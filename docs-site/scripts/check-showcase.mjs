import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const showcase = path.resolve(here, '..', 'static', 'showcase');
const htmlPath = path.join(showcase, 'index.html');

assert.ok(fs.existsSync(htmlPath), 'showcase index.html must exist');
const html = fs.readFileSync(htmlPath, 'utf8');

for (const id of ['main', 'product', 'ai', 'explore', 'diagnosis', 'architecture', 'trust', 'start']) {
  assert.match(html, new RegExp(`id="${id}"`), `missing section #${id}`);
}

for (const asset of [
  'media/dashboard.webp',
  'media/assistant-answer.webp',
  'media/topology.webp',
  'media/cost-explorer.webp',
  'media/compliance.webp',
  'media/ai-diagnosis.webp',
  'awsops-architecture.svg',
]) {
  assert.match(html, new RegExp(asset.replace('.', '\\.')), `missing reference: ${asset}`);
  assert.ok(fs.existsSync(path.join(showcase, asset)), `missing local asset: ${asset}`);
}

assert.match(html, /<h1[^>]*>[\s\S]*AWSops[\s\S]*<\/h1>/);
assert.match(html, /https:\/\/awsops\.atomai\.click\//);
assert.match(html, />9<[\s\S]*AI 라우팅 섹션/);
assert.match(html, />6<[\s\S]*Well-Architected 필러/);
assert.match(html, />3<[\s\S]*리포트 내보내기 형식/);
assert.match(html, /고객 AWS 리소스를 자동 변경하거나 자율 복구하지 않습니다/);
assert.doesNotMatch(html, /(?:src|href)="\/(?!\/)/, 'local links must be relative');
assert.doesNotMatch(html, /43개|125개|8 live|remediation_enabled|\/awsops\/api/);

console.log('showcase contract: ok');
