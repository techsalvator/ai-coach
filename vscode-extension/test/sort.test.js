'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DEFAULT, choose, sortPrompts, applySort, describe } = require('../sort');

const p = (n, usd, tin, cache) => ({ n, usd, ts: `2026-10-0${n}T10:00:00Z`, split: { known: tin != null, in: tin, out: 1, calls: 1, cacheHit: cache } });
const prompts = [p(1, 5, 100, 0.9), p(2, 1, 900, 0.1), p(3, null, null, null), p(4, 3, 500, 0.5)];

test('default order is the conversation order, untouched', () => {
  const s = [{ prompts }];
  assert.strictEqual(applySort(s, DEFAULT), s);
});

test('sorts by cost descending, with unpriced prompts last', () => {
  assert.deepStrictEqual(sortPrompts(prompts, { key: 'cost', dir: 'desc' }).map((x) => x.n), [1, 4, 2, 3]);
  assert.deepStrictEqual(sortPrompts(prompts, { key: 'cost', dir: 'asc' }).map((x) => x.n), [2, 4, 1, 3]);
});

test('sorts by tokens and cache hit; prompts without token data go last', () => {
  assert.deepStrictEqual(sortPrompts(prompts, { key: 'in', dir: 'desc' }).map((x) => x.n), [2, 4, 1, 3]);
  assert.deepStrictEqual(sortPrompts(prompts, { key: 'cache', dir: 'asc' }).map((x) => x.n), [2, 4, 1, 3]);
});

test('choosing the same key flips direction, a new key starts naturally', () => {
  assert.deepStrictEqual(choose({ key: 'cost', dir: 'desc' }, 'cost'), { key: 'cost', dir: 'asc' });
  assert.deepStrictEqual(choose({ key: 'cost', dir: 'desc' }, 'time'), { key: 'time', dir: 'asc' });
  assert.deepStrictEqual(choose(DEFAULT, 'in'), { key: 'in', dir: 'desc' });
});

test('sorts sessions, prompts and calls together', () => {
  const call = (n, usd, tin) => ({ n, usd, ts: `2026-10-01T10:0${n}:00Z`, tokensIn: tin, tokensOut: 1, cacheRead: 0 });
  const sess = (id, usd, ts, ps) => ({ id, usd, ts, split: { known: true, in: usd * 100, out: 1, calls: 1, cacheHit: 0.5 }, prompts: ps });
  const a = sess('a', 1, '2026-10-03T00:00:00Z', [{ ...p(1, 1, 10, 0.5), calls: [call(1, 0.1, 5), call(2, 0.9, 5)] }, p(2, 5, 10, 0.5)].map((x) => ({ calls: [], ...x })));
  const b = sess('b', 9, '2026-10-01T00:00:00Z', []);
  const r = applySort([a, b], { key: 'cost', dir: 'desc' });
  assert.deepStrictEqual(r.map((x) => x.id), ['b', 'a']);
  assert.deepStrictEqual(r[1].prompts.map((x) => x.n), [2, 1]);
  assert.deepStrictEqual(r[1].prompts[1].calls.map((x) => x.n), [2, 1]);
  assert.deepStrictEqual(applySort([a, b], { key: 'time', dir: 'desc' }).map((x) => x.id), ['a', 'b']);
});

test('applySort keeps other session fields and describes itself', () => {
  const r = applySort([{ id: 'x', usd: 1, ts: '2026-10-01T00:00:00Z', split: { known: true }, prompts: prompts.map((x) => ({ calls: [], ...x })) }], { key: 'cost', dir: 'desc' });
  assert.strictEqual(r[0].id, 'x');
  assert.strictEqual(describe({ key: 'cost', dir: 'desc' }), 'Cost ↓');
  assert.strictEqual(describe(DEFAULT), '');
});
