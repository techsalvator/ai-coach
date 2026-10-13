'use strict';
/**
 * VS Code Copilot Chat sessions as prompt rows, so they appear in the same reports as Copilot CLI sessions.
 *
 * VS Code keeps each chat as a .jsonl of incremental patches (kind 0: the whole state; kind 1: set a value at a
 * path; kind 2: push items onto an array) under <VS Code user dir>/workspaceStorage/<hash>/chatSessions/ and
 * globalStorage/emptyWindowChatSessions/. A finished request records promptTokens, completionTokens and, since
 * mid-July 2026, copilotCredits (AI credits). The files are big (response text, tool output), so each is
 * streamed, the heavy patches are skipped unread, and the result is cached per file.
 *
 * It is VS Code's internal format, not a documented one: a field it stops writing shows as missing, never as an
 * error. Tokens are as VS Code reports them for the request (an agent-mode request can span several model calls).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const ROW_VERSION = 1;

/** VS Code "User" folders to read: AI_COST_VSCODE_DIR (a PATH-style list) or the editions for this platform. */
function userDirs(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.AI_COST_VSCODE_DIR) return env.AI_COST_VSCODE_DIR.split(path.delimiter).filter(Boolean);
  const editions = ['Code', 'Code - Insiders'];
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA || path.join(home, 'AppData', 'Roaming'))
      : (env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return editions.map((e) => path.join(base, e, 'User'));
}

/** The folder a workspaceStorage entry belongs to ("file:///Users/me/proj" -> "/Users/me/proj"), or null. */
function workspaceFolder(dir) {
  try {
    const w = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'));
    const uri = w.folder || w.workspace;
    if (!uri) return null;
    let p = decodeURIComponent(String(uri).replace(/^file:\/\//, ''));
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // file:///C:/x on Windows
    if (w.workspace && !w.folder) p = p.replace(/\.code-workspace$/, '');
    return p;
  } catch {
    return null;
  }
}

/** Chat session files with the folder each belongs to: [{file, folder}]. */
function chatFiles(userDir) {
  const out = [];
  const ws = path.join(userDir, 'workspaceStorage');
  let dirs = [];
  try { dirs = fs.readdirSync(ws); } catch { /* no workspace storage */ }
  for (const d of dirs) {
    const cs = path.join(ws, d, 'chatSessions');
    let names = [];
    try { names = fs.readdirSync(cs); } catch { continue; }
    const folder = workspaceFolder(path.join(ws, d));
    for (const n of names) if (n.endsWith('.jsonl')) out.push({ file: path.join(cs, n), folder });
  }
  const empty = path.join(userDir, 'globalStorage', 'emptyWindowChatSessions');
  try { for (const n of fs.readdirSync(empty)) if (n.endsWith('.jsonl')) out.push({ file: path.join(empty, n), folder: null }); } catch { /* none */ }
  return out;
}

// Patches that only carry bulk (response parts, variable data, citations) and nothing a report needs.
const HEAVY = /^\{"kind":[12],"k":\["requests",\d+,"(response|variableData|contentReferences|codeCitations|responseMarkdownInfo|followups|editedFileEvents|timeSpentWaiting)"/;

/** The few fields of a request a report uses. */
function slim(r) {
  if (!r || typeof r !== 'object') return r;
  const md = (r.result && r.result.metadata) || {};
  return {
    requestId: r.requestId, timestamp: r.timestamp, modelId: r.modelId,
    message: r.message ? { text: r.message.text } : undefined,
    modeInfo: r.modeInfo ? { kind: r.modeInfo.kind, name: r.modeInfo.name } : undefined,
    isCanceled: r.isCanceled, elapsedMs: r.elapsedMs, modelState: r.modelState,
    promptTokens: r.promptTokens, completionTokens: r.completionTokens, copilotCredits: r.copilotCredits,
    result: r.result ? { metadata: { promptTokens: md.promptTokens, outputTokens: md.outputTokens, resolvedModel: md.resolvedModel,
      rounds: Array.isArray(md.toolCallRounds) ? md.toolCallRounds.length : undefined } } : undefined,
  };
}

function setPath(state, keys, value) {
  let cur = state;
  for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]];
  cur[keys[keys.length - 1]] = value;
}

/** Applies one patch to the (slimmed) state. */
function apply(state, o) {
  const keys = o.k || [];
  if (o.kind === 1) {
    if (keys[0] === 'requests' && keys.length >= 3) {
      const req = state.requests[keys[1]];
      if (!req) return;
      // a patch of one request field: keep it, slimming a whole `result`
      req[keys[2]] = keys[2] === 'result' ? slim({ result: o.v }).result : o.v;
      if (keys.length > 3) { /* deeper edits of result/message: not needed */ }
    } else if (keys.length === 1) {
      state[keys[0]] = o.v;
    }
  } else if (o.kind === 2 && keys[0] === 'requests' && keys.length === 1 && Array.isArray(o.v)) {
    const items = o.v.map(slim);
    if (o.i == null) state.requests.push(...items); else state.requests.splice(o.i, state.requests.length - o.i, ...items);
  }
}

/** Replays a chat file (streamed, heavy patches skipped) into {sessionId, creationDate, customTitle, requests: slim[]}. */
async function replay(file) {
  let state = null;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    if (state && HEAVY.test(line)) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; } // a partial last line
    if (o.kind === 0 && o.v) {
      state = { sessionId: o.v.sessionId, creationDate: o.v.creationDate, customTitle: o.v.customTitle, requests: (o.v.requests || []).map(slim) };
    } else if (state) {
      try { apply(state, o); } catch { /* a patch for something we did not keep */ }
    }
  }
  return state;
}

/** VS Code writes "claude-sonnet-4-6"; Copilot's price list says "claude-sonnet-4.6". */
const modelName = (m) => String(m || '').replace(/^copilot\//, '')
  .replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '')      // a date suffix: claude-haiku-4.5-20251001, gpt-5.4-2026-03-05
  .replace(/(\d)-(\d)(?!\d)/g, '$1.$2') || null;

/** Prompt rows (the shape prompt-usage uses) for one replayed session. */
function toRows(state, ctx = {}) {
  if (!state) return [];
  const id = String(state.sessionId || ctx.fallbackId || '').slice(0, 8) || 'unknown';
  const out = [];
  for (const r of state.requests || []) {
    const md = (r.result && r.result.metadata) || {};
    const input = r.promptTokens ?? md.promptTokens ?? null;
    const output = r.completionTokens ?? md.outputTokens ?? null;
    const credits = typeof r.copilotCredits === 'number' && r.copilotCredits > 0 ? r.copilotCredits : null;
    if (input == null && output == null && credits == null) continue; // nothing was spent: cancelled before the model
    const ts = r.timestamp ? new Date(r.timestamp).toISOString() : null;
    if (!ts) continue;
    const done = r.modelState && r.modelState.completedAt;
    const secs = r.elapsedMs != null ? Math.round(r.elapsedMs / 1000) : done ? Math.max(0, Math.round((done - r.timestamp) / 1000)) : null;
    const model = modelName(md.resolvedModel || r.modelId);
    out.push({
      session: `vs-${id}`, source: 'vscode', ts, prompt: String((r.message && r.message.text) || '').replace(/\s+/g, ' ').trim(),
      cwd: ctx.folder || null, repository: null, branch: null,
      credits, premium: null, models: model ? [model] : [], firstModel: model, lastModel: model,
      toolCalls: md.rounds || 0, subagents: 0, subagentTokens: 0, compactions: 0,
      seconds: secs, activeSeconds: secs, cacheBreak: null, jira: null, mode: (r.modeInfo && (r.modeInfo.name || r.modeInfo.kind)) || null,
      tokensLive: { input: input || 0, output: output || 0, cacheRead: 0, cacheWrite: 0, calls: 1 },
    });
  }
  return out;
}

/**
 * Rows for every VS Code chat request since sinceMs. cachePath: where per-file results are kept (a file is read
 * again only when its size or time changes). Returns {rows, files, scanned}.
 */
async function readAll(sinceMs, { dirs = userDirs(), cachePath = null } = {}) {
  let cache = { version: ROW_VERSION, files: {} };
  if (cachePath) {
    try {
      const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (c.version === ROW_VERSION) cache = c;
    } catch { /* no cache yet */ }
  }
  const seen = new Set();
  const rows = [];
  let files = 0; let scanned = 0;
  for (const dir of dirs) {
    for (const { file, folder } of chatFiles(dir)) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      seen.add(file);
      if (st.mtimeMs < sinceMs) continue; // nothing written since: nothing can fall inside the window
      files++;
      const hit = cache.files[file];
      let fileRows;
      if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) {
        fileRows = hit.rows;
      } else {
        fileRows = toRows(await replay(file), { folder, fallbackId: path.basename(file, '.jsonl') });
        cache.files[file] = { size: st.size, mtime: st.mtimeMs, rows: fileRows };
        scanned++;
      }
      rows.push(...fileRows);
    }
  }
  for (const f of Object.keys(cache.files)) if (!seen.has(f)) delete cache.files[f];
  if (cachePath && scanned) {
    try { fs.mkdirSync(path.dirname(cachePath), { recursive: true }); fs.writeFileSync(cachePath, JSON.stringify(cache)); } catch { /* speed only */ }
  }
  return { rows: rows.filter((r) => Date.parse(r.ts) >= sinceMs), files, scanned };
}

module.exports = { userDirs, chatFiles, workspaceFolder, replay, toRows, readAll, modelName, slim };
