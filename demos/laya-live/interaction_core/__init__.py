"""Interaction Core（候选 C：RPG / Action Resolution 派）。

Narraverse 自由交互核心：玩家自由输入 → Turn Interpretation → Facts / Hard Rules
→ Laya Evidence → Action Resolver → Canonical Outcome → Validate / Commit
→ Actor State → Story Agent。

职责边界（任务书 §3/§7/§10/§11）：
  · Interpreter 只归一化语义，不写状态、不裁决成败；
  · Laya 是 Proposal / Evidence，不是世界真相；
  · Resolver 裁决「做到什么程度」（分级），但不直接写状态；
  · Canonical Outcome 是本轮唯一权威事实，经既有 Validate/Commit 入口写入；
  · Story Agent 只在 Narration Contract 内措辞，不得改写结果。

本包不复制状态系统：提交复用 laya_bridge 的 propose_turn / commit_turn
（协议层版本、事务、engine 门禁、session/actor 隔离全部继承）。
"""
from .schemas import (          # noqa: F401
    Degree,
    TurnInput,
    Intent,
    TurnInterpretation,
    FactCheckResult,
    LayaEvidence,
    ResolutionContext,
    ActionResolution,
    CanonicalOutcome,
    StateChange,
    NarrationContract,
    CommitOutcome,
    TurnResult,
    NarrativePressure,
    RelevantMemory,
)
from . import interpreter, facts, resolver, outcome, narration, pipeline   # noqa: F401

__all__ = [
    "Degree", "TurnInput", "Intent", "TurnInterpretation", "FactCheckResult",
    "LayaEvidence", "ResolutionContext", "ActionResolution", "CanonicalOutcome",
    "StateChange", "NarrationContract", "CommitOutcome", "TurnResult",
    "NarrativePressure", "RelevantMemory",
    "interpreter", "facts", "resolver", "outcome", "narration", "pipeline",
]
