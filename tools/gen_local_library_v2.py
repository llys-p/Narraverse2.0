# -*- coding: utf-8 -*-
"""Regenerate app/local_library.js from knowledge-base (project-local path).
读 世界观设定/*.json + 角色卡/*.json + 设定集元数据.json，输出含
summary/tags/nsfw/lang/entries/avatar/category 的本地库。"""
import json
import hashlib
import os
import re

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KB = os.environ.get("NARRAVERSE_KNOWLEDGE_BASE", os.path.join(PROJECT_ROOT, "knowledge-base"))
OUT = os.environ.get("NARRAVERSE_LOCAL_LIBRARY_OUT", os.path.join(PROJECT_ROOT, "app", "local_library.js"))
META = os.path.join(KB, "设定集元数据.json")
AVATAR_DIR = os.path.join(PROJECT_ROOT, "app", "avatars")

BOOK_CAP = 10000
NOTES_CAP = 3000
MES_CAP = 1500


def cut(text, cap):
    text = (text or "").strip()
    if len(text) <= cap:
        return text
    return text[:cap] + "\n…（内容已截断，完整版见 knowledge-base 原文件）"


def source_ref(kind, path):
    """Return a portable, verifiable reference to the full knowledge-base source."""
    rel = os.path.relpath(path, KB).replace("\\", "/")
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    source_id = hashlib.sha256((kind + "\n" + rel).encode("utf-8")).hexdigest()[:24]
    return {
        "version": 1,
        "kind": kind,
        "relative_path": rel,
        "source_id": source_id,
        "source_hash": digest,
    }


def load_meta():
    if not os.path.exists(META):
        return {"books": {}, "cards": {}}
    try:
        return json.load(open(META, encoding="utf-8"))
    except Exception:
        return {"books": {}, "cards": {}}


def build_books(meta_books):
    books = []
    world_dir = os.path.join(KB, "世界观设定")
    for fn in sorted(os.listdir(world_dir)):
        if not fn.endswith(".json"):
            continue
        try:
            source_path = os.path.join(world_dir, fn)
            obj = json.load(open(source_path, encoding="utf-8"))
        except Exception as e:
            print("跳过(解析失败):", fn, repr(e))
            continue
        title = os.path.splitext(fn)[0]
        inner_name = obj.get("name")
        desc = obj.get("description") or ""
        entries = obj.get("entries") or {}
        parts = []
        if inner_name and inner_name != title:
            parts.append("（内部名：%s）" % inner_name)
        if desc:
            parts.append(desc.strip())
        for k, v in entries.items():
            if not isinstance(v, dict):
                continue
            key = v.get("key") or k
            content = v.get("content") or ""
            if isinstance(key, list):
                key = "、".join(str(x) for x in key)
            if content:
                parts.append("【%s】%s" % (key, content.strip()))
        content = cut("\n\n".join(parts), BOOK_CAP)
        m = meta_books.get(title, {})
        books.append({
            "title": title,
            "content": content,
            "source": "本地知识库·世界观设定",
            "size": len(content),
            "summary": m.get("summary", ""),
            "tags": m.get("tags", []),
            "nsfw": bool(m.get("nsfw", False)),
            "lang": m.get("lang", ""),
            "category": m.get("category", "其他"),
            "entries": len(entries),
            "source_ref": source_ref("lorebook", source_path),
        })
    return books


def normalize_card(src):
    if isinstance(src, dict) and isinstance(src.get("data"), dict) and (src.get("data", {}).get("name") or src.get("spec") == "chara_card_v2"):
        src = src["data"]
    if not isinstance(src, dict):
        return None
    notes = src.get("notes") or src.get("备注") or src.get("description") or src.get("背景") or ""
    card = {
        "name": str(src.get("name") or src.get("名字") or "").strip(),
        "appearance": str(src.get("appearance") or src.get("外貌") or "").strip(),
        "personality": str(src.get("personality") or src.get("性格") or "").strip(),
        "relationship": str(src.get("relationship") or src.get("关系") or "").strip(),
        "notes": cut(notes, NOTES_CAP),
    }
    if src.get("first_mes"):
        card["first_mes"] = cut(src["first_mes"], MES_CAP)
    if src.get("scenario"):
        card["scenario"] = str(src["scenario"]).strip()
    if src.get("tags"):
        tags = src["tags"] if isinstance(src["tags"], list) else re.split(r"[,，、]", str(src["tags"]))
        card["tags"] = [str(s).strip() for s in tags if str(s).strip()]
    if not card["appearance"] and card["notes"]:
        m = re.search(r"外貌[:：]\s*([^\n]+)", card["notes"])
        if m:
            card["appearance"] = m.group(1).strip()
    if not card["name"]:
        return None
    card["source"] = "本地知识库·角色卡"
    return card


def build_cards(meta_cards):
    cards = []
    card_dir = os.path.join(KB, "角色卡")
    for fn in sorted(os.listdir(card_dir)):
        if not fn.endswith(".json"):
            continue
        try:
            source_path = os.path.join(card_dir, fn)
            obj = json.load(open(source_path, encoding="utf-8"))
        except Exception as e:
            print("跳过(解析失败):", fn, repr(e))
            continue
        card = normalize_card(obj)
        if not card:
            continue
        base = os.path.splitext(fn)[0]
        avatar_base = base.replace("（", "(").replace("）", ")")
        avatar_path = os.path.join(AVATAR_DIR, avatar_base + ".jpg")
        if os.path.exists(avatar_path):
            card["avatar"] = "avatars/" + avatar_base + ".jpg"
        m = meta_cards.get(card["name"], {})
        card["summary"] = m.get("summary", "")
        meta_tags = m.get("tags") or []
        if not card.get("tags"):
            card["tags"] = list(meta_tags)
        elif meta_tags:
            low = [str(t).lower() for t in card["tags"]]
            for t in meta_tags:
                if str(t).lower() not in low:
                    card["tags"].append(t)
        inferred = bool(m.get("nsfw"))
        if not inferred and card.get("tags"):
            low = " ".join(str(t).lower() for t in card["tags"])
            inferred = "nsfw" in low or "smut" in low or "hentai" in low
        card["nsfw"] = inferred
        card["category"] = m.get("category", "NSFW角色" if inferred else "一般角色")
        card["source_ref"] = source_ref("character_card", source_path)
        cards.append(card)
    return cards


meta = load_meta()
books = build_books(meta.get("books", {}))
cards = build_cards(meta.get("cards", {}))
payload = {"generatedAt": "2026-08-10", "books": books, "cards": cards}
with open(OUT, "w", encoding="utf-8") as f:
    f.write("/* 本地 knowledge-base 设定集 + 角色卡（由 tools/gen_local_library_v2.py 生成）*/\n")
    f.write("window.LOCAL_LIBRARY = ")
    json.dump(payload, f, ensure_ascii=False, indent=1)
    f.write(";\n")

print("生成完成: %s" % OUT)
print("设定书: %d 本" % len(books))
print("角色卡: %d 张" % len(cards))
print("有中文简介的设定书: %d" % sum(1 for b in books if b.get("summary")))
total_kb = os.path.getsize(OUT) / 1024
print("文件大小: %.1f KB" % total_kb)
