/* =========================================================
 * 火柴人舞台组件（可挂到任意模式：离线小说 / 模块四 / 主冒险 / 书库）
 * 提供：多角色编排、动作库点选、逐通道手动调姿、文字→动作节拍、图片导出
 * 依赖：window.Stickman（引擎）、window.StickmanActions（文字推断，可缺省）
 * 自注入样式，不改动全局 CSS；实例互不干扰（引擎支持多舞台）
 * ========================================================= */
window.StickmanStage = (function () {
  'use strict';

  var CSS = [
    '.smst{--smst-bg:#141311;--smst-fg:#e8e4dc;--smst-dim:#8b857b;--smst-line:rgba(255,255,255,.09);--smst-cu:#c99b58;',
    'display:flex;flex-direction:column;gap:8px;font-size:12px;color:var(--smst-fg);background:var(--smst-bg);',
    'border:1px solid var(--smst-line);border-radius:10px;padding:10px;box-sizing:border-box}',
    '.smst *{box-sizing:border-box;font-family:inherit}',
    '.smst-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.smst-title{font-weight:600;letter-spacing:.02em}',
    '.smst-badge{font-size:10px;color:var(--smst-dim);border:1px solid var(--smst-line);border-radius:999px;padding:1px 7px}',
    '.smst-badge.on{color:#0f0e0d;background:var(--smst-cu);border-color:var(--smst-cu)}',
    '.smst-grow{flex:1 1 auto}',
    '.smst-canvas{position:relative;width:100%;border-radius:8px;overflow:hidden;background:#17161a;border:1px solid var(--smst-line)}',
    '.smst-canvas canvas{display:block;width:100%}',
    '.smst-cap{position:absolute;left:8px;top:6px;font-size:10px;color:rgba(255,255,255,.55);pointer-events:none;line-height:1.5}',
    '.smst-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
    '.smst-lbl{color:var(--smst-dim);font-size:11px;min-width:34px}',
    '.smst-btn{background:#1e1c19;color:var(--smst-fg);border:1px solid var(--smst-line);border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer}',
    '.smst-btn:hover{border-color:var(--smst-cu)}',
    '.smst-btn.on{background:var(--smst-cu);color:#12100e;border-color:var(--smst-cu);font-weight:600}',
    '.smst-chip{background:#1a1815;color:var(--smst-fg);border:1px solid var(--smst-line);border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer;white-space:nowrap}',
    '.smst-chip:hover{border-color:var(--smst-cu)}',
    '.smst-chip.on{background:var(--smst-cu);color:#12100e;border-color:var(--smst-cu)}',
    '.smst-beat{border-radius:5px;padding:2px 7px;font-size:11px;cursor:pointer;border:1px solid transparent;background:#211d17;color:#d8d2c6}',
    '.smst-beat.on{background:var(--smst-cu);color:#12100e}',
    '.smst-beats{display:flex;gap:4px;flex-wrap:wrap;max-height:74px;overflow:auto}',
    '.smst-grp{display:flex;gap:4px;flex-wrap:wrap;padding:4px 0;border-top:1px dashed var(--smst-line)}',
    '.smst-grpname{width:100%;color:var(--smst-dim);font-size:10px;letter-spacing:.08em;text-transform:uppercase}',
    '.smst-slider{display:flex;align-items:center;gap:6px;width:calc(50% - 3px)}',
    '.smst-slider input[type=range]{flex:1 1 auto;min-width:60px;accent-color:#c99b58}',
    '.smst-slider b{width:44px;text-align:right;font-weight:400;color:var(--smst-dim);font-variant-numeric:tabular-nums}',
    '.smst-sliders{display:flex;flex-wrap:wrap;gap:4px 8px}',
    '.smst-in{flex:1 1 160px;background:#1a1815;border:1px solid var(--smst-line);color:var(--smst-fg);border-radius:6px;padding:4px 7px;font-size:12px}',
    '.smst-note{color:var(--smst-dim);font-size:10px;line-height:1.5}',
    '.smst-hide{display:none!important}',
    '.smst-tabs{display:flex;gap:4px;flex-wrap:wrap}',
  ].join('');

  var SLIDERS = [
    { k: 'lean', n: '躯干前倾', lo: -1.7, hi: 1.7, st: 0.02 },
    { k: 'bend', n: '胸腰弯', lo: -0.9, hi: 0.9, st: 0.02 },
    { k: 'head', n: '头颈', lo: -0.9, hi: 0.9, st: 0.02 },
    { k: 'turn', n: '转向(0侧1正)', lo: 0, hi: 1, st: 0.05 },
    { k: 'armL', n: '左上臂', lo: -3.2, hi: 3.2, st: 0.02 },
    { k: 'elbowL', n: '左肘', lo: -2.2, hi: 2.4, st: 0.02 },
    { k: 'armR', n: '右上臂', lo: -3.2, hi: 3.2, st: 0.02 },
    { k: 'elbowR', n: '右肘', lo: -2.2, hi: 2.4, st: 0.02 },
    { k: 'legL', n: '左大腿', lo: -2.2, hi: 2.2, st: 0.02 },
    { k: 'kneeL', n: '左膝', lo: -2.6, hi: 0.4, st: 0.02 },
    { k: 'legR', n: '右大腿', lo: -2.2, hi: 2.2, st: 0.02 },
    { k: 'kneeR', n: '右膝', lo: -2.6, hi: 0.4, st: 0.02 },
    { k: 'footL', n: '左脚', lo: 0, hi: 3.1, st: 0.02 },
    { k: 'footR', n: '右脚', lo: 0, hi: 3.1, st: 0.02 },
    { k: 'px', n: '重心左右', lo: -18, hi: 18, st: 0.5 },
    { k: 'py', n: '重心高低', lo: -14, hi: 16, st: 0.5 },
    { k: 'hop', n: '腾空', lo: 0, hi: 34, st: 0.5 },
  ];
  var PROPS = ['none', 'sword', 'dagger', 'staff', 'bow', 'shield', 'book', 'cup', 'crate', 'hammer', 'shovel', 'quill', 'pick'];
  var COLORS = ['#e8e8e8', '#c99b58', '#8fae8d', '#8ec5ff', '#e07a7a', '#c9a0e8'];

  var injected = false;
  function injectCSS() {
    if (injected || typeof document === 'undefined') return;
    var s = document.createElement('style');
    s.id = 'smst-style';
    s.textContent = CSS;
    document.head.appendChild(s);
    injected = true;
  }
  function h(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(window.localStorage.getItem('smst:' + key) || 'null');
      window.localStorage.setItem('smst:' + key, JSON.stringify(val));
    } catch (e) { /* 隐私模式/无 localStorage 时忽略 */ }
    return null;
  }

  function create(target, opts) {
    opts = opts || {};
    injectCSS();
    var SM = window.Stickman;
    if (!SM) throw new Error('Stickman 未加载');
    var SA = window.StickmanActions || null;
    var key = opts.storageKey || 'default';
    var saved = store(key) || {};

    var root = h('div', 'smst');
    var host = typeof target === 'string' ? document.getElementById(target) : target;
    if (!host) throw new Error('StickmanStage: 找不到挂载点');
    host.appendChild(root);

    /* ---------- 头部 ---------- */
    var head = h('div', 'smst-head');
    head.appendChild(h('span', 'smst-title', opts.title || '火柴人舞台'));
    var modeBadge = h('span', 'smst-badge', '手动编排');
    head.appendChild(modeBadge);
    var srcBadge = h('span', 'smst-badge', '规则推断·可复核');
    head.appendChild(srcBadge);
    head.appendChild(h('span', 'smst-grow'));
    var beatBtn = h('button', 'smst-btn', '▶ 播放节拍');
    var stopBtn = h('button', 'smst-btn', '■ 停');
    var collapse = h('button', 'smst-btn', '收起');
    head.appendChild(beatBtn); head.appendChild(stopBtn); head.appendChild(collapse);
    root.appendChild(head);

    /* ---------- 画布（可复用宿主已有的 canvas，只出控制面板） ---------- */
    var cbox = h('div', 'smst-canvas');
    var cv = opts.canvas || document.createElement('canvas');
    var cap = h('div', 'smst-cap', '');
    if (opts.canvas) {
      cbox.classList.add('smst-hide');
    } else {
      cbox.appendChild(cv);
      cbox.appendChild(cap);
      root.appendChild(cbox);
    }

    var stage = SM.createStage(cv, { height: opts.height || 170 });

    /* ---------- 角色条 ---------- */
    var actorRow = h('div', 'smst-row');
    actorRow.appendChild(h('span', 'smst-lbl', '角色'));
    var actorChips = h('div', 'smst-row');
    actorRow.appendChild(actorChips);
    var addActorBtn = h('button', 'smst-btn', '＋ 加角色');
    actorRow.appendChild(addActorBtn);
    root.appendChild(actorRow);

    /* ---------- 选中角色的属性 ---------- */
    var propRow = h('div', 'smst-row');
    propRow.appendChild(h('span', 'smst-lbl', '形象'));
    var colorSel = h('select', 'smst-in');
    COLORS.forEach(function (c) { var o = h('option', null, c); o.value = c; colorSel.appendChild(o); });
    propRow.appendChild(colorSel);
    var propSel = h('select', 'smst-in');
    PROPS.forEach(function (p) { var o = h('option', null, p === 'none' ? '无道具' : p); o.value = p; propSel.appendChild(o); });
    propRow.appendChild(propSel);
    var flipBtn = h('button', 'smst-btn', '朝向');
    propRow.appendChild(flipBtn);
    var sizeSl = mkSlider('大小', 0.4, 1.8, 0.05, 1);
    propRow.appendChild(sizeSl.el);
    var posSl = mkSlider('位置', 0.05, 0.95, 0.01, 0.5);
    propRow.appendChild(posSl.el);
    root.appendChild(propRow);

    /* ---------- 动作库 ---------- */
    var libWrap = h('div', 'smst-row');
    libWrap.style.flexDirection = 'column';
    libWrap.style.alignItems = 'stretch';
    var tabs = h('div', 'smst-tabs');
    libWrap.appendChild(tabs);
    var libBody = h('div');
    libWrap.appendChild(libBody);
    root.appendChild(libWrap);

    /* ---------- 文字 → 动作 ---------- */
    var textBox = h('div', 'smst-row');
    textBox.appendChild(h('span', 'smst-lbl', '文字'));
    var ta = h('input', 'smst-in');
    ta.type = 'text';
    ta.placeholder = '把一段叙述丢进来，自动编排成动作节拍（离线规则，不调用 API）';
    textBox.appendChild(ta);
    var inferBtn = h('button', 'smst-btn', '按文字编排');
    var aiBtn = h('button', 'smst-btn', 'AI 编排');
    textBox.appendChild(inferBtn); textBox.appendChild(aiBtn);
    root.appendChild(textBox);
    var beats = h('div', 'smst-beats');
    root.appendChild(beats);
    var note = h('div', 'smst-note', '');
    root.appendChild(note);

    /* ---------- 手动调姿 ---------- */
    var poseWrap = h('div', 'smst-sliders');
    var poseHead = h('div', 'smst-row');
    var poseToggle = h('button', 'smst-btn', '手动调姿（逐关节）');
    poseHead.appendChild(poseToggle);
    var poseCopy = h('button', 'smst-btn', '复制当前姿势');
    var posePaste = h('button', 'smst-btn', '粘贴到选中角色');
    poseHead.appendChild(poseCopy); poseHead.appendChild(posePaste);
    var poseReset = h('button', 'smst-btn', '回中性');
    poseHead.appendChild(poseReset);
    poseHead.appendChild(h('span', 'smst-grow'));
    var speedSl = mkSlider('速度', 0.25, 2.5, 0.05, saved.speed || 1);
    poseHead.appendChild(speedSl.el);
    root.appendChild(poseHead);
    root.appendChild(poseWrap);
    poseWrap.classList.add('smst-hide');

    /* ---------- 导出 ---------- */
    var expRow = h('div', 'smst-row');
    expRow.appendChild(h('span', 'smst-lbl', '出图'));
    var expPng = h('button', 'smst-btn', '当前帧 PNG');
    var expStrip = h('button', 'smst-btn', '关键帧条');
    var expMotion = h('button', 'smst-btn', '连续帧(含轨迹)');
    var expSheet = h('button', 'smst-btn', '动作手册(全部)');
    expRow.appendChild(expPng); expRow.appendChild(expStrip); expRow.appendChild(expMotion); expRow.appendChild(expSheet);
    root.appendChild(expRow);

    /* ================= 逻辑 ================= */
    var sel = null;
    var beatsList = [];
    var beatTimer = 0;
    var clipPose = null;
    var sliderMap = {};

    function mkSlider(name, lo, hi, st, val) {
      var w = h('label', 'smst-slider');
      var b = h('b', null, '');
      var i = document.createElement('input');
      i.type = 'range'; i.min = lo; i.max = hi; i.step = st; i.value = val;
      var lb = h('span', 'smst-lbl', name);
      w.appendChild(lb); w.appendChild(i); w.appendChild(b);
      b.textContent = Number(val).toFixed(2);
      i.addEventListener('input', function () { b.textContent = Number(i.value).toFixed(2); });
      return { el: w, input: i, out: b, get: function () { return Number(i.value); } };
    }

    function refreshCap() {
      var a = stage.actors();
      cap.textContent = a.map(function (x) {
        return x.id + ' ' + x.action + (x.prop ? '/' + x.prop : '') + (x.flip ? ' ←' : '');
      }).join('   ');
    }
    function selected() { return stage.setActor ? findActor(sel) : null; }
    function findActor(id) {
      var a = stage.actors();
      for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i];
      return a[0] || null;
    }

    function renderActorChips() {
      actorChips.innerHTML = '';
      stage.actors().forEach(function (a) {
        var c = h('button', 'smst-chip' + (a.id === sel ? ' on' : ''), a.id);
        c.style.borderColor = a.color;
        c.onclick = function () { sel = a.id; syncFromActor(); renderLib(); };
        actorChips.appendChild(c);
        if (stage.actors().length > 1) {
          var x = h('button', 'smst-chip', '×');
          x.title = '移除该角色';
          x.onclick = function (ev) {
            ev.stopPropagation();
            stage.removeActor(a.id);
            if (sel === a.id) sel = stage.actors()[0] && stage.actors()[0].id;
            renderActorChips(); syncFromActor();
          };
          actorChips.appendChild(x);
        }
      });
    }

    function renderLib() {
      tabs.innerHTML = '';
      libBody.innerHTML = '';
      var names = stage.listActions();
      var groups = {};
      names.forEach(function (n) {
        var g = (SA && SA.META[n] && SA.META[n].group) || '其它';
        (groups[g] || (groups[g] = [])).push(n);
      });
      var gnames = Object.keys(groups);
      var active = libWrap._grp && gnames.indexOf(libWrap._grp) >= 0 ? libWrap._grp : gnames[0];
      gnames.forEach(function (g) {
        var t = h('button', 'smst-btn' + (g === active ? ' on' : ''), g + ' ' + groups[g].length);
        t.onclick = function () { libWrap._grp = g; renderLib(); };
        tabs.appendChild(t);
      });
      var box = h('div', 'smst-grp');
      box.appendChild(h('span', 'smst-grpname', active + '（点一下即播放）'));
      (groups[active] || []).forEach(function (n) {
        var zh = (SA && SA.META[n] && SA.META[n].zh) || n;
        var c = h('button', 'smst-chip' + (selected() && selected().action === n ? ' on' : ''), zh);
        c.title = n;
        c.onclick = function () { play(n); };
        box.appendChild(c);
      });
      libBody.appendChild(box);
    }

    function play(name, prop) {
      var a = selected();
      if (!a) return;
      stage.setActor(a, { action: name, prop: prop || (a.prop && a.prop !== 'none' ? a.prop : null) });
      if (prop) a.prop = prop;
      stage.start();
      refreshCap();
      renderLib();
      setMode('manual');
    }

    function setMode(m) {
      root._mode = m;
      modeBadge.textContent = m === 'auto' ? '自动跟随文本' : '手动编排';
      modeBadge.classList.toggle('on', m === 'auto');
    }

    /* ---------- 逐关节滑杆 ---------- */
    function buildSliders() {
      SLIDERS.forEach(function (s) {
        var sl = mkSlider(s.n, s.lo, s.hi, s.st, 0);
        sl.input.addEventListener('input', function () { applySliders(); });
        sliderMap[s.k] = { def: s, sl: sl };
        poseWrap.appendChild(sl.el);
      });
    }
    function applySliders() {
      var patch = {};
      Object.keys(sliderMap).forEach(function (k) { patch[k] = sliderMap[k].sl.get(); });
      var a = selected();
      if (!a) return;
      stage.setCustomPose(a.id, patch);
      stage.start();
      refreshCap();
    }
    function loadPoseIntoSliders(p) {
      Object.keys(sliderMap).forEach(function (k) {
        var o = sliderMap[k];
        var v = p[k] == null ? 0 : p[k];
        o.sl.input.value = v;
        o.sl.out.textContent = Number(v).toFixed(2);
      });
    }
    function syncFromActor() {
      var a = selected();
      if (!a) return;
      colorSel.value = a.color;
      propSel.value = a.prop || 'none';
      flipBtn.classList.toggle('on', !!a.flip);
      sizeSl.input.value = a.scale; sizeSl.out.textContent = Number(a.scale).toFixed(2);
      posSl.input.value = a.x; posSl.out.textContent = Number(a.x).toFixed(2);
      if (a.action === 'custom' && a.customPose) loadPoseIntoSliders(a.customPose);
      renderActorChips();
    }

    colorSel.onchange = function () { var a = selected(); if (a) { a.color = colorSel.value; refreshCap(); renderActorChips(); } };
    propSel.onchange = function () {
      var a = selected(); if (!a) return;
      stage.setActor(a, { prop: propSel.value === 'none' ? null : propSel.value });
      refreshCap();
    };
    flipBtn.onclick = function () { var a = selected(); if (a) { a.flip = !a.flip; flipBtn.classList.toggle('on', a.flip); refreshCap(); } };
    sizeSl.input.oninput = function () { var a = selected(); if (a) { a.scale = sizeSl.get(); refreshCap(); } };
    posSl.input.oninput = function () { var a = selected(); if (a) { a.x = posSl.get(); refreshCap(); } };
    speedSl.input.oninput = function () { stage.setSpeed(speedSl.get()); store(key, { speed: speedSl.get() }); };
    poseToggle.onclick = function () {
      poseWrap.classList.toggle('smst-hide');
      poseToggle.classList.toggle('on', !poseWrap.classList.contains('smst-hide'));
    };
    poseReset.onclick = function () { loadPoseIntoSliders(SM.neutralPose()); applySliders(); };
    poseCopy.onclick = function () {
      var a = selected(); if (!a) return;
      clipPose = SM.samplePose(a.action, a.t);
      note.textContent = '已复制 ' + a.id + ' 的当前姿势（' + a.action + '）';
    };
    posePaste.onclick = function () {
      var a = selected();
      if (!a || !clipPose) { note.textContent = '剪贴板为空：先「复制当前姿势」'; return; }
      stage.setCustomPose(a.id, clipPose);
      loadPoseIntoSliders(clipPose);
      note.textContent = '已把复制的姿势贴到 ' + a.id;
    };
    addActorBtn.onclick = function () {
      var n = stage.actors().length;
      var id = (opts.actorPrefix || 'a') + n;
      stage.addActor({ id: id, x: 0.25 + 0.5 * (n % 2), color: COLORS[n % COLORS.length], scale: n ? 0.85 : 1, flip: n % 2 === 1, action: 'idle' });
      sel = id;
      renderActorChips(); syncFromActor();
    };

    /* ---------- 文字 → 节拍 ---------- */
    function renderBeats() {
      beats.innerHTML = '';
      beatsList.forEach(function (b, i) {
        var c = h('button', 'smst-beat' + (beatsList._i === i ? ' on' : ''), (i + 1) + '.' + (b.label || b.action));
        c.title = b.reason + '\n' + b.text;
        c.onclick = function () { jumpBeat(i); };
        beats.appendChild(c);
      });
    }
    function jumpBeat(i) {
      var b = beatsList[i];
      if (!b) return;
      beatsList._i = i;
      var a = selected();
      if (a) stage.setActor(a, { action: b.action, prop: b.prop });
      note.textContent = '第 ' + (i + 1) + ' 拍 · ' + b.reason + ' · 原文：' + (b.text || '').slice(0, 40);
      renderBeats();
    }
    function setText(text) {
      if (!SA) { note.textContent = '未加载 StickmanActions，无法按文字编排'; return []; }
      beatsList = SA.sequence(text, { max: opts.maxBeats || 10 });
      beatsList._i = -1;
      renderBeats();
      note.textContent = '规则推断 ' + beatsList.length + ' 拍（可点每拍复核命中依据）；未调用任何 API';
      return beatsList;
    }
    function playBeats() {
      if (!beatsList.length) { note.textContent = '先输入文字并「按文字编排」'; return; }
      window.clearTimeout(beatTimer);
      var i = 0;
      var step = function () {
        if (i >= beatsList.length) { note.textContent = '节拍播完（' + beatsList.length + ' 拍）'; return; }
        jumpBeat(i);
        var b = beatsList[i];
        var d = (SM._test ? SM._test.actionDur(b.action) : 1) * 1000 / Math.max(0.25, speedSl.get());
        i++;
        beatTimer = window.setTimeout(step, Math.max(420, d + 120));
      };
      step();
    }
    inferBtn.onclick = function () { setText(ta.value); playBeats(); };
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter') { setText(ta.value); playBeats(); } });
    stopBtn.onclick = function () { window.clearTimeout(beatTimer); beatsList._i = -1; renderBeats(); play('idle'); };
    beatBtn.onclick = playBeats;
    aiBtn.onclick = function () {
      if (typeof window.callLLM !== 'function') { note.textContent = 'AI 编排不可用：当前模式没有 callLLM（离线规则仍可用）'; return; }
      if (!SA) return;
      note.textContent = 'AI 编排请求中…（这一步会真实调用你配置的模型）';
      SA.aiInfer(ta.value, window.callLLM).then(function (r) {
        setText(ta.value);
        beatsList.unshift({ action: r.action, prop: r.prop, label: (SA.META[r.action] || {}).zh || r.action, source: 'ai', reason: r.reason, text: ta.value.slice(0, 40), span: ta.value });
        renderBeats();
        jumpBeat(0);
        note.textContent = 'AI 结果已置顶（' + r.action + '），其余为规则推断，两者并列可对比';
      }, function (err) {
        note.textContent = 'AI 编排失败，已回退规则：' + (err && err.message ? err.message : err);
        setText(ta.value);
      });
    };

    /* ---------- 导出 ---------- */
    function dl(dataURL, name) {
      var a = document.createElement('a');
      a.href = dataURL;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
    expPng.onclick = function () { dl(stage.exportPNG({ scale: 2 }), 'stickman-' + Date.now() + '.png'); };
    expStrip.onclick = function () {
      var a = selected(); if (!a) return;
      dl(stage.exportStrip(a.action === 'custom' ? 'idle' : a.action, { phases: 5, scale: 1.2 }), 'stickman-' + a.action + '-strip.png');
    };
    expMotion.onclick = function () {
      var a = selected(); if (!a) return;
      dl(stage.exportMotion(a.action === 'custom' ? 'idle' : a.action, { frames: 7, scale: 1.1 }), 'stickman-' + a.action + '-motion.png');
    };
    expSheet.onclick = function () { dl(stage.exportSheet({ phases: 3, scale: 1 }), 'stickman-actions-sheet.png'); };

    var collapseState = { collapsed: false };
    var foldableRows = [actorRow, propRow, libWrap, textBox, beats, note, poseHead, poseWrap, expRow];
    function toggleCollapsed(elements, button, state) {
      state.collapsed = !state.collapsed;
      elements.forEach(function (element) { element.classList.toggle('smst-hide', state.collapsed); });
      button.textContent = state.collapsed ? '展开' : '收起';
      return state.collapsed;
    }
    collapse.onclick = function () { toggleCollapsed(foldableRows, collapse, collapseState); };

    /* ---------- 初始化 ---------- */
    buildSliders();
    stage.setSpeed(speedSl.get());
    var initActors = opts.actors && opts.actors.length ? opts.actors : [{ id: opts.actorId || 'hero', x: 0.5, color: '#e8e8e8', action: 'idle' }];
    stage.scene(initActors.map(function (a, i) {
      return { id: a.id || 'a' + i, x: a.x == null ? 0.5 : a.x, color: a.color || COLORS[i % COLORS.length], scale: a.scale || 1, flip: !!a.flip, action: a.action || 'idle', prop: a.prop || null };
    }));
    sel = stage.actors()[0].id;
    syncFromActor();
    renderLib();
    refreshCap();
    loadPoseIntoSliders(SM.neutralPose());

    var api = {
      root: root, stage: stage,
      play: play,
      /** 让舞台跟随一段叙述（自动模式）；返回节拍 */
      followText: function (text, o) {
        setMode('auto');
        var list = setText(text);
        if (!o || o.autoplay !== false) playBeats();
        return list;
      },
      /** 只推断一个动作并立刻播放（单拍，适合逐条消息驱动） */
      actFromText: function (text) {
        if (!SA) return null;
        var r = SA.infer(text);
        var a = selected();
        if (a) stage.setActor(a, { action: r.action, prop: r.prop });
        note.textContent = r.reason;
        refreshCap();
        return r;
      },
      setActor: function (id, props) { return stage.setActor(id, props); },
      setText: setText,
      playBeats: playBeats,
      pause: function () { window.clearTimeout(beatTimer); beatTimer = 0; stage.stop(); },
      beats: function () { return beatsList; },
      /** 外部（如剧情引擎）改了角色时，让控制面板重新同步 */
      sync: function () {
        if (!findActor(sel)) sel = stage.actors()[0] && stage.actors()[0].id;
        syncFromActor(); renderLib(); refreshCap();
      },
      setMode: setMode,
      select: function (id) { sel = id; syncFromActor(); renderLib(); },
      showPose: function () { poseWrap.classList.remove('smst-hide'); poseToggle.classList.add('on'); },
      destroy: function () {
        window.clearTimeout(beatTimer);
        beatTimer = 0;
        stage.stop();
        if (root.parentNode) root.parentNode.removeChild(root);
      },
    };
    return api;
  }

  return { create: create, version: '20261002-sm-v4' };
})();
