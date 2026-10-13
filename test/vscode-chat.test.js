// node --test test/*.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { replay, toRows, readAll, chatFiles, workspaceFolder, modelName, userDirs } = require('../lib/vscode-chat');

const T1 = Date.parse('2026-08-11T10:00:00Z');
const req = (n, extra = {}) => ({ requestId: `r${n}`, timestamp: T1 + n * 60000, modelId: 'copilot/auto', message: { text: `question ${n}`, parts: [{ big: 'x'.repeat(50) }] },
  response: [{ value: 'y'.repeat(500) }], ...extra });
const lines = (...objs) => `${objs.map((o) => JSON.stringify(o)).join('\n')}\n`;

/** A VS Code "User" dir with one workspace chat (2 requests, patched in the way VS Code writes them) and one empty-window chat. */
function fixture() {
  const user = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-user-'));
  const ws = path.join(user, 'workspaceStorage', 'abc123');
  fs.mkdirSync(path.join(ws, 'chatSessions'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'workspace.json'), JSON.stringify({ folder: 'file:///Users/me/My%20Project' }));
  fs.writeFileSync(path.join(ws, 'chatSessions', 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'), lines(
    { kind: 0, v: { version: 3, sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', creationDate: T1, requests: [] } },
    { kind: 2, k: ['requests'], v: [req(1)] },
    { kind: 1, k: ['requests', 0, 'result'], v: { metadata: { promptTokens: 41867, outputTokens: 430, resolvedModel: 'claude-sonnet-4-6', toolCallRounds: [1, 2, 3], toolCallResults: { big: 'z'.repeat(999) } } } },
    { kind: 2, k: ['requests', 0, 'response'], i: 2, v: [{ value: 'w'.repeat(2000) }] },
    { kind: 1, k: ['requests', 0, 'completionTokens'], v: 2924 },
    { kind: 1, k: ['requests', 0, 'promptTokens'], v: 41867 },
    { kind: 1, k: ['requests', 0, 'copilotCredits'], v: 18.77 },
    { kind: 1, k: ['requests', 0, 'elapsedMs'], v: 53619 },
    { kind: 2, k: ['requests'], v: [req(2)] },
    { kind: 1, k: ['requests', 1, 'result'], v: { metadata: { promptTokens: 900, outputTokens: 40, resolvedModel: 'claude-haiku-4-5-20251001' } } },
    { kind: 2, k: ['requests'], v: [req(3)] },           // submitted, never answered: no tokens, no credits
  ));
  const empty = path.join(user, 'globalStorage', 'emptyWindowChatSessions');
  fs.mkdirSync(empty, { recursive: true });
  fs.writeFileSync(path.join(empty, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl'), lines(
    { kind: 0, v: { version: 3, sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', requests: [{ ...req(5), promptTokens: 100, completionTokens: 7 }] } },
  ) + '{"kind":1,"k":["requests",0,"copilotCredits"],"v');   // a partial last line, as while VS Code is writing
  return user;
}

test('replays VS Code\'s patch records and keeps only what a report needs', async () => {
  const user = fixture();
  const state = await replay(path.join(user, 'workspaceStorage', 'abc123', 'chatSessions', 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'));
  assert.strictEqual(state.requests.length, 3);
  assert.strictEqual(state.requests[0].copilotCredits, 18.77);
  assert.strictEqual(state.requests[0].result.metadata.rounds, 3);
  assert.strictEqual(state.requests[0].response, undefined, 'bulk is dropped');
  assert.deepStrictEqual(Object.keys(state.requests[0].message), ['text']);
});

test('requests become prompt rows: credits, tokens, model, folder; unanswered requests are left out', async () => {
  const user = fixture();
  const { rows, files, scanned } = await readAll(0, { dirs: [user] });
  assert.deepStrictEqual([files, scanned], [2, 2]);
  assert.strictEqual(rows.length, 3);
  const a = rows.find((r) => r.prompt === 'question 1');
  assert.deepStrictEqual([a.session, a.source, a.credits, a.models[0], a.cwd, a.seconds, a.toolCalls],
    ['vs-aaaaaaaa', 'vscode', 18.77, 'claude-sonnet-4.6', '/Users/me/My Project', 54, 3]);
  assert.deepStrictEqual([a.tokensLive.input, a.tokensLive.output], [41867, 2924]);
  const b = rows.find((r) => r.prompt === 'question 2');
  assert.deepStrictEqual([b.credits, b.tokensLive.input, b.tokensLive.output, b.models[0]], [null, 900, 40, 'claude-haiku-4.5']);
  const c = rows.find((r) => r.session === 'vs-bbbbbbbb');
  assert.deepStrictEqual([c.cwd, c.credits, c.tokensLive.input], [null, null, 100]);   // the partial line is ignored
});

test('a window that excludes a file skips it; a cached file is not read again; a changed file is', async () => {
  const user = fixture();
  const cachePath = path.join(user, 'cache.json');
  assert.strictEqual((await readAll(0, { dirs: [user], cachePath })).scanned, 2);
  assert.strictEqual((await readAll(0, { dirs: [user], cachePath })).scanned, 0);
  const f = path.join(user, 'globalStorage', 'emptyWindowChatSessions', 'bbbbbbbb-1111-2222-3333-444444444444.jsonl');
  fs.appendFileSync(f, '":3.5}\n');
  const again = await readAll(0, { dirs: [user], cachePath });
  assert.strictEqual(again.scanned, 1);
  assert.strictEqual(again.rows.find((r) => r.session === 'vs-bbbbbbbb').credits, 3.5);
  const future = await readAll(Date.now() + 86400000, { dirs: [user], cachePath });
  assert.deepStrictEqual([future.rows.length, future.files], [0, 0]);
  const late = await readAll(T1 + 90000, { dirs: [user], cachePath });      // after question 1, before question 2
  assert.ok(late.rows.every((r) => Date.parse(r.ts) >= T1 + 90000) && late.rows.length === 2);
});

test('helpers: model names, workspace folders, missing folders, platform dirs', () => {
  assert.strictEqual(modelName('claude-sonnet-4-6'), 'claude-sonnet-4.6');
  assert.strictEqual(modelName('claude-haiku-4-5-20251001'), 'claude-haiku-4.5');
  assert.strictEqual(modelName('gpt-5.4-2026-03-05'), 'gpt-5.4');
  assert.strictEqual(modelName('copilot/auto'), 'auto');
  assert.strictEqual(modelName(undefined), null);
  assert.strictEqual(workspaceFolder('/no/such/dir'), null);
  assert.deepStrictEqual(chatFiles('/no/such/dir'), []);
  assert.deepStrictEqual(userDirs({ AI_COST_VSCODE_DIR: ['/a', '/b'].join(path.delimiter) }), ['/a', '/b']);
  assert.ok(userDirs({}, 'darwin', '/Users/x')[0].endsWith(path.join('Library', 'Application Support', 'Code', 'User')));
  assert.ok(userDirs({ APPDATA: 'C:\\Roaming' }, 'win32', 'C:\\Users\\x')[0].includes('Roaming'));
  assert.ok(userDirs({}, 'linux', '/home/x')[0].endsWith(path.join('.config', 'Code', 'User')));
});

test('the prompts report includes VS Code rows, can group by source and can leave them out', async () => {
  const user = fixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
  const { spawnSync } = require('node:child_process');
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'cost.js'), ...args, '--md'],
    { encoding: 'utf8', env: { ...process.env, COPILOT_HOME: home, AI_COST_HOME: home, AI_COST_VSCODE_DIR: user } }).stdout;
  const all = run('prompts', '--since', 'all', '--by', 'source');
  assert.match(all, /Includes 3 VS Code chat requests \(1 with a credit figure, 18\.77 credits/);
  assert.match(all, /\| VS Code chat \| 3 \| 18\.77 \| \$0\.19 \| 100% \| 18\.77 \|/);   // average over the priced request only
  assert.match(run('prompts', '--since', 'all'), /\| vs-aaaaaaaa \| — \| My Project \| question 1 \| 18\.77 \| \$0\.19 \| — \|/);
  assert.match(run('prompts', '--since', 'all', '--source', 'cli'), /No prompts match/);
  assert.match(run('prompts', '--source', 'nope'), /^$/);   // usage error goes to stderr
});
