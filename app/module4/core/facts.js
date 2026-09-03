/* Module 4 Task 9: compact, world-scoped facts and action traces. */
(function (root) {
  'use strict';

  var Module4 = root.Module4 = root.Module4 || {};
  Module4.Facts = Module4.Facts || {};

  var Facts = Module4.Facts;
  var sequence = 0;
  var INTERACTION_TYPES = ['chat', 'help', 'invite', 'persuade', 'request_help'];
  var ACTION_LABELS = {
    invite: '邀请',
    persuade: '说服',
    request_help: '请求帮助',
    explore: '探索',
    intensive: '高强度行动',
    custom: '自定义行动'
  };

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function shortText(value, maxLength) {
    return text(value).slice(0, maxLength || 280);
  }

  function number(value, fallback) {
    var result = Number(value);
    return Number.isFinite(result) ? result : fallback;
  }

  function uniqueText(values) {
    var seen = {};
    return (Array.isArray(values) ? values : []).map(text).filter(function (value) {
      if (!value || seen[value]) return false;
      seen[value] = true;
      return true;
    });
  }

  function normalWorld(world) {
    var next = clone(world);
    if (Module4.World && typeof Module4.World.normalizeWorld === 'function') Module4.World.normalizeWorld(next);
    if (Module4.Clock && typeof Module4.Clock.normalizeWorld === 'function') Module4.Clock.normalizeWorld(next);
    return next;
  }

  function nowOf(input) {
    var value = Number(input && input.createdAt);
    return Number.isFinite(value) && value > 0 ? value : Date.now();
  }

  function factId(world, day, period, createdAt) {
    sequence += 1;
    return 'fact-' + day + '-' + period + '-' + createdAt + '-' + sequence;
  }

  function append(world, input) {
    var source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    var summary = shortText(source.summary);
    if (!summary) return null;
    var createdAt = nowOf(source);
    var day = number(source.day, number(world.clock && world.clock.day, 1));
    var period = text(source.period) || text(world.clock && world.clock.period) || 'morning';
    var fact = {
      id: text(source.id) || factId(world, day, period, createdAt),
      day: day,
      period: period,
      type: text(source.type) || 'world',
      actors: uniqueText(source.actors),
      summary: summary,
      persistent: source.persistent !== false,
      sourceActionId: text(source.sourceActionId) || null,
      createdAt: createdAt
    };
    world.facts = Array.isArray(world.facts) ? world.facts : [];
    world.facts.push(fact);
    return fact;
  }

  function npcName(world, npcId) {
    var npc = world && world.npcs && world.npcs[npcId];
    return text(npc && npc.name) || text(npcId);
  }

  function judgmentSummary(world, action, judgment) {
    var label = ACTION_LABELS[text(action && action.type)] || text(action && action.type) || '行动';
    var target = text(action && action.targetNpcId);
    var outcome = Module4.Judgment && typeof Module4.Judgment.outcomeLabel === 'function'
      ? Module4.Judgment.outcomeLabel(judgment && judgment.outcome)
      : text(judgment && judgment.outcome);
    return target
      ? '你对' + npcName(world, target) + '的' + label + '结果：' + (outcome || '已结算') + '，相关状态已更新。'
      : '你的' + label + '结果：' + (outcome || '已结算') + '，相关状态已更新。';
  }

  function rewriteSummary(world, rewrite) {
    var npc = npcName(world, rewrite && rewrite.npcId);
    var replacement = rewrite && rewrite.replacementSlot || {};
    var location = text(replacement.locationId || replacement.location) || '新的地点';
    var period = text(rewrite && rewrite.period) || '后续';
    return npc + '的' + period + '安排已改为前往' + location + '。';
  }

  function markInteraction(world, action) {
    var type = text(action && action.type);
    var npcId = text(action && action.targetNpcId);
    if (INTERACTION_TYPES.indexOf(type) < 0 || !npcId || !world.npcs || !world.npcs[npcId]) return false;
    var currentDay = world.currentDay && typeof world.currentDay === 'object' ? world.currentDay : {};
    var ids = uniqueText(currentDay.interactedNpcIds);
    if (ids.indexOf(npcId) >= 0) return false;
    ids.push(npcId);
    world.currentDay = Object.assign({}, currentDay, { interactedNpcIds: ids });
    return true;
  }

  Facts.version = 'task9-facts';

  Facts.add = function (world, input) {
    if (!world || typeof world !== 'object') return { ok: false, changed: false, world: world, fact: null };
    var next = normalWorld(world);
    var fact = append(next, input);
    if (fact) next.updatedAt = fact.createdAt;
    return { ok: !!fact, changed: !!fact, world: next, fact: fact ? clone(fact) : null };
  };

  Facts.recordAction = function (world, action, judgment, scheduleRewrite) {
    if (!world || typeof world !== 'object') return { ok: false, changed: false, world: world, facts: [] };
    var next = normalWorld(world);
    var facts = [];
    var changed = markInteraction(next, action);
    var sourceActionId = text(action && action.id) || null;
    var context = judgment && judgment.context || {};

    if (judgment && judgment.required && Array.isArray(judgment.consequences) && judgment.consequences.length) {
      var judgmentFact = append(next, {
        day: number(context.day, number(next.clock && next.clock.day, 1)),
        period: text(context.period) || text(next.clock && next.clock.period),
        type: 'judgment',
        actors: ['player', action && action.targetNpcId],
        summary: judgmentSummary(next, action, judgment),
        persistent: true,
        sourceActionId: sourceActionId
      });
      if (judgmentFact) {
        facts.push(judgmentFact);
        changed = true;
      }
    }

    if (scheduleRewrite && scheduleRewrite.changed && scheduleRewrite.rewrite) {
      var rewriteFact = append(next, {
        day: scheduleRewrite.rewrite.day,
        period: scheduleRewrite.rewrite.period,
        type: 'schedule_rewrite',
        actors: ['player', scheduleRewrite.rewrite.npcId],
        summary: rewriteSummary(next, scheduleRewrite.rewrite),
        persistent: true,
        sourceActionId: scheduleRewrite.rewrite.sourceActionId || sourceActionId
      });
      if (rewriteFact) {
        facts.push(rewriteFact);
        changed = true;
      }
    }

    if (changed) next.updatedAt = Date.now();
    return { ok: true, changed: changed, world: next, facts: clone(facts) };
  };

  Facts.recordWorldEvents = function (world) {
    if (!world || typeof world !== 'object') return { ok: false, changed: false, world: world, facts: [] };
    var next = normalWorld(world);
    var currentDay = next.currentDay && typeof next.currentDay === 'object' ? next.currentDay : {};
    var facts = [];
    (Array.isArray(currentDay.events) ? currentDay.events : []).forEach(function (event) {
      var source = typeof event === 'string' ? { summary: event } : (event || {});
      var title = shortText(source.title || source.name, 120);
      var summary = shortText(source.summary || source.detail || source.description, 240);
      var fact = append(next, {
        day: number(currentDay.day, number(next.clock && next.clock.day, 1)),
        period: 'evening',
        type: 'world_event',
        actors: source.actors,
        summary: title && summary ? title + '：' + summary : (title || summary),
        persistent: true
      });
      if (fact) facts.push(fact);
    });
    if (facts.length) next.updatedAt = Date.now();
    return { ok: true, changed: facts.length > 0, world: next, facts: clone(facts) };
  };

  Facts.recent = function (world, limit) {
    var total = Math.max(0, Number(limit) || 12);
    var facts = world && Array.isArray(world.facts) ? world.facts : [];
    return clone(facts.filter(function (fact) { return fact && fact.persistent !== false; }).slice(-total));
  };
}(window));
