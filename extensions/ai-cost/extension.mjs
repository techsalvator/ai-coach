// ai-cost — the Copilot CLI token logger of the ai-cost-coach VS Code extension.
//
//   /tokenlog      where the per-call token log is, and how many calls this session has recorded
//   /cost ...      the cost reports, when the report code sits next to this file (not in the copy the VS Code extension
//                  installs: the reports are in VS Code's AI Cost view)
//
// It also records the tokens of every model call. Copilot's session log has credits per prompt but no tokens;
// the live `assistant.usage` event has them for every model call (main agent and subagents), so this appends one
// JSON line per call to ~/.ai-cost-coach/copilot-tokens.jsonl (AI_COST_TOKEN_LOG / AI_COST_HOME change that).
// The reports read it for the token split, `prompt N calls`, `call K` and the token-level advice; without it
// they show ~estimates.
//
// The VS Code extension's "Set Up Copilot Tracking" copies it to ~/.copilot/extensions/ai-cost/. Extensions are
// experimental in Copilot CLI: start `copilot --experimental` or run `/experimental on` once.
// Never lets a logging failure touch the session.
import { joinSession } from "@github/copilot-sdk/extension";
import fs from "node:fs";
import path from "node:path";
import { logPath, toRecord, writeLastCall } from "./record.mjs";
import { answer, loadReports } from "./cost-command.mjs";

const file = logPath();
const reports = loadReports();
let written = 0;

function status() {
    let size = "no file yet";
    try { size = `${(fs.statSync(file).size / 1024).toFixed(1)} KB`; } catch { /* not written yet */ }
    return `Token log: ${file} (${size}). ${written} model call${written === 1 ? "" : "s"} recorded in this session.`
        + (reports ? "" : " (/cost is not available: this copy only logs; the reports are in VS Code's AI Cost view.)");
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
        writeLastCall(record); // what the hook reads to price the next prompt
    } catch {
        // best effort only
    }
});
