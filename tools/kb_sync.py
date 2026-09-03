# -*- coding: utf-8 -*-
"""知识库中文简介补全 + 三处同步 + 平台注入 的可复用引擎。

工作流（对应 Skill `kb-summary-sync`）：
  1. discover  —— 扫描 knowledge-base 中「设定集元数据.json 缺 summary」的卡/书，给出待处理清单（含源文件路径，供 AI 读原文写简介）。
  2. apply     —— 把一条写好的中文简介同步进三处目标：
                  ① 设定集元数据.json 的 summary(+tags/nsfw/category)
                  ② Obsidian 素材库对应 md 的 `## 简介` 节
                  ③ 说明文档.md 的对应表格行
  3. regen     —— 跑 rebuild_meta_categories.py 再跑 gen_local_library_v2.py，重生成 app/local_library.js。
  4. verify    —— 校验某卡/书是否已进入 local_library.js（即平台「添加设定卡」网格可见）。

注意：本脚本只做「机械落盘 + 平台重生成 + 校验」。中文简介本身的撰写（读原文、保留风格/语气/用词、
把 {{char}}/{{user}} 替换为 主人公/主角、叙述者类用 叙述者/AI、露骨词不洗白）由 AI 按 Skill 约定完成，
再把摘要文本交给 `apply`。

项目内路径默认相对本脚本定位；外部 Obsidian 路径通过环境变量提供，未配置时跳过 Obsidian 同步。
"""
import json
import os
import re
import glob
import subprocess
import sys

# ---- 项目路径（可通过环境变量覆盖） ----
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KB = os.environ.get("NARRAVERSE_KNOWLEDGE_BASE", os.path.join(PROJECT_ROOT, "knowledge-base"))
META = os.path.join(KB, "设定集元数据.json")
BOOK_DIR = os.path.join(KB, "世界观设定")
CARD_DIR = os.path.join(KB, "角色卡")
DOC = os.path.join(KB, "说明文档.md")
OBS_W = os.environ.get("NARRAVERSE_OBSIDIAN_WORLD", "")
OBS_C = os.environ.get("NARRAVERSE_OBSIDIAN_CARDS", "")
LIB = os.environ.get("NARRAVERSE_LOCAL_LIBRARY_OUT", os.path.join(PROJECT_ROOT, "app", "local_library.js"))
REBUILD = os.path.join(PROJECT_ROOT, "tools", "rebuild_meta_categories.py")
GEN = os.path.join(PROJECT_ROOT, "tools", "gen_local_library_v2.py")


# ============ 元数据读写 ============
def load_meta():
    if not os.path.exists(META):
        return {"books": {}, "cards": {}}
    try:
        return json.load(open(META, encoding="utf-8"))
    except Exception:
        return {"books": {}, "cards": {}}


def save_meta(meta):
    with open(META, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)


# ============ 卡名解析（兼容 chara_card_v2 嵌套 data） ============
def card_display_name(obj):
    name = obj.get("name")
    if not name and isinstance(obj.get("data"), dict):
        name = obj.get("data", {}).get("name")
    return (name or "").strip()


# ============ 1. discover：找出缺 summary 的待处理项 ============
def discover_pending():
    """返回 [(type, key, src_path), ...]，type∈{'book','card'}。"""
    meta = load_meta()
    meta_books = meta.get("books", {})
    meta_cards = meta.get("cards", {})
    pending = []

    for fn in sorted(os.listdir(BOOK_DIR)):
        if not fn.endswith(".json"):
            continue
        title = os.path.splitext(fn)[0]
        b = meta_books.get(title, {})
        if not (b.get("summary") or "").strip():
            pending.append(("book", title, os.path.join(BOOK_DIR, fn)))

    for fn in sorted(os.listdir(CARD_DIR)):
        if not fn.endswith(".json"):
            continue
        try:
            obj = json.load(open(os.path.join(CARD_DIR, fn), encoding="utf-8"))
        except Exception:
            continue
        name = card_display_name(obj)
        if not name:
            continue
        c = meta_cards.get(name, {})
        if not (c.get("summary") or "").strip():
            pending.append(("card", name, os.path.join(CARD_DIR, fn)))

    return pending


# ============ Obsidian 路径定位 ============
def obsidian_path_for(type_, key):
    """book: 文件名为 title.md；card: frontmatter 原名 == key。"""
    if type_ == "book":
        p = os.path.join(OBS_W, key + ".md")
        return p if os.path.exists(p) else None
    for f in glob.glob(OBS_C + "/*.md"):
        fm = parse_frontmatter(f)
        if (fm.get("原名") or "").strip() == key:
            return f
    return None


def parse_frontmatter(path):
    try:
        txt = open(path, encoding="utf-8").read()
    except Exception:
        return {}
    m = re.match(r"^---\s*\n(.*?)\n---", txt, re.S)
    if not m:
        return {}
    out = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            v = v.strip().strip('"').strip("'")
            out[k.strip()] = v
    return out


# ============ Obsidian ## 简介 写入 ============
def upsert_intro(path, summary):
    """在 Obsidian md 中写入/更新 `## 简介` 节；无该节则在首个 `## ` 前插入。"""
    txt = open(path, encoding="utf-8").read()
    summary = summary.strip()
    intro_block = "## 简介\n" + summary + "\n"

    if "## 简介" in txt:
        # 替换 ## 简介 到下一个 ## 或文末之间的内容
        new_txt = re.sub(
            r"## 简介\s*\n.*?(?=\n## |\Z)",
            lambda m: "## 简介\n" + summary + "\n",
            txt,
            flags=re.S,
        )
        if new_txt == txt:  # 兜底：手动分割
            head, sep, rest = txt.partition("## 简介")
            parts = rest.split("\n## ", 1)
            tail = ("\n## " + parts[1]) if len(parts) > 1 else ""
            new_txt = head + intro_block + tail
    else:
        # 找首个 ## 节，插在它前面；都没有则追加
        idx = txt.find("\n## ")
        if idx != -1:
            new_txt = txt[:idx] + "\n" + intro_block + txt[idx:]
        else:
            new_txt = txt.rstrip() + "\n\n" + intro_block

    with open(path, "w", encoding="utf-8") as f:
        f.write(new_txt)
    return True


# ============ 说明文档.md 行 写入 ============
def doc_table_anchor(type_):
    """返回 (header_line_marker, table_header_row)。cards 表头 `| 文件 | 作用 |`；books 表头同。"""
    if type_ == "card":
        return ("## 角色卡", "| 文件 | 作用 |")
    return ("## 世界观设定", "| 文件 | 作用 |")


def upsert_doc_row(type_, filename_stem, ext, summary):
    """在 说明文档.md 对应表格中，按文件名(stem)定位行并更新第二列；无则追加到该表末尾。"""
    txt = open(DOC, encoding="utf-8").read()
    summary = summary.strip()
    # 候选文件名：说明文档里卡可能列 .json 或 .png；书列 .json
    candidates = [filename_stem + ext]
    if ext == ".json":
        candidates.append(filename_stem + ".png")
    else:
        candidates.append(filename_stem + ".json")

    lines = txt.split("\n")
    target_idx = None
    for i, line in enumerate(lines):
        if line.strip().startswith("|") and not line.strip().startswith("| ---"):
            first = line.split("|")[1].strip() if len(line.split("|")) > 1 else ""
            if first in candidates:
                target_idx = i
                break

    if target_idx is not None:
        cells = lines[target_idx].split("|")
        # cells: ['', '文件', '作用', ''] -> 更新第 3 格
        if len(cells) >= 4:
            cells[2] = " " + summary + " "
            lines[target_idx] = "|".join(cells)
        new_txt = "\n".join(lines)
    else:
        # 追加：定位对应表（## 角色卡 / ## 世界观设定），在其表格最后一行后插入
        section, _ = doc_table_anchor(type_)
        new_row = "| %s.%s | %s |" % (filename_stem, ext.lstrip("."), summary)
        insert_at = None
        for i, line in enumerate(lines):
            if line.strip().startswith(section):
                # 从该节向下找最后一个表格行
                j = i + 1
                last_row = None
                while j < len(lines) and (lines[j].strip().startswith("|") or lines[j].strip().startswith("###") or lines[j].strip() == ""):
                    if lines[j].strip().startswith("|") and not lines[j].strip().startswith("| ---"):
                        last_row = j
                    if lines[j].strip().startswith("###"):
                        break
                    j += 1
                insert_at = last_row
                break
        if insert_at is None:
            lines.append(new_row)
        else:
            lines.insert(insert_at + 1, new_row)
        new_txt = "\n".join(lines)

    with open(DOC, "w", encoding="utf-8") as f:
        f.write(new_txt)
    return target_idx is not None


# ============ 2. apply：三处同步 ============
def apply_one(type_, key, summary, tags=None, nsfw=None, category=None,
              obsidian_filename=None):
    """把一条中文简介同步进 ①metadata ②Obsidian ## 简介 ③说明文档.md。
    obsidian_filename: 可选，显式指定 Obsidian 文件名（不含 .md）；不传则自动定位。
    返回 dict 报告各目标是否成功。"""
    meta = load_meta()
    if type_ == "book":
        bucket = meta.setdefault("books", {})
    else:
        bucket = meta.setdefault("cards", {})
    entry = bucket.setdefault(key, {})
    entry["summary"] = summary.strip()
    if tags is not None:
        entry["tags"] = tags if isinstance(tags, list) else [t.strip() for t in re.split(r"[,，、]", tags) if t.strip()]
    if nsfw is not None:
        entry["nsfw"] = bool(nsfw)
    if category is not None:
        entry["category"] = category
    save_meta(meta)
    meta_ok = True

    # Obsidian
    obs_path = obsidian_path_for(type_, key)
    if obsidian_filename:
        cand = os.path.join(OBS_W if type_ == "book" else OBS_C, obsidian_filename + ".md")
        if os.path.exists(cand):
            obs_path = cand
    obs_ok = False
    if obs_path and os.path.exists(obs_path):
        upsert_intro(obs_path, summary)
        obs_ok = True

    # 说明文档：文件名 stem 用 obsidian 文件名或 key
    stem = os.path.splitext(os.path.basename(obs_path or ""))[0] if obs_path else key
    ext = ".json"
    doc_ok = upsert_doc_row(type_, stem, ext, summary)

    return {
        "type": type_, "key": key,
        "meta": meta_ok, "obsidian": obs_ok, "doc": doc_ok,
        "obsidian_path": obs_path,
    }


# ============ 3. regen：平台重生成 ============
def regen():
    """先 rebuild_meta_categories.py 再 gen_local_library_v2.py。返回 (ok, msg)。"""
    for script in (REBUILD, GEN):
        if not os.path.exists(script):
            return False, "缺失脚本: " + script
        try:
            r = subprocess.run(
                [sys.executable, script],
                capture_output=True, text=True, encoding="utf-8", timeout=300,
            )
            if r.returncode != 0:
                return False, "脚本失败 %s:\n%s\n%s" % (script, r.stdout, r.stderr)
        except Exception as e:
            return False, "运行异常 %s: %r" % (script, e)
    return True, "local_library.js 已重生成"


# ============ 4. verify：校验是否进入平台库 ============
def verify_in_library(name):
    """检查 local_library.js 中是否存在 name（卡按 name，书按 title）。"""
    if not os.path.exists(LIB):
        return False, "local_library.js 不存在，请先 regen"
    txt = open(LIB, encoding="utf-8").read()
    # 去掉注释行前缀
    m = re.search(r"window\.LOCAL_LIBRARY\s*=\s*(\{.*\})\s*;", txt, re.S)
    if not m:
        return False, "无法解析 LOCAL_LIBRARY"
    try:
        data = json.loads(m.group(1))
    except Exception as e:
        return False, "JSON 解析失败: %r" % e
    cards = {c.get("name") for c in data.get("cards", [])}
    books = {b.get("title") for b in data.get("books", [])}
    if name in cards:
        c = next(c for c in data["cards"] if c.get("name") == name)
        return True, "✅ 角色卡已收录，summary=%s，category=%s" % (
            "有" if c.get("summary") else "空", c.get("category"))
    if name in books:
        b = next(b for b in data["books"] if b.get("title") == name)
        return True, "✅ 设定书已收录，summary=%s，category=%s" % (
            "有" if b.get("summary") else "空", b.get("category"))
    return False, "❌ 未收录（请确认 json 在 knowledge-base 且已 regen）"


# ============ CLI ============
if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "discover"
    if cmd == "discover":
        pend = discover_pending()
        if not pend:
            print("✅ 无待处理项（全部已有 summary）")
        else:
            print("待处理 %d 项：" % len(pend))
            for t, k, p in pend:
                print("  [%s] %s  ->  %s" % (t, k, p))
    elif cmd == "regen":
        ok, msg = regen()
        print(("✅ " if ok else "❌ ") + msg)
    elif cmd == "verify":
        if len(sys.argv) < 3:
            print("用法: python kb_sync.py verify <name>")
        else:
            ok, msg = verify_in_library(sys.argv[2])
            print(msg)
    elif cmd == "apply":
        # apply <type> <key> <summary_file> [--tags t1,t2] [--nsfw 0|1] [--category X] [--obs 文件名]
        import argparse
        ap = argparse.ArgumentParser()
        ap.add_argument("type"); ap.add_argument("key"); ap.add_argument("summary_file")
        ap.add_argument("--tags", default=None); ap.add_argument("--nsfw", default=None)
        ap.add_argument("--category", default=None); ap.add_argument("--obs", default=None)
        a = ap.parse_args(sys.argv[2:])
        summary = open(a.summary_file, encoding="utf-8").read().strip()
        nsfw = None if a.nsfw is None else (a.nsfw in ("1", "true", "True"))
        rep = apply_one(a.type, a.key, summary, a.tags, nsfw, a.category, a.obs)
        print("apply 结果:", rep)
    else:
        print("用法: python kb_sync.py [discover|apply|regen|verify]")
