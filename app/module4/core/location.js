/* Module 4 Task 5: world-scoped locations and player movement. */
(function (root) {
  var Module4 = root.Module4 = root.Module4 || {};
  Module4.Location = Module4.Location || {};

  var Location = Module4.Location;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function fingerprint(value) {
    var hash = 2166136261;
    var input = text(value);
    for (var index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul ? Math.imul(hash, 16777619) : hash * 16777619;
    }
    return (hash >>> 0).toString(16);
  }

  function normalizeLocation(raw, key) {
    var source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { name: raw };
    var name = text(source.name || source.title);
    var id = text(source.id) || ('location-' + fingerprint(name || key || 'unknown'));
    return Object.assign({}, source, {
      id: id,
      name: name || id,
      description: text(source.description)
    });
  }

  function uniqueLocations(rawLocations) {
    var seen = {};
    return (Array.isArray(rawLocations) ? rawLocations : []).map(function (raw, index) {
      return normalizeLocation(raw, String(index + 1));
    }).filter(function (location) {
      if (!location.id || seen[location.id]) return false;
      seen[location.id] = true;
      return true;
    });
  }

  function locationRef(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return text(value.locationId || value.id || value.name);
    return text(value);
  }

  function scheduleLocationRefs(world) {
    var refs = [];
    function add(value) {
      var reference = locationRef(value);
      if (reference && refs.indexOf(reference) < 0) refs.push(reference);
    }
    add(world.player && world.player.location);
    Object.keys(world.npcs || {}).forEach(function (id) {
      var schedule = world.npcs[id] && world.npcs[id].schedule;
      ['morning', 'afternoon', 'evening'].forEach(function (period) {
        if (schedule && schedule[period]) add(schedule[period].locationId || schedule[period].location);
      });
    });
    var currentSchedules = world.currentDay && world.currentDay.schedules;
    if (currentSchedules && typeof currentSchedules === 'object' && !Array.isArray(currentSchedules)) {
      Object.keys(currentSchedules).forEach(function (id) {
        var schedule = currentSchedules[id] && currentSchedules[id].schedule;
        ['morning', 'afternoon', 'evening'].forEach(function (period) {
          if (schedule && schedule[period]) add(schedule[period].locationId || schedule[period].location);
        });
      });
    }
    return refs;
  }

  function findLocation(locations, reference) {
    var value = text(reference);
    return locations.find(function (location) {
      return location.id === value || location.name === value;
    }) || null;
  }

  Location.version = 'task5-location-encounter';
  Location.fromInput = function (input) {
    if (Array.isArray(input)) return uniqueLocations(input);
    if (typeof input !== 'string') return [];
    return uniqueLocations(input.split(/\r?\n/).map(function (line, index) {
      var parts = line.split('|').map(function (part) { return text(part); });
      return parts.length > 1
        ? { id: parts[0], name: parts[1], description: parts[2] || '' }
        : { name: parts[0] || ('地点 ' + (index + 1)) };
    }).filter(function (item) { return item.name || item.id; }));
  };

  Location.normalizeWorld = function (world) {
    if (!world || typeof world !== 'object') return world;
    if (Module4.World && typeof Module4.World.normalizeWorld === 'function') Module4.World.normalizeWorld(world);
    var locations = uniqueLocations(world.locations);
    scheduleLocationRefs(world).forEach(function (reference) {
      if (findLocation(locations, reference)) return;
      locations.push({ id: reference, name: reference, description: '', migrated: true });
    });
    world.locations = locations;
    var player = world.player && typeof world.player === 'object' ? world.player : {};
    var current = findLocation(locations, player.location);
    world.player = Object.assign({}, player, {
      location: current ? current.id : (locations.length ? locations[0].id : locationRef(player.location))
    });
    return world;
  };

  Location.list = function (world) {
    if (!world || typeof world !== 'object') return [];
    var next = clone(world);
    Location.normalizeWorld(next);
    return clone(next.locations);
  };

  Location.get = function (world, locationId) {
    var reference = text(locationId);
    var location = Location.list(world).find(function (item) {
      return item.id === reference || item.name === reference;
    });
    return location || null;
  };

  Location.movePlayer = function (world, locationId) {
    if (!world || typeof world !== 'object') return { ok: false, changed: false, world: world, message: '缺少模块四世界。' };
    var next = clone(world);
    Location.normalizeWorld(next);
    var target = findLocation(next.locations, locationId);
    if (!target) return { ok: false, changed: false, world: next, message: '目标地点不存在。' };
    var previous = next.player.location;
    if (previous === target.id) {
      return { ok: true, changed: false, kind: 'move', action: { type: 'move', target: target.id }, locationId: target.id, world: next, message: '你已经在' + target.name + '。' };
    }
    next.player.location = target.id;
    next.updatedAt = Date.now();
    return {
      ok: true,
      changed: true,
      kind: 'move',
      action: { type: 'move', target: target.id },
      previousLocationId: previous,
      locationId: target.id,
      world: next,
      message: '已移动到' + target.name + '。'
    };
  };
}(window));
