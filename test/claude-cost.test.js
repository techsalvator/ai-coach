// node --test test/*.test.js
'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cost-'));
process.env.CLAUDE_CONFIG_DIR = HOME;
const { analyse, rows, learnRates, sessions, isUserPrompt } = require('../lib/claude-cost');

const PROJ = path.join(HOME, 'projects', '-repo');
const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const at = (t) => `2026-09-29T${t}Z`;
const prompt = (text, t, extra = {}) => ({ type: 'user', message: { role: 'user', content: text }, origin: { kind: 'human' }, timestamp: at(t), cwd: '/repo', ...extra });
const usage = (input, read, write1h, output) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write1h,
  cache_creation: { ephemeral_1h_input_tokens: write1h, ephemeral_5m_input_tokens: 0 }, output_tokens: output });
const reply = (id, model, t, u, content = []) => ({ type: 'assistant', timestamp: at(t), message: { id, model, usage: u, content } });

function write(file, recs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

write(path.join(PROJ, `${SID}.jsonl`), [
  prompt('first question', '10:00:00'),
  // one API response written as two records (text block, then tool_use block): count once
  reply('m1', 'claude-opus-5-5', '10:00:05', usage(10, 0, 10000, 100), [{ type: 'text', text: 'hi' }]),
  reply('m1', 'claude-opus-5-5', '10:00:06', usage(10, 0, 10000, 200), [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cd /repo && ls -la' } }]),
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'y'.repeat(800) }] }] }, timestamp: at('10:00:07') },
  reply('m2', 'claude-opus-5-5', '10:00:08', usage(5, 10010, 300, 50)),
  prompt('<command-name>/usage</command-name>', '10:01:00'),                      // a command echo, not a prompt
  prompt('second, warm', '10:02:00'),
  reply('m3', 'claude-opus-5-5', '10:02:05', usage(5, 10300, 200, 40)),
  prompt('third, after a 2 h break', '12:10:00'),
  reply('m4', 'claude-opus-5-5', '12:10:05', usage(5, 0, 10500, 40)),
  prompt('fourth, switched model', '12:11:00'),
  reply('m5', 'claude-sonnet-5-5', '12:11:05', usage(5, 0, 10600, 40)),
  { type: 'cost-state', totalCostUSD: 2.5, modelUsage: { 'claude-opus-5-5': { costUSD: 2 }, 'claude-sonnet-5-5': { costUSD: 0.5 } } },
]);
write(path.join(PROJ, SID, 'subagents', 'agent-x.jsonl'), [
  { type: 'user', isSidechain: true, message: { role: 'user', content: 'sub task' }, timestamp: at('10:02:10') },
  reply('s1', 'claude-opus-5-5', '10:02:11', usage(3, 0, 2000, 30), [{ type: 'tool_use', id: 't9', name: 'Read', input: { file_path: '/repo/a.go', offset: 10, limit: 20 } }]),
  { type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', is_error: true, content: 'missing' }] }, timestamp: at('10:02:12') },
]);
fs.writeFileSync(path.join(PROJ, SID, 'subagents', 'agent-x.meta.json'), JSON.stringify({ agentType: 'Explore' }));

test('only human prompts count; command echoes and tool results do not', () => {
  assert.ok(isUserPrompt(prompt('hi', '10:00:00')));
  assert.ok(!isUserPrompt(prompt('<command-name>/usage</command-name>', '10:00:00')));
  assert.ok(!isUserPrompt({ type: 'user', message: { content: [{ type: 'tool_result' }] } }));
  assert.ok(!isUserPrompt(prompt('x', '10:00:00', { origin: { kind: 'task-notification' } })));
});

test('usage is counted once per API message, subagents join the running prompt, costs add up to cost-state', async () => {
  const [s] = sessions();
  const r = await analyse(s);
  assert.deepStrictEqual(r.prompts.map((p) => p.prompt), ['first question', 'second, warm', 'third, after a 2 h break', 'fourth, switched model']);
  assert.strictEqual(r.prompts[0].main.length, 2);                 // m1 once, m2
  assert.strictEqual(r.prompts[0].main[0].u.output_tokens, 200);   // the fuller record wins
  assert.strictEqual(r.prompts[0].tools, 1);
  assert.deepStrictEqual(r.prompts[1].sub.map((c) => c.agent), ['Explore']);
  const rs = rows(r, {});
  const total = rs.reduce((a, x) => a + x.usd, 0);
  assert.ok(Math.abs(total - 2.5) < 1e-9, `prompts sum to ${total}`);
});

test('cache breaks: warm, idle past the 1 h lifetime, and a model switch', async () => {
  const [s] = sessions();
  const rs = rows(await analyse(s), {});
  assert.deepStrictEqual(rs.map((x) => (x.cacheBreak ? x.cacheBreak.kind : null)), [null, null, 'idle', 'switch']);
  assert.strictEqual(rs[2].cacheBreak.uncached, 10505);
});

test('rates learned from sessions with a cost-state price the ones without', async () => {
  const { learned } = await learnRates(sessions());
  assert.ok(learned['claude-opus-5-5'] > 0 && learned['claude-sonnet-5-5'] > 0);
});

test('per-prompt tool calls: main and subagent, with what they did and their results', async () => {
  const [s] = sessions();
  const r = await analyse(s);
  assert.deepStrictEqual(r.prompts[0].toolCalls.map((t) => [t.where, t.name, t.detail, t.resultChars, t.error]),
    [['main', 'Bash', 'ls -la', 800, false]]);
  assert.deepStrictEqual(r.prompts[1].toolCalls.map((t) => [t.where, t.name, t.detail, t.error]),
    [['Explore', 'Read', '/repo/a.go (lines 10+20)', true]]);
});

test('token and cost split of a prompt adds up to the prompt', async () => {
  const [s] = sessions();
  const rs = rows(await analyse(s), {});
  const { run } = require('../lib/claude-cost');
  const text = await run(['--prompt', '2']);
  assert.match(text, /## Tokens/);
  assert.match(text, /\| main \| claude-opus-5-5 \| 1 \|/);
  assert.match(text, /\| Explore \| claude-opus-5-5 \| 1 \|/);
  const total = rs[1].modelCalls.reduce((a, c) => a + rs[1].rate(c), 0);
  assert.ok(Math.abs(total - rs[1].usd) < 1e-9);
});

test('a PhantomFlow skill command is a prompt; other commands and meta records are not', () => {
  const { commandPrompt, isUserPrompt } = require('../lib/claude-cost');
  const skills = new Set(['backlog', 'design']);
  const echo = (name, args) => `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>${args == null ? '' : `\n<command-args>${args}</command-args>`}`;
  assert.strictEqual(commandPrompt(echo('backlog', 'FOPTS-31765'), skills), '/backlog FOPTS-31765');
  assert.strictEqual(commandPrompt(echo('design', null), skills), '/design');
  assert.strictEqual(commandPrompt(echo('model', 'x'), skills), null);
  const rec = (content, extra = {}) => ({ type: 'user', message: { content }, ...extra });
  assert.ok(isUserPrompt(rec(echo('backlog', 'FOPTS-1')), skills));
  assert.ok(!isUserPrompt(rec(echo('model', 'opus')), skills));
  assert.ok(!isUserPrompt(rec(echo('backlog', 'FOPTS-1'), { isMeta: true }), skills));
  assert.ok(isUserPrompt(rec('just a question'), skills));
  assert.ok(!isUserPrompt(rec('<local-command-stdout>ok</local-command-stdout>'), skills));
});
