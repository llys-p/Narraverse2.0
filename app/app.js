/* LAN access: dynamic bridge host (auto-adapts to phone/PC) */
const DENOVA_BRIDGE_BASE = 'http://' + window.location.hostname + ':8097';
const PIXIV_BRIDGE_BASE = 'http://' + window.location.hostname + ':8098';

/* ====================================================================
 * 叙界 Narraverse — AI 文字冒险平台
 * 核心: LLM API + 侧边批注列 + 上下文管理 + 属性/技能/角色卡/设定书
 * ==================================================================== */

const isDenovaEmbedded = typeof window !== 'undefined' &&
  window.location && new URLSearchParams(window.location.search).get('embedded') === 'denova';
if (typeof document !== 'undefined' && document.body) {
  document.body.dataset.host = isDenovaEmbedded ? 'denova' : 'standalone';
}

/* ==================== 全局状态 ==================== */
const state = {
  adventures: [],
  currentId: null,
  apiConfig: { endpoint: '', apiKey: '', model: '', maxTokens: 8000, maxOutputTokens: 4096, temperature: 0.85, streaming: true, autoSave: true, autoSaveEvery: 5, loreScanDepth: 14, loreBudgetPct: 30, macroEnabled: true, ttsEngine: 'native', cosyvoiceEndpoint: 'wss://llm-23ju9mf3n4t0k5dx.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference', cosyvoiceApiKey: '', cosyvoiceRelay: '', cosyvoiceVoice: 'longanyang', imageApiEndpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', imageApiKey: '', imageModel: 'qwen-image-3.0-pro' },
  customThemes: [],
  deletedThemes: [],
  uploadedLoadCards: [],
  isGenerating: false,
  selectedTheme: '奇幻',
  selectedProfession: null,
  selectedMode: 'adventure',
  ui: { sidebarCollapsed: false },
  // v4 统一外壳层（P0-3/P0-1）
  userProfile: null,          // 本地 Profile（昵称/默认模型/主题/NSFW/默认预设），无云端
  denovaBooks: [],            // P1: Denova 工程 lore 缓存（加载库可挂载）
  currentPresetId: null,      // 当前场景预设 id（presets.js 读写）
};

/* 失败消息缓存：用于“重试”按钮 */
let lastFailedMessage = null;

/* 新建冒险时勾选加载的角色卡 / 设定书 */
let pendingLoadCards = [];
let pendingLoadBooks = [];
let adventureStoryPreference = '';
let generatedStoryProposals = [];
let selectedStoryProposalId = null;
let storyProposalGenerating = false;
let storyProposalError = '';
let adventureTitleDraft = '';
let adventureOpeningHook = '';

function resetAdventureCreationSession() {
  adventureStoryPreference = '';
  generatedStoryProposals = [];
  selectedStoryProposalId = null;
  storyProposalGenerating = false;
  storyProposalError = '';
  adventureTitleDraft = '';
  adventureOpeningHook = '';
}

function getLockedProfession() {
  const primary = document.getElementById('customProfessionInput');
  const customTheme = document.getElementById('customProfessionName');
  return String((primary && primary.value) || customProfession || (customTheme && customTheme.value) || '').trim();
}

function normalizeStoryProposal(raw, index, lockedProfession) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = function (value, fallback) {
    const out = String(value == null ? '' : value).trim();
    return out || fallback || '';
  };
  const cast = Array.isArray(raw.cast) ? raw.cast.map(function (item) {
    if (typeof item === 'string') return { name: text(item, '未命名角色'), role: '', relationship: '' };
    if (!item || typeof item !== 'object') return null;
    return {
      name: text(item.name, '未命名角色'),
      role: text(item.role || item.position, ''),
      relationship: text(item.relationship, ''),
    };
  }).filter(Boolean) : [];
  const toneTags = Array.isArray(raw.toneTags || raw.tags)
    ? (raw.toneTags || raw.tags).map(function (tag) { return text(tag, ''); }).filter(Boolean).slice(0, 6)
    : text(raw.toneTags || raw.tags, '').split(/[,，、]/).map(function (tag) { return tag.trim(); }).filter(Boolean).slice(0, 6);
  return {
    id: 'proposal_' + (index + 1),
    title: text(raw.title, '未命名故事方案 ' + (index + 1)),
    pitch: text(raw.pitch || raw.sellingPoint, '一场等待展开的冒险'),
    world: text(raw.world || raw.worldBackground, ''),
    playerIdentity: text(raw.playerIdentity || raw.identity, ''),
    profession: text(lockedProfession, '') || text(raw.profession, '') || text(state.selectedProfession, '冒险者'),
    location: text(raw.location || raw.startingLocation, ''),
    goal: text(raw.goal || raw.initialGoal, ''),
    toneTags: toneTags,
    cast: cast,
    openingHook: text(raw.openingHook || raw.hook, ''),
    other: text(raw.other || raw.notes, ''),
  };
}

function parseStoryProposals(rawText, lockedProfession) {
  let source = String(rawText || '').trim();
  source = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let parsed = null;
  try { parsed = JSON.parse(source); } catch (firstError) {
    const objectStart = source.indexOf('{');
    const objectEnd = source.lastIndexOf('}');
    const arrayStart = source.indexOf('[');
    const arrayEnd = source.lastIndexOf(']');
    const candidates = [];
    if (objectStart !== -1 && objectEnd > objectStart) candidates.push(source.slice(objectStart, objectEnd + 1));
    if (arrayStart !== -1 && arrayEnd > arrayStart) candidates.push(source.slice(arrayStart, arrayEnd + 1));
    for (const candidate of candidates) {
      try { parsed = JSON.parse(candidate); break; } catch (ignore) { /* try next candidate */ }
    }
  }
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.proposals) ? parsed.proposals : []);
  return list.slice(0, 3).map(function (item, index) {
    return normalizeStoryProposal(item, index, lockedProfession);
  }).filter(Boolean);
}

/* 正在编辑的消息索引 */
let editingMessageIndex = -1;

/* 主题默认数据 */
const themeData = {
  '奇幻': { items: [{name:'干粮',qty:3,desc:'补充体力的食物'},{name:'火把',qty:2,desc:'照明用，可燃烧约2小时'},{name:'短剑',qty:1,desc:'基础近战武器'}], location: '迷雾森林入口', desc: '剑与魔法的世界，巨龙、精灵与古老遗迹' },
  '科幻': { items: [{name:'能量电池',qty:2,desc:'为设备供能'},{name:'通讯器',qty:1,desc:'短距离通讯'},{name:'医疗包',qty:1,desc:'恢复30HP'}], location: '星际飞船·休眠舱', desc: '星际航行、赛博朋克或异星探索' },
  '恐怖': { items: [{name:'手电筒',qty:1,desc:'照明，电池有限'},{name:'旧钥匙',qty:1,desc:'不知开什么门'},{name:'绷带',qty:3,desc:'恢复10HP'}], location: '陌生黑暗的房间', desc: '诡异氛围、未知恐惧与生存挑战' },
  '末日': { items: [{name:'水壶',qty:1,desc:'装满清水'},{name:'罐头',qty:2,desc:'可食用'},{name:'铁管',qty:1,desc:'简易武器'}], location: '废墟之中', desc: '废土求生、丧尸或文明崩坏后的世界' },
  '武侠': { items: [{name:'干粮',qty:3,desc:'充饥'},{name:'长剑',qty:1,desc:'锋利的长剑'},{name:'伤药',qty:2,desc:'恢复20HP'}], location: '江湖古道', desc: '江湖恩怨、武功秘籍与门派纷争' },
  '悬疑': { items: [{name:'手机',qty:1,desc:'可通讯和拍照'},{name:'记事本',qty:1,desc:'记录线索'},{name:'钥匙',qty:1,desc:'未知用途的钥匙'}], location: '案发现场', desc: '案件调查、推理与真相揭露' },
};

/* 职业数据 */
const professionData = {
  '奇幻': [
    { name: '剑士', attrs: { 力量:14, 敏捷:12, 智力:8, 魅力:10, 幸运:10 }, skills: [{ name:'基础剑术', level:1, desc:'掌握基础剑技' }] },
    { name: '法师', attrs: { 力量:7, 敏捷:9, 智力:16, 魅力:10, 幸运:10 }, skills: [{ name:'魔法飞弹', level:1, desc:'发射一枚魔法飞弹' }] },
    { name: '游侠', attrs: { 力量:10, 敏捷:15, 智力:10, 魅力:10, 幸运:10 }, skills: [{ name:'精准射击', level:1, desc:'弓箭精准度提升' }] },
    { name: '牧师', attrs: { 力量:8, 敏捷:9, 智力:14, 魅力:13, 幸运:10 }, skills: [{ name:'初级治疗', level:1, desc:'恢复少量HP' }] },
    { name: '盗贼', attrs: { 力量:9, 敏捷:14, 智力:12, 魅力:10, 幸运:13 }, skills: [{ name:'潜行', level:1, desc:'降低被发现概率' }] },
  ],
  '科幻': [
    { name: '战士', attrs: { 力量:15, 敏捷:10, 智力:8, 魅力:10, 幸运:9 }, skills: [{ name:'重击', level:1, desc:'强力近战攻击' }] },
    { name: '工程师', attrs: { 力量:9, 敏捷:10, 智力:15, 魅力:10, 幸运:10 }, skills: [{ name:'维修', level:1, desc:'修复机械装置' }] },
    { name: '医护', attrs: { 力量:8, 敏捷:10, 智力:14, 魅力:12, 幸运:10 }, skills: [{ name:'急救', level:1, desc:'紧急治疗' }] },
    { name: '黑客', attrs: { 力量:7, 敏捷:11, 智力:16, 魅力:8, 幸运:12 }, skills: [{ name:'入侵', level:1, desc:'入侵电子系统' }] },
    { name: '飞行员', attrs: { 力量:9, 敏捷:15, 智力:12, 魅力:10, 幸运:8 }, skills: [{ name:'驾驶', level:1, desc:'熟练驾驶载具' }] },
  ],
  '恐怖': [
    { name: '侦探', attrs: { 力量:10, 敏捷:10, 智力:15, 魅力:10, 幸运:9 }, skills: [{ name:'推理', level:1, desc:'发现隐藏线索' }] },
    { name: '记者', attrs: { 力量:8, 敏捷:12, 智力:13, 魅力:11, 幸运:10 }, skills: [{ name:'采访', level:1, desc:'获取信息' }] },
    { name: '警察', attrs: { 力量:14, 敏捷:11, 智力:10, 魅力:10, 幸运:9 }, skills: [{ name:'格斗', level:1, desc:'近身搏斗' }] },
    { name: '医生', attrs: { 力量:9, 敏捷:10, 智力:15, 魅力:11, 幸运:9 }, skills: [{ name:'诊断', level:1, desc:'判断伤病情况' }] },
    { name: '普通人', attrs: { 力量:10, 敏捷:10, 智力:10, 魅力:10, 幸运:14 }, skills: [{ name:'直觉', level:1, desc:'危险直觉感知' }] },
  ],
  '末日': [
    { name: '生存者', attrs: { 力量:12, 敏捷:13, 智力:10, 魅力:9, 幸运:10 }, skills: [{ name:'搜刮', level:1, desc:'更高效搜寻物资' }] },
    { name: '机械师', attrs: { 力量:11, 敏捷:10, 智力:14, 魅力:9, 幸运:10 }, skills: [{ name:'修理', level:1, desc:'修复机械设备' }] },
    { name: '医疗兵', attrs: { 力量:10, 敏捷:10, 智力:14, 魅力:10, 幸运:10 }, skills: [{ name:'急救', level:1, desc:'紧急治疗' }] },
    { name: '狙击手', attrs: { 力量:11, 敏捷:15, 智力:10, 魅力:8, 幸运:10 }, skills: [{ name:'狙击', level:1, desc:'远程精准射击' }] },
    { name: '领袖', attrs: { 力量:10, 敏捷:10, 智力:12, 魅力:15, 幸运:10 }, skills: [{ name:'鼓舞', level:1, desc:'激励同伴士气' }] },
  ],
  '武侠': [
    { name: '剑客', attrs: { 力量:13, 敏捷:13, 智力:10, 魅力:10, 幸运:8 }, skills: [{ name:'基础剑法', level:1, desc:'入门剑术' }] },
    { name: '刀客', attrs: { 力量:15, 敏捷:11, 智力:9, 魅力:10, 幸运:9 }, skills: [{ name:'劈刀式', level:1, desc:'强力劈砍' }] },
    { name: '拳师', attrs: { 力量:14, 敏捷:12, 智力:10, 魅力:10, 幸运:8 }, skills: [{ name:'铁拳', level:1, desc:'重拳攻击' }] },
    { name: '暗器手', attrs: { 力量:9, 敏捷:15, 智力:12, 魅力:9, 幸运:11 }, skills: [{ name:'暗器投掷', level:1, desc:'远程暗器攻击' }] },
    { name: '医师', attrs: { 力量:8, 敏捷:10, 智力:15, 魅力:12, 幸运:9 }, skills: [{ name:'针灸', level:1, desc:'用银针治疗' }] },
  ],
  '悬疑': [
    { name: '警探', attrs: { 力量:11, 敏捷:10, 智力:14, 魅力:11, 幸运:8 }, skills: [{ name:'勘查', level:1, desc:'现场勘查' }] },
    { name: '记者', attrs: { 力量:8, 敏捷:12, 智力:13, 魅力:11, 幸运:10 }, skills: [{ name:'情报网', level:1, desc:'获取内幕消息' }] },
    { name: '心理医生', attrs: { 力量:9, 敏捷:9, 智力:16, 魅力:12, 幸运:8 }, skills: [{ name:'心理分析', level:1, desc:'分析人物心理' }] },
    { name: '律师', attrs: { 力量:9, 敏捷:9, 智力:15, 魅力:13, 幸运:8 }, skills: [{ name:'质询', level:1, desc:'追问关键信息' }] },
    { name: '私家侦探', attrs: { 力量:10, 敏捷:13, 智力:13, 魅力:10, 幸运:10 }, skills: [{ name:'跟踪', level:1, desc:'隐蔽跟踪目标' }] },
  ],
};

/* ==================== 冒险类型（题材 × 玩法模式，约26类） ==================== */
/* 每类由「题材(genre) + 玩法模式(mode)」组合，绑定职业池、初始物品与推荐知识库分类。 */
const GENRE_PROFESSIONS = {
  '奇幻': professionData['奇幻'],
  '异世界': professionData['奇幻'],
  '武侠': professionData['武侠'],
  '科幻': professionData['科幻'],
  '赛博朋克': professionData['科幻'],
  '太空歌剧': professionData['科幻'].concat([{ name:'舰长', attrs:{力量:12,敏捷:12,智力:13,魅力:13,幸运:10}, skills:[{name:'指挥',level:1,desc:'统率舰队'}] }]),
  '末日废土': professionData['末日'],
  '丧尸': professionData['末日'],
  '恐怖': professionData['恐怖'],
  '悬疑': professionData['悬疑'],
  '修仙': [
    { name:'剑修', attrs:{力量:12,敏捷:14,智力:10,魅力:10,幸运:10}, skills:[{name:'御剑术',level:1,desc:'剑气伤敌'}] },
    { name:'体修', attrs:{力量:16,敏捷:11,智力:8,魅力:9,幸运:10}, skills:[{name:'炼体',level:1,desc:'肉身强悍'}] },
    { name:'丹师', attrs:{力量:8,敏捷:9,智力:15,魅力:11,幸运:10}, skills:[{name:'炼丹',level:1,desc:'炼制丹药'}] },
    { name:'符师', attrs:{力量:9,敏捷:10,智力:14,魅力:10,幸运:11}, skills:[{name:'画符',level:1,desc:'符箓施法'}] },
    { name:'阵法师', attrs:{力量:9,敏捷:10,智力:15,魅力:10,幸运:10}, skills:[{name:'布阵',level:1,desc:'布置阵法'}] },
  ],
  '无限流': [
    { name:'轮回者', attrs:{力量:11,敏捷:12,智力:12,魅力:10,幸运:12}, skills:[{name:'适应',level:1,desc:'快速适应副本'}] },
    { name:'刺客', attrs:{力量:10,敏捷:16,智力:10,魅力:9,幸运:11}, skills:[{name:'背刺',level:1,desc:'高额背刺'}] },
    { name:'召唤师', attrs:{力量:8,敏捷:10,智力:15,魅力:10,幸运:11}, skills:[{name:'召唤',level:1,desc:'召唤眷属'}] },
    { name:'辅助', attrs:{力量:9,敏捷:10,智力:13,魅力:13,幸运:11}, skills:[{name:'增益',level:1,desc:'团队增益'}] },
    { name:'战士', attrs:{力量:15,敏捷:11,智力:9,魅力:9,幸运:10}, skills:[{name:'狂战',level:1,desc:'越战越勇'}] },
  ],
  '系统流': [
    { name:'系统宿主', attrs:{力量:10,敏捷:10,智力:10,魅力:10,幸运:14}, skills:[{name:'系统空间',level:1,desc:'存放奖励'}] },
    { name:'签到者', attrs:{力量:10,敏捷:10,智力:11,魅力:10,幸运:13}, skills:[{name:'每日签到',level:1,desc:'领取每日奖励'}] },
    { name:'肝帝', attrs:{力量:12,敏捷:12,智力:11,魅力:9,幸运:10}, skills:[{name:'刷怪',level:1,desc:'高效获取经验'}] },
    { name:'战斗狂', attrs:{力量:15,敏捷:13,智力:9,魅力:9,幸运:9}, skills:[{name:'战斗直觉',level:1,desc:'战斗增益'}] },
    { name:'欧皇', attrs:{力量:10,敏捷:10,智力:10,魅力:10,幸运:17}, skills:[{name:'气运',level:1,desc:'稀有掉落'}] },
  ],
  '校园': [
    { name:'学生', attrs:{力量:9,敏捷:10,智力:12,魅力:11,幸运:11}, skills:[{name:'学习',level:1,desc:'提升成绩'}] },
    { name:'学霸', attrs:{力量:8,敏捷:9,智力:16,魅力:10,幸运:10}, skills:[{name:'解题',level:1,desc:'快速解题'}] },
    { name:'体育生', attrs:{力量:14,敏捷:15,智力:9,魅力:10,幸运:10}, skills:[{name:'体能',level:1,desc:'运动擅长'}] },
    { name:'班长', attrs:{力量:10,敏捷:10,智力:12,魅力:13,幸运:10}, skills:[{name:'组织',level:1,desc:'统筹班级'}] },
    { name:'转校生', attrs:{力量:10,敏捷:11,智力:11,魅力:12,幸运:11}, skills:[{name:'融入',level:1,desc:'快速结交'}] },
  ],
  '都市': [
    { name:'上班族', attrs:{力量:10,敏捷:10,智力:12,魅力:10,幸运:10}, skills:[{name:'社交',level:1,desc:'职场人际'}] },
    { name:'神医', attrs:{力量:9,敏捷:10,智力:16,魅力:11,幸运:10}, skills:[{name:'妙手回春',level:1,desc:'治愈伤病'}] },
    { name:'保镖', attrs:{力量:15,敏捷:13,智力:10,魅力:9,幸运:10}, skills:[{name:'护送',level:1,desc:'保护目标'}] },
    { name:'总裁', attrs:{力量:11,敏捷:10,智力:14,魅力:14,幸运:10}, skills:[{name:'决策',level:1,desc:'商业决断'}] },
    { name:'记者', attrs:{力量:8,敏捷:12,智力:13,魅力:11,幸运:10}, skills:[{name:'情报网',level:1,desc:'获取内幕'}] },
  ],
  '同人': professionData['奇幻'],
  '历史': [
    { name:'将领', attrs:{力量:14,敏捷:11,智力:12,魅力:11,幸运:10}, skills:[{name:'统兵',level:1,desc:'指挥作战'}] },
    { name:'谋士', attrs:{力量:8,敏捷:9,智力:16,魅力:12,幸运:10}, skills:[{name:'谋略',level:1,desc:'运筹帷幄'}] },
    { name:'刺客', attrs:{力量:10,敏捷:16,智力:11,魅力:9,幸运:11}, skills:[{name:'暗杀',level:1,desc:'一击毙命'}] },
    { name:'商贾', attrs:{力量:9,敏捷:10,智力:13,魅力:13,幸运:11}, skills:[{name:'经商',level:1,desc:'积累财富'}] },
    { name:'侠客', attrs:{力量:13,敏捷:14,智力:10,魅力:12,幸运:10}, skills:[{name:'侠义',level:1,desc:'行侠仗义'}] },
  ],
  '通用': [
    { name:'冒险者', attrs:{力量:11,敏捷:11,智力:11,魅力:10,幸运:11}, skills:[{name:'生存',level:1,desc:'野外求生'}] },
    { name:'战士', attrs:{力量:15,敏捷:10,智力:8,魅力:10,幸运:10}, skills:[{name:'重击',level:1,desc:'强力攻击'}] },
    { name:'法师', attrs:{力量:7,敏捷:9,智力:16,魅力:10,幸运:10}, skills:[{name:'魔法飞弹',level:1,desc:'远程法术'}] },
    { name:'商人', attrs:{力量:9,敏捷:10,智力:13,魅力:13,幸运:10}, skills:[{name:'交易',level:1,desc:'议价获利'}] },
    { name:'学者', attrs:{力量:8,敏捷:9,智力:16,魅力:11,幸运:10}, skills:[{name:'博学',level:1,desc:'广知见闻'}] },
  ],
  'NSFW': [
    { name:'主人', attrs:{力量:12,敏捷:11,智力:11,魅力:12,幸运:10}, skills:[{name:'掌控',level:1,desc:'主导关系'}] },
    { name:'倾慕者', attrs:{力量:9,敏捷:10,智力:11,魅力:14,幸运:11}, skills:[{name:'取悦',level:1,desc:'亲近讨好'}] },
    { name:'顺从者', attrs:{力量:8,敏捷:9,智力:10,魅力:13,幸运:11}, skills:[{name:'服从',level:1,desc:'言听计从'}] },
    { name:'诱惑者', attrs:{力量:9,敏捷:12,智力:11,魅力:15,幸运:10}, skills:[{name:'魅惑',level:1,desc:'撩动心绪'}] },
    { name:'观察者', attrs:{力量:10,敏捷:10,智力:12,魅力:10,幸运:11}, skills:[{name:'旁观',level:1,desc:'静观其变'}] },
  ],
};
const GENRE_ITEMS = {
  '奇幻': themeData['奇幻'].items, '异世界': themeData['奇幻'].items, '武侠': themeData['武侠'].items,
  '科幻': themeData['科幻'].items, '赛博朋克': themeData['科幻'].items, '太空歌剧': themeData['科幻'].items,
  '末日废土': themeData['末日'].items, '丧尸': themeData['末日'].items, '恐怖': themeData['恐怖'].items, '悬疑': themeData['悬疑'].items,
  '修仙': [{name:'干粮',qty:3,desc:'充饥'},{name:'灵石',qty:2,desc:'修炼资源'},{name:'符纸',qty:5,desc:'画符用'}],
  '无限流': [{name:'补给包',qty:2,desc:'副本补给'},{name:'积分卡',qty:1,desc:'兑换物资'},{name:'恢复药剂',qty:2,desc:'恢复状态'}],
  '系统流': [{name:'新手礼包',qty:1,desc:'初始奖励'},{name:'恢复药剂',qty:2,desc:'恢复状态'},{name:'任务卷轴',qty:1,desc:'接取任务'}],
  '校园': [{name:'课本',qty:3,desc:'学习'},{name:'手机',qty:1,desc:'通讯'},{name:'便当',qty:1,desc:'午餐'}],
  '都市': [{name:'手机',qty:1,desc:'通讯'},{name:'钱包',qty:1,desc:'现金'},{name:'车钥匙',qty:1,desc:'座驾'}],
  '同人': themeData['奇幻'].items,
  '历史': [{name:'干粮',qty:3,desc:'军粮'},{name:'长剑',qty:1,desc:'佩剑'},{name:'战马',qty:1,desc:'坐骑'}],
  '通用': [{name:'干粮',qty:3,desc:'充饥'},{name:'水壶',qty:1,desc:'饮水'},{name:'火把',qty:2,desc:'照明'}],
  'NSFW': [{name:'情境道具',qty:1,desc:'情境所需'}],
};
const MODE_FLAVOR = {
  '探索': '以探索与解谜为主线，重视地图与世界观展开',
  '升级': '以成长变强为主线，重视等级/技能/数值突破',
  '生存': '以险境求生为主线，重视资源与据点',
  '战斗': '以战斗对抗为主线，重视招式与胜负',
  '恋爱': '以情感关系为主线，重视角色互动',
  '逆袭': '以弱到强、打脸翻盘为主线',
  '副本': '以无限流副本挑战为主线，重视随机与天赋',
  '解谜': '以推理解密为主线',
  '权谋': '以势力权谋为主线',
  '经营': '以建设经营为主线',
  '战斗爽文': '以无敌碾压、爽快战斗为主线',
};
/* [名称, 题材, 模式, 起始地点, 描述, 推荐知识库分类[]] */
const ADVENTURE_TYPE_DEFS = [
  ['西幻高奇幻·冒险探索', '奇幻', '探索', '迷雾森林·古老遗迹', '剑与魔法的世界，探索未知遗迹与巨龙传说', ['奇幻']],
  ['日式异世界·转生冒险', '异世界', '探索', '异世界传送阵', '转生到异世界，从零开始的冒险与邂逅', ['奇幻','同人世界']],
  ['修仙仙侠·问道升级', '修仙', '升级', '修真宗门·外门弟子房', '仙侠世界，修炼求道、渡劫飞升', ['修仙仙侠','小说模板']],
  ['武侠江湖·恩怨情仇', '武侠', '战斗', '江湖古道·客栈', '武林恩怨、门派纷争与快意恩仇', ['其他']],
  ['赛博朋克·义体黑客', '赛博朋克', '探索', '夜之城·霓虹巷', '赛博朋克都市，义体改造与黑客暗战', ['科幻']],
  ['太空歌剧·星际远征', '太空歌剧', '探索', '星际飞船·舰桥', '硬核太空歌剧，星际势力与远航', ['科幻']],
  ['末日废土·生存搜刮', '末日废土', '生存', '废墟之城·避难所', '废土求生，搜刮物资与据点', ['末日废土']],
  ['丧尸末日·据点防守', '丧尸', '生存', '封闭小区·天台', '丧尸围城，守护据点求生', ['末日废土','恐怖']],
  ['无限流·副本轮回', '无限流', '副本', '主神空间·光柱', '无限流轮回，随机副本与天赋系统', ['小说模板']],
  ['系统流·签到升级', '系统流', '升级', '系统面板·新手村', '系统流升级，签到变强打脸', ['小说模板']],
  ['校园青春·日常恋爱', '校园', '恋爱', '校园·教室', '校园日常与青春恋爱', ['校园']],
  ['校园异能·超自然事件', '校园', '战斗', '学园·旧校舍', '校园背景的超自然异能战斗', ['校园','科幻']],
  ['都市异能·扮猪吃虎', '都市', '逆袭', '都市·写字楼', '都市异能，隐藏实力逆袭翻盘', ['其他']],
  ['都市神医·医术逆袭', '都市', '逆袭', '都市·诊所', '都市神医，以医术逆袭人生', ['其他']],
  ['克苏鲁恐怖·调查求生', '恐怖', '生存', '临海小镇·灯塔', '克苏鲁恐怖，调查不可名状之物', ['恐怖']],
  ['灵异诡秘·驱邪解谜', '恐怖', '解谜', '古宅·祠堂', '诡秘灵异，驱邪与解谜', ['恐怖']],
  ['同人火影·忍界大战', '同人', '战斗', '木叶村·训练场', '火影忍者世界，忍者战斗与忍界大战', ['同人世界']],
  ['同人HP·魔法学院', '同人', '探索', '霍格沃茨·礼堂', '哈利波特世界，魔法学院生活', ['同人世界']],
  ['同人西幻·屠龙冒险', '同人', '探索', '维斯特洛·城外', '西幻世界，权谋与征伐', ['同人世界','奇幻']],
  ['历史架空·权谋争霸', '历史', '权谋', '王城·朝堂', '架空历史，势力博弈与权谋争霸', ['其他']],
  ['悬疑推理·罪案追踪', '悬疑', '解谜', '案发现场·警局', '罪案调查，推理揭真相', ['其他']],
  ['经营种田·领地建设', '通用', '经营', '边境领地·庄园', '经营建设，种田与领地发展', ['通用系统']],
  ['恋爱后宫·多线攻略', '通用', '恋爱', '都市·咖啡馆', '多角色恋爱攻略', ['NSFW']],
  ['战斗爽文·无敌碾压', '通用', '战斗爽文', '任意战场', '无敌流爽文，碾压一切对手', ['其他']],
  ['凡人流修仙·散修求道', '修仙', '探索', '散修洞府', '凡人散修，低调求道', ['修仙仙侠','小说模板']],
  ['NSFW成人·情感纠葛', 'NSFW', '恋爱', '私密空间', '成人向情感与关系剧情', ['NSFW']],
];
const ADVENTURE_TYPES = ADVENTURE_TYPE_DEFS.map(function (d) {
  const name = d[0], genre = d[1], mode = d[2], location = d[3], desc = d[4], recommend = d[5];
  const modeFlavor = MODE_FLAVOR[mode] || '';
  return {
    name: name, genre: genre, mode: mode, location: location,
    desc: desc + (modeFlavor ? '（' + modeFlavor + '）' : ''),
    items: (GENRE_ITEMS[genre] || GENRE_ITEMS['奇幻']).map(function (it) { return Object.assign({}, it); }),
    professions: GENRE_PROFESSIONS[genre] || GENRE_PROFESSIONS['通用'],
    recommend: recommend,
  };
});
function getAdventureType(name) {
  return ADVENTURE_TYPES.find(function (t) { return t.name === name; }) || null;
}
/* 按推荐分类从本地知识库筛选设定书（去重，供冒险类型一键挂载） */
function collectRecommendBooks(recommendCategories) {
  const out = [];
  if (recommendCategories && window.LOCAL_LIBRARY && window.LOCAL_LIBRARY.books) {
    for (const b of window.LOCAL_LIBRARY.books) {
      if (recommendCategories.indexOf(b.category) !== -1 &&
          !out.some(function (x) { return x.title === b.title; })) {
        out.push(b);
      }
    }
  }
  return out;
}

/* 属性中文名映射 */
const attrNames = { '力量': 'STR', '敏捷': 'AGI', '智力': 'INT', '魅力': 'CHA', '幸运': 'LUK' };

/* ==================== 持久化 ==================== */

/* 物品格式归一化：旧数据 string[] → 新数据 {name,qty,desc}[] */
function normalizeItems(items) {
  if (!items) return [];
  return items.map(function(item) {
    if (typeof item === 'string') return { name: item, qty: 1, desc: '' };
    if (!item.name) return { name: String(item), qty: item.qty || 1, desc: item.desc || '' };
    return { name: item.name, qty: item.qty || 1, desc: item.desc || '' };
  });
}

/* ==================== IndexedDB 持久化（扩大存储空间） ==================== */
const IDB_NAME = 'adventureAI_db';
const IDB_STORE = 'kv';
let idbConnPromise = null;

function idbOpen() {
  if (idbConnPromise) return idbConnPromise;
  if (!('indexedDB' in window)) {
    idbConnPromise = Promise.reject(new Error('IndexedDB 不可用'));
    return idbConnPromise;
  }
  idbConnPromise = new Promise(function (resolve, reject) {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = function () {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error || new Error('打开 IndexedDB 失败')); };
  });
  return idbConnPromise;
}

function idbSet(key, value) {
  return idbOpen().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB 写入失败')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB 写入中断')); };
    });
  });
}

function idbGet(key) {
  return idbOpen().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB 读取失败')); };
    });
  });
}

/* ==================== 永久对话档案（独立于上下文压缩） ==================== */
const CONVERSATION_ARCHIVE_VERSION = 1;
const CONVERSATION_ARCHIVE_CHUNK_EVENTS = 100;
let conversationArchiveQueue = Promise.resolve();

function archiveMetaKey(adventureId) { return 'conversationArchive:v1:' + adventureId + ':meta'; }
function archiveChunkKey(adventureId, index) { return 'conversationArchive:v1:' + adventureId + ':chunk:' + index; }

function messageFingerprint(message, index) {
  const raw = String((message && message.role) || '') + '\n' + String((message && message.content) || '') + '\n' + String(index || 0);
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) { hash ^= raw.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}

function ensureMessageIdentity(message, index, adventureId) {
  if (!message || message.role === 'system') return message;
  if (!message.id) message.id = 'msg_' + String(adventureId || 'legacy').replace(/[^A-Za-z0-9_-]/g, '').slice(-24) + '_' + messageFingerprint(message, index);
  if (!message.createdAt) message.createdAt = Date.now();
  return message;
}

function visibleConversation(history, adventureId) {
  return (history || []).filter(function (message) {
    return message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string';
  }).map(function (message, index) {
    ensureMessageIdentity(message, index, adventureId);
    return cloneValue(message);
  });
}

function mergeConversationHistories(base, next) {
  if (!base.length) return { messages: next.slice(), overlapped: true };
  if (!next.length) return { messages: base.slice(), overlapped: true };
  const sig = function (m) { return m.id || (m.role + '\n' + m.content); };
  const limit = Math.min(base.length, next.length);
  for (let overlap = limit; overlap > 0; overlap--) {
    let same = true;
    for (let i = 0; i < overlap; i++) {
      if (sig(base[base.length - overlap + i]) !== sig(next[i])) { same = false; break; }
    }
    if (same) return { messages: base.concat(next.slice(overlap)), overlapped: true };
  }
  const seen = new Set(base.map(sig));
  const additions = next.filter(function (m) { return !seen.has(sig(m)); });
  return { messages: base.concat(additions), overlapped: additions.length === 0 };
}

function recoverExistingConversation(adventure) {
  const candidates = [];
  const snapshots = (adventure.snapshots || []).filter(function (snapshot) {
    return snapshot && snapshot.kind === 'compress' && Array.isArray(snapshot.conversationHistory);
  }).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
  for (const snapshot of snapshots) candidates.push(visibleConversation(snapshot.conversationHistory, adventure.id));
  candidates.push(visibleConversation(adventure.conversationHistory, adventure.id));
  let merged = [];
  let continuous = true;
  for (const candidate of candidates) {
    const result = mergeConversationHistories(merged, candidate);
    merged = result.messages;
    continuous = continuous && result.overlapped;
  }
  let recoveryStatus = 'complete';
  if (adventure.contextCompressed || snapshots.length) recoveryStatus = (snapshots.length && continuous) ? 'best_effort' : 'incomplete';
  return { messages: merged, recoveryStatus: recoveryStatus };
}

function archiveActiveIds(adventure) {
  return visibleConversation(adventure.conversationHistory, adventure.id).map(function (message) { return message.id; });
}

async function ensureConversationArchive(adventure) {
  if (!adventure || !adventure.id) return null;
  let meta = await idbGet(archiveMetaKey(adventure.id));
  if (meta && meta.version === CONVERSATION_ARCHIVE_VERSION) return meta;
  const recovered = recoverExistingConversation(adventure);
  const events = recovered.messages.map(function (message, index) {
    return { seq: index + 1, type: 'message.seeded', at: message.createdAt || Date.now(), line_id: adventure.currentLineId || 'main', message: message };
  });
  const chunkCount = Math.max(1, Math.ceil(events.length / CONVERSATION_ARCHIVE_CHUNK_EVENTS));
  for (let chunk = 0; chunk < chunkCount; chunk++) {
    await idbSet(archiveChunkKey(adventure.id, chunk), events.slice(chunk * CONVERSATION_ARCHIVE_CHUNK_EVENTS, (chunk + 1) * CONVERSATION_ARCHIVE_CHUNK_EVENTS));
  }
  meta = {
    version: CONVERSATION_ARCHIVE_VERSION,
    adventure_id: adventure.id,
    next_seq: events.length + 1,
    chunk_count: chunkCount,
    active_ids: events.map(function (event) { return event.message.id; }),
    recovery_status: recovered.recoveryStatus,
    seeded_at: Date.now(),
    updated_at: Date.now(),
  };
  await idbSet(archiveMetaKey(adventure.id), meta);
  return meta;
}

async function appendConversationArchiveEvent(adventure, type, payload) {
  const meta = await ensureConversationArchive(adventure);
  if (!meta) return;
  const event = Object.assign({ seq: meta.next_seq++, type: type, at: Date.now(), line_id: adventure.currentLineId || 'main' }, payload || {});
  let chunkIndex = Math.max(0, meta.chunk_count - 1);
  let chunk = await idbGet(archiveChunkKey(adventure.id, chunkIndex)) || [];
  if (chunk.length >= CONVERSATION_ARCHIVE_CHUNK_EVENTS) { chunkIndex++; chunk = []; meta.chunk_count = chunkIndex + 1; }
  chunk.push(event);
  await idbSet(archiveChunkKey(adventure.id, chunkIndex), chunk);
  if (Array.isArray(event.removed_ids)) {
    const removed = new Set(event.removed_ids);
    meta.active_ids = meta.active_ids.filter(function (id) { return !removed.has(id); });
  }
  if (event.truncate_after_id) {
    const targetIndex = meta.active_ids.indexOf(event.truncate_after_id);
    if (targetIndex >= 0) meta.active_ids = meta.active_ids.slice(0, targetIndex + 1);
  }
  if (Array.isArray(event.replace_visible_ids)) {
    const firstIndex = event.replace_visible_ids.length ? meta.active_ids.indexOf(event.replace_visible_ids[0]) : -1;
    const prefix = firstIndex > 0 ? meta.active_ids.slice(0, firstIndex) : [];
    meta.active_ids = prefix.concat(event.replace_visible_ids.filter(function (id, index, list) { return list.indexOf(id) === index; }));
  }
  if (Array.isArray(event.active_ids)) meta.active_ids = event.active_ids.slice();
  else if (event.message && event.message.id && (type === 'message.committed' || type === 'message.seeded') && meta.active_ids.indexOf(event.message.id) < 0) meta.active_ids.push(event.message.id);
  meta.updated_at = Date.now();
  await idbSet(archiveMetaKey(adventure.id), meta);
}

function queueConversationArchiveEvent(adventure, type, payload) {
  if (!adventure || !adventure.id) return conversationArchiveQueue;
  conversationArchiveQueue = conversationArchiveQueue.then(function () {
    return appendConversationArchiveEvent(adventure, type, payload);
  }).catch(function (error) {
    console.error('永久对话档案写入失败:', error);
  });
  return conversationArchiveQueue;
}

function queueConversationArchiveSeed(adventure) {
  if (!adventure || !adventure.id) return conversationArchiveQueue;
  conversationArchiveQueue = conversationArchiveQueue.then(function () { return ensureConversationArchive(adventure); })
    .catch(function (error) { console.error('永久对话档案初始化失败:', error); });
  return conversationArchiveQueue;
}

async function loadConversationArchiveBundle(adventure) {
  await queueConversationArchiveSeed(adventure);
  await conversationArchiveQueue;
  const meta = await idbGet(archiveMetaKey(adventure.id));
  const events = [];
  for (let i = 0; i < (meta.chunk_count || 0); i++) {
    const chunk = await idbGet(archiveChunkKey(adventure.id, i));
    if (Array.isArray(chunk)) events.push.apply(events, chunk);
  }
  const messages = new Map();
  for (const event of events) {
    if (event.message && event.message.id) messages.set(event.message.id, cloneValue(event.message));
    if (event.type === 'message.edited' && event.message_id && messages.has(event.message_id)) {
      messages.get(event.message_id).content = event.content;
      messages.get(event.message_id).updatedAt = event.at;
    }
  }
  const active = (meta.active_ids || []).map(function (id) { return messages.get(id); }).filter(Boolean);
  const branches = (adventure.branches || []).map(function (branch) {
    return { id: branch.id, label: branch.label || branch.id, line_id: branch.lineId || 'main', created_at: branch.createdAt || 0, messages: visibleConversation((branch.prefix || []).concat(branch.messages || []), adventure.id) };
  });
  return { version: 1, recovery_status: meta.recovery_status || 'best_effort', messages: active, events: events, branches: branches };
}

function stateToJson() {
  return JSON.stringify({
    adventures: state.adventures,
    apiConfig: state.apiConfig,
    currentId: state.currentId,
    customThemes: state.customThemes,
  });
}

function applyParsedState(parsed) {
  state.adventures = parsed.adventures || [];
  state.apiConfig = { ...state.apiConfig, ...(parsed.apiConfig || {}) };
  state.currentId = parsed.currentId || null;
  state.customThemes = parsed.customThemes || [];
  if (state.currentId && !state.adventures.some(a => a.id === state.currentId)) {
    state.currentId = null;
  }
  /* 向后兼容：归一化所有冒险的物品数据 */
  for (const adv of state.adventures) {
    if (!adv.mode) adv.mode = 'adventure';
    if (!adv.affections) adv.affections = {};
    if (!adv.relations) adv.relations = {};
    if (adv.character) adv.character.items = normalizeItems(adv.character.items);
    if (!adv.quests) adv.quests = [];
    if (!adv.combat) adv.combat = { active: false, enemies: [], round: 0 };
    if (adv.snapshots) for (const s of adv.snapshots) if (!s.kind) s.kind = 'auto';
    if (!adv.eventNodes) adv.eventNodes = [];
    if (!('aiIntro' in adv)) adv.aiIntro = null;
    if (!adv.plotNodes) adv.plotNodes = [];
    visibleConversation(adv.conversationHistory, adv.id);
  }
}

async function loadState() {
  /* 优先 IndexedDB（空间大），为空或失败时回退 localStorage */
  let parsed = null;
  let fromLocalStorage = false;
  try {
    const saved = await idbGet('state');
    if (saved) parsed = JSON.parse(saved);
  } catch (e) {
    console.error('IndexedDB 读取失败，回退 localStorage:', e);
  }
  if (!parsed) {
    fromLocalStorage = true;
    try {
      const saved = localStorage.getItem('adventureAI_state');
      if (saved) parsed = JSON.parse(saved);
    } catch (e) {
      console.error('加载状态失败，尝试备份:', e);
      try {
        const bak = localStorage.getItem('adventureAI_state_bak');
        if (bak) parsed = JSON.parse(bak);
      } catch (e2) { console.error('备份加载失败:', e2); }
    }
  }
  if (parsed) applyParsedState(parsed);
  const currentAdventure = getCurrentAdventure();
  if (currentAdventure) queueConversationArchiveSeed(currentAdventure);
  ensureProfile();  // v4 P0-3: 本地 Profile 默认值兜底（无云端）
  /* 若旧数据还在 localStorage，迁移到 IndexedDB 以使用更大的空间 */
  if (fromLocalStorage && parsed) {
    try { persistToIdb(stateToJson()); } catch (e) { /* 迁移失败不阻塞启动 */ }
  }
}

let storageWarned = false;
let idbSaveTimer = null;
let lastSaveJson = null;
const DENOVA_SYNC_URL = DENOVA_BRIDGE_BASE + '/api/denova/sync';
const adventureSyncTimers = {};
const adventureSyncInFlight = {};
const adventureSyncPending = {};
const adventureSyncFingerprints = {};

function idbFlush() {
  if (idbSaveTimer) {
    clearTimeout(idbSaveTimer);
    idbSaveTimer = null;
  }
  const payload = lastSaveJson;
  if (payload == null) return;
  lastSaveJson = null;
  idbSet('state', payload).then(function () {
    /* 备份写一份（过大则跳过，避免占用翻倍） */
    if (payload.length < 4 * 1024 * 1024) {
      return idbSet('state_bak', payload);
    }
  }).catch(function (e) {
    console.error('IndexedDB 保存失败:', e);
    if (!storageWarned) {
      storageWarned = true;
      setTimeout(function() { storageWarned = false; alert('⚠ 存储空间不足，进度可能未保存。建议导出备份或删除旧冒险/旧存档。'); }, 300);
    }
  });
}

function persistToIdb(json) {
  lastSaveJson = json;
  if (idbSaveTimer) return;
  idbSaveTimer = setTimeout(idbFlush, 300);
}

function saveState(skipDenovaSync) {
  let json;
  try {
    json = stateToJson();
  } catch (e) {
    console.error('序列化状态失败:', e);
    return;
  }
  /* IndexedDB 为主存储（空间大、防抖写入） */
  persistToIdb(json);
  /* localStorage 仅作小数据镜像；空间不足时不再警告，交给 IndexedDB */
  try {
    if (json.length < 1024 * 1024) {
      localStorage.setItem('adventureAI_state', json);
      try { localStorage.setItem('adventureAI_state_bak', json); } catch (e2) { /* 备份键失败可忽略 */ }
    } else if (json.length < 4 * 1024 * 1024) {
      localStorage.setItem('adventureAI_state', json);
      try { localStorage.removeItem('adventureAI_state_bak'); } catch (e3) { /* ignore */ }
    } else {
      try { localStorage.removeItem('adventureAI_state'); } catch (e4) { /* ignore */ }
      try { localStorage.removeItem('adventureAI_state_bak'); } catch (e5) { /* ignore */ }
    }
  } catch (e) {
    /* 配额不足：删备份腾空间后再试一次，仍失败则交给 IndexedDB */
    console.error('localStorage 镜像写入失败（IndexedDB 仍会保存）:', e);
    try { localStorage.removeItem('adventureAI_state_bak'); } catch (e6) { /* ignore */ }
    try { localStorage.setItem('adventureAI_state', json); } catch (e7) { /* ignore */ }
  }
  if (!skipDenovaSync) scheduleAdventureSync(getCurrentAdventure());
}

window.addEventListener('pagehide', function () { idbFlush(); });

async function storageHealthCheck() {
  let lsTotal = 0;
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k);
      const len = v ? v.length : 0;
      lsTotal += len;
      keys.push(k + '=' + (len / 1024).toFixed(1) + 'KB');
    }
  } catch (e) { /* ignore */ }
  let idbTotal = 0;
  try {
    const stateVal = await idbGet('state');
    const bakVal = await idbGet('state_bak');
    if (typeof stateVal === 'string') idbTotal += stateVal.length;
    if (typeof bakVal === 'string') idbTotal += bakVal.length;
  } catch (e) { /* ignore */ }
  let quotaLine = '';
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est.quota) quotaLine = '（浏览器总配额约 ' + (est.quota / 1024 / 1024 / 1024).toFixed(2) + ' GB）';
    }
  } catch (e) { /* ignore */ }
  const advs = state.adventures || [];
  let snaps = 0, branches = 0, histMsgs = 0, resumes = 0;
  for (const a of advs) {
    snaps += (a.snapshots || []).length;
    branches += (a.branches || []).length;
    histMsgs += (a.conversationHistory || []).length;
    resumes += (a.plotLines || []).filter(l => l.resume).length;
  }
  alert('存储体检\n' +
    'IndexedDB（主存档）：' + (idbTotal / 1024 / 1024).toFixed(2) + ' MB' + quotaLine + '\n' +
    'localStorage（镜像）：' + (lsTotal / 1024 / 1024).toFixed(2) + ' MB\n' +
    '冒险：' + advs.length + ' | 快照：' + snaps + ' | 分支：' + branches + ' | 剧情线存档：' + resumes + ' | 对话消息：' + histMsgs + '\n\n' +
    keys.join('\n'));
}

/* ==================== 冒险管理 ==================== */
function getCurrentAdventure() {
  return state.adventures.find(a => a.id === state.currentId);
}

function createAdventureSyncId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return 'narraverse_' + crypto.randomUUID().replace(/-/g, '');
  }
  return 'narraverse_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 14);
}

function buildAdventureSyncPayload(adv) {
  const parts = applySettingExtraction(adv.setting || '');
  const chapters = (adv.novelChapters || []).filter(function (chapter) {
    return chapter && (chapter.result || chapter.content);
  }).slice(0, 100).map(function (chapter, index) {
    return {
      title: String(chapter.title || ('第 ' + (index + 1) + ' 章')).slice(0, 120),
      content: String(chapter.result || chapter.content || '').slice(0, 500000),
    };
  });
  const cards = (adv.characterCards || []).slice(0, 50).map(function (card) {
    return {
      name: String(card.name || '角色').slice(0, 120),
      description: String(card.description || card.notes || '').slice(0, 20000),
      personality: String(card.personality || '').slice(0, 10000),
      scenario: String(card.scenario || card.relationship || '').slice(0, 10000),
      first_mes: String(card.first_mes || '').slice(0, 10000),
      tags: Array.isArray(card.tags) ? card.tags.slice(0, 20) : [],
    };
  });
  const books = (adv.backgroundBooks || []).filter(function (book) {
    return !book._denovaSyncId;
  }).slice(0, 20).map(function (book) {
    return {
      title: String(book.title || '设定书').slice(0, 120),
      content: String(book.content || '').slice(0, 200000),
    };
  });
  const recentStory = (adv.conversationHistory || []).filter(function (message) {
    return message && message.role === 'assistant';
  }).slice(-8).map(function (message) { return String(message.content || ''); }).join('\n').slice(-6000);
  const title = String(adv.title || (adv.character && adv.character.name) || '未命名冒险').slice(0, 120);
  return {
    syncId: adv.syncMeta.id,
    name: title,
    theme: String(adv.theme || '').slice(0, 120),
    turns: adv.stats && adv.stats.turns != null ? adv.stats.turns : 0,
    world: String(parts.world || adv.setting || '').slice(0, 4000),
    identity: String(parts.identity || '').slice(0, 2000),
    goal: String(parts.goal || '').slice(0, 2000),
    other: String(parts.other || '').slice(0, 2000),
    customPrompt: String(adv.customPrompt || '').slice(0, 4000),
    summary: String(adv.contextSummary || recentStory || '').slice(0, 6000),
    novel: { title: title, chapters: chapters },
    books: books,
    cards: cards,
  };
}

function scheduleAdventureSync(adv) {
  if (!adv || !adv.syncMeta || !adv.syncMeta.enabled || !adv.syncMeta.id) return;
  if (adventureSyncInFlight[adv.id]) {
    adventureSyncPending[adv.id] = true;
    return;
  }
  clearTimeout(adventureSyncTimers[adv.id]);
  adventureSyncTimers[adv.id] = setTimeout(function () { pushAdventureSync(adv); }, 1200);
}

async function pushAdventureSync(adv) {
  if (!adv || !adv.syncMeta || adventureSyncInFlight[adv.id]) return;
  const payload = buildAdventureSyncPayload(adv);
  const fingerprint = JSON.stringify(payload);
  if (adventureSyncFingerprints[adv.id] === fingerprint && adv.syncMeta.status === 'synced') return;
  adventureSyncInFlight[adv.id] = true;
  adv.syncMeta.status = 'syncing';
  adv.syncMeta.error = '';
  saveState(true);
  try {
    const response = await fetch(DENOVA_SYNC_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: fingerprint,
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || ('HTTP ' + response.status));
    adventureSyncFingerprints[adv.id] = fingerprint;
    adv.syncMeta.projectName = result.projectName || adv.syncMeta.projectName || '';
    adv.syncMeta.lastPushAt = new Date().toISOString();
    adv.syncMeta.lastRemoteRevision = result.revision || '';
    adv.syncMeta.status = 'synced';
    adv.syncMeta.error = '';
    saveState(true);
  } catch (error) {
    adv.syncMeta.status = 'error';
    adv.syncMeta.error = String((error && error.message) || error || '同步失败');
    saveState(true);
  } finally {
    adventureSyncInFlight[adv.id] = false;
    if (adventureSyncPending[adv.id]) {
      adventureSyncPending[adv.id] = false;
      scheduleAdventureSync(adv);
    }
  }
}

function applyDenovaSyncResult(adv, result) {
  const shared = result.shared || {};
  if (shared.name) adv.title = String(shared.name);
  adv.setting = [
    shared.world ? '世界背景：' + shared.world : '',
    shared.identity ? '玩家身份：' + shared.identity : '',
    shared.goal ? '初始目标：' + shared.goal : '',
    shared.other ? '其他说明：' + shared.other : '',
  ].filter(Boolean).join('\n');
  if (shared.customPrompt != null) adv.customPrompt = String(shared.customPrompt);
  if (shared.summary != null) adv.contextSummary = String(shared.summary);
  if (shared.loreBook) {
    const index = adv.backgroundBooks.findIndex(function (book) { return book._denovaSyncId === adv.syncMeta.id; });
    if (index >= 0) adv.backgroundBooks[index] = shared.loreBook;
    else adv.backgroundBooks.push(shared.loreBook);
  }
  if (Array.isArray(shared.chapters)) {
    adv.novelChapters = shared.chapters.map(function (chapter) {
      return { title: chapter.title || '章节', result: chapter.content || '', status: 'done' };
    });
  }
  adv.syncMeta.projectName = result.projectName || adv.syncMeta.projectName || '';
  adv.syncMeta.lastPullAt = new Date().toISOString();
  adv.syncMeta.lastRemoteRevision = result.revision || '';
  adv.syncMeta.status = 'synced';
  adv.syncMeta.error = '';
  updateSystemPrompt(adv);
  saveState(true);
  if (adv.id === state.currentId) renderAll();
}

async function pullAdventureSync(adv) {
  if (!adv || !adv.syncMeta || !adv.syncMeta.enabled || !adv.syncMeta.id) return;
  try {
    const response = await fetch(DENOVA_SYNC_URL + '?id=' + encodeURIComponent(adv.syncMeta.id));
    if (response.status === 404) { scheduleAdventureSync(adv); return; }
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || ('HTTP ' + response.status));
    if (result.revision && result.revision === adv.syncMeta.lastRemoteRevision) return;
    applyDenovaSyncResult(adv, result);
  } catch (error) {
    adv.syncMeta.status = 'error';
    adv.syncMeta.error = String((error && error.message) || error || '同步失败');
    saveState(true);
  }
}

function pullCurrentAdventureSync() {
  return pullAdventureSync(getCurrentAdventure());
}

function createAdventure(theme, name, setting, professionName, opts) {
  opts = opts || {};
  const td = opts.themeData || themeData[theme] || themeData['奇幻'];
  const profList = opts.professionData || professionData[theme] || [];
  const prof = opts.profession || profList.find(p => p.name === professionName) || profList[0];

  const adventure = {
    id: 'adv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    title: '',
    theme: opts.themeKey || theme,
    setting: setting || '',
    customTheme: opts.themeData || null,
    mode: opts.mode === 'tavern' ? 'tavern' : 'adventure',
    affections: {},
    relations: {},
    character: {
      name: name || '冒险者',
      profession: prof ? prof.name : '冒险者',
      hp: 100, maxHp: 100,
      mp: 50, maxMp: 50,
      items: normalizeItems(JSON.parse(JSON.stringify(td.items))),
      location: td.location,
      chapter: '序章',
      mood: '平静',
      level: 1, exp: 0, maxExp: 100,
      attributes: prof ? { ...prof.attrs } : { 力量:10, 敏捷:10, 智力:10, 魅力:10, 幸运:10 },
      attributePoints: 5,
      skills: prof ? prof.skills.map(s => ({ ...s })) : [],
      skillPoints: 1,
    },
    conversationHistory: [
      { role: 'system', content: '' },
    ],
    contextSummary: null,
    contextCompressed: false,
    plotNodes: [],
    eventNodes: [],
    aiIntro: null,
    plotLines: [{ id: 'main', label: '主线', isMain: true, fromNodeId: null, nodeIds: [], resume: null, createdAt: Date.now() }],
    currentLineId: 'main',
    customPrompt: '',
    characterCards: [],
    backgroundBooks: [],
    mandalaCards: [],
    snapshots: [],
    branches: [],
    quests: [],
    combat: { active: false, enemies: [], round: 0 },
    /* P3 写作工程化：大纲/细纲 + 版本账本 */
    novelPlan: null,
    versionLedger: [],
    syncMeta: { id: createAdventureSyncId(), enabled: true, projectName: '', lastPushAt: '', lastPullAt: '', lastRemoteRevision: '', status: 'pending', error: '' },
    stats: { turns: 0, deaths: 0, startedAt: Date.now() },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  adventure.initialCharacter = JSON.parse(JSON.stringify(adventure.character));
  adventure.conversationHistory[0].content = buildSystemPrompt(adventure);
  state.adventures.unshift(adventure);
  state.currentId = adventure.id;
  queueConversationArchiveSeed(adventure);
  saveState();
  return adventure;
}

function loadAdventure(id) {
  state.currentId = id;
  saveState();
  closeMobileSidebar();
  const adv = getCurrentAdventure();
  if (adv) {
    queueConversationArchiveSeed(adv);
    renderAll();
    document.getElementById('inputArea').style.display = 'flex';
    document.getElementById('emptyState')?.remove();
    document.getElementById('headerActions').style.display = 'flex';
    pullAdventureSync(adv);
  }
  /* 进入冒险后：仅在「尚无介绍 + 已有压缩上下文」时自动生成一次（省算力） */
  maybeGenerateAdventureIntro(adv);
}

function deleteAdventure(id) {
  state.adventures = state.adventures.filter(a => a.id !== id);
  if (state.currentId === id) state.currentId = null;
  saveState();
  renderAdventureList();
  if (!state.currentId) {
    document.getElementById('storyArea').innerHTML = emptyStateHtml();
    document.getElementById('inputArea').style.display = 'none';
    document.getElementById('headerActions').style.display = 'none';
    resetMainUI();
  }
}

function resetMainUI() {
  document.getElementById('adventureTitle').textContent = '尚未开始冒险';
  document.getElementById('sceneTag').textContent = '';
  document.getElementById('charName').textContent = '—';
  document.getElementById('charProfession').textContent = '';
  document.getElementById('charProfession').style.display = 'none';
  document.getElementById('charMoodWrap').style.display = 'none';
  document.getElementById('charLevelWrap').style.display = 'flex';
  document.getElementById('charLevel').textContent = 'Lv.1';
  document.getElementById('expBar').style.width = '0%';
  document.getElementById('expText').textContent = '0/100';
  document.getElementById('hpBar').style.width = '0%';
  document.getElementById('hpValue').textContent = '0/0';
  document.getElementById('mpBar').style.width = '0%';
  document.getElementById('mpValue').textContent = '0/0';
  document.getElementById('charLocation').textContent = '—';
  document.getElementById('charChapter').textContent = '—';
  document.getElementById('attributesSection').style.display = 'none';
  document.getElementById('skillsSection').style.display = 'none';
  document.getElementById('inventory').innerHTML = '<div class="empty-text">空空如也</div>';
  document.getElementById('contextBar').style.width = '0%';
  document.getElementById('contextText').textContent = '0 tokens';
  document.getElementById('contextStatus').textContent = '等待开始...';
  document.getElementById('contextMeta').innerHTML = '';
  /* 隐藏战斗和任务面板 */
  var combatSec = document.getElementById('combatSection');
  var questsSec = document.getElementById('questsSection');
  var combatBar = document.getElementById('combatActionBar');
  if (combatSec) combatSec.style.display = 'none';
  if (questsSec) questsSec.style.display = 'none';
  if (combatBar) combatBar.style.display = 'none';
}

/* ==================== 冒险编辑 / 删除 ==================== */
let editingAdventureId = null;

function showEditAdventureModal(id) {
  const adv = state.adventures.find(a => a.id === id);
  if (!adv) return;
  editingAdventureId = id;
  document.getElementById('editAdventureTitle').value = adv.title || '';
  document.getElementById('editCharacterName').value = adv.character ? adv.character.name : '';
  document.getElementById('editAdventureSetting').value = adv.setting || '';
  document.getElementById('editCompactState').checked = !!(adv.compactState);
  showModal('editAdventureModal');
}

function saveEditAdventure() {
  const adv = state.adventures.find(a => a.id === editingAdventureId);
  if (!adv) { closeModal('editAdventureModal'); editingAdventureId = null; return; }
  const title = document.getElementById('editAdventureTitle').value.trim();
  const charName = document.getElementById('editCharacterName').value.trim();
  const setting = document.getElementById('editAdventureSetting').value.trim();
  if (title) adv.title = title;
  if (charName && adv.character) adv.character.name = charName;
  adv.setting = setting;
  adv.compactState = document.getElementById('editCompactState').checked;
  updateSystemPrompt(adv);
  adv.updatedAt = Date.now();
  saveState();
  editingAdventureId = null;
  closeModal('editAdventureModal');
  renderAll();
  renderAdventureList();
}

function deleteAdventureWithConfirm(id) {
  const adv = state.adventures.find(a => a.id === id);
  if (!adv) return;
  const displayName = adv.title || (adv.character ? adv.character.name : adv.theme);
  if (!confirm('确定删除冒险「' + displayName + '」？该冒险的存档、剧情线等全部数据将一起删除，且无法恢复。')) return;
  deleteAdventure(id);
}

/* ==================== System Prompt 构建 ==================== */
const SECTION_CARDS = '## 角色卡（NPC 设定）';
const SECTION_BOOKS = '## 设定书';
const SECTION_STATUS = '## 当前角色状态（实时追踪 — 每轮自动更新）';

/* 人物曼陀罗九宫格字段 */
const MANDALA_FIELDS = [
  { key: 'identity', label: '身份' },
  { key: 'desire', label: '欲望' },
  { key: 'goal', label: '目标' },
  { key: 'action', label: '行动' },
  { key: 'background', label: '背景' },
  { key: 'resource', label: '资源' },
  { key: 'relation', label: '关系' },
  { key: 'personality', label: '性格' },
];
const MANDALA_LABEL_TO_KEY = (function() {
  const map = { 名字: 'name' };
  for (const f of MANDALA_FIELDS) map[f.label] = f.key;
  return map;
})();

function buildCharacterCardsBlock(adventure) {
  let s = '';
  if (adventure.characterCards && adventure.characterCards.length > 0) {
    s += '## 角色卡（NPC 设定）\n';
    for (const card of adventure.characterCards) {
      s += '【' + card.name + '】';
      if (card.appearance) s += ' 外貌：' + card.appearance;
      if (card.personality) s += ' | 性格：' + card.personality;
      if (card.relationship) s += ' | 与玩家关系：' + card.relationship;
      if (card.tags && card.tags.length) s += ' | 标签：' + card.tags.join('、');
      if (card.scenario) s += ' | 场景：' + card.scenario;
      if (card.notes) s += ' | 备注：' + card.notes;
      if (card.character_note) s += ' | 核心约束：' + card.character_note;
      s += '\n';
      const altCount = (card.alternate_greetings && card.alternate_greetings.length) || 0;
      if (card.first_mes) s += '  默认开场：' + String(card.first_mes).replace(/\s*\n\s*/g, ' ').substring(0, 300) + '\n';
      if (altCount) s += '  多开局：' + altCount + ' 个备选开场（开局时由玩家选择）\n';
    }
    s += '\n';
  }
  return s;
}

/* 分组 NPC 同场：列出当前在场角色及其话痨度，给出群像对话/插话指令（借鉴 SillyTavern group chat） */
function buildActiveSceneBlock(adventure) {
  const present = (adventure.characterCards || []).filter(c => c.present !== false);
  if (present.length === 0) return '';
  const lines = present.map(c => {
    const t = (typeof c.talkativeness === 'number') ? c.talkativeness : 50;
    let s = '【' + c.name + '】（话痨度 ' + t + '/100';
    if (c.personality) s += '，性格：' + c.personality;
    s += '）';
    return s;
  });
  if (present.length === 1) {
    /* 单 NPC 场景不注入群像规则，避免无效指令噪音 */
    return '## 当前在场角色\n' + lines.join('\n') +
      '\n\n规则：该角色当前与你同处一个场景，保持人设一致、自然互动。\n\n';
  }
  return '## 当前在场角色（可多 NPC 同场，群像互动）\n' +
    lines.join('\n') +
    '\n\n规则：\n' +
    '1. 以上角色当前与你同处一个场景，可同时互动、彼此对话，不必一次只服务一个 NPC。\n' +
    '2. 话痨度越高的角色越主动插话、发起话题；话痨度低的角色多保持沉默，仅在剧情需要时回应。\n' +
    '3. 用不同角色的口吻与视角分别书写对话，保持人设一致；NPC 之间也可自然互动。\n' +
    '4. 玩家对每个角色的回应可分别影响各自的好感度与关系。\n\n';
}

/* 分组 NPC 同场：切换某角色是否在场 / 调整话痨度，并刷新系统提示词 */
function setNpcPresent(name, present) {
  const adv = getCurrentAdventure();
  if (!adv) return;
  const card = (adv.characterCards || []).find(c => c.name === name);
  if (!card) return;
  card.present = !!present;
  updateSystemPrompt(adv);
  saveState();
  renderCharacterPanel();
}
function setNpcTalkativeness(name, val) {
  const adv = getCurrentAdventure();
  if (!adv) return;
  const card = (adv.characterCards || []).find(c => c.name === name);
  if (!card) return;
  const t = Math.max(0, Math.min(100, parseInt(val, 10) || 0));
  card.talkativeness = t;
  updateSystemPrompt(adv);
  saveState();
  renderCharacterPanel();
}

/* （已移除 useExtension：扩展特性现直接内嵌于对话框，不再走独立「扩展工具」弹窗） */

/* 角色卡 V3：system_prompt（专属系统指令，借鉴 SillyTavern Character V3） */
function buildCardSystemDirectives(adventure) {
  const cards = adventure.characterCards || [];
  const parts = [];
  for (const card of cards) {
    const sp = (card.system_prompt && String(card.system_prompt).trim()) || '';
    if (sp) parts.push('### ' + card.name + ' 的专属系统指令\n' + sp);
  }
  if (!parts.length) return '';
  return '## 角色专属系统指令（来自角色卡 V3 · system_prompt）\n' + parts.join('\n\n') + '\n\n';
}

/* 角色卡 V3：post_history_instructions（结尾指令，置于提示词最后）+ character_note @depth 重注入 */
function buildPostHistoryTail(adventure) {
  const cards = adventure.characterCards || [];
  const lines = [];
  for (const card of cards) {
    const phi = (card.post_history_instructions && String(card.post_history_instructions).trim()) || '';
    if (phi) lines.push('【' + card.name + ' · 结尾指令】' + phi);
  }
  if (adventure.postHistoryInstructions && String(adventure.postHistoryInstructions).trim()) {
    lines.push('【全局结尾指令】' + String(adventure.postHistoryInstructions).trim());
  }
  // character_note @depth：长对话时在尾部再次强调核心约束
  const hist = adventure.conversationHistory || [];
  const nonSys = hist.filter(m => (m.role || '') !== 'system').length;
  for (const card of cards) {
    const note = (card.character_note && String(card.character_note).trim()) || '';
    if (!note) continue;
    const depth = (typeof card.note_depth === 'number' && card.note_depth > 0) ? card.note_depth : 0;
    if (depth > 0 && nonSys >= depth) {
      lines.push('【' + card.name + ' · 核心约束（再次提醒）】' + note);
    }
  }
  if (!lines.length) return '';
  return '\n## 结尾指令（post_history_instructions，始终遵守，置于最后）\n' + lines.join('\n') + '\n';
}

/* ==================== 提示词模板化 + 宏变量（借鉴 SillyTavern Prompt Manager） ====================
 * 在 buildSystemPrompt / buildTavernSystemPrompt 末尾对整段提示词做宏替换；
 * 用户可在「自定义规则 / 角色卡 system_prompt / post_history_instructions / character_note」
 * 中书写 {{user}}、{{location}} 等变量，每轮随剧情状态自动刷新。 */
const PROMPT_MACRO_LIST = [
  { token: 'char', desc: '主角/玩家名字' },
  { token: 'user', desc: '玩家名字（同 char）' },
  { token: 'player', desc: '玩家名字（同 char）' },
  { token: 'location', desc: '当前位置/场景' },
  { token: 'chapter', desc: '当前章节' },
  { token: 'level', desc: '当前等级（如 Lv.2）' },
  { token: 'profession', desc: '职业' },
  { token: 'theme', desc: '主题' },
  { token: 'hp', desc: '当前 HP（如 80/100）' },
  { token: 'mp', desc: '当前 MP（如 50/50）' },
  { token: 'mood', desc: '当前情绪' },
  { token: 'date', desc: '当前日期（YYYY-MM-DD）' },
  { token: 'time', desc: '当前时间（HH:MM）' },
  { token: 'random', desc: '随机串（每轮不同）' },
];

function resolvePromptMacros(text, adventure) {
  if (!text || typeof text !== 'string') return text;
  const cfg = (state && state.apiConfig) || {};
  if (cfg.macroEnabled === false) return text;
  const c = (adventure && adventure.character) || {};
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const ctx = {
    char: c.name || '',
    user: c.name || '',
    player: c.name || '',
    location: c.location || '未知',
    chapter: c.chapter || '序章',
    level: 'Lv.' + (c.level != null ? c.level : 1),
    profession: c.profession || '',
    theme: (adventure && adventure.theme) || '',
    hp: (c.hp != null ? c.hp : '') + '/' + (c.maxHp != null ? c.maxHp : ''),
    mp: (c.mp != null ? c.mp : '') + '/' + (c.maxMp != null ? c.maxMp : ''),
    mood: c.mood || '平静',
    date: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()),
    time: pad(now.getHours()) + ':' + pad(now.getMinutes()),
    random: Math.random().toString(16).slice(2, 6),
  };
  return text.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (m, key) => {
    const k = key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ctx, k)) {
      const v = ctx[k];
      return (v == null ? '' : String(v));
    }
    return m; // 未知宏原样保留，避免误删用户内容
  });
}

/* ==================== 扩展生态（对话框内特性，借鉴 SillyTavern 扩展生态思路） ====================
 * 两个特性直接作用于「对话框内」的每条 AI 叙事，无需单独弹窗：
 *  - 🔊 TTS 朗读：设置中开启后，AI 叙事气泡内出现「朗读」键，用浏览器原生 speechSynthesis 朗读（无需 API Key）。
 *  - 🖼 AI 生图：每条 AI 叙事内「生成场景图」键（已有 generateSceneImage 实现，需场景配图 API Key）。
 * 已删除「翻译 / 联网检索」：纯脚手架占位、无任何实现与配置项、无特性，徒增误解。
 * 采用「注册表 + 运行时开关」管理特性开关（默认关），新增对话框内特性只需在 EXTENSION_DEFAULTS 加条目。 */
const EXTENSIONS = {};
const EXTENSION_DEFAULTS = {
  tts: { label: '语音朗读 (TTS)', desc: '在每条 AI 叙事气泡内提供朗读键，浏览器原生语音合成' },
};
function registerExtension(name, def) {
  const cfg = (state && state.apiConfig && state.apiConfig.extensions) || {};
  const enabled = cfg[name] === true;
  EXTENSIONS[name] = Object.assign({ name: name, enabled: enabled, run: null }, def || {});
  return EXTENSIONS[name];
}
function setExtensionEnabled(name, enabled) {
  if (!EXTENSIONS[name]) return;
  EXTENSIONS[name].enabled = !!enabled;
  if (state && state.apiConfig) {
    state.apiConfig.extensions = state.apiConfig.extensions || {};
    state.apiConfig.extensions[name] = !!enabled;
  }
}
/* 默认注册对话框内特性；run 留空，特性由各自的 UI 控件（如朗读键）直接驱动。 */
Object.keys(EXTENSION_DEFAULTS).forEach(k => {
  registerExtension(k, Object.assign({}, EXTENSION_DEFAULTS[k], { run: null }));
});

/* ---------- TTS 朗读（对话框内，可点停） ---------- */
var ttsSpeakingIndex = -1;     // 当前正在朗读的叙事下标；点同一则停止
var ttsCosyVoiceWs = null;     // 当前 CosyVoice WebSocket
var ttsCosyVoiceAudio = null;  // 当前 CosyVoice 播放的 Audio 元素

function ttsExtractText(index) {
  const adv = getCurrentAdventure();
  if (!adv) return null;
  const msg = adv.conversationHistory[index];
  if (!msg || msg.role !== 'assistant') return null;
  const parsed = parseGameResponse(msg.content);
  const text = (parsed.narrative || '').replace(/[#*_`>~]/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

/* 停止一切朗读（原生 / CosyVoice 两种引擎都覆盖） */
function stopTts() {
  if (ttsCosyVoiceWs) { try { ttsCosyVoiceWs.close(); } catch (_) {} ttsCosyVoiceWs = null; }
  if (ttsCosyVoiceAudio) { try { ttsCosyVoiceAudio.pause(); } catch (_) {} ttsCosyVoiceAudio = null; }
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) {}
  ttsSpeakingIndex = -1;
  try { renderStory(); } catch (_) {}
}

/* 朗读键入口：同一条正在读 → 停止；否则开始（按设置选择引擎） */
function readNarrativeAloud(index) {
  const text = ttsExtractText(index);
  if (text == null) return;
  if (ttsSpeakingIndex === index) { stopTts(); return; }   // 再点一次 = 停止
  if (ttsSpeakingIndex !== -1) stopTts();                  // 先停掉上一条
  const cfg = state.apiConfig || {};
  if (cfg.ttsEngine === 'cosyvoice' && (cfg.cosyvoiceEndpoint || '').trim() && (cfg.cosyvoiceApiKey || '').trim()) {
    startCosyVoiceTts(text, index);
  } else {
    startNativeTts(text, index);
  }
}

/* 浏览器原生 SpeechSynthesis（无需 Key） */
function startNativeTts(text, index) {
  if (!('speechSynthesis' in window)) { alert('当前浏览器不支持语音朗读（Web Speech API）。可在设置切换到 CosyVoice 引擎。'); return; }
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN'; u.rate = 1; u.pitch = 1;
    u.onend = function () { if (ttsSpeakingIndex === index) { ttsSpeakingIndex = -1; try { renderStory(); } catch (_) {} } };
    u.onerror = function () { if (ttsSpeakingIndex === index) { ttsSpeakingIndex = -1; try { renderStory(); } catch (_) {} } };
    ttsSpeakingIndex = index;
    window.speechSynthesis.speak(u);
    try { renderStory(); } catch (_) {}
  } catch (e) {
    console.warn('[TTS] 朗读失败：' + (e && e.message));
  }
}

/* CosyVoice（阿里云百炼，WebSocket-only）。
 * 浏览器 WebSocket 无法设置 Authorization 握手头，maas 直连必 401；故提供「本地中继」模式（tools/cosyvoice_proxy.py 代注 Authorization 头）。
 * 留空中继且端点支持 ?token= 鉴权时，也可直接连端点并拼 ?token=。音频帧收集后在连接关闭时一次性播放。 */
function startCosyVoiceTts(text, index) {
  const cfg = state.apiConfig || {};
  const relay = (cfg.cosyvoiceRelay || '').trim();
  const endpoint = (cfg.cosyvoiceEndpoint || '').trim();
  const apiKey = (cfg.cosyvoiceApiKey || '').trim();
  const voice = (cfg.cosyvoiceVoice || 'longanyang').trim();
  /* 浏览器 WebSocket 无法设置 Authorization 握手头，故 maas 直连必 401。
   * 两种可用路径：①填「本地中继」→ 浏览器连中继（中继代为注入 Authorization 头，见 tools/cosyvoice_proxy.py）；
   * ②留空中继且端点服务支持 ?token= 鉴权（部分封装服务）→ 直接连端点并拼 ?token=。两者皆无则回退原生。 */
  if (!relay && (!endpoint || !apiKey)) { console.warn('[CosyVoice] 未配置中继也未配置端点/Key，回退浏览器原生 TTS'); startNativeTts(text, index); return; }
  try {
    const url = relay ? relay : (endpoint + (endpoint.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(apiKey));
    const ws = new WebSocket(url);
    ttsCosyVoiceWs = ws;
    const audioChunks = [];
    ws.binaryType = 'arraybuffer';
    const taskId = 'task-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    ws.onopen = function () {
      ws.send(JSON.stringify({
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: 'cosyvoice-v3-flash',
          parameters: { text_type: 'PlainText', voice: voice, format: 'mp3', sample_rate: 22050, volume: 50, rate: 1, pitch: 1 },
          input: {}
        }
      }));
    };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') {
        let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
        const action = msg.header && msg.header.action;
        if (action === 'task-started') {
          ws.send(JSON.stringify({ header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' }, payload: { input: { text: text } } }));
          ws.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }));
        } else if (action === 'task-failed') {
          console.warn('[CosyVoice] 任务失败：' + ev.data);
          try { ws.close(); } catch (_) {}
          startNativeTts(text, index);
        }
        return;
      }
      audioChunks.push(ev.data); // binary 音频帧
    };
    ws.onerror = function () { console.warn('[CosyVoice] WebSocket 错误，回退原生 TTS'); try { ws.close(); } catch (_) {} ttsCosyVoiceWs = null; startNativeTts(text, index); };
    ws.onclose = function () {
      ttsCosyVoiceWs = null;
      if (audioChunks.length > 0 && ttsSpeakingIndex === index) {
        const blob = new Blob(audioChunks, { type: 'audio/mpeg' });
        const objUrl = URL.createObjectURL(blob);
        const audio = new Audio(objUrl);
        ttsCosyVoiceAudio = audio;
        audio.onended = function () { try { URL.revokeObjectURL(objUrl); } catch (_) {} ttsSpeakingIndex = -1; try { renderStory(); } catch (_) {} };
        audio.play().catch(function (err) { console.warn('[CosyVoice] 播放失败', err); ttsSpeakingIndex = -1; try { renderStory(); } catch (_) {} });
      } else if (ttsSpeakingIndex === index) {
        ttsSpeakingIndex = -1; try { renderStory(); } catch (_) {}
      }
    };
    ttsSpeakingIndex = index;
    try { renderStory(); } catch (_) {}
  } catch (e) {
    console.warn('[CosyVoice] 启动失败，回退原生 TTS', e);
    startNativeTts(text, index);
  }
}

function buildPlotLineBlock(adventure) {
  let s = '';
  if (adventure.plotNodes && adventure.plotNodes.length > 0) {
    const curLine = (adventure.plotLines || []).find(l => l.id === adventure.currentLineId) || null;
    const lineLabel = curLine ? curLine.label : '主线';
    const curNode = lineLastNode(adventure, adventure.currentLineId);
    s += '## 当前剧情线\n';
    s += '当前线：' + lineLabel + '\n';
    if (curNode) s += '当前节点：' + curNode.title + (curNode.summary ? ' — ' + curNode.summary.substring(0, 120) : '') + '\n';
    s += '\n';
  }
  return s;
}

/* ==================== 设定书按需注入（World Info 化，借鉴 SillyTavern） ==================== */
function parseBookEntries(book) {
  /* 缓存解析结果：同一本书内容不变时不重复全量正则扫描（每轮构建提示词都会调用） */
  if (book && book._loreParsed && book._loreParsed._len === (book.content || '').length) {
    const _p = book._loreParsed;
    /* 反序列化后 RegExp 会退化为空对象({}),test 不再是函数 ——
       从 low 重建,恢复精确匹配与缓存性能(否则每次都重扫全量正则) */
    for (const _e of (_p.entries || [])) {
      for (const _mt of (_e.matchers || [])) {
        if (_mt.latin && _mt.re && typeof _mt.re.test !== 'function') {
          try { _mt.re = new RegExp('\\b' + String(_mt.low || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'); }
          catch (_err) { _mt.re = null; }
        }
      }
    }
    return _p;
  }
  const text = book.content || '';
  const entries = [];
  const re = /【([^】]+)】([\s\S]*?)(?=【|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const keys = m[1].split(/[、,，]/).map(s => s.trim()).filter(s => s.length >= 2);
    const c = m[2].trim();
    if (c && keys.length) {
      /* 拉丁关键词用词边界匹配，避免 "run" 命中 "running"、"mana" 命中 "woman" 等误报 */
      const matchers = keys.map(k => {
        if (/^[A-Za-z0-9_.-]+$/.test(k)) {
          let re = null;
          try {
            re = new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
          } catch (e) { re = null; }
          return { latin: true, re: re, low: k.toLowerCase() };
        }
        return { latin: false, low: k.toLowerCase() };
      });
      entries.push({ keys: keys, matchers: matchers, content: c, order: entries.length });
    }
  }
  const firstIdx = text.indexOf('【');
  const preamble = firstIdx > 0 ? text.slice(0, firstIdx).trim() : '';
  const parsed = { entries: entries, preamble: preamble };
  parsed._len = text.length;
  try { if (book) book._loreParsed = parsed; } catch (e) { /* 只读对象忽略缓存 */ }
  return parsed;
}

function buildLorebookBlock(adventure) {
  const books = adventure.backgroundBooks || [];
  if (!books.length) return '';
  const cfg = (state && state.apiConfig) || {};
  const scanDepth = cfg.loreScanDepth && cfg.loreScanDepth > 0 ? cfg.loreScanDepth : 14;
  const budgetPct = (cfg.loreBudgetPct != null && cfg.loreBudgetPct >= 0) ? cfg.loreBudgetPct : 30;
  const maxCtx = cfg.maxTokens || 8000;
  const budget = Math.max(200, Math.floor(maxCtx * budgetPct / 100));

  const hist = adventure.conversationHistory || [];
  /* 只扫描剧情消息：跳过系统提示词本体，但保留【前情摘要】等剧情性系统消息，
     避免压缩后关键词丢失导致设定无法按需命中。从后往前收集到 scanDepth 条。 */
  const parts = [];
  for (let i = hist.length - 1; i >= 0 && parts.length < scanDepth; i--) {
    const m = hist[i];
    const role = m.role || '';
    const c = (m.content || '');
    if (!c) continue;
    if (role === 'system') {
      if (c.indexOf('【前情摘要】') !== 0 && c.indexOf('【旧对话摘要】') !== 0) continue;
    }
    parts.push(c);
  }
  const recent = parts.join('\n');
  const recentLower = (recent || '').toLowerCase();

  let used = 0, matched = 0, total = 0;
  const out = [];
  for (const book of books) {
    const constParts = [];
    if (book.summary) constParts.push(book.summary);
    const parsed = parseBookEntries(book);
    total += parsed.entries.length;
    if (parsed.preamble) constParts.push(parsed.preamble.slice(0, 220));
    const constStr = constParts.join('\n');
    if (constStr) {
      const t = estimateTokens(constStr);
      if (used + t <= budget) { out.push('### ' + book.title + '（概览）\n' + constStr); used += t; }
    }
    for (const e of parsed.entries) {
      const hit = e.matchers.some(mt => {
        if (mt.latin) return (mt.re && typeof mt.re.test === 'function') ? mt.re.test(recent) : recentLower.indexOf(mt.low) !== -1;
        return mt.low && recentLower.indexOf(mt.low) !== -1;
      });
      if (!hit) continue;
      const t = estimateTokens(e.content);
      if (used + t > budget) continue;
      out.push('### ' + book.title + ' · ' + e.keys.join('/') + '\n' + e.content);
      used += t; matched++;
    }
  }
  if (!out.length) return '';
  return '## 设定书（按需注入 · 命中 ' + matched + '/' + total + ' 条，预算 ' + budget + ' tokens）\n' + out.join('\n\n') + '\n\n';
}

function buildTavernSystemPrompt(adventure, c, td) {
  let prompt = `你是「酒馆故事」——一个沉浸式角色扮演（文字对话/剧情）AI。你负责扮演角色、推动剧情、维护人设与人物关系，侧重对话与心理互动；默认不涉及属性、数值战斗或骰子检定。

## 世界设定
主题：${adventure.theme}
背景：${td.desc || '自由剧情'}
${adventure.setting ? '玩家设定：' + adventure.setting : ''}

`;

  prompt += buildCharacterCardsBlock(adventure);

  /* 分组 NPC 同场（在场角色 + 话痨度 + 群像群聊指令） */
  prompt += buildActiveSceneBlock(adventure);

  /* 角色卡 V3 专属系统指令（system_prompt） */
  prompt += buildCardSystemDirectives(adventure);

  /* 设定书按需注入（World Info 化） */
  prompt += buildLorebookBlock(adventure);

  /* 自定义规则 */
  if (adventure.customPrompt) {
    prompt += '## 玩家自定义规则\n' + adventure.customPrompt + '\n\n';
  }

  prompt += buildPlotLineBlock(adventure);

  /* 人物状态：场景 / 情绪 / 好感度 / 关系 */
  prompt += '## 人物状态（实时追踪 — 每轮自动更新）\n';
  prompt += '玩家：' + c.name + '\n';
  prompt += '场景：' + (c.location || '未知') + '\n';
  prompt += '情绪：' + (c.mood || '平静') + '\n';
  const affs = (adventure.affections || {});
  const affNames = Object.keys(affs);
  prompt += '好感度（0-100，默认50）：' + (affNames.length ? affNames.map(n => n + '=' + affs[n]).join('、') : '暂无') + '\n';
  const rels = (adventure.relations || {});
  const relNames = Object.keys(rels);
  if (relNames.length) prompt += '关系变化：' + relNames.map(n => n + '：' + rels[n]).join('；') + '\n';

  /* 已知人物（曼陀罗） */
  if (adventure.mandalaCards && adventure.mandalaCards.length > 0) {
    const knownLines = [];
    for (const card of adventure.mandalaCards) {
      const parts = [];
      for (const f of MANDALA_FIELDS) {
        if (card[f.key]) parts.push(f.label + '=' + card[f.key]);
      }
      if (parts.length > 0) knownLines.push(card.name + ' | ' + parts.join(' | '));
    }
    if (knownLines.length > 0) {
      prompt += '已知人物（仅展示玩家已了解的信息，未知的不写）：\n' + knownLines.join('\n') + '\n\n';
    }
  }

  prompt += `
## 回复格式（严格遵守，只输出以下区块，不要添加任何其他内容）

[NARRATIVE]
（150-350字，以对话、神态、心理和动作细节推进剧情，体现角色性格与关系，第二人称或当前视角）

[STATE]
情绪: 当前情绪
场景: 当前场景
好感度: 角色名=数值, 角色名=数值

[CHANGES]
（每行一个变化，无变化则只写"无"）
MOOD | 新情绪 | 原因
AFF +5 | 角色名 | 原因
AFF -5 | 角色名 | 原因
RELATION | 角色名 | 关系变化描述

[CHOICES]
1. 第一个选项
2. 第二个选项
3. 第三个选项

[QUESTS]
（每行一条任务更新，无更新则写"无"）
QUEST_NEW | 任务名 | 描述
QUEST_UPDATE | 任务名 | 进行中 | 进展描述
QUEST_COMPLETE | 任务名
QUEST_FAIL | 任务名

[CHARACTERS]
（每行一条：新登场角色或已知角色信息更新；无更新则写"无"）
角色名 | 身份=... | 欲望=... | 目标=... | 行动=... | 背景=... | 资源=... | 关系=... | 性格=...
玩家尚未了解的信息保持"未知"，不要编造

[PLOT]
（可选区块：剧情出现明显节点时输出；平时整块省略。每行一条）
NODE_NEW | 标题(6-12字) | 章节 | 摘要 | 地点 | 涉及人物(逗号分隔)
NODE_DONE | 节点标题
NODE_FAIL | 节点标题

## 规则
1. 对话驱动：以角色对话、神态、心理和互动推进剧情，避免大段说教
2. 人设一致：严格遵循角色卡与设定书，不 OOC；情绪随剧情自然变化
3. 关系推进：关注角色间关系与好感度变化，重要变化写入 [CHANGES] 与 [STATE]
4. 好感度规则：初始 50，范围 0-100；重大事件 ±5~15，普通互动 ±1~3，每次变化必须有原因
5. 保持剧情连贯，不遗忘已发生的事件；关键节点用 [PLOT] 记录
6. 追踪任务进度：在 [QUESTS] 中记录新任务、进展、完成或失败
7. 提供 2-4 个有意义的行动选项
8. 每次回复都要更新 [STATE] 为最新值；未知信息保持"未知"，不要编造`;

  /* 角色卡 V3：post_history_instructions（结尾指令，置于最后，始终遵守） */
  prompt += buildPostHistoryTail(adventure);

  return resolvePromptMacros(prompt, adventure);
}

function buildSystemPrompt(adventure) {
  const c = adventure.character || {};
  /* 旧存档冒险可能缺 character.attributes / skills / items 等字段，
     这里兜底，避免 buildSystemPrompt 抛错导致「一发送就静默失败」。 */
  c.attributes = c.attributes || {};
  c.skills = Array.isArray(c.skills) ? c.skills : [];
  c.items = Array.isArray(c.items) ? c.items : [];
  const td = adventure.customTheme || themeData[adventure.theme] || {};
  if (adventure.mode === 'tavern') return buildTavernSystemPrompt(adventure, c, td);

  let prompt = `你是「叙界 Narraverse」——一个文字冒险游戏的 AI 叙事者（Game Master）。

## 世界设定
主题：${adventure.theme}
背景：${td.desc || '自由冒险'}
${adventure.setting ? '玩家设定：' + adventure.setting : ''}

`;

  /* 角色卡注入 */
  prompt += buildCharacterCardsBlock(adventure);

  /* 分组 NPC 同场（在场角色 + 话痨度 + 群像群聊指令） */
  prompt += buildActiveSceneBlock(adventure);

  /* 角色卡 V3 专属系统指令（system_prompt） */
  prompt += buildCardSystemDirectives(adventure);

  /* 设定书按需注入（World Info 化） */
  prompt += buildLorebookBlock(adventure);

  /* 自定义规则 */
  if (adventure.customPrompt) {
    prompt += `## 玩家自定义规则\n${adventure.customPrompt}\n\n`;
  }

  /* 已知人物（曼陀罗，信息随剧情逐步揭示） */
  if (adventure.mandalaCards && adventure.mandalaCards.length > 0) {
    const knownLines = [];
    for (const card of adventure.mandalaCards) {
      const parts = [];
      for (const f of MANDALA_FIELDS) {
        if (card[f.key]) parts.push(f.label + '=' + card[f.key]);
      }
      if (parts.length > 0) knownLines.push(card.name + ' | ' + parts.join(' | '));
    }
    if (knownLines.length > 0) {
      prompt += '## 已知人物（仅展示玩家已了解的信息，未知的不写）\n' + knownLines.join('\n') + '\n\n';
    }
  }

  /* 当前剧情线 */
  prompt += buildPlotLineBlock(adventure);

  /* 角色状态（精简模式：只保留核心状态，显著降低每轮 token） */
  const compact = !!(adventure && adventure.compactState);
  if (compact) {
    const activeQuests = (adventure.quests && adventure.quests.length > 0)
      ? adventure.quests.filter(q => q.status === 'active').map(q => q.name)
      : [];
    prompt += `## 当前角色状态（精简）
角色：${c.name} ${c.profession} Lv.${c.level} | HP ${c.hp}/${c.maxHp} | MP ${c.mp}/${c.maxMp} | ${c.location} | ${c.chapter} | 情绪:${c.mood}
属性：力量${c.attributes['力量'] || 10} 敏捷${c.attributes['敏捷'] || 10} 智力${c.attributes['智力'] || 10} 魅力${c.attributes['魅力'] || 10} 幸运${c.attributes['幸运'] || 10}${c.attributePoints ? ' (可分配' + c.attributePoints + ')' : ''}
技能：${c.skills.length > 0 ? c.skills.map(s => s.name + 'Lv.' + s.level).join('、') : '无'}${c.skillPoints ? ' (可分配' + c.skillPoints + ')' : ''}
背包：${c.items.length > 0 ? c.items.map(i => i.name + (i.qty > 1 ? 'x' + i.qty : '')).join('、') : '空'}
任务(进行中)：${activeQuests.length > 0 ? activeQuests.join('、') : '无'}
${adventure.combat && adventure.combat.active ? '战斗(回合' + adventure.combat.round + ')：' + adventure.combat.enemies.map(e => e.name + ' HP' + e.hp + '/' + e.maxHp).join('、') + '\n' : ''}`;
  } else {
  prompt += `## 当前角色状态（实时追踪 — 每轮自动更新）
角色名：${c.name}
职业：${c.profession}
等级：Lv.${c.level} (EXP ${c.exp}/${c.maxExp})
HP：${c.hp}/${c.maxHp}
MP：${c.mp}/${c.maxMp}
位置：${c.location}
章节：${c.chapter}
情绪：${c.mood}

属性：
  力量(STR)：${c.attributes['力量'] || 10}
  敏捷(AGI)：${c.attributes['敏捷'] || 10}
  智力(INT)：${c.attributes['智力'] || 10}
  魅力(CHA)：${c.attributes['魅力'] || 10}
  幸运(LUK)：${c.attributes['幸运'] || 10}
可用属性点：${c.attributePoints}

技能：
${c.skills.length > 0 ? c.skills.map(s => `  ${s.name} Lv.${s.level} — ${s.desc}`).join('\n') : '  无'}
可用技能点：${c.skillPoints}

背包：${c.items.length > 0 ? c.items.map(i => i.name + ' x' + i.qty + (i.desc ? '（' + i.desc + '）' : '')).join('、') : '空'}

任务：
${adventure.quests && adventure.quests.length > 0 ? adventure.quests.map(q => '  [' + (q.status === 'completed' ? '已完成' : q.status === 'failed' ? '失败' : '进行中') + '] ' + q.name + (q.desc ? ' — ' + q.desc : '')).join('\n') : '  无'}

${adventure.combat && adventure.combat.active ? '## 当前战斗（回合 ' + adventure.combat.round + '）\n敌人：' + adventure.combat.enemies.map(e => e.name + ' HP:' + e.hp + '/' + e.maxHp + ' ATK:' + (e.attack||'?') + ' DEF:' + (e.defense||'?')).join('、') + '\n' : ''}`;
  }

  /* 回复格式 */
  prompt += `
## 回复格式（严格遵守，只输出以下区块，[PLOT] 为可选项，不要添加任何其他内容）

[NARRATIVE]
（第二人称叙事文本，200-400字，生动有沉浸感，描述当前场景和事件。叙事中体现角色情绪和属性对事件的影响。）

[STATE]
HP: 当前值/最大值
MP: 当前值/最大值
位置: 当前场景
章节: 当前章节
职业: 当前职业
情绪: 当前情绪

[CHANGES]
（每行一个变化，无变化则只写"无"）
HP +/-数值 | 原因
MP +/-数值 | 原因
ITEM + | 物品名 | 数量(可选，默认1) | 描述(可选)
ITEM - | 物品名 | 数量(可选，默认1)
MOOD | 新情绪 | 原因
SKILL_NEW | 技能名 | 描述（学会新技能）
SKILL_UP | 技能名 | 新等级（技能升级）
ATTR_UP | 力量/敏捷/智力/魅力/幸运 | +数值 | 原因
EXP + 数值 | 原因
LEVEL_UP | 新等级
SKILLPT + 数值 | 原因
ATTRPT + 数值 | 原因

[CHOICES]
1. 第一个选项
2. 第二个选项
3. 第三个选项

[QUESTS]
（每行一条任务更新，无更新则写"无"）
QUEST_NEW | 任务名 | 描述
QUEST_UPDATE | 任务名 | 进行中 | 进展描述
QUEST_COMPLETE | 任务名
QUEST_FAIL | 任务名

[COMBAT]
（若当前处于战斗中，输出战斗信息；否则写"无"）
START | 敌人名 | HP | 最大HP | 攻击力 | 防御力（战斗开始）
UPDATE | 敌人名 | HP | 状态（受伤/死亡等）
END | 结果（胜利/逃跑/失败）

[CHARACTERS]
（每行一条：新登场角色或已知角色信息更新；无更新则写"无"）
角色名 | 身份=... | 欲望=... | 目标=... | 行动=... | 背景=... | 资源=... | 关系=... | 性格=...
玩家尚未了解的信息保持"未知"，不要编造

[PLOT]
（可选区块：剧情出现明显节点时输出；平时整块省略。每行一条）
NODE_NEW | 标题(6-12字) | 章节 | 摘要 | 地点 | 涉及人物(逗号分隔)
NODE_DONE | 节点标题
NODE_FAIL | 节点标题

## 规则
1. 叙事使用第二人称（"你..."）
2. HP 降到 0 → 角色死亡，游戏结束
3. 属性变化必须有合理原因
4. 追踪所有物品的获取和消耗
5. 保持剧情连贯，不遗忘已发生的事件
6. 提供 2-4 个有意义的行动选项
7. 每次回复都要更新 [STATE] 为最新值
8. 情绪应随剧情变化而自然变化
9. 角色成长：完成重要事件后给予 EXP，升级时给予 3 属性点和 1 技能点
10. 属性影响叙事：高力量角色更容易完成力量检定，高智力更容易发现线索等
11. 技能可以影响事件走向，在叙事中自然体现技能的作用
12. 参考角色卡中的 NPC 设定，保持其性格和行为一致
13. 参考设定书中的世界观，保持设定一致
14. 每次回复在 [CHARACTERS] 中记录新登场角色或已知角色的信息更新，只写玩家已了解的信息，未知保持"未知"
15. 若玩家角色（职业/身份）与世界观或设定书冲突，自动补充/调整身份设定使其自洽，并在叙事中自然交代
16. 当玩家消息中出现“掷骰”或骰子结果（如 d20=12）时，以该结果作为对应检定/事件的判定，并自然体现在叙事中
17. 当玩家进行属性检定（如"力量检定"）时，结合角色当前属性值、骰子结果与场景难度判定成败，并在叙事中说明原因
18. 当玩家触发"随机事件"时，生成一个与当前场景、角色状态和世界观相符的随机事件（机遇、危险或转折），并给出新的行动选择
19. 追踪任务进度：在 [QUESTS] 中记录新任务、进展、完成或失败，并在叙事中自然提及任务相关线索
20. 战斗规则：当发生战斗时，在 [COMBAT] 中输出敌人状态和战斗结果。战斗中结合属性、技能和骰子结果判定伤害。敌人有 HP、攻击力、防御力
21. 物品有数量和描述：使用 ITEM + 时可附带数量和描述，物品在使用后数量减少
22. 当场景、章节、关键事件或任务阶段发生明显变化时，在回复末尾输出 [PLOT] 记录剧情节点；平时不要输出该区块`;

  /* 角色卡 V3：post_history_instructions（结尾指令，置于最后，始终遵守） */
  prompt += buildPostHistoryTail(adventure);

  return resolvePromptMacros(prompt, adventure);
}

function updateSystemPrompt(adventure) {
  const sys = adventure.conversationHistory[0];
  if (!sys || sys.role !== 'system') return;
  sys.content = syncSystemPrompt(adventure);
}

function extractSection(prompt, title) {
  const start = prompt.indexOf(title);
  if (start === -1) return '';
  const rest = prompt.slice(start + title.length);
  const nextHeading = rest.match(/\n## /);
  const end = nextHeading ? start + title.length + nextHeading.index : prompt.length;
  return prompt.slice(start, end);
}

function replaceAutoSection(prompt, title, newSection) {
  const start = prompt.indexOf(title);
  if (start === -1) {
    if (!newSection) return prompt;
    const trimmed = prompt.replace(/\s+$/, '');
    return trimmed + (trimmed ? '\n\n' : '') + newSection;
  }
  const rest = prompt.slice(start + title.length);
  const nextHeading = rest.match(/\n## /);
  const end = nextHeading ? start + title.length + nextHeading.index : prompt.length;
  if (!newSection) {
    return (prompt.slice(0, start) + prompt.slice(end)).replace(/\n{3,}/g, '\n\n');
  }
  return prompt.slice(0, start) + newSection + prompt.slice(end);
}

function syncSystemPrompt(adventure) {
  const hasOverride = !!(adventure.customPrompt && adventure.customPrompt.trim());
  if (!hasOverride) return buildSystemPrompt(adventure);
  let prompt = resolvePromptMacros(adventure.customPrompt, adventure);
  /* 构建 fresh 时清空 customPrompt，避免把用户覆盖文本里的同名区块误当成自动区块 */
  const fresh = buildSystemPrompt({ ...adventure, customPrompt: '' });
  prompt = replaceAutoSection(prompt, SECTION_CARDS, extractSection(fresh, SECTION_CARDS));
  prompt = replaceAutoSection(prompt, SECTION_BOOKS, extractSection(fresh, SECTION_BOOKS));
  prompt = replaceAutoSection(prompt, SECTION_STATUS, extractSection(fresh, SECTION_STATUS));
  return prompt;
}

/* ==================== API 调用 ==================== */
const REQUEST_TIMEOUT_MS = 120000;

async function callLLM(messages, onChunk) {
  const config = state.apiConfig;
  if (!config.endpoint || !config.apiKey) {
    throw new Error('API 未配置，请先在设置中填写 API 信息');
  }
  const url = config.endpoint.replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const useStream = typeof onChunk === 'function' && config.streaming !== false;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + config.apiKey,
      },
      body: JSON.stringify({
        model: config.model || 'deepseek-chat',
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        temperature: config.temperature ?? 0.85,
        max_tokens: config.maxOutputTokens || 4096,
        stream: useStream,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error('API 错误 (' + response.status + '): ' + errText.substring(0, 300));
    }
    if (useStream && response.body && (response.headers.get('content-type') || '').includes('text/event-stream')) {
      return await readStream(response, onChunk);
    }
    /* 接口不支持流式或返回了普通 JSON：走非流式路径 */
    const data = await response.json();
    return data.choices[0].message.content;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('请求超时（' + Math.round(REQUEST_TIMEOUT_MS / 1000) + ' 秒），请重试');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function readStream(response, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let thinkingFull = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (!delta) continue;
        let thinkingDelta = '';
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) thinkingDelta += delta.reasoning_content;
        if (typeof delta.thinking === 'string' && delta.thinking) thinkingDelta += delta.thinking;
        if (typeof delta.content === 'string' && delta.content) {
          full += delta.content;
          onChunk(delta.content, thinkingDelta);
        } else if (thinkingDelta) {
          onChunk('', thinkingDelta);
        }
        if (thinkingDelta) thinkingFull += thinkingDelta;
      } catch (e) { /* 忽略无法解析的数据帧 */ }
    }
  }
  return full;
}

/* ==================== 响应解析 ==================== */
function parseGameResponse(text) {
  const result = { narrative: '', state: {}, changes: [], choices: [], charactersLines: [], quests: [], combat: { events: [] }, plot: [] };
  const parts = text.split(/\[(NARRATIVE|STATE|CHANGES|CHOICES|QUESTS|COMBAT|CHARACTERS|PLOT)\]/);
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i];
    const content = (parts[i + 1] || '').trim();
    if (name === 'NARRATIVE') {
      result.narrative = content;
    } else if (name === 'STATE') {
      const hpM = content.match(/HP:\s*(\d+)\s*\/\s*(\d+)/i);
      if (hpM) { result.state.hp = +hpM[1]; result.state.maxHp = +hpM[2]; }
      const mpM = content.match(/MP:\s*(\d+)\s*\/\s*(\d+)/i);
      if (mpM) { result.state.mp = +mpM[1]; result.state.maxMp = +mpM[2]; }
      const locM = content.match(/位置:\s*(.+)/i);
      if (locM) result.state.location = locM[1].trim();
      const chM = content.match(/章节:\s*(.+)/i);
      if (chM) result.state.chapter = chM[1].trim();
      const profM = content.match(/职业:\s*(.+)/i);
      if (profM) result.state.profession = profM[1].trim();
      const moodM = content.match(/情绪:\s*(.+)/i);
      if (moodM) result.state.mood = moodM[1].trim();
      const affM = content.match(/好感度:\s*(.+)/i);
      if (affM) {
        result.state.affections = {};
        for (const pair of affM[1].split(/[,，]/)) {
          const pm = pair.match(/(.+?)\s*=\s*(\d+)/);
          if (pm) result.state.affections[pm[1].trim()] = Math.max(0, Math.min(100, +pm[2]));
        }
      }
    } else if (name === 'CHANGES') {
      if (content && content !== '无') {
        for (const line of content.split('\n')) {
          const t = line.trim();
          if (!t || t === '无') continue;

          const hpM = t.match(/^HP\s*([+-])\s*(\d+)\s*\|?\s*(.*)$/i);
          if (hpM) { result.changes.push({ type: 'hp', change: +(hpM[1] + hpM[2]), reason: hpM[3].trim() }); continue; }

          const mpM = t.match(/^MP\s*([+-])\s*(\d+)\s*\|?\s*(.*)$/i);
          if (mpM) { result.changes.push({ type: 'mp', change: +(mpM[1] + mpM[2]), reason: mpM[3].trim() }); continue; }

          const itemAdd = t.match(/^ITEM\s*\+\s*\|?\s*(.+?)(?:\s*\|\s*(\d+))?(?:\s*\|\s*(.*))?$/i);
          if (itemAdd) {
            const itemName = itemAdd[1].trim();
            const qty = itemAdd[2] ? parseInt(itemAdd[2]) : 1;
            const desc = (itemAdd[3] || '').trim();
            result.changes.push({ type: 'item', action: 'add', item: itemName, qty: qty, desc: desc });
            continue;
          }

          const itemRem = t.match(/^ITEM\s*-\s*\|?\s*(.+?)(?:\s*\|\s*(\d+))?$/i);
          if (itemRem) {
            const itemName = itemRem[1].trim();
            const qty = itemRem[2] ? parseInt(itemRem[2]) : 1;
            result.changes.push({ type: 'item', action: 'remove', item: itemName, qty: qty });
            continue;
          }

          const moodM = t.match(/^MOOD\s*\|\s*(.+?)(?:\s*\|\s*(.*))?$/i);
          if (moodM) { result.changes.push({ type: 'mood', mood: moodM[1].trim(), reason: (moodM[2]||'').trim() }); continue; }

          const affM = t.match(/^AFF\s*([+-])\s*(\d+)\s*\|\s*(.+?)(?:\s*\|\s*(.*))?$/i);
          if (affM) { result.changes.push({ type: 'aff', name: affM[3].trim(), change: +(affM[1] + affM[2]), reason: (affM[4]||'').trim() }); continue; }

          const relM = t.match(/^RELATION\s*\|\s*(.+?)(?:\s*\|\s*(.*))?$/i);
          if (relM) { result.changes.push({ type: 'relation', name: relM[1].trim(), desc: (relM[2]||'').trim() }); continue; }

          const skillNewM = t.match(/^SKILL_NEW\s*\|\s*(.+?)(?:\s*\|\s*(.*))?$/i);
          if (skillNewM) { result.changes.push({ type: 'skill_new', name: skillNewM[1].trim(), desc: (skillNewM[2]||'').trim() }); continue; }

          const skillUpM = t.match(/^SKILL_UP\s*\|\s*(.+?)(?:\s*\|\s*(.*))?$/i);
          if (skillUpM) { result.changes.push({ type: 'skill_up', name: skillUpM[1].trim(), newLevel: parseInt((skillUpM[2]||'1').trim()) || 1 }); continue; }

          const attrUpM = t.match(/^ATTR_UP\s*\|\s*(力量|敏捷|智力|魅力|幸运)\s*\|\s*\+?(\d+)(?:\s*\|\s*(.*))?$/i);
          if (attrUpM) { result.changes.push({ type: 'attr_up', attr: attrUpM[1].trim(), value: +attrUpM[2], reason: (attrUpM[3]||'').trim() }); continue; }

          const expM = t.match(/^EXP\s*\+\s*\|?\s*(\d+)(?:\s*\|\s*(.*))?$/i);
          if (expM) { result.changes.push({ type: 'exp', value: +expM[1], reason: (expM[2]||'').trim() }); continue; }

          const levelUpM = t.match(/^LEVEL_UP\s*\|?\s*(\d+)?$/i);
          if (levelUpM) { result.changes.push({ type: 'level_up', newLevel: parseInt(levelUpM[1]) || null }); continue; }

          const skillPtM = t.match(/^SKILLPT\s*\+\s*\|?\s*(\d+)(?:\s*\|\s*(.*))?$/i);
          if (skillPtM) { result.changes.push({ type: 'skillpt', value: +skillPtM[1], reason: (skillPtM[2]||'').trim() }); continue; }

          const attrPtM = t.match(/^ATTRPT\s*\+\s*\|?\s*(\d+)(?:\s*\|\s*(.*))?$/i);
          if (attrPtM) { result.changes.push({ type: 'attrpt', value: +attrPtM[1], reason: (attrPtM[2]||'').trim() }); continue; }
        }
      }
    } else if (name === 'CHOICES') {
      for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const cleaned = t.replace(/^\d+\.\s*/, '');
        if (cleaned) result.choices.push(cleaned);
      }
    } else if (name === 'QUESTS') {
      if (content && content !== '无') {
        for (const line of content.split('\n')) {
          const t = line.trim();
          if (!t || t === '无') continue;
          const qNew = t.match(/^QUEST_NEW\s*\|\s*(.+?)(?:\s*\|\s*(.*))?$/i);
          if (qNew) { result.quests.push({ action: 'new', name: qNew[1].trim(), desc: (qNew[2]||'').trim() }); continue; }
          const qUpd = t.match(/^QUEST_UPDATE\s*\|\s*(.+?)(?:\s*\|\s*(.+?))?(?:\s*\|\s*(.*))?$/i);
          if (qUpd) { result.quests.push({ action: 'update', name: qUpd[1].trim(), status: (qUpd[2]||'进行中').trim(), desc: (qUpd[3]||'').trim() }); continue; }
          const qComp = t.match(/^QUEST_COMPLETE\s*\|\s*(.+)$/i);
          if (qComp) { result.quests.push({ action: 'complete', name: qComp[1].trim() }); continue; }
          const qFail = t.match(/^QUEST_FAIL\s*\|\s*(.+)$/i);
          if (qFail) { result.quests.push({ action: 'fail', name: qFail[1].trim() }); continue; }
        }
      }
    } else if (name === 'COMBAT') {
      if (content && content !== '无') {
        for (const line of content.split('\n')) {
          const t = line.trim();
          if (!t || t === '无') continue;
          const cStart = t.match(/^START\s*\|\s*(.+?)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)?\s*\|\s*(\d+)?$/i);
          if (cStart) { result.combat.events.push({ type: 'start', name: cStart[1].trim(), hp: +cStart[2], maxHp: +cStart[3], attack: cStart[4]?+cStart[4]:0, defense: cStart[5]?+cStart[5]:0 }); continue; }
          const cUpd = t.match(/^UPDATE\s*\|\s*(.+?)\s*\|\s*(\d+)(?:\s*\|\s*(.*))?$/i);
          if (cUpd) { result.combat.events.push({ type: 'update', name: cUpd[1].trim(), hp: +cUpd[2], status: (cUpd[3]||'').trim() }); continue; }
          const cEnd = t.match(/^END\s*\|\s*(.+)$/i);
          if (cEnd) { result.combat.events.push({ type: 'end', result: cEnd[1].trim() }); continue; }
        }
      }
    } else if (name === 'CHARACTERS') {
      result.charactersLines = content.split('\n').map(l => l.trim()).filter(l => l && l !== '无');
    } else if (name === 'PLOT') {
      for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t || t === '无') continue;
        const pNew = t.match(/^NODE_NEW\s*\|\s*(.+?)(?:\s*\|\s*(.*?))?(?:\s*\|\s*(.*?))?(?:\s*\|\s*(.*?))?(?:\s*\|\s*(.*))?$/i);
        if (pNew) {
          result.plot.push({
            action: 'new',
            title: pNew[1].trim(),
            chapter: (pNew[2] || '').trim(),
            summary: (pNew[3] || '').trim(),
            location: (pNew[4] || '').trim(),
            characters: (pNew[5] || '').trim(),
          });
          continue;
        }
        const pDone = t.match(/^NODE_DONE\s*\|\s*(.+)$/i);
        if (pDone) { result.plot.push({ action: 'done', title: pDone[1].trim() }); continue; }
        const pFail = t.match(/^NODE_FAIL\s*\|\s*(.+)$/i);
        if (pFail) { result.plot.push({ action: 'fail', title: pFail[1].trim() }); continue; }
      }
    }
  }
  if (!result.narrative) result.narrative = stripSectionTags(text);
  return result;
}

/* ==================== 状态应用 ==================== */
function applyParsedResult(adventure, parsed) {
  const c = adventure.character;

  for (const change of parsed.changes) {
    if (change.type === 'hp') {
      c.hp = Math.max(0, Math.min(c.maxHp, c.hp + change.change));
    } else if (change.type === 'mp') {
      c.mp = Math.max(0, Math.min(c.maxMp, c.mp + change.change));
    } else if (change.type === 'item') {
      if (change.action === 'add') {
        const existing = c.items.find(i => i.name === change.item);
        if (existing) {
          existing.qty += (change.qty || 1);
        } else {
          c.items.push({ name: change.item, qty: change.qty || 1, desc: change.desc || '' });
        }
      } else if (change.action === 'remove') {
        const existing = c.items.find(i => i.name === change.item);
        if (existing) {
          existing.qty -= (change.qty || 1);
          if (existing.qty <= 0) c.items = c.items.filter(i => i.name !== change.item);
        }
      }
    } else if (change.type === 'mood') {
      c.mood = change.mood;
    } else if (change.type === 'skill_new') {
      if (!c.skills.find(s => s.name === change.name)) {
        c.skills.push({ name: change.name, level: 1, desc: change.desc || '新技能' });
      }
    } else if (change.type === 'skill_up') {
      const skill = c.skills.find(s => s.name === change.name);
      if (skill) skill.level = Math.max(skill.level, change.newLevel);
    } else if (change.type === 'attr_up') {
      if (c.attributes[change.attr] !== undefined) {
        c.attributes[change.attr] += change.value;
      }
    } else if (change.type === 'exp') {
      c.exp += change.value;
      while (c.exp >= c.maxExp) {
        c.exp -= c.maxExp;
        c.level++;
        c.maxExp = Math.floor(c.maxExp * 1.5);
        c.attributePoints += 3;
        c.skillPoints += 1;
        c.maxHp += 10;
        c.maxMp += 5;
        c.hp = c.maxHp;
        c.mp = c.maxMp;
      }
    } else if (change.type === 'level_up') {
      if (change.newLevel && change.newLevel > c.level) {
        const levelsGained = change.newLevel - c.level;
        c.level = change.newLevel;
        c.maxExp = Math.floor(c.maxExp * Math.pow(1.5, levelsGained));
        c.attributePoints += 3 * levelsGained;
        c.skillPoints += 1 * levelsGained;
        c.maxHp += 10 * levelsGained;
        c.maxMp += 5 * levelsGained;
        c.hp = c.maxHp;
        c.mp = c.maxMp;
      }
    } else if (change.type === 'skillpt') {
      c.skillPoints += change.value;
    } else if (change.type === 'attrpt') {
      c.attributePoints += change.value;
    } else if (change.type === 'aff') {
      if (!adventure.affections) adventure.affections = {};
      const base = adventure.affections[change.name] != null ? adventure.affections[change.name] : 50;
      adventure.affections[change.name] = Math.max(0, Math.min(100, base + change.change));
    } else if (change.type === 'relation') {
      if (!adventure.relations) adventure.relations = {};
      adventure.relations[change.name] = change.desc || '关系发生变化';
    }
  }

  /* 用 [STATE] 覆盖 */
  if (parsed.state.hp !== undefined) c.hp = parsed.state.hp;
  if (parsed.state.maxHp !== undefined) c.maxHp = parsed.state.maxHp;
  if (parsed.state.mp !== undefined) c.mp = parsed.state.mp;
  if (parsed.state.maxMp !== undefined) c.maxMp = parsed.state.maxMp;
  if (parsed.state.location) c.location = parsed.state.location;
  if (parsed.state.chapter) c.chapter = parsed.state.chapter;
  if (parsed.state.profession) c.profession = parsed.state.profession;
  if (parsed.state.mood) c.mood = parsed.state.mood;
  if (parsed.state.affections) {
    if (!adventure.affections) adventure.affections = {};
    Object.assign(adventure.affections, parsed.state.affections);
  }

  /* 应用任务更新 */
  if (parsed.quests && parsed.quests.length > 0 && adventure.quests) {
    for (const q of parsed.quests) {
      if (q.action === 'new') {
        if (!adventure.quests.find(x => x.name === q.name)) {
          adventure.quests.push({ name: q.name, status: 'active', desc: q.desc || '' });
        }
      } else if (q.action === 'update') {
        const eq = adventure.quests.find(x => x.name === q.name);
        if (eq) { eq.status = 'active'; if (q.desc) eq.desc = q.desc; }
      } else if (q.action === 'complete') {
        const eq = adventure.quests.find(x => x.name === q.name);
        if (eq) eq.status = 'completed';
      } else if (q.action === 'fail') {
        const eq = adventure.quests.find(x => x.name === q.name);
        if (eq) eq.status = 'failed';
      }
    }
  }

  /* 应用战斗更新 */
  if (parsed.combat && parsed.combat.events && parsed.combat.events.length > 0 && adventure.combat) {
    for (const ev of parsed.combat.events) {
      if (ev.type === 'start') {
        adventure.combat.active = true;
        adventure.combat.round = adventure.combat.round || 1;
        const existing = adventure.combat.enemies.find(e => e.name === ev.name);
        if (!existing) {
          adventure.combat.enemies.push({ name: ev.name, hp: ev.hp, maxHp: ev.maxHp, attack: ev.attack, defense: ev.defense });
        }
      } else if (ev.type === 'update') {
        const enemy = adventure.combat.enemies.find(e => e.name === ev.name);
        if (enemy) enemy.hp = ev.hp;
        if (ev.hp <= 0) adventure.combat.enemies = adventure.combat.enemies.filter(e => e.name !== ev.name);
      } else if (ev.type === 'end') {
        adventure.combat.active = false;
        adventure.combat.enemies = [];
        adventure.combat.round = 0;
      }
    }
    if (adventure.combat.active) adventure.combat.round++;
  }

}

/* ==================== 上下文管理 ==================== */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 2.5);
}

function getConversationTokens(history) {
  let total = 0;
  for (const msg of history) {
    total += estimateTokens(msg.content);
    total += 4;
  }
  return total;
}

async function manageContext(adventure) {
  const maxTokens = state.apiConfig.maxTokens || 8000;
  let tokens = getConversationTokens(adventure.conversationHistory);
  updateContextBar(tokens, maxTokens, '正常');

  if (tokens > maxTokens * 0.8 && adventure.conversationHistory.length > 10) {
    updateContextBar(tokens, maxTokens, '压缩中...');
    const keepCount = 6;
    const systemMsg = adventure.conversationHistory[0];
    const recentMsgs = adventure.conversationHistory.slice(-keepCount);
    const oldMsgs = adventure.conversationHistory.slice(1, -keepCount);

    if (oldMsgs.length > 0) {
      try {
        /* 压缩前自动存档：完整历史可随时回滚，压缩不再造成永久丢失 */
        createSnapshot(adventure, '压缩前自动存档', 'compress');

        /* 消息按新旧加权截断：越靠近当前的消息保留越多内容 */
        /* 前情摘要须覆盖「全部上文」：不再截断为片段，保留 oldMsgs 完整内容；
           仅对个别超长单条（>4000字）做上限保护，避免巨长消息撑爆请求 */
        const summaryInput = oldMsgs.map((m) => {
          const MAX = 4000;
          const text = m.content.length > MAX ? m.content.substring(0, MAX) + '……' : m.content;
          return '[' + m.role + ']: ' + text;
        }).join('\n\n');

        /* 附带当前已知状态，让摘要与角色状态保持一致 */
        const stateHint = '当前角色：' + adventure.character.name +
          ' 位置:' + (adventure.character.location || '未知') +
          ' 章节:' + (adventure.character.chapter || '未知') +
          ' HP:' + adventure.character.hp + '/' + adventure.character.maxHp +
          ' MP:' + adventure.character.mp + '/' + adventure.character.maxMp +
          (adventure.quests && adventure.quests.length > 0
            ? ' | 任务:' + adventure.quests.filter(q => q.status === 'active').map(q => q.name).join('、')
            : '') +
          (adventure.plotNodes && adventure.plotNodes.length
            ? ' | 剧情线:' + (adventure.currentLineId === 'main' ? '主线' : 'IF线') + (lineLastNode(adventure, adventure.currentLineId) ? '·' + lineLastNode(adventure, adventure.currentLineId).title : '')
            : '');

        const summary = await callLLM([
          { role: 'system', content: '请将以下文字冒险游戏对话整理为结构化「前情摘要」。按小节输出，只输出小节内容，不要额外说明：\n' +
            '【剧情摘要】(300字以内) 关键事件、剧情转折、玩家的决策及其结果\n' +
            '【当前场景】地点、时间、在场人物、世界/局势状态\n' +
            '【玩家近期行动】最近3-5个关键行动与结果\n' +
            '【NPC与关系】重要NPC的最新状态、与玩家关系的变化\n' +
            '【任务与线索】进行中任务、新线索、伏笔、未兑现的承诺\n' +
            '【重要物品与能力】对话中新获得的物品、技能、发现（与角色状态冲突时以角色状态为准）\n' +
            '【其他必须记住】特殊约定、隐藏信息、已触发的flag\n' +
            '要求：信息密度优先，宁可列要点也不要遗漏关键事件；单节过长可精简，但【剧情摘要】必须保留主干。\n\n' +
            '当前已知状态（仅供参考，勿重复摘录）：\n' + stateHint },
          { role: 'user', content: summaryInput },
        ]);

        /* 摘要为空时降级为最近消息原文，避免压缩后彻底丢失上下文 */
        const finalSummary = summary && summary.trim().length > 0
          ? summary.trim()
          : oldMsgs.map(m => '[' + m.role + ']: ' + m.content.substring(0, 200)).join('\n');
        adventure.conversationHistory = [
          systemMsg,
          { role: 'system', content: '【前情摘要】\n' + finalSummary },
          ...recentMsgs,
        ];
        adventure.contextSummary = finalSummary;
        adventure.contextCompressed = true;
        /* 压缩后把前情摘要写入时间轴事件节点，并持续记录 */
        logEvent(adventure, 'compress', '上下文已压缩', finalSummary);
        tokens = getConversationTokens(adventure.conversationHistory);
        updateContextBar(tokens, maxTokens, '已压缩');
        if (document.getElementById('timelineDrawer') && document.getElementById('timelineDrawer').style.display !== 'none') {
          try { renderTimeline(); } catch (e) { console.error('压缩后刷新时间轴失败:', e); }
        }
      } catch (e) {
        console.error('上下文压缩失败:', e);
        updateContextBar(tokens, maxTokens, '压缩失败');
      }
    }
  }
  return adventure;
}

/* ==================== UI 渲染 ==================== */

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function emptyStateHtml() {
  return '<div class="empty-state" id="emptyState">' +
    '<div class="empty-icon">✦</div>' +
    '<p class="empty-title">叙界 Narraverse</p>' +
    '<p class="empty-desc">接入 LLM API，AI 实时生成叙事<br>属性变化在文字旁批注显示，上下文跨轮次不丢失</p>' +
    '<button class="btn btn-primary btn-lg" onclick="showNewAdventureModal()">创建第一个冒险</button>' +
    '</div>';
}

function applySidebarState() {
  const app = document.querySelector('.app');
  if (app) {
    if (state.ui && state.ui.sidebarCollapsed) app.classList.add('sidebar-collapsed');
    else app.classList.remove('sidebar-collapsed');
  }
  const btn = document.getElementById('sidebarToggle');
  if (btn) btn.textContent = (state.ui && state.ui.sidebarCollapsed) ? '»' : '☰';
}

function closeMobileSidebar() {
  document.querySelector('.app')?.classList.remove('mobile-sidebar-open');
}

function toggleSidebar() {
  const app = document.querySelector('.app');
  if (document.documentElement.classList.contains('mobile-mode')) {
    if (app) app.classList.toggle('mobile-sidebar-open');
    return;
  }
  if (!state.ui) state.ui = {};
  state.ui.sidebarCollapsed = !state.ui.sidebarCollapsed;
  applySidebarState();
  saveState();
}

function applyChatBackground() {
  const sa = document.getElementById('storyArea');
  if (!sa) return;
  const adv = getCurrentAdventure();
  const bg = adv && adv.chatBackground;
  if (!bg) {
    sa.style.backgroundImage = '';
    sa.style.backgroundColor = '';
    return;
  }
  if (bg.type === 'image') {
    sa.style.backgroundColor = '';
    sa.style.backgroundImage = 'url(' + bg.value + ')';
    sa.style.backgroundSize = 'cover';
    sa.style.backgroundPosition = 'center';
    sa.style.backgroundRepeat = 'no-repeat';
    sa.style.backgroundAttachment = 'fixed';
  } else {
    sa.style.backgroundImage = '';
    sa.style.backgroundColor = bg.value;
  }
}

let _pendingBgImage = null;
function showChatBackgroundModal() {
  const adv = getCurrentAdventure();
  if (!adv) { alert('请先开始一个冒险'); return; }
  _pendingBgImage = null;
  const colorInput = document.getElementById('bgColorInput');
  const imgInput = document.getElementById('bgImageInput');
  if (imgInput) imgInput.value = '';
  const bg = adv.chatBackground;
  if (colorInput) colorInput.value = (bg && bg.type === 'color') ? bg.value : '#0f1320';
  const sw = document.getElementById('bgSwatches');
  if (sw) {
    const presets = ['#0f1320','#1a1f2e','#10243a','#2a1a2e','#1e2a1a','#2e241a','#0d0d0d','#3a1020'];
    sw.innerHTML = presets.map(function(c) {
      return '<span class="bg-swatch" style="background:' + c + '" data-color="' + c + '" onclick="document.getElementById(\'bgColorInput\').value=\'' + c + '\'"></span>';
    }).join('');
  }
  const prev = document.getElementById('bgPreview');
  if (prev) {
    if (bg && bg.type === 'image') { prev.style.backgroundColor = ''; prev.style.backgroundImage = 'url(' + bg.value + ')'; }
    else if (bg && bg.type === 'color') { prev.style.backgroundImage = ''; prev.style.backgroundColor = bg.value; }
    else { prev.style.backgroundImage = ''; prev.style.backgroundColor = ''; }
  }
  if (imgInput) imgInput.onchange = function(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = function(ev) {
      _pendingBgImage = ev.target.result;
      if (prev) { prev.style.backgroundColor = ''; prev.style.backgroundImage = 'url(' + _pendingBgImage + ')'; }
    };
    r.readAsDataURL(f);
  };
  showModal('chatBackgroundModal');
}

function applyChatBackgroundFromModal() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  if (_pendingBgImage) {
    adv.chatBackground = { type: 'image', value: _pendingBgImage };
  } else {
    const color = document.getElementById('bgColorInput').value;
    adv.chatBackground = { type: 'color', value: color };
  }
  applyChatBackground();
  saveState();
  closeModal('chatBackgroundModal');
}

function clearChatBackground() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  adv.chatBackground = null;
  applyChatBackground();
  saveState();
  closeModal('chatBackgroundModal');
}

function renderAdventureList() {
  const list = document.getElementById('adventureList');
  const countEl = document.getElementById('adventureCount');
  if (countEl) countEl.textContent = String(state.adventures.length);
  if (state.adventures.length === 0) {
    list.innerHTML = '<div class="adventure-list-empty"><span class="adventure-list-empty-mark">—</span><span>还没有故事</span><small>创建一场冒险，继续你的叙事</small></div>';
    return;
  }
  let html = '';
  const gen = window._introGen || {};
  for (const adv of state.adventures) {
    const isActive = adv.id === state.currentId;
    const mode = adv.mode === 'tavern' ? 'tavern' : 'adventure';
    const modeLabel = mode === 'tavern' ? '酒馆剧情' : '战斗冒险';
    const modeIcon = mode === 'tavern' ? 'wine' : 'swords';
    const intro = adv.aiIntro || null;
    const teaser = intro && intro.intro ? intro.intro : (adv.theme || '尚未开始的故事');
    const turns = countTurns(adv.conversationHistory || []);
    const status = adv.character && adv.character.hp > 0 ? '进行中' : '已结束';

    /* 选中冒险内联展示 AI 剧情大纲（融入左侧目录，不单独弹窗） */
    let introHtml = '';
    if (isActive) {
      if (adv.aiIntro) {
        const ai = adv.aiIntro;
        introHtml = '<div class="adv-intro">' +
          (ai.title ? '<div class="adv-intro-title">' + escapeHtml(ai.title) + '</div>' : '') +
          '<div class="adv-intro-text">' + escapeHtml(ai.intro || '（暂无介绍）') + '</div>' +
          '<button class="btn btn-secondary adv-intro-regen" onclick="event.stopPropagation(); generateAdventureIntro(\'' + adv.id + '\', true)">重新生成</button>' +
          '</div>';
      } else if (adv.contextSummary && gen[adv.id]) {
        introHtml = '<div class="adv-intro adv-intro-loading">🤖 正在根据前情摘要生成剧情大纲…</div>';
      } else if (adv.contextSummary) {
        introHtml = '<div class="adv-intro"><button class="btn btn-secondary adv-intro-regen" onclick="event.stopPropagation(); generateAdventureIntro(\'' + adv.id + '\', true)">生成剧情大纲</button></div>';
      } else {
        introHtml = '<div class="adv-intro adv-intro-hint">剧情展开（首次压缩上下文后）将自动生成大纲</div>';
      }
    }

    html += '<div class="adventure-item' + (isActive ? ' active' : '') + '" data-id="' + adv.id + '" draggable="true" onclick="loadAdventure(\'' + adv.id + '\')">' +
      '<div class="adv-thumb" aria-hidden="true"><svg class="n-icon adv-thumb-icon"><use href="#n-icon-' + modeIcon + '"></use></svg></div>' +
      '<div class="adv-info"><div class="adv-title">' + escapeHtml(adv.title || (adv.character.name + ' · ' + adv.theme)) + '</div>' +
      '<div class="adv-subline"><span class="adv-meta"><svg class="n-icon"><use href="#n-icon-' + modeIcon + '"></use></svg>' + modeLabel + '</span><span class="adv-meta">' + escapeHtml(adv.character.profession || '冒险者') + ' · Lv.' + (adv.character.level || 1) + '</span></div>' +
      '<div class="adv-teaser">' + escapeHtml(teaser) + '</div>' +
      '<div class="adv-subline adv-subline-secondary"><span class="adv-meta adv-status-' + (status === '进行中' ? 'active' : 'done') + '">' + status + '</span><span class="adv-meta">' + turns + ' 回合</span><span class="adv-meta">' + formatTime(adv.updatedAt || adv.createdAt) + '</span></div></div>' +
      '<div class="adv-actions">' +
      '<button class="adv-action-btn" title="编辑" aria-label="编辑冒险" onclick="event.stopPropagation(); showEditAdventureModal(\'' + adv.id + '\')"><svg class="n-icon"><use href="#n-icon-pencil"></use></svg></button>' +
      '<button class="adv-action-btn danger" title="删除" aria-label="删除冒险" onclick="event.stopPropagation(); deleteAdventureWithConfirm(\'' + adv.id + '\')"><svg class="n-icon"><use href="#n-icon-trash"></use></svg></button>' +
      '</div>' +
      introHtml +
      '</div>';
  }
  list.innerHTML = html;
  attachAdventureDrag(list);
}

/* 冒险列表拖拽排序 */
let _dragAdventureId = null;
function attachAdventureDrag(list) {
  if (!list) return;
  list.querySelectorAll('.adventure-item').forEach(function(it) {
    it.addEventListener('dragstart', function(e) {
      _dragAdventureId = it.dataset.id;
      it.classList.add('dragging');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', it.dataset.id); } catch (err) {} }
    });
    it.addEventListener('dragend', function() {
      _dragAdventureId = null;
      it.classList.remove('dragging');
      list.querySelectorAll('.adventure-item').forEach(function(x){ x.classList.remove('drag-over'); });
    });
    it.addEventListener('dragover', function(e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      it.classList.add('drag-over');
    });
    it.addEventListener('dragleave', function() {
      it.classList.remove('drag-over');
    });
    it.addEventListener('drop', function(e) {
      e.preventDefault();
      it.classList.remove('drag-over');
      reorderAdventures(_dragAdventureId, it.dataset.id);
    });
  });
}

function reorderAdventures(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  const arr = state.adventures;
  const from = arr.findIndex(function(a){ return a.id === fromId; });
  const to = arr.findIndex(function(a){ return a.id === toId; });
  if (from < 0 || to < 0) return;
  const moved = arr.splice(from, 1)[0];
  arr.splice(to, 0, moved);
  saveState();
  renderAdventureList();
}

/* ==================== 冒险 AI 介绍 / 美化 ==================== */
function safeParseJson(text) {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

/* 进入冒险后：仅在「尚无介绍 + 已有压缩上下文」时自动生成一次（省算力） */
function maybeGenerateAdventureIntro(adv) {
  if (!adv) return;
  if (adv.aiIntro) return;                  // 已有介绍则跳过
  if (!adv.contextSummary) return;         // 未压缩（无前情摘要）则不生成
  generateAdventureIntro(adv.id, false);
}

/* 基于压缩后的上下文（前情摘要）生成剧情大纲介绍；force=true 时忽略已有缓存（手动重新生成） */
async function generateAdventureIntro(advId, force) {
  const adv = state.adventures.find(a => a.id === advId);
  if (!adv) return;
  if (!force && adv.aiIntro) return;             // 已有介绍则不重复生成
  if (!adv.contextSummary) {                     // 没有压缩上下文就不生成
    renderAdventureList();
    return;
  }
  if (!state.apiConfig.apiKey && !state.apiConfig.endpoint) {
    adv.aiIntro = adv.aiIntro || { emoji: '📖', color: '#2EA7FF', title: '', intro: '（未配置 API，无法生成介绍）', generatedAt: Date.now() };
    renderAdventureList();
    return;
  }
  window._introGen = window._introGen || {};
  if (window._introGen[advId]) return;
  window._introGen[advId] = true;
  renderAdventureList();   /* 立刻显示「生成中…」 */
  try {
    const prompt = '根据下面这个文字冒险游戏的「前情摘要」，用一句话向玩家介绍当前的剧情大纲。\n前情摘要：\n' + adv.contextSummary +
      '\n严格只输出一行 JSON，不要任何额外文字，格式：' +
      '{"emoji":"一个代表当前剧情的emoji","color":"十六进制强调色如#2EA7FF","title":"8字以内剧情别名","intro":"30字以内一句话大纲，说明当前剧情进展与基调"}';
    const resp = await callLLM([{ role: 'user', content: prompt }]);
    const data = safeParseJson(resp) || {};
    adv.aiIntro = {
      emoji: (data.emoji || '📖').slice(0, 6),
      color: /^#[0-9a-fA-F]{6}$/.test(data.color || '') ? data.color : '#2EA7FF',
      title: (data.title || '').slice(0, 12),
      intro: (data.intro || '').slice(0, 60),
      generatedAt: Date.now(),
      fromSummary: true,
    };
    saveState();
  } catch (e) {
    console.error('生成冒险介绍失败:', e);
    const fb = adv.aiIntro || {};
    adv.aiIntro = { emoji: fb.emoji || '📖', color: fb.color || '#2EA7FF', title: fb.title || '', intro: '（生成失败，可重试）', generatedAt: Date.now() };
  } finally {
    window._introGen[advId] = false;
    renderAdventureList();
  }
}

function renderStory() {
  const storyArea = document.getElementById('storyArea');
  const adv = getCurrentAdventure();
  if (!adv || adv.conversationHistory.length <= 1) {
    storyArea.innerHTML = emptyStateHtml();
    document.getElementById('inputArea').style.display = 'none';
    document.getElementById('headerActions').style.display = 'none';
    return;
  }
  document.getElementById('inputArea').style.display = 'flex';
  document.getElementById('headerActions').style.display = 'flex';

  let html = '';
  let lastParsed = null;
  let roundNo = 0;

  for (let i = 1; i < adv.conversationHistory.length; i++) {
    const msg = adv.conversationHistory[i];

    if (msg.role === 'user') {
      roundNo++;
      html += '<div class="turn-row"><div class="narrative-col" style="display:flex;justify-content:center;padding:8px 0">' +
        '<span class="round-divider">⏺ 第 ' + roundNo + ' 回合</span></div><div class="annotation-col"></div></div>';
      html += '<div class="turn-row">' +
        '<div class="narrative-col">' +
        '<div class="message user">' +
        '<div class="msg-bubble user-bubble">' +
        '<div class="user-text">' + escapeHtml(msg.content) + '</div>' +
        '<div class="msg-actions">' +
        '<button class="msg-edit-btn" onclick="editMessageAt(' + i + ')">✎ 编辑</button>' +
        '<button class="msg-edit-btn" onclick="withdrawMessage(' + i + ')">↩ 撤回</button>' +
        '</div>' +
        '</div>' +
        '</div></div>' +
        '<div class="annotation-col"></div>' +
        '</div>';
    } else if (msg.role === 'assistant') {
      const parsed = parseGameResponse(msg.content);
      lastParsed = parsed;

      let annotHtml = '';
      for (const change of parsed.changes) {
        annotHtml += buildAnnotationCard(change);
      }

      /* 场景配图：如果已生成则显示 */
      let imageHtml = '';
      if (msg.sceneImage) {
        imageHtml = '<div class="scene-image-wrap">' +
          '<img src="' + escapeHtml(msg.sceneImage) + '" class="scene-image" alt="场景图" ' +
          'onclick="this.classList.toggle(\'expanded\')" ' +
          'onerror="this.parentElement.style.display=\'none\'">' +
          '<div class="scene-image-actions"><button class="msg-edit-btn" onclick="saveSceneImage(' + i + ')">💾 保存成图</button></div>' +
          '</div>';
      }

      /* 场景配图按钮 + 编辑按钮 */
      let actionBtns = '<button class="msg-edit-btn" onclick="editMessageAt(' + i + ')">✎ 编辑</button>';
      /* TTS 朗读键：仅在设置开启时内嵌于对话框每条 AI 叙事；朗读中显示「⏹ 停止」 */
      if ((state.apiConfig.extensions || {}).tts === true) {
        const speaking = (ttsSpeakingIndex === i);
        actionBtns = '<button class="msg-edit-btn" onclick="readNarrativeAloud(' + i + ')">' + (speaking ? '⏹ 停止' : '🔊 朗读') + '</button>' + actionBtns;
      }
      if (!msg.sceneImage && !msg.imageLoading) {
        actionBtns += '<button class="msg-edit-btn" onclick="generateSceneImage(' + i + ')">🖼 生成场景图</button>';
      }
      if (msg.imageLoading) {
        actionBtns += '<span class="img-loading-hint">🎨 正在用 Qwen-Image 生成场景图（约 60-90 秒）…</span>';
      }

      html += '<div class="turn-row">' +
        '<div class="narrative-col">' +
        '<div class="message">' +
        '<div class="ai-avatar">AI</div>' +
        '<div class="msg-bubble ai-bubble">' +
        '<div class="ai-name">AI 叙事者 ' + actionBtns + '</div>' +
        (msg.thinking ? '<details class="thinking-block"><summary>💭 AI 写手思考过程</summary><div class="thinking-content">' + escapeHtml(msg.thinking) + '</div></details>' : '') +
        '<div class="narrative-text">' + renderMarkdown(escapeHtml(sanitizeNarrative(parsed.narrative))) + '</div>' +
        imageHtml +
        '</div></div></div>' +
        '<div class="annotation-col">' + annotHtml + '</div>' +
        '</div>';

      if (adv.character.hp <= 0) {
        html += '<div class="turn-row"><div class="narrative-col" style="text-align:center;padding:20px">' +
          '<p style="font-size:18px;color:#FF5566;font-weight:700">角色已死亡</p>' +
          '<p style="font-size:13px;color:rgba(255,255,255,0.5);margin-top:8px">冒险结束，可以回退或读档重来</p>' +
          '<div style="display:flex;gap:8px;justify-content:center;margin-top:14px">' +
          '<button class="btn btn-secondary" onclick="undoLastTurn()">↩ 回到上一轮</button>' +
          '<button class="btn btn-secondary" onclick="showSnapshotsModal()">🗂 读取存档</button>' +
          '</div>' +
          '</div><div class="annotation-col"></div></div>';
        break;
      }
    } else if (msg.role === 'system' && msg.content.startsWith('【前情摘要】')) {
      html += '<div class="turn-row"><div class="narrative-col">' +
        '<div style="padding:8px 12px;border-radius:8px;background:rgba(18,222,212,0.06);border:1px solid rgba(18,222,212,0.15);font-size:11px;color:#12DED4">' +
        '⟳ 上下文已压缩 · 前情摘要已保留</div>' +
        '</div><div class="annotation-col"></div></div>';
    }
  }

  /* FIX: 确保选项在生成完成后才显示 */
  if (lastParsed && lastParsed.choices.length > 0 && adv.character.hp > 0 && !state.isGenerating) {
    html += '<div class="choices-container">';
    for (let j = 0; j < lastParsed.choices.length; j++) {
      html += '<button class="choice-btn" onclick="handleChoice(' + j + ')">' +
        '<span class="choice-arrow">→</span>' + escapeHtml(lastParsed.choices[j]) + '</button>';
    }
    html += '</div>';
  }

  storyArea.innerHTML = html;
  document.getElementById('adventureTitle').textContent = adv.title || (adv.character.name + ' · ' + adv.theme);
  document.getElementById('sceneTag').textContent = adv.character.location + ' · ' + adv.character.chapter;

  scrollToBottom();
}

function buildAnnotationCard(change) {
  if (change.type === 'hp') {
    const isDown = change.change < 0;
    const cls = isDown ? 'annot-hp-down' : 'annot-hp-up';
    const sign = change.change > 0 ? '+' : '';
    return '<div class="annotation-card ' + cls + '">' +
      '<span class="annot-icon">❤</span>' +
      '<span class="annot-value">HP ' + sign + change.change + '</span>' +
      (change.reason ? '<span class="annot-reason">' + escapeHtml(change.reason) + '</span>' : '') +
      '</div>';
  }
  if (change.type === 'mp') {
    const isDown = change.change < 0;
    const cls = isDown ? 'annot-mp-down' : 'annot-mp-up';
    const sign = change.change > 0 ? '+' : '';
    return '<div class="annotation-card ' + cls + '">' +
      '<span class="annot-icon">✦</span>' +
      '<span class="annot-value">MP ' + sign + change.change + '</span>' +
      (change.reason ? '<span class="annot-reason">' + escapeHtml(change.reason) + '</span>' : '') +
      '</div>';
  }
  if (change.type === 'item') {
    if (change.action === 'add') {
      return '<div class="annotation-card annot-item-add">' +
        '<span class="annot-icon">🔑</span>' +
        '<span class="annot-value">获得: ' + escapeHtml(change.item) + (change.qty > 1 ? ' x' + change.qty : '') + '</span>' +
        '</div>';
    } else {
      return '<div class="annotation-card annot-item-remove">' +
        '<span class="annot-icon">🗑</span>' +
        '<span class="annot-value">失去: ' + escapeHtml(change.item) + (change.qty > 1 ? ' x' + change.qty : '') + '</span>' +
        '</div>';
    }
  }
  if (change.type === 'mood') {
    return '<div class="annotation-card annot-mood">' +
      '<span class="annot-icon">😊</span>' +
      '<span class="annot-value">情绪 → ' + escapeHtml(change.mood) + '</span>' +
      (change.reason ? '<span class="annot-reason">' + escapeHtml(change.reason) + '</span>' : '') +
      '</div>';
  }
  if (change.type === 'skill_new') {
    return '<div class="annotation-card annot-skill-new">' +
      '<span class="annot-icon">⚡</span>' +
      '<span class="annot-value">新技能: ' + escapeHtml(change.name) + '</span>' +
      (change.desc ? '<span class="annot-reason">' + escapeHtml(change.desc) + '</span>' : '') +
      '</div>';
  }
  if (change.type === 'skill_up') {
    return '<div class="annotation-card annot-skill-up">' +
      '<span class="annot-icon">⬆</span>' +
      '<span class="annot-value">' + escapeHtml(change.name) + ' → Lv.' + change.newLevel + '</span>' +
      '</div>';
  }
  if (change.type === 'attr_up') {
    return '<div class="annotation-card annot-attr-up">' +
      '<span class="annot-icon">💪</span>' +
      '<span class="annot-value">' + escapeHtml(change.attr) + ' +' + change.value + '</span>' +
      (change.reason ? '<span class="annot-reason">' + escapeHtml(change.reason) + '</span>' : '') +
      '</div>';
  }
  if (change.type === 'exp') {
    return '<div class="annotation-card annot-exp">' +
      '<span class="annot-icon">★</span>' +
      '<span class="annot-value">EXP +' + change.value + '</span>' +
      (change.reason ? '<span class="annot-reason">' + escapeHtml(change.reason) + '</span>' : '') +
      '</div>';
  }
  if (change.type === 'level_up') {
    return '<div class="annotation-card annot-level-up">' +
      '<span class="annot-icon">🎉</span>' +
      '<span class="annot-value">升级! Lv.' + (change.newLevel || '?') + '</span>' +
      '<span class="annot-reason">+3属性点 +1技能点</span>' +
      '</div>';
  }
  if (change.type === 'skillpt') {
    return '<div class="annotation-card annot-skillpt">' +
      '<span class="annot-icon">⚡</span>' +
      '<span class="annot-value">技能点 +' + change.value + '</span>' +
      '</div>';
  }
  if (change.type === 'attrpt') {
    return '<div class="annotation-card annot-attrpt">' +
      '<span class="annot-icon">💪</span>' +
      '<span class="annot-value">属性点 +' + change.value + '</span>' +
      '</div>';
  }
  return '';
}

function renderCharacterPanel() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  const c = adv.character;

  document.getElementById('charName').textContent = c.name;
  document.getElementById('charProfession').textContent = c.profession;
  document.getElementById('charProfession').style.display = c.profession ? 'inline-block' : 'none';

  /* Mood */
  const moodWrap = document.getElementById('charMoodWrap');
  if (c.mood) {
    moodWrap.style.display = 'flex';
    document.getElementById('charMood').textContent = c.mood;
  } else {
    moodWrap.style.display = 'none';
  }

  /* Level / EXP */
  const levelWrap = document.getElementById('charLevelWrap');
  levelWrap.style.display = 'flex';
  document.getElementById('charLevel').textContent = 'Lv.' + c.level;
  const expPct = c.maxExp > 0 ? (c.exp / c.maxExp * 100) : 0;
  document.getElementById('expBar').style.width = expPct + '%';
  document.getElementById('expText').textContent = c.exp + '/' + c.maxExp;

  /* HP / MP */
  const hpPct = c.hp / c.maxHp * 100;
  const hpBar = document.getElementById('hpBar');
  hpBar.style.width = hpPct + '%';
  document.getElementById('hpValue').textContent = c.hp + '/' + c.maxHp;
  /* HP 临界预警 */
  if (hpPct <= 15 && c.hp > 0) {
    hpBar.style.background = 'linear-gradient(90deg,#FF0000,#FF5566)';
    hpBar.style.animation = 'hpCritical 0.8s infinite';
    document.getElementById('hpValue').style.color = '#FF5566';
    document.getElementById('hpValue').style.fontWeight = '700';
  } else if (hpPct <= 30 && c.hp > 0) {
    hpBar.style.background = 'linear-gradient(90deg,#FF5566,#FFB859)';
    hpBar.style.animation = '';
    document.getElementById('hpValue').style.color = '#FFB859';
    document.getElementById('hpValue').style.fontWeight = '600';
  } else {
    hpBar.style.background = 'linear-gradient(90deg,#FF5566,#FFB859)';
    hpBar.style.animation = '';
    document.getElementById('hpValue').style.color = '';
    document.getElementById('hpValue').style.fontWeight = '';
  }
  document.getElementById('mpBar').style.width = (c.mp / c.maxMp * 100) + '%';
  document.getElementById('mpValue').textContent = c.mp + '/' + c.maxMp;
  document.getElementById('charLocation').textContent = c.location;
  document.getElementById('charChapter').textContent = c.chapter;

  /* Inventory */
  var inv = document.getElementById('inventory');
  if (c.items.length === 0) {
    inv.innerHTML = '<div class="empty-text">空空如也</div>';
  } else {
    inv.innerHTML = c.items.map(function(item, i) {
      return '<div class="inv-item usable" title="' + escapeHtml(item.desc || '点击使用') + '" ' +
        'onclick="useInventoryItem(' + i + ')">' +
        escapeHtml(item.name) +
        (item.qty > 1 ? ' <span class="inv-qty">x' + item.qty + '</span>' : '') +
        '</div>';
    }).join('');
  }

  /* Attributes */
  renderAttributesPanel(c);
  /* Skills */
  renderSkillsPanel(c);
  /* Quests */
  renderQuestsPanel(adv);
  /* Combat */
  renderCombatPanel(adv);

  /* 酒馆模式：隐藏数值系统，显示人物状态（情绪/好感度/关系） */
  const tavernRelSection = document.getElementById('tavernRelationsSection');
  if (adv.mode === 'tavern') {
    for (const id of ['charLevelWrap', 'hpWrap', 'mpWrap', 'attributesSection', 'skillsSection', 'inventorySection']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    const relList = document.getElementById('tavernRelationsList');
    if (tavernRelSection && relList) {
      const affs = adv.affections || {};
      const rels = adv.relations || {};
      const names = Array.from(new Set([].concat(Object.keys(affs), Object.keys(rels))));
      let html;
      if (names.length === 0) {
        html = '<div class="empty-text">暂无关系数据，剧情推进后自动生成</div>';
      } else {
        html = names.map(function(n) {
          return '<div class="tavern-rel"><span class="tavern-rel-name">' + escapeHtml(n) + '</span>' +
            (affs[n] != null ? '<span class="tavern-aff">好感 ' + affs[n] + '</span>' : '') +
            (rels[n] ? '<div class="tavern-rel-desc">' + escapeHtml(rels[n]) + '</div>' : '') +
            '</div>';
        }).join('');
      }
      relList.innerHTML = html;
      tavernRelSection.style.display = 'block';
    }
  } else if (tavernRelSection) {
    tavernRelSection.style.display = 'none';
  }
}

function renderQuestsPanel(adv) {
  const section = document.getElementById('questsSection');
  const list = document.getElementById('questsList');
  /* 任务栏被隐藏时不显示（用户可点头部「📋 任务」恢复） */
  if (adv.hideQuests) { section.style.display = 'none'; return; }
  if (!adv.quests || adv.quests.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  let html = '';
  for (const q of adv.quests) {
    const statusCls = q.status || 'active';
    const statusText = statusCls === 'completed' ? '已完成' : statusCls === 'failed' ? '失败' : '进行中';
    html += '<div class="quest-item ' + statusCls + '">' +
      '<div class="quest-head"><span class="quest-status ' + statusCls + '">' + statusText + '</span>' +
      '<span class="quest-name">' + escapeHtml(q.name) + '</span>' +
      '<button class="quest-del-btn" onclick="deleteQuest(' + JSON.stringify(q.name) + ')" title="删除该任务">✕</button></div>' +
      (q.desc ? '<div class="quest-desc">' + escapeHtml(q.desc) + '</div>' : '') +
      '</div>';
  }
  list.innerHTML = html;
}

function renderCombatPanel(adv) {
  const section = document.getElementById('combatSection');
  const panel = document.getElementById('combatPanel');
  const roundEl = document.getElementById('combatRound');
  if (adv.mode === 'tavern') {
    if (section) section.style.display = 'none';
    return;
  }
  if (!adv.combat || !adv.combat.active || adv.combat.enemies.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  roundEl.textContent = '回合 ' + adv.combat.round;
  let html = '';
  for (const enemy of adv.combat.enemies) {
    const hpPct = enemy.maxHp > 0 ? (enemy.hp / enemy.maxHp * 100) : 0;
    html += '<div class="enemy-card">' +
      '<div class="enemy-name">' + escapeHtml(enemy.name) + '</div>' +
      '<div class="enemy-hp-bar">' +
      '<div class="enemy-hp-track"><div class="enemy-hp-fill" style="width:' + hpPct + '%"></div></div>' +
      '<span class="enemy-hp-text">' + enemy.hp + '/' + enemy.maxHp + '</span>' +
      '</div>' +
      '<div class="enemy-stats">' +
      (enemy.attack ? '<span>ATK ' + enemy.attack + '</span>' : '') +
      (enemy.defense ? '<span>DEF ' + enemy.defense + '</span>' : '') +
      '</div>' +
      '</div>';
  }
  panel.innerHTML = html;
}

function renderAttributesPanel(c) {
  const section = document.getElementById('attributesSection');
  const grid = document.getElementById('attributesGrid');
  const badge = document.getElementById('attrPointsBadge');

  section.style.display = 'block';
  badge.textContent = c.attributePoints;
  badge.style.display = c.attributePoints > 0 ? 'inline-flex' : 'none';

  let html = '';
  for (const [name, value] of Object.entries(c.attributes)) {
    html += '<div class="attr-row">' +
      '<span class="attr-name">' + name + '</span>' +
      '<span class="attr-value">' + value + '</span>' +
      '<button class="attr-plus-btn" ' + (c.attributePoints > 0 ? '' : 'disabled') +
      ' onclick="allocateAttribute(\'' + name + '\')">+</button>' +
      '</div>';
  }
  grid.innerHTML = html;
}

function renderSkillsPanel(c) {
  const section = document.getElementById('skillsSection');
  const list = document.getElementById('skillsList');
  const badge = document.getElementById('skillPointsBadge');

  section.style.display = 'block';
  badge.textContent = c.skillPoints;
  badge.style.display = c.skillPoints > 0 ? 'inline-flex' : 'none';

  if (c.skills.length === 0) {
    list.innerHTML = '<div class="skills-empty">暂无技能</div>';
    return;
  }

  let html = '';
  for (let i = 0; i < c.skills.length; i++) {
    const skill = c.skills[i];
    html += '<div class="skill-item">' +
      '<div class="skill-info">' +
      '<div class="skill-name">' + escapeHtml(skill.name) + '</div>' +
      '<div class="skill-desc">' + escapeHtml(skill.desc || '') + '</div>' +
      '</div>' +
      '<span class="skill-level">Lv.' + skill.level + '</span>' +
      '<button class="skill-plus-btn" ' + (c.skillPoints > 0 ? '' : 'disabled') +
      ' onclick="allocateSkill(' + i + ')">+</button>' +
      '</div>';
  }
  list.innerHTML = html;
}

function allocateAttribute(attrName) {
  const adv = getCurrentAdventure();
  if (!adv || adv.character.attributePoints <= 0) return;
  adv.character.attributes[attrName] = (adv.character.attributes[attrName] || 0) + 1;
  adv.character.attributePoints--;
  updateSystemPrompt(adv);
  saveState();
  renderCharacterPanel();
}

function allocateSkill(index) {
  const adv = getCurrentAdventure();
  if (!adv || adv.character.skillPoints <= 0) return;
  const skill = adv.character.skills[index];
  if (!skill) return;
  skill.level++;
  adv.character.skillPoints--;
  updateSystemPrompt(adv);
  saveState();
  renderCharacterPanel();
}

function renderContextBar() {
  const adv = getCurrentAdventure();
  if (!adv) {
    updateContextBar(0, state.apiConfig.maxTokens || 8000, '等待开始...');
    return;
  }
  const tokens = getConversationTokens(adv.conversationHistory);
  const max = state.apiConfig.maxTokens || 8000;
  const status = adv.contextCompressed ? '已压缩' : '正常';
  updateContextBar(tokens, max, status);
  const msgCount = adv.conversationHistory.filter(m => m.role === 'user' || m.role === 'assistant').length;
  const meta = document.getElementById('contextMeta');
  if (meta) {
    const stats = adv.stats || {};
    meta.innerHTML = '对话轮次: ' + Math.floor(msgCount / 2) + '<br>消息数: ' + msgCount + '<br>' +
      (adv.contextSummary ? '前情摘要: 已生成' : '前情摘要: 无') + '<br>' +
      '角色卡: ' + (adv.characterCards?.length || 0) + ' 张<br>' +
      '设定书: ' + (adv.backgroundBooks?.length || 0) + ' 本<br>' +
      '人物图鉴: ' + ((adv.mandalaCards && adv.mandalaCards.length) || 0) + ' 人<br>' +
      '回合: ' + (stats.turns || 0) + ' · 死亡: ' + (stats.deaths || 0) + '<br>' +
      '存档: ' + ((adv.snapshots && adv.snapshots.length) || 0) + ' · 分支: ' + ((adv.branches && adv.branches.length) || 0);
  }
}

function updateContextBar(used, max, status) {
  const bar = document.getElementById('contextBar');
  const text = document.getElementById('contextText');
  const stat = document.getElementById('contextStatus');
  if (bar) {
    const pct = Math.min(100, used / max * 100);
    bar.style.width = pct + '%';
    if (pct > 80) bar.style.background = 'linear-gradient(90deg,#FFB859,#FF5566)';
    else if (pct > 60) bar.style.background = 'linear-gradient(90deg,#FFB859,#12DED4)';
    else bar.style.background = 'linear-gradient(90deg,#12DED4,#2EA7FF)';
  }
  if (text) text.textContent = used + ' / ' + max + ' tokens';
  if (stat) {
    stat.textContent = status;
    stat.style.color = status === '正常' ? '#12DED4' : status === '已压缩' ? '#4ADE80' : '#FFB859';
  }
}

/* ===== 前情摘要编辑：把压缩后的上下文展示给用户修改 ===== */
function showContextSummaryModal() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  const input = document.getElementById('contextSummaryInput');
  const statusEl = document.getElementById('contextSummaryStatus');
  if (input) input.value = adv.contextSummary || '';
  if (statusEl) {
    if (adv.contextSummary) {
      statusEl.innerHTML = '状态：<b style="color:#4ADE80">已压缩</b> · 以下为当前生效的前情摘要，可直接修改';
    } else {
      statusEl.innerHTML = '状态：<b style="color:#FFB859">尚未压缩</b> · 这里还是空的，可在下方手动写入一条前情摘要';
    }
  }
  updateSummaryCounter();
  showModal('contextSummaryModal');
}

function updateSummaryCounter() {
  const input = document.getElementById('contextSummaryInput');
  const counter = document.getElementById('contextSummaryCounter');
  if (!input || !counter) return;
  const len = input.value.length;
  const tokens = estimateTokens(input.value);
  counter.textContent = '字符: ' + len + ' · 约 ' + tokens + ' tokens';
}

function saveContextSummary() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  const input = document.getElementById('contextSummaryInput');
  if (!input) return;
  const newSummary = input.value.replace(/\s+$/, '');
  adv.contextSummary = newSummary.length > 0 ? newSummary : null;

  /* 同步到对话历史中的【前情摘要】系统消息 */
  if (newSummary.length > 0) {
    const sysContent = '【前情摘要】\n' + newSummary;
    let replaced = false;
    if (adv.conversationHistory && adv.conversationHistory.length) {
      for (let i = 0; i < adv.conversationHistory.length; i++) {
        const m = adv.conversationHistory[i];
        if (m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('【前情摘要】')) {
          m.content = sysContent;
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        /* 没有现成的摘要消息时，插到 system 首条之后 */
        const insertAt = adv.conversationHistory[0] && adv.conversationHistory[0].role === 'system' ? 1 : 0;
        adv.conversationHistory.splice(insertAt, 0, { role: 'system', content: sysContent });
        adv.contextCompressed = true;
      }
    }
  } else {
    /* 清空摘要时，移除历史中的【前情摘要】系统消息 */
    if (adv.conversationHistory) {
      adv.conversationHistory = adv.conversationHistory.filter(m =>
        !(m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('【前情摘要】')));
    }
    adv.contextCompressed = false;
  }

  saveState();
  renderContextBar();
  closeModal('contextSummaryModal');
}

function renderAll() {
  /* 各渲染器独立容错：某个渲染器抛错不会阻断其余面板刷新 */
  /* 先刷新右侧栏数值，避免被耗时的 renderStory 全量重渲染拖慢 */
  try { renderCharacterPanel(); } catch (e) { console.error('renderCharacterPanel 失败:', e); }
  try { renderStory(); } catch (e) { console.error('renderStory 失败:', e); }
  try { renderContextBar(); } catch (e) { console.error('renderContextBar 失败:', e); }
  try { renderAdventureList(); } catch (e) { console.error('renderAdventureList 失败:', e); }
  try { renderCombatActionBar(); } catch (e) { console.error('renderCombatActionBar 失败:', e); }
  try { applyChatBackground(); } catch (e) { console.error('applyChatBackground 失败:', e); }
  try { refreshMandalaUI(); } catch (e) { console.error('refreshMandalaUI 失败:', e); }
  /* 酒馆模式隐藏战斗与骰子 UI */
  const adv = getCurrentAdventure();
  const diceBtn = document.getElementById('diceBtn');
  if (diceBtn) diceBtn.style.display = (adv && adv.mode === 'tavern') ? 'none' : '';
  const combatSection = document.getElementById('combatSection');
  if (combatSection && adv && adv.mode === 'tavern') combatSection.style.display = 'none';
}

function showTypingIndicator() {
  const storyArea = document.getElementById('storyArea');
  const div = document.createElement('div');
  div.className = 'turn-row';
  div.id = 'typingRow';
  div.innerHTML = '<div class="narrative-col">' +
    '<div class="message">' +
    '<div class="ai-avatar">AI</div>' +
    '<div class="msg-bubble ai-bubble" style="display:flex;align-items:center">' +
    '<div class="typing-dots"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>' +
    '</div></div></div>' +
    '<div class="annotation-col"></div>';
  storyArea.appendChild(div);
  scrollToBottom();
}

function hideTypingIndicator() {
  const row = document.getElementById('typingRow');
  if (row) row.remove();
}

function scrollToBottom() {
  const storyArea = document.getElementById('storyArea');
  storyArea.scrollTop = storyArea.scrollHeight;
}

/* ==================== Agent 状态面板 ==================== */
function toggleAgentState() {
  const drawer = document.getElementById('agentStateDrawer');
  if (drawer.style.display === 'none' || !drawer.style.display) {
    const timelineDrawer = document.getElementById('timelineDrawer');
    if (timelineDrawer) timelineDrawer.style.display = 'none';
    renderAgentState();
    drawer.style.display = 'flex';
  } else {
    drawer.style.display = 'none';
  }
}

function renderAgentState() {
  const adv = getCurrentAdventure();
  const body = document.getElementById('agentStateBody');
  if (!adv) {
    body.innerHTML = '<p style="color:rgba(255,255,255,0.4)">尚无数据</p>';
    return;
  }
  const sysContent = adv.conversationHistory[0]?.content || '';
  let msgListHtml = '';
  for (const msg of adv.conversationHistory) {
    if (msg.role === 'system' && msg.content.startsWith('【前情摘要】')) {
      msgListHtml += '<div class="state-msg-item"><span class="state-msg-role" style="color:#12DED4">摘要</span>' +
        '<span class="state-msg-content">' + escapeHtml(msg.content) + '</span></div>';
    } else if (msg.role === 'system') {
      continue;
    } else {
      msgListHtml += '<div class="state-msg-item"><span class="state-msg-role">' +
        (msg.role === 'user' ? '玩家' : 'AI') + '</span>' +
        '<span class="state-msg-content">' + escapeHtml(msg.content.substring(0, 200)) + (msg.content.length > 200 ? '...' : '') + '</span></div>';
    }
  }
  const tokens = getConversationTokens(adv.conversationHistory);
  const max = state.apiConfig.maxTokens || 8000;

  body.innerHTML =
    '<div class="state-section">' +
    '<h4>当前角色状态</h4>' +
    '<div class="state-content">' + escapeHtml(JSON.stringify(adv.character, null, 2)) + '</div>' +
    '</div>' +
    '<div class="state-section">' +
    '<h4>System Prompt (含实时状态)</h4>' +
    '<div class="state-content">' + escapeHtml(sysContent) + '</div>' +
    '</div>' +
    '<div class="state-section">' +
    '<h4>角色卡 (' + (adv.characterCards?.length || 0) + ')</h4>' +
    '<div class="state-content">' + (adv.characterCards?.length ? escapeHtml(adv.characterCards.map(c => c.name + ': ' + (c.relationship||'未知')).join('\n')) : '无') + '</div>' +
    '</div>' +
    '<div class="state-section">' +
    '<h4>设定书 (' + (adv.backgroundBooks?.length || 0) + ')</h4>' +
    '<div class="state-content">' + (adv.backgroundBooks?.length ? escapeHtml(adv.backgroundBooks.map(b => b.title).join('\n')) : '无') + '</div>' +
    '</div>' +
    '<div class="state-section">' +
    '<h4>上下文 Token 统计</h4>' +
    '<div class="state-content">' +
    '已用: ' + tokens + ' / ' + max + ' tokens (' + Math.round(tokens / max * 100) + '%)\n' +
    '消息数: ' + adv.conversationHistory.length + '\n' +
    '压缩: ' + (adv.contextCompressed ? '是' : '否') + '\n' +
    '前情摘要: ' + (adv.contextSummary ? '已生成' : '无') +
    '</div></div>' +
    '<div class="state-section">' +
    '<h4>对话历史</h4>' +
    '<div class="state-msg-list">' + msgListHtml + '</div>' +
    '</div>';
}

/* ==================== 提示词编辑器 ==================== */
function showPromptEditor() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  const textarea = document.getElementById('promptEditorText');
  /* 显示当前 system prompt 的基础部分（不含实时状态，因为那部分每次自动生成） */
  /* 实际显示完整 prompt 让用户看到全貌 */
  textarea.value = adv.conversationHistory[0]?.content || buildSystemPrompt(adv);
  showModal('promptEditorModal');
}

function savePrompt() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  const text = document.getElementById('promptEditorText').value.trim();
  if (text) {
    /* 用户编辑的完整 prompt 保存为覆盖版；角色卡/设定书/实时状态等自动区块会在每轮刷新，其余修改保留 */
    adv.customPrompt = text;
    updateSystemPrompt(adv);
    saveState();
  }
  closeModal('promptEditorModal');
}

function resetPrompt() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  adv.customPrompt = '';
  updateSystemPrompt(adv);
  saveState();
  document.getElementById('promptEditorText').value = adv.conversationHistory[0].content;
}

/* ==================== 角色卡管理 ==================== */
function showCharacterCards() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  renderCharacterCardsList();
  /* 清空表单 */
  ['newCardName','newCardAppearance','newCardPersonality','newCardRelationship','newCardNotes'].forEach(id => {
    document.getElementById(id).value = '';
  });
  showModal('characterCardsModal');
  /* 绑定「从文件导入」到当前冒险 */
  const imp = document.getElementById('cardImportInput2');
  if (imp) imp.onchange = function(e) {
    const f = e.target.files && e.target.files[0];
    if (f) importCardToAdventure(f);
    e.target.value = '';
  };
}

function renderCharacterCardsList() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  const container = document.getElementById('characterCardsList');
  if (!adv.characterCards || adv.characterCards.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">暂无角色卡</div>';
    return;
  }
  let html = '';
  for (let i = 0; i < adv.characterCards.length; i++) {
    const card = adv.characterCards[i];
    const present = card.present !== false;
    const talk = (typeof card.talkativeness === 'number') ? card.talkativeness : 50;
    html += '<div class="card-item">' +
      '<div class="card-item-header">' +
      '<span class="card-item-name">' + escapeHtml(card.name) + '</span>' +
      '<button class="card-item-remove" onclick="removeCharacterCard(' + i + ')">&times;</button>' +
      '</div>' +
      (card.appearance ? '<div class="card-item-detail"><span>外貌：</span>' + escapeHtml(card.appearance) + '</div>' : '') +
      (card.personality ? '<div class="card-item-detail"><span>性格：</span>' + escapeHtml(card.personality) + '</div>' : '') +
      (card.relationship ? '<div class="card-item-detail"><span>关系：</span>' + escapeHtml(card.relationship) + '</div>' : '') +
      (card.tags && card.tags.length ? '<div class="card-item-detail"><span>标签：</span>' + escapeHtml(card.tags.join('、')) + '</div>' : '') +
      (card.notes ? '<div class="card-item-detail"><span>备注：</span>' + escapeHtml(card.notes) + '</div>' : '') +
      (card.first_mes ? '<div class="card-item-detail"><span>开场白：</span>' + escapeHtml(String(card.first_mes).replace(/\s*\n\s*/g, ' ').substring(0, 120)) + '</div>' : '') +
      '<div class="card-item-detail card-item-scene">' +
        '<label class="switch-row inline"><input type="checkbox" ' + (present ? 'checked' : '') + ' onchange="setNpcPresent(\'' + escapeHtml(card.name).replace(/'/g, "\\'") + '\', this.checked)"> 在场</label>' +
        '<span class="talk-slider">话痨度 <input type="range" min="0" max="100" value="' + talk + '" onchange="setNpcTalkativeness(\'' + escapeHtml(card.name).replace(/'/g, "\\'") + '\', this.value)" oninput="setNpcTalkativeness(\'' + escapeHtml(card.name).replace(/'/g, "\\'") + '\', this.value); var _b=this.parentNode.querySelector(\'b\'); if(_b)_b.textContent=this.value;"> <b>' + talk + '</b></span>' +
      '</div>' +
      '</div>';
  }
  container.innerHTML = html;
}

function addCharacterCard() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  const name = document.getElementById('newCardName').value.trim();
  if (!name) { alert('请输入角色名称'); return; }
  const card = {
    name: name,
    appearance: document.getElementById('newCardAppearance').value.trim(),
    personality: document.getElementById('newCardPersonality').value.trim(),
    relationship: document.getElementById('newCardRelationship').value.trim(),
    notes: document.getElementById('newCardNotes').value.trim(),
    scenario: document.getElementById('newCardScenario').value.trim(),
    tags: document.getElementById('newCardTags').value.split(/[,，、]/).map(s => s.trim()).filter(Boolean),
    first_mes: document.getElementById('newCardFirstMes').value.trim(),
    character_note: document.getElementById('newCardCharacterNote').value.trim(),
    system_prompt: document.getElementById('newCardSystemPrompt').value.trim(),
    post_history_instructions: document.getElementById('newCardPostHist').value.trim(),
    alternate_greetings: document.getElementById('newCardAltGreetings').value.trim().split(/\n+/).map(s => s.trim()).filter(Boolean),
    talkativeness: parseInt(document.getElementById('newCardTalkativeness').value) || 50,
    present: true,
  };
  if (!adv.characterCards) adv.characterCards = [];
  adv.characterCards.push(card);
  updateSystemPrompt(adv);
  saveState();
  renderCharacterCardsList();
  /* 清空表单 */
  ['newCardName','newCardAppearance','newCardPersonality','newCardRelationship','newCardNotes','newCardScenario','newCardTags','newCardFirstMes','newCardCharacterNote','newCardSystemPrompt','newCardPostHist','newCardAltGreetings'].forEach(id => {
    document.getElementById(id).value = '';
  });
}

function removeCharacterCard(index) {
  const adv = getCurrentAdventure();
  if (!adv) return;
  adv.characterCards.splice(index, 1);
  updateSystemPrompt(adv);
  saveState();
  renderCharacterCardsList();
}

/* ==================== 设定书管理 ==================== */
function showBackgroundBooks() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  renderBackgroundBooksList();
  document.getElementById('newBookTitle').value = '';
  document.getElementById('newBookContent').value = '';
  document.getElementById('bookFileInput').value = '';
  showModal('backgroundBooksModal');

  /* 文件上传监听 */
  const fileInput = document.getElementById('bookFileInput');
  fileInput.onchange = function(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(ev) {
      document.getElementById('newBookTitle').value = file.name.replace(/\.(txt|md)$/i, '');
      document.getElementById('newBookContent').value = ev.target.result;
    };
    reader.readAsText(file, 'UTF-8');
  };
}

function renderBackgroundBooksList() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  const container = document.getElementById('backgroundBooksList');
  if (!adv.backgroundBooks || adv.backgroundBooks.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">暂无设定书</div>';
    return;
  }
  let html = '';
  for (let i = 0; i < adv.backgroundBooks.length; i++) {
    const book = adv.backgroundBooks[i];
    html += '<div class="book-item">' +
      '<div class="book-item-header">' +
      '<span class="book-item-title">' + escapeHtml(book.title) + '</span>' +
      '<button class="book-item-remove" onclick="removeBackgroundBook(' + i + ')">&times;</button>' +
      '</div>' +
      '<div class="book-item-preview">' + escapeHtml(book.content.substring(0, 300)) + (book.content.length > 300 ? '...' : '') + '</div>' +
      '</div>';
  }
  container.innerHTML = html;
}

function addBackgroundBook() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  const title = document.getElementById('newBookTitle').value.trim();
  const content = document.getElementById('newBookContent').value.trim();
  if (!title || !content) { alert('请填写标题和内容'); return; }
  if (!adv.backgroundBooks) adv.backgroundBooks = [];
  adv.backgroundBooks.push({ title, content });
  updateSystemPrompt(adv);
  saveState();
  renderBackgroundBooksList();
  document.getElementById('newBookTitle').value = '';
  document.getElementById('newBookContent').value = '';
  document.getElementById('bookFileInput').value = '';
}

function removeBackgroundBook(index) {
  const adv = getCurrentAdventure();
  if (!adv) return;
  adv.backgroundBooks.splice(index, 1);
  updateSystemPrompt(adv);
  saveState();
  renderBackgroundBooksList();
}

/* ==================== 流式输出 ==================== */
function showStreamingBubble() {
  const storyArea = document.getElementById('storyArea');
  const row = document.createElement('div');
  row.className = 'turn-row';
  row.id = 'streamRow';
  row.innerHTML = '<div class="narrative-col">' +
    '<div class="message">' +
    '<div class="ai-avatar">AI</div>' +
    '<div class="msg-bubble ai-bubble">' +
    '<div class="ai-name">AI 叙事者</div>' +
    '<details class="thinking-block thinking-stream" style="display:none"><summary>💭 AI 写手思考过程</summary><div class="thinking-content"></div></details>' +
    '<div class="narrative-text stream-text"></div>' +
    '</div></div></div>' +
    '<div class="annotation-col"></div>';
  row._streamBuffer = '';
  storyArea.appendChild(row);
  scrollToBottom();
  return row;
}

function appendStreamChunk(row, chunk) {
  if (!row) return;
  const el = row.querySelector('.stream-text');
  if (el) {
    row._streamBuffer = (row._streamBuffer || '') + chunk;
    el.textContent = cleanStreamText(row._streamBuffer);
    const storyArea = document.getElementById('storyArea');
    if (storyArea.scrollHeight - storyArea.scrollTop - storyArea.clientHeight < 120) {
      scrollToBottom();
    }
    /* 流式期间：一旦检测到完整的 [STATE]，立即预览右侧面板。
       [STATE] 是绝对值（每轮覆盖为最新），提前应用与完成时 applyParsedResult 幂等，不会重复计算。 */
    if (!row._statePreviewed) {
      var buf = row._streamBuffer || '';
      var stateStart = buf.indexOf('[STATE]');
      if (stateStart !== -1) {
        var afterState = buf.slice(stateStart + 7);
        /* [STATE] 之后出现下一个区块标签，说明 STATE 已完整接收 */
        if (afterState.search(/\[(CHANGES|CHOICES|QUESTS|COMBAT|CHARACTERS|PLOT)\]/) !== -1) {
          try {
            var parsed = parseGameResponse(buf);
            if (parsed.state && (parsed.state.hp !== undefined || parsed.state.mp !== undefined || parsed.state.location || parsed.state.mood || parsed.state.chapter)) {
              applyStatePreview(parsed.state);
              row._statePreviewed = true;
            }
          } catch (e) { /* 预览失败不影响主流程，完成时仍会正常应用 */ }
        }
      }
    }
  }
}

/* 流式期间的右侧面板预览：只应用 [STATE] 绝对值，不动 [CHANGES]/物品/任务/战斗（留给完成阶段） */
function applyStatePreview(statePartial) {
  var adv = getCurrentAdventure();
  if (!adv || !adv.character) return;
  var c = adv.character;
  if (statePartial.hp !== undefined) c.hp = statePartial.hp;
  if (statePartial.maxHp !== undefined) c.maxHp = statePartial.maxHp;
  if (statePartial.mp !== undefined) c.mp = statePartial.mp;
  if (statePartial.maxMp !== undefined) c.maxMp = statePartial.maxMp;
  if (statePartial.location) c.location = statePartial.location;
  if (statePartial.chapter) c.chapter = statePartial.chapter;
  if (statePartial.profession) c.profession = statePartial.profession;
  if (statePartial.mood) c.mood = statePartial.mood;
  if (statePartial.affections) {
    if (!adv.affections) adv.affections = {};
    Object.assign(adv.affections, statePartial.affections);
  }
  try { renderCharacterPanel(); } catch (e) { /* ignore */ }
}

function removeStreamBubble(row) {
  if (row && row.parentNode) row.parentNode.removeChild(row);
}

function updateThinkingBubble(row, text) {
  if (!row) return;
  const wrap = row.querySelector('.thinking-stream');
  if (!wrap) return;
  wrap.style.display = 'block';
  wrap.open = true;
  wrap.querySelector('summary').textContent = '💭 AI 写手思考过程';
  wrap.querySelector('.thinking-content').textContent = text;
}

/* ===== 右栏 Tab 切换 ===== */
function switchRightTab(tab) {
  const tabs = document.querySelectorAll('.rp-tab');
  const bodies = document.querySelectorAll('.rp-body');
  tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === tab); });
  bodies.forEach(function (b) { b.classList.toggle('active', b.id === 'rp-' + tab); });
  try { localStorage.setItem('adventureAI_rightTab', tab); } catch (e) { /* ignore */ }
}
function initRightTab() {
  let saved = '';
  try { saved = localStorage.getItem('adventureAI_rightTab') || ''; } catch (e) { /* ignore */ }
  if (saved && document.querySelector('.rp-tab[data-tab="' + saved + '"]')) switchRightTab(saved);
}
function viewTool(tab, fn) {
  switchRightTab(tab);
  if (typeof fn === 'function') fn();
}

/* ===== 创作下拉 ===== */
function toggleCreateMenu(e) {
  if (e) e.stopPropagation();
  const m = document.getElementById('createMenu');
  if (m) m.classList.toggle('open');
}
document.addEventListener('click', function () {
  const m = document.getElementById('createMenu');
  if (m) m.classList.remove('open');
});

/* ===== 命令面板 (Ctrl/Cmd+K) ===== */
/* ===== v4 P0-3: 本地 Profile（纯本地，无云端）===== */
const DEFAULT_PROFILE = {
  nickname: '',
  theme: '中性',          // v4 第三套中性为默认
  nsfw: false,
  defaultPresetId: 'explore',
  createdAt: null,
};
function ensureProfile() {
  if (typeof state === 'undefined') return;
  if (!state.userProfile || typeof state.userProfile !== 'object') {
    state.userProfile = Object.assign({}, DEFAULT_PROFILE);
  } else {
    state.userProfile = Object.assign({}, DEFAULT_PROFILE, state.userProfile);
  }
  if (!state.currentPresetId) state.currentPresetId = state.userProfile.defaultPresetId || DEFAULT_PROFILE.defaultPresetId;
}
function getUserProfile() {
  if (!state.userProfile) state.userProfile = Object.assign({}, DEFAULT_PROFILE);
  return state.userProfile;
}
function setUserProfile(patch) {
  if (!patch || typeof patch !== 'object') return;
  state.userProfile = Object.assign({}, getUserProfile(), patch);
  if (typeof saveState === 'function') saveState();
}
function exportProfile() {
  return JSON.stringify({ userProfile: getUserProfile(), currentPresetId: state.currentPresetId, version: 1 }, null, 2);
}
function importProfile(jsonStr) {
  try {
    var data = JSON.parse(jsonStr);
    if (data && data.userProfile) {
      state.userProfile = Object.assign({}, DEFAULT_PROFILE, data.userProfile);
      state.currentPresetId = data.currentPresetId || state.userProfile.defaultPresetId;
      if (typeof saveState === 'function') saveState();
      if (typeof initPresets === 'function') initPresets();
      return true;
    }
  } catch (e) { console.error('[profile] import failed:', e); }
  return false;
}

const UI_COMMANDS = [
  { icon: '💾', label: '保存存档点', fn: showSnapshotsModal, groups: ['dialogue','version'] },
  { icon: '🚀', label: '导出 Denova', fn: exportToDenova, groups: ['writing'] },
  { icon: '🎮', label: '离线小说游戏', fn: function () { GameEngine.open(); }, groups: ['game'] },
  { icon: '👥', label: '角色卡管理', fn: showCharacterCards, groups: ['dialogue','setting'] },
  { icon: '📚', label: '设定书管理', fn: showBackgroundBooks, groups: ['setting'] },
  { icon: '✏', label: '提示词编辑', fn: showPromptEditor, groups: ['dialogue','setting'] },
  { icon: '📖', label: '生成小说', fn: showNovelExportModal, groups: ['writing'] },
  { icon: '🖼', label: 'Pixiv 搜图', fn: openPixivSearch, groups: ['dialogue'] },
  { icon: '🗺', label: '剧情线', fn: toggleTimeline, groups: ['dialogue'] },
  { icon: '🧩', label: '人物图鉴', fn: toggleMandala, groups: ['dialogue','setting'] },
  { icon: '📍', label: '地点图鉴', fn: toggleLocations, groups: ['dialogue','setting'] },
  { icon: '📋', label: '任务日志', fn: toggleQuestsPanel, groups: ['dialogue','game'] },
  { icon: '🎨', label: '聊天背景', fn: showChatBackgroundModal, groups: ['dialogue'] },
  { icon: '⚡', label: 'Agent 状态', fn: toggleAgentState, groups: ['dialogue'] },
  { icon: '🎲', label: '掷骰', fn: toggleDiceMenu, groups: ['game','check'] },
  { icon: '✨', label: '创建新冒险', fn: showNewAdventureModal, groups: ['dialogue','setting'] },
  { icon: '🎨', label: '主题：暗色游戏风', fn: function () { setTheme('dark'); }, groups: ['dialogue','writing','game','setting'] },
  { icon: '🎨', label: '主题：中性', fn: function () { setTheme('neutral'); }, groups: ['dialogue','writing','game','setting'] },
  { icon: '📝', label: '打开 Denova 写作台', fn: function () { openDenovaShell('writing'); }, groups: ['writing'] },
  { icon: '🎮', label: '打开 Denova 游戏模式', fn: function () { openDenovaShell('game'); }, groups: ['game'] }
  /* 「导出/导入本地 Profile」由 bridge.js 模块化 push（app.js 无此两命令，避免重复） */
];
let cmdIndex = 0;
let cmdFiltered = [];
/* ==================== P4：主题切换 ==================== */
function getTheme() {
  try { return localStorage.getItem('adventureAI_theme') || 'dark'; } catch (e) { return 'dark'; }
}
function setTheme(theme) {
  const t = theme === 'neutral' ? 'neutral' : 'dark';
  try { localStorage.setItem('adventureAI_theme', t); } catch (e) { /* ignore */ }
  document.body.dataset.theme = t;
}
function initTheme() {
  document.body.dataset.theme = getTheme();
}

function openCommandPalette() {
  const o = document.getElementById('cmdOverlay');
  if (!o) return;
  o.classList.add('open');
  const i = document.getElementById('cmdInput');
  if (i) { i.value = ''; i.focus(); }
  cmdFiltered = UI_COMMANDS.slice();
  cmdIndex = 0;
  filterCommandPalette();  // v4 P0-5: 打开即按当前场景预设过滤
}
function closeCommandPalette() {
  const o = document.getElementById('cmdOverlay');
  if (o) o.classList.remove('open');
}
function renderCommandList() {
  const box = document.getElementById('cmdList');
  if (!box) return;
  box.innerHTML = '';
  cmdFiltered.forEach(function (c, idx) {
    const d = document.createElement('div');
    d.className = 'cmd-item' + (idx === cmdIndex ? ' active' : '');
    d.innerHTML = '<span class="cmd-ic">' + c.icon + '</span><span>' + c.label + '</span>';
    d.onclick = function () { execCommand(c); };
    box.appendChild(d);
  });
}
function execCommand(c) {
  closeCommandPalette();
  if (c && typeof c.fn === 'function') c.fn();
}
let cmdShowAll = false;
try { cmdShowAll = localStorage.getItem('adventureAI_showAllCmds') === '1'; } catch (e) { /* ignore */ }

function toggleCmdShowAll() {
  cmdShowAll = !cmdShowAll;
  try { localStorage.setItem('adventureAI_showAllCmds', cmdShowAll ? '1' : '0'); } catch (e) { /* ignore */ }
  const cb = document.getElementById('cmdShowAll');
  if (cb) cb.checked = cmdShowAll;
  filterCommandPalette();
}

function filterCommandPalette() {
  const i = document.getElementById('cmdInput');
  const q = i ? i.value.trim().toLowerCase() : '';
  const activeFilter = (typeof getActiveCmdFilter === 'function') ? getActiveCmdFilter() : [];
  cmdIndex = 0;
  cmdFiltered = UI_COMMANDS.filter(function (c) {
    if (q && c.label.toLowerCase().indexOf(q) === -1) return false;
    if (cmdShowAll || !activeFilter.length || activeFilter.indexOf('*') !== -1) return true;
    if (!c.groups || !c.groups.length) return false;
    return c.groups.some(function (g) { return activeFilter.indexOf(g) !== -1; });
  });
  /* 隐藏数量提示 */
  const hint = document.getElementById('cmdHiddenHint');
  if (hint) {
    const hidden = cmdShowAll ? 0 : UI_COMMANDS.filter(function (c) {
      if (!activeFilter.length || activeFilter.indexOf('*') !== -1) return false;
      if (!c.groups || !c.groups.length) return true;
      return !c.groups.some(function (g) { return activeFilter.indexOf(g) !== -1; });
    }).length;
    hint.textContent = cmdShowAll ? '' : ('当前场景隐藏 ' + hidden + ' 条命令');
  }
  const cb = document.getElementById('cmdShowAll');
  if (cb) cb.checked = cmdShowAll;
  renderCommandList();
}
function commandPaletteKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); cmdIndex = Math.min(cmdIndex + 1, cmdFiltered.length - 1); renderCommandList(); scrollCmdActive(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); cmdIndex = Math.max(cmdIndex - 1, 0); renderCommandList(); scrollCmdActive(); }
  else if (e.key === 'Enter') { e.preventDefault(); if (cmdFiltered[cmdIndex]) execCommand(cmdFiltered[cmdIndex]); }
  else if (e.key === 'Escape') { closeCommandPalette(); }
}
function scrollCmdActive() {
  const a = document.querySelector('.cmd-item.active');
  if (a) a.scrollIntoView({ block: 'nearest' });
}
document.addEventListener('keydown', function (e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openCommandPalette();
  }
});

/* ==================== 场景配图 ==================== */
function extractSceneKeywords(text) {
  /* 从叙事文本中提取关键场景描述词 */
  var t = String(text || '');
  /* 去掉换行，取前150字作为场景描述基础 */
  var summary = t.replace(/\n/g, ' ').substring(0, 150).trim();
  /* 提取双引号中的内容（通常是关键名词） */
  var quotes = t.match(/[「""]([^」""]+)[」""]/g);
  var keywords = [];
  if (quotes) {
    for (var q of quotes) {
      keywords.push(q.replace(/[「」""]/g, ''));
    }
  }
  /* 组合：keywords + summary */
  var prompt = keywords.length > 0 ? keywords.join(', ') + ', ' + summary : summary;
  /* 限制长度 */
  if (prompt.length > 200) prompt = prompt.substring(0, 200);
  return prompt;
}

function generateSceneImage(messageIndex) {
  var adv = getCurrentAdventure();
  if (!adv) return;
  var msg = adv.conversationHistory[messageIndex];
  if (!msg || msg.role !== 'assistant') return;
  var parsed = parseGameResponse(msg.content);
  var sceneDesc = extractSceneKeywords(parsed.narrative);
  if (!sceneDesc) return;

  var cfg = state.apiConfig;
  var endpoint = cfg.imageApiEndpoint || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
  var apiKey = cfg.imageApiKey;
  var model = cfg.imageModel || 'qwen-image-3.0-pro';

  if (!apiKey) {
    alert('请先在「API 设置 → 场景配图 API」中填写图片 API Key');
    showSettings();
    return;
  }

  /* 标记加载中 */
  msg.imageLoading = true;
  renderStory();

  /* 组合 prompt：场景关键词 + 主题风格 */
  var themeName = adv.theme || '奇幻';
  var styleMap = {
    '奇幻': 'fantasy art, medieval, magical',
    '科幻': 'sci-fi, futuristic, cyberpunk',
    '恐怖': 'dark horror, eerie, gloomy',
    '末日': 'post-apocalyptic, wasteland, ruins',
    '武侠': 'chinese ink painting, wuxia, ancient china',
    '悬疑': 'noir, mysterious, detective',
  };
  var themeStyle = styleMap[themeName] || 'digital art';
  var fullPrompt = sceneDesc + ', ' + themeStyle + ', detailed, atmospheric lighting, high quality, no text, no watermark';
  var seed = Math.floor(Math.random() * 2147483647);

  /* 超时保护：3 分钟 */
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 180000);

  fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: model,
      input: {
        messages: [
          { role: 'user', content: [ { text: fullPrompt } ] }
        ]
      },
      parameters: {
        prompt_extend: true,
        size: '1280*720',
        seed: seed
      }
    }),
    signal: controller.signal
  }).then(function(res) {
    if (!res.ok) {
      return res.text().then(function(t) { throw new Error('HTTP ' + res.status + '：' + t.substring(0, 200)); });
    }
    return res.json();
  }).then(function(data) {
    clearTimeout(timer);
    var imgUrl = null;
    try { imgUrl = data.output.choices[0].message.content[0].image; } catch (e) {}
    msg.imageLoading = false;
    if (!imgUrl) {
      saveState();
      renderStory();
      showImageError('场景图生成失败：返回数据格式异常');
      return;
    }
    /* DashScope 返回的 URL 约 24 小时后失效，转成 dataURL 长期保存；失败则回退临时 URL */
    fetch(imgUrl).then(function(r) { return r.blob(); }).then(function(blob) {
      var reader = new FileReader();
      reader.onloadend = function() {
        msg.sceneImage = reader.result;
        saveState();
        renderStory();
      };
      reader.onerror = function() { msg.sceneImage = imgUrl; saveState(); renderStory(); };
      reader.readAsDataURL(blob);
    }).catch(function() {
      msg.sceneImage = imgUrl;
      saveState();
      renderStory();
    });
  }).catch(function(err) {
    clearTimeout(timer);
    msg.imageLoading = false;
    saveState();
    renderStory();
    var hint = (err.name === 'AbortError') ? '生成超时（超过 3 分钟），Qwen-Image 首张可能较慢，请重试' : (err.message || err);
    showImageError('场景图生成失败：' + hint);
  });
}

function showImageError(text) {
  var storyArea = document.getElementById('storyArea');
  if (!storyArea) return;
  var errDiv = document.createElement('div');
  errDiv.className = 'turn-row';
  errDiv.innerHTML = '<div class="narrative-col"><div class="msg-bubble ai-bubble" style="border-color:rgba(255,184,89,0.3);background:rgba(255,184,89,0.05)">' +
    '<div style="color:#FFB859;font-size:12px">⚠ ' + escapeHtml(text) + '</div>' +
    '</div></div><div class="annotation-col"></div>';
  storyArea.appendChild(errDiv);
  scrollToBottom();
}


function cleanStreamText(raw) {
  /* 流式输出时只展示叙事正文，隐藏结构化区块 */
  let t = String(raw || '').replace(/^\s*\[NARRATIVE\]\s*/i, '');
  const next = t.search(/\[(STATE|CHANGES|CHOICES|QUESTS|COMBAT|CHARACTERS)\]/i);
  if (next !== -1) t = t.slice(0, next);
  return t.trim();
}

function stripSectionTags(text) {
  let t = String(text || '');
  /* 去掉 [NARRATIVE] 开头标记 */
  t = t.replace(/^\s*\[NARRATIVE\]\s*/i, '');
  /* 截断从第一个非 NARRATIVE 标签到末尾的所有内容 */
  const cut = t.search(/\[(STATE|CHANGES|CHOICES|QUESTS|COMBAT|CHARACTERS|PLOT)\]/i);
  if (cut !== -1) t = t.slice(0, cut);
  /* 兜底：去掉任何残留的整行标签 */
  t = t.split('\n').filter(l => !/^\s*\[(NARRATIVE|STATE|CHANGES|CHOICES|QUESTS|COMBAT|CHARACTERS|PLOT)\]\s*$/i.test(l)).join('\n');
  return t.trim();
}

/* 最终安全网：确保叙事文本中不含任何结构化标签或泄漏的关键词 */
function sanitizeNarrative(text) {
  let t = String(text || '');
  /* 去掉任何 [XXX] 格式的标签 */
  t = t.replace(/\[(NARRATIVE|STATE|CHANGES|CHOICES|QUESTS|COMBAT|CHARACTERS)\]/gi, '');
  /* 去掉可能泄漏的结构化数据行（HP:+/-, MP:+/-, ITEM, MOOD|, SKILL_*, ATTR_UP, EXP +, LEVEL_UP 等） */
  t = t.split('\n').filter(l => {
    const s = l.trim();
    if (/^(HP|MP)\s*[+-]\s*\d+/i.test(s)) return false;
    if (/^ITEM\s*[+-]/i.test(s)) return false;
    if (/^MOOD\s*\|/i.test(s)) return false;
    if (/^SKILL_(NEW|UP)\s*\|/i.test(s)) return false;
    if (/^ATTR_UP\s*\|/i.test(s)) return false;
    if (/^EXP\s*\+/i.test(s)) return false;
    if (/^LEVEL_UP/i.test(s)) return false;
    if (/^SKILLPT\s*\+/i.test(s)) return false;
    if (/^ATTRPT\s*\+/i.test(s)) return false;
    if (/^HP:\s*\d+\s*\/\s*\d+/i.test(s)) return false;
    if (/^MP:\s*\d+\s*\/\s*\d+/i.test(s)) return false;
    if (/^(位置|章节|职业|情绪):\s*.+/i.test(s)) return false;
    return true;
  }).join('\n');
  return t.trim();
}

function renderMarkdown(text) {
  /* text 已做过 HTML 转义，这里只做安全的轻量 markdown 替换 */
  let t = text;
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|\n)#{1,3}\s+(.+)/g, '$1<strong class="md-h">$2</strong>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/(^|\n)[-*] (.+)/g, '$1• $2');
  return t;
}

/* ==================== 曼陀罗人物卡 ==================== */
/* 名字归一化：去空格/全角空格，小写，用于识别同一角色 */
function normalizeCardName(name) {
  return String(name || '').trim().replace(/[\s\u3000]/g, '').toLowerCase();
}
/* 基础名：去掉末尾括号注释（如 艾米（继妹）→ 艾米），同一角色的不同写法可识别 */
function baseCardName(name) {
  return normalizeCardName(name).replace(/[（(【\[]\S*[）)】\]]/g, '');
}
function findMandalaCard(cards, name) {
  const n = normalizeCardName(name);
  const b = baseCardName(name);
  return cards.find(c => normalizeCardName(c.name) === n) ||
    (b ? cards.find(c => baseCardName(c.name) === b) : null) || null;
}
/* 合并重复卡：归一化名/基础名相同 → 保留更完整名字 + 合并字段 */
function dedupeMandalaCards(adv) {
  if (!adv.mandalaCards) adv.mandalaCards = [];
  const out = [];
  for (const card of adv.mandalaCards) {
    const n = normalizeCardName(card.name);
    const b = baseCardName(card.name);
    let target = null;
    for (const keep of out) {
      if (normalizeCardName(keep.name) === n || (b && baseCardName(keep.name) === b)) { target = keep; break; }
    }
    if (!target) { out.push(card); continue; }
    if (card.name.length > target.name.length) target.name = card.name;
    for (const f of MANDALA_FIELDS) {
      if (card[f.key]) target[f.key] = card[f.key];
    }
    if (card.updatedAt && (!target.updatedAt || card.updatedAt > target.updatedAt)) target.updatedAt = card.updatedAt;
  }
  adv.mandalaCards = out;
}
/* 曼陀罗即时刷新：抽屉开着就重绘 + 更新头部数量角标 */
function refreshMandalaUI() {
  const adv = getCurrentAdventure();
  if (adv) dedupeMandalaCards(adv);
  const drawer = document.getElementById('mandalaDrawer');
  if (drawer && drawer.style.display === 'flex') { try { renderMandala(); } catch (e) { console.error(e); } }
  const badge = document.getElementById('mandalaCount');
  if (badge) {
    const n = (adv && adv.mandalaCards) ? adv.mandalaCards.length : 0;
    badge.textContent = n ? String(n) : '';
    badge.style.display = n ? '' : 'none';
  }
}

/* 人物图鉴「刷新」：重新扫描完整对话历史，从每条 AI 回复的 [CHARACTERS] 重建人物卡 */
function refreshMandalaFromHistory() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  if (!adv.mandalaCards) adv.mandalaCards = [];
  let scanned = 0, added = 0;
  for (let i = 1; i < adv.conversationHistory.length; i++) {
    const msg = adv.conversationHistory[i];
    if (msg.role !== 'assistant') continue;
    scanned++;
    const parsed = parseGameResponse(msg.content);
    if (parsed.charactersLines && parsed.charactersLines.length > 0) {
      const before = adv.mandalaCards.length;
      applyCharacterUpdates(adv, parsed.charactersLines);
      added += (adv.mandalaCards.length - before);
    }
  }
  dedupeMandalaCards(adv);
  saveState();
  renderMandala();
  const hint = document.getElementById('mandalaHint');
  if (hint) hint.textContent = '已刷新 · 扫描 ' + scanned + ' 条 AI 回复，当前收录 ' + adv.mandalaCards.length + ' 位人物';
}

/* ==================== 地点图鉴 ==================== */
function toggleLocations() {
  const drawer = document.getElementById('locationDrawer');
  if (drawer.style.display === 'none' || !drawer.style.display) {
    const others = ['mandalaDrawer', 'agentStateDrawer', 'timelineDrawer'];
    for (const id of others) { const d = document.getElementById(id); if (d) d.style.display = 'none'; }
    renderLocations();
    drawer.style.display = 'flex';
  } else {
    drawer.style.display = 'none';
  }
}

/* 从当前位置 + 剧情节点 + 历史 [STATE] 位置 收集全部到访地点 */
function collectLocations(adv) {
  const set = new Map();
  const add = (loc, src) => {
    if (!loc) return;
    const k = String(loc).trim();
    if (!k || k === '未知' || k === '未知之地' || k === '未知位置') return;
    if (!set.has(k)) set.set(k, src);
  };
  add(adv.character.location, '当前');
  if (adv.plotNodes) for (const n of adv.plotNodes) add(n.location, '剧情节点');
  for (let i = 1; i < adv.conversationHistory.length; i++) {
    const msg = adv.conversationHistory[i];
    if (msg.role !== 'assistant') continue;
    const p = parseGameResponse(msg.content);
    if (p.state && p.state.location) add(p.state.location, '剧情');
  }
  return Array.from(set.entries()).map(([name, src]) => ({ name: name, src: src }));
}

function renderLocations() {
  const adv = getCurrentAdventure();
  const body = document.getElementById('locationBody');
  if (!body) return;
  const locs = collectLocations(adv);
  const hint = document.getElementById('locationHint');
  if (!locs.length) {
    body.innerHTML = '<p style="color:rgba(255,255,255,0.4)">还没有记录到地点。随着剧情推进，角色到达的新地点会自动收录，也可点「🔄 刷新」重新扫描。</p>';
    if (hint) hint.textContent = '';
    return;
  }
  const cur = String(adv.character.location || '').trim();
  let html = '<div class="location-list">';
  for (const l of locs) {
    const isCur = l.name === cur;
    html += '<div class="location-item' + (isCur ? ' current' : '') + '">' +
      '<span class="location-name">' + escapeHtml(l.name) + '</span>' +
      (isCur ? '<span class="location-cur">📍 当前</span>' : '') +
      '<span class="location-src">' + escapeHtml(l.src) + '</span>' +
      '</div>';
  }
  html += '</div>';
  body.innerHTML = html;
  if (hint) hint.textContent = '共收录 ' + locs.length + ' 个地点';
}

function refreshLocations() {
  const adv = getCurrentAdventure();
  if (adv) renderLocations();
}

/* ==================== 任务系统：删除 / 隐藏 ==================== */
function deleteQuest(name) {
  const adv = getCurrentAdventure();
  if (!adv || !adv.quests) return;
  if (!confirm('确定删除任务「' + name + '」？此操作不可撤销。')) return;
  adv.quests = adv.quests.filter(q => q.name !== name);
  saveState();
  renderQuestsPanel(adv);
}

/* 头部的「📋 任务」按钮与任务栏标题的「🙈」共用：切换任务栏的隐藏状态 */
function toggleQuestsPanel() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  adv.hideQuests = !adv.hideQuests;
  saveState();
  renderQuestsPanel(adv);
  if (!adv.hideQuests) {
    const sec = document.getElementById('questsSection');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

/* ==================== 撤回已发消息 ==================== */
function withdrawMessage(index) {
  const adv = getCurrentAdventure();
  if (!adv || state.isGenerating) return;
  const h = adv.conversationHistory;
  const msg = h[index];
  if (!msg || msg.role !== 'user') return;
  /* 撤回该玩家消息，以及紧跟其后的 AI 回复（若是对该消息的回应） */
  let removeCount = 1;
  if (h[index + 1] && h[index + 1].role === 'assistant') removeCount = 2;
  const removed = cloneValue(h.slice(index, index + removeCount));
  h.splice(index, removeCount);
  queueConversationArchiveEvent(adv, 'path.withdrawn', { removed_ids: visibleConversation(removed, adv.id).map(function (message) { return message.id; }), archived_messages: visibleConversation(removed, adv.id) });
  state.isGenerating = false;
  saveState();
  renderAll();
}

function applyCharacterUpdates(adv, lines) {
  if (!adv.mandalaCards) adv.mandalaCards = [];
  const unknownValues = new Set(['未知', '?', '？', 'unknown']);
  for (const line of lines) {
    const parts = line.split('|').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) continue;
    const name = parts.shift();
    if (!name) continue;
    /* 归一化/基础名匹配，避免同一角色重复建档 */
    dedupeMandalaCards(adv);
    let card = findMandalaCard(adv.mandalaCards, name);
    if (!card) {
      card = { name: name, createdAt: Date.now(), updatedAt: Date.now() };
      adv.mandalaCards.push(card);
    } else if (name.length > card.name.length && baseCardName(name) === baseCardName(card.name)) {
      card.name = name; /* 名字更完整则升级（如 艾米 → 艾米（继妹）） */
    }
    for (const p of parts) {
      const eq = p.indexOf('=');
      if (eq <= 0) continue;
      const label = p.slice(0, eq).trim();
      let value = p.slice(eq + 1).trim();
      const key = MANDALA_LABEL_TO_KEY[label];
      if (!key || key === 'name') continue;
      if (unknownValues.has(value)) value = '';
      card[key] = value;
    }
    card.updatedAt = Date.now();
  }
  dedupeMandalaCards(adv);
}

function toggleMandala() {
  const drawer = document.getElementById('mandalaDrawer');
  if (drawer.style.display === 'none' || !drawer.style.display) {
    const agentDrawer = document.getElementById('agentStateDrawer');
    const timelineDrawer = document.getElementById('timelineDrawer');
    if (agentDrawer) agentDrawer.style.display = 'none';
    if (timelineDrawer) timelineDrawer.style.display = 'none';
    renderMandala();
    drawer.style.display = 'flex';
  } else {
    drawer.style.display = 'none';
  }
}

function renderMandala() {
  const adv = getCurrentAdventure();
  const body = document.getElementById('mandalaBody');
  if (!body) return;
  if (!adv || !adv.mandalaCards || adv.mandalaCards.length === 0) {
    body.innerHTML = '<p style="color:rgba(255,255,255,0.4)">还没有收录到关键人物。剧情中登场的新角色会自动建档，玩家尚未了解的信息会显示为「？」。</p>';
    return;
  }
  let html = '<div class="mandala-grid">';
  for (const card of adv.mandalaCards) {
    html += '<div class="mandala-card">' +
      '<div class="mandala-name">' + escapeHtml(card.name) + '</div>' +
      '<div class="mandala-cells">';
    const order = [
      ['identity', 'desire', 'goal'],
      ['action', null, 'background'],
      ['resource', 'relation', 'personality'],
    ];
    for (let r = 0; r < 3; r++) {
      for (let cIdx = 0; cIdx < 3; cIdx++) {
        const key = order[r][cIdx];
        if (!key) {
          html += '<div class="mandala-cell mandala-center">' + escapeHtml(card.name) + '</div>';
          continue;
        }
        const field = MANDALA_FIELDS.find(f => f.key === key);
        const value = card[key] || '';
        html += '<div class="mandala-cell' + (value ? '' : ' unknown') + '">' +
          '<span class="mandala-cell-label">' + field.label + '</span>' +
          '<span class="mandala-cell-value">' + (value ? escapeHtml(value) : '？') + '</span>' +
          '</div>';
      }
    }
    html += '</div></div>';
  }
  html += '</div>';
  const listView = document.getElementById('timelineListView');
  if (listView) listView.innerHTML = html;
}

/* ==================== 自动存档 / 数据备份 ==================== */
function maybeAutoSave(adv) {
  if (!state.apiConfig.autoSave) return;
  const every = Math.max(1, parseInt(state.apiConfig.autoSaveEvery) || 5);
  adv.turnsSinceAutoSave = (adv.turnsSinceAutoSave || 0) + 1;
  if (adv.turnsSinceAutoSave >= every) {
    adv.turnsSinceAutoSave = 0;
    createSnapshot(adv, '自动存档 · ' + defaultSnapshotLabel(adv), 'auto');
  }
}

function exportAllData() {
  const payload = {
    app: 'Narraverse',
    version: 1,
    exportedAt: Date.now(),
    adventures: state.adventures,
    apiConfig: state.apiConfig,
    customThemes: state.customThemes,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'adventureai-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function() { URL.revokeObjectURL(url); }, 5000);
}

function importAllData() {
  const input = document.getElementById('importFileInput');
  if (input) input.click();
}

const EMBEDDED_MIGRATION_NOTICE_KEY = 'narraverse:embedded-migration-notice:v1';
let embeddedMigrationImportPending = false;

function markEmbeddedMigrationNoticeHandled() {
  try { localStorage.setItem(EMBEDDED_MIGRATION_NOTICE_KEY, '1'); } catch (e) { /* ignore */ }
}

function maybeShowEmbeddedMigrationNotice() {
  if (!isDenovaEmbedded || state.adventures.length > 0) return false;
  try {
    if (localStorage.getItem(EMBEDDED_MIGRATION_NOTICE_KEY) === '1') return false;
  } catch (e) { /* ignore */ }
  showModal('embeddedMigrationModal');
  return true;
}

function dismissEmbeddedMigrationNotice() {
  embeddedMigrationImportPending = false;
  markEmbeddedMigrationNoticeHandled();
  closeModal('embeddedMigrationModal');
}

function importEmbeddedMigrationBackup() {
  embeddedMigrationImportPending = true;
  closeModal('embeddedMigrationModal');
  importAllData();
}

/* ==================== 分支切换 ==================== */
function switchToBranch(branchId) {
  const adv = getCurrentAdventure();
  if (!adv || !adv.branches) return;
  const branch = adv.branches.find(b => b.id === branchId);
  if (!branch || !branch.messages || branch.messages.length === 0) return;
  if (!confirm('切换到该分支会替换当前剧情路径（当前路径会保存为新的分支记录），确定继续？')) return;
  /* 保存当前路径为新的分支，方便随时切回 */
  const prefixLen = (branch.prefix && branch.prefix.length) || 0;
  const curTail = adv.conversationHistory.slice(prefixLen);
  if (curTail.length > 0) {
    const firstUser = curTail.find(m => m.role === 'user');
    adv.branches.unshift({
      id: 'br_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      label: '当前路径：' + (firstUser ? firstUser.content.substring(0, 18) : ''),
      fromIndex: prefixLen - 1,
      lineId: adv.currentLineId,
      prefix: cloneValue(adv.conversationHistory),
      messages: cloneValue(curTail),
      createdAt: Date.now(),
    });
    if (adv.branches.length > 20) adv.branches.length = 20;
  }
  adv.conversationHistory = cloneValue(branch.prefix || []).concat(cloneValue(branch.messages));
  /* 恢复分支所属剧情线，并裁剪该线在分支点之后的节点，保持时间轴与历史一致 */
  const branchLineId = branch.lineId || 'main';
  adv.currentLineId = getPlotLine(adv, branchLineId) ? branchLineId : 'main';
  trimPlotNodesPastIndex(adv, prefixLen - 1);
  if (adv.conversationHistory.length === 0) {
    adv.conversationHistory = [{ role: 'system', content: '' }];
  }
  queueConversationArchiveEvent(adv, 'path.switched', { branch_id: branchId, replace_visible_ids: archiveActiveIds(adv) });
  /* 恢复该分支最后已知的角色状态 */
  const lastMsg = adv.conversationHistory[adv.conversationHistory.length - 1];
  if (lastMsg && lastMsg.stateAfter) {
    adv.character = cloneValue(lastMsg.stateAfter);
  }
  adv.contextSummary = null;
  adv.contextCompressed = false;
  updateSystemPrompt(adv);
  saveState();
  renderAll();
  renderTimeline();
}

/* ==================== 存档点 ==================== */
function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatTime(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function defaultSnapshotLabel(adv) {
  const c = adv.character;
  return 'Lv.' + c.level + ' · ' + (c.chapter || '序章') + ' · ' + (c.location || '未知位置');
}

function countTurns(history) {
  return history.filter(m => m.role === 'user').length;
}

const PROTECTED_SNAPSHOT_KINDS = ['manual', 'line'];

function createSnapshot(adv, label, kind) {
  if (!adv.snapshots) adv.snapshots = [];
  const snap = {
    id: 'snap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    kind: kind || 'manual',
    label: label || defaultSnapshotLabel(adv),
    createdAt: Date.now(),
    fromIndex: (adv.conversationHistory || []).length - 1,
    character: cloneValue(adv.character),
    conversationHistory: cloneValue(adv.conversationHistory),
    contextSummary: adv.contextSummary,
    contextCompressed: adv.contextCompressed,
  };
  adv.snapshots.unshift(snap);
  /* P3 版本账本：格式对齐 Denova ledger 语义（ts/type/object/blobId） */
  if (!adv.versionLedger) adv.versionLedger = [];
  adv.versionLedger.unshift({ ts: Date.now(), type: kind || 'manual', label: label || snap.label, object: 'adventure', blobId: snap.id });
  if (adv.versionLedger.length > 50) adv.versionLedger = adv.versionLedger.slice(0, 50);
  /* 手动/线路存档受保护；超限时优先删除自动类存档 */
  const MAX_SNAPSHOTS = 24;
  if (adv.snapshots.length > MAX_SNAPSHOTS) {
    const removable = adv.snapshots.filter(s => !PROTECTED_SNAPSHOT_KINDS.includes(s.kind));
    while (adv.snapshots.length > MAX_SNAPSHOTS && removable.length > 0) {
      const victim = removable.shift();
      const idx = adv.snapshots.indexOf(victim);
      if (idx !== -1) adv.snapshots.splice(idx, 1);
    }
    if (adv.snapshots.length > MAX_SNAPSHOTS) adv.snapshots.length = MAX_SNAPSHOTS;
  }
  saveState();
  return snap;
}

function showSnapshotsModal() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  renderSnapshotsList();
  showModal('snapshotsModal');
}

function saveSnapshotNow() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  createSnapshot(adv);
  renderSnapshotsList();
}

function renderSnapshotsList() {
  const adv = getCurrentAdventure();
  const list = document.getElementById('snapshotsList');
  if (!adv || !list) return;
  if (!adv.snapshots || adv.snapshots.length === 0) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">暂无存档，先保存一个吧</div>';
    return;
  }
  let html = '';
  for (const s of adv.snapshots) {
    const c = s.character;
    html += '<div class="snap-item">' +
      '<div class="snap-info">' +
      '<div class="snap-label">' + escapeHtml(s.label) + '</div>' +
      '<div class="snap-meta">' + escapeHtml(c.profession) + ' · ' + formatTime(s.createdAt) + ' · 回合 ' + countTurns(s.conversationHistory) + '</div>' +
      '</div>' +
      '<div class="snap-actions">' +
      '<button class="btn btn-secondary" onclick="loadSnapshot(\'' + s.id + '\')">读档</button>' +
      '<button class="btn btn-secondary snap-del" onclick="deleteSnapshot(\'' + s.id + '\')">删除</button>' +
      '</div>' +
      '</div>';
  }
  list.innerHTML = html;
}

function loadSnapshot(snapId) {
  const adv = getCurrentAdventure();
  if (!adv) return;
  const snap = adv.snapshots.find(s => s.id === snapId);
  if (!snap) return;
  if (!confirm('读取该存档会覆盖当前进度，确定继续？')) return;
  adv.character = cloneValue(snap.character);
  adv.conversationHistory = cloneValue(snap.conversationHistory);
  adv.contextSummary = snap.contextSummary;
  adv.contextCompressed = snap.contextCompressed;
  adv.currentLineId = 'main';
  queueConversationArchiveEvent(adv, 'path.snapshot_loaded', { snapshot_id: snapId, replace_visible_ids: archiveActiveIds(adv) });
  updateSystemPrompt(adv);
  saveState();
  closeModal('snapshotsModal');
  renderAll();
}

function deleteSnapshot(snapId) {
  const adv = getCurrentAdventure();
  if (!adv || !adv.snapshots) return;
  adv.snapshots = adv.snapshots.filter(s => s.id !== snapId);
  saveState();
  renderSnapshotsList();
}

/* ==================== 剧情线：节点卡 / IF 线 ==================== */

function ensurePlotData(adv) {
  if (!adv.plotNodes) adv.plotNodes = [];
  if (!adv.plotLines || adv.plotLines.length === 0) {
    adv.plotLines = [{ id: 'main', label: '主线', isMain: true, fromNodeId: null, nodeIds: [], resume: null, createdAt: Date.now() }];
  }
  if (!adv.currentLineId || !adv.plotLines.find(l => l.id === adv.currentLineId)) adv.currentLineId = 'main';
  return adv;
}

function getPlotLine(adv, lineId) {
  ensurePlotData(adv);
  return adv.plotLines.find(l => l.id === lineId);
}

function lineLastNode(adv, lineId) {
  ensurePlotData(adv);
  const line = getPlotLine(adv, lineId);
  if (!line) return null;
  for (let i = line.nodeIds.length - 1; i >= 0; i--) {
    const n = adv.plotNodes.find(p => p.id === line.nodeIds[i]);
    if (n) return n;
  }
  return null;
}

function saveLineResume(adv, lineId) {
  const line = getPlotLine(adv, lineId);
  if (!line) return;
  const snap = createSnapshot(adv, '线路存档 · ' + line.label, 'line');
  /* 内联保存完整进度（历史/角色/摘要），避免快照池裁剪导致线路失联（进得去出不来） */
  line.resume = {
    snapshotId: snap ? snap.id : null,
    history: cloneValue(adv.conversationHistory),
    character: cloneValue(adv.character),
    contextSummary: adv.contextSummary != null ? adv.contextSummary : null,
    contextCompressed: !!adv.contextCompressed,
    savedAt: Date.now(),
  };
}

function applyLineResume(adv, line) {
  const r = line && line.resume;
  if (r && r.history && r.history.length) {
    adv.conversationHistory = cloneValue(r.history);
    if (r.character) adv.character = cloneValue(r.character);
    adv.contextSummary = r.contextSummary != null ? r.contextSummary : null;
    adv.contextCompressed = !!r.contextCompressed;
    return true;
  }
  if (r && r.snapshotId) {
    const snap = adv.snapshots.find(s => s.id === r.snapshotId);
    if (snap) {
      adv.conversationHistory = cloneValue(snap.conversationHistory || []);
      if (snap.character) adv.character = cloneValue(snap.character);
      adv.contextSummary = snap.contextSummary != null ? snap.contextSummary : null;
      adv.contextCompressed = !!snap.contextCompressed;
      return true;
    }
  }
  return false;
}

function trimPlotNodesPastIndex(adv, index) {
  ensurePlotData(adv);
  const line = getPlotLine(adv, adv.currentLineId);
  if (!line) return;
  const removed = (line.nodeIds || []).filter(id => {
    const n = adv.plotNodes.find(x => x.id === id);
    return n && n.fromIndex != null && n.fromIndex > index;
  });
  line.nodeIds = (line.nodeIds || []).filter(id => !removed.includes(id));
  for (const id of removed) {
    const i = adv.plotNodes.findIndex(n => n.id === id);
    if (i !== -1) adv.plotNodes.splice(i, 1);
  }
  const last = lineLastNode(adv, adv.currentLineId);
  if (last) last.status = 'active';
}

function makePlotNode(adv, opts) {
  ensurePlotData(adv);
  const prev = lineLastNode(adv, adv.currentLineId);
  if (prev && prev.status === 'active') prev.status = 'done';
  const node = {
    id: 'pn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    title: opts.title || '未命名节点',
    chapter: opts.chapter || '',
    summary: opts.summary || '',
    location: opts.location || '',
    characters: opts.characters || [],
    lineId: adv.currentLineId,
    parentId: prev ? prev.id : null,
    fromIndex: opts.fromIndex != null ? opts.fromIndex : null,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  adv.plotNodes.push(node);
  const line = getPlotLine(adv, adv.currentLineId);
  if (!line.nodeIds) line.nodeIds = [];
  line.nodeIds.push(node.id);
  if (adv.plotNodes.length > 80) {
    const removedIds = adv.plotNodes.splice(0, adv.plotNodes.length - 80).map(n => n.id);
    for (const l of adv.plotLines) l.nodeIds = (l.nodeIds || []).filter(id => !removedIds.includes(id));
  }
  return node;
}

/* 事件日志：时间轴持续记录关键事件（压缩、死亡、升级等），与剧情节点分开存放 */
function logEvent(adv, type, title, detail) {
  ensurePlotData(adv);
  if (!adv.eventNodes) adv.eventNodes = [];
  adv.eventNodes.push({
    id: 'ev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    type: type || 'event',
    title: title || '事件',
    detail: detail || '',
    createdAt: Date.now(),
  });
  /* 事件节点上限，避免无限增长 */
  if (adv.eventNodes.length > 120) adv.eventNodes.splice(0, adv.eventNodes.length - 120);
}

function applyPlotUpdates(adv, plotOps, msgIndex) {
  if (!plotOps || plotOps.length === 0) return;
  ensurePlotData(adv);
  for (const op of plotOps) {
    if (op.action === 'new') {
      const title = (op.title || '').trim().substring(0, 40) || '剧情节点';
      const chars = String(op.characters || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
      /* 去重：同一剧情线上已存在同名节点（多为 LLM 重复输出同一剧情节点）时，更新既有节点而非新建，避免堆积大量同名节点 */
      const dup = adv.plotNodes.find(n => n.lineId === adv.currentLineId && n.title === title);
      if (dup) {
        if (op.chapter) dup.chapter = (op.chapter || '').trim();
        if (op.summary) dup.summary = (op.summary || '').trim().substring(0, 300);
        if (op.location) dup.location = (op.location || '').trim();
        if (chars.length) dup.characters = Array.from(new Set([...(dup.characters || []), ...chars]));
        if (dup.status === 'active') dup.status = 'active';
        dup.updatedAt = Date.now();
      } else {
        makePlotNode(adv, {
          title: title,
          chapter: (op.chapter || '').trim(),
          summary: (op.summary || '').trim().substring(0, 300),
          location: (op.location || '').trim(),
          characters: chars,
          fromIndex: msgIndex,
        });
      }
    } else if (op.action === 'done' || op.action === 'fail') {
      const line = getPlotLine(adv, adv.currentLineId);
      const title = (op.title || '').trim();
      const target = (line && title)
        ? adv.plotNodes.find(n => n.lineId === line.id && n.title === title)
        : lineLastNode(adv, adv.currentLineId);
      if (target) { target.status = op.action === 'done' ? 'done' : 'failed'; target.updatedAt = Date.now(); }
    }
  }
  saveState();
}

function addPlotNodeManual() {
  const adv = getCurrentAdventure();
  if (!adv || state.isGenerating) return;
  ensurePlotData(adv);
  const h = adv.conversationHistory;
  let idx = -1;
  for (let i = h.length - 1; i >= 0; i--) if (h[i].role === 'assistant') { idx = i; break; }
  if (idx < 0) { alert('还没有剧情，无法记录节点'); return; }
  const parsed = parseGameResponse(h[idx].content);
  const defaultTitle = (parsed.narrative || '').replace(/\s+/g, ' ').substring(0, 16) || '剧情节点';
  let title = '';
  try { title = (window.prompt('剧情节点标题（6-12字）：', defaultTitle) || '').trim(); } catch (e) { title = defaultTitle; }
  if (!title) return;
  let summary = '';
  try { summary = (window.prompt('节点摘要（可选，一句话）：', '') || '').trim(); } catch (e) { summary = ''; }
  const node = makePlotNode(adv, {
    title: title.substring(0, 40),
    chapter: adv.character.chapter || '',
    summary: summary.substring(0, 300),
    location: adv.character.location || '',
    characters: [],
    fromIndex: idx,
  });
  saveState();
  renderTimeline();
  alert('已记录节点：' + node.title);
}

function enterPlotNode(nodeId) {
  const adv = getCurrentAdventure();
  if (!adv) return;
  ensurePlotData(adv);
  const node = adv.plotNodes.find(n => n.id === nodeId);
  if (!node) return;
  const targetLine = getPlotLine(adv, node.lineId);
  const tipNode = lineLastNode(adv, node.lineId);
  const isTip = !!(tipNode && tipNode.id === node.id);

  if (node.lineId === adv.currentLineId && isTip) { renderTimeline(); return; }

  const curLine = getPlotLine(adv, adv.currentLineId);
  const curLabel = curLine ? curLine.label : '主线';
  if (!confirm('进入「' + node.title + '」将回到该节点继续（当前进度会保存为 ' + curLabel + '，可随时返回），确定？')) return;

  saveLineResume(adv, adv.currentLineId);

  let srcHistory, srcCharacter = null;
  if (node.lineId === adv.currentLineId) {
    srcHistory = adv.conversationHistory;
  } else if (applyLineResume(adv, targetLine)) {
    srcHistory = adv.conversationHistory;
    srcCharacter = adv.character;
  }
  if (!srcHistory || srcHistory.length === 0) { alert('该剧情线没有可用的历史记录'); return; }

  const fromIndex = node.fromIndex;
  if (fromIndex == null || fromIndex < 0 || fromIndex >= srcHistory.length) {
    alert('该节点的位置信息已失效，无法进入'); return;
  }

  adv.conversationHistory = cloneValue(srcHistory.slice(0, fromIndex + 1));
  const targetMsg = adv.conversationHistory[fromIndex];
  if (targetMsg && targetMsg.stateAfter) adv.character = cloneValue(targetMsg.stateAfter);
  else if (srcCharacter) adv.character = cloneValue(srcCharacter);
  else if (fromIndex === 0 && adv.initialCharacter) adv.character = cloneValue(adv.initialCharacter);
  adv.contextSummary = null;
  adv.contextCompressed = false;

  if (isTip) {
    adv.currentLineId = node.lineId;
  } else {
    const newLine = {
      id: 'line_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      label: 'IF线 · ' + node.title,
      isMain: false,
      fromNodeId: node.id,
      nodeIds: [],
      resume: null,
      createdAt: Date.now(),
    };
    adv.plotLines.push(newLine);
    if (adv.plotLines.length > 12) adv.plotLines = adv.plotLines.slice(adv.plotLines.length - 12);
    adv.currentLineId = newLine.id;
  }

  trimPlotNodesPastIndex(adv, fromIndex);
  updateSystemPrompt(adv);
  saveState();
  renderAll();
  renderTimeline();
}

function gotoMainLine() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  ensurePlotData(adv);
  if (adv.currentLineId === 'main') { renderTimeline(); return; }
  const main = getPlotLine(adv, 'main');
  if (!main || !main.resume) { alert('主线进度暂不可用'); return; }
  if (!confirm('回到主线将恢复主线进度（当前 IF 线进度会保存，可随时切回），确定？')) return;
  saveLineResume(adv, adv.currentLineId);
  if (!applyLineResume(adv, main)) { alert('主线存档已失效，无法恢复'); return; }
  adv.currentLineId = 'main';
  updateSystemPrompt(adv);
  saveState();
  renderAll();
  renderTimeline();
}

/* ==================== 剧情线 / 回溯 ==================== */
function toggleTimeline() {
  const drawer = document.getElementById('timelineDrawer');
  if (drawer.style.display === 'none' || !drawer.style.display) {
    /* 同时收起其他抽屉，避免叠在一起 */
    const agentDrawer = document.getElementById('agentStateDrawer');
    const mandalaDrawer = document.getElementById('mandalaDrawer');
    if (agentDrawer) agentDrawer.style.display = 'none';
    if (mandalaDrawer) mandalaDrawer.style.display = 'none';
    setTimelineView(timelineView);
    renderTimeline();
    drawer.style.display = 'flex';
  } else {
    drawer.style.display = 'none';
  }
}

function rewindTo(index, saveBranch) {
  const adv = getCurrentAdventure();
  if (!adv) return;
  const h = adv.conversationHistory;
  if (index < 0 || index >= h.length - 1) return;
  const tail = h.slice(index + 1);
  if (tail.length > 0 && saveBranch) {
    if (!confirm('回到此处会丢弃之后的剧情（丢弃内容会存入分支记录），确定继续？')) return;
    if (!adv.branches) adv.branches = [];
    const firstUser = tail.find(m => m.role === 'user');
    adv.branches.unshift({
      id: 'br_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      label: firstUser ? '从「' + firstUser.content.substring(0, 18) + '」处分出' : '剧情分支',
      fromIndex: index,
      lineId: adv.currentLineId,
      prefix: cloneValue(h.slice(0, index + 1)),
      messages: tail,
      createdAt: Date.now(),
    });
    if (adv.branches.length > 20) adv.branches.length = 20;
  }
  adv.conversationHistory = h.slice(0, index + 1);
  const targetMsg = adv.conversationHistory[index];
  const rewindTarget = visibleConversation([targetMsg], adv.id)[0];
  queueConversationArchiveEvent(adv, 'path.rewound', {
    truncate_after_id: rewindTarget ? rewindTarget.id : '',
    archived_messages: visibleConversation(tail, adv.id),
    saved_as_branch: !!saveBranch,
  });
  trimPlotNodesPastIndex(adv, index);
  /* 恢复该节点结束时的角色状态 */
  if (targetMsg && targetMsg.stateAfter) {
    adv.character = cloneValue(targetMsg.stateAfter);
  } else if (index === 0 && adv.initialCharacter) {
    adv.character = cloneValue(adv.initialCharacter);
  }
  adv.contextSummary = null;
  adv.contextCompressed = false;
  updateSystemPrompt(adv);
  saveState();
  renderAll();
}

function rewindToStart() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  if (adv.conversationHistory.length <= 1) return;
  if (!confirm('从头开始会清空本局全部剧情，确定继续？')) return;
  const removed = cloneValue(adv.conversationHistory.slice(1));
  adv.conversationHistory = [adv.conversationHistory[0]];
  queueConversationArchiveEvent(adv, 'path.rewound_to_start', { active_ids: [], archived_messages: visibleConversation(removed, adv.id) });
  adv.plotNodes = [];
  adv.plotLines = [{ id: 'main', label: '主线', isMain: true, fromNodeId: null, nodeIds: [], resume: null, createdAt: Date.now() }];
  adv.currentLineId = 'main';
  if (adv.initialCharacter) adv.character = cloneValue(adv.initialCharacter);
  adv.contextSummary = null;
  adv.contextCompressed = false;
  updateSystemPrompt(adv);
  saveState();
  renderAll();
}

function undoLastTurn() {
  const adv = getCurrentAdventure();
  if (!adv || state.isGenerating) return;
  const h = adv.conversationHistory;
  if (h.length <= 1) return;
  let target = h.length - 1;
  if (h[target].role === 'assistant') target -= 1;
  if (target < 1) {
    rewindToStart();
    return;
  }
  rewindTo(target - 1, false);
}

/* ==================== 分支图（Denova 风格泳道 · P-B） ==================== */
const BRANCH_COLORS = ['#7fa7d9', '#d6aa62', '#81b38d', '#c98c8c', '#a795d8', '#72b8b7'];
let timelineView = 'graph';
try { timelineView = localStorage.getItem('adventureAI_timelineView') || 'graph'; } catch (e) { /* ignore */ }
let selectedGraphNodeId = null;

function setTimelineView(view) {
  timelineView = (view === 'list') ? 'list' : 'graph';
  try { localStorage.setItem('adventureAI_timelineView', timelineView); } catch (e) { /* ignore */ }
  const btns = document.querySelectorAll('.tl-view-btn');
  btns.forEach(function (b) { b.classList.toggle('active', b.dataset.view === timelineView); });
  const gv = document.getElementById('branchGraphView');
  const lv = document.getElementById('timelineListView');
  if (gv) gv.style.display = timelineView === 'graph' ? '' : 'none';
  if (lv) lv.style.display = timelineView === 'list' ? '' : 'none';
}

function buildBranchGraph(adv) {
  ensurePlotData(adv);
  const nodes = adv.plotNodes || [];
  const lines = adv.plotLines || [];
  /* 列：沿 parentId 链递归（Denova buildNodeColumns 同款），无父节点列 0 */
  const byId = new Map(nodes.map(function (n) { return [n.id, n]; }));
  const columnById = new Map();
  function getColumn(nodeId, path) {
    const cached = columnById.get(nodeId);
    if (cached !== undefined) return cached;
    if (path.has(nodeId)) return 0;
    path.add(nodeId);
    const node = byId.get(nodeId);
    const column = (node && node.parentId) ? getColumn(node.parentId, path) + 1 : 0;
    path.delete(nodeId);
    columnById.set(nodeId, column);
    return column;
  }
  for (const n of nodes) getColumn(n.id, new Set());
  const rows = lines.map(function (line, idx) {
    const lineNodes = nodes.filter(function (n) { return n.lineId === line.id; })
      .sort(function (a, b) { return (columnById.get(a.id) || 0) - (columnById.get(b.id) || 0) || (byId.get(a.id).createdAt || 0) - (byId.get(b.id).createdAt || 0); });
    return {
      line: line,
      color: BRANCH_COLORS[idx % BRANCH_COLORS.length],
      nodes: lineNodes,
      startColumn: line.fromNodeId ? (columnById.get(line.fromNodeId) || 0) + 1 : 0
    };
  });
  /* 同线顺序补列（避免同列重叠） */
  for (const row of rows) {
    let prev = -1;
    for (const n of row.nodes) {
      const c = Math.max(columnById.get(n.id) || 0, prev + 1);
      columnById.set(n.id, c);
      prev = c;
    }
  }
  let maxColumn = 0;
  for (const n of nodes) maxColumn = Math.max(maxColumn, columnById.get(n.id) || 0);
  /* 连线 */
  const connections = [];
  const lineOf = function (nodeId) { const n = byId.get(nodeId); return n ? n.lineId : null; };
  for (const n of nodes) {
    if (n.parentId) connections.push({ from: n.parentId, to: n.id, branchChanged: lineOf(n.parentId) !== n.lineId });
  }
  for (const row of rows) {
    for (let i = 1; i < row.nodes.length; i++) connections.push({ from: row.nodes[i - 1].id, to: row.nodes[i].id, branchChanged: false });
  }
  /* 回溯点 */
  const markers = [];
  for (const snap of (adv.snapshots || [])) {
    markers.push({ kind: 'snapshot', label: snap.label || '存档', id: snap.id, column: snap.fromIndex != null ? Math.min(snap.fromIndex, maxColumn) : null, color: '#FFB859', icon: '💾' });
  }
  for (const br of (adv.branches || [])) {
    markers.push({ kind: 'branch', label: br.label || '分支', id: br.id, column: br.fromIndex != null ? Math.min(br.fromIndex, maxColumn) : null, color: '#81b38d', icon: '🌿' });
  }
  for (const line of lines) {
    if (line.resume && !line.isMain) markers.push({ kind: 'line', label: 'IF存档·' + line.label, lineId: line.id, column: null, color: '#a795d8', icon: '📍' });
  }
  return { rows: rows, connections: connections, columnById: columnById, markers: markers, maxColumn: maxColumn, nodes: nodes };
}

function renderBranchGraph(adv) {
  const gv = document.getElementById('branchGraphView');
  if (!gv) return;
  const a = adv || getCurrentAdventure();
  if (!a) { gv.innerHTML = ''; return; }
  const esc = escapeHtml;
  const graph = buildBranchGraph(a);
  const L = 34, T = 40, COL = 210, LANE = 88, CARD = 176;
  const height = Math.max(120, T + graph.rows.length * LANE + 30);
  const width = Math.max(400, L + (graph.maxColumn + 1) * COL + 120);
  /* 顶部分支 pill */
  let html = '<div class="branch-pills" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">';
  for (const row of graph.rows) {
    const active = row.line.id === a.currentLineId;
    html += '<button class="branch-pill" style="display:flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;border:1px solid ' + row.color + ';background:' + (active ? row.color + '33' : 'transparent') + ';color:var(--text-primary);cursor:pointer;font-size:12px"' +
      ' onclick="enterPlotNodeFromLine(\'' + row.line.id + '\')">' +
      '<span style="width:8px;height:8px;border-radius:50%;background:' + row.color + ';box-shadow:0 0 8px ' + row.color + '"></span>' +
      '<span>' + esc(row.line.label || (row.line.isMain ? '主线' : row.line.id)) + '</span>' +
      '<span style="opacity:.55">' + row.nodes.length + '</span></button>';
  }
  html += '</div>';
  /* 画布 */
  html += '<div class="branch-canvas" style="position:relative;overflow:auto;border:1px solid var(--border-strong);border-radius:10px;background:rgba(0,0,0,0.25)">' +
    '<div style="position:relative;width:' + width + 'px;height:' + height + 'px">';
  /* 泳道背景线 */
  graph.rows.forEach(function (row, idx) {
    const y = T + idx * LANE;
    html += '<div style="position:absolute;left:0;right:0;top:' + (y - 8) + 'px;height:1px;background:' + row.color + '22"></div>';
    html += '<div style="position:absolute;left:8px;top:' + (y - 14) + 'px;font-size:11px;color:' + row.color + ';opacity:.8">' + esc(row.line.label || (row.line.isMain ? '主线' : row.line.id)) + '</div>';
  });
  /* 连线 */
  const byId = new Map(graph.nodes.map(function (n) { return [n.id, n]; }));
  const pos = function (nodeId) {
    const n = byId.get(nodeId);
    if (!n) return null;
    const col = graph.columnById.get(nodeId) || 0;
    const rowIdx = graph.rows.findIndex(function (r) { return r.line.id === n.lineId; });
    return { x: L + col * COL, y: T + Math.max(0, rowIdx) * LANE };
  };
  let edges = '';
  for (const c of graph.connections) {
    const f = pos(c.from), t = pos(c.to);
    if (!f || !t) continue;
    const x1 = f.x + CARD, y1 = f.y + 26, x2 = t.x, y2 = t.y + 26;
    const curve = Math.max(40, Math.min(110, Math.abs(x2 - x1) * 0.4));
    edges += '<path d="M ' + x1 + ' ' + y1 + ' C ' + (x1 + curve) + ' ' + y1 + ', ' + (x2 - curve) + ' ' + y2 + ', ' + x2 + ' ' + y2 + '" fill="none" stroke="' + (c.branchChanged ? '#81b38d' : 'rgba(180,190,210,0.5)') + '" stroke-width="' + (c.branchChanged ? 2.6 : 2) + '"' + (c.branchChanged ? ' stroke-dasharray="6 5"' : '') + ' stroke-linecap="round"/>';
  }
  html += '<svg style="position:absolute;inset:0;pointer-events:none;overflow:visible" width="' + width + '" height="' + height + '">' + edges + '</svg>';
  /* 回溯点标记（列定位） */
  for (const mk of graph.markers) {
    if (mk.column == null && mk.kind === 'line') continue;
    const col = mk.column != null ? mk.column : 0;
    const x = L + col * COL + 60;
    html += '<button title="' + esc(mk.label) + '" style="position:absolute;left:' + x + 'px;top:6px;font-size:13px;border:none;background:transparent;cursor:pointer;filter:drop-shadow(0 0 4px ' + mk.color + ')" onclick="onMarkerClick(\'' + mk.kind + '\',\'' + mk.id + '\',\'' + (mk.lineId || '') + '\')">' + mk.icon + '</button>';
  }
  /* 节点卡 */
  graph.rows.forEach(function (row, idx) {
    for (const n of row.nodes) {
      const col = graph.columnById.get(n.id) || 0;
      const x = L + col * COL, y = T + idx * LANE;
      const isCur = n.id === selectedGraphNodeId;
      html += '<button data-no-drag="1" onclick="selectGraphNode(\'' + n.id + '\')" title="' + esc(n.summary || n.title) + '" style="position:absolute;left:' + x + 'px;top:' + y + 'px;width:' + CARD + 'px;min-height:52px;text-align:left;border:1px solid ' + (isCur ? row.color : 'var(--border-strong)') + ';border-radius:10px;background:' + (isCur ? row.color + '22' : 'rgba(255,255,255,0.04)') + ';color:var(--text-primary);cursor:pointer;padding:5px 8px;font-size:12px;box-shadow:0 6px 14px rgba(0,0,0,0.25)">' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + row.color + ';margin-right:6px"></span>' +
        '<b>' + esc(n.title) + '</b><br>' +
        '<span style="font-size:11px;color:var(--text-muted);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc((n.summary || '').slice(0, 26)) + '</span>' +
        (n.status === 'active' ? '<span style="font-size:10px;color:' + row.color + '">● 进行中</span>' : '') +
        '</button>';
    }
  });
  /* 空分支占位 */
  graph.rows.forEach(function (row, idx) {
    if (row.nodes.length === 0 && !row.line.isMain) {
      html += '<div style="position:absolute;left:' + (L + row.startColumn * COL) + 'px;top:' + (T + idx * LANE + 5) + 'px;width:' + CARD + 'px;border:1px dashed ' + row.color + ';border-radius:10px;padding:5px 8px;font-size:11px;color:var(--text-muted)">🌿 ' + esc(row.line.label) + '（空）</div>';
    }
  });
  html += '</div></div>';
  /* 底部操作 */
  const sel = graph.nodes.find(function (n) { return n.id === selectedGraphNodeId; });
  html += '<div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap;font-size:12px">' +
    (sel ? '<span>已选：<b>' + esc(sel.title) + '</b></span>' + '<button class="btn btn-secondary" onclick="createBranchFromNode(\'' + sel.id + '\')">🌿 从该节点开新分支</button>' + '<button class="btn btn-secondary" onclick="enterPlotNode(\'' + sel.id + '\')">↪ 进入该节点</button>' : '<span style="color:var(--text-muted)">点击节点可选中；回溯点：💾存档 🌿分支 📍IF线</span>') +
    '</div>';
  gv.innerHTML = html;
}

function selectGraphNode(nodeId) {
  selectedGraphNodeId = nodeId;
  const adv = getCurrentAdventure();
  if (adv) renderBranchGraph(adv);
}

function enterPlotNodeFromLine(lineId) {
  const adv = getCurrentAdventure();
  if (!adv) return;
  if (adv.currentLineId === lineId) { renderTimeline(); return; }
  const line = getPlotLine(adv, lineId);
  if (!line) return;
  if (!line.resume && !line.isMain) { alert('该线还没有存档点'); return; }
  enterPlotNode(lineLastNode(adv, lineId) ? lineLastNode(adv, lineId).id : null);
}

function createBranchFromNode(nodeId) {
  const adv = getCurrentAdventure();
  if (!adv) return;
  const node = adv.plotNodes.find(function (n) { return n.id === nodeId; });
  if (!node) return;
  if (node.fromIndex == null) { alert('该节点没有关联消息位置，无法开分支'); return; }
  rewindTo(node.fromIndex, true);
}

function onMarkerClick(kind, id, lineId) {
  const adv = getCurrentAdventure();
  if (!adv) return;
  if (kind === 'snapshot') {
    const snap = adv.snapshots.find(function (s) { return s.id === id; });
    if (!snap) return;
    if (!confirm('回到存档「' + (snap.label || '') + '」？')) return;
    loadSnapshot(snap.id);
  } else if (kind === 'branch') {
    switchToBranch(id);
  } else if (kind === 'line') {
    const line = getPlotLine(adv, lineId);
    if (!line) return;
    if (!confirm('进入 IF 线「' + line.label + '」的存档？当前进度会保存')) return;
    saveLineResume(adv, adv.currentLineId);
    if (applyLineResume(adv, line)) { adv.currentLineId = line.id; updateSystemPrompt(adv); saveState(); renderAll(); renderTimeline(); }
    else alert('IF 线存档已失效');
  }
}

function renderTimeline() {
  const adv = getCurrentAdventure();
  const body = document.getElementById('timelineBody');
  if (!body) return;
  ensurePlotData(adv);
  if (!adv || adv.conversationHistory.length <= 1) {
    const lv = document.getElementById('timelineListView');
    if (lv) lv.innerHTML = '<p style="color:rgba(255,255,255,0.4)">还没有剧情，开始冒险后这里会以时间轴显示剧情节点</p>';
    const gv = document.getElementById('branchGraphView');
    if (gv) gv.innerHTML = '<p style="color:rgba(255,255,255,0.4)">还没有剧情节点</p>';
    return;
  }
  renderBranchGraph(adv);
  const stats = adv.stats || {};
  const curLine = getPlotLine(adv, adv.currentLineId);
  const curNode = lineLastNode(adv, adv.currentLineId);

  let html = '<div class="timeline-toolbar">' +
    (adv.currentLineId !== 'main' ? '<button class="btn btn-secondary" onclick="gotoMainLine()">↺ 回到主线</button>' : '') +
    '<button class="btn btn-secondary" onclick="addPlotNodeManual()">＋ 记录节点</button>' +
    '<button class="btn btn-secondary" onclick="undoLastTurn()">↩ 回退一轮</button>' +
    '<button class="btn btn-secondary" onclick="rewindToStart()">↺ 从头开始</button>' +
    '</div>' +
    '<div class="tl-stats">' + (curLine ? escapeHtml(curLine.label) : '主线') + (curNode ? ' · 当前：' + escapeHtml(curNode.title) : '') + ' · 节点 ' + ((adv.plotNodes && adv.plotNodes.length) || 0) + ' · 事件 ' + ((adv.eventNodes && adv.eventNodes.length) || 0) + ' · IF线 ' + Math.max(0, (adv.plotLines || []).length - 1) + ' · 回合 ' + (stats.turns || 0) + ' · 死亡 ' + (stats.deaths || 0) + '</div>';

  const mainLine = getPlotLine(adv, 'main');
  const mainNodes = (mainLine ? mainLine.nodeIds : []).map(id => adv.plotNodes.find(n => n.id === id)).filter(Boolean);
  const branchLines = (adv.plotLines || []).filter(l => !l.isMain);

  /* 横向：主线剧情节点 */
  html += '<div class="tl-section-label">📍 剧情节点（横向滚动 →）</div>';
  html += '<div class="tl-axis">';
  if (mainNodes.length === 0) {
    html += '<p style="color:rgba(255,255,255,0.4);font-size:12px;line-height:1.6">还没有剧情节点。剧情推进到关键节点时会自动生成节点卡；也可点「＋ 记录节点」手动添加。</p>';
  }
  for (const node of mainNodes) {
    html += renderPlotNodeCard(adv, node, curNode);
    const children = branchLines.filter(l => l.fromNodeId === node.id);
    for (const line of children) {
      const nodes = (line.nodeIds || []).map(id => adv.plotNodes.find(n => n.id === id)).filter(Boolean);
      html += '<div class="tl-branch">';
      html += '<div class="tl-branch-header">' + escapeHtml(line.label) + (line.id === adv.currentLineId ? ' <span class="tl-current-tag">当前</span>' : '') + '</div>';
      html += '<div class="tl-branch-row">';
      for (const n of nodes) html += renderPlotNodeCard(adv, n, curNode);
      html += '</div></div>';
    }
  }
  html += '</div>';

  /* 横向：事件记录（压缩 / 死亡 / 升级 …） */
  const events = adv.eventNodes || [];
  html += '<div class="tl-events-section">';
  html += '<div class="tl-section-label">⚡ 事件记录（上下文压缩 / 死亡 / 升级 …）</div>';
  if (events.length === 0) {
    html += '<p style="color:rgba(255,255,255,0.4);font-size:12px;line-height:1.6">暂无事件。压缩上下文、角色死亡或升级时会自动记录到这里。</p>';
  } else {
    html += '<div class="tl-events">';
    for (const ev of events) html += renderEventNodeCard(ev, adv);
    html += '</div>';
  }
  html += '</div>';

  html += '<details class="tl-raw"><summary>消息级回溯（精确到每一条消息）</summary>' + renderRawMessageTimeline(adv) + '</details>';
  const listView = document.getElementById('timelineListView');
  if (listView) listView.innerHTML = html;
}

function renderPlotNodeCard(adv, node, curNode) {
  const isCurrent = adv.currentLineId === node.lineId && curNode && curNode.id === node.id;
  const statusBadge = node.status === 'active' ? '<span class="tl-badge active">进行中</span>'
    : node.status === 'failed' ? '<span class="tl-badge failed">失败</span>'
    : '<span class="tl-badge">完成</span>';
  const meta = [node.chapter, node.location, node.characters && node.characters.length ? node.characters.join('、') : ''].filter(Boolean).join(' · ');
  return '<div class="tl-card' + (isCurrent ? ' current' : '') + '">' +
    '<div class="tl-card-head">' + statusBadge +
      '<span class="tl-card-title">' + escapeHtml(node.title) + '</span>' +
      (isCurrent ? '<span class="tl-current-tag">当前</span>' : '') +
    '</div>' +
    (meta ? '<div class="tl-card-meta">' + escapeHtml(meta) + '</div>' : '') +
    (node.summary ? '<div class="tl-card-summary">' + escapeHtml(node.summary) + '</div>' : '') +
    '<div class="tl-card-actions">' +
      (isCurrent ? '' : '<button class="btn btn-secondary tl-enter" onclick="enterPlotNode(\'' + node.id + '\')">进入此线</button>') +
    '</div>' +
    '</div>';
}

function renderEventNodeCard(ev, adv) {
  const iconMap = { compress: '🗜', death: '💀', levelup: '⬆', event: '•' };
  const clsMap = { compress: 'ev-compress', death: 'ev-death', levelup: 'ev-levelup', event: 'ev-event' };
  const icon = iconMap[ev.type] || '•';
  const cls = clsMap[ev.type] || 'ev-event';
  const t = new Date(ev.createdAt || Date.now());
  const timeStr = (t.getMonth() + 1) + '/' + t.getDate() + ' ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
  return '<div class="tl-event ' + cls + '">' +
    '<div class="tl-event-icon">' + icon + '</div>' +
    '<div class="tl-event-body">' +
      '<div class="tl-event-head"><span class="tl-event-title">' + escapeHtml(ev.title) + '</span><span class="tl-event-time">' + timeStr + '</span></div>' +
      (ev.detail ? '<div class="tl-event-detail">' + escapeHtml(ev.detail) + '</div>' : '') +
    '</div>' +
    '</div>';
}

function renderRawMessageTimeline(adv) {
  const h = adv.conversationHistory;
  let html = '<div class="timeline-list">';
  for (let i = 1; i < h.length; i++) {
    const msg = h[i];
    const isCurrent = i === h.length - 1;
    if (msg.role === 'user') {
      html += '<div class="tl-node tl-user' + (isCurrent ? ' current' : '') + '">' +
        '<span class="tl-role">行动</span><span class="tl-text">' + escapeHtml(msg.content.substring(0, 60)) + '</span></div>';
    } else if (msg.role === 'assistant') {
      const parsed = parseGameResponse(msg.content);
      const st = msg.stateAfter;
      const stateBadge = st ? 'HP ' + st.hp + '/' + st.maxHp + ' · ' + st.location : '';
      html += '<div class="tl-node tl-beat' + (isCurrent ? ' current' : '') + '">' +
        '<span class="tl-role">剧情</span><span class="tl-text">' + escapeHtml(parsed.narrative.substring(0, 60)) + '</span>' +
        '<span class="tl-state">' + escapeHtml(stateBadge) + '</span>' +
        (isCurrent ? '<span class="tl-current-tag">当前</span>' : '<button class="btn btn-secondary tl-rewind" onclick="rewindTo(' + i + ', true)">回到此处</button>') +
        '</div>';
    }
  }
  html += '</div>';
  return html;
}

/* ==================== 消息编辑 / 下一步 ==================== */
function editMessageAt(index) {
  const adv = getCurrentAdventure();
  if (!adv) return;
  const msg = adv.conversationHistory[index];
  if (!msg) return;
  editingMessageIndex = index;
  document.getElementById('editMessageLabel').textContent = msg.role === 'user' ? '玩家行动（可编辑）' : 'AI 叙事（可编辑）';
  if (msg.role === 'assistant') {
    const parsed = parseGameResponse(msg.content);
    document.getElementById('editMessageText').value = parsed.narrative || stripSectionTags(msg.content);
  } else {
    document.getElementById('editMessageText').value = msg.content;
  }
  showModal('editMessageModal');
}

function replaceNarrativeSection(raw, newText) {
  const tag = '[NARRATIVE]';
  const start = raw.indexOf(tag);
  if (start === -1) return newText;
  const head = raw.slice(0, start);
  const rest = raw.slice(start + tag.length);
  const next = rest.search(/\[(STATE|CHANGES|CHOICES|QUESTS|COMBAT|CHARACTERS)\]/i);
  const end = next === -1 ? raw.length : start + tag.length + next;
  return head + tag + '\n' + newText + raw.slice(end);
}

function saveMessageEdit() {
  const adv = getCurrentAdventure();
  if (!adv || editingMessageIndex < 0) return;
  const msg = adv.conversationHistory[editingMessageIndex];
  if (!msg) { closeModal('editMessageModal'); editingMessageIndex = -1; return; }
  const newText = document.getElementById('editMessageText').value;
  if (msg.role === 'assistant') {
    msg.content = replaceNarrativeSection(msg.content, newText);
  } else {
    msg.content = newText;
  }
  adv.updatedAt = Date.now();
  ensureMessageIdentity(msg, editingMessageIndex, adv.id);
  queueConversationArchiveEvent(adv, 'message.edited', { message_id: msg.id, content: msg.content });
  saveState();
  editingMessageIndex = -1;
  closeModal('editMessageModal');
  renderStory();
  renderContextBar();
}

function sendNextStep() {
  if (state.isGenerating) return;
  const adv = getCurrentAdventure();
  if (!adv || adv.character.hp <= 0) return;

  if (!state.apiConfig.apiKey || !state.apiConfig.endpoint) {
    showSettings();
    return;
  }
  sendMessage('继续推进剧情。');
}

function setInputButtonsDisabled(disabled) {
  document.getElementById('sendBtn').disabled = disabled;
  const nextBtn = document.getElementById('nextBtn');
  if (nextBtn) nextBtn.disabled = disabled;
}

/* ==================== 物品使用 ==================== */
function useInventoryItem(index) {
  if (state.isGenerating) return;
  var adv = getCurrentAdventure();
  if (!adv || !adv.character) return;
  var item = adv.character.items[index];
  if (!item) return;
  sendMessage('我使用物品「' + item.name + '」' + (item.desc ? '（' + item.desc + '）' : '') + '。');
}

/* ==================== 战斗行动 ==================== */
function renderCombatActionBar() {
  var adv = getCurrentAdventure();
  var bar = document.getElementById('combatActionBar');
  var skillSelect = document.getElementById('combatSkillSelect');
  if (!bar) return;
  if (adv && adv.mode === 'tavern') {
    bar.style.display = 'none';
    return;
  }
  if (!adv || !adv.combat || !adv.combat.active) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  /* 填充技能下拉 */
  if (skillSelect) {
    var html = '<option value="">— 使用技能 —</option>';
    for (var i = 0; i < adv.character.skills.length; i++) {
      var s = adv.character.skills[i];
      html += '<option value="' + i + '">' + escapeHtml(s.name) + ' Lv.' + s.level + '</option>';
    }
    skillSelect.innerHTML = html;
  }
}

function combatAttack() {
  if (state.isGenerating) return;
  var adv = getCurrentAdventure();
  if (!adv || !adv.combat || !adv.combat.active) return;
  /* 基于力量属性掷骰 */
  var str = adv.character.attributes['力量'] || 10;
  var roll = Math.floor(Math.random() * 20) + 1;
  sendMessage('（战斗行动：攻击。掷骰 d20=' + roll + '，力量 ' + str + '）我发起攻击。');
}

function combatUseSkill(skillIndex) {
  if (state.isGenerating) return;
  var adv = getCurrentAdventure();
  if (!adv || !adv.combat || !adv.combat.active) return;
  var skill = adv.character.skills[skillIndex];
  if (!skill) return;
  /* 重置下拉 */
  document.getElementById('combatSkillSelect').value = '';
  sendMessage('（战斗行动：使用技能「' + skill.name + ' Lv.' + skill.level + '」）我施放技能：' + skill.name + '。');
}

function combatFlee() {
  if (state.isGenerating) return;
  var adv = getCurrentAdventure();
  if (!adv || !adv.combat || !adv.combat.active) return;
  var agi = adv.character.attributes['敏捷'] || 10;
  var roll = Math.floor(Math.random() * 20) + 1;
  sendMessage('（战斗行动：逃跑。掷骰 d20=' + roll + '，敏捷 ' + agi + '）我尝试逃离战斗。');
}



async function sendMessage(text) {
  if (state.isGenerating) return;
  lastFailedMessage = null;
  const input = document.getElementById('messageInput');
  const content = maybeRollDiceMessage(text || input.value.trim());
  if (!content) return;

  if (!state.apiConfig.apiKey || !state.apiConfig.endpoint) {
    showSettings();
    return;
  }

  const adv = getCurrentAdventure();
  if (!adv || (adv.character && adv.character.hp <= 0)) return;

  await queueConversationArchiveSeed(adv);

  state.isGenerating = true;
  setInputButtonsDisabled(true);
  input.value = '';

  const userMessage = { role: 'user', content: content, id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), createdAt: Date.now() };
  adv.conversationHistory.push(userMessage);

  let streamEl = null;
  try {
    /* 以下构造期调用曾位于 try 之外：一旦 updateSystemPrompt（构建系统提示词）抛错，
       异常无法被 catch 捕获，导致 isGenerating 永久卡 true、之后所有发送被静默拦截。
       现统一纳入 try，确保任何异常都能显示给用户并正确复位状态。 */
    updateSystemPrompt(adv);
    renderStory();
    showTypingIndicator();

    await manageContext(adv);
    hideTypingIndicator();
    const useStream = state.apiConfig.streaming !== false;
    let response = '';
    let thinkingAcc = '';
    if (useStream) {
      streamEl = showStreamingBubble();
      response = await callLLM(adv.conversationHistory, function(chunk, thinkingChunk) {
        if (thinkingChunk) {
          thinkingAcc += thinkingChunk;
          updateThinkingBubble(streamEl, thinkingAcc);
        }
        if (chunk) appendStreamChunk(streamEl, chunk);
      });
    } else {
      response = await callLLM(adv.conversationHistory);
    }
    removeStreamBubble(streamEl);
    streamEl = null;
    if (!response || !response.trim()) throw new Error('模型返回了空内容，请重试');

    const assistantMessage = { role: 'assistant', content: response, thinking: thinkingAcc || null, id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), createdAt: Date.now() };
    adv.conversationHistory.push(assistantMessage);
    const parsed = parseGameResponse(response);
    const preLevel = adv.character.level;
    applyParsedResult(adv, parsed);
    /* 升级事件记录到时间轴 */
    if (adv.character.level > preLevel) {
      logEvent(adv, 'levelup', '升级到 Lv.' + adv.character.level, '从 Lv.' + preLevel + ' 提升至 Lv.' + adv.character.level);
    }
    /* 即时刷新右侧栏数值：不等整段故事重渲染，解析完立刻生效 */
    renderCharacterPanel();
    if (parsed.charactersLines && parsed.charactersLines.length > 0) {
      applyCharacterUpdates(adv, parsed.charactersLines);
      refreshMandalaUI();
    }
    updateSystemPrompt(adv);
    /* 记录本轮结束时的角色状态，供剧情回溯恢复 */
    const lastAssistantMsg = adv.conversationHistory[adv.conversationHistory.length - 1];
    if (lastAssistantMsg && lastAssistantMsg.role === 'assistant') {
      lastAssistantMsg.stateAfter = JSON.parse(JSON.stringify(adv.character));
    }
    if (parsed.plot && parsed.plot.length > 0) {
      applyPlotUpdates(adv, parsed.plot, adv.conversationHistory.length - 1);
    }
    queueConversationArchiveEvent(adv, 'message.committed', { message: cloneValue(userMessage) });
    queueConversationArchiveEvent(adv, 'message.committed', { message: cloneValue(assistantMessage) });
    /* 统计与自动存档 */
    if (!adv.stats) adv.stats = { turns: 0, deaths: 0, startedAt: Date.now() };
    adv.stats.turns++;
    if (adv.character.hp <= 0) {
      adv.stats.deaths++;
      /* 死亡事件记录到时间轴 */
      logEvent(adv, 'death', '角色死亡', '在 ' + adv.character.location + ' · ' + adv.character.chapter + ' 倒下');
      /* 死亡时自动存档，方便读档重来 */
      createSnapshot(adv, '死亡存档 · ' + defaultSnapshotLabel(adv), 'death');
    }
    maybeAutoSave(adv);
    adv.updatedAt = Date.now();
    saveState();

    hideTypingIndicator();
    /* FIX: 先解除 isGenerating 再渲染，确保选项正常显示 */
    state.isGenerating = false;
    setInputButtonsDisabled(false);
    renderAll();
  } catch (e) {
    hideTypingIndicator();
    removeStreamBubble(streamEl);
    state.isGenerating = false;
    setInputButtonsDisabled(false);
    console.error('API 调用失败:', e);
    const storyArea = document.getElementById('storyArea');
    const errDiv = document.createElement('div');
    errDiv.className = 'turn-row';
    errDiv.innerHTML = '<div class="narrative-col">' +
      '<div class="msg-bubble ai-bubble" style="border-color:rgba(255,85,102,0.3);background:rgba(255,85,102,0.05)">' +
      '<div style="color:#FF5566;font-size:13px;font-weight:600;margin-bottom:4px">⚠ API 调用失败</div>' +
      '<div style="font-size:12px;color:rgba(255,255,255,0.6)">' + escapeHtml(e.message) + '</div>' +
      '<button class="btn btn-secondary" style="margin-top:8px" onclick="retryLastMessage()">重试</button>' +
      '</div></div><div class="annotation-col"></div>';
    storyArea.appendChild(errDiv);
    scrollToBottom();
    lastFailedMessage = content;
    adv.conversationHistory.pop();
  }
}

function retryLastMessage() {
  if (!lastFailedMessage) return;
  const content = lastFailedMessage;
  lastFailedMessage = null;
  sendMessage(content);
}

function handleChoice(index) {
  if (state.isGenerating) return;
  const adv = getCurrentAdventure();
  if (!adv || adv.character.hp <= 0) return;
  for (let i = adv.conversationHistory.length - 1; i >= 0; i--) {
    if (adv.conversationHistory[i].role === 'assistant') {
      const parsed = parseGameResponse(adv.conversationHistory[i].content);
      if (parsed.choices[index]) {
        sendMessage(parsed.choices[index]);
        return;
      }
    }
  }
}

async function startNewAdventure() {
  const name = document.getElementById('characterName').value.trim() || '冒险者';
  const setting = (composeSettingText() || document.getElementById('adventureSetting').value.trim());
  let theme = state.selectedTheme || '奇幻';
  const profession = state.selectedProfession || null;
  const opts = {};
  opts.mode = state.selectedMode === 'tavern' ? 'tavern' : 'adventure';

  if (theme === '自定义') {
    const customName = document.getElementById('customThemeName').value.trim();
    if (!customName) { alert('请填写自定义主题名称'); return; }
    const customTheme = {
      name: customName,
      location: document.getElementById('customThemeLocation').value.trim() || '未知之地',
      desc: document.getElementById('customThemeDesc').value.trim() || '自由冒险',
      items: document.getElementById('customThemeItems').value.split(/[,，、]/).map(s => s.trim()).filter(Boolean),
    };
    if (customTheme.items.length === 0) customTheme.items = ['干粮'];
    /* 保存自定义主题，下次创建冒险可直接选择 */
    if (!state.customThemes) state.customThemes = [];
    const idx = state.customThemes.findIndex(t => t.name === customName);
    if (idx >= 0) state.customThemes[idx] = customTheme;
    else state.customThemes.push(customTheme);
    const customProf = document.getElementById('customProfessionName').value.trim();
    opts.themeData = customTheme;
    opts.themeKey = customName;
    if (customProf) {
      opts.profession = { name: customProf, attrs: { 力量:10, 敏捷:10, 智力:10, 魅力:10, 幸运:10 }, skills: [] };
    }
    theme = customName;
  } else {
    /* 直接选中已保存的自定义/覆盖主题：作为 customTheme 使用 */
    const ct = (state.customThemes || []).find(t => t.name === theme);
    if (ct) {
      const customTheme = {
        name: ct.name,
        location: ct.location || '未知之地',
        desc: ct.desc || '自由冒险',
        items: (ct.items && ct.items.length) ? ct.items : ['干粮'],
      };
      opts.themeData = customTheme;
      opts.themeKey = ct.name;
      if (ct.professions && ct.professions.length) opts.professionData = ct.professions;
    } else {
      /* 选中冒险类型（题材×玩法模式）：构建 customTheme + 职业 + 推荐知识库 */
      const at = getAdventureType(theme);
      if (at) {
        opts.themeData = { name: at.name, location: at.location, desc: at.desc, items: at.items };
        opts.themeKey = at.name;
        opts.professionData = at.professions;
      }
    }
  }

  /* 自定义职业是用户硬约束，最后写入以避免被主题或 AI 方案覆盖。 */
  const lockedProfession = getLockedProfession();
  if (lockedProfession) {
    customProfession = lockedProfession;
    state.selectedProfession = null;
    opts.profession = { name: lockedProfession, attrs: { 力量:10, 敏捷:10, 智力:10, 魅力:10, 幸运:10 }, skills: [] };
  }

  if (!state.apiConfig.apiKey || !state.apiConfig.endpoint) {
    closeModal('newAdventureModal');
    showSettings();
    return;
  }

  /* 确认页微调的起始地点覆盖（冒险类型/自定义主题都可单独改） */
  if (state.adventureLocationOverride && opts.themeData) {
    opts.themeData = Object.assign({}, opts.themeData, { location: state.adventureLocationOverride });
  }
  closeModal('newAdventureModal');
  const adv = createAdventure(theme, name, setting, profession, opts);
  adv.title = adventureTitleDraft.trim() || (name + '的冒险');
  /* 把勾选的角色卡 / 设定书复制进新冒险 */
  for (const card of pendingLoadCards) {
    if (!adv.characterCards.some(c => c.name === card.name)) {
      adv.characterCards.push(JSON.parse(JSON.stringify(card)));
    }
  }
  for (const book of pendingLoadBooks) {
    if (!adv.backgroundBooks.some(b => b.title === book.title)) {
      adv.backgroundBooks.push(JSON.parse(JSON.stringify(book)));
    }
  }
  if (adv.characterCards.length > 0 || adv.backgroundBooks.length > 0) {
    updateSystemPrompt(adv);
  }
  saveState();
  document.getElementById('storyArea').innerHTML = '';
  document.getElementById('inputArea').style.display = 'flex';
  document.getElementById('headerActions').style.display = 'flex';
  renderAdventureList();
  renderCharacterPanel();
  renderContextBar();

  /* 角色卡 V3：多开局（alternate_greetings）。若有多个开场可选，先弹窗让用户选，
     否则直接进入。 */
  const openings = collectAdventureOpenings(adv);
  if (adventureOpeningHook.trim()) {
    beginAdventureOpening(adv, adventureOpeningHook.trim());
  } else if (openings.length > 0) {
    showOpeningChoiceModal(adv, openings);
  } else {
    beginAdventureOpening(adv, null);
  }
}

/* 收集本冒险可用的全部开局（默认开场 + 各角色卡 alternate_greetings） */
function collectAdventureOpenings(adv) {
  const list = [];
  const seen = new Set();
  for (const card of (adv.characterCards || [])) {
    const add = (text, label) => {
      const t = String(text || '').trim();
      if (!t || seen.has(t)) return;
      seen.add(t);
      list.push({ card: card.name, text: t, label: label });
    };
    if (card.first_mes) add(card.first_mes, card.name + ' · 默认开场');
    (card.alternate_greetings || []).forEach((g, i) => add(g, card.name + ' · 备选开局 ' + (i + 1)));
  }
  return list;
}

/* 弹窗让用户选择开局（多开局） */
function showOpeningChoiceModal(adv, openings) {
  const box = document.getElementById('openingChoices');
  if (!box) { beginAdventureOpening(adv, openings[0] ? openings[0].text : null); return; }
  box.innerHTML = '';
  openings.forEach((o, i) => {
    const label = document.createElement('label');
    label.className = 'opening-choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'openingChoice';
    input.value = String(i);
    if (i === 0) input.checked = true;
    label.appendChild(input);
    const span = document.createElement('span');
    const preview = o.text.length > 140 ? o.text.slice(0, 140) + '…' : o.text;
    span.innerHTML = '<strong>' + escapeHtml(o.label) + '</strong><br><span class="opening-preview">' + escapeHtml(preview) + '</span>';
    label.appendChild(span);
    box.appendChild(label);
  });
  /* 随机开局选项 */
  const rlabel = document.createElement('label');
  rlabel.className = 'opening-choice opening-random';
  const rinput = document.createElement('input');
  rinput.type = 'radio';
  rinput.name = 'openingChoice';
  rinput.value = 'random';
  rlabel.appendChild(rinput);
  const rspan = document.createElement('span');
  rspan.innerHTML = '<strong>🎲 随机开局</strong>';
  rlabel.appendChild(rspan);
  box.appendChild(rlabel);
  showModal('openingChoiceModal');
}

/* 确认开局选择 */
function confirmOpeningChoice() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  let chosen = null;
  const box = document.getElementById('openingChoices');
  if (box) {
    const sel = box.querySelector('input[name="openingChoice"]:checked');
    if (sel) {
      const openings = collectAdventureOpenings(adv);
      if (sel.value === 'random') {
        if (openings.length) chosen = openings[Math.floor(Math.random() * openings.length)].text;
      } else {
        const idx = parseInt(sel.value, 10);
        if (openings[idx]) chosen = openings[idx].text;
      }
    }
  }
  closeModal('openingChoiceModal');
  beginAdventureOpening(adv, chosen);
}

/* 真正开始冒险：把选中的开局作为叙事起点种子，拼装 initMsg 并发送 */
function beginAdventureOpening(adv, seed) {
  let initMsg = adv.setting ? '开始冒险。设定：' + adv.setting : '开始冒险';
  if (seed) initMsg += '。请以如下「开局」作为故事起点展开叙事：\n' + seed;
  if (adv.characterCards.length > 0 || adv.backgroundBooks.length > 0) {
    initMsg += '。已加载角色卡与设定书，设定将随剧情需要动态载入，请遵循已载入的设定';
  }
  initMsg += '。若玩家角色与背景设定不符，请自行补充身份设定使其自洽，并在叙事中自然交代。';
  adv.openingSeed = seed || null;
  sendMessage(initMsg);
}

/* ==================== 新建冒险：旧两步向导（兼容代码，当前不再调用） ==================== */
let advStep = 1; /* 当前创建向导步骤；现行流程使用 1～3 */

function legacyGoAdventureStep(n) {
  const guide = document.getElementById('advGuide');
  if (guide) guide.style.display = 'none';
  advStep = n === 2 ? 2 : 1;
  const s1 = document.getElementById('advStep1');
  const s2 = document.getElementById('advStep2');
  if (s1) s1.style.display = advStep === 1 ? '' : 'none';
  if (s2) s2.style.display = advStep === 2 ? '' : 'none';
  if (advStep === 1) renderLoadLibrary(); /* 回退到挂载页时重渲染，反映第 2 步的移除 */
  document.querySelectorAll('#newAdventureModal .adv-step').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.step) <= advStep);
    el.classList.toggle('cur', Number(el.dataset.step) === advStep);
  });
  const prev = document.getElementById('advPrevBtn');
  const next = document.getElementById('advNextBtn');
  const start = document.getElementById('advStartBtn');
  if (prev) prev.style.display = advStep === 2 ? '' : 'none';
  if (next) next.style.display = advStep === 1 ? '' : 'none';
  if (start) start.style.display = advStep === 2 ? '' : 'none';
  if (advStep === 2) renderAdventureEditor();
}

function legacyNextAdventureStep() { legacyGoAdventureStep(2); }
function legacyPrevAdventureStep() { legacyGoAdventureStep(1); }

/* 读取当前表单与挂载内容，渲染第 2 步「查看并微调」编辑器
 * —— 冒险设定详情 / 角色信息（chara_card_v2 字段）均可微调，角色卡支持单独保存 —— */
function renderAdventureEditorLegacy() {
  const box = document.getElementById('advPreview');
  if (!box) return;
  const esc = escapeHtml;
  const theme = state.selectedTheme || '奇幻';
  const at = getAdventureType(theme);
  const modeTxt = state.selectedMode === 'tavern' ? '🍷 酒馆剧情' : '⚔️ 战斗冒险';
  const charName = (document.getElementById('characterName').value || '').trim() || '冒险者';
  let setting = (document.getElementById('adventureSetting').value || '').trim();
  if (!Object.values(settingParts).some(function (v) { return v; }) && setting) syncSettingPartsFromText(setting);
  /* 起始地点默认：冒险类型 > 自定义主题 > 内置主题 > 覆盖值 */
  let defLoc = '未设定';
  if (at) defLoc = at.location;
  else if (theme === '自定义') defLoc = (document.getElementById('customThemeLocation').value || '').trim() || '未知之地';
  else if (themeData[theme]) defLoc = themeData[theme].location || '未设定';
  const locVal = state.adventureLocationOverride || (defLoc === '未设定' ? '' : defLoc);

  const profOptions = getThemeProfessions(theme) || [];
  const profVal = customProfession || state.selectedProfession || '';

  let html = '<div class="pv-block"><div class="pv-title">🗺 冒险设定 <span class="pv-hint">可直接微调，开始冒险后生效</span></div>';
  html += '<div class="pv-edit-grid">' +
    rowReadonly('主题', esc(theme) + (at ? ' <span class="pv-dim">（冒险类型 · ' + esc(at.genre) + ' / ' + esc(at.mode) + '）</span>' : '')) +
    rowReadonly('模式', esc(modeTxt)) +
    '<div class="pv-edit-field"><label>起始地点</label><input type="text" id="pvLoc" value="' + esc(locVal) + '" placeholder="如：王都郊外的酒馆"></div>' +
    '<div class="pv-edit-field"><label>角色名称</label><input type="text" id="pvCharName" value="' + esc(charName) + '"></div>' +
    '<div class="pv-edit-field"><label>职业</label>' + profSelectHtml(profOptions, profVal) + '</div>' +
    '<div class="pv-edit-field"><label>自定义职业（可选）</label><input type="text" id="pvProfCustom" value="' + esc(customProfession || '') + '" placeholder="填写后优先使用，如：黑客、傀儡师…"></div>' +
    '<div class="pv-edit-field pv-edit-full"><label>世界背景</label><textarea id="pvWorld" rows="2" placeholder="如：木叶村战后和平年代…">' + esc(settingParts.world) + '</textarea></div>' +
    '<div class="pv-edit-field pv-edit-full"><label>玩家身份</label><textarea id="pvIdentity" rows="2" placeholder="如：被日向带回收留的流浪汉…">' + esc(settingParts.identity) + '</textarea></div>' +
    '<div class="pv-edit-field pv-edit-full"><label>初始目标</label><textarea id="pvGoal" rows="2" placeholder="如：留在她家、慢慢侵蚀日向…">' + esc(settingParts.goal) + '</textarea></div>' +
    '<div class="pv-edit-field pv-edit-full"><label>其他说明</label><textarea id="pvOther" rows="2" placeholder="补充规则或特殊要求（可选）">' + esc(settingParts.other) + '</textarea></div>' +
    '<div class="pv-edit-field pv-edit-full"><label>主设定卡（AI 自动补充冒险设定用）</label><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
      (pendingLoadBooks.length === 0
        ? '<select id="pvMainBook"><option value="-1">（尚未挂载设定书，请先在上一步勾选）</option></select>'
        : '<select id="pvMainBook">' + pendingLoadBooks.map(function (b, i) { return '<option value="' + i + '">' + esc(b.title) + '</option>'; }).join('') + '</select>') +
      '<button type="button" class="btn btn-secondary" onclick="aiFillSetting()">✨ AI 自动补充</button></div></div>' +
    '</div></div>';

  /* 角色信息：逐张可编辑、可单独保存（chara_card_v2 字段） */
  html += '<div class="pv-block"><div class="pv-title">🎭 加入的角色 <span class="pv-count">' + pendingLoadCards.length + '</span> <span class="pv-hint">支持单独修改并保存</span> <button type="button" class="btn btn-secondary pv-upload-btn" onclick="uploadCardToPending()">⬆ 上传角色卡</button></div>';
  if (pendingLoadCards.length === 0) {
    html += '<div class="pv-empty">未加入角色卡（可返回上一步勾选）</div>';
  } else {
    pendingLoadCards.forEach(function (c, idx) {
      const avatar = c.avatar
        ? '<img class="char-edit-ava" src="' + loadAttr(c.avatar) + '" alt="">'
        : '<div class="char-edit-ava char-edit-ava-ph">' + esc((c.name || '?').charAt(0)) + '</div>';
      html += '<div class="char-edit-card" data-idx="' + idx + '">' + avatar +
        '<div class="char-edit-fields">' +
        '<div class="pv-edit-field"><label>名称</label><input type="text" data-field="name" value="' + esc(c.name || '') + '"></div>' +
        '<div class="pv-edit-field"><label>外貌形象</label><textarea data-field="appearance" rows="2">' + esc(c.appearance || '') + '</textarea></div>' +
        '<div class="pv-edit-field"><label>性格</label><textarea data-field="personality" rows="2">' + esc(c.personality || '') + '</textarea></div>' +
        '<div class="pv-edit-field"><label>关系 / 背景</label><textarea data-field="relationship" rows="2">' + esc(c.relationship || '') + '</textarea></div>' +
        '<div class="pv-edit-field"><label>备注</label><textarea data-field="notes" rows="2">' + esc(c.notes || '') + '</textarea></div>' +
        '<div class="pv-edit-field"><label>开场白</label><textarea data-field="first_mes" rows="2">' + esc(c.first_mes || '') + '</textarea></div>' +
        '<div class="pv-edit-field"><label>标签（逗号分隔）</label><input type="text" data-field="tags" value="' + esc((c.tags || []).join('，')) + '"></div>' +
        '<div class="char-edit-actions"><button type="button" class="btn btn-secondary char-edit-save" data-idx="' + idx + '">💾 保存</button><button type="button" class="btn btn-secondary char-edit-split" data-idx="' + idx + '">✨ 自动拆分</button><button type="button" class="btn btn-secondary char-edit-ai" data-idx="' + idx + '">🤖 AI 补充</button><span class="char-edit-status" data-idx="' + idx + '"></span></div>' +
        '</div></div>';
    });
  }
  html += '</div>';

  /* 挂载的设定书（可在此移除；允许不添加设定书） */
  html += '<div class="pv-block"><div class="pv-title">📚 挂载的设定书 <span class="pv-count">' + pendingLoadBooks.length + '</span></div>';
  if (pendingLoadBooks.length === 0) {
    html += '<div class="pv-empty">未挂载设定书（可返回上一步勾选，允许不添加设定书）</div>';
  } else {
    html += '<div class="pv-book-list">';
    for (const b of pendingLoadBooks) {
      html += '<div class="pv-book-item">' +
        '<span class="pv-book-name">' + esc(b.title) + '</span>' +
        '<span class="pv-book-meta">' + esc(b.category || '其他') + (b.entries ? ' · ' + b.entries + '条' : '') + '</span>' +
        '<button type="button" class="pv-book-remove" data-title="' + esc(b.title) + '">✕</button>' +
        '</div>';
    }
    html += '</div>';
  }
  html += '</div>';

  box.innerHTML = html;
  bindAdventureEditor(box);
}

function rowReadonly(k, v) {
  return '<div class="pv-edit-field"><label>' + k + '</label><div class="pv-readonly">' + v + '</div></div>';
}

function profSelectHtml(opts, val) {
  if (!opts || !opts.length) {
    return '<input type="text" id="pvProf" value="' + escapeHtml(val || '') + '" placeholder="（无可选职业，可手动填写）">';
  }
  let h = '<select id="pvProf">';
  if (val && !opts.some(function (p) { const n = typeof p === 'string' ? p : (p.name || p); return n === val; })) {
    h += '<option value="' + escapeHtml(val) + '" selected>' + escapeHtml(val) + '（自定义）</option>';
  }
  for (const p of opts) {
    const name = typeof p === 'string' ? p : (p.name || p);
    h += '<option value="' + escapeHtml(name) + '"' + (name === val ? ' selected' : '') + '>' + escapeHtml(name) + '</option>';
  }
  h += '</select>';
  return h;
}

/* 绑定第 2 步编辑器：冒险设定微调写回底层表单/state；角色卡单独保存；设定书移除 */
function bindAdventureEditorLegacy(box) {
  const nameInput = box.querySelector('#pvCharName');
  if (nameInput) nameInput.addEventListener('input', function (e) {
    const el = document.getElementById('characterName');
    if (el) el.value = e.target.value;
  });
  const bindPart = function (id, key) {
    const el = box.querySelector('#' + id);
    if (el) el.addEventListener('input', function (e) {
      settingParts[key] = e.target.value;
      syncSettingTextToInput();
    });
  };
  bindPart('pvWorld', 'world');
  bindPart('pvIdentity', 'identity');
  bindPart('pvGoal', 'goal');
  bindPart('pvOther', 'other');
  const locInput = box.querySelector('#pvLoc');
  if (locInput) locInput.addEventListener('input', function (e) { state.adventureLocationOverride = e.target.value.trim(); });
  const profSel = box.querySelector('#pvProf');
  if (profSel) profSel.addEventListener('change', function (e) { state.selectedProfession = e.target.value || null; });
  const profCustom = box.querySelector('#pvProfCustom');
  if (profCustom) profCustom.addEventListener('input', function (e) {
    customProfession = e.target.value.trim();
    if (customProfession) state.selectedProfession = null;
  });
  box.querySelectorAll('.char-edit-ai').forEach(function (btn) {
    btn.addEventListener('click', function () { aiFillCard(Number(btn.dataset.idx)); });
  });
  box.querySelectorAll('.char-edit-split').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const card = pendingLoadCards[Number(btn.dataset.idx)];
      if (card) { autoFillCardFields(card); renderAdventureEditor(); }
    });
  });
  box.querySelectorAll('.char-edit-save').forEach(function (btn) {
    btn.addEventListener('click', function () { saveCharacterEdit(Number(btn.dataset.idx)); });
  });
  box.querySelectorAll('.pv-book-remove').forEach(function (btn) {
    btn.addEventListener('click', function () { removePendingBook(btn.dataset.title); });
  });
}

/* 单张角色卡保存：从编辑器取值 → 深拷贝写回 pendingLoadCards（不污染全局知识库对象） */
function saveCharacterEdit(idx) {
  const card = pendingLoadCards[idx];
  if (!card) return;
  const root = document.querySelector('.char-edit-card[data-idx="' + idx + '"]');
  if (!root) return;
  const clone = JSON.parse(JSON.stringify(card));
  const get = function (f) { const el = root.querySelector('[data-field="' + f + '"]'); return el ? el.value : ''; };
  clone.name = (get('name') || '').trim() || card.name;
  clone.appearance = get('appearance');
  clone.personality = get('personality');
  clone.relationship = get('relationship');
  clone.notes = get('notes');
  clone.first_mes = get('first_mes');
  clone.tags = get('tags').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
  pendingLoadCards[idx] = clone;
  const btn = root.querySelector('.char-edit-save');
  if (btn) { const old = btn.textContent; btn.textContent = '✓ 已保存'; setTimeout(function () { btn.textContent = old; }, 1200); }
  const status = root.querySelector('.char-edit-status');
  if (status) status.textContent = '已写入';
}

function removePendingBook(title) {
  const i = pendingLoadBooks.findIndex(function (b) { return b.title === title; });
  if (i >= 0) { pendingLoadBooks.splice(i, 1); renderAdventureEditor(); }
}

function showNewAdventureModalLegacy() {
  document.getElementById('characterName').value = '';
  document.getElementById('adventureSetting').value = '';
  settingParts = { world: '', identity: '', goal: '', other: '' };
  state.selectedTheme = '奇幻';
  state.selectedProfession = null;
  state.adventureLocationOverride = '';
  customProfession = ''; /* 避免上一个冒险的自定义职业泄漏到新冒险 */
  renderThemeGrid();
  onThemeSelected('奇幻');
  pendingLoadCards = [];
  pendingLoadBooks = [];
  renderLoadLibrary();
  /* 先问要不要添加设定/角色卡：引导 → 第 1 页勾选 或 直接进第 2 页编辑 */
  advStep = 0;
  const g = document.getElementById('advGuide');
  if (g) g.style.display = '';
  const s1 = document.getElementById('advStep1');
  const s2 = document.getElementById('advStep2');
  if (s1) s1.style.display = 'none';
  if (s2) s2.style.display = 'none';
  const prev = document.getElementById('advPrevBtn');
  const next = document.getElementById('advNextBtn');
  const start = document.getElementById('advStartBtn');
  if (prev) prev.style.display = 'none';
  if (next) next.style.display = 'none';
  if (start) start.style.display = 'none';
  document.querySelectorAll('#newAdventureModal .adv-step').forEach(function (el) {
    el.classList.remove('active'); el.classList.remove('cur');
  });
  showModal('newAdventureModal');
}

/* ==================== 新建冒险：三步 AI 向导（覆盖旧两步实现） ==================== */
function getDefaultAdventureLocation() {
  const theme = state.selectedTheme || '奇幻';
  const adventureType = getAdventureType(theme);
  if (adventureType && adventureType.location) return adventureType.location;
  if (theme === '自定义') return (document.getElementById('customThemeLocation').value || '').trim();
  const customThemeData = (state.customThemes || []).find(function (item) { return item.name === theme; });
  return (customThemeData && customThemeData.location) || (themeData[theme] && themeData[theme].location) || '';
}

function goAdventureStep(step) {
  advStep = Math.max(1, Math.min(3, Number(step) || 1));
  [1, 2, 3].forEach(function (number) {
    const panel = document.getElementById('advStep' + number);
    if (panel) panel.style.display = number === advStep ? '' : 'none';
  });
  document.querySelectorAll('#newAdventureModal .adv-step').forEach(function (el) {
    const number = Number(el.dataset.step);
    el.classList.toggle('active', number <= advStep);
    el.classList.toggle('cur', number === advStep);
  });
  const prev = document.getElementById('advPrevBtn');
  const next = document.getElementById('advNextBtn');
  const start = document.getElementById('advStartBtn');
  if (prev) prev.style.display = advStep > 1 ? '' : 'none';
  if (next) next.style.display = advStep === 1 ? '' : 'none';
  if (start) start.style.display = advStep === 3 ? '' : 'none';
  if (advStep === 1) {
    renderLoadLibrary();
    renderSelectedMaterialTray();
  } else if (advStep === 2) {
    renderStoryProposalChoices();
  } else {
    renderAdventureEditor();
  }
}

function nextAdventureStep() {
  if (advStep === 1) generateStoryProposals();
  else goAdventureStep(Math.min(3, advStep + 1));
}

function prevAdventureStep() {
  goAdventureStep(Math.max(1, advStep - 1));
}

function syncAdventurePreference() {
  const input = document.getElementById('storyPreferenceInput');
  adventureStoryPreference = input ? input.value.trim() : '';
}

function updateProfessionLockBadge() {
  const badge = document.getElementById('professionLockBadge');
  if (!badge) return;
  const profession = getLockedProfession();
  badge.style.display = profession ? '' : 'none';
  badge.textContent = profession ? '🔒 已锁定：' + profession : '🔒 已锁定';
}

function renderSelectedMaterialTray() {
  const tray = document.getElementById('selectedMaterialTray');
  if (!tray) return;
  const chips = [];
  pendingLoadCards.forEach(function (card, index) {
    chips.push('<span class="selected-material-chip">🎭 ' + escapeHtml(card.name || '未命名角色') + '<button type="button" onclick="removePendingMaterial(\'card\',' + index + ')" aria-label="移除角色卡">×</button></span>');
  });
  pendingLoadBooks.forEach(function (book, index) {
    chips.push('<span class="selected-material-chip">📚 ' + escapeHtml(book.title || '未命名设定') + '<button type="button" onclick="removePendingMaterial(\'book\',' + index + ')" aria-label="移除设定书">×</button></span>');
  });
  tray.innerHTML = chips.length ? chips.join('') : '<span class="selected-material-empty">尚未选择素材，也可以只按主题生成故事</span>';
}

function removePendingMaterial(type, index) {
  if (type === 'card') pendingLoadCards.splice(index, 1);
  else pendingLoadBooks.splice(index, 1);
  renderLoadLibrary();
  renderSelectedMaterialTray();
  if (advStep === 3) renderAdventureEditor();
}

function summarizeStoryMaterial() {
  const cards = pendingLoadCards.map(function (card) {
    const detail = [card.appearance, card.personality, card.relationship, card.notes, card.scenario, card.first_mes].filter(Boolean).join('\n');
    return '角色卡【' + (card.name || '未命名') + '】\n' + detail.slice(0, 1400);
  });
  const allBookTitles = pendingLoadBooks.map(function (book) { return book.title || '未命名'; }).join('、');
  const books = pendingLoadBooks.slice(0, 5).map(function (book) {
    return '世界设定【' + (book.title || '未命名') + '】（' + (book.category || '其他') + '）\n' + String(book.content || book.summary || '').slice(0, 2600);
  });
  return {
    cardText: cards.join('\n\n') || '未加载角色卡',
    bookText: (allBookTitles ? '全部设定卡标题：' + allBookTitles + '\n\n' : '') + (books.join('\n\n') || '未加载世界设定卡')
  };
}

function buildStoryProposalMessages() {
  syncAdventurePreference();
  const material = summarizeStoryMaterial();
  const characterName = (document.getElementById('characterName').value || '').trim() || '冒险者';
  const lockedProfession = getLockedProfession();
  const theme = state.selectedTheme || '奇幻';
  const mode = state.selectedMode === 'tavern' ? '酒馆剧情' : '战斗冒险';
  const system = '你是中文互动文字冒险的开局策划。请根据玩家选择的角色卡、世界设定卡、主题和偏好，生成三套差异明显且可直接游玩的故事背景。' +
    '三套方案应分别偏向人物关系、谜团探索、行动冲突，但都必须尊重素材原设定。不要解释，只输出严格 JSON。' +
    '输出格式为 {"proposals":[{"title":"冒险标题","pitch":"一句话卖点","world":"世界背景","playerIdentity":"玩家身份","profession":"建议职业","location":"起始地点","goal":"初始目标","toneTags":["标签1","标签2","标签3"],"cast":[{"name":"角色名","role":"剧情定位","relationship":"与玩家关系"}],"openingHook":"可直接交给叙事 AI 的具体开场场景","other":"补充规则或叙事重点"}]}。' +
    '每个字段都必须填写；title 简短有辨识度；openingHook 必须是一个具体场景而非设定概述。';
  const user = '【主题】' + theme + '\n【模式】' + mode + '\n【玩家名】' + characterName +
    '\n【自定义职业硬约束】' + (lockedProfession || '无；可合理建议') +
    '\n【玩家偏好】' + (adventureStoryPreference || '未填写，请保持通用且有吸引力') +
    '\n\n【角色卡】\n' + material.cardText + '\n\n【世界设定卡】\n' + material.bookText;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

async function generateStoryProposals() {
  if (storyProposalGenerating) return;
  if (!state.apiConfig.apiKey || !state.apiConfig.endpoint) {
    showSettings();
    return;
  }
  storyProposalGenerating = true;
  storyProposalError = '';
  generatedStoryProposals = [];
  selectedStoryProposalId = null;
  goAdventureStep(2);
  try {
    const response = await callLLM(buildStoryProposalMessages());
    generatedStoryProposals = parseStoryProposals(response || '', getLockedProfession()).slice(0, 3);
    if (generatedStoryProposals.length !== 3) throw new Error('AI 未完整返回 3 套方案，请重新生成');
  } catch (error) {
    console.error('生成故事方案失败:', error);
    storyProposalError = (error && error.message) || '生成失败，请重试';
  } finally {
    storyProposalGenerating = false;
    renderStoryProposalChoices();
  }
}

function renderStoryProposalChoices() {
  const status = document.getElementById('storyProposalStatus');
  const grid = document.getElementById('storyProposalGrid');
  if (!status || !grid) return;
  if (storyProposalGenerating) {
    status.innerHTML = '<div class="story-proposal-loading"><span class="loading-spinner"></span><strong>AI 正在整理素材并设计三种开局…</strong><small>角色关系、世界规则与偏好会一起参与生成</small></div>';
    grid.innerHTML = '';
    return;
  }
  if (storyProposalError) {
    status.innerHTML = '<div class="story-proposal-error"><strong>没有成功生成方案</strong><span>' + escapeHtml(storyProposalError) + '</span><button class="btn btn-primary" onclick="generateStoryProposals()">重新生成</button></div>';
    grid.innerHTML = '';
    return;
  }
  status.innerHTML = generatedStoryProposals.length ? '<div class="story-proposal-intro"><strong>选一套最想玩的故事</strong><span>选中后仍可修改标题、设定与开场</span></div>' : '';
  grid.innerHTML = generatedStoryProposals.map(function (proposal, index) {
    const tags = proposal.toneTags.map(function (tag) { return '<span>' + escapeHtml(tag) + '</span>'; }).join('');
    const cast = proposal.cast.slice(0, 4).map(function (member) {
      return '<li><strong>' + escapeHtml(member.name) + '</strong><span>' + escapeHtml(member.role + (member.relationship ? ' · ' + member.relationship : '')) + '</span></li>';
    }).join('');
    return '<article class="story-proposal-card"><div class="story-proposal-number">方案 ' + (index + 1) + '</div>' +
      '<h3>' + escapeHtml(proposal.title) + '</h3><p class="story-proposal-pitch">' + escapeHtml(proposal.pitch) + '</p>' +
      '<div class="story-proposal-tags">' + tags + '</div><dl>' +
      '<div><dt>玩家身份</dt><dd>' + escapeHtml(proposal.playerIdentity) + '</dd></div>' +
      '<div><dt>开局目标</dt><dd>' + escapeHtml(proposal.goal) + '</dd></div>' +
      '<div><dt>起始地点</dt><dd>' + escapeHtml(proposal.location) + '</dd></div></dl>' +
      (cast ? '<ul class="story-proposal-cast">' + cast + '</ul>' : '') +
      '<button class="btn btn-primary" onclick="selectStoryProposal(' + index + ')">选择这套故事</button></article>';
  }).join('');
}

function applyStoryProposal(proposal) {
  if (!proposal) return;
  adventureTitleDraft = proposal.title || '';
  adventureOpeningHook = proposal.openingHook || '';
  settingParts = { world: proposal.world || '', identity: proposal.playerIdentity || '', goal: proposal.goal || '', other: proposal.other || '' };
  state.adventureLocationOverride = proposal.location || getDefaultAdventureLocation();
  if (!getLockedProfession() && proposal.profession) state.selectedProfession = proposal.profession;
  syncSettingTextToInput();
}

function selectStoryProposal(index) {
  const proposal = generatedStoryProposals[index];
  if (!proposal) return;
  selectedStoryProposalId = proposal.id;
  applyStoryProposal(proposal);
  goAdventureStep(3);
}

function skipStoryProposalGeneration() {
  syncAdventurePreference();
  const theme = state.selectedTheme || '奇幻';
  const manual = normalizeStoryProposal({
    title: ((document.getElementById('characterName').value || '').trim() || '冒险者') + '的' + theme + '冒险',
    pitch: '手动调整你的冒险设定', world: adventureStoryPreference, playerIdentity: '',
    profession: getLockedProfession() || state.selectedProfession || '', location: getDefaultAdventureLocation(),
    goal: '', toneTags: ['自定义'], cast: [], openingHook: '', other: ''
  }, 0, getLockedProfession());
  generatedStoryProposals = [manual];
  selectedStoryProposalId = manual.id;
  applyStoryProposal(manual);
  goAdventureStep(3);
}

function renderAdventureEditor() {
  const box = document.getElementById('advPreview');
  if (!box) return;
  const proposal = generatedStoryProposals.find(function (item) { return item.id === selectedStoryProposalId; }) || generatedStoryProposals[0] || null;
  const characterName = (document.getElementById('characterName').value || '').trim() || '冒险者';
  const lockedProfession = getLockedProfession();
  const professionOptions = getThemeProfessions(state.selectedTheme || '奇幻') || [];
  const professionValue = lockedProfession || state.selectedProfession || (proposal && proposal.profession) || '';
  const professionField = lockedProfession
    ? '<div class="pv-readonly profession-locked-value">🔒 ' + escapeHtml(lockedProfession) + '<small>自定义职业已锁定，AI 不会覆盖</small></div>'
    : profSelectHtml(professionOptions, professionValue);
  const tags = proposal ? proposal.toneTags.map(function (tag) { return '<span>' + escapeHtml(tag) + '</span>'; }).join('') : '';
  let html = '<section class="adv-confirm-hero"><div><span class="adv-confirm-kicker">最终确认</span><h3>' + escapeHtml(adventureTitleDraft || '未命名冒险') + '</h3><p>' + escapeHtml((proposal && proposal.pitch) || '修改完成后即可开始冒险') + '</p></div><div class="story-proposal-tags">' + tags + '</div></section>';
  html += '<section class="pv-block"><div class="pv-title">冒险与玩家</div><div class="pv-edit-grid">' +
    '<div class="pv-edit-field pv-edit-full"><label>冒险标题</label><input type="text" id="pvTitle" value="' + escapeHtml(adventureTitleDraft) + '" placeholder="为这次冒险起个标题"></div>' +
    '<div class="pv-edit-field"><label>角色名称</label><input type="text" id="pvCharName" value="' + escapeHtml(characterName) + '"></div>' +
    '<div class="pv-edit-field"><label>职业</label>' + professionField + '</div>' +
    '<div class="pv-edit-field pv-edit-full"><label>世界背景</label><textarea id="pvWorld" rows="4">' + escapeHtml(settingParts.world) + '</textarea></div>' +
    '<div class="pv-edit-field pv-edit-full"><label>玩家身份</label><textarea id="pvIdentity" rows="3">' + escapeHtml(settingParts.identity) + '</textarea></div>' +
    '<div class="pv-edit-field"><label>起始地点</label><input type="text" id="pvLoc" value="' + escapeHtml(state.adventureLocationOverride || '') + '"></div>' +
    '<div class="pv-edit-field"><label>初始目标</label><textarea id="pvGoal" rows="3">' + escapeHtml(settingParts.goal) + '</textarea></div>' +
    '<div class="pv-edit-field pv-edit-full"><label>开场钩子</label><textarea id="pvOpeningHook" rows="4" placeholder="AI 将从这个具体场景开始叙事">' + escapeHtml(adventureOpeningHook) + '</textarea></div>' +
    '<div class="pv-edit-field pv-edit-full"><label>其他说明</label><textarea id="pvOther" rows="3">' + escapeHtml(settingParts.other) + '</textarea></div>' +
    '</div></section>';
  html += renderAdventureMaterialSummary(proposal);
  box.innerHTML = html;
  bindAdventureEditor(box);
}

function renderAdventureMaterialSummary(proposal) {
  const castMap = {};
  (proposal && proposal.cast || []).forEach(function (member) { castMap[member.name] = member; });
  let html = '<div class="adv-confirm-materials"><section class="pv-block"><div class="pv-title">加入角色 <span class="pv-count">' + pendingLoadCards.length + '</span></div>';
  html += pendingLoadCards.length ? '<div class="adv-confirm-list">' + pendingLoadCards.map(function (card) {
    const cast = castMap[card.name] || {};
    const summary = [cast.role, cast.relationship, card.personality, card.relationship].filter(Boolean).slice(0, 2).join(' · ');
    return '<div class="adv-confirm-item"><strong>🎭 ' + escapeHtml(card.name || '未命名角色') + '</strong><span>' + escapeHtml(summary || '将按角色卡设定加入故事') + '</span></div>';
  }).join('') + '</div>' : '<div class="pv-empty">未加载角色卡</div>';
  html += '</section><section class="pv-block"><div class="pv-title">世界设定 <span class="pv-count">' + pendingLoadBooks.length + '</span></div>';
  html += pendingLoadBooks.length ? '<div class="adv-confirm-list">' + pendingLoadBooks.map(function (book) {
    const summary = String(book.summary || book.content || '').replace(/\s+/g, ' ').slice(0, 100);
    return '<div class="adv-confirm-item"><strong>📚 ' + escapeHtml(book.title || '未命名设定') + '</strong><span>' + escapeHtml((book.category ? book.category + ' · ' : '') + summary) + '</span></div>';
  }).join('') + '</div>' : '<div class="pv-empty">未加载世界设定卡</div>';
  return html + '</section></div>';
}

function bindAdventureEditor(box) {
  const titleInput = box.querySelector('#pvTitle');
  if (titleInput) titleInput.addEventListener('input', function (event) { adventureTitleDraft = event.target.value; });
  const nameInput = box.querySelector('#pvCharName');
  if (nameInput) nameInput.addEventListener('input', function (event) { document.getElementById('characterName').value = event.target.value; });
  ['World', 'Identity', 'Goal', 'Other'].forEach(function (suffix) {
    const input = box.querySelector('#pv' + suffix);
    const key = suffix.charAt(0).toLowerCase() + suffix.slice(1);
    if (input) input.addEventListener('input', function (event) {
      settingParts[key] = event.target.value;
      syncSettingTextToInput();
    });
  });
  const locationInput = box.querySelector('#pvLoc');
  if (locationInput) locationInput.addEventListener('input', function (event) { state.adventureLocationOverride = event.target.value.trim(); });
  const openingInput = box.querySelector('#pvOpeningHook');
  if (openingInput) openingInput.addEventListener('input', function (event) { adventureOpeningHook = event.target.value; });
  const professionInput = box.querySelector('#pvProf');
  if (professionInput) {
    const eventName = professionInput.tagName === 'SELECT' ? 'change' : 'input';
    professionInput.addEventListener(eventName, function (event) { state.selectedProfession = event.target.value.trim() || null; });
  }
}

function showNewAdventureModal() {
  closeMobileSidebar();
  document.getElementById('characterName').value = '';
  document.getElementById('adventureSetting').value = '';
  const preferenceInput = document.getElementById('storyPreferenceInput');
  if (preferenceInput) preferenceInput.value = '';
  const professionInput = document.getElementById('customProfessionInput');
  if (professionInput) professionInput.value = '';
  const hiddenProfessionInput = document.getElementById('customProfessionName');
  if (hiddenProfessionInput) hiddenProfessionInput.value = '';
  settingParts = { world: '', identity: '', goal: '', other: '' };
  state.selectedTheme = '奇幻';
  state.selectedProfession = null;
  state.selectedMode = 'adventure';
  state.adventureLocationOverride = '';
  customProfession = '';
  pendingLoadCards = [];
  pendingLoadBooks = [];
  resetAdventureCreationSession();
  document.querySelectorAll('#modeGrid .mode-card').forEach(function (card) { card.classList.toggle('selected', card.dataset.mode === 'adventure'); });
  renderThemeGrid();
  onThemeSelected('奇幻');
  updateProfessionLockBadge();
  showModal('newAdventureModal');
  goAdventureStep(1);
}

/* ==================== 角色卡文件导入 ==================== */
/* 角色卡字段自动拆分：把备注里按节写的设定（Appearance/Personality/Relationship 等）提取到对应字段 */
/* AI 提取设定（保文风/用词：直接摘取原文，不改编、不删改敏感词） */
const AI_EXTRACT_SYSTEM = '你是设定提取助手。请阅读下面提供的【原文】，把关键信息原样摘取到指定字段。\n' +
  '要求：①严格基于原文直接摘取或压缩原句，保留原文风格、语气与用词（包括敏感或露骨词汇），不要改编、美化、删改或添加审查措辞；' +
  '④**全部用中文输出**：原文为外文时翻译成自然地道的中文（避免机翻腔）；英文人名/地名本地化为常用中文名（如 Konoha→木叶、Serena→塞蕾娜），不要出现英文人名/地名；' +
  '②只输出原文中确实存在的信息，不要编造；③只输出指定格式，每行以「字段名：」开头，不要任何解释。';

function applySettingExtraction(text) {
  const out = {};
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    if (/^世界背景[:：]/.test(line)) { cur = 'world'; out.world = line.replace(/^世界背景[:：]\s*/, ''); }
    else if (/^玩家身份[:：]/.test(line)) { cur = 'identity'; out.identity = line.replace(/^玩家身份[:：]\s*/, ''); }
    else if (/^初始目标[:：]/.test(line)) { cur = 'goal'; out.goal = line.replace(/^初始目标[:：]\s*/, ''); }
    else if (/^其他说明[:：]/.test(line)) { cur = 'other'; out.other = line.replace(/^其他说明[:：]\s*/, ''); }
    else if (cur && line.trim()) out[cur] = out[cur] ? out[cur] + '\n' + line : line;
  }
  return out;
}

function applyCardExtraction(text, card) {
  const out = { appearance: '', personality: '', relationship: '', background: '' };
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    if (/^(外貌|外观)[:：]/.test(line)) { cur = 'appearance'; out.appearance = line.replace(/^(外貌|外观)[:：]\s*/, ''); }
    else if (/^(性格|个性)[:：]/.test(line)) { cur = 'personality'; out.personality = line.replace(/^(性格|个性)[:：]\s*/, ''); }
    else if (/^关系[:：]/.test(line)) { cur = 'relationship'; out.relationship = line.replace(/^关系[:：]\s*/, ''); }
    else if (/^背景[:：]/.test(line)) { cur = 'background'; out.background = line.replace(/^背景[:：]\s*/, ''); }
    else if (cur && line.trim()) out[cur] = out[cur] ? out[cur] + '\n' + line : line;
  }
  if (out.appearance && !card.appearance) card.appearance = out.appearance;
  if (out.personality && !card.personality) card.personality = out.personality;
  if (out.relationship && !card.relationship) card.relationship = out.relationship;
  if (out.background) {
    if (!card.relationship) card.relationship = out.background;
    else card.notes = (card.notes ? card.notes + '\n' : '') + '背景：' + out.background;
  }
  return out;
}

async function aiFillSetting() {
  const sel = document.getElementById('pvMainBook');
  const idx = sel ? Number(sel.value) : -1;
  const book = pendingLoadBooks[idx];
  if (!book) { alert('请先选择主设定卡（或先在上一步挂载设定书）'); return; }
  if (!state.apiConfig.apiKey || !state.apiConfig.endpoint) { showSettings(); return; }
  const original = (book.content || '').substring(0, 8000);
  const current = composeSettingText();
  const user = '【原文】\n' + original + '\n\n【当前字段（仅参考，缺失处可补）】\n' + (current || '（空）') + '\n\n请按以下格式输出（每行一个字段；全部用中文，外文人名/地名请本地化，不要出现英文名）：\n世界背景：\n玩家身份：\n初始目标：\n其他说明：';
  try {
    const out = await callLLM([{ role: 'system', content: AI_EXTRACT_SYSTEM }, { role: 'user', content: user }]);
    const extracted = applySettingExtraction(out || '');
    for (const k of ['world', 'identity', 'goal', 'other']) {
      if (extracted[k] && !settingParts[k]) settingParts[k] = extracted[k];
    }
    syncSettingTextToInput();
    renderAdventureEditor();
  } catch (e) { console.error('AI 补充失败:', e); alert('AI 补充失败：' + (e && e.message)); }
}

async function aiFillCard(idx) {
  const card = pendingLoadCards[idx];
  if (!card) return;
  if (!state.apiConfig.apiKey || !state.apiConfig.endpoint) { showSettings(); return; }
  const original = (card.notes || '').substring(0, 6000);
  if (!original) { alert('该角色卡没有备注原文可提取'); return; }
  const user = '【角色卡原文】\n' + original + '\n\n请按以下格式输出（每行一个字段，原文没有的留空；全部用中文，外文人名/地名请本地化，不要出现英文名）：\n外貌：\n性格：\n关系：\n背景：';
  try {
    const out = await callLLM([{ role: 'system', content: AI_EXTRACT_SYSTEM }, { role: 'user', content: user }]);
    applyCardExtraction(out || '', card);
    renderAdventureEditor();
  } catch (e) { console.error('AI 补充失败:', e); alert('AI 补充失败：' + (e && e.message)); }
}

function uploadCardToPending() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.md,.json,.png';
  input.style.display = 'none';
  document.body.appendChild(input);
  const done = function () { input.remove(); renderAdventureEditor(); };
  input.addEventListener('change', function () {
    const file = input.files && input.files[0];
    if (!file) { done(); return; }
    const addCard = function (c) {
      if (c && c.name && !pendingLoadCards.some(function (p) { return p.name === c.name; })) {
        autoFillCardFields(c);
        pendingLoadCards.push(c);
      }
    };
    if (/\.png$/i.test(file.name)) {
      const fr = new FileReader();
      fr.onload = function (e2) {
        try {
          const raw = extractCharaFromPNG(new Uint8Array(e2.target.result));
          const obj = parseCharaPayload(raw);
          if (obj) addCard(normalizeCardObject(obj));
        } catch (e) { console.error(e); }
        done();
      };
      fr.readAsArrayBuffer(file);
      return;
    }
    const reader = new FileReader();
    reader.onload = function (ev) {
      try {
        const cards = parseCharacterCardsFromFile(String(ev.target.result || ''));
        for (const c of cards) addCard(c);
      } catch (e) { console.error(e); alert('导入失败：' + (e && e.message)); }
      done();
    };
    reader.readAsText(file, 'UTF-8');
  });
  input.click();
}

function autoFillCardFields(card) {
  if (!card || !card.notes) return false;
  let changed = false;
  const notes = card.notes;
  const sectionRe = /(?:^|\n)\s*(Appearance|Personality|Relationship|Scenario|Background|Description|外貌|性格|个性|关系|场景|背景|描述)\s*[:：]/gi;
  const matches = [];
  let m;
  while ((m = sectionRe.exec(notes))) matches.push({ index: m.index, label: m[1].toLowerCase() });
  if (matches.length >= 2) {
    const removed = [];
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index;
      const end = i + 1 < matches.length ? matches[i + 1].index : notes.length;
      const section = notes.slice(start, end).replace(/^\s*(Appearance|Personality|Relationship|Scenario|外貌|性格|个性|关系|场景)\s*[:：]/i, '').trim();
      const label = matches[i].label;
      if ((label === 'appearance' || label === '外貌') && !card.appearance && section) { card.appearance = section; removed.push(start, end); changed = true; }
      else if ((label === 'personality' || label === '性格' || label === '个性') && !card.personality && section) { card.personality = section; removed.push(start, end); changed = true; }
      else if ((label === 'relationship' || label === '关系') && !card.relationship && section) { card.relationship = section; removed.push(start, end); changed = true; }
      else if ((label === 'scenario' || label === '场景') && !card.scenario && section) { card.scenario = section; removed.push(start, end); changed = true; }
    }
    if (removed.length) {
      const ranges = [];
      for (let i = 0; i < removed.length; i += 2) ranges.push([removed[i], removed[i + 1]]);
      ranges.sort(function (a, b) { return b[0] - a[0]; });
      let out = notes;
      for (const r of ranges) out = out.slice(0, r[0]) + out.slice(r[1]);
      card.notes = out.trim();
    }
    return changed;
  }
  const singles = [
    ['appearance', /外貌[:：]\s*([^\n]+)/],
    ['personality', /性格[:：]\s*([^\n]+)/],
    ['relationship', /关系[:：]\s*([^\n]+)/],
  ];
  for (const item of singles) {
    if (card[item[0]]) continue;
    const mm = notes.match(item[1]);
    if (mm && mm[1]) { card[item[0]] = mm[1].trim(); changed = true; }
  }
  return changed;
}

function normalizeCardObject(o) {
  /* 兼容 chub/tavern spec_v2：{ spec, data:{ name, description, personality, scenario, first_mes, tags, creator_notes } } */
  const src = (o && typeof o === 'object' && o.data && typeof o.data === 'object' && (o.data.name || o.spec === 'chara_card_v2')) ? o.data : o;
  const card = {
    name: String(src.name || src.名字 || '').trim(),
    appearance: String(src.appearance || src.外貌 || '').trim(),
    personality: String(src.personality || src.性格 || '').trim(),
    relationship: String(src.relationship || src.关系 || '').trim(),
    notes: String(src.notes || src.备注 || src.description || src.背景 || '').trim(),
  };
  if (src.first_mes) card.first_mes = String(src.first_mes).trim();
  if (src.scenario) card.scenario = String(src.scenario).trim();
  if (src.tags) {
    card.tags = (Array.isArray(src.tags) ? src.tags : String(src.tags).split(/[,，、]/))
      .map(s => String(s).trim()).filter(Boolean);
  }
  if (src.creator_notes) card.creator_notes = String(src.creator_notes).trim();
  /* 角色卡 V3 字段（借鉴 SillyTavern Character V3） */
  if (src.alternate_greetings) {
    card.alternate_greetings = (Array.isArray(src.alternate_greetings) ? src.alternate_greetings : [src.alternate_greetings])
      .map(s => String(s).trim()).filter(Boolean);
  }
  const ext = (src.extensions && typeof src.extensions === 'object') ? src.extensions : {};
  const cn = src.character_note || ext.character_note;
  if (cn) card.character_note = String(cn).trim();
  const dp = (ext && typeof ext.depth_prompt === 'object') ? ext.depth_prompt : null;
  if (dp) {
    if (dp.prompt) card.character_note = String(dp.prompt).trim();
    if (dp.depth != null) { const d = parseInt(dp.depth, 10); if (!isNaN(d)) card.note_depth = d; }
  }
  if (src.note_depth != null) { const d = parseInt(src.note_depth, 10); if (!isNaN(d)) card.note_depth = d; }
  if (src.system_prompt) card.system_prompt = String(src.system_prompt).trim();
  if (src.post_history_instructions) card.post_history_instructions = String(src.post_history_instructions).trim();
  /* 分组 NPC 同场（借鉴 SillyTavern group chat / talkativeness） */
  if (src.talkativeness != null) { const t = parseInt(src.talkativeness, 10); if (!isNaN(t)) card.talkativeness = Math.max(0, Math.min(100, t)); }
  if (src.present === false) card.present = false; // 默认在场（true）
  const sourceRef = (o && o.source_ref) || (src && src.source_ref);
  if (sourceRef) card.source_ref = cloneValue(sourceRef);
  else if (o && typeof o === 'object') card._source_raw = cloneValue(o);
  autoFillCardFields(card);
  /* 外貌缺失时尝试从人设中提取"外貌：xxx" */
  if (!card.appearance && card.notes) {
    const m = card.notes.match(/外貌[:：]\s*([^\n]+)/);
    if (m) card.appearance = m[1].trim();
  }
  return card;
}

function extractCharaFromPNG(data) {
  /* 从 PNG 的 tEXt 块中读取 chara 数据（可能是 base64 或纯 JSON） */
  const bytes = new Uint8Array(data);
  if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47)) return null;
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = ((bytes[pos] & 0xFF) << 24) | ((bytes[pos + 1] & 0xFF) << 16) | ((bytes[pos + 2] & 0xFF) << 8) | (bytes[pos + 3] & 0xFF);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    if (type === 'tEXt' && pos + 8 + len <= bytes.length) {
      const payload = bytes.slice(pos + 8, pos + 8 + len);
      const sep = payload.indexOf(0);
      if (sep > 0) {
        const key = String.fromCharCode.apply(null, payload.slice(0, sep));
        if (key === 'chara') {
          let s = '';
          for (let i = sep + 1; i < payload.length; i++) s += String.fromCharCode(payload[i]);
          return s;
        }
      }
    }
    pos += 12 + len;
  }
  return null;
}

function parseCharaPayload(raw) {
  if (!raw) return null;
  let text = null;
  try { text = decodeURIComponent(escape(atob(raw))); } catch (e) { text = null; }
  if (!text) {
    try { text = decodeURIComponent(escape(atob(raw.replace(/\s/g, '')))); } catch (e) { text = raw; }
  }
  try { return JSON.parse(text); } catch (e) { return null; }
}

function parseCharacterCardsFromFile(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  /* 支持 JSON：单个对象或对象数组 */
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const data = JSON.parse(trimmed);
      const list = Array.isArray(data) ? data : [data];
      return list.map(normalizeCardObject).filter(c => c.name);
    } catch (e) { /* 不是合法 JSON，继续按文本解析 */ }
  }
  /* 文本 key-value 解析 */
  const keyMap = [
    [/^(名字|名称|姓名)\s*[:：]\s*(.+)$/i, 'name'],
    [/^(外貌|外观|长相)\s*[:：]\s*(.+)$/i, 'appearance'],
    [/^(性格|性格特点)\s*[:：]\s*(.+)$/i, 'personality'],
    [/^(关系|与玩家关系|与主角关系)\s*[:：]\s*(.+)$/i, 'relationship'],
    [/^(备注|其他|背景|故事)\s*[:：]\s*(.+)$/i, 'notes'],
  ];
  const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
  const card = { name: '', appearance: '', personality: '', relationship: '', notes: '' };
  const extra = [];
  for (const line of lines) {
    let matched = false;
    for (const [re, key] of keyMap) {
      const m = line.match(re);
      if (m) { card[key] = m[2].trim(); matched = true; break; }
    }
    if (!matched) extra.push(line);
  }
  if (!card.name) card.name = extra.shift() || '';
  if (extra.length > 0) {
    card.notes = (card.notes ? card.notes + '\n' : '') + extra.join('\n');
  }
  return card.name ? [card] : [];
}

/* 通用：把角色卡文件解析为卡片数组（.txt/.md/.json/.png），结果经回调返回 */
function parseFileToCards(file, cb) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    try {
      let cards = [];
      const isPng = /\.png$/i.test(file.name) || file.type === 'image/png';
      if (isPng) {
        const raw = extractCharaFromPNG(ev.target.result);
        if (!raw) { cb(null, '未能从 PNG 中读取角色数据，可能不是角色卡图片'); return; }
        const obj = parseCharaPayload(raw);
        if (!obj) { cb(null, 'PNG 内嵌的角色数据格式无法解析'); return; }
        const card = normalizeCardObject(obj);
        if (!card.name) { cb(null, '未能从 PNG 中解析出角色名称'); return; }
        cards = [card];
      } else {
        cards = parseCharacterCardsFromFile(String(ev.target.result));
      }
      cb(cards, null);
    } catch (err) {
      cb(null, err.message);
    }
  };
  if (/\.png$/i.test(file.name) || file.type === 'image/png') reader.readAsArrayBuffer(file);
  else reader.readAsText(file, 'UTF-8');
}

function handleCardFileImport(file) {
  parseFileToCards(file, function(cards, errMsg) {
    if (errMsg) { alert('导入角色卡失败：' + errMsg); return; }
    if (!cards || cards.length === 0) { alert('未能从文件中解析出角色卡，请检查文件内容'); return; }
    if (!state.uploadedLoadCards) state.uploadedLoadCards = [];
    for (const card of cards) {
      if (!state.uploadedLoadCards.some(c => c.name === card.name)) state.uploadedLoadCards.push(card);
      if (!pendingLoadCards.some(c => c.name === card.name)) pendingLoadCards.push(card);
    }
    renderLoadLibrary();
    alert('已从文件导入 ' + cards.length + ' 张角色卡');
  });
}

/* 角色卡管理弹窗：直接把文件导入到当前冒险（无额外条件限制） */
function importCardToAdventure(file) {
  const adv = getCurrentAdventure();
  if (!adv) { alert('请先开始一个冒险，再导入角色卡'); return; }
  parseFileToCards(file, function(cards, errMsg) {
    if (errMsg) { alert('导入角色卡失败：' + errMsg); return; }
    if (!cards || cards.length === 0) { alert('未能从文件中解析出角色卡，请检查文件内容'); return; }
    if (!adv.characterCards) adv.characterCards = [];
    let added = 0;
    for (const card of cards) {
      if (!adv.characterCards.some(c => c.name === card.name)) { adv.characterCards.push(card); added++; }
    }
    if (added > 0) { updateSystemPrompt(adv); saveState(); renderCharacterCardsList(); }
    alert('已导入 ' + added + ' 张角色卡到当前冒险');
  });
}

/* ==================== 新建冒险：加载已有内容 ==================== */
function getCardLibrary() {
  const map = new Map();
  for (const adv of state.adventures) {
    for (const card of adv.characterCards || []) {
      if (!map.has(card.name)) map.set(card.name, card);
    }
  }
  return Array.from(map.values());
}

function getBookLibrary() {
  const map = new Map();
  for (const adv of state.adventures) {
    for (const book of adv.backgroundBooks || []) {
      if (!map.has(book.title)) map.set(book.title, book);
    }
  }
  return Array.from(map.values());
}

/* ==================== 加载设定 / 角色卡（卡片网格） ==================== */
let loadTab = 'all';
let loadQuery = '';
let loadCategory = 'all';
let lastLoadItems = [];
let showNsfw = false;
let loadView = 'grid'; /* 'grid' 卡片 | 'list' 列表（类说明文档） */
try { loadView = localStorage.getItem('adventureAI_loadView') === 'list' ? 'list' : 'grid'; } catch (e) { /* ignore */ }
let customProfession = ''; /* 自定义职业（优先于网格选择） */
let settingParts = { world: '', identity: '', goal: '', other: '' }; /* 冒险设定结构化：世界背景/玩家身份/初始目标/其他 */
try { showNsfw = localStorage.getItem('adventureAI_showNsfw') === '1'; } catch (e) { /* ignore */ }

const LOAD_GROUP_ORDER = ['通用系统', '奇幻', '科幻', '末日废土', '修仙仙侠', '同人世界', '校园', '恐怖', '小说模板', 'NSFW', '讲述者', '其他', '一般角色', 'NSFW角色'];

function loadAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;');
}

function bookCategory(book) {
  const t = (book.tags || []).join(' ') + ' ' + (book.title || '') + ' ' + (book.summary || '');
  if (book.nsfw) return 'NSFW';
  if (/修仙|仙侠|修真/.test(t)) return '修仙仙侠';
  if (/末日|丧尸|废土|僵尸|灾变|求生/.test(t)) return '末日废土';
  if (/赛博|科幻|星际|宇宙|机甲/.test(t)) return '科幻';
  if (/同人|原作|龙珠|碧蓝|冰与火|哈利|Re零|我的英雄|学院|上古卷轴|天际/.test(t)) return '同人世界';
  if (/奇幻|魔法|异世界|DND|精灵|战锤|斗气/.test(t)) return '奇幻';
  if (/系统|RPG|指令|属性|成长|状态|规则/.test(t)) return '通用系统';
  return '其他';
}

function cardCategory(card) {
  const t = (card.tags || []).join(' ');
  if (t.indexOf('讲述者') !== -1) return '讲述者';
  return card.nsfw ? 'NSFW角色' : '一般角色';
}

/* P1: 从 Denova 桥接拉取工程 lore，转成可挂载的设定书条目 */
function loadDenovaBooks(force) {
  if (force !== true && state.denovaBooks && state.denovaBooks.length) {
    return Promise.resolve(state.denovaBooks);
  }
  return fetch(DENOVA_BRIDGE_BASE + '/api/denova/projects').then(function (r) { return r.json(); })
    .then(function (pj) {
      if (!pj.ok || !pj.projects || !pj.projects.length) { state.denovaBooks = []; return []; }
      const jobs = pj.projects.map(function (proj) {
        return fetch(DENOVA_BRIDGE_BASE + '/api/denova/lore?book=' + encodeURIComponent(proj.name))
          .then(function (r) { return r.json(); })
          .then(function (lj) {
            if (!lj.ok || !lj.items || !lj.items.length) return null;
            const items = lj.items;
            const typeStat = {};
            items.forEach(function (it) { typeStat[it.type] = (typeStat[it.type] || 0) + 1; });
            const content = items.slice(0, 200).map(function (it) {
              const keys = Array.isArray(it.keywords) && it.keywords.length ? it.keywords.join('、') : (it.name || it.id);
              return '【' + keys + '】' + String(it.content || '');
            }).join('\n');
            return {
              title: 'Denova·' + proj.name,
              content: content,
              summary: 'Denova 工程「' + proj.name + '」' + items.length + ' 条资料：' + Object.keys(typeStat).map(function (k) { return k + '×' + typeStat[k]; }).join('、'),
              tags: ['Denova', '工程'],
              nsfw: false,
              lang: 'mix',
              category: 'Denova工程',
              entries: items.length,
              _denova: true
            };
          }).catch(function () { return null; });
      });
      return Promise.all(jobs).then(function (books) {
        state.denovaBooks = books.filter(Boolean);
        return state.denovaBooks;
      });
    }).catch(function () { state.denovaBooks = []; return []; });
}

function gatherLoadItems() {
  const cardMap = new Map();
  for (const c of getCardLibrary()) cardMap.set(c.name, c);
  for (const c of state.uploadedLoadCards || []) {
    if (!cardMap.has(c.name)) cardMap.set(c.name, c);
  }
  const localCards = (window.LOCAL_LIBRARY && LOCAL_LIBRARY.cards) || [];
  for (const c of localCards) {
    if (!cardMap.has(c.name)) cardMap.set(c.name, c);
  }
  /* 上传的角色卡默认勾选（重开弹窗时也保持勾选） */
  for (const c of state.uploadedLoadCards || []) {
    if (!pendingLoadCards.some(x => x.name === c.name)) pendingLoadCards.push(c);
  }
  const books = getBookLibrary();
  const localBooks = (window.LOCAL_LIBRARY && LOCAL_LIBRARY.books) || [];
  for (const b of localBooks) {
    if (!books.some(x => x.title === b.title)) books.push(b);
  }
  for (const b of (state.denovaBooks || [])) {
    if (!books.some(x => x.title === b.title)) books.push(b);
  }
  const items = [];
  for (const c of Array.from(cardMap.values())) {
    items.push({
      type: 'card',
      key: c.name,
      name: c.name,
      summary: c.summary || c.relationship || c.appearance || c.personality || '',
      tags: c.tags || [],
      nsfw: !!c.nsfw,
      lang: '',
      entries: 0,
      size: (c.notes || '').length,
      checked: pendingLoadCards.some(x => x.name === c.name),
      category: c.category || cardCategory(c),
      data: c,
    });
  }
  for (const b of books) {
    items.push({
      type: 'book',
      key: b.title,
      name: b.title,
      summary: b.summary || '',
      tags: b.tags || [],
      nsfw: !!b.nsfw,
      lang: b.lang || '',
      entries: b.entries || 0,
      size: b.size || (b.content || '').length,
      checked: pendingLoadBooks.some(x => x.title === b.title),
      category: b.category || bookCategory(b),
      data: b,
    });
  }
  return items;
}

function loadMatches(item, q) {
  if (!q) return true;
  q = q.toLowerCase();
  const hay = (
    item.name + ' ' + (item.summary || '') + ' ' + (item.tags || []).join(' ') + ' ' +
    (item.data.content || item.data.personality || '').substring(0, 400)
  ).toLowerCase();
  return hay.indexOf(q) !== -1;
}

function setLoadTab(type) {
  loadTab = type;
  const tabs = document.querySelectorAll('#loadTabs .load-tab');
  tabs.forEach(b => b.classList.toggle('active', b.dataset.type === type));
  renderLoadLibrary();
}

function setLoadCategory(cat) {
  loadCategory = cat;
  renderLoadLibrary();
}

function toggleNsfw() {
  showNsfw = !showNsfw;
  try { localStorage.setItem('adventureAI_showNsfw', showNsfw ? '1' : '0'); } catch (e) { /* ignore */ }
  renderLoadLibrary();
}

function onLoadSearch() {
  const el = document.getElementById('loadSearchInput');
  loadQuery = el ? el.value.trim() : '';
  renderLoadLibrary();
}

function updateLoadPendingCount() {
  const el = document.getElementById('loadPendingCount');
  if (!el) return;
  let nBooks = 0, nCards = 0, chars = 0;
  for (const b of pendingLoadBooks) { nBooks++; chars += (b.content || '').length; }
  for (const c of pendingLoadCards) { nCards++; chars += (c.notes || c.personality || '').length; }
  el.textContent = (nBooks + nCards > 0)
    ? '已勾选 ' + nBooks + ' 本设定书 · ' + nCards + ' 张角色卡 · 约 ' + Math.round(chars / 1000) + 'k 字'
    : '';
}

function toggleLoadItem(type, key) {
  const item = lastLoadItems.find(x => x.type === type && x.key === key);
  if (!item) return;
  if (type === 'book') {
    const i = pendingLoadBooks.findIndex(b => b.title === key);
    if (i >= 0) pendingLoadBooks.splice(i, 1);
    else pendingLoadBooks.push(item.data);
  } else {
    const i = pendingLoadCards.findIndex(c => c.name === key);
    if (i >= 0) pendingLoadCards.splice(i, 1);
    else { autoFillCardFields(item.data); pendingLoadCards.push(item.data); }
  }
  renderLoadLibrary();
  renderSelectedMaterialTray();
}

function toggleLoadGroup(groupKey, checked) {
  const visible = lastLoadItems.filter(x =>
    x.category === groupKey &&
    (loadTab === 'all' || x.type === (loadTab === 'book' ? 'book' : 'card')) &&
    (showNsfw || !x.nsfw) &&
    loadMatches(x, loadQuery)
  );
  for (const item of visible) {
    if (checked) {
      if (item.type === 'book' && !pendingLoadBooks.some(b => b.title === item.key)) pendingLoadBooks.push(item.data);
      if (item.type === 'card' && !pendingLoadCards.some(c => c.name === item.key)) pendingLoadCards.push(item.data);
    } else {
      if (item.type === 'book') pendingLoadBooks = pendingLoadBooks.filter(b => b.title !== item.key);
      if (item.type === 'card') pendingLoadCards = pendingLoadCards.filter(c => c.name !== item.key);
    }
  }
  renderLoadLibrary();
  renderSelectedMaterialTray();
}

function showLoadPreview(type, key) {
  const item = lastLoadItems.find(x => x.type === type && x.key === key);
  if (!item) return;
  const d = item.data;
  pixivState.previewKeyword = String((type === 'card' && (d.name || d.title)) || key || '');
  const esc = escapeHtml;
  const badges = [];
  if (type === 'book') {
    if (d.source) badges.push(d.source.replace('本地知识库·', ''));
    if (d.entries) badges.push(d.entries + ' 条');
    if (item.lang) badges.push(item.lang === 'zh' ? '中文' : item.lang === 'mix' ? '中英混合' : '英文');
    if (d.size) badges.push((d.size / 1024).toFixed(1) + 'k 字');
  } else if (d.source) {
    badges.push(d.source.replace('本地知识库·', ''));
  }
  if (item.nsfw) badges.push('NSFW');
  const tagHtml = (item.tags || []).map(t =>
    '<span class="load-tag' + (item.nsfw ? ' load-tag-nsfw' : '') + '">' + esc(t) + '</span>'
  ).join('');
  let body = '';
  if (type === 'card' && d.avatar) {
    body += '<img class="load-preview-avatar" src="' + loadAttr(d.avatar) + '" alt="">';
  }
  body += '<div class="load-preview-meta">' + badges.map(b => '<span class="load-badge">' + esc(b) + '</span>').join('') + '</div>';
  if (item.summary) body += '<p class="load-preview-summary">' + esc(item.summary) + '</p>';
  if (tagHtml) body += '<div class="load-tag-row">' + tagHtml + '</div>';
  if (type === 'book') {
    body += '<h4>正文预览</h4><pre class="load-preview-text">' + esc((d.content || '').substring(0, 1200)) + ((d.content || '').length > 1200 ? '…' : '') + '</pre>';
  } else {
    const parts = [];
    if (d.appearance) parts.push('外貌：' + d.appearance);
    if (d.personality) parts.push('性格：' + d.personality);
    if (d.relationship) parts.push('关系：' + d.relationship);
    if (parts.length) body += '<div class="load-preview-fields">' + parts.map(p => '<p>' + esc(p) + '</p>').join('') + '</div>';
    if (d.first_mes) body += '<h4>开场白</h4><pre class="load-preview-text">' + esc((d.first_mes || '').substring(0, 600)) + '</pre>';
    if (d.notes) body += '<h4>备注</h4><pre class="load-preview-text">' + esc((d.notes || '').substring(0, 600)) + '</pre>';
  }
  document.getElementById('loadPreviewTitle').textContent = (type === 'book' ? '设定书：' : '角色卡：') + item.name;
  document.getElementById('loadPreviewBody').innerHTML = body;
  showModal('loadPreviewModal');
}

function renderLoadCard(item) {
  const esc = escapeHtml;
  const d = item.data;
  const avatarHtml = item.type === 'card' ? renderLoadAvatar(item) : '';
  const badges = [];
  if (item.type === 'book') {
    if (d.entries) badges.push(d.entries + '条');
    if (item.lang) badges.push(item.lang === 'zh' ? '中文' : item.lang === 'mix' ? '中英' : 'EN');
  } else if (d.relationship) {
    badges.push('关系：' + d.relationship);
  }
  const nsfwBadge = item.nsfw ? '<span class="load-nsfw-mark">NSFW</span>' : '';
  const tagHtml = (item.tags || []).slice(0, 4).map(t => '<span class="load-tag">' + esc(t) + '</span>').join('');
  const fallbackSummary = item.type === 'book'
    ? (d.content || '').substring(0, 60)
    : (d.personality || d.appearance || '').substring(0, 60);
  /* 纵向弹性布局：名称独占一行（badge 紧跟其后同行换行，不挤压），简介/标签/元信息依次排下 */
  return '<div class="load-card' + (item.checked ? ' checked' : '') + '" ' +
    'data-type="' + item.type + '" data-key="' + loadAttr(item.key) + '">' +
    '<div class="load-card-top">' +
    '<input type="checkbox"' + (item.checked ? ' checked' : '') + '>' +
    avatarHtml +
    '<div class="load-card-main">' +
    '<div class="load-card-namerow"><span class="load-card-name">' + esc(item.name) + '</span>' + nsfwBadge + '</div>' +
    '<div class="load-card-summary">' + esc(item.summary || fallbackSummary) + '</div>' +
    '</div>' +
    '</div>' +
    (tagHtml ? '<div class="load-tag-row">' + tagHtml + '</div>' : '') +
    '<div class="load-card-meta">' + badges.map(b => '<span class="load-badge">' + esc(b) + '</span>').join('') + '</div>' +
    (item.data && item.data._denova ? '<div style="padding:4px 6px 6px"><button class="btn btn-secondary" style="font-size:11px;padding:2px 8px" onclick="event.stopPropagation();aiOrganizeDenovaBook(' + JSON.stringify(item.name.replace(/^Denova·/, '')) + ')">📥 AI 整理入库</button></div>' : '') +
    '</div>';
}

function renderLoadAvatar(item) {
  const esc = escapeHtml;
  const avatar = item.data.avatar;
  if (avatar) {
    return '<img class="load-avatar" src="' + loadAttr(avatar) + '" alt="" loading="lazy">';
  }
  return '<div class="load-avatar load-avatar-ph">' + esc((item.name || '?').charAt(0)) + '</div>';
}

function setLoadView(v) {
  loadView = (v === 'list') ? 'list' : 'grid';
  try { localStorage.setItem('adventureAI_loadView', loadView); } catch (e) { /* ignore */ }
  renderLoadLibrary();
}

function syncSettingPartsFromText(text) {
  const parts = { world: '', identity: '', goal: '', other: '' };
  let cur = 'other';
  for (const line of String(text || '').split('\n')) {
    if (/^世界背景[:：]/.test(line)) { cur = 'world'; parts.world = line.replace(/^世界背景[:：]\s*/, ''); }
    else if (/^玩家身份[:：]/.test(line)) { cur = 'identity'; parts.identity = line.replace(/^玩家身份[:：]\s*/, ''); }
    else if (/^初始目标[:：]/.test(line)) { cur = 'goal'; parts.goal = line.replace(/^初始目标[:：]\s*/, ''); }
    else if (line.trim()) parts[cur] = parts[cur] ? parts[cur] + '\n' + line : line;
  }
  settingParts = parts;
}
function composeSettingText() {
  const parts = [];
  if (settingParts.world) parts.push('世界背景：' + settingParts.world);
  if (settingParts.identity) parts.push('玩家身份：' + settingParts.identity);
  if (settingParts.goal) parts.push('初始目标：' + settingParts.goal);
  if (settingParts.other) parts.push('其他说明：' + settingParts.other);
  return parts.join('\n');
}
function syncSettingTextToInput() {
  const el = document.getElementById('adventureSetting');
  if (el) el.value = composeSettingText();
}
function onAdventureSettingInput() {
  const el = document.getElementById('adventureSetting');
  syncSettingPartsFromText(el ? el.value : '');
}

function onCustomProfessionInput() {
  const el = document.getElementById('customProfessionInput');
  customProfession = el ? el.value.trim() : '';
  if (customProfession) {
    state.selectedProfession = null;
    const grid = document.getElementById('professionGrid');
    if (grid) grid.querySelectorAll('.profession-card').forEach(function (c) { c.classList.remove('selected'); });
  }
  updateProfessionLockBadge();
}

/* 列表模式行（类说明文档：名称 + 中文简介 + 元信息） */
function renderLoadRow(item) {
  const esc = escapeHtml;
  const d = item.data;
  const badges = [];
  if (item.type === 'book') {
    if (d.entries) badges.push(d.entries + ' 条');
    if (item.lang) badges.push(item.lang === 'zh' ? '中文' : item.lang === 'mix' ? '中英' : '英文');
  } else if (d.relationship) {
    badges.push('关系：' + d.relationship);
  }
  const desc = item.summary || (item.type === 'book' ? (d.content || '').substring(0, 90) : (d.personality || d.appearance || '').substring(0, 90));
  return '<label class="lv-row' + (item.checked ? ' checked' : '') + '" data-type="' + item.type + '" data-key="' + loadAttr(item.key) + '">' +
    '<input type="checkbox"' + (item.checked ? ' checked' : '') + '>' +
    '<span class="lv-name">' + esc(item.name) + (item.nsfw ? ' <span class="load-nsfw-mark">NSFW</span>' : '') + '</span>' +
    '<span class="lv-desc">' + esc(desc) + '</span>' +
    '<span class="lv-meta">' + badges.map(function (b) { return '<span class="load-badge">' + esc(b) + '</span>'; }).join('') + '</span>' +
    '</label>';
}

function renderLoadLibrary() {
  const grid = document.getElementById('loadGrid');
  if (!grid) return;
  const esc = escapeHtml;
  lastLoadItems = gatherLoadItems();
  if (!state._denovaBooksLoaded) {
    state._denovaBooksLoaded = true;
    loadDenovaBooks().then(function () { renderLoadLibrary(); });
  }
  updateLoadPendingCount();
  const viewBtns = document.querySelectorAll('#loadViewToggle .load-view-btn');
  viewBtns.forEach(function (b) { b.classList.toggle('active', b.dataset.view === loadView); });
  const nsfwBtn = document.getElementById('loadNsfwBtn');
  if (nsfwBtn) {
    nsfwBtn.classList.toggle('active', showNsfw);
    nsfwBtn.textContent = showNsfw ? 'NSFW：显示中' : 'NSFW：已隐藏';
  }
  if (lastLoadItems.length === 0) {
    grid.innerHTML = '<small style="color:var(--text-muted)">暂无其他冒险中的角色卡 / 设定书</small>';
    return;
  }
  /* 类型标签页 + 搜索 + NSFW 过滤（不含分类），用于决定分类按钮 */
  const baseVisible = lastLoadItems.filter(x =>
    (loadTab === 'all' || x.type === (loadTab === 'book' ? 'book' : 'card')) &&
    (showNsfw || !x.nsfw) &&
    loadMatches(x, loadQuery)
  );
  const presentCats = LOAD_GROUP_ORDER.filter(g => baseVisible.some(x => x.category === g));
  if (loadCategory !== 'all' && presentCats.indexOf(loadCategory) === -1) {
    loadCategory = 'all';
  }
  const catBar = document.getElementById('loadCategoryBar');
  if (catBar) {
    const catHtml = ['all'].concat(presentCats)
      .map(function (c) {
        return '<button type="button" class="load-cat-btn' + (loadCategory === c ? ' active' : '') + '" ' +
          'data-cat="' + loadAttr(c) + '">' + (c === 'all' ? '全部' : esc(c)) + '</button>';
      }).join('');
    catBar.innerHTML = catHtml;
    catBar.querySelectorAll('.load-cat-btn').forEach(btn => {
      btn.addEventListener('click', function () {
        setLoadCategory(this.dataset.cat);
      });
    });
  }
  const visible = baseVisible.filter(x => loadCategory === 'all' || x.category === loadCategory);
  const groups = new Map();
  for (const item of visible) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  let html = '';
  for (const g of LOAD_GROUP_ORDER) {
    const items = groups.get(g);
    if (!items || items.length === 0) continue;
    const allChecked = items.every(x => x.checked);
    html += '<div class="load-group-block">' +
      '<div class="load-group-head">' +
      '<label class="load-group-check"><input type="checkbox" data-group="' + loadAttr(g) + '"' + (allChecked ? ' checked' : '') + '>' +
      '<span class="load-group-name">' + esc(g) + '</span>' +
      '<span class="load-group-count">' + items.length + '</span></label>' +
      '</div><div class="' + (loadView === 'list' ? 'load-list-view' : 'load-grid') + '">';
    for (const item of items) html += (loadView === 'list' ? renderLoadRow(item) : renderLoadCard(item));
    html += '</div></div>';
  }
  if (!html) html = '<small style="color:var(--text-muted)">没有匹配的设定，换个关键词试试</small>';
  grid.innerHTML = html;
  grid.querySelectorAll('.lv-row').forEach(function (row) {
    row.addEventListener('click', function (e) {
      if (e.target.closest('.load-preview-btn')) {
        e.stopPropagation();
        showLoadPreview(row.dataset.type, row.dataset.key);
        return;
      }
      toggleLoadItem(row.dataset.type, row.dataset.key);
    });
  });
  grid.querySelectorAll('.load-card').forEach(card => {
    card.addEventListener('click', function (e) {
      if (e.target.closest('.load-preview-btn')) {
        e.stopPropagation();
        showLoadPreview(card.dataset.type, card.dataset.key);
        return;
      }
      toggleLoadItem(card.dataset.type, card.dataset.key);
    });
  });
  grid.querySelectorAll('input[data-group]').forEach(cb => {
    cb.addEventListener('change', function () {
      toggleLoadGroup(this.dataset.group, this.checked);
    });
  });
}

/* ==================== 随机冒险 ==================== */
const RANDOM_NAMES = ['艾德','莉亚','云舟','晨星','阿泽','苏璃','方野','林晚','顾白','沈夜','柯林','米娅','洛恩','温蒂','杰德','希尔','诺亚','伊芙','雷恩','小满','白鹭','青梧','墨尘','南栀','萧然','扶苏','何夕','陆离'];
const RANDOM_SETTINGS = [
  '失忆的开端——醒来时身边只有一封没有署名的信。',
  '一场突如其来的灾难改变了整个世界的秩序，幸存者在废墟中挣扎求生。',
  '你被卷入一场古老的阴谋，所有线索都指向你的身世。',
  '传说中失落的宝藏即将现世，各方势力暗流涌动。',
  '你收到一封神秘的邀请函，赴宴者却接连失踪。',
  '城市里接连发生离奇事件，所有证据都指向你。',
  '你在梦境与现实之间徘徊，逐渐分不清哪个才是真实。',
  '一封来自过去的信，把你带回早已荒废的故乡。',
  '世界的天空出现异象，裂缝中传来低语，而你成了见证者。',
  '你继承了一间神秘的旧宅，连同它背后的诅咒与秘密。',
];
const RANDOM_CUSTOM_PROFESSIONS = ['冒险者','学者','工匠','商人','佣兵','旅人','医师','猎人'];

function pickRandom(list) {
  if (!list || list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)];
}

function selectThemeCard(theme, customTheme) {
  const grid = document.getElementById('themeGrid');
  if (!grid) return;
  let target = null;
  grid.querySelectorAll('.theme-card').forEach(c => {
    if (customTheme && c.dataset.theme === '自定义' && c.dataset.customName === customTheme.name) target = c;
    if (!customTheme && c.dataset.theme === theme) target = c;
  });
  if (!target) return;
  grid.querySelectorAll('.theme-card').forEach(c => c.classList.remove('selected'));
  target.classList.add('selected');
  state.selectedTheme = theme;
  state.selectedProfession = null;
  if (theme === '自定义') {
    if (customTheme) fillCustomThemeFields(customTheme);
    showCustomThemeFields();
  } else {
    hideCustomThemeFields();
    renderProfessionGrid(theme);
  }
}

function selectProfessionCard(name) {
  const grid = document.getElementById('professionGrid');
  if (!grid) return;
  const btn = grid.querySelector('.profession-card[data-prof="' + name + '"]');
  if (!btn) return;
  grid.querySelectorAll('.profession-card').forEach(c => c.classList.remove('selected'));
  btn.classList.add('selected');
  state.selectedProfession = name;
}

function randomizeAdventureForm() {
  const customThemes = (state.customThemes || []).map(t => t.name);
  const advTypeNames = ADVENTURE_TYPES.map(function (t) { return t.name; });
  const themePool = ['奇幻','科幻','恐怖','末日','武侠','悬疑'].concat(customThemes).concat(advTypeNames);
  const theme = pickRandom(themePool) || '奇幻';

  const name = pickRandom(RANDOM_NAMES) || '冒险者';
  const setting = pickRandom(RANDOM_SETTINGS) || '';

  if (customThemes.indexOf(theme) !== -1) {
    const t = state.customThemes.find(x => x.name === theme);
    selectThemeCard('自定义', t || null);
    document.getElementById('customProfessionName').value = pickRandom(RANDOM_CUSTOM_PROFESSIONS) || '';
  } else {
    selectThemeCard(theme, null);
    const profs = getThemeProfessions(theme);
    const prof = pickRandom(profs || []);
    if (prof) selectProfessionCard(prof.name);
  }
  document.getElementById('characterName').value = name;
  document.getElementById('adventureSetting').value = setting;
}

/* ==================== 掷骰 ==================== */
function parseDiceNotation(text) {
  const m = String(text || '').trim().match(/^(\d*)d(\d+)([+-]\d+)?$/i);
  if (!m) return null;
  return {
    count: m[1] ? parseInt(m[1], 10) : 1,
    sides: parseInt(m[2], 10),
    bonus: m[3] ? parseInt(m[3], 10) : 0,
  };
}

function rollDiceNotation(text) {
  const d = parseDiceNotation(text);
  if (!d || d.count < 1 || d.sides < 2 || d.count > 100) return null;
  const rolls = [];
  let total = 0;
  for (let i = 0; i < d.count; i++) {
    const r = Math.floor(Math.random() * d.sides) + 1;
    rolls.push(r);
    total += r;
  }
  total += d.bonus;
  const detailParts = rolls.join('+') + (d.bonus !== 0 ? (d.bonus > 0 ? '+' : '') + d.bonus : '');
  return {
    text: String(text).trim(),
    total: total,
    show: detailParts && detailParts !== String(total) ? detailParts : '',
  };
}

function diceResultString(notation) {
  const r = rollDiceNotation(notation);
  if (!r) return null;
  return '（掷骰 ' + r.text + '，结果：' + r.total + (r.show ? ' = ' + r.show : '') + '）';
}

function maybeRollDiceMessage(content) {
  const raw = String(content || '').trim();
  let notation = null;
  const cmd = raw.match(/^\/roll\s+(.+)$/i);
  if (cmd) notation = cmd[1].trim();
  else if (parseDiceNotation(raw)) notation = raw;
  if (!notation) return content;
  const suffix = diceResultString(notation);
  return suffix || content;
}

function toggleDiceMenu() {
  const menu = document.getElementById('diceMenu');
  if (!menu) return;
  menu.style.display = menu.style.display === 'none' || !menu.style.display ? 'block' : 'none';
}

function insertDiceResult(notation) {
  const input = document.getElementById('messageInput');
  const menu = document.getElementById('diceMenu');
  if (!input) return;
  const suffix = diceResultString(notation);
  if (!suffix) return;
  input.value = (input.value ? input.value + ' ' : '') + suffix;
  if (menu) menu.style.display = 'none';
  input.focus();
}

function insertAttributeCheck() {
  const input = document.getElementById('messageInput');
  const select = document.getElementById('diceAttrSelect');
  const menu = document.getElementById('diceMenu');
  if (!input || !select) return;
  const adv = getCurrentAdventure();
  const attr = select.value;
  const val = adv && adv.character && adv.character.attributes ? (adv.character.attributes[attr] || 10) : 10;
  const roll = Math.floor(Math.random() * 20) + 1;
  const suffix = '进行' + attr + '检定（掷骰 d20，结果：' + roll + '，属性值 ' + val + '）';
  input.value = (input.value ? input.value + ' ' : '') + suffix;
  if (menu) menu.style.display = 'none';
  input.focus();
}

/* ==================== 随机事件 ==================== */
const RANDOM_EVENT_PROMPTS = [
  '触发一个随机事件。',
  '发生一件意料之外的事情。',
  '一个突发事件打断了当前的局面。',
  '命运发生转折，请插入一个随机事件。',
  '眼前出现了新的变故。',
];

function triggerRandomEvent() {
  if (state.isGenerating) return;
  const adv = getCurrentAdventure();
  if (!adv || adv.character.hp <= 0) return;
  if (!state.apiConfig.apiKey || !state.apiConfig.endpoint) {
    showSettings();
    return;
  }
  sendMessage(pickRandom(RANDOM_EVENT_PROMPTS) || '触发一个随机事件。');
}

/* ==================== 主题管理（增删改 · CRUD） ==================== */
function getAllThemes() {
  const deleted = state.deletedThemes || [];
  const themes = [];
  for (const k of Object.keys(themeData)) {
    if (deleted.indexOf(k) !== -1) continue;
    const override = (state.customThemes || []).find(t => t.isOverride && t.name === k);
    themes.push({ name: k, isCustom: false, data: override || themeData[k] });
  }
  /* 冒险类型（题材×玩法模式）作为可选项，内置不可编辑 */
  for (const at of ADVENTURE_TYPES) {
    if (deleted.indexOf(at.name) !== -1) continue;
    themes.push({ name: at.name, isCustom: false, isAdventureType: true, data: at });
  }
  for (const t of (state.customThemes || [])) {
    if (!t.isOverride) themes.push({ name: t.name, isCustom: true, data: t });
  }
  return themes;
}

function getThemeProfessions(name) {
  const at = getAdventureType(name);
  if (at) return at.professions;
  const ct = (state.customThemes || []).find(t => t.name === name);
  if (ct && Array.isArray(ct.professions) && ct.professions.length) return ct.professions;
  return professionData[name] || [];
}

function renderThemeGrid() {
  const grid = document.getElementById('themeGrid');
  if (!grid) return;
  const themes = getAllThemes();
  grid.innerHTML = '';
  const normal = [];
  const advTypes = [];
  for (const t of themes) { if (t.isAdventureType) advTypes.push(t); else normal.push(t); }
  for (const t of normal) {
    const btn = document.createElement('button');
    btn.className = 'theme-card' + (t.isCustom ? ' custom-theme' : '');
    btn.dataset.theme = t.name;
    btn.dataset.custom = t.isCustom ? '1' : '0';
    if (state.selectedTheme === t.name) btn.classList.add('selected');
    btn.appendChild(document.createTextNode(t.name));
    const tools = document.createElement('span');
    tools.className = 'theme-card-tools';
    const edit = document.createElement('span'); edit.className = 'theme-tool edit'; edit.textContent = '✎'; edit.title = '编辑主题';
    const del = document.createElement('span'); del.className = 'theme-tool del'; del.textContent = '✕'; del.title = '删除主题';
    tools.appendChild(edit); tools.appendChild(del);
    btn.appendChild(tools);
    edit.addEventListener('click', function(e) { e.stopPropagation(); openThemeEditor(t.name); });
    del.addEventListener('click', function(e) { e.stopPropagation(); deleteTheme(t.name); });
    btn.addEventListener('click', function(e) {
      if (e.target.closest('.theme-card-tools')) return;
      onThemeSelected(t.name);
    });
    grid.appendChild(btn);
  }
  /* 末尾保留「自定义」一次性主题卡 */
  const customBtn = document.createElement('button');
  customBtn.className = 'theme-card';
  customBtn.dataset.theme = '自定义';
  if (state.selectedTheme === '自定义') customBtn.classList.add('selected');
  customBtn.appendChild(document.createTextNode('自定义'));
  customBtn.addEventListener('click', function() { selectThemeCard('自定义', null); });
  grid.appendChild(customBtn);
  /* 冒险类型折叠分组（按题材） */
  if (advTypes.length) {
    const detail = document.createElement('details');
    detail.className = 'theme-type-group';
    const sum = document.createElement('summary');
    sum.textContent = '🎯 冒险类型（' + advTypes.length + '）';
    detail.appendChild(sum);
    const genres = [];
    for (const at of advTypes) { if (genres.indexOf(at.data.genre) === -1) genres.push(at.data.genre); }
    for (const genre of genres) {
      const g = document.createElement('div');
      g.className = 'theme-type-genre';
      const gl = document.createElement('div');
      gl.className = 'theme-type-genre-label';
      gl.textContent = genre;
      g.appendChild(gl);
      for (const t of advTypes) {
        if (t.data.genre !== genre) continue;
        const btn = document.createElement('button');
        btn.className = 'theme-card adventure-type' + (state.selectedTheme === t.name ? ' selected' : '');
        btn.dataset.theme = t.name;
        btn.textContent = t.name;
        btn.title = t.data.desc || '';
        btn.addEventListener('click', function () { onThemeSelected(t.name); });
        g.appendChild(btn);
      }
      detail.appendChild(g);
    }
    grid.appendChild(detail);
  }
}

function onThemeSelected(name) {
  const grid = document.getElementById('themeGrid');
  if (grid) {
    grid.querySelectorAll('.theme-card').forEach(c => c.classList.remove('selected'));
    const btns = grid.querySelectorAll('.theme-card');
    for (const b of btns) { if (b.dataset.theme === name) { b.classList.add('selected'); break; } }
  }
  state.selectedTheme = name;
  state.selectedProfession = null;
  if (name === '自定义') {
    showCustomThemeFields();
    const pg = document.getElementById('professionGrid');
    if (pg) pg.innerHTML = '<small style="color:var(--text-muted)">自定义主题可选填一个自定义职业名（属性默认 10 点）</small>';
  } else {
    hideCustomThemeFields();
    renderProfessionGrid(name);
  }
}

function deleteTheme(name) {
  if (!confirm('确定删除主题「' + name + '」？')) return;
  const isBuiltin = !!themeData[name] && !(state.customThemes || []).some(t => t.name === name && !t.isOverride);
  if (isBuiltin) {
    if (!state.deletedThemes) state.deletedThemes = [];
    if (state.deletedThemes.indexOf(name) === -1) state.deletedThemes.push(name);
    state.customThemes = (state.customThemes || []).filter(t => !(t.isOverride && t.name === name));
  } else {
    state.customThemes = (state.customThemes || []).filter(t => t.name !== name);
  }
  if (state.selectedTheme === name) state.selectedTheme = '奇幻';
  saveState();
  renderThemeGrid();
  if (state.selectedTheme === '奇幻') onThemeSelected('奇幻');
}

function openThemeEditor(name) {
  const isNew = !name;
  const builtin = name && themeData[name] && !(state.customThemes || []).some(t => t.name === name);
  const existing = name ? (state.customThemes || []).find(t => t.name === name) : null;
  const data = existing || (builtin ? { name: name, location: themeData[name].location, desc: themeData[name].desc, items: (themeData[name].items || []).map(function(i){ return i.name; }) } : null);
  document.getElementById('themeEditorTitle').textContent = isNew ? '➕ 新建主题' : ('✎ 编辑主题：' + name);
  const nameEl = document.getElementById('themeEditorName');
  nameEl.value = data ? (data.name || '') : '';
  nameEl.readOnly = !isNew && !!builtin;
  document.getElementById('themeEditorLocation').value = data ? (data.location || '') : '';
  document.getElementById('themeEditorDesc').value = data ? (data.desc || '') : '';
  document.getElementById('themeEditorItems').value = data ? (Array.isArray(data.items) ? data.items.map(function(i){ return i.name || i; }).join('、') : '') : '';
  const profs = data && Array.isArray(data.professions) ? data.professions : [];
  document.getElementById('themeEditorProfessions').value = profs.map(function(p) {
    const attrs = p.attrs || {};
    const attrStr = ['力量','敏捷','智力','魅力','幸运'].map(function(a){ return attrs[a] != null ? attrs[a] : 10; }).join(',');
    const skillStr = (p.skills || []).map(function(s){ return s.name; }).join(';');
    return skillStr ? (p.name + '|' + attrStr + '|' + skillStr) : (p.name + '|' + attrStr);
  }).join('\n');
  showModal('themeEditorModal');
  try { nameEl.focus(); } catch (e) {}
}

function parseProfessionsText(text) {
  const lines = String(text || '').split(/\n+/).map(function(s){ return s.trim(); }).filter(Boolean);
  const out = [];
  const attrOrder = ['力量','敏捷','智力','魅力','幸运'];
  for (const line of lines) {
    const parts = line.split('|').map(function(s){ return s.trim(); });
    const pname = parts[0];
    if (!pname) continue;
    const attrs = {};
    if (parts[1]) {
      const vals = parts[1].split(/[,，]/).map(function(s){ return parseInt(s, 10); });
      attrOrder.forEach(function(a, i) { attrs[a] = (vals[i] != null && !isNaN(vals[i])) ? vals[i] : 10; });
    } else {
      attrOrder.forEach(function(a){ attrs[a] = 10; });
    }
    const skills = parts[2] ? parts[2].split(/[;；]/).map(function(s){ return s.trim(); }).filter(Boolean).map(function(s){ return { name: s, level: 1, desc: '' }; }) : [];
    out.push({ name: pname, attrs: attrs, skills: skills });
  }
  return out;
}

function saveThemeFromEditor() {
  const name = document.getElementById('themeEditorName').value.trim();
  if (!name) { alert('请填写主题名称'); return; }
  const location = document.getElementById('themeEditorLocation').value.trim() || '未知之地';
  const desc = document.getElementById('themeEditorDesc').value.trim() || '自由冒险';
  const items = document.getElementById('themeEditorItems').value.split(/[,，、]/).map(function(s){ return s.trim(); }).filter(Boolean);
  const professions = parseProfessionsText(document.getElementById('themeEditorProfessions').value);
  const isBuiltin = !!themeData[name] && !(state.customThemes || []).some(function(t){ return t.name === name && !t.isOverride; });
  const themeObj = { name: name, location: location, desc: desc, items: items.length ? items : ['干粮'], professions: professions, isOverride: !!isBuiltin };
  if (!state.customThemes) state.customThemes = [];
  const idx = state.customThemes.findIndex(function(t){ return t.name === name; });
  if (idx >= 0) state.customThemes[idx] = themeObj;
  else state.customThemes.push(themeObj);
  if (state.deletedThemes) state.deletedThemes = state.deletedThemes.filter(function(n){ return n !== name; });
  saveState();
  renderThemeGrid();
  closeModal('themeEditorModal');
}

function openThemeManager() {
  const list = document.getElementById('themeManagerList');
  if (!list) return;
  const themes = getAllThemes();
  let html = '';
  for (const t of themes) {
    html += '<div class="theme-manage-row">' +
      '<span class="theme-manage-name">' + escapeHtml(t.name) + (t.isCustom ? ' <span class="tag-custom">自定义</span>' : '') + '</span>' +
      '<span class="theme-manage-actions">' +
      '<button class="btn btn-secondary" onclick="openThemeEditor(\'' + escapeHtml(t.name) + '\')">编辑</button>' +
      '<button class="btn btn-secondary" onclick="deleteTheme(\'' + escapeHtml(t.name) + '\')">删除</button>' +
      '</span></div>';
  }
  list.innerHTML = html;
  showModal('themeManagerModal');
}

function showCustomThemeFields() {
  const wrap = document.getElementById('customThemeFields');
  if (wrap) wrap.style.display = 'block';
}
function hideCustomThemeFields() {
  const wrap = document.getElementById('customThemeFields');
  if (wrap) wrap.style.display = 'none';
}
function fillCustomThemeFields(t) {
  document.getElementById('customThemeName').value = t.name || '';
  document.getElementById('customThemeLocation').value = t.location || '';
  document.getElementById('customThemeDesc').value = t.desc || '';
  document.getElementById('customThemeItems').value = (t.items || []).join('、');
  document.getElementById('customProfessionName').value = '';
}

function renderProfessionGrid(theme) {
  const grid = document.getElementById('professionGrid');
  const profList = getThemeProfessions(theme);
  if (profList.length === 0) {
    grid.innerHTML = '<small style="color:var(--text-muted)">该主题暂无职业选项，可直接开始冒险</small>';
    return;
  }
  let html = '';
  for (const prof of profList) {
    html += '<button class="profession-card" data-prof="' + prof.name + '">' + prof.name + '</button>';
  }
  grid.innerHTML = html;
  /* 绑定点击 */
  grid.querySelectorAll('.profession-card').forEach(card => {
    card.addEventListener('click', function() {
      grid.querySelectorAll('.profession-card').forEach(c => c.classList.remove('selected'));
      this.classList.add('selected');
      state.selectedProfession = this.dataset.prof;
      const ci = document.getElementById('customProfessionInput');
      if (ci) ci.value = '';
      customProfession = '';
      updateProfessionLockBadge();
    });
  });
}

function showSettings() {
  closeMobileSidebar();
  document.getElementById('apiEndpoint').value = state.apiConfig.endpoint || '';
  document.getElementById('apiKey').value = state.apiConfig.apiKey || '';
  document.getElementById('modelName').value = state.apiConfig.model || '';
  document.getElementById('maxTokens').value = state.apiConfig.maxTokens || 8000;
  document.getElementById('maxOutputTokens').value = state.apiConfig.maxOutputTokens || 4096;
  document.getElementById('temperature').value = state.apiConfig.temperature ?? 0.85;
  document.getElementById('streamingToggle').checked = state.apiConfig.streaming !== false;
  document.getElementById('loreScanDepth').value = state.apiConfig.loreScanDepth || 14;
  document.getElementById('loreBudgetPct').value = state.apiConfig.loreBudgetPct != null ? state.apiConfig.loreBudgetPct : 30;
  document.getElementById('macroToggle').checked = state.apiConfig.macroEnabled !== false;
  const extCfg = state.apiConfig.extensions || {};
  ['tts'].forEach(k => {
    const el = document.getElementById('ext_' + k);
    if (el) el.checked = extCfg[k] === true;
  });
  document.getElementById('ttsEngine').value = state.apiConfig.ttsEngine || 'native';
  document.getElementById('cosyvoiceEndpoint').value = state.apiConfig.cosyvoiceEndpoint || '';
  document.getElementById('cosyvoiceApiKey').value = state.apiConfig.cosyvoiceApiKey || '';
  document.getElementById('cosyvoiceRelay').value = state.apiConfig.cosyvoiceRelay || '';
  document.getElementById('cosyvoiceVoice').value = state.apiConfig.cosyvoiceVoice || 'longanyang';
  document.getElementById('cosyvoiceConfig').style.display = (state.apiConfig.ttsEngine === 'cosyvoice') ? 'block' : 'none';
  document.getElementById('imageApiEndpoint').value = state.apiConfig.imageApiEndpoint || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
  document.getElementById('imageApiKey').value = state.apiConfig.imageApiKey || '';
  document.getElementById('imageModel').value = state.apiConfig.imageModel || 'qwen-image-3.0-pro';
  document.getElementById('autoSaveToggle').checked = state.apiConfig.autoSave !== false;
  document.getElementById('autoSaveEvery').value = state.apiConfig.autoSaveEvery || 5;
  showModal('settingsModal');
}

function saveSettings() {
  state.apiConfig.endpoint = document.getElementById('apiEndpoint').value.trim();
  state.apiConfig.apiKey = document.getElementById('apiKey').value.trim();
  state.apiConfig.model = document.getElementById('modelName').value.trim();
  state.apiConfig.maxTokens = parseInt(document.getElementById('maxTokens').value) || 8000;
  state.apiConfig.maxOutputTokens = parseInt(document.getElementById('maxOutputTokens').value) || 4096;
  state.apiConfig.temperature = parseFloat(document.getElementById('temperature').value) || 0.85;
  state.apiConfig.streaming = document.getElementById('streamingToggle').checked;
  state.apiConfig.loreScanDepth = parseInt(document.getElementById('loreScanDepth').value) || 14;
  state.apiConfig.loreBudgetPct = parseInt(document.getElementById('loreBudgetPct').value);
  if (isNaN(state.apiConfig.loreBudgetPct)) state.apiConfig.loreBudgetPct = 30;
  state.apiConfig.macroEnabled = document.getElementById('macroToggle').checked;
  state.apiConfig.ttsEngine = document.getElementById('ttsEngine').value || 'native';
  state.apiConfig.cosyvoiceEndpoint = document.getElementById('cosyvoiceEndpoint').value.trim();
  state.apiConfig.cosyvoiceApiKey = document.getElementById('cosyvoiceApiKey').value.trim();
  state.apiConfig.cosyvoiceRelay = document.getElementById('cosyvoiceRelay').value.trim();
  state.apiConfig.cosyvoiceVoice = document.getElementById('cosyvoiceVoice').value.trim() || 'longanyang';
  state.apiConfig.extensions = state.apiConfig.extensions || {};
  ['tts'].forEach(k => {
    state.apiConfig.extensions[k] = document.getElementById('ext_' + k).checked;
    setExtensionEnabled(k, document.getElementById('ext_' + k).checked);
  });
  state.apiConfig.imageApiEndpoint = document.getElementById('imageApiEndpoint').value.trim() || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
  state.apiConfig.imageApiKey = document.getElementById('imageApiKey').value.trim();
  state.apiConfig.imageModel = document.getElementById('imageModel').value.trim() || 'qwen-image-3.0-pro';
  state.apiConfig.autoSave = document.getElementById('autoSaveToggle').checked;
  state.apiConfig.autoSaveEvery = parseInt(document.getElementById('autoSaveEvery').value) || 5;
  /* 保存后刷新当前冒险的系统提示词（含精简状态等设置即时生效） */
  const cur = getCurrentAdventure();
  if (cur) { try { updateSystemPrompt(cur); } catch (e) { console.error('更新系统提示词失败:', e); } }
  saveState();
  closeModal('settingsModal');
}

function showModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

/* ==================== Pixiv 搜图 / AI 成图保存 / 一键生成小说 ==================== */
function openPixivSearch() {
  showModal('pixivModal');
  const inp = document.getElementById('pixivKeyword');
  if (inp) {
    if (!inp.value) inp.value = pixivState.word;
    setTimeout(function () { try { inp.focus(); } catch (e) { /* ignore */ } }, 60);
  }
}

function jumpPixivSearch() {
  const inp = document.getElementById('pixivKeyword');
  const kw = (inp ? inp.value : pixivState.word || '').trim();
  if (!kw) { alert('请输入搜索关键词，如：日向雏田 / 日向ヒナタ'); return; }
  window.open('https://www.pixiv.net/search?q=' + encodeURIComponent(kw) + '&s_mode=tag&type=artwork', '_blank');
}

/* ===== Pixiv App API 本地桥接（tools/pixiv_bridge.py :8098） ===== */
const PIXIV_BRIDGE = PIXIV_BRIDGE_BASE + '/api/pixiv';
const pixivState = {
  tab: 'search', word: '', target: 'partial_match_for_tags', sort: null,
  page: 1, rankMode: 'day', rankPage: 1,
  view: null, viewPage: 0,
  bookmarked: false,
  ugoira: null,
  previewKeyword: ''
};

function pixivNsfwOn() {
  try { return localStorage.getItem('adventureAI_showNsfw') === '1'; } catch (e) { return true; }
}
function pixivIsR18(item) { return !!(item && (item.x_restrict === 1 || item.sanity_level >= 6)); }
function pixivThumb(item) { const u = item.image_urls || {}; return u.square_medium || u.medium || u.large || ''; }
function pixivLarge(item) { const u = item.image_urls || {}; return u.large || u.medium || u.square_medium || ''; }
function pixivImg(url) { return url ? (PIXIV_BRIDGE + '/img?url=' + encodeURIComponent(url)) : ''; }
function pixivEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function pixivSwitchTab(tab) {
  pixivState.tab = tab;
  document.querySelectorAll('.pixiv-tab').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-pixiv-tab') === tab);
  });
  document.getElementById('pixivPanelSearch').style.display = tab === 'search' ? '' : 'none';
  document.getElementById('pixivPanelRank').style.display = tab === 'rank' ? '' : 'none';
}

function pixivFetch(url) {
  return fetch(PIXIV_BRIDGE + url).then(function (r) {
    return r.json().then(function (j) {
      if (!r.ok || j.error) { throw new Error(j.error || ('HTTP ' + r.status)); }
      return j;
    });
  });
}

function pixivFilterItems(items) {
  const on = pixivNsfwOn();
  return (items || []).filter(function (it) { return on || !pixivIsR18(it); });
}

function pixivUpdatePager(pagerId, infoId, page, hasNext, count) {
  const pager = document.getElementById(pagerId);
  if (!pager) return;
  const btns = pager.querySelectorAll('button');
  if (btns[0]) btns[0].style.visibility = page > 1 ? 'visible' : 'hidden';
  if (btns[1]) btns[1].style.visibility = hasNext ? 'visible' : 'hidden';
  const info = document.getElementById(infoId);
  if (info) info.textContent = '第 ' + page + ' 页 · ' + count + ' 条' + (hasNext ? '' : '（末页）');
  pager.style.display = 'flex';
}

function pixivSearch() {
  const inp = document.getElementById('pixivKeyword');
  const kw = (inp ? inp.value : pixivState.word || '').trim();
  if (!kw) { alert('请输入搜索关键词，如：日向雏田 / 日向ヒナタ'); return; }
  pixivState.word = kw;
  pixivState.page = 1;
  const box = document.getElementById('pixivResults');
  box.innerHTML = '<div class="pixiv-tip">🔍 正在搜索「' + pixivEsc(kw) + '」…</div>';
  pixivFetch('/search?q=' + encodeURIComponent(kw) + '&page=1').then(function (j) {
    const items = pixivFilterItems(j.illusts || []);
    pixivRenderGrid(box, items);
    pixivUpdatePager('pixivPager', 'pixivPageInfo', 1, !!j.next_url, items.length);
  }).catch(function (e) {
    box.innerHTML = '<div class="pixiv-tip">❌ ' + pixivEsc(e.message) + '<br><small>请重新运行 Launch-Narraverse.cmd</small></div>';
  });
}

function pixivPage(delta) {
  const np = pixivState.page + delta;
  if (np < 1) return;
  pixivState.page = np;
  const box = document.getElementById('pixivResults');
  box.innerHTML = '<div class="pixiv-tip">⏳ 加载第 ' + np + ' 页…</div>';
  pixivFetch('/search?q=' + encodeURIComponent(pixivState.word) + '&page=' + np).then(function (j) {
    const items = pixivFilterItems(j.illusts || []);
    pixivRenderGrid(box, items);
    pixivUpdatePager('pixivPager', 'pixivPageInfo', np, !!j.next_url, items.length);
  }).catch(function (e) { box.innerHTML = '<div class="pixiv-tip">❌ ' + pixivEsc(e.message) + '</div>'; });
}

function pixivRanking() {
  const sel = document.getElementById('pixivRankMode');
  const mode = sel ? sel.value : pixivState.rankMode;
  pixivState.rankMode = mode;
  pixivState.rankPage = 1;
  const box = document.getElementById('pixivRankResults');
  box.innerHTML = '<div class="pixiv-tip">🏆 加载排行榜…</div>';
  pixivFetch('/ranking?mode=' + encodeURIComponent(mode) + '&page=1').then(function (j) {
    const items = pixivFilterItems(j.illusts || []);
    pixivRenderGrid(box, items);
    pixivUpdatePager('pixivRankPager', 'pixivRankPageInfo', 1, !!j.next_url, items.length);
  }).catch(function (e) { box.innerHTML = '<div class="pixiv-tip">❌ ' + pixivEsc(e.message) + '</div>'; });
}

function pixivRankPage(delta) {
  const np = pixivState.rankPage + delta;
  if (np < 1) return;
  pixivState.rankPage = np;
  const box = document.getElementById('pixivRankResults');
  box.innerHTML = '<div class="pixiv-tip">⏳ 加载第 ' + np + ' 页…</div>';
  pixivFetch('/ranking?mode=' + encodeURIComponent(pixivState.rankMode) + '&page=' + np).then(function (j) {
    const items = pixivFilterItems(j.illusts || []);
    pixivRenderGrid(box, items);
    pixivUpdatePager('pixivRankPager', 'pixivRankPageInfo', np, !!j.next_url, items.length);
  }).catch(function (e) { box.innerHTML = '<div class="pixiv-tip">❌ ' + pixivEsc(e.message) + '</div>'; });
}

function pixivRandom() {
  const page = 1 + Math.floor(Math.random() * 5);
  pixivFetch('/ranking?mode=day&page=' + page).then(function (j) {
    const items = pixivFilterItems(j.illusts || []);
    if (!items.length) { document.getElementById('pixivResults').innerHTML = '<div class="pixiv-tip">😢 没抽到，再试一次</div>'; return; }
    const it = items[Math.floor(Math.random() * items.length)];
    pixivOpenDetail(it.id);
  }).catch(function (e) { document.getElementById('pixivResults').innerHTML = '<div class="pixiv-tip">❌ ' + pixivEsc(e.message) + '</div>'; });
}

function pixivRenderGrid(container, items) {
  if (!container) return;
  if (!items.length) { container.innerHTML = '<div class="pixiv-tip">（没有结果，换个关键词试试）</div>'; return; }
  const cards = items.map(function (it) {
    const r18 = pixivIsR18(it) ? '<span class="pixiv-badge pixiv-badge-r18">R18</span>' : '';
    const multi = it.page_count > 1 ? '<span class="pixiv-badge">' + it.page_count + 'P</span>' : '';
    const bm = it.total_bookmarks != null ? '<span class="pixiv-badge" style="right:auto;left:4px">♥' + it.total_bookmarks + '</span>' : '';
    return '<div class="pixiv-card" onclick="pixivOpenDetail(' + it.id + ')">' +
      '<div class="pixiv-card-img"><img loading="lazy" src="' + pixivImg(pixivThumb(it)) + '" alt="" onerror="this.style.display=\'none\'">' + r18 + multi + bm + '</div>' +
      '<div class="pixiv-card-title">' + pixivEsc(it.title) + '</div>' +
      '<div class="pixiv-card-author">' + pixivEsc((it.user && it.user.name) || '') + '</div>' +
      '</div>';
  }).join('');
  container.innerHTML = '<div class="pixiv-grid-inner">' + cards + '</div>';
}

function pixivOpenDetail(id) {
  if (pixivState.ugoira) { pixivStopUgoira(); }
  showModal('pixivViewModal');
  const wrap = document.getElementById('pixivViewImgWrap');
  wrap.innerHTML = '<div class="pixiv-tip">⏳ 加载作品…</div>';
  document.getElementById('pixivViewInfo').innerHTML = '';
  pixivFetch('/illust?id=' + id).then(function (j) {
    const ill = j.illust || {};
    pixivState.view = ill;
    pixivState.viewPage = 0;
    pixivState.bookmarked = !!j.is_bookmarked;
    pixivState.ugoira = null;
    document.getElementById('pixivViewTitle').textContent = ill.title || ('作品 ' + id);
    let pages = [];
    if (ill.meta_pages && ill.meta_pages.length) {
      pages = ill.meta_pages.map(function (p) {
        return (p.image_urls && (p.image_urls.original || p.image_urls.large || p.image_urls.medium)) || '';
      });
    } else if (ill.meta_single_page && ill.meta_single_page.original_image_url) {
      pages = [ill.meta_single_page.original_image_url];
    } else {
      pages = [pixivLarge(ill)];
    }
    ill._pages = pages.filter(Boolean);
    if (!ill._pages.length) { wrap.innerHTML = '<div class="pixiv-tip">没有可显示的图片</div>'; return; }
    pixivViewRender();
    pixivUpdateViewButtons();
  }).catch(function (e) { wrap.innerHTML = '<div class="pixiv-tip">❌ ' + pixivEsc(e.message) + '</div>'; });
}

function pixivViewPages() { return (pixivState.view && pixivState.view._pages) || []; }

function pixivViewRender() {
  const pages = pixivViewPages();
  if (!pages.length) return;
  const ill = pixivState.view;
  const idx = Math.min(pixivState.viewPage, pages.length - 1);
  pixivState.viewPage = idx;
  document.getElementById('pixivViewImgWrap').innerHTML =
    '<img src="' + pixivImg(pages[idx]) + '" alt="" onerror="this.parentNode.innerHTML=\'<div class=pixiv-tip>图片加载失败（检查桥接服务与代理）</div>\'">';
  const r18 = pixivIsR18(ill) ? ' ⚠️R18' : '';
  document.getElementById('pixivViewInfo').innerHTML =
    '<b>' + pixivEsc(ill.title || '') + '</b>' + r18 + '<br>' +
    '作者：' + pixivEsc((ill.user && ill.user.name) || '') +
    ' ｜ 收藏：' + (ill.total_bookmarks || 0) + ' ｜ 浏览：' + (ill.total_view || 0) + '<br>' +
    '标签：' + (ill.tags || []).map(function (tg) { return pixivEsc(tg.name || ''); }).join('、');
  document.getElementById('pixivViewPage').textContent = (idx + 1) + ' / ' + pages.length;
}

function pixivViewPrev() { if (pixivState.viewPage > 0) { pixivState.viewPage--; pixivViewRender(); } }
function pixivViewNext() { if (pixivState.viewPage < pixivViewPages().length - 1) { pixivState.viewPage++; pixivViewRender(); } }

function pixivCurrentUrl() {
  const pages = pixivViewPages();
  return pages[Math.min(pixivState.viewPage, pages.length - 1)] || '';
}

function pixivDownloadCurrent() {
  const url = pixivCurrentUrl();
  if (!url) return;
  const ill = pixivState.view || {};
  const name = (String(ill.title || 'pixiv-' + ill.id).replace(/[\\/:*?"<>|]/g, '_')).slice(0, 50) + '_' + (ill.id || '') + '_p' + pixivState.viewPage;
  const btn = document.querySelector('#pixivViewModal .pixiv-view-actions .btn-primary');
  if (btn) btn.textContent = '⏳ 下载中…';
  pixivFetch('/download?url=' + encodeURIComponent(url) + '&name=' + encodeURIComponent(name)).then(function (j) {
    if (btn) btn.textContent = '💾 保存到 ai-images';
    alert('已保存：' + j.path);
  }).catch(function (e) {
    if (btn) btn.textContent = '💾 保存到 ai-images';
    alert('保存失败：' + e.message);
  });
}

function pixivUpdateViewButtons() {
  const ill = pixivState.view || {};
  const bm = document.getElementById('pixivBookmarkBtn');
  if (bm) bm.textContent = pixivState.bookmarked ? '🔖 已收藏（点击取消）' : '🔖 收藏';
  const ub = document.getElementById('pixivUgoiraBtn');
  if (ub) {
    ub.style.display = ill.type === 'ugoira' ? '' : 'none';
    ub.textContent = pixivState.ugoira ? '⏹ 停止动图' : '▶ 播放动图';
  }
}

function pixivToggleBookmark() {
  const id = pixivState.view && pixivState.view.id;
  if (!id) return;
  const action = pixivState.bookmarked ? 'unbookmark' : 'bookmark';
  pixivFetch('/' + action + '?id=' + id).then(function () {
    pixivState.bookmarked = !pixivState.bookmarked;
    pixivUpdateViewButtons();
  }).catch(function (e) { alert('操作失败：' + e.message); });
}

function pixivToggleUgoira() {
  if (pixivState.ugoira) { pixivStopUgoira(); return; }
  const id = pixivState.view && pixivState.view.id;
  if (!id) return;
  pixivFetch('/ugoira?id=' + id).then(function (j) {
    if (!j.ok || !j.frames || !j.frames.length) { alert('动图数据加载失败'); return; }
    pixivState.ugoira = { frames: j.frames, base: PIXIV_BRIDGE + j.base, timer: null, idx: 0 };
    pixivUpdateViewButtons();
    pixivUgoiraTick();
  }).catch(function (e) { alert('动图加载失败：' + e.message); });
}

function pixivStopUgoira() {
  if (pixivState.ugoira && pixivState.ugoira.timer) { clearTimeout(pixivState.ugoira.timer); }
  pixivState.ugoira = null;
  pixivUpdateViewButtons();
}

function pixivUgoiraTick() {
  const ug = pixivState.ugoira;
  if (!ug) return;
  const fr = ug.frames[ug.idx % ug.frames.length];
  document.getElementById('pixivViewImgWrap').innerHTML = '<img src="' + ug.base + encodeURIComponent(fr.n) + '" alt="">';
  ug.idx++;
  if (ug.timer) clearTimeout(ug.timer);
  ug.timer = setTimeout(pixivUgoiraTick, Math.max(30, fr.delay || 100));
}

function pixivRandomFromView() {
  const page = 1 + Math.floor(Math.random() * 5);
  pixivFetch('/ranking?mode=day&page=' + page).then(function (j) {
    const items = pixivFilterItems(j.illusts || []);
    if (!items.length) { alert('没抽到，再试一次'); return; }
    const it = items[Math.floor(Math.random() * items.length)];
    pixivOpenDetail(it.id);
  }).catch(function (e) { alert('随机失败：' + e.message); });
}

function pixivSetSceneImage() {
  const url = pixivCurrentUrl();
  if (!url) { alert('没有可用的图片'); return; }
  const adv = getCurrentAdventure();
  if (!adv) { alert('当前没有进行中的冒险'); return; }
  pixivFetch('/dataurl?url=' + encodeURIComponent(url)).then(function (j) {
    if (!j.ok || !j.dataUrl) { alert('图片读取失败'); return; }
    const msgs = adv.conversationHistory || [];
    let target = null;
    for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i] && msgs[i].role === 'assistant') { target = msgs[i]; break; } }
    if (!target) { alert('当前冒险还没有 AI 回复消息'); return; }
    target.sceneImage = j.dataUrl;
    saveState();
    if (typeof renderStory === 'function') { try { renderStory(); } catch (e) { /* ignore */ } }
    alert('已设为当前场景图（冒险：' + (adv.title || (adv.character && adv.character.name) || '未命名') + '）');
  }).catch(function (e) { alert('设置失败：' + e.message); });
}

function pixivSearchReference() {
  const kw = String(pixivState.previewKeyword || '').trim();
  if (!kw) { alert('当前预览没有可用的搜索关键词'); return; }
  const inp = document.getElementById('pixivKeyword');
  if (inp) inp.value = kw;
  pixivState.word = kw;
  pixivSwitchTab('search');
  openPixivSearch();
  pixivSearch();
}

function pixivSearchCover() {
  const titleEl = document.getElementById('novelTitle');
  let kw = titleEl ? String(titleEl.textContent || '').replace('小说生成 · ', '').trim() : '';
  if (!kw) { alert('没有可用的书名'); return; }
  const inp = document.getElementById('pixivKeyword');
  if (inp) inp.value = kw;
  pixivState.word = kw;
  pixivSwitchTab('search');
  openPixivSearch();
  pixivSearch();
}

function pixivOpenOriginal() {
  const id = pixivState.view && pixivState.view.id;
  if (id) window.open('https://www.pixiv.net/artworks/' + id, '_blank');
}

function dataUrlToBlob(dataUrl) {
  const parts = String(dataUrl).split(',');
  const mime = (parts[0].match(/data:([^;]+)/) || [])[1] || 'image/png';
  const bin = atob(parts[1]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function downloadDataUrl(dataUrl, filename) {
  const suggested = String(filename).split('/').pop();
  try {
    if (window.showSaveFilePicker) {
      window.showSaveFilePicker({ suggestedName: suggested })
        .then(function (handle) {
          return handle.createWritable().then(function (w) {
            return w.write(dataUrlToBlob(dataUrl)).then(function () { return w.close(); });
          });
        })
        .then(function () { console.log('已保存:', suggested); })
        .catch(function (e) { /* 用户取消，静默 */ });
      return;
    }
  } catch (e) { /* 降级为普通下载 */ }
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = suggested;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function saveSceneImage(messageIndex) {
  const adv = getCurrentAdventure();
  if (!adv) return;
  const msg = adv.conversationHistory[messageIndex];
  if (!msg || !msg.sceneImage) return;
  const safeTitle = String(adv.title || adv.character.name || '冒险').replace(/[\\/:*?"<>|]/g, '_');
  const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  downloadDataUrl(msg.sceneImage, 'ai-images/' + safeTitle + '-' + messageIndex + '-' + ts + '.png');
}

/* ---------- 可选小说化（永久对话档案逐卷消费，不参与 Denova 原始导入） ---------- */
const NOVEL_TURNS_PER_CHAPTER = 10;
const NOVEL_SOURCE_TARGET_CHARS = 12000;
let novelChapters = [];

function stripGameTags(text) {
  /* 去掉 [STATE]/[CHANGES]/[CHOICES]/[QUESTS]/[CHARACTERS]/[PLOT] 区块，保留 [NARRATIVE] 与普通对话 */
  return String(text || '').split(/\n(?=\[)/).filter(function (seg) {
    const m = seg.match(/^\[([A-Z_]+)\]/);
    if (!m) return true;
    return m[1] === 'NARRATIVE';
  }).join('\n').trim();
}

function collectTurns(adv, sourceMessages) {
  const hist = Array.isArray(sourceMessages) ? sourceMessages : (adv.conversationHistory || []);
  const turns = [];
  let cur = [];
  for (const m of hist) {
    const role = m.role || '';
    if (role === 'system') continue;
    if (role === 'user') {
      if (cur.length) turns.push(cur);
      cur = [m];
    } else {
      cur.push(m);
    }
  }
  if (cur.length) turns.push(cur);
  return turns;
}

function buildNovelChapters(adv, sourceMessages) {
  const turns = collectTurns(adv, sourceMessages);
  const chapters = [];
  let start = 0;
  while (start < turns.length) {
    let end = start;
    let chars = 0;
    while (end < turns.length && end - start < NOVEL_TURNS_PER_CHAPTER) {
      const turnChars = turns[end].reduce(function (sum, message) { return sum + String(message.content || '').length; }, 0);
      if (end > start && chars + turnChars > NOVEL_SOURCE_TARGET_CHARS) break;
      chars += turnChars;
      end++;
    }
    if (end === start) end++;
    const slice = turns.slice(start, end);
    const text = slice.map(function (msgs) {
      return msgs.map(function (m) {
        const c = m.content || '';
        return (m.role === 'assistant') ? stripGameTags(c) : c;
      }).filter(Boolean).join('\n');
    }).filter(Boolean).join('\n\n');
    chapters.push({
      index: chapters.length,
      turnStart: start + 1,
      turnEnd: end,
      source_message_ids: slice.reduce(function (ids, messages) { return ids.concat(messages.map(function (message) { return message.id; }).filter(Boolean)); }, []),
      text: text,
      status: 'idle',
      result: '',
    });
    start = end;
  }
  return chapters;
}

function buildNovelSystemPrompt(adv) {
  const parts = [
    '你是网络小说作家。请把下面这段文字冒险游戏记录改写成小说章节：',
    '要求：①第三人称视角，保留对话与情节；②删去游戏化元素（选项/好感度/状态/任务/剧情节点等结构化内容）；',
    '③润色环境、动作与心理描写，对话保留原味；④每章 600-1200 字中文；⑤只输出小说正文，不要任何解释。',
    '⑥**先给章名**：第一行以「章名：」开头给出简洁易懂的章名（8 字以内），要求联系上下文、有逻辑；正文从第二行开始。',
    '⑦**保留原文风格与用词**：严格沿用原作/设定中的文风、语气与措辞，包括敏感或露骨词汇——不要替换、淡化、删改或添加审查性措辞，只做叙事润色。',
  ];
  if (adv && adv.novelPlan) {
    if (adv.novelPlan.outline) parts.push('【故事大纲】\n' + String(adv.novelPlan.outline));
    if (adv.novelPlan.groups && adv.novelPlan.groups.length) {
      parts.push('【章节组细纲】\n' + adv.novelPlan.groups.map(function (g, i) {
        return '组' + (i + 1) + '《' + g.title + '》：' + g.summary;
      }).join('\n'));
    }
  }
  const styleParts = [];
  for (const b of ((adv && adv.backgroundBooks) || [])) {
    const t = String(b.title || '');
    const tags = (b.tags || []).join(' ');
    if (t.indexOf('文风') !== -1 || tags.indexOf('文风') !== -1 || tags.indexOf('风格') !== -1) {
      styleParts.push('【文风参考：' + t + '】\n' + String(b.content || '').substring(0, 1500));
    }
  }
  if (adv && adv.customPrompt) styleParts.push('【玩家自定义规则/风格】\n' + String(adv.customPrompt).substring(0, 800));
  if (styleParts.length) parts.push('\n\n--- 必须遵循的风格/规则 ---\n' + styleParts.join('\n\n'));
  return parts.join('\n');
}

function localSettingsDoc(raw) {
  return '【说明】AI 整理失败，以下为设定原文（保留原始条目格式）：\n\n' + String(raw || '');
}

function generateSettingsDoc(adv, silent) {
  const a = adv || getCurrentAdventure();
  if (!a) return Promise.resolve('');
  if (a.settingDoc) {
    if (!silent) alert('已生成过设定文档（导出时会自动带上）；如需重新生成请先清空冒险的设定文档缓存');
    return Promise.resolve(a.settingDoc);
  }
  const books = (a.backgroundBooks || []).map(function (b) {
    return '《' + (b.title || '设定书') + '》\n' + String(b.content || '').slice(0, 2000);
  });
  const cards = (a.characterCards || []).map(function (c) {
    return '【角色】' + (c.name || '') + '\n' + String(c.description || '').slice(0, 800);
  });
  const raw = [].concat(books, cards).join('\n\n---\n\n').slice(0, 6000);
  if (!raw.trim()) { alert('当前冒险没有挂载设定或角色卡'); return Promise.resolve(''); }
  if (typeof callLLM !== 'function') { alert('AI 不可用，降级为原文整理'); return Promise.resolve(localSettingsDoc(raw)); }
  const btn = document.querySelector('#novelExportModal .modal-footer .btn');
  const oldText = btn ? btn.textContent : '';
  if (btn) btn.textContent = '⏳ 生成中…';
  return callLLM([
    { role: 'system', content: '你是设定整理助手。把玩家提供的设定原文整理成一份中文设定文档：①全部用中文输出，外文条目名/术语翻译成中文（可附原文别名）；②保留关键信息、数值、规则细节，不编造；③按「世界设定 / 角色 / 规则机制 / 物品道具」分节；④保留原文风格与敏感词，不删减、不审查；⑤只输出文档正文，不要任何解释。' },
    { role: 'user', content: raw + '\n\n---\n请输出中文设定文档：' }
  ]).then(function (r) {
    if (btn) btn.textContent = oldText;
    const doc = String(r || '').trim();
    if (!doc) return localSettingsDoc(raw);
    a.settingDoc = doc;
    saveState();
    if (!silent) alert('设定文档已生成（' + doc.length + ' 字，已缓存，导出到 Denova 时自动带上；也可点「⬇ 下载设定txt」保存）');
    return doc;
  }).catch(function (e) {
    if (btn) btn.textContent = oldText;
    alert('AI 生成失败：' + e.message + '，已降级为原文整理');
    return localSettingsDoc(raw);
  });
}

function downloadSettingsDoc() {
  const a = getCurrentAdventure();
  if (!a) return;
  const doc = a.settingDoc;
  if (!doc) { alert('还没有设定文档，请先点「📜 生成设定文档」'); return; }
  const blob = new Blob([doc], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const aEl = document.createElement('a');
  aEl.href = url;
  const safeTitle = String(a.title || (a.character && a.character.name) || '冒险').replace(/[\\/:*?"<>|]/g, '_');
  aEl.download = '设定文档-' + safeTitle + '.txt';
  document.body.appendChild(aEl);
  aEl.click();
  aEl.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
}

function setExportProgress(pct, text, detail) {
  const bar = document.getElementById('denovaExportBar');
  const pctEl = document.getElementById('denovaExportPct');
  const txtEl = document.getElementById('denovaExportText');
  const detEl = document.getElementById('denovaExportDetail');
  const p = Math.min(100, Math.max(0, pct));
  if (bar) bar.style.width = p + '%';
  if (pctEl) pctEl.textContent = Math.round(p) + '%';
  if (txtEl) txtEl.textContent = text || '';
  if (detEl) detEl.textContent = detail || '';
}

/* ==================== P1：Denova 设定书 AI 整理入库 ==================== */
function aiOrganizeDenovaBook(projName) {
  const name = String(projName || '').replace(/^Denova·/, '');
  if (!name) { alert('缺少工程名'); return; }
  fetch(DENOVA_BRIDGE_BASE + '/api/denova/lore?book=' + encodeURIComponent(name)).then(function (r) { return r.json(); })
    .then(function (lj) {
      if (!lj.ok || !lj.items || !lj.items.length) { alert('该工程没有可整理的 lore'); return; }
      const items = lj.items.slice(0, 120);
      const raw = items.map(function (it) {
        const keys = Array.isArray(it.keywords) && it.keywords.length ? it.keywords.join('、') : (it.name || it.id);
        return '【' + keys + '】' + String(it.content || '').slice(0, 400);
      }).join('\n\n').slice(0, 7000);
      if (typeof callLLM !== 'function') { alert('AI 不可用'); return; }
      return callLLM([
        { role: 'system', content: '你是设定整理助手。把玩家提供的 Denova 资料库条目整理成一份中文设定书：①全部中文（外文术语译中文可附原文）；②按「世界设定 / 角色 / 规则机制 / 物品道具」分节；③保留关键细节与敏感词，不删改；④输出用「【条目名】内容」逐条格式（条目名尽量用中文），不要额外解释。' },
        { role: 'user', content: raw + '\n\n---\n请输出整理后的设定书：' }
      ]).then(function (r) {
        const doc = String(r || '').trim();
        if (!doc) { alert('AI 输出为空'); return; }
        return fetch(DENOVA_BRIDGE_BASE + '/api/denova/import-kb', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, description: '从 Denova 工程「' + name + '」AI 整理导入', content: doc })
        }).then(function (r2) { return r2.json(); }).then(function (j2) {
          if (j2.error) { alert('入库失败：' + j2.error); return; }
          alert('✅ 已 AI 整理并存入知识库：\n' + j2.path + '\n\n共 ' + j2.entries + ' 个条目。重跑生成脚本后，所有冒险都能挂载这本设定书。');
        });
      });
    }).catch(function (e) { alert('整理失败：' + e.message); });
}

let activeDenovaExportJob = '';
let denovaExportPolling = false;

function setDenovaExportReport(value) {
  const box = document.getElementById('denovaExportReport');
  if (!box) return;
  box.textContent = value || '';
  box.style.display = value ? 'block' : 'none';
}

function parseDenovaGlossaryOverride(value) {
  const glossary = { version: 1, terms: {}, do_not_translate: [] };
  String(value || '').split(/\r?\n/).forEach(function (line) {
    const text = line.trim();
    if (!text || text.startsWith('#')) return;
    if (text.startsWith('!')) { if (text.slice(1).trim()) glossary.do_not_translate.push(text.slice(1).trim()); return; }
    const match = text.match(/^(.+?)\s*=\s*(.+)$/);
    if (match) glossary.terms[match[1].trim()] = match[2].trim();
  });
  return glossary;
}

function formatDenovaGlossaryOverride(value) {
  const glossary = value || {};
  return Object.keys(glossary.terms || {}).map(function (key) { return key + ' = ' + glossary.terms[key]; })
    .concat((glossary.do_not_translate || []).map(function (term) { return '!' + term; })).join('\n');
}

async function denovaExportRequest(path, options) {
  const response = await fetch(DENOVA_BRIDGE_BASE + path, options || {});
  let data = {};
  try { data = await response.json(); } catch (error) { data = { error: '桥接服务返回了无效响应' }; }
  if (!response.ok || data.error) throw new Error(data.error || ('HTTP ' + response.status));
  return data;
}

async function sha256Text(value) {
  if (!window.crypto || !window.crypto.subtle) return '';
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = await window.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(function (item) { return item.toString(16).padStart(2, '0'); }).join('');
}

function denovaMaterialDescriptor(raw, type, title, index) {
  const sourceRef = raw && raw.source_ref ? cloneValue(raw.source_ref) : null;
  const original = raw && raw._source_raw ? cloneValue(raw._source_raw) : cloneValue(raw || {});
  const fingerprint = messageFingerprint({ role: type, content: JSON.stringify(original) }, 0);
  return {
    descriptor: {
      mount_id: String((sourceRef && sourceRef.source_id) || ('embedded-' + type + '-' + fingerprint)),
      type: type, title: String(title || (type === 'character_card' ? '角色' : '设定书')),
      source_ref: sourceRef || undefined,
      resident: !!(raw && (raw.resident || raw.load_mode === 'resident')),
      order: index,
    },
    embedded: original,
  };
}

function splitBranchRecords(branches, targetChars) {
  const result = [];
  (branches || []).forEach(function (branch) {
    const base = Object.assign({}, branch, { messages: [] });
    let current = cloneValue(base);
    let size = JSON.stringify(base).length;
    (branch.messages || []).forEach(function (message) {
      const messageSize = JSON.stringify(message).length;
      if (current.messages.length && size + messageSize > targetChars) {
        result.push(current); current = cloneValue(base); size = JSON.stringify(base).length;
      }
      current.messages.push(message); size += messageSize;
    });
    if (current.messages.length || !(branch.messages || []).length) result.push(current);
  });
  return result;
}

function encodeRecordParts(collections, extra) {
  const targetChars = 2 * 1024 * 1024;
  const maxPartChars = 6 * 1024 * 1024;
  const fragments = [];
  Object.keys(collections).forEach(function (collection) {
    (collections[collection] || []).forEach(function (record, position) {
      const serialized = JSON.stringify(record);
      const total = Math.max(1, Math.ceil(serialized.length / targetChars));
      for (let index = 0; index < total; index++) {
        fragments.push({
          collection: collection, position: position, fragment_index: index, fragment_total: total,
          data: serialized.slice(index * targetChars, (index + 1) * targetChars),
        });
      }
    });
  });
  const parts = [];
  let current = Object.assign({}, extra || {}, { record_fragments: [] });
  for (const fragment of fragments) {
    current.record_fragments.push(fragment);
    if (JSON.stringify(current).length > maxPartChars && current.record_fragments.length > 1) {
      const last = current.record_fragments.pop();
      parts.push(current);
      current = { record_fragments: [last] };
    }
  }
  if (current.record_fragments.length || !parts.length) parts.push(current);
  return parts;
}

async function uploadDenovaExportParts(jobId, kind, parts, progressStart, progressEnd) {
  for (let index = 0; index < parts.length; index++) {
    const body = JSON.stringify(parts[index]);
    const hash = await sha256Text(body);
    const headers = { 'Content-Type': 'application/json' };
    if (hash) headers['X-Part-SHA256'] = hash;
    await denovaExportRequest('/api/denova/export/jobs/' + encodeURIComponent(jobId) + '/parts/' + kind + '/' + index, {
      method: 'PUT', headers: headers, body: body,
    });
    setExportProgress(progressStart + (progressEnd - progressStart) * (index + 1) / parts.length, '上传完整' + (kind === 'conversation' ? '对话档案' : '素材原件') + '…', (index + 1) + '/' + parts.length + ' 块');
  }
}

function describeDenovaPreflight(job) {
  const preflight = job.preflight || {};
  const translator = preflight.translator || {};
  return [
    '对话：' + (preflight.main_messages || 0) + ' 条；分支：' + (preflight.branch_messages || 0) + ' 条',
    '恢复等级：' + (preflight.recovery_status || '未知') + '；完整素材：' + (preflight.resolved_materials || 0) + ' 项；待翻译字段：' + (preflight.translation_fields || 0),
    '本地翻译：' + (translator.installed ? translator.model + ' 已就绪' : (translator.online ? 'Ollama 在线，HY-MT 未安装' : 'Ollama 未连接')),
    '预计原始数据：' + Math.ceil((preflight.estimated_bytes || 0) / 1024) + ' KiB',
  ].join('\n');
}

async function installDenovaTranslator(source) {
  const bytes = source && source.bytes || 0;
  setExportProgress(31, '准备安装本地 HY-MT…', bytes ? ('官方 Q4_K_M · ' + (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GiB') : '官方 Q4_K_M');
  await denovaExportRequest('/api/denova/translator/install', { method: 'POST' });
  while (true) {
    const status = await denovaExportRequest('/api/denova/translator/status');
    const install = status.install || {};
    setExportProgress(30 + Math.min(55, (install.progress || 0) * .55), install.stage || '安装 HY-MT…', install.bytes_total ? (Math.floor((install.bytes_downloaded || 0) / 1024 / 1024) + ' / ' + Math.ceil(install.bytes_total / 1024 / 1024) + ' MiB') : '不会卸载或删除现有 Qwen/Llama');
    if (status.installed || install.status === 'complete') return status;
    if (install.status === 'failed') throw new Error(install.error || 'HY-MT 安装失败');
    await new Promise(function (resolve) { setTimeout(resolve, 1200); });
  }
}

async function resolveDenovaSources(job) {
  let current = job;
  const unresolved = ((current.preflight || {}).unresolved || []);
  if (!unresolved.length) return current;
  const resolutions = {};
  for (const item of unresolved) {
    const candidates = item.candidates || [];
    if (!candidates.length) {
      const fallback = prompt('找不到「' + item.title + '」的完整原件。\n输入 I：接受当前挂载副本（清单标记不完整）\n输入 0：明确跳过此素材\n取消：停止导出', '');
      if (fallback === null) throw new Error('未解决「' + item.title + '」的完整原件');
      if (String(fallback).trim().toLowerCase() === 'i') resolutions[item.mount_id] = '__incomplete__';
      else if (String(fallback).trim() === '0') resolutions[item.mount_id] = '__skip__';
      else throw new Error('「' + item.title + '」必须选择原件、接受不完整副本或明确跳过');
      continue;
    }
    if (candidates.length === 1) { resolutions[item.mount_id] = candidates[0]; continue; }
    const answer = prompt('「' + item.title + '」找到多个原件，请输入序号：\n' + candidates.map(function (candidate, index) { return (index + 1) + '. ' + candidate; }).join('\n') + '\nI. 接受当前挂载副本（不完整）\n0. 明确跳过', '1');
    if (String(answer).trim().toLowerCase() === 'i') { resolutions[item.mount_id] = '__incomplete__'; continue; }
    if (String(answer).trim() === '0') { resolutions[item.mount_id] = '__skip__'; continue; }
    const selected = parseInt(answer, 10) - 1;
    if (isNaN(selected) || !candidates[selected]) throw new Error('未选择「' + item.title + '」的完整原件');
    resolutions[item.mount_id] = candidates[selected];
  }
  current = await denovaExportRequest('/api/denova/export/jobs/' + encodeURIComponent(current.id) + '/preflight', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolutions: resolutions }),
  });
  return current;
}

async function pollDenovaExportJob(jobId) {
  denovaExportPolling = true;
  while (denovaExportPolling && activeDenovaExportJob === jobId) {
    const job = await denovaExportRequest('/api/denova/export/jobs/' + encodeURIComponent(jobId));
    setExportProgress(job.progress || 0, job.stage || '处理中…', (job.warnings || []).join('；'));
    if (job.status === 'complete' || job.status === 'completed_with_warnings') return job;
    if (job.status === 'failed') throw new Error((job.errors || []).join('；') || '导出任务失败');
    if (job.status === 'cancelled' || job.status === 'paused') return job;
    await new Promise(function (resolve) { setTimeout(resolve, 900); });
  }
  return null;
}

async function controlDenovaExport(action) {
  if (!activeDenovaExportJob) return;
  try {
    denovaExportPolling = action !== 'cancel';
    const job = await denovaExportRequest('/api/denova/export/jobs/' + encodeURIComponent(activeDenovaExportJob) + '/' + action, { method: 'POST' });
    setExportProgress(job.progress || 0, job.stage || '', (job.warnings || []).join('；'));
    if (action === 'resume') {
      denovaExportPolling = true;
      const final = await pollDenovaExportJob(activeDenovaExportJob);
      if (final) finishDenovaExport(final);
    }
  } catch (error) { alert('任务控制失败：' + error.message); }
}

function pauseDenovaExport() { return controlDenovaExport('pause'); }
function resumeDenovaExport() { return controlDenovaExport('resume'); }
function cancelDenovaExport() { return controlDenovaExport('cancel'); }

function finishDenovaExport(job) {
  const report = job.report || {};
  const problems = [];
  if (report.recovery_status && report.recovery_status !== 'complete') problems.push('对话恢复：' + report.recovery_status);
  if (report.translation_failures) problems.push('翻译失败：' + report.translation_failures);
  if (report.conflicts) problems.push('手工修改冲突：' + report.conflicts);
  if (report.skipped) problems.push('明确跳过素材：' + report.skipped);
  if (report.incomplete) problems.push('不完整素材副本：' + report.incomplete);
  if (report.truncated) problems.push('截断：' + report.truncated);
  const lines = [
    '工程：' + (report.path || ''),
    '对话 ' + (report.main_messages || 0) + ' 条，分支对话 ' + (report.branch_messages || 0) + ' 条，剧情实录 ' + (report.shards || 0) + ' 卷',
    '角色卡 ' + (report.character_cards || 0) + ' 张，设定书 ' + (report.lorebooks || 0) + ' 本，资料条目 ' + (report.lore_items || 0) + ' 条',
    '翻译：' + (report.translation_status || '未知') + '；截断：' + (report.truncated || 0),
  ];
  if (problems.length) lines.push('需要注意：' + problems.join('；'));
  setDenovaExportReport(lines.join('\n'));
  setExportProgress(100, problems.length ? '⚠️ 导出完成，但有需处理项目' : '✅ 全量导出验收通过', problems.length ? problems.join('；') : '原件、对话与清单均已写入');
  if (typeof postToDenova === 'function') { try { postToDenova('sync-state', { type: 'export-done', book: report.path }); } catch (error) { /* no-op */ } }
}

async function exportToDenova() {
  const adv = getCurrentAdventure();
  if (!adv) { alert('当前没有进行中的冒险'); return; }
  showModal('denovaExportModal');
  setDenovaExportReport('');
  const glossaryInput = document.getElementById('denovaGlossaryOverride');
  if (glossaryInput) glossaryInput.value = formatDenovaGlossaryOverride(adv.denovaTranslationGlossary);
  setExportProgress(2, '清点当前冒险…', '不会调用摘要模型，也不会依赖小说');
  try {
    const archive = await loadConversationArchiveBundle(adv);
    const setting = (typeof applySettingExtraction === 'function') ? applySettingExtraction(adv.setting || '') : {};
    const name = String(adv.title || (adv.character && adv.character.name) || '未命名冒险').replace(/[\\/:*?"<>|]/g, '_');
    const descriptors = [], embedded = [];
    (adv.characterCards || []).forEach(function (card, index) {
      const item = denovaMaterialDescriptor(card, 'character_card', card.name, index);
      descriptors.push(item.descriptor);
      if (item.embedded) embedded.push({ mount_id: item.descriptor.mount_id, raw: item.embedded });
    });
    (adv.backgroundBooks || []).filter(function (book) { return !book._denovaSyncId; }).forEach(function (book, index) {
      const item = denovaMaterialDescriptor(book, 'lorebook', book.title, index);
      descriptors.push(item.descriptor);
      if (item.embedded) embedded.push({ mount_id: item.descriptor.mount_id, raw: item.embedded });
    });
    const glossary = parseDenovaGlossaryOverride(glossaryInput && glossaryInput.value);
    adv.denovaTranslationGlossary = glossary;
    saveState(true);
    const request = {
      schema_version: 4,
      adventure: {
        id: adv.id, sync_id: (adv.syncMeta && adv.syncMeta.id) || adv.id, name: name,
        theme: adv.theme || '', turns: adv.stats && adv.stats.turns || 0,
        player_name: adv.character && adv.character.name || '玩家',
        setting: {
          world: String(setting.world || adv.setting || ''), identity: String(setting.identity || ''),
          goal: String(setting.goal || ''), other: String(setting.other || ''),
        },
        custom_prompt: adv.customPrompt || '',
        system_prompt_hash: await sha256Text((adv.conversationHistory && adv.conversationHistory[0] && adv.conversationHistory[0].role === 'system') ? adv.conversationHistory[0].content : ''),
      },
      materials: descriptors,
      options: { translate_to_zh: true, glossary: glossary },
    };
    const created = await denovaExportRequest('/api/denova/export/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
    activeDenovaExportJob = created.id;
    const branchParts = splitBranchRecords(archive.branches || [], 1300000);
    const conversationParts = encodeRecordParts({ messages: archive.messages || [], events: archive.events || [], branches: branchParts }, { recovery_status: archive.recovery_status || 'best_effort' });
    const materialParts = encodeRecordParts({ embedded_materials: embedded });
    await uploadDenovaExportParts(created.id, 'conversation', conversationParts, 5, 20);
    await uploadDenovaExportParts(created.id, 'materials', materialParts, 20, 28);
    setExportProgress(30, '执行预检…', '回源、恢复等级、空间与模型');
    let preflight = await denovaExportRequest('/api/denova/export/jobs/' + encodeURIComponent(created.id) + '/preflight', { method: 'POST' });
    preflight = await resolveDenovaSources(preflight);
    setDenovaExportReport(describeDenovaPreflight(preflight));
    const translator = (preflight.preflight || {}).translator || {};
    if (!translator.installed) {
      const source = translator.source || {};
      const installNow = confirm('本地 HY-MT 翻译模型尚未就绪。\n\n是否从腾讯混元官方仓库安装 Q4_K_M？' + (source.bytes ? ('\n下载约 ' + (source.bytes / 1024 / 1024 / 1024).toFixed(2) + ' GiB，完成后校验官方 SHA-256。') : '') + '\n\n不会调用、卸载或删除现有 Qwen/Llama。');
      if (installNow) {
        await installDenovaTranslator(source);
      } else {
        const proceedEnglish = confirm('不安装翻译模型。是否仍先完整导入英文原件？\n导入清单会明确标记“model_missing”，之后可续跑翻译。');
        if (!proceedEnglish) { await cancelDenovaExport(); return; }
      }
    }
    await denovaExportRequest('/api/denova/export/jobs/' + encodeURIComponent(created.id) + '/start', { method: 'POST' });
    const final = await pollDenovaExportJob(created.id);
    if (final) finishDenovaExport(final);
  } catch (error) {
    denovaExportPolling = false;
    setExportProgress(100, '❌ 导出失败', error.message);
    setDenovaExportReport('失败原因：' + error.message + '\n没有通过验收的任务不会显示为全量成功。');
  }
}

async function showNovelExportModal() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  showModal('novelExportModal');
  const info = document.getElementById('novelInfo');
  if (info) info.textContent = '正在读取永久对话档案…';
  let archive;
  try { archive = await loadConversationArchiveBundle(adv); }
  catch (error) { archive = { messages: visibleConversation(adv.conversationHistory || [], adv.id), recovery_status: 'incomplete' }; }
  novelChapters = buildNovelChapters(adv, archive.messages || []);
  renderNovelPlan(adv);
  if (Array.isArray(adv.novelChapters)) {
    const savedBySource = new Map(adv.novelChapters.filter(function (chapter) { return chapter && chapter.result; }).map(function (chapter) { return [(chapter.source_message_ids || []).join(','), chapter]; }));
    for (let i = 0; i < novelChapters.length; i++) {
      const saved = savedBySource.get((novelChapters[i].source_message_ids || []).join(',')) || adv.novelChapters[i];
      if (saved && saved.result && (!saved.source_message_ids || (saved.source_message_ids || []).join(',') === (novelChapters[i].source_message_ids || []).join(','))) {
        novelChapters[i].title = saved.title;
        novelChapters[i].result = saved.result;
        novelChapters[i].status = 'done';
      }
    }
  }
  const title = document.getElementById('novelTitle');
  if (title) title.textContent = '小说生成 · ' + (adv.title || adv.character.name || '未命名冒险');
  if (info) {
    const turns = collectTurns(adv, archive.messages || []).length;
    info.textContent = '永久档案 ' + turns + ' 回合 · 按消息边界约 ' + NOVEL_SOURCE_TARGET_CHARS + ' 字/卷 · 预计 ' + novelChapters.length + ' 章 · 恢复等级 ' + (archive.recovery_status || '未知') +
      (turns === 0 ? '（还没有对话，先聊几回合再生成）' : '');
  }
  renderNovelChapters();
}

function renderNovelChapters() {
  const box = document.getElementById('novelChapters');
  if (!box) return;
  if (!novelChapters.length) {
    box.innerHTML = '<p style="color:var(--text-muted)">暂无章节数据</p>';
    return;
  }
  box.innerHTML = novelChapters.map(function (ch, idx) {
    const statusText = ch.status === 'generating' ? '<span class="novel-status generating">生成中…</span>'
      : ch.status === 'done' ? '<span class="novel-status done">完成（' + ch.result.length + ' 字）</span>'
      : ch.status === 'error' ? '<span class="novel-status error">失败</span>'
      : '<span class="novel-status idle">未生成</span>';
    const genBtn = ch.status === 'generating'
      ? '<button class="btn btn-secondary" disabled>生成中…</button>'
      : '<button class="btn btn-secondary" onclick="generateNovelChapter(' + idx + ')">' + (ch.status === 'done' ? '重新生成' : '生成') + '</button>';
    return '<div class="novel-chapter">' +
      '<div class="novel-chapter-head"><b>第 ' + (idx + 1) + ' 章' + (ch.title ? ' · ' + escapeHtml(ch.title) : '') + '</b>（回合 ' + ch.turnStart + '-' + ch.turnEnd + '）' + statusText + '</div>' +
      '<textarea class="novel-output" id="novelOutput_' + idx + '" rows="8" readonly>' + escapeHtml(ch.result) + '</textarea>' +
      '<div class="novel-chapter-actions">' + genBtn +
      (ch.result ? '<button class="btn btn-secondary" onclick="copyNovelChapter(' + idx + ')">复制本章</button>' : '') +
      '</div></div>';
  }).join('');
}

async function generateNovelChapter(idx) {
  const adv = getCurrentAdventure();
  const ch = novelChapters[idx];
  if (!ch) return;
  if (!ch.text) { alert('本章没有可用对话内容'); return; }
  if (!state.apiConfig.apiKey || !state.apiConfig.endpoint) { showSettings(); return; }
  if (ch.status === 'generating') return;
  ch.status = 'generating';
  renderNovelChapters();
  try {
    const out = await callLLM([
      { role: 'system', content: buildNovelSystemPrompt(adv) },
      { role: 'user', content: '【第 ' + (idx + 1) + ' 章素材 · 请完整消费，不得省略】\n' + ch.text },
    ]);
    let text = (out || '').trim();
    let title = '';
    const tm = text.match(/^章名[:：]\s*(.+?)\s*$/m);
    if (tm) {
      title = tm[1].trim();
      text = text.replace(tm[0], '').trim();
    }
    ch.title = title || ('第 ' + (idx + 1) + ' 章');
    ch.result = text;
    ch.status = ch.result ? 'done' : 'error';
    if (ch.status === 'done') {
      try {
        if (!adv.novelChapters) adv.novelChapters = [];
        adv.novelChapters[idx] = { title: ch.title, result: ch.result, source_message_ids: (ch.source_message_ids || []).slice(), source_turn_start: ch.turnStart, source_turn_end: ch.turnEnd, completed_at: Date.now() };
        saveState();
      } catch (e) { /* 持久化失败不阻断 */ }
    }
  } catch (e) {
    console.error('小说生成失败:', e);
    ch.status = 'error';
  }
  renderNovelChapters();
}

/* ==================== P3 写作工程化：大纲/细纲 + 版本对比 ==================== */
function generateNovelOutline() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  if (!state.apiConfig.apiKey || !state.apiConfig.endpoint) { showSettings(); return; }
  const btn = document.getElementById('novelOutlineBtn');
  if (btn) btn.textContent = '⏳ 生成中…';
  const turns = collectTurns(adv);
  const nGroups = Math.max(2, Math.min(5, Math.ceil(turns.length / 20)));
  const user = [
    '【冒险信息】主题：' + (adv.theme || '') + ' ｜ 玩家：' + ((adv.character && adv.character.name) || '') + ' ｜ 背景：' + String(adv.setting || '').slice(0, 500),
    '【现有对话回合】' + turns.length + ' 回合（将改写为小说章节）',
    '【设定书】' + (adv.backgroundBooks || []).slice(0, 5).map(function (b) { return '《' + b.title + '》'; }).join('、'),
    '',
    '请为这部小说生成创作大纲：',
    '①主线：一段话（故事走向、核心冲突、结局方向）',
    '②章节组细纲：' + nGroups + ' 组，每组一行，格式「组名｜本组目标（2-3 句，含起承转合与结尾钩子）」',
    '全部用中文，外文人名/地名本地化；只输出大纲文本。'
  ].join('\n');
  callLLM([
    { role: 'system', content: '你是小说大纲策划。基于冒险记录生成结构清晰的大纲与章节组细纲。' },
    { role: 'user', content: user }
  ]).then(function (r) {
    if (btn) btn.textContent = '✨ 生成大纲';
    const text = String(r || '').trim();
    const outline = (text.match(/主线[：:]([\s\S]*?)(?=\n\s*组|$)/) || [])[1] || text;
    const groups = [];
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^组?\s*(\S+?)[：:](.+)$/);
      if (m && m[1] && m[2]) groups.push({ title: m[1].trim(), summary: m[2].trim() });
    }
    if (!groups.length) groups.push({ title: '主线', summary: outline.slice(0, 100) });
    adv.novelPlan = { outline: outline.slice(0, 1500), groups: groups.slice(0, 6) };
    saveState();
    renderNovelPlan(adv);
    alert('✅ 大纲已生成：' + groups.length + ' 个章节组。可在弹窗中编辑后重新生成章节。');
  }).catch(function (e) {
    if (btn) btn.textContent = '✨ 生成大纲';
    alert('生成失败：' + e.message);
  });
}

function renderNovelPlan(adv) {
  const a = adv || getCurrentAdventure();
  const box = document.getElementById('novelPlanBox');
  const outlineInput = document.getElementById('novelOutlineInput');
  if (!box && !outlineInput) return;
  const p = a.novelPlan;
  if (outlineInput) outlineInput.value = p ? (p.outline || '') : '';
  if (box) {
    if (p && p.groups && p.groups.length) {
      box.innerHTML = p.groups.map(function (g, i) {
        return '<div class="novel-group" style="margin-bottom:6px;padding:6px;border:1px solid var(--border-strong);border-radius:8px">' +
          '<b>组' + (i + 1) + '《' + escapeHtml(g.title) + '》</b><br><span style="font-size:12px;color:var(--text-muted)">' + escapeHtml(g.summary) + '</span></div>';
      }).join('');
    } else {
      box.innerHTML = '<div style="color:var(--text-muted);font-size:12px">（暂无细纲，点「✨ 生成大纲」或手写上方大纲后保存）</div>';
    }
  }
}

function saveNovelPlan() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  const outlineInput = document.getElementById('novelOutlineInput');
  if (!outlineInput) return;
  if (!adv.novelPlan) adv.novelPlan = { outline: '', groups: [] };
  adv.novelPlan.outline = outlineInput.value;
  saveState();
  alert('大纲已保存');
}

function snapshotDiff() {
  const adv = getCurrentAdventure();
  if (!adv || !adv.snapshots || adv.snapshots.length < 2) { alert('至少需要两个存档才能对比'); return; }
  const a = adv.snapshots[0], b = adv.snapshots[1];
  const lines = [];
  lines.push('对比：' + (b.label || b.id) + ' → ' + (a.label || a.id));
  const ca = a.character || {}, cb = b.character || {};
  for (const f of ['hp', 'maxHp', 'mp', 'level', 'exp', 'location', 'chapter', 'mood']) {
    if (String(ca[f] || '') !== String(cb[f] || '')) lines.push('• 角色 ' + f + '：' + (cb[f] ?? '无') + ' → ' + (ca[f] ?? '无'));
  }
  const na = (a.conversationHistory || []).length, nb = (b.conversationHistory || []).length;
  lines.push('• 对话条数：' + nb + ' → ' + na + '（+ ' + (na - nb) + '）');
  if ((a.contextSummary || '') !== (b.contextSummary || '')) lines.push('• 剧情摘要：已更新');
  if (!lines.length) lines.push('（两存档关键字段无差异）');
  alert(lines.join('\n'));
}

async function generateAllNovel() {
  if (!novelChapters.length) { alert('还没有可生成的内容'); return; }
  if (!state.apiConfig.apiKey || !state.apiConfig.endpoint) { showSettings(); return; }
  if (!confirm('将逐卷消费永久对话档案并生成全部 ' + novelChapters.length + ' 章；失败不会覆盖原始实录。确定开始？')) return;
  for (let i = 0; i < novelChapters.length; i++) {
    if (novelChapters[i].status !== 'done') await generateNovelChapter(i);
  }
}

function copyNovelChapter(idx) {
  const ch = novelChapters[idx];
  if (!ch || !ch.result) return;
  navigator.clipboard.writeText(ch.result).then(function () {
    alert('已复制第 ' + (idx + 1) + ' 章');
  }).catch(function () { /* ignore */ });
}

function downloadNovel() {
  const adv = getCurrentAdventure();
  if (!adv) return;
  const parts = novelChapters.filter(function (c) { return c.result; })
    .map(function (c) { return '第 ' + (c.index + 1) + ' 章' + (c.title ? ' · ' + c.title : '') + '\n\n' + c.result; });
  if (!parts.length) { alert('还没有生成任何章节'); return; }
  const blob = new Blob([parts.join('\n\n\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safeTitle = String(adv.title || adv.character.name || '冒险').replace(/[\\/:*?"<>|]/g, '_');
  a.download = '小说-' + safeTitle + '-' + new Date().toISOString().slice(0, 10) + '.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
}

function copyNovelAll() {
  const parts = novelChapters.filter(function (c) { return c.result; })
    .map(function (c) { return '第 ' + (c.index + 1) + ' 章' + (c.title ? ' · ' + c.title : '') + '\n\n' + c.result; });
  if (!parts.length) { alert('还没有生成任何章节'); return; }
  navigator.clipboard.writeText(parts.join('\n\n\n')).then(function () {
    alert('已复制全部章节');
  }).catch(function () { /* ignore */ });
}

/* ==================== 初始化 ==================== */
document.addEventListener('DOMContentLoaded', async function () {
  await loadState();
  initTheme();
  initRightTab();
  renderAdventureList();

  /* 主题选择 */
  document.querySelectorAll('.theme-card').forEach(card => {
    card.addEventListener('click', function() {
      document.querySelectorAll('.theme-card').forEach(c => c.classList.remove('selected'));
      this.classList.add('selected');
      state.selectedTheme = this.dataset.theme;
      state.selectedProfession = null;
      if (this.dataset.theme === '自定义') {
        const t = state.customThemes.find(x => x.name === this.dataset.customName);
        if (t) { fillCustomThemeFields(t); }
        else { document.getElementById('customThemeName').value = ''; document.getElementById('customProfessionName').value = ''; }
        showCustomThemeFields();
        return;
      }
      hideCustomThemeFields();
      renderProfessionGrid(state.selectedTheme);
    });
  });

  /* 冒险模式选择 */
  document.querySelectorAll('.mode-card').forEach(card => {
    card.addEventListener('click', function() {
      document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('selected'));
      this.classList.add('selected');
      state.selectedMode = this.dataset.mode === 'tavern' ? 'tavern' : 'adventure';
    });
  });

  /* Enter 发送 */
  const input = document.getElementById('messageInput');
  if (input) {
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  /* 快捷键：Ctrl+Z 回退一轮，数字键 1-3 选择选项（输入框聚焦时不触发） */
  document.addEventListener('keydown', function(e) {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.ctrlKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoLastTurn();
      return;
    }
    if (e.key >= '1' && e.key <= '3') {
      handleChoice(Number(e.key) - 1);
    }
  });

  /* 上传角色卡文件 */
  const cardFileInput = document.getElementById('cardFileInput');
  if (cardFileInput) {
    cardFileInput.addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (!file) return;
      handleCardFileImport(file);
      e.target.value = '';
    });
  }

  /* 导入冒险数据 */
  const importInput = document.getElementById('importFileInput');
  if (importInput) {
    importInput.addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(ev) {
        try {
          const data = JSON.parse(ev.target.result);
          if (!data || !Array.isArray(data.adventures)) throw new Error('文件格式不正确');
          if (!confirm('导入将覆盖当前全部冒险数据，确定继续？')) return;
          state.adventures = data.adventures || [];
          state.customThemes = Array.isArray(data.customThemes) ? data.customThemes : [];
          if (data.apiConfig) state.apiConfig = { ...state.apiConfig, ...data.apiConfig };
          state.currentId = state.adventures.length > 0 ? state.adventures[0].id : null;
          saveState();
          renderAll();
          renderAdventureList();
          if (embeddedMigrationImportPending) {
            embeddedMigrationImportPending = false;
            markEmbeddedMigrationNoticeHandled();
          }
        } catch (err) {
          embeddedMigrationImportPending = false;
          alert('导入失败：' + err.message);
        }
      };
      reader.readAsText(file, 'UTF-8');
      e.target.value = '';
    });
  }

  const migrationNoticeShown = maybeShowEmbeddedMigrationNotice();

  /* 如果没有 API 配置，自动弹出设置；迁移提示优先，避免两个弹窗叠加。 */
  if (!state.apiConfig.apiKey && !migrationNoticeShown) {
    setTimeout(showSettings, 300);
  }

  /* 如果有当前冒险，加载它 */
  if (state.currentId) {
    loadAdventure(state.currentId);
  } else {
    document.getElementById('storyArea').innerHTML = emptyStateHtml();
  }

  /* 应用侧边栏折叠状态 */
  applySidebarState();

  /* 弹窗不再因点击外部遮罩而关闭，避免误关导致输入丢失。仅可通过关闭/取消/保存按钮关闭。 */
});
