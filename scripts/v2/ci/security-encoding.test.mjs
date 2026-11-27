import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { hclString } from '../hcl-string.mjs';
import { captureUrlPolicy } from '../../../docs-site/scripts/capture-url.mjs';

test('capture credential refusal exits nonzero and closes the browser', async () => {
  const requireWeb = createRequire(new URL('../../../web/package.json', import.meta.url));
  const ts = requireWeb('typescript');
  const source = readFileSync(new URL('../../../docs-site/scripts/capture-screenshots.ts', import.meta.url), 'utf8')
    .replace(/\bmain\(\);\s*$/, 'module.exports.finished = main();');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const currentUrl of ['https://app.example/login', 'https://app.example.evil.test/login']) {
    let closed = false;
    const errors = [];
    const page = {
      route: async () => {},
      goto: async () => {},
      waitForTimeout: async () => {},
      url: () => currentUrl,
    };
    const browser = {
      newContext: async () => ({ newPage: async () => page }),
      close: async () => { closed = true; },
    };
    const module = { exports: {} };
    const process = { env: { AWSOPS_CAPTURE_URL: 'https://app.example' }, argv: [] };
    runInNewContext(compiled, {
      module, exports: module.exports, process, __dirname: '/capture', URL,
      console: { log() {}, warn() {}, error: (...args) => errors.push(args.join(' ')) },
      require(name) {
        if (name === 'playwright') return { chromium: { launch: async () => browser } };
        if (name === './capture-url.mjs') return { captureUrlPolicy };
        if (name === 'fs') return { mkdirSync() {} };
        if (name === 'dns') return { setServers() {} };
        if (name === 'path') return requireWeb('node:path');
        throw new Error('Unexpected capture dependency: ' + name);
      },
    });
    await module.exports.finished;
    assert.equal(process.exitCode, 1);
    assert.equal(closed, true);
    assert.match(errors.join('\n'), /AWSOPS_LOGIN_PASSWORD is required|unconfigured origin/);
  }
});

test('presenter title serialization does not turn title text into a script', () => {
  const requireWeb = createRequire(new URL('../../../web/package.json', import.meta.url));
  const { JSDOM } = requireWeb('jsdom');
  const dom = new JSDOM('<title>test</title>', {
    url: 'https://app.example/presentation/', runScripts: 'outside-only',
  });
  const source = readFileSync(new URL(
    '../../../docs-site/static/presentation/awsops-intro/common/presenter-view.js', import.meta.url), 'utf8');
  dom.window.eval(source + '\nwindow.PresenterClass = PresenterView;');
  dom.window.document.title = '</title><script>window.injected=true</script>';
  const html = dom.window.PresenterClass.prototype.createPresenterHTML.call({ _collectStyleSheets: () => '' });
  const parsed = new JSDOM(html);
  try {
    assert.equal(parsed.window.document.title, 'Presenter View - ' + dom.window.document.title);
    assert.equal([...parsed.window.document.scripts].some((s) => s.textContent.includes('window.injected=true')), false);
  } finally {
    parsed.window.close();
    dom.window.close();
  }
});

test('HCL strings preserve quotes, backslashes, newlines and literal templates', () => {
  assert.equal(hclString('a"\\\nb\t'), '"a\\"\\\\\\u000ab\\u0009"');
  assert.equal(hclString('\b\f\\b'), '"\\u0008\\u000c\\\\b"');
  assert.equal(hclString('${file("private")} %{if true}'), '"$${file(\\"private\\")} %%{if true}"');
  assert.equal(hclString('$${x} %%{y}'), '"$$${x} %%%{y}"');
});

test('capture login requires exact configured origins, never suffix/path/userinfo matches', () => {
  const policy = captureUrlPolicy('https://app.example', 'https://tenant.auth.example');
  assert.equal(policy.isApp('https://app.example/dashboard'), true);
  assert.equal(policy.isHostedLogin('https://tenant.auth.example/login'), true);
  for (const url of [
    'https://app.example.evil.test/login',
    'https://evil.test/app.example',
    'https://app.example@evil.test',
    'http://app.example/login',
    'https://app.example:444/login',
    'https://user@app.example/login',
  ]) assert.equal(policy.isApp(url), false, url);
  for (const url of [
    'https://tenant.auth.example.evil.test',
    'https://another.auth.example/login',
    'https://evil.test/?auth.=amazoncognito.com',
  ]) assert.equal(policy.isHostedLogin(url), false, url);
  assert.equal(captureUrlPolicy('https://app.example').isHostedLogin('https://tenant.auth.example'), false);
});

test('only exact loopback names permit HTTP/local login bypass', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(captureUrlPolicy(`http://${host}:3000`).local, true);
  }
  assert.equal(captureUrlPolicy('https://localhost.evil.test').local, false);
  assert.throws(() => captureUrlPolicy('http://localhost.evil.test'));
  assert.throws(() => captureUrlPolicy('https://user:password@app.example'));
  assert.throws(() => captureUrlPolicy('file:///tmp/page.html'));
});
