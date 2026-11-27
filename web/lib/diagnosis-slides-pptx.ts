import PptxGenJS from 'pptxgenjs';
import { deckCopy, displayedText, type DiagnosisDeck } from './diagnosis-deck';
import { resourceRole, type BriefingVisual } from './diagnosis-visuals';

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

const left = 0.7,
  width = 11.94,
  bottom = 6.77;
const white = 'FFFFFF',
  lavender = 'F3EFF9',
  rule = 'CEC8DA';
type TextBox = (
  value: string,
  x: number,
  y: number,
  w: number,
  h: number,
  size: number,
  options?: PptxGenJS.TextPropsOptions,
) => void;

function relationships(
  slide: PptxGenJS.Slide,
  text: TextBox,
  rows: Extract<BriefingVisual, { kind: 'relationships' }>['rows'],
  top: number,
  lang: DiagnosisDeck['lang'],
) {
  const pitch = Math.min(2.35, (bottom - top) / rows.length);
  const nodeW = 3.82;
  const gap = width - 2 * nodeW;
  rows.forEach((row, i) => {
    const y = top + pitch * i;
    const singleLineSource = fittedSize(row.source, width - 0.2, 0.36, 15) >= 14;
    const sourceH = Math.min(pitch * 0.44, singleLineSource ? 0.36 : 0.83);
    const nodeH = pitch - sourceH - 0.1;
    for (const side of ['left', 'right'] as const) {
      const x = side === 'left' ? left : left + width - nodeW;
      const name = [resourceRole(row[side], lang), row[side]].filter(Boolean).join('\n');
      text(name, x, y, nodeW, nodeH, 19, {
        shape: 'rect',
        objectName: `Endpoint ${i} ${side}`,
        bold: true,
        align: 'center',
        margin: 4,
        fill: { color: lavender },
        line: { color: rule, width: 1 },
        fontSize: fittedSize(name, nodeW - 0.16, nodeH - 0.13, 19),
      });
    }
    slide.addShape('line', {
      x: left + nodeW,
      y: y + nodeH / 2,
      w: gap,
      h: 0,
      objectName: `Relationship ${i}`,
      line: { color: accent, width: 1.8, endArrowType: row.directed ? 'triangle' : undefined },
    });
    // Long qualifiers use the height of the nodes. Leave the arrowhead and both line ends clear.
    const labelAbove = fittedSize(row.label, gap - 0.2, nodeH / 2 - 0.04, 16) >= 13;
    const inset = labelAbove ? 0.1 : 0.28;
    text(row.label, left + nodeW + inset, y, gap - 2 * inset, labelAbove ? nodeH / 2 - 0.04 : nodeH, 16, {
      color: accent,
      bold: true,
      align: 'center',
      valign: labelAbove ? 'bottom' : 'middle',
      fill: labelAbove ? undefined : { color: white },
    });
    text(row.source, left + 0.1, y + nodeH + 0.04, width - 0.2, sourceH, 15, {
      color: muted,
      align: 'center',
    });
  });
}

function placement(
  slide: PptxGenJS.Slide,
  text: TextBox,
  visual: Extract<BriefingVisual, { kind: 'placement' }>,
  top: number,
  lang: DiagnosisDeck['lang'],
) {
  const frameH = bottom - top;
  slide.addShape('rect', {
    x: left,
    y: top,
    w: width,
    h: frameH,
    objectName: 'VPC',
    fill: { color: 'F1F7F4' },
    line: { color: '38765E', width: 1.5 },
  });
  text('Amazon VPC   ' + visual.container, left + 0.24, top + 0.16, width - 0.5, 0.55, 24, {
    bold: true,
    color: '225744',
  });
  const gap = 0.18,
    inset = 0.25;
  const w = (width - 2 * inset - (visual.rows.length - 1) * gap) / visual.rows.length;
  visual.rows.forEach((r, i) => {
    const x = left + inset + i * (w + gap),
      y = top + 0.94,
      h = frameH - 1.2;
    slide.addShape('rect', {
      x,
      y,
      w,
      h,
      objectName: 'VPC member ' + i,
      fill: { color: white },
      line: { color: 'A1BAAF', width: 1 },
    });
    const role = resourceRole(r.left, lang);
    if (role) text(role, x + 0.18, y + 0.15, w - 0.36, 0.4, 15, {
      bold: true,
      color: '225744',
    });
    text(r.left, x + 0.18, y + (role ? 0.63 : 0.18), w - 0.36, h * 0.36, 20, { bold: true });
    text(r.source, x + 0.18, y + 0.74 + h * 0.36, w - 0.36, h * 0.64 - 0.86, 15, {
      color: muted,
      valign: 'top',
    });
  });
}

function boundaries(slide: PptxGenJS.Slide, text: TextBox, headers: string[], rows: string[][], top: number) {
  const widths = [2.6, 4.46, width - 7.06];
  const demands = rows.map((row) =>
    Math.max(...row.map((cell, col) => Math.max(1, Math.ceil(cell.length / (widths[col] * 5))))),
  );
  const demand = demands.reduce((a, b) => a + b, 0);
  const base = 0.86;
  const space = Math.min(bottom - top - rows.length * base, 0.34 * demand);
  let y = top;
  rows.forEach((row, i) => {
    const h = base + (space * demands[i]) / demand - 0.12;
    const name = `Boundary ${i}`;
    slide.addShape('rect', {
      x: left,
      y,
      w: width,
      h,
      objectName: name + ' frame',
      fill: { color: white },
      line: { color: rule, width: 1 },
    });
    slide.addShape('rect', {
      x: left,
      y,
      w: widths[0],
      h,
      objectName: name + ' band',
      fill: { color: lavender },
      line: { color: rule, width: 1 },
    });
    let x = left;
    row.forEach((value, col) => {
      const w = widths[col] - 0.32;
      const labelH = Math.min(0.39, h * 0.28);
      text(headers[col], x + 0.16, y + 0.08, w, labelH, 13, {
        objectName: name + ' role ' + col,
        color: accent,
        bold: true,
      });
      text(value, x + 0.16, y + labelH + 0.12, w, h - labelH - 0.22, col === 0 ? 20 : 18, {
        objectName: name + ' value ' + col,
        bold: col === 0,
        valign: 'top',
      });
      x += widths[col];
    });
    y += h + 0.12;
  });
}

function stages(slide: PptxGenJS.Slide, text: TextBox, headers: string[], rows: string[][], top: number) {
  const gap = 0.22,
    w = (width - gap * (rows.length - 1)) / rows.length;
  const h = bottom - top;
  rows.forEach((r, i) => {
    const x = left + i * (w + gap);
    slide.addShape('rect', { x, y: top, w, h, line: { color: rule }, fill: { color: white } });
    text(r[0], x, top, w, 0.77, 20, { bold: true, margin: 8, color: white, fill: { color: accent } });
    const slot = (h - 0.93) / (r.length - 1);
    for (let c = 1; c < r.length; c++) {
      const y = top + 0.88 + (c - 1) * slot;
      text(headers[c], x + 0.17, y, w - 0.34, 0.34, 14, { bold: true, color: accent });
      text(r[c], x + 0.17, y + 0.38, w - 0.34, slot - 0.5, 18, { valign: 'top' });
    }
  });
}

function comparison(
  ppt: PptxGenJS,
  slide: PptxGenJS.Slide,
  text: TextBox,
  visual: Extract<BriefingVisual, { kind: 'comparison' }>,
  top: number,
) {
  const values = visual.unit === '%' ? visual.values.map((v) => v / 100) : visual.values;
  const format = visual.unit === '%' ? '0.##%' : '#,##0.00';
  text(visual.headers[1], left, top, 6.5, 0.41, 17, { bold: true, color: accent });
  slide.addChart(
    ppt.ChartType.bar,
    [
      {
        name: visual.headers[1],
        labels: visual.rows.map((r) => r[0]).reverse(),
        values: [...values].reverse(),
      },
    ],
    {
      x: left,
      y: top + 0.57,
      w: 6.6,
      h: bottom - top - 0.62,
      barDir: 'bar',
      barGrouping: 'clustered',
      showLegend: false,
      showTitle: false,
      showValue: true,
      dataLabelPosition: 'outEnd',
      dataLabelFormatCode: format,
      valAxisLabelFormatCode: visual.unit === '%' ? '0%' : '#,##0',
      valAxisMinVal: 0,
      valAxisMaxVal: Math.max(...values) * 1.3,
      catAxisLabelFontFace: fontFace,
      catAxisLabelFontSize: 14,
      valAxisLabelFontSize: 14,
      dataLabelColor: ink,
      dataLabelFontSize: 14,
      chartColors: [accent],
    },
  );
  text(visual.headers[2], 7.65, top, 4.9, 0.41, 17, { bold: true, color: accent });
  const slot = (bottom - top - 0.6) / visual.rows.length;
  visual.rows.forEach((r, i) => {
    const y = top + 0.56 + i * slot;
    const note = r[0] + '　' + r[2];
    slide.addText([{ text: r[0] + '　', options: { bold: true } }, { text: r[2] }], {
      x: 7.65, y: y + 0.05, w: 4.9, h: slot - 0.10, margin: 0,
      fontFace, fontSize: fittedSize(note, 4.9, slot - 0.10, 17), color: ink, fit: 'shrink', valign: 'middle',
    });
  });
}

function matrix(slide: PptxGenJS.Slide, headers: string[], rows: string[][], top: number, lang: string) {
  const grid = [headers, ...rows];
  // Share space by column demand while reserving enough width for short headers.
  const weights = headers.map((_, c) => Math.sqrt(Math.max(12, ...grid.map((r) => r[c].length))));
  const total = weights.reduce((a, b) => a + b, 0);
  const colW = weights.map((w) => 1 + ((width - headers.length) * w) / total);
  const rowWeights = grid.map((row) =>
    Math.max(
      1,
      ...row.map((v, c) =>
        v.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / (colW[c] * 6))), 0),
      ),
    ),
  );
  const sum = rowWeights.reduce((a, b) => a + b, 0);
  const height = Math.min(bottom - top, grid.length * 0.45 + sum * 0.42);
  const base = Math.min(0.42, height / (2 * grid.length));
  const rowH = rowWeights.map((w) => base + ((height - base * grid.length) * w) / sum);
  slide.addTable(
    grid.map((row, r) =>
      row.map((value, c) => ({
        text: value,
        options: {
          bold: r === 0 || c === 0,
          color: r === 0 ? white : ink,
          fill: { color: r === 0 ? accent : white },
          fontSize: fittedSize(value, colW[c] - 0.24, rowH[r] - 0.14, r === 0 ? 16 : 18),
        },
      })),
    ),
    {
      x: left,
      y: top,
      w: width,
      h: height,
      rowH,
      colW,
      objectName: 'Briefing matrix',
      autoPage: false,
      fontFace,
      lang,
      valign: 'middle',
      margin: [0.06, 0.12, 0.06, 0.12],
      border: { type: 'solid', pt: 0.65, color: rule },
    },
  );
}

// PptxGenJS 4 writes line presets as ordinary shapes.
// Modify only the named objects in its generated slide parts. Text is XML-escaped by the writer.
function nativeVisualObjects(xml: string, kind: BriefingVisual['kind']) {
  const nextId = 1 + Math.max(...Array.from(xml.matchAll(/<p:cNvPr id="(\d+)"/g), (m) => Number(m[1])));
  if (kind === 'matrix') {
    // Table IDs are allocated separately from shape IDs by PptxGenJS and can collide.
    return xml.replace(
      /<p:cNvPr id="\d+" name="Briefing matrix"/,
      `<p:cNvPr id="${nextId}" name="Briefing matrix"`,
    );
  }
  if (kind === 'relationships') {
    const endpoints = new Map(
      Array.from(
        xml.matchAll(/<p:cNvPr id="(\d+)" name="Endpoint (\d+ (?:left|right))"/g),
        (m) => [m[2], m[1]] as const,
      ),
    );
    return xml.replace(
      /<p:sp><p:nvSpPr><p:cNvPr id="(\d+)" name="Relationship (\d+)">[\s\S]*?<\/p:nvSpPr>(<p:spPr>[\s\S]*?<\/p:spPr>)[\s\S]*?<\/p:sp>/g,
      (_, id, row, geometry) => {
        const start = endpoints.get(row + ' left'),
          end = endpoints.get(row + ' right');
        if (!start || !end) throw new Error('Missing PowerPoint relationship endpoint');
        return (
          `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Relationship ${row}"/>` +
          `<p:cNvCxnSpPr><a:stCxn id="${start}" idx="3"/><a:endCxn id="${end}" idx="1"/></p:cNvCxnSpPr>` +
          `<p:nvPr/></p:nvCxnSpPr>${geometry}</p:cxnSp>`
        );
      },
    );
  }
  return xml;
}

export async function renderDeckPptx(deck: DiagnosisDeck): Promise<Blob> {
  const ppt = new PptxGenJS();
  ppt.layout = 'LAYOUT_WIDE';
  ppt.author = 'AWSops';
  ppt.title = deck.title;
  ppt.subject = deckCopy[deck.lang].brief;
  ppt.theme = { headFontFace: fontFace, bodyFontFace: fontFace };
  const c = deckCopy[deck.lang];
  const visualPages = new Map<number, BriefingVisual['kind']>();
  deck.slides.forEach((s, index) => {
    const slide = ppt.addSlide();
    const visual = index > 0 ? s.visual : undefined;
    slide.background = { color: visual ? white : paper };
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
    } else if (visual) {
      if (visual.kind === 'relationships' || visual.kind === 'matrix')
        visualPages.set(index + 1, visual.kind);
      const section = deck.sections[s.section]?.title || s.chapter;
      text(section === s.title ? c.brief : section, left, 0.96, width, 0.3, 14, {
        color: accent,
        bold: true,
      });
      text(s.title, left, 1.29, width, 0.65, 31, { bold: true });
      if (s.caption) text(s.caption, left, 1.98, width, 0.81, 16, { color: muted, valign: 'top' });
      const top = s.caption ? 2.87 : 2.1;
      if (visual.kind === 'relationships') relationships(slide, text, visual.rows, top, deck.lang);
      else if (visual.kind === 'stages') stages(slide, text, visual.headers, visual.rows, top);
      else if (visual.kind === 'comparison') comparison(ppt, slide, text, visual, top);
      else if (visual.kind === 'placement') placement(slide, text, visual, top, deck.lang);
      else if (visual.kind === 'boundaries') boundaries(slide, text, visual.headers, visual.rows, top);
      else matrix(slide, visual.headers, visual.rows, top, deck.lang);
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
    const clipped = !s.visual && s.items.some((r) => r.label.length > 86 || r.text.length > 600);
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
  let bytes = (await ppt.write({ outputType: 'arraybuffer', compression: !visualPages.size })) as ArrayBuffer;
  if (visualPages.size) {
    const { default: JSZip } = await import('jszip');
    const archive = await JSZip.loadAsync(bytes);
    for (const [page, kind] of visualPages) {
      const path = `ppt/slides/slide${page}.xml`;
      archive.file(path, nativeVisualObjects(await archive.file(path)!.async('string'), kind));
    }
    bytes = await archive.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
  }
  return new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
}
