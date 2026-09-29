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

# 短期同请求缓存 / in-flight 上限（有界，不作正式状态）。
_INFLIGHT_MAX = 256
_CACHE_MAX = 256
_CACHE_TTL_S = 600.0  # 与 DeliveryCore.READY_TTL_S 一致：候选有效期内重试不重复调用云端

# session_id / event_id 统一格式（与 core._ID_RE 同口径）：1–64 位 [A-Za-z0-9_-]。
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

_SINGLETON = {
    "core": None,          # DeliveryCore（进程内唯一）
    "lock": threading.RLock(),
    "inflight": {},        # (session_id,event_id) -> {"message","versions","started_at"}
    "cache": {},           # (session_id,event_id) -> {"message","versions","interp","prepared_at"}
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
        _SINGLETON["xlate_cache"].clear()
        _SINGLETON["xlate_disk_loaded"] = False
        _SINGLETON["config_error"] = None
    _SINGLETON["explain_calls"][0] = 0


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


def configure_real():
    """生产启动配置（`laya_bridge.main()` 在 `serve_forever` 前调用一次）。

    在**任何** GET/scene/prepare 可创建单例之前，把生产 Core 固定为：
      · `make_real_evidence_provider(xlate_lookup=运行翻译)`（真实 Evidence Provider，
        运行翻译与冻结资产分离）；
      · `real_capability_identity`（服务端档案/检查点身份源，Commit 时重读）。
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
            return _prepare_via_core(core, reuse, sid, event_id, message, expected)
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


def _query(query_string):
    import urllib.parse
    qs = urllib.parse.parse_qs(query_string)
    return {k: (v[0] if v else None) for k, v in qs.items()}
