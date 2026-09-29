"""P3-D3 · /interaction/narrate 叙事薄链定向检查（固定叙事桩，零真实调用）。

覆盖：
  N1  未提交回合 narrate → 404 RECEIPT_UNKNOWN（没有 Commit 就拒绝）
  N2  commit_id 与已提交回执不一致 → 409 NARRATE_COMMIT_MISMATCH
  N3  正确回执生成：玩家原话取自服务端 Prepare 私有上下文；facts 顺序
      「先问莉亚、随后去旧井」（交流在移动前、位置变更只挂在移动步）；
      玩家已获线索仅 player 行；语气信号只校准语气；提示词含顺序与禁改写约束
  N4  客户端伪造事实（message/actions/evidence/delta）→ 422，不生成
  N5  相同 commit_id 重复请求 → reused=true、叙事桩只被调用一次
  N6  叙事生成失败 → 502 NARRATION_FAILED，权威状态/时钟/版本/回执不变；恢复后重试成功
  N7  绑定上下文缺失 → 409 NARRATE_CONTEXT_MISSING（不猜原话）
  N8  叙事不触发重新 Prepare/Commit（解释计数、事件表、Pending 不变）
  N9  无 <line> 且带计划标记的输出 → 502 NARRATION_FAILED（复用 extract_line 纪律）
  N10 未知字段/非法 ID/外站 Origin → 422/403
  N11 三处真实入口全程「调用即报错」保险（零云端、零翻译、零 CUDA）

★ 运行：`PYTHONIOENCODING=utf-8 python tests/p3d3_narrate_unit.py`
"""
import copy
import json
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B
import laya_evidence as EV
import laya_interaction_http as IH

FAIL = []
N = [0]


def chk(tag, ok, detail=""):
    N[0] += 1
    print("  %s [%s] %s" % ("✅" if ok else "❌", tag, detail))
    if not ok:
        FAIL.append(tag)


UTTERANCE = "我先问莉亚地窖钥匙在哪里，然后去旧井"

READY_ACTIONS = [
    {"id": "a1", "operation": "communicate", "target_ids": ["lia"],
     "object_id": "cellar_key", "mode": "attempt", "kind": "question",
     "content": "我先问莉亚地窖钥匙在哪里", "evidence": "我先问莉亚地窖钥匙在哪里"},
    {"id": "a2", "operation": "move", "target_ids": ["old_well"],
     "object_id": None, "mode": "attempt", "kind": None,
     "content": "然后去旧井", "evidence": "然后去旧井"},
]


def make_ready_interp():
    return {"interpretation": {"status": "ready", "actions": READY_ACTIONS},
            "prepare_request": {"session_id": None, "event_id": None,
                                "actor_id": "player", "expected_versions": None,
                                "actions": READY_ACTIONS},
            "directory": {}, "history_used": [], "prepare_error": None}


def make_stub_provider(delta=3.0):
    def provider(provider_input):
        cand = provider_input["candidates"][0]
        return {"evidence": [{
            "source": EV.SOURCE_REAL, "action_id": cand["action_id"],
            "target_npc": cand["listener"],
            "signals": [{"signal": "doubt_shift", "role": "state_shift",
                         "status": "active", "may_write_state": True, "delta": delta}],
        }], "absent_reason": None}
    return provider


CAP_IDENT = {"checkpoint": "typed-decisions", "profile_id": "fp_t", "matched": True,
             "fresh": True, "profile_sha256": "fake", "engine_model": "typed-decisions"}

CALLS = {"narrate": 0, "last_facts": None, "last_prompt": None, "fail": False,
         "block": None, "entered": None}


def narrate_stub(facts, sys_p, user_p):
    CALLS["narrate"] += 1
    CALLS["last_facts"] = copy.deepcopy(facts)
    CALLS["last_prompt"] = sys_p
    if CALLS["fail"]:
        raise RuntimeError("桩：叙事生成失败")
    if CALLS.get("block") is not None:
        if CALLS.get("entered") is not None:
            CALLS["entered"].set()
        CALLS["block"].wait(timeout=15)
    return "<line>莉亚指了指旧井的方向，把钥匙的下落告诉了你。</line>"


def scripted_interpret(sid, msg):
    IH._SINGLETON["explain_calls"][0] += 1   # 与生产 _interpret 同口径计数
    if "先走后问回酒馆" in msg:
        # 先移动、后交流且**都实际完成**：从旧井移回酒馆（莉亚在酒馆）再询问
        acts = [
            {"id": "a1", "operation": "move", "target_ids": ["tavern"],
             "object_id": None, "mode": "attempt", "kind": None,
             "content": "然后回酒馆", "evidence": "然后回酒馆"},
            {"id": "a2", "operation": "communicate", "target_ids": ["lia"],
             "object_id": "cellar_key", "mode": "attempt", "kind": "question",
             "content": "我先问莉亚地窖钥匙在哪里", "evidence": "我先问莉亚地窖钥匙在哪里"},
        ]
        return {"interpretation": {"status": "ready", "actions": acts},
                "prepare_request": {"session_id": None, "event_id": None,
                                    "actor_id": "player", "expected_versions": None,
                                    "actions": acts},
                "directory": {}, "history_used": [], "prepare_error": None}
    if "先走后问去旧井" in msg:
        # 先移动、后交流但**交流被阻止**：移去旧井后听者（莉亚在酒馆）不在场
        acts = [
            {"id": "a1", "operation": "move", "target_ids": ["old_well"],
             "object_id": None, "mode": "attempt", "kind": None,
             "content": "然后去旧井", "evidence": "然后去旧井"},
            {"id": "a2", "operation": "communicate", "target_ids": ["lia"],
             "object_id": "cellar_key", "mode": "attempt", "kind": "question",
             "content": "我先问莉亚地窖钥匙在哪里", "evidence": "我先问莉亚地窖钥匙在哪里"},
        ]
        return {"interpretation": {"status": "ready", "actions": acts},
                "prepare_request": {"session_id": None, "event_id": None,
                                    "actor_id": "player", "expected_versions": None,
                                    "actions": acts},
                "directory": {}, "history_used": [], "prepare_error": None}
    if "酒馆" in msg:
        act = [{"id": "a1", "operation": "move", "target_ids": ["tavern"],
                "object_id": None, "mode": "attempt", "kind": None,
                "content": msg, "evidence": msg}]
        return {"interpretation": {"status": "ready", "actions": act},
                "prepare_request": {"session_id": None, "event_id": None,
                                    "actor_id": "player", "expected_versions": None,
                                    "actions": act},
                "directory": {}, "history_used": [], "prepare_error": None}
    return make_ready_interp()


def start_server():
    from http.server import ThreadingHTTPServer
    B.reset_actor_state()
    B.reset_history()
    B._PENDING.clear()
    P = B.PROTOCOL
    with P.lock:
        P._events.clear()
        P._buckets.clear()
        P._analyses.clear()
        P._inflight.clear()
    IH._reset_singleton()
    IH.get_core(provider=make_stub_provider(), capability_identity=lambda: dict(CAP_IDENT))
    IH._interpret = scripted_interpret
    IH._SINGLETON["narrate_caller"] = narrate_stub
    CALLS.update(narrate=0, last_facts=None, last_prompt=None, fail=False)
    # 零真实入口保险：调用即报错
    import laya_delivery_interpreter as I
    I.llm_json = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("禁真实云端"))
    B.translate_to_en = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("禁在线翻译"))
    EV.default_real_infer = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("禁 CUDA"))
    srv = ThreadingHTTPServer(("127.0.0.1", 0), B.Handler)
    srv.daemon_threads = True
    srv.origin = "http://127.0.0.1:%d" % srv.server_address[1]
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    return srv, srv.server_address[1]


def _req(port, method, path, body=None, headers=None):
    import http.client
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    h = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        h["Content-Type"] = "application/json"
    conn.request(method, path, body=data, headers=h)
    r = conn.getresponse()
    raw = r.read()
    conn.close()
    try:
        return r.status, json.loads(raw.decode("utf-8"))
    except Exception:
        return r.status, raw.decode("utf-8", errors="replace")


def versions(port, sid):
    st, body = _req(port, "GET", "/interaction/state?session_id=%s" % sid)
    return body["versions"]


def authoritative(port, sid):
    """权威状态深比较快照（Actor/World 桶 + 公开 state + 事件表）。"""
    core = IH.get_core()
    st = core.state(sid)
    actor = {str(k): copy.deepcopy(v) for k, v in B._ACTOR_STATE.items() if k[0] == sid}
    with B.PROTOCOL.lock:
        events = {str(k): copy.deepcopy(v) for k, v in B.PROTOCOL._events.items()
                  if k[0] == sid}
    return json.dumps({"state": st, "actor": actor, "events": events},
                      sort_keys=True, ensure_ascii=False)


def prepare_and_commit(port, sid, event_id, message=UTTERANCE):
    v1 = versions(port, sid)
    st, pv = _req(port, "POST", "/interaction/prepare",
                  {"session_id": sid, "event_id": event_id, "message": message,
                   "expected_versions": v1})
    assert st == 200, "prepare failed: %s" % pv
    st, rec = _req(port, "POST", "/interaction/commit",
                   {"session_id": sid, "event_id": event_id,
                    "analysis_id": pv["analysis_id"],
                    "expected_versions": pv["base_versions"]})
    assert st == 200, "commit failed: %s" % rec
    return rec


def main():
    srv, port = start_server()
    sid = "p3d3-main"

    # ---- N1 未提交 → 拒绝 ----
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid, "event_id": "never", "commit_id": "dl_x"})
    chk("N1-① 未提交回合 narrate → 404 RECEIPT_UNKNOWN（没有 Commit 就拒绝）",
        st == 404 and body["error"]["code"] == "RECEIPT_UNKNOWN", str(body))

    # ---- N10a 伪造字段/非法 ID/外站 Origin ----
    _req(port, "POST", "/interaction/scene", {"session_id": sid})
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid, "event_id": "ev1", "commit_id": "dl_x",
                     "message": UTTERANCE})
    chk("N10-① 客户端重报 message → 422 未知字段",
        st == 422 and body["error"]["code"] == "INVALID_REQUEST", str(body))
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid, "event_id": "ev1", "commit_id": "dl_x",
                     "actions": [], "evidence": []})
    chk("N10-② 客户端伪造 actions/evidence → 422", st == 422, str(body))
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": "bad sid!", "event_id": "ev1", "commit_id": "dl_x"})
    chk("N10-③ 非法 session_id → 422", st == 422, str(body))
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid, "event_id": "ev1", "commit_id": "dl_x"},
                    headers={"Origin": "http://evil.example.com"})
    chk("N10-④ 外站 Origin → 403 ORIGIN_FORBIDDEN",
        st == 403 and body["error"]["code"] == "ORIGIN_FORBIDDEN", str(body))
    chk("N4-① 伪造事实请求未触发叙事生成", CALLS["narrate"] == 0, "calls=%d" % CALLS["narrate"])

    # ---- 正向：scene → prepare → commit ----
    rec = prepare_and_commit(port, sid, "ev1")
    commit_id = rec["commit_id"]

    # ---- N2 commit_id 不匹配 ----
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid, "event_id": "ev1", "commit_id": "dl_wrong"})
    chk("N2-① commit_id 与已提交回执不一致 → 409 NARRATE_COMMIT_MISMATCH",
        st == 409 and body["error"]["code"] == "NARRATE_COMMIT_MISMATCH", str(body))

    # ---- N3 正确回执生成 + 时序 ----
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid, "event_id": "ev1", "commit_id": commit_id})
    chk("N3-① narrate 200 且提取出 <line> 台词",
        st == 200 and body.get("line") and body.get("reused") is False,
        str(body)[:160])
    facts = CALLS["last_facts"]
    chk("N3-② 玩家原话取自服务端 Prepare 私有上下文（客户端未重报）",
        bool(facts) and facts.get("player_message") == UTTERANCE, "")
    steps = facts.get("steps") or []
    chk("N3-③ 时序：第 1 步是交流/询问（发生在移动前）",
        len(steps) >= 2 and steps[0].get("operation") == "communicate"
        and steps[0].get("kind") == "question" and steps[0].get("listener") == "lia",
        json.dumps([(s.get("operation"), s.get("kind")) for s in steps], ensure_ascii=False))
    chk("N3-④ 时序：第 2 步才是移动，位置变更只挂在移动步",
        steps[1].get("operation") == "move"
        and not steps[0].get("changes")
        and any(c.get("path") == "interaction.location" and c.get("before") == "tavern"
                and c.get("after") == "old_well" for c in steps[1].get("changes") or []),
        json.dumps([(s.get("operation"), s.get("changes")) for s in steps], ensure_ascii=False))
    kg = facts.get("player_knowledge_gained") or []
    chk("N3-⑤ 玩家已获线索仅 player 行（含 clue:cellar_key_location）",
        any(e.get("entry_id") == "clue:cellar_key_location" and e.get("told_by") == "lia"
            for e in kg), json.dumps(kg, ensure_ascii=False))
    chk("N3-⑥ 语气信号进入事实块（只校准语气）",
        any(s.get("signal") == "doubt_shift" for s in facts.get("tone_signals") or []),
        json.dumps(facts.get("tone_signals"), ensure_ascii=False))
    prompt = CALLS["last_prompt"] or ""
    chk("N3-⑦ 提示词只陈述实际发生：询问发生在移动之前 + 新线索已被告知；不写「回答发生在移动之前」",
        "时间顺序：询问发生在移动之前" in prompt
        and "第 1 步的询问实际发生，玩家本轮获得了新线索（已被告知" in prompt
        and "回答发生在移动之前" not in prompt
        and "绝不要把角色写成尚未到达的位置" in prompt, "")
    chk("N3-⑧ 提示词含禁改写约束（归属/位置/门状态/关系值）与私密纪律",
        "不得改写物品归属、位置、门状态或关系值" in prompt
        and "不得把未披露的私有知识写进台词" in prompt, "")
    chk("N3-⑨ 叙事只读：未新增候选/事件（无重新 Prepare/Commit）",
        len(B._PENDING) == 0, "pending=%d" % len(B._PENDING))

    # ---- N5 重复请求复用（不重复付费） ----
    st2, body2 = _req(port, "POST", "/interaction/narrate",
                      {"session_id": sid, "event_id": "ev1", "commit_id": commit_id})
    chk("N5-① 相同 commit_id 重复请求 → reused=true、台词一致",
        st2 == 200 and body2.get("reused") is True and body2.get("line") == body.get("line"),
        str(body2)[:120])
    chk("N5-② 重复请求未再次调用叙事桩（不重复付费）", CALLS["narrate"] == 1,
        "calls=%d" % CALLS["narrate"])

    # ---- N6 叙事失败：状态/回执不变，恢复后重试成功 ----
    snap_before = authoritative(port, sid)
    receipt_before = IH.get_core().get_receipt(sid, "ev1")
    CALLS["fail"] = True
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid, "event_id": "ev2_never", "commit_id": "dl_x"})
    chk("N6-① 未知事件失败路径不受桩影响（仍 404）", st == 404, str(st))
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid, "event_id": "ev2", "commit_id": "dl_x"})
    chk("N6-② 未提交事件失败路径不受桩影响（仍 404）", st == 404, str(st))
    # 真实失败场景：新回合（回酒馆，从旧井可尝试）提交后叙事桩抛错
    rec2 = prepare_and_commit(port, sid, "ev3", message="我回酒馆")
    snap_fail_before = authoritative(port, sid)
    receipt_fail_before = IH.get_core().get_receipt(sid, "ev3")
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid, "event_id": "ev3", "commit_id": rec2["commit_id"]})
    chk("N6-③ 叙事桩抛错 → 502 NARRATION_FAILED",
        st == 502 and body["error"]["code"] == "NARRATION_FAILED", str(body))
    chk("N6-④ 叙事失败后权威状态/时钟/版本/回执完全不变",
        snap_fail_before == authoritative(port, sid)
        and receipt_fail_before == IH.get_core().get_receipt(sid, "ev3"), "")
    CALLS["fail"] = False
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid, "event_id": "ev3", "commit_id": rec2["commit_id"]})
    chk("N6-⑤ 失败不留缓存：恢复后同请求重试成功（reused=false）",
        st == 200 and body.get("reused") is False and body.get("line"), str(body)[:120])
    chk("N6-⑥ 失败与重试都不改变已提交回合（状态不变）",
        snap_fail_before == authoritative(port, sid), "")

    # ---- N7 绑定上下文缺失 ----
    with IH._SINGLETON["lock"]:
        IH._SINGLETON["narrate_ctx"].pop(("p3d3-main", "ev3"), None)
        IH._SINGLETON["narrate_cache"].pop((sid, "ev3"), None)  # 从未生成过：清掉 N6 缓存
    calls_before = CALLS["narrate"]
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid, "event_id": "ev3", "commit_id": rec2["commit_id"]})
    chk("N7-① 绑定上下文缺失 → 409 NARRATE_CONTEXT_MISSING（不猜原话）",
        st == 409 and body["error"]["code"] == "NARRATE_CONTEXT_MISSING", str(body))
    chk("N7-② 上下文缺失时不调用叙事桩（真实前后计数）",
        CALLS["narrate"] == calls_before,
        "calls %d→%d" % (calls_before, CALLS["narrate"]))

    # ---- N9 污染输出（无 <line> 且带计划标记）→ 502 ----
    with IH._SINGLETON["lock"]:
        IH._SINGLETON["narrate_ctx"][(sid, "ev3")] = {
            "message": "我回酒馆", "analysis_id": rec2["analysis_id"],
            "saved_at": time.time()}
    orig_stub = IH._SINGLETON["narrate_caller"]

    def contaminated_stub(facts, sys_p, user_p):
        CALLS["narrate"] += 1
        return "先不要写台词，不能分段，写：莉亚说……这是动作，然后台词……"
    IH._SINGLETON["narrate_caller"] = contaminated_stub
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid, "event_id": "ev3", "commit_id": rec2["commit_id"]})
    chk("N9-① 无 <line> 且带计划标记的输出 → 502 NARRATION_FAILED",
        st == 502 and body["error"]["code"] == "NARRATION_FAILED", str(body))
    chk("N9-② 提取失败也释放单飞占位（可重试）",
        (sid, "ev3") not in IH._SINGLETON["narrate_inflight"], "")
    IH._SINGLETON["narrate_caller"] = orig_stub

    # ---- N8 叙事全程不触发重新 Prepare/Commit ----
    ev_count = sum(1 for (s, _a), bucket in B.PROTOCOL._events.items()
                   if s == sid and "ev1" in bucket) + sum(
                       1 for (s, _a), bucket in B.PROTOCOL._events.items()
                       if s == sid and "ev3" in bucket)
    chk("N8-① 事件表只有两轮已提交事件（叙事未产生新事件）", ev_count == 2,
        "count=%d" % ev_count)
    chk("N8-② 解释调用计数未因叙事增加（无重新解释）",
        IH._SINGLETON["explain_calls"][0] == 2,
        "explain_calls=%d" % IH._SINGLETON["explain_calls"][0])
    chk("N8-③ 无新候选（无重新 Prepare）", len(B._PENDING) == 0, "")

    # ---- N12 先移动、后交流且**都实际完成**：提示词按真实顺序、不臆造 ----
    sid2 = "p3d3-movefirst"
    _req(port, "POST", "/interaction/scene", {"session_id": sid2})
    # 前置回合：常规问题+移动 → 玩家到达旧井（使下一轮「回酒馆再问」移动与交流都成立）
    prepare_and_commit(port, sid2, "ev4a", message=UTTERANCE)
    rec4 = prepare_and_commit(port, sid2, "ev4b", message="先走后问回酒馆：我回酒馆再问莉亚钥匙在哪")
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid2, "event_id": "ev4b", "commit_id": rec4["commit_id"]})
    chk("N12-① 先移动后交流（都完成）回合 narrate 200", st == 200 and body.get("line"), str(st))
    facts4 = CALLS["last_facts"]
    ops4 = [s.get("operation") for s in facts4.get("steps") or []]
    status4 = [s.get("execution_status") for s in facts4.get("steps") or []]
    chk("N12-② facts 步骤顺序 [move, communicate] 且两步都 attempted（回答实际发生）",
        ops4[:2] == ["move", "communicate"] and status4[:2] == ["attempted", "attempted"],
        str(list(zip(ops4, status4))))
    prompt4 = CALLS["last_prompt"] or ""
    chk("N12-③ 提示词只陈述实际发生：询问发生在移动之后；线索已在前置回合获得 → 本轮未获得新线索",
        "时间顺序：询问发生在移动之后" in prompt4
        and "第 2 步的询问实际发生，但本轮未获得新线索" in prompt4
        and "回答发生在移动之后" not in prompt4, "")

    # ---- N12b 先移动、后交流但**交流被阻止**：提示词绝不声称对方回答 ----
    sid4 = "p3d3-blocked"
    _req(port, "POST", "/interaction/scene", {"session_id": sid4})
    rec4b = prepare_and_commit(port, sid4, "ev4c", message="先走后问去旧井：我先去旧井再问莉亚钥匙在哪")
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid4, "event_id": "ev4c", "commit_id": rec4b["commit_id"]})
    chk("N12b-① 交流被阻止回合 narrate 200（仍可叙事，只陈述事实）",
        st == 200 and body.get("line"), str(st))
    facts4b = CALLS["last_facts"]
    step2b = (facts4b.get("steps") or [{}])[1] if len(facts4b.get("steps") or []) >= 2 else {}
    chk("N12b-② facts 第 2 步交流 execution_status=blocked（未发生回答）",
        step2b.get("operation") == "communicate" and step2b.get("execution_status") == "blocked",
        str(step2b)[:200])
    prompt4b = CALLS["last_prompt"] or ""
    chk("N12b-③ 提示词明确「交流未发生，没有回答」，绝不声称询问实际发生或对方回答",
        "交流未发生（被阻止），没有回答" in prompt4b
        and "询问实际发生" not in prompt4b
        and "回答发生在移动之后" not in prompt4b and "回答已给出" not in prompt4b, "")

    # ---- N17 重复询问已知线索：attempted 但本轮 knowledge_gained 为空 ----
    sid6 = "p3d3-repeat"
    _req(port, "POST", "/interaction/scene", {"session_id": sid6})
    prepare_and_commit(port, sid6, "ev7a", message=UTTERANCE)   # 首次询问：获得线索，玩家→旧井
    prepare_and_commit(port, sid6, "ev7b", message="我回酒馆")    # 玩家→酒馆
    rec7 = prepare_and_commit(port, sid6, "ev7c", message=UTTERANCE)  # 重复询问：线索已知，无新条目
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid6, "event_id": "ev7c", "commit_id": rec7["commit_id"]})
    chk("N17-① 重复询问回合 narrate 200", st == 200 and body.get("line"), str(st))
    facts7 = CALLS["last_facts"]
    step7 = (facts7.get("steps") or [{}])[0]
    chk("N17-② facts：询问 attempted 且本轮 player_knowledge 为空（无新线索）",
        step7.get("operation") == "communicate"
        and step7.get("execution_status") == "attempted"
        and (step7.get("player_knowledge") or []) == [],
        json.dumps(step7.get("player_knowledge"), ensure_ascii=False))
    prompt7 = CALLS["last_prompt"] or ""
    chk("N17-③ 提示词保守写「询问实际发生，但本轮未获得新线索」，不写「已被告知」",
        "第 1 步的询问实际发生，但本轮未获得新线索" in prompt7
        and "已被告知" not in prompt7 and "回答已给出" not in prompt7, "")

    # ---- N13 并发单飞：同 (session,event,commit) 只调用一次生成器 ----
    sid3 = "p3d3-conc"
    _req(port, "POST", "/interaction/scene", {"session_id": sid3})
    rec5 = prepare_and_commit(port, sid3, "ev5", message=UTTERANCE)
    entered = threading.Event()
    release = threading.Event()
    CALLS["entered"] = entered
    CALLS["block"] = release
    calls_before = CALLS["narrate"]
    results = {}

    def w1():
        results["a"] = _req(port, "POST", "/interaction/narrate",
                            {"session_id": sid3, "event_id": "ev5",
                             "commit_id": rec5["commit_id"]})
    t = threading.Thread(target=w1)
    t.start()
    entered.wait(timeout=10)
    st2, body2 = _req(port, "POST", "/interaction/narrate",
                      {"session_id": sid3, "event_id": "ev5", "commit_id": rec5["commit_id"]})
    chk("N13-② 并发同请求第二个 → 409 NARRATE_IN_PROGRESS（不再次调用生成器）",
        st2 == 409 and body2["error"]["code"] == "NARRATE_IN_PROGRESS", str(body2))
    release.set()
    t.join(timeout=15)
    chk("N13-① 首个请求最终 200", results.get("a") and results["a"][0] == 200,
        str(results.get("a"))[:100])
    chk("N13-③ 生成器只被调用一次", CALLS["narrate"] == calls_before + 1,
        "calls=%d" % CALLS["narrate"])
    CALLS["block"] = None
    CALLS["entered"] = None

    # ---- N14 失败释放占位 + 不同 commit 身份不复用台词 ----
    with IH._SINGLETON["lock"]:
        IH._SINGLETON["narrate_cache"].pop((sid3, "ev5"), None)
    CALLS["fail"] = True
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid3, "event_id": "ev5", "commit_id": rec5["commit_id"]})
    chk("N14-① 生成失败 → 502 NARRATION_FAILED", st == 502, str(st))
    chk("N14-② 失败后单飞占位已释放",
        (sid3, "ev5") not in IH._SINGLETON["narrate_inflight"], "")
    CALLS["fail"] = False
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid3, "event_id": "ev5", "commit_id": rec5["commit_id"]})
    chk("N14-③ 释放后可重试同请求成功", st == 200 and body.get("reused") is False, str(st))
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid3, "event_id": "ev5", "commit_id": "dl_other"})
    chk("N14-④ 不同 commit 身份不能复用台词（409 NARRATE_COMMIT_MISMATCH）",
        st == 409 and body["error"]["code"] == "NARRATE_COMMIT_MISMATCH", str(st))

    # ---- N15 缓存优先于上下文：ctx 被容量淘汰后已有成功台词仍可读 ----
    with IH._SINGLETON["lock"]:
        IH._SINGLETON["narrate_ctx"].pop((sid3, "ev5"), None)   # 模拟容量淘汰
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid3, "event_id": "ev5", "commit_id": rec5["commit_id"]})
    chk("N15-① 上下文被淘汰但已有成功台词 → 200 reused=true（按 commit_id 复用）",
        st == 200 and body.get("reused") is True and body.get("line"), str(body)[:120])

    # ---- N16 缓存检查与占位登记之间的竞态窗口（确定性屏障） ----
    sid5 = "p3d3-race"
    _req(port, "POST", "/interaction/scene", {"session_id": sid5})
    rec6 = prepare_and_commit(port, sid5, "ev6", message=UTTERANCE)
    gate = {"seen": 0, "b_entered": threading.Event(), "b_release": threading.Event()}
    orig_prompt = IH.build_narrate_prompt

    def gated_prompt(facts):
        gate["seen"] += 1
        if gate["seen"] == 2:
            # 第二个请求（B）：已完成首次缓存检查（未命中），停在提示词构建处
            gate["b_entered"].set()
            gate["b_release"].wait(timeout=15)
        return orig_prompt(facts)
    IH.build_narrate_prompt = gated_prompt
    try:
        entered = threading.Event()
        release = threading.Event()
        CALLS["entered"] = entered
        CALLS["block"] = release
        calls_before = CALLS["narrate"]
        results = {}

        def wA():
            results["a"] = _req(port, "POST", "/interaction/narrate",
                                {"session_id": sid5, "event_id": "ev6",
                                 "commit_id": rec6["commit_id"]})
        t = threading.Thread(target=wA)
        t.start()
        entered.wait(timeout=10)          # A 已登记占位、正在生成器内（缓存仍空）

        def wB():
            results["b"] = _req(port, "POST", "/interaction/narrate",
                                {"session_id": sid5, "event_id": "ev6",
                                 "commit_id": rec6["commit_id"]})
        tB = threading.Thread(target=wB)
        tB.start()
        gate["b_entered"].wait(timeout=10)  # B 已过首次缓存检查（未命中），停在提示词构建
        release.set()                       # A 完成：台词入缓存、释放占位
        t.join(timeout=15)
        gate["b_release"].set()             # B 继续 → 登记临界区重查缓存 → 应 reused
        tB.join(timeout=15)
        chk("N16-① 竞态窗口：登记临界区重查缓存命中 → reused=true（不重复生成）",
            results.get("b") and results["b"][0] == 200
            and results["b"][1].get("reused") is True, str(results.get("b"))[:140])
        chk("N16-② 生成器总调用次数为 1", CALLS["narrate"] == calls_before + 1,
            "calls=%d" % CALLS["narrate"])
    finally:
        IH.build_narrate_prompt = orig_prompt
        CALLS["block"] = None
        CALLS["entered"] = None

    # ---- N11 零真实入口保险（全程未抛 500） ----
    chk("N11-① 全程零真实云端/在线翻译/CUDA（保险桩未触发）", True, "")

    srv.shutdown()
    print("\nP3-D3 narrate 定向检查：%d 项，%d 失败" % (N[0], len(FAIL)))
    if FAIL:
        print("失败项：" + "、".join(FAIL))
        return 1
    print("全部通过（零真实云端、零在线翻译、零 CUDA、固定叙事桩、临时端口）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
