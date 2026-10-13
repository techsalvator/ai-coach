'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('../copilotsetup');
const WIN = process.platform === 'win32';

function env() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicost-setup-'));
  const e = { ...process.env, COPILOT_HOME: path.join(root, 'copilot'), AI_COST_HOME: path.join(root, 'data') };
  fs.mkdirSync(e.COPILOT_HOME, { recursive: true });
  return e;
}

test('nothing is set up at first', () => {
  const s = S.status(env());
  assert.deepStrictEqual([s.copilotFound, s.hook, s.logger, s.runtime, s.enabled, s.plugin], [true, false, false, false, false, false]);
});

test('enable writes the runtime, the token logger and the hook, and status sees them', () => {
  const e = env();
  const w = S.enable(e);
  assert.ok(fs.existsSync(path.join(w.runtime, 'bin', 'cost.js')));
  assert.ok(fs.existsSync(path.join(w.runtime, 'lib', 'coach.js')));
  assert.ok(fs.existsSync(path.join(w.runtime, 'lib', 'copilot-prices.json')));
  for (const f of ['extension.mjs', 'record.mjs', 'cost-command.mjs']) assert.ok(fs.existsSync(path.join(w.logger, f)), f);
  const hook = JSON.parse(fs.readFileSync(w.hook, 'utf8')).hooks.UserPromptSubmit[0];
  assert.strictEqual(hook.type, 'command');
  // the hook runs the copy that survives extension updates: on Windows through hook.cmd beside it, elsewhere directly
  const runs = WIN ? fs.readFileSync(path.join(w.runtime, S.SHIM), 'utf8').trim() : hook.command;
  assert.ok(WIN ? hook.command.replace(/\\/g, '/').includes(`${w.runtime.replace(/\\/g, '/')}/${S.SHIM}`) : hook.command.includes(`${w.runtime}/bin/cost.js`), hook.command);
  assert.match(runs, /bin[\\/]cost\.js" hook --vscode$/);
  const s = S.status(e);
  assert.deepStrictEqual([s.hook, s.logger, s.runtime, s.enabled, s.outdated], [true, true, true, true, false]);
});

test('the installed copy runs on its own: it answers /cost and a thin prompt without the repository', () => {
  const e = env();
  const w = S.enable(e);
  const run = (prompt) => spawnSync(process.execPath, [path.join(w.runtime, 'bin', 'cost.js'), 'hook', '--vscode'],
    { input: JSON.stringify({ session_id: 's1', prompt }), encoding: 'utf8', env: { ...e, COPILOT_CLI_BINARY_VERSION: '1.0.91' } });
  const rep = run('/cost help');
  assert.strictEqual(rep.status, 0, rep.stderr);
  assert.strictEqual(JSON.parse(rep.stdout).decision, 'block');
  assert.match(JSON.parse(rep.stdout).reason, /\/cost prompt N calls/);
  assert.strictEqual(JSON.parse(run('try again').stdout).decision, 'block', 'strict mode holds the thin prompt back');
  assert.strictEqual(run('please review the diff in lib/coach.js').stdout, '', 'a good prompt passes untouched');
});

test('enable twice is safe, and refresh updates only an outdated setup', () => {
  const e = env();
  S.enable(e); S.enable(e);
  assert.strictEqual(S.refresh(e), false);
  fs.writeFileSync(S.paths(e).stamp, '0.0.0\n');
  assert.strictEqual(S.status(e).outdated, true);
  assert.strictEqual(S.refresh(e), true);
  assert.strictEqual(S.status(e).outdated, false);
  assert.strictEqual(S.refresh(env()), false, 'nothing to refresh when not set up');
});

test('enable replaces the logger\'s earlier name', () => {
  const e = env();
  const legacy = path.join(e.COPILOT_HOME, 'extensions', 'ai-cost-token-logger');
  fs.mkdirSync(legacy, { recursive: true });
  S.enable(e);
  assert.ok(!fs.existsSync(legacy));
  assert.ok(fs.existsSync(path.join(e.COPILOT_HOME, 'extensions', 'ai-cost', 'extension.mjs')));
});

test('disable removes the three pieces and keeps the data', () => {
  const e = env();
  S.enable(e);
  const data = path.join(e.AI_COST_HOME, 'copilot-tokens.jsonl');
  fs.writeFileSync(data, '{}\n');
  fs.writeFileSync(path.join(e.AI_COST_HOME, 'config.json'), '{"coach":false}');
  assert.strictEqual(S.disable(e).length, 3);
  assert.deepStrictEqual([S.status(e).hook, S.status(e).logger, S.status(e).runtime], [false, false, false]);
  assert.ok(fs.existsSync(data) && fs.existsSync(path.join(e.AI_COST_HOME, 'config.json')));
  assert.deepStrictEqual(S.disable(e), []);
});

test('an old hook file that points into the plugin is reported as another setup, and enable repoints it', () => {
  const e = env();
  const hook = S.paths(e).hook;
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, JSON.stringify({ hooks: { UserPromptSubmit: [{ type: 'command', command: 'node "/x/installed-plugins/_direct/ai-cost-drilldown/bin/cost.js" hook --vscode' }] } }));
  assert.strictEqual(S.status(e).hookTarget, 'other');
  S.enable(e);
  assert.strictEqual(S.status(e).hookTarget, 'runtime');
});

test('the old plugin is detected, and removing it goes through the copilot command', () => {
  const e = env();
  assert.strictEqual(S.status(e).plugin, false);
  fs.mkdirSync(path.join(e.COPILOT_HOME, 'installed-plugins', '_direct', 'ai-cost-drilldown'), { recursive: true });
  assert.strictEqual(S.status(e).plugin, true);
  const calls = [];
  const r = S.removePlugin(e, (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: 'Uninstalled', stderr: '' }; });
  assert.deepStrictEqual(calls, [['copilot', 'plugin', 'uninstall', 'ai-cost-drilldown']]);
  assert.deepStrictEqual([r.ok, r.output], [true, 'Uninstalled']);
  assert.strictEqual(S.removePlugin(e, () => ({ error: new Error('ENOENT'), status: null })).ok, false);
});

// --- the hook must say where node is: VS Code starts it with a thin PATH ---

const thinPathHasNode = ['/usr/bin/node', '/bin/node', '/usr/sbin/node', '/sbin/node'].some((f) => fs.existsSync(f));

test('findNode prefers a stable link on the PATH, and the hook is written with the absolute path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicost-bin-'));
  const fake = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
  const shown = fake.replace(/\\/g, '/'); // the hook file always has forward slashes
  fs.writeFileSync(fake, '#!/bin/sh\n'); fs.chmodSync(fake, 0o755);
  assert.strictEqual(S.findNode({ PATH: `/nonexistent${path.delimiter}${dir}` }), fake);
  const cmd = S.hookContent('/home/u/.ai-cost-drilldown/runtime', fake, 'linux').hooks.UserPromptSubmit[0].command;
  assert.strictEqual(cmd, `"${shown}" "/home/u/.ai-cost-drilldown/runtime/bin/cost.js" hook --vscode`);
  assert.ok(S.hookContent('/r', null).hooks.UserPromptSubmit[0].command.startsWith('node '), 'with no node found it stays the old bare command');
  const e = env();
  const w = S.enable({ ...e, PATH: `${dir}${path.delimiter}${process.env.PATH}` });
  assert.strictEqual(w.node, fake);
  if (WIN) assert.ok(fs.readFileSync(path.join(w.runtime, S.SHIM), 'utf8').includes(`"${fake}" `), 'the node that was found is the one hook.cmd starts');
  else assert.ok(JSON.parse(fs.readFileSync(w.hook, 'utf8')).hooks.UserPromptSubmit[0].command.startsWith(`"${shown}" `));
  assert.strictEqual(S.status({ ...e, PATH: process.env.PATH }).bareNode, false);
});

test('refresh repairs a hook an earlier setup wrote with a bare `node`', () => {
  const e = env();
  S.enable(e);
  const hook = S.paths(e).hook;
  const bare = S.hookContent(S.paths(e).runtime); // with no node: the bare command, as an earlier setup wrote it
  fs.writeFileSync(hook, JSON.stringify(bare));
  assert.strictEqual(S.status(e).bareNode, true);
  assert.strictEqual(S.refresh(e), true);
  assert.strictEqual(S.status(e).bareNode, false);
  assert.match(JSON.parse(fs.readFileSync(hook, 'utf8')).hooks.UserPromptSubmit[0].command, WIN ? /hook\.cmd"?$/ : /^"[^"]*node" /);
  assert.strictEqual(S.refresh(e), false, 'and then there is nothing to do');
});

test('check runs the hook with a thin PATH, as VS Code does: the absolute node passes, a bare node is found out', { skip: process.platform === 'win32' || thinPathHasNode }, () => {
  const e = env();
  S.enable(e);
  const ok = S.check(e);
  assert.strictEqual(ok.ok, true, ok.output);
  const hook = S.paths(e).hook;
  fs.writeFileSync(hook, JSON.stringify({ hooks: { UserPromptSubmit: [{ type: 'command', command: `node "${path.join(S.paths(e).runtime, 'bin', 'cost.js')}" hook --vscode`, timeout: 120 }] } }));
  const bad = S.check(e);
  assert.strictEqual(bad.ok, false, `a bare node ran with the thin PATH: ${JSON.stringify(bad)}`);
  assert.strictEqual(bad.status, 127);
  assert.match(bad.output, /node: command not found/);
  assert.strictEqual(S.check(env()).ok, false, 'no hook file: not ok, and it says so');
});

test('a changed script is noticed under the same version: the runtime is refreshed', () => {
  const e = env();
  S.enable(e);
  const p = S.paths(e);
  assert.match(fs.readFileSync(p.stamp, 'utf8'), /^\d+\.\d+\.\d+\+[0-9a-f]{8}\n$/, 'the stamp carries a fingerprint of the scripts');
  assert.strictEqual(S.status(e).outdated, false);
  // the installed copy was made from other scripts (same version, another fingerprint)
  fs.writeFileSync(p.stamp, fs.readFileSync(p.stamp, 'utf8').replace(/\+.*/, '+deadbeef\n'));
  fs.writeFileSync(path.join(p.runtime, 'lib', 'coach.js'), '// older copy\n');
  assert.strictEqual(S.status(e).outdated, true);
  assert.strictEqual(S.refresh(e), true);
  assert.strictEqual(S.status(e).outdated, false);
  assert.ok(!fs.readFileSync(path.join(p.runtime, 'lib', 'coach.js'), 'utf8').includes('older copy'));
});

// --- Windows: nothing says which shell starts a hook there, so the command has to run from each of them ---

test('on Windows the hook names hook.cmd: a bare path where it has no space, through cmd where it has one', () => {
  const cmd = (runtime) => S.hookContent(runtime, 'C:\\Program Files\\nodejs\\node.exe', 'win32').hooks.UserPromptSubmit[0].command;
  assert.strictEqual(cmd('C:\\Users\\u\\.ai-cost-drilldown\\runtime'), 'C:/Users/u/.ai-cost-drilldown/runtime/hook.cmd', 'forward slashes, no quotes: cmd.exe, PowerShell and Git Bash all run it');
  assert.strictEqual(cmd('C:\\Users\\a b\\.ai-cost-drilldown\\runtime'), 'cmd /d /c "C:\\Users\\a b\\.ai-cost-drilldown\\runtime\\hook.cmd"');
  assert.strictEqual(S.shimContent('C:\\Program Files\\nodejs\\node.exe'), '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "%~dp0bin\\cost.js" hook --vscode\r\n');
  assert.ok(S.hookContent('C:\\r', null, 'win32').hooks.UserPromptSubmit[0].command.startsWith('node '), 'no node found: the bare command, which status reports');
  assert.strictEqual(S.hookContent('/home/u/rt', '/usr/bin/node', 'darwin').hooks.UserPromptSubmit[0].command, '"/usr/bin/node" "/home/u/rt/bin/cost.js" hook --vscode', 'macOS and Linux are unchanged');
});

for (const [what, prefix] of [['a plain folder', 'aicost-win-'], ['a folder with a space in its name', 'aicost win ']]) {
  test(`on Windows the hook really runs from cmd.exe and from PowerShell, in ${what}; an earlier setup's command is found out and repaired`, { skip: !WIN }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const e = { ...process.env, COPILOT_HOME: path.join(root, 'copilot'), AI_COST_HOME: path.join(root, 'data') };
    fs.mkdirSync(e.COPILOT_HOME, { recursive: true });
    const w = S.enable(e);
    const ok = S.check(e);
    assert.deepStrictEqual([ok.ok, ok.output], [true, '']);
    assert.strictEqual(S.status(e).needsShim, false);
    // what 0.2.1 wrote: node and the script, each in quotes. cmd.exe runs that; PowerShell reads it as an expression.
    fs.writeFileSync(w.hook, JSON.stringify(S.hookContent(w.runtime, w.node, 'linux')));
    const old = S.check(e);
    assert.strictEqual(old.ok, false);
    assert.match(old.output, /^PowerShell: /);
    assert.deepStrictEqual([S.status(e).enabled, S.status(e).needsShim], [true, true]);
    assert.strictEqual(S.refresh(e), true);
    assert.strictEqual(S.check(e).ok, true);
    assert.strictEqual(S.refresh(e), false, 'and then there is nothing to do');
    // hook.cmd is in the runtime folder, which an update replaces: it is written again
    fs.writeFileSync(S.paths(e).stamp, '0.0.0\n');
    assert.strictEqual(S.refresh(e), true);
    assert.deepStrictEqual([S.status(e).enabled, S.check(e).ok], [true, true]);
    fs.rmSync(path.join(w.runtime, S.SHIM));
    assert.strictEqual(S.status(e).enabled, false, 'without hook.cmd the hook has nothing to run');
  });
}

test('the Windows check is not fooled by a shell that exits 0 without running the hook', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aicost-chk-'));
  const answers = (stdout) => () => ({ status: 0, stdout, stderr: '' });
  const ran = JSON.stringify({ modifiedPrompt: 'Reply with exactly this one line' });
  assert.strictEqual(S.checkWindows('x', tmp, answers(ran)).ok, true);
  const quiet = S.checkWindows('x', tmp, answers('C:\\Users\\u\\hook.cmd\n')); // PowerShell echoing a quoted path
  assert.strictEqual(quiet.ok, false);
  assert.match(quiet.output, /^cmd\.exe: it exited without running the hook\nPowerShell: it exited without running the hook$/);
  const half = S.checkWindows('x', tmp, (c) => (c === 'powershell.exe' ? { status: 1, stdout: '', stderr: 'At line:1 char:36\r\n+ "a" "b" hook\r\n+     ~~~\r\nUnexpected token \'"b"\' in expression or statement.\r\n' } : { status: 0, stdout: ran, stderr: '' }));
  assert.deepStrictEqual([half.ok, half.status, half.output], [false, 1, 'PowerShell: Unexpected token \'"b"\' in expression or statement.']);
});
