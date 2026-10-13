'use strict';
// Copilot's premium-request quota for the month: Copilot CLI writes the plan's entitlement, the
// requests used and the reset date into its session log (quotaSnapshots.premium_interactions on
// model calls). The newest reading is the one to show.

const path = require('path');
const { libDir } = require('./model');
const { read, budget, stateDir } = require(path.join(libDir, 'premium.js'));

const fmt = (n) => String(Math.round(n * 10) / 10);

/** Where the month stands: days into the period, and the pace the month would end at. */
function pace(q, now = Date.now()) {
  if (!q || q.unlimited || q.stale || !q.resets || !(q.entitlement > 0)) return null;
  const end = Date.parse(q.resets);
  const d = new Date(end);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, d.getUTCDate());
  const total = (end - start) / 864e5;
  const elapsed = Math.max(0.5, (now - start) / 864e5);
  const projected = Math.round((q.used / elapsed) * total);
  const daysLeft = Math.max(0, Math.ceil((end - now) / 864e5));
  return { projected, daysLeft, over: projected > q.entitlement, exhaustsInDays: q.used > 0 ? Math.max(0, Math.floor((q.entitlement - q.used) / (q.used / elapsed))) : null };
}

/** One-line form for the status bar: { text, tip, over }, or null with no usable reading. */
function summary(q, now = Date.now(), { today = null, fixed = 0 } = {}) {
  if (!q || q.unlimited || q.stale || !(q.entitlement > 0)) return null;
  const left = Math.max(0, q.entitlement - q.used);
  const p = pace(q, now);
  const b = budget(q, now, { fixed, todayUsed: today || 0 });
  const resets = q.resets ? new Date(q.resets).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
  return {
    text: `Copilot ${left.toLocaleString()} left (${q.leftPct}%)${b && b.todayCounts ? ` · ${today == null ? '' : `${fmt(today)}/`}${b.perDay}/day` : ''}`,
    tip: `Copilot premium requests: ${left.toLocaleString()} of ${q.entitlement.toLocaleString()} left (${q.leftPct}%), resets ${resets}.${b ? ` Budget: ${b.fixed ? '' : 'about '}${b.perDay} a weekday${b.fixed ? ', your setting' : ''}; ${b.left.toLocaleString()} left for ${b.days} weekdays${today == null ? '' : `; ${fmt(today)} used today`}.` : ''}${p ? ` At this pace the month ends at about ${p.projected.toLocaleString()}.` : ''}`,
    over: !!(p && p.over) || !!(b && b.todayCounts && today != null && today > b.perDay),
  };
}

const DAY = 864e5;
const MIN_PROMPTS = 3; // prompts on a model before its cost per prompt is believed

/** Premium requests of one prompt, per model, from your own Copilot prompts: {model: {perPrompt, prompts}}. */
function observed(sessions, now = Date.now(), days = 30) {
  const by = new Map();
  for (const s of sessions || []) for (const p of s.prompts || []) {
    // A prompt that ran on one model only: its requests are that model's multiplier (times however many turns it took).
    if (p.premium == null || !p.models || p.models.length !== 1 || !(now - Date.parse(p.ts) <= days * DAY)) continue;
    if (!by.has(p.models[0])) by.set(p.models[0], []);
    by.get(p.models[0]).push(p.premium);
  }
  const out = {};
  for (const [model, xs] of by) {
    if (xs.length < MIN_PROMPTS) continue;
    xs.sort((a, b) => a - b);
    const mid = xs.length >> 1;
    out[model] = { perPrompt: Math.round((xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2) * 100) / 100, prompts: xs.length }; // the median: one long agent run is not the model's price
  }
  return out;
}

/**
 * What `room` premium requests buy, by model: [{model, perPrompt, prompts, count}], the models you use most first.
 * count is null for a model that costs nothing (it is included in the plan). With no usable history it falls back to
 * the usual multiplier tiers (0.33x, 1x, 3x), marked generic, because a model's multiplier is what GitHub sets.
 */
function capacity(room, seen, { max = 4 } = {}) {
  const rows = Object.entries(seen || {}).sort((a, b) => b[1].prompts - a[1].prompts).slice(0, max)
    .map(([model, v]) => ({ model, perPrompt: v.perPrompt, prompts: v.prompts, generic: false }));
  if (!rows.length) return [0.33, 1, 3].map((m) => ({ model: `a ${m}x model`, perPrompt: m, prompts: 0, generic: true, count: Math.floor(Math.max(0, room) / m) }));
  return rows.map((r) => ({ ...r, count: r.perPrompt > 0 ? Math.floor(Math.max(0, room) / r.perPrompt) : null }));
}

/**
 * The month's end if the last `days` days' pace continues, next to the month's own pace (pace()). This machine's prompts
 * set the rate and the account's reading sets where it starts, so a second machine makes it an underestimate.
 * Null with no reading, or no premium use in the window.
 */
function recentPace(q, sessions, now = Date.now(), days = 7) {
  const p = pace(q, now);
  if (!p) return null;
  let used = 0;
  for (const s of sessions || []) for (const x of s.prompts || []) {
    const age = now - Date.parse(x.ts);
    if (x.premium != null && age >= 0 && age <= days * DAY) used += x.premium;
  }
  if (!(used > 0)) return null;
  const perDay = used / days;
  const projected = Math.round(q.used + perDay * Math.max(0, (Date.parse(q.resets) - now) / DAY));
  // worth saying only when it is a different story from the month's pace
  const differs = Math.abs(projected - p.projected) >= Math.max(5, 0.1 * q.entitlement);
  return { perDay: Math.round(perDay * 10) / 10, projected, over: projected > q.entitlement, month: p.projected, differs, days };
}

module.exports = { read, pace, budget, summary, stateDir, observed, capacity, recentPace };
