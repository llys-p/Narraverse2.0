"""P1 · 物品交付纵向切片：无模型的 Prepare → Commit 最小闭环。

定位（严格限定在 `docs/interaction-core/P1-执行任务卡.md` 的范围内）：
让一个**预置场景**中玩家实际持有的一件物品，经统一 Prepare → Commit 交给
指定 NPC。本模块只验证协议骨架本身 —— 版本、候选、逐动作结果、Canonical
Outcome、原子发布、幂等、回退、旧写入口使候选失效。

  本模块**不接**：
  · 自由语言 Interpreter（P2-A 在独立模块产出 ActionIntent，本模块只消费结构化意图）；
  · 真实 Laya 推理（本轮动作用服务端规则可独立裁决，显式 `rules_only`，
    回执中 `laya_evidence=[]`，从不声称有 Laya 证据）；
  · 云端叙事、页面（`communicate`/`inspect` 见 P2-B2a，非致命对抗见 P2-B2b）。

P3-A 追加（服务端内部 Evidence 候选接线，仍零真实模型）：
  · 新增可注入的 `evidence_provider`（服务端内部，默认 None = 纯规则）；只有注入的
    Provider 才产生 `laya_evidence`，固定 fixture 显式 `source=test_fixture`，不冒充真实 Laya。
  · 先有事实再取证据：只对 `execution_status=attempted` 且听者在场的 `communicate`，
    且听者 `relationship_to == actor_id`（第一切片限 `lia → player`）才可能产出可写 Evidence。
  · 可写信号仅 `role=state_shift` 且 `status=active` 的 `doubt_shift`，经 `B.state_transition`
    校验后写 `lia.relationship.doubt`；其余信号最多作辅助 Evidence，不产生写项。
  · Evidence 在 Prepare 时算一次并存进候选；Commit 锁内用候选里的 Evidence 重算并比对，
    **不二次调用 Provider**。关系写项与规则写项经原有多实体事务一次发布、一次回滚。

P3-A-R1 复审修复追加（仍零真实模型）：
  · **档案身份重验**：新增可注入的服务端身份源 `capability_identity`（callable）；Prepare 锁内
    读一次固化进候选，Commit 锁内重读比较，变化 → 409 `CAPABILITY_CHANGED`、零写入、不调模型。
    身份来自服务端身份源，**不采信 Provider 自报**。
  · **Provider 可见数据最小化**：`make_provider_input` 不传玩家完整 actor_state，目标 NPC 状态
    剔除 `interaction.knowledge`；回执 Evidence 只保留协议白名单字段。
  · **同轮写项口径**：同 NPC 同路径多条可写 Evidence 先累加 delta、再对整轮应用一次 transition。
  · **锁边界**：Prepare 三段式——锁内（快照/事件占用/规则结算/身份固化）→ 锁外（耗时 Provider）
    → 重新锁内（版本/事件复核）再存候选；锁外窗口状态变化 → 409，不发布旧候选。

P3-A-R2 追加（同事件并发单飞，仍零真实模型）：
  · 新增以 **(session_id, event_id)** 为键的 in-flight 占用表 `_inflight`（dict）。Prepare 第一段
    离开锁前原子登记；同事件并发只允许一次 Provider 调用，同载荷 → 409 `PREPARE_IN_PROGRESS`，
    不同载荷 → 409 `EVENT_PAYLOAD_CONFLICT`，不生成两个可提交候选。
  · Provider 异常、版本冲突、正常结束均释放占用；重新入锁发布候选前复核占用归属、事件、版本，
    以及锁外期间变化的档案身份（`CAPABILITY_CHANGED`）与规则指纹（`RULESET_CHANGED`）。

P3-A-R3 追加（in-flight 异常释放与容量预留，仍零真实模型）：
  · 第一段登记 in-flight 后，规则结算/身份源/规则指纹/Provider 输入构造任一抛异常，都经
    try/except 释放占用再透出；身份源短暂异常后同一事件可重新 Prepare，不永久占用。
  · 容量检查计入已占用的 in-flight 并预留本次请求（`len(_pending) + len(_inflight) + 1`），
    并发 Prepare 不会把 Pending 撑过 `MAX_PENDING`。

P2-B2a 追加（`communicate` / `inspect` 的服务端事实链，仍然无模型）：
  · **发言不等于事实**：`claim` 与一般声明/表态只落「带说话者、听者与 `asserted_by`
    的声明条目」，绝不改 `owner`、门、位置或客观 `world.facts`，也不自动提高好感/信任；
  · **询问与观察只用服务端作者化信息**：询问仅在听话人在场且被指向时，把他/她身上
    `disclosure=public` 的作者化线索记为**提问者可知**信息；`inspect` 只观察主体所在
    位置可见的对象/门（在酒馆看不到旧井的钥匙）。模型原话不能创造线索、知识或物品；
  · **知识按 actor 私有**：`interaction.knowledge` 由 Commit 写进权威 Actor State 桶
    （`(session_id, actor_id)`）；不进客观 `world.interaction.facts`，世界回合记录也只留
    类型/说话者/听者/可见范围，不留私有原话；
  · **真实回合**：通过硬前提的说话/观察即使不产生属性或新知识变化，也带服务端
    `interaction.turn_tick + 1` 这一真实回合变化；被阻止/跳过的动作不能借时钟取得可提交资格。

P2-B2a-R1 定向修复（A 关口审查后，仍无模型）：
  · **私有知识不外泄**：普通 `state()` 视图剔除各角色 `interaction.knowledge`；规则计算仍用
    锁内完整 `_snapshot()`，按 actor 的知识只经 `knowledge(session, actor)` 内部读取；
  · **持有物用有效位置**：物品被持有时其**有效位置**随持有人当前位置（`take/transfer` 只改
    `owner`），`inspect` 可见性、观察内容与 P2-A 实体目录位置投影共用同一 `effective_object_location`；
  · **披露主题与时效**：询问只按结构化 `object_id` 匹配线索（不做原话关键词匹配），无明确对象
    只披露 `disclosure=general_public` 的线索；披露前再按服务端**当前**归属/地点核对线索，
    钥匙离开旧井后不再作为**当前**线索披露，复制到提问者的条目带 `as_of_turn` 与 `objective=False`。

P2-B2b 追加（单一非致命对抗，`attack` / `kind=challenge`，仍无模型）：
  · 只在**一个**服务端定义的动作上做六档：推搡/角力。伤害性攻击（`kind=violence` 等）
    明确 `UNSUPPORTED_OPERATION`，**不悄悄转成角力**；本轮不写生命/伤害系统。
  · `attack` **不接受** `object_id`：带物品会改变动作语义（持械 vs 徒手），同样显式
    `UNSUPPORTED_OPERATION`，不静默按徒手结算。
  · 硬前提全用服务端状态：目标为不同且已初始化的 actor、同位置、均可行动，行动者
    `energy >= 2`。不满足即 `blocked`、`degree=null` 且**不扣资源**；目标未知/不唯一走
    `NEEDS_CLARIFICATION`（输入消歧，零扣费），已知但不在场才 `blocked`。
  · `margin = attack.strength - (target.defense + 固定阻力 3)` → 六档；贡献 trace 列明各项与
    规则版本，**不读**客户端/模型自报数值。所有已尝试档位扣 2 energy；目标
    `interaction.balance_pressure`（0–4）按档位递增（截顶，仅表示非致命失衡），
    critical failure 反噬行动者 +1 作为 complication。Opportunity 只建议下一轮，不自动执行。

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
    P1 `transfer` 与 P2-B1 `move/take/unlock` 均为确定性硬规则，六档 Resolver 留 P2-B2。

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
import laya_evidence as _evidence  # noqa: E402  （P3-A Evidence Provider 接线）

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

#: 本轮实现（可独立裁决、无需模型）的动作：
#: P1 `transfer` + P2-B1 `move/take/unlock` + P2-B2a `communicate/inspect`
#: + P2-B2b `attack`（仅 kind=challenge 的非致命角力）。
IMPLEMENTED_OPERATIONS = ("transfer", "move", "take", "unlock", "communicate",
                          "inspect", "attack")
#: 已声明但**本轮仍不实现**的动作。命中即硬短路为 `UNSUPPORTED_OPERATION`，
#: 不做「用有限难度惩罚代替拒绝」。（P2-B2b 后暂无剩余扩展点。）
P2_OPERATIONS = ()

# --------------------------------------------------------------------------
# P2-B2b 单一非致命对抗（`attack` / `kind=challenge`）的固定规则与数值口径
# --------------------------------------------------------------------------
#: 只有「角力/推搡」这种非致命对抗可进公式；`violence` 等其它攻击语义明确不支持。
ATTACK_KINDS = ("challenge",)
#: 固定场景阻力（服务端作者化，非客户端可注入）。
ATTACK_BASE_RESISTANCE = 3
#: 每次**已尝试**的对抗消耗行动者 2 点 energy（硬前提要求 ≥ 该值）。
ATTACK_ENERGY_COST = 2
#: 目标失衡上限；档位增量截顶，达到上限仍有真实消耗与回合事件。
BALANCE_PRESSURE_LIMIT = 4
#: 六档（由低到高）。只有 `attack` 会产生 `success` 以外的档位。
DEGREE_ORDER = ("critical_failure", "failure", "partial_success",
                "success", "strong_success", "exceptional_success")
#: 视为「成功达成」的档位（供条件动作 `if_achieved` 与聚合使用）。
DEGREE_SUCCESSFUL = ("success", "strong_success", "exceptional_success")
#: 目标 `balance_pressure` 增量（截顶到 `BALANCE_PRESSURE_LIMIT`）。
BALANCE_GAIN = {"partial_success": 1, "success": 2, "strong_success": 3,
                "exceptional_success": 4}

#: `communicate` 的语义子类（`kind` 白名单，闭集；`operation=communicate` 之外的 kind → 422）：
#:   · `question` 走「询问 → 服务端作者化公开线索」；
#:   · 其余（声明/表态/威胁/合作等）走「声明事件」——只落私有 knowledge，绝不改客观事实。
QUESTION_KINDS = ("question",)
STATEMENT_KINDS = ("claim", "statement", "reveal", "threat", "hostility",
                   "cooperate", "refuse", "apologize", "acknowledge", "neutral")
COMMUNICATE_KINDS = QUESTION_KINDS + STATEMENT_KINDS

#: `interaction.knowledge` 的条目类型（按 actor 私有；不存在第二套知识存储）。
KNOWLEDGE_KINDS = ("clue", "observation", "statement")
#: 单角色知识条目上限：超限时动作 blocked（`knowledge_capacity`），不静默丢弃旧条目。
KNOWLEDGE_LIMIT = 64

INTENT_FIELDS = {"id", "operation", "target_ids", "object_id", "mode",
                 "kind", "content", "evidence", "depends_on", "when"}
MODES = ("attempt", "negated", "hypothetical", "quoted")
#: P2 条件动作：只有带 `depends_on` 时 `if_achieved / if_not_achieved` 才有效，
#: 无依赖时统一归一为 `always`（与 P2-A 解释器口径一致）。
WHEN_VALUES = ("always", "if_achieved", "if_not_achieved")
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
# 知识条目（按 actor 私有；唯一存放位置 = 该 actor 的 interaction.knowledge）
# ==========================================================================
#: 服务端作者化线索模板：莉亚知道钥匙在旧井。`disclosure=public` 表示「本人在场
#: 且被**指向该对象**问到时可以告知提问者」。它既不是客观 `world.facts`，也不是玩家
#: 原文/模型产物。`about` 同时记下**声称当时**的对象/地点/归属，供披露前做时效核对；
#: `general_public=False` 表示它不是「无明确对象的一般问题」也能披露的公共线索。
CLUE_KEY_LOCATION = {
    "entry_id": "clue:cellar_key_location",
    "kind": "clue",
    "content": "地窖钥匙在旧井",
    "source": "authored",
    "disclosure": "public",
    "general_public": False,
    "asserted_by": None,
    "objective": True,
    "about": {"object": "cellar_key", "location": "old_well", "owner": None},
    "learned_turn": None,
}


def _knowledge_entries(state):
    """取（并保证存在）某实体 state 的 knowledge 列表。"""
    inter = state.setdefault("interaction", {})
    if not isinstance(inter.get("knowledge"), list):
        inter["knowledge"] = []
    return inter["knowledge"]


def _knowledge_upsert(entries, entry):
    """按 `entry_id` 去重写入，返回 `(新列表, status)`，status ∈ `added|updated|unchanged`。

    已存在且内容完全一致 → `unchanged`：动作仍算一次真实回合（时钟照走），但
    不制造虚假 delta 来伪装「又学到了新东西」。`learned_turn` 记的是**首次得知**的回合，
    重复询问 / 重复观察同一状态不会把它刷成新回合，也不会因此产生写项。
    """
    out = [dict(e) for e in entries]
    for i, e in enumerate(out):
        if e.get("entry_id") == entry.get("entry_id"):
            merged = dict(entry)
            # `learned_turn` / `as_of_turn` 记的是**首次得知**的回合，重复询问 / 重复观察
            # 同一状态不刷新它，也不因此产生写项（避免伪装「又学到了新东西」）。
            merged["learned_turn"] = e.get("learned_turn")
            if "as_of_turn" in e or "as_of_turn" in merged:
                merged["as_of_turn"] = e.get("as_of_turn")
            if e == merged:
                return entries, "unchanged"
            out[i] = merged
            return out, "updated"
    out.append(dict(entry))
    return out, "added"


def _knowledge_overflow(entries, entries_to_add):
    """写入后是否超出 `KNOWLEDGE_LIMIT`（只计真正新增的 `entry_id`）。"""
    have = {e.get("entry_id") for e in entries}
    extra = [e for e in entries_to_add if e.get("entry_id") not in have]
    return len(entries) + len(extra) > KNOWLEDGE_LIMIT


def effective_object_location(obj, states):
    """物品的**有效位置**：被角色持有时随持有人当前所在地，未持有时才看物品自身 `location`。

    B1 的 `take/transfer` 只改 `owner`，物品 `location` 是落地位置/模板值。可见性、观察内容
    与 P2-A 实体目录必须用这一**同一**推导，否则会出现「一处说在旧井、一处允许在酒馆检查」
    的自相矛盾。`states` 是服务端快照（含各实体 `interaction.location`）。
    """
    owner = obj.get("owner")
    if owner and owner != WORLD:
        holder = (states.get(owner) or {}).get("interaction") or {}
        loc = holder.get("location")
        if loc:
            return loc
    return obj.get("location")


def _clue_is_current(clue, states):
    """披露前按服务端**当前**事实核对线索是否仍成立（线索时效）。

    `about` 记录的是作者化/得知**当时**的对象、地点与归属；钥匙离开旧井后，该线索不再
    代表当前真相，不得继续作为**当前**线索披露。无对象锚点的线索不做时效核对。
    """
    about = clue.get("about") or {}
    obj_id = about.get("object")
    if not obj_id:
        return True
    world = (states.get(WORLD) or {}).get("interaction") or {}
    obj = (world.get("objects") or {}).get(obj_id)
    if obj is None:
        return False
    if "location" in about and effective_object_location(obj, states) != about.get("location"):
        return False
    if "owner" in about and obj.get("owner") != about.get("owner"):
        return False
    return True


def _clue_entry(clue, told_by, tick):
    """把作者化线索复制成「某角色的可知信息」，附上是从谁那里得知的。

    复制条目 `objective=False` 且带 `as_of_turn`：它记录的是**得知当时**的事态，
    不暗示永远是当前真相（钥匙可能已被带走）。`about` 保留当时快照，供后续核对。
    """
    return {
        "entry_id": clue["entry_id"], "kind": "clue", "content": clue["content"],
        "source": clue.get("source") or "authored", "told_by": told_by,
        "objective": False, "asserted_by": None,
        "about": _copy.deepcopy(clue.get("about") or {}),
        "as_of_turn": tick, "learned_turn": tick,
    }


def _observation_entry(subject, obj, tick, location=None):
    """观察条目：内容由**服务端字段**生成，不采用任何模型措辞。

    `location` 传物品**有效位置**（被持有时随持有人）；不传则退回物品自身落地位置。
    """
    effective = location if location is not None else obj.get("location")
    parts = []
    if effective:
        parts.append("位于 %s" % effective)
    if obj.get("kind") == "door":
        parts.append("门状态=%s" % ("已上锁" if obj.get("locked") else "未上锁"))
    parts.append("归属=%s" % (obj.get("owner") or "无人持有"))
    return {
        "entry_id": "obs:%s" % subject, "kind": "observation",
        "content": "%s：%s" % (obj.get("name") or subject, "；".join(parts)),
        "source": "rule", "subject": subject, "objective": True, "asserted_by": None,
        "about": {"object": subject, "kind": obj.get("kind"),
                  "location": effective, "owner": obj.get("owner"),
                  "locked": obj.get("locked"), "open": obj.get("open"),
                  "portable": obj.get("portable")},
        "learned_turn": tick,
    }


def _scene_observation_entry(location, states, observer, tick):
    """只用当前权威快照列出在场人物与可见物品，不生成环境设定。"""
    world = states[WORLD]["interaction"]
    people = sorted((states[eid].get("name") or eid) for eid in states
                    if eid not in (observer, WORLD)
                    and (states[eid].get("interaction") or {}).get("location") == location)
    objects = sorted((obj.get("name") or oid) for oid, obj in world["objects"].items()
                     if effective_object_location(obj, states) == location
                     and obj.get("owner") in (None, observer))
    return {
        "entry_id": "obs:scene:%s" % location, "kind": "observation",
        "content": "所在地点 %s；可见人物：%s；可见物品：%s" % (
            location, "、".join(people) or "无", "、".join(objects) or "无"),
        "source": "rule", "subject": location, "objective": True,
        "asserted_by": None,
        "about": {"location": location, "visible_actors": people,
                  "visible_objects": objects},
        "learned_turn": tick,
    }


def _statement_entry(event_id, action_id, speaker, content, tick):
    """声明条目：只存**发言者与实际听者**的私有 knowledge，明确 `asserted_by`，
    `objective=False` —— 声称不等于客观成立，也绝不进 `world.facts`。"""
    return {
        "entry_id": "stmt:%s:%s" % (event_id or "na", action_id),
        "kind": "statement", "content": content, "source": "assertion",
        "asserted_by": speaker, "objective": False, "about": None,
        "learned_turn": tick,
    }


def _public_entity_state(state):
    """普通场景视图下的实体快照：剔除私有 `interaction.knowledge`。

    其它字段（位置、关系、属性…）照常保留；知识只经 `knowledge(session, actor)` 读取。
    """
    row = _copy.deepcopy(state)
    inter = row.get("interaction")
    if isinstance(inter, dict):
        inter.pop("knowledge", None)
    return row


def _degree_for_margin(margin):
    """整数 margin → 六档（P2-B2b 固定边界）。"""
    if margin <= -5:
        return "critical_failure"
    if margin <= -2:
        return "failure"
    if margin <= 0:
        return "partial_success"
    if margin <= 3:
        return "success"
    if margin <= 5:
        return "strong_success"
    return "exceptional_success"


def _aggregate_attempted(attempted):
    """把一轮里**已尝试**动作的档位聚合成 (result, degree)。

    取**最低**档位：从最高档起步逐个下调，等价于对已尝试集合取 min。非对抗动作恒为
    `success`（最低档位也仍是 `success`），因此对 transfer/move/take/unlock/
    communicate/inspect 无行为改变；只有 `attack` 才会让一轮整体落到
    `partial_success` / `failed`，或让单动作轮保留 `strong_success` / `exceptional_success`。
    """
    worst = DEGREE_ORDER[-1]
    for r in attempted:
        deg = r.get("degree") or "success"
        if deg in DEGREE_ORDER and DEGREE_ORDER.index(deg) < DEGREE_ORDER.index(worst):
            worst = deg
    if worst in DEGREE_SUCCESSFUL:
        return "achieved", worst
    if worst == "partial_success":
        return "partial_success", "partial_success"
    return "failed", worst


# ==========================================================================
# 服务端场景模板（服务端作者化，绝不从玩家声明推断）
# ==========================================================================
def scene_templates(B):
    """返回该场景的实体模板。每次调用重新构造，避免共享可变状态。"""
    def actor(name, name_en, *, skill, trust=50, relationship_to=None, knowledge=None):
        st = B._blank_actor_state(B.CFG.get("actor"))
        st.update(name=name, name_en=name_en)
        st.setdefault("relationship", {}).update(trust=trust, doubt=30)
        st["interaction"] = {
            "location": "tavern",
            "stats": {"strength": skill, "perception": skill, "persuasion": skill,
                      "defense": 2, "resolve": 2},
            "energy": 10, "incapacitated": False, "restrained": False,
            # P2-B2b：非致命失衡计数（初始 0，上限 BALANCE_PRESSURE_LIMIT）。
            # 只表示被推搡后的重心不稳，**不代表**击倒、受伤或 NPC 自主行动。
            "balance_pressure": 0,
            "relationship_to": relationship_to,
            # 私有知识：只有 Commit 能写，按 (session_id, actor_id) 落在权威 Actor State
            # 桶里；不进客观 world.facts，也不进世界回合记录的私有原话字段。
            "knowledge": _copy.deepcopy(knowledge or []),
        }
        return st

    return {
        "player": actor("玩家", "Player", skill=5),
        "lia": actor("莉亚", "Lia", skill=6, trust=60, relationship_to="player",
                     knowledge=[CLUE_KEY_LOCATION]),
        WORLD: {
            "name": "铁壶酒馆运行场景",
            "interaction": {
                "scene_id": SCENE_ID,
                "location": "tavern",
                "turn_tick": 0,
                "facts": [],
                "turns": [],          # 正式历史：Commit 才追加
                # 服务端地点图：唯一移动权威。move 只能到「当前地点可达」的已知地点。
                "places": {
                    "tavern": {"reachable": ["old_well"]},
                    "old_well": {"reachable": ["tavern"]},
                },
                "objects": {
                    "badge": {"name": "徽章", "kind": "item", "location": "tavern",
                              "owner": "player", "portable": True},
                    "apple": {"name": "苹果", "kind": "item", "location": "tavern",
                              "owner": "player", "portable": True},
                    # P2-B1 拾取链：钥匙在旧井、无人持有；地窖门在酒馆、上锁。
                    "cellar_key": {"name": "地窖钥匙", "kind": "item",
                                   "location": "old_well", "owner": None,
                                   "portable": True, "opens": "cellar_door"},
                    "cellar_door": {"name": "地窖门", "kind": "door",
                                    "location": "tavern", "locked": True,
                                    "open": False, "portable": False,
                                    "opens_with": "cellar_key"},
                },
            },
        },
    }


class DeliveryCore:
    """P1 物品交付核心。所有写入口只有 `commit`；`prepare_structured` 零游戏写入。"""

    def __init__(self, B, protocol=None, now=None, evidence_provider=None,
                 capability_identity=None):
        self.B = B
        self.P = protocol if protocol is not None else B.PROTOCOL
        self.now = now or time.time
        self.templates = scene_templates(B)
        self._pending = {}      # analysis_id -> 候选（进程内，非正式历史）
        # P3-A-R2：in-flight 单飞占用表，键为 **(session_id, event_id)**（不是 actor 桶）。
        # 值 = {"input_sha256", "actor_id", "started_at"}。登记/复核/释放都在 P.lock 内。
        self._inflight = {}
        # P3-A：服务端内部 Evidence Provider（可注入）。默认 None = 纯规则，回执
        # 恒 `rules_only=true, laya_evidence=[]`。注入的固定 fixture 必须显式
        # `source=test_fixture`，见 laya_evidence.py。
        self._evidence_provider = evidence_provider
        # P3-A-R1：服务端档案/检查点身份源（可注入 callable，无参返回 dict）。
        # 这是「服务端取得的身份」，与 Provider 自报的字符串无关；Prepare 锁内读一次
        # 固化进候选，Commit 锁内重读比较，变化即失效候选。P3-A 用可变的固定身份源
        # 做反例；P3-B 接 load_capability_profile() 的 (profile_id, checkpoint)。
        self._capability_identity = capability_identity

    def _capability_identity_value(self):
        """读取当前服务端档案/检查点身份（深拷贝，避免调用方改动身份源返回的引用）。"""
        if callable(self._capability_identity):
            val = self._capability_identity()
        else:
            val = None
        return _copy.deepcopy(val) if val is not None else None

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
        """只读场景视图（含各实体版本）。不初始化场景、不写任何状态。

        **私有知识不外泄**：普通视图剔除各角色的 `interaction.knowledge`，按 actor 的
        知识只经 `knowledge(session, actor)` 内部读取（供受信调用），规则计算仍用锁内
        完整 `_snapshot()`。这样「按 actor 的 knowledge()」才有隔离意义。
        """
        sid = str(session_id or "default")
        if not sid or len(sid) > 64:
            raise _ProtoError(422, "INVALID_REQUEST", "session_id 不合法")
        with self.P.lock:
            snap = self._snapshot(sid)
            return {
                "protocol_version": PROTOCOL_VERSION,
                "session_id": sid,
                "versions": snap["versions"],
                "states": {e: _public_entity_state(st) for e, st in snap["states"].items()},
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
        seen_ids = set()
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
            if aid_ in seen_ids:
                raise _ProtoError(422, "INVALID_REQUEST", "%s.id 在本轮重复" % where)
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
            dep = it.get("depends_on")
            if dep is not None and (not isinstance(dep, str) or dep not in seen_ids):
                raise _ProtoError(422, "INVALID_REQUEST",
                                  "%s.depends_on 必须指向更早动作" % where)
            when = it.get("when", "always")
            if not isinstance(when, str) or when not in WHEN_VALUES:
                raise _ProtoError(422, "INVALID_REQUEST",
                                  "%s.when 只允许 %s" % (where, "/".join(WHEN_VALUES)))
            if dep is None and when != "always":
                raise _ProtoError(422, "INVALID_REQUEST",
                                  "%s.when 为条件值时必须提供 depends_on" % where)
            if op == "communicate":
                k = (it.get("kind") or "").strip()
                if k and k not in COMMUNICATE_KINDS:
                    raise _ProtoError(422, "INVALID_REQUEST",
                                      "%s.kind=%s 与 operation=communicate 不匹配（闭集）：%s"
                                      % (where, k, "、".join(COMMUNICATE_KINDS)))
            if op == "attack":
                # P2-B2b：只支持非致命角力 `kind=challenge`。其它攻击语义（violence 等）
                # **明确不支持**，硬短路而不是悄悄转成角力。
                k = (it.get("kind") or "").strip()
                if k not in ATTACK_KINDS:
                    raise _ProtoError(
                        409, "UNSUPPORTED_OPERATION",
                        "%s operation=attack 只支持非致命角力 kind=%s；kind=%s 明确不支持"
                        "（伤害性攻击属未实现范围，不悄悄转成角力）"
                        % (where, "/".join(ATTACK_KINDS), k or "(空)"),
                        {"supported_kinds": list(ATTACK_KINDS)})
                # P2-B2b-R1：`attack` 不接受任何 `object_id`。武器/伤害系统不在首版范围，而
                # 「带物品」会改变动作语义（持械 vs 徒手），因此**显式拒绝**，不静默结算成
                # 徒手角力。这与 kind 闭集同一处收口：其它已实现动作里无意义的 `object_id`
                # 仍按既有约定忽略，唯独这里不能忽略，因为忽略等于替玩家改写意图。
                if obj is not None:
                    raise _ProtoError(
                        409, "UNSUPPORTED_OPERATION",
                        "%s operation=attack 不接受 object_id=%s：武器/持械语义本轮未实现，"
                        "不把带物品的动作静默结算成徒手角力" % (where, obj),
                        {"unsupported_field": "object_id"})
            out.append({
                "id": aid_, "operation": op, "target_ids": [str(t) for t in targets],
                "object_id": obj, "mode": mode,
                "kind": it.get("kind") or "", "content": it.get("content") or "",
                "evidence": it.get("evidence") or "",
                "depends_on": dep, "when": when,
            })
            seen_ids.add(aid_)
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
    def _check_transfer(self, intent, actor_id, states, ctx):
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

    def _check_move(self, intent, actor_id, states, ctx):
        world = states[WORLD]["interaction"]
        src = states[actor_id]["interaction"]
        targets = intent.get("target_ids") or []
        reasons, evidence = [], []
        if len(targets) != 1:
            reasons.append("move_requires_exactly_one_location")
        else:
            dest = targets[0]
            places = world.get("places") or {}
            if dest not in places:
                reasons.append("location_unknown")
            elif src.get("location") not in places:
                reasons.append("current_location_unknown")
            elif dest == src.get("location"):
                reasons.append("already_at_location")
            elif dest not in places[src["location"]].get("reachable", []):
                reasons.append("location_unreachable")
            else:
                evidence.append("route:%s>%s" % (src["location"], dest))
        if src.get("incapacitated"):
            reasons.append("actor_incapacitated")
        if src.get("restrained"):
            reasons.append("actor_restrained")
        return {"allowed": not reasons, "reasons": reasons, "evidence": evidence}

    def _check_take(self, intent, actor_id, states, ctx):
        world = states[WORLD]["interaction"]
        src = states[actor_id]["interaction"]
        obj_id = intent.get("object_id")
        item = world["objects"].get(obj_id) if obj_id else None
        reasons, evidence = [], []
        if item is None or item.get("kind") != "item":
            reasons.append("object_unknown")
        else:
            if item.get("owner") is not None:
                reasons.append("item_not_available")
            if item.get("location") != src.get("location"):
                reasons.append("object_not_at_location")
            if item.get("portable") is not True:
                reasons.append("item_not_portable")
            if not reasons:
                evidence.append("available:%s@%s" % (obj_id, src.get("location")))
        if src.get("incapacitated"):
            reasons.append("actor_incapacitated")
        if src.get("restrained"):
            reasons.append("actor_restrained")
        return {"allowed": not reasons, "reasons": reasons, "evidence": evidence}

    def _check_unlock(self, intent, actor_id, states, ctx):
        world = states[WORLD]["interaction"]
        src = states[actor_id]["interaction"]
        door_id = intent.get("object_id")
        door = world["objects"].get(door_id) if door_id else None
        reasons, evidence = [], []
        if door is None or door.get("kind") != "door":
            reasons.append("object_unknown")
        else:
            if door.get("location") != src.get("location"):
                reasons.append("door_out_of_reach")
            if door.get("locked") is not True:
                reasons.append("door_not_locked")
            key_id = door.get("opens_with")
            key = world["objects"].get(key_id) if key_id else None
            if key is None or key.get("kind") != "item":
                reasons.append("key_mismatch")
            elif key.get("owner") != actor_id:
                reasons.append("key_not_owned")
            elif key.get("opens") != door_id:
                reasons.append("key_mismatch")
            if not reasons:
                evidence.append("key:%s opens:%s" % (key_id, door_id))
        if src.get("incapacitated"):
            reasons.append("actor_incapacitated")
        if src.get("restrained"):
            reasons.append("actor_restrained")
        return {"allowed": not reasons, "reasons": reasons, "evidence": evidence}

    # ------------------------------------------------------------------
    # P2-B2a：交流与检查的硬前提（只读服务端事实，绝不采信玩家声明）
    # ------------------------------------------------------------------
    def _check_communicate(self, intent, actor_id, states, ctx):
        """交流硬前提：必须有一个**在场**的听者；询问只释放服务端作者化的公开线索。

        「发言不等于事实」：声明/表态一律不改 `owner`、门、位置或客观 `facts`，也不因
        玩家原话创造线索或知识；规则里没有任何关键词匹配。
        缺听者 / 听者不唯一 → `target_unresolved`（澄清，不暗选）；听者不在同一地点 →
        `listener_out_of_reach`（阻止，不产生任何写项，也不给答复）。
        """
        src = states[actor_id]["interaction"]
        targets = intent.get("target_ids") or []
        kind = (intent.get("kind") or "").strip() or "neutral"
        content = (intent.get("content") or intent.get("evidence") or "").strip()
        sub = "question" if kind in QUESTION_KINDS else "statement"
        reasons, evidence, clues, planned = [], [], [], []
        listener = None
        if not targets:
            # 自然发言可指向唯一在场听者；零人或多人时仍需玩家澄清。
            present = [eid for eid, state in states.items()
                       if eid not in (actor_id, WORLD)
                       and (state.get("interaction") or {}).get("location") == src.get("location")]
            if len(present) == 1:
                listener = present[0]
            else:
                reasons.append("target_unresolved")
        elif len(targets) == 1:
            listener = targets[0]
        else:
            reasons.append("target_unresolved")
        if listener is not None:
            if listener == actor_id:
                reasons.append("target_is_self")
            elif listener not in states or listener == WORLD:
                reasons.append("target_unresolved")
            else:
                lst = states[listener]["interaction"]
                if lst.get("location") != src.get("location"):
                    reasons.append("listener_out_of_reach")
                if lst.get("incapacitated"):
                    reasons.append("listener_unavailable")
        if sub == "statement" and not content:
            reasons.append("statement_content_missing")
        if src.get("incapacitated"):
            reasons.append("actor_incapacitated")
        if src.get("restrained"):
            reasons.append("actor_restrained")
        if not reasons:
            if sub == "question":
                # 服务端作者化规则：听者在场且被**指向对象**问到时，其 `disclosure=public`
                # 且对象匹配、且**当前仍成立**的线索成为**提问者**可知信息。
                #   · 按结构化 `object_id` 匹配（问钥匙才给钥匙线索），不做原话关键词匹配；
                #   · 无明确对象的一般问题只披露 `general_public=True` 的线索（钥匙线索不属此类）；
                #   · 披露前按服务端当前归属/地点核对（`_clue_is_current`），过期线索不再披露。
                asked = intent.get("object_id")
                clues = [e for e in (states[listener]["interaction"].get("knowledge") or [])
                         if e.get("kind") == "clue" and e.get("disclosure") == "public"
                         and ((asked and (e.get("about") or {}).get("object") == asked)
                              or (not asked and e.get("general_public")))
                         and _clue_is_current(e, states)]
                clues = [_copy.deepcopy(c) for c in clues]
                planned = [{"actor_id": actor_id,
                            "entry": _clue_entry(c, listener, ctx["tick"])} for c in clues]
            else:
                entry = _statement_entry(ctx["event_id"], intent["id"], actor_id,
                                         content, ctx["tick"])
                planned = [{"actor_id": actor_id, "entry": entry}]
                if listener and listener != actor_id:
                    planned.append({"actor_id": listener, "entry": entry})
            for row in planned:
                if _knowledge_overflow(_knowledge_entries(states[row["actor_id"]]),
                                       [row["entry"]]):
                    reasons.append("knowledge_capacity")
                    break
            if reasons:
                clues, planned = [], []
            else:
                evidence.append("listener:%s" % listener)
        return {"allowed": not reasons, "reasons": reasons, "evidence": evidence,
                "sub_kind": sub, "kind": kind, "listener": listener, "content": content,
                "clues": clues, "planned": planned}

    def _check_inspect(self, intent, actor_id, states, ctx):
        """检查硬前提：观察当前位置，或当前位置可见的对象/门。

        可见性用物品**有效位置**（被持有时随持有人当前位置）判定，不能只比物品自身静态
        `location`：玩家从旧井拿走钥匙返回酒馆后，钥匙随其在酒馆可见；留在旧井的人看不到
        已被带走的钥匙。观察只写观察者自己的 knowledge；主体无法唯一确定 → 澄清。
        """
        world = states[WORLD]["interaction"]
        src = states[actor_id]["interaction"]
        targets = intent.get("target_ids") or []
        subject = intent.get("object_id")
        reasons, evidence, planned = [], [], []
        if not subject and len(targets) == 1:
            subject = targets[0]
        if not subject:
            subject = src.get("location")  # 无具体对象的「观察周围」指向当前场景
        entry = None
        if subject == actor_id or subject == WORLD:
            reasons.append("inspect_subject_not_observable")
        elif subject in world["places"]:
            if subject != src.get("location"):
                reasons.append("object_out_of_sight")
            else:
                entry = _scene_observation_entry(subject, states, actor_id, ctx["tick"])
        else:
            obj = world["objects"].get(subject)
            if obj is None:
                if subject in states:
                    # 本轮只观察对象/门；观察人物不在 P2-B2a 范围，明确拒绝而非假装成功
                    reasons.append("inspect_subject_not_observable")
                else:
                    reasons.append("object_unknown")
            else:
                effective = effective_object_location(obj, states)
                if effective != src.get("location"):
                    reasons.append("object_out_of_sight")
                else:
                    entry = _observation_entry(subject, obj, ctx["tick"], effective)
        if entry is not None:
            if _knowledge_overflow(_knowledge_entries(states[actor_id]), [entry]):
                reasons.append("knowledge_capacity")
            else:
                evidence.append("visible:%s@%s" % (subject, src.get("location")))
                planned = [{"actor_id": actor_id, "entry": entry}]
        if src.get("incapacitated"):
            reasons.append("actor_incapacitated")
        if src.get("restrained"):
            reasons.append("actor_restrained")
        if reasons:
            planned = []
        return {"allowed": not reasons, "reasons": reasons, "evidence": evidence,
                "subject": subject, "planned": planned}

    # ------------------------------------------------------------------
    # P2-B2b：单一非致命对抗的硬前提与贡献拆解（只读服务端事实）
    # ------------------------------------------------------------------
    def _check_attack(self, intent, actor_id, states, ctx):
        """`attack` / `kind=challenge`（推搡/角力）的硬前提与贡献拆解。

        硬前提全部来自服务端状态：行动者与目标是**不同且已初始化**的 actor、同位置、
        均可行动（未 incapacitated/restrained）；行动者 `energy >= 2`。任一不满足即
        `blocked`，`degree=null` 且**不扣资源**。通过后按固定规则算 contribution：

            potency    = actor.interaction.stats.strength
            difficulty = target.interaction.stats.defense + 固定场景阻力(3)
            margin     = potency - difficulty            → 六档

        难度、margin 与档位**只**由服务端属性与版本化常量产生，绝不读客户端/模型自报数值。
        """
        src = states[actor_id]["interaction"]
        targets = intent.get("target_ids") or []
        reasons, evidence = [], []
        target, contribution = None, None
        if len(targets) != 1:
            reasons.append("target_unresolved")
        else:
            tid = targets[0]
            if tid == actor_id:
                reasons.append("target_is_self")
            elif tid not in states or tid == WORLD:
                reasons.append("target_unresolved")
            else:
                target = tid
                tgt = states[tid]["interaction"]
                if tgt.get("location") != src.get("location"):
                    reasons.append("target_out_of_reach")
                if tgt.get("incapacitated"):
                    reasons.append("target_incapacitated")
                if tgt.get("restrained"):
                    reasons.append("target_restrained")
        if src.get("incapacitated"):
            reasons.append("actor_incapacitated")
        if src.get("restrained"):
            reasons.append("actor_restrained")
        energy = int(src.get("energy") or 0)
        if energy < ATTACK_ENERGY_COST:
            reasons.append("insufficient_energy")
        if not reasons:
            strength = int((src.get("stats") or {}).get("strength") or 0)
            defense = int((states[target]["interaction"].get("stats") or {}).get("defense") or 0)
            difficulty = defense + ATTACK_BASE_RESISTANCE
            margin = strength - difficulty
            contribution = {
                "formula": "margin = strength - (defense + base_resistance)",
                "potency_strength": strength,
                "target_defense": defense,
                "base_resistance": ATTACK_BASE_RESISTANCE,
                "difficulty": difficulty,
                "margin": margin,
                "degree": _degree_for_margin(margin),
                "energy_cost": ATTACK_ENERGY_COST,
                "rule_version": RULESET_ID,
            }
            evidence.append("contest:%s>%s margin=%d" % (actor_id, target, margin))
        return {"allowed": not reasons, "reasons": reasons, "evidence": evidence,
                "target": target, "contribution": contribution}

    # ------------------------------------------------------------------
    # 逐动作结算（在副本上顺序模拟；只有 P2-B2b 的 attack 产生 margin/六档）
    # ------------------------------------------------------------------
    def _resolve_one(self, intent, actor_id, states, ctx):
        op = intent["operation"]
        target_id = (intent["target_ids"] or [None])[0]
        if intent["mode"] != "attempt":
            return {
                "action_id": intent["id"], "operation": op, "target_id": target_id,
                "execution_status": "skipped", "degree": None,
                "achieved": "非真实物理尝试（%s），不计为行动失败" % intent["mode"],
                "check": {"allowed": False, "reasons": ["not_an_attempt"], "evidence": []},
                "changes": [], "facts": [], "costs": [], "complications": [],
                "opportunities": [], "evidence": intent["evidence"],
                "record": None, "knowledge_gained": [],
            }
        check = {"transfer": self._check_transfer, "move": self._check_move,
                 "take": self._check_take, "unlock": self._check_unlock,
                 "communicate": self._check_communicate,
                 "inspect": self._check_inspect,
                 "attack": self._check_attack}[op](intent, actor_id, states, ctx)
        if not check["allowed"]:
            return {
                "action_id": intent["id"], "operation": op, "target_id": target_id,
                "execution_status": "blocked", "degree": None,
                "achieved": "未执行：" + "、".join(check["reasons"]),
                "check": check, "changes": [], "facts": [], "costs": [],
                "complications": [],
                "opportunities": ["先满足动作前提，再重新尝试。"],
                "evidence": intent["evidence"],
                "record": None, "knowledge_gained": [],
            }
        changes, facts = [], []
        gained, record = [], None
        degree = "success"
        costs, complications, opportunities = [], [], []
        world = states[WORLD]["interaction"]
        if op == "transfer":
            before = world["objects"][intent["object_id"]]["owner"]
            changes.append({"entity_id": WORLD,
                            "path": "interaction.objects.%s.owner" % intent["object_id"],
                            "before": before, "after": target_id, "source": "rule:" + intent["id"]})
            facts.append({"kind": "ownership", "object": intent["object_id"], "owner": target_id})
            achieved = "%s 由 %s 交给 %s" % (intent["object_id"], actor_id, target_id)
        elif op == "move":
            before = states[actor_id]["interaction"]["location"]
            after = target_id
            changes.append({"entity_id": actor_id, "path": "interaction.location",
                            "before": before, "after": after, "source": "rule:" + intent["id"]})
            facts.append({"kind": "location", "actor": actor_id, "location": after})
            achieved = "%s 移动到 %s" % (actor_id, after)
        elif op == "take":
            obj_id = intent["object_id"]
            before = world["objects"][obj_id]["owner"]
            changes.append({"entity_id": WORLD,
                            "path": "interaction.objects.%s.owner" % obj_id,
                            "before": before, "after": actor_id, "source": "rule:" + intent["id"]})
            facts.append({"kind": "ownership", "object": obj_id, "owner": actor_id})
            achieved = "%s 拾取了 %s" % (actor_id, obj_id)
        elif op == "inspect":
            subject = check["subject"]
            gained = self._apply_knowledge(changes, states, check["planned"])
            record = {"type": "inspect", "observer": actor_id, "subject": subject,
                      "visibility": "self"}
            achieved = ("%s 观察到 %s（新信息 %d 条）" % (actor_id, subject, len(gained))
                        if gained else "%s 观察了 %s（内容已知，无新增信息）" % (actor_id, subject))
        elif op == "communicate":
            listener = check["listener"]
            target_id = listener
            gained = self._apply_knowledge(changes, states, check["planned"])
            record = {"type": "communicate", "sub_kind": check["sub_kind"],
                      "kind": check["kind"], "speaker": actor_id, "listener": listener,
                      "visibility": "participants"}
            # 注意：`achieved` 里不放声明原话 —— 私有内容只走 knowledge 与权威回执，
            # 不进入世界回合记录（见 commit 的 `acts`）。
            achieved = ("%s 向 %s 询问（新信息 %d 条）" % (actor_id, listener, len(gained))
                        if check["sub_kind"] == "question"
                        else "%s 对 %s 作出声明（只记声明事件，不改客观事实与归属）"
                             % (actor_id, listener))
        elif op == "attack":
            tid = check["target"]
            c = check["contribution"]
            degree = c["degree"]
            atk, tgt = states[actor_id]["interaction"], states[tid]["interaction"]
            # ① 真实资源消耗：所有**已尝试**档位都扣 2 energy（含失败与严重失败）
            e_before = int(atk.get("energy") or 0)
            changes.append({"entity_id": actor_id, "path": "interaction.energy",
                            "before": e_before, "after": e_before - ATTACK_ENERGY_COST,
                            "source": "rule:" + intent["id"]})
            costs.append({"kind": "energy", "actor": actor_id,
                          "amount": ATTACK_ENERGY_COST})
            # ② 目标失衡（截顶到上限）：partial/success/strong/exceptional 递增，failure 不动
            tgt_before = int(tgt.get("balance_pressure") or 0)
            tgt_after = min(BALANCE_PRESSURE_LIMIT,
                            tgt_before + BALANCE_GAIN.get(degree, 0))
            if tgt_after != tgt_before:
                changes.append({"entity_id": tid, "path": "interaction.balance_pressure",
                                "before": tgt_before, "after": tgt_after,
                                "source": "rule:" + intent["id"]})
            # ③ critical failure 作为实际 complication：行动者自身失衡 +1
            if degree == "critical_failure":
                own_before = int(atk.get("balance_pressure") or 0)
                own_after = min(BALANCE_PRESSURE_LIMIT, own_before + 1)
                if own_after != own_before:
                    changes.append({"entity_id": actor_id,
                                    "path": "interaction.balance_pressure",
                                    "before": own_before, "after": own_after,
                                    "source": "rule:" + intent["id"]})
                complications.append({"kind": "self_off_balance", "actor": actor_id,
                                      "amount": own_after - own_before})
            facts.append({"kind": "contest", "actor": actor_id, "target": tid,
                          "margin": c["margin"], "degree": degree,
                          "target_balance_pressure": tgt_after,
                          "energy_spent": ATTACK_ENERGY_COST})
            # Opportunity 只是「下一轮可尝试的方向」，不自动执行。
            if degree in DEGREE_SUCCESSFUL or degree == "partial_success":
                opportunities.append({"kind": "follow_up",
                                      "suggested": "attack:challenge",
                                      "note": "目标失衡，下一轮可继续施压"})
            record = {"type": "attack", "kind": "challenge", "actor": actor_id,
                      "target": tid, "degree": degree, "visibility": "participants"}
            achieved = ("%s 对 %s 角力：margin=%d（strength %d −(defense %d + 阻力 %d)），"
                        "档位 %s；目标失衡 %d，energy −%d"
                        % (actor_id, tid, c["margin"], c["potency_strength"],
                           c["target_defense"], c["base_resistance"], degree,
                           tgt_after, ATTACK_ENERGY_COST))
        else:  # unlock
            obj_id = intent["object_id"]
            door = world["objects"][obj_id]
            for key, value in (("locked", False), ("open", True)):
                changes.append({"entity_id": WORLD,
                                "path": "interaction.objects.%s.%s" % (obj_id, key),
                                "before": door.get(key), "after": value,
                                "source": "rule:" + intent["id"]})
            facts.append({"kind": "door", "object": obj_id, "locked": False, "open": True})
            achieved = "%s 解锁并打开了 %s" % (actor_id, obj_id)
        return {
            "action_id": intent["id"], "operation": op, "target_id": target_id,
            "execution_status": "attempted", "degree": degree, "achieved": achieved,
            "check": check, "changes": changes, "facts": facts, "costs": costs,
            "complications": complications,
            "opportunities": opportunities,
            "evidence": intent["evidence"],
            "record": record, "knowledge_gained": gained,
        }

    def _apply_knowledge(self, changes, states, planned):
        """把 planned 条目按 actor 写进 `interaction.knowledge` 并登记 `state_changes`。

        `before` 取**当前工作副本**的值（同一回合的多个动作可前后链式）；内容完全一致
        （重复询问已知线索 / 重复观察同一状态）不登记改动，由服务端回合变化承担
        「这是一次真实回合」。
        """
        gained = []
        for row in planned:
            who = row["actor_id"]
            entries = _knowledge_entries(states[who])
            new_entries, status = _knowledge_upsert(entries, row["entry"])
            if status == "unchanged":
                continue
            changes.append({"entity_id": who, "path": "interaction.knowledge",
                            "before": _copy.deepcopy(entries),
                            "after": _copy.deepcopy(new_entries),
                            "source": "knowledge:" + row["entry"]["entry_id"]})
            gained.append({"actor_id": who, "entry": _copy.deepcopy(row["entry"]),
                           "status": status})
        return gained

    def _calculate(self, actor_id, intents, states, event_id=None,
                   evidence_entries=None, evidence_absent=None):
        """在副本上顺序结算，返回 (outcome, proposal, clarifications)。

        `event_id` 只用于声明条目的稳定 `entry_id`（`stmt:<event>:<action>`）；Prepare 与
        Commit 必须传同一个值，否则锁内重算会与预览不一致。

        P3-A：`evidence_entries`（可选）为**已固化的 Evidence 条目**（Prepare 锁外调 Provider
        一次得到、存进候选）。非空时用 `entries_to_changes` 基于当前快照重算可写关系写项
        （**不二次调用 Provider**），与规则写项一起原子发布。None 时为纯规则结果。

        P3-C：`evidence_absent`（可选）为【Evidence 缺席原因】；无 Laya 状态写项时写进
        `outcome["evidence_absent_reason"]`，供回执区分「未调 Laya / 译文缺失 / 引擎
        fallback / 档案不可用 / 无 active 可写」。active Evidence 被死区归零时 Evidence
        仍存在，故此字段为 None；具体原因由信号的 transition.deadzone 表示。
        """
        work = _copy.deepcopy(states)
        ctx = {"event_id": event_id,
               "tick": int((states[WORLD]["interaction"].get("turn_tick") or 0)) + 1}
        resolutions, changes, facts, clarifications = [], [], [], []
        by_id = {}
        for intent in intents:
            dep = intent.get("depends_on")
            prior = by_id.get(dep) if dep else None
            when = intent.get("when", "always")
            prior_achieved = bool(prior
                                  and prior["execution_status"] == "attempted"
                                  and prior.get("degree") in DEGREE_SUCCESSFUL)
            should_run = (not dep or (when == "always")
                          or (when == "if_achieved" and prior_achieved)
                          or (when == "if_not_achieved" and not prior_achieved))
            if not should_run:
                r = {"action_id": intent["id"], "operation": intent["operation"],
                     "target_id": (intent["target_ids"] or [None])[0],
                     "execution_status": "skipped", "degree": None,
                     "achieved": "依赖条件不成立，未执行",
                     "check": {"allowed": False, "reasons": ["dependency_condition_not_met"],
                               "evidence": []},
                     "changes": [], "facts": [], "costs": [], "complications": [],
                     "opportunities": [], "evidence": intent["evidence"],
                     "record": None, "knowledge_gained": []}
            else:
                r = self._resolve_one(intent, actor_id, work, ctx)
            by_id[intent["id"]] = r
            if r["execution_status"] == "blocked":
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
        attempted = [r for r in resolutions if r["execution_status"] == "attempted"]
        blocked = [r for r in resolutions if r["execution_status"] == "blocked"]
        # 真实回合：只要有动作通过硬前提被**真实执行**（含说话/观察这类不产生属性变化、
        # 也可能不产生新知识的尝试），就必须带服务端回合变化。被阻止 / 跳过 / 非尝试的
        # 动作在这里不产生任何写项，因此不能借时钟取得可提交资格。
        if attempted:
            tick = work[WORLD]["interaction"]["turn_tick"]
            changes.append({"entity_id": WORLD, "path": "interaction.turn_tick",
                            "before": tick, "after": tick + 1, "source": "turn_clock"})
            if facts:
                old_facts = states[WORLD]["interaction"]["facts"]
                changes.append({"entity_id": WORLD, "path": "interaction.facts",
                                "before": _copy.deepcopy(old_facts),
                                "after": _copy.deepcopy(work[WORLD]["interaction"]["facts"]),
                                "source": "canonical_facts"})
        if not attempted:
            result, degree = ("blocked", None) if blocked else ("no_attempt", None)
        elif blocked:
            # ★ ZCode-R1（F1）：attempted 与 blocked 并存才是「部分成功」。skipped
            # （否定/假设/引用/依赖未满足）既不是尝试也不是失败，不参与聚合、不拉低整轮
            # —— 旧口径 `len(attempted) == len(resolutions)` 把 skipped 也计进去，
            # 「交付成功 + 一句 negated 声明」会被错误记成 partial_success。
            result, degree = "partial_success", "partial_success"
        else:
            # 全部为已尝试（无 blocked）：档位只取已尝试集合的最低者（只有 attack 会变）。
            result, degree = _aggregate_attempted(attempted)

        # P3-A：Evidence（规则结果确定后，用同一副本 work 上的最终状态重算可写关系写项）。
        if evidence_entries:
            evidence_changes = _evidence.entries_to_changes(
                self, work, actor_id, evidence_entries)
        else:
            evidence_changes = []
        for ch in evidence_changes:
            self.B._set_path(work[ch["entity_id"]], ch["path"], ch["after"])
            changes.append(ch)
        rules_only = not bool(evidence_changes)
        outcome = {
            "event_id": None, "status": "resolved", "result": result, "degree": degree,
            "resolutions": resolutions, "facts_created": facts,
            "state_changes": changes, "rules_only": rules_only,
            "laya_evidence": evidence_entries or [],
            # P3-C：仅在 rules_only 时给缺席原因；有真实写项时恒 None（不误导为「有 Evidence 却缺席」）。
            "evidence_absent_reason": (evidence_absent if rules_only else None),
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
            # ZCode-R1a：过期候选被回收 → 会话级登记成对释放（owner 校验防误清）。
            self._release_claim(aid)
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
            "source": SOURCE,
            "rules_only": c["outcome"].get("rules_only", True),
            "laya_evidence": _copy.deepcopy(c["outcome"].get("laya_evidence") or []),
            "evidence_absent_reason": c["outcome"].get("evidence_absent_reason"),
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
        inflight_key = (sid, event_id)  # 事件身份键，**不是** actor 桶

        # ── 第一段（锁内）：快照 + 事件占用 + in-flight 单飞登记 + 规则结算 + 身份固化。──
        # 只做确定性、无 IO 的操作；**不在锁内调用耗时 Provider**（P3-A-R1 锁边界）。
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
                # ZCode-R1a：被取代候选转终态 → 其会话级登记按 owner 成对释放。
                self._release_claim(old["analysis_id"])
            # ★ P3-A-R2/R3：in-flight 单飞——先做并发冲突检查（同事件，键=(session_id,event_id)）。
            existing = self._inflight.get(inflight_key)
            if existing is not None:
                if existing["input_sha256"] != input_sha:
                    raise _ProtoError(409, "EVENT_PAYLOAD_CONFLICT",
                                      "同一 (session_id,event_id) 已由另一 actor 或另一组动作占用",
                                      {"existing_actor_id": existing.get("actor_id")})
                raise _ProtoError(409, "PREPARE_IN_PROGRESS",
                                  "同一 (session_id,event_id) 正在 Prepare，请稍后复用结果")
            # ★ ZCode-R1a：会话级登记覆盖 in-flight 与 Ready/Pending 全生命周期。
            #   protocol 侧登记先经 event_claim 惰性校验（终态/过期/基准失效自动剪除）；
            #   delivery 侧登记按自身 Pending 校验（status=ready 且未过期才算存活）。
            #   存活登记一律 409（同路径幂等复用/同 sha 换版本重做已在上方分支先行处理，
            #   同 sha 同版本的 in-flight 单飞也已在上方以 PREPARE_IN_PROGRESS 拒绝）。
            claim = self.P.event_claim(sid, event_id)
            if claim is not None and claim.get("path") == "delivery":
                cand = self._pending.get(claim.get("owner"))
                if not cand or cand.get("status") != "ready" \
                        or self.now() >= (cand.get("expires_at") or 0):
                    self.P._event_busy.pop(inflight_key, None)
                    claim = None
            if claim is not None:
                raise _ProtoError(
                    409, "EVENT_PAYLOAD_CONFLICT",
                    "同一 (session_id,event_id) 已存在未决候选/占用（%s@%s）"
                    % (claim.get("path"), (claim.get("scope") or (None, None))[1]),
                    {"occupied_by": claim.get("path"),
                     "existing_actor_id": (claim.get("scope") or (None, None))[1]})
            # ★ P3-A-R3：容量检查计入已占用的 in-flight，并预留本次请求（+1）。
            #   否则并发 Prepare 会把 Pending 撑过 MAX_PENDING（A 复现 199→201）。
            if len(self._pending) + len(self._inflight) + 1 > MAX_PENDING:
                self._cleanup()
            if len(self._pending) + len(self._inflight) + 1 > MAX_PENDING:
                raise _ProtoError(429, "PENDING_CAPACITY",
                                  "候选与进行中 Prepare 已达上限（%d），请等待过期" % MAX_PENDING)
            # 原子登记 in-flight 占用。
            self._inflight[inflight_key] = {"input_sha256": input_sha,
                                            "actor_id": aid, "started_at": self.now()}
            # ZCode-R1（P-F1）：会话级占用登记（协议实例持有，交付与旧协议共用可见）；
            # 释放与上方 _inflight 同点成对进行。
            # ZCode-R1b：固化 base_versions —— 协议层 event_claim 据此惰性识别
            # 「基准已失效但 Pending 仍标 ready」的交付候选并释放登记（R1b 修复2）。
            self.P._event_busy[inflight_key] = {
                "path": "delivery", "owner": "%s@%s" % (input_sha[:12], self.now()),
                "scope": (sid, aid), "sha": input_sha,
                "base_versions": dict(expected), "since": self.now()}
            try:
                # 规则结算（锁内，纯规则、无 Provider），只为拿到 resolutions 构造 Provider 输入。
                outcome_rules, _proposal_rules, clarifications = self._calculate(
                    aid, intents, snap["states"], event_id)
                if clarifications:
                    raise _ProtoError(409, "NEEDS_CLARIFICATION",
                                      "必需对象或目标无法确定，请澄清（不暗选）",
                                      {"clarifications": sorted(set(clarifications))})
                # 服务端档案/检查点身份与规则指纹：锁内读一次，供第三段复核。
                capability_identity = self._capability_identity_value()
                rules_fp_pre = self.rules_fingerprint()
                provider_input = _evidence.make_provider_input(
                    snap["states"], aid, outcome_rules["resolutions"], event_id,
                    session_id=sid)
                analysis_id = uuid.uuid4().hex
            except Exception:
                # 第一段登记后任何异常（规则/身份源/规则指纹/输入构造）都释放占用，不残留。
                self._inflight.pop(inflight_key, None)
                self.P._event_busy.pop(inflight_key, None)
                raise

        # ── 第二段（锁外）：耗时 Provider 调用。不持全局锁、不写任何状态。──
        # P3-C：Evidence 缺席原因。区分「未接入 Laya」「无可评估动作」「译文缺失」等阶段；
        # Provider 可返回 list（无诊断）或 {"evidence": [...], "absent_reason": ...}（带诊断）。
        evidence_entries = []
        evidence_absent = None
        if self._evidence_provider is None:
            evidence_absent = _evidence.ABSENT_LAYA_NOT_INVOKED
        elif provider_input is None:
            evidence_absent = _evidence.ABSENT_NO_EVALUABLE_ACTION
        try:
            if self._evidence_provider is not None and provider_input is not None:
                raw = self._evidence_provider(provider_input)
                if isinstance(raw, dict):
                    evidence_absent = raw.get("absent_reason")
                    raw = raw.get("evidence") or []
                evidence_entries = _evidence.normalize_evidence(raw, provider_input)
        except Exception as exc:
            # Provider 异常 → 释放 in-flight 占用（允许后续重新 Prepare），并明确报错。
            with P.lock:
                self._inflight.pop(inflight_key, None)
                self.P._event_busy.pop(inflight_key, None)
            raise _ProtoError(500, "INTERNAL_ERROR",
                              "Evidence Provider 失败，已释放事件占用：%s" % type(exc).__name__)

        # ── 第三段（重新锁内）：复核占用归属/事件/版本/档案身份/规则指纹，用 evidence_entries 重算并存候选。──
        published = False   # ZCode-R1a：成功发布候选后会话级登记保留到终态，不随 finally 释放。
        with P.lock:
            try:
                # 复核占用归属：仍应是自己持有、载荷一致（单飞保证，防御性再确认）。
                occ = self._inflight.get(inflight_key)
                if occ is None or occ["input_sha256"] != input_sha:
                    raise _ProtoError(409, "EVENT_PAYLOAD_CONFLICT",
                                      "Prepare 期间该 event 占用已被改写，拒绝发布")
                snap2 = self._snapshot(sid)
                if snap2["versions"] != expected:
                    raise _ProtoError(409, "STATE_VERSION_CONFLICT",
                                      "Prepare 期间状态已变化，请重新读取场景再 Prepare",
                                      {"current_versions": snap2["versions"]})
                _rec_aid2, rec2 = self._find_event(sid, event_id)
                if rec2 and rec2.get("status") == "committed":
                    raise _ProtoError(409, "EVENT_ALREADY_COMMITTED",
                                      "Prepare 期间该 event 已被提交，禁止重复写")
                # 锁外期间档案/检查点身份与规则指纹是否变化
                if self._capability_identity_value() != capability_identity:
                    raise _ProtoError(409, "CAPABILITY_CHANGED",
                                      "Prepare 期间服务端档案/检查点身份已变化，请重新 Prepare")
                if self.rules_fingerprint() != rules_fp_pre:
                    raise _ProtoError(409, "RULESET_CHANGED",
                                      "Prepare 期间规则指纹已变化，请重新 Prepare")
                outcome, proposal, clarifications = self._calculate(
                    aid, intents, snap2["states"], event_id,
                    evidence_entries=_copy.deepcopy(evidence_entries),
                    evidence_absent=evidence_absent)
                if clarifications:
                    raise _ProtoError(409, "NEEDS_CLARIFICATION",
                                      "必需对象或目标无法确定，请澄清（不暗选）",
                                      {"clarifications": sorted(set(clarifications))})
                outcome["event_id"] = event_id
                proposal["base_versions"] = dict(expected)
                self._pending[analysis_id] = {
                    "analysis_id": analysis_id,
                    "session_id": sid, "actor_id": aid, "event_id": event_id,
                    "base_versions": dict(expected), "input_sha256": input_sha,
                    "intents": _copy.deepcopy(intents),
                    "snapshot": _copy.deepcopy(snap2["states"]),
                    "outcome": outcome, "proposal": proposal,
                    # P3-A：固化 Evidence 条目，供 Commit 锁内重算（不二次调 Provider）。
                    "evidence_entries": _copy.deepcopy(evidence_entries),
                    # P3-C：固化 Evidence 缺席原因，供 Commit 锁内重算出一致的 outcome。
                    "evidence_absent": evidence_absent,
                    # P3-A-R1：固化服务端档案/检查点身份，供 Commit 锁内重验。
                    "capability_identity": _copy.deepcopy(capability_identity),
                    "rules_fingerprint": rules_fp_pre,
                    "source": SOURCE,
                    "status": "ready" if proposal["changes"] else "blocked",
                    "created_at": self.now(), "expires_at": self.now() + READY_TTL_S,
                    "terminal_at": None, "receipt": None,
                }
                # ★ ZCode-R1a：候选发布后会话级登记**保留**到终态（owner 换绑为
                #   analysis_id，供守卫惰性校验与终态成对释放）；blocked 候选不可提交，
                #   不持登记（跨路径可立即为该 event 另建候选）。
                claim = self.P._event_busy.get(inflight_key)
                if claim is not None and claim.get("path") == "delivery":
                    if self._pending[analysis_id]["status"] == "ready":
                        claim["owner"] = analysis_id
                        claim["expires_at"] = self._pending[analysis_id]["expires_at"]
                    else:
                        self.P._event_busy.pop(inflight_key, None)
                published = True
                return self._preview(self._pending[analysis_id])
            finally:
                # 异常/冲突出口释放 in-flight 与登记；成功发布（Ready）则保留登记
                # 由终态（提交/失效/过期/被取代）释放。
                self._inflight.pop(inflight_key, None)
                if not published:
                    self.P._event_busy.pop(inflight_key, None)

    def _release_claim(self, analysis_id):
        """按 owner 释放会话级事件登记（ZCode-R1a；候选终态时成对调用，防误清他人登记）。"""
        for key, claim in list(self.P._event_busy.items()):
            if claim.get("path") == "delivery" and claim.get("owner") == analysis_id:
                self.P._event_busy.pop(key, None)

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
                # ★ ZCode-R1（P-F1）：无 interaction_receipt 的已提交墓碑来自其它协议路径
                # （旧 commit_state），先于载荷比对判定 —— 反向顺序（旧协议先提交、交付后
                # 提交）得到明确的 EVENT_ALREADY_COMMITTED，而不是笼统的载荷冲突。
                prior = rec.get("interaction_receipt")
                if prior is None:
                    raise _ProtoError(409, "EVENT_ALREADY_COMMITTED",
                                      "该 event 已由其它协议路径提交")
                if rec.get("sha") != request_sha:
                    raise _ProtoError(409, "EVENT_PAYLOAD_CONFLICT",
                                      "同一 event_id 用不同 analysis 载荷重放，拒绝")
                if rec.get("base_versions") != expected:
                    raise _ProtoError(409, "IDEMPOTENCY_CONFLICT",
                                      "重放所用基准版本与已提交回执不符")
                return dict(_copy.deepcopy(prior), replayed=True)
            c = self._pending.get(analysis_id)
            if not c or c["session_id"] != sid or c["event_id"] != event_id:
                raise _ProtoError(404, "ANALYSIS_NOT_FOUND", "未知/已清理/scope 不符的候选")
            aid = c["actor_id"]
            if c["status"] == "invalidated":
                raise _ProtoError(410, "ANALYSIS_INVALIDATED", "候选已失效，请重新 Prepare")
            if self.now() >= c["expires_at"]:
                c["status"] = "expired"
                # ZCode-R1a：候选终态（expired）→ 会话级登记成对释放。
                self._release_claim(analysis_id)
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
                # ZCode-R1a：候选终态（invalidated）→ 会话级登记成对释放。
                self._release_claim(analysis_id)
                raise _ProtoError(409, "STATE_VERSION_CONFLICT",
                                  "提交基准版本与当前版本不一致，候选失效，请重新 Prepare",
                                  {"current_versions": cur})
            # ③ 规则复核
            if self.rules_fingerprint() != c["rules_fingerprint"]:
                c["status"] = "invalidated"
                c["terminal_at"] = self.now()
                self._release_claim(analysis_id)
                raise _ProtoError(409, "RULESET_CHANGED",
                                  "规则指纹已变化，候选失效，请重新 Prepare")
            # ③b 服务端档案/检查点身份重验（P3-A-R1）：锁内重读当前身份并与候选固化值比较；
            #     变化即失效候选、不调模型、不提交。身份来自服务端身份源，非 Provider 自报。
            cur_cap = self._capability_identity_value()
            if cur_cap != c.get("capability_identity"):
                c["status"] = "invalidated"
                c["terminal_at"] = self.now()
                self._release_claim(analysis_id)
                raise _ProtoError(409, "CAPABILITY_CHANGED",
                                  "服务端档案/检查点身份已变化，候选失效，请重新 Prepare",
                                  {"current_identity": cur_cap,
                                   "candidate_identity": c.get("capability_identity")})
            # ④ 锁内重算并与预览比对（不同 → 409 + 候选失效，绝不静默换结果）
            # P3-A：用候选里已固化的 Evidence 条目重算关系写项（**不二次调用 Provider**）。
            outcome, proposal, clarifications = self._calculate(
                aid, c["intents"], snap["states"], event_id,
                evidence_entries=_copy.deepcopy(c.get("evidence_entries") or []),
                evidence_absent=c.get("evidence_absent"))
            outcome["event_id"] = event_id
            proposal["base_versions"] = dict(expected)
            if clarifications or proposal["changes"] != c["proposal"]["changes"] \
                    or outcome != c["outcome"]:
                c["status"] = "invalidated"
                c["terminal_at"] = self.now()
                self._release_claim(analysis_id)
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
                    self._release_claim(analysis_id)
                    raise _ProtoError(422, "INVALID_WRITE_PATH",
                                      "点路径不存在，拒绝静默造字段：%s" % ch["path"])
                if ch["path"].endswith(".owner"):
                    applied_owner.append({"object": ch["path"].split(".")[-2],
                                          "from": ch["before"], "to": ch["after"]})
            commit_id = "dl_" + uuid.uuid4().hex[:12]
            ts = self.now()
            resolutions = outcome["resolutions"]
            # 正式回合记录只放**公开描述符**：类型、说话者/观察者、听者、可见范围。
            # 私有原话（声明内容、线索文本）只存在 actor 自己的 knowledge 与权威回执里，
            # 绝不落进 `world.interaction.turns`。
            public_acts = [_copy.deepcopy(r["record"]) for r in resolutions
                           if r.get("record") and r["execution_status"] == "attempted"]
            gained_rows = []
            for r in resolutions:
                for row in r.get("knowledge_gained") or []:
                    gained_rows.append({"action_id": r["action_id"],
                                        "actor_id": row["actor_id"],
                                        "status": row["status"],
                                        "entry": _copy.deepcopy(row["entry"])})
            knowledge_actors = sorted({row["actor_id"] for row in gained_rows})
            new_states[WORLD]["interaction"]["turns"].append({
                "commit_id": commit_id, "event_id": event_id,
                "analysis_id": analysis_id, "actor_id": aid,
                "result": outcome["result"], "degree": outcome["degree"],
                "owner_changes": _copy.deepcopy(applied_owner),
                "acts": _copy.deepcopy(public_acts),
                "knowledge_actors": knowledge_actors,
                "committed_at": _iso(ts),
            })
            receipt = {
                "protocol_version": PROTOCOL_VERSION,
                "status": "committed", "replayed": False,
                "commit_id": commit_id, "analysis_id": analysis_id,
                "session_id": sid, "actor_id": aid, "event_id": event_id,
                "base_versions": dict(expected),
                "committed_at": _iso(ts),
                "source": SOURCE,
                "rules_only": outcome.get("rules_only", True),
                "laya_evidence": _copy.deepcopy(outcome.get("laya_evidence") or []),
                "evidence_absent_reason": outcome.get("evidence_absent_reason"),
                "input_sha256": c["input_sha256"], "request_sha256": request_sha,
                "rules_fingerprint": c["rules_fingerprint"],
                "owner_changes": _copy.deepcopy(applied_owner),
                "acts": _copy.deepcopy(public_acts),
                # 权威回执携带本轮**实际新增/更新**的知识条目（含作者化线索文本）——
                # 「从回执得到线索」靠这一项；它不写进世界回合记录。
                "knowledge_gained": _copy.deepcopy(gained_rows),
                "outcome": _copy.deepcopy(outcome),
            }
            trace = {"t": ts, "kind": "p1_item_delivery",
                     "analysis_id": analysis_id, "event_id": event_id,
                     "session_id": sid, "actor_id": aid,
                     "rules_fingerprint": c["rules_fingerprint"],
                     "applied_changes": _redact_knowledge(proposal["changes"])}
            result = self.P.commit_multi_entity_bundle(
                sid, aid, event_id, expected, new_states, trace, receipt)
            c["status"] = "committed"
            c["terminal_at"] = ts
            c["receipt"] = result
            # 已提交候选立即释放 Pending 容量：权威回执由协议事件表长期提供，
            # 幂等重放走 `_find_event`，不再依赖进程内候选。
            self._pending.pop(analysis_id, None)
            # ZCode-R1a：候选终态（committed）→ 会话级登记成对释放。
            self._release_claim(analysis_id)
            return result

    def get_receipt(self, session_id, event_id):
        """按 (session_id, event_id) 取已提交回执（事件身份不再是 actor 桶）。"""
        with self.P.lock:
            rec = self._find_event(session_id, event_id)[1]
            if not rec or rec.get("status") != "committed" \
                    or rec.get("interaction_receipt") is None:
                raise _ProtoError(404, "RECEIPT_UNKNOWN", "未找到已提交回执")
            return _copy.deepcopy(rec["interaction_receipt"])

    # ------------------------------------------------------------------
    # 私有知识的按 actor 读取（下一轮内部读取只拿本角色自己的条目）
    # ------------------------------------------------------------------
    def knowledge(self, session_id, actor_id):
        """读某角色的私有知识条目；只读，不初始化场景、不写任何状态。

        知识按 `(session_id, actor_id)` 落在权威 Actor State 桶，**没有**「读别人知道
        什么」的旁路：跨角色的知识转移只能由服务端规则（如询问）产生条目后再读。
        """
        sid = str(session_id or "default")
        aid = str(actor_id or "")
        if not _ID_RE.match(aid):
            raise _ProtoError(422, "INVALID_REQUEST",
                              "actor_id 必须为 1–64 位 [A-Za-z0-9_-] 且非空")
        with self.P.lock:
            scope = (sid, aid)
            bucket = self.B._ACTOR_STATE.get(scope)
            inter = (bucket or {}).get("interaction") or {}
            return {
                "session_id": sid, "actor_id": aid,
                "initialized": scope in self.B._ACTOR_STATE,
                "version": self.P.state_version(scope),
                "entries": _copy.deepcopy(inter.get("knowledge") or []),
            }


def _redact_knowledge(changes):
    """把写项里的 `interaction.knowledge` 换成**只含 entry_id/kind** 的审计视图。

    同一份 trace 会被 `commit_multi_entity_bundle` 写进**每个**受影响作用域的
    `_STATE_TRACE`，其中包含世界作用域；因此「私有原话不外流」必须在入口收口，
    而不是指望下游不读。
    """
    out = []
    for ch in changes or []:
        row = _copy.deepcopy(ch)
        if str(row.get("path", "")).endswith("knowledge"):
            for key in ("before", "after"):
                rows = row.get(key)
                if isinstance(rows, list):
                    row[key] = [{"entry_id": e.get("entry_id"), "kind": e.get("kind")}
                                for e in rows if isinstance(e, dict)]
        out.append(row)
    return out


def _reason_codes(outcome):
    codes = []
    for r in outcome.get("resolutions") or []:
        if r["degree"] == "skipped" and "NOT_AN_ATTEMPT" not in codes:
            codes.append("NOT_AN_ATTEMPT")
        for reason in r["check"]["reasons"]:
            if reason not in codes:
                codes.append(reason.upper())
    return codes or ["NO_WRITABLE_RESULT"]
