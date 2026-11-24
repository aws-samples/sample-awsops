// Project only evidence in the saved Markdown. Each relationship is one cited pair.
import type { Table, TableCell } from 'mdast';
import type { Lang } from './i18n';
import { toString } from 'mdast-util-to-string';

interface Relationship {
  left: string;
  right: string;
  directed: boolean;
  label: string;
  source: string;
}
export type BriefingVisual =
  | { kind: 'relationships'; rows: Relationship[] }
  | { kind: 'placement'; container: string; rows: Relationship[] }
  | { kind: 'comparison'; headers: string[]; rows: string[][]; values: number[]; unit: 'USD' | '%' }
  | { kind: 'stages' | 'boundaries' | 'matrix'; headers: string[]; rows: string[][] };

// These prefixes are AWS resource ID types, not a guess about ownership or traffic.
export function resourceRole(endpoint: string, lang: Lang): string {
  const roles = {
    rtb: { ko: '라우팅 테이블', en: 'Route table', ja: 'ルートテーブル', zh: '路由表' },
    subnet: { ko: '서브넷', en: 'Subnet', ja: 'サブネット', zh: '子网' },
    sg: { ko: '보안 그룹', en: 'Security group', ja: 'セキュリティグループ', zh: '安全组' },
  };
  const prefix = /^(rtb|subnet|sg)-(?:[a-f0-9]{17}|[a-f0-9]{8})(?:$| )/.exec(endpoint)?.[1];
  return prefix ? roles[prefix as keyof typeof roles][lang] : '';
}

export const architectureHeading = /^(?:현재 아키텍처|Current architecture|現在のアーキテクチャ|当前架构)$/i;
const relationshipHeaders = new Set([
  '관계 유형|양 끝점|관측 근거와 범위',
  'Relationship|Endpoints|Source and scope',
  '関係|両端|根拠と範囲',
  '关系|两个端点|证据和范围',
]);
const call = /^(?:호출 표본|Observed call|観測された呼び出し|观测到的调用)(?:$| [(])/i;
const association =
  /^(?:네트워크 흐름|DNS 조회|구성 관계|허용 경로|Network flow|DNS lookup|Configuration|Permitted path|ネットワークフロー|DNS 照会|構成上の関係|許可された経路|网络流|DNS 查询|配置关系|允许的路径)(?:$| [(（])/i;
const boundaryHeaders = new Set([
  '경계|이번 진단에서 읽을 수 있는 구조|업무에 활용하는 방법',
  '구조를 읽는 순서|확인된 구성·관계|이 구조에서의 운영 판단',
  'Boundary|Assessed components|Decision',
  '경계|확인된 구성|운영 판단',
  '境界|確認済みの構成|運用判断',
  '边界|已确认的配置|运维决策',
]);

function endpoints(cell: TableCell, directed: boolean): string[] | undefined {
  // A slash inside a resource ID, or even an arrow in an inline-code label, is data.
  const pair = [''];
  for (const node of cell.children) {
    const value = toString(node, { includeHtml: false });
    const pieces = node.type === 'text' ? value.split(/ (→|\/) /) : [value];
    pair[pair.length - 1] += pieces[0];
    for (let i = 1; i < pieces.length; i += 2) {
      if (pieces[i] !== (directed ? '→' : '/')) return;
      pair.push(pieces[i + 1]);
    }
  }
  const names = pair.map((s) => s.replace(/\s+/g, ' ').trim());
  if (names.length === 2 && names.every((name) => name && name.length <= 105)) return names;
}

type TablePage = BriefingVisual | { kind: 'sourceRows'; rows: string[][] };

export function tableVisuals(block: string, table: Table, columns: string[][]): TablePage[] {
  const [headers, ...rows] = columns;
  if (!rows.length || rows.some((r) => r.length !== headers.length) || headers.some((h) => !h)) return [];
  const architecture = architectureHeading.test(block);
  if (architecture && relationshipHeaders.has(headers.join('|'))) {
    const edges: Relationship[] = [];
    const unplotted: string[][] = [];
    for (const [i, [label, , source]] of rows.entries()) {
      const directed = call.test(label);
      const pair = endpoints(table.children[i + 1].children[1], directed);
      if (
        !pair ||
        (!directed && !association.test(label)) ||
        !source ||
        label.length > 120 ||
        source.length > 240
      ) {
        unplotted.push(rows[i]);
        continue;
      }
      edges.push({ left: pair[0], right: pair[1], label, directed, source });
    }
    // Draw containment only for explicit inventory membership in a region-qualified VPC.
    // Similar service names, network flows and security permissions cannot establish it.
    const byVpc = new Map<string, Relationship[]>();
    for (const edge of edges) {
      const scope = /^vpc-(?:[a-f0-9]{8}|[a-f0-9]{17}) (\([a-z]{2}(?:-[a-z0-9]+)+-\d+\))$/.exec(edge.right);
      if (
        !edge.directed &&
        /^(?:구성 관계|Configuration|構成上の関係|配置关系)$/i.test(edge.label) &&
        scope &&
        edge.left.endsWith(' ' + scope[1]) &&
        edge.source.split(' · ').includes('infra:in_vpc')
      ) {
        const key = JSON.stringify([edge.right, edge.source]);
        const group = byVpc.get(key) ?? [];
        group.push(edge);
        byVpc.set(key, group);
      }
    }
    const placed = new Set<Relationship>();
    const visuals: TablePage[] = [];
    for (const members of byVpc.values()) {
      const container = members[0].right;
      if (members.length < 2) continue;
      for (let i = 0; i < members.length; i += 3)
        visuals.push({
          kind: 'placement',
          container,
          rows: members.slice(i, i + 3).map((edge) => ({
            ...edge,
            source: edge.source
              .split(' · ')
              .filter((part) => part !== 'infra:in_vpc')
              .join(' · '),
          })),
        });
      for (const member of members) placed.add(member);
    }
    const other = edges.filter((edge) => !placed.has(edge));
    for (let i = 0; i < other.length; i += 3)
      visuals.push({ kind: 'relationships', rows: other.slice(i, i + 3) });
    if (unplotted.length) visuals.push({ kind: 'sourceRows', rows: unplotted });
    return visuals;
  }

  // Keep code-owned provenance columns in notes as before, and counts in their
  // dedicated inventory layout. Short customer decision/comparison tables travel intact.
  if (
    /^(?:관계 유형|Relationship|関係|关系|유형|Type|種類|类型)$/i.test(headers[0]) ||
    headers.some((h) => /^(?:대상 · 판단|Subject · assessment|対象・判断|对象 · 判断)$/i.test(h)) ||
    headers.length < 2 ||
    headers.length > 4 ||
    headers.some((h) => h.length > 45) ||
    rows.some((r) => r.some((cell) => cell.length > 175))
  )
    return [];

  // The saved table declares the unit. Mixed quantities (CPU, queue depth,
  // connections) remain a table even when all of their cells contain numbers.
  const unit = headers[1].match(/\((USD|%)\)$/)?.[1];
  if ((unit === 'USD' || unit === '%') && headers.length === 3 && rows.length >= 2 && rows.length <= 5) {
    const number = unit === 'USD' ? /^(\d+(?:\.\d+)?)(?: USD)?$/ : /^(\d+(?:\.\d+)?)%?$/;
    const values = rows.map((row) => Number(row[1].match(number)?.[1]));
    if (
      values.every((v) => Number.isFinite(v) && v <= (unit === '%' ? 100 : Number.MAX_SAFE_INTEGER)) &&
      values.some((v) => v > 0) &&
      rows.every((r) => r[0].length <= 40 && r[2].length <= 90)
    )
      return [{ kind: 'comparison', headers, rows, values, unit }];
  }
  const phases = ['단계', '시점', 'Phase', 'Horizon', '段階', '時期', '阶段'].includes(headers[0]);
  if (
    phases &&
    headers.length <= 3 &&
    rows.length >= 2 &&
    rows.length <= 3 &&
    rows.every((r) => r[0].length <= 32 && r.slice(1).every((v) => v.length <= 105))
  )
    return [{ kind: 'stages', headers, rows }];
  const kind = architecture && boundaryHeaders.has(headers.join('|')) ? 'boundaries' : 'matrix';
  const pages: BriefingVisual[] = [];
  let page: string[][] = [];
  let lines = 0;
  for (const row of rows) {
    // A limit on the longest cell keeps projected text readable in either renderer.
    const charsPerLine = kind === 'boundaries' ? 17 : Math.floor(54 / headers.length);
    const height = Math.max(1, ...row.map((cell) => Math.ceil(Array.from(cell).length / charsPerLine)));
    if (page.length && (page.length >= (kind === 'boundaries' ? 3 : 5) || lines + height > 12)) {
      pages.push({ kind, headers, rows: page });
      page = [];
      lines = 0;
    }
    page.push(row);
    lines += height;
  }
  if (page.length) pages.push({ kind, headers, rows: page });
  return pages;
}
