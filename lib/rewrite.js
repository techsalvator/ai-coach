'use strict';
/**
 * A suggested rewrite of a thin prompt, from a small model (opt-in: `/cost coach rewrite on`).
 *
 * A hook cannot call a model, so this runs one `copilot -p` of its own: a cheap model, no tools, no MCP servers,
 * no custom instructions, low reasoning. It runs in a Copilot home of its own (<AI_COST_HOME>/rewriter) so the
 * user's plugins, hooks and MCP servers are not loaded (which keeps it to about 11k input tokens and a few
 * seconds) and its sessions stay out of the user's session list. What it spends is appended to
 * <AI_COST_HOME>/rewrites.jsonl, because those sessions are not in the cost reports.
 *
 * The model sees the held prompt, why it was held, and the last few prompts and answer of the session, so "the
 * bug" can become the file and error the session was about. It is told to leave a blank it cannot fill.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MODEL = 'gpt-5-mini';
const TIMEOUT_MS = 45000;
const TAIL_BYTES = 256 * 1024;
const clip = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };

const aiCostHome = (env = process.env) => env.AI_COST_HOME || env.COPILOT_COST_HOME || path.join(os.homedir(), '.ai-cost-drilldown');

/** The last few user prompts and the last answer of a session log, clipped: what "it" most likely refers to. */
function recentContext(file) {
  let text;
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return ''; }
  const prompts = []; let answer = '';
  for (const line of text.split('\n')) {
    const user = line.startsWith('{"type":"user.message"');
    if (!user && !line.startsWith('{"type":"assistant.message"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const content = e.data && e.data.content;
    if (!content) continue;
    if (user) prompts.push(clip(content, 300)); else answer = clip(content, 600);
  }
  const out = prompts.slice(-3).map((p) => `- user: ${p}`);
  if (answer) out.push(`- assistant (last answer): ${answer}`);
  return out.join('\n');
}

function instruction({ prompt, why, context, cwd }) {
  return [
    'Rewrite a developer\'s prompt to a coding agent so the agent can act on it without guessing or searching.',
    `The prompt was held back because ${why}.`,
    'Rules: keep the developer\'s intent; one task; name the file, function or ticket and the exact error ONLY if the context below gives them;',
    'where something needed is unknown, leave a short placeholder in angle brackets such as <file> or <exact error line>; never invent names or errors;',
    'one to three sentences; reply with the rewritten prompt only, no preamble, no quotes.',
    '',
    `Prompt: ${clip(prompt, 600)}`,
    cwd ? `Working folder: ${cwd}` : '',
    context ? `Recent conversation:\n${context}` : 'Recent conversation: none (this is the first prompt of the session).',
  ].filter((l) => l !== '').join('\n');
}

/** The reply and credits out of `copilot --output-format json` (one JSON event per line). */
function parseOutput(stdout) {
  let reply = ''; let credits = null;
  for (const line of String(stdout || '').split('\n')) {
    if (!line.startsWith('{')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const d = e.data || {};
    if (e.type === 'assistant.message' && d.content) reply = d.content;
    else if (e.type === 'session.usage_checkpoint' && typeof d.totalNanoAiu === 'number') credits = d.totalNanoAiu / 1e9;
  }
  reply = reply.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  return { reply: reply || null, credits };
}

/**
 * A rewrite of the prompt, or null if the model could not be reached in time. q: {prompt, why, sessionFile, cwd,
 * sessionId}; o: {env, model, spawnSync, platform} (injectable for tests).
 */
function suggest(q, o = {}) {
  const env = o.env || process.env;
  const spawnSync = o.spawnSync || require('child_process').spawnSync;
  const platform = o.platform || process.platform;
  const model = o.model || env.AI_COST_REWRITE_MODEL || DEFAULT_MODEL;
  const home = path.join(aiCostHome(env), 'rewriter');
  try { fs.mkdirSync(home, { recursive: true }); } catch { return null; }
  let text = instruction({ ...q, context: q.sessionFile ? recentContext(q.sessionFile) : '' });
  const win = platform === 'win32';
  if (win) text = `"${text.replace(/["%]/g, "'").replace(/\r?\n/g, ' ')}"`; // through cmd.exe: one quoted argument
  const args = ['-p', text, '--model', model, '--output-format', 'json', '--no-custom-instructions', '--disable-builtin-mcps',
    '--no-ask-user', '--available-tools', '--reasoning-effort', 'low'];
  const started = Date.now();
  let r;
  try {
    r = spawnSync(win ? 'copilot.cmd' : 'copilot', args, {
      cwd: home, encoding: 'utf8', timeout: TIMEOUT_MS, shell: win, maxBuffer: 8 << 20,
      // its own home: no plugins, hooks or MCP servers; and never coach the rewriter's own prompt
      env: { ...env, COPILOT_HOME: home, AI_COST_COACH: '0' },
    });
  } catch { return null; }
  const { reply, credits } = parseOutput(r && r.stdout);
  try {
    fs.appendFileSync(path.join(aiCostHome(env), 'rewrites.jsonl'), `${JSON.stringify({ ts: new Date(started).toISOString(), sessionId: q.sessionId || null, model, ms: Date.now() - started, credits, ok: Boolean(reply) })}\n`);
  } catch { /* the record is a courtesy */ }
  if (!reply || reply.length > 1200) return null;
  return { text: reply, model, credits };
}

module.exports = { suggest, instruction, recentContext, parseOutput, DEFAULT_MODEL };
