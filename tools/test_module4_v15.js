/* Module 4 V1.5 S0 fixture: three NPCs, five locations, time ticks, and revision-safe persistence. */
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
    'app/module4/core/facts.js',
    'app/module4/core/settlement.js',
    'app/module4/core/action.js',
    'app/module4/state/migrations.js',
    'app/module4/state/store.js',
  ]) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return {
    Action: context.Module4.Action,
    Clock: context.Module4.Clock,
    World: context.Module4.World,
    Store: context.Module4.State.Store,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyFixtureSchedules(world, npcEntries) {
  const next = plain(world);
  next.currentDay = {
    day: next.clock.day,
    previewGenerated: true,
    previewStatus: 'completed',
    schedules: {},
    events: [],
    interactedNpcIds: [],
  };
  npcEntries.forEach((entry) => {
    const schedule = {
      morning: { locationId: entry.morning, activity: '处理上午事务' },
      afternoon: { locationId: entry.afternoon, activity: '处理下午事务' },
      evening: { locationId: entry.evening, activity: '结束当天安排' },
    };
    next.currentDay.schedules[entry.id] = {
      npcId: entry.id,
      mood: 'focused',
      goal: '完成今日安排',
      schedule,
    };
    next.npcs[entry.id].schedule = plain(schedule);
  });
  return next;
}

const { Action, Clock, World, Store } = loadModules(createStorage());
let world = Store.createWorld({
  rulesVersion: 'v1.5',
  title: 'V1.5 三人五地回归世界',
  description: '固定合成夹具，不连接模型服务。',
  locations: [
    { id: 'classroom', name: '教室' },
    { id: 'library', name: '图书馆' },
    { id: 'bar', name: '酒吧' },
    { id: 'park', name: '公园' },
    { id: 'station', name: '车站' },
  ],
  player: { name: '林舟', identity: '观察者', location: 'classroom' },
});

assert.strictEqual(world.rulesVersion, 'v1.5');
assert.strictEqual(world.schemaVersion, 2);
assert.strictEqual(world.revision, 0);
assert.deepStrictEqual(plain(world.clock), { day: 1, period: 'morning', tick: 0 });
assert.strictEqual(world.locations.length, 5);

const npcEntries = [
  { name: '林雨', personality: '谨慎', morning: 'bar', afternoon: 'library', evening: 'park' },
  { name: '周衡', personality: '务实', morning: 'library', afternoon: 'station', evening: 'classroom' },
  { name: '苏晚', personality: '好奇', morning: 'park', afternoon: 'classroom', evening: 'bar' },
];
const addedEntries = npcEntries.map((entry) => {
  const added = World.addNpc(world, entry);
  assert.strictEqual(added.ok, true);
  world = added.world;
  return { ...entry, id: added.npc.id };
});
world = applyFixtureSchedules(world, addedEntries);
assert.strictEqual(Object.keys(world.npcs).length, 3);

const composite = Action.normalize('我去酒吧找林雨');
assert.strictEqual(composite.type, 'move');
assert.strictEqual(composite.targetLocationId, '酒吧');
assert.strictEqual(composite.followUp.type, 'seek');
assert.strictEqual(composite.followUp.targetNpcId, '林雨');

const noOpMove = Action.execute(world, { type: 'move', targetLocationId: 'classroom', text: '去教室' });
assert.strictEqual(noOpMove.ok, true);
assert.strictEqual(noOpMove.world.player.location, 'classroom');
assert.strictEqual(noOpMove.world.player.energy, world.player.energy);
assert.deepStrictEqual(plain(noOpMove.world.clock), plain(world.clock));
assert.strictEqual(noOpMove.judgment.required, false);

const moved = Action.execute(world, { type: 'move', targetLocationId: 'library', text: '去图书馆' });
assert.strictEqual(moved.ok, true);
assert.strictEqual(moved.world.player.location, 'library');
assert.strictEqual(moved.world.clock.period, 'morning');
assert.strictEqual(moved.world.clock.tick, 1);
assert.strictEqual(moved.world.player.energy, 95);

const waited = Action.execute(moved.world, '等到晚上');
assert.strictEqual(waited.ok, true);
assert.strictEqual(waited.action.type, 'wait');
assert.strictEqual(waited.world.clock.period, 'evening');
assert.strictEqual(waited.world.clock.tick, 0);
assert.strictEqual(waited.world.player.energy, 95);

const slept = Action.execute(waited.world, '睡到明天');
assert.strictEqual(slept.ok, true);
assert.strictEqual(slept.action.type, 'sleep');
assert.strictEqual(slept.world.clock.day, 2);
assert.strictEqual(slept.world.clock.period, 'morning');
assert.strictEqual(slept.world.clock.tick, 0);
assert.strictEqual(slept.world.player.energy, 100);

const saved = Store.saveWorld(world);
assert.strictEqual(saved.revision, 1);
const stale = plain(saved);
const fresh = plain(saved);
fresh.title = 'V1.5 三人五地回归世界（已更新）';
const freshSaved = Store.saveWorld(fresh);
assert.strictEqual(freshSaved.revision, 2);
assert.strictEqual(Store.saveWorld(stale), null);
assert.strictEqual(Store.getCurrentWorld().title, fresh.title);

console.log('Module4 V1.5 S0 fixture test passed.');
