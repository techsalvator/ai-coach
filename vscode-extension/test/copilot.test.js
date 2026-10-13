'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mergeSplit, split, modelsOf } = require('../model');

test('mergeSplit is unknown only when no part has token data', () => {
  assert.strictEqual(mergeSplit([]).known, false);
  assert.strictEqual(mergeSplit([mergeSplit([]), split([{ fresh: 1, cacheRead: 9, cacheWrite: 0, tokensOut: 2 }])]).known, true);
  const t = mergeSplit([split([{ fresh: 1, cacheRead: 9, cacheWrite: 0, tokensOut: 2 }]), split([{ fresh: 5, cacheRead: 5, cacheWrite: 0, tokensOut: 1 }])]);
  assert.deepStrictEqual([t.in, t.out, t.cacheHit], [20, 3, 0.7]);
});

test('modelsOf counts a prompt without per-call data once, on its first model', () => {
  const p = { calls: [], models: ['gpt-5'], usd: 0.5, split: { calls: 1, in: 100, out: 10 } };
  const q = { calls: [{ model: 'gpt-5', tokensIn: 50, tokensOut: 5, usd: 0.1 }], models: ['gpt-5'], usd: 0.1, split: {} };
  const [m] = modelsOf([p, q]);
  assert.deepStrictEqual([m.model, m.calls, m.in, m.out, m.usd], ['gpt-5', 2, 150, 15, 0.6]);
});
