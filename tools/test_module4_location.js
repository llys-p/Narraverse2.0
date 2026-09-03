/* Minimal Task 5 headless check: locations, movement, schedule-bound encounters, and reload. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

function loadModules(localStorage) {
  const context = { console: { error() {}, log() {} }, localStorage, crypto: null };
  context.window = context;
  vm.createContext(context);
  for (const file of [
    'app/module4/core/world.js',
    'app/module4/core/clock.js',
    'app/module4/core/schedule.js',
    'app/module4/core/location.js',
    'app/module4/core/encounter.js',
    'app/module4/state/migrations.js',
    'app/module4/state/store.js',
  ]) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return {
    world: context.Module4.World,
    clock: context.Module4.Clock,
    location: context.Module4.Location,
    schedule: context.Module4.Schedule,
    encounter: context.Module4.Encounter,
    store: context.Module4.State.Store,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyDailySchedule(world, npcId, schedule) {
  const next = plain(world);
  next.currentDay = {
    day: next.clock.day,
    previewGenerated: true,
    previewStatus: 'completed',
    schedules: {
      [npcId]: { npcId, mood: 'calm', goal: '完成日常工作', schedule },
    },
    events: [],
  };
  next.npcs[npcId].schedule = plain(schedule);
  return next;
}

const localStorage = createStorage();
let { world: World, clock: Clock, location: Location, schedule: Schedule, encounter: Encounter, store: Store } = loadModules(localStorage);
let world = Store.createWorld({
  title: '地点相遇测试世界',
  description: '用于验证地点和日程。',
  locations: [
    { id: 'classroom', name: '教室', description: '上课的地方' },
    { id: 'library', name: '图书馆', description: '安静的地方' },
    { id: 'park', name: '公园', description: '树下长椅' },
  ],
  player: { name: '林舟', location: 'classroom' },
});
world = World.addNpc(world, { name: '艾琳', personality: '谨慎' }).world;
const npcId = Object.keys(world.npcs)[0];
const schedule = {
  morning: { locationId: 'classroom', activity: '上课' },
  afternoon: { locationId: 'library', activity: '整理资料' },
  evening: { locationId: 'park', activity: '散步' },
};
world = applyDailySchedule(world, npcId, schedule);
world.clock.period = 'afternoon';
world = Store.saveWorld(world);

assert.strictEqual(Location.get(world, 'library').name, '图书馆');
assert.strictEqual(Schedule.getEffectiveSlot(world, npcId, 'afternoon').locationId, 'library');
const moved = Location.movePlayer(world, 'library');
assert.strictEqual(moved.ok, true);
assert.strictEqual(moved.changed, true);
assert.strictEqual(moved.world.player.location, 'library');
assert.strictEqual(moved.world.clock.period, 'afternoon');
const natural = Encounter.checkNatural(moved.world);
assert.strictEqual(natural.ok, true);
assert.strictEqual(natural.found, true);
assert.deepStrictEqual(plain(natural.npcIds), [npcId]);

const nameReferenceWorld = plain(moved.world);
nameReferenceWorld.currentDay.schedules[npcId].schedule.afternoon = { location: '图书馆', activity: '整理资料' };
nameReferenceWorld.npcs[npcId].schedule.afternoon = { location: '图书馆', activity: '整理资料' };
assert.strictEqual(Location.get(nameReferenceWorld, '图书馆').id, 'library');
assert.strictEqual(Encounter.checkNatural(nameReferenceWorld).found, true);
assert.strictEqual(Encounter.seekNpc(nameReferenceWorld, npcId).found, true);

const otherNameWorld = plain(nameReferenceWorld);
otherNameWorld.currentDay.schedules[npcId].schedule.afternoon = { location: '教室', activity: '上课' };
otherNameWorld.npcs[npcId].schedule.afternoon = { location: '教室', activity: '上课' };
assert.strictEqual(Encounter.checkNatural(otherNameWorld).found, false);
assert.strictEqual(Encounter.seekNpc(otherNameWorld, npcId).found, false);

const sought = Encounter.seekNpc(moved.world, npcId);
assert.strictEqual(sought.ok, true);
assert.strictEqual(sought.found, true);
assert.strictEqual(sought.npcs[0].id, npcId);

const morningWorld = plain(moved.world);
morningWorld.clock.period = 'morning';
const morningNatural = Encounter.checkNatural(morningWorld);
const morningSought = Encounter.seekNpc(morningWorld, npcId);
assert.strictEqual(morningNatural.ok, true);
assert.strictEqual(morningNatural.found, false);
assert.strictEqual(morningNatural.reason, 'not-scheduled-here');
assert.strictEqual(morningSought.ok, true);
assert.strictEqual(morningSought.found, false);
assert.strictEqual(morningSought.reason, 'not-scheduled-here');

morningWorld.player.location = 'classroom';
assert.strictEqual(Encounter.checkNatural(morningWorld).found, true);
const noTarget = Encounter.seekNpc(morningWorld, 'missing-npc');
assert.strictEqual(noTarget.ok, true);
assert.strictEqual(noTarget.found, false);
assert.strictEqual(noTarget.reason, 'unknown-npc');

Store.saveWorld(moved.world);
Store.openWorld(moved.world.id);
({ world: World, clock: Clock, location: Location, schedule: Schedule, encounter: Encounter, store: Store } = loadModules(localStorage));
const reloaded = Store.getCurrentWorld();
assert.strictEqual(reloaded.player.location, 'library');
assert.strictEqual(Location.get(reloaded, 'library').name, '图书馆');
assert.strictEqual(Encounter.checkNatural(reloaded).found, true);

const legacyStorage = createStorage();
legacyStorage.setItem('narraverse:module4:state', JSON.stringify({
  version: 1,
  currentWorldId: 'legacy-location-world',
  worlds: [{
    id: 'legacy-location-world',
    title: '旧地点世界',
    clock: { day: 1, period: 'morning' },
    player: { location: 'classroom', futurePlayerField: 'preserve-me' },
    npcs: {
      'legacy-npc': {
        id: 'legacy-npc',
        sourceRef: 'legacy-source',
        name: '旧 NPC',
        schedule: { morning: { locationId: 'classroom' } },
      },
    },
    currentDay: {
      day: 1,
      previewGenerated: true,
      schedules: { 'legacy-npc': { schedule: { morning: { locationId: 'classroom' } } } },
      events: [],
    },
  }],
}));
const legacy = loadModules(legacyStorage);
const legacyWorld = legacy.store.getCurrentWorld();
assert.strictEqual(legacyWorld.player.location, 'classroom');
assert.strictEqual(legacyWorld.player.futurePlayerField, 'preserve-me');
assert.strictEqual(legacy.location.get(legacyWorld, 'classroom').name, 'classroom');
assert.strictEqual(legacy.encounter.checkNatural(legacyWorld).found, true);

console.log('Module4 Task 5 Location + Encounter test passed.');
