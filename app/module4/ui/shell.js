/* Module 4 Task 6 shell: saved worlds and the unified player-action view. */
(function (root) {
  var Module4 = root.Module4 = root.Module4 || {};
  Module4.UI = Module4.UI || {};

  Module4.UI.mount = function (shell) {
    if (!shell || shell.dataset.mounted === 'true') return;
    shell.innerHTML = [
      '<header class="module4-shell__bar">',
      '<button class="btn btn--ghost" type="button" data-module4-action="close">← 返回叙界</button>',
      '<span class="module4-shell__title">开放沙盒文字 RPG</span>',
      '<span class="module4-shell__label">模块四 · 世界管理</span>',
      '</header>',
      '<div class="module4-shell__body">',
      '<aside class="module4-sidebar">',
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
    Module4.UI.WorldCreate.bind(form, function () { Module4.UI.render(shell); });
    shell.addEventListener('click', function (event) {
      var action = event.target.closest('[data-module4-action]');
      if (!action) return;
      var id = action.dataset.worldId;
      if (action.dataset.module4Action === 'close') Module4.close();
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
    });
    shell.dataset.mounted = 'true';
  };

  Module4.UI.render = function (shell, notice) {
    if (!shell) return;
    var store = Module4.State.Store;
    var worlds = store.listWorlds();
    var state = store.getState();
    Module4.UI.WorldList.render(document.getElementById('module4WorldList'), worlds, state.currentWorldId);
    var worldView = document.getElementById('module4WorldView');
    Module4.UI.PlayView.render(worldView, store.getCurrentWorld(), notice);
    Module4.UI.PlayView.bindAction(worldView && worldView.querySelector('[data-module4-action-form]'), function (result) {
      Module4.UI.render(shell, result.message);
    });
    Module4.UI.PlayView.bindFreeInput(worldView && worldView.querySelector('[data-module4-free-input-form]'), function (result) {
      Module4.UI.render(shell, result.message);
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
