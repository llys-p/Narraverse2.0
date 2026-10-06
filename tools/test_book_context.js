const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'app', 'book-context.js');
const appPath = path.join(__dirname, '..', 'app', 'app.js');
function classList(el) {
  const names = () => new Set(String(el.className || '').split(/\s+/).filter(Boolean));
  return {
    add(name) { const s = names(); s.add(name); el.className = [...s].join(' '); },
    remove(name) { const s = names(); s.delete(name); el.className = [...s].join(' '); },
    contains(name) { return names().has(name); },
  };
}
function element(tag) {
  const el = { tagName: tag.toUpperCase(), children: [], style: {}, dataset: {}, listeners: {}, className: '',
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    querySelector() { return null; },
  };
  el.classList = classList(el);
  let text = '';
  Object.defineProperty(el, 'textContent', { get() { return text + this.children.map(child => child.textContent).join(''); }, set(value) { text = String(value); this.children = []; } });
  return el;
}
function find(root, id) { if (root.id === id) return root; for (const child of root.children) { const got = find(child, id); if (got) return got; } return null; }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function makeEnv() {
  const document = { readyState: 'complete', documentElement: element('html'), head: element('head'), body: element('body'),
    createElement: element, getElementById(id) { return find(this.body, id) || find(this.head, id); }, addEventListener() {} };
  const listeners = {};
  const pending = [];
  const window = { location: { search: '?embedded=denova' }, addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    requestDenovaBookLore() { const d = deferred(); pending.push(d); return d.promise; },
    requestDenovaOpenBookLore() { return true; } };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), { window, document, URLSearchParams, Date }, { filename: sourcePath });
  return { window, document, listeners, pending, change(detail) { window.NarraverseWorldContextStatus = detail; listeners['narraverse-world-context-changed'].forEach(fn => fn({ detail })); },
    panel() { return document.getElementById('narraverseBookLorePanel'); },
    launcher() { return document.getElementById('narraverseBookLoreLauncher'); } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function main() {
  const env = makeEnv();
  const base = { consumer: 'narraverse', bookBound: true, bookKey: 'opaque-A', bookName: '同名书', bookRevision: '1' };
  env.change(base);
  assert.equal(env.launcher().style.display, 'block');
  env.launcher().listeners.click[0]();
  assert.equal(env.pending.length, 1);
  env.change({ ...base, bookKey: 'opaque-B' });
  assert.equal(JSON.stringify(env.window.NarraverseBookSelection.ids()), '[]', 'bookKey 改变必须清选择');
  env.pending[0].resolve({ requestId: 'old', ok: true, bookKey: 'opaque-A', items: [{ id: 'old-item', name: '旧书条目' }] });
  await tick();
  assert.equal(env.panel().children.length, 0, '旧 bookKey 的迟到目录不得显示');
  assert.equal(env.pending.length, 2, '打开的目录面板在切书后立即重取');
  env.pending[1].resolve({ requestId: 'new', ok: true, bookKey: 'opaque-B', items: [{ id: 'b-item', name: '本书条目' }] });
  await tick();
  assert.match(env.panel().textContent, /本书条目/);
  env.document.documentElement.dataset.locale = 'en-US';
  env.listeners['narraverse-locale-changed'].forEach(fn => fn());
  assert.match(env.panel().textContent, /Select lore for the next generation/);
  assert.match(env.launcher().textContent, /Book Lore/);
  const row = env.panel().children.find(el => el.tagName === 'LABEL');
  const checkbox = row.children[0]; checkbox.checked = true; checkbox.listeners.change[0]();
  assert.deepEqual(Array.from(env.window.NarraverseBookSelection.ids()), ['b-item']);
  env.change({ ...base, bookKey: 'opaque-B', bookRevision: '2' });
  assert.equal(JSON.stringify(env.window.NarraverseBookSelection.ids()), '[]', 'revision 变化清选择');
  assert.equal(env.pending.length, 3, '同书 revision 变化刷新打开中的目录');
  env.pending[2].resolve({ requestId: 'rev2', ok: true, bookKey: 'opaque-B', items: [{ id: 'b2', name: '新版本条目' }] });
  await tick();
  assert.match(env.panel().textContent, /新版本条目/);
  env.document.body.classList.add('module4-active');
  const identityTokenBeforeModule4 = env.window.NarraverseBookSelection.token();
  const module4TokenBeforeOpen = env.window.NarraverseBookSelection.module4Token();
  env.listeners['narraverse-module4-state-changed'].forEach(fn => fn({ detail: { open: true } }));
  assert.equal(env.launcher().style.display, 'none', '模块四期间隐藏本书入口');
  assert.deepEqual(Array.from(env.window.NarraverseBookSelection.ids()), [], '模块四期间不发送选择');
  assert.equal(env.window.NarraverseBookSelection.module4Token(), module4TokenBeforeOpen + 1, '切入模块四使用独立代际失效叙界请求');
  env.document.body.classList.remove('module4-active');
  env.listeners['narraverse-module4-state-changed'].forEach(fn => fn({ detail: { open: false } }));
  env.change({ consumer: 'module4', bookBound: true, bookKey: 'opaque-B', bookName: '同名书' });
  assert.equal(env.launcher().style.display, 'none', 'consumer=module4 时不得启用本书入口');
  assert.equal(env.window.NarraverseBookSelection.token(), identityTokenBeforeModule4, 'Module4 consumer 消息不改变书籍身份代际');
  env.change({ consumer: 'narraverse', bookBound: false, bookKey: '', bookName: '' });
  assert.deepEqual(Array.from(env.window.NarraverseBookSelection.ids()), []);
  const a = { ...base, bookKey: 'opaque-A' };
  env.change(a);
  const tokenBeforeRoundTrip = env.window.NarraverseBookSelection.token();
  env.change({ ...a, bookKey: 'opaque-B' });
  env.change(a);
  const tokenAfterRoundTrip = env.window.NarraverseBookSelection.token();
  assert.notEqual(tokenAfterRoundTrip, tokenBeforeRoundTrip, 'A→B→A 的上下文 token 必须变化');
  assert.equal(env.window.NarraverseBookSelection.isCurrentToken(tokenBeforeRoundTrip), false, 'A→B→A 后拒绝旧 A 模型响应');
  assert.equal(env.window.NarraverseBookSelection.isCurrentToken(tokenAfterRoundTrip), true, '当前上下文 token 可接受');
  assert.equal(env.window.NarraverseBookSelection.isBookBoundAdventure({ bookKey: 'opaque-A' }), true, '本书冒险必须阻断旧 Denova 同步');
  assert.equal(env.window.NarraverseBookSelection.isBookBoundAdventure({ bookKey: '' }), false, '旧无归属冒险保留旧同步行为');

  const app = fs.readFileSync(appPath, 'utf8');
  assert.match(app, /function buildLorebookBlock\(adventure\)\s*\{\s*if \(isNarraverseBookBound\(\) \|\| isAdventureBoundToBook\(adventure\)\) return '';/, '本书绑定或暂时解绑时旧背景书必须停止注入');
  for (const builder of ['buildCharacterCardsBlock', 'buildActiveSceneBlock', 'buildCardSystemDirectives', 'buildPostHistoryTail']) {
    assert.match(app, new RegExp('function ' + builder + '\\([^)]*\\) \\{\\s*if \\(isNarraverseBookBound\\(\\) \\|\\| isAdventureBoundToBook\\(adventure\\)\\) return \'\';'), builder + ' 在本书模式必须抑制旧角色卡提示');
  }
  assert.match(app, /bookKey: getNarraverseBoundBookKey\(\)/, '新冒险记录所属 bookKey');
  assert.match(app, /无法在本书中继续生成/, '旧冒险点击时给出归属提示');
  assert.match(app, /adventure\.bookKey === bookKey/, '只恢复匹配当前书籍的冒险');
  assert.match(app, /selectedLoreIds:/, '模型请求带显式资料选择');
  assert.match(app, /World setting is provided by the host book lore\./, '本书模式静态题材背景改为宿主资料指引');
  assert.match(app, /async function pushAdventureSync\(adv\) \{\s*if \(!adv \|\| isAdventureBoundToBook\(adv\)/, '本书冒险不推送旧 Denova 副本');
  assert.match(app, /async function pullAdventureSync\(adv\) \{\s*if \(!adv \|\| isAdventureBoundToBook\(adv\)/, '本书冒险不拉取旧 Denova 副本');
  assert.match(app, /isCurrentNarraverseBookContextToken\(requestBookContextToken\)/, '模型响应必须通过 bookKey ABA token 验证');
  assert.doesNotMatch(app, /window\.NarraverseWorldContext\b/, 'app 不能读取未由 bridge 初始化的重复状态');
  for (const source of ['app/ai-client.js', 'app/bridge.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', source), 'utf8'), /NarraverseWorldContext\b/, source + ' 只能读取 bridge 的实际 status');
  }
  await checkBridgeProtocol();
  await checkHostToModelEndToEnd();
  await checkSameBookRevisionRefresh();
  console.log('test_book_context: all assertions passed');
}

async function checkSameBookRevisionRefresh() {
  const env = makeEnv();
  const book = { consumer: 'narraverse', bookBound: true, bookKey: 'stable-key', bookName: '书', bookRevision: 'r1' };
  env.change(book);
  env.launcher().listeners.click[0]();
  const identityToken = env.window.NarraverseBookSelection.token();
  assert.equal(env.pending.length, 1);
  env.change({ ...book, bookRevision: 'r2' });
  assert.equal(env.window.NarraverseBookSelection.token(), identityToken, '同书 revision 变化不使模型身份 token 失效');
  assert.equal(env.window.NarraverseBookSelection.isCurrentToken(identityToken), true);
  assert.equal(env.pending.length, 2, 'revision 更新会创建新的目录请求序号');
  env.pending[0].resolve({ requestId: 'old-revision', ok: true, bookKey: 'stable-key', items: [{ id: 'old', name: '旧目录项' }] });
  await tick();
  assert.doesNotMatch(env.panel().textContent, /旧目录项/, '旧 revision 目录请求不得覆盖当前目录');
  env.pending[1].resolve({ requestId: 'new-revision', ok: true, bookKey: 'stable-key', items: [{ id: 'new', name: '新目录项' }] });
  await tick();
  assert.match(env.panel().textContent, /新目录项/);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
function loadBridge() {
  const parent = { postMessage(message, origin) { sent.push({ message, origin }); } };
  const listeners = {};
  const sent = [];
  const documentListeners = {};
  const document = { body: element('body'), documentElement: element('html'), getElementById() { return null; }, addEventListener(type, fn) { (documentListeners[type] ||= []).push(fn); } };
  const window = { parent, location: { search: '?embedded=denova&host_origin=http%3A%2F%2F127.0.0.1%3A8080', port: '8080' },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, dispatchEvent() {},
    setTimeout() { return 1; }, clearTimeout() {}, };
  const crypto = { getRandomValues(bytes) { bytes.fill(7); return bytes; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'app', 'bridge.js'), 'utf8'),
    { window, document, URLSearchParams, URL, crypto, btoa: value => Buffer.from(value, 'binary').toString('base64'), CustomEvent: function () {} },
    { filename: 'app/bridge.js' });
  (documentListeners.DOMContentLoaded || []).forEach(fn => fn());
  return { window, document, parent, listeners, sent, reply(message) { listeners.message.forEach(fn => fn({ source: parent, origin: 'http://127.0.0.1:8080', data: message })); } };
}
function loadIntegratedRuntime() {
  const parent = {};
  const sent = [];
  parent.postMessage = (message, origin) => sent.push({ message, origin });
  const listeners = {};
  const documentListeners = {};
  const document = {
    readyState: 'complete', body: element('body'), head: element('head'), documentElement: element('html'),
    createElement: element,
    getElementById(id) { return find(this.body, id) || find(this.head, id); },
    addEventListener(type, fn) { (documentListeners[type] ||= []).push(fn); },
  };
  const window = {
    parent, location: { search: '?embedded=denova&host_origin=http%3A%2F%2F127.0.0.1%3A8080', port: '8080' },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(event) { (listeners[event.type] || []).forEach(fn => fn(event)); },
    setTimeout() { return 1; }, clearTimeout() {},
  };
  const context = vm.createContext({ window, document, URLSearchParams, URL,
    crypto: { getRandomValues(bytes) { bytes.fill(9); return bytes; } },
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    console, setTimeout, clearTimeout,
  });
  for (const filename of ['bridge.js', 'book-context.js', 'ai-client.js']) {
    const file = path.join(__dirname, '..', 'app', filename);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: 'app/' + filename });
  }
  (documentListeners.DOMContentLoaded || []).forEach(fn => fn());
  return { context, window, document, parent, sent, listeners,
    reply(message) { (listeners.message || []).forEach(fn => fn({ source: parent, origin: 'http://127.0.0.1:8080', data: message })); } };
}
async function checkHostToModelEndToEnd() {
  const env = loadIntegratedRuntime();
  env.reply({ source: 'denova', version: 2, type: 'world-context-changed', payload: {
    consumer: 'narraverse', state: 'ready', bookBound: true, bookKey: 'real-status-key', bookName: '实际宿主书', bookRevision: 'rev-1', overviewPresent: true
  } });
  assert.equal(env.window.NarraverseWorldContext, undefined, '测试不得人工制造重复的 context 状态');
  const app = fs.readFileSync(appPath, 'utf8');
  const start = app.indexOf('function isNarraverseBookBound()');
  const end = app.indexOf('function getNarraverseBookContextToken()', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(app.slice(start, end) + '\nwindow.actualAppBookKey = getNarraverseBoundBookKey();', env.context, { filename: 'app/app-context-extract.js' });
  assert.equal(env.window.actualAppBookKey, 'real-status-key', 'app 必须从 bridge 实际写入的 Status 取得 bookKey');
  vm.runInContext("window.bookAdventureAllowed = isNarraverseAdventureBookCompatible({bookKey:'real-status-key'});", env.context);
  assert.equal(env.window.bookAdventureAllowed, true, 'Status 中绑定身份匹配时允许本书冒险');
  env.reply({ source: 'denova', version: 2, type: 'world-context-changed', payload: { consumer: 'narraverse', state: 'none' } });
  vm.runInContext("window.bookAdventureAllowed = isNarraverseAdventureBookCompatible({bookKey:'real-status-key'});", env.context);
  assert.equal(env.window.bookAdventureAllowed, false, '临时解绑期间禁止本书冒险走旧背景生成');
  assert.equal(env.window.NarraverseWorldContext, undefined);

  env.reply({ source: 'denova', version: 2, type: 'world-context-changed', payload: {
    consumer: 'narraverse', state: 'ready', bookBound: true, bookKey: 'real-status-key', bookName: '实际宿主书', bookRevision: 'rev-1', overviewPresent: true
  } });
  env.document.getElementById('narraverseBookLoreLauncher').listeners.click[0]();
  const catalogRequest = env.sent.find(entry => entry.message.type === 'book-lore-request').message;
  env.reply({ source: 'denova', version: 2, type: 'book-lore-result', payload: {
    requestId: catalogRequest.payload.requestId, ok: true, bookKey: 'real-status-key', items: [{ id: 'tower', name: 'Tower', load_mode: 'auto', enabled: true }]
  } });
  await tick();
  const panel = env.document.getElementById('narraverseBookLorePanel');
  assert.match(panel.children.map(child => child.textContent || '').join(' '), /自动条目按名称\/关键词触发/, '面板说明自动条目按名称与关键词触发');
  assert.match(panel.children.map(child => (child.children || []).map(grandchild => grandchild.textContent || '').join(' ')).join(' '), /Tower · 自动/, '面板标记自动资料类型');
  const row = panel.children.find(child => child.tagName === 'LABEL');
  const checkbox = row.children[0]; checkbox.checked = true; checkbox.listeners.change[0]();
  assert.deepEqual(Array.from(env.window.NarraverseBookSelection.ids()), ['tower']);
  const appStart = app.indexOf('function resolvePromptMacros(text, adventure)');
  const macroEnd = app.indexOf('/* ==================== 扩展生态', appStart);
  const llmStart = app.indexOf('const PLATFORM_MODEL_REQUIRED', macroEnd);
  const llmEnd = app.indexOf('/* ==================== 响应解析', llmStart);
  assert.ok(appStart >= 0 && macroEnd > appStart && llmStart > macroEnd && llmEnd > llmStart);
  vm.runInContext(app.slice(appStart, macroEnd) + '\n' + app.slice(llmStart, llmEnd) + '\n' +
    "var state = {apiConfig:{loreScanDepth:99,maxOutputTokens:100,temperature:0.4}}; " +
    "function getCurrentAdventure(){return window.integrationAdventure;}", env.context, { filename: 'app/call-llm-extract.js' });
  env.window.integrationAdventure = { bookKey: 'real-status-key', theme: '奇幻', character: { name: '阿青', location: '{{theme}}城' } };
  env.window.NarraverseSharedAI.chat = env.window.NarraverseSharedAI.chat.bind(env.window.NarraverseSharedAI);
  vm.runInContext('callLLM([{role:"user",content:"去灯塔"}]);', env.context);
  const modelRequest = env.sent.find(entry => entry.message.type === 'model-call-request').message;
  assert.deepEqual(Array.from(modelRequest.payload.selectedLoreIds), ['tower'], '真实 bridge 状态下勾选项必须出现在模型请求顶层');
  assert.equal(modelRequest.payload.loreActivation.scanDepth, 60, '关键词扫描深度按上限收敛');
  assert.equal(modelRequest.payload.loreActivation.contextText, '阿青\n奇幻城', '有限关键词上下文使用当前角色与宏替换后的场景值');
  assert.equal(Object.prototype.hasOwnProperty.call(modelRequest.payload.options, 'loreActivation'), false);

  env.window.integrationAdventure = null;
  vm.runInContext('state.apiConfig.loreScanDepth = undefined; callLLM([{role:"user",content:"最近的对话即可"}]);', env.context);
  const contextFreeRequest = env.sent.filter(entry => entry.message.type === 'model-call-request')[1].message;
  assert.equal(contextFreeRequest.payload.loreActivation.scanDepth, 14, '无配置时默认扫描深度为14');
  assert.equal(contextFreeRequest.payload.loreActivation.contextText, '', '无匹配本书冒险时不附带角色场景上下文');

  env.reply({ source: 'denova', version: 2, type: 'world-context-changed', payload: { consumer: 'module4', state: 'ready' } });
  env.window.NarraverseSharedAI.chat([], { selectedLoreIds: ['tower'] });
  const modelRequests = env.sent.filter(entry => entry.message.type === 'model-call-request');
  assert.equal(Object.prototype.hasOwnProperty.call(modelRequests[2].message.payload, 'selectedLoreIds'), false, '真实 module4 状态不发 selectedLoreIds');
  assert.equal(Object.prototype.hasOwnProperty.call(modelRequests[2].message.payload, 'loreActivation'), false, '真实 module4 状态不发 loreActivation');
}
async function checkBridgeProtocol() {
  const env = loadBridge();
  const catalogPromise = env.window.requestDenovaBookLore();
  const request = env.sent[0].message;
  assert.equal(request.type, 'book-lore-request');
  assert.ok(request.payload.requestId);
  env.reply({ source: 'denova', version: 2, type: 'book-lore-result', payload: { requestId: request.payload.requestId, ok: true, bookKey: 'opaque', items: [] } });
  assert.equal((await catalogPromise).bookKey, 'opaque');
  env.window.NarraverseWorldContextStatus = { consumer: 'narraverse', bookBound: true, bookKey: 'opaque' };
  const call = env.window.requestDenovaModel([], { selectedLoreIds: ['lore-a'] });
  assert.deepEqual(Array.from(env.sent[1].message.payload.selectedLoreIds), ['lore-a']);
  env.document.body.classList.add('module4-active');
  env.window.requestDenovaModel([], { selectedLoreIds: ['lore-b'] });
  assert.equal(Object.prototype.hasOwnProperty.call(env.sent[2].message.payload, 'selectedLoreIds'), false, 'Module4 请求不得携带 selectedLoreIds');
  void call;
}
