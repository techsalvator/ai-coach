'use strict';
// When the model guard speaks: once each time it turns on, not on every refresh, and again the next time it turns on.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guardnotice-'));
process.env.AI_COST_HOME = path.join(root, 'data');
process.env.COPILOT_HOME = path.join(root, 'copilot');
for (const k of ['AI_COST_COACH', 'AI_COST_COACH_STRICT', 'AI_COST_COACH_REWRITE', 'AI_COST_MODEL_GUARD']) delete process.env[k];

const shown = [];
const opened = [];
let click = 'Not now'; // the button the user presses on the next notice
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    return { EventEmitter: class { constructor() { this.event = () => {}; } fire() {} }, Uri: {}, ViewColumn: {}, StatusBarAlignment: {}, ThemeColor: class {},
      workspace: { getConfiguration: () => ({ get: (k, d) => d }) },
      commands: { executeCommand(...a) { opened.push(a); } },
      window: { showWarningMessage(...a) { shown.push(a); return Promise.resolve(click); } } };
  }
  return load.call(this, request, ...rest);
};
const ext = require('../extension')._test;
const G = require('../modelguard');

const DAY = 86400000;
const NOW = Date.now();
let writes = 0;
const snapshot = (used, resets) => {
  const dir = path.join(process.env.COPILOT_HOME, 'session-state', 's1');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, `{"quotaSnapshots":{"premium_interactions":${JSON.stringify({ isUnlimitedEntitlement: false, entitlementRequests: 300, usedRequests: used, overage: 0, remainingPercentage: 100 - used / 3, resetDate: new Date(resets).toISOString() })}}}\n`);
  // The quota reader caches by size and mtime. Two snapshots of the same size written within one clock tick (Windows'
  // coarse mtime) would look unchanged, so every write gets its own mtime.
  const t = new Date(Date.now() + ++writes * 2000);
  fs.utimesSync(file, t, t);
};
/** Sessions whose last 7 days used `week` premium requests, spread over two prompts. */
const sessions = (week) => [{ id: 's1', source: 'copilot', title: 't', ts: new Date(NOW - DAY).toISOString(), usd: 1, split: { known: false }, models: [], tokensIn: 0, tokensOut: 0,
  prompts: [1, 4].map((d) => ({ ts: new Date(NOW - d * DAY).toISOString(), models: ['claude-opus-5.5'], premium: week / 2, text: 'p', usd: 1, calls: [], split: { known: false, in: 0, out: 0 }, tokensIn: 0, tokensOut: 0 })) }];
const hot = (resets = NOW + 16 * DAY) => { snapshot(250, resets); ext.load(sessions(100)); };   // 250 + 100/7 * 16: well over 300
const calm = (resets = NOW + 16 * DAY) => { snapshot(60, resets); ext.load(sessions(7)); };     // 60 + 16: well under

test('it speaks when it turns on, once, however often it refreshes', () => {
  calm();
  assert.strictEqual(ext.guardTick(NOW), null);
  assert.strictEqual(shown.length, 0, 'nothing while the month is fine');
  hot();
  const g = ext.guardTick(NOW);
  assert.strictEqual(g.active, true);
  assert.strictEqual(shown.length, 1);
  assert.match(shown[0][0], /^This month is on pace for about \d+ premium requests, over the 300 included\./);
  assert.deepStrictEqual(shown[0].slice(1), ['Open model picker', 'Not now']);
  for (let i = 1; i <= 5; i++) ext.guardTick(NOW + i * 60e3);
  assert.strictEqual(shown.length, 1, 'a refresh a minute for five minutes: still the one notice');
  assert.strictEqual(ext.guard.active, true, 'and the status bar keeps showing it');
});

test('its button opens the model picker, and "Not now" does nothing', async () => {
  const flush = () => new Promise((r) => setImmediate(r));
  const cycle = async (button, min) => { // off, then on: one notice
    shown.length = 0; opened.length = 0; click = button;
    calm(); ext.guardTick(NOW + min * 60e3);
    hot(); ext.guardTick(NOW + (min + 1) * 60e3);
    await flush();
    assert.strictEqual(shown.length, 1);
  };
  await cycle('Not now', 10);
  assert.deepStrictEqual(opened, [], 'nothing was run');
  await cycle('Open model picker', 12);
  assert.deepStrictEqual(opened, [['workbench.action.chat.openModelPicker']]);
  click = undefined; // the notice dismissed
  await cycle(undefined, 14);
  assert.deepStrictEqual(opened, []);
});

test('it speaks again the next time it turns on, after it has turned off', () => {
  shown.length = 0;
  calm(); assert.strictEqual(ext.guardTick(NOW + 20 * 60e3), null);
  assert.strictEqual(JSON.parse(fs.readFileSync(G.stateFile(), 'utf8')).active, false, 'turned off, and remembered as off');
  hot();
  assert.strictEqual(ext.guardTick(NOW + 21 * 60e3).active, true);
  assert.strictEqual(shown.length, 1, 'a second activation is a second notice');
  ext.guardTick(NOW + 22 * 60e3);
  assert.strictEqual(shown.length, 1);
});

test('a new billing period that is also over speaks again', () => {
  shown.length = 0;
  hot(NOW + 16 * DAY); ext.guardTick(NOW + 30 * 60e3);
  const before = shown.length;
  hot(NOW + 46 * DAY); // the reset date moved on: a new period, and it is on pace to run out again
  ext.guardTick(NOW + 31 * 60e3);
  assert.strictEqual(shown.length, before + 1);
});

test('switched off, it neither speaks nor leaves state behind', () => {
  shown.length = 0;
  fs.rmSync(G.stateFile(), { force: true });
  fs.mkdirSync(process.env.AI_COST_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.AI_COST_HOME, 'config.json'), JSON.stringify({ modelGuard: false }));
  hot();
  assert.strictEqual(ext.guardTick(NOW + 40 * 60e3), null);
  assert.deepStrictEqual([shown.length, fs.existsSync(G.stateFile())], [0, false]);
});
