'use strict';
// The rename from ai-cost-drilldown to ai-cost-coach must not strand anyone's existing files or hooks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultHome } = require('../lib/paths');
const hookFile = require('../bin/vscode-hook');
const { INVOKED, RAW } = require('../bin/cost');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rename-'));

test('the data folder is ~/.ai-cost-coach, but an existing ~/.ai-cost-drilldown keeps being used', () => {
  const fresh = tmp();
  assert.strictEqual(defaultHome(fresh), path.join(fresh, '.ai-cost-coach'));
  const old = tmp();
  fs.mkdirSync(path.join(old, '.ai-cost-drilldown'));
  assert.strictEqual(defaultHome(old), path.join(old, '.ai-cost-drilldown'));
  const both = tmp();
  fs.mkdirSync(path.join(both, '.ai-cost-drilldown'));
  fs.mkdirSync(path.join(both, '.ai-cost-coach'));
  assert.strictEqual(defaultHome(both), path.join(both, '.ai-cost-coach'));
});

test('writing the chat hook removes the earlier-named hook file, so a prompt is not answered twice', () => {
  const home = tmp();
  const hooks = path.join(home, '.copilot', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'ai-cost-drilldown.json'), '{}');
  const root = path.resolve(__dirname, '..');
  assert.strictEqual(hookFile.apply({ root, home }).status, 'written');
  assert.deepStrictEqual(fs.readdirSync(hooks), ['ai-cost-coach.json']);
});

test('uninstalling the chat hook removes either name', () => {
  const home = tmp();
  const hooks = path.join(home, '.copilot', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'ai-cost-drilldown.json'), '{}');
  assert.strictEqual(hookFile.apply({ home, remove: true }).status, 'removed');
  assert.deepStrictEqual(fs.readdirSync(hooks), []);
});

test('/cost is recognised under the plugin\'s current and earlier names', () => {
  for (const n of ['ai-cost-coach', 'ai-cost-drilldown']) {
    assert.ok(INVOKED.test(`The user explicitly invoked the "/${n}:cost" skill. Go.`), n);
    assert.ok(RAW.test(`/${n}:cost prompts`), n);
  }
});
