"""静态预算检查：只加载 tokenizer，**不加载模型、不跑决策、不调 LLM**。

为什么必须先跑这一步（Phase3 English 复现实验 req.5）：

  1. 逐用例量 state 文档的 token 数与余量，标出**溢出/被截断**的用例。
     laya 的 build_sequence 溢出时做 `st[:room]` —— 保留左、丢右，而 compact
     state 的尾部正是 `message`（玩家这一句）和 `decision_history`（多轮上下文）。
     也就是说溢出的用例里，模型**根本没看到玩家说了什么**，而 API 返回里毫无迹象。
     这类用例必须从「能力对比」里剔除，单独列为 invalid，否则
     「english 更差」会只是「english 的 message 被吃掉了」。

  2. 检查**翻译缓存覆盖率**。缓存缺失会在跑的时候触发 LLM 调用，既拖时间，
     又会往缓存里写新条目 —— 那就不是「复用同一份缓存」了：第 1 次运行会
     边跑边补缓存，第 2、3 次命中率不同，条件就不一致。
     所以这里用**严格查缓存**（缺失返回 MISS，绝不调 LLM），开跑前一次性查清。

用法：
    LAYA_MODEL=english         ./.venv-cuda/Scripts/python.exe tests/replication/budget_check.py
    LAYA_MODEL=typed-decisions ./.venv-cuda/Scripts/python.exe tests/replication/budget_check.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _find_root(start):
    """向上找含 laya_bridge.py 的目录 —— 脚本换位置后不用改路径。"""
    d = start
    for _ in range(4):
        if os.path.exists(os.path.join(d, "laya_bridge.py")):
            return d
        d = os.path.dirname(d)
    raise SystemExit("找不到 laya_bridge.py；脚本必须放在 laya-live/ 之内")


ROOT = _find_root(HERE)
sys.path.insert(0, ROOT)

sys.argv = [sys.argv[0]]  # 防止 import 期误读 argv（bridge 里有按 argv 取数字的逻辑）

import laya_bridge as B  # noqa: E402

FRESH = [{"type": "start", "summary": "scene begins"}]

print("=" * 88)
print("静态预算检查（只加载 tokenizer，不跑模型）")
print("=" * 88)
print("检查点 = %s   LANG = %s" % (B.DEFAULT_MODEL_NAME, B.LANG))

cb = B.checkpoint_budget()
if not cb:
    print("★ checkpoint_budget() 拿不到 —— tokenizer 没就位，后面的数字全部无效。")
    sys.exit(2)
max_len, head, _tok = cb
room = max_len - head - 1
print("max_len=%d  head_max_len=%d  →  room(state 可用 token)=%d" % (max_len, head, room))

cache = {}
try:
    cache = json.loads(B._XLATE_DISK.read_text(encoding="utf-8"))
except Exception as e:
    print("读翻译缓存失败：%r" % e)
print("翻译缓存条目 = %d" % len(cache))


def translate_strict(text):
    """严格查缓存：缺失返回 MISS。**绝不在这里调 LLM。**"""
    if B.LANG != "en":
        return text, "n/a"
    if text in cache:
        return cache[text], "hit"
    return None, "MISS"


def make(text, dh):
    te, status = translate_strict(text)
    if te is None:
        return None, status
    doc = B.build_state_doc(B.CFG["actor"], text, [], B.CFG.get("scene"), None,
                            player_input_en=te, decision_history=dh)
    return doc, status


sets = B._load_case_sets()
items = []


def add(case_set, cid, role, text, dh):
    doc, status = make(text, dh)
    rec = {"set": case_set, "id": cid, "role": role, "cache": status}
    if doc is None:
        rec.update({"tokens": None, "overflow": None, "note": "翻译缓存未命中，未测预算"})
        items.append(rec)
        return rec
    b = B.state_budget(doc)
    if not b:
        rec.update({"tokens": None, "overflow": None, "note": "state_budget() 返回 None"})
        items.append(rec)
        return rec
    rec.update({"tokens": b["tokens"], "room": b["room"], "spare": b["spare"],
                "overflow": bool(b["overflow"]),
                "at_risk": b.get("at_risk_fields"),
                "state_doc_keys": list(doc.keys())})
    items.append(rec)
    return rec


# ---- observable / hidden_truth：单条 state，无前文（FRESH）----
for key in ("observable", "hidden_truth"):
    _meta, cases = sets.get(key) or ({}, [])
    for c in cases:
        add(key, c["id"], "base", c["text"], FRESH)

# ---- contextual：成对 —— base(无前文) 与 with_prior(带前文) ----
_meta, ctx = sets.get("contextual") or ({}, [])
for c in ctx:
    add("contextual", c["id"], "base", c["text"], FRESH)
    prior = c.get("prior") or {}
    add("contextual", c["id"], "with_prior", c["text"],
        prior.get("decision_history") or FRESH)

# ---- 汇总 ----
miss = [r for r in items if r["cache"] == "MISS"]
over = [r for r in items if r.get("overflow")]
ok = [r for r in items if r.get("overflow") is False]

print("\n--- 翻译缓存 ---")
if miss:
    print("★ 有 %d 条输入**不在缓存里**（跑起来会触发 LLM 调用并改写缓存，破坏条件一致性）：" % len(miss))
    for r in miss:
        print("   [%s/%s/%s]" % (r["set"], r["id"], r["role"]))
else:
    print("✅ 全部命中缓存：%d 条测量项，0 缺失。" % len(items))

print("\n--- 预算 ---")
print("可测 %d 项：余量>0 的 %d 项，溢出/截断 %d 项" % (len(items) - len(miss), len(ok), len(over)))
if items:
    toks = [r["tokens"] for r in items if r.get("tokens") is not None]
    if toks:
        print("token 分布：min=%d  中位=%d  max=%d   （room=%d）"
              % (min(toks), sorted(toks)[len(toks) // 2], max(toks), room))
if over:
    print("\n★ 溢出用例（**必须从能力对比中剔除，单独列为 invalid**）：")
    for r in over:
        print("   [%s/%s/%s] tokens=%d  超 %d  最可能丢：%s"
              % (r["set"], r["id"], r["role"], r["tokens"], r["tokens"] - room,
                 "、".join(r.get("at_risk") or ["?"])))

# 上下文分组：带前文 vs 不带前文，溢出差多少 —— 这是 req.5 最关心的那类偏差
ctx_items = [r for r in items if r["set"] == "contextual" and r.get("tokens") is not None]
if ctx_items:
    base_t = [r["tokens"] for r in ctx_items if r["role"] == "base"]
    pri_t = [r["tokens"] for r in ctx_items if r["role"] == "with_prior"]
    if base_t and pri_t:
        print("\n上下文组：base 平均 %d token / 带前文平均 %d token（前文平均 +%d）"
              % (sum(base_t) / len(base_t), sum(pri_t) / len(pri_t),
                 (sum(pri_t) - sum(base_t)) / len(pri_t)))
        print("          base 溢出 %d/%d，带前文溢出 %d/%d"
              % (sum(1 for r in ctx_items if r["role"] == "base" and r["overflow"]), len(base_t),
                 sum(1 for r in ctx_items if r["role"] == "with_prior" and r["overflow"]), len(pri_t)))

out = {"model": B.DEFAULT_MODEL_NAME, "max_len": max_len, "head_max_len": head,
       "room": room, "n_items": len(items), "n_cache_miss": len(miss),
       "n_overflow": len(over), "items": items}
p = os.path.join(HERE, "budget_%s.json" % B.DEFAULT_MODEL_NAME)
with open(p, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print("\n已写入 %s" % p)
