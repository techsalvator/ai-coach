#!/usr/bin/env node
'use strict';
/**
 * vscode-tasks — "AI cost: …" tasks for VS Code (Command Palette → Tasks: Run Task).
 *
 * VS Code's chat cannot run Copilot CLI commands, and a prompt file or skill there always goes through the model.
 * A task runs the report scripts of this repo in a terminal instead: no model, no credits.
 *
 *   node bin/vscode-tasks.js                  add or refresh the tasks in VS Code's user tasks.json
 *   node bin/vscode-tasks.js --uninstall      remove them
 *   node bin/vscode-tasks.js --file <path>    another tasks.json (e.g. a project's .vscode/tasks.json)
 *   node bin/vscode-tasks.js --root <path>    where the scripts are (default: this checkout)
 *
 * tasks.json is JSONC (comments, trailing commas). The merge replaces only tasks and inputs this installer owns
 * (label "AI cost: …", input ids "aiCost…"), backs the file up first, and leaves a file it cannot parse untouched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LABEL = 'AI cost: ';
const INPUT_PREFIX = 'aiCost';

/** The tasks, running the scripts under `root` (forward slashes: they work in every VS Code shell). */
function tasksFor(root) {
  const r = String(root).replace(/\\/g, '/');
  const task = (label, detail, script, args) => ({
    label: LABEL + label,
    detail,
    type: 'shell',
    command: `node "${r}/bin/${script}" ${args}`.trim(),
    problemMatcher: [],
    presentation: { reveal: 'always', panel: 'dedicated', clear: true, focus: true },
  });
  return [
    task('latest session', 'Credits, dollars, tokens and tools per prompt of the most recent Copilot CLI session', 'cost.js', '--last 20'),
    task('sessions', 'Recent Copilot CLI sessions', 'cost.js', 'list'),
    task('prompts', 'Prompts across Copilot CLI sessions and VS Code Copilot Chat', 'cost.js', 'prompts --since ${input:aiCostSince} ${input:aiCostPromptsView}'),
    task('epics', 'Cost per Jira epic or ticket', 'cost.js', 'epics --since ${input:aiCostSince} ${input:aiCostEpicsView}'),
    task('advise', 'Where Copilot spend can be cut, measured on your sessions', 'cost.js', 'advise --since ${input:aiCostSince}'),
    task('tools', 'Which tool calls drive context cost', 'cost.js', 'tools --since ${input:aiCostSince} ${input:aiCostToolsView}'),
    task('Claude Code', 'Claude Code cost per prompt, project or epic', 'claude-cost.js', '${input:aiCostClaudeView}'),
  ];
}

const pick = (id, description, options, def) => ({ id, type: 'pickString', description, options, default: def });
const INPUTS = [
  pick('aiCostSince', 'Time window', ['1d', '7d', '30d', 'all'], '7d'),
  pick('aiCostPromptsView', 'View', [
    { label: 'Top prompts by credits', value: '--top 25' },
    { label: 'Top prompts by active time', value: '--top 25 --sort time' },
    { label: 'By source (Copilot CLI vs VS Code chat)', value: '--by source' },
    { label: 'VS Code chat only', value: '--source vscode --top 25' },
    { label: 'Copilot CLI only', value: '--source cli --top 25' },
    { label: 'By skill', value: '--by skill' },
    { label: 'By repo', value: '--by repo' },
    { label: 'By day', value: '--by day' },
    { label: 'By session (with up time)', value: '--by session' },
    { label: 'By model', value: '--by model' },
  ], '--top 25'),
  pick('aiCostEpicsView', 'View', [
    { label: 'Per epic', value: '--top 25' },
    { label: 'Per ticket (stories, bugs, tasks)', value: '--stories --top 25' },
    { label: 'Largest prompts tied to no ticket', value: '--unattributed --top 25' },
  ], '--top 25'),
  pick('aiCostToolsView', 'View', [
    { label: 'By tool', value: '--by tool' },
    { label: 'By shell command', value: '--by command' },
    { label: 'Heaviest single calls', value: '--by call --top 20' },
  ], '--by tool'),
  pick('aiCostClaudeView', 'View', [
    { label: 'Latest session, per prompt', value: '--last 20' },
    { label: 'Recent sessions', value: '--list' },
    { label: 'Last 30 days by project', value: '--prompts --since 30d --by project' },
    { label: 'Last 30 days by day', value: '--prompts --since 30d --by day' },
    { label: 'Per Jira epic (30 days)', value: '--epics' },
  ], '--last 20'),
];

/** Strip // and /* *\/ comments outside strings, then trailing commas: JSONC -> JSON. */
function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') { out += n ?? ''; i++; } else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const isOurTask = (t) => t && String(t.label || '').startsWith(LABEL);
const isOurInput = (i) => i && String(i.id || '').startsWith(INPUT_PREFIX);

/** Add or refresh (or, with remove, take out) this repo's tasks in a tasks.json. Returns what happened. */
function mergeTasksFile(file, { root, remove = false } = {}) {
  let doc = { version: '2.0.0', tasks: [], inputs: [] };
  let existed = false;
  if (fs.existsSync(file)) {
    existed = true;
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim()) {
      try {
        doc = parseJsonc(text);
      } catch (err) {
        return { file, status: 'skipped', reason: `could not parse it (${err.message}); left untouched` };
      }
    }
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
      return { file, status: 'skipped', reason: 'unexpected content; left untouched' };
    }
  } else if (remove) {
    return { file, status: 'unchanged' };
  }
  // Nothing of ours to remove: do not rewrite the file (that would drop its comments for no reason).
  if (remove && !(doc.tasks || []).some(isOurTask) && !(doc.inputs || []).some(isOurInput)) return { file, status: 'unchanged' };
  doc.version = doc.version || '2.0.0';
  doc.tasks = [...(doc.tasks || []).filter((t) => !isOurTask(t)), ...(remove ? [] : tasksFor(root))];
  doc.inputs = [...(doc.inputs || []).filter((i) => !isOurInput(i)), ...(remove ? [] : INPUTS)];
  const next = `${JSON.stringify(doc, null, 2)}\n`;
  if (existed) {
    const prev = fs.readFileSync(file, 'utf8');
    if (prev === next) return { file, status: 'unchanged' };
    fs.writeFileSync(`${file}.bak`, prev); // comments in the original survive only here
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return { file, status: remove ? 'removed' : existed ? 'updated' : 'created', backup: existed ? `${file}.bak` : null };
}

/** VS Code's user-level tasks.json, or null when VS Code's user folder is absent. */
function userTasksFile(home = os.homedir(), platform = process.platform, env = process.env) {
  const dir = platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Code', 'User')
    : platform === 'win32' ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User')
      : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Code', 'User');
  return fs.existsSync(dir) ? path.join(dir, 'tasks.json') : null;
}

/** A checkout inside npm's npx cache disappears, so tasks must not point at it. */
const isTransient = (dir) => /[\\/]_npx[\\/]/.test(dir);

/** The command line; returns the lines to print. */
function run(argv, env = process.env) {
  const o = { remove: false, file: null, root: path.resolve(__dirname, '..') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--uninstall') o.remove = true;
    else if (a === '--file') o.file = val();
    else if (a === '--root') o.root = path.resolve(val());
    else if (a === '-h' || a === '--help') return ['usage: vscode-tasks.js [--uninstall] [--file <tasks.json>] [--root <folder holding bin/cost.js>]'];
    else throw new Error(`unknown option ${a}`);
  }
  const file = o.file || userTasksFile(os.homedir(), process.platform, env);
  if (!file) return ['VS Code\'s user folder was not found; pass --file <path to a tasks.json>.'];
  if (!o.remove) {
    if (!fs.existsSync(path.join(o.root, 'bin', 'cost.js'))) throw new Error(`${o.root} does not hold bin/cost.js; pass --root`);
    if (isTransient(o.root)) throw new Error(`${o.root} is inside npm's temporary npx cache; clone the repository and pass --root <clone>`);
  }
  const r = mergeTasksFile(file, { root: o.root, remove: o.remove });
  if (r.status === 'skipped') return [`${file}: ${r.reason}.`];
  if (r.status === 'unchanged') return [`${file}: ${o.remove ? 'no AI cost tasks to remove' : 'already up to date'}.`];
  return [`${file}: ${r.status}${r.backup ? ` (previous version saved as ${path.basename(r.backup)})` : ''}.`,
    ...(o.remove ? [] : [`${tasksFor(o.root).length} tasks run the scripts in ${o.root}. In VS Code: Command Palette → Tasks: Run Task → "AI cost: …".`])];
}

if (require.main === module) {
  try {
    console.log(run(process.argv.slice(2)).join('\n'));
  } catch (err) {
    console.error(`vscode-tasks: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { tasksFor, INPUTS, parseJsonc, mergeTasksFile, userTasksFile, isTransient, run, LABEL };
