'use strict';
// Where ai-cost-drilldown keeps its own files. Everything else it reads is Copilot's
// (~/.copilot/session-state, or COPILOT_HOME).
const os = require('os');
const path = require('path');

const HOME = process.env.AI_COST_HOME || process.env.COPILOT_COST_HOME || path.join(os.homedir(), '.ai-cost-drilldown');

module.exports = {
  HOME,
  CACHE_DIR: path.join(HOME, 'cache'),
  REPORTS_DIR: path.join(HOME, 'reports'),
  // Per-call token records (Copilot's session log has none). Written by the optional
  // token-logger extension; the PhantomFlow extension's older log is read too.
  TOKEN_LOGS: process.env.AI_COST_TOKEN_LOG || process.env.COPILOT_COST_TOKEN_LOG
    ? [process.env.AI_COST_TOKEN_LOG || process.env.COPILOT_COST_TOKEN_LOG]
    : [path.join(HOME, 'copilot-tokens.jsonl'), path.join(os.homedir(), '.phantomflow', 'logs', 'copilot-tokens.jsonl')],
};
