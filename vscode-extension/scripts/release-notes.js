'use strict';
// Prints the CHANGELOG section for a version: node scripts/release-notes.js 0.2.0
const fs = require('fs');
const path = require('path');

function notes(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## ${version}`));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

module.exports = { notes };

if (require.main === module) {
  const version = process.argv[2];
  const out = notes(fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'), version);
  if (!out) { console.error(`No CHANGELOG section for ${version}`); process.exit(1); }
  process.stdout.write(`${out}\n`);
}
