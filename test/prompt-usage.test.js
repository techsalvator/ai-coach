// node --test test/prompt-usage.test.js
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const { skillOf, parseSince, uptime, GROUPS } = require('../lib/prompt-usage');

test('up time counts only the part of each run inside the window', () => {
  const runs = [['2026-09-01T00:00:00Z', '2026-09-01T02:00:00Z'], ['2026-09-02T00:00:00Z', '2026-09-02T01:00:00Z']];
  assert.strictEqual(uptime(runs, 0), 3 * 3600);
  assert.strictEqual(uptime(runs, Date.parse('2026-09-01T01:00:00Z')), 2 * 3600);
  assert.strictEqual(uptime([], 0), 0);
});

test('skill is the leading slash command, not a leading path', () => {
  assert.strictEqual(skillOf('/backlog FOPTS-1'), '/backlog');
  assert.strictEqual(skillOf('/stats'), '/stats');
  assert.strictEqual(skillOf('/Users/harish/file.go fix this'), '(chat)');
  assert.strictEqual(skillOf('fix the /backlog skill'), '(chat)');
});

test('--since accepts relative spans, all, and dates', () => {
  const now = Date.now();
  assert.ok(Math.abs(parseSince('7d') - (now - 7 * 86400e3)) < 1000);
  assert.ok(Math.abs(parseSince('12h') - (now - 12 * 3600e3)) < 1000);
  assert.strictEqual(parseSince('all'), 0);
  assert.strictEqual(parseSince('2026-09-01'), Date.parse('2026-09-01'));
});

test('repo groups by repository, else the folder name', () => {
  assert.strictEqual(GROUPS.repo({ repository: 'flexera/x', cwd: '/a/b' }), 'flexera/x');
  assert.strictEqual(GROUPS.repo({ repository: null, cwd: '/a/b' }), 'b');
});
