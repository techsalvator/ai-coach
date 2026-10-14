'use strict';
// The detail panel opens once and is reused: selecting a row while it is open must bring its tab forward.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const panels = [];
let overviewColumn;
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    return {
      EventEmitter: class { constructor() { this.event = () => {}; } fire() {} }, Uri: { joinPath: () => ({}) }, ViewColumn: { Beside: -2, Active: -1 }, StatusBarAlignment: {}, ThemeColor: class {},
      workspace: { getConfiguration: () => ({ get: (k, d) => d }) }, commands: { executeCommand() {} },
      window: {
        showWarningMessage() {},
        createWebviewPanel(type, title, show) {
          const p = { type, show, iconPath: null, reveals: [], title, viewColumn: type === 'aiCostOverview' ? overviewColumn : undefined, webview: { html: '', onDidReceiveMessage() {} }, disposed: [], onDidDispose(f) { this.disposed.push(f); }, reveal(...a) { this.reveals.push(a); } };
          panels.push(p);
          return p;
        },
      },
    };
  }
  return load.call(this, request, ...rest);
};
const ext = require('../extension')._test;
const { demoSessions } = require('../scripts/demo-data');

test('a detail panel that is already open is brought forward, without taking the focus from the tree', async () => {
  const all = demoSessions(Date.parse('2026-10-05T18:00:00Z'));
  ext.load(all);
  await ext.onDrill({ kind: 'session', sid: all[0].id });
  const detail = panels.find((p) => p.type === 'aiCostDetail');
  assert.ok(detail, 'the first selection opens the panel');
  assert.strictEqual(detail.reveals.length, 0, 'a new panel is already shown');
  assert.ok(detail.show.preserveFocus, 'and opened without stealing the focus');

  await ext.onDrill({ kind: 'session', sid: all[1].id });
  assert.strictEqual(panels.filter((p) => p.type === 'aiCostDetail').length, 1, 'the same panel is reused');
  assert.strictEqual(detail.reveals.length, 1, 'and its tab is brought forward');
  assert.deepStrictEqual(detail.reveals[0], [undefined, true], 'in its own column, with the focus left where it was');

  await ext.onDrill({ kind: 'prompt', sid: all[1].id, n: 1 });
  assert.strictEqual(detail.reveals.length, 2, 'every selection does it');
});

test('the detail panel is a tab in the group you are in, or in the overview\'s group, never a new split', async () => {
  const all = demoSessions(Date.parse('2026-10-05T18:00:00Z'));
  ext.load(all);
  const closeDetail = () => { for (const p of panels.filter((x) => x.type === 'aiCostDetail')) for (const f of p.disposed.splice(0)) f(); };
  const last = () => panels.filter((p) => p.type === 'aiCostDetail').pop();

  closeDetail();
  await ext.onDrill({ kind: 'session', sid: all[0].id });
  assert.strictEqual(last().show.viewColumn, -1, 'no overview open: the active group (Beside would split a new one to the right)');

  // the overview open in the second group: the detail goes there, as another tab
  overviewColumn = 2;
  await ext.onDrill({ kind: 'overview' });
  closeDetail();
  await ext.onDrill({ kind: 'session', sid: all[0].id });
  assert.strictEqual(last().show.viewColumn, 2, "the overview's group");
});
