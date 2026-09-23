#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Laya × Narraverse 决策桥
==========================================================
把 Laya（https://github.com/NandhaKishorM/laya）的 Python SDK
包成一个本地 HTTP 接口，供前端（iframe / SPA / 本地页面）实时调用。

Laya 是「非自回归类型化决策引擎」：单次前向传播、约 33ms、
不做文本生成、因此不会幻觉。三个决策原语：
    choice  选项分类（带每个选项的概率与置信度）
    score   有序评分（返回期望值与分布）
    noul    校准概率 P(true)，0~1

用法
----------------------------------------------------------
    python laya_bridge.py            # 启动服务
    python laya_bridge.py probe      # 只体检：报告本机 laya 的真实 API 形状
    python laya_bridge.py langtest [检查点名...]
                                     # 对照实测：区分度够不够。
                                     # ★ 默认只跑 LAYA_MODEL 那一个 —— 两个检查点同时驻留
                                     #   约 1.7GB 权重，本机内存不够会 Segmentation fault
                                     #   （exit 139、零 traceback）。要换就点名：
                                     #   python laya_bridge.py langtest english
                                     # 加 LAYA_LANGTEST_DOC=zh 顺便测中文文档（预期变差）
    python laya_bridge.py selftest   # 离线自检：跑一遍回退引擎并校验状态增量
    python laya_bridge.py llmtest    # LLM 自检：key 是否有效 / model id 是否正确 / 预算够不够
    python laya_bridge.py qcheck     # 问题集审计：token 预算（含 state 文档）与温度桶。
                                     # ★ 改 narra_config.json 之后必跑
    python laya_bridge.py sanity [A|B|C|D]
                                     # A/B/C/D 对照诊断：我们的问法 vs 照 Laya 预设格式改写。
                                     # 现在这套配置就是 D 的结论落地的结果，保留它用于回归。

★ 本配置的问法是在真机上对照实测出来的，改配置前先读 narra_config.json 的 _readme。
  三条硬规矩：instructions 用反引号引用 state 键名 / score 用领域化档位 / choice 选项必须 3~5 词。

环境变量
----------------------------------------------------------
    密钥类（DEEPSEEK_API_KEY / LLM_API_KEY）以 .env 为准；
    其它键系统环境变量优先，方便临时试参数（见 load_env_file 的说明）。
    被覆盖的键会在启动横幅和 /health 的 env_overridden 里报出来。

    LAYA_BRIDGE_PORT   端口，默认 8130
    LAYA_MODEL         用哪个检查点：typed-decisions（默认）/ english / multilingual
                       ★ typed-decisions 是在四个特定合成工作流上微调的，未必适合
                         本项目的自定义叙事问题集；english 才是通用校准模型。
                         哪个更好要实测（python laya_bridge.py langtest）。
    LAYA_PRELOAD       =1（默认）只把 LAYA_MODEL 指定的那一个检查点常驻内存。
                       ★ 注意：不要直接用 Router(preload=True)，那会把三个检查点
                         全部下载并常驻（合计约 2.3GB 权重）。
    LAYA_DEVICE        cuda / cpu（不设则自动判断）
    DEEPSEEK_API_KEY   有则台词由 LLM 生成；没有则用配置里的台词池
    LLM_BASE_URL       默认 https://api.deepseek.com
    LLM_MODEL          默认 deepseek-flash
                       ★ 必须用 model id，不是显示名。传 "DeepSeek-V4.1-Flash" 会 400，
                         报错原文：The supported API model names are deepseek-flash, deepseek-v4-pro
                       另一可选：deepseek-v4-pro
    LLM_EFFORT         low / high / max，默认 low
                       实测一句 NPC 台词：有推理段约 1700ms / 200 推理 token；
                       不给 effort 则无推理段、约 900ms，便宜一半且对台词质量无明显损失
    LLM_MAX_TOKENS     默认 1600。★ 推理 token 也算在预算内，给太小（如 400）
                       会把推理吃光导致 content 变成空字符串
    OPEN_BROWSER       =1 时启动后自动打开 demo 页面（由 .bat 传入）

本地检查点
----------------------------------------------------------
    把检查点下到 _models/laya-<名字>/（用 _fetch_laya.py），桥会优先用本地目录，
    完全不走 huggingface_hub。理由见 _fetch_laya.py 顶部：hf 在下载过程中会删
    .incomplete 哨兵、.locks/*.lock 和 tempfile 目录，正好撞上本机的删除配额守卫。
"""
import json
import os
import re
import sys
import time
import math
import random
import inspect
import subprocess
import urllib.request
import urllib.error
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = Path(__file__).resolve().parent
CFG_PATH = HERE / "narra_config.json"
DEMO_HTML = HERE / "laya-live-demo.html"
ENV_PATH = HERE / ".env"
# 这些是密钥：以 .env 为准，不让系统环境变量覆盖。
# 理由：本机用户级环境变量里存着一个**已失效**的 DEEPSEEK_API_KEY（尾号 d4f0），
# 若让系统优先，.env 里的有效 key 会被静默屏蔽，表现为 401 且报错只显示 d4f0，极难定位。
ENV_AUTHORITATIVE = ("DEEPSEEK_API_KEY", "LLM_API_KEY")
PORT = int(os.environ.get("LAYA_BRIDGE_PORT", "8130"))


def load_env_file(path=ENV_PATH):
    """把 .env 读进 os.environ。优先级分两类：

      - 密钥类（ENV_AUTHORITATIVE）：**.env 优先**，被覆盖的键记进 ENV_OVERRIDDEN，
        启动横幅与 /health 都会报出来（避免系统里遗留的失效 key 静默生效）。
      - 其它键（LAYA_MODEL / LLM_EFFORT / LLM_MAX_TOKENS ...）：**系统环境变量优先**，
        这样临时试参数不用改文件：
            LAYA_MODEL=english python laya_bridge.py langtest
        （注：Windows 下若用 cmd，请用 `set X=Y && ...` 的写法。）

    这样密钥只存在本地文件里，不进 .bat、不进 HTML。
    """
    if not path.exists():
        return [], []
    loaded, overridden = [], []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if not k or not v:
            continue
        old = os.environ.get(k)
        if k in ENV_AUTHORITATIVE:
            if old is not None and old != v:
                overridden.append(k)
            os.environ[k] = v
            loaded.append(k)
        elif old is None:
            os.environ[k] = v
            loaded.append(k)
    return loaded, overridden


ENV_LOADED, ENV_OVERRIDDEN = load_env_file()

CFG = json.loads(CFG_PATH.read_text(encoding="utf-8"))

# ==========================================================================
# 1. Laya 引擎适配层
#    已按 pip install laya 0.3.5 的**真实 API 形状**核对（不再是猜测）：
#      laya.Router(models=None, device=None, token=None, max_loaded=1,
#                  default='english', auto_task_detection=False,
#                  standalone_repos=False, preload=False)
#      Router.predict(state, questions, model=None, task=None, lang=None)
#         -> system_one 的返回 + 一个 routing 键
#      Agent.system_one(state, questions) / predict = system_one
#      返回 {"model","answers":{qid:{...}},"usage":{"input_tokens","output_tokens"}}
#        choice -> {"type","choice","probabilities":{label:p},"confidence","action"}
#        score  -> {"type","score"(期望值),"legend","probabilities":{"0":p,..},"confidence"}
#        noul   -> {"type","noul"(P(true)),"confidence","action"}
#      三种问题的 type 取值就是 laya.QTYPES = {"choice":0,"score":1,"noul":2}
#
#    检查点选择（重要）：
#      english          421M ModernBERT-large, 512 ctx  —— 通用校准模型，Router 默认
#      multilingual     322M mmBERT-base,     1024 ctx —— 100+ 语言
#      typed-decisions  421M ModernBERT-large, 1024 ctx —— 在四个特定合成工作流上微调
#        (agent_trace_observability / customer_service / invoice_processing /
#         security_incidents)。router.py 原文明确写了它「不该做静默默认」。
#      本项目的叙事决策问题集不属于那四个工作流，所以哪个更合适必须实测，
#      用 LAYA_MODEL=english|typed-decisions 切换，langtest 会给出对照。
#
#    本地检查点优先：_models/laya-<名字>/ 下有 model.safetensors + rl_agent_config.json
#    就直接用本地目录，完全不碰 huggingface_hub（见 _fetch_laya.py 的说明：
#    hf 下载过程中的临时目录/锁文件删除会撞上本机的删除配额守卫）。
# ==========================================================================
MODELS_DIR = HERE / "_models"
MODEL_NAMES = ("typed-decisions", "english", "multilingual")
DEFAULT_MODEL_NAME = os.environ.get("LAYA_MODEL", "typed-decisions")


def find_local_models():
    """扫 _models/ 下已下好的检查点，返回 {router 名: 本地路径}。"""
    out = {}
    if not MODELS_DIR.is_dir():
        return out
    for n in MODEL_NAMES:
        for cand in (MODELS_DIR / ("laya-" + n), MODELS_DIR / n):
            if (cand / "model.safetensors").exists() and (cand / "rl_agent_config.json").exists():
                out[n] = str(cand)
                break
    return out


def _free_phys_mb():
    """当前可用物理内存（MB）；取不到返回 None。

    为什么需要它：加载第二个 840MB 检查点时进程被 OOM 干掉是 **Segmentation fault、
    零 traceback**，看起来像代码 bug（实测 exit 139）。先查一下内存再决定跑几个，
    比事后猜「为什么突然 segfault」便宜得多。
    """
    try:
        if os.name == "nt":
            import ctypes

            class _MEMSTATUS(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

            st = _MEMSTATUS()
            st.dwLength = ctypes.sizeof(_MEMSTATUS)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
                return int(st.ullAvailPhys // (1024 * 1024))
        else:
            with open("/proc/meminfo") as fh:
                for line in fh:
                    if line.startswith("MemAvailable:"):
                        return int(line.split()[1]) // 1024
    except Exception:
        pass
    return None


# ---------------------------------------------------------------- 快加载
# 背景（2026-09-23 实测，报告 §13.3）：
#   laya 0.3.5 的 `preload` 要 35–75 s，而其中 **95% 是一次没用的随机权重初始化**。
#   `laya/common.py:139 build_model()` 在有 `encoder/` 目录时走
#   `AutoModel.from_config(ecfg)` —— 对 4.2 亿参数做一次完整的随机初始化，
#   紧接着 `agent.py:194 load_state_dict(weights, strict=True)` 把所有权重覆盖掉。
#   实测拆解：build_model 25.15 s / 读 842MB safetensors 0.16 s / load_state_dict 0.63 s。
#   （旁证：纯磁盘读同一个 842MB 文件只要 0.43 s，1972 MB/s —— 所以**瓶颈不是 IO**。
#    早先报告里「瓶颈在磁盘 + tokenizer」的说法已被这次测量推翻。）
#
#   上游 0.3.7 的 changelog 修的就是这一处（"Checkpoints are built without the
#   throwaway random weight initialisation"，CPU 冷加载 22 s → 2 s，答案位级一致），
#   但 0.3.7 **不在 PyPI**（`pip index versions laya` → 最新 0.3.5），只能从 git 装。
#   这里用等价做法在本机自己省掉那一步，并逐值验证过一致性。
#
# ★ 唯一的坑：**非持久 buffer 不会被 load_state_dict 覆盖**。
#   ModernBERT 的 RoPE `*_inv_freq` 正是 `persistent=False`（本检查点 4 个），
#   在 meta 上构建再 to_empty 之后它们是未初始化内存 —— 模型能跑、不报错、输出是垃圾。
#   好在它们只是 config 的纯函数（compute_default_rope_parameters），重算即可。
#   如果哪天换了别的架构、或重算数量对不上，下面的守卫会直接**回退到正常构建**，
#   而不是把未初始化内存当结果用。
#
# 验证（_diag/_fastload.py，10 组输入 × 全 22 问题集，GPU 同设备对照）：
#   加载 35.75 s → 1.01 s；输出 **1707 个值 0 个不同**。
# 关闭方式：LAYA_FASTLOAD=0。
def _rebuild_nonpersistent_buffers(model):
    """重算非持久 buffer，返回 (重建个数, 本应有几个)。

    本应有几个 = 模型里 `named_buffers()` 有、而 `state_dict()` 里没有的那些 ——
    也就是 load_state_dict 永远不会覆盖的那些。两者数量不等就说明我们漏了，
    必须让上层回退，绝不能放着不管。
    """
    sd_keys = set(model.state_dict().keys())
    missing = [n for n, _ in model.named_buffers() if n not in sd_keys]
    done = 0
    for mod in model.modules():
        if not hasattr(mod, "compute_default_rope_parameters"):
            continue
        fresh = type(mod)(mod.config)
        for name, buf in fresh.named_buffers():
            setattr(mod, name, buf)
            done += 1
    return done, missing


def install_fastload():
    """接管 transformers.AutoModel.from_config，跳过被丢弃的随机初始化。

    返回一句人类可读的状态说明（会进 /health 与 describe()）——
    这类"静默加速"如果不报出来，事后没人知道跑的是哪条路径。
    """
    if os.environ.get("LAYA_FASTLOAD", "1") != "1":
        return "off（LAYA_FASTLOAD=0）"
    try:
        import torch
        import transformers
    except Exception as e:
        return "skip: 无法 import torch/transformers（%r）" % (e,)
    if getattr(transformers.AutoModel, "_laya_fastload_installed", False):
        return "already"

    orig = transformers.AutoModel.from_config
    state = {"disabled": False, "rebuilt": 0, "why": ""}

    def fast_from_config(*a, **k):
        if state["disabled"]:
            return orig(*a, **k)
        try:
            with torch.device("meta"):
                m = orig(*a, **k)
            m = m.to_empty(device="cpu")
            done, missing = _rebuild_nonpersistent_buffers(m)
            left = [n for n, t in list(m.named_parameters()) + list(m.named_buffers())
                    if getattr(t, "device", None) is not None and t.device.type == "meta"]
            if left:
                raise RuntimeError("仍有 %d 个 meta 张量未实体化：%s" % (len(left), left[:3]))
            if done != len(missing):
                raise RuntimeError("非持久 buffer 只重算了 %d 个，实际有 %d 个（%s）"
                                   % (done, len(missing), missing[:3]))
            state["rebuilt"] = done
            return m
        except Exception as e:
            # 一次性失败就永久回退：不要在每次构建时反复踩同一个坑。
            state["disabled"] = True
            state["why"] = repr(e)
            sys.stderr.write("[bridge] 快加载不可用，本进程回退到正常构建：%r\n" % (e,))
            return orig(*a, **k)

    transformers.AutoModel.from_config = fast_from_config
    transformers.AutoModel._laya_fastload_installed = True
    install_fastload.state = state
    return "on"


class LayaEngine:
    def __init__(self):
        self.kind = "unavailable"
        self.detail = ""
        self.obj = None
        self.load_ms = 0
        self.last_error = ""
        self.local_models = {}
        self.model_name = None
        self.fastload = "n/a"

    def init(self):
        t0 = time.time()
        # ★ 必须在构造 Router/Agent **之前**装好：它就是去改「模型怎么被建出来」那一步的。
        self.fastload = install_fastload()
        try:
            import laya  # noqa
        except Exception as e:
            self.detail = "未安装 laya（pip install laya）"
            self.last_error = repr(e)
            return
        self._laya = laya

        self.local_models = find_local_models()
        want = os.environ.get("LAYA_MODEL", DEFAULT_MODEL_NAME)
        if self.local_models and want not in self.local_models:
            # 想要的检查点没下到本地，退到已经有的那个（避免又去联网下载）
            self.model_name = sorted(self.local_models)[0]
            self.last_error = "本机没有 %r 检查点，已退到 %r" % (want, self.model_name)
        else:
            self.model_name = want

        device = os.environ.get("LAYA_DEVICE")
        preload = os.environ.get("LAYA_PRELOAD", "1") == "1"
        dev_kw = {"device": device} if device else {}

        # 首选 Router。★ 不要用 Router(preload=True)：
        #   那会把 self.models 里的三个检查点【全部】下载并常驻（合计约 2.3GB 权重）。
        #   正确做法是先建 Router(preload=False)，再只 preload 我们要的那一个。
        Router = getattr(laya, "Router", None)
        if Router is not None:
            for use_local in (True, False):
                if use_local and not self.local_models:
                    continue
                models = self.local_models if use_local else None
                try:
                    r = Router(models=models, preload=False, default=self.model_name, **dev_kw)
                    if preload:
                        r.preload([self.model_name])
                    self.obj = r
                    self.kind = "router"
                    self.detail = "laya.Router(%sdefault=%s, 只预载 %s)" % (
                        ("local_models, " if use_local else ""), self.model_name, self.model_name)
                    break
                except Exception as e:
                    self.last_error = "Router(use_local=%s): %r" % (use_local, e)

        # 退而求其次：直接加载单个检查点（本地优先）
        if self.obj is None and hasattr(laya, "load"):
            cands = []
            if self.model_name in self.local_models:
                cands.append((self.local_models[self.model_name], None))
            cands += [("convaiinnovations/laya", "typed-decisions"), ("convaiinnovations/laya", None)]
            for repo, sub in cands:
                try:
                    self.obj = laya.load(repo, subfolder=sub) if sub else laya.load(repo)
                    self.kind = "agent"
                    self.detail = "laya.load(%s%s)" % (repo, "" if not sub else ", subfolder=%s" % sub)
                    break
                except Exception as e:
                    self.last_error = "load(%s,%s): %r" % (repo, sub, e)

        self.load_ms = int((time.time() - t0) * 1000)

    @property
    def ready(self):
        return self.obj is not None

    def predict(self, state, questions):
        """单次前向传播回答全部问题。"""
        if self.kind == "router":
            try:
                return self.obj.predict(state, questions, model=self.model_name)
            except TypeError:
                return self.obj.predict(state, questions)
        return self.obj.predict(state, questions)

    def device_label(self):
        """当前推理设备的人类可读标签。

        ★ 刻意不做「静默回落到 CPU」：如果 LAYA_DEVICE=cuda 但 torch 装的是 CPU 版，
          一定要把这件事说出来。否则 benchmark 会给出「用了 GPU」的假结论 ——
          这正是本轮最容易犯的错（本机初始就是 torch 2.14.0+cpu）。
        """
        want = (os.environ.get("LAYA_DEVICE") or "").strip()
        try:
            import torch
            avail = torch.cuda.is_available()
            if want.lower().startswith("cuda"):
                if avail:
                    return "cuda (%s)" % torch.cuda.get_device_name(0)
                return "cpu ｜ ⚠ LAYA_DEVICE=cuda 但 CUDA 不可用（torch %s，多半是 CPU 版）" % torch.__version__
            if avail:
                return "cpu ｜ 可用的 CUDA 未启用，设 LAYA_DEVICE=cuda 开启"
            return "cpu (torch %s, 无 CUDA)" % torch.__version__
        except Exception:
            return want or "cpu (torch 未安装)"

    def describe(self):
        out = {
            "kind": self.kind,
            "ready": self.ready,
            "detail": self.detail,
            "load_ms": self.load_ms,
            "fastload": self.fastload,
            "model_name": self.model_name,
            "local_models": sorted(self.local_models),
            "models_dir": str(MODELS_DIR),
        }
        if self.last_error:
            out["last_error"] = self.last_error
        st = getattr(install_fastload, "state", None)
        if st:
            out["fastload_rebuilt_buffers"] = st.get("rebuilt")
            if st.get("why"):
                out["fastload_disabled_why"] = st["why"]
        if not self.ready:
            return out
        laya = getattr(self, "_laya", None)
        # 把本机实际的 API 形状报出来，方便对齐版本差异
        try:
            out["module_functions"] = sorted(
                n for n in dir(laya) if not n.startswith("_") and callable(getattr(laya, n, None))
            )[:40]
        except Exception:
            pass
        try:
            sig = inspect.signature(self.obj.predict)
            out["predict_signature"] = "predict" + str(sig)
        except Exception:
            pass
        try:
            out["presets"] = [
                n for n in dir(laya)
                if n.endswith("_questions") and callable(getattr(laya, n))
            ]
        except Exception:
            pass
        return out


ENGINE = LayaEngine()

# ==========================================================================
# 2. 回退引擎
#    Laya 不可用时的降级路径。只做关键词 + 角色状态权重，输出 schema 与
#    Laya 完全一致，所以前端不需要知道自己连的是哪条路径。
#    置信度显著更低（config.director 的阈值判断会照常工作）。
# ==========================================================================
INTENT_LEXICON = {
    "evade":    ["不重要", "明天", "再说", "改天", "何必", "不方便", "没必要", "别问", "以后", "回头", "不想说", "换一个", "先不说"],
    "lie":      ["发誓", "真的", "我保证", "绝对", "不认识", "从来", "当然", "怎么可能", "骗你干嘛"],
    "sincere":  ["说实话", "老实说", "实话", "我承认", "坦白", "不瞒你", "的确", "确实", "我告诉你"],
    "kind":     ["谢谢", "保重", "帮你", "救你", "我来", "替你", "小心", "别怕", "受伤", "你还好吗", "护着"],
    "threaten": ["杀了", "去死", "别怪", "后果", "交出来", "否则", "逼我", "让你", "敢动", "不客气"],
    "probe":    ["你是谁", "你叫什么", "你到底", "你怎么知道", "你的名字", "你打算", "为什么", "你在找", "什么来头"],
    "smalltalk":["天气", "酒不错", "喝一杯", "雨", "好冷", "好吃", "这地方", "今晚"],
}

INTENT_SCORE_BASE = {"evade": 1.6, "lie": 0.7, "sincere": 3.1, "kind": 3.5,
                     "threaten": 0.4, "probe": 1.9, "smalltalk": 2.6}

BEHAVIOR_WEIGHTS = {
    "ask":      {"suspicion": 0.30, "~trust": 0.34, "identify": 0.36},
    "observe":  {"caution": 0.26, "intuition": 0.22, "~alert": 0.30},
    "probe":    {"caution": 0.32, "intuition": 0.28, "doubt": 0.25, "~justice": 0.15},
    "leave":    {"~justice": 0.30, "~loyalty": 0.25, "~alert": 0.25, "~suspicion": 0.20},
    "confide":  {"trust": 0.40, "~suspicion": 0.22, "fondness": 0.26, "reliance": 0.26},
    "ally":     {"justice": 0.20, "respect": 0.20, "loyalty": 0.18, "alert": 0.16},
    "distance": {"~trust": 0.34, "suspicion": 0.30, "~fondness": 0.18, "~reliance": 0.18},
}

INTENT_BIAS = {
    "evade":     {"ask": 0.14, "probe": 0.10},
    "lie":       {"ask": 0.16, "observe": 0.08, "distance": 0.06},
    "sincere":   {"confide": 0.16, "observe": 0.06, "distance": -0.08},
    "kind":      {"confide": 0.10, "ally": 0.16, "distance": -0.10},
    "threaten":  {"leave": 0.16, "distance": 0.12, "ally": 0.08},
    "probe":     {"observe": 0.10, "probe": 0.08, "ask": 0.04},
    "smalltalk": {},
}

WORLD_WEIGHTS = {
    "war_outbreak":   {"border_tension": 0.46, "~crown_prestige": 0.24, "cult_involvement": 0.16, "weather_stress": 0.14},
    "caravan_drop":   {"border_tension": 0.30, "~trade_volume": 0.36, "grain_price": 0.30},
    "blackmarket":    {"grain_price": 0.30, "~crown_prestige": 0.28, "~trade_volume": 0.22},
}

FB_GAIN = 1.8    # z 标准化后的温度增益：候选行为数量可变，用固定温度会整体摊平
FB_SIG_T = 0.11  # sigmoid 陡度


def _featurize(actor):
    p = actor.get("personality", {})
    t = actor.get("traits", {})
    e = actor.get("emotion", {})
    r = actor.get("relationship", {})
    g = actor.get("goals", {})
    f = {
        "extraversion": (p.get("extraversion", 0) + 1) / 2,
        "intuition": (p.get("intuition", 0) + 1) / 2,
        "thinking": (p.get("thinking", 0) + 1) / 2,
        "judging": (p.get("judging", 0) + 1) / 2,
        "justice": t.get("justice", 0.5), "caution": t.get("caution", 0.5),
        "loyalty": t.get("loyalty", 0.5), "suspicion": t.get("suspicion", 0.5),
        "alert": e.get("alert", 0.5), "fondness": e.get("fondness", 0.5), "fatigue": e.get("fatigue", 0.2),
        "trust": r.get("trust", 50) / 100, "respect": r.get("respect", 50) / 100,
        "doubt": r.get("doubt", 50) / 100, "reliance": r.get("reliance", 50) / 100,
        "identify": g.get("identify_player", 0.5), "order": g.get("complete_order", 0.5),
        "risk": actor.get("situation", {}).get("risk", 0.5),
    }
    for k, v in list(f.items()):
        f["~" + k] = 1 - v
    return f


def _softmax_z(pairs, gain=FB_GAIN):
    """先标准化再上温度。
    候选行为数量会随场景变化，固定温度下候选越多分布越平，
    概率就没法横向比较了；标准化后分布形状与候选数量基本无关。"""
    if not pairs:
        return []
    vals = [p for _, p in pairs]
    n = len(vals)
    mean = sum(vals) / n
    var = sum((v - mean) ** 2 for v in vals) / n
    std = math.sqrt(var) or 1e-6
    z = [(k, (p - mean) / std * gain) for k, p in pairs]
    m = max(v for _, v in z)
    ex = [math.exp(v - m) for _, v in z]
    s = sum(ex)
    return [(k, e / s) for (k, _), e in zip(z, ex)]


def _sigmoid(v, temp=FB_SIG_T):
    return 1 / (1 + math.exp(-(v - 0.5) / temp))


def _lex_score(text):
    """关键词打分。强信号（回避/撒谎/坦诚/示好/威胁/试探）优先，
    只有完全没有强信号时才退到闲聊——否则「喝一杯+今晚」这种
    弱命中堆积会盖过「明天」这种强回避信号。"""
    text = text or ""
    hits = {k: 0.0 for k in INTENT_LEXICON}
    for intent, words in INTENT_LEXICON.items():
        if intent == "smalltalk":
            continue
        hits[intent] = sum(0.6 + 0.2 * len(w) for w in words if w in text)
    if max(hits.values()) <= 0:
        hits["smalltalk"] = sum(0.4 + 0.2 * len(w) for w in INTENT_LEXICON["smalltalk"] if w in text) or 0.6
    return hits


def fallback_decide(actor, world_state, player_input, questions, seed=None):
    """输出与 Laya 同构的 answers。"""
    rng = random.Random(seed if seed is not None else int(time.time() * 1000) % 100000)
    f = _featurize(actor)
    hits = _lex_score(player_input)
    intent_pairs = _softmax_z([(k, v + rng.uniform(0, 0.18)) for k, v in hits.items()], gain=1.4)
    intent_pairs.sort(key=lambda x: -x[1])
    intent = intent_pairs[0][0]

    answers = {}

    # ---- choice: 玩家意图 ----
    if "player_intent" in questions:
        crit = list(questions["player_intent"]["criteria"].keys())
        probs = {k: v for k, v in intent_pairs}
        for c in crit:
            probs.setdefault(c, 0.0)
        answers["player_intent"] = {"choice": intent, "confidence": round(intent_pairs[0][1], 4),
                                    "_fallback_probabilities": probs}

    # ---- choice: NPC 行为 ----
    if "npc_behavior" in questions:
        crit = list(questions["npc_behavior"]["criteria"].keys())
        raw = []
        bias = INTENT_BIAS.get(intent, {})
        for bid in crit:
            w = BEHAVIOR_WEIGHTS.get(bid)
            if w is None:
                raw.append((bid, 0.4))
                continue
            s = sum(f.get(k, 0.0) * wt for k, wt in w.items()) + bias.get(bid, 0.0) + rng.uniform(0, 0.03)
            raw.append((bid, s))
        probs = _softmax_z(raw)
        probs.sort(key=lambda x: -x[1])
        answers["npc_behavior"] = {"choice": probs[0][0], "confidence": round(probs[0][1], 4),
                                   "_fallback_probabilities": {k: v for k, v in probs}}

    # ---- score: 状态增量（关键词意图 → 序数，再按角色状态微调）----
    base = INTENT_SCORE_BASE.get(intent, 2.5)
    adjustments = {
        "trust_shift": base + (0.4 if f["trust"] > 0.7 else 0) - (0.5 if f["doubt"] > 0.6 else 0),
        "respect_shift": base - 0.2 + (0.3 if intent in ("sincere", "kind") else 0),
        "doubt_shift": 4 - base + (0.5 if f["suspicion"] > 0.6 else 0),
        "fondness_shift": base + (0.2 if intent == "kind" else -0.2),
        "alert_shift": 4 - base + (0.6 if intent == "threaten" else 0),
        "goal_shift": 4 - base + (0.4 if f["doubt"] > 0.5 else 0),
    }
    for qid, val in adjustments.items():
        if qid in questions:
            n = len(questions[qid].get("criteria", [])) - 1
            answers[qid] = {"score": round(max(0.0, min(float(n), val + rng.uniform(-0.25, 0.25))), 3)}

    # ---- noul ----
    tension = 0.30 if intent in ("threaten", "lie") else (0.12 if intent == "evade" else 0.0)
    if "betrayal_intent" in questions:
        p = _sigmoid(0.35 * f["doubt"] + 0.30 * (1 - f["trust"]) + 0.25 * f["suspicion"] - 0.30 + tension, 0.18)
        answers["betrayal_intent"] = {"noul": round(p, 4)}
    if "hidden_event" in questions:
        p = _sigmoid(0.50 * f["risk"] + 0.25 * f["alert"] + 0.20 * f["doubt"] - 0.15 + tension, 0.18)
        answers["hidden_event"] = {"noul": round(p, 4)}

    # ---- 世界层 ----
    for qid, w in WORLD_WEIGHTS.items():
        if qid in questions:
            fw = {k: world_state.get(k.lstrip("~"), 0.5) for k in w}
            fw.update({"~" + k.lstrip("~"): 1 - world_state.get(k.lstrip("~"), 0.5) for k in w})
            s = sum(fw.get(k, 0.0) * wt for k, wt in w.items())
            answers[qid] = {"noul": round(_sigmoid(s), 4)}

    return answers, intent, intent_pairs


# ==========================================================================
# 3. 归一化：把 Laya 的返回塞进统一 schema
# ==========================================================================
_RAW_KEYS = ("answers", "result", "output", "predictions")


def normalize_laya(res):
    """不同版本的 Laya 可能把答案放在不同层，这里统一剥出来。"""
    if not isinstance(res, dict):
        return {}, {}
    ans = None
    for k in _RAW_KEYS:
        if isinstance(res.get(k), dict):
            ans = res[k]
            break
    if ans is None:
        ans = res
    meta = {k: v for k, v in res.items() if k not in _RAW_KEYS}
    return ans, meta


def extract_probs(payload, criteria):
    """从各种可能的字段名里找每个选项的概率。"""
    if not isinstance(payload, dict):
        return None
    for k, v in payload.items():
        if isinstance(v, dict) and set(criteria) & set(v.keys()):
            return {c: float(v.get(c, 0.0)) for c in criteria}
        if k.lower() in ("probabilities", "probs", "probability", "distribution", "scores", "logits"):
            if isinstance(v, dict):
                return {c: float(v.get(c, 0.0)) for c in criteria}
            if isinstance(v, (list, tuple)) and len(v) == len(criteria):
                return {c: float(x) for c, x in zip(criteria, v)}
    return None


def normalize_answers(raw_answers, questions):
    out = {}
    for qid, cfg in (questions or {}).items():
        a = raw_answers.get(qid) if isinstance(raw_answers, dict) else None
        if a is None:
            out[qid] = {"_missing": True}
            continue
        if not isinstance(a, dict):
            out[qid] = {"_raw": a}
            continue
        item = dict(a)
        crit = None
        t = cfg.get("type")
        if t == "choice":
            crit = list(cfg.get("criteria", {}).keys())
            probs = extract_probs(a, crit) or a.get("_fallback_probabilities")
            if probs:
                s = sum(probs.values()) or 1.0
                item["_probabilities"] = {k: v / s for k, v in probs.items()}
            item["_value"] = a.get("choice")
        elif t == "score":
            item["_value"] = a.get("score")
        elif t == "noul":
            v = a.get("noul", a.get("probability", a.get("p")))
            item["_value"] = v
        out[qid] = item
    return out


# ==========================================================================
# 4. 状态增量：score → 插值 → 归因系数
# ==========================================================================
def _lerp_table(mapping, x):
    if not mapping:
        return 0.0
    x = max(0.0, min(float(len(mapping) - 1), float(x)))
    i = int(math.floor(x))
    j = min(i + 1, len(mapping) - 1)
    frac = x - i
    return mapping[i] * (1 - frac) + mapping[j] * frac


def build_deltas(answers, questions, actor):
    """把 Laya 的 score 期望值翻译成实际状态增量。"""
    sh = CFG.get("state_shift", {})
    paths = sh.get("paths", {})
    attr = sh.get("attribution", {})
    trait_path = attr.get("trait", "traits.suspicion")
    suspicion = _dig(actor, trait_path, 0.5)
    k_pos = 0.5 + (1 - suspicion)
    k_neg = 0.5 + suspicion
    pos_keys = set(attr.get("positive_keys", []))
    enabled = bool(attr.get("enabled", True))

    deltas = []
    for qid, spec in paths.items():
        if qid not in answers or answers[qid].get("_value") is None:
            continue
        mapping = questions.get(qid, {}).get("mapping")
        raw = _lerp_table(mapping, answers[qid]["_value"])
        is_pos = qid in pos_keys
        coef = (k_pos if is_pos else k_neg) if enabled else 1.0
        delta = raw * coef * float(spec.get("scale", 1.0))
        deltas.append({
            "question": qid,
            "target": spec["target"],
            "label": spec.get("label") or qid.replace("_shift", ""),
            "raw": round(raw, 3),
            "attribution": round(coef, 3),
            "delta": round(delta, 3),
            "range": spec.get("range", [0, 100]),
        })
    return deltas, {"k_positive": round(k_pos, 3), "k_negative": round(k_neg, 3), "enabled": enabled}


def _dig(obj, path, default=None):
    cur = obj
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return cur


def apply_gates(answers, choice_id):
    """用 noul 门限覆盖 choice 的 argmax，返回 (最终行为 id, 命中信息或 None)。

    算法（只看这三步，没有任何经验阈值写在这里）：
      ① 遍历 CFG["gates"]，取出每个门限问句的 noul 概率 P(true)；
      ② 按概率降序排序 —— 概率最高的门限优先裁决；
      ③ 返回第一个满足 P >= threshold 的 gate.behavior；一个都没命中就原样返回 choice 的 argmax。

    为什么需要这一步：
      · noul 是 Laya **校准过**的 P(true)，跨输入可比、有明确语义，天然适合当门限。
      · choice 即便把选项压短，区分度仍偏弱，argmax 容易停在先验吸引子上。

    所以分工是：choice 出**基础分布**（保留选项间相对次序，前端画分布图仍有意义），
    noul 门限在信号足够强时改写**最终行为**。阈值取在实测分布的空隙上，
    只在证据明确时才覆盖，平时完全不干预 choice —— 宁可漏，不可乱改。

    ★ 各门限的阈值、观察到的分布、以及哪些门限当前「不生效」，统一记在
      narra_config.json 的 gates._note 与 Laya接入报告.md。
      **不要在这里写死实验数值** —— 注释会因为一次重测就变成假的（本站踩过）。
      复现办法：python laya_bridge.py langtest，会列出每个门限的观察最大值、
      阈值、以及是否真的在生效；死门限必须显形，留着假装在工作比删掉更糟。
    """
    gates = CFG.get("gates") or {}
    armed = []
    for qid, g in gates.items():
        if qid.startswith("_") or not isinstance(g, dict):
            continue
        p = answers.get(qid, {}).get("_value")
        if isinstance(p, (int, float)):
            armed.append((qid, float(p), g.get("behavior"), float(g.get("threshold", 1.0))))
    armed.sort(key=lambda t: -t[1])          # 概率最高的门限优先
    for qid, p, beh, thr in armed:
        if beh and p >= thr:
            return beh, {"gate": qid, "p": round(p, 4), "threshold": thr,
                         "choice_said": choice_id,
                         "overrode": choice_id if choice_id != beh else None}
    return choice_id, None


# ==========================================================================
# 4b. 决策信号 + Policy Resolver
#
# 分工（本轮的核心架构改动）：
#     Laya → decision signals → Policy Resolver → behavior candidate
#
# choice 的 argmax 不再直接控制 NPC，它只作为兜底 baseline。
# 理由：choice 对复杂行为的区分力不足，而 noul/score 是校准过的量。
# ==========================================================================
def _signal_meta():
    return (CFG.get("signals") or {}).get("meta") or {}


def _signal_kind(name):
    return (_signal_meta().get(name) or {}).get("kind", "prob")


def signal_snapshot(answers):
    """把 signal_* 问句的答案收成有序快照，返回 (列表, {signal: value})。

    ★ 两类量纲不能混用：
        kind=prob  —— noul 的 P(true)，0~1，可以直接当阈值；
        kind=level —— score 的期望值，0~4，表示强度而不是概率。
      把 level 当 prob 去和 0.7 比大小是错的（0~4 尺度上一个 0.7 是「几乎没有」）。
    """
    spec = CFG.get("signals") or {}
    meta = spec.get("meta") or {}
    order = spec.get("order") or list(meta.keys())
    rows, values = [], {}
    for name in order:
        m = meta.get(name) or {}
        qid = m.get("question") or ("signal_" + name)
        v = (answers.get(qid) or {}).get("_value")
        if v is None:
            continue
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        values[name] = v
        rows.append({"signal": name, "label": m.get("label") or name,
                     "kind": m.get("kind") or "prob", "value": round(v, 4),
                     "question": qid, "range": m.get("range")})
    return rows, values


def _rule_matches(when, values):
    """一条规则的全部区间约束是否都满足。缺信号的约束视为不满足 —— 不放行。"""
    hits = []
    for name, rng in (when or {}).items():
        v = values.get(name)
        if v is None:
            return None
        pair = (list(rng) + [None, None])[:2]
        lo, hi = pair[0], pair[1]
        if lo is not None and v < lo:
            return None
        if hi is not None and v > hi:
            return None
        hits.append({"signal": name, "value": round(v, 4),
                     "range": [lo, hi], "kind": _signal_kind(name)})
    return hits


def assess_ambiguity(values):
    """歧义裁定，返回 (level, reasons)；level ∈ strong / moderate / ambiguous。

    ★ 判据设计上踩过一个坑，记在这里免得后人重踩：
      最初把「top1 与 top2 的差值 < margin」当成歧义条件，即把 8 个 prob 信号
      当成**互相竞争的候选**。但它们是**正交**的 —— 敌意 0.88 与怀疑 0.80 完全可以
      同时成立，"两个数挨得近" 并不代表模型不知道该怎么办。
      后果实测可见：敌意 0.88 + 退出 0.71（两条规则条件都满足）被判成 ambiguous，
      规则根本没机会触发。
      现在只保留两个触发条件：
        · 没有任何信号越出中间带 —— 这才是「所有维度上都没把握」的正确表达；
        · 可用信号数不足。
      top1/top2 差值仍然计算并返回，但只作审计信息，不再参与判定。

    ★ 刻意不追求「每次都给出一个结果」。在中间带里硬选一个，等于把模型的不确定性
      藏起来，下游 Director / Story Agent 就无从判断该不该自己接手。
    """
    amb = (CFG.get("policy") or {}).get("ambiguity") or {}
    margin = float(amb.get("margin", 0.08))
    mid_lo = float(amb.get("mid_low", 0.35))
    mid_hi = float(amb.get("mid_high", 0.65))
    need = int(amb.get("min_signals", 3))

    probs = sorted(((k, v) for k, v in values.items() if _signal_kind(k) == "prob"),
                   key=lambda t: -t[1])
    if len(probs) < need:
        return "ambiguous", [{"why": "可用的 prob 信号数量不足",
                              "have": len(probs), "need": need}]

    # 越出中间带 = 至少有一个维度是「有把握」的
    outside = [(k, v) for k, v in probs if v > mid_hi or v < mid_lo]
    if not outside:
        return "ambiguous", [{"why": "全部 prob 信号都落在中间带，没有任何维度是有把握的",
                              "band": [mid_lo, mid_hi],
                              "values": [[k, round(v, 4)] for k, v in probs]}]

    top = probs[0]
    gap = top[1] - (probs[1][1] if len(probs) > 1 else 0.0)
    info = {"why": "top1 与 top2 差值（仅供参考，不作为歧义判据 —— 信号是正交的）",
            "top1": [top[0], round(top[1], 4)],
            "top2": [probs[1][0], round(probs[1][1], 4)] if len(probs) > 1 else None,
            "gap": round(gap, 4)}

    # strong：有信号越过中间带的幅度 ≥ margin —— 这是「明显有把握」
    decisive = [(k, v) for k, v in outside if v >= mid_hi + margin or v <= mid_lo - margin]
    if decisive:
        return "strong", [{"why": "有信号明显越过中间带",
                           "signals": [[k, round(v, 4)] for k, v in decisive],
                           "band": [mid_lo, mid_hi], "margin": margin}, info]
    return "moderate", [{"why": "有信号越出中间带，但越过幅度未达 margin",
                         "signals": [[k, round(v, 4)] for k, v in outside],
                         "band": [mid_lo, mid_hi], "margin": margin}, info]


def policy_resolve(values, choice_baseline):
    """Decision Signals → Behavior Candidate，输出必须可审计。

    返回：behavior / source / reasons / choice_baseline / confidence_level / fallback
    source ∈ {"policy", "choice_baseline", "ambiguous"}

    求值顺序（★ 改动过，别改回去）：
        1. policy.enabled=false      → 一律回落 choice baseline（当前默认状态）
        2. 逐条规则 {when: 阈值合取} → 命中即 source=policy
        3. 无规则命中且判为歧义       → source=ambiguous，fallback=story_agent，不硬选
        4. 其余                       → source=choice_baseline
    """
    pol = CFG.get("policy") or {}
    level, amb_reasons = assess_ambiguity(values)

    if not pol.get("enabled", False):
        return {"behavior": choice_baseline, "source": "choice_baseline",
                "reasons": [{"why": "policy.enabled=false，规则未启用，回落 choice baseline",
                             "note": "阈值尚未由实测分布确认 —— 宁可不改，也不要乱改"}],
                "choice_baseline": choice_baseline, "confidence_level": level,
                "ambiguity_reasons": amb_reasons, "fallback": None}

    # ★ 顺序很重要：**先求规则，再判歧义**。
    #   规则是「人写死的显式阈值合取」（如 hostility≥0.75 且 withdraw≥0.65），命中即
    #   代表一个具体、有依据的判断；歧义判据是「没有任何维度有把握」的兜底。
    #   把歧义放在前面 → 规则永远触发不了（实测踩过，详见 assess_ambiguity 注释）。
    for rule in pol.get("rules") or []:
        hits = _rule_matches(rule.get("when"), values)
        if hits:
            return {"behavior": rule.get("behavior"), "source": "policy",
                    "reasons": hits, "choice_baseline": choice_baseline,
                    "confidence_level": level, "ambiguity_reasons": amb_reasons,
                    "fallback": None}

    if level == "ambiguous":
        return {"behavior": choice_baseline, "source": "ambiguous",
                "reasons": amb_reasons, "choice_baseline": choice_baseline,
                "confidence_level": level, "ambiguity_reasons": amb_reasons,
                "fallback": "story_agent"}      # ★ 交 Story/Director，不硬选

    return {"behavior": choice_baseline, "source": "choice_baseline",
            "reasons": [{"why": "没有规则命中，回落 choice baseline"}],
            "choice_baseline": choice_baseline, "confidence_level": level,
            "ambiguity_reasons": amb_reasons, "fallback": None}


def decision_history_entries(intent_id, behavior_id):
    """把一轮决策压成英文 decision_history 记录（玩家一条 + NPC 一条）。

    ★ 刻意**不**把 NPC 的中文台词翻成英文再塞进去：逐轮翻译既慢又会累积误差，
      而且把文学文本当决策记录本身就是错配。
      这里只记录**已经结构化的决策结果**（玩家意图 + NPC 行为），
      措辞直接取自配置里的英文 criteria —— 天然英文、天然可比、天然可审计。
    """
    out = []
    if intent_id:
        crit = ((CFG.get("questions", {}).get("player_intent") or {}).get("criteria") or {}).get(intent_id)
        out.append({"type": "player_%s" % intent_id,
                    "summary": "player %s" % (crit or intent_id)})
    if behavior_id:
        crit = behavior_short_criteria().get(behavior_id)
        out.append({"type": "npc_%s" % behavior_id,
                    "summary": "npc %s" % (crit or behavior_id)})
    return out


def build_decision_history(payload, accumulated=None):
    """取结构化决策历史：payload 显式给的优先，否则用桥内累积的（最近 6 条）。

    ★ 契约（§8）：每条 summary 必须是**与 state 文档同语言的结构化短语**
      （英文档就英文，中文档就中文），且只描述「决策结果」——
      例如 "player threatens or pressures her" / "npc politely keeps her distance"。
      不要塞逐轮的中文文学台词：那是 §8 的原始 bug ——
      state 文档是英文的，中间夹几段中文完整台词，Laya 会在这些 token 上失焦。
      桥内累积的条目由 decision_history_entries() 生成，天然满足这个契约；
      只有外部调用方自己传 decision_history 时才有可能破坏它。
    """
    dh = payload.get("decision_history")
    if isinstance(dh, list) and dh:
        return [d for d in dh if isinstance(d, dict) and d.get("summary")][-6:]
    return list(accumulated or [])[-6:]


# ==========================================================================
# 5. 叙事层：Laya 只给「行为」，台词交给 LLM（或配置里的台词池）
# ==========================================================================
LINE_OPEN, LINE_CLOSE = "<line>", "</line>"

# 出现两个以上这些词，就认为这段是「复述要求/写计划」，不是台词。
_PLAN_MARKERS = ("句，", "2~4", "2-4", "不要", "不能", "保持", "收束", "要求", "规则",
                 "写：", "不分段", "列点", "引导选项", "内心活动", "然后台词", "这是动作")


def extract_line(text):
    """从模型输出里取出台词，返回 (台词 或 None, 是否为结构化标签形式)。

    ★ 为什么必须做这一步（实测踩到的真 bug）：
      effort=low 时 DeepSeek-V4.1-Flash 有时**不产出独立的推理通道**
      （usage 里 reasoning_tokens=0），而是把「先复述一遍系统要求、再写自己的计划」
      直接写进 `message.content`。实测抓到过一次完整污染输出，长这样：

        「」内台词，2-4句，外部可见言行，交出秘密但不解释，收束本轮，不提问不引导。
        莉亚看到火漆印，然后主动说出真正的目的——给出一个新名字/新线索，但不解释。
        …… 好。写4句左右。她接过信，拇指在火漆的剑与焰上压了一下……
        「灰鸦是幌子，我北上的路引上写的是另一个名字。」……

      前端把 content 原样显示，用户看到的是 NPC 在念需求文档 —— 这是最难看的一类失败：
      模型明明答对了，交付出来是错的。

    修法分两层（**不要试图用启发式把计划和台词切开** —— 我试过，两者是交错在一起的，
    按「第一个像样的引号」切会把计划里的例句当成台词开头，越切越错）：
      ① 结构化：要求模型把台词包在 <line></line> 里。有标签 → 直接取标签内内容，零歧义。
      ② 没标签且文本带 >=2 个「要求/计划」标记词 → **判为不可用，返回 None**，
         交给 llm_narrate 重试一次；重试还不行就退回台词池。
         宁可显示一句正确的池子台词，也绝不把计划文本端给用户。
    """
    if not text:
        return None, False
    lo, hi = text.find(LINE_OPEN), text.rfind(LINE_CLOSE)
    if lo >= 0 and hi > lo:
        inner = text[lo + len(LINE_OPEN):hi].strip()
        if inner:
            return inner, True
    hits = sum(1 for m in _PLAN_MARKERS if m in text)
    if hits >= 2:
        return None, False
    return text, False


def _build_narrate_prompt(actor, behavior, player_input, history, state_line, strict=False):
    sys_p = (
        "你在为一款文字冒险游戏写 NPC 的回应。\n"
        "角色：%s，%s。\n"
        "本轮她决定做出的行为是「%s」（%s）。\n"
        "表现要求：%s\n"
        "当前关系与情绪：%s\n"
        "规则：\n"
        "1) 台词用「」包裹，配少量动作或环境描写，2~4 句，不要分段列点。\n"
        "2) 只写外部可见的言行。\n"
        "3) 不替玩家说话、不替玩家做决定、不在结尾提问引导选项。\n"
        "4) 用中文。\n"
        "格式（必须遵守）：把最终回应原文放进 <line> 与 </line> 之间。\n"
        "这两个标签之外**一个字符都不要写** —— 不要复述上面的规则、不要写你的思路或提纲、"
        "不要解释你为什么这么写。直接开始写她的言行。"
    ) % (actor.get("name", "NPC"), actor.get("identity", ""), behavior["name"], behavior["desc"],
         behavior.get("instr", ""), state_line)
    convo = "\n".join(
        "%s：%s" % ("玩家" if h.get("role") == "player" else actor.get("name", "NPC"), h.get("text", ""))
        for h in (history or [])[-8:]
    )
    user_p = (convo + "\n玩家：%s\n\n请写出她此刻的回应。" % player_input).strip()
    if strict:
        # 第二次尝试：把要求压到最短，并明确禁止「先写计划」。
        # 上一次的失败模式就是模型把系统提示的清单当成待办事项复述了一遍，
        # 所以重试时不再重复那套清单，只留一句最直白的格式命令。
        user_p += ("\n\n（重要）直接输出 <line>……</line>，标签内就是她的台词与动作原文。"
                   "先在心里想，不要写出来。第一段字符必须就是 <line>，"
                   "不许出现「内台词」「2-4句」「不要」「保持」「收束」这类字样。")
    return sys_p, user_p


def llm_narrate(actor, behavior, player_input, history, state_line, include_reasoning=False):
    """调用 LLM 生成台词。
    实测要点（DeepSeek-V4.1-Flash）：
      - 模型 id 是 deepseek-flash，不是显示名 DeepSeek-V4.1-Flash
      - 输出里 reasoning_tokens 常占 60~80%，max_tokens 给太小会把推理吃光、content 变空字符串
      - effort 档位 low/high/max；★ low 有时没有独立推理通道，会把「复述要求 + 写计划」
        直接写进 content（实测样本见 extract_line 的注释）。
        因此：先按 <line> 结构化解析；解析不出来就**降温重试一次**；
        仍失败则返回 error，让调用方退回台词池 —— 绝不把计划文本端给用户。
      - 正文在 message.content，推理轨迹在 message.reasoning_content（不要混进台词）"""
    key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("LLM_API_KEY")
    if not key:
        return None
    base = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com").rstrip("/")
    model = os.environ.get("LLM_MODEL", "deepseek-flash")
    effort = os.environ.get("LLM_EFFORT", "low")
    try:
        max_tokens = int(os.environ.get("LLM_MAX_TOKENS", "1600"))
    except Exception:
        max_tokens = 1600

    def once(strict):
        sys_p, user_p = _build_narrate_prompt(actor, behavior, player_input, history,
                                              state_line, strict=strict)
        payload = {
            "model": model,
            "messages": [{"role": "system", "content": sys_p}, {"role": "user", "content": user_p}],
            # 重试时降温：温度低模型更愿意照格式走，而不会即兴把计划也写出来
            "temperature": 0.35 if strict else 1.0,
            "max_tokens": max_tokens,
            "stream": False,
        }
        if effort:
            payload["effort"] = effort
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            base + "/chat/completions", data=body,
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
            method="POST",
        )
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                data = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return {"error": "HTTP %s: %s" % (e.code, e.read().decode("utf-8", "ignore")[:300])}
        except Exception as e:
            return {"error": repr(e)}
        ms = (time.perf_counter() - t0) * 1000
        try:
            msg = data["choices"][0]["message"]
        except Exception:
            return {"error": "返回结构异常: %s" % json.dumps(data, ensure_ascii=False)[:300]}
        text = (msg.get("content") or "").strip()
        usage = data.get("usage") or {}
        line, tagged = extract_line(text)
        return {
            "source": "llm", "model": data.get("model") or model, "effort": effort,
            "latency_ms": round(ms, 1),
            "reasoning_tokens": (usage.get("completion_tokens_details") or {}).get("reasoning_tokens"),
            "completion_tokens": usage.get("completion_tokens"),
            "contaminated": (not tagged) and bool(line),
            "line": line, "raw_content": text,
            "reasoning": msg.get("reasoning_content") or "",
        }

    r1 = once(strict=False)
    if r1 is None or r1.get("error") or r1.get("line"):
        return _finish_meta(r1, include_reasoning)
    # 第一次拿不到台词（content 为空，或被判为「混进计划文本」）→ 降温重试一次
    first_raw = (r1 or {}).get("raw_content") or ""
    why = "content 为空" if not first_raw else "content 被判为混入了计划/要求文本"
    r2 = once(strict=True)
    if r2 is None or r2.get("error") or not r2.get("line"):
        out = _finish_meta(r1 if (r1 and not r1.get("error")) else r2, include_reasoning)
        out["error"] = ("模型两次都没给出可用台词（第一次：%s；重试也失败）。"
                        "本次退回台词池。要根治建议把 LLM_EFFORT 调成 high —— "
                        "high 会走独立的推理通道，计划就不会落进 content。" % why)
        out["raw_content_first"] = first_raw
        out["retried"] = True
        return out
    r2["retried"] = True
    r2["contaminated"] = False          # 重试后拿到了结构化结果，是「重试成功」而不是「被清洗」
    r2["raw_content_first"] = first_raw
    return _finish_meta(r2, include_reasoning)


def _finish_meta(r, include_reasoning):
    """统一收尾：不带 raw_content/reasoning 时把它们收进诊断字段，别让它们塞满正常响应。"""
    if r is None or r.get("error"):
        return r or {"error": "no result"}
    if not include_reasoning:
        r.pop("reasoning", None)
        r.pop("raw_content", None)
    if r.get("line"):
        r["line"] = r["line"].strip()
    return r


def pool_line(behavior, player_input):
    pool = behavior.get("fallback_lines") or ["（她没有回答。）"]
    idx = abs(hash((behavior.get("id", ""), player_input or ""))) % len(pool)
    return {"line": pool[idx], "source": "pool"}


# ==========================================================================
# 6. state 文档：原则 3 —— 只送压缩后的决策状态，不送角色卡与剧情
#
# ★ 语言分工（最容易踩的架构坑）：
#   Laya 的 typed-decisions 检查点是英文 ModernBERT。README 自己的基准表写着
#   英文检查点在非拉丁脚本上会「高置信度 + 零准确率」（高棉语 0.952 置信 / 0.000 准确），
#   而 multilingual 检查点在 typed-decisions 任务上只有 0.342（低于 0.318 随机基线）。
#   结论：喂给 Laya 的决策文档必须全英文，中文只用于 UI 展示与 LLM 台词。
#   连玩家的中文台词也要先翻成英文，否则 state 里混着中文，同样静默失效。
# ==========================================================================
LANG = CFG.get("laya_language", "en")

_XLATE_CACHE = {}


def translate_to_en(text):
    """把玩家台词翻成英文。返回 (英文, 来源)。失败则原样返回并标 none。"""
    if not text:
        return "", "empty"
    if text in _XLATE_CACHE:
        return _XLATE_CACHE[text], "cache"
    key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("LLM_API_KEY")
    if not key:
        return text, "none"
    base = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com").rstrip("/")
    payload = {
        "model": os.environ.get("LLM_MODEL", "deepseek-flash"),
        "messages": [
            {"role": "system", "content": "Translate the user's game-dialogue line into English. "
                                          "Keep the tone and intent exactly. Output only the translation, "
                                          "no quotes, no explanation."},
            {"role": "user", "content": text},
        ],
        "temperature": 0.0, "max_tokens": 600, "stream": False, "effort": "low",
    }
    try:
        req = urllib.request.Request(
            base + "/chat/completions", data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + key}, method="POST")
        with urllib.request.urlopen(req, timeout=60) as r:
            j = json.loads(r.read().decode("utf-8"))
        out = (j["choices"][0]["message"].get("content") or "").strip()
        if out:
            if len(_XLATE_CACHE) > 300:
                _XLATE_CACHE.clear()
            _XLATE_CACHE[text] = out
            return out, "llm"
    except Exception:
        pass
    return text, "none"


def behavior_short_criteria():
    """行为选择题的选项文本：取 behaviors[].short_en（3~5 个词）。

    为什么不用 desc_en：长描述会让某一个选项变成**先验吸引子** —— 语义相反的输入
    会给出同一个 argmax。压成短标签后 argmax 才随输入移动。
    这是**选项长度约束**，不是措辞偏好；对照数据见 Laya接入报告.md。
    所以这里只认 short_en，缺了才退回 id —— 不要改回 desc_en。
    """
    return {b["id"]: (b.get("short_en") or b["id"]) for b in (CFG.get("behaviors") or [])}


def build_laya_questions(questions):
    """只把 type / instructions / criteria 交给 Laya。
    mapping、label 这些是我们自己的后处理元数据，混进文档既占 token 也可能干扰选项判断。

    criteria_source: "behaviors" —— 选项从 behaviors[].short_en 现取，避免和
    behavior 列表两处各写一份短标签后悄悄漂移（改了一处忘了另一处，是这类配置最常见的坑）。
    """
    out = {}
    for qid, q in (questions or {}).items():
        if not isinstance(q, dict) or "type" not in q:
            continue
        item = {"type": q["type"], "instructions": q.get("instructions", "")}
        if q["type"] == "choice":
            if q.get("criteria_source") == "behaviors":
                crit = behavior_short_criteria()
            else:
                crit = (q.get("criteria_zh") if LANG == "zh" and q.get("criteria_zh")
                        else q.get("criteria")) or {}
            item["criteria"] = crit
        elif q["type"] == "score":
            crit = q.get("criteria")
            if LANG == "zh" and q.get("criteria_zh"):
                crit = q["criteria_zh"]
            item["criteria"] = crit or []
        out[qid] = item
    return out


# ---- 人格：紧凑表示 --------------------------------------------------------
# signed   : extraversion -0.35, intuition 0.25, thinking 0.55, judging 0.70
# polarity : introversion 0.35, intuition 0.25, thinking 0.55, judging 0.70
# 两种写法语义等价（polarity 把负向轴翻成正向轴名，避免出现负号）。
# 哪种对 tokenizer 更有效必须实测，不要凭直觉定 —— 见 cmd_personatest。
_POLARITY_FLIP = {"extraversion": "introversion"}


def personality_style():
    """当前的人格渲染写法：signed（默认）或 polarity。

    优先级：环境变量 LAYA_PERSONA_STYLE > 配置 personality_style。
    ★ 为什么要有环境变量：personatest 的 docstring 一直写着可以
      `LAYA_PERSONA_STYLE=polarity python laya_bridge.py personatest` 对照另一种写法，
      但这条路径此前**根本没实现** —— 写进文档的开关必须真的能用，
      否则「实验结果可复现」就是空话（§16）。
    """
    want = (os.environ.get("LAYA_PERSONA_STYLE") or "").strip().lower()
    if want in ("signed", "polarity"):
        return want
    return CFG.get("personality_style", "signed")


def personality_line(personality):
    """把 actor.personality 渲染成一行紧凑文本，供 compact state 使用。

    ★ 为什么需要这个函数：actor.personality 一直写在配置里，但 compact state
      从来没把它喂给 Laya —— 换句话说「人格影响决策」这件事在 Demo 里
      **从未被验证过**。在把它接进 state 之前测到的任何差异，都不能归因给人格。
    """
    if not personality:
        return ""
    style = personality_style()
    parts = []
    for k, v in personality.items():
        try:
            fv = float(v)
        except (TypeError, ValueError):
            continue
        if style == "polarity":
            flipped = _POLARITY_FLIP.get(k)
            if flipped:
                parts.append("%s %.2f" % (flipped, -fv))
                continue
        parts.append("%s %.2f" % (k, fv))
    return ", ".join(parts)


def build_state_doc(actor, player_input, history, scene, world_state=None, player_input_en=None,
                    decision_history=None):
    """构造喂给 Laya 的决策文档。

    ★ state_format = "compact"（默认）
      早期用的是 12 字段嵌套 JSON（role/name/identity/personality_axes/traits/emotion/
      relationship_to_player/goals/situation/scene/recent_conversation/player_says）。
      问题有两个：
        1. 没有锚点。instructions 里写 "this sentence"，模型无法知道指的是哪个字段；
           而 Laya 自带 presets 的写法是反引号引用键名（`message`），state 就是含该键的 dict。
        2. token 全花在长键名和嵌套缩进上，会撑爆 head 预算、被 build_sequence 悄悄截掉尾巴。

      ★ 改这个函数就是在花 token 预算。加字段前必须先跑：
            python laya_bridge.py qcheck
        它按 state_format 逐项报余量。**余量必须为正** —— 否则被截掉的可能是 `message`
        本身，那会让模型完全看不到玩家说了什么，而且不报任何错。
        各检查点的实际余量记在 Laya接入报告.md，不要在这里写死数字。

    ★ state_format = "full" 保留为对照，方便复现早期「无区分度」的形态。
    """
    sit = actor.get("situation", {}) or {}
    fmt = CFG.get("state_format", "compact")

    if fmt == "compact":
        t = actor.get("traits", {}) or {}
        e = actor.get("emotion", {}) or {}
        r = actor.get("relationship", {}) or {}
        g = actor.get("goals", {}) or {}
        pers = personality_line(actor.get("personality"))
        if LANG == "en":
            doc = {"npc": ("%s, %s. Traits: %s. Currently %s."
                           % (actor.get("name_en") or actor.get("name"),
                              actor.get("identity_en") or actor.get("identity"),
                              ", ".join("%s %.2f" % (k, v) for k, v in t.items()),
                              ", ".join("%s %.2f" % (k, v) for k, v in e.items())))}
            if pers:
                doc["personality"] = pers
            doc["relationship"] = ("trust %s/100, respect %s/100, doubt %s/100, reliance %s/100"
                                   % (r.get("trust"), r.get("respect"), r.get("doubt"), r.get("reliance")))
            doc["goals"] = ", ".join("%s %.2f" % (k, v) for k, v in g.items())
            doc["scene"] = ("%s, %s. Risk %.2f. %s"
                            % (sit.get("place_en") or sit.get("place"),
                               sit.get("time_en") or sit.get("time"), sit.get("risk", 0),
                               (scene or {}).get("note_en") or (scene or {}).get("note", "")))
            doc["message"] = player_input_en if player_input_en is not None else player_input
        else:
            doc = {"npc": ("%s，%s。特质：%s。当前：%s。"
                           % (actor.get("name"), actor.get("identity"),
                              "，".join("%s %.2f" % (k, v) for k, v in t.items()),
                              "，".join("%s %.2f" % (k, v) for k, v in e.items())))}
            if pers:
                doc["personality"] = pers
            doc["relationship"] = ("信任 %s/100，尊敬 %s/100，怀疑 %s/100，依赖 %s/100"
                                   % (r.get("trust"), r.get("respect"), r.get("doubt"), r.get("reliance")))
            doc["goals"] = "，".join("%s %.2f" % (k, v) for k, v in g.items())
            doc["scene"] = ("%s，%s。风险 %.2f。%s"
                            % (sit.get("place"), sit.get("time"), sit.get("risk", 0),
                               (scene or {}).get("note", "")))
            doc["message"] = player_input
        # ★ 决策历史与叙事历史分离（不要再退回把原始对话塞进来）：
        #   原始对话里 NPC 的台词是中文文学文本，而 Laya 的 state 必须一律英文。
        #   混着喂会得到「Player: English / NPC: 中文 / Player: English」的交替文本，
        #   模型看到的一半是自己读不懂的脚本，且这种污染从第二轮才开始出现，很难察觉。
        #   所以这里只读结构化的 decision_history；完整中文对话留给 LLM Story Agent。
        dh = decision_history or []
        if dh:
            doc["decision_history"] = dh[-4:]
        if world_state:
            doc["world_state"] = world_state
        return doc

    # ---- full：早期形态，留作对照 ----
    # 注意：full 也走 decision_history，不再用 recent_conversation。
    # 否则这个「对照形态」会重新引入中英混杂，与「Laya state 一律英文」直接冲突，
    # 拿它做对照就变成了拿一个坏掉的形态做对照。
    dh = (decision_history or [])[-4:]
    if LANG == "en":
        doc = {
            "role": "NPC",
            "name": actor.get("name_en") or actor.get("name"),
            "identity": actor.get("identity_en") or actor.get("identity"),
            "personality_axes": actor.get("personality", {}),
            "traits": actor.get("traits", {}),
            "emotion": actor.get("emotion", {}),
            "relationship_to_player": actor.get("relationship", {}),
            "goals": actor.get("goals", {}),
            "situation": {"place": sit.get("place_en") or sit.get("place"),
                          "time": sit.get("time_en") or sit.get("time"),
                          "risk": sit.get("risk")},
            "scene": (scene or {}).get("note_en") or (scene or {}).get("note", ""),
            "player_says": player_input_en if player_input_en is not None else player_input,
        }
    else:
        doc = {
            "role": "NPC",
            "name": actor.get("name"),
            "identity": actor.get("identity"),
            "personality_axes": actor.get("personality", {}),
            "traits": actor.get("traits", {}),
            "emotion": actor.get("emotion", {}),
            "relationship_to_player": actor.get("relationship", {}),
            "goals": actor.get("goals", {}),
            "situation": sit,
            "scene": (scene or {}).get("note", ""),
            "player_says": player_input,
        }
    if dh:
        doc["decision_history"] = dh
    if world_state:
        doc["world_state"] = world_state
    return doc


def state_line(actor):
    r = actor.get("relationship", {})
    e = actor.get("emotion", {})
    return "信任%d 尊敬%d 怀疑%d 依赖%d；警觉%.2f 好感%.2f" % (
        r.get("trust", 0), r.get("respect", 0), r.get("doubt", 0), r.get("reliance", 0),
        e.get("alert", 0), e.get("fondness", 0))


# ==========================================================================
# 7. 决策主流程
# ==========================================================================
# 桥内累积的结构化决策历史（供不显式传 decision_history 的客户端用）
_DECISION_HISTORY = []

# 检查点预算缓存：{模型名: (max_len, head_max_len, tokenizer)}
_BUDGET_CACHE = {}


def checkpoint_budget():
    """当前检查点的 (max_len, head_max_len, tokenizer)；取不到返回 None。

    ★ 只加载 tokenizer（几 MB），不加载模型 —— 所以可以在每轮 decide() 里调用。
    """
    name = DEFAULT_MODEL_NAME
    if name in _BUDGET_CACHE:
        return _BUDGET_CACHE[name]
    d = MODELS_DIR / ("laya-" + name)
    got = None
    if (d / "tokenizer").is_dir():
        try:
            from transformers import AutoTokenizer
            tok = AutoTokenizer.from_pretrained(str(d / "tokenizer"))
            cfg_p = d / "rl_agent_config.json"
            cfg = json.loads(cfg_p.read_text(encoding="utf-8")) if cfg_p.exists() else {}
            got = (int(cfg.get("max_len", 512)), int(cfg.get("head_max_len", 256)), tok)
        except Exception:
            got = None
    _BUDGET_CACHE[name] = got
    return got


def state_budget(state_doc):
    """量当前 state 文档占多少 token、还剩多少余量。返回 dict，量不了返回 None。

    ★★ 为什么必须做运行时检查（这是一个真实的静默失效）：
      laya 的 build_sequence 拼出 [CLS] head [SEP] options [SEP] <state> [SEP]，
      当 state 超过 max_len - head - 1 时，它做的是 **st[:room]** ——
      **保留左边、丢掉右边**。而 compact state 的尾部恰好是
      `message`（玩家这一句）和 `decision_history`（多轮上下文）。
      于是"玩家说了什么"被无声地吃掉，模型只能凭角色卡和环境瞎猜，而
      API 返回里没有任何迹象。

      `qcheck` 能提前预测溢出，但没人会在第 5 轮对话时去跑 qcheck ——
      而溢出恰恰是**从第 3~4 轮开始**的（决策历史攒到 4 条、state 涨了约 90 token）。
      实测 english 检查点（max_len 512 / head 192，room 只有 319）：
        空决策历史 en 284 ✅ / 满决策历史 en 372 ★溢出 / zh 371 ★溢出 / zh 满 459 ★溢出 140
      所以本机默认的 typed-decisions（1024/256，room 767）够用，切 english 就会静默变差。
    """
    cb = checkpoint_budget()
    if not cb:
        return None
    max_len, head, tok = cb
    txt = state_doc if isinstance(state_doc, str) else json.dumps(state_doc, ensure_ascii=False)
    try:
        n = len(tok(txt, add_special_tokens=False)["input_ids"])
    except Exception:
        return None
    room = max_len - head - 1
    out = {"tokens": n, "room": room, "max_len": max_len, "head_max_len": head,
           "overflow": n > room, "spare": room - n}
    if n > room:
        # 按 compact state 的字段顺序判断哪些字段会被砍掉
        lost = [k for k in ("decision_history", "message", "scene", "goals")
                if '"%s"' % k in txt]
        out["at_risk_fields"] = lost[:2] or ["尾部字段"]
        out["note"] = ("★ state 超预算 %d token，laya 会做 st[:room] 静默截断"
                       "（保留左、丢右），最可能丢掉：%s。"
                       % (n - room, "、".join(out["at_risk_fields"])))
    return out


def payload_text(payload):
    """统一读取玩家输入（/decide 与 /narrate 共用，别各写一份）。

    ★ 同时接受 `player_input`（规范键）与 `message`（历史别名）。
      上一版的坑：/decide 读 player_input，/narrate 里喂给 LLM 的也读 player_input，
      但两处是**分别手写**的；只要有人用 `message` 调用，就会出现
      「决策吃到了台词、LLM 拿到空串」——两条链路基于不同输入，是最难查的一类不一致。
      统一在这里取，就不会再分叉。
    """
    return (payload.get("player_input") or payload.get("message") or "").strip()


def decide(payload):
    actor = payload.get("actor") or CFG["actor"]
    history = payload.get("history") or []
    # ★ 键名陷阱（2026-09-23 实测踩到，别再踩）：
    #   /decide 读的是 `player_input`，但直觉和 README 里的 curl 示例都写成 `message`。
    #   旧实现对未知键**静默忽略**：传 {"message": "刀抵在你喉咙上"} 会得到「空玩家输入」，
    #   于是「刀抵喉咙」和「今晚麦酒淡」返回逐位相同的 state 与信号 ——
    #   引擎看起来工作正常，实际玩家台词从未进入 state。这类静默失效比报错危险得多。
    #   现在：`message` 作为别名接受；两者都为空则显式告警，绝不假装决策过。
    player_input = payload_text(payload)
    input_key = ("player_input" if payload.get("player_input")
                 else ("message(别名)" if payload.get("message") else None))
    input_warning = None
    if not player_input:
        input_warning = ("player_input 为空 —— 本轮 state 里 message 字段是空的，"
                         "Laya 是在「玩家什么都没说」的前提下做的决策，结果与具体输入无关。"
                         "若你确实传了台词，检查键名：/decide 认 `player_input`（`message` 亦可）。")
    # ★ 世界状态不再默认注入：NPC Tick 是高频的、World Tick 是低频的，
    #   默认把世界状态塞进每个 NPC 回合会把两者绑死（§9）。客户端要带就显式传。
    world_state = payload.get("world_state")
    questions = payload.get("questions") or CFG["questions"]
    seed = payload.get("seed")
    include_world_questions = bool(payload.get("include_world_questions", False))

    t0 = time.perf_counter()

    # ---- 语言桥：Laya 只吃英文。客户端若已带上 text_en 就复用，否则现翻。----
    player_input_en = payload.get("player_input_en")
    xlate_src = "client" if player_input_en else ("n/a" if LANG != "en" else None)
    xlate_ms = 0.0
    if player_input_en is None and LANG == "en":
        tx0 = time.perf_counter()
        player_input_en, xlate_src = translate_to_en(player_input)
        xlate_ms = (time.perf_counter() - tx0) * 1000

    decision_history = build_decision_history(payload, _DECISION_HISTORY)

    state_doc = build_state_doc(actor, player_input, history, CFG.get("scene"), world_state,
                                player_input_en=player_input_en,
                                decision_history=decision_history)
    # ★ 运行时预算检查：state 超长会被 laya 内部 st[:room] 静默截断（丢尾部字段）。
    #   这里让它变成一条显式告警，而不是"模型忽然变笨了"。
    s_budget = state_budget(state_doc)
    if s_budget and s_budget.get("overflow"):
        sys.stderr.write("[bridge] ⚠ %s\n" % s_budget["note"])

    # ★ NPC Tick / World Tick 分离：默认**不再**把世界问题合进 NPC 决策。
    #   原来合在一起，等于每个 NPC 对话回合都重算一遍战争/商队/黑市 ——
    #   既白烧算力（那三题是低频的），又往 NPC 决策里混进无关变量。
    #   /world 独立跑；确实需要同回合带世界问题就显式传 include_world_questions=true。
    all_questions = dict(questions)
    if include_world_questions:
        all_questions.update(CFG.get("world", {}).get("questions", {}))
    laya_q = build_laya_questions(all_questions)          # 交给 Laya 的（只有 type/instructions/criteria）
    fallback_q = laya_q

    engine_used, meta_raw, routing = "fallback", {}, None
    if ENGINE.ready:
        try:
            res = ENGINE.predict(state_doc, laya_q)
            raw_answers, meta_raw = normalize_laya(res)
            routing = res.get("routing") if isinstance(res, dict) else None
            engine_used = "laya"
        except Exception as e:
            meta_raw = {"laya_error": repr(e)}
            ENGINE.last_error = repr(e)
    if engine_used == "fallback":
        raw_answers, _intent, _pairs = fallback_decide(actor, world_state, player_input, fallback_q, seed)
    latency_ms = (time.perf_counter() - t0) * 1000

    # 注意：增量映射表在原始配置里，不在交给 Laya 的精简版里
    answers = normalize_answers(raw_answers, laya_q)
    deltas, attribution_meta = build_deltas(answers, all_questions, actor)

    def pick(qid):
        a = answers.get(qid, {})
        return a.get("_value")

    # ---- 三段式：choice argmax → noul 门限（遗留，只审计）→ Policy Resolver ----
    #   choice_argmax : Laya choice 的原始 argmax ← ★ 这才是 fallback baseline
    #   gated_id      : 经 noul 门限改写后的值。★ 起**不再作为 baseline**，只留在返回里审计。
    #                   原因（2026-09-23 live 实测）：gate_ally 的阈值 0.45 是在离线夹具上
    #                   标的（非结盟侧观测最大 0.344），但在 live state 下 4/4 个输入
    #                   （含「今晚的麦酒比上个月淡了不少」）都落在 0.48~0.57 → 门限恒命中
    #                   → 把**所有**输入都改写成 ally，包括「刀抵在你喉咙上」。
    #                   恒真的门限不是门限，是常量。结论：夹具上标的阈值不可迁移到 live，
    #                   详见 Laya接入报告.md §12。gate_ally 已按此停用。
    #   final_id      : Policy Resolver 的最终产出 ← 真正控制 NPC 的那个
    choice_argmax = pick("npc_behavior")
    gated_id, gate_hit = apply_gates(answers, choice_argmax)
    signal_rows, signal_values = signal_snapshot(answers)
    policy = policy_resolve(signal_values, choice_argmax)

    final_id = policy.get("behavior") or choice_argmax
    bh = next((b for b in CFG["behaviors"] if b["id"] == final_id), None)
    if bh is None:
        # policy 配错行为名时不要静默挑一个 —— 记下原因再回落
        policy = dict(policy, behavior=choice_argmax, source="choice_baseline",
                      reasons=[{"why": "policy 给出的行为不在 behaviors 里，已回落 choice baseline",
                                "bad": final_id}])
        final_id = choice_argmax
        bh = next((b for b in CFG["behaviors"] if b["id"] == final_id), None)

    baseline_bh = next((b for b in CFG["behaviors"] if b["id"] == choice_argmax), None)

    hidden = answers.get("hidden_event", {}).get("_value")
    threshold = CFG.get("director", {}).get("event_threshold", 0.75)
    director = {
        "threshold": threshold,
        "hidden_event": hidden,
        "adopt": bool(hidden is not None and hidden >= threshold),
        "note": ("隐藏事件概率超过阈值 → 交后台导演排期进入剧情"
                 if hidden is not None and hidden >= threshold
                 else "未达阈值 → 只写入世界状态，不触发剧情"),
    }

    conf = answers.get("npc_behavior", {}).get("confidence")
    prob = answers.get("npc_behavior", {}).get("_probabilities")
    return {
        "engine": engine_used,
        "engine_detail": ENGINE.detail if engine_used == "laya" else (ENGINE.detail or "未安装 laya"),
        "confidence_reliable": engine_used == "laya",
        "latency_ms": round(latency_ms, 2),
        "lang": LANG,
        # ★ 输入自检：让我们一眼看出「这轮到底吃到了什么输入」
        "input_key": input_key,
        "input_warning": input_warning,
        "tick": "npc",
        "device": ENGINE.device_label(),
        "player_input_en": player_input_en,
        "translate": {"source": xlate_src, "ms": round(xlate_ms, 1)},
        "latency_breakdown": {"translate_ms": round(xlate_ms, 1),
                              "decide_ms": round(max(0.0, latency_ms - xlate_ms), 2)},
        "routing": routing,
        "answers": answers,
        "raw": meta_raw,
        "state_doc": state_doc,
        "state_budget": s_budget,
        "state_line": state_line(actor),
        "decision_history": decision_history,
        "attribution": attribution_meta,
        # ★ 本轮主输出：Laya 判断了什么
        "decision_signals": signal_rows,
        "signal_values": dict((k, round(v, 4)) for k, v in signal_values.items()),
        # ★ Narraverse 侧为什么做这个决定
        "policy": policy,
        # ★ 状态增量只是「建议」，不是最终写入值
        "proposed_deltas": deltas,
        "deltas": deltas,                        # 兼容旧前端，逐步淘汰
        "state_proposal_meta": {
            "is_proposal": True,
            "note": ("proposed_deltas 是**决策建议**，不是 Actor State 的最终写入值。"
                     "正式链路应为 Laya Proposal → 后端 Validate → State Transition → Commit；"
                     "浏览器端 applyDeltas() 只是本 Demo 的演示手段，**不是状态权威**。"),
        },
        "director": director,
        "decision": {
            # 最终行为由 Policy Resolver 决定；choice 只是 baseline
            "behavior": None if not bh else {
                "id": bh["id"], "name": bh["name"], "desc": bh["desc"], "instr": bh.get("instr", ""),
                "confidence": conf,
                "probabilities": prob,
                "source": policy.get("source"),
                "policy_reasons": policy.get("reasons"),
                "confidence_level": policy.get("confidence_level"),
                "fallback": policy.get("fallback"),
                "gated_by": gate_hit,
                # ★ 名字要诚实：gate 改写后的值不是 choice baseline。
                #   旧版这里叫 choice_baseline 但装的是 gated_id，前端据此显示
                #   「choice 首选 · 被改写」，实际改写结果与真实 argmax 并不一致（实测踩到）。
                "choice_argmax": choice_argmax,
                "gated_baseline": gated_id,
                "choice_baseline_name": (baseline_bh or {}).get("name"),
                "conflict": bool(policy.get("source") == "policy"
                                 and policy.get("behavior") != choice_argmax),
            },
            "choice_baseline": None if not baseline_bh else {
                "id": baseline_bh["id"], "name": baseline_bh["name"],
                "argmax": choice_argmax,
                "confidence": conf,
                "probabilities": prob,
            },
            "player_intent": {
                "id": pick("player_intent"),
                "confidence": answers.get("player_intent", {}).get("confidence"),
                "probabilities": answers.get("player_intent", {}).get("_probabilities"),
            },
            "betrayal_intent": answers.get("betrayal_intent", {}).get("_value"),
            "hidden_event": hidden,
        },
        "question_count": len(all_questions),
    }


def world_decide(payload):
    state = payload.get("world_state") or CFG["world"]["state"]
    qs = CFG["world"]["questions"]
    laya_q = build_laya_questions(qs)
    names = CFG["world"].get("names", {})
    t0 = time.perf_counter()
    engine_used = "fallback"
    raw_answers, meta_raw, routing = {}, {}, None
    if ENGINE.ready:
        try:
            res = ENGINE.predict({"world_state": state, "role": "WORLD"}, laya_q)
            raw_answers, meta_raw = normalize_laya(res)
            routing = res.get("routing") if isinstance(res, dict) else None
            engine_used = "laya"
        except Exception as e:
            meta_raw = {"laya_error": repr(e)}
    if engine_used == "fallback":
        raw_answers, _i, _p = fallback_decide(CFG["actor"], state, "", laya_q)
    latency_ms = (time.perf_counter() - t0) * 1000
    answers = normalize_answers(raw_answers, laya_q)
    thr = CFG.get("director", {}).get("event_threshold", 0.75)
    events = []
    for qid in qs:
        v = answers.get(qid, {}).get("_value")
        events.append({"id": qid, "name": names.get(qid, qid), "p": v,
                       "adopt": bool(v is not None and v >= thr)})
    events.sort(key=lambda e: -(e["p"] or 0))
    # World Tick 是低频的：世界事件概率 / 地区变化 / 势力状态 / 环境状态。
    # 不要把它跟 NPC Tick 合在一起跑（§9），/decide 已不再自动带世界问题。
    return {"engine": engine_used, "tick": "world", "device": ENGINE.device_label(),
            "latency_ms": round(latency_ms, 2), "threshold": thr,
            "world_state": state,
            "events": events, "routing": routing, "raw": meta_raw, "answers": answers}


# ==========================================================================
# 8. HTTP 层
# ==========================================================================
class Handler(BaseHTTPRequestHandler):
    server_version = "LayaBridge/0.1"
    protocol_version = "HTTP/1.1"   # 开 keep-alive：一轮对话有 2~3 次请求

    def log_message(self, fmt, *args):
        sys.stderr.write("[bridge] %s - %s\n" % (self.address_string(), fmt % args))

    # ---- helpers ----
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _read(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    # ---- routes ----
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/health", "/"):
            return self._json({
                "ok": True,
                "engine": "laya" if ENGINE.ready else "fallback",
                "laya": ENGINE.describe(),
                "config_path": str(CFG_PATH),
                "questions": list(CFG["questions"].keys()),
                "world_questions": list(CFG["world"]["questions"].keys()),
                "signals": (CFG.get("signals") or {}).get("order", []),
                "policy_enabled": bool((CFG.get("policy") or {}).get("enabled", False)),
                "behaviors": [b["id"] for b in CFG["behaviors"]],
                "device": ENGINE.device_label(),
                "personality_style": personality_style(),
                # 检查点预算：state 超了会被 laya 静默 st[:room] 截断（见 state_budget）
                "state_budget": (lambda cb: None if not cb else {
                    "max_len": cb[0], "head_max_len": cb[1],
                    "room": cb[0] - cb[1] - 1})(checkpoint_budget()),
                "ticks": {
                    "npc": "高频：player intent / relationship shift / emotion shift / decision signals（/decide）",
                    "world": "低频：世界事件概率 / 地区 / 势力 / 环境（独立 /world，不再混进 /decide）",
                },
                "llm": {
                    "ready": bool(os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("LLM_API_KEY")),
                    "model": os.environ.get("LLM_MODEL", "deepseek-flash"),
                    "effort": os.environ.get("LLM_EFFORT", "low"),
                    "max_tokens": os.environ.get("LLM_MAX_TOKENS", "1600"),
                    "base_url": os.environ.get("LLM_BASE_URL", "https://api.deepseek.com"),
                    "env_file": str(ENV_PATH) if ENV_PATH.exists() else None,
                    "env_loaded": ENV_LOADED,
                    "env_overridden": ENV_OVERRIDDEN,
                },
                "port": PORT,
            })
        if path == "/config":
            return self._json(CFG)
        if path in ("/demo", "/demo.html", "/index.html"):
            # 直接从桥上提供页面：省掉一个静态服务器，也避免 file:// 打开时
            # 跨源 fetch 到 http://127.0.0.1 的各种不确定行为（本地文件源是 opaque origin）。
            if not DEMO_HTML.exists():
                return self._json({"error": "缺少 %s" % DEMO_HTML.name}, 404)
            body = DEMO_HTML.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self._cors()
            self.end_headers()
            return self.wfile.write(body)
        if path == "/history":
            return self._json({"turns": [d for d in _HISTORY],
                               "decision_history": [d for d in _DECISION_HISTORY]})
        return self._json({"error": "not found",
                           "try": ["/health", "/config", "/demo", "/decide", "/narrate", "/world",
                                   "/reset", "/predict"]}, 404)

    def do_POST(self):
        path = self.path.split("?")[0]
        payload = self._read()

        if path == "/decide":
            try:
                out = decide(payload)
            except Exception as e:
                return self._json({"error": repr(e)}, 500)
            dec = out.get("decision") or {}
            beh = dec.get("behavior") or {}
            intent_id = (dec.get("player_intent") or {}).get("id")
            # ★ 历史日志也用统一取值，否则用 message 调用的轮次会被记成 player=None。
            #   注意 _DECISION_HISTORY 是**进程级滚动窗口**（上一条见下），
            #   它让「连续两次独立 /decide」并非彼此独立 —— 单角色 Demo 够用，
            #   多角色/并发场景必须改成按 actor 分桶。
            _HISTORY.append({"t": time.time(), "player": payload_text(payload),
                             "engine": out["engine"], "behavior": beh.get("id"),
                             "source": beh.get("source")})
            del _HISTORY[:-50]
            # ★ 把本轮压成结构化决策历史，供下一轮的 Laya state 用（§8）。
            #   客户端自己带了 decision_history 就不再累积 —— 免得两套历史互相打架。
            if not payload.get("decision_history"):
                _DECISION_HISTORY.extend(decision_history_entries(intent_id, beh.get("id")))
                del _DECISION_HISTORY[:-12]
            return self._json(out)

        if path == "/reset":
            # 清掉累积历史：换场景 / 开新局时调用。
            del _HISTORY[:]
            del _DECISION_HISTORY[:]
            return self._json({"ok": True, "cleared": ["history", "decision_history"]})

        if path == "/world":
            try:
                return self._json(world_decide(payload))
            except Exception as e:
                return self._json({"error": repr(e)}, 500)

        if path == "/narrate":
            actor = payload.get("actor") or CFG["actor"]
            bid = (payload.get("behavior") or {}).get("id")
            pre = None
            if not bid:
                # ★ 没带 behavior 就自己先跑一次 decide。
                #   原来这里直接 400（unknown behavior: None）—— 客户端必须先 /decide 再 /narrate，
                #   两步都得传 state_line / actor 保持一致，很容易漏。既然"实时输入"是主要用法，
                #   就让一次请求把决策和台词都办完；带了 behavior 仍然走原路径（不重复算）。
                try:
                    pre = decide(payload)
                except Exception as e:
                    return self._json({"error": "decide failed: %r" % e}, 500)
                bh_pre = (pre.get("decision") or {}).get("behavior") or {}
                bid = bh_pre.get("id")
                if not bid:
                    return self._json({"error": "decide 未给出行为", "decide": pre}, 500)
            bh = next((b for b in CFG["behaviors"] if b["id"] == bid), None)
            if bh is None:
                return self._json({"error": "unknown behavior: %s" % bid,
                                   "known": [b["id"] for b in CFG["behaviors"]]}, 400)
            if payload.get("use_llm", True):
                r = llm_narrate(actor, bh, payload_text(payload),
                                payload.get("history") or (pre or {}).get("history"),
                                payload.get("state_line")
                                or (pre or {}).get("state_line") or state_line(actor),
                                bool(payload.get("include_reasoning")))
                if r and not r.get("error"):
                    return self._json(dict(r, **({"decision": pre} if pre else {})))
                if r and r.get("error"):
                    fb = pool_line(bh, payload_text(payload))
                    fb["llm_error"] = r["error"]
                    fb["llm_meta"] = {k: r.get(k) for k in ("model", "effort", "latency_ms",
                                                            "reasoning_tokens", "completion_tokens",
                                                            "retried")}
                    # 把污染原文留在响应里：这是排查「台词为什么退化成池子」的唯一线索
                    if r.get("raw_content_first"):
                        fb["llm_meta"]["raw_content_first"] = r["raw_content_first"][:800]
                    return self._json(dict(fb, **({"decision": pre} if pre else {})))
            fb = pool_line(bh, payload_text(payload))
            if pre:
                fb["decision"] = pre
            return self._json(fb)

        if path == "/predict":
            # 原始透传：直接用任意 state / questions 调 Laya，验证 API 形状用
            if not ENGINE.ready:
                return self._json({"error": "laya 未就绪", "detail": ENGINE.describe()}, 503)
            try:
                res = ENGINE.predict(payload.get("state"), payload.get("questions"))
                return self._json({"engine": ENGINE.kind, "result": res})
            except Exception as e:
                return self._json({"error": repr(e)}, 500)

        return self._json({"error": "not found"}, 404)


_HISTORY = []


# ==========================================================================
# 9. CLI
# ==========================================================================
def cmd_probe():
    print("正在探测本机 Laya ...")
    ENGINE.init()
    print(json.dumps(ENGINE.describe(), ensure_ascii=False, indent=2, default=str))
    if not ENGINE.ready:
        print("\n[laya 不可用] 桥会以回退引擎运行（关键词 + 角色状态权重）。")
        print("安装：.venv\\Scripts\\python -m pip install laya")
        return 1
    print("\n走完整 decide() 链路（含中文→英文翻译）...")
    out = decide({"player_input": "我是个行商，从北边来。带了点不太方便在城里说的事。"})
    print("引擎 = %s | 题数 = %s | 总 %s ms（翻译 %s ms + 决策 %s ms）" % (
        out["engine"], out["question_count"], out["latency_ms"],
        out["latency_breakdown"]["translate_ms"], out["latency_breakdown"]["decide_ms"]))
    print("路由 = %s" % json.dumps(out["routing"], ensure_ascii=False, default=str))
    print("\n送进 Laya 的英文 state 文档：")
    print(json.dumps(out["state_doc"], ensure_ascii=False, indent=2, default=str)[:1800])
    print("\n选中的行为：%s (p=%s)" % (
        (out["decision"]["behavior"] or {}).get("name"),
        (out["decision"]["behavior"] or {}).get("confidence")))
    print("行为分布：", json.dumps((out["decision"]["behavior"] or {}).get("probabilities"),
                                ensure_ascii=False, default=str))
    print("状态增量：", "  ".join("%s %+.2f" % (d["label"], d["delta"]) for d in out["deltas"]))
    print("\n引擎原始返回：")
    print(json.dumps(out["raw"], ensure_ascii=False, indent=2, default=str)[:3000])
    return 0


SAMPLE_INPUT_EN = "To be honest, I am not a merchant at all. I am looking for a person."
SAMPLE_INPUT_ZH = "实话告诉你，我不是商人。我在找一个人。"

# ★ 区分度实测用的输入集：**必须语义反差足够大**。
#   早期用的是三句都很温和的对话（"货的事明天再谈" / "实话告诉你" / "你要是不说，我就不客气了"），
#   结果三个输入都选中同一个行为。但那只说明输入不够狠，不能说明模型没有区分能力 ——
#   这是很典型的误判：拿弱输入测出「没区分度」，然后去找模型的问题，其实是测试本身没力。
#   现在用四句极端反差输入，覆盖「敌意 / 善意 / 中性 / 侮辱」四个方向。
LANGTEST_CASES = [
    ("持刀威胁", "The player suddenly draws a knife and says he will kill her if she does not talk."),
    ("同袍相助", "The player hands over a sealed letter proving he is a fellow Templar sent to help her hunt Grey Crow."),
    ("陌生问路", "A stranger asks her which road leads to the next town."),
    ("羞辱骑士团", "The player spits on the floor and insults her order as a pack of liars and thieves."),
]


def _langtest_run(model, doc, q):
    t0 = time.perf_counter()
    if ENGINE.kind == "router":
        res = ENGINE.obj.predict(doc, q, model=model)
    else:
        res = ENGINE.obj.predict(doc, q)
    dt = (time.perf_counter() - t0) * 1000
    raw, _ = normalize_laya(res)
    return dt, normalize_answers(raw, q)


def cmd_langtest():
    """对照实测：用哪个检查点、决策文档用英文还是中文。

    判据不是「跑通了」，而是 **区分度** —— 三个语义明显不同的输入必须给出
    不同的行为分布与不同的有序评分。一个对所有输入都给同一答案的模型，
    无论多快、置信度多高，都不具备决策能力。参数对不对，只有数字能说话。

    用法：
        python laya_bridge.py langtest                 # 测本地已下 + 当前用的检查点
        python laya_bridge.py langtest english         # 指定测哪些（可多个）
        LAYA_LANGTEST_MODELS=english,typed-decisions python laya_bridge.py langtest
        LAYA_LANGTEST_DOC=zh python laya_bridge.py langtest   # 顺便测中文文档（预期变差）
    """
    ENGINE.init()
    if not ENGINE.ready:
        print("laya 未就绪，无法实测。先跑 probe 看原因。")
        return 1

    argv_names = [a for a in sys.argv[2:] if not a.startswith("-")]
    env_names = [n for n in (os.environ.get("LAYA_LANGTEST_MODELS") or "").split(",") if n.strip()]
    # ★ 默认只测**当前配置用的那一个**检查点。
    #   原来默认跑全部本地检查点，结果在这台机器上直接 Segmentation fault（exit 139）：
    #   两个 ModernBERT-large 检查点各 ~840MB 权重，同时驻留要 2.5GB+，
    #   而本机 15.7GB 里当时只剩 3.3GB 可用 → 加载第二个时进程被内存干掉，连报错都来不及打。
    #   想看另一个检查点就显式点名：python laya_bridge.py langtest english
    names = argv_names or [n.strip() for n in env_names] or [DEFAULT_MODEL_NAME]

    # 只测本地已下好的，避免为了对照又去联网下 800MB
    runnable, skipped = [], []
    for n in names:
        (runnable if n in ENGINE.local_models else skipped).append(n)
    if skipped:
        print("跳过（本地未下载，避免联网下载）：%s" % ", ".join(skipped))
        print("  如需实测请先跑：python _fetch_laya.py  并在其中改 SUBFOLDER")
    if not runnable:
        print("没有可实测的本地检查点。")
        return 1

    # 同时测多个检查点时必须一起 preload：
    # Router 的 max_loaded 默认 1，交替切换会让模型每轮换入换出，
    # 冷加载一次在 CPU 上要 ~37s，不预载就全花在反复加载上了。
    # 但预载 N 个 = 同时驻留 N×~840MB 权重。本机 15.7GB 内存实测：
    # 2 个就 Segmentation fault（无 traceback）。所以这里先报内存，超了直接劝退。
    if ENGINE.kind == "router" and len(runnable) > 1:
        need_mb = len(runnable) * 900 + 1200
        free_mb = _free_phys_mb()
        print("⚠ 本次要对 %d 个检查点做对照，需同时驻留约 %d MB 权重。" % (len(runnable), need_mb))
        if free_mb is not None:
            print("  当前可用物理内存 %d MB。" % free_mb)
            if free_mb < need_mb:
                print("  ★ 内存不足 → 这会 Segmentation fault（不是代码 bug，是 OOM 且无 traceback）。")
                print("    请一次只测一个：python laya_bridge.py langtest typed-decisions")
                return 1
        try:
            ENGINE.obj.preload(runnable)
            print("已同时预载：%s（max_loaded 已提升，避免交替换入换出）\n" % ", ".join(runnable))
        except Exception as e:
            print("预载 %s 失败（继续，但会变慢）：%r\n" % (runnable, e))
    elif len(runnable) == 1:
        print("（一次只测一个检查点，避免 OOM；换另一个就把它写在命令后面）\n")

    doc_langs = ["en"] + (["zh"] if os.environ.get("LAYA_LANGTEST_DOC") == "zh" else [])
    global LANG
    orig_lang = LANG

    for lang in doc_langs:
        LANG = lang
        docs, qs = {}, None
        for tag, text in LANGTEST_CASES:
            if lang == "en":
                docs[tag] = build_state_doc(CFG["actor"], text, [], CFG.get("scene"),
                                           CFG["world"]["state"], player_input_en=text)
            else:
                docs[tag] = build_state_doc(CFG["actor"], text, [], CFG.get("scene"),
                                            CFG["world"]["state"])
        qs = build_laya_questions(CFG["questions"])
        LANG = orig_lang

        print("=" * 78)
        print("决策文档语言：%s%s" % (lang, "（预期会变差：Laya 的决策检查点以英文训练）"
                                    if lang == "zh" else ""))
        print("=" * 78)
        for model in runnable:
            print("\n── 检查点 %s " % model + "─" * max(0, 60 - len(model)))
            rows, fails = [], 0
            for tag, _ in LANGTEST_CASES:
                try:
                    dt, std = _langtest_run(model, docs[tag], qs)
                    beh = std.get("npc_behavior", {})
                    probs = beh.get("_probabilities") or {}
                    top = sorted(probs.items(), key=lambda kv: -kv[1])[:3]
                    rows.append((tag, dt, beh.get("_value"), beh.get("confidence"), top, std))
                except Exception as e:
                    fails += 1
                    print("   [%s] 失败：%r" % (tag, e))
            if not rows:
                continue
            for tag, dt, choice, conf, top, std in rows:
                final, gate = apply_gates(std, choice)
                print("   %-4s %6.0fms  行为=%-10s conf=%-7s 分布 %s"
                      % (tag, dt, final, conf,
                         "  ".join("%s=%.3f" % kv for kv in top) or "(无)"))
                if gate:
                    print("        └ choice 说是 %s（P=%.3f），被门限 %s 改写（P=%.3f ≥ %.2f）"
                          % (gate.get("choice_said"), (std.get("npc_behavior", {})
                             .get("_probabilities") or {}).get(gate.get("choice_said"), 0),
                             gate["gate"], gate["p"], gate["threshold"]))
                gp = "  ".join("%s=%.3f" % (g, (std.get(g, {}) or {}).get("_value", -1))
                               for g in sorted(CFG.get("gates") or {}) if not g.startswith("_"))
                print("        └ 门限 %s" % (gp or "(无)"))
                print("        意图=%-9s  背叛=%-6s 隐藏事件=%-6s"
                      % (std.get("player_intent", {}).get("_value"),
                         std.get("betrayal_intent", {}).get("_value"),
                         std.get("hidden_event", {}).get("_value")))

            # ---- 区分度小结：这才是判据 ----
            # 行为题看**最终行为**（含门限覆盖），因为那才是实际问题里会被执行的那个。
            picked = [apply_gates(r[5], r[2])[0] for r in rows if r[2]]
            uniq = len(set(picked))
            if uniq <= 1:
                verdict = ("★ %d 个输入给了同一个行为 = 无区分能力，这个检查点/语言不可用"
                           % len(picked))
            elif uniq == len(picked):
                verdict = "完全区分（%d 个输入 → %d 个不同行为）" % (len(picked), uniq)
            else:
                verdict = "有区分（%d 个输入 → %d 种行为）" % (len(picked), uniq)
            print("   ▸ 区分度：")
            print("       选中行为 %s → %s" % (picked, verdict))
            score_ranges = []
            for qid, qcfg in CFG["questions"].items():
                if qcfg.get("type") != "score":
                    continue
                vals = [r[5].get(qid, {}).get("_value") for r in rows]
                vals = [v for v in vals if isinstance(v, (int, float))]
                if len(vals) >= 2:
                    lo, hi = min(vals), max(vals)
                    label = (CFG.get("state_shift", {}).get("paths", {})
                             .get(qid, {}) or {}).get("label", qid)
                    # 跨度和选项数一半比一下，太小吃不动阈值
                    n_opt = len(qcfg.get("criteria") or [])
                    score_ranges.append((label or qid, lo, hi, hi - lo, n_opt))
            score_ranges.sort(key=lambda t: -t[3])
            for label, lo, hi, span, n_opt in score_ranges:
                flag = "有区分" if span >= max(0.5, 0.15 * max(1, n_opt)) else "★ 几乎不动"
                print("       %-6s 期望值 %.2f ~ %.2f（跨度 %.2f / %d 档）%s"
                      % (label, lo, hi, span, n_opt, flag))

            # ★ 只看跨度是不够的：跨度大但方向反了（威胁→信任最高）比跨度小更糟。
            #   所以把每个评分题的**逐输入期望值**列出来，让方向可以人工核对。
            print("       ── 逐输入期望值（核对方向用，0=最低档 4=最高档）──")
            hdr = "".join("%-9s" % tag for tag, _, _, _, _, _ in rows)
            print("       %-10s%s" % ("", hdr))
            for qid, qcfg in CFG["questions"].items():
                if qcfg.get("type") != "score":
                    continue
                label = (CFG.get("state_shift", {}).get("paths", {}).get(qid, {}) or {}).get("label", qid)
                cells = ""
                for r in rows:
                    v = r[5].get(qid, {}).get("_value")
                    cells += "%-9s" % ("—" if not isinstance(v, (int, float)) else "%.2f" % v)
                print("       %-10s%s" % (label or qid, cells))

            # ★ 门限是否在用：一个永远不命中的门限等于死代码，必须让它显形。
            gmax = {}
            for gid in (CFG.get("gates") or {}):
                if gid.startswith("_"):
                    continue
                vs = [(r[5].get(gid, {}) or {}).get("_value") for r in rows]
                vs = [v for v in vs if isinstance(v, (int, float))]
                if vs:
                    gmax[gid] = max(vs)
            if gmax:
                thr = {g: (CFG["gates"][g] or {}).get("threshold") for g in gmax}
                dead = [g for g in gmax if thr.get(g) is not None and gmax[g] < thr[g]]
                print("       ── 行为门限 ──")
                for g in sorted(gmax, key=lambda x: -gmax[x]):
                    st_ = ("★ 未命中（观察到的最大 P=%.3f < 阈值 %s）" % (gmax[g], thr.get(g))
                           if g in dead else "在生效")
                    print("       %-14s 观察最大 P=%.3f  阈值 %-5s %s"
                          % (g, gmax[g], thr.get(g), st_))
                if dead:
                    print("       ★ %d 个门限当前是死的（不会改变任何结果）。"
                          "要么按真实对局的分布重标阈值，要么删掉它 —— 留着假装在工作更糟。"
                          % len(dead))
    print()
    return 0


# ==========================================================================
# 10b. 决策信号实验：回归矩阵 / 人格对照 / 性能基准
# ==========================================================================
TESTS_DIR = HERE / "tests"
# 注意别叫 _XLATE_CACHE —— 那个名字已经被 translate_to_en 的**内存**翻译记忆占用了，
# 重名会把 dict 换成 Path，直到调用翻译时才崩（TypeError: WindowsPath is not iterable）。
_XLATE_DISK = HERE / "_diag" / "translation_cache.json"


def _load_fixture(name):
    p = TESTS_DIR / name
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        print("读取 %s 失败：%r" % (p, e))
        return None


def _cached_translate(text, cache):
    """带磁盘缓存的翻译。48 条输入每条都要翻，不能每次重跑都重新调一遍 LLM。"""
    if text in cache:
        return cache[text]
    en, _src = translate_to_en(text)
    if en and en != text:
        cache[text] = en
        try:
            _XLATE_DISK.parent.mkdir(parents=True, exist_ok=True)
            _XLATE_DISK.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
        except Exception:
            pass
    return en


def _check_direction(rows_by_name, expected):
    """按 tests/regression_cases.json 写明的判据核对方向，返回 (通过数, 失败列表)。"""
    meta = _signal_meta()
    ok, bad = 0, []
    for name, want in (expected or {}).items():
        row = rows_by_name.get(name)
        if row is None:
            bad.append({"signal": name, "want": want, "got": None, "why": "信号缺失"})
            continue
        v = row["value"]
        # 优先用行自带的 kind —— score 位移题（trust_shift 等）在 signals.meta 里查不到，
        # 若退回默认的 "prob" 会拿 0~4 的期望值去和 0.5 比大小，判据整个错掉。
        kind = row.get("kind") or (meta.get(name) or {}).get("kind", "prob")
        if kind == "prob":
            good = {"high": v >= 0.50, "low": v <= 0.50,
                    "neutral": 0.30 <= v <= 0.70}.get(want, False)
        else:
            good = {"positive": v > 2.20, "negative": v < 1.80, "neutral": 1.80 <= v <= 2.20,
                    "high": v > 3.00, "low": v < 1.00}.get(want, False)
        if good:
            ok += 1
        else:
            bad.append({"signal": name, "want": want, "got": round(v, 4), "kind": kind})
    return ok, bad


# 方向断言也要能看见已有的 score 位移题（trust_shift / doubt_shift …）。
# 它们**不**放进 signals.meta —— UI 的信号面板不该把这些全铺开，会淹掉重点；
# 但它们同样是可断言的决策量，所以单独在这里声明。
SHIFT_IDS = ("trust_shift", "respect_shift", "doubt_shift",
             "fondness_shift", "alert_shift", "goal_shift")


def _run_signals(model, doc, qs):
    """跑一次并返回 (耗时ms, 信号行列表, {name: row})。

    第三项刻意是「信号 + score 位移题」的合并视图，供方向断言用。
    """
    t0 = time.perf_counter()
    if ENGINE.kind == "router":
        res = ENGINE.obj.predict(doc, qs, model=model)
    else:
        res = ENGINE.obj.predict(doc, qs)
    dt = (time.perf_counter() - t0) * 1000
    raw, _ = normalize_laya(res)
    answers = normalize_answers(raw, qs)
    rows, _vals = signal_snapshot(answers)
    by_name = dict((r["signal"], r) for r in rows)
    for qid in SHIFT_IDS:
        v = (answers.get(qid) or {}).get("_value")
        if v is None:
            continue
        by_name[qid] = {"signal": qid, "label": qid, "kind": "level",
                        "value": round(float(v), 4), "range": [0, 4]}
    return dt, rows, by_name


def cmd_signaltest():
    """决策信号回归：48 条 × 方向断言，并导出各信号实测分布（阈值就靠它定）。

    ★ 断言的是**决策方向**，不是「NPC 必须选某个唯一行为」。
      要求一句话只有一种正确反应是没有依据的；能站得住的要求是
      「敌意高的输入，敌意信号就该高」。

    用法：
        python laya_bridge.py signaltest            # 全量 48 条（默认检查点）
        python laya_bridge.py signaltest 6          # 只跑前 6 条，先看形状
        LAYA_MODEL=english python laya_bridge.py signaltest   # 换检查点对照

    ★ 两个诊断用过滤器（受控对照，用来区分「模型不行」和「我们把题塞太多」）：
        LAYA_QSET=signals   只跑 9 个信号题 + 6 个位移题，丢掉 npc_behavior /
                            player_intent / gates / world 等——用来测「题目数量」
                            本身对信号区分度的影响。
        LAYA_CASES=a,b,c    只跑指定 id 的用例，便于同批输入做 A/B。

        例：同一批 4 条极端输入，先跑全套，再只跑信号题，比 span 有没有变大。
        LAYA_CASES=smalltalk_1,severe_insult_2 LAYA_QSET=signals \
            python laya_bridge.py signaltest

    ★ 换检查点必须**新开进程**：检查点在 init 时按 device/model 加载，
      同进程切不了；两个 800MB 级检查点同时驻留会 OOM。
      两次结果按检查点名合并进 tests/thresholds.json，再用 ckptcompare 出对照表。
    """
    fixture = _load_fixture("regression_cases.json")
    if not fixture:
        return 1
    cases = list(fixture["cases"])
    want_ids = [x.strip() for x in (os.environ.get("LAYA_CASES") or "").split(",") if x.strip()]
    if want_ids:
        by_id = dict((c["id"], c) for c in cases)
        missing = [i for i in want_ids if i not in by_id]
        if missing:
            print("LAYA_CASES 里有找不到的 id：%s" % ", ".join(missing))
            return 1
        cases = [by_id[i] for i in want_ids]
    lim = next((int(a) for a in sys.argv[2:] if a.isdigit()), None)
    if lim:
        cases = cases[:lim]

    ENGINE.init()
    if not ENGINE.ready:
        print("laya 未就绪，先跑 probe 看原因。")
        return 1
    model = DEFAULT_MODEL_NAME
    if model not in ENGINE.local_models:
        print("本机没有 %r 检查点。" % model)
        return 1

    qs = build_laya_questions(CFG["questions"])
    # ★ LAYA_QSET=signals：只留信号题 + 位移题（受控对照，见 docstring）
    qset = (os.environ.get("LAYA_QSET") or "").strip().lower()
    if qset == "signals":
        keep = set(SHIFT_IDS) | set((CFG.get("signals") or {}).get("meta") or {})
        qs = dict((k, v) for k, v in qs.items() if k in keep or k.startswith("signal_"))
    elif qset:
        print("LAYA_QSET 只认识 'signals'，收到 %r —— 按全套跑。" % qset)
    cache = {}
    try:
        cache = json.loads(_XLATE_DISK.read_text(encoding="utf-8"))
    except Exception:
        pass

    print("=" * 78)
    print("决策信号回归 ｜ 检查点=%s ｜ 设备=%s" % (model, ENGINE.device_label()))
    print("题目数=%d（LAYA_QSET=%s）｜ 样本数=%d ｜ 断言的是方向，不是唯一行为"
          % (len(qs), qset or "full", len(cases)))
    print("=" * 78)

    per_cat, per_signal, obs, failures, total_ok, total_bad = {}, {}, {}, [], 0, 0
    obs_by_case = {}          # ★ 逐用例原始值：阈值的唯一合法来源
    global LANG
    t_start = time.perf_counter()

    for i, c in enumerate(cases, 1):
        text_en = _cached_translate(c["text"], cache) if LANG == "en" else c["text"]
        doc = build_state_doc(CFG["actor"], c["text"], [], CFG.get("scene"), None,
                              player_input_en=text_en,
                              decision_history=[{"type": "start", "summary": "scene begins"}])
        try:
            dt, rows, by_name = _run_signals(model, doc, qs)
        except Exception as e:
            print("  [%s] 失败：%r" % (c["id"], e))
            continue

        ok, bad = _check_direction(by_name, c.get("expected_direction"))
        obs_by_case[c["id"]] = dict((k, v["value"]) for k, v in by_name.items())
        total_ok += ok
        total_bad += len(bad)
        cat = c["category"]
        a, b = per_cat.get(cat, (0, 0))
        per_cat[cat] = (a + ok, b + len(bad))
        for r in rows:
            per_signal.setdefault(r["signal"], [0, 0])
            per_signal[r["signal"]][0] += 1
            per_signal[r["signal"]][1] += r["value"]
            obs.setdefault(r["signal"], []).append(r["value"])
        if bad:
            for x in bad:
                failures.append(dict(x, id=c["id"], category=cat))
        mark = "✅" if not bad else "❌"
        print("  %-3d %s %-12s %-10s %.0fms  %s" % (
            i, mark, cat, c["id"], dt,
            " ".join("%s=%.2f" % (r["signal"][:4], r["value"]) for r in rows[:5])))

    dur = time.perf_counter() - t_start
    print("\n" + "=" * 78)
    print("方向断言：%d 通过 / %d 失败 ｜ 准确率 %.1f%% ｜ 总耗时 %.1f min"
          % (total_ok, total_bad, 100.0 * total_ok / max(1, total_ok + total_bad), dur / 60))
    print("=" * 78)

    print("\n── 逐信号实测分布（阈值只能从这组数里定）" + "─" * 30)
    print("  %-12s %5s %7s %7s %7s %7s" % ("signal", "n", "min", "mean", "max", "span"))
    dist = {}
    for name in (CFG.get("signals", {}).get("order") or []):
        vals = obs.get(name) or []
        if not vals:
            print("  %-12s %5d   —— 无数据" % (name, 0))
            continue
        lo, hi, mean = min(vals), max(vals), sum(vals) / len(vals)
        dist[name] = {"n": len(vals), "min": round(lo, 4), "mean": round(mean, 4),
                      "max": round(hi, 4), "span": round(hi - lo, 4),
                      "kind": _signal_kind(name)}
        print("  %-12s %5d %7.3f %7.3f %7.3f %7.3f" % (name, len(vals), lo, mean, hi, hi - lo))

    print("\n── 逐类别方向准确率" + "─" * 42)
    for cat, (a, b) in sorted(per_cat.items(), key=lambda kv: (kv[1][0] / max(1, sum(kv[1])))):
        tot = a + b
        print("  %-14s %2d/%2d  %5.0f%%" % (cat, a, tot, 100.0 * a / max(1, tot)))

    if failures:
        print("\n── 失败明细（前 25 条）" + "─" * 40)
        for f in failures[:25]:
            print("  %-16s %-12s want=%-8s got=%s%s"
                  % (f["id"], f["signal"], f["want"],
                     f["got"], " (%s)" % f["why"] if f.get("why") else ""))

    # ★ 实验数值落进 tests/，不留在代码注释里（§2.2）
    out = {"_readme": ["由 python laya_bridge.py signaltest 生成。不要手改。",
                       "这是「已实测」的分布，policy 的阈值只能从这里推导。",
                       "重新生成请重跑 signaltest。"],
           "model": model, "device": ENGINE.device_label(),
           "n_cases": len(cases), "direction_accuracy": round(total_ok / max(1, total_ok + total_bad), 4),
           "signal_distribution": dist,
           "observations": obs_by_case,
           "category_accuracy": dict((k, {"ok": v[0], "total": v[0] + v[1]}) for k, v in per_cat.items()),
           "failures": failures}
    # ★ 按检查点合并保存：typed-decisions 与 english 必须能「同条件对照」（§11），
    #   后跑的把先跑的覆盖掉就没法比了。顶层字段保留最近一次，方便旧读法继续能用。
    try:
        path = TESTS_DIR / "thresholds.json"
        try:
            blob = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            blob = {}
        blob["_readme"] = out["_readme"] + [
            "runs 按检查点分别保存，typed-decisions / english 互不覆盖，供 ckptcompare 对照。"]
        # ★ 非默认 qset / 子集用例不能顶掉全量结果，键名带上限定符。
        #   注意默认 qset 是空串（不是 "full"），判断要连空串一起当「全量」。
        is_full = (not qset or qset == "full") and not want_ids
        run_key = model if is_full else (
            "%s|qset=%s|cases=%s" % (model, qset or "full", len(cases)))
        blob.setdefault("runs", {})[run_key] = out
        blob["model"] = model                       # 最近一次跑的
        for k in ("device", "n_cases", "direction_accuracy", "signal_distribution",
                  "observations", "category_accuracy", "failures"):
            blob[k] = out[k]
        path.write_text(json.dumps(blob, ensure_ascii=False, indent=2), encoding="utf-8")
        print("\n实测分布已合并写入 tests/thresholds.json（检查点键：%s）" % model)
    except Exception as e:
        print("\n写入 tests/thresholds.json 失败：%r" % e)
    return 0


def _infer_n_assertions(run):
    """从 direction_accuracy 与 failures 长度反推断言总数。

    accuracy = passed / total，failed = len(failures)。两个已知量解出 total。
    例：failed=50, accuracy=0.4949 → total = 50 / 0.5051 ≈ 99 ✓
    ★ 为什么要这个数：48 个用例会展开成 99 条方向断言（一个用例可断言多个信号）。
      「准确率差 2 个百分点」听起来像差距，实际只是 99 条里差 2 条 —— 必须先还原成
      条数，才能判断这差距是不是噪声。
    """
    try:
        acc = float(run.get("direction_accuracy") or 0.0)
    except Exception:
        return None
    failed = len(run.get("failures") or [])
    if failed == 0 or acc >= 1.0:
        return None
    n = int(round(failed / (1.0 - acc)))
    return n if n >= failed else None


def cmd_ckptcompare():
    """同条件检查点对照（§11）：typed-decisions vs english。

    同一套 48 条决策方向用例、同一批信号题，只换检查点。
    数据来自 signaltest 写下的 runs，所以**必须在两个进程里各跑一次**：
        python laya_bridge.py signaltest
        LAYA_MODEL=english python laya_bridge.py signaltest
        python laya_bridge.py ckptcompare

    评判标准不是「哪个方向准确率高」，而是：
        · 信号有没有区分度（span 太小 = 这个检查点在所有输入上给同一个值）
        · 排除「全部同样本里 90% 只选同一个行为」这种假高分
    """
    path = TESTS_DIR / "thresholds.json"
    try:
        blob = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        print("读不到 tests/thresholds.json（%r）。先跑 signaltest。" % e)
        return 1
    runs_all = blob.get("runs") or {}
    # 只拿「全量、默认 qset」的结果做检查点对照；带 |qset= / |cases= 的是诊断子集，
    # 混进来会让对照表没法看（同一条信号出现好几行）。
    runs = dict((k, v) for k, v in runs_all.items() if "|" not in k)
    skipped = sorted(k for k in runs_all if "|" in k)
    if skipped:
        print("（忽略 %d 个诊断子集结果：%s）\n" % (len(skipped), ", ".join(skipped)))
    if len(runs) < 2:
        print("目前只有 %d 个检查点的数据：%s" % (len(runs), ", ".join(sorted(runs)) or "无"))
        print("请再跑一次：LAYA_MODEL=english python laya_bridge.py signaltest")
        return 1

    order = [m for m in ("typed-decisions", "english", "multilingual") if m in runs]
    order += [m for m in sorted(runs) if m not in order]

    print("=" * 78)
    print("检查点对照（§11）｜同条件：同一批用例、同一批信号题，只换检查点")
    print("=" * 78)
    for m in order:
        r = runs[m]
        print("  %-16s n=%-3d 方向准确率 %.1f%%  ｜ %s"
              % (m, r.get("n_cases", 0), 100.0 * (r.get("direction_accuracy") or 0), r.get("device", "?")))

    # ---- 逐信号对比：区分度（span）比绝对值更有意义 ----
    print("\n── 逐信号实测（min / mean / max / span）" + "─" * 34)
    hdr = "  %-13s" % "signal"
    for m in order:
        hdr += "%-30s" % ("  " + m)
    print(hdr)
    sig_names = []
    for m in order:
        for s in (runs[m].get("signal_distribution") or {}):
            if s not in sig_names:
                sig_names.append(s)
    for s in sig_names:
        line = "  %-13s" % s
        for m in order:
            d = (runs[m].get("signal_distribution") or {}).get(s)
            line += ("%-30s" % ("  ——无数据") if not d else
                     "%-30s" % ("  %.2f/%.2f/%.2f span=%.2f"
                                % (d["min"], d["mean"], d["max"], d["span"])))
        print(line)

    # ---- 排名：按「有区分度的信号个数」+ 方向准确率综合 ----
    print("\n── 综合判断" + "─" * 46)
    summary = {}
    for m in order:
        dist = runs[m].get("signal_distribution") or {}
        # span 太小的信号等于常数输出，在决策里等于没提供信息
        live = [s for s, d in dist.items() if d.get("span", 0) >= 0.05]
        dead = [s for s, d in dist.items() if d.get("span", 0) < 0.05]
        summary[m] = {"direction_accuracy": runs[m].get("direction_accuracy"),
                      "n_assertions": _infer_n_assertions(runs[m]),
                      "live_signals": live, "flat_signals": dead,
                      "n_signals": len(dist)}
        print("  %-16s 有效区分信号 %d/%d ｜ 近乎常量 %s"
              % (m, len(live), len(dist), ", ".join(dead) or "无"))

    # ★ 显著性护栏（本轮加）。
    # 99 条断言里差 2 条 = 2 个百分点，视觉上像「更好」，统计上什么都不是。
    # 不加这道护栏，工具会为了「给一个结论」而随机指定赢家 —— 下游会把噪声当证据写进架构决策。
    MIN_PASS_GAP = 5
    ranked = sorted(order, key=lambda m: -(summary[m]["direction_accuracy"] or 0))
    tie, gap_pass = False, None
    if len(ranked) >= 2:
        a, b = ranked[0], ranked[1]
        na, nb = summary[a].get("n_assertions"), summary[b].get("n_assertions")
        if na and nb:
            pa = (summary[a]["direction_accuracy"] or 0) * na
            pb = (summary[b]["direction_accuracy"] or 0) * nb
            gap_pass = abs(pa - pb)
            tie = gap_pass < MIN_PASS_GAP
    summary["_verdict"] = {"ranked": ranked, "tie": tie,
                           "win_margin_assertions": (round(gap_pass, 1) if gap_pass is not None else None),
                           "min_pass_gap": MIN_PASS_GAP}

    if tie:
        # 准确率分不出 → 退到次级指标：区分度更宽的更适合当信号源
        def _total_span(m):
            dist = runs[m].get("signal_distribution") or {}
            return sum(d.get("span", 0.0) for d in dist.values())
        best = max(order, key=lambda m: (_total_span(m), len(summary[m]["live_signals"])))
        print("\n  ▸ 结论：**平局** —— 两个检查点的方向准确率差距仅 %.0f 条断言，"
              "未达显著门槛 %d 条。" % (gap_pass if gap_pass is not None else 0, MIN_PASS_GAP))
        print("    0.5 的准确率等于抛硬币：**两个检查点都没能真正做对决策方向**，"
              "差别只是随机噪声落在谁头上。")
        print("    次级指标（信号区分度跨度之和）：%s"
              % "，".join("%s=%.2f" % (m, _total_span(m)) for m in order))
        print("    → 若必须选一个当信号源，按「区分度更宽」取 **%s**，"
              "但这只是可用性偏好，**不是准确率证据**。" % best)
    else:
        best = ranked[0]
        print("\n  ▸ 结论：本次对照中 **%s** 更适合作为 Decision Signals Engine。" % best)
        print("    依据：方向准确率 %.1f%%（比次优多对 %.0f 条断言，达显著门槛 %d），"
              "%d/%d 个信号有实际区分度。"
              % (100.0 * (summary[best]["direction_accuracy"] or 0), gap_pass or 0,
                 MIN_PASS_GAP, len(summary[best]["live_signals"]), summary[best]["n_signals"]))
    if any(summary[m]["flat_signals"] for m in order):
        print("    ★ 标为「近乎常量」的信号在决策里等于没有信息，不要为它们写 policy 阈值。")
    print("    ★ 同一检查点的数值会随设备漂移（CPU vs GPU 实测最大差 0.033，"
          "与翻译抖动 0.055 同量级），比较必须同设备。")

    try:
        (TESTS_DIR / "ckpt_compare.json").write_text(json.dumps(
            {"_readme": ["由 python laya_bridge.py ckptcompare 生成。不要手改。",
                         "数据源是 thresholds.json 的 runs，需两个进程各跑一次 signaltest。"],
             "models": order, "summary": summary,
             "winner": best,
             "signal_distribution": dict((m, runs[m].get("signal_distribution")) for m in order),
             "direction_accuracy": dict((m, runs[m].get("direction_accuracy")) for m in order)},
            ensure_ascii=False, indent=2), encoding="utf-8")
        print("\n已写入 tests/ckpt_compare.json")
    except Exception as e:
        print("\n写入 tests/ckpt_compare.json 失败：%r" % e)
    return 0


def cmd_personatest():
    """人格 A/B 对照：固定场景/关系/情绪/目标/Traits/台词，只改 personality。

    要回答的问题只有一个：
        其余状态完全相同的情况下，Laya 会不会因为人格参数而产生**稳定且方向合理**的差异？

    判据是**跨人格的方差**：如果四个 persona 的信号几乎一样，那就说明
    「人格影响决策」在 Laya 这条链路上不成立 —— 无论配置里写得多漂亮。
    这比看某一条输入的结果有意义得多。

    用法：
        python laya_bridge.py personatest
        LAYA_PERSONA_STYLE=polarity python laya_bridge.py personatest   # 对照另一种人格写法
    """
    fixture = _load_fixture("personality_personas.json")
    if not fixture:
        return 1

    ENGINE.init()
    if not ENGINE.ready:
        print("laya 未就绪，先跑 probe 看原因。")
        return 1
    model = DEFAULT_MODEL_NAME
    personas = fixture["personas"]
    stimuli = fixture["stimuli"]

    global LANG
    qs = build_laya_questions(CFG["questions"])
    cache = {}
    try:
        cache = json.loads(_XLATE_DISK.read_text(encoding="utf-8"))
    except Exception:
        pass

    print("=" * 78)
    print("人格 A/B 对照 ｜ 检查点=%s ｜ 设备=%s" % (model, ENGINE.device_label()))
    print("人格写法=%s（LAYA_PERSONA_STYLE 可覆盖）｜ 信号子集只用于表格，实际跑全部 %d 题"
          % (personality_style(), len(qs)))
    print("=" * 78)

    order = CFG.get("signals", {}).get("order") or []
    table, per_persona = {}, {}
    for st in stimuli:
        text_en = _cached_translate(st["text"], cache) if LANG == "en" else st["text"]
        rows_pp = {}
        for p in personas:
            actor = json.loads(json.dumps(CFG["actor"]))     # 深拷贝，避免互相污染
            actor["personality"] = p["personality"]
            doc = build_state_doc(actor, st["text"], [], CFG.get("scene"), None,
                                  player_input_en=text_en,
                                  decision_history=[{"type": "start", "summary": "scene begins"}])
            try:
                _dt, rows, by_name = _run_signals(model, doc, qs)
            except Exception as e:
                print("  [%s/%s] 失败：%r" % (st["id"], p["id"], e))
                rows_pp[p["id"]] = {}
                continue
            rows_pp[p["id"]] = dict((r["signal"], r["value"]) for r in rows)
            # 累积到人名下，供最后算整体方差
            for sig, v in rows_pp[p["id"]].items():
                per_persona.setdefault(sig, {}).setdefault(p["id"], []).append(v)
        table[st["id"]] = rows_pp

    for st in stimuli:
        print("\n── 输入 [%s]：%s" % (st["id"], st["text"]))
        print("   %s" % st["why"])
        print("   %-12s %8s %8s %8s %8s %9s" % ("signal", *[p["id"] for p in personas], "跨人格极差"))
        rr = table.get(st["id"], {})
        for sig in order:
            vals = [rr.get(p["id"], {}).get(sig) for p in personas]
            have = [v for v in vals if v is not None]
            spread = (max(have) - min(have)) if len(have) > 1 else 0.0
            cells = " ".join(("%8.3f" % v) if v is not None else "       -" for v in vals)
            flag = "  ★" if spread >= 0.10 else ""
            print("   %-12s %s %9.3f%s" % (sig, cells, spread, flag))

    print("\n" + "=" * 78)
    print("整体：每个信号在人之间的平均极差（越大 = 人格影响越明显）")
    print("=" * 78)
    print("  %-12s %9s %9s" % ("signal", "平均极差", "判定"))
    summary = {}
    for sig in order:
        pp = per_persona.get(sig) or {}
        if len(pp) < 2:
            continue
        # 先按 persona 求均值，再算跨 persona 的极差
        means = dict((k, sum(v) / len(v)) for k, v in pp.items() if v)
        if len(means) < 2:
            continue
        spread = max(means.values()) - min(means.values())
        verdict = ("人格有可观察影响" if spread >= 0.10
                   else ("接近噪声，无可观察影响" if spread < 0.05 else "弱，需更多样本"))
        summary[sig] = {"persona_means": dict((k, round(v, 4)) for k, v in means.items()),
                        "spread": round(spread, 4), "verdict": verdict}
        print("  %-12s %9.3f   %s" % (sig, spread, verdict))

    live = [s for s, v in summary.items() if v["spread"] >= 0.10]
    print("\n结论：%d/%d 个信号对人呈现可观察差异。" % (len(live), len(summary)))
    print("  有明显差异：%s" % (", ".join(live) if live else "（无）"))
    print("  ★ 注意：差异存在 ≠ 方向合理。还要人工核对那几个 persona 的取向是否与设定一致；")
    print("    当前 Demo 只做到「能量出差异」，没有做「差异是否符合人格语义」的自动判定。")

    try:
        (TESTS_DIR / "personality_ab.json").write_text(json.dumps(
            {"_readme": ["由 python laya_bridge.py personatest 生成。",
                         "table = 逐输入逐人格的信号矩阵；summary = 跨人格极差"],
             "model": model, "device": ENGINE.device_label(),
             "personality_style": personality_style(),
             "table": table, "summary": summary}, ensure_ascii=False, indent=2), encoding="utf-8")
        print("\n已写入 tests/personality_ab.json")
    except Exception as e:
        print("\n写入失败：%r" % e)
    return 0


def cmd_bench():
    """CPU / GPU 性能基准（§10）。真实测量，不做理论估算。

    设备在 ENGINE.init() 时就定了（检查点按 device 加载），所以 CPU 与 GPU
    **必须分两个进程**跑，不能在同一个进程里切换：
        LAYA_DEVICE=cpu  python laya_bridge.py bench
        LAYA_DEVICE=cuda python laya_bridge.py bench        # 记得用 .venv-cuda 的解释器
    """
    ENGINE.init()
    if not ENGINE.ready:
        print("laya 未就绪，先跑 probe 看原因。")
        return 1

    try:
        import torch
    except Exception:
        torch = None

    print("=" * 78)
    print("性能基准 ｜ 检查点=%s" % DEFAULT_MODEL_NAME)
    print("设备：%s" % ENGINE.device_label())
    print("torch=%s  cuda_build=%s  cuda_available=%s"
          % (getattr(torch, "__version__", "?"), getattr(getattr(torch, "version", None), "cuda", None),
             bool(torch and torch.cuda.is_available())))
    print("=" * 78)

    if torch is not None and torch.cuda.is_available():
        p = torch.cuda.get_device_properties(0)
        print("GPU：%s  VRAM=%.2f GB  SM=%d.%d" % (p.name, p.total_memory / 1024**3,
                                                   p.major, p.minor))
    free_before = _free_phys_mb()
    print("冷加载模型耗时：%d ms" % ENGINE.load_ms)
    if torch is not None and torch.cuda.is_available():
        print("加载后 VRAM：allocated=%.2f GB  reserved=%.2f GB"
              % (torch.cuda.memory_allocated() / 1024**3, torch.cuda.memory_reserved() / 1024**3))
    free_after = _free_phys_mb()
    if free_before and free_after:
        print("RAM 占用（加载前后可用物理内存之差）：约 %d MB" % max(0, free_before - free_after))

    all_q = build_laya_questions(CFG["questions"])
    qids = list(all_q.keys())
    doc = build_state_doc(CFG["actor"], "Can you help me find the man called Grey Crow?",
                          [], CFG.get("scene"), None,
                          player_input_en="Can you help me find the man called Grey Crow?",
                          decision_history=[{"type": "start", "summary": "scene begins"}])

    print("\n%-34s %8s %10s %10s %12s" % ("题目集合", "题数", "首次ms", "均次ms", "每题均ms"))
    plan = [("1 题", 1), ("3 题", 3), ("6 题", 6), ("10 题", 10),
            ("完整 NPC tick", len(qids))]
    results = []
    for label, k in plan:
        k = min(k, len(qids))
        sub = dict((qid, all_q[qid]) for qid in qids[:k])
        try:
            t0 = time.perf_counter()
            ENGINE.predict(doc, sub) if ENGINE.kind != "router" else ENGINE.obj.predict(
                doc, sub, model=DEFAULT_MODEL_NAME)
            first_ms = (time.perf_counter() - t0) * 1000
            runs = []
            for _ in range(3):
                t1 = time.perf_counter()
                ENGINE.predict(doc, sub) if ENGINE.kind != "router" else ENGINE.obj.predict(
                    doc, sub, model=DEFAULT_MODEL_NAME)
                runs.append((time.perf_counter() - t1) * 1000)
            avg = sum(runs) / len(runs)
            results.append({"label": label, "n": k, "first_ms": round(first_ms, 1),
                            "avg_ms": round(avg, 1), "per_q_ms": round(avg / k, 1)})
            print("%-34s %8d %10.0f %10.0f %12.1f" % (label, k, first_ms, avg, avg / k))
        except Exception as e:
            print("%-34s  失败：%r" % (label, e))

    # ---- World Tick（§17 要求单独给出「GPU world decision」的毫秒数）----
    # 世界层走的是 world_state + role=WORLD 的 payload，和 NPC 的 doc 不是同一种输入，
    # 不能拿 NPC 的耗时顶上。
    world_ms, world_n = None, 0
    world_q = build_laya_questions(CFG["world"]["questions"])
    world_payload = {"world_state": CFG["world"]["state"], "role": "WORLD"}
    try:
        t0 = time.perf_counter()
        ENGINE.predict(world_payload, world_q)
        first_ms = (time.perf_counter() - t0) * 1000
        runs = []
        for _ in range(3):
            t1 = time.perf_counter()
            ENGINE.predict(world_payload, world_q)
            runs.append((time.perf_counter() - t1) * 1000)
        world_ms = sum(runs) / len(runs)
        world_n = len(world_q)
        print("\n%-34s %8d %10.0f %10.0f %12.1f"
              % ("World Tick（world_state + role=WORLD）", world_n, first_ms, world_ms, world_ms / max(1, world_n)))
    except Exception as e:
        print("\nWorld Tick 基准失败：%r" % e)

    if torch is not None and torch.cuda.is_available():
        print("\n峰值 VRAM：allocated=%.2f GB  reserved=%.2f GB"
              % (torch.cuda.max_memory_allocated() / 1024**3,
                 torch.cuda.max_memory_reserved() / 1024**3))

    if results:
        full = results[-1]
        print("\n★ 高频 NPC tick 可行性判断（仅按本机实测算）")
        print("  完整 NPC tick 一次 %.0f ms" % full["avg_ms"])
        print("  → 单 NPC 每秒可决策 %.1f 次；若每个 NPC 每回合都跑，8 个并发 NPC ≈ %.0f ms/回合"
              % (1000.0 / max(1.0, full["avg_ms"]), full["avg_ms"] * 8))
        print("  世界层是低频的（§9）：一「日」跑一次，%.0f ms 完全够用，不需要和 NPC tick 抢预算。"
              % (world_ms or 0))

    # ---- 落盘：CPU / GPU 两次分别跑，结果**按设备合并**，不要互相覆盖 ----
    # 每个进程只认一个设备（检查点在 init 时就按 device 加载），所以「一次跑出两份」
    # 是做不到的，只能合并同一份文件里的两次结果。
    vram = None
    if torch is not None and torch.cuda.is_available():
        vram = {"peak_allocated_gb": round(torch.cuda.max_memory_allocated() / 1024**3, 3),
                "peak_reserved_gb": round(torch.cuda.max_memory_reserved() / 1024**3, 3),
                "device_total_gb": round(torch.cuda.get_device_properties(0).total_memory / 1024**3, 2)}
    dev = ENGINE.device_label()
    try:
        path = TESTS_DIR / "bench.json"
        try:
            blob = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            blob = {}
        blob["_readme"] = ["由 python laya_bridge.py bench 生成。不要手改。",
                           "CPU 与 GPU 必须分两个进程各跑一次，结果按设备合并进 runs。",
                           "GPU 请用 .venv-cuda 的解释器并设 LAYA_DEVICE=cuda。"]
        blob["model"] = DEFAULT_MODEL_NAME
        blob.setdefault("runs", {})[dev] = {
            "results": results,
            "world_tick": ({"n_questions": world_n, "avg_ms": round(world_ms, 1)} if world_ms else None),
            "load_ms": ENGINE.load_ms,
            "vram": vram,
        }
        path.write_text(json.dumps(blob, ensure_ascii=False, indent=2), encoding="utf-8")
        print("已合并写入 tests/bench.json（设备键：%s）" % dev)
    except Exception as e:
        print("写入 tests/bench.json 失败：%r" % e)
    return 0


def cmd_selftest():
    print("=== 回退引擎自检（不需要 Laya）===")
    actor = json.loads(json.dumps(CFG["actor"]))
    qs = build_laya_questions(dict(CFG["questions"], **CFG["world"]["questions"]))
    cases = [
        "我是个行商，从北边来。带了点不太方便在城里说的事。",
        "货的事，明天再谈。今晚我只想喝一杯。",
        "实话告诉你，我不是商人。我在找一个人。",
        "你要是不说，我就不客气了。",
    ]
    for text in cases:
        out, intent, pairs = fallback_decide(actor, CFG["world"]["state"], text, qs, seed=15)
        deltas, _ = build_deltas(normalize_answers(out, qs), CFG["questions"], actor)
        b = out.get("npc_behavior", {})
        print("\n玩家：%s" % text)
        print("  意图：%s (%.3f)" % (intent, pairs[0][1]))
        print("  行为：%s (%.3f)" % (b.get("choice"), b.get("confidence", 0)))
        prob = b.get("_fallback_probabilities") or {}
        top = sorted(prob.items(), key=lambda kv: -kv[1])[:3]
        print("  分布：" + "  ".join("%s=%.3f" % kv for kv in top))
        print("  增量：" + "  ".join("%s %+.2f" % (d["label"], d["delta"]) for d in deltas))
        print("  背叛倾向=%.3f  隐藏事件=%.3f" % (out.get("betrayal_intent", {}).get("noul", -1),
                                                out.get("hidden_event", {}).get("noul", -1)))
    print("\n=== 世界层自检 ===")
    for e in world_decide({})["events"]:
        print("  %-14s %.3f  %s" % (e["id"], e["p"], "采纳" if e["adopt"] else "仅记录"))
    return 0


def cmd_qcheck():
    """审计问题集的 token 预算与温度桶 —— 改 narra_config.json 之后必跑。

    为什么需要它（都是 build_sequence 里的静默行为）：
      1. 每个选项最多吃 48 token（超出直接切掉，不报错）。
      2. 全部选项合计必须塞进 head_max_len（默认 256）。塞不下时所有选项会被
         一起压到 (head_max_len-16)/选项数 个 token，可能出现「两个选项文字
         被截成一样」——模型就分不出来了。这一步同样不报错。
      3. 每个问题按 (type, 选项数) 查 temperature_by_options 里的桶取温度。
         检查点自带的某些桶温度在 [0.5, 5] 之外，会被 clamp（见 clamp_temperature），
         那些桶的置信度就不再校准：typed-decisions 的 choice:11+ 只有 0.1006。
    这三件事都只有在问题集变长/选项变多时才会发作，所以要在改配置时立刻查。
    """
    import laya.common as LC
    from laya.agent import Agent as LayaAgent   # _to_internal 在 agent 模块，不在 common

    # 顺序很关键：必须**先看当前实际用的检查点**（LAYA_MODEL），再看其它的。
    # 两个检查点的 head_max_len 不一样（typed-decisions 256 / english 192），
    # 拿错的那份去算余量，会把本来够用的选项误判成溢出（或反过来漏报）。
    order = [DEFAULT_MODEL_NAME] + [n for n in sorted(find_local_models()) if n != DEFAULT_MODEL_NAME]

    tok, tok_from = None, None
    for name in order:
        d = MODELS_DIR / ("laya-" + name)
        if (d / "tokenizer").is_dir():
            try:
                from transformers import AutoTokenizer
                tok = AutoTokenizer.from_pretrained(str(d / "tokenizer"))
                tok_from = name
                print("tokenizer 来自本地: %s" % d)
                break
            except Exception as e:
                print("加载本地 tokenizer 失败(%s): %r" % (name, e))
    if tok is None:
        print("★ 本地没有 tokenizer（先跑 python _fetch_laya.py），无法审计。")
        return 1

    # head_max_len 取**同一个检查点**的配置；取不到用 laya 的默认
    head = 256
    for name in order:
        p = MODELS_DIR / ("laya-" + name) / "rl_agent_config.json"
        if p.exists():
            head = json.loads(p.read_text(encoding="utf-8")).get("head_max_len", head)
            break

    qs = dict(CFG["questions"])
    for k, v in (CFG.get("world", {}).get("questions") or {}).items():
        qs["world_" + k] = v

    # criteria_source="behaviors" 的题在配置里没有 criteria 字段，要按同一套解析规则取短标签，
    # 否则这里会误报「结构不合法」，把真正要看的预算信息遮掉。
    qs = build_laya_questions(qs)

    print("按检查点 %s 的预算审计（head_max_len = %d，每个选项最多 48 token）"
          % (tok_from, head))
    print("当前 LAYA_MODEL=%s；state_format=%s\n"
          % (DEFAULT_MODEL_NAME, CFG.get("state_format", "compact")))
    print("%-20s %-7s %4s %6s %6s %6s  %s"
          % ("问题", "类型", "选项", "指令", "选项和", "最长项", "结论"))
    print("-" * 92)
    problems = []
    for qid, q in qs.items():
        try:
            qq = LayaAgent._to_internal(q)
            opts = LC.render_options(qq)
        except Exception as e:
            print("%-20s ★ 结构不合法: %r" % (qid, e))
            problems.append(qid)
            continue
        ins = len(tok("%s question: %s" % (qq["t"], qq["ins"]), add_special_tokens=False)["input_ids"])
        per = [len(tok(" " + o, add_special_tokens=False)["input_ids"]) for o in opts]
        tot = sum(per)
        notes = []
        if max(per) > 48:
            notes.append("★ 有选项文字超 48 token 被切断")
        if tot > head - 16:
            squeezed = max(4, (head - 16) // max(1, len(per)))
            notes.append("★ 选项合计超 head，会被压到每项 %d token" % squeezed)
        tkey = LC.temp_bucket(LC.QTYPES[qq["t"]], len(per))
        temps = {}
        for name in sorted(find_local_models()):
            p = MODELS_DIR / ("laya-" + name) / "rl_agent_config.json"
            if p.exists():
                temps[name] = (json.loads(p.read_text(encoding="utf-8"))
                               .get("temperature_by_options", {}) or {}).get(tkey)
        for name, t in temps.items():
            if t is not None and LC.clamp_temperature(t) != float(t):
                notes.append("★ %s 的桶 %s 温度 %.4g 越界已 clamp 到 %.4g（该桶置信度不校准）"
                             % (name, tkey, t, LC.clamp_temperature(t)))
        if not notes:
            notes.append("OK（余量 %d token，桶 %s）" % (head - tot, tkey))
        if any(n.startswith("★") for n in notes):
            problems.append(qid)
        print("%-20s %-7s %4d %6d %6d %6d  %s"
              % (qid, qq["t"], len(per), ins, tot, max(per), "；".join(notes)))

    # ---- 另一半预算：state 文档。build_sequence 是
    #      [CLS] head [SEP] [MASK]opt… [SEP] <state> [SEP]，state 排在最前面被挤掉的位置。
    #      早期 12 字段 JSON 形态在 english 上会溢出（可用余量只有 max_len-head-1=319），
    #      而 state 超长是**静默截断**：st[:room] 保留左边、丢掉右边，
    #      正好把 `player_says`/`message` 这个最关键的字段丢掉 → 模型看不到玩家说了什么。
    max_len = 512
    for name in order:
        p = MODELS_DIR / ("laya-" + name) / "rl_agent_config.json"
        if p.exists():
            max_len = json.loads(p.read_text(encoding="utf-8")).get("max_len", max_len)
            break
    room = max_len - head - 1
    print()
    print("state 文档预算：max_len %d − head %d − 1 = 余量 %d token" % (max_len, head, room))
    orig_lang = LANG
    # ★ 必须连「最坏情况」一起量。decision_history 会随着对局长大，
    #   只测空历史等于没测 —— 真正的溢出从第三、四轮才开始出现，那时没人会再跑 qcheck。
    DH_FULL = [
        {"type": "player_sincere", "summary": "player gives real information openly"},
        {"type": "npc_confide", "summary": "npc reveals her own secret"},
        {"type": "player_lie", "summary": "player says a falsifiable lie"},
        {"type": "npc_confront", "summary": "npc confronts the player directly"},
    ]
    variants = [("空决策历史", None), ("满决策历史(4条)", DH_FULL)]
    for lang in ("en", "zh"):
        for label, dh in variants:
            globals()["LANG"] = lang
            doc = build_state_doc(CFG["actor"], SAMPLE_INPUT_EN if lang == "en" else SAMPLE_INPUT_ZH,
                                  [{"role": "player", "text": SAMPLE_INPUT_ZH, "text_en": SAMPLE_INPUT_EN}],
                                  CFG.get("scene"), CFG["world"]["state"],
                                  player_input_en=SAMPLE_INPUT_EN,
                                  decision_history=dh)
            txt = doc if isinstance(doc, str) else json.dumps(doc, ensure_ascii=False)
            n = len(tok(txt, add_special_tokens=False)["input_ids"])
            mark = "★ 溢出！尾部会被 st[:room] 静默截断" if n > room else "OK（余量 %d token）" % (room - n)
            print("  state_format=%-7s 语言 %s %-14s → %d token  %s"
                  % (CFG.get("state_format", "compact"), lang, label, n, mark))
            if n > room:
                problems.append("state_doc(%s,%s)" % (lang, label))
    globals()["LANG"] = orig_lang

    print()
    if problems:
        print("★ 有 %d 处需要处理：%s" % (len(problems), ", ".join(problems)))
        print("  选项太长的改短选项文字；state 溢出的改小 state_format=compact 或砍字段。")
        return 1
    print("问题集预算健康：无截断、无挤压、无越界温度桶、state 不溢出。")
    return 0


def cmd_sanity():
    """A/B 对照：我们自己发明的问法 vs 照 Laya 预设格式改写后的问法。

    背景（实测 + 读源码得到的结论）
    -------------------------------
    用我们原来的问法（12 字段 JSON state + 指令里写 "this sentence" + score 判据是
    通用比较词 much lower/lower/unchanged/higher/much higher），english 与
    typed-decisions 两个检查点都**没有区分度**：三个语义相反的输入选中同一个行为，
    六个评分项的期望值跨度只有 0.01~0.19（满分 5 档）。

    而 Laya 自带的 presets 是这样的形态：
        {"type":"score",
         "instructions":"How frustrated does the customer sound in `message`?",
         "criteria":["calm and neutral","concerned but civil","clearly annoyed",
                     "very angry or using strong language"]}
    两条关键差异：
      1. instructions 用**反引号引用命名变量**（`message`），state 就是含这个键的 dict。
         我们写 "this sentence"，模型没有锚点知道指的是什么。
      2. score 的 criteria 是**领域化的档位描述**，每个档自带语义。
         我们六个评分题共用同一组通用词，选项本身不含任何领域信息。

    本命令就是验证这个假设：同一批输入、同一个检查点，只换问法与 state 形态，
    看行为选择题的选中项是否开始随输入变化、评分题的期望值跨度是否张开。
    """
    ENGINE.init()
    if not ENGINE.ready:
        print("laya 未就绪。")
        return 1

    # 从配置里取行为候选（两种问法共用同一组选项，只换 instructions 与 state）
    behaviors = CFG.get("behaviors") or []
    if len(behaviors) < 3:
        print("配置里 behaviors 太少，无法做对照。")
        return 1
    crit_beh = {b["id"]: (b.get("desc_en") or b.get("desc") or "") for b in behaviors}

    # ---- 变体 B：照预设格式改写 ----
    def compact_state(msg):
        a = CFG["actor"]
        t, r, e = a.get("traits", {}), a.get("relationship", {}), a.get("emotion", {})
        sit = a.get("situation", {}) or {}
        return {
            "npc": ("%s, %s. Traits: %s. Currently %s."
                    % (a.get("name_en") or a.get("name"),
                       a.get("identity_en") or a.get("identity"),
                       ", ".join("%s %.2f" % (k, v) for k, v in t.items()),
                       ", ".join("%s %.2f" % (k, v) for k, v in e.items()))),
            "relationship": ("trust %s/100, respect %s/100, doubt %s/100, reliance %s/100"
                             % (r.get("trust"), r.get("respect"), r.get("doubt"), r.get("reliance"))),
            "scene": ("%s, %s. %s"
                      % (sit.get("place_en") or sit.get("place"), sit.get("time_en") or sit.get("time"),
                         (CFG.get("scene") or {}).get("note_en") or "")),
            "message": msg,
        }

    varB = {
        "behavior": {
            "type": "choice",
            "instructions": ("Given `npc`, `relationship` and `scene`, which single action does "
                             "`npc` take next in response to `message`?"),
            "criteria": crit_beh,
        },
        "trust": {
            "type": "score",
            "instructions": "How does `message` change the trust that `npc` has in the player?",
            "criteria": ["trust drops sharply", "trust drops a little", "trust is unchanged",
                         "trust rises a little", "trust rises sharply"],
        },
        "doubt": {
            "type": "score",
            "instructions": "How does `message` change how much `npc` doubts the player?",
            "criteria": ["doubt falls sharply", "doubt falls a little", "doubt is unchanged",
                         "doubt rises a little", "doubt rises sharply"],
        },
        "betray": {
            "type": "noul",
            "instructions": "Is `npc` forming the intention to abandon or turn against the player?",
        },
    }

    global LANG
    orig = LANG
    LANG = "en"
    varA_q = build_laya_questions(CFG["questions"])
    varA_state = {tag: build_state_doc(CFG["actor"], t, [], CFG.get("scene"),
                                       CFG["world"]["state"], player_input_en=t)
                  for tag, t in LANGTEST_CASES}
    varB_state = {tag: compact_state(t) for tag, t in LANGTEST_CASES}
    LANG = orig

    variant = ENGINE.model_name
    blocks = [b.upper() for b in sys.argv[2:] if b] or ["A", "B", "C"]
    print("检查点：%s    跑 %s\n" % (variant, "/".join(blocks)))
    summary = {}
    for name, state_map, qs in (("A 我们原来的问法", varA_state, varA_q),
                                ("B 照预设格式改写", varB_state, varB)):
        if name[0] not in blocks:
            continue
        print("=" * 78)
        print("变体 %s" % name)
        print("=" * 78)
        rows = []
        for tag, _ in LANGTEST_CASES:
            try:
                t0 = time.perf_counter()
                res = ENGINE.predict(state_map[tag], qs)
                dt = (time.perf_counter() - t0) * 1000
                raw, _ = normalize_laya(res)
                std = normalize_answers(raw, qs)
            except Exception as e:
                print("   [%s] 失败：%r" % (tag, e))
                continue
            rows.append((tag, dt, std))
            b = std.get("behavior") or std.get("npc_behavior") or {}
            probs = b.get("_probabilities") or {}
            top = sorted(probs.items(), key=lambda kv: -kv[1])[:3]
            print("   %-4s %6.0fms  行为=%-10s conf=%-7s 分布 %s"
                  % (tag, dt, b.get("_value"), b.get("confidence"),
                     "  ".join("%s=%.3f" % kv for kv in top) or "(无)"))
        if not rows:
            continue
        picked = []
        for tag, dt, std in rows:
            b = std.get("behavior") or std.get("npc_behavior") or {}
            if b.get("_value"):
                picked.append(b["_value"])
        print("   ▸ 行为选中 %s → %d 种" % (picked, len(set(picked))))
        spans = []
        for qid in ("trust", "trust_shift", "doubt", "doubt_shift"):
            vals = [std.get(qid, {}).get("_value") for tag, dt, std in rows]
            vals = [v for v in vals if isinstance(v, (int, float))]
            if len(vals) >= 2:
                spans.append("%s %.2f~%.2f (跨度%.2f)" % (qid, min(vals), max(vals), max(vals) - min(vals)))
        if spans:
            print("   ▸ 评分跨度 " + "; ".join(spans))
        summary[name] = (len(set(picked)), picked)
        print()

    # ---- 块 C：极端对照 —— 行为选择题到底能不能随状态移动 ----
    # 若在「玩家拔刀要杀她」与「玩家是同袍来帮她的」之间，行为题的 argmax 都不变，
    # 就说明不是测试输入太相近，而是这个选项集与 instructions 的组合本身失效。
    # 同时测「加一个 other 兜底选项」能否让先验散开（Laya 自己的预设都带 other）。
    if "C" in blocks:
        EXTREME = [
            ("持刀威胁", "The player suddenly draws a knife and says he will kill her if she does not talk."),
            ("同袍相助", "The player hands over a sealed letter proving he is a fellow Templar sent to help her hunt Grey Crow."),
            ("陌生问路", "A stranger asks her which road leads to the next town."),
            ("羞辱骑士团", "The player spits on the floor and insults her order as a pack of liars and thieves."),
        ]
        crit8 = dict(crit_beh)
        crit8["other"] = "none of the above fits; she does something else entirely"
        q7 = {"behavior": {"type": "choice",
                           "instructions": ("Given `npc`, `relationship` and `scene`, which single action does "
                                            "`npc` take next in response to `message`?"),
                           "criteria": crit_beh}}
        q8 = {"behavior": {"type": "choice",
                           "instructions": ("Given `npc`, `relationship` and `scene`, which single action does "
                                            "`npc` take next in response to `message`?"),
                           "criteria": crit8}}
        print("=" * 78)
        print("块 C 极端对照：行为选择题能否随状态移动（预设格式的问法）")
        print("=" * 78)
        for tag, qq in (("7 选项", q7), ("8 选项（含 other 兜底）", q8)):
            picked = []
            print("\n  ── %s ──" % tag)
            for label, msg in EXTREME:
                try:
                    t0 = time.perf_counter()
                    res = ENGINE.predict(compact_state(msg), qq)
                    dt = (time.perf_counter() - t0) * 1000
                    raw, _ = normalize_laya(res)
                    std = normalize_answers(raw, qq)
                except Exception as e:
                    print("     [%s] 失败：%r" % (label, e))
                    continue
                b = std.get("behavior", {})
                probs = b.get("_probabilities") or {}
                top = sorted(probs.items(), key=lambda kv: -kv[1])[:3]
                picked.append(b.get("_value"))
                print("     %-10s %6.0fms → %-10s conf=%-7s  %s"
                      % (label, dt, b.get("_value"), b.get("confidence"),
                         "  ".join("%s=%.3f" % kv for kv in top)))
            print("     ▸ 选中 %s → %d 种 %s"
                  % (picked, len(set(picked)),
                     "（能随状态移动 ✓）" if len(set(picked)) > 1
                     else "（★ 极端反差下仍不变 = 该问题设计本身失效）"))
        print()

    # ---- 块 D：行为题的两种备选设计（都基于前面确认「score 好用、choice 容易塌」） ----
    #   D1 短选项：把长长的选项描述压成 3~5 个词，看 choice 的 argmax 是否开始移动。
    #      （怀疑长描述让某个选项变成「吸引子」，先验压过 state）
    #   D2 拆成 noul：每个行为单独问一次「她是否即将做这件事？」
    #      noul 是校准 P(true)，多个独立概率天然可以归一成分布，不必让模型做排序。
    if "D" in blocks:
        EXTREME = [
            ("持刀威胁", "The player suddenly draws a knife and says he will kill her if she does not talk."),
            ("同袍相助", "The player hands over a sealed letter proving he is a fellow Templar sent to help her hunt Grey Crow."),
            ("陌生问路", "A stranger asks her which road leads to the next town."),
            ("羞辱骑士团", "The player spits on the floor and insults her order as a pack of liars and thieves."),
        ]
        SHORT = {
            "ask": "asks a direct question",
            "observe": "stays silent and watches",
            "probe": "probes indirectly",
            "leave": "ends the conversation",
            "confide": "reveals her own secret",
            "ally": "proposes an alliance",
            "distance": "politely keeps her distance",
        }
        print("=" * 78)
        print("块 D 行为题的两种备选设计")
        print("=" * 78)

        qD1 = {"behavior": {"type": "choice",
                            "instructions": ("Given `npc` and `message`, which single action does "
                                             "`npc` take next?"),
                            "criteria": SHORT}}
        print("\n  ── D1 短选项（3~5 词）──")
        picked = []
        for label, msg in EXTREME:
            try:
                res = ENGINE.predict(compact_state(msg), qD1)
                raw, _ = normalize_laya(res)
                std = normalize_answers(raw, qD1)
            except Exception as e:
                print("     [%s] 失败：%r" % (label, e))
                continue
            b = std.get("behavior", {})
            probs = b.get("_probabilities") or {}
            top = sorted(probs.items(), key=lambda kv: -kv[1])[:3]
            picked.append(b.get("_value"))
            print("     %-10s → %-10s conf=%-7s  %s"
                  % (label, b.get("_value"), b.get("confidence"),
                     "  ".join("%s=%.3f" % kv for kv in top)))
        print("     ▸ 选中 %s → %d 种 %s"
              % (picked, len(set(picked)),
                 "（能随状态移动 ✓）" if len(set(picked)) > 1
                 else "（★ 仍不变）"))

        qD2 = {}
        for b in behaviors:
            bid = b["id"]
            qD2["do_" + bid] = {
                "type": "noul",
                "instructions": ("Is `npc` about to %s in response to `message`?" % SHORT.get(bid, bid)),
            }
        print("\n  ── D2 每个行为一个 noul（校准 P(true)，再归一成分布）──")
        for label, msg in EXTREME:
            try:
                res = ENGINE.predict(compact_state(msg), qD2)
                raw, _ = normalize_laya(res)
                std = normalize_answers(raw, qD2)
            except Exception as e:
                print("     [%s] 失败：%r" % (label, e))
                continue
            vals = {bid: std.get("do_" + bid, {}).get("_value") for bid in SHORT}
            vals = {k: v for k, v in vals.items() if isinstance(v, (int, float))}
            s = sum(vals.values()) or 1.0
            norm = {k: v / s for k, v in vals.items()}
            top = sorted(norm.items(), key=lambda kv: -kv[1])[:3]
            print("     %-10s → %-10s   P 归一 %s"
                  % (label, top[0][0] if top else "?",
                     "  ".join("%s=%.3f" % kv for kv in top)))
            print("               原始 noul %s"
                  % "  ".join("%s=%.3f" % (k, vals[k]) for k in sorted(vals, key=lambda x: -vals[x])[:4]))
        print()

    print("=" * 78)
    print("结论")
    print("=" * 78)
    for k, v in summary.items():
        if v is None:
            continue
        u, picked = v
        print("  %-18s 行为区分度 %d 种  %s" % (k, u, picked))
    print()
    ok = [v for v in summary.values() if v]
    if ok and all(u <= 1 for u, _ in ok):
        print("  A/B 都不区分 → 不是问法问题，要怀疑 state 本身或检查点不适合该任务。")
    elif ok:
        best_name, (best_u, _) = max(((k, v) for k, v in summary.items() if v),
                                     key=lambda kv: kv[1][0])
        print("  区分度更高的是「%s」（%d 种）。改进方向：" % (best_name, best_u))
        print("    ① instructions 用反引号引用 state 里的键名（如 `message`、`npc`），")
        print("       不要写 \"this sentence\" 这种没有锚点的指代")
        print("    ② score 的 criteria 改成领域化的档位描述，别让六个题共用同一组通用比较词")
        print("    ③ state 用短键、只放必要字段，别把 12 个字段的 JSON 全塞进去")
    return 0


def cmd_llmtest():
    """独立验证 LLM 接入：key 是否有效、model id 是否对、effort 与预算的关系。

    不依赖 Laya，随时可跑：python laya_bridge.py llmtest
    """
    key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("LLM_API_KEY")
    base = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com").rstrip("/")
    model = os.environ.get("LLM_MODEL", "deepseek-flash")
    effort = os.environ.get("LLM_EFFORT", "low")
    print("=== LLM 接入自检 ===")
    print("  base_url   : %s" % base)
    print("  model      : %s" % model)
    print("  effort     : %s" % (effort or "(未设置)"))
    print("  max_tokens : %s" % os.environ.get("LLM_MAX_TOKENS", "1600"))
    print("  key        : %s" % ("尾号 " + key[-4:] if key else "**缺失**"))
    if ENV_LOADED:
        print("  .env 载入  : %s" % ", ".join(ENV_LOADED))
    if ENV_OVERRIDDEN:
        print("  ⚠ 覆盖系统 : %s（本机系统里那个 key 已失效，被 .env 顶掉了）" % ", ".join(ENV_OVERRIDDEN))
    if not key:
        print("\n没有 key → 台词会走配置里的台词池（fallback_lines），功能可用但不生动。")
        return 1

    actor = CFG["actor"]
    behavior = CFG["behaviors"][0]
    print("\n--- 1) 走真实代码路径 llm_narrate() ---")
    r = llm_narrate(actor, behavior, "货的事，明天再谈。", [], "信任 62 / 怀疑 41", include_reasoning=True)
    if r is None:
        print("  返回 None（无 key 或初始化失败）")
    elif r.get("error"):
        print("  ❌ %s" % r["error"])
    else:
        print("  ✅ %sms  输出 %s token（推理 %s）" % (r.get("latency_ms"), r.get("completion_tokens"), r.get("reasoning_tokens")))
        print("     台词：%s" % r.get("line"))
        # ★ 这两个字段常在排查「台词里混进计划文本」时用到，直接打出来
        print("     <line> 标签：%s" % ("有（结构化正常）" if not r.get("contaminated")
                                       else "没有 → 已触发兜底清洗"))
        if r.get("contaminated"):
            print("     清洗：原文 %s 字 → 保留 %s 字" % (r.get("raw_chars"), r.get("kept_chars")))
            print("     ★ 出现清洗说明模型把「复述要求/写计划」写进了 content（effort=low 时常见），")
            print("       下面的原始 content 前后对照一下，确认切掉的是计划而不是台词：")
            print("     ── 原始 content ──")
            print("     " + (r.get("raw_content") or "").replace("\n", "\n     "))

    print("\n--- 2) 故意用显示名当 model（验证 id/显示名不是一回事）---")
    payload = {
        "model": "DeepSeek-V4.1-Flash",
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 16,
    }
    try:
        req = urllib.request.Request(
            base + "/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            resp.read()
        print("  ⚠ 竟然成功了？请核对 API 是否已支持该显示名")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")
        print("  预期内失败：HTTP %s" % e.code)
        print("  %s" % detail[:220])
    except Exception as e:
        print("  其它错误：%r" % e)
    print("\n提示：本机系统环境变量里可能存着已失效的旧 key（尾号 d4f0），"
          "\n      本项目已让 .env 覆盖它；若要彻底清理，删掉用户级 DEEPSEEK_API_KEY 即可。")
    return 0


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "probe":
        return cmd_probe()
    if len(sys.argv) > 1 and sys.argv[1] == "langtest":
        return cmd_langtest()
    if len(sys.argv) > 1 and sys.argv[1] == "selftest":
        return cmd_selftest()
    if len(sys.argv) > 1 and sys.argv[1] == "llmtest":
        return cmd_llmtest()
    if len(sys.argv) > 1 and sys.argv[1] == "qcheck":
        return cmd_qcheck()
    if len(sys.argv) > 1 and sys.argv[1] == "sanity":
        return cmd_sanity()
    if len(sys.argv) > 1 and sys.argv[1] == "signaltest":
        return cmd_signaltest()
    if len(sys.argv) > 1 and sys.argv[1] == "ckptcompare":
        return cmd_ckptcompare()
    if len(sys.argv) > 1 and sys.argv[1] == "personatest":
        return cmd_personatest()
    if len(sys.argv) > 1 and sys.argv[1] == "bench":
        return cmd_bench()

    print("正在初始化 Laya ...（未安装会直接走回退引擎）")
    ENGINE.init()
    if ENGINE.ready:
        print("  Laya 就绪：%s（加载 %d ms）" % (ENGINE.detail, ENGINE.load_ms))
        _st = getattr(install_fastload, "state", None)
        if _st and not _st.get("why"):
            print("  快加载：%s（已重算 %d 个非持久 buffer）—— 省掉建随机权重那一步"
                  % (ENGINE.fastload, _st.get("rebuilt") or 0))
        else:
            print("  快加载：%s" % (ENGINE.fastload,))
        print("  检查点：%s    本地已下：%s"
              % (ENGINE.model_name, ", ".join(ENGINE.local_models) or "（无，走 Hub 下载）"))
    else:
        print("  Laya 不可用：%s" % ENGINE.detail)
        print("  → 以回退引擎运行（pip install laya 后重启即可切到真实推理）")

    has_key = bool(os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("LLM_API_KEY"))
    if ENV_LOADED:
        print("  已从 .env 载入：%s" % ", ".join(ENV_LOADED))
    if ENV_OVERRIDDEN:
        print("  ⚠ 这些键的【系统环境变量】被 .env 覆盖了：%s" % ", ".join(ENV_OVERRIDDEN))
        print("     （本机系统里存着一个已失效的 DEEPSEEK_API_KEY，若不移除会静默导致 401）")
    if has_key:
        print("  台词生成：%s（effort=%s, max_tokens=%s）" %
              (os.environ.get("LLM_MODEL", "deepseek-flash"),
               os.environ.get("LLM_EFFORT", "low"), os.environ.get("LLM_MAX_TOKENS", "1600")))
    else:
        print("  台词生成：未配置 API key → 使用配置里的台词池")

    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    url = "http://127.0.0.1:%d" % PORT
    print("\n桥已启动：%s" % url)
    print("  GET  /health    体检（引擎 / Laya API 形状 / 已装预设）")
    print("  GET  /config    读取 narra_config.json")
    print("  GET  /demo      打开演示页（?auto=N 可自动问第 N 句，便于无人值守截图）")
    print("  POST /decide    单轮 NPC Tick：决策信号 → Policy Resolver → 行为候选")
    print("  POST /narrate   按选中的行为生成台词（LLM 或台词池；不传 behavior 会自动先 decide）")
    print("  POST /world     独立 World Tick（低频世界事件，不再混进 /decide）")
    print("  POST /reset     清空累积历史（dialogue history + decision_history）")
    print("  POST /predict   原始透传，直接调 Laya")
    print("\n演示页：%s/demo    （?auto=7 会触发门限/策略改写，最适合看那套机制）" % url)
    print("自检：qcheck 问题集预算 ｜ signaltest 决策方向回归 ｜ personatest 人格对照 ｜ bench 性能")
    print("按 Ctrl+C 停止。\n")

    if os.environ.get("OPEN_BROWSER") == "1":
        try:
            # 改成打开桥上的 /demo，不再用 file:// 直接开本地文件：
            # 本地文件是 opaque origin，跨源 fetch 到 127.0.0.1 的行为各浏览器不一致。
            subprocess.Popen(["cmd", "/c", "start", "", url + "/demo"], shell=False)
        except Exception as e:
            print("（自动打开页面失败：%r）" % e)

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        srv.server_close()


if __name__ == "__main__":
    sys.exit(main() or 0)
