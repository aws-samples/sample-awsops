import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { executeGraphLayer } from './graph-execution';

// Run the actual legacy loader, builders, writer and coordinator. Only SQL/connector IO,
// scheduling and process/log sinks are replaced; no hypothetical publisher result is returned.
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
    const context = vm.createContext({ process: processSink, Buffer,
      setTimeout: (fn, delay) => { ticks.push(fn); output.scheduled.push(['timeout', delay]); },
      setInterval: (fn, delay) => { ticks.push(fn); output.scheduled.push(['interval', delay]); },
      console: { log: report('logs'), error: report('errors'), warn: report('errors') } });
    const fail = () => { throw Object.assign(new Error('credential=database-secret'), { code: input.code ?? '23514' }); };
    class Source {
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
    const pool = {
      query: async (sql, args) => {
        if (sql.includes('SELECT DISTINCT account_id')) {
          if (input.failure === (sql.includes('ANY') ? 'flow' : 'infra')) fail();
          return { rows: [{ account_id: 'self' }] };
        }
        if (sql.includes('FROM inventory_resources')) return { rows: [] };
        if (sql.includes('FROM datasource_graph_queries')) {
          output.registryReads++;
          if (input.failure === 'registry') fail();
          return { rows: [{ integration_id: 7, query: { mapper: 'servicegraph_v1',
            tool: 'prometheus_query', args_template: { query: 'fixture' } } }] };
        }
        if (sql.includes('to_regclass')) return { rows: [{ ready: input.schema !== false }] };
        if (sql.includes("class = 'infra'")) { output.infraReads++; return { rows: [] }; }
        throw new Error('Unexpected fixture query');
      },
      connect: async () => ({ release() {}, query: async (sql, args) => {
        if (sql.includes('INSERT INTO topology_graph_state')) {
          if (input.failure === 'trace_write') fail();
          output.attempts.push({ status: args[1], publish: args[3], details: JSON.parse(args[4]) });
          if (args[3]) output.savedCapture = 'new';
        }
        if (/INSERT INTO topology_(nodes|edges)/.test(sql)) output.traceWrites++;
        if (/DELETE FROM topology_(nodes|edges)/.test(sql)) output.traceDeletes++;
        return { rows: [], rowCount: 1 };
      } }),
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
      const exports = specifier.includes('/db') ? { getPool: () => { output.opened++; return pool; } }
        : load(resolve(input.root, 'lib', specifier.split('/').at(-1).replace(/\.ts$/, '') + '.ts'));
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
describe('legacy graph execution contract', () => {
  it.each([false, true])('uses real builder totals and writes trace without inventing outcome metadata (timer=%s)', timer => {
    const result = run({ timer });
    expect(result.code).toBe(timer ? null : 0);
    expect(result.logs).toHaveLength(cycles(timer) * 3);
    for (const line of result.logs) expect(Object.keys(JSON.parse(line.slice(line.indexOf(': ') + 2)))).toEqual(['nodes', 'edges']);
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
    expect(result.attempts).toEqual([]);
    expect(result.traceWrites).toBe(0);
    expect(result.traceDeletes).toBe(0);
    expect(result.savedCapture).toBe('previous');
    expect(result.errors).toContain('[graph-rebuild] trace skipped: infra execution failed');
  });
  it.each([false, true])('the actual loader synthetic error retains trace and makes registry failure observable (timer=%s)', timer => {
    const result = run({ timer, failure: 'registry' });
    expect(result.code).toBe(timer ? null : 1);
    expect(result.errors).toContain('[graph-rebuild] trace_sources: registry_read_failed');
    expect(result.attempts).toHaveLength(cycles(timer));
    for (const attempt of result.attempts) expect(attempt).toMatchObject({ status: 'error', publish: false,
      details: { sources: [{ sourceId: 'graph-registry', reasons: ['registry_read_failed'] }] } });
    expect(result.traceWrites).toBe(0);
    expect(result.traceDeletes).toBe(0);
    expect(result.savedCapture).toBe('previous');
    expect(JSON.stringify(result)).not.toContain('credential');
  });
  it.each(['error', 'unavailable', 'partial'])('legacy %s retention remains a zero-total execution, not exit-2 proof', sourceStatus => {
    const result = run({ sourceStatus, empty: true });
    expect(result.code).toBe(0);
    expect(result.logs.at(-1)).toBe('[graph-rebuild] trace: {"nodes":0,"edges":0}');
    expect(result.attempts).toMatchObject([{ status: sourceStatus, publish: false }]);
    expect(result.savedCapture).toBe('previous');
    expect(result.traceWrites).toBe(0);
    expect(result.traceDeletes).toBe(0);
  });
  it('a real confirmed-empty trace has the same legacy totals but actually publishes', () => {
    const result = run({ sourceStatus: 'empty' });
    expect(result.code).toBe(0);
    expect(result.logs.at(-1)).toBe('[graph-rebuild] trace: {"nodes":0,"edges":0}');
    expect(result.attempts).toMatchObject([{ status: 'empty', publish: true }]);
    expect(result.savedCapture).toBe('new');
    expect(result.traceDeletes).toBe(2);
  });
  it('missing legacy state schema returns zero without collection/publication proof', () => {
    const result = run({ schema: false });
    expect(result.code).toBe(0);
    expect(result.attempts).toEqual([]);
    expect(result.traceCollections).toBe(0);
    expect(result.savedCapture).toBe('previous');
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

describe('legacy totals projection', () => {
  it('normalizes stage and ignores unsupported result fields without logging them', async () => {
    const lines: string[] = [];
    const result = await executeGraphLayer('credential=stage-secret', async () => ({ nodes: 1, edges: 0,
      reasons: Array(100).fill('credential=reason-secret'), retained: 'future-field', secret: 'PRIVATE_VALUE',
    }), line => lines.push(line));
    expect(result).toEqual({ failed: false, totals: { nodes: 1, edges: 0 } });
    expect(lines).toEqual(['[graph-rebuild] unknown: {"nodes":1,"edges":0}']);
  });
  it.each([null, {}, { nodes: -1, edges: 0 }, { nodes: 1, edges: NaN }, { nodes: 1, edges: Number.MAX_SAFE_INTEGER + 1 }])(
    'invalid required totals never become healthy zeros: %j', async value => {
      const lines: string[] = [];
      expect(await executeGraphLayer('flow', async () => value, line => lines.push(line))).toEqual({ failed: true });
      expect(lines).toEqual(['[graph-rebuild] failed {"stage":"flow","code":"unknown"}']);
    });
});
