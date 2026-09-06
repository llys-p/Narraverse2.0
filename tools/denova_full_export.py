# -*- coding: utf-8 -*-
"""Narraverse -> Denova lossless manual export jobs.

The existing bounded sync/export path intentionally stays in denova_bridge.py.
This module owns only explicit, user-triggered, full-fidelity migrations.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from difflib import SequenceMatcher
from pathlib import Path


FORMAT_VERSION = 4
MANIFEST_VERSION = 1
PART_LIMIT = 8 * 1024 * 1024
TRANSCRIPT_TARGET_BYTES = 512 * 1024
DEFAULT_TRANSLATION_MODEL = "hy-mt1.5:1.8b-q4_k_m"
OLLAMA_URL = "http://127.0.0.1:11434"
TRANSLATION_CACHE_VERSION = 12
TRANSLATION_PROMPT_VERSION = 9
TRANSLATION_VALIDATOR_VERSION = 9
TRANSLATION_QUALITY_CONTRACT_VERSION = 2
TRANSLATION_CHUNK_TARGET = 720
TRANSLATION_CHUNK_MAX = 1200
QUALITY_REASONS = {
    "empty_output": "模型返回了空内容",
    "source_echo": "模型回显了英文原文",
    "mixed_language": "译文中残留连续英文句段",
    "missing_cjk": "译文缺少中文内容",
    "placeholder_mismatch": "受保护占位符或变量不完整",
    "structure_mismatch": "译文结构或长度异常",
    "bridge_or_model_error": "模型调用失败或返回拒绝话术",
}
HY_MT_REPO = "tencent/HY-MT1.5-1.8B-GGUF"
HY_MT_FILE = "HY-MT1.5-1.8B-Q4_K_M.gguf"
HY_MT_PUBLISHED_SIZE = 1133080512
HY_MT_PUBLISHED_SHA256 = "4383ac0c3c8e476de98ff979c2a3f069f8c4fb385e7860cf2d28da896cc477c7"


class ExportPaused(Exception):
    pass


class ExportCancelled(Exception):
    pass


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()) + "+08:00"


def safe_name(value: object, fallback: str = "未命名冒险") -> str:
    text = re.sub(r'[\\/:*?"<>|\r\n]', "_", str(value or fallback)).strip()
    return text[:80] or fallback


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_json(value: object) -> str:
    return sha256_bytes(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def valid_translation_field_path(value: str) -> bool:
    """Accept Master field paths without allowing arbitrary path traversal."""
    if len(value or "") > 200:
        return False
    dotted = re.fullmatch(
        r"[A-Za-z][A-Za-z0-9_]*(?:(?:\.[A-Za-z][A-Za-z0-9_]*)|(?:\[[0-9]+\]))*",
        value or "",
    )
    nested_entry = re.fullmatch(
        r"(?:character_book|lorebook)\.entries/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/(?:comment|content|keys|secondary_keys)",
        value or "",
    )
    return bool(dotted or nested_entry)


def translation_job_completion_status(apply_policy: str) -> str:
    # 质量 pass 的任务仍需遵守应用策略：旧 Lore 正文和 Master 高风险字段交人工确认；
    # 只有 auto_apply_metadata / master_auto 可以进入前端自动写回流程。
    return "pending_review" if apply_policy in {"review_content", "master_review"} else "completed"


def load_json(path: Path, default):
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return default


def atomic_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex[:8])
    with temp.open("wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    for attempt in range(8):
        try:
            os.replace(str(temp), str(path))
            return
        except PermissionError:
            if attempt == 7:
                try: temp.unlink()
                except OSError: pass
                raise
            time.sleep(.01 * (attempt + 1))


def atomic_text(path: Path, text: str) -> None:
    atomic_bytes(path, text.encode("utf-8"))


def atomic_json(path: Path, value: object) -> None:
    atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def content_hash(item: dict) -> str:
    tracked = {key: item.get(key) for key in (
        "enabled", "type", "name", "importance", "tags", "brief_description",
        "keywords", "load_mode", "content", "provenance",
    )}
    return sha256_json(tracked)


def stable_id(sync_id: str, source_id: str, group: str) -> str:
    digest = hashlib.sha256((sync_id + "\n" + source_id + "\n" + group).encode("utf-8")).hexdigest()[:24]
    return "nv-" + digest


def infer_type(text: str) -> str:
    value = (text or "")[:500]
    if re.search(r"角色|人物|character|npc", value, re.I): return "character"
    if re.search(r"地点|位置|location|城市|村庄|大陆", value, re.I): return "location"
    if re.search(r"势力|组织|faction|家族|氏族", value, re.I): return "faction"
    if re.search(r"规则|机制|系统|检定|rule|system", value, re.I): return "rule"
    if re.search(r"物品|道具|item|武器|装备|法器", value, re.I): return "item"
    return "world"


def unwrap_card(value: object) -> dict:
    if not isinstance(value, dict):
        return {}
    data = value.get("data")
    if isinstance(data, dict) and (data.get("name") or value.get("spec") == "chara_card_v2"):
        return data
    return value


def text_value(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, indent=2)
    return str(value).strip()


def list_value(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if value:
        return [item.strip() for item in re.split(r"[,，、]", str(value)) if item.strip()]
    return []


def card_name(raw: object) -> str:
    data = unwrap_card(raw)
    return str(data.get("name") or data.get("名字") or "").strip()


def lore_entries(raw: object) -> list[dict]:
    if not isinstance(raw, dict):
        return []
    source = raw.get("entries") or {}
    values = list(source.values()) if isinstance(source, dict) else source if isinstance(source, list) else []
    if not values and text_value(raw.get("content") or raw.get("description")):
        values = [{
            "uid": raw.get("id", 0), "key": [raw.get("title") or raw.get("name") or "设定书"],
            "content": raw.get("content") or raw.get("description"), "comment": raw.get("title") or raw.get("name") or "设定书",
        }]
    result = []
    for index, entry in enumerate(values):
        if not isinstance(entry, dict):
            continue
        content = text_value(entry.get("content"))
        keys = list_value(entry.get("key"))
        if not keys:
            comment = text_value(entry.get("comment"))
            keys = [comment or "条目-%d" % (index + 1)]
        result.append({
            "source_entry_id": str(entry.get("uid") if entry.get("uid") is not None else index),
            "keys": keys,
            "content": content,
            "enabled": not bool(entry.get("disable") or entry.get("disabled")),
            "order": entry.get("order", index),
            "comment": text_value(entry.get("comment")),
            "secondary_keys": list_value(entry.get("keysecondary")),
            "raw": entry,
        })
    return result


def normalize_material_raw(raw: object, material_type: str = "") -> object:
    """Unwrap embedded upload previews before source matching or lore mapping."""
    value = raw
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:
            return raw
    if not isinstance(value, dict):
        return value
    if material_type != "character_card":
        content = value.get("content")
        if isinstance(content, str):
            try:
                parsed = json.loads(content)
                if isinstance(parsed, dict) and (parsed.get("entries") or parsed.get("name")):
                    return parsed
            except Exception:
                pass
    return value


def truncation_count(raw: object) -> int:
    text = text_value(raw)
    markers = (
        "内容已截断",
        "完整版见 ai知识库",
        "Content truncated",
        "Full version available in",
        "Content truncated. Full version",
    )
    return sum(text.count(marker) for marker in markers)


def short_brief(content: str, item_type: str, name: str) -> str:
    compact = re.sub(r"\s+", " ", content or "").strip()
    return ("%s %s。%s" % (item_type, name, compact[:180])).strip()


def replace_card_macros(text: str, character: str, player: str) -> str:
    return re.sub(r"\{\{char\}\}", character, text or "", flags=re.I).replace("{{user}}", player or "玩家")


def translate_field(translator, original: str, context: str, check_control, failures: list[dict], material: dict, field: str) -> str:
    if not translator:
        return original
    try:
        return translator.translate(original, context, check_control)
    except (ExportPaused, ExportCancelled):
        raise
    except Exception as error:
        failures.append({"mount_id": material.get("mount_id"), "title": material.get("title"), "field": field, "error": str(error)})
        return original


class LocalTranslator:
    english_word_pattern = re.compile(r"\b[A-Za-z][A-Za-z'-]*\b")
    english_sentence_pattern = re.compile(r"\b[A-Za-z][A-Za-z'-]*(?:[ \t]+[A-Za-z][A-Za-z'-]*){2,}\b")
    protected_token_pattern = re.compile(r"__NV_(?:PROTECTED|EXISTING_ZH)_\d{4}__")
    protected_pattern = re.compile(
        # A slash-delimited expression is protected only when it has no
        # whitespace (or has an explicit regex flag). This avoids treating
        # ordinary prose such as "/Sadistic .../" as a machine regex.
        r"```[\s\S]*?```|`[^`\n]+`|https?://\S+|\{\{[^{}]+\}\}|<[^>]+>|/(?:\\.|[^\s/\n])*(?:\\.|[^A-Za-z0-9_\s/])(?:\\.|[^\s/\n])*/[gimsuy]*"
    )

    def __init__(self, cache_root: Path, glossary_path: Path, model: str = DEFAULT_TRANSLATION_MODEL):
        self.cache_root = cache_root
        self.glossary_path = glossary_path
        self.model = model
        self.cache_root.mkdir(parents=True, exist_ok=True)
        self.glossary = load_json(glossary_path, {"version": 1, "terms": {}, "do_not_translate": []})

    def status(self) -> dict:
        try:
            with urllib.request.urlopen(OLLAMA_URL + "/api/tags", timeout=3) as response:
                data = json.loads(response.read().decode("utf-8"))
            names = [str(item.get("name") or "") for item in data.get("models") or []]
            return {"online": True, "model": self.model, "installed": self.model in names, "models": names}
        except Exception as error:
            return {"online": False, "model": self.model, "installed": False, "error": str(error)}

    def _translation_probe(self, text: str) -> str:
        probe = self.protected_pattern.sub(" ", text or "")
        for term in self.glossary.get("do_not_translate") or []:
            probe = probe.replace(str(term), " ")
        return probe

    @classmethod
    def _english_words(cls, text: str) -> list[str]:
        return cls.english_word_pattern.findall(text or "")

    def needs_translation(self, text: str) -> bool:
        """Use a natural-language signal instead of any Latin character.

        Go has a parallel classifier for Master fields. Keep this rule made of
        small deterministic signals so both implementations can share the same
        examples without introducing a runtime dependency between languages.
        """
        probe = self._translation_probe(text)
        if not probe.strip():
            return False
        words = self._english_words(probe)
        if not words:
            return False
        meaningful = [word for word in words if not (word.isupper() and len(word) <= 8)]
        if re.search(r"(?im)^\s*[A-Za-z][A-Za-z \t/&-]{1,32}\s*[:：]", probe):
            return True
        # A single ordinary English label (for example "Harbor" or "dock")
        # is still a real translation target. Only machine-like tokens are
        # filtered above; short human-facing fields must not disappear.
        if meaningful:
            return True
        return False

    @staticmethod
    def _latin_cjk(text: str) -> tuple[int, int]:
        return (
            len(re.findall(r"[A-Za-z]", text or "")),
            len(re.findall(r"[\u3400-\u9fff]", text or "")),
        )

    @staticmethod
    def _normalized_text(text: str) -> str:
        return re.sub(r"[\W_]+", "", (text or "").lower(), flags=re.UNICODE)

    def _call_model(self, prompt: str) -> str:
        payload = json.dumps({
            "model": self.model, "prompt": prompt, "stream": False,
            "options": {"temperature": 0, "num_ctx": 8192}, "keep_alive": "5m",
        }).encode("utf-8")
        request = urllib.request.Request(OLLAMA_URL + "/api/generate", data=payload, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=180) as response:
            result = json.loads(response.read().decode("utf-8"))
        return str(result.get("response") or "").strip()

    @staticmethod
    def _structure_signature(text: str) -> tuple:
        """Return only stable Markdown structure, not translated wording."""
        headings = tuple(len(match.group(1)) for match in re.finditer(r"(?m)^\s{0,3}(#{1,6})\s+", text or ""))
        ordered = len(re.findall(r"(?m)^\s*\d+[.)]\s+", text or ""))
        unordered = len(re.findall(r"(?m)^\s*[-*+]\s+", text or ""))
        fences = len(re.findall(r"(?m)^\s*```", text or ""))
        horizontal = len(re.findall(r"(?m)^\s*(?:---+|___+|\*\*\*+)\s*$", text or ""))
        return headings, ordered, unordered, fences, horizontal

    def _assess_quality(self, output: str, model_chunk: str, values: list[tuple[str, str]], mode: str) -> dict:
        """统一质量契约：pass 可自动采用；needs_review 交人工；failed 无可用候选。

        统计前先排除受保护片段（占位符还原后的 URL、变量、专名等），检测目标是
        自然语言英文句段或原文回显，而不是变量、URL、缩写和角色名。
        """
        if not output or not output.strip():
            return {"quality_status": "failed", "quality_codes": ["empty_output"], "quality_reason": QUALITY_REASONS["empty_output"]}
        refusal_pattern = r"(?:I can(?:not|'t)\s+(?:translate|assist|help)|(?:抱歉.{0,20})?(?:无法|不能).{0,12}(?:翻译|协助|处理))"
        if re.search(refusal_pattern, output, re.I):
            return {"quality_status": "failed", "quality_codes": ["bridge_or_model_error"], "quality_reason": QUALITY_REASONS["bridge_or_model_error"]}
        if re.search(r"(?im)^\s*(?:NSFW\s+Terminology|Context|Terminology|SOURCE|参考上下文|参考术语表|需要翻译的文本|上下文|术语表|来源)\s*[:：]", output) or "SOURCE:\n" in output or "需要翻译的文本：" in output:
            return {"quality_status": "failed", "quality_codes": ["structure_mismatch"], "quality_reason": QUALITY_REASONS["structure_mismatch"]}
        codes: list[str] = []
        # 占位符：受保护内容必须数量一致（丢失、新增、改名都算疑点）；
        # 已有中文片段允许在译文中自然重复出现，只检查不丢失
        for token, original in values:
            expected = model_chunk.count(token)
            actual = output.count(original)
            if actual < expected or (actual > expected and not re.search(r"[\u3400-\u9fff]", original)):
                codes.append("placeholder_mismatch")
                break
        restored_source = self.restore(model_chunk, values)
        source_signature = self._structure_signature(restored_source)
        output_signature = self._structure_signature(output)
        if source_signature != output_signature:
            codes.append("structure_mismatch")
        source_compact = re.sub(r"\s+", "", restored_source)
        output_compact = re.sub(r"\s+", "", output)
        if len(output) > max(200, len(model_chunk) * 6) or re.search(r"(.{12,80})\1\1", output):
            if "structure_mismatch" not in codes:
                codes.append("structure_mismatch")
        if len(source_compact) >= 80 and len(output_compact) < max(12, int(len(source_compact) * 0.15)):
            if "structure_mismatch" not in codes:
                codes.append("structure_mismatch")
        # 回显 / 混杂判断：排除受保护片段后再统计
        source_probe = re.sub(r"__NV_(?:PROTECTED|EXISTING_ZH)_\d{4}__", "", model_chunk)
        out_probe = output
        for _, original in values:
            out_probe = out_probe.replace(original, " ")
        latin_out = len(re.findall(r"[A-Za-z]", out_probe))
        cjk_out = len(re.findall(r"[\u3400-\u9fff]", out_probe))
        source_words = [word.lower() for word in self._english_words(source_probe) if not (word.isupper() and len(word) <= 8)]
        output_words = [word.lower() for word in self._english_words(out_probe) if not (word.isupper() and len(word) <= 8)]
        if source_words:
            if cjk_out == 0:
                same_source = self._normalized_text(output) == self._normalized_text(restored_source)
                approx_source = bool(source_words and output_words and SequenceMatcher(None, source_words, output_words).ratio() >= 0.78)
                codes.append("source_echo" if same_source or approx_source else "missing_cjk")
            elif latin_out > 0 and output_words:
                codes.append("mixed_language")
        if mode == "name_zh" and re.search(r"[A-Za-z]", out_probe) and re.search(r"[A-Za-z]", source_probe):
            if "mixed_language" not in codes:
                codes.append("mixed_language")
        if not codes:
            return {"quality_status": "pass", "quality_codes": [], "quality_reason": ""}
        return {
            "quality_status": "needs_review",
            "quality_codes": codes,
            "quality_reason": "；".join(QUALITY_REASONS.get(code, code) for code in codes),
        }

    def _better_candidate(self, first: dict, second: dict) -> dict:
        """两次都未通过时，取更完整的候选作为人工参考，但状态保持非 pass。"""
        rank = {"pass": 2, "needs_review": 1, "failed": 0}
        if rank.get(second.get("quality_status"), 0) != rank.get(first.get("quality_status"), 0):
            return second if rank.get(second.get("quality_status"), 0) > rank.get(first.get("quality_status"), 0) else first
        first_cjk = self._latin_cjk(str(first.get("translation") or ""))[1]
        second_cjk = self._latin_cjk(str(second.get("translation") or ""))[1]
        return second if second_cjk > first_cjk else first

    def _translate_chunk_once(
        self,
        model_chunk: str,
        values: list[tuple[str, str]],
        terminology: str,
        mode: str,
        context: str = "",
        corrective: bool = False,
        prior_output: str = "",
        issue_codes: list[str] | None = None,
    ) -> dict:
        try:
            context_hint = re.sub(r"\s+", " ", context or "").strip()[:240] or "（无）"
            if mode == "name_zh":
                prompt = (
                    "你是专业的专名中文化译者。把下面的英文或罗马字名称翻译或音译为自然的简体中文名称。\n"
                    "有通行中文译名时优先使用；不要保留拉丁字母，不要解释，不要添加引号或标签。\n"
                    "只输出一个中文名称。\n\n参考上下文（仅用于理解，不要输出）：%s\n%s\n需要翻译的文本：\n%s"
                ) % (context_hint, terminology or "", model_chunk)
            elif corrective:
                prompt = (
                    "请把以下英文文本完整翻译成简体中文，只输出中文译文，不得出现英文句子，"
                    "不得复述原文，不得解释，原样保留 __NV_*__ 占位符、变量、URL 和数字。"
                    "保持标题、列表、代码围栏和段落结构。\n"
                    "参考上下文（仅用于理解，不要输出）：%s\n问题：%s\n上一次候选（仅用于修正）：\n%s\n"
                    "术语：%s\n原文：\n%s"
                ) % (context_hint, "、".join(issue_codes or []) or "质量校验未通过", prior_output[:2400], terminology or "无", model_chunk)
            else:
                prompt = (
                    "把下面的文本翻译成简体中文。要求：只返回最终译文；不要解释、不复述原文、"
                    "不增加标题；原样保留受保护变量、URL、数字和指定专名；保留 __NV_*__ 占位符"
                    "不变；保持输入文本的标题、列表、代码围栏和段落结构。\n"
                    "参考上下文（仅用于理解，不要输出）：%s\n术语：%s\n原文：\n%s"
                ) % (context_hint, terminology or "无", model_chunk)
            output = self._call_model(prompt)
        except Exception as error:
            return {"quality_status": "failed", "quality_codes": ["bridge_or_model_error"],
                    "quality_reason": "本地翻译失败: %s" % error, "translation": ""}
        output = self.restore(output, values)
        output = self._strip_prompt_echo(output)
        # 受保护内容被模型丢弃时保留缺失状态，不把它粗暴追加到译文末尾。
        missing_before = sum(max(model_chunk.count(token) - output.count(original), 0) for token, original in values)
        quality = self._assess_quality(output, model_chunk, values, mode)
        if missing_before > 0 and quality["quality_status"] == "pass":
            quality = {"quality_status": "needs_review", "quality_codes": ["placeholder_mismatch"],
                       "quality_reason": QUALITY_REASONS["placeholder_mismatch"]}
        quality["translation"] = output
        return quality

    def _safe_cut(self, text: str, limit: int) -> int:
        cut = min(limit, len(text))
        boundary = list(re.finditer(r"(?:[。！？!?；;.!?][ \t]*(?:\r?\n|$)|\r?\n)", text[:cut]))
        if boundary:
            candidate = boundary[-1].end()
            if candidate >= max(80, limit // 2):
                cut = candidate
        for match in self.protected_token_pattern.finditer(text):
            if match.start() < cut < match.end():
                cut = match.start() if match.start() else match.end()
                break
        return max(1, min(cut, len(text)))

    def _split_long_block(self, text: str, hard_max: int) -> list[str]:
        parts = []
        rest = text
        while len(rest) > hard_max:
            cut = self._safe_cut(rest, hard_max)
            parts.append(rest[:cut])
            rest = rest[cut:]
        if rest:
            parts.append(rest)
        return parts

    def chunks(self, text: str, target: int = TRANSLATION_CHUNK_TARGET, hard_max: int = TRANSLATION_CHUNK_MAX) -> list[str]:
        """Pack paragraphs and list groups while preserving Markdown shape."""
        blocks: list[str] = []
        current: list[str] = []
        last_nonempty = ""

        def flush() -> None:
            nonlocal current, last_nonempty
            if current:
                block = "".join(current)
                if block.strip():
                    blocks.extend(self._split_long_block(block, hard_max))
                current = []
            last_nonempty = ""

        for line in re.split(r"(?<=\n)", text or ""):
            stripped = line.strip()
            if not stripped:
                current.append(line)
                flush()
                continue
            is_heading = bool(re.match(r"^\s{0,3}#{1,6}\s+", line))
            is_list = bool(re.match(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)", line))
            last_is_list = bool(re.match(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)", last_nonempty))
            if is_heading or (last_nonempty and is_list != last_is_list):
                flush()
            current.append(line)
            last_nonempty = line
        flush()

        chunks: list[str] = []
        pending = ""
        for block in blocks:
            if not pending:
                pending = block
            elif len(pending) + len(block) <= target:
                pending += block
            else:
                chunks.append(pending)
                pending = block
        if pending:
            chunks.append(pending)
        return chunks

    def protect(self, text: str):
        values = []
        def repl(match):
            token = "__NV_PROTECTED_%04d__" % len(values)
            values.append((token, match.group(0)))
            return token
        protected = self.protected_pattern.sub(repl, text)
        for term in self.glossary.get("do_not_translate") or []:
            if str(term) in protected:
                token = "__NV_PROTECTED_%04d__" % len(values)
                protected = protected.replace(str(term), token)
                values.append((token, str(term)))
        return protected, values

    def restore(self, text: str, values: list[tuple[str, str]]) -> str:
        for token, value in values:
            text = text.replace(token, value)
        return text

    def protect_existing_chinese(self, text: str, values: list[tuple[str, str]]) -> tuple[str, list[tuple[str, str]]]:
        """Keep existing Chinese out of HY-MT's source payload and restore it verbatim."""
        next_index = len(values)
        extra_values: list[tuple[str, str]] = []

        def repl(match):
            nonlocal next_index
            token = "__NV_EXISTING_ZH_%04d__" % next_index
            next_index += 1
            extra_values.append((token, match.group(0)))
            return token

        protected = re.sub(r"[\u3400-\u9fff]+", repl, text)
        return protected, values + extra_values

    def cache_key(self, text: str, context: str, mode: str = "faithful_zh") -> str:
        return sha256_json({
            "text": text, "context": context, "model": self.model,
            "direction": "en-zh", "mode": mode, "glossary": self.glossary,
            "cache_version": TRANSLATION_CACHE_VERSION,
            "prompt_version": TRANSLATION_PROMPT_VERSION,
            "validator_version": TRANSLATION_VALIDATOR_VERSION,
        })

    def _validate_output(self, output: str, source: str, values: list[tuple[str, str]], mode: str) -> None:
        refusal_pattern = r"(?:I can(?:not|'t)\s+(?:translate|assist|help)|(?:抱歉.{0,20})?(?:无法|不能).{0,12}(?:翻译|协助|处理))"
        if not output or re.search(refusal_pattern, output, re.I):
            raise RuntimeError("本地模型返回空内容或拒绝话术")
        if re.search(r"(?im)^\s*(?:NSFW\s+Terminology|Context|Terminology|SOURCE|参考上下文|参考术语表|需要翻译的文本|上下文|术语表|来源)\s*[:：]", output) or "SOURCE:\n" in output or "需要翻译的文本：" in output:
            raise RuntimeError("本地模型回显了翻译提示模板")
        for _, original in values:
            if original not in output:
                raise RuntimeError("译文破坏了受保护内容: %s" % original[:80])
        if len(output) > max(200, len(source) * 6) or re.search(r"(.{12,80})\1\1", output):
            raise RuntimeError("译文长度或重复模式异常")
        if mode == "name_zh" and re.search(r"[A-Za-z]", source) and not re.search(r"[\u3400-\u9fff]", output):
            raise RuntimeError("名称中文化结果不含中文")

    def _strip_prompt_echo(self, output: str) -> str:
        """Remove a model's echoed prompt wrapper while keeping its answer."""
        markers = ("需要翻译的文本：", "需要翻译的文本:", "SOURCE:\n", "SOURCE:")
        positions = [(output.find(marker), marker) for marker in markers if output.find(marker) >= 0]
        if not positions:
            return output.strip()
        position, marker = min(positions, key=lambda item: item[0])
        # Only treat an early marker as a wrapper. A legitimate translated
        # paragraph containing the phrase later in the body must be untouched.
        if position <= 240:
            return output[position + len(marker):].strip()
        return output.strip()

    def _restore_missing_protected(self, output: str, source: str, values: list[tuple[str, str]]) -> str:
        """Re-append dropped machine tokens so a translation cannot corrupt them."""
        missing = []
        for token, original in values:
            count = source.count(token) - output.count(original)
            if count > 0:
                missing.extend([original] * count)
        if missing:
            output = output.rstrip() + "\n" + " ".join(missing)
        return output

    def translate(self, text: str, context: str, check_control, mode: str = "faithful_zh") -> str:
        result = self.translate_with_quality(text, context, check_control, mode)
        if result["quality_status"] != "pass":
            raise RuntimeError(result["quality_reason"] or "模型未产生可用中文译文")
        return result["translation"]

    def translate_with_quality(self, text: str, context: str, check_control, mode: str = "faithful_zh") -> dict:
        if mode not in ("faithful_zh", "name_zh"):
            raise ValueError("未知翻译模式: %s" % mode)
        contract = {"quality_contract_version": TRANSLATION_QUALITY_CONTRACT_VERSION}
        if not text:
            return {"quality_status": "pass", "quality_codes": [], "quality_reason": "", "translation": text, **contract}
        if mode == "name_zh":
            latin = len(re.findall(r"[A-Za-z]", text))
            cjk = len(re.findall(r"[\u3400-\u9fff]", text))
            if not latin or cjk >= latin:
                return {"quality_status": "pass", "quality_codes": [], "quality_reason": "", "translation": text, **contract}
        elif not self.needs_translation(text):
            return {"quality_status": "pass", "quality_codes": [], "quality_reason": "", "translation": text, **contract}
        translated = []
        codes: list[str] = []
        reasons: list[str] = []
        worst = "pass"
        rank = {"pass": 2, "needs_review": 1, "failed": 0}
        protected_text, protected_values = self.protect(text)
        # Long, explicit character cards can make a local model refuse the
        # whole request. Keep metadata efficient, but translate正文 in
        # smaller ordered pieces so no source content is discarded.
        for chunk in self.chunks(protected_text, target=TRANSLATION_CHUNK_TARGET, hard_max=TRANSLATION_CHUNK_MAX):
            check_control()
            values = [(token, original) for token, original in protected_values if token in chunk]
            restored_source = self.restore(chunk, values)
            if mode == "faithful_zh" and not self.needs_translation(restored_source):
                translated.append(restored_source)
                continue
            model_chunk = chunk
            if mode == "faithful_zh":
                model_chunk, values = self.protect_existing_chinese(model_chunk, values)
                translatable_probe = re.sub(r"__NV_(?:PROTECTED|EXISTING_ZH)_\d{4}__", "", model_chunk)
                if not self.needs_translation(translatable_probe):
                    translated.append(restored_source)
                    continue
            key = self.cache_key(model_chunk, context, mode)
            cache_path = self.cache_root / (key + ".json")
            cached = load_json(cache_path, None)
            if cached and cached.get("translation"):
                # 缓存结果必须按当前质量契约复验，坏缓存立即作废
                quality = self._assess_quality(str(cached["translation"]), model_chunk, values, mode)
                if quality["quality_status"] == "pass":
                    translated.append(str(cached["translation"]))
                    continue
                try: cache_path.unlink()
                except OSError: pass
            terms = self.glossary.get("terms") or {}
            model_chunk_lower = model_chunk.lower()
            matching_terms = [
                (str(term), str(translation))
                for term, translation in terms.items()
                if str(term).lower() in model_chunk_lower
            ]
            terminology = "" if not matching_terms else "术语：%s。" % "；".join("%s=%s" % pair for pair in matching_terms)
            outcome = self._translate_chunk_once(model_chunk, values, terminology, mode, context=context)
            if outcome["quality_status"] != "pass":
                # 自动重试最多一次：第一次 needs_review / failed 使用纠错 Prompt 重试
                retried = self._translate_chunk_once(
                    model_chunk,
                    values,
                    terminology,
                    mode,
                    context=context,
                    corrective=True,
                    prior_output=str(outcome.get("translation") or ""),
                    issue_codes=list(outcome.get("quality_codes") or []),
                )
                outcome = retried if retried["quality_status"] == "pass" else self._better_candidate(outcome, retried)
            if outcome["quality_status"] == "pass":
                # 只有 pass 才允许写成功缓存
                atomic_json(cache_path, {
                    "translation": outcome["translation"], "model": self.model, "mode": mode,
                    "quality_status": "pass",
                    "cache_version": TRANSLATION_CACHE_VERSION,
                    "prompt_version": TRANSLATION_PROMPT_VERSION,
                    "validator_version": TRANSLATION_VALIDATOR_VERSION,
                    "quality_contract_version": TRANSLATION_QUALITY_CONTRACT_VERSION,
                    "created_at": now_iso(),
                })
                translated.append(outcome["translation"])
            else:
                if rank.get(outcome["quality_status"], 0) < rank.get(worst, 2):
                    worst = outcome["quality_status"]
                for code in outcome.get("quality_codes") or []:
                    if code not in codes:
                        codes.append(code)
                reason = str(outcome.get("quality_reason") or "")
                if reason and reason not in reasons:
                    reasons.append(reason)
                translated.append(str(outcome.get("translation") or ""))
        return {
            "quality_status": worst,
            "quality_codes": codes,
            "quality_reason": "；".join(reasons),
            "translation": "".join(translated),
            **contract,
        }


class TranslationModelInstaller:
    """Explicit, asynchronous installer for the official Tencent Q4_K_M file."""

    def __init__(self, denova_dir: Path, translator: LocalTranslator):
        self.denova_dir = denova_dir
        self.translator = translator
        self.model_root = denova_dir / "narraverse-models"
        self.status_path = denova_dir / "narraverse-model-install.json"
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def _record(self) -> dict:
        return load_json(self.status_path, {})

    def _save(self, record: dict) -> None:
        record["updated_at"] = now_iso()
        atomic_json(self.status_path, record)

    def status(self) -> dict:
        ollama = self.translator.status()
        record = self._record()
        return {
            **ollama,
            "install": record,
            "source": {
                "repository": HY_MT_REPO, "filename": HY_MT_FILE,
                "bytes": HY_MT_PUBLISHED_SIZE, "sha256": HY_MT_PUBLISHED_SHA256,
                "url": "https://huggingface.co/%s/blob/main/%s" % (HY_MT_REPO, HY_MT_FILE),
            },
        }

    def start(self) -> dict:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return self.status()
            record = {
                "status": "queued", "stage": "等待下载官方模型", "progress": 0,
                "repository": HY_MT_REPO, "filename": HY_MT_FILE, "model": self.translator.model,
                "created_at": now_iso(), "error": "",
            }
            self._save(record)
            self._thread = threading.Thread(target=self._run, daemon=True, name="narraverse-hy-mt-installer")
            self._thread.start()
        return self.status()

    @staticmethod
    def _official_metadata() -> dict:
        url = "https://huggingface.co/api/models/" + HY_MT_REPO
        request = urllib.request.Request(url, headers={"User-Agent": "Narraverse-Denova/1.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            metadata = json.loads(response.read().decode("utf-8"))
        candidate = next((item for item in metadata.get("siblings") or [] if item.get("rfilename") == HY_MT_FILE), None)
        if not candidate:
            raise RuntimeError("官方仓库中未找到 Q4_K_M 文件")
        lfs = candidate.get("lfs") or {}
        digest = str(lfs.get("sha256") or "").lower()
        size = int(lfs.get("size") or candidate.get("size") or 0)
        # Hugging Face 的公开 siblings 接口有时会省略 LFS 字段；此前已从
        # 官方文件页核验并固定这两个值。若接口给出值则必须与固定值一致，
        # 缺字段时才使用固定值，避免把未知内容当作目标模型下载。
        if not re.fullmatch(r"[0-9a-f]{64}", digest) or size <= 0:
            digest, size = HY_MT_PUBLISHED_SHA256, HY_MT_PUBLISHED_SIZE
        elif digest != HY_MT_PUBLISHED_SHA256 or size != HY_MT_PUBLISHED_SIZE:
            raise RuntimeError("官方模型元数据与已核验文件哈希/大小不一致")
        return {"sha256": digest, "bytes": size}

    def _run(self) -> None:
        try:
            record = self._record(); record.update({"status": "checking", "stage": "核对官方文件与磁盘空间", "progress": 1}); self._save(record)
            metadata = self._official_metadata()
            self.model_root.mkdir(parents=True, exist_ok=True)
            free = shutil.disk_usage(self.model_root).free
            if free < metadata["bytes"] + 512 * 1024 * 1024:
                raise RuntimeError("磁盘空间不足：模型约 %.2f GiB，另需至少 512 MiB 余量" % (metadata["bytes"] / 1024 ** 3))
            target = self.model_root / HY_MT_FILE
            partial = target.with_suffix(target.suffix + ".part")
            existing = partial.stat().st_size if partial.is_file() else 0
            headers = {"User-Agent": "Narraverse-Denova/1.0"}
            if existing and existing < metadata["bytes"]:
                headers["Range"] = "bytes=%d-" % existing
            download_url = "https://huggingface.co/%s/resolve/main/%s?download=true" % (HY_MT_REPO, urllib.parse.quote(HY_MT_FILE))
            request = urllib.request.Request(download_url, headers=headers)
            with urllib.request.urlopen(request, timeout=120) as response:
                append = existing > 0 and getattr(response, "status", 200) == 206
                if not append: existing = 0
                mode = "ab" if append else "wb"
                downloaded = existing
                record.update({"status": "downloading", "stage": "下载 HY-MT Q4_K_M（约 %.2f GiB）" % (metadata["bytes"] / 1024 ** 3), "bytes_total": metadata["bytes"]})
                with partial.open(mode) as handle:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk: break
                        handle.write(chunk); downloaded += len(chunk)
                        if downloaded % (8 * 1024 * 1024) < len(chunk):
                            record.update({"bytes_downloaded": downloaded, "progress": min(90, int(downloaded * 90 / metadata["bytes"]))}); self._save(record)
                    handle.flush(); os.fsync(handle.fileno())
            if partial.stat().st_size != metadata["bytes"]:
                raise RuntimeError("模型下载大小不匹配")
            record.update({"status": "verifying", "stage": "校验官方 SHA-256", "progress": 92}); self._save(record)
            digest = hashlib.sha256()
            with partial.open("rb") as handle:
                while True:
                    chunk = handle.read(4 * 1024 * 1024)
                    if not chunk: break
                    digest.update(chunk)
            if digest.hexdigest().lower() != metadata["sha256"]:
                raise RuntimeError("模型 SHA-256 校验失败；保留 .part 便于诊断")
            os.replace(str(partial), str(target))
            ollama = shutil.which("ollama")
            if not ollama:
                raise RuntimeError("未找到 ollama 命令；模型文件已校验并保留")
            modelfile = self.model_root / "Modelfile.hy-mt1.5"
            atomic_text(modelfile, 'FROM "%s"\nPARAMETER temperature 0\nPARAMETER num_ctx 8192\n' % str(target))
            record.update({"status": "registering", "stage": "注册独立 Ollama 模型", "progress": 96, "sha256": metadata["sha256"]}); self._save(record)
            result = subprocess.run([ollama, "create", self.translator.model, "-f", str(modelfile)], capture_output=True, text=True, timeout=600)
            if result.returncode != 0:
                raise RuntimeError("Ollama 注册失败：%s" % (result.stderr or result.stdout or result.returncode))
            record.update({"status": "complete", "stage": "HY-MT 已就绪", "progress": 100, "bytes_downloaded": metadata["bytes"], "bytes_total": metadata["bytes"], "sha256": metadata["sha256"], "completed_at": now_iso()}); self._save(record)
        except Exception as error:
            record = self._record(); record.update({"status": "failed", "stage": "模型安装失败", "error": str(error)}); self._save(record)


class ExportJobManager:
    def __init__(self, denova_dir: str, projects: str, books_json: str, knowledge_base: str):
        self.denova_dir = Path(denova_dir)
        self.projects = Path(projects)
        self.books_json = Path(books_json)
        self.knowledge_base = Path(knowledge_base)
        self.jobs_root = self.denova_dir / "narraverse-export-jobs"
        self.cache_root = self.denova_dir / "narraverse-translation-cache"
        self.translation_jobs_root = self.denova_dir / "narraverse-translation-jobs"
        self.translation_job_files = self.translation_jobs_root / "jobs"
        self.translation_queue_path = self.translation_jobs_root / "queue.json"
        self.glossary_path = Path(__file__).with_name("translation_glossary.json")
        self.jobs_root.mkdir(parents=True, exist_ok=True)
        self.translation_job_files.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._threads: dict[str, threading.Thread] = {}
        self._translation_lock = threading.Lock()
        self._translation_queue_lock = threading.RLock()
        self._translation_queue_wake = threading.Event()
        self._translation_worker: threading.Thread | None = None
        self.translator = LocalTranslator(self.cache_root, self.glossary_path)
        self.installer = TranslationModelInstaller(self.denova_dir, self.translator)
        self._recover_translation_queue()

    def translator_status(self) -> dict:
        return self.installer.status()

    def install_translator(self) -> dict:
        return self.installer.start()

    def translate_lore_fields(self, fields: dict, context: dict) -> dict:
        """Translate selected lore fields (name/brief_description/content) serially.

        Reuses the existing LocalTranslator: cache, glossary, placeholder
        protection, and validation. A field that fails validation or translation
        keeps its original text and is reported in failed_fields; other fields
        are still translated. Successfully translated fields remain in cache.
        """
        allowed = ("name", "brief_description", "content")
        order = ("name", "brief_description", "content")
        cleaned: dict[str, str] = {}
        for key, value in (fields or {}).items():
            if key not in allowed:
                raise ValueError("非法翻译字段: %s" % key)
            text = str(value or "").strip()
            if text:
                cleaned[key] = text
        if not cleaned:
            raise ValueError("没有可翻译的字段")

        ctx = context or {}
        item_name = str(ctx.get("item_name") or "").strip()[:120]
        item_type = str(ctx.get("item_type") or "").strip()[:60]
        context_text = ("%s · %s" % (item_type, item_name)).strip(" ·")[:500]

        with self._translation_lock:
            status = self.translator.status()
            if not status.get("online"):
                raise RuntimeError("translator_offline")
            if not status.get("installed"):
                raise RuntimeError("model_missing")

            result: dict[str, str] = {}
            translated: list[str] = []
            failed: list[dict] = []
            for key in order:
                if key not in cleaned:
                    continue
                original = cleaned[key]
                field_context = "%s · %s" % (context_text, key) if context_text else key
                try:
                    output = self.translator.translate(
                        original, field_context, lambda: None,
                        "name_zh" if key == "name" else "faithful_zh",
                    )
                except Exception as error:
                    result[key] = original
                    failed.append({"field": key, "error": str(error)[:200]})
                    continue
                if not output or output == original:
                    result[key] = original
                else:
                    result[key] = output
                    translated.append(key)

            return {
                "model": self.translator.model,
                "fields": result,
                "translated_fields": translated,
                "skipped_fields": [key for key in cleaned if key not in translated and not any(f["field"] == key for f in failed)],
                "failed_fields": failed,
            }

    def _translation_queue(self) -> dict:
        return load_json(self.translation_queue_path, {
            "schema_version": 1, "order": [], "active_id": "",
            "pause_reasons": [], "updated_at": now_iso(),
        })

    def _save_translation_queue(self, queue: dict) -> None:
        queue["schema_version"] = 1
        queue["updated_at"] = now_iso()
        atomic_json(self.translation_queue_path, queue)

    def _translation_job_path(self, job_id: str) -> Path:
        if not re.fullmatch(r"translation-[0-9a-f]{24}", str(job_id or "")):
            raise ValueError("无效翻译任务 ID")
        return self.translation_job_files / (job_id + ".json")

    def _translation_job(self, job_id: str) -> dict:
        job = load_json(self._translation_job_path(job_id), None)
        if not job:
            raise FileNotFoundError("翻译任务不存在")
        return job

    def _save_translation_job(self, job: dict) -> None:
        job["updated_at"] = now_iso()
        atomic_json(self._translation_job_path(str(job["id"])), job)

    def _recover_translation_queue(self) -> None:
        with self._translation_queue_lock:
            queue = self._translation_queue()
            changed = False
            for job_id in list(queue.get("order") or []):
                try:
                    job = self._translation_job(job_id)
                except (FileNotFoundError, ValueError):
                    queue["order"].remove(job_id)
                    changed = True
                    continue
                if job.get("status") == "running":
                    job["status"] = "queued"
                    job["error"] = ""
                    self._save_translation_job(job)
                    changed = True
            if queue.get("active_id"):
                queue["active_id"] = ""
                changed = True
            if changed or not self.translation_queue_path.exists():
                self._save_translation_queue(queue)
            if any(self._translation_job(job_id).get("status") == "queued" for job_id in queue.get("order") or []):
                self._ensure_translation_worker()

    def _ensure_translation_worker(self) -> None:
        if self._translation_worker and self._translation_worker.is_alive():
            self._translation_queue_wake.set()
            return
        self._translation_worker = threading.Thread(
            target=self._translation_worker_loop, daemon=True,
            name="narraverse-translation-worker",
        )
        self._translation_worker.start()
        self._translation_queue_wake.set()

    def create_translation_jobs(self, payload: dict) -> dict:
        workspace = str((payload or {}).get("workspace") or "").strip()[:1000]
        requested = (payload or {}).get("jobs") or []
        if not workspace:
            raise ValueError("缺少 workspace")
        if not isinstance(requested, list) or not requested:
            raise ValueError("未提供翻译任务")
        if len(requested) > 5000:
            raise ValueError("单次最多创建 5000 个翻译任务")
        created, skipped = [], []
        legacy_fields = {"name", "brief_description", "content"}
        allowed_modes = {"name_zh", "faithful_zh"}
        allowed_policies = {"auto_apply_metadata", "review_content", "master_auto", "master_review"}
        master_policies = {"master_auto", "master_review"}
        with self._translation_queue_lock:
            queue = self._translation_queue()
            order = queue.setdefault("order", [])
            for raw in requested:
                if not isinstance(raw, dict):
                    raise ValueError("翻译任务必须是对象")
                field = str(raw.get("field") or "")
                mode = str(raw.get("mode") or ("name_zh" if field == "name" else "faithful_zh"))
                policy = str(raw.get("apply_policy") or ("review_content" if field == "content" else "auto_apply_metadata"))
                source = raw.get("source_text")
                is_master = policy in master_policies
                valid_field = valid_translation_field_path(field) if is_master else field in legacy_fields
                if not valid_field or mode not in allowed_modes or policy not in allowed_policies:
                    raise ValueError("翻译任务字段、模式或写回策略无效")
                if not isinstance(source, str) or not source.strip():
                    raise ValueError("翻译原文必须是非空字符串")
                if len(source.encode("utf-8")) > 2 * 1024 * 1024:
                    raise ValueError("单字段原文超过 2 MiB")
                item_id = str(raw.get("item_id") or "").strip()
                if not item_id:
                    raise ValueError("缺少资料 ID")
                source_hash = sha256_bytes(source.encode("utf-8"))
                supplied_hash = str(raw.get("source_sha256") or "").strip()
                if supplied_hash and supplied_hash != source_hash:
                    raise ValueError("翻译原文哈希不匹配")
                master_metadata = {
                    "import_id": str(raw.get("import_id") or "").strip()[:240],
                    "source_id": str(raw.get("source_id") or "").strip()[:240],
                    "source_revision": str(raw.get("source_revision") or "").strip()[:240],
                    "master_item_id": str(raw.get("master_item_id") or "").strip()[:240],
                }
                if is_master and not all(master_metadata.values()):
                    raise ValueError("Master 翻译任务缺少导入、来源或条目身份")
                if is_master and master_metadata["master_item_id"] != item_id:
                    raise ValueError("Master 条目 ID 与资料 ID 不一致")
                digest = sha256_json({
                    "workspace": workspace, "item_id": item_id, "field": field,
                    "source_sha256": source_hash, "mode": mode, "apply_policy": policy,
                    **master_metadata,
                    "cache_version": TRANSLATION_CACHE_VERSION,
                    "prompt_version": TRANSLATION_PROMPT_VERSION,
                    "validator_version": TRANSLATION_VALIDATOR_VERSION,
                    "quality_contract_version": TRANSLATION_QUALITY_CONTRACT_VERSION,
                })[:24]
                job_id = "translation-" + digest
                path = self._translation_job_path(job_id)
                if path.exists():
                    skipped.append(job_id)
                    existing = self._translation_job(job_id)
                    if existing.get("status") != "applied" and job_id not in order:
                        order.append(job_id)
                    continue
                job = {
                    "schema_version": 1, "id": job_id, "workspace": workspace,
                    "item_id": item_id, "item_name": str(raw.get("item_name") or "")[:240],
                    "field": field, "mode": mode, "apply_policy": policy,
                    "source_text": source, "source_sha256": source_hash,
                    "base_revision": str(raw.get("base_revision") or "")[:240],
                    **master_metadata,
                    "status": "queued", "translation": "", "model": self.translator.model,
                    "cache_version": TRANSLATION_CACHE_VERSION,
                    "prompt_version": TRANSLATION_PROMPT_VERSION,
                    "validator_version": TRANSLATION_VALIDATOR_VERSION,
                    "quality_status": "", "quality_codes": [], "quality_reason": "",
                    "quality_contract_version": TRANSLATION_QUALITY_CONTRACT_VERSION,
                    "attempts": 0,
                    "error": "", "created_at": now_iso(), "updated_at": now_iso(),
                }
                self._save_translation_job(job)
                order.append(job_id)
                created.append(job_id)
            self._save_translation_queue(queue)
            self._ensure_translation_worker()
        return {"created": created, "skipped": skipped, **self.translation_queue_status(workspace)}

    @staticmethod
    def _translation_job_summary(job: dict) -> dict:
        summary = {key: job.get(key) for key in (
            "id", "workspace", "item_id", "item_name", "field", "mode",
            "apply_policy", "source_sha256", "base_revision", "status",
            "import_id", "source_id", "source_revision", "master_item_id",
            "model", "cache_version", "attempts", "error", "created_at",
            "updated_at", "completed_at",
            "quality_status", "quality_codes", "quality_reason", "quality_contract_version",
        )}
        # 候选译文只随待人工/失败/冲突状态下发，避免队列轮询负载过大
        if job.get("status") in ("pending_review", "failed", "conflict"):
            summary["translation"] = job.get("translation") or ""
        return summary

    def translation_queue_status(self, workspace: str = "") -> dict:
        with self._translation_queue_lock:
            queue = self._translation_queue()
            jobs = []
            active_order = []
            for job_id in queue.get("order") or []:
                try: job = self._translation_job(job_id)
                except (FileNotFoundError, ValueError): continue
                if job.get("status") == "applied":
                    continue
                active_order.append(job_id)
                if workspace and job.get("workspace") != workspace:
                    continue
                jobs.append(self._translation_job_summary(job))
            if active_order != (queue.get("order") or []):
                queue["order"] = active_order
                self._save_translation_queue(queue)
            counts: dict[str, int] = {}
            for job in jobs:
                status = str(job.get("status") or "unknown")
                counts[status] = counts.get(status, 0) + 1
            return {
                "schema_version": 1, "active_id": queue.get("active_id") or "",
                "pause_reasons": list(queue.get("pause_reasons") or []),
                "paused": bool(queue.get("pause_reasons")), "counts": counts, "jobs": jobs,
            }

    def get_translation_job(self, job_id: str) -> dict:
        with self._translation_queue_lock:
            return self._translation_job(job_id)

    def pause_translation_queue(self, reason: str) -> dict:
        if reason not in ("manual", "game"):
            raise ValueError("暂停原因必须是 manual 或 game")
        with self._translation_queue_lock:
            queue = self._translation_queue()
            reasons = queue.setdefault("pause_reasons", [])
            if reason not in reasons:
                reasons.append(reason)
            self._save_translation_queue(queue)
        return self.translation_queue_status()

    def resume_translation_queue(self, reason: str) -> dict:
        if reason not in ("manual", "game"):
            raise ValueError("恢复原因必须是 manual 或 game")
        with self._translation_queue_lock:
            queue = self._translation_queue()
            queue["pause_reasons"] = [item for item in queue.get("pause_reasons") or [] if item != reason]
            self._save_translation_queue(queue)
            self._ensure_translation_worker()
        return self.translation_queue_status()

    def cancel_translation_job(self, job_id: str) -> dict:
        with self._translation_queue_lock:
            job = self._translation_job(job_id)
            if job.get("status") == "running":
                job["cancel_requested"] = True
            elif job.get("status") not in ("applied", "cancelled"):
                job["status"] = "cancelled"
            self._save_translation_job(job)
            return job

    def delete_translation_job(self, job_id: str) -> dict:
        """Remove a non-running job from the active queue but keep its audit file."""
        with self._translation_queue_lock:
            job = self._translation_job(job_id)
            if job.get("status") == "running":
                raise ValueError("运行中的任务必须先取消，完成后才能删除")
            job["status"] = "deleted"
            job["deleted_at"] = now_iso()
            self._save_translation_job(job)
            queue = self._translation_queue()
            queue["order"] = [item for item in queue.get("order") or [] if item != job_id]
            if queue.get("active_id") == job_id:
                queue["active_id"] = ""
            self._save_translation_queue(queue)
            return job

    def retry_translation_job(self, job_id: str) -> dict:
        with self._translation_queue_lock:
            job = self._translation_job(job_id)
            if job.get("status") not in ("failed", "conflict", "cancelled"):
                raise ValueError("只有失败、冲突或已取消任务可以重试")
            job.update({"status": "queued", "error": "", "translation": "", "cancel_requested": False,
                        "quality_status": "", "quality_codes": [], "quality_reason": ""})
            self._save_translation_job(job)
            self._ensure_translation_worker()
            return job

    def resolve_translation_job(self, job_id: str, status: str, error: str = "") -> dict:
        if status not in ("applied", "conflict", "cancelled"):
            raise ValueError("无效任务解决状态")
        with self._translation_queue_lock:
            job = self._translation_job(job_id)
            if job.get("status") not in ("completed", "pending_review", "conflict"):
                raise ValueError("当前任务状态不可解决")
            job["status"] = status
            job["error"] = str(error or "")[:500]
            self._save_translation_job(job)
            if status == "applied":
                queue = self._translation_queue()
                queue["order"] = [item for item in queue.get("order") or [] if item != job_id]
                self._save_translation_queue(queue)
            return job

    def _translation_worker_loop(self) -> None:
        while True:
            self._translation_queue_wake.wait(1)
            self._translation_queue_wake.clear()
            while True:
                with self._translation_queue_lock:
                    queue = self._translation_queue()
                    if queue.get("pause_reasons"):
                        break
                    selected = None
                    for job_id in queue.get("order") or []:
                        try: candidate = self._translation_job(job_id)
                        except (FileNotFoundError, ValueError): continue
                        if candidate.get("status") == "queued":
                            selected = candidate
                            break
                    if not selected:
                        break
                    selected["status"] = "running"
                    selected["attempts"] = int(selected.get("attempts") or 0) + 1
                    selected["error"] = ""
                    queue["active_id"] = selected["id"]
                    self._save_translation_job(selected)
                    self._save_translation_queue(queue)
                try:
                    with self._translation_lock:
                        status = self.translator.status()
                        if not status.get("online"):
                            raise RuntimeError("Ollama 当前不可用")
                        if not status.get("installed"):
                            raise RuntimeError("尚未安装 HY-MT 本地翻译模型")
                        result = self.translator.translate_with_quality(
                            str(selected.get("source_text") or ""),
                            "%s · %s" % (selected.get("item_name") or selected.get("item_id"), selected.get("field")),
                            lambda: None, str(selected.get("mode") or "faithful_zh"),
                        )
                    selected["translation"] = str(result.get("translation") or "")
                    selected["quality_status"] = str(result.get("quality_status") or "")
                    selected["quality_codes"] = [str(code) for code in result.get("quality_codes") or []]
                    selected["quality_reason"] = str(result.get("quality_reason") or "")[:500]
                    selected["quality_contract_version"] = TRANSLATION_QUALITY_CONTRACT_VERSION
                    if result.get("quality_status") == "pass":
                        selected["status"] = translation_job_completion_status(str(selected.get("apply_policy") or ""))
                        selected["error"] = ""
                    elif result.get("quality_status") == "needs_review":
                        # 有可用候选但存在回显/混杂/占位符疑点：不自动生效，交人工处理
                        selected["status"] = "pending_review"
                        selected["error"] = selected["quality_reason"]
                    else:
                        selected["status"] = "failed"
                        selected["error"] = selected["quality_reason"] or "模型未产生可用中文译文"
                    selected["completed_at"] = now_iso()
                except Exception as error:
                    selected["status"] = "failed"
                    selected["error"] = str(error)[:500]
                with self._translation_queue_lock:
                    latest = self._translation_job(selected["id"])
                    if latest.get("cancel_requested"):
                        selected["status"] = "cancelled"
                        selected["translation"] = ""
                    self._save_translation_job(selected)
                    queue = self._translation_queue()
                    if queue.get("active_id") == selected["id"]:
                        queue["active_id"] = ""
                    self._save_translation_queue(queue)

    def _job_dir(self, job_id: str) -> Path:
        if not re.fullmatch(r"job-[A-Za-z0-9_-]{8,80}", job_id or ""):
            raise ValueError("无效导出任务 ID")
        return self.jobs_root / job_id

    def _record_path(self, job_id: str) -> Path:
        return self._job_dir(job_id) / "job.json"

    def _load(self, job_id: str) -> dict:
        record = load_json(self._record_path(job_id), None)
        if not record:
            raise FileNotFoundError("导出任务不存在")
        return record

    def _save(self, record: dict) -> None:
        record["updated_at"] = now_iso()
        atomic_json(self._record_path(record["id"]), record)

    def create(self, request: dict) -> dict:
        if int(request.get("schema_version") or 0) != FORMAT_VERSION:
            raise ValueError("只接受 export-bundle v4")
        adventure = request.get("adventure") or {}
        if not adventure.get("id") or not adventure.get("name"):
            raise ValueError("导出请求缺少冒险 ID 或名称")
        job_id = "job-" + uuid.uuid4().hex
        job_dir = self._job_dir(job_id)
        (job_dir / "parts").mkdir(parents=True, exist_ok=False)
        record = {
            "id": job_id, "version": 1, "status": "uploading", "progress": 2,
            "stage": "接收导出清单", "request": request, "parts": {},
            "resolutions": {}, "warnings": [], "errors": [], "created_at": now_iso(),
        }
        self._save(record)
        return self.public(record)

    def put_part(self, job_id: str, kind: str, index: int, body: bytes, expected_hash: str = "") -> dict:
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,30}", kind or "") or index < 0 or index > 99999:
            raise ValueError("无效分块路径")
        if len(body) <= 0 or len(body) > PART_LIMIT:
            raise ValueError("分块必须在 1 字节到 8 MiB 之间")
        digest = sha256_bytes(body)
        if expected_hash and digest.lower() != expected_hash.lower():
            raise ValueError("分块哈希不匹配")
        json.loads(body.decode("utf-8"))
        path = self._job_dir(job_id) / "parts" / ("%s-%05d.json" % (kind, index))
        atomic_bytes(path, body)
        record = self._load(job_id)
        record.setdefault("parts", {}).setdefault(kind, {})[str(index)] = {"bytes": len(body), "sha256": digest}
        record["status"] = "uploading"
        record["stage"] = "接收 %s 分块" % kind
        self._save(record)
        return self.public(record)

    def _parts(self, record: dict, kind: str) -> list[dict]:
        result = []
        for index in sorted((record.get("parts", {}).get(kind) or {}), key=lambda value: int(value)):
            path = self._job_dir(record["id"]) / "parts" / ("%s-%05d.json" % (kind, int(index)))
            result.append(load_json(path, {}))
        return result

    def _assembled(self, record: dict) -> dict:
        bundle = {"messages": [], "events": [], "branches": [], "embedded_materials": []}
        fragments: dict[tuple[str, int], list[dict]] = {}
        for part in self._parts(record, "conversation"):
            for key in ("messages", "events", "branches"):
                bundle[key].extend(part.get(key) or [])
            for fragment in part.get("record_fragments") or []:
                key = (str(fragment.get("collection") or ""), int(fragment.get("position") or 0))
                fragments.setdefault(key, []).append(fragment)
            if part.get("recovery_status"):
                bundle["recovery_status"] = part["recovery_status"]
        for part in self._parts(record, "materials"):
            bundle["embedded_materials"].extend(part.get("materials") or [])
            for fragment in part.get("record_fragments") or []:
                key = (str(fragment.get("collection") or ""), int(fragment.get("position") or 0))
                fragments.setdefault(key, []).append(fragment)
        for (collection, position), pieces in fragments.items():
            if collection not in bundle:
                raise ValueError("未知分块记录集合：%s" % collection)
            pieces.sort(key=lambda item: int(item.get("fragment_index") or 0))
            total = int(pieces[0].get("fragment_total") or 0) if pieces else 0
            if total != len(pieces) or [int(item.get("fragment_index") or 0) for item in pieces] != list(range(total)):
                raise ValueError("记录分片不完整：%s[%d]" % (collection, position))
            value = json.loads("".join(str(item.get("data") or "") for item in pieces))
            position = max(0, min(position, len(bundle[collection])))
            bundle[collection].insert(position, value)
        if bundle["branches"]:
            merged_branches: dict[str, dict] = {}
            order: list[str] = []
            for branch in bundle["branches"]:
                branch_id = str(branch.get("id") or "branch-%d" % len(order))
                if branch_id not in merged_branches:
                    merged_branches[branch_id] = {key: value for key, value in branch.items() if key != "messages"}
                    merged_branches[branch_id]["messages"] = []
                    order.append(branch_id)
                merged_branches[branch_id]["messages"].extend(branch.get("messages") or [])
            bundle["branches"] = [merged_branches[key] for key in order]
        return bundle

    def _kb_path(self, relative: str) -> Path:
        relative = str(relative or "").replace("\\", "/")
        if not relative or relative.startswith("/") or ".." in relative.split("/"):
            raise ValueError("非法知识库相对路径")
        root = self.knowledge_base.resolve()
        candidate = (root / Path(relative)).resolve()
        if candidate != root and root not in candidate.parents:
            raise ValueError("知识库路径越界")
        return candidate

    def _candidate_sources(self, material: dict, preview: object = None) -> list[str]:
        title = str(material.get("title") or "").strip().lower()
        title_stems = {title, Path(title).stem.lower()}
        folder = "角色卡" if material.get("type") == "character_card" else "世界观设定"
        directory = self.knowledge_base / folder
        matches = []
        if not directory.is_dir():
            return matches
        for path in directory.glob("*.json"):
            if path.stem.lower() in title_stems:
                matches.append(path.relative_to(self.knowledge_base).as_posix())
                continue
            raw = load_json(path, {})
            inner = card_name(raw) if folder == "角色卡" else str(raw.get("name") or "")
            if inner.strip().lower() == title:
                matches.append(path.relative_to(self.knowledge_base).as_posix())
                continue
            if isinstance(preview, dict):
                if folder == "角色卡":
                    left, right = unwrap_card(normalize_material_raw(preview, "character_card")), unwrap_card(raw)
                    comparable = []
                    for key in ("description", "notes", "personality", "scenario", "first_mes", "system_prompt", "post_history_instructions"):
                        a, b = text_value(left.get(key)).strip(), text_value(right.get(key)).strip()
                        if a and b: comparable.append(a[:120] == b[:120] or a.startswith(b[:120]) or b.startswith(a[:120]))
                    if comparable and sum(comparable) >= min(2, len(comparable)):
                        matches.append(path.relative_to(self.knowledge_base).as_posix())
                else:
                    preview = normalize_material_raw(preview, "lorebook")
                    preview_keys = {key for entry in lore_entries(preview) for key in entry["keys"]}
                    raw_keys = {key for entry in lore_entries(raw) for key in entry["keys"]}
                    if preview_keys and len(preview_keys & raw_keys) >= min(2, len(preview_keys)):
                        matches.append(path.relative_to(self.knowledge_base).as_posix())
        return sorted(set(matches))

    def _resolve_materials(self, record: dict, assembled: dict) -> tuple[list[dict], list[dict]]:
        embedded = {item.get("mount_id"): item.get("raw") for item in assembled.get("embedded_materials") or []}
        resolved, unresolved = [], []
        for material in record["request"].get("materials") or []:
            item = dict(material)
            mount_id = str(item.get("mount_id") or "")
            source_ref = item.get("source_ref") or {}
            resolution = (record.get("resolutions") or {}).get(mount_id)
            if resolution == "__skip__":
                continue
            chosen = (resolution if resolution not in ("__incomplete__", None) else source_ref.get("relative_path"))
            embedded_raw = normalize_material_raw(embedded.get(mount_id), item.get("type") or "")
            raw = None
            path = None
            # When a mounted item lacks source_ref, try deterministic knowledge-base
            # recovery before accepting the embedded preview. This is what prevents
            # a truncated UI preview from becoming the export's alleged original.
            if not chosen and resolution is None and not source_ref:
                candidates = self._candidate_sources(item, embedded_raw)
                if len(candidates) == 1:
                    chosen = candidates[0]
                elif len(candidates) > 1:
                    unresolved.append({"mount_id": mount_id, "title": item.get("title"), "type": item.get("type"), "candidates": candidates})
                    continue
            if chosen:
                try:
                    path = self._kb_path(chosen)
                    if path.is_file():
                        data = path.read_bytes()
                        actual_hash = sha256_bytes(data)
                        expected = str(source_ref.get("source_hash") or "")
                        if expected and expected != actual_hash:
                            item.setdefault("warnings", []).append("源文件哈希已变化，使用当前完整文件")
                        raw = json.loads(data.decode("utf-8-sig"))
                        item["relative_path"] = path.relative_to(self.knowledge_base).as_posix()
                        item["source_hash"] = actual_hash
                except Exception as error:
                    item.setdefault("warnings", []).append(str(error))
            if raw is None and mount_id in embedded and (not source_ref or resolution == "__incomplete__"):
                raw = embedded_raw
                item["relative_path"] = "embedded://" + mount_id
                item["source_hash"] = sha256_json(raw)
                item["truncated"] = truncation_count(raw)
                if resolution == "__incomplete__" or item["truncated"]:
                    item.setdefault("warnings", []).append("用户接受当前挂载副本；完整原件未恢复")
                    item["incomplete"] = True
            if raw is None:
                candidates = self._candidate_sources(item, embedded_raw)
                unresolved.append({"mount_id": mount_id, "title": item.get("title"), "type": item.get("type"), "candidates": candidates})
                continue
            item["raw"] = raw
            resolved.append(item)
        return resolved, unresolved

    def preflight(self, job_id: str, resolutions: dict | None = None) -> dict:
        record = self._load(job_id)
        if resolutions:
            record.setdefault("resolutions", {}).update({str(key): str(value) for key, value in resolutions.items()})
        assembled = self._assembled(record)
        resolved, unresolved = self._resolve_materials(record, assembled)
        translator = self.translator
        estimate = sum(len(json.dumps(item.get("raw"), ensure_ascii=False)) for item in resolved)
        estimate += sum(len(str(message.get("content") or "")) for message in assembled.get("messages") or [])
        free = shutil.disk_usage(self.projects.parent if self.projects.parent.exists() else self.denova_dir).free
        warnings = []
        resolutions = record.get("resolutions") or {}
        skipped = [item.get("mount_id") for item in record["request"].get("materials") or [] if resolutions.get(str(item.get("mount_id") or "")) == "__skip__"]
        incomplete = [item.get("mount_id") for item in resolved if item.get("incomplete")]
        translation_fields = 0
        for item in resolved:
            raw = unwrap_card(item.get("raw")) if item.get("type") == "character_card" else item.get("raw")
            if item.get("type") == "character_card":
                for key in ("appearance", "personality", "relationship", "description", "notes", "scenario", "first_mes", "mes_example", "creator_notes", "character_note", "system_prompt", "post_history_instructions"):
                    if translator.needs_translation(text_value((raw or {}).get(key))): translation_fields += 1
                translation_fields += sum(1 for value in list_value((raw or {}).get("alternate_greetings")) if translator.needs_translation(text_value(value)))
            else:
                translation_fields += sum(1 for entry in lore_entries(raw) if translator.needs_translation(entry["content"]))
        recovery = assembled.get("recovery_status") or "best_effort"
        if recovery != "complete": warnings.append("现有冒险对话恢复等级为 %s" % recovery)
        if unresolved: warnings.append("有 %d 项素材未解析完整原件" % len(unresolved))
        if skipped: warnings.append("用户明确跳过 %d 项素材" % len(skipped))
        if incomplete: warnings.append("用户接受 %d 项不完整挂载副本" % len(incomplete))
        if free < max(estimate * 3, 64 * 1024 * 1024): warnings.append("可用磁盘空间可能不足")
        record.update({
            "status": "needs_resolution" if unresolved else "ready",
            "progress": 12, "stage": "预检完成", "warnings": warnings,
            "preflight": {
                "resolved_materials": len(resolved), "unresolved": unresolved,
                "main_messages": len(assembled.get("messages") or []),
                "branch_messages": sum(len(branch.get("messages") or []) for branch in assembled.get("branches") or []),
                "recovery_status": recovery, "estimated_bytes": estimate,
                "free_bytes": free, "translator": self.translator_status(), "translation_fields": translation_fields,
                "skipped": skipped, "incomplete": incomplete,
            },
        })
        self._save(record)
        return self.public(record)

    def _control(self, record: dict) -> None:
        latest = self._load(record["id"])
        desired = latest.get("desired_state")
        if desired == "cancelled": raise ExportCancelled()
        if desired == "paused": raise ExportPaused()

    def _register_project(self, name: str, project: Path) -> None:
        data = load_json(self.books_json, {"current": "", "books": [], "sort_mode": "recent"})
        found = next((item for item in data.get("books") or [] if item.get("path") == str(project) or item.get("name") == name), None)
        if found:
            found.update({"name": name, "path": str(project), "last_opened_at": now_iso()})
        else:
            data.setdefault("books", []).append({"name": name, "path": str(project), "author": "", "last_opened_at": now_iso()})
        atomic_json(self.books_json, data)

    def _project(self, request: dict) -> tuple[str, Path]:
        adventure = request.get("adventure") or {}
        sync_id = str(adventure.get("sync_id") or "")
        sync_index = load_json(self.denova_dir / "narraverse-sync-index.json", {"items": {}})
        entry = (sync_index.get("items") or {}).get(sync_id) if sync_id else None
        if isinstance(entry, dict) and entry.get("path"):
            candidate = Path(str(entry["path"])).resolve()
            root = self.projects.resolve()
            if candidate == root or root in candidate.parents:
                return safe_name(entry.get("projectName") or adventure.get("name")), candidate
        name = safe_name(adventure.get("name"))
        return name, self.projects / name

    def _source_files(self, materials: list[dict]) -> tuple[dict[str, bytes], list[dict]]:
        files, inventory = {}, []
        for material in materials:
            raw = material["raw"]
            mount_id = str(material.get("mount_id") or uuid.uuid4().hex)
            filename = safe_name(material.get("title"), "素材") + ".json"
            relative = ".narraverse/source/materials/%s-%s" % (mount_id[:24], filename)
            data = (json.dumps(raw, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            files[relative] = data
            inventory.append({
                "mount_id": mount_id, "type": material.get("type"), "title": material.get("title"),
                "source_id": (material.get("source_ref") or {}).get("source_id"),
                "source_path": material.get("relative_path"), "source_hash": material.get("source_hash"),
                "target_path": relative, "bytes": len(data), "incomplete": bool(material.get("incomplete")),
                "truncated": int(material.get("truncated") or 0),
                "warnings": material.get("warnings") or [],
            })
        return files, inventory

    def _transcript_files(self, assembled: dict) -> tuple[dict[str, bytes], dict]:
        messages = assembled.get("messages") or []
        rows, markdown = [], ["# 对话全文", ""]
        for index, message in enumerate(messages):
            if message.get("role") not in ("user", "assistant"):
                continue
            row = {
                "id": message.get("id") or "message-%d" % (index + 1), "role": message.get("role"),
                "content": str(message.get("content") or ""), "created_at": message.get("createdAt") or message.get("created_at"),
            }
            rows.append(row)
            markdown.extend(["## %s · %d" % ("玩家" if row["role"] == "user" else "叙事者", len(rows)), "", row["content"], ""])
        files = {
            ".narraverse/source/conversation.jsonl": ("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + ("\n" if rows else "")).encode("utf-8"),
            "对话全文.md": "\n".join(markdown).encode("utf-8"),
        }
        shard, shard_bytes, shard_index = [], 0, 1
        for row in rows:
            block = "## %s\n\n%s\n\n" % ("玩家" if row["role"] == "user" else "叙事者", row["content"])
            block_bytes = len(block.encode("utf-8"))
            if shard and shard_bytes + block_bytes > TRANSCRIPT_TARGET_BYTES:
                files["chapters/剧情实录-%03d.md" % shard_index] = ("# 剧情实录 %03d\n\n" % shard_index + "".join(shard)).encode("utf-8")
                shard, shard_bytes, shard_index = [], 0, shard_index + 1
            shard.append(block); shard_bytes += block_bytes
        if shard or not rows:
            files["chapters/剧情实录-%03d.md" % shard_index] = ("# 剧情实录 %03d\n\n" % shard_index + "".join(shard)).encode("utf-8")
        branch_count = 0
        for branch in assembled.get("branches") or []:
            branch_id = re.sub(r"[^A-Za-z0-9_-]", "_", str(branch.get("id") or "branch"))[:80]
            content = []
            for message in branch.get("messages") or []:
                if message.get("role") in ("user", "assistant"):
                    content.append(json.dumps({"id": message.get("id"), "role": message.get("role"), "content": message.get("content"), "created_at": message.get("createdAt")}, ensure_ascii=False))
                    branch_count += 1
            files[".narraverse/source/branches/%s.jsonl" % branch_id] = (("\n".join(content) + "\n") if content else "").encode("utf-8")
        return files, {"main_messages": len(rows), "branch_messages": branch_count, "shards": shard_index, "recovery_status": assembled.get("recovery_status") or "best_effort"}

    def _character_items(self, sync_id: str, material: dict, player: str, translator: LocalTranslator | None, check_control, failures: list[dict] | None = None) -> tuple[list[dict], list[dict]]:
        failures = failures if failures is not None else []
        raw = material["raw"]
        data = unwrap_card(raw)
        name = str(data.get("name") or data.get("名字") or material.get("title") or "角色").strip()
        source_id = str((material.get("source_ref") or {}).get("source_id") or material.get("source_hash") or material.get("mount_id"))
        aliases = list_value(data.get("alternate_names") or data.get("aliases"))
        common = {
            "appearance": data.get("appearance") or data.get("外貌"),
            "personality": data.get("personality") or data.get("性格"),
            "relationship": data.get("relationship") or data.get("关系"),
            "description": data.get("description") or data.get("notes") or data.get("背景"),
            "scenario": data.get("scenario"),
        }
        roleplay = {
            "first_mes": data.get("first_mes"), "alternate_greetings": data.get("alternate_greetings"),
            "mes_example": data.get("mes_example") or data.get("example_dialogue"),
        }
        extensions = data.get("extensions") if isinstance(data.get("extensions"), dict) else {}
        depth = extensions.get("depth_prompt") if isinstance(extensions.get("depth_prompt"), dict) else {}
        constraints = {
            "creator_notes": data.get("creator_notes"), "character_note": data.get("character_note") or depth.get("prompt"),
            "note_depth": data.get("note_depth") if data.get("note_depth") is not None else depth.get("depth"),
            "system_prompt": data.get("system_prompt"), "post_history_instructions": data.get("post_history_instructions"),
        }
        groups = [("core", "核心设定", common, "auto"), ("roleplay", "演绎参考", roleplay, "auto"), ("constraints", "创作者约束", constraints, "manual")]
        items, routes = [], []
        for group, label, fields, mode in groups:
            nonempty = [(key, text_value(value)) for key, value in fields.items() if text_value(value)]
            if not nonempty:
                continue
            item_id = stable_id(sync_id, source_id, group)
            sections = []
            for key, value in nonempty:
                original = value
                translated = translate_field(translator, original, "%s · %s · %s" % (name, label, key), check_control, failures, material, key)
                sections.append("## %s\n%s" % (key, translated))
                routes.append({"source_id": source_id, "field": key, "target_group": group, "target_id": item_id, "translated": translated != original})
            content = "# %s · %s\n\n%s" % (name, label, "\n\n".join(sections))
            items.append({
                "id": item_id, "enabled": True, "type": "character", "type_source": "import",
                "name": "%s · %s" % (name, label), "importance": "major" if material.get("resident") and group == "core" else "important",
                "tags": list(dict.fromkeys(list_value(data.get("tags")) + ["Narraverse", label])),
                "brief_description": short_brief(content, "character", name),
                "keywords": list(dict.fromkeys([name] + aliases)),
                "load_mode": "resident" if material.get("resident") and group == "core" else mode,
                "content": content, "created_at": now_iso(), "updated_at": now_iso(),
                "provenance": {"source": "narraverse", "sync_id": sync_id, "source_id": source_id, "group": group},
            })
        embedded_book = data.get("character_book")
        if isinstance(embedded_book, dict):
            child = dict(material)
            child["raw"] = embedded_book
            child["type"] = "lorebook"
            child["title"] = name + " · 角色内嵌设定"
            child["source_hash"] = sha256_json(embedded_book)
            world_items, world_routes = self._lore_items(sync_id, child, translator, check_control, failures)
            items.extend(world_items); routes.extend(world_routes)
        return items, routes

    def _lore_items(self, sync_id: str, material: dict, translator: LocalTranslator | None, check_control, failures: list[dict] | None = None) -> tuple[list[dict], list[dict]]:
        failures = failures if failures is not None else []
        source_id = str((material.get("source_ref") or {}).get("source_id") or material.get("source_hash") or material.get("mount_id"))
        items, routes = [], []
        for entry in lore_entries(material["raw"]):
            entry_source = source_id + ":" + entry["source_entry_id"]
            original = entry["content"]
            field = "entries.%s.content" % entry["source_entry_id"]
            translated = translate_field(translator, original, "%s · %s" % (material.get("title"), "、".join(entry["keys"])), check_control, failures, material, field)
            name = entry["comment"] or entry["keys"][0]
            item_type = infer_type(" ".join(entry["keys"]) + " " + entry["comment"])
            mode = "resident" if material.get("resident") else "auto"
            if not entry["enabled"] or re.search(r"正则|regex|脚本|script", name, re.I): mode = "manual"
            item = {
                "id": stable_id(sync_id, entry_source, "entry"), "enabled": entry["enabled"],
                "type": item_type, "type_source": "import", "name": name[:100],
                "importance": "major" if mode == "resident" else "important",
                "tags": [safe_name(material.get("title"), "设定书"), "Narraverse"],
                "brief_description": short_brief(translated, item_type, name),
                "keywords": list(dict.fromkeys(entry["keys"] + entry["secondary_keys"])),
                "load_mode": mode, "content": translated, "created_at": now_iso(), "updated_at": now_iso(),
                "provenance": {"source": "narraverse", "sync_id": sync_id, "source_id": source_id, "source_entry_id": entry["source_entry_id"], "order": entry["order"]},
            }
            items.append(item)
            routes.append({"source_id": source_id, "field": field, "target_id": item["id"], "translated": translated != original})
        return items, routes

    def _map_items(self, record: dict, materials: list[dict], translator: LocalTranslator | None) -> tuple[list[dict], list[dict], list[dict]]:
        request = record["request"]
        sync_id = str((request.get("adventure") or {}).get("sync_id") or (request.get("adventure") or {}).get("id"))
        player = str((request.get("adventure") or {}).get("player_name") or "玩家")
        items, routes, failures = [], [], []
        for index, material in enumerate(materials):
            self._control(record)
            try:
                mapped, field_routes = (self._character_items(sync_id, material, player, translator, lambda: self._control(record), failures)
                                        if material.get("type") == "character_card"
                                        else self._lore_items(sync_id, material, translator, lambda: self._control(record), failures))
                items.extend(mapped); routes.extend(field_routes)
            except (ExportPaused, ExportCancelled):
                raise
            except Exception as error:
                failures.append({"mount_id": material.get("mount_id"), "title": material.get("title"), "field": "*", "error": str(error)})
                mapped, field_routes = (self._character_items(sync_id, material, player, None, lambda: None)
                                        if material.get("type") == "character_card"
                                        else self._lore_items(sync_id, material, None, lambda: None))
                items.extend(mapped); routes.extend(field_routes)
            latest = self._load(record["id"])
            latest["progress"] = 42 + int(35 * (index + 1) / max(1, len(materials)))
            latest["stage"] = "整理资料 %d/%d" % (index + 1, len(materials))
            self._save(latest)
        return items, routes, failures

    def _merge_lore(self, project: Path, incoming: list[dict], previous_manifest: dict) -> tuple[list[dict], list[dict], dict]:
        lore_path = project / ".denova/lore/items.json"
        current = load_json(lore_path, {"version": 2, "items": []})
        current_items = current.get("items") or []
        by_id = {str(item.get("id")): item for item in current_items}
        baseline = previous_manifest.get("managed_lore") or {}
        incoming_ids = {item["id"] for item in incoming}
        conflicts, merged = [], []
        for item in incoming:
            existing = by_id.get(item["id"])
            prior_hash = (baseline.get(item["id"]) or {}).get("hash")
            if existing and (not prior_hash or content_hash(existing) != prior_hash):
                conflicts.append({"id": item["id"], "name": item.get("name"), "existing_hash": content_hash(existing), "incoming_hash": content_hash(item), "incoming": item})
                merged.append(existing)
            else:
                merged.append(item)
        for existing in current_items:
            item_id = str(existing.get("id"))
            if item_id in incoming_ids:
                continue
            prior_hash = (baseline.get(item_id) or {}).get("hash")
            if not prior_hash or content_hash(existing) != prior_hash:
                merged.append(existing)
        managed = {item["id"]: {"hash": content_hash(item), "name": item.get("name")} for item in incoming if not any(conflict["id"] == item["id"] for conflict in conflicts)}
        return merged, conflicts, managed

    def _commit(self, project: Path, files: dict[str, bytes]) -> Path | None:
        timestamp = time.strftime("%Y%m%d-%H%M%S")
        backup_root = project / ".narraverse/backups" / timestamp
        written, existing = [], {}
        try:
            for relative, data in files.items():
                target = project / Path(relative)
                if target.is_file():
                    backup = backup_root / Path(relative)
                    backup.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(target, backup)
                    existing[relative] = backup
                else:
                    existing[relative] = None
                atomic_bytes(target, data)
                written.append(relative)
            return backup_root if any(path for path in existing.values()) else None
        except Exception:
            for relative in reversed(written):
                target = project / Path(relative)
                backup = existing.get(relative)
                if backup and backup.is_file(): shutil.copy2(backup, target)
                elif target.exists(): target.unlink()
            raise

    def _run(self, job_id: str) -> None:
        record = self._load(job_id)
        try:
            record.update({"status": "running", "progress": 18, "stage": "回源完整原件", "desired_state": "running"})
            self._save(record)
            assembled = self._assembled(record)
            materials, unresolved = self._resolve_materials(record, assembled)
            if unresolved:
                raise RuntimeError("仍有 %d 项素材未解析，不能声称全量导入" % len(unresolved))
            name, project = self._project(record["request"])
            project.mkdir(parents=True, exist_ok=True)
            previous = load_json(project / ".narraverse/import-manifest.json", {})
            source_files, source_inventory = self._source_files(materials)
            transcript_files, transcript_stats = self._transcript_files(assembled)
            adventure = record["request"].get("adventure") or {}
            resolutions = record.get("resolutions") or {}
            skipped = [item.get("mount_id") for item in record["request"].get("materials") or [] if resolutions.get(str(item.get("mount_id") or "")) == "__skip__"]
            incomplete = [item.get("mount_id") for item in materials if item.get("incomplete")]
            custom_prompt = str(adventure.get("custom_prompt") or "")
            runtime = "# 运行约束\n\n## 用户自定义规则\n%s\n\n## 自动系统提示\n仅记录 SHA-256：%s\n" % (custom_prompt or "（无）", str(adventure.get("system_prompt_hash") or "（无）"))
            raw_manifest = {
                "version": MANIFEST_VERSION, "format_version": FORMAT_VERSION, "status": "raw_committed",
                "exported_at": now_iso(), "adventure_id": adventure.get("id"), "sync_id": adventure.get("sync_id"),
                "source": "narraverse", "conversation": transcript_stats, "materials": source_inventory,
                "translation": {"status": "pending" if record["request"].get("options", {}).get("translate_to_zh", True) else "disabled"},
                "counts": {"character_cards": sum(1 for item in materials if item.get("type") == "character_card"), "lorebooks": sum(1 for item in materials if item.get("type") == "lorebook")},
                "truncated": sum(int(item.get("truncated") or 0) for item in materials), "omissions": {"skipped": skipped, "incomplete": incomplete},
                "conflicts": [], "failures": [], "managed_lore": previous.get("managed_lore") or {},
            }
            raw_files = dict(source_files); raw_files.update(transcript_files)
            raw_files[".narraverse/source/runtime-instructions.md"] = runtime.encode("utf-8")
            raw_files[".narraverse/import-manifest.json"] = (json.dumps(raw_manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            self._commit(project, raw_files)
            record.update({"status": "running", "progress": 38, "stage": "完整英文原件已提交", "project_path": str(project).replace("\\", "/")})
            self._save(record)
            self._control(record)

            translate_enabled = bool(record["request"].get("options", {}).get("translate_to_zh", True))
            translator = LocalTranslator(self.cache_root, self.glossary_path)
            override = record["request"].get("options", {}).get("glossary") or {}
            if isinstance(override, dict):
                translator.glossary = {
                    "version": "%s+%s" % (translator.glossary.get("version", 1), override.get("version", 1)),
                    "terms": {**(translator.glossary.get("terms") or {}), **(override.get("terms") or {})},
                    "do_not_translate": list(dict.fromkeys((translator.glossary.get("do_not_translate") or []) + (override.get("do_not_translate") or []))),
                }
            translator_status = self.translator.status()
            active_translator = translator if translate_enabled and translator_status.get("installed") else None
            items, routes, translation_failures = self._map_items(record, materials, active_translator)
            merged, conflicts, managed = self._merge_lore(project, items, previous)
            conflict_files = {}
            conflict_stamp = time.strftime("%Y%m%d-%H%M%S")
            for conflict in conflicts:
                conflict_files[".narraverse/conflicts/%s/%s.json" % (conflict_stamp, conflict["id"])] = (json.dumps(conflict, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            setting = adventure.get("setting") or {}
            creator = "\n".join([
                "# 《%s》" % name, "", "## 迁移后的事实边界",
                "- `.narraverse/source/` 与剧情实录是已发生事实和原始真源。",
                "- 资料库是稳定人物/世界设定；请按关键词检索，不要每轮加载全部条目。",
                "- 大纲与导演计划只描述未来规划，不得覆盖已发生剧情。", "",
                "## 玩家身份", str(setting.get("identity") or ""), "", "## 当前目标", str(setting.get("goal") or ""), "",
            ])
            setting_doc = "# 冒险设定\n\n## 世界背景\n%s\n\n## 玩家身份\n%s\n\n## 初始目标\n%s\n\n## 其他说明\n%s\n" % (
                setting.get("world") or "", setting.get("identity") or "", setting.get("goal") or "", setting.get("other") or "")
            final_manifest = dict(raw_manifest)
            translation_pending = translate_enabled and not translator_status.get("installed")
            final_manifest.update({
                "status": "completed_with_warnings" if (translation_failures or conflicts or translation_pending or skipped or incomplete or transcript_stats["recovery_status"] != "complete") else "complete",
                "completed_at": now_iso(), "field_routes": routes,
                "translation": {"status": "model_missing" if translation_pending else "completed" if active_translator else "disabled", "model": translator.model if translate_enabled else "", "failures": translation_failures},
                "conflicts": [{key: value for key, value in conflict.items() if key != "incoming"} for conflict in conflicts],
                "failures": translation_failures, "managed_lore": managed,
                "counts": {**raw_manifest["counts"], "lore_items": len(items), "stored_items": len(merged), "field_routes": len(routes)},
            })
            final_files = {
                ".denova/lore/items.json": (json.dumps({"version": 2, "items": merged}, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
                "CREATOR.md": creator.encode("utf-8"), "setting/world.md": setting_doc.encode("utf-8"),
                ".narraverse/import-manifest.json": (json.dumps(final_manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
            }
            final_files.update(conflict_files)
            self._commit(project, final_files)
            self._register_project(name, project)
            record.update({
                "status": final_manifest["status"], "progress": 100, "stage": "验收完成",
                "report": {"path": str(project).replace("\\", "/"), **final_manifest["counts"], **transcript_stats,
                           "translation_failures": len(translation_failures), "conflicts": len(conflicts), "truncated": final_manifest.get("truncated", 0),
                           "translation_status": final_manifest["translation"]["status"], "skipped": len(skipped), "incomplete": len(incomplete)},
                "warnings": list(dict.fromkeys((record.get("warnings") or []) + (["本地 HY-MT 未安装，已完整导入英文原文"] if translation_pending else []) + (["有 %d 个 Denova 手工编辑冲突未覆盖" % len(conflicts)] if conflicts else []) + (["用户明确跳过 %d 项素材" % len(skipped)] if skipped else []) + (["有 %d 项素材仅使用不完整挂载副本" % len(incomplete)] if incomplete else []))),
                "desired_state": "completed",
            })
            self._save(record)
        except ExportPaused:
            record = self._load(job_id); record.update({"status": "paused", "stage": "已暂停，可继续", "desired_state": "paused"}); self._save(record)
        except ExportCancelled:
            record = self._load(job_id); record.update({"status": "cancelled", "stage": "已取消；已提交的完整原件保留", "desired_state": "cancelled"}); self._save(record)
        except Exception as error:
            record = self._load(job_id); record.setdefault("errors", []).append(str(error)); record.update({"status": "failed", "stage": "导出失败", "desired_state": "failed"}); self._save(record)

    def start(self, job_id: str) -> dict:
        record = self._load(job_id)
        if record.get("status") == "needs_resolution": raise ValueError("仍有素材未解析")
        with self._lock:
            current = self._threads.get(job_id)
            if current and current.is_alive(): return self.public(record)
            record["desired_state"] = "running"; record["status"] = "queued"; record["stage"] = "等待执行"; self._save(record)
            thread = threading.Thread(target=self._run, args=(job_id,), daemon=True, name="denova-full-export-" + job_id[-8:])
            self._threads[job_id] = thread; thread.start()
        return self.public(record)

    def pause(self, job_id: str) -> dict:
        record = self._load(job_id); record["desired_state"] = "paused"; record["stage"] = "正在暂停"; self._save(record); return self.public(record)

    def resume(self, job_id: str) -> dict:
        record = self._load(job_id); record["desired_state"] = "running"; self._save(record); return self.start(job_id)

    def cancel(self, job_id: str) -> dict:
        record = self._load(job_id); record["desired_state"] = "cancelled"; record["stage"] = "正在取消"; self._save(record); return self.public(record)

    def get(self, job_id: str) -> dict:
        return self.public(self._load(job_id))

    @staticmethod
    def public(record: dict) -> dict:
        return {key: value for key, value in record.items() if key not in ("request", "parts", "resolutions")}
