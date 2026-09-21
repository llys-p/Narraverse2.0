const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const KB = process.env.NARRAVERSE_KNOWLEDGE_BASE || path.join(PROJECT_ROOT, 'knowledge-base');
const AVATARS = process.env.NARRAVERSE_AVATARS || path.join(PROJECT_ROOT, 'app', 'avatars');
const VAULT = process.env.NARRAVERSE_OBSIDIAN_VAULT || path.join(PROJECT_ROOT, 'obsidian-vault');

// ========== 安全重生成：只重建 02-世界观设定 / 03-角色卡 / 08-索引 / 附件（角色头像、原始文件）与 .私有库
// 不动：01-收件箱、04-小说创作、05-酒馆冒险、06-素材与词库、07-模板、AGENTS.md、使用说明、欢迎页等
// NSFW 内容按既有约定写入 .私有库（Obsidian 不索引点开头目录），公开区仅保留 SFW。

function clean(s) { return String(s == null ? '' : s); }
function strip(s) { return clean(s).replace(/<[^>]+>/g, ''); }
function yamlStr(s) { return '"' + clean(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n') + '"'; }
function yamlTags(tags) {
  if (!Array.isArray(tags) || !tags.length) return '  - 未分类';
  const seen = new Set(); const out = [];
  for (const t of tags) { const s = clean(t).trim(); if (s && !seen.has(s)) { seen.add(s); out.push('  - ' + s); } }
  return out.join('\n') || '  - 未分类';
}

const meta = JSON.parse(fs.readFileSync(path.join(KB, '设定集元数据.json'), 'utf8'));
const metaBooks = meta.books || {};
const metaCards = meta.cards || {};

// 清理并重建生成区（含 .私有库）
const genDirs = [
  '02-世界观设定', '03-角色卡', '08-索引',
  '附件/角色头像', '附件/原始文件/世界观设定', '附件/原始文件/角色卡',
  '.私有库/世界观设定', '.私有库/角色卡',
  '.私有库/附件/角色头像', '.私有库/附件/原始文件/世界观设定', '.私有库/附件/原始文件/角色卡'
];
for (const d of genDirs) {
  fs.rmSync(path.join(VAULT, d), { recursive: true, force: true });
  fs.mkdirSync(path.join(VAULT, d), { recursive: true });
}

const bookNotes = [], cardNotes = [], nsfwBooks = [], nsfwCards = [];

// ---------- 世界观设定 ----------
const wsDir = path.join(KB, '世界观设定');
for (const fn of fs.readdirSync(wsDir).filter(f => f.endsWith('.json')).sort()) {
  const stem = fn.slice(0, -5);
  let obj;
  try { obj = JSON.parse(fs.readFileSync(path.join(wsDir, fn), 'utf8')); }
  catch (e) { console.log('跳过(坏JSON):', fn); continue; }
  const m = metaBooks[stem] || {};
  const nsfw = !!m.nsfw;
  const entries = (obj.entries && typeof obj.entries === 'object') ? obj.entries : {};
  const entryList = Object.entries(entries)
    .map(([k, v]) => { if (!v || typeof v !== 'object') return null; const key = Array.isArray(v.key) ? v.key.join('、') : (v.key || k); return { key: clean(key), content: strip(v.content || '') }; })
    .filter(Boolean);
  const dir = nsfw ? '.私有库/世界观设定' : '02-世界观设定';
  const rawDir = nsfw ? '.私有库/附件/原始文件/世界观设定' : '附件/原始文件/世界观设定';
  const L = [];
  L.push('---', 'title: ' + yamlStr(stem), 'type: 世界观设定', 'category: ' + yamlStr(m.category || '其他'), 'nsfw: ' + (nsfw ? 'true' : 'false'), 'lang: ' + yamlStr(m.lang || ''), '条目数: ' + entryList.length, '来源文件: ' + yamlStr(rawDir + '/' + fn), 'tags:');
  L.push(yamlTags(m.tags), '---', '', '# ' + stem, '');
  if (obj.name && obj.name !== stem) L.push('> 内部名（英文/原名）：`' + clean(obj.name) + '`');
  if (m.summary) L.push('', '## 简介', clean(m.summary));
  if (obj.description) L.push('', '## 原始描述', clean(obj.description));
  L.push('', '## 条目清单（' + entryList.length + ' 条）', '');
  if (!entryList.length) L.push('（无条目）');
  for (const e of entryList) {
    L.push('### ' + e.key);
    const c = strip(e.content);
    L.push(c.replace(/\r?\n/g, '\n').slice(0, 300) + (e.content.length > 300 ? '\n\n> …（完整原文见 `' + rawDir + '/' + fn + '`）' : ''), '');
  }
  fs.writeFileSync(path.join(VAULT, dir, stem + '.md'), L.join('\n'), 'utf8');
  fs.copyFileSync(path.join(wsDir, fn), path.join(VAULT, rawDir, fn));
  (nsfw ? nsfwBooks : bookNotes).push({ title: stem, category: m.category || '其他', nsfw, count: entryList.length });
}
console.log('世界观设定笔记(公开/私有):', bookNotes.length + '/' + nsfwBooks.length);

// ---------- 角色卡 ----------
const ccDir = path.join(KB, '角色卡');
for (const fn of fs.readdirSync(ccDir).filter(f => f.endsWith('.json')).sort()) {
  const stem = fn.slice(0, -5);
  let obj;
  try { obj = JSON.parse(fs.readFileSync(path.join(ccDir, fn), 'utf8')); }
  catch (e) { console.log('跳过(坏JSON):', fn); continue; }
  const data = (obj && typeof obj === 'object' && obj.data && obj.data.name) ? obj.data : obj;
  const name = clean(data.name || stem).trim();
  const m = metaCards[stem] || metaCards[name] || {};
  const tags = Array.isArray(data.tags) ? data.tags.map(clean) : [];
  const nsfw = !!m.nsfw || /nsfw|smut|hentai/i.test(tags.join(' '));
  const category = m.category || (nsfw ? 'NSFW角色' : '一般角色');
  const dir = nsfw ? '.私有库/角色卡' : '03-角色卡';
  const rawDir = nsfw ? '.私有库/附件/原始文件/角色卡' : '附件/原始文件/角色卡';
  const avatarDir = nsfw ? '.私有库/附件/角色头像' : '附件/角色头像';
  let avatarRel = null;
  for (const ext of ['.jpg', '.png']) {
    const cand = path.join(AVATARS, stem + ext);
    if (fs.existsSync(cand)) { const dest = path.join(VAULT, avatarDir, stem + ext); fs.copyFileSync(cand, dest); avatarRel = avatarDir + '/' + stem + ext; break; }
  }
  if (!avatarRel) { const png = path.join(ccDir, stem + '.png'); if (fs.existsSync(png)) { fs.copyFileSync(png, path.join(VAULT, avatarDir, stem + '.png')); avatarRel = avatarDir + '/' + stem + '.png'; } }
  const L = [];
  L.push('---', 'title: ' + yamlStr(stem), 'type: 角色卡', 'category: ' + yamlStr(category), 'nsfw: ' + (nsfw ? 'true' : 'false'), '原名: ' + yamlStr(name), '来源文件: ' + yamlStr(rawDir + '/' + fn), 'tags:');
  L.push(yamlTags([...(tags || []), ...(m.tags || [])]), '---', '', '# ' + stem, '');
  if (avatarRel) L.push('![' + stem + '](' + avatarRel + ')', '');
  if (m.summary) L.push('## 简介', clean(m.summary), '');
  L.push('> 原名：`' + name + '` ｜ 分类：' + category + (nsfw ? ' ｜ ⚠️NSFW' : ''));
  if (data.description) L.push('', '## 人设（description）', strip(data.description));
  if (data.personality) L.push('', '## 性格（personality）', strip(data.personality));
  if (data.scenario) L.push('', '## 场景（scenario）', strip(data.scenario));
  if (data.first_mes) { L.push('', '## 开场白（first_mes）', '```', strip(data.first_mes).slice(0, 600)); if (data.first_mes.length > 600) L.push('…（完整见原始文件）'); L.push('```'); }
  if (tags.length) L.push('', '## 标签', tags.join('、'));
  L.push('');
  fs.writeFileSync(path.join(VAULT, dir, stem + '.md'), L.join('\n'), 'utf8');
  fs.copyFileSync(path.join(ccDir, fn), path.join(VAULT, rawDir, fn));
  (nsfw ? nsfwCards : cardNotes).push({ title: stem, category, nsfw, orig: name });
}
console.log('角色卡笔记(公开/私有):', cardNotes.length + '/' + nsfwCards.length);

// ---------- 索引 ----------
const groups = {};
for (const b of bookNotes) (groups[b.category] = groups[b.category] || []).push(b);
let idx = ['---', 'type: 索引', '---', '', '# 世界观设定索引', '', '> 共 ' + bookNotes.length + ' 本设定集在库（另 ' + nsfwBooks.length + ' 本 NSFW 设定已移入 `.私有库/世界观设定`，Obsidian 内不可见），来源：`D:\\Narraverse2.0\\knowledge-base\\世界观设定`', ''];
for (const cat of Object.keys(groups).sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
  idx.push('## ' + cat + '（' + groups[cat].length + '）', '');
  for (const b of groups[cat].sort((x, y) => x.title.localeCompare(y.title, 'zh-CN'))) idx.push('- [[' + b.title + ']]' + (b.nsfw ? ' ⚠️' : '') + ' — ' + b.count + ' 条');
  idx.push('');
}
if (nsfwBooks.length) {
  idx.push('## NSFW 设定（已移入 `.私有库/世界观设定`）', '', '> ⚠️ Obsidian 不索引 `.` 开头目录，需在资源管理器中查看：`E:\\AI工具\\Obsidian素材库\\.私有库\\世界观设定`', '', '> 名单：' + nsfwBooks.map(b => b.title).join('、'), '');
}
fs.writeFileSync(path.join(VAULT, '08-索引/世界观索引.md'), idx.join('\n'), 'utf8');
const cardGroups = {};
for (const c of cardNotes) (cardGroups[c.category] = cardGroups[c.category] || []).push(c);
let cidx = ['---', 'type: 索引', '---', '', '# 角色卡索引', '', '> 共 ' + cardNotes.length + ' 张角色卡在库（另 ' + nsfwCards.length + ' 张 NSFW 卡已移入 `.私有库/角色卡`，Obsidian 内不可见），来源：`D:\\Narraverse2.0\\knowledge-base\\角色卡`', ''];
for (const cat of Object.keys(cardGroups).sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
  cidx.push('## ' + cat + '（' + cardGroups[cat].length + '）', '');
  for (const c of cardGroups[cat].sort((x, y) => x.title.localeCompare(y.title, 'zh-CN'))) cidx.push('- [[' + c.title + ']]' + (c.nsfw ? ' ⚠️' : '') + ' — 原名 `' + c.orig + '`');
  cidx.push('');
}
if (nsfwCards.length) {
  cidx.push('## NSFW 角色（已移入 `.私有库/角色卡`）', '', '> ⚠️ Obsidian 不索引 `.` 开头目录，需在资源管理器中查看：`E:\\AI工具\\Obsidian素材库\\.私有库\\角色卡`', '', '> 名单：' + nsfwCards.map(c => c.title).join('、'), '');
}
fs.writeFileSync(path.join(VAULT, '08-索引/角色索引.md'), cidx.join('\n'), 'utf8');
console.log('索引已更新，公开', bookNotes.length + cardNotes.length, '条 + 私有', nsfwBooks.length + nsfwCards.length, '条');
