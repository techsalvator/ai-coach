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

test('electricity, CO2e and water move together and follow the factors', () => {
  const f = em.FACTORS;
  const i = em.callImpact({ tokensIn: 0, tokensOut: 1000 }, 'claude-sonnet-5-5');
  assert.ok(Math.abs(i.wh - 1000 * f.classes.medium.whPerOutputToken * f.pue) < 1e-9);
  assert.ok(Math.abs(i.g - i.wh * f.gridGramsPerKWh / 1000) < 1e-9);
  assert.ok(Math.abs(i.ml - i.wh * f.waterLitresPerKWh) < 1e-9);
});

test('session and total impact sum prompts; no data gives null', () => {
  const p = { calls: [{ model: 'claude-sonnet-5-5', fresh: 100, cacheRead: 0, cacheWrite: 0, tokensOut: 100 }] };
  const one = em.promptImpact(p);
  const t = em.totalImpact([{ prompts: [p, p] }, { prompts: [p] }]);
  assert.ok(Math.abs(t.wh - 3 * one.wh) < 1e-9 && Math.abs(t.ml - 3 * one.ml) < 1e-9);
  assert.strictEqual(em.promptImpact({ calls: [] }), null);
});

test('units scale readably', () => {
  assert.strictEqual(em.formatWh(0.456), '0.46 Wh');
  assert.strictEqual(em.formatWh(2500), '2.50 kWh');
  assert.strictEqual(em.formatMl(35.2), '35.2 mL');
  assert.strictEqual(em.formatMl(1500), '1.50 L');
  assert.strictEqual(em.formatMl(null), '—');
});

test('explain shows the numbers behind each figure', () => {
  const i = em.callImpact({ fresh: 1000, cacheRead: 10000, cacheWrite: 0, tokensOut: 500 }, 'claude-sonnet-5-5');
  const [elec, co2, water] = em.explain(i);
  assert.deepStrictEqual([elec.key, co2.key, water.key], ['electricity', 'co2e', 'water']);
  assert.match(elec.text, /500 output \+ 1,000 fresh input/);
  assert.match(elec.text, /10,000 cache read/);
  assert.match(elec.text, /medium-model tokens/);
  assert.match(co2.text, /445 g CO₂e per kWh/);
  assert.match(water.text, /1\.8 L per kWh/);
  assert.strictEqual(em.explain(null), null);
});
