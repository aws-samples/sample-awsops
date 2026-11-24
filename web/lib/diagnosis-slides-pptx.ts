import PptxGenJS from 'pptxgenjs';
import { deckCopy, displayedText, type DiagnosisDeck } from './diagnosis-deck';

const fontFace = 'Pretendard';
const ink = '1B2737',
  accent = '593592',
  muted = '465C65',
  paper = 'F6F4EE';

// Keep native PowerPoint text editable at a size that fits the chosen box.
function fittedSize(value: string, width: number, height: number, max: number) {
  for (let pt = max; pt >= 10; pt--) {
    const lineWidth = Math.max(1, (width * 72 - 6) / pt);
    const lines = value.split('\n').reduce((sum, line) => {
      const em = Array.from(line).reduce((n, ch) => n + (ch.codePointAt(0)! > 255 ? 1.06 : 0.58), 0);
      return sum + Math.max(1, Math.ceil(em / lineWidth));
    }, 0);
    if (lines * pt * 1.32 <= height * 72 - 4) return pt;
  }
  return 10;
}

export async function renderDeckPptx(deck: DiagnosisDeck): Promise<Blob> {
  const ppt = new PptxGenJS();
  ppt.layout = 'LAYOUT_WIDE';
  ppt.author = 'AWSops';
  ppt.title = deck.title;
  ppt.subject = deckCopy[deck.lang].brief;
  ppt.theme = { headFontFace: fontFace, bodyFontFace: fontFace };
  const c = deckCopy[deck.lang];
  deck.slides.forEach((s, index) => {
    const slide = ppt.addSlide();
    slide.background = { color: paper };
    const text = (
      value: string,
      x: number,
      y: number,
      w: number,
      h: number,
      size: number,
      options: PptxGenJS.TextPropsOptions = {},
    ) =>
      slide.addText(value, {
        x,
        y,
        w,
        h,
        fontFace,
        fontSize: fittedSize(value, w, h, size),
        color: ink,
        margin: 0,
        valign: 'middle',
        fit: 'shrink',
        lang: deck.lang,
        ...options,
      });
    text('AWSops', 0.65, 0.26, 2, 0.42, 21, { bold: true, color: accent });
    text(`${c.brief}  /  #${deck.id}`, 8.25, 0.29, 4.42, 0.34, 12, { align: 'right', color: muted });
    slide.addShape(ppt.ShapeType.line, {
      x: 0.65,
      y: 0.82,
      w: 12.02,
      h: 0,
      line: { color: 'C8D1CE', width: 1 },
    });
    if (index === 0) {
      text(c.brief, 0.85, 1.55, 11.5, 0.5, 20, { bold: true, color: accent });
      text(deck.coverTitle, 0.85, 2.15, 11.5, 2.05, 42, { bold: true, valign: 'middle' });
      if (deck.coverScope) text(deck.coverScope, 0.85, 4.21, 11.5, 0.44, 17, { color: muted });
      slide.addShape(ppt.ShapeType.rect, {
        x: 0.85,
        y: 4.72,
        w: 0.75,
        h: 0.06,
        rectRadius: 0,
        line: { transparency: 100 },
        fill: { color: accent },
      });
      text(deck.metadata, 0.85, 4.96, 11.5, 0.45, 15, { color: muted });
      if (deck.firstAction) {
        text(c.first, 0.85, 5.68, 2.0, 0.55, 14, { color: accent, bold: true });
        text(displayedText(deck.firstAction, 240), 3.0, 5.58, 9.2, 1.1, 18);
      }
    } else {
      text(s.chapter === s.title ? c.brief : s.chapter, 0.7, 1.03, 12, 0.33, 14, {
        bold: true,
        color: accent,
      });
      text(s.title, 0.7, 1.5, 12, 0.88, 33, { bold: true });
      const top = s.caption ? 2.93 : 2.56;
      if (s.caption) text(displayedText(s.caption, 180), 0.73, 2.36, 11.86, 0.46, 13, { color: muted });
      const slot = Math.min(2.0, (6.83 - top) / Math.max(1, s.items.length));
      s.items.forEach((item, j) => {
        const y = top + j * slot;
        slide.addShape(ppt.ShapeType.rect, {
          x: 0.7,
          y,
          w: 11.94,
          h: slot - 0.1,
          line: { color: 'CFD8D5', width: 0.6 },
          fill: { color: j === 0 ? 'F0EAFB' : 'FFFFFF' },
        });
        slide.addShape(ppt.ShapeType.rect, {
          x: 0.7,
          y,
          w: 0.065,
          h: slot - 0.1,
          line: { transparency: 100 },
          fill: { color: accent },
        });
        if (item.label)
          text(
            displayedText(item.label, 86) + (item.count === undefined ? '' : '　' + item.count),
            0.93,
            y + 0.12,
            2.95,
            slot - 0.34,
            17,
            { bold: true, valign: 'middle' },
          );
        if (item.count !== undefined && item.count > 0) {
          const largest = Math.max(1, ...s.items.map((r) => r.count ?? 0));
          slide.addShape(ppt.ShapeType.rect, {
            x: 0.93,
            y: y + slot - 0.22,
            w: (2.7 * item.count) / largest,
            h: 0.045,
            line: { transparency: 100 },
            fill: { color: accent },
          });
        }
        text(
          displayedText(item.text, 600),
          item.label ? 4.14 : 0.95,
          y + 0.1,
          item.label ? 8.22 : 11.38,
          slot - 0.31,
          18,
          { valign: 'middle' },
        );
      });
    }
    const clipped = s.items.some((r) => r.label.length > 86 || r.text.length > 600);
    const count =
      s.total > s.items.length ? `${c.excerpt} ${s.from + 1}–${s.from + s.items.length} / ${s.total}` : '';
    if (count || clipped)
      text([count, c.notes].filter(Boolean).join('   '), 0.72, 6.91, 10.3, 0.32, 10, { color: muted });
    text(`${index + 1} / ${deck.slides.length}`, 11.4, 6.91, 1.24, 0.32, 11, {
      color: muted,
      align: 'right',
    });
    slide.addNotes(s.notes || deck.metadata);
  });
  const bytes = (await ppt.write({ outputType: 'arraybuffer', compression: true })) as ArrayBuffer;
  return new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
}
