/* Minimal Task 7 headless check: deterministic judgment and bounded consequences. */
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
    'app/module4/state/migrations.js',
    'app/module4/state/store.js',
  ]) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return {
    action: context.Module4.Action,
    judgment: context.Module4.Judgment,
    world: context.Module4.World,
    store: context.Module4.State.Store,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function withNpcState(world, npcId, relation, mood, availability) {
  const next = plain(world);
  next.npcs[npcId].relation.value = relation;
  next.npcs[npcId].mood = mood;
  next.npcs[npcId].goals = ['完成报告'];
  next.currentDay.schedules[npcId].schedule.morning.availability = availability;
  next.npcs[npcId].schedule.morning.availability = availability;
  return next;
}

const storage = createStorage();
let { action: Action, judgment: Judgment, world: World, store: Store } = loadModules(storage);
let world = Store.createWorld({
  title: '判定测试世界',
  locations: [
    { id: 'library', name: '图书馆' },
    { id: 'classroom', name: '教室' },
  ],
  player: { name: '林舟', location: 'library' },
});
const added = World.addNpc(world, { name: '艾琳', personality: '谨慎' });
assert.strictEqual(added.ok, true);
world = plain(added.world);
const npcId = added.npc.id;
world.currentDay = {
  day: 1,
  previewGenerated: true,
  previewStatus: 'completed',
  schedules: {
    [npcId]: {
      npcId,
      mood: 'neutral',
      goal: '完成报告',
      schedule: {
        morning: { locationId: 'library', activity: '整理资料' },
        afternoon: { locationId: 'library', activity: '整理资料' },
        evening: { locationId: 'library', activity: '整理资料' },
      },
    },
  },
  events: [],
};
world.npcs[npcId].schedule = plain(world.currentDay.schedules[npcId].schedule);

const invite = { type: 'invite', targetNpcId: npcId, text: '邀请艾琳下午去商业街', source: 'recommended' };
const positive = withNpcState(world, npcId, 30, 'happy', '可接触');
const costly = withNpcState(world, npcId, 0, 'neutral', '可接触');
const failed = withNpcState(world, npcId, -10, 'neutral', '');
const critical = withNpcState(world, npcId, -40, 'tense', '不可接触');

assert.strictEqual(Judgment.evaluate(positive, invite).outcome, 'success');
assert.strictEqual(Judgment.evaluate(costly, invite).outcome, 'costly_success');
assert.strictEqual(Judgment.evaluate(failed, invite).outcome, 'failure');
assert.strictEqual(Judgment.evaluate(critical, invite).outcome, 'critical_failure');
['invite', 'persuade', 'request_help', 'explore', 'intensive'].forEach((type) => {
  assert.strictEqual(Judgment.requires({ type }), true);
});
const attributed = plain(costly);
attributed.player.attributes = { charm: 5 };
assert.strictEqual(
  Judgment.evaluate(attributed, invite).factors.find((item) => item.key === 'attributes').delta,
  5,
);
assert.deepStrictEqual(
  plain(Judgment.evaluate(positive, invite)),
  plain(Judgment.evaluate(positive, invite)),
);

const scheduleBefore = plain(positive.currentDay.schedules[npcId].schedule);
const success = Action.execute(positive, invite);
assert.strictEqual(success.ok, true);
assert.strictEqual(success.judgment.required, true);
assert.strictEqual(success.judgment.outcome, 'success');
assert.strictEqual(success.world.npcs[npcId].relation.value, 32);
assert.strictEqual(success.world.npcs[npcId].mood, 'happy');
assert.strictEqual(success.world.npcs[npcId].temporaryState.at(-1).outcome, 'success');
assert.strictEqual(success.world.clock.period, 'afternoon');
assert.strictEqual(success.world.player.energy, 90);
assert.deepStrictEqual(plain(success.world.currentDay.schedules[npcId].schedule), scheduleBefore);
assert.deepStrictEqual(plain(success.world.npcs[npcId].schedule), scheduleBefore);

const offsite = plain(positive);
offsite.currentDay.schedules[npcId].schedule.morning.locationId = 'classroom';
offsite.npcs[npcId].schedule.morning.locationId = 'classroom';
const offsiteBefore = {
  relation: offsite.npcs[npcId].relation.value,
  mood: offsite.npcs[npcId].mood,
  temporaryState: plain(offsite.npcs[npcId].temporaryState),
  energy: offsite.player.energy,
  period: offsite.clock.period,
};
const absentInvite = Action.execute(offsite, invite);
assert.strictEqual(absentInvite.ok, false);
assert.strictEqual(absentInvite.changed, false);
assert.strictEqual(absentInvite.reason, 'target-not-present');
assert.strictEqual(absentInvite.judgment, null);
assert.strictEqual(absentInvite.world.npcs[npcId].relation.value, offsiteBefore.relation);
assert.strictEqual(absentInvite.world.npcs[npcId].mood, offsiteBefore.mood);
assert.deepStrictEqual(plain(absentInvite.world.npcs[npcId].temporaryState), offsiteBefore.temporaryState);
assert.strictEqual(absentInvite.world.player.energy, offsiteBefore.energy);
assert.strictEqual(absentInvite.world.clock.period, offsiteBefore.period);

const noTargetInputs = { invite: '邀请', persuade: '说服', request_help: '请求帮助' };
Object.keys(noTargetInputs).forEach((type) => {
  const noTarget = Action.execute(positive, noTargetInputs[type]);
  assert.strictEqual(noTarget.ok, false);
  assert.strictEqual(noTarget.changed, false);
  assert.strictEqual(noTarget.action.type, type);
  assert.strictEqual(noTarget.reason, 'target-required');
  assert.strictEqual(noTarget.judgment, null);
  assert.strictEqual(noTarget.world.npcs[npcId].relation.value, positive.npcs[npcId].relation.value);
  assert.strictEqual(noTarget.world.npcs[npcId].mood, positive.npcs[npcId].mood);
  assert.deepStrictEqual(plain(noTarget.world.npcs[npcId].temporaryState), plain(positive.npcs[npcId].temporaryState));
  assert.strictEqual(noTarget.world.player.energy, positive.player.energy);
  assert.strictEqual(noTarget.world.clock.period, positive.clock.period);
});

const failedAction = Action.execute(failed, invite);
assert.strictEqual(failedAction.ok, true);
assert.strictEqual(failedAction.judgment.outcome, 'failure');
assert.strictEqual(failedAction.world.npcs[npcId].relation.value, -11);
assert.strictEqual(failedAction.world.npcs[npcId].mood, 'tense');
assert.strictEqual(failedAction.world.clock.period, 'afternoon');

const criticalAction = Action.execute(critical, invite);
assert.strictEqual(criticalAction.ok, true);
assert.strictEqual(criticalAction.judgment.outcome, 'critical_failure');
assert.strictEqual(criticalAction.world.npcs[npcId].relation.value, -42);
assert.strictEqual(criticalAction.world.npcs[npcId].mood, 'tense');

const directMove = Action.execute(positive, { type: 'move', targetLocationId: 'library', source: 'recommended' });
assert.strictEqual(directMove.ok, true);
assert.strictEqual(directMove.judgment.required, false);

const normalChat = Action.execute(positive, { type: 'chat', targetNpcId: npcId, source: 'recommended' });
assert.strictEqual(normalChat.ok, true);
assert.strictEqual(normalChat.judgment.required, false);

const viewed = Action.execute(positive, { type: 'view_status', source: 'recommended' });
assert.strictEqual(viewed.ok, true);
assert.strictEqual(viewed.changed, false);
assert.strictEqual(viewed.judgment.required, false);
assert.strictEqual(viewed.world.clock.period, 'morning');

const riskyCustom = Action.execute(positive, '我想强行闯入禁区');
assert.strictEqual(riskyCustom.ok, true);
assert.strictEqual(riskyCustom.action.type, 'custom');
assert.strictEqual(riskyCustom.judgment.required, true);
assert.strictEqual(riskyCustom.changed, true);
assert.strictEqual(riskyCustom.action.advancesTime, true);
assert.strictEqual(riskyCustom.world.clock.period, 'afternoon');
assert.strictEqual(riskyCustom.world.player.energy, 90);
assert.strictEqual(riskyCustom.world.player.temporaryState.at(-1).type, 'judgment');

['explore', 'intensive'].forEach((type) => {
  const untargeted = Action.execute(positive, { type, text: '独自行动', source: 'recommended' });
  assert.strictEqual(untargeted.ok, true);
  assert.strictEqual(untargeted.judgment.required, true);
  assert.strictEqual(untargeted.world.clock.period, 'afternoon');
  assert.strictEqual(untargeted.world.player.temporaryState.at(-1).type, 'judgment');
});

Store.saveWorld(success.world);
({ action: Action, judgment: Judgment, world: World, store: Store } = loadModules(storage));
const reloaded = Store.getCurrentWorld();
assert.strictEqual(reloaded.npcs[npcId].relation.value, 32);
assert.strictEqual(reloaded.npcs[npcId].temporaryState.at(-1).outcome, 'success');

console.log('Module4 Task 7 Judgment test passed.');
