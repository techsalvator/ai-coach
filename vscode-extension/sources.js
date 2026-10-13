'use strict';
// Every source in one list. A source that fails to read is reported, not fatal: the others still load.
const claude = require('./model');
const copilot = require('./copilot');

const SOURCE_LABEL = { claude: 'Claude Code', copilot: 'Copilot CLI', vscode: 'VS Code chat' };

async function loadAll({ maxSessions = 500, copilotDays = 90, enabled = ['claude', 'copilot'] } = {}) {
  const errors = [];
  const run = async (name, fn) => { try { return await fn(); } catch (err) { errors.push(`${SOURCE_LABEL[name]}: ${err.message}`); return []; } };
  const [a, b] = await Promise.all([
    enabled.includes('claude') ? run('claude', () => claude.load({ maxSessions })) : [],
    enabled.includes('copilot') ? run('copilot', () => copilot.load({ days: copilotDays })) : [],
  ]);
  return { sessions: [...a, ...b].sort((x, y) => (x.ts < y.ts ? 1 : -1)), errors };
}

/** What a call went in and came out, from whichever transcript the session came from. */
async function callContent(session, prompt, call) {
  if (session.source === 'claude') return claude.callDetail(session.file, call.id);
  if (session.source === 'copilot') return copilot.callContent(session, prompt, call);
  return null;
}

/** Tool calls of a prompt: the Claude rows already carry them; Copilot's are read from the event log. */
async function promptTools(session, prompt) {
  if (prompt.toolCalls && prompt.toolCalls.length) return prompt.toolCalls;
  if (session.source === 'copilot' && prompt.toolCount) return copilot.promptTools(session, prompt);
  return prompt.toolCalls || [];
}

/** One tool call's full input and result. */
async function toolContent(session, prompt, tool) {
  if (!tool.id) return null;
  if (session.source === 'claude') return claude.toolContent(session.file, tool.id);
  if (session.source === 'copilot') return copilot.toolContent(session, tool);
  return null;
}

module.exports = { loadAll, callContent, promptTools, toolContent, SOURCE_LABEL };
