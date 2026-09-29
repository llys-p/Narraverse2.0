"""P3-A · 服务端内部 Laya Evidence Provider 接口与候选绑定（零真实模型）。

这是 P0 契约 §3 `LayaEvidence` 的**最薄接入口**，不加载 Laya 权重、不做推理、不复制
推理引擎、不新建第二套状态存储。它只回答一件事：把「Evidence」与 Pending 候选、
状态提案、Commit 重验绑定起来，让 P3-B 未来接 `analyze_core()` 时有一个确定的落点。

设计边界（对齐《P3 Evidence 接线裁决 v0.1》与 P3-A-R1 复审）：
  · 先有事实，再取证据：只对服务端在副本上判为 `execution_status=attempted`、听者在场的
    `communicate`，且听者 `relationship_to == actor_id`（有向关系明确为 NPC → 玩家）时，
    才可能产出**可写** Evidence。`claim` / 假设 / 引用 / 被阻止 / 跳过的动作不产生可写项。
  · 第一切片只允许 `lia → player` 这一个有向关系；不允许借用其它方向或其它 NPC。
  · 关系写项落在现有 `(session_id, "lia")` Actor State 的 `relationship.doubt`，
    单一状态真源，不建独立关系库。
  · 可写信号必须 `role=state_shift` 且 `status=active`；其余最多作辅助 Evidence（不写）。
  · **Provider 可见数据最小化（R1）**：`make_provider_input` 不传玩家完整 actor_state，
    只按服务端允许字段投影目标 NPC 状态，并**排除**各角色的 `interaction.knowledge`；
    回执 Evidence 只保留协议白名单字段，不透传 Provider 附带的原始字段。
  · **同轮写项口径（R1）**：同一 NPC、同一路径的多条可写 Evidence 按顺序累加 delta，
    并对整轮应用**一次** State Transition（死区/单轮上限/区间），不从旧值起算后静默覆盖。
  · Evidence 由**服务端内部注入的 Provider** 产生；档案/检查点身份由服务端身份源在候选级
    固化（见 `laya_delivery_core`），**不采信 Provider 自报的 profile/checkpoint**。
  · 生产默认（无 Provider）保持 `rules_only=true, laya_evidence=[]`。
"""

import copy as _copy
from collections import OrderedDict

#: Evidence 的 `source` 只能是 `test_fixture`（P3-B 起为真实来源）；fixture 必须显式标注。
SOURCE_FIXTURE = "test_fixture"

#: 第一切片唯一允许写入的有向关系（NPC → 玩家）；方向核对在 make_provider_input / entries_to_changes。
ALLOWED_NPC_TO_PLAYER = frozenset({"lia"})

#: 只有 role=state_shift 的信号能产出可写 delta；这里按信号名固定第一切片。
STATE_SHIFT_SIGNAL = "doubt_shift"

#: Provider 返回的每个 signal 里，**只允许这些字段**进入候选/回执；其余 Provider 附带字段被丢弃。
PROVIDER_SIGNAL_WHITELIST = ("signal", "role", "status", "may_write_state", "delta")

#: 回执 Evidence 条目的**固定白名单字段**；Provider 附带的任意额外字段不透传。
EVIDENCE_FIELDS = ("source", "event_id", "action_id", "target_npc", "actor_id",
                   "kind", "sub_kind", "signals", "writable")


def _project_npc_state(state):
    """投影目标 NPC 状态给 Provider：深拷贝后剔除 `interaction.knowledge`（私有知识外泄口）。

    其余字段（relationship/emotion/goals/traits/name/interaction 公开部分）保留——Provider
    评估关系信号需要它们。这里**不**包含玩家 state，也不包含任何角色的私有知识。
    """
    row = _copy.deepcopy(state)
    inter = row.get("interaction")
    if isinstance(inter, dict):
        inter.pop("knowledge", None)
    return row


def make_provider_input(states, actor_id, resolutions, event_id):
    """从服务端快照 + 已校验动作结果构造 Provider 输入（**只读**、纯函数）。

    返回 None 表示「没有可评估 Evidence 的目标动作」。输入不含任何客户端自报字段，也不含
    玩家完整 actor_state（只带 actor_id）；NPC 状态经 `_project_npc_state` 投影、剔除 knowledge。
    """
    candidates = []
    for r in resolutions:
        if r.get("operation") != "communicate":
            continue
        if r.get("execution_status") != "attempted":
            continue
        chk = r.get("check") or {}
        listener = chk.get("listener")
        if not listener or not chk.get("allowed"):
            continue
        # 裁决 §1：`claim`/假设/引用不产生可写 Evidence；「发言不等于事实」下，声明类
        # 也不驱动关系变化。第一切片只评估**询问**（question）这一种已尝试的实质交流。
        if chk.get("sub_kind") != "question":
            continue
        # 关系方向必须来自服务端模板：听者的 `relationship_to` 指向行动者本人。
        lst_state = states.get(listener) or {}
        rel_to = (lst_state.get("interaction") or {}).get("relationship_to")
        if rel_to != actor_id:
            continue
        if listener not in ALLOWED_NPC_TO_PLAYER:
            continue
        candidates.append({
            "event_id": event_id,
            "action_id": r.get("action_id"),
            "sub_kind": chk.get("sub_kind"),
            "kind": chk.get("kind"),
            "listener": listener,
            "actor_id": actor_id,
            "evidence_text": r.get("evidence") or "",
            "content": chk.get("content") or "",
        })
    if not candidates:
        return None
    return {
        "event_id": event_id,
        "actor_id": actor_id,
        "candidates": candidates,
        "npc_state": {lid: _project_npc_state(states[lid])
                      for lid in sorted({c["listener"] for c in candidates})},
    }


def normalize_evidence(raw_evidence, provider_input):
    """把 Provider 返回的 Evidence 规整为「身份固定、可校验、字段白名单」的结构。

    只保留：
      · 指向 provider_input 里真实存在的（action_id, listener）；
      · 有向关系方向为 NPC → 玩家（listener 的 relationship_to == actor_id 已在构造时核对）；
      · signal 经 `PROVIDER_SIGNAL_WHITELIST` 白名单投影（丢弃 Provider 附带字段）；
      · 可写信号 role=state_shift 且 status=active（doubt_shift）。
    不采信 Provider 自报的 profile/checkpoint —— 档案身份由服务端身份源在候选级固化。
    """
    if not raw_evidence:
        return []
    by_action = {c["action_id"]: c for c in provider_input["candidates"]}
    out = []
    for ev in raw_evidence:
        if not isinstance(ev, dict):
            continue
        aid = ev.get("action_id")
        base = by_action.get(aid)
        if base is None:
            continue
        listener = ev.get("target_npc") or base["listener"]
        if listener != base["listener"]:
            continue
        source = ev.get("source")
        normalized_signals = []
        writable = False
        for sig in ev.get("signals") or []:
            if not isinstance(sig, dict):
                continue
            name = sig.get("signal")
            # 严格白名单：只保留协议需要的字段，其余 Provider 附带字段丢弃。
            keep = {k: sig.get(k) for k in PROVIDER_SIGNAL_WHITELIST}
            if name != STATE_SHIFT_SIGNAL:
                keep["role"] = None
                keep["status"] = "auxiliary"
                keep["may_write"] = False
            else:
                role = keep.get("role")
                status = keep.get("status")
                may_write = (role == "state_shift" and status == "active"
                             and keep.get("may_write_state", True))
                keep["may_write"] = bool(may_write)
                writable = writable or may_write
            normalized_signals.append(keep)
        out.append({
            "source": source,
            "event_id": base["event_id"],
            "action_id": aid,
            "target_npc": listener,
            "actor_id": base["actor_id"],
            "kind": base["kind"],
            "sub_kind": base["sub_kind"],
            "signals": normalized_signals,
            "writable": bool(writable),
        })
    return out


def entries_to_changes(core, states, actor_id, entries):
    """从**已固化的 Evidence 条目**重算可写关系写项（不调 Provider）。

    供 Commit 锁内与 Prepare 复核段使用：候选里存的是 Prepare 时算好的 `entries`，这里基于
    **当前快照**重跑 `state_transition`。同一 NPC、同一 signal 的多条可写 Evidence **先累加
    delta，再对整轮应用一次 transition**（死区/单轮上限/区间），不从旧值起算后静默覆盖；
    合并后产生**一条**写项，transition 审计写回每条 signal。
    """
    groups = OrderedDict()  # (npc, signal) -> [(ev, sig), ...]
    for ev in entries or []:
        if not ev.get("writable"):
            continue
        npc = ev.get("target_npc")
        npc_state = states.get(npc) or {}
        inter = npc_state.get("interaction") or {}
        # 关系方向再核对一次（单一状态真源 + 防把 player→lia 偷写成 lia→player）。
        if inter.get("relationship_to") != actor_id:
            continue
        for sig in ev.get("signals") or []:
            if not sig.get("may_write"):
                continue
            signal = sig.get("signal") or STATE_SHIFT_SIGNAL
            groups.setdefault((npc, signal), []).append((ev, sig))

    changes = []
    for (npc, signal), items in groups.items():
        npc_state = states.get(npc) or {}
        rel = npc_state.get("relationship") or {}
        current = rel.get("doubt")
        # 累加 delta（按顺序），对整轮应用一次 transition。
        total = 0.0
        for _ev, sig in items:
            d = sig.get("delta")
            if isinstance(d, (int, float)) and not isinstance(d, bool):
                total += float(d)
        trans = core.B.state_transition(signal, total, current, allowed=True)
        for _ev, sig in items:
            sig["transition"] = _copy.deepcopy(trans)
        if trans.get("committed") and trans.get("final_delta", 0.0) != 0.0:
            path = trans.get("target") or "relationship.doubt"
            action_ids = ",".join(ev["action_id"] for ev, _sig in items)
            changes.append({
                "entity_id": npc,
                "path": path,
                "before": current,
                "after": trans.get("new_value"),
                "source": "laya_evidence:%s:%s" % (action_ids, signal),
            })
    return changes


def fixture_provider(doubt_delta):
    """构造一个固定返回的 fixture Provider（**显式 source=test_fixture**）。

    只对输入里第一个候选动作给一条 Evidence：信号 doubt_shift / role=state_shift /
    status=active，`delta` 由调用方给定。不带任何档案身份字段（由服务端身份源承载）。
    """
    def _provider(provider_input):
        cand = provider_input["candidates"][0]
        return [{
            "source": SOURCE_FIXTURE,
            "action_id": cand["action_id"],
            "target_npc": cand["listener"],
            "signals": [{
                "signal": STATE_SHIFT_SIGNAL,
                "role": "state_shift",
                "status": "active",
                "may_write_state": True,
                "delta": doubt_delta,
            }],
        }]
    return _provider


def fixture_provider_multi(deltas):
    """按 candidates 顺序给前 N 个候选各一条 Evidence（delta 依次取 `deltas`）。

    用于同轮多条可写 Evidence 的累加口径反例。每条显式 source=test_fixture，无档案身份字段。
    """
    def _provider(provider_input):
        out = []
        for i, cand in enumerate(provider_input["candidates"]):
            if i >= len(deltas):
                break
            out.append({
                "source": SOURCE_FIXTURE,
                "action_id": cand["action_id"],
                "target_npc": cand["listener"],
                "signals": [{
                    "signal": STATE_SHIFT_SIGNAL,
                    "role": "state_shift",
                    "status": "active",
                    "may_write_state": True,
                    "delta": deltas[i],
                }],
            })
        return out
    return _provider
