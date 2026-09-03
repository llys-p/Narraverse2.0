/* Minimal Module 4 UI check: fallback diagnostics stay scoped, escaped, and redacted. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const context = {
  console: { error() {}, log() {} },
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

function makeWorld(currentDay, actionLogs = []) {
  return {
    id: 'ui-test-world',
    title: 'UI 测试世界',
    description: '用于验证 Preview 诊断显示。',
    clock: { day: 1, period: 'morning' },
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
    currentDay,
    facts: [],
    dailyLogs: [],
    actionLogs,
  };
}

function render(currentDay, actionLogs) {
  const container = { innerHTML: '' };
  context.Module4.UI.PlayView.render(container, makeWorld(currentDay, actionLogs));
  return container.innerHTML;
}

const completedHtml = render({ day: 1, previewGenerated: true, previewStatus: 'completed', previewError: 'do not show' });
assert.strictEqual(completedHtml.includes('预演失败原因：'), false);
assert.ok(completedHtml.includes('今日安排已保存'));
assert.ok(completedHtml.includes('预演</span><strong>已生成'));

const fallbackHtml = render({
  day: 1,
  previewGenerated: true,
  previewStatus: 'fallback',
  previewError: 'API 错误 (401): Bearer sk-bearer-secret; apiKey=sk-api-secret; Authorization: sk-auth-secret; https://api.example.test/?token=sk-token-secret&key=sk-key-secret <script>alert(1)</script>',
});
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
assert.ok(completePreviewHtml.includes('今日安排已保存'));
assert.ok(completePreviewHtml.includes('图书馆 · 查找档案'));
assert.ok(completePreviewHtml.includes('试玩检查'));
assert.ok(completePreviewHtml.includes('这些安排只属于当前世界'));
assert.ok(completePreviewHtml.includes('预演</span><strong>已生成'));

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
}]);
assert.ok(actionTraceHtml.includes('已移动到图书馆。行动完成。'));

console.log('Module4 PlayView fallback diagnostic test passed.');
