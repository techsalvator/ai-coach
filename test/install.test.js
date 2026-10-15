// node --test test/*.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { run, parse, DEFAULT_SOURCE } = require('../bin/install');

/** Runs the installer with a fake `copilot` and a temp extensions folder. */
async function go(argv, { responses = [], tty = true, confirm = true, preinstalled = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-'));
  const userCopy = path.join(dir, 'ai-cost');
  if (preinstalled) { fs.mkdirSync(userCopy); fs.writeFileSync(path.join(userCopy, 'extension.mjs'), '// old copy\n'); }
  const calls = [];
  const out = [];
  const exec = (cmd, args) => { calls.push([cmd, ...args].join(' ')); return responses.shift() || { status: 0, stdout: '', stderr: '' }; };
  const code = await run([...argv, '--dir', dir], { exec, confirm: async () => confirm, log: (s) => out.push(s), tty, home: dir, env: { COPILOT_HOME: dir } });
  return { code, calls, out: out.join('\n'), dir, hasCopy: () => fs.existsSync(userCopy) };
}

test('the default source is this repository on GitHub', () => {
  assert.strictEqual(DEFAULT_SOURCE, 'techsalvator/ai-coach');
  assert.strictEqual(parse([]).source, 'techsalvator/ai-coach');
});

test('--yes installs the plugin only (it carries the token logger) and says what to do next', async () => {
  const r = await go(['--yes']);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.calls, ['copilot plugin install techsalvator/ai-coach']);
  assert.ok(!r.hasCopy(), 'no second copy of the logger');
  assert.match(r.out, /Plugin: installed/);
  assert.match(r.out, /\/experimental on/);
  assert.match(r.out, /\/ai-cost-coach:cost help.*\/tokenlog/);
});

test('it asks first; declining changes nothing', async () => {
  const r = await go([], { confirm: false });
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(r.calls, []);
  assert.match(r.out, /Cancelled/);
});

test('not a terminal and no --yes: refuses rather than guessing', async () => {
  const r = await go([], { tty: false });
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(r.calls, []);
  assert.match(r.out, /re-run with --yes/);
});

test('--dry-run shows the plan and runs nothing', async () => {
  const r = await go(['--dry-run']);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.calls, []);
  assert.match(r.out, /copilot plugin install techsalvator\/ai-coach/);
  assert.match(r.out, /Dry run/);
});

test('--user-extension also copies the logger, and warns it would then be recorded twice', async () => {
  const r = await go(['--yes', '--user-extension']);
  assert.ok(r.hasCopy());
  assert.match(r.out, /every call would be recorded twice/);
  const only = await go(['--yes', '--no-plugin', '--user-extension']);
  assert.deepStrictEqual(only.calls, []);
  assert.ok(only.hasCopy());
  assert.throws(() => parse(['--no-plugin']), /nothing to do/);
});

test('an older separate copy is flagged after installing the plugin, with how to remove it', async () => {
  const r = await go(['--yes'], { preinstalled: true });
  assert.match(r.out, /separate token-logger copy is installed/);
  assert.match(r.out, /recorded twice/);
  assert.match(r.out, /install-extension\.js --uninstall/);
  assert.ok(r.hasCopy(), 'it is only flagged, not removed');
});

test('an old-named separate copy (ai-cost-token-logger) is also flagged and removed on uninstall', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-'));
  fs.mkdirSync(path.join(dir, 'ai-cost-token-logger'));
  const out = [];
  const deps = { exec: () => ({ status: 0, stdout: '', stderr: '' }), confirm: async () => true, log: (s) => out.push(s), tty: true, home: dir, env: { COPILOT_HOME: dir } };
  await run(['--yes', '--dir', dir], deps);
  assert.match(out.join('\n'), /separate token-logger copy is installed/);
  await run(['--yes', '--uninstall', '--dir', dir], deps);
  assert.ok(!fs.existsSync(path.join(dir, 'ai-cost-token-logger')));
});

test('installing again over an existing plugin just succeeds; a deprecation warning is noted', async () => {
  const r = await go(['--yes'], { responses: [{ status: 0, stdout: 'Warning: Direct plugin installs (repos, URLs, local paths) are deprecated.', stderr: '' }] });
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.calls, ['copilot plugin install techsalvator/ai-coach']);
  assert.match(r.out, /deprecated in favour of marketplaces/);
});

test('no plugin.json on the default branch: says so', async () => {
  const msg = 'Failed to install plugin: Error: Request plugins.install failed with message: No plugin.json found in repository. Tried: .plugin/plugin.json, ./plugin.json';
  const r = await go(['--yes'], { responses: [{ status: 1, stdout: '', stderr: msg }] });
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /reached the repository but found no plugin\.json/);
  assert.match(r.out, /not on the default branch yet/);
});

test('any other install failure is reported once, with the access hint', async () => {
  const r = await go(['--yes'], { responses: [{ status: 1, stdout: '', stderr: 'repository not found' }] });
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /could not install it:\n  repository not found/);
  assert.match(r.out, /gh auth status/);
});

test('copilot not on PATH: prints the manual command', async () => {
  const r = await go(['--yes'], { responses: [{ status: null, stdout: '', stderr: '', missing: true }] });
  assert.strictEqual(r.code, 1, 'nothing could be installed: no Copilot CLI and no VS Code');
  assert.match(r.out, /`copilot` command was not found/);
  assert.match(r.out, /copilot plugin install techsalvator\/ai-coach/);
});

test('no Copilot CLI but VS Code: the plugin is skipped, the chat hook and tasks are still set up (from npx: via a kept copy)', async () => {
  const vh = require('../bin/vscode-hook');
  const make = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-nocli-'));
    const users = [['Library', 'Application Support'], ['AppData', 'Roaming'], ['.config']].map((p) => path.join(dir, ...p, 'Code', 'User'));
    for (const u of users) fs.mkdirSync(u, { recursive: true });
    const out = [];
    const deps = { exec: () => ({ status: null, stdout: '', stderr: '', missing: true }), log: (l) => out.push(l), tty: true, home: dir, env: { COPILOT_HOME: path.join(dir, '.copilot') } };
    const command = () => JSON.parse(fs.readFileSync(vh.hookFile(dir), 'utf8')).hooks.UserPromptSubmit[0].command;
    return { dir, deps, out, command, tasks: () => users.map((u) => path.join(u, 'tasks.json')).find((f) => fs.existsSync(f)) };
  };
  // from a clone: the hook and tasks point at the clone
  const a = make();
  assert.strictEqual(await run(['--yes', '--dir', a.dir], a.deps), 0, a.out.join('\n'));
  const here = path.resolve(__dirname, '..');
  assert.ok(a.command().includes(`${here.replace(/\\/g, '/')}/bin/cost.js`));
  assert.ok(a.tasks());
  const text = a.out.join('\n');
  assert.match(text, /Plugin: skipped, the `copilot` command was not found on PATH\. The VS Code parts below do not need it\./);
  assert.doesNotMatch(text, /experimental on|tokenlog/, 'no Copilot CLI next steps');
  assert.match(text, /From a terminal the same reports are: node ".*bin.cost\.js" help/);
  // from npx: the scripts are copied somewhere that stays, and removed again on --uninstall
  const b = make();
  const cache = path.join(b.dir, '_npx', 'abc123', 'node_modules', 'ai-cost-coach');
  for (const d of ['bin', 'lib']) fs.cpSync(path.join(here, d), path.join(cache, d), { recursive: true });
  fs.copyFileSync(path.join(here, 'package.json'), path.join(cache, 'package.json'));
  assert.strictEqual(await run(['--yes', '--dir', b.dir], { ...b.deps, here: cache }), 0, b.out.join('\n'));
  const app = path.join(b.dir, '.ai-cost-coach', 'app');
  assert.ok(fs.existsSync(path.join(app, 'lib', 'coach.js')) && fs.existsSync(path.join(app, 'bin', 'cost.js')));
  assert.ok(b.command().includes(`${app.replace(/\\/g, '/')}/bin/cost.js`), b.command());
  assert.ok(fs.readFileSync(b.tasks(), 'utf8').includes('.ai-cost-coach/app'));
  assert.strictEqual(await run(['--yes', '--uninstall', '--dir', b.dir], { ...b.deps, here: cache }), 0, b.out.join('\n'));
  assert.ok(!fs.existsSync(app) && !fs.existsSync(vh.hookFile(b.dir)));
});

test('--source changes where the plugin comes from (a repository or a local path)', async () => {
  const r = await go(['--yes', '--source', '/tmp/some/clone']);
  assert.deepStrictEqual(r.calls, ['copilot plugin install /tmp/some/clone']);
});

test('--from-here installs the plugin from the checkout the installer is in (to test a branch or a clone)', async () => {
  const r = await go(['--yes', '--from-here']);
  assert.deepStrictEqual(r.calls, [`copilot plugin install ${path.resolve(__dirname, '..')}`]);
  assert.ok(fs.existsSync(path.join(path.resolve(__dirname, '..'), 'plugin.json')), 'that folder holds the plugin');
});

test('--uninstall removes the plugin and a separate logger copy, keeping the log', async () => {
  const r = await go(['--yes', '--uninstall'], { preinstalled: true });
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.calls, ['copilot plugin uninstall ai-cost-coach']);
  assert.ok(!r.hasCopy());
  assert.match(r.out, /token log is kept/);
  const plain = await go(['--yes', '--uninstall']);
  assert.ok(!/separate token-logger copy/.test(plain.out));
});

test('--vscode-hook writes the chat hook file, pointing at the installed plugin when there is one; --uninstall removes it', async () => {
  const vh = require('../bin/vscode-hook');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-hook-'));
  const plugin = path.join(dir, 'installed-plugins', '_direct', 'ai-cost-coach');
  fs.mkdirSync(path.join(plugin, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'bin', 'cost.js'), '');
  const out = [];
  const deps = { exec: () => ({ status: 0, stdout: '', stderr: '' }), log: (s) => out.push(s), tty: true, home: dir, env: { COPILOT_HOME: dir } };
  assert.strictEqual(await run(['--yes', '--vscode-hook', '--dir', dir], deps), 0);
  const file = vh.hookFile(dir);
  const hook = JSON.parse(fs.readFileSync(file, 'utf8')).hooks.UserPromptSubmit[0];
  assert.strictEqual(hook.command, `node "${path.join(plugin, 'bin', 'cost.js').replace(/\\/g, '/')}" hook --vscode`);
  assert.match(out.join('\n'), /VS Code chat hook: written/);
  assert.strictEqual(vh.apply({ root: plugin, home: dir }).status, 'unchanged');
  assert.strictEqual(await run(['--yes', '--uninstall', '--dir', dir], deps), 0);
  assert.ok(!fs.existsSync(file));
  assert.throws(() => vh.apply({ root: path.join(dir, 'nowhere'), home: dir }), /no bin\/cost\.js/);
  assert.throws(() => vh.apply({ root: '/x/_npx/abc', home: dir }), /no bin\/cost\.js|npx cache/);
});

test('with VS Code present the tasks and the chat hook are added by default; --no-vscode-* leaves them out; without VS Code neither', async () => {
  const vh = require('../bin/vscode-hook');
  const make = (withCode) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-default-'));
    const plugin = path.join(dir, 'installed-plugins', '_direct', 'ai-cost-coach');
    fs.mkdirSync(path.join(plugin, 'bin'), { recursive: true });
    for (const f of ['cost.js', 'claude-cost.js']) fs.writeFileSync(path.join(plugin, 'bin', f), '');
    const users = [['Library', 'Application Support'], ['AppData', 'Roaming'], ['.config']].map((p) => path.join(dir, ...p, 'Code', 'User'));
    if (withCode) for (const u of users) fs.mkdirSync(u, { recursive: true });
    const out = [];
    const deps = { exec: () => ({ status: 0, stdout: '', stderr: '' }), log: (l) => out.push(l), tty: true, home: dir, env: { COPILOT_HOME: dir } };
    return { dir, deps, out, tasks: () => users.some((u) => fs.existsSync(path.join(u, 'tasks.json'))), hook: () => fs.existsSync(vh.hookFile(dir)) };
  };
  const a = make(true);
  assert.strictEqual(await run(['--yes', '--dir', a.dir], a.deps), 0);
  assert.ok(a.tasks() && a.hook(), a.out.join('\n'));
  assert.match(a.out.join('\n'), /send `\/cost`/);
  const b = make(true);
  assert.strictEqual(await run(['--yes', '--no-vscode-tasks', '--no-vscode-hook', '--dir', b.dir], b.deps), 0);
  assert.ok(!b.tasks() && !b.hook());
  const c = make(false);
  assert.strictEqual(await run(['--yes', '--dir', c.dir], c.deps), 0);
  assert.ok(!c.tasks() && !c.hook());
  assert.doesNotMatch(c.out.join('\n'), /VS Code/);
});
