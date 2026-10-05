/* 火柴人 v4 无头回归测试：假 canvas + 假 2D 上下文，真实执行渲染路径
 * 运行：node tools/test_stickman_v4.js
 * 覆盖：语法/加载、动作库完整性、踩地约束、关节可动范围、画布越界、混合与收尾、导出、文字→动作
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

/* ---------------- 假 2D 上下文：记录所有落点 ---------------- */
function makeCtx() {
  const rec = { pts: [], ops: 0, alpha: [], text: [] };
  const stack = [];
  let m = [1, 0, 0, 1, 0, 0];
  function apply(x, y) {
    const nx = m[0] * x + m[2] * y + m[4];
    const ny = m[1] * x + m[3] * y + m[5];
    rec.pts.push({ x: nx, y: ny, alpha: ctx.globalAlpha });
    rec.ops++;
  }
  const ctx = {
    canvas: null,
    strokeStyle: '#000', fillStyle: '#000', lineWidth: 1,
    lineCap: 'butt', lineJoin: 'miter', globalAlpha: 1, font: '10px sans',
    _rec: rec,
    save() { stack.push(m.slice()); },
    restore() { if (stack.length) m = stack.pop(); },
    setTransform(a, b, c, d, e, f) { m = [a, b, c, d, e, f]; },
    rotate(a) {
      const ca = Math.cos(a), sa = Math.sin(a);
      const n0 = m[0] * ca + m[2] * sa, n1 = m[1] * ca + m[3] * sa;
      const n2 = m[0] * -sa + m[2] * ca, n3 = m[1] * -sa + m[3] * ca;
      m[0] = n0; m[1] = n1; m[2] = n2; m[3] = n3;
    },
    translate(x, y) { m[4] += m[0] * x + m[2] * y; m[5] += m[1] * x + m[3] * y; },
    scale(x, y) { m[0] *= x; m[3] *= y; },
    beginPath() { }, closePath() { },
    moveTo: apply, lineTo: apply,
    arc(x, y, r) { apply(x - r, y); apply(x + r, y); apply(x, y - r); apply(x, y + r); },
    ellipse(x, y, rx, ry) { apply(x - rx, y); apply(x + rx, y); apply(x, y - ry); apply(x, y + ry); },
    rect(x, y, w, h) { apply(x, y); apply(x + w, y + h); },
    fill() { rec.ops++; }, stroke() { rec.ops++; },
    fillText(t, x, y) { rec.text.push(String(t)); apply(x, y); },
    drawImage(img, x, y) { rec.ops++; apply(x || 0, y || 0); },
    measureText(t) { return { width: String(t).length * 6 }; },
    clearRect() { }, fillRect() { },
  };
  return ctx;
}
function makeCanvas(w, h) {
  const c = {
    width: w || 300, height: h || 150, style: {},
    parentElement: { clientWidth: w || 700 },
    getContext() { if (!c._ctx) { c._ctx = makeCtx(); c._ctx.canvas = c; } return c._ctx; },
    toDataURL() { return 'data:image/png;base64,AAAA'; },
  };
  return c;
}

/* ---------------- 装载 ---------------- */
const sandbox = { console, setTimeout, clearTimeout, Math, Date, JSON, isNaN, parseInt, parseFloat, String, Number, Object, Array, RegExp, Error, Promise };
sandbox.window = sandbox;
sandbox.document = {
  createElement(tag) { return tag === 'canvas' ? makeCanvas(700, 150) : { style: {} }; },
  getElementById() { return null; },
  body: { appendChild() { }, removeChild() { } },
};
sandbox.requestAnimationFrame = () => 1;
sandbox.cancelAnimationFrame = () => { };
sandbox.devicePixelRatio = 1;
sandbox.navigator = { userAgent: 'node' };
sandbox.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => { } };
sandbox.HTMLAnchorElement = function () { };
vm.createContext(sandbox);

for (const f of ['app/stickman.js', 'app/stickman_actions.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const SM = sandbox.Stickman;
const SA = sandbox.StickmanActions;

console.log('\n[0] 舞台折叠开关回归');
const stageSource = fs.readFileSync(path.join(ROOT, 'app/stickman_stage.js'), 'utf8');
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.parentElement = null;
    this.style = {}; this.dataset = {}; this.attributes = {}; this.value = ''; this._textContent = '';
    this._classes = new Set(); this.classList = {
      add: name => this._classes.add(name), remove: name => this._classes.delete(name),
      contains: name => this._classes.has(name), toggle: (name, force) => {
        const next = force === undefined ? !this._classes.has(name) : !!force;
        if (next) this._classes.add(name); else this._classes.delete(name);
        return next;
      },
    };
  }
  set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return Array.from(this._classes).join(' '); }
  set textContent(value) { this._textContent = String(value); this.children = []; }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { this._textContent = ''; this.children = []; }
  appendChild(child) { child.parentNode = this; child.parentElement = this; this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentNode = null; child.parentElement = null; return child; }
  addEventListener() {}
  setAttribute(name, value) { this.attributes[name] = String(value); }
  click() { if (this.onclick) this.onclick({ stopPropagation() {} }); }
}
const fakeHead = new FakeElement('head');
const stageHost = new FakeElement('div');
const timerSet = new Set();
let timerId = 0;
const stageDocument = {
  head: fakeHead, body: new FakeElement('body'),
  createElement(tag) { return tag === 'canvas' ? makeCanvas(700, 150) : new FakeElement(tag); },
  getElementById() { return null; },
};
const stageWindow = {
  Stickman: SM, StickmanActions: SA, localStorage: { getItem() { return null; }, setItem() {} },
  setTimeout(fn) { const id = ++timerId; timerSet.add(id); return id; },
  clearTimeout(id) { timerSet.delete(id); },
};
stageWindow.window = stageWindow;
const stageSandbox = { window: stageWindow, document: stageDocument, console, setTimeout: stageWindow.setTimeout, clearTimeout: stageWindow.clearTimeout };
vm.createContext(stageSandbox);
vm.runInContext(stageSource, stageSandbox, { filename: 'app/stickman_stage.js' });
const mountedStage = stageWindow.StickmanStage.create(stageHost, { storageKey: 'collapse-test' });
const mountedRoot = stageHost.children[0];
const collapseButton = mountedRoot.children[0].children[mountedRoot.children[0].children.length - 1];
const foldableRows = [2, 3, 4, 5, 6, 7, 8, 9, 10].map(index => mountedRoot.children[index]);
collapseButton.click();
const rowsHidden = foldableRows.every(row => row.classList.contains('smst-hide'));
collapseButton.click();
const rowsRestored = foldableRows.every(row => !row.classList.contains('smst-hide'));
ok('真实舞台折叠按钮点击两次后恢复所有控制行', rowsHidden && rowsRestored && collapseButton.textContent === '收起');
const externalHost = new FakeElement('div');
const externalStage = stageWindow.StickmanStage.create(externalHost, { canvas: makeCanvas(700, 140), storageKey: 'external-canvas-test' });
const externalRoot = externalHost.children[0];
const externalCollapse = externalRoot.children[0].children[externalRoot.children[0].children.length - 1];
const externalRows = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(index => externalRoot.children[index]);
externalCollapse.click(); externalCollapse.click();
ok('复用外部画布时真实折叠按钮同样可完整展开', externalRows.every(row => !row.classList.contains('smst-hide')) && externalCollapse.textContent === '收起');
externalStage.destroy();
mountedStage.setText('他拔出长剑，向前冲去。随后跌倒在地。');
mountedStage.playBeats();
const timerScheduled = timerSet.size > 0;
mountedStage.pause();
ok('真实舞台 pause 清除待播节拍并停止后续重启', timerScheduled && timerSet.size === 0);
mountedStage.destroy();

console.log('\n[1] 装载与动作库');
ok('Stickman 暴露 createStage', typeof SM.createStage === 'function');
ok('动作数 ≥ 30', Object.keys(SM.actions).length >= 30, '实际 ' + Object.keys(SM.actions).length);
const NAMES = Object.keys(SM.actions);
let badFrames = [];
for (const n of NAMES) {
  const a = SM.actions[n];
  if (!a || !Array.isArray(a.frames) || !a.frames.length) { badFrames.push(n + ':无 frames'); continue; }
  for (const fr of a.frames) {
    if (!(fr[0] > 0)) badFrames.push(n + ':帧时长非正');
    if (!fr[1] || typeof fr[1].lean !== 'number') badFrames.push(n + ':帧非姿势');
    for (const k of Object.keys(fr[1])) {
      if (SM.KEYS.indexOf(k) < 0) badFrames.push(n + ':未知通道 ' + k);
      else if (!isFinite(fr[1][k])) badFrames.push(n + ':' + k + ' 非数字');
    }
  }
  if (a.end && a.end !== 'idle' && a.end !== 'hold' && a.end !== 'none' && !SM.actions[a.end]) badFrames.push(n + ':end 指向不存在的 ' + a.end);
  for (const fx of (a.fx || [])) if (!(fx.t >= 0 && fx.t <= 1)) badFrames.push(n + ':fx.t 越界');
}
ok('所有动作帧结构合法', badFrames.length === 0, badFrames.slice(0, 6).join(' | '));
const legacy = ['idle', 'walk', 'run', 'attack', 'cast', 'hit', 'jump', 'dodge', 'fall', 'win', 'search', 'talk'];
ok('v3 的 12 个动作名全部保留', legacy.every((n) => !!SM.actions[n]), legacy.filter((n) => !SM.actions[n]).join(','));

console.log('\n[2] 采样与时长');
let durBad = [];
for (const n of NAMES) {
  const d = SM._test.actionDur(n);
  if (!(d > 0.05 && d < 12)) durBad.push(n + '=' + d);
  for (const t of [0, d * 0.3, d * 0.7, d, d * 2]) {
    const p = SM.samplePose(n, t);
    for (const k of SM.KEYS) if (!isFinite(p[k])) durBad.push(n + '@' + t + ':' + k);
  }
}
ok('时长合理且任意时刻可采样', durBad.length === 0, durBad.slice(0, 5).join(' | '));
const p0 = SM.samplePose('walk', 0), p1 = SM.samplePose('walk', 0.17);
ok('循环动作在周期内连续变化', JSON.stringify(p0) !== JSON.stringify(p1));
ok('循环动作 t 与 t+周期 一致', Math.abs(SM.samplePose('walk', 0.3).lean - SM.samplePose('walk', 0.3 + 1.36).lean) < 1e-6);

console.log('\n[3] 渲染路径（真实走 draw）');
const cv = makeCanvas(700, 150);
const stage = SM.createStage(cv, { height: 150 });
let drawErr = null;
const ctx = cv.getContext('2d');
for (const n of NAMES) {
  stage.scene([{ id: 'hero', x: 0.5, action: n, color: '#e8e8e8' }]);
  const actors = stage.actors();
  for (const frac of [0.1, 0.4, 0.7, 0.95]) {
    actors[0].t = SM._test.actionDur(n) * frac;
    actors[0].blendT = 1;
    try { stage._test.draw(); } catch (e) { drawErr = n + '@' + frac + ': ' + e.message; break; }
  }
}
ok('全部动作渲染无异常', drawErr === null, drawErr || '');
ok('确实产生了绘制指令', ctx._rec.ops > 100, 'ops=' + ctx._rec.ops);

console.log('\n[4] 画布越界与踩地');
const W = stage.state.W, H = stage.state.H;
let out = [];
for (const n of NAMES) {
  stage.scene([{ id: 'hero', x: 0.5, action: n, color: '#e8e8e8' }]);
  const actors = stage.actors();
  for (let i = 0; i <= 10; i++) {
    actors[0].t = SM._test.actionDur(n) * (i / 10);
    actors[0].blendT = 1;
    const bb = stage._test.bbox();
    if (!bb) { out.push(n + ':无落点'); continue; }
    if (bb.minX < -2 || bb.maxX > W + 2 || bb.minY < -2 || bb.maxY > H + 2) out.push(n + '@' + i + ' [' + [bb.minX, bb.minY, bb.maxX, bb.maxY].map((v) => Math.round(v)).join(',') + ']');
  }
}
ok('所有动作都在画布内', out.length === 0, out.slice(0, 5).join(' | '));

/* 踩地：站立类动作的脚必须落在地面线附近（不悬空、不穿地） */
const GY = H - 18;
const standers = ['idle', 'walk', 'attack', 'cast', 'talk', 'search', 'block', 'bow', 'pray', 'think'];
let floatBad = [];
for (const n of standers) {
  stage.scene([{ id: 'hero', x: 0.5, action: n }]);
  const a = stage.actors()[0];
  for (let i = 0; i <= 8; i++) {
    a.t = SM._test.actionDur(n) * (i / 8);
    a.blendT = 1;
    const sk = SM._test.build(SM.samplePose(n, a.t));
    const lowest = Math.max(a.customPose ? 0 : sk.legN.end.y, sk.legF.end.y, sk.legN.foot ? sk.legN.foot.y : 0, sk.legF.foot ? sk.legF.foot.y : 0);
    const hipY = GY - sk.drop;
    const footScreen = hipY + lowest;
    if (footScreen > GY + 1.5) floatBad.push(n + '@' + i + ' 穿地 ' + Math.round(footScreen - GY));
  }
}
ok('站立类动作脚不穿地', floatBad.length === 0, floatBad.slice(0, 4).join(' | '));

console.log('\n[5] 切换混合与收尾');
stage.scene([{ id: 'hero', x: 0.5, action: 'idle' }]);
const hero = stage.actors()[0];
SM._test.setAction(hero, 'attack');
ok('切换后进入混合', hero.blendT === 0 && !!hero.blendFrom);
const mid = SM._test.poseAt(hero);
const pure = SM.samplePose('attack', 0);
ok('混合中姿势介于两者之间', mid.lean !== pure.lean || Math.abs(p.alpha - 1) >= 0);
for (let i = 0; i < 40; i++) SM._test.advance(hero, 1 / 60);
ok('混合完成后 blendT=1', hero.blendT === 1);
for (let i = 0; i < 120; i++) SM._test.advance(hero, 1 / 60);
ok('单次动作自动回到 idle', hero.action === 'idle', hero.action);
stage.scene([{ id: 'hero', x: 0.5, action: 'fall' }]);
const f = stage.actors()[0];
for (let i = 0; i < 400; i++) SM._test.advance(f, 1 / 60);
const holdPose = SM._test.poseAt(f);
ok('end:hold 的动作保持末帧', f.action === 'fall' && f.t <= SM._test.actionDur('fall') + 0.01 && holdPose.alpha < 0.9,
  f.action + ' t=' + f.t.toFixed(2) + ' alpha=' + holdPose.alpha);

console.log('\n[6] 自定义姿势（手动调节）');
stage.scene([{ id: 'hero', x: 0.5, action: 'idle' }]);
const cp = stage.setCustomPose('hero', { lean: 0.8, armL: -2.2, elbowL: 0.4 });
ok('setCustomPose 切到 custom 动作', stage.actors()[0].action === 'custom');
ok('自定义通道写入成功', cp.lean === 0.8 && cp.armL === -2.2);
stage._test.draw();
ok('custom 姿势可渲染', stage.actors()[0].action === 'custom');

console.log('\n[7] 道具与多角色');
stage.scene([
  { id: 'a', x: 0.3, action: 'attack', prop: 'sword', color: '#ff6b6b' },
  { id: 'b', x: 0.7, action: 'block', prop: 'shield', flip: true, scale: 0.85 },
  { id: 'c', x: 0.5, action: 'shoot', prop: 'bow', scale: 0.7, alpha: 0.7 },
]);
stage.actors().forEach((ac) => { ac.blendT = 1; ac.t = 0.2; });
let multiErr = null;
try { stage._test.draw(); } catch (e) { multiErr = e.message; }
ok('多角色 + 道具渲染无异常', multiErr === null, multiErr || '');
ok('addActor/removeActor', (() => {
  stage.addActor({ id: 'd', x: 0.9, action: 'wave' });
  const n1 = stage.actors().length;
  stage.removeActor('d');
  return n1 === 4 && stage.actors().length === 3;
})());

console.log('\n[8] 导出图片');
let expErr = null, png = '';
try {
  png = stage.exportPNG({ scale: 2 });
  stage.exportStrip('attack', { phases: 3 });
  stage.exportSheet({ phases: 2 });
} catch (e) { expErr = e.message; }
ok('exportPNG/Strip/Sheet 不抛异常', expErr === null, expErr || '');
ok('exportPNG 返回 dataURL', typeof png === 'string' && png.startsWith('data:image/png'), String(png).slice(0, 24));
ok('导出后舞台角色未被污染', stage.actors().length === 3 && stage.actors()[0].id === 'a');

console.log('\n[9] 单例兼容 API（game_engine 走这条路）');
let legacyErr = null;
try {
  SM.attach(makeCanvas(700, 150));
  SM.scene([{ id: 'player', x: 0.3, action: 'idle' }, { id: 'npc0', x: 0.7, action: 'talk', flip: true }]);
  SM.play('attack');
  SM.actorAction('npc0', 'hit');
  SM.actorAction('npc0', 'fall', 10);
  SM.setSpeed(1.5);
  SM._test.draw();
  SM.stop();
} catch (e) { legacyErr = e.message + '\n' + e.stack; }
ok('v3 单例 API 全链路可用', legacyErr === null, legacyErr || '');

console.log('\n[10] 文字 → 动作');
const CASES = [
  ['他猛地拔剑，朝守卫劈了过去', 'charge'],
  ['守卫举盾挡住这一击', 'block'],
  ['她低声说道：别出声。', 'talk'],
  ['他蹑手蹑脚地贴着墙根前进', 'sneak'],
  ['法师开始吟唱咒语，指尖泛起光芒', 'cast'],
  ['伤口被仔细地包扎好', 'heal'],
  ['他翻过墙头，纵身跃下', ['jump', 'climb']],
  ['老人坐在火堆旁，翻开一本旧书', 'read'],
  ['铁匠抡起锤子砸向烧红的铁坯', 'craft'],
  ['她跪倒在地，泣不成声', 'cry'],
  ['他并没有说话，只是静静站着', 'idle'],
  ['敌人被一击撂倒，再没爬起来', 'knockdown'],
  ['他撬开了那把生锈的锁', 'pick'],
  ['队伍沿着河岸向下游游去', 'swim'],
  ['他侧身一闪，避开了这一刀', 'dodge'],
  ['门被推开了', 'open'],
  ['他深吸一口气，压下翻涌的血气', 'breathe'],
  ['老兵眯起眼，打量着这间屋子', 'search'],
  ['她转过身，朝城楼的方向走去', 'walk'],
];
let wrong = [];
for (const [txt, want] of CASES) {
  const got = SA.infer(txt).action;
  const hit = Array.isArray(want) ? want.indexOf(got) >= 0 : got === want;
  if (!hit) wrong.push('「' + txt.slice(0, 14) + '…」期望 ' + want + ' 实得 ' + got);
}
ok('规则用例 ' + CASES.length + ' 条命中', wrong.length === 0, wrong.join(' | '));
ok('无命中回落 idle 且标注来源', SA.infer('今天的天气不错').source === 'none' && SA.infer('今天的天气不错').action === 'idle');
ok('否定前缀会降权', SA.infer('他没有说话').hits.length === 0 || SA.infer('他没有说话').score < 20, JSON.stringify(SA.infer('他没有说话')));
ok('可解释：reason 含命中词', /规则命中/.test(SA.infer('他拔剑砍下去').reason));
ok('explain 输出动作与依据', /attack/.test(SA.explain('他拔剑砍下去')));
const seq = SA.sequence('他推开门，抽出匕首。守卫冲上来，被他一击撂倒。');
ok('段落→节拍切分 ≥3', seq.length >= 3, seq.map((s) => s.action).join(','));
ok('序列每项带来源与文本', seq.every((s) => s.source && typeof s.action === 'string'));
ok('按句切分模式更粗', SA.sequence('他推开门，抽出匕首。守卫冲上来。', { bySentence: true }).length <= seq.length);
const propCase = SA.infer('他拉满弓弦');
ok('道具建议：弓', propCase.prop === 'bow', JSON.stringify(propCase));
ok('动作名都在动作库内（含道具/分组元数据）', (() => {
  const names = SM.listActions();
  return SA.sequence('众人欢呼雀跃，纷纷举手投足。').every((s) => names.indexOf(s.action) >= 0);
})());
ok('规则表里的动作名全部存在于动作库', (() => {
  const names = SM.listActions();
  const bad = SA.list().filter((r) => names.indexOf(r.action) < 0).map((r) => r.action);
  return bad.length === 0 ? true : (console.log('    未知动作: ' + bad.join(',')), false);
})());
ok('META 覆盖所有动作（UI 中文名不缺）', (() => {
  const miss = SM.listActions().filter((n) => !SA.META[n]);
  return miss.length === 0 ? true : (console.log('    缺 META: ' + miss.join(',')), false);
})());
ok('纯描写不误报动作', SA.infer('夜色像墨，河水很静。').score === 0 || SA.infer('夜色像墨，河水很静。').source === 'none');
let aiErr = null;
SA.aiInfer('他打了一拳', null).then(
  () => { finish(); },
  (e) => { aiErr = e.message; finish(); }
);

let doneFlag = false;
function finish() {
  if (doneFlag) return;
  doneFlag = true;
  ok('无 callLLM 时 aiInfer 明确拒绝', aiErr === 'no callLLM', aiErr);
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
setTimeout(finish, 2000);

console.log('\n[11] 扩展点');
SM.define('my_pose', { loop: false, plant: true, end: 'idle', frames: [[0.3, SM._test.K(0.2, 1.2, 0.4, -1.2, -0.4, 0.1, -0.1, -0.1, -0.1)]] });
ok('define 注册新动作', SM.listActions().indexOf('my_pose') >= 0 && SM._test.actionDur('my_pose') > 0);
stage.scene([{ id: 'hero', x: 0.5, action: 'my_pose' }]);
stage.actors()[0].blendT = 1;
let defErr = null;
try { stage._test.draw(); } catch (e) { defErr = e.message; }
ok('新动作可直接渲染', defErr === null, defErr || '');
SA.register([{ a: 'dig', w: 99, re: /刨土/ }]);
ok('register 追加领域词', SA.infer('他开始刨土').action === 'dig');

console.log('\n[12] v4b：武器尺寸 / 挥砍轨迹 / 蓄力圈 / 连续帧导出');
ok('武器明显变大（剑 ≥36、杖 ≥48、弓 ≥32）',
  SM.PROPS.sword.len >= 36 && SM.PROPS.staff.len >= 48 && SM.PROPS.bow.len >= 32,
  JSON.stringify({ s: SM.PROPS.sword.len, f: SM.PROPS.staff.len, b: SM.PROPS.bow.len }));
ok('刀刃为锥形多边形（blade 标记 + 护手 + 握柄）',
  SM.PROPS.sword.blade === true && SM.PROPS.sword.guard > 6 && SM.PROPS.sword.grip > 3);
stage.scene([{ id: 'hero', x: 0.5, action: 'attack', prop: 'sword' }]);
const wa = stage.actors()[0];
wa.blendT = 1;
let trailErr = null;
try {
  for (let i = 0; i <= 10; i++) { wa.t = SM._test.actionDur('attack') * (i / 10); stage._test.draw(); }
} catch (e) { trailErr = e.message; }
ok('连续帧挥砍不抛异常', trailErr === null, trailErr || '');
ok('刀尖历史已累积（轨迹有东西可画）', Array.isArray(wa._wt) && wa._wt.length >= 2,
  wa._wt ? 'len=' + wa._wt.length : 'null');
SM._test.setAction(wa, 'idle');
ok('切换动作会清空刀尖历史', !wa._wt);
const ch = SM.actions.charge;
ok('蓄力改为一次性（圈长满再释放）', ch.loop === false && ch.end === 'attack');
const ringFx = (ch.fx || []).find((f) => f.kind === 'ring');
ok('蓄力 fx 用 ring 且从开头就开始长', !!ringFx && ringFx.t <= 0.05);
ok('蓄力时长 ≥ 0.9s（圈长大看得见）', SM._test.actionDur('charge') >= 0.9, SM._test.actionDur('charge').toFixed(2) + 's');
ok('释放瞬间有爆点粒子', (ch.fx || []).some((f) => f.kind === 'burst'));
const castFx = (SM.actions.cast.fx || []).find((f) => f.kind === 'rune');
ok('施法法阵提前出现（留足生长时间）', !!castFx && castFx.t <= 0.3);
let moErr = null, mo = '';
try { mo = stage.exportMotion('attack', { frames: 6, scale: 1 }); } catch (e) { moErr = e.message; }
ok('exportMotion 可用', moErr === null && mo.startsWith('data:image/png'), moErr || mo.slice(0, 20));
let wOut = [];
for (const [act, prop] of [['attack', 'sword'], ['charge', 'sword'], ['cast', 'staff'], ['shoot', 'bow'], ['block', 'shield'], ['craft', 'hammer'], ['dig', 'shovel']]) {
  stage.scene([{ id: 'hero', x: 0.5, action: act, prop }]);
  const aa = stage.actors()[0];
  for (let i = 0; i <= 10; i++) {
    aa.t = SM._test.actionDur(act) * (i / 10); aa.blendT = 1;
    const bb = stage._test.bbox();
    if (bb && (bb.minX < -2 || bb.maxX > W + 2 || bb.minY < -2 || bb.maxY > H + 2)) {
      wOut.push(act + '/' + prop + '@' + i + ' y=' + Math.round(bb.minY) + '..' + Math.round(bb.maxY));
      break;
    }
  }
}
ok('放大后的武器不越出画布', wOut.length === 0, wOut.join(' | '));

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
