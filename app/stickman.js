/* =========================================================
 * 火柴人动作播放器 v3（层次化关节 + 关键帧，无依赖，离线可用）
 * 借鉴 Axis 的父子关节关键帧模型，自研轻量渲染：
 * - 关节从父骨派生（肩在躯干上、肘/膝接上下肢），肢体随躯干自然联动
 * - 肘/膝单向折叠（肘向后、膝向前），不再穿模
 * - 近远景深 + 实心头 + 手脚点 + 攻击刀光 + 施法光点
 * 角度约定：dir(a) = (sin a, cos a)，0=向下，+π/2=前(右)，π=向上
 * ========================================================= */
window.Stickman = (function () {
  'use strict';

  var BODY = { torso: 31, upper: 27, lower: 27, armUpper: 19, armLower: 19, head: 8.5, shoulder: 12, hip: 5.5 };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function smooth(k) { k = clamp(k, 0, 1); return k * k * (3 - 2 * k); }
  function dir(a) { return { x: Math.sin(a), y: Math.cos(a) }; }

  /* ---------- 姿势 ---------- */
  function pose(lean, armL, armR, elbowL, elbowR, legL, legR, kneeL, kneeR, hop, alpha) {
    return {
      lean: lean || 0, armL: armL || 0, armR: armR || 0,
      elbowL: elbowL || 0, elbowR: elbowR || 0,
      legL: legL || 0, legR: legR || 0,
      kneeL: kneeL || 0, kneeR: kneeR || 0,
      hop: hop || 0, alpha: (alpha == null ? 1 : alpha),
    };
  }

  var IDLE_A = pose(0.04, 0.4, -0.4, 0.32, 0.26, 0.3, -0.3, 0.16, 0.14);
  var IDLE_B = pose(-0.02, 0.3, -0.3, 0.24, 0.2, -0.18, 0.18, 0.1, 0.1);
  var NEUTRAL = pose(0, 0.24, -0.24, 0.24, 0.22, 0.16, -0.16, 0.12, 0.12);

  /* ---------- 动作库（关键帧：时长秒 + 姿势） ---------- */
  var ACTIONS = {
    idle: { loop: true, frames: [[1.0, IDLE_A], [1.0, IDLE_B]] },
    walk: {
      loop: true,
      frames: [
        [0.4, pose(0.1, -0.38, 0.36, 0.22, 0.18, 0.6, -0.46, 0.55, 0.12)],
        [0.4, pose(0.1, 0.36, -0.38, 0.18, 0.22, -0.46, 0.6, 0.12, 0.55)],
      ],
    },
    run: {
      loop: true,
      frames: [
        [0.24, pose(0.3, -0.62, 0.6, 0.26, 0.22, 0.95, -0.66, 0.85, 0.18, 0.14)],
        [0.24, pose(0.3, 0.6, -0.62, 0.22, 0.26, -0.66, 0.95, 0.18, 0.85, 0.14)],
      ],
    },
    attack: {
      loop: false,
      frames: [
        [0.2, pose(-0.14, -0.28, -2.1, 0.18, 0.9, 0.3, -0.3, 0.25, 0.25)],
        [0.13, pose(0.5, -0.7, 0.95, 0.18, 0.12, -0.4, 0.45, 0.15, 0.3)],
        [0.26, pose(0.04, -0.08, -0.3, 0.14, 0.28, 0.12, -0.12, 0.1, 0.1)],
      ],
    },
    cast: {
      loop: false,
      frames: [
        [0.26, pose(0.06, -1.85, -1.85, 0.7, 0.7, 0.34, -0.34, 0.6, 0.6)],
        [0.3, pose(0.2, -1.0, -1.0, 0.32, 0.32, 0.14, -0.14, 0.24, 0.24)],
        [0.18, pose(0.04, -0.08, -0.3, 0.14, 0.28, 0.12, -0.12, 0.1, 0.1)],
      ],
    },
    hit: {
      loop: false,
      frames: [
        [0.16, pose(-0.55, 0.95, -0.8, 0.5, 0.4, -0.5, 0.6, 0.35, 0.6)],
        [0.26, pose(-0.2, 0.45, -0.35, 0.28, 0.22, 0.16, -0.18, 0.14, 0.14)],
      ],
    },
    jump: {
      loop: false,
      frames: [
        [0.16, pose(0.22, -0.3, 0.3, 0.3, 0.3, 0.34, -0.34, 1.1, 1.1)],
        [0.22, pose(0.12, -2.7, -2.5, 0.18, 0.18, -0.14, 0.14, 0.06, 0.06, -1.7)],
        [0.2, pose(0.18, -0.3, 0.3, 0.3, 0.3, 0.26, -0.26, 0.7, 0.7)],
      ],
    },
    dodge: {
      loop: false,
      frames: [
        [0.14, pose(-0.68, 0.85, -0.6, 0.55, 0.4, -0.55, 0.45, 0.4, 0.35, 0.28)],
        [0.26, pose(0.04, -0.08, -0.3, 0.14, 0.28, 0.12, -0.12, 0.1, 0.1)],
      ],
    },
    fall: {
      loop: false,
      frames: [
        [0.16, pose(-0.55, 0.9, -0.7, 0.5, 0.35, -0.5, 0.6, 0.4, 0.6)],
        [0.28, pose(-1.6, 1.25, -1.1, 0.55, 0.45, -0.95, 1.05, 0.3, 0.5, 0, 0.85)],
        [0.5, pose(-1.6, 1.25, -1.1, 0.55, 0.45, -0.95, 1.05, 0.3, 0.5, 0, 0.25)],
      ],
    },
    win: {
      loop: false,
      frames: [
        [0.24, pose(0.08, -2.8, -2.8, 0.14, 0.14, 0.34, -0.34, 0.16, 0.16)],
        [0.15, pose(0.1, -2.7, -2.7, 0.12, 0.12, 0.22, -0.22, 0.12, 0.12, -0.4)],
        [0.2, pose(0.04, -0.08, -0.3, 0.14, 0.28, 0.12, -0.12, 0.1, 0.1)],
      ],
    },
    search: {
      loop: false,
      frames: [
        [0.3, pose(0.28, -0.7, 0.5, 0.4, 0.3, 0.2, -0.18, 0.16, 0.12)],
        [0.3, pose(0.12, 0.5, -0.6, 0.3, 0.35, -0.16, 0.18, 0.1, 0.1)],
        [0.26, pose(0.04, -0.08, -0.3, 0.14, 0.28, 0.12, -0.12, 0.1, 0.1)],
      ],
    },
    talk: {
      loop: false,
      frames: [
        [0.24, pose(0.1, -1.4, 0.25, 0.45, 0.25, 0.12, -0.12, 0.1, 0.1)],
        [0.24, pose(0.1, 0.25, -1.4, 0.25, 0.45, -0.12, 0.12, 0.1, 0.1)],
        [0.26, pose(0.04, -0.08, -0.3, 0.14, 0.28, 0.12, -0.12, 0.1, 0.1)],
      ],
    },
  };

  /* ---------- 颜色 ---------- */
  function hex2rgb(hex) {
    var h = (hex || '#e8e8e8').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function shade(hex, f) {
    var c = hex2rgb(hex);
    return 'rgb(' + Math.round(c.r * f) + ',' + Math.round(c.g * f) + ',' + Math.round(c.b * f) + ')';
  }

  /* ---------- 舞台 ---------- */
  var state = {
    canvas: null, ctx: null,
    W: 700, H: 150, raf: 0, running: false, lastTs: 0,
    actors: [], _record: false, _bbox: null,
  };
  function groundY() { return state.H - 20; }
  function byId(id) { for (var i = 0; i < state.actors.length; i++) if (state.actors[i].id === id) return state.actors[i]; return null; }
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

  function start() {
    if (state.running) return;
    state.running = true;
    state.lastTs = 0;
    state.raf = requestAnimationFrame(loop);
  }
  function loop(ts) {
    if (!state.running) return;
    if (state.lastTs) {
      var dt = (ts - state.lastTs) / 1000;
      for (var i = 0; i < state.actors.length; i++) state.actors[i].t += dt;
    }
    state.lastTs = ts;
    draw();
    state.raf = requestAnimationFrame(loop);
  }

  function attach(canvas) {
    if (!canvas) return;
    state.canvas = canvas;
    state.ctx = canvas.getContext('2d');
    resize();
    if (typeof ResizeObserver !== 'undefined') {
      try { new ResizeObserver(resize).observe(canvas.parentElement || canvas); } catch (e) { /* ignore */ }
    }
    if (!state.actors.length) ensureDefault();
    start();
  }
  function resize() {
    if (!state.canvas) return;
    var parent = state.canvas.parentElement;
    var w = (parent && parent.clientWidth) || 700;
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    state.W = Math.max(220, w);
    state.H = 150;
    state.canvas.width = Math.round(state.W * dpr);
    state.canvas.height = Math.round(state.H * dpr);
    state.canvas.style.height = state.H + 'px';
    state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---------- 角色 ---------- */
  function ensureDefault() {
    if (!state.actors.length) {
      state.actors.push({ id: 'hero', x: 0.5, scale: 1, color: '#e8e8e8', flip: false, alpha: 1, action: 'idle', t: 0 });
    }
  }
  function reset() { state.actors = []; ensureDefault(); }
  function scene(list) {
    state.actors = [];
    (list || []).forEach(function (a) {
      state.actors.push({
        id: a.id || 'actor' + state.actors.length,
        x: a.x != null ? a.x : 0.5,
        scale: a.scale || 1,
        color: a.color || '#e8e8e8',
        flip: !!a.flip,
        alpha: a.alpha == null ? 1 : a.alpha,
        action: a.action || 'idle',
        t: 0,
      });
    });
    if (!state.actors.length) ensureDefault();
  }
  function actorAction(id, name, delay) {
    var a = byId(id);
    if (!a) return;
    if (!ACTIONS[name]) name = 'idle';
    if (delay) {
      setTimeout(function () { a.action = name; a.t = 0; }, delay);
    } else {
      a.action = name;
      a.t = 0;
    }
  }
  function playAll(name) {
    for (var i = 0; i < state.actors.length; i++) {
      state.actors[i].action = ACTIONS[name] ? name : 'idle';
      state.actors[i].t = 0;
    }
    start();
  }
  function play(name) { playAll(name); }
  function stop() {
    state.running = false;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
  }

  /* ---------- 插值 ---------- */
  function lerpPose(a, b, k) {
    var o = {};
    for (var key in a) o[key] = a[key] + (b[key] - a[key]) * k;
    return o;
  }
  function frameAt(frames, tt) {
    var acc = 0;
    for (var i = 0; i < frames.length; i++) {
      var d = frames[i][0];
      if (tt <= acc + d) {
        var f0 = frames[i][1];
        var f1 = frames[(i + 1) % frames.length][1];
        var k = d > 0 ? smooth((tt - acc) / d) : 1;
        return lerpPose(f0, f1, k);
      }
      acc += d;
    }
    return frames[frames.length - 1][1];
  }
  function poseAt(actor) {
    var a = ACTIONS[actor.action];
    if (!a) return NEUTRAL;
    var dur = 0;
    for (var i = 0; i < a.frames.length; i++) dur += a.frames[i][0];
    var tt = actor.t;
    if (a.loop) {
      tt = actor.t % dur;
    } else if (actor.t >= dur + 0.4) {
      actor.action = 'idle';
      actor.t = 0;
      tt = 0;
    } else {
      tt = Math.min(actor.t, dur);
    }
    return frameAt(a.frames, tt);
  }

  /* ---------- 关节弯曲（肘向后、膝向前，单向折叠） ---------- */
  function elbowFold(a, bend) {
    var sgn = (a > 0.15) ? 1 : (a < -0.15 ? -1 : 1);
    return a - bend * sgn;
  }
  function kneeFold(a, bend) { return a - bend; }

  /* ---------- 绘制 ---------- */
  function limb(ctx, jx, jy, a1, l1, a2, l2, width, color, joint) {
    var d1 = dir(a1);
    var x1 = jx + d1.x * l1;
    var y1 = jy + d1.y * l1;
    var d2 = dir(a2);
    var x2 = x1 + d2.x * l2;
    var y2 = y1 + d2.y * l2;
    trace(jx, jy); trace(x1, y1); trace(x2, y2);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(jx, jy);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    if (joint) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x1, y1, 2.4 * (width / 3), 0, Math.PI * 2);
      ctx.fill();
    }
    return { x: x2, y: y2 };
  }
  function seg(ctx, x1, y1, x2, y2, width, color) {
    trace(x1, y1); trace(x2, y2);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  function trace(x, y) { if (state._markFn) state._markFn(x, y); }

  function drawFigure(actor, p) {
    var ctx = state.ctx;
    var gy = groundY();
    var s = actor.scale || 1;
    var near = actor.color || '#e8e8e8';
    var far = near; /* 统一配色，深度只靠错位表达 */
    var hx = actor.x * state.W;
    var a = actor.action;

    /* 地面与影子（屏幕坐标） */
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(14, gy);
    ctx.lineTo(state.W - 14, gy);
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(hx, gy + 6, 27 * s, 4 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(hx, 0);
    if (actor.flip) ctx.scale(-1, 1);
    ctx.scale(s, s);
    ctx.lineCap = 'round';
    ctx.globalAlpha = (p.alpha == null ? 1 : p.alpha) * (actor.alpha == null ? 1 : actor.alpha);
    var flipSign = actor.flip ? -1 : 1;
    state._markFn = function (x, y) { mark(hx + x * flipSign * s, y * s); };

    var baseY = gy / s;
    var hy = baseY - BODY.upper - BODY.lower + p.hop * 9;
    var lean = p.lean;
    var ndx = Math.sin(lean);
    var ndy = -Math.cos(lean);
    var neckX = ndx * BODY.torso;
    var neckY = hy + ndy * BODY.torso;
    var headX = neckX + ndx * (BODY.head * 0.8);
    var headY = neckY + ndy * (BODY.head * 0.8);
    var shX = ndx * BODY.torso * 0.82;
    var shY = hy + ndy * BODY.torso * 0.82;

    /* 肩宽/髋宽：近侧肢体前移、远侧后移，形成横向结构 */
    var shW = BODY.shoulder, hpW = BODY.hip;
    /* 后侧肢体（深色，先画） */
    var farLeg = limb(ctx, -hpW - 0.6, hy + 1, p.legR, BODY.upper, kneeFold(p.legR, p.kneeR), BODY.lower, 3.2, far, true);
    var farArm = limb(ctx, shX - shW - 0.6, shY + 1, p.armR, BODY.armUpper, elbowFold(p.armR, p.elbowR), BODY.armLower, 3, far, false);
    /* 躯干 + 髋关节点 */
    seg(ctx, 0, hy, neckX, neckY, 4, near);
    /* 肩线（比臂距略窄，避免"十字架"）/ 髋线 */
    ctx.strokeStyle = near;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(shX - shW * 0.7, shY + 2); ctx.lineTo(shX + shW * 0.7, shY + 2); ctx.stroke();
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-hpW - 2, hy + 1); ctx.lineTo(hpW + 2, hy + 1); ctx.stroke();
    ctx.fillStyle = near;
    ctx.beginPath();
    ctx.arc(0, hy, 3.5, 0, Math.PI * 2);
    ctx.fill();
    /* 头（实心） */
    trace(headX, headY);
    ctx.fillStyle = near;
    ctx.beginPath();
    ctx.arc(headX, headY, BODY.head, 0, Math.PI * 2);
    ctx.fill();
    /* 前侧肢体（亮色，后画） */
    var nearLeg = limb(ctx, hpW + 0.6, hy, p.legL, BODY.upper, kneeFold(p.legL, p.kneeL), BODY.lower, 3.2, near, true);
    var nearArm = limb(ctx, shX + shW + 0.6, shY, p.armL, BODY.armUpper, elbowFold(p.armL, p.elbowL), BODY.armLower, 3, near, false);

    /* 手脚点（远侧深、近侧亮） */
    ctx.fillStyle = far;
    ctx.beginPath(); ctx.arc(farLeg.x, farLeg.y, 2.8, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(farArm.x, farArm.y, 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = near;
    ctx.beginPath(); ctx.arc(nearLeg.x, nearLeg.y, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(nearArm.x, nearArm.y, 3, 0, Math.PI * 2); ctx.fill();

    /* 脚部横线（站姿更明确） */
    ctx.strokeStyle = near; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(farLeg.x, farLeg.y); ctx.lineTo(farLeg.x + 8, farLeg.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(nearLeg.x, nearLeg.y); ctx.lineTo(nearLeg.x + 8, nearLeg.y); ctx.stroke();

    /* 攻击：右手挥刀 + 刀光弧 */
    if (a === 'attack') {
      var foreA = elbowFold(p.armR, p.elbowR);
      var hx2 = farArm.x;
      var hy2 = farArm.y;
      var bx = hx2 + Math.sin(foreA) * 18;
      var by = hy2 + Math.cos(foreA) * 18;
      trace(bx, by);
      ctx.strokeStyle = '#cfd8ff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(hx2, hy2);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(207,216,255,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(hx2, hy2, 30, foreA - 0.9, foreA + 0.4);
      ctx.stroke();
    }
    /* 施法：手前光点 */
    if (a === 'cast') {
      var cx = nearArm.x;
      var cy = nearArm.y;
      trace(cx, cy);
      ctx.fillStyle = 'rgba(140,220,255,0.9)';
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
    state._markFn = null;
    ctx.globalAlpha = 1;
  }

  function draw() {
    var ctx = state.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, state.W, state.H);
    if (state._record) state._bbox = null;
    for (var i = 0; i < state.actors.length; i++) {
      var a = state.actors[i];
      drawFigure(a, poseAt(a));
    }
  }

  function limbEnds(p) {
    var shW = BODY.shoulder, hpW = BODY.hip;
    function end(jx, jy, a1, l1, a2, l2) {
      var d1 = dir(a1);
      var x1 = jx + d1.x * l1;
      var y1 = jy + d1.y * l1;
      var d2 = dir(a2);
      return { x: x1 + d2.x * l2, y: y1 + d2.y * l2 };
    }
    var shX = Math.sin(p.lean) * BODY.torso * 0.82;
    var shY = -Math.cos(p.lean) * BODY.torso * 0.82;
    return {
      nearHand: end(shX + shW + 0.6, shY, p.armL, BODY.armUpper, elbowFold(p.armL, p.elbowL), BODY.armLower),
      farHand: end(shX - shW - 0.6, shY + 1, p.armR, BODY.armUpper, elbowFold(p.armR, p.elbowR), BODY.armLower),
      nearFoot: end(hpW + 0.6, 0, p.legL, BODY.upper, kneeFold(p.legL, p.kneeL), BODY.lower),
      farFoot: end(-hpW - 0.6, 1, p.legR, BODY.upper, kneeFold(p.legR, p.kneeR), BODY.lower),
    };
  }

  return {
    attach: attach,
    resize: resize,
    stop: stop,
    reset: reset,
    scene: scene,
    actorAction: actorAction,
    play: play,
    playAll: playAll,
    actions: ACTIONS,
    actors: function () { return state.actors; },
    _test: {
      lerpPose: lerpPose,
      frameAt: frameAt,
      poseAt: poseAt,
      draw: draw,
      limbEnds: limbEnds,
      bbox: function () { state._record = true; draw(); state._record = false; return state._bbox; },
    },
  };
})();
