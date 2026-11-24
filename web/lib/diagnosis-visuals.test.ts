// @vitest-environment node
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildDiagnosisDeck } from './diagnosis-deck';
import { renderDeckHtml } from './diagnosis-slides-html';
import { renderDeckPptx } from './diagnosis-slides-pptx';

const header = '## Current architecture\n\n| Relationship | Endpoints | Source and scope |\n|---|---|---|\n';
const vpc = 'vpc-0123456789abcdef0 (us-west-2)';
const vpcSource = 'Inventory · infra:in_vpc · stale';

describe('architecture briefing', () => {
  it('renders regional membership, a sampled call and an unresolved row with independent semantics', async () => {
    const markdown =
      header +
      [
        `| Configuration | gateway (us-west-2) / ${vpc} | ${vpcSource} |`,
        `| Configuration | route (us-west-2) / ${vpc} | ${vpcSource} |`,
        `| Configuration | gateway / vpc-0123456789abcdef0 (us-east-1) | ${vpcSource} |`,
        '| Observed call (binding unverified) | `a / b` → `a → b` | X-Ray · sampled |',
        '| Network flow (direction unconfirmed) | a / b | NFM · partial |',
        '| Proposed path | db → cache | hypothesis |',
      ].join('\n');
    const deck = buildDiagnosisDeck({ id: 3, markdown }, 'ko');
    const placement = deck.slides.find((s) => s.visual?.kind === 'placement')!;
    expect(placement.visual).toMatchObject({
      container: vpc,
      rows: [
        { left: 'gateway (us-west-2)', source: 'Inventory · stale' },
        { left: 'route (us-west-2)', source: 'Inventory · stale' },
      ],
    });
    const relationships = deck.slides.find((s) => s.visual?.kind === 'relationships')!;
    expect(relationships.visual).toMatchObject({
      rows: [
        { directed: false, right: 'vpc-0123456789abcdef0 (us-east-1)' },
        { directed: true, left: 'a / b', right: 'a → b', source: 'X-Ray · sampled' },
        { directed: false, source: 'NFM · partial' },
      ],
    });
    expect(deck.slides.at(-1)?.items[0].text).toContain('hypothesis');
    const html = await renderDeckHtml(deck);
    expect(html).toContain('class="vpc"');
    expect(html.match(/class="connector directed"/g)).toHaveLength(1);
    const archive = await JSZip.loadAsync(await (await renderDeckPptx(deck)).arrayBuffer());
    const page = await archive.file('ppt/slides/slide3.xml')!.async('string');
    expect(page.match(/<p:cxnSp>/g)).toHaveLength(3);
    expect(page.match(/<a:stCxn /g)).toHaveLength(3);
    expect(page.match(/<a:endCxn /g)).toHaveLength(3);
    expect(page.match(/<a:tailEnd type="triangle"/g)).toHaveLength(1);
    expect(page).toContain('X-Ray · sampled');
  });
  it.each([
    ['현재 아키텍처', '관계 유형', '양 끝점', '관측 근거와 범위', '허용 경로'],
    ['Current architecture', 'Relationship', 'Endpoints', 'Source and scope', 'Permitted path'],
    ['現在のアーキテクチャ', '関係', '両端', '根拠と範囲', '許可された経路'],
    ['当前架构', '关系', '两个端点', '证据和范围', '允许的路径'],
  ])(
    'keeps permission edges neutral for saved %s regardless of the UI locale',
    (section, kind, pair, scope, label) => {
      const markdown = `## ${section}\n\n| ${kind} | ${pair} | ${scope} |\n|---|---|---|\n| ${label} | a / b | audit |\n`;
      expect(buildDiagnosisDeck({ id: 5, markdown }, 'en').slides[1].visual).toMatchObject({
        kind: 'relationships',
        rows: [{ directed: false }],
      });
    },
  );
  it('keeps every decision and qualifier visible, including the last phase and an inventory-only architecture', () => {
    const markdown =
      '## Current architecture\n\nCompare each boundary with its owner.\n\n| Boundary | Assessed components | Decision |\n|---|---|---|\n| Data | DB only | Confirm retention |\n\n' +
      '## Plan\n\n| Horizon | Owner | Action | Gate |\n|---|---|---|---|\n' +
      Array.from({ length: 8 }, (_, i) => `| Week ${i + 1} | team | try | check-${i + 1} |`).join('\n') +
      '\n\nRetain the fallback.';
    const { slides } = buildDiagnosisDeck({ id: 4, markdown }, 'en');
    expect(slides[1]).toMatchObject({
      visual: { kind: 'boundaries' },
      caption: 'Compare each boundary with its owner.',
    });
    expect(slides.flatMap((s) => s.items).some((i) => i.text.includes('check-8'))).toBe(true);
    expect(slides.at(-1)?.items[0].text).toBe('Retain the fallback.');
    expect(slides.some((s) => s.visual?.kind === 'relationships')).toBe(false);
  });
  it('plots comparable units with editable chart data and retains mixed measurements as a table', async () => {
    const markdown =
      '## Cost\n\n| Service | Estimated (USD) | Decision |\n|---|---|---|\n| A | 1.25 USD | Review A |\n| B | 2 USD | Review B |\n\n' +
      '## Metrics\n\n| Metric | dev | staging |\n|---|---|---|\n| CPU | 20% | 10% |\n| Queue | 3 | 6 |';
    const deck = buildDiagnosisDeck({ id: 2, markdown }, 'en');
    expect(deck.slides[1].visual).toMatchObject({ kind: 'comparison', values: [1.25, 2] });
    expect(deck.slides[2].visual).toMatchObject({ kind: 'matrix' });
    const zip = await JSZip.loadAsync(await (await renderDeckPptx(deck)).arrayBuffer());
    expect(await zip.file('ppt/charts/chart1.xml')!.async('string')).toContain('1.25');
    expect(Object.keys(zip.files).some((n) => n.endsWith('.xlsx'))).toBe(true);
  });
});
