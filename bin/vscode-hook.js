#!/usr/bin/env node
'use strict';
// VS Code Copilot Chat: /cost and the cost tips, through a chat hook.
//
//   node bin/vscode-hook.js              write ~/.copilot/hooks/ai-cost-drilldown.json
//   node bin/vscode-hook.js --uninstall  remove it
//   ... --root <folder>                  the ai-cost-drilldown folder the hook runs (default: this checkout)
//
// VS Code's agent chat loads hook files from ~/.copilot/hooks (no setting needed). The hook runs
// `node <root>/bin/cost.js hook --vscode` on every prompt: /cost reports open in an editor tab with no model
// call, and a prompt about to cost more than it needs to gets a one-line tip. Copilot CLI reads the same
// folder; there the hook recognises the CLI and does nothing, because the plugin's own hook answers.

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'ai-cost-drilldown.json';

/** The hook file VS Code reads for this user. */
const hookFile = (home = os.homedir()) => path.join(home, '.copilot', 'hooks', NAME);

/** The file's content for a given ai-cost-drilldown folder. */
function content(root) {
  const script = path.join(root, 'bin', 'cost.js').replace(/\\/g, '/');
  return { hooks: { UserPromptSubmit: [{ type: 'command', command: `node "${script}" hook --vscode`, timeout: 120 }] } };
}

const isTransient = (dir) => /[\\/]_npx[\\/]/.test(dir);

/** Writes or removes the hook file. Returns {status: 'written'|'unchanged'|'removed'|'absent', file}. */
function apply({ root, home = os.homedir(), remove = false } = {}) {
  const file = hookFile(home);
  if (remove) {
    if (!fs.existsSync(file)) return { status: 'absent', file };
    fs.unlinkSync(file);
    return { status: 'removed', file };
  }
  if (!fs.existsSync(path.join(root, 'bin', 'cost.js'))) throw new Error(`${root} has no bin/cost.js: pass --root <ai-cost-drilldown folder>`);
  if (isTransient(root)) throw new Error(`${root} is inside npm's temporary npx cache; clone the repository and pass --root <clone>`);
  const text = `${JSON.stringify(content(root), null, 2)}\n`;
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return { status: 'unchanged', file };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { status: 'written', file };
}

function run(argv, { home = os.homedir() } = {}) {
  const o = { root: path.resolve(__dirname, '..'), remove: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--uninstall') o.remove = true;
    else if (argv[i] === '--root' && argv[i + 1]) o.root = path.resolve(argv[++i]);
    else throw new Error(`unknown option ${argv[i]} (usage: vscode-hook.js [--uninstall] [--root <folder>])`);
  }
  const r = apply({ ...o, home });
  return `VS Code chat hook: ${r.status} (${r.file})${r.status === 'written' ? `; it runs ${o.root}/bin/cost.js. Open a new chat in VS Code and send /cost.` : '.'}`;
}

if (require.main === module) {
  try { console.log(run(process.argv.slice(2))); } catch (err) { console.error(`vscode-hook: ${err.message}`); process.exit(1); }
}

module.exports = { hookFile, content, apply, run, isTransient };
