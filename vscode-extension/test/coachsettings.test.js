'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CS = require('../coachsettings');
const { read, write } = CS;

const home = () => ({ AI_COST_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'aicost-cfg-')) });
const on = (env, key) => read(env).find((s) => s.key === key);

test('defaults: coach, strict and the model guard on, strict model off', () => {
  const env = home();
  assert.deepStrictEqual(read(env).map((s) => [s.key, s.on]), [['coach', true], ['strict', true], ['expiry', true], ['rewrite', false], ['guard', true]]);
});

test('writes go to config.json, where the hooks read them', () => {
  const env = home();
  write('strict', false, env);
  write('rewrite', true, env);
  const cfg = JSON.parse(fs.readFileSync(path.join(env.AI_COST_HOME, 'config.json'), 'utf8'));
  assert.deepStrictEqual(cfg, { strict: false, rewrite: true });
  assert.strictEqual(on(env, 'strict').on, false);
  assert.strictEqual(on(env, 'rewrite').on, true);
});

test('a switch is idle when the one it depends on is off', () => {
  const env = home();
  write('coach', false, env);
  assert.strictEqual(on(env, 'strict').idle, true);
  assert.strictEqual(on(env, 'coach').idle, false);
});

test('an environment variable wins and marks the switch locked', () => {
  const env = { ...home(), AI_COST_COACH: 'off' };
  assert.strictEqual(on(env, 'coach').on, false);
  assert.strictEqual(on(env, 'coach').locked, true);
});

test('limits: read with their defaults, written to config.json, and put back', () => {
  const env = home();
  assert.deepStrictEqual(CS.readLimits(env).map((l) => [l.key, l.value, l.isDefault]), [['costGateUsd', 0.5, true], ['longContextTokens', 150000, true], ['longSession', 21, true], ['dailyPremium', 0, true], ['bigPaste', 12000, true], ['modelGuardRequests', 2, true]]);
  CS.writeLimit('costGateUsd', 1.25, env);
  const l = CS.readLimits(env)[0];
  assert.deepStrictEqual([l.value, l.isDefault, l.format(l.value)], [1.25, false, '$1.25']);
  assert.throws(() => CS.writeLimit('costGateUsd', 'lots', env), /positive number/);
  CS.writeLimit('costGateUsd', null, env);
  assert.strictEqual(CS.readLimits(env)[0].isDefault, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(env.AI_COST_HOME, 'config.json'), 'utf8')).costGateUsd, undefined);
});

test('pause: set for some minutes, read, and resumed', () => {
  const env = home();
  const now = Date.parse('2026-10-06T12:00:00Z');
  assert.deepStrictEqual(CS.readPause(env, now), { until: 0, active: false });
  CS.writePause(60, env, now);
  assert.deepStrictEqual(CS.readPause(env, now + 1000), { until: now + 3600e3, active: true });
  assert.strictEqual(CS.readPause(env, now + 2 * 3600e3).active, false);
  CS.writePause(null, env, now);
  assert.strictEqual(CS.readPause(env, now).active, false);
});

test('results come from the coach log, over a window', () => {
  const env = home();
  fs.mkdirSync(env.AI_COST_HOME, { recursive: true });
  const line = (ts, event, id, avoidUsd) => JSON.stringify({ ts, event, id, session: 's', avoidUsd });
  fs.writeFileSync(path.join(env.AI_COST_HOME, 'coach-log.jsonl'), [
    line('2026-09-01T10:00:00Z', 'held', 'repeat'), line('2026-10-05T10:00:00Z', 'held', 'cost-gate'), line('2026-10-05T10:01:00Z', 'reworded', 'cost-gate', 0.7),
    line('2026-10-05T11:00:00Z', 'tip', 'long-session'),
  ].join('\n'));
  const now = Date.parse('2026-10-06T00:00:00Z');
  const r = CS.readResults(env, 30, now);
  assert.deepStrictEqual([r.total.held, r.total.reworded, r.total.tips], [1, 1, 1], 'the September line is outside 30 days');
  assert.strictEqual(r.byId['cost-gate'].avoidedUsd, 0.7);
  assert.strictEqual(CS.readResults(env, 90, now).total.held, 2);
});

test('the model guard switch is on by default, saved with the others, and the environment can decide it', () => {
  const env = home();
  assert.strictEqual(on(env, 'guard').on, true);
  assert.strictEqual(on(env, 'guard').idle, false, 'it needs nothing else to be on');
  write('guard', false, env);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(env.AI_COST_HOME, 'config.json'), 'utf8')), { modelGuard: false });
  assert.strictEqual(on(env, 'guard').on, false);
  const forced = { ...home(), AI_COST_MODEL_GUARD: 'off' };
  assert.deepStrictEqual([on(forced, 'guard').on, on(forced, 'guard').locked], [false, true]);
  CS.writeLimit('modelGuardRequests', 3, env);
  assert.strictEqual(CS.readLimits(env).find((l) => l.key === 'modelGuardRequests').value, 3);
  assert.throws(() => CS.writeLimit('modelGuardRequests', 'many', env), /positive number/);
});
