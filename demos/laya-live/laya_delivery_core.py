"""P1 · 物品交付纵向切片：无模型的 Prepare → Commit 最小闭环。

定位（严格限定在 `docs/interaction-core/P1-执行任务卡.md` 的范围内）：
让一个**预置场景**中玩家实际持有的一件物品，经统一 Prepare → Commit 交给
指定 NPC。本模块只验证协议骨架本身 —— 版本、候选、逐动作结果、Canonical
Outcome、原子发布、幂等、回退、旧写入口使候选失效。

本模块**不接**：
  · 自由语言 Interpreter（P1 只用内部可注入的结构化 ActionIntent 做无模型联调）；
  · 真实 Laya 推理（transfer 是服务端规则可独立裁决的动作，显式 `rules_only`，
    回执中 `laya_evidence=[]`，从不声称有 Laya 证据）；
  · 云端叙事、页面、P2 的 move/take/unlock 玩法（只留扩展点，命中即短路）。

权威链（P0 契约 §2 的最小裁剪）：
    结构化 ActionIntent（内部注入）
     → Facts：服务端场景快照上的持有 / 目标 / 可及性硬前提（硬前提不满足即短路，
       不用「有限难度惩罚」代替拒绝）
     → 规则结算（rules_only）
     → Canonical Outcome + State Proposal（在副本上构造，零游戏写入）
     → Commit：锁内重验版本与规则、重算并与预览比对、原子发布物品归属/状态/
       正式历史/版本/回执
     → 权威回执 → 下一轮快照读到新归属

复用来来源：
  · 版本体系 / 事务锁 / 事件身份 / 发布回滚：本树 `laya_state_protocol.py`
    的 `LayaStateProtocol`（其 `commit_multi_entity_bundle` 按需适配自
    A 候选 `interaction_core/service.py` + `commit_interaction_bundle` 骨架）。
  · Actor State 桶与点路径写入：本树 `laya_bridge.py`（`_ACTOR_STATE`、
    `actor_state_snapshot`、`_set_path`）。
  · 场景/规则思路参考 A 的 `interaction_core/{scene,rules}.py`；**不整包搬运**，
    P1 只实现 `transfer` 一条规则，六档 Resolver 与分级玩法留 P2。

唯一真源：物品归属只存在于世界运行态 `interaction.objects.<id>.owner`（即
`_ACTOR_STATE[(session_id, "ic_world")]`），**不存在**第二份可写 inventory/owner。
"""
import copy as _copy
import hashlib
import json
import re
import sys
import time
import uuid
from pathlib import Path

if __package__ in (None, ""):  # 允许以脚本/测试方式从 demos/laya-live 导入
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from laya_state_protocol import _ProtoError  # noqa: E402  （错误协议与 P2 共用）

WORLD = "ic_world"
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PROTOCOL_VERSION = "laya-delivery-v1"
SCENE_ID = "fusion-tavern-v1"
RULESET_ID = "fusion-rules-v1"
SOURCE = "structured_internal"

READY_TTL_S = 600
MAX_PENDING = 200
MAX_ACTIONS = 8
MAX_INTENT_CHARS = 2000

#: 本轮实现（可独立裁决、无需模型）的动作。
IMPLEMENTED_OPERATIONS = ("transfer",)
#: 已声明但**本轮不实现**的动作 —— P2 扩展点。命中即硬短路为
#: `UNSUPPORTED_OPERATION`，不做「用有限难度惩罚代替拒绝」。
P2_OPERATIONS = ("take", "move", "unlock", "inspect", "communicate", "attack")

INTENT_FIELDS = {"id", "operation", "target_ids", "object_id", "mode",
                 "kind", "content", "evidence"}
MODES = ("attempt", "negated", "hypothetical", "quoted")
#: 生产输入绝不允许注入的口子（难度 / delta / Outcome / 成功档位）。
FORBIDDEN_FIELDS = ("difficulty", "delta", "state_delta", "outcome", "margin",
                    "success", "degree", "success_degree", "writable_delta")
#: 需要澄清（而不是「已失败」）的原因码：目标不明 / 物品不明。
CLARIFY_REASONS = frozenset({"target_unresolved", "object_unknown"})


def _iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def _sha_text(value):
    if isinstance(value, str):
        return hashlib.sha256(value.encode("utf-8")).hexdigest()
    blob = json.dumps(value, sort_keys=True, ensure_ascii=False,
                      separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# ==========================================================================
# 服务端场景模板（服务端作者化，绝不从玩家声明推断）
# ==========================================================================
def scene_templates(B):
    """返回该场景的实体模板。每次调用重新构造，避免共享可变状态。"""
    def actor(name, name_en, *, skill, trust=50, relationship_to=None):
        st = B._blank_actor_state(B.CFG.get("actor"))
        st.update(name=name, name_en=name_en)
        st.setdefault("relationship", {}).update(trust=trust, doubt=30)
        st["interaction"] = {
            "location": "tavern",
            "stats": {"strength": skill, "perception": skill, "persuasion": skill,
                      "defense": 2, "resolve": 2},
            "energy": 10, "incapacitated": False, "restrained": False,
            "relationship_to": relationship_to,
        }
        return st

    return {
        "player": actor("玩家", "Player", skill=5),
        "lia": actor("莉亚", "Lia", skill=6, trust=60, relationship_to="player"),
        WORLD: {
            "name": "铁壶酒馆运行场景",
            "interaction": {
                "scene_id": SCENE_ID,
                "location": "tavern",
                "turn_tick": 0,
                "facts": [],
                "turns": [],          # 正式历史：Commit 才追加
                "objects": {
                    "badge": {"name": "徽章", "kind": "item", "location": "tavern",
                              "owner": "player", "portable": True},
                    "apple": {"name": "苹果", "kind": "item", "location": "tavern",
                              "owner": "player", "portable": True},
                    # P2 拾取链的素材，本轮只作为「未持有」反例存在。
                    "cellar_key": {"name": "地窖钥匙", "kind": "item",
                                   "location": "old_well", "owner": None,
                                   "portable": True},
                },
            },
        },
    }


class DeliveryCore:
    """P1 物品交付核心。所有写入口只有 `commit`；`prepare_structured` 零游戏写入。"""

    def __init__(self, B, protocol=None, now=None):
        self.B = B
        self.P = protocol if protocol is not None else B.PROTOCOL
        self.now = now or time.time
        self.templates = scene_templates(B)
        self._pending = {}      # analysis_id -> 候选（进程内，非正式历史）
        self._inflight = set()  # (session, actor, event_id) single-flight

    # ------------------------------------------------------------------
    # 场景初始化（服务端完成，与 Prepare 分离）
    # ------------------------------------------------------------------
    def ensure_scene(self, session_id):
        """把场景模板写进各实体桶 —— 服务端场景初始化，与 Prepare 分离。

        只在会话首次执行：新建实体桶并**推进该实体的版本**（首次初始化改变了游戏状态，
        必须让「读过模板快照」的旧候选失效）；重复调用不写、不推版本（幂等）。
        返回本次新建的实体列表。
        """
        sid = str(session_id or "default")
        created = []
        with self.P.lock:
            for entity, tpl in self.templates.items():
                scope = (sid, entity)
                if scope not in self.B._ACTOR_STATE:
                    self.B._ACTOR_STATE[scope] = _copy.deepcopy(tpl)
                    created.append(entity)
            for entity in created:
                self.P._bump_revision((sid, entity))
        return created

    def is_initialized(self, session_id):
        """该会话是否已由服务端完成场景初始化（所有实体桶都存在）。"""
        sid = str(session_id or "default")
        return all((sid, e) in self.B._ACTOR_STATE for e in self.templates)

    def _require_initialized(self, session_id):
        """Prepare 的前置硬条件：不得把模板快照当成已初始化的正式状态使用。"""
        sid = str(session_id or "default")
        missing = [e for e in self.templates if (sid, e) not in self.B._ACTOR_STATE]
        if missing:
            raise _ProtoError(409, "SCENE_NOT_INITIALIZED",
                              "该会话场景尚未由服务端初始化，缺失实体：%s；"
                              "请先 ensure_scene，模板快照不作为正式状态使用"
                              % "、".join(missing), {"missing": sorted(missing)})
        return True

    def _snapshot(self, session_id):
        """读取所有被读实体的服务端快照与版本（调用方需已持锁）。"""
        B = self.B
        states, versions = {}, {}
        for entity, tpl in self.templates.items():
            scope = (str(session_id), entity)
            state = _copy.deepcopy(tpl)
            bucket = B._ACTOR_STATE.get(scope)
            if bucket:
                # 与 A 的桥接语义一致：已存在的桶（含旧路由写过的）覆盖模板。
                state.update(_copy.deepcopy(bucket))
            states[entity] = state
            versions[entity] = self.P.state_version(scope)
        return {"states": states, "versions": versions}

    def state(self, session_id):
        """只读场景视图（含各实体版本）。不初始化场景、不写任何状态。"""
        sid = str(session_id or "default")
        if not sid or len(sid) > 64:
            raise _ProtoError(422, "INVALID_REQUEST", "session_id 不合法")
        with self.P.lock:
            snap = self._snapshot(sid)
            return {
                "protocol_version": PROTOCOL_VERSION,
                "session_id": sid,
                "versions": snap["versions"],
                "states": snap["states"],
                "initialized": {e: (sid, e) in self.B._ACTOR_STATE
                                for e in self.templates},
            }

    # ------------------------------------------------------------------
    # 请求校验（严格白名单 + 注入口子封死）
    # ------------------------------------------------------------------
    def _check_versions(self, req):
        v = req.get("expected_versions")
        if not isinstance(v, dict) or not v:
            raise _ProtoError(422, "INVALID_REQUEST", "expected_versions 必填非空版本映射")
        for k, val in v.items():
            if not isinstance(k, str) or not isinstance(val, str) or not val:
                raise _ProtoError(422, "INVALID_REQUEST",
                                  "expected_versions 必须是 实体 -> 版本字符串")
        want = set(self.templates)
        got = set(v)
        if got != want:
            raise _ProtoError(422, "INVALID_REQUEST",
                              "expected_versions 必须覆盖且仅覆盖被读实体：缺 %s，多 %s"
                              % (sorted(want - got), sorted(got - want)))
        return {str(k): str(val) for k, val in v.items()}

    def _check_actions(self, req):
        acts = req.get("actions")
        if not isinstance(acts, list) or not acts or len(acts) > MAX_ACTIONS:
            raise _ProtoError(422, "INVALID_REQUEST",
                              "actions 必须是 1–%d 项的结构化 ActionIntent 数组" % MAX_ACTIONS)
        out = []
        for i, it in enumerate(acts):
            where = "actions[%d]" % i
            if not isinstance(it, dict):
                raise _ProtoError(422, "INVALID_REQUEST", "%s 必须是对象" % where)
            banned = sorted(set(it) & set(FORBIDDEN_FIELDS))
            if banned:
                raise _ProtoError(422, "INVALID_REQUEST",
                                  "%s 含被禁字段（禁止客户端注入难度/delta/Outcome/成功档）：%s"
                                  % (where, "、".join(banned)))
            self.P._require_only(it, INTENT_FIELDS, where)
            aid_ = it.get("id")
            if not isinstance(aid_, str) or not aid_ or len(aid_) > 64:
                raise _ProtoError(422, "INVALID_REQUEST", "%s.id 必填且 ≤64 字符" % where)
            op = it.get("operation")
            if not isinstance(op, str) or not op:
                raise _ProtoError(422, "INVALID_REQUEST", "%s.operation 必填" % where)
            if op not in IMPLEMENTED_OPERATIONS:
                if op in P2_OPERATIONS:
                    raise _ProtoError(
                        409, "UNSUPPORTED_OPERATION",
                        "动作 %s 是 P2 扩展点，本轮未实现；硬前提直接短路，"
                        "不做有限难度惩罚" % op,
                        {"implemented": list(IMPLEMENTED_OPERATIONS),
                         "declared_p2": list(P2_OPERATIONS)})
                raise _ProtoError(422, "UNKNOWN_OPERATION", "未声明的动作：%s" % op)
            targets = it.get("target_ids") or []
            if not isinstance(targets, list) or not all(isinstance(t, str) for t in targets):
                raise _ProtoError(422, "INVALID_REQUEST", "%s.target_ids 必须是字符串数组" % where)
            obj = it.get("object_id")
            if obj is not None and not isinstance(obj, str):
                raise _ProtoError(422, "INVALID_REQUEST", "%s.object_id 必须是字符串或 null" % where)
            mode = it.get("mode") or "attempt"
            if mode not in MODES:
                raise _ProtoError(422, "INVALID_REQUEST",
                                  "%s.mode 只允许 %s" % (where, "/".join(MODES)))
            for f in ("kind", "content", "evidence"):
                val = it.get(f)
                if val is not None and (not isinstance(val, str) or len(val) > MAX_INTENT_CHARS):
                    raise _ProtoError(422, "INVALID_REQUEST",
                                      "%s.%s 必须为 ≤%d 字符的字符串" % (where, f, MAX_INTENT_CHARS))
            out.append({
                "id": aid_, "operation": op, "target_ids": [str(t) for t in targets],
                "object_id": obj, "mode": mode,
                "kind": it.get("kind") or "", "content": it.get("content") or "",
                "evidence": it.get("evidence") or "",
            })
        return out

    # ------------------------------------------------------------------
    # 规则指纹（服务端规则版本；与 Laya 能力档案无关 —— 本切片无模型）
    # ------------------------------------------------------------------
    def rules_fingerprint(self):
        return _sha_text({
            "protocol_version": PROTOCOL_VERSION,
            "ruleset": RULESET_ID, "scene": SCENE_ID,
            "implemented": list(IMPLEMENTED_OPERATIONS),
            "templates": scene_templates(self.B),
        })

    # ------------------------------------------------------------------
    # 硬前提检查（只读服务端事实）
    # ------------------------------------------------------------------
    def _check_transfer(self, intent, actor_id, states):
        reasons, evidence = [], []
        world = states[WORLD]["interaction"]
        objects = world["objects"]
        src = states[actor_id]["interaction"]
        obj_id = intent.get("object_id")
        targets = intent.get("target_ids") or []
        item = objects.get(obj_id) if obj_id else None
        if len(targets) != 1:
            reasons.append("transfer_requires_exactly_one_target")
        else:
            tid = targets[0]
            if tid == actor_id:
                reasons.append("target_is_self")
            elif tid not in states or tid == WORLD:
                reasons.append("target_unresolved")
            else:
                tgt = states[tid]["interaction"]
                if tgt.get("location") != src.get("location"):
                    reasons.append("target_out_of_reach")
                if tgt.get("incapacitated"):
                    reasons.append("recipient_unavailable")
        if src.get("incapacitated"):
            reasons.append("actor_incapacitated")
        if item is None:
            reasons.append("object_unknown")
        elif item.get("owner") != actor_id:
            reasons.append("item_not_owned")
        elif item.get("portable") is not True:
            reasons.append("item_not_portable")
        else:
            evidence.append("possession:" + obj_id)
        return {"allowed": not reasons, "reasons": reasons, "evidence": evidence}

    # ------------------------------------------------------------------
    # 逐动作结算（在副本上顺序模拟；不做 margin，不产生被阻止的物理效果）
    # ------------------------------------------------------------------
    def _resolve_one(self, intent, actor_id, states):
        op = intent["operation"]
        target_id = (intent["target_ids"] or [None])[0]
        check = self._check_transfer(intent, actor_id, states) if op == "transfer" \
            else {"allowed": False, "reasons": ["operation_not_implemented"], "evidence": []}
        if intent["mode"] != "attempt":
            return {
                "action_id": intent["id"], "operation": op, "target_id": target_id,
                "degree": "skipped", "achieved": "非真实物理尝试（%s），不计为行动失败" % intent["mode"],
                "check": {"allowed": False, "reasons": ["not_an_attempt"], "evidence": []},
                "changes": [], "facts": [], "costs": [], "complications": [],
                "opportunities": [], "evidence": intent["evidence"],
            }
        if not check["allowed"]:
            return {
                "action_id": intent["id"], "operation": op, "target_id": target_id,
                "degree": "failure",
                "achieved": "未执行：" + "、".join(check["reasons"]),
                "check": check, "changes": [], "facts": [], "costs": [],
                "complications": [],
                "opportunities": ["先满足动作前提，再重新尝试。"],
                "evidence": intent["evidence"],
            }
        # transfer 的规则：硬前提全部满足 → 归属一次性转交（无难度、无档位、无惩罚）
        before = states[WORLD]["interaction"]["objects"][intent["object_id"]]["owner"]
        changes = [{"entity_id": WORLD, "path": "interaction.objects.%s.owner" % intent["object_id"],
                    "before": before, "after": target_id, "source": "rule:" + intent["id"]}]
        facts = [{"kind": "ownership", "object": intent["object_id"], "owner": target_id}]
        return {
            "action_id": intent["id"], "operation": op, "target_id": target_id,
            "degree": "success",
            "achieved": "%s 由 %s 交给 %s" % (intent["object_id"], actor_id, target_id),
            "check": check, "changes": changes, "facts": facts, "costs": [],
            "complications": [],
            "opportunities": ["可继续交付其它已持有物品（P2 扩展）。"],
            "evidence": intent["evidence"],
        }

    def _calculate(self, actor_id, intents, states):
        """在副本上顺序结算，返回 (outcome, proposal, clarifications)。"""
        work = _copy.deepcopy(states)
        resolutions, changes, facts, clarifications = [], [], [], []
        for intent in intents:
            r = self._resolve_one(intent, actor_id, work)
            if intent["mode"] == "attempt":
                for reason in r["check"]["reasons"]:
                    if reason in CLARIFY_REASONS:
                        clarifications.append("%s:%s" % (intent["id"], reason))
            for ch in r["changes"]:
                self.B._set_path(work[ch["entity_id"]], ch["path"], ch["after"])
                changes.append(ch)
            for f in r["facts"]:
                work[WORLD]["interaction"]["facts"].append(_copy.deepcopy(f))
                facts.append(f)
            resolutions.append(r)
        if changes:
            tick = work[WORLD]["interaction"]["turn_tick"]
            changes.append({"entity_id": WORLD, "path": "interaction.turn_tick",
                            "before": tick, "after": tick + 1, "source": "turn_clock"})
            if facts:
                old_facts = states[WORLD]["interaction"]["facts"]
                changes.append({"entity_id": WORLD, "path": "interaction.facts",
                                "before": _copy.deepcopy(old_facts),
                                "after": _copy.deepcopy(work[WORLD]["interaction"]["facts"]),
                                "source": "canonical_facts"})
        degrees = [r["degree"] for r in resolutions if r["degree"] != "skipped"]
        if not degrees:
            result, degree = "no_attempt", "skipped"
        elif all(d == "failure" for d in degrees):
            result, degree = "blocked", "failure"
        elif all(d == "success" for d in degrees):
            result, degree = "achieved", "success"
        else:
            result, degree = "partial_success", "partial_success"
        outcome = {
            "event_id": None, "status": "resolved", "result": result, "degree": degree,
            "resolutions": resolutions, "facts_created": facts,
            "state_changes": changes, "rules_only": True, "laya_evidence": [],
        }
        proposal = {"base_versions": None, "changes": changes}
        return outcome, proposal, clarifications

    # ------------------------------------------------------------------
    # 候选生命周期
    # ------------------------------------------------------------------
    def _cleanup(self):
        """惰性回收：过期的终态/失效墓碑。已提交候选在提交时即从 Pending 释放，
        其权威回执由协议事件表长期提供（幂等重放走 `_find_event`）。"""
        now = self.now()
        drop = [aid for aid, c in self._pending.items()
                if c.get("expires_at") and now >= c["expires_at"]]
        for aid in drop:
            self._pending.pop(aid, None)
        return len(drop)

    def _preview(self, c):
        ready = bool(c["proposal"]["changes"])
        return {
            "protocol_version": PROTOCOL_VERSION,
            "analysis_id": c["analysis_id"],
            "session_id": c["session_id"], "actor_id": c["actor_id"],
            "event_id": c["event_id"],
            "status": "ready" if ready else "blocked",
            "can_commit": ready,
            "base_versions": _copy.deepcopy(c["base_versions"]),
            "expires_at": _iso(c["expires_at"]),
            "source": SOURCE, "rules_only": True, "laya_evidence": [],
            "rules_fingerprint": c["rules_fingerprint"],
            "outcome": _copy.deepcopy(c["outcome"]),
            "state_proposal": _copy.deepcopy(c["proposal"]),
            "reason_codes": [] if ready else _reason_codes(c["outcome"]),
        }

    # ------------------------------------------------------------------
    # Prepare（零游戏写入；只写进程内候选元数据）
    # ------------------------------------------------------------------
    def prepare_structured(self, req):
        P = self.P
        P._require_only(req, {"session_id", "event_id", "actor_id",
                              "expected_versions", "actions"}, "prepare")
        sid, aid = P._check_ids(req)
        event_id = P._check_event_id(req)
        expected = self._check_versions(req)
        intents = self._check_actions(req)
        input_sha = _sha_text({"session_id": sid, "actor_id": aid, "event_id": event_id,
                               "actions": intents})
        with P.lock:
            self._cleanup()
            self._require_initialized(sid)          # 未初始化 → 明确错误，不产生 Pending
            rec_aid, rec = self._find_event(sid, event_id)
            if rec and rec.get("status") == "committed":
                raise _ProtoError(409, "EVENT_ALREADY_COMMITTED",
                                  "该 event 已提交，禁止另造候选重复写",
                                  {"committed_scope": rec_aid,
                                   "commit_id": rec.get("commit_id"),
                                   "versions": rec.get("versions")})
            snap = self._snapshot(sid)
            if expected != snap["versions"]:
                raise _ProtoError(409, "STATE_VERSION_CONFLICT",
                                  "expected_versions 与当前版本不一致；请重新读取场景",
                                  {"current_versions": snap["versions"]})
            if aid not in snap["states"] or aid == WORLD:
                raise _ProtoError(422, "ACTOR_UNKNOWN", "未知/不可作为行动主体的角色")
            # 事件身份按 **(session_id, event_id)** 唯一（P0 §4），不是按 actor 分桶：
            #   · 另一 actor 或另一组动作借用同一 event → 409（不并存两份候选）；
            #   · 同一 actor + 同一动作，但旧候选已失效/被阻塞/基于旧版本 → 允许基于新版本
            #     重新 Prepare（旧 analysis_id 保留为失效墓碑，仍不可提交）；
            #   · 未失效且版本未变的同一候选 → 幂等复用（返回同一 analysis_id）。
            superseded = []
            for other_id, other in self._pending.items():
                if (other["session_id"], other["event_id"]) != (sid, event_id):
                    continue
                if other["input_sha256"] != input_sha:
                    raise _ProtoError(409, "EVENT_PAYLOAD_CONFLICT",
                                      "同一 (session_id,event_id) 已由另一 actor 或另一组动作占用",
                                      {"existing_actor_id": other["actor_id"],
                                       "existing_status": other["status"],
                                       "existing_analysis_id": other_id})
                if other["status"] == "ready" and other["base_versions"] == expected:
                    return self._preview(other)
                superseded.append(other_id)
            for other_id in superseded:
                old = self._pending[other_id]
                old["status"] = "invalidated"
                old["terminal_at"] = self.now()
            if len(self._pending) >= MAX_PENDING:
                self._cleanup()
            if len(self._pending) >= MAX_PENDING:
                raise _ProtoError(429, "PENDING_CAPACITY",
                                  "候选已达上限（%d），请等待过期" % MAX_PENDING)
            outcome, proposal, clarifications = self._calculate(aid, intents, snap["states"])
            if clarifications:
                raise _ProtoError(409, "NEEDS_CLARIFICATION",
                                  "必需对象或目标无法确定，请澄清（不暗选）",
                                  {"clarifications": sorted(set(clarifications))})
            outcome["event_id"] = event_id
            proposal["base_versions"] = dict(expected)
            analysis_id = uuid.uuid4().hex
            self._pending[analysis_id] = {
                "analysis_id": analysis_id,
                "session_id": sid, "actor_id": aid, "event_id": event_id,
                "base_versions": dict(expected), "input_sha256": input_sha,
                "intents": _copy.deepcopy(intents),
                "snapshot": _copy.deepcopy(snap["states"]),
                "outcome": outcome, "proposal": proposal,
                "rules_fingerprint": self.rules_fingerprint(),
                "source": SOURCE,
                "status": "ready" if proposal["changes"] else "blocked",
                "created_at": self.now(), "expires_at": self.now() + READY_TTL_S,
                "terminal_at": None, "receipt": None,
            }
            return self._preview(self._pending[analysis_id])

    def _check_session_id(self, req):
        v = req.get("session_id")
        if not isinstance(v, str) or not _ID_RE.match(v):
            raise _ProtoError(422, "INVALID_REQUEST",
                              "session_id 必须为 1–64 位 [A-Za-z0-9_-] 且非空")
        return v

    def _find_event(self, session_id, event_id):
        """在会话内查找事件身份（作用域 = 提交时的行动主体，由服务端候选决定）。"""
        for (sid, _aid), bucket in self.P._events.items():
            if sid == str(session_id) and event_id in bucket:
                return str(_aid), bucket[event_id]
        return None, None

    # ------------------------------------------------------------------
    # Commit（唯一写入口）
    # ------------------------------------------------------------------
    def commit(self, req):
        """只接受「服务端候选引用 + 期望版本」。

        不接受 actor 声明、事实、难度、delta 或成功档位；多出的字段一律 422
        （严格白名单）。作用域 actor 由服务端候选提供，不采信客户端自报。
        """
        P = self.P
        P._require_only(req, {"session_id", "event_id", "analysis_id",
                              "expected_versions"}, "commit")
        sid = self._check_session_id(req)
        event_id = P._check_event_id(req)
        analysis_id = req.get("analysis_id")
        if not isinstance(analysis_id, str) or not analysis_id:
            raise _ProtoError(422, "INVALID_REQUEST", "analysis_id 必填字符串")
        expected = self._check_versions(req)
        request_sha = _sha_text({"session_id": sid, "event_id": event_id,
                                 "analysis_id": analysis_id})
        with P.lock:
            self._cleanup()
            # ① 幂等：同 (session,event) 已提交 → 原回执 replayed=True，不二次转移/不推进时钟
            rec = self._find_event(sid, event_id)[1]
            if rec and rec.get("status") == "committed":
                if rec.get("sha") != request_sha:
                    raise _ProtoError(409, "EVENT_PAYLOAD_CONFLICT",
                                      "同一 event_id 用不同 analysis 载荷重放，拒绝")
                if rec.get("base_versions") != expected:
                    raise _ProtoError(409, "IDEMPOTENCY_CONFLICT",
                                      "重放所用基准版本与已提交回执不符")
                prior = rec.get("interaction_receipt")
                if prior is None:
                    raise _ProtoError(409, "EVENT_ALREADY_COMMITTED",
                                      "该 event 已由其它协议路径提交")
                return dict(_copy.deepcopy(prior), replayed=True)
            c = self._pending.get(analysis_id)
            if not c or c["session_id"] != sid or c["event_id"] != event_id:
                raise _ProtoError(404, "ANALYSIS_NOT_FOUND", "未知/已清理/scope 不符的候选")
            aid = c["actor_id"]
            if c["status"] == "invalidated":
                raise _ProtoError(410, "ANALYSIS_INVALIDATED", "候选已失效，请重新 Prepare")
            if self.now() >= c["expires_at"]:
                c["status"] = "expired"
                raise _ProtoError(410, "ANALYSIS_EXPIRED", "候选已过期（TTL %ds）" % READY_TTL_S)
            if c["status"] == "blocked" or not c["proposal"]["changes"]:
                raise _ProtoError(409, "ANALYSIS_NOT_COMMITTABLE",
                                  "硬前提未满足，没有可发布的写项：%s"
                                  % "、".join(_reason_codes(c["outcome"])))
            # ② 版本复核（所有被读实体）
            snap = self._snapshot(sid)
            cur = snap["versions"]
            if expected != cur or expected != c["base_versions"]:
                c["status"] = "invalidated"
                c["terminal_at"] = self.now()
                raise _ProtoError(409, "STATE_VERSION_CONFLICT",
                                  "提交基准版本与当前版本不一致，候选失效，请重新 Prepare",
                                  {"current_versions": cur})
            # ③ 规则复核
            if self.rules_fingerprint() != c["rules_fingerprint"]:
                c["status"] = "invalidated"
                c["terminal_at"] = self.now()
                raise _ProtoError(409, "RULESET_CHANGED",
                                  "规则指纹已变化，候选失效，请重新 Prepare")
            # ④ 锁内重算并与预览比对（不同 → 409 + 候选失效，绝不静默换结果）
            outcome, proposal, clarifications = self._calculate(
                aid, c["intents"], snap["states"])
            outcome["event_id"] = event_id
            proposal["base_versions"] = dict(expected)
            if clarifications or proposal["changes"] != c["proposal"]["changes"] \
                    or outcome != c["outcome"]:
                c["status"] = "invalidated"
                c["terminal_at"] = self.now()
                raise _ProtoError(409, "PROPOSAL_MISMATCH",
                                  "锁内重算与预览不一致，候选失效，请重新 Prepare")
            # ⑤ 构造写入集合（仅受影响实体）与正式历史
            touched = sorted({ch["entity_id"] for ch in proposal["changes"]} | {WORLD})
            new_states = {e: _copy.deepcopy(snap["states"][e]) for e in touched}
            applied_owner = []
            for ch in proposal["changes"]:
                ok = self.B._set_path(new_states[ch["entity_id"]], ch["path"], ch["after"])
                if not ok:
                    c["status"] = "invalidated"
                    raise _ProtoError(422, "INVALID_WRITE_PATH",
                                      "点路径不存在，拒绝静默造字段：%s" % ch["path"])
                if ch["path"].endswith(".owner"):
                    applied_owner.append({"object": ch["path"].split(".")[-2],
                                          "from": ch["before"], "to": ch["after"]})
            commit_id = "dl_" + uuid.uuid4().hex[:12]
            ts = self.now()
            new_states[WORLD]["interaction"]["turns"].append({
                "commit_id": commit_id, "event_id": event_id,
                "analysis_id": analysis_id, "actor_id": aid,
                "result": outcome["result"], "degree": outcome["degree"],
                "owner_changes": _copy.deepcopy(applied_owner),
                "committed_at": _iso(ts),
            })
            receipt = {
                "protocol_version": PROTOCOL_VERSION,
                "status": "committed", "replayed": False,
                "commit_id": commit_id, "analysis_id": analysis_id,
                "session_id": sid, "actor_id": aid, "event_id": event_id,
                "base_versions": dict(expected),
                "committed_at": _iso(ts),
                "source": SOURCE, "rules_only": True, "laya_evidence": [],
                "input_sha256": c["input_sha256"], "request_sha256": request_sha,
                "rules_fingerprint": c["rules_fingerprint"],
                "owner_changes": _copy.deepcopy(applied_owner),
                "outcome": _copy.deepcopy(outcome),
            }
            trace = {"t": ts, "kind": "p1_item_delivery",
                     "analysis_id": analysis_id, "event_id": event_id,
                     "session_id": sid, "actor_id": aid,
                     "rules_fingerprint": c["rules_fingerprint"],
                     "applied_changes": _copy.deepcopy(proposal["changes"])}
            result = self.P.commit_multi_entity_bundle(
                sid, aid, event_id, expected, new_states, trace, receipt)
            c["status"] = "committed"
            c["terminal_at"] = ts
            c["receipt"] = result
            # 已提交候选立即释放 Pending 容量：权威回执由协议事件表长期提供，
            # 幂等重放走 `_find_event`，不再依赖进程内候选。
            self._pending.pop(analysis_id, None)
            return result

    def get_receipt(self, session_id, event_id):
        """按 (session_id, event_id) 取已提交回执（事件身份不再是 actor 桶）。"""
        with self.P.lock:
            rec = self._find_event(session_id, event_id)[1]
            if not rec or rec.get("status") != "committed" \
                    or rec.get("interaction_receipt") is None:
                raise _ProtoError(404, "RECEIPT_UNKNOWN", "未找到已提交回执")
            return _copy.deepcopy(rec["interaction_receipt"])


def _reason_codes(outcome):
    codes = []
    for r in outcome.get("resolutions") or []:
        if r["degree"] == "skipped" and "NOT_AN_ATTEMPT" not in codes:
            codes.append("NOT_AN_ATTEMPT")
        for reason in r["check"]["reasons"]:
            if reason not in codes:
                codes.append(reason.upper())
    return codes or ["NO_WRITABLE_RESULT"]
