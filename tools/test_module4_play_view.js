/* Minimal Module 4 UI check: fallback diagnostics stay scoped, escaped, and redacted. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const context = {
  console: { error() {}, log() {} },
};
let scheduledPendingUpdate = null;
context.setTimeout = (callback) => {
  scheduledPendingUpdate = callback;
  return 1;
};
context.clearTimeout = () => {
  scheduledPendingUpdate = null;
};
context.window = context;
context.Module4 = {
  Action: { recommended() { return []; } },
  Clock: {
    PERIODS: ['morning', 'afternoon', 'evening'],
    periodLabel(period) { return period; },
  },
  Facts: { recent() { return []; } },
  Location: {
    list(world) { return world.locations; },
    get(world, id) { return world.locations.find((location) => location.id === id) || null; },
  },
  World: {
    listNpcs(world) { return Object.values(world.npcs); },
    listSourceCharacters() { return []; },
    getNpcSourceBinding(world, sourceRef) { return (world.sourceBindings || {})[sourceRef] || null; },
  },
  UI: {
    Components: {
      escape(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[character]));
      },
      date() { return '刚刚'; },
    },
  },
  AI: {
    Preview: {
      isCurrentDayValid(world) {
        return world.currentDay.previewGenerated === true
          && Number(world.currentDay.day) === Number(world.clock.day);
      },
    },
  },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('app/module4/ui/play-view.js', 'utf8'), context, {
  filename: 'app/module4/ui/play-view.js',
});

assert.strictEqual(context.Module4.UI.PlayView.isNarrativeAction({ type: 'move' }), true);
assert.strictEqual(context.Module4.UI.PlayView.isNarrativeAction({ type: 'custom' }), true);
assert.strictEqual(context.Module4.UI.PlayView.isNarrativeAction({ type: 'view_status' }), false);
assert.strictEqual(context.Module4.UI.PlayView.isNarrativeAction({ type: 'view_log' }), false);

function makeWorld(currentDay, actionLogs = [], narrativeEntries = []) {
  return {
    id: 'ui-test-world',
    title: 'UI 测试世界',
    description: '用于验证 Preview 诊断显示。',
    clock: { day: Number(currentDay.day) || 1, period: 'morning' },
    player: { name: '玩家', identity: '测试者', location: 'library', energy: 100, maxEnergy: 100 },
    locations: [{ id: 'library', name: '图书馆', description: '' }],
    npcs: {
      npc1: {
        id: 'npc1',
        sourceRef: 'source:npc1',
        name: '测试 NPC',
        mood: 'neutral',
        relation: { stage: 'unknown', value: 0 },
        schedule: { morning: {}, afternoon: {}, evening: {} },
      },
    },
    sourceBindings: {
      'source:npc1': {
        sourceRef: 'source:npc1',
        sourceVersion: 'source:npc1@2',
        snapshot: {
          name: '测试 NPC',
          personality: '谨慎而温柔',
          appearance: '总是带着一本旧笔记。',
          scenario: '',
        },
      },
    },
    currentDay,
    facts: [],
    dailyLogs: [],
    actionLogs,
    narrativeEntries,
  };
}

function render(currentDay, actionLogs, managementOpen = false, narrativeEntries = [], freeTextValue = '') {
  const container = { innerHTML: '' };
  context.Module4.UI.PlayView.render(container, makeWorld(currentDay, actionLogs, narrativeEntries), null, { managementOpen, freeTextValue });
  return container.innerHTML;
}

const openingHtml = render({ day: 1, previewGenerated: false });
assert.ok(openingHtml.includes('module4-current-scene'));
assert.ok(openingHtml.includes('data-module4-action-progress'));
assert.ok(openingHtml.includes('你叫玩家，身份是测试者。'));
assert.ok(openingHtml.includes('现在是第 1 天 · morning，你在图书馆。'));
assert.ok(openingHtml.indexOf('module4-current-scene') < openingHtml.indexOf('module4-free-input-form'));
assert.strictEqual(openingHtml.includes('module4-location-move-form'), false);
assert.strictEqual(openingHtml.includes('module4-meta-grid'), false);

const completedHtml = render({ day: 1, previewGenerated: true, previewStatus: 'completed', previewError: 'do not show' });
assert.strictEqual(completedHtml.includes('预演失败原因：'), false);
assert.strictEqual(completedHtml.includes('今日安排已保存'), false);
assert.strictEqual(completedHtml.includes('预演</span><strong>已生成'), false);

const fallbackHtml = render({
  day: 1,
  previewGenerated: true,
  previewStatus: 'fallback',
  previewError: 'API 错误 (401): Bearer sk-bearer-secret; apiKey=sk-api-secret; Authorization: sk-auth-secret; https://api.example.test/?token=sk-token-secret&key=sk-key-secret <script>alert(1)</script>',
}, [], true);
assert.ok(fallbackHtml.includes('预演失败原因：'));
assert.ok(fallbackHtml.includes('Bearer [REDACTED]'));
assert.ok(fallbackHtml.includes('apiKey=[REDACTED]'));
assert.ok(fallbackHtml.includes('Authorization: [REDACTED]'));
assert.ok(fallbackHtml.includes('token=[REDACTED]'));
assert.ok(fallbackHtml.includes('key=[REDACTED]'));
assert.ok(fallbackHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
for (const secret of ['sk-bearer-secret', 'sk-api-secret', 'sk-auth-secret', 'sk-token-secret', 'sk-key-secret']) {
  assert.strictEqual(fallbackHtml.includes(secret), false);
}

const emptyFallbackHtml = render({ day: 1, previewGenerated: true, previewStatus: 'fallback', previewError: '' });
assert.strictEqual(emptyFallbackHtml.includes('预演失败原因：'), false);

const completePreviewHtml = render({
  day: 1,
  previewGenerated: true,
  previewStatus: 'completed',
  schedules: {
    npc1: {
      npcId: 'npc1',
      mood: '冷静',
      goal: '调查旧钟',
      schedule: {
        morning: { locationId: 'library', activity: '查找档案' },
        afternoon: { locationId: 'library', activity: '整理线索' },
        evening: { locationId: 'library', activity: '记录发现' },
      },
    },
  },
});
assert.strictEqual(completePreviewHtml.includes('今日安排已保存'), false);
assert.strictEqual(completePreviewHtml.includes('图书馆 · 查找档案'), false);
assert.strictEqual(completePreviewHtml.includes('试玩检查'), false);
assert.strictEqual(completePreviewHtml.includes('这些安排只属于当前世界'), false);
assert.strictEqual(completePreviewHtml.includes('预演</span><strong>已生成'), false);

const managementHtml = render({
  day: 1,
  previewGenerated: true,
  previewStatus: 'completed',
  schedules: {
    npc1: {
      npcId: 'npc1',
      mood: '冷静',
      goal: '调查旧钟',
      schedule: {
        morning: { locationId: 'library', activity: '查找档案' },
        afternoon: { locationId: 'library', activity: '整理线索' },
        evening: { locationId: 'library', activity: '记录发现' },
      },
    },
  },
}, [], true);
assert.ok(managementHtml.includes('图书馆 · 查找档案'));
assert.ok(managementHtml.includes('试玩检查'));
assert.ok(managementHtml.includes('这些安排只属于当前世界'));
assert.ok(managementHtml.includes('来源角色卡'));
assert.ok(managementHtml.includes('source:npc1@2'));
assert.ok(managementHtml.includes('谨慎而温柔'));
assert.ok(managementHtml.includes('当前 Runtime'));

const actionTraceHtml = render({
  day: 1,
  previewGenerated: true,
  previewStatus: 'completed',
  schedules: {
    npc1: {
      npcId: 'npc1',
      mood: '冷静',
      goal: '调查旧钟',
      schedule: {
        morning: { locationId: 'library', activity: '查找档案' },
        afternoon: { locationId: 'library', activity: '整理线索' },
        evening: { locationId: 'library', activity: '记录发现' },
      },
    },
  },
}, [{
  day: 1,
  period: 'morning',
  type: 'move',
  description: '已移动到图书馆。行动完成。',
}], true);
assert.ok(actionTraceHtml.includes('已移动到图书馆。行动完成。'));

const responseHtml = render({ day: 1, previewGenerated: false }, [{
  id: 'action-1',
  day: 1,
  period: 'morning',
  type: 'chat',
  text: '我问测试 NPC 是否见过那份手稿。',
  description: '时间已推进。',
  createdAt: 100,
}], false, [{
  actionId: 'action-1',
  npcName: '测试 NPC',
  day: 1,
  period: 'morning',
  text: '测试 NPC 抬起头，告诉你他记得那份手稿。',
  createdAt: 101,
}]);
assert.ok(responseHtml.includes('我问测试 NPC 是否见过那份手稿。'));
assert.ok(responseHtml.includes('测试 NPC 抬起头，告诉你他记得那份手稿。'));
assert.ok(responseHtml.indexOf('我问测试 NPC 是否见过那份手稿。') < responseHtml.indexOf('测试 NPC 抬起头，告诉你他记得那份手稿。'));
assert.ok(responseHtml.includes('结果：时间已推进。'));

const customResponseHtml = render({ day: 1, previewGenerated: false }, [{
  id: 'action-custom',
  day: 1,
  period: 'morning',
  type: 'custom',
  text: '我靠在窗边听雨。',
  description: '已记录自定义行动；当前阶段不自动执行判定。',
  createdAt: 102,
}], false, [{
  actionId: 'action-custom',
  day: 1,
  period: 'morning',
  text: '雨丝沿着玻璃缓慢滑落，书页与潮气的味道混在一起。',
  createdAt: 103,
}]);
assert.ok(customResponseHtml.includes('雨丝沿着玻璃缓慢滑落'));
assert.strictEqual(customResponseHtml.includes('已记录自定义行动'), false);

const legacyCustomHtml = render({ day: 1, previewGenerated: false }, [{
  id: 'legacy-custom',
  day: 1,
  period: 'morning',
  type: 'custom',
  text: '开始上课',
  description: '已记录自定义行动；当前阶段不自动执行判定。',
  createdAt: 104,
}]);
assert.ok(legacyCustomHtml.includes('开始上课'));
assert.strictEqual(legacyCustomHtml.includes('已记录自定义行动'), false);

const foldedLogs = Array.from({ length: 8 }, (_, index) => ({
  id: `fold-${index + 1}`,
  day: 1,
  period: 'morning',
  type: 'custom',
  text: `第 ${index + 1} 轮行动`,
  createdAt: 200 + index * 2,
}));
const foldedNarratives = foldedLogs.map((log, index) => ({
  actionId: log.id,
  day: 1,
  period: 'morning',
  text: `第 ${index + 1} 轮回应`,
  createdAt: 201 + index * 2,
}));
const foldedHtml = render({ day: 1, previewGenerated: false }, foldedLogs, false, foldedNarratives);
assert.ok(foldedHtml.includes('今天较早的记录'));
assert.ok(foldedHtml.includes('2 轮'));
assert.ok(foldedHtml.includes('第 8 轮回应'));

const archivedHtml = render({ day: 2, previewGenerated: false }, foldedLogs.concat([{
  id: 'day-2-action',
  day: 2,
  period: 'morning',
  type: 'custom',
  text: '第二天的行动',
  createdAt: 300,
}]), false, foldedNarratives.concat([{
  actionId: 'day-2-action',
  day: 2,
  period: 'morning',
  text: '第二天的回应',
  createdAt: 301,
}]));
assert.ok(archivedHtml.includes('第二天的回应'));
assert.strictEqual(archivedHtml.includes('第 8 轮回应'), false);
const newDayHtml = render({ day: 2, previewGenerated: false }, foldedLogs, false, foldedNarratives);
assert.ok(newDayHtml.includes('新的一天开始了。之前的内容已归入世界轨迹。'));

const retryHtml = render({ day: 1, previewGenerated: false }, [], false, [], '我想重试这句话');
assert.ok(retryHtml.includes('value="我想重试这句话"'));

const pendingControls = [{ disabled: false }, { disabled: false }, { disabled: false }];
const pendingText = { textContent: '' };
const pendingProgress = { hidden: true, querySelector() { return pendingText; } };
const pendingClasses = new Set();
const pendingAttributes = {};
const pendingRegion = {
  dataset: {},
  matches(selector) { return selector === '[data-module4-action-form]'; },
  closest() { return null; },
  classList: {
    toggle(name, enabled) {
      if (enabled) pendingClasses.add(name);
      else pendingClasses.delete(name);
    },
  },
  setAttribute(name, value) { pendingAttributes[name] = value; },
  removeAttribute(name) { delete pendingAttributes[name]; },
  querySelectorAll() { return pendingControls; },
  querySelector(selector) {
    return selector === '[data-module4-action-progress]' ? pendingProgress : null;
  },
};

context.Module4.UI.PlayView.setActionPending(pendingRegion, true);
assert.strictEqual(pendingAttributes['aria-busy'], 'true');
assert.strictEqual(pendingClasses.has('is-pending'), true);
assert.strictEqual(pendingProgress.hidden, false);
assert.strictEqual(pendingText.textContent, '世界正在生成下一段，请稍候。');
assert.ok(pendingControls.every((control) => control.disabled));
assert.strictEqual(typeof scheduledPendingUpdate, 'function');

scheduledPendingUpdate();
assert.strictEqual(pendingText.textContent, '仍在生成，请不要重复提交。');

context.Module4.UI.PlayView.setActionPending(pendingRegion, false);
assert.strictEqual(pendingAttributes['aria-busy'], undefined);
assert.strictEqual(pendingClasses.has('is-pending'), false);
assert.strictEqual(pendingProgress.hidden, true);
assert.ok(pendingControls.every((control) => !control.disabled));

console.log('Module4 PlayView fallback diagnostic test passed.');
