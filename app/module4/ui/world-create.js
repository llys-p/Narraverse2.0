/* Module 4 Task 1: create a world and hand rendering back to the shell. */
(function (root) {
  var Module4 = root.Module4 = root.Module4 || {};
  Module4.UI = Module4.UI || {};
  Module4.UI.WorldCreate = Module4.UI.WorldCreate || {};

  Module4.UI.WorldCreate.bind = function (form, onCreated) {
    if (!form || form.dataset.bound === 'true') return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var status = form.querySelector('[data-module4-create-status]');
      var title = form.querySelector('[name="title"]');
      var description = form.querySelector('[name="description"]');
      var locations = form.querySelector('[name="locations"]');
      var playerName = form.querySelector('[name="playerName"]');
      var playerIdentity = form.querySelector('[name="playerIdentity"]');
      try {
        var created = Module4.State.Store.createWorld({
          rulesVersion: 'v1.5',
          title: title && title.value,
          description: description && description.value,
          locations: locations && locations.value,
          player: { name: playerName && playerName.value, identity: playerIdentity && playerIdentity.value }
        });
        form.reset();
        if (status) status.textContent = '已保存';
        if (typeof onCreated === 'function') onCreated(created);
      } catch (error) {
        if (status) status.textContent = error.message || '保存失败';
      }
    });
    form.dataset.bound = 'true';
  };
}(window));
