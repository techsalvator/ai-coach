'use strict';
// Copies what the extension runs and installs into ./runtime so the .vsix carries it:
//   runtime/lib/                the report code (the extension reads sessions with it)
//   runtime/bin/cost.js         the Copilot hook (cost tips); "AI Cost: Set Up Copilot Tracking" copies it to ~/.ai-cost-coach
//   runtime/extensions/ai-cost/ the Copilot CLI token logger, copied to ~/.copilot/extensions/
// In the repository these are read from the parent folder directly, so this runs only when packaging.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const dst = path.join(__dirname, '..', 'runtime');
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(path.join(dst, 'bin'), { recursive: true });
fs.cpSync(path.join(root, 'lib'), path.join(dst, 'lib'), { recursive: true });
fs.copyFileSync(path.join(root, 'bin', 'cost.js'), path.join(dst, 'bin', 'cost.js'));
fs.cpSync(path.join(root, 'extensions', 'ai-cost'), path.join(dst, 'extensions', 'ai-cost'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'README.md'), require('./make-readme').build(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), { imageBase: process.env.AI_COST_IMAGES_BASE || null })); // the page VS Code shows
fs.mkdirSync(path.join(root, 'dist'), { recursive: true }); // where `npm run package` writes the .vsix
console.log(`copied the runtime to ${dst}`);
