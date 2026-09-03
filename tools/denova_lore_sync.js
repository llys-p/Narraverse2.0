const fs = require('fs');
const path = require('path');

// ============ Denova × 平台 素材互通脚本（Step 0）============
// 用法：
//   node denova_lore_sync.js export <设定书文件名(不带.json)>   —— 平台设定书 → Denova 工程 lore
//   node denova_lore_sync.js import <Denova工程名> [输出文件名]  —— Denova lore → 平台设定书格式（默认 世界观设定/denova-<工程名>.json）
//   node denova_lore_sync.js list                               —— 列出 Denova 已注册工程
// 项目内路径默认相对本脚本定位，也可用环境变量覆盖。

const PROJECT_ROOT = path.resolve(__dirname, '..');
const KB_WORLD = process.env.NARRAVERSE_KNOWLEDGE_BASE
  ? path.join(process.env.NARRAVERSE_KNOWLEDGE_BASE, '世界观设定')
  : path.join(PROJECT_ROOT, 'knowledge-base', '世界观设定');
const DENOVA_DIR = process.env.NARRAVERSE_DENOVA_DATA_DIR
  || path.join(PROJECT_ROOT, 'denova-src', '.denova');
const PROJECTS = path.join(DENOVA_DIR, 'projects');
const BOOKS_JSON = path.join(DENOVA_DIR, 'books.json');

function nowIso() { return new Date().toISOString(); }
function clean(s) { return String(s == null ? '' : s); }
function oneLine(s, n) { return clean(s).replace(/\s+/g, ' ').trim().slice(0, n || 120); }
function inferType(key, content) {
  const text = clean(key) + ' ' + clean(content).slice(0, 200);
  if (/角色|人物|character|npc/i.test(text)) return 'character';
  if (/地点|位置|location|城市|村庄|村|镇|大陆/i.test(text)) return 'location';
  if (/势力|组织|faction|家族|氏族|社团/i.test(text)) return 'faction';
  if (/规则|机制|系统|检定|rule|system/i.test(text)) return 'rule';
  if (/物品|道具|item|武器|装备|法器/i.test(text)) return 'item';
  return 'world';
}

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return null; }
}
function saveJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function loadBooks() {
  return loadJson(BOOKS_JSON) || { current: '', books: [], sort_mode: 'recent' };
}
function saveBooks(b) { saveJson(BOOKS_JSON, b); }

function registerProject(name) {
  const b = loadBooks();
  const projPath = path.join(PROJECTS, name);
  const found = b.books.find(x => x.name === name);
  if (found) {
    found.path = projPath;
    found.last_opened_at = nowIso();
  } else {
    b.books.push({ name, path: projPath, author: '', last_opened_at: nowIso() });
  }
  saveBooks(b);
  return b;
}

// ---------- export：平台设定书 → Denova 工程 lore ----------
function exportBook(stem) {
  const src = path.join(KB_WORLD, stem + '.json');
  if (!fs.existsSync(src)) { console.error('找不到设定书:', src); process.exit(1); }
  const book = loadJson(src);
  if (!book || !book.entries) { console.error('设定书格式异常:', stem); process.exit(1); }

  const proj = path.join(PROJECTS, stem);
  const loreDir = path.join(proj, '.denova', 'lore');
  fs.mkdirSync(loreDir, { recursive: true });
  fs.mkdirSync(path.join(proj, 'interactive'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'setting'), { recursive: true });

  const usedIds = new Set();
  const items = [];
  for (const [k, v] of Object.entries(book.entries)) {
    if (!v || typeof v !== 'object') continue;
    const keys = Array.isArray(v.key) ? v.key.map(clean).filter(Boolean) : [clean(v.key || k)];
    if (!keys.length) keys.push(clean(k));
    let id = keys.join('、').slice(0, 80);
    let n = 2;
    while (usedIds.has(id)) { id = keys.join('、').slice(0, 76) + '_' + n; n++; }
    usedIds.add(id);
    items.push({
      id,
      enabled: true,
      type: inferType(keys.join(' '), v.content),
      type_source: 'import',
      name: keys.join('、').slice(0, 60),
      importance: 'major',
      tags: Array.isArray(v.keysecondary) ? v.keysecondary.map(clean).filter(Boolean).slice(0, 10) : [],
      brief_description: oneLine(v.comment || v.content || '', 100),
      keywords: keys,
      load_mode: 'resident',
      content: clean(v.content || ''),
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  }
  saveJson(path.join(loreDir, 'items.json'), { version: 2, items });

  // CREATOR.md 追加来源与描述
  const creatorMd = path.join(proj, 'CREATOR.md');
  let md = '';
  if (fs.existsSync(creatorMd)) md = fs.readFileSync(creatorMd, 'utf8') + '\n';
  const desc = oneLine(book.description || '', 200);
  md += '\n---\n> 来源：文字冒险平台 设定书「' + stem + '」自动导出（' + nowIso().slice(0, 10) + '）\n';
  if (desc) md += '> 简介：' + desc + '\n';
  fs.writeFileSync(creatorMd, md, 'utf8');

  registerProject(stem);
  console.log('已导出「' + stem + '」→ ' + proj + '（' + items.length + ' 条 lore）');
  return items.length;
}

// ---------- import：Denova lore → 平台设定书 ----------
function importBook(projName, outName) {
  const itemsJson = path.join(PROJECTS, projName, '.denova', 'lore', 'items.json');
  if (!fs.existsSync(itemsJson)) { console.error('工程无 lore:', itemsJson); process.exit(1); }
  const lore = loadJson(itemsJson);
  const entries = {};
  let uid = 1;
  for (const it of (lore.items || [])) {
    const keys = Array.isArray(it.keywords) && it.keywords.length ? it.keywords.map(clean).filter(Boolean) : [clean(it.name || it.id)];
    entries[keys.join('、')] = {
      uid: uid++,
      key: keys,
      keysecondary: Array.isArray(it.tags) ? it.tags : [],
      comment: clean(it.brief_description),
      content: clean(it.content),
    };
  }
  const out = {
    name: '',
    description: '从 Denova 工程「' + projName + '」导入（' + nowIso().slice(0, 10) + '）',
    is_creation: false,
    scan_depth: 2,
    token_budget: 0,
    recursive_scanning: false,
    extensions: {},
    entries,
  };
  const outFile = path.join(KB_WORLD, (outName || ('denova-' + projName)) + '.json');
  saveJson(outFile, out);
  console.log('已导入「' + projName + '」→ ' + outFile + '（' + Object.keys(entries).length + ' 条）');
}

// ---------- list ----------
function listProjects() {
  const b = loadBooks();
  console.log('Denova 已注册工程:');
  for (const x of (b.books || [])) console.log(' -', x.name, '→', x.path, x.path === b.current ? '（当前）' : '');
}

const cmd = process.argv[2];
if (cmd === 'export') {
  if (!process.argv[3]) { console.error('用法: node denova_lore_sync.js export <设定书名>'); process.exit(1); }
  exportBook(process.argv[3]);
} else if (cmd === 'import') {
  if (!process.argv[3]) { console.error('用法: node denova_lore_sync.js import <工程名> [输出名]'); process.exit(1); }
  importBook(process.argv[3], process.argv[4]);
} else if (cmd === 'list') {
  listProjects();
} else {
  console.log('用法:\n  node denova_lore_sync.js export <设定书名>\n  node denova_lore_sync.js import <工程名> [输出名]\n  node denova_lore_sync.js list');
}
