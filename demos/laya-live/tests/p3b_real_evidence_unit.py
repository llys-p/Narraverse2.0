"""P3-B · 真实 Laya Evidence 最薄闭环 · 零推理定向检查（零模型、零 Laya 权重、零云端）。

只验证「真实模型信号」适配器的映射与门禁，用**可替换推理函数**（fake infer）与**可替换
翻译**（fake xlate）注入；不加载 Laya、不调 CUDA、不发真实推理。真实小样见 `_diag/p3b_real_probe.py`。

覆盖《P3-B 真实 Laya Evidence 最薄闭环》与 P3-B 续作要求：
  B1  翻译只读冻结资产：命中返回英文，缺失 fail-closed（None，不在线补译）。
  B2  门禁：engine=fallback / 档案不 matched / 不 fresh → 无可写 Evidence。
  B3  逐项核对提取：source_signal=doubt_shift 且 role=state_shift 且 status=active 且
      target=relationship.doubt 且 checkpoint/profile_id 一致 且 may_write_state=true；
      错 role / 错 target / 错 checkpoint / may_write 非 true → 不写；auxiliary 不写。
  B4  隔离规则修正：default_real_infer 以 apply_adjudication=False 调 analyze_core，
      frozen_state 作为**函数参数**（不放 payload），payload 不含 frozen_state。
  B5  经 core 链路：真实 Evidence 产生 doubt 写项，Prepare 零写、Commit 落盘、下一轮可读；
      无可写时 rules_only=true。
  B6  真实档案身份源：real_capability_identity 以 force=True 重读（绕过 mtime 缓存）。
  B7  config freshness 行尾兼容：CRLF 工作区 raw sha != lf sha，lf sha 精确等于档案 sha；
      真实内容变化（两个 sha 都失配）→ 仍不 fresh。
  R4  身份绑定档案内容 SHA + 实际模型名：同 mtime 替换档案内容（改 doubt_shift.may_write_state、
      保留 profile_id/mtime）→ Commit 409 CAPABILITY_CHANGED、零写入；ENGINE 实际 model_name
      改变 → 旧候选失效；档案不可读 → 身份源 fail-closed。

★ 运行环境：Windows 控制台默认 GBK 编不出 ✅，请用
  `PYTHONIOENCODING=utf-8 python tests/p3b_real_evidence_unit.py`
"""
import copy
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B
import laya_evidence as EV
from laya_delivery_core import WORLD, DeliveryCore
from laya_state_protocol import _ProtoError  # noqa: F401

FAIL = []
N = [0]


def chk(tag, ok, detail=""):
    N[0] += 1
    print("  %s [%s] %s" % ("✅" if ok else "❌", tag, detail))
    if not ok:
        FAIL.append(tag)


def fresh(sid, provider=None, capability_identity=None):
    B.reset_actor_state()
    B.reset_history()
    B._PENDING.clear()
    P = B.PROTOCOL
    with P.lock:
        P._events.clear()
        P._buckets.clear()
        P._analyses.clear()
        P._inflight.clear()
    core = DeliveryCore(B, protocol=P, evidence_provider=provider,
                        capability_identity=capability_identity)
    core.ensure_scene(sid)
    return core, P


def doubt(core, sid):
    return core.state(sid)["states"]["lia"]["relationship"]["doubt"]


def ask(aid="a1", content="今晚人多吗？"):
    return {"id": aid, "operation": "communicate", "target_ids": ["lia"],
            "object_id": None, "mode": "attempt", "kind": "question",
            "content": content, "evidence": content}


def prep(core, sid, actions, ev="ev1"):
    return core.prepare_structured({"session_id": sid, "event_id": ev, "actor_id": "player",
                                    "expected_versions": core.state(sid)["versions"],
                                    "actions": actions})


def commit(core, sid, pv, ev="ev1"):
    return core.commit({"session_id": sid, "event_id": ev,
                        "analysis_id": pv["analysis_id"],
                        "expected_versions": pv["base_versions"]})


def real_result(*, engine="laya", matched=True, fresh=True, delta=3.0, status="active",
                role="state_shift", target="relationship.doubt", may_write=True,
                checkpoint="typed-decisions", profile_id="fp_t", auxiliaries=None):
    """构造 fake analyze_core 返回结构（含逐项核对所需字段）。

    `auxiliaries`：auxiliary 条目列表（P3-C 用），如
    `[{"source_signal": "trust_shift", "role": "state_shift", "delta_if_enabled": 0.7}]`。
    """
    proposal = {
        "profile": {"checkpoint": checkpoint, "profile_id": profile_id,
                    "matched": matched, "fresh": fresh,
                    "problems": [] if (matched and fresh) else ["x"]},
        "delta": ([{"source_signal": "doubt_shift", "status": status, "role": role,
                    "target": target, "delta": delta, "checkpoint": checkpoint,
                    "profile_id": profile_id}] if status == "active" else []),
        "auxiliary": list(auxiliaries or []),
        "ignored_signals": [],
    }
    state_writable = ["doubt_shift"] if may_write else []
    return {"engine": engine, "state_proposal": proposal,
            "capability_summary": {"state_writable": state_writable},
            "signal_values": {"doubt": 0.6}}


def _ev(result, cand):
    """取 `_evidence_from_real_result` 的 evidence 列表（P3-C 起该函数返回 dict）。"""
    return EV._evidence_from_real_result(result, cand)["evidence"]


def _absent(result, cand):
    """取 `_evidence_from_real_result` 的缺席原因。"""
    return EV._evidence_from_real_result(result, cand)["absent_reason"]


# ------------------------------------------------------------------ B1 翻译
def test_translation_lookup():
    chk("B1-① 冻结译文命中三句固定样本",
        all(EV.translation_cache_lookup(s) for s in
            ("今晚人多吗？", "你上次跟那个戴兜帽的人说了什么？我要听原话。",
             "灰鸦到底藏在哪？你一定知道，现在告诉我。")), "")
    chk("B1-② 缺失译文返回 None（不在线补译）",
        EV.translation_cache_lookup("这句不在冻结资产里_哨兵") is None, "")


# ------------------------------------------------------------------ B2/B3 门禁与逐项核对提取
def test_evidence_from_real_result_gates():
    cand = {"action_id": "a1", "listener": "lia"}
    ev = _ev(real_result(delta=3.0), cand)
    chk("B3-① 正常 laya+active 提取一条 doubt_shift Evidence",
        len(ev) == 1 and ev[0]["source"] == EV.SOURCE_REAL
        and ev[0]["signals"][0]["delta"] == 3.0, str(ev))
    chk("B2-① engine=fallback → 无可写 Evidence",
        _ev(real_result(engine="fallback"), cand) == [], "")
    chk("B2-② 档案不 fresh → 无可写 Evidence",
        _ev(real_result(fresh=False), cand) == [], "")
    chk("B2-③ 档案不 matched（错误检查点）→ 无可写 Evidence",
        _ev(real_result(matched=False), cand) == [], "")
    # 逐项核对：错 role / 错 target / 错 checkpoint / may_write 非 true
    chk("B3-② 错 role（非 state_shift）→ 不写",
        _ev(real_result(role="behavior_tendency"), cand) == [], "")
    chk("B3-③ 错 target（非 relationship.doubt）→ 不写",
        _ev(real_result(target="relationship.trust"), cand) == [], "")
    # delta.checkpoint 与 profile.checkpoint 不一致 → 不写
    r = real_result(checkpoint="typed-decisions")
    r["state_proposal"]["delta"][0]["checkpoint"] = "other-checkpoint"   # 篡改为不一致
    chk("B3-④ 错 checkpoint（delta 与 profile 不一致）→ 不写", _ev(r, cand) == [], "")
    # may_write_state 非 true（doubt_shift 不在 state_writable）
    chk("B3-⑤ may_write_state 非 true → 不写", _ev(real_result(may_write=False), cand) == [], "")
    # P3-C：status 非 active 的 doubt_shift 不进 delta，且无 auxiliary → evidence 空
    chk("B3-⑥ status 非 active 且无 auxiliary → evidence 空",
        _ev(real_result(status="auxiliary"), cand) == [], "")


# ------------------------------------------------------------------ B4 隔离规则修正 + frozen_state 参数
def test_default_real_infer_skips_adjudication_and_passes_frozen_state():
    npc_state = {"relationship": {"doubt": 30}, "emotion": {}, "goals": {}}
    with mock.patch.object(B, "analyze_core", return_value={"engine": "laya"}) as m:
        EV.default_real_infer("今晚人多吗？", "Are there many people tonight?",
                              npc_state, "lia", "sess-1")
        args, kwargs = m.call_args
    chk("B4-① apply_adjudication=False（隔离规则修正）",
        kwargs.get("apply_adjudication") is False, str(kwargs.get("apply_adjudication")))
    chk("B4-② frozen_state 作为函数参数传入（不放 payload）",
        kwargs.get("frozen_state") is npc_state and "frozen_state" not in args[0],
        "payload_keys=%s" % sorted(args[0].keys()))
    chk("B4-③ payload 只含服务端字段（actor/actor_id/session_id/player_input/player_input_en）",
        set(args[0].keys()) == {"actor", "actor_id", "session_id",
                                "player_input", "player_input_en"},
        str(sorted(args[0].keys())))


# ------------------------------------------------------------------ B5 经 core 链路
def test_real_provider_through_core():
    def infer(zh, en, npc_state, listener, session_id):
        return real_result(delta=3.0)

    core, P = fresh("p3b-e2e", EV.make_real_evidence_provider(
        infer=infer, xlate_lookup=lambda zh: "Are there many people tonight?"))
    before = doubt(core, "p3b-e2e")
    pv = prep(core, "p3b-e2e", [ask()])
    chk("B5-① 真实 Evidence 经 State Transition 产生 doubt 写项（30→33）",
        pv["status"] == "ready" and pv["rules_only"] is False
        and any(c["path"] == "relationship.doubt" and c["after"] == 33.0
                for c in pv["state_proposal"]["changes"]), str(pv["laya_evidence"]))
    chk("B5-② Evidence source=laya（非 test_fixture）",
        pv["laya_evidence"][0]["source"] == EV.SOURCE_REAL, "")
    chk("B5-③ Prepare 零游戏写入",
        doubt(core, "p3b-e2e") == before, "before=%s after=%s" % (before, doubt(core, "p3b-e2e")))
    rec = commit(core, "p3b-e2e", pv)
    chk("B5-④ Commit 后 doubt 落盘（33），下一轮可读",
        rec["status"] == "committed" and doubt(core, "p3b-e2e") == 33.0,
        "doubt=%s" % doubt(core, "p3b-e2e"))


def test_real_provider_no_writable():
    core, P = fresh("p3b-xlate-miss", EV.make_real_evidence_provider(
        infer=lambda *a: real_result(delta=3.0), xlate_lookup=lambda zh: None))
    pv = prep(core, "p3b-xlate-miss", [ask()])
    chk("B5-⑤ 翻译缺失 → 无可写 Evidence，规则动作仍成立（rules_only=true）",
        pv["status"] == "ready" and pv["rules_only"] is True
        and pv["laya_evidence"] == [], str(pv["laya_evidence"]))

    core2, P2 = fresh("p3b-fallback", EV.make_real_evidence_provider(
        infer=lambda *a: real_result(engine="fallback"),
        xlate_lookup=lambda zh: "Are there many people tonight?"))
    pv2 = prep(core2, "p3b-fallback", [ask()])
    chk("B5-⑥ engine=fallback → 无可写 Evidence（rules_only=true）",
        pv2["rules_only"] is True and pv2["laya_evidence"] == [], str(pv2["laya_evidence"]))


# ------------------------------------------------------------------ B6 真实档案身份源（force 重读）
def test_real_capability_identity_force():
    with mock.patch.object(B, "load_capability_profile",
                           return_value=(None, {"checkpoint": "typed-decisions",
                                                "profile_id": "fp_t",
                                                "matched": True, "fresh": True})) as m:
        ident = EV.real_capability_identity()
    chk("B6-① real_capability_identity 以 force=True 重读（绕过 mtime 缓存）",
        m.call_args.kwargs.get("force") is True, str(m.call_args))
    chk("B6-③ 身份含档案内容 SHA256 与 ENGINE 实际 model_name",
        bool(ident.get("profile_sha256")) and bool(ident.get("engine_model")), str(ident))


# ------------------------------------------------- R4 身份绑定档案内容 SHA + 实际模型名
def test_identity_detects_profile_content_change_same_profile_id():
    """Prepare 后同 mtime 替换档案内容（改 may_write_state、保留 profile_id）→ Commit 409、零写入。"""
    import json as _json
    import os as _os
    import shutil as _shutil
    import tempfile as _tempfile
    tmp = Path(_tempfile.mkdtemp()) / "capability_profiles.json"
    _shutil.copy(B.CAPABILITY_PATH, tmp)
    _arch_cfg_sha, arch_ck_id = _arch_ids()
    with mock.patch.object(B, "CAPABILITY_PATH", tmp), \
         mock.patch.object(B, "_checkpoint_fingerprint", return_value={"id": arch_ck_id}):
        core, P = fresh("p3b-ident-content", EV.fixture_provider(3.0),
                        capability_identity=EV.real_capability_identity)
        pv = prep(core, "p3b-ident-content", [ask()])
        before = doubt(core, "p3b-ident-content")
        # 临时档案里改 doubt_shift 的写入资格，保留 profile_id（不改 evidence），保留 mtime
        blob = _json.loads(tmp.read_text(encoding="utf-8"))
        sig = blob["profiles"]["typed-decisions"]["signals"]["doubt_shift"]
        pid_before = blob["profiles"]["typed-decisions"].get("profile_id")
        sig["may_write_state"] = False
        st = tmp.stat()
        tmp.write_text(_json.dumps(blob, ensure_ascii=False), encoding="utf-8")
        _os.utime(tmp, (st.st_atime, st.st_mtime))          # 恢复 mtime
        blob2 = _json.loads(tmp.read_text(encoding="utf-8"))
        err = None
        try:
            commit(core, "p3b-ident-content", pv)
        except _ProtoError as e:
            err = e
        chk("R4-① profile_id 与 mtime 不变、仅改 may_write_state → Commit 409 CAPABILITY_CHANGED",
            err is not None and err.code == "CAPABILITY_CHANGED",
            "code=%s profile_id_unchanged=%s"
            % (getattr(err, "code", None),
               pid_before == blob2["profiles"]["typed-decisions"].get("profile_id")))
        chk("R4-② 身份变化后状态零写入",
            doubt(core, "p3b-ident-content") == before, "doubt=%s" % doubt(core, "p3b-ident-content"))


def test_identity_detects_engine_model_change():
    """Prepare 后 ENGINE 实际 model_name 改变 → 旧候选 Commit 失效。"""
    core, P = fresh("p3b-ident-model", EV.fixture_provider(3.0),
                    capability_identity=EV.real_capability_identity)
    pv = prep(core, "p3b-ident-model", [ask()])
    before = doubt(core, "p3b-ident-model")
    with mock.patch.object(B.ENGINE, "model_name", "english"):
        err = None
        try:
            commit(core, "p3b-ident-model", pv)
        except _ProtoError as e:
            err = e
    chk("R4-③ 实际模型名改变 → Commit 409 CAPABILITY_CHANGED、零写入",
        err is not None and err.code == "CAPABILITY_CHANGED"
        and doubt(core, "p3b-ident-model") == before,
        "code=%s" % getattr(err, "code", None))


def test_identity_fail_closed_when_profile_unreadable():
    """档案不可读（SHA 取不到）→ 身份源 fail-closed（抛错，不返回可用身份）。"""
    with mock.patch.object(B, "_sha256_file", return_value=None):
        err = None
        try:
            ident = EV.real_capability_identity()
        except Exception as e:  # noqa: BLE001
            err = e
            ident = None
    chk("R4-④ 档案不可读 → 身份源抛错（fail-closed）",
        err is not None and ident is None, str(err))


def test_load_capability_profile_force_bypasses_mtime():
    B.load_capability_profiles()          # 预热 mtime 缓存
    B._CAP_PROFILE_CACHE["blob"] = {"profiles": {"typed-decisions": {"checkpoint": "FAKE-FROM-CACHE"}}}
    prof, check = B.load_capability_profile(force=True)   # force 重读真实文件
    chk("B6-② force=True 绕过 mtime 缓存，重读真实档案",
        check["checkpoint"] == "typed-decisions", "checkpoint=%s" % check.get("checkpoint"))


# ------------------------------------------------------------------ B7 config freshness 行尾兼容
def _arch_ids():
    blob = B.load_capability_profiles()
    prof = (blob.get("profiles") or {}).get("typed-decisions") or {}
    ev = prof.get("evidence") or {}
    return (ev.get("config") or {}).get("sha"), (ev.get("checkpoint") or {}).get("id")


def test_config_freshness_line_ending():
    fp = B._config_fingerprint()
    arch_cfg_sha, arch_ck_id = _arch_ids()
    chk("B7-① CRLF 工作区：raw sha != lf sha",
        fp.get("sha") != fp.get("sha_lf"),
        "raw=%s lf=%s" % (fp.get("sha")[:8], (fp.get("sha_lf") or "")[:8]))
    chk("B7-② 仅 CRLF→LF 后 sha 精确等于档案 config.sha",
        fp.get("sha_lf") == arch_cfg_sha,
        "lf=%s arch=%s" % ((fp.get("sha_lf") or "")[:8], arch_cfg_sha[:8]))
    # 行尾兼容命中后档案 fresh（mock checkpoint 一致，隔离模型目录依赖）
    with mock.patch.object(B, "_checkpoint_fingerprint", return_value={"id": arch_ck_id}):
        _prof2, check2 = B.load_capability_profile(force=True)
    chk("B7-③ 行尾兼容命中后档案 fresh，且记录 config_line_ending_compat",
        check2.get("fresh") is True and "config_line_ending_compat" in check2,
        str(check2.get("config_line_ending_compat")))


def test_config_freshness_rejects_real_change():
    _arch_cfg_sha, arch_ck_id = _arch_ids()
    # 真实内容变化：raw 与 lf 都与档案不符（两个 sha 同时失配）→ 仍不 fresh
    with mock.patch.object(B, "_config_fingerprint",
                           return_value={"path": "x", "sha": "deadbeef", "sha_lf": "cafebabe"}), \
         mock.patch.object(B, "_checkpoint_fingerprint", return_value={"id": arch_ck_id}):
        _prof, check = B.load_capability_profile(force=True)
    chk("B7-④ 真实内容变化（两个 sha 都失配）→ 仍不 fresh",
        check.get("fresh") is False
        and any("narra_config.json" in p for p in check.get("problems") or []),
        str(check.get("problems")))


def main():
    test_translation_lookup()
    test_evidence_from_real_result_gates()
    test_default_real_infer_skips_adjudication_and_passes_frozen_state()
    test_real_provider_through_core()
    test_real_provider_no_writable()
    test_real_capability_identity_force()
    test_identity_detects_profile_content_change_same_profile_id()
    test_identity_detects_engine_model_change()
    test_identity_fail_closed_when_profile_unreadable()
    test_load_capability_profile_force_bypasses_mtime()
    test_config_freshness_line_ending()
    test_config_freshness_rejects_real_change()
    print("\nP3-B 真实 Laya Evidence 零推理定向检查：%d 项，%d 失败" % (N[0], len(FAIL)))
    if FAIL:
        print("失败项：" + "、".join(FAIL))
        return 1
    print("全部通过（零模型、零 Laya 权重、零云端、零 HTTP）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
