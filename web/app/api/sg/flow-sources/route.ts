import { NextRequest, NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import {
  listFlowSources, upsertFlowSource, validateFlowSourceInput, validateFlowSourceViaBroker,
  type FlowSourceInput,
} from '@/lib/sg-rules';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

// GET /api/sg/flow-sources — authenticated read (any logged-in user; no admin gate on read).
export async function GET(req: NextRequest) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  try {
    const rows = await listFlowSources();
    return NextResponse.json({ rows });
  } catch (e) {
    return NextResponse.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// PUT /api/sg/flow-sources — admin-only create/update + source validation (spec's "Flow Log
// source configuration" section). The workgroup/database/table identifiers are strictly validated
// (web/lib/sg-rules.ts allowlist regexes) and never concatenated into SQL or AWS API calls; the
// live existence/schema check runs inside the isolated Athena broker Lambda, never in this route.
export async function PUT(req: NextRequest) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  if (!(await isAdmin(user))) return NextResponse.json({ status: 'error', message: 'admin only' }, { status: 403 });

  let body: any;
  try {
    body = await readJsonBounded(req, 16_384);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return NextResponse.json({ message: 'request body too large' }, { status: 413 });
    return NextResponse.json({ message: 'invalid JSON body' }, { status: 400 });
  }

  const input: FlowSourceInput = {
    accountId: String(body?.accountId ?? ''),
    region: String(body?.region ?? ''),
    workgroup: String(body?.workgroup ?? ''),
    databaseName: String(body?.databaseName ?? ''),
    tableName: String(body?.tableName ?? ''),
    enabled: body?.enabled === undefined ? true : Boolean(body.enabled),
  };
  const errors = validateFlowSourceInput(input);
  if (errors.length > 0) return NextResponse.json({ message: 'invalid input', errors }, { status: 400 });

  try {
    const validation = await validateFlowSourceViaBroker(input);
    const row = await upsertFlowSource(input, user.sub, {
      status: validation.status, reason: validation.reason ?? null,
      schemaFields: validation.schemaFields ?? null, partitionStrategy: validation.partitionStrategy ?? null,
      // Persisted so scripts/v2/workers/sg_rule_scan.py's build_day_select can use the actually
      // resolved column aliases / partition keys / optional-field presence instead of hardcoded
      // assumptions (MAJOR fix — see sg-rules.ts's ValidationResult doc comments).
      columnMap: validation.columnMap ?? null, partitionKeys: validation.partitionKeys ?? null,
      partitionKeyTypes: validation.partitionKeyTypes ?? null,
      optionalFields: validation.optionalFields ?? null,
      // Item 1 follow-up fix (round 2): persist the explicit scope-resolution record so operators
      // can distinguish a genuinely single-account table from a mis-detected org-wide one, instead
      // of an unscoped scan being silently indistinguishable from "not applicable."
      scopeResolution: validation.scopeResolution ?? null, scannedUnscoped: validation.scannedUnscoped ?? null,
      checkedAt: validation.checkedAt,
    });
    return NextResponse.json({ row, validation }, { status: 200 });
  } catch (e) {
    return NextResponse.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
