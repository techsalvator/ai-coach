'use strict';
/**
 * Cost per Jira epic or story, for Copilot CLI (AI credits) and, through claude-cost.js --epics,
 * Claude Code (dollars): which tickets the spend went to.
 *
 *   node lib/epic-usage.js                     epics, last 30 days
 *   node lib/epic-usage.js --stories           one row per ticket, with its epic
 *   node lib/epic-usage.js --key FOPTS-29970   one epic or ticket in detail: skills, days, sessions
 *   node lib/epic-usage.js --since 7d --top 10 --repo bill-analysis --csv
 *
 * Copilot does not record a ticket per prompt, so each prompt is attributed from what it left behind:
 *   prompt    the prompt names a ticket ("/design FOPTS-29970")
 *   carried   it names none ("yes", "looks good") and continues the session's current ticket;
 *             a gap of 8+ hours ends that, since it is likely different work
 *   tools     the Jira calls it made point at another ticket than the one carried (or there was none yet)
 *   branch    the git branch name holds a ticket
 * Tickets roll up to their epic where the logs show the link: a ticket created under a parent,
 * or a Jira lookup that returned the parent. Anything else counts as its own top level.
 */

const path = require('path');
const { keysIn } = require('./jira-signals');
const { UsageError } = require('./session-cost');
// Copilot's prompt reader is loaded only when no other source is given (claude-cost passes its own).
const copilot = () => require('./prompt-usage');
const skillOf = (prompt) => copilot().skillOf(prompt);

const GAP_MS = 8 * 3600 * 1000;
const fail = (m) => { throw new UsageError(m); };

function parseArgs(argv) {
  const o = { since: '30d', top: 25, stories: false, key: null, repo: null, projects: null, csv: false, unattributed: false, sort: 'credits', source: 'all' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) fail(`${a} needs a value`); return argv[++i]; };
    if (a === '--since') o.since = val();
    else if (a === '--top') o.top = Number(val());
    else if (a === '--all') o.top = Infinity;
    else if (a === '--stories' || a === '--tickets') o.stories = true;
    else if (a === '--key') o.key = val().toUpperCase();
    else if (a === '--repo') o.repo = val();
    else if (a === '--source') o.source = val();
    else if (a === '--projects') o.projects = val().toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--sort') o.sort = val();
    else if (a === '--csv') o.csv = true;
    else if (a === '--unattributed') o.unattributed = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else fail(`unknown option ${a} (see /cost help)`);
  }
  if (!['credits', 'recent'].includes(o.sort)) fail('--sort takes credits or recent');
  if (!['all', 'cli', 'vscode'].includes(o.source)) fail('--source is one of: all, cli, vscode');
  if (!(o.top > 0)) fail('--top needs a positive number');
  return o;
}

const prefixOf = (k) => k.slice(0, k.lastIndexOf('-'));

/** Project prefixes in use: those seen in Jira calls and branch names, so "UTF-8" and "ADR-15" are not tickets. */
function knownPrefixes(rows, extra) {
  const set = new Set(extra || []);
  for (const r of rows) {
    for (const k of Object.keys((r.jira && r.jira.keys) || {})) set.add(prefixOf(k));
    for (const k of keysIn(r.branch)) set.add(prefixOf(k));
  }
  return set;
}

/** Sets ticket and source on every row (in place); returns the rows. */
function attribute(rows, opts = {}) {
  const prefixes = knownPrefixes(rows, opts.projects);
  const ok = (k) => prefixes.has(prefixOf(k));
  const bySession = new Map();
  for (const r of rows) {
    if (!bySession.has(r.session)) bySession.set(r.session, []);
    bySession.get(r.session).push(r);
  }
  for (const list of bySession.values()) {
    list.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    let topic = null;
    let last = null;
    for (const r of list) {
      if (last && Date.parse(r.ts) - Date.parse(last) > GAP_MS) topic = null;
      last = r.ts;
      const named = keysIn(r.prompt).filter(ok);
      const tools = Object.entries((r.jira && r.jira.keys) || {}).filter(([k]) => ok(k)).sort((a, b) => b[1] - a[1]);
      const branchKey = keysIn(r.branch).filter(ok)[0] || null;
      if (named.length) { topic = named[0]; r.ticket = topic; r.source = 'prompt'; }
      else if (topic && !(tools.length && tools[0][1] >= 2 && !tools.some(([k]) => k === topic))) { r.ticket = topic; r.source = 'carried'; }
      else if (tools.length) { topic = tools[0][0]; r.ticket = topic; r.source = 'tools'; }
      else if (branchKey) { r.ticket = branchKey; r.source = 'branch'; }
      else { r.ticket = null; r.source = null; }
    }
  }
  return rows;
}

/** key -> {type, parent, summary}, merged from every prompt's Jira lookups. */
function ticketMeta(rows) {
  const meta = new Map();
  for (const r of rows) {
    for (const [k, m] of Object.entries((r.jira && r.jira.meta) || {})) {
      const cur = meta.get(k) || {};
      meta.set(k, { type: m.t || cur.type || null, parent: m.p || cur.parent || null, summary: m.s || cur.summary || null });
    }
  }
  return meta;
}

/** A ticket's epic: itself if it is one, else up its known parent chain to the first epic. A ticket
 *  whose chain never reaches a known epic counts as its own top level, or its highest known parent. */
function rootOf(key, meta) {
  let k = key;
  for (let i = 0; i < 4; i++) {
    const m = meta.get(k);
    if (m && m.type === 'Epic') return k;
    if (!m || !m.parent || m.parent === k) return k;
    const pt = (meta.get(m.parent) || {}).type;
    if (pt && /initiative|theme|portfolio/i.test(pt)) return k; // never roll an epic's work up into an initiative
    k = m.parent;
  }
  return k;
}

const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) || 0), 0);
const n2 = (c) => (c == null ? '?' : c.toFixed(2));
const usd = (c) => `$${((c || 0) * 0.01).toFixed(2)}`;

/** How a report shows its amounts. Copilot rows carry AI credits (1 credit = $0.01); Claude rows carry dollars. */
const CREDITS = {
  of: (r) => r.credits,
  heads: ['Credits', 'Cost'],
  cells: (v) => [n2(v), usd(v)],
  total: (v) => `${n2(v)} AI credits (${usd(v)})`,
  plain: (v) => n2(v),
  csv: [['credits', (v) => v.toFixed(2)], ['usd', (v) => (v * 0.01).toFixed(2)]],
  from: (rows) => rows,
};
const DOLLARS = {
  of: (r) => r.usd,
  heads: ['Cost'],
  cells: (v) => [`$${v.toFixed(2)}`],
  total: (v) => `$${v.toFixed(2)} estimated`,
  plain: (v) => `$${v.toFixed(2)}`,
  csv: [['usd', (v) => v.toFixed(2)]],
};

const cell = (s, w) => { const t = String(s ?? '').replace(/\|/g, '\\|'); return t.length > w ? `${t.slice(0, w - 1)}…` : t; };
const day = (ts) => (ts || '').slice(5, 10);
const dayRange = (rs) => { const d = rs.map((r) => r.ts).sort(); return d.length ? (day(d[0]) === day(d[d.length - 1]) ? day(d[0]) : `${day(d[0])} → ${day(d[d.length - 1])}`) : '—'; };

/** "design 62%, story 25%" for a set of rows, by amount. */
function skillMix(rs, n = 3) {
  const by = new Map();
  for (const r of rs) { const s = skillOf(r.prompt) || 'chat'; by.set(s, (by.get(s) || 0) + (r.amount || 0)); }
  const total = sum(rs, (r) => r.amount) || 1;
  return [...by].sort((a, b) => b[1] - a[1]).slice(0, n).map(([s, c]) => `${s} ${Math.round((c / total) * 100)}%`).join(', ');
}

function groups(rows, meta, keyFn) {
  const by = new Map();
  for (const r of rows) {
    if (!r.ticket) continue;
    const k = keyFn(r);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  return [...by].map(([key, rs]) => ({ key, rs, amount: sum(rs, (r) => r.amount) }));
}

function confidence(rows) {
  const by = { prompt: 0, carried: 0, tools: 0, branch: 0 };
  let none = 0;
  for (const r of rows) { if (r.source) by[r.source] += r.amount || 0; else none += r.amount || 0; }
  return { by, none, total: sum(rows, (r) => r.amount) };
}

const mdRow = (cells) => `| ${cells.join(' | ')} |`;
const mdSep = (aligns) => `|${aligns.map((a) => (a === 'r' ? '---:' : '---')).join('|')}|`;

function header(rows, o, conf, title, unit) {
  const attributed = conf.total - conf.none;
  const pct = (x) => `${Math.round((x / (conf.total || 1)) * 100)}%`;
  const from = o.sinceMs ? new Date(o.sinceMs).toISOString().slice(0, 10) : 'the first session';
  return [`# ${title} — since ${from}`, '',
    `${rows.length} prompts, **${unit.total(conf.total)}**; **${unit.plain(attributed)} (${pct(attributed)})** tied to a ticket. `
      + `Attribution by cost: ${pct(conf.by.prompt)} named in the prompt, ${pct(conf.by.carried)} carried from an earlier prompt in the session, `
      + `${pct(conf.by.tools)} from Jira calls, ${pct(conf.by.branch)} from the git branch; ${pct(conf.none)} unattributed.`, ''];
}

const latest = (rs) => rs.map((r) => r.ts).sort().pop();

function epicsTable(rows, meta, o, unit) {
  const all = groups(rows, meta, (r) => rootOf(r.ticket, meta));
  // An epic is a ticket Jira calls an Epic, or one other tickets rolled up into. Anything else is a
  // story, bug or task with no epic the logs show: one row for those together, not a row each.
  const isEpic = (g) => (meta.get(g.key) || {}).type === 'Epic' || new Set(g.rs.map((r) => r.ticket)).size > 1;
  const epics = all.filter(isEpic);
  const loose = all.filter((g) => !isEpic(g)).sort((a, b) => b.amount - a.amount);
  epics.sort(o.sort === 'recent' ? (a, b) => (latest(b.rs) < latest(a.rs) ? -1 : 1) : (a, b) => b.amount - a.amount);
  const total = sum(all, (g) => g.amount) || 1;
  const pct = (v) => `${Math.round((v / total) * 100)}%`;
  const out = [`Top ${Math.min(o.top, epics.length)} epics:`, '',
    mdRow(['Epic', 'Title', 'Prompts', ...unit.heads, 'Share', 'Tickets', 'Sessions', 'Days', 'Cost by skill']),
    mdSep(['l', 'l', 'r', ...unit.heads.map(() => 'r'), 'r', 'r', 'r', 'l', 'l'])];
  for (const g of epics.slice(0, o.top)) {
    const m = meta.get(g.key) || {};
    const tickets = new Set(g.rs.map((r) => r.ticket));
    out.push(mdRow([g.key, cell(m.summary || '', 44), g.rs.length, ...unit.cells(g.amount), pct(g.amount), tickets.size,
      new Set(g.rs.map((r) => r.session)).size, dayRange(g.rs), skillMix(g.rs)]));
  }
  if (loose.length) {
    const rs = loose.flatMap((g) => g.rs);
    const amount = sum(loose, (g) => g.amount);
    const top = loose.slice(0, 3).map((g) => `${g.key} ${unit.plain(g.amount)}`).join(', ');
    out.push(mdRow([`(no epic known)`, cell(`${loose.length} stories, bugs and tasks: ${top}${loose.length > 3 ? ', …' : ''}`, 60), rs.length, ...unit.cells(amount), pct(amount),
      loose.length, new Set(rs.map((r) => r.session)).size, dayRange(rs), skillMix(rs)]));
  }
  out.push('', 'A ticket counts under an epic when the logs show its parent (a Jira lookup or a create under it); `--stories` lists every ticket, with its epic where known. '
    + 'Drill in with `--key <ticket>`.');
  return out;
}

function storiesTable(rows, meta, o, unit) {
  const gs = groups(rows, meta, (r) => r.ticket).sort((a, b) => b.amount - a.amount);
  const total = sum(gs, (g) => g.amount) || 1;
  const out = [`Top ${Math.min(o.top, gs.length)} tickets:`, '',
    mdRow(['Ticket', 'Type', 'Epic', 'Title', 'Prompts', ...unit.heads, 'Share', 'Days', 'Cost by skill']),
    mdSep(['l', 'l', 'l', 'l', 'r', ...unit.heads.map(() => 'r'), 'r', 'l', 'l'])];
  for (const g of gs.slice(0, o.top)) {
    const m = meta.get(g.key) || {};
    const root = rootOf(g.key, meta);
    out.push(mdRow([g.key, m.type || '—', root === g.key ? '—' : root, cell(m.summary || '', 44), g.rs.length, ...unit.cells(g.amount),
      `${Math.round((g.amount / total) * 100)}%`, dayRange(g.rs), skillMix(g.rs)]));
  }
  return out;
}

function keyDetail(rows, meta, o, unit) {
  const k = o.key;
  const rs = rows.filter((r) => r.ticket && (r.ticket === k || rootOf(r.ticket, meta) === k));
  if (!rs.length) fail(`no prompts attributed to ${k} in this window (try --since all)`);
  const m = meta.get(k) || {};
  const amount = sum(rs, (r) => r.amount);
  const out = [`## ${k}${m.type ? ` (${m.type})` : ''}${m.summary ? ` — ${m.summary}` : ''}`, '',
    `**${unit.total(amount)}** over ${rs.length} prompts in ${new Set(rs.map((r) => r.session)).size} sessions, ${dayRange(rs)}.`, ''];
  const table = (title, head, keyFn, labelFn = (x) => x) => {
    const by = new Map();
    for (const r of rs) { const g = keyFn(r); if (!by.has(g)) by.set(g, []); by.get(g).push(r); }
    out.push(title, '', mdRow([head, 'Prompts', ...unit.heads, 'Share']), mdSep(['l', 'r', ...unit.heads.map(() => 'r'), 'r']));
    for (const [g, list] of [...by].sort((a, b) => sum(b[1], (r) => r.amount) - sum(a[1], (r) => r.amount)).slice(0, 15)) {
      const c = sum(list, (r) => r.amount);
      out.push(mdRow([cell(labelFn(g), 48), list.length, ...unit.cells(c), `${Math.round((c / (amount || 1)) * 100)}%`]));
    }
    out.push('');
  };
  table('By skill:', 'Skill', (r) => skillOf(r.prompt) || 'chat (no skill)');
  const tickets = new Set(rs.map((r) => r.ticket));
  if (tickets.size > 1) table('By ticket:', 'Ticket', (r) => r.ticket, (t) => `${t}${(meta.get(t) || {}).summary ? ` — ${meta.get(t).summary}` : ''}`);
  table('By day:', 'Day', (r) => (r.ts || '').slice(0, 10));
  table('By session:', 'Session', (r) => r.session.slice(0, 8));
  const top = [...rs].sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, 8);
  out.push('Most expensive prompts:', '', mdRow(['When (UTC)', 'Session', 'Prompt', ...unit.heads, 'Via']), mdSep(['l', 'l', 'l', ...unit.heads.map(() => 'r'), 'l']));
  for (const r of top) out.push(mdRow([(r.ts || '').slice(5, 16).replace('T', ' '), r.session.slice(0, 8), cell(r.prompt, 52), ...unit.cells(r.amount || 0), r.source]));
  return out;
}

function unattributedTable(rows, o, unit) {
  const rs = rows.filter((r) => !r.ticket).sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, o.top);
  const out = ['Largest prompts not tied to any ticket:', '', mdRow(['When (UTC)', 'Session', 'Repo', 'Prompt', ...unit.heads]), mdSep(['l', 'l', 'l', 'l', ...unit.heads.map(() => 'r')])];
  for (const r of rs) out.push(mdRow([(r.ts || '').slice(5, 16).replace('T', ' '), r.session.slice(0, 8), cell(r.repository || (r.cwd ? path.basename(r.cwd) : '?'), 22), cell(r.prompt, 52), ...unit.cells(r.amount || 0)]));
  return out;
}

function csv(rows, meta, o, unit) {
  const esc = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const cols = ['ticket', 'type', 'epic', 'title', 'prompts', ...unit.csv.map(([name]) => name), 'sessions', 'first', 'last'];
  const lines = [cols.join(',')];
  for (const g of groups(rows, meta, (r) => r.ticket).sort((a, b) => b.amount - a.amount)) {
    const m = meta.get(g.key) || {};
    const ts = g.rs.map((r) => r.ts).sort();
    const root = rootOf(g.key, meta);
    lines.push([g.key, m.type || '', root === g.key ? '' : root, m.summary || '', g.rs.length, ...unit.csv.map(([, f]) => f(g.amount)),
      new Set(g.rs.map((r) => r.session)).size, ts[0], ts[ts.length - 1]].map(esc).join(','));
  }
  return lines.join('\n');
}

const USAGE = 'usage: epic-usage.js [--since 30d|all|DATE] [--stories] [--key TICKET] [--top N] [--repo TEXT] [--projects A,B] [--sort credits|recent] [--unattributed] [--csv]';

/**
 * The report for these arguments, as text.
 *   deps.collect(sinceMs) -> {prompts}   where prompts come from; Copilot's reader by default
 *   deps.unit                            CREDITS (default) or DOLLARS: which field holds the amount
 *   deps.name                            "Copilot" (default) or "Claude Code", for the titles
 */
async function run(argv, deps = {}) {
  const o = parseArgs(argv);
  if (o.help) return USAGE;
  const unit = deps.unit || CREDITS;
  const name = deps.name || 'Copilot';
  o.sinceMs = copilot().parseSince(o.since);
  let { prompts } = await (deps.collect || copilot().collect)(o.sinceMs, { source: o.source });
  prompts = prompts.filter((r) => (r.ts ? Date.parse(r.ts) >= o.sinceMs : true));
  if (o.repo) prompts = prompts.filter((r) => `${r.repository || ''} ${r.cwd || ''}`.toLowerCase().includes(o.repo.toLowerCase()));
  for (const r of prompts) r.amount = unit.of(r) || 0;
  attribute(prompts, o);
  const meta = ticketMeta(prompts);
  if (o.csv) return csv(prompts, meta, o, unit);
  const conf = confidence(prompts);
  if (o.key) return [...header(prompts, o, conf, `${name} cost of ${o.key}`, unit), ...keyDetail(prompts, meta, o, unit)].join('\n');
  const body = o.unattributed ? unattributedTable(prompts, o, unit) : o.stories ? storiesTable(prompts, meta, o, unit) : epicsTable(prompts, meta, o, unit);
  return [...header(prompts, o, conf, o.stories ? `${name} cost per ticket` : `${name} cost per epic`, unit), ...body].join('\n');
}

if (require.main === module) {
  run(process.argv.slice(2)).then(console.log, (err) => {
    console.error(`epic-usage: ${err instanceof UsageError ? err.message : err.stack}`);
    process.exit(1);
  });
}

module.exports = { run, attribute, ticketMeta, rootOf, knownPrefixes, parseArgs, skillMix, CREDITS, DOLLARS };
