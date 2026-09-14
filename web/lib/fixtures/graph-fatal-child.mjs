// Run outside Vitest: an unhandled pg client event must fail this child, never the runner.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import pg from 'pg';
import ts from 'typescript';

const [mode, recording = 'available'] = process.argv.slice(2);
assert.ok(process.env.GRAPH_TEST_POSTGRES_SOCKET?.startsWith('/'), 'A disposable PostgreSQL Unix socket is required');
const pool = new pg.Pool({ host: process.env.GRAPH_TEST_POSTGRES_SOCKET,
  user: 'postgres', database: 'awsops_graph_task3', max: 1, connectionTimeoutMillis: 1000 });
const output = { logs: [], errors: [], removed: 0, closed: 0, scheduled: [] };
pool.on('remove', () => { output.removed++; });
const compile = (file, module = ts.ModuleKind.CommonJS) => ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { module, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} };
  modules.set(file, module);
  const require = createRequire(file);
  vm.runInThisContext(`(function(require,module,exports){${compile(file)}\n})`, { filename: file })(
    specifier => specifier.startsWith('.') ? load(resolve(dirname(file), `${specifier}.ts`)) : require(specifier),
    module, module.exports);
  return module.exports;
}
const store = load(resolve('lib/graph-store.ts'));
const { graphTransaction } = load(resolve('lib/graph-inventory.ts'));
const state = load(resolve('lib/graph-state.ts'));
let original;
let injected = false;
let failureAttempts = 0;
const target = new Proxy(pool, { get(object, key) {
  if (key === 'end') return async () => { output.closed++; await pool.end(); };
  if (key !== 'connect') {
    const value = Reflect.get(object, key);
    return typeof value === 'function' ? value.bind(object) : value;
  }
  return async () => {
    if (injected && recording === 'connect-error' && failureAttempts === 0) {
      failureAttempts++;
      throw Object.assign(new Error('credential=unavailable-recorder'), { code: '08006' });
    }
    const client = await pool.connect();
    // Delegate the entire real client lifecycle, including events and release(destroy).
    // Only add SQL work to trigger the unchanged production transaction budget.
    return new Proxy(client, { get(object, key) {
      if (key !== 'query') {
        const value = Reflect.get(object, key);
        return typeof value === 'function' ? value.bind(object) : value;
      }
      return async (sql, args) => {
        if (!injected && sql.includes('INSERT INTO topology_edges')) {
          injected = true;
          try {
            for (let i = 0; i < 3; i++) await client.query('SELECT pg_sleep(1.4)');
          } catch (error) { original = error; throw error; }
        }
        if (injected && sql.includes('INSERT INTO topology_graph_state') && args?.[1] === 'error') {
          failureAttempts++;
          if (recording === 'fatal') {
            // Failure recording itself loses its session; the publication error must still win.
            await client.query("SET LOCAL idle_in_transaction_session_timeout = '20ms'");
            await new Promise(resolve => setTimeout(resolve, 80));
          } else if (recording === 'sql-error') {
            await client.query("SELECT 'credential=unavailable-recorder'::int");
          }
        }
        return client.query(sql, args);
      };
    } });
  };
} });
const metricsSources = [{ calls: async (mins, endMs) => ({ sourceId: 'metrics:test',
  status: 'ok', items: [{ client: 'new', server: 'other', count: 3 }], reasons: [],
  windowStartMs: endMs - mins * 60000, windowEndMs: endMs }) }];
const trace = () => store.rebuildTraceGraph(target, [], undefined, metricsSources);

try {
  if (mode === 'helper') {
    await assert.rejects(trace(), error => error === original && error.code === '25P04');
  } else if (mode === 'rollback') {
    original = new Error('credential=original-callback-error');
    const damaged = { connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, { get(object, key) {
        if (key === 'query') return (sql, args) => client.query(
          sql === 'ROLLBACK' ? "SELECT 'credential=rollback-error'::int" : sql, args);
        const value = Reflect.get(object, key);
        return typeof value === 'function' ? value.bind(object) : value;
      } });
    } };
    await assert.rejects(graphTransaction(damaged, false, async () => { throw original; }), error => error === original);
    assert.equal(pool.totalCount, 0); // failed rollback cannot return an aborted transaction to the pool
  } else if (mode.startsWith('idle')) {
    // An error event between queries must remain the rejection, not a generic "not queryable".
    let client;
    await assert.rejects(graphTransaction(pool, false, async value => {
      client = value;
      await value.query("SET LOCAL idle_in_transaction_session_timeout = '20ms'");
      await new Promise(resolve => setTimeout(resolve, 80));
      if (mode === 'idle-query') await value.query('SELECT 1');
    }), error => error.code === '25P03');
    assert.equal(client.listenerCount('error'), 1); // only pg-pool's listener remains after release
  } else {
    const ticks = [];
    const processSink = { env: { NEXT_RUNTIME: 'nodejs', GRAPH_REBUILD_INTERVAL_MINS: '1' } };
    const context = vm.createContext({ process: processSink,
      setTimeout: (fn, delay) => { ticks.push(fn); output.scheduled.push(['timeout', delay]); },
      setInterval: (fn, delay) => { ticks.push(fn); output.scheduled.push(['interval', delay]); },
      console: { log: text => output.logs.push(text), error: text => output.errors.push(text) } });
    const link = async specifier => {
      const exports = specifier.includes('/db') ? { getPool: () => target }
        : specifier.includes('graph-sources') ? { loadGraphSources: async () => ({ sources: [], metricsSources }) }
        : specifier.includes('graph-state') ? state : store;
      const module = new vm.SyntheticModule(Object.keys(exports), function() {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context });
      await module.link(link);
      await module.evaluate();
      return module;
    };
    const file = resolve(mode === 'timer' ? 'instrumentation.ts' : '../scripts/v2/graph-rebuild.mjs');
    const module = new vm.SourceTextModule(compile(file, ts.ModuleKind.ESNext), { context, importModuleDynamically: link });
    await module.link(link);
    await module.evaluate();
    if (mode === 'timer') {
      await module.namespace.register();
      await Promise.all([ticks[0](), ticks[1]()]);
      output.afterFailure = await state.readGraphState(pool, 'self', 'trace');
      await ticks[1](); // actual running guard must reset and a fresh pool slot must be usable
    }
    output.code = processSink.exitCode ?? null;
    assert.deepEqual(output.errors, ['[graph-rebuild] failed {"stage":"trace","code":"25P04"}']);
  }
  if (mode !== 'cli') {
    let reused;
    for (let i = 0; i < 4; i++) {
      await graphTransaction(pool, true, async client => {
        if (reused) assert.equal(client, reused);
        reused = client;
        assert.equal(client.listenerCount('error'), 1); // one scoped handler; no accumulation
        assert.equal((await client.query('SELECT 42 AS value')).rows[0].value, 42);
      });
      assert.equal(reused.listenerCount('error'), 1); // pg-pool owns it again
    }
    assert.equal(pool.totalCount, 1);
    assert.equal(pool.idleCount, 1);
    assert.equal(pool.waitingCount, 0);
  }
  output.failureAttempts = failureAttempts;
  output.originalCode = original?.code;
} finally {
  if (!output.closed) await pool.end();
}
assert.equal(pool.totalCount, 0);
console.log(JSON.stringify(output));
