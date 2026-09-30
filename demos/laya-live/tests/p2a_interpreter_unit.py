"""P2-A 自由语义解释 · 定向检查（秒级：零模型、零云端、零 HTTP）。

先用**固定返回的假云端响应**验证 schema、证据、实体映射、条件与失败路径；真实
DeepSeek 调用在 `p2a_interpret_trace.py` 里单独做（最多 3 次），本文件不联网。

覆盖《P2-A 自由语义解释》§必须覆盖的输入：
  S1  schema 与实体映射（ID 只从服务端目录来）
  S2  多动作顺序与条件（“拿到钥匙就开门” → depends_on / when）
  S3  已提交历史指代（“把它给她”）与不唯一时的澄清
  S4  模型自报歧义 / 代词无法唯一解析 → needs_clarification
  S5  否定、假设、引用不执行（mode 透传，交 P1 核心记 skipped）
  S6  隐喻威胁只作交流（attack → communicate 强制纠偏）
  S7  “我已经把钥匙给你了”只是声明，不是 transfer、不改归属（B2a 起核心接管为声明事件）
  S8  未知动作显式 unsupported / bad_operation
  S9  伪造实体引用（目录外提及）→ invalid
  S10 模型输出禁字段（difficulty/delta/outcome/degree/confidence…）→ invalid
  S11 evidence 非原话子串 → invalid
  S12 依赖非法（指向更晚/不存在/自环）、when 非法 → invalid
  S13 云端失败路径（无 key/401/超时/坏 JSON/超量/空消息）→ invalid，fail-closed
  S14 interpret_turn → prepare_structured → commit 端到端（零模型）
  S15 目录构造要求场景已初始化
  S16 解释阶段零游戏写入
  S17 P2-A → P2-B1 条件动作真实场景集成

★ 运行环境：Windows 控制台默认 GBK 编不出 ✅，请用
  `PYTHONIOENCODING=utf-8 python tests/p2a_interpreter_unit.py`
"""
import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B
import laya_delivery_interpreter as I
from laya_delivery_core import WORLD, DeliveryCore
from laya_state_protocol import _ProtoError

FAIL = []
N = [0]


def chk(tag, ok, detail=''):
    N[0] += 1
    print('  %s [%s] %s' % ('✅' if ok else '❌', tag, detail))
    if not ok:
        FAIL.append(tag)


def fake(payload):
    """固定返回的假云端 caller。payload 可以是 dict（自动转 JSON）或字符串。"""
    raw = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)

    def caller(system, user):
        caller.last_prompt = (system, user)
        return raw, None
    return caller


def failing(err):
    return lambda system, user: (None, err)


def expect_error(tag, fn, code):
    try:
        fn()
    except (I.InterpretError, _ProtoError) as e:
        got = getattr(e, 'code', None) or getattr(e, 'reason', None)
        chk(tag, got == code, '%s' % got)
        return e
    chk(tag, False, '未抛出错误，期望 %s' % code)
    return None


def fresh(session='p2a'):
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


def interp(core, sid, message, payload, history=(), actor_id='player'):
    d = I.build_entity_directory(core, sid)
    return I.interpret(message, directory=d, actor_id=actor_id,
                       history=history, caller=fake(payload)), d


def all_ids_in_directory(dir_ids, action):
    return set(action['target_ids']) | ({action['object_id']} if action['object_id'] else set())


# ---------------------------------------------------------------- S1
def test_schema_and_mapping():
    core, P, sid = fresh()
    out, d = interp(core, sid, '把徽章交给莉亚', {
        'actions': [{'kind': 'give_item', 'operation': 'transfer', 'targets': ['莉亚'],
                     'object': '徽章', 'evidence': ['把徽章交给莉亚']}]})
    a = out['actions'][0]
    chk('S1-ready 且动作字段齐全',
        out['status'] == 'ready' and a['id'] == 'act1' and a['operation'] == 'transfer'
        and a['kind'] == 'give_item' and a['mode'] == 'attempt'
        and a['target_ids'] == ['lia'] and a['object_id'] == 'badge',
        'target=%s object=%s' % (a['target_ids'], a['object_id']))
    chk('S1-evidence 逐字保留', a['evidence'] == '把徽章交给莉亚' and a['content'] == a['evidence'],
        a['evidence'])
    chk('S1-实体 ID 全部来自服务端目录',
        all_ids_in_directory(I.entity_ids(d), a) <= I.entity_ids(d),
        '目录实体=%s' % sorted(I.entity_ids(d)))
    chk('S1-无 depends_on/when 时不产生多余字段',
        a['depends_on'] is None and a['when'] == 'always', '默认 always')
    req = I.to_prepare_request(out, sid, 'ev1', d['versions'])
    chk('S1-P1 投影字段与 P1 核心白名单一致',
        set(req['actions'][0]) == {'id', 'operation', 'target_ids', 'object_id',
                                   'mode', 'kind', 'content', 'evidence'},
        sorted(req['actions'][0]))
    # 别名与英文名同样只映射到目录 ID
    out2, _ = interp(core, sid, 'give the badge to Lia', {
        'actions': [{'kind': 'give_item', 'operation': 'transfer', 'targets': ['Lia'],
                     'object': 'badge', 'evidence': ['give the badge to Lia']}]})
    chk('S1-英文名/ID 别名同样映射到目录 ID',
        out2['status'] == 'ready' and out2['actions'][0]['target_ids'] == ['lia']
        and out2['actions'][0]['object_id'] == 'badge', 'Lia/badge → lia/badge')
    return core, P, sid


# ---------------------------------------------------------------- S2
def synth_directory_with_door(core, sid):
    """为隔离解释层映射构造副本；端到端集成使用真实服务端场景目录。"""
    d = copy.deepcopy(I.build_entity_directory(core, sid))
    d['objects']['cellar_door'] = {'id': 'cellar_door', 'name': '地窖门', 'kind': 'door',
                                   'location': 'tavern', 'owner': None,
                                   'mentions': ['地窖门', '门']}
    return d


def test_multi_action_conditions():
    core, P, sid = fresh('p2a2')
    # S2a：接口规定的标准输入「拿到钥匙就开门」（门来自合成目录，见上方说明）
    d_syn = synth_directory_with_door(core, sid)
    out = I.interpret('拿到钥匙就开门', directory=d_syn, caller=fake({
        'actions': [
            {'kind': 'take', 'operation': 'take', 'targets': ['钥匙'], 'object': '钥匙',
             'evidence': ['拿到钥匙']},
            {'kind': 'unlock', 'operation': 'unlock', 'targets': ['门'], 'object': '门',
             'evidence': ['就开门'], 'depends_on': 0, 'when': 'if_achieved'}]}))
    a1, a2 = out['actions']
    chk('S2a-两动作按表达顺序，条件指向更早动作',
        out['status'] == 'ready' and len(out['actions']) == 2
        and a1['object_id'] == 'cellar_key' and a2['operation'] == 'unlock'
        and a2['object_id'] == 'cellar_door' and a2['depends_on'] == 'act1'
        and a2['when'] == 'if_achieved',
        '%s ← depends_on %s/%s' % (a2['object_id'], a2['depends_on'], a2['when']))
    full = I.to_prepare_intents(out, p1_projection=False)
    chk('S2a-非投影保留 depends_on/when',
        full[1]['depends_on'] == 'act1' and full[1]['when'] == 'if_achieved', 'P2 字段保留')
    expect_error('S2a-投影到 P1 核心时拒绝丢条件',
                 lambda: I.to_prepare_intents(out, p1_projection=True),
                 'conditional_action_needs_p2b1_core')

    # S2b：融合后的真实场景目录包含 cellar_door，解释结果应引用目录实体。
    out_b, _ = interp(core, sid, '拿到钥匙就开门', {
        'actions': [
            {'kind': 'take', 'operation': 'take', 'object': '钥匙', 'evidence': ['拿到钥匙']},
            {'kind': 'unlock', 'operation': 'unlock', 'object': '门', 'evidence': ['就开门'],
             'depends_on': 0, 'when': 'if_achieved'}]})
    chk('S2b-真实场景目录含地窖门并成功映射',
        'cellar_door' in I.entity_ids(I.build_entity_directory(core, sid))
        and out_b['status'] == 'ready'
        and out_b['actions'][1]['object_id'] == 'cellar_door',
        str(out_b.get('invalid_detail') or out_b['actions'][1]['object_id']))

    # S2c：条件链用本树已存在的实体表达 → 逐字可用
    out_c, d_c = interp(core, sid, '拿到钥匙就把它交给莉亚', {
        'actions': [
            {'kind': 'take', 'operation': 'take', 'object': '钥匙', 'evidence': ['拿到钥匙']},
            {'kind': 'give_item', 'operation': 'transfer', 'targets': ['莉亚'], 'object': '它',
             'evidence': ['就把它交给莉亚'], 'depends_on': 0, 'when': 'if_achieved'}]})
    chk('S2c-同轮前置动作的代词消解（它→钥匙）+ 条件',
        out_c['status'] == 'ready' and out_c['actions'][1]['object_id'] == 'cellar_key'
        and out_c['actions'][1]['depends_on'] == 'act1'
        and out_c['actions'][1]['when'] == 'if_achieved'
        and out_c['actions'][1]['target_ids'] == ['lia'],
        'act2 object=%s' % out_c['actions'][1]['object_id'])
    cond_before = copy.deepcopy(B._ACTOR_STATE)
    cond_pv = core.prepare_structured(I.to_prepare_request(
        out_c, sid, 'ev_cond', d_c['versions'], p1_projection=False))
    chk('S2c-条件请求进入 B1 核心且 Prepare 零游戏写',
        cond_pv['status'] == 'blocked'
        and B._ACTOR_STATE == cond_before
        and cond_pv['outcome']['resolutions'][0]['execution_status'] == 'blocked'
        and cond_pv['outcome']['resolutions'][1]['execution_status'] == 'skipped'
        and cond_pv['outcome']['resolutions'][1]['degree'] is None,
        repr(cond_pv['outcome']['resolutions']))
    conditional = I.interpret_turn(core, sid, '拿到钥匙就把它交给莉亚', event_id='ev_cond_turn',
                                   caller=fake({'actions': [
                                       {'kind': 'take', 'operation': 'take', 'object': '钥匙',
                                        'evidence': ['拿到钥匙']},
                                       {'kind': 'give_item', 'operation': 'transfer',
                                        'targets': ['莉亚'], 'object': '它',
                                        'evidence': ['就把它交给莉亚'], 'depends_on': 0,
                                        'when': 'if_achieved'}]}))
    chk('S2c-interpret_turn 默认保留 P2 条件字段',
        conditional['prepare_error'] is None
        and conditional['prepare_request']['actions'][1]['depends_on'] == 'act1'
        and conditional['prepare_request']['actions'][1]['when'] == 'if_achieved',
        str(conditional['prepare_error']))
    legacy = I.interpret_turn(core, sid, '拿到钥匙就把它交给莉亚', event_id='ev_cond_p1',
                              p1_projection=True, caller=fake({'actions': [
                                  {'kind': 'take', 'operation': 'take', 'object': '钥匙',
                                   'evidence': ['拿到钥匙']},
                                  {'kind': 'give_item', 'operation': 'transfer',
                                   'targets': ['莉亚'], 'object': '它',
                                   'evidence': ['就把它交给莉亚'], 'depends_on': 0,
                                   'when': 'if_achieved'}]}))
    chk('S2c-显式 P1 投影仍拒绝静默丢条件',
        legacy['prepare_request'] is None
        and legacy['prepare_error']['reason'] == 'conditional_action_needs_p2b1_core',
        str(legacy['prepare_error']))
    return core, P, sid


# ---------------------------------------------------------------- S3 / S4
def test_reference_and_clarification():
    core, P, sid = fresh('p2a3')
    hist = [{'commit_id': 'dl_x', 'event_id': 'ev0', 'result': 'achieved',
             'owner_changes': [{'object': 'badge', 'from': 'player', 'to': 'lia'}]}]
    out, _ = interp(core, sid, '把它给她', {
        'actions': [{'kind': 'give_item', 'operation': 'transfer', 'targets': ['她'],
                     'object': '它', 'evidence': ['把它给她']}]}, history=hist)
    chk('S3-历史指代解析：它→徽章、她→莉亚',
        out['status'] == 'ready' and out['actions'][0]['object_id'] == 'badge'
        and out['actions'][0]['target_ids'] == ['lia'],
        'object=%s target=%s' % (out['actions'][0]['object_id'], out['actions'][0]['target_ids']))

    out2, _ = interp(core, sid, '把它给她', {
        'actions': [{'kind': 'give_item', 'operation': 'transfer', 'targets': ['她'],
                     'object': '它', 'evidence': ['把它给她']}]}, history=())
    chk('S4-物品不唯一 → 澄清且列出候选',
        out2['status'] == 'needs_clarification' and out2['actions'] == []
        and out2['partial_actions'][0]['target_ids'] == ['lia']
        and out2['ambiguities'][0]['reason'] == 'ambiguous_pronoun_object'
        and sorted(out2['ambiguities'][0]['candidates']) == ['apple', 'badge'],
        'actions 置空、诊断走 partial_actions；candidates=%s'
        % (out2['ambiguities'][0]['candidates'] if out2['ambiguities'] else None))
    expect_error('S4-澄清结果不可送 Prepare',
                 lambda: I.to_prepare_intents(out2), 'not_ready')

    d = I.build_entity_directory(core, sid)
    d2 = copy.deepcopy(d)
    d2['actors']['oren'] = {'id': 'oren', 'name': '奥伦', 'mentions': ['奥伦', 'Oren'],
                            'location': 'tavern'}
    out3 = I.interpret('把它给她', directory=d2, caller=fake({
        'actions': [{'kind': 'give_item', 'operation': 'transfer', 'targets': ['她'],
                     'object': '它', 'evidence': ['把它给她']}]}),
                     history=[{'owner_changes': [{'object': 'badge'}]}])
    chk('S4-两个非行动者时第三人称代词 → 澄清',
        out3['status'] == 'needs_clarification'
        and out3['ambiguities'][0]['reason'] == 'ambiguous_pronoun_person'
        and sorted(out3['ambiguities'][0]['candidates']) == ['lia', 'oren'],
        'candidates=%s' % out3['ambiguities'][0]['candidates'])

    out4, _ = interp(core, sid, '把那个东西给她', {
        'actions': [{'kind': 'give_item', 'operation': 'transfer', 'targets': ['她'],
                     'object': None, 'evidence': ['把那个东西给她']}],
        'ambiguities': [{'mention': '那个东西', 'reason': '多个候选'}]})
    chk('S4-模型自报歧义同样返回澄清', out4['status'] == 'needs_clarification'
        and out4['ambiguities'][0]['mention'] == '那个东西', 'model_reported')
    return core, P, sid


# ---------------------------------------------------------------- S5 / S6 / S7
def test_modes_threat_and_claim():
    core, P, sid = fresh('p2a4')
    out, d = interp(core, sid, '我不会把徽章给你，如果我有苹果我就把苹果交给莉亚，他昨天说过“把徽章给我”', {
        'actions': [
            {'kind': 'give_item', 'operation': 'transfer', 'targets': ['你'], 'object': '徽章',
             'mode': 'negated', 'evidence': ['我不会把徽章给你']},
            {'kind': 'give_item', 'operation': 'transfer', 'targets': ['莉亚'], 'object': '苹果',
             'mode': 'hypothetical', 'evidence': ['如果我有苹果我就把苹果交给莉亚']},
            {'kind': 'give_item', 'operation': 'transfer', 'targets': ['我'], 'object': '徽章',
             'mode': 'quoted', 'evidence': ['他昨天说过“把徽章给我”']}]})
    chk('S5-三种非尝试模式逐条透传',
        out['status'] == 'ready' and [a['mode'] for a in out['actions']]
        == ['negated', 'hypothetical', 'quoted']
        and out['actions'][1]['object_id'] == 'apple'
        and out['actions'][2]['target_ids'] == ['player'],
        'modes=%s' % [a['mode'] for a in out['actions']])
    req = I.to_prepare_request(out, sid, 'ev_modes', d['versions'])
    pv = core.prepare_structured(req)
    chk('S5-非尝试动作在 P1 核心记 skipped、不产生写项',
        pv['status'] == 'blocked' and 'NOT_AN_ATTEMPT' in pv['reason_codes'],
        'reason=%s' % pv['reason_codes'])
    expect_error('S5-非尝试动作不可提交', lambda: core.commit({
        'session_id': sid, 'event_id': 'ev_modes', 'analysis_id': pv['analysis_id'],
        'expected_versions': pv['base_versions']}), 'ANALYSIS_NOT_COMMITTABLE')

    out2, _ = interp(core, sid, '你最好祈祷太阳明天还升得起来', {
        'actions': [{'kind': 'threat', 'operation': 'attack', 'targets': [],
                     'object': None, 'evidence': ['你最好祈祷太阳明天还升得起来']}]})
    chk('S6-隐喻威胁被纠正为交流，不落成攻击',
        out2['status'] == 'ready' and out2['actions'][0]['operation'] == 'communicate'
        and out2['actions'][0]['kind'] == 'threat'
        and out2['coercions'][0]['from'] == 'attack', 'coercion=%s' % out2['coercions'])

    out3, d3 = interp(core, sid, '我已经把钥匙给你了', {
        'actions': [{'kind': 'claim', 'operation': 'communicate', 'targets': ['你'],
                     'object': '钥匙', 'evidence': ['我已经把钥匙给你了']}]})
    chk('S7-声明只作交流', out3['status'] == 'ready'
        and out3['actions'][0]['operation'] == 'communicate'
        and out3['actions'][0]['kind'] == 'claim', 'communicate/claim')
    req3 = I.to_prepare_request(out3, sid, 'ev_claim', d3['versions'])
    # P2-B2a 起核心已接管 communicate：声明必须落成「带说话者/听者的声明事件」，
    # 既不能退化成 transfer、也不能改归属 —— 比原来「只能 unsupported」的断言更强。
    pv3 = core.prepare_structured(req3)
    chk('S7-声明落成交流回合（不是 transfer、写项不含归属/门/位置）',
        pv3['status'] == 'ready'
        and [a['operation'] for a in out3['actions']] == ['communicate']
        and sorted({c['path'] for c in pv3['state_proposal']['changes']})
        == ['interaction.knowledge', 'interaction.turn_tick'],
        'state=%s reasons=%s' % (pv3['status'], pv3['reason_codes']))
    rec3 = core.commit({'session_id': sid, 'event_id': 'ev_claim',
                        'analysis_id': pv3['analysis_id'],
                        'expected_versions': pv3['base_versions']})
    world3 = core.state(sid)['states'][WORLD]['interaction']
    chk('S7-声明不写归属/客观事实，只在发言者与听者留 asserted_by 的 statement',
        world3['objects']['cellar_key']['owner'] is None
        and world3['facts'] == []
        and rec3['acts'] == [{'type': 'communicate', 'sub_kind': 'statement',
                              'kind': 'claim', 'speaker': 'player', 'listener': 'lia',
                              'visibility': 'participants'}]
        and [e['kind'] for e in core.knowledge(sid, 'player')['entries']] == ['statement']
        and all(e['asserted_by'] == 'player' and e['objective'] is False
                for e in core.knowledge(sid, 'lia')['entries'] if e['kind'] == 'statement'),
        'communicate/claim → 声明事件，钥匙 owner=None')
    return core, P, sid


# ---------------------------------------------------------------- S8–S13
def test_rejections():
    core, P, sid = fresh('p2a5')
    out, d = interp(core, sid, '偷走他的钱袋', {
        'actions': [{'kind': 'give_item', 'operation': 'other',
                     'other_operation': 'steal', 'targets': ['莉亚'], 'object': None,
                     'evidence': ['偷走他的钱袋']}]})
    chk('S8-未知动作显式 unsupported（不冒充成功）',
        out['status'] == 'unsupported' and out['unsupported'][0]['operation'] == 'steal'
        and out['actions'] == [], 'unsupported=%s' % out['unsupported'])
    expect_error('S8-unsupported 不可送 Prepare',
                 lambda: I.to_prepare_intents(out), 'not_ready')
    out2, _ = interp(core, sid, '跳舞', {
        'actions': [{'kind': 'neutral', 'operation': 'dance', 'evidence': ['跳舞']}]})
    chk('S8-闭集外 operation → invalid',
        out2['status'] == 'invalid' and out2['invalid_reason'] == 'bad_operation',
        out2['invalid_reason'])

    out3, _ = interp(core, sid, '把水晶球给她', {
        'actions': [{'kind': 'give_item', 'operation': 'transfer', 'targets': ['她'],
                     'object': '水晶球', 'evidence': ['把水晶球给她']}]})
    chk('S9-目录外实体（伪造目标/物品）→ invalid',
        out3['status'] == 'invalid' and out3['invalid_reason'] == 'entity_not_in_directory'
        and out3['invalid_detail']['mention'] == '水晶球',
        '%s %s' % (out3['invalid_reason'], out3['invalid_detail']))
    invented_existing = I.interpret('把徽章交给她', directory=d, caller=fake({
        'actions': [{'kind': 'give_item', 'operation': 'transfer', 'targets': ['莉亚'],
                     'object': '徽章', 'evidence': ['把徽章交给她']}]}))
    chk('S9-场景存在但原话未提及的实体不能由模型补入',
        invented_existing['status'] == 'invalid'
        and invented_existing['invalid_reason'] == 'entity_not_mentioned'
        and invented_existing['invalid_detail']['mention'] == '莉亚',
        '%s %s' % (invented_existing['invalid_reason'], invented_existing['invalid_detail']))

    for field, value in (('difficulty', 3), ('delta', {'owner': 'lia'}), ('outcome', 'achieved'),
                         ('degree', 'success'), ('confidence', 0.9), ('owner', 'lia')):
        o, _ = interp(core, sid, '把徽章交给莉亚', {
            'actions': [{'kind': 'give_item', 'operation': 'transfer', 'targets': ['莉亚'],
                         'object': '徽章', 'evidence': ['把徽章交给莉亚'], field: value}]})
        chk('S10-拒绝模型输出字段 %s' % field,
            o['status'] == 'invalid' and o['invalid_reason'] == 'forbidden_field'
            and field in o['invalid_detail']['fields'], o['invalid_detail'])
    o, _ = interp(core, sid, '把徽章交给莉亚', {
        'actions': [{'kind': 'give_item', 'operation': 'transfer', 'targets': ['莉亚'],
                     'object': '徽章', 'evidence': ['把徽章交给莉亚'], 'note': 'x'}]})
    chk('S10-未声明字段同样拒绝', o['status'] == 'invalid'
        and o['invalid_reason'] == 'unknown_field', o['invalid_detail'])

    o, _ = interp(core, sid, '把徽章交给莉亚', {
        'actions': [{'kind': 'give_item', 'operation': 'transfer', 'targets': ['莉亚'],
                     'object': '徽章', 'evidence': ['徽章归你了']}]})
    chk('S11-evidence 非原话子串 → invalid',
        o['status'] == 'invalid' and o['invalid_reason'] == 'evidence_not_verbatim',
        o['invalid_reason'])
    first_evidence_missing_target = I.interpret('把徽章交给莉亚', directory=d, caller=fake({
        'actions': [{'kind': 'give_item', 'operation': 'transfer', 'targets': ['莉亚'],
                     'object': '徽章', 'evidence': ['把徽章交给你', '交给莉亚']}] }))
    chk('S11-第一段 evidence 缺目标时拒绝后段补证',
        first_evidence_missing_target['status'] == 'invalid'
        and first_evidence_missing_target['invalid_reason'] == 'mention_missing_from_evidence',
        first_evidence_missing_target.get('invalid_reason'))
    o, _ = interp(core, sid, '把徽章交给莉亚', {
        'actions': [{'kind': 'give_item', 'operation': 'transfer', 'targets': ['莉亚'],
                     'object': '徽章', 'evidence': []}]})
    chk('S11-缺逐字证据 → invalid',
        o['status'] == 'invalid' and o['invalid_reason'] == 'evidence_not_verbatim',
        o['invalid_reason'])

    o, _ = interp(core, sid, '我已经把徽章给你了', {
        'actions': [{'kind': 'claim', 'operation': 'transfer', 'targets': ['你'],
                     'object': '徽章', 'evidence': ['把徽章给你']}]})
    chk('S7-claim + transfer 语义冲突不能成为物理转移',
        o['status'] == 'invalid' and o['invalid_reason'] == 'kind_operation_mismatch',
        o['invalid_reason'])
    claim_take = I.interpret('我已经拿到钥匙了', directory=d, caller=fake({
        'actions': [{'kind': 'claim', 'operation': 'take', 'object': '钥匙',
                     'evidence': ['我已经拿到钥匙了']}] }))
    chk('S7-claim + take 声明不能成为物理动作',
        claim_take['status'] == 'invalid'
        and claim_take['invalid_reason'] == 'kind_operation_mismatch',
        claim_take.get('invalid_reason'))

    o, _ = interp(core, sid, '拿到钥匙就把它交给莉亚', {
        'actions': [
            {'kind': 'take', 'operation': 'take', 'object': '钥匙', 'evidence': ['拿到钥匙'],
             'depends_on': 1},
            {'kind': 'give_item', 'operation': 'transfer', 'targets': ['莉亚'], 'object': '它',
             'evidence': ['就把它交给莉亚']}]})
    chk('S12-依赖指向更晚/自环 → invalid',
        o['status'] == 'invalid' and o['invalid_reason'] == 'bad_dependency', o['invalid_detail'])
    o, _ = interp(core, sid, '拿到钥匙就把它交给莉亚', {
        'actions': [
            {'kind': 'take', 'operation': 'take', 'object': '钥匙', 'evidence': ['拿到钥匙']},
            {'kind': 'give_item', 'operation': 'transfer', 'targets': ['莉亚'], 'object': '它',
             'evidence': ['就把它交给莉亚'], 'depends_on': 0, 'when': 'sometimes'}]})
    chk('S12-when 非法 → invalid',
        o['status'] == 'invalid' and o['invalid_reason'] == 'bad_when', o['invalid_detail'])
    o, _ = interp(core, sid, '拿到钥匙就把它交给莉亚', {
        'actions': [
            {'kind': 'take', 'operation': 'take', 'object': '钥匙', 'evidence': ['拿到钥匙']},
            {'kind': 'give_item', 'operation': 'transfer', 'targets': ['莉亚'], 'object': '它',
             'evidence': ['就把它交给莉亚'], 'when': 'if_achieved'}]})
    chk('S12-无依赖时条件被归一为 always',
        o['status'] == 'ready' and o['actions'][1]['when'] == 'always', 'always')

    d = I.build_entity_directory(core, sid)
    o = I.interpret('把徽章交给莉亚', directory=d, caller=failing('http_401'))
    chk('S13-云端 401 → invalid 且 fail-closed',
        o['status'] == 'invalid' and o['invalid_reason'] == 'cloud_http_401'
        and o['actions'] == [], o['invalid_reason'])
    o = I.interpret('把徽章交给莉亚', directory=d, caller=failing('no_api_key'))
    chk('S13-无 key → invalid', o['invalid_reason'] == 'cloud_no_api_key', o['invalid_reason'])
    for raw, reason in (('不是 JSON', 'json_parse'), ('{}', 'actions_not_list'),
                        ('[]', 'not_object'), ('', 'empty')):
        o = I.interpret('把徽章交给莉亚', directory=d, caller=fake(raw))
        chk('S13-坏输出 %r → invalid(%s)' % (raw[:8], reason),
            o['status'] == 'invalid' and o['invalid_reason'] == reason, o['invalid_reason'])
    many = {'actions': [{'kind': 'neutral', 'operation': 'communicate', 'evidence': ['把徽章交给莉亚']}] * 9}
    o = I.interpret('把徽章交给莉亚', directory=d, caller=fake(many))
    chk('S13-超过 8 个动作 → invalid',
        o['invalid_reason'] == 'too_many_actions', o['invalid_reason'])
    o = I.interpret('   ', directory=d, caller=fake({}))
    chk('S13-空玩家输入 → invalid', o['invalid_reason'] == 'empty_message', o['invalid_reason'])
    o = I.interpret('把徽章交给莉亚', directory=d, caller=fake('```json\n{"actions":[]}\n```'))
    chk('S13-空 actions 列表 → invalid', o['invalid_reason'] == 'actions_not_list',
        o['invalid_reason'])
    return core, P, sid


# ---------------------------------------------------------------- S14–S16
def test_end_to_end_and_readonly():
    core, P, sid = fresh('p2a6')
    before = copy.deepcopy(B._ACTOR_STATE)
    res = I.interpret_turn(core, sid, '把徽章交给莉亚', event_id='ev_e2e',
                           p1_projection=True,
                           caller=fake({'actions': [
                               {'kind': 'give_item', 'operation': 'transfer',
                                'targets': ['莉亚'], 'object': '徽章',
                                'evidence': ['把徽章交给莉亚']}]}))
    chk('S16-解释阶段零游戏写入',
        B._ACTOR_STATE == before, '正式状态深比较一致')
    chk('S14-interpret_turn 产出 Prepare 请求',
        res['interpretation']['status'] == 'ready' and res['prepare_error'] is None
        and res['prepare_request']['actor_id'] == 'player'
        and res['prepare_request']['expected_versions'] == res['directory']['versions'],
        'actions=%d' % len(res['prepare_request']['actions']))
    pv = core.prepare_structured(res['prepare_request'])
    rec = core.commit({'session_id': sid, 'event_id': 'ev_e2e',
                       'analysis_id': pv['analysis_id'],
                       'expected_versions': pv['base_versions']})
    chk('S14-端到端：原文 → 意图 → Prepare → Commit → 新归属',
        rec['status'] == 'committed' and rec['owner_changes'] == [
            {'object': 'badge', 'from': 'player', 'to': 'lia'}]
        and core.state(sid)['states'][WORLD]['interaction']['objects']['badge']['owner'] == 'lia',
        'commit_id=%s' % rec['commit_id'])
    chk('S14-解释来源标注（未用云端时明确标 injected）',
        res['interpretation']['source']['caller'] == 'injected'
        and res['interpretation']['source']['model'] is None
        and res['interpretation']['source']['directory_fingerprint'],
        'source=%s' % res['interpretation']['source'])

    B.reset_actor_state()
    core2 = DeliveryCore(B, protocol=P)
    expect_error('S15-目录构造要求场景已初始化',
                 lambda: I.build_entity_directory(core2, 'uninit_sess'),
                 'scene_not_initialized')
    return core, P, sid


def test_p2_condition_chain_integration():
    """固定解释响应穿过真实目录、B1 Prepare/Commit，并验证下一轮可读。"""
    core, P, sid = fresh('p2a-b1-chain')
    message = '先去老井拿钥匙，再去酒馆打开地窖门'
    response = {'actions': [
        {'kind': 'move', 'operation': 'move', 'targets': ['老井'],
         'evidence': ['去老井']},
        {'kind': 'take', 'operation': 'take', 'object': '钥匙',
         'evidence': ['拿钥匙'], 'depends_on': 0, 'when': 'if_achieved'},
        {'kind': 'move', 'operation': 'move', 'targets': ['酒馆'],
         'evidence': ['去酒馆'], 'depends_on': 1, 'when': 'if_achieved'},
        {'kind': 'unlock', 'operation': 'unlock', 'object': '地窖门',
         'evidence': ['打开地窖门'], 'depends_on': 2, 'when': 'if_achieved'},
    ]}
    before = copy.deepcopy(B._ACTOR_STATE)
    interpreted = I.interpret_turn(core, sid, message, event_id='ev_p2_chain',
                                   caller=fake(response))
    chk('S17-真实目录解释完整条件链且 Prepare 请求可用',
        interpreted['interpretation']['status'] == 'ready'
        and interpreted['prepare_error'] is None
        and [a['operation'] for a in interpreted['prepare_request']['actions']]
            == ['move', 'take', 'move', 'unlock']
        and [a['depends_on'] for a in interpreted['prepare_request']['actions']]
            == [None, 'act1', 'act2', 'act3'],
        str(interpreted.get('prepare_error')))
    chk('S17-Interpret 阶段零游戏写', B._ACTOR_STATE == before,
        'actor state unchanged')

    pv = core.prepare_structured(interpreted['prepare_request'])
    rs = pv['outcome']['resolutions']
    chk('S17-真实条件链 Prepare 可提交且零游戏写',
        pv['status'] == 'ready' and pv['can_commit']
        and B._ACTOR_STATE == before
        and all(r.get('execution_status') == 'attempted'
                and r.get('degree') == 'success' for r in rs), repr(rs))
    rec = core.commit({'session_id': sid, 'event_id': 'ev_p2_chain',
                       'analysis_id': pv['analysis_id'],
                       'expected_versions': pv['base_versions']})
    world = core.state(sid)['states'][WORLD]['interaction']
    chk('S17-Commit 后钥匙归玩家、地窖门开启',
        rec['status'] == 'committed'
        and world['objects']['cellar_key']['owner'] == 'player'
        and world['objects']['cellar_door']['locked'] is False
        and world['objects']['cellar_door']['open'] is True,
        str(rec.get('outcome', {}).get('state_changes')))

    replay = core.commit({'session_id': sid, 'event_id': 'ev_p2_chain',
                          'analysis_id': pv['analysis_id'],
                          'expected_versions': pv['base_versions']})
    chk('S17-重复提交幂等', replay.get('replayed') is True
        and world['turn_tick'] == 1, str(replay.get('replayed')))
    next_turn = I.interpret_turn(core, sid, '查看手里的钥匙和地窖门',
                                 event_id='ev_p2_chain_next',
                                 caller=fake({'actions': [
                                     {'kind': 'neutral', 'operation': 'communicate',
                                      'evidence': ['查看手里的钥匙和地窖门']}]}))
    directory = next_turn['directory']
    chk('S17-下一轮解释可读到提交后的权威实体状态',
        directory['objects']['cellar_key']['owner'] == 'player'
        and 'cellar_door' in I.entity_ids(directory)
        and directory['versions'] == core.state(sid)['versions']
        and bool(next_turn['history_used']),
        '下一轮目录钥匙归属/版本更新，且读取提交历史')
    # R1 补强：目录里被持有的物品用**有效位置**投影（随持有人），与核心 inspect 同一口径。
    chk('S17-目录位置投影：被带回酒馆的钥匙显示在持有人所在地',
        directory['objects']['cellar_key']['location'] == 'tavern',
        '目录 key.location=%s' % directory['objects']['cellar_key']['location'])


if __name__ == '__main__':
    test_schema_and_mapping()
    test_multi_action_conditions()
    test_reference_and_clarification()
    test_modes_threat_and_claim()
    test_rejections()
    test_end_to_end_and_readonly()
    test_p2_condition_chain_integration()
    print('\nP2-A 解释器定向检查：%d 项，%d 失败' % (N[0], len(FAIL)))
    if FAIL:
        print('失败项：' + '、'.join(FAIL))
        sys.exit(1)
    print('全部通过（零模型、零云端、零 HTTP；真实云端调用见 p2a_interpret_trace.py）')
