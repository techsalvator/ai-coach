'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { build } = require('../scripts/make-readme');

const root = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

test('the extension README drops the clone-and-build sections and their lines in the contents', () => {
  const readme = build(root);
  assert.ok(!/^## Install/m.test(readme) && !/^## Develop/m.test(readme));
  assert.ok(!/\(#install\)|\(#develop\)/.test(readme));
  assert.ok(!/dist\/ai-cost-coach|npm run package|code --install-extension/.test(readme), 'no instructions for building or installing the file');
  for (const heading of ['The screens', 'Advice', 'Copilot tracking and cost tips', 'Reading the numbers', 'Settings and commands', 'Your data and privacy', 'What it cannot do']) {
    assert.match(readme, new RegExp(`^## ${heading}`, 'm'), heading);
  }
});

test('the Details page gets no images, which VS Code would show as broken, and a pointer to the tour', () => {
  const readme = build(root);
  assert.ok(!/!\[/.test(readme), 'no image markdown: VS Code loads images there only from public https addresses');
  assert.match(readme, /\*The screens are in the tour: run \*\*AI Cost: Show Tour\*\*/);
  assert.ok(!/Every screen in this README/.test(readme));
  assert.ok(!/\]\((docs|vscode-extension|images)\//.test(readme), 'no link to a file of the repository');
});

test('with a public https folder for the images, they are kept and point there', () => {
  const readme = build(root, { imageBase: 'https://example.com/shots/' });
  const imgs = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(imgs.length >= 9);
  for (const i of imgs) assert.match(i, /^https:\/\/example\.com\/shots\/vscode-[\w-]+\.png$/);
  assert.match(readme, /Every screen in this README/, 'the note about the images stays when the images do');
});

test('the tour: every step has its screenshot in the package, and its command links exist', () => {
  const [tour] = pkg.contributes.walkthroughs;
  assert.ok(tour.steps.length >= 8);
  const commands = new Set(pkg.contributes.commands.map((c) => c.command));
  assert.strictEqual(new Set(tour.steps.map((s) => s.id)).size, tour.steps.length, 'unique step ids');
  for (const s of tour.steps) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', s.media.image)), `${s.media.image} is missing: run node scripts/screenshots.js --out images --scale 1`);
    assert.ok(s.media.altText, s.id);
    for (const m of s.description.matchAll(/\(command:([\w.]+)\)/g)) assert.ok(commands.has(m[1]), `${s.id}: ${m[1]} is not a command`);
  }
  assert.ok(commands.has('aiCost.showTour'));
  assert.ok(!fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8').includes('images'), 'the screenshots ship');
});
