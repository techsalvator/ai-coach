'use strict';
/**
 * emissions — a rough CO2e estimate for AI usage, from token counts.
 *
 * Energy per model call = output tokens * Wh-per-output-token for the model's size class, plus input tokens at a
 * fraction of that (cache reads far less); times data-centre PUE and grid intensity. The factors are public-estimate
 * assumptions (emissions-factors.json), not GreenPixie or any vendor's measured data, and are good to an order of
 * magnitude at best. Read it as a way to compare prompts and models, not as a footprint to report.
 */

const F = (() => { try { return require('./emissions-factors.json'); } catch { return null; } })();

/** Size class by model name; unknown models count as medium and are flagged as a guess by `classOf().guess`. */
function classOf(model) {
  const m = String(model || '').toLowerCase();
  if (/haiku|mini|flash|nano|lite/.test(m)) return { name: 'small', guess: false };
  if (/opus/.test(m)) return { name: 'large', guess: false };
  if (/sonnet|gpt|claude|gemini|o\d/.test(m)) return { name: 'medium', guess: false };
  return { name: 'medium', guess: true };
}

/** Grams CO2e for one model call. `c` is a call row: fresh/cacheRead/cacheWrite/tokensOut (Claude) or tokensIn/tokensOut. */
function callGrams(c, model = c && c.model, f = F) {
  if (!f || !c) return null;
  const cls = f.classes[classOf(model).name];
  const rel = f.inputRelativeToOutput;
  const hasSplit = c.fresh != null || c.cacheRead != null || c.cacheWrite != null;
  const fresh = hasSplit ? c.fresh || 0 : c.tokensIn || 0;
  const wh = cls.whPerOutputToken * ((c.tokensOut || 0) + fresh * rel.fresh + (c.cacheRead || 0) * rel.cacheRead + (c.cacheWrite || 0) * rel.cacheWrite);
  return wh * f.pue * f.gridGramsPerKWh / 1000;
}

/** A prompt: its calls when it has them, else its totals on its first model. */
function promptGrams(p, f = F) {
  if (!f || !p) return null;
  if (p.calls && p.calls.length) return p.calls.reduce((a, c) => a + callGrams(c, c.model, f), 0);
  if (p.tokensIn == null && p.tokensOut == null) return null;
  return callGrams({ tokensIn: p.tokensIn, tokensOut: p.tokensOut }, (p.models || [])[0], f);
}

function sessionGrams(s, f = F) {
  if (!f || !s) return null;
  return s.prompts.reduce((a, p) => a + (promptGrams(p, f) || 0), 0);
}

/** "0.42 g", "12.3 g", "1.20 kg". */
function format(g) {
  if (g == null) return '—';
  if (g >= 1000) return `${(g / 1000).toFixed(2)} kg`;
  return `${g.toFixed(g < 10 ? 2 : 1)} g`;
}

module.exports = { callGrams, promptGrams, sessionGrams, classOf, format, FACTORS: F };
