"""Outcome-first presentation: authored facts plus optional bounded cloud delivery choices.

Unrestricted generated prose cannot be proven fact-preserving by a JSON schema. Candidate A
therefore renders canonical statements itself. A cloud stylist may choose pace only.
"""
from dataclasses import dataclass
from .contracts import CoreError


@dataclass(frozen=True)
class NarrationContract:
    commit_id: str
    outcome: dict
    state_versions: dict
    may_change: tuple[str, ...] = ("pace",)
    must_preserve: tuple[str, ...] = ("degree", "facts_created", "state_changes", "costs", "complications")


class StoryAgent:
    def __init__(self, style_model=None):
        self.style_model = style_model

    def narrate(self, receipt):
        contract = NarrationContract(receipt["commit_id"], receipt["outcome"], receipt["versions"])
        pace = "measured"
        if self.style_model:
            style = self.style_model(
                'Choose delivery pace only. JSON {"pace":"concise|measured|tense"}. Do not write facts or prose.',
                {"outcome": contract.outcome})
            if not isinstance(style, dict) or style.get("pace") not in {"concise", "measured", "tense"}:
                raise CoreError("STORY_FORMAT", "叙事风格输出无效；提交结果仍然有效", 502)
            pace = style["pace"]
        states = receipt["states"]
        names = {k: v.get("name", k) for k, v in states.items()}
        labels = {"critical_failure": "严重失利", "failure": "未达成", "partial_success": "部分达成",
                  "success": "达成", "strong_success": "出色完成", "exceptional_success": "卓越完成"}
        lines = []
        for r in contract.outcome["resolutions"]:
            who = names.get(r["target_id"], r["target_id"] or "未明确目标")
            lines.append("%s · %s：%s。" % (who, labels[r["degree"]], r["achieved"].rstrip("。")))
            for fact in r["facts"]:
                if fact["kind"] == "communicated_claim":
                    lines.append('你向%s表达：“%s”（这是说出的内容，尚未核实。）' % (who, fact["content"]))
        lines.extend(contract.outcome["costs"])
        lines.extend(contract.outcome["complications"])
        lines.extend(contract.outcome["opportunities"])
        joiner = "\n" if pace == "concise" else "\n\n"
        return {"commit_id": contract.commit_id, "source": "canonical_renderer",
                "pace": pace, "text": joiner.join(lines), "contract": contract.__dict__}
