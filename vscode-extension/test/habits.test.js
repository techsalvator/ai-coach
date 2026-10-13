'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');
const { habits } = require('../habits');

const NOW = Date.parse('2026-10-10T12:00:00Z');
const ago = (days) => new Date(NOW - days * 86400000).toISOString();
const known = { known: true };
const call = (tokensIn) => ({ tokensIn, tokensOut: 100 });
const prompt = (o = {}) => ({ ts: ago(1), usd: 1, calls: [call(20000)], split: known, compactions: 0, ...o });
const session = (o = {}) => ({ source: 'copilot', cwd: null, split: known, prompts: [prompt()], ...o });
const run = (sessions, o = {}) => habits(sessions, { exists: () => false, now: NOW, ...o });
const find = (list, id) => list.find((f) => f.id === id);

test('quiet when the tools are in use, or there is nothing to judge', () => {
  assert.deepStrictEqual(run([]), []);
  assert.deepStrictEqual(run([session()], { tracking: true, coach: true }), []);
});

test('/compact: long Copilot CLI sessions that were never compacted are counted, by size or by prompt count', () => {
  const big = session({ prompts: [prompt(), prompt({ usd: 9, calls: [call(200000)] })] });
  const compacted = session({ prompts: [prompt({ calls: [call(200000)], compactions: 1 }), prompt()] });
  const many = session({ split: { known: false }, prompts: Array.from({ length: 21 }, () => prompt({ split: { known: false }, calls: [] })) });
  const short = session();
  const claude = session({ source: 'claude', prompts: [prompt({ calls: [call(400000)] })] });
  const f = find(run([short, big, compacted, many, claude]), 'no-compact');
  assert.strictEqual(f.status, '1 of 3 compacted');
  assert.match(f.detail, /^3 Copilot CLI sessions grew long[^]*2 of them were never compacted[^]*those 2 sessions \(\$31\.00\)/);
  assert.deepStrictEqual(f.targets, [[3, 0], [1, 1]], 'the dearest prompt of each, the dearest session first');
  assert.deepStrictEqual([f.habit, f.saving], [true, 0], 'no saving of its own: the measured findings carry it');
  assert.strictEqual(find(run([short, compacted, claude]), 'no-compact'), undefined, 'Claude Code logs no compaction, so it is not judged');
  assert.match(find(run([big]), 'no-compact').detail, /^1 Copilot CLI session grew long[^]*none of them was compacted/);
});

test('instructions file: a folder worked in three times without one is named; one that has it, is gone, or is new is not', () => {
  const at = (cwd, o = {}) => session({ cwd, ...o });
  const repo = path.resolve('/work/billing');
  const sessions = [at(repo), at(repo, { prompts: [prompt({ usd: 5 })] }), at(repo), at('/work/docs'), at('/work/docs'), at('/work/docs'), at('/work/new'), at('/work/gone'), at('/work/gone'), at('/work/gone')];
  const has = (...files) => (f) => files.map((x) => path.resolve(x)).includes(path.resolve(f));
  const f = find(run(sessions, { exists: has('/work/billing', '/work/docs', '/work/docs/AGENTS.md', '/work/new') }), 'no-instructions');
  assert.strictEqual(f.status, '1 folder');
  assert.match(f.detail, /^3 sessions ran in 1 folder that has no instructions file: billing \(3 sessions, \$7\.00\)\./);
  assert.match(f.action, /^Add \.github\/copilot-instructions\.md or AGENTS\.md /);
  assert.deepStrictEqual(f.targets[0], [1, 0], 'the first prompt of the dearest session there');
  assert.strictEqual(find(run(sessions, { exists: has('/work/billing', '/work/billing/.github/copilot-instructions.md') }), 'no-instructions'), undefined);
});

test('instructions file: each tool is checked for the file it reads', () => {
  const repo = path.resolve('/work/api');
  const three = (source) => [1, 2, 3].map(() => session({ source, cwd: repo }));
  const has = (...files) => (f) => [repo, ...files.map((x) => path.join(repo, x))].includes(path.resolve(f));
  assert.match(find(run(three('claude'), { exists: has('.github/copilot-instructions.md') }), 'no-instructions').action, /^Add CLAUDE\.md /);
  assert.strictEqual(find(run(three('claude'), { exists: has('CLAUDE.md') }), 'no-instructions'), undefined);
  assert.ok(find(run(three('vscode'), { exists: has('CLAUDE.md') }), 'no-instructions'), 'CLAUDE.md is not what Copilot reads');
  // VS Code chat and Copilot CLI in one folder are one tool's worth of sessions
  const mixed = [session({ cwd: repo }), session({ source: 'vscode', cwd: repo }), session({ cwd: repo })];
  assert.strictEqual(find(run(mixed, { exists: has() }), 'no-instructions').status, '1 folder');
});

test('token data: recent Copilot CLI prompts without it are reported, and the fix depends on whether tracking is on', () => {
  const blind = (days) => prompt({ ts: ago(days), split: { known: false }, calls: [] });
  const s = [session({ prompts: [blind(1), blind(2), blind(3), prompt(), prompt(), prompt({ ts: ago(20), split: { known: false } })] })];
  const off = find(run(s, { tracking: false }), 'no-token-data');
  assert.deepStrictEqual([off.title, off.status], ['Copilot tracking is off', '3 of 5 prompts']);
  assert.match(off.action, /^Tick Copilot tracking in the Coach panel/);
  const on = find(run(s, { tracking: true }), 'no-token-data');
  assert.strictEqual(on.title, 'The token logger is not recording');
  assert.match(on.action, /\/experimental on/);
  assert.strictEqual(find(run([session({ prompts: [blind(1), ...Array.from({ length: 9 }, () => prompt())] })], { tracking: true }), 'no-token-data'), undefined, 'one prompt in ten is not a habit');
  assert.strictEqual(find(run([session({ prompts: [blind(1), blind(1)] })], { tracking: false }), 'no-token-data'), undefined, 'too few prompts to say');
  assert.strictEqual(find(run([session({ source: 'vscode', prompts: Array.from({ length: 6 }, () => blind(1)) })], { tracking: false }), 'no-token-data'), undefined, 'VS Code chat never has per-call tokens');
});

test('coach off: said only when it is known to be off and Copilot is in use', () => {
  const busy = [session({ prompts: Array.from({ length: 6 }, () => prompt()) })];
  assert.strictEqual(find(run(busy, { coach: false }), 'coach-off').status, '6 prompts unchecked');
  assert.strictEqual(find(run(busy, { coach: true }), 'coach-off'), undefined);
  assert.strictEqual(find(run(busy, {}), 'coach-off'), undefined, 'not known: nothing said');
  assert.strictEqual(find(run([session({ source: 'claude', prompts: busy[0].prompts })], { coach: false }), 'coach-off'), undefined, 'the coach acts on Copilot only');
});

test('in the extension the unused tools follow the measured findings, with their own page text', () => {
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
  ext.load([{ ...session({ id: 's1', ts: ago(1), usd: 10, prompts: [prompt({ usd: 10, text: 'p', calls: [{ ...call(600000), model: 'claude-sonnet-5.5', usd: 10, fresh: 0, cacheRead: 600000, cacheWrite: 0 }] })] }) }]);
  const ids = ext.advice.findings.map((f) => f.id);
  assert.ok(ids.indexOf('long-context') >= 0 && ids.indexOf('no-compact') > ids.indexOf('long-context'), ids.join());
  const html = ext.adviceHtml(ids.indexOf('no-compact'));
  assert.match(html, /\/compact was not used in long sessions/);
  assert.match(html, /claims no saving of its own/);
  assert.ok(!/Estimated saving/.test(html));
});
