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
