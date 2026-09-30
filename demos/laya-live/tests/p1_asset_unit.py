"""P1 资产一致性聚焦自测（秒级：零模型加载、零云端调用、不触碰冻结源）。

对应《P1-执行提示词》§C 的 1–5：
  D1  行尾兼容：LF 与 CRLF 同内容都匹配档案；改用例内容 / 增删用例文件 → 拒绝
  D2  冻结基线：137/137 匹配；缺一条 / 改一条 / 坏文件 → 拒绝；真基线哈希前后不变
  D3  翻译同源：命中冻结译文不调在线；运行缓存增长/漂移不影响基线；基线缺失不静默换源
  M1  模型目录：配置同时作用于查找（推理输入）与校验；未知/缺指定检查点 fail-closed
  P1  门禁：两检查点 active 集合与档案一致；C/auxiliary 不进 writable delta；无档案零 delta

所有有意损坏的操作都在临时副本上进行；本文件只读真实档案与冻结基线。
"""
import json
import os
import shutil
import sys
import tempfile
import types
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B

FAIL = []
N = [0]


def chk(tag, ok, detail=''):
    N[0] += 1
    print('  %s [%s] %s' % ('✅' if ok else '❌', tag, detail))
    if not ok:
        FAIL.append(tag)


# ---- 真实档案证据（只读导入一次，后续全部与它比对）----------------------
_REAL_TS = Path(B.TESTS_DIR)
_ARCH = json.loads((_REAL_TS / 'capability_profiles.json').read_text(encoding='utf-8'))
_PROF = _ARCH['profiles']
_TD_ARCH = _PROF['typed-decisions']
_EN_ARCH = _PROF['english']
DS_SHA = _TD_ARCH['evidence']['dataset']['sha']
XLATE_SHA = _TD_ARCH['evidence']['translation_cache']['sha']
CKPT_TD = _TD_ARCH['evidence']['checkpoint']['id']


def _reset_frozen_memo():
    B._FROZEN_XLATE_MEMO.update({"path": None, "mtime": None, "blob": None})


def _copy_cases(root, eol):
    """把真实 4 个用例文件复制成指定的行尾（LF / CRLF）。重复调用是清空重写。"""
    d = root / 'cases'
    if d.exists():
        shutil.rmtree(d)
    d.mkdir()
    for p in sorted((_REAL_TS / 'cases').glob('*.json')):
        b = p.read_bytes().replace(b'\r\n', b'\n')
        if eol == 'crlf':
            b = b.replace(b'\n', b'\r\n')
        (d / p.name).write_bytes(b)
    return d


def _first_case_text():
    return B._case_texts()[0]


print('=' * 92)
print('P1 资产一致性聚焦自测')
print('=' * 92)

# ===========================================================================
print("\nD1 行尾兼容（仅 CRLF→LF 归一，完整文件集合与档案一致才放行）")
# ===========================================================================
with tempfile.TemporaryDirectory(prefix='p1_d1_') as _td:
    root = Path(_td)
    _copy_cases(root, 'crlf')
    with mock.patch.object(B, 'TESTS_DIR', root):
        ds = B._dataset_fingerprint()
    chk('D1 CRLF：raw 与档案不符（仅行尾差异）',
        ds['sha'] != DS_SHA, 'raw=%s…' % ds['sha'][:12])
    chk('D1 CRLF：sha_lf 与档案完全匹配',
        ds['sha_lf'] == DS_SHA, 'lf=%s… crlf_files=%s' % (ds['sha_lf'][:12], ds['crlf_files']))
    chk('D1 CRLF：逐文件也都匹配（files_lf 聚合一致）',
        ds['n_files'] == 4 and ds['sha_lf'] == DS_SHA,
        'n_files=%d' % ds['n_files'])

    # LF 版本：raw 与 lf 都应匹配档案
    _copy_cases(root, 'lf')
    with mock.patch.object(B, 'TESTS_DIR', root):
        ds = B._dataset_fingerprint()
    chk('D1 LF：raw 与 sha_lf 都匹配档案',
        ds['sha'] == DS_SHA and ds['sha_lf'] == DS_SHA,
        'raw=%s… lf=%s…' % (ds['sha'][:12], ds['sha_lf'][:12]))

    # 反例 a：改用例内容（CRLF 下改一个字）→ 两个哈希都失配，拒绝
    obs = root / 'cases' / 'observable.json'
    blob = json.loads(obs.read_text(encoding='utf-8'))
    blob['cases'][0]['text'] = blob['cases'][0]['text'] + '。'
    raw = json.dumps(blob, ensure_ascii=False, indent=2).replace('\n', '\r\n').encode('utf-8')
    obs.write_bytes(raw)
    with mock.patch.object(B, 'TESTS_DIR', root):
        ds = B._dataset_fingerprint()
    chk('D1 改用例内容：raw 与 sha_lf 都失配（拒绝）',
        ds['sha'] != DS_SHA and ds['sha_lf'] != DS_SHA,
        'lf=%s…' % ds['sha_lf'][:12])

    # 反例 b：增 / 删用例文件 → 拒绝
    _copy_cases(root, 'crlf')
    (root / 'cases' / 'extra.json').write_text('{"cases": []}', encoding='utf-8')
    with mock.patch.object(B, 'TESTS_DIR', root):
        ds = B._dataset_fingerprint()
    chk('D1 增加用例文件：sha_lf 失配（拒绝）', ds['sha_lf'] != DS_SHA,
        'n_files=%d lf=%s…' % (ds['n_files'], ds['sha_lf'][:12]))
    (root / 'cases' / 'extra.json').unlink()
    (root / 'cases' / 'observable.json').unlink()
    with mock.patch.object(B, 'TESTS_DIR', root):
        ds = B._dataset_fingerprint()
    chk('D1 删除用例文件：sha_lf 失配（拒绝）', ds['sha_lf'] != DS_SHA,
        'n_files=%d lf=%s…' % (ds['n_files'], ds['sha_lf'][:12]))

# ===========================================================================
print("\nD2 冻结基线（137/137 命中；缺/改/坏都拒绝；真基线不被触碰）")
# ===========================================================================
_frozen_real_sha = None
with tempfile.TemporaryDirectory(prefix='p1_d2_') as _td:
    root = Path(_td)
    _copy_cases(root, 'crlf')
    with tempfile.NamedTemporaryFile('w', suffix='.json', encoding='utf-8', delete=False) as _f:
        _frozen_real_sha = B._sha256_file(B._XLATE_FROZEN)
        _f = Path(_f.name)
        _f.write_text((_REAL_TS / 'assets' / 'translation_cache.json').read_text(encoding='utf-8'),
                      encoding='utf-8')
        with mock.patch.object(B, 'TESTS_DIR', root), mock.patch.object(B, '_XLATE_FROZEN', _f):
            _reset_frozen_memo()
            xs = B._xlate_subset_fingerprint()
        chk('D2 冻结基线 137/137 命中且子集哈希与档案一致',
            xs['n_missing'] == 0 and xs['sha'] == XLATE_SHA,
            'present=%d/%d sha=%s…' % (xs['n_present'], xs['n_texts'], xs['sha'][:12]))
        chk('D2 来源指到冻结基线（与运行缓存分离）', xs['source'] == str(_f),
            'source=%s' % xs['source'])

        # 缺一条
        t = _first_case_text()
        broken = json.loads(_f.read_text(encoding='utf-8'))
        del broken[t]
        _f.write_text(json.dumps(broken, ensure_ascii=False), encoding='utf-8')
        with mock.patch.object(B, 'TESTS_DIR', root), mock.patch.object(B, '_XLATE_FROZEN', _f):
            _reset_frozen_memo()
            xs = B._xlate_subset_fingerprint()
        chk('D2 缺一条基线译文：n_missing=1 且哈希失配（拒绝）',
            xs['n_missing'] == 1 and xs['sha'] != XLATE_SHA,
            'missing=%d sha=%s…' % (xs['n_missing'], xs['sha'][:12]))

        # 改一条（先恢复完整基线再改，确保改动落在 137 条子集内）
        _f.write_text((_REAL_TS / 'assets' / 'translation_cache.json').read_text(encoding='utf-8'),
                      encoding='utf-8')
        t2 = _first_case_text()
        broken = json.loads(_f.read_text(encoding='utf-8'))
        broken[t2] = 'CHANGED_' + broken[t2]
        _f.write_text(json.dumps(broken, ensure_ascii=False), encoding='utf-8')
        with mock.patch.object(B, 'TESTS_DIR', root), mock.patch.object(B, '_XLATE_FROZEN', _f):
            _reset_frozen_memo()
            xs = B._xlate_subset_fingerprint()
        chk('D2 改一条基线译文：哈希失配（拒绝）',
            xs['sha'] != XLATE_SHA, 'sha=%s…' % xs['sha'][:12])

        # 坏文件
        _f.write_text('not a json {{', encoding='utf-8')
        with mock.patch.object(B, 'TESTS_DIR', root), mock.patch.object(B, '_XLATE_FROZEN', _f):
            _reset_frozen_memo()
            xs = B._xlate_subset_fingerprint()
        chk('D2 坏基线文件：source_error 非空且 0 命中（拒绝猜测）',
            xs['source_error'] is not None and xs['n_present'] == 0,
            'err=%s' % xs['source_error'])
    # 真基线哈希不变（D2 全程只动临时副本）
    chk('D2 真冻结基线哈希前后不变',
        B._sha256_file(B._XLATE_FROZEN) == _frozen_real_sha,
        '%s…' % (_frozen_real_sha or '')[:16])


# ===========================================================================
print("\nD3 翻译同源（冻结命中不联网 / 运行缓存漂移不覆盖 / 基线缺失不换源）")
# ===========================================================================
with tempfile.TemporaryDirectory(prefix='p1_d3_') as _td:
    root = Path(_td)
    _copy_cases(root, 'crlf')
    t = _first_case_text()
    _frozen = _REAL_TS / 'assets' / 'translation_cache.json'
    real_val = json.loads(_frozen.read_text(encoding='utf-8'))[t]
    with mock.patch.object(B, 'TESTS_DIR', root):
        with mock.patch.object(B, '_XLATE_FROZEN', _frozen):
            _reset_frozen_memo()
            with mock.patch.object(B, 'translate_to_en',
                                   side_effect=AssertionError('D3: 冻结命中不应调在线翻译')):
                r = B._cached_translate(t, {})
            chk('D3 命中冻结译文直接返回、不调在线翻译', r == real_val, 'r=%r' % (str(r)[:24],))
            # 运行缓存里同一 key 存放漂移值 → 基线权威，返回冻结值
            r = B._cached_translate(t, {t: 'RUNTIME_DRIFT', '别的句子': 'x'})
            chk('D3 运行缓存漂移不覆盖基线', r == real_val, 'r=%r' % (str(r)[:24],))
    # 基线缺失：明确报 source_error，不读运行缓存凑数
    with mock.patch.object(B, 'TESTS_DIR', root), \
         mock.patch.object(B, '_XLATE_FROZEN', root / 'no_such_baseline.json'):
        _reset_frozen_memo()
        xs = B._xlate_subset_fingerprint()
        chk('D3 基线缺失：source_error 明确、0 命中（不静默换源）',
            xs['source_error'] is not None and xs['n_present'] == 0,
            'err=%s' % xs['source_error'])

# ===========================================================================
print("\nD3b 基准用例 fail-closed（缺译文/坏基线 → None，不查运行缓存、不调在线）")
# ===========================================================================
_act = json.loads((_REAL_TS / 'assets' / 'translation_cache.json').read_text(encoding='utf-8'))
with tempfile.TemporaryDirectory(prefix='p1_d3b_') as _td:
    root = Path(_td)
    _copy_cases(root, 'crlf')
    t_idx = _first_case_text()
    # 基准缺条：冻结基线 = 真实内容 minus 一条基准译文
    broke = {k: v for k, v in _act.items() if k != t_idx}
    with tempfile.NamedTemporaryFile('w', suffix='.json', encoding='utf-8', delete=False) as _f:
        _f_path = Path(_f.name)
        _f_path.write_text(json.dumps(broke, ensure_ascii=False), encoding='utf-8')
    try:
        with mock.patch.object(B, 'TESTS_DIR', root), \
             mock.patch.object(B, '_XLATE_FROZEN', _f_path), \
             mock.patch.object(B, 'translate_to_en',
                               side_effect=AssertionError('D3b: 基准缺译文不应调在线翻译')):
            _reset_frozen_memo()
            r = B._cached_translate(t_idx, {t_idx: 'RUNTIME_DRIFT'})
            chk('D3b 基准缺冻结译文：返回 None（不查运行缓存、不调在线）',
                r is None, 'got=%r' % r)
    finally:
        _f_path.unlink(missing_ok=True)
    # 坏基线（不可读）对基准用例同样 fail-closed
    with tempfile.NamedTemporaryFile('w', suffix='.json', encoding='utf-8', delete=False) as _f2:
        _f2_path = Path(_f2.name)
        _f2_path.write_text('not a json {{', encoding='utf-8')
    try:
        with mock.patch.object(B, 'TESTS_DIR', root), \
             mock.patch.object(B, '_XLATE_FROZEN', _f2_path), \
             mock.patch.object(B, 'translate_to_en',
                               side_effect=AssertionError('D3b: 坏基线不应调在线翻译')):
            _reset_frozen_memo()
            r = B._cached_translate(t_idx, {t_idx: 'RUNTIME_DRIFT'})
            chk('D3b 坏基线对基准用例 fail-closed（None，不调在线）',
                r is None, 'got=%r' % r)
    finally:
        _f2_path.unlink(missing_ok=True)

# ===========================================================================
print("\nD3c 未知玩家输入保留原路径（冻结→运行缓存→在线；基准判定不误伤）")
# ===========================================================================
with tempfile.TemporaryDirectory(prefix='p1_d3c_') as _td:
    root = Path(_td)
    _copy_cases(root, 'crlf')
    new_input = '一句从未见过的玩家输入，不属于任何基准用例。'
    # 在**真实**基准集合下找一个冻结里有、但非基准的文本
    _real_base = frozenset(B._case_texts())
    nonbase_hit = next(k for k in _act if k not in _real_base)
    with mock.patch.object(B, 'TESTS_DIR', root), \
         mock.patch.object(B, '_XLATE_FROZEN', _REAL_TS / 'assets' / 'translation_cache.json'), \
         mock.patch.object(B, '_XLATE_DISK', root / '_diag' / 'translation_cache.json'):
        # 非基准但冻结命中 → 冻结优先（不被运行缓存漂移覆盖）
        r1 = B._cached_translate(nonbase_hit, {nonbase_hit: 'DRIFT'})
        chk('D3c 非基准文本冻结命中 → 返回冻结值', r1 == _act[nonbase_hit], 'r=%r' % str(r1)[:24])
        # 非基准、冻结无、运行缓存有 → 返回运行缓存，不调在线
        with mock.patch.object(B, 'translate_to_en',
                               side_effect=AssertionError('D3c: 运行缓存命中不应调在线')):
            r2 = B._cached_translate(new_input, {new_input: 'RUN_CACHE'})
            chk('D3c 非基准文本运行缓存命中 → 不调在线', r2 == 'RUN_CACHE', 'r=%r' % str(r2)[:24])
        # 非基准、冻结无、运行缓存无 → 才调在线（仅此路径允许联网）
        with mock.patch.object(B, 'translate_to_en', return_value=('EN_ONLINE', 'llm')):
            r3 = B._cached_translate(new_input, {})
            chk('D3c 非基准文本无缓存才调在线', r3 == 'EN_ONLINE', 'r=%r' % str(r3)[:24])

# ===========================================================================
print("\nM1 模型目录（配置同时作用于查找与校验；未知/缺失检查点 fail-closed）")
# ===========================================================================
with tempfile.TemporaryDirectory(prefix='p1_m1_') as _td:
    root = Path(_td)
    # 只有一个有效检查点：typed-decisions
    (root / 'laya-typed-decisions').mkdir(parents=True)
    (root / 'laya-typed-decisions' / 'model.safetensors').write_text('x', encoding='utf-8')
    (root / 'laya-typed-decisions' / 'rl_agent_config.json').write_text('{}', encoding='utf-8')
    with mock.patch.object(B, 'MODELS_DIR', root):
        found = B.find_local_models()
    chk('M1 模型目录配置作用于查找（推理输入）',
        set(found) == {'typed-decisions'} and found['typed-decisions'].startswith(str(root)),
        'found=%s' % sorted(found))

    # 未知检查点名：fail-closed，不加载任何检查点
    fake_laya = types.ModuleType('laya')   # 无 Router / load → init 只走到守卫
    with mock.patch.dict(sys.modules, {'laya': fake_laya}), \
         mock.patch.dict(os.environ, {'LAYA_MODEL': 'bogus', 'LAYA_FASTLOAD': '0'}), \
         mock.patch.object(B, 'MODELS_DIR', root):
        e = B.LayaEngine()
        e.init()
    chk('M1 未知检查点名拒绝加载', e.model_name is None and '未知检查点名' in e.last_error,
        'err=%s' % (e.last_error or '')[:60])

    # 本地缺指定检查点：fail-closed，不静默退到已有检查点
    with mock.patch.dict(sys.modules, {'laya': fake_laya}), \
         mock.patch.dict(os.environ, {'LAYA_MODEL': 'english', 'LAYA_FASTLOAD': '0'}), \
         mock.patch.object(B, 'MODELS_DIR', root):
        e2 = B.LayaEngine()
        e2.init()
    chk('M1 缺指定检查点不静默替换',
        e2.obj is None and not e2.ready and '没有' in e2.last_error
        and 'english' in e2.last_error, 'err=%s' % (e2.last_error or '')[:60])
    chk('M1 缺检查点错误提示可用 LAYA_MODELS_DIR', 'LAYA_MODELS_DIR' in (e2.last_error or ''),
        'err=%s' % (e2.last_error or '')[:80])

    # 本地有指定检查点：正常选中
    with mock.patch.dict(sys.modules, {'laya': fake_laya}), \
         mock.patch.dict(os.environ, {'LAYA_MODEL': 'typed-decisions', 'LAYA_FASTLOAD': '0'}), \
         mock.patch.object(B, 'MODELS_DIR', root):
        e3 = B.LayaEngine()
        e3.init()
    chk('M1 本地有指定检查点则正常选中', e3.model_name == 'typed-decisions' and not e3.last_error,
        'model=%s err=%s' % (e3.model_name, (e3.last_error or '')[:40]))

# 校验与推理同目录：真实模型目录存在时，checkpoint 指纹必须等于档案
_real_models = Path(r'C:\Users\11\WorkBuddy\2026-09-23-11-11-35\laya-live\_models')
if _real_models.is_dir():
    with mock.patch.object(B, 'MODELS_DIR', _real_models):
        cid = B._checkpoint_fingerprint('typed-decisions')['id']
    chk('M1 校验读同一模型目录（checkpoint id 与档案一致）', cid == CKPT_TD,
        'id=%s…' % cid[:12])
else:
    print('  · 跳过：本机无外部模型目录（%s）' % _real_models)

# ===========================================================================
print("\nM1b 检查点目录布局一致性（laya-<名>/ 与裸 <名>/ 共用解析）")
# ===========================================================================


def _mk_ckpt(base, name):
    d = base / name
    d.mkdir(parents=True)
    (d / 'model.safetensors').write_text('fake', encoding='utf-8')
    (d / 'rl_agent_config.json').write_text('{"k": 1}', encoding='utf-8')
    (d / 'config.json').write_text('{"tok": 7}', encoding='utf-8')
    return d


with tempfile.TemporaryDirectory(prefix='p1_m1b_') as _td:
    root = Path(_td)
    bare = _mk_ckpt(root, 'typed-decisions')          # 裸目录布局
    with mock.patch.object(B, 'MODELS_DIR', root):
        _found = B.find_local_models()
        _fp = B._checkpoint_fingerprint('typed-decisions')
    chk('M1b 裸目录布局：加载器与指纹都识别',
        _found.get('typed-decisions') == str(bare) and _fp['exists'],
        'dir=%s exists=%s' % (_fp['dir'], _fp['exists']))
    # laya- 前缀布局：同一内容、不同目录名 → checkpoint id 必须一致
    root2 = Path(_td) / 'laya_layout'
    _mk_ckpt(root2, 'laya-typed-decisions')
    with mock.patch.object(B, 'MODELS_DIR', root2):
        _fp2 = B._checkpoint_fingerprint('typed-decisions')
    chk('M1b 两种布局同一内容 → checkpoint id 一致', _fp2['id'] == _fp['id'],
        'id=%s…' % _fp2['id'][:12])
    # 两种布局都缺失 → exists=False（不误报有效）
    with mock.patch.object(B, 'MODELS_DIR', Path(_td) / 'empty'):
        _fp3 = B._checkpoint_fingerprint('typed-decisions')
    chk('M1b 无任何布局 → exists=False', _fp3['exists'] is False, 'dir=%s' % _fp3['dir'])

# ===========================================================================
print("\nP1 门禁（active 集合一致；C/auxiliary 不进 writable delta；无档案零 delta）")
# ===========================================================================
td_active = sorted(s for s, v in _TD_ARCH['signals'].items() if v['status'] == 'active')
en_active = sorted(s for s, v in _EN_ARCH['signals'].items() if v['status'] == 'active')
chk('P1 typed-decisions active 集合', td_active == ['doubt_shift'], 'active=%s' % td_active)
chk('P1 english active 集合', en_active == ['fondness_shift'], 'active=%s' % en_active)

# 构造 profile：trust_shift=auxiliary(C)、doubt_shift=active(A) → 只有 doubt_shift 可写
_prof = {'checkpoint': 'typed-decisions', 'signals': {
    'trust_shift': {'grade': 'C', 'status': 'auxiliary'},
    'doubt_shift': {'grade': 'A', 'status': 'active'},
}}
_deltas = [
    {'question': 'trust_shift', 'target': 'relationship.trust', 'delta': 5.0},
    {'question': 'doubt_shift', 'target': 'relationship.doubt', 'delta': 4.0},
]
_prop, _bt, _sa = B.build_state_proposal(_deltas, _deltas, {}, _prof, {'problems': []})
_delta_src = sorted(d['source_signal'] for d in _prop['delta'])
_aux_src = sorted(a['source_signal'] for a in _prop['auxiliary'])
chk('P1 C/auxiliary 不进 writable delta', _delta_src == ['doubt_shift'],
    'delta=%s aux=%s' % (_delta_src, _aux_src))
chk('P1 auxiliary 只登记不生效（applied=false）',
    _aux_src == ['trust_shift'] and _prop['auxiliary'][0]['applied'] is False,
    'aux=%s applied=%s' % (_aux_src, _prop['auxiliary'][0]['applied']))
chk('P1 有可写 delta 时 can_commit_state=True', _prop['gate']['can_commit_state'] is True,
    '')

# 无可用档案 → 零 writable delta
_deltas2 = [
    {'question': 'doubt_shift', 'target': 'relationship.doubt', 'delta': 4.0},
]
_prop2, _, _ = B.build_state_proposal(_deltas2, _deltas2, {}, None, {'problems': ['档案缺失']})
chk('P1 无档案零 writable delta（不把未知当全能力）',
    _prop2['delta'] == [] and _prop2['gate']['can_commit_state'] is False,
    'delta=%d can_commit=%s' % (len(_prop2['delta']), _prop2['gate']['can_commit_state']))

# ===========================================================================
_reset_frozen_memo()
print('=' * 92)
print('P1 资产一致性聚焦自测：合计 %d 项：%d PASS / %d FAIL'
      % (N[0], N[0] - len(FAIL), len(FAIL)))
if FAIL:
    print('失败项：%s' % '、'.join(FAIL))
print('=' * 92)
sys.exit(1 if FAIL else 0)