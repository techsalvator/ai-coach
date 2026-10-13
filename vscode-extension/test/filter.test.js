'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EMPTY, applyFilter, describe, isActive, modelsIn } = require('../filter');

const now = Date.parse('2026-10-05T12:00:00');
const prompt = (text, usd, daysAgo, model = 'claude-sonnet-5-5') => ({
  text, usd, ts: new Date(now - daysAgo * 86400000).toISOString(), models: [model], tokensIn: 10, tokensOut: 1,
  split: { fresh: 10, cacheRead: 0, cacheWrite: 0, out: 1, calls: 1, known: true },
  calls: [{ model, tokensIn: 10, tokensOut: 1, usd, fresh: 10, cacheRead: 0, cacheWrite: 0 }],
});
const sessions = () => [
  { source: 'claude', id: 'a05dcb09-1111', title: 'checkout', cwd: '/x/shop', models: [{ model: 'claude-sonnet-5-5', calls: 2 }], prompts: [prompt('fix cart', 1, 0), prompt('add tests', 5, 10)] },
  { source: 'copilot', id: 'b4489ffc-2222', title: 'docs', cwd: '/x/docs', models: [{ model: 'claude-opus-5-5', calls: 1 }], prompts: [prompt('rewrite readme', 3, 1, 'claude-opus-5-5')] },
];

test('empty filter returns the sessions untouched', () => {
  const s = sessions();
  assert.strictEqual(isActive(EMPTY), false);
  assert.strictEqual(applyFilter(s, EMPTY, now), s);
});

test('period keeps only recent prompts and recomputes totals', () => {
  const r = applyFilter(sessions(), { ...EMPTY, period: 'week' }, now);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].prompts.length, 1);
  assert.strictEqual(r[0].usd, 1);
  assert.strictEqual(r[0].split.calls, 1);
  assert.strictEqual(r[0].split.out, 1);
});

test('model, min cost and text combine; empty sessions drop', () => {
  assert.deepStrictEqual(applyFilter(sessions(), { ...EMPTY, models: ['claude-opus-5-5'] }, now).map((s) => s.title), ['docs']);
  assert.deepStrictEqual(applyFilter(sessions(), { ...EMPTY, minUsd: 4 }, now).map((s) => s.title), ['checkout']);
  assert.deepStrictEqual(applyFilter(sessions(), { ...EMPTY, text: 'shop tests' }, now).map((s) => s.prompts.length), [1]);
  assert.deepStrictEqual(applyFilter(sessions(), { ...EMPTY, text: 'nothing' }, now), []);
});

test('text matches a session id', () => {
  assert.deepStrictEqual(applyFilter(sessions(), { ...EMPTY, text: 'a05dcb09' }, now).map((s) => s.title), ['checkout']);
});

test('filters by source', () => {
  assert.deepStrictEqual(applyFilter(sessions(), { ...EMPTY, sources: ['copilot'] }, now).map((s) => s.title), ['docs']);
  assert.strictEqual(describe({ ...EMPTY, sources: ['claude', 'copilot'] }), 'Claude Code, Copilot CLI');
});

test('filters to one day', () => {
  const day = require('../filter').dayKey(new Date(now - 86400000).toISOString());
  const r = applyFilter(sessions(), { ...EMPTY, day }, now);
  assert.deepStrictEqual(r.map((x) => x.title), ['docs']);
  assert.ok(describe({ ...EMPTY, day }).length > 0);
});

test('lastDays keeps recent prompts, 0 keeps everything', () => {
  const { lastDays } = require('../filter');
  assert.strictEqual(lastDays(sessions(), 0, now).length, 2);
  const r = lastDays(sessions(), 7, now);
  assert.deepStrictEqual(r.map((x) => [x.title, x.prompts.length]), [['checkout', 1], ['docs', 1]]);
  assert.strictEqual(r[0].usd, 1);
});

test('a day range includes both ends', () => {
  const { dayKey } = require('../filter');
  const a = dayKey(new Date(now - 10 * 86400000).toISOString()); const b = dayKey(new Date(now - 9 * 86400000).toISOString());
  assert.deepStrictEqual(applyFilter(sessions(), { ...EMPTY, day: `${a}..${b}` }, now).map((x) => x.prompts.map((p) => p.text)), [['add tests']]);
  assert.match(describe({ ...EMPTY, day: `${a}..${b}` }), / to /);
});

test('describes the filter and lists models', () => {
  assert.strictEqual(describe({ ...EMPTY, period: 'today', minUsd: 2 }), 'Today · ≥ $2');
  assert.deepStrictEqual(modelsIn(sessions()), ['claude-sonnet-5-5', 'claude-opus-5-5']);
});

test('lastDays treats -1 like 0: everything', () => {
  const { lastDays } = require('../filter');
  assert.strictEqual(lastDays(sessions(), -1, now).length, 2);
  assert.strictEqual(lastDays(sessions(), -1, now)[0].prompts.length, 2);
});
