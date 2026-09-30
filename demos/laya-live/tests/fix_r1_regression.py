"""ZCode-R1 修复正式回归（秒级：零模型、零云端、假时钟、无监听端口）。

对应任务卡 `ZCode-R1-Delivery协议与结果修复.md` 四项必修的**修复后**断言
（审查树三个探针断言的是修复前缺陷行为，修复后它们按设计"复现失败"，不作为通过依据）：

  R1  P-F1 · 交付先提交 → 换 actor 旧协议 analyze/commit_state 被拒（会话级事件唯一）
  R2  P-F1 · 反向：交付候选在先 → 旧协议提交后，交付 commit 得到明确 EVENT_ALREADY_COMMITTED
  R3  P-F1 · 跨路径并发准备不并存两个可提交候选（双向 busy 核对）
  R4  P-F1 · 既有幂等重放 / 载荷冲突 / 候选失效语义不被破坏（两路各自验证）
  R5  F1  · 聚合：attempted+skipped → achieved；attempted+blocked → partial_success；
            全 skipped → no_attempt；预览与回执一致
  R6  P-F2 · analyze 锁外段注入异常 → 占位/未发布候选全释放，同事件可重新分析
  R7  H-F2 · commit_state 与多实体 bundle 回滚：客户端只收固定 INTERNAL_ERROR 文案，
            根因进异常链，回滚完整且之后可重新提交

★ 运行：PYTHONIOENCODING=utf-8 python tests/fix_r1_regression.py
"""
import copy
import io
import json
import sys
import threading
import time
import types
from contextlib import contextmanager, redirect_stderr
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B  # noqa: E402
from laya_delivery_core import WORLD, DeliveryCore  # noqa: E402
from laya_state_protocol import LayaStateProtocol, _ProtoError  # noqa: E402

FAIL = []
N = [0]


def chk(tag, ok, detail=''):
    N[0] += 1
    print('  [%s] %s%s' % ('PASS' if ok else 'FAIL', tag, (' | ' + detail) if detail else ''))
    if not ok:
        FAIL.append(tag)


# ---------------------------------------------------------------- 桩与脚手架
FAKE_CHECK = {"matched": True, "fresh": True, "problems": [],
              "code_changed": True, "checkpoint": "typed-decisions", "profile_id": "fp_t"}
FAKE_PROF = {"checkpoint": "typed-decisions", "profile_id": "fp_t", "signals": {
    "doubt_shift": {"grade": "A", "status": "active", "role": "state_shift"},
    "trust_shift": {"grade": "C", "status": "auxiliary", "role": "state_shift"},
}}
FAKE_DELTAS = ([
    {"question": "doubt_shift", "target": "relationship.doubt", "delta": 3.0,
     "label": "怀疑", "raw": 2.4, "range": [0, 100]},
], {})

now = [2000.0]
P = LayaStateProtocol(B, now=lambda: now[0])


def reset_all(sid='r1'):
    B.reset_actor_state()
    B.reset_history()
    B._PENDING.clear()
    P._buckets.clear()
    P._analyses.clear()
    P._events.clear()
    P._inflight.clear()
    P._event_busy.clear()          # ZCode-R1 新增表一并清
    now[0] = 2000.0
    core = DeliveryCore(B, protocol=P)
    core.ensure_scene(sid)
    return core


def _fake_engine():
    return types.SimpleNamespace(
        ready=True, predict=lambda _s, _q: {"answers": B.fallback_decide(
            B.CFG["actor"], None, "", _q)[0]},
        detail="stub-fake", model_name=None, last_error=None,
        device_label=lambda: "cpu (fake)", describe=lambda: {"kind": "fake"})


@contextmanager
def assets_ctx():
    eng = {"ready": True, "model_name": "typed-decisions", "detail": "stub"}
    with mock.patch.object(B, 'load_capability_profile',
                           side_effect=lambda m: (copy.deepcopy(FAKE_PROF), dict(FAKE_CHECK))), \
         mock.patch.object(B, 'load_capability_profiles',
                           return_value={"profiles": {}}), \
         mock.patch.object(B, 'build_deltas',
                           side_effect=lambda a, q, ac: copy.deepcopy(FAKE_DELTAS)), \
         mock.patch.object(B, '_cached_translate', return_value="EN_TEST"), \
         mock.patch.object(B, '_engine_identity', return_value=eng), \
         mock.patch.object(B, 'ENGINE', _fake_engine()):
        yield


def legacy_analyze(sid, event, actor='lia', message='你一直在瞒着我什么？', base=None):
    return P.analyze({
        "session_id": sid, "actor_id": actor, "event_id": event, "message": message,
        "expected_state_version": base or P.state_version((sid, actor)),
        "context": {"scene": "旅店大厅", "history": []},
    })


def legacy_commit(sid, actor, analysis_id, base=None):
    return P.commit_state({
        "session_id": sid, "actor_id": actor, "analysis_id": analysis_id,
        # 幂等重放契约：重放必须带原始基准版本（base_state_version），不是当前版本。
        "expected_state_version": base or P.state_version((sid, actor)),
    })


def transfer(aid='a1', obj='apple', target='lia', mode='attempt'):
    return {'id': aid, 'operation': 'transfer', 'target_ids': [target],
            'object_id': obj, 'mode': mode}


def communicate(aid='a2', kind='claim', mode='attempt', content='我说了一句话',
                target='lia'):
    return {'id': aid, 'operation': 'communicate', 'target_ids': [target],
            'kind': kind, 'mode': mode, 'content': content}


def prepare(core, sid, actions, event_id, actor='player'):
    return core.prepare_structured({
        "session_id": sid, "event_id": event_id, "actor_id": actor,
        "expected_versions": core.state(sid)["versions"], "actions": actions,
    })


def commit(core, sid, event_id, analysis_id, actor='player', expected=None):
    return core.commit({
        "session_id": sid, "event_id": event_id, "analysis_id": analysis_id,
        # 幂等重放契约：重放必须带**原始基准版本**（回执 base_versions），不是当前版本。
        "expected_versions": expected or core.state(sid)["versions"],
    })


def err_of(fn, *a, **k):
    """运行并返回 _ProtoError；无异常返回 (None, None)。"""
    try:
        fn(*a, **k)
        return None, None
    except _ProtoError as e:
        return e.http, e.code


def exc_of(fn, *a, **k):
    """运行并返回任意异常对象；无异常返回 None（用于断言裸异常穿出）。"""
    try:
        fn(*a, **k)
        return None
    except Exception as e:
        return e


# ===========================================================================
print('=' * 92)
print('ZCode-R1 修复正式回归（零模型 / 零云端 / 假时钟）')
print('=' * 92)

# ---------------------------------------------------------------------------
print('\n[R1] P-F1 · 交付先提交 → 换 actor 旧协议被拒（会话级事件唯一）')
core = reset_all('r1s1')
pre = prepare(core, 'r1s1', [transfer('a1')], 'evt-shared')
rec = commit(core, 'r1s1', 'evt-shared', pre['analysis_id'])
chk('R1 前置：交付提交成功', rec.get('status') == 'committed'
    and rec.get('replayed') is False, 'commit_id=%s' % rec.get('commit_id'))
with assets_ctx():
    h, c = err_of(legacy_analyze, 'r1s1', 'evt-shared', actor='lia')
chk('R1 旧协议 analyze（换 actor，同 event）被拒', (h, c) == (409, 'EVENT_ALREADY_COMMITTED'),
    'http=%s code=%s' % (h, c))
chk('R1 协议侧无候选残留（_analyses 无 in_flight）',
    not [a for a in P._analyses.values() if a.get('status') == 'in_flight'],
    'analyses=%d' % len(P._analyses))
chk('R1 会话级占用表已清空', not P._event_busy, 'busy=%r' % P._event_busy)

# ---------------------------------------------------------------------------
print('\n[R2] P-F1a · 交付 Ready 后旧协议 Analyze 被拒（同 actor 与换 actor 都不借作用域绕过）')
core = reset_all('r1s2')
pre = prepare(core, 'r1s2', [transfer('a1')], 'evt-shared2')       # 只 Prepare 不 Commit
chk('R2 前置：交付候选 ready，会话级登记保留（owner=analysis_id）',
    pre['status'] == 'ready'
    and P._event_busy.get(('r1s2', 'evt-shared2'), {}).get('owner') == pre['analysis_id'],
    'claim=%r' % P._event_busy.get(('r1s2', 'evt-shared2')))
with assets_ctx():
    h, c = err_of(legacy_analyze, 'r1s2', 'evt-shared2', actor='player')   # 同 actor
chk('R2 旧协议 Analyze（同 actor）被拒 → EVENT_PAYLOAD_CONFLICT',
    (h, c) == (409, 'EVENT_PAYLOAD_CONFLICT'), 'http=%s code=%s' % (h, c))
with assets_ctx():
    h, c = err_of(legacy_analyze, 'r1s2', 'evt-shared2', actor='lia')      # 换 actor
chk('R2 旧协议 Analyze（换 actor）同样被拒', (h, c) == (409, 'EVENT_PAYLOAD_CONFLICT'),
    'http=%s code=%s' % (h, c))
chk('R2 被拒后旧协议侧零候选（交付 Pending 恰 1 个该 event 候选）',
    not [a for a in P._analyses.values() if a.get('event_id') == 'evt-shared2']
    and sum(1 for x in core._pending.values()
            if x.get('event_id') == 'evt-shared2') == 1,
    'legacy_analyses=%d delivery_pending=%d'
    % (len([a for a in P._analyses.values() if a.get('event_id') == 'evt-shared2']),
       len([x for x in core._pending.values() if x.get('event_id') == 'evt-shared2'])))
rec = commit(core, 'r1s2', 'evt-shared2', pre['analysis_id'])
chk('R2 交付正常提交不受影响', rec.get('status') == 'committed', '')
chk('R2 提交终态 → 会话级登记成对释放', not P._event_busy, 'busy=%r' % P._event_busy)
with assets_ctx():
    h, c = err_of(legacy_analyze, 'r1s2', 'evt-shared2', actor='lia')
chk('R2 提交后旧协议 Analyze 撞墓碑 → EVENT_ALREADY_COMMITTED',
    (h, c) == (409, 'EVENT_ALREADY_COMMITTED'), 'http=%s code=%s' % (h, c))

# ---------------------------------------------------------------------------
print('\n[R3] P-F1 · 跨路径并发准备：busy 占用双向拒绝')
# 3a 旧协议分析中（analyze_core 慢桩）→ 交付 Prepare 拒绝
core = reset_all('r1s3')
orig_core = B.analyze_core
entered = threading.Event()


def slow_core(*a, **k):
    entered.set()
    time.sleep(0.3)
    return orig_core(*a, **k)


with assets_ctx(), mock.patch.object(B, 'analyze_core', side_effect=slow_core):
    out = {}

    def t_legacy():
        try:
            out['r'] = legacy_analyze('r1s3', 'evt-race', actor='lia')
        except _ProtoError as e:
            out['err'] = (e.http, e.code)

    th = threading.Thread(target=t_legacy)
    th.start()
    entered.wait(2)
    h, c = err_of(prepare, core, 'r1s3', [transfer('a1')], 'evt-race')
    th.join(5)
chk('R3a 交付 Prepare 撞旧协议分析中占用 → 409 EVENT_PAYLOAD_CONFLICT',
    (h, c) == (409, 'EVENT_PAYLOAD_CONFLICT'), 'http=%s code=%s' % (h, c))
chk('R3a 旧协议分析本身成功（未受影响）', out.get('r') is not None
    and out['r'].get('status') in ('ready', 'reference_only'),
    'status=%r' % (out.get('r') or {}).get('status'))
# R1a：Ready 候选落地后登记保留（owner=analysis_id），提交终态才释放
claim_r3a = P._event_busy.get(('r1s3', 'evt-race'))
chk('R3a Ready 候选持有会话级登记（owner 换绑 analysis_id）',
    claim_r3a is not None and claim_r3a.get('owner') == out['r']['analysis_id'],
    'claim=%r' % claim_r3a)
with assets_ctx():
    lc3a = legacy_commit('r1s3', 'lia', out['r']['analysis_id'])
chk('R3a 提交终态 → 登记成对释放',
    lc3a.get('status') == 'committed' and not P._event_busy,
    'busy=%r' % P._event_busy)

# 3b 交付 Prepare 中（慢 Provider）→ 旧协议 analyze 拒绝
core = reset_all('r1s4')
gate = threading.Event()
released = threading.Event()


def blocking_provider(provider_input):
    gate.set()
    released.wait(2)
    return []


core_slow = DeliveryCore(B, protocol=P, evidence_provider=blocking_provider)
out2 = {}


def t_delivery():
    try:
        out2['r'] = prepare(core_slow, 'r1s4', [communicate('a1', kind='question',
                                                            content='钥匙在哪')], 'evt-race2')
    except _ProtoError as e:
        out2['err'] = (e.http, e.code)


th2 = threading.Thread(target=t_delivery)
th2.start()
gate.wait(2)
with assets_ctx():
    h2, c2 = err_of(legacy_analyze, 'r1s4', 'evt-race2', actor='lia')
released.set()
th2.join(5)
chk('R3b 旧协议 analyze 撞交付 Prepare 占用 → 409 EVENT_PAYLOAD_CONFLICT',
    (h2, c2) == (409, 'EVENT_PAYLOAD_CONFLICT'), 'http=%s code=%s' % (h2, c2))
chk('R3b 交付 Prepare 本身成功完成', out2.get('r') is not None
    and out2['r'].get('status') in ('ready', 'blocked'), 'status=%r' % (out2.get('r') or {}).get('status'))
# R1a：Ready 候选落地后登记保留（owner=analysis_id），直到终态才释放
claim_after = P._event_busy.get(('r1s4', 'evt-race2'))
chk('R3b Ready 候选持有会话级登记（owner 换绑 analysis_id）',
    claim_after is not None and claim_after.get('owner') == out2['r']['analysis_id']
    and claim_after.get('path') == 'delivery',
    'claim=%r' % claim_after)
rc3b = commit(core_slow, 'r1s4', 'evt-race2', out2['r']['analysis_id'])
chk('R3b 提交终态 → 登记成对释放', rc3b.get('status') == 'committed' and not P._event_busy,
    'busy=%r' % P._event_busy)

# R3c（R1a 窗口1）：交付 Provider 阻塞时，同 actor 旧协议 Analyze 也被拒
core = reset_all('r1s5c')
gate2 = threading.Event()
released2 = threading.Event()


def blocking_provider2(provider_input):
    gate2.set()
    released2.wait(2)
    return []


core_slow2 = DeliveryCore(B, protocol=P, evidence_provider=blocking_provider2)
out3 = {}


def t_delivery2():
    try:
        out3['r'] = prepare(core_slow2, 'r1s5c',
                            [communicate('a1', kind='question', content='钥匙在哪')],
                            'evt-race3', actor='player')
    except _ProtoError as e:
        out3['err'] = (e.http, e.code)


th3 = threading.Thread(target=t_delivery2)
th3.start()
gate2.wait(2)
with assets_ctx():
    h3, c3 = err_of(legacy_analyze, 'r1s5c', 'evt-race3', actor='player')   # 同 actor
released2.set()
th3.join(5)
chk('R3c 同 actor 旧协议 Analyze 撞交付占用 → 409 EVENT_PAYLOAD_CONFLICT',
    (h3, c3) == (409, 'EVENT_PAYLOAD_CONFLICT'), 'http=%s code=%s' % (h3, c3))
chk('R3c 结束后只留交付一个候选（旧协议零候选）',
    out3.get('r') is not None
    and not [a for a in P._analyses.values() if a.get('event_id') == 'evt-race3']
    and sum(1 for x in core_slow2._pending.values()
            if x.get('event_id') == 'evt-race3') == 1,
    'delivery_status=%r' % (out3.get('r') or {}).get('status'))

# ---------------------------------------------------------------------------
print('\n[R4] P-F1 · 既有幂等/冲突/失效语义保持（两路各自验证）')
core = reset_all('r1s5')
p1_ = prepare(core, 'r1s5', [transfer('a1')], 'evt-idem')
p2_ = prepare(core, 'r1s5', [transfer('a1')], 'evt-idem')
chk('R4 交付：同载荷重入返回同一 analysis_id', p1_['analysis_id'] == p2_['analysis_id'], '')
h, c = err_of(prepare, core, 'r1s5', [transfer('a1', obj='badge')], 'evt-idem')
chk('R4 交付：同 event 换载荷 → EVENT_PAYLOAD_CONFLICT', (h, c) == (409, 'EVENT_PAYLOAD_CONFLICT'),
    'http=%s code=%s' % (h, c))
base_versions = core.state('r1s5')['versions']
rc1 = commit(core, 'r1s5', 'evt-idem', p1_['analysis_id'], expected=base_versions)
rc2 = commit(core, 'r1s5', 'evt-idem', p1_['analysis_id'], expected=base_versions)
chk('R4 交付：提交后幂等重放 replayed=True，不二次写',
    rc1.get('replayed') is False and rc2.get('replayed') is True, '')
with assets_ctx():
    la1 = legacy_analyze('r1s5', 'evt-legacy', actor='lia')
    la2 = legacy_analyze('r1s5', 'evt-legacy', actor='lia')
    chk('R4 旧协议：同请求重试复用同一 analysis_id',
        la1['analysis_id'] == la2['analysis_id'], '')
    h, c = err_of(legacy_analyze, 'r1s5', 'evt-legacy', actor='lia', message='换了一句台词')
    chk('R4 旧协议：同 event 换 message → EVENT_PAYLOAD_CONFLICT',
        (h, c) == (409, 'EVENT_PAYLOAD_CONFLICT'), 'http=%s code=%s' % (h, c))
    legacy_base = la1['evidence']['base_state_version'] if 'base_state_version' in la1.get('evidence', {}) \
        else P.state_version(('r1s5', 'lia'))
    lc1 = legacy_commit('r1s5', 'lia', la1['analysis_id'], base=legacy_base)
    lc2 = legacy_commit('r1s5', 'lia', la1['analysis_id'], base=legacy_base)
    chk('R4 旧协议：提交后幂等重放 replayed=True',
        lc1.get('replayed') is False and lc2.get('replayed') is True, '')

# ---------------------------------------------------------------------------
print('\n[R8] R1a · 反向 Ready 窗口：旧协议 Ready 后交付 Prepare 被拒（两种 actor 都不绕过）')
core = reset_all('r1s8r')
with assets_ctx():
    la8 = legacy_analyze('r1s8r', 'evt-r8', actor='lia')
chk('R8 前置：旧协议候选 ready，会话级登记保留',
    la8.get('status') in ('ready', 'reference_only')
    and P._event_busy.get(('r1s8r', 'evt-r8'), {}).get('owner') == la8['analysis_id'],
    'claim=%r' % P._event_busy.get(('r1s8r', 'evt-r8')))
h, c = err_of(prepare, core, 'r1s8r', [transfer('a1')], 'evt-r8', actor='player')
chk('R8 交付 Prepare（player）撞旧协议 Ready → 409 EVENT_PAYLOAD_CONFLICT',
    (h, c) == (409, 'EVENT_PAYLOAD_CONFLICT'), 'http=%s code=%s' % (h, c))
h, c = err_of(prepare, core, 'r1s8r', [transfer('a1')], 'evt-r8', actor='lia')
chk('R8 交付 Prepare（同 actor lia）同样被拒', (h, c) == (409, 'EVENT_PAYLOAD_CONFLICT'),
    'http=%s code=%s' % (h, c))
chk('R8 交付侧零候选（Pending 无该 event 候选）',
    not [x for x in core._pending.values() if x.get('event_id') == 'evt-r8'],
    'delivery_pending=%d' % len([x for x in core._pending.values()
                                 if x.get('event_id') == 'evt-r8']))
with assets_ctx():
    lc8 = legacy_commit('r1s8r', 'lia', la8['analysis_id'])
chk('R8 旧协议正常提交 → 登记成对释放',
    lc8.get('status') == 'committed' and not P._event_busy,
    'busy=%r' % P._event_busy)
h, c = err_of(prepare, core, 'r1s8r', [transfer('a1')], 'evt-r8', actor='player')
chk('R8 提交后交付 Prepare 撞墓碑 → EVENT_ALREADY_COMMITTED',
    (h, c) == (409, 'EVENT_ALREADY_COMMITTED'), 'http=%s code=%s' % (h, c))

# ---------------------------------------------------------------------------
print('\n[R9] R1a · 生命周期与 owner 安全（失效释放 / 过期剪除 / 被取代换绑 / Reset）')
# 9a 交付候选因版本推进失效 → 登记释放 → 旧协议可为同 event 建候选
core = reset_all('r1s9b')
pa = prepare(core, 'r1s9b', [transfer('a1')], 'evt-lc')
base_a = core.state('r1s9b')['versions']
pb = prepare(core, 'r1s9b', [transfer('a1', obj='badge')], 'evt-lc2')
commit(core, 'r1s9b', 'evt-lc2', pb['analysis_id'])          # 推进版本
h, c = err_of(commit, core, 'r1s9b', 'evt-lc', pa['analysis_id'], expected=base_a)
chk('9a 旧基准提交 → 409 STATE_VERSION_CONFLICT（候选失效）',
    (h, c) == (409, 'STATE_VERSION_CONFLICT'), 'http=%s code=%s' % (h, c))
chk('9a 失效终态 → 登记成对释放', not P._event_busy, 'busy=%r' % P._event_busy)
with assets_ctx():
    la9 = legacy_analyze('r1s9b', 'evt-lc', actor='lia')
chk('9a 登记释放后旧协议可为同 event 建候选',
    la9.get('status') in ('ready', 'reference_only'), 'status=%r' % la9.get('status'))

# 9b 旧协议候选 TTL 过期 → 登记惰性剪除 → 交付可建候选
core = reset_all('r1s9e')
with assets_ctx():
    lae = legacy_analyze('r1s9e', 'evt-exp', actor='lia')
now[0] += 601                                                 # 越过 READY_TTL_S(600)
h, c = err_of(prepare, core, 'r1s9e', [transfer('a1')], 'evt-exp', actor='player')
chk('9b 旧协议候选过期 → 登记惰性剪除，交付 Prepare 放行',
    (h, c) == (None, None), 'http=%s code=%s' % (h, c))
chk('9b 交付候选已建、登记换绑交付',
    P._event_busy.get(('r1s9e', 'evt-exp'), {}).get('path') == 'delivery',
    'claim=%r' % P._event_busy.get(('r1s9e', 'evt-exp')))

# 9c 被取代（同 sha 换基准重做）→ 登记换绑新候选；旧请求不得释放新登记
core = reset_all('r1s9o')
p1 = prepare(core, 'r1s9o', [transfer('a1')], 'evt-ow')
base1 = core.state('r1s9o')['versions']
p2 = prepare(core, 'r1s9o', [transfer('a1', obj='badge')], 'evt-ow2')
commit(core, 'r1s9o', 'evt-ow2', p2['analysis_id'])           # 推进版本（挪徽章，不动苹果）
p3 = prepare(core, 'r1s9o', [transfer('a1')], 'evt-ow')       # 同 sha 新基准 → C1 被取代
claim9 = P._event_busy.get(('r1s9o', 'evt-ow'))
chk('9c 重做后登记换绑新候选（owner=p3）',
    claim9 is not None and claim9.get('owner') == p3['analysis_id'],
    'claim=%r' % claim9)
h, c = err_of(commit, core, 'r1s9o', 'evt-ow', p1['analysis_id'], expected=base1)
chk('9c 被取代候选提交 → 410 ANALYSIS_INVALIDATED',
    (h, c) == (410, 'ANALYSIS_INVALIDATED'), 'http=%s code=%s' % (h, c))
chk('9c 旧请求不释放新候选的登记（owner 校验）',
    P._event_busy.get(('r1s9o', 'evt-ow'), {}).get('owner') == p3['analysis_id'],
    'claim=%r' % P._event_busy.get(('r1s9o', 'evt-ow')))
rc9 = commit(core, 'r1s9o', 'evt-ow', p3['analysis_id'])
chk('9c 新候选正常提交 → 登记释放',
    rc9.get('status') == 'committed' and not P._event_busy,
    'busy=%r' % P._event_busy)

# 9d Reset 清理会话级登记
core = reset_all('r1s9t')
pt = prepare(core, 'r1s9t', [transfer('a1')], 'evt-rs')
chk('9d 前置：登记存在', ('r1s9t', 'evt-rs') in P._event_busy, '')
P.reset_scope(('r1s9t', 'player'))
chk('9d Reset 后同 session 登记全清', not P._event_busy, 'busy=%r' % P._event_busy)

# ---------------------------------------------------------------------------
print('\n[R10] R1b · Reset 定向与基准失效登记（A 复现两窗口的正式反例）')
# 10a actor 定向 Reset 不得剥离其他角色存活候选的登记
core = reset_all('r1xa')
with assets_ctx():
    lax = legacy_analyze('r1xa', 'evt-r10', actor='lia')
chk('10a 前置：lia 候选 ready 且持登记',
    lax.get('status') in ('ready', 'reference_only')
    and P._event_busy.get(('r1xa', 'evt-r10'), {}).get('owner') == lax['analysis_id'],
    'claim=%r' % P._event_busy.get(('r1xa', 'evt-r10')))
P.reset_scope(('r1xa', 'player'))                     # 定向 Reset **另一**角色
chk('10a 定向 Reset(player) 后 lia 候选仍 ready、登记仍在（不脱离事件登记）',
    lax.get('status') in ('ready', 'reference_only')
    and P._event_busy.get(('r1xa', 'evt-r10'), {}).get('owner') == lax['analysis_id'],
    'status=%r claim=%r' % (lax.get('status'), P._event_busy.get(('r1xa', 'evt-r10'))))
h, c = err_of(prepare, core, 'r1xa', [transfer('a1')], 'evt-r10', actor='player')
chk('10a 同 event 跨入口不可建第二个可提交候选',
    (h, c) == (409, 'EVENT_PAYLOAD_CONFLICT'), 'http=%s code=%s' % (h, c))
P.reset_scope(('r1xa', 'lia'))                        # Reset 归属作用域 → 登记随候选失效释放
chk('10a Reset(lia) 后该作用域登记释放', not P._event_busy, 'busy=%r' % P._event_busy)
h, c = err_of(prepare, core, 'r1xa', [transfer('a1')], 'evt-r10', actor='player')
chk('10a 新 generation 上交付可建候选', (h, c) == (None, None), 'http=%s code=%s' % (h, c))

# 10b 完整 session Reset：登记与候选一同失效，新 generation 可用
core = reset_all('r1xb')
pdb = prepare(core, 'r1xb', [transfer('a1')], 'evt-r10b')
chk('10b 前置：登记存在', ('r1xb', 'evt-r10b') in P._event_busy, '')
P.reset_scope(('r1xb', 'player'))
P.reset_scope(('r1xb', 'lia'))
P.reset_scope(('r1xb', WORLD))
chk('10b 全 session Reset 后登记全清', not P._event_busy, 'busy=%r' % P._event_busy)
h, c = err_of(prepare, core, 'r1xb', [transfer('a1')], 'evt-r10b', actor='player')
chk('10b 新 generation 上可重新 Prepare', (h, c) == (None, None), 'http=%s code=%s' % (h, c))
chk('10b 该 event 恰一个 ready 候选（旧候选已被取代）',
    sum(1 for x in core._pending.values()
        if x.get('event_id') == 'evt-r10b' and x.get('status') == 'ready') == 1,
    'ready=%d' % len([x for x in core._pending.values()
                      if x.get('event_id') == 'evt-r10b' and x.get('status') == 'ready']))

# 10c 交付 Ready 基准失效（未 Commit）→ 跨入口守卫惰性释放登记（A 复现窗口2）
core = reset_all('r1xc')
pc = prepare(core, 'r1xc', [transfer('a1')], 'evt-r10c')
chk('10c 前置：交付 ready 且登记固化 base_versions',
    P._event_busy.get(('r1xc', 'evt-r10c'), {}).get('path') == 'delivery'
    and isinstance(P._event_busy.get(('r1xc', 'evt-r10c'), {}).get('base_versions'), dict),
    'claim=%r' % P._event_busy.get(('r1xc', 'evt-r10c')))
P._bump_revision(('r1xc', 'lia'))                     # 基准推进（未 Commit）
with assets_ctx():
    h, c = err_of(legacy_analyze, 'r1xc', 'evt-r10c', actor='lia')
chk('10c 旧协议 Analyze 不再被失效登记挡住（惰性判 stale 后放行）',
    (h, c) == (None, None), 'http=%s code=%s' % (h, c))
claim_c = P._event_busy.get(('r1xc', 'evt-r10c'))
chk('10c 登记换绑新 protocol 候选（owner=lax 新分析）',
    claim_c is not None and claim_c.get('path') == 'protocol',
    'claim=%r' % claim_c)
h, c = err_of(commit, core, 'r1xc', 'evt-r10c', pc['analysis_id'])
chk('10c 旧交付候选 Commit 明确拒绝（基准失效）',
    (h, c) == (409, 'STATE_VERSION_CONFLICT'), 'http=%s code=%s' % (h, c))
chk('10c 旧请求不误删新登记',
    P._event_busy.get(('r1xc', 'evt-r10c'), {}).get('path') == 'protocol',
    'claim=%r' % P._event_busy.get(('r1xc', 'evt-r10c')))

# 10d 同路径重做：基准推进后同 sha 重做 → 旧候选转终态、登记换绑、旧 Commit 拒绝
core = reset_all('r1xd')
pd1 = prepare(core, 'r1xd', [transfer('a1')], 'evt-r10d')
base_d = core.state('r1xd')['versions']
P._bump_revision(('r1xd', 'lia'))
pd2 = prepare(core, 'r1xd', [transfer('a1')], 'evt-r10d')      # 同 sha 新基准 → 取代
chk('10d 重做成功且登记换绑新候选',
    P._event_busy.get(('r1xd', 'evt-r10d'), {}).get('owner') == pd2['analysis_id'],
    'claim=%r' % P._event_busy.get(('r1xd', 'evt-r10d')))
h, c = err_of(commit, core, 'r1xd', 'evt-r10d', pd1['analysis_id'], expected=base_d)
chk('10d 旧候选 Commit → 410 ANALYSIS_INVALIDATED',
    (h, c) == (410, 'ANALYSIS_INVALIDATED'), 'http=%s code=%s' % (h, c))
chk('10d 旧请求不误删新登记',
    P._event_busy.get(('r1xd', 'evt-r10d'), {}).get('owner') == pd2['analysis_id'],
    'claim=%r' % P._event_busy.get(('r1xd', 'evt-r10d')))
rcd = commit(core, 'r1xd', 'evt-r10d', pd2['analysis_id'])
chk('10d 新候选提交成功 → 登记释放',
    rcd.get('status') == 'committed' and not P._event_busy,
    'busy=%r' % P._event_busy)

# ---------------------------------------------------------------------------
print('\n[R5] F1 · 整轮结果聚合（skipped 不拖低整轮）')
core = reset_all('r1s6')
pre = prepare(core, 'r1s6', [transfer('a1'), communicate('a2', mode='negated', content='')], 'evt-f1')
res = [(r['action_id'], r['execution_status']) for r in pre['outcome']['resolutions']]
chk('R5 前置：一轮 = attempted transfer + skipped negated',
    res == [('a1', 'attempted'), ('a2', 'skipped')], 'res=%r' % res)
chk('R5 预览 result=achieved/success（不再被 skipped 拉成 partial）',
    pre['outcome']['result'] == 'achieved' and pre['outcome']['degree'] == 'success',
    'result=%r degree=%r' % (pre['outcome']['result'], pre['outcome']['degree']))
rec = commit(core, 'r1s6', 'evt-f1', pre['analysis_id'])
chk('R5 回执与预览一致（achieved/success）',
    rec['outcome']['result'] == 'achieved' and rec['outcome']['degree'] == 'success',
    'result=%r' % rec['outcome']['result'])
# 对照 1：attempted + blocked 仍为 partial_success
core = reset_all('r1s7')
pre2 = prepare(core, 'r1s7', [transfer('a1'), communicate('a2', content='')], 'evt-f1b')
res2 = [(r['action_id'], r['execution_status']) for r in pre2['outcome']['resolutions']]
chk('R5 对照：attempted+blocked 仍 partial_success',
    res2 == [('a1', 'attempted'), ('a2', 'blocked')]
    and pre2['outcome']['result'] == 'partial_success',
    'res=%r result=%r' % (res2, pre2['outcome']['result']))
# 对照 2：全 skipped 仍 no_attempt
core = reset_all('r1s8')
pre3 = prepare(core, 'r1s8', [communicate('a1', mode='negated', content='')], 'evt-f1c')
chk('R5 对照：全 skipped 仍 no_attempt 且不可提交',
    pre3['outcome']['result'] == 'no_attempt' and pre3['can_commit'] is False,
    'result=%r can_commit=%s' % (pre3['outcome']['result'], pre3['can_commit']))

# ---------------------------------------------------------------------------
print('\n[R6] P-F2 · analyze 锁外段注入异常 → 占位/候选全释放，可重新分析')
core = reset_all('r1s9')
real_vsd = B.validate_state_delta
calls = {'n': 0}


def boom_vsd(*a, **k):
    calls['n'] += 1
    # validate_state_delta 一次 analyze 被调两次：analyze_core 内部（:2530）一次、
    # 协议锁外校验段（protocol :499+）一次。炸第 2 次才精确命中 P-F2 的无保护窗口
    # （炸第 1 次会被 analyze() 的推理失败包装转成 502，测不到锁外段）。
    if calls['n'] == 2:
        raise RuntimeError('boom-in-review')
    return real_vsd(*a, **k)


with assets_ctx(), mock.patch.object(B, 'validate_state_delta', side_effect=boom_vsd), \
        redirect_stderr(io.StringIO()) as errcap:
    exc = exc_of(legacy_analyze, 'r1s9', 'evt-leak', actor='lia')
chk('R6 首次 analyze 未预期异常原样穿出（非 _ProtoError，不吞根因）',
    isinstance(exc, RuntimeError) and 'boom-in-review' in str(exc)
    and not isinstance(exc, _ProtoError),
    'exc=%r' % exc)
chk('R6 in-flight 占位无残留', not P._inflight, 'inflight=%r' % P._inflight)
chk('R6 会话级占用无残留', not P._event_busy, 'busy=%r' % P._event_busy)
chk('R6 未发布候选无残留（in_flight 记录被回收）',
    not [a for a in P._analyses.values() if a.get('status') == 'in_flight'],
    'analyses=%d' % len(P._analyses))
with assets_ctx():
    la = legacy_analyze('r1s9', 'evt-leak', actor='lia')
chk('R6 同一 event 可立即重新分析', la.get('status') in ('ready', 'reference_only'),
    'status=%r' % la.get('status'))
chk('R6 重新分析后状态一致（in-flight 清空；Ready 候选按 R1a 持有登记）',
    not P._inflight
    and P._event_busy.get(('r1s9', 'evt-leak'), {}).get('owner') == la['analysis_id'],
    'inflight=%r claim=%r' % (P._inflight, P._event_busy.get(('r1s9', 'evt-leak'))))

# ---------------------------------------------------------------------------
print('\n[R7] H-F2 · 两条回滚路径固定 INTERNAL_ERROR 文案，根因进异常链，回滚完整')
MARK = 'SECRET-INTERNAL-MARKER/xyz'
real_bump = P._bump_revision


def boom_bump(scope):
    raise ValueError(MARK)


# 7a commit_state 回滚
core = reset_all('r1s10')
with assets_ctx():
    la = legacy_analyze('r1s10', 'evt-hf2', actor='lia')
    ver0 = P.state_version(('r1s10', 'lia'))
    with mock.patch.object(P, '_bump_revision', side_effect=boom_bump), \
            redirect_stderr(io.StringIO()) as errcap:
        try:
            legacy_commit('r1s10', 'lia', la['analysis_id'])
            e7 = None
        except _ProtoError as e:
            e7 = e
chk('R7a commit_state 回滚 → 500 INTERNAL_ERROR', e7 is not None and e7.http == 500
    and e7.code == 'INTERNAL_ERROR', '')
chk('R7a 客户端 message 为固定文案（无内部 repr/标记）',
    e7 is not None and e7.message == '提交发布失败已回滚（无部分写入）'
    and MARK not in e7.message and '%r' not in e7.message
    and MARK not in json.dumps(e7.details or {}, ensure_ascii=False),
    'message=%r' % (e7.message if e7 else None))
chk('R7a 根因保留在异常链（__cause__）', e7 is not None and isinstance(e7.__cause__, ValueError)
    and MARK in str(e7.__cause__), '')
chk('R7a 回滚完整：版本未动、无 committed 墓碑',
    P.state_version(('r1s10', 'lia')) == ver0
    and not any(b.get('evt-hf2', {}).get('status') == 'committed'
                for (_s, _a), b in P._events.items()),
    'ver=%s' % P.state_version(('r1s10', 'lia')))
with assets_ctx():
    la2 = legacy_analyze('r1s10', 'evt-hf2', actor='lia')
    lc = legacy_commit('r1s10', 'lia', la2['analysis_id'])
chk('R7a 回滚后同一 event 可重新分析并提交', lc.get('status') == 'committed', '')

# 7b 多实体 bundle 回滚（交付 commit）
core = reset_all('r1s11')
pre = prepare(core, 'r1s11', [transfer('a1')], 'evt-hf2b')
ver0 = dict(core.state('r1s11')['versions'])
with mock.patch.object(P, '_bump_revision', side_effect=boom_bump), \
        redirect_stderr(io.StringIO()):
    try:
        commit(core, 'r1s11', 'evt-hf2b', pre['analysis_id'])
        e8 = None
    except _ProtoError as e:
        e8 = e
chk('R7b bundle 回滚 → 500 INTERNAL_ERROR', e8 is not None and e8.http == 500
    and e8.code == 'INTERNAL_ERROR', '')
chk('R7b 客户端 message 为固定文案（无内部 repr/标记）',
    e8 is not None and e8.message == '多实体发布失败，已全回退（无半提交）'
    and MARK not in e8.message and '%r' not in e8.message,
    'message=%r' % (e8.message if e8 else None))
chk('R7b 根因保留在异常链', e8 is not None and isinstance(e8.__cause__, ValueError), '')
chk('R7b 回滚完整：全实体版本未动、无墓碑、候选仍可提交',
    core.state('r1s11')['versions'] == ver0
    and not any('evt-hf2b' in b for (_s, _a), b in P._events.items()),
    'versions_unchanged=%s' % (core.state('r1s11')['versions'] == ver0))
rec = commit(core, 'r1s11', 'evt-hf2b', pre['analysis_id'])
chk('R7b 回滚后原候选可直接重新提交成功',
    rec.get('status') == 'committed' and rec.get('replayed') is False,
    'commit_id=%s' % rec.get('commit_id'))

# ===========================================================================
print()
print('==== 结果：%d 项断言，%d 失败 ====' % (N[0], len(FAIL)))
if FAIL:
    print('失败项：', ', '.join(FAIL))
sys.exit(1 if FAIL else 0)
