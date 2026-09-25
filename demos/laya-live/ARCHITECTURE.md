# Interaction Core · Candidate B

基线 `laya-p2-safe @ 357d78b74fccbba6ae14307ed204ae55e6b6c300`；分支
`laya-b-freeform`；工作树 `D:\Narraverse2.0-wt-b`。

## 主链路

```text
玩家自由输入 + 本会话最近已提交的对话 + 当前实体表
  → DeepSeek Turn Interpreter（多意图、多目标、语气、原文依据、动作操作）
  → WorldState / HardRule（物品、门、在场目标、行动条件）
  → 现有 Laya analyze_core（仅输出证据和能力档案允许的状态提案）
  → ActionResolver（6 档，公开因素与权重）
  → CanonicalOutcome（每个意图/目标的结果、事实、成本、机会）
  → 服务端确认并重验 → 同一协议锁内提交 Actor State / 世界运行桶
  → 只读取已提交结果的 Narration
```

本候选的重点是玩家可以自由表达，不必命中预设词组。Interpreter 只归一语义，
不会决定行动成功、改动数值或写故事；旧关键词分类入口只供旧路由使用。
模型返回枚举意图和枚举操作，带原文子串；schema 异常明确失败。
`information_handover + speak` 只会记录“说过这句话”，不会创造钥匙或核实其位置。
`evidence_handover + give` 才会在有物品且结算成功时转移物品所有权。

## 边界与数据结构

- `laya_turn_interpreter.py`：ActionIntent、TurnInterpretation。一个回合可有多条意图；
  targets 可有多个。operation 限于 speak/persuade/give/attack/unlock/inspect/move/take/use。
- `laya_facts.py`：WorldFact、WorldState、HardRule、FactCheckResult/Report。
  物品所有权、目标存在、钥匙匹配、门状态、行动者限制由服务端事实检查。
- `laya_resolver.py`：ResolutionContext、LayaEvidence、ActionResolution。结果档位依次是
  critical_failure/failure/partial_success/success/strong_success/exceptional_success。
  默认纯确定性；服务层本轮不启用随机数。
- `laya_interaction_b.py`：组合层、服务端候选、提交入口和同源 HTTP 服务。每层对象
  在明确位置转成 JSON；客户端只能回传 analysis_id、event_id 和原版本映射。

服务器的 runtime 世界事实放在现有 `_ACTOR_STATE[(session_id, b_runtime_world)]`；
角色状态继续使用相同 Actor State 存储。`b_runtime_world` 是会话**运行数据**，不等于
Narraverse 世界设定资产。未来接入正式 Runtime 存储时替换存储适配，不回写 World 定义。
服务端复用 `LayaStateProtocol` 的 RLock、epoch/generation/revision 版本和事件记录；
提交读取所有版本，锁内重新结算，核对旧预览后一次发布，异常回退。
分析和叙事均不修改已提交 Actor State；提交是本候选唯一写入口。

Laya 使用已有模型、能力档案、`build_state_proposal` 与 `validate_state_delta`。
新增 `legacy_adjudication=False` 内部参数，B 链路绕开原关键词修正；旧路由默认行为保留。
只有 profile/transition 验证通过的 active state_shift 能写角色属性；原始信号是
证据而非权威。Resolver 对 Laya 倾向给予公开的有限权重。

`_world()` 是服务器初始小场景：莉亚、奥伦、玩家、徽章、地窖门、未持有的钥匙。
移动到旧井 → 拾取钥匙 → 返回酒馆 → 开门，形成可逐轮推进的物品/位置闭环。
行动结果影响下一轮事实。近期对话注入 Interpreter 供代词消歧，不把历史当指令。
玩家和 NPC 都能作为行动者使用 Resolver；对 NPC×NPC 的长期关系仍待将单一的
“对玩家关系”扩展为明确的双方关系。

## Outcome、Story 与 Director

CanonicalOutcome 的 `resolutions` 保留每个意图/目标的事实检查、分级结果和解释；
`state_changes`、`facts_created`、`costs`、`complications`、`opportunities` 分开。
失败可带警觉或重试机会，机会不代表已生成资源。
当前 Narration 由回执确定性渲染中文结果，不接受客户端编造的结果。
开放文学式 Story Agent、Scene Tick、World Tick 和低频 Cloud Director 尚未正式接入。
未来 Director 可提出 pressure/agenda/opportunity/hold，不可直接覆盖已提交结果。

受限点：初始规则只覆盖当前酒馆与旧井几个实体及 9 类操作；没有完整装备、负重、
角色成长或世界模拟。多角色状态共用一个进程的内存，重启不持久。所有公式、语义效果、
并发和页面仍待统一验收；本轮按用户要求没有运行测试或模型。

完整接口与启动见 HANDOFF.md，人工流程例子见 TRACE_EXAMPLE.md。
