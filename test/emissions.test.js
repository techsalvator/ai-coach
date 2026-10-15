'use strict';
const test = require('node:test');
const assert = require('node:assert');
const em = require('../lib/emissions');

test('a bigger model emits more for the same tokens, and output weighs more than input', () => {
  const c = { tokensIn: 5000, tokensOut: 400 };
  const small = em.callGrams(c, 'claude-haiku-5-5');
  const mid = em.callGrams(c, 'claude-sonnet-5-5');
  const large = em.callGrams(c, 'claude-opus-5-5');
  assert.ok(small < mid && mid < large);
  assert.ok(em.callGrams({ tokensIn: 0, tokensOut: 1000 }, 'gpt-5.4') > em.callGrams({ tokensIn: 1000, tokensOut: 0 }, 'gpt-5.4'));
});

test('cache reads cost far less than fresh input', () => {
  const fresh = em.callGrams({ fresh: 50000, cacheRead: 0, cacheWrite: 0, tokensOut: 0 }, 'claude-sonnet-5-5');
  const cached = em.callGrams({ fresh: 0, cacheRead: 50000, cacheWrite: 0, tokensOut: 0 }, 'claude-sonnet-5-5');
  assert.ok(cached < fresh / 5);
});

test('a prompt sums its calls; one without calls uses its totals; no tokens is null', () => {
  const calls = [{ model: 'claude-sonnet-5-5', fresh: 1000, cacheRead: 0, cacheWrite: 0, tokensOut: 200 }, { model: 'claude-opus-5-5', fresh: 500, cacheRead: 0, cacheWrite: 0, tokensOut: 100 }];
  assert.ok(Math.abs(em.promptGrams({ calls }) - (em.callGrams(calls[0]) + em.callGrams(calls[1]))) < 1e-9);
  assert.ok(em.promptGrams({ calls: [], tokensIn: 1000, tokensOut: 200, models: ['gpt-5.4'] }) > 0);
  assert.strictEqual(em.promptGrams({ calls: [] }), null);
});

test('unknown models are medium and flagged as a guess; format picks a readable unit', () => {
  assert.deepStrictEqual(em.classOf('mystery-model'), { name: 'medium', guess: true });
  assert.strictEqual(em.classOf('claude-opus-5-5').name, 'large');
  assert.strictEqual(em.format(0.456), '0.46 g');
  assert.strictEqual(em.format(12.34), '12.3 g');
  assert.strictEqual(em.format(1500), '1.50 kg');
  assert.strictEqual(em.format(null), '—');
});

test('the factors file says it is not GreenPixie data', () => {
  assert.match(em.FACTORS.label, /NOT GreenPixie/);
});
