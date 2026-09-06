/* Load the formal executable page and exercise the Module4 UI in a fresh jsdom origin. */
import { JSDOM, VirtualConsole } from 'jsdom';

const baseUrl = process.env.NARRAVERSE_SMOKE_URL || 'http://127.0.0.1:8080/narraverse/index.html?embedded=denova';
const readyTimeoutMs = Number.parseInt(process.env.NARRAVERSE_SMOKE_READY_TIMEOUT_MS || '10000', 10);
const consoleErrors = [];
const jsdomErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('error', (error) => consoleErrors.push(String(error).slice(0, 300)));
virtualConsole.on('jsdomError', (error) => jsdomErrors.push(String(error?.message || error).slice(0, 300)));

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, predicate, timeout = readyTimeoutMs) {
  const deadline = Date.now() + (Number.isFinite(timeout) && timeout > 0 ? timeout : 10000);
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(25);
  }
  const diagnostics = [...jsdomErrors, ...consoleErrors].slice(0, 3).join(' | ');
  throw new Error('Timed out waiting for ' + description + (diagnostics ? ' (' + diagnostics + ')' : ''));
}

function submit(window, form) {
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

const dom = await JSDOM.fromURL(baseUrl, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole,
});
const window = dom.window;
await waitFor('Module4.open', () => typeof window.Module4?.open === 'function');
const emptyRightPanel = window.document.getElementById('rightPanel');
if (emptyRightPanel && emptyRightPanel.style.display !== 'none') {
  throw new Error('Empty adventure state should hide the character status panel.');
}
let narrativeCalls = 0;
window.callLLM = async () => {
  narrativeCalls += 1;
  return JSON.stringify({
    narrative: '你沿着眼前的线索继续行动，周围的光影与声息随之发生细微变化；当这一步结束时，新的现场已经在你面前展开。',
    factIds: [],
    knowledge: [],
  });
};
window.Module4.open();
await wait(300);

const shell = window.document.getElementById('module4Shell');
if (!shell || shell.hidden) throw new Error('Module4 did not open.');

const createForm = window.document.getElementById('module4WorldCreateForm');
createForm.querySelector('[name="title"]').value = '页面验收世界';
createForm.querySelector('[name="description"]').value = '正式页面脚本 smoke test';
createForm.querySelector('[name="locations"]').value = 'classroom|教室|\nlibrary|图书馆|';
createForm.querySelector('[name="playerName"]').value = '验收玩家';
createForm.querySelector('[name="playerIdentity"]').value = '测试者';
submit(window, createForm);
await wait(150);

let world = window.Module4.State.Store.getCurrentWorld();
if (!world || world.title !== '页面验收世界') throw new Error('World creation failed.');
if (!world.currentDay || world.currentDay.previewGenerated !== true) {
  throw new Error('New V1.5 world did not prepare its first Daily Preview.');
}

const worldListItem = shell.querySelector('[data-module4-action="open-world"]');
if (!worldListItem) throw new Error('World list did not render the created world.');
worldListItem.click();
await wait(60);
world = window.Module4.State.Store.getCurrentWorld();
if (!world || world.title !== '页面验收世界') throw new Error('World list open failed.');

shell.querySelector('[data-module4-action="toggle-management"]').click();
await wait(60);
const playHtml = window.document.getElementById('module4WorldView').innerHTML;
for (const internalLabel of ['试玩检查', '今日预演', 'NPC Runtime']) {
  if (playHtml.includes(internalLabel)) throw new Error(`Management data leaked into play DOM: ${internalLabel}`);
}

let input = window.document.querySelector('[data-module4-free-input-form] [name="freeText"]');
input.value = '去图书馆';
submit(window, input.form);
await wait(60);
world = window.Module4.State.Store.getCurrentWorld();
if (world.player.location !== 'library' || world.clock.tick !== 1 || world.player.energy !== 95) {
  throw new Error('Move action failed.');
}
if (!world.narrativeEntries.length || !world.narrativeEntries.at(-1).text.includes('新的现场')) {
  throw new Error('Move narrative was not committed.');
}

input = window.document.querySelector('[data-module4-free-input-form] [name="freeText"]');
input.value = '等到晚上';
submit(window, input.form);
await wait(60);
input = window.document.querySelector('[data-module4-free-input-form] [name="freeText"]');
input.value = '睡到明天';
submit(window, input.form);
await wait(60);
world = window.Module4.State.Store.getCurrentWorld();
if (world.clock.day !== 2 || world.clock.period !== 'morning' || world.clock.tick !== 0 || world.player.energy !== 100) {
  throw new Error('Sleep/day settlement failed.');
}

window.Module4.State.Store.load();
window.Module4.UI.render(shell);
const persisted = window.Module4.State.Store.getCurrentWorld();
if (persisted.clock.day !== 2 || persisted.player.location !== 'library') {
  throw new Error('Persistence reload failed.');
}

const unexpectedConsoleErrors = consoleErrors.filter((message) => !message.includes('IndexedDB 读取失败'));
if (jsdomErrors.length || unexpectedConsoleErrors.length) {
  throw new Error(JSON.stringify({ jsdomErrors, unexpectedConsoleErrors }));
}

console.log(JSON.stringify({
  pageLoaded: true,
  module4Version: window.Module4.version,
  worldCreated: true,
  firstPreviewReady: true,
  playDomIsolated: true,
  move: true,
  narrativeCalls,
  sleep: true,
  persistedReload: true,
  expectedJsdomStorageFallback: consoleErrors.length > 0,
}));

window.close();
