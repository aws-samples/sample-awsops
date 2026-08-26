# AWSops Screenshot-led Showcase Brochure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public, screenshot-led AWSops showcase at `/awsops/showcase/` while preserving the existing architecture-led brochure.

**Architecture:** Docusaurus copies a standalone `docs-site/static/showcase/index.html` and adjacent assets into the Pages build. A Playwright/Canvas script creates privacy-safe WebP derivatives from current screenshots, while the architecture-diagram skill refreshes a local draw.io/SVG diagram against current v2 facts. Static and browser checks enforce content, accessibility, responsive layout, local asset integrity, and the supplied demo CTA.

**Tech Stack:** Static HTML/CSS, Docusaurus 3.9, TypeScript, Playwright, browser Canvas/WebP, draw.io SVG, Python brochure checker

---

## File map

- Create `docs-site/scripts/showcase-assets.ts`: declarative crop, mask, and label-replacement specifications.
- Create `docs-site/scripts/showcase-assets.test.ts`: validates unique outputs and in-bounds privacy operations.
- Create `docs-site/scripts/build-showcase-media.ts`: renders sanitized WebP derivatives with Playwright Canvas.
- Create `docs-site/static/showcase/media/*.webp`: six generated, public-safe product images.
- Create `docs-site/static/showcase/awsops-architecture.drawio`: editable v2 architecture source.
- Create `docs-site/static/showcase/awsops-architecture.svg`: exported brochure diagram.
- Create `docs-site/scripts/check-showcase.mjs`: static content and path contract.
- Create `docs-site/static/showcase/index.html`: standalone brochure.
- Create `docs-site/scripts/verify-showcase.ts`: browser checks and viewport screenshots.
- Preserve `docs-site/static/brochure/**` and Docusaurus navigation unchanged.

### Task 1: Generate privacy-safe showcase media

**Files:**
- Create: `docs-site/scripts/showcase-assets.ts`
- Create: `docs-site/scripts/showcase-assets.test.ts`
- Create: `docs-site/scripts/build-showcase-media.ts`
- Create: `docs-site/static/showcase/media/dashboard.webp`
- Create: `docs-site/static/showcase/media/assistant-answer.webp`
- Create: `docs-site/static/showcase/media/topology.webp`
- Create: `docs-site/static/showcase/media/cost-explorer.webp`
- Create: `docs-site/static/showcase/media/compliance.webp`
- Create: `docs-site/static/showcase/media/ai-diagnosis.webp`

- [ ] **Step 1: Write the asset-spec test**

Create `docs-site/scripts/showcase-assets.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {ASSETS, validateAssetSpecs} from './showcase-assets';

test('showcase asset outputs are unique WebP files', () => {
  const outputs = ASSETS.map((asset) => asset.output);
  assert.equal(new Set(outputs).size, outputs.length);
  assert.ok(outputs.every((output) => output.endsWith('.webp')));
});

test('all crops and privacy overlays are valid', () => {
  assert.doesNotThrow(() => validateAssetSpecs(1920, 1080));
  for (const asset of ASSETS) {
    assert.ok(asset.outputWidth <= 1600);
    for (const overlay of asset.overlays) {
      assert.ok(overlay.left >= 0 && overlay.top >= 0);
      assert.ok(overlay.left + overlay.width <= asset.crop.width);
      assert.ok(overlay.top + overlay.height <= asset.crop.height);
    }
  }
});

test('topology and diagnosis have baked-in identifier replacements', () => {
  const topology = ASSETS.find((asset) => asset.output === 'topology.webp');
  const diagnosis = ASSETS.find((asset) => asset.output === 'ai-diagnosis.webp');
  assert.deepEqual(
    topology?.overlays.map((overlay) => overlay.label),
    ['DNS endpoint', 'CloudFront', 'Load balancer', 'Target group', 'Healthy targets'],
  );
  assert.equal(diagnosis?.overlays[0]?.label, '호스트 계정 (mid)');
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
cd docs-site && npx tsx scripts/showcase-assets.test.ts
```

Expected: FAIL with `Cannot find module './showcase-assets'`.

- [ ] **Step 3: Add exact crop and privacy specifications**

Create `docs-site/scripts/showcase-assets.ts`:

```ts
import path from 'node:path';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Overlay extends Rect {
  fill: string;
  text: string;
  label?: string;
}

export interface AssetSpec {
  source: string;
  output: string;
  crop: Rect;
  outputWidth: number;
  overlays: Overlay[];
}

const SCREENSHOTS = path.join('static', 'screenshots');

export const ASSETS: AssetSpec[] = [
  {
    source: path.join(SCREENSHOTS, 'overview', 'dashboard.png'),
    output: 'dashboard.webp',
    crop: {left: 0, top: 0, width: 1920, height: 1080},
    outputWidth: 1600,
    overlays: [
      {left: 42, top: 958, width: 180, height: 58, fill: '#f4f6f8', text: '#526173', label: 'Demo operator'},
      {left: 846, top: 210, width: 448, height: 112, fill: '#ffffff', text: '#526173', label: 'Recent AI operations'},
    ],
  },
  {
    source: path.join(SCREENSHOTS, 'overview', 'assistant-answer.png'),
    output: 'assistant-answer.webp',
    crop: {left: 590, top: 112, width: 720, height: 890},
    outputWidth: 1200,
    overlays: [],
  },
  {
    source: path.join(SCREENSHOTS, 'resources', 'topology-detail.png'),
    output: 'topology.webp',
    crop: {left: 288, top: 160, width: 1150, height: 860},
    outputWidth: 1400,
    overlays: [
      {left: 700, top: 108, width: 210, height: 38, fill: '#e8f8ee', text: '#17362b', label: 'DNS endpoint'},
      {left: 700, top: 270, width: 210, height: 38, fill: '#eaf1ff', text: '#1f3763', label: 'CloudFront'},
      {left: 700, top: 429, width: 210, height: 38, fill: '#fff0dc', text: '#523819', label: 'Load balancer'},
      {left: 700, top: 591, width: 210, height: 38, fill: '#f2e9ff', text: '#3e2a5c', label: 'Target group'},
      {left: 700, top: 752, width: 210, height: 38, fill: '#e5f8f5', text: '#173d38', label: 'Healthy targets'},
    ],
  },
  {
    source: path.join(SCREENSHOTS, 'cost', 'cost-explorer.png'),
    output: 'cost-explorer.webp',
    crop: {left: 288, top: 104, width: 1600, height: 900},
    outputWidth: 1600,
    overlays: [],
  },
  {
    source: path.join(SCREENSHOTS, 'overview', 'dashboard.png'),
    output: 'compliance.webp',
    crop: {left: 288, top: 386, width: 1600, height: 190},
    outputWidth: 1600,
    overlays: [],
  },
  {
    source: path.join(SCREENSHOTS, 'operations', 'ai-diagnosis.png'),
    output: 'ai-diagnosis.webp',
    crop: {left: 568, top: 128, width: 1320, height: 900},
    outputWidth: 1600,
    overlays: [
      {left: 190, top: 214, width: 275, height: 42, fill: '#f4f6f8', text: '#18212d', label: '호스트 계정 (mid)'},
    ],
  },
];

export function validateAssetSpecs(sourceWidth: number, sourceHeight: number): void {
  const outputs = new Set<string>();
  for (const asset of ASSETS) {
    if (outputs.has(asset.output)) throw new Error(`duplicate output: ${asset.output}`);
    outputs.add(asset.output);
    const {crop} = asset;
    if (crop.left < 0 || crop.top < 0 ||
        crop.left + crop.width > sourceWidth ||
        crop.top + crop.height > sourceHeight) {
      throw new Error(`crop outside source: ${asset.output}`);
    }
    for (const overlay of asset.overlays) {
      if (overlay.left < 0 || overlay.top < 0 ||
          overlay.left + overlay.width > crop.width ||
          overlay.top + overlay.height > crop.height) {
        throw new Error(`overlay outside crop: ${asset.output}`);
      }
    }
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run:

```bash
cd docs-site && npx tsx scripts/showcase-assets.test.ts
```

Expected: 3 tests pass, 0 fail.

- [ ] **Step 5: Implement the Canvas/WebP generator**

Create `docs-site/scripts/build-showcase-media.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {ASSETS, validateAssetSpecs} from './showcase-assets';

const here = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(here, '..');
const outputDir = path.join(siteRoot, 'static', 'showcase', 'media');

async function main(): Promise<void> {
  validateAssetSpecs(1920, 1080);
  fs.mkdirSync(outputDir, {recursive: true});
  const browser = await chromium.launch({headless: true});
  const page = await browser.newPage();

  try {
    for (const asset of ASSETS) {
      const sourcePath = path.join(siteRoot, asset.source);
      if (!fs.existsSync(sourcePath)) throw new Error(`missing source: ${sourcePath}`);
      const source = fs.readFileSync(sourcePath).toString('base64');
      const dataUrl = await page.evaluate(async ({source, asset}) => {
        const image = new Image();
        image.src = `data:image/png;base64,${source}`;
        await image.decode();
        const scale = asset.outputWidth / asset.crop.width;
        const canvas = document.createElement('canvas');
        canvas.width = asset.outputWidth;
        canvas.height = Math.round(asset.crop.height * scale);
        const ctx = canvas.getContext('2d', {alpha: false});
        if (!ctx) throw new Error('2D canvas unavailable');
        ctx.drawImage(
          image,
          asset.crop.left, asset.crop.top, asset.crop.width, asset.crop.height,
          0, 0, canvas.width, canvas.height,
        );
        for (const overlay of asset.overlays) {
          const x = Math.round(overlay.left * scale);
          const y = Math.round(overlay.top * scale);
          const width = Math.round(overlay.width * scale);
          const height = Math.round(overlay.height * scale);
          ctx.fillStyle = overlay.fill;
          ctx.fillRect(x, y, width, height);
          if (overlay.label) {
            ctx.fillStyle = overlay.text;
            ctx.font = `600 ${Math.max(14, Math.round(14 * scale))}px system-ui, sans-serif`;
            ctx.textBaseline = 'middle';
            ctx.fillText(overlay.label, x + Math.round(12 * scale), y + height / 2, width - Math.round(24 * scale));
          }
        }
        return canvas.toDataURL('image/webp', 0.86);
      }, {source, asset});
      const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const outputPath = path.join(outputDir, asset.output);
      fs.writeFileSync(outputPath, Buffer.from(encoded, 'base64'));
      console.log(`${asset.output}: ${fs.statSync(outputPath).size} bytes`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 6: Generate and inspect all six images**

Run:

```bash
cd docs-site
npx tsx scripts/build-showcase-media.ts
file static/showcase/media/*.webp
```

Expected: six RIFF WebP files, each no wider than 1600px. Open every output with
`view_image`. Confirm account IDs, emails, internal hostnames, ARNs, and
conversation-history resource names are absent. Adjust only the declarative
rectangles in `showcase-assets.ts`, rerun the tests, and regenerate if a label
edge remains visible.

- [ ] **Step 7: Commit the media pipeline and outputs**

```bash
git add docs-site/scripts/showcase-assets.ts \
  docs-site/scripts/showcase-assets.test.ts \
  docs-site/scripts/build-showcase-media.ts \
  docs-site/static/showcase/media
git commit -m "feat(docs): generate sanitized showcase media"
```

### Task 2: Refresh the complete v2 architecture diagram

**Files:**
- Create: `docs-site/static/showcase/awsops-architecture.drawio`
- Create: `docs-site/static/showcase/awsops-architecture.svg`

- [ ] **Step 1: Invoke the architecture-diagram skill**

Use `aws-content-plugin:architecture-diagram`. Start from
`docs-site/static/brochure/awsops-arch.drawio` only as a layout reference; create
new adjacent showcase assets and keep the existing brochure files unchanged.

- [ ] **Step 2: Build the exact current flow**

Export a 1411x871 landscape SVG with these labeled groups and arrows:

```text
User
  -> CloudFront (TLS, Lambda@Edge RS256 + Cognito)
  -> VPC Origin (HTTPS 443)
  -> Internal ALB (HTTPS 443)
  -> ECS Fargate web (arm64, thin BFF)
       -> Aurora Serverless v2 (application state)
       -> AgentCore Runtime (Sonnet 4.6)
            -> Memory + Code Interpreter
            -> 9 routed sections
               network | container | data | security | cost
               monitoring | iac | ops | observability -> external-obs
            -> MCP Lambda tools -> observed AWS/external data (READ ONLY)
       -> POST /api/jobs -> Aurora worker_jobs + SQS
            -> dispatcher -> Step Functions
            -> RunLambda OR ecs:runTask.sync Fargate
            -> status updater + 5-minute reaper
```

Use official AWS icons, left-to-right primary flow, a separate asynchronous
worker lane, and a visibly bounded read-only observation boundary. Do not show
autonomous remediation, AWS-resource mutation, a public ALB, or a `/awsops`
application base path.

- [ ] **Step 3: Validate source and SVG labels**

Run:

```bash
test -s docs-site/static/showcase/awsops-architecture.drawio
test -s docs-site/static/showcase/awsops-architecture.svg
rg -n "CloudFront|VPC Origin|Internal ALB|ECS Fargate|Aurora Serverless|AgentCore Runtime|external-obs|SQS|Step Functions|READ ONLY" \
  docs-site/static/showcase/awsops-architecture.svg
```

Expected: both files are non-empty and every required label is present. Open the
SVG with `view_image` and verify no arrow crosses a label, all nine routes are
legible, and the read-only boundary cannot be mistaken for a mutation path.

- [ ] **Step 4: Commit the architecture**

```bash
git add docs-site/static/showcase/awsops-architecture.drawio \
  docs-site/static/showcase/awsops-architecture.svg
git commit -m "docs(showcase): add current v2 architecture diagram"
```

### Task 3: Build the standalone editorial brochure

**Files:**
- Create: `docs-site/scripts/check-showcase.mjs`
- Create: `docs-site/static/showcase/index.html`

- [ ] **Step 1: Write the failing static contract**

Create `docs-site/scripts/check-showcase.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(here, '..');
const showcase = path.join(siteRoot, 'static', 'showcase');
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
```

- [ ] **Step 2: Run the contract and verify it fails**

Run:

```bash
cd docs-site && node scripts/check-showcase.mjs
```

Expected: FAIL with `showcase index.html must exist`.

- [ ] **Step 3: Create the semantic page and exact copy**

Create `docs-site/static/showcase/index.html` with this section contract and
copy. Keep all CSS in one `<style>` in the document head.

```html
<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>AWSops | 흩어진 AWS 운영을 하나의 화면에</title>
  <meta name="description" content="AWS 운영 현황, 리소스 관계, 비용과 보안을 한 화면에서 보고 Amazon Bedrock AgentCore로 근거 기반 진단을 수행하는 읽기 전용 운영 대시보드입니다.">
  <meta property="og:title" content="AWSops | AWS 운영의 단일 화면">
  <meta property="og:description" content="통합 가시성, 라이브 데이터 기반 AI 답변, Well-Architected 진단을 하나의 운영 흐름으로 연결합니다.">
  <meta property="og:type" content="website">
  <style>
    :root{
      --paper:#f7f8fa;--surface:#fff;--ink:#18212d;--muted:#526173;
      --line:#d9e0e8;--graphite:#111827;--cobalt:#2563eb;
      --cobalt-dark:#174bb8;--coral:#c95032;--teal:#0f766e;
      --maxw:1180px;--shadow:0 14px 36px rgba(24,33,45,.12);
      --sans:Pretendard,"Noto Sans KR",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      --mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace;
    }
    *{box-sizing:border-box}
    html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
    body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.65;letter-spacing:0}
    img{display:block;max-width:100%}
    a{color:inherit;text-decoration:none}
    :focus-visible{outline:3px solid var(--coral);outline-offset:3px}
    .skip-link{position:absolute;left:12px;top:-60px;z-index:100;background:var(--graphite);color:#fff;padding:10px 14px;border-radius:4px}
    .skip-link:focus{top:12px}
    .wrap{width:min(100% - 48px,var(--maxw));margin:0 auto}
    .nav{position:sticky;top:0;z-index:50;background:rgba(247,248,250,.96);border-bottom:1px solid var(--line)}
    .nav-in{height:62px;display:flex;align-items:center;gap:24px}
    .brand{font-size:19px;font-weight:800}
    .nav-links{display:flex;align-items:center;gap:24px;margin-left:auto;font-size:14px;color:var(--muted)}
    .button{display:inline-flex;min-height:42px;align-items:center;justify-content:center;padding:0 18px;border-radius:6px;background:var(--cobalt);color:#fff;font-weight:750}
    .button:hover{background:var(--cobalt-dark)}
    .hero{position:relative;height:calc(100svh - 132px);min-height:580px;max-height:760px;overflow:hidden;background:var(--graphite)}
    .hero-media{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center top}
    .hero-scrim{position:absolute;inset:0 52% 0 0;background:rgba(17,24,39,.9)}
    .hero-content{position:relative;z-index:2;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;color:#fff}
    .eyebrow{font-family:var(--mono);font-size:12px;color:#a8c3ff;text-transform:uppercase}
    h1{margin:10px 0 0;font-size:64px;line-height:1;font-weight:850;letter-spacing:0}
    .hero-line{max-width:12ch;margin:20px 0 0;font-size:34px;line-height:1.16;font-weight:750}
    .hero-copy{max-width:42ch;margin:18px 0 26px;color:#d7dfeb}
    .band,.section{padding:82px 0}
    .band{background:#fff;border-bottom:1px solid var(--line)}
    .section-head{max-width:720px;margin-bottom:34px}
    .kicker{font-family:var(--mono);font-size:12px;color:var(--cobalt);text-transform:uppercase}
    h2{margin:8px 0 12px;font-size:38px;line-height:1.16;letter-spacing:0}
    .lead{margin:0;color:var(--muted);font-size:18px}
    .proofs{display:grid;grid-template-columns:repeat(3,1fr);border-block:1px solid var(--line)}
    .proof{padding:22px 0}
    .proof+.proof{border-left:1px solid var(--line);padding-left:24px}
    .proof b{display:block;font-size:32px}
    .proof span{color:var(--muted)}
    .story{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(260px,.8fr);gap:48px;align-items:center}
    .story.reverse{grid-template-columns:minmax(260px,.8fr) minmax(0,1.2fr)}
    .frame{margin:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#edf1f5;box-shadow:var(--shadow)}
    .frame img{width:100%;object-fit:cover}
    .frame.wide img{aspect-ratio:16/9}.frame.tall img{aspect-ratio:4/5}
    .frame figcaption{padding:10px 14px;background:#fff;color:var(--muted);font-size:13px}
    .pair{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}
    .trust-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:8px;overflow:hidden}
    .trust-item{background:#fff;padding:24px}.trust-item h3{margin:0 0 8px;font-size:17px}.trust-item p{margin:0;color:var(--muted);font-size:14px}
    .architecture{background:#eef2f6;border-block:1px solid var(--line)}
    .arch-figure{margin:0;background:#fff;border:1px solid var(--line);border-radius:8px;padding:14px;overflow:hidden}
    .arch-figure img{width:100%;height:auto}
    .arch-hint{display:none;color:var(--muted);font-size:13px;text-align:center}
    .closing{background:var(--graphite);color:#fff;text-align:center}
    .closing h2{max-width:18ch;margin:0 auto 14px}.closing p{max-width:52ch;margin:0 auto 26px;color:#cbd5e1}
    footer{padding:32px 0;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
    .footer-in{display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap}
    @media (max-width:1024px){
      h1{font-size:52px}.hero-line{font-size:30px}.hero-scrim{inset:0 38% 0 0}
      .story,.story.reverse{grid-template-columns:1fr}.story.reverse .story-copy{order:-1}
      .trust-grid{grid-template-columns:1fr 1fr}
    }
    @media (max-width:640px){
      .wrap{width:min(100% - 36px,var(--maxw))}.nav-links a:not(.button){display:none}
      .hero{height:calc(100svh - 120px);min-height:540px}.hero-scrim{inset:0;background:rgba(17,24,39,.8)}
      h1{font-size:42px}.hero-line{font-size:27px}.band,.section{padding:62px 0}h2{font-size:30px}
      .proofs{grid-template-columns:1fr}.proof+.proof{border-left:0;border-top:1px solid var(--line);padding-left:0}
      .pair,.trust-grid{grid-template-columns:1fr}.hero .button,.closing .button{width:100%}
      .arch-figure{position:relative;padding:0;aspect-ratio:871/1411}
      .arch-figure img{position:absolute;top:50%;left:50%;max-width:none;width:calc((100vw - 36px)*1411/871);height:auto;transform:translate(-50%,-50%) rotate(90deg)}
      .arch-hint{display:block}
    }
    @media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important;animation:none!important}}
  </style>
</head>
<body>
  <a class="skip-link" href="#main">본문으로 건너뛰기</a>
  <nav class="nav" aria-label="주요 탐색">
    <div class="wrap nav-in"><a class="brand" href="#top">AWSops</a>
      <div class="nav-links"><a href="#product">제품</a><a href="#ai">AI 진단</a><a href="#architecture">아키텍처</a><a href="#trust">신뢰</a><a class="button" href="https://awsops.atomai.click/" target="_blank" rel="noopener noreferrer">제품 데모 보기</a></div>
    </div>
  </nav>
  <header class="hero" id="top">
    <img class="hero-media" src="media/dashboard.webp" alt="AWSops 통합 운영 대시보드" fetchpriority="high">
    <div class="hero-scrim" aria-hidden="true"></div>
    <div class="wrap hero-content"><span class="eyebrow">AWS + Kubernetes operations</span><h1>AWSops</h1><p class="hero-line">흩어진 AWS 운영을 하나의 화면에.</p><p class="hero-copy">운영 현황을 보고, 라이브 데이터에 질문하고, Well-Architected 관점의 진단까지 한 흐름으로 이어갑니다.</p><a class="button" href="https://awsops.atomai.click/" target="_blank" rel="noopener noreferrer">제품 데모 보기</a></div>
  </header>
  <main id="main">
    <section class="band" id="product"><div class="wrap"><div class="section-head"><span class="kicker">See</span><h2>먼저, 운영 전체를 봅니다.</h2><p class="lead">AWS 리소스, Kubernetes, 비용, 보안 신호를 하나의 대시보드에서 비교합니다.</p></div><div class="proofs"><div class="proof"><b>9</b><span>AI 라우팅 섹션</span></div><div class="proof"><b>6</b><span>Well-Architected 필러</span></div><div class="proof"><b>3</b><span>리포트 내보내기 형식</span></div></div></div></section>
    <section class="section" id="ai"><div class="wrap story"><figure class="frame tall"><img src="media/assistant-answer.webp" loading="lazy" alt="비용 질문에 근거를 제시하는 AWSops AI 어시스턴트"><figcaption>도메인별 읽기 전용 도구가 수집한 근거를 하나의 답변으로 합성합니다.</figcaption></figure><div class="story-copy"><span class="kicker">Ask</span><h2>운영 데이터에 바로 질문합니다.</h2><p class="lead">질문 의도를 전문 라우트로 분류하고 라이브 데이터를 조회합니다. 여러 도메인의 결과는 한 번에 읽을 수 있는 답변으로 돌아옵니다.</p></div></div></section>
    <section class="band" id="explore"><div class="wrap"><div class="section-head"><span class="kicker">Explore</span><h2>관계, 비용, 통제를 같은 맥락에서.</h2><p class="lead">리소스 흐름을 따라가고, 비용 추이와 보안 통제를 함께 확인합니다.</p></div><figure class="frame wide"><img src="media/topology.webp" loading="lazy" alt="DNS에서 타깃까지 이어지는 AWS 리소스 토폴로지"><figcaption>요청 경로와 리소스 관계를 시각적으로 탐색합니다.</figcaption></figure><div class="pair"><figure class="frame wide"><img src="media/cost-explorer.webp" loading="lazy" alt="월별 및 일별 AWS 비용 추이"><figcaption>서비스별 비용과 변화를 비교합니다.</figcaption></figure><figure class="frame wide"><img src="media/compliance.webp" loading="lazy" alt="보안 이슈와 CIS 컴플라이언스 요약"><figcaption>위험 신호와 컴플라이언스 상태를 빠르게 확인합니다.</figcaption></figure></div></div></section>
    <section class="section" id="diagnosis"><div class="wrap story reverse"><div class="story-copy"><span class="kicker">Diagnose</span><h2>관찰을 의사결정 자료로 바꿉니다.</h2><p class="lead">무거운 진단은 비동기 워커에서 처리하고, Well-Architected 관점의 결과를 MD, DOCX, PDF로 내보냅니다.</p></div><figure class="frame wide"><img src="media/ai-diagnosis.webp" loading="lazy" alt="AWSops AI 진단 보고서와 목차"><figcaption>진단 결과와 개선 제안을 구조화된 보고서로 제공합니다.</figcaption></figure></div></section>
    <section class="section architecture" id="architecture"><div class="wrap"><div class="section-head"><span class="kicker">Architecture</span><h2>제품 경험을 지탱하는 전체 v2 구조.</h2><p class="lead">비공개 엣지, thin BFF, Aurora, AgentCore 전문 라우팅, 비동기 워커가 역할별로 분리됩니다.</p></div><figure class="arch-figure"><img src="awsops-architecture.svg" loading="lazy" alt="CloudFront VPC Origin부터 Fargate, Aurora, AgentCore 9개 라우트와 비동기 워커까지 이어지는 AWSops v2 아키텍처"></figure><p class="arch-hint">모바일에서는 다이어그램을 세로 방향으로 표시합니다.</p></div></section>
    <section class="section" id="trust"><div class="wrap"><div class="section-head"><span class="kicker">Trust</span><h2>변경보다 근거를 우선합니다.</h2><p class="lead">AWSops는 운영 상태를 관찰하고 진단과 개선 제안을 제공합니다. 진단 결과로 고객 AWS 리소스를 자동 변경하거나 자율 복구하지 않습니다.</p></div><div class="trust-grid"><article class="trust-item"><h3>Private edge</h3><p>CloudFront VPC Origin 뒤의 내부 ALB로 애플리케이션을 보호합니다.</p></article><article class="trust-item"><h3>Verified identity</h3><p>Cognito와 Lambda@Edge의 RS256 검증으로 접근을 통제합니다.</p></article><article class="trust-item"><h3>Least privilege</h3><p>라이브 조회는 AgentCore MCP 도구 경계 안에서 읽기 전용으로 수행합니다.</p></article><article class="trust-item"><h3>Encrypted state</h3><p>Aurora와 관리형 시크릿으로 상태와 자격 증명을 분리합니다.</p></article></div></div></section>
    <section class="section closing" id="start"><div class="wrap"><h2>운영을 하나의 화면으로 옮겨보세요.</h2><p>실제 대시보드에서 통합 가시성과 AI 진단 흐름을 확인할 수 있습니다.</p><a class="button" href="https://awsops.atomai.click/" target="_blank" rel="noopener noreferrer">제품 데모 보기</a></div></section>
  </main>
  <footer><div class="wrap footer-in"><span>AWSops · Terraform · ECS Fargate · Aurora · Bedrock AgentCore</span><span><a href="https://github.com/Atom-oh/awsops">GitHub</a> · <a href="../brochure/">Architecture brochure</a></span></div></footer>
</body>
</html>
```

During implementation, refine spacing and object positions only after browser
screenshots; preserve the exact section IDs, claims, relative local paths,
no-gradient palette, `h1`, CTA, and accessibility primitives above.

- [ ] **Step 4: Run static checks**

Run:

```bash
cd docs-site
node scripts/check-showcase.mjs
python3 /home/atomoh/.codex/plugins/cache/oh-my-cloud-skills/aws-content-plugin/1.14.1/skills/brochure/scripts/check_brochure.py \
  static/showcase/index.html
```

Expected: `showcase contract: ok`; brochure checker reports 0 fail.

- [ ] **Step 5: Commit the brochure**

```bash
git add docs-site/scripts/check-showcase.mjs docs-site/static/showcase/index.html
git commit -m "feat(docs): add screenshot-led AWSops showcase"
```

### Task 4: Add automated browser verification

**Files:**
- Create: `docs-site/scripts/verify-showcase.ts`
- Create locally, do not commit: `docs-site/.artifacts/showcase-375.png`
- Create locally, do not commit: `docs-site/.artifacts/showcase-768.png`
- Create locally, do not commit: `docs-site/.artifacts/showcase-1440.png`

- [ ] **Step 1: Write viewport and asset assertions**

Create `docs-site/scripts/verify-showcase.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';

const baseUrl = process.env.SHOWCASE_URL ?? 'http://127.0.0.1:3002/awsops/showcase/';
const viewports = [
  {name: '375', width: 375, height: 812},
  {name: '768', width: 768, height: 1024},
  {name: '1440', width: 1440, height: 1000},
];
const outputDir = path.resolve('.artifacts');
fs.mkdirSync(outputDir, {recursive: true});

const browser = await chromium.launch({headless: true});
try {
  for (const viewport of viewports) {
    const page = await browser.newPage({viewport});
    const response = await page.goto(baseUrl, {waitUntil: 'networkidle'});
    assert.equal(response?.status(), 200);
    await page.evaluate(async () => {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((resolve) => setTimeout(resolve, 400));
      window.scrollTo(0, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const result = await page.evaluate(() => {
      const images = [...document.images];
      const hero = document.querySelector('.hero')?.getBoundingClientRect();
      const product = document.querySelector('#product')?.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        failedImages: images.filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.src),
        heroBottom: hero?.bottom ?? Number.POSITIVE_INFINITY,
        productTop: product?.top ?? Number.POSITIVE_INFINITY,
        cta: document.querySelector<HTMLAnchorElement>('#start a.button')?.href,
      };
    });
    assert.ok(result.overflow <= 1, `${viewport.name}: horizontal overflow ${result.overflow}`);
    assert.deepEqual(result.failedImages, []);
    assert.ok(result.heroBottom < viewport.height, `${viewport.name}: next section is not visible below hero`);
    assert.ok(result.productTop < viewport.height, `${viewport.name}: product section hint missing`);
    assert.equal(result.cta, 'https://awsops.atomai.click/');
    await page.screenshot({
      path: path.join(outputDir, `showcase-${viewport.name}.png`),
      fullPage: true,
    });
    await page.close();
  }
  console.log('showcase browser verification: ok');
} finally {
  await browser.close();
}
```

- [ ] **Step 2: Ensure artifacts stay untracked**

Append only if absent:

```gitignore
docs-site/.artifacts/
```

to the repository `.gitignore`.

- [ ] **Step 3: Build and start the local docs server**

Run:

```bash
cd docs-site
npm run build
npm run serve -- --host 0.0.0.0 --port 3002 --no-open
```

Expected: Docusaurus builds successfully and serves the site on port 3002. Keep
this process running for the next steps.

- [ ] **Step 4: Run browser verification**

In a second terminal:

```bash
cd docs-site
npx tsx scripts/verify-showcase.ts
```

Expected: `showcase browser verification: ok` and three PNGs under
`docs-site/.artifacts/`.

- [ ] **Step 5: Inspect all three renders**

Open each artifact with `view_image`. Verify:

- No overlap, clipped Korean text, blank frame, or horizontal scroll.
- The product name and real dashboard are first-viewport signals.
- A visible hint of the `See` section appears below the hero.
- Mobile architecture labels remain readable after rotation.
- Buttons are at least 40px high and mobile CTAs fit their containers.
- The page does not read as a one-note blue, beige, dark-slate, or orange theme.

Fix `index.html`, rerun both static checkers, rebuild, and rerun browser
verification until all checks hold.

- [ ] **Step 6: Commit verification and layout fixes**

```bash
git add .gitignore docs-site/scripts/verify-showcase.ts docs-site/static/showcase/index.html
git commit -m "test(docs): verify showcase across viewports"
```

### Task 5: Run final quality and public-route gates

**Files:**
- Verify: `docs-site/static/showcase/index.html`
- Verify: `docs-site/static/showcase/awsops-architecture.svg`
- Verify: `docs-site/static/showcase/media/*.webp`

- [ ] **Step 1: Run all deterministic checks**

```bash
cd docs-site
npx tsx scripts/showcase-assets.test.ts
node scripts/check-showcase.mjs
python3 /home/atomoh/.codex/plugins/cache/oh-my-cloud-skills/aws-content-plugin/1.14.1/skills/brochure/scripts/check_brochure.py \
  static/showcase/index.html
npm run build
```

Expected: all tests pass, brochure checker has 0 fail, and Docusaurus build exits
0.

- [ ] **Step 2: Verify built asset URLs**

With the local server still running:

```bash
for path in \
  /awsops/showcase/ \
  /awsops/showcase/media/dashboard.webp \
  /awsops/showcase/media/assistant-answer.webp \
  /awsops/showcase/media/topology.webp \
  /awsops/showcase/media/cost-explorer.webp \
  /awsops/showcase/media/compliance.webp \
  /awsops/showcase/media/ai-diagnosis.webp \
  /awsops/showcase/awsops-architecture.svg
do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3002${path}")
  test "$code" = 200 || { echo "${path}: ${code}"; exit 1; }
done
echo "showcase assets: 200"
```

Expected: `showcase assets: 200`.

- [ ] **Step 3: Run the mandatory content review**

Discover and invoke the content-review agent with:

```text
review content at docs-site/static/showcase/index.html
```

Provide the architecture SVG and six WebP files as adjacent context. Require a
score of at least 85. Fix every factual contradiction, PII finding, inaccessible
copy, or diagram/copy mismatch, then rerun Steps 1 and 2.

- [ ] **Step 4: Review the final diff and posture**

Run:

```bash
git diff --check
git status --short
git diff HEAD~4 -- docs-site/static/showcase docs-site/scripts .gitignore
rg -n "remediation_enabled|mutation|autonomous|125|43개|8 live|/awsops/api" \
  docs-site/static/showcase || true
```

Expected: no whitespace errors; only showcase files, focused scripts, and the
optional artifact ignore are part of the feature; no stale metric or enabled
mutation claim appears.

- [ ] **Step 5: Report the local preview**

Keep the local server running and provide:

```text
http://localhost:3002/awsops/showcase/
```

Do not deploy or edit the navbar until the user has compared the new page with
the existing brochure.
