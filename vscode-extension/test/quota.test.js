'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Quota = require('../quota');

function home(snap, extra = '') {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-'));
  const d = path.join(h, 'session-state', 's1');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'events.jsonl'), `{"a":1,"quotaSnapshots":{"premium_interactions":${JSON.stringify(snap)}}}\n${extra}`);
  return { COPILOT_HOME: h };
}
const snap = (o) => ({ isUnlimitedEntitlement: false, entitlementRequests: 300, usedRequests: 100, overage: 0, remainingPercentage: 66.7, resetDate: '2026-11-01T00:00:00Z', ...o });

test('reads the newest premium quota reading', () => {
  const q = Quota.read(home(snap({})), Date.parse('2026-10-16T00:00:00Z'));
  assert.equal(q.entitlement, 300);
  assert.equal(q.used, 100);
  assert.equal(q.leftPct, 66.7);
  assert.equal(q.stale, false);
});

test('a reading whose reset date has passed is stale', () => {
  assert.equal(Quota.read(home(snap({})), Date.parse('2026-11-02T00:00:00Z')).stale, true);
});

test('no log, no reading', () => {
  assert.equal(Quota.read({ COPILOT_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'quota-')) }), null);
});

test('pace projects the month from the days gone and flags going over', () => {
  const now = Date.parse('2026-10-16T00:00:00Z'); // 15 of 31 days
  const p = Quota.pace(Quota.read(home(snap({ usedRequests: 200 })), now), now);
  assert.equal(p.projected, Math.round((200 / 15) * 31));
  assert.equal(p.over, true);
  assert.equal(p.daysLeft, 16);
});

test('unlimited plans have no pace', () => {
  const now = Date.parse('2026-10-16T00:00:00Z');
  assert.equal(Quota.pace(Quota.read(home(snap({ isUnlimitedEntitlement: true })), now), now), null);
});

test('summary gives the status-bar text, and flags a pace over the plan', () => {
  const now = Date.parse('2026-10-16T00:00:00Z');
  const ok = Quota.summary(Quota.read(home(snap({ usedRequests: 100 })), now), now);
  assert.match(ok.text, /^Copilot 200 left \(66\.7%\)/);
  assert.equal(ok.over, false);
  assert.equal(Quota.summary(Quota.read(home(snap({ usedRequests: 200 })), now), now).over, true);
  assert.equal(Quota.summary(null), null);
});

test('budget spreads what is left over the weekdays to the reset date', () => {
  // Thursday 15 Oct 2026 to the reset on 1 Nov: Oct 15, 16, 19-23, 26-30 = 12 weekdays
  const now = new Date(2026, 9, 15, 12).getTime();
  const q = Quota.read(home(snap({ usedRequests: 100 })), now);
  const b = Quota.budget(q, now);
  assert.equal(b.days, 12);
  assert.equal(b.left, 200);
  assert.equal(b.perDay, Math.floor(200 / 12));
  assert.equal(b.todayCounts, true);
  assert.equal(Quota.budget(q, now, { todayUsed: 40 }).perDay, Math.floor(240 / 12), 'what today used is added back');
});

test('on a weekend today is not counted', () => {
  const now = new Date(2026, 9, 17, 12).getTime(); // Saturday
  const b = Quota.budget(Quota.read(home(snap({})), now), now);
  assert.equal(b.todayCounts, false);
  assert.equal(b.days, 10);
});

test('the status text carries the daily budget and today so far', () => {
  const now = new Date(2026, 9, 15, 12).getTime();
  const q = Quota.read(home(snap({ usedRequests: 100 })), now);
  assert.match(Quota.summary(q, now, { today: 3 }).text, /· 3\/16\/day$/);
  assert.match(Quota.summary(q, now).text, /· 16\/day$/);
});

test('a daily budget you set replaces the computed one', () => {
  const now = new Date(2026, 9, 15, 12).getTime();
  const q = Quota.read(home(snap({ usedRequests: 100 })), now);
  const b = Quota.budget(q, now, { fixed: 50 });
  assert.equal(b.perDay, 50);
  assert.equal(b.fixed, true);
  assert.match(Quota.summary(q, now, { today: 3, fixed: 50 }).text, /· 3\/50\/day$/);
  assert.equal(Quota.summary(q, now, { today: 51, fixed: 50 }).over, true);
  assert.equal(Quota.summary(q, now, { today: 49, fixed: 50 }).over, false);
});
