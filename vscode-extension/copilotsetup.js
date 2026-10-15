'use strict';
// Sets up Copilot tracking from the extension: the three pieces that used to come from the Copilot CLI plugin.
//
//   hook      ~/.copilot/hooks/ai-cost-coach.json   runs the cost-tips hook in VS Code chat and Copilot CLI
//   logger    ~/.copilot/extensions/ai-cost/             records the tokens of every Copilot CLI model call
//   runtime   ~/.ai-cost-coach/runtime/              the scripts the hook runs, copied to a path that survives extension updates
//
// Nothing here touches VS Code. The extension asks first, then calls enable(); every function takes `env` so the
// tests work in a temporary home.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK_NAME = 'ai-cost-coach.json';
const LEGACY_HOOK_NAME = 'ai-cost-drilldown.json'; // the hook file's earlier name: still found, moved and removed
const LOGGER_NAME = 'ai-cost';
const PLUGIN_NAMES = ['ai-cost-drilldown', 'ai-cost-coach']; // the old Copilot CLI plugin, by its earlier and its current name
const SHIM = 'hook.cmd'; // Windows: the file the hook's command names, in the runtime folder
const WIN = process.platform === 'win32';
const slash = (f) => String(f).replace(/\\/g, '/');

const copilotHome = (env = process.env) => env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
/** ~/.ai-cost-coach, except that an existing ~/.ai-cost-drilldown (the folder's earlier name) keeps being used. */
const defaultHome = (home = os.homedir()) => {
  const earlier = path.join(home, '.ai-cost-drilldown');
  return !fs.existsSync(path.join(home, '.ai-cost-coach')) && fs.existsSync(earlier) ? earlier : path.join(home, '.ai-cost-coach');
};
const dataHome = (env = process.env) => env.AI_COST_HOME || env.COPILOT_COST_HOME || defaultHome();

function paths(env = process.env) {
  const c = copilotHome(env);
  const runtime = path.join(dataHome(env), 'runtime');
  return { copilot: c, hook: path.join(c, 'hooks', HOOK_NAME), legacyHook: path.join(c, 'hooks', LEGACY_HOOK_NAME), logger: path.join(c, 'extensions', LOGGER_NAME), runtime, stamp: path.join(runtime, 'VERSION') };
}

/** Where the files to install come from: the folder the .vsix carries, else the repository this runs from. */
function source() {
  // The repository first (so a stale bundled copy never shadows the code being developed), then the copy the .vsix carries.
  for (const dir of [path.join(__dirname, '..'), path.join(__dirname, 'runtime')]) {
    if (fs.existsSync(path.join(dir, 'bin', 'cost.js')) && fs.existsSync(path.join(dir, 'extensions', LOGGER_NAME))) return dir;
  }
  throw new Error('the runtime files are missing from this extension: run `npm run bundle-runtime`');
}

const version = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;

/** A short hash of the scripts the runtime is copied from, so a changed script is noticed even under the same version. */
function fingerprint(src) {
  const h = require('crypto').createHash('sha1');
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else { h.update(path.relative(src, f)); h.update(fs.readFileSync(f)); }
    }
  };
  try { for (const d of ['bin', 'lib']) walk(path.join(src, d)); } catch { return ''; }
  return h.digest('hex').slice(0, 8);
}

/** What the installed runtime is stamped with: the version, and the fingerprint of the scripts it was copied from. */
function stampValue() {
  let fp = '';
  try { fp = fingerprint(source()); } catch { /* no source: the version alone */ }
  return fp ? `${version()}+${fp}` : version();
}

const isExe = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };

/**
 * Where node is, as an absolute path, or null. The hook cannot just say `node`: VS Code starts it with a thin PATH (no
 * Homebrew, nvm or Volta), and the command then fails with "node: command not found" and the prompt runs unchecked.
 */
function findNode(env = process.env) {
  const exe = WIN ? 'node.exe' : 'node';
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) { // inside VS Code, the PATH it resolved from your shell (a stable link, not a versioned folder)
    const f = dir && path.join(dir, exe);
    if (f && isExe(f)) return f;
  }
  if (path.basename(process.execPath).toLowerCase() === exe) return process.execPath; // running under node itself
  if (WIN) { // no login shell to ask: where.exe searches the PATH of this process, then the installers' usual folders
    try {
      const out = spawnSync('where.exe', ['node'], { encoding: 'utf8', timeout: 8000 });
      const found = String(out.stdout || '').split(/\r?\n/).map((x) => x.trim()).find((x) => x.toLowerCase().endsWith('node.exe') && isExe(x));
      if (found) return found;
    } catch { /* try the usual places */ }
    return [env.ProgramFiles && path.join(env.ProgramFiles, 'nodejs', exe), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'nodejs', exe)].filter(Boolean).find(isExe) || null;
  }
  try { // a login shell knows where your node is (nvm, Homebrew, Volta)
    const r = spawnSync(env.SHELL || '/bin/zsh', ['-lc', 'command -v node'], { encoding: 'utf8', timeout: 8000 });
    const f = String(r.stdout || '').trim().split('\n').pop();
    if (f && isExe(f)) return f;
  } catch { /* try the usual places */ }
  return ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'].find(isExe) || null;
}

/** What hook.cmd holds: node by its full path, and the script beside the file (%~dp0 is the folder the .cmd is in). */
const shimContent = (node) => `@echo off\r\n"${node}" "%~dp0bin\\cost.js" hook --vscode\r\n`;

/** Windows: writes hook.cmd into the runtime folder. Returns false when there is no node to put in it. */
function writeShim(p, node, platform = process.platform) {
  if (platform !== 'win32' || !node) return false;
  fs.writeFileSync(path.join(p.runtime, SHIM), shimContent(node));
  return true;
}

/**
 * The hook file's content for a runtime folder and a node: the same file VS Code and Copilot CLI both read.
 *
 * On Windows the command names hook.cmd instead of node and the script. Nothing says which shell starts a hook there, and
 * `"C:/…/node.exe" "C:/…/cost.js" hook` is a command in cmd.exe and Git Bash but a parse error in PowerShell. A path with
 * forward slashes and no quotes runs in all three; a path with a space in it cannot be written that way, so it goes
 * through `cmd /d /c "…"`, which cmd.exe and PowerShell both run.
 */
function hookContent(runtime, node = null, platform = process.platform) {
  let command;
  if (platform === 'win32' && node) {
    const shim = path.win32.join(runtime, SHIM);
    command = /\s/.test(shim) ? `cmd /d /c "${shim}"` : slash(shim);
  } else {
    command = `${node ? `"${slash(node)}"` : 'node'} "${slash(path.join(runtime, 'bin', 'cost.js'))}" hook --vscode`;
  }
  return { hooks: { UserPromptSubmit: [{ type: 'command', command, timeout: 120 }] } };
}

/** True when the old Copilot CLI plugin of this tool is installed (its own hook then answers prompts). */
function pluginInstalled(env = process.env) {
  const root = path.join(copilotHome(env), 'installed-plugins');
  try {
    return fs.readdirSync(root).some((m) => PLUGIN_NAMES.some((n) => fs.existsSync(path.join(root, m, n))));
  } catch { return false; }
}

/** The name the old plugin is installed under (its earlier name unless only the current one is there). */
function pluginName(env = process.env) {
  const root = path.join(copilotHome(env), 'installed-plugins');
  try {
    for (const n of PLUGIN_NAMES) if (fs.readdirSync(root).some((m) => fs.existsSync(path.join(root, m, n)))) return n;
  } catch { /* none */ }
  return PLUGIN_NAMES[0];
}

/** What is in place. `enabled` is true when all three pieces are, and `outdated` when the runtime is from another version. */
function status(env = process.env) {
  const p = paths(env);
  const exists = (f) => fs.existsSync(f);
  let hookTarget = null;
  let bareNode = false;
  let viaShim = false;
  try {
    const cmd = slash(JSON.parse(fs.readFileSync(exists(p.hook) ? p.hook : p.legacyHook, 'utf8')).hooks.UserPromptSubmit[0].command);
    viaShim = cmd.includes(`${slash(p.runtime)}/${SHIM}`);
    hookTarget = viaShim || cmd.includes(`${slash(p.runtime)}/bin/cost.js`) ? 'runtime' : 'other';
    bareNode = /^node\s/.test(cmd); // `node` alone is not found when VS Code starts the hook
  } catch { /* no hook file, or not ours to read */ }
  const hook = hookTarget === 'runtime';
  const logger = exists(path.join(p.logger, 'extension.mjs'));
  const runtime = exists(path.join(p.runtime, 'bin', 'cost.js')) && (!viaShim || exists(path.join(p.runtime, SHIM)));
  const needsShim = WIN && hook && !viaShim; // an earlier setup's command, which PowerShell cannot run
  let stamped = null;
  try { stamped = fs.readFileSync(p.stamp, 'utf8').trim(); } catch { /* none */ }
  return {
    copilotFound: exists(p.copilot), hook, hookTarget, bareNode, needsShim, logger, runtime,
    plugin: pluginInstalled(env), enabled: hook && logger && runtime,
    outdated: runtime && stamped !== stampValue(), paths: p,
  };
}

function copyRuntime(src, p) {
  fs.rmSync(p.runtime, { recursive: true, force: true });
  fs.mkdirSync(path.join(p.runtime, 'bin'), { recursive: true });
  fs.cpSync(path.join(src, 'lib'), path.join(p.runtime, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(src, 'bin', 'cost.js'), path.join(p.runtime, 'bin', 'cost.js'));
  fs.writeFileSync(p.stamp, `${stampValue()}\n`);
}

function copyLogger(src, p) {
  fs.rmSync(p.logger, { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(p.logger), 'ai-cost-token-logger'), { recursive: true, force: true }); // the earlier name
  fs.mkdirSync(p.logger, { recursive: true });
  const from = path.join(src, 'extensions', LOGGER_NAME);
  for (const f of fs.readdirSync(from).filter((x) => x.endsWith('.mjs'))) fs.copyFileSync(path.join(from, f), path.join(p.logger, f));
}

/** Writes all three pieces. Returns what it wrote. Existing copies are replaced; the token log and settings are left alone. */
function enable(env = process.env) {
  const src = source();
  const p = paths(env);
  copyRuntime(src, p);
  copyLogger(src, p);
  fs.mkdirSync(path.dirname(p.hook), { recursive: true });
  const node = findNode(env);
  writeShim(p, node);
  fs.writeFileSync(p.hook, `${JSON.stringify(hookContent(p.runtime, node), null, 2)}\n`);
  fs.rmSync(p.legacyHook, { force: true }); // two hook files would answer every prompt twice
  return { runtime: p.runtime, logger: p.logger, hook: p.hook, node };
}

/** Brings an enabled setup up to this extension's version. Returns true when it changed anything. */
function refresh(env = process.env) {
  const s = status(env);
  if (!s.enabled) return false;
  let changed = false;
  if (fs.existsSync(s.paths.legacyHook)) { // the hook file's earlier name: keep one file, under the current name
    if (!fs.existsSync(s.paths.hook)) fs.renameSync(s.paths.legacyHook, s.paths.hook); else fs.rmSync(s.paths.legacyHook, { force: true });
    changed = true;
  }
  if (s.outdated) { const src = source(); copyRuntime(src, s.paths); copyLogger(src, s.paths); writeShim(s.paths, findNode(env)); changed = true; }
  if (s.bareNode || s.needsShim) { // an earlier setup wrote `node`, or on Windows a command PowerShell cannot run: write it as it should be
    const node = findNode(env);
    if (node) { writeShim(s.paths, node); fs.writeFileSync(s.paths.hook, `${JSON.stringify(hookContent(s.paths.runtime, node), null, 2)}\n`); changed = true; }
  }
  return changed;
}

/**
 * Runs the hook the way VS Code and Copilot start it, with a thin PATH and nothing else, and says whether it worked. This is
 * the check that would have caught "node: command not found". It uses a throwaway data folder, so nothing is recorded.
 */
function check(env = process.env, run = spawnSync) {
  let command;
  try { command = JSON.parse(fs.readFileSync(paths(env).hook, 'utf8')).hooks.UserPromptSubmit[0].command; } catch { return { ok: false, output: 'The hook file is missing or unreadable.' }; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aicost-check-'));
  try {
    if (WIN) return checkWindows(command, tmp, run);
    // No startup files: bash reads ~/.bashrc even for `-c` when its stdin looks like a network connection, which a pipe
    // from this process can, and a .bashrc that adds node to the PATH would make a bare `node` pass a check it should fail.
    const r = run('/bin/bash', ['--noprofile', '--norc', '-c', command], {
      input: JSON.stringify({ sessionId: 'ai-cost-check', prompt: 'check that the hook can run' }), encoding: 'utf8', timeout: 30000,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), AI_COST_HOME: path.join(tmp, 'data'), COPILOT_HOME: path.join(tmp, 'copilot') },
    });
    const output = `${r.stderr || ''}${r.stdout || ''}${r.error ? r.error.message : ''}`.trim();
    return { ok: !r.error && r.status === 0, status: r.status, output };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/**
 * The same check on Windows, from cmd.exe and from PowerShell, since either may be what starts the hook. A shell can exit 0
 * without running anything (PowerShell prints a quoted path and is done), so the hook is asked something it answers:
 * "/cost coach status" comes back as a line for the model, which only the hook itself writes.
 */
function checkWindows(command, tmp, run = spawnSync) {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const thin = {
    PATH: [path.join(root, 'System32'), root, path.join(root, 'System32', 'WindowsPowerShell', 'v1.0')].join(';'),
    SystemRoot: root, ComSpec: process.env.ComSpec || path.join(root, 'System32', 'cmd.exe'), PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
    USERPROFILE: os.homedir(), TEMP: os.tmpdir(), TMP: os.tmpdir(), AI_COST_HOME: path.join(tmp, 'data'), COPILOT_HOME: path.join(tmp, 'copilot'),
  };
  const o = { input: JSON.stringify({ sessionId: 'ai-cost-check', prompt: '/cost coach status' }), encoding: 'utf8', timeout: 30000, env: thin };
  const shells = { 'cmd.exe': () => run(command, [], { ...o, shell: thin.ComSpec }), PowerShell: () => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], o) };
  const failed = []; let status = 0;
  for (const [name, start] of Object.entries(shells)) {
    const res = start();
    if (!res.error && res.status === 0 && String(res.stdout).includes('modifiedPrompt')) continue;
    const why = res.error ? res.error.message : String(res.stderr || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^(At line:|\+|~)/.test(l)) || (res.status ? `exit code ${res.status}` : 'it exited without running the hook');
    failed.push(`${name}: ${why}`);
    status = res.status || 1;
  }
  return { ok: !failed.length, status, output: failed.join('\n') };
}

/** Removes the three pieces. The token log, session cache and coach settings stay. */
function disable(env = process.env) {
  const p = paths(env);
  const removed = [];
  for (const f of [p.hook, p.legacyHook, p.logger, p.runtime]) {
    if (fs.existsSync(f)) { fs.rmSync(f, { recursive: true, force: true }); removed.push(f); }
  }
  return removed;
}

/** Uninstalls the old Copilot CLI plugin through Copilot itself. Returns {ok, output}. */
function removePlugin(env = process.env, run = spawnSync) {
  const r = run('copilot', ['plugin', 'uninstall', pluginName(env)], { encoding: 'utf8', timeout: 60000, env });
  return { ok: !r.error && r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}${r.error ? r.error.message : ''}`.trim() };
}

module.exports = { pluginName, paths, status, enable, refresh, check, checkWindows, findNode, shimContent, SHIM, disable, removePlugin, pluginInstalled, hookContent, source, version };
