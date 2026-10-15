#!/usr/bin/env node
/**
 * prompt-usage — prompts across all Copilot CLI sessions, with their AI credits,
 * premium requests, run time, tool calls and subagent tokens.
 *
 * Built on session-cost.js's parser (per-prompt credits are the difference between
 * Copilot's usage checkpoints). Scanning ~1 GB of logs takes tens of seconds, so each
 * session's result is cached in ~/.ai-cost-coach/cache/ and reused while its log file is
 * unchanged; sessions untouched since the start of the window are skipped outright.
 *
 *   node lib/prompt-usage.js                      # last 7 days, top 25 by credits
 *   node lib/prompt-usage.js --since 30d --top 50
 *   node lib/prompt-usage.js --since 2026-09-01 --sort time
 *   node lib/prompt-usage.js --by day             # also: skill, repo, branch, session, model
 *   node lib/prompt-usage.js --grep backlog --repo bill-analysis
 *   node lib/prompt-usage.js --csv > prompts.csv  # every matching prompt
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { analyse, sessions, UsageError, readTokenLog, attachLiveTokens, latestQuota, tokensOf, fmtTokens,
  TOKENS_NOTE, cacheBreakLine, breakMark, BREAK_NOTE, creditsUsd } = require('./session-cost');

const { readAll: readVscodeAll, userDirs } = require('./vscode-chat');
const readVscode = (sinceMs, o) => readVscodeAll(sinceMs, { dirs: o.dirs || userDirs(), cachePath: o.cachePath });
const CACHE = path.join(require('./paths').CACHE_DIR, 'prompt-usage-v10.json');
const VSCODE_CACHE = path.join(require('./paths').CACHE_DIR, 'vscode-chat-v1.json');
const SORTS = {
  credits: (p) => p.credits ?? -1,
  time: (p) => p.activeSeconds ?? -1,
  wall: (p) => p.seconds ?? -1,
  tokens: (p) => (tokensOf(p) || { input: -1 }).input,
  tools: (p) => p.toolCalls,
  recent: (p) => Date.parse(p.ts) || 0,
};
const GROUPS = {
  day: (p) => (p.ts || '').slice(0, 10),
  skill: (p) => skillOf(p.prompt),
  repo: (p) => p.repository || (p.cwd ? path.basename(p.cwd) : '?'),
  branch: (p) => p.branch || '—',
  session: (p) => sessionLabel(p.session),
  model: (p) => p.models[0] || '—',
  source: (p) => (p.source === 'vscode' ? 'VS Code chat' : 'Copilot CLI'),
};

function fail(msg) {
  throw new UsageError(msg);
}

function parseArgs(argv) {
  const o = { since: '7d', top: 25, sort: 'credits', by: null, grep: null, repo: null, source: 'all', csv: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) fail(`${a} needs a value`); return argv[++i]; };
    if (a === '--since') o.since = val();
    else if (a === '--top') o.top = Number(val());
    else if (a === '--all') o.top = Infinity;
    else if (a === '--sort') o.sort = val();
    else if (a === '--by') o.by = val();
    else if (a === '--grep') o.grep = val().toLowerCase();
    else if (a === '--repo') o.repo = val().toLowerCase();
    else if (a === '--source') o.source = val();
    else if (a === '--csv') o.csv = true;
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else fail(`unknown argument ${a}`);
  }
  if (!['all', 'cli', 'vscode'].includes(o.source)) fail('--source is one of: all, cli, vscode');
  if (!SORTS[o.sort]) fail(`--sort is one of: ${Object.keys(SORTS).join(', ')}`);
  if (o.by && !GROUPS[o.by]) fail(`--by is one of: ${Object.keys(GROUPS).join(', ')}`);
  if (!(o.top > 0)) fail('--top needs a positive number');
  o.sinceMs = parseSince(o.since);
  return o;
}

/** "7d", "12h", "all", or an ISO date. */
function parseSince(v) {
  if (v === 'all') return 0;
  const m = /^(\d+)([dh])$/.exec(v);
  if (m) return Date.now() - Number(m[1]) * (m[2] === 'd' ? 86400e3 : 3600e3);
  const t = Date.parse(v);
  if (Number.isNaN(t)) fail(`--since takes 7d, 12h, all, or a date (got "${v}")`);
  return t;
}

/** UUID sessions by their first 8 characters; named ones (pf-design-FOPTS-1…) share
 *  prefixes, so they keep more of their name. */
function sessionLabel(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id) ? id.slice(0, 8) : cell(id, 28);
}

/** "/backlog FOPTS-1" -> "/backlog"; anything else is a chat prompt. */
function skillOf(prompt) {
  const m = /^\/([\w-]+)(?=\s|$)/.exec(prompt || ''); // not a path like /Users/…
  return m ? `/${m[1]}` : '(chat)';
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return { sessions: {} }; }
}

function writeCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(cache));
  } catch { /* a cache we cannot write only costs speed */ }
}

/** Flat, serialisable prompt rows for one session. */
function rows(sessionId, result) {
  return result.prompts.map((p, i) => ({
    session: sessionId, n: i + 1, ts: p.ts, prompt: p.prompt, cwd: p.cwd, repository: p.repository,
    branch: p.branch, credits: p.credits, premium: p.premium, models: [...p.models],
    toolCalls: p.toolCalls, subagents: p.subagents.length,
    subagentTokens: p.subagents.reduce((a, s) => a + s.tokens, 0), compactions: p.compactions,
    seconds: p.end && p.ts ? Math.round((Date.parse(p.end) - Date.parse(p.ts)) / 1000) : null,
    activeSeconds: Math.round(p.activeMs / 1000),
    tokensEst: p.tokensEst || null,
    firstModel: p.firstModel || null, lastModel: p.lastModel || null, cacheBreak: p.cacheBreak || null,
    jira: p.jira.toJSON(),
  }));
}

/**
 * Prompt rows since sinceMs. opts.source: 'all' (default), 'cli' (Copilot CLI sessions) or 'vscode' (VS Code
 * Copilot Chat, read from VS Code's own storage). opts.vscodeDirs overrides where VS Code keeps it.
 */
async function collect(sinceMs, opts = {}) {
  const source = opts.source || 'all';
  const cache = readCache();
  const out = [];
  const runs = {}; // session id -> [[start, end], ...]
  let scanned = 0;
  let reused = 0;
  for (const s of source === 'vscode' ? [] : sessions()) {
    if (s.mtime < sinceMs) continue; // nothing in it can fall inside the window
    const { size } = fs.statSync(s.file);
    const hit = cache.sessions[s.id];
    let prompts;
    if (hit && hit.size === size && hit.mtime === s.mtime) {
      prompts = hit.prompts;
      runs[s.id] = hit.runs || [];
      reused++;
    } else {
      const result = await analyse(s.file);
      prompts = rows(s.id, result);
      runs[s.id] = result.runs;
      cache.sessions[s.id] = { size, mtime: s.mtime, prompts, runs: result.runs };
      scanned++;
    }
    out.push(...prompts);
  }
  writeCache(cache);
  // Live tokens are joined after caching: the token log grows on its own clock.
  const live = readTokenLog();
  const bySession = new Map();
  for (const p of out) {
    if (!bySession.has(p.session)) bySession.set(p.session, []);
    bySession.get(p.session).push(p);
  }
  for (const [id, list] of bySession) attachLiveTokens(list, live.get(id));
  let vscode = null;
  if (source !== 'cli') {
    const v = await readVscode(sinceMs, { dirs: opts.vscodeDirs, cachePath: VSCODE_CACHE });
    out.push(...v.rows);
    vscode = { requests: v.rows.length, withCredits: v.rows.filter((r) => r.credits != null).length, files: v.files };
  }
  return { prompts: out, runs, scanned, reused, quota: latestQuota(live), vscode };
}

// ------------------------------------------------------------------ formatting

const n2 = (c) => (c == null ? '?' : c.toFixed(2));
const int = (n) => (n == null ? '?' : Math.round(n).toLocaleString('en-US'));
const cell = (s, w) => {
  const t = String(s ?? '').replace(/\|/g, '\\|');
  return t.length > w ? `${t.slice(0, w - 1)}…` : t;
};
function dur(sec) {
  if (sec == null) return '…';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`;
}
const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) || 0), 0);
function median(xs) {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
}

function summary(ps, o, stats) {
  const credits = sum(ps, (p) => p.credits);
  const sessionsSeen = new Set(ps.map((p) => p.session)).size;
  const from = o.sinceMs ? new Date(o.sinceMs).toISOString().slice(0, 10) : 'the first session';
  return [
    `# Copilot prompt usage — since ${from}`,
    '',
    `${int(ps.length)} prompts in ${sessionsSeen} sessions: **${n2(credits)} AI credits (${creditsUsd(credits)})**, `
      + `${int(sum(ps, (p) => p.premium))} premium requests, ${dur(sum(ps, (p) => p.activeSeconds))} of active agent time. `
      + `Median prompt ${n2(median(ps.map((p) => p.credits)))} credits, ${dur(median(ps.map((p) => p.activeSeconds)))} active (1 AI credit = $0.01).`,
    tokenLine(ps),
    ...(vscodeLine(ps) ? [vscodeLine(ps)] : []),
    ...(cacheBreakLine(cli(ps)) ? [cacheBreakLine(cli(ps))] : []),
    ...(stats.quota ? [`Premium quota: ${stats.quota.leftPct}% left${stats.quota.resets ? `, resets ${stats.quota.resets.slice(0, 10)}` : ''}.`] : []),
    `_(${stats.scanned} session logs read, ${stats.reused} from cache${o.grep || o.repo ? '; filtered' : ''}.)_`,
    '',
  ];
}

const VSCODE_NOTE = 'VS Code chat rows (sessions named vs-…) come from VS Code\'s own chat storage: tokens and credits are what VS Code '
  + 'recorded per request (an agent-mode request can span several model calls; no cache split, no premium-request count).';

// Cache breaks are only known for Copilot CLI sessions.
const cli = (ps) => ps.filter((p) => p.source !== 'vscode');

/** What the VS Code chat rows in a set of prompts contribute, and how to leave them out. */
function vscodeLine(ps) {
  const v = ps.filter((p) => p.source === 'vscode');
  if (!v.length) return null;
  const withCredits = v.filter((p) => p.credits != null);
  return `Includes ${int(v.length)} VS Code chat requests (${int(withCredits.length)} with a credit figure, ${n2(sum(withCredits, (p) => p.credits))} credits; VS Code recorded `
    + 'credits only from mid-July 2026, earlier requests have tokens but no cost). `--source cli` leaves them out.';
}

/** Tokens over a set of prompts, saying how many are live and how many estimated. */
function tokenTotals(ps) {
  const t = { input: 0, output: 0, live: 0, estimate: 0 };
  for (const p of ps) {
    const x = tokensOf(p);
    if (!x) continue;
    t.input += x.input; t.output += x.output; t[x.source]++;
  }
  return t;
}

function tokenLine(ps) {
  const t = tokenTotals(ps);
  if (!t.live && !t.estimate) return 'Tokens: none recorded for these prompts.';
  return `Tokens: ${fmtTokens({ input: t.input, output: t.output, source: t.live ? 'live' : 'estimate' })} `
    + `(in / out) — live for ${int(t.live)} prompts, estimated for ${int(t.estimate)}.`;
}

function promptTable(ps, o) {
  const shown = [...ps].sort((a, b) => SORTS[o.sort](b) - SORTS[o.sort](a)).slice(0, o.top);
  const out = [`Top ${shown.length} by ${o.sort}:`, '',
    '| When (UTC) | Session | # | Repo | Prompt | Credits | Cost | Prem | Tokens in / out | Active | Wall | Tools | Subagent tokens | Model |',
    '|---|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|'];
  for (const p of shown) {
    out.push(`| ${(p.ts || '').slice(5, 16).replace('T', ' ')} | ${sessionLabel(p.session)} | ${p.n ?? '—'} | ${cell(GROUPS.repo(p), 22)} | `
      + `${cell(p.prompt, 48)} | ${n2(p.credits)}${breakMark(p)} | ${creditsUsd(p.credits)} | ${p.premium ?? (p.source === 'vscode' ? '—' : '?')} | ${fmtTokens(tokensOf(p))} | ${dur(p.activeSeconds)} | ${dur(p.seconds)} | ${p.toolCalls} | `
      + `${p.subagentTokens ? int(p.subagentTokens) : '—'}${p.compactions ? ' ⟳' : ''} | ${cell(p.models.join(', ') || '—', 18)} |`);
  }
  const eg = shown.find((p) => p.n && p.source !== 'vscode');
  if (eg) out.push('', `Open any row with \`/cost prompt <session> <#>\`, e.g. \`/cost prompt ${sessionLabel(eg.session)} ${eg.n}\` (add \`calls\` for its model calls).`);
  if (shown.some((p) => p.compactions)) out.push('', '⟳ = context compacted during the prompt.');
  if (shown.some((p) => p.cacheBreak)) out.push('', BREAK_NOTE);
  return out;
}

/** Seconds a session was up inside the window: its runs, clipped to [since, now]. */
function uptime(runs, sinceMs) {
  const now = Date.now();
  return (runs || []).reduce((a, [s, e]) => {
    const from = Math.max(Date.parse(s), sinceMs);
    const to = Math.min(Date.parse(e), now);
    return a + Math.max(0, to - from);
  }, 0) / 1000;
}

function groupTable(ps, o, runs) {
  const key = GROUPS[o.by];
  const groups = new Map();
  for (const p of ps) {
    const k = key(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const rowsOut = [...groups.entries()].map(([k, g]) => ({
    k, n: g.length, priced: g.filter((p) => p.credits != null).length, credits: sum(g, (p) => p.credits), premium: sum(g, (p) => p.premium),
    seconds: sum(g, (p) => p.activeSeconds), tokens: sum(g, (p) => p.subagentTokens), tok: tokenTotals(g),
  }));
  rowsOut.sort(o.by === 'day' ? (a, b) => b.k.localeCompare(a.k) : (a, b) => b.credits - a.credits);
  const total = sum(rowsOut, (r) => r.credits) || 1;
  // Per session, also how long it was open (up time) and in how many runs.
  const bySession = o.by === 'session';
  const sessionOf = new Map(ps.map((p) => [GROUPS.session(p), p.session]));
  const out = [`By ${o.by}:`, '',
    `| ${o.by[0].toUpperCase() + o.by.slice(1)} | Prompts | Credits | Cost | Share | Avg credits | Premium | Tokens in / out | Active time |`
      + `${bySession ? ' Up time | Runs |' : ''} Subagent tokens |`,
    `|---|---:|---:|---:|---:|---:|---:|---:|---:|${bySession ? '---:|---:|' : ''}---:|`];
  for (const r of rowsOut.slice(0, o.top)) {
    const id = sessionOf.get(r.k);
    const up = bySession ? ` ${dur(Math.round(uptime(runs[id], o.sinceMs)))} | ${(runs[id] || []).length} |` : '';
    out.push(`| ${cell(r.k, 40)} | ${r.n} | ${n2(r.credits)} | ${creditsUsd(r.credits)} | ${Math.round((r.credits / total) * 100)}% | `
      + `${r.priced ? n2(r.credits / r.priced) : '—'} | ${n2(r.premium).replace(/\.00$/, '')} | `
      + `${r.tok.live || r.tok.estimate ? fmtTokens({ input: r.tok.input, output: r.tok.output, source: r.tok.estimate ? 'estimate' : 'live' }) : '—'} | `
      + `${dur(r.seconds)} |${up} ${r.tokens ? int(r.tokens) : '—'} |`);
  }
  if (bySession) {
    out.push('', 'Active time = the agent working on your prompts. Up time = the session open (start or resume '
      + 'to exit), within the window; Runs = how many times it was started or resumed.');
  }
  return out;
}

function csv(ps) {
  const cols = ['ts', 'source', 'session', 'n', 'repository', 'branch', 'cwd', 'prompt', 'credits', 'usd', 'premium', 'tokensIn', 'tokensOut',
    'tokensSource', 'cacheBreak', 'activeSeconds', 'seconds', 'toolCalls', 'subagents', 'subagentTokens', 'compactions', 'models'];
  const esc = (v) => {
    const t = Array.isArray(v) ? v.join(' ') : String(v ?? '');
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const row = (p) => {
    const t = tokensOf(p);
    return { ...p, source: p.source || 'cli', usd: p.credits == null ? '' : (p.credits * 0.01).toFixed(4), tokensIn: t ? t.input : '', tokensOut: t ? t.output : '', tokensSource: t ? t.source : '',
      cacheBreak: p.cacheBreak ? p.cacheBreak.kind : '' };
  };
  return [cols.join(','), ...ps.map((p) => { const r = row(p); return cols.map((c) => esc(r[c])).join(','); })].join('\n');
}

/** The report for these arguments, as text. Throws UsageError on bad input. */
async function run(argv) {
  const o = parseArgs(argv);
  if (o.help) {
    return 'usage: prompt-usage.js [--since 7d|30d|all|DATE] [--top N|--all] '
      + `[--sort ${Object.keys(SORTS).join('|')}] [--by ${Object.keys(GROUPS).join('|')}] `
      + '[--grep TEXT] [--repo TEXT] [--source all|cli|vscode] [--csv|--json]';
  }
  const stats = await collect(o.sinceMs, { source: o.source });
  const ps = stats.prompts.filter((p) => (Date.parse(p.ts) || 0) >= o.sinceMs
    && (!o.grep || p.prompt.toLowerCase().includes(o.grep))
    && (!o.repo || `${p.repository || ''} ${p.cwd || ''}`.toLowerCase().includes(o.repo)));

  if (o.csv) return csv(ps);
  if (o.json) return JSON.stringify(ps, null, 2);
  if (!ps.length) return 'No prompts match.';
  const out = summary(ps, o, stats);
  out.push(...(o.by ? groupTable(ps, o, stats.runs) : promptTable(ps, o)));
  out.push('', TOKENS_NOTE);
  if (ps.some((p) => p.source === 'vscode')) out.push(VSCODE_NOTE);
  return out.join('\n');
}

if (require.main === module) {
  run(process.argv.slice(2)).then(console.log, (err) => {
    console.error(`prompt-usage: ${err instanceof UsageError ? err.message : err.stack}`);
    process.exit(1);
  });
}

module.exports = { run, skillOf, parseSince, rows, uptime, GROUPS, collect };
