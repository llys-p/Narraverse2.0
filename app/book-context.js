(function (root) {
  'use strict';
  var MAX_IDS = 50;
  var context = { consumer: '', bookBound: false, bookKey: '', bookName: '', bookRevision: '', overviewPresent: false };
  var locale = function () { return document.documentElement.dataset.locale === 'en-US'; };
  function text(zh, en) { return locale() ? en : zh; }
  var selected = [];
  var items = null;
  var sequence = 0;
  var pending = false;
  var launcherId = 'narraverseBookLoreLauncher';
  var panelId = 'narraverseBookLorePanel';
  var contextGeneration = 0;
  var module4Generation = 0;

  function embedded() { return new URLSearchParams(root.location.search).get('embedded') === 'denova'; }
  function allowed() {
    var status = root.NarraverseWorldContextStatus || {};
    return embedded() && context.consumer === 'narraverse' && context.bookBound && !!context.bookKey &&
      status.consumer === 'narraverse' && !document.body.classList.contains('module4-active');
  }
  function sendIds() { return allowed() ? selected.slice(0, MAX_IDS) : []; }
  function ensureUI() {
    if (!embedded() || document.getElementById(launcherId)) return;
    var button = document.createElement('button');
    button.id = launcherId; button.type = 'button'; button.textContent = text('本书资料', 'Book Lore');
    button.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:9990;display:none;padding:7px 12px;border:1px solid #777;border-radius:18px;background:#222;color:#fff;cursor:pointer';
    button.addEventListener('click', togglePanel);
    document.body.appendChild(button);
    var panel = document.createElement('div');
    panel.id = panelId;
    panel.style.cssText = 'position:fixed;right:14px;bottom:54px;z-index:9991;display:none;width:min(330px,calc(100vw - 28px));max-height:60vh;overflow:auto;padding:10px;border:1px solid #777;border-radius:10px;background:#222;color:#eee;font:13px sans-serif';
    document.body.appendChild(panel);
  }
  function updateUI() {
    ensureUI();
    var button = document.getElementById(launcherId), panel = document.getElementById(panelId);
    if (!button || !panel) return;
    button.style.display = allowed() ? 'block' : 'none';
    button.textContent = (context.bookName ? text('本书资料 · ', 'Book Lore · ') + context.bookName : text('本书资料', 'Book Lore')) + (selected.length ? ' (' + selected.length + ')' : '');
    if (!allowed()) panel.style.display = 'none';
  }
  function requestCatalog() {
    if (!allowed() || pending || items) return;
    var mine = ++sequence;
    pending = true;
    var expectedKey = context.bookKey, expectedRevision = context.bookRevision;
    var panel = document.getElementById(panelId);
    if (panel) panel.textContent = text('正在读取本书资料…', 'Loading book lore…');
    if (typeof root.requestDenovaBookLore !== 'function') {
      pending = false; if (panel) panel.textContent = text('宿主资料目录接口不可用', 'Host book catalog is unavailable'); return;
    }
    root.requestDenovaBookLore().then(function (result) {
      if (mine !== sequence || !allowed() || expectedKey !== context.bookKey || expectedRevision !== context.bookRevision) return;
      pending = false;
      if (!result.ok || result.bookKey !== expectedKey) { if (panel) panel.textContent = text('读取本书资料失败', 'Could not load book lore'); return; }
      items = Array.isArray(result.items) ? result.items.filter(function (item) { return item && typeof item.id === 'string' && item.id.length <= 128 && item.enabled !== false; }) : [];
      renderItems();
    }).catch(function () {
      if (mine !== sequence) return;
      pending = false; if (panel) panel.textContent = text('读取本书资料失败', 'Could not load book lore');
    });
  }
  function renderItems() {
    var panel = document.getElementById(panelId); if (!panel) return;
    panel.textContent = '';
    var heading = document.createElement('div');
    heading.textContent = (context.bookName || text('本书', 'This book')) + text(' · 勾选本次生成要附带的资料', ' · Select lore for the next generation');
    panel.appendChild(heading);
    var activationNote = document.createElement('small');
    activationNote.textContent = text('常驻每轮使用；自动条目按名称/关键词触发；勾选条目随本轮附带', 'Resident items are used every turn; auto items trigger by name/keywords; selected items are included this turn.');
    activationNote.style.cssText = 'display:block;opacity:.78;line-height:1.4;margin:5px 0 8px';
    panel.appendChild(activationNote);
    if (!items || !items.length) { var empty = document.createElement('p'); empty.textContent = text('当前书籍暂无资料条目', 'This book has no lore items'); panel.appendChild(empty); return; }
    items.forEach(function (item) {
      var label = document.createElement('label'); label.style.cssText = 'display:flex;gap:8px;padding:7px 0';
      var input = document.createElement('input'); input.type = 'checkbox'; input.checked = selected.indexOf(item.id) >= 0;
      input.disabled = !input.checked && selected.length >= MAX_IDS;
      input.addEventListener('change', function () {
        if (input.checked && selected.indexOf(item.id) < 0) selected.push(item.id);
        else if (!input.checked) selected = selected.filter(function (id) { return id !== item.id; });
        updateUI(); renderItems();
      });
      var span = document.createElement('span');
      var mode = String(item.load_mode || '').toLowerCase();
      var modeLabel = mode === 'resident' ? text('常驻', 'Resident') : mode === 'auto' ? text('自动', 'Auto') : mode;
      span.textContent = (item.name || item.id) + (modeLabel ? ' · ' + modeLabel : '');
      label.appendChild(input); label.appendChild(span); panel.appendChild(label);
    });
    var clear = document.createElement('button'); clear.type = 'button'; clear.textContent = text('清空所选', 'Clear selection');
    clear.addEventListener('click', function () { selected = []; updateUI(); renderItems(); }); panel.appendChild(clear);
    var edit = document.createElement('button'); edit.type = 'button'; edit.textContent = text('打开资料编辑', 'Open lore editor'); edit.style.marginLeft = '8px';
    edit.addEventListener('click', function () { if (typeof root.requestDenovaOpenBookLore === 'function') root.requestDenovaOpenBookLore(); }); panel.appendChild(edit);
  }
  function togglePanel() {
    var panel = document.getElementById(panelId); if (!panel || !allowed()) return;
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    if (panel.style.display === 'block') { if (items) renderItems(); else requestCatalog(); }
  }
  root.addEventListener('narraverse-world-context-changed', function (event) {
    var payload = event && event.detail || {};
    var bookConsumer = payload.consumer === 'narraverse';
    var next = {
      consumer: String(payload.consumer || ''),
      bookBound: bookConsumer ? payload.bookBound === true : context.bookBound,
      bookKey: bookConsumer && typeof payload.bookKey === 'string' ? payload.bookKey : context.bookKey,
      bookName: bookConsumer && typeof payload.bookName === 'string' ? payload.bookName : context.bookName,
      bookRevision: bookConsumer ? (payload.bookRevision == null ? '' : String(payload.bookRevision)) : context.bookRevision,
      overviewPresent: bookConsumer ? payload.overviewPresent === true : context.overviewPresent
    };
    var identityChanged = next.bookKey !== context.bookKey;
    var boundChanged = next.bookBound !== context.bookBound;
    var revisionChanged = next.bookRevision !== context.bookRevision;
    if (identityChanged || boundChanged) contextGeneration++;
    context = next;
    if (identityChanged || boundChanged || revisionChanged) {
      sequence++; pending = false; items = null; selected = [];
    }
    updateUI();
    var panel = document.getElementById(panelId);
    if ((identityChanged || revisionChanged) && allowed() && panel && panel.style.display === 'block') requestCatalog();
  });
  root.addEventListener('narraverse-module4-state-changed', function (event) {
    if (event && event.detail && event.detail.open) module4Generation++;
    updateUI();
  });
  root.addEventListener('narraverse-locale-changed', function () {
    updateUI();
    var panel = document.getElementById(panelId);
    if (panel && panel.style.display === 'block' && items) renderItems();
  });
  root.NarraverseBookSelection = {
    ids: sendIds,
    token: function () { return context.bookBound && context.bookKey ? contextGeneration + ':' + context.bookKey : ''; },
    isCurrentToken: function (token) { return !!token && token === (context.bookBound && context.bookKey ? contextGeneration + ':' + context.bookKey : ''); },
    module4Token: function () { return module4Generation; },
    isBookBoundAdventure: function (adventure) { return !!(adventure && typeof adventure.bookKey === 'string' && adventure.bookKey); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureUI); else ensureUI();
}(window));
