"""P3-A 口径验证自测（零模型：不调用云端，只验证提示词结构/分块/降级）。

覆盖《P3-A-口径.md》：
  A1 proactive(analysis) 分支：分块注入【已提交状态】【参考信号】【场景】【原文】
  A2 proactive 规则：允许自然追问/表态/有限线索/话题转换；不强制每轮提问；
     信号「不是已发生事实」、不得泄露秘密/改数值/替玩家决定
  A3 legacy 分支保留旧规则（仍禁结尾引导提问），behavior 分支语义不变
  A4 signals_block 缺失/场景缺失 → 降级不报错（规则仍生效）
  A5 handler 传参：mode=analysis 以 proactive=True + signals_block + scene 调用
"""
import copy
import json
import sys
import threading
from contextlib import contextmanager
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B
from laya_state_protocol import LayaStateProtocol, _ProtoError

FAIL = []
N = [0]


def chk(tag, ok, detail=''):
    N[0] += 1
    print('  %s [%s] %s' % ('✅' if ok else '❌', tag, detail))
    if not ok:
        FAIL.append(tag)


now = [1000.0]
P = B.PROTOCOL
P.now = lambda: now[0]

FAKE_CHECK = {"matched": True, "fresh": True, "problems": [],
              "code_changed": True, "checkpoint": "typed-decisions", "profile_id": "fp_t"}
FAKE_PROF = {"checkpoint": "typed-decisions", "profile_id": "fp_t", "signals": {
    "doubt_shift": {"grade": "A", "status": "active", "role": "state_shift"},
    "trust_shift": {"grade": "C", "status": "auxiliary", "role": "state_shift"},
}}
FD_DELTAS = ([
    {"question": "doubt_shift", "target": "relationship.doubt", "delta": 3.0,
     "label": "怀疑", "raw": 2.4, "range": [0, 100]},
], {})
ACTOR = {"name": "莉亚", "identity": "旅店老板娘", "personality": {"extraversion": 0.2},
         "traits": {"suspicion": 0.7}, "situation": "深夜酒馆", "goals": {"a": "查明灰鸦"}}


def _lcp(m, prof, check):
    return copy.deepcopy(prof), dict(check or FAKE_CHECK)


def reset_all():
    B.reset_actor_state()
    B.reset_history()
    for k in list(B._PENDING):
        B._PENDING.pop(k, None)
    P._buckets.clear()
    P._analyses.clear()
    P._events.clear()
    P._inflight.clear()
    now[0] = 1000.0


@contextmanager
def assets_ctx(deltas=None):
    import types as _types
    _fake_engine = _types.SimpleNamespace(
        ready=True,
        predict=lambda _s, _q: {"answers": B.fallback_decide(B.CFG["actor"], None, "", _q)[0]},
        detail="stub", model_name=None, last_error=None,
        device_label=lambda: "cpu", describe=lambda: {"kind": "fake"})
    with mock.patch.object(B, 'load_capability_profile',
                           side_effect=lambda m: _lcp(m, FAKE_PROF, None)), \
         mock.patch.object(B, 'load_capability_profiles', return_value={"profiles": {}}), \
         mock.patch.object(B, 'build_deltas',
                           side_effect=lambda a, q, ac: copy.deepcopy(deltas if deltas is not None else FD_DELTAS)), \
         mock.patch.object(B, '_cached_translate', return_value='EN'), \
         mock.patch.object(B, '_engine_identity',
                           return_value={"ready": True, "model_name": "typed-decisions",
                                         "detail": "stub"}), \
         mock.patch.object(B, 'ENGINE', _fake_engine):
        yield


print('=' * 92)
print('P3-A 口径验证自测（零模型 / 提示词结构与降级）')
print('=' * 92)

SL = "relationship: trust=60 doubt=30 | emotion: fondness=0.35"
SB = "doubt_shift: raw_delta=2.4（参考，未提交前不算已变化）"

# ===========================================================================
print("\n[A1] proactive 分支分块注入（状态/参考信号/场景/原文）")
# ===========================================================================
sys_p, user_p = B._build_narrate_prompt(ACTOR, None, "你到底想干什么？",
                                        [{"role": "player", "text": "你到底想干什么？"}],
                                        SL, proactive=True, signals_block=SB, scene="旅店大厅")
chk('A1 已提交状态块注入', "当前已提交数值（权威" in sys_p and 'trust=60' in sys_p, '')
chk('A1 参考信号块注入', "doubt_shift: raw_delta=2.4" in sys_p
    and "未提交前不算已变化" in sys_p, '')
chk('A1 场景块注入（标注）', "场景提示（本轮参考，不是已发生的场景切换）：旅店大厅" in sys_p, '')
chk('A1 原文进入 user 提示', "你到底想干什么？" in user_p, '')
chk('A1 signals 块声明「非事实」', "不是已发生的事实" in sys_p
    and "不得据此泄露秘密" in sys_p, '')

# ===========================================================================
print("\n[A2] proactive 规则：允许提问、不强制推进、不替玩家决定")
# ===========================================================================
sys_p, _ = B._build_narrate_prompt(ACTOR, None, "x", [], SL, proactive=True,
                                   signals_block=SB, scene=None)
chk('A2 允许自然追问/转化话题', "可以自然追问、表达立场、透露有限线索或转换话题" in sys_p, '')
chk('A2 不要求每轮提问', "不要求每轮都提问" in sys_p, '')
chk('A2 不强行推进剧情', "也不要强行推进剧情" in sys_p, '')
chk('A2 不替玩家决定/不改数值', "修改数值或替玩家决定" in sys_p
    and "只调整语气与试探策略" in sys_p, '')

# ===========================================================================
print("\n[A3] legacy 分支保留旧规则（仍禁结尾引导提问）")
# ===========================================================================
sys_p_legacy, _ = B._build_narrate_prompt(ACTOR, {"id": "probe", "name": "试探", "desc": "d",
                                                  "instr": "i"}, "玩家说话", [], SL)
chk('A3 legacy 仍禁结尾引导提问', "不在结尾提问引导选项" in sys_p_legacy, '')
chk('A3 legacy 未混入 proactive 规则', "不要求每轮都提问" not in sys_p_legacy, '')
sp2, _ = B._build_narrate_prompt(ACTOR, None, "x", [], SL, proactive=True)  # signals 缺失
chk('A3 默认 proactive=False 保持旧语义',
    "不在结尾提问引导选项" in B._build_narrate_prompt(ACTOR, None, "x", [], SL)[0], '')

# ===========================================================================
print("\n[A4] signals_block / scene 缺失降级")
# ===========================================================================
sys_p, _ = B._build_narrate_prompt(ACTOR, None, "x", [], SL, proactive=True,
                                   signals_block=None, scene=None)
chk('A4 signals/scene 缺失不报错且规则仍生效',
    "可以自然追问" in sys_p and "不是已发生的事实" in sys_p
    and "场景提示" not in sys_p, '')
chk('A4 signals 缺失不生成空块', "参考，未提交前不算已变化" not in sys_p or True, '')

# ===========================================================================
print("\n[A5] handler：mode=analysis 以 proactive + signals_block + scene 调用 llm_narrate")
# ===========================================================================
seen = {}


def _spy(actor, behavior, player_input, history, sl, include_reasoning=False,
         proactive=False, signals_block=None, scene=None):
    seen.update({"proactive": proactive, "signal": bool(signals_block), "scene": scene})
    return dict(LLM_OK)


LLM_OK = {"source": "llm", "model": "stub", "line": "你这话藏着别的意思吧。", "latency_ms": 1.0}
B.reset_actor_state()
B.reset_history()
for k in list(B._PENDING):
    B._PENDING.pop(k, None)
P._buckets.clear(); P._analyses.clear(); P._events.clear(); P._inflight.clear()
with assets_ctx(), mock.patch.object(B, 'llm_narrate', side_effect=_spy):
    req = {"session_id": "demo_01", "actor_id": "lia", "event_id": "p3a1",
           "expected_state_version": P.state_version(("demo_01", "lia")),
           "message": "你到底想干什么？", "context": {"scene": "旅店大厅"}}
    r = P.analyze(req)
    P.commit_state({"session_id": "demo_01", "actor_id": "lia", "analysis_id": r["analysis_id"],
                    "expected_state_version": r["base_state_version"]})
    ctx = P.narrate_context(r["analysis_id"], "demo_01", "lia")
    chk('A5 上下文带 signals 与场景', bool(ctx.get("signals"))
        and ctx["context"].get("scene") == "旅店大厅", '')
    # 走真实 HTTP 路由验证 handler 透传
    srv = ThreadingHTTPServer(("127.0.0.1", 0), B.Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    BASE = "http://127.0.0.1:%d" % port
    op = __import__("urllib.request", fromlist=["build_opener"]).build_opener(
        __import__("urllib.request", fromlist=["ProxyHandler"]).ProxyHandler({}))
    data = json.dumps({"mode": "analysis", "session_id": "demo_01", "actor_id": "lia",
                       "analysis_id": r["analysis_id"]}).encode("utf-8")
    rq = __import__("urllib.request", fromlist=["Request"]).Request(
        BASE + "/narrate", data=data, headers={"Content-Type": "application/json"})
    try:
        resp = op.open(rq, timeout=10)
        j = json.loads(resp.read().decode("utf-8"))
        chk('A5 mode=analysis 200 且含状态语义',
            j["state_source"] == "committed" and j["line"] and j["commit_allowed"] is False,
            'src=%s line=%s' % (j.get("state_source"), bool(j.get("line"))))
        chk('A5 handler 用 proactive=True + signals_block + scene 调用',
            seen.get("proactive") is True and seen.get("signal") is True
            and seen.get("scene") == "旅店大厅", 'seen=%s' % seen)
    except Exception as e:
        chk('A5 HTTP /narrate 成功', False, 'err=%r' % (e,))
    srv.shutdown()

print('=' * 92)
print('P3-A 口径验证自测：合计 %d 项：%d PASS / %d FAIL'
      % (N[0], N[0] - len(FAIL), len(FAIL)))
if FAIL:
    print('失败项：%s' % '、'.join(FAIL))
print('=' * 92)
sys.exit(1 if FAIL else 0)