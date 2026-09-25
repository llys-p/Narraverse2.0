# Interaction Core · HANDOFF（候选 C）

> baseline `357d78b74fccbba6ae14307ed204ae55e6b6c300`（laya-p2-safe，干净）
> branch `candidate-c-interaction-core` · worktree `D:\Narraverse2.0-c` · 未 push

## 做了什么

Interaction Core 完整 Turn Tick 链路（候选 C 侧重 Action Resolution）：
Interpret（LLM 归一化，fail-closed 降级链）→ Facts（FactBase 前提验证）→
Laya Evidence（复用 analyze_core）→ **Action Resolver（6 档对抗结算 +
贡献分解 + Fail Forward + NPC 共享模型）** → Canonical Outcome（含
Narration Contract）→ 既有协议层 propose/commit（零改动复用）→ Story Agent
（Contract 约束 + 违约过滤）。新增桥路由 `POST /core/turn`。

## 没做什么（按任务书 §19 范围控制）

- 未实现完整 RPG Rules Engine（力量/负重/技能/装备只留 FactBase 接口）
- 未接 Cloud Director（NarrativePressure 仅 schema 预留）
- 未做 Scene/World Tick（`tick` 字段预留）
- 未做长期人格成长、Memory 系统、UI
- 未动既有 /analyze /commit_state /decide /turn 语义与全部既有测试

## 新增文件

```
demos/laya-live/interaction_core/
  __init__.py        导出与包说明
  schemas.py         冻结数据对象（15 个，含 2 个预留）
  interpreter.py     LLM 归一化 + Laya-only 降级 + neutral_fallback（fail-closed）
  facts.py           FactBase（inventory/world_facts/statuses/claims）+ FactChecker
  resolver.py        对抗结算（potency vs difficulty → 6 档）+ 贡献分解
                     + fail_forward 表 + npc_counter_intent（共享模型）
  outcome.py         Canonical Outcome + degree→delta 映射 + Narration Contract
  narration.py       Story Agent（Contract 驱动 + must_not 输出过滤 + 违约重试）
  pipeline.py        Turn Tick 编排 + merge（resolver 权威）+ 全链 trace
  ARCHITECTURE.md    架构文档
  HANDOFF.md         本文
tests/interaction_core_unit.py   40 项新测试
_diag/core_trace_demo.json       真实模型 Demo Trace（gitignore，本地证据）
```

## 修改文件（仅两处，均为附加）

- `laya_bridge.py`：新增 `/core/turn` 路由（+15 行）；`/reset` 联动清 FactBase（+7 行）
- 其余协议层/状态层/前端：**零改动**

## 测试结果

| 套件 | 结果 |
|---|---|
| interaction_core_unit（新） | **40/40 PASS** |
| p1_asset_unit | 35/35（既有，无回归） |
| p2b1_unit | 88/88 |
| p2b2_unit | 35/35 |
| p2c_unit | 71/71 |
| p3a_unit | 17/17 |
| p3p2_unit | 54/54 |
| **合计** | **340/340 PASS** |

真实模型验证：任务书指定的 Demo Trace 输入全链路通过（多意图识别
information_handover+challenge、success 档、doubt −2.2、协议层真实提交、
narration 0 违约且语义呼应 opportunity）。测试中 LLM 全部 mock，未烧 API
做单测；黑盒隐藏表达验证留给候选 D。

## 已知问题与风险（最危险的三个）

1. **Interpreter 主通道依赖 DeepSeek 可用性**：LLM 断供时降级到
   laya_only（粗粒度、无 objects），false_claim 检测会失效（物件对账
   依赖 LLM 给出 objects）。缓解：fail-closed 不产生错误裁决；但体验
   降级明显。**风险最高的一环。**
2. **Resolver 数值定标是启发式**（base/阈值/惩罚常量）：40 项测试覆盖
   方向与档位分布，但没有经过批量真实语料校准 —— degree 边界
   （如 partial↔success 的 0.8/3.0）可能需要按实测调。
3. **npc_counter_intent 只覆盖最典型反制**（验货/敌意/善意三族）：
   复杂 Outcome（多意图冲突、violence 混合）下 NPC 反制可能缺失，
   回落到 Laya policy 行为 —— 行为仍合法，但"NPC 主动博弈"的戏会变少。

## 其他已知限制

- FactBase 是进程内存（重启即失），与 Actor State 同生命周期语义；
  持久化属未来物品系统范畴。
- LLM interpret 延迟 ~1.4s/轮（DeepSeek），叠加 Laya ~4s，Turn Tick 总延迟
  ~8s（含 narration）。
- narration 的 must_not 是短语级输出过滤，模型换个说法（"信了大半"）可能
  溜过 —— 输出过滤是最后防线而非语义保证，根本保证在 prompt + contract。

## 下一阶段建议（如果只能做一件事）

**把 Interpreter 的 LLM 契约与 Resolver 定标放进同一套隐藏表达黑盒验证**
（候选 D 的 adversarial cases 正是输入源）：用未见过的表达批量跑
/core/turn，统计（意图识别准确率 × 档位分布 × 语义违约率），据数据校准
两组常量。这是全链路里唯二"凭手感定的数值"，其余环节都有测试钉死。
