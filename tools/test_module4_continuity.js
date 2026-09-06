/* Module 4 V1.5 S7 deterministic continuity fixture: seven days, bounded logs, and one event transition. */
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

function loadModules(storage) {
  const context = { console: { error() {}, log() {} }, localStorage: storage, crypto: null };
  context.window = context;
  vm.createContext(context);
  for (const file of [
    'app/module4/core/world.js',
    'app/module4/core/clock.js',
    'app/module4/core/schedule.js',
    'app/module4/core/location.js',
    'app/module4/core/encounter.js',
    'app/module4/core/facts.js',
    'app/module4/core/events.js',
    'app/module4/core/settlement.js',
    'app/module4/core/action.js',
    'app/module4/core/judgment.js',
    'app/module4/state/migrations.js',
    'app/module4/state/store.js',
  ]) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return {
    Action: context.Module4.Action,
    Events: context.Module4.Events,
    Store: context.Module4.State.Store,
    World: context.Module4.World,
  };
}

const storage = createStorage();
const { Action, Events, Store, World } = loadModules(storage);
let world = Store.createWorld({
  rulesVersion: 'v1.5',
  title: '七日连续夹具',
  locations: [
    { id: 'classroom', name: '教室' },
    { id: 'library', name: '图书馆' },
    { id: 'bar', name: '酒吧' },
    { id: 'park', name: '公园' },
    { id: 'station', name: '车站' },
  ],
  player: { name: '林舟', location: 'classroom' },
});
for (const name of ['林雨', '周衡', '苏晚']) {
  world = World.addNpc(world, { name, personality: '固定夹具角色' }).world;
}
world = Events.add(world, {
  id: 'seven-day-event',
  title: '一次性七日事件',
  summary: '只允许完成一次的固定事件。',
  status: 'active',
  transitions: [{
    id: 'first-study',
    trigger: { type: 'action', actionType: 'study', day: 1 },
    summary: '玩家开始处理事件。',
    effects: { stage: 'started', status: 'resolved' },
  }],
}).world;
world = Store.saveWorld(world);

for (let day = 1; day <= 7; day += 1) {
  assert.strictEqual(world.clock.day, day);
  for (const type of ['study', 'study', 'train', 'train', 'intensive']) {
    const result = Action.execute(world, { type, source: 'recommended' });
    assert.strictEqual(result.ok, true);
    world = Store.saveWorld(result.world);
    assert.ok(world);
  }
  assert.strictEqual(world.clock.day, day + 1);
  assert.strictEqual(world.clock.period, 'morning');
  assert.strictEqual(world.clock.tick, 0);
  assert.strictEqual(world.player.energy, 100);
  assert.strictEqual(world.currentDay.day, day + 1);
  assert.strictEqual(world.currentDay.previewGenerated, false);
}

assert.strictEqual(world.clock.day, 8);
assert.strictEqual(world.dailyLogs.length, 7);
assert.strictEqual(world.actionLogs.length, 35);
assert.strictEqual(world.facts.filter((fact) => fact.type === 'world_event').length, 1);
assert.strictEqual(world.events.find((event) => event.id === 'seven-day-event').status, 'resolved');
assert.strictEqual(world.events.find((event) => event.id === 'seven-day-event').appliedTransitionIds.length, 1);
assert.strictEqual(Store.getCurrentWorld().clock.day, 8);

console.log('Module4 V1.5 S7 continuity test passed.');
