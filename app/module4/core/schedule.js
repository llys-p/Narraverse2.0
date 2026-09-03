/* Module 4 Task 8: raw Daily Preview slots plus traceable world-scoped rewrites. */
(function (root) {
  var Module4 = root.Module4 = root.Module4 || {};
  Module4.Schedule = Module4.Schedule || {};

  var Schedule = Module4.Schedule;
  var PERIODS = ['morning', 'afternoon', 'evening'];

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function positiveInteger(value, fallback) {
    var number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
  }

  function slotObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? clone(value) : null;
  }

  function currentDayValid(world) {
    if (Module4.AI && Module4.AI.Preview && typeof Module4.AI.Preview.isCurrentDayValid === 'function') {
      return Module4.AI.Preview.isCurrentDayValid(world);
    }
    return !!(world && world.currentDay && world.currentDay.previewGenerated === true
      && Number(world.currentDay.day) === Number(world.clock && world.clock.day));
  }

  function currentDay(world) {
    return positiveInteger(world && world.clock && world.clock.day, 1);
  }

  function originalSlot(world, npcId, period) {
    var npc = world.npcs && world.npcs[npcId];
    var daily = world.currentDay && world.currentDay.schedules && world.currentDay.schedules[npcId];
    var slot = daily && daily.schedule && daily.schedule[period];
    if (!slot && npc && npc.schedule) slot = npc.schedule[period];
    return slotObject(slot);
  }

  function latestRewrite(world, npcId, day, period) {
    var rewrites = Array.isArray(world && world.scheduleRewrites) ? world.scheduleRewrites : [];
    for (var index = rewrites.length - 1; index >= 0; index -= 1) {
      var rewrite = rewrites[index];
      if (!rewrite || typeof rewrite !== 'object') continue;
      if (text(rewrite.npcId) !== text(npcId)) continue;
      if (Number(rewrite.day) !== Number(day)) continue;
      if (text(rewrite.period) !== period) continue;
      var replacement = slotObject(rewrite.replacementSlot);
      if (replacement && text(replacement.locationId || replacement.location)) return rewrite;
    }
    return null;
  }

  function normalizedWorld(world) {
    var next = clone(world);
    if (Module4.World && typeof Module4.World.normalizeWorld === 'function') Module4.World.normalizeWorld(next);
    if (Module4.Clock && typeof Module4.Clock.normalizeWorld === 'function') Module4.Clock.normalizeWorld(next);
    return next;
  }

  function rejected(world, reason, message) {
    return { ok: false, changed: false, world: world, rewrite: null, reason: reason, message: message };
  }

  Schedule.version = 'task8-schedule-rewrite';
  Schedule.PERIODS = PERIODS.slice();
  Schedule.isCurrentDayValid = currentDayValid;

  Schedule.getOriginalSlot = function (world, npcId, period) {
    if (!world || PERIODS.indexOf(period) < 0 || !currentDayValid(world)) return null;
    return originalSlot(world, npcId, period);
  };

  Schedule.getEffectiveSlot = function (world, npcId, period) {
    if (!world || PERIODS.indexOf(period) < 0 || !currentDayValid(world)) return null;
    var rewrite = latestRewrite(world, npcId, currentDay(world), period);
    if (rewrite) return slotObject(rewrite.replacementSlot);
    return originalSlot(world, npcId, period);
  };

  Schedule.getLocationRef = function (slot) {
    return slot && typeof slot === 'object' ? text(slot.locationId || slot.location) : '';
  };

  Schedule.applyRewrite = function (world, input) {
    if (!world || typeof world !== 'object') return rejected(world, 'missing-world', '缺少模块四世界。');
    var next = normalizedWorld(world);
    var source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    var npcId = text(source.npcId);
    var day = positiveInteger(source.day, currentDay(next));
    var period = text(source.period);
    var replacement = slotObject(source.replacementSlot);
    var sourceActionId = text(source.sourceActionId);
    var sourceOutcome = text(source.sourceOutcome);
    if (!npcId || !next.npcs || !next.npcs[npcId]) return rejected(next, 'unknown-npc', '目标 NPC 不存在。');
    if (!currentDayValid(next) || day !== currentDay(next)) return rejected(next, 'invalid-day', '只能改写当前有效日程。');
    if (PERIODS.indexOf(period) < 0) return rejected(next, 'invalid-period', '目标时段无效。');
    if (!sourceActionId || !sourceOutcome) return rejected(next, 'missing-source', '日程改写缺少行动来源。');
    if (PERIODS.indexOf(period) <= PERIODS.indexOf(text(next.clock && next.clock.period))) {
      return rejected(next, 'not-future-period', '只能改写后续时段的日程。');
    }
    var original = originalSlot(next, npcId, period);
    if (!original) return rejected(next, 'missing-original-slot', '目标时段没有可改写的原始日程。');
    if (!replacement || !Schedule.getLocationRef(replacement)) {
      return rejected(next, 'invalid-replacement-slot', '新的日程地点无效。');
    }

    var createdAt = Number(source.createdAt);
    var rewrite = {
      npcId: npcId,
      day: day,
      period: period,
      originalSlot: original,
      replacementSlot: replacement,
      reason: text(source.reason) || '玩家行动改变后续安排',
      sourceActionId: sourceActionId,
      sourceOutcome: sourceOutcome,
      createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now()
    };
    next.scheduleRewrites = Array.isArray(next.scheduleRewrites) ? clone(next.scheduleRewrites) : [];
    next.scheduleRewrites.push(rewrite);
    next.updatedAt = Date.now();
    return {
      ok: true,
      changed: true,
      world: next,
      rewrite: clone(rewrite),
      reason: null,
      message: '已改写' + period + '时段的日程。'
    };
  };
}(window));
