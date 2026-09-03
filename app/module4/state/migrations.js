/* Module 4 Task 4: keep module-specific state isolated and forward-compatible. */
(function (root) {
  var Module4 = root.Module4 = root.Module4 || {};
  Module4.State = Module4.State || {};
  Module4.State.Migrations = Module4.State.Migrations || {};

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalizeWorld(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var id = text(raw.id);
    var title = text(raw.title);
    if (!id || !title) return null;
    var sourcePlayer = raw.player && typeof raw.player === 'object' ? raw.player : {};
    var world = Object.assign({}, raw);
    world.id = id;
    world.title = title;
    world.description = text(raw.description);
    world.player = Object.assign({}, sourcePlayer, {
      name: text(sourcePlayer.name),
      identity: text(sourcePlayer.identity),
      energy: sourcePlayer.energy,
      maxEnergy: sourcePlayer.maxEnergy
    });
    world.createdAt = Number(raw.createdAt) || Date.now();
    world.updatedAt = Number(raw.updatedAt) || world.createdAt;
    if (Module4.Clock && typeof Module4.Clock.normalizeWorld === 'function') Module4.Clock.normalizeWorld(world);
    if (Module4.World && typeof Module4.World.normalizeWorld === 'function') Module4.World.normalizeWorld(world);
    if (Module4.Location && typeof Module4.Location.normalizeWorld === 'function') Module4.Location.normalizeWorld(world);
    return world;
  }

  Module4.State.Migrations.apply = function (raw) {
    var source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var seen = {};
    var worlds = Array.isArray(source.worlds) ? source.worlds.map(normalizeWorld).filter(function (world) {
      if (!world || seen[world.id]) return false;
      seen[world.id] = true;
      return true;
    }) : [];
    var currentWorldId = text(source.currentWorldId);
    if (!worlds.some(function (world) { return world.id === currentWorldId; })) currentWorldId = null;
    return Object.assign({}, source, {
      version: 1,
      currentWorldId: currentWorldId,
      worlds: worlds
    });
  };
}(window));
