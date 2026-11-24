import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Nodes } from 'mdast';
import { resourceRole } from './diagnosis-visuals';
import { deckCopy, displayedText, type BriefingSlide, type DiagnosisDeck } from './diagnosis-deck';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Untrusted source renders as inert text/formatting. In particular, no raw HTML,
// remote images, link destinations, attributes or user-supplied navigation code.
function readable(node: Nodes): string {
  const children = 'children' in node ? node.children.map(readable).join('') : '';
  switch (node.type) {
    case 'root':
      return children;
    case 'text':
    case 'html':
      return escape(node.value);
    case 'inlineCode':
      return '<code>' + escape(node.value) + '</code>';
    case 'code':
      return '<pre>' + escape(node.value) + '</pre>';
    case 'image':
      return escape(node.alt ?? '');
    case 'break':
      return '<br>';
    case 'thematicBreak':
      return '<hr>';
    case 'heading':
      return '<h3>' + children + '</h3>';
    case 'paragraph':
      return '<p>' + children + '</p>';
    case 'strong':
      return '<strong>' + children + '</strong>';
    case 'emphasis':
      return '<em>' + children + '</em>';
    case 'blockquote':
      return '<blockquote>' + children + '</blockquote>';
    case 'list':
      return node.ordered ? '<ol>' + children + '</ol>' : '<ul>' + children + '</ul>';
    case 'listItem':
      return '<li>' + children + '</li>';
    case 'table':
      return (
        '<div class="scroll"><table>' +
        node.children
          .map(
            (row, n) =>
              '<tr>' +
              row.children
                .map((cell) =>
                  n === 0 ? '<th scope="col">' + readable(cell) + '</th>' : '<td>' + readable(cell) + '</td>',
                )
                .join('') +
              '</tr>',
          )
          .join('') +
        '</table></div>'
      );
    default:
      return children;
  }
}

const visualCopy = {
  en: { directed: 'Directed from left to right', undirected: 'Undirected' },
  ko: { directed: '왼쪽에서 오른쪽으로 향하는 관계', undirected: '방향 없는 관계' },
  ja: { directed: '左から右への関係', undirected: '方向のない関係' },
  zh: { directed: '从左到右的有向关系', undirected: '无向关系' },
};

function renderVisual(visual: NonNullable<BriefingSlide['visual']>, title: string, lang: DiagnosisDeck['lang']) {
  if (visual.kind === 'stages') {
    return `<ol class="stages">${visual.rows.map(r => `<li><h3>${escape(r[0])}</h3><dl>${visual.headers.slice(1).map((h, i) =>
      `<dt>${escape(h)}</dt><dd>${escape(r[i + 1])}</dd>`).join('')}</dl></li>`).join('')}</ol>`;
  }
  if (visual.kind === 'comparison') {
    const max = Math.max(...visual.values);
    return `<figure class="comparison"><figcaption>${escape(visual.headers[1])}</figcaption><ul>${visual.rows.map((r, i) =>
      `<li><strong>${escape(r[0])}</strong><span>${escape(r[1])}</span><meter min="0" max="${max}" value="${visual.values[i]}" aria-hidden="true"></meter><p>${escape(visual.headers[2])} · ${escape(r[2])}</p></li>`).join('')}</ul></figure>`;
  }
  if (visual.kind === 'placement') {
    return `<section class="vpc"><h3>Amazon VPC　${escape(visual.container)}</h3><ul>${visual.rows.map(row =>
      `<li><span>${escape(resourceRole(row.left, lang) || row.label)}</span><strong>${escape(row.left)}</strong><p>${escape(row.source)}</p></li>`
    ).join('')}</ul></section>`;
  }
  if (visual.kind === 'relationships') {
    const copy = visualCopy[lang];
    const endpoint = (id: string) => [resourceRole(id, lang), id].filter(Boolean).map(escape).join('<br>');
    return `<ul class="relationships" role="list">${visual.rows.map(row => `
      <li>
        <strong class="relation-label">${escape(row.label)}</strong>
        <div class="incidence">
          <span class="endpoint">${endpoint(row.left)}</span>
          <span class="connector${row.directed ? ' directed' : ''}" role="img" aria-label="${escape(row.directed ? copy.directed : copy.undirected)}"></span>
          <span class="endpoint">${endpoint(row.right)}</span>
        </div>
        ${row.source ? `<p class="relation-source">${escape(row.source)}</p>` : ''}
      </li>`).join('')}</ul>`;
  }
  if (visual.kind === 'boundaries') {
    return `<div class="zones">${visual.rows.map(row => `
      <section class="zone">
        <span class="zone-role">${escape(visual.headers[0])}</span>
        <h3>${escape(row[0])}</h3>
        <dl>${visual.headers.slice(1).map((header, i) =>
          `<dt>${escape(header)}</dt><dd>${escape(row[i + 1] ?? '')}</dd>`).join('')}</dl>
      </section>`).join('')}</div>`;
  }
  return `<table class="matrix" aria-label="${escape(title)}">
    <thead><tr>${visual.headers.map(cell => `<th scope="col">${escape(cell)}</th>`).join('')}</tr></thead>
    <tbody>${visual.rows.map(row => `<tr>${row.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>`;
}

const css = `
:root {
  color-scheme: light;
  --bg: #f6f4ee;
  --ink: #1b2737;
  --muted: #4c5c68;
  --rule: #c8d1ce;
  --accent: #593592;
  --soft: #f0eafb;
  --panel: #fff;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  font:
    16px/1.55 Pretendard,
    'Noto Sans KR',
    system-ui,
    sans-serif;
  background: var(--bg);
  color: var(--ink);
}
button,
select {
  font: inherit;
  cursor: pointer;
  color: inherit;
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 6px;
  padding: 0.42em 0.76em;
}
button:focus-visible,
select:focus-visible,
summary:focus-visible {
  outline: 3px solid #197d78;
  outline-offset: 2px;
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
header,
footer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px max(5vw, 18px);
}
header {
  border-bottom: 1px solid var(--rule);
}
header b {
  color: var(--accent);
  font-size: 20px;
}
header span {
  color: var(--muted);
}
header select {
  margin-left: auto;
  max-width: 48vw;
}
main {
  margin: 0 auto;
  max-width: 1480px;
  padding: clamp(24px, 5vh, 60px) max(5vw, 18px) 28px;
  min-height: 76vh;
}
.slide[hidden] {
  display: none;
}
.kicker {
  color: var(--accent);
  font-weight: 700;
  letter-spacing: 0.025em;
  font-size: 15px;
  margin: 0 0 14px;
}
h1,
h2 {
  letter-spacing: -0.035em;
  line-height: 1.17;
  overflow-wrap: anywhere;
  word-break: keep-all;
  text-wrap: balance;
}
h1 {
  font-size: clamp(36px, 5.7vw, 82px);
  max-width: 20em;
  margin: 0.25em 0 0.55em;
}
h2 {
  font-size: clamp(30px, 3.6vw, 54px);
  margin: 0 0 0.6em;
}
h3 {
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.cover {
  padding: clamp(24px, 7vh, 82px) 0;
}
.cover .first {
  max-width: 59em;
  padding: 15px 20px;
  border-left: 4px solid var(--accent);
  background: var(--soft);
  line-height: 1.55;
}
.cover .first strong {
  display: block;
  color: var(--accent);
  font-size: 0.9rem;
}
.cover .meta {
  font-size: clamp(15px, 1.45vw, 22px);
  color: var(--muted);
  max-width: 62em;
}
.line {
  width: 60px;
  height: 5px;
  background: var(--accent);
  margin: 20px 0;
}
.cards {
  display: grid;
  gap: 12px;
  list-style: none;
  padding: 0;
  margin: 0;
}
.card {
  background: var(--panel);
  border: 1px solid var(--rule);
  border-left: 5px solid var(--accent);
  border-radius: 8px;
  padding: clamp(12px, 1.35vw, 21px);
  display: grid;
  grid-template-columns: minmax(140px, 25%) 1fr;
  gap: 22px;
  align-items: start;
}
.card meter {
  display: block;
  width: 100%;
  height: 0.5em;
  margin-top: 0.5em;
  accent-color: var(--accent);
}
.caption {
  font-size: clamp(19px, 1.45vw, 23px);
  margin: -0.4em 0 1em;
  color: var(--muted);
}
.card:first-child {
  background: var(--soft);
}
.card h3 {
  font-size: clamp(15px, 1.35vw, 22px);
  margin: 0;
  word-break: break-word;
}
.card p {
  line-height: 1.4;
  font-size: clamp(15px, 1.42vw, 23px);
  margin: 0;
  white-space: pre-line;
  overflow-wrap: anywhere;
  word-break: keep-all;
}
.card.solo {
  grid-template-columns: 1fr;
}
.stages { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr)); padding: 0; list-style: none; gap: .8rem; }
.stages li { background: white; border: 1px solid var(--rule); }
.stages h3 { padding: .65em; background: var(--accent); color: white; margin: 0; }
.stages dl { padding: .8em; margin: 0; }
.stages dt, .comparison figcaption { font-weight: 700; color: var(--accent); }
.stages dd { margin: .2em 0 .8em; }
.comparison { margin: 0; }
.comparison ul { list-style: none; padding: 0; }
.comparison li { display: grid; grid-template-columns: 2fr 1fr; gap: .2rem .8rem; padding: .55em 0; }
.comparison meter, .comparison p { margin: 0; width: 100%; grid-column: 1 / -1; }
.vpc { border: 2px solid #38765e; background: #f1f7f4; padding: 1.15rem; }
.vpc h3 { margin: 0 0 1rem; color: #225744; }
.vpc ul { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr)); gap: 1rem; padding: 0; margin: 0; list-style: none; }
.vpc li { padding: 1rem; border: 1px solid #a1baaf; background: white; }
.vpc strong { display: block; margin-top: .65rem; }
.vpc p { color: var(--muted); }
.visual-slide {
  overflow-wrap: anywhere;
}
.relationships, .zones {
  display: grid;
  gap: 0.8rem;
}
.relationships {
  list-style: none;
  padding: 0;
  margin: 0;
}
.relationships li, .zone {
  border: 1px solid var(--rule);
  border-radius: 8px;
  background: var(--panel);
  padding: clamp(12px, 1.3vw, 20px);
}
.incidence {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 12% minmax(0, 1fr);
  align-items: center;
  margin: 0.35em 0;
}
.endpoint {
  font: 600 clamp(14px, 1.25vw, 20px)/1.4 ui-monospace, monospace;
  padding: 0.5em 0.65em;
  border: 1px solid var(--accent);
  border-radius: 5px;
  background: var(--soft);
}
.connector {
  position: relative;
  border-top: 2px solid var(--accent);
}
.connector.directed::after {
  content: '';
  position: absolute;
  right: 2px;
  top: -5px;
  width: 8px;
  height: 8px;
  border: solid var(--accent);
  border-width: 2px 2px 0 0;
  transform: rotate(45deg);
}
.relation-label, .zone h3 {
  font-size: clamp(17px, 1.55vw, 24px);
}
.relation-source, .zone-role, .zone dt {
  color: var(--muted);
}
.relation-source {
  margin: 0;
}
.zones {
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  align-items: start;
}
.zone {
  border-top: 4px solid var(--accent);
}
.zone h3, .zone dl, .zone dd {
  margin: 0;
}
.zone dt {
  margin-top: 0.8em;
  border-top: 1px solid var(--rule);
  padding-top: 0.6em;
}
.zone-role, .zone dt {
  font-size: 0.95rem;
  font-weight: 600;
}
.zone dd, .matrix {
  font-size: clamp(16px, 1.35vw, 22px);
  line-height: 1.4;
}
.visual-slide :is(.endpoint, .relation-label, .relation-source, .zone-role, .zone h3, .zone dt, .zone dd, .matrix th, .matrix td, .caption) {
  white-space: pre-line;
}
.matrix {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  background: var(--panel);
}
.matrix :is(th, td) {
  border: 1px solid var(--rule);
  padding: clamp(5px, 1vw, 15px);
  vertical-align: top;
  text-align: start;
}
.matrix th {
  background: var(--soft);
  border-bottom: 2px solid var(--accent);
}
@media screen and (max-width: 700px) {
  .zones {
    grid-auto-flow: row;
  }
}
.count {
  color: var(--muted);
  font-size: 0.85rem;
  margin-top: 10px;
}
footer {
  position: sticky;
  bottom: 0;
  background: var(--bg);
  border-top: 1px solid var(--rule);
  flex-wrap: wrap;
}
footer output {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  margin-right: auto;
}
progress {
  width: 100%;
  height: 4px;
  accent-color: var(--accent);
}
dialog {
  width: min(80rem, 92vw);
  max-height: 86vh;
  overflow: auto;
  border: 1px solid var(--rule);
  padding: 0;
  border-radius: 10px;
  color: var(--ink);
  background: #fff;
}
dialog::backdrop {
  background: #101f2bbd;
}
.dialogbar {
  position: sticky;
  top: 0;
  background: #fff;
  padding: 12px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px solid var(--rule);
}
.paper {
  padding: 10px clamp(16px, 3vw, 45px) 40px;
  overflow-wrap: anywhere;
}
.paper td,
.paper th {
  text-align: left;
  border: 1px solid var(--rule);
  padding: 6px 10px;
  vertical-align: top;
}
.paper th {
  background: var(--soft);
}
.scroll {
  overflow: auto;
}
.paper table {
  border-collapse: collapse;
}
.paper code,
.paper pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.paper details {
  margin: 0.8rem 0;
}
.paper summary {
  cursor: pointer;
  font-weight: 700;
}
@media (max-width: 700px) {
  header,
  footer {
    gap: 7px;
  }
  header span {
    display: none;
  }
  .card {
    grid-template-columns: 1fr;
    gap: 5px;
  }
  main {
    min-height: 70vh;
  }
  .cover {
    padding-top: 24px;
  }
}
@media print {
  header,
  footer,
  dialog,
  .count {
    display: none !important;
  }
  .slide,
  .slide[hidden] {
    display: block;
    break-after: page;
  }
  .slide:last-child {
    break-after: auto;
  }
  main {
    padding: 0;
  }
  .card, .relationships li, .zone, .matrix tr {
    break-inside: avoid;
  }
}
`;

const script = `
(() => {
  const slides = [...document.querySelectorAll('.slide')],
    sel = document.querySelector('select'),
    prev = document.getElementById('prev'),
    next = document.getElementById('next'),
    detail = document.getElementById('detail'),
    dialog = document.querySelector('dialog'),
    count = document.querySelector('output'),
    progress = document.querySelector('progress');
  let index = 0;
  function show(n) {
    index = Math.max(0, Math.min(n, slides.length - 1));
    slides.forEach((s, i) => (s.hidden = i !== index));
    sel.selectedIndex = index;
    prev.disabled = index === 0;
    next.disabled = index === slides.length - 1;
    count.textContent = index + 1 + ' / ' + slides.length;
    progress.value = index + 1;
    window.scrollTo(0, 0);
  }
  prev.onclick = () => show(index - 1);
  next.onclick = () => show(index + 1);
  sel.onchange = () => show(sel.selectedIndex);
  detail.onclick = () => {
    const key = slides[index].dataset.section;
    document.querySelectorAll('.paper details').forEach((s) => (s.open = s.dataset.id === key));
    dialog.showModal();
    const openedSection = document.querySelector('.paper details[open]');
    if (openedSection) openedSection.scrollIntoView({ block: 'start' });
    else dialog.scrollTop = 0;
  };
  document.getElementById('dismiss').onclick = () => dialog.close();
  document.addEventListener('keydown', (e) => {
    if (
      dialog.open ||
      e.altKey ||
      e.ctrlKey ||
      e.metaKey ||
      ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)
    )
      return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      e.preventDefault();
      show(index + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      show(index - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      show(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      show(slides.length - 1);
    }
  });
  show(0);
})();
`;

export async function renderDeckHtml(deck: DiagnosisDeck): Promise<string> {
  const c = deckCopy[deck.lang];
  const parser = unified().use(remarkParse).use(remarkGfm);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script));
  const scriptHash = btoa(String.fromCharCode(...new Uint8Array(hash)));
  const pages = deck.slides
    .map((s, i) => {
      const cover = i === 0;
      return `<section class="slide${cover ? ' cover' : s.visual ? ' visual-slide' : ''}" data-section="${escape(String(s.section))}"${cover ? '' : ' hidden'}><p class="kicker">${escape(cover || s.title === s.chapter ? c.brief : s.chapter)}</p>
      ${
        cover
          ? '<div class="line"></div><h1>' +
            escape(deck.coverTitle) +
            '</h1>' +
            (deck.coverScope ? '<h3>' + escape(deck.coverScope) + '</h3>' : '') +
            '<p class="meta">' +
            escape(deck.metadata) +
            '</p>' +
            (deck.firstAction
              ? '<p class="first"><strong>' +
                escape(c.first) +
                '</strong>' +
                escape(displayedText(deck.firstAction, 240)) +
                '</p>'
              : '')
          : '<h2>' +
            escape(s.title) +
            '</h2>' +
            (s.caption ? '<p class="caption">' + escape(s.visual ? s.caption : displayedText(s.caption, 180)) + '</p>' : '') +
            (s.visual
              ? renderVisual(s.visual, s.title, deck.lang)
              : '<ul class="cards">' +
                s.items
                  .map(
                    (r) =>
                      '<li class="card' +
                      (r.label ? '' : ' solo') +
                      '">' +
                      (r.label
                        ? '<h3>' +
                          escape(displayedText(r.label, 86)) +
                          (r.count === undefined
                            ? ''
                            : '　' +
                              escape(String(r.count)) +
                              '<meter min="0" max="' +
                              Math.max(1, ...s.items.map((item) => item.count ?? 0)) +
                              '" value="' +
                              escape(String(r.count)) +
                              '"></meter>') +
                          '</h3>'
                        : '') +
                      '<p>' +
                      escape(displayedText(r.text, 600)) +
                      '</p></li>',
                  )
                  .join('') +
                '</ul>') +
            (s.total > s.items.length
              ? '<p class="count">' +
                escape(c.excerpt) +
                ' ' +
                escape(String(s.from + 1)) +
                '–' +
                escape(String(s.from + s.items.length)) +
                ' / ' +
                escape(String(s.total)) +
                '</p>'
              : '')
      }
    </section>`;
    })
    .join('');
  const options = deck.slides.map((s, i) => `<option>${i + 1}. ${escape(s.title)}</option>`).join('');
  const source = deck.sections
    .map(
      (s, i) =>
        `<details data-id="${i}"><summary>${escape(s.title)}</summary>${readable(parser.parse(s.text))}</details>`,
    )
    .join('');
  return `<!doctype html><html lang="${escape(deck.lang)}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(deck.title)}</title><style>${css}</style></head><body>
    <header><b>AWSops</b><span>${escape(c.brief)} / #${escape(String(deck.id))}</span><select aria-label="${escape(c.contents)}">${options}</select></header>
    <main>${pages}</main><footer><progress max="${deck.slides.length}" value="1" aria-label="${escape(c.brief)}"></progress><output aria-live="polite"></output>
    <button id="detail">${escape(c.detail)}</button><button id="prev">← ${escape(c.prev)}</button><button id="next">${escape(c.next)} →</button></footer>
    <dialog aria-label="${escape(c.detail)}"><div class="dialogbar"><strong>${escape(c.detail)} / #${escape(String(deck.id))}</strong><button autofocus id="dismiss">${escape(c.close)}</button></div><div class="paper">${readable(parser.parse(deck.preamble))}${source}</div></dialog>
    <script>${script}</script></body></html>`;
}
