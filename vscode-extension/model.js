'use strict';
// The drill-down data, with no VS Code dependency: sessions -> prompts -> model calls, from Claude Code's
// transcripts. extension.js renders it; the tests and `node model.js` read it directly.

const fs = require('fs');
const readline = require('readline');
const path = require('path');

// In the repository the report code is the parent folder's lib/ (always current); the packaged .vsix carries its own copy in runtime/.
const libDir = [path.join(__dirname, '..', 'lib'), path.join(__dirname, 'runtime', 'lib')].find((d) => fs.existsSync(path.join(d, 'claude-cost.js')));
if (!libDir) throw new Error('ai-cost-drilldown lib not found: run `npm run bundle-runtime`');
const cc = require(path.join(libDir, 'claude-cost.js'));
const em = require(path.join(libDir, 'emissions.js'));

const sizeOf = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);

/** One model call as a row: who made it, model, tokens, cost (null when the model has no rate). */
/** The tool calls a model call made, joined to their results through the prompt's tool log. */
function toolsOf(prompt, c) {
  const byId = prompt.toolById || (prompt.toolById = new Map((prompt.toolCalls || []).map((t) => [t.id, t])));
  return [...(c.tools || [])].map((id) => byId.get(id)).filter(Boolean).map((t) => ({
    id: t.id, name: t.name, detail: t.detail, error: Boolean(t.error), tokens: t.resultChars == null ? null : Math.round(t.resultChars / 4),
    seconds: t.resultTs && t.ts ? Math.max(0, Math.round((Date.parse(t.resultTs) - Date.parse(t.ts)) / 1000)) : null,
  }));
}

function callRow(prompt, c, i) {
  const tokensIn = sizeOf(c.u);
  return {
    kind: 'call', id: c.id, n: i + 1, ts: c.ts, who: c.who, model: c.model,
    usd: prompt.rate(c), tokensIn, tokensOut: c.u.output_tokens || 0,
    fresh: c.u.input_tokens || 0, cacheRead: c.u.cache_read_input_tokens || 0, cacheWrite: c.u.cache_creation_input_tokens || 0, tools: c.tools ? c.tools.size : 0, toolCalls: toolsOf(prompt, c),
  };
}

const sum = (xs, k) => xs.reduce((a, x) => a + (x[k] || 0), 0);
/** Token split for a list of calls: uncached input, cache reads, cache writes, output. */
function split(calls) {
  const t = { fresh: sum(calls, 'fresh'), cacheRead: sum(calls, 'cacheRead'), cacheWrite: sum(calls, 'cacheWrite'), out: sum(calls, 'tokensOut'), calls: calls.length, known: true };
  t.in = t.fresh + t.cacheRead + t.cacheWrite;
  t.cacheHit = t.in ? t.cacheRead / t.in : null;
  return t;
}
/** Several splits as one. `known` is false only when none of them had token data. */
function mergeSplit(splits) {
  const t = { fresh: sum(splits, 'fresh'), cacheRead: sum(splits, 'cacheRead'), cacheWrite: sum(splits, 'cacheWrite'), out: sum(splits, 'out'), calls: sum(splits, 'calls'), known: splits.some((x) => x.known) };
  t.in = t.fresh + t.cacheRead + t.cacheWrite;
  t.cacheHit = t.in ? t.cacheRead / t.in : null;
  return t;
}
/** Per-model calls, tokens and cost. A prompt without per-call data counts once, on its first model. */
function modelsOf(prompts) {
  const m = new Map();
  const add = (model, calls, tin, tout, usd) => {
    const x = m.get(model) || { model, calls: 0, in: 0, out: 0, usd: 0, priced: true };
    x.calls += calls; x.in += tin; x.out += tout;
    if (usd == null) x.priced = false; else x.usd += usd;
    m.set(model, x);
  };
  for (const p of prompts) {
    if (p.calls.length) for (const c of p.calls) add(c.model, 1, c.tokensIn, c.tokensOut, c.usd);
    else if (p.models.length) add(p.models[0], p.split.calls || 1, p.split.in, p.split.out, p.usd);
  }
  return [...m.values()].sort((a, b) => b.in + b.out - a.in - a.out);
}

/** Sessions with their prompts and calls, newest first. */
async function load({ maxSessions = 500, root } = {}) {
  const list = cc.sessions(root).slice(0, maxSessions);
  const { learned, results } = await cc.learnRates(list);
  return results.filter((r) => r.prompts.length).map((result) => {
    const prompts = cc.rows(result, learned).map((p, pi) => ({
      kind: 'prompt', n: pi + 1, ts: p.ts, text: p.prompt || '(no text)', usd: p.usd, usdEstimated: p.usdEstimated,
      tokensIn: p.tokensIn, tokensOut: p.tokensOut, cacheHit: p.cacheHit, models: p.models, seconds: p.seconds,
      cacheBreak: p.cacheBreak, toolCalls: p.toolCalls.map((t) => ({ id: t.id, name: t.name, detail: t.detail, error: Boolean(t.error), where: t.where, tokens: t.resultChars == null ? null : Math.round(t.resultChars / 4), seconds: t.resultTs && t.ts ? Math.max(0, Math.round((Date.parse(t.resultTs) - Date.parse(t.ts)) / 1000)) : null })),
      calls: p.modelCalls.sort((a, b) => (a.ts < b.ts ? -1 : 1)).map((c, i) => callRow(p, c, i)),
    }));
    for (const p of prompts) p.split = split(p.calls);
    const usd = prompts.reduce((a, p) => a + (p.usd || 0), 0);
    const last = prompts[prompts.length - 1];
    return {
      kind: 'session', id: result.session.id, file: result.session.file, title: result.title || path.basename(result.cwd || result.session.project),
      cwd: result.cwd, branch: result.branch, ts: last.ts, usd,
      tokensIn: prompts.reduce((a, p) => a + p.tokensIn, 0), tokensOut: prompts.reduce((a, p) => a + p.tokensOut, 0), prompts,
      source: 'claude', split: mergeSplit(prompts.map((p) => p.split)), models: modelsOf(prompts),
    };
  }).sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

/** Cost of prompts sent on the given local day (default today). */
function dayTotal(sessions, day = new Date()) {
  const same = (ts) => { const d = new Date(ts); return d.toDateString() === day.toDateString(); };
  return sessions.reduce((a, s) => a + s.prompts.filter((p) => same(p.ts)).reduce((b, p) => b + (p.usd || 0), 0), 0);
}

const money = (x) => (x == null ? '—' : `$${x.toFixed(x < 1 ? 3 : 2)}`);
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

const CLIP = 6000;
const clip = (t) => { const x = String(t == null ? '' : t); return x.length > CLIP ? `${x.slice(0, CLIP)}\n… (${x.length - CLIP} more characters)` : x; };
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && typeof b.text === 'string' ? b.text : b && b.type === 'image' ? '[image]' : '')).join('') : '');

/** The new input a record adds to the conversation: the prompt text, or tool results. */
function inputBlocks(e) {
  const c = e.message && e.message.content;
  if (typeof c === 'string') return [{ type: 'text', text: clip(c) }];
  return (Array.isArray(c) ? c : []).map((b) => (b.type === 'tool_result' ? { type: 'result', text: clip(textOf(b.content)), error: Boolean(b.is_error) }
    : b.type === 'text' ? { type: 'text', text: clip(b.text) } : null)).filter(Boolean);
}

/** One model call's content, read on demand from the transcript (the main one, then the subagents').
 *  `input` is what the call added to the conversation since the previous call (the rest of its context was
 *  already there, mostly served from cache); `output` is what the model returned. */
async function callDetail(file, id) {
  const files = [file];
  const subDir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  if (fs.existsSync(subDir)) for (const f of fs.readdirSync(subDir)) if (f.endsWith('.jsonl')) files.push(path.join(subDir, f));
  for (const f of files) {
    let pending = [];
    let found = null;
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      const m = e.message;
      if (e.type === 'assistant' && m) {
        if (m.id === id) {
          if (!found) found = { input: pending, output: [] };
          for (const b of m.content || []) {
            if (b.type === 'text') found.output.push({ type: 'text', text: clip(b.text) });
            else if (b.type === 'thinking') found.output.push({ type: 'thinking', text: clip(b.thinking || '') });
            else if (b.type === 'tool_use') found.output.push({ type: 'tool', name: b.name, text: clip(JSON.stringify(b.input, null, 2)) });
          }
        } else if (found) break;
        else pending = [];
      } else if (e.type === 'user' && m && !found) pending = pending.concat(inputBlocks(e));
    }
    rl.close();
    if (found) return found;
  }
  return null;
}

/** A session narrowed to some of its prompts, with its totals recomputed. */
function subset(session, prompts) {
  return { ...session, prompts, usd: sum(prompts, 'usd'), tokensIn: sum(prompts, 'tokensIn'), tokensOut: sum(prompts, 'tokensOut'),
    ts: prompts.length ? prompts[prompts.length - 1].ts : session.ts, split: mergeSplit(prompts.map((p) => p.split)), models: modelsOf(prompts) };
}

/** A tool call's full input and result, read on demand from the Claude Code transcripts (main, then subagents). */
async function toolContent(file, id) {
  const files = [file];
  const subDir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  if (fs.existsSync(subDir)) for (const f of fs.readdirSync(subDir)) if (f.endsWith('.jsonl')) files.push(path.join(subDir, f));
  for (const f of files) {
    let input = null; let result = null; let error = false;
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes(id)) continue; // cheap skip: most lines are not about this tool call
      let e; try { e = JSON.parse(line); } catch { continue; }
      for (const b of (e.message && Array.isArray(e.message.content) ? e.message.content : [])) {
        if (b.type === 'tool_use' && b.id === id) input = clip(JSON.stringify(b.input, null, 2));
        else if (b.type === 'tool_result' && b.tool_use_id === id) { result = clip(textOf(b.content)); error = Boolean(b.is_error); }
      }
      if (input != null && result != null) break;
    }
    rl.close();
    if (input != null || result != null) return { input, result, error };
  }
  return null;
}

module.exports = { em, clip, toolContent, split, mergeSplit, modelsOf, subset, libDir, callDetail, load, dayTotal, money, tokens };

if (require.main === module) {
  load({ maxSessions: Number(process.argv[2]) || 5 }).then((ss) => {
    for (const s of ss) {
      console.log(`${money(s.usd).padStart(8)}  ${s.title} (${s.prompts.length} prompts)`);
      for (const p of s.prompts.slice(-3)) {
        console.log(`${money(p.usd).padStart(12)}  ${p.text.slice(0, 50)} [${p.calls.length} calls]`);
        for (const c of p.calls.slice(0, 2)) console.log(`${money(c.usd).padStart(16)}  ${c.model} in ${tokens(c.tokensIn)} out ${tokens(c.tokensOut)}`);
      }
    }
    console.log(`today: ${money(dayTotal(ss))}`);
  });
}
