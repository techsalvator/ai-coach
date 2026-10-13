#!/usr/bin/env node
/**
 * tool-usage — which kinds of tool calls drive the cost of Copilot CLI sessions.
 *
 * Copilot logs no tokens or credits per tool call. What it logs is every call's name,
 * arguments and full result text. A result joins the conversation and is re-read by
 * every later model call until the context is compacted, and those re-reads dominate
 * a long session's usage (one session: 366M cache-read tokens vs 0.6M fresh input).
 * So a call's cost is estimated as
 *
 *     carried tokens = result tokens (≈ characters / 4) × later model calls until compaction
 *
 * counted in the context that made the call (the main agent, or that subagent). These
 * are estimates for ranking, not billed amounts; the report shows the session's real
 * cache-read tokens next to them where Copilot recorded them.
 *
 *   node lib/tool-usage.js                          # last 7 days, by tool
 *   node lib/tool-usage.js --by command             # shell commands by program
 *   node lib/tool-usage.js --by call --top 15       # heaviest single calls
 *   node lib/tool-usage.js --since 30d --scope all  # include subagents' own calls
 *   node lib/tool-usage.js --session a05dcb09
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { sessions, UsageError } = require('./session-cost');

const CACHE = path.join(require('./paths').CACHE_DIR, 'tool-usage-v2.json');
const CHARS_PER_TOKEN = 4;
const MAIN = 'main';

function fail(msg) {
  throw new UsageError(msg);
}

function parseArgs(argv) {
  const o = { since: '7d', top: 20, by: 'tool', scope: 'main', session: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) fail(`${a} needs a value`); return argv[++i]; };
    if (a === '--since') o.since = val();
    else if (a === '--top') o.top = Number(val());
    else if (a === '--by') o.by = val();
    else if (a === '--scope') o.scope = val();
    else if (a === '--session') o.session = val();
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else fail(`unknown argument ${a}`);
  }
  if (!['tool', 'command', 'call'].includes(o.by)) fail('--by is one of: tool, command, call');
  if (!['main', 'subagents', 'all'].includes(o.scope)) fail('--scope is one of: main, subagents, all');
  if (!(o.top > 0)) fail('--top needs a positive number');
  if (o.session) o.since = 'all';
  o.sinceMs = parseSince(o.since);
  return o;
}

function parseSince(v) {
  if (v === 'all') return 0;
  const m = /^(\d+)([dh])$/.exec(v);
  if (m) return Date.now() - Number(m[1]) * (m[2] === 'd' ? 86400e3 : 3600e3);
  const t = Date.parse(v);
  if (Number.isNaN(t)) fail(`--since takes 7d, 12h, all, or a date (got "${v}")`);
  return t;
}

/** What a shell call actually ran: drop a leading `cd <dir> &&|;`, keep `rtk <cmd>`
 *  together, and take the first command of a pipeline. */
function stripPrefix(cmd) {
  let c = String(cmd || '').trim();
  for (let i = 0; i < 3; i++) c = c.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;|\n)\s*/, '');
  return c.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, ''); // FOO=bar cmd
}

function commandOf(cmd) {
  const c = stripPrefix(cmd);
  const words = c.split(/[\s|;&]+/).filter(Boolean);
  if (!words.length) return '(empty)';
  const prog = path.basename(words[0]);
  return prog === 'rtk' && words[1] ? `rtk ${words[1]}` : prog;
}

/** A short, human label for one call's arguments. */
function detailOf(name, args) {
  const a = args || {};
  const v = (a.command && stripPrefix(a.command)) || a.path || a.pattern || a.query || a.url || a.issueIdOrKey || a.prompt || '';
  return String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').trim();
}

/** Every tool call in one session log, with its estimated carried tokens. */
async function analyseTools(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const turns = {};        // context -> model calls so far
  const compactions = {};  // context -> turn numbers at which it was compacted
  const open = new Map();  // toolCallId -> call
  const calls = [];
  let cacheRead = null;
  for await (const line of rl) {
    // Cheap pre-filter: logs are hundreds of MB and most lines are other events.
    const head = line.slice(0, 64);
    if (!/"type":"(tool\.execution_|assistant\.turn_start|session\.(compaction_complete|shutdown))/.test(head)) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const d = e.data || {};
    const ctx = e.agentId || MAIN;
    if (e.type === 'assistant.turn_start') turns[ctx] = (turns[ctx] || 0) + 1;
    else if (e.type === 'session.compaction_complete') (compactions[ctx] ||= []).push(turns[ctx] || 0);
    else if (e.type === 'session.shutdown') {
      const t = d.tokenDetails && d.tokenDetails.cache_read && d.tokenDetails.cache_read.tokenCount;
      if (t != null) cacheRead = t;
    } else if (e.type === 'tool.execution_start') {
      const shell = d.toolName === 'bash' || d.toolName === 'powershell' || d.shellToolInfo;
      open.set(d.toolCallId, {
        ts: e.timestamp, ctx, tool: d.toolName,
        command: shell ? commandOf(d.arguments && d.arguments.command) : null,
        detail: detailOf(d.toolName, d.arguments).slice(0, 160), turn: turns[ctx] || 0,
      });
    } else if (e.type === 'tool.execution_complete') {
      const c = open.get(d.toolCallId);
      if (!c) continue;
      open.delete(d.toolCallId);
      const content = d.result && d.result.content;
      c.tokens = Math.round(String(typeof content === 'string' ? content : JSON.stringify(content ?? '')).length / CHARS_PER_TOKEN);
      c.ms = Math.max(0, Date.parse(e.timestamp) - Date.parse(c.ts));
      calls.push(c);
    }
  }
  for (const c of calls) {
    const next = (compactions[c.ctx] || []).find((t) => t > c.turn) ?? (turns[c.ctx] || 0);
    c.carried = c.tokens * Math.max(0, next - c.turn);
    delete c.turn;
  }
  return { calls, cacheRead };
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return { sessions: {} }; }
}

async function collect(o) {
  const cache = readCache();
  const out = [];
  const cacheReads = {};
  let scanned = 0;
  let reused = 0;
  let list = sessions();
  if (o.session) {
    list = list.filter((s) => s.id.startsWith(o.session));
    if (list.length !== 1) fail(list.length ? `"${o.session}" matches ${list.length} sessions` : `no session matches "${o.session}"`);
  }
  for (const s of list) {
    if (s.mtime < o.sinceMs) continue;
    const { size } = fs.statSync(s.file);
    const hit = cache.sessions[s.id];
    let r;
    if (hit && hit.size === size && hit.mtime === s.mtime) {
      r = hit;
      reused++;
    } else {
      const a = await analyseTools(s.file);
      r = { size, mtime: s.mtime, calls: a.calls, cacheRead: a.cacheRead };
      cache.sessions[s.id] = r;
      scanned++;
    }
    for (const c of r.calls) out.push({ ...c, session: s.id });
    cacheReads[s.id] = r.cacheRead;
  }
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(cache));
  } catch { /* speed only */ }
  return { calls: out, cacheReads, scanned, reused };
}

// ------------------------------------------------------------------ formatting

const int = (n) => Math.round(n).toLocaleString('en-US');
const big = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
  : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(Math.round(n)));
const cell = (s, w) => {
  const t = String(s ?? '').replace(/\|/g, '\\|');
  return t.length > w ? `${t.slice(0, w - 1)}…` : t;
};
const secs = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60e3 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60e3)}m`);

function keyOf(c, by) {
  if (by === 'command') return c.command ? `$ ${c.command}` : c.tool;
  return c.tool;
}

async function run(argv) {
  const o = parseArgs(argv);
  if (o.help) {
    return 'usage: tool-usage.js [--since 7d|30d|all|DATE] [--session ID] [--by tool|command|call] '
      + '[--scope main|subagents|all] [--top N] [--json]';
  }
  const stats = await collect(o);
  const calls = stats.calls.filter((c) => (Date.parse(c.ts) || 0) >= o.sinceMs
    && (o.scope === 'all' || (o.scope === 'main') === (c.ctx === MAIN)));
  if (o.json) return JSON.stringify(calls, null, 2);
  if (!calls.length) return 'No tool calls match.';

  const total = calls.reduce((a, c) => a + c.carried, 0) || 1;
  const sessionsSeen = new Set(calls.map((c) => c.session));
  const realRead = [...sessionsSeen].reduce((a, id) => a + (stats.cacheReads[id] || 0), 0);
  const from = o.sinceMs ? new Date(o.sinceMs).toISOString().slice(0, 10) : 'the first session';
  const out = [
    `# Copilot tool calls — ${o.session ? `session ${o.session}` : `since ${from}`}, ${o.scope === 'main' ? 'main agent' : o.scope}`,
    '',
    `${int(calls.length)} calls in ${sessionsSeen.size} sessions returned ~${big(calls.reduce((a, c) => a + c.tokens, 0))} tokens, `
      + `carried through ~**${big(total)} tokens** of later model calls.`
      + (realRead ? ` (Those sessions' real cache reads, for scale: ${big(realRead)}.)` : ''),
    `_(${stats.scanned} session logs read, ${stats.reused} from cache.)_`,
    '',
  ];

  if (o.by === 'call') {
    out.push(`Heaviest ${Math.min(o.top, calls.length)} calls:`, '',
      '| When (UTC) | Session | Tool | Call | Result tokens | Carried tokens | Share | Took |',
      '|---|---|---|---|---:|---:|---:|---:|');
    for (const c of [...calls].sort((a, b) => b.carried - a.carried).slice(0, o.top)) {
      out.push(`| ${(c.ts || '').slice(5, 16).replace('T', ' ')} | ${c.session.slice(0, 8)} | ${c.tool} | ${cell(c.detail, 60)} | `
        + `${int(c.tokens)} | ${big(c.carried)} | ${((c.carried / total) * 100).toFixed(1)}% | ${secs(c.ms)} |`);
    }
  } else {
    const groups = new Map();
    for (const c of calls) {
      const k = keyOf(c, o.by);
      const g = groups.get(k) || { k, n: 0, tokens: 0, carried: 0, ms: 0, max: 0 };
      g.n++; g.tokens += c.tokens; g.carried += c.carried; g.ms += c.ms; g.max = Math.max(g.max, c.tokens);
      groups.set(k, g);
    }
    out.push(`By ${o.by}:`, '',
      `| ${o.by === 'command' ? 'Tool / command' : 'Tool'} | Calls | Result tokens | Avg | Largest | Carried tokens | Share | Time |`,
      '|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const g of [...groups.values()].sort((a, b) => b.carried - a.carried).slice(0, o.top)) {
      out.push(`| ${cell(g.k, 36)} | ${int(g.n)} | ${big(g.tokens)} | ${int(g.tokens / g.n)} | ${int(g.max)} | `
        + `${big(g.carried)} | ${((g.carried / total) * 100).toFixed(1)}% | ${secs(g.ms)} |`);
    }
  }
  out.push('', 'Carried tokens = result size (≈ characters / 4) × later model calls that re-read it before the '
    + 'context was compacted. Estimates for ranking, not billed amounts: Copilot logs no cost per tool call.');
  return out.join('\n');
}

if (require.main === module) {
  run(process.argv.slice(2)).then(console.log, (err) => {
    console.error(`tool-usage: ${err instanceof UsageError ? err.message : err.stack}`);
    process.exit(1);
  });
}

module.exports = { run, analyseTools, commandOf };
