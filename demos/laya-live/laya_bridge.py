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


class LayaEngine:
    def __init__(self):
        self.kind = "unavailable"
        self.detail = ""
        self.obj = None
        self.load_ms = 0
        self.last_error = ""
        self.local_models = {}
        self.model_name = None

    def init(self):
        t0 = time.time()
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

    def describe(self):
        out = {
            "kind": self.kind,
            "ready": self.ready,
            "detail": self.detail,
            "load_ms": self.load_ms,
            "model_name": self.model_name,
            "local_models": sorted(self.local_models),
            "models_dir": str(MODELS_DIR),
        }
        if self.last_error:
            out["last_error"] = self.last_error
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

    为什么需要这一步 —— 四轮实测的结论：
      · score 与 noul 是 Laya **校准过**的原语。noul 直接给 P(true)（0~1），
        跨输入可比、有明确语义；实测「玩家拔刀要杀她」时 leave 的 noul = 0.739，
        而「玩家辱骂骑士团」时 leave = 0.216 —— 信号清晰。
      · choice 即便把选项压短，区分度仍然偏弱，argmax 容易停在先验吸引子上
        （七个长选项下，四个语义相反的输入全选中 confide）。

    所以分工是：choice 出**基础分布**（保留选项间相对次序，前端画分布图仍有意义），
    noul 门限在信号很强时改写**最终行为**。阈值取保守值（0.70~0.85），
    只在证据明确时才覆盖，平时完全不干预 choice 的判断 —— 宁可漏，不可乱改。
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

    为什么不是 desc_en：实测用长描述当选项时，某个选项会变成先验吸引子。
    7 个长选项下，「她主动交出秘密」对「玩家拔刀要杀她」与「玩家辱骂骑士团」
    都是 argmax —— 四个语义相反的输入给同一个答案。压成短标签后 argmax 才开始
    随输入移动。所以这里只认 short_en，缺了才退回 id。
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


def build_state_doc(actor, player_input, history, scene, world_state=None, player_input_en=None):
    """构造喂给 Laya 的决策文档。

    ★ state_format = "compact"（默认，实测有效）
      早期用的是 12 字段嵌套 JSON（role/name/identity/personality_axes/traits/emotion/
      relationship_to_player/goals/situation/scene/recent_conversation/player_says）。
      问题有两个，都是实测出来的：
        1. 没有锚点。instructions 里写 "this sentence"，模型无法知道指的是哪个字段；
           而 Laya 自带 presets 的写法是反引号引用键名（`message`），state 就是含该键的 dict。
        2. token 全花在长键名和嵌套缩进上。英文检查点可用余量只有 354 token，
           12 字段形态要 367 token → 直接溢出被 build_sequence 截掉尾巴。
      compact 形态把状态压成几句话 + 一个 `message` 键，既给了锚点又留足余量。

    ★ state_format = "full" 保留为对照，方便复现早期「无区分度」的实测结果。
    """
    sit = actor.get("situation", {}) or {}
    fmt = CFG.get("state_format", "compact")

    if fmt == "compact":
        t = actor.get("traits", {}) or {}
        e = actor.get("emotion", {}) or {}
        r = actor.get("relationship", {}) or {}
        g = actor.get("goals", {}) or {}
        if LANG == "en":
            doc = {
                "npc": ("%s, %s. Traits: %s. Currently %s."
                        % (actor.get("name_en") or actor.get("name"),
                           actor.get("identity_en") or actor.get("identity"),
                           ", ".join("%s %.2f" % (k, v) for k, v in t.items()),
                           ", ".join("%s %.2f" % (k, v) for k, v in e.items()))),
                "relationship": ("trust %s/100, respect %s/100, doubt %s/100, reliance %s/100"
                                 % (r.get("trust"), r.get("respect"), r.get("doubt"), r.get("reliance"))),
                "goals": ", ".join("%s %.2f" % (k, v) for k, v in g.items()),
                "scene": ("%s, %s. Risk %.2f. %s"
                          % (sit.get("place_en") or sit.get("place"),
                             sit.get("time_en") or sit.get("time"), sit.get("risk", 0),
                             (scene or {}).get("note_en") or (scene or {}).get("note", ""))),
            }
            convo = ["%s: %s" % ("Player" if h.get("role") == "player" else (actor.get("name_en") or "NPC"),
                                 h.get("text_en") or h.get("text", ""))
                     for h in (history or [])[-6:]]
            doc["message"] = player_input_en if player_input_en is not None else player_input
        else:
            doc = {
                "npc": ("%s，%s。特质：%s。当前：%s。"
                        % (actor.get("name"), actor.get("identity"),
                           "，".join("%s %.2f" % (k, v) for k, v in t.items()),
                           "，".join("%s %.2f" % (k, v) for k, v in e.items()))),
                "relationship": ("信任 %s/100，尊敬 %s/100，怀疑 %s/100，依赖 %s/100"
                                 % (r.get("trust"), r.get("respect"), r.get("doubt"), r.get("reliance"))),
                "goals": "，".join("%s %.2f" % (k, v) for k, v in g.items()),
                "scene": ("%s，%s。风险 %.2f。%s"
                          % (sit.get("place"), sit.get("time"), sit.get("risk", 0),
                             (scene or {}).get("note", ""))),
            }
            convo = ["%s：%s" % ("玩家" if h.get("role") == "player" else actor.get("name", "NPC"),
                                 h.get("text", "")) for h in (history or [])[-6:]]
            doc["message"] = player_input
        if convo:
            doc["conversation"] = convo
        if world_state:
            doc["world_state"] = world_state
        return doc

    # ---- full：早期形态，留作对照 ----
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
            "recent_conversation": [
                "%s: %s" % ("Player" if h.get("role") == "player" else (actor.get("name_en") or "NPC"),
                            h.get("text_en") or h.get("text", ""))
                for h in (history or [])[-6:]
            ],
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
            "recent_conversation": [
                "%s：%s" % ("玩家" if h.get("role") == "player" else actor.get("name", "NPC"), h.get("text", ""))
                for h in (history or [])[-6:]
            ],
            "player_says": player_input,
        }
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
def decide(payload):
    actor = payload.get("actor") or CFG["actor"]
    history = payload.get("history") or []
    player_input = (payload.get("player_input") or "").strip()
    world_state = payload.get("world_state") or CFG["world"]["state"]
    questions = payload.get("questions") or CFG["questions"]
    seed = payload.get("seed")

    t0 = time.perf_counter()

    # ---- 语言桥：Laya 只吃英文。客户端若已带上 text_en 就复用，否则现翻。----
    player_input_en = payload.get("player_input_en")
    xlate_src = "client" if player_input_en else ("n/a" if LANG != "en" else None)
    xlate_ms = 0.0
    if player_input_en is None and LANG == "en":
        tx0 = time.perf_counter()
        player_input_en, xlate_src = translate_to_en(player_input)
        xlate_ms = (time.perf_counter() - tx0) * 1000

    state_doc = build_state_doc(actor, player_input, history, CFG.get("scene"), world_state,
                                player_input_en=player_input_en)

    # 世界层问题跟 NPC 层一起问；state 里已经带了 world_state
    all_questions = dict(questions)
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

    behavior_id = pick("npc_behavior")
    # ★ choice 给基础分布，noul 门限做覆盖（见 apply_gates 的说明）
    behavior_id, gate_hit = apply_gates(answers, behavior_id)
    bh = next((b for b in CFG["behaviors"] if b["id"] == behavior_id), None)

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
    return {
        "engine": engine_used,
        "engine_detail": ENGINE.detail if engine_used == "laya" else (ENGINE.detail or "未安装 laya"),
        "confidence_reliable": engine_used == "laya",
        "latency_ms": round(latency_ms, 2),
        "lang": LANG,
        "player_input_en": player_input_en,
        "translate": {"source": xlate_src, "ms": round(xlate_ms, 1)},
        "latency_breakdown": {"translate_ms": round(xlate_ms, 1),
                              "decide_ms": round(max(0.0, latency_ms - xlate_ms), 2)},
        "routing": routing,
        "answers": answers,
        "raw": meta_raw,
        "state_doc": state_doc,
        "state_line": state_line(actor),
        "attribution": attribution_meta,
        "deltas": deltas,
        "director": director,
        "decision": {
            "behavior": None if not bh else {
                "id": bh["id"], "name": bh["name"], "desc": bh["desc"], "instr": bh.get("instr", ""),
                "confidence": conf,
                "probabilities": answers.get("npc_behavior", {}).get("_probabilities"),
                "gated_by": gate_hit,
                "choice_pick": (gate_hit or {}).get("choice_said") or behavior_id,
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
    return {"engine": engine_used, "latency_ms": round(latency_ms, 2), "threshold": thr,
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
                "questions": list(CFG["questions"].keys()) + list(CFG["world"]["questions"].keys()),
                "behaviors": [b["id"] for b in CFG["behaviors"]],
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
            return self._json({"turns": [d for d in _HISTORY]})
        return self._json({"error": "not found",
                           "try": ["/health", "/config", "/demo", "/decide", "/narrate", "/world",
                                   "/predict"]}, 404)

    def do_POST(self):
        path = self.path.split("?")[0]
        payload = self._read()

        if path == "/decide":
            try:
                out = decide(payload)
            except Exception as e:
                return self._json({"error": repr(e)}, 500)
            _HISTORY.append({"t": time.time(), "player": payload.get("player_input"),
                             "engine": out["engine"], "behavior": (out["decision"]["behavior"] or {}).get("id")})
            del _HISTORY[:-50]
            return self._json(out)

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
                r = llm_narrate(actor, bh, payload.get("player_input", ""),
                                payload.get("history") or (pre or {}).get("history"),
                                payload.get("state_line")
                                or (pre or {}).get("state_line") or state_line(actor),
                                bool(payload.get("include_reasoning")))
                if r and not r.get("error"):
                    return self._json(dict(r, **({"decision": pre} if pre else {})))
                if r and r.get("error"):
                    fb = pool_line(bh, payload.get("player_input", ""))
                    fb["llm_error"] = r["error"]
                    fb["llm_meta"] = {k: r.get(k) for k in ("model", "effort", "latency_ms",
                                                            "reasoning_tokens", "completion_tokens",
                                                            "retried")}
                    # 把污染原文留在响应里：这是排查「台词为什么退化成池子」的唯一线索
                    if r.get("raw_content_first"):
                        fb["llm_meta"]["raw_content_first"] = r["raw_content_first"][:800]
                    return self._json(dict(fb, **({"decision": pre} if pre else {})))
            fb = pool_line(bh, payload.get("player_input", ""))
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
    for lang in ("en", "zh"):
        globals()["LANG"] = lang
        doc = build_state_doc(CFG["actor"], SAMPLE_INPUT_EN if lang == "en" else SAMPLE_INPUT_ZH,
                              [{"role": "player", "text": SAMPLE_INPUT_ZH, "text_en": SAMPLE_INPUT_EN}],
                              CFG.get("scene"), CFG["world"]["state"],
                              player_input_en=SAMPLE_INPUT_EN)
        txt = doc if isinstance(doc, str) else json.dumps(doc, ensure_ascii=False)
        n = len(tok(txt, add_special_tokens=False)["input_ids"])
        mark = "★ 溢出！尾部会被 st[:room] 静默截断" if n > room else "OK（余量 %d token）" % (room - n)
        print("  state_format=%-7s 语言 %s → %d token  %s"
              % (CFG.get("state_format", "compact"), lang, n, mark))
        if n > room:
            problems.append("state_doc(%s)" % lang)
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

    print("正在初始化 Laya ...（未安装会直接走回退引擎）")
    ENGINE.init()
    if ENGINE.ready:
        print("  Laya 就绪：%s（加载 %d ms）" % (ENGINE.detail, ENGINE.load_ms))
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
    print("  POST /decide    单轮决策：state + questions → 概率 / 增量 / 导演裁决")
    print("  POST /narrate   按选中的行为生成台词（LLM 或台词池；不传 behavior 会自动先 decide）")
    print("  POST /world     世界层事件概率")
    print("  POST /predict   原始透传，直接调 Laya")
    print("\n演示页：%s/demo    （?auto=7 会触发 gate_ally 门限覆盖，最适合看那套机制）" % url)
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
