/* Module 4 Task 9 entry point. Facts and deterministic day settlement are world-scoped. */
(function (root) {
  'use strict';

  var Module4 = root.Module4 = root.Module4 || {};
  Module4.version = 'task9-facts-settlement';

  function setWorkspaceVisible(visible) {
    var app = document.querySelector('.app');
    var shell = document.getElementById('module4Shell');
    if (!shell) return;

    if (visible) {
      if (Module4.UI && typeof Module4.UI.mount === 'function') Module4.UI.mount(shell);
      if (Module4.UI && typeof Module4.UI.render === 'function') Module4.UI.render(shell);
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
