'use strict';
/**
 * emissions — a rough CO2e estimate for AI usage, from token counts.
 *
 * Electricity (Wh) per model call = output tokens * Wh-per-output-token for the model's size class, plus input tokens at a
 * fraction of that (cache reads far less); times data-centre PUE and grid intensity. The factors are public-estimate
 * assumptions (emissions-factors.json), not GreenPixie or any vendor's measured data, and are good to an order of
 * magnitude at best. Water is facility energy times a litres-per-kWh figure, so it follows electricity. Read it as a way to compare prompts and models, not as a footprint to report.
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

/** Electricity (Wh, facility level), CO2e (g) and water (mL) for one model call. `c` is a call row:
 *  fresh/cacheRead/cacheWrite/tokensOut (Claude) or tokensIn/tokensOut. */
function callImpact(c, model = c && c.model, f = F) {
  if (!f || !c) return null;
  const cls = f.classes[classOf(model).name];
  const rel = f.inputRelativeToOutput;
  const hasSplit = c.fresh != null || c.cacheRead != null || c.cacheWrite != null;
  const fresh = hasSplit ? c.fresh || 0 : c.tokensIn || 0;
  const wh = cls.whPerOutputToken * ((c.tokensOut || 0) + fresh * rel.fresh + (c.cacheRead || 0) * rel.cacheRead + (c.cacheWrite || 0) * rel.cacheWrite) * f.pue;
  const cn = classOf(model).name;
  const tok = { out: c.tokensOut || 0, fresh, cacheRead: c.cacheRead || 0, cacheWrite: c.cacheWrite || 0 };
  // `basis` is what the figures were worked from: raw tokens, and the output-token equivalent per size class.
  const eq = tok.out + fresh * rel.fresh + tok.cacheRead * rel.cacheRead + tok.cacheWrite * rel.cacheWrite;
  return { wh, g: wh * f.gridGramsPerKWh / 1000, ml: wh * f.waterLitresPerKWh, basis: { tok, eq: { [cn]: eq }, calls: 1 } };
}
const ZERO = () => ({ wh: 0, g: 0, ml: 0, basis: { tok: { out: 0, fresh: 0, cacheRead: 0, cacheWrite: 0 }, eq: {}, calls: 0 } });
const add = (a, b) => {
  if (!b) return a;
  a.wh += b.wh; a.g += b.g; a.ml += b.ml;
  for (const k of Object.keys(a.basis.tok)) a.basis.tok[k] += b.basis.tok[k];
  for (const [k, v] of Object.entries(b.basis.eq)) a.basis.eq[k] = (a.basis.eq[k] || 0) + v;
  a.basis.calls += b.basis.calls;
  return a;
};

const n0 = (n) => Math.round(n).toLocaleString('en-US');
const sig = (n) => (n >= 100 ? n0(n) : String(+n.toPrecision(3)));

/** How each of the three figures was worked out, with the actual numbers behind `i` (an impact from the functions
 *  above): [{ key, label, text }] for CO2e, electricity and water. Plain text, no markup. */
function explain(i, f = F) {
  if (!f || !i || !i.basis) return null;
  const { tok, eq, calls } = i.basis;
  const classes = Object.keys(eq).filter((k) => eq[k] > 0);
  const rel = f.inputRelativeToOutput;
  const tokens = `${n0(tok.out)} output + ${n0(tok.fresh)} fresh input x ${rel.fresh} + ${n0(tok.cacheRead)} cache read x ${rel.cacheRead} + ${n0(tok.cacheWrite)} cache write x ${rel.cacheWrite}`;
  const perClass = classes.map((k) => `${n0(eq[k])} ${k}-model tokens x ${f.classes[k].whPerOutputToken} Wh`).join(' + ') || 'no tokens';
  const kwh = i.wh / 1000;
  return [
    { key: 'electricity', label: 'Electricity', text: `From ${n0(calls)} model call${calls === 1 ? '' : 's'}: ${tokens} = ${perClass} = ${sig(i.wh / f.pue)} Wh at the chip, x ${f.pue} data-centre overhead (PUE) = ${sig(i.wh)} Wh.` },
    { key: 'co2e', label: 'CO₂e', text: `${sig(i.wh)} Wh = ${sig(kwh)} kWh x ${f.gridGramsPerKWh} g CO₂e per kWh (global average grid) = ${sig(i.g)} g.` },
    { key: 'water', label: 'Water', text: `${sig(i.wh)} Wh = ${sig(kwh)} kWh x ${f.waterLitresPerKWh} L per kWh (data-centre cooling) = ${sig(i.ml)} mL.` },
  ];
}

/** A prompt: its calls when it has them, else its totals on its first model. */
function promptImpact(p, f = F) {
  if (!f || !p) return null;
  if (p.calls && p.calls.length) return p.calls.reduce((a, c) => add(a, callImpact(c, c.model, f)), ZERO());
  if (p.tokensIn == null && p.tokensOut == null) return null;
  return callImpact({ tokensIn: p.tokensIn, tokensOut: p.tokensOut }, (p.models || [])[0], f);
}

function sessionImpact(s, f = F) {
  if (!f || !s) return null;
  return s.prompts.reduce((a, p) => add(a, promptImpact(p, f)), ZERO());
}

/** Several sessions as one. */
function totalImpact(sessions, f = F) {
  if (!f) return null;
  return sessions.reduce((a, s) => add(a, sessionImpact(s, f)), ZERO());
}

// CO2e-only forms, kept for callers that want just grams.
const grams = (i) => (i ? i.g : null);
const callGrams = (c, model, f) => grams(callImpact(c, model, f));
const promptGrams = (p, f) => grams(promptImpact(p, f));
const sessionGrams = (s, f) => grams(sessionImpact(s, f));

/** "0.42 g", "12.3 g", "1.20 kg". */
function format(g) {
  if (g == null) return '—';
  if (g >= 1000) return `${(g / 1000).toFixed(2)} kg`;
  return `${g.toFixed(g < 10 ? 2 : 1)} g`;
}

/** "0.8 Wh", "12 Wh", "1.20 kWh". */
function formatWh(wh) {
  if (wh == null) return '—';
  if (wh >= 1000) return `${(wh / 1000).toFixed(2)} kWh`;
  return `${wh.toFixed(wh < 10 ? 2 : 1)} Wh`;
}

/** "0.7 mL", "35 mL", "1.20 L". */
function formatMl(ml) {
  if (ml == null) return '—';
  if (ml >= 1000) return `${(ml / 1000).toFixed(2)} L`;
  return `${ml.toFixed(ml < 10 ? 2 : 1)} mL`;
}

module.exports = { explain, callImpact, promptImpact, sessionImpact, totalImpact, callGrams, promptGrams, sessionGrams, classOf, format, formatWh, formatMl, FACTORS: F };
