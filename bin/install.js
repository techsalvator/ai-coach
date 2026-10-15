#!/usr/bin/env node
'use strict';
// One-command setup for ai-cost-coach: the Copilot CLI plugin, which also carries the token logger.
//
//   npx github:techsalvator/ai-coach            install the plugin (asks first)
//   node bin/install.js                             the same, from a clone
//   ... --yes                                       do not ask
//   ... --dry-run                                   show what would run, change nothing
//   ... --uninstall                                 remove the plugin (and a separate logger copy, if present)
//   ... --user-extension                            ALSO copy the token logger to ~/.copilot/extensions/ (fallback)
//   ... --source <owner/repo|path>                  where the plugin is installed from (default: this repo's GitHub)
//   ... --from-here                                 install the plugin from the checkout this script is in (to test a branch or a clone)
//   When VS Code is found, the chat hook (/cost and cost tips in VS Code's chat) and the "AI cost: …" tasks are
//   added too (and removed by --uninstall):
//   ... --no-vscode-hook | --no-vscode-tasks        leave one out
//   ... --dir <path>                                extensions folder for --user-extension (default: $COPILOT_HOME/extensions)
//
// The plugin includes extensions/ai-cost/ (the /cost command and the token logger), which Copilot CLI (verified on 1.0.90) loads when the
// plugin is installed and extensions are on (`/experimental on`). Copying the logger to the user folder as well
// would record every call twice, so that is opt-in, for Copilot versions that do not load plugin extensions.
// This script changes Copilot's user-level config, which is why it asks first. The Claude Code report needs no
// install: see INSTALL.md.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const ext = require('./install-extension');
const vscode = require('./vscode-tasks');
const vscodeHook = require('./vscode-hook');

const PLUGIN = 'ai-cost-coach';
const LEGACY_PLUGIN = 'ai-cost-drilldown'; // the plugin's earlier name: still found and removed
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const DEFAULT_SOURCE = String(pkg.repository || '').replace(/^github:/, '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');

class UsageError extends Error {}

function parse(argv) {
  const o = { yes: false, dryRun: false, plugin: true, extension: false, uninstall: false, source: DEFAULT_SOURCE, dir: null, tasks: null, tasksFile: null, hook: null }; // tasks/hook: null = when VS Code is found
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`); return argv[++i]; };
    if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--user-extension') o.extension = true;
    else if (a === '--no-plugin') o.plugin = false;
    else if (a === '--uninstall') o.uninstall = true;
    else if (a === '--source') o.source = val();
    else if (a === '--from-here') o.source = path.resolve(__dirname, '..');
    else if (a === '--vscode-tasks') o.tasks = true;
    else if (a === '--vscode-hook') o.hook = true;
    else if (a === '--no-vscode-tasks') o.tasks = false;
    else if (a === '--no-vscode-hook') o.hook = false;
    else if (a === '--tasks-file') { o.tasks = true; o.tasksFile = val(); }
    else if (a === '--dir') o.dir = val();
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new UsageError(`unknown option ${a}`);
  }
  if (!o.plugin && !o.extension && !o.uninstall) throw new UsageError('nothing to do: --no-plugin needs --user-extension');
  if (o.plugin && !o.source) throw new UsageError('no plugin source known: pass --source <owner/repo>');
  return o;
}

const HELP = [
  'usage: install.js [--yes] [--dry-run] [--uninstall] [--from-here | --source <owner/repo|path>] [--no-vscode-tasks] [--no-vscode-hook] [--user-extension [--no-plugin]] [--dir <extensions folder>]',
  'Installs the ai-cost-coach Copilot CLI plugin, which includes the token logger (asks first).',
].join('\n');

/** Runs a command; {status, stdout, stderr, missing}. */
function defaultExec(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', timeout: 180000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', missing: Boolean(r.error && r.error.code === 'ENOENT') };
}

function defaultConfirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
  });
}

const tail = (r) => `${r.stderr}${r.stdout}`.trim().split('\n').slice(-4).join('\n  ');

/**
 * The installer. deps: {env, exec, confirm, log, tty, home} are injectable for tests.
 * Returns the exit code.
 */
async function run(argv, deps = {}) {
  const env = deps.env || process.env;
  const exec = deps.exec || defaultExec;
  const confirm = deps.confirm || defaultConfirm;
  const log = deps.log || console.log;
  const tty = deps.tty !== undefined ? deps.tty : Boolean(process.stdin.isTTY);
  const o = parse(argv);
  if (o.help) { log(HELP); return 0; }

  const extArgs = o.dir ? ['--dir', o.dir] : [];
  const extRoot = o.dir || path.join(env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'extensions');
  const userCopy = path.join(extRoot, 'ai-cost');
  const hasUserCopy = ['ai-cost', 'ai-cost-token-logger'].some((n) => fs.existsSync(path.join(extRoot, n)));
  const copilotHome = env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
  const direct = (n) => path.join(copilotHome, 'installed-plugins', '_direct', n);
  // The folder the plugin is installed in, under whichever of its names it has.
  const installedName = !fs.existsSync(direct(PLUGIN)) && fs.existsSync(direct(LEGACY_PLUGIN)) ? LEGACY_PLUGIN : PLUGIN;
  const verb = o.uninstall ? 'Remove' : 'Install';
  const plan = [];
  if (o.plugin) plan.push(o.uninstall ? `copilot plugin uninstall ${installedName}` : `copilot plugin install ${o.source}   (the plugin includes the token logger)`);
  if (o.extension && !o.uninstall) {
    plan.push(`copy the token logger to ${userCopy}/`);
    if (o.plugin) plan.push('  (the plugin already includes it, so every call would be recorded twice; the reports count each once)');
  }
  if (o.uninstall && (o.extension || hasUserCopy)) plan.push(`remove the separate token-logger copy at ${userCopy}/`);
  // VS Code tasks: they must point at a folder that stays, so the installed plugin, else this checkout.
  const installedPlugin = direct(installedName);
  const tasksFile = o.tasksFile || vscode.userTasksFile(deps.home || os.homedir(), process.platform, env);
  // Both VS Code parts are added whenever VS Code is found (its user folder exists); --no-vscode-* leaves one out.
  const hasVscode = Boolean(vscode.userTasksFile(deps.home || os.homedir(), process.platform, env));
  if (o.tasks === null) o.tasks = hasVscode && !o.uninstall;
  if (o.hook === null) o.hook = hasVscode && !o.uninstall;
  const doTasks = Boolean(tasksFile) && (o.tasks || (o.uninstall && fs.existsSync(tasksFile)));
  if (o.tasks && !tasksFile) plan.push('VS Code tasks: VS Code\'s user folder was not found, so none are added');
  else if (doTasks) plan.push(o.uninstall ? `remove the "AI cost: …" tasks from ${tasksFile}` : `add "AI cost: …" tasks to ${tasksFile} (a backup is kept)`);
  // VS Code chat hook: one file in ~/.copilot/hooks (VS Code's own user location; COPILOT_HOME does not move it).
  const home = deps.home || os.homedir();
  const hookPath = vscodeHook.hookFile(home);
  const doHook = o.hook || (o.uninstall && fs.existsSync(hookPath));
  if (doHook) plan.push(o.uninstall ? `remove the VS Code chat hook ${hookPath}` : `add the VS Code chat hook ${hookPath} (/cost and cost tips in VS Code's chat)`);
  log([`${verb} ai-cost-coach. This will:`, ...plan.map((p) => `  - ${p}`)].join('\n'));
  if (o.dryRun) { log('\nDry run: nothing was changed.'); return 0; }

  if (!o.yes) {
    if (!tty) { log('\nNot a terminal: re-run with --yes to proceed without asking.'); return 1; }
    if (!(await confirm('\nProceed?'))) { log('Cancelled; nothing was changed.'); return 1; }
  }

  let failed = false;
  let noCli = false;
  /**
   * The folder the VS Code hook and tasks run the scripts from: the installed plugin, else this checkout. A copy
   * fetched by npx sits in a cache npm clears, so it is first copied to <AI_COST_HOME>/app, which stays.
   */
  const here = deps.here || path.resolve(__dirname, '..');
  const appDir = path.join(env.AI_COST_HOME || require('../lib/paths').defaultHome(home), 'app');
  let stableRoot = null;
  const scriptsRoot = () => {
    if (stableRoot) return stableRoot;
    if (fs.existsSync(path.join(installedPlugin, 'bin', 'cost.js'))) stableRoot = installedPlugin;
    else if (!vscode.isTransient(here)) stableRoot = here;
    else {
      fs.rmSync(appDir, { recursive: true, force: true });
      fs.mkdirSync(appDir, { recursive: true });
      for (const n of ['bin', 'lib', 'package.json']) fs.cpSync(path.join(here, n), path.join(appDir, n), { recursive: true });
      log(`Copied the scripts to ${appDir} (this run came from npm's temporary cache).`);
      stableRoot = appDir;
    }
    return stableRoot;
  };
  if (o.plugin) {
    if (o.uninstall) {
      const r = exec('copilot', ['plugin', 'uninstall', installedName]);
      if (r.missing) log('Plugin: Copilot CLI is not installed here, so there is no plugin to remove.');
      else if (r.status !== 0) { log(`Plugin: uninstall failed (maybe it was not installed):\n  ${tail(r)}`); failed = true; }
      else log('Plugin: removed.');
    } else {
      const r = exec('copilot', ['plugin', 'install', o.source]);
      const text = `${r.stderr}${r.stdout}`;
      if (r.missing) {
        // No Copilot CLI: not a failure when the VS Code parts can still be set up (they need only Node).
        noCli = true;
        log(`Plugin: skipped, the \`copilot\` command was not found on PATH. ${doHook || doTasks ? 'The VS Code parts below do not need it.' : ''}`.trim());
        log(`  For /cost inside Copilot CLI: install Copilot CLI, then run  copilot plugin install ${o.source}`);
        if (!doHook && !doTasks) failed = true;
      } else if (r.status === 0) {
        // Installing again over an existing install succeeds, so there is no separate "update" case.
        log('Plugin: installed.');
        if (/deprecated/i.test(text)) log('  (Copilot warns that installing a plugin straight from a repository or path is deprecated in favour of marketplaces.)');
      } else if (/No plugin\.json found/i.test(text)) {
        // Copilot read the repository (so access works) but the manifest is not on its default branch.
        log('Plugin: Copilot reached the repository but found no plugin.json there (it looks in .plugin/, the root, .github/plugin/ and .claude-plugin/).');
        log('  The plugin code is probably not on the default branch yet: merge or push it first. Until then,');
        log('  `copilot --plugin-dir <clone>` loads it for one session.');
        failed = true;
      } else {
        log(`Plugin: could not install it:\n  ${tail(r)}`);
        log('  Check you can read the repository (gh auth status). Without installing, `copilot --plugin-dir <clone>` loads it for one session.');
        failed = true;
      }
    }
  }
  if (o.extension || (o.uninstall && hasUserCopy)) {
    try {
      for (const line of ext.run([...(o.uninstall ? ['--uninstall'] : []), ...extArgs], env)) log(`Extension: ${line}`);
    } catch (err) {
      log(`Extension: ${err.message}`);
      failed = true;
    }
  }

  if (doTasks) {
    try {
      const root = o.uninstall ? here : scriptsRoot();
      const r = vscode.mergeTasksFile(tasksFile, { root, remove: o.uninstall });
      log(`VS Code tasks: ${r.status === 'skipped' ? r.reason : r.status}${r.backup ? ' (backup: tasks.json.bak)' : ''}${o.uninstall || r.status === 'skipped' ? '' : `; they run the scripts in ${root}`}.`);
    } catch (err) {
      log(`VS Code tasks: ${err.message}`);
      failed = true;
    }
  }

  if (doHook) {
    try {
      const root = o.uninstall ? here : scriptsRoot();
      const r = vscodeHook.apply({ root, home, remove: o.uninstall });
      log(`VS Code chat hook: ${r.status} (${r.file})${o.uninstall ? '' : `; it runs the scripts in ${root}`}.`);
    } catch (err) {
      log(`VS Code chat hook: ${err.message}`);
      failed = true;
    }
  }

  if (o.uninstall && fs.existsSync(path.join(appDir, 'bin', 'cost.js'))) {
    fs.rmSync(appDir, { recursive: true, force: true });
    log(`Removed the copied scripts at ${appDir}.`);
  }

  if (!o.uninstall) {
    const notes = [];
    if (o.plugin && !failed && hasUserCopy && !o.extension) {
      notes.push(`A separate token-logger copy is installed at ${userCopy}. The plugin includes the logger, so each call is now recorded twice. Remove the copy: node bin/install-extension.js --uninstall`);
    }
    if (!noCli) {
      notes.push('Turn extensions on once (the plugin\'s extension adds the bare /cost and the token log): `/experimental on` in Copilot, or start `copilot --experimental`.');
      notes.push(`Open a new Copilot session and run \`/cost help\` (or \`/${PLUGIN}:cost help\` without experimental mode), then \`/tokenlog\`.`);
    } else if (stableRoot) {
      notes.push(`From a terminal the same reports are: node "${path.join(stableRoot, 'bin', 'cost.js')}" help`);
    }
    if (o.tasks && doTasks) notes.push('In VS Code: Command Palette → Tasks: Run Task → "AI cost: …".');
    if (o.hook && doHook) notes.push('In VS Code: open a new chat and send `/cost` (the report opens in an editor tab, no AI credits).');
    notes.push(`Claude Code needs no install: run \`! node ${stableRoot ? path.join(stableRoot, 'bin', 'claude-cost.js') : '<clone>/bin/claude-cost.js'}\` (see INSTALL.md).`);
    log(['\nNext:', ...notes.map((n) => `  - ${n}`)].join('\n'));
  }
  return failed ? 1 : 0;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`install: ${err instanceof UsageError ? err.message : err.stack}`);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}

module.exports = { run, parse, DEFAULT_SOURCE };
