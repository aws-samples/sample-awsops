#!/usr/bin/env node
// ADR-038: live hybrid-routing accuracy gate. Calls real Bedrock (Haiku) — needs AWS creds.
// Usage: node scripts/v2/routing-accuracy.mjs
import { execSync } from 'node:child_process';

console.log('\n[1/1] live routing accuracy (golden set, real Bedrock)');
try {
  execSync('npx vitest run lib/golden-routing.live.test.ts', {
    stdio: 'inherit', shell: '/bin/bash', cwd: new URL('../../web', import.meta.url).pathname,
    env: { ...process.env, LIVE_ROUTING: '1' },
  });
  console.log('\n✅ routing accuracy gate PASSED');
} catch {
  console.error('✗ routing accuracy gate FAILED — keep hybrid_routing_enabled=false');
  process.exit(1);
}
