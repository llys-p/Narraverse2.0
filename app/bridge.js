/* =============================================================================
 * app/bridge.js — Denova 宿主协议 v2
 * -----------------------------------------------------------------------------
 * Denova 是唯一顶层宿主；叙界在 localhost 跨源 iframe 中运行，仅交换宿主级事件：
 * ready / switch-mode / theme-changed / locale-changed / visibility-changed。
 * standalone 模式仍保留旧套壳入口，但必须由用户显式配置 Denova 地址。
 * ========================================================================== */

const NARRAVERSE_BRIDGE_VERSION = 2;
const denovaModelRequests = new Map();

function isEmbeddedInDenova() {
  return window.parent !== window &&
    new URLSearchParams(window.location.search).get('embedded') === 'denova';
}

function getDenovaHostOrigin() {
  if (!isEmbeddedInDenova()) return '';
  const configured = new URLSearchParams(window.location.search).get('host_origin') || '';
  try {
    const parsed = new URL(configured);
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port === window.location.port
      ? parsed.origin : '';
  } catch (_) {
    return '';
  }
}

function postNarraverseHostMessage(type, payload) {
  if (!isEmbeddedInDenova()) return false;
  const hostOrigin = getDenovaHostOrigin();
  if (!hostOrigin) return false;
  window.parent.postMessage({
    source: 'narraverse',
    version: NARRAVERSE_BRIDGE_VERSION,
    type: type,
    payload: payload || {}
  }, hostOrigin);
  return true;
}

function requestDenovaMode(mode) {
  if (mode !== 'ide' && mode !== 'interactive') return;
  postNarraverseHostMessage('switch-mode', { mode: mode });
}

function applyDenovaTheme(theme) {
  if (theme === 'light') setTheme('neutral');
  else if (theme === 'dark') setTheme('dark');
}

function applyDenovaLocale(locale) {
  const normalized = locale === 'en-US' ? 'en-US' : 'zh-CN';
  document.documentElement.lang = normalized;
  document.documentElement.dataset.locale = normalized;
}

function handleDenovaHostMessage(event) {
  if (!isEmbeddedInDenova()) return;
  if (event.source !== window.parent || event.origin !== getDenovaHostOrigin()) return;
  const message = event.data;
  if (!message || message.source !== 'denova' || (message.version !== 1 && message.version !== NARRAVERSE_BRIDGE_VERSION)) return;
  if (message.type === 'theme-changed') {
    applyDenovaTheme(message.payload && message.payload.theme);
  } else if (message.type === 'locale-changed') {
    applyDenovaLocale(message.payload && message.payload.locale);
  } else if (message.type === 'module4-open') {
    if (typeof Module4 !== 'undefined' && Module4) {
      if (message.payload && message.payload.open) Module4.open();
      else Module4.close();
    }
  } else if (message.type === 'visibility-changed' && message.payload && message.payload.visible) {
    if (typeof pullCurrentAdventureSync === 'function') pullCurrentAdventureSync();
  } else if (message.version === 2 && message.type === 'world-context-changed') {
    var contextPayload = message.payload && typeof message.payload === 'object' ? message.payload : { state: 'none' };
    window.NarraverseWorldContextStatus = contextPayload;
    document.documentElement.dataset.worldContextState = String(contextPayload.state || 'none');
    window.dispatchEvent(new CustomEvent('narraverse-world-context-changed', { detail: contextPayload }));
  } else if (message.version === 2 && message.type === 'model-call-result') {
    const payload = message.payload || {};
    const pending = denovaModelRequests.get(String(payload.requestId || ''));
    if (!pending) return;
    denovaModelRequests.delete(String(payload.requestId));
    window.clearTimeout(pending.timer);
    if (payload.ok) pending.resolve(String(payload.content || ''));
    else {
      const error = new Error(String(payload.message || '共享模型请求失败'));
      error.code = String(payload.code || 'upstream_error');
      pending.reject(error);
    }
  }
}

function announceNarraverseReady() {
  postNarraverseHostMessage('ready', { capabilities: ['host-model-proxy-v2'] });
}

function randomBridgeRequestId() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode.apply(null, bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function requestDenovaModel(messages, options) {
  if (!isEmbeddedInDenova() || !getDenovaHostOrigin()) {
    return Promise.reject(new Error('Denova 宿主模型代理不可用'));
  }
  const requestId = randomBridgeRequestId();
  return new Promise(function (resolve, reject) {
    const timer = window.setTimeout(function () {
      denovaModelRequests.delete(requestId);
      reject(new Error('共享模型请求超时'));
    }, 125000);
    denovaModelRequests.set(requestId, { resolve: resolve, reject: reject, timer: timer });
    const sent = postNarraverseHostMessage('model-call-request', {
      requestId: requestId,
      messages: Array.isArray(messages) ? messages.map(function (message) {
        return { role: message.role, content: message.content };
      }) : [],
      options: {
        maxTokens: options && options.maxTokens,
        temperature: options && options.temperature
      }
    });
    if (!sent) {
      window.clearTimeout(timer);
      denovaModelRequests.delete(requestId);
      reject(new Error('Denova 宿主模型代理不可用'));
    }
  });
}

window.requestDenovaModel = requestDenovaModel;

function getStandaloneDenovaOrigin() {
  let configured = '';
  try { configured = localStorage.getItem('narraverse:denova-frontend-url') || ''; } catch (e) { /* ignore */ }
  if (!configured) return '';
  try { return new URL(configured).origin; } catch (e) { return ''; }
}

/* 兼容现有导出完成通知；首期宿主只处理模式切换，其余命令明确 no-op。 */
function postToDenova(cmd, payload) {
  if (isEmbeddedInDenova()) {
    if (cmd === 'switch-scene') requestDenovaMode(payload && payload.mode === 'game' ? 'interactive' : 'ide');
    return;
  }
  const frame = document.getElementById('denovaFrame');
  const origin = getStandaloneDenovaOrigin();
  if (!frame || !frame.contentWindow || !origin) return;
  frame.contentWindow.postMessage({ cmd: cmd, payload: payload || {} }, origin);
}

function queryDenova() {
  return Promise.reject(new Error('Denova query bridge is not available in host protocol v2'));
}

/* ---------- standalone 兼容套壳 ---------- */
function openDenovaShell(mode) {
  if (isEmbeddedInDenova()) {
    requestDenovaMode(mode === 'game' ? 'interactive' : 'ide');
    return;
  }
  const origin = getStandaloneDenovaOrigin();
  if (!origin) {
    alert('请从 Denova 的“叙界”模式进入，或先配置 Denova 前端地址。');
    return;
  }
  const shell = document.getElementById('denovaShell');
  const frame = document.getElementById('denovaFrame');
  if (!shell || !frame) return;
  const title = document.getElementById('denovaShellTitle');
  if (title) title.textContent = mode === 'game' ? 'Denova · 游戏模式' : 'Denova · 写作台';
  frame.src = origin + '/?mode=' + (mode === 'game' ? 'interactive' : 'ide');
  shell.style.display = 'flex';
}

function closeDenovaShell() {
  const shell = document.getElementById('denovaShell');
  if (shell) shell.style.display = 'none';
}

/* ---------- Profile 导入导出（命令面板入口） ---------- */
function _exportProfileFile() {
  if (typeof exportProfile !== 'function') return;
  const blob = new Blob([exportProfile()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'workbuddy-profile.json';
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}

function _importProfileFile() {
  if (typeof importProfile !== 'function') return;
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.onchange = function () {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = function () {
      if (importProfile(r.result)) alert('Profile 已导入');
      else alert('Profile 导入失败：文件格式错误');
    };
    r.readAsText(f);
  };
  inp.click();
}

/* ---------- 初始化 ---------- */
document.addEventListener('DOMContentLoaded', function () {
  window.addEventListener('message', handleDenovaHostMessage);
  if (isEmbeddedInDenova()) {
    const shell = document.getElementById('denovaShell');
    if (shell) shell.style.display = 'none';
  }
  /* 注册命令面板入口（UI_COMMANDS 是 const 数组，可 push）。
   * embedded 模式使用 Denova 顶层模式切换，不再显示旧套壳命令。 */
  if (typeof UI_COMMANDS !== 'undefined') {
    if (isEmbeddedInDenova()) {
      for (let index = UI_COMMANDS.length - 1; index >= 0; index--) {
        if (UI_COMMANDS[index].label === '打开 Denova 写作台' || UI_COMMANDS[index].label === '打开 Denova 游戏模式') {
          UI_COMMANDS.splice(index, 1);
        }
      }
    }
    UI_COMMANDS.push({ icon: '📦', label: '导出本地 Profile', fn: _exportProfileFile, groups: ['setting'] });
    UI_COMMANDS.push({ icon: '📤', label: '导入本地 Profile', fn: _importProfileFile, groups: ['setting'] });
  }
  window.setTimeout(announceNarraverseReady, 0);
});
