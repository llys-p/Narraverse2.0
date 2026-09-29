"""P3-D1 · Interaction Core HTTP 编排层（/interaction/*）。

把「公开 state → 显式创世 → 解释 → Prepare → Commit → 下轮 state/回执」接到现有
`laya_bridge.Handler` 上。**本模块不做**：页面、叙事、玩法公式、真实云端/CUDA。

权威边界（对齐 docs/interaction-core/P3-D-HTTP-协议-v0.1.md）：
  · 服务端进程内**只一个** `DeliveryCore`（`get_core()`），共享 PROTOCOL 锁/版本/桶/事件表；
    绝不按请求新建 Core。
  · 客户端只能提交 `session_id/event_id/message/expected_versions`（prepare）或
    `session_id/event_id/analysis_id/expected_versions`（commit）；不能提交动作、事实、
    Evidence、状态 delta 或档案身份。
  · 云端解释之前按 `(session_id,event_id)` 单飞 + 短期同请求缓存：并发同请求只解释一次；
    同 event 改载荷/版本 → 冲突；同请求重试复用已校验解释与候选，不重复计费。
  · 公开响应按玩家视角投影：候选引用、版本、逐动作结果、可见状态变更、精简 Evidence/
    缺席原因；**不直出**目录、原始模型响应、NPC 未披露私有知识或 Provider 输入。
  · 运行翻译与冻结基线分开：复用 `_cached_translate` 纪律（基准只读冻结、未知输入冻结→
    运行缓存→在线），运行缓存单独锁、绝不写 tests/assets；失败返回 None → Evidence 缺席
    `translation_missing`。
  · 只监听 127.0.0.1；/interaction/* 处理前拒绝非同源 `Origin`（含 OPTIONS），旧端点不变。
"""

import copy as _copy
import json
import re
import threading
import time
import uuid

# 延迟导入，避免在 import 期把 laya_bridge 的重型依赖拉进来（本模块由 Handler 注入使用）。
_lazy = {}


def _mods():
    if not _lazy:
        import laya_bridge as B
        import laya_delivery_core as C
        import laya_delivery_interpreter as I
        import laya_evidence as E
        from laya_state_protocol import _ProtoError
        _lazy.update(B=B, C=C, I=I, E=E, _ProtoError=_ProtoError)
    return _lazy


DELIVERY_PROTOCOL_VERSION = "laya-delivery-v1"

# Prepare 只允许这些字段（严格白名单）；其余 422。
PREPARE_ALLOWED = {"session_id", "event_id", "message", "expected_versions"}
# Commit 只允许这些字段。
COMMIT_ALLOWED = {"session_id", "event_id", "analysis_id", "expected_versions"}
# 场景创世只允许 session_id。
SCENE_ALLOWED = {"session_id"}
# ★ P3-D3：叙事只接受回执身份（session/event/commit）；玩家原话由服务端 Prepare 时
#   保存的私有上下文提供，客户端不得重报 message/状态/动作/Evidence。
NARRATE_ALLOWED = {"session_id", "event_id", "commit_id"}

# 短期同请求缓存 / in-flight 上限（有界，不作正式状态）。
_INFLIGHT_MAX = 256
_CACHE_MAX = 256
_CACHE_TTL_S = 600.0  # 与 DeliveryCore.READY_TTL_S 一致：候选有效期内重试不重复调用云端

# ★ P3-D3：叙事私有上下文与成功台词缓存（有界；缺失即拒绝叙事，绝不猜原话）。
_NARRATE_CTX_MAX = 256
_NARRATE_CACHE_MAX = 256

# session_id / event_id 统一格式（与 core._ID_RE 同口径）：1–64 位 [A-Za-z0-9_-]。
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

_SINGLETON = {
    "core": None,          # DeliveryCore（进程内唯一）
    "lock": threading.RLock(),
    "inflight": {},        # (session_id,event_id) -> {"message","versions","started_at"}
    "cache": {},           # (session_id,event_id) -> {"message","versions","interp","prepared_at"}
    # P3-D3：Prepare 成功时绑定的叙事私有上下文（message/analysis_id，不随候选过期而丢）；
    # 成功台词缓存（同 commit_id 复用，避免重复付费）。两者皆有界、非正式状态。
    "narrate_ctx": {},     # (session_id,event_id) -> {"message","analysis_id","saved_at"}
    "narrate_cache": {},   # (session_id,event_id) -> {"commit_id","line","saved_at"}
    "narrate_inflight": {},  # (session_id,event_id) -> {"commit_id","started_at"}（单飞占位）
    "narrate_caller": None,  # 叙事生成器（可注入桩；None → 503 NARRATOR_UNAVAILABLE）
    "xlate_lock": threading.Lock(),
    "xlate_cache": {},     # 运行翻译缓存（独立锁，绝不写冻结资产）
    "xlate_disk_loaded": False,  # 运行翻译磁盘缓存首用装载标记（重启后可复用既有缓存）
    "config_error": None,  # 生产配置失败原因（非 None 时无参 get_core() fail-closed）
    "explain_calls": [0],  # 定向核对用：云端解释实际调用次数
}


def _valid_id(v):
    return isinstance(v, str) and bool(_ID_RE.match(v))


def _interpret(session_id, message, actor_id="player"):
    """服务端解释入口（单飞与缓存之外的实际调用点）。返回 interpret_turn 结果。"""
    mods = _mods()
    core = get_core()
    result = mods["I"].interpret_turn(core, session_id, message,
                                      actor_id=actor_id, event_id=None,
                                      history=None, p1_projection=False)
    _SINGLETON["explain_calls"][0] += 1
    return result


def get_core(provider=None, capability_identity=None, runtime_translate=None):
    """取进程内唯一 DeliveryCore（首次创建；重复调用返回同一实例）。

    生产：由服务端配置注入真实 `make_real_evidence_provider` + `real_capability_identity`，
    并用带运行翻译的 provider（见 build_runtime_translate）。测试可注入固定桩。
    **无参调用且生产配置未完成 → 抛错（fail-closed）**：绝不静默创建
    `evidence_provider=None` 的 rules-only 单例。
    """
    mods = _mods()
    with _SINGLETON["lock"]:
        if _SINGLETON["core"] is None:
            if provider is None and capability_identity is None:
                err = _SINGLETON.get("config_error")
                raise RuntimeError("生产 Provider 未配置（%s）；main() 必须先 configure_real()"
                                   % (err or "configure_real 未调用"))
            B = mods["B"]
            C = mods["C"]
            _SINGLETON["core"] = C.DeliveryCore(
                B, protocol=B.PROTOCOL,
                evidence_provider=provider,
                capability_identity=capability_identity)
            _SINGLETON["core"]._runtime_translate = runtime_translate
        return _SINGLETON["core"]


def _reset_singleton():
    """仅测试用：重置单例与单飞/缓存（不碰正式状态桶）。"""
    with _SINGLETON["lock"]:
        _SINGLETON["core"] = None
        _SINGLETON["inflight"] = {}
        _SINGLETON["cache"] = {}
        _SINGLETON["narrate_ctx"] = {}
        _SINGLETON["narrate_cache"] = {}
        _SINGLETON["narrate_inflight"] = {}
        _SINGLETON["narrate_caller"] = None
        _SINGLETON["xlate_cache"].clear()
        _SINGLETON["xlate_disk_loaded"] = False
        _SINGLETON["config_error"] = None
    _SINGLETON["explain_calls"][0] = 0


def _evict_oldest(store, time_key):
    """容量满时淘汰最旧条目（有界，不无界新增）。调用方需持锁。"""
    if not store:
        return
    oldest = min(store, key=lambda k: store[k][time_key])
    store.pop(oldest, None)


def _store_narrate_ctx(sid, event_id, message, analysis_id):
    """Prepare 成功时把玩家原话绑定到 (session,event)+analysis_id（叙事私有上下文）。

    只存服务端在 Prepare 收到的原话；客户端 narrate 请求不得重报。有界（满则淘汰最旧）。
    调用方需持锁。
    """
    if not analysis_id:
        return
    if len(_SINGLETON["narrate_ctx"]) >= _NARRATE_CTX_MAX:
        _evict_oldest(_SINGLETON["narrate_ctx"], "saved_at")
    _SINGLETON["narrate_ctx"][(sid, event_id)] = {
        "message": message, "analysis_id": analysis_id, "saved_at": time.time()}


def _reject_foreign_origin(headers, actual_origin):
    """/interaction/* 的同源前置：带 Origin 的请求必须与受信 origin 一致。

    返回 None 表示放行；返回 (http, body) 表示拒绝。无 Origin 的本机诊断请求放行；
    **受信 origin 未配置时带 Origin 一律拒绝**（fail-closed，不静默放行外站）。
    """
    origin = headers.get("Origin")
    if not origin:
        return None
    if not actual_origin:
        return (403, {"protocol_version": DELIVERY_PROTOCOL_VERSION,
                      "error": {"code": "ORIGIN_FORBIDDEN",
                                "message": "受信 origin 未配置，拒绝带 Origin 的请求",
                                "details": {"origin": origin}}})
    if origin.rstrip("/") != actual_origin.rstrip("/"):
        return (403, {"protocol_version": DELIVERY_PROTOCOL_VERSION,
                      "error": {"code": "ORIGIN_FORBIDDEN",
                                "message": "跨源请求被拒绝（/interaction/* 仅限同源）",
                                "details": {"origin": origin}}})
    return None


def _project_knowledge_gained(gained_rows):
    """本轮知识条目 → 玩家视角：仅筛 `actor_id=player` 的条目（莉亚未披露的私有知识
    绝不出现在玩家回执里），条目本身精简投影（不含 `about`/`learned_turn` 快照字段）。"""
    out = []
    for row in gained_rows or []:
        if row.get("actor_id") != "player":
            continue
        entry = row.get("entry") or {}
        out.append({
            "action_id": row.get("action_id"),
            "status": row.get("status"),
            "entry": {
                "entry_id": entry.get("entry_id"),
                "kind": entry.get("kind"),
                "content": entry.get("content"),
                "source": entry.get("source"),
                "told_by": entry.get("told_by"),
                "objective": entry.get("objective"),
                "as_of_turn": entry.get("as_of_turn"),
            },
        })
    return out


def _player_view_preview(pv):
    """候选预览 → 玩家视角白名单（精简，不直出目录/原始响应/Provider 输入）。"""
    resolutions = []
    knowledge_gained = []
    for r in (pv.get("outcome") or {}).get("resolutions") or []:
        resolutions.append({
            "action_id": r.get("action_id"), "operation": r.get("operation"),
            "execution_status": r.get("execution_status"), "degree": r.get("degree"),
            "target_id": r.get("target_id"),
        })
        knowledge_gained.extend(r.get("knowledge_gained") or [])
    # 可见状态变更：只保留非 knowledge 的写项（knowledge 属于私有，不进公开视图）。
    changes = []
    for ch in (pv.get("state_proposal") or {}).get("changes") or []:
        if ".knowledge" in str(ch.get("path")):
            continue
        changes.append({"entity_id": ch.get("entity_id"), "path": ch.get("path"),
                        "before": ch.get("before"), "after": ch.get("after"),
                        "source": ch.get("source")})
    return {
        "protocol_version": DELIVERY_PROTOCOL_VERSION,
        "status": pv.get("status"),
        "event_id": pv.get("event_id"),
        "analysis_id": pv.get("analysis_id"),
        "base_versions": _copy.deepcopy(pv.get("base_versions") or {}),
        "can_commit": bool(pv.get("can_commit")),
        "expires_at": pv.get("expires_at"),
        "resolutions": resolutions,
        "rules_only": pv.get("rules_only", True),
        "laya_evidence": _copy.deepcopy(pv.get("laya_evidence") or []),
        "evidence_absent_reason": pv.get("evidence_absent_reason"),
        "changes": changes,
        "reason_codes": pv.get("reason_codes") or [],
        "knowledge_gained": _project_knowledge_gained(knowledge_gained),
    }


def _error_body(code, message, details=None, http=400):
    return http, {"protocol_version": DELIVERY_PROTOCOL_VERSION,
                  "error": {"code": code, "message": message, "details": details}}


def build_runtime_translate():
    """构造「运行翻译」查询 callable：复用 `_cached_translate` 纪律（基准只读冻结、
    未知输入冻结→运行缓存→在线），运行缓存独立锁，绝不写 tests/assets。失败返回 None。

    首用时把既有**可写运行缓存文件**（`laya_bridge._XLATE_DISK`）读进内存，进程重启后
    同句不重复付费；装载失败静默继续（空缓存起跑，不影响 fail-closed 语义）。

    定向核对用桩替换本函数，避免真实在线翻译额度。
    """
    mods = _mods()

    def lookup(text):
        with _SINGLETON["xlate_lock"]:
            if not _SINGLETON["xlate_disk_loaded"]:
                _SINGLETON["xlate_disk_loaded"] = True
                try:
                    blob = json.loads(mods["B"]._XLATE_DISK.read_text(encoding="utf-8"))
                    if isinstance(blob, dict):
                        _SINGLETON["xlate_cache"].update(blob)
                except Exception:
                    pass
            return mods["B"]._cached_translate(text, _SINGLETON["xlate_cache"])
    return lookup


def make_cloud_narrate_caller():
    """生产叙事生成器（P3-D3b）：把 D3 已构造的 sys_p/user_p 经 `llm_chat_raw`
    发往云端，返回原始 content（`<line>` 提取由 handle_post_narrate 统一做）。

    不建行为提案、不调旧 /narrate 的隐式 decide、不回落台词池；传输失败/空内容
    → 抛错（上层 502 NARRATION_FAILED，已提交状态与回执不变）。原始响应、推理
    内容与 Prompt 不回流、不进日志。
    """
    mods = _mods()

    def caller(facts, sys_p, user_p):
        content, err = mods["B"].llm_chat_raw(sys_p, user_p)
        if err:
            raise RuntimeError("cloud_narrate_%s" % err)
        return content
    return caller


def configure_real():
    """生产启动配置（`laya_bridge.main()` 在 `serve_forever` 前调用一次）。

    在**任何** GET/scene/prepare 可创建单例之前，把生产 Core 固定为：
      · `make_real_evidence_provider(xlate_lookup=运行翻译)`（真实 Evidence Provider，
        运行翻译与冻结资产分离）；
      · `real_capability_identity`（服务端档案/检查点身份源，Commit 时重读）；
      · P3-D3b：叙事生成器——**配置了云端凭据**才注入 `make_cloud_narrate_caller()`
        （发送 D3 提示词、不隐式 decide、不回落台词池）；未配置凭据保持 None →
        `/interaction/narrate` 明确 503 `NARRATOR_UNAVAILABLE`。
    测试注入的桩与生产配置分明：若单例已被测试创建则不覆盖；HTTP body 不能选 Provider。
    """
    mods = _mods()
    with _SINGLETON["lock"]:
        if _SINGLETON["core"] is not None:
            return
        try:
            provider = mods["E"].make_real_evidence_provider(
                xlate_lookup=build_runtime_translate())
            _SINGLETON["core"] = mods["C"].DeliveryCore(
                mods["B"], protocol=mods["B"].PROTOCOL,
                evidence_provider=provider,
                capability_identity=mods["E"].real_capability_identity)
            import os as _os
            if _os.environ.get("DEEPSEEK_API_KEY") or _os.environ.get("LLM_API_KEY"):
                _SINGLETON["narrate_caller"] = make_cloud_narrate_caller()
            else:
                _SINGLETON["narrate_caller"] = None   # 未配置凭据 → 503 明确不可用
        except Exception as e:
            # 配置失败记录原因：后续无参 get_core() 会 fail-closed（500），绝不静默降级
            # 成 rules-only 单例。
            _SINGLETON["config_error"] = "%s: %s" % (type(e).__name__, e)


def handle_get(path, query, headers, actual_origin):
    """GET /interaction/*（state / receipt）。返回 (status_code, body)。"""
    mods = _mods()
    reject = _reject_foreign_origin(headers, actual_origin)
    if reject:
        return reject
    qs = _query(query)
    sid = qs.get("session_id")

    if path == "/interaction/state":
        if not _valid_id(sid):
            return _error_body("INVALID_REQUEST",
                               "session_id 必须为 1–64 位 [A-Za-z0-9_-]", None, 422)
        try:
            core = get_core()
            st = core.state(sid)
        except mods["_ProtoError"] as e:
            return e.http, {"protocol_version": DELIVERY_PROTOCOL_VERSION,
                            "error": {"code": e.code, "message": e.message, "details": e.details}}
        return 200, {
            "protocol_version": DELIVERY_PROTOCOL_VERSION,
            "session_id": st["session_id"],
            "versions": st["versions"],
            "states": st["states"],
            "initialized": st["initialized"],
        }

    if path == "/interaction/receipt":
        event_id = qs.get("event_id")
        if not sid or not event_id:
            return _error_body("INVALID_REQUEST", "缺少 session_id 或 event_id", None, 422)
        if not _valid_id(sid) or not _valid_id(event_id):
            return _error_body("INVALID_REQUEST",
                               "session_id/event_id 必须为 1–64 位 [A-Za-z0-9_-]", None, 422)
        try:
            core = get_core()
            rec = core.get_receipt(sid, event_id)
        except mods["_ProtoError"] as e:
            return e.http, {"protocol_version": DELIVERY_PROTOCOL_VERSION,
                            "error": {"code": e.code, "message": e.message, "details": e.details}}
        return 200, _player_view_receipt(rec)

    return 404, {"protocol_version": DELIVERY_PROTOCOL_VERSION,
                 "error": {"code": "NOT_FOUND", "message": "未知 /interaction 路由", "details": None}}


def _player_view_receipt(rec):
    """已提交回执 → 玩家视角白名单。"""
    owner = rec.get("owner_changes") or []
    return {
        "protocol_version": DELIVERY_PROTOCOL_VERSION,
        "status": rec.get("status"),
        "replayed": bool(rec.get("replayed")),
        "commit_id": rec.get("commit_id"),
        "session_id": rec.get("session_id"),
        "event_id": rec.get("event_id"),
        "analysis_id": rec.get("analysis_id"),
        "base_versions": _copy.deepcopy(rec.get("base_versions") or {}),
        "committed_at": rec.get("committed_at"),
        "rules_only": rec.get("rules_only", True),
        "laya_evidence": _copy.deepcopy(rec.get("laya_evidence") or []),
        "evidence_absent_reason": rec.get("evidence_absent_reason"),
        "owner_changes": _copy.deepcopy(owner),
        "acts": _copy.deepcopy(rec.get("acts") or []),
        "knowledge_gained": _project_knowledge_gained(rec.get("knowledge_gained") or []),
    }


def handle_post_scene(payload, headers, actual_origin):
    mods = _mods()
    reject = _reject_foreign_origin(headers, actual_origin)
    if reject:
        return reject
    extra = sorted(set(payload) - SCENE_ALLOWED)
    if extra:
        return _error_body("INVALID_REQUEST", "未知字段：%s" % "、".join(extra), None, 422)
    sid = payload.get("session_id")
    if not _valid_id(sid):
        # 写入前先校验：非法 ID 一律 422，状态/版本完全不变，绝不留下脏桶。
        return _error_body("INVALID_REQUEST",
                           "session_id 必须为 1–64 位 [A-Za-z0-9_-] 且非空", None, 422)
    try:
        core = get_core()
        created = core.ensure_scene(sid)
        st = core.state(sid)
    except mods["_ProtoError"] as e:
        return e.http, {"protocol_version": DELIVERY_PROTOCOL_VERSION,
                        "error": {"code": e.code, "message": e.message, "details": e.details}}
    return 200, {
        "protocol_version": DELIVERY_PROTOCOL_VERSION,
        "session_id": sid,
        "created": list(created),
        "versions": st["versions"],
        "states": st["states"],
    }


def handle_post_prepare(payload, headers, actual_origin):
    """POST /interaction/prepare：解释 → Prepare 候选 → 玩家视角预览。"""
    mods = _mods()
    reject = _reject_foreign_origin(headers, actual_origin)
    if reject:
        return reject
    extra = sorted(set(payload) - PREPARE_ALLOWED)
    if extra:
        return _error_body("INVALID_REQUEST", "未知字段：%s" % "、".join(extra), None, 422)
    sid = payload.get("session_id")
    event_id = payload.get("event_id")
    message = payload.get("message")
    expected = payload.get("expected_versions")
    if not _valid_id(sid):
        return _error_body("INVALID_REQUEST",
                           "session_id 必须为 1–64 位 [A-Za-z0-9_-] 且非空", None, 422)
    if not _valid_id(event_id):
        return _error_body("INVALID_REQUEST",
                           "event_id 必须为 1–64 位 [A-Za-z0-9_-] 且非空", None, 422)
    if not isinstance(message, str) or not message or len(message) > 4000:
        return _error_body("INVALID_REQUEST", "message 必填且 ≤4000 字符", None, 422)
    if not isinstance(expected, dict) or not expected:
        return _error_body("INVALID_REQUEST", "expected_versions 必填版本映射", None, 422)

    core = get_core()
    key = (sid, event_id)
    try:
        # 提前核对场景/版本，避免 stale 请求触发云端解释
        st = core.state(sid)
    except mods["_ProtoError"] as e:
        return e.http, {"protocol_version": DELIVERY_PROTOCOL_VERSION,
                        "error": {"code": e.code, "message": e.message, "details": e.details}}
    missing = sorted(e for e, initialized in st["initialized"].items() if not initialized)
    if missing:
        return _error_body("SCENE_NOT_INITIALIZED",
                           "该会话场景尚未初始化，请先调用 /interaction/scene",
                           {"missing": missing}, 409)
    if expected != st["versions"]:
        return _error_body("STATE_VERSION_CONFLICT",
                           "expected_versions 与当前版本不一致（stale），请重新读取场景",
                           {"current_versions": st["versions"]}, 409)

    # 单飞/缓存簿记只在入口锁内做（快、无 Provider/Core 耗时调用）；耗时的 Core 调用
    # 一律放锁外，避免其它事件的解释被同一把锁串行化。
    with _SINGLETON["lock"]:
        inflight = _SINGLETON["inflight"].get(key)
        if inflight is not None:
            if inflight["message"] != message or inflight["versions"] != expected:
                return _error_body("EVENT_PAYLOAD_CONFLICT",
                                   "同一 event 正被另一载荷/版本 Prepare", None, 409)
            return _error_body("PREPARE_IN_PROGRESS", "同一 event 正在 Prepare", None, 409)
        cached = _SINGLETON["cache"].get(key)
        reuse = None
        if cached is not None:
            if time.time() - cached["prepared_at"] > _CACHE_TTL_S:
                _SINGLETON["cache"].pop(key, None)      # 过期缓存不得复用
            elif cached["message"] != message or cached["versions"] != expected:
                # 缓存已存在但载荷不同 → 云端调用前冲突（换新 event_id 再试）。
                return _error_body("EVENT_PAYLOAD_CONFLICT",
                                   "同一 event 已有不同载荷的解释缓存，请换新 event_id",
                                   None, 409)
            else:
                reuse = cached["interp"]
        if reuse is None:
            if len(_SINGLETON["inflight"]) >= _INFLIGHT_MAX:
                return _error_body("INFLIGHT_CAPACITY",
                                   "解释单飞占位已满，请稍后重试", None, 429)
            _prune_caches()
            if len(_SINGLETON["cache"]) >= _CACHE_MAX:
                _evict_oldest_cache()
            _SINGLETON["inflight"][key] = {"message": message, "versions": dict(expected),
                                           "started_at": time.time()}

    if reuse is not None:
        try:
            # 同请求重试：复用已校验解释与候选（不重复计费）；Core 给出幂等候选或
            # 当前冲突/已提交结果。
            code, out = _prepare_via_core(core, reuse, sid, event_id, message, expected)
            if code == 200:
                with _SINGLETON["lock"]:
                    _store_narrate_ctx(sid, event_id, message, out.get("analysis_id"))
            return code, out
        except mods["_ProtoError"] as e:
            return e.http, {"protocol_version": DELIVERY_PROTOCOL_VERSION,
                            "error": {"code": e.code, "message": e.message, "details": e.details}}

    try:
        interp = _interpret(sid, message)
    except Exception as e:
        with _SINGLETON["lock"]:
            _SINGLETON["inflight"].pop(key, None)
        return _error_body("INTERPRETER_UNAVAILABLE",
                           "解释服务不可用，未创建候选", None, 502)

    status = (interp.get("interpretation") or {}).get("status")
    if status == "invalid" and str((interp.get("interpretation") or {}).get("invalid_reason")
                                   or "").startswith("cloud_"):
        # 云端 401/402/429/超时/无可解析响应 → 502，不回显原始错误体。
        with _SINGLETON["lock"]:
            _SINGLETON["inflight"].pop(key, None)
        return _error_body("INTERPRETER_UNAVAILABLE",
                           "云端解释不可用，未创建候选", None, 502)
    if status == "needs_clarification":
        with _SINGLETON["lock"]:
            _SINGLETON["inflight"].pop(key, None)
        return _error_body("NEEDS_CLARIFICATION", "需要澄清（不暗选）", None, 409)
    if status == "unsupported":
        with _SINGLETON["lock"]:
            _SINGLETON["inflight"].pop(key, None)
        return _error_body("UNSUPPORTED_OPERATION", "不支持的操作", None, 409)
    if status != "ready":
        with _SINGLETON["lock"]:
            _SINGLETON["inflight"].pop(key, None)
        return _error_body("INTERPRETATION_INVALID", "解释结果无效", None, 422)

    if not interp.get("prepare_request"):
        with _SINGLETON["lock"]:
            _SINGLETON["inflight"].pop(key, None)
        return _error_body("INTERPRETATION_INVALID", "无法组装 Prepare 请求", None, 422)

    with _SINGLETON["lock"]:
        _prune_caches()
        if len(_SINGLETON["cache"]) >= _CACHE_MAX:
            _evict_oldest_cache()
        _SINGLETON["cache"][key] = {"message": message, "versions": dict(expected),
                                    "interp": interp, "prepared_at": time.time()}

    try:
        result = _prepare_via_core(core, interp, sid, event_id, message, expected)
        # 候选 TTL 从 Core 完成 Prepare 时开始。真实 Provider 可能耗时，入口缓存
        # 也必须从此时计时，才能在候选有效期内避免重复云端解释。
        with _SINGLETON["lock"]:
            cached = _SINGLETON["cache"].get(key)
            if cached is not None and cached["interp"] is interp:
                cached["prepared_at"] = time.time()
            # P3-D3：Prepare 成功即绑定叙事私有上下文（原话 + analysis_id）。
            if result[0] == 200:
                _store_narrate_ctx(sid, event_id, message, result[1].get("analysis_id"))
        return result
    except mods["_ProtoError"] as e:
        return e.http, {"protocol_version": DELIVERY_PROTOCOL_VERSION,
                        "error": {"code": e.code, "message": e.message, "details": e.details}}
    finally:
        with _SINGLETON["lock"]:
            _SINGLETON["inflight"].pop(key, None)


def _prepare_via_core(core, interp, sid, event_id, message, expected):
    mods = _mods()
    req = dict(interp["prepare_request"])
    # 服务端固定 session_id / event_id / actor_id=player / expected_versions（不采信客户端 payload）
    req["session_id"] = sid
    req["event_id"] = event_id
    req["actor_id"] = "player"
    req["expected_versions"] = dict(expected)
    pv = core.prepare_structured(req)
    out = _player_view_preview(pv)
    # 附解释摘要（不含目录/原始响应/历史原文）
    interp_summary = (interp.get("interpretation") or {})
    out["interpretation"] = {
        "status": interp_summary.get("status"),
        "n_actions": len(interp_summary.get("actions") or []),
    }
    return 200, out


def handle_post_commit(payload, headers, actual_origin):
    mods = _mods()
    reject = _reject_foreign_origin(headers, actual_origin)
    if reject:
        return reject
    extra = sorted(set(payload) - COMMIT_ALLOWED)
    if extra:
        return _error_body("INVALID_REQUEST", "未知字段：%s" % "、".join(extra), None, 422)
    sid = payload.get("session_id")
    event_id = payload.get("event_id")
    analysis_id = payload.get("analysis_id")
    expected = payload.get("expected_versions")
    if not _valid_id(sid):
        return _error_body("INVALID_REQUEST",
                           "session_id 必须为 1–64 位 [A-Za-z0-9_-] 且非空", None, 422)
    if not _valid_id(event_id):
        return _error_body("INVALID_REQUEST",
                           "event_id 必须为 1–64 位 [A-Za-z0-9_-] 且非空", None, 422)
    if not isinstance(analysis_id, str) or not analysis_id:
        return _error_body("INVALID_REQUEST", "analysis_id 必填字符串", None, 422)
    if not isinstance(expected, dict) or not expected:
        return _error_body("INVALID_REQUEST", "expected_versions 必填", None, 422)
    try:
        core = get_core()
        rec = core.commit({"session_id": sid, "event_id": event_id,
                           "analysis_id": analysis_id,
                           "expected_versions": expected})
    except mods["_ProtoError"] as e:
        return e.http, {"protocol_version": DELIVERY_PROTOCOL_VERSION,
                        "error": {"code": e.code, "message": e.message, "details": e.details}}
    return 200, _player_view_receipt(rec)


def _prune_caches():
    """清理**过期缓存**。in-flight 占位绝不按时间清除：解释器云端 timeout 可达 90 秒，
    活跃调用必须由请求路径自行释放，否则第二个请求会再次付费调用云端。"""
    now = time.time()
    for k in list(_SINGLETON["cache"]):
        if now - _SINGLETON["cache"][k]["prepared_at"] > _CACHE_TTL_S:
            _SINGLETON["cache"].pop(k, None)


def _evict_oldest_cache():
    """缓存容量满时淘汰最旧条目（有界，不无界新增）。"""
    if not _SINGLETON["cache"]:
        return
    oldest = min(_SINGLETON["cache"],
                 key=lambda k: _SINGLETON["cache"][k]["prepared_at"])
    _SINGLETON["cache"].pop(oldest, None)


# ==========================================================================
# P3-D3 · 叙事薄链：POST /interaction/narrate（只消费已提交回合）
# ==========================================================================
def build_narrate_facts(rec, player_message):
    """把已提交回执组织成叙事事实块（**只读**，不改任何状态）。

    · steps：按 acts 顺序的逐动作事实（含每步造成的公开状态变更 before/after）——
      顺序即时间顺序；
    · player_knowledge_gained：仅 actor_id=player 的条目（莉亚未披露的私有知识
      绝不进入叙事输入）；
    · tone_signals：Laya 信号（只校准语气，不是已发生事实）。
    """
    resolutions = (rec.get("outcome") or {}).get("resolutions") or []
    steps = []
    for i, r in enumerate(resolutions):
        record = r.get("record") or {}
        changes = []
        for ch in r.get("changes") or []:
            if ".knowledge" in str(ch.get("path")):
                continue          # 私有知识写项不进叙事事实
            changes.append({"path": ch.get("path"), "before": ch.get("before"),
                            "after": ch.get("after")})
        kg_rows = [{"entry_id": row.get("entry", {}).get("entry_id"),
                     "kind": row.get("entry", {}).get("kind")}
                    for row in r.get("knowledge_gained") or []
                    if row.get("actor_id") == "player"]
        steps.append({
            "n": i + 1,
            "operation": r.get("operation"),
            "kind": record.get("kind") or record.get("sub_kind"),
            "execution_status": r.get("execution_status"),
            "degree": r.get("degree"),
            "achieved": r.get("achieved"),
            "listener": record.get("listener"),
            "speaker": record.get("speaker"),
            "changes": changes,
            "player_knowledge": kg_rows,
        })
    gained = []
    for row in rec.get("knowledge_gained") or []:
        if row.get("actor_id") != "player":
            continue
        entry = row.get("entry") or {}
        gained.append({"entry_id": entry.get("entry_id"), "kind": entry.get("kind"),
                       "content": entry.get("content"),
                       "told_by": entry.get("told_by"),
                       "objective": entry.get("objective"),
                       "as_of_turn": entry.get("as_of_turn")})
    signals = []
    for e in rec.get("laya_evidence") or []:
        for s in e.get("signals") or []:
            signals.append({"signal": s.get("signal"), "status": s.get("status"),
                            "may_write_state": s.get("may_write_state"),
                            "delta": s.get("delta")})
    return {
        "event_id": rec.get("event_id"),
        "commit_id": rec.get("commit_id"),
        "player_message": player_message,
        "steps": steps,
        "player_knowledge_gained": gained,
        "tone_signals": signals,
        "rules_only": rec.get("rules_only", True),
    }


def build_narrate_prompt(facts):
    """叙事提示词：复用现有叙事规则语言与 <line> 格式；顺序即事实。

    ★ 顺序与事实措辞由 `_ordering_note` 按已提交 steps 的实际发生情况生成
      （attempted 只证「询问发生」，线索按本轮 knowledge_gained、blocked 明确
      「没有回答」，不臆造事实）。
    ★ 角色身份与静态人设取**服务端配置**（`laya_bridge.CFG["actor"]`）；回合事实
      只取已提交回执与服务端绑定的玩家原话，不接受客户端补报。
    ★ 语气信号只校准语气；不得改写物品归属、位置、门状态、关系值或泄露
      未披露的私有知识（沿用现有 analysis/legacy 提示词的同类规则）。
    """
    mods = _mods()
    actor = mods["B"].CFG.get("actor") or {}
    persona = json.dumps({k: actor.get(k) for k in ("personality", "traits",
                                                    "situation", "goals")},
                         ensure_ascii=False)
    steps_txt = []
    for s in facts.get("steps") or []:
        line = "第 %d 步（按发生顺序）：%s" % (s.get("n"),
                                               s.get("achieved") or ("动作 %s" % s.get("operation")))
        if s.get("changes"):
            line += "。本步造成的公开状态变更：%s" % "；".join(
                "%s：%s → %s" % (c["path"], c["before"], c["after"])
                for c in s["changes"])
        steps_txt.append(line)
    order_note = _ordering_note(facts.get("steps") or [])
    kg_note = ("玩家已获知线索：%s" % json.dumps(facts.get("player_knowledge_gained") or [],
                                                 ensure_ascii=False))
    sig_note = ("Laya 信号（只校准语气，不是已发生事实，不得据此改写数值）：%s"
                % json.dumps(facts.get("tone_signals") or [], ensure_ascii=False))
    sys_p = (
        "你在为文字冒险游戏写本回合的叙事台词。\n"
        "角色：%s，%s。\n"
        "人物与场景补充：%s\n"
        "玩家原话（服务端保存的原始输入）：%s\n"
        "本回合事实（按发生顺序）：\n%s\n"
        "%s\n"
        "%s\n"
        "%s\n"
        "规则：\n"
        "1) 台词用「」包裹，2~4 句，中文，不分段列点。\n"
        "2) 只能依据上述事实：不得改写物品归属、位置、门状态或关系值；\n"
        "   不得把未披露的私有知识写进台词（只可使用「玩家已获知线索」里的内容）。\n"
        "3) Laya 信号只用于调整语气，不是已发生事实。\n"
        "4) 不替玩家说话、不替玩家做决定。\n"
        "格式（必须遵守）：把最终台词原文放进 <line> 与 </line> 之间，"
        "这两个标签之外一个字符都不要写。"
    ) % (actor.get("name", "NPC"), actor.get("identity", ""), persona,
         facts.get("player_message") or "",
         "\n".join(steps_txt) or "（无动作）",
         order_note, kg_note, sig_note)
    user_p = "请写出本回合的叙事台词。"
    return sys_p, user_p


def _ordering_note(steps):
    """按已提交 steps 的**实际发生情况**生成顺序约束（措辞收紧版）。

    · `execution_status=attempted` 只证明交流/询问实际发生，**不**据此断言
      「回答已给出」或「回答发生在移动前/后」——回答与否由本轮 knowledge_gained
      决定：玩家本轮确实获得新线索才写「已被告知」；没有新线索保守写
      「询问发生，未获得新线索」，自然回应留给叙事模型，不得补造事实。
    · blocked 的交流明确写「交流未发生，没有回答」。
    · 顺序关系只陈述「询问发生在移动之前/之后」（动作发生的时间顺序）。
    """
    base = ("步骤按时间顺序排列，先发生的写在前；移动造成的状态变更只适用于其后。"
            "绝不要把角色写成尚未到达的位置。")
    parts = []
    comm_n = None    # 第一个实际发生的交流步骤号
    move_n = None    # 第一个实际完成的移动步骤号
    for s in steps:
        op = s.get("operation")
        talk = "询问" if s.get("kind") == "question" else "交流"
        if op == "communicate":
            if s.get("execution_status") == "attempted":
                if comm_n is None:
                    comm_n = s.get("n")
                rows = s.get("player_knowledge") or []
                if any(r.get("kind") == "clue" for r in rows):
                    parts.append("第 %d 步的%s实际发生，玩家本轮获得了新线索（已被告知，"
                                 "见「玩家已获知线索」）。" % (s.get("n"), talk))
                elif rows:
                    parts.append("第 %d 步的%s实际发生，本轮记录了新内容。" % (s.get("n"), talk))
                else:
                    parts.append("第 %d 步的%s实际发生，但本轮未获得新线索。" % (s.get("n"), talk))
            else:
                parts.append("第 %d 步的交流未发生（被阻止），没有回答。" % s.get("n"))
        elif op == "move" and s.get("execution_status") == "attempted":
            if move_n is None:
                move_n = s.get("n")
    if comm_n is not None and move_n is not None:
        if comm_n < move_n:
            parts.append("时间顺序：询问发生在移动之前。")
        else:
            parts.append("时间顺序：询问发生在移动之后。")
    if not parts:
        return base + "不要臆造与步骤顺序不符的状态变化。"
    return base + "".join(parts)


def handle_post_narrate(payload, headers, actual_origin):
    """POST /interaction/narrate：只消费已提交回合的叙事薄链。

    · 请求只接受 session_id/event_id/commit_id；玩家原话来自 Prepare 时服务端
      保存的私有上下文，客户端重报 message/状态/动作/Evidence 一律 422。
    · 没有 Commit → 404；commit_id 与已提交回执不一致 → 409。
    · 已成功台词按 commit_id 优先复用（即使私有上下文被容量淘汰仍可读）；
      从未生成过且上下文缺失 → 409 NARRATE_CONTEXT_MISSING（不可叙事，绝不猜原话）。
    · 同 (session,event,commit) 并发单飞：生成器在锁外运行，第二个同时到达的
      相同请求得 409 NARRATE_IN_PROGRESS；失败/提取失败都释放占位可重试。
    · 生成失败 502，权威状态/时钟/版本/回执均不变，不重新 Prepare/Commit。
    """
    mods = _mods()
    reject = _reject_foreign_origin(headers, actual_origin)
    if reject:
        return reject
    extra = sorted(set(payload) - NARRATE_ALLOWED)
    if extra:
        return _error_body("INVALID_REQUEST", "未知字段：%s" % "、".join(extra), None, 422)
    sid = payload.get("session_id")
    event_id = payload.get("event_id")
    commit_id = payload.get("commit_id")
    if not _valid_id(sid):
        return _error_body("INVALID_REQUEST",
                           "session_id 必须为 1–64 位 [A-Za-z0-9_-] 且非空", None, 422)
    if not _valid_id(event_id):
        return _error_body("INVALID_REQUEST",
                           "event_id 必须为 1–64 位 [A-Za-z0-9_-] 且非空", None, 422)
    if not isinstance(commit_id, str) or not commit_id:
        return _error_body("INVALID_REQUEST", "commit_id 必填字符串", None, 422)

    core = get_core()
    try:
        rec = core.get_receipt(sid, event_id)     # 没有 Commit 就拒绝（404）
    except mods["_ProtoError"] as e:
        return e.http, {"protocol_version": DELIVERY_PROTOCOL_VERSION,
                        "error": {"code": e.code, "message": e.message, "details": e.details}}
    if rec.get("commit_id") != commit_id:
        return _error_body("NARRATE_COMMIT_MISMATCH",
                           "commit_id 与该事件已提交回执不一致", None, 409)

    with _SINGLETON["lock"]:
        # 已成功生成的台词优先按 commit_id 复用：即使私有原话上下文被容量淘汰，
        # 已有成功台词仍可读（回执仍有效的前提下）。
        cached = _SINGLETON["narrate_cache"].get((sid, event_id))
        if cached and cached.get("commit_id") == commit_id:
            return 200, {"protocol_version": DELIVERY_PROTOCOL_VERSION,
                         "session_id": sid, "event_id": event_id,
                         "commit_id": commit_id, "line": cached["line"], "reused": True}
        ctx = _SINGLETON["narrate_ctx"].get((sid, event_id))
        if ctx and ctx.get("analysis_id") == rec.get("analysis_id"):
            message = ctx.get("message")
        else:
            message = None
    if message is None:
        # 从未生成过台词且上下文已缺失 → 不可叙事，绝不猜原话。
        return _error_body("NARRATE_CONTEXT_MISSING",
                           "绑定上下文已缺失，无法取得玩家原话，拒绝叙事（不猜测原话）",
                           None, 409)

    facts = build_narrate_facts(rec, message)
    sys_p, user_p = build_narrate_prompt(facts)
    caller = _SINGLETON["narrate_caller"]
    if caller is None:
        return _error_body("NARRATOR_UNAVAILABLE", "叙事生成器未配置", None, 503)

    # 单飞：同 (session,event,commit) 的并发叙事只调用一次生成器；生成器在锁外运行。
    # ★ 在登记占位的**同一临界区**内再次检查该 commit_id 的成功台词缓存：关闭
    # 「请求 B 初次查缓存未命中 → 首个请求完成并入缓存 → 轮到 B 登记占位」的
    # 竞态窗口——此时已缓存则直接 reused=true，绝不再次调用生成器。
    with _SINGLETON["lock"]:
        cached = _SINGLETON["narrate_cache"].get((sid, event_id))
        if cached and cached.get("commit_id") == commit_id:
            return 200, {"protocol_version": DELIVERY_PROTOCOL_VERSION,
                         "session_id": sid, "event_id": event_id,
                         "commit_id": commit_id, "line": cached["line"], "reused": True}
        inflight = _SINGLETON["narrate_inflight"].get((sid, event_id))
        if inflight is not None:
            if inflight.get("commit_id") != commit_id:
                return _error_body("NARRATE_COMMIT_MISMATCH",
                                   "该事件正以另一 commit 身份生成叙事", None, 409)
            return _error_body("NARRATE_IN_PROGRESS",
                               "同一回合正在生成叙事，请稍后复用结果", None, 409)
        if len(_SINGLETON["narrate_inflight"]) >= _NARRATE_CTX_MAX:
            return _error_body("NARRATE_CAPACITY", "叙事单飞占位已满，请稍后重试", None, 429)
        _SINGLETON["narrate_inflight"][(sid, event_id)] = {
            "commit_id": commit_id, "started_at": time.time()}

    try:
        raw = caller(facts, sys_p, user_p)      # 锁外运行
    except Exception:
        with _SINGLETON["lock"]:
            _SINGLETON["narrate_inflight"].pop((sid, event_id), None)
        return _error_body("NARRATION_FAILED",
                           "叙事生成失败，已提交回合与权威状态不受影响", None, 502)
    line, _structured = mods["B"].extract_line(str(raw or ""))
    if not line:
        with _SINGLETON["lock"]:
            _SINGLETON["narrate_inflight"].pop((sid, event_id), None)
        return _error_body("NARRATION_FAILED",
                           "叙事生成结果不可用（未提取到台词），已提交回合不受影响", None, 502)

    with _SINGLETON["lock"]:
        _SINGLETON["narrate_inflight"].pop((sid, event_id), None)
        if len(_SINGLETON["narrate_cache"]) >= _NARRATE_CACHE_MAX:
            _evict_oldest(_SINGLETON["narrate_cache"], "saved_at")
        _SINGLETON["narrate_cache"][(sid, event_id)] = {
            "commit_id": commit_id, "line": line, "saved_at": time.time()}
    return 200, {"protocol_version": DELIVERY_PROTOCOL_VERSION,
                 "session_id": sid, "event_id": event_id,
                 "commit_id": commit_id, "line": line, "reused": False}


def _query(query_string):
    import urllib.parse
    qs = urllib.parse.parse_qs(query_string)
    return {k: (v[0] if v else None) for k, v in qs.items()}
