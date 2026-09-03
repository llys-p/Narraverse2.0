/* Minimal Task 6 headless check: normalization, recommendations, and one action executor. */
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
    'app/module4/ui/play-view.js',
  ]) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return {
    action: context.Module4.Action,
    clock: context.Module4.Clock,
    world: context.Module4.World,
    store: context.Module4.State.Store,
    playView: context.Module4.UI.PlayView,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyDailySchedule(world, npcId) {
  const next = plain(world);
  next.currentDay = {
    day: next.clock.day,
    previewGenerated: true,
    previewStatus: 'completed',
    schedules: {
      [npcId]: {
        npcId,
        mood: 'focused',
        goal: '完成今日研究',
        schedule: {
          morning: { locationId: 'classroom', activity: '上课' },
          afternoon: { locationId: 'library', activity: '整理资料' },
          evening: { locationId: 'park', activity: '散步' },
        },
      },
    },
    events: [],
  };
  next.npcs[npcId].schedule = plain(next.currentDay.schedules[npcId].schedule);
  return next;
}

function submitFreeInput(playView, text) {
  const listeners = {};
  const input = { value: text };
  const form = {
    dataset: {},
    addEventListener(type, handler) { listeners[type] = handler; },
    querySelector(selector) { return selector === '[name="freeText"]' ? input : null; },
  };
  let result = null;
  playView.bindFreeInput(form, (next) => { result = next; });
  listeners.submit({ preventDefault() {} });
  return { result, input };
}

const { action: Action, clock: Clock, world: World, store: Store, playView: PlayView } = loadModules(createStorage());
let world = Store.createWorld({
  title: '统一行动测试世界',
  description: '用于验证推荐、自由输入和统一执行。',
  locations: [
    { id: 'classroom', name: '教室' },
    { id: 'library', name: '图书馆' },
    { id: 'park', name: '公园' },
  ],
  player: { name: '林舟', location: 'classroom' },
});
const added = World.addNpc(world, { name: '艾琳', personality: '谨慎而温柔' });
assert.strictEqual(added.ok, true);
world = applyDailySchedule(added.world, added.npc.id);
const npcId = added.npc.id;

const recommendations = Action.recommended(world);
assert.ok(recommendations.length >= 2 && recommendations.length <= 5);
recommendations.forEach((item) => {
  assert.strictEqual(item.actorId, 'player');
  assert.strictEqual(item.source, 'recommended');
  assert.ok(typeof item.id === 'string' && item.id.length > 0);
  assert.ok(typeof item.energyCost === 'number');
  assert.strictEqual(typeof item.advancesTime, 'boolean');
});

const canonicalMove = Action.normalize({
  type: 'move',
  targetLocationId: 'library',
  text: '前往图书馆',
  source: 'recommended',
});
assert.strictEqual(canonicalMove.type, 'move');
assert.strictEqual(canonicalMove.energyCost, Clock.ENERGY_COSTS.move);
assert.strictEqual(canonicalMove.advancesTime, true);

const targetedChat = Action.execute(world, {
  type: 'chat',
  targetNpcId: npcId,
  text: '和艾琳聊天',
  source: 'recommended',
});
assert.strictEqual(targetedChat.ok, true);
assert.strictEqual(targetedChat.judgment.required, false);
assert.strictEqual(targetedChat.world.clock.period, 'afternoon');
assert.strictEqual(targetedChat.world.player.energy, 100 - Clock.ENERGY_COSTS.chat);
assert.deepStrictEqual(plain(targetedChat.world.currentDay.interactedNpcIds), [npcId]);
assert.deepStrictEqual(plain(targetedChat.world.facts), []);

const targetedHelp = Action.execute(world, {
  type: 'help',
  targetNpcId: npcId,
  text: '帮助艾琳',
  source: 'recommended',
});
assert.strictEqual(targetedHelp.ok, true);
assert.strictEqual(targetedHelp.judgment.required, false);
assert.strictEqual(targetedHelp.world.clock.period, 'afternoon');
assert.strictEqual(targetedHelp.world.player.energy, 100 - Clock.ENERGY_COSTS.help);
assert.deepStrictEqual(plain(targetedHelp.world.currentDay.interactedNpcIds), [npcId]);
assert.deepStrictEqual(plain(targetedHelp.world.facts), []);

const absentSocial = plain(world);
absentSocial.currentDay.schedules[npcId].schedule.morning.locationId = 'library';
absentSocial.npcs[npcId].schedule.morning.locationId = 'library';
['chat', 'help'].forEach((type) => {
  const result = Action.execute(absentSocial, {
    type,
    targetNpcId: npcId,
    text: type === 'chat' ? '和艾琳聊天' : '帮助艾琳',
    source: 'recommended',
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.reason, 'target-not-present');
  assert.strictEqual(result.world.player.energy, absentSocial.player.energy);
  assert.strictEqual(result.world.clock.period, absentSocial.clock.period);
  assert.deepStrictEqual(plain(result.world.currentDay.interactedNpcIds), []);
  assert.deepStrictEqual(plain(result.world.facts), []);
});

const moved = Action.execute(world, canonicalMove);
assert.strictEqual(moved.ok, true);
assert.strictEqual(moved.changed, true);
assert.strictEqual(moved.world.player.location, 'library');
assert.strictEqual(moved.world.clock.period, 'afternoon');
assert.strictEqual(moved.world.player.energy, 100 - Clock.ENERGY_COSTS.move);
assert.strictEqual(moved.encounter.found, true);
assert.deepStrictEqual(plain(moved.encounter.npcIds), [npcId]);
assert.strictEqual(moved.world.actionLogs.length, 1);
assert.ok(moved.world.actionLogs[0].description.includes('图书馆'));
assert.strictEqual(moved.world.actionLogs[0].before.period, 'morning');
assert.strictEqual(moved.world.actionLogs[0].after.period, 'afternoon');

const viewed = Action.execute(moved.world, { type: 'view_status', source: 'recommended' });
assert.strictEqual(viewed.ok, true);
assert.strictEqual(viewed.changed, false);
assert.strictEqual(viewed.action.advancesTime, false);
assert.strictEqual(viewed.world.clock.period, 'afternoon');
assert.strictEqual(viewed.world.player.energy, moved.world.player.energy);
assert.strictEqual(viewed.world.actionLogs.length, moved.world.actionLogs.length);

const sought = Action.execute(moved.world, {
  type: 'seek',
  targetNpcId: '艾琳',
  text: '寻找艾琳',
  source: 'recommended',
});
assert.strictEqual(sought.ok, true);
assert.strictEqual(sought.encounter.found, true);
assert.strictEqual(sought.action.targetNpcId, npcId);
assert.strictEqual(sought.world.clock.period, 'evening');
assert.strictEqual(sought.world.player.energy, moved.world.player.energy - Clock.ENERGY_COSTS.chat);

const parsedMove = Action.normalize('去图书馆');
assert.strictEqual(parsedMove.type, 'move');
assert.strictEqual(parsedMove.targetLocationId, '图书馆');
assert.strictEqual(parsedMove.source, 'free_input');
Store.saveWorld(world);
const freeMoved = submitFreeInput(PlayView, '去图书馆');
assert.strictEqual(freeMoved.input.value, '');
assert.strictEqual(freeMoved.result.ok, true);
assert.strictEqual(freeMoved.result.action.type, 'move');
assert.strictEqual(freeMoved.result.action.source, 'free_input');
assert.strictEqual(freeMoved.result.action.targetLocationId, 'library');
assert.strictEqual(freeMoved.result.world.player.location, 'library');
assert.strictEqual(freeMoved.result.world.player.energy, 100 - Clock.ENERGY_COSTS.move);
assert.strictEqual(freeMoved.result.world.clock.period, 'afternoon');

Store.saveWorld(world);
const help = submitFreeInput(PlayView, '我帮她整理桌上的资料').result;
assert.strictEqual(help.ok, true);
assert.strictEqual(help.action.type, 'help');
assert.strictEqual(help.action.source, 'free_input');
assert.strictEqual(help.action.advancesTime, true);
assert.strictEqual(help.world.clock.period, 'afternoon');
assert.strictEqual(help.world.player.energy, 100 - Clock.ENERGY_COSTS.help);

Store.saveWorld(world);
const custom = submitFreeInput(PlayView, '我想看看窗外的雨').result;
assert.strictEqual(custom.ok, true);
assert.strictEqual(custom.changed, true);
assert.strictEqual(custom.action.type, 'custom');
assert.strictEqual(custom.action.source, 'free_input');
assert.strictEqual(custom.action.advancesTime, false);
assert.strictEqual(custom.world.clock.period, world.clock.period);
assert.ok(custom.world.actionLogs.some((log) => log.type === 'custom' && log.text === '我想看看窗外的雨'));

const invalid = Action.execute({
  ...world,
  player: { ...world.player, energy: 0 },
}, { type: 'study', source: 'recommended' });
assert.strictEqual(invalid.ok, false);
assert.strictEqual(invalid.world.clock.period, world.clock.period);
assert.strictEqual(invalid.world.player.energy, 0);

console.log('Module4 Task 6 Action pipeline test passed.');
