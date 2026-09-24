# L3 四模式作品设定库接入骨架

日期：2026-09-22。**仅规划，未实现/未批准运行态接线**。先完成 L2。
本文件定义边界与验收，具体 wire 字段需在实现前对真实 handler 逐项核对，不能照搬内部结构。

## 1. 目标与复用事实

用户选一份作品设定库，再进入写作/游戏/叙界/沙盒；常驻背景进入首次模型输入，按需正文经受控读取获取，手动资料仅用户明确选择可读。
各模式可以选不同的库，也可以只读复用同一库；首版每个运行仅绑定一个库，不做多库自动合并。
**不是再次新增第五个运行模式，也不是新建一个“世界”中转存储。**

当前真实复用点（实现时再核对）：
- `internal/app/world_context_writing.go` 的 bind-before-start 和 session/task 生命周期。
- `world_context_interactive.go` 的新回合 resolve 与 regenerate 复用。
- `internal/agent/world_context_runtime.go` 的临时输入与历史隔离。
- `internal/worldcontext/registry.go` 的运行期引用释放原则，**不直接把 Library 伪装成 World Snapshot**。
- 现有共享模型网关、受控 iframe 宿主路径。前端 Provider 的存在不是交接已消费的证据。

## 2. 接入契约草图（已被 §8 B0 冻结契约细化取代，保留作背景）

服务端绑定的 LibraryReadRef：
- libraryId：唯一库；
- expectedRevision：选择时已保存的库版本；
- manualItemIds：本次用户明确授予读取的手动条目集合。
consumer、scopeKey、runContextId 不由用户或模型提供；受控入口派生。
auto 正文读取是模型在获准目录内的按需行为，不是额外授予 manual 权限。
L2预览的 autoItemIds 仅用于模拟本次读取，不自动成为长期授权。

服务端只在已建立运行身份后产生临时读取授权：
运行身份 + 固定库revision + 用户manual允许集 + 累积读取预算。
这不是新的持久化资料表。ID/revision/安全状态可作为非正文运行元数据，正文不进World/Library/剧情存档。

首版不缓存历史版本的整个库：绑定时先读/核版本；后续按需读取再比对版本。
运行中库变化 → library_revision_conflict，停止追加旧授权下的新正文，提示重选并开新运行。
已经进入模型的本轮临时片段可保留至运行结束，不能悄悄替换为最新版。
拒绝在旧revision授权下“重新读取当前文件再当成原版本”。

## 3. 背景来源互斥

每次运行的背景策略必须显式为 legacy / library / none（transport 名称已在 §8.1 冻结为 `background_source`）：
- legacy 保持已有 World/Lore 行为，不因新功能改变旧请求。
- library 使用一份新库；禁用旧背景**注入通道**，不删旧资料，也不禁写作正文/项目工具。
- none 不携带作品背景。
同时提交相冲突的 Library/World 控制字段必须报错，不能按任意优先级吞掉其中之一。
需核查旧 lore 工具与自动注入点；只移除一个提示片段并不能证明不存在暗中叠加。

## 4. 临时上下文与失败语义

- 初始输入：有来源标记的库概览、常驻正文、有界auto目录、明确选择manual正文。
- 按需工具：工具持有服务端授权对象；只允许目录内auto或用户已授权manual，禁用项不可绕过。
- 模型提交任意库ID、磁盘路径、consumer/运行身份均无效；每次读取校验归属和剩余预算。
- 预算覆盖初始输入+工具结果+历史+系统提示+预留输出；同一项重复读取不能绕过累计预算。
- 背景正文不得落Session、展示存档、run ledger、压缩源/summary。工具结果若通常持久化，必须先解决临时工具结果边界，不能直接沿用会写正文的默认路径。
- 新读取失败要显式 unavailable/stale/denied/budget_exceeded；不能标active却偷偷bare。
- 用户可显式选择“无资料继续”；无法读取背景不是允许默认静默降级的理由。
- 新库权限不是模型提示词安全沙箱；来源文本是不可信数据，不得授予工具/写入权限。

## 5. 生命周期矩阵

| 动作 | 规定 |
| --- | --- |
| 选择库/带入模式 | 仅组件内待交接Ref；目标书/故事选择成功才消费 |
| analysis首次预览 | 使用同一授权与投影，若复用现有handle，必须证明首次分析→运行同字节，不直接复用不同数据类型 |
| start | 完成库版本/预算检查后再启动模型，不得先启动再补绑定 |
| 写作新task | 由服务端session/task归属绑定；取消/切书清理未消费交接 |
| 游戏新回合 | 新InteractiveRun，Task仅执行尝试 |
| regenerate | 同InteractiveRun已有临时背景，不能依赖客户端重发Ref；背景已过期则明确失败/提示重选，不猜新版本 |
| reconnect | 复用同次运行与状态回放，不重抽来源、不重新授权 |
| 切故事/分支/iframe实例 | 清旧待消费交接；已经独立运行的任务按现有归属清理 |
| complete/cancel/destroy | 幂等释放临时上下文，无负refCount |
| 进程重启 | 不从剧情存档恢复背景正文或旧授权；显式重新选库/确认版本 |

## 6. 分段任务、文件范围与验收

| 批次 | 文件范围（拟） | 必须通过 |
| --- | --- | --- |
| L3.0 契约与授权 | libraryruntime、app/agent的最小接口及测试；transport单独DTO | 背景互斥；手动授权不可伪造；禁用/跨库拒绝；无模型/数据写入 |
| L3.1 写作纵向 | 写作handler/app/agent临时注入、对应前端Provider/入口/状态条 | 挂载后交接真实被消费；analysis/首发/取消/重连；模型实际输入有且仅有获准内容；落盘无正文 |
| L3.2 游戏纵向 | interactive handler/app/StoryStage、现有InteractiveRun | Turn持久化后才建索引；regenerate复用；切故事/分支不串库；active/degraded/none真实可见 |
| L3.3 叙界 | 宿主受控bind/call及对应入口 | 不改iframe信任根；无库Ref/运行秘密泄漏；第一请求等待绑定 |
| L3.4 Module4 | 仅现有受控适配与入口 | 不改Adventure规则/存档真源；动作成功与背景读取状态独立 |
| L3.5 收口 | 全套回归+正式exe+真实模型 | 四模式实际读取、无剧情回写、重连/取消/过期、无持久正文、Key脱敏 |

文件范围需在每批开始前按真实调用点精确化，不能以此表授权整目录重构。
CHANGELOG、协作日志、中英文字由集成者集中修改，避免并行冲突。
每个纵向批次独立commit；一次完成整段再审查，避免逐函数等待审批。

## 7. 不做与风险

不做新Agent系统、世界模拟、全局Canon、剧情自动同步、多库合成、新模型网关或新密钥设置。
最大风险：预览绿但实际不注入；按需工具把正文写入Session；旧Lore暗中叠加；客户端用ID冒充授权；游戏regenerate换背景。
每一项都需真实消息装配或存储扫描证据，UI徽章/200响应不足以放行。

## 8. B0 冻结契约与真实调用点锚点（2026-09-24，基线 968d1e2，只读调查产出，未接线）

本节由 B0 对照当前代码逐项核对后冻结；锚点为 `denova-src/` 下 文件:行号，采集自基线工作树（`internal/agent/prompt.go`、`config_manager_tools.go` 存在他人未提交改动，本节未引用这两个文件）。实现批次（L3.0 起）以本节为契约，变更须先改本节。

### 8.1 transport 字段与冲突拒绝

- 新增外层字段 `background_source`（snake_case，与 `world_context`/`analysis_handle` 同层）：`"legacy" | "library" | "none"`。
- legacy 载体不变：`world_context{worldId, expectedWorldRevision, selection}` 与 `analysis_handle`（chat 与 interactive 共用 PolicyChat 解码；证据 `internal/api/handlers/handler_chat_world_transport_test.go:49-81`、`handler_interactive_world_transport_test.go:15-17,65`）。
- library 载体：`library_context{libraryId, expectedRevision, manualItemIds[]}`，内层 camelCase 与 L2 preview DTO 一致（`internal/api/handler_library_context_preview_test.go:51` 已证 `runContextId/scopeKey/modelView/runSalt/analysisHandle` 被拒）。
- 冲突拒绝：`library_context` 与 `world_context`/`analysis_handle` 同时出现 → HTTP 400 `background_source_conflict`，禁止任何优先级吞并。legacy 内部既有优先级（Ref 优先于 handle，`internal/app/world_context_writing.go:100-101`）不受影响。
- `background_source` 与控制字段不一致（如 `library` 但无 `library_context`，或 `none` 却带 world 字段）→ 400。字段缺省时结构推断：有 `library_context`→library，有 world 字段→legacy，全无→none；旧请求行为不变。
- 传输层沿用越权/未知字段拒绝模式（`handler_chat_world_transport_test.go:121-131`）：consumer、scopeKey、runContextId 及一切运行身份字段在 library transport 同样拒绝。

### 8.2 服务端派生身份与绑定时机

- 写作：consumer 固定 `writing`，scopeKey=`"task:"+taskID`（`world_context_writing.go:46-50,106-107`）；绑定先于模型 goroutine（bind-before-start，`world_context_writing.go:14-22,308-337`）。library 绑定沿用同序：先核库版本/预算，再启动模型。
- 游戏：InteractiveRun 身份 `create/bindContext`（`world_context_interactive_runs.go:132-193`），turn 持久化后以 `(story,branch,turn)` 反查 runID（同文件:242-289）；新回合 resolve（`world_context_interactive.go:80-190`），regenerate/reconnect 走 `reuseInteractiveRunContext` 复用（同文件:203-250；`interactive_app_service.go:937-980`）。library 同构：regenerate 复用原运行绑定，不得依赖客户端重发 `library_context`；过期/版本变化显式失败。
- 受控 iframe：consumer 由路由固定 `narraverse|module4`（`internal/api/routes.go:266-276`，`internal/worldcontext/types.go:23-39`）；宿主信任根=回环+`Origin` 匹配（`handler_world_context_host.go:100-106`），绑定校验 `frameInstance`+Ref 后 `BindWorldContextHostFrame`（同文件:168-205），一次性 secret 走 HttpOnly Strict cookie、不回 JSON（同文件:119-148）。library 接入只增 bind 载体类型，不改信任根与 secret 机制。
- LibraryReadRef 仅服务端持有：`{libraryId, expectedRevision, manualItemIds}` 由受控入口随启动请求提交；L2 preview 的 `autoItemIds` 只模拟本次预览读取，**不进入任何运行授权**。

### 8.3 修订、授权与累计预算

- 单运行单库单 revision：绑定时读/核版本；运行中库变化 → `library_revision_conflict`，停止追加旧授权下的新正文，提示重选并开新运行（阻断分类沿用 `isBlockingWorldContextError`，`world_context_writing.go:63-78`：请求/选择/修订/归档/引用不一致/消费者不受信=阻断）。
- `manualItemIds` 仅为本次用户显式授权的手动条目集合；禁用、跨库、过期版本一律拒绝。auto 目录读取是模型在获准目录内的按需行为，不是 manual 授权的扩展。
- 累计预算：单运行单计数器，覆盖 系统提示+历史+初始装配（库概览+常驻正文+有界 auto 目录+manual 正文）+每次按需读取工具结果+预留输出；同一项重复读取照计；每次读取前校验归属与剩余额度。测量沿用 L2 `librarycontext.Build` 的定点迭代法（`internal/librarycontext/preview.go`）。数值常量由 L3.0 定为配置项，不在本契约写死。
- 不引入新的服务端 analysis handle 机制：library 首次预览即 L2 preview 端点（咨询性），运行消费由启动请求显式字段承载，preview 与 run 不共享 handle 状态。

### 8.4 运行态错误语义

- 绑定期（模型启动前）：请求非法、选择含禁用项、revision 冲突、consumer 不受信、库不可用 → **阻断启动**。用户显式选库后失败不静默降级；须显式改选或显式选 none（“无资料继续”必须是用户选择，不是默认值）。
- 运行期按需读取失败：显式 `unavailable | stale | denied | budget_exceeded`；不得标 active 却暗中 bare。状态事件在首个模型 chunk 前下发（沿 `internal/api/agentui/stream.go:77` 与 `stream_test.go:106-116` 的先行+脱敏约束）。
- 状态 wire 只含脱敏摘要（libraryName/revisionLabel/selectedCount/errorCode 类，沿 `world_context_service.go:119-131` 最小投影与 `handlers/world_context_state.go:12-19` 字段集）；runContextId、scopeKey、fingerprint、正文不下发（`stream_test.go:144-146` 的禁发清单同样适用）。

### 8.5 持久化边界与逐处验证锚点

- 初始模型输入：唯一注入通道=运行选项的 ephemeral 前缀（装配 `internal/agent/world_context_runtime.go:30-42`，进入 `chat.go:418-428` `ModelInputMessages`）。library 走同构 EphemeralLibraryContext，栈内生命周期约束照抄 `world_context_runtime.go:8-18`（不进 Session、压缩、ledger、display）。
- 工具结果：旧 lore 工具结果会持久化到 display（`internal/agent/chat_display.go:167-181`）——**library 按需读取工具不得沿用该默认路径**；ledger/display 只允许记条目 ID、revision、错误码等元数据，禁止正文。
- 压缩：压缩源为持久化历史（`internal/agent/context_compaction.go`），ephemeral 前缀不进历史故不进压缩；L3.1/L3.2 验收时以该锚点做落盘扫描复核。
- run ledger：`chat.go:157,204,218` 只记 run_context 元数据与 finish 状态；library 只增记库 ID/revision/错误码。
- Session 与展示存档：同 ephemeral 约束，无库正文。

### 8.6 旧背景通道穷举与不叠加证据（library 模式必须全部关闭）

1. WorldContext ephemeral ModelView：写作 `resolveWritingRun`（无 Ref/handle 即 bare、零 Registry 增量，`world_context_writing.go:91-113`）、游戏 `resolveInteractiveRun`（`world_context_interactive.go:80-190`）、宿主 bind（`handler_world_context_host.go:168-205`）。library 模式在传输层 400 拒绝 world 字段后，这些路径天然零背景。
2. **旧 lore 工具（独立于 world_context，必然存在）**：`internal/agent/lore_tools.go`（read/list/write_lore_items，数据源 `internal/book`）经 `builder.go:483-571` ExtraToolsFactory 按 agent 配置挂载，与是否携带 world_context 无关。library 模式必须以 per-run 读取策略禁用 lore 读取（`builder.go:560-571` 已有 `loreToolsOptions{ReadPolicy}` 钩子可承载），否则模型可同时拉取两套设定。
3. 系统提示词行为段：`internal/agent/system_prompt.go:132-147` 含资料库工具使用指引；library 模式须把对应指令替换为 library 读取指令，避免模型被指引调用旧工具。
4. 游戏 Director 稳定上下文：director.md / agent-brief.md / **lore-context.md**（`system_prompt.go:142`，`internal/agent/interactive_director*.go`）；library 模式下 lore-context.md 不得注入。
5. 配置管理 Agent 的资料库工具（`config_manager_master_tools.go`）属配置模式，不进 chat/interactive 模型输入，不构成叠加；B4 接入时不得借道配置工具传库正文。

结论：通道 2/3/4 与 `world_context` 相互独立，是真实叠加风险。L3 各批验收必须对 2/3/4 分别给出关闭证据；仅删除一个提示片段不构成“无叠加”证明。

### 8.7 共用设施与禁止项

- 模型调用一律走既有共享网关（`internal/app/model_gateway.go`、`internal/api/handlers/handler_model_gateway.go`），不新增网关、密钥或第二设定真源；唯一真源=`internal/library` store 经 L2 Build 投影。
- 8080 用户服务入口不动；L3 各批在隔离 executable 验收。

### 8.8 B2a 写作链实现回写（2026-09-24，冻结供 B2b/AI3 与 B2c/AI1 对接）

以下为 B2a 落地后的受控 wire 契约与实现锚点，B2b 前端与 B2c 闭环按此对接；与 §8.1–8.7 冲突时以本节为准（实现层修正已标注）。

- transport（`internal/api/handlers/world_context_transport.go`）：顶层 `background_source`（`legacy|library|none`，snake_case；null/空串=缺省，按结构推断：有 `library_context`→library、有 world 载体→legacy、全无→none）；**修正轮：`RuntimeWorldContext.BackgroundSourceExplicit` 区分“显式声明”与“结构推断”——推断 none 不等于显式 none，只有显式 `background_source="none"` 才走无背景路径，未声明/推断请求保持 legacy 旧路径逐字节兼容**；`library_context{libraryId,expectedRevision,manualItemIds[]}`（内层 camelCase，与 L2 preview DTO 一致）。互斥即 400 `background_source_conflict`（library+world_context / library+analysis_handle / legacy+library_context，**修正轮新增：library 或显式 none + 非空 `lore_references`（field=lore_references；未声明/legacy 不拒，null/空数组视为无）**），不做优先级吞并；声明一致性（library 无载体、none 带字段）400 `invalid_request`；子树越权键（consumer/scopeKey/runContextId 等）按 `forbiddenWorldContextKeys` 前缀 `library_context.<key>` 精确拒绝；`manualItemIds` 逐项去空白、空条目拒绝；`PolicyContextAnalysis`+library（显式或推断）→400（§8.3：库预览只走 L2 preview 端点）。
- 绑定（`internal/app/library_writing.go`，bind-before-start）：scopeKey=`task:<taskID>` 服务端派生；Bind 用零值 Config→默认预算，Baseline=0；`AssembleInitial` 计初始装配（含冻结抬头，B1 修复轮口径）；系统提示+逐轮历史在模型送入前经 `Run.ChargeExternal` 计入同一累计计数器（`internal/agent/chat.go` 装配点；失败→显式 `budget_exceeded` 终止运行，不静默降级）。绑定期失败→HTTP 映射：`invalid_request|selection_invalid`→400、`consumer_not_trusted`→403、`revision_conflict`→409、`library_unavailable`→503、`budget_exceeded`→413（`internal/api/handlers/handler_chat.go`）。Library 与 World 同现由传输层 400 拒绝，app 层防御性再拒（`world_context_writing.go`）。
- agent 装配（`internal/agent/library_context_runtime.go`）：`EphemeralLibraryContextInput` 头部前置，`ModelInputMessagesWithLibrary` 序=library→world→history（防御序，传输层已互斥）；`BuildWithLibraryBackground`（`builder.go`，**修正轮：改收单源 instruction 参数**，空串防御性回退自建；nil Run 回退 `Build`）挂 `read_library_item`（`library_read_tool.go`，持有本次绑定 Run；nil Run 构造期报错），**不挂任何 lore 工具**。§8.6 通道 2 实现修正：未走 `loreToolsOptions{ReadPolicy}` 钩子，而是新工厂 `ideToolsFactoryWithLibrary`（library 工具+插图工具，无 lore 三件），其余工具集与旧工厂逐字节一致。**修正轮新增显式 none 构建路径**：`BuildWithNoBackground(ctx, cfg, instruction)` 用 `ideToolsFactoryNoBackground`（仅插图工具：无 lore 工具、无库工具），空 instruction 显式报错（none 无回退路径）；app 侧对应 `buildAgentRunnerWithLibrary`/`buildAgentRunnerWithNoBackground`（`runtime_builder.go`）。
- §8.6 通道 3 实现修正与证据：资料库工具指引实际位于 `internal/prompts/system.go` 的 `systemInstructionBody`（原锚点 `internal/agent/system_prompt.go:132-147` 已漂移）。**修正轮：`SystemInstructionInput.LibraryBackground bool` 升级为 `BackgroundMode string`**（`BackgroundModeDefault|Library|None`，值与 transport 的 legacy|library|none 对齐），经 `loreBackgroundGuidanceRows` 7 行**三列**替换表（legacy 列必须与 body 逐字节一致=旧请求兼容；library 列=`read_library_item` 指引+"设定库只读背景"语义；none 列="以大纲/进度/既有章节为准"的无背景语义）按模式整段替换全部 lore 工具指引（工具说明/工作流 4、5/初始化第 6 步/续写第 1、6 步/重写第 4 步）；替换表与 body 逐字节同步由 `TestBuildIDEWritingFlowInstructionBackgroundModesReplaceLoreGuidance`（prompts）与 `TestIDEInstructionLibraryBackgroundReplacesLoreToolGuidance`（agent）双端守护。
- **修正轮新增：旧 Lore 注入三通道全关（library/显式 none 模式；legacy 不动）+ 单源 composition。**① 系统提示组成：`agent.BuildBackgroundInstructionComposition(cfg, state, teller, mode)` 单源构建一次——library/none 模式下 StateContext 与审计 stateParts 取 `book.CompactContext(Parts)ExcludingLore()`（排除 ID=lore 的片段，保序）；② 稳定上下文消息：`IDEWorkspaceRuntimeContextsForRequestExcludingLore(state, req)`（stable 排除 lore，dynamic 原样）——实证 B0 重构后 lore 正文经稳定上下文消息进入模型而非系统提示正文（`prompts/system.go` StateContext 注释），关闭稳定上下文即关闭 lore 正文注入；③ `lore_references` 引用通道：传输层 400 + app 层 `planWritingBackground` 防御性再拒（`ErrInvalidRequest`，拒绝发生在绑定/启动前，不静默丢弃）。app 层 `WritingTaskInput` 增 `BackgroundSource`/`BackgroundSourceExplicit`（`handler_chat.go` 转发），`planWritingBackground` 单点裁定三模式（有 library_context→library；显式 none→none；其余含推断 none→legacy）。**计费与审计单源（缺口②修复）**：同一 `plan.Composition` 既以 `Instruction()` 作 runner 构建输入（模型实际系统提示），又整体作 `RunOptions.SystemPromptLog`——计费点 `chargeLibraryRuntimeInputCost`/`ChargeExternal` 与提示审计不再用默认 `BuildInstructionComposition`；守护断言：legacy 与默认 composition 逐字节一致（兼容证明）、library composition≠默认（回归守护）、计费文本==单源提示；端到端"计费==实际提示"由构造单源保证（adk `deep.New` runner 内部 instruction 不可外部观测）。
- 持久化隔离四通道（B2a 已关）：① ephemeral 只进当次 `ModelInputMessages`（`PrependTo` 不改 history 原切片）；② `retainToolContextAcrossTurns` 对 `read_library_item` 返回 false（工具结果不跨轮持久化进 Session 上下文，`tool_result_context_semantic.go`）；③ `logToolResult` 库工具短路（只记 bytes，防失败关键词预览泄漏正文，`chat_tool_log.go`）；④ `chat.go` tool_result 事件 data 构建处为唯一脱敏点（SSE wire、display 存档、run ledger 共用同一事件）：content 替换为 `[library-item-read] <name>`，`library_read` meta 只含 itemId/name/type/loadMode/sourceRevision/bytes（失败为 errorCode+有界消息，eino 包装下 errorCode 仍稳定），`ManifestForTool` Source=`library`；model_input_log 头部过滤扩展至库背景（`model_input_log.go`）。压缩：库背景进 compact[0]（与 world 同构），压缩摘要源无库正文（`TestSessionConversationMidRunCompactionKeepsLibraryBackgroundFirst`）。模型经 runner 内部工具循环仍拿全文（唯一全文通道）。
- 状态事件（`internal/api/agentui/stream.go`）：`library_context_state`→`data-library-context-state`，首个模型 chunk 前下发；字段只含 `state`（`active|none`）、`libraryName`、`revisionLabel`（64 字符有界）、`selectedCount`（manual>0 时）；禁发 runContextId/scopeKey/fingerprint/libraryId/expectedRevision/manualItemIds/body/catalog（`TestStreamEncoderLibraryContextStatePrecedesModelContent`）。
- run ledger（`internal/agent/run_options.go`、`conversation.go`）：`run_context` 只增记 `library_id`/`library_revision`（bounded 256B），无库正文。
- B2b 边界（`internal/api/handlers/handler_interactive.go`）：interactive+library（显式或推断）→400“interactive 尚未支持 library 背景”，B2b 接线前 UI 不得向 interactive 发送 `library_context`。
- B2c 前端对接要点：写作请求携带 `background_source`+`library_context`（revision 取自库详情当前值）；**无库请求若要"无作品背景"必须显式声明 `background_source="none"`（不声明=推断=legacy 旧路径，仍带旧 Lore；显式 none 不得携带 `lore_references`）**；消费 `data-library-context-state` 渲染 active/none；冲突与绑定期错误按上面 HTTP 映射处理，不重试 `background_source_conflict`。

