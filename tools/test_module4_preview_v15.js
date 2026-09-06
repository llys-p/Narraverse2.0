/* Module 4 V1.5 S5 preview: automatic-ready semantics, legal schedule completion, and stable goals. */
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

function loadModules() {
  const context = { console: { error() {}, log() {} }, localStorage: createStorage(), crypto: null };
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
    'app/module4/ai/context.js',
    'app/module4/ai/prompts.js',
    'app/module4/ai/preview.js',
    'app/module4/state/migrations.js',
    'app/module4/state/store.js',
  ]) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return {
    Preview: context.Module4.AI.Preview,
    Store: context.Module4.State.Store,
    World: context.Module4.World,
  };
}

(async function () {
  const { Preview, Store, World } = loadModules();
  let world = Store.createWorld({
    rulesVersion: 'v1.5',
    title: 'V1.5 自动预演测试世界',
    locations: [{ id: 'library', name: '图书馆' }, { id: 'park', name: '公园' }],
    player: { name: '林舟', location: 'library' },
  });
  const added = World.addNpc(world, { name: '林雨', personality: '谨慎' });
  world = added.world;
  const npcId = added.npc.id;
  world.npcs[npcId].goals = ['长期调查旧钟'];

  let calls = 0;
  const sparse = await Preview.startDay(world, {
    maxAttempts: 1,
    callLLM: async () => {
      calls += 1;
      return JSON.stringify({
        npcs: [{ npcId, mood: '平静', goal: '今天整理线索', schedule: { morning: {}, afternoon: { locationId: '图书馆' }, evening: { locationId: '未知地点' } } }],
        worldEvents: [],
      });
    },
  });
  assert.strictEqual(sparse.ok, true);
  assert.strictEqual(sparse.status, 'fallback');
  assert.strictEqual(calls, 1);
  assert.strictEqual(sparse.world.npcs[npcId].goals[0], '长期调查旧钟');
  assert.strictEqual(sparse.world.npcs[npcId].dailyGoal, '长期调查旧钟');
  assert.strictEqual(Preview.isCurrentDayValid(sparse.world), true);
  ['morning', 'afternoon', 'evening'].forEach((period) => {
    const slot = sparse.world.currentDay.schedules[npcId].schedule[period];
    assert.ok(['library', 'park'].includes(slot.locationId));
    assert.ok(slot.activity);
  });

  let validCalls = 0;
  const valid = await Preview.startDay({
    ...world,
    id: 'v15-valid-preview-world',
  }, {
    maxAttempts: 1,
    callLLM: async () => {
      validCalls += 1;
      return JSON.stringify({
        npcs: [{ npcId, mood: '专注', goal: '处理当日事务', schedule: { morning: {}, afternoon: {}, evening: {} } }],
        worldEvents: [],
      });
    },
  });
  assert.strictEqual(valid.status, 'completed');
  assert.strictEqual(validCalls, 1);
  assert.strictEqual(Preview.isCurrentDayValid(valid.world), true);
  assert.strictEqual(valid.world.currentDay.schedules[npcId].schedule.morning.locationId, 'library');
  assert.strictEqual(valid.world.currentDay.schedules[npcId].schedule.evening.activity, '处理当日事务');

  const idempotent = await Preview.ensureDayReady(valid.world, {
    callLLM: async () => { throw new Error('ready day must not call model'); },
  });
  assert.strictEqual(idempotent.changed, false);
  assert.strictEqual(idempotent.idempotent, true);

  const empty = Store.createWorld({ rulesVersion: 'v1.5', title: '无 NPC 世界' });
  const emptyReady = await Preview.ensureDayReady(empty);
  assert.strictEqual(emptyReady.ok, true);
  assert.strictEqual(emptyReady.status, 'completed');
  assert.strictEqual(Preview.isCurrentDayValid(emptyReady.world), true);

  console.log('Module4 V1.5 S5 preview test passed.');
}()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
