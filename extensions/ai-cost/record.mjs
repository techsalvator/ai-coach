// Pure helpers of the token logger: where the log goes and what one record holds.
// Kept apart from extension.mjs (which needs the Copilot SDK) so they can be tested.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The log file. Same rules as lib/paths.js in the repo: an explicit file wins, else the data dir. */
export function logPath(env = process.env, home = os.homedir()) {
    const explicit = env.AI_COST_TOKEN_LOG || env.COPILOT_COST_TOKEN_LOG;
    if (explicit) return explicit;
    const base = env.AI_COST_HOME || env.COPILOT_COST_HOME || path.join(home, ".ai-cost-drilldown");
    return path.join(base, "copilot-tokens.jsonl");
}

/**
 * One `assistant.usage` event as a log record, or null if it is not a model call.
 * The shape is what the report code reads (lib/session-cost.js readTokenLog) and what the
 * PhantomFlow extension writes, so the two logs can be read together.
 */
export function toRecord(ev, sessionId, now = () => new Date().toISOString()) {
    const d = ev?.data ?? {};
    if (d.model == null && d.inputTokens == null) return null;
    const premium = d.quotaSnapshots?.premium_interactions;
    return {
        ts: ev.timestamp ?? now(),
        session: sessionId,
        agent: ev.agentId ?? null,
        sub: Boolean(ev.agentId) || d.initiator === "sub-agent",
        model: d.model,
        input: d.inputTokens ?? 0,          // the whole prompt, cache reads and writes included
        output: d.outputTokens ?? 0,
        cacheRead: d.cacheReadTokens ?? 0,
        cacheWrite: d.cacheWriteTokens ?? 0,
        reasoning: d.reasoningTokens ?? 0,
        ms: d.duration ?? null,
        premiumLeftPct: premium?.remainingPercentage ?? null,
        premiumResets: premium?.resetDate ?? null,
    };
}

/** Where a session's last main-agent call is kept: one small file per session, beside the log's data dir. */
export function lastCallPath(sessionId, env = process.env, home = os.homedir()) {
    const base = env.AI_COST_HOME || env.COPILOT_COST_HOME || path.join(home, ".ai-cost-drilldown");
    return path.join(base, "last-call", `${String(sessionId).replace(/[^\w.-]/g, "_")}.json`);
}

/**
 * Keeps the session's last main-agent call where the hook finds it without reading the shared log: that log is read
 * from its end, and with several busy sessions one session's last call can be further back than the hook looks.
 * Subagent calls are skipped (their context is not the session's). Files of sessions idle for 30 days are removed.
 */
export function writeLastCall(record, env = process.env, home = os.homedir(), now = Date.now()) {
    if (!record || record.sub || !record.session) return null;
    const file = lastCallPath(record.session, env, home);
    const dir = path.dirname(file);
    const fresh = !fs.existsSync(dir) || !fs.existsSync(file);
    fs.mkdirSync(dir, { recursive: true });
    if (fresh) { // a session's first call: a good moment to clear out old sessions
        for (const f of fs.readdirSync(dir)) {
            try { if (now - fs.statSync(path.join(dir, f)).mtimeMs > 30 * 864e5) fs.unlinkSync(path.join(dir, f)); } catch { /* in use */ }
        }
    }
    fs.writeFileSync(file, JSON.stringify(record));
    return file;
}
