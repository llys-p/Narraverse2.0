/* Module 4 Task 4: independent local persistence for worlds and Daily Preview state. */
(function (root) {
  var Module4 = root.Module4 = root.Module4 || {};
  Module4.State = Module4.State || {};
  Module4.State.Store = Module4.State.Store || {};

  var Store = Module4.State.Store;
  var namespace = 'narraverse:module4';
  var storageKey = namespace + ':state';
  var recoveryKey = storageKey + ':recovery';
  var state = { version: 2, currentWorldId: null, worlds: [] };
  var recovery = { available: false, reason: null };
  var loaded = false;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function storage() {
    try { return root.localStorage; } catch (error) { return null; }
  }

  function emptyState() {
    return { version: 2, currentWorldId: null, worlds: [] };
  }

  function markRecovery(target, serialized, reason) {
    recovery = { available: true, reason: reason || 'invalid-state' };
    if (!target || typeof serialized !== 'string') return;
    try {
      if (!target.getItem(recoveryKey)) target.setItem(recoveryKey, serialized);
    } catch (error) {
      /* 原始存档仍留在主键；恢复副本写入失败时不输出原始内容。 */
    }
  }

  function persist() {
    var target = storage();
    if (!target || recovery.available) return false;
    try {
      target.setItem(storageKey, JSON.stringify(state));
      return true;
    } catch (error) {
      console.error('Module4 状态保存失败:', error);
      return false;
    }
  }

  function ensureLoaded() {
    if (!loaded) Store.load();
  }

  function makeId() {
    var randomUuid = root.crypto && typeof root.crypto.randomUUID === 'function'
      ? root.crypto.randomUUID()
      : Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    return 'module4_world_' + randomUuid;
  }

  function normalizeNewWorld(input) {
    var source = input && typeof input === 'object' ? input : {};
    var rulesVersion = source.rulesVersion === 'v1.5' ? 'v1.5' : 'legacy';
    var player = source.player && typeof source.player === 'object' ? source.player : {};
    var worldInitial = Module4.World.createInitialState(rulesVersion);
    var clockInitial = Module4.Clock.createInitialState(rulesVersion);
    var locations = Module4.Location && typeof Module4.Location.fromInput === 'function'
      ? Module4.Location.fromInput(source.locations)
      : (Array.isArray(source.locations) ? clone(source.locations) : []);
    var now = Date.now();
    return {
      id: makeId(),
      schemaVersion: rulesVersion === 'v1.5' ? 2 : 1,
      rulesVersion: rulesVersion,
      revision: 0,
      title: String(source.title == null ? '' : source.title).trim(),
      description: String(source.description == null ? '' : source.description).trim(),
      player: Object.assign({}, clockInitial.player, {
        name: String(player.name == null ? '' : player.name).trim(),
        identity: String(player.identity == null ? '' : player.identity).trim(),
        location: String(player.location == null ? (locations[0] && locations[0].id || '') : player.location).trim()
      }),
      clock: clockInitial.clock,
      npcs: worldInitial.npcs,
      locations: locations,
      sourceBindings: worldInitial.sourceBindings,
      scheduleRewrites: worldInitial.scheduleRewrites,
      sceneObjects: worldInitial.sceneObjects,
      events: worldInitial.events,
      npcRelations: worldInitial.npcRelations,
      knowledge: worldInitial.knowledge,
      facts: worldInitial.facts,
      dailyLogs: worldInitial.dailyLogs,
      actionLogs: worldInitial.actionLogs,
      narrativeEntries: worldInitial.narrativeEntries,
      currentDay: worldInitial.currentDay,
      createdAt: now,
      updatedAt: now
    };
  }

  Store.namespace = namespace;
  Store.storageKey = storageKey;
  Store.recoveryKey = recoveryKey;
  Store.load = function () {
    var raw = null;
    var target = storage();
    recovery = { available: false, reason: null };
    if (target) {
      var serialized = null;
      try {
        serialized = target.getItem(storageKey);
        if (serialized) raw = JSON.parse(serialized);
      } catch (error) {
        markRecovery(target, serialized, 'invalid-json');
        console.error('Module4 状态读取失败，原始存档已保留。');
      }
    }
    var migrate = Module4.State.Migrations && Module4.State.Migrations.apply;
    try {
      state = migrate ? migrate(raw) : emptyState();
    } catch (error) {
      state = emptyState();
      if (target) markRecovery(target, target.getItem(storageKey), 'invalid-state');
      console.error('Module4 状态迁移失败，原始存档已保留。');
    }
    loaded = true;
    return Store.getState();
  };
  Store.getRecovery = function () {
    ensureLoaded();
    return { available: recovery.available, key: recoveryKey, reason: recovery.reason };
  };
  Store.restoreRecovery = function () {
    ensureLoaded();
    var target = storage();
    if (!target || !recovery.available) return null;
    var serialized = null;
    var restored;
    try {
      serialized = target.getItem(recoveryKey);
      if (!serialized) return null;
      restored = JSON.parse(serialized);
      var migrate = Module4.State.Migrations && Module4.State.Migrations.apply;
      restored = migrate ? migrate(restored) : restored;
      if (!restored || !Array.isArray(restored.worlds)) return null;
      target.setItem(storageKey, JSON.stringify(restored));
      state = restored;
      recovery = { available: false, reason: null };
      loaded = true;
      return Store.getState();
    } catch (error) {
      /* 恢复失败时保留主存档和恢复副本，不输出其内容。 */
      return null;
    }
  };
  Store.isLoaded = function () { return loaded; };
  Store.getState = function () {
    ensureLoaded();
    return clone(state);
  };
  Store.listWorlds = function () {
    ensureLoaded();
    return state.worlds.slice().sort(function (a, b) {
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    }).map(clone);
  };
  Store.getWorld = function (id) {
    ensureLoaded();
    var world = state.worlds.find(function (item) { return item.id === id; });
    return clone(world || null);
  };
  Store.getCurrentWorld = function () {
    ensureLoaded();
    return Store.getWorld(state.currentWorldId);
  };
  Store.createWorld = function (input) {
    ensureLoaded();
    var world = normalizeNewWorld(input);
    if (!world.title) throw new Error('世界名称不能为空');
    var previousWorldId = state.currentWorldId;
    state.worlds.push(world);
    state.currentWorldId = world.id;
    if (!persist()) {
      state.worlds.pop();
      state.currentWorldId = previousWorldId;
      throw new Error(recovery.available ? '模块四存档正在恢复，世界未保存' : '模块四存储不可用，世界未保存');
    }
    return clone(world);
  };
  Store.openWorld = function (id) {
    ensureLoaded();
    if (!state.worlds.some(function (world) { return world.id === id; })) return null;
    var previousWorldId = state.currentWorldId;
    state.currentWorldId = id;
    if (!persist()) {
      state.currentWorldId = previousWorldId;
      throw new Error(recovery.available ? '模块四存档正在恢复，打开状态未保存' : '模块四存储不可用，打开状态未保存');
    }
    return Store.getWorld(id);
  };
  Store.deleteWorld = function (id) {
    ensureLoaded();
    var index = state.worlds.findIndex(function (world) { return world.id === id; });
    if (index < 0) return false;
    var removed = state.worlds.splice(index, 1)[0];
    var previousWorldId = state.currentWorldId;
    if (state.currentWorldId === id) state.currentWorldId = state.worlds[0] ? state.worlds[0].id : null;
    if (!persist()) {
      state.worlds.splice(index, 0, removed);
      state.currentWorldId = previousWorldId;
      throw new Error(recovery.available ? '模块四存档正在恢复，世界未删除' : '模块四存储不可用，世界未删除');
    }
    return true;
  };
  Store.saveWorld = function (world) {
    ensureLoaded();
    if (!world || !world.id) return null;
    var index = state.worlds.findIndex(function (item) { return item.id === world.id; });
    if (index < 0) return null;
    var previous = state.worlds[index];
    var expectedRevision = Number(world.revision);
    var currentRevision = Number(previous.revision) || 0;
    if (world.rulesVersion === 'v1.5'
        && Number.isFinite(expectedRevision)
        && expectedRevision !== currentRevision) return null;
    var next = clone(world);
    next.schemaVersion = Number(next.schemaVersion) || (next.rulesVersion === 'v1.5' ? 2 : 1);
    next.rulesVersion = next.rulesVersion === 'v1.5' ? 'v1.5' : 'legacy';
    next.revision = currentRevision + 1;
    next.updatedAt = Date.now();
    state.worlds[index] = next;
    if (!persist()) {
      state.worlds[index] = previous;
      throw new Error(recovery.available ? '模块四存档正在恢复，世界未保存' : '模块四存储不可用，世界未保存');
    }
    return clone(next);
  };
  Store.save = function () {
    ensureLoaded();
    return persist();
  };
}(window));
