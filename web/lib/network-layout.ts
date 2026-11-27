// Deterministic AWS-diagram container layout for NetworkTopology (pure, React-free).
// AWS architecture diagrams are nested grids (Account > Region > VPC > AZ > Subnet > tiles),
// so a post-order box packer is enough; no general graph-layout dependency is needed.
// Coordinates follow xyflow `parentId` semantics: x/y are relative to the parent box.
import type { NetKind, NetNode, NetworkTopology } from './network-topology-types';

export interface Placed { id: string; parentId?: string; x: number; y: number; width: number; height: number }

const PAD = 16, HEADER = 30, GAP = 16, TILE_GAP = 8, BAND_GAP = 40;
const ACCOUNT_INNER = 1360, TOP_WIDTH = 1400, SUBNET_COLS = 3;
const TILE = { w: 84, h: 72 };
const LEAF: Partial<Record<NetKind, { w: number; h: number }>> = {
  vpc: { w: 200, h: 60 }, tgw: { w: 160, h: 52 }, external: { w: 190, h: 52 },
};
const EMPTY_SUBNET = { w: 220, h: 64 };
const TILE_KINDS = new Set<NetKind>(['igw', 'nat', 'vpce', 'ec2', 'alb', 'nlb', 'rds', 'lambda', 'more']);

type Size = { w: number; h: number };
type Pos = { x: number; y: number };

/** Wrap boxes left→right within maxWidth; returns positions and the content size. */
function flow(sizes: Size[], maxWidth: number, gap = GAP): { pos: Pos[]; w: number; h: number } {
  const pos: Pos[] = [];
  let x = 0, y = 0, rowH = 0, w = 0;
  for (const s of sizes) {
    if (x > 0 && x + s.w > maxWidth) { x = 0; y += rowH + gap; rowH = 0; }
    pos.push({ x, y });
    x += s.w + gap; rowH = Math.max(rowH, s.h); w = Math.max(w, x - gap);
  }
  return { pos, w, h: sizes.length ? y + rowH : 0 };
}

export function layoutNetwork(t: NetworkTopology): Placed[] {
  const children = new Map<string, NetNode[]>();
  const ids = new Set(t.nodes.map((n) => n.id));
  for (const n of t.nodes) {
    const key = n.parent && ids.has(n.parent) ? n.parent : '';
    children.set(key, [...(children.get(key) ?? []), n]);
  }
  const size = new Map<string, Size>();
  const rel = new Map<string, Pos>();

  function measure(n: NetNode): Size {
    const kids = children.get(n.id) ?? [];
    let s: Size;
    if (TILE_KINDS.has(n.kind)) s = { ...TILE };
    else if (!kids.length) s = n.kind === 'subnet' ? { ...EMPTY_SUBNET } : { ...(LEAF[n.kind] ?? EMPTY_SUBNET) };
    else {
      const sizes = kids.map(measure);
      let content: { pos: Pos[]; w: number; h: number };
      if (n.kind === 'subnet') {
        content = flow(sizes, SUBNET_COLS * TILE.w + (SUBNET_COLS - 1) * TILE_GAP, TILE_GAP);
        content.w = Math.max(content.w, EMPTY_SUBNET.w - 2 * PAD);
      } else if (n.kind === 'az') {
        // Stack subnets vertically.
        let y = 0, w = 0;
        const pos = sizes.map((s) => { const p = { x: 0, y }; y += s.h + GAP; w = Math.max(w, s.w); return p; });
        content = { pos, w, h: y - GAP };
      } else if (n.kind === 'vpc') {
        // VPC-level tiles on a top row, then AZ columns left → right (never wrapped).
        const tiles = kids.map((k, i) => ({ k, i })).filter(({ k }) => k.kind !== 'az');
        const azs = kids.map((k, i) => ({ k, i })).filter(({ k }) => k.kind === 'az');
        const top = flow(tiles.map(({ i }) => sizes[i]), Number.MAX_SAFE_INTEGER, TILE_GAP);
        const pos: Pos[] = new Array(kids.length);
        tiles.forEach(({ i }, j) => { pos[i] = top.pos[j]; });
        const y0 = tiles.length ? top.h + GAP : 0;
        let x = 0, h = 0;
        for (const { i } of azs) { pos[i] = { x, y: y0 }; x += sizes[i].w + GAP; h = Math.max(h, sizes[i].h); }
        content = { pos, w: Math.max(top.w, azs.length ? x - GAP : 0), h: y0 + h };
      } else if (n.kind === 'region' && t.level === 'fleet' && kids.some(k => k.kind === 'tgw')) {
        // Regional hubs get their own band; attachments branch to VPCs below.
        const hubs = kids.map((k, i) => ({ k, i })).filter(({ k }) => k.kind === 'tgw');
        const others = kids.map((k, i) => ({ k, i })).filter(({ k }) => k.kind !== 'tgw');
        const top = flow(hubs.map(({ i }) => sizes[i]), ACCOUNT_INNER);
        const bottom = flow(others.map(({ i }) => sizes[i]), ACCOUNT_INNER);
        const w = Math.max(top.w, bottom.w), y0 = top.h + GAP * 3;
        const pos: Pos[] = new Array(kids.length);
        hubs.forEach(({ i }, j) => { pos[i] = { x: top.pos[j].x + (w - top.w) / 2, y: top.pos[j].y }; });
        others.forEach(({ i }, j) => { pos[i] = { x: bottom.pos[j].x, y: y0 + bottom.pos[j].y }; });
        content = { pos, w, h: others.length ? y0 + bottom.h : top.h };
      } else {
        content = flow(sizes, ACCOUNT_INNER);
      }
      kids.forEach((k, i) => rel.set(k.id, { x: PAD + content.pos[i].x, y: HEADER + content.pos[i].y }));
      s = { w: content.w + 2 * PAD, h: HEADER + content.h + PAD };
    }
    size.set(n.id, s);
    return s;
  }

  // Top level: out-of-scope hubs/stubs in a band at y=0, account boxes wrapped below it.
  const roots = children.get('') ?? [];
  const band = roots.filter((n) => n.kind !== 'account');
  const accounts = roots.filter((n) => n.kind === 'account');
  const bandFlow = flow(band.map(measure), TOP_WIDTH);
  band.forEach((n, i) => rel.set(n.id, bandFlow.pos[i]));
  const y0 = band.length ? bandFlow.h + BAND_GAP : 0;
  const accountFlow = flow(accounts.map(measure), TOP_WIDTH, BAND_GAP);
  accounts.forEach((n, i) => rel.set(n.id, { x: accountFlow.pos[i].x, y: y0 + accountFlow.pos[i].y }));

  return t.nodes.map((n) => {
    const p = rel.get(n.id) ?? { x: 0, y: 0 };
    const s = size.get(n.id) ?? measure(n);
    return { id: n.id, ...(n.parent && ids.has(n.parent) ? { parentId: n.parent } : {}), x: p.x, y: p.y, width: s.w, height: s.h };
  });
}
