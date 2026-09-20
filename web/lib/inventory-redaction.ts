const normalizeKey = (key: string) => key.replace(/[_-]/g, '').toLowerCase();
const secretKeys = new Set(['customheaders', 'origincustomheaders', 'clientsecret']);
const containers = new Set(['row', 'origins', 'actions', 'authenticateoidcconfig']);

/** Remove recognized provider-secret fields, including legacy JSON-string copies.
 * This is not a free-text secret detector. Never truncate an encoded credential value. */
export function redactInventorySecrets<T>(input: T): T {
  let remaining = 20_000, removed = 0;
  const unsafe = () => new Error('Inventory metadata cannot be safely projected');
  const walk = (value: unknown, depth: number, key = '', encodedContainer = false): unknown => {
    if (--remaining < 0 || depth > 32) throw unsafe();
    if (typeof value === 'string') {
      const first = value.trimStart()[0];
      if (first !== '{' && first !== '[' && first !== '"') return value;
      if (value.length > 256 * 1024) throw unsafe();
      let decoded: unknown;
      try { decoded = JSON.parse(value); }
      catch {
        if (key === '' || encodedContainer || containers.has(normalizeKey(key))) throw unsafe();
        return value;
      }
      const before = removed;
      const clean = walk(decoded, depth + 1, key, encodedContainer);
      return removed === before ? value : JSON.stringify(clean);
    }
    if (value instanceof Date) return value.toJSON();
    if (Array.isArray(value)) return value.map(item =>
      walk(item, depth + 1, key, encodedContainer || containers.has(normalizeKey(key))));
    if (value && typeof value === 'object') {
      const clean: Record<string, unknown> = {};
      for (const [name, item] of Object.entries(value)) {
        if (secretKeys.has(normalizeKey(name))) { removed++; continue; }
        const wrapper = normalizeKey(name) === 'items' && (encodedContainer || containers.has(normalizeKey(key)));
        Object.defineProperty(clean, name, { value: walk(item, depth + 1, name, wrapper),
          enumerable: true, configurable: true, writable: true });
      }
      return clean;
    }
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (typeof value === 'bigint') throw unsafe();
    return value;
  };
  return walk(input, 0) as T;
}
