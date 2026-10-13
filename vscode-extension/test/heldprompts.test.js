'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../heldprompts');
const { libDir } = require('../model');
const coach = require(path.join(libDir, 'coach.js'));

const env = () => ({ ...process.env, AI_COST_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'aicost-held-')) });
const NOW = Date.parse('2026-10-06T12:00:00Z');
const BANNER = '**Prompt check (ai-cost-drilldown): not sent.** This prompt was held back because a bare retry makes the model guess what failed.\n\n**Tip:** Name the file, paste the exact error line.\n\nTry it as:\n> In `<file or function>`, `<what is wrong>`.\n\n- Run /compact first.\n- Or send the same prompt again.\n\n_No model call, no AI credits._';

test('pending lists fresh held prompts oldest first, and drops stale or unreadable ones', () => {
  const e = env();
  coach.writeHeld(e, { session: 's', id: 'a', prompt: 'old', banner: 'b' }, NOW - 30e3);
  coach.writeHeld(e, { session: 's', id: 'b', prompt: 'new', banner: 'b' }, NOW - 5e3);
  coach.writeHeld(e, { session: 's', id: 'c', prompt: 'stale', banner: 'b' }, NOW - 120e3);
  fs.writeFileSync(path.join(coach.heldDir(e), `${NOW}-bad.json`), '{not json');
  const got = H.pending(e, NOW);
  assert.deepStrictEqual(got.map((r) => r.prompt), ['old', 'new']);
  assert.strictEqual(fs.readdirSync(coach.heldDir(e)).length, 2, 'the stale and the unreadable files are gone');
  H.remove(got[0]);
  assert.deepStrictEqual(H.pending(e, NOW).map((r) => r.prompt), ['new']);
  assert.deepStrictEqual(H.pending(env(), NOW), [], 'no folder yet: nothing');
});

test('the notification says why the prompt was held, in plain text', () => {
  assert.strictEqual(H.message({ banner: BANNER }), 'Prompt held: This prompt was held back because a bare retry makes the model guess what failed.');
  const long = H.message({ banner: `**Prompt check (ai-cost-drilldown): not sent.** ${'word '.repeat(80)}` });
  assert.ok(long.length <= 240 && long.endsWith('…'));
});

test('the banner as HTML: structure kept, everything escaped', () => {
  const html = H.bannerHtml({ banner: BANNER });
  assert.match(html, /<p><b>Prompt check \(ai-cost-drilldown\): not sent\.<\/b> This prompt was held back/);
  assert.match(html, /<p><b>Tip:<\/b> Name the file/);
  assert.match(html, /<blockquote>In <code>&lt;file or function&gt;<\/code>, <code>&lt;what is wrong&gt;<\/code>\.<\/blockquote>/);
  assert.match(html, /<ul><li>Run \/compact first\.<\/li><li>Or send the same prompt again\.<\/li><\/ul>/);
  assert.match(html, /<p><i>No model call, no AI credits\.<\/i><\/p>/);
  const hostile = H.bannerHtml({ banner: '**x** <img src=x onerror=alert(1)> "quoted"\n- <script>alert(1)</script>' });
  assert.ok(!/<img|<script/.test(hostile), hostile);
  assert.match(hostile, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('the heartbeat helpers write and clear the file the hook reads', () => {
  const e = env();
  H.beat(e, NOW);
  assert.strictEqual(coach.notifierAlive(e, NOW + 1000), true);
  H.stop(e);
  assert.strictEqual(coach.notifierAlive(e, NOW + 1000), false);
});
