# -*- coding: utf-8 -*-
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import denova_full_export as export
from denova_full_export import LocalTranslator, translation_job_completion_status


def make_translator() -> LocalTranslator:
    root = Path(tempfile.mkdtemp(prefix="nv-quality-"))
    glossary = root / "glossary.json"
    glossary.write_text(json.dumps({"version": 1, "terms": {}, "do_not_translate": []}), encoding="utf-8")
    return LocalTranslator(root / "cache", glossary)


def run_translate(translator: LocalTranslator, replies, text: str, mode: str = "faithful_zh") -> dict:
    """Patch the Ollama call with scripted model replies (one per attempt)."""
    replies = list(replies)
    with mock.patch.object(LocalTranslator, "_call_model", side_effect=replies):
        return translator.translate_with_quality(text, "测试上下文", lambda: None, mode)


class QualityContractTest(unittest.TestCase):
    def test_pass_on_clean_chinese(self):
        translator = make_translator()
        result = run_translate(translator, ["她走进图书馆，安静地坐了下来。"], "She walks into the library and sits down quietly.")
        self.assertEqual(result["quality_status"], "pass")
        self.assertEqual(result["quality_codes"], [])
        self.assertIn("图书馆", result["translation"])
        # pass 结果必须写入成功缓存
        cache_files = list(translator.cache_root.glob("*.json"))
        self.assertEqual(len(cache_files), 1)
        self.assertEqual(json.loads(cache_files[0].read_text(encoding="utf-8"))["quality_status"], "pass")

    def test_source_echo_goes_to_needs_review_with_retry(self):
        translator = make_translator()
        source = "She walks into the library and sits down quietly."
        result = run_translate(translator, [source, source], source)
        self.assertEqual(result["quality_status"], "needs_review")
        self.assertIn("source_echo", result["quality_codes"])
        # 两次都未通过不得写成功缓存
        self.assertEqual(list(translator.cache_root.glob("*.json")), [])

    def test_mixed_language_goes_to_needs_review(self):
        translator = make_translator()
        result = run_translate(translator, [
            "她走进图书馆，She walks into the library and sits down quietly，安静地坐下。",
            "她走进图书馆，She walks into the library and sits down quietly，安静地坐下。",
        ], "She walks into the library and sits down quietly. The room is silent.")
        self.assertEqual(result["quality_status"], "needs_review")
        self.assertIn("mixed_language", result["quality_codes"])

    def test_legal_english_tokens_do_not_trigger_review(self):
        translator = make_translator()
        result = run_translate(
            translator,
            ["她的用户名是 {{user}}，主页在 https://example.com/about，等级 42。"],
            "Her username is {{user}} and her page is https://example.com/about with level 42.",
        )
        self.assertEqual(result["quality_status"], "pass")
        self.assertIn("{{user}}", result["translation"])
        self.assertIn("https://example.com/about", result["translation"])

    def test_missing_placeholder_goes_to_needs_review(self):
        translator = make_translator()
        result = run_translate(
            translator,
            ["她打开了链接。", "她打开了链接。"],
            "She opens https://example.com/a and https://example.com/b quickly.",
        )
        self.assertEqual(result["quality_status"], "needs_review")
        self.assertIn("placeholder_mismatch", result["quality_codes"])
        self.assertNotIn("https://example.com/a", result["translation"])
        self.assertNotIn("https://example.com/b", result["translation"])

    def test_translation_selector_ignores_machine_tokens_but_accepts_prose(self):
        translator = make_translator()
        self.assertFalse(translator.needs_translation("https://example.com/a {{user}} HUD HP MP NPC"))
        self.assertFalse(translator.needs_translation("中文 RPG系统"))
        self.assertTrue(translator.needs_translation("The room is quiet."))
        self.assertTrue(translator.needs_translation("Harbor"))
        self.assertTrue(translator.needs_translation("Age: 15"))

    def test_short_english_echo_and_mixed_word_need_review(self):
        translator = make_translator()
        echoed = run_translate(translator, ["Harbor", "Harbor"], "Harbor")
        self.assertIn("source_echo", echoed["quality_codes"])
        mixed = run_translate(translator, ["她走进 library。", "她走进 library。"], "She enters the library.")
        self.assertIn("mixed_language", mixed["quality_codes"])

    def test_structure_and_source_echo_quality_checks(self):
        translator = make_translator()
        structure = translator._assess_quality(
            "### 标题\n- 一项",
            "### Title\n- One",
            [],
            "faithful_zh",
        )
        self.assertEqual(structure["quality_status"], "pass")
        structure = translator._assess_quality(
            "标题\n一项",
            "### Title\n- One",
            [],
            "faithful_zh",
        )
        self.assertEqual(structure["quality_status"], "needs_review")
        self.assertIn("structure_mismatch", structure["quality_codes"])
        echoed = translator._assess_quality(
            "The old library stands near the river bank today.",
            "The old library stands near the river bank today.",
            [],
            "faithful_zh",
        )
        self.assertIn("source_echo", echoed["quality_codes"])

    def test_chunks_keep_markdown_groups_and_protected_tokens_intact(self):
        translator = make_translator()
        source = "# 标题\n\n" + "\n".join("- The old library entry number %d is still available." % index for index in range(60))
        protected, values = translator.protect(source + " https://example.com/keep")
        pieces = translator.chunks(protected)
        self.assertGreater(len(pieces), 1)
        self.assertTrue(all(len(piece) <= export.TRANSLATION_CHUNK_MAX or "__NV_PROTECTED_" in piece for piece in pieces))
        token = values[-1][0]
        self.assertEqual(sum(piece.count(token) for piece in pieces), 1)

    def test_first_failure_retry_passes(self):
        translator = make_translator()
        source = "The old library stands near the river."
        result = run_translate(translator, [source, "那座老图书馆矗立在河边。"], source)
        self.assertEqual(result["quality_status"], "pass")
        self.assertIn("图书馆", result["translation"])

    def test_both_failures_keep_best_candidate_for_review(self):
        translator = make_translator()
        source = "The old library stands near the river bank today."
        result = run_translate(
            translator,
            [source, "那座老 the old library 矗立在河边。"],
            source,
        )
        self.assertEqual(result["quality_status"], "needs_review")
        # 候选保留人工参考，而不是被当成 pass
        self.assertNotEqual(result["quality_status"], "pass")
        self.assertTrue(result["translation"])

    def test_model_error_marks_failed(self):
        translator = make_translator()
        def boom(prompt):
            raise RuntimeError("connection refused")
        with mock.patch.object(LocalTranslator, "_call_model", side_effect=boom):
            result = translator.translate_with_quality("The library is quiet.", "ctx", lambda: None, "faithful_zh")
        self.assertEqual(result["quality_status"], "failed")
        self.assertIn("bridge_or_model_error", result["quality_codes"])

    def test_cached_result_revalidated_by_current_contract(self):
        translator = make_translator()
        source = "She walks into the library and sits down quietly."
        # 预置一份旧坏缓存（回显原文）
        key = translator.cache_key(translator.protect(source)[0], "测试上下文", "faithful_zh")
        (translator.cache_root / (key + ".json")).write_text(
            json.dumps({"translation": source, "model": translator.model, "mode": "faithful_zh"}),
            encoding="utf-8",
        )
        result = run_translate(translator, ["她走进图书馆，安静地坐了下来。"], source)
        self.assertEqual(result["quality_status"], "pass")
        self.assertIn("图书馆", result["translation"])
        cached = json.loads((translator.cache_root / (key + ".json")).read_text(encoding="utf-8"))
        self.assertIn("图书馆", cached["translation"])

    def test_empty_output_marks_failed(self):
        translator = make_translator()
        result = run_translate(translator, ["", ""], "The library is quiet.")
        self.assertEqual(result["quality_status"], "failed")
        self.assertIn("empty_output", result["quality_codes"])

    def test_name_mode_keeps_latin_out(self):
        translator = make_translator()
        result = run_translate(translator, ["Alice", "爱丽丝"], "Alice", mode="name_zh")
        self.assertEqual(result["quality_status"], "pass")
        self.assertEqual(result["translation"], "爱丽丝")

    def test_translate_wrapper_raises_on_non_pass(self):
        translator = make_translator()
        source = "She walks into the library and sits down quietly."
        with mock.patch.object(LocalTranslator, "_call_model", side_effect=[source, source]):
            with self.assertRaises(RuntimeError):
                translator.translate(source, "ctx", lambda: None, "faithful_zh")


class VersionSummaryTest(unittest.TestCase):
    def test_versions_bumped_and_in_cache_key(self):
        self.assertEqual(export.TRANSLATION_CACHE_VERSION, 12)
        self.assertEqual(export.TRANSLATION_PROMPT_VERSION, 9)
        self.assertEqual(export.TRANSLATION_VALIDATOR_VERSION, 9)
        self.assertEqual(export.TRANSLATION_QUALITY_CONTRACT_VERSION, 2)
        translator = make_translator()
        base = translator.cache_key("text", "ctx", "faithful_zh")
        with mock.patch.object(export, "TRANSLATION_PROMPT_VERSION", 99):
            other = translator.cache_key("text", "ctx", "faithful_zh")
        self.assertNotEqual(base, other)

    def test_completion_status_keeps_master_review_pending(self):
        self.assertEqual(translation_job_completion_status("master_review"), "pending_review")
        self.assertEqual(translation_job_completion_status("master_auto"), "completed")
        self.assertEqual(translation_job_completion_status("auto_apply_metadata"), "completed")
        self.assertEqual(translation_job_completion_status("review_content"), "pending_review")


class MasterTranslationFieldPathTest(unittest.TestCase):
    def test_accepts_stable_nested_entry_paths_without_accepting_traversal(self):
        self.assertTrue(export.valid_translation_field_path("character.name"))
        self.assertTrue(export.valid_translation_field_path("lorebook.entries/entry-abc123/content"))
        self.assertTrue(export.valid_translation_field_path("character_book.entries/entry-abc123/secondary_keys"))
        self.assertFalse(export.valid_translation_field_path("lorebook.entries/../content"))
        self.assertFalse(export.valid_translation_field_path("lorebook.entries/entry-abc123/runtime_script"))


if __name__ == "__main__":
    unittest.main()
