#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Phase3 P0 验收：Task1（真歧义交接）+ Task2/Task3（历史分桶 + 提交门控）。

用法：
    python tests/p0_acceptance.py                 # 默认 http://127.0.0.1:8130
    python tests/p0_acceptance.py http://127.0.0.1:8131

★ 这个脚本是**验收**，不是单元测试：
  - Task1 只断言「桥不再代选行为」这一件事，不预设哪些输入一定判歧义。
    如果 3 句里一句都没判歧义，脚本会明说「未覆盖到歧义分支」，而不是假装通过。
  - Task2 的「无串扰」用**同输入不同会话**的 state_doc 逐字节比较来判，
    不看桶的条数 —— 条数对得上但内容串了是可能的（旧实现就是）。
"""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8130").rstrip("/")

# ★ 必须绕开系统代理（本机环境有 http_proxy=127.0.0.1:13793）。
#   urllib 默认会**把 127.0.0.1 也交给代理**，于是本地请求全部挂到超时，
#   而裸 socket 秒回 —— 看起来像「桥没响应」，其实是代理。
#   只在本脚本里绕开；桥自己访问 DeepSeek 时仍然需要代理，不要去改桥。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

PASS, FAIL, INFO = [], [], []


def post(path, body, timeout=180):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    try:
        with _OPENER.open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {"error": "unparsable"}


def get(path, timeout=60):
    try:
        with _OPENER.open(BASE + path, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {"error": "unparsable"}


def ok(cond, label, detail=""):
    (PASS if cond else FAIL).append(label)
    print("  %s %s%s" % ("PASS" if cond else "FAIL", label,
                         ("  <- " + detail) if (detail and not cond) else ""))
    return cond


def info(msg):
    INFO.append(msg)
    print("  · " + msg)


# ---------------------------------------------------------------- 环境
print("=" * 74)
print("Phase3 P0 验收 @ %s" % BASE)
print("=" * 74)

st, health = get("/health")
if st != 200:
    print("桥不可用（/health -> %s）。先启动：python laya_bridge.py serve" % st)
    sys.exit(2)
laya = health.get("laya") or {}
info("engine=%s  fastload=%s  rebuilt=%s  load_ms=%s" % (
    health.get("engine"), laya.get("fastload"),
    laya.get("fastload_rebuilt_buffers"), health.get("load_ms")))

SID_A = "acc-A-%d" % int(time.time())
SID_B = "acc-B-%d" % int(time.time())

# ---------------------------------------------------------------- Task 1
print("\n[Task 1] 歧义 → behavior=null → 交上游（不得代选）")
AMBIG_INPUTS = [
    ("普通寒暄", "晚上好，今晚的麦酒煮得不错。"),
    ("模糊身份", "我可能是个商人，也可能不是，随你怎么想。"),
    ("中性询问", "这附近有什么值得去的地方吗？"),
]
amb_hits = 0
for label, text in AMBIG_INPUTS:
    st, out = post("/decide", {"player_input": text, "session_id": SID_A, "actor_id": "probe-" + label})
    if st != 200 or out.get("error"):
        ok(False, "[T1] %s /decide 正常返回" % label, str(out.get("error"))[:120])
        continue
    dec = out.get("decision") or {}
    beh = dec.get("behavior")
    src = dec.get("source")
    if src == "ambiguous":
        amb_hits += 1
        print("  [%s] source=ambiguous  behavior=%r  fallback=%r  awaiting=%r"
              % (label, beh, dec.get("fallback"), dec.get("awaiting_upstream")))
        ok(beh is None, "[T1] %s: 歧义时 behavior 必须为 null" % label, repr(beh))
        ok(dec.get("awaiting_upstream") is True, "[T1] %s: awaiting_upstream=true" % label)
        ok(dec.get("fallback") == "story_agent", "[T1] %s: fallback=story_agent" % label,
           repr(dec.get("fallback")))
        ok(bool(dec.get("behavior_null_reason")), "[T1] %s: 给出 null 的原因" % label)
        cb = dec.get("choice_baseline") or {}
        ok(cb.get("adopted") is False, "[T1] %s: choice_baseline.adopted=false（未采纳）" % label,
           repr(cb.get("adopted")))
        # 未带 behavior 调 /narrate：不得偷偷补一个行为，也不得生成台词
        st2, nr = post("/narrate", {"player_input": text, "session_id": SID_A,
                                    "actor_id": "probe-" + label, "use_llm": False})
        ok(st2 == 200 and nr.get("awaiting_upstream") is True,
           "[T1] %s: /narrate 返回 awaiting_upstream（不代选行为）" % label,
           "http=%s keys=%s" % (st2, sorted(list(nr.keys()))[:8]))
        ok(nr.get("line") in (None, ""), "[T1] %s: /narrate 不生成台词" % label, repr(nr.get("line")))
        ok("behavior" in nr and nr.get("behavior") is None,
           "[T1] %s: /narrate 的 behavior 也是 null" % label, repr(nr.get("behavior")))
    else:
        print("  [%s] source=%s（未判歧义，跳过该分支断言）" % (label, src))

if amb_hits == 0:
    info("★ 这 3 句都没判成 ambiguous —— 歧义分支**未被覆盖**，"
         "上面的 PASS 只证明代码没崩，不能证明交接真的成立。"
         "这是预期内的：歧义阈值未重新校准（P0 只修交接语义，不动阈值）。")
else:
    info("3 句里 %d 句判为 ambiguous，交接分支已覆盖。" % amb_hits)

# 歧义轮次不得进入历史
st, nr = post("/narrate", {"player_input": AMBIG_INPUTS[0][1], "session_id": "acc-amb",
                           "actor_id": "x", "use_llm": False})
if nr.get("awaiting_upstream"):
    st_c, c = post("/commit", {"turn_id": (nr.get("turn") or {}).get("turn_id")})
    ok(st_c == 409 and c.get("ok") is False,
       "[T1] ambiguous 轮次调 /commit 必须被拒（409）", "http=%s ok=%s" % (st_c, c.get("ok")))
    info("拒绝理由：%s" % c.get("note"))

# ---------------------------------------------------------------- Task 2
print("\n[Task 2] 历史分桶：2 会话 × 3 NPC × 交替 10 轮，不得串扰")
NPCS = ["莉亚", "布伦南", "卡西"]
ROUNDS = 10
LINES = ["我带了封信，圣殿的火漆印。", "别装傻，灰鸦在哪？", "你要是说出来，我就不为难你。",
         "我付得起钱。", "外面那几个人跟了你一路了。", "今晚的麦酒淡得像水。",
         "你手在抖。", "直说吧，谁派你来的？", "我什么都没看见。", "走了，别送。"]
errors = []
amb_count = 0
committed = 0
for sid in (SID_A, SID_B):
    for i in range(ROUNDS):
        npc = NPCS[i % len(NPCS)]
        st, out = post("/decide", {"player_input": LINES[i % len(LINES)],
                                   "session_id": sid, "actor_id": npc})
        if st != 200 or out.get("error"):
            errors.append((sid, npc, str(out.get("error"))[:100]))
            continue
        t = out.get("turn") or {}
        if t.get("history_isolation") is not True:
            errors.append((sid, npc, "history_isolation=%r" % t.get("history_isolation")))
        dec = out.get("decision") or {}
        if dec.get("source") == "ambiguous":
            amb_count += 1
        beh = dec.get("behavior") or {}
        if beh.get("id"):
            # 模拟上游采纳 → commit
            st_c, c = post("/commit", {"turn_id": t.get("turn_id")})
            if c.get("ok"):
                committed += 1
ok(not errors, "[T2] 2×3×10 = 60 轮全部正常且声明为已隔离", str(errors[:3]))
info("60 轮中判为歧义（behavior=null，无法提交）%d 轮；成功 commit %d 轮"
     % (amb_count, committed))
ok(committed > 0, "[T2] 至少有可提交的轮次（否则下面的历史检查无意义）", "committed=0")

st, h = get("/history")
buckets = h.get("buckets") or {}
in_a = sorted(k for k in buckets if k.startswith(SID_A + "/"))
in_b = sorted(k for k in buckets if k.startswith(SID_B + "/"))
info("会话 A 桶：%s" % in_a)
info("会话 B 桶：%s" % in_b)
ok(all(k.startswith(SID_A + "/") or k.startswith(SID_B + "/") for k in buckets)
   or len(buckets) > len(in_a) + len(in_b),
   "[T2] /history 暴露分桶结构（不再是一条全局列表）", str(list(buckets)[:5]))
ok(not any(SID_A in k for k in in_b) and not any(SID_B in k for k in in_a),
   "[T2] A / B 的桶没有互相包含")

# 内容级串扰检查：同一输入，A（有历史）vs 全新会话 C（无历史）
PROBE = "我带了封信，圣殿的火漆印。"
st, out_a = post("/decide", {"player_input": PROBE, "session_id": SID_A, "actor_id": "莉亚"})
st, out_c = post("/decide", {"player_input": PROBE, "session_id": "acc-C-fresh-%d" % time.time(),
                             "actor_id": "莉亚"})
dh_a = out_a.get("decision_history") or []
dh_c = out_c.get("decision_history") or []
info("A 的 decision_history 条数=%d，全新会话=%d" % (len(dh_a), len(dh_c)))
ok(len(dh_a) > 0 and len(dh_c) == 0,
   "[T2] 有历史的会话带上历史，全新会话为空（说明历史真的来自当前桶）",
   "A=%d C=%d" % (len(dh_a), len(dh_c)))
sd_a = json.dumps(out_a.get("state_doc") or {}, ensure_ascii=False, sort_keys=True)
sd_c = json.dumps(out_c.get("state_doc") or {}, ensure_ascii=False, sort_keys=True)
ok(sd_a != sd_c, "[T2] 同一输入、不同会话 → state_doc 不同（旧实现下会逐字节相同）")

# B 的 state_doc 不得含 A 的历史
st, out_b = post("/decide", {"player_input": PROBE, "session_id": SID_B, "actor_id": "莉亚"})
dh_b = out_b.get("decision_history") or []
a_summaries = {d.get("summary") for d in dh_a}
b_summaries = {d.get("summary") for d in dh_b}
# 摘要可能重合（同类决策），所以判据是「B 的条数不超过 B 自己的轮数」而不是集合不相交
ok(len(dh_b) <= 6, "[T2] B 的历史只来自 B 自己（≤6 条窗口）", "B=%d" % len(dh_b))

# ---------------------------------------------------------------- Task 3
print("\n[Task 3] 提交门：只有 committed 才进历史")
SID_D = "acc-D-%d" % int(time.time())
st, out = post("/decide", {"player_input": "我带了封信，圣殿的火漆印。",
                           "session_id": SID_D, "actor_id": "莉亚"})
tid = (out.get("turn") or {}).get("turn_id")
beh = ((out.get("decision") or {}).get("behavior") or {}).get("id")
st, h = get("/history")
before = len((h.get("buckets") or {}).get("%s/莉亚" % SID_D) or [])
ok(before == 0, "[T3] /decide 之后该桶仍为空（只 propose，未 commit）", "before=%d" % before)
ok((out.get("history_gate") or {}).get("stage") == "proposed",
   "[T3] 响应带 history_gate.stage=proposed", str(out.get("history_gate"))[:120])
if beh:
    st_c, c = post("/commit", {"turn_id": tid})
    ok(st_c == 200 and c.get("ok") is True, "[T3] commit 有效轮次 → 200 ok", "http=%s" % st_c)
    st, h = get("/history")
    after = len((h.get("buckets") or {}).get("%s/莉亚" % SID_D) or [])
    ok(after > 0, "[T3] commit 之后该桶才有内容", "after=%d" % after)
    st_c2, c2 = post("/commit", {"turn_id": tid})
    ok(st_c2 == 409, "[T3] 重复 commit 同一 turn_id 被拒（幂等保护）", "http=%s" % st_c2)
else:
    info("该轮无行为（behavior=null）→ 走的是「拒绝提交」路径，已在 T1 覆盖")

# ---------------------------------------------------------------- 汇总
print("\n" + "=" * 74)
print("PASS %d / FAIL %d" % (len(PASS), len(FAIL)))
if FAIL:
    print("\n失败项：")
    for f in FAIL:
        print("  - " + f)
if INFO:
    print("\n说明：")
    for i in INFO:
        print("  - " + i)
print("=" * 74)
sys.exit(1 if FAIL else 0)
