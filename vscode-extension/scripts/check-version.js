'use strict';
// A pull request that changes what the extension ships must bump the version in vscode-extension/package.json,
// and give the new version a section in vscode-extension/CHANGELOG.md.
//   node scripts/check-version.js <base-ref>      e.g. origin/main (compares HEAD with where it branched off)
const { execFileSync } = require('child_process');
const path = require('path');
const { notes } = require('./release-notes');

// What the .vsix carries as code: the extension itself, the report code, the hook and the token logger. Tests, scripts
// and the docs (README, CHANGELOG) change nothing a user runs.
const ext = (f) => f.startsWith('vscode-extension/')
  && !/^vscode-extension\/(test|scripts)\//.test(f)
  && !/^vscode-extension\/(CHANGELOG\.md|README\.md|\.gitignore|\.vscodeignore)$/.test(f);
const shipped = (f) => ext(f) || /^(lib|bin|extensions)\//.test(f);

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? m.slice(1).map(Number) : null;
};
const newer = (a, b) => { // a > b
  const x = parse(a); const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/** The reasons a pull request fails the check (none: it passes). */
function check({ changed, baseVersion, headVersion, changelog }) {
  const files = changed.filter(shipped);
  if (!files.length) return [];
  const errors = [];
  if (!newer(headVersion, baseVersion)) {
    errors.push(`vscode-extension/package.json is at ${headVersion}, which is not above ${baseVersion} on the base branch. `
      + `This pull request changes what the extension ships (${files.slice(0, 5).join(', ')}${files.length > 5 ? `, and ${files.length - 5} more` : ''}), so bump the version.`);
  } else if (!notes(changelog, headVersion)) {
    errors.push(`vscode-extension/CHANGELOG.md has no "## ${headVersion}" section (or it is empty). Describe what changed in this version.`);
  }
  return errors;
}

module.exports = { check, shipped, newer };

if (require.main === module) {
  const base = process.argv[2];
  if (!base) { console.error('usage: check-version.js <base-ref>'); process.exit(2); }
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8', cwd: path.join(__dirname, '..', '..') });
  const changed = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
  const pkg = (s) => JSON.parse(s).version;
  const errors = check({
    changed,
    baseVersion: pkg(git('show', `${base}:vscode-extension/package.json`)),
    headVersion: pkg(git('show', 'HEAD:vscode-extension/package.json')),
    changelog: git('show', 'HEAD:vscode-extension/CHANGELOG.md'),
  });
  if (errors.length) { for (const e of errors) console.error(`::error::${e}`); process.exit(1); }
  console.log(changed.some(shipped) ? 'Version bumped, and the CHANGELOG describes it.' : 'No shipped files changed: no version bump needed.');
}
