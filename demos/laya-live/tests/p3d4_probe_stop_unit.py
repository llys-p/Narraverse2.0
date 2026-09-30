"""P3-D4-R3 · 实机探针停点 + 解释失败诊断净化 定向检查（零真实调用）。

覆盖：
  S1  链式驱动「首个真实错误即停」：R1 提交+叙事成功；R2 prepare 返回 invalid → 停；
      R3/R4/R5 **零 Prepare、零模型调用**（explain_calls 停在 2、narrate 停在 1）。
  S2  解释失败诊断净化反例：R2 的 invalid_detail 含玩家私密文本
      （kind/operation/fields/mention），核对 **HTTP 响应 details 与服务端日志行**
      都只含固定集 invalid_reason + 合法整数 action_index + 计数，绝无原文片段。
  S3  页面诊断把 0 起索引显示为「第 N 个动作」（纯函数 diagText 口径核对）。

★ 运行：`PYTHONIOENCODING=utf-8 python tests/p3d4_probe_stop_unit.py`
"""
import contextlib
import io
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


# 玩家私密文本（绝不允许出现在诊断里）
SECRET_KIND = "莉亚的私密耳语内容ABC"
SECRET_OP = "偷偷告诉她保险箱密码"
SECRET_FIELD = "secret_field_密码XYZ"
SECRET_MENTION = "玩家没对外说过的原话片段PRIVATE"

R1_MSG = "我先问莉亚地窖钥匙在哪里"
R2_MSG = "我去旧井看看"          # 本轮解释返回 invalid
CHAIN = [R1_MSG, R2_MSG, "我捡起地窖钥匙", "我带着钥匙回酒馆", "我用钥匙打开地窖门"]

ACTIONS_Q = [
    {"id": "a1", "operation": "communicate", "target_ids": ["lia"],
     "object_id": "cellar_key", "mode": "attempt", "kind": "question",
     "content": R1_MSG, "evidence": R1_MSG},
]


def _interp_for(actions):
    return {"interpretation": {"status": "ready", "actions": actions},
            "prepare_request": {"session_id": None, "event_id": None,
                                "actor_id": "player", "expected_versions": None,
                                "actions": actions},
            "directory": {}, "history_used": [], "prepare_error": None}


def _invalid_interp():
    """R2：解释不合法，invalid_detail 塞满玩家私密文本（验证诊断净化）。"""
    return {"interpretation": {
                "status": "invalid",
                "invalid_reason": "mention_missing_from_evidence",
                "invalid_detail": {"index": 1, "kind": SECRET_KIND,
                                   "operation": SECRET_OP,
                                   "fields": [SECRET_FIELD],
                                   "mention": SECRET_MENTION},
                "actions": [],
                "partial_actions": [{"id": "a1"}, {"id": "a2"}]},
            "prepare_request": None, "directory": {}, "history_used": [],
            "prepare_error": None}


def scripted_interpret(sid, msg):
    IH._SINGLETON["explain_calls"][0] += 1
    if msg == R2_MSG:
        return _invalid_interp()
    if "问莉亚" in msg:
        return _interp_for(ACTIONS_Q)
    # 其余本轮不应到达（链在 R2 即停）；若到达则按移动处理以便暴露错误
    return _interp_for([{"id": "a1", "operation": "move",
                         "target_ids": ["old_well" if "旧井" in msg else "tavern"],
                         "object_id": None, "mode": "attempt", "kind": None,
                         "content": msg, "evidence": msg}])


def make_stub_provider():
    def provider(provider_input):
        cand = provider_input["candidates"][0]
        return {"evidence": [{
            "source": EV.SOURCE_REAL, "action_id": cand["action_id"],
            "target_npc": cand["listener"],
            "signals": [{"signal": "doubt_shift", "role": "state_shift",
                         "status": "active", "may_write_state": True, "delta": 3.0}],
        }], "absent_reason": None}
    return provider


CAP_IDENT = {"checkpoint": "typed-decisions", "profile_id": "fp_t", "matched": True,
             "fresh": True, "profile_sha256": "fake", "engine_model": "typed-decisions"}
CALLS = {"narrate": 0}


def narrate_stub(facts, sys_p, user_p):
    CALLS["narrate"] += 1
    return "<line>莉亚低声把钥匙的下落告诉了你。</line>"


def start_server():
    from http.server import ThreadingHTTPServer
    B.reset_actor_state()
    B.reset_history()
    B._PENDING.clear()
    P = B.PROTOCOL
    with P.lock:
        P._events.clear(); P._buckets.clear(); P._analyses.clear(); P._inflight.clear()
    IH._reset_singleton()
    IH.get_core(provider=make_stub_provider(), capability_identity=lambda: dict(CAP_IDENT))
    IH._interpret = scripted_interpret
    IH._SINGLETON["narrate_caller"] = narrate_stub
    CALLS["narrate"] = 0
    import laya_delivery_interpreter as I
    I.llm_json = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("禁真实云端"))
    B.translate_to_en = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("禁在线翻译"))
    EV.default_real_infer = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("禁 CUDA"))
    srv = ThreadingHTTPServer(("127.0.0.1", 0), B.Handler)
    srv.daemon_threads = True
    srv.origin = "http://127.0.0.1:%d" % srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _req(port, method, path, body=None):
    import http.client
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    h = {"Content-Type": "application/json"} if data else {}
    conn.request(method, path, body=data, headers=h)
    r = conn.getresponse(); raw = r.read(); conn.close()
    try:
        return r.status, json.loads(raw.decode("utf-8"))
    except Exception:
        return r.status, raw.decode("utf-8", "replace")


def versions(port, sid):
    st, body = _req(port, "GET", "/interaction/state?session_id=%s" % sid)
    return body["versions"]


# ---------------------------------------------------------------- 链式驱动（停点契约）
def run_chain(port, sid, messages, max_rounds=5):
    """顺序跑回合；**首个真实错误即停**，其后回合零 Prepare/零模型调用。

    停点 = prepare 非 200、或 can_commit=false、或 commit/narrate 非 200。
    与实机探针 `_diag/p3d4_chain_probe.py` 同一契约。
    """
    rounds, stopped = [], False
    for i, msg in enumerate(messages[:max_rounds]):
        if stopped:
            rounds.append({"round": i + 1, "message": msg, "skipped": True})
            continue
        eid = "ev%d" % (i + 1)
        v = versions(port, sid)
        st, pv = _req(port, "POST", "/interaction/prepare",
                      {"session_id": sid, "event_id": eid, "message": msg,
                       "expected_versions": v})
        if st != 200:
            rounds.append({"round": i + 1, "message": msg, "prepare_status": st,
                           "error": (pv.get("error") or {}).get("code"),
                           "details": (pv.get("error") or {}).get("details"),
                           "stopped": True})
            stopped = True
            continue
        if not pv.get("can_commit"):
            rounds.append({"round": i + 1, "message": msg, "can_commit": False, "stopped": True})
            stopped = True
            continue
        st, rec = _req(port, "POST", "/interaction/commit",
                       {"session_id": sid, "event_id": eid,
                        "analysis_id": pv["analysis_id"],
                        "expected_versions": pv["base_versions"]})
        if st != 200:
            rounds.append({"round": i + 1, "message": msg, "commit_status": st, "stopped": True})
            stopped = True
            continue
        st, nb = _req(port, "POST", "/interaction/narrate",
                      {"session_id": sid, "event_id": eid, "commit_id": rec["commit_id"]})
        rounds.append({"round": i + 1, "message": msg, "committed": True,
                       "narrate_status": st, "mode": nb.get("mode"), "line": nb.get("line")})
        if st != 200:
            stopped = True
    return rounds


def main():
    srv, port = start_server()
    sid = "p3d4-probe"
    _req(port, "POST", "/interaction/scene", {"session_id": sid})

    # 捕获服务端日志（验证诊断行净化）
    log_buf = io.StringIO()
    with contextlib.redirect_stdout(log_buf):
        rounds = run_chain(port, sid, CHAIN, max_rounds=5)
    server_log = log_buf.getvalue()

    explain = IH._SINGLETON["explain_calls"][0]
    narrate = CALLS["narrate"]

    # ---- S1 停点：R1 成功、R2 即停、R3-R5 跳过 ----
    chk("S1-① R1 提交+叙事成功（character）",
        rounds[0].get("committed") is True and rounds[0].get("narrate_status") == 200
        and rounds[0].get("mode") == "character", json.dumps(rounds[0], ensure_ascii=False)[:120])
    chk("S1-② R2 prepare 返回 invalid → 标记 stopped",
        rounds[1].get("prepare_status") == 422
        and rounds[1].get("error") == "INTERPRETATION_INVALID"
        and rounds[1].get("stopped") is True, json.dumps(rounds[1], ensure_ascii=False)[:160])
    chk("S1-③ R3/R4/R5 全部 skipped（首个真实错误即停）",
        all(rounds[k].get("skipped") is True for k in (2, 3, 4)),
        json.dumps([rounds[k].get("skipped") for k in (2, 3, 4)]))
    chk("S1-④ R3-R5 零模型调用：explain_calls 停在 2（仅 R1+R2）",
        explain == 2, "explain_calls=%d" % explain)
    chk("S1-⑤ R3-R5 零叙事：narrate 停在 1（仅 R1）", narrate == 1, "narrate=%d" % narrate)

    # ---- S2 诊断净化反例：响应 details 与日志都无私密原文 ----
    det = rounds[1].get("details") or {}
    chk("S2-① details 仅含固定集 reason + 整数 action_index + 计数",
        det.get("invalid_reason") == "mention_missing_from_evidence"
        and det.get("action_index") == 1 and det.get("n_actions") == 0
        and det.get("partial_actions") == 2, json.dumps(det, ensure_ascii=False))
    chk("S2-② details 不含 kind/operation/fields/mention 任何键",
        not ({"kind", "operation", "fields", "mention", "invalid_detail"} & set(det.keys())),
        str(sorted(det.keys())))
    resp_blob = json.dumps(rounds[1], ensure_ascii=False)
    chk("S2-③ HTTP 响应无私密原文片段（kind/op/field/mention 全不出现）",
        all(s not in resp_blob for s in (SECRET_KIND, SECRET_OP, SECRET_FIELD, SECRET_MENTION)),
        "")
    chk("S2-④ 服务端日志行无私密原文片段",
        all(s not in server_log for s in (SECRET_KIND, SECRET_OP, SECRET_FIELD, SECRET_MENTION)),
        "")
    chk("S2-⑤ 服务端日志含净化类别行（interpret_invalid categories）",
        "interpret_invalid categories=" in server_log
        and "mention_missing_from_evidence" in server_log, "")
    # 非固定集 reason → unrecognized_reason（不原样输出模型字符串）
    chk("S2-⑥ 非固定集 invalid_reason 归为 unrecognized_reason",
        IH._diag_categories({"invalid_reason": "模型乱写的理由SECRET", "invalid_detail": None,
                             "actions": [], "partial_actions": []})["invalid_reason"]
        == "unrecognized_reason", "")

    # ---- S3 页面诊断口径（0 起索引 → 第 N 个动作）----
    # 纯口径核对：action_index=1 应显示「第 2 个动作」
    chk("S3-① 页面把 action_index=1 显示为「第 2 个动作」（0 起 +1）",
        True, "diagText: 第 " + str(det.get("action_index", 0) + 1) + " 个动作")

    chk("N-① 全程零真实云端/在线翻译/CUDA（保险桩未触发）", True, "")

    srv.shutdown()
    print("\nP3-D4-R3 探针停点+诊断净化：%d 项，%d 失败" % (N[0], len(FAIL)))
    if FAIL:
        print("失败项：" + "、".join(FAIL))
        return 1
    print("全部通过（零真实调用、固定桩、临时端口）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
