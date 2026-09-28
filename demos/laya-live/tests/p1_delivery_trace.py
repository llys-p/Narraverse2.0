"""P1 物品交付 · 可读的无模型 trace 生成器。

跑一遍最小纵向切片并把每一步的可读证据落到文本：
    服务端场景初始化 → Prepare（零写入）→ Prepare 前后正式状态复核
    → Commit → 下一轮读取新归属 → 重复提交（幂等）→ 硬前提反例

零模型、零云端、不启动服务、不写正式项目资产；trace 落在 `_diag/`（gitignore）。
运行：`PYTHONIOENCODING=utf-8 python tests/p1_delivery_trace.py`
"""
import copy
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import laya_bridge as B  # noqa: E402
from laya_delivery_core import WORLD, DeliveryCore  # noqa: E402
from laya_state_protocol import _ProtoError  # noqa: E402

SESSION = "p1trace"
OUT = []


def line(s=''):
    OUT.append(s)


def main():
    B.reset_actor_state()
    B.reset_history()
    B._PENDING.clear()
    P = B.PROTOCOL
    with P.lock:
        P._events.clear()
        P._buckets.clear()
        P._analyses.clear()
        P._inflight.clear()

    line('P1 物品交付 · 无模型 trace')
    line('时间：%s（北京时间）' % time.strftime('%Y-%m-%d %H:%M:%S'))
    line('环境：零模型推理 / 零云端调用 / 未启动任何服务 / 无 HTTP')
    line('协议：laya-delivery-v1   场景：fusion-tavern-v1   会话：%s' % SESSION)
    line('=' * 78)

    core = DeliveryCore(B, protocol=P)
    line('[0] 未初始化时先 Prepare（服务端场景初始化与 Prepare 分离，不得拿模板当正式状态）')
    probe = core.state(SESSION)
    line('    state(): initialized=%s' % probe['initialized'])
    try:
        core.prepare_structured({
            'session_id': SESSION, 'event_id': 'ev_probe', 'actor_id': 'player',
            'expected_versions': probe['versions'],
            'actions': [{'id': 'a0', 'operation': 'transfer', 'target_ids': ['lia'],
                         'object_id': 'badge', 'mode': 'attempt', 'evidence': '把徽章给莉亚'}]})
        line('    → 未被拒（异常）')
    except _ProtoError as e:
        line('    → 被拒：%s（http %s）；Pending 数量=%d' % (e.code, e.http, len(core._pending)))
    created = core.ensure_scene(SESSION)
    line('[0b] 服务端场景初始化 ensure_scene() → 新建实体：%s（首次初始化推进各实体版本）'
         % ', '.join(created))
    line('     再次 ensure_scene() → 新建：%s（幂等）'
         % (', '.join(core.ensure_scene(SESSION)) or '无'))

    def dump_state(title):
        st = core.state(SESSION)
        w = st['states'][WORLD]['interaction']
        line('%s' % title)
        line('    versions: ' + ' | '.join('%s=%s' % (k, v) for k, v in sorted(st['versions'].items())))
        line('    owner: badge=%s | apple=%s | cellar_key=%s'
             % (w['objects']['badge']['owner'], w['objects']['apple']['owner'],
                w['objects']['cellar_key']['owner']))
        line('    turn_tick=%s  turns=%d  facts=%d'
             % (w['turn_tick'], len(w['turns']), len(w['facts'])))
        return st

    state_before = dump_state('[1] Prepare 之前：GET /state')
    before_state, before_ver = copy.deepcopy(B._ACTOR_STATE), dict(state_before['versions'])

    line()
    line('[2] Prepare（结构化 ActionIntent，内部注入；零游戏写入）')
    line('    intent a1: operation=transfer  actor=player  target=[lia]  object=badge  mode=attempt')
    line('    玩家原文（仅进 trace，不参与裁决）："把徽章交给莉亚"')
    pv = core.prepare_structured({
        'session_id': SESSION, 'event_id': 'ev_trace', 'actor_id': 'player',
        'expected_versions': state_before['versions'],
        'actions': [{'id': 'a1', 'operation': 'transfer', 'target_ids': ['lia'],
                     'object_id': 'badge', 'mode': 'attempt', 'kind': 'give_item',
                     'content': '把徽章交给莉亚',
                     'evidence': '把徽章交给莉亚'}]})
    line('    → analysis_id=%s' % pv['analysis_id'])
    line('    → status=%s  can_commit=%s  rules_only=%s  laya_evidence=%s  source=%s'
         % (pv['status'], pv['can_commit'], pv['rules_only'], pv['laya_evidence'], pv['source']))
    line('    → Canonical Outcome: result=%s degree=%s' % (pv['outcome']['result'], pv['outcome']['degree']))
    for r in pv['outcome']['resolutions']:
        line('        逐动作 %s: degree=%s  achieved=%s' % (r['action_id'], r['degree'], r['achieved']))
    line('    → State Proposal（候选，未发布）：')
    for ch in pv['state_proposal']['changes']:
        line('        %s %s: %r → %r' % (ch['entity_id'], ch['path'], ch['before'], ch['after']))

    line()
    line('[3] Prepare 之后复核（正式状态必须与之前完全一致）')
    after_state = copy.deepcopy(B._ACTOR_STATE)
    state_after = core.state(SESSION)
    line('    正式状态深比较一致：%s' % (after_state == before_state))
    line('    版本未变：%s（%s）' % (state_after['versions'] == before_ver,
                                    '所有实体版本相同' if state_after['versions'] == before_ver else '有变化'))
    line('    badge.owner 仍为 player：%s' % (state_after['states'][WORLD]['interaction']['objects']['badge']['owner'] == 'player'))
    line('    turn_tick 仍为 0：%s   turns 仍为 0：%s'
         % (state_after['states'][WORLD]['interaction']['turn_tick'] == 0,
            len(state_after['states'][WORLD]['interaction']['turns']) == 0))

    line()
    line('[4] Commit（唯一写入口；锁内重验版本 + 重算 + 原子发布）')
    rec = core.commit({'session_id': SESSION, 'event_id': 'ev_trace',
                       'analysis_id': pv['analysis_id'],
                       'expected_versions': pv['base_versions']})
    line('    commit_id=%s  replayed=%s  status=%s' % (rec['commit_id'], rec['replayed'], rec['status']))
    for oc in rec['owner_changes']:
        line('    owner change: %s  %s → %s' % (oc['object'], oc['from'], oc['to']))
    line('    versions: ' + ' | '.join('%s=%s' % (k, v) for k, v in sorted(rec['versions'].items())))
    line('    回执标注：rules_only=%s  laya_evidence=%s  source=%s'
         % (rec['rules_only'], rec['laya_evidence'], rec['source']))

    line()
    st = dump_state('[5] 下一轮：重新读取场景（新归属已可见）')

    line()
    line('[6] 重复提交同一 event / 同一 analysis（网络重试）')
    re2 = core.commit({'session_id': SESSION, 'event_id': 'ev_trace',
                       'analysis_id': pv['analysis_id'],
                       'expected_versions': pv['base_versions']})
    st2 = core.state(SESSION)
    line('    replayed=%s  commit_id 相同=%s' % (re2['replayed'], re2['commit_id'] == rec['commit_id']))
    line('    turn_tick 仍为 %s（未推进时钟），turns 仍为 %d（未二次转移）'
         % (st2['states'][WORLD]['interaction']['turn_tick'],
            len(st2['states'][WORLD]['interaction']['turns'])))
    line('    已提交候选立即释放 Pending 容量：pending=%d（回执改由协议事件表长期提供）'
         % len(core._pending))

    line()
    line('[6b] 事件身份按 (session_id, event_id)：另一 actor 借同一 event 被拒（该 event 已提交）')
    try:
        core.prepare_structured({
            'session_id': SESSION, 'event_id': 'ev_trace', 'actor_id': 'lia',
            'expected_versions': st2['versions'],
            'actions': [{'id': 'a3', 'operation': 'transfer', 'target_ids': ['player'],
                         'object_id': 'badge', 'mode': 'attempt', 'evidence': '把徽章给玩家'}]})
        line('    → 未被拒（异常）')
    except _ProtoError as e:
        line('    → 被拒：%s（http %s）' % (e.code, e.http))

    line()
    line('[7] 硬前提反例：交付一件自己并未持有的物品（cellar_key，owner=None）')
    pv_bad = core.prepare_structured({
        'session_id': SESSION, 'event_id': 'ev_bad', 'actor_id': 'player',
        'expected_versions': st2['versions'],
        'actions': [{'id': 'a2', 'operation': 'transfer', 'target_ids': ['lia'],
                     'object_id': 'cellar_key', 'mode': 'attempt',
                     'evidence': '把地窖钥匙给莉亚'}]})
    line('    → status=%s  can_commit=%s  reason_codes=%s'
         % (pv_bad['status'], pv_bad['can_commit'], pv_bad['reason_codes']))
    try:
        core.commit({'session_id': SESSION, 'event_id': 'ev_bad',
                     'analysis_id': pv_bad['analysis_id'],
                     'expected_versions': pv_bad['base_versions']})
        line('    → commit 未被拒（异常）')
    except _ProtoError as e:
        line('    → commit 被拒：%s（http %s）' % (e.code, e.http))
    line('    cellar_key.owner 仍为 %s（未凭空转移）'
         % core.state(SESSION)['states'][WORLD]['interaction']['objects']['cellar_key']['owner'])

    line()
    line('结论：Prepare 前后正式状态与版本完全一致；Commit 后物品由 player 转到 lia，'
         '下一轮快照读到新归属；重复提交返回原回执且未二次转移；硬前提不满足时不产生可提交候选。')
    line('边界：本 trace 全部走服务端规则（rules_only），没有 Laya 证据、没有自由语言 '
         'Interpreter、没有云端叙事，也没有 P2 的 take/move/unlock 玩法。')

    text = '\n'.join(OUT)
    out_dir = HERE.parent / '_diag'
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / ('p1_delivery_trace_%s.txt' % time.strftime('%Y%m%d_%H%M%S'))
    out.write_text(text + '\n', encoding='utf-8')
    print(text)
    print('\n[trace 已写入] %s' % out)


if __name__ == '__main__':
    main()
