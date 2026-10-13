'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { advise, priceOf } = require('../advice');

const call = (o) => ({ model: 'claude-opus-5-5', usd: 1, fresh: 0, cacheRead: 100000, cacheWrite: 0, tokensIn: 100000, tokensOut: 100, ...o });
const prompt = (o) => ({ usd: 1, calls: [call({})], cacheBreak: null, ...o });

test('normalises dashed model names', () => {
  assert.ok(priceOf('claude-opus-5-5'));
  assert.ok(priceOf('claude-sonnet-4-6'));
  assert.strictEqual(priceOf('nope'), null);
});

test('flags expired cache, with the prompt as target', () => {
  const s = [{ prompts: [prompt({}), prompt({ cacheBreak: { kind: 'idle', to: 'claude-opus-5-5', uncached: 500000 } })] }];
  const r = advise(s);
  const f = r.findings.find((x) => x.id === 'cache-expiry');
  assert.ok(f && f.saving > 0);
  assert.deepStrictEqual(f.targets[0], [0, 1]);
});

test('flags a large model on short replies, not Sonnet', () => {
  const s = [{ prompts: [prompt({ calls: [call({ usd: 2 }), call({ model: 'claude-sonnet-5-5' })] })] }];
  const f = advise(s).findings.find((x) => x.id === 'heavy-model');
  assert.ok(f && f.saving > 0 && f.saving < 2);
});

test('quiet when nothing is wrong', () => {
  assert.deepStrictEqual(advise([{ prompts: [prompt({ calls: [call({ model: 'claude-sonnet-5-5', tokensOut: 5000 })] })] }]).findings, []);
});
