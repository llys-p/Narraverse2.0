"""ZCode 副手审查 · Delivery Core / Evidence 定向反例（秒级：零模型、零云端、零 HTTP）。

基线：fusion 保存点 d446336（隔离树 D:/Narraverse2.0-zreview，分支 zcode/review-delivery-evidence）。
每个反例只验证一个疑点，全部确定性、可重复：

  F1  attempted + skipped 混合轮被聚合为 partial_success
      （_calculate 聚合分支把「从未尝试」的 skipped 也拖低整轮结果）
  F2  transfer 是唯一不检查 actor_restrained 的动作
      （与其余 6 个动作的前提检查不一致；restrained 玩家可交出物品）
  F3  normalize_evidence 不校验 source 字段
      （Provider 可在回执里自我标注 source="laya"，违反本模块「不冒充真实 Laya」的声明）
  F4  make_real_evidence_provider 只评估 candidates[0]
      （一轮多条 question 时第二条静默无 Evidence，连 auxiliary 都没有）
  F5  解释器 MAX_MESSAGE=4000 与核心 MAX_INTENT_CHARS=2000 的契约裂缝
      （解释器 ready 的长引用轮在 Prepare 被 422 INVALID_REQUEST 拒绝）

用法：PYTHONIOENCODING=utf-8 python tests/review_zcode_delivery_evidence.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B  # noqa: E402
from laya_delivery_core import WORLD, DeliveryCore  # noqa: E402
from laya_delivery_interpreter import parse_interpretation, to_prepare_request  # noqa: E402
import laya_evidence as EV  # noqa: E402
from laya_state_protocol import _ProtoError  # noqa: E402

FAIL = []
N = [0]


def chk(tag, ok, detail=''):
    N[0] += 1
    print('  [%s] %s%s' % ('REPRO-CONFIRMED' if ok else 'not-reproduced', tag,
                           (' | ' + detail) if detail else ''))
    if not ok:
        FAIL.append(tag)


def fresh(session='zrev'):
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


def versions_of(core, sid):
    return core.state(sid)["versions"]


def prepare(core, sid, actions, event_id):
    return core.prepare_structured({
        "session_id": sid, "event_id": event_id, "actor_id": "player",
        "expected_versions": versions_of(core, sid), "actions": actions,
    })


def commit(core, sid, event_id, analysis_id):
    return core.commit({
        "session_id": sid, "event_id": event_id, "analysis_id": analysis_id,
        "expected_versions": versions_of(core, sid),
    })


def transfer(aid='a1', obj='apple', target='lia', mode='attempt'):
    return {'id': aid, 'operation': 'transfer', 'target_ids': [target],
            'object_id': obj, 'mode': mode}


def communicate(aid='a2', kind='claim', mode='attempt', content='我说了一句话',
                target='lia'):
    return {'id': aid, 'operation': 'communicate', 'target_ids': [target],
            'kind': kind, 'mode': mode, 'content': content}


# ============================================================================
print('F1 attempted + skipped 混合轮的整轮结果聚合')
core, P, sid = fresh('f1')
pre = prepare(core, sid, [transfer('a1'), communicate('a2', mode='negated', content='')], 'e-f1')
resolutions = pre['outcome']['resolutions']
statuses = [(r['action_id'], r['execution_status'], r['degree']) for r in resolutions]
print('    resolutions:', statuses)
print('    preview.result =', pre['outcome']['result'], '/ degree =', pre['outcome']['degree'])
receipt = commit(core, sid, 'e-f1', pre['analysis_id'])
chk('F1 mixed attempted+skipped -> result=partial_success (expected: achieved)',
    receipt['outcome']['result'] == 'partial_success',
    'actual result=%r degree=%r；唯一 attempted 动作 transfer 成功，negated 从未尝试，'
    '却把整轮拖成 partial_success（laya_delivery_core.py:1218-1224 的 else 分支）'
    % (receipt['outcome']['result'], receipt['outcome']['degree']))

# 对照组：attempted + blocked（声明缺内容 → 只挡 communicate，不影响 transfer）—— 这一组是可辩护的设计
core2, P2, sid2 = fresh('f1b')
pre2 = prepare(core2, sid2, [transfer('a1'), communicate('a2', content='')], 'e-f1b')
print('    对照 attempted+blocked ->', pre2['outcome']['result'],
      '| a2 reasons:', pre2['outcome']['resolutions'][1]['check']['reasons'])

# ============================================================================
print('F2 transfer 不检查 actor_restrained（其余 6 个动作都检查）')
core, P, sid = fresh('f2')
with P.lock:
    B._ACTOR_STATE[(sid, 'player')]['interaction']['restrained'] = True
    for entity in ('player', 'lia', WORLD):
        P._bump_revision((sid, entity))
pre_t = prepare(core, sid, [transfer('a1')], 'e-f2-transfer')
print('    restrained 玩家 transfer apple ->', pre_t['status'],
      '| reasons:', pre_t['outcome']['resolutions'][0]['check']['reasons'])
chk('F2 transfer while restrained is READY (expected: blocked/actor_restrained)',
    pre_t['status'] == 'ready' and pre_t['can_commit'] is True,
    '被缚玩家仍产出门票候选（apple 归属可变更）；laya_delivery_core.py:708-709 只查 '
    'incapacitated，无 actor_restrained')
# 对照：同一受限状态下 take 明确 blocked 且含 actor_restrained
core3, P3, sid3 = fresh('f2b')
with P3.lock:
    B._ACTOR_STATE[(sid3, 'player')]['interaction']['restrained'] = True
    for entity in ('player', 'lia', WORLD):
        P3._bump_revision((sid3, entity))
pre_k = prepare(core3, sid3, [{'id': 'a1', 'operation': 'take',
                               'target_ids': [], 'object_id': 'cellar_key'}], 'e-f2-take')
print('    对照 restrained take ->', pre_k['status'],
      '| reasons:', pre_k['outcome']['resolutions'][0]['check']['reasons'])
chk('F2-contrast take while restrained is BLOCKED with actor_restrained',
    pre_k['status'] == 'blocked'
    and 'actor_restrained' in pre_k['outcome']['resolutions'][0]['check']['reasons'])

# ============================================================================
print('F3 normalize_evidence 不校验 source 字段（可自标 source="laya"）')
pi = {
    'event_id': 'e-f3', 'actor_id': 'player', 'session_id': 'f3',
    'candidates': [{'event_id': 'e-f3', 'action_id': 'a1', 'sub_kind': 'question',
                    'kind': 'question', 'listener': 'lia', 'actor_id': 'player',
                    'evidence_text': '钥匙在哪', 'content': '钥匙在哪'}],
    'npc_state': {'lia': {'relationship': {'doubt': 30},
                          'interaction': {'relationship_to': 'player'}}},
}
raw = [{'source': 'laya', 'action_id': 'a1', 'target_npc': 'lia',   # 冒充真实来源
        'signals': [{'signal': 'doubt_shift', 'role': 'state_shift',
                     'status': 'active', 'may_write_state': True, 'delta': 1.5,
                     'provider_private_field': 'x'}]}]
out = EV.normalize_evidence(raw, pi)
print('    normalized source =', out[0]['source'], '| writable =', out[0]['writable'],
      '| signal keys =', sorted(out[0]['signals'][0].keys()))
chk('F3 fake source="laya" passes through normalize_evidence',
    out[0]['source'] == 'laya',
    'laya_evidence.py:28-31 声明 source 只能是 test_fixture/laya 且「不冒充」，'
    '但 normalize_evidence(:123-179) 对 source 无任何白名单校验；'
    'provider_private_field 被正确丢弃（白名单本身生效）')

# ============================================================================
print('F4 make_real_evidence_provider 只评估 candidates[0]')
calls = []


def spy_infer(zh, en, npc_state, listener, session_id):
    calls.append({'zh': zh, 'listener': listener})
    return {'engine': 'fallback'}          # 让 _evidence_from_real_result 走 fallback 分支即可


provider = EV.make_real_evidence_provider(infer=spy_infer,
                                          xlate_lookup=lambda t: 'EN:' + t)
pi2 = {
    'event_id': 'e-f4', 'actor_id': 'player', 'session_id': 'f4',
    'candidates': [
        {'event_id': 'e-f4', 'action_id': 'a1', 'sub_kind': 'question',
         'kind': 'question', 'listener': 'lia', 'actor_id': 'player',
         'evidence_text': '', 'content': '钥匙在哪'},
        {'event_id': 'e-f4', 'action_id': 'a2', 'sub_kind': 'question',
         'kind': 'question', 'listener': 'lia', 'actor_id': 'player',
         'evidence_text': '', 'content': '苹果归谁'},
    ],
    'npc_state': {'lia': {'relationship': {'doubt': 30},
                          'interaction': {'relationship_to': 'player'}}},
}
ret = provider(pi2)
print('    infer calls =', calls, '| absent_reason =', ret.get('absent_reason'))
chk('F4 only candidates[0] evaluated (a2 silently gets no evidence at all)',
    len(calls) == 1 and calls[0]['zh'] == '钥匙在哪',
    'laya_evidence.py:424 `cand = provider_input["candidates"][0]`：一轮第二条 question '
    '不产生任何 Evidence（无 active 也无 auxiliary），回执无法区分「没问」与「问了未评估」；'
    '而核心侧 entries_to_changes/make_provider_input 明明支持多候选（fixture_provider_multi 即为此而设）')

# ============================================================================
print('F5 解释器 4000 字符上限与核心 2000 字符上限的契约裂缝')
long_quote = '这是很长的原话内容' * 280          # 2520 字符
message = '莉亚，我宣布：' + long_quote      # 提及「莉亚」逐字在原话里
model_raw = json.dumps({'actions': [{
    'kind': 'claim', 'operation': 'communicate', 'other_operation': None,
    'targets': ['莉亚'], 'object': None, 'mode': 'attempt',
    'content': None, 'evidence': [message], 'depends_on': None, 'when': 'always'
}], 'ambiguities': []}, ensure_ascii=False)
core4, P4, sid4 = fresh('f5')
directory = __import__('laya_delivery_interpreter').build_entity_directory(core4, sid4)
interp = parse_interpretation(model_raw, message, directory, 'player', ())
print('    interpreter status =', interp['status'])
if interp['status'] == 'ready':
    req = to_prepare_request(interp, sid4, 'e-f5', versions_of(core4, sid4))
    try:
        core4.prepare_structured(req)
        chk('F5 long verbatim quote prepared without error', False, '居然成功了')
    except _ProtoError as e:
        print('    prepare -> HTTP', e.http, e.code)
        chk('F5 interpreter-ready turn rejected 422 by core (interface mismatch)',
            e.http == 422 and e.code == 'INVALID_REQUEST',
            '解释器 ready（evidence 是合法逐字子串，%d 字符），核心 _check_actions 因 '
            'content>2000 判 INVALID_REQUEST（laya_delivery_core.py:619-623 vs 解释器 '
            'MAX_MESSAGE=4000 laya_delivery_interpreter.py:70）—— 玩家长引用声明无澄清路径，'
            '直接变非法请求' % len(message))
else:
    chk('F5 interpreter-ready turn rejected 422 by core (interface mismatch)',
        False, '解释器未 ready：%r' % interp.get('invalid_reason'))

# ============================================================================
print('紧邻回归（既有秒级单测，证明基线行为未被误读）')
import subprocess
env_python = sys.executable
tests_dir = Path(__file__).resolve().parent
for name in ('p1_delivery_unit.py', 'p2a_interpreter_unit.py'):
    r = subprocess.run([env_python, str(tests_dir / name)], capture_output=True,
                       text=True, encoding='utf-8', errors='replace',
                       env={'PYTHONIOENCODING': 'utf-8', 'SYSTEMROOT': __import__('os').environ.get('SYSTEMROOT', ''),
                            'PATH': __import__('os').environ.get('PATH', '')})
    tail = (r.stdout or '').strip().splitlines()[-3:]
    print('  %s -> exit %d | %s' % (name, r.returncode, ' / '.join(tail)[-160:]))

print()
print('==== SUMMARY: %d repros, %d confirmed, %d not reproduced ===='
      % (N[0], N[0] - len(FAIL), len(FAIL)))
if FAIL:
    print('NOT REPRODUCED:', ', '.join(FAIL))
