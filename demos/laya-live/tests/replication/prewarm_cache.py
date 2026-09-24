"""把三组用例的输入全部预热进翻译缓存（**跑实验之前**执行，只跑一次）。

为什么必须单独有这一步（2026-09-23 实测踩到的坑）：

  `_cached_translate` 在缓存缺失时会**顺手把译文写进磁盘缓存**。
  于是「同一组 3 次独立运行」里，第 1、2 次把缺失的那条判为
  「缓存缺失 → message 被填成中文」而剔除，中间那次运行把译文写了进去，
  第 3 次就读到一条都不缺 —— **同一组数据里混了两种条件，且全程无报错**。

  根因是 `translate_to_en` 会**间歇性返回空串**（HTTP 200 但 content 为空），
  所以「什么时候写得进去」不可预测。实验不能把这种不确定性吃进去。

做法：开跑**之前**在这里一次性补齐，之后每次运行前断言「全命中」，
运行后再核对缓存哈希 —— 条件不变就成了一个可观察的事实，而不是一个假设。

用法：
    ./.venv-cuda/Scripts/python.exe tests/replication/prewarm_cache.py
"""
import hashlib
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def _find_root(start):
    """向上找含 laya_bridge.py 的目录 —— 脚本换位置后不用改路径。"""
    d = start
    for _ in range(4):
        if os.path.exists(os.path.join(d, "laya_bridge.py")):
            return d
        d = os.path.dirname(d)
    raise SystemExit("找不到 laya_bridge.py；脚本必须放在 laya-live/ 之内")


ROOT = _find_root(HERE)
sys.path.insert(0, ROOT)
sys.argv = [sys.argv[0]]

import laya_bridge as B  # noqa: E402

DISK = B._XLATE_DISK
TRIES = 6

cache = {}
if DISK.exists():
    try:
        cache = json.loads(DISK.read_text(encoding="utf-8"))
    except Exception as e:
        print("读缓存失败：%r" % e)
print("预热前：%d 条 ｜ sha256=%s"
      % (len(cache), hashlib.sha256(DISK.read_bytes()).hexdigest()[:16] if DISK.exists() else "无"))

sets = B._load_case_sets()
need = []
for k in ("observable", "contextual", "hidden_truth"):
    for c in (sets.get(k) or ({}, []))[1]:
        if c["text"] not in need:
            need.append(c["text"])

# ★ 除三组标准用例集外，还要扫 tests/cases/ 下**任何**额外的用例文件。
#   否则新加一个专项用例集（如 P2.5 的 trust_context.json）时，
#   预热脚本会「看起来通过了」，而那个集的输入根本没进缓存 ——
#   运行期再靠 _cached_translate 边跑边写，就又回到「跑途中改条件」那个坑。
#   宁可多预热几条无关文本，也不要漏掉一个将要被断言的输入。
#
# ★★ 2026-09-24 补：这段扫描**第一次写的时候只认 `cases[].text` 一种形状**，
#    于是 P3 的 p3_experience.json（用 `scenarios[].lines[]`）被静默漏掉 ——
#    脚本打印「额外用例文件补入 6 条」然后「0 条缺缓存」，看似一切正常，
#    而实际上 15 条 P3 台词**一条都没进缓存**。
#    这是同一类错误的第二次出现（第一次是 P2.5 之前根本没有这段扫描），
#    所以修法不能是「再补一个 key」，而是**递归收集所有字符串值**，
#    并对「加了新用例文件但收集到 0 条」显式告警。
#    漏掉输入的代价是运行期边跑边写缓存 = 条件在途中改变，这正是本脚本存在的理由。
import glob as _glob


def _collect_texts(obj, out):
    """递归收集 JSON 里所有看起来是「一句玩家台词」的字符串。

    判据刻意宽：长度 >= 4 的 str 且在 `text`/`lines`/`line`/`message` 键下，
    或出现在 cases/scenarios 的元素里且含中日韩字符。
    宽比窄安全 —— 多预热几条无关文本无害，漏一条会让实验条件在途中变化。
    """
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str) and k in ("text", "line", "message", "player_input"):
                if len(v) >= 2 and v not in out:
                    out.append(v)
            else:
                _collect_texts(v, out)
    elif isinstance(obj, list):
        for it in obj:
            if isinstance(it, str):
                # 裸字符串出现在 lines 这类数组里 → 也是台词
                if len(it) >= 4 and any("\u4e00" <= ch <= "\u9fff" for ch in it):
                    if it not in out:
                        out.append(it)
            else:
                _collect_texts(it, out)


_extra = 0
for _p in sorted(_glob.glob(os.path.join(ROOT, "tests", "cases", "*.json"))):
    try:
        _blob = json.load(open(_p, encoding="utf-8"))
    except Exception:
        continue
    _got = []
    _collect_texts(_blob, _got)
    # 去掉 _readme / 说明性长文本：它们是给人和 AI 读的，不是玩家台词
    _got = [t for t in _got if t not in need and len(t) <= 120]
    if not _got:
        print("⚠ %s 里没收集到任何输入文本 —— 若该文件确实含用例输入，"
              "说明它的结构又不被识别了（见本段注释），请补 _collect_texts 的判据。"
              % os.path.basename(_p))
    for _t in _got:
        need.append(_t)
        _extra += 1
if _extra:
    print("额外用例文件补入 %d 条文本" % _extra)

missing = [t for t in need if t not in cache]
print("用例输入去重后 %d 条，其中 %d 条缺缓存" % (len(need), len(missing)))

added, failed = 0, []
for t in missing:
    got = ""
    for i in range(TRIES):
        # 用与运行期**同一个**函数，保证新增条目的来源和已有 172 条一致
        en, src = B.translate_to_en(t)
        if en and en != t:
            got = en
            break
        time.sleep(1.5 * (i + 1))
    if got:
        cache[t] = got
        added += 1
        print("  ✅ %s\n     → %s" % (t[:40], got[:80]))
    else:
        failed.append(t)
        print("  ★ %d 次尝试都拿到空串，失败：%s" % (TRIES, t[:40]))

if added:
    DISK.parent.mkdir(parents=True, exist_ok=True)
    DISK.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n已写回 %d 条 → %s" % (added, DISK))

after = json.loads(DISK.read_text(encoding="utf-8")) if DISK.exists() else {}
still = [t for t in need if t not in after]
print("预热后：%d 条 ｜ sha256=%s"
      % (len(after), hashlib.sha256(DISK.read_bytes()).hexdigest()[:16] if DISK.exists() else "无"))
if still:
    print("★ 仍有 %d 条缺失 —— 不要开跑，signalmetrics 会拒绝执行（return 2）：" % len(still))
    for t in still:
        print("   · %s" % t[:50])
    sys.exit(1)
print("✅ 缓存完备，可以开始冻结运行。")
