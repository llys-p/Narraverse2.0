/* Narraverse shared model client.
 * Text generation always delegates credentials and transport to Denova's
 * unified gateway through the trusted host bridge. There is no standalone
 * provider-direct path any more: opening these assets on their own can only
 * read status, never generate text.
 */
(function (root) {
  'use strict';

  var api = root.NarraverseSharedAI = root.NarraverseSharedAI || {};
  var PLATFORM_REQUIRED = '请从平台（Denova）进入叙界，并在平台设置中配置模型 / Open Narraverse from Denova and configure the model in Denova settings';

  function isEmbedded() {
    return typeof window !== 'undefined' && window.location
      && new URLSearchParams(window.location.search).get('embedded') === 'denova';
  }

  function jsonRequest(path, options) {
    var requestOptions = Object.assign({
      headers: { 'Content-Type': 'application/json' }
    }, options || {});
    return fetch(path, requestOptions).then(function (response) {
      return response.text().then(function (raw) {
        var data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch (error) { data = {}; }
        if (!response.ok) {
          var message = data && data.error ? String(data.error) : '共享模型请求失败';
          var err = new Error(message);
          err.upstreamStatus = Number(data && data.upstream_status) || 0;
          err.code = data && data.code ? String(data.code) : 'upstream_error';
          throw err;
        }
        return data;
      });
    });
  }

  api.isEmbedded = isEmbedded;

  api.refresh = function (module) {
    if (!isEmbedded()) return Promise.reject(new Error('当前为静态模式，无法读取 Denova 共享模型状态。'));
    var suffix = module ? '?module=' + encodeURIComponent(module) : '';
    return jsonRequest('/api/model/status' + suffix, { method: 'GET' });
  };

  api.test = function (module) {
    if (!isEmbedded()) return Promise.resolve({ ok: false, code: 'standalone', message: '静态模式未连接 Denova 共享模型。' });
    return jsonRequest('/api/model/test?module=' + encodeURIComponent(module || 'narraverse'), {
      method: 'POST',
      body: JSON.stringify({ module: module || 'narraverse' })
    });
  };

  api.chat = function (messages, options) {
    if (!isEmbedded()) return Promise.reject(new Error(PLATFORM_REQUIRED));
    var opts = options || {};
    var normalizedMessages = Array.isArray(messages) ? messages.map(function (message) {
      return { role: message.role, content: message.content };
    }) : [];
    if (typeof root.requestDenovaModel !== 'function') {
      return Promise.reject(new Error('Denova 宿主模型代理不可用'));
    }
    var requestOptions = {
      maxTokens: opts.maxTokens,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : undefined
    };
    var status = root.NarraverseWorldContextStatus || {};
    if (status.consumer === 'narraverse' && status.bookBound === true && status.bookKey &&
        !(root.document && root.document.body && root.document.body.classList.contains('module4-active')) &&
        Array.isArray(opts.selectedLoreIds)) {
      requestOptions.selectedLoreIds = opts.selectedLoreIds.slice(0, 50);
    }
    if (status.consumer === 'narraverse' && status.bookBound === true && status.bookKey &&
        !(root.document && root.document.body && root.document.body.classList.contains('module4-active')) &&
        opts.loreActivation && typeof opts.loreActivation === 'object' && !Array.isArray(opts.loreActivation)) {
      requestOptions.loreActivation = opts.loreActivation;
    }
    return root.requestDenovaModel(normalizedMessages, requestOptions);
  };
}(window));
