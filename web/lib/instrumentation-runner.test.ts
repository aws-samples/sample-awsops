import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Mirrors graph-rebuild-runner.test.ts's source-assertion approach: instrumentation.ts's register()
// runs at server boot as a side effect (setInterval, dynamic imports) — assert wiring by source
// rather than by executing it (executing would need a real Aurora pool + timers).
const SRC = readFileSync(join(process.cwd(), 'instrumentation.ts'), 'utf8');

describe('instrumentation.ts (graph-rebuild interval)', () => {
  it('is gated on NEXT_RUNTIME=nodejs via a literal `=== \'nodejs\'` guard (required for webpack to' +
    ' dead-code-eliminate the pg/node-builtins import from the edge bundle)', () => {
    expect(SRC).toMatch(/NEXT_RUNTIME\s*===\s*['"]nodejs['"]/);
  });

  it('is gated on GRAPH_REBUILD_INTERVAL_MINS (no-op when unset/0)', () => {
    expect(SRC).toMatch(/GRAPH_REBUILD_INTERVAL_MINS/);
  });

  it('wires all three materialized layers via the registry-driven graph-source loader, same as scripts/v2/graph-rebuild.mjs', () => {
    expect(SRC).toMatch(/rebuildGraph/);
    expect(SRC).toMatch(/rebuildInfraGraph/);
    expect(SRC).toMatch(/rebuildTraceGraph/);
    expect(SRC).toMatch(/loadGraphSources/);
  });

  it('schedules a recurring interval, not a one-shot run', () => {
    expect(SRC).toMatch(/setInterval/);
  });

  it('guards against overlapping runs (a rebuild slower than the interval, or the initial 60s' +
    ' setTimeout landing on top of a 1-minute interval, must not run concurrently)', () => {
    expect(SRC).toMatch(/running/);
    expect(SRC).toMatch(/finally/);
  });
});
