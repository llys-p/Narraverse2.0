# -*- coding: utf-8 -*-
"""Re-read knowledge-base 所有设定书/角色卡，给 设定集元数据.json 每条补 category 字段，
并自动补录缺失条目、清理已不存在的条目。仅改元数据，不动原文件。"""
import json, os, re

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KB = os.environ.get("NARRAVERSE_KNOWLEDGE_BASE", os.path.join(PROJECT_ROOT, "knowledge-base"))
META = os.path.join(KB, "设定集元数据.json")
WORLD = os.path.join(KB, "世界观设定")
CARD = os.path.join(KB, "角色卡")


def jload(p):
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception as e:
        print("  跳过解析失败:", os.path.basename(p), repr(e))
        return None


def book_category(title, tags, nsfw, summary):
    if nsfw:
        return "NSFW"
    text = " ".join([title] + list(tags) + [summary or ""])
    if "小说设定" in title or "小说" in tags or "大纲" in tags:
        return "小说模板"
    if re.search(r"修仙|仙侠|修真", text):
        return "修仙仙侠"
    if re.search(r"末日|丧尸|废土|僵尸|灾变|求生", text):
        return "末日废土"
    if re.search(r"赛博|科幻|星际|宇宙|机甲|太空|环世界|分裂天空", text):
        return "科幻"
    if re.search(r"校园|高中", text):
        return "校园"
    if re.search(r"恐怖|克苏鲁|诡秘|咒|跟踪", text):
        return "恐怖"
    if re.search(r"同人|龙珠|碧蓝|冰与火|哈利|Re零|我的英雄|学院|上古卷轴|火影|权游", text):
        return "同人世界"
    if re.search(r"奇幻|魔法|异世界|DND|精灵|战锤|斗气|龙与地下城|阿多利昂|鲁娜|阿尔坎西亚|幻想RPG", text):
        return "奇幻"
    if re.search(r"系统|RPG|指令|属性|成长|状态|规则|越狱|战斗|血腥|文风|催眠|角色扮演|RPG", text):
        return "通用系统"
    return "其他"


def card_category(tags, nsfw):
    if "讲述者" in tags:
        return "讲述者"
    return "NSFW角色" if nsfw else "一般角色"


def infer_nsfw(title, tags, summary):
    text = " ".join([title] + list(tags) + [summary or ""]).lower()
    return bool(re.search(r"nsfw|smut|hentai|性|色情|性癖|成人|娘|人妻|继妹|学妹|妈妈|阿姨|妻子|女警|情欲|催眠|性行为|子宫|巨根|里番", text))


meta = jload(META) or {"books": {}, "cards": {}}
meta.setdefault("books", {})
meta.setdefault("cards", {})

# ---- 设定书 ----
seen_books = set()
for fn in sorted(os.listdir(WORLD)):
    if not fn.endswith(".json"):
        continue
    title = os.path.splitext(fn)[0]
    seen_books.add(title)
    obj = jload(os.path.join(WORLD, fn))
    if obj is None:
        continue
    desc = obj.get("description") or ""
    name = obj.get("name") or title
    m = meta["books"].get(title, {})
    if not m:
        print("  + 新增书元数据:", title)
        m = {}
    # 自动补 summary
    if not m.get("summary"):
        s = (desc or name).strip()
        m["summary"] = (s[:120] + "…") if len(s) > 120 else s
    tags = m.get("tags") or []
    if not tags:
        # 用描述里的关键词生成基础 tags
        tags = []
    nsfw = bool(m.get("nsfw", infer_nsfw(title, tags, m.get("summary", ""))))
    m["nsfw"] = nsfw
    if "lang" not in m:
        m["lang"] = "en" if not re.search(r"[\u4e00-\u9fff]", desc) else "zh"
    m["category"] = book_category(title, tags, nsfw, m.get("summary", ""))
    m["tags"] = tags
    meta["books"][title] = m

# 清理不存在的书
for title in list(meta["books"].keys()):
    if title not in seen_books:
        print("  - 删除失效书元数据:", title)
        del meta["books"][title]

# ---- 角色卡 ----
seen_cards = set()
for fn in sorted(os.listdir(CARD)):
    if not fn.endswith(".json"):
        continue
    base = os.path.splitext(fn)[0]
    obj = jload(os.path.join(CARD, fn))
    if obj is None:
        continue
    # 取卡名（与生成脚本一致）
    src = obj
    if isinstance(src, dict) and isinstance(src.get("data"), dict):
        src = src["data"]
    cname = str((src or {}).get("name") or base).strip()
    if not cname:
        continue
    seen_cards.add(cname)
    raw_tags = src.get("tags") if isinstance(src, dict) else None
    tags = m.get("tags") or []
    if not tags and isinstance(raw_tags, list):
        tags = [str(t).strip() for t in raw_tags if str(t).strip()]
    m = meta["cards"].get(cname, {})
    if not m:
        print("  + 新增卡元数据:", cname)
        m = {}
    if not m.get("summary"):
        s = (str((src or {}).get("description") or "") or cname).strip()
        m["summary"] = (s[:120] + "…") if len(s) > 120 else s
    nsfw = bool(m.get("nsfw", infer_nsfw(cname, tags, m.get("summary", ""))))
    m["nsfw"] = nsfw
    m["category"] = card_category(tags, nsfw)
    m["tags"] = tags
    meta["cards"][cname] = m

for cname in list(meta["cards"].keys()):
    if cname not in seen_cards:
        print("  - 删除失效卡元数据:", cname)
        del meta["cards"][cname]

with open(META, "w", encoding="utf-8") as f:
    json.dump(meta, f, ensure_ascii=False, indent=2)
print("元数据已更新: 书 %d / 卡 %d" % (len(meta["books"]), len(meta["cards"])))
