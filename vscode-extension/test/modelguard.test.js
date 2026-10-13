'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../modelguard');

const NOW = Date.parse('2026-10-16T12:00:00Z'); // 15.5 of 31 days into the period
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const q = (o = {}) => ({ unlimited: false, entitlement: 300, used: 100, leftPct: 66.7, overage: 0, resets: '2026-11-01T00:00:00Z', ts: ago(0), stale: false, ...o });
const p = (days, model, premium) => ({ ts: ago(days), models: [model], premium });
// three prompts a model, over the 30 days: opus 3 a prompt, sonnet 1, mini 0
const history = [p(10, 'claude-opus-5.5', 3), p(11, 'claude-opus-5.5', 3), p(12, 'claude-opus-5.5', 3),
  p(10, 'claude-sonnet-5.5', 1), p(11, 'claude-sonnet-5.5', 1), p(12, 'claude-sonnet-5.5', 1), p(13, 'claude-sonnet-5.5', 1),
  p(10, 'gpt-5-mini', 0), p(11, 'gpt-5-mini', 0), p(12, 'gpt-5-mini', 0)];
const week = (n) => [p(1, 'claude-sonnet-5.5', n / 2), p(4, 'claude-sonnet-5.5', n / 2)]; // n requests in the last 7 days
const plan = (query, extra = [], o = {}) => G.plan(query, [{ prompts: [...history, ...extra] }], { now: NOW, ...o });

test('quiet while the month is on pace: nothing gated, nothing said', () => {
  const g = plan(q(), week(20)); // 100 + 20/7 * 15.5 = 144 of 300
  assert.strictEqual(g.active, false);
  assert.deepStrictEqual([g.gated, g.suggest, g.since], [[], null, null]);
  assert.strictEqual(G.describe(g), '');
  assert.strictEqual(G.plan(null, [], { now: NOW }).active, false, 'no reading');
  assert.strictEqual(G.plan(q({ unlimited: true }), [], { now: NOW }).active, false);
  assert.strictEqual(G.plan(q({ stale: true }), [], { now: NOW }).active, false);
});

test('active when the month is projected over the plan: the costly models, and the cheaper one you already use most', () => {
  const g = plan(q({ used: 200 }), week(100)); // 200 + 100/7 * 15.5 = 421 of 300
  assert.strictEqual(g.active, true);
  assert.strictEqual(g.reason, 'month');
  assert.strictEqual(g.projected, Math.round(200 + (100 / 7) * 15.5));
  assert.deepStrictEqual(g.gated.map((m) => [m.model, m.perPrompt]), [['claude-opus-5.5', 3]]);
  assert.deepStrictEqual([g.suggest.model, g.suggest.perPrompt], ['claude-sonnet-5.5', 1], 'the one you use most, not the cheapest');
  assert.strictEqual(g.since, NOW);
  assert.match(G.describe(g), /^This month is on pace for about 4\d\d premium requests, over the 300 included\. The costly models for you: claude-opus-5\.5 \(3 a prompt\)\. claude-sonnet-5\.5 costs you about 1 a prompt: use it for routine work\.$/);
});

test('today over the budget activates it too, whatever the month looks like', () => {
  const g = plan(q(), week(20), { todayOver: true });
  assert.deepStrictEqual([g.active, g.reason], [true, 'today']);
  assert.match(G.describe(g), /^Today's premium requests have reached the day's budget\./);
});

test('it stays active until the month is under 95% of the plan, then lets go, and a new period starts clean', () => {
  const hot = plan(q({ used: 200 }), week(100));
  assert.strictEqual(hot.active, true);
  // pace has eased: 200 + 56/7 * 15.5 = 324 -> over; 140: 200 + 20/7*15.5 = 244. Between 285 (95%) and 300: still on.
  const easing = plan(q({ used: 250 }), week(21), { prev: hot }); // 250 + 3 * 15.5 = 296.5: under 300, over 285
  assert.strictEqual(easing.projected, Math.round(250 + 3 * 15.5));
  assert.deepStrictEqual([easing.active, easing.reason, easing.since], [true, 'month', hot.since], 'still on: not yet under 95%, and it keeps the time it started');
  const calm = plan(q({ used: 100 }), week(21), { prev: easing, now: NOW + 3600e3 }); // 100 + 3 * 15.4 = 146
  assert.deepStrictEqual([calm.active, calm.since], [false, null]);
  // without the earlier state, 296.5 is simply under the plan: no flapping needed, but nothing to hold either
  assert.strictEqual(plan(q({ used: 250 }), week(21)).active, false);
  // a new period does not inherit the old one's state
  const fresh = G.plan(q({ used: 20, resets: '2026-12-01T00:00:00Z' }), [{ prompts: [...history, ...week(10)] }], { now: NOW + 20 * 86400000, prev: { ...hot, period: '2026-11-01T00:00:00Z' } });
  assert.strictEqual(fresh.active, false);
});

test('only models that cost enough are gated; with nothing observed it says the pace and nothing more', () => {
  const g = plan(q({ used: 200 }), week(100), { threshold: 3 });
  assert.deepStrictEqual(g.gated.map((m) => m.model), ['claude-opus-5.5']);
  assert.deepStrictEqual(plan(q({ used: 200 }), week(100), { threshold: 4 }).gated, []);
  assert.strictEqual(plan(q({ used: 200 }), week(100), { threshold: 4 }).suggest, null, 'nothing to move away from');
  const bare = G.plan(q({ used: 200 }), [{ prompts: week(100) }], { now: NOW });
  assert.deepStrictEqual([bare.active, bare.gated.length], [true, 0]);
  assert.match(G.describe(bare), /^This month is on pace for about \d+ premium requests, over the 300 included\.$/);
});

test('the state is kept in a small file, written whole, and a bad file reads as none', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const env = { AI_COST_HOME: path.join(home, 'data') };
  assert.strictEqual(G.load(env), null);
  const g = plan(q({ used: 200 }), week(100));
  G.save(g, env);
  assert.deepStrictEqual(G.load(env), JSON.parse(JSON.stringify(g)));
  assert.deepStrictEqual(fs.readdirSync(env.AI_COST_HOME).filter((f) => f.endsWith('.tmp')), []);
  fs.writeFileSync(G.stateFile(env), '{"active": tr');
  assert.strictEqual(G.load(env), null);
  G.save(g, { AI_COST_HOME: path.join(home, 'file-not-folder', 'x') }); // an unwritable place is not an error
});
