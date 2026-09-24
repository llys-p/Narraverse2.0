"""P2-B1：Analyze / Commit 状态协议 v1 的服务端实现（存储与编排）。

独立小模块承载协议编排，**不复制推理引擎**：翻译、Laya 推理、状态公式、能力
档案、指纹全部复用 laya_bridge（通过注入的 B 引用访问）。契约见
`tasks/P2-A-Analyze-Commit协议.md`，本文实现其 §3/§4/§5/§8 的服务端部分。

边界（B1 范围）：
  · 新端点：GET /state（扩展）、POST /analyze、GET /analysis/{id}、
    POST /commit_state、POST /reject_analysis。
  · 旧路由（/decide、/turn、/commit、/reset）共用同一事务边界与版本是
    **P2-B2** 的范围，本轮不接；但本模块已提供版本/锁/重置工具供 B2 复用。
  · 本模块不初始化 Actor State、不写 _HISTORY_BUCKETS；分析零写入，
    仅首次成功 Commit 才建立 Actor State 桶。

存储设计（§4）：
  · _buckets[(session,actor)] -> {"generation": int, "revision": int}
      epoch 在模块创建时随机生成；Reset 换 generation；重启换 epoch。
      版本 token 为不透明字符串 `v1:{epoch}:{gen}:{rev}`，旧版本不因
      revision 回到 0 而重新有效。
  · _analyses[analysis_id] -> 候选记录（含 in-flight 占位）。
  · _events[(session,actor)][event_id] -> {"sha":..., "status":...} 墓碑。
  · _inflight[(scope,event_id,base_version)] -> analysis_id（single-flight）。

错误协议（§8）：所有错误返回
  {protocol_version, error:{code, message, details}}。
"""
import copy as _copy
import hashlib
import json
import re
import sys
import threading
import time
import uuid

PROTOCOL_VERSION = "laya-state-v1"
READY_TTL_S = 600          # 候选 ready/reference_only 发布起有效时长
RECEIPT_TTL_S = 3600       # 终态完整回执保留时长（自终态时间起）
MAX_ANALYSES = 200         # 完整分析记录（含 in-flight）/ 进程
MAX_EVENTS_PER_BUCKET = 1000   # 事件身份记录 / 桶
MAX_HISTORY_ITEMS = 12
MAX_MESSAGE_CHARS = 4000
MAX_SCENE_CHARS = 2000
MAX_CONTENT_CHARS = 2000
MAX_BODY_BYTES = 65536     # HTTP 请求体上限（§3.2）

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_ROLES = ("user", "assistant")


def _sha256_text(s):
    if isinstance(s, str):
        return hashlib.sha256(s.encode("utf-8")).hexdigest()
    return hashlib.sha256(json.dumps(s, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def _iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def _finite_number(v):
    """JSON 数字须有限且非布尔（禁止 NaN/Infinity，布尔不当数字）。"""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float("inf"), float("-inf"))


class LayaStateProtocol:
    def __init__(self, B, now=None):
        self.B = B
        self.now = now or time.time
        self.lock = threading.RLock()
        self.epoch = uuid.uuid4().hex[:16]
        self._buckets = {}      # (session, actor) -> {"generation","revision"}
        self._analyses = {}     # analysis_id -> record
        self._events = {}       # (session, actor) -> {event_id: {"sha","status",...}}
        self._inflight = {}     # (scope, event_id, base) -> analysis_id

    # ======================================================================
    # 版本
    # ======================================================================
    def _scope(self, session_id, actor_id):
        return (str(session_id), str(actor_id))

    def _ensure_bucket_meta(self, scope):
        if scope not in self._buckets:
            self._buckets[scope] = {"generation": 0, "revision": 0}
        return self._buckets[scope]

    def state_version(self, scope):
        """当前版本 token（首次只读访问会登记版本元数据，不初始化 Actor State）。"""
        m = self._ensure_bucket_meta(scope)
        return "v1:%s:%d:%d" % (self.epoch, m["generation"], m["revision"])

    @staticmethod
    def _parse_version(token):
        """解析 token -> (epoch, generation, revision)；不合法返回 None。"""
        if not isinstance(token, str):
            return None
        parts = token.split(":")
        if len(parts) != 4 or parts[0] != "v1":
            return None
        try:
            return parts[1], int(parts[2]), int(parts[3])
        except ValueError:
            return None

    def _bump_revision(self, scope):
        m = self._ensure_bucket_meta(scope)
        m["revision"] += 1
        return self.state_version(scope)

    def reset_scope(self, scope):
        """Reset 作用域：清版本/候选/事件/回执并换 generation（供 B2 接入 /reset）。"""
        with self.lock:
            m = self._ensure_bucket_meta(scope)
            m["generation"] += 1
            m["revision"] = 0
            for aid, a in list(self._analyses.items()):
                if (a["session_id"], a["actor_id"]) == scope:
                    if a["status"] in ("ready", "reference_only"):
                        self._analyses[aid]["status"] = "invalidated"
                        self._analyses[aid]["terminal_at"] = self.now()
                    elif a["status"] == "in_flight":
                        self._analyses[aid]["status"] = "invalidated"
            self._events.pop(scope, None)
            for k in list(self._inflight):
                if k[0] == scope:
                    self._inflight.pop(k, None)
            return self.state_version(scope)

    # ======================================================================
    # 规则指纹（§5）
    # ======================================================================
    def rules_fingerprint(self, model, force=True):
        """有效规则指纹：协议版本 + 配置 + 检查点 id + 当前档案内容 + dataset/冻结译文子集。

        force=True 时强制刷新能力档案缓存 —— mtime 未变的内容替换也必须被识别
        （§5「资产热替换不受锁保护，提交仍要发现已发生的磁盘漂移」）。
        """
        B = self.B
        if force:
            B.load_capability_profiles(force=True)
        prof, check = B.load_capability_profile(model)
        blob = {
            "protocol_version": PROTOCOL_VERSION,
            "config": B._config_fingerprint().get("sha"),
            "checkpoint": {
                "name": model,
                "id": B._checkpoint_fingerprint(model).get("id"),
            },
            "profile": prof or {"unavailable": True},
            "profile_check": {
                "matched": check.get("matched"), "fresh": check.get("fresh"),
                "problems": check.get("problems") or [],
            },
            "dataset": B._dataset_fingerprint().get("sha_lf") or B._dataset_fingerprint().get("sha"),
            "xlate": B._xlate_subset_fingerprint().get("sha"),
        }
        return hashlib.sha256(
            json.dumps(blob, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()

    def _effective_model(self):
        eng = getattr(self.B.ENGINE, "model_name", None)
        return eng or self.B.DEFAULT_MODEL_NAME

    # ======================================================================
    # 请求校验（§3.2 / §3.4 / §3.5，白名单 + 未知字段 422）
    # ======================================================================
    def _check_ids(self, req):
        for k in ("session_id", "actor_id"):
            v = req.get(k)
            if not isinstance(v, str) or not _ID_RE.match(v):
                raise _ProtoError(422, "INVALID_REQUEST",
                                  "%s 必须为 1–64 位 [A-Za-z0-9_-] 且非空" % k)
        return str(req["session_id"]), str(req["actor_id"])

    def _require_only(self, req, allowed, where):
        extra = sorted(set(req) - set(allowed))
        if extra:
            raise _ProtoError(422, "INVALID_REQUEST",
                              "%s 含未知字段（严格白名单，不允许静默忽略）：%s"
                              % (where, "、".join(extra)))

    def _check_event_id(self, req):
        v = req.get("event_id")
        if not isinstance(v, str) or not _ID_RE.match(v):
            raise _ProtoError(422, "INVALID_REQUEST", "event_id 必填且为 1–64 位 [A-Za-z0-9_-]")
        return v

    def _check_message(self, req):
        m = req.get("message")
        if not isinstance(m, str) or not m.strip() or len(m) > MAX_MESSAGE_CHARS:
            raise _ProtoError(422, "INVALID_REQUEST",
                              "message 必填、非全空白、1–%d 字符" % MAX_MESSAGE_CHARS)
        return m

    def _check_context(self, req):
        ctx = req.get("context")
        if ctx is None:
            return {"scene": "", "history": []}
        if not isinstance(ctx, dict):
            raise _ProtoError(422, "INVALID_REQUEST", "context 必须是对象")
        self._require_only(ctx, {"scene", "history"}, "context")
        scene = ctx.get("scene") or ""
        if not isinstance(scene, str) or len(scene) > MAX_SCENE_CHARS:
            raise _ProtoError(422, "INVALID_REQUEST",
                              "context.scene 须为字符串且 ≤%d 字符" % MAX_SCENE_CHARS)
        history = ctx.get("history") or []
        if not isinstance(history, list) or len(history) > MAX_HISTORY_ITEMS:
            raise _ProtoError(422, "INVALID_REQUEST",
                              "context.history 须为数组且 ≤%d 项" % MAX_HISTORY_ITEMS)
        out = []
        for i, it in enumerate(history):
            if not isinstance(it, dict):
                raise _ProtoError(422, "INVALID_REQUEST", "context.history[%d] 必须是对象" % i)
            self._require_only(it, {"role", "content"}, "context.history[%d]" % i)
            role = it.get("role")
            content = it.get("content")
            if role not in _ROLES:
                raise _ProtoError(422, "INVALID_REQUEST",
                                  "context.history[%d].role 只允许 user/assistant" % i)
            if not isinstance(content, str) or not content.strip() or len(content) > MAX_CONTENT_CHARS:
                raise _ProtoError(422, "INVALID_REQUEST",
                                  "context.history[%d].content 须为非空字符串且 ≤%d 字符" % (i, MAX_CONTENT_CHARS))
            out.append({"role": role, "content": content})
        return {"scene": scene, "history": out}

    def _check_version(self, req):
        v = req.get("expected_state_version")
        if not isinstance(v, str) or not v:
            raise _ProtoError(422, "INVALID_REQUEST", "expected_state_version 必填字符串")
        return v

    # ======================================================================
    # 生命周期工具
    # ======================================================================
    def _maybe_expire(self, a):
        """惰性过期：ready/reference_only 超过 expires_at → expired。"""
        if a["status"] in ("ready", "reference_only") and self.now() >= a.get("expires_at", 0):
            a["status"] = "expired"
            a["terminal_at"] = a.get("expires_at") or self.now()
        return a

    def _maybe_stale(self, a):
        """惰性失效：基准版本与当前版本/epoch/generation 不符 → stale。"""
        cur = self.state_version((a["session_id"], a["actor_id"]))
        if a["status"] in ("ready", "reference_only", "expired"):
            if cur != a.get("base_state_version"):
                a["status"] = "stale"
        return a

    def _cleanup_expired(self):
        """请求时清理：只清保留期已过的终态；腾出容量。返回可回收条数。"""
        now = self.now()
        drop = []
        for aid, a in self._analyses.items():
            if a["status"] in ("committed", "rejected", "expired"):
                tt = a.get("terminal_at") or a.get("expires_at") or 0
                if now >= tt + RECEIPT_TTL_S:
                    drop.append(aid)
        for aid in drop:
            self._analyses.pop(aid, None)
        return len(drop)

    def _event_record(self, scope, event_id):
        self._events.setdefault(scope, {})
        return self._events[scope]

    def _reuse_candidate(self, scope, event_id, base):
        """同事件同基准版本的现成候选（ready/reference_only 且未过期）→ 复用。"""
        for a in self._analyses.values():
            if (a["session_id"], a["actor_id"]) != scope:
                continue
            if a["event_id"] != event_id or a["base_state_version"] != base:
                continue
            if a["status"] in ("ready", "reference_only"):
                self._maybe_expire(a)
                if a["status"] in ("ready", "reference_only"):
                    return a
        return None

    # ======================================================================
    # GET /state（§3.1，扩展）
    # ======================================================================
    def get_state(self, session_id, actor_id):
        scope = self._scope(session_id, actor_id)
        with self.lock:
            ver = self.state_version(scope)
            initialized = scope in self.B._ACTOR_STATE
            state = self.B.actor_state_snapshot(session_id, actor_id,
                                                actor=self.B.CFG.get("actor"))
            return {
                "protocol_version": PROTOCOL_VERSION,
                "current": {
                    "session_id": str(session_id), "actor_id": str(actor_id),
                    "state_version": ver,
                    "initialized": initialized,
                    "source": "committed" if initialized else "template",
                    "state": state,
                },
            }

    # ======================================================================
    # POST /analyze（§3.2 / §3.3）
    # ======================================================================
    def analyze(self, req):
        B = self.B
        self._require_only(req, {"session_id", "actor_id", "event_id",
                                 "expected_state_version", "message", "context"}, "analyze")
        sid, aid = self._check_ids(req)
        event_id = self._check_event_id(req)
        expected = self._check_version(req)
        message = self._check_message(req)
        context = self._check_context(req)
        scope = self._scope(sid, aid)
        model = self._effective_model()

        # input_sha256：白名单字段规范序列化（排除 expected_state_version；§4.1）
        input_sha = _sha256_text({
            "session_id": sid, "actor_id": aid, "event_id": event_id,
            "message": message, "context": context,
        })
        # 基准用例唯一来源是冻结基线（P1 纪律）；非基准走 冻结→运行→在线。
        frozen = B._load_frozen_xlate()
        baseline = _baseline_texts_of(B)
        if (frozen is not None and message in frozen) or message in baseline:
            xlate_src = "frozen"
        else:
            xlate_src = None

        with self.lock:
            current = self.state_version(scope)
            if expected != current:
                raise _ProtoError(409, "STATE_VERSION_CONFLICT",
                                  "expected_state_version 与当前版本不一致；请 GET /state 刷新",
                                  {"current_state_version": current})
            ev = self._event_record(scope, event_id)
            rec = ev.get(event_id)
            if rec:
                if rec.get("status") == "committed":
                    raise _ProtoError(
                        409, "EVENT_ALREADY_COMMITTED", "该 event 已被提交，禁止另造候选重复写",
                        {"commit_id": rec.get("commit_id"), "analysis_id": rec.get("analysis_id"),
                         "state_version": rec.get("state_version")})
                if rec.get("status") == "rejected":
                    raise _ProtoError(409, "EVENT_REJECTED", "该 event 已被拒绝/关闭")
                if rec.get("sha") != input_sha:
                    raise _ProtoError(409, "EVENT_PAYLOAD_CONFLICT",
                                      "同一 event_id 换 message/context 内容冲突")
            reused = self._reuse_candidate(scope, event_id, expected)
            if reused is not None:
                return self._analysis_response(reused)
            ik = (scope, event_id, expected)
            if ik in self._inflight:
                raise _ProtoError(409, "ANALYSIS_IN_PROGRESS",
                                  "同 event 同基准版本正在分析中", {"retry_after_ms": 500})
            # 容量（§4.2）：先尝试回收过期终态，仍满则 429
            if len(self._analyses) >= MAX_ANALYSES:
                self._cleanup_expired()
            if len(self._analyses) >= MAX_ANALYSES:
                raise _ProtoError(429, "PENDING_CAPACITY",
                                  "完整分析记录已达上限（%d），请清理/等待过期" % MAX_ANALYSES)
            if len(ev) >= MAX_EVENTS_PER_BUCKET:
                raise _ProtoError(429, "EVENT_CAPACITY",
                                  "该作用域事件身份记录已达上限（%d），需 Reset/新会话" % MAX_EVENTS_PER_BUCKET)
            snapshot = B.actor_state_snapshot(sid, aid, actor=B.CFG.get("actor"))
            base_state_sha = _sha256_text(snapshot)
            rules = self.rules_fingerprint(model, force=True)
            analysis_id = uuid.uuid4().hex
            self._inflight[ik] = analysis_id
            self._analyses[analysis_id] = {
                "analysis_id": analysis_id, "session_id": sid, "actor_id": aid,
                "event_id": event_id, "status": "in_flight",
                "base_state_version": expected,
                "created_at": self.now(), "expires_at": None, "terminal_at": None,
                "message": message, "context": context, "input_sha256": input_sha,
                "base_state_sha256": base_state_sha, "rules_fingerprint": rules,
                "snapshot": snapshot, "signals": {}, "state_proposal": {},
                "capability": {}, "evidence": {}, "commit_receipt": None,
                "xlate_source_hint": xlate_src, "model": model,
            }

        # ---- 锁外：翻译 + 推理（模型/网络调用不放锁内；§5）----
        en = None
        try:
            cache = {}
            try:
                cache = json.loads(B._XLATE_DISK.read_text(encoding="utf-8"))
            except Exception:
                pass
            en = B._cached_translate(message, cache)
            if xlate_src is None:
                if frozen is not None and message in frozen:
                    xlate_src = "frozen"
                elif message in cache:
                    xlate_src = "runtime"
                else:
                    xlate_src = "online"
        except B.TranslationFailure:
            with self.lock:
                self._release_inflight(scope, event_id, expected)
            raise _ProtoError(502, "TRANSLATION_FAILED", "基准译文缺失或翻译失败（fail-closed）")
        if en is None:
            with self.lock:
                self._release_inflight(scope, event_id, expected)
            raise _ProtoError(502, "TRANSLATION_FAILED",
                              "无法取得英文输入（基准缺冻结译文或翻译失败）",
                              {"source": xlate_src})

        payload = {
            "session_id": sid, "actor_id": aid,
            "player_input": message, "player_input_en": en,
            "history": context.get("history") or [],
        }
        if context.get("scene"):
            payload["scene"] = context["scene"]
        core = None
        try:
            core = B.analyze_core(payload, turn_id=analysis_id, frozen_state=snapshot)
        except Exception as e:
            with self.lock:
                self._release_inflight(scope, event_id, expected)
            raise _ProtoError(502, "MODEL_INFERENCE_FAILED",
                              "Laya 推理失败：%r" % (e,))
        if core.get("ok") is False:
            with self.lock:
                self._release_inflight(scope, event_id, expected)
            raise _ProtoError(502, "MODEL_INFERENCE_FAILED",
                              core.get("note") or core.get("invalid_reason") or "分析核心失败")

        # ---- judgment 语义校验（§6.2：不需要 NPC 行为）----
        judgment = {"behavior_is_null": False, "awaiting_upstream": False,
                    "source": "judgment", "turn_id": analysis_id}
        validated, skipped, preview = B.validate_state_delta(
            sid, aid, core.get("state_proposal") or {}, judgment,
            actor=B.CFG.get("actor"), frozen_state=snapshot)
        proposal_core = core.get("state_proposal") or {}
        delta_out = proposal_core.get("delta") or []
        aux_core = proposal_core.get("auxiliary") or []
        ignored_core = proposal_core.get("ignored_signals") or []

        signals = self._build_signals(core, proposal_core)
        writable = []
        by_signal = {}
        for d in delta_out:
            by_signal[d.get("source_signal")] = d
        for r in validated:
            d = by_signal.get(r.get("signal")) or {}
            writable.append({
                "source_signal": d.get("source_signal") or r.get("signal"),
                "target": r.get("target"),
                "proposed_delta": d.get("delta") or r.get("proposal"),
                "applied_delta": r.get("final_delta"),
                "old_value": r.get("old"), "new_value": r.get("new_value"),
            })
        aux_out = [{
            "source_signal": a.get("source_signal"),
            "proposed_delta": a.get("delta_if_enabled") if a.get("delta_if_enabled") is not None
                              else a.get("delta"),
            "reason_codes": ["CAPABILITY_NOT_ACTIVE"],
        } for a in aux_core]
        skipped_out = []
        for d in delta_out:
            if d.get("source_signal") in by_signal and not writable:
                pass
        for r in skipped:
            if r.get("signal"):
                skipped_out.append({"source_signal": r.get("signal"),
                                    "reason_codes": _skip_reason_codes(r)})
        for ig in ignored_core:
            skipped_out.append({"source_signal": ig.get("source_signal"),
                                "reason_codes": ["ROLE_NOT_WRITABLE"] if ig.get("role") != "state_shift"
                                                else ["CAPABILITY_NOT_ACTIVE"]})

        status = "ready" if writable else "reference_only"
        can_commit = bool(writable)
        reason_codes = [] if writable else self._reference_reason_codes(
            core, proposal_core, writable, skipped, ignored_core)
        profile = core.get("checkpoint_profile") or {}
        check = {"matched": profile.get("matched"), "fresh": profile.get("fresh"),
                 "code_changed": profile.get("code_changed"),
                 "checkpoint": profile.get("checkpoint"),
                 "profile_id": profile.get("profile_id")}
        capability = self._build_capability(core, profile, check, writable, aux_out)
        evidence = {
            "input_sha256": input_sha,
            "base_state_sha256": base_state_sha,
            "rules_fingerprint": rules,
            "translation": {"source": xlate_src, "input_en_sha256": _sha256_text(en)},
        }
        state_proposal_out = {
            "writable_delta": writable,
            "auxiliary": aux_out,
            "skipped": skipped_out,
            "preview_state": preview.get("state"),
        }

        # ---- 锁内复核并发布（版本/generation/规则未变才发布候选）----
        with self.lock:
            cur = self.state_version(scope)
            if cur != expected:
                self._release_inflight(scope, event_id, expected)
                raise _ProtoError(409, "STATE_VERSION_CONFLICT",
                                  "分析期间版本已变化，候选未发布",
                                  {"current_state_version": cur})
            rules2 = self.rules_fingerprint(model, force=True)
            if rules2 != rules:
                self._release_inflight(scope, event_id, expected)
                raise _ProtoError(409, "RULESET_CHANGED",
                                  "分析期间规则指纹变化（配置/档案/检查点/基线），请重分析")
            a = self._analyses[analysis_id]
            a.update({
                "status": status, "expires_at": self.now() + READY_TTL_S,
                "signals": signals, "state_proposal": state_proposal_out,
                "capability": capability, "evidence": evidence,
                "xlate_src": xlate_src, "en": en, "judgment": judgment,
                "proposal_core": proposal_core, "snapshot": snapshot,
                "preview_state": preview.get("state"),
            })
            self._inflight.pop((scope, event_id, expected), None)
            ev[event_id] = {"sha": input_sha, "status": "analyzed"}
            return self._analysis_response(self._analyses[analysis_id])

    def _release_inflight(self, scope, event_id, expected):
        ik = (scope, event_id, expected)
        aid = self._inflight.pop(ik, None)
        if aid:
            a = self._analyses.get(aid)
            if a and a.get("status") == "in_flight":
                self._analyses.pop(aid, None)

    def _build_signals(self, core, proposal_core):
        signals = {}
        for d in core.get("raw_deltas_all_signals") or []:
            sig = d.get("question")
            if sig:
                signals[sig] = {"availability": "known",
                                "raw_delta": d.get("delta") if _finite_number(d.get("delta")) else None,
                                "score": None}
        for name, v in (core.get("signal_values") or {}).items():
            ent = signals.setdefault(name, {"availability": "known", "raw_delta": None, "score": None})
            if _finite_number(v):
                ent["score"] = v
        return signals

    def _build_capability(self, core, profile, check, writable, aux_out):
        pv = {}
        for sig in [w.get("source_signal") for w in writable] + [a.get("source_signal") for a in aux_out]:
            ent = ((profile.get("signals") or {}).get(sig) or {})
            pv[sig] = {"grade": ent.get("grade"), "status": ent.get("status"),
                       "role": ent.get("role")}
        return {
            "checkpoint": check.get("checkpoint") or profile.get("checkpoint"),
            "profile_id": check.get("profile_id") or profile.get("profile_id"),
            "matched": bool(check.get("matched")), "fresh": bool(check.get("fresh")),
            "code_changed": bool(check.get("code_changed")), "signals": pv,
        }

    def _reference_reason_codes(self, core, proposal_core, writable, skipped, ignored):
        codes = []
        prof = core.get("checkpoint_profile") or {}
        if not prof:
            codes.append("PROFILE_UNAVAILABLE")
        for ig in ignored:
            if ig.get("role") != "state_shift":
                codes.append("ROLE_NOT_WRITABLE")
            elif ig.get("status") in ("auxiliary", "disabled", "semantic_review"):
                codes.append("CAPABILITY_NOT_ACTIVE")
            else:
                codes.append("TARGET_UNAVAILABLE")
        for s in skipped:
            c = _skip_reason_codes(s)
            for x in c:
                if x not in codes:
                    codes.append(x)
        if not codes:
            codes.append("NO_WRITABLE_SIGNAL")
        return codes

    # ======================================================================
    # GET /analysis/{id}（§3.5，只读，不触发重推理/在线翻译/提交）
    # ======================================================================
    def get_analysis(self, analysis_id, session_id, actor_id):
        scope = self._scope(session_id, actor_id)
        with self.lock:
            a = self._analyses.get(analysis_id)
            if not a or (a["session_id"], a["actor_id"]) != scope:
                raise _ProtoError(404, "ANALYSIS_NOT_FOUND", "未知/已清理/scope 不符的 analysis_id")
            self._maybe_expire(a)
            self._maybe_stale(a)
            return self._analysis_response(a)

    def _analysis_response(self, a):
        self._maybe_expire(a)
        self._maybe_stale(a)
        receipt = a.get("commit_receipt")
        return {
            "protocol_version": PROTOCOL_VERSION,
            "analysis_id": a["analysis_id"],
            "session_id": a["session_id"], "actor_id": a["actor_id"],
            "event_id": a["event_id"],
            "status": a["status"],
            "base_state_version": a["base_state_version"],
            "created_at": _iso(a["created_at"]),
            "expires_at": _iso(a["expires_at"]) if a.get("expires_at") else None,
            "can_commit": a["status"] in ("ready", "reference_only") and bool(a["state_proposal"].get("writable_delta")),
            "reason_codes": self._reason_codes_of(a),
            "signals": a["signals"],
            "state_proposal": a["state_proposal"],
            "capability": a["capability"],
            "evidence": a["evidence"],
            "commit_receipt": receipt,
        }

    def _reason_codes_of(self, a):
        wp = (a["state_proposal"] or {}).get("writable_delta") or []
        if wp:
            return []
        return self._reference_reason_codes_from_record(a)

    def _reference_reason_codes_from_record(self, a):
        codes = []
        cap = a.get("capability") or {}
        if not cap.get("fresh"):
            codes.append("PROFILE_UNAVAILABLE")
        for s in (a["state_proposal"] or {}).get("skipped") or []:
            for c in s.get("reason_codes") or []:
                if c not in codes:
                    codes.append(c)
        if not codes:
            codes.append("NO_WRITABLE_SIGNAL")
        return codes

    # ======================================================================
    # POST /commit_state（§3.4 / §5）
    # ======================================================================
    def commit_state(self, req):
        B = self.B
        self._require_only(req, {"session_id", "actor_id", "analysis_id",
                                 "expected_state_version"}, "commit_state")
        sid, aid = self._check_ids(req)
        analysis_id = req.get("analysis_id")
        if not isinstance(analysis_id, str) or not analysis_id:
            raise _ProtoError(422, "INVALID_REQUEST", "analysis_id 必填字符串")
        expected = self._check_version(req)
        scope = self._scope(sid, aid)
        model = self._effective_model()

        with self.lock:
            a = self._analyses.get(analysis_id)
            if not a or (a["session_id"], a["actor_id"]) != scope:
                raise _ProtoError(404, "ANALYSIS_NOT_FOUND", "未知/已清理/scope 不符的 analysis_id")
            # 精确重试：同 ID、同 scope、同 expected → 原回执（回执保留期内）
            if a["status"] == "committed":
                if expected == a.get("base_state_version") and a.get("commit_receipt"):
                    return self._commit_reply(a, replayed=True)
                raise _ProtoError(409, "IDEMPOTENCY_CONFLICT",
                                  "该 analysis 已提交；用原 expected_state_version 重试获取原回执")
            if a["status"] == "rejected":
                raise _ProtoError(409, "ANALYSIS_REJECTED", "该候选已被拒绝")
            self._maybe_expire(a)
            if a["status"] == "expired":
                raise _ProtoError(410, "ANALYSIS_EXPIRED", "候选已过期（TTL %ds）" % READY_TTL_S)
            if a["status"] == "stale" or a["status"] == "invalidated":
                raise _ProtoError(410, "ANALYSIS_INVALIDATED", "候选已因版本/Reset 失效")
            if a["status"] not in ("ready", "reference_only"):
                raise _ProtoError(409, "ANALYSIS_NOT_COMMITTABLE",
                                  "候选当前状态 %s 不可提交" % a["status"])
            current = self.state_version(scope)
            if expected != current or expected != a.get("base_state_version"):
                raise _ProtoError(409, "STATE_VERSION_CONFLICT",
                                  "提交基准版本与当前版本不一致",
                                  {"current_state_version": current})
            rules = self.rules_fingerprint(model, force=True)
            if rules != a.get("rules_fingerprint"):
                raise _ProtoError(409, "RULESET_CHANGED",
                                  "规则指纹已变化（配置/档案/检查点/基线），要求重分析")
            prof, check = B.load_capability_profile(model)
            if not check.get("fresh") or not check.get("matched"):
                raise _ProtoError(409, "PROFILE_UNAVAILABLE",
                                  "能力档案当前不可用/不匹配，拒绝提交",
                                  {"profile_fresh": check.get("fresh"),
                                   "matched": check.get("matched")})
            # 用当前状态重新校验（版本已一致；PROPOSAL_MISMATCH 兜底任何绕过写入）
            snapshot = B.actor_state_snapshot(sid, aid, actor=B.CFG.get("actor"))
            commits, skipped, preview = B.validate_state_delta(
                sid, aid, a.get("proposal_core") or {}, a.get("judgment") or {},
                actor=B.CFG.get("actor"), frozen_state=snapshot)
            if not commits:
                raise _ProtoError(409, "ANALYSIS_NOT_COMMITTABLE",
                                  "重新校验后没有可写项（reference_only 不允许空 Commit 冒充成功）")
            self._assert_preview_matches(a, commits)
            # 局部构造新状态并一次发布（发布段带回滚：任何异常 → 版本/状态/审计/事件全回退）
            new_state = _copy.deepcopy(snapshot)
            applied = []
            for r in commits:
                B._set_path(new_state, r.get("target"), r.get("new_value"))
                applied.append({
                    "source_signal": r.get("signal"), "target": r.get("target"),
                    "old_value": r.get("old"), "delta": r.get("final_delta"),
                    "new_value": r.get("new_value"),
                })
            state_changed = any(abs(float(x.get("delta") or 0)) > 1e-9 for x in applied)
            prev_ver = current
            commit_id = "cm_" + uuid.uuid4().hex[:12]
            ts = self.now()
            trace_item = {
                "t": ts, "kind": "accepted_interaction",
                "analysis_id": analysis_id, "event_id": a["event_id"],
                "session_id": sid, "actor_id": aid,
                "before_version": prev_ver, "after_version": "PENDING",
                "input_sha256": a.get("input_sha256"),
                "rules_fingerprint": a.get("rules_fingerprint"),
                "applied_delta": applied, "new_state": new_state,
            }
            receipt = {
                "protocol_version": PROTOCOL_VERSION,
                "status": "committed", "replayed": False,
                "analysis_id": analysis_id,
                "session_id": sid, "actor_id": aid, "event_id": a["event_id"],
                "commit_id": commit_id,
                "previous_state_version": prev_ver, "state_version": "PENDING",
                "state_changed": state_changed,
                "committed_at": _iso(ts),
                "applied_delta": applied,
                "state": _copy.deepcopy(new_state),
            }
            # ---- 回滚快照 ----
            had_bucket = scope in B._ACTOR_STATE
            saved_bucket = _copy.deepcopy(B._ACTOR_STATE.get(scope)) if had_bucket else None
            had_trace = scope in B._STATE_TRACE
            saved_trace = _copy.deepcopy(B._STATE_TRACE.get(scope)) if had_trace else None
            meta = self._ensure_bucket_meta(scope)
            saved_revision = meta["revision"]
            ev = self._event_record(scope, a["event_id"])
            prev_ev = _copy.deepcopy(ev.get(a["event_id"])) if a["event_id"] in ev else None
            try:
                new_ver = self._bump_revision(scope)
                trace_item["after_version"] = new_ver
                receipt["state_version"] = new_ver
                B._ACTOR_STATE[scope] = new_state
                tr = B._STATE_TRACE.setdefault(scope, [])
                tr.append(trace_item)
                del tr[:-(self.B._STATE_TRACE_MAX if hasattr(self.B, "_STATE_TRACE_MAX") else 30)]
                ev[a["event_id"]] = {"sha": a.get("input_sha256"), "status": "committed",
                                     "analysis_id": analysis_id, "commit_id": commit_id,
                                     "state_version": new_ver}
            except Exception:
                # 回滚：不留下部分状态/历史/版本/事件
                meta["revision"] = saved_revision
                if had_bucket:
                    B._ACTOR_STATE[scope] = saved_bucket
                else:
                    B._ACTOR_STATE.pop(scope, None)
                if had_trace:
                    B._STATE_TRACE[scope] = saved_trace
                else:
                    B._STATE_TRACE.pop(scope, None)
                if prev_ev is not None:
                    ev[a["event_id"]] = prev_ev
                else:
                    ev.pop(a["event_id"], None)
                raise _ProtoError(500, "INTERNAL_ERROR",
                                  "提交发布失败已回滚（无部分写入）：%r" % (sys.exc_info()[1],))
            a.update({"status": "committed", "terminal_at": ts, "commit_receipt": receipt})
            return self._commit_reply(a, replayed=False)

    def _assert_preview_matches(self, a, commits):
        want = {w.get("source_signal"): w for w in (a["state_proposal"] or {}).get("writable_delta") or []}
        for r in commits:
            sig = r.get("signal")
            w = want.get(sig)
            if w is None:
                raise _ProtoError(409, "PROPOSAL_MISMATCH",
                                  "提交时出现了候选里没有的信号项：%s" % sig)
            if abs(float(r.get("final_delta") or 0) - float(w.get("applied_delta") or 0)) > 1e-6 \
                    or (r.get("new_value") is not None and w.get("new_value") is not None
                        and abs(float(r["new_value"]) - float(w["new_value"])) > 1e-6):
                raise _ProtoError(
                    409, "PROPOSAL_MISMATCH",
                    "重新校验的最终增量/新值与原预览不一致（%s：预览 %s→%s，现校验 %s→%s）"
                    % (sig, w.get("old_value"), w.get("new_value"),
                       r.get("old"), r.get("new_value")))
        # 候选里所有 writable 项在提交时都必须仍然可写（缺失 = 现在不可写）
        got = {r.get("signal") for r in commits}
        for sig, w in want.items():
            if sig not in got:
                raise _ProtoError(409, "PROPOSAL_MISMATCH",
                                  "候选的 %s 现在不再可写（整次失败，不能部分写入）" % sig)

    def _commit_reply(self, a, replayed):
        receipt = a.get("commit_receipt") or {}
        return dict(receipt, protocol_version=PROTOCOL_VERSION, replayed=replayed)

    # ======================================================================
    # POST /reject_analysis（§3.5）
    # ======================================================================
    def reject_analysis(self, req):
        self._require_only(req, {"session_id", "actor_id", "analysis_id", "reason"}, "reject_analysis")
        sid, aid = self._check_ids(req)
        analysis_id = req.get("analysis_id")
        if not isinstance(analysis_id, str) or not analysis_id:
            raise _ProtoError(422, "INVALID_REQUEST", "analysis_id 必填字符串")
        reason = req.get("reason") or "user_cancelled"
        if reason not in ("user_cancelled", "director_rejected", "superseded"):
            raise _ProtoError(422, "INVALID_REQUEST", "reason 只允许 user_cancelled/director_rejected/superseded")
        scope = self._scope(sid, aid)
        with self.lock:
            a = self._analyses.get(analysis_id)
            if not a or (a["session_id"], a["actor_id"]) != scope:
                raise _ProtoError(404, "ANALYSIS_NOT_FOUND", "未知/已清理/scope 不符的 analysis_id")
            if a["status"] == "committed":
                raise _ProtoError(409, "ALREADY_COMMITTED", "已提交的候选不能被 Reject")
            if a["status"] == "rejected":
                return {"protocol_version": PROTOCOL_VERSION, "status": "rejected",
                        "replayed": True, "analysis_id": analysis_id,
                        "session_id": sid, "actor_id": aid, "reason": reason}
            self._maybe_expire(a)
            if a["status"] == "expired":
                raise _ProtoError(410, "ANALYSIS_EXPIRED", "候选已过期")
            if a["status"] in ("stale", "invalidated"):
                raise _ProtoError(410, "ANALYSIS_INVALIDATED", "候选已失效")
            if a["status"] not in ("ready", "reference_only"):
                raise _ProtoError(409, "ANALYSIS_NOT_COMMITTABLE",
                                  "候选当前状态 %s 不可拒绝" % a["status"])
            a["status"] = "rejected"
            a["terminal_at"] = self.now()
            a["reject_reason"] = reason
            # 关闭同一 event_id：同事件其它候选也不可提交
            ev = self._event_record(scope, a["event_id"])
            ev[a["event_id"]] = {"sha": a.get("input_sha256"), "status": "rejected",
                                 "analysis_id": analysis_id}
            for other in self._analyses.values():
                if (other["session_id"], other["actor_id"]) != scope:
                    continue
                if other["event_id"] == a["event_id"] and other["analysis_id"] != analysis_id \
                        and other["status"] in ("ready", "reference_only"):
                    other["status"] = "rejected"
                    other["terminal_at"] = self.now()
            return {"protocol_version": PROTOCOL_VERSION, "status": "rejected",
                    "replayed": False, "analysis_id": analysis_id,
                    "session_id": sid, "actor_id": aid, "reason": reason}


class _ProtoError(Exception):
    """协议错误：携带 HTTP 状态码与错误码（§8）。"""

    def __init__(self, http, code, message, details=None):
        self.http = http
        self.code = code
        self.message = message
        self.details = details
        super().__init__("protocol %s: %s" % (code, message))

    def body(self):
        return {"protocol_version": PROTOCOL_VERSION,
                "error": {"code": self.code, "message": self.message,
                          "details": self.details}}


def _skip_reason_codes(skip):
    txt = str(skip.get("skipped_reason") or "").lower()
    if "没有 range" in txt or "range" in txt:
        return ["TARGET_UNAVAILABLE"]
    if "status=" in txt and ("auxiliary" in txt or "write_status" in txt):
        return ["CAPABILITY_NOT_ACTIVE"]
    if "前置准入" in txt or "歧义" in txt:
        return ["CAPABILITY_NOT_ACTIVE"]
    if "没有当前值" in txt or "不猜初值" in txt:
        return ["UNKNOWN_VALUE"]
    if "没有拿到该 signal 的数值" in txt:
        return ["UNKNOWN_VALUE"]
    return ["NO_WRITABLE_SIGNAL"]


_BASE_TEXTS_MEMO = {"mtime": None, "texts": None}


def _baseline_texts_of(B):
    """基准用例文本集合（带 mtime 缓存；与 bridge 的 _baseline_texts 同语义）。"""
    names = ("observable.json", "contextual.json", "hidden_truth.json")
    d = B.TESTS_DIR / "cases"
    try:
        mt = tuple((d / n).stat().st_mtime for n in names)
    except OSError:
        mt = None
    m = _BASE_TEXTS_MEMO
    if m.get("mtime") == mt and m.get("texts") is not None:
        return m["texts"]
    texts = frozenset(B._case_texts())
    m.update({"mtime": mt, "texts": texts})
    return texts