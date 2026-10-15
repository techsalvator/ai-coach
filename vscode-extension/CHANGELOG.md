# Changelog

All notable changes to the AI Cost Coach extension (called AI Cost Drilldown up to 0.2.2). Versions follow semver.

## 0.3.2 (2026-10-15)

### Added

- **Each Sustainability figure now says how it was worked out.** Under the CO₂e, electricity and water tiles (overview,
  session, prompt and model-call screens) a bar shows the sum with the actual numbers: the output, fresh input, cache
  read and cache write tokens behind it, the energy factor for the model size, the data-centre overhead (PUE), then the
  grid (g CO₂e per kWh) and water (L per kWh) factors, down to the figure on the tile.

## 0.3.1 (2026-10-15)

### Changed

- **ai-cost-drilldown is now ai-cost-coach everywhere:** the Copilot CLI plugin (so the skill is `/ai-cost-coach:cost`),
  the package, the hook file (`~/.copilot/hooks/ai-cost-coach.json`), the data folder (`~/.ai-cost-coach/`), the labels
  the coach puts on its notices, the docs and the repository links (now `techsalvator/ai-coach`). Nothing is lost on
  upgrade: an existing `~/.ai-cost-drilldown/` folder keeps being used, the earlier-named hook file is moved to the new
  name (never left beside it, which would answer every prompt twice), `/ai-cost-drilldown:cost` is still understood, and
  an old plugin installed under either name is still found and can be removed. This list's earlier entries keep the old
  names, as they were then.

## 0.3.0 (2026-10-15)

### Added

- **A Sustainability section with estimated CO₂e, electricity and water.** It shows under the main tiles on the overview,
  session, prompt and model-call screens. The figures come from token counts (output tokens weigh most, cache reads
  least), a per-model-size energy factor, a data-centre overhead (PUE 1.2), a global grid average (445 g CO₂/kWh) and a
  water factor (1.8 L/kWh). They are public-estimate assumptions, not measured data and not GreenPixie data, so every
  figure carries a `~`: use them to compare prompts and models, not to report a footprint. The factors and their
  sources are in `lib/emissions-factors.json`; replace that file to use your own.

## 0.2.4 (2026-10-14)

### Changed

- **A new extension ID: `techselva.ai-cost-coach`** (publisher `techselva`, name `ai-cost-coach`; it was
  `flexera.ai-cost-drilldown-vscode`). VS Code sees a different extension, so it does not update the old one: uninstall
  AI Cost Drilldown / AI Cost Coach 0.2.3 and earlier, or both run and show two sets of views. The `aiCost.*` settings,
  the coach's files in `~/.ai-cost-drilldown/` and the Copilot hook are unchanged, so your settings carry over. The
  `.vsix` is now `ai-cost-coach-<version>.vsix`.

### Fixed

- **The tour opens by the extension's own ID** instead of a fixed one, so **AI Cost: Show Tour** keeps working under any ID.

## 0.2.3 (2026-10-14)

### Fixed

- **The detail panel opens as a tab, not a new split.** It used to open "beside", which made a new editor group to the
  right. It is now a tab in the overview's group (or the group you are in, with no overview open).
- **Selecting a session, prompt or call brings the detail tab forward.** The detail panel is opened once and reused, so
  with it already open (behind another tab, or in another column) a new selection changed its content but left it hidden.
  It is revealed now, and the focus stays in the tree.

### Changed

- **The extension is now called AI Cost Coach** (it was AI Cost Drilldown): the Extensions view, the tour, the README and the
  release titles. The extension ID (`flexera.ai-cost-drilldown-vscode`) and the `aiCost.*` settings are unchanged, so it
  updates in place and keeps your settings. Commands keep the short `AI Cost:` prefix.
- The repository, homepage and issues links on the extension's Details page now point to
  https://github.com/techsalvator/ai-coach.

## 0.2.2 (2026-10-11)

### Added

- **Advice now lists the token-saving tools that were not used**, under the measured findings: `/compact` never run in a long
  Copilot CLI session, a folder worked in again and again with no project instructions file, the token logger not recording
  (and whether that is tracking being off or experimental mode), and the coach switched off. Each says what was counted and
  what to do, and opens the prompts behind it. They claim no saving of their own: that is in the findings above them.
- **The coach learns from what happens on your machine**, and Coach results has a **What the coach learned** section that says so:
  - **the cache lifetime is measured.** With the token logger on, the hook works out from the idle gaps between model calls how
    long each model really keeps its cache on your plan (5, 10, 30 or 60 minutes) and uses that in the cache rules, in place of
    the documented 5 minutes for Claude models and 30 for GPT. It needs five gaps that decide it, and is redone once a day;
  - **cold-cache warnings are checked.** After you send a prompt anyway, the next model call shows whether it started cold as
    warned; Coach results counts the warnings that were right and the false alarms.
- **Windows: the Copilot hook is set up to run from any shell, and is really checked.** The hook file now names a small
  `hook.cmd` in the runtime folder, which cmd.exe, PowerShell and Git Bash all run. The command 0.2.1 wrote (`"node" "script"`)
  is a parse error in PowerShell; it is rewritten when the extension starts. **AI Cost: Check Copilot Tracking** used to say
  "Not checked on Windows": it now starts the hook from cmd.exe and from PowerShell and reports the one that fails. Node is
  found with `where` when it is not on the PATH VS Code was given.
- The tests also run on Windows and macOS on every pull request.
- **Model guard.** When premium requests are on pace to run out (or today's budget is reached), the extension says so once,
  names the models that cost you the most requests a prompt (from your own prompts) and the cheaper one you already use most,
  and stays on until the month is projected under 95% of the plan. It advises only: it does not hide or switch models.
  In the Coach panel: the **Model guard** switch and the **Model guard: costly from** limit.
- **Pacing that says what to do.** Under the Copilot premium-request budget, the overview now shows what the room left today
  buys on each model you use (from your own prompts' cost, median over 30 days; the usual 0.33x / 1x / 3x tiers when there is
  no history), and how the last 7 days ran against the month's pace, with where the month would end at that rate.

### Changed

- **Strict model writes better suggestions.** The small model now also sees the result of the tool call that failed since
  your last prompt (where the error text usually is), both ends of a long answer instead of its start, and the branch name.
  The held prompt and the conversation are passed as material in tags, with the instruction after them, so text in a prompt
  cannot redirect the rewrite. "Your data and privacy" in the README lists what is sent.

- **A hook that fails is no longer silent.** The hook never fails a prompt, so a coach that broke used to look like one with
  nothing to say. Its failures are now written to `~/.ai-cost-drilldown/hook-errors.jsonl`; the Coach panel's **Copilot
  tracking** row says how many prompts ran unchecked in the last day, and **AI Cost: Check Copilot Tracking** shows the last error.
- **The cost gate keeps working with several busy sessions.** The token logger now also keeps each session's last call in a
  small file of its own (`~/.ai-cost-drilldown/last-call/`). The hook used to find it at the end of the one shared token log,
  where another session's calls could push it out of reach, and the gate then fell back to counting prompts without saying so.
- A held prompt that names nothing to work on ("clean up the code") gets a fill-in template for a change, not the one for an error.

### Fixed

- **Coach state is no longer lost between sessions.** Settings and the coach's per-session state are written whole (a
  half-written file used to read as "no settings", which put every default back), and a hook saves its own session into
  what is on disk at that moment, so two sessions sending prompts together no longer overwrite each other.
- **"Fix the failing tests" is no longer held.** A short prompt that asks to fix something the agent finds with one command
  (the tests, the linter, the build, type errors, CI, merge conflicts) is not thin, and runs. "The tests are broken" and
  "fix the error" are still held.
- **Coach results no longer count a cold cache as avoided when it was paid.** A different prompt sent on the same cold cache
  used to count as *changed*, with the restart's cost as avoided, and then as a second hold. It is now the same hold, still
  open: it is *changed* when the cache is dealt with (`/compact`, `/clear`, `/new`) or the session is left for a day, and
  *sent anyway* when a prompt is sent again on the cold cache.
- **The daily budget counted the wrong thing.** Today's use was the change in the month's quota reading since the day's
  first prompt. In a Copilot session inside VS Code that reading is rarely written, so the count stayed at zero and then
  jumped by days of use at once ("you have used 737 of today's 8 premium requests"). Today's use is now what this machine's
  Copilot sessions used since midnight, from the running total every session log keeps, in Copilot CLI and VS Code alike.
- **The quota shown could be out of date.** The newest reading was looked for only in the last 512 KB of a session log, so
  it was lost as the log grew and an older one from another session was shown. The whole log is searched now, and the
  newest reading across sessions wins.

### Known limits

- Today's use counts this machine's Copilot sessions. Premium requests made on another machine, or outside Copilot CLI
  and VS Code, are in the month's quota but not in today's count.
- In a Copilot session inside VS Code the quota reading (requests left, reset date) is written only now and then, so it
  can be some hours old.

## 0.2.1 (2026-10-08)

### Fixed

- **The status bar follows the tool selection.** Leaving a tool out in the chart legend or the Sessions filter now takes its
  cost out of `AI today` at once (it used to count every tool until the next sync), names what is left (`· Claude Code`, or
  `· 2 of 3 tools`), and shows the Copilot premium-request quota and daily budget only while Copilot CLI is selected. A day,
  model or text filter does not apply to it: it is always about today.

## 0.2.0 (2026-10-08)

Premium-request quota and daily budget for Copilot, a stricter and cost-aware coach that also works in VS Code chat, a
tour, and releases built by GitHub Actions.

### Added

- **Copilot premium requests left this month** under the overview tiles: used, left, reset date, and the month-end pace,
  read from the quota Copilot CLI writes into its session log (no setting needed). The status bar shows it too
  (`AI today $1.20 · Copilot 6,832 left (89.9%)`), highlighted when the month is on pace to go over.
- **A daily budget for Copilot premium requests**: what is left, spread over the weekdays remaining until the reset
  (Monday to Friday), shown in the overview with today's use against it, and in the status bar as `3/16/day`.
  **Daily budget (premium requests)** in the Coach panel sets your own number instead (empty: the automatic figure); the
  status bar turns to the warning colour when today goes over it, and strict mode holds the first prompt after today's use
  reaches the budget, set or automatic (once a day, none at weekends).
  Without VS Code: `cost coach budget <n>` or `cost coach budget auto`.
- **Strict mode in VS Code chat.** The hook stops the prompt and the extension shows why as a notification, with **Why**,
  **Send anyway** (sends the same prompt to the chat again) and **Copy prompt**. It only blocks while the extension is
  running, so a prompt is never stopped silently; otherwise VS Code chat gets a tip. Setting: `aiCost.notifyHeldPrompts`.
- **The hook runs with the absolute path to node.** VS Code starts hooks with a thin `PATH`, where a bare `node` fails with
  `node: command not found` and prompts run unchecked. Setup writes node's full path, an earlier setup is repaired when the
  extension starts, and **AI Cost: Check Copilot Tracking** (also run after setup and at startup) runs the hook that way and
  reports a failure.
- **Coach panel**, more of it:
  - a **cost gate**: strict mode holds a prompt that would restart a big cold cache, with its price in the banner (default
    limit $0.50; needs the token logger from Copilot tracking), and skills are checked too;
  - **Hold on every cache expiry** (on by default): strict mode holds a prompt on any cache expiry in a session of 5 or more
    prompts, with the price when it is known; off, only expiries over the cost limit are held;
  - **Coach results**: tips shown, prompts held, and what you did next, with an estimate of the cost avoided;
  - adjustable **Cost limit**, **Long session** and **Big paste** thresholds, and **Pause strict mode**;
  - a prompt that trips several rules at once is held once, with every reason listed under **Also:**;
  - the banner of a held thin prompt now carries a **Tip** line: what to change, and why that costs less;
  - a **long session** is long by the size of its context (default 150k tokens) when the token log knows it, and by prompt
    count (21) otherwise, so a few big prompts count and many small ones do not;
  - strict mode now also holds a **long session** (once per session, when it is crossed) and a **big paste** (every time),
    and a bare retry is held every time;
  - fewer false holds: follow-ups that lean on the conversation are not thin, `/compact`, `/clear` and `/new` are never held,
    and neither are the prompts Copilot sends by itself (its "you have not yet marked the task as complete" nudge, system notices).
- **A tour** (a walkthrough, `AI Cost: Show Tour` or Help → Get Started) with the screenshots, shown from the package so it works
  offline. The Details page in the Extensions view has no images, because VS Code loads images there only from public https
  addresses.
- A fuller Extensions page: icon, categories, keywords and a preview flag, and a README written for the Details tab.
- **Releases from GitHub Actions**: tests on every pull request, and a merge to `main` with a new version builds the
  `.vsix` and publishes a GitHub release `vscode-v<version>` with it attached and these notes. The `.vsix` is no longer committed to `dist/`.

### Changed

- The `package` script names the file from the version in `package.json`.
- The copy of the scripts that the hook runs (`~/.ai-cost-drilldown/runtime`) is refreshed when the scripts change, not only
  when the version does. Before, a build with the same version left an older hook in place.

### Known limits

- The premium-request quota is shown for Copilot only, and is as fresh as the last Copilot CLI call.
- Strict mode in VS Code chat has been checked in a Copilot session running inside VS Code (the hold, the notification and
  Send anyway), not yet in the classic Copilot Chat panel.
- Today's premium-request use, for the budget hold, is counted from the first prompt the coach saw that day.
- Carried over from 0.1.0: no per-call detail for VS Code chat; Claude Code deletes its own transcripts after about
  30 days unless `cleanupPeriodDays` is raised; per-call Copilot tokens exist only for calls made while tracking was on;
  not yet verified on Windows, or across Copilot CLI updates.

## 0.1.0 (2026-10-05, internal build)

First version of the VS Code extension. It replaces the Copilot CLI plugin and the `npx` installer.

### Added

- **Overview**, opened in an editor tab when you select the AI Cost icon, and a compact copy in the sidebar.
  Cost by month (chart and table) by default, with By day, 7d, 30d and 90d ranges (By day shows every day of the loaded
  history; 90d is drawn by week), tiles, a token breakdown, and cost by source, model and prompt. Click a month to see
  its days.
- **Tool selector in the chart legend** (Claude Code, Copilot CLI, VS Code chat): click a tool to leave it out or bring it
  back. It is the Sessions filter's Source setting, so the overview, the tree and Advice all follow.
- **Sessions tree** for Claude Code, Copilot CLI and VS Code Copilot Chat: session → prompt → model call, with cost,
  tokens and the tools each call used.
- **Detail panels** for a session, a prompt, a model call (what went in, what came out) and a tool call (its input
  and result). Each has a breadcrumb and a Back button.
- **Drill-down by clicking charts:** a source, model, day, week or month filters the Sessions tree; a prompt or call
  opens its detail.
- **Filter** by source, day or date range, models, minimum prompt cost and text (including session ID). A message
  above the tree says what is filtered.
- **Sort** sessions, prompts and calls by time, cost, tokens in or out, cache hit, or number of calls; sortable
  tables in the detail panels.
- **Sync sessions** button with progress and a last-synced time; the logs are also re-read every minute.
- **Advice:** where the loaded sessions could have cost less (cache expiry, model switches, a larger model on short
  replies, very long conversations, concentrated spend), with estimated savings and the prompts behind each.
- **Coach panel** with switches for cost tips, strict mode and strict model, and a **repeated-prompt check**: the same
  prompt run twice in a session is held the second time, with what the first run cost.
- **Copilot tracking** (`AI Cost: Set Up Copilot Tracking`): installs the cost-tips hook and the per-call token
  logger from the extension, after asking. `Remove Copilot Tracking` undoes it. It offers to remove the old
  Copilot CLI plugin.
- Settings: `aiCost.openOverviewOnSelect`, `aiCost.maxSessions`, `aiCost.copilotDays`, `aiCost.sources`,
  `aiCost.refreshSeconds`.

### Changed

- The cost-tips hook now answers in Copilot CLI without the plugin installed. While the old plugin is still
  installed its own hook answers, so a prompt is never handled twice.

### Removed

- The Copilot CLI plugin install path: `plugin.json`, `hooks.json`, the `/cost` skill, the `npx` installer, the
  VS Code hook and tasks scripts, and `INSTALL.md`. Typing `/cost` inside Copilot is no longer provided; the reports
  are in VS Code.

### Known limits

- No per-call detail for VS Code chat (VS Code stores one total per request).
- Claude Code deletes its own transcripts after about 30 days unless `cleanupPeriodDays` is raised.
- Per-call Copilot tokens exist only for calls made while tracking was on.
- Not yet verified: the Copilot tracking hook on Windows, and the token logger across Copilot CLI updates.
