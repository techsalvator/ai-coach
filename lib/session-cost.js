#!/usr/bin/env node
/**
 * session-cost — per-prompt cost of a Copilot CLI session, from its event log.
 *
 * Copilot CLI shows session totals (/usage) but nothing per prompt. Its event log
 * (~/.copilot/session-state/<id>/events.jsonl) does record, after every prompt, a
 * `session.usage_checkpoint` with running totals of AI credits (totalNanoAiu; 1e9 =
 * one credit, as `copilot -p` prints it) and premium requests. The difference between
 * consecutive checkpoints is one prompt's cost. The log has no per-prompt tokens, so they
 * come from two places: live, from the token log (lib/paths.js), which the optional
 * token-logger extension writes from Copilot's `assistant.usage` event on every model call; else
 * estimated, splitting each run's token totals (per model, at `session.shutdown`) across
 * its prompts by credits.
 *
 *   node lib/session-cost.js                 # most recently active session
 *   node lib/session-cost.js a05dcb09        # session id or prefix
 *   node lib/session-cost.js --last 10       # last 10 prompts (default 20)
 *   node lib/session-cost.js --all           # every prompt
 *   node lib/session-cost.js --list          # recent sessions
 *   node lib/session-cost.js --json          # machine-readable
 *
 * Copilot CLI only; the log format is undocumented, so fields this relies on are
 * read defensively and a missing one shows as "?".
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const HOME = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
const STATE = path.join(HOME, 'session-state');
const NANO_PER_CREDIT = 1e9;

function parseArgs(argv) {
  const opts = { last: 20, json: false, list: false, session: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--all') opts.last = Infinity;
    else if (a === '--last') opts.last = Number(argv[++i]);
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--prompt') opts.prompt = Number(argv[++i]);
    else if (a === '--calls') opts.calls = true;
    else if (a === '--call') opts.call = Number(argv[++i]);
    else opts.session = a;
  }
  if (!(opts.last > 0)) fail('--last needs a positive number');
  return opts;
}

/** Bad input: the CLI prints it and exits 1; the /cost command shows it and carries on. */
class UsageError extends Error {}
function fail(msg) {
  throw new UsageError(msg);
}

/** Session directories with an event log, most recently written first. */
function sessions() {
  if (!fs.existsSync(STATE)) return [];
  return fs.readdirSync(STATE)
    .map((id) => ({ id, file: path.join(STATE, id, 'events.jsonl') }))
    .filter((s) => fs.existsSync(s.file))
    .map((s) => ({ ...s, mtime: fs.statSync(s.file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

function resolveSession(arg) {
  const all = sessions();
  if (!all.length) fail(`no Copilot sessions under ${STATE}`);
  if (!arg) return all[0];
  if (fs.existsSync(arg) && arg.endsWith('.jsonl')) return { id: path.basename(path.dirname(arg)), file: arg };
  const hits = all.filter((s) => s.id.startsWith(arg));
  if (hits.length !== 1) fail(hits.length ? `"${arg}" matches ${hits.length} sessions` : `no session matches "${arg}"`);
  return hits[0];
}

// ------------------------------------------------------------------ live tokens

const { TOKEN_LOGS } = require('./paths');
const { PromptJira } = require('./jira-signals');

/** Per-call token records the token logger captures live, grouped by session. Takes one
 *  file or several; a record present in two logs counts once. */
function readTokenLog(files = TOKEN_LOGS) {
  const bySession = new Map();
  const seen = new Set();
  for (const file of [].concat(files)) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r || !r.session || !r.ts) continue;
      const key = `${r.session}|${r.ts}|${r.model}|${r.input}|${r.output}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!bySession.has(r.session)) bySession.set(r.session, []);
      bySession.get(r.session).push(r);
    }
  }
  for (const list of bySession.values()) list.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  return bySession;
}

/** Add each live record to the prompt it belongs to: the latest one that started before it. */
function attachLiveTokens(prompts, records) {
  if (!records || !records.length) return;
  const sorted = prompts.filter((p) => p.ts).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  let i = -1;
  for (const r of records) {
    while (i + 1 < sorted.length && sorted[i + 1].ts <= r.ts) i++;
    if (i < 0) continue;
    const p = sorted[i];
    const t = p.tokensLive || (p.tokensLive = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0,
      mainInput: 0, mainOutput: 0 });
    if (!r.sub && t.firstMainUncached == null) t.firstMainUncached = Math.max(0, (r.input || 0) - (r.cacheRead || 0));
    t.input += r.input || 0; t.output += r.output || 0;
    t.cacheRead += r.cacheRead || 0; t.cacheWrite += r.cacheWrite || 0; t.calls++;
    if (!r.sub) { t.mainInput += r.input || 0; t.mainOutput += r.output || 0; }
    (p.liveCalls || (p.liveCalls = [])).push(r);
  }
}

/** The latest premium-quota reading in the live log, if any. */
function latestQuota(bySession) {
  let best = null;
  for (const list of bySession.values()) {
    for (const r of list) if (r.premiumLeftPct != null && (!best || r.ts > best.ts)) best = r;
  }
  return best && { leftPct: best.premiumLeftPct, resets: best.premiumResets, ts: best.ts };
}

/** Cache breaks over a set of prompts: counts, and median credits with vs without one. */
function cacheBreakStats(prompts) {
  const done = prompts.filter((p) => p.credits != null && p.firstModel);
  const med = (a) => { const v = a.map((p) => p.credits).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const sw = done.filter((p) => p.cacheBreak && p.cacheBreak.kind === 'switch');
  const idle = done.filter((p) => p.cacheBreak && p.cacheBreak.kind === 'idle');
  const clean = done.filter((p) => !p.cacheBreak);
  return { switches: sw.length, idle: idle.length, medSwitch: med(sw), medIdle: med(idle), medClean: med(clean), n: done.length };
}

/** One summary sentence, or null when there is nothing to compare. */
function cacheBreakLine(prompts) {
  const s = cacheBreakStats(prompts);
  if (!s.n || (!s.switches && !s.idle)) return null;
  const f = (x) => (x == null ? '?' : x.toFixed(2));
  return `Cache breaks: ${s.switches} model switch${s.switches === 1 ? '' : 'es'} (⇄) and ${s.idle} idle expir${s.idle === 1 ? 'y' : 'ies'} (⏲) `
    + `in ${s.n} prompts. Median credits: ${f(s.medClean)} with the cache warm, ${f(s.medSwitch)} after a switch, `
    + `${f(s.medIdle)} after an idle gap.`;
}

/** "⇄" / "⏲" plus, when captured live, the uncached tokens the rebuild re-read. */
function breakMark(p) {
  if (!p.cacheBreak) return '';
  const k = (n) => (n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const rebuilt = p.tokensLive && p.tokensLive.firstMainUncached != null ? ` ${k(p.tokensLive.firstMainUncached)}` : '';
  return (p.cacheBreak.kind === 'switch' ? ' ⇄' : ' ⏲') + rebuilt;
}

const BREAK_NOTE = '⇄ = started on a different model than the last prompt ended on; ⏲ = started after the model\'s '
  + 'cache lifetime had passed (5 min Claude, 30 min GPT). Either way the whole conversation was re-read at full '
  + 'price; the number after the mark is those uncached tokens, where captured live.';

/** A prompt's tokens: live when captured, else the estimate, else null. */
function tokensOf(p) {
  if (p.tokensLive) return { ...p.tokensLive, source: 'live' };
  if (p.tokensEst) return { ...p.tokensEst, source: 'estimate' };
  return null;
}

const TOKENS_NOTE = 'Credits per prompt come from Copilot\'s usage checkpoints. Tokens (all model calls, subagents '
  + 'included; input counts cache reads) are live where the token logger captured them, and ~estimated '
  + 'otherwise: each run\'s token total split across its prompts by credits.';

/** "120k / 3.4k", with ~ on estimates. */
function fmtTokens(t) {
  if (!t) return '—';
  const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));
  const mark = t.source === 'estimate' ? '~' : '';
  return `${mark}${k(t.input)} / ${mark}${k(t.output)}`;
}

/** What a tool call did, in a few words: the command (without a leading cd), file, pattern or target. */
function toolDetail(args) {
  const a = args || {};
  const strip = (c) => String(c).replace(/^(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;|\n)\s*)+/, '');
  const v = (a.command && strip(a.command)) || a.path || a.pattern || a.query || a.url || a.issueIdOrKey
    || (a.agent_type && `${a.agent_type}: ${a.description || ''}`) || a.prompt
    || Object.values(a).find((x) => typeof x === 'string') || JSON.stringify(a);
  return String(v).replace(/\s+/g, ' ').trim();
}

// ------------------------------------------------------------------ prices

/** GitHub's published per-model token prices (copilot-prices.json, with its source and date). */
let PRICES = null;
try { PRICES = require('./copilot-prices.json'); } catch { PRICES = null; }
const USD_PER_CREDIT = (PRICES && PRICES.usdPerCredit) || 0.01;

/** Dollars for one live model call at list price, or null for a model without a price. */
function callUsd(r) {
  const pr = PRICES && PRICES.models[r.model];
  if (!pr) return null;
  const fresh = Math.max(0, (r.input || 0) - (r.cacheRead || 0) - (r.cacheWrite || 0));
  return (fresh * pr.input + (r.cacheRead || 0) * pr.cachedInput + (r.cacheWrite || 0) * (pr.cacheWrite ?? pr.input)
    + (r.output || 0) * pr.output) / 1e6;
}

/** "$4.28" for a number of credits (1 AI credit = $0.01). */
const creditsUsd = (c) => (c == null ? '?' : `$${(c * USD_PER_CREDIT).toFixed(2)}`);

/** Where one prompt's tokens went: by agent and model, split by token type, plus the largest calls. */
function tokenSplit(p, agentNames) {
  const n = (x) => Math.round(x).toLocaleString('en-US');
  const calls = p.liveCalls || [];
  if (!calls.length) {
    const t = tokensOf(p);
    return ['## Tokens', t ? `Only an estimate is available (${fmtTokens(t)}): this prompt ran before the token logger captured `
      + 'tokens live, so there is no per-call split.' : 'No token data for this prompt.'];
  }
  const who = (r) => (r.sub ? agentNames.get(r.agent) || `subagent ${String(r.agent || '?').slice(0, 8)}` : 'main agent');
  const fresh = (r) => Math.max(0, (r.input || 0) - (r.cacheRead || 0) - (r.cacheWrite || 0));
  const groups = new Map();
  const tot = { calls: 0, fresh: 0, read: 0, write: 0, out: 0, reason: 0, input: 0, usd: 0, unpriced: 0 };
  for (const r of calls) {
    const key = `${who(r)}\u0000${r.model}`;
    const g = groups.get(key) || { who: who(r), model: r.model, calls: 0, fresh: 0, read: 0, write: 0, out: 0, reason: 0, input: 0, usd: 0, unpriced: 0 };
    const usd = callUsd(r);
    for (const t of [g, tot]) {
      t.calls++; t.fresh += fresh(r); t.read += r.cacheRead || 0; t.write += r.cacheWrite || 0;
      t.out += r.output || 0; t.reason += r.reasoning || 0; t.input += r.input || 0;
      if (usd == null) t.unpriced++; else t.usd += usd;
    }
    groups.set(key, g);
  }
  const share = (x) => `${tot.input ? Math.round((x / tot.input) * 100) : 0}%`;
  const out = ['## Tokens', '',
    `${n(tot.calls)} model calls read **${n(tot.input)} input tokens**: ${n(tot.read)} (${share(tot.read)}) re-read from cache, `
      + `${n(tot.write)} (${share(tot.write)}) written to cache, ${n(tot.fresh)} (${share(tot.fresh)}) fresh. `
      + `Output ${n(tot.out)} tokens, of which ${n(tot.reason)} reasoning.`];
  if (PRICES) {
    out.push(`Cost: **${fmtCredits(p.credits)} credits = ${creditsUsd(p.credits)}** charged (1 AI credit = $${USD_PER_CREDIT}). `
      + `At GitHub's published token prices these calls come to **$${tot.usd.toFixed(2)}**`
      + `${tot.unpriced ? ` plus ${tot.unpriced} call${tot.unpriced === 1 ? '' : 's'} on unpriced models` : ''} `
      + `([price list](${PRICES.source}), ${PRICES.fetched}).`);
  }
  const usdCell = (g) => (PRICES ? ` $${g.usd.toFixed(2)}${g.unpriced ? '+' : ''} | ${tot.usd ? Math.round((g.usd / tot.usd) * 100) : 0}% |` : '');
  out.push('', `| Who | Model | Calls | Input | Cache read | Cache write | Fresh | Output | Reasoning | Share of input |${PRICES ? ' List price | Share of cost |' : ''}`,
    `|---|---|---:|---:|---:|---:|---:|---:|---:|---:|${PRICES ? '---:|---:|' : ''}`);
  for (const g of [...groups.values()].sort((a, b) => b.usd - a.usd || b.input - a.input)) {
    out.push(`| ${cell(g.who, 26)} | ${g.model} | ${g.calls} | ${n(g.input)} | ${n(g.read)} | ${n(g.write)} | ${n(g.fresh)} | ${n(g.out)} | ${n(g.reason)} | ${share(g.input)} |${usdCell(g)}`);
  }
  out.push(`| **Total** | | **${tot.calls}** | **${n(tot.input)}** | **${n(tot.read)}** | **${n(tot.write)}** | **${n(tot.fresh)}** | **${n(tot.out)}** | **${n(tot.reason)}** | 100% |`
    + `${PRICES ? ` **$${tot.usd.toFixed(2)}** | 100% |` : ''}`);
  if (PRICES && tot.usd) {
    let wRead = 0; let wWrite = 0; let wOut = 0; let wFresh = 0;
    for (const r of calls) {
      const pr = PRICES.models[r.model];
      if (!pr) continue;
      wRead += (r.cacheRead || 0) * pr.cachedInput; wWrite += (r.cacheWrite || 0) * (pr.cacheWrite ?? pr.input);
      wOut += (r.output || 0) * pr.output; wFresh += fresh(r) * pr.input;
    }
    const t = wRead + wWrite + wOut + wFresh || 1;
    const sh = (x) => `${Math.round((x / t) * 100)}%`;
    out.push('', `Cost drivers at list price: cache reads ${sh(wRead)}, cache writes ${sh(wWrite)}, output ${sh(wOut)}, fresh input ${sh(wFresh)}.`);
  }
  const main = calls.filter((r) => !r.sub);
  if (main.length > 1) {
    const avg = main.reduce((a, r) => a + (r.input || 0), 0) / main.length;
    out.push('', `The main agent made ${main.length} calls averaging ${n(avg)} input tokens: each call re-sends the whole conversation, `
      + 'so input grows with calls × context size, and cache reads are most of it.');
  }
  const t0 = Date.parse(p.ts);
  out.push('', 'Largest model calls (# = order in the prompt; `--call #` explains one, `--calls` lists all):', '',
    '| # | At | Who | Model | Input | Cache read | Output |', '|---:|---:|---|---|---:|---:|---:|');
  const order = new Map(calls.map((r, i) => [r, i + 1]));
  for (const r of [...calls].sort((a, b) => (b.input || 0) - (a.input || 0)).slice(0, 5)) {
    out.push(`| ${order.get(r)} | +${fmtSeconds((Date.parse(r.ts) - t0) / 1000)} | ${cell(who(r), 26)} | ${r.model} | ${n(r.input || 0)} | ${n(r.cacheRead || 0)} | ${n(r.output || 0)} |`);
  }
  return out;
}

// ------------------------------------------------------------------ model calls

/** Each live model call of a prompt, joined to its assistant.message (what it asked for) and to
 *  what grew its input since the same agent's previous call (that call's output and tool results). */
function joinCalls(p, agentNames) {
  const calls = p.liveCalls || [];
  const msgs = (p.msgLog || []).map((m) => ({ ...m, used: false }));
  const results = new Map((p.toolLog || []).filter((t) => t.id).map((t) => [t.id, t]));
  const last = new Map(); // agent -> previous joined call
  return calls.map((r, i) => {
    const agent = r.sub ? r.agent : null;
    const at = Date.parse(r.ts);
    const m = msgs.find((x) => !x.used && x.agent === agent && Date.parse(x.ts) >= at - 2000 && Date.parse(x.ts) <= at + 30000);
    if (m) m.used = true;
    const prev = last.get(agent) || null;
    const fed = prev && prev.msg ? prev.msg.requests.map((q) => {
      const t = results.get(q.id);
      return { name: q.name, detail: q.detail, tokens: t && t.resultChars != null ? Math.round(t.resultChars / 4) : null, error: t && t.error };
    }) : [];
    const compacted = prev && (p.compactAt || []).some((c) => c > prev.r.ts && c <= r.ts);
    const c = { n: i + 1, r, agent, msg: m || null, prev, fed, compacted,
      who: r.sub ? (agentNames.get(r.agent) || `subagent ${String(r.agent || '?').slice(0, 8)}`) : 'main agent',
      added: prev ? (r.input || 0) - (prev.r.input || 0) : null, usd: callUsd(r) };
    // The agent's context was cached by its previous call, yet this call read (almost) none of it:
    // the cache expired while the agent waited (Claude in Copilot keeps it ~5 minutes).
    if (prev && !compacted && (r.cacheRead || 0) < 0.5 * (prev.r.input || 0) && (prev.r.input || 0) > 5000) {
      c.cacheMiss = true;
      // Records are stamped when a call ends; the cache clock runs from when the previous
      // request was sent to when this one was.
      c.idle = Math.round(((at - (r.ms || 0)) - (Date.parse(prev.r.ts) - (prev.r.ms || 0))) / 1000);
    }
    last.set(agent, c);
    return c;
  });
}

// Shortest prompt-cache lifetime Copilot uses (Claude: 300s; GPT: 1800s). A miss sooner than
// this is not an expiry.
const MIN_CACHE_TTL = 300;

const kTok = (x) => (x == null ? '?' : x >= 1e3 ? `${(x / 1e3).toFixed(x >= 1e4 ? 0 : 1)}k` : String(x));

/** What a call did next, in a few words: the tools it asked for, or its reply. */
function didText(c) {
  if (!c.msg) return '—';
  const reqs = c.msg.requests;
  if (reqs.length) {
    const by = new Map();
    for (const q of reqs) by.set(q.name, (by.get(q.name) || 0) + 1);
    const first = reqs[0].detail ? `: ${reqs[0].detail}` : '';
    return `→ ${[...by].map(([k, v]) => (v > 1 ? `${k} ×${v}` : k)).join(', ')}${first}`;
  }
  return `reply (${kTok(Math.round(c.msg.replyChars / 4))} tok)`;
}

/** Why the input grew since the agent's previous call. */
function addedText(c) {
  if (!c.prev) return c.r.sub ? 'first call: agent instructions + task' : 'first call of the prompt: conversation so far + your prompt';
  if (c.compacted) return 'context compacted since the previous call';
  const parts = [`prev output ${kTok(c.prev.r.output || 0)}`];
  if (c.cacheMiss) {
    parts.unshift(c.idle >= MIN_CACHE_TTL
      ? `⏲ cache expired (idle ${fmtSeconds(c.idle)}): whole context re-sent uncached`
      : `✕ cache miss (only ${fmtSeconds(c.idle)} idle): whole context re-sent uncached`);
  }
  const by = new Map();
  for (const f of c.fed) {
    const g = by.get(f.name) || { n: 0, tok: 0, err: 0 };
    g.n++; g.tok += f.tokens || 0; g.err += f.error ? 1 : 0; by.set(f.name, g);
  }
  for (const [name, g] of by) parts.push(`${name}${g.n > 1 ? ` ×${g.n}` : ''} ${kTok(g.tok)}${g.err ? ' ✗' : ''}`);
  return parts.join(', ');
}

/** Every model call of a prompt, in order. */
function callsReport(p, agentNames) {
  const cs = joinCalls(p, agentNames);
  if (!cs.length) return ['No live token records for this prompt (they start once the token-logger extension is installed).'];
  const n = (x) => Number(x || 0).toLocaleString('en-US');
  const t0 = Date.parse(p.ts);
  const out = ['## Model calls', '',
    'Each call re-sends its agent\'s whole context. **Added** = input minus the same agent\'s previous call: '
      + 'what grew the context (the previous call\'s output plus the tool results it asked for). '
      + '**Then** = what this call asked for next. ✗ = a tool call that failed.', '',
    '| # | At | Who | Model | Input | Added | Cache read | Cache write | Output | Took | List price | Added by | Then |',
    '|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|'];
  for (const c of cs) {
    const r = c.r;
    out.push(`| ${c.n} | +${fmtSeconds((Date.parse(r.ts) - t0) / 1000)} | ${cell(c.who, 22)} | ${r.model} | ${n(r.input)} | `
      + `${c.added == null ? '—' : (c.added >= 0 ? '+' : '') + n(c.added)} | ${n(r.cacheRead)} | ${n(r.cacheWrite)} | ${n(r.output)} | `
      + `${r.ms ? fmtSeconds(r.ms / 1000) : '—'} | ${c.usd == null ? '?' : `$${c.usd.toFixed(3)}`} | ${cell(addedText(c), 48)} | ${cell(didText(c), 60)} |`);
  }
  const main = cs.filter((c) => !c.r.sub);
  const misses = cs.filter((c) => c.cacheMiss);
  if (misses.length) {
    const list = (cs2) => `${cs2.length} call${cs2.length === 1 ? '' : 's'} (${cs2.map((c) => `#${c.n}`).join(', ')})`;
    const expired = misses.filter((c) => c.idle >= MIN_CACHE_TTL);
    const missed = misses.filter((c) => c.idle < MIN_CACHE_TTL);
    if (expired.length) {
      out.push('', `⏲ ${list(expired)} found the agent's cache expired — typically the main agent waiting on a long subagent `
        + '— and paid for its whole context uncached again.');
    }
    if (missed.length) {
      out.push('', `✕ ${list(missed)} got no cache hit although the previous call was moments earlier: the provider did not `
        + 'serve its cache (seen with models whose caching is best-effort), so the whole context was billed uncached.');
    }
  }
  if (main.length) {
    const base = main[0].r.input || 0;
    const readUsd = main.reduce((a, c) => { const pr = PRICES && PRICES.models[c.r.model]; return a + (pr ? (c.r.cacheRead || 0) * pr.cachedInput / 1e6 : 0); }, 0);
    out.push('', `The main agent started this prompt with ${n(base)} tokens of context (the conversation so far) and made ${main.length} calls; `
      + `re-reading that context from cache cost $${readUsd.toFixed(2)} of this prompt. A shorter session (or /compact, or a new session per task) shrinks every one of those calls.`);
  }
  return out;
}

/** One model call in full: token split with prices, what fed it, its reasoning, what it asked for. */
function callReport(p, agentNames, k) {
  const cs = joinCalls(p, agentNames);
  if (!(k >= 1 && k <= cs.length)) fail(`--call takes 1..${cs.length} (the # column of --calls)`);
  const c = cs[k - 1];
  const r = c.r;
  const n = (x) => Number(x || 0).toLocaleString('en-US');
  const pr = PRICES && PRICES.models[r.model];
  const fresh = Math.max(0, (r.input || 0) - (r.cacheRead || 0) - (r.cacheWrite || 0));
  const $ = (tok, rate) => (pr ? `$${((tok * rate) / 1e6).toFixed(4)}` : '?');
  const out = [`## Call ${k} of ${cs.length} — ${c.who}, ${r.model}`, '',
    `${(r.ts || '').slice(11, 19)} UTC · took ${r.ms ? fmtSeconds(r.ms / 1000) : '?'} · list price ${c.usd == null ? '?' : `$${c.usd.toFixed(4)}`}`, '',
    '| Tokens | Count | Rate ($/1M) | Cost |', '|---|---:|---:|---:|',
    `| Cache read (context re-sent, already cached) | ${n(r.cacheRead)} | ${pr ? pr.cachedInput : '?'} | ${$(r.cacheRead || 0, pr && pr.cachedInput)} |`,
    `| Cache write (new context, cached for next call) | ${n(r.cacheWrite)} | ${pr ? pr.cacheWrite ?? pr.input : '?'} | ${$(r.cacheWrite || 0, pr && (pr.cacheWrite ?? pr.input))} |`,
    `| Fresh input (not cached) | ${n(fresh)} | ${pr ? pr.input : '?'} | ${$(fresh, pr && pr.input)} |`,
    `| Output (of which ${n(r.reasoning)} reasoning) | ${n(r.output)} | ${pr ? pr.output : '?'} | ${$(r.output || 0, pr && pr.output)} |`,
    `| **Total** | ${n((r.input || 0) + (r.output || 0))} | | **${c.usd == null ? '?' : `$${c.usd.toFixed(4)}`}** |`, ''];
  out.push('### What went in', '');
  if (c.cacheMiss) {
    out.push(c.idle >= MIN_CACHE_TTL
      ? `⏲ The cache from call ${c.prev.n} expired: ${fmtSeconds(c.idle)} passed between the two calls, so the whole context was billed uncached instead of read from the cache.`
      : `✕ Cache miss: call ${c.prev.n} was only ${fmtSeconds(c.idle)} earlier, yet none of its context was read from the cache, so all of it was billed uncached. The cache had not expired; the provider did not serve it.`, '');
  }
  if (!c.prev) out.push(`${addedText(c)}: ${n(r.input)} tokens.`);
  else {
    out.push(c.compacted || c.added < 0
      ? `The context was compacted after call ${c.prev.n}: ${n(c.prev.r.input)} tokens were summarised down to ${n(c.r.input)}, `
        + `so most of this call's input is new to the cache (${n(c.r.cacheWrite)} written). Before the compaction:`
      : `The same context as call ${c.prev.n} (${n(c.prev.r.input)} tokens) plus ${n(c.added)} new tokens:`, '',
      `- call ${c.prev.n}'s output: ${n(c.prev.r.output)} tokens`);
    for (const f of c.fed) out.push(`- ${f.name} result: ~${kTok(f.tokens)} tokens${f.error ? ' ✗ failed' : ''} — ${cell(f.detail, 120)}`);
    out.push('', '_(Tool result tokens ≈ characters / 4.)_');
  }
  out.push('', '### What it did', '');
  if (!c.msg) out.push('No matching assistant message in the session log.');
  else {
    if (c.msg.reasoning) out.push(`Reasoning summary: _${cell(c.msg.reasoning, 600)}_`, '');
    if (c.msg.replyChars) out.push(`Reply (${n(c.msg.replyChars)} chars): ${cell(c.msg.reply, 600)}`, '');
    if (c.msg.requests.length) {
      out.push(`Asked for ${c.msg.requests.length} tool call${c.msg.requests.length === 1 ? '' : 's'} (their results go into the next ${c.who} call):`, '');
      const results = new Map((p.toolLog || []).filter((t) => t.id).map((t) => [t.id, t]));
      for (const q of c.msg.requests) {
        const t = results.get(q.id);
        out.push(`- ${q.name}: ${cell(q.detail, 160)} → ~${kTok(t && t.resultChars != null ? Math.round(t.resultChars / 4) : null)} tokens${t && t.error ? ' ✗' : ''}`);
      }
    }
  }
  const next = cs.find((x) => x.prev === c);
  if (next) out.push('', `Next ${c.who} call: #${next.n}.`);
  return out;
}

/** Every tool call one prompt made, in order: main agent and subagents. */
function promptReport(session, result, n, opts = {}) {
  const ps = result.prompts;
  if (!(n >= 1 && n <= ps.length)) fail(`--prompt takes 1..${ps.length} (the # column of the session report)`);
  const p = ps[n - 1];
  const t0 = Date.parse(p.ts);
  const secs = (a, b) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)) : null);
  const k = (x) => (x >= 1e3 ? `${(x / 1e3).toFixed(x >= 1e4 ? 0 : 1)}k` : String(x));
  const out = [`# Prompt ${n} of session ${session.id.slice(0, 8)}`, '', `> ${cell(p.prompt, 300)}`, '',
    `${(p.ts || '').slice(0, 16).replace('T', ' ')} UTC · ${fmtCredits(p.credits)} credits (${creditsUsd(p.credits)})${breakMark(p)} · tokens ${fmtTokens(tokensOf(p))} · `
      + `${[...p.models].join(', ') || '—'} · active ${fmtSeconds(p.activeMs / 1000)}, wall ${fmtDuration(p.ts, p.end)}`, ''];
  const names = result.agentNames || new Map();
  if (opts.call != null) return [...out, ...callReport(p, names, opts.call)].join('\n');
  if (opts.calls) return [...out, ...callsReport(p, names)].join('\n');
  out.push(...tokenSplit(p, names), '');
  const tc = p.toolLog || [];
  if (!tc.length) { out.push('No tool calls in this prompt.'); return out.join('\n'); }
  out.push(`${tc.length} tool call${tc.length === 1 ? '' : 's'}:`, '', '| # | At | Where | Tool | What | Result | Took |', '|---:|---:|---|---|---|---:|---:|');
  tc.forEach((t, i) => {
    const res = t.resultChars == null ? '—' : `${k(Math.round(t.resultChars / 4))} tok${t.error ? ' ✗' : ''}`;
    const took = secs(t.ts, t.resultTs);
    out.push(`| ${i + 1} | +${fmtSeconds((Date.parse(t.ts) - t0) / 1000)} | ${cell(t.where, 18)} | ${cell(t.name, 28)} | ${cell(t.detail, 70)} | ${res} | ${took == null ? '…' : fmtSeconds(took)} |`);
  });
  const by = new Map();
  for (const t of tc) {
    const g = by.get(t.name) || { n: 0, tok: 0, s: 0, err: 0 };
    g.n++; g.tok += Math.round((t.resultChars || 0) / 4); g.s += secs(t.ts, t.resultTs) || 0; g.err += t.error ? 1 : 0;
    by.set(t.name, g);
  }
  out.push('', '| Tool | Calls | Result tokens | Time | Errors |', '|---|---:|---:|---:|---:|');
  for (const [name, g] of [...by].sort((a, b) => b[1].tok - a[1].tok)) out.push(`| ${cell(name, 36)} | ${g.n} | ${k(g.tok)} | ${fmtSeconds(g.s)} | ${g.err || '—'} |`);
  out.push('', 'Result tokens ≈ characters / 4 (Copilot caps a result near 20k characters); ✗ = the tool reported a failure. '
    + '"Where" is the main agent or the subagent that made the call.');
  return out.join('\n');
}

/** A prompt the user typed: not a subagent's (agentId), and not something Copilot
 *  injected — system notifications (source "system"), skill context ("skill-epic"). */
function isUserPrompt(e) {
  const d = e.data || {};
  return e.type === 'user.message' && !e.agentId && (!d.source || d.source === 'user')
    && !String(d.content || '').startsWith('<system_notification>');
}

function newPrompt(e, ctx) {
  return {
    ts: e.timestamp, prompt: String(e.data.content || '').replace(/\s+/g, ' ').trim(),
    cwd: ctx.cwd, repository: ctx.repository, branch: ctx.branch,
    credits: null, premium: null, models: new Set(), toolCalls: 0, subagents: [],
    compactions: 0, end: null, lastTurn: null, toolLog: [], msgLog: [], compactAt: [], jira: new PromptJira(),
    // Wall time (ts -> end) includes waiting for your answers at a gate, which are not
    // logged as prompts. Active time is the agent's own turns minus the time its
    // ask_user calls sat waiting for you (seen: 69 hours inside one turn).
    activeMs: 0, turnStart: null, waitMs: 0, asks: {},
  };
}

async function analyse(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const prompts = [];
  let cur = null;
  // Checkpoint totals run from the session start, so the first prompt's baseline is zero.
  let prev = { nano: 0, premium: 0 };
  let start = null;
  let shutdown = null;
  let unattributed = 0; // checkpoints with no prompt open: background work, resumes
  // Older Copilot versions restart the running totals when a session is resumed (the
  // new run counts from zero); current ones carry them on. A total below the previous
  // one is a restart: that run counts from zero and the earlier runs move into `carried`.
  // A restarted run that has already outspent all earlier runs is indistinguishable
  // from a continuation and is under-counted — a known, rare gap.
  const carried = { nano: 0, premium: 0 };
  // Up time: each start/resume opens a run, a shutdown closes it. A run with no
  // shutdown (a crash, or the session still open) ends at its last event.
  const runs = [];
  let runStart = null;
  let lastTs = null;
  // Token estimate for history: the log has tokens only as running totals per model at
  // each shutdown (they restart on resume in older Copilot, like credits). Each run's
  // increase is split over the prompts it closed, in proportion to their credits.
  let prevTok = null;
  let pending = [];
  // Prompt-cache breaks: each model has its own cache, kept for a short time (Copilot
  // records the lifetime per model, e.g. 300 s for Claude, 1800 s for GPT). A prompt
  // that starts on a different model than the last one ended on, or after a gap longer
  // than the cache lifetime, re-reads the whole conversation at full price.
  const ttlByModel = {};
  let lastClosed = null;
  // Tool calls, for the per-prompt drill-down: main agent and subagents (named via
  // subagent.selected), with their results.
  const agentNames = new Map();
  const openTools = new Map();
  const estimate = (d) => {
    const mm = d.modelMetrics;
    if (!mm) return;
    const tot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const m of Object.values(mm)) {
      const u = (m && m.usage) || {};
      tot.input += u.inputTokens || 0; tot.output += u.outputTokens || 0;
      tot.cacheRead += u.cacheReadTokens || 0; tot.cacheWrite += u.cacheWriteTokens || 0;
    }
    const base = !prevTok || tot.input < prevTok.input ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : prevTok;
    const credited = pending.filter((q) => q.credits > 0);
    const sum = credited.reduce((a, q) => a + q.credits, 0);
    if (sum > 0) {
      for (const q of credited) {
        const share = q.credits / sum;
        q.tokensEst = Object.fromEntries(Object.keys(tot).map((k) => [k, Math.round((tot[k] - base[k]) * share)]));
      }
    }
    prevTok = tot;
    pending = [];
  };
  // Where the session is working; it moves on resume and on folder/branch changes.
  const ctx = { cwd: null, repository: null, branch: null };
  const setCtx = (c) => {
    if (!c || !c.cwd) return;
    if (c.cwd !== ctx.cwd) Object.assign(ctx, { repository: null, branch: null });
    Object.assign(ctx, { cwd: c.cwd }, c.repository ? { repository: c.repository } : {},
      c.branch ? { branch: c.branch } : {});
  };

  for await (const line of rl) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const d = e.data || {};
    if (e.type === 'session.start' || e.type === 'session.resume') {
      if (runStart) runs.push([runStart, lastTs]); // previous run never shut down
      runStart = e.timestamp;
    } else if (e.type === 'session.shutdown' && runStart) {
      runs.push([runStart, e.timestamp]);
      runStart = null;
    }
    if (e.timestamp) lastTs = e.timestamp;

    if (e.type === 'session.start') {
      start = { ts: d.startTime || e.timestamp, cwd: d.context && d.context.cwd };
      setCtx(d.context);
    } else if (e.type === 'session.resume') setCtx(d.context);
    else if (e.type === 'session.context_changed') setCtx(d);

    if (isUserPrompt(e)) {
      // A prompt typed while the previous one was still running folds into it.
      if (!cur) { cur = newPrompt(e, ctx); prompts.push(cur); }
      continue;
    }
    // A shutdown carries the same running totals, and closes a prompt the session
    // exited in the middle of; otherwise that prompt would absorb every prompt, and
    // the idle days, until the next checkpoint after a resume.
    if (e.type === 'session.usage_checkpoint' && Array.isArray(d.modelCacheState)) {
      for (const m of d.modelCacheState) if (m && m.modelId && m.cacheTtlSeconds) ttlByModel[m.modelId] = m.cacheTtlSeconds;
    }
    if (e.type === 'session.usage_checkpoint' || (e.type === 'session.shutdown' && d.totalNanoAiu != null)) {
      if (e.type === 'session.shutdown') shutdown = d;
      const tot = { nano: d.totalNanoAiu, premium: d.totalPremiumRequests };
      if (tot.nano != null && prev.nano != null) {
        const restarted = tot.nano < prev.nano;
        if (restarted) {
          carried.nano += prev.nano;
          carried.premium += prev.premium || 0;
        }
        const base = restarted ? { nano: 0, premium: 0 } : prev;
        const delta = (tot.nano - base.nano) / NANO_PER_CREDIT;
        if (cur) {
          cur.credits = delta;
          cur.premium = Math.round(((tot.premium || 0) - (base.premium || 0)) * 100) / 100;
        } else {
          unattributed += delta;
        }
      }
      if (cur) {
        cur.end = cur.lastTurn || e.timestamp;
        cur.activeMs = Math.max(0, cur.activeMs - cur.waitMs);
        delete cur.asks;
        delete cur.turnStart;
        pending.push(cur);
        if (lastClosed && lastClosed.lastModel && cur.firstModel) {
          if (cur.firstModel !== lastClosed.lastModel) {
            cur.cacheBreak = { kind: 'switch', from: lastClosed.lastModel, to: cur.firstModel };
          } else if (lastClosed.end && cur.ts) {
            const gap = (Date.parse(cur.ts) - Date.parse(lastClosed.end)) / 1000;
            const ttl = ttlByModel[cur.firstModel] || (/^claude/.test(cur.firstModel) ? 300 : 1800);
            if (gap > ttl) cur.cacheBreak = { kind: 'idle', gapSeconds: Math.round(gap), ttlSeconds: ttl };
          }
        }
        if (cur.lastModel) lastClosed = cur;
      }
      prev = tot;
      cur = null;
      if (e.type === 'session.shutdown') estimate(d);
      continue;
    }
    if (e.type === 'session.shutdown') { shutdown = d; estimate(d); continue; }
    if (e.type === 'subagent.selected' && e.agentId && d.agentName) agentNames.set(e.agentId, d.agentName);
    if (e.type === 'tool.execution_complete' && openTools.has(d.toolCallId)) {
      const t = openTools.get(d.toolCallId);
      openTools.delete(d.toolCallId);
      const c = d.result && d.result.content;
      t.resultChars = String(typeof c === 'string' ? c : JSON.stringify(c ?? '')).length;
      t.resultTs = e.timestamp;
      t.error = d.success === false;
      if (t.owner && t.jiraStart && !t.error) { try { t.owner.jira.complete(t.name, t.jiraStart, c); } catch { /* best effort */ } }
    }
    if (!cur) continue;
    if (e.type === 'tool.execution_start' && d.toolCallId) {
      const t = { id: d.toolCallId, name: d.toolName, detail: toolDetail(d.arguments), ts: e.timestamp, agent: e.agentId || null,
        where: e.agentId ? (agentNames.get(e.agentId) || 'subagent') : 'main' };
      cur.toolLog.push(t);
      openTools.set(d.toolCallId, t);
      try {
        // Non-enumerable: they point back at the prompt, which would make --json circular.
        Object.defineProperty(t, 'jiraStart', { value: cur.jira.start(d.toolName, d.arguments), writable: true });
        Object.defineProperty(t, 'owner', { value: cur });
      } catch { /* best effort */ }
    }

    // One per model call (main agent and subagents): what the call asked for, for --calls.
    if (e.type === 'assistant.message' && d.model) {
      cur.msgLog.push({ ts: e.timestamp, agent: e.agentId || null, model: d.model,
        requests: (d.toolRequests || []).map((r) => ({ id: r.toolCallId, name: r.name, detail: toolDetail(r.arguments) })),
        replyChars: String(d.content || '').length, reply: String(d.content || '').slice(0, 600),
        reasoning: String(d.reasoningText || '').replace(/\s+/g, ' ').trim().slice(0, 600) });
    }
    if (e.type === 'session.compaction_complete' && !e.agentId) cur.compactAt.push(e.timestamp);

    if (e.type === 'assistant.turn_start' && !e.agentId) cur.turnStart = e.timestamp;
    else if (e.type === 'assistant.turn_end' && !e.agentId) {
      cur.lastTurn = e.timestamp; // wall time ends here, not at an idle checkpoint
      if (cur.turnStart) cur.activeMs += Math.max(0, Date.parse(e.timestamp) - Date.parse(cur.turnStart));
      cur.turnStart = null;
    }
    else if (e.type === 'assistant.message' && !e.agentId && d.model) {
      cur.models.add(d.model);
      cur.firstModel = cur.firstModel || d.model;
      cur.lastModel = d.model;
    }
    else if (e.type === 'tool.execution_start' && !e.agentId) {
      cur.toolCalls++;
      if (d.toolName === 'ask_user') cur.asks[d.toolCallId] = e.timestamp;
    } else if (e.type === 'tool.execution_complete' && !e.agentId && cur.asks[d.toolCallId]) {
      cur.waitMs += Math.max(0, Date.parse(e.timestamp) - Date.parse(cur.asks[d.toolCallId]));
      delete cur.asks[d.toolCallId];
    }
    else if (e.type === 'subagent.completed') {
      cur.subagents.push({ agent: d.agentName, model: d.model, tokens: d.totalTokens || 0,
        toolCalls: d.totalToolCalls || 0, ms: d.durationMs || 0 });
    } else if (e.type === 'session.compaction_complete') cur.compactions++;
  }
  if (runStart) runs.push([runStart, lastTs]);
  return {
    start, prompts, shutdown, unattributed, runs, agentNames,
    totals: { credits: (carried.nano + prev.nano) / NANO_PER_CREDIT,
      premium: Math.round((carried.premium + (prev.premium || 0)) * 100) / 100 },
  };
}

// ------------------------------------------------------------------ formatting

const fmtCredits = (c) => (c == null ? '?' : c.toFixed(2));
const fmtInt = (n) => (n == null ? '?' : Math.round(n).toLocaleString('en-US'));
const cell = (s, n) => {
  const t = String(s).replace(/\|/g, '\\|');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
function fmtSeconds(sec) {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}
function fmtDuration(from, to) {
  if (!from || !to) return '…';
  return fmtSeconds((Date.parse(to) - Date.parse(from)) / 1000);
}

function report(session, result, last) {
  const { prompts, totals, start, shutdown, unattributed } = result;
  const shown = prompts.slice(-last);
  const done = shown.filter((p) => p.credits != null);
  const windowCredits = done.reduce((a, p) => a + p.credits, 0);
  const out = [];

  out.push(`# Copilot session cost — ${session.id.slice(0, 8)}`);
  out.push('');
  if (start) out.push(`Started ${start.ts ? new Date(start.ts).toISOString().slice(0, 16).replace('T', ' ') : '?'} in \`${start.cwd || '?'}\`.`);
  const upSec = result.runs.reduce((a, [s, e]) => a + Math.max(0, Date.parse(e) - Date.parse(s)), 0) / 1000;
  out.push(`Up for ${fmtSeconds(upSec)} over ${result.runs.length} run${result.runs.length === 1 ? '' : 's'} `
    + '(start or resume to exit).');
  out.push(`${prompts.length} prompts; showing the last ${shown.length}. `
    + `Session total: **${fmtCredits(totals && totals.credits)} AI credits (${creditsUsd(totals && totals.credits)})**, ${fmtInt(totals && totals.premium)} premium requests.`);
  const breaks = cacheBreakLine(shown);
  if (breaks) out.push(breaks);
  if (result.quota) {
    out.push(`Premium quota: ${result.quota.leftPct}% left${result.quota.resets ? `, resets ${result.quota.resets.slice(0, 10)}` : ''} `
      + `(as of ${result.quota.ts.slice(0, 16).replace('T', ' ')} UTC).`);
  }
  out.push('');

  out.push('| # | When (UTC) | Prompt | Credits | Cost | Premium | Tokens in / out | Main model | Tools | Subagents (tokens) | Active | Wall |');
  out.push('|---|---|---|---:|---:|---:|---:|---|---:|---|---:|---:|');
  shown.forEach((p, i) => {
    const n = prompts.length - shown.length + i + 1;
    const subs = p.subagents.length
      ? `${p.subagents.length} (${fmtInt(p.subagents.reduce((a, s) => a + s.tokens, 0))})` : '—';
    const flag = p.compactions ? ' ⟳' : '';
    out.push(`| ${n} | ${(p.ts || '').slice(5, 16).replace('T', ' ')} | ${cell(p.prompt, 50)} | `
      + `${fmtCredits(p.credits)}${breakMark(p)} | ${creditsUsd(p.credits)} | ${p.premium == null ? '?' : p.premium} | ${fmtTokens(tokensOf(p))} | ${cell([...p.models].join(', ') || '—', 22)} | `
      + `${p.toolCalls} | ${subs}${flag} | ${fmtSeconds(p.activeMs / 1000)} | ${fmtDuration(p.ts, p.end)} |`);
  });
  out.push('');
  if (shown.some((p) => p.compactions)) out.push('⟳ = the context was compacted during this prompt.\n');

  const subs = shown.flatMap((p) => p.subagents);
  if (subs.length) {
    const by = new Map();
    for (const s of subs) {
      const k = `${s.agent}\u0000${s.model}`;
      const v = by.get(k) || { agent: s.agent, model: s.model, runs: 0, tokens: 0, ms: 0 };
      v.runs++; v.tokens += s.tokens; v.ms += s.ms;
      by.set(k, v);
    }
    out.push('## Subagents');
    out.push('| Agent | Model | Runs | Tokens | Avg time |');
    out.push('|---|---|---:|---:|---:|');
    for (const v of [...by.values()].sort((a, b) => b.tokens - a.tokens)) {
      out.push(`| ${v.agent} | ${v.model || '?'} | ${v.runs} | ${fmtInt(v.tokens)} | ${Math.round(v.ms / v.runs / 1000)}s |`);
    }
    out.push('');
  }

  if (done.length) {
    const followUps = done.filter((p) => !p.subagents.length);
    const fuCredits = followUps.reduce((a, p) => a + p.credits, 0);
    const top = [...done].sort((a, b) => b.credits - a.credits).slice(0, 3);
    out.push('## Where the credits went');
    out.push(`- Shown prompts: **${fmtCredits(windowCredits)} credits (${creditsUsd(windowCredits)})**.`);
    out.push(`- Prompts with no subagent: ${followUps.length} of ${done.length}, `
      + `${fmtCredits(fuCredits)} credits (${windowCredits ? Math.round((fuCredits / windowCredits) * 100) : 0}%). `
      + 'Their cost is mostly the main conversation re-sent each turn — long sessions make every follow-up dearer.');
    if (unattributed > 0.005) {
      out.push(`- Not tied to any prompt (whole session): ${fmtCredits(unattributed)} credits — `
        + 'usage recorded between prompts, e.g. background work finishing after a reply or around a resume.');
    }
    out.push(`- Most expensive: ${top.map((p) => `"${cell(p.prompt, 40)}" ${fmtCredits(p.credits)}`).join('; ')}.`);
    out.push('');
  }

  if (shutdown && shutdown.tokenDetails) {
    const t = shutdown.tokenDetails;
    const g = (k) => fmtInt(t[k] && t[k].tokenCount);
    out.push(`Session tokens at last shutdown: input ${g('input')}, cache read ${g('cache_read')}, `
      + `cache write ${g('cache_write')}, output ${g('output')}.`);
  }
  if (shown.some((p) => p.cacheBreak)) out.push(BREAK_NOTE);
  out.push(TOKENS_NOTE);
  return out.join('\n');
}

/** Folder and first prompt, streamed: logs open with inline images, so a fixed-size
 *  head can hold only a handful of lines. Stops at the first prompt. */
async function sessionHead(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let cwd = '?';
  for await (const line of rl) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'session.start') cwd = (e.data.context && e.data.context.cwd) || '?';
    if (isUserPrompt(e)) { rl.close(); return { cwd, first: String(e.data.content).replace(/\s+/g, ' ') }; }
  }
  return { cwd, first: '' };
}

async function listSessions() {
  const rows = [];
  for (const s of sessions().slice(0, 10)) {
    const { cwd, first } = await sessionHead(s.file);
    rows.push(`| ${s.id.slice(0, 8)} | ${new Date(s.mtime).toISOString().slice(0, 16).replace('T', ' ')} | ${cell(cwd, 40)} | ${cell(first, 50)} |`);
  }
  return ['| Session | Last active (UTC) | Folder | First prompt |', '|---|---|---|---|', ...rows].join('\n');
}

const USAGE = 'usage: session-cost.js [session-id-prefix] [--last N | --all] [--prompt N [--calls | --call K]] [--list] [--json]';

/** The report for these arguments, as text. Throws UsageError on bad input. */
async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) return USAGE;
  if (opts.list) return listSessions();
  const session = resolveSession(opts.session);
  const result = await analyse(session.file);
  const live = readTokenLog();
  attachLiveTokens(result.prompts, live.get(session.id));
  result.quota = latestQuota(live);
  if (opts.json) {
    const prompts = result.prompts.slice(-opts.last).map((p) => ({ ...p, models: [...p.models] }));
    return JSON.stringify({ session: session.id, start: result.start, totals: result.totals,
      unattributed: result.unattributed, prompts }, null, 2);
  }
  if (opts.prompt != null) return promptReport(session, result, opts.prompt, opts);
  return report(session, result, opts.last);
}

if (require.main === module) {
  run(process.argv.slice(2)).then(console.log, (err) => {
    console.error(`session-cost: ${err instanceof UsageError ? err.message : err.stack}`);
    process.exit(1);
  });
}

module.exports = { analyse, isUserPrompt, sessions, run, UsageError, STATE,
  readTokenLog, attachLiveTokens, latestQuota, tokensOf, fmtTokens, TOKENS_NOTE,
  cacheBreakStats, cacheBreakLine, breakMark, BREAK_NOTE, callUsd, creditsUsd, joinCalls,
  promptReportForTest: (p, names) => tokenSplit(p, names).join('\n') };
