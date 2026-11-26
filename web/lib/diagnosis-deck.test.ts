import { describe, it, expect } from 'vitest';
import { buildDiagnosisDeck } from './diagnosis-deck';
import { renderDeckHtml } from './diagnosis-slides-html';

describe('presentations of stored diagnoses', () => {
  it('keeps source rows in notes and excludes the evidence ledger from briefing pages', async () => {
    const text = [
      '## Assessment',
      '### Top risks',
      '| Rank | Pillar · severity | Subject · assessment | Evidence source |',
      '| --- | --- | --- | --- |',
      '| 1 | Security | Encryption setting needs review. | sampled inventory |',
      '## Security',
      '- Check the workload owner.',
      '## Evidence appendix',
      'Internal source detail.',
    ].join('\n');
    const deck = buildDiagnosisDeck({ id: 71, status: 'partial', markdown: text }, 'en');
    expect(deck.metadata).toContain('Partial assessment');
    const risk = deck.slides.find((s) => s.title === 'Top risks')!;
    expect(risk.items[0].text).toBe('Encryption setting needs review.');
    expect(risk.notes).toContain('sampled inventory');
    expect(deck.slides.some((s) => s.chapter === 'Evidence appendix')).toBe(false);
    expect(await renderDeckHtml(deck)).toContain('Internal source detail.');
  });
  it.each([
    ['Review the route. Compare traffic.', 'Review the route.'],
    ['Check v1.2 before continuing', 'Check v1.2 before continuing'],
    ['확인하세요。 비교하세요。', '확인하세요。'],
  ])('keeps the sentence ending in the first action on the cover', (action, expected) => {
    const markdown = '## Assessment\n\n### Immediate checks\n\n| Subject | Check |\n|---|---|\n| DB | ' + action + ' |';
    expect(buildDiagnosisDeck({ id: 2, markdown }, 'en').firstAction).toBe(expected);
  });

  it('shows the selected range and retains omitted rows in notes', () => {
    const markdown =
      '## Inventory\n| Type | Count | Example |\n|---|---|---|\n' +
      ['vm', 'db', 'queue', 'service'].map((s, i) => `| ${s} | ${10 - i} | example-${s} |`).join('\n');
    const slide = buildDiagnosisDeck({ id: 1, markdown }, 'en').slides[1];
    expect(slide.total).toBe(4);
    expect(slide.items.map((r) => r.count)).toEqual([10, 9, 8]);
    expect(slide.notes).toContain('example-service');
  });
  it('preserves legacy prose without interpreting inline source markup or image URLs as active content', async () => {
    const deck = buildDiagnosisDeck(
      {
        id: 3,
        title: '<source-title />',
        markdown:
          '# Old report\n\nRead-only text.\n\n![diagram](https://example.invalid/diagram.png)\n\n<custom-element />',
      },
      'en',
    );
    const html = await renderDeckHtml(deck);
    expect(html).toContain('Read-only text.');
    expect(html).toContain('&lt;source-title /&gt;');
    expect(html).not.toContain('<custom-element');
    expect(html).not.toContain('https://example.invalid/');
    expect(html).toContain("default-src 'none'");
  });
});

describe('stored heading and decision-role compatibility', () => {
  it('keeps old doubled subheadings inside their source section', () => {
    const deck = buildDiagnosisDeck({id: 8, markdown: '## Security\n\n## ### Follow-up\n\nRead the policy.'}, 'en');
    expect(deck.sections.map(s => s.title)).toEqual(['Security']);
    expect(deck.slides.some(s => s.chapter === 'Security' && s.title === 'Follow-up')).toBe(true);
  });
  it.each([true, false])('keeps decision criteria separate from findings and table scope (table=%s)', (table) => {
    const md = '## Security\n\nPartial assessment · Admitted findings 1\n\n**DB** · Hypothesis\n\nReview encryption.\n\n'
      + (table ? '### Root Cause and Remediation\n\n| Subject | How to verify |\n|---|---|\n| DB | Check policy. |\n\n' : '')
      + '**Decision criteria**\n\nCompare actual settings with policy.';
    const deck = buildDiagnosisDeck({id: 2, markdown: md}, 'en');
    const decision = deck.slides.filter(s => s.title === 'Decision criteria');
    expect(decision).toHaveLength(1);
    expect(decision[0].items[0].text).toBe('Compare actual settings with policy.');
    expect(deck.slides.filter(s => s !== decision[0]).every(s =>
      !s.caption.includes('Compare actual') && s.items.every(r => !r.text.includes('Compare actual')))).toBe(true);
  });
});

it('retains each finding and its scoped provenance in native slide notes only', () => {
  const md = '## Security\n\nPartial assessment · Admitted findings 1\n\n**DB** · Hypothesis\n\n' +
    'Review storage protection.\n\nEvidence · Inventory, historical scope only.\n\nAdditional qualification.';
  const slide = buildDiagnosisDeck({id: 9, markdown:md}, 'en').slides[1];
  expect(slide.items).toEqual([{label:'DB · Hypothesis',text:'Review storage protection.'}]);
  expect(slide.notes).toContain('Evidence · Inventory, historical scope only.');
  expect(slide.notes).toContain('Additional qualification.');
});

it('shows qualifying prose and a trailing safety notice even when a heading also owns a table', () => {
  const md = '## Assessment\n\n### Immediate checks\n\n| Subject | How to verify |\n|---|---|\n| DB | Verify backup. |\n\n' +
    '**Coverage and unknowns** · Conclusions apply only to the selected period.\n\n' +
    '_[Do not run the command; review it through your change process (degraded)]_';
  const deck = buildDiagnosisDeck({id: 8, markdown: md}, 'en');
  const visible = deck.slides.flatMap(s => [s.caption, ...s.items.flatMap(r => [r.label,r.text])]).join(' ');
  expect(visible).toContain('Conclusions apply only to the selected period.');
  expect(visible).toContain('Do not run the command');
  expect(visible).toContain('Verify backup.');
});

it('keeps the worker-owned audit appendix outside customer HTML and PowerPoint input', async () => {
  const markdown = '# Assessment\n\n- [Risks](#assessment)\n- [Evidence appendix](#evidence_appendix)\n\n' +
    '## Risks\n\nReview the storage protection policy.\n\n## Evidence appendix\n\nCollector diagnostic marker.\n';
  const deck = buildDiagnosisDeck({id: 42, markdown}, 'en');
  expect(deck.sections.map(s => s.title)).toEqual(['Risks']);
  expect(JSON.stringify(deck)).not.toContain('Collector diagnostic marker.');
  expect(await renderDeckHtml(deck)).not.toContain('Collector diagnostic marker.');
});
