#!/usr/bin/env node
/**
 * claude-cost — per-prompt cost of Claude Code sessions, from their transcripts.
 *
 * Claude Code's built-in /usage shows session totals; this shows each prompt: estimated
 * cost, tokens, cache hit rate, model, tools, subagents, and cache breaks. Run it without
 * the model (no tokens) from inside Claude Code with the `!` prefix:
 *
 *   ! node <repo>/bin/claude-cost.js                 # this session (most recent)
 *   ! node <repo>/bin/claude-cost.js --last 10
 *   ! node <repo>/bin/claude-cost.js 6c94f208        # a session by id prefix
 *   ! node <repo>/bin/claude-cost.js --list          # recent sessions
 *   ! node <repo>/bin/claude-cost.js --prompts --since 7d [--by project|day|model|session] [--top N]
 *   ! node <repo>/bin/claude-cost.js --epics [--since 30d] [--stories] [--key FOPTS-123] [--repo TEXT] [--csv]
 *
 * Tables print as aligned box tables fitted to the terminal width (--width N to set it);
 * --md prints the raw markdown instead (for pasting into a document).
 *
 * Data: ~/.claude/projects/<project>/<session>.jsonl (main conversation) and
 * <session>/subagents/agent-*.jsonl (+ .meta.json). One API response is written as
 * several records sharing a message id, so usage is counted once per id.
 *
 * Cost: a transcript's `cost-state` record holds Claude Code's own cost per model for the
 * session (list price, or your organisation's configured rates). It is split across that
 * model's calls in proportion to weighted tokens — input 1, cache write 1.25 (5-minute)
 * or 2 (1-hour), cache read 0.1, output 5 — so prompts add up to Claude Code's figure.
 * Sessions without `cost-state` use the cost per weighted token learned from those with
 * one, marked ~. A model never seen with a `cost-state` shows no cost.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { PromptJira, isJiraTool } = require('./jira-signals');

const ROOT = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

class UsageError extends Error {}
const fail = (msg) => { throw new UsageError(msg); };

// ------------------------------------------------------------------ transcripts

/** Main-conversation transcripts, most recently written first. */
function sessions(root = ROOT) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const dir = path.join(root, proj.name);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      out.push({ id: f.slice(0, -6), project: proj.name, file, mtime: fs.statSync(file).mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

async function* records(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    try { yield JSON.parse(line); } catch { /* partial line */ }
  }
}

// Skills whose commands count as prompts. Typed as "/design FOPTS-1", Claude Code logs the command as an
// echo record, not as a prompt, so the run's cost would fold into the prompt before it. Names come from
// the skills folders: PhantomFlow's (~/.phantomflow/skills/*.md) by default, or AI_COST_SKILLS_DIR /
// PHANTOMFLOW_SKILLS_DIR (a list separated like PATH). A folder holds `name.md` files or `name/SKILL.md`.
const SKILLS_DIRS = (process.env.AI_COST_SKILLS_DIR || process.env.PHANTOMFLOW_SKILLS_DIR
  || path.join(os.homedir(), '.phantomflow', 'skills')).split(path.delimiter).filter(Boolean);
const PF_SKILLS = (() => {
  const names = new Set();
  for (const dir of SKILLS_DIRS) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.md')) names.add(e.name.slice(0, -3));
        else if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md'))) names.add(e.name);
      }
    } catch { /* no such folder */ }
  }
  return names;
})();

/** "/design FOPTS-1" for a command echo of a PhantomFlow skill, else null. */
function commandPrompt(content, skills = PF_SKILLS) {
  const m = /<command-name>\/?([\w:.-]+)<\/command-name>/.exec(content);
  if (!m || !skills.has(m[1])) return null;
  const a = /<command-args>([^]*?)<\/command-args>/.exec(content);
  return `/${m[1]}${a && a[1].trim() ? ` ${a[1].trim()}` : ''}`;
}

/** A prompt the user typed: string content from a human (or a PhantomFlow skill command), not another
 *  command echo or meta record. */
function isUserPrompt(e, skills = PF_SKILLS) {
  if (e.type !== 'user' || e.isSidechain || e.isMeta) return false;
  const c = e.message && e.message.content;
  if (typeof c !== 'string' || !c.trim()) return false;
  if (e.origin && e.origin.kind && e.origin.kind !== 'human') return false;
  if (commandPrompt(c, skills)) return true;
  return !/^<(command-|local-command|bash-|task-notification|system-reminder)/.test(c.trim());
}

const promptText = (c) => commandPrompt(c) || c.replace(/\s+/g, ' ').trim();

/** Weighted tokens: cost relative to one uncached input token. */
function weight(u) {
  const cc = u.cache_creation || {};
  const c1h = cc.ephemeral_1h_input_tokens || 0;
  const c5m = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens
    : Math.max(0, (u.cache_creation_input_tokens || 0) - c1h);
  return (u.input_tokens || 0) + 1.25 * c5m + 2 * c1h + 0.1 * (u.cache_read_input_tokens || 0) + 5 * (u.output_tokens || 0);
}

const promptSize = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
const baseModel = (m) => String(m || '').replace(/-\d{8}$/, '');

/** What a tool call did, in a few words: the command, file, pattern or target. */
function toolDetail(name, input) {
  const i = input || {};
  const strip = (c) => String(c).replace(/^(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/, '');
  let d;
  if (i.command) d = strip(i.command);
  else if (i.file_path) d = i.file_path + (i.offset || i.limit ? ` (lines ${i.offset || 1}${i.limit ? `+${i.limit}` : ''})` : '');
  else if (i.pattern) d = `${i.pattern}${i.path ? ` in ${i.path}` : ''}`;
  else if (i.url) d = i.url;
  else if (i.subagent_type || i.description) d = [i.subagent_type, i.description].filter(Boolean).join(': ');
  else if (i.query) d = i.query;
  else if (i.skill) d = i.skill;
  else {
    const first = Object.values(i).find((v) => typeof v === 'string');
    d = first || JSON.stringify(i);
  }
  return String(d).replace(/\s+/g, ' ').trim();
}

/** Text length of a tool_result's content (string or blocks). */
function resultChars(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) return content.reduce((a, b) => a + (b && typeof b.text === 'string' ? b.text.length : b && b.type === 'image' ? 0 : JSON.stringify(b || '').length), 0);
  return 0;
}

/** The text of a tool_result's content (string or blocks). */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
  return '';
}

/** Calls in a transcript, one per API message id (the record with the most output wins).
 *  Tool calls and their results go into `toolLog` (id -> call) when given. */
async function calls(file, onRecord, toolLog) {
  const byId = new Map();
  for await (const e of records(file)) {
    if (onRecord) onRecord(e);
    if (toolLog && e.message && Array.isArray(e.message.content)) {
      for (const b of e.message.content) {
        if (!b) continue;
        if (e.type === 'assistant' && b.type === 'tool_use' && b.id && !toolLog.has(b.id)) {
          const t = { id: b.id, name: b.name, detail: toolDetail(b.name, b.input), ts: e.timestamp };
          // Jira calls keep their arguments and result: they say which ticket a prompt worked on.
          if (isJiraTool(b.name)) t.args = b.input;
          toolLog.set(b.id, t);
        } else if (e.type === 'user' && b.type === 'tool_result' && b.tool_use_id) {
          const t = toolLog.get(b.tool_use_id);
          if (t) {
            t.resultChars = resultChars(b.content); t.resultTs = e.timestamp; t.error = Boolean(b.is_error);
            if (t.args) t.content = resultText(b.content);
          }
        }
      }
    }
    const m = e.type === 'assistant' && e.message;
    if (!m || !m.usage || !m.id || m.model === '<synthetic>') continue;
    const prev = byId.get(m.id);
    if (!prev || (m.usage.output_tokens || 0) >= (prev.u.output_tokens || 0)) {
      const tools = (m.content || []).filter((b) => b && b.type === 'tool_use').map((b) => b.id);
      byId.set(m.id, { ts: e.timestamp, model: baseModel(m.model), u: m.usage, tools: new Set([...(prev ? prev.tools : []), ...tools]) });
    } else {
      for (const b of m.content || []) if (b && b.type === 'tool_use') prev.tools.add(b.id);
    }
  }
  return [...byId.values()].sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

async function analyse(session) {
  const prompts = [];
  let costState = null;
  let title = null;
  let cwd = null;
  let branch = null;
  const mainTools = new Map();
  const main = await calls(session.file, (e) => {
    if (e.type === 'cost-state') costState = e;
    else if (e.type === 'custom-title' && e.customTitle) title = e.customTitle;
    if (e.cwd) cwd = e.cwd;
    if (e.gitBranch) branch = e.gitBranch;
    if (isUserPrompt(e)) {
      prompts.push({ ts: e.timestamp, prompt: promptText(e.message.content), cwd: e.cwd, branch: e.gitBranch,
        main: [], sub: [], tools: 0, toolCalls: [], end: e.timestamp });
    }
  }, mainTools);
  prompts.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const owner = (ts) => {
    let p = null;
    for (const q of prompts) { if (q.ts <= ts) p = q; else break; }
    return p;
  };
  const unattributed = [];
  for (const c of main) {
    const p = owner(c.ts);
    if (!p) { unattributed.push(c); continue; }
    p.main.push(c);
    p.tools += c.tools.size;
    if (c.ts > p.end) p.end = c.ts;
  }
  for (const t of mainTools.values()) {
    const p = owner(t.ts);
    if (p) p.toolCalls.push({ ...t, where: 'main' });
  }
  // Subagents: their own transcripts, attributed to the prompt that was running.
  const subDir = path.join(path.dirname(session.file), session.id, 'subagents');
  const agents = [];
  if (fs.existsSync(subDir)) {
    for (const f of fs.readdirSync(subDir).filter((x) => x.endsWith('.jsonl'))) {
      let type = 'subagent';
      try { type = JSON.parse(fs.readFileSync(path.join(subDir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8')).agentType || type; } catch { /* no meta */ }
      const subTools = new Map();
      const cs = await calls(path.join(subDir, f), null, subTools);
      agents.push({ type, calls: cs });
      for (const t of subTools.values()) {
        const p = owner(t.ts);
        if (p) p.toolCalls.push({ ...t, where: type });
      }
      for (const c of cs) {
        c.agent = type;
        const p = owner(c.ts);
        if (p) { p.sub.push(c); if (c.ts > p.end) p.end = c.ts; } else unattributed.push(c);
      }
    }
  }
  for (const p of prompts) {
    p.toolCalls.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    p.jira = new PromptJira();
    for (const t of p.toolCalls) {
      if (!t.args) continue;
      const started = p.jira.start(t.name, t.args);
      if (started && !t.error && t.content != null) p.jira.complete(t.name, started, t.content);
      delete t.content; // only needed here
    }
  }
  detectBreaks(prompts);
  return { session, prompts, unattributed, agents, costState, title, cwd, branch };
}

/** A prompt whose first main call re-processed what the previous call had cached. */
function detectBreaks(prompts) {
  let prev = null;
  for (const p of prompts) {
    const first = p.main[0];
    if (first && prev) {
      const expected = promptSize(prev.u);
      const read = first.u.cache_read_input_tokens || 0;
      if (expected >= 2000 && read < 0.95 * expected) {
        const ttl = (prev.u.cache_creation && prev.u.cache_creation.ephemeral_1h_input_tokens) ? 3600 : 300;
        const gap = (Date.parse(first.ts) - Date.parse(prev.ts)) / 1000;
        const kind = first.model !== prev.model ? 'switch' : gap > ttl ? 'idle' : 'miss';
        p.cacheBreak = { kind, from: prev.model, to: first.model, gapSeconds: Math.round(gap), ttlSeconds: ttl,
          uncached: (first.u.cache_creation_input_tokens || 0) + (first.u.input_tokens || 0) };
      }
    }
    if (p.main.length) prev = p.main[p.main.length - 1];
  }
}

// ------------------------------------------------------------------ cost

/** Cost per weighted token per model: from this session's cost-state, else learned. */
function rates(result, learned) {
  const all = [...result.prompts.flatMap((p) => [...p.main, ...p.sub]), ...result.unattributed];
  const w = {};
  for (const c of all) w[c.model] = (w[c.model] || 0) + weight(c.u);
  const own = {};
  if (result.costState && result.costState.modelUsage) {
    for (const [m, v] of Object.entries(result.costState.modelUsage)) {
      const k = baseModel(m);
      if (v && v.costUSD > 0 && w[k] > 0) own[k] = v.costUSD / w[k];
    }
  }
  return (model) => (own[model] != null ? { k: own[model], est: false }
    : learned && learned[model] != null ? { k: learned[model], est: true } : null);
}

function priceCalls(cs, rate) {
  let usd = 0;
  let est = false;
  let missing = false;
  for (const c of cs) {
    const r = rate(c.model);
    if (!r) { missing = true; continue; }
    usd += weight(c.u) * r.k;
    est = est || r.est;
  }
  return { usd, est, missing };
}

/** Prompt rows with cost and tokens. */
function rows(result, learned) {
  const rate = rates(result, learned);
  return result.prompts.map((p) => {
    const cs = [...p.main, ...p.sub];
    const cost = priceCalls(cs, rate);
    const tin = cs.reduce((a, c) => a + promptSize(c.u), 0);
    const read = cs.reduce((a, c) => a + (c.u.cache_read_input_tokens || 0), 0);
    return {
      session: result.session.id, project: result.session.project, ts: p.ts, prompt: p.prompt, cwd: p.cwd, branch: p.branch,
      usd: cs.length ? cost.usd : null, usdEstimated: cost.est, usdPartial: cost.missing,
      tokensIn: tin, tokensOut: cs.reduce((a, c) => a + (c.u.output_tokens || 0), 0),
      cacheHit: tin ? read / tin : null,
      models: [...new Set(p.main.map((c) => c.model))], calls: p.main.length, tools: p.tools,
      subagents: [...new Set(p.sub.map((c) => c.agent))], subTokens: p.sub.reduce((a, c) => a + promptSize(c.u) + (c.u.output_tokens || 0), 0),
      seconds: Math.round((Date.parse(p.end) - Date.parse(p.ts)) / 1000), cacheBreak: p.cacheBreak || null,
      toolCalls: p.toolCalls, jira: p.jira.toJSON(),
      modelCalls: [...p.main.map((c) => ({ ...c, who: 'main' })), ...p.sub.map((c) => ({ ...c, who: c.agent }))],
      rate: (c) => { const x = rate(c.model); return x ? weight(c.u) * x.k : null; },
    };
  });
}

/** Cost per weighted token per model, learned from every session with a cost-state. */
async function learnRates(list) {
  const cost = {};
  const w = {};
  const results = [];
  for (const s of list) {
    const r = await analyse(s);
    results.push(r);
    if (!r.costState || !r.costState.modelUsage) continue;
    const all = [...r.prompts.flatMap((p) => [...p.main, ...p.sub]), ...r.unattributed];
    const ws = {};
    for (const c of all) ws[c.model] = (ws[c.model] || 0) + weight(c.u);
    for (const [m, v] of Object.entries(r.costState.modelUsage)) {
      const k = baseModel(m);
      if (v && v.costUSD > 0 && ws[k] > 0) { cost[k] = (cost[k] || 0) + v.costUSD; w[k] = (w[k] || 0) + ws[k]; }
    }
  }
  const learned = {};
  for (const k of Object.keys(cost)) learned[k] = cost[k] / w[k];
  return { learned, results };
}

// ------------------------------------------------------------------ formatting

const usd = (r) => (r.usd == null ? '—' : `${r.usdEstimated ? '~' : ''}$${r.usd.toFixed(r.usd < 1 ? 3 : 2)}${r.usdPartial ? '+' : ''}`);
const k = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const cell = (s, w) => { const t = String(s ?? '').replace(/\|/g, '\\|'); return t.length > w ? `${t.slice(0, w - 1)}…` : t; };
function dur(s) {
  if (s == null || Number.isNaN(s)) return '…';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}
const mark = (r) => (!r.cacheBreak ? '' : `${{ switch: ' ⇄', idle: ' ⏲', miss: ' ✕' }[r.cacheBreak.kind]} ${k(r.cacheBreak.uncached)}`);
const projectName = (r) => (r.cwd ? path.basename(r.cwd) : r.project);

function breakLine(rs) {
  const done = rs.filter((r) => r.usd != null);
  const med = (a) => { const v = a.map((r) => r.usd).sort((x, y) => x - y); return v.length ? `$${v[Math.floor(v.length / 2)].toFixed(2)}` : '—'; };
  const by = (kind) => done.filter((r) => r.cacheBreak && r.cacheBreak.kind === kind);
  const [sw, idle, miss] = ['switch', 'idle', 'miss'].map(by);
  if (!sw.length && !idle.length && !miss.length) return null;
  return `Cache breaks: ${sw.length} model switch (⇄), ${idle.length} idle expiry (⏲), ${miss.length} other miss (✕) in ${done.length} prompts. `
    + `Median cost ${med(done.filter((r) => !r.cacheBreak))} with the cache warm, ${med([...sw, ...idle, ...miss])} after a break.`;
}

const NOTES = [
  'Cost splits Claude Code\'s own per-model figure for the session (its `cost-state`) by weighted tokens; ~ = estimated from other sessions\' rates; + = a model without a rate. Figures are list-price estimates unless your organisation configured rates — subscription usage is not billed per token.',
  '⇄ model switch, ⏲ idle past the cache lifetime (5 min or 1 h), ✕ other cache miss (e.g. compaction): the number is the tokens re-cached at full price.',
];

function sessionReport(result, rs, last) {
  const shown = rs.slice(-last);
  const cs = result.costState;
  const total = rs.reduce((a, r) => a + (r.usd || 0), 0);
  const out = [`# Claude Code session — ${result.session.id.slice(0, 8)}${result.title ? ` · ${result.title}` : ''}`, '',
    `\`${result.cwd || result.session.project}\`${result.branch ? ` on \`${result.branch}\`` : ''}. ${rs.length} prompts; showing the last ${shown.length}.`,
    cs ? `Claude Code's own session cost: **$${cs.totalCostUSD.toFixed(2)}** (prompts account for $${total.toFixed(2)}; the rest is background calls).`
      : `Estimated session cost: **~$${total.toFixed(2)}** (no cost-state in this transcript).`];
  const b = breakLine(shown);
  if (b) out.push(b);
  out.push('', '| # | When (UTC) | Prompt | Cost | Tokens in / out | Cache hit | Model | Tools | Subagents (tokens) | Took |',
    '|---|---|---|---:|---:|---:|---|---:|---|---:|');
  shown.forEach((r, i) => {
    const n = rs.length - shown.length + i + 1;
    out.push(`| ${n} | ${r.ts.slice(5, 16).replace('T', ' ')} | ${cell(r.prompt, 48)} | ${usd(r)}${mark(r)} | ${r.calls || r.subTokens ? `${k(r.tokensIn)} / ${k(r.tokensOut)}` : '—'} | `
      + `${pct(r.cacheHit)} | ${cell(r.models.join(', ') || '—', 18)} | ${r.tools} | ${r.subagents.length ? `${cell(r.subagents.join(', '), 20)} (${k(r.subTokens)})` : '—'} | ${dur(r.seconds)} |`);
  });
  if (result.agents.length) {
    const agg = new Map();
    for (const a of result.agents) {
      const g = agg.get(a.type) || { runs: 0, tokens: 0 };
      g.runs++; g.tokens += a.calls.reduce((s, c) => s + promptSize(c.u) + (c.u.output_tokens || 0), 0);
      agg.set(a.type, g);
    }
    out.push('', '## Subagents', '| Agent | Runs | Tokens |', '|---|---:|---:|');
    for (const [t, g] of [...agg].sort((a, b2) => b2[1].tokens - a[1].tokens)) out.push(`| ${t} | ${g.runs} | ${k(g.tokens)} |`);
  }
  out.push('', ...NOTES);
  return out.join('\n');
}

/** Where one prompt's tokens (and estimated cost) went: by who and model, by token type, plus the largest calls. */
function tokenSplit(r) {
  const cs = r.modelCalls || [];
  if (!cs.length) return ['## Tokens', 'No model calls in this prompt.'];
  const n = (x) => Math.round(x).toLocaleString('en-US');
  const f = (c) => ({ fresh: c.u.input_tokens || 0, read: c.u.cache_read_input_tokens || 0, write: c.u.cache_creation_input_tokens || 0,
    out: c.u.output_tokens || 0, think: (c.u.output_tokens_details && c.u.output_tokens_details.thinking_tokens) || 0, usd: r.rate(c) });
  const groups = new Map();
  const tot = { calls: 0, fresh: 0, read: 0, write: 0, out: 0, think: 0, usd: 0, input: 0 };
  for (const c of cs) {
    const x = f(c);
    const key = `${c.who}\u0000${c.model}`;
    const g = groups.get(key) || { who: c.who, model: c.model, calls: 0, fresh: 0, read: 0, write: 0, out: 0, think: 0, usd: 0, input: 0 };
    for (const t of [g, tot]) {
      t.calls++; t.fresh += x.fresh; t.read += x.read; t.write += x.write; t.out += x.out; t.think += x.think;
      t.usd += x.usd || 0; t.input += x.fresh + x.read + x.write;
    }
    groups.set(key, g);
  }
  const share = (x, of) => `${of ? Math.round((x / of) * 100) : 0}%`;
  const out = ['## Tokens', '',
    `${n(tot.calls)} model calls read **${n(tot.input)} input tokens**: ${n(tot.read)} (${share(tot.read, tot.input)}) re-read from cache, `
      + `${n(tot.write)} (${share(tot.write, tot.input)}) written to cache, ${n(tot.fresh)} (${share(tot.fresh, tot.input)}) fresh. `
      + `Output ${n(tot.out)} tokens, of which ${n(tot.think)} thinking.`, '',
    '| Who | Model | Calls | Input | Cache read | Cache write | Fresh | Output | Thinking | Est. cost | Share of cost |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const g of [...groups.values()].sort((a, b) => b.usd - a.usd || b.input - a.input)) {
    out.push(`| ${cell(g.who, 22)} | ${g.model} | ${g.calls} | ${n(g.input)} | ${n(g.read)} | ${n(g.write)} | ${n(g.fresh)} | ${n(g.out)} | ${n(g.think)} | `
      + `$${g.usd.toFixed(3)} | ${share(g.usd, tot.usd)} |`);
  }
  out.push(`| **Total** | | **${tot.calls}** | **${n(tot.input)}** | **${n(tot.read)}** | **${n(tot.write)}** | **${n(tot.fresh)}** | **${n(tot.out)}** | `
    + `**${n(tot.think)}** | **$${tot.usd.toFixed(3)}** | 100% |`);
  // What drives the cost: cache reads are cheap per token but numerous; writes and output are dear.
  const w = { read: 0.1 * tot.read, write: 0, out: 5 * tot.out, fresh: tot.fresh };
  for (const c of cs) {
    const cc = c.u.cache_creation || {};
    const c1h = cc.ephemeral_1h_input_tokens || 0;
    w.write += 2 * c1h + 1.25 * Math.max(0, (c.u.cache_creation_input_tokens || 0) - c1h);
  }
  const wt = w.read + w.write + w.out + w.fresh || 1;
  out.push('', `Cost drivers (weighted): cache reads ${share(w.read, wt)}, cache writes ${share(w.write, wt)}, `
    + `output ${share(w.out, wt)}, fresh input ${share(w.fresh, wt)}.`);
  const t0 = Date.parse(r.ts);
  out.push('', 'Largest model calls:', '', '| At | Who | Model | Input | Cache read | Cache write | Output |', '|---:|---|---|---:|---:|---:|---:|');
  for (const c of [...cs].sort((a, b) => promptSize(b.u) - promptSize(a.u)).slice(0, 5)) {
    const x = f(c);
    out.push(`| +${dur(Math.round((Date.parse(c.ts) - t0) / 1000))} | ${cell(c.who, 22)} | ${c.model} | ${n(x.fresh + x.read + x.write)} | ${n(x.read)} | ${n(x.write)} | ${n(x.out)} |`);
  }
  return out;
}

/** Every tool call one prompt made, in order, main conversation and subagents. */
function promptReport(result, rs, n) {
  if (!(n >= 1 && n <= rs.length)) fail(`--prompt takes 1..${rs.length} (the # column of the session report)`);
  const r = rs[n - 1];
  const t0 = Date.parse(r.ts);
  const secs = (a, b) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)) : null);
  const out = [`# Prompt ${n} of session ${result.session.id.slice(0, 8)}`, '', `> ${cell(r.prompt, 300)}`, '',
    `${r.ts.slice(0, 16).replace('T', ' ')} UTC · ${usd(r)}${mark(r)} · ${r.calls ? `${k(r.tokensIn)} in / ${k(r.tokensOut)} out` : 'no model calls'} · `
      + `cache hit ${pct(r.cacheHit)} · ${r.models.join(', ') || '—'} · ${r.calls} model call${r.calls === 1 ? '' : 's'} · took ${dur(r.seconds)}`, ''];
  out.push(...tokenSplit(r), '');
  const tc = r.toolCalls || [];
  if (!tc.length) { out.push('No tool calls in this prompt.'); return out.join('\n'); }
  out.push(`${tc.length} tool call${tc.length === 1 ? '' : 's'}:`, '', '| # | At | Where | Tool | What | Result | Took |', '|---:|---:|---|---|---|---:|---:|');
  tc.forEach((t, i) => {
    const res = t.resultChars == null ? '—' : `${k(Math.round(t.resultChars / 4))} tok${t.error ? ' ✗' : ''}`;
    out.push(`| ${i + 1} | +${dur(Math.round((Date.parse(t.ts) - t0) / 1000))} | ${cell(t.where, 16)} | ${cell(t.name, 28)} | ${cell(t.detail, 70)} | ${res} | ${dur(secs(t.ts, t.resultTs))} |`);
  });
  const by = new Map();
  for (const t of tc) {
    const g = by.get(t.name) || { n: 0, tok: 0, s: 0, err: 0 };
    g.n++; g.tok += Math.round((t.resultChars || 0) / 4); g.s += secs(t.ts, t.resultTs) || 0; g.err += t.error ? 1 : 0;
    by.set(t.name, g);
  }
  out.push('', '| Tool | Calls | Result tokens | Time | Errors |', '|---|---:|---:|---:|---:|');
  for (const [name, g] of [...by].sort((a, b) => b[1].tok - a[1].tok)) out.push(`| ${cell(name, 36)} | ${g.n} | ${k(g.tok)} | ${dur(g.s)} | ${g.err || '—'} |`);
  out.push('', 'Result tokens ≈ characters / 4: what each result added to the context; ✗ = the tool returned an error. "Where" is the main conversation or the subagent that made the call.');
  return out.join('\n');
}

function parseSince(v) {
  if (v === 'all') return 0;
  const m = /^(\d+)([dh])$/.exec(v);
  if (m) return Date.now() - Number(m[1]) * (m[2] === 'd' ? 86400e3 : 3600e3);
  const t = Date.parse(v);
  if (Number.isNaN(t)) fail(`--since takes 7d, 12h, all, or a date (got "${v}")`);
  return t;
}

function parseArgs(argv) {
  const o = { last: 20, since: '7d', top: 25, by: null, list: false, prompts: false, session: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) fail(`${a} needs a value`); return argv[++i]; };
    if (a === '--last') o.last = Number(val());
    else if (a === '--all') o.last = Infinity;
    else if (a === '--list') o.list = true;
    else if (a === '--prompts') o.prompts = true;
    else if (a === '--since') o.since = val();
    else if (a === '--top') o.top = Number(val());
    else if (a === '--by') o.by = val();
    else if (a === '--prompt') o.prompt = Number(val());
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('--')) fail(`unknown argument ${a}`);
    else o.session = a;
  }
  if (!(o.last > 0) || !(o.top > 0)) fail('--last and --top need a positive number');
  if (o.by && !['project', 'day', 'model', 'session'].includes(o.by)) fail('--by is one of: project, day, model, session');
  return o;
}

const USAGE = 'usage: claude-cost.js [session-id-prefix] [--last N|--all] [--prompt N] | --list | --prompts [--since 7d|30d|all|DATE] [--by project|day|model|session] [--top N]';

/** Prompt rows of the sessions active since sinceMs, for the epic report. Rates are learned from every session. */
async function epicRows(sinceMs) {
  const list = sessions();
  const { learned, results } = await learnRates(list);
  const mtime = new Map(list.map((s) => [s.id, s.mtime]));
  const prompts = results.filter((r) => mtime.get(r.session.id) >= sinceMs).flatMap((r) => rows(r, learned));
  return { prompts };
}

async function run(argv) {
  // The epic view is --epics, or any option only it has (--stories, --key, ...), so those work alone.
  if (argv.some((a) => ['--epics', '--stories', '--tickets', '--key', '--unattributed', '--projects'].includes(a))) {
    if (!sessions().length) fail(`no Claude Code transcripts under ${ROOT}`);
    const epics = require('./epic-usage');
    try {
      return await epics.run(argv.filter((a) => a !== '--epics'), { collect: epicRows, unit: epics.DOLLARS, name: 'Claude Code' });
    } catch (err) {
      if (err.constructor && err.constructor.name === 'UsageError' && !(err instanceof UsageError)) throw new UsageError(err.message);
      throw err;
    }
  }
  const o = parseArgs(argv);
  if (o.help) return USAGE;
  const list = sessions();
  if (!list.length) fail(`no Claude Code transcripts under ${ROOT}`);
  const { learned, results } = await learnRates(list);
  const byId = new Map(results.map((r) => [r.session.id, r]));

  if (o.list) {
    const out = ['| Session | Last active (UTC) | Project | Title / first prompt | Prompts | Cost |', '|---|---|---|---|---:|---:|'];
    for (const s of list.slice(0, 15)) {
      const r = byId.get(s.id);
      const rs = rows(r, learned);
      const cost = r.costState ? `$${r.costState.totalCostUSD.toFixed(2)}` : `~$${rs.reduce((a, x) => a + (x.usd || 0), 0).toFixed(2)}`;
      out.push(`| ${s.id.slice(0, 8)} | ${new Date(s.mtime).toISOString().slice(0, 16).replace('T', ' ')} | ${cell(r.cwd ? path.basename(r.cwd) : s.project, 24)} | `
        + `${cell(r.title || (r.prompts[0] && r.prompts[0].prompt) || '', 44)} | ${rs.length} | ${cost} |`);
    }
    return out.join('\n');
  }

  if (o.prompts) {
    const sinceMs = parseSince(o.since);
    const all = results.flatMap((r) => rows(r, learned)).filter((r) => Date.parse(r.ts) >= sinceMs);
    if (!all.length) return 'No prompts match.';
    const total = all.reduce((a, r) => a + (r.usd || 0), 0);
    const from = sinceMs ? new Date(sinceMs).toISOString().slice(0, 10) : 'the first session';
    const out = [`# Claude Code prompts — since ${from}`, '',
      `${all.length} prompts in ${new Set(all.map((r) => r.session)).size} sessions: **$${total.toFixed(2)}** estimated, `
        + `${k(all.reduce((a, r) => a + r.tokensIn, 0))} tokens in / ${k(all.reduce((a, r) => a + r.tokensOut, 0))} out.`];
    const b = breakLine(all);
    if (b) out.push(b);
    out.push('');
    if (o.by) {
      const key = { project: projectName, day: (r) => r.ts.slice(0, 10), model: (r) => r.models[0] || '—', session: (r) => r.session.slice(0, 8) }[o.by];
      const g = new Map();
      for (const r of all) { const x = key(r); const v = g.get(x) || { n: 0, usd: 0, tin: 0, s: 0 }; v.n++; v.usd += r.usd || 0; v.tin += r.tokensIn; v.s += r.seconds || 0; g.set(x, v); }
      const sorted = [...g].sort(o.by === 'day' ? (a, b2) => b2[0].localeCompare(a[0]) : (a, b2) => b2[1].usd - a[1].usd);
      out.push(`| ${o.by[0].toUpperCase() + o.by.slice(1)} | Prompts | Cost | Share | Avg cost | Tokens in | Time |`, '|---|---:|---:|---:|---:|---:|---:|');
      for (const [x, v] of sorted.slice(0, o.top)) {
        out.push(`| ${cell(x, 36)} | ${v.n} | $${v.usd.toFixed(2)} | ${Math.round((v.usd / (total || 1)) * 100)}% | $${(v.usd / v.n).toFixed(2)} | ${k(v.tin)} | ${dur(v.s)} |`);
      }
    } else {
      out.push(`Top ${Math.min(o.top, all.length)} by cost:`, '',
        '| When (UTC) | Session | Project | Prompt | Cost | Tokens in / out | Cache hit | Model | Took |', '|---|---|---|---|---:|---:|---:|---|---:|');
      for (const r of [...all].sort((a, b2) => (b2.usd || 0) - (a.usd || 0)).slice(0, o.top)) {
        out.push(`| ${r.ts.slice(5, 16).replace('T', ' ')} | ${r.session.slice(0, 8)} | ${cell(projectName(r), 20)} | ${cell(r.prompt, 44)} | ${usd(r)}${mark(r)} | `
          + `${k(r.tokensIn)} / ${k(r.tokensOut)} | ${pct(r.cacheHit)} | ${cell(r.models.join(', ') || '—', 16)} | ${dur(r.seconds)} |`);
      }
    }
    out.push('', ...NOTES);
    return out.join('\n');
  }

  let target = list[0];
  if (o.session) {
    const hits = list.filter((s) => s.id.startsWith(o.session));
    if (hits.length !== 1) fail(hits.length ? `"${o.session}" matches ${hits.length} sessions` : `no session matches "${o.session}"`);
    target = hits[0];
  }
  const r = byId.get(target.id);
  if (o.prompt != null) return promptReport(r, rows(r, learned), o.prompt);
  return sessionReport(r, rows(r, learned), o.last);
}

/** Display options of the command line, taken out of argv: --md (raw markdown) and --width N. */
function displayOptions(argv) {
  const rest = [];
  const d = { pretty: true, width: Number(process.stdout.columns) || Number(process.env.COLUMNS) || 140 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--md') d.pretty = false;
    else if (argv[i] === '--width') { d.width = Number(argv[++i]); if (!(d.width >= 40)) fail('--width needs a number of at least 40'); }
    else rest.push(argv[i]);
  }
  return { rest, ...d };
}

/** The command line: prints the report (as box tables unless --md) and exits non-zero on bad input. */
function main(argv) {
  let cli;
  try { cli = displayOptions(argv); } catch (err) { console.error(`claude-cost: ${err.message}`); process.exit(1); }
  return run(cli.rest).then((text) => console.log(cli.pretty ? require('./pretty').prettyMarkdown(text, { width: cli.width }) : text), (err) => {
    console.error(`claude-cost: ${err instanceof UsageError ? err.message : err.stack}`);
    process.exit(1);
  });
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { run, main, analyse, rows, weight, isUserPrompt, commandPrompt, detectBreaks, sessions, learnRates, epicRows };
