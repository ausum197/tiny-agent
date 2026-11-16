/**
 * fzf-style fuzzy match scoring. Subsequence match over the target string with
 * bonuses for consecutive runs, word boundaries (/ _ - . and camelCase humps)
 * and starts-of-string, penalties for gaps. Returns -Infinity when the query is
 * not a subsequence of the target. Case-insensitive.
 */

export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return 0;
  if (q.length > t.length) return Number.NEGATIVE_INFINITY;

  let score = 0;
  let qi = 0;
  let prevMatch = -1;
  let consecutive = 0;

  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] !== q[qi]) continue;
    const prevChar = ti > 0 ? (t[ti - 1] ?? "/") : "/";
    const boundary = "/_-. ~".includes(prevChar);
    const camel = /[a-z]/.test(prevChar) && /[A-Z]/.test(target[ti] ?? "");

    let gain: number;
    if (prevMatch === ti - 1) {
      consecutive += 1;
      gain = 4 + Math.min(consecutive, 8); // running streak
    } else {
      consecutive = 0;
      gain = boundary ? 10 : camel ? 7 : 1;
      // gap penalty for skipped characters since the last match
      if (prevMatch >= 0) gain -= Math.min(5, ti - prevMatch - 1);
    }

    score += gain;
    if (ti === 0) score += 4; // start of string
    prevMatch = ti;
    qi += 1;
  }

  if (qi < q.length) return Number.NEGATIVE_INFINITY;
  // slight preference for shorter paths (same score, tighter name)
  score += Math.max(0, 16 - Math.floor(t.length / 4));
  return score;
}
