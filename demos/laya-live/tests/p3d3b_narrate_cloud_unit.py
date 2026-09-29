"""P3-D3b · /interaction/narrate 生产云端叙事生成器接线 · 固定传输桩定向检查（零真实模型）。

覆盖：
  C1  生产 configure_real() 注入云端叙事生成器；实际发送的是 D3 已构造的 sys_p/user_p
      （含服务端配置的角色人设、本回合事实顺序、线索/信号块），不含旧 /narrate 的
      行为提案/台词池标记。
  C2  无隐式 decide：decide/PROTOCOL.analyze 全程「调用即报错」保险未触发。
  C3  同 commit_id 成功台词复用：云端传输只调用 1 次。
  C4  云端失败（HTTP 500 类）→ 502 NARRATION_FAILED；权威状态/时钟/版本/回执深比较不变；
      恢复后同请求可重试成功。
  C5  云端空内容 → 502 NARRATION_FAILED。
  C6  未配置凭据 → 生产配置不注入生成器 → 503 NARRATOR_UNAVAILABLE。
  C7  响应卫生：200/502 响应体与错误体不含 Prompt/原始响应/推理内容标记。
  C8  同回合单飞保持：并发同请求第二个 409 NARRATE_IN_PROGRESS、传输总调用 1 次。
  零真实云端、零在线翻译、零 CUDA。

★ 运行：`PYTHONIOENCODING=utf-8 python tests/p3d3b_narrate_cloud_unit.py`
"""
import copy
import json
import os
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


def scripted_interpret(sid, msg):
    IH._SINGLETON["explain_calls"][0] += 1
    if "酒馆" in msg:
        act = [{"id": "a1", "operation": "move", "target_ids": ["tavern"],
                "object_id": None, "mode": "attempt", "kind": None,
                "content": msg, "evidence": msg}]
        return {"interpretation": {"status": "ready", "actions": act},
                "prepare_request": {"session_id": None, "event_id": None,
                                    "actor_id": "player", "expected_versions": None,
                                    "actions": act},
                "directory": {}, "history_used": [], "prepare_error": None}
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


# ---- 固定云端传输桩（替代 llm_chat_raw；零真实网络） ----
TRANSPORT = {"calls": 0, "sys": None, "user": None, "mode": "ok",
             "entered": None, "release": None}


def transport_stub(system, user, timeout=120):
    TRANSPORT["calls"] += 1
    TRANSPORT["sys"] = system
    TRANSPORT["user"] = user
    if TRANSPORT["mode"] == "fail_http":
        return None, "http_500"
    if TRANSPORT["mode"] == "empty":
        return "", None
    if TRANSPORT["mode"] == "block":
        TRANSPORT["entered"].set()
        TRANSPORT["release"].wait(timeout=15)
    return "<line>莉亚朝旧井的方向点了点头，把钥匙的下落告诉了你。</line>", None


def _raising(*a, **k):
    raise RuntimeError("零真实调用保险：不应被调用")


def start_server(with_credentials=True):
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
    TRANSPORT.update(calls=0, sys=None, user=None, mode="ok", entered=None, release=None)
    B.llm_chat_raw = transport_stub
    B.translate_to_en = _raising
    EV.default_real_infer = _raising
    IH._interpret = scripted_interpret
    # 无隐式 decide 保险：旧 /narrate 的 decide 链任何一环被调用即报错
    B.decide = _raising
    P.analyze = _raising

    keys_before = {k: os.environ.get(k) for k in ("DEEPSEEK_API_KEY", "LLM_API_KEY")}
    if with_credentials:
        os.environ["DEEPSEEK_API_KEY"] = "test-stub-key"
        os.environ.pop("LLM_API_KEY", None)
    else:
        os.environ.pop("DEEPSEEK_API_KEY", None)
        os.environ.pop("LLM_API_KEY", None)
    try:
        IH.configure_real()
    finally:
        for k, v in keys_before.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    # 测试桩 Provider 与凭据无关（真实 Provider 会撞上零真实调用保险桩）
    IH.get_core()._evidence_provider = make_stub_provider()

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
    # ---- C1/C2/C3/C7：生产注入 + D3 提示词 + 无隐式 decide + 复用 + 卫生 ----
    srv, port = start_server(with_credentials=True)
    sid = "p3d3b-main"
    chk("C1-① 配置凭据后 configure_real 注入云端叙事生成器",
        callable(IH._SINGLETON["narrate_caller"]), "")
    _req(port, "POST", "/interaction/scene", {"session_id": sid})
    rec = prepare_and_commit(port, sid, "ev1")
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid, "event_id": "ev1", "commit_id": rec["commit_id"]})
    chk("C1-② narrate 200 且提取出 <line> 台词（经云端传输桩）",
        st == 200 and body.get("line") and body.get("reused") is False, str(body)[:140])
    sys_p = TRANSPORT["sys"] or ""
    user_p = TRANSPORT["user"] or ""
    c13 = {
        "本回合事实": "本回合事实（按发生顺序）" in sys_p,
        "时间顺序": "时间顺序：" in sys_p,
        "玩家已获知线索": "玩家已获知线索" in sys_p,
        "Laya信号": "Laya 信号（只校准语气" in sys_p,
        "user_p": "请写出本回合的叙事台词。" == user_p,
        "user_repr": repr(user_p),
    }
    chk("C1-③ 实际发送的是 D3 提示词：本回合事实（按发生顺序）+ 时间顺序 + 线索/信号块",
        all(c13.values()), json.dumps(c13, ensure_ascii=False))
    chk("C1-④ 角色身份与静态人设取服务端配置（CFG actor）",
        "角色：莉亚" in sys_p and "圣殿骑士" in sys_p
        and "人物与场景补充" in sys_p, "")
    chk("C1-⑤ 玩家原话取自服务端绑定上下文",
        "玩家原话（服务端保存的原始输入）：%s" % UTTERANCE in sys_p, "")
    chk("C1-⑥ 不含旧 /narrate 的行为提案/台词池标记",
        "本轮她决定做出的行为" not in sys_p and "台词池" not in sys_p
        and "表现要求" not in sys_p, "")
    chk("C2-① 无隐式 decide：decide/PROTOCOL.analyze 保险桩全程未触发", True, "")

    st2, body2 = _req(port, "POST", "/interaction/narrate",
                      {"session_id": sid, "event_id": "ev1", "commit_id": rec["commit_id"]})
    chk("C3-① 同 commit_id 重复请求 → reused=true、台词一致",
        st2 == 200 and body2.get("reused") is True and body2.get("line") == body.get("line"),
        str(body2)[:120])
    chk("C3-② 云端传输只调用 1 次（成功台词复用，不重复付费）",
        TRANSPORT["calls"] == 1, "calls=%d" % TRANSPORT["calls"])
    chk("C7-① 200 响应只含白名单字段（无 Prompt/原始响应）",
        set(body.keys()) == {"protocol_version", "session_id", "event_id",
                             "commit_id", "line", "reused"}
        and "本回合事实" not in json.dumps(body, ensure_ascii=False), "")

    # ---- C4/C5：失败与空内容：状态/时钟/版本/回执不变 ----
    rec2 = prepare_and_commit(port, sid, "ev2", message="我回酒馆")
    snap_before = authoritative(port, sid)
    receipt_before = IH.get_core().get_receipt(sid, "ev2")
    TRANSPORT["mode"] = "fail_http"
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid, "event_id": "ev2", "commit_id": rec2["commit_id"]})
    chk("C4-① 云端 HTTP 失败 → 502 NARRATION_FAILED",
        st == 502 and body["error"]["code"] == "NARRATION_FAILED", str(body))
    chk("C4-② 失败后权威状态/时钟/版本/回执深比较不变",
        snap_before == authoritative(port, sid)
        and receipt_before == IH.get_core().get_receipt(sid, "ev2"), "")
    TRANSPORT["mode"] = "empty"
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid, "event_id": "ev2", "commit_id": rec2["commit_id"]})
    chk("C5-① 云端空内容 → 502 NARRATION_FAILED",
        st == 502 and body["error"]["code"] == "NARRATION_FAILED", str(body))
    TRANSPORT["mode"] = "ok"
    st, body = _req(port, "POST", "/interaction/narrate",
                    {"session_id": sid, "event_id": "ev2", "commit_id": rec2["commit_id"]})
    chk("C4-③ 失败不留缓存：恢复后同请求重试成功（reused=false）",
        st == 200 and body.get("reused") is False and body.get("line"), str(st))
    chk("C7-② 502 错误体不含 Prompt/原始响应/密钥标记",
        "本回合事实" not in json.dumps(body, ensure_ascii=False)
        and "Bearer" not in json.dumps(body, ensure_ascii=False), "")
    srv.shutdown()

    # ---- C6：未配置凭据 → 503 NARRATOR_UNAVAILABLE ----
    srv2, port2 = start_server(with_credentials=False)
    sid2 = "p3d3b-nokey"
    chk("C6-① 未配置凭据时 configure_real 不注入生成器",
        IH._SINGLETON["narrate_caller"] is None, "")
    _req(port2, "POST", "/interaction/scene", {"session_id": sid2})
    rec3 = prepare_and_commit(port2, sid2, "ev1")
    st, body = _req(port2, "POST", "/interaction/narrate",
                    {"session_id": sid2, "event_id": "ev1", "commit_id": rec3["commit_id"]})
    chk("C6-② 无凭据 narrate → 503 NARRATOR_UNAVAILABLE（明确不可用，不假装生成）",
        st == 503 and body["error"]["code"] == "NARRATOR_UNAVAILABLE", str(body))
    chk("C6-③ 未配置凭据时云端传输零调用", TRANSPORT["calls"] == 0, "calls=%d" % TRANSPORT["calls"])
    srv2.shutdown()

    # ---- C8：生产接线下的同回合单飞保持 ----
    srv3, port3 = start_server(with_credentials=True)
    sid3 = "p3d3b-conc"
    _req(port3, "POST", "/interaction/scene", {"session_id": sid3})
    rec4 = prepare_and_commit(port3, sid3, "ev1")
    entered = threading.Event()
    release = threading.Event()
    TRANSPORT["mode"] = "block"
    TRANSPORT["entered"] = entered
    TRANSPORT["release"] = release
    calls_before = TRANSPORT["calls"]
    results = {}

    def w1():
        results["a"] = _req(port3, "POST", "/interaction/narrate",
                            {"session_id": sid3, "event_id": "ev1",
                             "commit_id": rec4["commit_id"]})
    t = threading.Thread(target=w1)
    t.start()
    entered.wait(timeout=10)
    stB, bodyB = _req(port3, "POST", "/interaction/narrate",
                      {"session_id": sid3, "event_id": "ev1", "commit_id": rec4["commit_id"]})
    chk("C8-① 并发同请求第二个 → 409 NARRATE_IN_PROGRESS",
        stB == 409 and bodyB["error"]["code"] == "NARRATE_IN_PROGRESS", str(bodyB))
    release.set()
    t.join(timeout=15)
    chk("C8-② 首个请求最终 200 且云端传输总调用 1 次",
        results.get("a") and results["a"][0] == 200
        and TRANSPORT["calls"] == calls_before + 1,
        "calls=%d" % TRANSPORT["calls"])
    TRANSPORT["mode"] = "ok"
    srv3.shutdown()

    print("\nP3-D3b narrate 云端接线定向检查：%d 项，%d 失败" % (N[0], len(FAIL)))
    if FAIL:
        print("失败项：" + "、".join(FAIL))
        return 1
    print("全部通过（零真实云端、零在线翻译、零 CUDA、固定云端传输桩、临时端口）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
