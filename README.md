# AI Cost Drilldown for VS Code

See where your AI spend goes, from a month down to a single tool call, for **Claude Code**, **GitHub Copilot CLI**
and **VS Code Copilot Chat**, inside VS Code.

![The overview: cost by month, split by tool](docs/images/vscode-1-overview-months.png)

*Every screen in this README is one of the extension's own panels, drawn from made-up sample sessions. Nothing in
the images comes from anyone's real logs.*

## Contents

- [Install](#install)
- [The screens](#the-screens)
  - [Overview](#overview) · [The sidebar](#the-sidebar) · [A month](#a-month)
  - [A session](#a-session) · [A prompt](#a-prompt) · [A model call](#a-model-call) · [A tool call](#a-tool-call)
- [Finding things: filter, sort, sync and back](#finding-things-filter-sort-sync-and-back)
- [Advice](#advice)
- [Copilot tracking and cost tips](#copilot-tracking-and-cost-tips)
- [Reading the numbers](#reading-the-numbers)
- [Settings and commands](#settings-and-commands)
- [Your data and privacy](#your-data-and-privacy)
- [What it cannot do](#what-it-cannot-do)
- [Develop](#develop)

## Install

You need **VS Code 1.90 or newer**. Node.js 18 or newer is needed only for [Copilot tracking](#copilot-tracking-and-cost-tips),
because its hook is a Node script.

The packaged extension, a `.vsix` file, is attached to each [release](https://github.com/flexera/ai-cost-drilldown/releases).
Download it from the latest release, or with the GitHub CLI:

```bash
gh release download --repo flexera/ai-cost-drilldown --pattern '*.vsix'
code --install-extension ai-cost-drilldown-vscode-*.vsix
```

or, in VS Code, **Extensions → … → Install from VSIX…** and pick that file. Then run **Developer: Reload Window**.
To update, install the newer file over it (add `--force` to reinstall the same version).

To build the `.vsix` from source:

```bash
cd vscode-extension
npm run package          # copies the report code in, then writes ../dist/ai-cost-drilldown-vscode-<version>.vsix
```

`dist/` is not committed.

### Releasing

Releases are made by merging. A pull request that changes what the extension ships (anything under `vscode-extension/`
except its tests, scripts, README and CHANGELOG, or anything under `lib/`, `bin/` or `extensions/`) must bump the version
and add that version's CHANGELOG section: the **Version bump** check fails otherwise. Make that check required in the
branch protection of `main` to stop the merge. In the pull request, set the new version in `vscode-extension/package.json` and add a
`## <version>` section to `vscode-extension/CHANGELOG.md`; merge it to `main`.

The [workflow](.github/workflows/vscode-extension.yml) runs the tests and builds the `.vsix`. If there is no release for
that version yet, it creates the tag `vscode-v<version>` on the merge commit and publishes a GitHub release with the
`.vsix` attached and the CHANGELOG section as the notes. If the version already has a release (a merge that did not
bump it), nothing is published and the run says so. Pull requests only run the tests and build the `.vsix` as a
downloadable build artifact.

To publish a release again, delete the release and its tag, then re-run the workflow on `main` from the Actions tab.

What changed is in the [changelog](vscode-extension/CHANGELOG.md).

Click the **AI Cost** icon in the activity bar. Your Claude Code and Copilot sessions load by themselves: there is
nothing to sign in to and no key to enter. To remove it, uninstall it like any extension.

If you used the earlier Copilot CLI plugin, see [Moving from the plugin](#moving-from-the-copilot-cli-plugin).

## The screens

Inside VS Code the same screens are in the tour: run **AI Cost: Show Tour** from the Command Palette, or open Help → Get Started → AI Cost Drilldown.
The extension's own page in the Extensions view shows this text without the images, because VS Code only loads
images there from public `https` addresses.

### Overview

Selecting the AI Cost icon opens the overview in an editor tab. It starts with **cost by month**, stacked by tool:
Claude Code is blue, Copilot CLI orange, VS Code chat green, and a tool keeps its colour on every screen.

- **Tiles:** total cost, today, number of sessions, and how much of the input came from the prompt cache.
- **Cost by month** as a chart and as a table (cost per tool, sessions and prompts).
- **Where the tokens went:** cache reads, cache writes, new input and output, with each one's share.
- **By source, by model** and the **most expensive prompts**.
- **By month · By day · 7d · 30d · 90d** switches the range. **By day** shows the cost of every day in the loaded history;
  the 90-day range is drawn by week, and a month shows its days.
- **The legend under the chart is the tool selector** (Claude Code, Copilot CLI, VS Code chat). Click a tool to leave it out
  and click it again to bring it back; the last one cannot be switched off. It is the same filter as the Sessions view's
  **Filter → Source**, so the chart, tiles, tokens, sources, models, prompts, the Sessions tree and Advice all follow.
- **↻ Sync sessions** reads the logs again and shows when it last did.

![By day, with Copilot CLI left out through the legend](docs/images/vscode-1b-overview-by-day.png)

Almost everything on the page is clickable. A source or model bar filters the Sessions view to it, a month opens
that month, a day or week filters to it, and a prompt opens its detail. Hover any bar for its numbers.

### The sidebar

The AI Cost icon shows four panels. The first is a compact copy of the overview; its **Open the full overview ›**
link opens the tab.

![The compact overview in the sidebar](docs/images/vscode-2-sidebar-overview.png)

| Panel | What it shows |
|---|---|
| **Overview** | The picture above: tiles, cost by month, tokens, sources and models |
| **Sessions** | Every session as a tree: session → prompt → model call, with cost, tokens and the tools each call used. Click any row to open its detail |
| **Advice** | Where the loaded sessions could have cost less, each with an estimated saving and the prompts behind it. See [Advice](#advice) |
| **Coach** | Switches for [Copilot tracking and cost tips](#copilot-tracking-and-cost-tips) |

The Sessions title bar has **Overview**, **Sort**, **Filter**, **Clear filter** (while one is active) and **Sync** buttons.

### A month

Click a month, in the chart or the table, and the whole overview switches to it: its tiles, its cost per day,
its sources, models and prompts. A breadcrumb at the top (`All months › September 2026`) takes you back, and
**Filter sessions to this month** applies the month to the Sessions view.

![One month, day by day](docs/images/vscode-3-overview-month.png)

### Copilot premium requests left

Under the tiles, a bar shows how many of your plan's premium requests are left this month: used, left, the
reset date, and where the month will end at the current pace, flagged when that is over what the plan includes.
The numbers are the ones Copilot CLI writes into its own session log, so they are your plan's real allowance, with
nothing to configure. They update when Copilot CLI makes a call; the panel is hidden on plans with unlimited
requests, and says so when the last reading is from a month that has ended. The status bar carries it as well (`AI today $1.20 · Copilot 6,832 left (89.9%)`) and turns to a warning colour when the month is
on pace to go over. The panel also sets a daily budget: what is left, spread over the weekdays remaining until the reset (Monday to Friday,
today included while it is a weekday), with today's use against it. The status bar shows it as `3/16/day`, today's
requests over the budget. Set your own number with **Daily budget (premium requests)** in the Coach panel (empty means automatic, the calculation above), or from a terminal with `cost coach budget 50` (`cost coach budget auto` goes back to automatic; with no number it shows the current budget); the status bar
turns to a warning colour when today goes over it. Today's use comes from Copilot CLI
sessions. Claude Code has no monthly request quota in its logs, so only Copilot is shown.

Two lines under the budget turn the pace into something to act on:

- **What the room left today buys, by model.** A model's multiplier is what makes a request cost 1, 3 or 0.33, so the
  panel says how many prompts the rest of today's budget is on each of the models you use most (`17 on claude-sonnet-5.5
  (1 a prompt, from your 3 prompts) · 5 on claude-opus-5.5 · unlimited on gpt-5-mini`). The per-prompt figure is the median
  of your own single-model prompts over 30 days, with at least three, so it is what your prompts cost, not a table. With
  no history yet it shows the usual 0.33x, 1x and 3x tiers instead and points you to `/model`.
- **How the last 7 days ran.** The month's pace is an average since the reset, which is slow to notice a change. When the
  last 7 days' pace would end the month at a clearly different number, the panel says so, and whether that is over what
  your plan includes. This machine's prompts set the rate and the account's reading sets where it starts, so use on another
  machine makes it an underestimate.

### The model guard

When Copilot's premium requests are on pace to run out (at the last 7 days' pace, or today's use has reached the daily
budget), the extension says so once, names the models that cost you the most requests a prompt, and names the cheaper
one you already use most (`claude-opus-5.5 (3 a prompt) … claude-sonnet-5.5 costs you about 1 a prompt: use it for
routine work`). The status bar goes to its warning colour and its tooltip carries the same line. It stays on until the
month is projected under 95% of the plan, so it does not flicker at the line, and a new billing period starts clean.

It advises and nothing more: **it does not hide or switch any model.** VS Code keeps which models are hidden in its own
profile storage and offers no setting, command or extension API to change it, so hiding is done by you, with the eye
icon in **Chat: Manage Language Models**. An organization that must enforce a list does it in GitHub's Copilot model
policy. The notification's button opens the model picker. In the Coach panel: the **Model guard** switch (on) and the
**Model guard: costly from** limit (2: the requests a prompt from which a model counts as costly).

### A session

Click a session in the tree, or a bar in the overview. The panel shows its tool, folder and branch, a cost-per-prompt
chart, where its tokens went, a table of models, and every prompt with tokens in and out, cache hit and cost.
Click a column header to sort the table; click a row or a bar to open that prompt.

![A session: cost per prompt, tokens, models and prompts](docs/images/vscode-4-session.png)

### A prompt

A prompt shows its cost, model calls, cache hit and tool calls, the token split, the cost of each model call, a
**Model calls** table with the tools each call used, and every tool call it made.

![A prompt: its model calls and tool calls](docs/images/vscode-5-prompt.png)

A **breadcrumb with a Back button** runs along the top of every detail panel: `‹ Back | Overview › billing-service › Prompt 6`.
Each part is a link, and Back steps through what you opened, in order.

### A model call

A call shows what it cost, its tokens in and out, and the tools it made. Below that it shows **what went in**
(what was new since the previous call: your prompt, or the results of the previous call's tools) and
**what came out** (the reply, the reasoning where it is recorded, and each tool request).

![One model call: what went in and what came out](docs/images/vscode-6-call.png)

The rest of a call's input was the earlier conversation, almost all of it served from the cache; the token bar
shows how much.

### A tool call

Click any tool in a Tool calls table to see its **input** (the full arguments) and its **result**, with its status,
result size and time. This works for both Claude Code and Copilot CLI, including prompts that have no token data.

![One tool call: its input and its result](docs/images/vscode-7-tool.png)

## Finding things: filter, sort, sync and back

- **Filter** (the funnel in the Sessions title bar) narrows the tree by *source*, *day or date range*, *models*,
  *minimum prompt cost* and *text* (a word in the prompt, session title, session ID, folder or branch). Clicking a
  chart adds to the filter too, so you can go source → model → day. While a filter is active, a message at the top of
  the tree says what it is and how many sessions and prompts match, and the funnel next to it clears it. The Advice
  panel and the overview follow the filter.
- **Sort** orders sessions, the prompts in them and each prompt's calls together, by time, cost, tokens in, tokens
  out, cache hit or number of calls. Choose the same key again to reverse it. Anything without a value for the key
  goes last.
- **Sync sessions** reads the logs again. It also runs by itself every minute; the manual button shows progress,
  says what changed (`synced 108 sessions (+2), 1177 prompts (+8)`) and the overview shows when it last synced.
- **Back and the breadcrumb** work in every detail panel, as described [above](#a-prompt).

## Advice

The Advice panel measures your own sessions and lists where spend could be cut. Each finding says what was
measured, an estimated saving in dollars, and the prompts it comes from (click one to open it).

| Finding | What it measures |
|---|---|
| **Prompt cache expired between prompts** | Prompts that started after the cache had lapsed, so the whole conversation was re-sent at the cache-write price instead of the cheap read price |
| **Model switched mid-session** | Prompts that ran on a different model from the one before, which cannot reuse its cache |
| **Top-tier model on short replies** | Calls on the larger models that returned 400 tokens or fewer, re-priced on a Sonnet-class model |
| **Very long conversations** | Calls that sent more than 150k tokens of context; the saving is a ceiling for capping it at 100k |
| **A few prompts carry the spend** | The five most expensive prompts and their share of the total |

Savings overlap (a fresh session also removes cache expiries), so they do not add up. Findings that would save
less than a few cents are left out.

### Token-saving tools that were not used

Under the measured findings, with a tools icon, the panel lists the habits that would have prevented them and were not
used. They claim no saving of their own, because what they cost is already in the findings above.

| Finding | When it shows |
|---|---|
| **/compact was not used in long sessions** | Copilot CLI sessions that reached 150k tokens of context (or 21 prompts, where there is no token data) and were never compacted. Counted from Copilot's own log, which records each compaction |
| **No project instructions file** | A folder you ran three or more sessions in has no `.github/copilot-instructions.md` or `AGENTS.md` (for Claude Code: `CLAUDE.md` or `AGENTS.md`), so each session works out the build, the tests and the layout again |
| **Copilot tracking is off** / **The token logger is not recording** | A fifth or more of the last 7 days' Copilot CLI prompts have no token data. It says which of the two it is, and what to do |
| **Cost tips are off** | The Coach switch is off while Copilot prompts are being sent |

Claude Code's log does not say when a context was compacted, so its sessions are not judged on that.

## Copilot tracking and cost tips

Without any setup, Copilot sessions already show **credits and dollars per prompt, and prompt tokens**, read from
Copilot CLI's session log and from VS Code's chat storage. **Copilot tracking** adds two things that need to run
inside Copilot itself:

- **Per-call tokens.** Copilot's log has credits but no tokens. A small Copilot CLI extension records the tokens of
  every model call as it happens, which gives the token split, the model-calls table and exact call costs. Prompts
  it did not see show "No token data": that cannot be recovered afterwards.
- **Cost tips.** A prompt hook shows one line when a prompt is about to cost more than it needs to, in Copilot CLI and
  in VS Code's chat.

To turn it on, tick **Copilot tracking** in the Coach panel, or run **AI Cost: Set Up Copilot Tracking**. VS Code
also offers it once if it finds Copilot on your machine. It asks first and lists exactly what it will write:

| Where | What |
|---|---|
| `~/.copilot/hooks/ai-cost-drilldown.json` | The hook, read by VS Code chat and Copilot CLI |
| `~/.copilot/extensions/ai-cost/` | The token logger, which writes `~/.ai-cost-drilldown/copilot-tokens.jsonl` and each session's last call in `~/.ai-cost-drilldown/last-call/` |
| `~/.ai-cost-drilldown/runtime/` | The scripts the hook runs, copied somewhere that survives extension updates |

Copilot CLI loads extensions only in experimental mode: run `/experimental on` once, then start a new session.
**AI Cost: Remove Copilot Tracking** deletes the three pieces and keeps your token log and settings. After an
extension update the copies are refreshed by themselves.

### The cost tips and the five switches

The Coach panel has five switches, saved where the hook reads them (`~/.ai-cost-drilldown/config.json`):

| Switch | What it does | Default |
|---|---|---|
| **Coach** | Shows a one-line tip when a prompt, or the session it is sent in, is about to cost more than it needs to | on |
| **Strict mode** | In Copilot CLI, holds a prompt back with a banner instead of running it (a thin prompt, a repeat, a cache expiry, a long session, a big paste or going over your daily budget); sending the same prompt again runs it as written. In VS Code chat it holds the prompt too, and the extension shows the banner as a notification ([below](#strict-mode-in-vs-code-chat)); if the extension is not running, VS Code chat gets the tip instead | on |
| **Hold on every cache expiry** | In strict mode, hold a prompt whenever the session's cache has expired (idle past the cache lifetime, in a session of 5 or more prompts), with its price in the banner when the token log knows the session's size. Off, only an expiry whose restart costs at least the cost limit is held and the rest is a tip | on |
| **Strict model** | The banner also carries the prompt reworded by a small model (one `copilot -p` call each time, so it costs a little) | off |
| **Model guard** | Says which of your models cost the most premium requests a prompt, and which cheaper one you use, while the month is on pace to run out ([above](#the-model-guard)). Advice only | on |

A switch shows "inactive" when the one it depends on is off, and "set by …" when an environment variable
(`AI_COST_COACH`, `AI_COST_COACH_STRICT`, `AI_COST_COACH_EXPIRY`, `AI_COST_COACH_REWRITE`, `AI_COST_MODEL_GUARD`) decides it.

| Rule | When it applies | Held in strict mode |
|---|---|---|
| **Cold cache over the cost limit** | The session's cache has expired and re-sending its context would cost at least the cost limit (default $0.50) for the first model call alone. The banner says how many tokens and how many dollars, and how much of that is avoidable. Skills are checked too | yes, on every expiry, whatever the switch |
| **Repeated prompt** | The same prompt, or the same skill with the same arguments, already ran in this session. The banner says how long ago, and what that run cost when the token log saw it | yes, every time |
| Nothing to work on | A short prompt names no file, function or ticket: "clean up the code" | yes, every time |
| Problem without the error | A short prompt mentions an error but not where or what it says: "fix the bug". Not held when the agent can find it with one command: "fix the failing tests", the lint errors, the build, type errors, CI, merge conflicts | yes, every time |
| Several asks in one | A short prompt strings separate tasks together with "also … also …" | yes, every time |
| Bare retry | The prompt is only "try again", "fix it", "still not working" and the like | yes, every time |
| **Cache expired** | A session of 5 or more prompts sat idle past the cache lifetime (5 minutes for Claude models, 30 for GPT, or what your token log shows it to be: [below](#what-the-coach-learns)). The banner says how long and, when the token log knows the session's size, the price of restarting it | yes, on every expiry (the **Hold on every cache expiry** switch); off, it is a tip |
| **Long session** | The session's context is 150k tokens or more (the **Long session (tokens)** limit), all of it re-sent on every model call. Without the token logger's log the prompt count decides instead: 21 or more prompts (the **Long session (prompts)** limit) | yes, once per session, when it is crossed |
| **Daily budget** | Today's premium requests have reached the day's budget: the **Daily budget (premium requests)** you set, or, when you have not set one, what the month has left spread over the weekdays remaining (worked out once a day; no budget at weekends). The first prompt after that is held, with what was used and a tip to pick a model with a lower premium multiplier. Today's use is what this machine's Copilot sessions used since midnight (Copilot CLI and Copilot in VS Code), from the running totals in their logs; requests made on another machine or in another tool are not counted | yes, once a day |
| **Big paste** | The prompt carries 12,000 or more characters of pasted text (the **Big paste** limit), which is re-sent on every later call | yes, every time |

Every held prompt's banner says why it was held, gives a **Tip** on what to change (and a fill-in template for a thin prompt), and says how to run it anyway: send the same prompt again.
When a prompt trips several rules at once, one banner lists them all (**Also:**), so sending it again never runs it past a reason you were not shown.
With strict mode off, or in VS Code chat while the extension is not running, each of these is a one-line tip instead: at most one tip per prompt, and each kind once per session. The checks are patterns on the prompt text and the
session's own log, run locally; they catch prompts that are plainly thin, not ones that are subtly unclear.
Questions, answers ("yes", "continue"), follow-ups that lean on the conversation ("still the same error", "yes, fix
the alias bug first") and anything naming a file, identifier, ticket, link, number or quoted text are never flagged
as thin, and `/compact`, `/clear` and `/new` are never held. The cost rule needs the token logger that Copilot
tracking installs, because that log says how big the session's context is; without it you get the plain cache tip.

### If the hook does not run

VS Code and Copilot start the hook with a thin `PATH`, so a bare `node` command is not found (the hook fails with
`node: command not found` and every prompt runs unchecked). Setting up Copilot tracking therefore writes the **absolute
path to your node** into the hook file, and an earlier setup that wrote a bare `node` is repaired the next time the
extension starts. **AI Cost: Check Copilot Tracking** runs the hook with that same thin `PATH` and tells you whether it
works; it is also run right after setup and a few seconds after VS Code starts, and a failure shows an error. Copilot
records a failed hook in the session's `events.jsonl` (`hook.end` with `success: false` and the error), which is where to
look if prompts are not being held.

A hook that starts but then fails inside lets the prompt run, as a hook must, and writes the error to
`~/.ai-cost-drilldown/hook-errors.jsonl`. The **Copilot tracking** row in the Coach panel then says how many prompts ran
unchecked in the last day, and **AI Cost: Check Copilot Tracking** shows the last error.

**On Windows** nothing documents which shell starts a hook, and they disagree: `"C:/…/node.exe" "C:/…/cost.js" hook` is a
command in cmd.exe and Git Bash but a parse error in PowerShell. So there the hook file names one small file,
`~/.ai-cost-drilldown/runtime/hook.cmd`, which holds node's full path. Written with forward slashes and no quotes it runs
from cmd.exe, PowerShell and Git Bash alike; if your home folder has a space in its name it is run through
`cmd /d /c "…"`, which cmd.exe and PowerShell run and Git Bash does not. **AI Cost: Check Copilot Tracking** starts the
hook from cmd.exe and from PowerShell and reports the one that fails. A setup made by 0.2.1 or earlier is rewritten the
next time the extension starts.

### Strict mode in VS Code chat

VS Code stops a prompt that a hook blocks, but it never shows the hook's reason: the prompt would just vanish. So the
hook blocks in VS Code chat only while this extension is running to show why. The extension tells the hook it is there
(a small heartbeat file, refreshed every 15 seconds), and each held prompt appears as a notification in the VS Code
window you are using:

- **Why** opens the full banner (the reason, the tip, what to do) with the prompt.
- **Send anyway** sends the same prompt to the chat again, which runs it. It is the same as sending it again in
  Copilot CLI.
- **Copy prompt** copies it, so you can reword it first.

If no VS Code window with the extension is open, or `aiCost.notifyHeldPrompts` is off, the hook gives VS Code chat a tip
instead, as before, so a prompt is never stopped silently. A notification is shown in the focused window only, and only
for a minute: a hold you did not see in time is dropped, and sending the same prompt again still runs it.

### Cost limit, results and pause

Under the switches the Coach panel has:

- **Coach results** opens what the coach did over the last 30 days: tips shown, prompts held, and whether you then
  changed the prompt or sent it anyway, with an estimate of the cost the changes avoided.

  ![Coach results: what was held, what you did next](docs/images/vscode-8-coach-results.png)

  *Held* is a prompt strict mode stopped. *Changed* is a different prompt afterwards, or a hold that no longer applied
  (for example after `/compact`). *Sent anyway* is the same prompt sent again. A cold cache is different, because
  rewording the prompt does not warm it: a different prompt in the same session is the same hold, still open. It becomes
  *Changed* when the cache is dealt with (`/compact`, `/clear`, `/new`) or the session is left alone for a day (the
  work went to a new session), and *Sent anyway* when a prompt is sent again on the cold cache. The avoided figure counts only held
  prompts you changed, from list prices: for a cold cache the extra cost of re-sending the context at full price, for a
  repeat the cost of the earlier run. It is an estimate, not a measured saving.
- **Cost limit**, **Long session (tokens)**, **Long session (prompts)**, **Daily budget (premium requests)**, **Big paste** and **Model guard: costly from** are the thresholds above. Click one to change it; leave the box
  empty to put the default back.
- **Pause strict mode** stops prompts being held for 30 minutes, 1 hour, 4 hours or until tomorrow, and resumes by
  itself. Tips still show while it is paused.

### What the coach learns

The coach's rules start from fixed lines. Two things in it are then corrected from what happens on your machine, and
**Coach results** has a **What the coach learned** section that says what was corrected and from how much evidence.

- **The cache lifetime.** Five minutes for Claude models and thirty for GPT are what is documented, not necessarily what
  your plan does. With the token logger on, the hook looks at the idle gaps between a session's model calls and whether
  the call after each gap read its context from the cache or paid for it again, and picks the lifetime (5, 10, 30 or 60
  minutes) that explains them. It overrules the documented figure only with five or more gaps that tell the choices
  apart and a lifetime that explains at least four in five of them. It is worked out once a day and kept in
  `~/.ai-cost-drilldown/cache-ttl.json`.
- **Cold-cache warnings, checked.** When you send a prompt anyway after a cold-cache hold, the hook looks at the next
  model call in the token log: did it start cold, as warned? Coach results counts how many warnings were right and how
  many were false alarms.

Both need the token logger from Copilot tracking; without it the documented lifetimes are used and nothing is checked.

### Moving from the Copilot CLI plugin

Earlier versions were installed as a Copilot CLI plugin (`copilot plugin install`). The extension replaces it. If
the plugin is still installed, setting up Copilot tracking offers to remove it (it runs
`copilot plugin uninstall ai-cost-drilldown`), and until it is gone the plugin's own hook answers prompts, so a
prompt is never handled twice. The `/cost` command typed inside Copilot is no longer provided: the reports are in
VS Code.

## Reading the numbers

**Costs are estimates.** Claude Code's cost is each model's list price applied to the tokens in its transcript,
scaled to the session total Claude Code recorded when it has one (a `~` marks an estimate). Copilot's cost per
prompt is the AI credits Copilot recorded, at **$0.01 per credit**; each model call is priced at GitHub's published
token prices (`lib/copilot-prices.json`), so the calls of a prompt may not add up to its credits to the cent. A model
without a price shows "—". Subscription usage is not billed per token: these are list-price figures for comparing
where the usage went.

**Cache.** Every model call re-sends the whole conversation, normally from a cheap cache. *Read from cache* is
input served from it, *written to cache* is input stored for next time at a higher price, and *new input* is neither.
A high cache hit means a conversation is being reused well; a prompt that starts with a miss pays full price for
all of it.

**Sources.** Claude Code is read from `~/.claude/projects/`, Copilot CLI from `~/.copilot/session-state/`, and VS Code
Copilot Chat from VS Code's own storage.

## Settings and commands

| Setting | Default | What it does |
|---|---|---|
| `aiCost.openOverviewOnSelect` | on | Open the overview in a tab when you select the AI Cost icon |
| `aiCost.maxSessions` | 500 | How many recent Claude Code transcripts to read |
| `aiCost.copilotDays` | 90 | How many days of Copilot CLI and VS Code chat history to load |
| `aiCost.sources` | `claude`, `copilot` | Which tools to load sessions from |
| `aiCost.refreshSeconds` | 60 | How often to read the logs again |
| `aiCost.notifyHeldPrompts` | on | Show prompts that strict mode holds in VS Code chat as notifications. Off, VS Code chat gets a tip instead of a block |

Commands (Command Palette, **AI Cost: …**): Overview, Sync Sessions, Filter, Clear Filter, Sort, Set Up Copilot
Tracking, Remove Copilot Tracking.

## Your data and privacy

The extension reads session logs that already exist on your machine, which include your prompt text, folders and
branch names. It sends nothing anywhere and needs no account or key. The one exception is **Strict model**, which
sends the held prompt, the session's last few prompts, its last answer, the result of its last failed tool call and
the branch name to a small model through your own `copilot` command.

It writes nothing to those logs. Its own files are in `~/.ai-cost-drilldown/` (a cache of what it read, the coach
settings, saved reports, and the token log when tracking is on); `AI_COST_HOME` changes that folder.
[Copilot tracking](#copilot-tracking-and-cost-tips) is the only thing that writes outside it, and only after you
agree.

## What it cannot do

- **Recover tokens it did not record.** Per-call Copilot tokens exist only for calls made while tracking was on.
- **Per-call detail for VS Code chat.** VS Code stores one total per request, so its sessions stop at the prompt.
- **Show Claude's reasoning.** Claude Code's transcripts keep only a signature for it, so the Thinking box is empty.
- **Go back past what the tools keep.** Claude Code deletes its own transcripts after about 30 days unless
  `cleanupPeriodDays` in `~/.claude/settings.json` is raised, and only from then on.
- **Bill-accurate totals.** It reports what the tools logged on this machine: not other machines, and not what is
  finally invoiced.
- **Show Copilot's full replies.** Copilot CLI's event log keeps tool requests and a short preview of each reply.
- **Coach Claude Code.** Claude Code sessions are measured, but the coach (tips and strict mode) acts on Copilot sessions only:
  Copilot CLI, and Copilot sessions running inside VS Code.
- **Hold a prompt it was never shown.** The coach acts through a hook. If the hook cannot run, Copilot lets the prompt
  through, which is why **AI Cost: Check Copilot Tracking** exists.

Checked in a live session: strict mode holding a prompt in a Copilot session running inside VS Code, with the
notification and **Send anyway**. On Windows the hook is started from cmd.exe and PowerShell by the tests, on every pull request. Not yet checked: the classic
Copilot Chat panel, a prompt held by the hook in a live Copilot session on Windows, and the token logger across Copilot
CLI updates (Copilot's extensions are experimental).

## Develop

```bash
cd vscode-extension
npm test                         # node --test, no dependencies
node model.js 5                  # the Claude Code sessions, in the terminal
node copilot.js 30               # the Copilot sessions of the last 30 days
npm run package                  # build the .vsix into ../dist
node scripts/screenshots.js      # redraw the images in docs/images (needs Chrome)
```

To try the extension without installing it, open `vscode-extension/` in VS Code and press F5.

| Path | What it is |
|---|---|
| `vscode-extension/extension.js` | The views, panels, filter, sort, sync and Copilot tracking commands |
| `vscode-extension/model.js`, `copilot.js`, `sources.js` | Sessions → prompts → calls → tools, from Claude Code and Copilot |
| `vscode-extension/charts.js`, `sort.js`, `filter.js`, `advice.js`, `habits.js` | Charts (plain SVG), sort, filter, the advice rules and the unused-tools checks |
| `vscode-extension/copilotsetup.js`, `coachsettings.js` | Copilot tracking setup and the coach switches |
| `vscode-extension/scripts/` | `screenshots.js`, `demo-data.js` (the sample sessions), `bundle-runtime.js` |
| `lib/` | The report code: session logs, prompts, tools, advice, VS Code chat storage, prices |
| `bin/cost.js` | The Copilot hook (cost tips); the extension copies it when tracking is set up |
| `extensions/ai-cost/` | The Copilot CLI token logger the extension installs |
| `test/` | Tests for `lib/`, `bin/` and the logger |
