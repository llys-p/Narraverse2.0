/* Module 4 Task 8 headless check: traceable rewrites drive effective schedules. */
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
    encounter: context.Module4.Encounter,
    judgment: context.Module4.Judgment,
    location: context.Module4.Location,
    schedule: context.Module4.Schedule,
    store: context.Module4.State.Store,
    world: context.Module4.World,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function withDailySchedule(world, npcId) {
  const next = plain(world);
  const schedule = {
    morning: { locationId: 'library', activity: '整理资料' },
    afternoon: { locationId: 'library', activity: '阅读资料' },
    evening: { locationId: 'library', activity: '回顾笔记' },
  };
  next.currentDay = {
    day: next.clock.day,
    previewGenerated: true,
    previewStatus: 'completed',
    schedules: { [npcId]: { npcId, mood: 'happy', goal: '完成报告', schedule } },
    events: [],
  };
  next.npcs[npcId].schedule = plain(schedule);
  next.npcs[npcId].relation.value = 30;
  next.npcs[npcId].mood = 'happy';
  next.npcs[npcId].goals = ['完成报告'];
  return next;
}

const storage = createStorage();
let { action: Action, encounter: Encounter, judgment: Judgment, location: Location, schedule: Schedule, store: Store, world: World } = loadModules(storage);
let world = Store.createWorld({
  title: '日程改写测试世界',
  locations: [
    { id: 'library', name: '图书馆' },
    { id: 'park', name: '公园' },
  ],
  player: { name: '林舟', location: 'library' },
});
const added = World.addNpc(world, { name: '艾琳', personality: '谨慎' });
assert.strictEqual(added.ok, true);
world = withDailySchedule(added.world, added.npc.id);
const npcId = added.npc.id;

const missingSource = Schedule.applyRewrite(world, {
  npcId,
  day: 1,
  period: 'afternoon',
  replacementSlot: { locationId: 'park' },
});
assert.strictEqual(missingSource.ok, false);
assert.strictEqual(missingSource.reason, 'missing-source');

const success = Action.execute(world, '邀请艾琳下午去公园');
assert.strictEqual(success.ok, true);
assert.strictEqual(success.judgment.outcome, 'success');
assert.strictEqual(success.action.scheduleChange.period, 'afternoon');
assert.strictEqual(success.action.scheduleChange.locationId, 'park');
assert.strictEqual(success.scheduleRewrite.changed, true);
assert.strictEqual(success.world.scheduleRewrites.length, 1);
const rewrite = success.world.scheduleRewrites[0];
assert.strictEqual(rewrite.npcId, npcId);
assert.strictEqual(rewrite.day, 1);
assert.strictEqual(rewrite.period, 'afternoon');
assert.strictEqual(rewrite.originalSlot.locationId, 'library');
assert.strictEqual(rewrite.replacementSlot.locationId, 'park');
assert.strictEqual(rewrite.reason, '邀请艾琳下午去公园');
assert.strictEqual(rewrite.sourceActionId, success.action.id);
assert.strictEqual(rewrite.sourceOutcome, 'success');
assert.ok(rewrite.createdAt > 0);
assert.strictEqual(success.world.currentDay.schedules[npcId].schedule.afternoon.locationId, 'library');
assert.strictEqual(success.world.npcs[npcId].schedule.afternoon.locationId, 'library');
assert.strictEqual(Schedule.getOriginalSlot(success.world, npcId, 'afternoon').locationId, 'library');
assert.strictEqual(Schedule.getEffectiveSlot(success.world, npcId, 'afternoon').locationId, 'park');

const atPark = Location.movePlayer(success.world, 'park').world;
assert.strictEqual(Encounter.checkNatural(atPark).found, true);
assert.deepStrictEqual(plain(Encounter.checkNatural(atPark).npcIds), [npcId]);
assert.strictEqual(Judgment.evaluate(atPark, { type: 'invite', targetNpcId: npcId }).context.schedule.locationId, 'park');
const atLibrary = Location.movePlayer(success.world, 'library').world;
assert.strictEqual(Encounter.checkNatural(atLibrary).found, false);

const persuaded = Action.execute(world, '说服艾琳下午去公园');
assert.strictEqual(persuaded.judgment.outcome, 'success');
assert.strictEqual(persuaded.scheduleRewrite.changed, true);
assert.strictEqual(persuaded.world.scheduleRewrites[0].replacementSlot.locationId, 'park');

const failureWorld = plain(world);
failureWorld.npcs[npcId].relation.value = -10;
failureWorld.npcs[npcId].mood = 'neutral';
const failed = Action.execute(failureWorld, '邀请艾琳下午去公园');
assert.strictEqual(failed.ok, true);
assert.strictEqual(failed.judgment.outcome, 'failure');
assert.strictEqual(failed.scheduleRewrite.reason, 'outcome-not-rewriteable');
assert.strictEqual(failed.world.scheduleRewrites.length, 0);
assert.strictEqual(failed.world.currentDay.schedules[npcId].schedule.afternoon.locationId, 'library');

const costlyWorld = plain(world);
costlyWorld.npcs[npcId].relation.value = 10;
costlyWorld.npcs[npcId].mood = 'neutral';
const costly = Action.execute(costlyWorld, '邀请艾琳下午去公园');
assert.strictEqual(costly.judgment.outcome, 'costly_success');
assert.strictEqual(costly.scheduleRewrite.reason, 'outcome-not-rewriteable');
assert.strictEqual(costly.world.scheduleRewrites.length, 0);

Store.saveWorld(success.world);
const otherWorld = Store.createWorld({ title: '隔离世界', locations: [{ id: 'park', name: '公园' }] });
assert.deepStrictEqual(plain(otherWorld.scheduleRewrites), []);
Store.openWorld(success.world.id);
({ action: Action, encounter: Encounter, judgment: Judgment, location: Location, schedule: Schedule, store: Store, world: World } = loadModules(storage));
const reloaded = Store.getCurrentWorld();
assert.strictEqual(reloaded.scheduleRewrites.length, 1);
assert.strictEqual(reloaded.currentDay.schedules[npcId].schedule.afternoon.locationId, 'library');
assert.strictEqual(Schedule.getEffectiveSlot(reloaded, npcId, 'afternoon').locationId, 'park');

console.log('Module4 Task 8 Schedule Rewrite test passed.');
