import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const bridgeSource = readFileSync(new URL('../bridge.js', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../ai-client.js', import.meta.url), 'utf8');

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
  vm.runInContext(appSource, context, { filename: 'app.js' });
  vm.runInContext(bridgeSource, context, { filename: 'bridge.js' });
  return context;
}

test('embedded host transport works without a second iframe API key', () => {
  const context = page('?embedded=denova&host_origin=http%3A%2F%2F127.0.0.1%3A18090');
  assert.equal(vm.runInContext('canRequestModel()', context), true);
});

test('standalone still requires its own complete API configuration', () => {
  const context = page('', false);
  assert.equal(vm.runInContext('canRequestModel()', context), false);
  vm.runInContext("state.apiConfig.endpoint='https://example.invalid'; state.apiConfig.apiKey='test-only'", context);
  assert.equal(vm.runInContext('canRequestModel()', context), true);
});

test('embedded page without a valid host cannot use local API credentials', () => {
  const context = page('?embedded=denova');
  vm.runInContext("state.apiConfig.endpoint='https://example.invalid'; state.apiConfig.apiKey='test-only'", context);
  assert.equal(vm.runInContext('canRequestModel()', context), false);
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
