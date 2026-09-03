/* Minimal Task 3 headless check: source identity, Runtime isolation, migration, and reload. */
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
    'app/module4/state/migrations.js',
    'app/module4/state/store.js',
  ]) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return {
    world: context.Module4.World,
    store: context.Module4.State.Store,
  };
}

const cardA = {
  name: '艾琳',
  source_ref: { kind: 'character_card', source_id: 'master-erin' },
  personality: '谨慎而温柔',
  notes: '图书馆的研究员',
};
const cardB = { name: '周野', personality: '直率', notes: '喜欢修理旧物' };
const cardC = { name: '林鸦', personality: '沉默', notes: '总在观察周围' };
const originalA = JSON.stringify(cardA);
const originalB = JSON.stringify(cardB);
const adventureCards = [cardA, cardB];
const libraryCards = [cardC, cardA];
const localStorage = createStorage();
let { world: World, store } = loadModules(localStorage, adventureCards, libraryCards);

const sources = World.listSourceCharacters();
assert.strictEqual(sources.length, 3);
const refA = World.sourceRefFor(cardA);
const refB = World.sourceRefFor(cardB);
const refC = World.sourceRefFor(cardC);
assert.strictEqual(refA, 'character-card:master-erin');
assert.strictEqual(refB, World.sourceRefFor({ name: '周野', personality: '直率', notes: '喜欢修理旧物' }));
assert.strictEqual(refC, sources.find((source) => source.name === '林鸦').sourceRef);

let worldA = store.createWorld({ title: '世界 A' });
for (const sourceRef of [refA, refB, refC]) {
  const result = World.addNpcFromSource(worldA, sourceRef);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.changed, true);
  worldA = store.saveWorld(result.world);
}
const duplicate = World.addNpcFromSource(worldA, refA);
assert.strictEqual(duplicate.ok, true);
assert.strictEqual(duplicate.changed, false);
assert.strictEqual(Object.keys(worldA.npcs).length, 3);

let worldB = store.createWorld({ title: '世界 B' });
const worldBResult = World.addNpcFromSource(worldB, refA);
worldB = store.saveWorld(worldBResult.world);
assert.strictEqual(worldBResult.changed, true);
const npcA = World.listNpcs(worldA).find((npc) => npc.sourceRef === refA);
const npcB = World.listNpcs(worldB).find((npc) => npc.sourceRef === refA);
assert.ok(npcA && npcB);
assert.notStrictEqual(npcA.id, npcB.id);
assert.strictEqual(npcA.sourceRef, npcB.sourceRef);

const updatedA = World.updateNpc(worldA, npcA.id, {
  mood: 'happy',
  relation: { stage: 'friend', value: 12 },
  goals: ['完成研究'],
  temporaryState: ['刚刚见过玩家'],
  schedule: { afternoon: { locationId: 'library', activity: 'study' } },
  futureRuntimeField: 'preserve-me',
});
assert.ok(updatedA);
worldA = store.saveWorld(updatedA);
const changedNpcA = World.listNpcs(worldA).find((npc) => npc.id === npcA.id);
const unchangedNpcB = World.listNpcs(worldB).find((npc) => npc.id === npcB.id);
assert.strictEqual(changedNpcA.mood, 'happy');
assert.strictEqual(changedNpcA.relation.stage, 'friend');
assert.strictEqual(changedNpcA.schedule.afternoon.locationId, 'library');
assert.strictEqual(changedNpcA.schedule.morning.locationId, undefined);
assert.strictEqual(changedNpcA.futureRuntimeField, 'preserve-me');
assert.strictEqual(unchangedNpcB.mood, 'neutral');
assert.strictEqual(unchangedNpcB.relation.value, 0);
assert.strictEqual(JSON.stringify(unchangedNpcB.schedule), JSON.stringify({ morning: {}, afternoon: {}, evening: {} }));
assert.strictEqual(JSON.stringify(cardA), originalA);
assert.strictEqual(JSON.stringify(cardB), originalB);

store.openWorld(worldA.id);
({ world: World, store } = loadModules(localStorage, adventureCards, libraryCards));
const reloadedA = store.getCurrentWorld();
assert.strictEqual(reloadedA.npcs[npcA.id].mood, 'happy');
assert.strictEqual(reloadedA.npcs[npcA.id].relation.value, 12);
assert.strictEqual(reloadedA.npcs[npcA.id].futureRuntimeField, 'preserve-me');
assert.strictEqual(store.getWorld(worldB.id).npcs[npcB.id].mood, 'neutral');

const legacyStorage = createStorage();
legacyStorage.setItem('narraverse:module4:state', JSON.stringify({
  version: 1,
  currentWorldId: 'legacy-world',
  worlds: [{
    id: 'legacy-world',
    title: '旧 Task 1/2 世界',
    player: {
      name: '旧玩家',
      identity: '旅人',
      location: { id: 'town' },
      attributes: { courage: 3 },
      futurePlayerField: 'preserve-me',
    },
    clock: { day: 3, period: 'evening' },
    npcs: {
      'legacy-npc': {
        id: 'legacy-npc',
        sourceRef: 'character-card:legacy',
        name: '旧 NPC',
        mood: 'neutral',
        relation: { stage: 'known', value: 2, futureRelationField: 'preserve-me' },
        schedule: { morning: { futureScheduleField: 'preserve-me' } },
        futureRuntimeField: 'preserve-me',
      },
    },
    futureWorldField: 'preserve-me',
  }],
}));
const legacy = loadModules(legacyStorage, adventureCards, libraryCards);
const legacyWorld = legacy.store.getCurrentWorld();
assert.strictEqual(legacyWorld.clock.day, 3);
assert.strictEqual(legacyWorld.clock.period, 'evening');
assert.strictEqual(legacyWorld.player.location.id, 'town');
assert.strictEqual(legacyWorld.player.attributes.courage, 3);
assert.strictEqual(legacyWorld.player.futurePlayerField, 'preserve-me');
assert.strictEqual(legacyWorld.player.energy, 100);
assert.strictEqual(legacyWorld.npcs['legacy-npc'].futureRuntimeField, 'preserve-me');
assert.strictEqual(legacyWorld.npcs['legacy-npc'].relation.futureRelationField, 'preserve-me');
assert.strictEqual(legacyWorld.npcs['legacy-npc'].schedule.morning.futureScheduleField, 'preserve-me');
assert.strictEqual(JSON.stringify(legacyWorld.npcs['legacy-npc'].schedule.afternoon), '{}');
assert.strictEqual(legacyWorld.futureWorldField, 'preserve-me');
assert.strictEqual(JSON.stringify(cardA), originalA);
assert.strictEqual(JSON.stringify(cardB), originalB);

console.log('Module4 Task 3 NPC test passed.');
