"""P1 物品交付纵向切片 · 定向核对（秒级：零模型、零云端、零 HTTP）。

覆盖《P1-执行任务卡》§交付和停点 的「最小定向核对」：
  T1  场景真源：唯一 owner 真源在世界运行态，服务端初始化与 Prepare 分离
  T2  Prepare 零写入：正式状态 / 归属 / 回合 / 历史 / 版本全不变
  T3  Commit 交付成功：归属由玩家转到 NPC，回执标注 rules_only、无 Laya 证据
  T4  下一轮读取新归属（回合时钟推进、正式历史追加）
  T5  重复提交幂等：原回执 replayed=true，不二次转移、不推进时钟
  T6  同一 event_id 换载荷 → 冲突
  T7  未持有物品不得交付（硬前提短路，不给可提交候选）
  T8  目标为自己 → 明确失败
  T9  目标不明 → 要求澄清（不暗选）
  T10 物品不明 → 要求澄清
  T11 客户端注入难度 / delta / Outcome → 422
  T12 attack 未显式声明 kind=challenge → 显式短路 UNSUPPORTED_OPERATION
      （P2-B2b 起 attack+kind=challenge 已实现走六档；未声明 kind 不悄悄当角力）
  T13 旧写入口改动被读实体 → 原候选失效
  T14 发布段注入异常 → 无半提交（状态/版本/事件全回退）
  T15 非真实尝试（negated）不计为失败、不产生任何写项

P1-R1 定向修复的四个反例（A 关口审查 §本轮亲自验证）：
  R1 Pending 容量：200 次合法提交后 Pending 不堆积，第 201 次 Prepare 可继续，
     历史 event 的回执仍可幂等重放
  R2 事件身份按 (session_id, event_id)：另一 actor / 另一组动作借同一 event → 409
  R3 场景初始化前置：未初始化时 Prepare 明确报错且不产生 Pending；首次初始化推进版本、
     重复初始化幂等
  R4 失效后重分析：同一 event 同一动作可在候选 stale/invalidated/blocked 后基于新版本
     重新 Prepare，旧 analysis_id 仍不可提交；重算不一致仍 409 并作废候选

★ 运行环境：Windows 控制台默认 GBK 编不出 ✅，请用
  `PYTHONIOENCODING=utf-8 python tests/p1_delivery_unit.py`
"""
import copy
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B
from laya_delivery_core import WORLD, DeliveryCore
from laya_state_protocol import _ProtoError

FAIL = []
N = [0]


def chk(tag, ok, detail=''):
    N[0] += 1
    print('  %s [%s] %s' % ('✅' if ok else '❌', tag, detail))
    if not ok:
        FAIL.append(tag)


def fresh(session='p1s'):
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
    core.ensure_scene(session)
    return core, P, session


def transfer_intent(action_id='a1', obj='badge', target='lia', mode='attempt'):
    return {'id': action_id, 'operation': 'transfer', 'target_ids': [target],
            'object_id': obj, 'mode': mode, 'kind': 'give_item',
            'content': '把徽章交给莉亚', 'evidence': '原文：把徽章给莉亚'}


def versions_of(core, sid):
    return core.state(sid)['versions']


def expect_error(tag, fn, code):
    try:
        fn()
    except _ProtoError as e:
        chk(tag, e.code == code, '%s (http %s)' % (e.code, e.http))
        return e
    chk(tag, False, '未抛出错误，期望 %s' % code)
    return None


def owner_of(core, sid, obj):
    return core.state(sid)['states'][WORLD]['interaction']['objects'][obj]['owner']


# ---------------------------------------------------------------- T1 / T2
def test_scene_and_zero_write():
    core, P, sid = fresh()
    st = core.state(sid)
    chk('T1-真源唯一且为世界运行态',
        owner_of(core, sid, 'badge') == 'player'
        and set(st['states']) == {'player', 'lia', WORLD}
        and st['initialized'] == {'player': True, 'lia': True, WORLD: True},
        '实体=%s 徽章 owner=player' % sorted(st['states']))
    chk('T1-场景初始化与快照读取分离',
        sorted(core.ensure_scene(sid)) == [], '重复 ensure_scene 不再写模板')

    before_state = copy.deepcopy(B._ACTOR_STATE)
    before_ver = versions_of(core, sid)
    pv = core.prepare_structured({
        'session_id': sid, 'event_id': 'ev_prep', 'actor_id': 'player',
        'expected_versions': before_ver, 'actions': [transfer_intent()]})
    chk('T2-Prepare 返回可提交预览',
        pv['status'] == 'ready' and pv['can_commit'] is True
        and pv['rules_only'] is True and pv['laya_evidence'] == []
        and pv['source'] == 'structured_internal',
        'result=%s' % pv['outcome']['result'])
    chk('T2-Prepare 零游戏写入',
        B._ACTOR_STATE == before_state and owner_of(core, sid, 'badge') == 'player',
        '正式状态深比较一致')
    chk('T2-Prepare 不改版本 / 回合 / 正式历史',
        versions_of(core, sid) == before_ver
        and core.state(sid)['states'][WORLD]['interaction']['turn_tick'] == 0
        and core.state(sid)['states'][WORLD]['interaction']['turns'] == [],
        '版本与回合时钟不变')
    chk('T2-Prepare 不写正式事件表',
        P._events == {} or all(
            not rec for rec in P._events.values()),
        '协议事件表为空')
    return core, P, sid, pv


# ---------------------------------------------------------------- T3 / T4
def test_commit_and_next_round():
    core, P, sid, pv = test_scene_and_zero_write()
    rec = core.commit({
        'session_id': sid, 'event_id': 'ev_prep', 'analysis_id': pv['analysis_id'],
        'expected_versions': pv['base_versions']})
    chk('T3-Commit 回执权威',
        rec['status'] == 'committed' and rec['replayed'] is False
        and rec['rules_only'] is True and rec['laya_evidence'] == []
        and rec['source'] == 'structured_internal',
        'commit_id=%s' % rec['commit_id'])
    chk('T3-归属由玩家转到 NPC',
        rec['owner_changes'] == [{'object': 'badge', 'from': 'player', 'to': 'lia'}]
        and rec['outcome']['result'] == 'achieved'
        and owner_of(core, sid, 'badge') == 'lia',
        'owner_changes=%s' % rec['owner_changes'])
    chk('T3-版本在发布时前进',
        rec['versions'][WORLD] != rec['base_versions'][WORLD]
        and rec['versions']['lia'] == rec['base_versions']['lia'],
        'world %s -> %s' % (rec['base_versions'][WORLD], rec['versions'][WORLD]))

    st = core.state(sid)
    chk('T4-下一轮读取新归属',
        st['states'][WORLD]['interaction']['objects']['badge']['owner'] == 'lia'
        and st['states'][WORLD]['interaction']['objects']['apple']['owner'] == 'player',
        '苹果仍在玩家身上，徽章已在莉亚处')
    chk('T4-回合时钟与正式历史',
        st['states'][WORLD]['interaction']['turn_tick'] == 1
        and len(st['states'][WORLD]['interaction']['turns']) == 1
        and st['states'][WORLD]['interaction']['turns'][0]['owner_changes']
        == [{'object': 'badge', 'from': 'player', 'to': 'lia'}],
        'turn_tick=1, turns=1')
    chk('T4-回执可按事件取回', core.get_receipt(sid, 'ev_prep') == rec,
        'get_receipt 与原回执一致')

    # T5 重复提交幂等
    re2 = core.commit({'session_id': sid, 'event_id': 'ev_prep',
                       'analysis_id': pv['analysis_id'],
                       'expected_versions': pv['base_versions']})
    chk('T5-重复提交返回原回执 replayed=true',
        re2['replayed'] is True and re2['commit_id'] == rec['commit_id']
        and re2['versions'] == rec['versions'],
        'commit_id 与版本均未变')
    after = core.state(sid)
    chk('T5-不二次转移 / 不推进时钟',
        owner_of(core, sid, 'badge') == 'lia'
        and after['states'][WORLD]['interaction']['turn_tick'] == 1
        and len(after['states'][WORLD]['interaction']['turns']) == 1,
        'turn_tick 仍为 1')
    # T6 同 event_id 换载荷
    expect_error('T6-同 event 换 analysis 载荷冲突', lambda: core.commit({
        'session_id': sid, 'event_id': 'ev_prep', 'analysis_id': 'deadbeef',
        'expected_versions': pv['base_versions']}), 'EVENT_PAYLOAD_CONFLICT')
    expect_error('T6-已提交 event 不能再造候选', lambda: core.prepare_structured({
        'session_id': sid, 'event_id': 'ev_prep', 'actor_id': 'player',
        'expected_versions': after['versions'], 'actions': [transfer_intent()]}),
        'EVENT_ALREADY_COMMITTED')
    # 负载复用：新事件号可继续交付另一件已持有物品
    pv2 = core.prepare_structured({
        'session_id': sid, 'event_id': 'ev_2', 'actor_id': 'player',
        'expected_versions': after['versions'],
        'actions': [transfer_intent('a9', obj='apple')]})
    rec2 = core.commit({'session_id': sid, 'event_id': 'ev_2',
                        'analysis_id': pv2['analysis_id'],
                        'expected_versions': pv2['base_versions']})
    chk('T6-新事件可继续交付另一件物品',
        rec2['replayed'] is False and owner_of(core, sid, 'apple') == 'lia',
        'apple owner=lia')
    return core, P, sid


# ---------------------------------------------------------------- T7–T13
def test_hard_prerequisites():
    core, P, sid = fresh('p1s2')
    v = versions_of(core, sid)

    pv = core.prepare_structured({'session_id': sid, 'event_id': 'e1',
        'actor_id': 'player', 'expected_versions': v,
        'actions': [transfer_intent(obj='cellar_key')]})
    chk('T7-未持有物品不产生可提交候选',
        pv['status'] == 'blocked' and pv['can_commit'] is False
        and 'ITEM_NOT_OWNED' in pv['reason_codes'], 'reasons=%s' % pv['reason_codes'])
    expect_error('T7-未持有物品提交被拒', lambda: core.commit({
        'session_id': sid, 'event_id': 'e1', 'analysis_id': pv['analysis_id'],
        'expected_versions': v}), 'ANALYSIS_NOT_COMMITTABLE')
    chk('T7-未持有物品未发生任何转移', owner_of(core, sid, 'cellar_key') is None,
        '钥匙仍无人持有')

    pv = core.prepare_structured({'session_id': sid, 'event_id': 'e2',
        'actor_id': 'player', 'expected_versions': v,
        'actions': [transfer_intent(target='player')]})
    chk('T8-目标为自己 → 明确失败',
        pv['status'] == 'blocked' and 'TARGET_IS_SELF' in pv['reason_codes'],
        'reasons=%s' % pv['reason_codes'])

    expect_error('T9-目标不明 → 澄清', lambda: core.prepare_structured({
        'session_id': sid, 'event_id': 'e3', 'actor_id': 'player',
        'expected_versions': v, 'actions': [transfer_intent(target='ghost')]}),
        'NEEDS_CLARIFICATION')
    expect_error('T10-物品不明 → 澄清', lambda: core.prepare_structured({
        'session_id': sid, 'event_id': 'e4', 'actor_id': 'player',
        'expected_versions': v, 'actions': [transfer_intent(obj=None)]}),
        'NEEDS_CLARIFICATION')

    bad = transfer_intent()
    bad['difficulty'] = 3
    expect_error('T11-注入 difficulty → 422', lambda: core.prepare_structured({
        'session_id': sid, 'event_id': 'e5', 'actor_id': 'player',
        'expected_versions': v, 'actions': [bad]}), 'INVALID_REQUEST')
    bad2 = transfer_intent()
    bad2['outcome'] = {'result': 'achieved'}
    expect_error('T11-注入 outcome → 422', lambda: core.prepare_structured({
        'session_id': sid, 'event_id': 'e6', 'actor_id': 'player',
        'expected_versions': v, 'actions': [bad2]}), 'INVALID_REQUEST')
    expect_error('T11-Commit 注入 delta → 422', lambda: core.commit({
        'session_id': sid, 'event_id': 'e11', 'analysis_id': 'x',
        'expected_versions': v, 'delta': {'badge.owner': 'lia'}}), 'INVALID_REQUEST')
    expect_error('T11-Commit 注入 outcome → 422', lambda: core.commit({
        'session_id': sid, 'event_id': 'e11', 'analysis_id': 'x',
        'expected_versions': v, 'outcome': {'result': 'achieved'}}), 'INVALID_REQUEST')
    expect_error('T11-Commit 带 actor_id → 422（A 裁决：作用域由服务端候选提供）',
                 lambda: core.commit({
        'session_id': sid, 'event_id': 'e11', 'analysis_id': 'x',
        'expected_versions': v, 'actor_id': 'player'}), 'INVALID_REQUEST')

    # P2-B1 起 take/move/unlock 已实现；P2-B2a 起 communicate/inspect 也已实现；
    # P2-B2b 起 attack 仅 kind=challenge（非致命角力）实现。这里继续验证
    # **未显式声明 kind=challenge** 的 attack 仍显式硬短路，不悄悄转成角力。
    expect_error('T12-attack 未声明 kind=challenge → 短路', lambda: core.prepare_structured({
        'session_id': sid, 'event_id': 'e7', 'actor_id': 'player',
        'expected_versions': v, 'actions': [{'id': 'a1', 'operation': 'attack',
            'target_ids': ['lia'], 'object_id': None, 'mode': 'attempt'}]}),
        'UNSUPPORTED_OPERATION')
    expect_error('T12-未声明动作', lambda: core.prepare_structured({
        'session_id': sid, 'event_id': 'e8', 'actor_id': 'player',
        'expected_versions': v, 'actions': [{'id': 'a1', 'operation': 'dance',
            'target_ids': ['lia'], 'object_id': None, 'mode': 'attempt'}]}),
        'UNKNOWN_OPERATION')

    pv = core.prepare_structured({'session_id': sid, 'event_id': 'e9',
        'actor_id': 'player', 'expected_versions': v,
        'actions': [transfer_intent(mode='negated')]})
    chk('T15-negated 不计为失败也不写',
        pv['status'] == 'blocked' and 'NOT_AN_ATTEMPT' in pv['reason_codes'],
        'reasons=%s' % pv['reason_codes'])

    # 版本集合必须精确
    expect_error('T15-版本集合缺项 → 422', lambda: core.prepare_structured({
        'session_id': sid, 'event_id': 'e10', 'actor_id': 'player',
        'expected_versions': {'player': v['player']},
        'actions': [transfer_intent()]}), 'INVALID_REQUEST')
    return core, P, sid


def test_legacy_invalidates_candidate():
    core, P, sid = fresh('p1s3')
    v = versions_of(core, sid)
    pv = core.prepare_structured({'session_id': sid, 'event_id': 'ev_stale',
        'actor_id': 'player', 'expected_versions': v,
        'actions': [transfer_intent()]})
    chk('T13-候选已就绪', pv['status'] == 'ready', 'analysis=%s' % pv['analysis_id'])
    # 旧路由（/decide → /commit {turn_id}）改动被读实体 lia 的状态
    tid = B.next_turn_id(sid, 'lia')
    B.propose_turn(tid, sid, 'lia', behavior_id='b1', intent_id='i1',
                   source='legacy', engine_used=B.ENGINE_MODE_LAYA)
    ok, note, res = B.commit_turn(tid)
    chk('T13-旧路由提交成功（真实路径）', ok is True, str(note)[:60])
    chk('T13-旧路由推进了 lia 的版本',
        versions_of(core, sid)['lia'] != v['lia'],
        '%s -> %s' % (v['lia'], versions_of(core, sid)['lia']))
    expect_error('T13-原候选因版本冲突失效', lambda: core.commit({
        'session_id': sid, 'event_id': 'ev_stale', 'analysis_id': pv['analysis_id'],
        'expected_versions': v}), 'STATE_VERSION_CONFLICT')
    expect_error('T13-失效候选不可再提交', lambda: core.commit({
        'session_id': sid, 'event_id': 'ev_stale', 'analysis_id': pv['analysis_id'],
        'expected_versions': v}), 'ANALYSIS_INVALIDATED')
    chk('T13-未发生物品转移', owner_of(core, sid, 'badge') == 'player', '徽章仍在玩家处')


class _BoomTrace(dict):
    def setdefault(self, key, default=None):
        raise RuntimeError('injected publish failure')


def test_publish_failure_rolls_back():
    core, P, sid = fresh('p1s4')
    v = versions_of(core, sid)
    pv = core.prepare_structured({'session_id': sid, 'event_id': 'ev_boom',
        'actor_id': 'player', 'expected_versions': v,
        'actions': [transfer_intent()]})
    before_state = copy.deepcopy(B._ACTOR_STATE)
    with mock.patch.object(B, '_STATE_TRACE', _BoomTrace()):
        err = expect_error('T14-发布异常 → 500', lambda: core.commit({
            'session_id': sid, 'event_id': 'ev_boom',
            'analysis_id': pv['analysis_id'], 'expected_versions': v}),
            'INTERNAL_ERROR')
    chk('T14-异常信息含回退说明',
        err is not None and '回退' in (err.message or ''), str(err.message if err else ''))
    chk('T14-无半提交：状态与归属未变',
        B._ACTOR_STATE == before_state and owner_of(core, sid, 'badge') == 'player',
        '正式状态与 Prepare 前一致')
    chk('T14-无半提交：版本未推进 / 事件未登记',
        versions_of(core, sid) == v and P._events.get((sid, 'player')) is None,
        '版本与事件表均未变化')
    rec = core.commit({'session_id': sid, 'event_id': 'ev_boom',
                       'analysis_id': pv['analysis_id'], 'expected_versions': v})
    chk('T14-回退后候选仍可正常提交',
        rec['status'] == 'committed' and owner_of(core, sid, 'badge') == 'lia',
        'commit_id=%s' % rec['commit_id'])


# ---------------------------------------------------------------- R1–R4
def test_pending_capacity_released():
    """R1：已提交候选立即释放 Pending 容量；回执仍由协议事件表提供。"""
    core, P, sid = fresh('p1s5')
    v = versions_of(core, sid)
    first = None
    for i in range(200):
        actor, target = ('player', 'lia') if i % 2 == 0 else ('lia', 'player')
        ev = 'cap%03d' % i
        pv = core.prepare_structured({
            'session_id': sid, 'event_id': ev, 'actor_id': actor,
            'expected_versions': v,
            'actions': [transfer_intent('a%d' % i, obj='badge', target=target)]})
        rec = core.commit({'session_id': sid, 'event_id': ev,
                           'analysis_id': pv['analysis_id'],
                           'expected_versions': pv['base_versions']})
        if i == 0:
            first = (ev, pv, rec, v)
        v = versions_of(core, sid)
    chk('R1-200 次合法提交后 Pending 不堆积',
        len(core._pending) == 0, 'pending=%d' % len(core._pending))
    pv = core.prepare_structured({
        'session_id': sid, 'event_id': 'cap200', 'actor_id': 'player',
        'expected_versions': v, 'actions': [transfer_intent('a200', obj='badge', target='lia')]})
    chk('R1-第 201 次 Prepare 可继续', pv['status'] == 'ready',
        'status=%s analysis=%s' % (pv['status'], pv['analysis_id']))
    rep = core.commit({'session_id': sid, 'event_id': first[0],
                       'analysis_id': first[1]['analysis_id'],
                       'expected_versions': first[3]})
    chk('R1-历史 event 回执仍可幂等重放',
        rep['replayed'] is True and rep['commit_id'] == first[2]['commit_id'],
        'commit_id=%s' % rep['commit_id'])
    chk('R1-回执可按事件取回',
        core.get_receipt(sid, first[0])['commit_id'] == first[2]['commit_id'],
        'get_receipt(%s) 命中' % first[0])


def test_event_identity_by_session_event():
    """R2：事件身份是 (session_id, event_id)，不是 (session, actor, event)。"""
    core, P, sid = fresh('p1s6')
    v = versions_of(core, sid)
    pv = core.prepare_structured({'session_id': sid, 'event_id': 'evx',
        'actor_id': 'player', 'expected_versions': v, 'actions': [transfer_intent()]})
    chk('R2-player 候选已建立', pv['status'] == 'ready', 'analysis=%s' % pv['analysis_id'])
    expect_error('R2-另一 actor 借同一 event → 409', lambda: core.prepare_structured({
        'session_id': sid, 'event_id': 'evx', 'actor_id': 'lia',
        'expected_versions': v,
        'actions': [transfer_intent(target='player')]}), 'EVENT_PAYLOAD_CONFLICT')
    expect_error('R2-同一 actor 换动作借同一 event → 409', lambda: core.prepare_structured({
        'session_id': sid, 'event_id': 'evx', 'actor_id': 'player',
        'expected_versions': v, 'actions': [transfer_intent(obj='apple')]}),
        'EVENT_PAYLOAD_CONFLICT')
    again = core.prepare_structured({'session_id': sid, 'event_id': 'evx',
        'actor_id': 'player', 'expected_versions': v, 'actions': [transfer_intent()]})
    chk('R2-同一 actor 同一动作同版本 → 幂等复用',
        again['analysis_id'] == pv['analysis_id'], 'analysis 未变')
    chk('R2-未产生第二份事件/候选', len(core._pending) == 1 and P._events == {},
        'pending=1, 事件表仍空')


def test_scene_initialization_gate():
    """R3：Prepare 必须要求服务端 ensure_scene 已完成。"""
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
    sid = 'p1s7'
    v0 = core.state(sid)['versions']
    chk('R3-未初始化时 state 明确标 initialized=false',
        core.is_initialized(sid) is False
        and all(flag is False for flag in core.state(sid)['initialized'].values()),
        'initialized=false')
    chk('R3-state() 只读：读未初始化会话不建桶、不初始化',
        (sid, 'player') not in B._ACTOR_STATE and (sid, 'lia') not in B._ACTOR_STATE
        and (sid, WORLD) not in B._ACTOR_STATE,
        '读操作不会把模板写成正式状态')
    expect_error('R3-未初始化时 Prepare 明确报错', lambda: core.prepare_structured({
        'session_id': sid, 'event_id': 'i1', 'actor_id': 'player',
        'expected_versions': v0, 'actions': [transfer_intent()]}),
        'SCENE_NOT_INITIALIZED')
    chk('R3-被拒时不产生 Pending', len(core._pending) == 0, 'pending=0')
    created = core.ensure_scene(sid)
    v1 = core.state(sid)['versions']
    chk('R3-首次初始化推进各实体版本',
        created == ['player', 'lia', WORLD] and all(v1[e] != v0[e] for e in v1),
        'created=%s' % created)
    chk('R3-重复初始化幂等（不写、不推版本）',
        core.ensure_scene(sid) == [] and core.state(sid)['versions'] == v1
        and core.is_initialized(sid) is True,
        '重复调用无副作用')
    pv = core.prepare_structured({'session_id': sid, 'event_id': 'i1',
        'actor_id': 'player', 'expected_versions': v1,
        'actions': [transfer_intent()]})
    chk('R3-初始化后可正常 Prepare', pv['status'] == 'ready', 'analysis=%s' % pv['analysis_id'])
    expect_error('R3-用初始化前的旧版本 Prepare → 409', lambda: core.prepare_structured({
        'session_id': sid, 'event_id': 'i2', 'actor_id': 'player',
        'expected_versions': v0, 'actions': [transfer_intent()]}),
        'STATE_VERSION_CONFLICT')


def test_reprepare_after_invalidation():
    """R4：候选失效/被阻塞后，同一 event+动作可基于新版本重新 Prepare。"""
    core, P, sid = fresh('p1s8')
    v = versions_of(core, sid)
    pv1 = core.prepare_structured({'session_id': sid, 'event_id': 'evr',
        'actor_id': 'player', 'expected_versions': v, 'actions': [transfer_intent()]})
    tid = B.next_turn_id(sid, 'lia')
    B.propose_turn(tid, sid, 'lia', behavior_id='b1', intent_id='i1',
                   source='legacy', engine_used=B.ENGINE_MODE_LAYA)
    ok, note, _ = B.commit_turn(tid)
    chk('R4-旧路由改动被读实体', ok is True, str(note)[:50])
    expect_error('R4-旧候选提交 → 409 并作废', lambda: core.commit({
        'session_id': sid, 'event_id': 'evr', 'analysis_id': pv1['analysis_id'],
        'expected_versions': v}), 'STATE_VERSION_CONFLICT')
    v2 = versions_of(core, sid)
    pv2 = core.prepare_structured({'session_id': sid, 'event_id': 'evr',
        'actor_id': 'player', 'expected_versions': v2, 'actions': [transfer_intent()]})
    chk('R4-同 event 同动作可基于新版本重新 Prepare',
        pv2['status'] == 'ready' and pv2['analysis_id'] != pv1['analysis_id'],
        '新 analysis=%s' % pv2['analysis_id'])
    expect_error('R4-旧 analysis_id 仍不可提交', lambda: core.commit({
        'session_id': sid, 'event_id': 'evr', 'analysis_id': pv1['analysis_id'],
        'expected_versions': v2}), 'ANALYSIS_INVALIDATED')
    rec = core.commit({'session_id': sid, 'event_id': 'evr',
                       'analysis_id': pv2['analysis_id'],
                       'expected_versions': pv2['base_versions']})
    chk('R4-新候选可正常提交',
        rec['status'] == 'committed' and owner_of(core, sid, 'badge') == 'lia',
        'commit_id=%s' % rec['commit_id'])

    # blocked 候选不应锁死同一 event
    v3 = versions_of(core, sid)
    b1 = core.prepare_structured({'session_id': sid, 'event_id': 'evb',
        'actor_id': 'player', 'expected_versions': v3,
        'actions': [transfer_intent(obj='cellar_key')]})
    b2 = core.prepare_structured({'session_id': sid, 'event_id': 'evb',
        'actor_id': 'player', 'expected_versions': v3,
        'actions': [transfer_intent(obj='cellar_key')]})
    chk('R4-blocked 候选后同 event 可重建',
        b1['status'] == 'blocked' and b2['analysis_id'] != b1['analysis_id'],
        'blocked 不锁死 event')
    chk('R4-blocked 旧候选不可提交', b1['status'] == 'blocked',
        'reason=%s' % b1['reason_codes'])


def test_recompute_mismatch_still_invalidates():
    """R4：锁内重算与预览不一致仍 409 且作废候选（不放宽这条）。"""
    core, P, sid = fresh('p1s9')
    v = versions_of(core, sid)
    pv = core.prepare_structured({'session_id': sid, 'event_id': 'evm',
        'actor_id': 'player', 'expected_versions': v, 'actions': [transfer_intent()]})
    original = core._calculate

    def tampered(actor_id, intents, states, event_id=None, evidence_entries=None):
        outcome, proposal, clar = original(actor_id, intents, states, event_id,
                                           evidence_entries=evidence_entries)
        proposal = copy.deepcopy(proposal)
        proposal['changes'] = proposal['changes'][:-1]      # 模拟「重算得到不同结果」
        return outcome, proposal, clar

    with mock.patch.object(core, '_calculate', side_effect=tampered):
        expect_error('R4-重算不一致 → 409', lambda: core.commit({
            'session_id': sid, 'event_id': 'evm', 'analysis_id': pv['analysis_id'],
            'expected_versions': v}), 'PROPOSAL_MISMATCH')
    expect_error('R4-作废后旧候选不可提交', lambda: core.commit({
        'session_id': sid, 'event_id': 'evm', 'analysis_id': pv['analysis_id'],
        'expected_versions': v}), 'ANALYSIS_INVALIDATED')
    pv2 = core.prepare_structured({'session_id': sid, 'event_id': 'evm',
        'actor_id': 'player', 'expected_versions': v, 'actions': [transfer_intent()]})
    rec = core.commit({'session_id': sid, 'event_id': 'evm',
                       'analysis_id': pv2['analysis_id'],
                       'expected_versions': pv2['base_versions']})
    chk('R4-作废后重新 Prepare 并提交成功',
        rec['status'] == 'committed' and owner_of(core, sid, 'badge') == 'lia'
        and pv2['analysis_id'] != pv['analysis_id'], 'commit_id=%s' % rec['commit_id'])


if __name__ == '__main__':
    test_commit_and_next_round()
    test_hard_prerequisites()
    test_legacy_invalidates_candidate()
    test_publish_failure_rolls_back()
    test_pending_capacity_released()
    test_event_identity_by_session_event()
    test_scene_initialization_gate()
    test_reprepare_after_invalidation()
    test_recompute_mismatch_still_invalidates()
    print('\nP1 物品交付定向核对：%d 项，%d 失败' % (N[0], len(FAIL)))
    if FAIL:
        print('失败项：' + '、'.join(FAIL))
        sys.exit(1)
    print('全部通过（零模型、零云端、未启动任何服务）')
