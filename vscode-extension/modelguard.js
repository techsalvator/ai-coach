'use strict';
// The model guard: while Copilot's premium requests are on pace to run out, say which of the models you use cost the most
// requests a prompt and which cheaper one you already use, until the pace is back. Pure decisions (plan) and a small
// state file (load, save) so the Copilot hook can read the same state later. It advises; it never switches a model.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Quota = require('./quota');

const RELEASE = 0.95;        // active until the month is projected under this share of the plan: no flapping at the line
const DEFAULT_THRESHOLD = 2; // requests a prompt at or over which a model counts as expensive

const dataDir = (env = process.env) => env.AI_COST_HOME || env.COPILOT_COST_HOME || path.join(os.homedir(), '.ai-cost-drilldown');
const stateFile = (env = process.env) => path.join(dataDir(env), 'model-guard.json');

/**
 * The guard's state now. q: the quota reading; sessions: loaded sessions (their prompts carry models and premium counts);
 * prev: the state kept from the last run; todayOver: today's use has reached the daily budget.
 * Active when the month is projected over the plan (at the last 7 days' pace when there is one, the month's otherwise) or
 * today is over budget, and stays active until the month is projected under 95% of the plan, or the period resets.
 */
function plan(q, sessions, { prev = null, now = Date.now(), todayOver = false, threshold = DEFAULT_THRESHOLD } = {}) {
  const pace = Quota.pace(q, now);
  if (!pace) return { active: false, reason: null, period: q && q.resets ? q.resets : null };
  const recent = Quota.recentPace(q, sessions, now);
  const projected = recent ? recent.projected : pace.projected;
  const same = Boolean(prev && prev.period === q.resets);
  const over = projected > q.entitlement;
  const holding = same && prev.active === true && projected > RELEASE * q.entitlement;
  const active = over || todayOver || holding;
  const seen = Quota.observed(sessions, now);
  const priced = Object.entries(seen).map(([model, v]) => ({ model, perPrompt: v.perPrompt, prompts: v.prompts }));
  const gated = priced.filter((m) => m.perPrompt >= threshold).sort((a, b) => b.perPrompt - a.perPrompt);
  // the cheaper model you already use most: one you have shown you can work with, not a guess from a price list
  const cheaper = priced.filter((m) => m.perPrompt < threshold).sort((a, b) => b.prompts - a.prompts)[0] || null;
  return {
    active,
    reason: !active ? null : over || (holding && !todayOver) ? 'month' : 'today',
    projected, entitlement: q.entitlement, period: q.resets,
    since: active ? (same && prev.active ? prev.since : now) : null,
    gated: active ? gated : [], suggest: active && gated.length ? cheaper : null, threshold,
  };
}

const num = (n) => Math.round(n * 10) / 10;

/** One sentence for a notification or tooltip, or '' when there is nothing to say. */
function describe(g) {
  if (!g || !g.active) return '';
  const why = g.reason === 'today'
    ? "Today's premium requests have reached the day's budget."
    : `This month is on pace for about ${g.projected.toLocaleString()} premium requests, over the ${g.entitlement.toLocaleString()} included.`;
  if (!g.gated.length) return why;
  const costly = g.gated.slice(0, 3).map((m) => `${m.model} (${num(m.perPrompt)} a prompt)`).join(', ');
  const cheap = g.suggest ? ` ${g.suggest.model} costs you about ${num(g.suggest.perPrompt)} a prompt${g.suggest.perPrompt === 0 ? ' (included)' : ''}: use it for routine work.` : '';
  return `${why} The costly models for you: ${costly}.${cheap}`;
}

function load(env = process.env) {
  try { return JSON.parse(fs.readFileSync(stateFile(env), 'utf8')); } catch { return null; }
}
function save(state, env = process.env) {
  try {
    fs.mkdirSync(dataDir(env), { recursive: true });
    const tmp = `${stateFile(env)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, stateFile(env));
  } catch { /* the guard is advice: never fail a sync over it */ }
}

module.exports = { plan, describe, load, save, stateFile, RELEASE, DEFAULT_THRESHOLD };
