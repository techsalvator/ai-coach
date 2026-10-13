'use strict';
// Where the loaded sessions could have cost less. Pure: takes model.js sessions, returns findings.
// Each finding says what was measured, an estimated saving in dollars, and the prompts it points at
// (`targets` are [sessionIndex, promptIndex] paths into the same array). Savings overlap, so they do not add up.

const fs = require('fs');
const path = require('path');
const { libDir } = require('./model');

const PRICES = (() => { try { return JSON.parse(fs.readFileSync(path.join(libDir, 'copilot-prices.json'), 'utf8')).models; } catch { return {}; } })();
const priceOf = (model) => PRICES[String(model).replace(/-(\d+)-(\d+)$/, '-$1.$2').replace(/-\d{8}$/, '')] || null;

const CHEAP_MODEL = 'claude-sonnet-5.5';
const LIGHT_OUTPUT = 400;   // output tokens at or under this: a short reply
const LONG_CONTEXT = 150000;
const KEEP_CONTEXT = 100000;
const MIN_SAVING = 0.05;

const money = (x) => `$${x.toFixed(2)}`;
const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) || 0), 0);

/** The cost of a call on a model, from the price table (null when the model has no price). */
function tableCost(c, model) {
  const p = priceOf(model);
  if (!p) return null;
  return (c.fresh * p.input + c.cacheRead * p.cachedInput + c.cacheWrite * (p.cacheWrite ?? p.input) + c.tokensOut * p.output) / 1e6;
}

function advise(sessions) {
  const findings = [];
  const prompts = sessions.flatMap((s, si) => s.prompts.map((p, pi) => ({ p, s, path: [si, pi] })));
  const total = sum(prompts, (x) => x.p.usd);

  // 1. Cache expired between prompts: the whole context was re-sent at the write price.
  const breaks = prompts.filter((x) => x.p.cacheBreak && ['idle', 'miss'].includes(x.p.cacheBreak.kind));
  const expiry = breaks.map((x) => {
    const pr = priceOf(x.p.cacheBreak.to);
    return { ...x, saving: pr ? x.p.cacheBreak.uncached * ((pr.cacheWrite ?? pr.input) - pr.cachedInput) / 1e6 : 0 };
  });
  const expiryUsd = sum(expiry, (x) => x.saving);
  if (breaks.length) {
    const idle = breaks.filter((x) => x.p.cacheBreak.kind === 'idle').length;
    findings.push({
      id: 'cache-expiry', title: 'Prompt cache expired between prompts', saving: expiryUsd,
      detail: `${breaks.length} prompts started after the cache had lapsed (${idle} after the cache lifetime, ${breaks.length - idle} for other reasons), so the whole conversation was re-sent at the cache-write price: ${money(expiryUsd)} more than a cache read.`,
      action: 'Start a fresh session after a long break instead of resuming a big one, or batch your prompts so the gap stays under the cache lifetime (5 minutes, or 1 hour on extended caching).',
      targets: expiry.sort((a, b) => b.saving - a.saving).slice(0, 15).map((x) => x.path),
    });
  }

  // 2. Model switches mid-conversation also start with a cold cache.
  const switches = prompts.filter((x) => x.p.cacheBreak && x.p.cacheBreak.kind === 'switch');
  if (switches.length) {
    const usd = sum(switches, (x) => { const pr = priceOf(x.p.cacheBreak.to); return pr ? x.p.cacheBreak.uncached * ((pr.cacheWrite ?? pr.input) - pr.cachedInput) / 1e6 : 0; });
    findings.push({
      id: 'model-switch', title: 'Model switched mid-session', saving: usd,
      detail: `${switches.length} prompts ran on a different model from the one before, which cannot reuse its cache (${money(usd)} of re-sent context).`,
      action: 'Pick a model at the start of a session and keep it. Switch only when the task really changes.',
      targets: switches.slice(0, 15).map((x) => x.path),
    });
  }

  // 3. A top-tier model answering with a short reply: the same call on a cheaper model.
  const cheap = priceOf(CHEAP_MODEL);
  const heavy = [];
  for (const x of prompts) {
    for (const c of x.p.calls) {
      const mine = priceOf(c.model);
      if (!cheap || !mine || c.usd == null || c.tokensOut > LIGHT_OUTPUT || c.model.includes('sonnet') || c.model.includes('haiku')) continue;
      const alt = tableCost(c, CHEAP_MODEL); const own = tableCost(c, c.model);
      if (own > 0 && alt != null && alt < own) heavy.push({ x, saving: c.usd * (1 - alt / own) });
    }
  }
  if (heavy.length) {
    const usd = sum(heavy, (h) => h.saving);
    const byPrompt = new Map();
    for (const h of heavy) byPrompt.set(h.x.path.join(','), (byPrompt.get(h.x.path.join(',')) || 0) + h.saving);
    findings.push({
      id: 'heavy-model', title: 'Top-tier model on short replies', saving: usd,
      detail: `${heavy.length} calls on the larger models returned ${LIGHT_OUTPUT} tokens or fewer: mostly tool steps and short answers. The same calls on ${CHEAP_MODEL} would have cost about ${money(usd)} less.`,
      action: 'Use the larger model for planning and hard debugging, and a Sonnet-class model for edits, lookups and routine tool use.',
      targets: [...byPrompt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k]) => k.split(',').map(Number)),
    });
  }

  // 4. Very long contexts: every call re-reads all of it.
  const longs = [];
  for (const x of prompts) {
    const excess = sum(x.p.calls.filter((c) => c.tokensIn > LONG_CONTEXT), (c) => {
      const pr = priceOf(c.model);
      return pr ? (c.tokensIn - KEEP_CONTEXT) * pr.cachedInput / 1e6 : 0;
    });
    if (excess > 0) longs.push({ ...x, saving: excess });
  }
  if (longs.length) {
    const usd = sum(longs, (x) => x.saving);
    const calls = sum(longs, (x) => x.p.calls.filter((c) => c.tokensIn > LONG_CONTEXT).length);
    findings.push({
      id: 'long-context', title: 'Very long conversations', saving: usd,
      detail: `${calls} calls sent more than ${LONG_CONTEXT / 1000}k tokens of context. Capping the context at ${KEEP_CONTEXT / 1000}k would save up to ${money(usd)} (a ceiling: it counts only the cache reads above the cap).`,
      action: 'Run /compact when a task is done, or start a new session for a new task, so later calls carry less.',
      targets: longs.sort((a, b) => b.saving - a.saving).slice(0, 15).map((x) => x.path),
    });
  }

  // 5. Where the money went.
  const top = [...prompts].sort((a, b) => (b.p.usd || 0) - (a.p.usd || 0)).slice(0, 5);
  const topUsd = sum(top, (x) => x.p.usd);
  if (total > 0 && top.length >= 3) {
    findings.push({
      id: 'concentration', title: 'A few prompts carry the spend', saving: 0,
      detail: `The 5 most expensive prompts cost ${money(topUsd)}, ${Math.round((topUsd / total) * 100)}% of the ${money(total)} loaded. Start there.`,
      action: 'Open them and check the model, the context size and the cache hit.',
      targets: top.map((x) => x.path),
    });
  }

  const real = findings.filter((f) => f.id === 'concentration' || f.saving >= MIN_SAVING);
  real.sort((a, b) => b.saving - a.saving);
  return { total, findings: real, small: findings.filter((f) => !real.includes(f)).map((f) => f.title) };
}

module.exports = { advise, priceOf };
