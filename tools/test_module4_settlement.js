/* Module 4 Task 9 headless check: facts, deterministic settlement, next-day reset, and reload. */
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
    'app/module4/core/judgment.js',
    'app/module4/ai/prompts.js',
    'app/module4/ai/preview.js',
    'app/module4/state/migrations.js',
    'app/module4/state/store.js',
  ]) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return {
    action: context.Module4.Action,
    preview: context.Module4.AI.Preview,
    schedule: context.Module4.Schedule,
    store: context.Module4.State.Store,
    world: context.Module4.World,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function dayPreview(world) {
  return {
    npcs: Object.values(world.npcs).map((npc) => ({
      npcId: npc.id,
      mood: npc.id === Object.keys(world.npcs)[0] ? 'happy' : 'calm',
      goal: npc.name === '艾琳' ? '完成报告' : '修好收音机',
      schedule: {
        morning: { locationId: 'library', activity: npc.name === '艾琳' ? '整理资料' : '查阅手册' },
        afternoon: { locationId: 'library', activity: npc.name === '艾琳' ? '阅读资料' : '购买零件' },
        evening: { locationId: 'park', activity: npc.name === '艾琳' ? '回顾笔记' : '修理收音机' },
      },
    })),
    worldEvents: [{ title: '旧钟响起', summary: '城镇比平时更早进入夜晚。' }],
  };
}

(async function () {
  const storage = createStorage();
  let { action: Action, preview: Preview, schedule: Schedule, store: Store, world: World } = loadModules(storage);
  let world = Store.createWorld({
    title: '日结算测试世界',
    description: '用于验证 P0 的日结算闭环。',
    locations: [
      { id: 'library', name: '图书馆' },
      { id: 'park', name: '公园' },
    ],
    player: { name: '林舟', location: 'library' },
  });
  const erin = World.addNpc(world, { name: '艾琳', personality: '谨慎' });
  assert.strictEqual(erin.ok, true);
  world = erin.world;
  const zhou = World.addNpc(world, { name: '周野', personality: '直率' });
  assert.strictEqual(zhou.ok, true);
  world = plain(zhou.world);
  const erinId = erin.npc.id;
  const zhouId = zhou.npc.id;
  const rawSchedule = {
    morning: { locationId: 'library', activity: '整理资料' },
    afternoon: { locationId: 'library', activity: '阅读资料' },
    evening: { locationId: 'park', activity: '回顾笔记' },
  };
  world.currentDay = {
    day: 1,
    previewGenerated: true,
    previewStatus: 'completed',
    schedules: {
      [erinId]: { npcId: erinId, mood: 'happy', goal: '完成报告', schedule: plain(rawSchedule) },
      [zhouId]: { npcId: zhouId, mood: 'calm', goal: '修好收音机', schedule: plain(dayPreview(world).npcs.find((npc) => npc.npcId === zhouId).schedule) },
    },
    events: [{ title: '旧钟响起', summary: '城镇比平时更早进入夜晚。' }],
    interactedNpcIds: [],
  };
  world.npcs[erinId].schedule = plain(rawSchedule);
  world.npcs[zhouId].schedule = plain(world.currentDay.schedules[zhouId].schedule);
  world.npcs[erinId].relation.value = 30;
  world.npcs[erinId].mood = 'happy';
  world.npcs[erinId].goals = ['完成报告'];
  world.npcs[zhouId].temporaryState = [{ type: 'carry-over-check' }];
  world.currentDay.schedules[zhouId].schedule.morning.locationId = 'park';
  world.npcs[zhouId].schedule.morning.locationId = 'park';

  ['chat', 'help'].forEach((type) => {
    const absent = Action.execute(world, {
      type,
      targetNpcId: zhouId,
      text: type === 'chat' ? '和周野聊天' : '帮助周野',
      source: 'recommended',
    });
    assert.strictEqual(absent.ok, false);
    assert.strictEqual(absent.reason, 'target-not-present');
    assert.strictEqual(absent.world.player.energy, world.player.energy);
    assert.strictEqual(absent.world.clock.period, world.clock.period);
    assert.deepStrictEqual(plain(absent.world.currentDay.interactedNpcIds), []);
    assert.deepStrictEqual(plain(absent.world.facts), []);
  });

  const invited = Action.execute(world, '邀请艾琳下午去公园');
  assert.strictEqual(invited.ok, true);
  assert.strictEqual(invited.world.clock.period, 'afternoon');
  assert.strictEqual(invited.judgment.outcome, 'success');
  assert.strictEqual(invited.scheduleRewrite.changed, true);
  assert.strictEqual(invited.world.currentDay.schedules[erinId].schedule.afternoon.locationId, 'library');
  assert.strictEqual(Schedule.getEffectiveSlot(invited.world, erinId, 'afternoon').locationId, 'park');
  assert.deepStrictEqual(plain(invited.world.currentDay.interactedNpcIds), [erinId]);
  assert.deepStrictEqual(plain(invited.facts).map((fact) => fact.type), ['judgment', 'schedule_rewrite']);

  const toEvening = Action.execute(invited.world, { type: 'study', source: 'recommended' });
  assert.strictEqual(toEvening.ok, true);
  assert.strictEqual(toEvening.world.clock.period, 'evening');
  toEvening.world.player.temporaryState = [{ type: 'carry-over-check' }];

  const settled = Action.execute(toEvening.world, { type: 'train', source: 'recommended' });
  assert.strictEqual(settled.ok, true);
  assert.strictEqual(settled.clock.requiresSettlement, true);
  assert.strictEqual(settled.settlement.ok, true);
  assert.strictEqual(settled.world.clock.day, 2);
  assert.strictEqual(settled.world.clock.period, 'morning');
  assert.strictEqual(settled.world.player.energy, settled.world.player.maxEnergy);
  assert.strictEqual(settled.world.currentDay.day, 2);
  assert.strictEqual(settled.world.currentDay.previewGenerated, false);
  assert.deepStrictEqual(plain(settled.world.currentDay.schedules), {});
  assert.deepStrictEqual(plain(settled.world.npcs[erinId].temporaryState), []);
  assert.deepStrictEqual(plain(settled.world.npcs[zhouId].temporaryState), []);
  assert.deepStrictEqual(plain(settled.world.player.temporaryState), []);
  assert.strictEqual(settled.world.npcs[erinId].relation.value, 32);
  assert.strictEqual(settled.world.npcs[erinId].mood, 'happy');
  assert.ok(settled.world.facts.some((fact) => fact.type === 'judgment' && fact.sourceActionId === invited.action.id));
  assert.ok(settled.world.facts.some((fact) => fact.type === 'schedule_rewrite' && fact.sourceActionId === invited.action.id));
  assert.ok(settled.world.facts.some((fact) => fact.type === 'world_event' && fact.day === 1));
  assert.strictEqual(settled.world.dailyLogs.length, 1);
  assert.strictEqual(settled.world.dailyLogs[0].day, 1);
  assert.ok(settled.world.dailyLogs[0].entries.some((entry) => entry.includes('周野')));
  assert.strictEqual(settled.world.scheduleRewrites.length, 1);
  assert.strictEqual(settled.world.scheduleRewrites[0].replacementSlot.locationId, 'park');
  assert.strictEqual(Schedule.getEffectiveSlot(settled.world, erinId, 'afternoon'), null);

  Store.saveWorld(settled.world);
  Store.openWorld(settled.world.id);
  ({ action: Action, preview: Preview, schedule: Schedule, store: Store, world: World } = loadModules(storage));
  const reloaded = Store.getCurrentWorld();
  assert.strictEqual(reloaded.clock.day, 2);
  assert.strictEqual(reloaded.clock.period, 'morning');
  assert.strictEqual(reloaded.currentDay.previewGenerated, false);
  assert.strictEqual(reloaded.facts.length, 3);
  assert.strictEqual(reloaded.dailyLogs.length, 1);
  assert.strictEqual(reloaded.scheduleRewrites.length, 1);

  let previewCalls = 0;
  let previewInput = null;
  const day2Preview = await Preview.startDay(reloaded, {
    callLLM: async (messages) => {
      previewCalls += 1;
      previewInput = JSON.parse(messages[1].content);
      return JSON.stringify(dayPreview(reloaded));
    },
  });
  assert.strictEqual(day2Preview.ok, true);
  assert.strictEqual(previewCalls, 1);
  assert.strictEqual(day2Preview.world.currentDay.day, 2);
  assert.strictEqual(day2Preview.world.currentDay.previewGenerated, true);
  assert.ok(previewInput.recentFacts.some((fact) => fact.type === 'schedule_rewrite'));
  assert.strictEqual(Schedule.getEffectiveSlot(day2Preview.world, erinId, 'afternoon').locationId, 'library');
  const idempotent = await Preview.startDay(day2Preview.world, {
    callLLM: async () => { throw new Error('Day 2 preview should stay idempotent'); },
  });
  assert.strictEqual(idempotent.changed, false);
  assert.strictEqual(previewCalls, 1);

  let day3World = day2Preview.world;
  for (const action of [
    { type: 'study', source: 'recommended' },
    { type: 'study', source: 'recommended' },
    { type: 'train', source: 'recommended' },
  ]) {
    const result = Action.execute(day3World, action);
    assert.strictEqual(result.ok, true);
    day3World = result.world;
  }
  assert.strictEqual(day3World.clock.day, 3);
  assert.strictEqual(day3World.clock.period, 'morning');
  assert.ok(day3World.facts.some((fact) => fact.day === 1 && fact.type === 'schedule_rewrite'));
  assert.strictEqual(day3World.dailyLogs.length, 2);

  let day3Input = null;
  const day3Preview = await Preview.startDay(day3World, {
    callLLM: async (messages) => {
      day3Input = JSON.parse(messages[1].content);
      return JSON.stringify(dayPreview(day3World));
    },
  });
  assert.strictEqual(day3Preview.world.currentDay.day, 3);
  assert.ok(day3Input.recentFacts.some((fact) => fact.day === 1 && fact.type === 'schedule_rewrite'));

  console.log('Module4 Task 9 Facts + Day Settlement test passed.');
}()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
