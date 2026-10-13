'use strict';
// Orders sessions, the prompts inside them, and each prompt's calls by one key. Pure, so it is tested without VS Code.

/** Tokens of a session or prompt (which carry a split) or of a call (which carries its own counts). */
function tok(x) {
  if (x.split) return x.split;
  return { known: true, in: x.tokensIn, out: x.tokensOut, calls: 1, cacheHit: x.tokensIn ? (x.cacheRead || 0) / x.tokensIn : null };
}
const known = (x, f) => { const t = tok(x); return t.known ? f(t) : null; };

const KEYS = {
  time: { label: 'Time (default order)', get: (x) => Date.parse(x.ts), firstDir: 'asc' },
  cost: { label: 'Cost', get: (x) => x.usd, firstDir: 'desc' },
  in: { label: 'Tokens in', get: (x) => known(x, (t) => t.in), firstDir: 'desc' },
  out: { label: 'Tokens out', get: (x) => known(x, (t) => t.out), firstDir: 'desc' },
  cache: { label: 'Cache hit', get: (x) => tok(x).cacheHit, firstDir: 'asc' },
  calls: { label: 'Model calls', get: (x) => known(x, (t) => t.calls), firstDir: 'desc' },
};
const DEFAULT = { key: 'time', dir: 'asc' };

const isDefault = (s) => s.key === DEFAULT.key && s.dir === DEFAULT.dir;

/** Choosing the current key flips its direction; a new key starts in its natural direction. */
function choose(sort, key) {
  if (sort.key === key) return { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: KEYS[key].firstDir };
}

/** Items ordered by the key. One with no value for it goes last, whichever way it is sorted. */
function sortItems(items, sort) {
  const { get } = KEYS[sort.key];
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const x = get(a); const y = get(b);
    const nx = x == null || Number.isNaN(x); const ny = y == null || Number.isNaN(y);
    if (nx || ny) return nx === ny ? 0 : nx ? 1 : -1;
    return (x - y) * sign || (Date.parse(a.ts) - Date.parse(b.ts));
  });
}
const sortPrompts = sortItems;

/** Sessions, prompts and calls all reordered. Items keep their own numbers; only the array order changes. */
function applySort(sessions, sort) {
  if (isDefault(sort)) return sessions;
  return sortItems(sessions, sort).map((s) => ({
    ...s, prompts: sortItems(s.prompts, sort).map((p) => ({ ...p, calls: sortItems(p.calls, sort) })),
  }));
}

const describe = (sort) => (isDefault(sort) ? '' : `${KEYS[sort.key].label} ${sort.dir === 'asc' ? '↑' : '↓'}`);

module.exports = { KEYS, DEFAULT, isDefault, choose, sortItems, sortPrompts, applySort, describe };
