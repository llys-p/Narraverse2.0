# -*- coding: utf-8 -*-
"""手工把 Laya 检查点下成本地目录（绕开 huggingface_hub 的缓存/锁/临时目录机制）。

为什么要手工下
--------------
1. huggingface_hub 在下载过程中会删 `.incomplete` 哨兵文件、`.locks/*.lock`、
   以及退出时清理 tempfile 目录。本机有「删除配额守卫」（同一轮累计 >50 项即
   SystemExit 杀进程），这些清理动作正好会撞上去，导致下载中断。
2. 本脚本只做「GET -> 写文件」，一个删除动作都没有，因此完全不受守卫影响。

产出
----
    <OUT>/rl_agent_config.json
    <OUT>/model.safetensors
    <OUT>/tokenizer/*           （tokenizer_config.json 会被就地修正，见下）
    <OUT>/encoder/*

用法
----
    python _fetch_laya.py                  # typed-decisions（默认）
    python _fetch_laya.py english          # english（仓库根，通用校准模型）
    python _fetch_laya.py multilingual

之后即可 `laya.load("<OUT>")` 直接加载（Agent 看到本地目录存在就跳过下载）。
桥会优先扫 _models/ 下的本地检查点，所以下好哪个就能用哪个。

实测记录（2026-09-23）：typed-decisions 对本项目的自定义叙事问题集**没有区分度** ——
「回避/坦诚/威胁」三个输入都选中同一个行为 confide，六个评分项的期望值跨度只有
0.10~0.22（满分 5 档）。但同一批问题的「意图」选择题三个输入给出了三个不同答案，
说明模型没坏，是行为题与评分题塌了。这与 router.py 的说明一致：typed-decisions
是在四个特定合成工作流（agent_trace_observability / customer_service /
invoice_processing / security_incidents）上微调的。故必须再下 english 做对照。

另一件事：agent.py 里的 `_fix_tokenizer_config` 会在加载时把 `tokenizer_class`
从 `TokenizersBackend` 改成 `PreTrainedTokenizerFast`，并修 `extra_special_tokens`
的 list->dict（否则 transformers 会报 "'list' object has no attribute 'keys'"）。
本脚本提前做同样的修正，让下载物本身就可加载。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

REPO = "convaiinnovations/laya"
REVISION = "main"

# 要下哪个检查点：命令行参数 > 默认。
#   python _fetch_laya.py                → typed-decisions（子目录）
#   python _fetch_laya.py english        → english（仓库根目录，无子目录前缀）
#   python _fetch_laya.py multilingual
_ARG = (sys.argv[1] if len(sys.argv) > 1 else "typed-decisions").strip()
if _ARG in ("english", "root", ""):
    SUBFOLDER = ""          # english 检查点就是仓库根
    NAME = "english"
else:
    SUBFOLDER = _ARG
    NAME = _ARG

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "_models", "laya-" + NAME)
ENDPOINTS = ["https://hf-mirror.com", "https://huggingface.co"]
TRIES = 8

# 只取加载所必需的四类文件（Agent 内部的 allow_patterns 也是这些）
NEEDED = ("rl_agent_config.json", "model.safetensors", "tokenizer/", "encoder/")


def log(msg):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), msg), flush=True)


def _open(url, timeout=60, headers=None, method="GET"):
    hdr = {"User-Agent": "curl/8.5.0"}
    if headers:
        hdr.update(headers)
    req = urllib.request.Request(url, headers=hdr, method=method)
    return urllib.request.urlopen(req, timeout=timeout)


def get_bytes(url, timeout=60, tries=TRIES, what=""):
    """带重试的 GET，返回 bytes。本机 TLS 握手偶发中断，必须重试。"""
    last = None
    for i in range(1, tries + 1):
        try:
            with _open(url, timeout=timeout) as r:
                return r.read()
        except Exception as e:
            last = e
            if i < tries:
                time.sleep(min(1.5 * i, 8))
                sys.stderr.write("  重试 %d/%d %s (%s)\n" % (i, tries, what, type(e).__name__))
    raise RuntimeError("%s 失败（重试 %d 次）: %r" % (what or url, tries, last))


def api(path, tries=TRIES):
    last = None
    for ep in ENDPOINTS:
        for i in range(1, tries + 1):
            try:
                raw = get_bytes(ep + path, timeout=45, tries=1, what=path)
                return ep, json.loads(raw.decode("utf-8"))
            except Exception as e:
                last = e
                time.sleep(min(1.2 * i, 6))
    raise RuntimeError("API %s 在所有端点都失败: %r" % (path, last))


def list_files():
    sub = ("/" + SUBFOLDER) if SUBFOLDER else ""
    ep, data = api("/api/models/%s/tree/%s%s?recursive=true" % (REPO, REVISION, sub))
    log("文件清单来自 %s" % ep)
    # 注意：子目录查询返回的 path 仍然带 "<subfolder>/" 前缀，
    # 下载 URL 要用带前缀的全路径，落盘则用去掉前缀的相对路径。
    pre = (SUBFOLDER + "/") if SUBFOLDER else ""
    files = []
    for it in data:
        if it.get("type") != "file":
            continue
        full = it["path"]
        rel = full[len(pre):] if pre and full.startswith(pre) else full
        # 根目录查询会一并返回 multilingual/、typed-decisions/、assets/ 等兄弟目录，排除掉
        if "/" in rel and not any(rel.startswith(n) for n in NEEDED):
            continue
        if any(rel == n or rel.startswith(n) for n in NEEDED):
            files.append((full, rel, it.get("size") or 0))
    return ep, files


def download(ep, full, rel, size):
    dest = os.path.join(OUT, rel.replace("/", os.sep))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    # 已下完（大小一致）就跳过 —— 不删除，直接复用
    if os.path.exists(dest) and size and os.path.getsize(dest) == size:
        log("  跳过（已存在且大小一致） %s" % rel)
        return
    got = os.path.getsize(dest) if os.path.exists(dest) else 0
    url = "%s/%s/resolve/%s/%s" % (ep, REPO, REVISION, full)
    last = None
    for i in range(1, TRIES + 1):
        try:
            hdr = {"Range": "bytes=%d-" % got} if got else {}
            with _open(url, timeout=180, headers=hdr) as r:
                mode = "ab" if (got and r.status == 206) else "wb"
                if mode == "wb":
                    got = 0
                t0 = time.time()
                with open(dest, mode) as f:
                    while True:
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
                        got += len(chunk)
                        if size and got % (16 << 20) < (1 << 20):
                            pct = 100.0 * got / size
                            sys.stderr.write("\r    %s  %5.1f%%  %.1f/%.1fMB  %.1fMB/s   "
                                             % (rel, pct, got / 1048576, size / 1048576,
                                                (got / 1048576) / max(time.time() - t0, .01)))
                            sys.stderr.flush()
            if not size or os.path.getsize(dest) == size:
                sys.stderr.write("\n")
                log("  完成 %s (%.1fMB)" % (rel, os.path.getsize(dest) / 1048576))
                return
            last = "大小不符: 期望 %d 实得 %d" % (size, os.path.getsize(dest))
        except Exception as e:
            last = repr(e)
        if i < TRIES:
            time.sleep(min(1.5 * i, 8))
            sys.stderr.write("\n  断点重试 %d/%d %s (%s)\n" % (i, TRIES, rel, last))
            got = os.path.getsize(dest) if os.path.exists(dest) else 0
    raise RuntimeError("%s 下载失败: %s" % (rel, last))


def fix_tokenizer_config():
    """提前做 agent.py 里 _fix_tokenizer_config 的修正，让下载物本身可加载。"""
    p = os.path.join(OUT, "tokenizer", "tokenizer_config.json")
    if not os.path.exists(p):
        return
    with open(p, encoding="utf-8") as f:
        tcfg = json.load(f)
    changed = False
    if tcfg.get("tokenizer_class") in (None, "TokenizersBackend"):
        tcfg["tokenizer_class"] = "PreTrainedTokenizerFast"
        tcfg.pop("backend", None)
        tcfg.pop("is_local", None)
        changed = True
    extra = tcfg.get("extra_special_tokens")
    if isinstance(extra, list):
        tcfg["extra_special_tokens"] = {"extra_%d" % i: t for i, t in enumerate(extra)}
        changed = True
    if changed:
        with open(p, "w", encoding="utf-8") as f:
            json.dump(tcfg, f, indent=2)
        log("  已修正 tokenizer_config.json")
    else:
        log("  tokenizer_config.json 无需修正")


def main():
    log("目标目录: %s" % OUT)
    ep, files = list_files()
    if not files:
        log("!! 未匹配到任何文件，检查 NEEDED 前缀")
        return 1
    total = sum(s for _, _, s in files)
    log("需要 %d 个文件，合计 %.1f MB" % (len(files), total / 1048576))
    for _, rel, s in files:
        log("* %s (%.1fMB)" % (rel, s / 1048576))
    t0 = time.time()
    for full, rel, s in files:
        log("下载 %s" % rel)
        download(ep, full, rel, s)
    log("全部完成，用时 %.1fs" % (time.time() - t0))
    fix_tokenizer_config()
    with open(os.path.join(OUT, "rl_agent_config.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    log("cfg: max_len=%s head_max_len=%s encoder=%s"
        % (cfg.get("max_len"), cfg.get("head_max_len"), cfg.get("encoder")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
