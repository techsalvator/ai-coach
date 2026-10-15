'use strict';
// Where ai-cost-coach keeps its own files. Everything else it reads is Copilot's
// (~/.copilot/session-state, or COPILOT_HOME).
const fs = require('fs');
const os = require('os');
const path = require('path');

/** ~/.ai-cost-coach, except that an existing ~/.ai-cost-drilldown (the folder's earlier name) keeps being used, so
 *  settings, caches and the token log carry over. */
function defaultHome(home = os.homedir()) {
  const current = path.join(home, '.ai-cost-coach');
  const earlier = path.join(home, '.ai-cost-drilldown');
  return !fs.existsSync(current) && fs.existsSync(earlier) ? earlier : current;
}

const HOME = process.env.AI_COST_HOME || process.env.COPILOT_COST_HOME || defaultHome();

module.exports = {
  defaultHome,
  HOME,
  CACHE_DIR: path.join(HOME, 'cache'),
  REPORTS_DIR: path.join(HOME, 'reports'),
  // Per-call token records (Copilot's session log has none). Written by the optional
  // token-logger extension; the PhantomFlow extension's older log is read too.
  TOKEN_LOGS: process.env.AI_COST_TOKEN_LOG || process.env.COPILOT_COST_TOKEN_LOG
    ? [process.env.AI_COST_TOKEN_LOG || process.env.COPILOT_COST_TOKEN_LOG]
    : [path.join(HOME, 'copilot-tokens.jsonl'), path.join(os.homedir(), '.phantomflow', 'logs', 'copilot-tokens.jsonl')],
};
