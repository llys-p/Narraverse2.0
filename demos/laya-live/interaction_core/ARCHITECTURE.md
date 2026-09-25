# Interaction Core · ARCHITECTURE（候选 C：RPG / Action Resolution 派）

> baseline `357d78b` (laya-p2-safe) · branch `candidate-c-interaction-core` · worktree `D:\Narraverse2.0-c`

## 1. 完整数据流（Turn Tick）

```
玩家自由输入
   │
   ▼
Turn Interpreter（interaction_core/interpreter.py）
   LLM 语义归一化（DeepSeek，严格 JSON 契约 + 白名单校验）
   ├─ 主通道：llm —— 多意图/否定/隐喻/多目标，天然不依赖关键词
   ├─ 降级1：laya_only —— LLM 不可用时用 Laya 结构化信号映射粗粒度事件
   └─ 降级2：neutral_fallback —— 信号也不显著 → 不裁决（fail-closed）
   │  TurnInterpretation（intents[] + tone + source + notes）
   ▼
Facts / Hard Rules（interaction_core/facts.py）
   FactBase（per session/actor：inventory / world_facts / statuses / claims）
   语义级前提验证：持有？被束缚？已缴械？
   → FactCheckResult[]（ok / insufficient / false_claim / denied）
   ▼
Laya Evidence（复用 laya_bridge.decide = analyze_core）
   9 信号读数（prob 0~1）+ 引擎身份 + 原始 delta（仅审计对照）
   → LayaEvidence（Proposal / Evidence，不是世界真相）
   ▼
Action Resolver（interaction_core/resolver.py）★ 候选 C 核心
   potency = base(意图) + 置信 + 环境/资源 …（贡献逐项记录）
   difficulty = base(意图) + 目标怀疑/信任/警觉 + false_claim 惩罚 + 显式难度
   margin = potency − difficulty → Degree 6 档
   （critical_failure / failure / partial_success / success / strong / exceptional）
   → ActionResolution[]（含 contributions 审计分解）
   ▼
Canonical Outcome（interaction_core/outcome.py）
   唯一权威事实：result / degree / facts_created / state_changes
                / costs / complications / opportunities（Fail Forward）
   + NarrationContract（Story Agent 的边界）
   ▼
Validate / Commit（复用协议层 propose_turn → commit_turn）
   版本冻结（capture_legacy_scope）· 事务 · engine 门禁 · 幂等
   · session/actor 隔离 · capability 过滤 —— 全部继承，零平行状态系统
   resolver 的 state_changes 替换 Laya 原生 doubt 条目（resolver 权威）
   审计经既有 rule_adjudicated / adjudication_source / ti_basis 通道透传
   ▼
Actor State（既有 _ACTOR_STATE 桶，一字未改）
   ▼
Story Agent（interaction_core/narration.py）
   由 NarrationContract 驱动的 LLM 生成；must_not_include 输出过滤
   违约降温重试一次 → 仍违约如实带 violation 返回，绝不静默放行
```

Scene Tick / World Tick：schemas 已预留 `tick` 字段与 `NarrativePressure`；
本轮只实现 Turn Tick，数据对象不阻塞未来扩展。

## 2. 每层职责与写权限（谁不能写什么）

| 层 | 职责 | 写 Actor State？ |
|---|---|---|
| Interpreter | 归一化语义：这轮玩家想做什么 | **否** |
| Facts | 前提验证：这个世界里能不能做 | **否**（只写自己的 FactBase） |
| Laya | NPC 即时倾向：Proposal / Evidence | **否**（从来不能） |
| Resolver | 裁决做到什么程度（分级） | **否**（纯函数） |
| Outcome | 唯一权威事实 + 状态变化提案 | 构造 StateChange，不落盘 |
| Validate/Commit | 唯一写入入口（协议层） | **是**（唯一） |
| Story Agent | 在 Contract 内措辞 | **否**；不得改写结果 |

Director（未来）：输出 NarrativePressure（低频结构），**不能覆盖已 Resolve 的
Outcome**；接口已预留，本轮不接入。

## 3. 核心 schema（冻结对象，schemas.py）

`TurnInput / Intent / TurnInterpretation / FactCheckResult / LayaEvidence /
ResolutionContext / ActionResolution / StateChange / CanonicalOutcome /
NarrationContract / CommitOutcome / TurnResult`，预留 `NarrativePressure /
RelevantMemory`。全部 `to_dict()` 可序列化；层间只传这些类型，不传无边界的 dict。

## 4. 关键设计决策（候选 C 立场）

1. **Resolver 是数值对抗模型而非骰子**：potency vs difficulty 的确定性差值
   → 分级。同输入同输出（纯函数、无隐藏状态）；未来要随机必须以可注入
   seed 显式加入。贡献逐项记录（contributions），每个档位都能回答"为什么"。
2. **Laya 是修正项不是裁判**：信号只进 laya_alignment（±1.5 上限）与
   target 警觉项；degree 永远由规则模型决定 —— 防止"模型情绪"直接改写世界。
3. **false_claim 是特性不是错误**：声称交出没有的物品 → 难度 +5 →
   自然落入失败系（怀疑上升 + "要求验货" complication）。说谎被抓包是
   涌现行为，不是特判分支。
4. **失败 ≠ 什么都没发生**：Fail Forward 表（意图 × 档位带）产出
   Cost / Complication / Opportunity；数值只做方向与量级，复杂后果走语义通道。
5. **玩家与 NPC 共享行动模型**：npc_counter_intent 从 Outcome 生成 NPC
   反制意图，走同一 resolve()；行为映射回既有 behaviors（probe/distance/
   confide），NPC 不再只是被动回复。
6. **协议层零改动复用**：提交走 propose_turn/commit_turn（版本/事务/引擎
   门禁/隔离全继承）；resolver 审计借道既有 rule_adjudicated 透传白名单，
   不扩协议 schema。唯一桥改动：新增 /core/turn 路由 + /reset 联动清 FactBase。
7. **Interpreter 的 LLM 契约 fail-closed**：严格 JSON + 类别白名单（幻觉
   类别丢弃）+ 重试一次 + 降级链（llm → laya_only → neutral_fallback），
   绝不落关键词。旧关键词表（laya_bridge）保留在 legacy 路径，本模块不引用。

## 5. 放弃的备选方案

- **掷骰 Resolver（d20 式）**：直观但引入不可复现性；且本阶段没有任何
  理由需要随机（无隐藏信息博弈）。留 seed 接口，默认确定性。
- **Resolver 直接产生 trust/alert 多信号 delta**：当前 capability 只放行
  doubt_shift（A 级）；硬塞其他信号只会被 validate 拦下。改为：只有
  doubt 走数值，其余影响走 costs/complications 语义通道 —— 语义更诚实。
- **Interpreter 走 Laya 信号为主 + LLM 为辅**：Laya 信号对隐喻/否定/多意图
  无分辨力（实测：威胁句 disclose 也能 ≥0.5）。LLM 归一化为主、Laya 做
  降级与旁证是唯一能同时满足"自由表达"与"fail-closed"的组合。
- **改协议层加 resolver 字段**：会破坏 P2 契约与既有 300 项测试；
   借道 rule_adjudicated/adjudication_source/ti_basis 已透传通道，零协议改动。

## 6. Laya / Rules / Director / Story 的位置

- **Laya**：analyze_core 一次性调用，产出 Evidence（signals + raw delta）；
  其 behavior policy 作为 NPC 行为的**回落**来源。
- **Rules**：Facts 层的 verdict（ok/insufficient/false_claim/denied）以数值
  惩罚进入 Resolver（+5/+2/+10），硬规则永远能压制模型乐观。
- **Director（未来）**：NarrativePressure 已预留；只能影响 difficulty 修正
  与机会注入，不能改 Outcome。
- **Story Agent**：输入是 Outcome + Contract；输出过滤 + 违约重试；
  测试断言 failure 档台词含"完全相信"必被抓。

## 7. Demo Trace（真实模型，2026-09-26）

输入（任务书指定）：`箱子我没带来，不过钥匙埋在旧井第三块砖下面。你如果还觉得我是骗子，就自己去看。`

| 层 | 结果 |
|---|---|
| Interpretation | **多意图**：information_handover(conf .95, objects 钥匙/旧井/砖, quote"钥匙埋在旧井第三块砖下面") + challenge(conf .85, quote"就自己去看")；无任何关键词命中 |
| Facts | ok / ok（信息交代无实物前提；claims 登记） |
| Laya Evidence | disclose .55 / hostility .46 / …（engine=laya） |
| Resolver | information_handover：potency 4.4 vs difficulty 1.5（doubt +1.5, trust −2.4, laya .13）→ margin 2.93 → **success**；challenge → success |
| Outcome | result「玩家交代信息——奏效」；state_changes: doubt_shift **−2.2**（resolved_by=resolver:information_handover）；opportunity「具体、可验证的细节让莉亚愿意沿着这条线索查下去」 |
| Commit | 协议层真实提交（版本 v1:…:0:1，rule_adjudicated=resolver:information_handover 透传） |
| Narration | 「…她侧身让出半步路…**我今夜自己去**。要是砖下真有东西——你最好还站在我能找到你的地方。」——恰好演出 opportunity（去核实），0 contract violations |

完整 JSON：`_diag/core_trace_demo.json`（含每层耗时与全部中间数据）。
