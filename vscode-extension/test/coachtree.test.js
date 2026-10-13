'use strict';
// The Coach panel's rows (switches, results, limits, pause) and the results page, with a stand-in for VS Code
// and a throwaway home folder, so nothing of the real settings is touched.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicost-coachtree-'));
process.env.AI_COST_HOME = path.join(root, 'data');
process.env.COPILOT_HOME = path.join(root, 'copilot');
fs.mkdirSync(process.env.COPILOT_HOME, { recursive: true });
delete process.env.AI_COST_COACH; delete process.env.AI_COST_COACH_STRICT; delete process.env.AI_COST_COACH_REWRITE;

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    class TreeItem { constructor(label) { this.label = label; } }
    return { EventEmitter: class { constructor() { this.event = () => {}; } fire() {} }, TreeItem, ThemeIcon: class { constructor(id) { this.id = id; } },
      TreeItemCollapsibleState: { None: 0 }, TreeItemCheckboxState: { Checked: 1, Unchecked: 0 }, Uri: {}, ViewColumn: {}, StatusBarAlignment: {},
      workspace: { getConfiguration: () => ({ get: (k, d) => d }) }, commands: { executeCommand() {} }, window: {} };
  }
  return load.call(this, request, ...rest);
};
const { _test } = require('../extension');
const CS = require('../coachsettings');

const rows = () => { const t = new _test.CoachTree(); return t.getChildren().map((n) => { const i = t.getTreeItem(n); return { kind: n.kind || 'switch', label: i.label, description: i.description, command: i.command && i.command.command }; }); };

test('the Coach panel lists tracking, the five switches, results, the limits and the pause', () => {
  const r = rows();
  assert.deepStrictEqual(r.map((x) => x.label), ['Copilot tracking', 'Coach', 'Strict mode', 'Hold on every cache expiry', 'Strict model', 'Model guard', 'Coach results', 'Cost limit', 'Long session (tokens)', 'Long session (prompts)', 'Daily budget (premium requests)', 'Big paste', 'Model guard: costly from', 'Pause strict mode']);
  assert.strictEqual(r.find((x) => x.label === 'Cost limit').description, '$0.5 (default) · needs Copilot tracking');
  assert.strictEqual(r.find((x) => x.label === 'Long session (prompts)').description, '21 prompts (default)');
  assert.strictEqual(r.find((x) => x.label === 'Long session (tokens)').description, '150k tokens (default)');
  assert.strictEqual(r.find((x) => x.label === 'Big paste').description, '12,000 characters (default)');
  assert.strictEqual(r.find((x) => x.label === 'Model guard: costly from').description, '2 requests a prompt (default)');
  assert.strictEqual(r.find((x) => x.label === 'Pause strict mode').description, 'off');
  assert.strictEqual(r.find((x) => x.label === 'Coach results').description, 'nothing yet (30 days)');
  assert.strictEqual(r.find((x) => x.label === 'Cost limit').command, 'aiCost.editLimit');
});

test('a changed limit shows without "(default)"; a pause shows until when; both come back', () => {
  CS.writeLimit('costGateUsd', 2);
  assert.strictEqual(rows().find((x) => x.label === 'Cost limit').description, '$2 · needs Copilot tracking');
  CS.writeLimit('costGateUsd', null);
  CS.writePause(60);
  assert.match(rows().find((x) => x.label === 'Pause strict mode').description, /^paused until \d{1,2}:\d{2}/);
  CS.writePause(null);
  assert.strictEqual(rows().find((x) => x.label === 'Pause strict mode').description, 'off');
});

test('the results row and page summarise the log, and escape what they print', () => {
  fs.mkdirSync(process.env.AI_COST_HOME, { recursive: true });
  const ts = new Date().toISOString();
  const line = (event, id, avoidUsd) => JSON.stringify({ ts, event, id, session: 's', avoidUsd });
  fs.writeFileSync(path.join(process.env.AI_COST_HOME, 'coach-log.jsonl'), [
    line('held', 'cost-gate'), line('reworded', 'cost-gate', 0.72), line('held', 'repeat'), line('sent-anyway', 'repeat'), line('tip', 'long-session'), line('tip', '<img src=x onerror=alert(1)>'),
  ].join('\n'));
  assert.strictEqual(rows().find((x) => x.label === 'Coach results').description, '2 held · 1 changed · 1 sent anyway · about $0.720 avoided (30 days)');
  const html = _test.coachResultsHtml(CS.readResults());
  assert.match(html, /Cold cache over the cost limit<\/td><td>0<\/td><td>1<\/td><td>1<\/td><td>0<\/td><td>\$0\.720/);
  assert.match(html, /Repeated prompt<\/td><td>0<\/td><td>1<\/td><td>0<\/td><td>1<\/td>/);
  assert.ok(!html.includes('<img src=x'), 'a rule id from the log is escaped');
  assert.match(html, /&lt;img src=x/);
  assert.match(_test.coachResultsHtml({ byId: {}, total: { tips: 0, held: 0, reworded: 0, sentAnyway: 0, avoidedUsd: 0 } }), /Nothing yet/);
});

test('the tracking row says when the hook has been failing, and only while tracking is on', () => {
  const coach = require('../../lib/coach');
  const Setup = require('../copilotsetup');
  const tracking = () => rows().find((x) => x.label === 'Copilot tracking').description;
  coach.logError(new Error('Cannot find module ./premium'));
  assert.strictEqual(tracking(), 'off', 'tracking is off: nothing to say');
  Setup.enable();
  assert.strictEqual(tracking(), 'on (the hook failed 1 time in the last day)');
  coach.logError(new Error('again'));
  assert.strictEqual(tracking(), 'on (the hook failed 2 times in the last day)');
  assert.strictEqual(CS.readErrors(process.env, 24, Date.now() + 25 * 3600e3).length, 0, 'a day later it is forgotten');
  Setup.disable();
  fs.rmSync(path.join(process.env.AI_COST_HOME, 'hook-errors.jsonl'));
});

test('the results page says what the coach learned: checked warnings and measured cache lifetimes', () => {
  const zero = { tips: 0, held: 0, reworded: 0, sentAnyway: 0, avoidedUsd: 0, checked: 0, right: 0 };
  const gate = { ...zero, held: 3, sentAnyway: 3, checked: 3, right: 2 };
  const results = { byId: { 'cost-gate': gate }, total: gate };
  const html = _test.coachResultsHtml(results, { 'claude-sonnet-5.5': { ttl: 3600, seen: 9, wrong: 1, usual: 300 }, 'gpt-6-sol': { ttl: 1800, seen: 6, wrong: 0, usual: 1800 } });
  assert.match(html, /<h3>What the coach learned<\/h3>/);
  assert.match(html, /Of 3 cold-cache warnings you sent anyway, the next model call started cold 2 times: 1 was a false alarm\./);
  assert.match(html, /claude-sonnet-5\.5 keeps its cache for <b>1 hour<\/b> on your plan, not the documented 5 minutes: measured over 9 idle gaps in the token log \(1 did not fit\)/);
  assert.match(html, /gpt-6-sol keeps its cache for <b>30 minutes<\/b> on your plan, as documented: measured over 6 idle gaps/);
  assert.ok(!/What the coach learned/.test(_test.coachResultsHtml({ byId: {}, total: zero })), 'nothing learned: no section');
  assert.match(_test.coachResultsHtml({ byId: {}, total: { ...zero, checked: 2, right: 2 } }), /started cold every time, as warned\./);
  assert.deepStrictEqual(CS.readTtl(), {}, 'with no token log there is nothing measured');
  assert.strictEqual(rows().some((x) => /Learn from/.test(String(x.label))), false, 'no such switch in the panel');
});
