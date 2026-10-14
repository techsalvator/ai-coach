'use strict';
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const { advise } = require('./advice');
const { habits } = require('./habits');
const F = require('./filter');
const CS = require('./coachsettings');
const Setup = require('./copilotsetup');
const SORT = require('./sort');
const Held = require('./heldprompts');
const CH = require('./charts');
const { dayTotal, money, tokens } = require('./model');
const { loadAll, callContent, promptTools, toolContent, SOURCE_LABEL } = require('./sources');
const Quota = require('./quota');
const Guard = require('./modelguard');

let allSessions = [];
let sessions = [];
let filter = { ...F.EMPTY };
let sort = { ...SORT.DEFAULT };
let views = [];
let extensionUri;
let errors = [];
let overviewDays = 0; // 0 = by month, from the first prompt
let overviewMonth = null; // 'YYYY-MM' while drilled into one month
let lastSynced = null;
let syncing = false;
let advice = { total: 0, findings: [], small: [] };
let guard = null; // the model guard's state while it is on (modelguard.js), else null
/** The measured findings, then the token-saving tools that were not used (habits.js): what it cost, then what would have prevented it. */
function adviseAll(list) {
  const a = advise(list);
  let unused = [];
  try { unused = habits(list, { tracking: Setup.status().enabled, coach: CS.read().find((s) => s.key === 'coach').on }); } catch { /* the measured findings still stand */ }
  return { ...a, findings: [...a.findings, ...unused] };
}
let loading = false;
const changed = new vscode.EventEmitter();

const tk = (sp) => (sp.known ? `${tokens(sp.in)} in / ${tokens(sp.out)} out` : 'no token data');
const ICON = { claude: 'comment-discussion', copilot: 'terminal', vscode: 'comment-discussion' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clip = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const when = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

class Tree {
  constructor() { this.onDidChangeTreeData = changed.event; }
  getChildren(node) {
    if (!node) return sessions.map((s, i) => ({ ...s, path: [i] }));
    if (node.kind === 'session') return node.prompts.map((p, i) => ({ ...p, path: [...node.path, i] }));
    if (node.kind === 'prompt') return node.calls.map((c, i) => ({ ...c, sid: node.sid, pn: node.n, path: [...node.path, i] }));
    return [];
  }
  getTreeItem(n) {
    const S = vscode.TreeItemCollapsibleState;
    const item = new vscode.TreeItem('', n.kind === 'call' ? S.None : S.Collapsed);
    if (n.kind === 'session') {
      item.label = n.title; item.description = `${n.id.slice(0, 8)} · ${SOURCE_LABEL[n.source]} · ${money(n.usd)} · ${tk(n.split)} · ${n.prompts.length} prompts · ${when(n.ts)}`;
      item.tooltip = `${n.title}\n${n.id}\n${n.cwd || ''}`;
      item.iconPath = new vscode.ThemeIcon(ICON[n.source]);
    } else if (n.kind === 'prompt') {
      item.label = clip(n.text, 60); item.description = `${money(n.usd)} · ${tk(n.split)}`;
      item.iconPath = new vscode.ThemeIcon(n.cacheBreak ? 'warning' : 'comment');
    } else {
      item.label = `${n.n}. ${n.model}${n.who === 'main' ? '' : ` (${n.who})`}`; item.description = `${money(n.usd)} · ${tokens(n.tokensIn)} in / ${tokens(n.tokensOut)} out${n.toolCalls && n.toolCalls.length ? ` · ${toolSummary(n.toolCalls)}` : ''}`;
      item.iconPath = new vscode.ThemeIcon('zap');
    }
    item.id = n.kind === 'session' ? n.id : n.kind === 'prompt' ? `${n.sid}:${n.n}` : `${n.sid}:${n.pn}:${n.n}`;
    item.contextValue = n.kind;
    item.command = { command: 'aiCost.showDetail', title: 'Show detail', arguments: [n.path] };
    return item;
  }
}

class AdviceTree {
  constructor() { this.onDidChangeTreeData = changed.event; }
  getChildren(node) {
    if (!node) return advice.findings.map((f, i) => ({ kind: 'finding', i, f }));
    if (node.kind === 'finding') return node.f.targets.map((path) => ({ kind: 'target', path }));
    return [];
  }
  getTreeItem(n) {
    const S = vscode.TreeItemCollapsibleState;
    if (n.kind === 'finding') {
      const item = new vscode.TreeItem(n.f.title, n.f.targets.length ? S.Collapsed : S.None);
      item.description = n.f.saving ? `save up to ${money(n.f.saving)}` : n.f.status || '';
      item.iconPath = new vscode.ThemeIcon(n.f.habit ? 'tools' : 'lightbulb');
      item.tooltip = n.f.detail;
      item.command = { command: 'aiCost.showAdvice', title: 'Show advice', arguments: [n.i] };
      return item;
    }
    const p = resolve(n.path);
    const item = new vscode.TreeItem(p ? clip(p.text, 60) : 'out of date', S.None);
    item.description = p ? `${money(p.usd)} · ${tk(p.split)}` : '';
    item.iconPath = new vscode.ThemeIcon('comment');
    item.command = { command: 'aiCost.showDetail', title: 'Show detail', arguments: [n.path] };
    return item;
  }
}

const coachChanged = new vscode.EventEmitter();
class CoachTree {
  constructor() { this.onDidChangeTreeData = coachChanged.event; }
  getChildren(node) {
    if (node) return [];
    return [{ key: 'tracking', kind: 'tracking' }, ...CS.read(), { key: 'results', kind: 'results' }, ...CS.readLimits().map((l) => ({ ...l, kind: 'limit' })), { key: 'pause', kind: 'pause' }];
  }
  getTreeItem(sw) {
    const item = new vscode.TreeItem(sw.kind === 'tracking' ? 'Copilot tracking' : sw.label, vscode.TreeItemCollapsibleState.None);
    item.id = sw.key;
    if (sw.kind === 'tracking') {
      const st = Setup.status();
      item.checkboxState = st.enabled ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      const failed = st.enabled ? CS.readErrors() : [];
      item.description = st.enabled ? (st.plugin ? 'on (old plugin still installed)' : st.bareNode ? 'on (hook needs repair: reload the window)' : failed.length ? `on (the hook failed ${failed.length} time${failed.length === 1 ? '' : 's'} in the last day)` : 'on') : st.copilotFound ? 'off' : 'off (Copilot not found)';
      item.iconPath = new vscode.ThemeIcon(st.enabled ? 'pass-filled' : 'circle-outline');
      item.tooltip = 'Installs the cost-tips hook and the token logger for Copilot, from this extension.\n'
        + 'Without it Copilot sessions still show credits and prompt tokens read from VS Code, but no per-call tokens and no tips.\n'
        + (st.plugin ? '\nThe old Copilot CLI plugin is still installed. Turn tracking on to remove it.' : '')
        + (failed.length ? `\nThe hook failed on ${failed.length} prompt${failed.length === 1 ? '' : 's'} in the last day, which then ran unchecked. Last: ${failed[failed.length - 1].error}` : '');
      item.command = { command: st.enabled ? 'aiCost.disableCopilotTracking' : 'aiCost.enableCopilotTracking', title: 'Toggle Copilot tracking' };
      return item;
    }
    if (sw.kind === 'results') {
      const r = CS.readResults().total;
      item.label = 'Coach results';
      item.description = r.held + r.tips ? `${r.held} held · ${r.reworded} changed · ${r.sentAnyway} sent anyway${r.avoidedUsd ? ` · about ${money(r.avoidedUsd)} avoided` : ''} (30 days)` : 'nothing yet (30 days)';
      item.iconPath = new vscode.ThemeIcon('graph');
      item.tooltip = 'What the coach did over the last 30 days: tips shown, prompts held, and whether you sent them anyway or changed them.';
      item.command = { command: 'aiCost.coachResults', title: 'Show coach results' };
      return item;
    }
    if (sw.kind === 'limit') {
      item.label = sw.label;
      const auto = sw.key === 'dailyPremium' && !(sw.value > 0) ? autoBudget() : null;
      item.description = `${auto ? `automatic, about ${auto} a day` : sw.format(sw.value)}${sw.isDefault ? ' (default)' : ''}${sw.key === 'costGateUsd' && !Setup.status().enabled ? ' · needs Copilot tracking' : ''}`;
      item.iconPath = new vscode.ThemeIcon('settings-gear');
      item.tooltip = `${sw.help}\n\nClick to change it.`;
      item.command = { command: 'aiCost.editLimit', title: 'Change', arguments: [sw.key] };
      return item;
    }
    if (sw.kind === 'pause') {
      const p = CS.readPause();
      item.label = 'Pause strict mode';
      item.description = p.active ? `paused until ${new Date(p.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'off';
      item.iconPath = new vscode.ThemeIcon(p.active ? 'debug-pause' : 'debug-start');
      item.tooltip = 'Stop strict mode holding prompts for a while. Tips still show. It resumes by itself.';
      item.command = { command: 'aiCost.pauseStrict', title: 'Pause or resume strict mode' };
      return item;
    }
    const off = !Setup.status().enabled;
    item.checkboxState = sw.on ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    item.description = sw.locked ? `${sw.on ? 'on' : 'off'} (set by ${sw.env})`
      : off ? `${sw.on ? 'on' : 'off'} (inactive: Copilot tracking is off)`
      : sw.idle ? `${sw.on ? 'on' : 'off'} (inactive: ${sw.needs === 'coach' ? 'Coach' : 'Strict mode'} is off)` : sw.on ? 'on' : 'off';
    item.iconPath = new vscode.ThemeIcon(sw.on && !sw.idle && !off ? 'pass-filled' : 'circle-outline');
    item.tooltip = `${sw.help}${sw.locked ? `\n\nThe environment variable ${sw.env} decides this, so changing it here has no effect until the variable is removed.` : ''}`;
    item.command = { command: 'aiCost.toggleCoach', title: 'Toggle', arguments: [sw.key] };
    return item;
  }
}

/** Asks first, then writes the hook, the token logger and the runtime they run from. */
async function enableTracking() {
  const st = Setup.status();
  const p = st.paths;
  const home = (f) => f.replace(os.homedir(), '~');
  const detail = [
    'This writes to your user-level Copilot folder:',
    '',
    `• ${home(p.hook)}: the hook that shows cost tips in VS Code chat and Copilot CLI`,
    `• ${home(p.logger)}: records the tokens of each Copilot CLI model call`,
    `• ${home(p.runtime)}: the scripts the hook runs`,
    '',
    'Nothing is sent anywhere. Copilot CLI loads extensions only in experimental mode: run /experimental on once.',
    ...(st.plugin ? ['', 'The old ai-cost-drilldown Copilot CLI plugin is installed. It can be removed now: this extension replaces it.'] : []),
  ].join('\n');
  const buttons = st.plugin ? ['Set up and remove the old plugin', 'Set up'] : ['Set up'];
  const pick = await vscode.window.showInformationMessage('Set up Copilot cost tracking?', { modal: true, detail }, ...buttons);
  if (!pick) return;
  try { Setup.enable(); } catch (err) { vscode.window.showErrorMessage(`AI Cost: could not set up Copilot tracking: ${err.message}`); coachChanged.fire(); return; }
  let extra = '';
  if (pick.startsWith('Set up and remove')) {
    const r = Setup.removePlugin();
    extra = r.ok ? ' The old plugin was removed.' : ` The old plugin could not be removed (${r.output || 'copilot not found'}); run "copilot plugin uninstall ai-cost-drilldown".`;
  }
  coachChanged.fire();
  const health = Setup.check();
  if (health.ok) vscode.window.showInformationMessage(`Copilot tracking is set up and its hook runs. In Copilot CLI run /experimental on, then start a new session.${extra}`);
  else vscode.window.showErrorMessage(`Copilot tracking is set up, but its hook cannot run: ${health.output.split('\n')[0] || `exit code ${health.status}`}. Prompts will not be checked until that is fixed.${extra}`);
}

/** Runs the hook as VS Code does (a thin PATH) and says whether it works. */
function checkTracking() {
  const st = Setup.status();
  if (!st.enabled) { vscode.window.showInformationMessage('Copilot tracking is off. Run "AI Cost: Set Up Copilot Tracking" first.'); return; }
  const r = Setup.check();
  const failed = CS.readErrors();
  if (r.ok && failed.length) vscode.window.showWarningMessage(`The Copilot hook runs, but it failed on ${failed.length} prompt${failed.length === 1 ? '' : 's'} in the last day, which then ran unchecked. Last: ${failed[failed.length - 1].error} ${failed[failed.length - 1].at}`.trim());
  else if (r.ok) vscode.window.showInformationMessage('Copilot tracking works: the hook ran with the same thin PATH VS Code gives it.');
  else vscode.window.showErrorMessage(`The Copilot hook cannot run: ${r.output.split('\n')[0] || `exit code ${r.status}`}. Run "AI Cost: Set Up Copilot Tracking" again; if it keeps failing, check that node is installed.`, 'Set up again').then((p) => { if (p) enableTracking(); });
}

async function disableTracking() {
  const pick = await vscode.window.showWarningMessage('Remove Copilot cost tracking?', { modal: true, detail: 'This removes the hook, the token logger and the scripts they run. Your token log, settings and sessions are kept.' }, 'Remove');
  if (!pick) return;
  Setup.disable();
  coachChanged.fire();
  vscode.window.showInformationMessage('Copilot tracking was removed.');
}

const RULE_NAME = {
  'cost-gate': 'Cold cache over the cost limit', repeat: 'Repeated prompt', 'vague-retry': 'Bare retry', 'no-error-text': 'Problem without the error',
  'no-target': 'Nothing to work on', 'multi-ask': 'Several asks in one', 'cache-expired': 'Cache expired', 'long-session': 'Long session', 'big-paste': 'Big paste', 'daily-budget': 'Daily budget',
};
const lifetime = (s) => (s >= 3600 ? `${s / 3600} hour${s === 3600 ? '' : 's'}` : `${s / 60} minutes`);
/** ttl: the measured cache lifetimes (coachsettings readTtl). */
function coachResultsHtml(results, ttl = {}) {
  const { byId, total } = results;
  const learned = [];
  if (total.checked) learned.push(`Of ${total.checked} cold-cache warning${total.checked === 1 ? '' : 's'} you sent anyway, the next model call started cold ${total.right === total.checked ? (total.checked === 1 ? 'as warned' : 'every time, as warned') : `${total.right} time${total.right === 1 ? '' : 's'}`}${total.right < total.checked ? `: ${total.checked - total.right} ${total.checked - total.right === 1 ? 'was' : 'were'} a false alarm` : ''}.`);
  for (const [model, m] of Object.entries(ttl)) learned.push(`${esc(model)} keeps its cache for <b>${lifetime(m.ttl)}</b> on your plan${m.ttl === m.usual ? ', as documented' : `, not the documented ${lifetime(m.usual)}`}: measured over ${m.seen} idle gaps in the token log${m.wrong ? ` (${m.wrong} did not fit)` : ''}. The cache rules use the measured figure.`);
  const rows = Object.entries(byId).sort((a, b) => (b[1].held + b[1].tips) - (a[1].held + a[1].tips)).map(([id, r]) =>
    `<tr><td class="l">${esc(RULE_NAME[id] || id)}</td><td>${r.tips}</td><td>${r.held}</td><td>${r.reworded}</td><td>${r.sentAnyway}</td><td>${r.avoidedUsd ? money(r.avoidedUsd) : '—'}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);padding:16px}h2{font-weight:500}h3{margin:20px 0 6px;font-weight:500}.quota p{margin:4px 0}.qbar{height:8px;border-radius:4px;background:var(--vscode-input-background);overflow:hidden;max-width:520px}.qbar i{display:block;height:100%;background:var(--vscode-charts-blue,#3794ff)}.note{color:var(--vscode-descriptionForeground)}
.u{border-collapse:collapse;width:100%;max-width:780px}.u td{padding:4px 14px 4px 0;white-space:nowrap}.u td:not(.l){text-align:right}.u .h td{color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-panel-border)}${CH.CSS}</style>
<h2>Coach results</h2><p class="note">The last 30 days: what the coach showed or held, and what you did next.</p>
${tiles([['Held', total.held], ['Changed after a hold', total.reworded], ['Sent anyway', total.sentAnyway], ['Estimated avoided', total.avoidedUsd ? money(total.avoidedUsd) : '—']])}
${rows ? `<h3>By rule</h3><table class="u"><tr class="h"><td class="l">Rule</td><td>Tips shown</td><td>Held</td><td>Changed</td><td>Sent anyway</td><td>Est. avoided</td></tr>${rows}</table>`
    : '<p>Nothing yet. Tips and held prompts appear here once Copilot tracking is on and you have sent prompts.</p>'}
${learned.length ? `<h3>What the coach learned</h3>${learned.map((l) => `<p>${l}</p>`).join('')}` : ''}
<p class="note">A <b>held</b> prompt was stopped by strict mode. <b>Changed</b> means you then sent something different, or the hold no longer applied (for example after /compact); <b>sent anyway</b> means you sent the same prompt again.
A cold cache is not warmed by rewording the prompt, so there a different prompt is the same hold: it is <b>changed</b> once the cache is dealt with (/compact, /clear, /new) or the session is left for a day, and <b>sent anyway</b> when a prompt is sent again on it.
<b>Estimated avoided</b> counts only held prompts you changed: for a cold cache, the extra cost of re-sending the context at full price; for a repeat, what the earlier run cost. It is an estimate from list prices, not a measured saving.</p>`;
}
function showCoachResults() { openHtml('AI Cost: coach results', coachResultsHtml(CS.readResults(), CS.readTtl())); }

async function editLimit(key) {
  const l = CS.readLimits().find((x) => x.key === key);
  if (!l) return;
  const unset = l.key === 'dailyPremium' && !(l.value > 0);
  const auto = unset ? autoBudget() : null;
  const v = await vscode.window.showInputBox({
    title: `${l.label}`, value: unset ? '' : String(l.value), placeHolder: unset ? `automatic${auto ? `: about ${auto} a day` : ''}` : undefined, prompt: `${l.help} Leave empty for the default.`,
    validateInput: (x) => (x.trim() === '' || (Number.isFinite(Number(x)) && Number(x) > 0) ? null : 'Enter a number above zero, or leave empty'),
  });
  if (v == null) return;
  try { CS.writeLimit(key, v.trim() === '' ? null : Number(v)); } catch (err) { vscode.window.showErrorMessage(`AI Cost: ${err.message}`); }
  coachChanged.fire();
}

async function pauseStrict() {
  const p = CS.readPause();
  const items = [
    { label: '30 minutes', minutes: 30 }, { label: '1 hour', minutes: 60 }, { label: '4 hours', minutes: 240 },
    { label: 'Until tomorrow', minutes: Math.ceil((new Date().setHours(24, 0, 0, 0) - Date.now()) / 60e3) },
    ...(p.active ? [{ label: 'Resume strict mode now', minutes: null }] : []),
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'Pause strict mode', placeHolder: 'Prompts are not held while it is paused. Tips still show.' });
  if (!pick) return;
  CS.writePause(pick.minutes);
  coachChanged.fire();
}

// --- strict mode in VS Code's chat: the hook stops the prompt, and the banner is shown here ---

function heldPage(rec) {
  return `<!doctype html><meta charset="utf-8"><style>body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);padding:16px;max-width:780px}h2{font-weight:500}
blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground)}code{font-family:var(--vscode-editor-font-family)}
pre{white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto;padding:8px;background:var(--vscode-textCodeBlock-background);border-radius:4px}ul{padding-left:1.2em}</style>
<h2>Prompt held</h2>${Held.bannerHtml(rec)}<h3>The prompt</h3><pre>${esc(String(rec.prompt || '').slice(0, 4000))}</pre>
<p><i>In the notification, <b>Send anyway</b> sends this prompt to the chat again, which runs it. <b>Copy prompt</b> copies it so you can reword it first.</i></p>`;
}

/** A held prompt as a notification: why it was held, and three ways forward. */
function handleHeld(rec) {
  return vscode.window.showWarningMessage(Held.message(rec), 'Why', 'Send anyway', 'Copy prompt').then(async (pick) => {
    if (pick === 'Why') openHtml('AI Cost: held prompt', heldPage(rec));
    else if (pick === 'Send anyway') {
      try { await vscode.commands.executeCommand('workbench.action.chat.open', { query: rec.prompt, isPartialQuery: false }); } catch {
        await vscode.env.clipboard.writeText(rec.prompt);
        vscode.window.showInformationMessage('AI Cost could not send it for you. The prompt is copied: paste it into the chat and send it again.');
      }
    } else if (pick === 'Copy prompt') {
      await vscode.env.clipboard.writeText(rec.prompt);
      vscode.window.setStatusBarMessage('AI Cost: prompt copied. Send the same prompt again to run it.', 4000);
    }
  });
}

/**
 * Tells the hook this window will show held prompts (a heartbeat file: without it the hook gives VS Code a tip instead of
 * blocking), and shows each prompt the hook holds. Only the focused window shows one, so two windows do not both pop it up.
 */
function startHeldNotifier(ctx) {
  const on = () => vscode.workspace.getConfiguration('aiCost').get('notifyHeldPrompts', true);
  const beat = () => { try { if (on()) Held.beat(); else Held.stop(); } catch { /* the hook then gives tips */ } };
  const show = () => {
    if (!on() || !vscode.window.state.focused) return;
    for (const rec of Held.pending()) { Held.remove(rec); handleHeld(rec); }
  };
  beat();
  let watcher;
  try { fs.mkdirSync(Held.dir(), { recursive: true }); watcher = fs.watch(Held.dir(), { persistent: false }, show); } catch { /* the poll below still finds them */ }
  const hb = setInterval(beat, 15000);
  const poll = setInterval(show, 3000);
  ctx.subscriptions.push(
    { dispose() { clearInterval(hb); clearInterval(poll); if (watcher) watcher.close(); try { Held.stop(); } catch { /* none */ } } },
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('aiCost.notifyHeldPrompts')) beat(); }),
  );
}

function toggleCoach(key, on) {
  const sw = CS.read().find((x) => x.key === key);
  if (!sw) return;
  try {
    CS.write(key, on == null ? !sw.on : on);
  } catch (err) { vscode.window.showErrorMessage(`AI Cost: could not save the setting: ${err.message}`); }
  if (sw.locked) vscode.window.showWarningMessage(`AI Cost: ${sw.env} is set in the environment, so it overrides this switch.`);
  coachChanged.fire();
}

const RANGES = [[0, 'By month'], [-1, 'By day'], [7, '7d'], [30, '30d'], [90, '90d']];
const rangeButtons = () => `<span class="range">${RANGES.map(([d, l]) => `<button class="${d === overviewDays && !overviewMonth ? 'on' : ''}" data-drill='${JSON.stringify({ kind: 'range', value: d })}' title="${d > 0 ? `Last ${d} days` : d < 0 ? 'Every day that is loaded' : 'Every month that is loaded'}">${l}</button>`).join('')}</span>`;
function monthTable(months, compact) {
  const present = Object.keys(CH.SOURCE_SLOT).filter((k) => months.some((m) => m.bySource[k]));
  const head = `<tr class="h"><td class="l">Month</td>${compact ? '' : present.map((k) => `<td>${esc(SOURCE_LABEL[k])}</td>`).join('')}<td>Total</td>${compact ? '' : '<td>Sessions</td><td>Prompts</td>'}</tr>`;
  const rows = months.map((m) => `<tr data-drill="${esc(JSON.stringify({ kind: 'month', value: m.month }))}"><td class="l">${esc(CH.monthName(m.month, true))}</td>${compact ? '' : present.map((k) => `<td>${m.bySource[k] ? money(m.bySource[k]) : '—'}</td>`).join('')}<td><b>${money(m.total)}</b></td>${compact ? '' : `<td>${m.sessions}</td><td>${m.prompts}</td>`}</tr>`).join('');
  return `<table class="u tools nosort mt">${head}${rows}</table>`;
}
/** The tools the chart's legend lets you include or leave out. Null with one tool: there is nothing to choose. */
function harnessChoice() {
  const tools = F.sourcesIn(allSessions);
  if (tools.length < 2) return null;
  return { tools, active: (k) => !filter.sources.length || filter.sources.includes(k) };
}
/** Says how far back the loaded data goes when the chosen range reaches past it. */
function coverageNote(loaded) {
  const ts = loaded.flatMap((s) => s.prompts.map((p) => Date.parse(p.ts)));
  if (!ts.length) return '';
  const first = new Date(Math.min(...ts)); const days = Math.ceil((Date.now() - first) / 86400000);
  if (overviewDays > 0 && days >= overviewDays) return '';
  return `<p class="note">The loaded history starts ${first.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} (${days} days). Copilot history is set by <code>aiCost.copilotDays</code>; Claude Code deletes its own transcripts after about 30 days unless <code>cleanupPeriodDays</code> is raised.</p>`;
}

function overviewHtml(compact = false) {
  const loaded = sessions;
  const all = overviewMonth ? F.applyFilter(sessions, { ...F.EMPTY, day: `${overviewMonth}-01..${overviewMonth}-31` }) : F.lastDays(sessions, overviewDays); const prompts = all.flatMap((s) => s.prompts);
  const usd = prompts.reduce((a, p) => a + (p.usd || 0), 0);
  const sp = all.length ? mergeSplitOf(all) : null;
  const models = new Map();
  for (const s of all) for (const m of s.models) { const x = models.get(m.model) || { usd: 0, calls: 0, in: 0, out: 0 }; x.usd += m.usd; x.calls += m.calls; x.in += m.in; x.out += m.out; models.set(m.model, x); }
  const topModels = [...models.entries()].sort((a, b) => b[1].usd - a[1].usd).slice(0, 8);
  const top = all.flatMap((ss) => ss.prompts.map((p) => ({ p, sid: ss.id }))).filter((x) => x.p.usd).sort((a, b) => b.p.usd - a.p.usd).slice(0, 8);
  const bySource = Object.keys(CH.SOURCE_SLOT).map((k) => ({ k, usd: all.filter((x) => x.source === k).reduce((a, x) => a + x.usd, 0), n: all.filter((x) => x.source === k).length })).filter((x) => x.n);
  const chart = compact ? { width: 320, height: 130, labels: 5 } : {};
  const chartTitle = overviewMonth ? `Cost per day, ${CH.monthName(overviewMonth, true)}` : overviewDays === 0 ? 'Cost by month' : overviewDays < 0 ? 'Cost per day, all loaded history' : `Cost per ${overviewDays > 60 ? 'week' : 'day'}, last ${overviewDays} days`;
  const crumb = overviewMonth ? `<nav class="crumbs"><a class="cr" data-drill='{"kind":"month","value":""}' tabindex="0" role="button">All months</a><i class="sep">›</i><span>${esc(CH.monthName(overviewMonth, true))}</span><button class="link" data-drill='${JSON.stringify({ kind: 'filterMonth', value: overviewMonth })}'>Filter sessions to this month</button></nav>` : '';
  const stamp = syncing ? 'Syncing…' : lastSynced ? `Synced ${lastSynced.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Not synced yet';
  const syncBtn = `<button class="link" data-drill='{"kind":"sync"}' title="Read the session logs again">↻ Sync sessions</button>`;
  const body = (compact ? '' : `<h2>AI cost overview</h2>`) + crumb
    + `<p class="note sync">${syncBtn} <span>${stamp}</span>${rangeButtons()}</p>`
    + `<p class="note">${all.length} sessions, ${prompts.length} prompts${F.isActive(filter) ? ` · filtered: ${esc(F.describe(filter))} <button class="link" data-drill='{"kind":"clear"}'>Clear</button>` : ''}.${compact ? '' : ' Costs are list-price estimates: Claude Code per token, Copilot in AI credits at $0.01.'}</p>`
    + tiles([['Total cost', money(usd)], overviewMonth ? ['Prompts', prompts.length] : ['Today', money(dayTotal(all))], ['Sessions', all.length], ['Cache hit', sp && sp.cacheHit != null ? `${Math.round(sp.cacheHit * 100)}%` : '—']])
    + quotaHtml(Quota.read())
    + `<h3>${chartTitle} <span class="note">· ${overviewMonth || overviewDays === 0 ? 'click a bar to open' : 'click a bar to filter'}</span></h3>${CH.dailyCost(all, SOURCE_LABEL, { days: overviewDays, month: overviewMonth, chart, chips: harnessChoice() })}${overviewMonth ? '' : coverageNote(loaded)}`
    + (!overviewMonth && overviewDays === 0 ? `<h3>Cost by month</h3>${monthTable(CH.monthTotals(all), compact)}` : '')
    + (sp && sp.known ? `<h3>Where the tokens went</h3>${CH.composition(CH.tokenSegments(sp))}` : '')
    + (bySource.length > 1 ? `<h3>By source</h3>${CH.hbars(bySource.map((x) => ({ label: SOURCE_LABEL[x.k], value: x.usd, text: `${money(x.usd)} · ${x.n} sessions`, drill: { kind: 'source', value: x.k } })))}` : '')
    + `<h3>By model</h3>${CH.hbars(topModels.slice(0, compact ? 4 : 8).map(([m, x]) => ({ label: m, value: x.usd, text: compact ? money(x.usd) : `${money(x.usd)} · ${x.calls} calls`, tip: `${m}\n${money(x.usd)} · ${x.calls} calls\n${tokens(x.in)} in / ${tokens(x.out)} out`, drill: { kind: 'model', value: m } })))}`
    + (compact ? '' : `<h3>Most expensive prompts</h3>${CH.hbars(top.map((x) => ({ label: clip(x.p.text, 60), value: x.p.usd, text: money(x.p.usd), tip: `${clip(x.p.text, 120)}\n${when(x.p.ts)} · ${tk(x.p.split)}`, drill: { kind: 'prompt', sid: x.sid, n: x.p.n } })))}`)
    + (compact ? `<button class="link" data-drill='{"kind":"full"}'>Open the full overview ›</button>` : '');
  return `<!doctype html><meta charset="utf-8"><style>body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);padding:${compact ? '4px 10px 12px' : '16px'}}h2{font-weight:500}h3{margin:20px 0 6px;font-weight:500}.note{color:var(--vscode-descriptionForeground)}${CH.CSS}</style><body class="${compact ? 'compact' : ''}">${body}<script>${CH.TIP_SCRIPT}</script><script>${CH.DRILL_SCRIPT}</script>`;
}
/** Copilot's premium requests left this month, from the quota Copilot CLI logs. */
/** The automatic daily budget (what is left spread over the weekdays remaining), or null with no reading or at a weekend. */
function autoBudget() {
  const b = Quota.budget(Quota.read(), Date.now(), { todayUsed: premiumToday(allSessions) || 0 });
  return b && b.todayCounts ? b.perDay : null;
}
function premiumToday(sessions, day = new Date()) { // today's premium requests, or null when no prompt today has a count
  let n = 0; let any = false;
  for (const s of sessions) for (const p of s.prompts) {
    if (p.premium == null || new Date(p.ts).toDateString() !== day.toDateString()) continue;
    n += p.premium; any = true;
  }
  return any ? n : null;
}
/** What the day's remaining budget buys, by model, and the last 7 days' pace when it tells another story than the month's. */
function pacingHtml(q, bud, today, now) {
  const parts = [];
  const recent = Quota.recentPace(q, allSessions, now);
  if (recent && recent.differs) {
    const dir = recent.projected > recent.month ? 'faster' : 'slower';
    parts.push(`<p class="note">The last ${recent.days} days ran ${dir} than the month: at ${recent.perDay} a day the month ends at about ${recent.projected.toLocaleString()}${recent.over ? ', <b>over what is included</b>' : ''}, against ${recent.month.toLocaleString()} at the month's pace.</p>`);
  }
  if (bud) {
    const room = Math.max(0, bud.perDay - (bud.todayCounts && today != null ? today : 0));
    const cap = Quota.capacity(room, Quota.observed(allSessions, now));
    const what = bud.todayCounts ? `Room left today (${Math.round(room * 10) / 10})` : `A weekday's budget (${bud.perDay})`;
    const each = (c) => (c.perPrompt > 0 ? `${c.count} on ${esc(c.model)} <span class="note">(${c.perPrompt} a prompt${c.generic ? '' : `, from your ${c.prompts} prompts`})</span>` : `unlimited on ${esc(c.model)} <span class="note">(counts 0)</span>`);
    parts.push(`<p class="note">${what} buys about: ${cap.map(each).join(' · ')}${cap[0].generic ? '. Check a model\'s multiplier with /model in Copilot.' : '.'}</p>`);
  }
  return parts.join('');
}
function quotaHtml(q, now = Date.now()) {
  if (!q || q.unlimited) return '';
  const when = (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (q.stale) return `<p class="note">Copilot premium requests: the last reading is from a month that ended ${esc(when(q.resets))}. It updates the next time Copilot CLI makes a call.</p>`;
  const pace = Quota.pace(q, now);
  const today = premiumToday(allSessions, new Date(now));
  const bud = Quota.budget(q, now, { fixed: CS.dailyPremium(), todayUsed: today || 0 });
  const unit = 'weekday';
  const usedPct = Math.min(100, Math.max(0, 100 - q.leftPct));
  const left = Math.max(0, q.entitlement - q.used);
  const line = pace
    ? `Resets ${esc(when(q.resets))} (${pace.daysLeft} days). At this pace the month ends at about ${pace.projected.toLocaleString()} requests${pace.over ? `, <b>over the ${q.entitlement.toLocaleString()} included</b>` : ''}.`
    : `Resets ${esc(when(q.resets))}.`;
  return `<h3>Copilot premium requests</h3><div class="quota" title="Read from Copilot CLI's session log at ${esc(new Date(q.ts).toLocaleString())}"><div class="qbar"><i style="width:${usedPct}%"></i></div>`
    + `<p><b>${left.toLocaleString()}</b> of ${q.entitlement.toLocaleString()} left (${q.leftPct}%) · ${q.used.toLocaleString()} used${q.overage ? ` · ${q.overage} over` : ''}</p><p class="note">${line}</p>`
    + (bud ? `<p><b>${bud.perDay}</b> requests a ${unit}${bud.todayCounts && today != null ? ` · today ${Math.round(today * 10) / 10} of ${bud.perDay}` : ''} <span class="note">· ${bud.fixed ? 'your daily budget' : 'what is left, spread over the weekdays remaining'}, ${bud.left.toLocaleString()} left for ${bud.days} ${unit}s${bud.todayCounts ? ', today included' : ''}</span></p>` : '') + pacingHtml(q, bud, today, now) + '</div>';
}
function mergeSplitOf(ss) {
  const t = { fresh: 0, cacheRead: 0, cacheWrite: 0, out: 0, calls: 0, known: false };
  for (const x of ss) { t.fresh += x.split.fresh; t.cacheRead += x.split.cacheRead; t.cacheWrite += x.split.cacheWrite; t.out += x.split.out; t.calls += x.split.calls; t.known = t.known || x.split.known; }
  t.in = t.fresh + t.cacheRead + t.cacheWrite; t.cacheHit = t.in ? t.cacheRead / t.in : null;
  return t;
}
// The full overview lives in its own editor tab, apart from the detail panel, so opening a session does not replace it.
let overviewPanel;
function showOverview(focus = true) {
  if (overviewPanel) { overviewPanel.reveal(undefined, !focus); return; }
  overviewPanel = vscode.window.createWebviewPanel('aiCostOverview', 'AI Cost', { viewColumn: vscode.ViewColumn.Active, preserveFocus: !focus }, { enableScripts: true, retainContextWhenHidden: true });
  overviewPanel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg');
  overviewPanel.onDidDispose(() => { overviewPanel = undefined; });
  overviewPanel.webview.onDidReceiveMessage(onDrill);
  overviewPanel.webview.html = overviewHtml();
}

class OverviewView {
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage(onDrill);
    view.onDidChangeVisibility(() => { if (view.visible) { this.render(); this.autoOpen(); } });
    this.render();
    this.autoOpen();
  }
  // Selecting the AI Cost icon shows this view, and with it the overview in a tab (unless that is switched off).
  autoOpen() { if (vscode.workspace.getConfiguration('aiCost').get('openOverviewOnSelect', true)) showOverview(false); }
  render() { if (this.view) this.view.webview.html = overviewHtml(true); }
}
const overviewView = new OverviewView();

function adviceHtml(i) {
  const f = advice.findings[i];
  if (!f) return null;
  return `<!doctype html><meta charset="utf-8"><style>body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);padding:16px;max-width:760px}h2{font-weight:500}.s{color:var(--vscode-descriptionForeground)}</style>
<h2>${esc(f.title)}</h2>${f.saving ? `<p>Estimated saving: <b>up to ${money(f.saving)}</b> over the ${sessions.length} loaded sessions.</p>` : ''}
<p>${esc(f.detail)}</p><h3>What to do</h3><p>${esc(f.action)}</p>
<p class="s">${f.habit ? 'This is a token-saving tool that was there to use and was not. What it cost is in the measured findings above it, so it claims no saving of its own.' : 'Pick a prompt under this finding in the tree to see its tokens, calls and content. Findings overlap, so the savings do not add up.'}</p>`;
}
function showAdvice(i) {
  const html = adviceHtml(i);
  if (html) openHtml('AI Cost: advice', html);
}

let panel;
const tiles = (items) => `<div class="tiles">${items.map(([k, v]) => `<div class="tile"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>`;

function crumbsHtml(n, { s, p, c, canBack }) {
  const d = (o) => ` data-drill="${esc(JSON.stringify(o))}" tabindex="0" role="button"`;
  const parts = [`<a class="cr"${d({ kind: 'overview' })}>Overview</a>`];
  if (s) parts.push(n.kind === 'session' ? `<span>${esc(clip(s.title, 40))}</span>` : `<a class="cr"${d({ kind: 'session', sid: s.id })}>${esc(clip(s.title, 40))}</a>`);
  if (p) parts.push(n.kind === 'prompt' ? `<span>Prompt ${p.n}</span>` : `<a class="cr"${d({ kind: 'prompt', sid: s.id, n: p.n })}>Prompt ${p.n}</a>`);
  if (c) parts.push(n.kind === 'tool' ? `<a class="cr"${d({ kind: 'call', sid: s.id, pn: p.n, cn: c.n })}>Call ${c.n}</a>` : `<span>Call ${c.n}</span>`);
  else if (n.kind === 'call') parts.push(`<span>Call ${n.n}</span>`);
  if (n.kind === 'tool') parts.push(`<span>${esc(clip(n.name, 30))}</span>`);
  return `<nav class="crumbs">${canBack ? `<button class="link"${d({ kind: 'back' })}>‹ Back</button><i class="sep">|</i>` : ''}${parts.join('<i class="sep">›</i>')}</nav>`;
}

function detailHtml(n, content, ctx) {
  const row = (k, v) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`;
  let title; let rows = []; let extra = '';
  if (n.kind === 'session') {
    title = n.title;
    rows = [['Session', n.id], ['Source', SOURCE_LABEL[n.source]], ['Folder', n.cwd || ''], ['Branch', n.branch || '']];
    const max = Math.max(...n.prompts.map((p) => p.usd || 0), 0.0001);
    const chrono = [...n.prompts].sort((x, y) => (x.ts < y.ts ? -1 : 1));
    extra = `${tiles([['Cost', money(n.usd)], ['Prompts', n.prompts.length], ['Model calls', n.split.calls], ['Cache hit', n.split.cacheHit == null ? '—' : `${Math.round(n.split.cacheHit * 100)}%`]])}`
      + `<h3>Cost per prompt</h3>${CH.columns(chrono.map((p) => ({ label: String(p.n), tip: `${p.n}. ${clip(p.text, 60)}\n${money(p.usd)} · ${tk(p.split)}\nClick to open`, drill: { kind: 'prompt', sid: n.id, n: p.n }, parts: [{ value: p.usd || 0, slot: 1 }] })))}`
      + (n.split.known ? `<h3>Where the tokens went</h3>${CH.composition(CH.tokenSegments(n.split))}` : '')
      + `<h3>Models</h3>${modelTable(n.models)}<h3>Prompts</h3>${usageTable(n.prompts.map((p) => ({ label: `${p.n}. ${clip(p.text, 70)}`, usd: p.usd, sp: p.split, drill: { kind: 'prompt', sid: n.id, n: p.n } })), max)}`;
  } else if (n.kind === 'prompt') {
    title = clip(n.text, 80);
    rows = [['Models', n.models.join(', ')], ['Took', `${n.seconds}s`]];
    const ptools = (content && content.tools) || n.toolCalls;
    extra += tiles([['Cost', (n.usdEstimated ? '~' : '') + money(n.usd)], ['Model calls', n.calls.length || n.split.calls || '—'], ['Cache hit', n.split.cacheHit == null ? '—' : `${Math.round(n.split.cacheHit * 100)}%`], ['Tool calls', ptools.length || n.toolCount || '—']]);
    if (n.split.known) extra += `<h3>Where the tokens went</h3>${CH.composition(CH.tokenSegments(n.split))}`;
    if (n.calls.length > 1) extra += `<h3>Cost per model call</h3>${CH.columns(n.calls.map((c) => ({ label: String(c.n), tip: `${c.n}. ${c.model}${c.who === 'main' ? '' : ` (${c.who})`}\n${money(c.usd)} · ${tokens(c.tokensIn)} in / ${tokens(c.tokensOut)} out\nClick to open`, drill: { kind: 'call', sid: n.sid, pn: n.n, cn: c.n }, parts: [{ value: c.usd || 0, slot: 1 }] })))}`;
    if (n.note) extra += `<p class="tip">${esc(n.note)}</p>`;
    if (n.cacheBreak) extra += `<p class="tip">Cache break: ${esc(JSON.stringify(n.cacheBreak))}</p>`;
    const max = Math.max(...n.calls.map((c) => c.usd || 0), 0.0001);
    if (n.calls.length) extra += `<h3>Model calls</h3>${usageTable(n.calls.map((c) => ({ label: `${c.n}. ${c.model}${c.who === 'main' ? '' : ` (${c.who})`}`, usd: c.usd, tools: c.toolCalls || [], drill: { kind: 'call', sid: n.sid, pn: n.n, cn: c.n }, sp: { known: true, in: c.tokensIn, out: c.tokensOut, cacheHit: c.tokensIn ? c.cacheRead / c.tokensIn : null } })), max)}`;
    if (ptools.length) extra += `<h3>Tool calls (${ptools.length})</h3>${toolTable(ptools.slice(0, 200), { sid: n.sid, pn: n.n })}${ptools.length > 200 ? '<p class="note">First 200 shown.</p>' : ''}`;
    else if (n.toolCount) extra += `<h3>Tool calls (${n.toolCount})</h3><p class="note">The tool list could not be read for this prompt.</p>`;
  } else if (n.kind === 'tool') {
    title = n.name;
    rows = [['What', n.detail || '—']];
    if (n.where && n.where !== 'main') rows.push(['Run by', n.where]);
    extra = tiles([['Status', n.error ? '✕ Error' : '✓ Done'], ['Result size', n.tokens == null ? '—' : `${tokens(n.tokens)} tok`], ['Took', n.seconds == null ? '—' : `${n.seconds}s`]]);
    extra += content === undefined ? '' : content === null ? '<p class="note">The transcript has no record of this tool call.</p>'
      : `<h3>Input</h3><pre>${esc(content.input == null ? '(none recorded)' : content.input)}</pre><h3>${content.error ? 'Error' : 'Result'}</h3><pre>${esc(content.result == null ? '(none recorded)' : content.result)}</pre>`;
  } else {
    title = `Call ${n.n}: ${n.model}`;
    let extra2 = content === undefined ? '' : content === null ? '<p>This call was not found in the transcript.</p>' : callContentHtml(content);
    extra = extra2;
    rows = [['Made by', n.who], ['Time', when(n.ts)], ['Tools called', n.tools]];
    const tools = (content && content.tools && content.tools.length ? content.tools : n.toolCalls) || [];
    const sp = { in: n.tokensIn, fresh: n.fresh, cacheRead: n.cacheRead, cacheWrite: n.cacheWrite, out: n.tokensOut, known: true };
    extra = tiles([['Cost', money(n.usd)], ['Tokens in', tokens(n.tokensIn)], ['Tokens out', tokens(n.tokensOut)], ['Cache hit', n.tokensIn ? `${Math.round((n.cacheRead / n.tokensIn) * 100)}%` : '—']])
      + `<h3>Where the tokens went</h3>${CH.composition(CH.tokenSegments(sp))}`
      + (tools.length ? `<h3>Tool calls (${tools.length})</h3>${toolTable(tools, ctx && ctx.p ? { sid: ctx.s.id, pn: ctx.p.n, cn: n.n } : null)}` : n.tools ? `<p class="note">${n.tools} tool call${n.tools > 1 ? 's' : ''}: no detail recorded.</p>` : '<h3>Tool calls</h3><p class="note">This call made no tool calls.</p>') + extra;
  }
  return `<!doctype html><meta charset="utf-8"><style>
body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);padding:16px}h2{font-weight:500}h3{margin:18px 0 6px;font-weight:500}
table{border-collapse:collapse}td{padding:3px 16px 3px 0}td:first-child{color:var(--vscode-descriptionForeground)}
.b{display:flex;align-items:center;gap:8px;margin:3px 0}.b span:first-child{width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.b i{display:block;height:6px;background:var(--vscode-progressBar-background);border-radius:3px}.b span:last-child{width:70px;text-align:right}
.k{margin:10px 0 2px;color:var(--vscode-descriptionForeground)}.note{color:var(--vscode-descriptionForeground)}pre{white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto;padding:8px;background:var(--vscode-textCodeBlock-background);border-radius:4px;margin:0}
.u{width:100%}.u td{padding:3px 12px 3px 0;white-space:nowrap}.u td:not(.l):not(.g){text-align:right}.u td.l+td.l{max-width:300px}.u .l{max-width:360px;overflow:hidden;text-overflow:ellipsis}.u .h td{color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-panel-border)}.u .g{width:100%}.u .g i{display:block;height:6px;background:var(--vscode-progressBar-background);border-radius:3px;min-width:1px}
.tip{padding:8px;border:1px solid var(--vscode-editorWarning-foreground);border-radius:4px}
.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:8px;color:var(--vscode-descriptionForeground)}.crumbs .link{margin:0}.cr{color:var(--vscode-textLink-foreground)}.cr:hover{text-decoration:underline}.sep{font-style:normal;opacity:.6}
${CH.CSS}</style>
${ctx ? crumbsHtml(n, ctx) : ''}<h2>${esc(title)}</h2><table>${rows.map(([k, v]) => row(k, v)).join('')}</table>${extra}<script>${SORT_SCRIPT}</script><script>${CH.TIP_SCRIPT}</script><script>${CH.DRILL_SCRIPT}</script>`;
}
/** "Bash ×2, Read" for a list of tool calls. */
function toolSummary(tools) {
  const by = new Map();
  for (const t of tools || []) by.set(t.name, (by.get(t.name) || 0) + 1);
  return [...by].map(([k, v]) => (v > 1 ? `${k} ×${v}` : k)).join(', ');
}
function toolTable(tools, base) {
  const rows = tools.map((t) => {
    const d = base && t.id ? ` data-drill="${esc(JSON.stringify({ kind: 'tool', sid: base.sid, pn: base.pn, cn: base.cn, tid: t.id }))}"` : '';
    const who = t.where && t.where !== 'main' ? ` <span class="note">(${esc(t.where)})</span>` : '';
    return `<tr${d}><td class="l">${esc(t.name)}${who}</td><td class="l" title="${esc(t.detail || '')}">${esc(clip(t.detail || '', 90))}</td><td>${t.tokens == null ? '—' : `${tokens(t.tokens)} tok`}</td><td>${t.seconds == null ? '—' : `${t.seconds}s`}</td><td>${t.error ? '✕ error' : ''}</td></tr>`;
  }).join('');
  return `<table class="u tools"><tr class="h"><td class="l">Tool</td><td class="l">What</td><td>Result</td><td>Took</td><td></td></tr>${rows}</table>${base ? '<p class="note">Click a tool to see its input and result.</p>' : ''}`;
}
const num = (x) => `${(x || 0).toLocaleString()} (${tokens(x || 0)})`;
function splitRows(t) {
  if (t.known === false) return [['Tokens', 'No token data']];
  return [['Tokens in (total)', num(t.in)], ['  new input', num(t.fresh)], ['  read from cache', num(t.cacheRead)], ['  written to cache', num(t.cacheWrite)],
    ['Cache hit', t.cacheHit == null ? '—' : `${Math.round(t.cacheHit * 100)}%`], ['Tokens out', num(t.out)]];
}
function modelTable(ms) {
  return `<table>${ms.map((m) => `<tr><td>${esc(m.model)}</td><td>${m.calls} calls</td><td>${tokens(m.in)} in / ${tokens(m.out)} out</td><td>${m.priced ? money(m.usd) : '—'}</td></tr>`).join('')}</table>`;
}
const KIND = { text: 'Text', result: 'Tool result', thinking: 'Thinking', tool: 'Tool call' };
function block(b) { return `<div class="k">${esc(KIND[b.type] || b.type)}${b.name ? `: ${esc(b.name)}` : ''}${b.error ? ' (error)' : ''}</div><pre>${esc(b.text)}</pre>`; }
function callContentHtml(c) {
  return `${c.partial ? '<p class="note">Copilot\'s event log keeps tool requests and a short preview of each reply, not the full text.</p>' : ''}<h3>Went in</h3><p class="note">New since the previous call. The rest of its input was the earlier conversation, mostly served from cache.</p>${c.input.map(block).join('') || '<p>Nothing new.</p>'}`
    + `<h3>Came out</h3>${c.output.map(block).join('') || '<p>No content.</p>'}`;
}
// Click a column header to sort a usage table; click again to reverse. Cells with no value always go last.
const SORT_SCRIPT = `
document.querySelectorAll('table.u:not(.tools):not(.nosort)').forEach(function (t) {
  var heads = t.querySelectorAll('tr.h td'), state = { col: -1, dir: 1 };
  heads.forEach(function (th, c) {
    if (c === heads.length - 1) return;
    th.style.cursor = 'pointer'; th.title = 'Sort by ' + th.textContent;
    th.addEventListener('click', function () {
      state.dir = state.col === c ? -state.dir : (c === 0 || c === 3 ? 1 : -1); state.col = c;
      var rows = Array.prototype.slice.call(t.querySelectorAll('tr:not(.h)')), body = rows[0].parentNode;
      rows.sort(function (a, b) {
        var x = a.cells[c].getAttribute('data-v'), y = b.cells[c].getAttribute('data-v');
        if (x === '' || y === '') return x === y ? 0 : x === '' ? 1 : -1;
        return (Number(x) - Number(y)) * state.dir;
      }).forEach(function (r) { body.appendChild(r); });
      heads.forEach(function (h) { h.textContent = h.textContent.replace(/ [↑↓]$/, ''); });
      th.textContent += state.dir > 0 ? ' ↑' : ' ↓';
    });
  });
});`;
function usageTable(items, max) {
  const withTools = items.some((x) => x.tools && x.tools.length);
  const head = `<tr class="h"><td class="l">Name</td><td>Tokens in</td><td>Tokens out</td><td>Cache hit</td>${withTools ? '<td class="l">Tools</td>' : ''}<td>Cost</td><td></td></tr>`;
  const v = (x) => (x == null ? '' : x);
  const rows = items.map((x, i) => `<tr${x.drill ? ` data-drill="${esc(JSON.stringify(x.drill))}"` : ''}><td class="l" data-v="${i}" title="${esc(x.label)}">${esc(x.label)}</td><td data-v="${v(x.sp.known ? x.sp.in : null)}">${x.sp.known ? tokens(x.sp.in) : '—'}</td><td data-v="${v(x.sp.known ? x.sp.out : null)}">${x.sp.known ? tokens(x.sp.out) : '—'}</td>`
    + `<td data-v="${v(x.sp.cacheHit)}">${x.sp.cacheHit == null ? '—' : `${Math.round(x.sp.cacheHit * 100)}%`}</td>`
    + (withTools ? `<td class="l" data-v="${(x.tools || []).length}" title="${esc((x.tools || []).map((t) => `${t.name} ${t.detail || ''}`).join('\n'))}">${esc(toolSummary(x.tools))}</td>` : '')
    + `<td data-v="${v(x.usd)}">${money(x.usd)}</td><td class="g" data-v="${v(x.usd)}"><i style="width:${Math.round(((x.usd || 0) / max) * 100)}%"></i></td></tr>`).join('');
  return `<table class="u">${head}${rows}</table>`;
}
function bar(label, usd, max) {
  return `<div class="b"><span>${esc(label)}</span><div style="flex:1"><i style="width:${Math.round(((usd || 0) / max) * 100)}%"></i></div><span>${money(usd)}</span></div>`;
}
function resolve(path) {
  const [si, pi, ci] = path || [];
  const s = sessions[si];
  const p = s && s.prompts[pi];
  return ci != null ? p && p.calls[ci] : pi != null ? p : s;
}
function find(list, sid, pn, cn) {
  const ss = list.find((x) => x.id === sid);
  const p = ss && pn != null ? ss.prompts.find((x) => x.n === pn) : null;
  const c = p && cn != null ? p.calls.find((x) => x.n === cn) : null;
  return { s: ss, p, c };
}
// Where the detail panel has been, newest last, for the Back button.
let trail = [];
const refOf = (s, p, c, tool) => ({ sid: s.id, pn: p ? p.n : undefined, cn: c ? c.n : undefined, tid: tool ? tool.id : undefined });
/** An item by ids: in the filtered view if it is there, else among everything loaded. */
const lookup = (sid, pn, cn) => { const hit = find(sessions, sid, pn, cn); return hit.s ? hit : find(allSessions, sid, pn, cn); };

/** A prompt's tool calls. Copilot prompts carry only a count until asked: read the list once and keep it. */
async function toolsFor(s, p) {
  if (!p.toolCalls || (!p.toolCalls.length && p.toolCount)) p.toolCalls = await promptTools(s, p);
  return p.toolCalls;
}
async function showNode(s, p, c, { back = false, tool = null } = {}) {
  if (!back) {
    const r = refOf(s, p, c, tool); const last = trail[trail.length - 1];
    if (!last || JSON.stringify(last) !== JSON.stringify(r)) { trail.push(r); if (trail.length > 50) trail.shift(); }
  }
  const ctx = { s, p, c, canBack: trail.length > 1 };
  try {
    if (tool) openPanel({ kind: 'tool', ...tool }, await toolContent(s, p, tool), ctx);
    else if (c) openPanel(c, await callContent(s, p, c), ctx);
    else if (p) openPanel(p, { tools: await toolsFor(s, p) }, ctx);
    else openPanel(s, undefined, ctx);
  } catch (err) { vscode.window.showErrorMessage(`AI Cost: ${err.stack || err}`); }
}
async function openTool(sid, pn, cn, tid) {
  const { s, p, c } = lookup(sid, pn, cn);
  if (!s || !p) { vscode.window.showWarningMessage('AI Cost: that item is no longer loaded. Refresh the view.'); return; }
  const tool = (await toolsFor(s, p)).find((t) => t.id === tid) || (c && (c.toolCalls || []).find((t) => t.id === tid));
  if (!tool) { vscode.window.showWarningMessage('AI Cost: that tool call could not be found.'); return; }
  await showNode(s, p, c, { tool });
}
function goBack() {
  if (trail.length < 2) return;
  trail.pop();
  const r = trail[trail.length - 1];
  if (r.tid) { trail.pop(); openTool(r.sid, r.pn, r.cn, r.tid); return; }
  const { s, p, c } = lookup(r.sid, r.pn, r.cn);
  if (s) showNode(s, p, c, { back: true });
}
/** A click on a chart: narrow the filter (each click adds to it) or open the item. */
function onDrill(m) {
  if (!m || typeof m !== 'object') return;
  const narrow = (patch) => { filter = { ...filter, ...patch }; recompute(); vscode.commands.executeCommand('aiCost.tree.focus'); };
  switch (m.kind) {
    case 'full': showOverview(true); break;
    case 'clear': filter = { ...F.EMPTY }; recompute(); break;
    case 'source': narrow({ sources: [m.value] }); break;
    case 'model': narrow({ models: [m.value] }); break;
    case 'day': narrow({ day: m.value, ...(m.source ? { sources: [m.source] } : {}) }); break;
    case 'back': goBack(); break;
    case 'range': overviewDays = Number(m.value) || 0; overviewMonth = null; renderOverviews(); break;
    case 'month': overviewMonth = m.value || null; renderOverviews(); break;
    case 'filterMonth': narrow({ day: `${m.value}-01..${m.value}-31` }); break;
    case 'tool': openTool(m.sid, m.pn, m.cn, m.tid); break;
    case 'sync': vscode.commands.executeCommand('aiCost.refresh'); break;
    case 'harness': {
      // Toggle one tool. With nothing chosen every tool counts, so the first click leaves that one out.
      const present = F.sourcesIn(allSessions);
      if (!present.includes(m.value)) break;
      const now = filter.sources.length ? filter.sources : present;
      const next = now.includes(m.value) ? now.filter((k) => k !== m.value) : [...now, m.value];
      filter = { ...filter, sources: next.length === 0 || next.length === present.length ? [] : next }; // none left, or all back: no filter
      recompute();
      break;
    }
    case 'overview': showOverview(true); break;
    case 'session': case 'prompt': case 'call': {
      const { s, p, c } = lookup(m.sid, m.kind === 'session' ? undefined : m.n != null ? m.n : m.pn, m.cn);
      if (s && (m.kind === 'session' || p)) showNode(s, p, c);
      else vscode.window.showWarningMessage('AI Cost: that item is no longer loaded. Refresh the view.');
      break;
    }
    default: break;
  }
}

async function showDetail(path) {
  const n = resolve(path);
  if (!n) { vscode.window.showWarningMessage('AI Cost: that row is out of date. Refresh the view.'); return; }
  const [si, pi, ci] = path;
  const ss = sessions[si]; const p = pi != null ? ss.prompts[pi] : undefined; const c = ci != null ? p.calls[ci] : undefined;
  await showNode(ss, p, c);
}
function openHtml(title, html) {
  if (!panel) { panel = vscode.window.createWebviewPanel('aiCostDetail', 'AI Cost', { viewColumn: (overviewPanel && overviewPanel.viewColumn) || vscode.ViewColumn.Active, preserveFocus: true }, { enableScripts: true }); panel.onDidDispose(() => { panel = undefined; trail = []; }); panel.webview.onDidReceiveMessage(onDrill); }
  else panel.reveal(undefined, true); // already open, maybe behind another tab of its group: bring it forward, and leave the focus in the tree
  panel.title = title;
  panel.webview.html = html;
}
function openPanel(n, content, ctx) { openHtml(`AI Cost: ${n.kind}`, detailHtml(n, content, ctx)); }

function renderOverviews() {
  overviewView.render();
  if (overviewPanel) overviewPanel.webview.html = overviewHtml();
}

let statusBar = null;

/**
 * The status bar: today's cost and the Copilot quota. It follows the tool selection (the Sessions filter's Source setting,
 * set from the chart legend or the filter), so leaving a tool out leaves its cost and its quota out. Other filters (a day,
 * a model, text) do not apply: it is always about today.
 */
/**
 * The model guard, once per refresh: works out whether premium requests are on pace to run out, keeps the state where the
 * hook can read it, and says so once per time it turns on. It only advises: no model is hidden or switched.
 */
function guardTick(now = Date.now()) {
  const sw = CS.read().find((s) => s.key === 'guard');
  if (!sw || !sw.on) { guard = null; return null; }
  try {
    const q = Quota.read();
    const today = premiumToday(allSessions);
    const bud = q ? Quota.budget(q, now, { fixed: CS.dailyPremium(), todayUsed: today || 0 }) : null;
    const todayOver = Boolean(bud && bud.todayCounts && today != null && today >= bud.perDay);
    const prev = Guard.load();
    const next = Guard.plan(q, allSessions, { prev, now, todayOver, threshold: CS.readLimits().find((l) => l.key === 'modelGuardRequests').value || Guard.DEFAULT_THRESHOLD });
    const turnedOn = next.active && !(prev && prev.active && prev.period === next.period);
    // Written only when there is something to keep: while it is on, or on the refresh that turns it off. The saved state is
    // what the next refresh compares with, so it says "on" from now: a window that refreshes next does not announce it again.
    if (next.active || (prev && prev.active)) Guard.save(next);
    guard = next.active ? next : null;
    if (turnedOn) {
      vscode.window.showWarningMessage(`${Guard.describe(next)} Use a cheaper model for routine work until the pace is back.`, 'Open model picker', 'Not now')
        .then((pick) => { if (pick === 'Open model picker') vscode.commands.executeCommand('workbench.action.chat.openModelPicker'); }, () => {});
    }
  } catch { guard = null; }
  return guard;
}

function updateStatusBar() {
  if (!statusBar || !lastSynced) return;
  guardTick();
  const picked = filter.sources.length ? filter.sources : null;
  const mine = picked ? allSessions.filter((x) => picked.includes(x.source)) : allSessions;
  const present = F.sourcesIn(allSessions);
  const names = picked ? picked.map((k) => SOURCE_LABEL[k]) : [];
  const scope = !picked || picked.length >= present.length ? '' : names.length === 1 ? names[0] : `${names.length} of ${present.length} tools`;
  const qs = !picked || picked.includes('copilot') ? Quota.summary(Quota.read(), Date.now(), { today: premiumToday(mine), fixed: CS.dailyPremium() }) : null;
  statusBar.text = `$(credit-card) AI today ${money(dayTotal(mine))}${scope ? ` · ${scope}` : ''}${qs ? ` · ${qs.text}` : ''}`;
  statusBar.backgroundColor = (qs && qs.over) || guard ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  const top = advice && advice.findings.find((f) => f.saving);
  statusBar.tooltip = `${allSessions.length} recent sessions loaded, synced ${lastSynced.toLocaleTimeString()}. Click for the overview.`
    + `${scope ? `\nCost for ${names.join(', ')} only. Change it with the legend in the overview, or Filter → Source.` : ''}`
    + `${guard ? `\nModel guard: ${Guard.describe(guard)}` : ''}${qs ? `\n${qs.tip}` : ''}${errors.length ? `\nCould not read: ${errors.join('; ')}` : ''}${top ? `\nTop advice: ${top.title} (up to ${money(top.saving)})` : ''}`;
}

function recompute() {
  sessions = SORT.applySort(F.applyFilter(allSessions, filter), sort);
  advice = adviseAll(sessions);
  const on = F.isActive(filter);
  const shown = [F.isActive(filter) ? F.describe(filter) : '', SORT.describe(sort)].filter(Boolean).join(' · ');
  for (const v of views) {
    v.description = shown || undefined;
    const prompts = sessions.reduce((n, x) => n + x.prompts.length, 0);
    v.message = !on ? undefined : !sessions.length ? `Nothing matches the filter (${F.describe(filter)}). Click the clear-filter icon in the title bar.`
      : `Filtered: ${F.describe(filter)}. Showing ${sessions.length} sessions and ${prompts} prompts. Click the clear-filter icon in the title bar to see everything.`;
  }
  vscode.commands.executeCommand('setContext', 'aiCost.filtered', on);
  updateStatusBar();
  renderOverviews();
  changed.fire();
}

async function editSort() {
  const items = Object.entries(SORT.KEYS).map(([key, k]) => ({
    label: key === sort.key ? `$(check) ${k.label}` : `      ${k.label}`, key,
    description: key === sort.key ? (sort.dir === 'asc' ? 'ascending: choose again to reverse' : 'descending: choose again to reverse') : '',
  }));
  const pick = await vscode.window.showQuickPick(items, { title: 'AI Cost: sort', placeHolder: 'Sort sessions, and the prompts and calls inside them' });
  if (!pick) return;
  sort = SORT.choose(sort, pick.key);
  recompute();
}

async function editFilter() {
  for (;;) {
    const f = filter;
    const items = [
      { label: '$(calendar) Period', description: F.PERIOD_LABEL[f.period], key: 'period' },
      { label: '$(server) Source', description: f.sources.map((k) => SOURCE_LABEL[k]).join(', ') || 'Any', key: 'sources' },
      { label: '$(calendar) Day or date range', description: f.day ? F.describe({ ...F.EMPTY, day: f.day }) : 'Any', detail: 'One day (YYYY-MM-DD) or a range (YYYY-MM-DD..YYYY-MM-DD)', key: 'day' },
      { label: '$(symbol-misc) Models', description: f.models.join(', ') || 'Any', key: 'models' },
      { label: '$(credit-card) Minimum prompt cost', description: f.minUsd ? `$${f.minUsd}` : 'None', key: 'minUsd' },
      { label: '$(search) Text', description: f.text || 'None', detail: 'Matches the prompt, session title or ID, folder or branch', key: 'text' },
      { label: '$(clear-all) Clear filter', key: 'clear' },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: 'AI Cost: filter', placeHolder: 'Choose what to filter on. Esc to finish.' });
    if (!pick) return;
    if (pick.key === 'clear') filter = { ...F.EMPTY };
    else if (pick.key === 'period') {
      const p = await vscode.window.showQuickPick(Object.entries(F.PERIOD_LABEL).map(([k, label]) => ({ label, k, picked: k === f.period })), { title: 'Period' });
      if (p) filter = { ...f, period: p.k };
    } else if (pick.key === 'day') {
      const ok = /^\d{4}-\d{2}-\d{2}(\.\.\d{4}-\d{2}-\d{2})?$/;
      const v = await vscode.window.showInputBox({ title: 'Day or date range', value: f.day, prompt: 'For example 2026-09-01 or 2026-09-01..2026-09-07. Leave empty to clear.', validateInput: (x) => (x === '' || ok.test(x) ? null : 'Use YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD') });
      if (v != null) filter = { ...f, day: v };
    } else if (pick.key === 'sources') {
      const p = await vscode.window.showQuickPick(F.sourcesIn(allSessions).map((k) => ({ label: SOURCE_LABEL[k], k, picked: f.sources.includes(k) })), { title: 'Sources (none selected means any)', canPickMany: true });
      if (p) filter = { ...f, sources: p.map((x) => x.k) };
    } else if (pick.key === 'models') {
      const ms = F.modelsIn(allSessions);
      const p = await vscode.window.showQuickPick(ms.map((m) => ({ label: m, picked: f.models.includes(m) })), { title: 'Models (none selected means any)', canPickMany: true });
      if (p) filter = { ...f, models: p.map((x) => x.label) };
    } else if (pick.key === 'minUsd') {
      const v = await vscode.window.showInputBox({ title: 'Minimum prompt cost in dollars', value: f.minUsd ? String(f.minUsd) : '', validateInput: (x) => (x === '' || (Number.isFinite(Number(x)) && Number(x) >= 0) ? null : 'Enter a number, or leave empty') });
      if (v != null) filter = { ...f, minUsd: v === '' ? 0 : Number(v) };
    } else if (pick.key === 'text') {
      const v = await vscode.window.showInputBox({ title: 'Text to find', value: f.text, prompt: 'Every word must match' });
      if (v != null) filter = { ...f, text: v };
    }
    recompute();
  }
}

/** Once, if Copilot is on this machine and tracking is off: offer to set it up. */
function offerSetup(ctx) {
  const st = Setup.status();
  if (!st.copilotFound || st.enabled || ctx.globalState.get('aiCost.setupOffered')) return;
  setTimeout(async () => {
    const pick = await vscode.window.showInformationMessage('AI Cost can also track your Copilot sessions in more detail: per-call tokens and cost tips.', 'Set up Copilot tracking', 'Not now', "Don't ask again");
    if (pick === 'Set up Copilot tracking') await enableTracking();
    if (pick) ctx.globalState.update('aiCost.setupOffered', true);
  }, 4000);
}

let extensionId = 'techselva.ai-cost-coach'; // the walkthrough is opened by the extension's own id

function activate(ctx) {
  if (ctx.extension && ctx.extension.id) extensionId = ctx.extension.id;
  extensionUri = ctx.extensionUri;
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  bar.command = 'aiCost.overview'; bar.text = '$(credit-card) AI …'; bar.show();
  statusBar = bar;
  const cfg = () => vscode.workspace.getConfiguration('aiCost');
  async function sync() {
    const before = { sessions: allSessions.length, prompts: allSessions.reduce((a, x) => a + x.prompts.length, 0) };
    try {
      const r = await loadAll({ maxSessions: cfg().get('maxSessions', 500), copilotDays: cfg().get('copilotDays', 90), enabled: cfg().get('sources', ['claude', 'copilot']) });
      allSessions = r.sessions; errors = r.errors;
      for (const ss of allSessions) for (const p of ss.prompts) p.sid = ss.id;
      lastSynced = new Date();
      recompute();
      changed.fire();
      const after = { sessions: allSessions.length, prompts: allSessions.reduce((a, x) => a + x.prompts.length, 0) };
      return { before, after };
    } catch (err) {
      bar.text = '$(warning) AI cost'; bar.tooltip = String(err.message || err);
      throw err;
    }
  }
  /** Reads the session logs again. `manual` shows progress in the view and says what changed. */
  async function refresh(manual) {
    if (loading) { if (manual === true) vscode.window.setStatusBarMessage('AI Cost: already syncing…', 2500); return; }
    loading = true; syncing = true;
    const was = bar.text; bar.text = '$(sync~spin) AI syncing…'; renderOverviews();
    try {
      const r = manual === true
        ? await vscode.window.withProgress({ location: { viewId: 'aiCost.tree' }, title: 'Syncing sessions' }, sync)
        : await sync();
      if (manual === true) {
        const ds = r.after.sessions - r.before.sessions; const dp = r.after.prompts - r.before.prompts;
        const d = (n) => (n > 0 ? ` (+${n})` : n < 0 ? ` (${n})` : '');
        vscode.window.setStatusBarMessage(`AI Cost: synced ${r.after.sessions} sessions${d(ds)}, ${r.after.prompts} prompts${d(dp)}`, 5000);
      }
    } catch (err) {
      if (manual === true) vscode.window.showErrorMessage(`AI Cost: sync failed: ${err.message || err}`);
    } finally { loading = false; syncing = false; if (bar.text.includes('syncing')) bar.text = was; renderOverviews(); }
  }
  ctx.subscriptions.push(
    bar, changed,
    ...(views = [vscode.window.createTreeView('aiCost.tree', { treeDataProvider: new Tree() }), vscode.window.createTreeView('aiCost.advice', { treeDataProvider: new AdviceTree() })]),
    ...(() => {
      const view = vscode.window.createTreeView('aiCost.coach', { treeDataProvider: new CoachTree() });
      view.onDidChangeCheckboxState((e) => {
        for (const [sw, st] of e.items) {
          if (sw.kind === 'tracking') (st === vscode.TreeItemCheckboxState.Checked ? enableTracking : disableTracking)().then(() => coachChanged.fire());
          else toggleCoach(sw.key, st === vscode.TreeItemCheckboxState.Checked);
        }
      });
      return [view, coachChanged];
    })(),
    vscode.commands.registerCommand('aiCost.toggleCoach', (key) => toggleCoach(key)),
    vscode.commands.registerCommand('aiCost.coachResults', showCoachResults),
    vscode.commands.registerCommand('aiCost.editLimit', editLimit),
    vscode.commands.registerCommand('aiCost.pauseStrict', pauseStrict),
    vscode.commands.registerCommand('aiCost.enableCopilotTracking', enableTracking),
    vscode.commands.registerCommand('aiCost.disableCopilotTracking', disableTracking),
    vscode.commands.registerCommand('aiCost.checkCopilotTracking', checkTracking),
    vscode.window.registerWebviewViewProvider('aiCost.overview', overviewView),
    vscode.commands.registerCommand('aiCost.overview', () => showOverview(true)),
    vscode.commands.registerCommand('aiCost.showTour', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${extensionId}#aiCost.tour`, false)),
    vscode.commands.registerCommand('aiCost.sort', editSort),
    vscode.commands.registerCommand('aiCost.filter', editFilter),
    vscode.commands.registerCommand('aiCost.clearFilter', () => { filter = { ...F.EMPTY }; recompute(); }),
    vscode.commands.registerCommand('aiCost.showAdvice', showAdvice),
    vscode.commands.registerCommand('aiCost.refresh', () => refresh(true)),
    vscode.commands.registerCommand('aiCost.showDetail', showDetail),
  );
  try { Setup.refresh(); } catch { /* the old copy keeps working */ }
  // A hook that cannot run lets every prompt through unchecked, and nothing says so: look once, a few seconds after start.
  setTimeout(() => { try { if (Setup.status().enabled && !Setup.check().ok) checkTracking(); } catch { /* not worth a message */ } }, 4000);
  startHeldNotifier(ctx);
  offerSetup(ctx);
  refresh();
  const timer = setInterval(() => refresh(), Math.max(10, cfg().get('refreshSeconds', 60)) * 1000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
}
function deactivate() {}
/** What the screenshot script needs: the panels' HTML, and a way to hand them sessions without reading any logs. */
const _test = {
  overviewHtml, detailHtml, adviceHtml, quotaHtml, onDrill, coachResultsHtml, CoachTree, handleHeld, heldPage, startHeldNotifier,
  get filter() { return filter; },
  get days() { return overviewDays; },
  load(all, { days = 0, month = null, synced = true } = {}) {
    if (synced) lastSynced = new Date();
    allSessions = all; sessions = all; overviewDays = days; overviewMonth = month; advice = adviseAll(all);
    for (const ss of all) for (const p of ss.prompts) p.sid = ss.id;
  },
  get advice() { return advice; },
  attachBar(bar) { statusBar = bar; },
  guardTick,
  get guard() { return guard; },
  updateStatusBar,
};

module.exports = { activate, deactivate, _test };
