'use strict';
// Charts as plain HTML and inline SVG for the webview panels: no libraries, no network.
// Colours are categorical slots 1-4 of the reference palette, validated in both modes; the order is fixed and an
// entity keeps its slot everywhere (a source is always the same colour, a token kind too). Marks are thin, bars
// have a 2px gap, the grid is recessive, and every mark carries a hover tooltip (data-tip) and a visible value
// elsewhere on the page, because aqua and yellow are below 3:1 on a light surface.

const { money, tokens } = require('./model');

const CSS = `
:root{--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--grid:rgba(128,128,128,.22);--ink2:var(--vscode-descriptionForeground)}
body.vscode-dark,body.vscode-high-contrast{--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:12px 0}
.tile{padding:10px 12px;border:1px solid var(--vscode-panel-border);border-radius:6px}
.info{margin:6px 0;padding:6px 10px;border-left:3px solid var(--vscode-textLink-foreground,#3794ff);background:var(--vscode-textBlockQuote-background,transparent);color:var(--ink2);font-size:12px}.info b{color:var(--vscode-foreground);font-weight:600}
.tile b{display:block;font-size:20px;font-weight:500;margin-top:2px}.tile span{color:var(--ink2)}
.chart{margin:6px 0 4px;max-width:780px}.chart svg{width:100%;height:auto;display:block;overflow:visible}
.chart text{fill:var(--ink2);font-size:11px}.chart .ax{stroke:var(--grid)}.chart .bl{stroke:var(--ink2);stroke-width:1}
.chart rect[data-tip]:hover,.seg:hover{filter:brightness(1.15)}
.compact .chart,.compact .stack,.compact .legend,.compact .hb{max-width:none}.compact .tiles{grid-template-columns:1fr 1fr;gap:8px}.compact .tile b{font-size:17px}.compact .hb{grid-template-columns:minmax(50px,110px) 1fr auto}.compact h3{margin:14px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink2);font-weight:500}.compact .legend{gap:2px 12px;font-size:11px}
.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:8px;color:var(--vscode-descriptionForeground)}.crumbs .link{margin:0}.crumbs span+.link{margin-left:10px}.cr{color:var(--vscode-textLink-foreground)}.cr:hover{text-decoration:underline}.sep{font-style:normal;opacity:.6}
.legend.chips{gap:6px 8px}.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--vscode-panel-border);border-radius:12px;padding:2px 10px;background:none;color:var(--vscode-foreground);cursor:pointer;font:inherit}.chip:not(.on){opacity:.45}.chip.on{border-color:var(--vscode-focusBorder)}.chip:hover{background:var(--vscode-list-hoverBackground)}
.sync{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin:6px 0}.sync .link{margin:0}
.range{display:inline-flex;margin-left:auto;border:1px solid var(--vscode-panel-border);border-radius:4px;overflow:hidden}.range button{background:none;border:0;border-right:1px solid var(--vscode-panel-border);color:var(--vscode-foreground);padding:2px 9px;cursor:pointer;font:inherit}.range button:last-child{border-right:0}.range button:hover{background:var(--vscode-list-hoverBackground)}.range button.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.link{margin-top:14px;background:none;border:0;color:var(--vscode-textLink-foreground);cursor:pointer;padding:0;font:inherit}.link:hover{text-decoration:underline}
.stack{display:flex;gap:2px;height:14px;max-width:780px;margin:6px 0}.seg{min-width:2px;border-radius:2px}
.legend{display:flex;flex-wrap:wrap;gap:4px 18px;margin:6px 0 4px;max-width:780px}.legend span{white-space:nowrap}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.hb{display:grid;grid-template-columns:minmax(120px,240px) 1fr 140px;gap:4px 12px;align-items:center;max-width:780px}
.hb .t{background:var(--grid);border-radius:3px;height:8px}.hb .t i{display:block;height:8px;border-radius:3px;background:var(--s1)}
.hb .row{display:contents}.hb .row>div:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hb .row>div:last-child{text-align:right;white-space:nowrap}
[data-drill]{cursor:pointer}[data-drill]:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}.hb .row[data-drill]:hover>div{color:var(--vscode-textLink-foreground)}.hb .row[data-drill]:hover .t i{filter:brightness(1.2)}tr[data-drill]:hover td{background:var(--vscode-list-hoverBackground)}
#tip{position:fixed;pointer-events:none;display:none;padding:4px 8px;border-radius:4px;font-size:12px;z-index:9;white-space:pre;
background:var(--vscode-editorHoverWidget-background);border:1px solid var(--vscode-editorHoverWidget-border);color:var(--vscode-editorHoverWidget-foreground)}`;

// Hover tooltip for anything with data-tip.
const TIP_SCRIPT = `
(function () {
  var tip = document.createElement('div'); tip.id = 'tip'; document.body.appendChild(tip);
  document.addEventListener('mousemove', function (e) {
    var el = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!el) { tip.style.display = 'none'; return; }
    tip.textContent = el.getAttribute('data-tip'); tip.style.display = 'block';
    tip.style.left = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8) + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
  });
})();`;

/** Makes a mark clickable: the webview sends this object to the extension. */
const drillAttr = (d) => (d ? ` data-drill="${esc(JSON.stringify(d))}" tabindex="0" role="button"` : '');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const slot = (i) => `var(--s${i})`;

/** A nice round top for an axis: 1, 2, 5 x 10^n. */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/**
 * Columns, optionally stacked. cols: [{label, tip, parts:[{value, slot, name}]}]. One axis, thin columns,
 * a 2px gap between stacked segments, three recessive gridlines, a label on about every n-th column.
 */
const axisMoney = (v) => (v === 0 ? '$0' : `$${+v.toFixed(v < 1 ? 2 : v < 10 ? 1 : 0)}`);
function columns(cols, { height = 170, width = 760, labels = 12, fmt = money, axis = axisMoney, unit = '' } = {}) {
  const W = width; const L = 40; const B = 22; const T = 8;
  const H = height; const plotH = H - B - T; const plotW = W - L - 4;
  const max = niceMax(Math.max(...cols.map((c) => c.parts.reduce((a, p) => a + (p.value || 0), 0)), 0));
  const slotW = plotW / Math.max(cols.length, 1); const bw = Math.max(2, Math.min(28, slotW * 0.7));
  const y = (v) => T + plotH - (v / max) * plotH;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  for (const f of [0.5, 1]) s += `<line class="ax" x1="${L}" x2="${W - 4}" y1="${y(max * f)}" y2="${y(max * f)}"/><text x="${L - 6}" y="${y(max * f) + 4}" text-anchor="end">${axis(max * f)}${unit}</text>`;
  s += `<line class="bl" x1="${L}" x2="${W - 4}" y1="${y(0)}" y2="${y(0)}"/><text x="${L - 6}" y="${y(0) + 4}" text-anchor="end">${axis(0)}${unit}</text>`;
  const every = Math.ceil(cols.length / labels);
  cols.forEach((c, i) => {
    const x = L + i * slotW + (slotW - bw) / 2;
    let acc = 0;
    c.parts.filter((p) => p.value > 0).forEach((p) => {
      const dr = drillAttr(p.drill || c.drill);
      const top = y(acc + p.value); const h = Math.max(1, y(acc) - top - (acc > 0 ? 2 : 0));
      s += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${slot(p.slot)}"${dr} data-tip="${esc(c.tip)}${p.name ? `\n${esc(p.name)}: ${fmt(p.value)}${unit}` : ''}"/>`;
      acc += p.value;
    });
    if (i % every === 0) s += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(c.label)}</text>`;
  });
  return `<div class="chart">${s}</svg></div>`;
}

/** One horizontal stacked bar with a legend that carries every value: segments [{name, value, slot}]. */
function composition(segments, { fmt = tokens } = {}) {
  const total = segments.reduce((a, x) => a + x.value, 0);
  if (!total) return '<p class="note">No token data.</p>';
  const bar = segments.filter((x) => x.value > 0).map((x) => `<div class="seg" style="flex:${x.value};background:${slot(x.slot)}" data-tip="${esc(x.name)}: ${fmt(x.value)} (${Math.round((x.value / total) * 100)}%)"></div>`).join('');
  const legend = segments.map((x) => `<span><i class="sw" style="background:${slot(x.slot)}"></i>${esc(x.name)} ${fmt(x.value)} · ${Math.round((x.value / total) * 100)}%</span>`).join('');
  return `<div class="stack">${bar}</div><div class="legend">${legend}</div>`;
}

/** Horizontal bars with a value on each: rows [{label, value, text, tip}]. One hue: it is magnitude. */
function hbars(rows) {
  const max = Math.max(...rows.map((r) => r.value), 0.0000001);
  return `<div class="hb">${rows.map((r) => `<div class="row"${drillAttr(r.drill)}><div title="${esc(r.label)}">${esc(r.label)}</div><div class="t" data-tip="${esc(r.tip || r.text)}"><i style="width:${Math.max(1, Math.round((r.value / max) * 100))}%"></i></div><div>${esc(r.text)}</div></div>`).join('')}</div>`;
}

const legend = (items) => `<div class="legend">${items.map((x) => `<span><i class="sw" style="background:${slot(x.slot)}"></i>${esc(x.name)}</span>`).join('')}</div>`;

/** Token kinds in a fixed order and colour, from a split. */
const tokenSegments = (sp) => [
  { name: 'Read from cache', value: sp.cacheRead, slot: 1 }, { name: 'Written to cache', value: sp.cacheWrite, slot: 2 },
  { name: 'New input', value: sp.fresh, slot: 3 }, { name: 'Output', value: sp.out, slot: 4 },
];

// Clicks (and Enter) on anything with data-drill go to the extension, which narrows the filter or opens the item.
const DRILL_SCRIPT = `
(function () {
  var vs = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  function send(el) { var d = el && el.closest ? el.closest('[data-drill]') : null; if (d && vs) vs.postMessage(JSON.parse(d.getAttribute('data-drill'))); }
  document.addEventListener('click', function (e) { send(e.target); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(e.target); });
})();`;

const SOURCE_SLOT = { claude: 1, copilot: 2, vscode: 3 };
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const WEEK_AFTER = 60; // spans longer than this are drawn by week
const monday = (d) => { const x = new Date(d); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const monthKey = (ts) => dayKey(ts).slice(0, 7);
const monthName = (k, long) => new Date(`${k}-01T12:00:00`).toLocaleDateString([], long ? { month: 'long', year: 'numeric' } : { month: 'short' });

/**
 * Cost stacked by source, drawn by day, week or month:
 *   month: 'YYYY-MM'   the days of that month
 *   days: 0            every month from the first prompt (the default overview)
 *   days: -1           every day from the first prompt
 *   days: N            the last N days, by week when that is over 60 days
 * Segments drill: a month bar to that month, a day or week to a filter on it.
 */
function dailyCost(sessions, labels, { days = 0, month = null, now = new Date(), chart = {}, chips = null } = {}) {
  let first = now;
  for (const s of sessions) for (const p of s.prompts) if (new Date(p.ts) < first) first = new Date(p.ts);
  const mode = month || days < 0 ? 'day' : days === 0 ? 'month' : days > WEEK_AFTER ? 'week' : 'day';
  if (days < 0 && !month) days = Math.max(7, Math.ceil((now - first) / 86400000) + 1); // every day since the first prompt
  const key = (ts) => (mode === 'month' ? monthKey(ts) : mode === 'week' ? dayKey(monday(ts)) : dayKey(ts));
  const by = new Map();
  for (const s of sessions) for (const p of s.prompts) {
    const k = key(p.ts); const d = by.get(k) || {};
    d[s.source] = (d[s.source] || 0) + (p.usd || 0); by.set(k, d);
  }
  const starts = [];
  if (month) {
    const [y, m] = month.split('-').map(Number);
    for (let d = new Date(y, m - 1, 1, 12); d.getMonth() === m - 1 && d <= now; d = new Date(y, m - 1, d.getDate() + 1, 12)) starts.push(d);
  } else if (mode === 'month') {
    for (let d = new Date(first.getFullYear(), first.getMonth(), 1, 12); d <= now; d = new Date(d.getFullYear(), d.getMonth() + 1, 1, 12)) starts.push(d);
  } else if (mode === 'week') {
    const from = new Date(now); from.setDate(from.getDate() - (days - 1));
    for (let d = monday(from); d <= now; d = new Date(d.getTime() + 7 * 86400000)) starts.push(new Date(d));
  } else {
    for (let i = days - 1; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); starts.push(d); }
  }
  const cols = starts.map((d) => {
    const k = key(d.toISOString());
    const day = by.get(k) || {};
    const total = Object.values(day).reduce((a, x) => a + x, 0);
    let label; let name; let drill;
    if (mode === 'month') { label = monthName(k.slice(0, 7)); name = monthName(k.slice(0, 7), true); drill = { kind: 'month', value: k.slice(0, 7) }; }
    else if (mode === 'week') { const end = new Date(d.getTime() + 6 * 86400000); label = `${d.getMonth() + 1}/${d.getDate()}`; name = `Week of ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`; drill = { kind: 'day', value: `${dayKey(d)}..${dayKey(end)}` }; }
    else { label = `${d.getMonth() + 1}/${d.getDate()}`; name = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); drill = { kind: 'day', value: dayKey(d) }; }
    return { label, tip: `${name}\nTotal ${money(total)}${mode === 'month' ? '\nClick for its days' : ''}`,
      parts: Object.keys(SOURCE_SLOT).map((k2) => ({ value: day[k2] || 0, slot: SOURCE_SLOT[k2], name: labels[k2], drill: mode === 'month' ? drill : { ...drill, source: k2 } })) };
  });
  const present = Object.keys(SOURCE_SLOT).filter((k) => sessions.some((s) => s.source === k));
  return columns(cols, chart) + (chips ? chipLegend(chips, labels) : present.length > 1 ? legend(present.map((k) => ({ name: labels[k], slot: SOURCE_SLOT[k] }))) : '');
}

/**
 * The legend as the control: one chip per tool, clickable to include or leave it out. chips: {tools: [source keys, all that
 * exist], active: (key) => bool}. It replaces a plain legend, so the colours are explained and chosen in one place.
 */
function chipLegend({ tools, active }, labels) {
  return `<div class="legend chips">${tools.map((k) => `<button class="chip${active(k) ? ' on' : ''}" aria-pressed="${active(k)}" title="${active(k) ? 'Click to leave out' : 'Click to include'} ${esc(labels[k])}"${drillAttr({ kind: 'harness', value: k })}><i class="sw" style="background:${slot(SOURCE_SLOT[k])}"></i>${esc(labels[k])}</button>`).join('')}</div>`;
}

/** Cost per month and source, newest first: [{month, total, bySource:{claude, ...}, sessions, prompts}]. */
function monthTotals(sessions) {
  const by = new Map();
  for (const s of sessions) for (const p of s.prompts) {
    const k = monthKey(p.ts); const m = by.get(k) || { month: k, total: 0, bySource: {}, prompts: 0, ids: new Set() };
    m.total += p.usd || 0; m.bySource[s.source] = (m.bySource[s.source] || 0) + (p.usd || 0); m.prompts++; m.ids.add(s.id); by.set(k, m);
  }
  return [...by.values()].sort((a, b) => (a.month < b.month ? 1 : -1)).map((m) => ({ ...m, sessions: m.ids.size }));
}

module.exports = { monthTotals, monthName, CSS, TIP_SCRIPT, DRILL_SCRIPT, columns, composition, hbars, legend, tokenSegments, dailyCost, niceMax, SOURCE_SLOT };
