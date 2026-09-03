/* Module 4 Task 4: world-scoped NPC source bindings and independent Runtime. */
(function (root) {
  var Module4 = root.Module4 = root.Module4 || {};
  Module4.World = Module4.World || {};

  var World = Module4.World;
  var FALLBACK_PERIODS = ['morning', 'afternoon', 'evening'];
  var SNAPSHOT_FIELDS = [
    'name',
    'appearance',
    'personality',
    'scenario',
    'notes',
    'relationship',
    'character_note',
    'creator_notes',
    'tags'
  ];

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function periods() {
    return Module4.Clock && Array.isArray(Module4.Clock.PERIODS)
      ? Module4.Clock.PERIODS
      : FALLBACK_PERIODS;
  }

  function fingerprint(value) {
    var hash = 2166136261;
    var input = String(value || '');
    for (var index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul ? Math.imul(hash, 16777619) : hash * 16777619;
    }
    return (hash >>> 0).toString(16);
  }

  function sourceObject(source) {
    return source && source.source && typeof source.source === 'object' ? source.source : source;
  }

  function sourceRefFor(source) {
    var card = sourceObject(source) || {};
    var explicit = card.sourceRef || card.source_ref;
    var explicitId = explicit && typeof explicit === 'object'
      ? (explicit.source_id || explicit.sourceId || explicit.id)
      : explicit;
    var directId = card.sourceId || card.source_id || card.id;
    if (explicitId || directId) return 'character-card:' + text(explicitId || directId);
    var fields = [
      card.name,
      card.appearance,
      card.personality,
      card.relationship,
      card.notes,
      card.scenario,
      card.first_mes,
      card.character_note,
      card.system_prompt,
      card.post_history_instructions,
      Array.isArray(card.tags) ? card.tags.join('\u001f') : card.tags
    ].map(text).join('\u001e');
    return 'character-card:fingerprint-' + fingerprint(fields);
  }

  function sourceVersionFor(source, sourceRef) {
    var card = sourceObject(source) || {};
    var explicit = card.sourceRef || card.source_ref;
    var version = card.sourceVersion || card.source_version || card.version || card.sourceHash || card.source_hash;
    if (!version && explicit && typeof explicit === 'object') {
      version = explicit.version || explicit.source_version || explicit.hash || explicit.source_hash;
    }
    return version ? text(sourceRef) + '@' + text(version) : text(sourceRef);
  }

  function snapshotValue(value) {
    if (Array.isArray(value)) return value.map(function (item) { return snapshotValue(item); });
    if (value && typeof value === 'object') return clone(value);
    return value == null ? '' : value;
  }

  function normalizeSnapshot(raw, fallbackName) {
    var source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var snapshot = Object.assign({}, source);
    SNAPSHOT_FIELDS.forEach(function (field) {
      if (hasOwn(source, field)) snapshot[field] = snapshotValue(source[field]);
      else snapshot[field] = field === 'tags' ? [] : '';
    });
    snapshot.name = text(snapshot.name) || text(fallbackName) || '未命名角色';
    if (!Array.isArray(snapshot.tags)) snapshot.tags = snapshot.tags ? [text(snapshot.tags)] : [];
    return snapshot;
  }

  function createSourceBinding(source) {
    var card = sourceObject(source);
    if (!card || typeof card !== 'object' || Array.isArray(card)) return null;
    var sourceRef = sourceRefFor(card);
    return {
      sourceRef: sourceRef,
      sourceVersion: sourceVersionFor(card, sourceRef),
      snapshot: normalizeSnapshot(card, card.name)
    };
  }

  function runtimeId(worldId, sourceRef) {
    return 'npc_' + fingerprint(text(worldId) + '\u001f' + text(sourceRef));
  }

  function normalizeRelation(raw) {
    var relation = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var value = Number(relation.value);
    return Object.assign({}, relation, {
      stage: text(relation.stage) || 'unknown',
      value: Number.isFinite(value) ? value : 0
    });
  }

  function normalizeSchedule(raw) {
    var source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var schedule = Object.assign({}, source);
    periods().forEach(function (period) {
      var slot = source[period];
      schedule[period] = slot && typeof slot === 'object' && !Array.isArray(slot) ? clone(slot) : {};
    });
    return schedule;
  }

  function createCurrentDay(day) {
    return {
      day: Number(day) > 0 ? Number(day) : 1,
      previewGenerated: false,
      previewStatus: 'idle',
      schedules: {},
      events: [],
      interactedNpcIds: []
    };
  }

  function normalizeNpc(raw, key) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var sourceRef = text(raw.sourceRef || raw.source_ref);
    var id = text(raw.id) || text(key) || ('npc_' + fingerprint(JSON.stringify(raw)));
    return Object.assign({}, raw, {
      id: id,
      sourceRef: sourceRef || 'legacy-runtime:' + id,
      name: text(raw.name) || '未命名角色',
      mood: text(raw.mood) || 'neutral',
      relation: normalizeRelation(raw.relation),
      goals: Array.isArray(raw.goals) ? clone(raw.goals) : [],
      temporaryState: Array.isArray(raw.temporaryState) ? clone(raw.temporaryState) : [],
      schedule: normalizeSchedule(raw.schedule)
    });
  }

  function sourceCandidates() {
    var candidates = [];
    if (typeof root.getCardLibrary === 'function') {
      try {
        candidates = candidates.concat(root.getCardLibrary() || []);
      } catch (error) {
        candidates = [];
      }
    }
    if (root.LOCAL_LIBRARY && Array.isArray(root.LOCAL_LIBRARY.cards)) {
      candidates = candidates.concat(root.LOCAL_LIBRARY.cards);
    }
    return candidates;
  }

  World.version = 'task9-facts-settlement';
  World.createInitialState = function () {
    return {
      npcs: {},
      locations: [],
      sourceBindings: {},
      scheduleRewrites: [],
      facts: [],
      dailyLogs: [],
      actionLogs: [],
      currentDay: createCurrentDay(1)
    };
  };
  World.createCurrentDay = function (day) { return createCurrentDay(day); };
  World.sourceRefFor = sourceRefFor;
  World.createSourceBinding = createSourceBinding;
  World.snapshotFields = SNAPSHOT_FIELDS.slice();

  World.normalizeWorld = function (world) {
    if (!world || typeof world !== 'object') return world;
    var rawNpcs = world.npcs && typeof world.npcs === 'object' && !Array.isArray(world.npcs)
      ? world.npcs
      : {};
    var npcs = {};
    Object.keys(rawNpcs).forEach(function (key) {
      var npc = normalizeNpc(rawNpcs[key], key);
      if (npc) npcs[npc.id] = npc;
    });
    world.npcs = npcs;

    var rawBindings = world.sourceBindings && typeof world.sourceBindings === 'object' && !Array.isArray(world.sourceBindings)
      ? world.sourceBindings
      : {};
    var sourceBindings = {};
    Object.keys(rawBindings).forEach(function (key) {
      var rawBinding = rawBindings[key];
      if (!rawBinding || typeof rawBinding !== 'object' || Array.isArray(rawBinding)) return;
      var sourceRef = text(rawBinding.sourceRef || rawBinding.source_ref || key);
      if (!sourceRef) return;
      sourceBindings[sourceRef] = Object.assign({}, rawBinding, {
        sourceRef: sourceRef,
        sourceVersion: text(rawBinding.sourceVersion || rawBinding.source_version) || sourceRef,
        snapshot: normalizeSnapshot(rawBinding.snapshot, rawBinding.name)
      });
    });
    Object.keys(npcs).forEach(function (id) {
      var npc = npcs[id];
      if (sourceBindings[npc.sourceRef]) return;
      sourceBindings[npc.sourceRef] = {
        sourceRef: npc.sourceRef,
        sourceVersion: 'legacy:' + npc.sourceRef,
        snapshot: normalizeSnapshot({ name: npc.name }, npc.name),
        migrated: true
      };
    });
    world.sourceBindings = sourceBindings;
    world.scheduleRewrites = Array.isArray(world.scheduleRewrites) ? clone(world.scheduleRewrites) : [];
    world.facts = Array.isArray(world.facts) ? clone(world.facts) : [];
    world.dailyLogs = Array.isArray(world.dailyLogs) ? clone(world.dailyLogs) : [];
    world.actionLogs = Array.isArray(world.actionLogs) ? clone(world.actionLogs).slice(-100) : [];

    var fallbackDay = world.clock && Number(world.clock.day) > 0 ? Number(world.clock.day) : 1;
    var rawCurrentDay = world.currentDay && typeof world.currentDay === 'object' && !Array.isArray(world.currentDay)
      ? world.currentDay
      : {};
    var currentDay = Number(rawCurrentDay.day);
    world.currentDay = Object.assign({}, rawCurrentDay, {
      day: Number.isFinite(currentDay) && currentDay > 0 ? currentDay : fallbackDay,
      previewGenerated: rawCurrentDay.previewGenerated === true,
      previewStatus: text(rawCurrentDay.previewStatus) || 'idle',
      schedules: rawCurrentDay.schedules && typeof rawCurrentDay.schedules === 'object' && !Array.isArray(rawCurrentDay.schedules)
        ? clone(rawCurrentDay.schedules)
        : {},
      events: Array.isArray(rawCurrentDay.events) ? clone(rawCurrentDay.events) : [],
      interactedNpcIds: Array.isArray(rawCurrentDay.interactedNpcIds)
        ? rawCurrentDay.interactedNpcIds.map(text).filter(Boolean).filter(function (id, index, ids) { return ids.indexOf(id) === index; })
        : []
    });
    return world;
  };

  World.listSourceCharacters = function () {
    var sourceMap = {};
    sourceCandidates().forEach(function (candidate) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
      var source = clone(candidate);
      var name = text(source.name);
      if (!name) return;
      var sourceRef = sourceRefFor(source);
      if (!sourceMap[sourceRef]) sourceMap[sourceRef] = { sourceRef: sourceRef, name: name, source: source };
    });
    return Object.keys(sourceMap).map(function (sourceRef) { return sourceMap[sourceRef]; });
  };

  World.listNpcs = function (world) {
    if (!world || typeof world !== 'object') return [];
    var next = clone(world);
    World.normalizeWorld(next);
    return Object.keys(next.npcs).map(function (id) { return clone(next.npcs[id]); }).sort(function (a, b) {
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  };

  World.createNpcRuntime = function (world, source) {
    var card = sourceObject(source);
    if (!world || !world.id || !card || !text(card.name)) return null;
    var sourceRef = sourceRefFor(card);
    return {
      id: runtimeId(world.id, sourceRef),
      sourceRef: sourceRef,
      name: text(card.name),
      mood: 'neutral',
      relation: { stage: 'unknown', value: 0 },
      goals: [],
      temporaryState: [],
      schedule: { morning: {}, afternoon: {}, evening: {} }
    };
  };

  World.addNpc = function (world, source) {
    if (!world || typeof world !== 'object') return { ok: false, changed: false, world: world, message: '缺少模块四世界。' };
    var next = clone(world);
    World.normalizeWorld(next);
    var npc = World.createNpcRuntime(next, source);
    if (!npc) return { ok: false, changed: false, world: next, message: '角色资料无效，无法加入。' };
    var binding = createSourceBinding(source);
    if (!binding) return { ok: false, changed: false, world: next, message: '角色资料无效，无法建立来源快照。' };
    var existing = Object.keys(next.npcs).map(function (id) { return next.npcs[id]; }).find(function (item) {
      return item.sourceRef === npc.sourceRef;
    });
    if (existing) return { ok: true, changed: false, world: next, npc: clone(existing), message: '该角色已在当前世界。' };
    if (!next.sourceBindings[npc.sourceRef] || next.sourceBindings[npc.sourceRef].migrated) {
      next.sourceBindings[npc.sourceRef] = binding;
    }
    next.npcs[npc.id] = npc;
    next.updatedAt = Date.now();
    return { ok: true, changed: true, world: next, npc: clone(npc), message: '已加入 ' + npc.name + '。原始角色资料保持不变。' };
  };

  World.addNpcFromSource = function (world, sourceRef) {
    var source = World.listSourceCharacters().find(function (item) { return item.sourceRef === sourceRef; });
    return World.addNpc(world, source || null);
  };

  World.getNpcSourceSnapshot = function (world, sourceRef) {
    if (!world || typeof world !== 'object') return null;
    var next = clone(world);
    World.normalizeWorld(next);
    var binding = next.sourceBindings[text(sourceRef)];
    return binding ? clone(binding.snapshot) : null;
  };

  World.getNpcSourceBinding = function (world, sourceRef) {
    if (!world || typeof world !== 'object') return null;
    var next = clone(world);
    World.normalizeWorld(next);
    var binding = next.sourceBindings[text(sourceRef)];
    return binding ? clone(binding) : null;
  };

  World.updateNpc = function (world, npcId, patch) {
    if (!world || typeof world !== 'object' || !patch || typeof patch !== 'object') return null;
    var next = clone(world);
    World.normalizeWorld(next);
    var current = next.npcs[npcId];
    if (!current) return null;
    var updated = Object.assign({}, current, patch, { id: current.id, sourceRef: current.sourceRef });
    if (patch.relation && typeof patch.relation === 'object') {
      updated.relation = Object.assign({}, current.relation, patch.relation);
    }
    if (patch.schedule && typeof patch.schedule === 'object') {
      updated.schedule = Object.assign({}, current.schedule, clone(patch.schedule));
    }
    if (Array.isArray(patch.goals)) updated.goals = clone(patch.goals);
    if (Array.isArray(patch.temporaryState)) updated.temporaryState = clone(patch.temporaryState);
    next.npcs[npcId] = normalizeNpc(updated, npcId);
    next.updatedAt = Date.now();
    return next;
  };
}(window));
