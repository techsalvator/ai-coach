#!/usr/bin/env node
'use strict';
// Regenerates the README's drill-down screenshots (docs/images/drilldown-*.png) from your own sessions.
//
//   node scripts/screenshots.js [--session a05dcb09] [--prompt 428] [--call 72] [--lines 46] [--out docs/images]
//   node scripts/screenshots.js --set coach     the cost-tips screenshots (docs/images/coach-*.png) instead
//
// The coach set sends four small prompts through the real `copilot` (a few AI credits) with the installed plugin,
// using a throwaway AI_COST_HOME so your own coach settings and state are untouched.
//
// Each image is the command's real output (the same box tables the terminal shows), drawn as a terminal window by
// headless Chrome. The reports show prompt text, folders and ticket keys: look at the images before committing them.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const COLS = 150;
const LINE = 18; // px

function args(argv) {
  const o = { session: 'a05dcb09', prompt: '428', call: '72', lines: 46, set: 'drilldown', out: path.join(ROOT, 'docs', 'images') };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    if (!(k in o) || argv[i + 1] == null) throw new Error(`unknown option ${argv[i]}`);
    o[k] = k === 'lines' ? Number(argv[i + 1]) : argv[i + 1];
  }
  return o;
}

function chrome() {
  const found = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'google-chrome', 'chromium', 'chrome']
    .filter(Boolean).find((c) => !spawnSync(c, ['--version'], { stdio: 'ignore' }).error);
  if (!found) throw new Error('Chrome was not found: set CHROME to its executable');
  return found;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The command's output, cut to `max` lines with a note of what was left out. */
function run(cmd, max) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'cost.js'), ...cmd, '--width', String(COLS)], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`cost ${cmd.join(' ')} failed:\n${r.stderr}`);
  const lines = r.stdout.replace(/\s+$/, '').split('\n');
  return lines.length > max ? [...lines.slice(0, max), '', `… ${lines.length - max} more lines`] : lines;
}

/** Table rows are never wrapped (a wrapped border breaks the box); prose wraps at the table's width. */
const isTable = (l) => /^[\u2500-\u257F]/.test(l.trimStart());

/** Arrows and symbols (⇄ ⏲ ✕ ⟳) come from a fallback font of another width: pin each to one column. */
const sym = (t) => t.replace(/[\u2190-\u21FF\u2300-\u23FF\u25A0-\u27FF\u2B00-\u2BFF]\uFE0F?/g, (c) => `<span class="s">${c}</span>`);

function html(title, lines) {
  const cols = Math.max(COLS, ...lines.filter(isTable).map((l) => [...l].length));
  const rows = lines.reduce((n, l) => n + (isTable(l) ? 1 : Math.max(1, Math.ceil([...l].length / cols))), 0);
  const width = Math.ceil(cols * 7.85) + 60; // 13px Menlo is 7.83px a character
  const body = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;background:#0d1117}
    .win{margin:12px;border:1px solid #30363d;border-radius:8px;overflow:hidden;background:#0d1117}
    .bar{height:28px;background:#161b22;border-bottom:1px solid #30363d;display:flex;align-items:center;padding:0 12px;gap:7px}
    .dot{width:11px;height:11px;border-radius:50%}
    .t{color:#8b949e;font:12px -apple-system,Segoe UI,sans-serif;margin-left:10px}
    .out{padding:12px 14px;color:#c9d1d9;font:13px/${LINE}px Menlo,Consolas,"DejaVu Sans Mono",monospace;width:${cols}ch}
    .out div{white-space:pre-wrap;word-break:break-word;min-height:${LINE}px}
    .out div.tb{white-space:pre}
    .s{display:inline-block;width:1ch;text-align:center;overflow:hidden;vertical-align:top;height:${LINE}px}
    .p{color:#58a6ff}
  </style><div class="win"><div class="bar"><span class="dot" style="background:#ff5f56"></span><span class="dot" style="background:#ffbd2e"></span><span class="dot" style="background:#27c93f"></span><span class="t">copilot</span></div>
  <div class="out"><div class="p">❯ ${esc(title)}</div><div></div>${lines.map((l) => `<div${isTable(l) ? ' class="tb"' : ''}>${sym(esc(l))}</div>`).join('')}</div></div>`;
  return { body, height: (rows + 2) * LINE + 96, width };
}

/** One real `copilot -p` run: its output lines (without the resume hint) and the session id. */
function copilot(prompt, env, extra = []) {
  const r = spawnSync('copilot', [...extra, '-p', prompt], { encoding: 'utf8', timeout: 180000, cwd: env.SHOT_CWD, env: { ...process.env, COLUMNS: '110', NO_COLOR: '1', ...env } });
  // prompt mode prints markdown as typed; an interactive session renders it, so drop the ** and _( )_ markers
  const out = `${r.stdout || ''}${r.stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '').replace(/\*\*/g, '').replace(/_\(([^)]*)\)_/g, '($1)');
  const id = (/--resume=([0-9a-f-]+)/.exec(out) || [])[1];
  const lines = out.replace(/\s+$/, '').split('\n').filter((l) => !/^(Resume|Changes|Tokens)\s/.test(l));
  while (lines.length && !lines[0].trim()) lines.shift();
  return { lines: lines.join('\n').replace(/\n{3,}/g, '\n\n').split('\n'), id };
}

/** The cost-tips screenshots: [name, what was typed, output lines]. */
function coachShots(max) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-shots-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-work-'));
  const base = { AI_COST_HOME: home, SHOT_CWD: cwd };
  const cut = (lines) => (lines.length > max ? [...lines.slice(0, max), '', `… ${lines.length - max} more lines`] : lines);
  const status = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'cost.js'), 'coach', '--width', '110'], { encoding: 'utf8', env: { ...process.env, ...base } }).stdout.replace(/\s+$/, '').split('\n');
  const tip = copilot('try again', { ...base, AI_COST_COACH_STRICT: '0' });
  const held = copilot('fix the bug', base);
  // a session that says what "the bug" is, so the rewrite has something to work with
  const first = copilot('Note this for later and reply with only "ok": in lib/coach.js the strict-mode test fails with "AssertionError: expected block".', base);
  const model = copilot('fix the bug', { ...base, AI_COST_COACH_REWRITE: '1' }, first.id ? [`--resume=${first.id}`] : []);
  return [
    ['coach-1-tip', 'try again', cut(tip.lines)],
    ['coach-2-strict', 'fix the bug', cut(held.lines)],
    // the credits line of a resumed session is the session's running total, not this prompt's: leave it out
    ['coach-3-strict-model', 'fix the bug', cut(model.lines.filter((l) => !/^AI Credits/.test(l)))],
    ['coach-4-status', '/cost coach', cut(status)],
  ];
}

function main() {
  const o = args(process.argv.slice(2));
  const shots = o.set === 'coach' ? coachShots(o.lines) : [
    ['drilldown-1-sessions', '/cost', []],
    ['drilldown-2-prompts', '/cost prompts --since 30d --top 10', ['prompts', '--since', '30d', '--top', '10']],
    ['drilldown-3-prompt', `/cost prompt ${o.session} ${o.prompt}`, ['prompt', o.session, o.prompt]],
    ['drilldown-4-calls', `/cost prompt ${o.session} ${o.prompt} calls`, ['prompt', o.session, o.prompt, 'calls']],
    ['drilldown-5-call', `/cost prompt ${o.session} ${o.prompt} call ${o.call}`, ['prompt', o.session, o.prompt, 'call', o.call]],
  ].map(([name, title, cmd]) => [name, title, run(cmd, o.lines)]);
  const bin = chrome();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
  fs.mkdirSync(o.out, { recursive: true });
  for (const [name, title, lines] of shots) {
    const { body, height, width } = html(title, lines);
    const page = path.join(tmp, `${name}.html`);
    const png = path.join(o.out, `${name}.png`);
    fs.writeFileSync(page, body);
    const r = spawnSync(bin, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
      `--window-size=${width},${height}`, `--screenshot=${png}`, `file://${page}`], { encoding: 'utf8', timeout: 60000 });
    if (!fs.existsSync(png)) throw new Error(`Chrome did not write ${png}:\n${r.stderr}`);
    console.log(`${path.relative(ROOT, png)}  (${Math.round(fs.statSync(png).size / 1024)} KB)`);
  }
}

try { main(); } catch (err) { console.error(`screenshots: ${err.message}`); process.exit(1); }
