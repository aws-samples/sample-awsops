import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { executeGraphLayer } from './graph-execution';

// Run the actual loader, bounded publishers, writer and coordinator. Only SQL/connector IO,
// scheduling and process/log sinks are replaced; publication counts come from the real builders.
function run(options: Record<string, unknown> = {}) {
  return JSON.parse(execFileSync('node', ['--experimental-vm-modules', '--input-type=module', '-e', String.raw`
    import vm from 'node:vm';
    import fs from 'node:fs';
    import { createRequire } from 'node:module';
    import { resolve, dirname } from 'node:path';
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const require = createRequire(resolve(input.root, 'package.json'));
    const ts = require('typescript');
    const output = { code: null, logs: [], errors: [], opened: 0, closed: 0,
      scheduled: [], registryReads: 0, traceCollections: 0, infraReads: 0,
      attempts: [], traceWrites: 0, traceDeletes: 0, savedCapture: 'previous', unhandled: false };
    const ticks = [];
    let reportingFaults = input.reportingFailure ? 2 : 0;
    const report = key => line => {
      if (reportingFaults-- > 0) throw Object.assign(new Error('credential=report-secret'), { code: '58000' });
      output[key].push(line);
    };
    const processSink = { env: input.env ?? { NEXT_RUNTIME: 'nodejs', GRAPH_REBUILD_INTERVAL_MINS: '1' } };
    const context = vm.createContext({ process: processSink, Buffer, performance, setImmediate, clearTimeout,
      setTimeout: (fn, delay) => {
        if (delay < 60000) return setTimeout(fn, delay);
        ticks.push(fn); output.scheduled.push(['timeout', delay]);
      },
      setInterval: (fn, delay) => { ticks.push(fn); output.scheduled.push(['interval', delay]); },
      console: { log: report('logs'), error: report('errors'), warn: report('errors') } });
    const fail = () => { throw Object.assign(new Error('credential=database-secret'), { code: input.code ?? '23514' }); };
    let stage = '';
    class Source {
      constructor() { if (input.failure === 'source_constructor') fail(); }
      async available() { return true; }
      async calls(mins, endMs) {
        output.traceCollections++;
        const status = input.sourceStatus ?? 'ok';
        const items = input.empty || ['error', 'unavailable', 'empty'].includes(status)
          ? [] : [{ client: 'api', server: 'database', count: 1 }];
        return { sourceId: 'metrics:fixture', status, items,
          reasons: status === 'error' ? ['query_failed'] : status === 'partial' ? ['cap_reached'] : [],
          windowStartMs: endMs - mins * 60000, windowEndMs: endMs };
      }
    }
    const fixtureNow = Date.now();
    const query = async (sql, args) => {
        if (sql.includes('SELECT accounts.account_id')) {
          if (input.failure === stage) fail();
          return { rows: [{ account_id: 'self' },
            ...(input.accountCap ? Array.from({ length: 100 }, (_, i) => ({ account_id: String(i).padStart(12, '0') }))
              : input.partialFailure === stage || input.memberOnlyGap ? [{ account_id: '123456789012' }] : [])] };
        }
        if (sql.includes('FROM inventory_sync_runs')) {
          const now = fixtureNow - (stage === 'infra' && input.infraOutcome === 'stale' ? 3600000 : 0);
          return { rows: args[0].map(resource_type => ({ resource_type, account_id: 'self',
            status: stage === 'infra' && input.infraOutcome === 'retained' && resource_type === 'vpc' ? 'failed' : 'succeeded',
            row_count: stage === 'infra' && input.infraOutcome === 'degraded' && resource_type === 'vpc' ? 1 : 0,
            unknown_attribute_count: stage === 'infra' && input.infraOutcome === 'degraded' && resource_type === 'vpc' ? 1 : 0, version: '1',
            started_at: new Date(now - 2000).toISOString(),
            finished_at: new Date(now - 1000).toISOString(),
            last_success_at: new Date(now - 1000).toISOString() })).filter(row => !sql.includes("status='succeeded'") || row.status === 'succeeded') };
        }
        if (sql.includes('FROM inventory_resources')) {
          if (stage === 'infra' && input.infraOutcome === 'degraded') return { rows: sql.includes('count(*)::int')
            ? [{ resource_type: 'vpc', count: 1 }]
            : [{ account_id: 'self', resource_type: 'vpc', resource_id: 'vpc-fixture', region: 'fixture', data: { vpc_id: 'vpc-fixture' }, captured_at: new Date(Date.now()-1000).toISOString() }] };
          if (input.partialFailure === stage && args?.[0] === '123456789012') fail();
          return { rows: [] };
        }
        if (sql.includes('FROM inventory_snapshots')) return { rows: input.memberOnlyGap && args[0] !== 'self' ? [] : args[1].map(resource_type => ({
          resource_type, captured_at: new Date(fixtureNow - 1000 - (stage === 'infra' && input.infraOutcome === 'stale' ? 3600000 : 0)).toISOString(),
          resource_count: stage === 'infra' && input.infraOutcome === 'degraded' && resource_type === 'vpc' ? 1 : 0,
        })) };
        if (sql.includes('FROM datasource_graph_queries')) {
          output.registryReads++;
          if (input.failure === 'registry') fail();
          return { rows: [{ integration_id: 7, query: { mapper: 'servicegraph_v1',
            tool: 'prometheus_query', args_template: { query: 'fixture' } } }] };
        }
        if (sql.includes('to_regclass')) return { rows: [{ ready: input.schema !== false }] };
        if (/class\s*=\s*'infra'/.test(sql)) { output.infraReads++; return { rows: [] }; }
        if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: input.skipStage !== stage && !(stage === 'infra' && input.infraOutcome === 'skipped') }] };
        if (sql.includes('AS retained')) return { rows: [{ retained: true }] };
        if (sql.includes('INSERT INTO topology_graph_state')) {
          if (args[5] === 'trace') {
            if (input.failure === 'trace_write') fail();
            output.attempts.push({ status: args[1], publish: args[3], details: JSON.parse(args[4]) });
            if (args[3]) output.savedCapture = 'new';
          }
          return { rows: [], rowCount: 1 };
        }
        if (/INSERT INTO topology_(nodes|edges)/.test(sql)) {
          if (stage === 'trace') output.traceWrites++;
          return { rows: [], rowCount: 1 };
        }
        if (/DELETE FROM topology_(nodes|edges)/.test(sql)) {
          if (stage === 'trace') output.traceDeletes++;
          return { rows: [], rowCount: 1 };
        }
        if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
        throw new Error('Unexpected fixture query');
    };
    const pool = {
      query,
      connect: async () => ({ release() {}, on() {}, removeListener() {}, query }),
      end: async () => {
        output.closed++;
        if (input.closeFailure) throw Object.assign(new Error('credential=close-secret'), { code: '08006' });
      },
    };
    const cache = new Map();
    const compile = (file, module) => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const load = file => {
      if (cache.has(file)) return cache.get(file).exports;
      const module = { exports: {} }; cache.set(file, module);
      const localRequire = specifier => {
        if (specifier.endsWith('/trace-source')) return {
          ClickHouseOtelTraceSource: Source, TempoTraceSource: Source, MetricsCallsSource: Source,
        };
        if (specifier.startsWith('@/')) return load(resolve(input.root, specifier.slice(2) + '.ts'));
        if (specifier.startsWith('.')) return load(resolve(dirname(file), specifier + '.ts'));
        return createRequire(file)(specifier);
      };
      vm.runInContext('(function(require,module,exports){' + compile(file, ts.ModuleKind.CommonJS) + '\n})', context)(localRequire, module, module.exports);
      return module.exports;
    };
    const link = async specifier => {
      let exports = specifier.includes('/db') ? { getPool: () => { output.opened++; return pool; } }
        : load(resolve(input.root, 'lib', specifier.split('/').at(-1).replace(/\.ts$/, '') + '.ts'));
      if (specifier.includes('graph-store')) {
        const stages = { rebuildGraph: 'flow', rebuildInfraGraph: 'infra', rebuildTraceGraph: 'trace',
          recordTraceSourceFailure: 'trace', recordTraceDependencySkip: 'trace' };
        exports = Object.fromEntries(Object.entries(exports).map(([name, value]) => [name,
          stages[name] ? (...args) => { stage = stages[name]; return value(...args); } : value]));
      }
      const module = new vm.SyntheticModule(Object.keys(exports), function() {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context });
      await module.link(link); await module.evaluate(); return module;
    };
    const file = resolve(input.root, input.timer ? 'instrumentation.ts' : '../scripts/v2/graph-rebuild.mjs');
    const module = new vm.SourceTextModule(compile(file, ts.ModuleKind.ESNext), { context, importModuleDynamically: link });
    await module.link(link); await module.evaluate();
    if (input.timer) {
      await module.namespace.register();
      if (ticks.length) {
        try { await Promise.all([ticks[0](), ticks[1]()]); } catch { output.unhandled = true; }
        try { await ticks[1](); } catch { output.unhandled = true; }
      }
    }
    output.code = processSink.exitCode ?? null;
    console.log(JSON.stringify(output));
  `], { input: JSON.stringify({ root: resolve('.'), ...options }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
}

const cycles = (timer: boolean) => timer ? 2 : 1;
describe('graph execution and publication contract', () => {
  it.each([false, true])('uses real publisher totals and writes trace (timer=%s)', timer => {
    const result = run({ timer });
    expect(result.code).toBe(timer ? null : 0);
    expect(result.logs).toHaveLength(cycles(timer) * 3);
    for (const line of result.logs) expect(JSON.parse(line.slice(line.indexOf(': ') + 2)))
      .toMatchObject({ published: 1, retained: 0, skipped: 0, degraded: 0 });
    const infra = JSON.parse(result.logs.find((line: string) => line.startsWith('[graph-rebuild] infra:')).split(': ').slice(1).join(': '));
    expect(infra).toMatchObject({ nodes: 0, published: 1, retained: 0, skipped: 0, degraded: 0 });
    expect(result.attempts).toHaveLength(cycles(timer));
    expect(result.attempts.every((a: { publish: boolean }) => a.publish)).toBe(true);
    expect(result.traceWrites).toBeGreaterThan(0);
    expect(result.closed).toBe(timer ? 0 : 1);
  });
  it.each([false, true])('flow failure still allows infra and trace (timer=%s)', timer => {
    const result = run({ timer, failure: 'flow' });
    expect(result.code).toBe(timer ? null : 1);
    expect(result.logs).toHaveLength(cycles(timer) * 2);
    expect(result.traceCollections).toBe(cycles(timer));
    expect(result.attempts.every((a: { publish: boolean }) => a.publish)).toBe(true);
    expect(result.errors).toEqual(Array(cycles(timer)).fill('[graph-rebuild] failed {"stage":"flow","code":"23514"}'));
  });
  it.each([false, true])('infra failure prevents dependent trace collection and publication (timer=%s)', timer => {
    const result = run({ timer, failure: 'infra' });
    expect(result.code).toBe(timer ? null : 1);
    expect(result.registryReads).toBe(0);
    expect(result.traceCollections).toBe(0);
    expect(result.infraReads).toBe(0);
    expect(result.attempts).toHaveLength(cycles(timer));
    expect(result.attempts.every((a: { publish: boolean; details: Record<string, unknown> }) =>
      !a.publish && a.details.sourceAttempted === false && a.details.failureReason === 'not_attempted')).toBe(true);
    expect(result.traceWrites).toBe(0);
    expect(result.traceDeletes).toBe(0);
    expect(result.savedCapture).toBe('previous');
    expect(result.errors).toContain('[graph-rebuild] trace skipped: infra execution failed');
  });
  it.each([false, true])('returned incomplete infra never refreshes trace (timer=%s)', timer => {
    for (const infraOutcome of ['retained', 'skipped']) {
      const result = run({ timer, infraOutcome });
      expect(result.code).toBe(timer ? null : 2);
      expect(result.registryReads).toBe(0);
      expect(result.traceCollections).toBe(0);
      expect(result.attempts).toHaveLength(cycles(timer));
      expect(result.attempts.every((a: { publish: boolean; details: Record<string, unknown> }) =>
        !a.publish && a.details.sourceAttempted === false && a.details.failureReason === 'not_attempted')).toBe(true);
      expect(result.traceWrites).toBe(0);
      expect(result.traceDeletes).toBe(0);
      expect(result.savedCapture).toBe('previous');
      expect(result.errors).toContain('[graph-rebuild] trace skipped: infra publication incomplete');
    }
  });
  it.each([false, true].flatMap(timer => ['degraded', 'stale'].map(infraOutcome => ({ timer, infraOutcome }))))(
    'published $infraOutcome self context permits only qualified partial telemetry (timer=$timer)', ({ timer, infraOutcome }) => {
      const result = run({ timer, infraOutcome });
      expect(result.code).toBe(timer ? null : 2);
      expect(result.traceCollections).toBe(cycles(timer)); expect(result.infraReads).toBe(0);
      expect(result.traceWrites).toBeGreaterThan(0);
      expect(result.attempts.every((a: { publish: boolean; status: string; details: Record<string, unknown> }) =>
        a.publish && a.status === 'partial' && a.details.infraUnavailable === true)).toBe(true);
      const empty = run({ timer, infraOutcome, empty: true });
      expect(empty.traceWrites).toBe(0); expect(empty.traceDeletes).toBe(0);
      expect(empty.savedCapture).toBe('previous');
      expect(empty.attempts.every((a: { publish: boolean }) => !a.publish)).toBe(true);
    });
  it.each([false, true])('member retention keeps fleet incomplete but does not poison clean self trace context (timer=%s)', timer => {
    const result = run({ timer, memberOnlyGap: true });
    expect(result.code).toBe(timer ? null : 2);
    expect(result.logs.find((line: string) => line.startsWith('[graph-rebuild] infra:'))).toContain('"retained":1');
    expect(result.traceCollections).toBe(cycles(timer));
    expect(result.traceWrites).toBeGreaterThan(0);
    expect(result.attempts.every((attempt: { publish: boolean }) => attempt.publish)).toBe(true);
  });
  it.each([false, true])('account truncation stays incomplete while a proved self slice can refresh trace (timer=%s)', timer => {
    const result = run({ timer, accountCap: true });
    expect(result.code).toBe(timer ? null : 2);
    expect(result.logs.find((line: string) => line.startsWith('[graph-rebuild] infra:'))).toContain('"accountsTruncated":true');
    expect(result.traceCollections).toBe(cycles(timer));
    expect(result.traceWrites).toBeGreaterThan(0);
  });
  it.each([false, true])('the actual loader synthetic error retains trace and makes registry failure observable (timer=%s)', timer => {
    const result = run({ timer, failure: 'registry' });
    expect(result.code).toBe(timer ? null : 1);
    expect(result.errors).toContain('[graph-rebuild] trace_sources: registry_read_failed');
    expect(result.attempts).toHaveLength(cycles(timer));
    for (const attempt of result.attempts) expect(attempt).toMatchObject({ status: 'error', publish: false,
      details: { sources: [{ sourceId: 'trace:registry', reasons: ['registry_read_failed'] }] } });
    expect(result.traceCollections).toBe(0);
    expect(result.attempts[0].details.sources[0]).not.toHaveProperty('itemCount');
    expect(result.attempts[0].details).not.toHaveProperty('windowStartMs');
    expect(result.traceWrites).toBe(0);
    expect(result.traceDeletes).toBe(0);
    expect(result.savedCapture).toBe('previous');
    expect(JSON.stringify(result)).not.toContain('credential');
  });
  it.each(['error', 'unavailable', 'partial'].flatMap(sourceStatus =>
    [false, true].map(timer => ({ sourceStatus, timer }))))('retention stays distinct from confirmed empty: %j', ({ sourceStatus, timer }) => {
    const result = run({ timer, sourceStatus, empty: true });
    expect(result.code).toBe(timer ? null : 2);
    expect(result.logs.at(-1)).toContain('"retained":1');
    expect(result.attempts).toHaveLength(cycles(timer));
    expect(result.attempts.every((a: { status: string; publish: boolean }) => a.status === sourceStatus && !a.publish)).toBe(true);
    expect(result.savedCapture).toBe('previous');
    expect(result.traceWrites).toBe(0);
    expect(result.traceDeletes).toBe(0);
  });
  it('a real confirmed-empty trace reports publication despite zero nodes and edges', () => {
    const result = run({ sourceStatus: 'empty' });
    expect(result.code).toBe(0);
    expect(result.logs.at(-1)).toContain('"published":1');
    expect(result.attempts).toMatchObject([{ status: 'empty', publish: true }]);
    expect(result.savedCapture).toBe('new');
    expect(result.traceDeletes).toBe(2);
  });
  it('missing state schema reports skipped work without collection/publication proof', () => {
    const result = run({ schema: false });
    expect(result.code).toBe(2);
    expect(result.attempts).toEqual([]);
    expect(result.traceCollections).toBe(0);
    expect(result.savedCapture).toBe('previous');
  });
  it.each([false, true])('unexpected loader exceptions persist non-publishing failure evidence (timer=%s)', timer => {
    const result = run({ timer, failure: 'source_constructor' });
    expect(result.code).toBe(timer ? null : 1);
    expect(result.attempts).toHaveLength(cycles(timer));
    expect(result.attempts.every((a: { publish: boolean }) => !a.publish)).toBe(true);
    expect(result.attempts[0].details.sources).toMatchObject([{ sourceId: 'trace:registry', status: 'error' }]);
    expect(result.traceWrites).toBe(0);
    expect(result.traceDeletes).toBe(0);
    expect(JSON.stringify(result)).not.toContain('credential');
  });
  it.each([false, true])('preserves partial account counts and the infra dependency (timer=%s)', timer => {
    for (const partialFailure of ['flow', 'infra']) {
      const result = run({ timer, partialFailure });
      expect(result.code).toBe(timer ? null : 1);
      const line = result.logs.find((line: string) => line.startsWith(`[graph-rebuild] ${partialFailure}:`));
      expect(JSON.parse(line.slice(line.indexOf(': ') + 2))).toMatchObject({
        published: 1, failed: 1, failureCode: '23514',
      });
      expect(result.traceCollections).toBe(cycles(timer));
      expect(JSON.stringify(result)).not.toContain('credential');
    }
  });
  it.each([false, true])('reports trace lock skips and degraded publications (timer=%s)', timer => {
    const skipped = run({ timer, skipStage: 'trace' });
    expect(skipped.code).toBe(timer ? null : 2);
    expect(skipped.logs.at(-1)).toContain('"skipped":1');
    expect(skipped.traceDeletes).toBe(0);
    const degraded = run({ timer, sourceStatus: 'partial' });
    expect(degraded.code).toBe(timer ? null : 2);
    expect(degraded.logs.at(-1)).toContain('"degraded":1');
    expect(degraded.traceWrites).toBeGreaterThan(0);
  });
  it.each([false, true])('trace write exceptions remain sanitized failures (timer=%s)', timer => {
    const result = run({ timer, failure: 'trace_write' });
    expect(result.code).toBe(timer ? null : 1);
    expect(result.errors).toEqual(Array(cycles(timer)).fill('[graph-rebuild] failed {"stage":"trace","code":"23514"}'));
    expect(result.closed).toBe(timer ? 0 : 1);
    expect(run({ timer, failure: 'trace_write', code: 'credential=secret' }).errors.join('\n')).toContain('"code":"unknown"');
  });
  it('CLI awaits close and reports sanitized cleanup failure with earlier totals intact', () => {
    const result = run({ closeFailure: true });
    expect(result.code).toBe(1);
    expect(result.closed).toBe(1);
    expect(result.logs).toHaveLength(3);
    expect(result.errors).toEqual(['[graph-rebuild] pool close failed {"stage":"graph_state","code":"08006"}']);
  });
  it('timer catches an unexpected coordination failure, resets overlap and recovers next tick', () => {
    const result = run({ timer: true, reportingFailure: true });
    expect(result.unhandled).toBe(false);
    expect(result.errors).toEqual(['[graph-rebuild] failed {"stage":"graph_state","code":"58000"}']);
    expect(result.traceCollections).toBe(1);
    expect(result.closed).toBe(0);
    expect(JSON.stringify(result)).not.toContain('credential');
  });
  it('timer skips an overlapping tick without closing its shared pool', () => {
    const result = run({ timer: true });
    expect(result.scheduled).toEqual([['timeout', 60000], ['interval', 60000]]);
    expect(result.traceCollections).toBe(2);
    expect(result.closed).toBe(0);
  });
  it.each([
    { NEXT_RUNTIME: 'edge', GRAPH_REBUILD_INTERVAL_MINS: '1' }, { NEXT_RUNTIME: 'nodejs' },
    { NEXT_RUNTIME: 'nodejs', GRAPH_REBUILD_INTERVAL_MINS: '0' },
    { NEXT_RUNTIME: 'nodejs', GRAPH_REBUILD_INTERVAL_MINS: '-1' },
    { NEXT_RUNTIME: 'nodejs', GRAPH_REBUILD_INTERVAL_MINS: 'invalid' },
    { NEXT_RUNTIME: 'nodejs', GRAPH_REBUILD_INTERVAL_MINS: 'Infinity' },
  ])('disabled timer does not load a pool or collect: %j', env => {
    expect(run({ timer: true, env })).toMatchObject({ scheduled: [], opened: 0, closed: 0, attempts: [], registryReads: 0 });
  });
});

describe('publisher outcome projection', () => {
  const valid = { nodes: 1, edges: 0, published: 1, retained: 0, skipped: 0, degraded: 0, reasons: [] };
  it.each([{ published: 0 }, { retained: 1 }, { skipped: 1 }, { degraded: 1 }, { accountsTruncated: true },
    { reasons: ['account_limit'] }])('keeps valid incomplete outcomes distinct: %j', async override => {
    const result = await executeGraphLayer('infra', async () => ({ ...valid, ...override }), () => {});
    expect(result.incomplete).toBe(true);
  });
  it('keeps known account progress while sanitizing failure codes', async () => {
    const lines: string[] = [];
    const result = await executeGraphLayer('infra', async () => ({ ...valid, nodes: 3, failed: 1,
      failureCode: 'credential=private', reasons: ['account_failed'] }), line => lines.push(line));
    expect(result).toMatchObject({ failed: true, totals: { nodes: 3, published: 1, failed: 1, failureCode: 'unknown' } });
    expect(lines.join('')).not.toContain('credential');
  });
  it('normalizes stage and ignores unsupported result fields without logging them', async () => {
    const lines: string[] = [];
    const result = await executeGraphLayer('credential=stage-secret', async () => ({ nodes: 1, edges: 0,
      published: 1, retained: 0, skipped: 0, degraded: 0, reasons: [], secret: 'PRIVATE_VALUE',
    }), line => lines.push(line));
    expect(result).toMatchObject({ failed: false, incomplete: false,
      totals: { nodes: 1, edges: 0, published: 1, retained: 0, skipped: 0, degraded: 0, reasons: [] } });
    expect(lines[0]).toContain('[graph-rebuild] unknown:');
    expect(lines.join('\n')).not.toContain('PRIVATE_VALUE');
  });
  it.each([null, {}, { nodes: 1, edges: 0 }, { ...valid, nodes: -1 },
    { ...valid, edges: NaN }, { ...valid, edges: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, retained: 'future-field' }, { ...valid, failed: -1 },
    { ...valid, reasons: ['credential=reason-secret'] }, { ...valid, accountsTruncated: 'PRIVATE_VALUE' },
    { ...valid, selfInfraComplete: 'unverified' }, { ...valid, selfInfraComplete: true }])(
    'invalid required totals never become healthy zeros: %j', async value => {
      const lines: string[] = [];
      expect(await executeGraphLayer('flow', async () => value, line => lines.push(line))).toEqual({ failed: true });
      expect(lines).toEqual(['[graph-rebuild] failed {"stage":"flow","code":"unknown"}']);
    });
});
