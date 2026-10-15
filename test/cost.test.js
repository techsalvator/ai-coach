// node --test test/*.test.js
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

const { splitArgs, INVOKED, RAW } = require('../bin/cost');
const BIN = path.join(__dirname, '..', 'bin', 'cost.js');
// its own state folder: the hook's cost tips keep per-session state, which must not land in the real home
const ENV = { ...process.env, AI_COST_HOME: require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'cost-')) };
const hook = (input) => spawnSync(process.execPath, [BIN, 'hook'], { input: JSON.stringify(input), encoding: 'utf8', env: ENV });

test('matches the /cost skill as Copilot expands it, with or without the plugin prefix', () => {
  assert.ok(INVOKED.test('The user explicitly invoked the "/cost" skill. Follow its instructions now.'));
  assert.ok(INVOKED.test('The user explicitly invoked the "/ai-cost-coach:cost" skill. Follow its instructions now.'));
  assert.ok(!INVOKED.test('The user explicitly invoked the "/costly" skill.'));
  assert.ok(RAW.test('/cost prompts') && RAW.test('/ai-cost-coach:cost') && RAW.test('  /cost'));
  assert.ok(!RAW.test('/costly') && !RAW.test('what does /cost do?'));
});

test('splitArgs keeps quoted phrases together', () => {
  assert.deepStrictEqual(splitArgs('prompts --grep "design spec" --top 5'), ['prompts', '--grep', 'design spec', '--top', '5']);
  assert.deepStrictEqual(splitArgs(''), []);
});

test('hook: any other prompt passes through with no output', () => {
  const r = hook({ sessionId: 'x', prompt: 'please review this PR' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('hook: /cost help is answered and blocked, never sent to the model', () => {
  const r = hook({ sessionId: 'x', prompt: 'The user explicitly invoked the "/ai-cost-coach:cost" skill. Go.\n\n<skill-context name="cost">\nARGUMENTS: help\n</skill-context>' });
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /\/cost prompt N calls/);
  assert.match(out.reason, /Answered locally by ai-cost-coach: no model call, no AI credits\./);
});

test('hook: a bad argument is still answered (blocked), with the help', () => {
  const r = hook({ sessionId: 'x', prompt: '/cost prompt notanumber' });
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /needs a prompt number/);
  assert.strictEqual(r.status, 0);
});

test('hook: unreadable input is ignored', () => {
  const r = spawnSync(process.execPath, [BIN, 'hook'], { input: 'not json', encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('hook: a session with no log yet (a new `copilot -p` run) falls back to the most recent session, with a note', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
  const sid = '11111111-2222-3333-4444-555555555555';
  fs.mkdirSync(path.join(home, 'session-state', sid), { recursive: true });
  fs.writeFileSync(path.join(home, 'session-state', sid, 'events.jsonl'), `${JSON.stringify({ type: 'session.start', timestamp: '2026-10-01T10:00:00Z', data: { sessionId: sid, context: { cwd: '/x' } } })}\n`);
  const r = spawnSync(process.execPath, [BIN, 'hook'], { input: JSON.stringify({ sessionId: 'not-yet-written', prompt: '/cost session' }), encoding: 'utf8', env: { ...process.env, COPILOT_HOME: home, AI_COST_HOME: home } });
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /This session has no log yet; showing the most recent session instead\./);
  assert.match(out.reason, /Copilot session cost — 11111111/);
});

test('a bare /cost shows all sessions; /cost session, /cost 20 and /cost prompt N stay on this session', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
  const now = Date.now();
  const mk = (sid, cwd, text, nano) => {
    fs.mkdirSync(path.join(home, 'session-state', sid), { recursive: true });
    const t = (ms) => new Date(now - 3600000 + ms).toISOString();
    fs.writeFileSync(path.join(home, 'session-state', sid, 'events.jsonl'), [
      { type: 'session.start', timestamp: t(0), data: { sessionId: sid, context: { cwd } } },
      { type: 'user.message', timestamp: t(1000), data: { content: text } },
      { type: 'assistant.turn_start', timestamp: t(1500), data: {} },
      { type: 'assistant.turn_end', timestamp: t(5000), data: {} },
      { type: 'session.usage_checkpoint', timestamp: t(6000), data: { totalNanoAiu: nano, totalPremiumRequests: 1 } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  };
  mk('aaaaaaaa-0000-0000-0000-000000000001', '/x/one', 'first session prompt', 12e9);
  mk('bbbbbbbb-0000-0000-0000-000000000002', '/x/two', 'second session prompt', 30e9);
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args, '--md'], { encoding: 'utf8',
    env: { ...process.env, COPILOT_HOME: home, AI_COST_HOME: home, AI_COST_VSCODE_DIR: path.join(home, 'no-vscode') } }).stdout;
  const all = run();
  assert.match(all, /2 prompts in 2 sessions: \*\*42\.00 AI credits \(\$0\.42\)\*\*/);
  assert.match(all, /By session:/);
  assert.match(all, /\| bbbbbbbb \| 1 \| 30\.00 \|/);
  assert.match(all, /\| aaaaaaaa \| 1 \| 12\.00 \|/);
  assert.match(all, /This session: `\/cost session`/);
  const hook = (prompt) => JSON.parse(spawnSync(process.execPath, [BIN, 'hook'], { encoding: 'utf8',
    input: JSON.stringify({ sessionId: 'aaaaaaaa-0000-0000-0000-000000000001', prompt }),
    env: { ...process.env, COPILOT_HOME: home, AI_COST_HOME: home, AI_COST_VSCODE_DIR: path.join(home, 'no-vscode') } }).stdout).reason;
  assert.match(hook('/cost'), /2 prompts in 2 sessions/);
  assert.match(hook('/cost session'), /Copilot session cost — aaaaaaaa[^]*first session prompt/);
  assert.match(hook('/cost session --last 1'), /Copilot session cost — aaaaaaaa/);
  assert.match(hook('/cost 20'), /Copilot session cost — aaaaaaaa/);
  assert.match(hook('/cost session bbbbbbbb'), /Copilot session cost — bbbbbbbb/);
  assert.match(hook('/cost prompt 1'), /Prompt 1 of session aaaaaaaa/);
  // a prompt or the tools of ANOTHER session, from this one
  assert.match(hook('/cost prompt bbbbbbbb 1'), /Prompt 1 of session bbbbbbbb[^]*second session prompt/);
  assert.match(hook('/cost prompt bbbbbbbb:1'), /Prompt 1 of session bbbbbbbb/);
  assert.match(hook('/cost session bbbbbbbb prompt 1'), /Prompt 1 of session bbbbbbbb/);
  assert.match(hook('/cost prompt bbbbbbbb 1 calls'), /Prompt 1 of session bbbbbbbb[^]*No live token records/);
  assert.match(hook('/cost session bbbbbbbb tools'), /No tool calls match/);          // found the session; it made none
  assert.match(hook('/cost session zzzzzzzz tools'), /no session matches "zzzzzzzz"/);
  assert.match(hook('/cost prompt bbbbbbbb'), /needs a prompt number[^]*\/cost prompt <session> N/);
  assert.match(hook('/cost prompt zzzzzzzz 1'), /no session matches|matches 0/i);
  // the all-sessions prompt table carries each prompt's number, and says how to open one
  const top = run('prompts');
  assert.match(top, /\| Session \| # \| Repo \|/);
  assert.match(top, /\| bbbbbbbb \| 1 \| two \| second session prompt \|/);
  assert.match(top, /Open any row with `\/cost prompt <session> <#>`, e\.g\. `\/cost prompt bbbbbbbb 1`/);
});

test('a misspelt command is named and corrected, not read as a session id', () => {
  const { nearestCommand } = require('../bin/cost');
  assert.strictEqual(nearestCommand('sesssion'), 'session');
  assert.strictEqual(nearestCommand('promt'), 'prompt');
  assert.strictEqual(nearestCommand('promts'), 'prompts');   // nearer to prompts than to prompt
  assert.strictEqual(nearestCommand('tool'), 'tools');
  assert.strictEqual(nearestCommand('epic'), 'epics');
  assert.strictEqual(nearestCommand('advice'), 'advise');
  for (const ok of ['session', 'a05dcb09', 'b4489ffc', 'deadbeef', 'face', '20', '--all', 'pf-design-FOPTS-1', undefined]) assert.strictEqual(nearestCommand(ok), null, String(ok));
  const r = hook({ sessionId: 'x', prompt: '/cost sesssion b4489ffc prompt 2' });
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /unknown command "sesssion"\. Did you mean `\/cost session b4489ffc prompt 2`\?/);
});

test('openInEditor: the code command first, then the vscode:// link; a failure everywhere is reported', () => {
  const { openInEditor } = require('../bin/cost');
  const calls = [];
  const run = (ok) => (cmd, a) => { calls.push([cmd, ...a]); return { status: ok(cmd) ? 0 : 1 }; };
  assert.strictEqual(openInEditor('/tmp/a b.txt', { spawnSync: run((c) => c === 'code'), platform: 'linux', env: {} }), true);
  assert.deepStrictEqual(calls, [['code', '-r', '/tmp/a b.txt']]);
  calls.length = 0;
  assert.strictEqual(openInEditor('/tmp/a b.txt', { spawnSync: run((c) => c === 'xdg-open'), platform: 'linux', env: {} }), true);
  assert.deepStrictEqual(calls[1], ['xdg-open', 'vscode://file/tmp/a%20b.txt']);
  calls.length = 0;
  assert.strictEqual(openInEditor('C:\\Users\\me\\r.txt', { spawnSync: run(() => false), platform: 'win32', env: {} }), false);
  assert.deepStrictEqual(calls[1], ['cmd', '/c', 'start', '', 'vscode://file/C:/Users/me/r.txt']);
  assert.strictEqual(openInEditor('/tmp/x', { spawnSync: run(() => true), env: { AI_COST_NO_OPEN: '1' } }), false);
});
