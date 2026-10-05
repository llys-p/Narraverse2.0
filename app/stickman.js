/* =========================================================
 * 火柴人动作引擎 v4（层次化骨骼 + 关键帧 + 混合 + 道具/粒子 + 图片导出）
 * 相比 v3 的改动：
 * - 两段脊柱（骨盆→胸腔→颈）+ 颈部与头部倾斜，躯干为锥形结构，不再是单根直棍
 * - 踩地约束（plant）：按双腿最低点自动决定骨盆高度，走路/弓步不会浮空也不会穿地
 * - 肘/膝改为「有符号相对角」，可正可负，才能编出背手、抱臂、后摆等姿势
 * - 动作切换 crossfade，消除 v3 的「瞬间跳帧」
 * - 动作库 12 → 30+，每条带道具/特效/收尾状态
 * - 对外新增 define / listActions / samplePose / setCustomPose / exportPNG / exportStrip / exportSheet
 * 角度约定：dir(a) = (sin a, cos a)，0=向下，+π/2=前(朝向)，-π/2=后，π=向上
 * 局部坐标：原点在骨盆，+x 为角色朝向，+y 向下
 * ========================================================= */
window.Stickman = (function () {
  'use strict';

  /* ---------------- 骨骼尺寸 ---------------- */
  var BODY = {
    spineLow: 16, spineUp: 15, neck: 5, headR: 7.2,
    shoulder: 10.5, hip: 6.2,
    armUpper: 17.5, armLower: 16.5, hand: 3.4,
    thigh: 25.5, shin: 25, foot: 9.5,
    sideShoulder: 3.4, sideHip: 2.8,
  };
  var HALF_PI = Math.PI / 2;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function smooth(k) { k = clamp(k, 0, 1); return k * k * (3 - 2 * k); }
  function dir(a) { return { x: Math.sin(a), y: Math.cos(a) }; }
  function add(p, d, l) { return { x: p.x + d.x * l, y: p.y + d.y * l }; }
  function lerp(a, b, k) { return a + (b - a) * k; }

  /* ---------------- 姿势通道 ---------------- */
  var KEYS = ['px', 'py', 'lean', 'bend', 'head', 'turn',
    'armL', 'elbowL', 'armR', 'elbowR',
    'legL', 'kneeL', 'legR', 'kneeR',
    'footL', 'footR', 'hop', 'alpha'];

  /* 紧凑关键帧写法：K(lean, armL, elbowL, armR, elbowR, legL, kneeL, legR, kneeR, 附加) */
  function K(lean, aL, eL, aR, eR, lL, kL, lR, kR, o) {
    var p = {
      px: 0, py: 0, lean: lean || 0, bend: 0, head: 0, turn: 0,
      armL: aL || 0, elbowL: eL || 0, armR: aR || 0, elbowR: eR || 0,
      legL: lL || 0, kneeL: kL || 0, legR: lR || 0, kneeR: kR || 0,
      footL: HALF_PI - 0.12, footR: HALF_PI - 0.12,
      hop: 0, alpha: 1,
    };
    if (o) for (var k in o) if (o.hasOwnProperty(k)) p[k] = o[k];
    return p;
  }

  function copyPose(p) {
    var o = {};
    for (var i = 0; i < KEYS.length; i++) o[KEYS[i]] = p[KEYS[i]];
    return o;
  }
  function lerpPose(a, b, k) {
    var o = {};
    for (var i = 0; i < KEYS.length; i++) {
      var key = KEYS[i];
      o[key] = (a[key] == null ? 0 : a[key]) + ((b[key] == null ? 0 : b[key]) - (a[key] == null ? 0 : a[key])) * k;
    }
    return o;
  }

  /* ---------------- 中性姿势（兜底） ---------------- */
  var NEUTRAL = K(0.03, 0.2, 0.18, -0.18, 0.16, 0.12, -0.1, -0.12, -0.08);

  /* ---------------- 动作库 ---------------- */
  var ACTIONS = {
    /* --- 站立/移动 --- */
    idle: {
      loop: true, plant: true,
      frames: [
        [1.1, K(0.04, 0.26, 0.22, -0.2, 0.18, 0.14, -0.06, -0.14, -0.06, { bend: 0.04, head: 0.05 })],
        [1.3, K(-0.02, 0.18, 0.3, -0.14, 0.24, 0.1, -0.04, -0.1, -0.04, { bend: -0.02, head: -0.06, py: -0.6 })],
      ],
    },
    breathe: {
      loop: true, plant: true,
      frames: [
        [1.6, K(0.02, 0.22, 0.26, -0.18, 0.22, 0.12, -0.05, -0.12, -0.05, { bend: 0.05 })],
        [1.9, K(-0.03, 0.16, 0.34, -0.12, 0.3, 0.08, -0.03, -0.08, -0.03, { bend: -0.03, py: -0.8 })],
      ],
    },
    walk: {
      loop: true, plant: true, speed: 1,
      frames: [
        [0.34, K(0.1, -0.5, 0.55, 0.44, 0.4, 0.44, -0.16, -0.42, -0.62, { head: -0.04 })],
        [0.34, K(0.12, -0.1, 0.3, 0.08, 0.28, 0.06, -0.05, -0.04, -0.06, { py: -0.9 })],
        [0.34, K(0.1, 0.46, 0.42, -0.52, 0.6, -0.42, -0.6, 0.46, -0.18, { head: -0.04 })],
        [0.34, K(0.12, -0.1, 0.3, 0.08, 0.28, -0.04, -0.06, 0.06, -0.05, { py: -0.9 })],
      ],
    },
    run: {
      loop: true, plant: true, speed: 1,
      frames: [
        [0.19, K(0.3, -0.72, 1.5, 0.62, 1.35, 0.92, -1.35, -0.5, -0.35, { hop: 5, head: -0.12 })],
        [0.17, K(0.34, -0.3, 1.2, 0.24, 1.1, 0.16, -0.35, -0.12, -1.5, { hop: 1 })],
        [0.19, K(0.3, 0.66, 1.4, -0.76, 1.55, -0.46, -0.3, 0.95, -1.4, { hop: 5, head: -0.12 })],
        [0.17, K(0.34, 0.26, 1.1, -0.32, 1.2, -0.1, -1.5, 0.18, -0.3, { hop: 1 })],
      ],
      fx: [{ t: 0.06, kind: 'dust', on: 'foot' }, { t: 0.44, kind: 'dust', on: 'foot' }],
      trail: 0.55,
    },
    sneak: {
      loop: true, plant: true,
      frames: [
        [0.52, K(0.42, -0.34, 1.05, 0.3, 0.9, 0.5, -0.72, -0.34, -0.95, { py: 10, head: 0.24 })],
        [0.52, K(0.42, -0.34, 1.05, 0.3, 0.9, -0.3, -0.95, 0.52, -0.7, { py: 10, head: 0.24 })],
      ],
    },
    climb: {
      loop: true, plant: true,
      frames: [
        [0.4, K(0.16, 2.5, -0.5, 1.9, -0.9, 0.9, -1.5, -0.2, -0.5, { hop: 6, head: -0.3 })],
        [0.4, K(0.16, 1.9, -0.9, 2.5, -0.5, -0.2, -0.5, 0.9, -1.5, { hop: 3, head: -0.3 })],
      ],
    },
    swim: {
      loop: true, plant: true,
      frames: [
        [0.4, K(1.45, 2.6, -0.3, 1.2, -0.4, -1.3, -0.2, -1.15, -0.35, { head: -0.55 })],
        [0.4, K(1.45, 1.2, -0.4, 2.6, -0.3, -1.15, -0.35, -1.3, -0.2, { head: -0.55 })],
      ],
      fx: [{ t: 0.2, kind: 'splash', on: 'hand' }],
    },
    jump: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.16, K(0.34, 0.5, 0.7, 0.5, 0.7, 0.3, -0.95, -0.3, -0.95, { py: 8, head: 0.16 })],
        [0.2, K(-0.1, -2.6, -0.35, -2.6, -0.35, 0.62, -1.5, -0.5, -1.15, { hop: 30, head: -0.16 })],
        [0.24, K(0.16, -1.5, -0.3, -1.4, -0.3, 0.4, -0.5, -0.36, -0.4, { hop: 22 })],
        [0.2, K(0.4, 0.4, 0.9, 0.4, 0.9, 0.34, -1.05, -0.34, -1.05, { py: 9, head: 0.2 })],
        [0.16, NEUTRAL],
      ],
      fx: [{ t: 0.02, kind: 'dust', on: 'foot', big: 1 }, { t: 0.78, kind: 'dust', on: 'foot', big: 1 }],
    },
    land: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.14, K(0.24, 0.6, 0.8, 0.6, 0.8, 0.4, -1.1, -0.4, -1.1, { py: 7 })],
        [0.22, K(0.06, 0.3, 0.5, 0.3, 0.5, 0.16, -0.3, -0.16, -0.3, { py: 2 })],
      ],
      fx: [{ t: 0.1, kind: 'dust', on: 'foot', big: 1 }],
    },
    fall: {
      loop: false, plant: true, end: 'hold',
      frames: [
        [0.18, K(-0.6, 1.1, 0.4, -0.9, 0.3, -0.55, -0.5, 0.6, -0.4, { hop: 2 })],
        [0.26, K(-1.3, 1.62, 0.25, -1.5, 0.2, 1.28, -0.22, 1.44, -0.14, { py: -1, head: -0.35 })],
        [0.5, K(-1.34, 1.66, 0.2, -1.55, 0.25, 1.3, -0.2, 1.46, -0.12, { py: -1.5, head: -0.4, alpha: 0.85 })],
      ],
      fx: [{ t: 0.42, kind: 'dust', on: 'foot', big: 1 }],
    },
    getup: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.24, K(-1.3, 1.6, 0.25, -1.45, 0.25, 1.28, -0.22, 1.44, -0.14, { py: -1 })],
        [0.26, K(-0.5, 1.0, 0.6, -0.6, 0.8, 0.75, -1.6, -0.2, -0.4, { py: 10 })],
        [0.24, K(0.2, 0.5, 0.7, 0.4, 0.7, 0.3, -0.9, -0.3, -0.9, { py: 6 })],
      ],
    },

    /* --- 战斗 --- */
    attack: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.18, K(-0.22, -0.4, 0.5, -1.95, 1.15, 0.28, -0.24, -0.3, -0.2, { head: 0.12 })],
        [0.1, K(0.56, -0.75, 0.35, 1.18, 0.12, -0.34, 0.18, 0.5, -0.28, { head: -0.2, py: -1 })],
        [0.16, K(0.34, -0.5, 0.4, 0.75, 0.3, -0.2, 0.1, 0.36, -0.2)]
        ,
        [0.24, NEUTRAL],
      ],
      fx: [{ t: 0.19, kind: 'slash', on: 'armR' }],
      trail: 0.9, weaponDefault: 'sword',
    },
    thrust: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.16, K(-0.16, 0.2, 0.4, -0.5, 1.5, 0.2, -0.3, -0.3, -0.3)],
        [0.14, K(0.62, 0.3, 0.3, 1.52, 0.04, -0.42, 0.2, 0.62, -0.3, { head: -0.15 })],
        [0.26, NEUTRAL],
      ],
      fx: [{ t: 0.28, kind: 'streak', on: 'armR' }],
      weaponDefault: 'dagger',
    },
    shoot: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.2, K(0.14, 1.5, -0.15, 1.5, 0.5, 0.24, -0.2, -0.3, -0.24, { head: -0.1 })],
        [0.26, K(0.2, 1.52, -0.5, 1.5, -0.9, 0.24, -0.2, -0.3, -0.24, { head: -0.1 })],
        [0.12, K(0.16, 1.5, -0.1, 1.5, 0.2, 0.2, -0.18, -0.26, -0.2)],
        [0.22, NEUTRAL],
      ],
      fx: [{ t: 0.46, kind: 'shot', on: 'armR' }],
      weaponDefault: 'bow',
    },
    block: {
      loop: true, plant: true,
      frames: [
        [0.2, K(0.16, 0.95, 1.6, 0.6, 1.75, 0.3, -0.4, -0.34, -0.5, { head: 0.1 })],
        [0.24, K(0.12, 0.9, 1.55, 0.55, 1.7, 0.28, -0.38, -0.32, -0.48, { head: 0.1, py: -0.4 })],
      ],
      weaponDefault: 'sword', shield: true,
    },
    guard: {
      loop: true, plant: true,
      frames: [
        [0.9, K(0.2, 0.42, 1.15, -0.3, 1.3, 0.34, -0.5, -0.36, -0.55, { head: 0.06 })],
        [1.0, K(0.16, 0.46, 1.2, -0.26, 1.35, 0.32, -0.48, -0.34, -0.53, { head: 0.06, py: -0.5 })],
      ],
    },
    dodge: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.12, K(-0.5, 0.9, 0.5, -0.7, 0.4, -0.5, -0.4, 0.55, -0.3, { py: 4 })],
        [0.2, K(-0.85, 1.3, 0.35, -1.0, 0.5, -0.75, -0.25, 0.85, -0.2, { px: -7, hop: 4, head: -0.3 })],
        [0.22, K(-0.3, 0.7, 0.5, -0.5, 0.4, -0.3, -0.5, 0.3, -0.4, { hop: 1 })],
      ],
      trail: 0.7,
      fx: [{ t: 0.14, kind: 'dust', on: 'foot' }],
    },
    hit: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.1, K(-0.62, 1.15, 0.35, -0.85, 0.3, -0.42, -0.35, 0.5, -0.3, { hop: 2, px: -3, head: -0.35 })],
        [0.2, K(-0.3, 0.6, 0.5, -0.4, 0.4, -0.2, -0.35, 0.24, -0.3, { px: -1 })],
        [0.2, NEUTRAL],
      ],
      fx: [{ t: 0.02, kind: 'spark', on: 'chest' }],
    },
    knockdown: {
      loop: false, plant: true, end: 'hold',
      frames: [
        [0.12, K(-0.7, 1.2, 0.3, -0.9, 0.3, -0.5, -0.4, 0.6, -0.35, { hop: 3 })],
        [0.24, K(-1.32, 1.68, 0.18, -1.52, 0.22, 1.3, -0.2, 1.46, -0.12, { py: -1, head: -0.35 })],
        [0.6, K(-1.36, 1.7, 0.15, -1.56, 0.2, 1.32, -0.18, 1.48, -0.1, { py: -1.5, head: -0.4, alpha: 0.8 })],
      ],
      fx: [{ t: 0.14, kind: 'dust', on: 'foot', big: 1 }, { t: 0.02, kind: 'spark', on: 'chest' }],
    },
    victory: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.24, K(-0.1, -2.85, -0.2, -2.85, -0.2, 0.24, -0.16, -0.24, -0.16, { head: -0.2 })],
        [0.18, K(-0.16, -2.95, -0.15, -2.4, -0.3, 0.3, -0.2, -0.3, -0.2, { hop: 7, head: -0.24 })],
        [0.22, K(-0.06, -2.7, -0.2, -2.9, -0.15, 0.2, -0.14, -0.2, -0.14, { hop: 2 })],
        [0.2, NEUTRAL],
      ],
      fx: [{ t: 0.2, kind: 'burst', on: 'hand' }],
    },
    win: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.24, K(-0.1, -2.85, -0.2, -2.85, -0.2, 0.24, -0.16, -0.24, -0.16, { head: -0.2 })],
        [0.18, K(-0.16, -2.95, -0.15, -2.4, -0.3, 0.3, -0.2, -0.3, -0.2, { hop: 7, head: -0.24 })],
        [0.22, K(-0.06, -2.7, -0.2, -2.9, -0.15, 0.2, -0.14, -0.2, -0.14, { hop: 2 })],
        [0.2, NEUTRAL],
      ],
      fx: [{ t: 0.2, kind: 'burst', on: 'hand' }],
    },
    charge: {
      loop: false, plant: true, end: 'attack',
      frames: [
        [0.42, K(-0.3, -0.5, 0.7, -1.7, 1.4, 0.3, -0.35, -0.34, -0.28, { head: 0.16 })],
        [0.44, K(-0.44, -0.62, 0.82, -1.9, 1.52, 0.34, -0.42, -0.38, -0.32, { head: 0.2, py: 2 })],
        [0.3, K(-0.5, -0.7, 0.9, -2.0, 1.6, 0.36, -0.46, -0.4, -0.36, { head: 0.24, py: 3 })],
      ],
      fx: [{ t: 0.02, kind: 'ring', on: 'body', color: '#ff9a5c' }, { t: 0.94, kind: 'burst', on: 'handR', color: '#ffc06a' }],
      weaponDefault: 'sword',
    },

    /* --- 施法/交互 --- */
    cast: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.24, K(-0.14, -1.15, 0.5, -1.15, 0.5, 0.26, -0.3, -0.26, -0.3, { head: 0.14 })],
        [0.22, K(-0.2, -2.42, -0.15, -2.42, -0.15, 0.26, -0.3, -0.26, -0.3, { head: -0.1 })],
        [0.3, K(0.22, -1.9, 0.25, -1.9, 0.25, 0.2, -0.2, -0.2, -0.2, { head: -0.24 })],
        [0.24, NEUTRAL],
      ],
      fx: [{ t: 0.26, kind: 'rune', on: 'body' }, { t: 0.4, kind: 'glow', on: 'handL' }, { t: 0.4, kind: 'glow', on: 'handR' }, { t: 0.74, kind: 'burst', on: 'handR', color: '#9fe0ff' }, { t: 0.74, kind: 'burst', on: 'handL', color: '#9fe0ff' }],
      weaponDefault: 'staff',
    },
    heal: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.3, K(0.3, 0.75, 1.35, 0.75, 1.35, 0.24, -0.35, -0.24, -0.35, { head: 0.3 })],
        [0.42, K(0.24, 0.85, 1.5, 0.85, 1.5, 0.22, -0.3, -0.22, -0.3, { head: 0.26 })],
        [0.26, NEUTRAL],
      ],
      fx: [{ t: 0.22, kind: 'glow', on: 'handL', color: '#8ff0b8' }, { t: 0.22, kind: 'glow', on: 'handR', color: '#8ff0b8' }],
    },
    pray: {
      loop: true, plant: true,
      frames: [
        [1.3, K(0.22, 1.15, 1.6, -1.15, -1.6, 0.14, -0.1, -0.14, -0.1, { head: 0.42, py: 0.5 })],
        [1.5, K(0.18, 1.15, 1.62, -1.15, -1.62, 0.14, -0.1, -0.14, -0.1, { head: 0.36, py: -0.3 })],
      ],
    },

    /* --- 社交 --- */
    talk: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.26, K(0.1, -1.25, 0.75, -0.2, 0.3, 0.16, -0.1, -0.16, -0.1, { head: -0.1, turn: 0.35 })],
        [0.26, K(0.06, -0.4, 0.5, -1.35, 0.8, 0.14, -0.1, -0.14, -0.1, { head: 0.06, turn: 0.35 })],
        [0.24, NEUTRAL],
      ],
    },
    wave: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.18, K(0.04, -2.5, -0.35, -0.2, 0.25, 0.14, -0.1, -0.14, -0.1, { head: -0.08, turn: 0.4 })],
        [0.16, K(0.04, -2.35, -0.75, -0.2, 0.25, 0.14, -0.1, -0.14, -0.1, { turn: 0.4 })],
        [0.16, K(0.04, -2.6, -0.25, -0.2, 0.25, 0.14, -0.1, -0.14, -0.1, { turn: 0.4 })],
        [0.16, K(0.04, -2.35, -0.75, -0.2, 0.25, 0.14, -0.1, -0.14, -0.1, { turn: 0.4 })],
        [0.2, NEUTRAL],
      ],
    },
    point: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.2, K(0.12, -1.55, -0.02, -0.3, 0.4, 0.16, -0.12, -0.18, -0.12, { head: -0.14, turn: 0.3 })],
        [0.4, K(0.18, -1.6, 0.02, -0.3, 0.4, 0.18, -0.12, -0.2, -0.12, { head: -0.18, turn: 0.3 })],
        [0.24, NEUTRAL],
      ],
    },
    bow: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.24, K(0.5, 0.35, 0.4, -0.35, -0.4, 0.1, -0.16, -0.1, -0.16, { head: 0.4, turn: 0.55 })],
        [0.3, K(1.15, 0.5, 0.5, -0.5, -0.5, 0.06, -0.28, -0.06, -0.28, { head: 0.75, py: 2, turn: 0.6 })],
        [0.24, K(0.5, 0.35, 0.4, -0.35, -0.4, 0.1, -0.16, -0.1, -0.16, { head: 0.4, turn: 0.55 })],
        [0.2, NEUTRAL],
      ],
    },
    shrug: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.2, K(0.02, 0.95, 1.5, -0.95, -1.5, 0.14, -0.1, -0.14, -0.1, { head: -0.16, turn: 0.75 })],
        [0.24, K(-0.06, 1.05, 1.65, -1.05, -1.65, 0.14, -0.1, -0.14, -0.1, { head: 0.1, py: -0.8, turn: 0.75 })],
        [0.22, NEUTRAL],
      ],
    },
    cheer: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.16, K(-0.12, -2.6, -0.2, -2.6, -0.2, 0.2, -0.2, -0.2, -0.2, { turn: 0.6, head: -0.2 })],
        [0.14, K(-0.16, -2.9, -0.1, -2.9, -0.1, 0.34, -0.34, -0.34, -0.34, { hop: 9 })],
        [0.14, K(-0.1, -2.7, -0.25, -2.7, -0.25, 0.16, -0.12, -0.16, -0.12, { hop: 1.5, turn: 0.6 })],
        [0.18, NEUTRAL],
      ],
      fx: [{ t: 0.16, kind: 'burst', on: 'hand' }],
    },
    cry: {
      loop: true, plant: true,
      frames: [
        [0.9, K(0.24, 1.05, 1.55, -1.05, -1.55, 0.12, -0.12, -0.12, -0.12, { head: 0.5, py: 1.5, turn: 0.4 })],
        [1.0, K(0.18, 1.0, 1.6, -1.0, -1.6, 0.12, -0.12, -0.12, -0.12, { head: 0.38, py: 0.8, turn: 0.4 })],
      ],
      fx: [{ t: 0.4, kind: 'tear', on: 'head' }],
    },
    think: {
      loop: true, plant: true,
      frames: [
        [1.2, K(0.1, 0.55, 1.85, -0.24, 0.3, 0.14, -0.1, -0.14, -0.1, { head: 0.3 })],
        [1.4, K(0.06, 0.62, 1.9, -0.28, 0.34, 0.14, -0.1, -0.14, -0.1, { head: 0.12, py: -0.4 })],
      ],
    },
    listen: {
      loop: true, plant: true,
      frames: [
        [1.1, K(0.06, 0.9, 1.75, -0.3, 0.5, 0.16, -0.12, -0.16, -0.12, { head: -0.34 })],
        [1.3, K(-0.02, 0.86, 1.7, -0.26, 0.46, 0.16, -0.12, -0.16, -0.12, { head: -0.18, py: -0.5 })],
      ],
    },
    sleep: {
      loop: true, plant: true,
      frames: [
        [1.6, K(-1.32, 1.15, 1.15, -1.45, 0.3, 1.24, -0.42, 1.4, -0.3, { py: -1, head: -0.3, alpha: 0.9 })],
        [1.7, K(-1.3, 1.12, 1.18, -1.42, 0.32, 1.22, -0.4, 1.38, -0.28, { py: -2.2, head: -0.28, alpha: 0.86 })],
      ],
      fx: [{ t: 0.5, kind: 'zzz', on: 'head' }],
    },

    /* --- 操作/生活 --- */
    search: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.3, K(0.42, -0.95, 0.55, -0.2, 0.4, 0.24, -0.45, -0.26, -0.3, { head: 0.34 })],
        [0.3, K(0.36, -0.4, 0.5, -0.95, 0.6, 0.22, -0.4, -0.24, -0.32, { head: 0.3 })],
        [0.26, NEUTRAL],
      ],
    },
    read: {
      loop: true, plant: true,
      frames: [
        [1.5, K(0.34, 0.9, 1.5, -0.9, -1.5, 0.12, -0.12, -0.12, -0.12, { head: 0.55, turn: 0.5 })],
        [1.7, K(0.3, 0.92, 1.52, -0.92, -1.52, 0.12, -0.12, -0.12, -0.12, { head: 0.48, turn: 0.5, py: -0.4 })],
      ],
      prop: 'book',
    },
    write: {
      loop: true, plant: true,
      frames: [
        [0.5, K(0.4, 0.95, 1.45, -0.3, 0.5, 0.14, -0.16, -0.14, -0.16, { head: 0.55 })],
        [0.5, K(0.36, 1.02, 1.5, -0.3, 0.5, 0.14, -0.16, -0.14, -0.16, { head: 0.5 })],
      ],
      prop: 'quill',
    },
    drink: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.22, K(0.1, 1.15, 1.5, -0.2, 0.35, 0.14, -0.12, -0.14, -0.12, { head: -0.1 })],
        [0.3, K(-0.16, 1.9, 1.15, -0.2, 0.35, 0.12, -0.1, -0.12, -0.1, { head: -0.42 })],
        [0.22, K(0.1, 1.15, 1.5, -0.2, 0.35, 0.14, -0.12, -0.14, -0.12, { head: -0.1 })],
        [0.2, NEUTRAL],
      ],
      prop: 'cup',
    },
    open: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.22, K(0.16, 1.45, 0.1, 1.3, 0.12, 0.2, -0.24, -0.24, -0.28, { head: -0.06 })],
        [0.3, K(0.5, 1.6, 0.05, 1.5, 0.06, -0.3, 0.1, 0.5, -0.3, { head: -0.16, px: 2 })],
        [0.24, NEUTRAL],
      ],
    },
    pick: {
      loop: true, plant: true,
      frames: [
        [0.42, K(0.62, 1.05, 0.9, -0.2, 0.4, 0.3, -0.75, -0.3, -0.85, { head: 0.5, py: 12 })],
        [0.42, K(0.66, 1.12, 0.82, -0.2, 0.4, 0.3, -0.75, -0.3, -0.85, { head: 0.52, py: 12.6 })],
      ],
      prop: 'pick',
    },
    craft: {
      loop: true, plant: true,
      frames: [
        [0.34, K(0.44, 0.7, 1.3, -0.7, -1.3, 0.24, -0.4, -0.24, -0.4, { head: 0.42 })],
        [0.24, K(0.62, 1.15, 1.05, -1.15, -1.05, 0.24, -0.4, -0.24, -0.4, { head: 0.5, py: 2 })],
      ],
      prop: 'hammer',
      fx: [{ t: 0.6, kind: 'spark', on: 'handL' }],
    },
    carry: {
      loop: true, plant: true,
      frames: [
        [0.4, K(0.24, 0.62, 0.55, 0.58, 0.6, 0.42, -0.2, -0.4, -0.5, { head: 0.16 })],
        [0.4, K(0.24, 0.62, 0.55, 0.58, 0.6, -0.4, -0.5, 0.42, -0.2, { head: 0.16 })],
      ],
      prop: 'crate',
    },
    push: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.24, K(0.5, 1.4, 0.12, 1.36, 0.14, -0.44, 0.16, 0.55, -0.24, { head: -0.12 })],
        [0.34, K(0.6, 1.52, 0.06, 1.5, 0.06, -0.5, 0.18, 0.62, -0.22, { head: -0.14, px: 3 })],
        [0.24, NEUTRAL],
      ],
      fx: [{ t: 0.3, kind: 'dust', on: 'foot' }],
    },
    throw: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.18, K(-0.3, -0.3, 0.5, -2.3, 0.9, 0.24, -0.3, -0.3, -0.3, { head: 0.14 })],
        [0.12, K(0.55, -0.6, 0.4, 1.35, 0.1, -0.34, 0.16, 0.5, -0.26, { head: -0.16 })],
        [0.26, K(0.3, -0.4, 0.5, 0.7, 0.4, -0.2, 0.06, 0.34, -0.2)],
        [0.22, NEUTRAL],
      ],
      fx: [{ t: 0.19, kind: 'streak', on: 'armR' }],
      trail: 0.8,
    },
    dig: {
      loop: true, plant: true,
      frames: [
        [0.4, K(0.5, 0.5, 0.9, -0.5, -0.9, 0.3, -0.5, -0.3, -0.4, { head: 0.4 })],
        [0.36, K(0.95, 1.35, 0.7, -1.3, -0.7, 0.34, -0.6, -0.34, -0.5, { head: 0.6, py: 6 })],
      ],
      prop: 'shovel',
      fx: [{ t: 0.7, kind: 'dust', on: 'handR' }],
    },
    sit: {
      loop: true, plant: true,
      frames: [
        [1.5, K(0.1, 0.35, 0.55, -0.3, 0.5, 1.42, -1.45, 1.3, -1.4, { head: 0.1 })],
        [1.7, K(0.06, 0.32, 0.6, -0.28, 0.52, 1.42, -1.45, 1.3, -1.4, { head: 0.04, py: -0.8 })],
      ],
    },
    kneel: {
      loop: true, plant: true,
      frames: [
        [1.4, K(0.16, 0.5, 0.9, -0.5, -0.9, 1.35, -1.45, 0.1, -1.6, { head: 0.12 })],
        [1.6, K(0.12, 0.48, 0.92, -0.48, -0.92, 1.35, -1.45, 0.1, -1.6, { head: 0.06, py: -0.8 })],
      ],
    },
    stretch: {
      loop: false, plant: true, end: 'idle',
      frames: [
        [0.4, K(-0.2, -2.4, -0.5, -2.2, -0.4, 0.18, -0.14, -0.18, -0.14, { head: -0.3, py: -2 })],
        [0.34, K(-0.34, -2.85, -0.2, -2.7, -0.2, 0.2, -0.16, -0.2, -0.16, { head: -0.4, hop: 1.5, py: -3 })],
        [0.26, NEUTRAL],
      ],
    },
  };

  /* ---------------- 道具外观（v4b：明显放大，剑/匕改为锥形刀刃） ---------------- */
  var PROPS = {
    sword: { len: 40, w: 3.6, color: '#dfe6ff', edge: '#ffffff', blade: true, guard: 11, grip: 7, from: 'handR' },
    dagger: { len: 21, w: 3.2, color: '#dfe6ff', edge: '#ffffff', blade: true, guard: 7, grip: 5, from: 'handR' },
    staff: { len: 54, w: 3.4, color: '#b98a52', shaft: true, cap: 6.2, capColor: '#8cdcff', from: 'handR' },
    bow: { len: 38, w: 3.2, color: '#c1935c', arc: true, from: 'handL', anchor: 'handR' },
    shield: { len: 0, w: 0, color: '#9aa3b8', plate: true, big: 13, boss: true, from: 'handR' },
    book: { len: 0, w: 0, color: '#d8c79a', plate: true, square: true, big: 9, from: 'handL' },
    cup: { len: 0, w: 0, color: '#e0c98a', plate: true, square: true, big: 7, from: 'handL' },
    crate: { len: 0, w: 0, color: '#b98a52', plate: true, square: true, big: 14, both: true, from: 'handL' },
    hammer: { len: 30, w: 3.6, color: '#8b7355', haft: true, head: 12, headColor: '#9aa3b8', from: 'handR' },
    shovel: { len: 38, w: 3.2, color: '#8b7355', haft: true, head: 10, headColor: '#9aa3b8', from: 'handR' },
    pick: { len: 16, w: 2.4, color: '#9aa3b8', spike: true, from: 'handR' },
    quill: { len: 18, w: 2, color: '#e8e2cf', feather: true, from: 'handR' },
  };

  /* ---------------- 舞台状态（每个实例一份，见 makeStage） ---------------- */
  var durCache = {};
  function actionDur(name) {
    if (durCache[name] != null) return durCache[name];
    var a = ACTIONS[name];
    if (!a) return 1;
    var sp = a.speed || 1, d = 0;
    for (var i = 0; i < a.frames.length; i++) d += a.frames[i][0];
    d = d / sp;
    durCache[name] = d;
    return d;
  }
  function invalidate(name) { delete durCache[name]; }

  function makeStage() {
  var state = {
    canvas: null, ctx: null,
    W: 700, H: 150, raf: 0, running: false, lastTs: 0,
    actors: [], particles: [], trails: {},
    speed: 1, blend: 0.14, showGround: true, bg: null,
    _record: false, _bbox: null, _markFn: null,
  };

  function groundY() { return state.H - 18; }
  function byId(id) {
    for (var i = 0; i < state.actors.length; i++) if (state.actors[i].id === id) return state.actors[i];
    return null;
  }
  function mark(x, y) {
    if (!state._record) return;
    if (!state._bbox) state._bbox = { minX: x, minY: y, maxX: x, maxY: y };
    else {
      if (x < state._bbox.minX) state._bbox.minX = x;
      if (y < state._bbox.minY) state._bbox.minY = y;
      if (x > state._bbox.maxX) state._bbox.maxX = x;
      if (y > state._bbox.maxY) state._bbox.maxY = y;
    }
  }
  function trace(x, y) { if (state._markFn) state._markFn(x, y); }

  /* ---------------- 骨骼求解 ---------------- */
  function build(p) {
    var up1 = { x: Math.sin(p.lean), y: -Math.cos(p.lean) };
    var pelvis = { x: p.px, y: 0 };
    var chest = add(pelvis, up1, BODY.spineLow);
    var up2 = { x: Math.sin(p.lean + p.bend), y: -Math.cos(p.lean + p.bend) };
    var neck = add(chest, up2, BODY.spineUp);
    var headC = add(neck, up2, BODY.neck + BODY.headR);
    var shCtr = add(chest, up2, BODY.spineUp * 0.16);
    var tw = clamp(p.turn, 0, 1);
    var shHalf = BODY.sideShoulder + (BODY.shoulder - BODY.sideShoulder) * tw;
    var hipHalf = BODY.sideHip + (BODY.hip - BODY.sideHip) * tw;

    function limbChain(root, aUp, aElb, lUp, lLow, footA, footLen) {
      var elbow = add(root, dir(aUp), lUp);
      var end = add(elbow, dir(aUp + aElb), lLow);
      var toe = null;
      if (footLen) toe = add(end, dir(footA), footLen);
      return { joint: elbow, end: end, foot: toe };
    }
    var s = {
      pelvis: pelvis, chest: chest, neck: neck, head: headC, headR: BODY.headR,
      shN: { x: shCtr.x + shHalf, y: shCtr.y }, shF: { x: shCtr.x - shHalf, y: shCtr.y + 1 },
      hpN: { x: pelvis.x + hipHalf, y: pelvis.y }, hpF: { x: pelvis.x - hipHalf, y: pelvis.y + 1 },
      lean: p.lean, bend: p.bend, turn: p.turn,
    };
    s.armN = limbChain(s.shN, p.armL, p.elbowL, BODY.armUpper, BODY.armLower, null, 0);
    s.armF = limbChain(s.shF, p.armR, p.elbowR, BODY.armUpper, BODY.armLower, null, 0);
    s.legN = limbChain(s.hpN, p.legL, p.kneeL, BODY.thigh, BODY.shin, p.footL, BODY.foot);
    s.legF = limbChain(s.hpF, p.legR, p.kneeR, BODY.thigh, BODY.shin, p.footR, BODY.foot);
    /* 脚底最低点（踩地约束用） */
    function drop(c) {
      var y = c.end.y;
      if (c.foot) y = Math.max(y, c.foot.y);
      return y;
    }
    s.drop = Math.max(drop(s.legN), drop(s.legF));
    return s;
  }

  /* ---------------- 姿势采样（无副作用） ---------------- */
  function framesPose(name, t) {
    var a = ACTIONS[name];
    if (!a) return null;
    var sp = a.speed || 1;
    var tt = t * sp;
    var frames = a.frames;
    var acc = 0, i;
    var total = 0;
    for (i = 0; i < frames.length; i++) total += frames[i][0];
    if (a.loop) {
      if (total > 0) tt = tt % total;
    } else if (tt > total) tt = total;
    for (i = 0; i < frames.length; i++) {
      var d = frames[i][0];
      if (tt <= acc + d || i === frames.length - 1) {
        var f0 = frames[i][1];
        var last = i === frames.length - 1;
        var f1 = last && !a.loop ? frames[i][1] : frames[(i + 1) % frames.length][1];
        var k = d > 0 ? smooth((tt - acc) / d) : 1;
        if (last && !a.loop) k = 1;
        return lerpPose(f0, f1, k);
      }
      acc += d;
    }
    return copyPose(frames[frames.length - 1][1]);
  }

  function samplePose(name, t) {
    var p = framesPose(name || 'idle', t);
    return p || copyPose(NEUTRAL);
  }

  function actorPose(actor) {
    if (actor.action === 'custom' && actor.customPose) return copyPose(actor.customPose);
    var p = samplePose(actor.action, actor.t);
    if (actor.blendFrom && actor.blendT < 1) {
      var k = smooth(actor.blendT);
      p = lerpPose(actor.blendFrom, p, k);
    }
    return p;
  }

  /* ---------------- 时间推进 / 收尾 ---------------- */
  function advance(actor, dt) {
    actor.t += dt;
    if (actor.blendFrom) actor.blendT = Math.min(1, actor.blendT + dt / Math.max(0.02, state.blend));
    var a = ACTIONS[actor.action];
    if (!a) return;
    var dur = actionDur(actor.action);
    if (a.loop) {
      if (actor.t >= dur) { actor.t -= dur; actor._fxDone = {}; actor._prevT = 0; }
      return;
    }
    if (actor.t < dur) return;
    var endMode = a.end || 'idle';
    if (endMode === 'hold' || endMode === 'none') { actor.t = dur; return; }
    if (!actor._settled) {
      actor._settled = true;
      setAction(actor, endMode);
    }
  }

  function setAction(actor, name, keepTime) {
    if (!ACTIONS[name] && name !== 'custom') name = 'idle';
    if (actor.action === name && keepTime) return;
    actor.blendFrom = actorPose(actor);
    actor.blendT = 0;
    actor.action = name;
    actor.t = 0;
    actor._settled = false;
    actor._fxDone = {};
    actor._wt = null;
    actor._wtLast = -1;
    var def = ACTIONS[name];
    if (def && def.weaponDefault && !actor.propExplicit) actor.prop = def.weaponDefault;
  }

  /* ---------------- 特效 / 粒子 ---------------- */
  function spawn(kind, x, y, opt) {
    var n = 1, i;
    var col = (opt && opt.color) || null;
    if (kind === 'dust') n = (opt && opt.big) ? 12 : 6;
    if (kind === 'spark') n = 9;
    if (kind === 'burst') n = 14;
    if (kind === 'splash') n = 7;
    if (kind === 'tear') n = 2;
    for (i = 0; i < n; i++) {
      var ang, sp, life, r;
      if (kind === 'dust') { ang = -HALF_PI + (Math.random() - 0.5) * 2.2; sp = 12 + Math.random() * 26; life = 0.4 + Math.random() * 0.3; r = 1.6 + Math.random() * 2.2; col = col || 'rgba(220,215,205,0.5)'; }
      else if (kind === 'spark') { ang = -HALF_PI + (Math.random() - 0.5) * 2.6; sp = 55 + Math.random() * 70; life = 0.22 + Math.random() * 0.2; r = 1 + Math.random() * 1.2; col = col || '#ffd479'; }
      else if (kind === 'burst') { ang = -HALF_PI + (Math.random() - 0.5) * 3.1; sp = 40 + Math.random() * 55; life = 0.4 + Math.random() * 0.35; r = 1.2 + Math.random() * 1.6; col = col || '#9fe0ff'; }
      else if (kind === 'splash') { ang = -HALF_PI + (Math.random() - 0.5) * 1.8; sp = 30 + Math.random() * 40; life = 0.3; r = 1.4 + Math.random(); col = col || '#a8d8f0'; }
      else { ang = HALF_PI * 0.92; sp = 12; life = 0.7; r = 1.3; col = col || '#8ec5ff'; }
      state.particles.push({
        kind: kind, x: x, y: y,
        vx: Math.sin(ang) * sp * (kind === 'tear' ? 0.2 : 1),
        vy: Math.cos(ang) * sp * (kind === 'tear' ? 0.6 : -1) * (kind === 'dust' ? 0.5 : 1),
        life: life, max: life, r: r, color: col,
        g: kind === 'dust' ? 26 : (kind === 'tear' ? 90 : 130),
      });
    }
    if (state.particles.length > 400) state.particles.splice(0, state.particles.length - 400);
  }

  function updateParticles(dt) {
    var out = [];
    for (var i = 0; i < state.particles.length; i++) {
      var q = state.particles[i];
      q.life -= dt;
      if (q.life <= 0) continue;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.vy += q.g * dt;
      if (q.kind === 'dust') { q.vx *= 0.94; q.vy *= 0.9; }
      out.push(q);
    }
    state.particles = out;
  }

  function drawParticles(ctx) {
    for (var i = 0; i < state.particles.length; i++) {
      var q = state.particles[i];
      var k = clamp(q.life / q.max, 0, 1);
      ctx.globalAlpha = k * (q.kind === 'dust' ? 0.55 : 0.9);
      ctx.fillStyle = q.color;
      ctx.beginPath();
      ctx.arc(q.x, q.y, q.r * (q.kind === 'dust' ? (2 - k) : k), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function anchorPoint(sk, on, hipY, hx, sgn, s) {
    var pt = null;
    if (on === 'handL') pt = sk.armN.end;
    else if (on === 'handR') pt = sk.armF.end;
    else if (on === 'chest' || on === 'body') pt = sk.chest;
    else if (on === 'head') pt = sk.head;
    else if (on === 'foot') pt = (sk.legN.end.y > sk.legF.end.y ? sk.legN : sk.legF).end;
    else pt = sk.armF.end;
    if (!pt) return { x: hx, y: hipY };
    return { x: hx + pt.x * sgn * s, y: hipY + pt.y * s };
  }

  function runFx(actor, sk, hipY, hx, sgn, s, prevT, t) {
    var a = ACTIONS[actor.action];
    if (!a || !a.fx) return;
    var dur = actionDur(actor.action);
    if (!actor._fxDone) actor._fxDone = {};
    for (var i = 0; i < a.fx.length; i++) {
      var f = a.fx[i];
      var at = f.t * dur;
      var key = actor.action + '#' + i + '#' + Math.round(at * 100);
      if (actor._fxDone[key]) continue;
      if (prevT < at && t >= at) {
        actor._fxDone[key] = 1;
        var pt = anchorPoint(sk, f.on, hipY, hx, sgn, s);
        if (f.kind === 'glow' || f.kind === 'aura' || f.kind === 'rune') continue;
        spawn(f.kind, pt.x, pt.y, f);
      }
    }
  }

  /* ---------------- 拖影 ---------------- */
  function updateTrail(actor, sk, hipY, hx, sgn, s) {
    var a = ACTIONS[actor.action];
    var amt = a && a.trail;
    if (!amt) { if (state.trails[actor.id]) state.trails[actor.id] = null; return; }
    var hand = sk.armF.end, foot = sk.legN.end;
    var rec = state.trails[actor.id] || (state.trails[actor.id] = []);
    rec.push({ x: hx + hand.x * sgn * s, y: hipY + hand.y * s, f: hx + foot.x * sgn * s, fy: hipY + foot.y * s });
    while (rec.length > 7) rec.shift();
    actor._trailAmt = amt;
  }
  function drawTrail(ctx, actor) {
    var rec = state.trails[actor.id];
    if (!rec || rec.length < 2 || !actor._trailAmt) return;
    for (var i = 0; i < rec.length - 1; i++) {
      var k = (i + 1) / rec.length;
      ctx.globalAlpha = k * 0.22 * actor._trailAmt;
      ctx.strokeStyle = actor.color || '#e8e8e8';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(rec[i].x, rec[i].y);
      ctx.lineTo(rec[i + 1].x, rec[i + 1].y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* ---------------- 颜色 ---------------- */
  function hex2rgb(hex) {
    var h = String(hex || '#e8e8e8').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) n = 0xe8e8e8;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function shade(hex, f) {
    var c = hex2rgb(hex);
    return 'rgb(' + Math.round(clamp(c.r * f, 0, 255)) + ',' + Math.round(clamp(c.g * f, 0, 255)) + ',' + Math.round(clamp(c.b * f, 0, 255)) + ')';
  }
  function rgba(hex, a) {
    var c = hex2rgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }

  /* ---------------- 绘制 ---------------- */
  function strokeLine(ctx, pts, w, col) {
    ctx.strokeStyle = col;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  /* 道具：v4b 明显放大，刀刃改锥形多边形，并回报刀尖/护手坐标给挥砍轨迹 */
  function drawProp(ctx, sk, actor, near) {
    var pname = actor.prop;
    if (!pname) return null;
    var def = PROPS[pname];
    if (!def) return null;
    if (def.both && near) return null;
    if (!def.both && !near && def.from === 'handL') return null;
    var chain = def.from === 'handL' ? sk.armN : sk.armF;
    var h = chain.end, j = chain.joint;
    var ang = Math.atan2(h.x - j.x, h.y - j.y);
    var dx = Math.sin(ang), dy = Math.cos(ang);
    var px = -dy, py = dx; /* 垂直方向 */
    trace(h.x, h.y);
    var tip = { x: h.x, y: h.y }, base = { x: h.x, y: h.y };

    if (def.plate) {
      var sz = def.big || 11;
      ctx.save();
      ctx.translate(h.x + dx * 2, h.y + dy * 2);
      ctx.rotate(-ang);
      ctx.fillStyle = rgba(def.color, 0.88);
      ctx.strokeStyle = shade(def.color, 1.35);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      if (def.square) { ctx.rect(-sz * 0.6, -sz * 0.45, sz * 1.2, sz * 0.9); }
      else { ctx.ellipse(0, 0, sz * 0.72, sz, 0, 0, Math.PI * 2); }
      ctx.fill(); ctx.stroke();
      if (def.boss) {
        ctx.fillStyle = shade(def.color, 0.6);
        ctx.beginPath(); ctx.arc(0, 0, sz * 0.26, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      tip = { x: h.x + dx * (2 + sz), y: h.y + dy * (2 + sz) };
      trace(tip.x, tip.y);
      sk.propTip = near ? tip : sk.propTip;
      return tip;
    }

    if (def.arc) { /* 弓：整段弧 + 弦 */
      var r = def.len / 2;
      var a0 = ang + HALF_PI - 1.25, a1 = ang + HALF_PI + 1.25;
      ctx.strokeStyle = def.color;
      ctx.lineWidth = def.w;
      ctx.beginPath(); ctx.arc(h.x, h.y, r, a0, a1); ctx.stroke();
      var p0 = { x: h.x + Math.sin(a0) * r, y: h.y + Math.cos(a0) * r };
      var p1 = { x: h.x + Math.sin(a1) * r, y: h.y + Math.cos(a1) * r };
      ctx.strokeStyle = 'rgba(245,245,235,0.75)';
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      trace(p0.x, p0.y); trace(p1.x, p1.y);
      tip = { x: h.x + dx * r, y: h.y + dy * r };
      if (near) sk.propTip = tip;
      return tip;
    }

    if (def.blade) { /* 剑/匕：握柄 + 护手 + 锥形刀刃 */
      var g0 = { x: h.x - dx * def.grip, y: h.y - dy * def.grip };
      ctx.strokeStyle = '#5a4632';
      ctx.lineWidth = def.w + 0.6;
      ctx.beginPath(); ctx.moveTo(g0.x, g0.y); ctx.lineTo(h.x, h.y); ctx.stroke();
      var gw = def.guard / 2;
      ctx.strokeStyle = def.edge || '#e8e8f0';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(h.x + px * gw, h.y + py * gw);
      ctx.lineTo(h.x - px * gw, h.y - py * gw);
      ctx.stroke();
      var hw = def.w, tw = 0.7;
      var b0 = { x: h.x + px * hw, y: h.y + py * hw };
      var b1 = { x: h.x - px * hw, y: h.y - py * hw };
      tip = { x: h.x + dx * def.len, y: h.y + dy * def.len };
      var m0 = { x: tip.x + px * tw, y: tip.y + py * tw };
      var m1 = { x: tip.x - px * tw, y: tip.y - py * tw };
      ctx.beginPath();
      ctx.moveTo(b0.x, b0.y); ctx.lineTo(m0.x, m0.y); ctx.lineTo(tip.x, tip.y);
      ctx.lineTo(m1.x, m1.y); ctx.lineTo(b1.x, b1.y); ctx.closePath();
      ctx.fillStyle = rgba(def.color, 0.92);
      ctx.fill();
      ctx.strokeStyle = shade(def.color, 1.25);
      ctx.lineWidth = 1;
      ctx.stroke();
      /* 血槽/高光：沿刀刃的一条亮线，让武器更“厚” */
      ctx.strokeStyle = rgba('#ffffff', 0.55);
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(h.x + dx * 3, h.y + dy * 3);
      ctx.lineTo(h.x + dx * def.len * 0.82, h.y + dy * def.len * 0.82);
      ctx.stroke();
      trace(tip.x, tip.y);
      base = { x: h.x + px * hw, y: h.y + py * hw };
      if (near) { sk.propTip = tip; sk.propBase = { x: h.x - px * hw, y: h.y - py * hw }; sk.propTrail = true; }
      return tip;
    }

    /* 杖 / 锤 / 铲 / 撬 / 笔：一根杆 + 端头 */
    var back = def.shaft ? 0.3 : 0.12;
    var x0 = h.x - dx * def.len * back, y0 = h.y - dy * def.len * back;
    var x1 = h.x + dx * def.len * (1 - back), y1 = h.y + dy * def.len * (1 - back);
    trace(x0, y0); trace(x1, y1);
    ctx.strokeStyle = def.color;
    ctx.lineWidth = def.w;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    if (def.head) {
      ctx.strokeStyle = def.headColor || '#9aa3b8';
      ctx.lineWidth = def.w + 1.6;
      ctx.beginPath();
      ctx.moveTo(x1 - px * def.head / 2, y1 - py * def.head / 2);
      ctx.lineTo(x1 + px * def.head / 2, y1 + py * def.head / 2);
      ctx.stroke();
      trace(x1 + px * def.head / 2, y1 + py * def.head / 2);
    }
    if (def.spike) {
      ctx.strokeStyle = def.color; ctx.lineWidth = def.w + 1;
      ctx.beginPath();
      ctx.moveTo(x1 - px * 5, y1 - py * 5); ctx.lineTo(x1 + px * 5, y1 + py * 5);
      ctx.stroke();
    }
    if (def.feather) {
      ctx.fillStyle = rgba('#ffffff', 0.7);
      ctx.beginPath();
      ctx.ellipse(x0, y0, 5, 2.2, -ang, 0, Math.PI * 2);
      ctx.fill();
    }
    if (def.cap) {
      var pulse = 4.6 + Math.sin(actor.t * 7) * 1.2;
      ctx.fillStyle = rgba(def.capColor || '#8cdcff', 0.35);
      ctx.beginPath(); ctx.arc(x1, y1, def.cap + pulse, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = rgba(def.capColor || '#8cdcff', 0.95);
      ctx.beginPath(); ctx.arc(x1, y1, def.cap, 0, Math.PI * 2); ctx.fill();
      trace(x1 - (def.cap + pulse), y1);
    }
    if (near && (def.head || def.spike)) { sk.propTip = { x: x1, y: y1 }; sk.propBase = { x: x0, y: y0 }; sk.propTrail = true; }
    return { x: x1, y: y1 };
  }

  /* 挥砍轨迹：按刀尖历史撒一条细渐隐弧带（速度快→明显，静止→自动消失） */
  function bladeTrail(ctx, actor, tip, base) {
    if (!tip || !base) return;
    var t = actor.t;
    var hist = actor._wt;
    if (!hist || t < hist.lastT) { hist = actor._wt = []; }
    hist.lastT = t;
    /* 起点往刀尖方向收，缎带才不会糊成大扇形 */
    var bx = base.x + (tip.x - base.x) * 0.45;
    var by = base.y + (tip.y - base.y) * 0.45;
    hist.push({ t: t, x: tip.x, y: tip.y, bx: bx, by: by });
    while (hist.length > 12) hist.shift();
    var span = 0.18;
    while (hist.length > 1 && t - hist[0].t > span) hist.shift();
    if (hist.length < 2) return;
    for (var i = 1; i < hist.length; i++) {
      var a = hist[i - 1], b = hist[i];
      var k = i / hist.length;
      var dx = b.x - a.x, dy = b.y - a.y;
      var step = Math.sqrt(dx * dx + dy * dy);
      if (step < 0.8) continue;
      ctx.globalAlpha = clamp(k * k * 0.26 * Math.min(1, step / 7), 0, 0.3);
      ctx.fillStyle = '#cdd8f2';
      ctx.beginPath();
      ctx.moveTo(a.bx, a.by); ctx.lineTo(a.x, a.y);
      ctx.lineTo(b.x, b.y); ctx.lineTo(b.bx, b.by);
      ctx.closePath(); ctx.fill();
      /* 前缘亮线：让轨迹读起来像刀风而不是一团雾 */
      ctx.globalAlpha = clamp(k * 0.5, 0, 0.55);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(b.bx, b.by); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawFigure(actor) {
    var ctx = state.ctx;
    if (!ctx) return;
    var p = actorPose(actor);
    var gy = groundY();
    var s = actor.scale || 1;
    var near = actor.color || '#e8e8e8';
    var far = shade(near, 0.62);
    var hx = actor.x * state.W;
    var sgn = actor.flip ? -1 : 1;
    var a = ACTIONS[actor.action];
    var plant = !a || a.plant !== false;
    var sk = build(p);
    var STAND = BODY.thigh + BODY.shin;
    /* plant=true：按双腿最低点自动决定骨盆高度（脚永远踩地）；false：以站立高度为基准，由 hop/py 决定腾空 */
    var hipY = gy - (plant ? sk.drop : STAND) + p.py - p.hop;

    /* 地面 + 影子 */
    if (state.showGround) {
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(12, gy); ctx.lineTo(state.W - 12, gy); ctx.stroke();
    }
    var air = clamp((p.hop - p.py) / 26, 0, 1);
    ctx.fillStyle = 'rgba(0,0,0,' + (0.32 - air * 0.18) + ')';
    ctx.beginPath();
    ctx.ellipse(hx, gy + 5, (24 - air * 8) * s, (3.6 - air * 1.2) * s, 0, 0, Math.PI * 2);
    ctx.fill();

    /* 特效标记（连续型：slash/glow/ring/rune/streak/shot/zzz）；prog = 本动作已走完的比例 */
    var fxHold = {};
    var tt = 0;
    if (a && a.fx) {
      var dur = actionDur(actor.action);
      tt = clamp(actor.t / Math.max(0.001, dur), 0, 1);
      for (var fi = 0; fi < a.fx.length; fi++) {
        var f = a.fx[fi];
        if (['slash', 'glow', 'aura', 'ring', 'rune', 'streak', 'shot', 'zzz'].indexOf(f.kind) >= 0 && tt >= f.t) fxHold[f.kind] = f;
      }
    }

    ctx.save();
    ctx.translate(hx, hipY);
    if (actor.flip) ctx.scale(-1, 1);
    ctx.scale(s, s);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = clamp(p.alpha, 0, 1) * (actor.alpha == null ? 1 : actor.alpha);
    state._markFn = function (x, y) { mark(hx + x * sgn * s, hipY + y * s); };

    function T(pt) { trace(pt.x, pt.y); }
    [sk.hpN, sk.hpF, sk.pelvis, sk.chest, sk.neck, sk.head,
      sk.armN.joint, sk.armN.end, sk.armF.joint, sk.armF.end,
      sk.legN.joint, sk.legN.end, sk.legF.joint, sk.legF.end].forEach(T);

    /* 远侧肢体：髋→膝→踝（大腿不能漏）+ 肩→肘→腕（上臂不能漏） */
    strokeLine(ctx, [sk.hpF, sk.legF.joint, sk.legF.end], 3.6, far);
    if (sk.legF.foot) strokeLine(ctx, [sk.legF.end, sk.legF.foot], 2.9, far);
    strokeLine(ctx, [sk.shF, sk.armF.joint, sk.armF.end], 3.1, far);
    drawProp(ctx, sk, actor, false);

    /* 躯干：可弯脊柱（骨盆→胸→颈）+ 髋线 + 肩线，经典火柴人读法 */
    strokeLine(ctx, [sk.pelvis, sk.chest, sk.neck], 5.2, near);
    strokeLine(ctx, [sk.hpF, sk.hpN], 3.2, near);
    strokeLine(ctx, [sk.shF, sk.shN], 3.2, near);
    ctx.fillStyle = near;
    ctx.beginPath(); ctx.arc(sk.pelvis.x, sk.pelvis.y, 3.1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(sk.chest.x, sk.chest.y, 2.4, 0, Math.PI * 2); ctx.fill();
    /* 颈 */
    strokeLine(ctx, [sk.neck, sk.head], 3, near);
    /* 头（实心 + 朝向指示） */
    ctx.fillStyle = near;
    ctx.beginPath();
    ctx.arc(sk.head.x, sk.head.y, BODY.headR, 0, Math.PI * 2);
    ctx.fill();
    var ha = p.lean + p.bend + p.head;
    var fx0 = Math.cos(ha), fy0 = Math.sin(ha);
    ctx.fillStyle = near;
    ctx.beginPath();
    ctx.arc(sk.head.x + fx0 * BODY.headR * 0.92, sk.head.y + fy0 * BODY.headR * 0.92, 1.9, 0, Math.PI * 2);
    ctx.fill();
    /* 肩线 */
    strokeLine(ctx, [sk.shF, sk.shN], 2.6, near);

    /* 近侧肢体：完整两段，大腿与上臂都要画出来 */
    strokeLine(ctx, [sk.hpN, sk.legN.joint, sk.legN.end], 3.9, near);
    if (sk.legN.foot) strokeLine(ctx, [sk.legN.end, sk.legN.foot], 3.1, near);
    strokeLine(ctx, [sk.shN, sk.armN.joint, sk.armN.end], 3.3, near);
    /* 关节点（膝/肘也点上，关节可动才看得出来） */
    ctx.fillStyle = near;
    [[sk.armN.end, 2.9], [sk.legN.end, 2.6], [sk.armN.joint, 2.2], [sk.legN.joint, 2.4]].forEach(function (q) {
      ctx.beginPath(); ctx.arc(q[0].x, q[0].y, q[1], 0, Math.PI * 2); ctx.fill();
    });
    ctx.fillStyle = far;
    [[sk.armF.end, 2.5], [sk.legF.end, 2.3], [sk.armF.joint, 1.9], [sk.legF.joint, 2.0]].forEach(function (q) {
      ctx.beginPath(); ctx.arc(q[0].x, q[0].y, q[1], 0, Math.PI * 2); ctx.fill();
    });
    drawProp(ctx, sk, actor, true);

    /* 连续特效 */
    if (fxHold.slash) {
      var hd = sk.armF.end, hj = sk.armF.joint;
      var ang2 = Math.atan2(hd.x - hj.x, hd.y - hj.y);
      ctx.strokeStyle = 'rgba(207,216,255,0.55)';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.arc(hd.x, hd.y, 34, ang2 + HALF_PI - 1.15, ang2 + HALF_PI + 0.5);
      ctx.stroke();
    }
    /* 挥砍轨迹：只有会砍的道具（刀剑锤镐）才留刀风，法杖/弓不糊屏 */
    if (sk.propTrail) bladeTrail(ctx, actor, sk.propTip, sk.propBase);
    if (fxHold.streak) {
      var hd2 = sk.armF.end;
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(hd2.x, hd2.y); ctx.lineTo(hd2.x + 26, hd2.y); ctx.stroke();
    }
    if (fxHold.glow) {
      var gsrc = fxHold.glow.on === 'handR' ? sk.armF.end : sk.armN.end;
      var gc = fxHold.glow.color || '#8cdcff';
      var gpulse = 1 + Math.sin(actor.t * 9) * 0.18;
      ctx.fillStyle = rgba(gc, 0.16);
      ctx.beginPath(); ctx.arc(gsrc.x, gsrc.y, 20 * gpulse, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = rgba(gc, 0.4);
      ctx.beginPath(); ctx.arc(gsrc.x, gsrc.y, 11 * gpulse, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = rgba('#ffffff', 0.95);
      ctx.beginPath(); ctx.arc(gsrc.x, gsrc.y, 4.6, 0, Math.PI * 2); ctx.fill();
    }
    /* 蓄力圈：从小长大，随蓄力时间推进，外圈走一整圈进度弧 */
    if (fxHold.ring || fxHold.aura) {
      var fr = fxHold.ring || fxHold.aura;
      var pr = clamp((tt - fr.t) / Math.max(0.001, 1 - fr.t), 0, 1);
      var cxr = 0, cyr = sk.chest.y - 2;
      var R = 8 + 42 * pr;
      var col = fr.color || '#ff9a5c';
      ctx.strokeStyle = rgba(col, 0.22 + 0.45 * pr);
      ctx.lineWidth = 1.4 + 2.8 * pr;
      ctx.beginPath(); ctx.arc(cxr, cyr, R, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = rgba('#ffe6b0', 0.9);
      ctx.lineWidth = 2.2 + 1.8 * pr;
      ctx.beginPath(); ctx.arc(cxr, cyr, R, -HALF_PI, -HALF_PI + Math.PI * 2 * pr); ctx.stroke();
      ctx.strokeStyle = rgba(col, 0.3 + 0.3 * pr);
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(cxr, cyr, R * 0.62, Math.PI * 2 * pr, Math.PI * 2 * pr + 4.4); ctx.stroke();
      for (var tk = 0; tk < 8; tk++) {
        var ta = tk * Math.PI / 4 + actor.t * 1.6;
        var t0 = R * 0.78, t1 = R * (0.86 + 0.1 * pr);
        ctx.strokeStyle = rgba(col, 0.25 + 0.5 * pr);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(cxr + Math.cos(ta) * t0, cyr + Math.sin(ta) * t0);
        ctx.lineTo(cxr + Math.cos(ta) * t1, cyr + Math.sin(ta) * t1);
        ctx.stroke();
      }
      ctx.fillStyle = rgba(col, 0.35 + 0.4 * pr);
      ctx.beginPath(); ctx.arc(cxr, cyr, 2.6 + 5.4 * pr, 0, Math.PI * 2); ctx.fill();
    }
    /* 法阵：夸张版——三层反转圆环 + 内嵌多边形 + 六个游动光点 + 释放闪光 */
    if (fxHold.rune) {
      var fq = fxHold.rune;
      var prq = clamp((tt - fq.t) / Math.max(0.001, 1 - fq.t), 0, 1);
      var rcx = sk.chest.x, rcy = sk.chest.y + 4;
      var colq = fq.color || '#8cdcff';
      var Rq = (18 + 26 * prq) * (1 + 0.06 * Math.sin(actor.t * 6));
      ctx.save();
      ctx.translate(rcx, rcy);
      for (var ri = 0; ri < 3; ri++) {
        var rr = Rq * (0.5 + ri * 0.3);
        var rot = actor.t * (ri % 2 ? -1.9 : 2.6) + ri;
        ctx.save();
        ctx.rotate(rot);
        ctx.strokeStyle = rgba(colq, 0.5 - ri * 0.1);
        ctx.lineWidth = 2.2 - ri * 0.5;
        ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2); ctx.stroke();
        if (ri < 2) {
          var sides = ri === 0 ? 3 : 6;
          ctx.beginPath();
          for (var si = 0; si <= sides; si++) {
            var sa = si * Math.PI * 2 / sides;
            var sx = Math.cos(sa) * rr * 0.86, sy = Math.sin(sa) * rr * 0.86;
            if (si === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
          }
          ctx.strokeStyle = rgba(colq, 0.34);
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
        ctx.restore();
      }
      for (var mi = 0; mi < 6; mi++) {
        var ma = actor.t * 3.2 + mi * Math.PI / 3;
        var mr = Rq * (0.86 + 0.12 * Math.sin(actor.t * 5 + mi));
        ctx.fillStyle = rgba('#ffffff', 0.85);
        ctx.beginPath(); ctx.arc(Math.cos(ma) * mr, Math.sin(ma) * mr, 2.1, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = rgba(colq, 0.35);
        ctx.beginPath(); ctx.arc(Math.cos(ma) * mr, Math.sin(ma) * mr, 5, 0, Math.PI * 2); ctx.fill();
      }
      if (prq > 0.55) {
        var fl = (prq - 0.55) / 0.45;
        ctx.fillStyle = rgba('#ffffff', 0.2 * (1 - fl));
        ctx.beginPath(); ctx.arc(0, 0, Rq * (1 + fl * 1.6), 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
    if (fxHold.shot) {
      ctx.strokeStyle = 'rgba(255,240,200,0.85)';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(sk.armF.end.x + 14, sk.armF.end.y);
      ctx.lineTo(sk.armF.end.x + 32, sk.armF.end.y);
      ctx.stroke();
    }
    ctx.restore();
    state._markFn = null;
    ctx.globalAlpha = 1;

    /* 世界坐标特效 */
    if (fxHold.zzz) {
      var hp = anchorPoint(sk, 'head', hipY, hx, sgn, s);
      ctx.fillStyle = 'rgba(200,220,255,0.6)';
      ctx.font = (9 * s) + 'px monospace';
      ctx.fillText('z', hp.x + 6 * sgn, hp.y - 12 - (actor.t % 1) * 6);
    }
    runFx(actor, sk, hipY, hx, sgn, s, actor._prevT || 0, actor.t);
    actor._prevT = actor.t;
    updateTrail(actor, sk, hipY, hx, sgn, s);
    drawTrail(state.ctx, actor);
  }

  function draw() {
    var ctx = state.ctx;
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(state.dpr || 1, 0, 0, state.dpr || 1, 0, 0);
    ctx.clearRect(0, 0, state.W, state.H);
    if (state.bg) { ctx.fillStyle = state.bg; ctx.fillRect(0, 0, state.W, state.H); }
    if (state._record) state._bbox = null;
    /* 远→近：scale 小的先画 */
    var order = state.actors.slice().sort(function (a, b) { return (a.scale || 1) - (b.scale || 1); });
    for (var i = 0; i < order.length; i++) {
      if (!order[i].hidden) drawFigure(order[i]);
    }
    drawParticles(ctx);
    ctx.restore();
  }

  /* ---------------- 循环 ---------------- */
  function loop(ts) {
    if (!state.running) return;
    var dt = 0;
    if (state.lastTs) {
      dt = clamp((ts - state.lastTs) / 1000, 0, 0.05) * state.speed;
      for (var i = 0; i < state.actors.length; i++) {
        state.actors[i].t += 0;
        advance(state.actors[i], dt);
      }
      updateParticles(dt);
    }
    state.lastTs = ts;
    draw();
    state.raf = requestAnimationFrame(loop);
  }
  function start() {
    if (state.running) return;
    state.running = true;
    state.lastTs = 0;
    state.raf = requestAnimationFrame(loop);
  }
  function stop() {
    state.running = false;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
  }

  /* ---------------- 尺寸 ---------------- */
  function resize() {
    if (!state.canvas) return;
    var parent = state.canvas.parentElement;
    var w = (parent && parent.clientWidth) || state.W || 700;
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    state.dpr = dpr;
    state.W = Math.max(200, w);
    state.H = Math.max(90, state._h || 150);
    state.canvas.width = Math.round(state.W * dpr);
    state.canvas.height = Math.round(state.H * dpr);
    state.canvas.style.width = '100%';
    state.canvas.style.height = state.H + 'px';
    state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function normActor(a, i) {
    var act = (a.action && (ACTIONS[a.action] || a.action === 'custom')) ? a.action : 'idle';
    var def = ACTIONS[act];
    var prop = a.prop || (def && def.weaponDefault) || null;
    return {
      id: a.id || 'actor' + i,
      x: a.x != null ? clamp(a.x, 0, 1) : 0.5,
      scale: a.scale || 1,
      color: a.color || '#e8e8e8',
      flip: !!a.flip,
      alpha: a.alpha == null ? 1 : a.alpha,
      action: act,
      prop: prop,
      propExplicit: !!a.prop,
      hidden: !!a.hidden,
      customPose: a.customPose || null,
      t: a.t || 0, blendFrom: null, blendT: 1, _settled: false, _fxDone: {}, _prevT: 0,
    };
  }

  function ensureDefault() {
    if (!state.actors.length) state.actors.push(normActor({ id: 'hero', x: 0.5 }, 0));
  }

  function attach(canvas, opts) {
    if (!canvas) return;
    state.canvas = canvas;
    state.ctx = canvas.getContext('2d');
    opts = opts || {};
    state._h = opts.height || 150;
    state.bg = opts.bg || null;
    state.showGround = opts.ground !== false;
    if (opts.speed) state.speed = opts.speed;
    resize();
    if (typeof ResizeObserver !== 'undefined') {
      try { new ResizeObserver(resize).observe(canvas.parentElement || canvas); } catch (e) { /* ignore */ }
    }
    if (!state.actors.length) ensureDefault();
    start();
  }
  function reset() { state.actors = []; state.particles = []; state.trails = {}; ensureDefault(); }
  function scene(list) {
    state.actors = (list || []).map(normActor);
    state.trails = {};
    if (!state.actors.length) ensureDefault();
  }
  function addActor(def) {
    var a = normActor(def || {}, state.actors.length);
    state.actors.push(a);
    return a.id;
  }
  function removeActor(id) {
    state.actors = state.actors.filter(function (a) { return a.id !== id; });
    delete state.trails[id];
    if (!state.actors.length) ensureDefault();
  }
  function setActor(id, props) {
    var a = typeof id === 'object' ? id : byId(id);
    if (!a) return null;
    for (var k in props) if (props.hasOwnProperty(k)) {
      if (k === 'action') { setAction(a, props[k]); continue; }
      if (k === 'prop') { a.prop = props[k] || null; a.propExplicit = !!props[k]; continue; }
      a[k] = props[k];
    }
    if (props.x != null) a.x = clamp(a.x, 0, 1);
    if (props.scale != null) a.scale = clamp(a.scale, 0.3, 3);
    return a;
  }
  function actorAction(id, name, delay) {
    var a = byId(id);
    if (!a) return;
    if (delay) {
      setTimeout(function () { var b = byId(id); if (b) setAction(b, name); }, delay);
    } else setAction(a, name);
  }
  function playAll(name) {
    for (var i = 0; i < state.actors.length; i++) setAction(state.actors[i], name);
    start();
  }
  function play(name) { playAll(name); }
  function setSpeed(v) { state.speed = clamp(v || 1, 0.1, 4); }
  function setBlend(v) { state.blend = clamp(v == null ? 0.14 : v, 0, 1); }
  function setCustomPose(id, patch) {
    var a = byId(id);
    if (!a) return null;
    var base = a.customPose ? copyPose(a.customPose) : copyPose(NEUTRAL);
    for (var k in patch) if (patch.hasOwnProperty(k) && KEYS.indexOf(k) >= 0) base[k] = patch[k];
    a.customPose = base;
    if (a.action !== 'custom') setAction(a, 'custom');
    return base;
  }
  function define(name, spec) {
    if (!name || !spec || !spec.frames) return false;
    ACTIONS[name] = spec;
    invalidate(name);
    return true;
  }
  function listActions() { return Object.keys(ACTIONS); }

  /* ---------------- 图片导出 ---------------- */
  function offscreen(w, h, bg) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var x = c.getContext('2d');
    if (bg) { x.fillStyle = bg; x.fillRect(0, 0, w, h); }
    return c;
  }
  /* 在离屏画布上渲染「单个动作的某一时刻」，返回该画布 */
  function renderCell(name, t, w, h, scale, color, prop) {
    var cell = offscreen(w, h, null);
    var cctx = cell.getContext('2d');
    var savedCtx = state.ctx, savedActors = state.actors, savedTrails = state.trails, savedP = state.particles;
    state.ctx = cctx;
    state.trails = {};
    state.particles = [];
    state.actors = [normActor({ id: '_cell', x: 0.5, color: color || '#e8e8e8', action: name, prop: prop || null }, 0)];
    state.actors[0].t = t;
    state.actors[0].blendT = 1;
    cctx.setTransform(scale, 0, 0, scale, 0, 0);
    draw();
    state.ctx = savedCtx; state.actors = savedActors; state.trails = savedTrails; state.particles = savedP;
    return cell;
  }

  /* 把当前舞台（含所有角色）导出为 PNG dataURL */
  function exportPNG(opts) {
    opts = opts || {};
    var scale = opts.scale || 2;
    var w = Math.round(state.W * scale), h = Math.round(state.H * scale);
    var out = offscreen(w, h, opts.bg || '#17161A');
    var octx = out.getContext('2d');
    var savedCtx = state.ctx;
    octx.save();
    octx.scale(scale, scale);
    state.ctx = octx;
    draw();
    state.ctx = savedCtx;
    octx.restore();
    /* draw() 会 clearRect 掉底色，这里把背景垫回图形下方 */
    octx.save();
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.globalCompositeOperation = 'destination-over';
    octx.fillStyle = opts.bg || '#17161A';
    octx.fillRect(0, 0, w, h);
    octx.restore();
    if (opts.label !== false) {
      octx.fillStyle = 'rgba(255,255,255,0.5)';
      octx.font = Math.round(11 * scale) + 'px ui-monospace, monospace';
      var names = state.actors.map(function (a) { return a.id + ':' + a.action + (a.prop ? '/' + a.prop : ''); }).join('  ');
      octx.fillText(names.slice(0, 120), 8 * scale, h - 8 * scale);
    }
    return out.toDataURL('image/png');
  }
  /* 单个动作的关键帧条 */
  function exportStrip(name, opts) {
    opts = opts || {};
    var phases = opts.phases || 4;
    var scale = opts.scale || 1.4;
    var act = ACTIONS[name] ? name : 'idle';
    var dur = actionDur(act);
    var w = Math.round(state.W * scale), h = Math.round(state.H * scale);
    var out = offscreen(w * phases, h + 22, opts.bg || '#17161A');
    var octx = out.getContext('2d');
    for (var i = 0; i < phases; i++) {
      var cell = renderCell(act, dur * ((i + 0.5) / phases), w, h, scale, opts.color, opts.prop);
      octx.drawImage(cell, i * w, 0);
      octx.strokeStyle = 'rgba(255,255,255,0.08)';
      octx.beginPath(); octx.moveTo(i * w, 0); octx.lineTo(i * w, h); octx.stroke();
    }
    octx.fillStyle = 'rgba(255,255,255,0.6)';
    octx.font = '13px ui-monospace, monospace';
    octx.fillText(act + ' · ' + dur.toFixed(2) + 's · ' + phases + ' frames', 8, h + 16);
    return out.toDataURL('image/png');
  }
  /* 连续帧动图条：同一个角色按时间推进，能看到挥砍轨迹与蓄力圈的生长 */
  function exportMotion(name, opts) {
    opts = opts || {};
    var n = opts.frames || 6;
    var scale = opts.scale || 1.1;
    var act = ACTIONS[name] ? name : 'idle';
    var dur = actionDur(act);
    var w = Math.round(state.W * scale), h = Math.round(state.H * scale);
    var out = offscreen(w * n, h + 20, opts.bg || '#17161A');
    var octx = out.getContext('2d');
    var savedCtx = state.ctx, savedActors = state.actors, savedTrails = state.trails, savedP = state.particles;
    var cell = offscreen(w, h, null);
    var cctx = cell.getContext('2d');
    state.trails = {}; state.particles = [];
    state.actors = [normActor({ id: 'm', x: 0.5, color: opts.color || '#e8e8e8', action: act, prop: opts.prop }, 0)];
    var a = state.actors[0];
    a.blendT = 1;
    for (var i = 0; i < n; i++) {
      a.t = dur * ((i + 1) / n);
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.fillStyle = opts.bg || '#17161A';
      cctx.fillRect(0, 0, w, h);
      cctx.setTransform(scale, 0, 0, scale, 0, 0);
      state.ctx = cctx;
      draw();
      octx.drawImage(cell, i * w, 0);
      octx.strokeStyle = 'rgba(255,255,255,0.07)';
      octx.beginPath(); octx.moveTo(i * w, 0); octx.lineTo(i * w, h); octx.stroke();
    }
    state.ctx = savedCtx; state.actors = savedActors; state.trails = savedTrails; state.particles = savedP;
    octx.fillStyle = 'rgba(255,255,255,0.6)';
    octx.font = '12px ui-monospace, monospace';
    octx.fillText(act + ' · ' + dur.toFixed(2) + 's · 连续 ' + n + ' 帧（含轨迹）', 8, h + 15);
    return out.toDataURL('image/png');
  }

  /* 全动作接触表（评审 / 动作手册导出） */
  function exportSheet(opts) {
    opts = opts || {};
    var names = opts.actions || Object.keys(ACTIONS);
    var per = opts.phases || 3;
    var scale = opts.scale || 0.9;
    var w = Math.round(state.W * scale), h = Math.round(state.H * scale);
    var rowH = h + 18;
    var out = offscreen(w * per, rowH * names.length, opts.bg || '#17161A');
    var octx = out.getContext('2d');
    for (var r = 0; r < names.length; r++) {
      var name = names[r];
      var dur = actionDur(name);
      for (var c = 0; c < per; c++) {
        octx.drawImage(renderCell(name, dur * ((c + 0.5) / per), w, h, scale, opts.color), c * w, r * rowH);
      }
      octx.fillStyle = 'rgba(255,255,255,0.55)';
      octx.font = '12px ui-monospace, monospace';
      octx.fillText(name, 4, r * rowH + h + 13);
    }
    return out.toDataURL('image/png');
  }

  /* ---------------- 姿态 JSON（供 UI 滑杆/存档） ---------------- */
  function poseToJSON(p) { return copyPose(p || NEUTRAL); }
  function neutralPose() { return copyPose(NEUTRAL); }

  function limbEnds(p) {
    var sk = build(p);
    return {
      nearHand: sk.armN.end, farHand: sk.armF.end,
      nearFoot: sk.legN.end, farFoot: sk.legF.end,
    };
  }

    return {
      attach: attach, resize: resize, start: start, stop: stop,
      reset: reset, scene: scene, addActor: addActor, removeActor: removeActor,
      setActor: setActor, actorAction: actorAction, play: play, playAll: playAll,
      setSpeed: setSpeed, setBlend: setBlend, setCustomPose: setCustomPose,
      define: define, listActions: listActions, samplePose: samplePose,
      exportPNG: exportPNG, exportStrip: exportStrip, exportSheet: exportSheet,
      exportMotion: exportMotion, neutralPose: neutralPose, poseToJSON: poseToJSON,
      actors: function () { return state.actors; },
      state: state, actions: ACTIONS, BODY: BODY, KEYS: KEYS,
      _test: {
        lerpPose: lerpPose, framesPose: framesPose, samplePose: samplePose,
        poseAt: function (actor) { return actorPose(actor); },
        build: build, draw: draw, limbEnds: limbEnds, actionDur: actionDur,
        advance: advance, setAction: setAction, K: K,
        bbox: function () { state._record = true; draw(); state._record = false; return state._bbox; },
      },
    };
  }

  /* ---------------- 默认舞台（兼容 v3 的单例调用方式） ---------------- */
  var def = makeStage();

  /* 纯函数门面：动作库是共享数据，不属于任何一个舞台 */
  function define(name, spec) {
    if (!name || !spec || !spec.frames) return false;
    ACTIONS[name] = spec;
    invalidate(name);
    return true;
  }
  function listActions() { return Object.keys(ACTIONS); }
  function samplePose(name, t) { return def.samplePose(name, t); }
  function neutralPose() { return def.neutralPose(); }
  function poseToJSON(p) { return def.poseToJSON(p); }

  function forward(name, args) {
    var st = def, fn = st[name];
    if (typeof fn !== 'function') return undefined;
    return fn.apply(st, args);
  }
  function legacy(name) {
    return function () { return forward(name, arguments); };
  }

  return {
    /* 多舞台：每个 canvas 一份独立角色/粒子/时钟，互不干扰 */
    createStage: function (canvas, opts) {
      var st = makeStage();
      if (canvas) st.attach(canvas, opts);
      return st;
    },
    define: define, listActions: listActions, samplePose: samplePose,
    actions: ACTIONS, BODY: BODY, KEYS: KEYS, PROPS: PROPS,
    /* --- 以下为 v3 兼容 API，全部走默认舞台 --- */
    attach: legacy('attach'), resize: legacy('resize'),
    start: legacy('start'), stop: legacy('stop'), reset: legacy('reset'),
    scene: legacy('scene'), play: legacy('play'), playAll: legacy('playAll'),
    actorAction: legacy('actorAction'), addActor: legacy('addActor'),
    removeActor: legacy('removeActor'), setActor: legacy('setActor'),
    setSpeed: legacy('setSpeed'), setBlend: legacy('setBlend'),
    setCustomPose: legacy('setCustomPose'),
    exportPNG: legacy('exportPNG'), exportStrip: legacy('exportStrip'),
    exportSheet: legacy('exportSheet'), exportMotion: legacy('exportMotion'),
    neutralPose: neutralPose, poseToJSON: poseToJSON,
    actors: function () { return def.actors(); },
    state: def.state,
    _test: def._test,
  };
})();
