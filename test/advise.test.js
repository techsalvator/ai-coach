// node --test test/*.test.js
const assert = require('node:assert');
const { test } = require('node:test');
const { evaluate, format, run } = require('../lib/advise');

const T0 = Date.parse('2026-09-30T10:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const row = (session, i, credits, extra = {}) => ({ session, ts: at(i * 3), prompt: `prompt ${i} with several words here`, credits, seconds: 30, models: ['claude-sonnet-5.5'], cacheBreak: null, ...extra });
const rec = (o) => ({ model: 'claude-sonnet-5.5', sub: false, input: 150000, cacheRead: 148000, cacheWrite: 2000, output: 400, ...o });
const call = (o = {}, extra = {}) => ({ session: 'L', sub: false, who: 'main agent', model: o.model || 'claude-sonnet-5.5', rec: rec(o), miss: false, idle: null, ...extra });

test('long sessions: flags big contexts and the sessions holding the credits', () => {
  const rows = [...Array.from({ length: 25 }, (_, i) => row('LLLLLLLL', i, 50)), ...Array.from({ length: 3 }, (_, i) => row('SSSSSSSS', 100 + i, 5))];
  const calls = Array.from({ length: 20 }, () => call());
  const { findings } = evaluate(rows, calls);
  const f = findings.find((x) => x.id === 'long-sessions');
  assert.ok(f, 'finding present');
  assert.ok(f.evidence.some((e) => /1 session with 21\+ prompts holds 99%/.test(e)));
  assert.ok(f.evidence.some((e) => /20 of 20 main-agent calls carried over 60k/.test(e)));
  assert.ok(f.savingUsd > 0 && f.savingShare > 0.3);
});

test('cache breaks: an idle expiry after a 10 min gap would be covered by a 30-min cache', () => {
  const warm = Array.from({ length: 10 }, (_, i) => row('A', i, 10));
  const rows = [...warm, { ...row('A', 14, 100), ts: at(40), cacheBreak: { kind: 'idle', uncached: 120000 } }];
  const { findings } = evaluate(rows, []);
  const f = findings.find((x) => x.id === 'cache-breaks');
  assert.ok(f);
  assert.ok(f.evidence.some((e) => /1 of 11 prompts started after a cache break \(1 idle expiries, 0 model switches\)/.test(e)));
  assert.ok(f.evidence.some((e) => /1 idle expiries came after a 5–30 min gap/.test(e)));
  assert.strictEqual(Math.round(f.savingCredits), 90);
});

test('short replies: confirmations are counted, commands are not', () => {
  const rows = [row('A', 0, 30, { prompt: 'yes' }), row('A', 1, 30, { prompt: 'accept it' }), row('A', 2, 30, { prompt: '/design FOPTS-1' }), row('A', 3, 30, { prompt: 'a longer prompt with many words' })];
  const f = evaluate(rows, []).findings.find((x) => x.id === 'short-replies');
  assert.ok(f.evidence[0].startsWith('2 replies of 4 words or fewer'));
  assert.strictEqual(f.savingCredits, 30);
});

test('opus subagents: re-priced on Sonnet per agent', () => {
  const rows = [row('A', 0, 100)];
  const calls = [call({ model: 'claude-opus-5.5', sub: true, input: 5000, cacheRead: 0, cacheWrite: 5000, output: 30000 }, { sub: true, who: 'story-decomposer' })];
  const f = evaluate(rows, calls).findings.find((x) => x.id === 'opus-subagents');
  assert.ok(f);
  assert.ok(f.evidence.some((e) => /^story-decomposer: \$0\.63, 30k output tokens over 1 call; on Sonnet \$0\.31\./.test(e)));
  assert.ok(f.savingUsd > 0.3);
});

test('in-prompt misses: separates a long wait from a miss moments after the previous call', () => {
  const calls = [call({ cacheRead: 0, cacheWrite: 0 }, { miss: true, idle: 13 }), call({ cacheRead: 0, cacheWrite: 0 }, { miss: true, idle: 400 }), ...Array.from({ length: 3 }, () => call())];
  const f = evaluate([row('A', 0, 10)], calls).findings.find((x) => x.id === 'in-prompt-misses');
  assert.ok(f.evidence[0].includes('1 after a wait of 5+ min'));
  assert.ok(f.evidence[0].includes('1 although the previous call was moments earlier'));
});

test('a finding under 2% goes to "checked and small", and nothing-to-flag data reads cleanly', () => {
  const big = Array.from({ length: 40 }, () => call({ input: 20000, cacheRead: 19000, cacheWrite: 1000 })); // small contexts, no flags
  const small = evaluate([row('A', 0, 10)], [...big, call({ model: 'claude-opus-5.5', sub: true, input: 100, cacheRead: 0, cacheWrite: 100, output: 50 }, { sub: true, who: 'tiny' })]);
  assert.ok(small.small.some((f) => f.id === 'opus-subagents'));
  const text = format(small, {});
  assert.match(text, /Nothing stands out|Checked and small/);
});

test('run prints a report and --json prints the findings', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => row('LLLLLLLL', i, 50, { ts: new Date().toISOString() }));
  const deps = { collect: async () => ({ prompts: rows }), liveCalls: async () => Array.from({ length: 5 }, () => call()) };
  assert.match(await run(['--since', '7d'], deps), /# Copilot cost advice/);
  assert.ok(JSON.parse(await run(['--json'], deps)).findings.length >= 1);
});
