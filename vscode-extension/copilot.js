'use strict';
// Copilot CLI and VS Code Copilot Chat sessions, in the same session -> prompt -> call shape as model.js.
// The rows come from lib/prompt-usage.js (event logs, VS Code chat storage, plus the token logger's per-call records).
// Cost is Copilot's AI credits at USD_PER_CREDIT; a call's cost is its tokens at GitHub's list prices.

const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { libDir, split, mergeSplit, modelsOf, clip } = require('./model');
const lib = (f) => require(path.join(libDir, f));
const pu = lib('prompt-usage.js');
const sc = lib('session-cost.js');

const PRICES = (() => { try { return JSON.parse(fs.readFileSync(path.join(libDir, 'copilot-prices.json'), 'utf8')); } catch { return {}; } })();
const USD_PER_CREDIT = PRICES.usdPerCredit || 0.01;

const NO_TOKENS = 'No token data for this prompt: the /cost extension logger was not running, so Copilot CLI recorded only credits.';
const NO_CALLS = 'VS Code stores one total per chat request, so there is no per-call breakdown.';

const callId = (r) => `${r.ts}|${r.model}|${r.input}`;

function callRow(r, i) {
  const cacheRead = r.cacheRead || 0; const cacheWrite = r.cacheWrite || 0;
  return {
    kind: 'call', id: callId(r), n: i + 1, ts: r.ts, who: r.sub ? `subagent ${String(r.agent || '').slice(0, 8)}`.trim() : 'main', model: r.model,
    usd: sc.callUsd(r), tokensIn: r.input || 0, tokensOut: r.output || 0,
    fresh: Math.max(0, (r.input || 0) - cacheRead - cacheWrite), cacheRead, cacheWrite, tools: 0,
  };
}

function promptRow(row, i) {
  const calls = (row.liveCalls || []).map(callRow);
  let sp; let note = null;
  if (calls.length) sp = split(calls);
  else if (row.tokensLive && row.tokensLive.calls) {
    const t = row.tokensLive;
    sp = mergeSplit([{ fresh: Math.max(0, t.input - t.cacheRead - t.cacheWrite), cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, out: t.output, calls: t.calls, known: true }]);
    if (row.source === 'vscode') note = NO_CALLS;
  } else { sp = mergeSplit([]); note = NO_TOKENS; }
  const cb = row.cacheBreak;
  return {
    kind: 'prompt', n: i + 1, ts: row.ts, text: row.prompt || '(no text)', usd: row.credits == null ? null : row.credits * USD_PER_CREDIT, usdEstimated: false,
    tokensIn: sp.in, tokensOut: sp.out, cacheHit: sp.cacheHit, models: row.models || [], seconds: row.seconds || 0,
    cacheBreak: cb ? { ...cb, to: cb.to || row.firstModel, uncached: (row.tokensLive && row.tokensLive.firstMainUncached) || 0 } : null,
    toolCalls: [], toolCount: row.toolCalls || 0, compactions: row.compactions || 0, calls, split: sp, note, credits: row.credits, premium: row.premium == null ? null : row.premium,
  };
}

const tail = (s, n) => (s.length > n ? s.slice(-n) : s);
const label = (row) => path.basename(row.cwd || row.repository || '') || String(row.session).slice(0, 8);

/** Copilot sessions from the last `days` days, newest first. */
async function load({ days = 30 } = {}) {
  const since = Date.now() - days * 86400000;
  const { prompts } = await pu.collect(since, { source: 'all' });
  const by = new Map();
  // collect() keeps whole sessions touched since then, so drop the older prompts inside them.
  for (const r of prompts) { if (Date.parse(r.ts) < since) continue; if (!by.has(r.session)) by.set(r.session, []); by.get(r.session).push(r); }
  const out = [];
  for (const [id, rows] of by) {
    rows.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const ps = rows.map(promptRow);
    const first = rows[0];
    const usd = ps.reduce((a, p) => a + (p.usd || 0), 0);
    out.push({
      kind: 'session', id, source: first.source === 'vscode' ? 'vscode' : 'copilot', title: label(first), cwd: first.cwd, branch: first.branch,
      ts: ps[ps.length - 1].ts, usd, tokensIn: ps.reduce((a, p) => a + p.tokensIn, 0), tokensOut: ps.reduce((a, p) => a + p.tokensOut, 0),
      prompts: ps, split: mergeSplit(ps.map((p) => p.split)), models: modelsOf(ps),
    });
  }
  return out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

// analyse() reads a whole event log (one is over 100 MB), so keep the latest few.
const analysed = new Map();
async function analyseCached(file) {
  const key = `${file}|${fs.statSync(file).mtimeMs}`;
  if (!analysed.has(key)) {
    const result = await sc.analyse(file);
    for (const k of analysed.keys()) if (k.startsWith(`${file}|`)) analysed.delete(k);
    analysed.set(key, result);
    while (analysed.size > 3) analysed.delete(analysed.keys().next().value);
  }
  return analysed.get(key);
}
const fileOf = (session) => { const s = sc.sessions().find((x) => x.id === session.id); return s && s.file; };

const toolRow = (t) => ({
  id: t.id, name: t.name, detail: t.detail, where: t.where, error: Boolean(t.error), tokens: t.resultChars == null ? null : Math.round(t.resultChars / 4),
  seconds: t.resultTs && t.ts ? Math.max(0, Math.round((Date.parse(t.resultTs) - Date.parse(t.ts)) / 1000)) : null,
});

/** Every tool call of a prompt, in order. Read on demand: the prompt rows only carry a count, and many prompts have no token data. */
async function promptTools(session, prompt) {
  const file = fileOf(session);
  if (!file) return [];
  const result = await analyseCached(file);
  const p = result.prompts.find((x) => x.ts === prompt.ts);
  return p ? (p.toolLog || []).map(toolRow) : [];
}

/** A tool call's full arguments and result, streamed from the event log. */
async function toolContent(session, tool) {
  const file = fileOf(session);
  if (!file) return null;
  let input = null; let result = null; let error = false;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes(tool.id)) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const d = e.data || {};
    if (d.toolCallId !== tool.id) continue;
    if (e.type === 'tool.execution_start') input = clip(JSON.stringify(d.arguments, null, 2));
    else if (e.type === 'tool.execution_complete') {
      const c = d.result && d.result.content;
      result = clip(typeof c === 'string' ? c : JSON.stringify(c ?? '', null, 2));
      error = d.success === false;
      if (error && d.error) result = clip(`${typeof d.error === 'string' ? d.error : JSON.stringify(d.error)}\n\n${result}`);
    }
    if (input != null && result != null) break;
  }
  rl.close();
  return input != null || result != null ? { input, result, error } : null;
}

/** What a Copilot CLI call went in and came out, from the event log: the tool requests, the reply, and what grew its input. */
async function callContent(session, prompt, call) {
  const file = fileOf(session);
  if (!file) return null;
  const result = await analyseCached(file);
  sc.attachLiveTokens(result.prompts, sc.readTokenLog().get(session.id));
  const p = result.prompts.find((x) => x.ts === prompt.ts);
  if (!p) return null;
  const c = sc.joinCalls(p, result.agentNames || new Map()).find((x) => callId(x.r) === call.id);
  if (!c) return null;
  const input = [];
  if (!c.prev) input.push({ type: 'text', text: c.r.sub ? 'First call of a subagent: its instructions and task.' : 'First call of the prompt: the conversation so far, and your prompt.' });
  else if (c.compacted) input.push({ type: 'text', text: 'The context was compacted since the previous call.' });
  else {
    input.push({ type: 'text', text: `Previous output: ${(c.prev.r.output || 0).toLocaleString()} tokens.${c.cacheMiss ? ` Cache missed${c.idle ? ` (idle ${c.idle}s)` : ''}: the whole context was re-sent uncached.` : ''}` });
    for (const f of c.fed) input.push({ type: 'result', text: `${f.name}${f.detail ? `: ${f.detail}` : ''}${f.tokens != null ? ` (about ${f.tokens.toLocaleString()} tokens)` : ''}`, error: f.error });
  }
  const output = [];
  if (c.msg) {
    if (c.msg.reasoning) output.push({ type: 'thinking', text: c.msg.reasoning });
    if (c.msg.reply) output.push({ type: 'text', text: tail(c.msg.reply, 600) + (c.msg.replyChars > 600 ? `\n… (${c.msg.replyChars - 600} more characters)` : '') });
    for (const q of c.msg.requests) output.push({ type: 'tool', name: q.name, text: q.detail || '' });
  }
  const results = new Map((p.toolLog || []).filter((t) => t.id).map((t) => [t.id, t]));
  const tools = c.msg ? c.msg.requests.map((q) => {
    const t = results.get(q.id) || {};
    return { id: q.id, name: q.name, detail: q.detail, error: Boolean(t.error), tokens: t.resultChars == null ? null : Math.round(t.resultChars / 4),
      seconds: t.resultTs && t.ts ? Math.max(0, Math.round((Date.parse(t.resultTs) - Date.parse(t.ts)) / 1000)) : null };
  }) : [];
  return { input, output, tools, partial: true };
}

module.exports = { load, callContent, promptTools, toolContent, USD_PER_CREDIT };

if (require.main === module) {
  load({ days: Number(process.argv[2]) || 7 }).then((ss) => {
    for (const s of ss.slice(0, 8)) console.log(`${s.source.padEnd(8)} $${s.usd.toFixed(2).padStart(7)} ${s.title} (${s.prompts.length} prompts, ${s.split.known ? s.split.in + ' in' : 'no tokens'}, ${s.split.calls} calls)`);
    console.log(ss.length, 'sessions');
  });
}
