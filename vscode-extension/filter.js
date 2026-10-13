'use strict';
// Narrows loaded sessions to the prompts that match. Pure, so it is tested without VS Code.
const { subset } = require('./model');

const DAY = 86400000;
const PERIODS = { all: 0, today: 1, week: 7, month: 30 };
const PERIOD_LABEL = { all: 'All time', today: 'Today', week: 'Last 7 days', month: 'Last 30 days' };
const SOURCE_LABEL = { claude: 'Claude Code', copilot: 'Copilot CLI', vscode: 'VS Code chat' };
const EMPTY = { period: 'all', day: '', sources: [], models: [], minUsd: 0, text: '' };
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const isActive = (f) => f.period !== 'all' || f.day !== '' || f.sources.length > 0 || f.models.length > 0 || f.minUsd > 0 || f.text.trim() !== '';

/** Models seen in the sessions, most used first. */
function modelsIn(sessions) {
  const n = new Map();
  for (const s of sessions) for (const m of s.models) n.set(m.model, (n.get(m.model) || 0) + m.calls);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
}

/** Sources present in the sessions. */
const sourcesIn = (sessions) => ['claude', 'copilot', 'vscode'].filter((k) => sessions.some((s) => s.source === k));

/** `day` is one day (YYYY-MM-DD) or a range (YYYY-MM-DD..YYYY-MM-DD). */
function inDay(ts, day) {
  const k = dayKey(ts); const [a, b] = day.split('..');
  return b ? k >= a && k <= b : k === a;
}
const dayLabel = (k) => new Date(`${k}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });

function startOf(period, now) {
  if (period === 'all') return 0;
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  return d.getTime() - (PERIODS[period] - 1) * DAY;
}

/** Sessions reduced to matching prompts. A session with none left is dropped. */
function applyFilter(sessions, f, now = Date.now()) {
  if (!isActive(f)) return sessions;
  const from = startOf(f.period, now);
  const words = f.text.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const s of sessions) {
    if (f.sources.length && !f.sources.includes(s.source)) continue;
    const hay = `${s.title} ${s.id} ${s.cwd || ''} ${s.branch || ''}`.toLowerCase();
    const keep = s.prompts.filter((p) => {
      if (Date.parse(p.ts) < from) return false;
      if (f.day && !inDay(p.ts, f.day)) return false;
      if ((p.usd || 0) < f.minUsd) return false;
      if (f.models.length && !p.models.some((m) => f.models.includes(m))) return false;
      const text = `${p.text.toLowerCase()} ${hay}`;
      return words.every((w) => text.includes(w));
    });
    if (keep.length) out.push(keep.length === s.prompts.length ? s : subset(s, keep));
  }
  return out;
}

/** Sessions reduced to the prompts of the last `days` days (0 = all of them). */
function lastDays(sessions, days, now = Date.now()) {
  if (!days || days < 0) return sessions; // 0 and -1 (by month, by day) both mean everything loaded
  const from = startOf('today', now) - (days - 1) * DAY;
  const out = [];
  for (const s of sessions) {
    const keep = s.prompts.filter((p) => Date.parse(p.ts) >= from);
    if (keep.length) out.push(keep.length === s.prompts.length ? s : subset(s, keep));
  }
  return out;
}

/** A short description of what is filtered, for the view header. */
function describe(f) {
  const parts = [];
  if (f.period !== 'all') parts.push(PERIOD_LABEL[f.period]);
  if (f.day) { const [a, b] = f.day.split('..'); parts.push(b ? `${dayLabel(a)} to ${dayLabel(b)}` : dayLabel(a)); }
  if (f.sources.length) parts.push(f.sources.map((k) => SOURCE_LABEL[k]).join(', '));
  if (f.models.length) parts.push(f.models.join(', '));
  if (f.minUsd > 0) parts.push(`≥ $${f.minUsd}`);
  if (f.text.trim()) parts.push(`"${f.text.trim()}"`);
  return parts.join(' · ');
}

module.exports = { lastDays, dayKey, SOURCE_LABEL, sourcesIn, EMPTY, PERIOD_LABEL, isActive, modelsIn, applyFilter, describe };
