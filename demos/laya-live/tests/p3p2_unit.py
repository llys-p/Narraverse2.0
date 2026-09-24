"""P3 Phase2 状态层单元自测（秒级，不跑模型）。

覆盖：
  T1  死区：|delta| < 阈值 → 归零；≥ 阈值 → 原样
  T2  链路顺序：proposal → deadzone → per_turn → range
  T3  调试字段齐全：old/proposal/after_deadzone/final_delta/new_value
  T4  auxiliary（respect_shift）不写状态，但能拿到 proposal
  T5  关系维度**不硬绑定**：trust 涨不带动 doubt/fondness
  T6  fondness 用自己的 range（[0,1]）与自己的 per_turn（±0.05）
  T7  歧义轮整轮不 commit
  T8  单轮上限与 range clamp 仍然生效
"""
import sys

sys.path.insert(0, '.')
import laya_bridge as B

FAIL = []
N = [0]


def chk(tag, ok, detail=''):
    N[0] += 1
    print('  %s [%s] %s' % ('✅' if ok else '❌', tag, detail))
    if not ok:
        FAIL.append(tag)


print('=' * 92)
print('P3 Phase2 状态层单元自测')
print('=' * 92)

print()
print('T1/T2/T3 死区 + 链路顺序 + 调试字段')
for sig, thr, cases in (
    ('trust_shift', 1.0, [(0.4, 0.0), (0.99, 0.0), (1.0, 1.0), (3.0, 3.0), (-0.5, 0.0), (-0.99, 0.0), (-1.0, -1.0), (-4.0, -4.0)]),
):
    for prop, want in cases:
        r = B.state_transition(sig, prop, 60, allowed=True)
        got = r['after_deadzone']
        chk('%s proposal=%+.2f' % (sig, prop), abs(got - want) < 1e-9,
            'after_deadzone=%+.3f (期望 %+.3f) deadzone_applied=%s' % (got, want, r['deadzone']['applied']))
        need = ('old', 'proposal', 'after_deadzone', 'final_delta', 'new_value')
        missing = [k for k in need if k not in r]
        if missing:
            chk('%s 字段齐全' % sig, False, '缺 %s' % missing)
chk('调试字段齐全（四件套+after_deadzone）', True, 'old/proposal/after_deadzone/final_delta/new_value')

print()
print('T2 顺序验证：死区先于 per-turn')
# proposal=20 → 死区放行 → per_turn 12 → 12；若顺序反了会得到 per_turn 后再判死区（仍 12，看不出）
# 用一个「死区内但 per_turn 之外」不可能的值做反证：proposal=0.2 若先 per_turn 仍是 0.2，再死区 → 0
r = B.state_transition('trust_shift', 0.2, 60)
chk('死区在小值上生效（不被 per_turn 掩盖）', r['after_deadzone'] == 0.0 and r['final_delta'] == 0.0,
    'final_delta=%s' % r['final_delta'])
r = B.state_transition('trust_shift', 20.0, 60)
chk('大值被 per_turn 截到 12', abs(r['final_delta'] - 12.0) < 1e-9 and 'per_turn' in ' '.join(r['clamped_by']),
    'final_delta=%s clamped_by=%s' % (r['final_delta'], r['clamped_by']))

print()
print('T6 fondness 用自己的 range 与 per_turn')
r = B.state_transition('fondness_shift', 0.03, 0.35)
chk('fondness 正常写入 [0,1]', abs(r['final_delta'] - 0.03) < 1e-9 and r['range'] == [0, 1],
    'delta=%s range=%s' % (r['final_delta'], r['range']))
r = B.state_transition('fondness_shift', 0.5, 0.35)
chk('fondness 被自己的 per_turn 截到 0.05', abs(r['final_delta'] - 0.05) < 1e-9,
    'delta=%s clamped_by=%s' % (r['final_delta'], r['clamped_by']))
r = B.state_transition('fondness_shift', 0.001, 0.35)
chk('fondness 死区 0.002 生效', r['final_delta'] == 0.0, 'delta=%s' % r['final_delta'])
r = B.state_transition('fondness_shift', 0.9, 0.98)
chk('fondness range 上界 clamp 到 1.0', abs(r['new_value'] - 1.0) < 1e-9, 'new=%s' % r['new_value'])

print()
print('T5 关系维度不硬绑定（直接构造 proposal）')
B.reset_actor_state()
st = B.actor_state_for('T5', 'Lia')
before = {'trust': st['relationship']['trust'], 'doubt': st['relationship']['doubt'],
          'fondness': st['emotion']['fondness']}
prop = {'delta': [
    {'source_signal': 'trust_shift', 'target': 'relationship.trust', 'delta': 8.0,
     'status': 'active', 'grade': 'A', 'role': 'state_shift'},
]}
B.apply_state_transition('T5', 'Lia', prop, {'behavior_is_null': False, 'turn_id': 't1'})
st = B.actor_state_for('T5', 'Lia')
chk('trust 单涨不带动 doubt', abs(st['relationship']['doubt'] - before['doubt']) < 1e-9,
    'doubt %s → %s' % (before['doubt'], st['relationship']['doubt']))
chk('trust 单涨不带动 fondness', abs(st['emotion']['fondness'] - before['fondness']) < 1e-9,
    'fondness %s → %s' % (before['fondness'], st['emotion']['fondness']))
chk('trust 自身确实涨了', st['relationship']['trust'] > before['trust'],
    '%s → %s' % (before['trust'], st['relationship']['trust']))

print()
print('T5b 「信任高但 fondness 低」组合可以存在')
B.reset_actor_state()
prop = {'delta': [
    {'source_signal': 'trust_shift', 'target': 'relationship.trust', 'delta': 12.0,
     'status': 'active', 'grade': 'A', 'role': 'state_shift'},
    {'source_signal': 'fondness_shift', 'target': 'emotion.fondness', 'delta': -0.05,
     'status': 'active', 'grade': 'A', 'role': 'state_shift'},
]}
for i in range(4):
    B.apply_state_transition('T5b', 'Lia', prop, {'behavior_is_null': False, 'turn_id': 't%d' % i})
st = B.actor_state_for('T5b', 'Lia')
t_, f_ = st['relationship']['trust'], st['emotion']['fondness']
chk('能造出 trust 高 + fondness 低', t_ > 80 and f_ < 0.35,
    'trust=%.1f fondness=%.3f （起始 60 / 0.35）' % (t_, f_))

print()
print('T7 歧义轮整轮不 commit')
B.reset_actor_state()
prop = {'delta': [
    {'source_signal': 'trust_shift', 'target': 'relationship.trust', 'delta': 9.0,
     'status': 'active', 'grade': 'A', 'role': 'state_shift'},
]}
c, s, v = B.apply_state_transition('T7', 'Lia', prop,
                                   {'behavior_is_null': True, 'awaiting_upstream': True, 'turn_id': 't1'})
chk('歧义轮 commit=0', len(c) == 0 and len(s) == 1, 'commits=%d skipped=%d' % (len(c), len(s)))
chk('trust 未被改动', B.actor_state_for('T7', 'Lia')['relationship']['trust'] == 60,
    'trust=%s' % B.actor_state_for('T7', 'Lia')['relationship']['trust'])

print()
print('T4 auxiliary / respect_shift 不写状态')
B.reset_actor_state()
prop = {'delta': [
    {'source_signal': 'respect_shift', 'target': 'relationship.respect', 'delta': 7.0,
     'status': 'auxiliary', 'grade': 'C', 'role': 'state_shift'},
]}
c, s, v = B.apply_state_transition('T4', 'Lia', prop, {'behavior_is_null': False, 'turn_id': 't1'})
chk('auxiliary commit=0', len(c) == 0, 'commits=%d' % len(c))
chk('auxiliary 有跳过理由', s and 'auxiliary' in (s[0].get('skipped_reason') or ''),
    (s[0].get('skipped_reason') if s else '(无)'))
chk('respect 未被改动', B.actor_state_for('T4', 'Lia')['relationship']['respect'] == 45,
    'respect=%s' % B.actor_state_for('T4', 'Lia')['relationship']['respect'])

print()
print('T8 无 range 的字段拒绝写')
_saved = None
try:
    import copy
    _saved = copy.deepcopy(B.CFG['state_shift']['paths'])
    del B.CFG['state_shift']['paths']['trust_shift']['range']
    r = B.state_transition('trust_shift', 5.0, 60)
    chk('无 range → 拒绝且有理由', (not r['committed']) and 'range' in (r['skipped_reason'] or ''),
        r['skipped_reason'])
finally:
    if _saved is not None:
        B.CFG['state_shift']['paths'] = _saved

print()
print('T9 翻译失败必须 fail-closed（不以中文冒充英文）')
# ★ 2026-09-24 用户明确要求：translate_to_en 失败时
#   ①明确返回 translation failure ②不调用英文 checkpoint ③不生成 proposal ④不 commit
#   ⑤测试结果标 invalid。这里把四条都钉住。
import os as _os

chk('默认是 fail-closed', B.XLATE_FAIL_CLOSED is True,
    'LAYA_XLATE_FAIL_CLOSED=%s（LAYA_XLATE_FAIL_OPEN 未设即可）' % B.XLATE_FAIL_CLOSED)

# 用一个必然失败的 key 触发（只覆盖内存，不改 .env）
_saved_key = _os.environ.get('DEEPSEEK_API_KEY')
_saved_alt = _os.environ.get('LLM_API_KEY')
try:
    _os.environ['DEEPSEEK_API_KEY'] = 'sk-invalid-unit-test'
    _os.environ.pop('LLM_API_KEY', None)

    _raised = None
    try:
        B.translate_to_en('这是一句必然翻译失败的台词。')
    except B.TranslationFailure as e:
        _raised = e
    chk('translate_to_en 抛 TranslationFailure', _raised is not None,
        'reason=%s' % (getattr(_raised, 'reason', '(未抛)')))

    chk('失败原因只含状态码、不含凭证',
        _raised is not None and 'sk-' not in str(_raised.reason),
        'reason=%r（不得出现 key / 尾号）' % (getattr(_raised, 'reason', None)))

    _r = B._cached_translate('另一句必然失败的台词。', {})
    chk('_cached_translate 返回 None（不回填中文）', _r is None, 'got=%r' % (_r,))

    # decide()：四件事都不能发生
    B.reset_actor_state()
    _out = B.decide({'player_input': '这是一句必然翻译失败的台词。',
                     'session_id': 'T9', 'actor_id': 'Lia'})
    chk('decide 标 invalid 且 ok=False',
        _out.get('status') == 'invalid' and _out.get('ok') is False,
        'status=%s ok=%s' % (_out.get('status'), _out.get('ok')))
    chk('decide 未调用 Laya（无 actor_state / decision）',
        'actor_state' not in _out and 'decision' not in _out,
        'keys=%s' % ','.join(sorted(_out.keys()))[:80])
    chk('decide 无 state proposal', not (_out.get('state_proposal')),
        'state_proposal=%r' % (_out.get('state_proposal'),))
    chk('decide 未 commit', not (_out.get('state_commits')), 'commits=%r' % (_out.get('state_commits'),))
    _tr = B.actor_state_for('T9', 'Lia') or {}
    chk('Actor State 未被写入（trust 仍 60）',
        ((_tr.get('relationship') or {}).get('trust')) == 60,
        'trust=%s' % ((_tr.get('relationship') or {}).get('trust')))
finally:
    if _saved_key is not None:
        _os.environ['DEEPSEEK_API_KEY'] = _saved_key
    elif 'DEEPSEEK_API_KEY' in _os.environ:
        del _os.environ['DEEPSEEK_API_KEY']
    if _saved_alt is not None:
        _os.environ['LLM_API_KEY'] = _saved_alt

# ---------------------------------------------------------------------------
# T10：fail-closed 的精简返回**不得**把路由层打崩。
#
# 背景（真机实测踩到，不是假想）：decide() 有两条返回路径 ——
#   · 正常轮：带 engine / device / routing / answers …
#   · fail-closed 轮（翻译失败）：**精简返回**，只带 status/invalid_reason/state_commits…
# do_POST 的 /decide 与 /turn 分支在写历史日志时曾用 `out["engine"]` 下标取值，
# 于是翻译失败那一轮直接 KeyError → BaseHTTPRequestHandler 抛异常 → **HTTP 连接被掐断**
# （客户端看到 ConnectionRefusedError 10061 / RemoteDisconnected），
# 把一次「标 invalid 的干净拒绝」升级成「看起来像桥挂了」。
#
# ★ 判据要精确，否则测的是别的东西。这里拆成两条独立事实：
#   (a) 源码级：历史日志那两处必须是 .get，不得下标。
#       只看 `"engine": out["engine"]` 这个**模式**，不去数全文里
#       别的合法下标（如 /predict 分支的 out["engine"]）。
#   (b) 行为级：fail-closed 返回**不含** engine 键 —— 这正是 (a) 会崩的前提。
#       必须在**清掉 key** 的环境下构造（T9 的 finally 已还原 key，所以这里重设一次）。
_src = open(B.__file__, encoding='utf-8').read()
chk('历史日志用 .get 而非下标取 engine',
    _src.count('"engine": out.get("engine")') == 2 and '"engine": out["engine"]' not in _src,
    'out.get 出现 %d 次（应为 2：/decide 与 /turn 各一）' % _src.count('"engine": out.get("engine")'))

_sv = _os.environ.get('DEEPSEEK_API_KEY')
try:
    _os.environ['DEEPSEEK_API_KEY'] = 'sk-invalid-unit-test'
    _os.environ.pop('LLM_API_KEY', None)
    _fc = B.decide({'player_input': '这是一句必然翻译失败的台词。',
                    'session_id': 'T10', 'actor_id': 'Lia'}) or {}
finally:
    if _sv is not None:
        _os.environ['DEEPSEEK_API_KEY'] = _sv
chk('fail-closed 返回不含 engine（=下标取值必崩的前提）',
    'engine' not in _fc and _fc.get('status') == 'invalid',
    'status=%s has_engine=%s' % (_fc.get('status'), 'engine' in _fc))
chk('fail-closed 返回不含 decision / turn（两处共享代码都会中招）',
    'decision' not in _fc and 'turn' not in _fc,
    'keys=%s' % ','.join(sorted(_fc.keys()))[:90])

print()
print('=' * 92)
print('合计 %d 项：%d PASS / %d FAIL' % (N[0], N[0] - len(FAIL), len(FAIL)))
if FAIL:
    print('失败项：%s' % '、'.join(FAIL))
print('=' * 92)
sys.exit(1 if FAIL else 0)
