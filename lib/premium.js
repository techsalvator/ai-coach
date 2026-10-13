'use strict';
// Copilot's premium requests: the month's quota, and today's use.
// Quota: Copilot writes the plan's entitlement, the requests used and the reset date into its session log
// (quotaSnapshots.premium_interactions, on some model calls); the newest reading wins.
// Today: the running total every session log keeps (totalPremiumRequests).

const fs = require('fs');
const os = require('os');
const path = require('path');

const FILES = 20;              // the most recently written session logs
const MAX_SCAN = 64 << 20;     // of each, at most this much from the end
const CHUNK = 4 << 20;
const SNAP = Buffer.from('"premium_interactions":');
const TOTAL = Buffer.from('"totalPremiumRequests":');

const stateDir = (env = process.env) => path.join(env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'session-state');

/** The session logs, newest first: [{f, mtime, size}]. */
function logs(env) {
  const dir = stateDir(env);
  try {
    return fs.readdirSync(dir).map((d) => {
      const f = path.join(dir, d, 'events.jsonl');
      try { const st = fs.statSync(f); return { f, mtime: st.mtimeMs, size: st.size }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

/**
 * The last quota reading in a log, searched from the end. Readings are rare in a Copilot session inside VS Code (a few in
 * a 19 MB log), so the whole file is searched, not just its tail: a tail-only search loses the reading as the log grows.
 */
function lastSnapshot(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    let end = size;
    const floor = Math.max(0, size - MAX_SCAN);
    while (end > floor) {
      const start = Math.max(floor, end - CHUNK);
      const len = Math.min(size - start, end - start + 2048); // overlap: a reading that straddles two chunks
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      for (let i = buf.lastIndexOf(SNAP); i >= 0; i = i > 0 ? buf.lastIndexOf(SNAP, i - 1) : -1) {
        const close = buf.indexOf(0x7d, i); // "}"
        if (close < 0) continue;
        try {
          const o = JSON.parse(buf.toString('utf8', i + SNAP.length, close + 1));
          if (Number.isFinite(o.usedRequests)) return o;
        } catch { /* a cut-off object */ }
      }
      end = start;
    }
  } finally { fs.closeSync(fd); }
  return null;
}

const seen = new Map(); // file -> {size, mtime, snap}: a log that has not grown is not searched again (the extension asks often)

/** The newest premium-quota reading, or null: { entitlement, used, leftPct, resets, ts, unlimited, overage, stale }. */
function read(env = process.env, now = Date.now()) {
  let best = null;
  for (const x of logs(env).slice(0, FILES)) {
    let c = seen.get(x.f);
    if (!c || c.size !== x.size || c.mtime !== x.mtime) {
      let snap = null;
      try { snap = lastSnapshot(x.f, x.size); } catch { /* unreadable: skip */ }
      c = { size: x.size, mtime: x.mtime, snap };
      seen.set(x.f, c);
    }
    const s = c.snap;
    if (!s) continue;
    // The newest reading is the one of the latest period with the most used: `usedRequests` only grows within a month.
    const newer = !best || String(s.resetDate || '') > String(best.s.resetDate || '')
      || (String(s.resetDate || '') === String(best.s.resetDate || '') && s.usedRequests > best.s.usedRequests);
    if (newer) best = { s, mtime: x.mtime };
  }
  if (!best) return null;
  const { s } = best;
  const resets = s.resetDate || null;
  return {
    unlimited: !!s.isUnlimitedEntitlement,
    entitlement: s.entitlementRequests,
    used: s.usedRequests,
    leftPct: s.remainingPercentage,
    overage: s.overage || 0,
    resets,
    ts: new Date(best.mtime).toISOString(),
    stale: !!resets && Date.parse(resets) <= now, // the reading is from a month that has ended
  };
}

/**
 * Premium requests used today (local day) in this machine's Copilot sessions. Every session log keeps a running total
 * (`totalPremiumRequests`, at each usage checkpoint and shutdown), in Copilot CLI and in VS Code alike; today's use is
 * how much those totals grew since midnight. A total that drops is a session resumed by an older Copilot, counting from zero.
 */
function usedToday(env = process.env, now = Date.now()) {
  const t = new Date(now);
  const midnight = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  let sum = 0;
  for (const x of logs(env)) {
    if (x.mtime < midnight) break; // newest first: the rest were not written today
    let buf;
    try { buf = fs.readFileSync(x.f); } catch { continue; }
    let prev = 0;
    for (let i = buf.indexOf(TOTAL); i >= 0; i = buf.indexOf(TOTAL, i + 1)) {
      const start = buf.lastIndexOf(0x0a, i) + 1;
      const head = buf.toString('utf8', start, Math.min(start + 40, buf.length));
      if (!head.startsWith('{"type":"session.usage_checkpoint"') && !head.startsWith('{"type":"session.shutdown"')) continue;
      let end = buf.indexOf(0x0a, i);
      if (end < 0) end = buf.length;
      let e;
      try { e = JSON.parse(buf.toString('utf8', start, end)); } catch { continue; }
      const total = e.data && e.data.totalPremiumRequests;
      if (!Number.isFinite(total)) continue;
      const grew = total >= prev ? total - prev : total;
      prev = total;
      if (Date.parse(e.timestamp) >= midnight && Date.parse(e.timestamp) <= now) sum += grew;
      i = end;
    }
  }
  return Math.round(sum * 10) / 10;
}

/**
 * The daily budget: what the day started with, spread over the weekdays left until the reset (Monday to Friday,
 * today included while it is one). `fixed` is a number you set, which replaces the calculation; `todayUsed` is
 * what today has used so far, added back so the figure does not shrink as the day goes on.
 * Days are local calendar days; the period ends on the reset date.
 */
function budget(q, now = Date.now(), { fixed = 0, todayUsed = 0 } = {}) {
  if (!q || q.unlimited || q.stale || !q.resets || !(q.entitlement > 0)) return null;
  const r = new Date(q.resets);
  const endKey = Date.UTC(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate());
  const t = new Date(now);
  let day = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  let counted = 0;
  let todayCounts = false;
  for (let i = 0; Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) < endKey && i < 400; i++) {
    const dow = day.getDay();
    if (dow !== 0 && dow !== 6) { counted++; if (i === 0) todayCounts = true; }
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  }
  const left = Math.max(0, q.entitlement - q.used);
  const start = left + Math.max(0, todayUsed);
  return { days: counted, todayCounts, left, fixed: fixed > 0, perDay: fixed > 0 ? fixed : counted ? Math.floor(start / counted) : start };
}

module.exports = { read, budget, usedToday, stateDir };
