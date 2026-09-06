/* Module 4 V1.5 shell: play view first, world management on demand. */
(function (root) {
  var Module4 = root.Module4 = root.Module4 || {};
  Module4.UI = Module4.UI || {};

  function setManagementOpen(shell, open) {
    var body = shell && shell.querySelector('.module4-shell__body');
    var sidebar = shell && shell.querySelector('.module4-sidebar');
    var button = shell && shell.querySelector('[data-module4-action="toggle-management"]');
    if (!body) return;
    body.classList.toggle('is-management-open', !!open);
    body.dataset.managementInitialized = 'true';
    if (sidebar) sidebar.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (button) {
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      button.textContent = open ? '关闭世界档案' : '打开世界档案';
    }
  }

  Module4.UI.mount = function (shell) {
    if (!shell || shell.dataset.mounted === 'true') return;
    shell.innerHTML = [
      '<header class="module4-shell__bar">',
      '<button class="btn btn--ghost" type="button" data-module4-action="close">← 返回叙界</button>',
      '<span class="module4-shell__title">叙事沙盒 · 场景记录</span>',
      '<span class="module4-shell__label">模块四 · 自由行动</span>',
      '<button class="btn btn--ghost module4-management-toggle" type="button" data-module4-action="toggle-management" aria-expanded="false" aria-controls="module4Management">打开世界档案</button>',
      '</header>',
      '<div id="module4RecoveryNotice" class="module4-recovery-notice" hidden></div>',
      '<div class="module4-shell__body">',
      '<aside class="module4-sidebar" id="module4Management" aria-hidden="true">',
      '<div class="module4-section-heading"><div><span class="module4-kicker">我的世界</span><h2>世界列表</h2></div><span class="module4-count" id="module4WorldCount">0</span></div>',
      '<div class="module4-world-list" id="module4WorldList"></div>',
      '<form class="module4-create-form" id="module4WorldCreateForm">',
      '<div class="module4-section-heading"><div><span class="module4-kicker">新建</span><h2>创建世界</h2></div></div>',
      '<label>世界名称<input name="title" type="text" maxlength="80" placeholder="例如：魔法大学" required></label>',
      '<label>世界说明<textarea name="description" rows="3" maxlength="1000" placeholder="这个世界有什么值得被记住？"></textarea></label>',
      '<label>地点（每行一个，可用 id|名称|说明）<textarea name="locations" rows="4" maxlength="1200" placeholder="library|图书馆|城镇中央的旧图书馆\nclassroom|教室|"></textarea></label>',
      '<label>玩家名称<input name="playerName" type="text" maxlength="40" placeholder="例如：林舟"></label>',
      '<label>玩家身份<input name="playerIdentity" type="text" maxlength="160" placeholder="例如：刚转入学院的旁听生"></label>',
      '<div class="module4-create-form__footer"><span data-module4-create-status aria-live="polite"></span><button class="btn btn-primary" type="submit">保存世界</button></div>',
      '</form>',
      '</aside>',
      '<main class="module4-main" id="module4WorldView"></main>',
      '</div>'
    ].join('');
    var form = document.getElementById('module4WorldCreateForm');
    Module4.UI.WorldCreate.bind(form, function (world) {
      Module4.UI.render(shell);
      if (typeof Module4.ensureDayReady === 'function') Module4.ensureDayReady(shell, world);
    });
    shell.addEventListener('click', function (event) {
      var action = event.target.closest('[data-module4-action]');
      if (!action) return;
      var id = action.dataset.worldId;
      if (action.dataset.module4Action === 'close') Module4.close();
      if (action.dataset.module4Action === 'toggle-management') {
        var body = shell.querySelector('.module4-shell__body');
        setManagementOpen(shell, !(body && body.classList.contains('is-management-open')));
        Module4.UI.render(shell);
      }
      if (action.dataset.module4Action === 'open-world') {
        Module4.State.Store.openWorld(id);
        Module4.UI.render(shell);
      }
      if (action.dataset.module4Action === 'delete-world') {
        var world = Module4.State.Store.getWorld(id);
        if (world && root.confirm('删除世界“' + world.title + '”？此操作只影响模块四存档。')) {
          Module4.State.Store.deleteWorld(id);
          Module4.UI.render(shell);
        }
      }
      if (action.dataset.module4Action === 'restore-recovery') {
        var restored = Module4.State.Store.restoreRecovery();
        Module4.UI.render(shell, restored ? '已从本机保留副本恢复模块四存档。' : '保留副本暂时无法恢复，原始存档仍已保留。');
      }
    });
    shell.dataset.mounted = 'true';
  };

  Module4.UI.render = function (shell, notice, renderOptions) {
    if (!shell) return;
    var store = Module4.State.Store;
    var recoveryNotice = document.getElementById('module4RecoveryNotice');
    var recovery = store.getRecovery && store.getRecovery();
    if (recoveryNotice) {
      recoveryNotice.hidden = !(recovery && recovery.available);
      recoveryNotice.innerHTML = recovery && recovery.available ? [
        '<strong>模块四存档需要恢复</strong>',
        '<span>原始存档未被覆盖，已保留本机恢复副本。恢复期间不会写入新变化。</span>',
        '<button class="btn btn-secondary" type="button" data-module4-action="restore-recovery">尝试恢复保留副本</button>'
      ].join('') : '';
    }
    var worlds = store.listWorlds();
    var state = store.getState();
    var body = shell.querySelector('.module4-shell__body');
    if (body && body.dataset.managementInitialized !== 'true') setManagementOpen(shell, worlds.length === 0);
    Module4.UI.WorldList.render(document.getElementById('module4WorldList'), worlds, state.currentWorldId);
    var worldView = document.getElementById('module4WorldView');
    Module4.UI.PlayView.render(worldView, store.getCurrentWorld(), notice, {
      managementOpen: !!(body && body.classList.contains('is-management-open')),
      freeTextValue: renderOptions && renderOptions.freeTextValue || ''
    });
    Module4.UI.PlayView.bindAction(worldView && worldView.querySelector('[data-module4-action-form]'), function (result) {
      Module4.UI.render(shell, result.message);
    });
    Module4.UI.PlayView.bindFreeInput(worldView && worldView.querySelector('[data-module4-free-input-form]'), function (result) {
      Module4.UI.render(shell, result.message, { freeTextValue: result && result.retryText || '' });
    });
    Module4.UI.PlayView.bindNpc(worldView && worldView.querySelector('[data-module4-npc-source-form]'), function (result) {
      Module4.UI.render(shell, result.message);
    });
    Module4.UI.PlayView.bindMove(worldView && worldView.querySelector('[data-module4-move-form]'), function (result) {
      Module4.UI.render(shell, result.message);
    });
    Module4.UI.PlayView.bindSeek(worldView && worldView.querySelector('[data-module4-seek-form]'), function (result) {
      Module4.UI.render(shell, result.message);
    });
    Module4.UI.PlayView.bindPreview(worldView && worldView.querySelector('[data-module4-preview-form]'), function (result) {
      Module4.UI.render(shell, result.message);
    });
    var count = document.getElementById('module4WorldCount');
    if (count) count.textContent = String(worlds.length);
  };
}(window));
