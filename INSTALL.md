# Install

ai-cost-drilldown has two parts you can use independently:

- a **GitHub Copilot CLI plugin** — `/cost` (or `/ai-cost-drilldown:cost`) reports credits, dollars, tokens and
  tool calls per session, prompt, epic and model call, with no AI credits; it also covers VS Code Copilot Chat;
- a **Claude Code cost report** — `bin/claude-cost.js`, run with Claude Code's `!` prefix. Nothing to install.

What the commands do is in the [README](README.md). This page is about setting it up.

Both only read the tools' own session logs (`~/.copilot/session-state/`, `~/.claude/projects/`). They write
nothing there, call no API and need no credentials.

## Quick start: one command

```bash
npx github:flexera/ai-cost-drilldown
```

It shows what it will do and asks first, then runs `copilot plugin install flexera/ai-cost-drilldown`. The plugin
includes an **extension** (`extensions/ai-cost/`, which Copilot CLI loads together with the plugin) that adds the bare
`/cost` command and records per-call tokens, so this one step installs everything for Copilot CLI.

If VS Code is installed (its user folder exists), the same run also adds the [VS Code chat hook](#vs-code-chat)
(`/cost` and cost tips in VS Code's chat) and the ["AI cost: …" tasks](#vs-code-tasks). Both are listed before it
asks, and each can be left out with a flag. Copilot CLI itself is optional: without it the plugin step is skipped
and the VS Code parts are still set up (see [Requirements](#requirements)).

Then, once: run `/experimental on` in Copilot (extensions are experimental), open a new session, and try
`/cost help` and `/tokenlog`. Without experimental mode, `/ai-cost-drilldown:cost help` still works (see below).
The Claude Code report needs no install.

| Flag | Effect |
|---|---|
| `--yes` | do not ask |
| `--dry-run` | show what would run and change nothing |
| `--uninstall` | remove the plugin (and a separate logger copy, if you have one); the token log is kept |
| `--source <owner/repo or path>` | install from another repository, fork or local clone |
| `--from-here` | install from the checkout the installer runs from: how to test a branch (below) |
| `--no-vscode-hook` | do not add the VS Code chat hook (see [VS Code chat](#vs-code-chat)) |
| `--no-vscode-tasks` | do not add the "AI cost: …" tasks to VS Code (see [VS Code tasks](#vs-code-tasks)) |
| `--user-extension` | also copy the logger to `~/.copilot/extensions/` (a fallback; see below) |
| `--dir <path>` | the extensions folder for `--user-extension` (default `$COPILOT_HOME/extensions`) |

**Testing a branch before it is merged.** `npx github:flexera/ai-cost-drilldown#<branch>` fetches that branch, but the
plugin would still be installed from the default branch. Add `--from-here` so it installs from the fetched branch itself:

```bash
npx github:flexera/ai-cost-drilldown#<branch> --from-here
```

A tag works the same way and stays fixed while the branch moves, so prefer one for a test you want to repeat. The whole
setup from a release-candidate tag (plugin, plus the VS Code chat hook and tasks when VS Code is installed):

```bash
npx git+https://github.com/flexera/ai-cost-drilldown.git#v0.1.0-rc.7 --from-here
```

Use the `git+https://…` form if `npx github:…` fails with `Permission denied (publickey)`: the short form can go through
SSH, which needs an SSH key registered with GitHub, while HTTPS uses your normal Git credentials. Use a new tag for new
commits rather than moving one; npm caches by commit.

(Try it in a [sandbox](#try-it-in-a-sandbox) first.) From a clone, `node bin/install.js` does the same as the plain command. It changes Copilot's user-level configuration, so it is never
silent: in a script or CI, pass `--yes` explicitly.

Copilot prints a warning that installing a plugin straight from a repository or path "is deprecated" in favour of
marketplace installs. It works today; a marketplace listing is the planned replacement.

> Not yet verified against the private repository's `main` branch, which does not hold the plugin yet. Copilot did
> reach the repository (it reported that `plugin.json` was missing), so access works. If an install fails, use the
> manual routes below and tell the maintainers what the error said.

The steps below are the same install done by hand.

## Requirements

- **Node.js 18 or newer** on your `PATH` (`node --version`). The plugin's hook runs `node bin/cost.js hook`.
- **Copilot CLI**, only for the parts that live in it — developed and tested on 1.0.89 to 1.0.91. Plugins need a
  version that supports `copilot plugin` and `--plugin-dir`.
- **VS Code** with Copilot Chat, for the chat hook and the tasks.
- **Claude Code**, for the Claude report.

Only Node.js is needed by everything. What needs Copilot CLI:

| Part | Needs Copilot CLI |
|---|---|
| `/cost` and `/tokenlog` inside Copilot CLI (the plugin), strict mode there | yes |
| Strict model (the rewrite is a `copilot -p` call) | yes |
| `/cost` and cost tips in VS Code's chat (the chat hook) | no |
| VS Code tasks, and `node bin/cost.js …` in a terminal | no |
| Claude Code report | no |

**Without Copilot CLI** the installer still works: it reports the plugin as skipped and sets up the VS Code chat hook
and tasks. Run through `npx` it first copies the scripts to `~/.ai-cost-drilldown/app`, because npm's cache is
temporary; from a clone they run from the clone. `--uninstall` removes the hook, the tasks and that copy.
- Access to this repository (it is private to the organisation) for `npx github:…` and `copilot plugin install`.

No `npm install` is needed: there are no dependencies.

```bash
git clone https://github.com/flexera/ai-cost-drilldown.git ~/ai-cost-drilldown
cd ~/ai-cost-drilldown && npm test        # optional; no dependencies to install
```

> **Paths in this guide.** The examples use `~/ai-cost-drilldown`. That is only where the example above cloned it:
> replace it with your own folder (for instance `~/PycharmProjects/ai-cost-drilldown`). A wrong path fails quietly in two
> places: `copilot --plugin-dir <wrong folder>` starts normally but only warns "no plugin.json or SKILL.md found" and has no
> `/cost`; and VS Code tasks keep pointing at the folder they were added from.

## Copilot CLI plugin

### Try it without installing

```bash
copilot --plugin-dir ~/ai-cost-drilldown
```

This loads the plugin for that session only. Nothing is written to your Copilot configuration. This is the
route that has been tested end to end (interactive and prompt mode).

### Install it for every session

```bash
copilot plugin install flexera/ai-cost-drilldown
```

> Not yet verified for a private repository: the install clones the repo with your GitHub credentials, so
> `gh auth status` should show an account with access. If it fails, use `--plugin-dir` above, and tell the
> maintainers what the error said.

Update later with `copilot plugin update ai-cost-drilldown`; remove with `copilot plugin uninstall ai-cost-drilldown`.

### Use it

Type this at Copilot's prompt (with extensions on; otherwise use the longer `/ai-cost-drilldown:cost` form of each):

```
/cost                       all sessions, last 7 days, one row per session
/cost prompts               the most expensive prompts across sessions, with session and prompt number
/cost session               this session, last 20 prompts
/cost prompt 12             prompt 12 of this session (add: calls, or: call 5)
/cost prompt a05dcb09 428   one prompt of any session, without switching to it
/cost epics                 cost per Jira epic
/cost advise                where spend can be cut
/cost help                  every option
```

A plugin's own skill always carries the plugin's name, so the skill is `/ai-cost-drilldown:cost`. A bare **`/cost`** also
works when extensions are on (it comes from the plugin's extension), and in prompt mode (`copilot -p "/cost …"`). The full list
of commands is in the [README](README.md).

### Check that it works

1. Run `/ai-cost-drilldown:cost help`. You should see the command list immediately.
2. Check it was free: the hook answers before any model call, so those runs never appear as prompts. If a later
   report lists a `/ai-cost-drilldown:cost` prompt with credits, the hook did not run and Copilot used the fallback skill
   (see Troubleshooting).

### The extension: bare `/cost` and per-call tokens (included)

The plugin ships a Copilot CLI **extension** (`extensions/ai-cost/`) that Copilot loads together with the plugin. It does two
things. It answers a bare **`/cost`** (same reports, same options, answered in-process: no hook, no spinner, no AI credits). And it
records per-call tokens: Copilot's session log has credits but not tokens, so without a token log the token figures are
`~`estimates, and the detailed views (`prompt N calls`, `call K`, the token split, the token-level `advise` findings) need it. Check:

1. Enable extensions, which are experimental: start `copilot --experimental`, or run `/experimental on` once.
2. Start a new Copilot session and run `/tokenlog`. It prints the log path and how many model calls this session has
   recorded (0 until your first prompt).

It records one line per model call (model, main agent or subagent, input including cache reads and writes, output,
reasoning, premium quota left) to `~/.ai-cost-drilldown/copilot-tokens.jsonl` (`AI_COST_TOKEN_LOG` or `AI_COST_HOME`
change that); about 250 bytes per call. Only calls made while it is loaded are recorded; earlier prompts keep their
`~`estimates. The same extension works with `--plugin-dir`.

Extensions are experimental. Without `/experimental on` there is no bare `/cost` and no token log, but
`/ai-cost-drilldown:cost` still works (the hook answers it) with `~`estimated tokens.

**Do not install it twice.** The logger is also a standalone folder you can copy to `~/.copilot/extensions/`
(`node bin/install-extension.js`, or `bin/install.js --user-extension`). That is a fallback for a Copilot that does not
load plugin extensions; next to the plugin it records every call twice (the reports count each call once, so nothing
breaks, but the log grows twice as fast). If you installed that copy earlier, remove it with
`node bin/install-extension.js --uninstall`. If the PhantomFlow cost extension is also installed, it logs the same events
to its own file; the reports read both and count each call once.

## VS Code chat

`/cost` and the cost tips also work in VS Code's Copilot Chat, through a chat hook:

```bash
node ~/ai-cost-drilldown/bin/vscode-hook.js              # add or refresh the hook
node ~/ai-cost-drilldown/bin/vscode-hook.js --uninstall  # remove it
```

The installer adds it by default when VS Code is installed (`--no-vscode-hook` skips it). Then open a **new** chat and send `/cost` (any `/cost …` command works).

- **Reports open in an editor tab.** The hook builds the report, saves it under `~/.ai-cost-drilldown/reports/`
  (reports older than a day are cleared), opens it, and stops the prompt: no model call, no AI credits. The chat
  itself shows no reply, because VS Code never displays what a hook answers. If the tab cannot be opened, the
  model is asked to say where the file is (one small model call).
- **Cost tips** appear above an answer, as in the CLI. `/cost coach off` and `/cost coach on` switch them; the
  model confirms in one line (one small model call). The switch is shared with the CLI.
- **How it is registered.** One file, `~/.copilot/hooks/ai-cost-drilldown.json`, which VS Code reads for every
  workspace. It runs `node <folder>/bin/cost.js hook --vscode` on each prompt, where `<folder>` is the installed
  plugin if there is one, else the clone you ran the command from (`--root <folder>` picks another). No VS Code
  setting is changed. Copilot CLI reads the same folder; there the hook recognises the CLI and does nothing,
  because the plugin's own hook answers.
- It applies to agent chats. Measured on VS Code 1.139; hooks there are new, so a VS Code update may change it.
  `chat.useHooks` must not be switched off.

## VS Code tasks

VS Code's chat cannot run Copilot CLI commands, so the reports are available there as tasks: **Command Palette → Tasks:
Run Task → "AI cost: …"**. They run this repo's scripts in a terminal: no model call, no credits.

```bash
node ~/ai-cost-drilldown/bin/vscode-tasks.js              # add or refresh them in VS Code's user tasks.json
node ~/ai-cost-drilldown/bin/vscode-tasks.js --uninstall  # remove them
```

The installer adds them by default when VS Code is installed (`--no-vscode-tasks` skips them). `--file <path>` targets another `tasks.json` (a project's `.vscode/tasks.json`,
to share them through git), `--root <path>` says where the scripts are.

| Task | Shows |
|---|---|
| AI cost: latest session | the most recent Copilot CLI session, per prompt |
| AI cost: sessions | recent sessions |
| AI cost: prompts | prompts across sessions; pick a window and a view: top, by source (CLI vs VS Code chat), VS Code chat only, by skill, repo, day, session, model |
| AI cost: epics | cost per Jira epic, per ticket, or the prompts tied to no ticket |
| AI cost: advise | where spend can be cut |
| AI cost: tools | which tool calls drive context cost |
| AI cost: Claude Code | the Claude Code report: latest session, recent sessions, by project, by day, per epic |

### How the tasks are registered

VS Code has no install step for tasks: it lists whatever is in a `tasks.json`. The user-level one applies to every
workspace (macOS: `~/Library/Application Support/Code/User/tasks.json`; Windows: `%APPDATA%\Code\User\tasks.json`; Linux:
`~/.config/Code/User/tasks.json`); a project can have its own at `.vscode/tasks.json`. The script writes entries like this
one into it; VS Code reads the file when you open Run Task, so a restart is not normally needed:

```json
{
  "label": "AI cost: prompts",
  "type": "shell",
  "command": "node \"/path/to/ai-cost-drilldown/bin/cost.js\" prompts --since ${input:aiCostSince} ${input:aiCostPromptsView}"
}
```

`label` is the name under Run Task. `command` is an ordinary shell command that VS Code runs in a terminal panel, so a task
is the same as typing that `node …` line yourself. Each `${input:…}` refers to an entry in the file's `inputs` list (ids
starting `aiCost`): VS Code shows a pick list (time window; view) and pastes the choice into the command.

Only tasks labelled "AI cost: …" and their inputs are replaced; your other tasks stay, a `tasks.json.bak` is kept, and a file
that cannot be parsed is left untouched (the rewrite drops comments, which survive in the backup). The tasks hold the path
of the scripts: the installed plugin when the installer adds them, else the clone. Run the command again after moving the clone.

## Claude Code report

Run it from inside Claude Code with the `!` prefix, which executes the command directly without the model:

```
! node ~/ai-cost-drilldown/bin/claude-cost.js                           this session, last 20 prompts
! node ~/ai-cost-drilldown/bin/claude-cost.js --prompts --since 30d     across sessions
! node ~/ai-cost-drilldown/bin/claude-cost.js --epics                   cost per Jira epic
! node ~/ai-cost-drilldown/bin/claude-cost.js --help
```

To type less in a terminal, add a shell alias, e.g. `alias claude-cost='node ~/ai-cost-drilldown/bin/claude-cost.js'`.
`package.json` also declares `claude-cost` and `copilot-cost` commands; `npx --package <clone> claude-cost --help` works,
`npm install -g .` is not tested.

Skill commands such as `/backlog FOPTS-123` count as their own prompts when their names are known. By default
the names are read from `~/.phantomflow/skills/`. For other skills, point `AI_COST_SKILLS_DIR` at folders holding
`name.md` or `name/SKILL.md` (separated like `PATH`):

```bash
export AI_COST_SKILLS_DIR="$HOME/.claude/skills:$HOME/my-skills"
```

## Configuration

All optional.

| Variable | Default | Meaning |
|---|---|---|
| `AI_COST_HOME` | `~/.ai-cost-drilldown` | where the report caches go (disposable; delete to rebuild) |
| `AI_COST_TOKEN_LOG` | `~/.ai-cost-drilldown/copilot-tokens.jsonl`, then the PhantomFlow log | the per-call token log (written by the logger, read by the reports) |
| `AI_COST_SKILLS_DIR` | `~/.phantomflow/skills` | skill names that count as prompts (Claude report) |
| `COPILOT_HOME` | `~/.copilot` | where Copilot's session logs are |
| `AI_COST_VSCODE_DIR` | VS Code's `User` folder for this OS (`Code` and `Code - Insiders`) | where VS Code Copilot Chat sessions are read from (a `PATH`-style list) |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | where Claude Code's transcripts are |
| `AI_COST_COACH` | on (or `/cost coach off`) | `0` or `off` switches the cost tips off |
| `AI_COST_COACH_STRICT` | on (or `/cost coach strict off`) | `0` or `off` lets thin prompts run with a tip instead of holding them back (Copilot CLI) |
| `AI_COST_COACH_REWRITE` | off (or `/cost coach strict model on`) | `1` or `on` adds a model-written rewrite to the strict-mode banner |
| `AI_COST_REWRITE_MODEL` | `gpt-5-mini` | the model that writes the suggestions |
| `AI_COST_NO_OPEN` | unset | set to keep VS Code chat reports from opening an editor tab (they are still saved) |
| `COLUMNS` | detected, else 140 | table width in a terminal (also `--width N`) |

The older names `COPILOT_COST_HOME`, `COPILOT_COST_TOKEN_LOG` and `PHANTOMFLOW_SKILLS_DIR` still work.

### Keeping prices current

Dollar figures for Copilot use GitHub's published token prices, stored in `lib/copilot-prices.json` (copied from
the [models and pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing) page;
its `fetched` date says how current it is). When GitHub changes a price or adds a model, edit that file. A model
without an entry is marked unpriced in the reports.

## Try it in a sandbox

Copilot keeps all its configuration and state under `COPILOT_HOME`, so you can test the whole install without touching
your real setup. Everything below lives in a throwaway folder; sign-in is shared, so it needs no login.

```bash
export SB=$(mktemp -d)
export COPILOT_HOME=$SB/copilot AI_COST_HOME=$SB/data      # in this shell only
mkdir $SB/work && cd $SB/work                              # an empty folder to run in
node ~/ai-cost-drilldown/bin/install.js --yes --source ~/ai-cost-drilldown
copilot --experimental                                     # answer "Yes" to the folder-trust dialog, then try the commands
```

Close the shell (or `unset COPILOT_HOME AI_COST_HOME`) and delete `$SB` when done. The sandbox starts with no
sessions, so the reports are empty until you run a prompt in it; a Haiku prompt costs about a credit.

## Updating and removing

```bash
cd ~/ai-cost-drilldown && git pull          # for --plugin-dir and the Claude report
copilot plugin update ai-cost-drilldown     # if installed with `copilot plugin install`
```

To remove everything: uninstall the plugin (or stop using `--plugin-dir`), delete the clone, and delete
`~/.ai-cost-drilldown/`.

## Using it next to PhantomFlow

Current PhantomFlow no longer ships its own `/cost`, extensions or VS Code cost tasks: they moved here. Two leftovers
from older PhantomFlow installs are worth checking:

- **`~/.copilot/extensions/phantomflow-cost`**. It also registers a bare `/cost`. Tested with both loaded: there is no
  error and no double answer, but **the old extension answers** and this plugin's `/cost` is shadowed. Remove that folder
  (the PhantomFlow installer flags it).
- **`~/.phantomflow/logs/copilot-tokens.jsonl`**, the token log the old extension wrote. Keep it: the reports read it
  together with this plugin's log and count each call once, so older prompts keep their exact tokens.

PhantomFlow's `/stats` skill and its `claude-cost.js` use the same report code and can stay.

## Troubleshooting

**`Unknown command: /cost`.** A bare `/cost` comes from the plugin's extension, which needs experimental mode: run `/experimental on`
(or start `copilot --experimental`) and open a new session. Meanwhile the full `/ai-cost-drilldown:cost` always works. Check the
plugin is loaded: start Copilot with `--plugin-dir`, or run `copilot plugin list`.

**The plugin loads but `/ai-cost-drilldown:cost` is unknown.** `plugin.json` must sit at the repository root. A manifest
under `.github/plugin/` loaded the hook but not the skill.

**The report took credits, or Copilot's model answered instead.** The hook did not run, so the fallback skill asked
the model to run the script. Check that `node` is on the `PATH` Copilot sees (`node --version` in the same terminal),
and that the hook output is not an error (`node bin/cost.js hook` with a prompt on stdin prints nothing for prompts that
are not `/cost`). On Windows the hook runs through PowerShell; that path is not yet tested.

**VS Code chat requests are missing, or show no credits.** They are read from VS Code's `User` folder
(`workspaceStorage/*/chatSessions/` and `globalStorage/emptyWindowChatSessions/`); set `AI_COST_VSCODE_DIR` if yours is elsewhere
(a portable or remote install). VS Code recorded credits per request only from mid-July 2026: older requests show tokens and `?` for
credits. `--source cli` leaves VS Code out.

**The first run is slow.** It reads every session log and builds a cache in `~/.ai-cost-drilldown/cache/`, which can take
several seconds with many sessions. Later runs reuse it.

**Token numbers start with `~`.** There is no per-call token log for that prompt (it ran before the logger was loaded, or the
logger is not loaded). Check `/tokenlog`, and that extensions are on (`/experimental on` or `--experimental`); see "The extension" above.

**Claude Code: a skill command is missing from the prompts.** Its name is not in the skills folders; set
`AI_COST_SKILLS_DIR`.

**Output looks like raw `| --- |` tables.** You are viewing markdown as plain text. In a terminal, `bin/cost.js` and
`bin/claude-cost.js` print box tables by default; pass `--md` only when you want the raw markdown.
