"""ZCode 副手审查 · 协议层底座（laya_state_protocol.py）定向反例（秒级：零模型、零云端、零 HTTP）。

基线：fusion 保存点 d446336（隔离树 D:/Narraverse2.0-zreview，分支 zcode/review-delivery-evidence）。
只读审查的唯一反例脚本；不修改任何生产代码。每个反例只验证一个疑点，全部确定性、可重复：

  F1  事件身份作用域错位 → 同一 event_id 在同一会话被两条路径各提交一次（双重提交）
      交付路径（DeliveryCore.commit → commit_multi_entity_bundle，laya_state_protocol.py:987-1083）
      把事件墓碑记在 (sid, requester) 桶，且 DeliveryCore._find_event
      （laya_delivery_core.py:1464-1469）跨全会话桶查重；而协议路径 analyze/commit_state
      （laya_state_protocol.py:392-404 / :709-847）只在**本 (sid, actor) 桶**内查重。
      → 交付已提交的 event，换一个 actor 走 /analyze + /commit_state 可再次提交成功。
  F2  analyze() 锁外段（laya_state_protocol.py:496-567）无任何 try/finally：
      未预期异常（这里用注入的 RuntimeError 代表任意未预期异常）会**永久泄漏**
      _inflight[(scope,event,base)] 单飞占位 + 一条 in_flight 候选；
      _cleanup_expired（:288-312）永远不回收 in_flight → 同 (scope,event,base)
      从此只能 409 ANALYSIS_IN_PROGRESS，直到进程重启（对照：TranslationFailure /
      analyze_core 失败 / fallback 回落三条路径都刻意 _release_inflight，:454-457 /
      :475-484 / :489-494 —— 覆盖缺口是疏漏而非设计）。
  F3  _maybe_stale（:275-286）把已 expired 的候选改标 stale 并把 terminal_at 刷成
      「查询时刻」，违反 P2-A 协议 §「expired 的终态时间取原 expires_at，不因晚查询
      而延长」（tasks/P2-A-Analyze-Commit协议.md:234）→ 终态保留期被晚查询拉长。

引擎/翻译/档案边界沿用 tests/p2b1_unit.py 的既定 mock 模式（assets_ctx，零模型）；
F1 交付侧走**真实** DeliveryCore.prepare_structured + commit（纯规则、零模型）。

用法：PYTHONIOENCODING=utf-8 python tests/review_zcode_protocol_probe.py
"""
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B  # noqa: E402  （只读 narra_config.json；模型懒加载，不触发）
from laya_delivery_core import DeliveryCore  # noqa: E402
from laya_state_protocol import _ProtoError  # noqa: E402

FAIL = []
N = [0]


def chk(tag, ok, detail=''):
    N[0] += 1
    print('  [%s] %s%s' % ('REPRO-CONFIRMED' if ok else 'not-reproduced', tag,
                           (' | ' + detail) if detail else ''))
    if not ok:
        FAIL.append(tag)


# ---------------------------------------------------------------------------
# 引擎/翻译/档案边界桩（沿用 tests/p2b1_unit.py 的既定模式，零模型零云端）
# ---------------------------------------------------------------------------
FAKE_CHECK = {"matched": True, "fresh": True, "problems": [],
              "code_changed": True, "checkpoint": "typed-decisions", "profile_id": "fp_t"}
FAKE_PROF = {"checkpoint": "typed-decisions", "profile_id": "fp_t", "signals": {
    "doubt_shift": {"grade": "A", "status": "active", "role": "state_shift"},
    "trust_shift": {"grade": "C", "status": "auxiliary", "role": "state_shift"},
    "fondness_shift": {"grade": "C", "status": "auxiliary", "role": "state_shift"},
    "respect_shift": {"grade": "D", "status": "disabled", "role": "state_shift"},
    "alert_shift": {"grade": "D", "status": "disabled", "role": "state_shift"},
    "goal_shift": {"grade": "D", "status": "disabled", "role": "state_shift"},
}}
FAKE_DELTAS = ([
    {"question": "doubt_shift", "target": "relationship.doubt", "delta": 3.0,
     "label": "怀疑", "raw": 2.4, "range": [0, 100]},
], {})


def _fake_engine():
    return SimpleNamespace(
        ready=True, model_name=None, detail="stub-fake", last_error=None,
        predict=lambda _state, _q: {"answers": B.fallback_decide(B.CFG["actor"], None, "", _q)[0]},
        device_label=lambda: "cpu (fake)", describe=lambda: {"kind": "fake"})


@contextmanager
def assets_ctx():
    eng = {"ready": True, "model_name": B.DEFAULT_MODEL_NAME, "detail": "stub"}
    with mock.patch.object(B, 'load_capability_profile',
                           side_effect=lambda m: (__import__('copy').deepcopy(FAKE_PROF),
                                                  dict(FAKE_CHECK))), \
         mock.patch.object(B, 'load_capability_profiles', return_value={"profiles": {}}), \
         mock.patch.object(B, 'build_deltas',
                           side_effect=lambda a, q, ac: __import__('copy').deepcopy(FAKE_DELTAS)), \
         mock.patch.object(B, '_cached_translate', return_value="EN_TEST"), \
         mock.patch.object(B, '_engine_identity', return_value=eng), \
         mock.patch.object(B, 'ENGINE', _fake_engine()):
        yield


def fresh(session):
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


def transfer(aid='a1', obj='apple', target='lia', mode='attempt'):
    return {'id': aid, 'operation': 'transfer', 'target_ids': [target],
            'object_id': obj, 'mode': mode}


# ============================================================================
print('F1 事件身份作用域错位：交付已提交的 event 经聊天协议再次提交（双重提交）')
# ============================================================================
EVT = 'evt_zp_delivery_1'
core, P, sid = fresh('zpf1')

# ---- 交付路径（真实 prepare + commit，纯规则零模型）----
pre = core.prepare_structured({
    "session_id": sid, "event_id": EVT, "actor_id": "player",
    "expected_versions": core.state(sid)["versions"], "actions": [transfer()],
})
chk('F1 交付 prepare ready', pre["can_commit"] is True,
    'status=%s' % pre["status"])
drec = core.commit({
    "session_id": sid, "event_id": EVT, "analysis_id": pre["analysis_id"],
    "expected_versions": core.state(sid)["versions"],
})
chk('F1 交付 commit 成功（apple 归 lia，world.turns=1）',
    drec["status"] == "committed" and drec["replayed"] is False
    and B._ACTOR_STATE[(sid, "ic_world")]["interaction"]["objects"]["apple"]["owner"] == "lia"
    and len(B._ACTOR_STATE[(sid, "ic_world")]["interaction"]["turns"]) == 1,
    'commit_id=%s' % drec.get("commit_id"))
rec_player = P._events[(sid, "player")][EVT]
chk('F1 交付墓碑落在 (sid,player) 桶、带 interaction_receipt',
    rec_player.get("status") == "committed" and rec_player.get("interaction_receipt") is not None,
    'keys=%s' % sorted(rec_player))

# ---- 协议路径：同一 event_id，另一 actor（lia），真实 analyze + commit_state ----
doubt_before = B._ACTOR_STATE[(sid, "lia")]["relationship"]["doubt"]
with assets_ctx():
    r = P.analyze({
        "session_id": sid, "actor_id": "lia", "event_id": EVT,
        "message": "这苹果就交给你了（同一事件换协议通道重放）",
        "expected_state_version": P.state_version((sid, "lia")),
        "context": {"scene": "旅店大厅", "history": []},
    })
    chk('F1 协议 analyze 未被交付墓碑拦截（ EVENT_ALREADY_COMMITTED 未触发）',
        r["status"] in ("ready", "reference_only"), 'status=%s' % r["status"])
    crec = P.commit_state({
        "session_id": sid, "actor_id": "lia", "analysis_id": r["analysis_id"],
        "expected_state_version": r["base_state_version"],
    })
    chk('F1 协议 commit_state 对同一 event 再度提交成功',
        crec.get("status") == "committed" and crec.get("replayed") is False,
        'commit_id=%s state_version=%s' % (crec.get("commit_id"), crec.get("state_version")))

recs = sorted("%s/%s" % k for k, v in P._events.items() if EVT in v)
chk('F1 同一会话同一 event_id 出现两条 committed 墓碑（双重提交成立）', len(recs) == 2,
    'scopes=%s' % recs)
rec_lia = P._events[(sid, "lia")][EVT]
chk('F1 协议墓碑覆盖语义：无 interaction_receipt、sha 为消息摘要',
    rec_lia.get("interaction_receipt") is None and rec_lia.get("sha") == r["evidence"]["input_sha256"],
    'keys=%s' % sorted(rec_lia))
doubt_after = B._ACTOR_STATE[(sid, "lia")]["relationship"]["doubt"]
chk('F1 同一逻辑事件产生了第二份状态写（协议写项作用于 lia 关系值）',
    abs(doubt_after - doubt_before) > 1e-9,
    'before=%s after=%s applied=%s'
    % (doubt_before, doubt_after,
       [(d.get("source_signal"), d.get("delta"), d.get("new_value"))
        for d in crec.get("applied_delta") or []]))

# ---- 对照组：同 event 同路径（player 桶）会被拦 —— 证明缺口只在作用域 ----
with assets_ctx():
    try:
        P.analyze({
            "session_id": sid, "actor_id": "player", "event_id": EVT,
            "message": "对照：同一 actor 走协议路径",
            "expected_state_version": P.state_version((sid, "player")),
            "context": {},
        })
        chk('F1 对照组被 EVENT_ALREADY_COMMITTED 拦截', False, '未抛错')
    except _ProtoError as e:
        chk('F1 对照组被 EVENT_ALREADY_COMMITTED 拦截',
            e.code == "EVENT_ALREADY_COMMITTED", 'code=%s' % e.code)

# ============================================================================
print('F2 analyze() 锁外段未预期异常 → _inflight 单飞占位永久泄漏（同事件永久 409）')
# ============================================================================
EVT2 = 'evt_zp_leak_2'
core2, P2, sid2 = fresh('zpf2')
req2 = {
    "session_id": sid2, "actor_id": "lia", "event_id": EVT2,
    "message": "触发未预期异常的消息",
    "expected_state_version": P2.state_version((sid2, "lia")),
    "context": {"scene": "旅店大厅", "history": []},
}
expected2 = req2["expected_state_version"]
# analyze_core 内部（laya_bridge.py:2530）会先调一次 validate_state_delta（被
# analyze() 的 except Exception 包住，:473-484）；协议自己在 :499 的那次调用在
# 锁外**无任何保护**。让第 1 次调用走真实现、第 2 次（协议那次）抛 RuntimeError，
# 即可精确命中未保护窗口。
real_vsd = B.validate_state_delta
_vsd_calls = [0]


def _vsd_then_boom(*a, **k):
    _vsd_calls[0] += 1
    if _vsd_calls[0] >= 2:
        raise RuntimeError('boom-in-review')
    return real_vsd(*a, **k)


with assets_ctx(), \
        mock.patch.object(B, 'validate_state_delta', side_effect=_vsd_then_boom):
    raw_err = None
    try:
        P2.analyze(req2)
    except RuntimeError as e:
        raw_err = e
    except _ProtoError as e:
        raw_err = e
    chk('F2 未预期异常原样穿出 analyze（非 _ProtoError，HTTP 层只会 500）',
        isinstance(raw_err, RuntimeError), 'raised=%r' % (raw_err,))
chk('F2 _inflight 单飞占位残留',
    ((sid2, "lia"), EVT2, expected2) in P2._inflight,
    'inflight_keys=%s' % list(P2._inflight))
leaked = [a for a in P2._analyses.values() if a["status"] == "in_flight"]
chk('F2 in_flight 候选残留（容量槽被占）', len(leaked) == 1,
    'analyses=%d' % len(P2._analyses))
reclaimed = P2._cleanup_expired()
chk('F2 _cleanup_expired 不回收 in_flight（返回 0、记录仍在）',
    reclaimed == 0 and len(leaked) == 1 and leaked[0]["status"] == "in_flight",
    'cleanup=%d' % reclaimed)
with assets_ctx():
    try:
        P2.analyze(req2)   # 同 event 同基准版本重试 —— 唯一变化是上次失败过
        chk('F2 同 (scope,event,base) 重试被永久 409 ANALYSIS_IN_PROGRESS 楔死',
            False, '第二次 analyze 意外成功')
    except _ProtoError as e:
        chk('F2 同 (scope,event,base) 重试被永久 409 ANALYSIS_IN_PROGRESS 楔死',
            e.code == "ANALYSIS_IN_PROGRESS",
            'code=%s current=%s' % (e.code, P2.state_version((sid2, "lia"))))

# ============================================================================
print('F3 _maybe_stale 把 expired 候选改标 stale 并刷新 terminal_at（终态保留期被拉长）')
# ============================================================================
EVT3 = 'evt_zp_ttl_3'
core3, P3, sid3 = fresh('zpf3')
fake_now = [1000.0]
P3.now = lambda: fake_now[0]
try:
    with assets_ctx():
        r3 = P3.analyze({
            "session_id": sid3, "actor_id": "lia", "event_id": EVT3,
            "message": "TTL 探针", "expected_state_version": P3.state_version((sid3, "lia")),
            "context": {},
        })
        expires_at = r3["expires_at_epoch"] if "expires_at_epoch" in r3 else None
        a3 = P3._analyses[r3["analysis_id"]]
        orig_exp = a3["expires_at"]                       # 1600.0
        fake_now[0] = orig_exp + 400.0                    # 晚 400s 才有人查询
        P3._bump_revision((sid3, "lia"))                  # 期间版本前进
        q3 = P3.get_analysis(r3["analysis_id"], sid3, "lia")
        chk('F3 expired 被改标 stale 且 terminal_at=查询时刻（应为 expires_at）',
            q3["status"] == "stale"
            and abs(a3["terminal_at"] - (orig_exp + 400.0)) < 1e-9
            and abs(a3["terminal_at"] - orig_exp) > 1e-9,
            'status=%s terminal_at=%s expires_at=%s' % (q3["status"], a3["terminal_at"], orig_exp))
finally:
    P3.now = time.time

# ============================================================================
print('')
print('=' * 72)
print('结果：%d/%d 确认 %s' % (N[0] - len(FAIL), N[0],
                              ('；未确认：' + '、'.join(FAIL)) if FAIL else ''))
print('=' * 72)
sys.exit(1 if FAIL else 0)
