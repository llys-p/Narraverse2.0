/* Module 4 Task 1 UI primitives. */
(function (root) {
  var Module4 = root.Module4 = root.Module4 || {};
  Module4.UI = Module4.UI || {};
  Module4.UI.Components = Module4.UI.Components || {};

  Module4.UI.Components.escape = function (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  };
  Module4.UI.Components.date = function (value) {
    if (!value) return '刚刚';
    try { return new Date(value).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }); }
    catch (error) { return '刚刚'; }
  };
}(window));
