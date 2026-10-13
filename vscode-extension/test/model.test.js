'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, dayTotal } = require('../model');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicost-'));
  const dir = path.join(root, '-proj'); fs.mkdirSync(dir);
  const now = new Date().toISOString();
  const lines = [
    { type: 'user', timestamp: now, cwd: '/x/demo', message: { role: 'user', content: 'hello there' } },
    { type: 'assistant', timestamp: now, message: { id: 'm1', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 } } },
    { type: 'assistant', timestamp: now, message: { id: 'm2', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 20, output_tokens: 7 } } },
  ];
  fs.writeFileSync(path.join(dir, 'abc.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  return root;
}

test('loads session -> prompt -> calls', async () => {
  const ss = await load({ root: fixture() });
  assert.strictEqual(ss.length, 1);
  assert.strictEqual(ss[0].title, 'demo');
  assert.strictEqual(ss[0].prompts.length, 1);
  const p = ss[0].prompts[0];
  assert.strictEqual(p.text, 'hello there');
  assert.strictEqual(p.calls.length, 2);
  assert.strictEqual(p.calls[0].tokensIn, 110);
  assert.strictEqual(p.calls[0].tokensOut, 5);
  assert.strictEqual(dayTotal(ss), 0); // no rate for this model without a cost-state: unpriced, not a crash
});
