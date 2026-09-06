/* Narraverse shared model client.
 * Embedded mode delegates credentials and transport to Denova's unified
 * gateway. Standalone mode intentionally leaves its legacy local settings
 * path in app.js for offline/static inspection.
 */
(function (root) {
  'use strict';

  var api = root.NarraverseSharedAI = root.NarraverseSharedAI || {};

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
    if (!isEmbedded()) return Promise.reject(new Error('当前为静态模式，请使用页面本地 API 设置。'));
    var opts = options || {};
    return jsonRequest('/api/model/chat', {
      method: 'POST',
      body: JSON.stringify({
        module: opts.module || 'narraverse',
        messages: Array.isArray(messages) ? messages.map(function (message) {
          return { role: message.role, content: message.content };
        }) : [],
        max_tokens: opts.maxTokens,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : undefined
      })
    }).then(function (data) {
      return String(data && data.content || '');
    });
  };
}(window));
