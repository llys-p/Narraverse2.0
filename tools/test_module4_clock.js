/* Minimal Task 2 headless check: clock transitions, energy limits, migration, persistence. */
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
    'app/module4/core/facts.js',
    'app/module4/core/settlement.js',
    'app/module4/state/migrations.js',
    'app/module4/state/store.js',
  ]) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return { clock: context.Module4.Clock, settlement: context.Module4.Settlement, store: context.Module4.State.Store };
}

const localStorage = createStorage();
const legacyStorage = createStorage();
legacyStorage.setItem('narraverse:module4:state', JSON.stringify({
  version: 1,
  currentWorldId: 'legacy-world',
  worlds: [{
    id: 'legacy-world',
    title: '旧任务世界',
    description: '由 Task 1 创建的世界。',
    player: { name: '旧玩家', identity: '旅人' },
    createdAt: 1,
    updatedAt: 2,
    preservedField: 'must-survive-migration',
  }],
}));
const legacy = loadModules(legacyStorage);
assert.strictEqual(JSON.stringify(legacy.store.getWorld('legacy-world').clock), JSON.stringify({ day: 1, period: 'morning' }));
assert.strictEqual(legacy.store.getWorld('legacy-world').player.energy, 100);
assert.strictEqual(legacy.store.getWorld('legacy-world').player.maxEnergy, 100);
assert.strictEqual(legacy.store.getWorld('legacy-world').preservedField, 'must-survive-migration');
assert.deepStrictEqual(JSON.parse(JSON.stringify(legacy.store.getWorld('legacy-world').facts)), []);
assert.deepStrictEqual(JSON.parse(JSON.stringify(legacy.store.getWorld('legacy-world').dailyLogs)), []);

let { clock, settlement, store } = loadModules(localStorage);
const world = store.createWorld({ title: '时间测试世界' });
assert.deepStrictEqual(
  JSON.parse(JSON.stringify({ clock: world.clock, player: world.player })),
  { clock: { day: 1, period: 'morning' }, player: { energy: 100, maxEnergy: 100, name: '', identity: '', location: '' } },
);

const free = clock.applyAction(world, 'view_status');
assert.strictEqual(free.ok, true);
assert.strictEqual(free.changed, false);
assert.strictEqual(free.world.clock.period, 'morning');

let result = clock.applyAction(world, 'study');
assert.strictEqual(result.ok, true);
assert.strictEqual(result.world.clock.period, 'afternoon');
assert.strictEqual(result.world.player.energy, 90);
store.saveWorld(result.world);

result = clock.applyAction(store.getCurrentWorld(), 'explore');
assert.strictEqual(result.world.clock.period, 'evening');
assert.strictEqual(result.world.player.energy, 75);
store.saveWorld(result.world);

result = clock.applyAction(store.getCurrentWorld(), 'train');
assert.strictEqual(result.requiresSettlement, true);
assert.strictEqual(result.world.clock.day, 1);
assert.strictEqual(result.world.clock.period, 'evening');
assert.strictEqual(result.world.player.energy, 55);
const settled = settlement.settle(result.world);
assert.strictEqual(settled.ok, true);
assert.strictEqual(settled.world.clock.day, 2);
assert.strictEqual(settled.world.clock.period, 'morning');
assert.strictEqual(settled.world.player.energy, 100);
store.saveWorld(settled.world);

const insufficient = clock.applyAction({
  ...settled.world,
  player: { ...settled.world.player, energy: 5 },
}, 'explore');
assert.strictEqual(insufficient.ok, false);
assert.strictEqual(insufficient.world.clock.day, 2);
assert.strictEqual(insufficient.world.player.energy, 5);

({ clock, settlement, store } = loadModules(localStorage));
assert.strictEqual(store.getCurrentWorld().clock.day, 2);
assert.strictEqual(store.getCurrentWorld().clock.period, 'morning');
assert.strictEqual(store.getCurrentWorld().player.energy, 100);

console.log('Module4 Task 2 clock test passed.');
