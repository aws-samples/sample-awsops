import { describe, it, expect, beforeAll, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildCanonicalString,
  isSnsCertUrlSafe,
  checkFreshness,
  validateCert,
  verifySnsMessage,
  fetchSnsCert,
} from './sns-verify';

// A node-generated RSA keypair lets us sign canonical strings and verify with the public key,
// without a real cert (validateCertFn is stubbed for those cases).
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const TS = '2026-06-25T00:00:00.000Z';
const NOW = Date.parse(TS) + 60_000; // 1 min after the message

function notification(over: Record<string, unknown> = {}) {
  return {
    Type: 'Notification',
    MessageId: 'm-1',
    TopicArn: 'arn:aws:sns:ap-northeast-2:123456789012:alarms',
    Subject: 'ALARM: HighCPU',
    Message: '{"AlarmName":"HighCPU"}',
    Timestamp: TS,
    SignatureVersion: '2',
    SigningCertURL: 'https://sns.ap-northeast-2.amazonaws.com/SimpleNotificationService-abc.pem',
    ...over,
  };
}
function signMsg(m: Record<string, unknown>, alg = 'RSA-SHA256') {
  const sig = sign(alg, Buffer.from(buildCanonicalString(m), 'utf8'), privateKey);
  return { ...m, Signature: sig.toString('base64') };
}

describe('buildCanonicalString', () => {
  it('Notification: key\\nvalue\\n in fixed order, Subject included when present', () => {
    const s = buildCanonicalString(notification());
    expect(s).toBe(
      'Message\n{"AlarmName":"HighCPU"}\nMessageId\nm-1\nSubject\nALARM: HighCPU\n' +
        'Timestamp\n2026-06-25T00:00:00.000Z\nTopicArn\narn:aws:sns:ap-northeast-2:123456789012:alarms\nType\nNotification\n',
    );
  });
  it('Notification: Subject omitted entirely when absent', () => {
    const s = buildCanonicalString(notification({ Subject: undefined }));
    expect(s).not.toContain('Subject');
  });
  it('SubscriptionConfirmation: uses SubscribeURL + Token, not Subject', () => {
    const s = buildCanonicalString({
      Type: 'SubscriptionConfirmation', MessageId: 'm', Message: 'x', Timestamp: TS, Token: 'tok',
      SubscribeURL: 'https://sns.ap-northeast-2.amazonaws.com/?Action=Confirm', TopicArn: 'arn:t',
    });
    expect(s).toContain('SubscribeURL\n');
    expect(s).toContain('Token\ntok\n');
    expect(s).not.toContain('Subject');
  });
});

describe('isSnsCertUrlSafe', () => {
  it('accepts https sns.<region>.amazonaws.com .pem path', () => {
    expect(isSnsCertUrlSafe('https://sns.us-east-1.amazonaws.com/SimpleNotificationService-x.pem')).toBe(true);
  });
  it('rejects non-https, wrong host, non-pem path, creds', () => {
    expect(isSnsCertUrlSafe('http://sns.us-east-1.amazonaws.com/x.pem')).toBe(false);
    expect(isSnsCertUrlSafe('https://evil.com/SimpleNotificationService-x.pem')).toBe(false);
    expect(isSnsCertUrlSafe('https://sns.us-east-1.amazonaws.com.evil.com/x.pem')).toBe(false);
    expect(isSnsCertUrlSafe('https://sns.us-east-1.amazonaws.com/x.txt')).toBe(false);
    expect(isSnsCertUrlSafe('https://u:p@sns.us-east-1.amazonaws.com/x.pem')).toBe(false);
  });
});

describe('checkFreshness', () => {
  it('true inside window, false outside (past + future)', () => {
    const w = 15 * 60_000;
    expect(checkFreshness(TS, NOW, w)).toBe(true);
    expect(checkFreshness(TS, Date.parse(TS) + 16 * 60_000, w)).toBe(false);
    expect(checkFreshness(TS, Date.parse(TS) - 16 * 60_000, w)).toBe(false);
    expect(checkFreshness('not-a-date', NOW, w)).toBe(false);
  });
});

describe('verifySnsMessage (signature + freshness + url, cert stubbed)', () => {
  const okCert = () => true;
  const fetchPub = async () => pubPem; // public key PEM stands in for the cert's key
  it('ok for a fresh, validly-signed v2 message', async () => {
    const r = await verifySnsMessage(signMsg(notification()), { now: NOW, fetchCert: fetchPub, validateCertFn: okCert });
    expect(r.ok).toBe(true);
  });
  it('rejects a tampered Message (signature mismatch)', async () => {
    const m = signMsg(notification());
    const r = await verifySnsMessage({ ...m, Message: '{"AlarmName":"TAMPERED"}' }, { now: NOW, fetchCert: fetchPub, validateCertFn: okCert });
    expect(r.ok).toBe(false);
  });
  it('rejects a stale (replayed) message', async () => {
    const r = await verifySnsMessage(signMsg(notification()), { now: Date.parse(TS) + 60 * 60_000, fetchCert: fetchPub, validateCertFn: okCert });
    expect(r.ok).toBe(false);
  });
  it('rejects an unsafe SigningCertURL before any fetch', async () => {
    const m = signMsg(notification({ SigningCertURL: 'https://evil.com/x.pem' }));
    const r = await verifySnsMessage(m, { now: NOW, fetchCert: fetchPub, validateCertFn: okCert });
    expect(r.ok).toBe(false);
  });
  it('rejects SignatureVersion not in {1,2}', async () => {
    const r = await verifySnsMessage(signMsg(notification({ SignatureVersion: '9' })), { now: NOW, fetchCert: fetchPub, validateCertFn: okCert });
    expect(r.ok).toBe(false);
  });
});

describe('fetchSnsCert (DoS/SSRF guards: res.ok + cert-parse-before-cache)', () => {
  const BASE = 'https://sns.ap-northeast-2.amazonaws.com/SimpleNotificationService-';
  let certPem = '';
  let haveOpenssl = true;
  beforeAll(() => {
    try {
      const d = mkdtempSync(join(tmpdir(), 'snsfetch-'));
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(d, 'k.pem'),
        '-out', join(d, 'c.pem'), '-days', '2', '-nodes', '-subj', '/O=Amazon/CN=sns.amazonaws.com'], { stdio: 'ignore' });
      certPem = readFileSync(join(d, 'c.pem'), 'utf8');
      rmSync(d, { recursive: true, force: true });
    } catch { haveOpenssl = false; }
  });
  it('returns a valid cert and caches it (second call does not re-fetch)', async () => {
    if (!haveOpenssl) return;
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(certPem, { status: 200 }));
    const u = `${BASE}cache.pem`;
    expect(await fetchSnsCert(u)).toContain('BEGIN CERTIFICATE');
    await fetchSnsCert(u);
    expect(spy).toHaveBeenCalledTimes(1); // served from cache
    spy.mockRestore();
  });
  it('throws on an HTTP error (404) — never cached', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));
    await expect(fetchSnsCert(`${BASE}e404.pem`)).rejects.toBeTruthy();
    spy.mockRestore();
  });
  it('throws on a non-certificate body (e.g. HTML/404 page returned with 200)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>nope</html>', { status: 200 }));
    await expect(fetchSnsCert(`${BASE}html.pem`)).rejects.toBeTruthy();
    spy.mockRestore();
  });
});

describe('validateCert (real X509 via openssl when available)', () => {
  let dir: string | null = null;
  let certPem = '';
  let haveOpenssl = true;
  beforeAll(() => {
    try {
      dir = mkdtempSync(join(tmpdir(), 'snscert-'));
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(dir, 'k.pem'),
        '-out', join(dir, 'c.pem'), '-days', '2', '-nodes',
        '-subj', '/O=Amazon/CN=sns.ap-northeast-2.amazonaws.com'], { stdio: 'ignore' });
      certPem = readFileSync(join(dir, 'c.pem'), 'utf8');
    } catch { haveOpenssl = false; }
  });
  it('accepts a current Amazon-subject cert', () => {
    if (!haveOpenssl) return; // skip if openssl unavailable
    expect(validateCert(certPem, Date.now())).toBe(true);
  });
  it('rejects an expired/not-yet-valid cert (now far outside validity)', () => {
    if (!haveOpenssl) return;
    expect(validateCert(certPem, Date.now() + 10 * 24 * 60 * 60_000)).toBe(false);
  });
  it('rejects a non-Amazon cert', () => {
    if (!haveOpenssl || !dir) return;
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(dir, 'k2.pem'),
      '-out', join(dir, 'c2.pem'), '-days', '2', '-nodes', '-subj', '/O=Evil/CN=evil.example.com'], { stdio: 'ignore' });
    expect(validateCert(readFileSync(join(dir, 'c2.pem'), 'utf8'), Date.now())).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
