#!/usr/bin/env node
'use strict';
// ai-cost-drilldown entry point.
//
//   node bin/cost.js hook          userPromptSubmitted hook: answers /cost with no model call; for any other
//                                  prompt, at most a one-line cost tip (lib/coach.js; `/cost coach off`)
//   node bin/cost.js hook --vscode the same from VS Code's chat (bin/vscode-hook.js): reports open in an editor tab
//   node bin/cost.js [args...]     the same report on the command line (and the skill's fallback)
//
// The hook sees every prompt. For anything but the /cost skill it exits at once with no
// output, and Copilot carries on. For /cost it runs the report and returns
// {"decision":"block","reason":<report>}: Copilot shows the report (rendered as markdown)
// and never calls the model, so it costs no AI credits. If the hook fails or times out,
// Copilot runs the cost skill instead, which asks the model to run this script: slower
// and it costs credits, but /cost still answers.

const HELP = [
  '/cost                      all sessions, last 7 days: one row per session, with the total',
  '/cost session              this session, last 20 prompts',
  '/cost 20 | /cost --all     this session, last N / every prompt',
  '/cost list                 recent sessions',
  '/cost prompt N             prompt N\'s tokens, cost and tool calls (N = the # column of /cost session)',
  '/cost prompt <session> N   the same for any session, without opening it (also <session>:N; add calls | call K)',
  '/cost prompt N calls       every model call of prompt N: what grew its input, what it did next',
  '/cost prompt N call K      one model call in full: cost per token type, what went in, its reasoning',
  '/cost session <id> [...]   another session (id or prefix); `… prompt N` and `… tools` open its prompt or tool costs',
  '/cost prompts [...]        prompts across all sessions:',
  '    --since 7d|30d|all|DATE  --top N  --sort credits|time|wall|tokens|tools|recent',
  '    --by day|skill|repo|branch|session|model|source  --grep TEXT  --repo TEXT  --csv',
  '    --source all|cli|vscode   (VS Code Copilot Chat is included by default; also on epics and advise)',
  '/cost advise [...]         where spend can be cut, measured on your sessions: --since 30d|all|DATE  --top N  --json',
  '/cost epics [...]          cost per Jira epic: --since 30d|all|DATE  --top N  --repo TEXT  --csv',
  '    --stories (one row per ticket)  --key FOPTS-123 (one epic/ticket: skills, days, sessions)  --unattributed',
  '/cost tools [...]          which tool calls drive cost (estimated carried tokens):',
  '    --by tool|command|call  --since 7d|30d|all  --session ID  --scope main|subagents|all  --top N',
  '/cost coach [on|off]       one-line tips above an answer when a prompt is thin or about to cost more than it needs to',
  '/cost coach strict on|off  hold a thin prompt back with a banner instead (send it again to run it as written)',
  '/cost coach strict model on|off   also suggest a rewrite of the held prompt, written by a small model (send y to run it)',
  'Reading a report uses no AI credits: it is answered locally, with no model call.',
].join('\n');

/** Split raw argument text into argv, keeping "quoted phrases" together. */
function splitArgs(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const COMMANDS = ['help', 'coach', 'list', 'session', 'prompt', 'prompts', 'tools', 'epics', 'stories', 'advise'];

/** Edit distance between two short words. */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/** The command a mistyped word most likely meant, or null (numbers, flags, session ids and exact commands). */
function nearestCommand(word) {
  const w = String(word ?? '').toLowerCase();
  if (!/^[a-z]{3,}$/.test(w) || COMMANDS.includes(w)) return null; // ids have digits or dashes; "abc" could be a hex prefix
  if (/^[a-f]+$/.test(w)) return null;
  let best = null;
  for (const c of COMMANDS) {
    const dist = distance(w, c);
    if (dist <= 2 && (!best || dist < best.dist)) best = { c, dist };
  }
  return best ? best.c : null;
}

/** Session report for the session /cost was typed in. In a brand-new `copilot -p` session the log does not exist yet
 *  when the hook runs; show the most recent session instead and say so. */
async function forSession(lib, sessionId, args) {
  const sc = lib('session-cost.js');
  try {
    return await sc.run(sessionId ? [sessionId, ...args] : args);
  } catch (err) {
    if (sessionId && /no session matches/i.test(err.message)) {
      return `_This session has no log yet; showing the most recent session instead._\n\n${await sc.run(args)}`;
    }
    throw err;
  }
}

/**
 * One prompt of this session or of any other: "N", "N calls", "N call K", and the same after a session id or
 * prefix ("a05dcb09 428 calls") or as "a05dcb09:428". A second number is what tells a session from a prompt.
 */
function promptView(lib, sessionId, args) {
  let rest = [...args];
  let other = null;
  const pair = /^([\w-]+):(\d+)$/.exec(rest[0] ?? '');
  if (pair) { other = pair[1]; rest = [pair[2], ...rest.slice(1)]; }
  else if (rest.length >= 2 && /^\d+$/.test(rest[1])) { other = rest[0]; rest = rest.slice(1); }
  if (!/^\d+$/.test(rest[0] ?? '')) {
    throw usage('/cost prompt needs a prompt number: `/cost prompt N` for this session, `/cost prompt <session> N` for another (the # column of /cost session and /cost prompts).');
  }
  const n = rest[0];
  const tail = rest.slice(1);
  if (tail[0] === 'calls') tail[0] = '--calls';
  else if (tail[0] === 'call') {
    if (!/^\d+$/.test(tail[1] ?? '')) throw usage('/cost prompt N call K needs a call number (the # column of /cost prompt N calls).');
    tail[0] = '--call';
  }
  if (other) return lib('session-cost.js').run([other, '--prompt', n, ...tail]);
  return forSession(lib, sessionId, ['--prompt', n, ...tail]);
}

/** The report for these arguments. sessionId: the session /cost was typed in, if known. */
async function cost(argv, sessionId) {
  const fs = require('fs');
  const path = require('path');
  const sub = argv[0];
  const lib = (name) => require(path.join(__dirname, '..', 'lib', name));

  if (sub === 'help' || sub === '-h' || sub === '--help') return HELP;
  // Bare /cost: every session, one row each, with the overall total. One session is `/cost session`.
  if (!argv.length) {
    return `${await lib('prompt-usage.js').run(['--by', 'session'])}\n\n`
      + 'All sessions, last 7 days. This session: `/cost session` · another window: `/cost prompts --since 30d --by session` · everything: `/cost help`.';
  }
  if (sub === 'coach') return lib('coach.js').command(argv.slice(1));
  if (sub === 'list') return lib('session-cost.js').run(['--list']);
  if (sub === 'prompts') {
    const rest = argv.slice(1);
    if (!rest.includes('--csv')) return lib('prompt-usage.js').run(rest);
    // A CSV of every prompt does not belong in the chat: write it to a file.
    const csv = await lib('prompt-usage.js').run(rest);
    const { REPORTS_DIR } = lib('paths.js');
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const file = path.join(REPORTS_DIR, `copilot-prompts-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`);
    fs.writeFileSync(file, csv + '\n');
    return `Wrote ${csv.split('\n').length - 1} prompts to ${file}`;
  }
  if (sub === 'tools') return lib('tool-usage.js').run(argv.slice(1));
  if (sub === 'advise') return lib('advise.js').run(argv.slice(1));
  if (sub === 'epics' || sub === 'stories') {
    const rest = argv.slice(1);
    return lib('epic-usage.js').run(sub === 'stories' ? ['--stories', ...rest] : rest);
  }
  if (sub === 'prompt') return promptView(lib, sessionId, argv.slice(1));
  if (sub === 'session') {
    // "/cost session" and "/cost session --last 5" are this session; "/cost session <id> …" is another one,
    // where "prompt N [calls|call K]" and "tools […]" open that session's prompt or tool costs directly.
    if (!argv[1] || argv[1].startsWith('--')) return forSession(lib, sessionId, argv.slice(1));
    if (argv[2] === 'prompt') return promptView(lib, sessionId, [argv[1], ...argv.slice(3)]);
    if (argv[2] === 'tools') return lib('tool-usage.js').run(['--session', argv[1], ...argv.slice(3)]);
    return lib('session-cost.js').run(argv.slice(1));
  }
  // A misspelt command ("sesssion", "promt") must not fall through as a session id: the words after it would be
  // read as one too, and the error would be about them ("2" matches 41 sessions).
  const near = nearestCommand(sub);
  if (near) throw usage(`unknown command "${sub}". Did you mean \`/cost ${[near, ...argv.slice(1)].join(' ')}\`?`);
  // This session: "/cost 20", "/cost --all", "/cost --last 5". A lone session id or prefix opens that session.
  const rest = /^\d+$/.test(sub ?? '') ? ['--last', sub, ...argv.slice(1)] : argv;
  return forSession(lib, sessionId, rest);
}

function usage(msg) {
  const err = new Error(msg);
  err.usage = true;
  return err;
}

// Copilot hands a skill invocation to the hook already expanded: this line first, then
// the skill's text, with whatever followed the command on an "ARGUMENTS:" line. A plugin's
// skill is namespaced by the plugin: typed and named "/ai-cost-drilldown:cost".
const INVOKED = /^The user explicitly invoked the "\/(?:ai-cost-drilldown:)?cost" skill\./;
// Prompt mode (copilot -p) passes the text as typed, before any skill expansion.
const RAW = /^\s*\/(?:ai-cost-drilldown:)?cost(\s+|$)/;

async function hook() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  const prompt = String(input?.prompt ?? '');
  if (!input.sessionId && input.session_id) input.sessionId = input.session_id; // hook files in VS Code's format send snake_case
  // `hook --vscode` is what ~/.copilot/hooks/ai-cost-drilldown.json runs (bin/vscode-hook.js). Copilot CLI reads
  // that folder too: there the plugin's own hook answers, so this one stays out of the way.
  const vscode = process.argv.includes('--vscode');
  if (vscode && process.env.COPILOT_CLI_BINARY_VERSION) return;
  let args;
  if (INVOKED.test(prompt)) args = (/^ARGUMENTS: (.*)$/m.exec(prompt) || [])[1] || '';
  else if (RAW.test(prompt)) args = prompt.replace(RAW, ''); // prompt mode: `copilot -p "/cost …"`
  else return coachHook(input, prompt, vscode); // not /cost: at most a one-line cost tip, and Copilot carries on
  // VS Code's chat shows nothing for a blocked prompt, so a report cannot be answered there. The one command that
  // must work there is the tips' own switch: apply it here and have the model confirm in one line.
  if (vscode) {
    if (/^coach(\s+(on|off|status|(strict|rewrite|strict\s+(with\s+)?model)(\s+(on|off))?))?\s*$/i.test(args.trim())) {
      const coach = require('../lib/coach');
      coach.apply(splitArgs(args).slice(1));
      const line = `${coach.statusLine()} Switch with /cost coach on|off, /cost coach strict on|off and /cost coach strict model on|off.`;
      process.stdout.write(JSON.stringify({ modifiedPrompt: `Reply with exactly this one line and nothing else, using no tools:\n\n${line}` }));
      return;
    }
    // Any other /cost: the report goes into an editor tab, untouched by the model.
    let text;
    try {
      text = await cost(splitArgs(args), input.sessionId || null);
    } catch (err) {
      text = `/cost: ${err.usage || err.constructor?.name === 'UsageError' ? err.message : err.stack}\n\n${HELP}`;
    }
    const file = saveReport(`/cost ${args.trim()}`.trim(), String(text));
    // With the tab open the prompt is simply stopped: no model call, no credits. The chat shows no reply (VS Code
    // never displays a hook's reason), but the report is in front of the user. Only when the tab could not be
    // opened is the model asked to say where the file is.
    if (openInEditor(file)) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: `Cost report opened in an editor tab: ${file}` }));
      return;
    }
    const line = `Saved the cost report: ${file} (ai-cost-drilldown: it could not be opened in a tab; the report was built locally and only this line used the model).`;
    process.stdout.write(JSON.stringify({ modifiedPrompt: `Reply with exactly this one line and nothing else, using no tools:\n\n${line}` }));
    return;
  }
  let reason;
  try {
    reason = await cost(splitArgs(args), input.sessionId || null);
  } catch (err) {
    // Still answer (and still block): a bad argument must not fall through to the model.
    reason = `/cost: ${err.usage || err.constructor?.name === 'UsageError' ? err.message : err.stack}\n\n${HELP}`;
  }
  // Copilot shows its usual "Working" spinner while a hook runs, so say plainly that no model was involved.
  process.stdout.write(JSON.stringify({ decision: 'block', reason: `${String(reason)}\n\n_Answered locally by ai-cost-drilldown: no model call, no AI credits._` }));
}

/** Writes a report as fixed-width text (box tables) for an editor tab; yesterday's reports are cleared. */
function saveReport(title, markdown, now = new Date()) {
  const fs = require('fs');
  const path = require('path');
  const { REPORTS_DIR } = require('../lib/paths');
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  for (const n of fs.readdirSync(REPORTS_DIR)) {
    if (!/^cost-\d{8}-\d{6}\.txt$/.test(n)) continue;
    const f = path.join(REPORTS_DIR, n);
    try { if (now - fs.statSync(f).mtimeMs > 864e5) fs.unlinkSync(f); } catch { /* in use */ }
  }
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const file = path.join(REPORTS_DIR, `cost-${stamp}.txt`);
  const body = require('../lib/pretty').prettyMarkdown(markdown, { width: 160 });
  fs.writeFileSync(file, `${title}   (${now.toLocaleString()})\n\n${body}\n`);
  return file;
}

/** Opens a file in VS Code: the `code` command, else the vscode:// link through the system opener. */
function openInEditor(file, { spawnSync = require('child_process').spawnSync, platform = process.platform, env = process.env } = {}) {
  if (env.AI_COST_NO_OPEN) return false;
  const win = platform === 'win32';
  const tries = [[win ? 'code.cmd' : 'code', ['-r', file]]];
  if (platform === 'darwin') tries.push(['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', ['-r', file]]);
  const url = `vscode://file/${encodeURI(file.replace(/\\/g, '/')).replace(/^\//, '')}`;
  tries.push(win ? ['cmd', ['/c', 'start', '', url]] : [platform === 'darwin' ? 'open' : 'xdg-open', [url]]);
  for (const [cmd, a] of tries) {
    try {
      const r = spawnSync(cmd, a, { stdio: 'ignore', timeout: 10000, shell: win && cmd.endsWith('.cmd') });
      if (!r.error && r.status === 0) return true;
    } catch { /* try the next way */ }
  }
  return false;
}

/** A cost tip for a prompt that is not /cost: passed to the model as context, which shows it above its answer. */
function coachHook(input, prompt, vscode) {
  try {
    const coach = require('../lib/coach');
    const skill = /^The user explicitly invoked the "\/[^"]+" skill\./.test(prompt) || /^\s*\//.test(prompt);
    // Strict mode can stop a thin prompt, but only where the banner would be seen: not in VS Code's chat.
    const tip = coach.tipFor({ prompt, sessionId: input.sessionId, skill, canBlock: !vscode });
    if (tip && tip.use) {
      // "y" after a banner that offered a rewrite: run the rewrite in place of the "y"
      process.stdout.write(JSON.stringify({ modifiedPrompt: tip.use }));
    } else if (tip && tip.block) {
      let suggestion = null;
      if (coach.rewrite()) {
        const path = require('path');
        const home = process.env.COPILOT_HOME || path.join(require('os').homedir(), '.copilot');
        suggestion = require('../lib/rewrite').suggest({
          prompt, why: tip.why, cwd: input.cwd, sessionId: input.sessionId,
          sessionFile: input.sessionId ? path.join(home, 'session-state', String(input.sessionId), 'events.jsonl') : null,
        });
        if (suggestion) coach.offer(input.sessionId, suggestion.text);
      }
      process.stdout.write(JSON.stringify({ decision: 'block', reason: coach.banner(tip, suggestion) }));
    }
    else if (tip) process.stdout.write(JSON.stringify(vscode ? coach.asPrompt(tip, prompt) : coach.asContext(tip)));
  } catch { /* a tip is never worth failing a prompt for */ }
}

/** The command line: the report as box tables fitted to the terminal (--width N), or raw markdown (--md). */
async function cli(argv) {
  const rest = [];
  let pretty = true;
  let width = Number(process.stdout.columns) || Number(process.env.COLUMNS) || 140;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--md') pretty = false;
    else if (argv[i] === '--width') { width = Number(argv[++i]); if (!(width >= 40)) throw usage('--width needs a number of at least 40'); }
    else rest.push(argv[i]);
  }
  const text = await cost(rest);
  console.log(pretty ? require('../lib/pretty').prettyMarkdown(text, { width }) : text);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const main = argv[0] === 'hook' ? hook() : cli(argv);
  main.catch((err) => {
    console.error(`ai-cost-drilldown: ${err.usage || err.constructor?.name === 'UsageError' ? err.message : err.stack}`);
    process.exit(argv[0] === 'hook' ? 0 : 1); // a hook must never fail the prompt
  });
}

module.exports = { saveReport, openInEditor, cost, splitArgs, INVOKED, RAW, HELP, nearestCommand };
