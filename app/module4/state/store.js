/* Module 4 Task 4: independent local persistence for worlds and Daily Preview state. */
(function (root) {
  var Module4 = root.Module4 = root.Module4 || {};
  Module4.State = Module4.State || {};
  Module4.State.Store = Module4.State.Store || {};

  var Store = Module4.State.Store;
  var namespace = 'narraverse:module4';
  var storageKey = namespace + ':state';
  var state = { version: 1, currentWorldId: null, worlds: [] };
  var loaded = false;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function storage() {
    try { return root.localStorage; } catch (error) { return null; }
  }

  function persist() {
    var target = storage();
    if (!target) return false;
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
    var player = source.player && typeof source.player === 'object' ? source.player : {};
    var worldInitial = Module4.World.createInitialState();
    var locations = Module4.Location && typeof Module4.Location.fromInput === 'function'
      ? Module4.Location.fromInput(source.locations)
      : (Array.isArray(source.locations) ? clone(source.locations) : []);
    var now = Date.now();
    return {
      id: makeId(),
      title: String(source.title == null ? '' : source.title).trim(),
      description: String(source.description == null ? '' : source.description).trim(),
      player: Object.assign({}, Module4.Clock.createInitialState().player, {
        name: String(player.name == null ? '' : player.name).trim(),
        identity: String(player.identity == null ? '' : player.identity).trim(),
        location: String(player.location == null ? (locations[0] && locations[0].id || '') : player.location).trim()
      }),
      clock: Module4.Clock.createInitialState().clock,
      npcs: worldInitial.npcs,
      locations: locations,
      sourceBindings: worldInitial.sourceBindings,
      scheduleRewrites: worldInitial.scheduleRewrites,
      facts: worldInitial.facts,
      dailyLogs: worldInitial.dailyLogs,
      actionLogs: worldInitial.actionLogs,
      currentDay: worldInitial.currentDay,
      createdAt: now,
      updatedAt: now
    };
  }

  Store.namespace = namespace;
  Store.storageKey = storageKey;
  Store.load = function () {
    var raw = null;
    var target = storage();
    if (target) {
      try {
        var serialized = target.getItem(storageKey);
        if (serialized) raw = JSON.parse(serialized);
      } catch (error) {
        console.error('Module4 状态读取失败，使用空状态:', error);
      }
    }
    var migrate = Module4.State.Migrations && Module4.State.Migrations.apply;
    state = migrate ? migrate(raw) : { version: 1, currentWorldId: null, worlds: [] };
    loaded = true;
    return Store.getState();
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
      throw new Error('模块四存储不可用，世界未保存');
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
      throw new Error('模块四存储不可用，打开状态未保存');
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
      throw new Error('模块四存储不可用，世界未删除');
    }
    return true;
  };
  Store.saveWorld = function (world) {
    ensureLoaded();
    if (!world || !world.id) return null;
    var index = state.worlds.findIndex(function (item) { return item.id === world.id; });
    if (index < 0) return null;
    var previous = state.worlds[index];
    var next = clone(world);
    next.updatedAt = Date.now();
    state.worlds[index] = next;
    if (!persist()) {
      state.worlds[index] = previous;
      throw new Error('模块四存储不可用，世界未保存');
    }
    return clone(next);
  };
  Store.save = function () {
    ensureLoaded();
    return persist();
  };
}(window));
