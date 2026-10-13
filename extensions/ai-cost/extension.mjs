// ai-cost — the Copilot CLI extension of the ai-cost-drilldown plugin.
//
//   /cost ...      the cost reports, answered in this process: no model call, no AI credits, no hook, no spinner
//                  (/cost help lists everything; it is the same report code as /ai-cost-drilldown:cost)
//   /tokenlog      where the per-call token log is, and how many calls this session has recorded
//
// It also records the tokens of every model call. Copilot's session log has credits per prompt but no tokens;
// the live `assistant.usage` event has them for every model call (main agent and subagents), so this appends one
// JSON line per call to ~/.ai-cost-drilldown/copilot-tokens.jsonl (AI_COST_TOKEN_LOG / AI_COST_HOME change that).
// The reports read it for the token split, `prompt N calls`, `call K` and the token-level advice; without it
// they show ~estimates.
//
// It ships inside the plugin and Copilot CLI loads it when the plugin is installed. Extensions are experimental:
// start `copilot --experimental` or run `/experimental on`. (`node bin/install-extension.js` copies it to the user
// extensions folder instead, for a Copilot that does not load plugin extensions; that copy only logs.)
// Never lets a logging failure touch the session.
import { joinSession } from "@github/copilot-sdk/extension";
import fs from "node:fs";
import path from "node:path";
import { logPath, toRecord } from "./record.mjs";
import { answer, loadReports } from "./cost-command.mjs";

const file = logPath();
const reports = loadReports();
let written = 0;

function status() {
    let size = "no file yet";
    try { size = `${(fs.statSync(file).size / 1024).toFixed(1)} KB`; } catch { /* not written yet */ }
    return `Token log: ${file} (${size}). ${written} model call${written === 1 ? "" : "s"} recorded in this session.`
        + (reports ? "" : " (/cost is not available: this copy has no report code; use the plugin's /ai-cost-drilldown:cost.)");
}

const commands = [
    {
        name: "tokenlog",
        description: "Where the per-call token log is and how many calls it has recorded this session",
        handler: async () => {
            try {
                await session.log(status(), { level: "info" });
            } catch {
                // never fail the session
            }
        },
    },
];

// Only offer /cost where the report code is present, so a copy without it does not shadow another /cost.
if (reports) {
    commands.unshift({
        name: "cost",
        description: "AI credits, dollars, tokens and tool calls per prompt, epic and model call; /cost help for options",
        handler: async (ctx) => {
            const { text, level } = await answer(ctx?.args, ctx?.sessionId ?? session.sessionId, reports);
            try {
                await session.log(text, { level });
            } catch {
                // never fail the session
            }
        },
    });
}

const session = await joinSession({ commands });

session.on("assistant.usage", (ev) => {
    try {
        const record = toRecord(ev, session.sessionId);
        if (!record) return;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(record) + "\n");
        written++;
    } catch {
        // best effort only
    }
});
