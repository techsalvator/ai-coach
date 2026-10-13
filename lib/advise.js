'use strict';
/**
 * Where Copilot spend can be cut, measured on your own sessions.
 *
 *   node lib/advise.js                 last 30 days
 *   node lib/advise.js --since 7d --top 5
 *   node lib/advise.js --json
 *
 * Every model call re-sends the whole conversation, so most spend is context, not work. The
 * report looks for the ways that shows up, states what it measured and an estimated saving for
 * each, and lists what it checked and found small. Two bases are used, and each finding says which:
 *   all prompts          credits per prompt, from Copilot's usage checkpoints (every session)
 *   prompts with tokens  per-call tokens, priced at GitHub's list prices (only sessions the token
 *                        logger saw: they need the /cost extension)
 * Savings overlap (a fresh session also removes cache expiries), so they do not add up.
 */

const { sessions, analyse, joinCalls, attachLiveTokens, readTokenLog, callUsd, UsageError } = require('./session-cost');
const { collect, parseSince } = require('./prompt-usage');
const PRICES = (() => { try { return require('./copilot-prices.json'); } catch { return null; } })();

const CTX_LIMIT = 60000;        // context size beyond which a main-agent call is "long"
const SHORT_WORDS = 4;          // a reply this short ("yes", "accept it") is a confirmation
const MIN_SAVING = 0.02;        // a finding saving less than this share of its base is "small"
const CACHE_TTL_LONG = 30 * 60; // GPT models in Copilot keep the prompt cache this long (Claude: 5 min)

const sum = (xs, f = (x) => x) => xs.reduce((a, x) => a + (f(x) || 0), 0);
const median = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
const usd = (credits) => `$${(credits * 0.01).toFixed(2)}`;
const money = (d) => `$${d.toFixed(2)}`;
const pct = (x) => `${Math.round(x * 100)}%`;

/** Dollars of a call re-priced on another model (same tokens, same caching behaviour); null if unpriced. */
function repriced(rec, model) {
  const pr = PRICES && PRICES.models[model];
  if (!pr) return null;
  const fresh = Math.max(0, rec.input - rec.cacheRead - rec.cacheWrite);
  return (fresh * pr.input + rec.cacheRead * pr.cachedInput + rec.cacheWrite * (pr.cacheWrite ?? pr.input) + rec.output * pr.output) / 1e6;
}

/** Dollars of a call's input side (everything but output), and of its output. */
function parts(rec) {
  const pr = PRICES && PRICES.models[rec.model];
  if (!pr) return null;
  const fresh = Math.max(0, rec.input - rec.cacheRead - rec.cacheWrite);
  return {
    input: (fresh * pr.input + rec.cacheRead * pr.cachedInput + rec.cacheWrite * (pr.cacheWrite ?? pr.input)) / 1e6,
    output: rec.output * pr.output / 1e6,
    warmInput: rec.input * pr.cachedInput / 1e6, // the whole input read from cache
  };
}

// ------------------------------------------------------------------ findings

/**
 * Pure: rows = prompt rows (credits, prompt, session, ts, seconds, cacheBreak, models);
 * calls = [{session, sub, who, model, rec, miss, idle}] for prompts with live tokens.
 * Returns {context, findings, small}.
 */
function evaluate(rows, calls, o = {}) {
  const top = o.top || 5;
  const totalCredits = sum(rows, (r) => r.credits);
  const priced = calls.map((c) => ({ ...c, usd: callUsd(c.rec), p: parts(c.rec) })).filter((c) => c.usd != null && c.p);
  const totalUsd = sum(priced, (c) => c.usd);
  const findings = [];
  const small = [];
  const add = (f) => (f.savingShare >= MIN_SAVING ? findings : small).push(f);

  // 1. Long sessions: every call re-sends the conversation so far.
  {
    const bySession = new Map();
    for (const r of rows) {
      const a = bySession.get(r.session) || { id: r.session, n: 0, credits: 0, first: r.ts, last: r.ts };
      a.n++; a.credits += r.credits || 0;
      if (r.ts < a.first) a.first = r.ts;
      if (r.ts > a.last) a.last = r.ts;
      bySession.set(r.session, a);
    }
    const ss = [...bySession.values()];
    const long = ss.filter((s) => s.n >= 21);
    const short = ss.filter((s) => s.n <= 5);
    const longCredits = sum(long, (s) => s.credits);
    const mains = priced.filter((c) => !c.sub && c.rec.input > CTX_LIMIT);
    const excess = sum(mains, (c) => ((c.rec.input - CTX_LIMIT) / c.rec.input) * c.p.input);
    const mainTotal = sum(priced.filter((c) => !c.sub), (c) => c.usd);
    const f = {
      id: 'long-sessions',
      title: 'Long sessions re-send a large context on every call',
      base: 'prompts with tokens',
      savingUsd: excess, savingShare: totalUsd ? excess / totalUsd : 0,
      evidence: [],
      actions: ['Start a **new session per ticket or skill run** (a fresh `/design`, `/story`), or `/compact` first.',
        'Close finished sessions instead of resuming them days later.'],
    };
    if (long.length) {
      f.evidence.push(`${long.length} session${long.length === 1 ? '' : 's'} with 21+ prompts ${long.length === 1 ? 'holds' : 'hold'} ${pct(longCredits / (totalCredits || 1))} of credits (${usd(longCredits)}): `
        + `${(longCredits / (sum(long, (s) => s.n) || 1)).toFixed(0)} credits per prompt${short.length ? `, against ${(sum(short, (s) => s.credits) / (sum(short, (s) => s.n) || 1)).toFixed(0)} in sessions of 1–5 prompts` : ''}.`);
      for (const s of long.sort((a, b) => b.credits - a.credits).slice(0, 3)) {
        const days = Math.max(1, Math.round((Date.parse(s.last) - Date.parse(s.first)) / 864e5));
        f.evidence.push(`Session ${s.id.slice(0, 8)}: ${s.n} prompts over ${days} day${days === 1 ? '' : 's'}, ${usd(s.credits)}.`);
      }
    }
    if (mains.length) {
      f.evidence.push(`${mains.length} of ${priced.filter((c) => !c.sub).length} main-agent calls carried over ${CTX_LIMIT / 1000}k tokens of context; `
        + `they are ${pct(sum(mains, (c) => c.usd) / (mainTotal || 1))} of main-agent spend. Keeping context to ${CTX_LIMIT / 1000}k would save about ${money(excess)}.`);
    }
    if (f.evidence.length) add(f);
  }

  // 2. Cache breaks between prompts: idle expiry and model switches.
  {
    const breaks = rows.filter((r) => r.cacheBreak);
    const warm = rows.filter((r) => !r.cacheBreak);
    const warmMedian = median(warm.map((r) => r.credits));
    const byTs = new Map();
    for (const r of rows) { if (!byTs.has(r.session)) byTs.set(r.session, []); byTs.get(r.session).push(r); }
    for (const list of byTs.values()) list.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const gapOf = (r) => {
      const list = byTs.get(r.session); const i = list.indexOf(r);
      if (i < 1) return null;
      const prev = list[i - 1];
      return (Date.parse(r.ts) - (Date.parse(prev.ts) + (prev.seconds || 0) * 1000)) / 1000;
    };
    const excessOf = (r) => Math.max(0, (r.credits || 0) - (warmMedian || 0));
    const idle = breaks.filter((r) => r.cacheBreak.kind === 'idle');
    const switches = breaks.filter((r) => r.cacheBreak.kind === 'switch');
    const covered = idle.filter((r) => { const g = gapOf(r); return g != null && g < CACHE_TTL_LONG; });
    const excess = sum(covered, excessOf);
    const f = {
      id: 'cache-breaks',
      title: 'The prompt cache expired while you were away, or the model changed',
      base: 'all prompts',
      savingCredits: excess, savingShare: totalCredits ? excess / totalCredits : 0,
      evidence: [],
      actions: ['Answer follow-ups within the cache lifetime (**5 min** for Claude models) or batch them; the first prompt after a gap re-writes the whole context at ~12× the read price.',
        'For long think-heavy sessions, start on a **GPT model: its cache lasts 30 min**. Pick it at session start; switching models mid-session also breaks the cache.',
        '`/compact` before resuming a big session after a long break.'],
    };
    if (breaks.length) {
      f.evidence.push(`${breaks.length} of ${rows.length} prompts started after a cache break (${idle.length} idle expiries, ${switches.length} model switches): `
        + `${pct(sum(breaks, (r) => r.credits) / (totalCredits || 1))} of credits. Median ${median(breaks.map((r) => r.credits))?.toFixed(0)} credits against ${warmMedian?.toFixed(0)} with the cache warm.`);
      if (covered.length) f.evidence.push(`${covered.length} idle expiries came after a 5–30 min gap, which a 30-min cache would have covered: about ${usd(excess)} above the warm median.`);
    }
    if (f.evidence.length) add(f);
  }

  // 3. Short confirmations: each re-reads the whole context.
  {
    const isShort = (r) => !/^\s*\//.test(r.prompt) && r.prompt.trim().split(/\s+/).length <= SHORT_WORDS;
    const shorts = rows.filter(isShort);
    const credits = sum(shorts, (r) => r.credits);
    const f = {
      id: 'short-replies',
      title: 'One-word replies cost as much as a full prompt\'s context',
      base: 'all prompts',
      savingCredits: credits / 2, savingShare: totalCredits ? credits / 2 / totalCredits : 0,
      evidence: shorts.length ? [`${shorts.length} repl${shorts.length === 1 ? 'y' : 'ies'} of ${SHORT_WORDS} words or fewer ("yes", "accept it"): ${pct(credits / (totalCredits || 1))} of credits, ${(credits / shorts.length).toFixed(0)} credits each (${usd(credits)}).`,
        'Saving assumes they are batched two per message.'] : [],
      actions: ['Answer **several questions in one message** ("1 yes, 2 accept, 3 …"), or say "accept all recommendations".',
        'In the grill and review skills, ask for a batch of answers per round rather than one at a time.'],
    };
    if (shorts.length) add(f);
  }

  // 4. Opus subagents writing long outputs.
  {
    const target = 'claude-sonnet-5.5';
    const opus = priced.filter((c) => c.sub && /opus/i.test(c.model));
    const byAgent = new Map();
    for (const c of opus) {
      const alt = repriced(c.rec, target);
      if (alt == null) continue;
      const a = byAgent.get(c.who) || { who: c.who, usd: 0, alt: 0, out: 0, calls: 0 };
      a.usd += c.usd; a.alt += alt; a.out += c.rec.output; a.calls++;
      byAgent.set(c.who, a);
    }
    const agents = [...byAgent.values()].sort((a, b) => (b.usd - b.alt) - (a.usd - a.alt));
    const saving = sum(agents, (a) => a.usd - a.alt);
    const f = {
      id: 'opus-subagents',
      title: 'Opus subagents write the longest outputs',
      base: 'prompts with tokens',
      savingUsd: saving, savingShare: totalUsd ? saving / totalUsd : 0,
      evidence: agents.length ? [`${agents.length} Opus agent${agents.length === 1 ? '' : 's'} are ${pct(sum(agents, (a) => a.usd) / (totalUsd || 1))} of spend (${money(sum(agents, (a) => a.usd))}); output is priced at $20 per million against $10 on Sonnet.`,
        ...agents.slice(0, top).map((a) => `${a.who}: ${money(a.usd)}, ${(a.out / 1000).toFixed(0)}k output tokens over ${a.calls} call${a.calls === 1 ? '' : 's'}; on Sonnet ${money(a.alt)}.`)] : [],
      actions: ['Trial the biggest writers (e.g. `story-decomposer`, `design-synthesizer`) on Sonnet in `model_map` and compare the results with `/cost prompt N`.',
        'Keep Opus where the reasoning matters (risk analysis, API design); the saving is only worth it if the output holds up.'],
    };
    if (agents.length) add(f);
  }

  // 5. Cache misses inside a prompt (a subagent wait, or a provider that did not serve the cache).
  {
    const misses = priced.filter((c) => c.miss);
    const extra = sum(misses, (c) => Math.max(0, c.p.input - c.p.warmInput));
    const expired = misses.filter((c) => c.idle >= 300);
    const missed = misses.filter((c) => c.idle < 300);
    const f = {
      id: 'in-prompt-misses',
      title: 'Calls that missed the cache inside a prompt',
      base: 'prompts with tokens',
      savingUsd: extra, savingShare: totalUsd ? extra / totalUsd : 0,
      evidence: misses.length ? [`${misses.length} call${misses.length === 1 ? '' : 's'} re-read their whole context uncached: ${expired.length} after a wait of 5+ min `
        + `(usually the main agent waiting on a long subagent), ${missed.length} although the previous call was moments earlier. About ${money(extra)} above a cache hit.`,
      ...(missed.length ? [`Models involved: ${[...new Set(missed.map((c) => c.model))].join(', ')}.`] : [])] : [],
      actions: ['Keep subagent runs under the cache lifetime, or split long ones; compact before a long wait.',
        'If one model keeps missing the cache with no wait, prefer another for long sessions: uncached input is 10× the cached price.'],
    };
    if (misses.length) add(f);
  }

  // Context, not findings.
  const byPrompt = rows.map((r) => r.credits || 0).sort((a, b) => b - a);
  const topN = Math.max(1, Math.ceil(byPrompt.length * 0.1));
  const byModel = new Map();
  for (const c of priced) byModel.set(c.model, (byModel.get(c.model) || 0) + c.usd);
  const typeSplit = { read: 0, write: 0, fresh: 0, out: 0 };
  for (const c of priced) {
    const pr = PRICES.models[c.model];
    const fresh = Math.max(0, c.rec.input - c.rec.cacheRead - c.rec.cacheWrite);
    typeSplit.read += c.rec.cacheRead * pr.cachedInput / 1e6;
    typeSplit.write += c.rec.cacheWrite * (pr.cacheWrite ?? pr.input) / 1e6;
    typeSplit.fresh += fresh * pr.input / 1e6;
    typeSplit.out += c.rec.output * pr.output / 1e6;
  }
  const context = {
    prompts: rows.length, credits: totalCredits, pricedPrompts: new Set(priced.map((c) => `${c.session}`)).size, pricedCalls: priced.length, pricedUsd: totalUsd,
    top10Share: totalCredits ? sum(byPrompt.slice(0, topN)) / totalCredits : 0, medianPrompt: median(byPrompt),
    models: [...byModel].sort((a, b) => b[1] - a[1]).map(([m, v]) => [m, v]),
    types: typeSplit,
    expensive: [...rows].sort((a, b) => (b.credits || 0) - (a.credits || 0)).slice(0, 3),
  };
  findings.sort((a, b) => (b.savingShare || 0) - (a.savingShare || 0));
  return { context, findings, small };
}

// ------------------------------------------------------------------ report

const savingText = (f) => (f.savingUsd != null ? `${money(f.savingUsd)} (${pct(f.savingShare)} of token-level spend)` : `${usd(f.savingCredits)} (${pct(f.savingShare)} of all credits)`);

function format(res, o) {
  const { context: c, findings, small } = res;
  const from = o.sinceMs ? new Date(o.sinceMs).toISOString().slice(0, 10) : 'the first session';
  const out = [`# Copilot cost advice — since ${from}`, '',
    `${c.prompts} prompts, **${c.credits.toFixed(0)} AI credits (${usd(c.credits)})**. Token-level checks cover ${c.pricedCalls} calls in ${c.pricedPrompts} sessions (${money(c.pricedUsd)} at list prices; needs the token logger).`,
    `The most expensive 10% of prompts are ${pct(c.top10Share)} of spend; the median prompt is ${c.medianPrompt == null ? '?' : c.medianPrompt.toFixed(1)} credits.`];
  if (c.pricedUsd) {
    const t = c.types; const tot = t.read + t.write + t.fresh + t.out || 1;
    out.push(`By token type: cache writes ${pct(t.write / tot)}, output ${pct(t.out / tot)}, cache reads ${pct(t.read / tot)}, fresh input ${pct(t.fresh / tot)}. `
      + `Models: ${c.models.slice(0, 4).map(([m, v]) => `${m} ${pct(v / c.pricedUsd)}`).join(', ')}.`);
  }
  out.push('');
  if (!findings.length) {
    out.push('Nothing stands out: no check found a saving above 2%.', '');
  } else {
    out.push('## What to change, biggest first', '', '| # | Finding | Estimated saving | Based on |', '|---:|---|---|---|');
    findings.forEach((f, i) => out.push(`| ${i + 1} | ${f.title} | ${savingText(f)} | ${f.base} |`));
    out.push('', 'Savings overlap (a fresh session also removes cache expiries), so they do not add up.', '');
    findings.forEach((f, i) => {
      out.push(`### ${i + 1}. ${f.title}`, '', ...f.evidence.map((e) => `- ${e}`), '', 'Do:', ...f.actions.map((a) => `- ${a}`), '');
    });
  }
  if (small.length) out.push(`Checked and small (under 2%): ${small.map((f) => f.title.toLowerCase()).join('; ')}.`, '');
  if (c.expensive.length) {
    out.push('Where to look first — the most expensive prompts:', '');
    out.push('| When (UTC) | Session | Prompt | Credits | Cost |', '|---|---|---|---:|---:|');
    for (const r of c.expensive) out.push(`| ${(r.ts || '').slice(5, 16).replace('T', ' ')} | ${r.session.slice(0, 8)} | ${String(r.prompt).replace(/\|/g, '\\|').slice(0, 56)} | ${(r.credits || 0).toFixed(1)} | ${usd(r.credits || 0)} |`);
    out.push('', 'Drill into one with `/cost prompt N` (its number is in `/cost session <id>`).');
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ gathering

function parseArgs(argv) {
  const o = { since: '30d', top: 5, json: false, source: 'cli' }; // the checks are about Copilot CLI sessions (cache, per-call tokens)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`); return argv[++i]; };
    if (a === '--since') o.since = val();
    else if (a === '--top') o.top = Number(val());
    else if (a === '--json') o.json = true;
    else if (a === '--source') o.source = val();
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new UsageError(`unknown option ${a} (see /cost help)`);
  }
  if (!(o.top > 0)) throw new UsageError('--top needs a positive number');
  if (!['all', 'cli', 'vscode'].includes(o.source)) throw new UsageError('--source is one of: all, cli, vscode');
  return o;
}

/** Per-call records of every prompt with live tokens in the sessions active since sinceMs. */
async function liveCalls(sinceMs) {
  const live = readTokenLog();
  const out = [];
  for (const s of sessions()) {
    if (s.mtime < sinceMs || !live.has(s.id)) continue;
    const r = await analyse(s.file);
    attachLiveTokens(r.prompts, live.get(s.id));
    for (const p of r.prompts) {
      if (!p.liveCalls || !p.liveCalls.length) continue;
      for (const c of joinCalls(p, r.agentNames || new Map())) {
        out.push({ session: s.id, sub: Boolean(c.r.sub), who: c.who, model: c.r.model, rec: c.r, miss: Boolean(c.cacheMiss), idle: c.idle });
      }
    }
  }
  return out;
}

async function run(argv, deps = {}) {
  const o = parseArgs(argv);
  if (o.help) return 'usage: advise.js [--since 30d|all|DATE] [--top N] [--source all|cli|vscode] [--json]';
  o.sinceMs = parseSince(o.since);
  const { prompts } = await (deps.collect || collect)(o.sinceMs, { source: o.source });
  const rows = prompts.filter((r) => (r.ts ? Date.parse(r.ts) >= o.sinceMs : true));
  const calls = o.source === 'vscode' ? [] : await (deps.liveCalls || liveCalls)(o.sinceMs);
  const res = evaluate(rows, calls, o);
  return o.json ? JSON.stringify(res, null, 2) : format(res, o);
}

if (require.main === module) {
  run(process.argv.slice(2)).then(console.log, (err) => {
    console.error(`advise: ${err instanceof UsageError ? err.message : err.stack}`);
    process.exit(1);
  });
}

module.exports = { run, evaluate, format, repriced, parseArgs };
