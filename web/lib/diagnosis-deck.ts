// Build both presentations from the saved report. No inventory read or model call occurs here.
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { toString } from 'mdast-util-to-string';
import type { RootContent, Table, Paragraph } from 'mdast';
import type { Lang } from './i18n';
import { normalizeHeadings } from './report-headings';

export interface ReportForDeck {
  id: number;
  title?: string | null;
  status?: string | null;
  tier?: string | null;
  markdown: string;
}
export interface DeckItem {
  label: string;
  text: string;
  count?: number;
}
export interface BriefingSlide {
  chapter: string;
  title: string;
  items: DeckItem[];
  total: number;
  from: number;
  caption: string;
  notes: string;
  section: number;
}
export interface DiagnosisDeck {
  id: number;
  title: string;
  lang: Lang;
  metadata: string;
  coverTitle: string;
  coverScope: string;
  preamble: string;
  firstAction?: string;
  slides: BriefingSlide[];
  sections: { title: string; text: string }[];
}

export const deckCopy = {
  ko: {
    brief: '진단 브리핑',
    first: '먼저 확인할 일',
    report: '진단',
    detail: '원문',
    close: '닫기',
    next: '다음',
    prev: '이전',
    contents: '목차',
    evidence: '근거와 범위',
    partial: '부분 평가',
    full: '완료',
    excerpt: '발췌',
    notes: '전체 문장은 발표자 노트에 있습니다.',
  },
  en: {
    brief: 'Diagnosis briefing',
    first: 'First check',
    report: 'Report',
    detail: 'Source',
    close: 'Close',
    next: 'Next',
    prev: 'Previous',
    contents: 'Contents',
    evidence: 'Evidence and scope',
    partial: 'Partial assessment',
    full: 'Completed',
    excerpt: 'Excerpt',
    notes: 'See speaker notes for the full text.',
  },
  ja: {
    brief: '診断ブリーフィング',
    first: '最初の確認',
    report: '診断',
    detail: '原文',
    close: '閉じる',
    next: '次へ',
    prev: '前へ',
    contents: '目次',
    evidence: '根拠と範囲',
    partial: '部分評価',
    full: '完了',
    excerpt: '抜粋',
    notes: '全文は発表者ノートにあります。',
  },
  zh: {
    brief: '诊断简报',
    first: '优先核查',
    report: '报告',
    detail: '原文',
    close: '关闭',
    next: '下一页',
    prev: '上一页',
    contents: '目录',
    evidence: '证据及范围',
    partial: '部分评估',
    full: '已完成',
    excerpt: '摘录',
    notes: '完整内容见演讲者备注。',
  },
};

const plain = (node: RootContent | Table['children'][number]['children'][number]) =>
  toString(node, { includeHtml: false }).replace(/\s+/g, ' ').trim();
const stripSignal = (s: string) => s.replace(/^\[(?:Critical|Warning|Info)\]\s*/i, '').trim();
const appendix = /^(?:근거 부록|Evidence appendix|根拠資料|证据附录)$/i;
const sourceLine = /^(?:근거|Evidence|根拠|证据)\s*·/i;
// Exact code-owned labels from diagnosis/editor.py; these are operator guidance.
const decisionHeadings = new Set(['개선 여부를 결정하는 기준', 'Decision criteria', '改善を判断する基準', '改进决策依据']);
const coverageLine = /(?:채택 소견|Admitted findings|採用所見|采纳发现)\s*\d+/i;

function tableRows(table: Table) {
  return table.children.map((row) => row.children.map((cell) => plain(cell)));
}

function itemFromParagraph(node: Paragraph): DeckItem | null {
  const text = stripSignal(plain(node));
  if (!text || sourceLine.test(text)) return null;
  return { label: '', text };
}

function toItems(nodes: RootContent[]): DeckItem[] {
  const items: DeckItem[] = [];
  let label = '';
  for (const node of nodes) {
    if (node.type === 'paragraph') {
      const row = itemFromParagraph(node);
      if (!row) continue;
      // A finding starts with its strong subject, followed by the claim classification.
      if (
        node.children[0]?.type === 'strong' &&
        (node.children.length === 1 ||
          (node.children[1]?.type === 'text' && /^\s*·/.test(node.children[1].value)))
      ) {
        if (label) items.push({ label: '', text: label });
        label = row.text;
      } else {
        items.push({ label, text: row.text });
        label = '';
      }
    } else if (node.type === 'list') {
      for (const li of node.children) {
        const text = stripSignal(plain(li));
        if (text) items.push({ label, text });
        label = '';
      }
    } else if (node.type === 'blockquote' || node.type === 'code') {
      const text = stripSignal(plain(node));
      if (text) items.push({ label, text });
      label = '';
    }
  }
  if (label) items.push({ label: '', text: label });
  return items;
}

function tableItems(table: Table): DeckItem[] {
  const [header, ...rows] = tableRows(table);
  const numbered = rows.length > 0 && rows.every((row) => /^\d+$/.test(row[0]));
  return rows
    .map((row) => {
      const start = numbered ? 2 : 1;
      if (/^(?:유형|Type|種類|类型)$/i.test(header[0]) && /^\d+$/.test(row[1]) && row.length === 3)
        return { label: row[0], text: row[2], count: Number(row[1]) };
      if (
        numbered &&
        row.length === 4 &&
        /^(대상 · 판단|Subject · assessment|対象・判断|对象 · 判断)$/i.test(header[2])
      )
        return { label: row.slice(0, 2).join('  /  '), text: row[2] };
      if (/^(?:관계 유형|Relationship|関係|关系)$/i.test(header[0])) return { label: row[0], text: row[1] };
      return {
        label: row.slice(0, start).join('  /  '),
        text: row
          .slice(start)
          .map((cell, i) => cell && (row.length - start === 1 ? cell : `${header[start + i]}  ${cell}`))
          .filter(Boolean)
          .join('\n'),
      };
    })
    .filter((row) => row.label || row.text);
}

// Always retain the full source for the current section. Limit the briefing pages,
// not the underlying report. Truncations are visible and never become invented facts.
export function displayedText(text: string, limit: number): string {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  const candidate = chars.slice(0, limit - 1).join('');
  const boundary = candidate.search(/\s+\S*$/);
  return (boundary > candidate.length * 0.7 ? candidate.slice(0, boundary) : candidate) + '…';
}

export function buildDiagnosisDeck(report: ReportForDeck, lang: Lang): DiagnosisDeck {
  const source = normalizeHeadings(report.markdown.replace(/\r\n?/g, '\n'));
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source);
  const copy = deckCopy[lang];
  const blocks: { title: string; nodes: RootContent[]; start: number }[] = [];
  const preamble: RootContent[] = [];
  for (const node of tree.children) {
    if (node.type === 'heading' && node.depth === 2) {
      blocks.push({ title: plain(node), nodes: [], start: node.position?.start.offset ?? 0 });
    } else if (blocks.length) {
      blocks[blocks.length - 1].nodes.push(node);
    } else preamble.push(node);
  }
  const heading = preamble.find((n) => n.type === 'heading' && n.depth === 1);
  const title = report.title?.trim() || (heading && plain(heading)) || `${copy.report} #${report.id}`;
  if (!blocks.length)
    blocks.push({ title: copy.brief, nodes: preamble.filter((n) => n !== heading), start: 0 });
  // The worker keeps the technical ledger for the authenticated investigator.
  // An offline customer export must not embed it, even in the source dialog or notes.
  const finalBlock = blocks[blocks.length - 1];
  const appendixLink = `- [${finalBlock.title}](#evidence_appendix)`;
  const preambleText = source.slice(0, blocks[0].start).trim();
  const hasLedger = appendix.test(finalBlock.title) && preambleText.split('\n').includes(appendixLink);
  const sourceEnd = hasLedger ? finalBlock.start : source.length;
  if (hasLedger) blocks.pop();
  const sections = blocks.map((b, i) => ({
    title: b.title,
    text: source.slice(b.start, blocks[i + 1]?.start ?? sourceEnd).trim(),
  }));
  const generated = preamble.find((n) => n.type === 'blockquote');
  const generatedText = generated ? plain(generated) : '';
  const timestamp = generatedText.match(
    /\d{4}(?:-\d{2}-\d{2}|년\s*\d{1,2}월\s*\d{1,2}일)\s+\d{1,2}:\d{2}(?::\d{2})?\s*\(?KST\)?/,
  )?.[0];
  const metadata = [
    `#${report.id}`,
    report.tier,
    report.status === 'partial' ? copy.partial : report.status === 'succeeded' ? copy.full : report.status,
    timestamp || generatedText,
  ]
    .filter(Boolean)
    .join('   /   ');
  const slides: BriefingSlide[] = [
    {
      chapter: 'AWSops',
      title,
      items: [],
      total: 0,
      from: 0,
      caption: metadata,
      notes: metadata,
      section: -1,
    },
  ];

  let firstAction: string | undefined;
  blocks.forEach((block, section) => {
    if (appendix.test(block.title)) return;
    const groups: { heading: string; nodes: RootContent[] }[] = [{ heading: '', nodes: [] }];
    for (const node of block.nodes) {
      if (node.type === 'heading') groups.push({ heading: plain(node), nodes: [] });
      else groups[groups.length - 1].nodes.push(node);
    }
    const add = (heading: string, items: DeckItem[], caption = '', notes = '') => {
      if (!items.length) return;
      const shown = items.slice(0, 3);
      const fullNotes = notes || items.map((r) => [r.label, r.text].filter(Boolean).join('\n')).join('\n\n');
      let from = 0;
      while (from < shown.length) {
        const page: DeckItem[] = [];
        let cost = 0;
        for (const item of shown.slice(from)) {
          // Budget the projection for a readable row height in a 16:9 presentation.
          const weight = Math.max(100, Math.min(600, item.text.length), Math.min(180, item.label.length * 2));
          if (page.length && cost + weight > 390) break;
          page.push(item);
          cost += weight;
        }
        slides.push({
          chapter: block.title,
          title: heading || block.title,
          items: page,
          total: items.length,
          from,
          caption,
          notes: fullNotes,
          section,
        });
        from += page.length;
      }
    };
    for (const group of groups) {
      const tables = group.nodes.filter((n): n is Table => n.type === 'table');
      // Notes retain original order and evidence windows, even when a line is
      // deliberately left off the visible cards or moved to a decision slide.
      const proseNotes = group.nodes.filter(n => n.type !== 'table').map(n => plain(n)).filter(Boolean).join('\n\n');
      const allItems = toItems(group.nodes);
      const decisions = allItems.filter(r => decisionHeadings.has(r.label));
      const paragraphs = allItems.filter(r => !decisionHeadings.has(r.label));
      const presented = new Set<DeckItem>();
      const isDomain = paragraphs.some((r) => coverageLine.test(r.text));
      if (isDomain) {
        const findings = paragraphs.filter((r) => r.label && !coverageLine.test(r.text));
        const status = paragraphs.find((r) => coverageLine.test(r.text));
        if (findings.length) {
          add(block.title, findings, status?.text, proseNotes);
          for (const item of findings) presented.add(item);
          if (status) presented.add(status);
        } else {
          add(block.title, paragraphs, '', proseNotes);
          for (const item of paragraphs) presented.add(item);
        }
      } else if (
        !tables.length &&
        !(
          group.heading === '' &&
          /^(현재 아키텍처|Current architecture|現在のアーキテクチャ|当前架构)$/i.test(block.title) &&
          groups.length > 1 &&
          paragraphs.length === 1 &&
          !paragraphs[0].label
        )
      ) {
        add(group.heading || block.title, paragraphs, '', proseNotes);
        for (const item of paragraphs) presented.add(item);
      }
      for (const table of tables) {
        const rows = tableItems(table);
        const columns = tableRows(table);
        const header = columns[0];
        if (
          !firstAction &&
          /^(즉시 확인할 사항|즉시 조치|Immediate checks|Quick Wins|最初の確認事項|立即核查)/i.test(
            group.heading,
          )
        ) {
          const action = columns[1]?.[1];
          firstAction = action?.match(/^.*?[.!?。！？](?=\s|$)/u)?.[0] ?? action;
        }
        const relationships = /^(?:관계 유형|Relationship|関係|关系)$/i.test(header[0]);
        const label = relationships ? header[0] + ' / ' + header[1] : group.heading || block.title;
        const scope = relationships
          ? paragraphs.find((r) => /\b\d+\s*\/\s*\d+/.test(r.text))
          : undefined;
        if (scope && rows.length) presented.add(scope);
        const originals = columns
          .slice(1)
          .map((row) => row.map((cell, index) => header[index] + ': ' + cell).join('\n'))
          .join('\n\n');
        const notes = [originals, proseNotes].filter(Boolean).join('\n\n');
        add(label, rows, scope?.text, notes);
      }
      // A table may be followed by a limitation, safety instruction or explanation.
      // Keep that prose visible, including beyond the per-slide excerpt cap.
      if (tables.length || isDomain) {
        const remaining = paragraphs.filter(item => !presented.has(item));
        for (let i = 0; i < remaining.length; i += 3) {
          add(group.heading || block.title, remaining.slice(i, i + 3), '', proseNotes);
        }
      }
      for (const decision of decisions) add(decision.label, [{ label: '', text: decision.text }]);
    }
  });
  if (slides.length === 1)
    slides.push({
      chapter: copy.report,
      title: copy.evidence,
      items: [{ label: '', text: copy.detail }],
      total: 1,
      from: 0,
      caption: '',
      notes: '',
      section: 0,
    });
  const named = /^(.*?)\s+(?:·|—)\s+(AWS\s.+)$/.exec(title);
  return {
    id: report.id,
    title,
    lang,
    metadata,
    coverTitle: named?.[1] || title,
    coverScope: named?.[2] || '',
    preamble: hasLedger ? preambleText.split('\n').filter(line => line !== appendixLink).join('\n') : preambleText,
    firstAction,
    slides,
    sections,
  };
}
