/* =========================================================
 * 离线小说冒险引擎 v1（无需 AI API，纯本地逻辑）
 * 设定包：window.GAME_PACKS = { id: {...} }
 * 结构：事件图（选择 + 数值检定）+ 金手指成长 + 阶段大纲 + 随机事件 + 多结局
 * ========================================================= */
window.GameEngine = (function () {
  'use strict';

  var packs = {};
  function syncPacks() {
    packs = (typeof window !== 'undefined' && window.GAME_PACKS) || {};
    return packs;
  }
  var pack = null;
  var S = null;
  var rng = null;
  var headless = false;

  /* ---------------- 随机 ---------------- */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randInt(n) { return Math.floor(rng() * n); }
  function pick(arr) { return arr[randInt(arr.length)]; }
  function d(n) { return randInt(n) + 1; }

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function byId(id) { return headless ? null : document.getElementById(id); }

  /* ---------------- 火柴人动作识别 ---------------- */
  var ACTION_RULES = [
    { n: 'fall', re: /倒下|倒地|死亡|抹杀|昏|晕|失败/ },
    { n: 'attack', re: /攻击|砍|劈|斩|刺|拳|搏斗|迎战|击杀|战斗|强攻|冲锋|砸|一击/ },
    { n: 'cast', re: /施法|魔法|咒|驱邪|念出|法术|符文|诀|召唤|能量|光芒/ },
    { n: 'dodge', re: /躲|闪避|避|脱身|逃/ },
    { n: 'jump', re: /跳|跃|翻越|腾空/ },
    { n: 'run', re: /跑|奔|追|冲|疾/ },
    { n: 'hit', re: /受伤|伤|疼痛|血|被.*(咬|撞|摔|打|抽)/ },
    { n: 'search', re: /搜索|搜查|翻找|搜寻|检视|调查|查看柜|查看属性/ },
    { n: 'talk', re: /交谈|对话|询问|搭话|谈判|劝说|交涉|留下线索/ },
  ];
  function pickAction(text, explicit) {
    if (explicit && ACTIONS_OK(explicit)) return explicit;
    for (var i = 0; i < ACTION_RULES.length; i++) {
      if (ACTION_RULES[i].re.test(text || '')) return ACTION_RULES[i].n;
    }
    return 'idle';
  }
  function ACTIONS_OK(name) {
    return typeof window !== 'undefined' && window.Stickman &&
      window.Stickman.actions && window.Stickman.actions[name];
  }
  function playAction(name) {
    if (typeof window !== 'undefined' && window.Stickman) window.Stickman.play(name || 'idle');
  }

  /* ---------------- AI 增强（可选；数值/战斗/结局始终离线，AI 失败自动回退） ---------------- */
  var aiEnabled = false;
  var aiCache = {};
  function hasAPI() {
    try {
      if (typeof callLLM !== 'function') return false;
      if (typeof state === 'undefined' || !state || !state.apiConfig) return false;
      var c = state.apiConfig;
      return !!(c.endpoint && c.apiKey);
    } catch (e) { return false; }
  }
  function aiActive() { return !headless && aiEnabled && hasAPI(); }
  function aiStateSummary() {
    var parts = [];
    parts.push('玩家（轮回者）当前状态：');
    parts.push('HP ' + S.hp + '/' + S.maxHp + '，MP ' + S.mp + '/' + S.maxMp + '，金币 ' + S.gold);
    parts.push('属性：' + Object.keys(pack.attrs).map(function (k) { return k + ' ' + attrTotal(k); }).join('、'));
    var info = gfLevelInfo();
    parts.push('金手指：' + info.gf.name + ' Lv.' + S.gfLevel);
    parts.push('天赋：' + S.talent.name);
    parts.push('进度：第 ' + (S.stageIdx + 1) + ' 幕 · ' + currentStage().name + '，回合 ' + S.turns);
    parts.push('道具：' + (S.items.length ? S.items.join('、') : '无'));
    if (S.history.length) parts.push('最近事件：' + S.history.slice(-6).join(' → '));
    return parts.join('；');
  }
  var AI_ACTIONS = ['idle', 'walk', 'run', 'attack', 'cast', 'hit', 'jump', 'dodge', 'fall', 'win', 'search', 'talk'];
  function aiActionOut(text, fallback) {
    var m = String(text).match(/<action:\s*([a-z]+)\s*>\s*$/i);
    var action = null;
    if (m && AI_ACTIONS.indexOf(m[1].toLowerCase()) !== -1) action = m[1].toLowerCase();
    var cleaned = String(text).replace(/<action:\s*[a-z]+\s*>\s*$/i, '').trim();
    if (!action) action = fallback;
    return { text: cleaned, action: action };
  }
  function aiCall(sys, user) {
    return callLLM([{ role: 'system', content: sys }, { role: 'user', content: user }]);
  }
  function aiCacheKey(id) { return 'og_ai_' + (pack ? pack.id : 'x') + '_' + id; }
  function aiCached(id) {
    try {
      var k = aiCacheKey(id);
      if (aiCache[k] != null) return aiCache[k];
      var ls = window.localStorage;
      return ls ? ls.getItem(k) : null;
    } catch (e) { return null; }
  }
  function aiCachePut(id, text) {
    try {
      var k = aiCacheKey(id);
      aiCache[k] = text;
      var ls = window.localStorage;
      if (ls) ls.setItem(k, text);
    } catch (e) { /* ignore */ }
  }
  function aiNarrate(baseText, kind, cacheId) {
    if (cacheId) { var c = aiCached(cacheId); if (c) return Promise.resolve(aiActionOut(c)); }
    var sys = '你是文字冒险游戏的叙事生成器。基于玩家当前状态，把给定的剧情片段扩写成一段生动、贴合状态的中文叙事（80-160字），保持原意与走向，不改动任何数值与可选分支。在结尾用单独一行输出动作建议：<action:动作名>，动作名只能是 idle/walk/run/attack/cast/hit/jump/dodge/fall/win/search/talk 之一。只输出叙事与这一行，不要其它说明。';
    var user = '【玩家状态】\n' + aiStateSummary() + '\n\n【原剧情】\n' + baseText + '\n\n【情境】' + (kind || '');
    return aiCall(sys, user).then(function (full) {
      if (cacheId) aiCachePut(cacheId, full);
      return aiActionOut(full);
    });
  }
  function aiNarrateResult(baseText) {
    var sys = '你是文字冒险游戏的叙事生成器。玩家刚做了一个选择，下面是该选择的基础结果。请扩写成生动、贴合状态的中文描写（60-140字），保持结果走向不变，不改动数值。在结尾用单独一行输出动作建议：<action:动作名>，动作名只能是 idle/walk/run/attack/cast/hit/jump/dodge/fall/win/search/talk 之一。';
    var user = '【玩家状态】\n' + aiStateSummary() + '\n\n【选择结果】\n' + baseText;
    return aiCall(sys, user).then(aiActionOut);
  }
  function stripHtml(s) { return String(s == null ? '' : s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
  function aiAction(name, fallback) {
    if (name && window.Stickman && window.Stickman.actions && window.Stickman.actions[name]) return name;
    return fallback;
  }
  function aiPresentBusy(title) {
    var t = byId('ogTitle'); if (t) t.textContent = pack.title + ' · ' + (title || '');
    var s = byId('ogStory'); if (s) s.innerHTML = '<p class="og-text og-ai-busy">✨ AI 正在生成叙事…</p>';
    var c = byId('ogChoices'); if (c) c.innerHTML = '';
  }

  /* ---------------- 火柴人舞台：角色场景 ---------------- */
  function stickman() { return (typeof window !== 'undefined') ? window.Stickman : null; }
  function getChar(key) {
    var c = (pack && pack.characters && pack.characters[key]) || {};
    return { color: c.color || '#e8e8e8', scale: c.scale || 1, flip: !!c.flip, alpha: c.alpha };
  }
  function setScene(defs) {
    var sm = stickman();
    if (!sm) return;
    var actors = [];
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      var c = getChar(d.key || 'player');
      actors.push({
        id: d.id, x: d.x != null ? d.x : 0.5,
        scale: c.scale, color: c.color,
        flip: d.flip != null ? d.flip : c.flip,
        alpha: c.alpha, action: d.action || 'idle',
      });
    }
    sm.scene(actors);
  }
  function storyScene(showKeys, playerAction) {
    var defs = [{ id: 'player', key: 'player', x: 0.32, action: playerAction || 'idle' }];
    var xs = [0.68, 0.48, 0.84];
    (showKeys || []).slice(0, 3).forEach(function (k, i) {
      defs.push({ id: 'npc' + i, key: k, x: xs[i] || 0.68, flip: true });
    });
    setScene(defs);
  }
  function combatScene(enemyKey) {
    setScene([
      { id: 'player', key: 'player', x: 0.28, action: 'idle' },
      { id: 'enemy', key: enemyKey || 'enemy', x: 0.72, flip: true, action: 'idle' },
    ]);
  }
  function sceneAct(id, name) {
    var sm = stickman();
    if (sm) sm.actorAction(id, name);
  }
  function findItem(idOrName) {
    return (pack.items || []).filter(function (it) { return it.id === idOrName || it.name === idOrName; })[0];
  }
  function hasItem(name) { return S.items.indexOf(name) !== -1; }
  function log(msg) { if (S) S.log.unshift('[' + S.turns + '] ' + msg); if (S && S.log.length > 40) S.log.length = 40; }

  /* ---------------- 数值 ---------------- */
  function gfLevelInfo() {
    var gf = pack.goldenFingers[S.gfIdx];
    if (!gf || !gf.levels) return { bonus: {} };
    var lv = gf.levels[Math.min(S.gfLevel, gf.levels.length) - 1];
    return { gf: gf, level: lv, max: gf.levels.length };
  }
  function itemBonus(name) {
    var b = 0;
    (S.items || []).forEach(function (it) {
      var def = findItem(it);
      if (def && def.attrs && def.attrs[name]) b += def.attrs[name];
    });
    return b;
  }
  function attrTotal(name) {
    var lv = gfLevelInfo();
    var b = (lv.level && lv.level.bonus && lv.level.bonus[name]) || 0;
    return (S.attrs[name] || 0) + b + itemBonus(name);
  }
  function attrMod(name) { return Math.floor((attrTotal(name) - 10) / 2); }
  function rollCheck(attr, dc, mod) {
    var r = d(20);
    var m = attrMod(attr) + (mod || 0);
    return { attr: attr, dc: dc, roll: r, mod: m, total: r + m, pass: r + m >= dc };
  }

  /* ---------------- 效果 ---------------- */
  function applyEffect(eff) {
    var notes = [];
    if (!eff) return notes;
    if (eff.hp) {
      S.hp = Math.max(0, Math.min(S.maxHp, S.hp + eff.hp));
      notes.push(eff.hp >= 0 ? 'HP +' + eff.hp : 'HP ' + eff.hp);
    }
    if (eff.mp) {
      S.mp = Math.max(0, Math.min(S.maxMp, S.mp + eff.mp));
      notes.push(eff.mp >= 0 ? 'MP +' + eff.mp : 'MP ' + eff.mp);
    }
    if (eff.gold) { S.gold += eff.gold; notes.push(eff.gold >= 0 ? '金币 +' + eff.gold : '金币 ' + eff.gold); }
    if (eff.gfXp) { S.gfXp += eff.gfXp; notes.push('金手指经验 +' + eff.gfXp); }
    if (eff.attrs) {
      for (var k in eff.attrs) {
        S.attrs[k] = (S.attrs[k] || 0) + eff.attrs[k];
        notes.push(k + (eff.attrs[k] >= 0 ? '+' : '') + eff.attrs[k]);
      }
    }
    if (eff.addItem) { S.items.push(eff.addItem); notes.push('获得「' + eff.addItem + '」'); }
    if (eff.removeItem) {
      var i = S.items.indexOf(eff.removeItem);
      if (i >= 0) { S.items.splice(i, 1); notes.push('失去「' + eff.removeItem + '」'); }
    }
    if (eff.flag) S.flags[eff.flag] = true;
    if (eff.clearFlag) delete S.flags[eff.clearFlag];
    checkDeath();
    return notes;
  }
  function checkDeath() {
    if (S.hp > 0) return;
    if (hasItem('复活币') && !S._usedRevive) {
      S._usedRevive = true;
      S.hp = Math.max(1, Math.floor(S.maxHp / 2));
      S.items.splice(S.items.indexOf('复活币'), 1);
      log('复活币生效，你从死亡边缘苏醒');
      return;
    }
    showEnding('death');
  }

  /* ---------------- 流程 ---------------- */
  function startRun(packId, talentIdx, seed) {
    syncPacks();
    pack = packs[packId] || packs[Object.keys(packs)[0]];
    if (!pack) return;
    rng = mulberry32(seed != null ? seed : ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0));
    var attrs = {};
    for (var k in pack.attrs) {
      var base = (pack.attrs[k].base != null) ? pack.attrs[k].base : 10;
      attrs[k] = base + randInt(7) - 3;
    }
    var talent = (talentIdx != null && pack.talents[talentIdx]) ? pack.talents[talentIdx] : pick(pack.talents);
    if (talent.attrs) for (var t in talent.attrs) attrs[t] = (attrs[t] || 0) + talent.attrs[t];
    S = {
      packId: pack.id,
      seed: seed,
      attrs: attrs,
      hp: pack.player.hp, maxHp: pack.player.hp,
      mp: pack.player.mp, maxMp: pack.player.mp,
      gold: pack.player.gold || 0,
      items: (pack.player.items || []).slice(),
      talent: talent,
      gfIdx: randInt(pack.goldenFingers.length),
      gfLevel: 1, gfXp: 0,
      stageIdx: 0,
      pos: 0,
      flags: {},
      log: [],
      history: [],
      turns: 0,
      status: 'play',
      ending: null,
      pendingNext: null,
      pendingUpgrade: false,
      _usedRevive: false,
    };
    if (talent.hp) { S.hp += talent.hp; S.maxHp += talent.hp; }
    log('第 1 幕 · ' + pack.stages[0].name + ' 开始');
    renderPanel();
    if (headless) {
      S.pos = -1;
      resolveNext('@next');
    } else {
      showBriefing();
    }
  }

  function showBriefing() {
    var gf = pack.goldenFingers[S.gfIdx];
    var lines = [
      '<h3>开局简报</h3>',
      '<p>天赋：<b>' + esc(S.talent.name) + '</b> — ' + esc(S.talent.desc) + '</p>',
      '<p>金手指：<b>' + esc(gf.name) + '</b> — ' + esc(gf.desc) + '</p>',
      '<p>属性：' + Object.keys(S.attrs).map(function (k) { return k + ' ' + attrTotal(k); }).join(' / ') + '</p>',
    ];
    renderScene('', lines.join(''), [{ text: '进入轮回空间', next: '@next' }]);
    S.pendingNext = '@next';
  }

  function currentStage() { return pack.stages[S.stageIdx]; }

  function showEvent(evId) {
    if (!evId || S.status === 'end') return;
    var st = currentStage();
    var idx = st.events.indexOf(evId);
    if (idx === -1) {
      if (headless) throw new Error('事件未找到: ' + evId);
      showEnding('death');
      return;
    }
    S.pos = idx;
    S.history.push(evId);
    S.turns++;
    if (S.talent.healPerEvent) { S.hp = Math.min(S.maxHp, S.hp + S.talent.healPerEvent); }
    renderPanel();
    var ev = pack.events[evId];
    var fallbackAction = pickAction(ev.text, ev.action);
    if (aiActive()) {
      aiPresentBusy(ev.title);
      aiNarrate(ev.text, ev.title, evId).then(function (out) {
        renderEventText(out.text, ev);
        storyScene(ev.show, aiAction(out.action, fallbackAction));
      }).catch(function () { renderEvent(ev); storyScene(ev.show, fallbackAction); });
    } else {
      renderEvent(ev);
      storyScene(ev.show, fallbackAction);
    }
  }

  function resolveNext(next) {
    if (!next || next === '@next') {
      var st = currentStage();
      if (S.pos + 1 < st.events.length) showEvent(st.events[S.pos + 1]);
      else advanceStage();
      return;
    }
    if (next === '@stage') { advanceStage(); return; }
    if (next.indexOf('end:') === 0) { showEnding(next.slice(4)); return; }
    if (next.indexOf('@random:') === 0) { showRandomEvent(next.slice(8)); return; }
    showEvent(next);
  }

  function advanceStage() {
    S.stageIdx++;
    S.pos = -1;
    if (S.stageIdx >= pack.stages.length) { showEnding('win_graduate'); return; }
    var st = currentStage();
    S.hp = Math.min(S.maxHp, S.hp + 30);
    S.history = [];
    log('副本通关，休整回复 HP +30；进入第 ' + (S.stageIdx + 1) + ' 幕：' + st.name);
    renderStageIntro(st);
  }

  function showRandomEvent(contId) {
    var pool = pack.randomEvents.filter(function (e) { return S.history.indexOf(e.id) === -1; });
    var ev = pool.length ? pick(pool) : pick(pack.randomEvents);
    S.history.push(ev.id);
    S._randomCont = contId;
    var fallbackAction = pickAction(ev.text, ev.action);
    if (aiActive()) {
      aiPresentBusy('随机事件');
      aiNarrate(ev.text, '随机事件', ev.id).then(function (out) {
        renderRandomEventText(out.text, ev);
        storyScene(ev.show, aiAction(out.action, fallbackAction));
      }).catch(function () { renderRandomEvent(ev); storyScene(ev.show, fallbackAction); });
    } else {
      storyScene(ev.show, fallbackAction);
      renderRandomEvent(ev);
    }
  }

  function showEnding(endingId) {
    if (S.status === 'end') return;
    var end = pack.endings[endingId] || pack.endings.death;
    S.status = 'end';
    S.ending = endingId;
    renderEnding(end);
  }

  /* ---------------- 选择 / 检定 ---------------- */
  function onChoice(idx) {
    if (S.status === 'end') return;
    var ch = S.curChoices[idx];
    if (!ch) return;
    if (ch.action === 'continue') { onContinue(); return; }
    if (ch.combat) { startCombat(ch.combat); return; }
    var notes, next, narr, baseText, fallbackAction;
    if (ch.check) {
      var c = rollCheck(ch.check.attr, ch.check.dc, ch.check.mod);
      var branch = c.pass ? (ch.result || {}) : (ch.fail || {});
      notes = applyEffect(branch.effect);
      if (S.status === 'end') return;
      next = branch.next;
      narr = branch.text || ch.text;
      baseText = (branch.text || ch.text) + '<br><small class="og-check">检定 ' + c.attr + ' DC' + c.dc +
        '：掷出 ' + c.roll + ' + ' + c.mod + ' = ' + c.total + '（' + (c.pass ? '成功' : '失败') + '）</small>';
      fallbackAction = pickAction(ch.text + ' ' + (branch.text || ''), ch.action || (branch.effect && branch.effect.hp < 0 ? 'hit' : null));
    } else {
      notes = applyEffect(ch.effect);
      if (S.status === 'end') return;
      next = ch.next;
      narr = ch.resultText || ('你选择了：' + ch.text);
      baseText = narr;
      fallbackAction = pickAction(ch.text + ' ' + (ch.resultText || ''), ch.action || (ch.effect && ch.effect.hp < 0 ? 'hit' : null));
    }
    S.pendingNext = next;
    presentResult(baseText, narr, notes, next, fallbackAction);
  }

  function presentResult(baseText, narr, notes, next, fallbackAction) {
    if (aiActive()) {
      aiPresentBusy('结果');
      aiNarrateResult(narr).then(function (out) {
        renderResult(esc(out.text), notes, next);
        sceneAct('player', aiAction(out.action, fallbackAction));
      }).catch(function () {
        renderResult(baseText, notes, next);
        sceneAct('player', fallbackAction);
      });
    } else {
      renderResult(baseText, notes, next);
      sceneAct('player', fallbackAction);
    }
  }

  function onContinue() {
    if (S.status === 'end') return;
    if (S._pendingUpgrade) {
      S._pendingUpgrade = false;
      resolveNext(S.pendingNext);
      return;
    }
    var up = checkGfUpgrade();
    if (up) {
      S._pendingUpgrade = true;
      renderUpgrade(up);
      return;
    }
    resolveNext(S.pendingNext);
  }

  function checkGfUpgrade() {
    var info = gfLevelInfo();
    var gf = info.gf;
    if (!gf || !gf.levels) return null;
    var nextLv = gf.levels[S.gfLevel];
    if (nextLv && S.gfXp >= nextLv.xp) {
      S.gfLevel++;
      log(gf.name + ' 升级到 Lv.' + S.gfLevel);
      renderPanel();
      return nextLv;
    }
    return null;
  }

  /* ---------------- 战斗 ---------------- */
  function startCombat(comb) {
    S.combat = {
      enemy: comb.enemy, maxHp: comb.enemyHp, hp: comb.enemyHp,
      rounds: comb.rounds || 3, attr: comb.attr, dc: comb.dc || 13,
      dmg: comb.dmg || 8, winNext: comb.winNext, loseNext: comb.loseNext,
      winEffect: comb.winEffect, loseEffect: comb.loseEffect,
      log: [],
    };
    combatScene(comb.enemyKey);
    sceneAct('player', 'attack');
    renderCombat();
  }
  function combatAttack() {
    if (!S.combat) return;
    var c = rollCheck(S.combat.attr, S.combat.dc);
    var msg;
    if (c.pass) {
      S.combat.hp -= 1;
      msg = '命中！' + S.combat.enemy + ' 剩余 ' + Math.max(0, S.combat.hp) + '/' + S.combat.maxHp;
    } else {
      S.hp -= S.combat.dmg;
      msg = '被反击！受到 ' + S.combat.dmg + ' 点伤害（HP ' + S.hp + '）';
    }
    S.combat.rounds--;
    S.combat.log.push('掷出 ' + c.roll + ' + ' + c.mod + ' = ' + c.total + '：' + msg);
    renderPanel();
    if (c.pass) {
      sceneAct('player', 'attack');
      if (!headless) setTimeout(function () { sceneAct('enemy', 'hit'); }, 240);
    } else {
      sceneAct('enemy', 'attack');
      if (!headless) setTimeout(function () { sceneAct('player', 'hit'); }, 240);
    }
    if (S.hp <= 0) { checkDeath(); return; }
    if (S.status === 'end') return;
    if (S.combat.hp <= 0) { combatEnd(true); return; }
    if (S.combat.rounds <= 0) { combatEnd(false); return; }
    renderCombat();
  }
  function combatEnd(win) {
    var comb = S.combat;
    S.combat = null;
    var notes = applyEffect(win ? comb.winEffect : comb.loseEffect);
    if (S.status === 'end') return;
    var next = win ? comb.winNext : comb.loseNext;
    S.pendingNext = next;
    var base = win ? ('你击败了' + comb.enemy + '。') : ('你不敌' + comb.enemy + '，勉强脱身。');
    if (aiActive()) {
      aiPresentBusy('战斗结束');
      aiNarrateResult(base).then(function (out) {
        renderCombatResultText(out.text, win, comb.enemy, notes, next);
      }).catch(function () { renderCombatResult(win, comb.enemy, notes, next); });
    } else {
      renderCombatResult(win, comb.enemy, notes, next);
    }
    sceneAct('player', win ? 'win' : 'fall');
    sceneAct('enemy', win ? 'fall' : 'win');
  }

  /* ---------------- 渲染 ---------------- */
  function renderPanel() {
    if (headless) return;
    var el = byId('ogChar');
    if (!el) return;
    var info = gfLevelInfo();
    var gf = info.gf;
    var nextXp = info.level ? info.level.xp : 0;
    var html = '';
    var hpPct = Math.max(0, Math.min(100, Math.round(S.hp / S.maxHp * 100)));
    var mpPct = Math.max(0, Math.min(100, Math.round(S.mp / S.maxMp * 100)));
    html += '<div class="og-bar"><span>HP</span><div class="og-bar-track"><div class="og-bar-fill og-hp" style="width:' + hpPct + '%"></div></div><b>' + S.hp + '/' + S.maxHp + '</b></div>';
    html += '<div class="og-bar"><span>MP</span><div class="og-bar-track"><div class="og-bar-fill og-mp" style="width:' + mpPct + '%"></div></div><b>' + S.mp + '/' + S.maxMp + '</b></div>';
    html += '<div class="og-attrs">';
    for (var k in pack.attrs) {
      html += '<span class="og-attr" title="修正值 ' + attrMod(k) + '">' + esc(pack.attrs[k].name || k) + ' <b>' + attrTotal(k) + '</b></span>';
    }
    html += '</div>';
    html += '<div class="og-line">天赋：' + esc(S.talent.name) + '</div>';
    html += '<div class="og-line">金手指：' + esc(gf.name) + ' <b>Lv.' + S.gfLevel + '</b>' +
      (nextXp ? ' <small>经验 ' + S.gfXp + '/' + nextXp + '</small>' : ' <small>已满级</small>') + '</div>';
    html += '<div class="og-line">金币：' + S.gold + ' ｜ 道具：' + (S.items.length ? esc(S.items.join('、')) : '无') + '</div>';
    var st = currentStage();
    html += '<div class="og-line og-stage">第 ' + (S.stageIdx + 1) + ' 幕 · ' + esc(st.name) + '</div>';
    el.innerHTML = html;
  }

  function renderScene(title, body, choices) {
    S.curChoices = choices;
    if (headless) return;
    byId('ogTitle').textContent = pack.title + ' · ' + (title || '');
    byId('ogStory').innerHTML = body;
    var box = byId('ogChoices');
    box.innerHTML = choices.map(function (ch, i) {
      var hint = '';
      if (ch.check) hint = '<small class="og-check-hint">『' + esc(ch.check.attr) + ' 判定 DC' + ch.check.dc + '』</small>';
      if (ch.combat) hint = '<small class="og-check-hint">⚔ 战斗</small>';
      var click = (ch.action === 'continue') ? 'GameEngine.onContinue()' : 'GameEngine.onChoice(' + i + ')';
      return '<button type="button" class="og-choice" onclick="' + click + '">' + esc(ch.text) + hint + '</button>';
    }).join('');
    byId('ogLog').innerHTML = '<div class="og-log-title">行动记录</div>' + S.log.map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('');
  }

  function renderEvent(ev) { renderEventText(ev.text, ev); }
  function renderEventText(text, ev) {
    renderScene(ev.title, '<p class="og-text">' + esc(text) + '</p>', ev.choices);
  }

  function renderResult(text, notes, next) {
    var body = '<p class="og-text">' + text + '</p>' +
      (notes && notes.length ? '<div class="og-notes">' + notes.map(function (n) { return '<span>' + esc(n) + '</span>'; }).join('') + '</div>' : '');
    renderScene('结果', body, [{ text: '继续 ▶', action: 'continue' }]);
  }

  function renderRandomEvent(ev) { renderRandomEventText(ev.text, ev); }
  function renderRandomEventText(text, ev) {
    var choices = ev.choices.map(function (ch) {
      var c = { text: ch.text, next: S._randomCont };
      if (ch.effect) c.effect = ch.effect;
      if (ch.check) c.check = ch.check;
      if (ch.result) { c.result = {}; for (var k in ch.result) c.result[k] = ch.result[k]; c.result.next = S._randomCont; }
      if (ch.fail) { c.fail = {}; for (var j in ch.fail) c.fail[j] = ch.fail[j]; c.fail.next = S._randomCont; }
      return c;
    });
    renderScene('随机事件 · ' + ev.title, '<p class="og-text">' + esc(text) + '</p>', choices);
  }

  function renderUpgrade(lv) {
    var gf = pack.goldenFingers[S.gfIdx];
    var bonus = lv.bonus || {};
    var b = Object.keys(bonus).map(function (k) { return k + '+' + bonus[k]; }).join(' / ');
    renderScene('金手指升级',
      '<div class="og-upgrade"><div class="og-upgrade-icon">✨</div><p class="og-text"><b>' + esc(gf.name) +
      '</b> 升到 <b>Lv.' + S.gfLevel + '</b></p><p class="og-text">' + esc(lv.desc || '') + '</p>' +
      (b ? '<p class="og-notes"><span>属性加成：' + esc(b) + '</span></p>' : '') + '</div>',
      [{ text: '继续 ▶', action: 'continue' }]);
  }

  function renderStageIntro(st) {
    storyScene([], 'walk');
    if (aiActive()) {
      aiPresentBusy('第 ' + (S.stageIdx + 1) + ' 幕');
      aiNarrate(st.intro, '进入新副本', 'stage' + S.stageIdx).then(function (out) {
        renderScene('第 ' + (S.stageIdx + 1) + ' 幕 · ' + st.name,
          '<p class="og-text">' + esc(out.text) + '</p>',
          [{ text: '进入副本', next: '@next' }]);
        S.pendingNext = '@next';
      }).catch(function () {
        renderScene('第 ' + (S.stageIdx + 1) + ' 幕 · ' + st.name,
          '<p class="og-text">' + esc(st.intro) + '</p>',
          [{ text: '进入副本', next: '@next' }]);
        S.pendingNext = '@next';
      });
      return;
    }
    renderScene('第 ' + (S.stageIdx + 1) + ' 幕 · ' + st.name,
      '<p class="og-text">' + esc(st.intro) + '</p>',
      [{ text: '进入副本', next: '@next' }]);
    S.pendingNext = '@next';
  }

  function renderCombat() {
    var comb = S.combat;
    var body = '<div class="og-combat">' +
      '<div class="og-combat-enemy">⚔ ' + esc(comb.enemy) + '　HP ' + Math.max(0, comb.hp) + '/' + comb.maxHp + '</div>' +
      '<div class="og-combat-rule">用『' + esc(comb.attr) + '』判定（DC' + comb.dc + '），命中 1 次扣敌人 1 HP，' +
      '未命中被反击 -' + comb.dmg + '。剩 ' + comb.rounds + ' 回合。</div>' +
      (comb.log.length ? '<div class="og-notes">' + comb.log.map(function (l) { return '<span>' + esc(l) + '</span>'; }).join('') + '</div>' : '') +
      '</div>';
    if (headless) return;
    byId('ogTitle').textContent = pack.title + ' · 战斗';
    byId('ogStory').innerHTML = body;
    byId('ogChoices').innerHTML = '<button type="button" class="og-choice" onclick="GameEngine.combatAttack()">⚔ 攻击！</button>';
  }

  function renderCombatResult(win, enemy, notes, next) {
    renderCombatResultText(null, win, enemy, notes, next);
  }
  function renderCombatResultText(text, win, enemy, notes, next) {
    var body = '<div class="og-combat-result ' + (win ? 'og-win' : 'og-lose') + '">' +
      (win ? '🎉 你击败了 ' + esc(enemy) + '！' : '💀 你不敌 ' + esc(enemy) + '，勉强脱身。') + '</div>' +
      (text ? '<p class="og-text">' + esc(text) + '</p>' : '') +
      (notes && notes.length ? '<div class="og-notes">' + notes.map(function (n) { return '<span>' + esc(n) + '</span>'; }).join('') + '</div>' : '');
    renderScene('战斗结束', body, [{ text: '继续 ▶', action: 'continue' }]);
  }

  function renderStart() {
    if (headless) return;
    syncPacks();
    var p = packs[Object.keys(packs)[0]];
    byId('ogTitle').textContent = p.title + ' · 选择开局天赋';
    byId('ogStory').innerHTML = '<div class="og-intro"><p class="og-text">' + esc(p.intro) + '</p>' +
      '<p class="og-text">属性会随机浮动，金手指在开局随机抽取，可通过经验成长升级。</p></div>';
    var box = byId('ogChoices');
    box.innerHTML = p.talents.map(function (t, i) {
      return '<button type="button" class="og-choice" onclick="GameEngine.start(' + i + ')">' +
        esc(t.name) + '<small class="og-check-hint">' + esc(t.desc) + '</small></button>';
    }).join('');
    byId('ogLog').innerHTML = '<div class="og-log-title">行动记录</div><div>选择天赋后开始冒险</div>';
  }

  function renderEnding(end) {
    if (headless) return;
    setScene([{ id: 'player', key: 'player', x: 0.5, action: end.kind === 'death' ? 'fall' : (end.kind === 'win' ? 'win' : 'cast') }]);
    var body = '<div class="og-ending">' +
      '<div class="og-ending-icon">' + (end.kind === 'win' ? '🏆' : end.kind === 'death' ? '💀' : '🌀') + '</div>' +
      '<h3>' + esc(end.title) + '</h3>' +
      '<p class="og-text">' + esc(end.text) + '</p>' +
      '<div class="og-notes"><span>回合 ' + S.turns + '</span><span>金手指 Lv.' + S.gfLevel + '</span>' +
      '<span>金币 ' + S.gold + '</span></div>' +
      '</div>';
    byId('ogTitle').textContent = pack.title + ' · 结局';
    byId('ogStory').innerHTML = body;
    byId('ogChoices').innerHTML = '<button type="button" class="og-choice" onclick="GameEngine.restart()">🔄 重新开局（随机体验）</button>';
  }

  /* ---------------- 对外 ---------------- */
  function start(talentIdx) {
    var id = Object.keys(packs)[0];
    startRun(id, talentIdx == null ? null : talentIdx);
  }
  function toggleAI() {
    aiEnabled = !aiEnabled;
    syncAiButton();
  }
  function syncAiButton() {
    var btn = byId('ogAiBtn');
    if (btn) { btn.textContent = '✨ AI 增强：' + (aiEnabled ? '开' : '关'); if (btn.classList) btn.classList.toggle('on', aiEnabled); }
    var note = byId('ogAiStatus');
    if (note) note.textContent = (aiEnabled && !hasAPI()) ? '（未检测到 API 配置，将自动回退离线）' : '';
  }
  function open() {
    syncPacks();
    if (!Object.keys(packs).length) { alert('未找到游戏设定包'); return; }
    var el = byId('offlineGame');
    if (el) el.style.display = 'flex';
    if (typeof window !== 'undefined' && window.Stickman) {
      window.Stickman.attach(byId('ogCanvas'));
    }
    syncAiButton();
    renderStart();
  }
  function close() {
    var el = byId('offlineGame');
    if (el) el.style.display = 'none';
    if (typeof window !== 'undefined' && window.Stickman) window.Stickman.stop();
  }
  function restart() { startRun(S.packId, S.talent ? pack.talents.indexOf(S.talent) : null); }

  /* ---------------- 无头模拟（测试用） ---------------- */
  function simulate(packId, seed, maxSteps, pickFn, opts) {
    headless = true;
    syncPacks();
    startRun(packId, opts && opts.talentIdx != null ? opts.talentIdx : null, seed);
    var uiMode = !!(opts && opts.uiMode);
    var steps = 0;
    while (S.status !== 'end' && steps < (maxSteps || 200)) {
      steps++;
      if (S.combat) { combatAttack(); continue; }
      var choices = S.curChoices || [];
      if (!choices.length) { showEnding('death'); break; }
      var idx = pickFn ? pickFn(S, choices) : 0;
      onChoice(idx);
      if (!uiMode && S.status !== 'end' && !S.combat) onContinue();
    }
    var result = { status: S.status, ending: S.ending, turns: S.turns, gfLevel: S.gfLevel, hp: S.hp, history: S.history.slice() };
    headless = false;
    return result;
  }

  return {
    packs: function () { return syncPacks(); },
    open: open,
    close: close,
    start: start,
    restart: restart,
    onChoice: onChoice,
    onContinue: onContinue,
    combatAttack: combatAttack,
    toggleAI: toggleAI,
    simulate: simulate,
    _state: function () { return S; },
  };
})();
