"""Turn Interpreter：把玩家自然语言归一化成结构化意图（任务书 §4/§5）。

三条铁律：
  1. **不做关键词匹配**。主通道是 LLM 语义归一化（DeepSeek），天然覆盖否定、
     隐喻、多意图、多目标；旧关键词表（laya_bridge._EVIDENCE_STOP_WORDS 等）
     只保留在 legacy 路径里，本模块**不 import、不 fallback 到关键词**。
  2. **fail-closed**。LLM 不可用 / 输出格式异常 → 重试一次 → 仍失败就降级到
     **Laya-only 粗粒度事件**（结构化信号映射），再不行 → neutral_fallback
     （不做任何裁决，由 Laya 原生增量路径接管）。绝不把未解析的语义当成功。
  3. **不写任何状态**。本模块输出 TurnInterpretation，纯数据。

LLM 输出契约（严格 JSON）：
  {"intents": [{"type": <INTENT_TYPES>, "targets": [..], "objects": [..],
                "tone": [..], "confidence": 0~1, "quote": "..."}],
   "tone": [..]}
解析失败的 JSON 直接判降级，不做"猜一层"的宽松解析（宽松解析 = fail-open）。
"""
import json
import os
import time
import urllib.request

from .schemas import INTENT_TYPES, Intent, TurnInterpretation

# Laya-only 降级通道的信号→事件映射（粗粒度；只在 LLM 不可用时使用）。
# 量纲：signals 是 prob 0~1（signal_snapshot 的 kind=prob）。
_LAYA_FALLBACK_RULES = (
    # (事件类型, 判定函数, 目标缺省, 置信度取法)
    ("information_handover", lambda s: s.get("disclose", 0.0) >= 0.5,
     lambda s: min(1.0, s.get("disclose", 0.0) * 1.2)),
    ("hostility", lambda s: s.get("hostility", 0.0) >= 0.5,
     lambda s: min(1.0, s.get("hostility", 0.0))),
    ("cooperation", lambda s: s.get("cooperation", 0.0) >= 0.55,
     lambda s: min(1.0, s.get("cooperation", 0.0))),
    ("question", lambda s: s.get("investigate", 0.0) >= 0.6,
     lambda s: min(1.0, s.get("investigate", 0.0))),
)

_SYSTEM_PROMPT = """你是一个文字冒险游戏的回合意图分析器。把玩家的原话归一化为结构化意图。

语义类别（type 只能取以下值）：
- violence: 直接动手（攻击、夺抢、强行闯入）
- threat: 言语或姿态威胁（包括隐喻威胁，如"祈祷太阳还能升起来"）
- evidence_handover: 交出或出示实物证据（徽章、名单、信件等实物）
- information_handover: 交代信息、坦白、告知位置/去向（不需要实物）
- cooperation: 主动配合、示好、提供帮助
- apology: 道歉、退让、软化态度
- hostility: 敌意态度表达（不构成具体威胁的敌对）
- question: 提问、探询
- challenge: 激将、质问、挑衅（要求对方证明或回应）
- neutral: 中性陈述或闲聊
- other: 以上都不匹配

判定要求：
1. 一轮可以有多个意图，全部列出，按显著性排序。
2. 否定句不产生被否定的意图："我不会伤害你"绝不能是 violence。
3. 隐喻和潜台词要识别："你最好祈祷太阳还能升起来"是 threat。
4. "把徽章扔到桌上让她自己验" 同时是 evidence_handover 和 challenge。
5. targets 是行为指向的人（NPC 名或 "player"）；objects 是涉及的物件名词。
6. confidence 是你对该意图判断的置信度 0~1；quote 是支撑判断的原话片段（≤20字）。

只输出 JSON，不要任何其他文字，格式：
{"intents": [{"type": "...", "targets": [], "objects": [], "tone": [], "confidence": 0.0, "quote": ""}], "tone": []}"""


class InterpretationFailure(Exception):
    """LLM 归一化失败（含格式异常）。调用方应走降级链，不得 fail-open。"""


def _llm_available() -> bool:
    return bool(os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("LLM_API_KEY"))


def _chat_json(sys_prompt: str, user_prompt: str, temperature: float = 0.1,
               max_tokens: int = 900) -> dict:
    """调 DeepSeek 并要求严格 JSON。任何异常都抛 InterpretationFailure。"""
    key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("LLM_API_KEY")
    base = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com").rstrip("/")
    model = os.environ.get("LLM_MODEL", "deepseek-flash")
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": sys_prompt},
                     {"role": "user", "content": user_prompt}],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
        "response_format": {"type": "json_object"},
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        base + "/chat/completions", data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
        method="POST")
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=60) as r:
        blob = json.loads(r.read().decode("utf-8"))
    content = ((blob.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    try:
        parsed = json.loads(content)
    except Exception:
        raise InterpretationFailure("llm content is not JSON: %r" % content[:120])
    if not isinstance(parsed, dict):
        raise InterpretationFailure("llm JSON top-level is not object")
    parsed["_latency_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    return parsed


def _validate_llm_payload(parsed: dict) -> dict:
    """白名单校验：类别必须合法、数值钳制、字段形状修正。失败抛异常。"""
    intents_raw = parsed.get("intents")
    if not isinstance(intents_raw, list) or not intents_raw:
        raise InterpretationFailure("intents missing or empty")
    if len(intents_raw) > 6:
        intents_raw = intents_raw[:6]          # 防刷屏；一轮超 6 个意图没有意义
    intents = []
    for it in intents_raw:
        if not isinstance(it, dict):
            continue
        t = it.get("type")
        if t not in INTENT_TYPES:
            continue                            # 幻觉类别直接丢弃，不猜
        conf = it.get("confidence")
        conf = float(conf) if isinstance(conf, (int, float)) else 0.5
        conf = max(0.0, min(1.0, conf))
        targets = [str(x) for x in (it.get("targets") or [])][:4]
        objects = [str(x) for x in (it.get("objects") or [])][:4]
        tone = [str(x) for x in (it.get("tone") or [])][:4]
        quote = str(it.get("quote") or "")[:40]
        intents.append(Intent(type=t, targets=targets, objects=objects,
                              tone=tone, confidence=conf, source="llm", quote=quote))
    if not intents:
        raise InterpretationFailure("no valid intents after whitelist")
    tone = [str(x) for x in (parsed.get("tone") or [])][:4]
    return {"intents": intents, "tone": tone}


def interpret_via_llm(text: str, actor_name: str = "") -> TurnInterpretation:
    """主通道：LLM 归一化（带一次重试）。失败抛 InterpretationFailure。"""
    if not _llm_available():
        raise InterpretationFailure("no llm api key")
    user_p = "NPC 对手：%s\n玩家原话：%s" % (actor_name or "（未命名）", text)
    last_err = None
    for attempt in range(2):
        try:
            parsed = _chat_json(_SYSTEM_PROMPT, user_p,
                                temperature=0.1 if attempt == 0 else 0.0)
            ok = _validate_llm_payload(parsed)
            return TurnInterpretation(text=text, intents=ok["intents"],
                                      tone=ok["tone"], source="llm",
                                      notes=["llm_latency_ms=%s" % parsed.get("_latency_ms")])
        except InterpretationFailure as e:
            last_err = e
            continue
        except Exception as e:                  # 网络/超时/HTTP 错误
            last_err = InterpretationFailure("llm call failed: %r" % e)
            continue
    raise last_err or InterpretationFailure("llm interpret failed")


def interpret_via_laya(text: str, laya_signals: dict) -> TurnInterpretation:
    """降级通道 1：Laya-only 粗粒度事件（结构化信号映射，非关键词）。

    只在 LLM 不可用/失败时使用；产出意图无 objects/quote（信息量降级，
    Resolver 会看到 source=laya 并保守结算）。
    """
    s = laya_signals or {}
    intents = []
    for intent_type, hit, conf_fn in _LAYA_FALLBACK_RULES:
        try:
            if hit(s):
                intents.append(Intent(type=intent_type, targets=[],
                                      confidence=round(conf_fn(s), 3), source="laya"))
        except Exception:
            continue
    if not intents:
        # Laya 信号也不显著 → 不裁决（neutral），让 Laya 原生增量路径接管。
        # source 用 neutral_fallback 而非 laya_only：laya_only 表示
        # "用 Laya 信号产出了意图"；这里没有产出，是彻底的不裁决。
        return TurnInterpretation(text=text,
                                  intents=[Intent(type="neutral", confidence=0.3)],
                                  source="neutral_fallback",
                                  notes=["degraded: no significant laya signals"])
    return TurnInterpretation(text=text, intents=intents, tone=[],
                              source="laya_only",
                              notes=["degraded: llm unavailable, laya signals only"])


def interpret_turn(text: str, laya_signals: dict, actor_name: str = "") -> TurnInterpretation:
    """编排主/降级链。返回值永远合法；降级路径记录在 source/notes。"""
    if not (text or "").strip():
        return TurnInterpretation(text=text or "",
                                  intents=[Intent(type="neutral", confidence=0.2)],
                                  source="neutral_fallback",
                                  notes=["empty player input"])
    try:
        return interpret_via_llm(text, actor_name=actor_name)
    except InterpretationFailure as e:
        interp = interpret_via_laya(text, laya_signals or {})
        interp.notes.append("llm_failed: %s" % e)
        return interp
