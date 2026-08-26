import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// T6 — the graph-rebuild runner wires all THREE materialized layers (flow/infra/trace). The runner
// executes at import (getPool + process.exit), so this asserts its wiring by source rather than by
// running it. Mirrors the migration-presence assertions in graph-store.test.ts.
const RUNNER = join(process.cwd(), '..', 'scripts', 'v2', 'graph-rebuild.mjs');

describe('graph-rebuild.mjs', () => {
  const src = readFileSync(RUNNER, 'utf8');
  it('imports and calls all three rebuilds', () => {
    expect(src).toMatch(/rebuildGraph/);
    expect(src).toMatch(/rebuildInfraGraph/);
    expect(src).toMatch(/rebuildTraceGraph/);
  });
  it('loads registry-driven graph sources and logs the trace line', () => {
    expect(src).toMatch(/loadGraphSources/);
    expect(src).toMatch(/\[graph-rebuild\] trace:/);
  });
});
