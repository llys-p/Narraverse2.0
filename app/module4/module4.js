/* Module 4 V1.5 entry point. Facts, context, and deterministic day settlement are world-scoped. */
(function (root) {
  'use strict';

  var Module4 = root.Module4 = root.Module4 || {};
  Module4.version = 'v1.5-context-interaction';

  Module4.ensureDayReady = function (shell, worldOverride) {
    if (!Module4.State || !Module4.State.Store || !Module4.AI || !Module4.AI.Preview
      || typeof Module4.AI.Preview.ensureDayReady !== 'function') return;
    var world = worldOverride || Module4.State.Store.getCurrentWorld();
    if (!world || world.rulesVersion !== 'v1.5') return;
    Module4.AI.Preview.ensureDayReady(world).then(function (result) {
      if (!result || !result.ok || !result.changed) return;
      var saved = Module4.State.Store.saveWorld(result.world);
      if (saved && Module4.UI && typeof Module4.UI.render === 'function') Module4.UI.render(shell, result.message);
    }).catch(function () {
      /* Preview 自己会 fallback；这里不把请求错误写入页面或诊断。 */
    });
  };

  function setWorkspaceVisible(visible) {
    var app = document.querySelector('.app');
    var shell = document.getElementById('module4Shell');
    if (!shell) return;

    if (visible) {
      if (Module4.UI && typeof Module4.UI.mount === 'function') Module4.UI.mount(shell);
      if (Module4.UI && typeof Module4.UI.render === 'function') Module4.UI.render(shell);
      Module4.ensureDayReady(shell);
      if (app) app.setAttribute('aria-hidden', 'true');
      shell.hidden = false;
      shell.setAttribute('aria-hidden', 'false');
      document.body.classList.add('module4-active');
      return;
    }

    shell.hidden = true;
    shell.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('module4-active');
    if (app) app.setAttribute('aria-hidden', 'false');
  }

  Module4.open = function () { setWorkspaceVisible(true); };
  Module4.close = function () {
    setWorkspaceVisible(false);
    if (typeof root.postNarraverseHostMessage === 'function') root.postNarraverseHostMessage('module4-closed');
  };

  root.addEventListener('DOMContentLoaded', function () {
    if (Module4.State && Module4.State.Store) Module4.State.Store.load();
    var shell = document.getElementById('module4Shell');
    if (shell) shell.hidden = true;
  });
}(window));
