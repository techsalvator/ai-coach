// node --test test/*.test.js
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const coach = require('../lib/coach');
const BIN = path.join(__dirname, '..', 'bin', 'cost.js');

const NOW = Date.parse('2026-10-02T12:00:00Z');
const line = (type, at, data = {}) => JSON.stringify({ type, data, id: 'x', timestamp: new Date(at).toISOString() });

/** A sandbox: Copilot home with one session of `prompts` prompts whose last answer was `idleMs` ago. */
function sandbox({ prompts = 0, idleMs = 60e3, model = 'claude-sonnet-4.6' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-'));
  const env = { ...process.env, COPILOT_HOME: path.join(root, 'copilot'), AI_COST_HOME: path.join(root, 'cost') };
  delete env.AI_COST_COACH;
  const dir = path.join(env.COPILOT_HOME, 'session-state', 's1');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < prompts; i++) {
    lines.push(line('user.message', NOW - idleMs - 1000, { content: `p${i} {"type":"user.message"` }));
    lines.push(line('assistant.message', NOW - idleMs, { model, content: 'ok' }));
  }
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.map((l) => `${l}\n`).join(''));
  return { env, log: path.join(dir, 'events.jsonl') };
}

test('sessionFacts counts prompts (only real ones), incrementally, and finds the last answer', () => {
  const { log } = sandbox({ prompts: 3, idleMs: 5000, model: 'gpt-5.4' });
  const a = coach.sessionFacts(log);
  assert.strictEqual(a.prompts, 3);
  assert.strictEqual(a.model, 'gpt-5.4');
  assert.strictEqual(a.lastAt, NOW - 5000);
  fs.appendFileSync(log, `${line('user.message', NOW, { content: 'more' })}\n`);
  assert.strictEqual(coach.sessionFacts(log, a).prompts, 4);
  assert.strictEqual(coach.sessionFacts(log).prompts, 4);
  assert.strictEqual(coach.sessionFacts('/nonexistent/events.jsonl'), null);
});

test('rules: expiry needs idle past the model\'s cache lifetime and a session worth caching', () => {
  const ids = (p, f, o) => coach.evaluate(p, f, NOW, o).map((t) => t.id);
  assert.deepStrictEqual(ids('add a test', { prompts: 8, lastAt: NOW - 6 * 60e3, model: 'claude-sonnet-4.6' }), ['cache-expired']);
  assert.deepStrictEqual(ids('add a test', { prompts: 8, lastAt: NOW - 6 * 60e3, model: 'gpt-5.4' }), []);
  assert.deepStrictEqual(ids('add a test', { prompts: 8, lastAt: NOW - 31 * 60e3, model: 'gpt-5.4' }), ['cache-expired']);
  assert.deepStrictEqual(ids('add a test', { prompts: 2, lastAt: NOW - 60 * 60e3, model: 'claude-sonnet-4.6' }), []);
  assert.deepStrictEqual(ids('add a test', { prompts: 30, lastAt: NOW - 1000, model: 'x' }), ['long-session']);
  assert.deepStrictEqual(ids('add a test', null), []);
});

test('rules: bare retries and big pastes, but not answers or skills', () => {
  const ids = (p, o) => coach.evaluate(p, null, NOW, o).map((t) => t.id);
  for (const p of ['try again', 'Try again.', 'fix it', 'still not working', "it doesn't work", 'same error', 'please retry']) assert.deepStrictEqual(ids(p), ['vague-retry'], p);
  for (const p of ['yes', 'continue', 'ok', 'try again with the --verbose flag on bin/cost.js', 'fix it in lib/coach.js line 40']) assert.deepStrictEqual(ids(p), [], p);
  assert.deepStrictEqual(ids('x'.repeat(13000)), ['big-paste']);
  assert.deepStrictEqual(ids('x'.repeat(13000), { skill: true }), []);
});

test('tipFor: one tip per prompt, each kind once per session, expiry again after an hour; off switch', () => {
  const { env } = sandbox({ prompts: 25, idleMs: 10 * 60e3 });
  coach.setStrict(false, env);
  const ask = (prompt, now = NOW) => coach.tipFor({ prompt, sessionId: 's1' }, { env, now });
  assert.strictEqual(ask('try again').id, 'cache-expired');
  assert.strictEqual(ask('try again').id, 'long-session');
  assert.strictEqual(ask('try again').id, 'vague-retry');
  assert.strictEqual(ask('try again'), null);
  assert.strictEqual(ask('add a test', NOW + 2 * 3600e3).id, 'cache-expired');
  coach.setEnabled(false, env);
  assert.strictEqual(coach.tipFor({ prompt: 'try again', sessionId: 'other' }, { env, now: NOW }), null);
  assert.match(coach.command([], env), /Cost tips are \*\*off\*\*/);
  assert.match(coach.command(['on'], env), /Cost tips are \*\*on\*\*/);
  assert.throws(() => coach.command(['maybe'], env), /strict model on, strict model off, or nothing/);
});

test('hook, strict off: a tip goes out as additionalContext, never as a block; plain prompts stay silent', () => {
  const { env } = sandbox({ prompts: 1 });
  coach.setStrict(false, env);
  const hook = (input) => spawnSync(process.execPath, [BIN, 'hook'], { input: JSON.stringify(input), encoding: 'utf8', env });
  const out = JSON.parse(hook({ sessionId: 's1', prompt: 'still not working' }).stdout);
  assert.deepStrictEqual(Object.keys(out), ['additionalContext']);
  assert.match(out.additionalContext, /Cost tip \(ai-cost-drilldown\):\*\* a short retry/);
  assert.strictEqual(hook({ sessionId: 's1', prompt: 'still not working' }).stdout, '', 'once per session');
  assert.strictEqual(hook({ sessionId: 's1', prompt: 'please review this PR' }).stdout, '');
});

test('hook in VS Code (snake_case input): tips work, /cost is not blocked because the chat would show nothing', () => {
  const { env } = sandbox({ prompts: 1 });
  delete env.COPILOT_CLI_BINARY_VERSION;
  const hook = (input) => spawnSync(process.execPath, [BIN, 'hook', '--vscode'], { input: JSON.stringify(input), encoding: 'utf8', env });
  const out = JSON.parse(hook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'try again' }).stdout);
  assert.deepStrictEqual(Object.keys(out), ['modifiedPrompt'], 'VS Code drops additionalContext when it adds its own');
  assert.match(out.modifiedPrompt, /^try again\n\n<system_reminder>\n[^]*a short retry[^]*<\/system_reminder>$/);
  // a report: saved as text for an editor tab; the model is only asked to say where it is
  const rep = spawnSync(process.execPath, [BIN, 'hook', '--vscode'], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: '/cost help' }), encoding: 'utf8', env: { ...env, AI_COST_NO_OPEN: '1' } });
  const file = /Saved the cost report: (\S+\.txt) /.exec(JSON.parse(rep.stdout).modifiedPrompt)[1];
  assert.ok(file.startsWith(path.join(env.AI_COST_HOME, 'reports')));
  assert.match(fs.readFileSync(file, 'utf8'), /^\/cost help {3}\(.*\)\n\n[^]*\/cost prompt N calls/);
  // the switch works from the chat itself: applied locally, confirmed by the model in one line
  const off = JSON.parse(hook({ hook_event_name: 'UserPromptSubmit', session_id: 's2', prompt: '/cost coach off' }).stdout);
  assert.match(off.modifiedPrompt, /Cost tips \(ai-cost-drilldown\) are off; strict mode is off; strict model is off\./);
  assert.strictEqual(hook({ hook_event_name: 'UserPromptSubmit', session_id: 's2', prompt: 'try again' }).stdout, '');
  assert.match(JSON.parse(hook({ hook_event_name: 'UserPromptSubmit', session_id: 's2', prompt: '/cost coach on' }).stdout).modifiedPrompt, /are on; strict mode is on; strict model is off\./);
  assert.match(JSON.parse(hook({ hook_event_name: 'UserPromptSubmit', session_id: 's2', prompt: 'try again' }).stdout).modifiedPrompt, /a short retry/);
});

test('the --vscode hook does nothing when Copilot CLI runs it: the plugin\'s hook answers there', () => {
  const { env } = sandbox({ prompts: 1 });
  const run = (prompt) => spawnSync(process.execPath, [BIN, 'hook', '--vscode'], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt }), encoding: 'utf8', env: { ...env, COPILOT_CLI_BINARY_VERSION: '1.0.90' } }).stdout;
  assert.strictEqual(run('try again'), '');
  assert.strictEqual(run('/cost help'), '');
  assert.ok(!fs.existsSync(path.join(env.AI_COST_HOME, 'reports')));
});

test('quality: thin prompts are named for what they lack; prompts with a target, questions and answers pass', () => {
  const id = (p) => (coach.quality(p) || { id: null }).id;
  assert.strictEqual(id('fix the bug'), 'no-error-text');
  assert.strictEqual(id('getting an error on build'), 'no-error-text');
  assert.strictEqual(coach.quality('make it faster', { first: true }).id, 'no-target');
  assert.strictEqual(id('make it faster'), null, 'a follow-up may say "it"');
  for (const p of ['Error: failed reaching server: context deadline exceeded', 'what is the error code we are throwing?', 'Fix issue 3', 'make goa-validation is failing in workflow', `also ${'word '.repeat(60)} also`]) assert.strictEqual(id(p), null, p);
  assert.strictEqual(id('clean up the code'), 'no-target');
  assert.strictEqual(id('try again'), 'vague-retry');
  assert.strictEqual(id('fix it, also add tests, also update docs for the hook in bin/cost.js'), 'multi-ask');
  for (const p of ['yes', 'continue', 'looks good', 'run the tests', 'commit this', 'update the README', 'fix the bug in lib/coach.js',
    'refactor tipFor to return early', 'why does FOPTS-123 fail', 'explain how prompt caching works', 'the build fails with "ENOENT: no such file"',
    'add a --json flag to the advise report and print findings as an array']) assert.strictEqual(id(p), null, p);
});

test('strict mode: a thin prompt is held back with a banner every time; the same prompt again runs; on by default', () => {
  const { env } = sandbox({ prompts: 1 });
  const hook = (prompt, extra = []) => spawnSync(process.execPath, [BIN, 'hook', ...extra], { input: JSON.stringify({ sessionId: 's1', hook_event_name: extra.length ? 'UserPromptSubmit' : undefined, prompt }), encoding: 'utf8', env }).stdout;
  assert.match(coach.command([], env), /Strict mode is \*\*on\*\*/);
  const held = JSON.parse(hook('fix the bug'));
  assert.strictEqual(held.decision, 'block');
  assert.match(held.reason, /Prompt check \(ai-cost-drilldown\): not sent\.[^]*mentions a problem[^]*In `<file or function>`[^]*send the same prompt again[^]*\/cost coach strict off/);
  assert.strictEqual(hook('fix the bug'), '', 'sent again as written: it runs, with no tip');
  assert.strictEqual(JSON.parse(hook('fix the bug')).decision, 'block', 'a later thin prompt is held again');
  assert.strictEqual(JSON.parse(hook('clean up the code')).decision, 'block', 'a different thin prompt is not a resend');
  assert.strictEqual(hook('fix the bug in lib/coach.js'), '', 'a good prompt passes');
  assert.strictEqual(hook('The user explicitly invoked the "/design" skill. fix the bug'), '', 'skills are never checked');
  // VS Code's chat shows nothing for a stopped prompt: the tip instead
  const vs = { ...env }; delete vs.COPILOT_CLI_BINARY_VERSION;
  const out = spawnSync(process.execPath, [BIN, 'hook', '--vscode'], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's9', prompt: 'make it faster' }), encoding: 'utf8', env: vs }).stdout;
  assert.match(JSON.parse(out).modifiedPrompt, /does not say what to work on/);
  assert.match(coach.command(['strict', 'off'], env), /Strict mode is \*\*off\*\*/);
  assert.match(JSON.parse(hook('getting an error on build')).additionalContext, /mentions a problem/, 'strict off: a tip, not a block');
  coach.command(['off'], env);
  assert.match(coach.command(['strict', 'on'], env), /Cost tips are \*\*on\*\*.*Strict mode is \*\*on\*\*/, 'strict on turns coaching on');
});

test('rewrite: the instruction carries the prompt, the reason and recent context; output is parsed; failures give null', () => {
  const rw = require('../lib/rewrite');
  const { env, log } = sandbox({ prompts: 2 });
  fs.appendFileSync(log, `${line('user.message', NOW, { content: 'the hook test in test/coach.test.js is red' })}\n${line('assistant.message', NOW, { model: 'm', content: 'AssertionError: expected block' })}\n`);
  const ctx = rw.recentContext(log);
  assert.match(ctx, /- user: the hook test in test\/coach\.test\.js is red\n- assistant \(last answer\): AssertionError: expected block$/);
  assert.strictEqual(rw.recentContext('/nonexistent'), '');
  const calls = [];
  const fake = (out) => (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { stdout: out }; };
  const ok = [JSON.stringify({ type: 'assistant.message', data: { content: '"Fix the red hook test in test/coach.test.js."' } }), JSON.stringify({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 90000000 } })].join('\n');
  const r = rw.suggest({ prompt: 'fix the bug', why: 'it mentions a problem', sessionFile: log, cwd: '/w', sessionId: 's1' }, { env, spawnSync: fake(ok), platform: 'linux' });
  assert.deepStrictEqual(r, { text: 'Fix the red hook test in test/coach.test.js.', model: 'gpt-5-mini', credits: 0.09 });
  const c = calls[0];
  assert.strictEqual(c.cmd, 'copilot');
  assert.match(c.args[1], /Prompt: fix the bug\nWorking folder: \/w\nRecent conversation:\n- user:[^]*never invent|never invent[^]*Prompt: fix the bug/);
  for (const flag of ['--available-tools', '--no-custom-instructions', '--disable-builtin-mcps', '--no-ask-user']) assert.ok(c.args.includes(flag), flag);
  assert.strictEqual(c.args[c.args.indexOf('--model') + 1], 'gpt-5-mini');
  assert.strictEqual(c.opts.env.COPILOT_HOME, path.join(env.AI_COST_HOME, 'rewriter'), 'its own Copilot home');
  assert.strictEqual(c.opts.env.AI_COST_COACH, '0', 'the rewriter is never coached');
  assert.strictEqual(rw.suggest({ prompt: 'x', why: 'y' }, { env, spawnSync: fake('Error: not signed in'), platform: 'linux' }), null);
  assert.strictEqual(rw.suggest({ prompt: 'x', why: 'y' }, { env: { ...env, AI_COST_REWRITE_MODEL: 'claude-haiku-4.5' }, spawnSync: fake(ok), platform: 'linux' }).model, 'claude-haiku-4.5');
  const logged = fs.readFileSync(path.join(env.AI_COST_HOME, 'rewrites.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(logged.map((l) => [l.ok, l.credits]), [[true, 0.09], [false, null], [true, 0.09]]);
});

test('rewrite on: the banner carries the suggestion, "y" runs it, anything else drops it; off by default', { skip: process.platform === 'win32' }, () => {
  const { env } = sandbox({ prompts: 1 });
  // a fake `copilot` first on PATH, answering as --output-format json does
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fakebin-'));
  fs.writeFileSync(path.join(bin, 'copilot'), `#!/bin/sh\necho '{"type":"assistant.message","data":{"content":"In lib/coach.js, make tipFor return early when coaching is off."}}'\necho '{"type":"session.usage_checkpoint","data":{"totalNanoAiu":120000000}}'\n`, { mode: 0o755 });
  const e = { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const hook = (prompt) => spawnSync(process.execPath, [BIN, 'hook'], { input: JSON.stringify({ sessionId: 's1', prompt }), encoding: 'utf8', env: e }).stdout;
  assert.doesNotMatch(JSON.parse(hook('fix the bug')).reason, /Suggested prompt/, 'off by default: the plain banner');
  assert.match(coach.command(['strict', 'model', 'on'], e), /Strict model is \*\*on\*\*/);
  const held = JSON.parse(hook('getting an error on build'));
  assert.strictEqual(held.decision, 'block');
  assert.match(held.reason, /Suggested prompt:\n> In lib\/coach\.js, make tipFor return early when coaching is off\.[^]*Send \*\*y\*\* to run[^]*gpt-5-mini \(0\.12 AI credits\)[^]*\/cost coach strict model off/);
  assert.deepStrictEqual(JSON.parse(hook('y')), { modifiedPrompt: 'In lib/coach.js, make tipFor return early when coaching is off.' });
  assert.strictEqual(hook('y'), '', 'the offer is used up: a later "y" is just a prompt');
  JSON.parse(hook('fix the bug'));
  assert.strictEqual(hook('fix the bug in lib/coach.js line 40'), '', 'their own rewording runs');
  assert.strictEqual(hook('yes'), '', 'and the dropped suggestion is not run by a later "yes"');
  // a suggestion that still has blanks is a template to fill in: "y" is not offered and would not run it
  fs.writeFileSync(path.join(bin, 'copilot'), `#!/bin/sh\necho '{"type":"assistant.message","data":{"content":"Fix <exact error line> in <file>."}}'\n`, { mode: 0o755 });
  const blanks = JSON.parse(hook('the build is broken')).reason;
  assert.match(blanks, /> Fix <exact error line> in <file>\.[^]*Fill in the parts in `<angle brackets>`[^]*a small model call/);
  assert.doesNotMatch(blanks, /Send \*\*y\*\*/);
  assert.strictEqual(hook('y'), '');
  assert.match(coach.command(['strict', 'model', 'off'], e), /Strict model is \*\*off\*\*/);
  // shorter and older spellings of the same switch
  assert.match(coach.command(['strict', 'with', 'model', 'on'], e), /Strict model is \*\*on\*\*/);
  assert.match(coach.command(['rewrite', 'off'], e), /Strict model is \*\*off\*\*/);
  assert.throws(() => coach.command(['strict', 'with', 'on'], e), /strict model on/);
});
