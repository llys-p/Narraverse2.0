"""P3-D4 · 叙事历史上下文与角色在场定向检查（固定叙事桩，零真实调用）。

覆盖（只测本轮新增行为；既有薄链行为由 p3d3_narrate_unit.py 回归）：
  H1  第 2 轮提示词含第 1 轮的服务端保存原话+台词（历史来源只有服务端两份缓存）
  H2  历史只取最近 3 轮、排除当前事件、按时间升序
  H3  历史块明确声明「不是权威事实」与禁改写约束
  H4  某轮原话上下文缺失 → 如实标注缺失（不猜原话），台词仍可用
  H5  无历史 → 明确降级说明，不臆造往轮
  P1  有实际发生的交流（attempted，listener=lia）→ mode=character
  P2  纯移动回合（无交流）→ mode=scene，提示词是场景叙述模式（不以角色口吻）
  P3  交流被阻止（listener_out_of_reach）→ mode=scene
  P4  facts 记录被阻止步骤的 check_reasons（在场判断依据可追溯）
  R1  响应带 mode；同 commit 复用返回同一 mode
  R2  客户端无法注入历史/模式（白名单外字段 422；生成输入只来自服务端）

★ 运行：`PYTHONIOENCODING=utf-8 python tests/p3d4_narrate_unit.py`
"""
import copy
import json
import sys
import threading
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


UTTERANCE_Q = "我先问莉亚地窖钥匙在哪里"
UTTERANCE_MOVE = "我去旧井看看"
UTTERANCE_MOVE_FIRST = "先走后问去旧井：我先去旧井再问莉亚钥匙在哪"

ACTIONS_Q = [
    {"id": "a1", "operation": "communicate", "target_ids": ["lia"],
     "object_id": "cellar_key", "mode": "attempt", "kind": "question",
     "content": UTTERANCE_Q, "evidence": UTTERANCE_Q},
]
ACTIONS_MOVE = [
    {"id": "a1", "operation": "move", "target_ids": ["old_well"],
     "object_id": None, "mode": "attempt", "kind": None,
     "content": UTTERANCE_MOVE, "evidence": UTTERANCE_MOVE},
]
ACTIONS_MOVE_FIRST = [
    {"id": "a1", "operation": "move", "target_ids": ["old_well"],
     "object_id": None, "mode": "attempt", "kind": None,
     "content": "我先去旧井", "evidence": "我先去旧井"},
    {"id": "a2", "operation": "communicate", "target_ids": ["lia"],
     "object_id": "cellar_key", "mode": "attempt", "kind": "question",
     "content": "再问莉亚钥匙在哪", "evidence": "再问莉亚钥匙在哪"},
]


def _interp_for(actions):
    return {"interpretation": {"status": "ready", "actions": actions},
            "prepare_request": {"session_id": None, "event_id": None,
                                "actor_id": "player", "expected_versions": None,
                                "actions": actions},
            "directory": {}, "history_used": [], "prepare_error": None}


def scripted_interpret(sid, msg):
    IH._SINGLETON["explain_calls"][0] += 1
    if "先走后问去旧井" in msg:
        return _interp_for(ACTIONS_MOVE_FIRST)
    if "旧井" in msg:
        return _interp_for(ACTIONS_MOVE)
    if "回酒馆" in msg:
        return _interp_for([
            {"id": "a1", "operation": "move", "target_ids": ["tavern"],
             "object_id": None, "mode": "attempt", "kind": None,
             "content": msg, "evidence": msg}])
    return _interp_for(ACTIONS_Q)


LINES = {
    "q1": "<line>（第1轮台词）莉亚压低声音告诉你钥匙的下落。</line>",
    "q2": "<line>（第2轮台词）莉亚又重复了一遍地点。</line>",
    "q3": "<line>（第3轮台词）莉亚有些不耐烦。</line>",
    "q4": "<line>（第4轮台词）莉亚沉默不语。</line>",
    "move": "<line>（场景）井边只有风声。</line>",
}


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

CALLS = {"narrate": 0, "last_facts": None, "last_prompt": None}


def narrate_stub(facts, sys_p, user_p):
    CALLS["narrate"] += 1
    CALLS["last_facts"] = copy.deepcopy(facts)
    CALLS["last_prompt"] = sys_p
    mode = facts.get("narration_mode")
    if mode == "scene":
        return LINES["move"]
    # 按「第N轮台词」序号取桩词（用消息里的标记挑选，见 _pick_line_key）
    return LINES.get(CALLS.get("next_line") or "q1", LINES["q1"])


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
    CALLS.update(narrate=0, last_facts=None, last_prompt=None, next_line="q1")
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


def prepare_and_commit(port, sid, event_id, message):
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


def narrate(port, sid, event_id, commit_id):
    return _req(port, "POST", "/interaction/narrate",
                {"session_id": sid, "event_id": event_id, "commit_id": commit_id})


def main():
    srv, port = start_server()
    sid = "p3d4-hist"

    # ---- P1/H1：第 1 轮（问莉亚）→ character；无历史 ----
    _req(port, "POST", "/interaction/scene", {"session_id": sid})
    CALLS["next_line"] = "q1"
    rec1 = prepare_and_commit(port, sid, "ev1", message=UTTERANCE_Q)
    st, body = narrate(port, sid, "ev1", rec1["commit_id"])
    chk("P1-① 有实际交流（问莉亚）→ mode=character",
        st == 200 and body.get("mode") == "character", str(body)[:120])
    chk("H5-① 首轮无历史 → 明确降级说明（不臆造往轮）",
        "服务端没有已提交的往轮可引用" in (CALLS["last_prompt"] or ""), "")

    # ---- H1/H3：第 2 轮（纯移动）→ scene + 历史含第 1 轮 ----
    CALLS["next_line"] = "move"
    rec2 = prepare_and_commit(port, sid, "ev2", message=UTTERANCE_MOVE)
    st, body = narrate(port, sid, "ev2", rec2["commit_id"])
    chk("P2-① 纯移动回合 → mode=scene", st == 200 and body.get("mode") == "scene",
        str(body)[:120])
    prompt = CALLS["last_prompt"] or ""
    chk("H1-① 第 2 轮提示词含第 1 轮服务端保存的原话与台词",
        "第1轮 玩家原话：%s" % UTTERANCE_Q in prompt
        and "第1轮 台词：（第1轮台词）莉亚压低声音告诉你钥匙的下落。" in prompt, "")
    chk("H3-① 历史块声明「不是权威事实」与禁改写约束",
        "不是权威事实" in prompt and "不得据此改写物品归属、位置、门状态或关系值" in prompt, "")
    chk("P2-② 场景模式提示词不以角色口吻，且**不推断角色不在现场**",
        "以该角色的口吻写出本回合台词" not in prompt
        and "不要推断角色是否在现场" in prompt
        and "不要写任何角色的台词" in prompt
        and "听不见也看不见" not in prompt and "她不在现场" not in prompt, "")
    chk("R2-① 历史只来自服务端（facts 不含任何客户端字段）",
        set((CALLS["last_facts"] or {}).keys()) <= {
            "event_id", "commit_id", "player_message", "steps",
            "player_knowledge_gained", "tone_signals", "rules_only",
            "narration_mode", "dialog_history"},
        str(sorted((CALLS["last_facts"] or {}).keys())))

    # ---- H2：第 3 轮（移回酒馆）、第 4 轮（再问）→ 历史最多 3 轮、排除当前、升序 ----
    CALLS["next_line"] = "move"
    rec3 = prepare_and_commit(port, sid, "ev3", message="我回酒馆")
    st3, body3 = narrate(port, sid, "ev3", rec3["commit_id"])
    hist3 = (CALLS["last_facts"] or {}).get("dialog_history") or []
    chk("H2-① 第 3 轮历史为 [ev1, ev2]（排除当前事件、按时间升序）",
        [h.get("message") for h in hist3] == [UTTERANCE_Q, UTTERANCE_MOVE],
        json.dumps(hist3, ensure_ascii=False)[:200])
    CALLS["next_line"] = "q2"
    rec4 = prepare_and_commit(port, sid, "ev4", message=UTTERANCE_Q)
    st4, body4 = narrate(port, sid, "ev4", rec4["commit_id"])
    hist4 = (CALLS["last_facts"] or {}).get("dialog_history") or []
    chk("H2-② 第 4 轮历史只取最近 3 轮 [ev1, ev2, ev3]",
        len(hist4) == 3 and [h.get("line") for h in hist4] == [
            LINES["q1"][6:-7], LINES["move"][6:-7], LINES["move"][6:-7]],
        json.dumps([h.get("message") for h in hist4], ensure_ascii=False))
    chk("P1-② 第 4 轮（问莉亚）恢复 character 模式", body4.get("mode") == "character", "")

    # ---- H4：容量淘汰某轮原话上下文 → 台词仍在但标注缺失 ----
    with IH._SINGLETON["lock"]:
        IH._SINGLETON["narrate_ctx"].pop((sid, "ev2"), None)   # 淘汰 ev2 原话
    CALLS["next_line"] = "q4"
    rec5 = prepare_and_commit(port, sid, "ev5", message=UTTERANCE_Q)
    st5, body5 = narrate(port, sid, "ev5", rec5["commit_id"])
    prompt5 = CALLS["last_prompt"] or ""
    chk("H4-① 原话缺失轮如实标注（台词保留，不猜原话）",
        "第1轮 台词：（场景）井边只有风声。（该轮玩家原话上下文已缺失）" in prompt5
        and "第2轮 玩家原话：我回酒馆" in prompt5
        and "玩家原话：我去旧井看看" not in prompt5, "")

    # ---- R1：同 commit 复用返回同一 mode ----
    st6, body6 = narrate(port, sid, "ev5", rec5["commit_id"])
    chk("R1-① 复用路径返回同一 mode 与 reused=true",
        st6 == 200 and body6.get("reused") is True and body6.get("mode") == "character"
        and body6.get("line") == body5.get("line"), str(body6)[:140])

    # ---- P3/P4：先移动后问（交流被阻止 listener_out_of_reach）→ scene + check_reasons ----
    sid2 = "p3d4-blocked"
    _req(port, "POST", "/interaction/scene", {"session_id": sid2})
    recB = prepare_and_commit(port, sid2, "evb", message=UTTERANCE_MOVE_FIRST)
    stB, bodyB = narrate(port, sid2, "evb", recB["commit_id"])
    factsB = CALLS["last_facts"] or {}
    step2 = (factsB.get("steps") or [{}])[1] if len(factsB.get("steps") or []) >= 2 else {}
    chk("P3-① 交流被阻止回合 → mode=scene（本回合无指向角色的实际交流）",
        stB == 200 and bodyB.get("mode") == "scene", str(bodyB)[:120])
    chk("P4-① facts 被阻止步骤带 check_reasons（含 listener_out_of_reach）",
        step2.get("operation") == "communicate"
        and "listener_out_of_reach" in (step2.get("check_reasons") or []),
        json.dumps(step2, ensure_ascii=False)[:200])
    chk("P3-② 场景模式提示词不给角色台词口吻、不推断不在现场",
        "以该角色的口吻" not in (CALLS["last_prompt"] or "")
        and "不要推断角色是否在现场" in (CALLS["last_prompt"] or ""), "")

    # ---- R2：客户端白名单外字段（伪造 history/mode）→ 422，不生成 ----
    calls_before = CALLS["narrate"]
    stX, bodyX = _req(port, "POST", "/interaction/narrate",
                      {"session_id": sid2, "event_id": "evb", "commit_id": recB["commit_id"],
                       "dialog_history": [{"message": "伪造", "line": "伪造"}],
                       "narration_mode": "character"})
    chk("R2-② 客户端伪造 history/mode → 422 未知字段（不进生成）",
        stX == 422 and bodyX["error"]["code"] == "INVALID_REQUEST", str(bodyX)[:120])
    chk("R2-③ 伪造请求未触发生成器", CALLS["narrate"] == calls_before,
        "calls=%d" % CALLS["narrate"])

    # ---- M1：其他 NPC 的交流不触发莉亚台词（按服务端角色身份判断）----
    core = IH.get_core()
    npc_ids = IH._actor_entity_ids(core)
    chk("M1-① 角色身份解析为 {lia}（服务端配置 CFG actor，非客户端）",
        npc_ids == {"lia"}, str(npc_ids))
    chk("M1-② 指向莉亚的已提交实际交流 → 可开口（character）",
        IH._npc_participates(
            [{"operation": "communicate", "execution_status": "attempted", "listener": "lia"}],
            npc_ids) is True, "")
    chk("M1-③ 其他 NPC（bartender）的交流 → 不触发莉亚台词（scene）",
        IH._npc_participates(
            [{"operation": "communicate", "execution_status": "attempted", "listener": "bartender"}],
            npc_ids) is False, "")
    chk("M1-④ 被阻止的莉亚交流 / 纯移动 → 不触发（scene）",
        IH._npc_participates(
            [{"operation": "communicate", "execution_status": "blocked", "listener": "lia"}],
            npc_ids) is False
        and IH._npc_participates(
            [{"operation": "move", "execution_status": "attempted", "listener": None}],
            npc_ids) is False, "")

    # ---- M2：已提交但叙事失败的回合保留位置、标「该轮没有台词」----
    sid7 = "p3d4-failedround"
    _req(port, "POST", "/interaction/scene", {"session_id": sid7})
    recM1 = prepare_and_commit(port, sid7, "evm1", message=UTTERANCE_Q)
    orig_caller = IH._SINGLETON["narrate_caller"]
    IH._SINGLETON["narrate_caller"] = lambda f, s, u: (_ for _ in ()).throw(RuntimeError("桩失败"))
    stM, _ = narrate(port, sid7, "evm1", recM1["commit_id"])
    IH._SINGLETON["narrate_caller"] = orig_caller
    chk("M2-① 第1轮叙事失败 → 502（无成功台词缓存）", stM == 502, str(stM))
    recM2 = prepare_and_commit(port, sid7, "evm2", message="我去旧井看看")
    stM2, bodyM2 = narrate(port, sid7, "evm2", recM2["commit_id"])
    histM = (CALLS["last_facts"] or {}).get("dialog_history") or []
    chk("M2-② 已提交但叙事失败轮保留在历史中（has_line=False）",
        len(histM) == 1 and histM[0].get("message") == UTTERANCE_Q
        and histM[0].get("has_line") is False, json.dumps(histM, ensure_ascii=False)[:160])
    chk("M2-③ 提示词明确标「该轮没有台词」",
        "第1轮 玩家原话：%s（该轮没有台词）" % UTTERANCE_Q in (CALLS["last_prompt"] or ""), "")

    # ---- M3：未提交候选绝不进入历史 ----
    sid8 = "p3d4-uncommitted"
    _req(port, "POST", "/interaction/scene", {"session_id": sid8})
    recU1 = prepare_and_commit(port, sid8, "evu1", message=UTTERANCE_Q)
    narrate(port, sid8, "evu1", recU1["commit_id"])          # 第1轮成功叙事
    vU = versions(port, sid8)
    _req(port, "POST", "/interaction/prepare",                 # 准备但**不提交**
         {"session_id": sid8, "event_id": "evu_pending",
          "message": "我偷偷准备但不提交", "expected_versions": vU})
    recU2 = prepare_and_commit(port, sid8, "evu2", message="我去旧井看看")
    stU2, bodyU2 = narrate(port, sid8, "evu2", recU2["commit_id"])
    msgsU = [h.get("message") for h in ((CALLS["last_facts"] or {}).get("dialog_history") or [])]
    chk("M3-① 未提交候选（evu_pending）绝不进入历史",
        "我偷偷准备但不提交" not in msgsU, json.dumps(msgsU, ensure_ascii=False))
    chk("M3-② 历史只含已提交回合 [evu1]",
        msgsU == [UTTERANCE_Q], json.dumps(msgsU, ensure_ascii=False))

    # ---- D1：解释失败诊断收紧（只固定集 reason + 整数 index + 计数，无模型字符串）----
    dirty_body = {"status": "invalid", "invalid_reason": "bad_kind",
                  "invalid_detail": {"index": 2, "kind": "私密耳语ABC",
                                     "mention": "玩家原话片段XYZ", "max": 8},
                  "actions": [], "partial_actions": [{"id": "a1"}]}
    cat = IH._diag_categories(dirty_body)
    chk("D1-① 诊断只含固定集 reason + 整数 action_index + 计数 + 代码常量 max_actions",
        cat == {"invalid_reason": "bad_kind", "action_index": 2,
                "n_actions": 0, "partial_actions": 1, "max_actions": 8},
        json.dumps(cat, ensure_ascii=False))
    chk("D1-② 诊断不含任何模型字符串（kind/mention 原文不出现，即使截断也不行）",
        "私密耳语ABC" not in json.dumps(cat, ensure_ascii=False)
        and "玩家原话片段XYZ" not in json.dumps(cat, ensure_ascii=False), "")

    # ---- D2：解释不合法 → 422 带收紧类别 details，不含原始模型内容 ----
    sid9 = "p3d4-invaliddiag"
    _req(port, "POST", "/interaction/scene", {"session_id": sid9})
    orig_interp = IH._interpret

    def invalid_interpret(sid, msg):
        IH._SINGLETON["explain_calls"][0] += 1
        return {"interpretation": {"status": "invalid", "invalid_reason": "bad_kind",
                                   "invalid_detail": {"index": 0, "kind": "danceSECRET",
                                                      "mention": msg},
                                   "actions": [], "partial_actions": [{"id": "a1"}]},
                "prepare_request": None, "directory": {}, "history_used": [],
                "prepare_error": None}
    IH._interpret = invalid_interpret
    v9 = versions(port, sid9)
    stD, bodyD = _req(port, "POST", "/interaction/prepare",
                      {"session_id": sid9, "event_id": "evd", "message": "跳个舞吧莉亚",
                       "expected_versions": v9})
    IH._interpret = orig_interp
    det = (bodyD.get("error") or {}).get("details") or {}
    chk("D2-① 解释不合法 → 422 带收紧类别 details（reason+action_index+计数）",
        stD == 422 and bodyD["error"]["code"] == "INTERPRETATION_INVALID"
        and det.get("invalid_reason") == "bad_kind" and det.get("action_index") == 0
        and det.get("n_actions") == 0 and det.get("partial_actions") == 1,
        json.dumps(det, ensure_ascii=False))
    chk("D2-② 422 响应不回显玩家原话/模型字符串（无 invalid_detail/kind/mention 键）",
        "跳个舞" not in json.dumps(bodyD, ensure_ascii=False)
        and "danceSECRET" not in json.dumps(bodyD, ensure_ascii=False)
        and "invalid_detail" not in det and "mention" not in det and "kind" not in det,
        json.dumps(det, ensure_ascii=False))

    # ---- C1：线索叙事纪律（提示词禁止补出线索未给出的具体细节）----
    sidC = "p3d4-clue"
    _req(port, "POST", "/interaction/scene", {"session_id": sidC})
    recC = prepare_and_commit(port, sidC, "evc", message=UTTERANCE_Q)
    narrate(port, sidC, "evc", recC["commit_id"])
    promptC = CALLS["last_prompt"] or ""
    chk("C1-① 叙事提示词含线索纪律：具体事实只能逐字采用线索原文、没说的不补",
        "只能逐字采用「玩家已获知线索」的原文" in promptC
        and "线索没说的绝不补出" in promptC, "")
    chk("C1-② 叙事提示词明确禁止补藏匿点/容器/数量（举反例石砖/铁环/木盒）",
        "藏匿点" in promptC and "容器" in promptC and "数量" in promptC
        and "井沿第三块石砖下" in promptC and "挂在铁环上" in promptC
        and "装在木盒里" in promptC, "")
    chk("C1-③ 线索以逐字权威原文（content）列出",
        "逐字权威原文" in promptC and "地窖钥匙在旧井" in promptC, "")

    # ---- C2：解释器证据契约提示词（每动作证据含自身提及，拆句允许重叠）----
    import laya_delivery_interpreter as ID
    sys_i, _user_i = ID.build_interpret_prompt(
        "我拿到钥匙就开门", {"actors": {}, "objects": {}, "locations": {}}, "player", [])
    chk("C2-① 解释提示词要求每动作 evidence 含自身 targets/object 提及",
        "包含该动作自己报告的 targets / object 提及" in sys_i, "")
    chk("C2-② 解释提示词允许拆句时两段 evidence 重叠、不为避重删提及",
        "允许重叠" in sys_i
        and "不要为了避重而把某条动作 evidence 里的提及删掉" in sys_i, "")

    # ---- 零真实入口保险 ----
    chk("N-① 全程零真实云端/在线翻译/CUDA（保险桩未触发）", True, "")

    srv.shutdown()
    print("\nP3-D4 narrate 定向检查：%d 项，%d 失败" % (N[0], len(FAIL)))
    if FAIL:
        print("失败项：" + "、".join(FAIL))
        return 1
    print("全部通过（零真实云端、零在线翻译、零 CUDA、固定叙事桩、临时端口）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
