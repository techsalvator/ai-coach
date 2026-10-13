'use strict';
/**
 * Plain-text rendering of the markdown the cost reports produce, for places that show raw
 * text (Claude Code's `!` output, a terminal, a file): tables become aligned box tables
 * that wrap long cells to the width, headings are underlined, and the **bold**, `code`
 * and _italic_ marks are dropped. Copilot CLI renders the markdown itself, so its /cost
 * does not use this.
 *
 *   const { prettyMarkdown } = require('./pretty');
 *   prettyMarkdown(text, { width: 120 })
 */

const MIN_TEXT_COL = 14; // narrowest a wrapping (left-aligned) column is squeezed to
const MAX_LINES = 4; // a cell wraps onto at most this many lines, then ends in …

const strip = (s) => s
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:]|$)/g, '$1$2');

const len = (s) => Array.from(s).length;
const pad = (s, w, align) => {
  const gap = Math.max(0, w - len(s));
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + s + ' '.repeat(gap - Math.floor(gap / 2));
  return s + ' '.repeat(gap);
};

/** Cells of a markdown table row; \| inside a cell is a literal pipe. */
function cellsOf(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++; }
    else if (t[i] === '|') { out.push(cur.trim()); cur = ''; }
    else cur += t[i];
  }
  out.push(cur.trim());
  return out;
}

/** Wraps text to width, on spaces where possible; a word longer than the width is split. */
function wrap(text, width) {
  if (len(text) <= width) return [text];
  const lines = [];
  let line = '';
  for (let word of text.split(/\s+/)) {
    while (len(word) > width) {
      if (line) { lines.push(line); line = ''; }
      const chars = Array.from(word);
      // Break after a hyphen or slash when there is one in the first half, else at the width.
      const head = chars.slice(0, width).join('');
      const cut = Math.max(head.lastIndexOf('-'), head.lastIndexOf('/'));
      const at = cut >= width / 2 ? cut + 1 : width;
      lines.push(chars.slice(0, at).join(''));
      word = chars.slice(at).join('');
    }
    if (!line) line = word;
    else if (len(line) + 1 + len(word) <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  if (lines.length > MAX_LINES) {
    const kept = lines.slice(0, MAX_LINES);
    const last = Array.from(kept[MAX_LINES - 1]);
    kept[MAX_LINES - 1] = `${last.slice(0, Math.max(0, width - 1)).join('')}…`;
    return kept;
  }
  return lines;
}

/** One markdown table (header, separator, body rows) as a box table. */
function renderTable(header, aligns, body, width) {
  const n = header.length;
  const rows = [header, ...body.map((r) => { const c = r.slice(0, n); while (c.length < n) c.push(''); return c; })];
  // A column is as wide as its body needs; its header may wrap, down to its longest word.
  const longestWord = (t) => Math.max(1, ...t.split(/\s+/).map(len));
  const natural = Array.from({ length: n }, (_, i) => Math.max(longestWord(header[i]), ...body.map((r) => len(r[i] ?? ''))));
  const w = natural.slice();
  const overhead = 3 * n + 1;
  const fit = () => w.reduce((a, b) => a + b, 0) + overhead;
  // Squeeze the widest text column first, down to a floor; number columns (right-aligned)
  // never go below their widest value, so a figure is not split across lines. If it still does
  // not fit, the table is left wider than the width: the terminal wraps it, nothing is cut.
  const floor = natural.map((nat, i) => (aligns[i] === 'right' ? nat : Math.min(nat, Math.max(MIN_TEXT_COL, longestWord(header[i])))));
  while (fit() > width) {
    let best = -1;
    for (let i = 0; i < n; i++) if (aligns[i] !== 'right' && w[i] > floor[i] && (best < 0 || w[i] > w[best])) best = i;
    if (best < 0) break;
    w[best]--;
  }
  const bar = (l, m, r) => `${l}${w.map((x) => '─'.repeat(x + 2)).join(m)}${r}`;
  const wrapped = rows.map((r) => r.map((c, i) => wrap(c, w[i])));
  const multi = wrapped.slice(1).some((r) => r.some((c) => c.length > 1));
  const out = [bar('┌', '┬', '┐')];
  wrapped.forEach((cells, ri) => {
    const height = Math.max(...cells.map((c) => c.length));
    for (let l = 0; l < height; l++) {
      out.push(`│ ${cells.map((c, i) => pad(c[l] ?? '', w[i], ri === 0 ? (aligns[i] === 'right' ? 'right' : 'left') : aligns[i])).join(' │ ')} │`);
    }
    if (ri === 0) out.push(bar('├', '┼', '┤'));
    else if (multi && ri < wrapped.length - 1) out.push(bar('├', '┼', '┤'));
  });
  out.push(bar('└', '┴', '┘'));
  return out;
}

const isSeparator = (line) => /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(line);
const alignOf = (c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : 'left');

/** The markdown text as plain text. width: columns to fit tables into (default 140). */
function prettyMarkdown(text, { width = 140 } = {}) {
  const lines = String(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|/.test(lines[i]) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const header = cellsOf(strip(lines[i]));
      const aligns = cellsOf(lines[i + 1]).map(alignOf);
      const body = [];
      let j = i + 2;
      while (j < lines.length && /^\s*\|/.test(lines[j])) { body.push(cellsOf(strip(lines[j]))); j++; }
      out.push(...renderTable(header, aligns, body, width));
      i = j - 1;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(lines[i]);
    if (h) {
      const title = strip(h[2]);
      out.push(title, (h[1].length === 1 ? '═' : '─').repeat(Math.min(len(title), width)));
      continue;
    }
    out.push(strip(lines[i]).replace(/^(\s*)- /, '$1• '));
  }
  return out.join('\n');
}

module.exports = { prettyMarkdown, renderTable, cellsOf, wrap, strip };
