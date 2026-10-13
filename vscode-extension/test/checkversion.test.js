'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { check, shipped, newer } = require('../scripts/check-version');

const log = '# Changelog\n\n## 0.3.0\n\n- new\n\n## 0.2.0 (2026-10-08)\n\n- old\n';
const run = (changed, baseVersion, headVersion, changelog = log) => check({ changed, baseVersion, headVersion, changelog });

test('what counts as shipped: the extension, lib, bin and the logger; not tests, scripts or docs', () => {
  for (const f of ['vscode-extension/extension.js', 'vscode-extension/package.json', 'vscode-extension/media/icon.png', 'lib/coach.js', 'bin/cost.js', 'extensions/ai-cost/extension.mjs']) assert.ok(shipped(f), f);
  for (const f of ['vscode-extension/test/a.test.js', 'vscode-extension/scripts/x.js', 'vscode-extension/CHANGELOG.md', 'vscode-extension/README.md', 'README.md', 'test/coach.test.js', '.github/workflows/vscode-extension.yml', 'docs/images/a.png']) assert.ok(!shipped(f), f);
});

test('nothing shipped changed: no bump needed', () => {
  assert.deepStrictEqual(run(['README.md', 'vscode-extension/test/a.test.js', 'vscode-extension/CHANGELOG.md'], '0.2.0', '0.2.0'), []);
});

test('shipped files changed without a bump fail, and say which', () => {
  const e = run(['lib/coach.js', 'README.md'], '0.2.0', '0.2.0');
  assert.strictEqual(e.length, 1);
  assert.match(e[0], /0\.2\.0, which is not above 0\.2\.0[^]*lib\/coach\.js/);
});

test('a lower version fails too', () => {
  assert.strictEqual(run(['bin/cost.js'], '0.3.0', '0.2.9').length, 1);
});

test('a bump needs its CHANGELOG section', () => {
  assert.deepStrictEqual(run(['lib/coach.js'], '0.2.0', '0.3.0'), []);
  assert.match(run(['lib/coach.js'], '0.2.0', '0.4.0')[0], /no "## 0\.4\.0" section/);
});

test('versions compare numerically, not as text', () => {
  assert.ok(newer('0.10.0', '0.9.0'));
  assert.ok(!newer('0.2.0', '0.2.0'));
  assert.ok(!newer('garbage', '0.2.0'));
});
