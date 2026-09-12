import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smokeArgs } from './deployment-smoke.mjs';

test('smoke uses service Host/SNI and verified TLS via the CloudFront connection', () => {
  assert.deepEqual(smokeArgs('https://dev.example.com', 'd123.cloudfront.net'), [
    '-fsS', '--max-time', '30', '--connect-to',
    'dev.example.com:443:d123.cloudfront.net:443', 'https://dev.example.com/api/health',
  ]);
});

test('smoke refuses non-HTTPS, credentials, unexpected ports/paths and foreign destinations', () => {
  for (const url of ['http://dev.example.com', 'https://user@dev.example.com',
    'https://dev.example.com:8443', 'https://dev.example.com/path', 'https://dev.example.com?q=1']) {
    assert.throws(() => smokeArgs(url, 'd123.cloudfront.net'));
  }
  for (const destination of ['internal-alb.example.com', 'd123.cloudfront.net.evil.com', '-k']) {
    assert.throws(() => smokeArgs('https://dev.example.com', destination));
  }
});
