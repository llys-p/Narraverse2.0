/* Module 4 Task 5: schedule-bound natural encounters and active search. */
(function (root) {
  var Module4 = root.Module4 = root.Module4 || {};
  Module4.Encounter = Module4.Encounter || {};

  var Encounter = Module4.Encounter;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalizedWorld(world) {
    var next = clone(world);
    if (Module4.Location && typeof Module4.Location.normalizeWorld === 'function') {
      Module4.Location.normalizeWorld(next);
    } else if (Module4.World && typeof Module4.World.normalizeWorld === 'function') {
      Module4.World.normalizeWorld(next);
    }
    return next;
  }

  function locationId(world, reference) {
    var location = Module4.Location && typeof Module4.Location.get === 'function'
      ? Module4.Location.get(world, reference)
      : null;
    return location ? location.id : text(reference);
  }

  function noEncounter(world, kind, reason, npcId) {
    return {
      ok: true,
      found: false,
      changed: false,
      kind: kind,
      reason: reason,
      npcId: npcId || null,
      period: world.clock && world.clock.period,
      locationId: world.player && world.player.location || '',
      npcs: [],
      message: reason === 'no-location'
        ? '你还没有选择地点。'
        : reason === 'no-current-schedule'
          ? '今天的 NPC 日程还没有生成。'
          : '这里暂时没有遇到符合当前日程的 NPC。'
    };
  }

  function currentSlot(world, npcId) {
    if (!Module4.Schedule || typeof Module4.Schedule.getEffectiveSlot !== 'function') return null;
    return Module4.Schedule.getEffectiveSlot(world, npcId, world.clock && world.clock.period);
  }

  function isAtPlayerLocation(world, slot) {
    var target = locationId(world, Module4.Schedule.getLocationRef(slot));
    return !!target && target === text(world.player && world.player.location);
  }

  Encounter.version = 'task5-location-encounter';

  Encounter.checkNatural = function (world) {
    if (!world || typeof world !== 'object') return { ok: false, found: false, changed: false, kind: 'natural', message: '缺少模块四世界。' };
    var next = normalizedWorld(world);
    if (!next.player.location) return noEncounter(next, 'natural', 'no-location');
    if (!Module4.Schedule.isCurrentDayValid(next)) return noEncounter(next, 'natural', 'no-current-schedule');
    var found = [];
    Object.keys(next.npcs || {}).forEach(function (npcId) {
      var slot = currentSlot(next, npcId);
      if (slot && isAtPlayerLocation(next, slot)) found.push(clone(next.npcs[npcId]));
    });
    var location = Module4.Location.get(next, next.player.location);
    return {
      ok: true,
      found: found.length > 0,
      changed: false,
      kind: 'natural',
      reason: found.length ? null : 'not-scheduled-here',
      period: next.clock.period,
      locationId: next.player.location,
      npcIds: found.map(function (npc) { return npc.id; }),
      npcs: found,
      message: found.length
        ? '你在' + (location ? location.name : next.player.location) + '遇到了：' + found.map(function (npc) { return npc.name; }).join('、') + '。'
        : '这里暂时没有遇到符合当前日程的 NPC。'
    };
  };

  Encounter.seekNpc = function (world, npcId) {
    if (!world || typeof world !== 'object') return { ok: false, found: false, changed: false, kind: 'seek', message: '缺少模块四世界。' };
    var next = normalizedWorld(world);
    if (!next.player.location) return noEncounter(next, 'seek', 'no-location', npcId);
    if (!Module4.Schedule.isCurrentDayValid(next)) return noEncounter(next, 'seek', 'no-current-schedule', npcId);
    var npc = next.npcs && next.npcs[text(npcId)];
    if (!npc) return noEncounter(next, 'seek', 'unknown-npc', npcId);
    var slot = currentSlot(next, npc.id);
    if (slot && isAtPlayerLocation(next, slot)) {
      return {
        ok: true,
        found: true,
        changed: false,
        kind: 'seek',
        npcId: npc.id,
        period: next.clock.period,
        locationId: next.player.location,
        npcs: [clone(npc)],
        message: '你在当前地点找到了' + npc.name + '。'
      };
    }
    return noEncounter(next, 'seek', 'not-scheduled-here', npc.id);
  };
}(window));
