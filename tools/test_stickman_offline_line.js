/* 离线小说线（引擎 + 火柴人）回归：无头跑完整局，并校验「文本 → 动作」始终落在动作库内
 * 运行：node tools/test_stickman_offline_line.js
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function makeCtx() {
  const noop = () => {};
  return new Proxy({ _ops: 0, globalAlpha: 1 }, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'canvas') return null;
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
const canvas = (w, h) => ({ width: w, height: h, style: {}, parentElement: { clientWidth: w }, getContext: makeCtx, toDataURL: () => 'data:image/png;base64,AA' });

const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval, Math, Date, JSON, isNaN, parseInt, parseFloat, String, Number, Object, Array, RegExp, Error, Promise };
sandbox.window = sandbox;
sandbox.document = {
  createElement: (t) => (t === 'canvas' ? canvas(700, 140) : { style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  body: { appendChild() {}, removeChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
  head: { appendChild() {} },
};
sandbox.requestAnimationFrame = () => 1;
sandbox.cancelAnimationFrame = () => {};
sandbox.devicePixelRatio = 1;
sandbox.alert = () => {};
sandbox.ResizeObserver = undefined;
sandbox.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
vm.createContext(sandbox);

for (const f of ['app/stickman.js', 'app/stickman_actions.js', 'app/game_engine.js', 'app/packs/limitless.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const SM = sandbox.Stickman;
const SA = sandbox.StickmanActions;
const GE = sandbox.GameEngine;

console.log('\n[1] 无头跑完整局（三种选法 × 两个种子）');
let runErr = null, results = [];
try {
  for (const seed of [7, 2026]) {
    for (const picker of [null, (s, c) => c.length - 1, (s, c) => Math.floor(Math.random() * c.length)]) {
      const r = GE.simulate('limitless', seed, 260, picker);
      results.push(r.status + '/' + (r.ending || '-') + '/t' + r.turns);
      assert.ok(r.turns > 0, '回合数为 0');
    }
  }
} catch (e) { runErr = e.message + '\n' + e.stack; }
ok('6 局全部跑通无异常', runErr === null, runErr || '');
console.log('    ' + results.join('  '));
const endings = results.map((r) => r.split('/')[1]);
ok('结局可达（≥2 种）', new Set(endings).size >= 2, endings.join(','));

console.log('\n[2] 事件文本 → 动作 必须落在动作库内');
const pack = GE.packs().limitless;
const names = SM.listActions();
function collect(o, out) {
  if (!o) return out;
  if (typeof o === 'string') { if (o.length > 4) out.push(o); return out; }
  if (Array.isArray(o)) { o.forEach((x) => collect(x, out)); return out; }
  if (typeof o === 'object') Object.keys(o).forEach((k) => { if (k !== 'id' && k !== 'next' && k !== 'attr') collect(o[k], out); });
  return out;
}
const texts = [];
collect(pack.intro, texts);
(pack.stages || []).forEach((s) => { collect(s.intro, texts); });
Object.keys(pack.events || {}).forEach((k) => collect(pack.events[k], texts));
(pack.randomEvents || []).forEach((e) => collect(e, texts));
Object.values(pack.endings || {}).forEach((e) => collect(e, texts));
let badAct = [], nonIdle = 0;
for (const t of texts) {
  const a = GE.pickAction(String(t));
  if (names.indexOf(a) < 0) badAct.push(a + ' ← ' + String(t).slice(0, 18));
  if (a !== 'idle') nonIdle++;
}
ok('全部映射合法（' + texts.length + ' 段文本）', badAct.length === 0, badAct.slice(0, 5).join(' | '));
ok('文本量足够大（≥120 段）', texts.length >= 120, String(texts.length));
ok('非 idle 覆盖率 ≥ 25%（不再长期只待机）', nonIdle / Math.max(1, texts.length) >= 0.25,
  (100 * nonIdle / Math.max(1, texts.length)).toFixed(1) + '%');
const hist = {};
texts.forEach((t) => { const a = GE.pickAction(String(t)); hist[a] = (hist[a] || 0) + 1; });
const used = Object.keys(hist).filter((k) => k !== 'idle').length;
ok('覆盖 ≥ 10 种不同动作', used >= 10, used + ' 种：' + JSON.stringify(hist));

console.log('\n[3] 战斗/剧情动作名合法');
let combatBad = [];
for (const key of Object.keys(pack.characters || {})) {
  const c = pack.characters[key];
  for (const a of (c.actions || [])) if (names.indexOf(a) < 0) combatBad.push(key + ':' + a);
}
for (const a of ['guard', 'attack', 'hit', 'dodge', 'fall', 'victory', 'idle']) {
  if (names.indexOf(a) < 0) combatBad.push('引擎内建动作缺失 ' + a);
}
ok('角色动作与引擎内建动作都在库内', combatBad.length === 0, combatBad.join(','));

console.log('\n[4] AI 动作建议白名单与动作库一致');
const src = fs.readFileSync(path.join(ROOT, 'app/game_engine.js'), 'utf8');
const core = /AI_ACTIONS_CORE = \[([^\]]+)\]/.exec(src);
ok('AI_ACTIONS_CORE 存在', !!core);
if (core) {
  const listed = core[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  const unknown = listed.filter((n) => names.indexOf(n) < 0);
  ok('白名单 ' + listed.length + ' 项全部存在', unknown.length === 0, unknown.join(','));
  ok('白名单不超过 30 项（控制提示词长度）', listed.length <= 30, String(listed.length));
}
ok('提示词不再写死动作列表', !/idle\/walk\/run\/attack\/cast\/hit\/jump\/dodge\/fall\/win\/search\/talk/.test(src));

console.log('\n[5] <action:xxx> 解析');
const cases = [
  ['叙事文本<action:cast>', 'cast'],
  ['叙事文本<action:fly>', null],
  ['叙事文本<action:knockdown>', 'knockdown'],
  ['没有标签', null],
];
let parseBad = [];
for (const [txt, want] of cases) {
  const m = /<action:\s*([a-z_]+)\s*>/i.exec(txt);
  const got = m && names.indexOf(m[1].toLowerCase()) >= 0 ? m[1].toLowerCase() : null;
  if (got !== want) parseBad.push(txt + ' → ' + got + ' 期望 ' + want);
}
ok('标签解析与白名单校验', parseBad.length === 0, parseBad.join(' | '));

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
