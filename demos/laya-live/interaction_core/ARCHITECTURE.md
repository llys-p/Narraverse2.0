# Interaction Core · Candidate A

基线：`laya-p2-safe @ 357d78b74fccbba6ae14307ed204ae55e6b6c300`。
独立分支：`codex/interaction-core-a`。
工作树：`D:\Narraverse2.0-interaction-a`。

## 1. 设计决定

这一层负责**运行中交互的结算**。Laya 是其中的证据提供者；云端 Interpreter
理解玩家在尝试什么；Rules/Resolver 决定在当前规则与事实下做到了什么。
同一份结构化输入、证据和状态得到同一份结算。云端语义输出本身不承诺逐次确定。

```text
TurnInput + server SceneSnapshot + recent conversation
  → SemanticInterpreter → TurnInterpretation / ActionIntent[]
  → Fact Checks (possession, target, location, energy, restraint)
  → BridgeEvidence (per recipient, actual Laya + capability profile)
  → sequential ActionResolver (pure local simulation)
  → CanonicalOutcome + StateProposal [preview, no game-state writes]
  → Validate / Commit (same lock + all read versions + re-resolution)
  → existing _ACTOR_STATE / _STATE_TRACE / protocol versions / event receipt
  → StoryAgent (read committed receipt only)
```

预检查决定哪些 NPC 真正涉及本轮。Resolver 再按动作顺序检查前提：例如第一步交出
徽章后，第二步不能把同一枚徽章再交给另一人。`depends_on` 可表达“前一步成功才做”。
单个动作可有多个目标；每个目标有独立结算，消耗也逐目标发生。混合成败的总览标为
partial_success，**具体结果始终以 resolutions 为准**。

## 2. 模块和数据对象

| 文件 | 职责 | 主要契约 |
|---|---|---|
| contracts.py | 显式数据结构和可替换接口 | TurnInput, ActionIntent, TurnInterpretation, FactCheckResult, ResolutionContext, LayaEvidence, ActionResolution, CanonicalOutcome, StateProposal, CommitResult |
| interpreter.py | 一次云端 JSON 语义理解；不计算数值 | Interpreter / SemanticInterpreter / JsonModel |
| rules.py | 前提检查、确定性公式、纯函数结算 | check_facts / resolve_turn |
| bridge_adapter.py | 复用现有推理、档案、State Transition 和状态存储 | BridgeStore / BridgeEvidence / NoEvidence |
| service.py | prepare / commit / receipt / narrate 编排 | InteractionCore / PendingTurn |
| narration.py | 从已提交结果表达事实 | NarrationContract / StoryAgent |
| scene.py | 服务端小型酒馆场景、初始数据 | make_scene |
| ../interaction_server.py | 独立端口 HTTP 入口，沿用旧 Handler | make_handler |
| demo.html | 输入、预览、确认、已提交状态、完整 trace | 同源 HTTP 消费者 |

dataclass 边界用于各层输入输出；dict 仅承载现有 Actor State、模型 JSON、证据载荷、
物体表及 HTTP 序列化，不把一个无边界 dict 从头传到底。

## 3. 自由语义与显式规则的分工

Interpreter 输出语义类别与动作操作，两者分别描述“是什么意思”和“尝试做什么”。
例如 threat + communicate 是传达威胁；violence + attack 才触发攻击规则。攻击物体
与攻击人物的 target 不同。mode 区分 attempt / negated / hypothetical / quoted。
否定和引用不执行物理动作；可以同时保留表达这句话的 communicate。

来源证据必须是当前消息的原文片段。实体引用必须对应场景 ID，歧义返回
NEEDS_CLARIFICATION，不凭空补物品。默认对话对象由场景的 default_addressee 指定，
有明确称呼则按原文解析。多意图全部保留，最多 12 个，不用正则或关键词推断类别。

声明位置只生成 communicated_claim，truth=unverified。即使与服务端事实巧合一致，
“玩家这样说过”也不自动成为“玩家已取到钥匙”。inspect 成功只能揭示服务端已登记
的 verified_clue；不存在的额外线索不由模型临时补写。

模型只给语义与引用，不能设置 difficulty、delta、胜率或新事实。结构异常停止本轮，
不回落到原来 regex 调数值的入口。现有 legacy 路由保持原语义。

## 4. 结算模型

已实现 8 个操作：communicate / persuade / transfer / unlock / force / attack / inspect / assist。
其中 communicate、合法 transfer、匹配钥匙 unlock 满足前提即成功。
其余使用有版本的确定性公式：

```text
margin = skill + owned_equipment + one_use_support + environment
       + relationship + active_laya_tendency + verified_evidence
       - difficulty - opposition
```

| margin | degree |
|---|---|
| < -6 | critical_failure |
| [-6, -2) | failure |
| [-2, 1) | partial_success |
| [1, 4) | success |
| [4, 7) | strong_success |
| ≥ 7 | exceptional_success |

阈值是候选 A 的**演示平衡规则**，没有经过数据校准，不是 Laya 输出的概率。
relationship/tendency 只影响 persuade；已核实且明确引用的线索可提供有限证据加成。
身体行动不会被“关系很好”绕过钥匙、位置或精力前提。暂无随机数。

功能例子：force 部分成功会降低下次破门难度但门仍关闭；失败耗精力并增加噪声，
给出寻找钥匙/求助的机会。attack 按程度扣血，健康归零才失能。assist 提供下一次
技能行动的一次性加成。persuade 成功只改变即时 openness，不自动结盟/泄密/转移物品。

Fail Forward 中的 complications/costs 若实际改变状态，必须伴随 StateChange。
opportunities 是可选后续尝试，不等同于已生成新钥匙、通道或 NPC 承诺。

## 5. Laya 复用和能力边界

复用 `_cached_translate`、`analyze_core`、`build_state_proposal`、能力档案、
`validate_state_delta` / `state_transition`，不复制引擎或重建 profile。
新增可选内部参数 `legacy_adjudication=False` 跳过旧 apply_rule_adjudication。
所有旧调用保持默认 True。

每个涉及的 NPC 一次分析，仅传属于该目标的原文片段。结构化上下文仅传简短英文枚举，
避免把中文解释和巨大对象塞进英文检查点。玩家整句、语义结果仍完整保留在 trace。
翻译继续遵守原来的冻结缓存纪律；无真实推理结果则拒绝候选。

能力 active 的 state_shift 才能经过原 State Transition 进入角色变化；auxiliary
仅保留为 evidence。Resolver 只把 active cooperation/hostility 用作有界修正。
这不会把 C 级 trust_shift 或 fondness_shift 放入写入路径。

`--rules-only` 显式移除 Laya Evidence，语义 Interpreter 仍是云端模型。它不是
“假 Laya 成功”；回执 evidence=[]，没有任何 Laya 属性变化。

## 6. 状态权威与多角色提交

实体状态继续存储在 `_ACTOR_STATE[(session_id, entity_id)]`。角色上增加 `interaction`
运行字段；保留的 `ic_world` 实体桶容纳本会话物体、已记录事实、对话和时钟。
**这是 Demo runtime scene，不是 Narraverse World 定义的新持久化真源。**
正式接入时应将 BridgeStore 替换为现有 Runtime 存储适配器；不回写 World 配置资产。

prepare 读取所有小场景实体及其版本，模型调用期间不持锁。完成时再对照版本。
服务端 Pending 保存候选 600 秒、容量 200，不保存另一份可写状态真源。
commit 接受 analysis_id + 原版本映射；不接收客户端 delta 或 outcome。
commit 锁内重跑纯结算和 capability/State Transition，再比较预览，最后一次发布。

既有协议新增内部 `commit_interaction_bundle`：复用同一 RLock、版本 epoch/gen/rev、
Actor State、trace 和 events；涵盖所有读取版本、一次发布多个写入桶，异常回退。
这一步是必要最小扩展：原 commit_state 只能提交单个 NPC 的 state_shift，无法原子
表达“交出物品、另一人取得、精力消耗、世界时钟前进”。连续调用多次旧 commit 会部分成功。

所有实际写入桶推进版本，旧路由修改任一读过的角色也会让新候选失效。Reset 的世代
变化同样生效。准确重复提交取原回执；读取回执和叙事不重新结算。运行状态仍仅在进程内，
没有新增持久化或宣称多进程事务。会话 reset 负责释放事件回执。

## 7. Story Agent 的确定性取舍

本候选不把“请勿篡改结果”的提示词当成事实校验器。默认 StoryAgent 将权威 resolution
渲染成中文结果、成本、后果和机会，原话只作为未核实的角色声明引用。
可注入 cloud style_model 选择枚举 pace；模型不返回可替换的结果句子。

因此本版提供可靠结果表达与 NarrationContract，**没有实现开放文学式云端叙事**。
这是 A 的明确取舍：后续若恢复自由写作，需引入叙事事实校验/事实槽位，不能把未经
验证的文字当成已发生的事实。Story 只读 receipt；未 commit 无叙事入口。
叙事网络失败不回滚既有提交，重试 /narrate 即可。

## 8. 历史、人物与未来接口

同会话最近 12 条 user/assistant 消息供 Interpreter 消歧；叙事使用已提交 outcome。
原始会话与旧 NPC 行为历史分开，没有为了兼容而伪造 NPC 决策。

Turn Tick 已随提交递增；Scene/World Tick 预留独立计数，目前不自动推进。
NarrativePressure(kind,target_id,description,tick) 和 RelevantMemory(source,content,authority)
提供未来接口。Director 无提交入口；以后可在 Scene Tick 提供候选压力，仍需规则校验。
玩家/NPC 都能作为 TurnInput.actor_id 使用同一 Resolver；NPC 目标规划本轮未实现。
快速 openness、资源、伤势与中期 relationship 分组；不修改 traits/personality。

## 9. 放弃的备选方案与限制

- 没有复制全部旧协议，也没有建立新的 Actor/World 数据库。
- 没有把玩家自由原文交给 regex 直接决定数值。
- 没有逐层都调用大模型；每轮一次 Interpreter，加每个涉及 NPC 的 Laya/必要翻译。
- 没有让生成式模型计算成功档位或拥有 commit 权限。
- 暂不按 NPC 分别存对不同人的关系：现有 relationship 仍是角色对玩家关系。
  NPC 自主行为可以走身体/物体规则；NPC 对 NPC 的社交结算需要关系目标明确化后扩展。
- 现有模板没有完整距离、负重、技能树；Hard Rules 当前实现位置一致、资源、所有权、
  束缚/失能和钥匙匹配。未来字段通过 interaction 扩展，公式需另行版本化。
- 语义归一是否正确、Laya 新上下文下效果、平衡公式和实际并发均待统一验收；本轮不跑测试。

启动、接口与未验证项见 HANDOFF.md；完整人工推演见 TRACE_EXAMPLE.md。
