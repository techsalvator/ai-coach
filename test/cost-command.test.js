// node --test test/*.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const MOD = path.join(__dirname, '..', 'extensions', 'ai-cost', 'cost-command.mjs');
const load = () => import(pathToFileURL(MOD).href); // a bare C: path is not a URL import() accepts

/** A COPILOT_HOME with one session that has a log, so the reports have something to read. */
function fixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  fs.mkdirSync(path.join(home, 'session-state', sid), { recursive: true });
  fs.writeFileSync(path.join(home, 'session-state', sid, 'events.jsonl'),
    `${JSON.stringify({ type: 'session.start', timestamp: '2026-10-01T10:00:00Z', data: { sessionId: sid, context: { cwd: '/x' } } })}\n`);
  return { home, sid };
}

test('the command answers help and a session report with the same code as the hook', async () => {
  const { home, sid } = fixtureHome();
  process.env.COPILOT_HOME = home; process.env.AI_COST_HOME = home;
  const { answer } = await load();
  const help = await answer('help', sid);
  assert.strictEqual(help.level, 'info');
  assert.match(help.text, /\/cost prompt N calls/);
  const report = await answer('session', sid);
  assert.strictEqual(report.level, 'info');
  assert.match(report.text, /Copilot session cost — aaaaaaaa/);
});

test('a bad argument is a warning that carries the help, not an exception', async () => {
  const { home, sid } = fixtureHome();
  process.env.COPILOT_HOME = home; process.env.AI_COST_HOME = home;
  const { answer } = await load();
  const r = await answer('prompt notanumber', sid);
  assert.strictEqual(r.level, 'warning');
  assert.match(r.text, /needs a prompt number/);
  assert.match(r.text, /\/cost list/);
});

test('without report code beside it (a copy made into ~/.copilot/extensions) it says so', async () => {
  const { answer } = await load();
  const r = await answer('list', 'x', null);
  assert.strictEqual(r.level, 'warning');
  assert.match(r.text, /not next to this extension/);
  assert.match(r.text, /AI Cost view in VS Code/);
});

test('loadReports finds bin/cost.js when the extension sits in the repository', async () => {
  const { loadReports } = await load();
  const reports = loadReports();
  assert.strictEqual(typeof reports.cost, 'function');
  assert.strictEqual(typeof reports.splitArgs, 'function');
  assert.ok(reports.HELP.includes('/cost advise'));
});
