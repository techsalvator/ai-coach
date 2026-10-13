'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const Quota = require('../quota');

const NOW = Date.parse('2026-10-16T12:00:00Z'); // a Friday, 15.5 of 31 days into the period
const ago = (days) => new Date(NOW - days * 86400000).toISOString();
const prompt = (days, models, premium) => ({ ts: ago(days), models, premium });
const sessions = (...ps) => [{ prompts: ps }];
const q = (o = {}) => ({ unlimited: false, entitlement: 300, used: 100, leftPct: 66.7, overage: 0, resets: '2026-11-01T00:00:00Z', ts: ago(0), stale: false, ...o });

test('observed: a model\'s requests per prompt is the median of your single-model prompts, once there are enough', () => {
  const s = sessions(
    prompt(1, ['claude-sonnet-5.5'], 1), prompt(2, ['claude-sonnet-5.5'], 1), prompt(3, ['claude-sonnet-5.5'], 4), // one long agent run: not the price
    prompt(1, ['claude-opus-5.5'], 3), prompt(2, ['claude-opus-5.5'], 3), prompt(3, ['claude-opus-5.5'], 3), prompt(4, ['claude-opus-5.5'], 3),
    prompt(1, ['gpt-5-mini'], 0), prompt(1, ['gpt-5-mini'], 0), prompt(2, ['gpt-5-mini'], 0),
    prompt(1, ['claude-haiku-4.5'], 0.33), prompt(2, ['claude-haiku-4.5'], 0.33), // two prompts: not believed yet
    prompt(1, ['claude-sonnet-5.5', 'gpt-5-mini'], 2), // two models: whose is it?
    prompt(1, ['gpt-5-mini'], null), // no count
    prompt(40, ['claude-opus-5.5'], 9), // out of the window
  );
  assert.deepStrictEqual(Quota.observed(s, NOW), {
    'claude-sonnet-5.5': { perPrompt: 1, prompts: 3 },
    'claude-opus-5.5': { perPrompt: 3, prompts: 4 },
    'gpt-5-mini': { perPrompt: 0, prompts: 3 },
  });
  assert.deepStrictEqual(Quota.observed(sessions(prompt(1, ['m'], 1), prompt(1, ['m'], 2), prompt(1, ['m'], 3), prompt(1, ['m'], 4)), NOW).m.perPrompt, 2.5, 'an even count: the middle two');
  assert.deepStrictEqual(Quota.observed(undefined, NOW), {});
});

test('capacity: what the room buys per model, the most used first; free models are unlimited; no history gives the usual tiers', () => {
  const seen = { 'claude-opus-5.5': { perPrompt: 3, prompts: 4 }, 'claude-sonnet-5.5': { perPrompt: 1, prompts: 30 }, 'gpt-5-mini': { perPrompt: 0, prompts: 9 }, 'claude-haiku-4.5': { perPrompt: 0.33, prompts: 3 } };
  const c = Quota.capacity(16, seen);
  assert.deepStrictEqual(c.map((x) => [x.model, x.count]), [['claude-sonnet-5.5', 16], ['gpt-5-mini', null], ['claude-opus-5.5', 5], ['claude-haiku-4.5', 48]]);
  assert.strictEqual(c.every((x) => x.generic === false), true);
  assert.strictEqual(Quota.capacity(16, seen, { max: 2 }).length, 2);
  assert.strictEqual(Quota.capacity(-3, seen)[0].count, 0, 'no room is no room');
  const generic = Quota.capacity(16, {});
  assert.deepStrictEqual(generic.map((x) => [x.model, x.perPrompt, x.count, x.generic]), [['a 0.33x model', 0.33, 48, true], ['a 1x model', 1, 16, true], ['a 3x model', 3, 5, true]]);
});

test('recentPace: the last 7 days continued, said only when it is a different story from the month', () => {
  // 100 of 300 used 15.5 days in: the month's pace ends at 200. Last week alone used 70 (10 a day): 100 + 10 * 15.5 = 255
  const busy = sessions(prompt(1, ['m'], 20), prompt(3, ['m'], 30), prompt(6, ['m'], 20), prompt(9, ['m'], 50)); // 70 inside the week, 50 before
  const r = Quota.recentPace(q(), busy, NOW);
  assert.deepStrictEqual([r.perDay, r.projected, r.month, r.differs, r.over, r.days], [10, 255, 200, true, false, 7]);
  assert.strictEqual(Quota.recentPace(q({ used: 200 }), sessions(prompt(1, ['m'], 70)), NOW).over, true, 'over what is included');
  const same = Quota.recentPace(q(), sessions(prompt(1, ['m'], 45), prompt(5, ['m'], 45)), NOW); // 90 a week: 100 + 12.9 * 15.5 = 300? no: 90/7*15.5
  assert.strictEqual(same.projected, Math.round(100 + (90 / 7) * 15.5));
  const flat = Quota.recentPace(q(), sessions(prompt(2, ['m'], 6.5), prompt(5, ['m'], 6.5)), NOW); // 13/7 a day: 100 + 28.8, against 200
  assert.strictEqual(flat.differs, true);
  const close = Quota.recentPace(q({ used: 200 }), sessions(prompt(2, ['m'], 90), prompt(5, ['m'], 90)), NOW); // 180/7: 200 + 398 = 598 vs 400
  assert.strictEqual(close.differs, true);
  const alike = Quota.recentPace(q(), sessions(prompt(1, ['m'], 3.5), prompt(4, ['m'], 3.5), prompt(6, ['m'], 3.5)), NOW);
  assert.strictEqual(alike.projected, Math.round(100 + (10.5 / 7) * 15.5));
  assert.strictEqual(Quota.recentPace(q(), sessions(prompt(20, ['m'], 50)), NOW), null, 'nothing in the window');
  assert.strictEqual(Quota.recentPace(q({ unlimited: true }), busy, NOW), null);
  assert.strictEqual(Quota.recentPace(q({ stale: true }), busy, NOW), null);
});

test('the overview says what the budget buys and how the last week ran, and stays quiet without the data', () => {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'vscode') {
      return { EventEmitter: class { constructor() { this.event = () => {}; } fire() {} }, Uri: {}, ViewColumn: {}, StatusBarAlignment: {}, ThemeColor: class {},
        workspace: { getConfiguration: () => ({ get: (k, d) => d }) }, commands: { executeCommand() {} }, window: {} };
    }
    return load.call(this, request, ...rest);
  };
  const ext = require('../extension')._test;
  Module._load = load;
  const mk = (days, model, premium) => ({ ts: ago(days), models: [model], premium, text: 'p', usd: 1, calls: [], split: { known: false, in: 0, out: 0 }, tokensIn: 0, tokensOut: 0 });
  const prompts = [mk(0.2, 'claude-sonnet-5.5', 1), mk(1, 'claude-sonnet-5.5', 1), mk(2, 'claude-sonnet-5.5', 1), mk(1, 'claude-opus-5.5', 3), mk(3, 'claude-opus-5.5', 3), mk(4, 'claude-opus-5.5', 3), mk(5, 'gpt-5-mini', 0), mk(5, 'gpt-5-mini', 0), mk(6, 'gpt-5-mini', 0)];
  ext.load([{ id: 's1', source: 'copilot', title: 't', ts: ago(0.2), usd: 1, prompts, split: { known: false }, models: [], tokensIn: 0, tokensOut: 0 }]);
  const html = ext.quotaHtml(q({ used: 100 }), NOW);
  assert.match(html, /(Room left today|A weekday's budget) \(\d+(\.\d+)?\) buys about: \d+ on claude-sonnet-5\.5 <span class="note">\(1 a prompt, from your 3 prompts\)<\/span>/);
  assert.match(html, /\d+ on claude-opus-5\.5 <span class="note">\(3 a prompt/);
  assert.match(html, /unlimited on gpt-5-mini <span class="note">\(counts 0\)/);
  assert.match(html, /The last 7 days ran slower than the month: at 1\.7 a day the month ends at about 127, against 200/);
  assert.ok(!/Check a model/.test(html), 'real models named: no need to send you to /model');
  ext.load([]);
  const bare = ext.quotaHtml(q({ used: 100 }), NOW);
  assert.match(bare, /buys about: \d+ on a 0\.33x model[^]*a 1x model[^]*a 3x model[^]*Check a model's multiplier with \/model/);
  assert.ok(!/The last 7 days ran/.test(bare));
});
