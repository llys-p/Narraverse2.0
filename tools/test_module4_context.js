/* Module 4 V1.5 S3 context boundary: player/NPC/Preview views must not share hidden facts accidentally. */
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
    'app/module4/state/migrations.js',
    'app/module4/state/store.js',
  ]) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return {
    Context: context.Module4.AI.Context,
    Facts: context.Module4.Facts,
    Prompts: context.Module4.AI.Prompts,
    Store: context.Module4.State.Store,
    World: context.Module4.World,
  };
}

const { Context, Facts, Prompts, Store, World } = loadModules();
let world = Store.createWorld({
  rulesVersion: 'v1.5',
  title: '认知隔离测试世界',
  description: '只用于验证上下文过滤。',
  locations: [{ id: 'library', name: '图书馆' }, { id: 'bar', name: '酒吧' }],
  player: { name: '林舟', location: 'library' },
});
const addedErin = World.addNpc(world, {
  name: '林雨',
  personality: '谨慎',
  creator_notes: 'SECRET-CREATOR-NOTE-9F3A',
});
const erin = addedErin.npc;
world = addedErin.world;
world = World.addNpc(world, { name: '周衡', personality: '务实' }).world;
const zhou = Object.values(world.npcs).find((npc) => npc.name === '周衡');
world.currentDay = {
  day: 1,
  previewGenerated: true,
  previewStatus: 'completed',
  schedules: {
    [erin.id]: { npcId: erin.id, schedule: { morning: { locationId: 'library' }, afternoon: {}, evening: {} } },
    [zhou.id]: { npcId: zhou.id, schedule: { morning: { locationId: 'bar' }, afternoon: {}, evening: {} } },
  },
  events: [],
  interactedNpcIds: [],
};
world.npcs[erin.id].schedule = world.currentDay.schedules[erin.id].schedule;
world.npcs[zhou.id].schedule = world.currentDay.schedules[zhou.id].schedule;

const secret = 'SECRET-FILE-LOCATION-4B7C';
const publicFact = Facts.add(world, {
  id: 'public-fact',
  type: 'world',
  summary: '图书馆今天对外开放。',
  visibility: 'public',
}).world;
publicFact.facts.push({
  id: 'secret-fact',
  type: 'world',
  summary: secret + '：文件被藏在酒吧后门。',
  visibility: 'restricted',
  knownTo: [erin.id],
  persistent: true,
});
publicFact.knowledge = {
  player: [{ id: 'rumor-1', claim: '有人听说文件去向不明。', epistemicStatus: 'heard', sourceFactId: 'secret-fact' }],
  [erin.id]: [{ id: 'observation-1', claim: '林雨亲眼见过文件被带走。', epistemicStatus: 'observation', sourceFactId: 'secret-fact' }],
};

const playerContext = Context.forPlayer(publicFact);
const zhouContext = Context.forNpc(publicFact, zhou.id);
const erinContext = Context.forNpc(publicFact, erin.id);
const playerJson = JSON.stringify(playerContext);
const zhouJson = JSON.stringify(zhouContext);
const erinJson = JSON.stringify(erinContext);
assert.strictEqual(playerJson.includes(secret), false);
assert.strictEqual(playerJson.includes('SECRET-CREATOR-NOTE-9F3A'), false);
assert.strictEqual(zhouJson.includes(secret), false);
assert.strictEqual(zhouJson.includes('SECRET-CREATOR-NOTE-9F3A'), false);
assert.ok(erinJson.includes(secret));
assert.strictEqual(erinJson.includes('SECRET-CREATOR-NOTE-9F3A'), false);
assert.ok(playerContext.knowledge.some((entry) => entry.epistemicStatus === 'heard'));
assert.strictEqual(playerContext.facts.some((fact) => fact.id === 'secret-fact'), false);
assert.strictEqual(zhouContext.facts.some((fact) => fact.id === 'secret-fact'), false);
assert.strictEqual(erinContext.facts.some((fact) => fact.id === 'secret-fact'), true);

const previewInput = JSON.parse(Prompts.buildDailyPreviewMessages(publicFact)[1].content);
assert.strictEqual(JSON.stringify(previewInput.npcs).includes('SECRET-CREATOR-NOTE-9F3A'), false);
assert.strictEqual(previewInput.npcs.length, 2);

console.log('Module4 V1.5 S3 context boundary test passed.');
