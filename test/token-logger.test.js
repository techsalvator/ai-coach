// node --test test/*.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const EXT = path.join(__dirname, '..', 'extensions', 'ai-cost');
const load = () => import(pathToFileURL(path.join(EXT, 'record.mjs')).href); // a bare C: path is not a URL import() accepts

test('toRecord maps an assistant.usage event to the record the reports read', async () => {
  const { toRecord } = await load();
  const ev = { timestamp: '2026-10-01T10:00:00.000Z', agentId: 'ag1', data: { model: 'claude-sonnet-5.5', inputTokens: 1000, outputTokens: 50,
    cacheReadTokens: 800, cacheWriteTokens: 150, reasoningTokens: 10, duration: 2500,
    quotaSnapshots: { premium_interactions: { remainingPercentage: 7.4, resetDate: '2026-10-01' } } } };
  assert.deepStrictEqual(toRecord(ev, 'sess-1'), { ts: '2026-10-01T10:00:00.000Z', session: 'sess-1', agent: 'ag1', sub: true, model: 'claude-sonnet-5.5',
    input: 1000, output: 50, cacheRead: 800, cacheWrite: 150, reasoning: 10, ms: 2500, premiumLeftPct: 7.4, premiumResets: '2026-10-01' });
});

test('toRecord: a main-agent call, missing fields default, and non-model events are skipped', async () => {
  const { toRecord } = await load();
  const r = toRecord({ data: { model: 'gpt-6-sol', inputTokens: 5 } }, 's', () => 'NOW');
  assert.deepStrictEqual([r.ts, r.agent, r.sub, r.output, r.cacheRead, r.ms, r.premiumLeftPct], ['NOW', null, false, 0, 0, null, null]);
  assert.strictEqual(toRecord({ data: {} }, 's'), null);
  assert.strictEqual(toRecord(undefined, 's'), null);
  assert.strictEqual(toRecord({ data: { initiator: 'sub-agent', model: 'm', inputTokens: 1 } }, 's').sub, true);
});

test('logPath follows the same rules as lib/paths.js', async () => {
  const { logPath } = await load();
  assert.strictEqual(logPath({}, '/home/u'), path.join('/home/u', '.ai-cost-drilldown', 'copilot-tokens.jsonl'));
  assert.strictEqual(logPath({ AI_COST_HOME: '/data' }, '/home/u'), path.join('/data', 'copilot-tokens.jsonl'));
  assert.strictEqual(logPath({ AI_COST_TOKEN_LOG: '/x/log.jsonl', AI_COST_HOME: '/data' }, '/home/u'), '/x/log.jsonl');
  assert.strictEqual(logPath({ COPILOT_COST_HOME: '/old' }, '/home/u'), path.join('/old', 'copilot-tokens.jsonl'));
});

test('a record written by the logger is read back by the report code', async () => {
  const { toRecord } = await load();
  const { readTokenLog } = require('../lib/session-cost');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenlog-'));
  const file = path.join(dir, 'log.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(toRecord({ timestamp: '2026-10-01T10:00:00Z', data: { model: 'claude-haiku-4.5', inputTokens: 9, outputTokens: 1 } }, 'abc'))}\n`);
  const by = readTokenLog(file);
  assert.strictEqual(by.get('abc').length, 1);
  assert.strictEqual(by.get('abc')[0].input, 9);
});

test('the log reader counts a call once when two logs hold it', () => {
  const { readTokenLog } = require('../lib/session-cost');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenlog-'));
  const rec = { ts: '2026-10-01T10:00:00Z', session: 's1', model: 'm', input: 10, output: 2 };
  const a = path.join(dir, 'a.jsonl'); const b = path.join(dir, 'b.jsonl');
  fs.writeFileSync(a, `${JSON.stringify(rec)}\n${JSON.stringify({ ...rec, ts: '2026-10-01T10:00:05Z' })}\n`);
  fs.writeFileSync(b, `${JSON.stringify(rec)}\n`);
  assert.strictEqual(readTokenLog([a, b, path.join(dir, 'missing.jsonl')]).get('s1').length, 2);
});

test('the logger keeps each session\'s last main-agent call in its own file, which the hook reads', async () => {
  const { toRecord, writeLastCall, lastCallPath } = await load();
  const coach = require('../lib/coach');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lastcall-'));
  const env = { AI_COST_HOME: home };
  const rec = (input, over = {}) => toRecord({ timestamp: '2026-10-01T10:00:00Z', data: { model: 'claude-sonnet-5.5', inputTokens: input, outputTokens: 1 }, ...over }, 'sess-1');
  assert.strictEqual(lastCallPath('a/../b', env), path.join(home, 'last-call', 'a_.._b.json'), 'a session id is never a path');
  assert.strictEqual(writeLastCall(rec(1000), env), path.join(home, 'last-call', 'sess-1.json'));
  writeLastCall(rec(2000), env);
  assert.strictEqual(writeLastCall(rec(9, { agentId: 'sub1' }), env), null, 'a subagent\'s call is not the session\'s context');
  assert.strictEqual(writeLastCall(null, env), null);
  assert.strictEqual(coach.lastCall('sess-1', env).input, 2000, 'the newest main-agent call');
  assert.strictEqual(coach.lastCall('other', env), null);
  // a session idle for 30 days is cleared when another session makes its first call
  const old = path.join(home, 'last-call', 'old.json');
  fs.writeFileSync(old, '{}');
  fs.utimesSync(old, new Date('2026-08-01'), new Date('2026-08-01'));
  writeLastCall(toRecord({ data: { model: 'm', inputTokens: 5 } }, 'sess-2'), env, undefined, Date.parse('2026-10-01'));
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'last-call')).sort(), ['sess-1.json', 'sess-2.json']);
});
