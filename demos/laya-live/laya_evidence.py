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
#: 真实 Laya 推理产出的 Evidence 来源（区别于 fixture，绝不冒充）。
SOURCE_REAL = "laya"

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


def make_provider_input(states, actor_id, resolutions, event_id, session_id=None):
    """从服务端快照 + 已校验动作结果构造 Provider 输入（**只读**、纯函数）。

    返回 None 表示「没有可评估 Evidence 的目标动作」。输入不含任何客户端自报字段，也不含
    玩家完整 actor_state（只带 actor_id）；NPC 状态经 `_project_npc_state` 投影、剔除 knowledge。
    `session_id`（可选）供真实 Provider 做历史/状态隔离，缺省时用 event_id 派生。
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
        "session_id": session_id or ("sess-" + str(event_id)),
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


# ==========================================================================
# P3-B：真实 Laya Evidence Provider（只取真实模型信号，隔离旧规则修正）
# ==========================================================================
#: 冻结译文资产路径（只读；缺失即停，不在线补译）。
_XLATE_ASSETS_PATH = None
_XLATE_ASSETS = None


def _translation_assets():
    """懒加载 tests/assets/translation_cache.json（中文原文 → 英文译文）。"""
    global _XLATE_ASSETS, _XLATE_ASSETS_PATH
    if _XLATE_ASSETS is None:
        import json as _json
        from pathlib import Path
        here = Path(__file__).resolve().parent
        path = here / "tests" / "assets" / "translation_cache.json"
        _XLATE_ASSETS_PATH = path
        try:
            _XLATE_ASSETS = _json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            _XLATE_ASSETS = {}
    return _XLATE_ASSETS


def translation_cache_lookup(text):
    """从冻结译文资产只读查英文译文；缺失返回 None（调用方应 fail-closed，不在线补译）。"""
    if not text:
        return None
    return _translation_assets().get(text)


def default_real_infer(zh, en, npc_state, listener, session_id):
    """真实推理：调 `laya_bridge.analyze_core(apply_adjudication=False, frozen_state=npc_state)`。

    这是「只取真实模型信号」的入口：`apply_adjudication=False` 使 `state_proposal["delta"]`
    不含结构化/关键词规则修正（`apply_rule_adjudication`）。英文由调用方从冻结译文资产
    读入（`player_input_en`），不触发在线翻译；服务端 NPC 快照经 **`frozen_state=` 函数
    参数**传给 analyze_core（不放 payload），使 analyze_core 跳过回读 Actor State 桶、
    用与 Prepare 一致的快照合并 relationship/emotion/goals。
    """
    import laya_bridge as _B
    payload = {
        "actor": _B.CFG.get("actor"),
        "actor_id": listener,
        "session_id": session_id,
        "player_input": zh,
        "player_input_en": en,
    }
    return _B.analyze_core(payload, frozen_state=npc_state, apply_adjudication=False)


def _evidence_from_real_result(result, cand):
    """从真实 analyze_core 结果提取可写 Evidence（**逐项核对，不自行填 role/status/may_write**）。

    门禁（任一不满足 → 空，绝不产出可写 Evidence）：
      · engine == "laya"（fallback 引擎结果不算真实模型信号）；
      · profile.matched 且 profile.fresh（档案不符/不新鲜 → 不写）；
      · 对每条 delta：source_signal == doubt_shift 且 role == state_shift 且
        status == active 且 target == relationship.doubt 且 checkpoint/profile_id 与
        profile 一致，且 doubt_shift ∈ capability_summary.state_writable（may_write_state=true）。
    以上字段全部来自真实结果，缺失或错配即拒绝，绝不默认填上。
    """
    if not isinstance(result, dict):
        return []
    if result.get("engine") != "laya":
        return []
    proposal = result.get("state_proposal") or {}
    profile = proposal.get("profile") or {}
    if not profile.get("matched") or not profile.get("fresh"):
        return []
    checkpoint = profile.get("checkpoint")
    profile_id = profile.get("profile_id")
    state_writable = set((result.get("capability_summary") or {}).get("state_writable") or [])
    signals = []
    for d in proposal.get("delta") or []:
        if d.get("source_signal") != STATE_SHIFT_SIGNAL:
            continue
        # 逐项核对（缺一项即拒绝），不从 status 反推 role / may_write_state。
        if d.get("role") != "state_shift":
            continue
        if d.get("status") != "active":
            continue
        if d.get("target") != "relationship.doubt":
            continue
        if d.get("checkpoint") != checkpoint:
            continue
        if d.get("profile_id") != profile_id:
            continue
        if STATE_SHIFT_SIGNAL not in state_writable:
            continue  # may_write_state != true
        signals.append({
            "signal": STATE_SHIFT_SIGNAL,
            "role": d.get("role"),
            "status": d.get("status"),
            "may_write_state": True,
            "delta": d.get("delta"),
        })
    if not signals:
        return []
    return [{
        "source": SOURCE_REAL,
        "action_id": cand["action_id"],
        "target_npc": cand["listener"],
        "signals": signals,
    }]


def make_real_evidence_provider(infer=None, xlate_lookup=None):
    """构造真实 Laya Evidence Provider（符合 P3-A 的 `provider(provider_input)` 接口）。

    参数（供零推理检查注入替换）：
      · infer：可替换推理函数，签名 infer(zh, en, npc_state, listener, session_id) -> dict；
        默认 `default_real_infer`（真实 analyze_core，apply_adjudication=False）。
      · xlate_lookup：可替换翻译查询，签名 xlate_lookup(zh) -> en|None；
        默认 `translation_cache_lookup`（只读冻结译文资产）。
    """
    infer = infer or default_real_infer
    xlate_lookup = xlate_lookup or translation_cache_lookup

    def provider(provider_input):
        if not provider_input or not provider_input.get("candidates"):
            return []
        cand = provider_input["candidates"][0]
        zh = cand.get("content") or cand.get("evidence_text") or ""
        en = xlate_lookup(zh)
        if en is None:
            return []   # 翻译缺失即停（fail-closed，不写 Evidence，规则动作仍独立成立）
        npc_state = (provider_input.get("npc_state") or {}).get(cand["listener"]) or {}
        result = infer(zh, en, npc_state, cand["listener"],
                       provider_input.get("session_id"))
        return _evidence_from_real_result(result, cand)
    return provider


def real_capability_identity(model=None):
    """服务端真实档案/检查点身份源（callable，无参调用，供 core 的 capability_identity 注入）。

    身份 = `checkpoint` / `profile_id` / `matched` / `fresh` / **能力档案文件内容 SHA256** /
    **ENGINE 当前实际 model_name**。前三项在「同 mtime 替换档案内容、保留 profile_id」时
    不会变（例如把 `doubt_shift.may_write_state` 改掉），故必须绑定档案内容 SHA，才能让
    Commit 识别变化；绑定 ENGINE 实际 `model_name` 使「实际模型名改变」也使旧候选失效。
    档案不可读 → **fail-closed**（抛错，不返回可用身份）。用 `force=True` 绕过 mtime 缓存重读。
    """
    import laya_bridge as _B
    profile_sha = _B._sha256_file(_B.CAPABILITY_PATH)
    if not profile_sha:
        # 档案不可读 → 不返回可用身份；Prepare/Commit 调用处据此 fail-closed（拒绝）。
        raise RuntimeError("能力档案不可读，无法确定服务端档案身份（fail-closed）")
    _prof, check = _B.load_capability_profile(model, force=True)
    engine_model = getattr(_B.ENGINE, "model_name", None) or _B.DEFAULT_MODEL_NAME
    return {
        "checkpoint": check.get("checkpoint"),
        "profile_id": check.get("profile_id"),
        "matched": bool(check.get("matched")),
        "fresh": bool(check.get("fresh")),
        "profile_sha256": profile_sha,
        "engine_model": engine_model,
    }
