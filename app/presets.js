/* =============================================================================
 * app/presets.js — 场景预设引擎（P0-1，v4 §4.7）
 * -----------------------------------------------------------------------------
 * 依赖（均在 app.js，本脚本在 app.js 之后加载，全局可见）：
 *   - state            全局状态（app.js:7）
 *   - switchRightTab() 右栏 Tab 切换（app.js:3135，通用，按 data-tab/id 匹配）
 *   - saveState()      持久化（app.js）
 *
 * 设计：纯增量，不改动现有任何函数。state 惰性加字段 currentPresetId
 *       （不改 state 定义，避免回归；P0-3 本地 Profile 时再统一整理状态字段）。
 *
 * 预设随 Work 持久化：applyPreset 重组右栏 Tab 显隐 / 视觉密度；
 * 命令面板 cmdFilter 由各自模块读取 getCurrentPreset() 自行适配。
 * ========================================================================== */

/* 右栏全部 Tab id（与 index.html .rp-tab[data-tab] / #rp-<id> 对齐） */
const RIGHT_TABS = ['status', 'attr', 'skill', 'inv', 'rel', 'quest'];

/* 内置场景预设（v4 §4.7） */
const SCENE_PRESETS = [
  {
    id: 'explore',
    name: '灵感探索',
    icon: '💡',
    desc: '剧情党·灵感期：对话与关系为主',
    defaultModule: 'dialogue',
    rightTabs: ['status', 'rel'],
    cmdFilter: ['dialogue', 'setting'],
    visualDensity: 'spacious',
    autoLaunch: ''
  },
  {
    id: 'longform',
    name: '严肃长篇',
    icon: '📖',
    desc: '作者·成稿期：写作、关系与任务为主',
    defaultModule: 'writing',
    rightTabs: ['rel', 'quest'],
    cmdFilter: ['writing', 'version', 'setting'],
    visualDensity: 'normal',
    autoLaunch: ''
  },
  {
    id: 'game',
    name: '互动游戏',
    icon: '🎮',
    desc: '玩家·游玩期：状态与技能为主',
    defaultModule: 'game',
    rightTabs: ['status', 'skill'],
    cmdFilter: ['game', 'check'],
    visualDensity: 'compact',
    autoLaunch: ''
  },
  {
    id: 'quickplay',
    name: '快速试玩',
    icon: '⚡',
    desc: '新用户/分享：极简对话',
    defaultModule: 'dialogue',
    rightTabs: ['status'],
    cmdFilter: ['dialogue'],
    visualDensity: 'spacious',
    autoLaunch: ''
  },
  {
    id: 'worldbuild',
    name: '世界观构建',
    icon: '🌍',
    desc: '架构师·设定期：设定与属性为主',
    defaultModule: 'library',
    rightTabs: ['attr', 'rel'],
    cmdFilter: ['setting', 'rule'],
    visualDensity: 'normal',
    autoLaunch: ''
  }
];

const DEFAULT_PRESET_ID = 'explore';

/* -------------------------------------------------------------------------- */

function getPresetById(id) {
  for (var i = 0; i < SCENE_PRESETS.length; i++) {
    if (SCENE_PRESETS[i].id === id) return SCENE_PRESETS[i];
  }
  return null;
}

function getCurrentPreset() {
  var id = (typeof state !== 'undefined' && state.currentPresetId) || DEFAULT_PRESET_ID;
  return getPresetById(id) || SCENE_PRESETS[0];
}

function listPresets() {
  return SCENE_PRESETS.map(function (p) {
    return { id: p.id, name: p.name, icon: p.icon, desc: p.desc };
  });
}

/* 切换预设：写状态 + 重组界面 + 持久化 + 通知 Denova（如在线） */
function switchPreset(id) {
  var p = getPresetById(id);
  if (!p) { console.warn('[presets] unknown preset:', id); return; }
  if (typeof state !== 'undefined') state.currentPresetId = p.id;
  applyPreset(p);
  if (typeof saveState === 'function') saveState();
  renderPresetSwitcher();
  if (typeof postToDenova === 'function') postToDenova('switch-scene', { presetId: p.id });
}

/* 重组界面：右栏 Tab 显隐 + 视觉密度 + 默认 Tab */
function applyPreset(preset) {
  if (!preset) return;
  var visible = {};
  (preset.rightTabs || []).forEach(function (t) { visible[t] = true; });

  RIGHT_TABS.forEach(function (tab) {
    var head = document.querySelector('.rp-tab[data-tab="' + tab + '"]');
    var body = document.getElementById('rp-' + tab);
    var show = !!visible[tab];
    if (head) head.style.display = show ? '' : 'none';
    if (body) body.style.display = show ? '' : 'none';
  });

  document.body.setAttribute('data-density', preset.visualDensity || 'normal');

  /* 若当前 active Tab 被隐藏，切到预设第一个可见 Tab */
  var curActive = document.querySelector('.rp-tab.active');
  if (curActive && curActive.style.display === 'none' && typeof switchRightTab === 'function') {
    var first = (preset.rightTabs && preset.rightTabs[0]) || 'status';
    switchRightTab(first);
  }

}

/* 渲染顶栏切换器 <select id="presetSwitcher"> */
function renderPresetSwitcher() {
  var sel = document.getElementById('presetSwitcher');
  if (!sel) return;
  var cur = getCurrentPreset();
  sel.innerHTML = SCENE_PRESETS.map(function (p) {
    return '<option value="' + p.id + '"' + (p.id === cur.id ? ' selected' : '') + '>' +
      p.icon + ' ' + p.name + '</option>';
  }).join('');
}

/* 初始化：平台启动后调用 */
function initPresets() {
  if (typeof state !== 'undefined' && !state.currentPresetId) {
    state.currentPresetId = DEFAULT_PRESET_ID;
  }
  renderPresetSwitcher();
  applyPreset(getCurrentPreset());
}

/* 自启（不改动 app.js 启动流程） */
document.addEventListener('DOMContentLoaded', function () {
  /* 确保 state 已由 app.js loadState() 载入后再初始化 */
  setTimeout(initPresets, 0);
});

/* 暴露命令面板调用入口（P0-5 cmdFilter 适配用） */
function getActiveCmdFilter() {
  var p = getCurrentPreset();
  return (p && p.cmdFilter) || [];
}
