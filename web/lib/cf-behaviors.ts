// CloudFront cache-behavior parsing and request-path matching (pure; patterns use the linear glob-match).
// Inventory rows are Steampipe-shaped: snake_case columns, PascalCase nested keys.
import { globMatch } from './glob-match';

export interface CfBehavior { pathPattern: string; targetOriginId: string; order: number; isDefault: boolean }

type Row = Record<string, unknown>;

/** Parse a jsonb value that may arrive as a JSON string; unparseable strings yield undefined. */
function parsed(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return undefined; }
}

function obj(v: unknown): Row | null {
  const p = parsed(v);
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Row) : null;
}

/**
 * Accept an array, `{ Items }` / `{ Quantity, Items }`, or either as a JSON string. Absent (`null`/`undefined`)
 * and `{ Quantity: 0 }` (Items null/absent — the Steampipe shape of a default-only distribution) are zero
 * behaviors. Anything else that does not parse to an Items array, or whose Quantity disagrees with Items.length,
 * is malformed → null, so the caller rejects the whole row instead of silently routing via the default.
 */
function items(v: unknown): unknown[] | null {
  if (v === null || v === undefined) return [];
  const p = parsed(v);
  if (Array.isArray(p)) return p;
  const o = obj(p);
  if (!o) return null;
  const q = o.Quantity, list = o.Items;
  if (q !== undefined && (typeof q !== 'number' || !Number.isInteger(q))) return null;
  if (list === null || list === undefined) return q === 0 ? [] : null;
  if (!Array.isArray(list) || (q !== undefined && q !== list.length)) return null;
  return list;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const MAX_PATH_PATTERN = 255;

/**
 * Ordered cache behaviors followed by the default (`pathPattern: '*'`, `order: Infinity`).
 * All-or-nothing: if the cache_behaviors container is present but malformed, any item lacks a non-empty
 * PathPattern/TargetOriginId (or has one over 255 characters), or a present default lacks a non-empty TargetOriginId, the
 * whole row yields `[]`. A partial list
 * would silently reroute requests to the wrong behavior. An absent default is allowed.
 */
export function cloudFrontBehaviors(row: Record<string, unknown>): CfBehavior[] {
  const out: CfBehavior[] = [];
  const list = items(row.cache_behaviors);
  if (!list) return [];
  for (const raw of list) {
    const it = obj(raw);
    const pathPattern = text(it?.PathPattern);
    const targetOriginId = text(it?.TargetOriginId);
    // CloudFront caps PathPattern at 255 characters; a longer one is malformed (and is never compiled to a RegExp).
    if (!pathPattern || !targetOriginId || pathPattern.length > MAX_PATH_PATTERN) return [];
    out.push({ pathPattern, targetOriginId, order: out.length, isDefault: false });
  }
  const rawDefault = row.default_cache_behavior;
  if (rawDefault != null) {
    const def = obj(rawDefault);
    const targetOriginId = text(def?.TargetOriginId);
    if (!targetOriginId) return [];
    out.push({ pathPattern: '*', targetOriginId, order: Infinity, isDefault: true });
  }
  return out;
}

export function matchBehavior(behaviors: CfBehavior[], path: string): CfBehavior | null {
  let p = path.split('#')[0].split('?')[0];
  if (!p.startsWith('/')) p = `/${p}`;
  // CloudFront patterns for non-default behaviors may omit the leading slash; normalise the same way.
  const ordered = behaviors.filter((b) => !b.isDefault).sort((a, b) => a.order - b.order);
  for (const b of ordered) {
    const pat = b.pathPattern.startsWith('/') || b.pathPattern.startsWith('*') ? b.pathPattern : `/${b.pathPattern}`;
    if (globMatch(pat, p)) return b; // linear glob, never a backtracking RegExp
  }
  return behaviors.find((b) => b.isDefault) ?? null;
}

/** What a CloudFront origin sends on: its DomainName and normalized OriginPath ('' none, null unreadable). */
export interface CfOrigin { domainName: string; originPath: string | null }

/**
 * Origins by Id (`origins` as an array, `{ Items }`, or either as a JSON string), or null when the container is
 * malformed. OriginPath is prepended by CloudFront to every request path: normalized to a leading '/' and no
 * trailing '/'; absent/null is '' and a non-string value is null (the path the origin sees is unknown).
 */
export function cloudFrontOrigins(row: Record<string, unknown>): Map<string, CfOrigin> | null {
  const list = items(row.origins);
  if (!list) return null;
  const out = new Map<string, CfOrigin>();
  for (const raw of list) {
    const o = obj(raw), id = text(o?.Id);
    if (!o || !id) continue;
    const p = o.OriginPath;
    const originPath = p == null ? '' : typeof p !== 'string' ? null
      : p.trim() === '' ? '' : `/${p.trim().replace(/^\/+/, '').replace(/\/+$/, '')}`.replace(/^\/$/, '');
    // A duplicated Id cannot say which origin a behavior uses: neither its domain nor its path is known.
    out.set(id, out.has(id) ? { domainName: '', originPath: null } : { domainName: text(o.DomainName), originPath });
  }
  return out;
}
