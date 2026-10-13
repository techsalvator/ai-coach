// node --test test/*.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const premium = require('../lib/premium');

const NOW = new Date(2026, 9, 8, 17).getTime(); // a Thursday afternoon, local time
const ev = (type, at, data) => `${JSON.stringify({ type, data, id: 'x', timestamp: new Date(at).toISOString() })}\n`;
const snap = (used, o = {}) => ev('model.model_call_success', NOW, { quotaSnapshots: { premium_interactions: { isUnlimitedEntitlement: false, entitlementRequests: 7600, usedRequests: used, remainingPercentage: 80, resetDate: '2026-11-01T00:00:00Z', ...o } } });
const ckpt = (total, at) => ev('session.usage_checkpoint', at, { totalNanoAiu: 1, totalPremiumRequests: total });

function home(sessions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'premium-'));
  for (const [id, { text, at = NOW }] of Object.entries(sessions)) {
    const dir = path.join(root, 'session-state', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'events.jsonl'), text);
    fs.utimesSync(path.join(dir, 'events.jsonl'), new Date(at), new Date(at));
  }
  return { COPILOT_HOME: root };
}

test('the quota reading is found however far back it is in the log, not only in its tail', () => {
  const filler = ev('assistant.message', NOW, { content: 'x'.repeat(1000) }).repeat(900); // about 0.9 MB after the reading
  const q = premium.read(home({ a: { text: snap(1505) + filler } }), NOW);
  assert.strictEqual(q.used, 1505);
  assert.strictEqual(q.stale, false);
});

test('the newest reading wins across logs: the most used of the latest period, not the newest file', () => {
  const env = home({
    old: { text: snap(768), at: NOW - 26 * 3600e3 },
    active: { text: snap(1094) + snap(1505) + ckpt(3, NOW - 60e3) },
    quiet: { text: ckpt(1, NOW - 30e3), at: NOW + 1000 }, // written last, with no reading in it
    lastMonth: { text: snap(7000, { resetDate: '2026-10-01T00:00:00Z' }), at: NOW - 3600e3 },
  });
  assert.strictEqual(premium.read(env, NOW).used, 1505);
});

test('a reading quoted inside a message is not a reading', () => {
  const quoted = ev('user.message', NOW, { content: JSON.stringify({ premium_interactions: { usedRequests: 9999 } }) });
  assert.strictEqual(premium.read(home({ a: { text: snap(12) + quoted } }), NOW).used, 12);
  assert.strictEqual(premium.read(home({ b: { text: quoted } }), NOW), null);
});

test('today\'s use is how much the sessions\' running totals grew since midnight', () => {
  const yesterday = NOW - 24 * 3600e3;
  const env = home({
    a: { text: ckpt(5, yesterday) + ckpt(9, yesterday + 60e3) + ckpt(12, NOW - 3600e3) + ckpt(16, NOW - 60e3) }, // 7 today
    b: { text: ckpt(2.5, NOW - 120e3) },                                                                          // a new session: 2.5
    c: { text: ckpt(40, yesterday), at: yesterday },                                                               // not touched today
  });
  assert.strictEqual(premium.usedToday(env, NOW), 9.5);
});

test('a total that drops is a resumed session counting from zero; quoted totals and later events do not count', () => {
  const env = home({
    a: { text: ckpt(30, NOW - 26 * 3600e3) + ckpt(2, NOW - 3600e3) + ckpt(3, NOW - 60e3)
      + ev('user.message', NOW - 30e3, { content: '{"type":"session.usage_checkpoint","data":{"totalPremiumRequests":900}}' })
      + ckpt(50, NOW + 3600e3) },
  });
  assert.strictEqual(premium.usedToday(env, NOW), 3);
  assert.strictEqual(premium.usedToday(home({}), NOW), 0);
});
