'use strict';
// Synthetic sessions for the README screenshots: nothing here comes from anyone's real logs. They are built with the
// extension's own helpers (split, mergeSplit, modelsOf), so the panels render them exactly as they render real ones.
// Deterministic: the same call always gives the same data.

const { split, mergeSplit, modelsOf } = require('../model');
const { priceOf } = require('../advice');

const DAY = 86400000;
function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const PROJECTS = [
  ['billing-service', 'payments/billing-service', 'feature/invoice-export'],
  ['web-dashboard', 'apps/web-dashboard', 'main'],
  ['infra-terraform', 'platform/infra-terraform', 'chore/upgrade-provider'],
  ['mobile-app', 'apps/mobile-app', 'fix/login-crash'],
  ['data-pipeline', 'data/data-pipeline', 'feature/daily-rollup'],
  ['docs-site', 'web/docs-site', 'main'],
];
const PROMPTS = [
  'add pagination to the invoices endpoint', 'why does the nightly job time out', 'refactor the retry helper', 'write tests for the export service',
  'fix the failing lint step in CI', 'explain how the cache invalidation works', 'rename the config keys and update the docs', 'investigate the memory growth in the worker',
  'add a feature flag for the new checkout', 'summarise what changed since the last release', 'upgrade the HTTP client and fix the breakages', 'draft the migration for the new column',
  'review this diff for race conditions', 'make the dashboard table sortable', 'trace why the webhook is delivered twice', 'tidy up the error messages in the CLI',
];
const TOOLS = {
  claude: [['Read', (f) => f], ['Grep', (f) => `"retry" in ${f}`], ['Bash', () => 'npm test -- --runInBand'], ['Edit', (f) => f], ['Bash', () => 'git diff --stat']],
  copilot: [['view', (f) => f], ['grep', (f) => `retry ${f}`], ['bash', () => 'npm test'], ['edit', (f) => f], ['bash', () => 'git status --short']],
};
const FILES = ['src/export/service.ts', 'src/http/client.ts', 'lib/retry.go', 'app/routes/invoices.ts', 'infra/main.tf', 'src/jobs/nightly.py', 'docs/guide.md'];
const MODELS = { claude: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5'], copilot: ['claude-sonnet-5.5', 'gpt-5.2-codex', 'claude-opus-5.5'], vscode: ['claude-sonnet-5.5', 'gpt-5.2-codex'] };

const sourceName = { claude: 'Claude Code', copilot: 'Copilot CLI', vscode: 'VS Code chat' };

function callCost(model, c) {
  const p = priceOf(model);
  if (!p) return null;
  return (c.fresh * p.input + c.cacheRead * p.cachedInput + c.cacheWrite * (p.cacheWrite ?? p.input) + c.tokensOut * p.output) / 1e6;
}

/** Sessions for the three sources over about 120 days up to `now` (a timestamp). */
function demoSessions(now = Date.parse('2026-10-05T18:00:00Z')) {
  const r = rng(20261005);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const sessions = [];
  const plan = [];
  for (let d = 118; d >= 0; d -= 1) {
    const age = d / 118; // newer days are busier
    const n = r() < 0.55 + (1 - age) * 0.25 ? 1 + (r() < 0.3 + (1 - age) * 0.3 ? 1 : 0) : 0;
    for (let i = 0; i < n; i++) plan.push(d);
  }
  plan.forEach((d, i) => {
    const day = now - d * DAY;
    const age = d / 118;
    const src = r() < 0.25 + (1 - age) * 0.35 ? 'claude' : r() < 0.88 ? 'copilot' : 'vscode';
    if (src === 'claude' && d > 32) return; // Claude Code keeps about a month of transcripts
    const [title, cwd, branch] = pick(PROJECTS);
    const id = `${(0x1000 + i * 7919).toString(16).slice(-4)}${Math.floor(r() * 0xffff).toString(16).padStart(4, '0')}-${Math.floor(r() * 0xffff).toString(16).padStart(4, '0')}-4a11-9c2d-${Math.floor(r() * 0xffffffffff).toString(16).padStart(12, '0')}`;
    const count = 2 + Math.floor(r() * (src === 'vscode' ? 5 : 16));
    const prompts = [];
    let t = day - 8 * 3600e3 + Math.floor(r() * 6 * 3600e3);
    let ctx = 20000 + Math.floor(r() * 40000);
    const model0 = pick(MODELS[src]);
    for (let k = 0; k < count; k++) {
      t += Math.floor((4 + r() * 25) * 60e3) + (r() < 0.08 ? 3 * 3600e3 : 0);
      const idle = r() < 0.08;
      const model = r() < 0.12 ? pick(MODELS[src]) : model0;
      const ncalls = src === 'vscode' ? 0 : 1 + Math.floor(r() * 7);
      const calls = [];
      let at = t;
      const tools = [];
      for (let c = 0; c < ncalls; c++) {
        at += Math.floor((2 + r() * 20) * 1000);
        ctx += Math.floor(1500 + r() * 9000);
        const missed = c === 0 && idle;
        const cacheRead = missed ? 0 : Math.floor(ctx * (0.92 + r() * 0.07));
        const cacheWrite = missed ? ctx : Math.max(0, ctx - cacheRead);
        const tokensOut = Math.floor(80 + r() * (r() < 0.2 ? 3800 : 700));
        const callModel = r() < 0.06 ? pick(MODELS[src]) : model;
        const row = { kind: 'call', id: `${id}-${k}-${c}`, n: c + 1, ts: new Date(at).toISOString(), who: 'main', model: callModel, tokensIn: ctx, tokensOut, fresh: Math.floor(r() * 12), cacheRead, cacheWrite, tools: 0, toolCalls: [] };
        row.tokensIn = row.fresh + cacheRead + cacheWrite;
        row.usd = callCost(callModel, row);
        const nt = r() < 0.75 ? 1 + (r() < 0.25 ? 1 : 0) : 0;
        for (let q = 0; q < nt; q++) {
          const [name, detail] = pick(TOOLS[src === 'claude' ? 'claude' : 'copilot']);
          const tool = { id: `${row.id}-t${q}`, name, detail: detail(pick(FILES)), error: r() < 0.05, where: 'main', tokens: Math.floor(120 + r() * 5200), seconds: Math.floor(r() * 9) };
          row.toolCalls.push(tool); tools.push(tool);
        }
        row.tools = row.toolCalls.length;
        calls.push(row);
      }
      const sp = calls.length ? split(calls) : { ...mergeSplit([]), known: src === 'vscode' ? false : r() < 0.8 };
      let spFinal = sp;
      if (!calls.length && src === 'vscode') { // VS Code stores one total per request
        const tin = Math.floor(8000 + r() * 40000); const tout = Math.floor(200 + r() * 1800);
        spFinal = mergeSplit([{ fresh: tin, cacheRead: 0, cacheWrite: 0, out: tout, calls: 1, known: true }]);
      }
      const usd = calls.length ? calls.reduce((a, c) => a + (c.usd || 0), 0) * (src === 'claude' ? 1 : 1.04) : (src === 'vscode' ? ((spFinal.in * 3 + spFinal.out * 15) / 1e6) : 0.02 + r() * 0.2);
      prompts.push({
        kind: 'prompt', n: k + 1, ts: new Date(t).toISOString(), text: `${pick(PROMPTS)} in ${pick(FILES)}`, usd, usdEstimated: src === 'claude', tokensIn: spFinal.in, tokensOut: spFinal.out,
        cacheHit: spFinal.cacheHit, models: [...new Set(calls.map((c) => c.model).concat(calls.length ? [] : [model]))], seconds: Math.floor((at - t) / 1000) + 5,
        cacheBreak: idle && calls.length ? { kind: 'idle', to: model, gapSeconds: 3600 * (2 + Math.floor(r() * 20)), ttlSeconds: 300, uncached: calls[0].cacheWrite } : null,
        toolCalls: tools, toolCount: tools.length, calls, split: spFinal, note: src === 'vscode' ? 'VS Code stores one total per chat request, so there is no per-call breakdown.' : (!spFinal.known ? 'No token data for this prompt: the Copilot tracking token logger was not running, so Copilot CLI recorded only credits.' : null),
      });
      t = at;
    }
    const usd = prompts.reduce((a, p) => a + (p.usd || 0), 0);
    sessions.push({
      kind: 'session', id, source: src, title, cwd: `~/work/${cwd}`, branch, ts: prompts[prompts.length - 1].ts, usd,
      tokensIn: prompts.reduce((a, p) => a + p.tokensIn, 0), tokensOut: prompts.reduce((a, p) => a + p.tokensOut, 0),
      prompts, split: mergeSplit(prompts.map((p) => p.split)), models: modelsOf(prompts),
    });
  });
  return sessions.sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

/** The arguments a tool of this demo would have been called with. */
function argsFor(t) {
  if (t.name === 'Bash' || t.name === 'bash') return { command: t.detail, description: 'Run the command' };
  if (/grep/i.test(t.name)) return { pattern: 'retry', path: 'src/http/client.ts', output_mode: 'content' };
  return { file_path: t.detail };
}

/** What a call went in and came out, for the call screen: it follows the call's own first tool. */
function demoCallContent(promptText, call) {
  const t = call.toolCalls[0];
  const intent = { Bash: 'Run the tests to see whether the change holds.', Grep: 'Find where retries are configured.', Read: 'Read the file before changing it.', Edit: 'Apply the change.' }[t.name] || 'Look at the file.';
  return {
    input: [
      { type: 'text', text: promptText },
      { type: 'result', text: 'src/http/client.ts\n  41: const MAX_RETRIES = 3;\n  58: await sleep(backoff(attempt));\nsrc/jobs/nightly.py\n  12: RETRY_LIMIT = 5' },
    ],
    output: [
      { type: 'thinking', text: `${intent} The earlier results show the retry settings live in the HTTP client and the nightly job.` },
      { type: 'text', text: `${intent}` },
      { type: 'tool', name: t.name, text: JSON.stringify(argsFor(t), null, 2) },
    ],
  };
}

/** One tool call's input and result, by the kind of tool. */
function demoToolContent(tool) {
  const args = JSON.stringify(argsFor(tool), null, 2);
  const result = /bash/i.test(tool.name)
    ? '> billing-service@2.4.0 test\n> jest --runInBand\n\n PASS  src/export/service.test.ts\n PASS  src/http/client.test.ts\n FAIL  src/jobs/nightly.test.ts\n  ● nightly job › retries a failed batch\n    expected 3 calls, received 2\n\nTest Suites: 1 failed, 2 passed, 3 total\nTests:       1 failed, 14 passed, 15 total'
    : /grep/i.test(tool.name) ? 'src/http/client.ts\n  41: const MAX_RETRIES = 3;\n  58: await sleep(backoff(attempt));\n  72: if (attempt >= MAX_RETRIES) throw err;'
      : 'export async function request(url: string, init?: RequestInit) {\n  for (let attempt = 0; ; attempt++) {\n    try { return await fetch(url, init); }\n    catch (err) { if (attempt >= MAX_RETRIES) throw err; }\n  }\n}';
  return { input: args, result, error: false };
}

module.exports = { demoSessions, demoCallContent, demoToolContent, sourceName };

if (require.main === module) {
  const ss = demoSessions();
  const by = {};
  for (const s of ss) by[s.source] = (by[s.source] || 0) + 1;
  console.log(ss.length, 'sessions', by, '$' + ss.reduce((a, s) => a + s.usd, 0).toFixed(2), ss[ss.length - 1].ts.slice(0, 10), '..', ss[0].ts.slice(0, 10));
}
