import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

// Execute the real entrypoint in a VM; only DB/collection IO and console/process sinks are
// replaced. This also checks top-level awaiting and exit behavior, without AWS or a TS loader.
function run(outcome = 'published', failed = '', traceOutcome = 'published', timer = false,
  env = { NEXT_RUNTIME: 'nodejs', GRAPH_REBUILD_INTERVAL_MINS: '1' }, code = '23514') {
  const file = resolve(timer ? 'instrumentation.ts' : '../scripts/v2/graph-rebuild.mjs');
  const compile = (path: string) => transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText;
  return JSON.parse(execFileSync('node', ['--experimental-vm-modules', '--input-type=module', '-e', `
    import vm from 'node:vm';
    import fs from 'node:fs';
    import * as url from 'node:url';
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const result = { code: null, logs: [], errors: [], opened: 0, closed: 0, scheduled: [] };
    const ticks = [];
    const schedule = kind => (callback, delay) => { ticks.push(callback); result.scheduled.push({ kind, delay }); };
    const processSink = { argv: ['node', input.file], env: input.env, exit: code => { result.code = code; } };
    const context = vm.createContext({ process: processSink, setTimeout: schedule('timeout'), setInterval: schedule('interval'), console: {
      log: text => result.logs.push(text), error: text => result.errors.push(text),
    } });
    const rebuild = (stage, outcome) => async () => {
      if (input.failed === stage) throw Object.assign(new Error('credential=secret'), { code: input.code });
      const counts = { nodes: 0, edges: 0, published: 0, retained: 0, skipped: 0, degraded: 0, reasons: [] };
      counts[outcome] = 1;
      if (outcome === 'degraded') counts.published = 1;
      return counts;
    };
    const load = async specifier => {
      const exports = specifier === 'node:url' ? url
        : specifier.includes('/db') ? { getPool: () => { result.opened++; return { end: async () => { result.closed++; } }; } }
        : specifier.includes('graph-sources') ? { loadGraphSources: async () => ({ sources: [], metricsSources: [] }) }
        : { rebuildGraph: rebuild('flow', input.outcome), rebuildInfraGraph: rebuild('infra', input.outcome),
            rebuildTraceGraph: rebuild('trace', input.traceOutcome) };
      const loaded = specifier.includes('graph-state') ? new vm.SourceTextModule(input.state, { context })
        : new vm.SyntheticModule(Object.keys(exports), function() {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context });
      await loaded.link(load);
      await loaded.evaluate();
      return loaded;
    };
    const module = new vm.SourceTextModule(input.source, {
      context, importModuleDynamically: load,
      initializeImportMeta: meta => { meta.url = url.pathToFileURL(input.file).href; },
    });
    await module.link(load);
    try { await module.evaluate(); } catch { result.code = 1; }
    if (input.timer) {
      await module.namespace.register();
      if (ticks.length) {
        await Promise.all([ticks[0](), ticks[1]()]); // overlapping initial/interval tick
        await ticks[1](); // finally must reset the guard even after failure
      }
    }
    result.code = processSink.exitCode ?? result.code;
    console.log(JSON.stringify(result));
  `], { input: JSON.stringify({ file, source: compile(file), state: compile(resolve('lib/graph-state.ts')),
      outcome, failed, traceOutcome, timer, env, code }),
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
}

describe('graph rebuild runner outcomes', () => {
  it('reports a confirmed empty publication as success and closes its pool', () => {
    const result = run();
    expect(result.code).toBe(0);
    expect(result.closed).toBe(1);
    expect(result.logs.join('\n')).toContain('"published":1');
  });
  it.each(['retained', 'skipped'])('distinguishes %s from a healthy zero', outcome => {
    const result = run(outcome);
    expect(result.code).toBe(2);
    expect(result.logs.join('\n')).toContain(`"${outcome}":1`);
    expect(result.closed).toBe(1);
  });
  it('reports collection exceptions as failure without raw errors', () => {
    const result = run('published', 'flow');
    expect(result.code).toBe(1);
    expect(result.errors).toEqual(['[graph-rebuild] failed {"stage":"flow","code":"23514"}']);
    expect(result.closed).toBe(1);
  });
  it.each(['retained', 'skipped', 'published', 'degraded'])('CLI propagates trace %s even if inventory published', outcome => {
    const result = run('published', '', outcome);
    expect(result.code).toBe(['retained', 'skipped'].includes(outcome) ? 2 : 0);
    expect(result.logs.at(-1)).toContain(`"${outcome}":1`);
    expect(result.closed).toBe(1);
  });
  it.each(['retained', 'skipped', 'published', 'degraded'])('timer reports trace %s and bounds overlapping ticks', outcome => {
    const result = run('published', '', outcome, true);
    expect(result.scheduled).toEqual([{ kind: 'timeout', delay: 60000 }, { kind: 'interval', delay: 60000 }]);
    expect(result.logs).toHaveLength(6); // two cycles, three layers; overlapping tick skipped
    expect(result.logs.at(-1)).toContain(`"${outcome}":1`);
    expect(result.closed).toBe(0);
  });
  it.each([false, true])('trace exceptions disclose stage/code safely (timer=%s)', timer => {
    const result = run('published', 'trace', 'published', timer);
    expect(result.errors).toEqual(Array(timer ? 2 : 1).fill('[graph-rebuild] failed {"stage":"trace","code":"23514"}'));
    expect(result.code).toBe(timer ? null : 1);
    expect(result.closed).toBe(timer ? 0 : 1);
    expect(run('published', 'trace', 'published', timer, undefined, 'credential=secret').errors.join('\n'))
      .toContain('"code":"unknown"');
  });
  it.each([
    { NEXT_RUNTIME: 'edge', GRAPH_REBUILD_INTERVAL_MINS: '1' },
    { NEXT_RUNTIME: 'nodejs', GRAPH_REBUILD_INTERVAL_MINS: '0' },
    { NEXT_RUNTIME: 'nodejs', GRAPH_REBUILD_INTERVAL_MINS: '-1' },
    { NEXT_RUNTIME: 'nodejs', GRAPH_REBUILD_INTERVAL_MINS: 'invalid' },
  ])('timer gates leave the pool untouched: %j', env => {
    const result = run('published', '', 'published', true, env);
    expect(result).toMatchObject({ scheduled: [], logs: [], errors: [], opened: 0, closed: 0 });
  });
});
