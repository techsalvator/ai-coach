// node --test test/tool-usage.test.js
'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const { analyseTools, commandOf } = require('../lib/tool-usage');

test('shell calls are grouped by the program they run', () => {
  assert.strictEqual(commandOf('cd /repo && rtk grep -rn foo .'), 'rtk grep');
  assert.strictEqual(commandOf('cd "/a b"; git status'), 'git');
  assert.strictEqual(commandOf('FOO=1 BAR=2 go test ./...'), 'go');
  assert.strictEqual(commandOf('cat a.txt | head -5'), 'cat');
  assert.strictEqual(commandOf('/usr/bin/sed -n 1p x'), 'sed');
  assert.strictEqual(commandOf(''), '(empty)');
});

test('a result is carried by every later model call in its context until compaction', async () => {
  const ev = (type, data, extra = {}) => JSON.stringify({ type, data, timestamp: '2026-09-25T10:00:00Z', ...extra });
  const lines = [
    ev('assistant.turn_start', {}),                                                     // main turn 1
    ev('tool.execution_start', { toolCallId: 'a', toolName: 'view', arguments: { path: '/x' } }),
    ev('tool.execution_complete', { toolCallId: 'a', result: { content: 'x'.repeat(400) } }), // 100 tokens
    ev('assistant.turn_start', {}),                                                     // 2
    ev('assistant.turn_start', {}),                                                     // 3
    ev('session.compaction_complete', {}),                                              // after 3: dropped
    ev('assistant.turn_start', {}),                                                     // 4
    ev('assistant.turn_start', {}, { agentId: 's1' }),                                  // subagent's own turn 1
    ev('tool.execution_start', { toolCallId: 'b', toolName: 'bash', arguments: { command: 'cd /r && git log' } }, { agentId: 's1' }),
    ev('tool.execution_complete', { toolCallId: 'b', result: { content: 'y'.repeat(40) } }, { agentId: 's1' }),
    ev('assistant.turn_start', {}, { agentId: 's1' }),                                  // s1 turn 2
  ];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-usage-')), 'events.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const { calls } = await analyseTools(file);
  const view = calls.find((c) => c.tool === 'view');
  const git = calls.find((c) => c.tool === 'bash');
  assert.deepStrictEqual([view.tokens, view.carried, view.ctx], [100, 200, 'main']); // turns 2 and 3
  assert.deepStrictEqual([git.command, git.tokens, git.carried, git.ctx], ['git', 10, 10, 's1']);
});
