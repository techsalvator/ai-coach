'use strict';
// What the held-prompt notification does when you pick each button, with a stand-in for VS Code.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const calls = { exec: [], clip: [], info: [], status: [], html: [], msg: [] };
let pick = null; let execFails = false;
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    return {
      EventEmitter: class { constructor() { this.event = () => {}; } fire() {} }, Uri: {}, ViewColumn: { Beside: 2 }, StatusBarAlignment: {},
      workspace: { getConfiguration: () => ({ get: (k, d) => d }), onDidChangeConfiguration: () => ({ dispose() {} }) },
      commands: { executeCommand: async (...a) => { calls.exec.push(a); if (execFails) throw new Error('no such command'); } },
      env: { clipboard: { writeText: async (t) => { calls.clip.push(t); } } },
      window: {
        state: { focused: true },
        showWarningMessage: async (m, ...buttons) => { calls.msg.push([m, buttons]); return pick; },
        showInformationMessage: async (m) => { calls.info.push(m); }, setStatusBarMessage: (m) => { calls.status.push(m); },
        createWebviewPanel: () => ({ title: '', webview: { set html(h) { calls.html.push(h); }, onDidReceiveMessage() {} }, onDidDispose() {} }),
      },
    };
  }
  return load.call(this, request, ...rest);
};
const { _test } = require('../extension');
const REC = { ts: Date.now(), session: 's', id: 'repeat', prompt: 'summarise <b>lib/coach.js</b>', banner: '**Prompt check (ai-cost-drilldown): not sent.** You already ran this exact prompt 5 minutes ago.\n\n- Send the same prompt again.' };
const reset = () => { for (const k of Object.keys(calls)) calls[k].length = 0; execFails = false; };

test('the notification names the reason and offers Why, Send anyway and Copy prompt', async () => {
  reset(); pick = undefined;
  await _test.handleHeld(REC);
  assert.deepStrictEqual(calls.msg[0], ['Prompt held: You already ran this exact prompt 5 minutes ago.', ['Why', 'Send anyway', 'Copy prompt']]);
  assert.strictEqual(calls.exec.length + calls.clip.length + calls.html.length, 0, 'dismissed: nothing else happens');
});

test('Send anyway sends the same prompt to the chat again, which runs it', async () => {
  reset(); pick = 'Send anyway';
  await _test.handleHeld(REC);
  assert.deepStrictEqual(calls.exec, [['workbench.action.chat.open', { query: REC.prompt, isPartialQuery: false }]]);
  assert.strictEqual(calls.clip.length, 0);
});

test('if the chat cannot be driven, the prompt is copied and you are told', async () => {
  reset(); pick = 'Send anyway'; execFails = true;
  await _test.handleHeld(REC);
  assert.deepStrictEqual(calls.clip, [REC.prompt]);
  assert.match(calls.info[0], /could not send it for you[^]*copied/);
});

test('Copy prompt copies it, and Why opens the banner with the prompt escaped', async () => {
  reset(); pick = 'Copy prompt';
  await _test.handleHeld(REC);
  assert.deepStrictEqual(calls.clip, [REC.prompt]);
  assert.match(calls.status[0], /prompt copied/);
  reset(); pick = 'Why';
  await _test.handleHeld(REC);
  const html = calls.html[0];
  assert.match(html, /<h2>Prompt held<\/h2>[^]*You already ran this exact prompt[^]*<li>Send the same prompt again\.<\/li>/);
  assert.match(html, /summarise &lt;b&gt;lib\/coach\.js&lt;\/b&gt;/, 'the prompt is shown as text, not as markup');
  assert.ok(!html.includes('<b>lib/coach.js</b>'));
});
