/* Module 4 Task 9: deterministic end-of-day settlement and one cross-day boundary. */
(function (root) {
  'use strict';

  var Module4 = root.Module4 = root.Module4 || {};
  Module4.Settlement = Module4.Settlement || {};

  var Settlement = Module4.Settlement;
  var logSequence = 0;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function shortText(value, maxLength) {
    return text(value).slice(0, maxLength || 300);
  }

  function number(value, fallback) {
    var result = Number(value);
    return Number.isFinite(result) ? result : fallback;
  }

  function normalWorld(world) {
    var next = clone(world);
    if (Module4.World && typeof Module4.World.normalizeWorld === 'function') Module4.World.normalizeWorld(next);
    if (Module4.Clock && typeof Module4.Clock.normalizeWorld === 'function') Module4.Clock.normalizeWorld(next);
    return next;
  }

  function currentDay(world) {
    return number(world && world.clock && world.clock.day, 1);
  }

  function effectiveSlot(world, npcId) {
    if (Module4.Schedule && typeof Module4.Schedule.getEffectiveSlot === 'function') {
      return Module4.Schedule.getEffectiveSlot(world, npcId, 'evening');
    }
    var npc = world && world.npcs && world.npcs[npcId];
    return npc && npc.schedule ? clone(npc.schedule.evening) : null;
  }

  function slotSummary(slot, npc) {
    var activity = text(slot && (slot.activity || slot.intent));
    if (activity) return activity;
    var goal = Array.isArray(npc && npc.goals) ? npc.goals[0] : '';
    if (goal && typeof goal === 'object') goal = goal.text || goal.title || goal.name;
    return shortText(goal, 120) || '按既有安排结束当天';
  }

  function unplayedNpcEntries(world) {
    var current = world.currentDay && typeof world.currentDay === 'object' ? world.currentDay : {};
    var interacted = Array.isArray(current.interactedNpcIds) ? current.interactedNpcIds : [];
    return Object.keys(world.npcs || {}).filter(function (npcId) {
      return interacted.indexOf(npcId) < 0;
    }).map(function (npcId) {
      var npc = world.npcs[npcId];
      var summary = slotSummary(effectiveSlot(world, npcId), npc);
      return shortText((text(npc && npc.name) || npcId) + '：' + summary + '。');
    }).filter(Boolean);
  }

  function dayFacts(world, day) {
    return (Array.isArray(world.facts) ? world.facts : []).filter(function (fact) {
      return fact && Number(fact.day) === Number(day);
    });
  }

  function clearTemporaryState(world) {
    Object.keys(world.npcs || {}).forEach(function (npcId) {
      var npc = world.npcs[npcId];
      if (npc && typeof npc === 'object') npc.temporaryState = [];
    });
    world.player = Object.assign({}, world.player || {}, { temporaryState: [] });
  }

  function newCurrentDay(day) {
    if (Module4.World && typeof Module4.World.createCurrentDay === 'function') {
      return Module4.World.createCurrentDay(day);
    }
    return {
      day: day,
      previewGenerated: false,
      previewStatus: 'idle',
      schedules: {},
      events: [],
      interactedNpcIds: []
    };
  }

  function appendLog(world, day, entries, createdAt) {
    logSequence += 1;
    var visibleEntries = entries.map(function (entry) { return shortText(entry, 240); }).filter(Boolean).slice(0, 12);
    var summary = visibleEntries.length
      ? '第 ' + day + ' 天：' + shortText(visibleEntries.slice(0, 3).join('；'), 360)
      : '第 ' + day + ' 天平稳结束。';
    var log = {
      id: 'daily-log-' + day + '-' + createdAt + '-' + logSequence,
      day: day,
      summary: summary,
      entries: visibleEntries,
      createdAt: createdAt
    };
    world.dailyLogs = Array.isArray(world.dailyLogs) ? world.dailyLogs : [];
    world.dailyLogs.push(log);
    return log;
  }

  Settlement.version = 'task9-day-settlement';

  Settlement.settle = function (world, input) {
    if (!world || typeof world !== 'object') {
      return { ok: false, changed: false, world: world, reason: 'missing-world', message: '缺少模块四世界。' };
    }
    var next = normalWorld(world);
    if (text(next.clock && next.clock.period) !== 'evening') {
      return { ok: false, changed: false, world: next, reason: 'not-evening', message: '只能在晚间主要行动结束后进行日结算。' };
    }
    var source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    var createdAt = Number(source.createdAt);
    if (!Number.isFinite(createdAt) || createdAt <= 0) createdAt = Date.now();
    var day = currentDay(next);
    var eventFacts = Module4.Facts && typeof Module4.Facts.recordWorldEvents === 'function'
      ? Module4.Facts.recordWorldEvents(next)
      : { world: next, facts: [] };
    next = eventFacts.world || next;
    var facts = dayFacts(next, day);
    var entries = facts.map(function (fact) { return fact.summary; }).concat(unplayedNpcEntries(next));
    var dailyLog = appendLog(next, day, entries, createdAt);

    clearTemporaryState(next);
    next.clock = Object.assign({}, next.clock, { day: day + 1, period: 'morning' });
    next.player = Object.assign({}, next.player, { energy: next.player.maxEnergy });
    next.currentDay = newCurrentDay(day + 1);
    next.updatedAt = createdAt;

    return {
      ok: true,
      changed: true,
      world: next,
      day: day,
      nextDay: day + 1,
      facts: clone(eventFacts.facts || []),
      dailyLog: clone(dailyLog),
      message: '第 ' + day + ' 天已结算。现在是第 ' + (day + 1) + ' 天早晨，精力已恢复。'
    };
  };
}(window));
