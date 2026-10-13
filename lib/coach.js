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

const fs = require('fs');
const os = require('os');
const path = require('path');

const LONG_SESSION = 21;      // prompts; the same line `/cost advise` draws
const EXPIRY_MIN_PROMPTS = 5; // a short session has little cached context to lose
const BIG_PASTE = 12000;      // characters in one prompt (about 3k tokens)
const TAIL_BYTES = 1 << 20;
const HOUR = 3600e3;

/** Seconds the provider keeps a prompt cache warm. */
const ttl = (model) => (/^(gpt|o\d)/i.test(String(model || '')) ? 1800 : 300);

const copilotHome = (env = process.env) => env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
const aiCostHome = (env = process.env) => env.AI_COST_HOME || env.COPILOT_COST_HOME || path.join(os.homedir(), '.ai-cost-drilldown');
const configPath = (env) => path.join(aiCostHome(env), 'config.json');
const statePath = (env) => path.join(aiCostHome(env), 'coach-state.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
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
function strict(env = process.env) {
  if (env.AI_COST_COACH_STRICT != null) return !/^(0|off|false|no)$/i.test(env.AI_COST_COACH_STRICT);
  return readJson(configPath(env), {}).strict !== false;
}
function setStrict(on, env = process.env) {
  writeJson(configPath(env), { ...readJson(configPath(env), {}), strict: !!on });
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
      text: 'a short retry makes the model guess what failed. Name the file, paste the exact error line, and say what you expected: one precise prompt usually costs less than several retries.' };
  }
  const n = words(text);
  const generic = GENERIC.test(text) || (first && PRONOUN.test(text));
  if (n <= 10 && !TARGET.test(text) && !QUESTION.test(text) && (PROBLEM.test(text) || (ACTION.test(text) && generic))) {
    return PROBLEM.test(text)
      ? { id: 'no-error-text', why: 'it mentions a problem but not where it is or what the error says, so the model has to go looking',
        text: 'this prompt mentions a problem but not where it is or what the error says, so the model has to go looking. Name the file and paste the exact error line.' }
      : { id: 'no-target', why: 'it does not say what to work on, so the model has to search for it',
        text: 'this prompt does not say what to work on, so the model has to search for it. Name the file, function or ticket, and the result you want.' };
  }
  if (n <= 40 && (text.match(/\balso\b/gi) || []).length >= 2) {
    return { id: 'multi-ask', why: 'it asks for several separate things at once', template: 'One task per prompt: send the first, check the result, then the next.',
      text: 'this prompt asks for several separate things. One task per prompt is cheaper to run and easier to check: send the first, then the next.' };
  }
  return null;
}

/** A suggestion with <placeholders> left is a template to fill in, not something to run as it stands. */
const hasBlanks = (text) => /<[^<>\n]{2,40}>/.test(String(text || ''));

/** The strict-mode banner shown instead of running the prompt. suggestion: {text, model, credits} from lib/rewrite.js. */
function banner(q, suggestion) {
  const head = `**Prompt check (ai-cost-drilldown): not sent.** This prompt was held back because ${q.why}.`;
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

const mins = (ms) => { const m = Math.round(ms / 60e3); return m >= 120 ? `${Math.round(m / 60)} hours` : `${m} minutes`; };

/** Every tip that applies, most valuable first: [{id, text, quality?}]. facts: sessionFacts() or null. */
function evaluate(prompt, facts, now = Date.now(), { skill = false } = {}) {
  const tips = [];
  const text = String(prompt || '').trim();
  if (facts && facts.lastAt && facts.prompts >= EXPIRY_MIN_PROMPTS) {
    const idle = now - facts.lastAt;
    if (idle > ttl(facts.model) * 1000) {
      tips.push({ id: 'cache-expired', text: `this session sat idle for ${mins(idle)}, so its cached context has expired and this prompt re-reads all ${facts.prompts} earlier prompts at full price. For a new topic, start a new session or run /compact first.` });
    }
  }
  if (facts && facts.prompts >= LONG_SESSION) {
    tips.push({ id: 'long-session', text: `this session already holds ${facts.prompts} prompts, and every model call re-sends them. Start a new session for the next task, or run /compact.` });
  }
  if (!skill) {
    if (text.length >= BIG_PASTE) {
      tips.push({ id: 'big-paste', text: `this prompt carries about ${Math.round(text.length / 4000)}k tokens of pasted text, which is re-sent on every later call in this session. Next time save it to a file and name the path.` });
    } else {
      const q = quality(text, { first: !facts || !facts.prompts });
      if (q) tips.push({ ...q, quality: true });
    }
  }
  return tips;
}

const REPEAT_AFTER = { 'cache-expired': HOUR };

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
  const id = String(input.sessionId || '');
  const state = readJson(statePath(env), { sessions: {} });
  if (!state.sessions) state.sessions = {};
  const s = state.sessions[id || '(none)'] || { shown: {} };
  const facts = id ? sessionFacts(path.join(copilotHome(env), 'session-state', id, 'events.jsonl'), s) : null;
  if (facts) { s.offset = facts.offset; s.prompts = facts.prompts; }
  const all = evaluate(input.prompt, facts, now, { skill: input.skill });
  const save = () => {
    s.at = now;
    state.sessions[id || '(none)'] = s;
    try { writeJson(statePath(env), state); } catch { /* a tip may repeat; never fail the prompt */ }
  };
  const thin = all.find((t) => t.quality);
  // A rewrite was offered with the last banner: "y" runs it in place of this prompt.
  if (input.canBlock && s.suggestion) {
    const use = s.suggestion;
    delete s.suggestion;
    if (ACCEPT.test(String(input.prompt || ''))) { delete s.held; save(); return { use }; }
  }
  if (input.canBlock && strict(env) && (thin || s.held)) {
    const text = String(input.prompt || '').trim();
    const resent = s.held === text;
    delete s.held;
    if (thin && !resent) { s.held = text; save(); return { ...thin, block: true }; }
    save();
    if (thin) return null; // sent again as written: let it run, with no further comment
  }
  const tip = all
    .find((t) => !(t.id in s.shown) || (REPEAT_AFTER[t.id] && now - s.shown[t.id] > REPEAT_AFTER[t.id])) || null;
  if (tip) s.shown[tip.id] = now;
  s.at = now;
  state.sessions[id || '(none)'] = s;
  for (const [k, v] of Object.entries(state.sessions)) if (now - (v.at || 0) > 30 * 24 * HOUR) delete state.sessions[k];
  try { writeJson(statePath(env), state); } catch { /* a tip may repeat; never fail the prompt */ }
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
  const bad = () => { const e = new Error('/cost coach takes: on, off, strict on, strict off, strict model on, strict model off, or nothing (status).'); e.usage = true; return e; };
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
  } else if (a[0] === 'on' || a[0] === 'off') setEnabled(a[0] === 'on', env);
  else throw bad();
}

/** One line: what is on. */
function statusLine(env = process.env) {
  const on = enabled(env);
  const st = on && strict(env);
  return `Cost tips (ai-cost-drilldown) are ${on ? 'on' : 'off'}; strict mode is ${st ? 'on' : 'off'}; strict model is ${st && rewrite(env) ? 'on' : 'off'}.`;
}

/** `/cost coach [on|off|strict on|strict off|strict model on|strict model off]`. */
function command(args, env = process.env) {
  apply(args, env);
  const on = enabled(env);
  const st = on && strict(env);
  const rw = st && rewrite(env);
  return [
    `Cost tips are **${on ? 'on' : 'off'}**${env.AI_COST_COACH != null ? ' (set by AI_COST_COACH)' : ''}. Strict mode is **${st ? 'on' : 'off'}**. Strict model is **${rw ? 'on' : 'off'}**.`,
    '',
    'When on, a prompt that is about to cost more than it needs to gets one line of advice at the top of the answer:',
    `- the session was idle past the cache lifetime (5 minutes for Claude models, 30 for GPT) after ${EXPIRY_MIN_PROMPTS}+ prompts`,
    `- the session holds ${LONG_SESSION}+ prompts`,
    `- the prompt pastes ${BIG_PASTE / 1000}k+ characters`,
    '- the prompt is thin: a bare retry ("try again"), no file, function or ticket named ("fix the bug"), a problem with no error text, or several asks in one',
    '',
    'Each kind shows once per session (an expired cache: at most once an hour). The tip is passed to the model with the prompt, so it costs a few dozen tokens when it appears and nothing otherwise.',
    '',
    'Strict mode (Copilot CLI): a thin prompt is not sent. A banner says what is missing and how to phrase it; sending the same prompt again runs it as written. No model call, no credits. In VS Code\'s chat a stopped prompt shows nothing, so strict mode gives the tip there instead.',
    '',
    `Strict model: the banner also carries the prompt rewritten by a small model (${require('./rewrite').DEFAULT_MODEL}, or AI_COST_REWRITE_MODEL), using the last few messages of the session to fill in what "it" means. Send y to run the suggestion. Each suggestion is one small model call (roughly 0.05 to 0.3 AI credits, a few seconds), logged in rewrites.jsonl.`,
    `Switch: \`/cost coach ${on ? 'off' : 'on'}\` · \`/cost coach strict ${st ? 'off' : 'on'}\` · \`/cost coach strict model ${rw ? 'off' : 'on'}\`.`,
  ].join('\n');
}

module.exports = { quality, banner, strict, setStrict, rewrite, setRewrite, offer, hasBlanks, ACCEPT, apply, statusLine, evaluate, tipFor, sessionFacts, asContext, asPrompt, command, enabled, setEnabled, ttl, VAGUE, LABEL };
