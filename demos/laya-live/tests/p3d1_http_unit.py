"""P3-D1-R1 · Interaction Core HTTP 接线 · 临时端口定向检查（零云端、零 CUDA）。

用固定解释桩 + 固定 Evidence 桩，在**本机临时端口**起真实 HTTP 服务，走通
公开 state → 显式创世 → 解释 → Prepare → Commit → 下轮 state/回执，并覆盖协议要求的反例。
不碰 8130/8131、能力档案、冻结资产；不接页面/叙事。

覆盖（对照 P3-D-HTTP-协议-v0.1 与 R1 接手卡）：
  D1  公开 GET 零写；显式场景创世幂等；原话 → Prepare 前后游戏态不变；Commit 后多实体
      版本与下轮 state 改变；重复 Commit 不二次记账。
  D2  反例：stale 版本 / 改载荷 / 未知字段 / 非就绪解释 明确失败。
  D3  并发同事件只有一次解释调用；同事件改载荷冲突。
  D4  外站 Origin 在调用模型与写入前被拒（含 OPTIONS）。
  D6  译文缺失：不调用 Laya（evidence 缺席 translation_missing），冻结资产不变。
  R1  正式启动 origin：main() 同款「真实监听地址」受信 origin；未配置 origin 时带
      Origin 的请求 fail-closed 403（解释/写入前）。
  R2  生产 Provider：configure_real() 注入真实 Provider/身份源/运行翻译；先 GET state
      再 Prepare 仍走已配置 Provider（translation_missing 而非 laya_not_invoked）。
  R3  非法 session/event：scene/prepare/commit/receipt/state 入口统一 1–64 位
      [A-Za-z0-9_-]，写入前 422、状态/版本不变、不调解释器。
  R4  单飞/缓存：活跃解释超 60 秒不被清理（仍只有一次解释调用）；同 event 改载荷在
      解释前 409；缓存命中查 TTL（过期复用）；容量满淘汰最旧（有界）；缓存命中路径
      不持入口锁调 Core。
  R5  收口：回执走 get_receipt；玩家本轮获得线索进预览/回执（actor_id=player 投影、
      莉亚私有知识不外泄）；cloud_* invalid → 502；非 cloud invalid → 422；运行翻译
      磁盘缓存重启可读；未提交回执 404。
  R6  桩隔离：test_full_chain 的解释桩替换必须恢复，不泄漏到后续用例。

★ 运行环境：Windows 控制台默认 GBK 编不出 ✅，请用
  `PYTHONIOENCODING=utf-8 python tests/p3d1_http_unit.py`
"""
import copy
import json
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B
import laya_evidence as EV
import laya_interaction_http as IH

FAIL = []
N = [0]

# 模块级真实解释入口（测试桩替换后必须恢复到此，防泄漏到后续用例）。
ORIG_INTERPRET = IH._interpret


def chk(tag, ok, detail=""):
    N[0] += 1
    print("  %s [%s] %s" % ("✅" if ok else "❌", tag, detail))
    if not ok:
        FAIL.append(tag)


# ------------------------------------------------------------------ 桩
def make_ready_interp(actions=None):
    """固定「ready」解释桩：返回 interpret_turn 结构 + 一个 communicate/question 动作。"""
    acts = actions or [{
        "id": "a1", "operation": "communicate", "target_ids": ["lia"],
        "object_id": None, "mode": "attempt", "kind": "question",
        "content": "今晚人多吗？", "evidence": "今晚人多吗？",
    }]
    return {
        "interpretation": {"status": "ready", "actions": acts},
        "prepare_request": {
            "session_id": None, "event_id": None, "actor_id": "player",
            "expected_versions": None, "actions": acts,
        },
        "directory": {}, "history_used": [], "prepare_error": None,
    }


def make_stub_provider(delta=3.0, absent_reason=None):
    """固定 Evidence 桩：返回 list 或 dict（带缺席原因）。"""
    def provider(provider_input):
        if absent_reason is not None:
            return {"evidence": [], "absent_reason": absent_reason}
        cand = provider_input["candidates"][0]
        return {"evidence": [{
            "source": EV.SOURCE_REAL, "action_id": cand["action_id"],
            "target_npc": cand["listener"],
            "signals": [{"signal": "doubt_shift", "role": "state_shift", "status": "active",
                         "may_write_state": True, "delta": delta}],
        }], "absent_reason": None}
    return provider


CAP_IDENT = {"checkpoint": "typed-decisions", "profile_id": "fp_t", "matched": True,
             "fresh": True, "profile_sha256": "fake", "engine_model": "typed-decisions"}


def _no_infer(*args, **kwargs):
    raise AssertionError("零模型保险：真实 infer 不应被调用")


class _FakeTime:
    """替换 IH 模块内的 time（只影响 IH 簿记，不影响 http.client / Core 的真实时钟）。"""
    def __init__(self, clock):
        self._clock = clock

    def time(self):
        return self._clock["t"]


# ------------------------------------------------------------------ 服务与客户端
def _reset_world():
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


def start_server():
    """测试服务器：手工设置 origin + 注入固定桩（非真实模型）。"""
    from http.server import ThreadingHTTPServer
    _reset_world()
    IH.get_core(provider=make_stub_provider(), capability_identity=lambda: dict(CAP_IDENT))
    srv = ThreadingHTTPServer(("127.0.0.1", 0), B.Handler)
    srv.daemon_threads = True
    srv.origin = "http://127.0.0.1:%d" % srv.server_address[1]
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    return srv, srv.server_address[1]


def start_server_no_origin():
    """测试服务器但**不设置** srv.origin（复现旧缺陷环境）+ 注入桩 Core。"""
    from http.server import ThreadingHTTPServer
    _reset_world()
    IH.get_core(provider=make_stub_provider(), capability_identity=lambda: dict(CAP_IDENT))
    srv = ThreadingHTTPServer(("127.0.0.1", 0), B.Handler)
    srv.daemon_threads = True
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    return srv, srv.server_address[1]


def start_server_production():
    """与 laya_bridge.main() 同款生产启动：origin 由真实监听地址计算（同表达式，非
    手工字面量），configure_real() 注入真实 Provider/身份源；infer 用零模型桩替换
    （真翻译缺失 → translation_missing，绝不触发真实 CUDA）。"""
    from http.server import ThreadingHTTPServer
    _reset_world()
    orig_infer = EV.default_real_infer
    EV.default_real_infer = _no_infer
    try:
        IH.configure_real()
    finally:
        EV.default_real_infer = orig_infer
    srv = ThreadingHTTPServer(("127.0.0.1", 0), B.Handler)
    srv.daemon_threads = True
    srv.origin = "http://127.0.0.1:%d" % srv.server_address[1]   # 与 main() 相同表达式
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


def _options(port, path, headers=None):
    import http.client
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request("OPTIONS", path, headers=headers or {})
    r = conn.getresponse()
    r.read()
    conn.close()
    return r.status


# ------------------------------------------------------------------ D1 正向链
def test_full_chain():
    srv, port = start_server()
    sid = "d1-full"
    import laya_interaction_http as M
    M._interpret = lambda sid_, msg: make_ready_interp()   # 固定解释桩（零云端）
    try:
        # 未初始化 GET 零写
        st, body = _req(port, "GET", "/interaction/state?session_id=%s" % sid)
        chk("D1-① 未初始化 GET 返回 initialized 全 false、不建桶",
            st == 200 and all(v is False for v in body["initialized"].values()),
            str(body.get("initialized")))

        # 显式创世
        st, body = _req(port, "POST", "/interaction/scene", {"session_id": sid})
        created = body.get("created") or []
        chk("D1-② 显式创世返回实体清单", st == 200 and set(created) == {"player", "lia", "ic_world"},
            str(created))
        v1 = body["versions"]
        # 重复创世幂等（不推进版本）
        st2, body2 = _req(port, "POST", "/interaction/scene", {"session_id": sid})
        chk("D1-③ 重复创世幂等：created 空、版本不变",
            st2 == 200 and (body2.get("created") or []) == [] and body2["versions"] == v1, "")

        # Prepare
        st, pv = _req(port, "POST", "/interaction/prepare",
                      {"session_id": sid, "event_id": "turn_1",
                       "message": "今晚人多吗？", "expected_versions": v1})
        chk("D1-④ Prepare 返回候选预览", st == 200 and pv.get("analysis_id")
            and pv.get("protocol_version") == "laya-delivery-v1", str(pv.get("status")))
        # Prepare 前后游戏态/时钟不变（GET state 时钟仍 0）
        st5, body5 = _req(port, "GET", "/interaction/state?session_id=%s" % sid)
        tick = body5["states"]["ic_world"]["interaction"]["turn_tick"]
        chk("D1-⑤ Prepare 前后游戏时钟不变（零写）", tick == 0, "tick=%s" % tick)
        chk("D1-⑥ Prepare 响应有逐动作 resolutions 且无私有知识",
            "resolutions" in pv and "SENTINEL" not in json.dumps(pv, ensure_ascii=False), "")

        # Commit
        st, rec = _req(port, "POST", "/interaction/commit",
                       {"session_id": sid, "event_id": "turn_1",
                        "analysis_id": pv["analysis_id"], "expected_versions": v1})
        chk("D1-⑦ Commit 成功且 doubt 已写（rules_only=false）",
            st == 200 and rec["status"] == "committed" and rec["rules_only"] is False,
            "status=%s rules_only=%s" % (rec.get("status"), rec.get("rules_only")))

        # 下轮 state 改变：版本推进 + 时钟 +1
        st6, body6 = _req(port, "GET", "/interaction/state?session_id=%s" % sid)
        v2 = body6["versions"]
        tick2 = body6["states"]["ic_world"]["interaction"]["turn_tick"]
        chk("D1-⑧ Commit 后版本推进、时钟 +1", v2 != v1 and tick2 == 1,
            "tick=%s" % tick2)

        # 重复 Commit 不二次记账（replayed）
        st7, rec2 = _req(port, "POST", "/interaction/commit",
                         {"session_id": sid, "event_id": "turn_1",
                          "analysis_id": pv["analysis_id"], "expected_versions": v1})
        chk("D1-⑨ 重复 Commit 幂等 replayed=true",
            st7 == 200 and rec2.get("replayed") is True, str(rec2.get("replayed")))

        # receipt 查询
        st8, rec3 = _req(port, "GET", "/interaction/receipt?session_id=%s&event_id=turn_1" % sid)
        chk("D1-⑩ receipt 查询返回已提交回执（玩家视角）",
            st8 == 200 and rec3.get("commit_id") == rec["commit_id"], "")

        # 公开 state 无 lia 私有知识：私有知识是「钥匙在旧井」这条线索（lia 才知道的位置），
        # 且不应出现 knowledge/clue 键；客观对象名「地窖钥匙」属世界目录，不算私有泄漏。
        blob = json.dumps(body6, ensure_ascii=False)
        lia_state = json.dumps(body6["states"]["lia"], ensure_ascii=False)
        chk("D1-⑪ 公开 state 不含 lia 私有知识线索（无 knowledge/clue 键、无「在旧井」位置线索）",
            "knowledge" not in lia_state and "clue" not in lia_state
            and "旧井" not in lia_state, "")
    finally:
        M._interpret = ORIG_INTERPRET
    srv.shutdown()


# ------------------------------------------------------------------ D2 反例
def test_rejections():
    srv, port = start_server()
    sid = "d1-rej"
    _req(port, "POST", "/interaction/scene", {"session_id": sid})
    v1 = versions(port, sid)

    import laya_interaction_http as M
    chk("R6-① test_full_chain 的解释桩未泄漏（已恢复原函数）",
        M._interpret is ORIG_INTERPRET, "")

    # 未知字段
    st, body = _req(port, "POST", "/interaction/prepare",
                    {"session_id": sid, "event_id": "e1", "message": "x",
                     "expected_versions": v1, "actions": []})
    chk("D2-① prepare 未知字段 actions → 422", st == 422, str(body))
    # 注入 actor_id
    st, body = _req(port, "POST", "/interaction/prepare",
                    {"session_id": sid, "event_id": "e1", "message": "x",
                     "expected_versions": v1, "actor_id": "lia"})
    chk("D2-② prepare 注入 actor_id → 422", st == 422, str(body))
    # stale 版本
    stale = dict(v1); stale["ic_world"] = "v1:old:0:0"
    st, body = _req(port, "POST", "/interaction/prepare",
                    {"session_id": sid, "event_id": "e2", "message": "x",
                     "expected_versions": stale})
    chk("D2-③ stale 版本 → 409 STATE_VERSION_CONFLICT",
        st == 409 and body["error"]["code"] == "STATE_VERSION_CONFLICT", str(body))
    # commit 注入字段
    st, body = _req(port, "POST", "/interaction/commit",
                    {"session_id": sid, "event_id": "e1", "analysis_id": "x",
                     "expected_versions": v1, "delta": [1]})
    chk("D2-④ commit 注入 delta → 422", st == 422, str(body))

    # 非就绪解释（桩返回 needs_clarification）
    IH._SINGLETON["core"] = None
    IH.get_core(provider=make_stub_provider(), capability_identity=lambda: dict(CAP_IDENT))
    M._interpret = lambda sid, msg: {"interpretation": {"status": "needs_clarification", "actions": []},
                                     "prepare_request": None, "directory": {}, "history_used": []}
    try:
        st, body = _req(port, "POST", "/interaction/prepare",
                        {"session_id": sid, "event_id": "e3", "message": "x",
                         "expected_versions": v1})
        chk("D2-⑤ 非就绪解释 → 409 NEEDS_CLARIFICATION",
            st == 409 and body["error"]["code"] == "NEEDS_CLARIFICATION", str(body))
    finally:
        M._interpret = ORIG_INTERPRET
    srv.shutdown()


# ------------------------------------------------------------------ D3 并发单飞
def test_concurrent_single_explain():
    srv, port = start_server()
    sid = "d1-conc"
    _req(port, "POST", "/interaction/scene", {"session_id": sid})
    v1 = versions(port, sid)

    import laya_interaction_http as M
    entered = threading.Event()
    release = threading.Event()
    calls = [0]

    def slow_interpret(sid_, msg):
        calls[0] += 1
        entered.set()
        release.wait(timeout=10)
        return make_ready_interp()

    M._interpret = slow_interpret
    results = {}

    def worker():
        results["a"] = _req(port, "POST", "/interaction/prepare",
                            {"session_id": sid, "event_id": "ev-c", "message": "m",
                             "expected_versions": v1})

    try:
        t = threading.Thread(target=worker)
        t.start()
        entered.wait(timeout=10)
        stB, bodyB = _req(port, "POST", "/interaction/prepare",
                          {"session_id": sid, "event_id": "ev-c", "message": "m",
                           "expected_versions": v1})
        release.set()
        t.join(timeout=10)
        chk("D3-① 并发同事件只调用一次解释", calls[0] == 1, "calls=%d" % calls[0])
        chk("D3-② 并发第二个请求 PREPARE_IN_PROGRESS",
            stB == 409 and bodyB["error"]["code"] == "PREPARE_IN_PROGRESS", str(bodyB))
    finally:
        M._interpret = ORIG_INTERPRET
    srv.shutdown()


# ------------------------------------------------------------------ D4 外站 Origin 拒绝
def test_foreign_origin_rejected():
    srv, port = start_server()
    sid = "d1-org"
    _req(port, "POST", "/interaction/scene", {"session_id": sid})
    v1 = versions(port, sid)
    foreign = {"Origin": "http://evil.example.com"}
    st, body = _req(port, "POST", "/interaction/prepare",
                    {"session_id": sid, "event_id": "e1", "message": "x",
                     "expected_versions": v1}, headers=foreign)
    chk("D4-① 外站 Origin 在解释前被拒（403 ORIGIN_FORBIDDEN）",
        st == 403 and body["error"]["code"] == "ORIGIN_FORBIDDEN", str(body))
    st, body = _req(port, "POST", "/interaction/scene", {"session_id": sid}, headers=foreign)
    chk("D4-② 外站 Origin 写入口 scene 也被拒", st == 403, str(body))
    # OPTIONS 同口径
    r = _options(port, "/interaction/prepare", headers={"Origin": "http://evil.example.com"})
    chk("D4-③ 外站 Origin 的 OPTIONS 被拒（403）", r == 403, "status=%s" % r)
    srv.shutdown()


# ------------------------------------------------------------------ D6 译文缺失
def test_translation_missing_no_laya():
    srv, port = start_server()
    sid = "d1-xlate"
    IH._reset_singleton()
    # 译文缺失：provider 直接返回 absent=translation_missing，不调 Laya
    def xlate_provider(provider_input):
        return {"evidence": [], "absent_reason": EV.ABSENT_TRANSLATION_MISSING}
    IH.get_core(provider=xlate_provider, capability_identity=lambda: dict(CAP_IDENT))
    import laya_interaction_http as M
    M._interpret = lambda sid_, msg: make_ready_interp()   # 固定解释桩（零云端）
    try:
        _req(port, "POST", "/interaction/scene", {"session_id": sid})
        v1 = versions(port, sid)
        st, pv = _req(port, "POST", "/interaction/prepare",
                      {"session_id": sid, "event_id": "e1", "message": "未知句子_哨兵",
                       "expected_versions": v1})
        chk("D6-① 译文缺失 → rules_only=true 且 absent=translation_missing",
            st == 200 and pv["rules_only"] is True
            and pv["evidence_absent_reason"] == EV.ABSENT_TRANSLATION_MISSING,
            str(pv.get("evidence_absent_reason")))
    finally:
        M._interpret = ORIG_INTERPRET
    srv.shutdown()


# ------------------------------------------------------------------ R1 未配置 origin → fail-closed
def test_origin_unconfigured_fail_closed():
    srv, port = start_server_no_origin()
    sid = "d1-orgnone"
    foreign = {"Origin": "http://evil.example.com"}
    st, body = _req(port, "POST", "/interaction/prepare",
                    {"session_id": sid, "event_id": "e1", "message": "x",
                     "expected_versions": {"player": "v1:0:0", "lia": "v1:0:0",
                                           "ic_world": "v1:0:0"}}, headers=foreign)
    chk("R1-① 未配置受信 origin：外站 Origin prepare 403（不静默放行）",
        st == 403 and body["error"]["code"] == "ORIGIN_FORBIDDEN", str(body))
    st, body = _req(port, "POST", "/interaction/scene", {"session_id": sid}, headers=foreign)
    chk("R1-② 未配置受信 origin：外站 Origin scene 写入口 403", st == 403, str(body))
    r = _options(port, "/interaction/prepare", headers={"Origin": "http://evil.example.com"})
    chk("R1-③ 未配置受信 origin：OPTIONS 同口径 403", r == 403, "status=%s" % r)
    chk("R1-④ 外站请求在解释前被拒（零解释调用）",
        IH._SINGLETON["explain_calls"][0] == 0,
        "calls=%d" % IH._SINGLETON["explain_calls"][0])
    # 无 Origin 的本机诊断请求仍放行
    st, body = _req(port, "POST", "/interaction/scene", {"session_id": sid})
    chk("R1-⑤ 无 Origin 本机诊断请求仍放行", st == 200, str(st))
    srv.shutdown()


# ------------------------------------------------------------------ R1+R2 生产启动（main() 同款）
def test_production_startup_origin_and_provider():
    srv, port = start_server_production()
    sid = "d1-prod"
    ok_origin = {"Origin": "http://127.0.0.1:%d" % port}
    st, body = _req(port, "GET", "/interaction/state?session_id=%s" % sid, headers=ok_origin)
    chk("R1-⑥ 正式 origin（真实监听地址）同源请求放行", st == 200, str(body)[:120])
    st, body = _req(port, "POST", "/interaction/scene", {"session_id": sid}, headers=ok_origin)
    chk("R1-⑦ 正式启动同源 scene 放行", st == 200, str(st))
    st, body = _req(port, "POST", "/interaction/scene", {"session_id": sid},
                    headers={"Origin": "http://evil.example.com"})
    chk("R1-⑧ 正式启动外站 scene 403（写前拒绝）", st == 403, str(body))
    st, body = _req(port, "POST", "/interaction/prepare",
                    {"session_id": sid, "event_id": "e1", "message": "x",
                     "expected_versions": versions(port, sid)},
                    headers={"Origin": "http://evil.example.com"})
    chk("R1-⑨ 正式启动外站 prepare 403 且零解释调用",
        st == 403 and IH._SINGLETON["explain_calls"][0] == 0, str(st))
    srv.shutdown()


# ------------------------------------------------------------------ R2 生产 Provider（先 GET 再 Prepare）
def test_production_provider_first_get_then_prepare():
    srv, port = start_server_production()
    sid = "d1-prov"
    SENT = "地窖钥匙在哪_哨兵R2XYZ"
    calls = [0]
    orig_tt = B.translate_to_en
    B.translate_to_en = lambda text: (calls.__setitem__(0, calls[0] + 1) or (None, "stub"))
    # 本用例只验证 Provider 已配置；磁盘缓存装载另有 R5 专测，此处跳过读盘。
    IH._SINGLETON["xlate_disk_loaded"] = True
    import laya_interaction_http as M
    M._interpret = lambda sid_, msg: make_ready_interp(actions=[{
        "id": "a1", "operation": "communicate", "target_ids": ["lia"],
        "object_id": "cellar_key", "mode": "attempt", "kind": "question",
        "content": SENT, "evidence": SENT,
    }])
    try:
        # 先 GET state（旧缺陷：此请求会先创建 rules_only 单例）
        st, body = _req(port, "GET", "/interaction/state?session_id=%s" % sid)
        chk("R2-① 先 GET state 正常（200）", st == 200, str(st))
        st, body = _req(port, "POST", "/interaction/scene", {"session_id": sid})
        chk("R2-② 场景创世正常", st == 200, str(st))
        v1 = body["versions"]
        st, pv = _req(port, "POST", "/interaction/prepare",
                      {"session_id": sid, "event_id": "t1", "message": SENT,
                       "expected_versions": v1})
        chk("R2-③ 先 GET 后 Prepare 仍走已配置真实 Provider（translation_missing，非 laya_not_invoked）",
            st == 200 and pv.get("evidence_absent_reason") == EV.ABSENT_TRANSLATION_MISSING,
            str(pv.get("evidence_absent_reason")))
        chk("R2-④ 运行翻译查询确被调用一次（零 CUDA：infer 保险桩未触发）",
            calls[0] == 1, "calls=%d" % calls[0])
        core = IH.get_core()
        chk("R2-⑤ 单例身份源为真实 real_capability_identity",
            core._capability_identity is EV.real_capability_identity, "")
        # Commit 走真实身份源（档案可读 → 成功）
        st, rec = _req(port, "POST", "/interaction/commit",
                       {"session_id": sid, "event_id": "t1", "analysis_id": pv["analysis_id"],
                        "expected_versions": v1})
        chk("R2-⑥ Commit 经真实身份源成功", st == 200 and rec.get("status") == "committed",
            str(st))
    finally:
        B.translate_to_en = orig_tt
        M._interpret = ORIG_INTERPRET
    srv.shutdown()


# ------------------------------------------------------------------ R3 非法 session/event
def test_id_validation():
    srv, port = start_server()
    good_sid = "d1-ids"
    _req(port, "POST", "/interaction/scene", {"session_id": good_sid})
    v1 = versions(port, good_sid)

    bad_sids = ("bad sid!", "a" * 65, "中文字符")
    for bad in bad_sids:
        st, body = _req(port, "POST", "/interaction/scene", {"session_id": bad})
        chk("R3-① scene 非法 session_id → 422（%r）" % bad[:12], st == 422, str(st))
    chk("R3-② 非法 session 未写任何实体桶",
        not any(scope[0] in bad_sids for scope in B._ACTOR_STATE), "")
    chk("R3-③ 合法会话版本不受影响", versions(port, good_sid) == v1, "")
    st, body = _req(port, "POST", "/interaction/prepare",
                    {"session_id": good_sid, "event_id": "bad@event", "message": "x",
                     "expected_versions": v1})
    chk("R3-④ prepare 非法 event_id → 422 且零解释调用",
        st == 422 and IH._SINGLETON["explain_calls"][0] == 0, str(st))
    st, body = _req(port, "POST", "/interaction/prepare",
                    {"session_id": "bad sid!", "event_id": "e1", "message": "x",
                     "expected_versions": v1})
    chk("R3-⑤ prepare 非法 session_id → 422", st == 422, str(st))
    st, body = _req(port, "GET",
                    "/interaction/receipt?session_id=%s&event_id=%s" % (good_sid, "bad@event"))
    chk("R3-⑥ receipt 非法 event_id → 422", st == 422, str(body))
    st, body = _req(port, "POST", "/interaction/commit",
                    {"session_id": "bad sid!", "event_id": "e1", "analysis_id": "x",
                     "expected_versions": v1})
    chk("R3-⑦ commit 非法 session_id → 422", st == 422, str(body))
    st, body = _req(port, "GET", "/interaction/state?session_id=%s" % "bad@sid")
    chk("R3-⑧ state 非法 session_id → 422", st == 422, str(body))
    srv.shutdown()


# ------------------------------------------------------------------ A 复审：未创世不得先花云端额度；入口缓存覆盖整个候选有效期
def test_preflight_and_cache_lifetime():
    import laya_delivery_core as C
    srv, port = start_server()
    sid = "d1-uninitialized"
    st, state = _req(port, "GET", "/interaction/state?session_id=%s" % sid)
    import laya_interaction_http as M
    original = M._interpret
    calls = [0]

    def unexpected_interpret(_sid, _msg):
        calls[0] += 1
        raise RuntimeError("未初始化场景不应调用解释器")

    M._interpret = unexpected_interpret
    try:
        code, body = _req(port, "POST", "/interaction/prepare",
                          {"session_id": sid, "event_id": "e1", "message": "你好",
                           "expected_versions": state["versions"]})
        chk("A-① 未初始化 Prepare 在解释前返回 SCENE_NOT_INITIALIZED",
            st == 200 and code == 409
            and body["error"]["code"] == "SCENE_NOT_INITIALIZED" and calls[0] == 0,
            "http=%s calls=%s" % (code, calls[0]))
        chk("A-② 未初始化 Prepare 不建游戏状态桶",
            not any(scope[0] == sid for scope in B._ACTOR_STATE), "")
        chk("A-③ 解释缓存覆盖整个 Core 候选有效期",
            M._CACHE_TTL_S == C.READY_TTL_S,
            "http=%s core=%s" % (M._CACHE_TTL_S, C.READY_TTL_S))
    finally:
        M._interpret = original
        srv.shutdown()


# ------------------------------------------------------------------ R4 单飞不被时钟清理 / 缓存 TTL / 载荷冲突
def test_inflight_clock_ttl_conflict():
    srv, port = start_server()
    sid = "d1-ttl"
    _req(port, "POST", "/interaction/scene", {"session_id": sid})
    v1 = versions(port, sid)

    import laya_interaction_http as M
    real_time = M.time
    clock = {"t": real_time.time()}
    M.time = _FakeTime(clock)

    # ── 阶段 1：活跃解释超过 60 秒不被清理 ──
    entered = threading.Event()
    release = threading.Event()
    calls = [0]

    def slow_interpret(sid_, msg):
        calls[0] += 1
        entered.set()
        release.wait(timeout=10)
        return make_ready_interp()

    M._interpret = slow_interpret
    results = {}
    try:
        t = threading.Thread(target=lambda: results.setdefault(
            "a", _req(port, "POST", "/interaction/prepare",
                      {"session_id": sid, "event_id": "ev-slow", "message": "m1",
                       "expected_versions": v1})))
        t.start()
        entered.wait(timeout=10)
        clock["t"] += 61          # 越过旧实现的 60 秒 in-flight 清理阈值
        M._prune_caches()         # 旧实现会在此把活跃 in-flight 删掉 → 第二次付费
        st, body = _req(port, "POST", "/interaction/prepare",
                        {"session_id": sid, "event_id": "ev-slow", "message": "m1",
                         "expected_versions": v1})
        chk("R4-① 活跃解释超过 60 秒不被清理（第二个请求 PREPARE_IN_PROGRESS）",
            st == 409 and body["error"]["code"] == "PREPARE_IN_PROGRESS", str(body))
        chk("R4-② 全程仍只有一次解释调用", calls[0] == 1, "calls=%d" % calls[0])
        release.set()
        t.join(timeout=10)
        st2, pv = results.get("a") or (None, {})
        chk("R4-③ 首个请求正常完成", st2 == 200 and bool(pv.get("analysis_id")), str(st2))
    finally:
        M._interpret = ORIG_INTERPRET

    # ── 阶段 2：缓存命中查 TTL；同事件改载荷在解释前冲突 ──
    calls2 = [0]
    M._interpret = lambda sid_, msg: (calls2.__setitem__(0, calls2[0] + 1)
                                      or make_ready_interp())
    try:
        st, pv = _req(port, "POST", "/interaction/prepare",
                      {"session_id": sid, "event_id": "ev-ttl", "message": "mA",
                       "expected_versions": v1})
        chk("R4-④ 首次 Prepare 成功且入缓存",
            st == 200 and IH._SINGLETON["cache"].get((sid, "ev-ttl")) is not None, str(st))
        clock["t"] += IH._CACHE_TTL_S + 1
        st, pv2 = _req(port, "POST", "/interaction/prepare",
                       {"session_id": sid, "event_id": "ev-ttl", "message": "mA",
                        "expected_versions": v1})
        chk("R4-⑤ 过期缓存不复用：重新解释一次（calls=2）且仍 200",
            st == 200 and calls2[0] == 2, "calls=%d st=%s" % (calls2[0], st))
        st, body = _req(port, "POST", "/interaction/prepare",
                        {"session_id": sid, "event_id": "ev-ttl", "message": "mB",
                         "expected_versions": v1})
        chk("R4-⑥ 同 event 改载荷在解释前冲突（409 EVENT_PAYLOAD_CONFLICT，解释次数不增）",
            st == 409 and body["error"]["code"] == "EVENT_PAYLOAD_CONFLICT"
            and calls2[0] == 2, "calls=%d %s" % (calls2[0], str(body)[:140]))
    finally:
        M._interpret = ORIG_INTERPRET
        M.time = real_time
    srv.shutdown()


# ------------------------------------------------------------------ A 复审：Provider 慢于缓存 TTL 也不能重复解释
def test_prepare_provider_lifetime():
    srv, port = start_server()
    sid = "d1-slow-provider"
    _req(port, "POST", "/interaction/scene", {"session_id": sid})
    v1 = versions(port, sid)
    import laya_interaction_http as M
    real_time = M.time
    original_interpret = M._interpret
    original_prepare = M._prepare_via_core
    clock = {"t": real_time.time()}
    M.time = _FakeTime(clock)
    calls = [0]
    entered = threading.Event()
    release = threading.Event()

    def fixed_interpret(_sid, _message):
        calls[0] += 1
        return make_ready_interp()

    def slow_prepare(*args):
        entered.set()
        release.wait(timeout=10)
        return original_prepare(*args)

    M._interpret = fixed_interpret
    M._prepare_via_core = slow_prepare
    result = {}
    try:
        worker = threading.Thread(target=lambda: result.setdefault(
            "first", _req(port, "POST", "/interaction/prepare",
                          {"session_id": sid, "event_id": "e1", "message": "m",
                           "expected_versions": v1})))
        worker.start()
        entered.wait(timeout=10)
        clock["t"] += M._CACHE_TTL_S + 1
        second_code, second_body = _req(port, "POST", "/interaction/prepare",
                                        {"session_id": sid, "event_id": "e1",
                                         "message": "m", "expected_versions": v1})
        chk("A-④ Core Prepare 尚在运行时缓存过期也不重复解释",
            second_code == 409 and second_body["error"]["code"] == "PREPARE_IN_PROGRESS"
            and calls[0] == 1, "http=%s calls=%s" % (second_code, calls[0]))
        release.set()
        worker.join(timeout=10)
        chk("A-⑤ 首次 Prepare 完成后缓存从候选创建时刻计时",
            result.get("first", (None,))[0] == 200
            and M._SINGLETON["cache"][(sid, "e1")]["prepared_at"] == clock["t"], "")
    finally:
        release.set()
        M._interpret = original_interpret
        M._prepare_via_core = original_prepare
        M.time = real_time
        srv.shutdown()


# ------------------------------------------------------------------ R4 缓存容量有界
def test_cache_capacity_bounded():
    srv, port = start_server()
    sid = "d1-cap"
    _req(port, "POST", "/interaction/scene", {"session_id": sid})
    v1 = versions(port, sid)

    import laya_interaction_http as M
    M._interpret = lambda sid_, msg: make_ready_interp()
    try:
        now = time.time()
        with IH._SINGLETON["lock"]:
            for i in range(IH._CACHE_MAX):
                k = (sid, "cap%04d" % i)
                IH._SINGLETON["cache"][k] = {"message": "m%d" % i,
                                             "versions": dict(v1),
                                             "interp": make_ready_interp(),
                                             "prepared_at": now}
        st, pv = _req(port, "POST", "/interaction/prepare",
                      {"session_id": sid, "event_id": "cap9999", "message": "mNew",
                       "expected_versions": v1})
        with IH._SINGLETON["lock"]:
            n = len(IH._SINGLETON["cache"])
            has_oldest = (sid, "cap0000") in IH._SINGLETON["cache"]
            has_new = (sid, "cap9999") in IH._SINGLETON["cache"]
        chk("R4-⑦ 缓存容量有界：满后新增不超上限（len==_CACHE_MAX）",
            st == 200 and n == IH._CACHE_MAX, "n=%d" % n)
        chk("R4-⑧ 容量满时最旧条目被淘汰、新条目入缓存",
            (not has_oldest) and has_new, "oldest=%s new=%s" % (has_oldest, has_new))
    finally:
        M._interpret = ORIG_INTERPRET
    srv.shutdown()


# ------------------------------------------------------------------ R4 缓存命中路径不持入口锁调 Core
def test_cache_hit_releases_entry_lock():
    srv, port = start_server()
    sid = "d1-lk2"
    _req(port, "POST", "/interaction/scene", {"session_id": sid})
    v1 = versions(port, sid)

    import laya_interaction_http as M
    M._interpret = lambda sid_, msg: make_ready_interp()
    try:
        st, pv = _req(port, "POST", "/interaction/prepare",
                      {"session_id": sid, "event_id": "e1", "message": "m",
                       "expected_versions": v1})
        # 已入缓存
        entered = threading.Event()
        release = threading.Event()
        core = IH.get_core()
        orig_prepare = core.prepare_structured

        def slow_prepare(req):
            entered.set()
            release.wait(timeout=10)
            return orig_prepare(req)

        core.prepare_structured = slow_prepare
        try:
            results = {}
            t = threading.Thread(target=lambda: results.setdefault("a", _req(
                port, "POST", "/interaction/prepare",
                {"session_id": sid, "event_id": "e1", "message": "m",
                 "expected_versions": v1})))
            t.start()
            entered.wait(timeout=10)
            ok = IH._SINGLETON["lock"].acquire(blocking=False)
            if ok:
                IH._SINGLETON["lock"].release()
            chk("R4-⑨ 缓存命中路径不持入口锁调 Core（并发可取得锁）", ok, "")
            release.set()
            t.join(timeout=10)
            chk("R4-⑩ 缓存命中重放仍成功", results.get("a")[0] == 200,
                str(results.get("a"))[:120])
        finally:
            core.prepare_structured = orig_prepare
    finally:
        M._interpret = ORIG_INTERPRET
    srv.shutdown()


# ------------------------------------------------------------------ R5 玩家线索回执 + 私有知识不外泄
def test_receipt_player_knowledge():
    srv, port = start_server()
    sid = "d1-kn"
    import laya_interaction_http as M
    clue_act = [{
        "id": "a1", "operation": "communicate", "target_ids": ["lia"],
        "object_id": "cellar_key", "mode": "attempt", "kind": "question",
        "content": "地窖钥匙在哪？", "evidence": "地窖钥匙在哪？",
    }]
    M._interpret = lambda sid_, msg: make_ready_interp(actions=clue_act)
    try:
        _req(port, "POST", "/interaction/scene", {"session_id": sid})
        v1 = versions(port, sid)
        st, pv = _req(port, "POST", "/interaction/prepare",
                      {"session_id": sid, "event_id": "tq1", "message": "地窖钥匙在哪？",
                       "expected_versions": v1})
        kg = pv.get("knowledge_gained") or []
        chk("R5-① Prepare 预览含玩家本轮获得的线索", st == 200 and bool(kg), str(kg))
        chk("R5-② 预览线索内容含「旧井」（可确认问到钥匙位置）",
            any("旧井" in (row.get("entry") or {}).get("content", "") for row in kg), str(kg))
        st, rec = _req(port, "POST", "/interaction/commit",
                       {"session_id": sid, "event_id": "tq1", "analysis_id": pv["analysis_id"],
                        "expected_versions": v1})
        chk("R5-③ Commit 成功", st == 200 and rec.get("status") == "committed", str(st))
        st, rr = _req(port, "GET", "/interaction/receipt?session_id=%s&event_id=tq1" % sid)
        chk("R5-④ 回执含 knowledge_gained 玩家线索（可显示「钥匙在旧井」）",
            st == 200 and bool(rr.get("knowledge_gained"))
            and "旧井" in json.dumps(rr.get("knowledge_gained"), ensure_ascii=False),
            str(rr.get("knowledge_gained")))
        # 未提交回执：走 Core 持锁 get_receipt → 404 RECEIPT_UNKNOWN
        st, body = _req(port, "GET", "/interaction/receipt?session_id=%s&event_id=never" % sid)
        chk("R5-⑤ 未提交回执 → 404 RECEIPT_UNKNOWN（Core 持锁接口）",
            st == 404 and body["error"]["code"] == "RECEIPT_UNKNOWN", str(body))
        # 公开 state 仍无 lia 私有知识
        st2, body2 = _req(port, "GET", "/interaction/state?session_id=%s" % sid)
        lia_state = json.dumps(body2["states"]["lia"], ensure_ascii=False)
        chk("R5-⑥ 公开 state 不含 lia 私有知识（无 knowledge/clue 键、无「旧井」）",
            st2 == 200 and "knowledge" not in lia_state and "clue" not in lia_state
            and "旧井" not in lia_state, "")
    finally:
        M._interpret = ORIG_INTERPRET
    srv.shutdown()


# ------------------------------------------------------------------ R5 回执投影只留 player 行（莉亚未披露知识不外泄）
def test_receipt_excludes_lia_rows():
    srv, port = start_server()
    sid = "d1-kn2"
    import laya_interaction_http as M
    claim_act = [{
        "id": "a1", "operation": "communicate", "target_ids": ["lia"],
        "object_id": None, "mode": "attempt", "kind": "claim",
        "content": "我昨晚在旧井见过鬼魂", "evidence": "我昨晚在旧井见过鬼魂",
    }]
    M._interpret = lambda sid_, msg: make_ready_interp(actions=claim_act)
    try:
        _req(port, "POST", "/interaction/scene", {"session_id": sid})
        v1 = versions(port, sid)
        st, pv = _req(port, "POST", "/interaction/prepare",
                      {"session_id": sid, "event_id": "tc1", "message": "我昨晚在旧井见过鬼魂",
                       "expected_versions": v1})
        st, rec = _req(port, "POST", "/interaction/commit",
                       {"session_id": sid, "event_id": "tc1", "analysis_id": pv["analysis_id"],
                        "expected_versions": v1})
        raw = IH.get_core().get_receipt(sid, "tc1")
        n_raw = len(raw.get("knowledge_gained") or [])
        st, rr = _req(port, "GET", "/interaction/receipt?session_id=%s&event_id=tc1" % sid)
        n_http = len(rr.get("knowledge_gained") or [])
        chk("R5-⑦ 原始回执含 player+lia 两行，HTTP 回执只投影 player 行",
            n_raw == 2 and n_http == 1,
            "raw=%d http=%d" % (n_raw, n_http))
        chk("R5-⑧ HTTP 回执知识投影不含 actor 维度外泄（无 lia 行内容）",
            all(row.get("entry") is not None for row in rr.get("knowledge_gained") or [])
            and "knowledge_actors" not in json.dumps(rr, ensure_ascii=False), "")
    finally:
        M._interpret = ORIG_INTERPRET
    srv.shutdown()


# ------------------------------------------------------------------ R5 云端解释故障 → 502
def test_cloud_failure_502():
    srv, port = start_server()
    sid = "d1-502"
    _req(port, "POST", "/interaction/scene", {"session_id": sid})
    v1 = versions(port, sid)
    import laya_interaction_http as M

    def cloud_invalid(sid_, msg):
        return {"interpretation": {"status": "invalid", "actions": [],
                                   "invalid_reason": "cloud_401", "invalid_detail": None},
                "prepare_request": None, "directory": {}, "history_used": []}

    M._interpret = cloud_invalid
    try:
        st, body = _req(port, "POST", "/interaction/prepare",
                        {"session_id": sid, "event_id": "e1", "message": "今晚人多吗？",
                         "expected_versions": v1})
        chk("R5-⑨ cloud_* invalid → 502 INTERPRETER_UNAVAILABLE",
            st == 502 and body["error"]["code"] == "INTERPRETER_UNAVAILABLE", str(body))
        chk("R5-⑩ 502 不回显云端错误细节（无 401/密钥/原始错误）",
            "401" not in json.dumps(body, ensure_ascii=False), str(body))
    finally:
        M._interpret = ORIG_INTERPRET

    def bad_invalid(sid_, msg):
        return {"interpretation": {"status": "invalid", "actions": [],
                                   "invalid_reason": "bad_kind", "invalid_detail": None},
                "prepare_request": None, "directory": {}, "history_used": []}

    M._interpret = bad_invalid
    try:
        st, body = _req(port, "POST", "/interaction/prepare",
                        {"session_id": sid, "event_id": "e2", "message": "今晚人多吗？",
                         "expected_versions": v1})
        chk("R5-⑪ 非 cloud invalid → 422 INTERPRETATION_INVALID",
            st == 422 and body["error"]["code"] == "INTERPRETATION_INVALID", str(body))
    finally:
        M._interpret = ORIG_INTERPRET

    M._interpret = lambda sid_, msg: make_ready_interp()
    try:
        st, pv = _req(port, "POST", "/interaction/prepare",
                      {"session_id": sid, "event_id": "e1", "message": "今晚人多吗？",
                       "expected_versions": v1})
        chk("R5-⑫ 502 后同事件可重试（in-flight 已释放）", st == 200, str(st))
    finally:
        M._interpret = ORIG_INTERPRET
    srv.shutdown()


# ------------------------------------------------------------------ R5 运行翻译磁盘缓存重启可读
def test_runtime_xlate_disk_reload():
    orig_disk = B._XLATE_DISK
    tmpdir = tempfile.mkdtemp(prefix="p3d1_xlate_")
    disk = Path(tmpdir) / "translation_cache.json"
    disk.write_text(json.dumps({"运行时句子哨兵XYZ": "runtime sentence XYZ"},
                               ensure_ascii=False), encoding="utf-8")
    B._XLATE_DISK = disk
    calls = [0]
    orig_tt = B.translate_to_en
    B.translate_to_en = lambda text: (calls.__setitem__(0, calls[0] + 1) or (None, "stub"))
    frozen_path = B._XLATE_FROZEN
    frozen_before = frozen_path.read_bytes() if frozen_path.exists() else None
    IH._reset_singleton()
    try:
        lookup = IH.build_runtime_translate()
        got = lookup("运行时句子哨兵XYZ")
        chk("R5-⑬ 重启后读取已有运行翻译缓存（零在线翻译调用）",
            got == "runtime sentence XYZ" and calls[0] == 0,
            "got=%r calls=%d" % (got, calls[0]))
        got2 = lookup("全新未知句哨兵XYZ")
        chk("R5-⑭ 未知新句经在线桩失败返回 None（fail-closed，不回退中文）",
            got2 is None and calls[0] == 1, "got=%r calls=%d" % (got2, calls[0]))
        disk_after = json.loads(disk.read_text(encoding="utf-8"))
        chk("R5-⑮ 运行缓存文件未被失败译文污染",
            disk_after == {"运行时句子哨兵XYZ": "runtime sentence XYZ"}, str(disk_after))
        frozen_after = frozen_path.read_bytes() if frozen_path.exists() else None
        chk("R5-⑯ 冻结资产文件未被触碰", frozen_before == frozen_after, "")
    finally:
        B._XLATE_DISK = orig_disk
        B.translate_to_en = orig_tt
        IH._reset_singleton()
        shutil.rmtree(tmpdir, ignore_errors=True)


def main():
    test_full_chain()
    test_rejections()
    test_concurrent_single_explain()
    test_foreign_origin_rejected()
    test_translation_missing_no_laya()
    test_origin_unconfigured_fail_closed()
    test_production_startup_origin_and_provider()
    test_production_provider_first_get_then_prepare()
    test_id_validation()
    test_preflight_and_cache_lifetime()
    test_inflight_clock_ttl_conflict()
    test_prepare_provider_lifetime()
    test_cache_capacity_bounded()
    test_cache_hit_releases_entry_lock()
    test_receipt_player_knowledge()
    test_receipt_excludes_lia_rows()
    test_cloud_failure_502()
    test_runtime_xlate_disk_reload()
    print("\nP3-D1-R1 Interaction HTTP 定向检查：%d 项，%d 失败" % (N[0], len(FAIL)))
    if FAIL:
        print("失败项：" + "、".join(FAIL))
        return 1
    print("全部通过（零云端、零 CUDA、临时端口、固定桩）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
