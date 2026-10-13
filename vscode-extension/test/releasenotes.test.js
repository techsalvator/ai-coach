'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { notes } = require('../scripts/release-notes');

const log = '# Changelog\n\n## 0.3.0\n\n- three\n\n## 0.2.0 (unreleased)\n\n### Added\n\n- two\n\n## 0.1.0\n\n- one\n';

test('takes the section for a version, up to the next heading', () => {
  assert.equal(notes(log, '0.2.0'), '### Added\n\n- two');
  assert.equal(notes(log, '0.1.0'), '- one');
});

test('a version with no section gives null', () => {
  assert.equal(notes(log, '9.9.9'), null);
});

test('the current version has release notes', () => {
  const root = path.join(__dirname, '..');
  const v = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  assert.ok(notes(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), v), `CHANGELOG.md has no "## ${v}" section`);
});
