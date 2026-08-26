# Plan — Datasource Explore page (v1 `/datasources/explore` parity for v2)

## Context
v1 had a dedicated **Datasources → Explore** UI: pick a datasource, type a query in its native
language (PromQL/LogQL/TraceQL/SQL) **or** describe it in natural language → Bedrock generates the
query → run → chart/table. v2 already has: connector Lambdas with read-only `*_query`/`*_query_range`
tools (SSRF/auth/read-only owned by the Lambda), `invokeConnectorTool()` BFF helper, cached schemas
(`datasource_schemas` + `listConfiguredSchemas`), the web-task `lambda:InvokeFunction` IAM grant, and
chat-side schema injection. **Missing: the Explore page + a query-exec BFF route + an NL→query route.**

This increment adds them. **No Terraform change** (IAM already present). **Read-only only** — the
route maps `kind → read tool` and never calls a mutating tool (policy: AWS-mutation/autonomy frozen).

## Constraints / invariants (must hold)
- **Read-only**: `TOOL` map contains ONLY `*_query`/`*_query_range`/`*_search` read tools. No write/mutate tool is reachable.
- **No credential leakage**: routes never return or log credential values. The connector Lambda owns secrets.
- **SSRF unchanged**: query execution goes through the connector Lambda (which owns `assert_host_allowed`). The BFF never makes the outbound datasource call itself.
- **Auth**: query/list/generate require an authenticated user (`verifyUser`). They are NOT admin-only (read-only exploration); credential WRITE stays admin-only (unchanged).
- **Slug allowlist**: every connector invocation validates `slug ∈ KNOWN_CONNECTOR_SLUGS` (defense-in-depth; `invokeConnectorTool` also checks).
- **Queryable kinds** = `clickhouse, prometheus, loki, tempo, mimir` (notion excluded — not a query datasource).
- **Arg key**: clickhouse query tool takes `{sql}`; all others take `{query}`. The route maps per kind.
- **Bounded**: query string capped (8 KB); the connector Lambda already truncates results (`truncated` flag surfaced to the UI).
- Existing tsc baseline (20) and all current vitest suites stay green. New code `export default` for the page.

## Tasks (TDD + Tidy; bite-sized; per-task commit)

### Task 1: nav registration

**Files:**
- Modify: `web/components/shell/Sidebar.tsx`
- Modify: `web/lib/i18n.ts`
- Modify: `web/components/shell/CommandPalette.tsx`
- Test: `web/lib/i18n.test.ts`

Add `{ href: '/datasources', tkey: 'nav.datasources', icon: SearchCode }` to `Sidebar.FIXED` (import `SearchCode`), `nav.datasources` to i18n ko (`데이터소스`) + en (`Datasources`), and a `/datasources` entry to `CommandPalette.PAGES`. MobileNav renders `<Sidebar>` → the mobile drawer gets it automatically; bottom tabs stay at 5.

- [ ] Assert `nav.datasources` exists in both `MESSAGES.ko` and `MESSAGES.en` (key parity); existing nav/i18n tests stay green.
- [ ] Add the Sidebar FIXED entry + SearchCode import + CommandPalette page entry.

### Task 2: result normalizer (pure, the testable core)

**Files:**
- Create: `web/lib/datasource-render.ts`
- Test: `web/lib/datasource-render.test.ts`

Pure `normalizeResult(kind, tool, body): NormalizedResult` where `NormalizedResult = { shape: 'series'|'table'|'logs'|'traces'|'empty'; columns?: {key,label}[]; rows?: Record<string,unknown>[]; series?: Record<string,unknown>[]; seriesXKey?: string; seriesYKey?: string; truncated?: boolean; note?: string }`. prometheus/mimir matrix → first series `series:[{t,value}]` + a `rows` table of all series `{metric, points}`, carry `truncated`. prometheus/mimir vector → table `{metric, value, timestamp}`. loki streams → logs table `{timestamp, line, labels}` (flatten present rows), shape `logs`. tempo `{traces}` → table `{traceID, rootServiceName, rootTraceName, durationMs}`, shape `traces`. clickhouse `{rowCount, rows, meta}` → columns from `meta[].name` (fallback to keys of `rows[0]`), rows = `body.rows` (NOT `body.data`). empty/missing/malformed → `shape:'empty'` with a `note` (never throw).

- [ ] Test one per kind incl. empty + truncated + malformed (missing keys) + multi-series matrix (first chosen, table lists all).
- [ ] Implement the normalizer to green.

### Task 3: query-exec + list BFF routes

**Files:**
- Create: `web/app/api/datasources/route.ts`
- Create: `web/app/api/datasources/query/route.ts`
- Test: `web/app/api/datasources/query/route.test.ts`

`GET /api/datasources` (authenticated): `getConfiguredSlugs()` ∩ QUERYABLE → `[{slug, kind, hasSchema}]` (hasSchema via `listConfiguredSchemas(currentAccountId())`). Never credentials. `POST /api/datasources/query` (authenticated): body `{slug, query, range?}`. Validate slug ∈ KNOWN, query non-empty ≤8 KB. kind==slug for these. Tool resolution = an **explicit per-kind `TOOL` map** (NO formula — tempo has no `*_query`/`*_query_range`), all read-only tools + per-kind arg key:
```
TOOL = {
  prometheus: { instant:'prometheus_query', range:'prometheus_query_range', arg:'query' },
  mimir:      { instant:'mimir_query',        range:'mimir_query_range',        arg:'query' },
  loki:       { instant:'loki_query',          range:'loki_query_range',          arg:'query' },
  tempo:      { instant:'tempo_search',        /* no range */                     arg:'query' },
  clickhouse: { instant:'clickhouse_query',    /* no range */                     arg:'sql', extra:{ max_rows } },
}
```
`range` selects `.range` only when present (else `.instant`). Args = `{ [t.arg]: query, ...t.extra }`. `invokeConnectorTool(slug, tool, args)` → `normalizeResult(kind, tool, body)` → return. Errors → 502 `{error}` (message only).

- [ ] Test: unauthenticated→401; unknown slug→400; empty query→400; clickhouse maps to `{sql}` not `{query}`; range flag selects `_query_range`; every `TOOL` value is a read tool (no mutate); invoke error → 502 clean message; normalized passthrough. Mock connector-invoke/auth/integration-credentials/datasource-schema.
- [ ] Implement both routes to green.

### Task 4: Explore page

**Files:**
- Create: `web/app/datasources/page.tsx`

`'use client'` default-export. On mount `GET /api/datasources` → dropdown (slug + kind + hasSchema hint). Query `Input` with kind-specific placeholder (PromQL/LogQL/TraceQL/SQL). "실행" `Button` → `POST /api/datasources/query` → render by `normalizeResult` shape: `series`→`AreaTrend`; `table|logs|traces`→`DataTable`; `empty`→note. Range toggle for time-series kinds. Error + truncated banners. Uses existing `PageHeader`/`Card`/`Input`/`Button`/`DataTable`/`AreaTrend`.

- [ ] Build the page; keep tsc-clean (thin glue — covered by route + normalizer tests, no dedicated test required).

### Task 5: NL→query generation (STEP 4)

**Files:**
- Create: `web/app/api/datasources/generate/route.ts`
- Test: `web/app/api/datasources/generate/route.test.ts`
- Modify: `web/app/datasources/page.tsx`

`POST /api/datasources/generate` (authenticated): body `{slug, kind, nl}`. Build `extraContext` from this slug's cached schema (`listConfiguredSchemas` filtered to slug). `invokeAgent({ gateway:'monitoring', messages:[{role:'user',content:nl}], systemPromptOverride: QUERY_ONLY_PROMPT(kind), extraContext, sessionId })`. Parse returned text: extract FIRST fenced code block → `{query}`; no fence → trim whole text (bounded). Never executes. Page: "AI로 생성" button fills the query Input (does not auto-run).

- [ ] Test: parses a fenced query out of prose; no-fence fallback returns trimmed text; unauthenticated→401; empty nl→400. Mock agentcore + datasource-schema.
- [ ] Implement the route + wire the page button.

## Out of scope (note as deferred, not silently dropped)
- Multiple instances of the same datasource kind (v2 is one-per-kind by secret slug).
- Saved queries / history, query autocompletion, multi-source correlation in one view (chat already does cross-source correlation).
- Mutating/write datasource ops (permanently frozen).

## Verification
- `cd web && npx vitest run` all green; `npx tsc --noEmit` baseline unchanged.
- `cd agent/lambda && python3 -m pytest -q` unaffected (no Lambda change).
- No Terraform change → no apply. `make deploy` ships web-only.
