/** Shared, bounded interpretation of cached Tempo metadata. No network or DB access. */
export interface TempoAttribute {
  name: string;
  types: string[];
  typesTruncated: boolean;
}

const TYPES = new Set(['int', 'float', 'string', 'bool', 'duration', 'status', 'kind']);
const INTRINSICS = new Set(['duration', 'status', 'name', 'kind', 'statusMessage',
  'rootName', 'rootServiceName', 'traceDuration', 'nestedSetLeft', 'nestedSetRight', 'nestedSetParent']);

export function isTempoIntrinsic(name: string): boolean {
  return INTRINSICS.has(name) || /^(span|trace|event|link|instrumentation):[A-Za-z_][\w.]*$/.test(name);
}

/** A qualified custom identifier, including the unscoped `.key` form. */
export function tempoAttributeIdentity(identifier: string): { scope: string; key: string } | null {
  const match = /^(\.|(?:span|resource|event|link|instrumentation)\.)([\s\S]+)$/.exec(identifier.trim());
  if (!match) return null;
  let key = match[2];
  if (key.startsWith('"')) {
    try { key = JSON.parse(key); } catch { return null; }
    if (typeof key !== 'string') return null;
  } else if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) return null;
  if (!key || key.length > 1024 || /[\u0000-\u001f\u007f]/.test(key)) return null;
  return { scope: match[1] === '.' ? '' : match[1].slice(0, -1), key };
}

export function tempoAttributeKey(identifier: string): string | null {
  const identity = tempoAttributeIdentity(identifier);
  return identity ? JSON.stringify([identity.scope, identity.key]) : null;
}

export function normalizeTempoSchema(schema: unknown): {
  attributes: TempoAttribute[]; hasShape: boolean; incomplete: boolean; namesTruncated: boolean;
} {
  const s = schema && typeof schema === 'object' && !Array.isArray(schema)
    ? schema as Record<string, unknown> : {};
  const structured = Array.isArray(s.attributes);
  const source = structured ? s.attributes as unknown[] : Array.isArray(s.tags) ? s.tags : [];
  const hasShape = structured || Array.isArray(s.tags);
  const namesTruncated = typeof s.names_truncated === 'boolean' ? s.names_truncated : s.truncated === true;
  let malformed = source.length > 200;
  const byKey = new Map<string, TempoAttribute>();
  for (const item of source.slice(0, 200)) {
    let attribute: TempoAttribute;
    if (structured) {
      if (!item || typeof item !== 'object' || typeof (item as { name?: unknown }).name !== 'string') {
        malformed = true; continue;
      }
      const a = item as Record<string, unknown>;
      const name = a.name as string;
      // Earlier cached v2 schemas mixed the virtual intrinsic scope into attributes.
      if (isTempoIntrinsic(name)) continue;
      const rawTypes = Array.isArray(a.types) ? a.types : [];
      const types = rawTypes.filter((t): t is string => typeof t === 'string' && TYPES.has(t));
      attribute = {
        name, types: [...new Set(types)],
        typesTruncated: a.types_truncated === true
          || (s.truncated === true && a.types_truncated !== false)
          || types.length !== rawTypes.length,
      };
    } else {
      // The unscoped v1 request returns raw custom keys, not virtual intrinsics.
      // A raw `duration` is therefore `.duration`, distinct from intrinsic `duration`.
      if (typeof item !== 'string' || !item) { malformed = true; continue; }
      const reserved = /^(span|resource|event|link|instrumentation|parent|trace)(\.|$)/.test(item);
      const key = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(item) && !reserved ? item : JSON.stringify(item);
      attribute = { name: `.${key}`, types: [], typesTruncated: false };
    }
    const key = tempoAttributeKey(attribute.name);
    if (!key) { malformed = true; continue; }
    const previous = byKey.get(key);
    if (previous) {
      previous.typesTruncated ||= attribute.typesTruncated || !previous.types.length || !attribute.types.length;
      previous.types = [...new Set([...previous.types, ...attribute.types])];
    } else byKey.set(key, attribute);
  }
  const attributes = [...byKey.values()];
  return { attributes, hasShape,
    incomplete: !hasShape || malformed || namesTruncated || (!attributes.length && s.truncated === true),
    namesTruncated: malformed || namesTruncated };
}
