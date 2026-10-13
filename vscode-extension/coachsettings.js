'use strict';
// The coach switches, stored where the hooks read them (~/.ai-cost-drilldown/config.json), through lib/coach.js,
// so the checkboxes and `/cost coach …` always agree. No VS Code dependency.
const path = require('path');
const { libDir } = require('./model');
const coach = require(path.join(libDir, 'coach.js'));

// Each switch: how lib/coach.js reads and writes it, the environment variable that overrides it, and what it does.
const SWITCHES = [
  { key: 'coach', label: 'Coach', env: 'AI_COST_COACH', get: coach.enabled, set: coach.setEnabled,
    help: 'A one-line tip when a prompt, or the session it is sent in, is about to cost more than it needs to.' },
  { key: 'strict', label: 'Strict mode', env: 'AI_COST_COACH_STRICT', get: coach.strict, set: coach.setStrict, needs: 'coach',
    help: 'Hold back a thin prompt with a banner instead of running it. Sending it again runs it as written. In VS Code chat it gives the tip instead.' },
  { key: 'expiry', label: 'Hold on every cache expiry', env: 'AI_COST_COACH_EXPIRY', get: coach.holdExpiry, set: coach.setHoldExpiry, needs: 'strict',
    help: 'Strict mode holds a prompt whenever the session\'s cache has expired (idle past the cache lifetime, in a session of 5 or more prompts), not only when the restart costs more than the cost limit. Off, an expiry under the limit is a tip.' },
  { key: 'rewrite', label: 'Strict model', env: 'AI_COST_COACH_REWRITE', get: coach.rewrite, set: coach.setRewrite, needs: 'strict',
    help: 'The strict banner also carries the prompt reworded by a small model. Each suggestion is a small model call, so it is off by default.' },
  { key: 'guard', label: 'Model guard', env: 'AI_COST_MODEL_GUARD', get: coach.modelGuard, set: coach.setModelGuard,
    help: 'While Copilot premium requests are on pace to run out, say which of your models cost the most requests a prompt and which cheaper one you already use. It only advises: no model is hidden or switched.' },
];

/** Current state of each switch. `locked` is true when an environment variable decides it, so a click would not stick. */
function read(env = process.env) {
  const state = {};
  for (const s of SWITCHES) state[s.key] = { on: s.get(env), locked: env[s.env] != null };
  return SWITCHES.map((s) => {
    const dep = s.needs && !state[s.needs].on;
    return { ...s, on: state[s.key].on, locked: state[s.key].locked, idle: Boolean(dep) };
  });
}

function write(key, on, env = process.env) {
  const s = SWITCHES.find((x) => x.key === key);
  if (!s) throw new Error(`unknown switch ${key}`);
  s.set(on, env);
}

// The thresholds the hook uses, and a pause for strict mode, saved next to the switches.
const LIMITS = [
  { key: 'costGateUsd', label: 'Cost limit', format: (v) => `$${v}`, help: 'Strict mode holds a prompt when its first model call, re-reading a session whose cache has expired, would cost at least this much. Needs Copilot tracking, whose token log gives the session\'s size.' },
  { key: 'longContextTokens', label: 'Long session (tokens)', format: (v) => `${Math.round(v / 1000)}k tokens`, help: 'A session is long once its context is this big, which every model call re-sends. Strict mode holds the next prompt, once per session. Needs Copilot tracking: its token log says how big the context is.' },
  { key: 'longSession', label: 'Long session (prompts)', format: (v) => `${v} prompts`, help: 'The same rule by prompt count, used when the token log has nothing for the session.' },
  { key: 'dailyPremium', label: 'Daily budget (premium requests)', format: (v) => (v > 0 ? `${v} a day` : 'automatic'), help: 'Copilot premium requests you allow yourself per day. Leave empty for automatic: what is left in the month, spread over the weekdays remaining (none at weekends). Strict mode holds the first prompt once today\'s use reaches the budget, once a day. Shown in the overview and the status bar against today\'s use.' },
  { key: 'bigPaste', label: 'Big paste', format: (v) => `${Number(v).toLocaleString()} characters`, help: 'Show a tip when a prompt carries this much pasted text, which is re-sent on every later call.' },
  { key: 'modelGuardRequests', label: 'Model guard: costly from', format: (v) => `${v} requests a prompt`, help: 'A model counts as costly for the model guard from this many premium requests a prompt, measured from your own prompts.' },
];

/** Each threshold with its value now and whether that is the default. */
function readLimits(env = process.env) {
  const now = coach.limits(env);
  return LIMITS.map((l) => ({ ...l, value: now[l.key], isDefault: now[l.key] === coach.DEFAULT_LIMITS[l.key] }));
}
/** The daily premium-request budget you set, or 0 for automatic. */
const dailyPremium = (env = process.env) => coach.limits(env).dailyPremium;
const writeLimit = (key, value, env = process.env) => coach.setLimit(key, value, env);

/** {until, active}: when a strict-mode pause ends. */
function readPause(env = process.env, now = Date.now()) {
  const until = coach.pausedUntil(env, now);
  return { until, active: until > 0 };
}
const writePause = (minutes, env = process.env, now = Date.now()) => coach.pauseStrict(minutes, env, now);

/** What the coach did over the last `days` days: per rule and in total. */
const readResults = (env = process.env, days = 30, now = Date.now()) => coach.results(env, now - days * 86400000);

/** The cache lifetime per model as the token log shows it: {model: {ttl, seen, wrong}}, with `usual` (the documented one) added. */
function readTtl(env = process.env, now = Date.now()) {
  const out = {};
  for (const [model, m] of Object.entries(coach.learnedTtl(env, now))) out[model] = { ...m, usual: coach.ttl(model) };
  return out;
}

/** The hook's failures over the last `hours` hours, oldest first: a prompt it failed on ran unchecked. */
const readErrors = (env = process.env, hours = 24, now = Date.now()) => coach.errors(env, now - hours * 3600e3);

module.exports = { SWITCHES, LIMITS, read, write, readLimits, dailyPremium, writeLimit, readPause, writePause, readResults, readErrors, readTtl };
