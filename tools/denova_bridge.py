# -*- coding: utf-8 -*-
"""
Denova 导出桥接服务（v3，2026-08-12 按「Denova 文件导入模板」重构）
- POST /api/denova/export
  body: {name, theme, world, identity, goal, other, customPrompt, summary, turns,
         books:[{title,content}], cards:[{name,description,personality,scenario,first_mes,tags}]}
- v3 变更：移除 NSFW 词条过滤（用户要求词条全量导出）；按模板生成
  CREATOR.md / ideas.md / setting/outline.md / setting/progress.md / setting/character-states.md；
  lore 条目 importance/load_mode/brief_description 按模板规则；去重保留，上限放宽 200/500
"""
import json
import hashlib
import base64
import os
import re
import shutil
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from denova_full_export import ExportJobManager, PART_LIMIT
except ImportError:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from denova_full_export import ExportJobManager, PART_LIMIT

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DENOVA_DIR = os.environ.get("NARRAVERSE_DENOVA_DATA_DIR", os.path.join(PROJECT_ROOT, "denova-src", ".denova"))
PROJECTS = os.path.join(DENOVA_DIR, "projects")
BOOKS_JSON = os.path.join(DENOVA_DIR, "books.json")
SYNC_INDEX = os.path.join(DENOVA_DIR, "narraverse-sync-index.json")
KNOWLEDGE_BASE = os.environ.get("NARRAVERSE_KNOWLEDGE_BASE", os.path.join(PROJECT_ROOT, "knowledge-base"))
PORT = 8097

MAX_PER_BOOK = 200
MAX_TOTAL = 500
TYPE_ORDER = {"character": 0, "faction": 1, "location": 2, "rule": 3, "item": 4, "world": 5, "other": 6}
_FULL_EXPORT_MANAGER = None
_FULL_EXPORT_SIGNATURE = None
MATERIAL_EXTENSIONS = {".json", ".png"}
MATERIAL_MAX_BYTES = 32 * 1024 * 1024


def full_export_manager():
    global _FULL_EXPORT_MANAGER, _FULL_EXPORT_SIGNATURE
    signature = (DENOVA_DIR, PROJECTS, BOOKS_JSON, KNOWLEDGE_BASE)
    if _FULL_EXPORT_MANAGER is None or _FULL_EXPORT_SIGNATURE != signature:
        _FULL_EXPORT_MANAGER = ExportJobManager(*signature)
        _FULL_EXPORT_SIGNATURE = signature
    return _FULL_EXPORT_MANAGER


def knowledge_materials():
    """Return safe, stable references to importable Narraverse materials."""
    root = os.path.realpath(KNOWLEDGE_BASE)
    if not os.path.isdir(root):
        return []
    items = []
    scan_roots = [(os.path.join(root, "角色卡"), "character_card"), (os.path.join(root, "世界观设定"), "lorebook")]
    for scan_root, declared_kind in scan_roots:
        if not os.path.isdir(scan_root):
            continue
        for current, dirs, files in os.walk(scan_root):
            dirs[:] = [name for name in dirs if not name.startswith(".")]
            for filename in sorted(files):
                extension = os.path.splitext(filename)[1].lower()
                if extension not in MATERIAL_EXTENSIONS:
                    continue
                path = os.path.realpath(os.path.join(current, filename))
                try:
                    if os.path.commonpath((root, path)) != root or not os.path.isfile(path):
                        continue
                    size = os.path.getsize(path)
                    if size <= 0 or size > MATERIAL_MAX_BYTES:
                        continue
                    relative = os.path.relpath(path, root).replace("\\", "/")
                    with open(path, "rb") as handle:
                        digest = hashlib.sha256(handle.read()).hexdigest()
                    source_id = hashlib.sha256(relative.encode("utf-8")).hexdigest()[:24]
                    items.append({
                        "source_id": source_id,
                        "name": filename,
                        "relative_path": relative,
                        "kind": "character_card" if extension == ".png" else declared_kind,
                        "bytes": size,
                        "sha256": digest,
                        "source_ref": {"version": 1, "source_id": source_id, "relative_path": relative, "sha256": digest},
                    })
                except (OSError, ValueError):
                    continue
    return sorted(items, key=lambda item: (item["kind"], item["relative_path"].lower()))


def read_knowledge_material(source_id):
    matches = [item for item in knowledge_materials() if item["source_id"] == source_id]
    if len(matches) != 1:
        raise FileNotFoundError("叙界素材不存在或来源标识不唯一")
    item = matches[0]
    root = os.path.realpath(KNOWLEDGE_BASE)
    path = os.path.realpath(os.path.join(root, item["relative_path"].replace("/", os.sep)))
    if os.path.commonpath((root, path)) != root:
        raise ValueError("素材路径越界")
    with open(path, "rb") as handle:
        data = handle.read()
    if hashlib.sha256(data).hexdigest() != item["sha256"]:
        raise ValueError("素材读取期间已发生变化，请刷新后重试")
    return {**item, "content_base64": base64.b64encode(data).decode("ascii")}

def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()) + "+08:00"

def today():
    return time.strftime("%Y-%m-%d")

def safe_name(name):
    s = re.sub(r'[\\/:*?"<>|\r\n]', "_", str(name or "未命名冒险")).strip()
    return s[:60] or "未命名冒险"

def infer_type(text):
    t = (text or "")[:300]
    if re.search(r"角色|人物|character|npc", t, re.I): return "character"
    if re.search(r"地点|位置|location|城市|村庄|村|镇|大陆", t, re.I): return "location"
    if re.search(r"势力|组织|faction|家族|氏族|社团", t, re.I): return "faction"
    if re.search(r"规则|机制|系统|检定|rule|system", t, re.I): return "rule"
    if re.search(r"物品|道具|item|武器|装备|法器", t, re.I): return "item"
    return "world"

def parse_book_content(content):
    entries = []
    for m in re.finditer(r"【([^】]+)】([\s\S]*?)(?=【|$)", content or ""):
        keys = [s.strip() for s in re.split(r"[、,，]", m.group(1)) if s.strip()]
        c = m.group(2).strip()
        if c and keys:
            entries.append({"keys": keys, "content": c})
    return entries

def clean_card_text(s):
    s = str(s or "")
    s = re.sub(r"\{\{(char|user|random|time|.+?)}}", "", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()

def brief_of(content, itype, name):
    """模板要求 brief_description 3-5 句概括：类型 名称。取内容前 3 句"""
    sentences = re.split(r"(?<=[。！？!?])\s*", re.sub(r"\s+", " ", content or "").strip())
    head = [s for s in sentences if s][:3]
    return "%s %s。%s" % (itype, name, " ".join(head)[:150])

def summary_section(summary, key, fallback=""):
    m = re.search(r"【%s】(.*?)(?=【|$)" % key, summary or "")
    if m:
        return m.group(1).strip()
    return fallback

def load_json(p, default):
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default

def save_json(p, obj):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)

def write_text(p, text):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)

def sync_id(value):
    value = str(value or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,100}", value):
        raise ValueError("无效 sync id")
    return value

def sync_project(sync_key, requested_name):
    index = load_json(SYNC_INDEX, {"version": 1, "items": {}})
    items = index.setdefault("items", {})
    entry = items.get(sync_key)
    if entry:
        return index, entry
    base = safe_name(requested_name or "Narraverse冒险")
    project_name = base
    project_path = os.path.join(PROJECTS, project_name)
    if os.path.exists(project_path):
        project_name = safe_name(base + "-" + sync_key[:8])
        project_path = os.path.join(PROJECTS, project_name)
    entry = {"projectName": project_name, "path": project_path, "createdAt": now_iso()}
    items[sync_key] = entry
    save_json(SYNC_INDEX, index)
    return index, entry

def managed_files(project_path):
    paths = [
        os.path.join(project_path, "CREATOR.md"),
        os.path.join(project_path, "setting", "world.md"),
        os.path.join(project_path, "setting", "outline.md"),
        os.path.join(project_path, "setting", "character-states.md"),
        os.path.join(project_path, ".denova", "lore", "items.json"),
    ]
    chapter_root = os.path.join(project_path, "chapters")
    if os.path.isdir(chapter_root):
        for root, _, files in os.walk(chapter_root):
            paths.extend(os.path.join(root, name) for name in sorted(files) if name.endswith(".md"))
    return paths

def managed_revision(project_path):
    digest = hashlib.sha256()
    latest = 0.0
    for path in sorted(managed_files(project_path)):
        if not os.path.isfile(path):
            continue
        stat = os.stat(path)
        latest = max(latest, stat.st_mtime)
        digest.update(os.path.relpath(path, project_path).replace("\\", "/").encode("utf-8"))
        with open(path, "rb") as handle:
            digest.update(handle.read())
    return digest.hexdigest(), latest

def backup_managed_files(project_path):
    existing = [path for path in managed_files(project_path) if os.path.isfile(path)]
    if not existing:
        return
    backup_root = os.path.join(project_path, ".narraverse", "backups", time.strftime("%Y%m%d-%H%M%S"))
    for path in existing:
        target = os.path.join(backup_root, os.path.relpath(path, project_path))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(path, target)

def setting_document(payload):
    return "\n".join([
        "# 冒险设定", "",
        "## 世界背景", str(payload.get("world") or ""), "",
        "## 玩家身份", str(payload.get("identity") or ""), "",
        "## 初始目标", str(payload.get("goal") or ""), "",
        "## 其他说明", str(payload.get("other") or ""), "",
    ])

def read_setting_document(path, fallback):
    if not os.path.isfile(path):
        return fallback
    text = open(path, "r", encoding="utf-8").read()
    result = dict(fallback)
    for heading, key in (("世界背景", "world"), ("玩家身份", "identity"), ("初始目标", "goal"), ("其他说明", "other")):
        match = re.search(r"^##\s*%s\s*\n([\s\S]*?)(?=^##\s|\Z)" % re.escape(heading), text, re.M)
        if match:
            result[key] = match.group(1).strip()
    return result

def read_synced_chapters(project_path):
    chapter_root = os.path.join(project_path, "chapters")
    chapters = []
    if not os.path.isdir(chapter_root):
        return chapters
    for root, _, files in os.walk(chapter_root):
        for name in sorted(files):
            if not name.endswith(".md"):
                continue
            title = re.sub(r"^ch\d+-", "", name[:-3])
            chapters.append({"title": title, "content": open(os.path.join(root, name), "r", encoding="utf-8").read()})
    return chapters

def read_synced_lore(project_path, project_name, sync_key):
    lore = load_json(os.path.join(project_path, ".denova", "lore", "items.json"), {"items": []})
    items = lore.get("items") or []
    if not items:
        return None
    content = "\n".join("【%s】%s" % (
        "、".join(item.get("keywords") or [item.get("name") or item.get("id") or "资料"]),
        str(item.get("content") or "")
    ) for item in items[:200])
    return {
        "title": "Denova·" + project_name,
        "content": content,
        "summary": "同步自 Denova 工程，共 %d 条资料" % len(items),
        "tags": ["Denova", "同步"],
        "_denovaSyncId": sync_key,
    }

def do_sync_push(payload):
    sync_key = sync_id(payload.get("syncId"))
    index, entry = sync_project(sync_key, payload.get("name"))
    project_path = entry["path"]
    if os.path.isdir(project_path):
        backup_managed_files(project_path)
    export_payload = dict(payload)
    export_payload["name"] = entry["projectName"]
    result = do_export(export_payload)
    write_text(os.path.join(project_path, "setting", "world.md"), setting_document(payload))
    revision, latest = managed_revision(project_path)
    sync_record = {
        "version": 1,
        "syncId": sync_key,
        "projectName": entry["projectName"],
        "shared": payload,
        "revision": revision,
        "pushedAt": now_iso(),
    }
    save_json(os.path.join(project_path, ".narraverse", "sync.json"), sync_record)
    entry.update({"updatedAt": now_iso(), "revision": revision})
    save_json(SYNC_INDEX, index)
    return {"ok": True, "syncId": sync_key, "projectName": entry["projectName"], "path": project_path.replace("\\", "/"), "revision": revision, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(latest or time.time())) + "+08:00", "items": result.get("items", 0), "chapters": result.get("chapters", 0)}

def do_sync_pull(sync_value):
    sync_key = sync_id(sync_value)
    index = load_json(SYNC_INDEX, {"items": {}})
    entry = (index.get("items") or {}).get(sync_key)
    if not entry or not os.path.isdir(entry.get("path") or ""):
        raise FileNotFoundError("同步工程不存在")
    project_path = entry["path"]
    record = load_json(os.path.join(project_path, ".narraverse", "sync.json"), {"shared": {}})
    shared = dict(record.get("shared") or {})
    setting = read_setting_document(os.path.join(project_path, "setting", "world.md"), shared)
    shared.update(setting)
    shared["chapters"] = read_synced_chapters(project_path)
    shared["loreBook"] = read_synced_lore(project_path, entry["projectName"], sync_key)
    revision, latest = managed_revision(project_path)
    return {"ok": True, "syncId": sync_key, "projectName": entry["projectName"], "revision": revision, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(latest or time.time())) + "+08:00", "shared": shared}

def register_project(name, proj_path):
    b = load_json(BOOKS_JSON, {"current": "", "books": [], "sort_mode": "recent"})
    found = next((x for x in b.get("books", []) if x.get("name") == name), None)
    if found:
        found["path"] = proj_path
        found["last_opened_at"] = now_iso()
    else:
        b.setdefault("books", []).append({"name": name, "path": proj_path, "author": "", "last_opened_at": now_iso()})
    save_json(BOOKS_JSON, b)

def do_export(payload):
    name = safe_name(payload.get("name"))
    theme = str(payload.get("theme") or "").strip()
    world = str(payload.get("world") or "").strip()
    identity = str(payload.get("identity") or "").strip()
    goal = str(payload.get("goal") or "").strip()
    other = str(payload.get("other") or "").strip()
    custom = str(payload.get("customPrompt") or "").strip()
    summary = str(payload.get("summary") or "").strip()
    turns = str(payload.get("turns") or "?")

    proj = os.path.join(PROJECTS, name)
    lore_dir = os.path.join(proj, ".denova", "lore")
    setting_dir = os.path.join(proj, "setting")
    os.makedirs(lore_dir, exist_ok=True)
    os.makedirs(setting_dir, exist_ok=True)

    # ================= lore 资料库 =================
    items = []
    used = set()
    now = now_iso()

    def add_item(keys, content, itype, brief, tags=None):
        nonlocal items
        keys = [k for k in keys if k]
        if not keys:
            keys = ["未命名"]
        kid = "、".join(keys)[:80]
        n = 2
        while kid in used:
            kid = "、".join(keys)[:76] + "_%d" % n
            n += 1
        used.add(kid)
        importance = "major" if itype == "character" else "important"
        load_mode = "resident" if itype in ("character", "faction") else "auto"
        items.append({
            "id": kid, "enabled": True, "type": itype, "type_source": "import",
            "name": "、".join(keys)[:60], "importance": importance,
            "tags": (tags or [])[:10],
            "brief_description": brief,
            "keywords": keys, "load_mode": load_mode, "content": content or "",
            "created_at": now, "updated_at": now,
        })

    seen_content = set()
    truncated = []
    for b in payload.get("books") or []:
        title = safe_name(b.get("title") or "设定书")
        parsed = parse_book_content(b.get("content"))
        added = 0
        for e in parsed:
            if added >= MAX_PER_BOOK:
                break
            dedupe_key = "|".join(e["keys"]) + "\n" + e["content"][:200]
            if dedupe_key in seen_content:
                continue
            seen_content.add(dedupe_key)
            itype = infer_type(" ".join(e["keys"]))
            add_item(e["keys"], e["content"], itype, brief_of(e["content"], itype, "、".join(e["keys"])[:40]), [title])
            added += 1
        if len(parsed) > MAX_PER_BOOK:
            truncated.append(title + "（超限截断，保留前 %d 条）" % MAX_PER_BOOK)

    for c in payload.get("cards") or []:
        cname = str(c.get("name") or "角色").strip()
        desc = clean_card_text(c.get("description"))
        personality = clean_card_text(c.get("personality"))
        scenario = clean_card_text(c.get("scenario"))
        first_mes = clean_card_text(c.get("first_mes"))
        content = "\n\n".join(x for x in [
            "【人设】" + desc,
            "【性格】" + personality,
            "【场景】" + scenario,
            "【开场白】" + first_mes,
        ] if x.strip() and not x.endswith("】"))
        add_item([cname], content, "character", brief_of(content, "character", cname), list(c.get("tags") or []))

    items.sort(key=lambda i: TYPE_ORDER.get(i["type"], 9))
    items = items[:MAX_TOTAL]
    save_json(os.path.join(lore_dir, "items.json"), {"version": 2, "items": items})

    # ================= CREATOR.md（模板格式） =================
    creator = ["# 《%s》" % name, ""]
    if summary:
        creator += ["## 剧情摘要（续写起点）", summary, ""]
    creator += ["## 核心创作规则", ""]
    if custom:
        creator += ["- 其他全局要求：%s" % custom.replace("\n", "\n  "), ""]
    creator += [
        "- 每章字数/篇幅目标：（如 2000-3000 字）",
        "- 禁止内容：（如 未成年人、非自愿等）",
        "- 写作风格：（如 第三人称贴身叙事 / 第一人称）",
        "- 叙事视角：（如 固定女主视角）",
        "- 对话风格：（如 对话推动、直白露骨）",
        "",
        "---",
        "> 来源：文字冒险平台「导出到 Denova」v3（%s）" % today(),
        "",
    ]
    write_text(os.path.join(proj, "CREATOR.md"), "\n".join(creator))

    # ================= ideas.md（模板格式） =================
    ideas = [
        "# 灵感", "",
        "## 当前方向",
        "（一句话：这本书想写成什么）", "",
        "## 核心卖点",
        "（最吸引人的地方）", "",
        "## 作品信息",
        "- 类型：%s" % (theme or "（待定）"),
        "- 目标读者：",
        "- 整体基调：", "",
        "## 金手指 / 独特设定",
        "（钩子，可去掉）", "",
        "## 其他要求",
        "%s" % (other or "（阶段性结论、待确认问题、取舍理由）"), "",
        "## 参考作品",
        "（类似「XX + YY」的感觉）", "",
    ]
    write_text(os.path.join(proj, "ideas.md"), "\n".join(ideas))

    # ================= setting/outline.md =================
    outline = [
        "# 大纲", "",
        "## 主线",
        "%s" % (goal or world or "（主线一句话：故事长期走向）"), "",
        "## 卷章安排",
        "- 第一卷《待定》：范围、主题",
        "  - 第 1-5 章：目标（……）",
        "  - 第 6-10 章：目标（……）", "",
        "## 长期伏笔 / 结局方向",
        "（只在规划层记录，不写已发生内容）", "",
    ]
    write_text(os.path.join(setting_dir, "outline.md"), "\n".join(outline))

    # ================= setting/progress.md =================
    scene = summary_section(summary, "当前场景") or "（当前位置：一句话场景坐标）"
    events = summary_section(summary, "近期事件") or "（暂无）"
    situation = summary_section(summary, "当前局势") or "（暂无）"
    foreshadow = summary_section(summary, "伏笔") or "（暂无）"
    progress = [
        "# 写作进度", "",
        "## 当前进度概览",
        "- 正式章节：尚未在 Denova 中落稿",
        "- 已对话回合：%s" % turns,
        "- 当前位置：%s" % scene, "",
        "## 最近剧情摘要",
        "- %s" % events, "",
        "## 下一步写作提示",
        "- 当前局势：%s" % situation,
        "- 待回收伏笔：%s" % foreshadow,
        "",
    ]
    write_text(os.path.join(setting_dir, "progress.md"), "\n".join(progress))

    # ================= setting/character-states.md =================
    cs = ["# 角色当前状态", ""]
    for c in payload.get("cards") or []:
        cname = str(c.get("name") or "角色").strip()
        cs += [
            "## %s" % cname,
            "- 最近出场：未落稿",
            "- 当前位置：（未知）",
            "- 身体状态：（未知）",
            "- 心理状态：%s" % clean_card_text(c.get("personality")),
            "- 当前目标：（未知）",
            "- 持有物：（未知）",
            "- 关系变化：（未知）",
            "- 待回收伏笔：（未知）",
            "",
        ]
    if not payload.get("cards"):
        cs += ["（暂无角色卡，可从资料库 character 条目补全）", ""]
    write_text(os.path.join(setting_dir, "character-states.md"), "\n".join(cs))

    # ================= 章节（一键生成的小说正文 → chapters/） =================
    novel = payload.get("novel") or {}
    chapters = novel.get("chapters") or []
    ch_count = 0
    if chapters:
        ch_dir = os.path.join(proj, "chapters", "v00001-第一卷")
        os.makedirs(ch_dir, exist_ok=True)
        for i, ch in enumerate(chapters):
            ch_title = safe_name(ch.get("title") or ("第%d章" % (i + 1)))
            ch_content = str(ch.get("content") or "").strip()
            # 纯文本：剥掉常见 Markdown 标记（模板要求正文纯文本）
            ch_content = re.sub(r"^#{1,6}\s*", "", ch_content, flags=re.M)
            ch_content = re.sub(r"^\s*[-*]\s+", "", ch_content, flags=re.M)
            ch_content = re.sub(r"^>\s*", "", ch_content, flags=re.M)
            fname = "ch%05d-%s.md" % (i + 1, ch_title[:30])
            write_text(os.path.join(ch_dir, fname), ch_content)
            ch_count += 1

    # ================= 小说全文.txt（平台「下载全部(.txt)」同款合并版） =================
    novel_full = str((novel.get("fullText") or payload.get("novelFullText") or "")).strip()
    if novel_full:
        write_text(os.path.join(proj, "小说全文.txt"), novel_full)

    # ================= 中文设定文档（setting/设定汇总.txt） =================
    setting_doc = str(payload.get("settingDoc") or "").strip()
    if setting_doc:
        write_text(os.path.join(setting_dir, "设定汇总.txt"), setting_doc)

    # ================= 更新 progress / outline / character-states =================
    if ch_count:
        last_ch = "ch%05d" % ch_count
        progress_path = os.path.join(setting_dir, "progress.md")
        if os.path.exists(progress_path):
            p = open(progress_path, "r", encoding="utf-8").read()
            p = p.replace("- 正式章节：尚未在 Denova 中落稿", "- 正式章节：已完成 ch00001-%s，共 %d 章（来自平台一键生成）" % (last_ch.replace("ch", "ch"), ch_count))
            write_text(progress_path, p)
        outline_path = os.path.join(setting_dir, "outline.md")
        if os.path.exists(outline_path):
            o = open(outline_path, "r", encoding="utf-8").read()
            lines = []
            for i, ch in enumerate(chapters):
                lines.append("  - ch%05d《%s》" % (i + 1, safe_name(ch.get("title") or ("第%d章" % (i + 1)))[:30]))
            if lines:
                o = o.replace("- 第一卷《待定》：范围、主题", "- 第一卷《%s》：范围、主题\n%s" % (safe_name(novel.get("title") or name)[:30], "\n".join(lines)))
                write_text(outline_path, o)
        cs_path = os.path.join(setting_dir, "character-states.md")
        if os.path.exists(cs_path):
            cst = open(cs_path, "r", encoding="utf-8").read()
            cst = cst.replace("- 最近出场：未落稿", "- 最近出场：ch%05d（平台导出）" % ch_count)
            write_text(cs_path, cst)

    register_project(name, proj)
    return {"ok": True, "path": proj.replace("\\", "/"), "items": len(items), "truncated": truncated, "chapters": ch_count}

class Handler(BaseHTTPRequestHandler):
    server_version = "DenovaExportBridge/3.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[denova-bridge] %s\n" % (fmt % args))

    def _send(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Part-SHA256")
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, body, content_type="application/octet-stream"):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _is_loopback(self):
        return bool(self.client_address) and self.client_address[0] in ("127.0.0.1", "::1")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Part-SHA256")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            path = parsed.path
            if path == "/api/denova/health":
                self._send({"ok": True, "version": 5, "denovaDir": DENOVA_DIR, "sync": True, "fullExport": True})
                return
            if path == "/api/denova/translator/status":
                self._send({"ok": True, **full_export_manager().translator_status()})
                return
            if path == "/api/denova/materials":
                if not self._is_loopback():
                    self._send({"ok": False, "code": "invalid_request", "error": "仅允许本机回环地址调用"}, 403)
                    return
                self._send({"ok": True, "materials": knowledge_materials()})
                return
            material_match = re.fullmatch(r"/api/denova/materials/([0-9a-f]{24})", path)
            if material_match:
                if not self._is_loopback():
                    self._send({"ok": False, "code": "invalid_request", "error": "仅允许本机回环地址调用"}, 403)
                    return
                try:
                    material = read_knowledge_material(material_match.group(1))
                    body = base64.b64decode(material.pop("content_base64"))
                    content_type = "image/png" if material["name"].lower().endswith(".png") else "application/json"
                    self._send_bytes(body, content_type)
                except FileNotFoundError as error:
                    self._send({"ok": False, "code": "not_found", "error": str(error)}, 404)
                return
            if path == "/api/denova/translator/jobs":
                if not self._is_loopback():
                    self._send({"ok": False, "code": "invalid_request", "error": "仅允许本机回环地址调用"}, 403)
                    return
                self._send({"ok": True, **full_export_manager().translation_queue_status((qs.get("workspace") or [""])[0])})
                return
            translation_job = re.fullmatch(r"/api/denova/translator/jobs/(translation-[0-9a-f]{24})", path)
            if translation_job:
                if not self._is_loopback():
                    self._send({"ok": False, "code": "invalid_request", "error": "仅允许本机回环地址调用"}, 403)
                    return
                try:
                    self._send({"ok": True, **full_export_manager().get_translation_job(translation_job.group(1))})
                except FileNotFoundError as error:
                    self._send({"ok": False, "code": "not_found", "error": str(error)}, 404)
                return
            match = re.fullmatch(r"/api/denova/export/jobs/(job-[A-Za-z0-9_-]+)", path)
            if match:
                try:
                    self._send({"ok": True, **full_export_manager().get(match.group(1))})
                except FileNotFoundError as error:
                    self._send({"error": str(error)}, 404)
                return
            if path == "/api/denova/sync":
                try:
                    self._send(do_sync_pull((qs.get("id") or [""])[0]))
                except FileNotFoundError as e:
                    self._send({"error": str(e)}, 404)
                return
            if path == "/api/denova/projects":
                out = []
                if os.path.isdir(PROJECTS):
                    for name in sorted(os.listdir(PROJECTS)):
                        d = os.path.join(PROJECTS, name)
                        if not os.path.isdir(d):
                            continue
                        lore_path = os.path.join(d, ".denova", "lore", "items.json")
                        count = 0
                        if os.path.exists(lore_path):
                            try:
                                count = len(json.load(open(lore_path, "r", encoding="utf-8")).get("items", []))
                            except Exception:
                                count = -1
                        out.append({"name": name, "loreCount": count, "path": d.replace("\\", "/")})
                self._send({"ok": True, "projects": out})
                return
            if path == "/api/denova/lore":
                name = safe_name((qs.get("book") or [""])[0])
                lore_path = os.path.join(PROJECTS, name, ".denova", "lore", "items.json")
                if not os.path.exists(lore_path):
                    self._send({"error": "工程不存在或无 lore: " + name}, 404)
                    return
                data = load_json(lore_path, {"version": 2, "items": []})
                self._send({"ok": True, "name": name, "items": data.get("items", [])})
                return
            if path == "/api/denova/director-presets":
                sdm = os.path.join(DENOVA_DIR, "story-director-modules")
                out = {"actorStates": [], "eventPackages": [], "ruleSystems": []}
                if os.path.isdir(sdm):
                    for sub, key in (("actor-states", "actorStates"), ("event-packages", "eventPackages"), ("rule-systems", "ruleSystems")):
                        d = os.path.join(sdm, sub)
                        if not os.path.isdir(d):
                            continue
                        for fn in sorted(os.listdir(d)):
                            if not fn.endswith(".json"):
                                continue
                            try:
                                j = load_json(os.path.join(d, fn), {})
                                meta = {"id": j.get("id") or fn[:-5], "name": j.get("name") or fn[:-5], "description": (j.get("description") or "")[:200]}
                                if sub == "event-packages":
                                    meta["events"] = [{"id": e.get("id"), "type_name": e.get("type_name")} for e in (j.get("events") or [])[:20]]
                                if sub == "rule-systems":
                                    meta["rule_templates"] = [{"id": r.get("id"), "label": r.get("label"), "dice": r.get("dice")} for r in ((j.get("trpg_system") or {}).get("rule_templates") or [])]
                                out[key].append(meta)
                            except Exception as e:
                                out[key].append({"id": fn[:-5], "error": str(e)})
                self._send({"ok": True, **out})
                return
            self._send({"error": "未知接口 " + path}, 404)
        except Exception as e:
            self._send({"error": "内部错误: " + str(e)}, 500)

    def do_PUT(self):
        try:
            path = urllib.parse.urlparse(self.path).path
            match = re.fullmatch(r"/api/denova/export/jobs/(job-[A-Za-z0-9_-]+)/parts/([a-z][a-z0-9_-]{0,30})/(\d+)", path)
            if not match:
                self._send({"error": "未知接口 " + path}, 404)
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > PART_LIMIT:
                self._send({"error": "分块必须在 1 字节到 8 MiB 之间"}, 400)
                return
            body = self.rfile.read(length)
            result = full_export_manager().put_part(match.group(1), match.group(2), int(match.group(3)), body, self.headers.get("X-Part-SHA256") or "")
            self._send({"ok": True, **result})
        except FileNotFoundError as error:
            self._send({"error": str(error)}, 404)
        except Exception as error:
            self._send({"error": str(error)}, 400)

    def do_POST(self):
        try:
            path = urllib.parse.urlparse(self.path).path
            if path == "/api/denova/export/jobs":
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0 or length > 2 * 1024 * 1024:
                    self._send({"error": "导出清单大小异常"}, 400)
                    return
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                self._send({"ok": True, **full_export_manager().create(payload)})
                return
            if path == "/api/denova/translator/install":
                self._send({"ok": True, **full_export_manager().install_translator()})
                return
            if path == "/api/denova/translator/jobs":
                if not self._is_loopback():
                    self._send({"ok": False, "code": "invalid_request", "error": "仅允许本机回环地址调用"}, 403)
                    return
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0 or length > 2 * 1024 * 1024:
                    self._send({"ok": False, "code": "invalid_request", "error": "翻译任务请求体大小异常"}, 413 if length > 2 * 1024 * 1024 else 400)
                    return
                try:
                    payload = json.loads(self.rfile.read(length).decode("utf-8"))
                    self._send({"ok": True, **full_export_manager().create_translation_jobs(payload)})
                except ValueError as error:
                    self._send({"ok": False, "code": "invalid_request", "error": str(error)}, 400)
                return
            queue_action = re.fullmatch(r"/api/denova/translator/queue/(pause|resume)", path)
            if queue_action:
                if not self._is_loopback():
                    self._send({"ok": False, "code": "invalid_request", "error": "仅允许本机回环地址调用"}, 403)
                    return
                length = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(length).decode("utf-8")) if 0 < length <= 4096 else {}
                try:
                    method = full_export_manager().pause_translation_queue if queue_action.group(1) == "pause" else full_export_manager().resume_translation_queue
                    self._send({"ok": True, **method(str(payload.get("reason") or "manual"))})
                except ValueError as error:
                    self._send({"ok": False, "code": "invalid_request", "error": str(error)}, 400)
                return
            translation_action = re.fullmatch(r"/api/denova/translator/jobs/(translation-[0-9a-f]{24})/(cancel|retry|resolve|delete)", path)
            if translation_action:
                if not self._is_loopback():
                    self._send({"ok": False, "code": "invalid_request", "error": "仅允许本机回环地址调用"}, 403)
                    return
                job_id, action = translation_action.groups()
                try:
                    if action == "cancel":
                        result = full_export_manager().cancel_translation_job(job_id)
                    elif action == "delete":
                        result = full_export_manager().delete_translation_job(job_id)
                    elif action == "retry":
                        result = full_export_manager().retry_translation_job(job_id)
                    else:
                        length = int(self.headers.get("Content-Length") or 0)
                        payload = json.loads(self.rfile.read(length).decode("utf-8")) if 0 < length <= 4096 else {}
                        result = full_export_manager().resolve_translation_job(job_id, str(payload.get("status") or ""), str(payload.get("error") or ""))
                    self._send({"ok": True, **result})
                except FileNotFoundError as error:
                    self._send({"ok": False, "code": "not_found", "error": str(error)}, 404)
                except ValueError as error:
                    self._send({"ok": False, "code": "invalid_request", "error": str(error)}, 400)
                return
            if path == "/api/denova/translator/translate":
                if not self._is_loopback():
                    self._send({"ok": False, "code": "invalid_request", "error": "仅允许本机回环地址调用"}, 403)
                    return
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0:
                    self._send({"ok": False, "code": "empty_fields", "error": "请求体为空"}, 400)
                    return
                if length > 2 * 1024 * 1024:
                    self._send({"ok": False, "code": "payload_too_large", "error": "请求体超过 2 MiB 上限"}, 413)
                    return
                try:
                    payload = json.loads(self.rfile.read(length).decode("utf-8"))
                except Exception:
                    self._send({"ok": False, "code": "invalid_request", "error": "请求体不是合法 JSON"}, 400)
                    return
                if str(payload.get("target_language") or "") != "zh-CN":
                    self._send({"ok": False, "code": "invalid_request", "error": "仅支持 target_language=zh-CN"}, 400)
                    return
                fields = payload.get("fields") or {}
                if not isinstance(fields, dict) or not fields:
                    self._send({"ok": False, "code": "empty_fields", "error": "未提供待翻译字段"}, 400)
                    return
                context = payload.get("context") or {}
                try:
                    result = full_export_manager().translate_lore_fields(fields, context)
                    self._send({"ok": True, **result})
                except ValueError as error:
                    message = str(error)
                    code = "empty_fields" if "没有可翻译" in message else "invalid_request"
                    self._send({"ok": False, "code": code, "error": message}, 400)
                except RuntimeError as error:
                    code = str(error)
                    if code == "translator_offline":
                        self._send({"ok": False, "code": code, "error": "Ollama 当前不可用，请启动 Ollama 后重试"}, 503)
                    elif code == "model_missing":
                        self._send({"ok": False, "code": code, "error": "尚未安装 HY-MT 本地翻译模型"}, 503)
                    elif code == "translation_validation_failed":
                        self._send({"ok": False, "code": code, "error": "译文未通过完整性校验，原资料未修改"}, 422)
                    elif code == "translation_failed":
                        self._send({"ok": False, "code": code, "error": "本地翻译失败，请重试"}, 422)
                    else:
                        self._send({"ok": False, "code": "translation_failed", "error": str(error)}, 422)
                except Exception as error:
                    self._send({"ok": False, "code": "translation_failed", "error": "翻译服务异常: %s" % error}, 500)
                return
            job_action = re.fullmatch(r"/api/denova/export/jobs/(job-[A-Za-z0-9_-]+)/(preflight|start|pause|resume|cancel)", path)
            if job_action:
                job_id, action = job_action.groups()
                if action == "preflight":
                    length = int(self.headers.get("Content-Length") or 0)
                    if length < 0 or length > 2 * 1024 * 1024:
                        self._send({"error": "预检请求大小异常"}, 400)
                        return
                    payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                    result = full_export_manager().preflight(job_id, payload.get("resolutions") or {})
                else:
                    result = getattr(full_export_manager(), action)(job_id)
                self._send({"ok": True, **result})
                return
            if path == "/api/denova/sync":
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0 or length > 20 * 1024 * 1024:
                    self._send({"error": "请求体大小异常"}, 400)
                    return
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                self._send(do_sync_push(payload))
                return
            if path == "/api/denova/import-kb":
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0 or length > 5 * 1024 * 1024:
                    self._send({"error": "请求体大小异常"}, 400)
                    return
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                name = safe_name(payload.get("name") or "Denova工程")
                description = str(payload.get("description") or "")
                content = str(payload.get("content") or "")
                if not content:
                    self._send({"error": "缺少内容"}, 400)
                    return
                kb_world = os.path.join(os.path.dirname(os.path.dirname(DENOVA_DIR)), "knowledge-base", "世界观设定")
                os.makedirs(kb_world, exist_ok=True)
                entries = {}
                uid = 1
                for m in re.finditer(r"【([^】]+)】([\s\S]*?)(?=【|$)", content):
                    keys = [s.strip() for s in re.split(r"[、,，]", m.group(1)) if s.strip()]
                    c = m.group(2).strip()
                    if c and keys:
                        entries[keys[0]] = {"uid": uid, "key": keys, "keysecondary": [], "comment": "", "content": c}
                        uid += 1
                if not entries:
                    entries["资料"] = {"uid": 1, "key": ["资料"], "keysecondary": [], "comment": "", "content": content[:6000]}
                book = {
                    "name": "", "description": description or ("从 Denova 工程「%s」AI 整理导入（%s）" % (name, time.strftime("%Y-%m-%d"))),
                    "is_creation": False, "scan_depth": 2, "token_budget": 0,
                    "recursive_scanning": False, "extensions": {},
                    "entries": entries,
                }
                out_path = os.path.join(kb_world, "denova-" + name + ".json")
                save_json(out_path, book)
                self._send({"ok": True, "path": out_path.replace("\\", "/"), "entries": len(entries)})
                return
            if path != "/api/denova/export":
                self._send({"error": "未知接口 " + path}, 404)
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 20 * 1024 * 1024:
                self._send({"error": "请求体大小异常"}, 400)
                return
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            result = do_export(payload)
            self._send(result)
        except Exception as e:
            self._send({"error": "导出失败: " + str(e)}, 500)

def main():
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("denova data bridge v4 listening on http://0.0.0.0:%d" % PORT)
    srv.serve_forever()

if __name__ == "__main__":
    main()
