/* Module 4 Task 1: world list rendering only. */
(function (root) {
  var Module4 = root.Module4 = root.Module4 || {};
  Module4.UI = Module4.UI || {};
  Module4.UI.WorldList = Module4.UI.WorldList || {};

  Module4.UI.WorldList.render = function (container, worlds, currentWorldId) {
    if (!container) return;
    var escape = Module4.UI.Components.escape;
    if (!worlds.length) {
      container.innerHTML = '<p class="module4-list-empty">还没有世界，先创建一个。</p>';
      return;
    }
    container.innerHTML = worlds.map(function (world) {
      var active = world.id === currentWorldId ? ' is-active' : '';
      return [
        '<article class="module4-world-item' + active + '">',
        '<button type="button" class="module4-world-item__open" data-module4-action="open-world" data-world-id="' + escape(world.id) + '">',
        '<strong>' + escape(world.title) + '</strong>',
        '<span>' + escape(world.description || '尚未填写世界说明') + '</span>',
        '</button>',
        '<button type="button" class="module4-world-item__delete" data-module4-action="delete-world" data-world-id="' + escape(world.id) + '" aria-label="删除 ' + escape(world.title) + '">删除</button>',
        '</article>'
      ].join('');
    }).join('');
  };
}(window));
