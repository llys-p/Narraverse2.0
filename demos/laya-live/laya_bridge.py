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
import copy as _copy
import os
import re
import sys
import time
import math
import random
import inspect
import hashlib
import subprocess
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ★ P2-B1：Analyze/Commit 状态协议 v1 的存储与编排（独立小模块，不复制推理引擎）。
from laya_state_protocol import LayaStateProtocol, _ProtoError, MAX_BODY_BYTES

HERE = Path(__file__).resolve().parent
CFG_PATH = HERE / "narra_config.json"
DEMO_HTML = HERE / "laya-live-demo.html"
ENV_PATH = HERE / ".env"
# 这些是密钥：以 .env 为准，不让系统环境变量覆盖。
# 理由：本机用户级环境变量里存着一个**已失效**的 DEEPSEEK_API_KEY（尾号 d4f0），
# 若让系统优先，.env 里的有效 key 会被静默屏蔽，表现为 401 且报错只显示 d4f0，极难定位。
ENV_AUTHORITATIVE = ("DEEPSEEK_API_KEY", "LLM_API_KEY")
PORT = int(os.environ.get("LAYA_BRIDGE_PORT", "8130"))

# ★ Qoder 审查 M-1（2026-09-25）：引擎标识的**单一权威**字面量。
#   旧路由 legacy 门禁（engine_used）与 /decide、/world 的取值得共用这份常量，
#   避免「黑名单只挡一个拼写、改名即静默失效」的自证缺口。
ENGINE_MODE_LAYA = "laya"
ENGINE_MODE_FALLBACK = "fallback"


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
# ★ P1（2026-09-24）：模型目录可配置。worktree/新 checkout 默认没有 _models/，
#   本机模型可能放在别处（如外部运行副本的 _models）。LAYA_MODELS_DIR 显式指定后，
#   推理（find_local_models）与 checkpoint 校验（_checkpoint_fingerprint）用的是
#   **同一个**有效目录 —— 两处读不同目录 = 校验的是 A、跑的是 B，必须杜绝。
#   优先级与 LAYA_MODEL 一致：系统环境变量 > .env（见 load_env_file）。
MODELS_DIR = Path(os.environ.get("LAYA_MODELS_DIR") or (HERE / "_models"))
MODEL_NAMES = ("typed-decisions", "english", "multilingual")
DEFAULT_MODEL_NAME = os.environ.get("LAYA_MODEL", "typed-decisions")


def _checkpoint_candidates(model):
    """一个检查点的两种目录布局：`laya-<名>/` 或裸 `<名>/`。

    ★ 加载（find_local_models）与校验（_checkpoint_fingerprint）**必须共用**这份
      候选列表 —— 之前两者各写一份（加载器接受裸目录、指纹只查 laya- 前缀），
      造成「能加载但指纹报 exists=False」的永久失效组合（P1 审查 P2 项）。
      候选顺序即为优先级：laya-<名>/ 优先，与既有资产布局保持一致。
    """
    return (Path(MODELS_DIR) / ("laya-" + model), Path(MODELS_DIR) / model)


def find_local_models():
    """扫 _models/ 下已下好的检查点，返回 {router 名: 本地路径}。"""
    out = {}
    if not MODELS_DIR.is_dir():
        return out
    for n in MODEL_NAMES:
        for cand in _checkpoint_candidates(n):
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
        # ★★ P1 fail-closed（2026-09-24）：不再「退到已经有的那个」。
        #   旧逻辑在本地缺用户指定检查点时，会静默换成 sorted(local)[0] 继续跑 ——
        #   而能力档案是**按检查点**生成的（typed-decisions 可写 doubt_shift、
        #   english 可写 fondness_shift）。静默换检查点 = 拿另一套可写信号集
        #   冒充用户选择，状态层会按错误的档案写状态。宁可起不来，也不能装对。
        if want not in MODEL_NAMES:
            self.last_error = ("未知检查点名 %r（可选：%s）。拒绝加载任何检查点 —— "
                               "不能以默认检查点冒充用户选择。"
                               % (want, "、".join(MODEL_NAMES)))
            self.detail = "LAYA_MODEL 无效，fail-closed 不加载"
            self.load_ms = int((time.time() - t0) * 1000)
            return
        self.model_name = want
        if self.local_models and want not in self.local_models:
            self.last_error = ("模型目录 %s 里没有 %r 检查点（本地有：%s）。"
                               "可用 LAYA_MODELS_DIR 指定模型目录；拒绝退到其它检查点冒充。"
                               % (MODELS_DIR, want, "、".join(sorted(self.local_models)) or "无"))
            self.detail = "请求的检查点在模型目录缺失，fail-closed 不加载"
            self.load_ms = int((time.time() - t0) * 1000)
            return

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
            # ★ P1：兜底只加载**用户指定的**检查点。旧代码会退到硬编码的
            #   typed-decisions 或 repo 默认（english）—— 又一处「冒充用户选择」。
            #   指定名不合法时让 HF 明确报错，不换名重试。
            cands.append(("convaiinnovations/laya", self.model_name))
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

# ★ P2-B1：协议实例（注入 bridge 模块引用；锁/版本/候选/事件都在协议模块内）。
PROTOCOL = LayaStateProtocol(sys.modules[__name__])


def _finite_number(v):
    """JSON 数值须有限且非布尔（禁止 NaN/Infinity，布尔不当数字）。"""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v \
        and v not in (float("inf"), float("-inf"))


def _engine_identity():
    """协议引擎身份门禁用的只读身份：实际引擎是否就绪 + 实际加载的 checkpoint 名。

    ★ P1 审查（2026-09-25）：Analyze/Commit 都要求「引擎就绪且加载的检查点与
      所选档案一致」，不满足时协议层返回 503 MODEL_UNAVAILABLE。这是**身份门禁**，
      用于杜绝「Laya 未加载/降级到 fallback 时仍把启发式结果冒充真实判断提交」。
    """
    return {"ready": bool(getattr(ENGINE, "ready", False)),
            "model_name": getattr(ENGINE, "model_name", None),
            "detail": getattr(ENGINE, "detail", "")}

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
        if qid not in answers:
            continue
        v = answers[qid].get("_value")
        # ★ P1 审查（2026-09-25）：非有限数值（NaN/Infinity/布尔）在**映射前**就拒绝。
        #   旧行为会把 NaN 送进 _lerp_table：NaN 与所有阈值比较都为 False → 落入
        #   else 分支当「最大档」映射，产出一条看起来正常、实则由异常值驱动的
        #   最大增量提案 —— 这类值绝不能成为状态数值。布尔同样不当数字。
        if v is None or not _finite_number(v):
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


def _set_path(obj, path, value):
    """按 "relationship.trust" 这种点路径写值。中间层不存在则返回 False。

    ★ 刻意**不**自动造中间层：target 指向一个 Actor State 里本来没有的字段，
      是配置和状态结构对不上（该报出来），而不是该被静默补齐的东西。
      静默造字段会让「这个 signal 到底有没有接上」变得看不出来。
    """
    parts = path.split(".")
    cur = obj
    for part in parts[:-1]:
        if not isinstance(cur, dict) or part not in cur:
            return False
        cur = cur[part]
    if not isinstance(cur, dict) or parts[-1] not in cur:
        return False
    cur[parts[-1]] = value
    return True


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
    """prob（0~1 概率）还是 level（0~4 强度）。

    ★ 为什么不能只看 signals.meta：6 个 score 位移题（trust_shift / doubt_shift …）
      与 investigate 都是 level 型，但*_shift 那几个**不在** signals.meta 里
      （它们刻意不上信号面板，见 SHIFT_IDS 的注释）。
      只查 meta 会让它们退回默认 "prob"，于是拿 0~4 的值去和 0.5 比大小 ——
      判据整个错掉，而且错得很安静。
    """
    k = (_signal_meta().get(name) or {}).get("kind")
    if k:
        return k
    if name == "investigate" or name.endswith("_shift"):
        return "level"
    return "prob"


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


def _why_text(reasons):
    """把 reasons 压成一句人能读的话。

    ★ 为什么必须有这个函数（实测踩到，2026-09-23）：
      reasons 有**三种形状**混在一起 ——
        · {why: "...", signals: [...]}   规则命中 / 歧义判据
        · "纯文本"                       旧版遗留
        · [[k, v], ...]                  嵌套明细
      而 assess_ambiguity() 返回的是一个**字典列表**（不是字符串列表）。
      直接 `"；".join(ambiguity_reasons)` 会在歧义轮次抛
      `TypeError: sequence item 0: expected str instance, dict found`
      —— 也就是说：**越该进歧义分支的时候越会崩**，正常轮次反而看不出来。
    """
    out = []
    for r in reasons or []:
        if isinstance(r, dict):
            out.append(str(r.get("why") or ""))
        elif isinstance(r, (list, tuple)):
            out.append(_why_text(r))
        else:
            out.append(str(r))
    return "；".join([x for x in out if x])


def policy_resolve(values, choice_baseline):
    """Decision Signals → Behavior Candidate，输出必须可审计。

    返回：behavior / source / reasons / choice_baseline / confidence_level / fallback
    source ∈ {"policy", "choice_baseline", "ambiguous"}

    求值顺序（★ 改动过，别改回去）：
        1. policy.enabled=false      → 一律回落 choice baseline
        2. 逐条规则 {when: 阈值合取} → 命中即 source=policy
        3. 无规则命中且判为歧义       → source=ambiguous，**behavior=None**，
                                       fallback=story_agent —— 真的不选，交上游
        4. 其余                       → source=choice_baseline

    ★ Phase3-Task1（2026-09-23）：第 3 条以前返回的是 choice_baseline，
      只额外标了个 fallback=story_agent。而 /narrate 与前端都只认 behavior，
      于是「交回上游」在实现上不成立 —— 歧义轮次照样产出具体行为并生成台词。
      现在 behavior 为 None，`decision.behavior` 就是 null，上游必须自己决定。
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
        return {"behavior": None, "source": "ambiguous",
                "reasons": amb_reasons, "choice_baseline": choice_baseline,
                "confidence_level": level, "ambiguity_reasons": amb_reasons,
                "fallback": "story_agent",
                # ★ 把「候选但未采纳」显式写出来，免得下游把 choice_baseline 字段误当成结果
                "note": ("判为歧义 → 不选行为（behavior=null），交 Story/Director。"
                         "choice_baseline 只是审计信息，**未被采纳**，也不得写入 Decision History。")}

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


def _build_narrate_prompt(actor, behavior, player_input, history, state_line, strict=False,
                          proactive=False, signals_block=None, scene=None):
    """构造叙事提示词。

    ★ P3-A：`proactive=True` 时进入**分析模式规则分支**（允许自然追问/表态/有限线索/
      话题转换，但不强制每轮提问，且不把信号当已发生事实）；legacy 分支（proactive
      默认 False）的规则与旧语义完全不变。`signals_block`/`scene` 是 analysis 模式的
      分块注入（参考信号 + 场景提示），供 DeepSeek 校准语气而非改写数值。
    """
    if proactive:
        # ---- P3-A analysis 模式规则分支 ----
        state_note = ("当前已提交数值（权威，只用于校准语气，不要在文本里念数字）：%s"
                      % state_line)
        scene_note = ("场景提示（本轮参考，不是已发生的场景切换）：%s" % scene) if scene else ""
        sig_note = (signals_block
                    + "\n（以上仅供调整语气与试探策略：这些信号是「角色此刻的感受倾向」"
                      "参考，**不是**已发生的事实；不得据此泄露秘密、修改数值或替玩家做决定。）"
                    if signals_block else "")
        sys_p = (
            "你在为一款文字冒险游戏写 NPC 的回应（分析模式）。\n"
            "角色：%s，%s。\n"
            "人物与场景补充：%s\n"
            "%s\n"
            "%s\n"
            "%s\n"
            "规则：\n"
            "1) 台词用「」包裹，配少量动作或环境描写，2~4 句，不要分段列点。\n"
            "2) 只写外部可见的言行。\n"
            "3) 你可以自然追问、表达立场、透露有限线索或转换话题；"
            "**不要求每轮都提问**，也不要强行推进剧情。\n"
            "4) 你只调整语气与试探策略：状态数值和参考信号是「角色此刻的感受倾向」，"
            "**不是已发生的事实**；不得据此泄露秘密、修改数值或替玩家决定。\n"
            "5) 用中文。\n"
            "格式（必须遵守）：把最终回应原文放进 <line> 与 </line> 之间。\n"
            "这两个标签之外**一个字符都不要写**。"
        ) % (actor.get("name", "NPC"), actor.get("identity", ""),
             json.dumps({k: actor.get(k) for k in ("personality", "traits", "situation", "goals")},
                        ensure_ascii=False),
             state_note, scene_note, sig_note)
        convo = "\n".join(
            "%s：%s" % ("玩家" if h.get("role") in ("player", "user")
                       else actor.get("name", "NPC"),
                       h.get("content") if h.get("content") is not None else h.get("text", ""))
            for h in (history or [])[-8:])
        user_p = (convo + "\n玩家：%s\n\n请写出她此刻的回应。" % player_input).strip()
        return sys_p, user_p

    behavior_note = (
        "本轮她决定做出的行为是「%s」（%s）。\n表现要求：%s"
        % (behavior["name"], behavior["desc"], behavior.get("instr", ""))
        if behavior else
        "Laya 本轮判断不明确，没有选定行为。请由你根据人物设定、对话历史和玩家原话，"
        "选择合适的回应方式并自然续写。不要把不确定判断当成事实，不强行透露秘密或推进重大剧情。"
        "你只生成角色回应，不修改或宣称已提交任何属性数值。\n人物与场景补充："
        + json.dumps({k: actor.get(k) for k in ("personality", "traits", "situation", "goals")},
                     ensure_ascii=False)
    )
    sys_p = (
        "你在为一款文字冒险游戏写 NPC 的回应。\n"
        "角色：%s，%s。\n"
        "%s\n"
        "当前关系与情绪：%s\n"
        "规则：\n"
        "1) 台词用「」包裹，配少量动作或环境描写，2~4 句，不要分段列点。\n"
        "2) 只写外部可见的言行。\n"
        "3) 不替玩家说话、不替玩家做决定、不在结尾提问引导选项。\n"
        "4) 用中文。\n"
        "格式（必须遵守）：把最终回应原文放进 <line> 与 </line> 之间。\n"
        "这两个标签之外**一个字符都不要写** —— 不要复述上面的规则、不要写你的思路或提纲、"
        "不要解释你为什么这么写。直接开始写她的言行。"
    ) % (actor.get("name", "NPC"), actor.get("identity", ""), behavior_note, state_line)
    convo = "\n".join(
        "%s：%s" % ("玩家" if h.get("role") in ("player", "user")
                   else actor.get("name", "NPC"),
                   h.get("content") if h.get("content") is not None else h.get("text", ""))
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


def llm_narrate(actor, behavior, player_input, history, state_line, include_reasoning=False,
                proactive=False, signals_block=None, scene=None):
    """调用 LLM 生成台词。
    ★ P3-A：proactive/signals_block/scene 透传给 _build_narrate_prompt（analysis 模式）。
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
                                              state_line, strict=strict,
                                              proactive=proactive,
                                              signals_block=signals_block, scene=scene)
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

# ★★ fail-closed 开关（2026-09-24，用户明确要求）。
#   历史行为是「翻译失败 → **原样返回中文** → 标 src='none' 继续跑」。那是一个
#   **静默**失效：中文进的是英文校准的 ModernBERT（README 基准：非拉丁脚本
#   0.952 置信 / 0.000 准确）→ 高置信 + 零准确，API 返回里毫无迹象。
#   实测 2026-09-24 撞到过：key 失效时表现为「首次调用成功、随后失败」，
#   随机且间歇，看起来像「模型今天不稳定」，实际输入早已是中文。
#   ⇒ 默认改为 **fail-closed**：拿不到英文就明确报失败，由调用方**停在这一轮**，
#     绝不用中文冒充英文继续算。
#   为什么留开关而不是直接删掉旧行为：旧路径是 §16 / §19 那批历史实验的**执行条件**，
#   重跑旧实验需要能复现它。开关默认关闭 fail-open，**只用于复现实验，不用于正常玩**。
XLATE_FAIL_CLOSED = os.environ.get("LAYA_XLATE_FAIL_OPEN", "0") not in ("1", "true", "yes")


class TranslationFailure(Exception):
    """翻译失败。调用方**必须**据此中止本轮，不得回退中文原文。"""

    def __init__(self, reason, text=""):
        self.reason = reason
        self.text = text
        super().__init__("translation failed: %s" % reason)


def translate_to_en(text):
    """把玩家台词翻成英文。返回 (英文, 来源)。

    ★ 失败时**抛 TranslationFailure**（fail-closed），不再返回中文原文。
      返回 (None, "none") 这种「带毒的成功」是本案的原始 bug，已移除。
      如果确实要复现历史实验条件，显式设 `LAYA_XLATE_FAIL_OPEN=1`。

    ★ 2026-09-25（P3-B 体验回归）：max_tokens 1600→8000。
      实测（deepseek-flash，P2 面板 /analyze）：翻译请求的推理 token 高达
      r=6553，finish=length、content 空 → fail-closed 502。这与 2026-09-24
      的「reasoning 吃光预算」同源（当时 600→1600）；当前模型推理更重，
      预算必须留足。这是对真实可复现缺陷的配置修复，不是凑参数。
    """
    if not text:
        return "", "empty"
    if text in _XLATE_CACHE:
        return _XLATE_CACHE[text], "cache"
    key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("LLM_API_KEY")
    if not key:
        if XLATE_FAIL_CLOSED:
            raise TranslationFailure("no_api_key", text)
        return text, "none"
    base = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com").rstrip("/")
    payload = {
        "model": os.environ.get("LLM_MODEL", "deepseek-flash"),
        "messages": [
            # ★★ 2026-09-24 修：提示词必须**明确禁止解释**，且 max_tokens 要留出推理余量。
            #   实测踩到：`灰鸦手上有块旧疤，是从左边脸颊一直划到下巴的。` 这句
            #   原文本身自相矛盾（「手上」的疤却「从脸颊划到下巴」），模型于是
            #   在 **reasoning_content** 里反复纠结这个矛盾，reasoning 吃掉 1896 token、
            #   `finish_reason=length`、**content 为空串** → 表现为翻译失败。
            #   而旧提示词只说 "Output only the translation"，没禁止「先想再答」，
            #   600 token 的预算对「会引发纠结的句子」根本不够。
            #   两个修法缺一不可：
            #     ① 提示词显式要求「原文矛盾也照译，不要解释」→ 减少无谓推理；
            #     ② max_tokens 600 → 1600 → 给推理留余量，而不是和输出抢 token。
            #   注意这**不是**「调参凑测试过」：它修的是一个真实的、可复现的
            #   「长句/怪句必失败」缺陷 —— 修复前 263 条里有 2 条**稳定**失败，
            #   且失败与句子长度/矛盾程度相关，与内容好坏无关。
            #   ★★ 2026-09-25：推理进一步加重（r=6553），1600 仍会被吃光 → 8000。
            {"role": "system", "content": "You are a translation engine. Translate the user's "
                                          "Chinese game-dialogue line into English. Output ONLY "
                                          "the English translation, nothing else. Do not explain, "
                                          "do not comment, do not add notes, even if the source "
                                          "line seems contradictory or odd - just translate it literally. "
                                          "Do not think out loud; answer directly."},
            {"role": "user", "content": text},
        ],
        "temperature": 0.0, "max_tokens": 8000, "stream": False, "effort": "low",
    }
    err = "empty_response"
    try:
        req = urllib.request.Request(
            base + "/chat/completions", data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + key}, method="POST")
        with urllib.request.urlopen(req, timeout=60) as r:
            j = json.loads(r.read().decode("utf-8"))
        _ch = (j.get("choices") or [{}])[0]
        _msg = _ch.get("message") or {}
        out = (_msg.get("content") or "").strip()
        if out:
            if len(_XLATE_CACHE) > 300:
                _XLATE_CACHE.clear()
            _XLATE_CACHE[text] = out
            return out, "llm"
        # ★★ 空 content 要**区分原因**，不能都记成 "empty_response"：
        #   `finish_reason=length` 表示 token 预算被 reasoning 吃光（可修：调大 max_tokens
        #   或收紧提示词）；`finish_reason=stop` 才是真的「模型什么都没说」。
        #   不区分的话，一个**可复现的配置 bug** 会伪装成「偶发性空响应」，
        #   于是被当成网络抖动放过去 —— 2026-09-24 就是这个坑，
        #   2 条台词稳定失败了很多轮才被定位到 finish_reason。
        _fr = _ch.get("finish_reason")
        _rc_len = len(_msg.get("reasoning_content") or "")
        err = ("length_budget_exhausted(r=%d)" % _rc_len) if _fr == "length" else \
              ("empty_response(finish=%s,r=%d)" % (_fr, _rc_len))
    except urllib.error.HTTPError as e:
        # ★ 只记状态码，**不记** key/尾号/响应体（凭证不进日志、不进提交）
        err = "http_%s" % getattr(e, "code", "?")
    except Exception as e:
        err = "exc_%s" % type(e).__name__
    if XLATE_FAIL_CLOSED:
        if os.environ.get("LAYA_TRACE"):
            sys.stderr.write("[xlate-trace] translate_to_en fail-closed err=%s\n" % err)
        raise TranslationFailure(err, text)
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
# ★ 已删除：`_DECISION_HISTORY`（进程级全局滚动窗口）。
#   它让两个 NPC / 两个冒险 / 两个浏览器会话共用同一条历史，且完全静默。
#   实测复现：同一句台词在 live（HTTP 层累加）与 CLI 直调（不累加）下行为不同。
#   替代品见下面 §7.5 的 _HISTORY_BUCKETS（按 (session_id, actor_id) 分桶 + 提交门控）。
#   如果哪里还引用到 _DECISION_HISTORY，那是漏改 —— 会直接 NameError，不静默。

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


# ==========================================================================
# 决策历史：按 (session_id, actor_id) 分桶 + 提交门控
# ==========================================================================
# 为什么必须改（Phase3-Task2/Task3，2026-09-23）：
#   旧实现是 `_DECISION_HISTORY = []` 一个进程级全局列表 ——
#   两个 NPC、两个冒险、两个浏览器会话共用同一条历史。实测已复现：
#   同一句台词在 live（HTTP 层累加历史）与 CLI 直调（不累加）下得到不同行为。
#   多角色场景下，B 的 state_doc 里会出现 A 的历史，而这是**静默**的。
#
# 三道门（Task3）：
#   proposed  —— /decide 产出，只登记在 _PENDING，**不进历史**
#   accepted  —— 上游（本 Demo 里是 Story Agent 真的写出台词）确认可用
#   committed —— /commit 明确提交，**只有这一步才写进桶**
#   ambiguous / behavior=null 的轮次**永远无法提交**：没有行为就没有可确认的事实。
_HISTORY_BUCKETS = {}      # (session_id, actor_id) -> [{"type","summary"}, ...]
_HISTORY_MAX = 12          # 每桶保留条数（每轮 2 条：player_* + npc_*）
_TURN_SEQ = {}             # (session_id, actor_id) -> 已发号数
_PENDING = {}              # turn_id -> {"session","actor","behavior","intent","entries","decision_source"}


def bucket_key(session_id, actor_id):
    return (str(session_id or "default"), str(actor_id or "default"))


def _legacy_scope(session_id, actor_id, actor=None):
    """归一 legacy (session, actor)，并返回 (scope, actor_name)。"""
    sid = str(session_id or "default")
    aid = str(actor_id or (actor or {}).get("name") or "default")
    return (sid, aid), aid


def history_for(session_id, actor_id):
    """取某个 (session, actor) 已提交的历史（副本）。"""
    return list(_HISTORY_BUCKETS.get(bucket_key(session_id, actor_id), []))


def next_turn_id(session_id, actor_id):
    k = bucket_key(session_id, actor_id)
    _TURN_SEQ[k] = _TURN_SEQ.get(k, 0) + 1
    return "%s/%s#%d" % (k[0], k[1], _TURN_SEQ[k])


def propose_turn(turn_id, session_id, actor_id, behavior_id, intent_id, source,
                 state_proposal=None, state_decision=None, actor=None, record_history=True,
                 engine_used=None, frozen_state=None, frozen_version=None):
    """登记一个待确认的决策和状态 Proposal。**不写历史、不写 Actor State**。

    ★ P2-B2：登记在**协议锁内**完成，并绑定作用域状态版本与规则指纹 ——
      旧 `/commit {turn_id}` 提交时用同一锁校验「当前版本 == 登记版本」，
      使旧/新提交共用同一版本体系（§6.3 / §9 L1）。

    ★ 闭环审查（2026-09-25）：登记时把**版本**与**冻结快照**原子绑在一起：
      - `engine_used="fallback"` 的候选（真实推理失败落到启发式）在提交时被拒，
        不再把启发式结果冒充模型判断写入；
      - `frozen_state` 由调用方在锁内捕获的服务器快照提供；无则登记时回读桶，
        保证「分析用的状态」与「提交校验用的状态」是同一份。
    """
    session_id = str(session_id or "default")
    actor_id = str(actor_id or "default")
    scope = (session_id, actor_id)
    with PROTOCOL.lock:
        base_ver = frozen_version if frozen_version is not None else PROTOCOL.state_version(scope)
        # ★ 推理期间已发生提交/Reset → 登记版本已过时：直接拒绝登记，避免旧计算
        #   冒用新版本。让调用方重新跑一轮（decide 会用到这份版本重填）。
        if frozen_version is not None and base_ver != PROTOCOL.state_version(scope):
            _PENDING.pop(turn_id, None)
            raise _ProtoError(409, "STATE_VERSION_CONFLICT",
                              "本轮分析期间状态版本已变化（推理窗口内发生 Reset/Commit），"
                              "拒绝登记旧计算；请重发",
                              {"frozen_version": frozen_version,
                               "current_state_version": PROTOCOL.state_version(scope)})
        rules = PROTOCOL.rules_fingerprint(PROTOCOL._effective_model(), force=False)
        if frozen_state is None:
            frozen_state = actor_state_snapshot(session_id, actor_id,
                                                actor=actor or CFG.get("actor"))
        _PENDING[turn_id] = {
            "session": session_id, "actor": actor_id,
            "behavior": behavior_id, "intent": intent_id, "source": source,
            "entries": decision_history_entries(intent_id, behavior_id) if record_history else [],
            "state_proposal": _copy.deepcopy(state_proposal or {}),
            "state_decision": _copy.deepcopy(state_decision or {}),
            "actor_template": _copy.deepcopy(actor) if actor else None,
            "base_state_version": base_ver,
            "rules_fingerprint": rules,
            "engine_used": engine_used,
            "frozen_state": _copy.deepcopy(frozen_state),
        }
        # 防止长跑进程里 _PENDING 无限增长（未提交的轮次不该被记住）
        if len(_PENDING) > 200:
            for k in list(_PENDING)[:100]:
                _PENDING.pop(k, None)
    return _PENDING[turn_id]


def commit_turn(turn_id):
    """显式提交某轮的状态 Proposal 与历史。返回 (ok, note, state_result)。

    ★ P2-B2：委托给协议层 `commit_legacy_turn` —— 与新的 `/commit_state`
      共用同一进程锁与版本体系（版本检查、规则复核、历史/状态/版本同锁发布）。
    """
    return PROTOCOL.commit_legacy_turn(turn_id)


# ============================================================================
# ★★ Phase3-P3：Actor State 存储 + State Transition
#    （第一阶段：闭环；第二阶段：中性死区 + 多关系维度）
# ============================================================================
# 为什么必须有这一段：P2 之前整条链路是**无状态**的 —— /decide 从 payload 里读
# actor，算完给一份 state_proposal，然后**忘掉**。下一轮又是原来的 relationship.trust。
# 于是「连续交互让关系变化」在架构上根本不可能发生，跟模型好坏无关。
# 这一段只补一件事：让 state_shift 的 proposal 真的能落到下一轮的输入里。
#
# 固定链路（第二版，加了一步死区）：
#     proposal → deadzone → per_turn clamp → range clamp → commit
#
# 四个刻意的设计约束：
#   1) 范围**复用** state_shift.paths.*.range，不新建第二套格式。
#      relationship.trust 就是 0~100，不另起一套 0~1。
#   2) 单轮上限**不是**分数上限。range 0~100 的字段单轮最多走 ±12，
#      所以「一句话就把关系打满/打到底」在结构上不可能 —— 这是体验的自然感来源。
#   3) 只有 active 能写。auxiliary 依然只登记不写；ambiguous / awaiting_upstream 不 commit。
#      P2 已经把「谁能写」交给能力档案裁决，P3 只是尊重那个裁决，不在这里重新定级。
#   4) 中性死区只**部分**缓解「闲聊也在改关系」。这是实测结论不是设计选择：
#      中性句与有意义句的 delta 在数值上高度重叠，任何阈值都无法真正分开它们。
#      详见报告 §20.2。不要指望调大它能「修好」——调大会先吃掉真实关系变化。

_ACTOR_STATE = {}       # (session_id, actor_id) -> {"relationship": {...}, "emotion": {...}, "goals": {...}}
_STATE_TRACE = {}       # (session_id, actor_id) -> [ 每轮 commit 的审计记录 ]
_STATE_TRACE_MAX = 30


def _blank_actor_state(actor):
    """从 actor 模板抽出「会被状态层改写」的那几组字段。深拷贝，绝不共享引用。"""
    a = actor or CFG.get("actor") or {}
    return {
        "name": a.get("name"), "name_en": a.get("name_en"),
        "relationship": _copy.deepcopy(a.get("relationship") or {}),
        "emotion": _copy.deepcopy(a.get("emotion") or {}),
        "goals": _copy.deepcopy(a.get("goals") or {}),
        "traits": _copy.deepcopy(a.get("traits") or {}),
    }


def actor_state_for(session_id, actor_id, actor=None, create=True):
    """取某桶的 Actor State。不存在且 create=True 时，用 actor 模板初始化。

    ★ 键与 history 完全一致（session_id, actor_id）—— 两者必须同桶，
      否则「历史属于 A、状态属于 B」这种串线在架构上就成立了。
    """
    k = bucket_key(session_id, actor_id)
    st = _ACTOR_STATE.get(k)
    if st is None and create:
        st = _blank_actor_state(actor)
        st["_created_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        _ACTOR_STATE[k] = st
    return st


def actor_state_snapshot(session_id, actor_id, actor=None):
    """返回 Actor State 的深拷贝；桶不存在时只构造默认值，不写入全局状态。"""
    st = _ACTOR_STATE.get(bucket_key(session_id, actor_id))
    return _copy.deepcopy(st if st is not None else _blank_actor_state(actor))


def actor_state_view(session_id, actor_id):
    """给前端/测试看的只读快照（含本轮之后的取值）。"""
    k = bucket_key(session_id, actor_id)
    st = _ACTOR_STATE.get(k)
    return {"bucket": "%s/%s" % k, "exists": st is not None,
            "state": _copy.deepcopy(st), "trace": _copy.deepcopy(_STATE_TRACE.get(k, []))}


def actor_state_analysis_view(session_id, actor_id, actor=None):
    """纯分析使用的当前状态视图；不会因为读取而创建 Actor State 桶。"""
    k = bucket_key(session_id, actor_id)
    return {"bucket": "%s/%s" % k, "exists": k in _ACTOR_STATE,
            "state": actor_state_snapshot(session_id, actor_id, actor),
            "trace": _copy.deepcopy(_STATE_TRACE.get(k, []))}


def _transition_cfg():
    t = (CFG.get("state_shift") or {}).get("transition") or {}
    return t


def _deadzone_cfg():
    """中性死区配置。缺段 = 全部为 0（即不启用死区），不报错。"""
    dz = _transition_cfg().get("deadzone") or {}
    return {k: float(v) for k, v in dz.items() if not str(k).startswith("_") and isinstance(v, (int, float))}


def deadzone_of(signal):
    """该 signal 的死区阈值（绝对值）。找不到就取 default，再找不到就是 0。"""
    dz = _deadzone_cfg()
    v = dz.get(signal, dz.get("default", 0.0))
    return max(0.0, float(v))


def _apply_deadzone(delta, thr):
    """|delta| < thr → 0；否则原样返回。

    ★ 刻意只做「归零」，不做柔性衰减。
      理由是可审计性：柔性衰减会引入一个「缩小了多少」的中间量，
      而它无法用一句话说明白（见报告 §20.2 的取舍）。归零的话
      after_deadzone 只可能是 proposal 或 0，调试时一眼就知道死区有没有生效。
    """
    if thr <= 0:
        return float(delta), False
    if abs(float(delta)) < thr:
        return 0.0, True
    return float(delta), False


def state_transition(signal, proposal_delta, current_value, allowed=True):
    """Phase3-P3 State Transition（第二版：加入中性死区）。

    链路固定为：
        proposal → deadzone → per_turn clamp → range clamp → commit

    输入：
      signal          —— 如 "trust_shift"（key 必须存在于 state_shift.paths）
      proposal_delta  —— Laya 算出的原始增量（build_deltas 的产物）
      current_value   —— 该 target 当前值
      allowed         —— 前置准入（status==active / 不是 ambiguous / 不是 awaiting_upstream）

    返回一份**完整可审计**的裁决，字段固定为：
        old / proposal / after_deadzone / final_delta / new_value
    外加 clamped_by / range / per_turn / deadzone / skipped_reason，方便调试。

    ★ 顺序很重要：先按单轮上限截 proposal，再按合法区间截结果值。
      反过来做会得到一个「区间内合法、但本轮变化超过单轮上限」的 new_value，
      即漏掉单轮限制。这两种顺序在信任已接近 100 时才看得出差别，
      但正是那种情况最容易出现「最后一句话把关系推满」的跳变。
    """
    t = _transition_cfg()
    paths = (CFG.get("state_shift") or {}).get("paths") or {}
    p = paths.get(signal) or {}
    rng = p.get("range")
    target = p.get("target")
    label = p.get("label") or signal
    dz_thr = deadzone_of(signal)
    out = {
        "signal": signal, "target": target, "label": label,
        "old": current_value, "proposal": proposal_delta,
        "after_deadzone": None, "final_delta": 0.0, "new_value": current_value,
        "range": list(rng) if rng else None,
        "deadzone": {"threshold": dz_thr, "applied": False},
        "committed": False, "skipped_reason": None, "clamped_by": [],
    }
    if not t or not t.get("enabled", True):
        out["skipped_reason"] = "state_shift.transition 未启用（配置里 enabled=false 或缺段）"
        return out
    if not rng:
        out["skipped_reason"] = ("state_shift.paths.%s 没有 range —— 没有合法区间的字段不许写状态"
                                 "（宁可不动，也不猜一个范围）" % signal)
        return out
    if not allowed:
        out["skipped_reason"] = "前置准入未通过（status 非 active / 歧义 / 等上游）"
        return out
    if current_value is None:
        out["skipped_reason"] = ("Actor State 里 %s 没有当前值 —— 不猜初值"
                                 % target)
        return out
    if proposal_delta is None:
        out["skipped_reason"] = "本轮没有拿到该 signal 的数值（未出值或未达 active）"
        return out
    # ★ P1 审查（2026-09-25）：核心状态公式也拒绝非有限数值（老/新路径共用本函数，
    #   双层兜底：build_deltas 映射前 + 这里提交/预演前）。NaN 会在 range clamp
    #   阶段产生 NaN 新值并写入 Actor State —— 那是最难查的一类污染。
    if not _finite_number(proposal_delta) or not _finite_number(current_value):
        out["skipped_reason"] = "数值非有限（NaN/Infinity/布尔），拒绝写入"
        return out

    lo_max = (t.get("per_turn_max") or {}).get(signal,
             (t.get("per_turn_max") or {}).get("default"))
    lo_min = (t.get("per_turn_min") or {}).get(signal,
             (t.get("per_turn_min") or {}).get("default"))
    if lo_max is None or lo_min is None:
        out["skipped_reason"] = "transition 配置缺 per_turn_max / per_turn_min（含 default）"
        return out
    if lo_min > lo_max:
        out["skipped_reason"] = "per_turn_min(%s) > per_turn_max(%s)，配置自相矛盾" % (lo_min, lo_max)
        return out

    # ① 中性死区：先于任何 clamp，作用在最终 proposal delta 上
    d, dz_hit = _apply_deadzone(proposal_delta, dz_thr)
    out["after_deadzone"] = d
    out["deadzone"]["applied"] = dz_hit
    if dz_hit:
        out["clamped_by"].append("deadzone:%s" % dz_thr)
    # ② 单轮上限
    capped = min(max(d, float(lo_min)), float(lo_max))
    if abs(capped - d) > 1e-9:
        out["clamped_by"].append("per_turn:%s~%s" % (lo_min, lo_max))
    # ③ 合法区间（在**结果值**上截，不是在增量上）
    new = float(current_value) + capped
    final_new = min(max(new, float(rng[0])), float(rng[1]))
    if abs(final_new - new) > 1e-9:
        out["clamped_by"].append("range:%s~%s" % (rng[0], rng[1]))
    out["final_delta"] = round(final_new - float(current_value), 6)
    out["new_value"] = round(final_new, 6)
    out["committed"] = True
    out["skipped_reason"] = None
    out["per_turn"] = {"min": lo_min, "max": lo_max}
    return out



def validate_state_delta(session_id, actor_id, state_proposal, decision, actor=None,
                         frozen_state=None):
    """纯校验 state proposal；返回可提交项、跳过项和提交后的预览，不写全局状态。

    ★ P2-B1（2026-09-25）：`frozen_state` 由**协议层在锁内捕获的服务器快照**提供
      （不接受客户端）。提供时不再读桶，避免「外层验版本、内层又读另一份状态」
      的竞态 —— 协议层先固定快照与版本，再在快照上完成分析/校验，发布前复核。
    """
    t = _transition_cfg()
    if frozen_state is not None:
        st = _copy.deepcopy(frozen_state)
    else:
        st = actor_state_snapshot(session_id, actor_id, actor)
    validated, skipped = [], []

    upstream = None
    if decision:
        if decision.get("behavior_is_null"):
            upstream = "behavior_is_null" if decision.get("awaiting_upstream") else "behavior_is_null"
        elif decision.get("awaiting_upstream"):
            upstream = "awaiting_upstream"

    if upstream:
        for d in (state_proposal or {}).get("delta") or []:
            skipped.append({
                "source_signal": d.get("source_signal"), "target": d.get("target"),
                "proposal": d.get("delta"), "old": _dig(st, d.get("target")),
                "final_delta": 0.0, "new_value": _dig(st, d.get("target")),
                "committed": False,
                "skipped_reason": ("本轮 %s（歧义 / 未给行为）→ 不 commit 状态。"
                                   "事实认定权在上游，状态层不抢跑。" % upstream),
            })
        return validated, skipped, {"state": st, "would_change": False}

    for d in (state_proposal or {}).get("delta") or []:
        sig = d.get("source_signal")
        stt = d.get("status")
        allowed = stt in (t.get("write_status") or ["active"])
        if not allowed:
            skipped.append({"source_signal": sig, "target": d.get("target"),
                            "proposal": d.get("delta"), "old": _dig(st, d.get("target")),
                            "final_delta": 0.0, "new_value": _dig(st, d.get("target")),
                            "committed": False,
                            "skipped_reason": "status=%s 不在 write_status=%s 里"
                                              % (stt, t.get("write_status"))})
            continue
        # ★ P1 审查（2026-09-25）：校验层显式拒绝非有限数值，避免异常值进入
        #   状态公式（state_transition 亦有守卫，这里是语义更清晰的提前标注）。
        if not _finite_number(d.get("delta")):
            skipped.append({"source_signal": sig, "target": d.get("target"),
                            "proposal": d.get("delta"), "old": _dig(st, d.get("target")),
                            "final_delta": 0.0, "new_value": _dig(st, d.get("target")),
                            "committed": False,
                            "skipped_reason": "delta 非有限（NaN/Infinity/布尔），拒绝写入"})
            continue
        r = state_transition(sig, d.get("delta"), _dig(st, d.get("target")), allowed=True)
        r.update(grade=d.get("grade"), status=stt, role=d.get("role"),
                 attribute=d.get("attribute"), checkpoint=d.get("checkpoint"))
        # ★ 规则层裁决标记随 delta 透传（前端可视化「为何这个值变/回落」）
        if d.get("rule_adjudicated"):
            r["rule_adjudicated"] = d["rule_adjudicated"]
        if r["committed"]:
            _set_path(st, d.get("target"), r["new_value"])
            r.update(validated=True, committed=False)
            validated.append(r)
        else:
            skipped.append(dict(r, proposal=d.get("delta")))
    return validated, skipped, {"state": st, "would_change": bool(validated)}


def commit_state(session_id, actor_id, state_proposal, decision, actor=None):
    """校验并提交一份 state proposal；运行时 delta 的唯一写入入口（初始化/重置另计）。"""
    commits, skipped, _preview = validate_state_delta(
        session_id, actor_id, state_proposal, decision, actor=actor)
    if not commits:
        return commits, skipped, actor_state_view(session_id, actor_id)

    st = actor_state_for(session_id, actor_id, actor)
    k = bucket_key(session_id, actor_id)
    for r in commits:
        _set_path(st, r.get("target"), r.get("new_value"))
        r["committed"] = True

    if commits:
        tr = _STATE_TRACE.setdefault(k, [])
        tr.append({"t": time.time(),
                   "turn_id": (decision or {}).get("turn_id"),
                   "n": len(commits), "commits": commits})
        del tr[:-_STATE_TRACE_MAX]
    return commits, skipped, actor_state_view(session_id, actor_id)


def apply_state_transition(session_id, actor_id, state_proposal, decision, actor=None):
    """兼容旧调用名；实际写入统一委托给 commit_state。"""
    return commit_state(session_id, actor_id, state_proposal, decision, actor=actor)


def reset_actor_state(session_id=None, actor_id=None):
    """清 Actor State（与 reset_history 同样的三个参数语义）。"""
    hit = []
    for k in list(_ACTOR_STATE):
        if session_id is not None and k[0] != str(session_id):
            continue
        if actor_id is not None and k[1] != str(actor_id):
            continue
        _ACTOR_STATE.pop(k, None)
        _STATE_TRACE.pop(k, None)
        hit.append("%s/%s" % k)
    return hit


def reset_history(session_id=None, actor_id=None):
    """清历史。三个参数都不给 = 全清；给 session = 清该 session 下所有 actor。"""
    hit = []
    for k in list(_HISTORY_BUCKETS):
        if session_id is not None and k[0] != str(session_id):
            continue
        if actor_id is not None and k[1] != str(actor_id):
            continue
        _HISTORY_BUCKETS.pop(k, None)
        hit.append("%s/%s" % k)
    for k in list(_TURN_SEQ):
        if (session_id is None or k[0] == str(session_id)) and (actor_id is None or k[1] == str(actor_id)):
            _TURN_SEQ.pop(k, None)
    for tid, p in list(_PENDING.items()):
        if (session_id is None or p["session"] == str(session_id)) and \
           (actor_id is None or p["actor"] == str(actor_id)):
            _PENDING.pop(tid, None)
    # 注意：不在这里清 `_HISTORY`（HTTP 层的人读展示日志）。那是展示用滚动窗口，
    # 跟 Laya 读的历史是两码事 —— 混在一起清，会出现「桶清了但展示还在」的假象。
    return hit


def analyze_core(payload, turn_id=None, frozen_state=None):
    """运行 Laya 判断并生成 Proposal；只读 Actor State，不提交任何状态变化。

    ★ P2-B1（2026-09-25）：`frozen_state` 由协议层在锁内捕获（服务器内部，不接受
      客户端快照伪装）。提供时跳过读桶，直接用冻结快照合并进本轮 actor 与校验，
      保证「分析用的状态」与「对外承诺的基础版本」是同一份。
    """
    actor = payload.get("actor") or CFG["actor"]
    history = payload.get("history") or []
    # ★ 历史分桶键（Phase3-Task2）：不传就退到 "default"，但会**报出来**，
    #   不让调用方以为自己在用隔离的历史。
    session_id = payload.get("session_id") or "default"
    actor_id = str(payload.get("actor_id") or (actor or {}).get("name") or "default")
    turn_id = turn_id or "%s/%s#analysis" % (session_id, actor_id)
    # ★★ Phase3-P3：Actor State 就是**按同一个桶**取的当前人物状态。
    #   传了 actor 就说明调用方要显式指定这一轮的模板 —— 此时状态以传入的 actor 为准
    #   （多 NPC 演示就是这么用的：同一 session 下给不同 actor 对象）。
    #   没传 actor 就说明调用方想走**连续剧情**：从桶里取上一轮 commit 之后的状态。
    #   这两条路径必须写清楚，否则「为什么我的状态没变化」会变成一个谜。
    if frozen_state is not None:
        _st = _copy.deepcopy(frozen_state)
    elif payload.get("actor"):
        _st = actor_state_snapshot(session_id, actor_id, actor)
    else:
        _st = actor_state_snapshot(session_id, actor_id, CFG.get("actor"))
    state_source = "payload.actor" if payload.get("actor") else "bucket"
    # ★ 把桶里的状态合进这一轮要喂给 Laya 的 actor：relationship / emotion / goals 用状态，
    #   其余（identity / personality / situation）仍来自模板。
    #   只合会变的那几组，是刻意的 —— 把整个 actor 覆盖掉等于把「人物设定」也交给状态层，
    #   那不是本阶段的职责。
    if _st:
        actor = dict(actor or {})
        for _grp in ("relationship", "emotion", "goals"):
            if _st.get(_grp):
                actor[_grp] = dict(_st[_grp])
    # ★ 是否真的隔离（Phase3-Task2）：只有调用方显式传了 session_id **和** actor 标识才算。
    #   退到 default 桶时不报错（单角色 Demo 必须能用），但要在本轮输出里**标出来**，
    #   否则会有人把「多角色共用一条历史」的演示结果当成隔离证据。
    history_isolated = bool(payload.get("session_id")
                            and (payload.get("actor_id") or (actor or {}).get("name")))
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
    # ★★ fail-closed（2026-09-24，用户明确要求）：翻译失败**必须停在这一轮**。
    #   四件事一件都不能沾：①不调用英文 checkpoint ②不生成 state proposal
    #   ③不 commit ④结果标 invalid。理由见 translate_to_en 的注释 ——
    #   「中文冒充英文继续算」是本项目最危险的静默失效，必须从结构上堵掉。
    player_input_en = payload.get("player_input_en")
    xlate_src = "client" if player_input_en else ("n/a" if LANG != "en" else None)
    xlate_ms = 0.0
    if player_input_en is None and LANG == "en":
        tx0 = time.perf_counter()
        try:
            player_input_en, xlate_src = translate_to_en(player_input)
        except TranslationFailure as e:
            xlate_ms = (time.perf_counter() - tx0) * 1000
            # 环境自检：key 是否配置（**不记** key 本身、不记尾号）
            _has_key = bool(os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("LLM_API_KEY"))
            return {
                "ok": False,
                "status": "invalid",
                "invalid_reason": "translation_failed",
                "translation": {
                    "failed": True, "reason": e.reason, "source": "none",
                    "has_api_key": _has_key, "ms": round(xlate_ms, 1),
                    # 不回显原始台词译文（失败时它根本不存在）；只回显原文供调用方对账
                    "text_chars": len(player_input or ""),
                },
                "note": ("玩家台词无法翻成英文（reason=%s）。本轮**已中止**："
                         "未调用 Laya、未生成 state proposal、未 commit 任何状态。"
                         "这是刻意的 fail-closed —— 用中文冒充英文喂英文校准的模型会"
                         "得到「高置信 + 零准确」，且 API 里毫无迹象。请检查 API key / 网络后重试。"
                         % e.reason),
                "session_id": session_id, "actor_id": actor_id, "turn_id": turn_id,
                "state_commits": [], "state_skipped": [],
            }

    decision_history = build_decision_history(payload, history_for(session_id, actor_id))

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

    engine_used, meta_raw, routing = ENGINE_MODE_FALLBACK, {}, None
    if ENGINE.ready:
        try:
            res = ENGINE.predict(state_doc, laya_q)
            raw_answers, meta_raw = normalize_laya(res)
            routing = res.get("routing") if isinstance(res, dict) else None
            engine_used = ENGINE_MODE_LAYA
        except Exception as e:
            meta_raw = {"laya_error": repr(e)}
            ENGINE.last_error = repr(e)
    if engine_used == ENGINE_MODE_FALLBACK:
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

    # ---- ★★ Phase3-P2 Task10：按能力档案过滤后的统一 Proposal ------------------
    # 只有 role=state_shift 且 status=active 的 signal 能产出 delta。
    # 档案缺失 / 输入哈希不符时**一条都不产出** —— 宁可不动状态，也不拿未知能力当全能力用。
    # 代价是：换到一个没有档案的检查点（如 multilingual）时，本桥不再给状态建议；
    # 这是刻意的，因为「没验证过」和「验证过没问题」必须表现成不一样。
    _cap_prof, _cap_check = load_capability_profile(
        getattr(ENGINE, "model_name", None) or DEFAULT_MODEL_NAME)
    state_proposal, behavior_tendency, situation_assessment = build_state_proposal(
        answers, deltas, signal_values, _cap_prof, _cap_check)
    # ★ 规则层事件裁决（2026-09-25）：独立于 Laya 输出的启发式修正。
    #   口径：Laya 识别倾向，数值公式与裁决由规则层独立设计（见 apply_rule_adjudication）。
    #   安全边界：只作用于 doubt_shift；无命中时与旧版逐字节一致。
    state_proposal = apply_rule_adjudication(state_proposal, signal_values, player_input)

    # ★ 信号总表（Task9/Task10 的展示接口）：把 role / status / grade 直接挂到每个信号上。
    #   为什么不让前端自己按名字 join 三份数据 —— 前端 join 一定会和后端漂，
    #   而这张表的用途恰恰是「一眼看出这个信号能不能用」，漂了就等于给了错误的安全感。
    _prof_sig = ((_cap_prof or {}).get("signals") or {})
    signal_table = []
    for _r in signal_rows:
        _v = _prof_sig.get(_r["signal"]) or {}
        signal_table.append(dict(
            _r,
            role=_v.get("role"), status=_v.get("status"), grade=_v.get("grade"),
            portability=_v.get("portability"), status_source=_v.get("status_source"),
            may_write_state=_v.get("may_write_state"),
            consumable=bool(_v.get("status") in ("active", "auxiliary")),
            has_profile=bool(_v),
        ))

    # ★ 档案摘要（给前端 ⓿ 那一栏用）—— 注意必须覆盖**全部 15 个 signal**，
    #   而不是只有面板上那 9 个：会写 Actor State 的 6 个 *_shift 刻意不在面板上
    #   （见 SHIFT_IDS 的注释），只统计面板信号会得到「可写状态的信号：无」这种错误结论。
    cap_summary = None
    if _cap_prof:
        _psig = _cap_prof.get("signals") or {}
        _order = all_signal_names()
        _by_role = {}
        for _n, _v in _psig.items():
            _by_role.setdefault(_v.get("role"), []).append({
                "signal": _n, "status": _v.get("status"), "grade": _v.get("grade"),
                "portability": _v.get("portability"),
                "status_source": _v.get("status_source"),
                "label": ((CFG.get("state_shift") or {}).get("paths") or {}).get(_n, {}).get("label"),
            })
        for _r in _by_role.values():
            _r.sort(key=lambda x: _order.index(x["signal"]) if x["signal"] in _order else 99)
        cap_summary = {
            "checkpoint": _cap_prof.get("checkpoint"),
            "profile_id": _cap_prof.get("profile_id"),
            "role_in_phase3": _cap_prof.get("role_in_phase3"),
            "generated_at": _cap_prof.get("generated_at"),
            "n_runs": (_cap_prof.get("runs") or {}).get("n_runs"),
            "counts": _cap_prof.get("counts"),
            "state_writable": [_n for _n in _order
                               if (_psig.get(_n) or {}).get("may_write_state")],
            "revalidate_on_switch": [_n for _n in _order
                                     if (_psig.get(_n) or {}).get("revalidate_on_switch")],
            "by_role": _by_role,
        }

    # ★ 最终行为的取值规则（Phase3-Task1 后）：
    #   · source=ambiguous → **不给行为**（behavior=None），由上游 Story/Director 决定。
    #     这里绝不能用 `or choice_argmax` 兜底 —— 那正是被修掉的假交接：
    #     旧代码 final_id = policy.get("behavior") or choice_argmax，
    #     而歧义分支的 behavior 恰好就是 choice_baseline，于是"不硬选"变成了"硬选"。
    #   · 其余情况 policy.behavior 一定非空（规则命中 或 choice_baseline）。
    #   · 只有「policy 给出不在 behaviors 里的行为名」这一种错配才回落 choice，并写明原因。
    final_id = policy.get("behavior")
    if final_id is None and policy.get("source") != "ambiguous":
        # 不该发生：policy 既没给行为、又不是歧义。显式记下来，别静默兜底。
        policy = dict(policy, behavior=choice_argmax, source="choice_baseline",
                      reasons=[{"why": "policy 未给出行为且 source 不是 ambiguous → 回落 choice baseline"
                                "（配置异常，值得查）"}])
        final_id = choice_argmax
    bh = next((b for b in CFG["behaviors"] if b["id"] == final_id), None) if final_id else None
    if final_id is not None and bh is None:
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

    # ★★ 新版地基：分析与提交彻底分开。这里可以预演 State Transition，
    #   但绝不创建或修改 Actor State；只有 commit_state() 允许真正写入。
    state_decision = {
        "behavior_is_null": bh is None, "awaiting_upstream": bh is None,
        "source": policy.get("source"), "turn_id": turn_id,
    }
    state_validated, state_skipped, state_preview = validate_state_delta(
        session_id, actor_id, state_proposal,
        state_decision,
        actor=actor, frozen_state=frozen_state)
    state_view = actor_state_analysis_view(session_id, actor_id, actor=actor)

    # ★ behavior=null 的原因（Phase3-Task1）：必须能用一句话说清「为什么没给行为」。
    #   上游拿到一个裸 null 只能猜；而且歧义是**正常裁决**，不是故障，两者要分开。
    if bh is not None:
        behavior_null_reason = None
    elif policy.get("source") == "ambiguous":
        behavior_null_reason = ("判为歧义 → 本桥不选行为，交 Story / Director 裁决。依据：%s"
                                % (_why_text(policy.get("ambiguity_reasons")
                                             or policy.get("reasons")) or "（无明细）"))
    else:
        behavior_null_reason = ("policy 未产出行为，且 source 不是 ambiguous —— 属配置异常"
                                "（查 signals / policy 规则），本轮无行为，同样不许代选")

    return {
        "engine": engine_used,
        "engine_detail": ENGINE.detail if engine_used == ENGINE_MODE_LAYA else (ENGINE.detail or "未安装 laya"),
        "confidence_reliable": engine_used == ENGINE_MODE_LAYA,
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
        # ★ P2：信号面板要看的那张表（含 role / status / grade / 能不能用）
        "signal_table": signal_table,
        # ★ P2：能力档案摘要（覆盖全部 15 个 signal，含写状态的 6 个 *_shift）
        "capability_summary": cap_summary,
        # ★ Narraverse 侧为什么做这个决定
        "policy": policy,
        # ★ 状态增量只是「建议」，不是最终写入值
        # ★★ Phase3-P2 Task10：P2 起这里**已经不是全部增量**了 ——
        #     只有 role=state_shift 且 status=active 的 signal 才进 proposed_deltas；
        #     auxiliary / disabled / semantic_review 全部被 capability profile 拦下并逐条留 reason。
        #     未过滤的全量增量仍在 raw_deltas_all_signals，**仅供审计，不许拿去写状态**。
        "state_proposal": state_proposal,
        "behavior_tendency": behavior_tendency,
        "situation_assessment": situation_assessment,
        # ★★ 纯分析契约：state_commits 永远为空；validated 只是提交预演。
        "state_commits": [],
        "state_skipped": state_skipped,
        "actor_state": {"source": state_source, **(state_view or {})},
        "state_validation": {
            "validated_delta": state_validated,
            "preview": state_preview,
            "decision": state_decision,
        },
        "state_transition_meta": {
            "is_proposal": True,
            "authority": "none",
            "n_committed": 0,
            "n_validated": len(state_validated),
            "n_skipped": len(state_skipped),
            "note": ("本轮只分析与校验，没有写 Actor State。"
                     "validated_delta 是提交预演；真正写入只能走 commit_state()。"
                     "本轮状态取自 %s。" % state_source),
        },
        "checkpoint_profile": state_proposal["profile"],
        "proposed_deltas": state_proposal["delta"],
        "deltas": state_proposal["delta"],           # 兼容旧前端，逐步淘汰
        "raw_deltas_all_signals": deltas,
        "state_proposal_meta": {
            "is_proposal": True,
            "filtered_by_capability_profile": True,
            "n_active": len(state_proposal["delta"]),
            "n_auxiliary": len(state_proposal["auxiliary"]),
            "n_ignored": len(state_proposal["ignored_signals"]),
            "note": ("proposed_deltas 是**决策建议**，不是 Actor State 的最终写入值；"
                     "且自 Phase3-P2 起它已是**按能力档案过滤后**的结果 —— "
                     "正式链路应为 Laya Proposal → 后端 Validate → State Transition → Commit；"
                     "浏览器端 applyDeltas() 只是本 Demo 的演示手段，**不是状态权威**。"),
        },
        "director": director,
        # ★ 本轮身份（Phase3-Task2/Task3）：/commit 要用 turn_id；history_isolation=false
        #   表示调用方没传 session_id / actor_id，历史退到了 default 桶 —— 单角色演示可用，
        #   但**不能**当隔离证据用。history_gate 说明本轮历史处于哪道门。
        "turn": {
            "session_id": session_id,
            "actor_id": actor_id,
            "turn_id": turn_id,
            "history_bucket": "%s/%s" % (session_id, actor_id),
            "history_isolation": history_isolated,
            "history_bucket_entries": len(history_for(session_id, actor_id)),
            "note": ("历史按 (session_id, actor_id) 隔离。"
                     if history_isolated else
                     "未传 session_id / actor_id → 历史落在 default 桶，多角色会互相污染。"
                     "单角色 Demo 可用；并发 / 多 NPC 必须先传这两个字段。"),
        },
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
            # ★ Phase3-Task1：behavior=null 不再是「异常」，而是**明确裁决**。
            #   这一层字段是给上游 Story / Director 的唯一接口：
            #     behavior_is_null=true + fallback="story_agent" → 请上游自己决定
            #   choice_baseline 仍然给出（审计用），但它**没有被采纳**，
            #   本桥任何路径都不会再回退到它。要证明这一点，看 awaiting_upstream 与
            #   choice_baseline.adopted 两个字段即可，不必读代码。
            "behavior_is_null": bh is None,
            "behavior_null_reason": behavior_null_reason,
            "awaiting_upstream": bh is None,
            "source": policy.get("source"),
            "fallback": policy.get("fallback"),
            "choice_baseline": None if not baseline_bh else {
                "id": baseline_bh["id"], "name": baseline_bh["name"],
                "argmax": choice_argmax,
                "confidence": conf,
                "probabilities": prob,
                # ★ 这一项是审计信息，**不是**本轮行为。旧实现的 bug 就是让它当了行为。
                "adopted": bool(bh is not None and bh["id"] == baseline_bh["id"]
                                and policy.get("source") == "policy"),
                "note": ("仅审计：choice argmax 供对比。判为歧义时它**未被采纳**，"
                         "最终行为由上游 Story / Director 决定。"),
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


def decide(payload, frozen_state=None):
    """兼容现有 /decide 入口：分配 turn_id 后调用纯分析核，不写 Actor State。

    `frozen_state` 供 legacy handler 在锁内捕获的服务器状态快照 —— 与提交流程
    共用同一份「版本+快照」，避免模型推理期间发生 Reset/Commit 时把旧计算
    冒用的新版本提交（闭环审查 2026-09-25）。
    """
    actor = payload.get("actor") or CFG["actor"]
    session_id = payload.get("session_id") or "default"
    actor_id = str(payload.get("actor_id") or (actor or {}).get("name") or "default")
    return analyze_core(payload, turn_id=next_turn_id(session_id, actor_id),
                        frozen_state=frozen_state)


def world_decide(payload):
    state = payload.get("world_state") or CFG["world"]["state"]
    qs = CFG["world"]["questions"]
    laya_q = build_laya_questions(qs)
    names = CFG["world"].get("names", {})
    t0 = time.perf_counter()
    engine_used = ENGINE_MODE_FALLBACK
    raw_answers, meta_raw, routing = {}, {}, None
    if ENGINE.ready:
        try:
            res = ENGINE.predict({"world_state": state, "role": "WORLD"}, laya_q)
            raw_answers, meta_raw = normalize_laya(res)
            routing = res.get("routing") if isinstance(res, dict) else None
            engine_used = ENGINE_MODE_LAYA
        except Exception as e:
            meta_raw = {"laya_error": repr(e)}
    if engine_used == ENGINE_MODE_FALLBACK:
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
    # ★ P1 审查（2026-09-25）：请求读超时兜底 —— 防「声明 Content-Length 大于实际
    #   字节」的请求让读取线程永久挂起（rfile.read(n) 会一直等缺的字节）。
    #   超时按 socket 异常捕获并转 400，连接随后关闭。
    timeout = 10

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

    def _read_protocol(self):
        """协议端点专用读取：区分空 body / 未声明长度 / 超限(413) / 坏 JSON(400) / 顶层类型(422)。

        ★ P1 审查（2026-09-25）三处加固：
          1) Content-Length 缺失或非整数 → 400（不再把空 body 当 `{}` 之类继续路由）；
          2) 实际读到的字节数必须等于声明长度（防「加大声明长度」后带着残缺 body 进入路由）；
          3) JSON 顶层必须是对象，数组/标量 → 422 INVALID_REQUEST（约定错误协议，不允许越层 404/500）。
        """
        cl = self.headers.get("Content-Length")
        if cl is None:
            raise _ProtoError(400, "INVALID_JSON", "缺少 Content-Length，无法确定请求体边界")
        try:
            n = int(str(cl).strip())
        except (TypeError, ValueError):
            raise _ProtoError(400, "INVALID_JSON", "Content-Length 不是合法整数")
        if n <= 0:
            raise _ProtoError(400, "INVALID_JSON", "请求体为空")
        if n > MAX_BODY_BYTES:
            raise _ProtoError(413, "PAYLOAD_TOO_LARGE", "请求体超过 64 KiB 上限")
        try:
            raw = self.rfile.read(n)
        except OSError as e:
            # 含 socket.timeout：声明长度大于实际且连接不再来字节时，按超时/断连转 400
            raise _ProtoError(400, "INVALID_JSON", "读取请求体失败或超时：%r" % (e,))
        if len(raw) != n:
            raise _ProtoError(400, "INVALID_JSON",
                              "请求体不完整（声明 %d 字节，实际读到 %d 字节）" % (n, len(raw)))
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            raise _ProtoError(400, "INVALID_JSON", "JSON 无法解析")
        if not isinstance(body, dict):
            raise _ProtoError(422, "INVALID_REQUEST", "请求体顶层必须是 JSON 对象")
        return body

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
                "engine": ENGINE_MODE_LAYA if ENGINE.ready else ENGINE_MODE_FALLBACK,
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
        if path == "/state":
            # ★★ Phase3-P3：查某桶的 Actor State（含最近若干轮 commit 审计）。
            #   为什么必须有这个只读口：没有它，"状态到底有没有变化"只能靠再跑一轮来推断，
            #   而那种推断分不清「状态没变」和「状态变了但没接进输入」。
            #   ★ P2-B1：显式给 session_id+actor_id 时追加协议 `current`（版本/初始化/快照）。
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            sid = (qs.get("session_id") or [None])[0]
            aid = (qs.get("actor_id") or [None])[0]
            tr_cfg = (CFG.get("state_shift") or {}).get("transition") or {}
            if sid is not None and aid is not None:
                views = {("%s/%s" % (sid, aid)): actor_state_view(sid, aid)}
            else:
                views = {}
                for k in _ACTOR_STATE:
                    if sid is not None and k[0] != sid:
                        continue
                    if aid is not None and k[1] != aid:
                        continue
                    views["%s/%s" % k] = actor_state_view(k[0], k[1])
                if not views and sid is None and aid is None:
                    views["(空)"] = {"bucket": None, "exists": False, "state": None, "trace": []}
            out = {
                "n_buckets": len(_ACTOR_STATE),
                "buckets": views,
                "ranges": dict((sig, (p or {}).get("range"))
                               for sig, p in ((CFG.get("state_shift") or {}).get("paths") or {}).items()),
                "per_turn": {"max": tr_cfg.get("per_turn_max"), "min": tr_cfg.get("per_turn_min")},
                "note": ("Actor State 按 (session_id, actor_id) 分桶，与 history 同键。"
                         "ranges 直接读 state_shift.paths.*.range —— 本桥不维护第二套范围。"),
            }
            if sid is not None and aid is not None:
                try:
                    out.update(PROTOCOL.get_state(sid, aid))
                except _ProtoError as e:
                    return self._json(e.body(), e.http)
            return self._json(out)
        if path.startswith("/analysis/"):
            # ★ P2-B1：候选生命周期查询（只读，必须给 scope）。
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            sid = (qs.get("session_id") or [None])[0]
            aid = (qs.get("actor_id") or [None])[0]
            analysis_id = path[len("/analysis/"):]
            if not sid or not aid:
                return self._json({"protocol_version": "laya-state-v1",
                                   "error": {"code": "INVALID_REQUEST",
                                             "message": "GET /analysis/{id} 必须提供 session_id/actor_id 查询参数",
                                             "details": None}}, 422)
            try:
                return self._json(PROTOCOL.get_analysis(analysis_id, sid, aid))
            except _ProtoError as e:
                return self._json(e.body(), e.http)
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
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            sid = (qs.get("session_id") or [None])[0]
            aid = (qs.get("actor_id") or [None])[0]
            if sid is not None:
                buckets = {"%s/%s" % (sid, aid or k[1]): v
                           for k, v in _HISTORY_BUCKETS.items()
                           if k[0] == sid and (aid is None or k[1] == aid)}
            else:
                buckets = {"%s/%s" % k: v for k, v in _HISTORY_BUCKETS.items()}
            return self._json({
                "turns": [d for d in _HISTORY],
                # ★ Phase3-Task2 后历史按 (session_id, actor_id) 分桶。
                #   这里不再暴露那条**已废弃的进程级全局** _DECISION_HISTORY ——
                #   暴露它等于鼓励人继续依赖「所有角色共用一条历史」的旧行为。
                "buckets": buckets,
                "pending": len(_PENDING),
                "note": ("每桶只含 **已 commit** 的轮次。proposed 未提交的轮次不在里面，"
                         "behavior=null 的轮次永远进不来。"),
                "filter": {"session_id": sid, "actor_id": aid},
            })
        return self._json({"error": "not found",
                           "try": ["/health", "/config", "/demo", "/history", "/state", "/decide",
                                   "/turn", "/commit", "/narrate", "/world", "/reset", "/predict",
                                   "/analyze", "/analysis/{id}", "/commit_state", "/reject_analysis"]}, 404)

    def do_POST(self):
        path = self.path.split("?")[0]

        # ★ P2-B1：协议端点（错误统一按 §8；响应带 protocol_version）。
        #   必须用 _read_protocol 单独读 body —— do_POST 开头的 _read()
        #   只用于旧端点；协议端点最先读，避免 body 被提前消费导致空读。
        if path in ("/analyze", "/commit_state", "/reject_analysis"):
            try:
                payload = self._read_protocol()
            except _ProtoError as e:
                return self._json(e.body(), e.http)
            try:
                if path == "/analyze":
                    res = PROTOCOL.analyze(payload)
                elif path == "/commit_state":
                    res = PROTOCOL.commit_state(payload)
                else:
                    res = PROTOCOL.reject_analysis(payload)
                return self._json(res)
            except _ProtoError as e:
                return self._json(e.body(), e.http)
            except Exception as e:
                return self._json({"protocol_version": "laya-state-v1",
                                   "error": {"code": "INTERNAL_ERROR",
                                             "message": repr(e), "details": None}}, 500)

        payload = self._read()

        if path == "/decide":
            # ★ 闭环审查（2026-09-25）：先锁定一处「版本+状态快照」再跑分析 ——
            #   若推理期间发生 Reset/Commit，propose_turn 用版本校验直接拒绝，
            #   不让旧计算冒用新版本登记/提交。
            _fx_version, _fx_state = PROTOCOL.capture_legacy_scope(
                payload.get("session_id"), payload.get("actor_id"),
                payload.get("actor") or CFG.get("actor"))
            try:
                try:
                    out = decide(payload, frozen_state=_fx_state)
                except TypeError as _sig_e:
                    # == Qoder M-2（2026-09-25）：只兼容「单参数桩」这一个签名差异 ====
                    #   str 含 "unexpected keyword argument" 才回退（测试桩/外部单参替换）；
                    #   分析核内部真抛的 TypeError 原样上抛（且绝不重跑推理）。
                    if "unexpected keyword argument" in str(_sig_e):
                        out = decide(payload)
                        out.setdefault("frozen_binding_skipped", True)
                    else:
                        raise
            except Exception as e:
                return self._json({"error": repr(e)}, 500)
            dec = out.get("decision") or {}
            beh = dec.get("behavior") or {}
            turn = out.get("turn") or {}
            intent_id = (dec.get("player_intent") or {}).get("id")
            # ★ 历史日志也用统一取值，否则用 message 调用的轮次会被记成 player=None。
            # ★★ 注意 `out.get("engine")` 而不是 `out["engine"]`：
            #    `decide()` 有**两条返回路径** —— 正常轮带 engine，
            #    fail-closed 轮（翻译失败，status="invalid"）是**精简返回**、没有 engine 键。
            #    用下标取值会让 bridge 在「玩家台词翻译失败」这一**已经异常**的场景上
            #    再抛一次 KeyError，直接掐断 HTTP 连接（10061/RemoteDisconnected），
            #    把一次可控的 invalid 升级成看起来像服务崩了。见 tests/p3p2_unit.py T10。
            _HISTORY.append({"t": time.time(), "player": payload_text(payload),
                             "engine": out.get("engine"), "behavior": beh.get("id"),
                             "source": beh.get("source"),
                             "turn_id": turn.get("turn_id"),
                             "bucket": turn.get("history_bucket")})
            del _HISTORY[:-50]
            # ★ 三轮门控（Phase3-Task2/Task3）：/decide 只 **propose**，绝不直接写历史。
            #   旧实现在这里 extend _DECISION_HISTORY —— 于是「判了歧义、上游根本没采纳」
            #   的轮次也会污染下一轮 state，而且完全静默。现在只有 /commit 才进桶。
            if turn.get("turn_id"):
                try:
                    propose_turn(turn.get("turn_id"), turn.get("session_id"), turn.get("actor_id"),
                                 beh.get("id"), intent_id, dec.get("source"),
                                 state_proposal=out.get("state_proposal"),
                                 state_decision=(out.get("state_validation") or {}).get("decision"),
                                 actor=payload.get("actor") or CFG.get("actor"),
                                 record_history=not bool(payload.get("decision_history")),
                                 engine_used=out.get("engine"),
                                 frozen_state=_fx_state, frozen_version=_fx_version)
                except _ProtoError as e:
                    # ★ Qoder 审查 B-1（2026-09-25）：propose_turn 现在会因
                    #   推理窗口内版本变化抛 409，必须翻译成 HTTP 响应，
                    #   否则异常逃到 socketserver 会直接掐断连接（客户端
                    #   RemoteDisconnected，日志却仍记 200，排障被误导）。
                    return self._json(e.body(), e.http)
            out = dict(out, history_gate={
                "stage": "proposed",
                "committed": False,
                "turn_id": turn.get("turn_id"),
                "note": ("/decide 只登记候选，未写入历史。确认本轮真的被采纳后调 POST /commit"
                         "（turn_id 见 turn.turn_id）。behavior=null 的轮次无法提交 —— "
                         "没有行为就没有可确认的事实。"),
            })
            return self._json(out)

        if path == "/turn":
            # ★★ 新版地基：一步走完闭环，但仍严格执行 Analyze → Commit。
            #   decide() 只分析；本分支在 commit_state=true 时显式提交状态与历史。
            #   与 /decide + /commit 两步走的关系：
            #     /turn   = 单人连续剧情 / 体验测试。默认认定本轮成立。
            #     /decide+/commit = 上游（Story / Director）可能否决的正式链路。
            #   两者共用同一套状态层，不存在"快路绕过校验"。
            #   确实要在 /turn 上也不写状态时传 commit_state=false。
            _fx_version, _fx_state = PROTOCOL.capture_legacy_scope(
                payload.get("session_id"), payload.get("actor_id"),
                payload.get("actor") or CFG.get("actor"))
            try:
                try:
                    out = decide(payload, frozen_state=_fx_state)
                except TypeError as _sig_e:
                    # M-2：只兼容「单参数桩」，其它 TypeError 原样上抛、绝不重跑推理
                    if "unexpected keyword argument" in str(_sig_e):
                        out = decide(payload)
                        out.setdefault("frozen_binding_skipped", True)
                    else:
                        raise
            except Exception as e:
                return self._json({"error": repr(e)}, 500)
            turn = out.get("turn") or {}
            dec = out.get("decision") or {}
            beh = dec.get("behavior") or {}
            do_commit = payload.get("commit_state", True)
            ok, note = (False, "commit_state=false → 本轮不写状态、不写历史")
            state_result = {}
            if do_commit and beh.get("id"):
                try:
                    propose_turn(turn.get("turn_id"), turn.get("session_id"),
                                 turn.get("actor_id"), beh.get("id"),
                                 (dec.get("player_intent") or {}).get("id"), dec.get("source"),
                                 state_proposal=out.get("state_proposal"),
                                 state_decision=(out.get("state_validation") or {}).get("decision"),
                                 actor=payload.get("actor") or CFG.get("actor"),
                                 engine_used=out.get("engine"),
                                 frozen_state=_fx_state, frozen_version=_fx_version)
                except _ProtoError as e:
                    # B-1（2026-09-25）：同 /decide，把 409 翻译成 HTTP 响应而非掐断连接
                    return self._json(e.body(), e.http)
                ok, note, state_result = commit_turn(turn.get("turn_id"))
            elif do_commit:
                note = ("本轮无行为（歧义 / 未给行为）→ 按 P3 第一版规则：不 commit 状态、"
                        "不写历史。状态变化本身就是事实认定，歧义轮不抢跑。")
            _HISTORY.append({"t": time.time(), "player": payload_text(payload),
                             "engine": out.get("engine"), "behavior": beh.get("id"),
                             "source": beh.get("source"), "turn_id": turn.get("turn_id"),
                             "bucket": turn.get("history_bucket")})
            del _HISTORY[:-50]
            committed_view = state_result.get("actor_state")
            if committed_view is not None:
                out = dict(out, actor_state={"source": "committed", **committed_view},
                           state_commits=state_result.get("state_commits") or [],
                           state_skipped=state_result.get("state_skipped") or [],
                           state_transition_meta={
                               "is_proposal": False, "authority": "commit_state",
                               "n_committed": len(state_result.get("state_commits") or []),
                               "n_skipped": len(state_result.get("state_skipped") or []),
                               "note": "本轮已执行显式提交；实际变化见 state_commits。",
                           })
            return self._json(dict(out, state_gate={
                "stage": "committed" if ok else "not_committed",
                "history_committed": bool(ok),
                "state_commits": state_result.get("state_commits") or [],
                "note": note,
            }))

        if path == "/commit":
            # ★ 提交门（Phase3-Task3）：只有这一步才把决策写进 (session, actor) 桶。
            #   语义上＝「上游 Story / Director 真的采纳了这轮行为」。
            tid = payload.get("turn_id") or (payload.get("turn") or {}).get("turn_id")
            if not tid:
                return self._json({"error": "缺少 turn_id",
                                   "hint": "turn_id 来自 /decide 响应里的 turn.turn_id"}, 400)
            ok, note, state_result = commit_turn(tid)
            return self._json({"ok": ok, "turn_id": tid, "note": note,
                               "stage": "committed" if ok else "rejected",
                               "reason": state_result.get("reason"),
                               "state_version": state_result.get("state_version"),
                               "state_commits": state_result.get("state_commits") or [],
                               "state_skipped": state_result.get("state_skipped") or [],
                               "actor_state": state_result.get("actor_state")},
                              200 if ok else 409)

        if path == "/reset":
            # ★ 按桶清（Phase3-Task2）：传 session_id（+可选 actor_id）只清那一个桶，
            #   都不传 = 全清（保留旧行为，单角色演示方便）。
            #   ★ P2-B2：清状态/历史/重试均在同一事务锁内，并连同协议层
            #     reset_scope（换版本 generation、作废计算中的候选）一起执行。
            #   ★ 闭环审查（2026-09-25）风险2：全部 / 按 session 清空时，也必须
            #     对**每个受影响作用域**换 generation —— 否则旧协议候选仍可提交。
            sid = payload.get("session_id")
            aid = payload.get("actor_id")
            with PROTOCOL.lock:
                scopes = set()
                if sid is not None and aid is not None:
                    scopes.add((str(sid), str(aid)))
                else:
                    for _ks in (set(_ACTOR_STATE) | set(PROTOCOL._buckets)):
                        if sid is not None and str(_ks[0]) != str(sid):
                            continue
                        scopes.add(_ks)
                    for _p in _PENDING.values():
                        _pp = (_p.get("session"), _p.get("actor"))
                        if sid is not None and str(_pp[0]) != str(sid):
                            continue
                        scopes.add(_pp)
                new_ver = None
                hit = None
                for _sc in sorted(scopes):
                    new_ver = PROTOCOL.reset_scope(_sc)
                if scopes:
                    hit = ["%s/%s" % s for s in sorted(scopes)]
                hit_state = reset_actor_state(sid, aid)
                hit_buckets = reset_history(sid, aid)
                cleared = []
                if sid is None and aid is None:
                    del _HISTORY[:]
                    cleared.append("history_display")
            return self._json({"ok": True, "cleared": cleared,
                               "buckets_cleared": hit_buckets,
                               # ★ Phase3-P3：Actor State 与 history 同桶，就一起清。
                               #   只清一个会造出「历史清了但关系还在 82」的拧巴状态。
                               "actor_state_cleared": hit_state,
                               "protocol_scopes_reset": hit,
                               "scope": ("全部" if sid is None and aid is None
                                         else "session=%s actor=%s" % (sid, aid)),
                               "state_version": new_ver})

        if path == "/world":
            try:
                return self._json(world_decide(payload))
            except Exception as e:
                return self._json({"error": repr(e)}, 500)

        if path == "/narrate":
            actor = payload.get("actor") or CFG["actor"]
            bid = (payload.get("behavior") or {}).get("id")
            if payload.get("mode") == "analysis":
                # ★ P2-C（§7）：服务器选定的 analysis 模式。输入仅
                #   {mode, session_id, actor_id, analysis_id}——拒绝客户端携带
                #   actor/delta/behavior/state_line；不调 decide、不产生新候选、
                #   绝不重复 Commit。committed 取回执快照；reference_only 仅当
                #   版本/规则仍有效时引用；ready 未提交 → 409。
                if not payload.get("analysis_id"):
                    return self._json({"protocol_version": "laya-state-v1",
                                       "error": {"code": "INVALID_REQUEST",
                                                 "message": "mode=analysis 必须提供 analysis_id",
                                                 "details": None}}, 422)
                try:
                    ctx = PROTOCOL.narrate_context(payload.get("analysis_id"),
                                                   str(payload.get("session_id") or ""),
                                                   str(payload.get("actor_id") or ""))
                except _ProtoError as e:
                    return self._json(e.body(), e.http)
                n_actor = _copy.deepcopy(CFG["actor"])
                _st = ctx.get("state") or {}
                for _grp in ("relationship", "emotion", "goals"):
                    if _st.get(_grp):
                        n_actor[_grp] = dict(_st[_grp])
                # ★ P3-A：参考信号分块（availability=known，标注不改状态）+ 场景分块
                _blk = []
                for _sig, _sv in (ctx.get("signals") or {}).items():
                    _raw = (_sv or {}).get("raw_delta")
                    _blk.append("%s: raw_delta=%s（参考，未提交前不算已变化）"
                                % (_sig, "—" if _raw is None else _raw))
                _wd = (ctx.get("writable_delta") or [])
                for _w in _wd:
                    _blk.append("%s → %s: 提议 %s（候选建议，未提交前不是已变化）"
                                % (_w.get("source_signal"), _w.get("target"),
                                   _w.get("proposed_delta")))
                _signals_block = "\n".join(_blk) if _blk else None
                _scene = (ctx.get("context") or {}).get("scene") or None
                # ★ 玩法层：剧情阶段分块（决策呈现给叙事模型，让语气随关系档位走）
                _stage = plot_stage(ctx.get("state"))
                _stage_block = "当前关系档位：%s。%s（参考，不念数字）" % (_stage["txt"], _stage["hint"])
                _signals_block = (_stage_block + "\n" + _signals_block) if _signals_block else _stage_block
                r = llm_narrate(n_actor, None, ctx.get("message") or "",
                                (ctx.get("context") or {}).get("history") or [],
                                state_line(n_actor), bool(payload.get("include_reasoning")),
                                proactive=True, signals_block=_signals_block, scene=_scene)
                base = {
                    "ok": True, "mode": "analysis",
                    "analysis_id": payload.get("analysis_id"),
                    "state_version": ctx.get("state_version"),
                    "state_source": ctx.get("state_source"),
                    "commit_allowed": False, "state_commits": [],
                    "state": ctx.get("state"),
                    "plot_stage": _stage,
                }
                if not r or r.get("error") or not r.get("line"):
                    return self._json(dict(base, ok=False, line=None,
                                           error="云端叙事失败（状态已确认/可参考，回复可在稍后重试）"), 502)
                return self._json(dict(r, **base))
            if payload.get("mode") == "upstream":
                # 只续写服务端确实判为歧义的轮次；生成文本不等于接受状态 Proposal。
                pending = _PENDING.get(payload.get("turn_id"))
                sid = str(payload.get("session_id") or "default")
                aid = str(payload.get("actor_id") or actor.get("name") or "default")
                if (not pending or pending["session"] != sid or pending["actor"] != aid
                        or pending.get("behavior")
                        or not pending.get("state_decision", {}).get("awaiting_upstream")):
                    return self._json({"error": "没有匹配的待接续歧义轮次，请重新分析。"}, 409)
                if not payload.get("use_llm", True):
                    return self._json({"error": "请开启 LLM 生成以接续本轮对话。"}, 400)
                actor = _copy.deepcopy(pending.get("actor_template") or CFG["actor"])
                snapshot = actor_state_snapshot(sid, aid, actor)
                for group in ("relationship", "emotion", "goals"):
                    if group in snapshot:
                        actor[group] = snapshot[group]
                r = llm_narrate(actor, None, payload_text(payload), payload.get("history") or [],
                                state_line(actor), bool(payload.get("include_reasoning")))
                if not r or r.get("error") or not r.get("line"):
                    return self._json({"error": "云端接续失败，请稍后重试；本轮未提交状态。",
                                       "state_commits": [], "commit_allowed": False}, 502)
                return self._json(dict(r, ok=True, mode="upstream", behavior=None,
                                       turn_id=payload.get("turn_id"), commit_allowed=False,
                                       state_commits=[], history_committed=False))
            pre = None
            if not bid:
                # ★ 没带 behavior 就自己先跑一次 decide（"实时输入"的主要用法）。
                #   带了 behavior 仍走原路径，不重复算。
                try:
                    pre = decide(payload)
                except Exception as e:
                    return self._json({"error": "decide failed: %r" % e}, 500)
                dec_pre = pre.get("decision") or {}
                bh_pre = dec_pre.get("behavior") or {}
                bid = bh_pre.get("id")
                if not bid:
                    # ★★ Phase3-Task1 的核心：这里**绝不再**拿 choice argmax 当指定行为。
                    #    旧实现在这一步隐含「反正要一个行为」——那正是被修掉的假交接：
                    #    歧义轮次本该交上游，却在桥内被悄悄代选了，调用方只看到一个
                    #    正常响应，完全看不出「其实没人拍板」。
                    #    现在显式返回 awaiting_upstream，让上游 Story / Director 决定；
                    #    本桥不生成台词（没有行为就没有台词）。
                    return self._json({
                        "ok": False,
                        "awaiting_upstream": True,
                        "reason": "Laya 不确定 · 交由上游模型裁决",
                        "behavior": None,
                        "fallback": dec_pre.get("fallback"),
                        "behavior_null_reason": dec_pre.get("behavior_null_reason"),
                        "decision_source": dec_pre.get("source"),
                        "turn": pre.get("turn"),
                        "line": None,
                        "decision": pre,
                    })
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
    # ★ P2 起 out["deltas"] 是**按能力档案过滤后**的结果，不等于「Laya 报了多少增量」。
    #   两行分开打，避免有人拿过滤后的数字去说明模型能力（或反过来）。
    print("状态建议（已过滤，能进 State Transition 的）：",
          "  ".join("%s %+.2f" % (d["label"], d["delta"]) for d in out["deltas"]) or "（无）")
    print("全量增量（未过滤，仅审计）：",
          "  ".join("%s %+.2f" % (d["label"], d["delta"]) for d in out["raw_deltas_all_signals"]))
    print("能力档案：%s fresh=%s ｜ 可写状态 %d 条 / 修正项 %d 条 / 拦下 %d 条"
          % ((out.get("checkpoint_profile") or {}).get("checkpoint"),
             (out.get("checkpoint_profile") or {}).get("fresh"),
             len(out["state_proposal"]["delta"]), len(out["state_proposal"]["auxiliary"]),
             len(out["state_proposal"]["ignored_signals"])))
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
# ★★ P1（2026-09-24）：冻结基线与运行缓存彻底分家。
#   旧实现里档案校验（_xlate_subset_fingerprint）和实验翻译读的是**同一个**
#   可写文件 _diag/translation_cache.json —— 换机器/新 checkout 上它不存在，
#   就出现 P0 撞到的怪象：「翻译明明能命中（内存已载入冻结译文），
#   校验却报缺 137/137」。现在基线固定为 tests/assets/translation_cache.json
#   （选项 B 已入库：264 条，sha256 ac954c9494cde484…，见 tests/assets/README.md），
#   **只读**；日常运行缓存仍走 _diag，只能追加、永不覆盖基线。
#   LAYA_XLATE_FROZEN 可显式指定基线路径；优先级同 LAYA_MODEL（系统环境 > .env）。
_XLATE_FROZEN = Path(os.environ.get("LAYA_XLATE_FROZEN") or
                     (TESTS_DIR / "assets" / "translation_cache.json"))
_FROZEN_XLATE_MEMO = {"path": None, "mtime": None, "blob": None}


def _load_frozen_xlate():
    """读**冻结**翻译基线（只读，绝不写任何文件）。缺失/损坏返回 None。

    ★ 返回 None 时调用方必须 fail-closed（档案校验拒用 / 实验拒绝开跑），
      **不允许**静默回落运行缓存或在线补译 —— 那是把「校验读 A、翻译读 B」
      的原始 bug 换个地方重演。聚焦测试用 LAYA_XLATE_FROZEN 指向临时副本，
      真基线永不被测试触碰。
    """
    p = _XLATE_FROZEN
    m = _FROZEN_XLATE_MEMO
    try:
        mt = p.stat().st_mtime
    except OSError:
        m.update({"path": str(p), "mtime": None, "blob": None})
        return None
    if m.get("path") == str(p) and m.get("mtime") == mt and m.get("blob") is not None:
        return m["blob"]
    try:
        blob = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(blob, dict):
            raise ValueError("顶层不是 JSON 对象")
    except Exception:
        m.update({"path": str(p), "mtime": mt, "blob": None})
        return None
    m.update({"path": str(p), "mtime": mt, "blob": blob})
    return blob


def _load_fixture(name):
    p = TESTS_DIR / name
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        print("读取 %s 失败：%r" % (p, e))
        return None


_BASE_TEXTS_MEMO = {"mtime": None, "texts": None}


def _baseline_texts():
    """基准用例文本集合（frozenset，带 mtime 缓存）。

    供 `_cached_translate` 判定「text 是否属于基准用例」：基准用例的英文只能由
    冻结基线供给（fail-closed），未知玩家输入才允许走运行缓存/在线。
    缓存键是三个用例文件（cases/*.json）的 mtime 元组 —— 补文件、删文件、
    行尾重写等任何在磁盘上的变化都会让 mtime 变化从而重建；日常调用零重复读盘。
    """
    names = ("observable.json", "contextual.json", "hidden_truth.json")
    try:
        mt = tuple((TESTS_DIR / "cases" / n).stat().st_mtime for n in names)
    except OSError:
        mt = None
    m = _BASE_TEXTS_MEMO
    if m.get("mtime") == mt and m.get("texts") is not None:
        return m["texts"]
    texts = frozenset(_case_texts())
    m.update({"mtime": mt, "texts": texts})
    return texts


def _cached_translate(text, cache):
    """带磁盘缓存的翻译。48 条输入每条都要翻，不能每次重跑都重新调一遍 LLM。

    ★ fail-closed（2026-09-24）：拿不到英文就**返回 None**，绝不回落中文原文。
      本函数的调用方（signalmetrics / 实验脚本）应当把 None 当**剔除**处理，
      并在 invalid 段里记明原因 —— 旧实现的 `en != text` 判据看起来在防这件事，
      但 translate_to_en 当时是**原样返回 text**，所以判据恰好把中文挡在了缓存外、
      却把 `en`（=中文）继续交给下游用了。判据对了一半，毒还在。
      现在源头就抛/返回空，下游无从误用。

    ★ P1 审查 P1（2026-09-25）查找语义再收紧：**基准用例与未知玩家输入分两条路径**。
      当前实现「冻结没命中就继续查运行缓存/在线」会让基准用例在基线无效或缺条时
      回退到运行缓存甚至在线翻译 —— 这正是「校验读 A、翻译读 B」的变体（审查反例
      实测拿到了运行缓存的 RUNTIME_DRIFT 和一次在线调用）。现在：
        · 若 text 在基准用例集合（_case_texts）里 → 唯一可信来源是**冻结基线**：
          基线不可读、或基线上缺这条 → 直接返回 None（fail-closed），
          不查运行缓存、不调在线翻译；
        · 仅对**未知玩家输入**才保留 冻结 → 运行缓存 → 在线 的原路径，
          且在线译文只写运行缓存，永不写回基线。
    """
    frozen = _load_frozen_xlate()
    if text in _baseline_texts():
        if frozen is None or text not in frozen:
            return None
        return frozen[text]
    if frozen is not None and text in frozen:
        return frozen[text]
    if text in cache:
        return cache[text]
    try:
        en, _src = translate_to_en(text)
    except TranslationFailure as e:
        if os.environ.get("LAYA_TRACE"):
            sys.stderr.write("[xlate-trace] _cached_translate: TranslationFailure reason=%s\n" % e.reason)
        return None
    if not en or en == text:
        if os.environ.get("LAYA_TRACE"):
            sys.stderr.write("[xlate-trace] _cached_translate: en=%r empty_or_same (text=%r)\n" % (en, text))
        return None
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
        if LANG == "en" and not text_en:
            # ★ fail-closed：拿不到英文就**不跑这条**，而不是拿中文去跑。
            #   静默用中文跑会让这条用例的「准确率」变成噪声，且主表看不出来。
            print("  [%s] 跳过：翻译失败（fail-closed，不以中文冒充英文）" % c["id"])
            continue
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


# ==========================================================================
# 11.5 逐 signal 指标 + 可用性分级（Phase3 Task6 / Task7）
# ==========================================================================
# 为什么必须逐 signal，不许用总体 accuracy：
#   「方向断言 49.5%」这个数字本身没有行动价值 —— 它把 15 个维度混成一个数，
#   于是「哪些维度其实有信号、哪些纯噪声」全看不出来。上一轮实测里只有 3/15
#   维度超过了噪声底，但总体准确率把这件事完全掩盖了。
#   主结论必须按 signal 给，总体数只作为附注。
#
# 分级规则（Task7）**写在代码里**，不写在文档里 —— 否则「A/B/C/D」会随人变。
_NOISE_FLOOR = 0.05          # 实测噪声底：设备漂移 0.033 / 翻译抖动 0.055
_BOOT_SEED = 20260923        # bootstrap 固定种子：同输入必须给同结论
_BOOT_N = 2000


def _auc(pairs):
    """AUC = P(高分组 > 低分组)，用**秩和法**算（不依赖 sklearn）。

    pairs: [(value, label)]，label ∈ {"high", "low"}。
    返回 (auc, n_high, n_low)；样本不足返回 (None, 0, 0)。

    ★ 为什么是秩和而不是双重循环（2026-09-23 踩到）：
      朴素写法 O(n_hi·n_lo)。单次没问题，但 bootstrap 要重采样 2000 次、
      15 个 signal —— 60×60 的配对就是 2000×15×3600 ≈ 1 亿次 Python 循环，
      实测就是把命令挂在那儿几十分钟不动。秩和法 O(n log n)，秒级。
      两种写法结果完全等价，不是近似。

    并列（差值 < 1e-12）用**中位秩**，等价于并列各记 0.5 —— 必须这样，
    否则 noul 这种全挤在 0.5 附近的信号会因为「并列算赢」而虚高。
    """
    hi = [v for v, l in pairs if l == "high"]
    lo = [v for v, l in pairs if l == "low"]
    if not hi or not lo:
        return None, len(hi), len(lo)
    pool = sorted(v for v, _ in pairs)
    rank_of = {}
    i = 0
    while i < len(pool):
        j = i
        while j + 1 < len(pool) and abs(pool[j + 1] - pool[i]) < 1e-12:
            j += 1
        midrank = (i + j) / 2.0 + 1.0          # 1-based 中位秩
        rank_of[pool[i]] = midrank
        i = j + 1
    r_hi = sum(rank_of[v] for v in hi)
    n1, n2 = len(hi), len(lo)
    auc = (r_hi - n1 * (n1 + 1) / 2.0) / (n1 * n2)
    return auc, n1, n2


def _best_threshold(pairs):
    """在候选阈值上扫一遍，取平衡准确率最高的那个。返回 (thr, bal_acc, acc)。"""
    vals = sorted(set(v for v, _ in pairs))
    if len(vals) < 2:
        return None, None, None
    cands = [(vals[i] + vals[i + 1]) / 2.0 for i in range(len(vals) - 1)]
    best = (None, -1.0, None)
    for t in cands:
        tp = sum(1 for v, l in pairs if v >= t and l == "high")
        fn = sum(1 for v, l in pairs if v < t and l == "high")
        tn = sum(1 for v, l in pairs if v < t and l == "low")
        fp = sum(1 for v, l in pairs if v >= t and l == "low")
        tpr = tp / max(1, tp + fn)
        tnr = tn / max(1, tn + fp)
        bal = (tpr + tnr) / 2.0
        acc = (tp + tn) / max(1, tp + tn + fp + fn)
        if bal > best[1]:
            best = (round(t, 4), round(bal, 4), round(acc, 4))
    return best


def _boot(pairs, stat, n=_BOOT_N, seed=_BOOT_SEED):
    """bootstrap 95% 置信区间。stat 接收重采样后的 pairs，返回 float 或 None。"""
    rng = random.Random(seed)
    vals = []
    m = len(pairs)
    if m < 4:
        return None
    for _ in range(n):
        sample = [pairs[rng.randrange(m)] for _ in range(m)]
        r = stat(sample)
        if r is not None:
            vals.append(r)
    if len(vals) < n // 2:
        return None
    vals.sort()
    return (round(vals[int(0.025 * len(vals))], 4),
            round(vals[int(0.975 * len(vals)) - 1], 4))


def grade_signal(metrics):
    """Task7：把逐 signal 指标打 A/B/C/D（外加 N = 样本不足，R = 稳定反向）。

    ★ 规则固定在这里，运行结果才可复现。判据全部基于 **AUC 的点估计与
      bootstrap 区间下界**，不看总体准确率、不看均值差（均值差受量纲影响，
      不同 signal 之间不可比；AUC 可比）。

      N  样本不足（high 或 low 任一组 < 10）—— 不下结论，不许写成「差」
      R  CI 上界 < 0.50 —— **稳定反向**。它比噪声更危险：噪声不会骗人，
        反向会。要用必须先查清是「用例期望写反了」还是「信号语义相反」，
        查清之后只能**反向**使用，禁止按原方向写阈值。
      A  CI 下界 > 0.50 且 AUC ≥ 0.70 —— 可以作为行为的直接输入
      B  CI 下界 > 0.50 且 AUC ≥ 0.60 —— 可作强提示，但上层必须有规则约束
      C  AUC ≥ 0.55（区间不稳）     —— 只能当合取项，禁止单独定行为
      D  AUC < 0.55                 —— 不可用，不要拿它写阈值

    ★ 合并规则：一个 signal 的最终等级 = min(判别等级, 上下文等级)。
      理由：Projection Layer 的意义就是「随世界状态变化」。一个只能靠固定
      阈值把两组人分开、但对前文完全无反应的信号，无法承担这个职责 ——
      它更像一个常量偏置。所以两者取较差的那个。
    """
    auc = metrics.get("auc")
    ci = metrics.get("auc_ci")
    n_hi, n_lo = metrics.get("n_high") or 0, metrics.get("n_low") or 0
    if auc is None or n_hi < 10 or n_lo < 10:
        return "N", "样本不足（high=%d / low=%d，各需 ≥10）" % (n_hi, n_lo)
    # ★ 反向要先判：CI 整段落在 0.5 以下 = 「高分组的值反而更低」，这不是噪声
    if ci and ci[1] < 0.50:
        return "R", "AUC=%.3f，CI %s 整体 <0.50 —— 高分组反而更低，**方向反了**" % (auc, ci)
    if ci and ci[0] > 0.50 and auc >= 0.70:
        return "A", "AUC=%.3f，CI 下界 %.3f>0.50" % (auc, ci[0])
    if ci and ci[0] > 0.50 and auc >= 0.60:
        return "B", "AUC=%.3f，CI 下界 %.3f>0.50" % (auc, ci[0])
    if auc >= 0.55:
        return "C", "AUC=%.3f，但 CI %s 不稳" % (auc, ci)
    return "D", "AUC=%.3f < 0.55（CI %s）" % (auc, ci)


def grade_context(delta_stat):
    """Task7 的上下文维度：一个 signal 对前文有没有反应。

    与 grade_signal 分开算，因为这是**另一种能力**：
      判别 = 能不能把两类输入分开（静态）
      上下文 = 同一句话在不同前文下会不会变（动态）
    只看判别会把「常量偏置」误当成能力。

    ★ 只用 **signed**（期望方向上的增量）统计，不用裸 Δ ——
      同一个 signal 既有期望 up 的配对又有期望 down 的配对，
      裸 Δ 的均值会因为方向相反而互相抵消，把「有反应」算成「没动」。

      N  可配对样本 < 10
      R  稳定反向：CI 不含 0 且 越噪声底 ≥60% 且 **方向对率 ≤25%**
         —— 反应是真的，但方向与设计预期相反。必须先去查「是用例期望写反了，
         还是信号语义相反」，查清后只能反向使用。这条规则是必须的：
         第一版把它判成了 B（「有反应就是好」），而可靠地反向比噪声更危险。
      B  CI 不含 0 且 越噪声底 ≥60% 且 方向对率 ≥60% —— 有真实上下文响应
      C  越噪声底 ≥30% —— 弱反应，只能当合取项
      D  其余
    """
    n = delta_stat.get("n") or 0
    if n < 10:
        return "N", "可配对样本 %d < 10" % n
    share = delta_stat.get("share_beyond") or 0.0
    sign_rate = delta_stat.get("sign_rate") or 0.0
    ci = delta_stat.get("mean_ci")
    sig_ci = bool(ci and (ci[0] > 0 or ci[1] < 0))
    if sig_ci and share >= 0.60:
        if sign_rate <= 0.25:
            return "R", ("%.0f%% 的增量越过噪声底、均值 CI %s 不含 0，但**方向对率只有 %.0f%%** "
                         "—— 稳定反向，先去查用例与信号语义"
                         % (share * 100, ci, sign_rate * 100))
        if sign_rate >= 0.60:
            return "B", ("%.0f%% 的增量越过噪声底、均值 CI %s 不含 0、方向对率 %.0f%%"
                         % (share * 100, ci, sign_rate * 100))
        return "C", "有反应但方向不稳（越噪声底 %.0f%%、方向对率 %.0f%%）" % (share * 100, sign_rate * 100)
    if share >= 0.30:
        return "C", "%.0f%% 的增量越过噪声底（方向对率 %.0f%%）" % (share * 100, sign_rate * 100)
    return "D", "只有 %.0f%% 的增量越过噪声底（要求 ≥30%%）" % (share * 100)


# 严重度排序（用于 combine_grades 取差）。★ R 排在 C 与 D 之间而不是最差：
#   「稳定反向」是可以被利用的（反向使用即可），而 D 是纯噪声、什么也做不了。
#   但两者都比 C 差 —— C 至少方向是对的，只是不稳。
_GRADE_ORDER = {"A": 4, "B": 3, "C": 2, "R": 1, "D": 0, "N": -1}


def combine_grades(g_disc, g_ctx):
    """min(判别, 上下文)。任一为 N 时不参与取小（缺数据 ≠ 差）。"""
    if g_disc == "N":
        return g_ctx
    if g_ctx == "N":
        return g_disc
    return g_disc if _GRADE_ORDER[g_disc] <= _GRADE_ORDER[g_ctx] else g_ctx


def _load_case_sets():
    """读三组用例。返回 {组名: (元信息, [cases])}；缺文件就报出来，不静默跳过。"""
    out = {}
    for key in ("observable", "contextual", "hidden_truth"):
        p = TESTS_DIR / "cases" / ("%s.json" % key)
        try:
            blob = json.loads(p.read_text(encoding="utf-8"))
            out[key] = (blob, list(blob.get("cases") or []))
        except Exception as e:
            print("读取 %s 失败：%r" % (p, e))
            out[key] = ({}, [])
    return out


# ==========================================================================
# Phase3-P2 Task8：Checkpoint Capability Profile（机器可读的能力档案）
#
# 为什么必须有这一步：P1.5 的实测结论是「同一个 signal 在不同 checkpoint 上等级会变」——
#   15 个里 8 个变、1 个稳定反向、只有 trust_shift 一个跨检查点都是 A。
#   既然能力不是 Laya 的属性、而是 **checkpoint 的属性**，那么
#   「哪些 signal 可以进 State Transition」就**不能**是代码里的常量，
#   必须是每个 checkpoint 一份、从实验数据推导、跟着检查点走的档案。
#
# 三条纪律：
#   1) **等级不在这里定**。全部读 tests/runs/*.json 里 signalmetrics 已经算好的 grade，
#      本模块只做「跨跑次取代表值 → 跨检查点分类 → 按 grade 推导 status」。
#      想改判据就去改 grade_signal()，改在这里等于偷偷改评分规则。
#   2) 推导规则写死在 _derive_status()，可审计；唯一允许的例外是 config 里
#      capability_policy.override 显式点名的 signal —— 且 profile 会标
#      status_source=policy_override 并附 reason，覆盖是**可见的**，不伪装成推导结果。
#   3) 档案必须能自证来源：dataset / translation-cache / checkpoint / config / code 五个哈希。
#      哈希对不上时**拒绝使用**旧档案（见 load_capability_profile），不许静默沿用 ——
#      「拿 A 条件的档案去指导 B 条件的运行」正是这套实验里已经踩过一次的坑。
# ==========================================================================

_ROLE_NAMES = ("state_shift", "behavior_tendency", "situation_assessment")

# status 的四个取值（与提示词一致，不要扩成五个；要表达「暂时不用」用 disabled + reason）
_STATUSES = ("active", "auxiliary", "disabled", "semantic_review")


def _sha256_file(p):
    try:
        return hashlib.sha256(Path(p).read_bytes()).hexdigest()
    except Exception:
        return None


def _sha256_blob(obj):
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def _dataset_fingerprint():
    """用例集指纹：逐文件内容哈希后再整体哈希一次。

    ★ 只哈希文件名列表是不够的 —— 改了用例内容必须能看出来，
      而「改了什么用例」恰恰是 P1→P1.5 之间最大的变量。

    ★ P1（2026-09-24）增加行尾兼容哈希：.gitattributes 对 JSON 只标了 `text`，
      Windows 检出会把工作区变成 CRLF，raw 哈希随之改变，但用例内容一个字节没变
      （P0 已证明：三文件转 LF 后与档案逐字节一致）。`sha_lf` 是每个文件**仅做
      CRLF→LF**后重算的聚合指纹 —— raw 不符而 `sha_lf` 与档案一致，即可断定
      「内容未变、只有行尾不同」；任何真实内容改动（改用例 / 增删文件 / 改编码）
      两个哈希会同时失配，照样拒绝。归一化只此一种：去空白、重排序、重序列化、
      读 Git HEAD 代替工作区，一律不做。
    """
    d = TESTS_DIR / "cases"
    per, per_lf, crlf = {}, {}, []
    try:
        for p in sorted(d.glob("*.json")):
            b = p.read_bytes()
            per[p.name] = hashlib.sha256(b).hexdigest()
            b_lf = b.replace(b"\r\n", b"\n")
            per_lf[p.name] = hashlib.sha256(b_lf).hexdigest()
            if per[p.name] != per_lf[p.name]:
                crlf.append(p.name)
    except Exception:
        pass
    return {"dir": str(d), "files": per, "sha": _sha256_blob(per),
            "files_lf": per_lf, "sha_lf": _sha256_blob(per_lf),
            "crlf_files": crlf, "n_files": len(per)}


def _checkpoint_fingerprint(model):
    """检查点指纹。

    ★ 刻意**不**哈希权重内容：权重上 GB，读一遍纯属浪费，而且换不了任何结论。
      改为「配置/分词器配置的内容哈希 + 顶层文件清单（名 + 大小）」——
      换 checkpoint、换权重、换 max_len 都能看出来，开销毫秒级。

    ★ P1 审查 P2：目录解析**必须**与 find_local_models 共用 `_checkpoint_candidates`
      （laya-<名>/ 与裸 <名>/ 两种布局都认），否则出现「加载器认得出、指纹却
      报 exists=False」的布局，能力档案在该布局下永远不 fresh。
      有效判定与加载器一致：model.safetensors 与 rl_agent_config.json 都在。
    """
    d = next((c for c in _checkpoint_candidates(model)
              if (c / "model.safetensors").exists() and (c / "rl_agent_config.json").exists()),
             None)
    if d is None:
        # 两种布局都无效：用默认候选（laya-<名>）做诊断路径，exists=False
        d = Path(_checkpoint_candidates(model)[0])
    cfg_files = {}
    for rel in ("rl_agent_config.json", "config.json", "model_config.json",
                "tokenizer/tokenizer_config.json", "tokenizer/special_tokens_map.json"):
        p = d / rel
        if p.exists():
            cfg_files[rel] = _sha256_file(p)
    listing = []
    try:
        listing = sorted((p.name, p.stat().st_size) for p in d.iterdir() if p.is_file())
    except Exception:
        pass
    blob = {"model": model, "cfg": cfg_files, "files": listing}
    return {"model": model, "dir": str(d), "exists": d.is_dir(),
            "config_files": cfg_files, "top_level_files": listing,
            "id": _sha256_blob(blob)}


def _config_fingerprint():
    return {"path": str(CFG_PATH), "sha": _sha256_file(CFG_PATH)}


def _case_texts():
    """三组用例的全部输入文本（稳定顺序）。"""
    out = []
    for key in ("observable", "contextual", "hidden_truth"):
        try:
            blob = json.loads((TESTS_DIR / "cases" / ("%s.json" % key)).read_text(encoding="utf-8"))
        except Exception:
            continue
        for c in (blob.get("cases") or []):
            t = c.get("text")
            if t:
                out.append(t)
    return out


def _xlate_subset_fingerprint():
    """实验**真正用到**的那部分译文 → 哈希。这才是英文侧的输入条件。

    ★ 为什么不哈希整个缓存文件：正常使用（玩家自己敲中文）也会往缓存里写条目。
      哈希整个文件会让「玩过几轮 demo」变成「实验条件变了」——
      假告警多了等于没有告警，最后没人看。
      该冻结的是**这批用例的译文**：同一个中文句子只要译文没变，
      实验的输入条件就没变；缓存里多几条别的句子与本次实验无关。

    ★ n_missing > 0 表示这批输入根本没进过缓存 —— 那 signalmetrics 也不会开跑
      （开跑前的完备性断言会拦住），所以这个数字应当永远是 0；
      它不是 0 就说明缓存被换过 / 被删过。

    ★ P1（2026-09-24）：读取源改为**冻结基线**（_XLATE_FROZEN，默认
      tests/assets/translation_cache.json），与运行缓存（_XLATE_DISK）分离 ——
      校验和翻译必须同源（P0 的核心结论）。基线缺失/损坏时 source_error
      会给出原因，档案校验据此拒绝，绝不静默换源。
    """
    texts = sorted(set(_case_texts()))
    fr = _load_frozen_xlate()
    cache = fr if fr is not None else {}
    sub = dict((t, cache.get(t)) for t in texts if t in cache)
    missing = [t for t in texts if t not in cache]
    return {"sha": _sha256_blob(sub), "kind": "case_subset",
            "n_texts": len(texts), "n_present": len(sub), "n_missing": len(missing),
            "missing_sample": missing[:5], "source": str(_XLATE_FROZEN),
            "source_file_sha": _sha256_file(_XLATE_FROZEN),
            "source_error": None if fr is not None else "冻结基线缺失或不是合法 JSON 对象"}


def _code_fingerprint():
    p = Path(__file__).resolve()
    return {"path": str(p), "sha": _sha256_file(p)}


def all_signal_names():
    """15 个可定级 signal = signals.order 的 9 个 + 6 个 *_shift（顺序稳定）。"""
    spec = CFG.get("signals") or {}
    order = list(spec.get("order") or list(spec.get("meta") or {}))
    return order + [s for s in SHIFT_IDS if s not in order]


def _signal_roles(strict=True):
    """读 signals.roles。strict=True 时缺一个就返回 None。

    ★ 为什么必须有 strict：如果「忘了分层」会静默退回默认 role，
      那么一个 role 写错的 signal 会以正确的外表出现在错误的位置上 ——
      这类错误在验收时看不出来，只有出了事故才看得出来。
    """
    roles = (CFG.get("signals") or {}).get("roles") or {}
    roles = dict((k, v) for k, v in roles.items() if not k.startswith("_"))
    names = all_signal_names()
    missing = [s for s in names if s not in roles]
    if missing:
        msg = "signals.roles 没有覆盖这些 signal：%s" % "、".join(missing)
        if strict:
            print("★ 配置错误：%s" % msg)
            print("  每个 signal 都必须显式声明 role —— 不许有默认值，")
            print("  否则「忘了分层」会变成「静默用了默认值」，验收时看不出来。")
            return None
        print("⚠ %s（非 strict 模式，继续）" % msg)
    unknown = [k for k in roles if k not in names]
    if unknown:
        print("⚠ signals.roles 里 %d 个名字不是可定级 signal（将被忽略）：%s"
              % (len(unknown), "、".join(unknown)))
    for k, v in sorted(roles.items()):
        if k in names and (v or {}).get("role") not in _ROLE_NAMES:
            print("⚠ signals.roles.%s 的 role=%r 不在 %s 之内" % (k, (v or {}).get("role"), _ROLE_NAMES))
    return roles


def _capability_policy():
    return CFG.get("capability_policy") or {}


def parse_run_filename(stem):
    """从 `tests/runs/<a>__<b>.json` 拆出 (候选检查点名, run_id)。仅作**兜底**。

    ★ 为什么只算兜底、最终以文件内的 `model` 字段为准 —— 因为这里踩过一个静默坑：
      格式 `<checkpoint>__<run_id>` 用 `__` 分隔，但**检查点名自己也可能含 `__`**。
      实测：`trust_context__typed-decisions.json`（P2.5 产物，真检查点=typed-decisions）
      被旧实现的 `stem.rsplit("__", 1)` 解析成 检查点=`trust_context`、run=`typed-decisions`，
      于是凭空多出一个叫 `trust_context` 的"检查点"——**没有任何报错**。
      若那时跑 `capability`，就会拿两份 P2.5 结果去算一个不存在的检查点的等级，
      产出一份**看起来完全正常**的错误档案。静默错配比崩溃危险。
    """
    if "__" not in stem:
        return stem, "run1"
    i = stem.rfind("__")
    return stem[:i], stem[i + 2:]


def _load_run_results(runs_dir=None):
    """读 tests/runs/*.json，按**文件内的 model 字段**分组（文件名只作兜底）。

    返回 (分组, 文件名分组, 跳过的文件名)。

    ★ 判定顺序是刻意的：文件内容 > 文件名。
      文件名是人手写的、可以含 `__`、可以改；`model` 字段是写文件时代码填的，
      与那次运行实际加载的检查点一一对应。用内容判定把上面那类错配根除掉。
      解析不出 model 又不满足兜底规则的文件，**列出来并跳过**，不猜。
    """
    d = Path(runs_dir) if runs_dir else (TESTS_DIR / "runs")
    out, names, skipped = {}, {}, []
    try:
        files = sorted(d.glob("*.json"))
    except Exception:
        files = []
    for p in files:
        try:
            blob = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            print("⚠ 解析 %s 失败：%r（跳过）" % (p.name, e))
            skipped.append(p.name)
            continue
        ck = blob.get("model")
        if not ck:
            # 兜底：文件名解析。要能被当作检查点的，至少得像个 signalmetrics 产物
            cand, _run = parse_run_filename(p.stem)
            if not (blob.get("discrimination") or blob.get("final_grades")):
                skipped.append(p.name)
                continue
            ck = cand
        ck = str(ck)
        out.setdefault(ck, []).append(blob)
        names.setdefault(ck, []).append(p.name)
    return out, names, skipped


def _median(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2.0


def _rep_grade(gs):
    """跨跑次的代表等级 → (grade, unstable)。

    ★ 全部一致 → 直接用它；不一致 → 取**较差**的那个并标 unstable。
      取较差而不是取众数/取最好：跑次之间有分歧本身就是结论（说明不稳），
      挑最好的一次当结论等于把抖动当能力 —— P1 已经在这一步上栽过一次。
    """
    gs = [g for g in gs if g]
    if not gs:
        return None, False
    if len(set(gs)) == 1:
        return gs[0], False
    return min(gs, key=lambda g: _GRADE_ORDER.get(g, -1)), True


def _collect_signal_stats(runs):
    """从 N 次运行里抽每个 signal 的等级序列与指标。"""
    st = {}
    for s in all_signal_names():
        aucs, dgs, cgs, fgs = [], [], [], []
        csigned, cg, cn = [], [], []
        thr, gap = [], []
        for r in runs:
            d = (r.get("discrimination") or {}).get(s) or {}
            aucs.append(d.get("auc"))
            dgs.append(d.get("grade"))
            thr.append(d.get("best_threshold"))
            gap.append(d.get("mean_gap"))
            f = (r.get("final_grades") or {}).get(s) or {}
            cgs.append(f.get("context") or ((r.get("contextual") or {}).get(s) or {}).get("grade"))
            fgs.append(f.get("final") or d.get("grade"))
            x = (r.get("contextual") or {}).get(s)
            if x:
                csigned.append(x.get("mean_signed"))
                cg.append(x.get("grade"))
                cn.append(x.get("n"))
        dg_rep, dg_unstable = _rep_grade(dgs)
        cg_rep, cg_unstable = _rep_grade(cgs)
        fg_rep, fg_unstable = _rep_grade(fgs)
        st[s] = {
            "auc_by_run": aucs, "auc_median": _median(aucs),
            "disc_grades": dgs, "disc_grade": dg_rep,
            "ctx_grades": cgs, "ctx_grade": cg_rep,
            "final_grades": fgs, "final_grade": fg_rep,
            "unstable": bool(dg_unstable or cg_unstable or fg_unstable),
            "n_ctx_pairs": max(cn) if cn else None,
            "ctx_signed_median": _median(csigned),
            "threshold_median": _median(thr),
            "mean_gap_median": _median(gap),
        }
    return st


def _derive_status(name, grade, role, unstable, override, portability):
    """由实验结果推导 status → (status, source, reasons[])。

    规则（写死在这里，可审计；**等级不在本函数里决定**，只消费 grade）：

      0) config.capability_policy.override 显式点名 → 用它（source=policy_override）
      1) grade = N  → disabled         样本不足：不下结论，同样不接入
      2) 跑次之间等级不一致 → disabled  同一检查点内自己都不稳，谈不上能力
      3) grade = R  → semantic_review  「稳定反向」不是「弱」，是方向/语义出了问题。
                                       不接入，且**禁止静默取反** —— 取反等于把一个
                                       没查清的假设写进状态，比不用更危险
      4) grade = A  → active           该 role 的主输入
      5) grade = B  → auxiliary        「可作强提示，上层必须有规则约束」= 修正项
      6) grade = C  → auxiliary        「只能当合取项，禁止单独定行为」
      7) grade = D  → disabled         不可用
      8) 兜底       → disabled

    ★ portability（跨检查点稳定 / 特有 / 反向）**不参与降级**。
      档案本身是按检查点生成的：在这个检查点上 grade 是多少就是多少，
      拿另一个检查点的表现来降当前检查点的级，等于让 A 条件的数据否定 B 条件的结论。
      portability 只写进 revalidate_on_switch —— 真正的安全阀是
      「换检查点必须重新生成档案，哈希对不上时 load_capability_profile() 直接拒用」。
    """
    ov = (override or {}).get(name)
    if ov:
        st = ov.get("status")
        if st not in _STATUSES:
            return "disabled", "policy_override", ["override 里的 status=%r 非法，按 disabled 处理" % st]
        return st, "policy_override", list(ov.get("reason") or ["config 里显式覆盖"])

    r = []
    if grade == "N" or grade is None:
        return "disabled", "derived", ["grade=N（样本不足）：不下结论，也不接入正式链路"]
    if unstable:
        return "disabled", "derived", ["3 次运行的等级不一致 —— 该检查点内自己就不稳，"
                                       "谈不上「已验证的能力」"]
    if grade == "R":
        return "semantic_review", "derived", [
            "grade=R（稳定反向）：这不是「信号弱」，是方向或语义有问题。",
            "不接入正式链路，**并且禁止静默取反** —— 必须先查清是用例期望写反了、"
            "还是这个量的语义与名字不符",
        ]
    if grade == "A":
        r.append("grade=A（CI 下界 >0.50 且 AUC ≥0.70）：可作为该 role 的主输入")
        return "active", "derived", r
    if grade == "B":
        r.append("grade=B（CI 下界 >0.50 且 AUC ≥0.60）：可作强提示，但上层必须有规则约束 → 修正项")
        return "auxiliary", "derived", r
    if grade == "C":
        r.append("grade=C（AUC ≥0.55 但 CI 不稳）：只能当合取项，禁止单独定行为 → 修正项")
        return "auxiliary", "derived", r
    if grade == "D":
        r.append("grade=D（AUC <0.55）：不可用，不要拿它写阈值")
        return "disabled", "derived", r
    return "disabled", "derived", ["未知等级 %r" % grade]


def _evidence_check(runs, names, ckpt_fp, ds_fp):
    """核对「这几次运行是不是同一个条件」，并把结论写进档案。

    ★ 这是那次静默条件漂移事故的固化：当时同一组号称「3 次独立运行」的数据里
      混进了两种翻译缓存状态（obs_crow_3 在不在缓存里），**而且没有任何报错**。
      所以档案不能只说「3 次运行」，必须能回答「这 3 次条件是否一致」。
    """
    out = {"checks": {}, "consistent": True, "problems": []}

    # (1) 检查点：运行记录的 model 字段必须一致，且与档案一致
    models = sorted(set(str(r.get("model")) for r in runs))
    out["checks"]["models"] = models
    if len(models) > 1:
        out["consistent"] = False
        out["problems"].append("这几次运行的 model 字段不一致：%s" % "、".join(models))

    # (2) 翻译缓存：每次运行记录的 cache_sha 必须一致
    shas = [(r.get("validity") or {}).get("cache_sha") for r in runs]
    uniq = sorted(set(s for s in shas if s))
    out["checks"]["cache_sha"] = [(names[i] if i < len(names) else "?", (shas[i] or "")[:16])
                                  for i in range(len(shas))]
    out["checks"]["cache_sha_unique"] = uniq
    if len(uniq) > 1:
        out["consistent"] = False
        out["problems"].append(
            "★ 这几次运行用的是**不同的翻译缓存**（%d 个不同哈希）—— 条件已经变了，"
            "不能当同一组独立运行合并比较。见 tests/replication/ckpt_analysis.py 的说明。"
            % len(uniq))
    for i, r in enumerate(runs):
        if (r.get("validity") or {}).get("cache_changed_during_run"):
            out["consistent"] = False
            out["problems"].append("★ %s 运行**期间**翻译缓存被改写"
                                   % (names[i] if i < len(names) else "?"))

    # (3) 用例集：运行记录的 counts 必须与当前磁盘上的用例数一致
    cur = {}
    for key in ("observable", "contextual", "hidden_truth"):
        try:
            blob = json.loads((TESTS_DIR / "cases" / ("%s.json" % key)).read_text(encoding="utf-8"))
            cur[key] = len(blob.get("cases") or [])
        except Exception:
            cur[key] = None
    out["checks"]["case_counts_now"] = cur
    out["checks"]["case_counts_runs"] = [r.get("counts") for r in runs]
    for i, r in enumerate(runs):
        c = r.get("counts") or {}
        if cur and any(cur.get(k) is not None and c.get(k) != cur.get(k) for k in cur):
            out["consistent"] = False
            out["problems"].append(
                "%s 的用例数与当前磁盘不一致（运行 %s / 现在 %s）—— "
                "档案描述的是另一批输入，等级不能直接沿用"
                % (names[i] if i < len(names) else "?", c, cur))

    # (4) 有效性：被剔除的用例要能说出来
    out["checks"]["invalid_per_run"] = [
        len((r.get("validity") or {}).get("invalid") or []) for r in runs]
    for i, r in enumerate(runs):
        for it in ((r.get("validity") or {}).get("invalid") or []):
            out["problems"].append("剔除用例 [%s/%s/%s]：%s"
                                   % (it.get("set"), it.get("id"), it.get("role"),
                                      "；".join(it.get("reasons") or [])))
    out["checkpoint_id"] = ckpt_fp.get("id")
    out["dataset_sha"] = ds_fp.get("sha")
    return out


def _portability_from_analysis(name):
    """跨检查点分类：优先读 ckpt_analysis 的产物，读不到就标「未跨检查点验证」。

    ★ 刻意**不**在这里重新实现一遍 classify()。
      两份规则一定会漂，而「同一份数据被两套规则解释成不同结论」是这套实验里
      最难查的一类错误。分类只允许有一个权威实现（tests/replication/ckpt_analysis.py）。
    """
    p = TESTS_DIR / "ckpt_replication.json"
    try:
        blob = json.loads(p.read_text(encoding="utf-8"))
        row = ((blob.get("rows") or {}).get(name) or {})
        cls = row.get("class")
        if cls:
            return cls, "tests/ckpt_replication.json"
    except Exception:
        pass
    return "未跨检查点验证", None


def _build_profile(model, runs, names, era_ids=None):
    """为一个检查点生成档案。

    era_ids —— 若给了，表示这批 run 是被 tests/runs/eras.json **显式声明**为
    同一个可比较纪元的。它会被写进档案（`runs.era_ids`），让「这份等级是在哪几次
    运行上算的」可被独立核对。没有它时写明 `era_declared=False` ——
    「未声明」和「声明了就是这些」必须能区分。
    """
    roles = _signal_roles(strict=True)
    if roles is None:
        return None
    pol = _capability_policy()
    override = pol.get("override") or {}
    prod = pol.get("production_candidate")
    cmp_list = list(pol.get("comparison_checkpoints") or [])

    ckpt_fp = _checkpoint_fingerprint(model)
    ds_fp = _dataset_fingerprint()
    cfg_fp = _config_fingerprint()
    code_fp = _code_fingerprint()
    stats = _collect_signal_stats(runs)
    ev = _evidence_check(runs, names, ckpt_fp, ds_fp)

    signals = {}
    counts = dict((s, 0) for s in _STATUSES)
    for s in all_signal_names():
        entry = roles.get(s) or {}
        role = entry.get("role")
        st = stats[s]
        portability, port_src = _portability_from_analysis(s)
        status, source, reasons = _derive_status(
            s, st["final_grade"], role, st["unstable"], override, portability)
        counts[status] = counts.get(status, 0) + 1

        target = entry.get("target")
        if not target and role == "state_shift":
            target = (((CFG.get("state_shift") or {}).get("paths") or {}).get(s) or {}).get("target")

        signals[s] = {
            "name": s,
            "role": role,
            "kind": entry.get("kind") or st.get("kind") or _signal_kind(s),
            "range": entry.get("range"),
            "state_target": target,
            "semantic_zh": entry.get("semantic_zh"),
            "semantic_en": entry.get("semantic_en"),
            "validated_on": entry.get("validated_on"),
            # ---- 实验推导部分（唯一的事实来源）----
            "grade": st["final_grade"],
            "grade_by_run": st["final_grades"],
            "discrimination_grade": st["disc_grade"],
            "context_grade": st["ctx_grade"],
            "grade_detail": {
                "discrimination_by_run": st["disc_grades"],
                "context_by_run": st["ctx_grades"],
                "n_ctx_pairs": st["n_ctx_pairs"],
            },
            "metrics": {
                "auc_by_run": st["auc_by_run"],
                "auc_median": st["auc_median"],
                "ctx_signed_median": st["ctx_signed_median"],
                "mean_gap_median": st["mean_gap_median"],
                # ★ 最佳阈值只是统计输出：档案里记录，但**不写回 config / Policy**。
                #   从一次实验的阈值直接当生产阈值，是这套系统最容易犯的错。
                "best_threshold_median": st["threshold_median"],
                "best_threshold_is_statistical_only": True,
            },
            "status": status,
            "status_source": source,
            "status_reasons": reasons,
            "portability": portability,
            "portability_source": port_src,
            "revalidate_on_switch": portability not in ("① 跨检查点稳定", "未跨检查点验证"),
            "may_write_state": bool(role == "state_shift" and status == "active"),
            "need_upper_constraint": status == "auxiliary",
        }

    prof = {
        "_readme": [
            "Phase3-P2 Task8：Checkpoint Capability Profile（机器可读，由 laya_bridge.py capability 生成，不要手改）。",
            "★ 等级 (grade) 一律读自 tests/runs/*.json 里 signalmetrics 算好的值，本文件不重新定级。",
            "★ status 由 _derive_status() 推导；status_source=policy_override 的条目来自",
            "  narra_config.json 的 capability_policy.override，是**可见的**声明式覆盖。",
            "★ 只能由 role=state_shift 且 status=active 的 signal 产生 state_proposal 的 delta。",
            "  role 决定「能流向哪里」，status 决定「够不够格」，两者正交。",
            "★ metrics.best_threshold_median 只是统计输出，禁止写回 config / Policy。",
            "★ 使用前必须核对 evidence 里的五个哈希；对不上就重新生成档案。",
        ],
        "checkpoint": model,
        "profile_id": None,          # 下面回填
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "generator": "laya_bridge.py capability",
        "role_in_phase3": ("production_candidate" if model == prod
                           else ("capability_comparison" if model in cmp_list else "unregistered")),
        "runs": {"n_runs": len(runs), "files": names, "run_ids": [r.get("run_id") for r in runs],
                 "era_declared": bool(era_ids),
                 "era_ids": list(era_ids or []),
                 "era_source": str(ERA_PATH) if era_ids else None,
                 "era_note": (("这批运行由 %s 显式声明为同一可比较纪元。" % ERA_PATH.name)
                              if era_ids else
                              "未声明纪元 → 本档案是在该检查点的**全部** run 上算的，"
                              "若 runs/ 横跨多次缓存改动，跨跑次一致性可能不成立。")},
        "evidence": {
            "dataset": ds_fp, "checkpoint": ckpt_fp, "config": cfg_fp,
            # ★ 英文侧输入条件的权威哈希 = 实验用例译文的哈希（不是整个缓存文件）。
            #   file_sha_now / file_sha_per_run 只作旁证：前者会随日常使用增长，
            #   后者用来发现「运行期间缓存被改写」（那次静默条件漂移事故的指纹）。
            "translation_cache": {
                # ★ P1：权威来源是冻结基线（与 _xlate_subset_fingerprint 同源）。
                #   runtime_file 只是日常缓存的位置，供追查用，不参与哈希比对。
                "path": str(_XLATE_FROZEN),
                "sha": _xlate_subset_fingerprint()["sha"],
                "kind": "case_subset",
                "subset": _xlate_subset_fingerprint(),
                "file_sha_now": _sha256_file(_XLATE_FROZEN),
                "runtime_file": str(_XLATE_DISK),
                "file_sha_per_run": ev["checks"].get("cache_sha"),
            },
            "code": code_fp,
            "consistency": ev,
        },
        "status_rule": [
            "0) capability_policy.override 显式点名 → 覆盖（source=policy_override）",
            "1) grade=N → disabled；2) 跑次等级不一致 → disabled",
            "3) grade=R → semantic_review（方向/语义问题，禁止静默取反）",
            "4) grade=A → active；5) grade=B → auxiliary；6) grade=C → auxiliary；7) grade=D → disabled",
            "★ portability 不参与降级：档案是按检查点生成的，换检查点必须重新生成。",
        ],
        "counts": counts,
        "signals": signals,
    }
    prof["profile_id"] = _sha256_blob({
        "ckpt": model,
        "signals": dict((k, [v["grade"], v["status"], v["role"]]) for k, v in signals.items()),
        "dataset": ds_fp.get("sha"), "checkpoint": ckpt_fp.get("id"), "config": cfg_fp.get("sha"),
    })
    return prof


CAPABILITY_PATH = TESTS_DIR / "capability_profiles.json"
# ★★ 实验纪元声明（2026-09-24 P3 新增）。
#   为什么需要这个文件：tests/runs/ 是**只增不减**的（那些是证据，不该删），
#   但每个纪元跑的时候翻译缓存 / 用例集可能不同。于是「同一检查点的所有 run 文件」
#   会横跨多个条件，`_evidence_check` 一旦看到 2 个不同的 cache_sha 就判 inconsistent
#   → 档案永远不 fresh → 状态层一条都不写。
#   这是同一个类的第三次出现（前两次：run 文件名错配、prewarm 漏扫形状）。
#   修法不是「删掉旧 run」也不是「放宽一致性检查」（那等于把条件漂移当正常），
#   而是**让纪元显式声明**：哪些 run 属于同一次可比较的基线。
#   文件缺失时退回「全部 run」的旧行为，但会打印提示 —— 不静默。
ERA_PATH = TESTS_DIR / "runs" / "eras.json"


def _load_eras():
    """读 tests/runs/eras.json → {checkpoint: [run_id, ...]}。缺失/坏掉则返回 {}。"""
    try:
        blob = json.loads(ERA_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    out = {}
    for ck, v in (blob.get("eras") or {}).items():
        if isinstance(v, list):
            out[ck] = [str(x) for x in v]
        elif isinstance(v, dict):
            out[ck] = [str(x) for x in (v.get("run_ids") or [])]
    return out


def _filter_runs_to_era(model, runs, names):
    """把某检查点的 runs 收敛到「声明的那一个纪元」。

    ★ 判据是 run_id（文件内字段），不是文件名 —— 与 _load_run_results 同源。
      返回 (runs, names, era_ids, note)；note 说明做了什么，永远不静默。
    """
    eras = _load_eras()
    want = eras.get(model)
    if not want:
        if runs:
            return runs, names, None, (
                "未声明纪元（%s 不存在或没有 %s 条目）→ 使用 tests/runs/ 里该检查点的**全部** run"
                % (ERA_PATH.name, model))
        return runs, names, None, None
    keep_r, keep_n, hit = [], [], []
    for r, n in zip(runs, names):
        rid = str(r.get("run_id") or "")
        if rid in want:
            keep_r.append(r)
            keep_n.append(n)
            hit.append(rid)
    missing = [x for x in want if x not in hit]
    if not keep_r:
        return runs, names, None, (
            "★ 声明了纪元 %s，但 tests/runs/ 里一个都匹配不到（run_id=%s）→ 退回全部 run。"
            "这通常意味着 runs 文件被移动/改名了，请核对。" % (model, want))
    note = ("已按纪元收敛到 %d/%d 次运行：%s"
            % (len(keep_r), len(runs), "、".join(hit)))
    if len(keep_r) < len(runs):
        note += "（未计入：%s）" % "、".join(
            str(r.get("run_id")) for r in runs if str(r.get("run_id")) not in want)
    if missing:
        note += " ★ 声明里这些 run 不存在：%s" % "、".join(missing)
    return keep_r, keep_n, hit, note


_CAP_PROFILE_CACHE = {"mtime": None, "blob": None}


def load_capability_profiles(force=False):
    """读 tests/capability_profiles.json（带 mtime 缓存）。"""
    p = CAPABILITY_PATH
    if not p.exists():
        return None
    try:
        mt = p.stat().st_mtime
        if not force and _CAP_PROFILE_CACHE["mtime"] == mt and _CAP_PROFILE_CACHE["blob"] is not None:
            return _CAP_PROFILE_CACHE["blob"]
        blob = json.loads(p.read_text(encoding="utf-8"))
        _CAP_PROFILE_CACHE.update({"mtime": mt, "blob": blob})
        return blob
    except Exception as e:
        print("⚠ 读取能力档案失败：%r" % e)
        return None


def load_capability_profile(model=None):
    """运行时取当前检查点的能力档案 → (profile, check)。

    check 里是「为什么可用 / 不可用」，decide() 会原样透出给上游：
      matched          —— 档案里的 checkpoint 与当前运行的是同一个
      fresh            —— 输入侧哈希（dataset / config / checkpoint / cache）与磁盘现状一致
      problems[]       —— 具体哪一项对不上
      code_changed     —— 只是提示：代码变了不等于等级变了，所以**不阻断**
                          （断的是输入变了 —— 那会让同一份档案描述的是另一批条件）

    ★ 档案缺失或不 fresh 时**返回 (None, check)**，调用方必须据此拒绝写状态，
      而不是退回「所有 signal 都可用」—— 未知能力当全能力用，是最危险的默认值。
    """
    name = model or DEFAULT_MODEL_NAME
    blob = load_capability_profiles()
    check = {"checkpoint": name, "profile_file": str(CAPABILITY_PATH),
             "file_exists": CAPABILITY_PATH.exists(),
             "matched": False, "fresh": False, "problems": [], "code_changed": False,
             "profile_id": None}
    if not blob:
        check["problems"].append("能力档案不存在（先跑：python laya_bridge.py capability）")
        return None, check
    prof = ((blob.get("profiles") or {}).get(name))
    if not prof:
        check["problems"].append(
            "档案里没有检查点 %r 的条目（有的：%s）。"
            "换检查点必须重新生成档案 —— 能力不是 Laya 的属性，是检查点的属性。"
            % (name, "、".join(sorted((blob.get("profiles") or {}).keys())) or "无"))
        return None, check
    check["matched"] = (prof.get("checkpoint") == name)
    check["profile_id"] = prof.get("profile_id")

    ev = prof.get("evidence") or {}
    # 输入侧：不一致就拒用
    ds_now = _dataset_fingerprint()
    ds_arch = (ev.get("dataset") or {}).get("sha")
    if ds_arch != ds_now.get("sha"):
        # ★ P1 行尾兼容（2026-09-24）：raw 不符时允许**仅 CRLF→LF** 的核对 ——
        #   且必须**完整文件集合**的 LF 聚合指纹与档案一致才放行。
        #   放行时把证据写进 check（--check 会打印），内容有任何真实改动仍拒绝。
        if ds_arch and ds_arch == ds_now.get("sha_lf"):
            check["line_ending_compat"] = {
                "matched_via": "CRLF→LF（工作区行尾不同，用例内容与档案完全一致）",
                "crlf_files": ds_now.get("crlf_files") or [],
                "raw_sha": ds_now.get("sha"), "lf_sha": ds_now.get("sha_lf"),
            }
        else:
            check["problems"].append(
                "用例集已变（dataset sha 不符，且 CRLF→LF 兼容核对也不匹配）"
                "→ 等级是在另一批输入上算的")
    cfg_now = _config_fingerprint().get("sha")
    if (ev.get("config") or {}).get("sha") != cfg_now:
        check["problems"].append("narra_config.json 已变（config sha 不符）→ signal 定义可能已变")
    ck_now = _checkpoint_fingerprint(name).get("id")
    if (ev.get("checkpoint") or {}).get("id") != ck_now:
        check["problems"].append("检查点本体已变（checkpoint id 不符）→ 必须重新验证")
    # ★ 比对的是「实验用例译文的哈希」，不是缓存文件哈希 ——
    #   日常使用会让文件增长，那不是实验条件变化（见 _xlate_subset_fingerprint 的说明）。
    #   ★ P1：读的是冻结基线；基线本身缺失/损坏要单独报出，不能笼统说「译文已变」。
    xsub_now = _xlate_subset_fingerprint()
    if xsub_now.get("source_error"):
        check["problems"].append(
            "冻结译文基线不可读（%s）：%s → 拒绝猜测，不在线补译、不静默换源"
            % (xsub_now["source"], xsub_now["source_error"]))
    elif (ev.get("translation_cache") or {}).get("sha") != xsub_now["sha"]:
        check["problems"].append(
            "实验用例的译文已变（缺 %d/%d 条，基线：%s）→ 英文侧的输入条件与生成档案时不同"
            % (xsub_now["n_missing"], xsub_now["n_texts"], xsub_now["source"]))
    # 旁证：生成档案时那几次运行本身是否条件一致（运行期缓存被改写等），
    # 由 _evidence_check 在生成阶段已经判定并存进 consistency —— 这里只透出结论，
    # 不在每次 decide 里重读 6 个运行文件（那是几百 KB 的 I/O，且结论不会变）。
    # 代码侧：只提示
    if (ev.get("code") or {}).get("sha") != _code_fingerprint().get("sha"):
        check["code_changed"] = True
    if not (ev.get("consistency") or {}).get("consistent", True):
        check["problems"] += ["生成档案时这几次运行的条件就不一致：%s" % x
                              for x in ((ev.get("consistency") or {}).get("problems") or [])[:3]]

    check["fresh"] = not check["problems"]
    return (prof if check["fresh"] else None), check


def capability_status_map(profile):
    """profile → {signal: status}，供 decide() 过滤用。"""
    return dict((k, v.get("status")) for k, v in (profile.get("signals") or {}).items())


def _role_entries():
    return dict((k, v) for k, v in ((CFG.get("signals") or {}).get("roles") or {}).items()
                if not k.startswith("_"))


def _role_block(role_name, signal_values, profile, usable):
    """behavior_tendency / situation_assessment 两个块共用。

    ★ 这里**刻意不套阈值**。0.5 对 kind=prob 是「概率的中点」而不是标定出来的阈值，
      但即便这样也不在这里判读 —— 阈值属于 Policy Resolver 的规则表，
      能力档案里那些 best_threshold 又只是**统计输出**。
      让 Laya 层自己「顺手判一下」，等于把一处没标定的判据藏进推演层，
      以后没人能说清某个行为到底是哪条规则定的。
    """
    roles = _role_entries()
    sig = (profile or {}).get("signals") or {}
    out = []
    for name in all_signal_names():
        ent = roles.get(name) or {}
        if ent.get("role") != role_name:
            continue
        if name not in signal_values:
            continue
        pv = sig.get(name) or {}
        st = pv.get("status")
        out.append({
            "signal": name,
            "role": role_name,
            "value": signal_values.get(name),
            "kind": ent.get("kind"),
            "range": ent.get("range"),
            "grade": pv.get("grade"),
            "status": st,
            "semantic_zh": ent.get("semantic_zh"),
            # 只有 active / auxiliary 的值才允许上游当输入；disabled / semantic_review 一律标不可消费
            "consumable": bool(usable and st in ("active", "auxiliary")),
            "threshold_applied": False,
            "note": "本层只给值，不判读。阈值/分档属于 Policy Resolver，不得在这里定。",
        })
    return out


# 剧情线档位（玩法层）：由 state 的可写/代理信号判定关系走向，
# 供云端叙事（/narrate analysis 分块）与前端横幅（_plotline）共用。
# ★ 判据：doubt 是可写代理；trust 只读（档案 grade=C → auxiliary 不可写），
#   因此「信任渐生」用疑点回落（doubt<=30）判定，否则信任线永远不可达。
_PLOT_STAGES = (
    ("break",   "决裂边缘", "她对你已到决裂边缘，随时可能动手。", lambda d, t: d >= 70),
    ("guard",   "戒备中",   "她在戒备，每句话都在试探你的来路。", lambda d, t: d >= 45),
    ("trust",   "信任渐生", "疑点在消解，她开始松口，愿意吐露一两句真话。", lambda d, t: d <= 30),
    ("probing", "试探阶段", "关系未定，她还在权衡是否信你。", lambda d, t: True),
)


def plot_stage(state):
    """剧情线档位（玩法层）：返回 {"key","txt","hint"}。state 为 actor state 字典。"""
    rel = (state or {}).get("relationship") or {}
    d = _fnum(rel.get("doubt"))
    t = _fnum(rel.get("trust"))
    if not rel:
        return {"key": "probing", "txt": "试探阶段", "hint": _PLOT_STAGES[3][2],
                "doubt": d, "trust": t}
    for key, txt, hint, cond in _PLOT_STAGES:
        if cond(d, t):
            return {"key": key, "txt": txt, "hint": hint, "doubt": d, "trust": t}
    return {"key": "probing", "txt": "试探阶段", "hint": _PLOT_STAGES[3][2],
            "doubt": d, "trust": t}


def apply_rule_adjudication(state_proposal, signal_values, player_input=""):
    """规则层事件裁决（启发式，独立于 Laya 输出的数值公式层）。

    ★ 口径（2026-09-25，用户方向）：Laya 负责识别玩家行动意图；
      数值公式与**胜负裁决**由规则层独立设计，不混进模型输出。

    双通道裁决（任一命中即减缓疑点）：
      A) 模型侧：Laya 判「合作/坦白」倾向显著（cooperation ≥ 0.5 或
         disclose ≥ 0.5）→ 疑点正向增量打折并略降（old*0.5 - 0.8）。
         —— 实测中对试探/对峙台词 Laya 倾向偏保守，单独不足以破单调。
      B) 证据词（规则侧，玩家原文命中**强证据动作词**）→ 疑点正向增量
         直接取负（-|old|*0.6 - 0.6）。对应「交出/摊牌/坦白」这类明确让渡
         行为：交出名单、放下刀、摊开双手、和盘托出……
         —— 规则层独立裁决，不依赖模型输出（这正是「胜负归规则层」）。
    安全边界：
      - 只可能改到 source_signal == doubt_shift 且 delta > 0 的条目；
      - 无命中时**逐字节返回原对象**（零拷贝）；
      - 不改 status/grade/target/range，只动 delta 并打 `rule_adjudicated`。
    """
    ds = (state_proposal or {}).get("delta") or []
    if not ds:
        return state_proposal
    # 通道 A：模型倾向
    sv = signal_values or {}
    coop = _fnum(sv.get("cooperation"))
    disc = _fnum(sv.get("disclose"))
    # 通道 B：证据词（保守白名单，中文场景）
    text = str(player_input or "")
    evidence_hit = False
    for kw in _EVIDENCE_STOP_WORDS:
        if kw in text:
            evidence_hit = True
            break
    if coop < 0.5 and disc < 0.5 and not evidence_hit:
        return state_proposal
    out = _copy.deepcopy(state_proposal)
    changed = False
    if evidence_hit:
        # ★ 胜负归规则层：命中证据词时**无条件**施加疑点压制（不依赖 Laya 输出）。
        #   此前规则只在 Laya 给正 delta 时接管——Laya 判 0/负的证据轮会漏网，
        #   信任线仍不可达（实测）。现在：doubt_shift 项无论正负改写成
        #   -|old|-0.8；若该轮连 doubt_shift 项都没有，则追加一条 -2.8。
        target = next((it for it in out.get("delta") or []
                       if it.get("source_signal") == "doubt_shift"), None)
        if target is not None:
            target["delta"] = round(-abs(_fnum(target.get("delta"))) - 0.8, 3)
            target["rule_adjudicated"] = "evidence_handover"
            changed = True
        else:
            out.setdefault("delta", []).append({
                "source_signal": "doubt_shift", "target": "relationship.doubt",
                "delta": -2.8, "status": "active", "grade": "A", "role": "state_shift",
                "label": "怀疑", "range": [0, 100], "rule_adjudicated": "evidence_handover",
            })
            changed = True
    else:
        for item in out.get("delta") or []:
            if item.get("source_signal") != "doubt_shift":
                continue
            old = _fnum(item.get("delta"))
            if old <= 0:
                continue
            item["delta"] = round(old * 0.5 - 0.8, 3)
            item["rule_adjudicated"] = "pro_cooperation"
            changed = True
    return out if changed else state_proposal


# 证据词白名单：玩家「交出/摊牌/坦白」类强动作（规则层裁决用，保守列举）
_EVIDENCE_STOP_WORDS = (
    "放下刀", "放下剑", "摊开", "交给你", "交出来", "交给",
    "证据", "证词", "名单", "账目", "账本", "供词",
    "信物", "徽章", "图纸", "家书", "坦白", "和盘托出",
    "搜我", "搜身", "敞开外衣", "毫无保留", "再无保留", "搜我身上",
)


def _fnum(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return 0.0
    return v if v == v and v not in (float("inf"), float("-inf")) else 0.0


def build_state_proposal(answers, deltas, signal_values, profile, check):
    """Phase3-P2 Task10：统一 Proposal Schema（按能力档案过滤后的状态建议）。

    返回 (state_proposal, behavior_tendency, situation_assessment)。三者都是**建议**，
    绝不写 Actor State —— 真正写入属于 Narraverse 的 State Transition Layer。

    ★ 三道过滤，缺一不可：
      1) role == state_shift  —— 只有这一层能写状态。behavior_tendency 与
         situation_assessment 无论等级多高，都**没有**产出 delta 的资格。
      2) status == active     —— auxiliary 只能当合取/修正项。P2 阶段对 auxiliary 更严：
         只登记「若启用会产生多少」，**不产生任何数值效果**（applied=false）。
         这比提示词的要求更保守一格，理由是会写状态的量一旦算错是**不可逆**的。
      3) 档案自身可用          —— 档案缺失 / 输入哈希不符 → 一条 delta 都不产出。
         未知能力当全能力用，是这套系统里最危险的默认值。

    ★ 被过滤掉的必须逐条留 reason：只报「忽略了 N 个」不算达标，
      必须能说出是哪 N 个、为什么。
    """
    roles = _role_entries()
    smap = capability_status_map(profile) if profile else {}
    usable = bool(profile)
    ignored = []
    delta_out, aux_out = [], []

    for d in deltas:
        sig = d.get("question")
        ent = roles.get(sig) or {}
        role = ent.get("role")
        pv = ((profile or {}).get("signals") or {}).get(sig) or {}
        base = {"source_signal": sig, "attribute": d.get("target"),
                "target": d.get("target"),   # 旧键名，前端 applyDeltas 还在读；逐步淘汰
                "grade": pv.get("grade"), "role": role,
                "status": smap.get(sig), "semantic_zh": ent.get("semantic_zh")}
        if role != "state_shift":
            ignored.append(dict(base, reason=[
                "role=%s，不是 state_shift —— 它没有写 Actor State 的资格，"
                "只能进对应的输出块" % (role or "(未声明)")]))
            continue
        if not usable:
            ignored.append(dict(base, reason=[
                "能力档案不可用（%s）→ 该检查点上没有任何 signal 被验证过，一条 delta 都不产出"
                % ("；".join(check.get("problems") or []) or "原因未知")]))
            continue
        if smap.get(sig) == "active":
            delta_out.append({
                "attribute": d.get("target"), "delta": d.get("delta"),
                "target": d.get("target"),   # 旧键名，前端 applyDeltas 还在读；逐步淘汰
                "source_signal": sig, "grade": pv.get("grade"), "status": "active",
                "role": role, "label": d.get("label"),
                "raw": d.get("raw"), "attribution": d.get("attribution"),
                "range": d.get("range"),
                "checkpoint": (profile or {}).get("checkpoint"),
                "profile_id": (profile or {}).get("profile_id"),
            })
        elif smap.get(sig) == "auxiliary":
            aux_out.append(dict(base, applied=False,
                                delta_if_enabled=d.get("delta"),
                                raw=d.get("raw"), attribution=d.get("attribution"),
                                reason=[
                                    "grade=%s → auxiliary：只能当合取/修正项，不能单独驱动状态变化。"
                                    % pv.get("grade"),
                                    "P2 阶段对它会写状态的量更保守：只登记「若启用是多少」，"
                                    "不产生数值效果（applied=false）",
                                ]))
        else:
            ignored.append(dict(base, reason=list(pv.get("status_reasons") or
                                                  ["status=%r，不接入正式链路" % smap.get(sig)])))

    # 档案里 status=disabled / semantic_review 的 signal 若本轮根本没出值，也要列出来 ——
    # 「因为它没出现所以没被过滤」和「因为它不可用所以没被过滤」是两件事。
    for name in all_signal_names():
        ent = roles.get(name) or {}
        if ent.get("role") != "state_shift":
            continue
        if smap.get(name) in (None, "active", "auxiliary"):
            continue
        if any(x.get("source_signal") == name for x in ignored):
            continue
        pv = ((profile or {}).get("signals") or {}).get(name) or {}
        ignored.append({"source_signal": name, "attribute": ent.get("target"),
                        "grade": pv.get("grade"), "role": "state_shift",
                        "status": smap.get(name), "semantic_zh": ent.get("semantic_zh"),
                        "reason": list(pv.get("status_reasons") or []) +
                                  ["本轮该 signal 未产出值，且按档案本来也不可用"]})

    proposal = {
        "is_proposal": True,
        "authority": "none",
        "note": ("state_proposal 是**推演建议**，不是 Actor State 的最终写入值。"
                 "正式链路应为 Laya Proposal → 后端 Validate → State Transition → Commit；"
                 "浏览器端 applyDeltas() 只是 Demo 的演示手段，**不是状态权威**。"),
        "profile": {
            "checkpoint": check.get("checkpoint"),
            "profile_id": check.get("profile_id"),
            "matched": check.get("matched"),
            "fresh": check.get("fresh"),
            "code_changed": check.get("code_changed"),
            "problems": list(check.get("problems") or []),
            "source_file": check.get("profile_file"),
            "checked_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        },
        "delta": delta_out,
        "auxiliary": aux_out,
        "ignored_signals": ignored,
        "gate": {
            "can_commit_state": bool(delta_out),
            "n_delta": len(delta_out),
            "n_auxiliary": len(aux_out),
            "n_ignored": len(ignored),
            "why": ("有 %d 条 delta 来自 role=state_shift 且 status=active 的 signal，"
                    "可以交给 State Transition 层裁决" % len(delta_out)) if delta_out else
                   ("不产出 delta。" + ("能力档案不可用。" if not usable
                                      else "该检查点上没有 state_shift 类 signal 达到 active。")),
        },
    }
    bt = _role_block("behavior_tendency", signal_values, profile, usable)
    sa = _role_block("situation_assessment", signal_values, profile, usable)
    return proposal, bt, sa


def cmd_capability():
    """Phase3-P2 Task8：从实验产物生成机器可读的 Checkpoint Capability Profile。

    用法：
        python laya_bridge.py capability                  # tests/runs/ 里出现的所有检查点
        python laya_bridge.py capability typed-decisions  # 只做指定的
        python laya_bridge.py capability --check          # 只核对现有档案是否仍与磁盘一致

    ★ 本命令**不跑模型** —— 它只读 tests/runs/*.json，把已经算好的等级整理成档案。
      所以它是秒级的，可以在每次改动后随手重跑。
    """
    argv = sys.argv[2:]
    only = [a for a in argv if not a.startswith("-")]
    do_check = "--check" in argv

    runs_by_ck, names_by_ck, run_skipped = _load_run_results()
    if run_skipped:
        # ★ 显式列出来：这些文件既没有 model 字段、也不像 signalmetrics 产物，
        #   所以**没有被算进任何检查点**。不列的话，"少读了一个文件"是看不出来的。
        print("（以下 %d 个文件没有 model 字段且不似 signalmetrics 产物，未计入任何检查点：%s）"
              % (len(run_skipped), "、".join(run_skipped)))
    if not runs_by_ck:
        print("★ tests/runs/ 里没有任何 <checkpoint>__<run>.json，没有实验数据可依据。")
        print("  先跑：LAYA_MODEL=<ckpt> python laya_bridge.py signalmetrics")
        print("  ★ 本命令拒绝在缺实验数据时凭猜测生成档案 —— 那就是「硬写等级」。")
        return 1

    if do_check:
        blob = load_capability_profiles(force=True) or {}
        profs = blob.get("profiles") or {}
        print("=" * 96)
        print("能力档案核对（不重新生成，只看现档案与磁盘是否一致）")
        print("=" * 96)
        # ★ P1：先报有效资产来源，让「校验读的是哪份资产」有据可查（不含任何密钥）。
        print("  模型目录   ：%s（存在=%s）" % (MODELS_DIR, MODELS_DIR.is_dir()))
        print("  冻结译文基线：%s（存在=%s）" % (_XLATE_FROZEN, _XLATE_FROZEN.exists()))
        print("  运行翻译缓存：%s（存在=%s，只增不参与基线校验）"
              % (_XLATE_DISK, _XLATE_DISK.exists()))
        for ck in sorted((profs.keys() if profs else [])) or sorted(runs_by_ck.keys()):
            prof, check = load_capability_profile(ck)
            tag = "✅ fresh" if check["fresh"] else "★ 需重新生成"
            print("  %-18s %s ｜ profile_id=%s ｜ code_changed=%s"
                  % (ck, tag, (check.get("profile_id") or "")[:12], check["code_changed"]))
            lec = check.get("line_ending_compat")
            if lec:
                print("        · 行尾兼容匹配（%s）；CRLF 文件：%s"
                      % (lec.get("matched_via"), "、".join(lec.get("crlf_files") or []) or "无"))
            for x in check["problems"]:
                print("        · %s" % x)
        return 0

    # ---- 生成 ----------------------------------------------------------
    roles = _signal_roles(strict=True)
    if roles is None:
        return 2

    ckpts = [c for c in (only or sorted(runs_by_ck.keys())) if c in runs_by_ck]
    skipped = [c for c in (only or []) if c not in runs_by_ck]
    for c in skipped:
        print("⚠ %s 在 tests/runs/ 里没有数据，跳过" % c)
    if not ckpts:
        print("★ 没有可生成的检查点。tests/runs/ 里现有：%s" % "、".join(sorted(runs_by_ck.keys())))
        return 1

    profiles = {}
    for ck in ckpts:
        runs_all_ck = runs_by_ck[ck]
        names_all_ck = names_by_ck.get(ck) or []
        # ★ 按纪元收敛：只拿「同一次可比较基线」里的 run 去算等级。
        #   不做这一步时，runs/ 里横跨多次缓存的 run 会被判 inconsistent，
        #   档案永远不 fresh，状态层一条都不写（见 ERA_PATH 的注释）。
        runs, names_ck, era_hit, era_note = _filter_runs_to_era(ck, runs_all_ck, names_all_ck)
        if era_note:
            print("  [%s] %s" % (ck, era_note))
        if len(runs) < 3:
            print("⚠ %s 只有 %d 次运行 —— 档案会记录这个事实，"
                  "但「跨跑次稳不稳」这一项在它上面是**未验证**的。" % (ck, len(runs)))
        prof = _build_profile(ck, runs, names_ck, era_ids=era_hit)
        if prof is None:
            return 2
        profiles[ck] = prof

    # ---- 打印 ----------------------------------------------------------
    print("=" * 104)
    print("Checkpoint Capability Profile ｜ 由实验产物推导（不跑模型，只读 tests/runs/）")
    print("★ 等级来自 signalmetrics 的 grade；status 由 _derive_status() 推导；"
          "policy_override 的条目在下方标 [P]")
    print("=" * 104)
    for ck in ckpts:
        p = profiles[ck]
        print("\n■ %s ｜ role_in_phase3=%s ｜ %d 次运行 ｜ profile_id=%s"
              % (ck, p["role_in_phase3"], p["runs"]["n_runs"], p["profile_id"][:16]))
        print("  role 分布：%s"
              % " ｜ ".join("%s=%d" % (r, sum(1 for v in p["signals"].values() if v["role"] == r))
                            for r in _ROLE_NAMES))
        c = p["counts"]
        print("  status 分布：active=%d auxiliary=%d disabled=%d semantic_review=%d"
              % (c.get("active", 0), c.get("auxiliary", 0), c.get("disabled", 0),
                 c.get("semantic_review", 0)))
        if not p["evidence"]["consistency"]["consistent"]:
            print("  ★★ 条件一致性检查未通过：")
            for x in p["evidence"]["consistency"]["problems"]:
                print("      · %s" % x)
        print("  %-15s %-21s %-6s %-6s %-16s %-6s %s"
              % ("signal", "role", "kind", "grade", "status", "auc", "por"))
        print("  " + "-" * 100)
        for s in all_signal_names():
            v = p["signals"][s]
            mark = "[P]" if v["status_source"] == "policy_override" else "   "
            # 只让 active + state_shift 真的能写状态 —— 这是全系统最关键的一条约束
            wr = "→state" if v["may_write_state"] else ""
            print("  %-15s %-21s %-6s %-6s %-16s %-6s %-4s %s %s"
                  % (s, v["role"], v["kind"], v["grade"], v["status"],
                     ("%.3f" % v["metrics"]["auc_median"])
                     if v["metrics"]["auc_median"] is not None else "—",
                     v["portability"].split(" ")[0], mark, wr))
        print("  ★ 可写 Actor State 的 signal（role=state_shift 且 status=active）：%s"
              % ("、".join(s for s in all_signal_names() if p["signals"][s]["may_write_state"]) or "无"))
        print("  ★ 需在换检查点时重新验证的：%s"
              % ("、".join(s for s in all_signal_names() if p["signals"][s]["revalidate_on_switch"]) or "无"))

    out = {
        "_readme": ["Phase3-P2 Task8：每个 checkpoint 一份能力档案。",
                    "由 python laya_bridge.py capability 生成；等级读自 tests/runs/，status 由代码推导。",
                    "运行时由 load_capability_profile() 按五个哈希核对后才敢用。"],
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "runs_dir": str(TESTS_DIR / "runs"),
        "index": dict((ck, {"profile_id": profiles[ck]["profile_id"],
                            "role_in_phase3": profiles[ck]["role_in_phase3"],
                            "n_runs": profiles[ck]["runs"]["n_runs"],
                            "counts": profiles[ck]["counts"],
                            "consistent": profiles[ck]["evidence"]["consistency"]["consistent"]})
                      for ck in ckpts),
        "profiles": profiles,
    }
    # 合并进旧文件（保留本次没生成的检查点，但仍然逐条记录它的哈希状态由 --check 负责）
    try:
        old = load_capability_profiles(force=True)
        if old and isinstance(old.get("profiles"), dict):
            merged = dict(old["profiles"])
            merged.update(profiles)
            out["profiles"] = merged
            for ck, ent in (old.get("index") or {}).items():
                out["index"].setdefault(ck, ent)
    except Exception:
        pass
    CAPABILITY_PATH.parent.mkdir(parents=True, exist_ok=True)
    CAPABILITY_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n已写入 %s（%d 个检查点：%s）"
          % (CAPABILITY_PATH, len(out["profiles"]), "、".join(sorted(out["profiles"]))))
    print("运行时核对：python laya_bridge.py capability --check")
    return 0


def cmd_signalmetrics():
    """Phase3 Task6/7：逐 signal 指标 + bootstrap CI + A/B/C/D 分级。

    用法：
        python laya_bridge.py signalmetrics                # 三组全跑，默认检查点
        python laya_bridge.py signalmetrics 8              # 每组只跑前 8 条（看形状）
        LAYA_MODEL=english python laya_bridge.py signalmetrics
        LAYA_SETS=observable,contextual python laya_bridge.py signalmetrics   # 排除隐藏真相组

    ★ 主结论是**逐 signal**的表格：high/low 组均值、mean/median gap、AUC、
      最佳阈值、阈值准确率、bootstrap CI，最后给等级。
      总体 accuracy 只在末尾作为附注出现，且**隐藏真相组不计入**。
    """
    sets = _load_case_sets()
    want = [x.strip() for x in (os.environ.get("LAYA_SETS") or "").split(",") if x.strip()]
    if want:
        sets = dict((k, v) for k, v in sets.items() if k in want)
    lim = next((int(a) for a in sys.argv[2:] if a.isdigit()), None)

    ENGINE.init()
    if not ENGINE.ready:
        print("laya 未就绪，先跑 probe 看原因。")
        return 1
    model = DEFAULT_MODEL_NAME
    qs = build_laya_questions(CFG["questions"])
    cache = {}
    try:
        cache = json.loads(_XLATE_DISK.read_text(encoding="utf-8"))
    except Exception:
        pass

    # ---- ★★ 翻译缓存必须在**开跑前就完备**，否则条件会在运行途中自己变 ----------
    # 实测踩到（2026-09-23，English 复现实验）：obs_crow_3 不在缓存里，
    #   第 1、2 次运行按「缓存缺失 → message 被填成中文」把它剔除（69/70），
    #   而中间那一次运行顺手把译文写进了缓存 —— 于是**第 3 次运行读到 70/70、0 剔除**。
    #   同一组号称「3 次独立运行」的数据里混进了两种条件，**而且没有任何报错**。
    # 根因：translate_to_en 会**间歇性**返回空串（HTTP 200 但 content 为空），
    #   所以「什么时候能写进缓存」不可预测 —— 这类不确定性不该由实验去承担。
    # 修法：开跑前缺任何一条就**直接停**（return 2），让人先跑 _prewarm_cache.py，
    #   而不是让它边跑边改条件。跑完再核对哈希，双重保险。
    _cache_sha = (hashlib.sha256(_XLATE_DISK.read_bytes()).hexdigest()
                  if _XLATE_DISK.exists() else None)

    if LANG == "en":
        # ★ P1（2026-09-24）：基准输入的完备性以**冻结基线**为准（与档案校验同源）。
        #   旧实现查的是可写的 _diag 运行缓存 —— 新 checkout 上它不存在，
        #   会误报 137/137 缺失（P0 撞到）；反过来只靠运行缓存又会允许
        #   「基线被换掉但缓存凑齐了」的假通过。现在：基线缺失/缺条目一律拒绝开跑，
        #   不在线补译、不回落运行缓存凑数 —— 恢复基线是唯一出路。
        _frozen = _load_frozen_xlate()
        _all = []
        for _k in ("observable", "contextual", "hidden_truth"):
            for _c in (sets.get(_k) or ({}, []))[1]:
                _all.append(_c["text"])
        if _frozen is None:
            print("★ 开跑前检查未通过：冻结译文基线不可读（%s）。" % _XLATE_FROZEN)
            print("  基准输入的英文以冻结基线为准（fail-closed）。")
            print("  纪律见 tests/assets/README.md；不得用运行缓存或在线补译凑齐条件。")
            return 2
        _missing = sorted(set(t for t in _all if t not in _frozen))
        if _missing:
            print("★ 开跑前检查未通过：%d 条基准输入不在**冻结基线**（%s）里，拒绝开跑。"
                  % (len(_missing), _XLATE_FROZEN))
            print("  基线缺失/被换必须先恢复冻结资产（tests/assets/README.md），")
            print("  不允许靠运行缓存或在线补译凑齐 —— 那会让这批 run 与档案不可比。")
            for _t in _missing[:6]:
                print("      · %s" % _t[:44])
            return 2
        print("冻结基线完备：%d/%d 条基准输入全部命中（基线共 %d 条）｜ sha256=%s"
              % (len(set(_all)), len(set(_all)), len(_frozen),
                 (_sha256_file(_XLATE_FROZEN) or "")[:16]))

    def run_one(doc):
        dt, rows, by_name = _run_signals(model, doc, qs)
        return dt, by_name

    def make_doc(text, history_entries):
        text_en = _cached_translate(text, cache) if LANG == "en" else text
        return build_state_doc(CFG["actor"], text, [], CFG.get("scene"), None,
                               player_input_en=text_en,
                               decision_history=history_entries)

    FRESH = [{"type": "start", "summary": "scene begins"}]
    sig_order = list((CFG.get("signals") or {}).get("order") or [])
    all_names = sig_order + [s for s in SHIFT_IDS if s not in sig_order]

    run_id = os.environ.get("LAYA_RUN_ID") or time.strftime("%Y%m%d-%H%M%S")
    print("=" * 92)
    print("逐 signal 指标 ｜ 检查点=%s ｜ 设备=%s ｜ run=%s"
          % (model, ENGINE.device_label(), run_id))
    print("bootstrap n=%d seed=%d ｜ 噪声底=%.2f ｜ 等级规则见 grade_signal() 的 docstring"
          % (_BOOT_N, _BOOT_SEED, _NOISE_FLOOR))
    print("=" * 92)

    # ---- ★ 有效性过滤（English 复现实验 req.5）---------------------------
    # ★★ 为什么必须在跑模型**之前**做，而且必须把结论**排除掉**而不是「记一笔」：
    #   两类用例喂给模型的输入其实是坏的，而 API 返回里毫无迹象 ——
    #     1) state 溢出：build_sequence 会做 `st[:room]`（保留左、丢右），而 compact
    #        state 的尾部正是 `message`（玩家这一句）和 `decision_history`。
    #        模型的回答**不是**「它对这个输入的看法」，而是「它对一个被砍过的输入的看法」。
    #     2) 翻译失败/缺失：**2026-09-24 起改为 fail-closed** —— `_cached_translate`
    #        拿不到英文就直接返回 None（旧行为是静默回落中文原文）。于是
    #        `player_input_en=None` → message 字段退回中文 —— 而 english 与
    #        typed-decisions 都是英文校准的 ModernBERT。这一类**不是假设**：
    #        2026-09-24 撞到 key 失效时，表现为「首次成功、随后失败」，
    #        随机且间歇，看起来像「模型今天不稳定」。
    #        ⇒ 剔除 + 单独列为 invalid（与 §15.6「两组不齐」同一处理口径）。
    #   把坏输入留在主表里，得到的就不是「能力对比」，而是「谁被截得更少」的对比。
    #   所以：剔除 + 单独列为 invalid，与 §15.6 的「两组不齐」同一处理口径。
    xcache = cache if isinstance(cache, dict) else {}
    invalid = []

    def vet(cid, cset, role, text, dh):
        """量一条用例的输入是否**能**被有效呈现给模型，返回 (ok, budget)。"""
        doc = make_doc(text, dh)
        b = state_budget(doc)
        why = []
        if b and b.get("overflow"):
            why.append("state 溢出 %d token（room=%d）：laya 会 st[:room] 静默截断，"
                       "最可能丢掉 message / decision_history"
                       % (b["tokens"] - b["room"], b["room"]))
        if LANG == "en" and text not in xcache:
            why.append("翻译缺失 → message 字段退回**中文原文**，"
                       "英文校准的模型读不到这句话"
                       "（fail-closed：_cached_translate 拿不到英文即返回 None，不再静默回填中文）")
        if why:
            invalid.append({"set": cset, "id": cid, "role": role,
                            "tokens": (b or {}).get("tokens"),
                            "room": (b or {}).get("room"), "reasons": why})
        return (not why), b

    # ---- 收集：判别用 high/low 配对 -------------------------------------
    # ★★ 这里**只能**用 observable。第一版把 hidden_truth 一起并进来算了，
    #    是错的：那些用例的期望方向依赖 NPC 观察不到的事实，模型**原理上**
    #    不可能满足，并进来会系统性压低 AUC —— 这正是 Task4 说的
    #    「绝不混进主 accuracy」。hidden_truth 单独一段出，只当参考上限。
    obs_meta, obs_cases_all = sets.get("observable") or ({}, [])
    ht_meta, ht_cases_all = sets.get("hidden_truth") or ({}, [])
    ctx_meta, ctx_cases_all = sets.get("contextual") or ({}, [])
    if lim:
        obs_cases_all = obs_cases_all[:lim]
        ht_cases_all = ht_cases_all[:lim]
        ctx_cases_all = ctx_cases_all[:lim]

    obs_cases, ht_cases, ctx_cases, budgets = [], [], [], {}
    for c in obs_cases_all:
        _ok, _b = vet(c["id"], "observable", "base", c["text"], FRESH)
        budgets["observable/%s/base" % c["id"]] = _b
        if _ok:
            obs_cases.append(c)
    for c in ht_cases_all:
        _ok, _b = vet(c["id"], "hidden_truth", "base", c["text"], FRESH)
        budgets["hidden_truth/%s/base" % c["id"]] = _b
        if _ok:
            ht_cases.append(c)
    for c in ctx_cases_all:
        _prior = c.get("prior") or {}
        _ok1, _b1 = vet(c["id"], "contextual", "base", c["text"], FRESH)
        _ok2, _b2 = vet(c["id"], "contextual", "with_prior", c["text"],
                        _prior.get("decision_history") or FRESH)
        budgets["contextual/%s/base" % c["id"]] = _b1
        budgets["contextual/%s/with_prior" % c["id"]] = _b2
        if _ok1 and _ok2:
            ctx_cases.append(c)

    print("有效性过滤（req.5）：observable %d/%d ｜ hidden_truth %d/%d ｜ contextual %d/%d 通过"
          % (len(obs_cases), len(obs_cases_all), len(ht_cases), len(ht_cases_all),
             len(ctx_cases), len(ctx_cases_all)))
    _tok_ok = [b["tokens"] for b in budgets.values() if b]
    if _tok_ok:
        room_now = (checkpoint_budget() or (0, 0, None))
        print("  state 预算：token min=%d 中位=%d max=%d ｜ room=%d ｜ 溢出 %d 项"
              % (min(_tok_ok), sorted(_tok_ok)[len(_tok_ok) // 2], max(_tok_ok),
                 room_now[0] - room_now[1] - 1, sum(1 for b in budgets.values() if b and b["overflow"])))
    if invalid:
        print("  ★ 剔除 %d 项（**不进任何主结论**，单列于报告末尾）：" % len(invalid))
        for r in invalid:
            print("     [%s/%s/%s] %s" % (r["set"], r["id"], r["role"], "；".join(r["reasons"])))
    else:
        print("  0 项被剔除。")

    pairs = dict((n, []) for n in all_names)
    ht_pairs = dict((n, []) for n in all_names)
    obs_runs = {}

    def collect(cases, bucket, keep_runs=None):
        ok_n = 0
        for c in cases:
            try:
                _dt, by_name = run_one(make_doc(c["text"], FRESH))
            except Exception as e:
                print("  [%s] 失败：%r" % (c["id"], e))
                continue
            if keep_runs is not None:
                keep_runs[c["id"]] = by_name
            for name, want_dir in (c.get("expected_direction") or {}).items():
                row = by_name.get(name)
                if row is None:
                    continue
                if want_dir in ("high", "positive"):
                    bucket[name].append((float(row["value"]), "high"))
                    ok_n += 1
                elif want_dir in ("low", "negative"):
                    bucket[name].append((float(row["value"]), "low"))
                    ok_n += 1
                # neutral 不参与 AUC：它不是「两类中的一类」，混进来会把
                # 阈值扫描带偏，也会让 AUC 失去「可分性」的含义。
        return ok_n

    n_obs_assert = collect(obs_cases, pairs, obs_runs)
    n_ht_assert = collect(ht_cases, ht_pairs)

    # ---- 逐 signal 主表 -------------------------------------------------
    grades, report = {}, {}

    def disc_table(the_pairs, title, note):
        print("\n" + title)
        print("  %-12s %-5s %4s %4s %8s %8s %8s %7s %7s %7s %-18s %s"
              % ("signal", "kind", "nHi", "nLo", "均值Hi", "均值Lo", "meanGap", "medGap",
                 "AUC", "thrAcc", "bestThr", "AUC 95%CI"))
        rows = {}
        for name in all_names:
            p = the_pairs.get(name) or []
            hi = [v for v, l in p if l == "high"]
            lo = [v for v, l in p if l == "low"]
            auc, n_hi, n_lo = _auc(p)
            if auc is None:
                print("  %-12s %-5s %4d %4d   —— %s" % (name, _signal_kind(name), n_hi, n_lo, note))
                rows[name] = {"n_high": n_hi, "n_low": n_lo, "auc": None, "grade": "N",
                              "grade_reason": "两组不齐（%s）" % note}
                continue
            mh, ml = sum(hi) / len(hi), sum(lo) / len(lo)
            sh, sl = sorted(hi), sorted(lo)

            def med(a):
                return a[len(a) // 2] if len(a) % 2 else (a[len(a) // 2 - 1] + a[len(a) // 2]) / 2.0

            gap, mgap = mh - ml, med(sh) - med(sl)
            thr, bal, tacc = _best_threshold(p)
            ci = _boot(p, lambda s: _auc(s)[0])
            m = {"n_high": n_hi, "n_low": n_lo, "mean_high": round(mh, 4), "mean_low": round(ml, 4),
                 "mean_gap": round(gap, 4), "median_gap": round(mgap, 4), "auc": round(auc, 4),
                 "auc_ci": ci, "best_threshold": thr, "threshold_balanced_acc": bal,
                 "threshold_accuracy": tacc, "kind": _signal_kind(name), "boot_n": _BOOT_N,
                 "boot_seed": _BOOT_SEED}
            g, why = grade_signal(m)
            m["grade"] = g
            m["grade_reason"] = why
            rows[name] = m
            print("  %-12s %-5s %4d %4d %8.3f %8.3f %+8.3f %+7.3f %7.3f %7s %-18s %-18s  %s"
                  % (name, m["kind"], n_hi, n_lo, mh, ml, gap, mgap, auc, tacc or "—",
                     "%s/%.2f" % (thr, bal) if thr is not None else "—", "%s" % (ci,), g))
        return rows

    report = disc_table(pairs, "── 主结论：逐 signal 判别力（**仅 observable**，%d 条断言）"
                        % n_obs_assert + "─" * 12,
                        "observable 组两组不齐，无法算 AUC")
    grades = dict((k, (v.get("grade", "N"), v.get("grade_reason", ""))) for k, v in report.items())

    ht_report = disc_table(ht_pairs, "── 参考（**不计入任何主结论**）：hidden_truth 组的判别力"
                           "（%d 条断言）" % n_ht_assert + "─" * 12,
                           "hidden_truth 组两组不齐。★ 这组期望方向依赖 NPC 观察不到的真相，"
                           "数字只作上限参考")
    for k in ht_report:
        ht_report[k]["counts_in_main_accuracy"] = False
        ht_report[k]["note"] = ("本组不含 omniscient 判据，**不得**用于给 signal 定级或定阈值。"
                                "放进来的唯一目的是对照「若把真相喂进去会怎样」。")

    # ---- 上下文维度 -----------------------------------------------------
    print("\n── 上下文维度：同一句话在有/无前文下的增量（成对）" + "─" * 30)
    # ctx_cases 已在有效性过滤阶段取好并按 req.5 过滤过 —— 不要在这里重新读文件，
    # 否则「过滤」只作用于判别段、上下文段又悄悄把坏用例收回来。
    deltas = dict((n, []) for n in all_names)
    for c in ctx_cases:
        try:
            _d1, base = run_one(make_doc(c["text"], FRESH))
            prior = c.get("prior") or {}
            dh = prior.get("decision_history") or FRESH
            _d2, withp = run_one(make_doc(c["text"], dh))
        except Exception as e:
            print("  [%s] 失败：%r" % (c["id"], e))
            continue
        for name, want_dir in (c.get("expect_delta") or {}).items():
            if name not in base or name not in withp:
                continue
            d = float(withp[name]["value"]) - float(base[name]["value"])
            signed = d if want_dir == "up" else -d
            deltas[name].append({"delta": round(d, 4), "want": want_dir,
                                 "signed": round(signed, 4),
                                 "beyond": abs(d) >= _NOISE_FLOOR, "id": c["id"]})
    print("  %-12s %4s %9s %9s %9s %9s %-18s %-14s %s"
          % ("signal", "n", "均Δ(定向)", "中位Δ", "方向对", "越噪声底", "均值 95%CI", "等级", "说明"))
    ctx_grades, ctx_report = {}, {}
    for name in all_names:
        ds = deltas.get(name) or []
        if not ds:
            continue
        # ★★ 统计量必须是 **signed**（期望方向上的增量），不能用裸 Δ。
        #    第一版这里算的是裸 Δ 的均值，而同一个 signal 既有期望 up 的配对、
        #    也有期望 down 的配对 —— 两者会互相抵消，于是「有反应」被算成
        #    「平均没动」。这是把方向信息丢掉之后又假装在测效应，必须修。
        sv = [x["signed"] for x in ds]
        mv = sum(sv) / len(sv)
        srt = sorted(sv)
        med = srt[len(srt) // 2] if len(srt) % 2 else (srt[len(srt) // 2 - 1] + srt[len(srt) // 2]) / 2.0
        sign_ok = sum(1 for x in ds if x["signed"] > 0)
        share = sum(1 for x in ds if x["beyond"]) / len(ds)
        ci = _boot([(x["signed"], x["want"]) for x in ds], lambda s: sum(v for v, _ in s) / len(s))
        st = {"n": len(ds), "mean_signed": round(mv, 4), "median_signed": round(med, 4),
              "sign_ok": sign_ok, "sign_rate": round(sign_ok / len(ds), 4),
              "share_beyond": round(share, 4), "mean_ci": ci,
              "n_up": sum(1 for x in ds if x["want"] == "up"),
              "n_down": sum(1 for x in ds if x["want"] == "down"),
              "cases": [{k: x[k] for k in ("id", "delta", "want", "signed", "beyond")} for x in ds]}
        g, why = grade_context(st)
        st["grade"] = g
        st["grade_reason"] = why
        ctx_grades[name] = (g, why)
        ctx_report[name] = st
        print("  %-12s %4d %+8.3f %+8.3f %7d/%-3d %9.0f%% %-18s %-14s %s"
              % (name, len(ds), mv, med, sign_ok, len(ds), share * 100,
                 "%s" % (ci,), g, why))

    # ---- 合并等级 -------------------------------------------------------
    print("\n── 最终等级：min(判别, 上下文)（N 表示该维度样本不足，不参与取小）" + "─" * 16)
    final = {}
    for name in all_names:
        if name not in report and name not in ctx_report:
            continue
        gd = grades.get(name, ("N", "无判别数据"))[0]
        gc = ctx_grades.get(name, ("N", "无上下文数据"))[0]
        g = combine_grades(gd, gc)
        final[name] = {"discrimination": gd, "context": gc, "final": g,
                       "disc_reason": grades.get(name, ("N", ""))[1],
                       "ctx_reason": ctx_grades.get(name, ("N", ""))[1]}
        print("  %-12s 判别=%-2s 上下文=%-2s → **%s**" % (name, gd, gc, g))

    # ---- 附注：总体准确率（不含隐藏真相组）-----------------------------
    # ★ 复用上面已经跑过的 obs_runs，不重跑 —— 重跑既浪费又会引入随机差异
    #   （noul 输出对上下文/批处理敏感），会让「同一份数据算出的两个数对不上」。
    print("\n── 附注：总体方向准确率（**仅 observable**，隐藏真相组不计入）" + "─" * 18)
    o = b = 0
    for c in obs_cases:
        by_name = obs_runs.get(c["id"])
        if by_name is None:
            continue
        k, bad = _check_direction(by_name, c.get("expected_direction"))
        o += k
        b += len(bad)
    print("  observable  %d/%d = %.1f%%（%d 条用例）" % (o, o + b, 100.0 * o / max(1, o + b), len(obs_cases)))
    print("  ★ 这个数**不能**和上一轮的 49.5% / 51.5% 直接比 —— 用例集换了，")
    print("    旧口径里混着 16 条依赖隐藏真相的用例，且断言分布不同。")
    print("    要看趋势必须用同一套用例重跑旧版本，或看逐 signal 的表。")
    if ht_cases:
        print("  hidden_truth %d 条 —— **不计入上面的数字**，单列于上方的参考段" % len(ht_cases))

    # ---- 落盘 -----------------------------------------------------------
    # ★ 每次运行**单独**留一份原始结果（tests/runs/），signal_metrics.json 只保留
    #   该检查点的最新一次。原因：P1 实测同条件三次重跑的 AUC 中位区间 0.013、
    #   最大 0.073 —— 只留最后一次，就等于把「抖动」当成了「结果」，
    #   而且下一步没法算 run-to-run 区间（它需要每一次的原始数字，不能只有均值）。
    # ---- 跑完核对：翻译缓存有没有在运行期间被改写 ----------------------
    # 开跑前已经断言过完备（全命中），所以正常情况哈希不会变；这里是第二道保险 ——
    # 「条件不可能变」不该靠推理，应该有一个能被观察到的事实。
    _cache_sha_after = (hashlib.sha256(_XLATE_DISK.read_bytes()).hexdigest()
                        if _XLATE_DISK.exists() else None)
    _cache_changed = _cache_sha_after != _cache_sha
    if _cache_changed:
        print("\n★★★ 警告：翻译缓存在本次运行**期间被改写**（%s → %s）。"
              "本次运行的条件与其它运行不一致，不能直接合并比较。"
              % ((_cache_sha or "")[:16], (_cache_sha_after or "")[:16]))

    _cb = checkpoint_budget() or (None, None, None)
    _room = (_cb[0] - _cb[1] - 1) if _cb[0] else None
    _toks = [b["tokens"] for b in budgets.values() if b]
    validity = {
        "_readme": ["req.5：任何输入被截断 / 未被有效呈现的用例，必须从能力对比中剔除，并单独列出。",
                    "两类 invalid：(a) state 溢出被 st[:room] 静默截断；"
                    "(b) 翻译缓存缺失 → message 字段是中文原文。",
                    "★ 只报「剔除了几条」不算达标 —— 必须能说出是哪几条、为什么。"],
        "max_len": _cb[0], "head_max_len": _cb[1], "room": _room,
        "cache_sha": _cache_sha, "cache_changed_during_run": _cache_changed,
        "n_items_measured": len(budgets),
        "token_min": min(_toks) if _toks else None,
        "token_median": sorted(_toks)[len(_toks) // 2] if _toks else None,
        "token_max": max(_toks) if _toks else None,
        "n_overflow": sum(1 for b in budgets.values() if b and b.get("overflow")),
        "passed": {"observable": [len(obs_cases), len(obs_cases_all)],
                   "hidden_truth": [len(ht_cases), len(ht_cases_all)],
                   "contextual": [len(ctx_cases), len(ctx_cases_all)]},
        "invalid": invalid,
    }
    out = {"_readme": ["由 python laya_bridge.py signalmetrics 生成。不要手改。",
                       "主结论 = discrimination 段（**仅 observable**）与 contextual 段。",
                       "hidden_truth 段只是参考上限，绝不用来给 signal 定级或定阈值。",
                       "总体 accuracy 只在 observable_accuracy 里，且不与旧口径可比。",
                       "validity.invalid 里的用例已从以上所有主结论中剔除。"],
           "run_id": run_id,
           "model": model, "device": ENGINE.device_label(),
           "noise_floor": _NOISE_FLOOR, "bootstrap": {"n": _BOOT_N, "seed": _BOOT_SEED},
           "discrimination": report, "contextual": ctx_report, "final_grades": final,
           "hidden_truth_reference": ht_report,
           "observable_accuracy": {"passed": o, "total": o + b,
                                   "rate": round(o / max(1, o + b), 4),
                                   "n_cases": len(obs_cases),
                                   "comparable_with_previous_round": False,
                                   "why": "用例集已重建，与第二轮 48 条口径不可直接比较。"},
           "validity": validity,
           "counts": dict((k, len(v[1])) for k, v in sets.items()),
           "n_assertions": {"observable": n_obs_assert, "hidden_truth": n_ht_assert}}
    if invalid:
        print("\n── 单独列出：本次被剔除的 invalid 用例（**不进任何主结论**）" + "─" * 14)
        for r in invalid:
            print("  [%s/%s/%s] tokens=%s ｜ %s"
                  % (r["set"], r["id"], r["role"], r.get("tokens"), "；".join(r["reasons"])))
    try:
        runs_dir = TESTS_DIR / "runs"
        runs_dir.mkdir(parents=True, exist_ok=True)
        raw = dict(out, budgets=budgets)
        rp = runs_dir / ("%s__%s.json" % (model, run_id))
        rp.write_text(json.dumps(raw, ensure_ascii=False, indent=1), encoding="utf-8")
        print("\n本次运行的原始结果已单独留档：tests/runs/%s" % rp.name)
    except Exception as e:
        print("\n写入 tests/runs/ 失败：%r" % e)
    try:
        p = TESTS_DIR / "signal_metrics.json"
        try:
            blob = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            blob = {}
        blob.setdefault("runs", {})[model] = out
        for k, v in out.items():
            if k != "runs":
                blob[k] = v
        p.write_text(json.dumps(blob, ensure_ascii=False, indent=2), encoding="utf-8")
        print("逐 signal 指标已写入 tests/signal_metrics.json（检查点键：%s）" % model)
    except Exception as e:
        print("\n写入 tests/signal_metrics.json 失败：%r" % e)
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
    if len(sys.argv) > 1 and sys.argv[1] == "signalmetrics":
        return cmd_signalmetrics()
    if len(sys.argv) > 1 and sys.argv[1] == "capability":
        return cmd_capability()
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
    print("自检：qcheck 问题集预算 ｜ signaltest 决策方向回归 ｜ signalmetrics 逐 signal 指标+分级 "
          "｜ personatest 人格对照 ｜ ckptcompare 检查点对照 ｜ bench 性能")
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
