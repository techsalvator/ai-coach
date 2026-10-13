// node --test test/session-cost.test.js
'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const { analyse } = require('../lib/session-cost');

const ev = (type, data, extra = {}) => JSON.stringify({ type, data, timestamp: '2026-09-25T10:00:00Z', ...extra });
const checkpoint = (credits, premium) => ev('session.usage_checkpoint', { totalNanoAiu: credits * 1e9, totalPremiumRequests: premium });

async function run(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-')), 'events.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return analyse(file);
}

test('each prompt costs the difference between checkpoints, the first from zero', async () => {
  const r = await run([
    ev('session.start', { startTime: '2026-09-25T09:00:00Z', context: { cwd: '/repo' } }),
    ev('user.message', { content: '/backlog FOPTS-1' }),
    checkpoint(10.5, 1),
    ev('user.message', { content: 'yes' }),
    checkpoint(14, 2),
  ]);
  assert.deepStrictEqual(r.prompts.map((p) => [p.prompt, p.credits, p.premium]), [['/backlog FOPTS-1', 10.5, 1], ['yes', 3.5, 1]]);
  assert.strictEqual(r.totals.credits, 14);
  assert.strictEqual(r.start.cwd, '/repo');
});

test('subagent prompts and system notifications are not user prompts', async () => {
  const r = await run([
    ev('user.message', { content: 'design it' }),
    ev('user.message', { content: 'You are the design synthesizer…' }, { agentId: 'sub-1' }),
    ev('user.message', { content: '<system_notification>IDE back</system_notification>', source: 'system' }),
    checkpoint(5, 1),
  ]);
  assert.strictEqual(r.prompts.length, 1);
  assert.strictEqual(r.prompts[0].credits, 5);
});

test('counts main-agent tools and models, and subagent tokens, per prompt', async () => {
  const r = await run([
    ev('user.message', { content: 'review' }),
    ev('assistant.message', { model: 'claude-sonnet-5' }),
    ev('tool.execution_start', { toolName: 'bash' }),
    ev('tool.execution_start', { toolName: 'view' }, { agentId: 'sub-1' }), // the subagent's own
    ev('assistant.message', { model: 'gpt-5.6-luna' }, { agentId: 'sub-1' }),
    ev('subagent.completed', { agentName: 'pr-review-reviewer', model: 'gpt-5.6-luna', totalTokens: 1200, durationMs: 3000 }),
    ev('session.compaction_complete', {}),
    checkpoint(7, 1),
  ]);
  const p = r.prompts[0];
  assert.deepStrictEqual([...p.models], ['claude-sonnet-5']);
  assert.strictEqual(p.toolCalls, 1);
  assert.deepStrictEqual(p.subagents.map((s) => [s.agent, s.tokens]), [['pr-review-reviewer', 1200]]);
  assert.strictEqual(p.compactions, 1);
});

test('usage between prompts is kept as unattributed, so the parts add up to the total', async () => {
  const r = await run([
    ev('user.message', { content: 'a' }),
    checkpoint(4, 1),
    checkpoint(6, 1), // background work after the reply
    ev('user.message', { content: 'b' }),
    checkpoint(9, 2),
  ]);
  const sum = r.prompts.reduce((a, p) => a + p.credits, 0) + r.unattributed;
  assert.strictEqual(r.unattributed, 2);
  assert.strictEqual(sum, r.totals.credits);
});

test('a shutdown closes an open prompt, so later prompts are not folded into it', async () => {
  const r = await run([
    ev('user.message', { content: 'a' }),
    ev('session.shutdown', { totalNanoAiu: 3e9, totalPremiumRequests: 1 }),
    ev('session.resume', { context: { cwd: '/other' } }),
    ev('user.message', { content: 'b' }),
    checkpoint(5, 2),
  ]);
  assert.deepStrictEqual(r.prompts.map((p) => [p.prompt, p.credits, p.cwd]), [['a', 3, null], ['b', 2, '/other']]);
});

test('totals that restart on resume count the new run from zero', async () => {
  const r = await run([
    ev('user.message', { content: 'a' }),
    ev('session.shutdown', { totalNanoAiu: 67e9, totalPremiumRequests: 1 }),
    ev('session.resume', {}),
    ev('user.message', { content: 'b' }),
    ev('session.shutdown', { totalNanoAiu: 40e9, totalPremiumRequests: 1 }),
  ]);
  assert.deepStrictEqual(r.prompts.map((p) => p.credits), [67, 40]);
  assert.deepStrictEqual(r.totals, { credits: 107, premium: 2 });
});

test('run time ends at the last turn, not at a checkpoint written later', async () => {
  const r = await run([
    ev('user.message', { content: 'a' }, { timestamp: '2026-09-25T10:00:00Z' }),
    ev('assistant.turn_end', {}, { timestamp: '2026-09-25T10:00:30Z' }),
    ev('session.usage_checkpoint', { totalNanoAiu: 1e9, totalPremiumRequests: 1 }, { timestamp: '2026-09-27T10:00:00Z' }),
  ]);
  assert.strictEqual(r.prompts[0].end, '2026-09-25T10:00:30Z');
});

test('prompts carry the folder, repository and branch they ran in', async () => {
  const r = await run([
    ev('session.start', { context: { cwd: '/home' } }),
    ev('session.context_changed', { cwd: '/repo', repository: 'flexera/x', branch: 'main' }),
    ev('user.message', { content: 'a' }),
    checkpoint(1, 1),
  ]);
  assert.deepStrictEqual([r.prompts[0].cwd, r.prompts[0].repository, r.prompts[0].branch], ['/repo', 'flexera/x', 'main']);
});

test('skill context Copilot injects is not a user prompt', async () => {
  const r = await run([
    ev('user.message', { content: 'run the epic' }),
    ev('user.message', { content: '<skill-context name="epic">…', source: 'skill-epic' }),
    checkpoint(2, 1),
  ]);
  assert.deepStrictEqual(r.prompts.map((p) => p.prompt), ['run the epic']);
});

test('active time sums the agent turns; wall time also covers waiting at a gate', async () => {
  const at = (t) => ({ timestamp: `2026-09-25T${t}Z` });
  const r = await run([
    ev('user.message', { content: 'a' }, at('10:00:00')),
    ev('assistant.turn_start', {}, at('10:00:00')),
    ev('assistant.turn_end', {}, at('10:00:20')),
    ev('assistant.turn_start', {}, at('11:00:00')),
    ev('tool.execution_start', { toolName: 'ask_user', toolCallId: 'q1' }, at('11:00:05')),
    ev('tool.execution_complete', { toolCallId: 'q1' }, at('11:59:55')), // waiting for your answer
    ev('assistant.turn_end', {}, at('12:00:10')),
    ev('session.usage_checkpoint', { totalNanoAiu: 1e9, totalPremiumRequests: 1 }, at('12:00:11')),
  ]);
  assert.strictEqual(r.prompts[0].activeMs, 20000 + 60 * 60 * 1000 + 10000 - 59 * 60 * 1000 - 50000); // 20s + 1h10s - 59m50s
  assert.strictEqual(r.prompts[0].end, '2026-09-25T12:00:10Z');
});

test('up time: runs open at start/resume and close at shutdown, or at the last event', async () => {
  const at = (t) => ({ timestamp: `2026-09-25T${t}Z` });
  const r = await run([
    ev('session.start', {}, at('10:00:00')),
    ev('session.shutdown', {}, at('10:30:00')),            // run 1: 30m
    ev('session.resume', {}, at('11:00:00')),
    ev('user.message', { content: 'a' }, at('11:05:00')),  // run 2 crashes: ends at its last event
    ev('session.resume', {}, at('12:00:00')),
    ev('assistant.turn_end', {}, at('12:10:00')),          // run 3 still open: ends at its last event
  ]);
  assert.deepStrictEqual(r.runs, [
    ['2026-09-25T10:00:00Z', '2026-09-25T10:30:00Z'],
    ['2026-09-25T11:00:00Z', '2026-09-25T11:05:00Z'],
    ['2026-09-25T12:00:00Z', '2026-09-25T12:10:00Z'],
  ]);
});

test('a prompt still running has no cost yet, and garbage lines are skipped', async () => {
  const r = await run([
    '{not json',
    ev('user.message', { content: 'a' }),
    checkpoint(1, 1),
    ev('user.message', { content: 'still going' }),
  ]);
  assert.strictEqual(r.prompts[1].credits, null);
});

test('history estimate: each run\'s token increase is split over its prompts by credits', async () => {
  const mm = (input, output) => ({ 'claude-sonnet-5': { usage: { inputTokens: input, outputTokens: output } } });
  const r = await run([
    ev('user.message', { content: 'a' }),
    checkpoint(3, 1),
    ev('user.message', { content: 'b' }),
    checkpoint(4, 2),                                                        // a: 3 credits, b: 1
    ev('session.shutdown', { totalNanoAiu: 4e9, totalPremiumRequests: 2, modelMetrics: mm(1000, 40) }),
    ev('session.resume', {}),
    ev('user.message', { content: 'c' }),
    ev('session.shutdown', { totalNanoAiu: 6e9, totalPremiumRequests: 3, modelMetrics: mm(1500, 50) }),
  ]);
  assert.deepStrictEqual(r.prompts.map((p) => p.tokensEst && [p.tokensEst.input, p.tokensEst.output]),
    [[750, 30], [250, 10], [500, 10]]);
});

test('live tokens join the prompt that was running, and win over the estimate', () => {
  const { attachLiveTokens, tokensOf, fmtTokens } = require('../lib/session-cost');
  const prompts = [
    { ts: '2026-09-26T10:00:00Z', tokensEst: { input: 9, output: 9 } },
    { ts: '2026-09-26T11:00:00Z' },
  ];
  attachLiveTokens(prompts, [
    { ts: '2026-09-26T09:59:00Z', input: 999, output: 9 },                  // before any prompt: ignored
    { ts: '2026-09-26T10:00:05Z', input: 100, output: 5, cacheRead: 80, sub: false },
    { ts: '2026-09-26T10:00:09Z', input: 40, output: 2, sub: true },
    { ts: '2026-09-26T11:00:01Z', input: 7, output: 1 },
  ]);
  const a = tokensOf(prompts[0]);
  assert.deepStrictEqual([a.source, a.input, a.output, a.mainInput, a.calls], ['live', 140, 7, 100, 2]);
  assert.strictEqual(fmtTokens(tokensOf(prompts[1])), '7 / 1');
  assert.strictEqual(fmtTokens({ input: 22100000, output: 73000, source: 'estimate' }), '~22.1M / ~73k');
});

test('the live token log is read per session; bad lines are skipped', () => {
  const { readTokenLog, latestQuota } = require('../lib/session-cost');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-')), 'copilot-tokens.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ ts: '2026-09-26T10:00:02Z', session: 's1', input: 1, premiumLeftPct: 20, premiumResets: '2026-10-01' }),
    'not json',
    JSON.stringify({ ts: '2026-09-26T10:00:01Z', session: 's1', input: 2, premiumLeftPct: 21 }),
    JSON.stringify({ ts: '2026-09-26T10:00:03Z', session: 's2', input: 3 }),
  ].join('\n'));
  const bySession = readTokenLog(file);
  assert.deepStrictEqual(bySession.get('s1').map((r) => r.input), [2, 1]);   // sorted by time
  assert.deepStrictEqual(latestQuota(bySession), { leftPct: 20, resets: '2026-10-01', ts: '2026-09-26T10:00:02Z' });
});

test('cache breaks: a model switch between prompts, or an idle gap past the cache lifetime', async () => {
  const at = (t) => ({ timestamp: `2026-09-26T${t}Z` });
  const msg = (model, t) => ev('assistant.message', { model }, at(t));
  const turn = (t) => ev('assistant.turn_end', {}, at(t));
  const cp = (credits, t, ttl) => ev('session.usage_checkpoint', { totalNanoAiu: credits * 1e9, totalPremiumRequests: credits,
    modelCacheState: [{ modelId: 'claude-sonnet-5.5', cacheTtlSeconds: ttl }] }, at(t));
  const r = await run([
    ev('user.message', { content: 'a' }, at('10:00:00')), msg('gpt-6-luna', '10:00:05'), turn('10:00:06'), cp(1, '10:00:07', 300),
    ev('user.message', { content: 'b' }, at('10:01:00')), msg('claude-sonnet-5.5', '10:01:05'), turn('10:01:06'), cp(3, '10:01:07', 300),
    ev('user.message', { content: 'c' }, at('10:02:00')), msg('claude-sonnet-5.5', '10:02:05'), turn('10:02:06'), cp(4, '10:02:07', 300),
    ev('user.message', { content: 'd' }, at('10:20:00')), msg('claude-sonnet-5.5', '10:20:05'), turn('10:20:06'), cp(6, '10:20:07', 300),
  ]);
  assert.deepStrictEqual(r.prompts.map((p) => (p.cacheBreak ? p.cacheBreak.kind : null)), [null, 'switch', null, 'idle']);
  assert.deepStrictEqual(r.prompts[1].cacheBreak, { kind: 'switch', from: 'gpt-6-luna', to: 'claude-sonnet-5.5' });
  assert.strictEqual(r.prompts[3].cacheBreak.ttlSeconds, 300);
  const { cacheBreakStats } = require('../lib/session-cost');
  const s = cacheBreakStats(r.prompts);
  assert.deepStrictEqual([s.switches, s.idle, s.n], [1, 1, 4]);
});

test('a break is marked with the uncached tokens its first call re-read, when captured live', () => {
  const { attachLiveTokens, breakMark } = require('../lib/session-cost');
  const p = { ts: '2026-09-26T10:00:00Z', cacheBreak: { kind: 'switch' } };
  attachLiveTokens([p], [
    { ts: '2026-09-26T10:00:01Z', input: 210000, cacheRead: 5000, sub: false },
    { ts: '2026-09-26T10:00:02Z', input: 212000, cacheRead: 209000, sub: false },
  ]);
  assert.strictEqual(breakMark(p), ' ⇄ 205k');
  assert.strictEqual(breakMark({ cacheBreak: { kind: 'idle' } }), ' ⏲');
  assert.strictEqual(breakMark({}), '');
});

test('per-prompt tool log: main and named subagent calls, with result size and failures', async () => {
  const at = (t) => ({ timestamp: `2026-09-26T${t}Z` });
  const r = await run([
    ev('user.message', { content: 'groom it' }, at('10:00:00')),
    ev('tool.execution_start', { toolCallId: 't1', toolName: 'bash', arguments: { command: 'cd /repo && git status' } }, at('10:00:01')),
    ev('tool.execution_complete', { toolCallId: 't1', success: true, result: { content: 'x'.repeat(400) } }, at('10:00:03')),
    ev('subagent.selected', { agentName: 'backlog-groomer' }, { agentId: 'a1', ...at('10:00:04') }),
    ev('tool.execution_start', { toolCallId: 't2', toolName: 'view', arguments: { path: '/repo/a.go' } }, { agentId: 'a1', ...at('10:00:05') }),
    ev('tool.execution_complete', { toolCallId: 't2', success: false, result: { content: 'nope' } }, { agentId: 'a1', ...at('10:00:06') }),
    checkpoint(2, 1),
  ]);
  const log = r.prompts[0].toolLog;
  assert.deepStrictEqual(log.map((t) => [t.where, t.name, t.detail, t.resultChars, t.error]),
    [['main', 'bash', 'git status', 400, false], ['backlog-groomer', 'view', '/repo/a.go', 4, true]]);
});

test('token split of a prompt: by who and model, cache read/write/fresh, subagents named', () => {
  const { attachLiveTokens } = require('../lib/session-cost');
  const p = { ts: '2026-09-26T10:00:00Z', toolLog: [], models: new Set(['claude-sonnet-5.5']), activeMs: 0 };
  attachLiveTokens([p], [
    { ts: '2026-09-26T10:00:01Z', model: 'claude-sonnet-5.5', sub: false, input: 1000, cacheRead: 900, cacheWrite: 90, output: 50, reasoning: 5 },
    { ts: '2026-09-26T10:00:02Z', model: 'claude-opus-5.5', sub: true, agent: 'a1', input: 400, cacheRead: 0, cacheWrite: 396, output: 80 },
  ]);
  const { promptReportForTest } = require('../lib/session-cost');
  const text = promptReportForTest(p, new Map([['a1', 'design-synthesizer']]));
  assert.match(text, /2 model calls read \*\*1,400 input tokens\*\*: 900 \(64%\) re-read from cache, 486 \(35%\) written to cache, 14 \(1%\) fresh/);
  assert.match(text, /\| main agent \| claude-sonnet-5.5 \| 1 \| 1,000 \|/);
  assert.match(text, /\| design-synthesizer \| claude-opus-5.5 \| 1 \| 400 \|/);
});

test('list-price cost of live calls matches credits at $0.01 per credit', () => {
  const { callUsd, creditsUsd, promptReportForTest } = require('../lib/session-cost');
  // Sonnet 5.5: input 2, cached 0.2, write 2.5, output 10 ($ per 1M tokens).
  const r = { model: 'claude-sonnet-5.5', input: 1_100_000, cacheRead: 1_000_000, cacheWrite: 50_000, output: 20_000 };
  // fresh 50k*2 + read 1M*0.2 + write 50k*2.5 + out 20k*10 = 0.1 + 0.2 + 0.125 + 0.2
  assert.strictEqual(callUsd(r).toFixed(3), '0.625');
  assert.strictEqual(callUsd({ ...r, model: 'no-such-model' }), null);
  assert.strictEqual(creditsUsd(62.5), '$0.63');
  const text = promptReportForTest({ credits: 62.5, liveCalls: [{ ...r, agent: null, sub: false }] }, {});
  assert.match(text, /62\.50 credits = \$0\.63\*\* charged/);
  assert.match(text, /come to \*\*\$0\.63\*\*/);
  assert.match(text, /\| \$0\.63 \| 100% \|/);
});

test('joinCalls pairs each model call with its message and what grew its input', () => {
  const { joinCalls } = require('../lib/session-cost');
  const p = {
    ts: '2026-09-30T10:00:00.000Z',
    liveCalls: [
      { ts: '2026-09-30T10:00:05.000Z', sub: false, agent: null, model: 'claude-sonnet-5.5', input: 100000, cacheRead: 99000, cacheWrite: 1000, output: 300 },
      { ts: '2026-09-30T10:00:09.000Z', sub: true, agent: 'a1', model: 'claude-haiku-4.5', input: 5000, cacheRead: 0, cacheWrite: 5000, output: 800 },
      { ts: '2026-09-30T10:00:20.000Z', sub: false, agent: null, model: 'claude-sonnet-5.5', input: 104000, cacheRead: 100000, cacheWrite: 4000, output: 50 },
    ],
    msgLog: [
      { ts: '2026-09-30T10:00:05.010Z', agent: null, model: 'claude-sonnet-5.5', requests: [{ id: 't1', name: 'task', detail: 'plan-reader' }], replyChars: 0, reply: '', reasoning: 'delegate' },
      { ts: '2026-09-30T10:00:09.010Z', agent: 'a1', model: 'claude-haiku-4.5', requests: [], replyChars: 3200, reply: 'summary', reasoning: '' },
      { ts: '2026-09-30T10:00:20.010Z', agent: null, model: 'claude-sonnet-5.5', requests: [], replyChars: 40, reply: 'done', reasoning: '' },
    ],
    toolLog: [{ id: 't1', name: 'task', detail: 'plan-reader', resultChars: 14000, error: false }],
    compactAt: [],
  };
  const cs = joinCalls(p, new Map([['a1', 'design-plan-reader']]));
  assert.strictEqual(cs.length, 3);
  assert.strictEqual(cs[1].who, 'design-plan-reader');
  assert.strictEqual(cs[1].prev, null);
  assert.strictEqual(cs[2].prev, cs[0]);
  assert.strictEqual(cs[2].added, 4000);
  assert.deepStrictEqual(cs[2].fed.map((f) => [f.name, f.tokens]), [['task', 3500]]);
  assert.strictEqual(cs[2].msg.reply, 'done');
});
