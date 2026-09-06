/* Minimal Task 1 headless check: CRUD, namespace isolation, autosave, reload recovery. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { if (this.failWrites) throw new Error('quota'); values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
    failWrites: false,
  };
}

function loadStore(localStorage) {
  const context = { console: { error() {}, log() {} }, localStorage, crypto: null };
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
  return context.Module4.State.Store;
}

const localStorage = createStorage();
localStorage.setItem('adventureAI_state', '{"adventures":[{"id":"legacy"}]}');
let store = loadStore(localStorage);
assert.strictEqual(store.namespace, 'narraverse:module4');
assert.strictEqual(store.listWorlds().length, 0);

const first = store.createWorld({
  title: '魔法大学',
  description: '一所把日常和奇异事件放在一起的学校。',
  player: { name: '林舟', identity: '旁听生' },
});
const second = store.createWorld({ title: '海边小镇' });
const third = store.createWorld({ title: '旧城区' });
assert.strictEqual(store.listWorlds().length, 3);
assert.ok(localStorage.getItem(store.storageKey));
assert.strictEqual(JSON.parse(localStorage.getItem('adventureAI_state')).adventures[0].id, 'legacy');

store.openWorld(first.id);
assert.strictEqual(store.getCurrentWorld().title, '魔法大学');

localStorage.failWrites = true;
assert.throws(() => store.createWorld({ title: '不会保存' }), /未保存/);
assert.strictEqual(store.listWorlds().length, 3);
localStorage.failWrites = false;

store = loadStore(localStorage);
assert.strictEqual(store.getCurrentWorld().id, first.id);
assert.strictEqual(store.getWorld(first.id).player.identity, '旁听生');
assert.strictEqual(store.deleteWorld(second.id), true);
assert.strictEqual(store.listWorlds().length, 2);
assert.strictEqual(store.getWorld(third.id).title, '旧城区');

const corruptStorage = createStorage();
const corruptRaw = '{"worlds":';
corruptStorage.setItem('narraverse:module4:state', corruptRaw);
const recoveryStore = loadStore(corruptStorage);
assert.strictEqual(recoveryStore.getRecovery().available, true);
assert.strictEqual(corruptStorage.getItem(recoveryStore.storageKey), corruptRaw);
assert.strictEqual(corruptStorage.getItem(recoveryStore.recoveryKey), corruptRaw);
assert.throws(() => recoveryStore.createWorld({ title: '恢复期间不应写入' }), /正在恢复/);

const recoverySource = createStorage();
const sourceStore = loadStore(recoverySource);
const recoverableWorld = sourceStore.createWorld({ title: '可恢复世界' });
corruptStorage.setItem(recoveryStore.recoveryKey, recoverySource.getItem(sourceStore.storageKey));
assert.ok(recoveryStore.restoreRecovery());
assert.strictEqual(recoveryStore.getRecovery().available, false);
assert.strictEqual(recoveryStore.getCurrentWorld().id, recoverableWorld.id);
assert.strictEqual(corruptStorage.getItem(recoveryStore.recoveryKey), recoverySource.getItem(sourceStore.storageKey));

console.log('Module4 Task 1 store test passed.');
