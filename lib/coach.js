'use strict';
/**
 * Coaching tips at the moment a prompt is sent: one short line when the prompt, or the session it is sent in, is
 * about to cost more than it needs to. The rules are the live form of what `/cost advise` measures afterwards.
 *
 * A hook cannot show text to the user without stopping the prompt (and VS Code's chat shows nothing even then),
 * so the tip rides along as `additionalContext`: the model is told to print the line first and then answer as
 * usual. That costs the tip's few tokens, so tips are rare by design: at most one per prompt, and each kind once
 * per session (an expired cache: once an hour).
 *
 * Everything is local and cheap: the prompt text, and the tail of the session's own event log.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LONG_SESSION = 21;      // prompts; the same line `/cost advise` draws
const EXPIRY_MIN_PROMPTS = 5; // a short session has little cached context to lose
const BIG_PASTE = 12000;      // characters in one prompt (about 3k tokens)
const TAIL_BYTES = 1 << 20;
const RUNS_KEPT = 40;         // prompts remembered per session, to spot a repeat
const HOUR = 3600e3;

/** Seconds the provider keeps a prompt cache warm. */
const ttl = (model) => (/^(gpt|o\d)/i.test(String(model || '')) ? 1800 : 300);

const premium = require('./premium');
/** The user's home as node finds it (HOME, or USERPROFILE on Windows), read from `env`, as the other locations here follow their variables. */
const homeOf = (env = process.env) => (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
const copilotHome = (env = process.env) => env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
const aiCostHome = (env = process.env) => env.AI_COST_HOME || env.COPILOT_COST_HOME || path.join(os.homedir(), '.ai-cost-drilldown');
const configPath = (env) => path.join(aiCostHome(env), 'config.json');
const statePath = (env) => path.join(aiCostHome(env), 'coach-state.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
/** Written whole or not at all: a hook in another session reading it mid-write would see half a file and fall back to defaults. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(value, null, 2);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch { // Windows refuses to replace a file another process has open: write it in place
    try { fs.unlinkSync(tmp); } catch { /* never made */ }
    fs.writeFileSync(file, text);
  }
}

/** On unless switched off: AI_COST_COACH=0|off, or `/cost coach off` (config.json). */
function enabled(env = process.env) {
  if (env.AI_COST_COACH != null) return !/^(0|off|false|no)$/i.test(env.AI_COST_COACH);
  return readJson(configPath(env), {}).coach !== false;
}
function setEnabled(on, env = process.env) {
  writeJson(configPath(env), { ...readJson(configPath(env), {}), coach: !!on });
}

/** Strict mode (on unless switched off): a thin prompt is stopped with a banner instead of running with a tip. */
function strict(env = process.env, now = Date.now()) {
  if (env.AI_COST_COACH_STRICT != null) return !/^(0|off|false|no)$/i.test(env.AI_COST_COACH_STRICT);
  const c = readJson(configPath(env), {});
  return c.strict !== false && !(Number(c.strictPausedUntil) > now); // a pause lasts until its time, then strict mode is back
}
function setStrict(on, env = process.env) {
  writeJson(configPath(env), { ...readJson(configPath(env), {}), strict: !!on });
}

/**
 * Hold a prompt on every cache expiry in strict mode (on unless switched off: AI_COST_COACH_EXPIRY=0|off, or config.json).
 * Off, only an expiry whose restart costs at least the cost limit is held, and the rest is a tip.
 */
function holdExpiry(env = process.env) {
  if (env.AI_COST_COACH_EXPIRY != null) return !/^(0|off|false|no)$/i.test(env.AI_COST_COACH_EXPIRY);
  return readJson(configPath(env), {}).holdExpiry !== false;
}
function setHoldExpiry(on, env = process.env) {
  writeJson(configPath(env), { ...readJson(configPath(env), {}), holdExpiry: !!on });
}

/** The model guard (on unless switched off: AI_COST_MODEL_GUARD=0|off, or config.json): advice when premium requests run short. */
function modelGuard(env = process.env) {
  if (env.AI_COST_MODEL_GUARD != null) return !/^(0|off|false|no)$/i.test(env.AI_COST_MODEL_GUARD);
  return readJson(configPath(env), {}).modelGuard !== false;
}
function setModelGuard(on, env = process.env) {
  writeJson(configPath(env), { ...readJson(configPath(env), {}), modelGuard: !!on });
}

/** Rewrite suggestions (off unless switched on, because each one is a small model call): see lib/rewrite.js. */
function rewrite(env = process.env) {
  if (env.AI_COST_COACH_REWRITE != null) return /^(1|on|true|yes)$/i.test(env.AI_COST_COACH_REWRITE);
  return readJson(configPath(env), {}).rewrite === true;
}
function setRewrite(on, env = process.env) {
  writeJson(configPath(env), { ...readJson(configPath(env), {}), rewrite: !!on });
}

/** After a banner offered a rewrite, these mean "use it". */
const ACCEPT = /^\s*(y|yes|ok|okay|use it|use that|go)\s*[.!]*\s*$/i;

/** Follow-ups that leave the model guessing what failed. */
const VAGUE = /^(please\s+)?((try|do)\s+(it\s+)?again|retry|fix\s+(it|this|that)|(it'?s\s+|it\s+is\s+)?still\s+(not\s+working|broken|failing|wrong|the\s+same)|(it\s+)?(doesn'?t|does\s+not|didn'?t)\s+work|not\s+working|same\s+(error|issue|problem)|that'?s\s+wrong|wrong)(\s+please)?[\s.!]*$/i;

/**
 * What the session's log says, read incrementally: prompts so far (the one being sent is not in the log yet), and
 * when and with which model the last answer came. `seen` is the {offset, prompts} kept from the previous call.
 */
function sessionFacts(file, seen = {}) {
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  let { offset = 0, prompts = 0 } = seen;
  if (offset > size) { offset = 0; prompts = 0; } // the log was replaced
  const fd = fs.openSync(file, 'r');
  try {
    // A prompt is a line starting {"type":"user.message": count "\n" + that, from one byte before the offset
    // (the log is only appended to whole lines), plus the very first line of the file.
    const needle = Buffer.from('\n{"type":"user.message"');
    const buf = Buffer.alloc(1 << 20);
    let pos = Math.max(0, offset - 1);
    if (pos === 0) {
      const head = Buffer.alloc(needle.length - 1);
      fs.readSync(fd, head, 0, head.length, 0);
      if (head.equals(needle.subarray(1))) prompts++;
    }
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) break;
      const chunk = Buffer.concat([carry, buf.subarray(0, n)]);
      for (let i = chunk.indexOf(needle); i !== -1; i = chunk.indexOf(needle, i + 1)) prompts++;
      carry = Buffer.from(chunk.subarray(Math.max(0, chunk.length - (needle.length - 1)))); // too short to hold a whole match
      pos += n;
    }
    // the last answer: scan the tail backwards for an assistant.message
    const start = Math.max(0, size - TAIL_BYTES);
    const tail = Buffer.alloc(size - start);
    fs.readSync(fd, tail, 0, tail.length, start);
    let lastAt = null; let model = null;
    const lines = tail.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].startsWith('{"type":"assistant.message"')) continue;
      try {
        const e = JSON.parse(lines[i]);
        lastAt = Date.parse(e.timestamp); model = e.data && e.data.model;
        break;
      } catch { /* a line cut by the tail window */ }
    }
    return { offset: size, prompts, lastAt, model };
  } finally {
    fs.closeSync(fd);
  }
}

// --- settings you can tune, and a pause for strict mode (config.json, next to the on/off switches) ---

const DEFAULT_LIMITS = { costGateUsd: 0.5, longSession: LONG_SESSION, longContextTokens: 150000, bigPaste: BIG_PASTE, dailyPremium: 0, modelGuardRequests: 2 };

/** The thresholds in force (`dailyPremium` is 0 until set: the budget is then worked out from the quota): the defaults, or what config.json says. Anything that is not a positive number is ignored. */
function limits(env = process.env) {
  const c = readJson(configPath(env), {});
  const pick = (k) => (Number.isFinite(Number(c[k])) && Number(c[k]) > 0 ? Number(c[k]) : DEFAULT_LIMITS[k]);
  return { costGateUsd: pick('costGateUsd'), longSession: Math.round(pick('longSession')), longContextTokens: Math.round(pick('longContextTokens')), bigPaste: Math.round(pick('bigPaste')), dailyPremium: pick('dailyPremium'), modelGuardRequests: pick('modelGuardRequests') };
}
/** Sets one threshold; null puts the default back. */
function setLimit(key, value, env = process.env) {
  if (!(key in DEFAULT_LIMITS)) throw new Error(`unknown limit ${key}`);
  const c = readJson(configPath(env), {});
  if (value == null) delete c[key];
  else if (Number.isFinite(Number(value)) && Number(value) > 0) c[key] = Number(value);
  else throw new Error(`${key} must be a positive number`);
  writeJson(configPath(env), c);
}

/** When strict mode's pause ends (ms), or 0 when it is not paused. */
function pausedUntil(env = process.env, now = Date.now()) {
  const t = Number(readJson(configPath(env), {}).strictPausedUntil);
  return t > now ? t : 0;
}
/** Pauses strict mode for `minutes` (tips and banners stop holding prompts); null resumes it. */
function pauseStrict(minutes, env = process.env, now = Date.now()) {
  const c = readJson(configPath(env), {});
  if (minutes == null) delete c.strictPausedUntil;
  else c.strictPausedUntil = now + Number(minutes) * 60e3;
  writeJson(configPath(env), c);
}

// --- what a prompt will cost to start: the session's context, and whether its cache is still warm ---

let PRICES = null;
try { PRICES = require('./copilot-prices.json'); } catch { PRICES = null; }
const priceOf = (model) => (PRICES && PRICES.models[String(model).replace(/-(\d+)-(\d+)$/, '-$1.$2')]) || null;

/** The token log files, newest data last. */
function tokenLogFiles(env = process.env) {
  const explicit = env.AI_COST_TOKEN_LOG || env.COPILOT_COST_TOKEN_LOG;
  return explicit ? [explicit] : [path.join(aiCostHome(env), 'copilot-tokens.jsonl'), path.join(homeOf(env), '.phantomflow', 'logs', 'copilot-tokens.jsonl')];
}

/** A session's token records from the end of the log (the log only grows), oldest first. */
function tokenRecords(sessionId, env = process.env, maxBytes = 2 << 20) {
  const out = [];
  if (!sessionId) return out;
  for (const file of tokenLogFiles(env)) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      for (const l of buf.toString('utf8').split('\n')) {
        if (!l.includes(sessionId)) continue;
        try { const r = JSON.parse(l); if (r.session === sessionId) out.push(r); } catch { /* a line cut by the window */ }
      }
    } catch { /* no log: no estimate */ } finally { if (fd != null) fs.closeSync(fd); }
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

/**
 * The session's last main-agent call, from the small file the token logger keeps per session (extensions/ai-cost/record.mjs).
 * The shared log is read from its end, and with several busy sessions this session's last call can be further back than that.
 */
function lastCall(sessionId, env = process.env) {
  const r = readJson(path.join(aiCostHome(env), 'last-call', `${String(sessionId).replace(/[^\w.-]/g, '_')}.json`), null);
  return r && r.session === sessionId && r.input ? r : null;
}

// --- the cache lifetime, measured: the defaults in ttl() are what providers document, not what a plan or a model does ---

const DAY = 24 * HOUR;
const TTL_CHOICES = [300, 600, 1800, 3600]; // the lifetimes providers offer, in seconds: a measured one is one of these
const TTL_MIN_EVIDENCE = 5;                 // gaps that tell the choices apart, before a default is overruled
const ttlFile = (env) => path.join(aiCostHome(env), 'cache-ttl.json');

/**
 * The cache lifetime per model as token records show it: {model: {ttl, seen, wrong}}. Two main-agent calls in a row in one
 * session, on the same model, with the context not shrunk: the idle time between them, and whether the second read the
 * context from the cache or paid for it again. The lifetime is the choice that explains the most of those. A model is left
 * out (the default stands) when too few gaps tell the choices apart, or when no choice explains four in five.
 */
function measureTtl(records) {
  const bySession = new Map();
  for (const rec of records) {
    if (!rec || rec.sub || !rec.session || !rec.model) continue;
    if (!bySession.has(rec.session)) bySession.set(rec.session, []);
    bySession.get(rec.session).push(rec);
  }
  const seen = {}; // model -> [{idle (seconds), warm}]
  for (const list of bySession.values()) {
    list.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]; const cur = list[i];
      // A model switch or a compaction also starts cold, for another reason: not evidence about the lifetime.
      if (cur.model !== prev.model || !(prev.input > 5000) || cur.input < 0.8 * prev.input) continue;
      const idle = (Date.parse(cur.ts) - (cur.ms || 0) - Date.parse(prev.ts)) / 1000; // a record is written when its call ends
      if (!(idle > 60)) continue;
      const read = (cur.cacheRead || 0) / prev.input;
      if (read >= 0.5) (seen[cur.model] ||= []).push({ idle, warm: true });
      else if (read < 0.1) (seen[cur.model] ||= []).push({ idle, warm: false });
    }
  }
  const out = {};
  const lo = TTL_CHOICES[0]; const hi = TTL_CHOICES[TTL_CHOICES.length - 1];
  for (const [model, obs] of Object.entries(seen)) {
    // A warm read inside the shortest lifetime, or a cold one past the longest, fits every choice and decides nothing.
    if (obs.filter((o) => (o.warm ? o.idle > lo : o.idle < hi)).length < TTL_MIN_EVIDENCE) continue;
    const wrong = (t) => obs.filter((o) => (o.warm ? o.idle > t : o.idle < t)).length;
    const usual = ttl(model);
    const best = TTL_CHOICES.reduce((a, t) => (wrong(t) < wrong(a) || (wrong(t) === wrong(a) && t === usual) ? t : a));
    if (wrong(best) / obs.length <= 0.2) out[model] = { ttl: best, seen: obs.length, wrong: wrong(best) };
  }
  return out;
}

/** The measured lifetimes, worked out at most once a day from the end of the token log and kept in cache-ttl.json. */
function learnedTtl(env = process.env, now = Date.now()) {
  const kept = readJson(ttlFile(env), null);
  if (kept && kept.models && now >= kept.at && now - kept.at < DAY) return kept.models;
  const records = [];
  for (const file of tokenLogFiles(env)) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - (4 << 20));
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      for (const l of buf.toString('utf8').split('\n')) { try { records.push(JSON.parse(l)); } catch { /* a line cut by the window */ } }
    } catch { /* no log: nothing measured */ } finally { if (fd != null) fs.closeSync(fd); }
  }
  const models = measureTtl(records);
  try { writeJson(ttlFile(env), { at: now, models }); } catch { /* measured again next time */ }
  return models;
}

/** Dollars of one logged model call at GitHub's list prices, or null for a model without a price. */
function recordUsd(r) {
  const pr = priceOf(r.model);
  if (!pr) return null;
  const read = r.cacheRead || 0; const write = r.cacheWrite || 0;
  const fresh = Math.max(0, (r.input || 0) - read - write);
  return (fresh * pr.input + read * pr.cachedInput + write * (pr.cacheWrite ?? pr.input) + (r.output || 0) * pr.output) / 1e6;
}

/**
 * What the first model call of the next prompt will cost: the whole context is re-read, at the cheap cache-read price
 * while the cache is warm and at the cache-write price once it has expired. A floor, not the prompt's whole cost.
 * rec: the session's last main-agent call; lastAt: when the last answer came.
 */
function projectStart(rec, lastAt, now, ttlOf = ttl) {
  const pr = rec && priceOf(rec.model);
  if (!pr || !rec.input) return null;
  const idleMs = now - (lastAt || Date.parse(rec.ts));
  const cold = idleMs > ttlOf(rec.model) * 1000;
  const warm = (rec.input * pr.cachedInput) / 1e6;
  const full = (rec.input * (pr.cacheWrite ?? pr.input)) / 1e6;
  return { ctx: rec.input, model: rec.model, idleMs, cold, usd: cold ? full : warm, premium: cold ? full - warm : 0 };
}

/** What a run of a prompt cost: the session's calls between two moments. Null when the token log has nothing there. */
function costBetween(sessionId, fromMs, toMs, env = process.env) {
  const rs = tokenRecords(sessionId, env).filter((r) => Date.parse(r.ts) >= fromMs && Date.parse(r.ts) < toMs);
  const priced = rs.map(recordUsd).filter((x) => x != null);
  return priced.length ? priced.reduce((a, x) => a + x, 0) : null;
}

const usd = (x) => `$${x.toFixed(x < 10 ? 2 : 0)}`;
const ktok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);

// --- VS Code chat: a held prompt cannot show its banner there, so the extension shows it ---
//
// VS Code stops a prompt a hook blocks but never displays the hook's reason, so the hook only blocks in VS Code when the
// extension is running to show it. The extension proves that with a heartbeat file, and the hook leaves each held prompt (its
// banner and text) in a small folder the extension watches.

const heldDir = (env) => path.join(aiCostHome(env), 'held');
const notifierFile = (env) => path.join(aiCostHome(env), 'notifier.json');
const NOTIFIER_FRESH_MS = 45e3; // the extension touches its heartbeat every 15 seconds

/** True when an extension window has said, in the last 45 seconds, that it will show held prompts. */
function notifierAlive(env = process.env, now = Date.now()) {
  const t = Number(readJson(notifierFile(env), {}).ts);
  return Number.isFinite(t) && now - t < NOTIFIER_FRESH_MS && now - t > -5000;
}
const touchNotifier = (env = process.env, now = Date.now()) => writeJson(notifierFile(env), { ts: now });
function clearNotifier(env = process.env) { try { fs.unlinkSync(notifierFile(env)); } catch { /* none */ } }

/** Leaves a held prompt for the extension to show: {session, id, prompt, banner}. Best effort, and old ones are cleared. */
function writeHeld(env, record, now = Date.now()) {
  try {
    const dir = heldDir(env);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      const t = Number(f.split('-')[0]);
      if (now - t > 10 * 60e3) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* gone */ } }
    }
    fs.writeFileSync(path.join(dir, `${now}-${crypto.randomBytes(3).toString('hex')}.json`), JSON.stringify({ ts: now, ...record }));
  } catch { /* the prompt is held either way */ }
}

// --- what the coach did, and what you did next (coach-log.jsonl) ---

const logFile = (env) => path.join(aiCostHome(env), 'coach-log.jsonl');
/** One line per decision: a tip shown, a prompt held, and then whether it was sent anyway or changed. Best effort. */
function logEvent(env, now, e) {
  try {
    const file = logFile(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date(now).toISOString(), ...e })}\n`);
    if (fs.statSync(file).size > 2 << 20) { // keep it small: the last 2000 decisions
      fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8').trim().split('\n').slice(-2000).join('\n')}\n`);
    }
  } catch { /* never fail a prompt over a log */ }
}

const errorFile = (env) => path.join(aiCostHome(env), 'hook-errors.jsonl');
/** A hook never fails a prompt, so a failure is written down instead: otherwise a broken coach looks like a quiet one. */
function logError(err, env = process.env, now = Date.now()) {
  try {
    const file = errorFile(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stack = String((err && err.stack) || err).split('\n');
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date(now).toISOString(), error: stack[0], at: (stack[1] || '').trim() })}\n`);
    if (fs.statSync(file).size > 256 << 10) fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8').trim().split('\n').slice(-200).join('\n')}\n`);
  } catch { /* nowhere left to say it */ }
}
/** The hook's failures since a moment, oldest first: [{ts, error, at}]. */
function errors(env = process.env, sinceMs = 0) {
  let text = '';
  try { text = fs.readFileSync(errorFile(env), 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e && e.error && Date.parse(e.ts) >= sinceMs) out.push(e);
  }
  return out;
}

/**
 * Counts per rule since a moment: {id: {tips, held, reworded, sentAnyway, avoidedUsd, checked, right}}, plus the total.
 * checked: cold-cache warnings sent anyway whose next model call was looked at; right: those that did start cold.
 */
function results(env = process.env, sinceMs = 0) {
  const byId = {};
  let text = '';
  try { text = fs.readFileSync(logFile(env), 'utf8'); } catch { /* nothing yet */ }
  for (const l of text.split('\n')) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (!e.id || Date.parse(e.ts) < sinceMs) continue;
    const r = byId[e.id] || (byId[e.id] = { tips: 0, held: 0, reworded: 0, sentAnyway: 0, avoidedUsd: 0, checked: 0, right: 0 });
    if (e.event === 'tip') r.tips++;
    else if (e.event === 'held') r.held++;
    else if (e.event === 'reworded') { r.reworded++; r.avoidedUsd += e.avoidUsd || 0; }
    else if (e.event === 'sent-anyway') r.sentAnyway++;
    else if (e.event === 'checked') { r.checked++; if (e.right) r.right++; }
  }
  const total = { tips: 0, held: 0, reworded: 0, sentAnyway: 0, avoidedUsd: 0, checked: 0, right: 0 };
  for (const r of Object.values(byId)) for (const k of Object.keys(total)) total[k] += r[k];
  return { byId, total };
}

// --- prompt quality: is there enough here for the model to act without searching or guessing? ---

/** Something concrete to work on: a file or path, an identifier, a ticket, a link, quoted or pasted text. */
const TARGET = new RegExp([
  '[\\w-]+\\.[A-Za-z]{1,5}\\b',             // a file: cost.js, README.md
  '[\\w.-]+[\\\\/][\\w.-]+',                  // a path: lib/coach
  '`[^`]+`', '"[^"]{3,}"', "'[^']{3,}'",    // quoted code or text
  '\\b[a-z]+[A-Z]\\w*', '\\b\\w+_\\w+',       // camelCase, snake_case
  '\\b\\w+\\(\\)',                           // a call: run()
  '\\b[A-Z][A-Z0-9]+-\\d+\\b',               // a ticket: FOPTS-123
  '\\b\\w+-\\w+', '\\w: \\S', '\\b\\d+\\b', // kebab-case, "Error: text", a number (issue 3, port 8080)
  'https?://', '#\\d+', '\\n',             // a link, PR/issue, pasted lines
].join('|'));
const ACTION = /\b(fix|debug|solve|resolve|repair|improve|optimi[sz]e|refactor|clean\s*up|speed\s*up|rewrite|update|change|make)\b/i;
const PROBLEM = /\b(bugs?|errors?|exceptions?|issues?|problems?|fail(s|ed|ing|ure)?|crash(es|ed|ing)?|broken|not\s+working|doesn'?t\s+work)\b/i;
const GENERIC = /\b(things?|stuff|everything|the\s+(code|app|project|script|program|page|feature|function|logic))\b/i;
const PRONOUN = /\b(it|this|that)\b/i; // fine as a follow-up, empty as a session's first prompt
const QUESTION = /\?\s*$|^(what|why|how|which|where|when|who|is|are|can|could|does|do|did|should|explain|show|tell|list|describe)\b/i;
const words = (t) => t.split(/\s+/).filter(Boolean).length;
// A follow-up leans on what is already in the conversation: "still the same error", "the latest run", "yes, do it".
const POINTS_BACK = /\b(same|latest|last|recent|previous|earlier|above|still|again)\b/i;
const AFFIRMS = /^(yes|yeah|yep|ok(ay)?|sure|go ahead|do it|please do)\b[\s,.!]/i;
// A problem the agent finds by itself with one command: the tests, the linter, the build, the type checker, CI, a merge.
// "fix the failing tests" needs no error pasted; "getting an error on build" asks for nothing, so it is still thin.
const SELF_LOCATING = /\b(tests?|specs?|lint(er|ing)?|eslint|build|compil(e|er|ation)|type\s?check(s|er|ing)?|type\s+errors?|tsc|ci|pipeline|(merge\s+)?conflicts?)\b/i;

const TEMPLATE = 'In `<file or function>`, `<what is wrong or what you want>`. Error: `<the exact line>`. Expected: `<the result>`.';

/**
 * What a prompt is missing, or null: {id, text (one line, for a tip), why and template (for the strict banner)}.
 * first: the session's first prompt, where "it" and "this" refer to nothing.
 * Pattern checks only: they catch prompts that are plainly thin, never ones that are subtly unclear.
 */
function quality(prompt, { first = false } = {}) {
  const text = String(prompt || '').trim();
  if (!text) return null;
  if (VAGUE.test(text)) {
    return { id: 'vague-retry', why: 'a bare retry makes the model guess what failed',
      advice: 'Name the file, paste the exact error line, and say what you expected: one precise prompt usually costs less than several retries.',
      text: 'a short retry makes the model guess what failed. Name the file, paste the exact error line, and say what you expected: one precise prompt usually costs less than several retries.' };
  }
  const n = words(text);
  // Not the session's first prompt: it can lean on the conversation, so what it refers to is already there.
  const followUp = !first && (AFFIRMS.test(text) || POINTS_BACK.test(text));
  const generic = GENERIC.test(text) || (first && PRONOUN.test(text));
  const findable = ACTION.test(text) && SELF_LOCATING.test(text); // running the tests or the build says where and what
  if (!followUp && !findable && n <= 10 && !TARGET.test(text) && !QUESTION.test(text) && (PROBLEM.test(text) || (ACTION.test(text) && generic))) {
    return PROBLEM.test(text)
      ? { id: 'no-error-text', why: 'it mentions a problem but not where it is or what the error says, so the model has to go looking',
        advice: 'Name the file and paste the exact error line: the model can then fix it directly instead of searching, which is what makes a prompt expensive.',
        text: 'this prompt mentions a problem but not where it is or what the error says, so the model has to go looking. Name the file and paste the exact error line.' }
      : { id: 'no-target', why: 'it does not say what to work on, so the model has to search for it', template: 'In `<file, function or ticket>`, `<what to change>`, so that `<the result you want>`.',
        advice: 'Name the file, function or ticket, and the result you want: searching the project for it costs more than reading what you point at.',
        text: 'this prompt does not say what to work on, so the model has to search for it. Name the file, function or ticket, and the result you want.' };
  }
  if (n <= 40 && (text.match(/\balso\b/gi) || []).length >= 2) {
    return { id: 'multi-ask', why: 'it asks for several separate things at once',
      advice: 'One task per prompt is cheaper to run and easier to check: send the first, look at the result, then the next.', template: 'One task per prompt: send the first, check the result, then the next.',
      text: 'this prompt asks for several separate things. One task per prompt is cheaper to run and easier to check: send the first, then the next.' };
  }
  return null;
}

/** A suggestion with <placeholders> left is a template to fill in, not something to run as it stands. */
const hasBlanks = (text) => /<[^<>\n]{2,40}>/.test(String(text || ''));

/** The strict-mode banner shown instead of running the prompt. suggestion: {text, model, credits} from lib/rewrite.js. */
/** One line for a reason listed under "Also": why, and what to do about it. */
function reasonLine(t) {
  const why = `${t.why.charAt(0).toUpperCase()}${t.why.slice(1)}.`;
  const todo = t.advice || (t.actions && t.actions.join(' ')) || (t.repeat ? 'Reword it if the answer above was not what you wanted.' : '');
  return `- ${why}${todo ? ` ${todo}` : ''}`;
}

/** The banner shown in place of a held prompt: the headline reason, then any other reasons that also apply. */
function banner(q, suggestion, env = process.env) {
  const text = headline(q, suggestion, env);
  if (!q.also || !q.also.length) return text;
  const cut = text.lastIndexOf('\n\n_'); // the footer line
  const also = ['', `**Also:**`, ...q.also.map(reasonLine)].join('\n');
  return cut < 0 ? `${text}\n${also}` : `${text.slice(0, cut)}\n${also}${text.slice(cut)}`;
}

function headline(q, suggestion, env = process.env) {
  if (q.gate) {
    return [
      `**Prompt check (ai-cost-drilldown): not sent.** ${q.why.charAt(0).toUpperCase()}${q.why.slice(1)}.`,
      '',
      `That is about ${usd(q.est.usd)} for the first model call alone, ${usd(q.est.premium)} more than a warm one (estimated from the session's last call on ${q.est.model}).`,
      '',
      '- Run /compact first to shrink what is re-sent, or start a new session for a new topic.',
      '- Or send the same prompt again to run it as it is.',
      '',
      `_No model call, no AI credits. The limit is ${usd(limits(env).costGateUsd)}: change it, or turn this off, in VS Code's AI Cost view under Coach, or with /cost coach strict off_`,
    ].join('\n');
  }
  if (q.actions) { // a cache expiry, a long session or a big paste
    return [
      `**Prompt check (ai-cost-drilldown): not sent.** ${q.why.charAt(0).toUpperCase()}${q.why.slice(1)}.`,
      '',
      ...q.actions.map((a) => `- ${a}`),
      '- Or send the same prompt again to run it as it is.',
      '',
      `_No model call, no AI credits. Turn this off, or change the limits, in VS Code's AI Cost view under Coach, or with /cost coach strict off_`,
    ].join('\n');
  }
  if (q.repeat) {
    return [
      `**Prompt check (ai-cost-drilldown): not sent.** ${q.why.charAt(0).toUpperCase()}${q.why.slice(1)}.`,
      '',
      q.prevUsd != null ? `Its answer is already above in this session. That run cost about ${usd(q.prevUsd)}, and running it again repeats the cost.` : 'Its answer is already above in this session, and running it again repeats the cost.',
      '',
      '- To ask for something different, send a reworded prompt.',
      '- To run it again exactly as written, send the same prompt again.',
      '',
      '_No model call, no AI credits. Turn this off: /cost coach strict off_',
    ].join('\n');
  }
  const head = `**Prompt check (ai-cost-drilldown): not sent.** This prompt was held back because ${q.why}.${q.advice ? `\n\n**Tip:** ${q.advice}` : ''}`;
  if (suggestion) {
    const cost = suggestion.credits != null ? `${suggestion.credits.toFixed(2)} AI credits` : 'a small model call';
    return [
      head,
      '',
      'Suggested prompt:',
      `> ${suggestion.text}`,
      '',
      ...(hasBlanks(suggestion.text)
        ? ['- Fill in the parts in `<angle brackets>` and send it: the session did not say what they are.']
        : ['- Send **y** to run the suggestion.', '- Or send your own rewording.']),
      '- Or send the same prompt again to run it exactly as written.',
      '',
      `_The suggestion was written by ${suggestion.model} (${cost}). Turn suggestions off: /cost coach strict model off · turn the check off: /cost coach strict off_`,
    ].join('\n');
  }
  return [
    head,
    '',
    'Try it as:',
    `> ${q.template || TEMPLATE}`,
    '',
    'To run it exactly as written, send the same prompt again.',
    '',
    '_No model call, no AI credits. Turn this off: /cost coach strict off_',
  ].join('\n');
}

/** A short fingerprint of a prompt, so a repeat is found without keeping the text. */
const promptKey = (text) => crypto.createHash('sha1').update(String(text).replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);

/** Short answers ("yes", "continue", "y") are meant to be repeated; everything else is worth a second look. */
/** Prompts Copilot itself sends: its nudge to keep working until the task_complete tool is called, and system notices. */
const AUTOMATIC = /^\s*(<current_datetime>[^<]*<\/current_datetime>\s*)?(You have not yet marked the task as complete using the task_complete tool|<system_(notification|reminder)>)/i;

const repeatable = (text, skill) => Boolean(skill) || words(text) >= 3;

const mins = (ms) => { const m = Math.round(ms / 60e3); return m >= 120 ? `${Math.round(m / 60)} hours` : m < 1 ? 'under a minute' : `${m} minute${m === 1 ? '' : 's'}`; };

/** Every tip that applies, most valuable first: [{id, text, quality?}]. facts: sessionFacts() or null. */
/** The tip for a prompt that will start on a cold cache: how much it re-sends and what that costs. */
function gateTip(est) {
  const ago = mins(est.idleMs);
  return { id: 'cost-gate', gate: true, hold: true, est,
    why: `the session's cache expired ${ago} ago, so this prompt re-sends about ${ktok(est.ctx)} tokens at full price`,
    text: `this session's cache expired ${ago} ago, so this prompt re-sends about ${ktok(est.ctx)} tokens at full price: about ${usd(est.usd)} for the first model call alone, ${usd(est.premium)} more than if the cache were warm. Run /compact first, or start a new session for a new topic.` };
}

function evaluate(prompt, facts, now = Date.now(), { skill = false, lim = DEFAULT_LIMITS, est = null, holdExpiry = false, ctx = null, ttlOf = ttl } = {}) {
  const tips = [];
  const text = String(prompt || '').trim();
  // The cost gate comes first, and replaces the plainer cache tip: a skill is checked too, as it re-reads the same context.
  if (est && est.cold && est.usd >= lim.costGateUsd) tips.push(gateTip(est));
  else if (facts && facts.lastAt && facts.prompts >= EXPIRY_MIN_PROMPTS) {
    const idle = now - facts.lastAt;
    if (idle > ttlOf(facts.model) * 1000) {
      // Strict mode holds every expiry (unless that is switched off); the gate above is the one that comes with a price over the limit.
      const price = est && est.cold ? ` (about ${usd(est.usd)} for the first model call)` : '';
      tips.push({ id: 'cache-expired', expiry: true, actions: ['Run /compact first to shrink what is re-sent, or start a new session for a new topic.'], hold: Boolean(holdExpiry), est: est && est.cold ? est : null,
        why: `this session sat idle for ${mins(idle)}, so its cached context has expired and this prompt re-reads all ${facts.prompts} earlier prompts at full price${price}`,
        text: `this session sat idle for ${mins(idle)}, so its cached context has expired and this prompt re-reads all ${facts.prompts} earlier prompts at full price${price}. For a new topic, start a new session or run /compact first.` });
    }
  }
  // A long session is one whose context is big: by tokens when the token log says how big it is (a few big prompts cost more
  // than many small ones), by prompt count otherwise. Held once per session, as holding every later prompt would only nag.
  const bySize = ctx != null;
  if (bySize ? ctx >= lim.longContextTokens : facts && facts.prompts >= lim.longSession) {
    const warm = est ? est.usd - est.premium : null; // what each call costs to re-read it, even with a warm cache
    const what = bySize ? `this session's context is about ${ktok(ctx)} tokens${facts && facts.prompts ? ` (${facts.prompts} prompts)` : ''}` : `this session already holds ${facts.prompts} prompts`;
    const each = bySize && warm != null && warm >= 0.005 ? `, about ${usd(warm)} per call even with a warm cache` : '';
    tips.push({ id: 'long-session', hold: true, once: true, why: `${what}, and every model call re-sends ${bySize ? 'all of it' : 'them'}${each}`,
      actions: ['Start a new session for the next task, or run /compact first.'],
      text: `${what}, and every model call re-sends ${bySize ? 'all of it' : 'them'}${each}. Start a new session for the next task, or run /compact.` });
  }
  if (!skill) {
    if (text.length >= lim.bigPaste) {
      tips.push({ id: 'big-paste', hold: true, why: `this prompt carries about ${Math.round(text.length / 4000)}k tokens of pasted text, which is re-sent on every later call in this session`,
        actions: ['Save the paste to a file and name its path in the prompt: the path costs a few tokens, the paste is re-sent on every later call.'],
        text: `this prompt carries about ${Math.round(text.length / 4000)}k tokens of pasted text, which is re-sent on every later call in this session. Next time save it to a file and name the path.` });
    } else {
      const q = quality(text, { first: !facts || !facts.prompts });
      if (q) tips.push({ ...q, quality: true });
    }
  }
  return tips;
}

/** The tip for a prompt already run in this session: what it was, and that running it again repeats its cost. */
function repeatTip(ageMs) {
  const ago = mins(ageMs);
  return { id: 'repeat', repeat: true, hold: true, why: `you already ran this exact prompt ${ago} ago in this session`,
    text: `you sent this exact prompt ${ago} ago in this session, and its answer is already above. Running it again repeats that cost: scroll up, or reword it if the answer was not what you wanted.` };
}

const dayKey = (now) => { const d = new Date(now); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

/**
 * The tip for going over the day's premium-request budget: the limit `dailyPremium` when you set one, otherwise what
 * the month has left spread over the weekdays remaining (worked out once a day, so it does not shrink as the day's use
 * grows; none on a weekend, or with no quota reading). Today's use is what this machine's Copilot sessions used since
 * midnight, from the running totals in their logs. Held once a day.
 */
function dailyBudget(state, env, now) {
  const day = dayKey(now);
  const used = premium.usedToday(env, now);
  let b = state.budget;
  if (!b || b.day !== day || 'base' in b) { // a new day (or the state of an older version, which counted differently)
    const q = premium.read(env, now);
    const auto = q ? premium.budget(q, now, { todayUsed: used }) : null;
    b = state.budget = { day, auto: auto && auto.todayCounts ? auto.perDay : 0 };
  }
  const budget = limits(env).dailyPremium || b.auto;
  if (!(budget > 0) || used < budget) return null;
  const why = `you have used ${used} of today's ${budget} premium requests`;
  return { id: 'daily-budget', daily: true, day, hold: true, why,
    actions: ['Pick a model with a lower premium multiplier for routine prompts (/model), or leave the rest for tomorrow.'],
    text: `${why}. Pick a model with a lower premium multiplier for routine prompts, or leave the rest for tomorrow.` };
}

const REPEAT_AFTER = { 'cache-expired': HOUR, 'cost-gate': HOUR, repeat: 1 }; // a repeat is mentioned every time
const COLD = ['cost-gate', 'cache-expired']; // holds on the session's cache, which rewording the prompt does not change
const LEFT_AFTER = 24 * HOUR;                // a held session with no prompt for this long was left for a new one

/**
 * The tip for this prompt, or null. Reads and updates the per-session state (what was already shown).
 * input: {prompt, sessionId, skill, canBlock}; o: {env, now}.
 *
 * In strict mode, where the caller can stop a prompt (canBlock), a thin prompt comes back as {..., block: true}
 * every time, not once per session; sending the very same prompt again lets it through.
 */
function tipFor(input, o = {}) {
  const env = o.env || process.env;
  const now = o.now || Date.now();
  if (!enabled(env)) return null;
  // Nor the prompts Copilot sends by itself (the nudge to keep going until task_complete is called, system notices): nobody
  // typed them, and holding one only stalls the agent. They leave no trace in the state either.
  if (AUTOMATIC.test(String(input.prompt || ''))) return null;
  const id = String(input.sessionId || '');
  const state = readJson(statePath(env), { sessions: {} });
  if (!state.sessions) state.sessions = {};
  const s = state.sessions[id || '(none)'] || { shown: {} };
  const facts = id ? sessionFacts(path.join(copilotHome(env), 'session-state', id, 'events.jsonl'), s) : null;
  if (facts) { s.offset = facts.offset; s.prompts = facts.prompts; }
  // What the session's context is worth to re-read, from its last main-agent call in the token log (only when the logger ran).
  const rec = id ? lastCall(id, env) || tokenRecords(id, env).reverse().find((r) => !r.sub) : null;
  // The commands that shrink or reset the context are what the banner recommends: never hold those.
  const manages = /^\s*\/(compact|clear|new)\b/i.test(String(input.prompt || ''));
  // The cache lifetime as this machine's token log shows it, where it shows enough; the documented one otherwise.
  const measured = rec || (facts && facts.lastAt) ? learnedTtl(env, now) : {};
  const ttlOf = (m) => (measured[m] && measured[m].ttl) || ttl(m);
  // A cold-cache warning that was sent anyway: the first call after it says whether the cache really was cold.
  if (s.verify) {
    const next = tokenRecords(id, env).find((x) => !x.sub && Date.parse(x.ts) > s.verify.at);
    if (next) { logEvent(env, now, { event: 'checked', session: id, id: s.verify.id, right: (next.cacheRead || 0) < 0.5 * s.verify.ctx }); delete s.verify; }
    else if (now - s.verify.at > DAY) delete s.verify; // the token log never saw it
  }
  const est = rec ? projectStart(rec, facts && facts.lastAt, now, ttlOf) : null;
  const all = manages ? [] : evaluate(input.prompt, facts, now, { skill: input.skill, lim: limits(env), est, holdExpiry: holdExpiry(env), ctx: rec ? rec.input : null, ttlOf });
  // The daily premium-request budget, when you set one: once today's use reaches it, the first prompt is held.
  const spent = manages ? null : dailyBudget(state, env, now);
  if (spent) all.push(spent);
  const text = String(input.prompt || '').trim();
  const key = promptKey(text);
  const prior = repeatable(text, input.skill) && (s.runs || []).find((r) => r.k === key);
  // A thin prompt already has its own check (held every time in strict mode), so a repeat is for prompts that pass it.
  if (prior && !all.some((t) => t.quality)) {
    const again = repeatTip(now - prior.at);
    const next = Math.min(now, ...(s.runs || []).map((r) => r.at).filter((at) => at > prior.at));
    again.prevUsd = id ? costBetween(id, prior.at, next, env) : null; // what that run cost, when the token log saw it
    all.unshift(again);
  }
  // Remember a prompt only once it is going to run (a held one has not run yet).
  const remember = () => { s.runs = [...(s.runs || []).filter((r) => r.k !== key), { k: key, at: now }].slice(-RUNS_KEPT); };
  const save = () => {
    s.at = now;
    // Other sessions' hooks may have saved since this one read the file: put this session into what is there now, not over it.
    const disk = readJson(statePath(env), { sessions: {} });
    state.sessions = { ...(disk.sessions || {}), [id || '(none)']: s };
    for (const [k, v] of Object.entries(state.sessions)) {
      if (now - (v.at || 0) > 30 * 24 * HOUR) { delete state.sessions[k]; continue; }
      // A session left alone for a day after a cold-cache hold: the work went to a new session, which is what the banner asks for.
      if (v.heldInfo && COLD.includes(v.heldInfo.id) && now - (v.at || 0) > LEFT_AFTER) {
        logEvent(env, now, { event: 'reworded', left: true, session: k === '(none)' ? '' : k, id: v.heldInfo.id, avoidUsd: v.heldInfo.avoidUsd });
        delete v.heldInfo; delete v.held;
      }
    }
    try { writeJson(statePath(env), state); } catch { /* a tip may repeat; never fail the prompt */ }
  };
  // What became of the last held prompt: sent again as it was, or changed.
  const settle = (outcome) => {
    if (!s.heldInfo) return;
    logEvent(env, now, { event: outcome, session: id, id: s.heldInfo.id, avoidUsd: outcome === 'reworded' ? s.heldInfo.avoidUsd : 0 });
    delete s.heldInfo;
  };
  // The first thing strict mode can hold: a thin prompt (held every time, a bare retry included), a repeat, a cold cache,
  // a long session (once per session) or a big paste.
  // Every reason that applies, in order (one already held this session is skipped): the first is the headline and the rest are
  // listed in the same banner, so sending the prompt again never runs it past a reason that was not shown.
  const reasons = all.filter((t) => (t.quality || t.hold) && !(t.once && t.id in s.shown) && !(t.daily && state.budget && state.budget.heldDay === t.day));
  const thin = reasons[0];
  const holdable = Boolean(thin);
  // A rewrite was offered with the last banner: "y" runs it in place of this prompt.
  if (input.canBlock && s.suggestion) {
    const use = s.suggestion;
    delete s.suggestion;
    if (ACCEPT.test(String(input.prompt || ''))) { settle('reworded'); delete s.held; save(); return { use }; }
  }
  if (input.canBlock && strict(env, now) && (holdable || s.held)) {
    const resent = s.held === text;
    // A cold cache is the session's state, not the prompt's: a different prompt does not escape it. While it still applies,
    // the new prompt is the same hold carried over, not a change that avoided anything (and not a second hold either).
    const carried = Boolean(s.held && !resent && s.heldInfo && COLD.includes(s.heldInfo.id) && reasons.some((r) => r.gate || r.expiry));
    // Sent again as it was, and still held-worthy: sent anyway. Changed, or no longer held-worthy (say, after /compact): it avoided the hold.
    if (s.held && !carried) {
      const outcome = resent && holdable ? 'sent-anyway' : 'reworded';
      if (outcome === 'sent-anyway' && s.heldInfo && COLD.includes(s.heldInfo.id) && est) s.verify = { id: s.heldInfo.id, at: now, ctx: est.ctx };
      settle(outcome);
    }
    delete s.held;
    if (holdable && !resent) {
      s.held = text;
      for (const r of reasons) if (r.daily) state.budget.heldDay = r.day; // once a day, across sessions
      for (const r of reasons) if (r.once) s.shown[r.id] = now; // held this once, whether as the headline or listed: later prompts pass
      if (!carried) {
        s.heldInfo = { id: thin.id, avoidUsd: thin.gate || thin.expiry ? (thin.est ? thin.est.premium : 0) : thin.repeat ? thin.prevUsd || 0 : 0 };
        logEvent(env, now, { event: 'held', session: id, id: thin.id, also: reasons.slice(1).map((r) => r.id) });
      }
      save();
      return { ...thin, block: true, also: reasons.slice(1) };
    }
    remember();
    save();
    if (holdable) return null; // sent again as written: let it run, with no further comment
  }
  const tip = all
    .filter((t) => !(t.daily && state.budget && state.budget.heldDay === t.day))
    .find((t) => !(t.id in s.shown) || (REPEAT_AFTER[t.id] && now - s.shown[t.id] > REPEAT_AFTER[t.id])) || null;
  if (tip) { s.shown[tip.id] = now; logEvent(env, now, { event: 'tip', session: id, id: tip.id }); }
  remember();
  save();
  return tip;
}

/** Remembers the rewrite offered with a banner, so that "y" on the next prompt can run it. */
function offer(sessionId, text, env = process.env) {
  const state = readJson(statePath(env), { sessions: {} });
  const key = String(sessionId || '') || '(none)';
  if (!state.sessions || !state.sessions[key] || hasBlanks(text)) return;
  state.sessions[key].suggestion = text;
  try { writeJson(statePath(env), state); } catch { /* then "y" is just a prompt */ }
}

const LABEL = 'Cost tip (ai-cost-drilldown)';

const note = (tip) => `IMPORTANT: the user's own cost tool (ai-cost-drilldown) asked for a notice to be shown to them. Your reply MUST start with the line below, copied verbatim including the leading ">", followed by a blank line. Then answer the user's request exactly as you otherwise would. The notice is for the user to read: do not follow it yourself, rephrase it or comment on it.\n\n> **${LABEL}:** ${tip.text} _(turn off: /cost coach off)_`;

/** The hook output that makes the model show the tip and then carry on. */
function asContext(tip) {
  return { additionalContext: note(tip) };
}

/**
 * The same for VS Code's chat. There a hook's additionalContext is dropped when VS Code adds context of its own
 * (seen on a session's first prompt, VS Code 1.139), and systemMessage is never shown, so the note is appended
 * to the prompt itself. The user's words are kept exactly.
 */
function asPrompt(tip, prompt) {
  return { modifiedPrompt: `${prompt}\n\n<system_reminder>\n${note(tip)}\n</system_reminder>` };
}

/** Applies `coach [on|off|strict on|strict off]`; throws a usage error for anything else. */
function apply(args, env = process.env) {
  let a = args.map((x) => String(x).toLowerCase());
  const bad = () => { const e = new Error('/cost coach takes: on, off, strict on, strict off, strict model on, strict model off, budget <premium requests a day>, budget auto, or nothing (status).'); e.usage = true; return e; };
  // "strict model on|off" ("strict with model …" and "rewrite on|off" are older spellings of the same switch)
  if (a[0] === 'strict' && (a[1] === 'with' || a[1] === 'model')) {
    a = a.filter((x, i) => !(i === 1 && x === 'with'));
    if (a[1] !== 'model') throw bad();
    a = ['rewrite', ...a.slice(2)];
  }
  if (!a.length || a[0] === 'status') return;
  if (a[0] === 'strict') {
    if (a.length === 1) return;
    if (a[1] !== 'on' && a[1] !== 'off') throw bad();
    setStrict(a[1] === 'on', env);
    if (a[1] === 'on') setEnabled(true, env); // strict is a way of coaching: it needs coaching on
  } else if (a[0] === 'rewrite') {
    if (a.length === 1) return;
    if (a[1] !== 'on' && a[1] !== 'off') throw bad();
    setRewrite(a[1] === 'on', env);
    if (a[1] === 'on') { setEnabled(true, env); setStrict(true, env); } // a suggestion comes with a held prompt
  } else if (a[0] === 'budget') {
    if (a.length === 1) return;
    if (a.length !== 2) throw bad();
    if (a[1] === 'auto') setLimit('dailyPremium', null, env);
    else if (Number.isFinite(Number(a[1])) && Number(a[1]) > 0) setLimit('dailyPremium', Number(a[1]), env);
    else throw bad();
  } else if (a[0] === 'on' || a[0] === 'off') setEnabled(a[0] === 'on', env);
  else throw bad();
}

/** One line: what is on. */
function statusLine(env = process.env) {
  const on = enabled(env);
  const st = on && strict(env);
  return `Cost tips (ai-cost-drilldown) are ${on ? 'on' : 'off'}; strict mode is ${st ? 'on' : 'off'}; strict model is ${st && rewrite(env) ? 'on' : 'off'}.`;
}

/** The daily premium-request budget, in words: the number you set, or the automatic figure. */
function budgetLine(env = process.env, now = Date.now()) {
  const set = limits(env).dailyPremium;
  if (set > 0) return `Daily budget: **${set}** premium requests (yours; \`/cost coach budget auto\` goes back to the automatic one).`;
  const q = premium.read(env, now);
  const b = q && premium.budget(q, now);
  return b && b.todayCounts
    ? `Daily budget: **automatic**, about ${b.perDay} premium requests today (${b.left.toLocaleString()} left over ${b.days} weekdays). \`/cost coach budget <n>\` sets your own.`
    : 'Daily budget: **automatic** (none today: no quota reading yet, a weekend, or an unlimited plan). `/cost coach budget <n>` sets your own.';
}

/** `/cost coach [on|off|strict on|strict off|strict model on|strict model off|budget <n>|budget auto]`. */
function command(args, env = process.env) {
  apply(args, env);
  const on = enabled(env);
  const st = on && strict(env);
  const rw = st && rewrite(env);
  return [
    `Cost tips are **${on ? 'on' : 'off'}**${env.AI_COST_COACH != null ? ' (set by AI_COST_COACH)' : ''}. Strict mode is **${st ? 'on' : 'off'}**. Strict model is **${rw ? 'on' : 'off'}**.`,
    '',
    'When on, a prompt that is about to cost more than it needs to gets one line of advice at the top of the answer:',
    `- the session was idle past the cache lifetime (5 minutes for Claude models, 30 for GPT, or what your token log shows it to be) after ${EXPIRY_MIN_PROMPTS}+ prompts`,
    `- the session's cache expired (idle past the cache lifetime): strict mode holds the prompt on every expiry, or only when re-sending its context would cost ${usd(limits(env).costGateUsd)}+ with the Coach switch off (that price needs the token logger from Copilot tracking)`,
    `- the session is long: its context is ${ktok(limits(env).longContextTokens)}+ tokens (when the token logger runs), else it holds ${limits(env).longSession}+ prompts`,
    `- the prompt pastes ${limits(env).bigPaste / 1000}k+ characters`,
    '- the prompt repeats one already run in this session',
    '- today\'s premium requests have reached the daily budget (once a day)',
    '- the prompt is thin: a bare retry ("try again"), no file, function or ticket named ("fix the bug"), a problem with no error text, or several asks in one',
    '',
    'Each kind shows once per session (an expired cache: at most once an hour). The tip is passed to the model with the prompt, so it costs a few dozen tokens when it appears and nothing otherwise.',
    '',
    'Strict mode (Copilot CLI): a thin prompt (a bare retry included, every time), a repeat, a cache expiry, a long session (once) or a big paste is not sent. A banner says what to do; sending the same prompt again runs it as written. No model call, no credits. In VS Code\'s chat a stopped prompt shows nothing, so strict mode gives the tip there instead.',
    '',
    `Strict model: the banner also carries the prompt rewritten by a small model (${require('./rewrite').DEFAULT_MODEL}, or AI_COST_REWRITE_MODEL), using the last few prompts, the last answer and the last failed tool call of the session to fill in what "it" and "the error" mean. Send y to run the suggestion. Each suggestion is one small model call (roughly 0.05 to 0.3 AI credits, a few seconds), logged in rewrites.jsonl.`,
    budgetLine(env),
    '',
    `Switch: \`/cost coach ${on ? 'off' : 'on'}\` · \`/cost coach strict ${st ? 'off' : 'on'}\` · \`/cost coach strict model ${rw ? 'off' : 'on'}\`.`,
  ].join('\n');
}

module.exports = { modelGuard, setModelGuard, measureTtl, learnedTtl, lastCall, logError, errors, heldDir, notifierFile, notifierAlive, touchNotifier, clearNotifier, writeHeld, NOTIFIER_FRESH_MS, ktok, holdExpiry, setHoldExpiry, DEFAULT_LIMITS, limits, setLimit, pausedUntil, pauseStrict, results, projectStart, tokenRecords, costBetween, recordUsd, gateTip, quality, banner, strict, setStrict, rewrite, setRewrite, offer, hasBlanks, ACCEPT, apply, statusLine, evaluate, tipFor, sessionFacts, asContext, asPrompt, command, enabled, setEnabled, ttl, VAGUE, LABEL };
