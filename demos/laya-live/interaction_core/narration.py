"""Story Agent：把 Canonical Outcome 演成剧情（任务书 §11）。

边界执行：
  1. prompt 由 outcome.narration_contract 驱动 —— 必须体现的结果、允许的自由度、
     语义禁区全部写进 system prompt；
  2. 生成后做 contract check：must_not_include 里的短语不得出现在台词里
     （这是对**模型输出**的输出过滤，不是对玩家输入的语义判定）；
  3. 违约时降温重试一次，仍违约 → 返回带 violation 标记的结果，
     调用方（pipeline）绝不静默放行。

LLM 传输与 laya_bridge.llm_narrate 同源（DeepSeek chat/completions），
但 prompt 构造独立 —— 故意不共用 _build_narrate_prompt：Story Agent 的
输入契约是 Outcome，不是 behavior/state_line。
"""
import json
import os
import re
import time
import urllib.request
from typing import Any, Dict, List, Optional

from .schemas import CanonicalOutcome

_SYSTEM_PROMPT = """你是一个文字冒险游戏的叙事者（Story Agent）。系统已经裁决了本轮行动的结果，你的任务是把**已经发生的结果**写成自然剧情。

铁律：
1. 你只决定措辞、节奏、动作细节，**绝不改写结果**：结果是什么档位就是什么档位。
2. 必须体现「必须体现」里的每一条事实。
3. 不得出现「语义禁区」里的任何含义。
4. 台词用「」包裹，配少量动作或环境描写，2~4 句，不列点。
5. 只写 NPC 的外部言行和你能看到的环境；不替玩家说话、不替玩家决定。
6. 用中文。

格式：把最终回应原文放进 <line> 与 </line> 之间，标签之外一个字符都不要写。"""


def _line_tag(prompt_body: str) -> str:
    return prompt_body.strip()


def _extract_line(content: str) -> Optional[str]:
    m = re.search(r"<line>(.*?)</line>", content or "", re.S)
    if m:
        return m.group(1).strip()
    return None


def _chat(sys_prompt: str, user_prompt: str, temperature: float) -> Dict[str, Any]:
    key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("LLM_API_KEY")
    if not key:
        return {"error": "no api key"}
    base = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com").rstrip("/")
    model = os.environ.get("LLM_MODEL", "deepseek-flash")
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": sys_prompt},
                     {"role": "user", "content": user_prompt}],
        "temperature": temperature,
        "max_tokens": 1200,
        "stream": False,
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        base + "/chat/completions", data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
        method="POST")
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            blob = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return {"error": "llm call failed: %r" % e}
    content = ((blob.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    return {"content": content, "latency_ms": round((time.perf_counter() - t0) * 1000, 1)}


def check_contract(line: str, must_not: List[str]) -> List[str]:
    """输出过滤：返回台词里命中的禁区短语（空 = 合规）。"""
    if not line:
        return []
    return [bad for bad in (must_not or []) if bad and bad in line]


def narrate_from_outcome(outcome: CanonicalOutcome, player_input: str,
                         actor: Dict[str, Any],
                         history: Optional[List[Dict[str, str]]] = None) -> Dict[str, Any]:
    """按 Outcome 的 narration contract 生成剧情。

    返回 {line, contract_violations, attempts, model} 或 {line: None, error}。
    违约重试一次（降温）；仍违约则如实带 violation 返回，绝不静默改写结果。
    """
    contract = outcome.narration_contract
    who = actor.get("name", "NPC")
    convo = ""
    for h in (history or [])[-6:]:
        role = "玩家" if h.get("role") in ("player", "user") else who
        convo += "%s：%s\n" % (role, h.get("content") or h.get("text") or "")

    user_p = (
        "【本轮裁决（不可改写）】\n"
        "结果档位：%s\n结果一句话：%s\n"
        "必须体现：\n%s\n"
        "语义禁区（任何一条的含义都不得出现）：\n%s\n\n"
        "【允许的自由度】\n%s\n\n"
        "【人物】%s，%s\n【前文】%s\n【玩家原话】%s\n\n"
        "请写出她此刻的回应。"
        % (outcome.degree.label, outcome.result,
           "\n".join("- " + m for m in contract.must_include),
           "、".join(contract.must_not_include) or "（无）",
           "；".join(contract.may_include),
           who, actor.get("identity", ""),
           convo or "（无）", player_input))

    attempts = []
    for temp in (0.8, 0.2):
        r = _chat(_SYSTEM_PROMPT, user_p, temp)
        if r.get("error"):
            return {"line": None, "error": r["error"], "attempts": attempts}
        line = _extract_line(r.get("content") or "")
        if not line:
            # 无标签 → 降温重试前的宽容提取：直接取全文首段（防模型丢标签）
            line = (r.get("content") or "").strip().split("\n")[0][:400] or None
        violations = check_contract(line, contract.must_not_include)
        attempts.append({"temperature": temp, "violations": violations,
                         "latency_ms": r.get("latency_ms")})
        if line and not violations:
            return {"line": line, "contract_violations": [],
                    "attempts": attempts, "model": os.environ.get("LLM_MODEL", "deepseek-flash")}
        if line and violations:
            continue          # 违约 → 降温重试
    # 两次都不干净：如实返回（调用方决定是否展示），绝不静默放行
    return {"line": line, "contract_violations": violations,
            "attempts": attempts, "model": os.environ.get("LLM_MODEL", "deepseek-flash")}
