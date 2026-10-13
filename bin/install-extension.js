#!/usr/bin/env node
'use strict';
// Installs (or removes) the token-logger extension in Copilot CLI's user extensions folder.
//
//   node bin/install-extension.js               copy it to ~/.copilot/extensions/ai-cost/
//   node bin/install-extension.js --uninstall   remove it
//   node bin/install-extension.js --dir <path>  use another extensions folder (default: $COPILOT_HOME/extensions)
//
// The plugin already includes this extension (Copilot CLI loads extensions shipped in plugins), so installing it
// here as well records every call twice. Use it only where the plugin's copy does not load. It changes only that folder.

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'ai-cost';
const LEGACY = ['ai-cost-token-logger']; // the earlier name of this extension; removed with it
const SRC = path.join(__dirname, '..', 'extensions', NAME);

function parse(argv) {
  const o = { uninstall: false, dir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--uninstall') o.uninstall = true;
    else if (argv[i] === '--dir') { o.dir = argv[++i]; if (!o.dir) throw new Error('--dir needs a path'); }
    else if (argv[i] === '-h' || argv[i] === '--help') o.help = true;
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return o;
}

/** Installs or removes the extension; returns the lines to print. */
function run(argv, env = process.env) {
  const o = parse(argv);
  if (o.help) return ['usage: install-extension.js [--uninstall] [--dir <extensions folder>]'];
  const root = o.dir || path.join(env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'extensions');
  const dst = path.join(root, NAME);
  if (o.uninstall) {
    const found = [NAME, ...LEGACY].map((n) => path.join(root, n)).filter((p) => fs.existsSync(p));
    if (!found.length) return [`${NAME} is not installed in ${root}.`];
    for (const p of found) fs.rmSync(p, { recursive: true, force: true });
    return found.map((p) => `Removed ${p}. The token log is kept; delete it yourself if you want it gone.`);
  }
  for (const n of LEGACY) fs.rmSync(path.join(root, n), { recursive: true, force: true }); // replaced by ai-cost
  fs.mkdirSync(dst, { recursive: true });
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.mjs'));
  for (const f of files) fs.copyFileSync(path.join(SRC, f), path.join(dst, f));
  const out = [`Installed ${files.length} files to ${dst}.`,
    'Extensions are experimental in Copilot CLI: start `copilot --experimental`, or run `/experimental on` once.',
    'Check it with /tokenlog in a session. Records go to ~/.ai-cost-drilldown/copilot-tokens.jsonl.'];
  if (fs.existsSync(path.join(root, 'phantomflow-cost'))) {
    out.push('The PhantomFlow cost extension is installed too and logs the same events elsewhere; the reports read both and count each call once.');
  }
  return out;
}

if (require.main === module) {
  try {
    console.log(run(process.argv.slice(2)).join('\n'));
  } catch (err) {
    console.error(`install-extension: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { run };
