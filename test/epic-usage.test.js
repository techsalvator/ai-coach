// node --test test/*.test.js
const assert = require('node:assert');
const { test } = require('node:test');
const { attribute, rootOf, ticketMeta } = require('../lib/epic-usage');
const { keysIn, parseIssue, PromptJira } = require('../lib/jira-signals');

const row = (session, ts, prompt, extra = {}) => ({ session, ts, prompt, credits: 10, branch: null, jira: null, ...extra });
const tools = (keys, meta = {}) => ({ keys, meta });

test('keysIn finds ticket keys and skips lowercase paths', () => {
  assert.deepStrictEqual(keysIn('/design FOPTS-29970 see artifacts/fopts-29970 and UTF-8'), ['FOPTS-29970', 'UTF-8']);
});

test('attribute: named, carried, and project prefixes learned from Jira calls', () => {
  const rows = [
    row('s', '2026-09-30T10:00:00Z', 'ADR-15 and UTF-8 mentioned', { jira: tools({ 'FOPTS-1': 1 }) }),
    row('s', '2026-09-30T10:05:00Z', '/design FOPTS-29970'),
    row('s', '2026-09-30T10:06:00Z', 'yes'),
    row('s', '2026-09-30T10:07:00Z', 'accept'),
  ];
  attribute(rows);
  assert.strictEqual(rows[0].ticket, 'FOPTS-1');   // only the learned prefix FOPTS counts: ADR/UTF ignored
  assert.strictEqual(rows[0].source, 'tools');
  assert.deepStrictEqual([rows[1].ticket, rows[1].source], ['FOPTS-29970', 'prompt']);
  assert.deepStrictEqual([rows[3].ticket, rows[3].source], ['FOPTS-29970', 'carried']);
});

test('attribute: a gap of 8+ hours ends carrying; a branch key is the last resort', () => {
  const rows = [
    row('s', '2026-09-30T01:00:00Z', '/prd FOPTS-5', { branch: 'harish/FOPTS-9-thing' }),
    row('s', '2026-09-30T01:10:00Z', 'ok'),
    row('s', '2026-09-30T20:00:00Z', 'something else', { branch: 'harish/FOPTS-9-thing' }),
    row('t', '2026-09-30T20:00:00Z', 'no clues at all'),
  ];
  attribute(rows);
  assert.strictEqual(rows[1].ticket, 'FOPTS-5');
  assert.deepStrictEqual([rows[2].ticket, rows[2].source], ['FOPTS-9', 'branch']);
  assert.strictEqual(rows[3].ticket, null);
});

test('attribute: Jira calls on another ticket override a stale carried one', () => {
  const rows = [
    row('s', '2026-09-30T10:00:00Z', '/design FOPTS-1'),
    row('s', '2026-09-30T10:05:00Z', 'now look at the other one', { jira: tools({ 'FOPTS-2': 3 }) }),
    row('s', '2026-09-30T10:06:00Z', 'go on'),
  ];
  attribute(rows);
  assert.deepStrictEqual([rows[1].ticket, rows[1].source], ['FOPTS-2', 'tools']);
  assert.strictEqual(rows[2].ticket, 'FOPTS-2');
});

test('rootOf stops at the first epic and never rolls into an initiative', () => {
  const meta = new Map([
    ['FOPTS-9', { type: 'Story', parent: 'FOPTS-5' }],
    ['FOPTS-5', { type: 'Epic', parent: 'FLEX-1' }],
    ['FLEX-1', { type: 'Initiative', parent: null }],
    ['FOPTS-7', { type: null, parent: 'FOPTS-5' }],
  ]);
  assert.strictEqual(rootOf('FOPTS-9', meta), 'FOPTS-5');
  assert.strictEqual(rootOf('FOPTS-5', meta), 'FOPTS-5');
  assert.strictEqual(rootOf('FOPTS-7', meta), 'FOPTS-5');
  assert.strictEqual(rootOf('FOPTS-99', meta), 'FOPTS-99');
});

test('ticketMeta merges lookups across prompts', () => {
  const meta = ticketMeta([row('s', 'x', 'p', { jira: tools({}, { 'A-1': { t: 'Story' } }) }), row('s', 'y', 'p', { jira: tools({}, { 'A-1': { p: 'A-2', s: 'Title' } }) })]);
  assert.deepStrictEqual(meta.get('A-1'), { type: 'Story', parent: 'A-2', summary: 'Title' });
});

test('PromptJira records keys, created tickets with their parent, and looked-up parents', () => {
  const j = new PromptJira();
  const s1 = j.start('atlassian-createJiraIssue', { parent: 'FOPTS-5', issueTypeName: 'Task', summary: 'do it' });
  j.complete('atlassian-createJiraIssue', s1, '{"id":"1","key":"FOPTS-6","self":"x"}');
  const s2 = j.start('atlassian-getJiraIssue', { issueIdOrKey: 'FOPTS-9' });
  j.complete('atlassian-getJiraIssue', s2, JSON.stringify({ key: 'FOPTS-9', fields: { summary: 'S', issuetype: { name: 'Story' }, parent: { key: 'FOPTS-5', fields: { summary: 'E', issuetype: { name: 'Epic' } } } } }));
  assert.strictEqual(j.start('bash', { command: 'ls FOPTS-1' }), null);
  const out = j.toJSON();
  assert.strictEqual(out.meta['FOPTS-6'].p, 'FOPTS-5');
  assert.deepStrictEqual([out.meta['FOPTS-9'].t, out.meta['FOPTS-9'].p, out.meta['FOPTS-5'].t], ['Story', 'FOPTS-5', 'Epic']);
  assert.ok(out.keys['FOPTS-5'] >= 1 && out.keys['FOPTS-9'] === 1);
});

test('parseIssue falls back to patterns on truncated JSON', () => {
  const r = parseIssue('{"expand":"x","key":"FOPTS-3","fields":{"parent":{"id":"12","key":"FOPTS-2","fields":{"summ');
  assert.deepStrictEqual([r.key, r.parent], ['FOPTS-3', 'FOPTS-2']);
});

test('parseIssues reads Copilot plain results and the Atlassian connector wrapper', () => {
  const { parseIssues } = require('../lib/jira-signals');
  const issue = (key, parent) => ({ key, fields: { summary: `S ${key}`, issuetype: { name: parent ? 'Story' : 'Epic' }, ...(parent ? { parent: { key: parent, fields: { summary: 'E', issuetype: { name: 'Epic' } } } } : {}) } });
  assert.deepStrictEqual(parseIssues(JSON.stringify(issue('A-2', 'A-1'))).map((i) => [i.key, i.type, i.parent]), [['A-2', 'Story', 'A-1']]);
  const wrapped = parseIssues(JSON.stringify({ issues: { nodes: [issue('A-2', 'A-1'), issue('A-3', 'A-1')] } }));
  assert.deepStrictEqual(wrapped.map((i) => i.key), ['A-2', 'A-3']);
  assert.strictEqual(wrapped[0].parentType, 'Epic');
});

test('a search result fills in many tickets at once', () => {
  const { PromptJira } = require('../lib/jira-signals');
  const j = new PromptJira();
  const st = j.start('mcp__x__searchJiraIssuesUsingJql', { jql: 'parent = FOPTS-5' });
  j.complete('mcp__x__searchJiraIssuesUsingJql', st, JSON.stringify({ issues: { nodes: [
    { key: 'FOPTS-6', fields: { summary: 'a', issuetype: { name: 'Story' }, parent: { key: 'FOPTS-5', fields: { issuetype: { name: 'Epic' } } } } },
    { key: 'FOPTS-7', fields: { summary: 'b', issuetype: { name: 'Task' }, parent: { key: 'FOPTS-5', fields: { issuetype: { name: 'Epic' } } } } }] } }));
  const m = j.toJSON().meta;
  assert.deepStrictEqual([m['FOPTS-6'].p, m['FOPTS-7'].p, m['FOPTS-5'].t], ['FOPTS-5', 'FOPTS-5', 'Epic']);
});

test('dollar-based rows (Claude Code) produce a dollar report', async () => {
  const { run, DOLLARS } = require('../lib/epic-usage');
  const rows = [
    { session: 's', ts: new Date().toISOString(), prompt: '/design FOPTS-5', usd: 3.5, cwd: '/x/repo', jira: { keys: { 'FOPTS-5': 1 }, meta: { 'FOPTS-5': { t: 'Epic', s: 'The epic' } } } },
    { session: 's', ts: new Date().toISOString(), prompt: 'yes', usd: 1.25, cwd: '/x/repo', jira: null },
  ];
  const text = await run(['--since', '7d'], { collect: async () => ({ prompts: rows }), unit: DOLLARS, name: 'Claude Code' });
  assert.match(text, /# Claude Code cost per epic/);
  assert.match(text, /\$4\.75 estimated/);
  assert.match(text, /\| FOPTS-5 \| The epic \| 2 \| \$4\.75 \| 100% \|/);
  assert.ok(!/Credits/.test(text));
  const csv = await run(['--csv'], { collect: async () => ({ prompts: rows }), unit: DOLLARS });
  assert.match(csv, /^ticket,type,epic,title,prompts,usd,sessions,first,last\nFOPTS-5,Epic,,The epic,2,4\.75,1,/);
});

test('epics view lists real epics; loose stories and bugs share one row', async () => {
  const { run, DOLLARS } = require('../lib/epic-usage');
  const now = new Date().toISOString();
  const rows = [
    { session: 's1', ts: now, prompt: '/design FOPTS-9', usd: 2, jira: { keys: { 'FOPTS-9': 1 }, meta: { 'FOPTS-9': { t: 'Story', p: 'FOPTS-5' }, 'FOPTS-5': { t: 'Epic', s: 'Real epic' } } } },
    { session: 's2', ts: now, prompt: '/backlog FOPTS-77', usd: 1.5, jira: { keys: { 'FOPTS-77': 1 }, meta: { 'FOPTS-77': { t: 'Bug', s: 'A bug' } } } },
    { session: 's3', ts: now, prompt: '/backlog FOPTS-78', usd: 0.5, jira: { keys: { 'FOPTS-78': 1 }, meta: {} } },
  ];
  const text = await run(['--since', '7d'], { collect: async () => ({ prompts: rows }), unit: DOLLARS });
  assert.match(text, /\| FOPTS-5 \| Real epic \| 1 \| \$2\.00 \|/);
  assert.match(text, /\| \(no epic known\) \| 2 stories, bugs and tasks: FOPTS-77 \$1\.50, FOPTS-78 \$0\.50 \| 2 \| \$2\.00 \|/);
  assert.ok(!/\| FOPTS-77 \|/.test(text));
  const stories = await run(['--since', '7d', '--stories'], { collect: async () => ({ prompts: rows }), unit: DOLLARS });
  assert.match(stories, /\| FOPTS-77 \| Bug \| — \|/);
});
