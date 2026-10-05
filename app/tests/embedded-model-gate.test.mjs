import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const bridgeSource = readFileSync(new URL('../bridge.js', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../ai-client.js', import.meta.url), 'utf8');

const EMBEDDED_SEARCH = '?embedded=denova&host_origin=http%3A%2F%2F127.0.0.1%3A18090';

function page(search, embedded = true) {
  const window = {
    location: { hostname: 'localhost', port: '18090', search },
    parent: embedded ? {} : null,
    addEventListener() {},
    setTimeout() {},
  };
  if (!embedded) window.parent = window;
  const context = vm.createContext({
    window,
    document: { body: { dataset: {} }, addEventListener() {} },
    URL,
    URLSearchParams,
    console,
  });
  vm.runInContext(clientSource, context, { filename: 'ai-client.js' });
  vm.runInContext(appSource, context, { filename: 'app.js' });
  vm.runInContext(bridgeSource, context, { filename: 'bridge.js' });
  return context;
}

/* Loads app.js with a counting fetch stub so any provider-direct request is observable. */
function appWithFetch({ search = EMBEDDED_SEARCH, sharedClient } = {}) {
  let directRequests = 0;
  const window = {
    location: { hostname: 'localhost', port: '18090', search },
    parent: {},
    addEventListener() {},
    setTimeout() {},
    clearTimeout() {},
    requestDenovaModel: async () => 'host-answer',
  };
  if (sharedClient) window.NarraverseSharedAI = sharedClient;
  const context = vm.createContext({
    window,
    document: { body: { dataset: {}, classList: { contains: () => false } }, addEventListener() {} },
    URL,
    URLSearchParams,
    fetch: async () => { directRequests += 1; throw new Error('供应商直连请求不应发生'); },
    console,
  });
  vm.runInContext(appSource, context, { filename: 'app.js' });
  vm.runInContext(bridgeSource, context, { filename: 'bridge.js' });
  return { context, window, directRequests: () => directRequests };
}

test('embedded host transport works without a second iframe API key', () => {
  const context = page(EMBEDDED_SEARCH);
  assert.equal(vm.runInContext('canRequestModel()', context), true);
});

test('standalone pages never report model availability', () => {
  const context = page('', false);
  assert.equal(vm.runInContext('canRequestModel()', context), false);
});

test('legacy local credentials no longer unlock model requests', () => {
  const standalone = page('', false);
  vm.runInContext("state.apiConfig.endpoint='https://example.invalid'; state.apiConfig.apiKey='test-only'", standalone);
  assert.equal(vm.runInContext('canRequestModel()', standalone), false);

  const embeddedWithoutHost = page('?embedded=denova');
  vm.runInContext("state.apiConfig.endpoint='https://example.invalid'; state.apiConfig.apiKey='test-only'", embeddedWithoutHost);
  assert.equal(vm.runInContext('canRequestModel()', embeddedWithoutHost), false);
});

test('callLLM without the shared client fails closed and never dials a provider', async () => {
  const { context, directRequests } = appWithFetch({});
  await assert.rejects(
    vm.runInContext(`callLLM([{role:'user',content:'hi'}])`, context),
    /请从平台|platform/i,
  );
  assert.equal(directRequests(), 0);
});

test('callLLM ignores leftover local credentials when the shared client is missing', async () => {
  const { context, directRequests } = appWithFetch({});
  vm.runInContext("state.apiConfig.endpoint='https://example.invalid'; state.apiConfig.apiKey='sk-local-legacy'; state.apiConfig.model='deepseek-chat'", context);
  await assert.rejects(vm.runInContext(`callLLM([{role:'user',content:'hi'}])`, context), /请从平台|platform/i);
  assert.equal(directRequests(), 0);
});

test('callLLM delegates to the host client and keeps the chunk callback contract', async () => {
  const seen = [];
  const { context, directRequests } = appWithFetch({
    sharedClient: {
      chat: async (messages, options) => { seen.push({ messages, options }); return '  来自平台的正文  '; },
    },
  });
  vm.runInContext('state.apiConfig.maxOutputTokens = 2048; state.apiConfig.temperature = 0.4;', context);
  const result = await vm.runInContext(
    `callLLM([{role:'system',content:'s'},{role:'user',content:'u'}], function(){ globalThis.__chunk = (globalThis.__chunk||0)+1; })`,
    context,
  );
  assert.equal(result, '  来自平台的正文  ');
  const chunkCalls = vm.runInContext('globalThis.__chunk || 0', context);
  assert.equal(chunkCalls, 1, '网关一次性返回完整正文，回调只触发一次');
  /* vm 里的对象来自另一份 Object 原型，只比结构不比引用身份。 */
  assert.deepEqual(JSON.parse(JSON.stringify(seen[0].messages)), [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]);
  assert.equal(seen[0].options.maxTokens, 2048);
  assert.equal(seen[0].options.temperature, 0.4);
  assert.equal(directRequests(), 0);
});

test('callLLM normalizes legacy and invalid output limits at the send boundary', async () => {
  const seen = [];
  const { context } = appWithFetch({
    sharedClient: { chat: async (_messages, options) => { seen.push(options.maxTokens); return '生成结果'; } },
  });
  vm.runInContext("applyParsedState({adventures:[],apiConfig:{maxOutputTokens:12000,imageApiKey:'image-retained',cosyvoiceApiKey:'tts-retained'}})", context);
  await vm.runInContext("callLLM([{role:'user',content:'旧档直接生成'}])", context);
  assert.equal(seen.at(-1), 8192, '旧存档值收敛到宿主允许的上限');
  assert.equal(vm.runInContext('state.apiConfig.maxOutputTokens', context), 12000, '生成不回写旧存档值');
  const saved = JSON.parse(vm.runInContext('stateToJson()', context));
  assert.equal(saved.apiConfig.maxOutputTokens, 12000, '序列化存档仍保留旧值');
  assert.equal(saved.apiConfig.imageApiKey, 'image-retained');
  assert.equal(saved.apiConfig.cosyvoiceApiKey, 'tts-retained');

  vm.runInContext("state.apiConfig = {...state.apiConfig, ...{maxOutputTokens:12000}}", context);
  await vm.runInContext("callLLM([{role:'user',content:'导入档直接生成'}])", context);
  assert.equal(seen.at(-1), 8192, '文件导入的旧值同样在公共发送边界收敛');

  for (const [value, expected] of [[2048, 2048], [1, 1], [8193, 8192], [0, 4096], [-1, 4096], [1.5, 4096], ['invalid', 4096], [undefined, 4096]]) {
    vm.runInContext(`state.apiConfig.maxOutputTokens = ${JSON.stringify(value)}`, context);
    if (value === undefined) vm.runInContext('delete state.apiConfig.maxOutputTokens', context);
    await vm.runInContext("callLLM([{role:'user',content:'验证输出限制'}])", context);
    assert.equal(seen.at(-1), expected, `maxOutputTokens=${String(value)} 应发送 ${expected}`);
  }
});

test('blank model output is a failure, not a silent success', async () => {
  const { context, directRequests } = appWithFetch({
    sharedClient: { chat: async () => '   ' },
  });
  await assert.rejects(vm.runInContext(`callLLM([{role:'user',content:'hi'}])`, context), /没有返回可用内容/);
  assert.equal(directRequests(), 0);
});

test('host rejections surface to the caller without a fallback request', async () => {
  const { context, directRequests } = appWithFetch({
    sharedClient: { chat: async () => { const error = new Error('宿主代理不可用'); error.code = 'host_unavailable'; throw error; } },
  });
  await assert.rejects(vm.runInContext(`callLLM([{role:'user',content:'hi'}])`, context), /宿主代理不可用/);
  assert.equal(directRequests(), 0);
});

test('the iframe app never contains a provider chat-completions path', () => {
  assert.doesNotMatch(appSource, /chat\/completions/);
});

test('the offline game engine no longer reads model connection settings', () => {
  const engineSource = readFileSync(new URL('../game_engine.js', import.meta.url), 'utf8');
  assert.doesNotMatch(engineSource, /apiConfig/);
});

test('host rejection never falls back to a bare model request', async () => {
  let directRequests = 0;
  const window = {
    location: { search: '?embedded=denova' },
    requestDenovaModel: async () => { const error = new Error('host unavailable'); error.code = 'host_unavailable'; throw error; },
  };
  const context = vm.createContext({
    window,
    URLSearchParams,
    fetch: () => { directRequests += 1; throw new Error('bare request'); },
    console,
  });
  vm.runInContext(clientSource, context, { filename: 'ai-client.js' });
  await assert.rejects(window.NarraverseSharedAI.chat([{ role: 'user', content: 'test' }]), /host unavailable/);
  assert.equal(directRequests, 0);
});

test('standalone shared client refuses instead of inviting local API settings', async () => {
  let directRequests = 0;
  const window = { location: { search: '' } };
  const context = vm.createContext({ window, URLSearchParams, fetch: () => { directRequests += 1; throw new Error('bare request'); }, console });
  vm.runInContext(clientSource, context, { filename: 'ai-client.js' });
  await assert.rejects(window.NarraverseSharedAI.chat([{ role: 'user', content: 'test' }]), /请从平台/);
  assert.equal(directRequests, 0);
});

test('new exports and saves carry no text-model connection fields', () => {
  const context = page(EMBEDDED_SEARCH);
  vm.runInContext(
    "state.apiConfig.endpoint='https://example.invalid'; state.apiConfig.apiKey='sk-legacy'; state.apiConfig.model='deepseek-chat';"
    + "state.apiConfig.imageApiKey='sk-image'; state.apiConfig.cosyvoiceApiKey='sk-tts';",
    context,
  );
  const serialized = JSON.parse(vm.runInContext('stateToJson()', context));
  assert.equal('endpoint' in serialized.apiConfig, false);
  assert.equal('apiKey' in serialized.apiConfig, false);
  assert.equal('model' in serialized.apiConfig, false);
  assert.equal(serialized.apiConfig.imageApiKey, 'sk-image');
  assert.equal(serialized.apiConfig.cosyvoiceApiKey, 'sk-tts');
  assert.equal(serialized.apiConfig.temperature, 0.85);
});

test('legacy archives restore story and settings without reconnecting credentials', () => {
  const context = page(EMBEDDED_SEARCH);
  vm.runInContext(
    "applyParsedState({adventures:[{id:'a1',name:'旧冒险',conversationHistory:[{role:'user',content:'正文'}]}],"
    + "currentId:'a1',apiConfig:{endpoint:'https://example.invalid',apiKey:'sk-legacy',model:'deepseek-chat',temperature:0.6,autoSaveEvery:3}})",
    context,
  );
  assert.equal(vm.runInContext("state.adventures[0].conversationHistory[0].content", context), '正文');
  assert.equal(vm.runInContext('state.apiConfig.temperature', context), 0.6);
  assert.equal(vm.runInContext('state.apiConfig.autoSaveEvery', context), 3);
  assert.equal(vm.runInContext("state.apiConfig.apiKey || ''", context), '');
  assert.equal(vm.runInContext("state.apiConfig.endpoint || ''", context), '');
});

test('the offline game engine asks the platform gate instead of local credentials', () => {
  const engineSource = readFileSync(new URL('../game_engine.js', import.meta.url), 'utf8');
  assert.doesNotMatch(engineSource, /apiConfig/);
  assert.match(engineSource, /function hasAPI\(\)[\s\S]{0,240}canRequestModel\(\)/);
});

test('the settings dialog exposes platform status instead of connection inputs', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="(apiEndpoint|apiKey|modelName|streamingToggle)"/);
  assert.match(html, /data-testid="platform-model-state"/);
  assert.match(html, /refreshPlatformModelStatus\(\)/);
  assert.match(html, /openPlatformModelSettings\(\)/);
  assert.match(html, /id="maxOutputTokens"[^>]*min="1" max="8192"/);
  assert.match(html, /缺失或无效值按 4096.*missing or invalid values use 4096/s);
});

test('the settings jump posts one fixed command to the trusted host only', () => {
  const posted = [];
  const window = {
    location: { hostname: 'localhost', port: '18090', search: EMBEDDED_SEARCH },
    parent: { postMessage: (message, origin) => { posted.push({ message, origin }); } },
    addEventListener() {},
    setTimeout() {},
  };
  const context = vm.createContext({
    window,
    document: { body: { dataset: {} }, documentElement: { dataset: {} }, addEventListener() {} },
    URL,
    URLSearchParams,
    console,
  });
  vm.runInContext(bridgeSource, context, { filename: 'bridge.js' });
  assert.equal(vm.runInContext('requestDenovaModelSettings()', context), true);
  /* postMessage 的信封在 vm 里构造，比较结构而不是原型身份。 */
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{
    message: { source: 'narraverse', version: 2, type: 'open-model-settings', payload: {} },
    origin: 'http://127.0.0.1:18090',
  }]);
});

test('the settings jump fails closed without a trusted host origin', () => {
  const context = page('?embedded=denova');
  assert.equal(vm.runInContext('requestDenovaModelSettings()', context), false);
});

/* 设置页只读状态，绝不触发付费测试；两次刷新之间迟到的回包不得改写读数。 */
/* 让 vm 里的 Promise 链走完：一次宏任务比多次微任务更稳。 */
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0) });

function statusHarness() {
  const fields = {};
  const pending = [];
  const window = {
    location: { hostname: 'localhost', port: '18090', search: EMBEDDED_SEARCH },
    parent: {},
    addEventListener() {},
    setTimeout() {},
    clearTimeout() {},
    NarraverseSharedAI: {
      refresh: (module) => new Promise((resolve) => { pending.push({ module, resolve }) }),
      test: () => { throw new Error('状态刷新不得调用模型测试'); },
    },
  };
  const context = vm.createContext({
    window,
    document: {
      body: { dataset: {}, classList: { contains: () => false } },
      documentElement: { dataset: {} },
      addEventListener() {},
      getElementById(id) {
        if (!fields[id]) fields[id] = { dataset: {}, textContent: '' };
        return fields[id];
      },
    },
    URL,
    URLSearchParams,
    console,
  });
  vm.runInContext(appSource, context, { filename: 'app.js' });
  vm.runInContext(bridgeSource, context, { filename: 'bridge.js' });
  return { context, fields, pending };
}

function readStatusText(fields) {
  return [fields.platformModelState, fields.platformModelDetail]
    .map((node) => (node ? node.textContent : ''))
    .join(' ');
}

test('a stale platform status reply cannot overwrite the newer reading', async () => {
  const { context, fields, pending } = statusHarness();
  vm.runInContext('refreshPlatformModelStatus()', context);
  vm.runInContext('refreshPlatformModelStatus()', context);
  assert.equal(pending.length, 2);
  assert.equal(pending[0].module, 'narraverse');

  pending[1].resolve({ configured: true, model: 'newer-model', base_url: 'https://newer.invalid' });
  pending[0].resolve({ configured: true, model: 'stale-model', base_url: 'https://stale.invalid' });
  await tick();

  const text = readStatusText(fields);
  assert.match(text, /newer-model/);
  assert.doesNotMatch(text, /stale-model/);
});

test('an unconfigured platform says which part is missing', async () => {
  const { context, fields, pending } = statusHarness();
  vm.runInContext('refreshPlatformModelStatus()', context);
  pending[0].resolve({ configured: false, endpoint_configured: false, credential_configured: false, model_configured: false });
  await tick();
  assert.match(readStatusText(fields), /未配置|尚未/);
  assert.match(readStatusText(fields), /密钥/);
  assert.match(readStatusText(fields), /API key/);
  assert.match(readStatusText(fields), /endpoint/);
  assert.match(readStatusText(fields), /model name/);
});
