/**
 * Which tasks may run at the same time. A task lists the paths it expects to change (`touches`, glob-like patterns
 * relative to the repository); two tasks whose lists could match a common path are not started together, so their
 * work cannot collide at merge time. This errs toward "overlap": a false positive only serializes two tasks, a false
 * negative costs a merge conflict.
 */

/** More alternatives than this from `{a,b}` groups and the pattern counts as "everything". */
const MAX_ALTERNATIVES = 64;

/**
 * True when some path could match a pattern in `a` and a pattern in `b`. A list with no patterns is unrestricted: it
 * never overlaps anything, so a task without `touches` is never held back and never holds another back.
 */
export function touchesOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (!a.length || !b.length) return false;
  const other = b.flatMap(parse);
  return a.flatMap(parse).some((x) => other.some((y) => overlap(x, y)));
}

/** Every alternative of a pattern as a list of path segments. */
function parse(pattern: string): string[][] {
  let alternatives: string[];
  try {
    alternatives = expandBraces(pattern.replace(/\\/g, '/'), { left: MAX_ALTERNATIVES });
  } catch {
    return [['**']];
  }
  return alternatives.map(segments);
}

/** `a/{b,c}.ts` as `a/b.ts` and `a/c.ts`. A group without a comma keeps its text; an unbalanced brace is left for `segments`. */
function expandBraces(p: string, budget: { left: number }): string[] {
  const open = p.indexOf('{');
  if (open < 0) {
    if (--budget.left < 0) throw new RangeError('too many alternatives');
    return [p];
  }
  const parts: string[] = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open; i < p.length; i++) {
    if (p[i] === '{') depth++;
    else if (p[i] === ',' && depth === 1) {
      parts.push(p.slice(from, i));
      from = i + 1;
    } else if (p[i] === '}' && --depth === 0) {
      parts.push(p.slice(from, i));
      const head = p.slice(0, open);
      const tail = p.slice(i + 1);
      return parts.flatMap((alt) => expandBraces(head + alt + tail, budget));
    }
  }
  if (--budget.left < 0) throw new RangeError('too many alternatives');
  return [p];
}

/**
 * A pattern as path segments. Case is ignored (macOS and Windows do), `.`, `./` and doubled or leading slashes are
 * dropped, and `..` or an empty pattern stand for the whole tree. A trailing slash, or a last segment that looks like a
 * directory (see below), also covers everything under it.
 */
function segments(raw: string): string[] {
  const p = raw.trim().toLowerCase();
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return ['**'];
    out.push(simplify(seg));
  }
  const last = out.at(-1);
  if (last === undefined) return ['**'];
  if (last !== '**' && (p.endsWith('/') || looksLikeDirectory(last))) out.push('**');
  return out;
}

/** `**` alone crosses directories; inside a name it is an ordinary `*`. Character classes become `?`; anything fancier a `*`. */
function simplify(seg: string): string {
  if (/^\*{2,}$/.test(seg)) return '**';
  const s = seg.replace(/\[[^\]]*\]/g, '?').replace(/\*{2,}/g, '*');
  return /[(){}]/.test(s) ? '*' : s;
}

/**
 * Whether a last segment probably names a directory, so that the pattern covers its contents: no wildcard and no
 * extension (`src`, `.github`), or `*` alone. `Makefile` is taken for a directory too, which only costs an overlap.
 */
function looksLikeDirectory(seg: string): boolean {
  return seg === '*' || (!/[*?]/.test(seg) && !/.\./.test(seg));
}

/** Can some path match both segment lists? `**` takes any number of segments, including none. */
function overlap(a: string[], b: string[]): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let r: boolean;
    if (i === a.length) r = b.slice(j).every((s) => s === '**');
    else if (j === b.length) r = a.slice(i).every((s) => s === '**');
    else if (a[i] === '**' || b[j] === '**') r = go(i + 1, j) || go(i, j + 1);
    else r = segmentsMatch(a[i]!, b[j]!) && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

/** Can one name match both patterns, where `*` is any run of characters and `?` any one? */
function segmentsMatch(p: string, q: string): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (q.length + 1) + j;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let r: boolean;
    if (i === p.length) r = [...q.slice(j)].every((c) => c === '*');
    else if (j === q.length) r = [...p.slice(i)].every((c) => c === '*');
    else if (p[i] === '*') r = go(i + 1, j) || go(i, j + 1);
    else if (q[j] === '*') r = go(i, j + 1) || go(i + 1, j);
    else r = (p[i] === '?' || q[j] === '?' || p[i] === q[j]) && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}
