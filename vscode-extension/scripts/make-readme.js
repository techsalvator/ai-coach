'use strict';
// The extension's page in VS Code shows the README.md inside the package. It is made from the repository README, so the
// two cannot drift apart: the sections about cloning and building are dropped (they mean nothing on an installed
// extension's page) and the images are handled.
//
// The images need care. VS Code draws that page through a sanitizer that allows images only from https: a relative path
// (images/x.png) is never loaded, even though the file is installed beside the README, and a data: URI is stripped. Left
// in, they show as broken-image icons. So by default the images are removed and the page points at the tour (the
// walkthrough in package.json, which shows the same screenshots from the package, offline). When the images are hosted
// at a public https address (say the repository is public), set AI_COST_IMAGES_BASE to that folder and they are kept.

const fs = require('fs');
const path = require('path');

const DROP = ['Install', 'Develop']; // sections of the repository README that do not belong on the extension's page
const IMAGE_LINE = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/;
const SCREENS_NOTE = /\*Every screen in this README is one of the extension's own panels[^*]*\*/; // the sentence wraps over two lines
const TOUR_NOTE = '*The screens are in the tour: run **AI Cost: Show Tour** from the Command Palette, or open Help → Get Started → AI Cost Coach. They are made-up sample sessions, so nothing in them comes from anyone\'s real logs.*';

/**
 * The extension README for the text of the repository README.
 * imageBase: an https folder holding the images (the file names of docs/images); without it the images are removed.
 */
function build(text, { imageBase = null } = {}) {
  const out = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) { // a Windows checkout has CRLF
    const h = /^## (.+)$/.exec(line);
    if (h) skipping = DROP.includes(h[1].trim());
    if (skipping) continue;
    if (DROP.some((d) => line.trim() === `- [${d}](#${d.toLowerCase()})`)) continue; // its line in the contents list
    if (!imageBase && IMAGE_LINE.test(line)) continue;
    out.push(line);
  }
  let md = `<!-- Made from the repository README by scripts/make-readme.js when the package is built: edit that one. -->\n${out.join('\n')}`;
  md = imageBase
    ? md.replace(/\]\(docs\/images\/([^)\s]+)\)/g, (m, f) => `](${imageBase.replace(/\/$/, '')}/${f})`)
    : md.replace(SCREENS_NOTE, TOUR_NOTE);
  return md.replace(/\]\(vscode-extension\/CHANGELOG\.md\)/g, '](CHANGELOG.md)').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n');
}

module.exports = { build, DROP };

if (require.main === module) {
  const root = path.join(__dirname, '..', '..', 'README.md');
  const dst = path.join(__dirname, '..', 'README.md');
  fs.writeFileSync(dst, build(fs.readFileSync(root, 'utf8'), { imageBase: process.env.AI_COST_IMAGES_BASE || null }));
  console.log(`wrote ${dst}`);
}
