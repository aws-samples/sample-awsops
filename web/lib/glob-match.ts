// Linear-time glob matching (pure, dependency-free): `*` any run (including `/`), `?` exactly one character, every
// other character literal; anchored at both ends and case-sensitive. Used for CloudFront cache-behavior patterns and
// ALB path-pattern/host-header values instead of a compiled RegExp, whose `.*` expansion backtracks catastrophically
// on patterns like `*a*a…*b` (ReDoS). Works on code points.

/** Greedy two-pointer match with single-star backtracking: O(pattern × text) worst case, never exponential. */
export function globMatch(pattern: string, text: string): boolean {
  const p = [...pattern], t = [...text];
  let i = 0, j = 0, star = -1, mark = 0;
  while (j < t.length) {
    if (i < p.length && p[i] === '*') { star = i++; mark = j; }
    else if (i < p.length && (p[i] === '?' || p[i] === t[j])) { i++; j++; }
    else if (star !== -1) { i = star + 1; j = ++mark; }
    else return false;
  }
  while (i < p.length && p[i] === '*') i++;
  return i === p.length;
}
