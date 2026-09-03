/* Minimal Task 4 headless check: source binding, Daily Preview, retry/fallback, and reload. */
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

function loadModules(localStorage, adventureCards, libraryCards) {
  const context = {
    console: { error() {}, log() {} },
    localStorage,
    crypto: null,
    getCardLibrary() { return adventureCards; },
    LOCAL_LIBRARY: { cards: libraryCards },
  };
  context.window = context;
  vm.createContext(context);
  for (const file of [
    'app/module4/core/world.js',
    'app/module4/core/clock.js',
    'app/module4/core/facts.js',
    'app/module4/core/settlement.js',
    'app/module4/ai/prompts.js',
    'app/module4/ai/preview.js',
    'app/module4/state/migrations.js',
    'app/module4/state/store.js',
  ]) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return {
    world: context.Module4.World,
    clock: context.Module4.Clock,
    settlement: context.Module4.Settlement,
    preview: context.Module4.AI.Preview,
    store: context.Module4.State.Store,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function makePreview(world) {
  return {
    npcs: Object.values(world.npcs).map((npc) => ({
      npcId: npc.id,
      mood: 'focused',
      goal: '完成今日研究',
      schedule: {
        morning: { locationId: 'library', activity: '整理资料', intent: '准备工作' },
        afternoon: { activity: '前往图书馆', locationId: 'library' },
        evening: { locationId: 'library', activity: '回顾线索', availability: '可接触' },
      },
    })),
    worldEvents: [{ title: '旧钟响起', summary: '城镇今天比平时更早进入夜晚。' }],
  };
}

(async function () {
const card = {
  name: '艾琳',
  source_ref: { kind: 'character_card', source_id: 'master-erin' },
  appearance: '银色短发',
  personality: '谨慎而温柔',
  scenario: '在旧图书馆寻找失落的手稿',
  notes: '图书馆的研究员',
  relationship: '对玩家保持观察',
  character_note: '不喜欢被突然打断',
  creator_notes: '测试来源版本',
  tags: ['研究员', '图书馆'],
};
const adventureCards = [card];
const libraryCards = [];
const localStorage = createStorage();
let { world: World, clock: Clock, settlement: Settlement, preview: Preview, store } = loadModules(localStorage, adventureCards, libraryCards);

let world = store.createWorld({ title: '快照测试世界', description: '一座围绕旧图书馆展开的研究城镇。' });
world.locations = [{ id: 'library', name: '旧图书馆', description: '城镇中央的旧图书馆。' }];
world = store.saveWorld(world);
const sourceRef = World.sourceRefFor(card);
let added = World.addNpcFromSource(world, sourceRef);
assert.strictEqual(added.ok, true);
world = store.saveWorld(added.world);
const npcId = Object.keys(world.npcs)[0];
const binding = World.getNpcSourceBinding(world, sourceRef);
assert.strictEqual(binding.sourceRef, sourceRef);
assert.strictEqual(binding.sourceVersion, sourceRef);
assert.strictEqual(binding.snapshot.personality, '谨慎而温柔');
assert.deepStrictEqual(plain(binding.snapshot.tags), ['研究员', '图书馆']);
assert.strictEqual(binding.snapshot.mood, undefined);
assert.strictEqual(binding.snapshot.schedule, undefined);

card.personality = '已经被修改的性格';
card.notes = '已经被删除前的最新资料';
adventureCards.length = 0;
libraryCards.length = 0;

let calls = 0;
let capturedInput = null;
let capturedMessages = null;
const result = await Preview.startDay(world, {
  callLLM: async (messages) => {
    calls += 1;
    capturedMessages = messages;
    capturedInput = JSON.parse(messages[1].content);
    return JSON.stringify(makePreview(world));
  },
});
assert.strictEqual(result.ok, true);
assert.strictEqual(result.status, 'completed');
assert.strictEqual(result.attempts, 1);
assert.strictEqual(calls, 1);
assert.strictEqual(capturedInput.npcs[0].sourceSnapshot.personality, '谨慎而温柔');
assert.strictEqual(capturedInput.npcs[0].sourceSnapshot.notes, '图书馆的研究员');
assert.strictEqual(capturedInput.npcs[0].sourceSnapshot.name, '艾琳');
assert.strictEqual(capturedInput.npcs[0].runtime.npcId, npcId);
assert.ok(capturedMessages[0].content.includes('最终只输出严格 JSON'));
assert.ok(capturedMessages[0].content.includes('每一个 NPC 且只为每一个 NPC 返回一个对应项'));
assert.ok(capturedMessages[0].content.includes('非空短字符串 mood'));
assert.ok(capturedMessages[0].content.includes('非空短字符串 goal'));
assert.ok(capturedMessages[0].content.includes('morning、afternoon、evening'));
assert.ok(capturedMessages[0].content.includes('不能缺省、不能为 null、不能是字符串'));
assert.ok(capturedMessages[0].content.includes('worldEvents 数组 []'));
assert.ok(capturedMessages[0].content.includes('npcId":"输入中的原始 npcId"'));
assert.deepStrictEqual(plain(capturedInput.world), {
  title: '快照测试世界',
  description: '一座围绕旧图书馆展开的研究城镇。',
  locations: [{ id: 'library', name: '旧图书馆', description: '城镇中央的旧图书馆。' }],
});
assert.deepStrictEqual(plain(capturedInput.recentFacts), []);
assert.strictEqual(result.world.currentDay.previewGenerated, true);
assert.strictEqual(result.world.currentDay.previewStatus, 'completed');
assert.strictEqual(result.world.currentDay.schedules[npcId].goal, '完成今日研究');
assert.strictEqual(result.world.currentDay.events[0].title, '旧钟响起');
assert.strictEqual(result.world.npcs[npcId].mood, 'focused');
assert.strictEqual(result.world.npcs[npcId].schedule.afternoon.locationId, 'library');

world = store.saveWorld(result.world);
const idempotent = await Preview.startDay(world, {
  callLLM: async () => { throw new Error('same-day preview must not call the model'); },
});
assert.strictEqual(idempotent.ok, true);
assert.strictEqual(idempotent.changed, false);
assert.strictEqual(idempotent.idempotent, true);
assert.strictEqual(calls, 1);

store.openWorld(world.id);
({ world: World, clock: Clock, settlement: Settlement, preview: Preview, store } = loadModules(localStorage, [], []));
const reloaded = store.getCurrentWorld();
assert.strictEqual(World.getNpcSourceSnapshot(reloaded, sourceRef).personality, '谨慎而温柔');
const reloadedPreview = await Preview.startDay(reloaded, {
  callLLM: async () => { throw new Error('reloaded same-day preview must not call the model'); },
});
assert.strictEqual(reloadedPreview.changed, false);

let day2World = reloaded;
for (const action of ['study', 'explore', 'train']) {
  const transition = Clock.applyAction(day2World, action);
  assert.strictEqual(transition.ok, true);
  const completed = transition.requiresSettlement ? Settlement.settle(transition.world) : transition;
  assert.strictEqual(completed.ok, true);
  day2World = store.saveWorld(completed.world);
}
assert.strictEqual(day2World.clock.day, 2);
assert.strictEqual(day2World.clock.period, 'morning');
assert.strictEqual(Preview.isCurrentDayValid(day2World), false);
let day2Calls = 0;
let day2Input = null;
const day2Result = await Preview.startDay(day2World, {
  callLLM: async (messages) => {
    day2Calls += 1;
    day2Input = JSON.parse(messages[1].content);
    return JSON.stringify(makePreview(day2World));
  },
});
assert.strictEqual(day2Calls, 1);
assert.strictEqual(day2Input.recentFacts[0].type, 'world_event');
assert.strictEqual(day2Result.world.currentDay.day, 2);
assert.strictEqual(Preview.isCurrentDayValid(day2Result.world), true);
const day2Again = await Preview.startDay(day2Result.world, {
  callLLM: async () => { throw new Error('same-day Day 2 preview must not call the model'); },
});
assert.strictEqual(day2Again.changed, false);
assert.strictEqual(day2Calls, 1);

let retryWorld = store.createWorld({ title: '重试测试世界' });
retryWorld = World.addNpc(retryWorld, { name: '重试角色', personality: '稳定' }).world;
let retryCalls = 0;
const retryResult = await Preview.startDay(retryWorld, {
  maxAttempts: 2,
  callLLM: async () => {
    retryCalls += 1;
    return retryCalls === 1 ? '{invalid' : JSON.stringify(makePreview(retryWorld));
  },
});
assert.strictEqual(retryResult.status, 'completed');
assert.strictEqual(retryResult.attempts, 2);
assert.strictEqual(retryCalls, 2);

let fallbackWorld = store.createWorld({ title: 'fallback 测试世界' });
fallbackWorld = World.addNpc(fallbackWorld, { name: '备用角色', personality: '安静' }).world;
let fallbackCalls = 0;
const fallbackResult = await Preview.startDay(fallbackWorld, {
  maxAttempts: 2,
  callLLM: async () => {
    fallbackCalls += 1;
    return '{still-invalid';
  },
});
assert.strictEqual(fallbackResult.ok, true);
assert.strictEqual(fallbackResult.status, 'fallback');
assert.strictEqual(fallbackResult.attempts, 2);
assert.strictEqual(fallbackCalls, 2);
assert.strictEqual(fallbackResult.world.currentDay.previewGenerated, true);
assert.ok(fallbackResult.world.currentDay.schedules[Object.keys(fallbackResult.world.npcs)[0]]);
assert.strictEqual(fallbackResult.world.npcs[Object.keys(fallbackResult.world.npcs)[0]].mood, 'neutral');
const fallbackNpc = fallbackResult.world.npcs[Object.keys(fallbackResult.world.npcs)[0]];
assert.ok(['morning', 'afternoon', 'evening'].every((period) => fallbackNpc.schedule[period].activity));
assert.strictEqual(Preview.isCurrentDayValid(fallbackResult.world), true);

let incompleteWorld = store.createWorld({ title: '不完整预演测试世界' });
incompleteWorld.locations = [{ id: 'library', name: '图书馆' }];
incompleteWorld = World.addNpc(incompleteWorld, { name: '缺失日程角色', personality: '稳定' }).world;
const incomplete = await Preview.startDay(incompleteWorld, {
  maxAttempts: 1,
  callLLM: async () => JSON.stringify({
    npcs: [{
      npcId: Object.keys(incompleteWorld.npcs)[0],
      mood: '平静',
      goal: '观察情况',
      schedule: { morning: {}, afternoon: {}, evening: {} },
    }],
    worldEvents: [],
  }),
});
assert.strictEqual(incomplete.status, 'completed');
assert.strictEqual(incomplete.world.currentDay.previewError, '');
assert.strictEqual(incomplete.world.currentDay.schedules[Object.keys(incomplete.world.npcs)[0]].schedule.morning.location, undefined);
assert.strictEqual(incomplete.world.currentDay.schedules[Object.keys(incomplete.world.npcs)[0]].schedule.morning.activity, undefined);
assert.strictEqual(Preview.isCurrentDayValid(incomplete.world), true);

let sparseWorld = store.createWorld({ title: '稀疏预演测试世界' });
sparseWorld.locations = [{ id: 'library', name: '图书馆' }];
sparseWorld = World.addNpc(sparseWorld, { name: '稀疏日程角色', personality: '稳定' }).world;
const sparse = await Preview.startDay(sparseWorld, {
  maxAttempts: 1,
  callLLM: async () => JSON.stringify({
    npcs: [{
      npcId: Object.keys(sparseWorld.npcs)[0],
      mood: '平静',
      goal: '观察情况',
      schedule: {},
    }],
    worldEvents: [],
  }),
});
assert.strictEqual(sparse.status, 'completed');
assert.strictEqual(sparse.world.currentDay.previewError, '');
assert.ok(['morning', 'afternoon', 'evening'].every((period) => (
  sparse.world.currentDay.schedules[Object.keys(sparse.world.npcs)[0]].schedule[period]
)));
assert.strictEqual(Preview.isCurrentDayValid(sparse.world), true);

const legacyStorage = createStorage();
legacyStorage.setItem('narraverse:module4:state', JSON.stringify({
  version: 1,
  currentWorldId: 'legacy-task3-world',
  worlds: [{
    id: 'legacy-task3-world',
    title: '旧 Task 3 世界',
    clock: { day: 2, period: 'afternoon' },
    player: { name: '旧玩家' },
    npcs: {
      'legacy-npc': {
        id: 'legacy-npc',
        sourceRef: 'character-card:deleted-source',
        name: '旧 NPC',
        mood: 'neutral',
      },
    },
  }],
}));
const legacy = loadModules(legacyStorage, [], []);
const legacyWorld = legacy.store.getCurrentWorld();
const legacyBinding = legacy.world.getNpcSourceBinding(legacyWorld, 'character-card:deleted-source');
assert.strictEqual(legacyBinding.migrated, true);
assert.strictEqual(legacyBinding.sourceVersion, 'legacy:character-card:deleted-source');
assert.strictEqual(legacyBinding.snapshot.name, '旧 NPC');
const legacyPreview = await legacy.preview.startDay(legacyWorld, {
  callLLM: async (messages) => {
    const input = JSON.parse(messages[1].content);
    assert.strictEqual(input.npcs[0].sourceSnapshot.name, '旧 NPC');
    return JSON.stringify(makePreview(legacyWorld));
  },
});
assert.strictEqual(legacyPreview.ok, true);
assert.strictEqual(legacyPreview.world.currentDay.day, 2);

console.log('Module4 Task 4 Daily Preview test passed.');
}()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
