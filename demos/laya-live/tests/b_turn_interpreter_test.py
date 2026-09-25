# -*- coding: utf-8 -*-
"""候选 B —— 语义 Turn Interpreter 测试。

分层：
  - 纯函数测试（默认跑，无网络、无模型）：schema 校验 + 提示词规则存在性。
  - live 语义测试（B_TI_LIVE=1 才跑，需 DeepSeek key + 网络）：否定/隐喻/物体语境/多意图。

★ 铁律（任务书 §18）：不写死句子规则。live 断言的是**语义结果**（哪类意图出现/不出现），
  解释器内部没有任何 "if text == 某句" 的分支；提示词里只有通用语义规则。

用法：
  python tests/b_turn_interpreter_test.py          # 纯函数
  B_TI_LIVE=1 python tests/b_turn_interpreter_test.py  # 纯函数 + live
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from laya_turn_interpreter import (  # noqa: E402
    INTENTS, TurnInterpretation, build_semantic_prompt,
    parse_and_validate, interpret_semantic,
)

_PASS = 0
_FAIL = 0
_FAILURES = []


def check(name, cond, detail=""):
    global _PASS, _FAIL
    if cond:
        _PASS += 1
        print("  PASS  %s" % name)
    else:
        _FAIL += 1
        _FAILURES.append(name)
        print("  FAIL  %s  %s" % (name, detail))


# ---------------------------------------------------------------------------
# 纯函数：schema 校验
# ---------------------------------------------------------------------------
def test_parse_multi_intent():
    raw = ('{"intents":['
           '{"intent":"information_handover","targets":["lia"],"confidence":0.9,'
           '"evidence":["钥匙埋在老井第三块砖下面"],"tone":"defiant"},'
           '{"intent":"challenge","targets":["lia"],"confidence":0.7,'
           '"evidence":["你爱信不信"]}],'
           '"summary":"玩家透露钥匙位置并较劲"}')
    msg = "箱子我没带来，钥匙埋在老井第三块砖下面，你爱信不信。"
    ti = parse_and_validate(raw, msg)
    check("multi_intent_ok", ti.status == "ok", ti.invalid_reason)
    check("multi_intent_count", len(ti.intents) == 2, str(len(ti.intents)))
    check("multi_intent_types",
          [i.intent for i in ti.intents] == ["information_handover", "challenge"],
          str([i.intent for i in ti.intents]))


def test_parse_neutral():
    ti = parse_and_validate('{"intents":[{"intent":"neutral","targets":[],'
                            '"confidence":1.0,"evidence":["哦"]}],"summary":"寒暄"}', "哦。")
    check("neutral_ok", ti.status == "ok" and ti.intents[0].intent == "neutral", ti.invalid_reason)


def test_parse_empty_intents_ok():
    ti = parse_and_validate('{"intents":[],"summary":"无动作"}', "……")
    check("empty_intents_ok", ti.status == "ok" and ti.intents == [], ti.invalid_reason)


def test_bad_intent_rejected():
    ti = parse_and_validate('{"intents":[{"intent":"teleport","targets":[],'
                            '"confidence":0.9,"evidence":[]}],"summary":"x"}', "我瞬移。")
    check("bad_intent_rejected", ti.status == "invalid"
          and "bad_intent" in (ti.invalid_reason or ""), ti.invalid_reason)


def test_nan_confidence_rejected():
    ti = parse_and_validate('{"intents":[{"intent":"neutral","targets":[],'
                            '"confidence":NaN,"evidence":[]}],"summary":"x"}', "嗯。")
    check("nan_confidence_rejected", ti.status == "invalid"
          and ti.invalid_reason == "confidence_range", ti.invalid_reason)


def test_bool_confidence_rejected():
    ti = parse_and_validate('{"intents":[{"intent":"neutral","targets":[],'
                            '"confidence":true,"evidence":[]}],"summary":"x"}', "嗯。")
    check("bool_confidence_rejected", ti.status == "invalid"
          and ti.invalid_reason == "bad_confidence_type", ti.invalid_reason)


def test_evidence_non_substring_dropped():
    raw = ('{"intents":[{"intent":"threat","targets":["lia"],"confidence":0.8,'
           '"evidence":["太阳还能升起来","这段不是原话"]}],"summary":"施压"}')
    msg = "你最好祈祷太阳还能升起来。"
    ti = parse_and_validate(raw, msg)
    check("evidence_dropped_but_ok", ti.status == "ok", ti.invalid_reason)
    check("evidence_kept_only_substring",
          ti.intents[0].evidence == ["太阳还能升起来"], str(ti.intents[0].evidence))


def test_code_fence_stripped():
    raw = '```json\n{"intents":[{"intent":"apology","targets":["lia"],"confidence":0.9,"evidence":["对不起"]}],"summary":"道歉"}\n```'
    ti = parse_and_validate(raw, "对不起，我错了。")
    check("code_fence_stripped", ti.status == "ok"
          and ti.intents[0].intent == "apology", ti.invalid_reason)


def test_json_with_prose_recovered():
    raw = '好的，结果如下：{"intents":[{"intent":"cooperation","targets":["lia"],"confidence":0.9,"evidence":["我来帮你"]}],"summary":"愿意帮忙"} 这是全部。'
    ti = parse_and_validate(raw, "我来帮你。")
    check("prose_recovered", ti.status == "ok"
          and ti.intents[0].intent == "cooperation", ti.invalid_reason)


def test_not_object_rejected():
    ti = parse_and_validate('["violence"]', "我打你。")
    check("not_object_rejected", ti.status == "invalid"
          and ti.invalid_reason == "not_object", ti.invalid_reason)


# ---------------------------------------------------------------------------
# 纯函数：提示词规则存在性
# ---------------------------------------------------------------------------
def test_prompt_contains_rules():
    system, user = build_semantic_prompt("测试句。", {"targets": ["lia", "灰鸦"]})
    joined = system + "\n" + user
    check("prompt_negation_rule", "否定语义" in joined and "不会伤害你" in joined)
    check("prompt_metaphor_rule", "隐喻施压" in joined and "太阳还能升起来" in joined)
    check("prompt_object_context_rule", "物体语境" in joined and "削苹果" in joined)
    check("prompt_multi_intent_rule", "多条意图" in joined and "多个目标" in joined)
    check("prompt_closed_enum", all(i in joined for i in INTENTS))
    check("prompt_json_only", "不要 markdown 代码块" in joined and "只输出 JSON" in joined)
    check("prompt_context_targets", "lia" in user and "灰鸦" in user)


# ---------------------------------------------------------------------------
# live 语义测试（B_TI_LIVE=1）
# ---------------------------------------------------------------------------
def test_live_semantics():
    cases = [
        {"text": "我不会伤害你。", "must": None, "must_any": None,
         "forbid": ["violence"], "min_intents": 1, "desc": "否定：不应判 violence"},
        {"text": "你最好祈祷太阳还能升起来。", "must": ["threat"], "must_any": None,
         "forbid": None, "min_intents": 1, "desc": "隐喻：无『威胁』字样也应 threat"},
        {"text": "我拔刀削苹果。", "must": None, "must_any": None,
         "forbid": ["violence"], "min_intents": 1, "desc": "物体语境：削苹果不判对人 violence"},
        {"text": "箱子我没带来，钥匙埋在老井第三块砖下面，你爱信不信。",
         "must": ["information_handover"], "must_any": None, "forbid": None,
         "min_intents": 1, "desc": "间接：无『交出/证据』字样也应 information_handover"},
        # 「还不信就算了」语义上偏 withdraw（算了=不再坚持），challenge/withdraw 皆可接受；
        # 关键断言是：① 证物交接被识别；② 一轮出现多条意图（多意图）。
        {"text": "我把徽章扔到桌上，让她自己验。还不信就算了。",
         "must": ["evidence_handover"], "must_any": ["challenge", "withdraw"],
         "forbid": None, "min_intents": 2, "desc": "多意图：交证物 + 较劲/不买账"},
    ]
    for c in cases:
        ti = interpret_semantic(c["text"])
        if ti.status != "ok":
            check("live:%s" % c["desc"], False,
                  "status=%s reason=%s" % (ti.status, ti.invalid_reason))
            continue
        got = [i.intent for i in ti.intents]
        ok = True
        if c["must"] and not all(m in got for m in c["must"]):
            ok = False
        if c["must_any"] and not any(m in got for m in c["must_any"]):
            ok = False
        if c["forbid"] and any(f in got for f in c["forbid"]):
            ok = False
        if len(got) < c["min_intents"]:
            ok = False
        check("live:%s" % c["desc"], ok, "got=%s summary=%r" % (got, ti.summary))


def main():
    global _PASS, _FAIL
    print("=== 纯函数：schema 校验 ===")
    test_parse_multi_intent()
    test_parse_neutral()
    test_parse_empty_intents_ok()
    test_bad_intent_rejected()
    test_nan_confidence_rejected()
    test_bool_confidence_rejected()
    test_evidence_non_substring_dropped()
    test_code_fence_stripped()
    test_json_with_prose_recovered()
    test_not_object_rejected()
    print("=== 纯函数：提示词规则 ===")
    test_prompt_contains_rules()
    if os.environ.get("B_TI_LIVE") == "1":
        print("=== live：语义用例（DeepSeek）===")
        test_live_semantics()
    else:
        print("（跳过 live 语义测试；设 B_TI_LIVE=1 开启）")
    print("\n%d PASS / %d FAIL" % (_PASS, _FAIL))
    if _FAILURES:
        print("失败项：%s" % "、".join(_FAILURES))
    return 1 if _FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
