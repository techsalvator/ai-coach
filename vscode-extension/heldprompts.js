'use strict';
// Prompts that strict mode held in VS Code's chat. VS Code stops such a prompt but never shows the hook's reason, so the hook
// leaves each one in a folder (lib/coach.js writeHeld) and the extension shows it as a notification. No VS Code dependency.

const fs = require('fs');
const path = require('path');
const { libDir } = require('./model');
const coach = require(path.join(libDir, 'coach.js'));

const MAX_AGE_MS = 60e3; // a held prompt older than this is not shown: you have moved on

/** Held prompts not shown yet, oldest first, each with its `file`. Unreadable and stale ones are deleted. */
function pending(env = process.env, now = Date.now()) {
  let files = [];
  try { files = fs.readdirSync(coach.heldDir(env)).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    const file = path.join(coach.heldDir(env), f);
    let rec;
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { try { fs.unlinkSync(file); } catch { /* gone */ } continue; }
    if (!(now - rec.ts <= MAX_AGE_MS)) { try { fs.unlinkSync(file); } catch { /* gone */ } continue; }
    out.push({ ...rec, file });
  }
  return out;
}
const remove = (rec) => { try { fs.unlinkSync(rec.file); } catch { /* shown by another window */ } };

/** The notification's line: why it was held, without markdown. */
function message(rec) {
  const first = String(rec.banner || '').split('\n')[0]
    .replace(/\*\*Prompt check \(ai-cost-drilldown\): not sent\.\*\*\s*/, '').replace(/\*\*/g, '').replace(/`/g, '');
  const text = `Prompt held: ${first}`;
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inline = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/(^|\s)_([^_]+)_(?=\s|$|[.,])/g, '$1<i>$2</i>');

/** The banner's markdown as HTML: paragraphs, bullets, quotes, bold, code and italics. Everything is escaped first. */
function bannerHtml(rec) {
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; } };
  for (const line of String(rec.banner || '').split('\n')) {
    if (/^- /.test(line)) { (list = list || []).push(`<li>${inline(line.slice(2))}</li>`); continue; }
    close();
    if (/^> /.test(line)) out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  close();
  return out.join('\n');
}

module.exports = { pending, remove, message, bannerHtml, MAX_AGE_MS, dir: (env = process.env) => coach.heldDir(env), beat: coach.touchNotifier, stop: coach.clearNotifier };
