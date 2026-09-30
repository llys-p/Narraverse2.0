# -*- coding: utf-8 -*-
"""ZCode 复核副手 · laya_interaction_http.py HTTP 边界定向探针（只读审查用反例脚本）。

基线：融合树保存点 d446336（工作树 D:\\Narraverse2.0-zreview）。
零云端、零 CUDA、零真实监听端口：直接以函数调用方式驱动 handle_* / 内部投影函数，
解释器与翻译全部打桩。断言焦点：
  P1  玩家视角投影：/interaction/state 无任何 interaction.knowledge；
      预览 changes 剔除 .knowledge 写项；knowledge_gained 只含 actor_id=player 行，
      条目投影不含 about/learned_turn；回执不透传 outcome/声明原话到他人视图。
  P2  白名单与类型再校验：scene/prepare/commit 未知字段 422；非法 ID 422 且不调解释器；
      stale 版本 409 且不调解释器；message 长度上限。
  P3  同源守卫：无 Origin 放行 / 不匹配 403 / 受信 origin 未配置 403 / 尾斜杠等价；
      OPTIONS 口径同一函数。
  P4  fail-closed：未配置生产 Provider 时 get_core() 抛 RuntimeError，不静默造 rules-only 单例。
  P5  单飞与缓存：并发同 (session,event) 同载荷只有一次解释调用（另一请求 409
      PREPARE_IN_PROGRESS）；同载荷重试复用缓存（不二次解释、同一 analysis_id）；
      解释期间改载荷 409 EVENT_PAYLOAD_CONFLICT；解释器抛异常 502 且释放占用。
  P6  运行翻译锁：xlate_lock 在线翻译期间被持有 → 并发查询串行化（可用性面，非正确性）。

运行（Git Bash）：
  cd /d/Narraverse2.0-zreview/demos/laya-live && PYTHONIOENCODING=utf-8 python tests/review_zcode_http_probe.py
"""
import json
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B  # noqa: E402
import laya_interaction_http as IH  # noqa: E402

FAIL = []
N = [0]


def chk(tag, ok, detail=""):
    N[0] += 1
    print("  [%s] %s%s" % ("OK" if ok else "FAIL", tag, (" | " + str(detail)) if detail else ""))
    if not ok:
        FAIL.append(tag)


ORIG_INTERPRET = IH._interpret
ORIG_TRANSLATE = B._cached_translate


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


def _inject_rules_only_core():
    """测试注入：rules-only Core（provider=None + 桩身份源），不触配置错误路径。"""
    IH.get_core(provider=None,
                capability_identity=lambda: {"checkpoint": "t", "profile_id": "p",
                                             "matched": True, "fresh": True})


def _get_versions(sid):
    code, body = IH.handle_get("/interaction/state", "session_id=" + sid, {}, None)
    assert code == 200, (code, body)
    return body["versions"]


def _stub_interp(actions, counter=None, delay=0.0):
    """固定解释桩：返回 interpret_turn 结构（prepare_request 只带 5 个白名单键）。"""
    def _do(session_id, message, actor_id="player"):
        if counter is not None:
            with counter["lock"]:
                counter["n"] += 1
        if delay:
            time.sleep(delay)
        return {
            "interpretation": {"status": "ready", "actions": actions,
                               "invalid_reason": None, "invalid_detail": None},
            "prepare_request": {"session_id": None, "event_id": None,
                                "actor_id": "player", "expected_versions": None,
                                "actions": actions},
            "directory": {}, "history_used": [], "prepare_error": None,
        }
    return _do


def _err_code(body):
    return (body or {}).get("error", {}).get("code")


def _find_key(obj, key, hits):
    """递归找精确键名（区分 knowledge vs knowledge_actors）。"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key:
                hits.append(k)
            _find_key(v, key, hits)
    elif isinstance(obj, list):
        for v in obj:
            _find_key(v, key, hits)


# ================================================================ P1 隐私投影
def test_privacy():
    print("== P1 隐私投影（statement 双写 / question 线索 / state 无 knowledge）==")
    _reset_world()
    _inject_rules_only_core()
    sid = "zrev-priv-s1"

    code, body = IH.handle_post_scene({"session_id": sid}, {}, None)
    chk("P1.scene", code == 200 and body.get("created"), (code, _err_code(body)))
    versions = _get_versions(sid)

    # ---- statement：player 声明 → player+lia 各落一条私有 knowledge ----
    stmt = "我昨晚在井边看到莉亚"
    acts = [{"id": "a1", "operation": "communicate", "target_ids": ["lia"],
             "object_id": None, "mode": "attempt", "kind": "claim",
             "content": stmt, "evidence": stmt}]
    IH._interpret = _stub_interp(acts)
    payload = {"session_id": sid, "event_id": "evt-stmt-1", "message": stmt,
               "expected_versions": versions}
    code, pv = IH.handle_post_prepare(payload, {}, None)
    chk("P1.stmt.prepare", code == 200, (code, _err_code(pv)))

    bad_paths = [c["path"] for c in pv.get("changes", []) if ".knowledge" in str(c.get("path"))]
    chk("P1.stmt.changes 无 .knowledge 写项", not bad_paths, bad_paths)
    kept = [c["path"] for c in pv.get("changes", [])]
    chk("P1.stmt.changes 保留 turn_tick", "interaction.turn_tick" in kept, kept)

    kg = pv.get("knowledge_gained") or []
    # 注：预览路径的行来自 _apply_knowledge（无 action_id，投影后为 None）；回执路径才有 action_id。
    chk("P1.stmt.kg 恰一条（其余 actor 行已剔除）", len(kg) == 1, [(r.get("action_id"), (r.get("entry") or {}).get("entry_id")) for r in kg])
    ent = (kg[0].get("entry") or {}) if kg else {}
    chk("P1.stmt.kg 条目无 about/learned_turn",
        "about" not in ent and "learned_turn" not in ent, sorted(ent))
    chk("P1.stmt.kg 是玩家自己的声明（允许）", ent.get("content") == stmt, ent.get("content"))
    for r in pv.get("resolutions", []):
        chk("P1.stmt.resolution 白名单键",
            set(r) <= {"action_id", "operation", "execution_status", "degree", "target_id"},
            sorted(r))

    # ---- commit 后：原始回执确有 lia 行（过滤器承重），HTTP 视图只剩 player 行 ----
    code, rec = IH.handle_post_commit({"session_id": sid, "event_id": "evt-stmt-1",
                                       "analysis_id": pv["analysis_id"],
                                       "expected_versions": versions}, {}, None)
    chk("P1.stmt.commit", code == 200 and rec.get("status") == "committed",
        (code, _err_code(rec)))
    core = IH.get_core()
    raw = core.get_receipt(sid, "evt-stmt-1")
    raw_actors = sorted(r["actor_id"] for r in raw.get("knowledge_gained") or [])
    view_rows = rec.get("knowledge_gained") or []
    chk("P1.stmt.raw回执含 lia 行（过滤器承重）", raw_actors == ["lia", "player"], raw_actors)
    chk("P1.stmt.HTTP视图剔除非 player 行",
        len(view_rows) == 1 and (view_rows[0].get("entry") or {}).get("content") == stmt,
        [(r.get("action_id"), (r.get("entry") or {}).get("entry_id")) for r in view_rows])
    chk("P1.stmt.HTTP回执无 outcome 键", "outcome" not in rec, sorted(rec))
    leak = [a for a in rec.get("acts", [])
            if isinstance(a, dict) and stmt in json.dumps(a, ensure_ascii=False)]
    chk("P1.stmt.acts 不含声明原话", not leak, leak)

    # ---- question：指向 cellar_key → 线索按契约进 player 回执，但不带 about/learned_turn ----
    q = "钥匙在哪里？"
    qacts = [{"id": "a1", "operation": "communicate", "target_ids": ["lia"],
              "object_id": "cellar_key", "mode": "attempt", "kind": "question",
              "content": q, "evidence": q}]
    IH._interpret = _stub_interp(qacts)
    versions2 = _get_versions(sid)
    code, pv2 = IH.handle_post_prepare({"session_id": sid, "event_id": "evt-q-1",
                                        "message": q, "expected_versions": versions2},
                                       {}, None)
    chk("P1.q.prepare", code == 200, (code, _err_code(pv2)))
    kg2 = pv2.get("knowledge_gained") or []
    ent2 = (kg2[0].get("entry") or {}) if kg2 else {}
    chk("P1.q.kg 恰一条 player 行", len(kg2) == 1 and True, [(r.get("action_id"), r.get("status")) for r in kg2])
    chk("P1.q.kg content=作者化线索（契约：从回执得到线索）",
        ent2.get("content") == "地窖钥匙在旧井", ent2.get("content"))
    chk("P1.q.kg told_by=lia 且无 about/learned_turn",
        ent2.get("told_by") == "lia" and "about" not in ent2 and "learned_turn" not in ent2,
        sorted(ent2))
    code, rec2 = IH.handle_post_commit({"session_id": sid, "event_id": "evt-q-1",
                                        "analysis_id": pv2["analysis_id"],
                                        "expected_versions": versions2}, {}, None)
    chk("P1.q.commit", code == 200, (code, _err_code(rec2)))

    # ---- GET state：任意实体状态无 knowledge 键（含 commit 后 turns 存在的场景）----
    code, st = IH.handle_get("/interaction/state", "session_id=" + sid, {}, None)
    chk("P1.state.get 200", code == 200, code)
    hits = []
    _find_key(st.get("states"), "knowledge", hits)
    chk("P1.state.states 无 knowledge 键", not hits, hits)
    code, recq = IH.handle_get("/interaction/receipt",
                               "session_id=%s&event_id=evt-q-1" % sid, {}, None)
    kgq = (recq or {}).get("knowledge_gained") or []
    chk("P1.receipt.get 200 且投影行恰一条（clue content 在列）",
        code == 200 and len(kgq) == 1
        and (kgq[0].get("entry") or {}).get("content") == "地窖钥匙在旧井",
        (code, [(r.get("action_id"), (r.get("entry") or {}).get("content")) for r in kgq]))
    IH._interpret = ORIG_INTERPRET


# ================================================================ P2 校验
def test_validation():
    print("== P2 白名单 / ID / 版本预检（均不得触发解释器）==")
    _reset_world()
    _inject_rules_only_core()
    sid = "zrev-val-s1"
    IH.handle_post_scene({"session_id": sid}, {}, None)
    versions = _get_versions(sid)
    counter = {"n": 0, "lock": threading.Lock()}
    IH._interpret = _stub_interp([], counter)

    cases = [
        ("scene 未知字段", IH.handle_post_scene({"session_id": sid, "actor": "x"}, {}, None), 422),
        ("scene 非法 ID", IH.handle_post_scene({"session_id": "坏/id!"}, {}, None), 422),
        ("prepare 未知字段", IH.handle_post_prepare(
            {"session_id": sid, "event_id": "e1", "message": "m",
             "expected_versions": versions, "actions": []}, {}, None), 422),
        ("prepare 非法 event_id", IH.handle_post_prepare(
            {"session_id": sid, "event_id": "e/1", "message": "m",
             "expected_versions": versions}, {}, None), 422),
        ("prepare message 4001 字", IH.handle_post_prepare(
            {"session_id": sid, "event_id": "e2", "message": "a" * 4001,
             "expected_versions": versions}, {}, None), 422),
        ("prepare expected 空映射", IH.handle_post_prepare(
            {"session_id": sid, "event_id": "e3", "message": "m",
             "expected_versions": {}}, {}, None), 422),
        ("prepare stale 版本", IH.handle_post_prepare(
            {"session_id": sid, "event_id": "e4", "message": "m",
             "expected_versions": dict(versions, player="v1:0:0:999")}, {}, None), 409),
        ("commit 未知字段", IH.handle_post_commit(
            {"session_id": sid, "event_id": "e5", "analysis_id": "x",
             "expected_versions": versions, "degree": "success"}, {}, None), 422),
        ("commit 非法 analysis_id 类型", IH.handle_post_commit(
            {"session_id": sid, "event_id": "e5", "analysis_id": 7,
             "expected_versions": versions}, {}, None), 422),
    ]
    for tag, (code, body), want in cases:
        chk("P2.%s" % tag, code == want and _err_code(body) == "INVALID_REQUEST"
            if want == 422 else code == want, (code, _err_code(body)))
    chk("P2.以上全部未触发解释器", counter["n"] == 0, counter["n"])

    code, body = IH.handle_get("/interaction/state", "session_id=x&session_id=y", {}, None)
    chk("P2.GET state 重复参数取首个不炸", code == 200, (code, _err_code(body)))
    code, body = IH.handle_get("/interaction/nope", "session_id=x", {}, None)
    chk("P2.GET 未知路由 404", code == 404 and _err_code(body) == "NOT_FOUND", code)
    code, body = IH.handle_get("/interaction/receipt", "session_id=" + sid, {}, None)
    chk("P2.receipt 缺 event_id 422", code == 422, (code, _err_code(body)))
    IH._interpret = ORIG_INTERPRET


# ================================================================ P3 同源守卫
def test_origin():
    print("== P3 同源守卫（_reject_foreign_origin 直接驱动）==")
    f = IH._reject_foreign_origin
    chk("P3.无 Origin 放行", f({}, None) is None and f({}, "http://127.0.0.1:8130") is None, None)
    st, body = f({"Origin": "http://evil.example"}, "http://127.0.0.1:8130")
    chk("P3.跨源 403 ORIGIN_FORBIDDEN",
        st == 403 and _err_code(body) == "ORIGIN_FORBIDDEN", (st, _err_code(body)))
    st, body = f({"Origin": "http://evil.example"}, None)
    chk("P3.受信 origin 未配置 fail-closed 403",
        st == 403 and _err_code(body) == "ORIGIN_FORBIDDEN", (st, _err_code(body)))
    chk("P3.尾斜杠等价",
        f({"Origin": "http://127.0.0.1:8130/"}, "http://127.0.0.1:8130") is None, None)
    chk("P3.同源放行", f({"Origin": "http://127.0.0.1:8130"}, "http://127.0.0.1:8130") is None, None)
    # 守卫发生在 scene 写入前：未初始化会话不该被跨源请求创建
    _reset_world()
    _inject_rules_only_core()
    st, body = IH.handle_post_scene({"session_id": "zrev-origin-s"},
                                    {"Origin": "http://evil.example"}, "http://127.0.0.1:9")
    chk("P3.跨源 scene 被拒且未创世", st == 403 and not IH.get_core().is_initialized("zrev-origin-s"),
        (st, _err_code(body)))


# ================================================================ P5 单飞/缓存
def test_singleflight():
    print("== P5 单飞 / 缓存 / 冲突 / 解释器故障 ==")
    _reset_world()
    _inject_rules_only_core()
    sid = "zrev-sf-s1"
    IH.handle_post_scene({"session_id": sid}, {}, None)
    versions = _get_versions(sid)
    counter = {"n": 0, "lock": threading.Lock()}
    IH._interpret = _stub_interp(
        [{"id": "a1", "operation": "communicate", "target_ids": ["lia"],
          "object_id": None, "mode": "attempt", "kind": "claim",
          "content": "你好", "evidence": "你好"}], counter, delay=0.4)

    out = []
    def _go(msg):
        out.append(IH.handle_post_prepare(
            {"session_id": sid, "event_id": "evt-sf-1", "message": msg,
             "expected_versions": versions}, {}, None))
    t1 = threading.Thread(target=_go, args=("你好",))
    t1.start()
    time.sleep(0.1)
    # 解释进行中：改载荷 → 冲突；同载荷另一请求 → PREPARE_IN_PROGRESS
    st_c, body_c = IH.handle_post_prepare(
        {"session_id": sid, "event_id": "evt-sf-1", "message": "改口",
         "expected_versions": versions}, {}, None)
    chk("P5.解释中改载荷 409 EVENT_PAYLOAD_CONFLICT",
        st_c == 409 and _err_code(body_c) == "EVENT_PAYLOAD_CONFLICT",
        (st_c, _err_code(body_c)))
    t2 = threading.Thread(target=_go, args=("你好",))
    t2.start()
    t1.join(); t2.join()
    codes = sorted((c, _err_code(b)) for c, b in out)
    chk("P5.并发同载荷一 200 一 409 PREPARE_IN_PROGRESS",
        codes == [(200, None), (409, "PREPARE_IN_PROGRESS")], codes)
    chk("P5.解释只调用一次", counter["n"] == 1, counter["n"])
    first_aid = [b.get("analysis_id") for c, b in out if c == 200][0]

    # 同载荷重试：缓存复用，不二次解释，同一 analysis_id
    st_r, body_r = IH.handle_post_prepare(
        {"session_id": sid, "event_id": "evt-sf-1", "message": "你好",
         "expected_versions": versions}, {}, None)
    chk("P5.重试复用缓存不二次解释",
        st_r == 200 and counter["n"] == 1 and body_r.get("analysis_id") == first_aid,
        (st_r, counter["n"], body_r.get("analysis_id") == first_aid))

    # 解释器抛异常 → 502 且释放占用（后续同事件可重新 Prepare）
    def _boom(session_id, message, actor_id="player"):
        raise RuntimeError("simulated interpreter crash")
    IH._interpret = _boom
    st_x, body_x = IH.handle_post_prepare(
        {"session_id": sid, "event_id": "evt-sf-2", "message": "你好",
         "expected_versions": versions}, {}, None)
    chk("P5.解释器异常 502 INTERPRETER_UNAVAILABLE",
        st_x == 502 and _err_code(body_x) == "INTERPRETER_UNAVAILABLE",
        (st_x, _err_code(body_x)))
    IH._interpret = _stub_interp(
        [{"id": "a1", "operation": "communicate", "target_ids": ["lia"],
          "object_id": None, "mode": "attempt", "kind": "claim",
          "content": "你好", "evidence": "你好"}], counter, delay=0.0)
    st_y, body_y = IH.handle_post_prepare(
        {"session_id": sid, "event_id": "evt-sf-2", "message": "你好",
         "expected_versions": versions}, {}, None)
    chk("P5.故障后占用已释放可重试", st_y == 200, (st_y, _err_code(body_y)))
    IH._interpret = ORIG_INTERPRET


# ================================================================ P7 发布失败错误回显
def test_publish_failure_repr():
    print("== P7 commit 发布段失败：_ProtoError.message 是否内嵌异常 repr 并原样到客户端 ==")
    _reset_world()
    _inject_rules_only_core()
    sid = "zrev-pf-s1"
    IH.handle_post_scene({"session_id": sid}, {}, None)
    versions = _get_versions(sid)
    marker = "SECRET-INTERNAL-MARKER/xyz"
    acts = [{"id": "a1", "operation": "communicate", "target_ids": ["lia"],
             "object_id": None, "mode": "attempt", "kind": "claim",
             "content": "你好", "evidence": "你好"}]
    IH._interpret = _stub_interp(acts)
    code, pv = IH.handle_post_prepare({"session_id": sid, "event_id": "evt-pf-1",
                                       "message": "你好", "expected_versions": versions},
                                      {}, None)
    assert code == 200, (code, pv)
    orig_bump = B.PROTOCOL._bump_revision
    try:
        def _boom(scope):
            raise ValueError(marker)
        B.PROTOCOL._bump_revision = _boom
        code, rec = IH.handle_post_commit({"session_id": sid, "event_id": "evt-pf-1",
                                           "analysis_id": pv["analysis_id"],
                                           "expected_versions": versions}, {}, None)
        msg = ((rec or {}).get("error") or {}).get("message", "")
        chk("P7.发布失败 500 INTERNAL_ERROR", code == 500
            and _err_code(rec) == "INTERNAL_ERROR", (code, _err_code(rec)))
        chk("P7.异常 repr 内嵌 message 并原样透传客户端（%r in message）" % marker,
            marker in msg, msg[:120])
    finally:
        B.PROTOCOL._bump_revision = orig_bump
        IH._interpret = ORIG_INTERPRET
    # 回滚后状态可用：同一 event 重新 Prepare 应成功（版本未推进、候选未残留）
    code2, pv2 = IH.handle_post_prepare({"session_id": sid, "event_id": "evt-pf-1",
                                         "message": "你好", "expected_versions": versions},
                                        {}, None)
    chk("P7.回滚后同事件可重新 Prepare", code2 == 200, (code2, _err_code(pv2)))


# ================================================================ P4 fail-closed + P6 翻译锁
def test_failclosed_and_xlate():
    print("== P4 fail-closed / P6 运行翻译锁串行化 ==")
    _reset_world()  # core=None, config_error=None
    try:
        IH.handle_get("/interaction/state", "session_id=x", {}, None)
        chk("P4.未配置 get_core 抛 RuntimeError", False, "未抛错")
    except RuntimeError as e:
        chk("P4.未配置 get_core 抛 RuntimeError", "生产 Provider 未配置" in str(e), str(e)[:60])
    chk("P4.未静默造单例", IH._SINGLETON["core"] is None, None)

    # P6：lookup 持 xlate_lock 调 _cached_translate → 并发查询串行化（无云端：打桩计时）
    def slow_translate(text, cache):
        time.sleep(0.4)
        return "EN-" + text
    B._cached_translate = slow_translate
    try:
        lookup = IH.build_runtime_translate()
        got = []
        def _lk(t):
            got.append(lookup(t))
        t0 = time.time()
        ths = [threading.Thread(target=_lk, args=("zh-%d" % i,)) for i in range(3)]
        for t in ths:
            t.start()
        for t in ths:
            t.join()
        dt = time.time() - t0
        # 3 个 0.4s 串行 ≈ 1.2s；若真并行应 ≈0.4s
        chk("P6.xlate_lock 串行化（3×0.4s ≈ %.2fs ≥ 1.0）" % dt,
            all(g.startswith("EN-zh-") for g in got) and dt >= 1.0, "%.2fs" % dt)
    finally:
        B._cached_translate = ORIG_TRANSLATE
        with IH._SINGLETON["xlate_lock"]:
            IH._SINGLETON["xlate_cache"].clear()
            IH._SINGLETON["xlate_disk_loaded"] = False


def main():
    t0 = time.time()
    print("== ZCode HTTP 边界复核探针（d446336，零云端/零监听/打桩驱动）==")
    test_privacy()
    test_validation()
    test_origin()
    test_singleflight()
    test_publish_failure_repr()
    test_failclosed_and_xlate()
    IH._interpret = ORIG_INTERPRET
    B._cached_translate = ORIG_TRANSLATE
    print("== 结果：%d 项断言，%d 失败；耗时 %.2fs ==" % (N[0], len(FAIL), time.time() - t0))
    if FAIL:
        print("失败项：" + "、".join(FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
