// node --test test/*.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { tasksFor, INPUTS, parseJsonc, mergeTasksFile, userTasksFile, isTransient, run } = require('../bin/vscode-tasks');
const install = require('../bin/install');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-tasks-'));
const ROOT = path.resolve(__dirname, '..');

test('creates a tasks.json when there is none', () => {
  const file = path.join(tmp(), 'tasks.json');
  const r = mergeTasksFile(file, { root: ROOT });
  assert.strictEqual(r.status, 'created');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(doc.tasks.length, 7);
  assert.ok(doc.tasks.every((t) => t.label.startsWith('AI cost: ') && t.command.startsWith(`node "${ROOT.replace(/\\/g, '/')}/bin/`)));
  assert.strictEqual(doc.inputs.length, INPUTS.length);
});

test('keeps the user\'s own tasks and inputs (and PhantomFlow\'s), backs up, is repeatable, and removes only its own', () => {
  const file = path.join(tmp(), 'tasks.json');
  fs.writeFileSync(file, '{\n  // mine\n  "version": "2.0.0",\n  "tasks": [ { "label": "mine", "type": "shell", "command": "echo hi" }, { "label": "PhantomFlow: cost — prompts", "command": "x" }, ],\n  "inputs": [ { "id": "pfSince", "type": "pickString", "options": ["7d"] } ]\n}\n');
  assert.strictEqual(mergeTasksFile(file, { root: ROOT }).status, 'updated');
  assert.ok(fs.readFileSync(`${file}.bak`, 'utf8').includes('// mine'));
  let doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(doc.tasks.slice(0, 2).map((t) => t.label), ['mine', 'PhantomFlow: cost — prompts']);
  assert.strictEqual(doc.tasks.length, 9);
  assert.ok(doc.inputs.some((i) => i.id === 'pfSince'));
  assert.strictEqual(mergeTasksFile(file, { root: ROOT }).status, 'unchanged');
  assert.strictEqual(mergeTasksFile(file, { root: '/other/place' }).status, 'updated');           // a new root rewrites the commands
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.length, 9);
  assert.strictEqual(mergeTasksFile(file, { remove: true }).status, 'removed');
  doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(doc.tasks.map((t) => t.label), ['mine', 'PhantomFlow: cost — prompts']);
  assert.deepStrictEqual(doc.inputs.map((i) => i.id), ['pfSince']);
  assert.strictEqual(mergeTasksFile(file, { remove: true }).status, 'unchanged');
});

test('leaves a file it cannot parse untouched', () => {
  const file = path.join(tmp(), 'tasks.json');
  fs.writeFileSync(file, '{ not json');
  assert.strictEqual(mergeTasksFile(file, { root: ROOT }).status, 'skipped');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json');
  assert.deepStrictEqual(parseJsonc('{ "a": 1, // c\n "b": "x//y", /* z */ }'), { a: 1, b: 'x//y' });
});

test('every input a task uses is defined, and a Windows root gets forward slashes', () => {
  const ids = new Set(INPUTS.map((i) => i.id));
  for (const t of tasksFor(ROOT)) for (const m of t.command.matchAll(/\$\{input:(\w+)\}/g)) assert.ok(ids.has(m[1]), m[1]);
  assert.ok(tasksFor('C:\\Users\\me\\ai-cost-drilldown')[0].command.startsWith('node "C:/Users/me/ai-cost-drilldown/bin/cost.js"'));
  assert.ok(isTransient('/Users/me/.npm/_npx/abc/node_modules/ai-cost-drilldown') && !isTransient(ROOT));
});

test('the command line: --file, a root without the scripts, the npx cache, and --uninstall', () => {
  const file = path.join(tmp(), 'tasks.json');
  assert.match(run(['--file', file]).join('\n'), /created[^]*7 tasks run the scripts/);
  assert.throws(() => run(['--file', file, '--root', os.tmpdir()]), /does not hold bin\/cost\.js/);
  assert.match(run(['--file', file, '--uninstall']).join('\n'), /removed/);
  assert.throws(() => run(['--bogus']), /unknown option/);
  assert.strictEqual(userTasksFile('/no/such/home', 'darwin', {}), null);
});

test('the installer adds the tasks with --vscode-tasks and removes them on --uninstall', async () => {
  const dir = tmp();
  const file = path.join(dir, 'tasks.json');
  const out = [];
  const deps = { exec: () => ({ status: 0, stdout: '', stderr: '' }), confirm: async () => true, log: (s) => out.push(s), tty: true, home: dir, env: { COPILOT_HOME: dir } };
  assert.strictEqual(await install.run(['--yes', '--dir', dir, '--tasks-file', file], deps), 0);
  assert.match(out.join('\n'), /add "AI cost: …" tasks to/);
  assert.match(out.join('\n'), /VS Code tasks: created; they run the scripts in /);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.length, 7);
  assert.strictEqual(await install.run(['--yes', '--uninstall', '--dir', dir, '--tasks-file', file], deps), 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.length, 0);
});

test('the installer points the tasks at the installed plugin when there is one', async () => {
  const dir = tmp();
  const plugin = path.join(dir, 'installed-plugins', '_direct', 'ai-cost-drilldown');
  fs.mkdirSync(path.join(plugin, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'bin', 'cost.js'), '');
  const file = path.join(dir, 'tasks.json');
  const deps = { exec: () => ({ status: 0, stdout: '', stderr: '' }), confirm: async () => true, log: () => {}, tty: true, home: dir, env: { COPILOT_HOME: dir } };
  await install.run(['--yes', '--dir', dir, '--tasks-file', file], deps);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].command.includes(plugin.replace(/\\/g, '/')));
});

test('removing when nothing of ours is there does not rewrite the file (comments survive)', () => {
  const file = path.join(tmp(), 'tasks.json');
  const text = '{\n  // keep me\n  "version": "2.0.0",\n  "tasks": [ { "label": "mine" }, ],\n}\n';
  fs.writeFileSync(file, text);
  assert.strictEqual(mergeTasksFile(file, { remove: true }).status, 'unchanged');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), text);
  assert.ok(!fs.existsSync(`${file}.bak`));
});

test('the installer never looks outside the home it is given', async () => {
  const dir = tmp();     // no VS Code folder here
  const out = [];
  const deps = { exec: () => ({ status: 0, stdout: '', stderr: '' }), confirm: async () => true, log: (s) => out.push(s), tty: true, home: dir, env: { COPILOT_HOME: dir } };
  await install.run(['--yes', '--dir', dir, '--vscode-tasks'], deps);
  assert.match(out.join('\n'), /VS Code's user folder was not found, so none are added/);
  await install.run(['--yes', '--uninstall', '--dir', dir], deps);
  assert.ok(!/AI cost/.test(out.slice(-3).join('\n')));
});
