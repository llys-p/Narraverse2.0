"""P2-B2a 交流与检查的服务端事实链 · 定向检查（零模型、零云端、零 HTTP、零 Laya）。

覆盖《P2-B2a 询问与检查》的 A 固定行为边界：
  A1  正向链：问莉亚 → 权威回执给出旧井线索 → 下一轮读到玩家已知线索 → 去旧井拾钥匙
      → 回酒馆开门；线索本身不替玩家移动或拾取
  A2  发言不等于事实：`claim` 只落带说话者/听者与 `asserted_by` 的声明条目，
      不改 owner / 门 / 位置 / 客观 facts，也不提高好感
  A3  询问与观察只用服务端作者化信息：远距询问不得答复；酒馆看不见旧井的钥匙；
      观察只写检查者 knowledge
  B1  事件可提交，但不能空提交伪装成功：真实交流/观察带 `turn_tick + 1`；
      被阻止 / 跳过 / 非尝试的动作不能借时钟取得可提交资格
  B2  知识位置固定：`interaction.knowledge` 按 actor 私有；世界回合记录只留
      类型/说话者/听者/可见范围，不放私有原话
  B3  权威边界：客户端注入难度/delta/outcome → 422；非角力的 attack（kind=violence）仍 UNSUPPORTED_OPERATION

P2-B2a-R1 定向修复的补强反例（A 关口审查）：
  F1–F6 私有知识视图：普通 `state()` 剔除各 actor 的 knowledge，按 actor 的内部读取仍正确，
         声明后普通视图与世界回合记录都不含私有原话
  G1–G8 持有物有效位置：取钥匙带回酒馆后能观察携带的钥匙；留在旧井的人看不到已被带走的钥匙；
         转交后可见性随新持有人位置变化
  H1–H3 线索时效：钥匙离开旧井后旧线索不再作**当前**线索披露；已学到的旧线索作为历史保留，
         复制条目带 `as_of_turn` 且 `objective=False`
  I1–I3 披露主题：无明确对象的一般问题不披露；问了别的对象不给钥匙线索；问钥匙才给钥匙线索

★ 运行环境：Windows 控制台默认 GBK 编不出 ✅，请用
  `PYTHONIOENCODING=utf-8 python tests/p2b2a_communicate_unit.py`
"""
import copy
import json
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B
from laya_delivery_core import WORLD, DeliveryCore
from laya_state_protocol import _ProtoError  # noqa: F401  （与 expect_error 配套）

FAIL = []
N = [0]

#: 公开回合描述符允许出现的键 —— 任何私有内容字段（content/text/evidence…）都不许进来。
ACT_KEYS = {"type", "sub_kind", "kind", "speaker", "listener", "observer",
            "subject", "visibility"}


def chk(tag, ok, detail=""):
    N[0] += 1
    print("  %s [%s] %s" % ("✅" if ok else "❌", tag, detail))
    if not ok:
        FAIL.append(tag)


def expect_error(tag, fn, code):
    try:
        fn()
    except _ProtoError as e:
        chk(tag, e.code == code, "%s %s" % (e.code, (e.message or "")[:70]))
        return e
    chk(tag, False, "未抛出错误，期望 %s" % code)
    return None


def fresh(sid):
    B.reset_actor_state()
    B.reset_history()
    B._PENDING.clear()
    P = B.PROTOCOL
    with P.lock:
        P._events.clear()
        P._buckets.clear()
        P._analyses.clear()
        P._inflight.clear()
    core = DeliveryCore(B, protocol=P)
    core.ensure_scene(sid)
    return core, P, sid


def talk(aid, kind, listener="lia", content="", evidence="", mode="attempt", obj=None):
    return {"id": aid, "operation": "communicate",
            "target_ids": [listener] if listener else [], "object_id": obj,
            "mode": mode, "kind": kind, "content": content, "evidence": evidence}


def look(aid, subject):
    return {"id": aid, "operation": "inspect", "target_ids": [], "object_id": subject,
            "mode": "attempt", "kind": "inspect", "content": "", "evidence": ""}


def prepare(core, sid, actions, event, actor="player"):
    return core.prepare_structured({
        "session_id": sid, "event_id": event, "actor_id": actor,
        "expected_versions": core.state(sid)["versions"], "actions": actions,
    })


def commit(core, sid, pv, event):
    return core.commit({"session_id": sid, "event_id": event,
                        "analysis_id": pv["analysis_id"],
                        "expected_versions": pv["base_versions"]})


def world_of(core, sid):
    return core.state(sid)["states"][WORLD]["interaction"]


def entries_of(core, sid, actor):
    return core.knowledge(sid, actor)["entries"]


class _BoomTrace(dict):
    def setdefault(self, key, default=None):
        raise RuntimeError("injected publish failure")


# ------------------------------------------------------------------ A1 正向链
def test_answer_chain():
    core, P, sid = fresh("b2a-ask")
    before = copy.deepcopy(B._ACTOR_STATE)
    pv = prepare(core, sid, [talk("a1", "question", content="钥匙在哪",
                                  evidence="钥匙在哪", obj="cellar_key")], "ask-1")
    chk("A1-1 在场听者的询问可就绪", pv["status"] == "ready" and pv["can_commit"],
        str(pv["reason_codes"]))
    chk("A1-2 Prepare 零游戏写入（knowledge / 时钟 / 归属都不动）",
        B._ACTOR_STATE == before, "prepare must only simulate")
    rs = pv["outcome"]["resolutions"][0]
    chk("A1-3 询问是真实尝试，且带服务端回合变化",
        rs["execution_status"] == "attempted" and rs["degree"] == "success"
        and any(c["path"] == "interaction.turn_tick"
                for c in pv["state_proposal"]["changes"]),
        repr([c["path"] for c in pv["state_proposal"]["changes"]]))
    chk("A1-4 线索不替玩家移动或拾取（零游戏写入的旁证）",
        B._ACTOR_STATE[(sid, WORLD)]["interaction"]["objects"]["cellar_key"]["owner"] is None
        and B._ACTOR_STATE[(sid, "player")]["interaction"]["location"] == "tavern", "")

    rec = commit(core, sid, pv, "ask-1")
    gained = rec["knowledge_gained"]
    chk("A2-1 权威回执给出旧井线索（来自服务端作者化模板）",
        rec["status"] == "committed" and len(gained) == 1
        and gained[0]["actor_id"] == "player" and gained[0]["status"] == "added"
        and gained[0]["entry"]["content"] == "地窖钥匙在旧井"
        and gained[0]["entry"]["told_by"] == "lia",
        str(gained)[:180])
    chk("A2-2 回合记录带类型 / 说话者 / 听者 / 可见范围",
        rec["acts"] == [{"type": "communicate", "sub_kind": "question",
                         "kind": "question", "speaker": "player", "listener": "lia",
                         "visibility": "participants"}], str(rec["acts"]))
    w = world_of(core, sid)
    chk("A2-3 世界回合记录不含线索文本，只有公开描述符",
        len(w["turns"]) == 1 and w["turns"][0]["acts"] == rec["acts"]
        and w["turns"][0]["knowledge_actors"] == ["player"]
        and "地窖钥匙在旧井" not in json.dumps(w["turns"], ensure_ascii=False),
        str(w["turns"]))
    chk("A2-4 公开描述符不含任何私有内容字段",
        all(set(a) <= ACT_KEYS for row in w["turns"] for a in row["acts"]), "")
    chk("A2-5 线索不写客观 facts，时钟推进一次",
        w["facts"] == [] and w["turn_tick"] == 1, str(w["facts"]))
    kb = entries_of(core, sid, "player")
    chk("A2-6 下一轮读到玩家已知线索（带来源、学习回合与得知当时语义）",
        len(kb) == 1 and kb[0]["entry_id"] == "clue:cellar_key_location"
        and kb[0]["learned_turn"] == 1 and kb[0]["as_of_turn"] == 1
        and kb[0]["objective"] is False and kb[0]["told_by"] == "lia", str(kb))
    lk = entries_of(core, sid, "lia")
    chk("A2-7 莉亚自己的知识未被改写（作者化条目原样）",
        len(lk) == 1 and lk[0]["source"] == "authored" and "told_by" not in lk[0],
        str(lk))

    # 线索只给方向，移动与拾取仍要玩家自己按 B1 链走。
    pv2 = prepare(core, sid, [
        {"id": "m1", "operation": "move", "target_ids": ["old_well"], "object_id": None},
        {"id": "t1", "operation": "take", "target_ids": [], "object_id": "cellar_key",
         "depends_on": "m1", "when": "if_achieved"},
    ], "go-well")
    chk("A3-1 循线索去旧井并拾取钥匙", pv2["status"] == "ready", str(pv2["reason_codes"]))
    commit(core, sid, pv2, "go-well")
    pv3 = prepare(core, sid, [
        {"id": "m2", "operation": "move", "target_ids": ["tavern"], "object_id": None},
        {"id": "u1", "operation": "unlock", "target_ids": [], "object_id": "cellar_door",
         "depends_on": "m2", "when": "if_achieved"},
    ], "open-door")
    commit(core, sid, pv3, "open-door")
    w = world_of(core, sid)
    chk("A3-2 链闭环：钥匙归玩家、门已开、回合各推进一步",
        w["objects"]["cellar_key"]["owner"] == "player"
        and w["objects"]["cellar_door"]["locked"] is False
        and w["objects"]["cellar_door"]["open"] is True and w["turn_tick"] == 3,
        "tick=%s owner=%s locked=%s" % (w["turn_tick"],
                                        w["objects"]["cellar_key"]["owner"],
                                        w["objects"]["cellar_door"]["locked"]))
    chk("A3-3 移动/拾取/开门不伪造知识，玩家知识仍只有那条线索",
        [e["entry_id"] for e in entries_of(core, sid, "player")]
        == ["clue:cellar_key_location"],
        str(entries_of(core, sid, "player")))


# ------------------------------- F 私有知识视图：普通 state() 不得外泄他人知识
def test_state_hides_private_knowledge():
    core, P, sid = fresh("b2a-privacy")
    st = core.state(sid)
    chk("F1 场景视图不暴露任何 actor 的私有 knowledge",
        "knowledge" not in st["states"]["lia"]["interaction"]
        and "knowledge" not in st["states"]["player"]["interaction"],
        str(list(st["states"]["lia"]["interaction"].keys())))
    chk("F2 按 actor 的内部读取仍正确（莉亚保有作者化线索）",
        len(entries_of(core, sid, "lia")) == 1
        and entries_of(core, sid, "lia")[0]["entry_id"] == "clue:cellar_key_location",
        str(entries_of(core, sid, "lia")))

    pv = prepare(core, sid, [talk("a1", "question", content="钥匙在哪",
                                  evidence="钥匙在哪", obj="cellar_key")], "priv-ask")
    commit(core, sid, pv, "priv-ask")
    st2 = core.state(sid)
    chk("F3 提交后普通视图仍读不到任何 actor 私有条目",
        "knowledge" not in st2["states"]["player"]["interaction"]
        and "knowledge" not in st2["states"]["lia"]["interaction"],
        str(list(st2["states"]["player"]["interaction"].keys())))
    chk("F4 内部按 actor 读取能看到玩家新知识（隔离意义成立）",
        len(entries_of(core, sid, "player")) == 1
        and entries_of(core, sid, "lia")[0]["kind"] == "clue", "")

    pv = prepare(core, sid, [talk("c1", "claim", content="钥匙在我这",
                                  evidence="钥匙在我这")], "priv-claim")
    commit(core, sid, pv, "priv-claim")
    st3 = core.state(sid)
    chk("F5 声明后普通视图仍不含私有原话",
        "钥匙在我这" not in json.dumps(st3["states"], ensure_ascii=False)
        and "knowledge" not in st3["states"]["lia"]["interaction"], "")
    chk("F6 世界回合记录也不含私有原话",
        "钥匙在我这" not in json.dumps(world_of(core, sid)["turns"], ensure_ascii=False), "")


# ------------------------------- G 持有物有效位置：可见性随持有人移动而变化
def test_effective_location_visibility():
    core, P, sid = fresh("b2a-visible")
    pv = prepare(core, sid, [
        {"id": "m1", "operation": "move", "target_ids": ["old_well"], "object_id": None},
        {"id": "t1", "operation": "take", "target_ids": [], "object_id": "cellar_key",
         "depends_on": "m1", "when": "if_achieved"},
        {"id": "m2", "operation": "move", "target_ids": ["tavern"], "object_id": None,
         "depends_on": "t1", "when": "if_achieved"},
    ], "go-grab")
    chk("G1 取钥匙并带回酒馆的链可就绪", pv["status"] == "ready", str(pv["reason_codes"]))
    commit(core, sid, pv, "go-grab")
    w = world_of(core, sid)
    chk("G2 钥匙归玩家（静态落地位置仍是旧井）",
        w["objects"]["cellar_key"]["owner"] == "player"
        and w["objects"]["cellar_key"]["location"] == "old_well",
        str(w["objects"]["cellar_key"]))

    pv = prepare(core, sid, [look("i1", "cellar_key")], "peek-carried")
    chk("G3 玩家在酒馆能观察自己携带的钥匙（有效位置随持有人）",
        pv["status"] == "ready", str(pv["reason_codes"]))
    rec = commit(core, sid, pv, "peek-carried")
    obs = rec["knowledge_gained"][0]["entry"]
    chk("G4 观察内容用有效位置（酒馆），不是静态旧井",
        obs["about"]["location"] == "tavern" and "位于 tavern" in obs["content"], str(obs))

    pv = prepare(core, sid, [{"id": "lm1", "operation": "move",
                              "target_ids": ["old_well"], "object_id": None}], "lia-go",
                 actor="lia")
    commit(core, sid, pv, "lia-go")
    pv = prepare(core, sid, [look("li1", "cellar_key")], "lia-peek", actor="lia")
    r = pv["outcome"]["resolutions"][0]
    chk("G5 留在旧井的人看不到已被带走的钥匙",
        pv["status"] == "blocked" and "object_out_of_sight" in r["check"]["reasons"],
        repr(r["check"]["reasons"]))

    pv = prepare(core, sid, [{"id": "lm2", "operation": "move",
                              "target_ids": ["tavern"], "object_id": None}], "lia-back",
                 actor="lia")
    commit(core, sid, pv, "lia-back")
    pv = prepare(core, sid, [{"id": "tr1", "operation": "transfer",
                              "target_ids": ["lia"], "object_id": "cellar_key"}], "give-key")
    commit(core, sid, pv, "give-key")
    chk("G6 钥匙转交后归莉亚（仍无人移动静态位置）",
        world_of(core, sid)["objects"]["cellar_key"]["owner"] == "lia", "")

    pv = prepare(core, sid, [{"id": "lm3", "operation": "move",
                              "target_ids": ["old_well"], "object_id": None}], "lia-go2",
                 actor="lia")
    commit(core, sid, pv, "lia-go2")
    pv = prepare(core, sid, [look("i2", "cellar_key")], "peek-again")
    r = pv["outcome"]["resolutions"][0]
    chk("G7 钥匙随新持有人到旧井后，酒馆的玩家看不到",
        pv["status"] == "blocked" and "object_out_of_sight" in r["check"]["reasons"],
        repr(r["check"]["reasons"]))
    pv = prepare(core, sid, [look("li2", "cellar_key")], "lia-peek2", actor="lia")
    chk("G8 旧井的持有人自己能看到携带的钥匙", pv["status"] == "ready",
        str(pv["reason_codes"]))


# ------------------------------- H 线索时效：钥匙离开旧井后不再作当前线索
def test_clue_timeliness():
    core, P, sid = fresh("b2a-stale")
    pv = prepare(core, sid, [talk("q1", "question", content="钥匙在哪",
                                  evidence="钥匙在哪", obj="cellar_key")], "q1")
    rec = commit(core, sid, pv, "q1")
    chk("H1 钥匙还在旧井时可披露线索",
        len(rec["knowledge_gained"]) == 1
        and rec["knowledge_gained"][0]["entry"]["as_of_turn"] == 1, str(rec["knowledge_gained"]))

    pv = prepare(core, sid, [
        {"id": "m1", "operation": "move", "target_ids": ["old_well"], "object_id": None},
        {"id": "t1", "operation": "take", "target_ids": [], "object_id": "cellar_key",
         "depends_on": "m1", "when": "if_achieved"},
        {"id": "m2", "operation": "move", "target_ids": ["tavern"], "object_id": None,
         "depends_on": "t1", "when": "if_achieved"},
    ], "grab")
    commit(core, sid, pv, "grab")
    pv = prepare(core, sid, [talk("q2", "question", content="钥匙在哪",
                                  evidence="钥匙在哪", obj="cellar_key")], "q2")
    r = pv["outcome"]["resolutions"][0]
    rec2 = commit(core, sid, pv, "q2")
    chk("H2 钥匙离开旧井后，旧井线索不再作为当前线索披露",
        r["check"]["clues"] == [] and rec2["knowledge_gained"] == [],
        "clues=%s gained=%s" % (r["check"]["clues"], rec2["knowledge_gained"]))
    chk("H3 玩家已学到的旧线索作为历史知识保留（带得知当时语义）",
        [e["entry_id"] for e in entries_of(core, sid, "player")]
        == ["clue:cellar_key_location"]
        and entries_of(core, sid, "player")[0]["objective"] is False
        and entries_of(core, sid, "player")[0]["as_of_turn"] == 1,
        str(entries_of(core, sid, "player")))


# ------------------------------- I 披露主题：只按结构化 object_id 匹配，不做关键词
def test_disclosure_object_scoping():
    core, P, sid = fresh("b2a-scope")
    pv = prepare(core, sid, [talk("a1", "question", content="有什么线索吗",
                                  evidence="有什么线索吗")], "general")
    r = pv["outcome"]["resolutions"][0]
    rec = commit(core, sid, pv, "general")
    chk("I1 无明确对象的一般问题不披露钥匙线索",
        r["check"]["clues"] == [] and rec["knowledge_gained"] == [],
        "clues=%s" % r["check"]["clues"])

    pv = prepare(core, sid, [talk("a2", "question", content="钥匙在哪",
                                  evidence="钥匙在哪", obj="cellar_door")], "wrong-obj")
    r = pv["outcome"]["resolutions"][0]
    chk("I2 问了别的对象（门）不给钥匙线索（按 object_id 匹配）",
        r["check"]["clues"] == [], str(r["check"]["clues"]))

    pv = prepare(core, sid, [talk("a3", "question", content="钥匙在哪",
                                  evidence="钥匙在哪", obj="cellar_key")], "right-obj")
    rec3 = commit(core, sid, pv, "right-obj")
    chk("I3 问了钥匙才披露钥匙线索",
        len(rec3["knowledge_gained"]) == 1
        and rec3["knowledge_gained"][0]["entry"]["entry_id"] == "clue:cellar_key_location",
        str(rec3["knowledge_gained"]))


# ------------------------------------------------ A2/B1-a 远距询问与不可见观察
def test_remote_and_out_of_sight():
    core, P, sid = fresh("b2a-remote")
    pv = prepare(core, sid, [{"id": "m1", "operation": "move",
                              "target_ids": ["old_well"], "object_id": None}], "go")
    commit(core, sid, pv, "go")

    pv = prepare(core, sid, [talk("a1", "question", content="钥匙在哪",
                                  evidence="钥匙在哪")], "remote-ask")
    r = pv["outcome"]["resolutions"][0]
    chk("B1-1 远距询问被阻止（对不在场的人不得获得答复）",
        pv["status"] == "blocked" and r["execution_status"] == "blocked"
        and r["degree"] is None and "listener_out_of_reach" in r["check"]["reasons"],
        repr(r["check"]["reasons"]))
    chk("B1-2 被阻止的交流没有任何写项（不能借时钟取得可提交资格）",
        pv["state_proposal"]["changes"] == [], str(pv["state_proposal"]["changes"]))
    expect_error("B1-3 被阻止的交流不可提交",
                 lambda: commit(core, sid, pv, "remote-ask"), "ANALYSIS_NOT_COMMITTABLE")
    chk("B1-4 被阻止的交流未写入任何知识、未推进时钟",
        entries_of(core, sid, "player") == [] and world_of(core, sid)["turn_tick"] == 1,
        "tick=%s" % world_of(core, sid)["turn_tick"])

    pv = prepare(core, sid, [{"id": "m2", "operation": "move",
                              "target_ids": ["tavern"], "object_id": None}], "back")
    commit(core, sid, pv, "back")
    pv = prepare(core, sid, [look("i1", "cellar_key")], "peek-key")
    r = pv["outcome"]["resolutions"][0]
    chk("B2-1 在酒馆观察旧井的钥匙被阻止（不可及）",
        pv["status"] == "blocked" and "object_out_of_sight" in r["check"]["reasons"],
        repr(r["check"]["reasons"]))
    chk("B2-2 观察被阻止时不写 knowledge、不推时钟",
        entries_of(core, sid, "player") == [] and world_of(core, sid)["turn_tick"] == 2, "")

    facts_before = copy.deepcopy(world_of(core, sid)["facts"])
    pv = prepare(core, sid, [look("i2", "cellar_door")], "look-door")
    chk("B3-1 就地观察可见的门可就绪", pv["status"] == "ready", str(pv["reason_codes"]))
    commit(core, sid, pv, "look-door")
    kb = entries_of(core, sid, "player")
    chk("B3-2 观察只写检查者 knowledge，内容由服务端字段生成",
        len(kb) == 1 and kb[0]["kind"] == "observation"
        and kb[0]["subject"] == "cellar_door" and kb[0]["about"]["locked"] is True
        and kb[0]["source"] == "rule", str(kb))
    chk("B3-3 观察不新增客观 facts、不改门状态",
        world_of(core, sid)["facts"] == facts_before
        and world_of(core, sid)["objects"]["cellar_door"]["locked"] is True,
        "facts=%s" % world_of(core, sid)["facts"])
    chk("B3-4 观察不进莉亚的知识（按 actor 过滤）",
        [e["kind"] for e in entries_of(core, sid, "lia")] == ["clue"],
        str(entries_of(core, sid, "lia")))


# ------------------------------------------------------- A2 声明不等于事实
def test_claim_is_not_a_fact():
    core, P, sid = fresh("b2a-claim")
    pv = prepare(core, sid, [talk("a1", "claim", content="我已经把钥匙给你了",
                                  evidence="我已经把钥匙给你了")], "claim-1")
    chk("C1-1 声明是一次真实交流回合", pv["status"] == "ready", str(pv["reason_codes"]))
    chk("C1-2 声明的写项只有双方 knowledge 与回合时钟，无任何属主/门/位置写",
        sorted({c["path"] for c in pv["state_proposal"]["changes"]})
        == ["interaction.knowledge", "interaction.turn_tick"]
        and sorted({c["entity_id"] for c in pv["state_proposal"]["changes"]})
        == sorted(["lia", "player", WORLD]),
        str(pv["state_proposal"]["changes"])[:200])
    rec = commit(core, sid, pv, "claim-1")
    w = world_of(core, sid)
    chk("C2-1 声明不改客观事实：归属 / 门 / 位置 / 客观 facts 全不变",
        w["objects"]["cellar_key"]["owner"] is None
        and w["objects"]["cellar_key"]["location"] == "old_well"
        and w["objects"]["cellar_door"]["locked"] is True and w["facts"] == [],
        "owner=%s locked=%s facts=%s" % (w["objects"]["cellar_key"]["owner"],
                                        w["objects"]["cellar_door"]["locked"], w["facts"]))
    chk("C2-2 声明不改好感 / 信任",
        core.state(sid)["states"]["lia"]["relationship"]["trust"] == 60, "")
    pk, lk = entries_of(core, sid, "player"), entries_of(core, sid, "lia")
    chk("C2-3 声明只落发言者与听者的 statement，明确 asserted_by 且非客观真相",
        len(pk) == 1 and pk[0]["kind"] == "statement"
        and pk[0]["asserted_by"] == "player" and pk[0]["objective"] is False
        and any(e["kind"] == "statement" and e["asserted_by"] == "player"
                and e["objective"] is False for e in lk),
        "player=%s lia=%s" % (pk, lk))
    chk("C2-4 世界回合记录不放私有原话",
        "我已经把钥匙给你了" not in json.dumps(w["turns"], ensure_ascii=False),
        json.dumps(w["turns"], ensure_ascii=False)[:150])
    chk("C2-5 回执仍给出声明内容（供下一轮指代）",
        rec["knowledge_gained"][0]["entry"]["content"] == "我已经把钥匙给你了", "")
    chk("C2-6 隐喻威胁这类表态同样不改客观事实",
        world_of(core, sid)["objects"]["cellar_door"]["open"] is False, "")
    audit = [ch for item in (B._STATE_TRACE.get((sid, WORLD)) or [])
             for ch in (item.get("applied_changes") or [])
             if str(ch.get("path", "")).endswith("knowledge")]
    chk("C2-7 审计 trace（含世界作用域）里的 knowledge 写项已脱敏，不含私有原话",
        bool(audit) and all(
            set(e) == {"entry_id", "kind"}
            for ch in audit for e in (ch.get("before") or []) + (ch.get("after") or []))
        and "我已经把钥匙给你了" not in json.dumps(audit, ensure_ascii=False),
        json.dumps(audit, ensure_ascii=False)[:160])


# --------------------------------------------------------- 澄清与形态校验
def test_clarify_and_schema():
    core, P, sid = fresh("b2a-clarify")
    expect_error("D1-交流缺听者 → 澄清（不暗选）",
                 lambda: prepare(core, sid, [talk("a1", "question", listener=None,
                                                  content="钥匙在哪")], "no-listener"),
                 "NEEDS_CLARIFICATION")
    expect_error("D2-听者不唯一 → 澄清（不暗选）",
                 lambda: prepare(core, sid, [{
                     "id": "a1", "operation": "communicate",
                     "target_ids": ["lia", "player"], "object_id": None,
                     "mode": "attempt", "kind": "question", "content": "钥匙在哪"}], "two"),
                 "NEEDS_CLARIFICATION")
    expect_error("D3-未知听者 → 澄清",
                 lambda: prepare(core, sid, [talk("a1", "question", listener="ghost",
                                                  content="钥匙在哪")], "ghost"),
                 "NEEDS_CLARIFICATION")
    pv = prepare(core, sid, [talk("a1", "question", listener="player",
                                  content="钥匙在哪")], "self-talk")
    chk("D4-对自己说话 → blocked（不是澄清）",
        pv["status"] == "blocked"
        and "target_is_self" in pv["outcome"]["resolutions"][0]["check"]["reasons"], "")
    expect_error("D5-communicate 的 kind 越出闭集 → 422",
                 lambda: prepare(core, sid, [talk("a1", "violence")], "bad-kind"),
                 "INVALID_REQUEST")
    pv = prepare(core, sid, [talk("a1", "claim", content="")], "empty-claim")
    chk("D6-声明缺内容 → blocked（不冒充说过话）",
        pv["status"] == "blocked"
        and "statement_content_missing" in pv["outcome"]["resolutions"][0]["check"]["reasons"],
        str(pv["reason_codes"]))
    expect_error("D7-观察未知对象 → 澄清",
                 lambda: prepare(core, sid, [look("i1", "ghost_key")], "ghost-key"),
                 "NEEDS_CLARIFICATION")
    pv = prepare(core, sid, [look("i2", "lia")], "look-lia")
    chk("D8-观察人物不在本轮范围 → 明确 blocked（不冒充成功）",
        pv["status"] == "blocked"
        and "inspect_subject_not_observable"
            in pv["outcome"]["resolutions"][0]["check"]["reasons"], "")
    expect_error("D9-attack+kind=violence 仍硬短路（仅 kind=challenge 进六档公式）",
                 lambda: prepare(core, sid, [{
                     "id": "a1", "operation": "attack", "target_ids": ["lia"],
                     "object_id": None, "mode": "attempt", "kind": "violence"}], "atk"),
                 "UNSUPPORTED_OPERATION")
    expect_error("D10-客户端注入 delta / outcome 仍 422",
                 lambda: core.prepare_structured({
                     "session_id": sid, "event_id": "inject", "actor_id": "player",
                     "expected_versions": core.state(sid)["versions"],
                     "actions": [dict(talk("a1", "claim", content="钥匙在我这"),
                                      delta={"cellar_key.owner": "player"})]}),
                 "INVALID_REQUEST")
    pv = prepare(core, sid, [talk("a1", "question", mode="negated",
                                  content="我没问你钥匙在哪",
                                  evidence="我没问你钥匙在哪")], "neg")
    chk("D11-非尝试的询问记 skipped，不写知识也不推时钟",
        pv["status"] == "blocked" and "NOT_AN_ATTEMPT" in pv["reason_codes"]
        and pv["state_proposal"]["changes"] == [], str(pv["reason_codes"]))
    chk("D12-以上路径都没有留下残余候选或场景写入",
        entries_of(core, sid, "player") == [] and world_of(core, sid)["turn_tick"] == 0
        and core.knowledge(sid, "player")["initialized"] is True, "")


# --------------------------------------------- B1/B2 重复、回滚、旧写致 stale
def test_repeat_rollback_and_stale():
    core, P, sid = fresh("b2a-repeat")
    pv = prepare(core, sid, [talk("a1", "question", content="钥匙在哪",
                                  evidence="钥匙在哪", obj="cellar_key")], "q1")
    commit(core, sid, pv, "q1")
    replay = commit(core, sid, pv, "q1")
    w = world_of(core, sid)
    chk("E1-1 同一 event 重放幂等：不二次追加回合、不推进时钟",
        replay.get("replayed") is True and w["turn_tick"] == 1 and len(w["turns"]) == 1,
        str(replay.get("replayed")))
    chk("E1-2 重放不重复写知识",
        len(entries_of(core, sid, "player")) == 1, str(entries_of(core, sid, "player")))

    pv2 = prepare(core, sid, [talk("a1", "question", content="再说一次钥匙在哪",
                                   evidence="再说一次钥匙在哪", obj="cellar_key")], "q2")
    chk("E2-1 重复询问已知线索仍可作为一次新回合",
        pv2["status"] == "ready"
        and any(c["path"] == "interaction.turn_tick"
                for c in pv2["state_proposal"]["changes"]), str(pv2["reason_codes"]))
    rec2 = commit(core, sid, pv2, "q2")
    chk("E2-2 重复询问不制造新知识 delta（不伪装又学到了东西）",
        rec2["knowledge_gained"] == [] and world_of(core, sid)["turn_tick"] == 2
        and len(entries_of(core, sid, "player")) == 1
        and entries_of(core, sid, "player")[0]["learned_turn"] == 1,
        "tick=%s gained=%s" % (world_of(core, sid)["turn_tick"], rec2["knowledge_gained"]))

    pv3 = prepare(core, sid, [talk("a1", "claim", content="钥匙在我这",
                                   evidence="钥匙在我这")], "q3")
    before_state = copy.deepcopy(B._ACTOR_STATE)
    before_versions = core.state(sid)["versions"]
    with mock.patch.object(B, "_STATE_TRACE", _BoomTrace()):
        expect_error("E3-1 发布段异常 → 500 全回退",
                     lambda: commit(core, sid, pv3, "q3"), "INTERNAL_ERROR")
    chk("E3-2 无半提交：knowledge / 时钟 / 版本 / 事件表全回退",
        B._ACTOR_STATE == before_state
        and core.state(sid)["versions"] == before_versions
        and world_of(core, sid)["turn_tick"] == 2
        and "q3" not in (P._events.get((sid, "player")) or {}), "")
    rec3 = commit(core, sid, pv3, "q3")
    chk("E3-3 回退后候选仍可正常提交",
        rec3["status"] == "committed" and world_of(core, sid)["turn_tick"] == 3,
        "commit_id=%s" % rec3["commit_id"])

    pv4 = prepare(core, sid, [look("i1", "cellar_door")], "q4")
    tid = B.next_turn_id(sid, "lia")
    B.propose_turn(tid, sid, "lia", behavior_id="b1", intent_id="i1",
                   source="legacy", engine_used=B.ENGINE_MODE_LAYA)
    ok, note, _res = B.commit_turn(tid)
    chk("E4-1 旧路由提交成功（真实路径，改动被读实体）", ok is True, str(note)[:60])
    expect_error("E4-2 旧写使观察候选版本失效",
                 lambda: commit(core, sid, pv4, "q4"), "STATE_VERSION_CONFLICT")
    expect_error("E4-3 失效候选不可再提交",
                 lambda: commit(core, sid, pv4, "q4"), "ANALYSIS_INVALIDATED")
    chk("E4-4 失效路径没有留下任何观察知识",
        all(e["kind"] != "observation" for e in entries_of(core, sid, "player")),
        str(entries_of(core, sid, "player")))


def main():
    test_answer_chain()
    test_state_hides_private_knowledge()
    test_effective_location_visibility()
    test_clue_timeliness()
    test_disclosure_object_scoping()
    test_remote_and_out_of_sight()
    test_claim_is_not_a_fact()
    test_clarify_and_schema()
    test_repeat_rollback_and_stale()
    print("\nP2-B2a 交流与检查定向检查：%d 项，%d 失败" % (N[0], len(FAIL)))
    if FAIL:
        print("失败项：" + "、".join(FAIL))
        return 1
    print("全部通过（零模型、零云端、零 HTTP、零 Laya）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
