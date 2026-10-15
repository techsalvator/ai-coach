'use strict';
// The overview's range buttons and harness chips, driven by the same messages the page sends.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const NOW = Date.parse('2026-10-05T18:00:00Z');
const RealDate = Date;
global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } };
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    return { EventEmitter: class { constructor() { this.event = () => {}; } fire() {} }, Uri: {}, ViewColumn: {}, StatusBarAlignment: {}, ThemeColor: class { constructor(id) { this.id = id; } },
      workspace: { getConfiguration: () => ({ get: (k, d) => d }) }, commands: { executeCommand() {} }, window: { showWarningMessage() {} } };
  }
  return load.call(this, request, ...rest);
};
const ext = require('../extension')._test;
const { demoSessions } = require('../scripts/demo-data');

const sessions = demoSessions(NOW);
const drill = (m) => ext.onDrill(m);
const page = () => ext.overviewHtml(false);
const chips = (html) => [...html.matchAll(/<button class="chip( on)?"[^>]*data-drill="\{&quot;kind&quot;:&quot;harness&quot;,&quot;value&quot;:&quot;(\w+)&quot;\}"/g)].map((m) => [m[2], Boolean(m[1])]);
const barDays = (html) => new Set([...html.matchAll(/data-drill="\{&quot;kind&quot;:&quot;day&quot;,&quot;value&quot;:&quot;(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1])).size;

test('By day draws one bar group per day of the loaded history, and the others keep their ranges', () => {
  ext.load(sessions, { days: 0 });
  assert.match(page(), /Cost by month/);
  drill({ kind: 'range', value: -1 });
  assert.strictEqual(ext.days, -1);
  const html = page();
  assert.match(html, /Cost per day, all loaded history/);
  assert.match(html, /class="on"[^>]*>By day</);
  assert.ok(barDays(html) > 60, `every day, not weeks (${barDays(html)} days)`);
  assert.ok(!/Cost by month<\/h3>\s*<table/.test(html), 'no month table here');
  drill({ kind: 'range', value: 30 });
  assert.match(page(), /Cost per day, last 30 days/);
  drill({ kind: 'range', value: 90 });
  assert.match(page(), /Cost per week, last 90 days/);
});

test('the legend under the chart is the tool selector: one set of chips, no separate section', () => {
  ext.load(sessions, { days: 0 });
  const html = page();
  assert.deepStrictEqual(chips(html), [['claude', true], ['copilot', true], ['vscode', true]]);
  assert.ok(!/>Harness</.test(html), 'no separate Harness row');
  assert.strictEqual((html.match(/class="legend/g) || []).length, 2, 'the chart legend and the token legend only');
  assert.match(html.split('class="legend chips"')[0], /<svg[^]*<\/svg>/, 'the chips sit after the chart');
});

test('clicking a chip leaves that tool out, everywhere; clicking again brings it back', () => {
  ext.load(sessions, { days: 0 });
  const total = (html) => Number((/Total cost<\/span><b>\$([\d,.]+)/.exec(html) || [])[1].replace(/,/g, ''));
  const all = total(page());
  drill({ kind: 'harness', value: 'copilot' });
  assert.deepStrictEqual(ext.filter.sources, ['claude', 'vscode']);
  assert.deepStrictEqual(chips(page()), [['claude', true], ['copilot', false], ['vscode', true]]);
  assert.ok(total(page()) < all, 'the totals follow');
  assert.ok(!/Copilot CLI<\/span>/.test(page().split('By source')[1] || ''), 'and so does the by-source list');
  drill({ kind: 'harness', value: 'copilot' });
  assert.deepStrictEqual(ext.filter.sources, [], 'all three back means no filter');
  assert.strictEqual(total(page()), all);
});

test('the last tool cannot be switched off, and unknown tools are ignored', () => {
  ext.load(sessions, { days: 0 });
  drill({ kind: 'harness', value: 'claude' });
  drill({ kind: 'harness', value: 'copilot' });
  assert.deepStrictEqual(ext.filter.sources, ['vscode']);
  drill({ kind: 'harness', value: 'vscode' });
  assert.deepStrictEqual(ext.filter.sources, [], 'nothing left selected would show nothing: back to all');
  drill({ kind: 'harness', value: 'nonsense' });
  assert.deepStrictEqual(ext.filter.sources, []);
});

test('a chip filter sticks while the range changes', () => {
  ext.load(sessions, { days: 0 });
  drill({ kind: 'harness', value: 'vscode' });
  drill({ kind: 'range', value: -1 });
  assert.deepStrictEqual(ext.filter.sources, ['claude', 'copilot']);
  assert.deepStrictEqual(chips(page()), [['claude', true], ['copilot', true], ['vscode', false]]);
  drill({ kind: 'clear' });
  assert.deepStrictEqual(ext.filter.sources, []);
});

test('the status bar follows the tool selection: today\'s cost and the Copilot quota leave with the tool', () => {
  ext.load(sessions, { days: 0 });
  const bar = {};
  ext.attachBar(bar);
  const today = (text) => Number((/AI today \$([\d.]+)/.exec(text) || [])[1]);
  const present = [...new Set(sessions.map((x) => x.source))];
  assert.ok(present.length >= 2, 'the demo data has more than one tool');
  drill({ kind: 'clear' });
  const total = today(bar.text);
  assert.ok(total > 0, 'there is cost today');
  assert.ok(!/ · (Claude Code|Copilot CLI|VS Code chat|\d of \d tools)/.test(bar.text), 'every tool: no scope in the text');
  // a chip click on the full selection leaves that tool out
  let left = 0;
  for (const src of present) {
    drill({ kind: 'clear' });
    drill({ kind: 'harness', value: src });
    const without = today(bar.text);
    assert.match(bar.text, / · (Claude Code|Copilot CLI|VS Code chat|\d of \d tools)/, `${src} left out: the scope is in the text`);
    assert.match(bar.tooltip, /only\./);
    assert.ok(without < total || sessions.every((x) => x.source !== src || !x.prompts.some((p) => new Date(p.ts).toDateString() === new Date().toDateString())), `${src} left out costs less`);
    if (src === 'copilot') assert.ok(!/Copilot \d/.test(bar.text), 'no Copilot quota without Copilot CLI');
    left += total - without;
  }
  assert.ok(Math.abs(left - total) < 0.02 * present.length, `what each tool contributed adds up to the total (${left} vs ${total})`);
  drill({ kind: 'clear' });
  assert.strictEqual(today(bar.text), total, 'clearing the filter brings the total back');
});

test('the overview shows an estimated CO2e tile, labelled as an estimate', () => {
  ext.load(sessions, { days: 0 });
  const html = page();
  assert.match(html, /CO₂e \(est\.\)/);
  assert.match(html, /~[\d.]+ (g|kg) CO₂e/);
  assert.match(html, /not GreenPixie/);
});
