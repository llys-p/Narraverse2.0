/* Module 4 V1.5 S4 interaction: filtered one-NPC request, validated response, and no-cost failure. */
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
    'app/module4/core/action.js',
    'app/module4/core/judgment.js',
    'app/module4/ai/context.js',
    'app/module4/ai/interaction.js',
    'app/module4/state/migrations.js',
    'app/module4/state/store.js',
  ]) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return {
    Context: context.Module4.AI.Context,
    Interaction: context.Module4.AI.Interaction,
    Store: context.Module4.State.Store,
    World: context.Module4.World,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const { Context, Interaction, Store, World } = loadModules();

(async function () {
let world = Store.createWorld({
  rulesVersion: 'v1.5',
  title: 'NPC 对话测试世界',
  locations: [{ id: 'library', name: '图书馆' }, { id: 'courtyard', name: '庭院' }],
  player: { name: '林舟', location: 'library' },
});
const added = World.addNpc(world, { name: '林雨', personality: '谨慎而温柔' });
world = added.world;
const npcId = added.npc.id;
world.currentDay = {
  day: 1,
  previewGenerated: true,
  previewStatus: 'completed',
  schedules: {
    [npcId]: {
      npcId,
      schedule: {
        morning: { locationId: 'library', activity: '整理资料' },
        afternoon: { locationId: 'library', activity: '阅读' },
        evening: { locationId: 'library', activity: '回顾' },
      },
    },
  },
  events: [],
  interactedNpcIds: [],
};
world.npcs[npcId].schedule = plain(world.currentDay.schedules[npcId].schedule);
world.facts.push({ id: 'public-1', summary: '图书馆今天开放。', visibility: 'public', persistent: true });
world.facts.push({ id: 'hidden-1', summary: 'HIDDEN-CONTEXT-MARKER', visibility: 'restricted', knownTo: ['another-npc'], persistent: true });

const messageInput = JSON.parse(Interaction.buildMessages(world, {
  type: 'chat',
  targetNpcId: npcId,
  text: '和林雨聊聊',
})[1].content);
const messageJson = JSON.stringify(messageInput);
assert.strictEqual(messageJson.includes('HIDDEN-CONTEXT-MARKER'), false);
assert.strictEqual(messageJson.includes('林雨'), true);

let calls = 0;
const success = await Interaction.start(world, {
  type: 'chat',
  targetNpcId: npcId,
  text: '和林雨聊聊',
}, {
  callLLM: async () => {
    calls += 1;
    return JSON.stringify({
      narrative: '林雨抬头看了你一眼，告诉你她正在整理今天的资料。',
      factIds: ['public-1', 'unknown-fact'],
      knowledge: [{ claim: '林雨正在整理资料。', epistemicStatus: 'heard', sourceFactId: 'public-1' }],
    });
  },
});
assert.strictEqual(success.ok, true);
assert.strictEqual(success.action.targetNpcId, npcId);
assert.strictEqual(success.world.clock.tick, 1);
assert.strictEqual(success.world.player.energy, 95);
assert.strictEqual(success.world.narrativeEntries.length, 1);
assert.strictEqual(success.narrativeEntry.text, '林雨抬头看了你一眼，告诉你她正在整理今天的资料。');
assert.deepStrictEqual(plain(success.narrativeEntry.factIds), ['public-1']);
assert.strictEqual(success.world.knowledge.player.length, 1);
assert.strictEqual(success.world.knowledge.player[0].epistemicStatus, 'heard');
assert.strictEqual(calls, 1);

const beforeFailure = plain(world);
const failed = await Interaction.start(world, {
  type: 'chat',
  targetNpcId: npcId,
  text: '再次聊天',
}, { callLLM: async () => { throw new Error('simulated provider failure'); } });
assert.strictEqual(failed.ok, false);
assert.strictEqual(failed.reason, 'interaction-failed');
assert.strictEqual(failed.message.includes('公共模型请求失败'), true);
assert.strictEqual(failed.message.includes('simulated provider failure'), false);
assert.deepStrictEqual(plain(failed.world.clock), beforeFailure.clock);
assert.strictEqual(failed.world.player.energy, beforeFailure.player.energy);
assert.strictEqual(failed.world.actionLogs.length, beforeFailure.actionLogs.length);
assert.strictEqual(failed.world.narrativeEntries.length, beforeFailure.narrativeEntries.length);

const invalid = await Interaction.start(world, {
  type: 'chat',
  targetNpcId: npcId,
  text: '格式测试',
}, { callLLM: async () => 'not-json' });
assert.strictEqual(invalid.ok, false);
assert.strictEqual(invalid.reason, 'interaction-failed');
assert.strictEqual(invalid.world.player.energy, beforeFailure.player.energy);

const duplicateWorld = plain(world);
let duplicateCalls = 0;
const duplicateInput = { type: 'chat', targetNpcId: npcId, text: '重复点击测试' };
const one = Interaction.start(duplicateWorld, duplicateInput, {
  callLLM: async () => {
    duplicateCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return JSON.stringify({ narrative: '林雨点了点头。', factIds: [], knowledge: [] });
  },
});
const two = Interaction.start(duplicateWorld, duplicateInput, { callLLM: async () => JSON.stringify({ narrative: '不应被调用。' }) });
assert.strictEqual(one, two);
const duplicateResult = await one;
assert.strictEqual(duplicateResult.ok, true);
assert.strictEqual(duplicateCalls, 1);

let moveMessages = null;
const moved = await Interaction.start(world, {
  type: 'move',
  targetLocationId: 'courtyard',
  text: '我推开门走进庭院',
}, {
  callLLM: async (messages) => {
    moveMessages = JSON.parse(messages[1].content);
    return JSON.stringify({
      narrative: '门轴发出一声轻响。你从安静的图书馆走进庭院，午前的风掠过石阶，潮湿的草木气息随之漫上来。',
      factIds: [],
      knowledge: [],
    });
  },
});
assert.strictEqual(moved.ok, true);
assert.strictEqual(moved.world.player.location, 'courtyard');
assert.strictEqual(moved.world.clock.tick, 1);
assert.strictEqual(moved.world.narrativeEntries.length, 1);
assert.strictEqual(moveMessages.transition.before.location.name, '图书馆');
assert.strictEqual(moveMessages.transition.after.location.name, '庭院');

const custom = await Interaction.start(world, '我靠在窗边，听一会儿雨声', {
  callLLM: async () => JSON.stringify({
    narrative: '你靠上冰凉的窗框，雨丝正沿着玻璃缓慢滑落。书页与潮气混在一起，图书馆里原本细碎的声响也渐渐沉了下去。',
    factIds: [],
    knowledge: [],
  }),
});
assert.strictEqual(custom.ok, true);
assert.strictEqual(custom.action.type, 'custom');
assert.strictEqual(custom.world.narrativeEntries.length, 1);
assert.strictEqual(custom.message.includes('我还不能确定'), false);

const beforeMoveFailure = plain(world);
const failedMove = await Interaction.start(world, {
  type: 'move',
  targetLocationId: 'courtyard',
  text: '我走进庭院',
}, { callLLM: async () => { throw new Error('simulated move provider failure'); } });
assert.strictEqual(failedMove.ok, false);
assert.strictEqual(failedMove.reason, 'interaction-failed');
assert.deepStrictEqual(plain(failedMove.world.clock), beforeMoveFailure.clock);
assert.strictEqual(failedMove.world.player.location, beforeMoveFailure.player.location);
assert.strictEqual(failedMove.world.player.energy, beforeMoveFailure.player.energy);
assert.strictEqual(failedMove.world.actionLogs.length, beforeMoveFailure.actionLogs.length);
assert.strictEqual(failedMove.world.narrativeEntries.length, beforeMoveFailure.narrativeEntries.length);

console.log('Module4 V1.5 S4 interaction test passed.');
}()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
