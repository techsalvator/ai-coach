// The /cost command of the ai-cost extension, apart from the Copilot SDK so it can be tested.
//
// It runs the same report code as the plugin's hook (bin/cost.js) inside the extension process. That code sits at
// ../../bin/cost.js relative to this file when the extension ships inside the plugin; a copy made into
// ~/.copilot/extensions/ has no bin/ next to it, so there the command is unavailable (the logger still works).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** The report code, or null when this copy of the extension has no bin/ beside it. */
export function loadReports() {
    try {
        return require("../../bin/cost.js");
    } catch {
        return null;
    }
}

/**
 * The answer to "/cost <text>": {text, level}. reports: what loadReports() returned.
 * Never throws: a bad argument becomes a warning that carries the help text.
 */
export async function answer(argText, sessionId, reports = loadReports()) {
    if (!reports) {
        return { text: "/cost: the report code is not next to this extension (it was copied out of the plugin). "
            + "Install the plugin, or use /ai-cost-drilldown:cost.", level: "warning" };
    }
    try {
        return { text: String(await reports.cost(reports.splitArgs(argText), sessionId || null)), level: "info" };
    } catch (err) {
        const known = err && (err.usage || err.constructor?.name === "UsageError");
        return { text: `/cost: ${known ? err.message : err.stack}\n\n${reports.HELP}`, level: "warning" };
    }
}
