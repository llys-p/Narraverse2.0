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
  T11 分析核纯读：不创建、不修改 Actor State
  T12 显式 commit_state 才允许写 Actor State
  T13 /turn 的 commit_state=false 在真实路由上不写状态或历史
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
from unittest.mock import patch as _patch
from urllib.error import HTTPError as _HTTPError

chk('默认是 fail-closed', B.XLATE_FAIL_CLOSED is True,
    'LAYA_XLATE_FAIL_CLOSED=%s（LAYA_XLATE_FAIL_OPEN 未设即可）' % B.XLATE_FAIL_CLOSED)

# 拦截外部 HTTP，稳定模拟 401；不访问翻译服务、不读写真实翻译缓存。
_http_mock = _patch.object(B.urllib.request, 'urlopen',
                          side_effect=_HTTPError('https://unit.invalid', 401, 'unit', {}, None))
_cache_mock = _patch.object(B, '_XLATE_CACHE', {})
_http_mock.start()
_cache_mock.start()
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

    _r = B._cached_translate('另一句必然失败的台词。', B._XLATE_CACHE)
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
    _http_mock.stop()
    _cache_mock.stop()

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
_sv_alt = _os.environ.get('LLM_API_KEY')
try:
    _os.environ['DEEPSEEK_API_KEY'] = 'sk-invalid-unit-test'
    _os.environ.pop('LLM_API_KEY', None)
    with _patch.object(B, '_XLATE_CACHE', {}), _patch.object(
            B.urllib.request, 'urlopen',
            side_effect=_HTTPError('https://unit.invalid', 401, 'unit', {}, None)):
        _fc = B.decide({'player_input': '这是一句必然翻译失败的台词。',
                        'session_id': 'T10', 'actor_id': 'Lia'}) or {}
finally:
    if _sv is not None:
        _os.environ['DEEPSEEK_API_KEY'] = _sv
    else:
        _os.environ.pop('DEEPSEEK_API_KEY', None)
    if _sv_alt is not None:
        _os.environ['LLM_API_KEY'] = _sv_alt
chk('fail-closed 返回不含 engine（=下标取值必崩的前提）',
    'engine' not in _fc and _fc.get('status') == 'invalid',
    'status=%s has_engine=%s' % (_fc.get('status'), 'engine' in _fc))
chk('fail-closed 返回不含 decision / turn（两处共享代码都会中招）',
    'decision' not in _fc and 'turn' not in _fc,
    'keys=%s' % ','.join(sorted(_fc.keys()))[:90])

print()
print('T11/T12 分析与状态提交必须彻底分层')
chk('存在纯分析核 analyze_core', hasattr(B, 'analyze_core'))
chk('存在纯校验层 validate_state_delta', hasattr(B, 'validate_state_delta'))
chk('存在唯一写入层 commit_state', hasattr(B, 'commit_state'))

# 不依赖模型能力与当前档案是否恰好产出 active delta：即使分析结果为空，
# 读取一个从未出现过的桶也不能把它初始化进 _ACTOR_STATE。
B.reset_actor_state('T11', 'Lia')
_pure_out = B.decide({'player_input': 'You lied to me.',
                      'player_input_en': 'You lied to me.',
                      'session_id': 'T11', 'actor_id': 'Lia'}) or {}
_pure_view = B.actor_state_view('T11', 'Lia')
chk('decide/analyze 不创建 Actor State 桶', _pure_view.get('exists') is False,
    'exists=%s state_commits=%r' % (_pure_view.get('exists'), _pure_out.get('state_commits')))
chk('decide/analyze 不返回伪装成已提交的 state_commits',
    not (_pure_out.get('state_commits')),
    'state_commits=%r' % (_pure_out.get('state_commits'),))

_proposal = {'delta': [
    {'source_signal': 'doubt_shift', 'target': 'relationship.doubt', 'delta': 4.0,
     'status': 'active', 'grade': 'A', 'role': 'state_shift'},
]}
_decision = {'behavior_is_null': False, 'awaiting_upstream': False, 'turn_id': 'T12#1'}
if hasattr(B, 'validate_state_delta') and hasattr(B, 'commit_state'):
    B.reset_actor_state('T12', 'Lia')
    _validated, _skipped, _preview = B.validate_state_delta(
        'T12', 'Lia', _proposal, _decision, actor=B.CFG.get('actor'))
    _after_validate = B.actor_state_view('T12', 'Lia')
    chk('校验预演明确标记未提交', bool(_validated) and
        all(r.get('validated') and not r['committed'] for r in _validated))
    chk('validate_state_delta 不创建 Actor State 桶', _after_validate.get('exists') is False,
        'exists=%s validated=%d' % (_after_validate.get('exists'), len(_validated)))
    _commits, _skipped2, _committed_view = B.commit_state(
        'T12', 'Lia', _proposal, _decision, actor=B.CFG.get('actor'))
    _doubt = (((_committed_view or {}).get('state') or {}).get('relationship') or {}).get('doubt')
    chk('commit_state 是显式写入点', bool(_commits) and _doubt == 34.0,
        'commits=%d doubt=%r' % (len(_commits), _doubt))
else:
    chk('validate 后仍为纯读', False, '待实现 validate_state_delta / commit_state')
    chk('commit_state 是显式写入点', False, '待实现 commit_state')

print()
print('T13 /turn 显式提交门（本机临时端口，不跑模型）')
import json as _json
import threading as _threading
import urllib.request as _urlrequest

B.reset_actor_state('T13', 'Lia')
B.reset_history('T13', 'Lia')
_real_decide = B.decide
_seq = [0]


def _fake_decide(_payload):
    _seq[0] += 1
    _tid = 'T13/Lia#%d' % _seq[0]
    return {
        'engine': B.ENGINE_MODE_LAYA,
        'turn': {'turn_id': _tid, 'session_id': 'T13', 'actor_id': 'Lia',
                 'history_bucket': 'T13/Lia'},
        'decision': {'behavior': {'id': 'unit_behavior'}, 'source': 'unit',
                     'player_intent': {'id': 'unit_intent'}},
        'state_proposal': _proposal,
        'state_validation': {'decision': dict(_decision, turn_id=_tid)},
        'state_commits': [], 'state_skipped': [],
        'actor_state': B.actor_state_analysis_view('T13', 'Lia', B.CFG.get('actor')),
    }


_srv = B.ThreadingHTTPServer(('127.0.0.1', 0), B.Handler)
_thr = _threading.Thread(target=_srv.serve_forever, daemon=True)
_thr.start()
_opener = _urlrequest.build_opener(_urlrequest.ProxyHandler({}))


def _post_turn(commit_flag):
    _body = _json.dumps({'player_input': 'unit', 'session_id': 'T13',
                         'actor_id': 'Lia', 'commit_state': commit_flag}).encode('utf-8')
    _req = _urlrequest.Request('http://127.0.0.1:%d/turn' % _srv.server_address[1],
                               data=_body, headers={'Content-Type': 'application/json'})
    with _opener.open(_req, timeout=5) as _resp:
        return _json.loads(_resp.read().decode('utf-8'))


try:
    B.decide = _fake_decide
    _not_committed = _post_turn(False)
    _after_false = B.actor_state_view('T13', 'Lia')
    chk('/turn commit_state=false 不创建 Actor State', _after_false.get('exists') is False,
        'exists=%s gate=%r' % (_after_false.get('exists'), _not_committed.get('state_gate')))
    chk('/turn commit_state=false 不写历史', not B.history_for('T13', 'Lia'),
        'history=%r' % B.history_for('T13', 'Lia'))

    _committed = _post_turn(True)
    _after_true = B.actor_state_view('T13', 'Lia')
    _doubt_true = (((_after_true.get('state') or {}).get('relationship') or {}).get('doubt'))
    chk('/turn commit_state=true 才写状态', _doubt_true == 34.0,
        'doubt=%r commits=%r' % (_doubt_true, _committed.get('state_commits')))
    chk('/turn commit_state=true 同时写历史', bool(B.history_for('T13', 'Lia')),
        'history=%r' % B.history_for('T13', 'Lia'))
    chk('提交响应元数据与实际写入一致',
        _committed.get('state_transition_meta', {}).get('n_committed') == 1 and
        _committed['state_transition_meta']['authority'] == 'commit_state' and
        not _committed['state_transition_meta']['is_proposal'])
finally:
    B.decide = _real_decide
    _srv.shutdown()
    _srv.server_close()
    _thr.join(timeout=5)
    B.reset_actor_state('T13', 'Lia')
    B.reset_history('T13', 'Lia')

print()
print('T14 自定义角色预览、快照隔离和顺序重复提交')
_custom = copy.deepcopy(B.CFG['actor'])
_custom.setdefault('relationship', {})['doubt'] = 12
_custom_out = B.analyze_core({'player_input_en': 'Hello.', 'player_input': 'Hello.',
                            'actor': _custom, 'session_id': 'T14', 'actor_id': 'Custom'})
chk('自定义角色预览采用实际模板',
    _custom_out['actor_state']['state']['relationship']['doubt'] == 12 and
    _custom_out['state_validation']['preview']['state']['relationship']['doubt'] == 12)
chk('自定义角色分析不创建状态', not B.actor_state_view('T14', 'Custom')['exists'])
B.propose_turn('T14#1', 'T14', 'Custom', 'unit', None, 'unit',
               _proposal, _decision, _custom, record_history=False,
               engine_used=B.ENGINE_MODE_LAYA)
_ok, _, _result = B.commit_turn('T14#1')
chk('显式历史模式仍能提交状态且不重复写历史',
    _ok and _result['actor_state']['state']['relationship']['doubt'] == 16 and
    not B.history_for('T14', 'Custom'))
_before = copy.deepcopy((B._ACTOR_STATE, B._STATE_TRACE, B._HISTORY_BUCKETS))
_repeat, _, _ = B.commit_turn('T14#1')
_view = B.actor_state_snapshot('T14', 'Custom')
_view['relationship']['doubt'] = 99
chk('顺序重复提交拒绝且外部快照修改不污染状态',
    not _repeat and _before == (B._ACTOR_STATE, B._STATE_TRACE, B._HISTORY_BUCKETS))
B.reset_actor_state('T14', 'Custom')

print('=' * 92)
print('合计 %d 项：%d PASS / %d FAIL' % (N[0], N[0] - len(FAIL), len(FAIL)))
if FAIL:
    print('失败项：%s' % '、'.join(FAIL))
print('=' * 92)
sys.exit(1 if FAIL else 0)
