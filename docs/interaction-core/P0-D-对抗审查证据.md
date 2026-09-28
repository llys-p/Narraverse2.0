# D · P0 只读审查交付（对抗证据核对 + 契约复核）

> 归档说明（A）：以下为 TRAE 中 D 的原始只读审查交付副本。A 已抽查会改变 P0 契约的关键源码位置；全表不是运行时攻击复现记录。正式复现与修复验收归 P5。共享区工作稿位于 `D:\Narraverse2.0-ai-shared\updates\D-2026-09-28-P0审查.md`。

角色：TRAE / D（对抗性架构审查者）
日期：2026-09-28
工作目录：只读。审查对象 A/B/C 三个 worktree 与共享区契约，**未修改任何候选代码、融合工作树或主工作树 D:\Narraverse2.0**。
模型与扣费：本会话实际运行型号为平台显示名 DeepSeek-V4-Pro。全程纯静态只读审查，未调用 DeepSeek 付费 API、未跑模型推理、未启动服务。本工具无法查询账户余额，前后余额与扣费数字请以平台账单为准；此格不编造数字。
核对结论：三个候选 worktree 的 HEAD 与任务卡一致且工作树干净 —— A `bdca76a`、B `a55ef9a`、C `b3a18f4`；B 的 `4e61eca → a55ef9a` 仅追加 HANDOFF.md 19 行复核记录，**无代码变化**，因此对 B 的原审查结论直接适用于 a55ef9a。

---

## 1. 原 D 攻击逐项清单（编号 · 受审 SHA · 输入/场景 · 预期 · 实际 · 证据 · 已修？）

### 候选 A（branch `codex/interaction-core-a` @ `bdca76a`，HEAD 未变）

| 编号 | 输入/场景 | 预期 | 实际 | 证据位置（相对 `demos/laya-live/interaction_core/`） | 已修？ |
|---|---|---|---|---|---|
| A1 玩法断链：钥匙永久不可得 | 场景地窖门锁着、`cellar_key` 在旧井。玩家先信息交出位置、后续想取钥匙开门 | 可拾取钥匙 → 用匹配钥匙开门 | 操作集无 pickup/take；`transfer` 要求 `item.owner == actor`，而钥匙 `owner=None` → 永远 `key_not_owned`，`unlock` 恒失败，只能反复 `force` | `scene.py` L28-29；`rules.py` L22-31（RULES 表无 pickup）、L78、L84-87 | 否 |
| A2 物体可被 attack 摧毁 | 玩家"拔刀削苹果"（物体语境、非攻击 NPC） | 判为对物体的无害处理或澄清，不产生战斗结算 | apple 带 `health:2` 即满足"可攻击"门槛；刀 combat+1 → margin≥1=`success` → 伤害 2 摧毁苹果并记 `attack_attempt` | `scene.py` L33-35；`rules.py` L98-100、L136-138、L198-210 | 否 |
| A3 语义类别 `kind` 被规则层弃用 | "我不会伤害你，但门肯定扛不住我"（否定+威胁）；隐喻威胁"你最好祈祷太阳还能升起来" | 否定不执行；隐喻威胁产生合理表达后果，不物理执行 | `rules.py` 裁决只看 `operation`，`violence/threat/challenge` 等 `kind` 无任何消费（已 grep 确认：rules.py 中 "kind" 仅指 door/事实类型）。否定句若被模型标 attempt 即真实扣血/推门；`--rules-only` 下威胁是零后果 no-op | `rules.py` L22-31、L49-107、L151-235 全文；`interpreter.py` mode 字段存在但规则层不读 | 否 |
| A4 零测试 | 任务书 §18 要求 Interpreter 7 类/Resolver 6 类/Outcome 不可篡改/2NPC×2sessions | 应有新增可运行测试 | HANDOFF 自述"没有新增或执行测试"，TRACE_EXAMPLE 为人工推演 | `HANDOFF.md` L16、L99-104；`ARCHITECTURE.md` L168 | 否 |
| A5（防御性发现，非越权） | 缺 `location` 属性的实体交互；Laya before/after 顺序耦合 | — | 缺 location 恒判 `target_out_of_reach`（fail-close 误封不越权）；规则 change 先于 Laya change 回放、路径无碰撞故当前无碍，未来同路径会触发 PROPOSAL_CONFLICT（fail-safe） | `rules.py` L63-64；`service.py` L101-112、L147-150 | 否（按设计留待融合版处理） |

### 候选 C（branch `candidate-c-interaction-core` @ `b3a18f4`，HEAD 未变）

| 编号 | 输入/场景 | 预期 | 实际 | 证据位置（相对 `demos/laya-live/interaction_core/`） | 已修？ |
|---|---|---|---|---|---|
| C1 客户端操纵结算（最严重） | POST /core/turn 携带 `difficulty: -20`（或 +20） | 难度由服务端权威；客户端字段被忽略或拒绝 | `pipeline.py` 把 `payload["difficulty"]` 直接 `float()` 注入，`resolver.py` 无符号/边界钳制 → threat 可被强制 `exceptional_success`，正数可强制失败。"failure 变 success"由 HTTP 客户端一线触发，等价 Director 后门。**本次已亲手复核源码确认** | `pipeline.py` L177；`resolver.py` L167-169（`explicit_difficulty` 直接加），无 min/max | 否 |
| C2 失败敌意意图 doubt 反转 + 审计文本失真 | 玩家威胁/动手但结算 FAILURE | 失败威胁应体现敌意成本，怀疑不降 | FAILURE=-0.5、CRITICAL=-1.4；threat/violence/hostility/challenge `dir=+1`；`delta = dir × magnitude` → **失败威胁使 doubt 下降**，与"成功示好"同号近量级；且 `_state_reason` 文案报未带符号的 magnitude：信任向意图失败时文本写"怀疑 -0.5"、实际 delta +0.5。**本次已亲手复核源码确认** | `outcome.py` L30-39、L42-48、L221-230、L248-255 | 否 |
| C3 Story 违约台词放行（fail-open） | 云端叙事违约（写出"她完全相信了你"） | 回退权威结果表达，不放行展示 | `narration.py` 两次降温后仍违约则"如实返回"（L131-133），pipeline 不拦截即原样可见；子串禁词表是最后防线且不完整。本次复核了 `narration.py` 路径 | `narration.py` L77-81、L114-133 | 否 |
| C4 actor/target 声明不消费 | "把名单给卫兵甲，别给莉亚" | 结算与提交按意图目标分别进行 | `Intent.targets`/`actor_identities` 声明后从未消费；pipeline 恒按单一 `frozen_state` 结算并经固定 actor 桶 commit | `pipeline.py` L172-177 只传 `_target_stats(frozen_state)`；`schemas.py` targets 字段 | 否 |
| C5 Facts 层半空 | 声称出示未持有的徽章 / reset 某 NPC | 事实对账成立；reset 只影响目标角色 | `world_facts` 赋值即弃；`inventory` 生产路径无 `add_item` → `evidence_handover` 恒 `false_claim`；`reset_fact_bases` 忽略 `actor_id`，清 NPC1 连坐 NPC2 | `facts.py` L111、L68-76；pipeline 调用处 | 否 |
| C6 测试为 mock 管道 | 否定/隐喻/多意图真实语义 | 真实语义有覆盖 | Interpreter 语义用例全部 mock 掉 LLM，测的是契约管道而非语义；数值档位无真实语料校准 | `tests/interaction_core_unit.py` | 否 |

### 候选 B（branch `laya-b-freeform`，受审 `4e61eca` = 当前 `a55ef9a` 代码）

| 编号 | 输入/场景 | 预期 | 实际 | 证据位置（相对 `demos/laya-live/`） | 已修？ |
|---|---|---|---|---|---|
| B1 数值空转 | 任何需要档位结算的输入 | 六档均可随输入达到 | stats 恒 0.55、relationship 恒 0/-0.1、env 恒 0、resource 恒 1.0 → 实际只剩"事实门 + ±0.1 Laya 修正"，critical/strong/exceptional 基本不可达 | `laya_resolver.py` 常量与 factor 计算 | 否（B 自身定位未完成候选，融合版不整包继承） |
| B2 give 不拒自指 | "我把徽章递给我自己" | 拒绝或澄清 | `give` 无 `target==actor` 拒绝 → 语义错但状态无损（漏洞面小） | `laya_interaction_b.py` give 分支 | 否 |
| B3 prompt 内嵌任务书例句 | 黑盒用"削苹果/太阳/老井砖"原句测试 | 不被训练式先例带偏 | 提示词逐字嵌入任务书 §4/§17 例句，接近"为测试写死"边缘 | B 的 Interpreter prompt | 否 |
| B4 跨轮历史无清洗注入 | 玩家历史消息含"忽略之前指令" | 提示注入被隔离 | 玩家原话直插 LLM 上下文，间接提示注入无清洗 | B 的 interpret 调用处 | 否 |
| B5 测试仅一类 | 任务书 §18 五类 | 全量 | 仅 Interpreter 类有测试，Resolver/Facts/Outcome/Isolation 缺四 | `tests/b_turn_interpreter_test.py` | 否 |

**增量核对结论**：`4e61eca → a55ef9a` 只追加 `HANDOFF.md` 19 行（B 自己的只读复核记录），无任何代码/契约影响，上述 B1-B5 直接适用。job 卡所述"B 未完成"是较早快照；B 功能提交 4e61eca 相比当时审查无变化。

**未运行时复现的项**（按任务卡要求如实标注，不做完整复跑）：以上全部为静态源码证据与路径推演；C1、C2、A1、A2 为源码级确认（行号指向可审计），C3/B2/B4 为代码路径复核。运行时复现与修复验证按 plan.md 归 P5 定向用例，不在本任务重跑模型。

---

## 2. 契约 v0.1 复核（只报阻断类问题，每项附最小反例与改法）

总体：契约的权威链（Interpreter→Facts→Laya→Resolver→Commit→Story 只读回执）与八项硬原则沿用了恢复记录的既定融合方向，方向正确、无"整包拼接"倾向，可作底稿。以下 4 项为会导致权威倒置 / 不可提交 / 玩法断链 / 跨角色污染的阻断问题：

**C-1 玩法断链：契约未定义"获得物品"路径（A1 的直接复现风险）**
§5 承诺 P2 实现"移动到旧井、拾取钥匙、返回开门"，但 §1/§3/§5 从未定义 pickup/take 操作，也未说 owner=None 的物品如何合法转成玩家持有。
反例：按 A 的规则底座实现 → 地窖钥匙 owner=None 且无拾取操作 → 任务书 §22 的那句"钥匙埋在旧井砖下"永久只是口头信息，链路在第二步断裂。
改法：在 §5 明确第一版动作集包含 take/pickup（含移动前提：目标物品 `location == actor.location`、`owner is None`），"获得"只能通过 Facts 登记的移动+拾取，模型不得直接改 owner。这是 P1 冻结前的必写条款。

**C-2 不可提交/权威倒置：Commit 重算与预览不一致时未定语义**
§4 要求 Commit"重验…候选结果"，但没说重算结果 ≠ 预览结果时怎么办。实现若静默采用重算结果，则"预览权威"倒置（玩家看到 A 提交成 B）；若一律拒绝（A 现在的 PROPOSAL_CHANGED 409），客户端必须整轮重 prepare——两种语义对 P1 的"网络重试有清楚结果"验收点影响不同。
改法：写明"重算与预览不一致 → 409 + 候选作废 + 客户端重新 prepare，禁止用重算结果替换预览"。

**C-3 跨角色污染：有向关系条款未落到第一版数据**
§3 末段要求"谁对谁"的有向关系，但 A/B/C 现有 relationship 都是 NPC→player 单向量；§8 问题 2 仍开放。若 P1/P2 直接复用现有关系向量并允许 persuade/反制对任意 NPC 生效，会出现 NPC↔NPC 借假向量结算（C 的 `npc_counter` 正是这样造了一个假玩家 target_stats）。
改法：第一版关系 schema 强制 `from_id → to_id`；NPC↔NPC 在无成对数据时显式拒绝或置零，契约给出这条"拒绝语义"，不留为开放问题。

**C-4 跨会话污染面：prepare 的"事件占位"未限定边界**
§4 允许 prepare 写"有 TTL 的 Pending、事件占位和版本元数据"。若"事件占位"落在共享事件表且未按 `(session_id, event_id)` 键控，prepare 会写正式可见的会话外状态（plan.md 明确"这些不是 Actor 初始化或正式历史"，契约应引用同一口径）。
改法：§4 补一句"允许写入的仅限进程内 (session, event) 键控元数据与 TTL 候选，不得创建 Actor bucket、追加正式历史或推进回合时钟"。

**特别核三项（任务卡指定）**：
1. **硬规则拒绝能否被数值绕过** —— 现 C 的 `denied` 是 +10.0 有限数值惩罚（`resolver.py`），若未来 potency 加成增长无上界，理论上可越过。契约 §3"不得用一个有限数值惩罚继续掷进成功档"方向正确，建议升级为结构性条款：verdict=denied → 不进 margin 公式，直接短路为 FAILURE/未执行，`insufficient` 同理至少保底在失败档。
2. **难度能否被客户端影响** —— 契约 §3 TurnInput 已禁，§6 已点名 C 的风险（其措辞"设计风险、非已复现结论"偏保守：C1 是源码级确认的注入点，建议 §6 改为"已定位注入点，融合版必须移除"）。补充：测试注入入口与生产 HTTP 分离；生产难度只由服务端 Facts/Stats/环境给出。
3. **Prepare 是否会写游戏态** —— A 的 prepare 经 `state_version(scope)` 可能创建 scope 版元数据（幂等元数据，非游戏态），与 §4"允许版本元数据"一致；但 P5 的"Prepare 零写"验收须把"版本/Pending 元数据"与"游戏态"分开计数，并禁止模板化初始化 Actor bucket。契约 §4 引用 plan.md 的口径即可闭环。

---

## 3. 模块复用短表（可复用 / 需改造 / 不建议搬入）

| 模块 | 来源 | 判定 | 说明 |
|---|---|---|---|
| `contracts.py` dataclass 契约 | A | 可复用 | schema 底稿；补有向关系、可见性（私密/公开）、fact 类型四分类 |
| `service.py`（prepare/commit 编排+幂等+锁内重算比对） | A | 可复用（核心） | 按 C-2 补"重算不一致"语义；保留 analysis_id+期望版本+receipt replay |
| `commit_interaction_bundle`（多实体原子事务+回滚） | A | 可复用 | 这就是 D 原审查确认的"必要最小协议扩展"，证明现有协议可承载多实体提交，无需新建状态真源 |
| `check_facts` 硬前提层 | A | 可复用+需改 | 补 take/pickup、NPC/物体攻击区分、location 缺省语义、denied 短路 |
| `interpreter.py` 的 decode 校验（白名单+evidence 子串+mode） | A | 需改造 | 保留结构性防线；补 kind 消费与否定/隐喻规则层兜底（A3 根因） |
| `narration.py` 的 NarrationContract + canonical_renderer | A | 可复用 | 作为云端叙事的违约回退基准 |
| `resolve_one`（A 规则结算） | A | 不建议搬 | 数值薄且引 A2 物体攻击问题，档位内核由 C 取代 |
| B `laya_turn_interpreter.py`（封闭枚举+无关键词） | B | 可复用（思路） | 接云端语义；补澄清状态与历史清洗（B4） |
| B commit 重验思想 | B | 融于 A service | 已由 A 的锁内重算覆盖，不单独搬 |
| C `resolver.py`（贡献分解+六档+玩家/NPC 共享） | C | 可复用（内核） | 删客户端 difficulty（C1）；denied 改短路（C-1 特别核）；保留逐项贡献可审计 |
| C `outcome.py` 档→delta 映射 | C | 不建议搬 | C2 的失败负 magnitude 反转是根本性缺陷，敌意失败语义需重定义后再搬 |
| C `fail_forward` 语义表 | C | 可复用+需改 | costs/complications/opportunities 语义化；声明类输出不得生成事实 |
| C `narration.py` 云端生成+违约检测 | C | 需改造 | 违约必须回退权威渲染（C-4 §4），不得"如实放行"给前端 |
| C `npc_counter_intent` | C | 不建议搬 | 无目标、无关系、造假玩家 stats，重写后再考虑 |
| B resolver 数值常量 | B | 不建议搬 | 空转，无价值 |

**对契约 §1"最影响此选择的变量"的明确回答**：D 原攻击（A 的 bundle 提交已验证结构）+ 本轮复核表明，现有协议**可以**经 `commit_interaction_bundle` 这一最小扩展承载多实体提交，不需要额外建第二套状态真源；但契约必须先把 C-1（取物断链）、C-2（重算不一致语义）、C-3（有向关系）这三条写死，P1 才能开工。

## 4. 结论

- 契约 v0.1 可作底稿，但未到可冻结状态：需先合入 C-1~C-4 与"denied 短路"条款。
- 未擅自将契约标为冻结；未改融合工作树、未启动 P1、未重建能力档案、未跑模型。
- 下一步建议：A 收件后在 v0.2 合入上述条款并定稿 P1 任务卡；P5 按 §1 清单把 C1/C2/A1 转成运行时复现用例。
