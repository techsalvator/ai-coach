'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('the extension is techselva.ai-cost-coach, and nothing in it opens the tour by another id', () => {
  assert.strictEqual(`${pkg.publisher}.${pkg.name}`, 'techselva.ai-cost-coach');
  const src = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  assert.ok(!/flexera\.ai-cost|ai-cost-drilldown-vscode/.test(src), 'an id that is not this extension\'s would open nothing');
  assert.match(src, /openWalkthrough', `\$\{extensionId\}#aiCost\.tour`/);
});
