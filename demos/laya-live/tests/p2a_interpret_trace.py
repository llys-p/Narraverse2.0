"""P2-A 可读 trace：`interpret → ActionIntent[]`（含真实 DeepSeek 解释调用）。

两段：
  ① 固定假响应段（零网络）：把提示词契约、schema 校验、实体映射、条件、澄清、拒绝路径
     和一条 interpret → prepare → commit 端到端链，逐条打成可读文本。
  ② 真实云端段（默认最多 3 次 DeepSeek 解释调用）：用本机现有配置（`DEEPSEEK_API_KEY`
     或 `LLM_API_KEY`，模型 `LLM_MODEL`，默认 deepseek-flash）。无 key / 认证失败时
     **如实标注未验证**，不寻找或复制密钥、不批量试词。

用法：
  PYTHONIOENCODING=utf-8 python tests/p2a_interpret_trace.py            # 假响应 + 真云端
  PYTHONIOENCODING=utf-8 python tests/p2a_interpret_trace.py --no-live  # 只跑假响应
trace 落 `_diag/p2a_interpret_trace_<ts>.txt`（gitignore 已排除）。
"""
import copy
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import laya_bridge as B  # noqa: E402
import laya_delivery_interpreter as I  # noqa: E402
from laya_delivery_core import WORLD, DeliveryCore  # noqa: E402

OUT = []
SESSION = "p2a-trace"
LIVE_MESSAGES = ["把徽章交给莉亚", "拿到钥匙就开门", "我已经把钥匙给你了"]


def line(s=''):
    OUT.append(s)


def fake(payload):
    raw = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    return lambda system, user: (raw, None)


def action_line(a):
    return ("    %s  op=%s kind=%s mode=%s object=%s targets=%s dep=%s/%s  evidence=%r"
            % (a['id'], a['operation'], a['kind'], a['mode'], a['object_id'],
               a['target_ids'], a['depends_on'], a['when'], a['evidence']))


def main():
    live = '--no-live' not in sys.argv
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
    core.ensure_scene(SESSION)
    d = I.build_entity_directory(core, SESSION)

    line('P2-A 自由语义解释 · 可读 trace')
    line('时间：%s（北京时间）' % time.strftime('%Y-%m-%d %H:%M:%S'))
    line('协议：%s / 提示词：%s' % (I.INTERPRETER_VERSION, I.PROMPT_VERSION))
    line('会话：%s   目录指纹：%s' % (SESSION, d['fingerprint']))
    line('目录实体：' + ', '.join(sorted(I.entity_ids(d))))
    line('模型：%s（LLM_MODEL，默认 deepseek-flash）' % I.cloud_model_name())
    line('=' * 78)

    line('[1] 提示词契约（system 前 12 行；完整提示词在源码 build_interpret_prompt）')
    sys_p, user_p = I.build_interpret_prompt('把徽章交给莉亚', d, 'player', ())
    for row in sys_p.splitlines()[:12]:
        line('    | ' + row)
    line('    --- user 段 ---')
    for row in user_p.splitlines()[:6]:
        line('    | ' + row)
    line('    （user 段同时带上：已提交最近回合并标注「仅供参考」、本轮行动者、玩家原话）')

    line()
    line('[2] 固定假响应：schema / 实体映射 / 逐字证据')
    out = I.interpret('把徽章交给莉亚', directory=d, caller=fake({'actions': [
        {'kind': 'give_item', 'operation': 'transfer', 'targets': ['莉亚'], 'object': '徽章',
         'evidence': ['把徽章交给莉亚']}]}))
    line('    原文：把徽章交给莉亚  →  status=%s' % out['status'])
    for a in out['actions']:
        line(action_line(a))
    line('    实体 ID 全部来自服务端目录：%s'
         % (set(a['target_ids']) | {a['object_id']} <= I.entity_ids(d)))
    line('    source=%s' % out['source'])

    line()
    line('[3] 多动作 + 条件（接口规定的标准输入「拿到钥匙就开门」）')
    d_syn = copy.deepcopy(d)
    d_syn['objects']['cellar_door'] = {'id': 'cellar_door', 'name': '地窖门', 'kind': 'door',
                                       'location': 'tavern', 'owner': None,
                                       'mentions': ['地窖门', '门']}
    out_cond = I.interpret('拿到钥匙就开门', directory=d_syn, caller=fake({'actions': [
        {'kind': 'take', 'operation': 'take', 'object': '钥匙', 'evidence': ['拿到钥匙']},
        {'kind': 'unlock', 'operation': 'unlock', 'object': '门', 'evidence': ['就开门'],
         'depends_on': 0, 'when': 'if_achieved'}]}))
    line('    合成目录（含地窖门 —— 门对象属 P2-B1 场景，本树尚未实现）→ status=%s'
         % out_cond['status'])
    for a in out_cond['actions']:
        line(action_line(a))
    line('    P2 字段（depends_on/when）与 P1 白名单：P1 投影会**拒绝**丢条件 —— %s'
         % _try(lambda: I.to_prepare_intents(out_cond, p1_projection=True)))
    line('    真目录下同一句：%s'
         % _try(lambda: I.interpret('拿到钥匙就开门', directory=d, caller=fake({'actions': [
             {'kind': 'take', 'operation': 'take', 'object': '钥匙', 'evidence': ['拿到钥匙']},
             {'kind': 'unlock', 'operation': 'unlock', 'object': '门', 'evidence': ['就开门'],
              'depends_on': 0, 'when': 'if_achieved'}]}))['invalid_reason'],
             lambda v: 'invalid(%s) —— 不凭空造门，待 B1 接入' % v))
    out_c2 = I.interpret('拿到钥匙就把它交给莉亚', directory=d, caller=fake({'actions': [
        {'kind': 'take', 'operation': 'take', 'object': '钥匙', 'evidence': ['拿到钥匙']},
        {'kind': 'give_item', 'operation': 'transfer', 'targets': ['莉亚'], 'object': '它',
         'evidence': ['就把它交给莉亚'], 'depends_on': 0, 'when': 'if_achieved'}]}))
    line('    用本树已有实体表达同一条件链 → status=%s' % out_c2['status'])
    for a in out_c2['actions']:
        line(action_line(a))

    line()
    line('[4] 已提交历史指代与澄清')
    hist = [{'commit_id': 'dl_x', 'event_id': 'ev0', 'result': 'achieved',
             'owner_changes': [{'object': 'badge', 'from': 'player', 'to': 'lia'}]}]
    out_ref = I.interpret('把它给她', directory=d, history=hist, caller=fake({'actions': [
        {'kind': 'give_item', 'operation': 'transfer', 'targets': ['她'], 'object': '它',
         'evidence': ['把它给她']}]}))
    line('    有已提交历史 → status=%s' % out_ref['status'])
    for a in out_ref['actions']:
        line(action_line(a))
    out_amb = I.interpret('把它给她', directory=d, history=(), caller=fake({'actions': [
        {'kind': 'give_item', 'operation': 'transfer', 'targets': ['她'], 'object': '它',
         'evidence': ['把它给她']}]}))
    line('    无历史且持有两件物品 → status=%s  actions=%s  ambiguities=%s'
         % (out_amb['status'], out_amb['actions'], out_amb['ambiguities']))

    line()
    line('[5] 否定 / 假设 / 引用 / 隐喻威胁 / 声明 / 未知动作 / 伪造实体（逐条拒绝或纠正）')
    cases = [
        ('我不会把徽章给你', {'actions': [{'kind': 'give_item', 'operation': 'transfer',
                                       'targets': ['你'], 'object': '徽章', 'mode': 'negated',
                                       'evidence': ['我不会把徽章给你']}]}, 'mode 透传'),
        ('如果我有苹果我就把苹果交给莉亚', {'actions': [{'kind': 'give_item', 'operation': 'transfer',
                                                'targets': ['莉亚'], 'object': '苹果',
                                                'mode': 'hypothetical',
                                                'evidence': ['如果我有苹果我就把苹果交给莉亚']}]},
         'mode 透传'),
        ('你最好祈祷太阳明天还升得起来', {'actions': [{'kind': 'threat', 'operation': 'attack',
                                              'targets': ['莉亚'],
                                              'evidence': ['你最好祈祷太阳明天还升得起来']}]},
         'attack→communicate 纠偏'),
        ('我已经把钥匙给你了', {'actions': [{'kind': 'claim', 'operation': 'communicate',
                                       'targets': ['莉亚'], 'object': '钥匙',
                                       'evidence': ['我已经把钥匙给你了']}]}, '声明≠transfer'),
        ('偷走他的钱袋', {'actions': [{'kind': 'give_item', 'operation': 'other',
                                  'other_operation': 'steal', 'targets': ['莉亚'],
                                  'evidence': ['偷走他的钱袋']}]}, 'unsupported'),
        ('把水晶球给她', {'actions': [{'kind': 'give_item', 'operation': 'transfer',
                                  'targets': ['她'], 'object': '水晶球',
                                  'evidence': ['把水晶球给她']}]}, '目录外实体 → invalid'),
        ('把徽章交给莉亚', {'actions': [{'kind': 'give_item', 'operation': 'transfer',
                                   'targets': ['莉亚'], 'object': '徽章',
                                   'evidence': ['把徽章交给莉亚'], 'difficulty': 3}]},
         '禁字段 → invalid'),
    ]
    for msg, payload, note in cases:
        r = I.interpret(msg, directory=d, caller=fake(payload))
        detail = r['invalid_reason'] or r['unsupported'] or r['coercions'] or [
            '%s/%s' % (a['operation'], a['kind']) for a in (r['actions'] or r['partial_actions'])]
        line('    %-18s → %-20s %s' % (msg[:18], '%s（%s）' % (r['status'], note), detail))

    line()
    line('[6] 端到端：原文 → 意图 → Prepare → Commit → 下一轮归属（零模型）')
    res = I.interpret_turn(core, SESSION, '把徽章交给莉亚', event_id='ev_trace',
                           caller=fake({'actions': [
                               {'kind': 'give_item', 'operation': 'transfer',
                                'targets': ['莉亚'], 'object': '徽章',
                                'evidence': ['把徽章交给莉亚']}]}))
    line('    prepare_request.actions = %s'
         % json.dumps(res['prepare_request']['actions'], ensure_ascii=False))
    pv = core.prepare_structured(res['prepare_request'])
    line('    Prepare → status=%s can_commit=%s rules_only=%s'
         % (pv['status'], pv['can_commit'], pv['rules_only']))
    rec = core.commit({'session_id': SESSION, 'event_id': 'ev_trace',
                       'analysis_id': pv['analysis_id'],
                       'expected_versions': pv['base_versions']})
    st = core.state(SESSION)
    line('    Commit → %s  owner_changes=%s' % (rec['commit_id'], rec['owner_changes']))
    line('    下一轮 owner: badge=%s apple=%s cellar_key=%s   turn_tick=%s'
         % (st['states'][WORLD]['interaction']['objects']['badge']['owner'],
            st['states'][WORLD]['interaction']['objects']['apple']['owner'],
            st['states'][WORLD]['interaction']['objects']['cellar_key']['owner'],
            st['states'][WORLD]['interaction']['turn_tick']))

    line()
    line('[7] 真实云端语义调用（最多 3 次，不批量试词）')
    if not live:
        line('    --no-live：本轮未做真实调用（只验证了适配器与假响应路径）')
    else:
        has_key = bool(__import__('os').environ.get('DEEPSEEK_API_KEY')
                       or __import__('os').environ.get('LLM_API_KEY'))
        line('    现有配置：has_api_key=%s  model=%s' % (has_key, I.cloud_model_name()))
        if not has_key:
            line('    无可用密钥配置 → 真实调用未验证（不寻找或复制密钥）')
        else:
            hist2 = (core.state(SESSION)['states'][WORLD]['interaction'] or {}).get('turns') or []
            for i, msg in enumerate(LIVE_MESSAGES, 1):
                t0 = time.time()
                r = I.interpret(msg, directory=d, actor_id='player', history=hist2)
                ms = int((time.time() - t0) * 1000)
                line('    调用 #%d 原文=%r  status=%s  %dms' % (i, msg, r['status'], ms))
                line('        reason/detail=%s' % (r['invalid_reason'] or r['invalid_detail']
                                                   or r['unsupported'] or r['ambiguities']))
                for a in (r['actions'] or r['partial_actions']):
                    line('        ' + action_line(a).strip())
                line('        source=%s' % r['source'])
                if r['status'] == 'invalid' and str(r['invalid_reason']).startswith('cloud_'):
                    line('        → 云端不可用（%s），按纪律停止后续真实调用，不改用关键词兜底'
                         % r['invalid_reason'])
                    break

    line()
    line('边界：P2-A 只产出意图/证据/歧义/来源；不判事实、难度、成功，不写游戏状态，'
         '不接 HTTP/页面/Laya/Narration。take/move/unlock 与 depends_on/when 的消费属 P2-B1，'
         'communicate/inspect 与六档对抗属 P2-B2。')

    text = '\n'.join(OUT)
    out_dir = HERE.parent / '_diag'
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / ('p2a_interpret_trace_%s.txt' % time.strftime('%Y%m%d_%H%M%S'))
    out.write_text(text + '\n', encoding='utf-8')
    print(text)
    print('\n[trace 已写入] %s' % out)


def _try(fn, fmt=None):
    try:
        v = fn()
        return json.dumps(v, ensure_ascii=False)[:160] if fmt is None else fmt(v)
    except I.InterpretError as e:
        return '拒绝：%s %s' % (e.reason, e.detail or '')


if __name__ == '__main__':
    main()
