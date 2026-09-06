/* Module 4 V1.5 S6 events: candidates do not become facts, transitions are finite and deduplicated. */
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
    'app/module4/core/events.js',
    'app/module4/core/settlement.js',
    'app/module4/core/action.js',
    'app/module4/core/judgment.js',
    'app/module4/ai/context.js',
    'app/module4/ai/prompts.js',
    'app/module4/ai/preview.js',
    'app/module4/state/migrations.js',
    'app/module4/state/store.js',
  ]) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return {
    Action: context.Module4.Action,
    Events: context.Module4.Events,
    Preview: context.Module4.AI.Preview,
    Store: context.Module4.State.Store,
    World: context.Module4.World,
  };
}

(async function () {
  const { Action, Events, Preview, Store, World } = loadModules();
  let world = Store.createWorld({
    rulesVersion: 'v1.5',
    title: '有限事件测试世界',
    locations: [{ id: 'library', name: '图书馆' }],
    player: { name: '林舟', location: 'library' },
  });
  const erinAdded = World.addNpc(world, { name: '林雨', personality: '谨慎' });
  world = erinAdded.world;
  const zhouAdded = World.addNpc(world, { name: '周衡', personality: '务实' });
  world = zhouAdded.world;
  const erinId = erinAdded.npc.id;
  const zhouId = zhouAdded.npc.id;
  world.sceneObjects = [{
    id: 'file',
    name: '失踪文件',
    locationId: 'library',
    state: 'missing',
    holderId: 'world',
    takeable: true,
  }];

  const candidate = await Preview.startDay(world, {
    maxAttempts: 1,
    callLLM: async () => JSON.stringify({
      npcs: Object.values(world.npcs).map((npc) => ({
        npcId: npc.id,
        mood: '平静',
        goal: '维持当天安排',
        schedule: { morning: { locationId: 'library', activity: '整理资料' }, afternoon: { locationId: 'library', activity: '阅读' }, evening: { locationId: 'library', activity: '收尾' } },
      })),
      worldEvents: [{ id: 'preview-candidate', title: '文件去向不明', summary: '有人注意到文件失踪。', status: 'active' }],
    }),
  });
  assert.strictEqual(candidate.ok, true);
  assert.strictEqual(candidate.world.events.length, 1);
  assert.strictEqual(candidate.world.events[0].status, 'candidate');
  assert.strictEqual(candidate.world.facts.length, 0);

  const added = Events.add(candidate.world, {
    id: 'file-chain',
    dedupeKey: 'file-chain-v1',
    title: '文件去向不明',
    summary: '文件离开了原来的位置。',
    actors: [erinId, zhouId],
    status: 'active',
    stage: 'missing',
    transitions: [{
      id: 'file-found',
      trigger: { type: 'get_clue', objectId: 'file' },
      summary: '玩家拿到了失踪文件。',
      effects: {
        stage: 'found',
        status: 'resolved',
        objectId: 'file',
        objectPatch: { state: 'held', holderId: 'player', locationId: null },
        npcChanges: [{ npcId: erinId, mood: 'tense', relationDelta: 1 }],
        npcRelations: [{ fromNpcId: erinId, toNpcId: zhouId, delta: -1, stage: '怀疑' }],
        knowledge: [{ viewerId: 'player', claim: '你拿到了失踪文件。', epistemicStatus: 'observation' }],
      },
    }, {
      id: 'file-expired',
      trigger: { type: 'deadline', day: 1 },
      summary: '文件线索已经过期。',
      effects: { stage: 'expired', status: 'expired' },
    }],
  });
  assert.strictEqual(added.ok, true);
  world = added.world;

  const taken = Action.execute(world, { type: 'take', targetObjectId: 'file', text: '拿走失踪文件' });
  assert.strictEqual(taken.ok, true);
  assert.strictEqual(taken.world.events.find((event) => event.id === 'file-chain').status, 'resolved');
  assert.strictEqual(taken.world.events.find((event) => event.id === 'file-chain').stage, 'found');
  assert.strictEqual(taken.world.sceneObjects[0].holderId, 'player');
  assert.strictEqual(taken.world.npcs[erinId].relation.value, 1);
  assert.strictEqual(taken.world.npcRelations[erinId + '->' + zhouId].value, -1);
  assert.strictEqual(taken.world.npcs[zhouId].relation.value, 0);
  assert.strictEqual(taken.world.facts.filter((fact) => fact.type === 'world_event').length, 1);
  assert.strictEqual(taken.world.knowledge.player[0].epistemicStatus, 'observation');

  const repeated = Events.advance(taken.world, { action: { type: 'take', targetObjectId: 'file' }, timeChanged: true, clock: taken.world.clock });
  assert.strictEqual(repeated.changed, false);
  assert.strictEqual(repeated.facts.length, 0);

  let deadlineWorld = Store.createWorld({
    rulesVersion: 'v1.5',
    title: '忽略事件测试世界',
    locations: [{ id: 'library', name: '图书馆' }],
    player: { name: '林舟', location: 'library' },
  });
  deadlineWorld = Events.add(deadlineWorld, {
    id: 'deadline-chain',
    title: '无人处理的文件',
    summary: '文件线索等待处理。',
    status: 'active',
    transitions: [{ id: 'expire', trigger: { type: 'deadline', day: 1 }, summary: '文件线索失效。', effects: { stage: 'expired', status: 'expired' } }],
  }).world;
  const slept = Action.execute(deadlineWorld, '睡到明天');
  assert.strictEqual(slept.ok, true);
  assert.strictEqual(slept.world.clock.day, 2);
  assert.strictEqual(slept.world.clock.tick, 0);
  assert.strictEqual(slept.world.events[0].status, 'expired');
  assert.strictEqual(slept.world.facts.filter((fact) => fact.type === 'world_event').length, 1);

  const limited = Store.createWorld({ rulesVersion: 'v1.5', title: '活跃上限测试' });
  let limitedWorld = limited;
  for (let index = 0; index < 3; index += 1) {
    limitedWorld = Events.add(limitedWorld, { id: 'active-' + index, title: '活跃事件 ' + index, summary: '事件', status: 'active', transitions: [] }).world;
  }
  const rejected = Events.add(limitedWorld, { id: 'active-3', title: '超限事件', summary: '事件', status: 'active', transitions: [] });
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.reason, 'active-limit');

  console.log('Module4 V1.5 S6 events test passed.');
}()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
