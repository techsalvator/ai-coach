#!/usr/bin/env node
'use strict';
// Regenerates the README's screenshots (docs/images/vscode-*.png).
//
//   node scripts/screenshots.js [--out ../docs/images] [--scale 2]
//
// The README uses the 2x set in docs/images. The extension's own page ships a 1x set in vscode-extension/images, which keeps
// the .vsix small:  node scripts/screenshots.js --out images --scale 1
//
// Each image is one of the extension's real panels (the same HTML it shows in VS Code), filled with the synthetic
// sessions from scripts/demo-data.js, and drawn by headless Chrome in VS Code's dark theme. Nothing is read from
// your own logs, so the images carry no prompts, folders or costs of yours. The tree views are VS Code's own UI and
// are described in the README instead of drawn here.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// The charts and ranges are relative to "now": freeze it so the images do not depend on the day they are made.
const FIXED_NOW = Date.parse('2026-10-05T18:00:00Z');
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(FIXED_NOW); }
  static now() { return FIXED_NOW; }
};

// The extension host's module, replaced by just enough of it for the panels to render.
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    return {
      EventEmitter: class { constructor() { this.event = () => {}; } fire() {} }, Uri: {}, ViewColumn: {}, StatusBarAlignment: {},
      workspace: { getConfiguration: () => ({ get: (k, d) => d }) }, commands: { executeCommand() {} }, window: {},
    };
  }
  return load.call(this, request, ...rest);
};

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const { demoSessions, demoCallContent, demoToolContent } = require('./demo-data');
const ext = require('../extension')._test;

// VS Code Dark+: the variables the panels style themselves with.
const THEME = `:root{--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;
--vscode-panel-border:#3c3c3c;--vscode-progressBar-background:#0e70c0;--vscode-editorHoverWidget-background:#252526;--vscode-editorHoverWidget-border:#454545;
--vscode-editorHoverWidget-foreground:#cccccc;--vscode-textLink-foreground:#3794ff;--vscode-textCodeBlock-background:#2a2a2a;--vscode-editorWarning-foreground:#cca700;
--vscode-button-background:#0e639c;--vscode-button-foreground:#ffffff;--vscode-list-hoverBackground:#2a2d2e;--vscode-focusBorder:#007fd4}
html{background:#1e1e1e}body{margin:0 auto;box-sizing:border-box}`;

function page(html, width) {
  const inject = `<style>${THEME}body{width:${width}px}</style>`
    + '<script>document.addEventListener("DOMContentLoaded",function(){document.body.classList.add("vscode-dark");'
    + 'setTimeout(function(){document.documentElement.setAttribute("data-h",String(document.documentElement.scrollHeight))},50)})</script>';
  return html.replace('<meta charset="utf-8">', `<meta charset="utf-8">${inject}`);
}

function chrome(args) {
  const r = spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return r;
}

function render(name, html, width, outDir, tmp, scale = 2) {
  const file = path.join(tmp, `${name}.html`);
  fs.writeFileSync(file, page(html, width));
  const dom = chrome(['--virtual-time-budget=2000', '--dump-dom', `file://${file}`]).stdout || '';
  const h = Number((/data-h="(\d+)"/.exec(dom) || [])[1]) || 900;
  const out = path.join(outDir, `${name}.png`);
  // Chrome will not open a window narrower than about 500px: draw the narrow panels in one that wide, then cut the middle of it (where the panel is centred) to size.
  const win = Math.max(width, 500);
  chrome([`--force-device-scale-factor=${scale}`, `--window-size=${win},${h + 24}`, '--virtual-time-budget=2000', `--screenshot=${out}`, `file://${file}`]);
  if (win > width) spawnSync('sips', ['--cropToHeightWidth', String((h + 24) * scale), String(width * scale), out], { stdio: 'ignore' });
  console.log(`${path.relative(process.cwd(), out)}  ${width}x${h + 24}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}

function main(argv) {
  if (!CHROME) throw new Error('Chrome or Chromium is needed to draw the images');
  const j = argv.indexOf('--scale');
  const scale = j >= 0 ? Number(argv[j + 1]) || 2 : 2;
  const i = argv.indexOf('--out');
  const outDir = path.resolve(i >= 0 ? argv[i + 1] : path.join(__dirname, '..', '..', 'docs', 'images'));
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aicost-shots-'));
  const sessions = demoSessions(FIXED_NOW);

  ext.load(sessions, { days: 0 });
  render('vscode-1-overview-months', ext.overviewHtml(false), 1000, outDir, tmp, scale);
  // By day, with Copilot CLI left out through the chart legend: the totals, the chart and the lists all follow.
  ext.onDrill({ kind: 'range', value: -1 });
  ext.onDrill({ kind: 'harness', value: 'copilot' });
  render('vscode-1b-overview-by-day', ext.overviewHtml(false), 1000, outDir, tmp, scale);
  ext.onDrill({ kind: 'clear' });
  ext.onDrill({ kind: 'range', value: 0 });
  render('vscode-2-sidebar-overview', ext.overviewHtml(true), 320, outDir, tmp, scale);
  ext.load(sessions, { days: 0, month: '2026-09' });
  render('vscode-3-overview-month', ext.overviewHtml(false), 1000, outDir, tmp, scale);

  // One path down the tree: a session, a prompt in it, a call in that prompt, a tool in that call.
  const session = sessions.find((s) => s.source === 'claude' && s.prompts.length >= 9 && s.prompts.length <= 14) || sessions.find((s) => s.source === 'claude');
  const prompt = session.prompts.find((p) => p.calls.length >= 6 && p.toolCalls.length >= 3);
  const call = prompt.calls.find((c) => c.toolCalls.some((t) => t.name === 'Bash')) || prompt.calls.find((c) => c.toolCalls.length);
  const tool = { kind: 'tool', ...call.toolCalls.find((t) => t.name === 'Bash') || call.toolCalls[0] };
  call.toolCalls = [tool, ...call.toolCalls.filter((t) => t !== tool)]; // the screens follow the same tool
  if (tool.name === 'Bash') tool.detail = 'npm test -- --runInBand';
  ext.load(sessions, { days: 0 });
  render('vscode-4-session', ext.detailHtml(session, undefined, { s: session, canBack: true }), 1000, outDir, tmp, scale);
  render('vscode-5-prompt', ext.detailHtml(prompt, { tools: prompt.toolCalls }, { s: session, p: prompt, canBack: true }), 1000, outDir, tmp, scale);
  render('vscode-6-call', ext.detailHtml(call, { ...demoCallContent(prompt.text, call), tools: call.toolCalls }, { s: session, p: prompt, c: call, canBack: true }), 1000, outDir, tmp, scale);
  render('vscode-7-tool', ext.detailHtml(tool, demoToolContent(tool), { s: session, p: prompt, c: call, canBack: true }), 1000, outDir, tmp, scale);
  // What the coach did over 30 days (made-up numbers), as the Coach results page shows them.
  const row = (tips, held, reworded, sentAnyway, avoidedUsd) => ({ tips, held, reworded, sentAnyway, avoidedUsd });
  const byId = { 'cost-gate': row(0, 14, 9, 5, 6.84), repeat: row(0, 7, 3, 4, 8.41), 'long-session': row(0, 9, 6, 3, 0), 'big-paste': row(0, 5, 3, 2, 0), 'cache-expired': row(3, 34, 21, 13, 1.12), 'no-error-text': row(0, 3, 2, 1, 0), 'vague-retry': row(0, 12, 4, 8, 0) };
  const total = Object.values(byId).reduce((a, r) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + r[k]])), row(0, 0, 0, 0, 0));
  render('vscode-8-coach-results', ext.coachResultsHtml({ byId, total }), 1000, outDir, tmp, scale);
  fs.rmSync(tmp, { recursive: true, force: true });
}

main(process.argv.slice(2));
