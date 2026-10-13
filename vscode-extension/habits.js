'use strict';
// The token-saving tools that were there to use and were not: /compact in a long session, a project instructions file,
// the token logger, the coach itself. advice.js measures what a session cost more than it needed to; this says which
// habit would have prevented it. Pure: takes model.js sessions and what the caller knows about the machine, and returns
// findings in the shape advice.js uses (`saving` is 0: these overlap the measured findings, so they claim none of their own).

const fs = require('fs');
const path = require('path');

const LONG_CONTEXT = 150000; // tokens in one call: the line advice.js and the coach draw for a long session
const LONG_PROMPTS = 21;     // the same line by prompt count, for sessions with no token data
const MIN_SESSIONS = 3;      // a folder worked in this often is worth an instructions file
const RECENT_DAYS = 7;       // token data is judged on recent prompts: older ones may predate the logger
const MIN_PROMPTS = 5;
const NO_DATA_SHARE = 0.2;

// What each tool reads at the start of a session, relative to the folder it runs in.
const INSTRUCTIONS = {
  copilot: ['.github/copilot-instructions.md', 'AGENTS.md'],
  vscode: ['.github/copilot-instructions.md', 'AGENTS.md'],
  claude: ['CLAUDE.md', 'AGENTS.md'],
};

const money = (x) => `$${x.toFixed(2)}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const usdOf = (s) => s.prompts.reduce((a, p) => a + (p.usd || 0), 0);
/** The most expensive prompt of a session, as a path into the sessions array. */
const topPrompt = (s, si) => [si, s.prompts.reduce((best, p, i) => ((p.usd || 0) > (s.prompts[best].usd || 0) ? i : best), 0)];

const isLong = (s) => (s.split && s.split.known
  ? s.prompts.some((p) => (p.calls || []).some((c) => c.tokensIn >= LONG_CONTEXT))
  : s.prompts.length >= LONG_PROMPTS);

/**
 * Long Copilot CLI sessions that were never compacted. Copilot's log says when a context was compacted, so this is
 * counted, not guessed; the other tools' logs do not say, so their sessions are left out.
 */
function noCompact(sessions) {
  const long = sessions.map((s, si) => ({ s, si })).filter(({ s }) => s.source === 'copilot' && s.prompts.length && isLong(s));
  const never = long.filter(({ s }) => !s.prompts.some((p) => p.compactions > 0));
  if (!never.length) return null;
  const usd = never.reduce((a, { s }) => a + usdOf(s), 0);
  return {
    id: 'no-compact', habit: true, saving: 0, title: '/compact was not used in long sessions', status: `${long.length - never.length} of ${long.length} compacted`,
    detail: `${plural(long.length, 'Copilot CLI session')} grew long (${LONG_CONTEXT / 1000}k tokens of context, or ${LONG_PROMPTS} prompts where there is no token data), and ${never.length === long.length ? 'none of them was' : `${never.length} of them ${never.length === 1 ? 'was' : 'were'} never`} compacted. Every model call in a session re-sends all of its context, so those ${plural(never.length, 'session')} (${money(usd)}) carried everything to the end.`,
    action: 'Run /compact when a task is done and before picking a long session up again, or start a new session for the next task. Strict mode in the Coach panel holds the prompt that crosses the line, once per session, to remind you.',
    targets: never.sort((a, b) => usdOf(b.s) - usdOf(a.s)).slice(0, 15).map(({ s, si }) => topPrompt(s, si)),
  };
}

/** Folders worked in again and again that have no instructions file for the tool used there. */
function noInstructions(sessions, exists) {
  const folders = new Map(); // "source|folder" -> the sessions run there
  sessions.forEach((s, si) => {
    if (!s.cwd || !INSTRUCTIONS[s.source] || !s.prompts.length) return;
    const key = `${s.source === 'claude' ? 'claude' : 'copilot'}|${path.resolve(s.cwd)}`;
    if (!folders.has(key)) folders.set(key, []);
    folders.get(key).push({ s, si });
  });
  const missing = [];
  for (const [key, list] of folders) {
    const [tool, folder] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
    if (list.length < MIN_SESSIONS || !exists(folder)) continue; // a folder that is gone cannot be checked
    if (INSTRUCTIONS[tool].some((f) => exists(path.join(folder, f)))) continue;
    missing.push({ tool, folder, list, usd: list.reduce((a, { s }) => a + usdOf(s), 0) });
  }
  if (!missing.length) return null;
  missing.sort((a, b) => b.usd - a.usd);
  const n = missing.reduce((a, m) => a + m.list.length, 0);
  const names = missing.slice(0, 4).map((m) => `${path.basename(m.folder)} (${plural(m.list.length, 'session')}, ${money(m.usd)})`).join(', ');
  const files = [...new Set(missing.map((m) => (m.tool === 'claude' ? 'CLAUDE.md' : '.github/copilot-instructions.md or AGENTS.md')))].join('; for Claude Code, ');
  return {
    id: 'no-instructions', habit: true, saving: 0, title: 'No project instructions file', status: plural(missing.length, 'folder'),
    detail: `${plural(n, 'session')} ran in ${plural(missing.length, 'folder')} that ${missing.length === 1 ? 'has' : 'have'} no instructions file: ${names}${missing.length > 4 ? ', and more' : ''}. Without one, each new session has to work out how the project is built, tested and laid out before it can start, with tool calls whose results stay in the context.`,
    action: `Add ${files} with the build and test commands, where things live, and the conventions the agent keeps getting wrong. Keep it short: it is sent with every model call.`,
    targets: missing.flatMap((m) => m.list).sort((a, b) => usdOf(b.s) - usdOf(a.s)).slice(0, 15).map(({ s, si }) => [si, 0]),
  };
}

/**
 * Recent Copilot CLI prompts with no token data: the token logger was not running. Without it the reports have credits
 * but no tokens, and the coach cannot price a cold cache or size a session.
 */
function noTokenData(sessions, tracking, now) {
  const since = now - RECENT_DAYS * 86400000;
  const recent = sessions.flatMap((s, si) => (s.source === 'copilot' ? s.prompts.map((p, pi) => ({ p, path: [si, pi] })) : [])).filter((x) => Date.parse(x.p.ts) >= since);
  const blind = recent.filter((x) => !(x.p.split && x.p.split.known));
  if (recent.length < MIN_PROMPTS || blind.length / recent.length < NO_DATA_SHARE) return null;
  const off = tracking === false;
  return {
    id: 'no-token-data', habit: true, saving: 0, title: off ? 'Copilot tracking is off' : 'The token logger is not recording', status: `${blind.length} of ${recent.length} prompts`,
    detail: `${blind.length} of the ${recent.length} Copilot CLI prompts of the last ${RECENT_DAYS} days have no token data${off ? ', because Copilot tracking is off' : ''}. Their cost is known from credits, but not where the tokens went, and the coach cannot say what a cold cache will cost or how big a session has grown: it falls back to counting prompts.`,
    action: off
      ? 'Tick Copilot tracking in the Coach panel. Then run /experimental on once in Copilot CLI and start a new session.'
      : 'Copilot CLI loads the logger only in experimental mode: run /experimental on once, then start a new session. /tokenlog in Copilot CLI says whether it is recording.',
    targets: blind.sort((a, b) => (b.p.usd || 0) - (a.p.usd || 0)).slice(0, 15).map((x) => x.path),
  };
}

/** The coach is switched off while Copilot is in use: nothing checks a prompt before it runs. */
function coachOff(sessions, coach, now) {
  if (coach !== false) return null;
  const since = now - RECENT_DAYS * 86400000;
  const n = sessions.filter((s) => s.source !== 'claude').reduce((a, s) => a + s.prompts.filter((p) => Date.parse(p.ts) >= since).length, 0);
  if (n < MIN_PROMPTS) return null;
  return {
    id: 'coach-off', habit: true, saving: 0, title: 'Cost tips are off', status: `${n} prompts unchecked`,
    detail: `${n} Copilot prompts ran in the last ${RECENT_DAYS} days with the coach off, so none was checked for an expired cache, a long session, a repeat or a thin prompt before it ran.`,
    action: 'Turn Coach on in the Coach panel. A tip costs a few dozen tokens when it appears and nothing otherwise; strict mode can stay off if you do not want prompts held.',
    targets: [],
  };
}

/**
 * The habits that would have saved tokens and were not used, most expensive first.
 * o.exists: is this path there (injectable for tests); o.tracking, o.coach: true, false or null when not known; o.now.
 */
function habits(sessions, o = {}) {
  const exists = o.exists || fs.existsSync;
  const now = o.now || Date.now();
  return [noCompact(sessions), noInstructions(sessions, exists), noTokenData(sessions, o.tracking, now), coachOff(sessions, o.coach, now)].filter(Boolean);
}

module.exports = { habits, INSTRUCTIONS, LONG_CONTEXT, LONG_PROMPTS };
