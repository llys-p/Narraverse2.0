# 作品设定库 L1–L4 交接任务清单

状态快照：2026-09-24 07:56（Asia/Shanghai，A1/A2 已推送；B0 完成、B1 完成+修复轮在分支 `library-b2a`，均本地未推送）。**本文件是后续 AI 唯一勾选表**；设计理由见 [总骨架](LIBRARY_EVOLUTION_BLUEPRINT.md)，L1/L2 证据见 [验收报告](../acceptance/LIBRARY_L1_L2_ACCEPTANCE.md)。每次接手先重查 Git，本快照不是永久事实。

## 1. 先知道现在是什么状态

| 项 | 已核实事实 |
| --- | --- |
| 仓库 | `D:\Narraverse2.0`；A1/A2 已推送（`origin/main`=`968d1e2`，L1/L2 基线=`f503173`）。B0 本地提交 `50d6bcc`（契约）、B1 本地提交 `eab8f57`（授权核心）+ 修复轮提交 `6b5c996`、B2a 提交 `c363056`（写作后端接线），均未推送；B1 修复轮起在独立分支 `library-b2a`（工作树 `D:\Narraverse2.0-b2a`，自 `2b1bad1` 接手，B2a 亦在该分支）。期间并行 laya 提交（`48a34f2`/`1f0763e`/`b708cde`/`532f706`）与本任务文件零交集。并行任务的脏改动仍留在主工作树。 |
| L1 | 独立作品设定库及其修复（来源形态、未保存草稿、跨库异步、事件时间戳、缺失更新基线）已随 `f503173` 提交。 |
| L2 | 三档只读加载、Master 固定版本解析、预算、只读预览 API/UI 已随 `f503173` 提交；定向 Go 测试、前端 207 文件/1296 测试、构建和隔离 executable 23 项验收已通过；**未装配到用户 8080**。详细限制以验收报告为准。 |
| L3 | B0 契约已冻结（[L3 计划 §8](LIBRARY_L3_MODE_INTEGRATION_PLAN.md)，提交 `50d6bcc`；B2a wire 契约回写于 §8.8）；B1 授权核心已实现（提交 `eab8f57`+修复轮 `6b5c996`，见 B1 完成记录）；B2a 写作后端已接线（transport `background_source`+`library_context`、bind-before-start、`read_library_item` 按需读取、旧 lore 通道关闭、持久化隔离、状态事件，提交 `c363056`，见 B2a 完成记录）。**写作前端入口与真实模型闭环是 B2b/B2c；游戏/叙界/沙盒接线是 B3/B4**。旧 WorldContext 可用不等于新库接入。 |
| L4 | [迁移方案](LIBRARY_L4_MIGRATION_PLAN.md) 与 `internal/librarymigration/README.md` 是骨架；**没有迁移旧 World/Lore，也没有迁移 API**。 |
| 运行实例 | 隔离验收 18082 已停；用户已有 8080 未被替换。本地 `artifacts/`、`.denova/`、exe、dist、截图和用户资料不得暂存入 Git。 |
| 并行改动 | 主工作树还有 Module4 UI、Agent Skills、知识库、Laya Demo 等他人工作；`CHANGELOG.md`、`项目协作日志.md` 等共享文件混有多个任务的内容。禁止 reset/clean/整树暂存或还原。 |

入场阅读：根 `AGENTS.md`、`项目协作日志.md` 最新条目、`denova-src/AGENTS.md`、本清单、[L1/L2 实施记录](LIBRARY_RUNTIME_IMPLEMENTATION_PLAN.md)、[L2 契约](LIBRARY_L2_READ_CONTRACT.md)，再按领取的任务读 L3 或 L4 方案和相关代码。不要按聊天里的旧 SHA 猜测当前分支。

已完成但尚未共享的本地里程碑（后续 AI 核对证据即可，不要重做）：

- [x] L1 修复和本地保存/重启验收；证据：L1/L2 验收报告第 2、3 节。**代码已随 `f503173` 提交并推送。**
- [x] L2 只读核心、来源解析、HTTP 与 UI 预览及隔离 executable 23 项验收；证据：同报告第 3、4 节。**代码已随 `f503173` 提交并推送。**
- [x] L3/L4 边界方案及目录职责骨架；证据：对应计划和 README。**功能尚未实现。**
- [x] B0 transport/读取授权契约冻结（真实调用点锚点）；证据：L3 计划 §8 与 B0 完成记录。**仅契约，未接线。**
- [x] B1 临时读取授权核心与 ephemeral 临时输入（`internal/libraryruntime` + app 适配）；证据：B1 完成记录与 17 个包内测试（含 3 条预算口径失败先行回归）。**代码已提交 `eab8f57`，修复轮 `6b5c996`（分支 `library-b2a`，本地未推送），未接线任何模式。**

## 2. 多 AI 工作协议

- **AI1＝集成与验收负责人**：持有主工作树；核对基线、精确提交与合并；独占主线的 `routes.go`、共享 `CHANGELOG.md`、`项目协作日志.md`、本文和最终报告。AI2/AI3 只在自己的分支更新本文归属任务行，交 AI1 合并；接入新功能时由 AI1 协调中英 i18n 的提交时序。不可把别人的脏改动带入作品设定库提交。
- **AI2＝Go/运行边界负责人**：基线落成后在独立分支/工作树做 `internal/libraryruntime/`、`internal/app`、`internal/agent` 和受控 handler；只改领到的纵向批次。若需改 AI1 独占文件，先交最小差异给 AI1 集成。
- **AI3＝前端与页面验收负责人**：基线落成后在另一独立分支/工作树做 `web/src/features/library-workspace/` 及对应模式入口、组件测试、浏览器验证。只能按已经冻结的 transport 契约接线；中英文案成对提交。两位 AI 配合时由 AI1 兼任此角色。
- 基线未提交前，AI2 可只读核对真实写作/游戏/iframe 调用点，AI3 可只读设计页面交接与验收用例；**不要从当前 HEAD 开干净 worktree 写 L3**，那样会缺失未提交的 L1/L2 源码。
- 一个任务一个负责人、一个分支、一组精确文件。先合入公共契约，再允许 AI2/AI3 并行写后端/前端；不要同时编辑共享文件或在同一个脏工作树编码。
- **每完成一项就更新本文件**：负责人把对应 `- [ ]` 改为 `- [x]`，在该项“完成记录”写实际 SHA、时间、命令/结果、未验证边界。工作树分离时先在自己的分支更新对应行，AI1 合并后核对主线的勾选状态；未合入主线只能写“分支完成”，不能勾主线验收。失败或等待外部条件保持 `[ ]` 并写阻塞，不以“代码已写”替代验收。
- 每次修改按 AGENTS 更新项目协作日志，精确时间、倒序；正式 commit 前按 `denova-src/AGENTS.md` 更新 CHANGELOG。提交信息英文。不要把 API Key、完整用户存档、原始模型请求或磁盘绝对来源路径写进日志/报告。

交给新 AI 的开工口令（把角色名和任务 ID 替换成实际分配即可）：

> 你是 Narraverse2.0 作品设定库的【AI1/AI2/AI3】，本轮只领取本清单【任务 ID】。先读本文件第 1、2 节、项目两份 AGENTS、最新协作日志及该任务依赖文档；重查 HEAD/status 和前置任务的实际 commit。按归属文件实施并验证。完成后只在自己的分支勾选本任务，填时间、SHA、实际测试与限制，交 AI1 合并；未完成保持未勾并说明阻塞。不要改其他 AI 的任务、用户数据或运行中的 8080。

## 3. 检查点 A：先把已验收的 L1/L2 变成可共享基线

### A1 · 复核并隔离当前改动（AI1；可与 AI2/AI3 只读预审并行）

- [x] 对照验收报告和当前 Git，列出 L1/L2 **tracked 与 untracked** 精确文件；复查 `internal/library/`、`librarycontext/`、`app/library_context_service*`、Library handler/DTO/routes、前端 feature/i18n、相关 docs。审查共享 CHANGELOG/协作日志中的逐块内容。
- [x] 做一次改动比例相称的代码审查：来源版本和写入保护、预览只读、请求脱敏、并发/预算；复用已有门禁证据，仅在 HEAD 变化影响本任务时重跑相关测试。记录结论和实际失败，不把既有 Windows 符号链接权限问题写成测试通过。
- [x] 在所有待提交文件中排除 `artifacts/`、`.denova/`、`.obsidian/`、`node_modules`、dist、exe、截图、虚构验收运行目录及其他 AI 的修改。**完成记录：2026-09-24 06:40（Asia/Shanghai，AI1）。接手时重查 Git：HEAD=379eadb（main 与 origin/main 同步）；`1689b17` 之后的 5 个提交仅涉及 `demos/laya-live/` 与协作日志，与本任务文件零交集，故未重跑测试，直接复用 09-23 验收门禁证据。精确清单：tracked 修改 11（`internal/library/store.go`、`api/handlers/handler_library_workspace.go`、`api/routes.go`、`LibraryEditorPanel.tsx`、`library-panels.test.tsx`、`use-work-library.ts`、zh/en `workLibrary.ts`、`denova-src/CHANGELOG.md`、`docs/DOCUMENTATION_INDEX.md`、`docs/NEXT_PROJECT_BACKLOG.md`）+ untracked 新增 23（`librarycontext/` 4、`libraryruntime/`、`librarymigration/` README、`app/library_context_service*` 2、api handler/DTO/测试 3、`library/origin_update_test.go`、前端 4、docs 8）。共享文件逐块核查：routes.go 仅新增一行 context-preview 路由；DOCUMENTATION_INDEX/NEXT_PROJECT_BACKLOG 的 diff 全属本任务；CHANGELOG 混有 Agent Skills 块（09-22 遗留），已按块分离暂存。审查结论：来源形态保留与枚举校验、baseUpdatedAt 400 拒绝、只读调用链（GetWorkLibrary→Build→DTO，无模型/Task/Registry）、错误脱敏（400/404/409/413/500 通用文案）、请求代次/归属守卫与预算定点迭代，均与验收报告一致。排除项复核：Module4、Agent、知识库、Laya、artifacts/、.denova/、.obsidian/、dist-verify-*、exe、resp.json、截图、docs/_local-archive、09-21 三份文档均未暂存；敏感内容扫描无命中。未重跑既有 Windows symlink 权限失败（internal/skills，非本任务），不写成通过。**

### A2 · 建立 L1/L2 共享提交（AI1；依赖 A1）

- [x] 用精确路径与逐块暂存形成可复核提交；共享文件只暂存本任务片段。提交前 `git diff --cached --name-only`、`git diff --cached --check` 和暂存 diff 全检。
- [x] 记录本地 commit 完整 SHA、分支与远端是否已同步；**提交、推送、合并分别记状态**，不把其中一个写成另一个。若仍未获得执行外部推送的指令，保留本地提交并报告状态。
- [x] AI2/AI3 从该 SHA 建独立工作树后读取真实代码，确认不会基于旧 `3f226e1` 或仅有 L1 的 HEAD 实现 L3。**完成记录：2026-09-24 06:42（Asia/Shanghai，AI1）。精确暂存 34 文件（CHANGELOG 仅 Library 块，Agent Skills 块保留为未暂存改动）；`git diff --cached --name-only` 34 文件核对通过，`git diff --cached --check` 通过（LF/CRLF 为 .gitattributes+autocrlf 提示，非空白错误），暂存 diff 全检 +2168/−32。本地提交 SHA `f503173b2ec0879c7bdab4d9e5248b022f4d30c0`（main，英文 message "feat(library): add L2 read-only context preview and L1 update-safety fixes"）。状态分别记录：已提交=是（本地 main）；已推送=否（main 领先 origin/main 1 提交，未获外部推送指令）；合并=无（未动其他分支）。AI2/AI3 后续必须从此 SHA 建独立 worktree 接手 L3，不得基于旧 `3f226e1` 或仅有 L1 的 HEAD。**

**检查点 A 通过条件**：L1/L2 代码与文档可从同一明确 SHA 检出；相关测试/验收结果有出处；并行用户改动未混入；用户 8080 未被替换。

## 4. 检查点 B：L3 让作品设定库真正供四模式读取

### B0 · 冻结真实 transport 和读取授权（AI2 主责，AI1 审合；依赖 A2）

- [x] 对照当前 chat、interactive、受控 iframe、模型/工具调用点，冻结 `legacy | library | none` 的入口字段、冲突拒绝、服务端派生 consumer/运行身份、单次库 revision 与 manual 授权；明确 L2 `autoItemIds` 只是预览选择，不是长期授权。
- [x] 明确常驻/目录/手动片段和后续按需工具的累计预算与错误码；要求初始模型输入、工具结果、压缩、Session/run ledger/展示存档逐处可验证。契约变化写回 L3 计划并给 AI3 对齐，不能新增模型网关或第二设定真源。
- [x] 用真实调用点证据确认旧 World/Lore 背景不会与新 Library 暗中叠加。**完成记录：2026-09-24 06:59（Asia/Shanghai，AI1 兼任 AI2 职责，依据用户指令）。契约冻结于 [L3 计划 §8](LIBRARY_L3_MODE_INTEGRATION_PLAN.md)，提交 `50d6bccf71e2943176040da6f1b5bd42d20b173d`（本地，未推送）。只读调查基线 968d1e2 工作树，未接线、未调用模型、未改生产代码；`internal/agent/prompt.go`、`config_manager_tools.go` 他人未提交改动未被引用。要点：① transport 冻结为 `background_source`（legacy|library|none）+ `library_context{libraryId,expectedRevision,manualItemIds[]}`，与 world 字段同现即 400 `background_source_conflict`，不做优先级吞并；consumer/scopeKey/runContextId 沿既有传输层拒绝模式。② 身份派生对齐真实锚点：写作 bind-before-start（world_context_writing.go:14-50,91-113,308-337）、游戏 InteractiveRun（world_context_interactive_runs.go:132-193,242-289）、iframe 信任根（handler_world_context_host.go:100-106,168-205）。③ 单库单 revision、manual 授权语义（L2 autoItemIds 仅预览）、累计预算（系统提示+历史+初始装配+按需工具结果+预留输出，定点测量沿用 librarycontext.Build）。④ 错误语义：绑定期失败阻断启动不静默降级；运行期 unavailable/stale/denied/budget_exceeded 显式；状态 wire 脱敏。⑤ 持久化逐处锚点：ephemeral 唯一注入（chat.go:418-428）、lore 工具结果会持久化到 display（chat_display.go:167-181）——library 工具不得沿用、压缩源（context_compaction.go）、run ledger（chat.go:157,204,218）。⑥ 不叠加证据=通道穷举：world ephemeral、**lore 工具（builder.go:483-571，独立于 world_context 必然存在）**、系统提示词资料库指引（system_prompt.go:132-147）、Director lore-context.md（system_prompt.go:142）共 4 条独立通道，library 模式须逐一关闭并留验证点。未验证边界：锚点行号基于当前工作树，L3.0 实现时须逐个复核；lore 工具禁用需实现层确认 ReadPolicy 钩子语义；未运行任何测试（纯文档产出）。**

### B1 · 临时读取授权核心（AI2；依赖 B0）

- [x] 在 `internal/libraryruntime/` 与必要的 app/agent 适配实现运行身份绑定、固定版本、manual 集合、auto 目录受控读取与累计预算；禁用、跨库、任意路径、过期版本均拒绝。
- [x] 单测/集成测试证明背景正文只进入当次模型输入，不落库、World、Session、压缩摘要、工具持久记录；完成/取消清理幂等，错误不能伪装为 active 或静默 bare。**完成记录：2026-09-24 07:32（Asia/Shanghai，AI2）。代码提交 `eab8f5792f69013ddafdf402c63bb1c97142f03c`（本地 main，未推送；同期间并行 laya 提交 `1f0763e`/`b708cde`/`532f706` 在其下，无文件交集）。实现：`internal/libraryruntime` per-run 授权核心（Bind/AssembleInitial/ReadOnDemand/Complete/Cancel/Status）——服务端派生身份（consumer=`writing|game|narraverse|module4`+scopeKey，伪造→`consumer_not_trusted`）；固定 revision（绑定与每次装配/读取都重核，漂移→`stale`，不交付旧授权下的新正文，也不把新版本当原版本）；manual 集逐项校验（存在/启用/manual 档，禁用/未知/跨库/其他档→`selection_invalid`）；auto 目录受控按需读取（仅启用 auto 或已授权 manual；resident/禁用/未授权/未知→`denied`；reference 经受控 Resolver 核对固定来源版本，locator 一律不是许可）；累计预算单计数器（基线+预留输出+初始装配+每次按需读取，重复读取照计，超限→`budget_exceeded`）；complete/cancel 幂等（首终态生效，终态后读取显式 `released`）。初始装配经 `librarycontext.Build`（L2 口径）包冻结只读抬头，以 `EphemeralLibraryContext` 返回当次模型输入；Run 不保留正文。app 适配 `BindWorkLibraryRuntime`（provider=GetWorkLibrary；Master resolver 与 L2 预览共用 `libraryMasterResolver`，自 `library_context_service.go` 抽出、行为不变）。测试：`go test ./internal/libraryruntime/ -count=1` 14 用例全过（含真实 Store 集成：全生命周期库文件逐字节零写入、跨库同名条目 ID 不串库、revision 漂移显式 stale、幂等清理、同输入同字节）；`go test ./internal/app/ -run "TestLibraryPreview|TestBindWorkLibraryRuntime" -count=1` 4 用例过（真实 App+Master 全链零写入、禁止字段不跨界、绑定期阻断错误码）；`go vet` 两包干净；`library`/`librarycontext` 依赖包测试过。未验证边界：① B1 只做核心+最小 app 适配，未接线任何模式，transport/agent 装配/前端入口是 B2a/B3a/B4；② “不落 Session/压缩/ledger/工具持久记录”在 B1 以核心不可达+零写入证明（Run 无正文、无持久化导入、库/Master 文件逐字节不变），agent 消息装配与落盘扫描证据按 B2a/B2c 各自条目产出；③ 默认预算常量（512KB/32k tokens/预留 8k/目录 50）为 L3.0 配置项，接线时按模式复核；④ 未跑 `internal/skills`（既有 Windows symlink 权限环境失败，非本任务，不写成通过）。修复轮（2026-09-24 07:56，Asia/Shanghai，分支 `library-b2a` 工作树 `D:\Narraverse2.0-b2a` 自 `2b1bad1` 接手，提交 `6b5c996`）：评审定位三处预算口径缺陷，按“失败回归测试先行”各补一条失败测试后最小修复——① 初始装配计费漏冻结抬头（`read.go` 原只量 JSON，现按完整交付文本=抬头+JSON 计费，与 `EphemeralLibraryContext.EstimatedTokens()` 同口径）；② 预留输出零值 Config 静默得 0（违背同结构体“零值→默认”约定与 §8.3 计数器覆盖预留输出，现零/负→默认 8000，显式越界 ≥ 累计 token 上限在绑定期显式 `invalid_request`，不再静默改写成误导性 `budget_exceeded`）；③ 运行中无外部成本计入通道（§8.3 单计数器须覆盖历史逐轮增长，新增 `Run.ChargeExternal(bytes, tokens)`：超限 `budget_exceeded` 不部分计入、负数 `invalid_request`、终态后 `released`）。验证：`go test ./internal/libraryruntime/ -count=1` 17 用例全过（14 旧 + 3 新回归）、`go test ./internal/app/ -run "TestLibraryPreview|TestBindWorkLibraryRuntime" -count=1` 4 用例过、`go vet` 两包干净、`library`/`librarycontext` 依赖包测试过。本修复轮在分支完成，主线清单记录待 AI1 合并后同步核对。**

### B2a · 写作后端接线（AI2；依赖 B1）

- [x] 在任务启动前解析并绑定库；首发、分析交接、取消与重连沿用真实 task/session 归属，拒绝冲突背景字段。
- [x] 用真实消息装配及落盘扫描证明只含获准内容、旧 Lore 不叠加、Session/压缩/日志无库正文；提交可供 UI 对接的受控契约。**完成记录：2026-09-24 08:35（Asia/Shanghai，AI2，分支 `library-b2a` 工作树 `D:\Narraverse2.0-b2a`，自 `2b1bad1`+B1 修复轮接手）。代码提交 `c363056304f145a4951872e5973d5f67ea0bfc82`（本地分支，未推送；未触碰主工作树与他人未提交修改，未动 8080）。① transport：`world_context_transport.go` 冻结顶层 `background_source`（legacy|library|none，null/空串=缺省结构推断）+内层 `library_context{libraryId,expectedRevision,manualItemIds[]}`（camelCase，与 L2 preview DTO 一致）；与 world_context/analysis_handle 同现→400 `background_source_conflict` 不吞并；声明一致性/越权键（前缀 `library_context.`）/空 ID/空条目/非法值→400 `invalid_request`；`PolicyContextAnalysis`+library（显式或推断）→400（库预览只走 L2 preview 端点）。② 绑定（bind-before-start，`internal/app/library_writing.go`）：scopeKey=`task:<taskID>` 服务端派生；Bind 零值 Config→默认预算、Baseline=0；`AssembleInitial` 计初始装配（含冻结抬头）；系统提示+逐轮历史在模型送入前经 `Run.ChargeExternal` 计入同一累计计数器（chat.go 装配点，`budget_exceeded` 显式终止运行）；绑定期失败→HTTP：invalid_request/selection_invalid→400、consumer_not_trusted→403、revision_conflict→409、library_unavailable→503、budget_exceeded→413；任务取消/中止走 `releaseWritingLibraryRun(aborted)`（defer），complete/cancel 幂等；运行中库漂移沿用 B1 显式 `stale`。③ agent 装配与通道关闭（§8.6 2/3 有实现修正，见 L3 计划 §8.8）：`EphemeralLibraryContextInput` 头部前置；`BuildWithLibraryBackground` 挂 `read_library_item`（持有本次 Run，错误码稳定透传）且**不挂任何 lore 工具**（实现为新工厂 `ideToolsFactoryWithLibrary` 而非 B0 猜测的 ReadPolicy 钩子）；系统提示 lore 指引实际位于 `prompts/system.go` systemInstructionBody（B0 锚点 `internal/agent/system_prompt.go:132-147` 已漂移），经 `LibraryBackground=true`+`loreToLibraryGuidancePairs` 7 对替换表整段替换为 read_library_item 指引，prompts/agent 双端测试守护替换表与 body 逐字节同步。④ 持久化隔离四通道全关+落盘证据：ephemeral 只进当次 ModelInputMessages（PrependTo 不改 history 切片）；`retainToolContextAcrossTurns` 对 read_library_item=false（不进 Session 上下文）；`logToolResult` 库工具短路只记 bytes；chat.go tool_result 事件 data 为唯一脱敏点（SSE/display 存档/run ledger 共用：content=`[library-item-read] <name>`，meta 仅 itemId/name/type/loadMode/sourceRevision/bytes，失败为 errorCode+有界消息、eino 包装下码仍稳定）；model_input_log 过滤库背景头部；压缩：库背景进 compact[0]（与 world 同构），摘要源无库正文。⑤ 状态事件：`library_context_state`→`data-library-context-state`，首个模型 chunk 前下发，只含 state/libraryName/revisionLabel(64 有界)/selectedCount，禁发 runContextId/scopeKey/fingerprint/libraryId/expectedRevision/manualItemIds/body/catalog。⑥ run ledger 增记 `library_id`/`library_revision`（bounded 256B）。⑦ B2b 边界：interactive+library→400“interactive 尚未支持 library 背景”。验证（`D:\Narraverse2.0-b2a\denova-src`）：`go build ./...` 过；`go vet` agent/prompts/handlers/agentui/app/libraryruntime 六包干净；`go test ./internal/prompts/ ./internal/api/agentui/ ./internal/libraryruntime/ -count=1` 全过；`go test ./internal/api/handlers/ -count=1` 全过；`go test ./internal/app/ -count=1` 仅既有 Windows symlink 环境失败（TestActiveAutomationReservation…，主工作树同败，与本轮无关）；`go test ./internal/agent/ -count=1` 仅既有 symlink 环境失败（TestToolExecutionGateCanonicalizesWorkspaceSymlink，同上）；B2a 定向用例（agent 9 项、handlers 6 项、agentui 1 项、app 4 项、prompts 守护 1 项）全绿；真实链路测试用真实 Store/App 文件逐字节零写入断言。未验证边界：① 未做真实模型生成闭环与隔离 executable 验收（B2c 范围，模型凭据不可用保持未完成）；② 前端 UI 未接线（B2b 范围，受控契约已冻结于 L3 计划 §8.8）；③ Director lore-context.md（§8.6 通道 4）属游戏链，B3a 范围；④ 库文件落盘扫描覆盖 `libraries/library-<id>.json` 逐字节零写入，Session/压缩/display 存档的运行时落盘文件扫描在 B2c executable 验收中复核；⑤ 默认预算常量按 B1 约定，未按模式复核。**

### B2b · 写作入口与状态（AI3；依赖 B0，按 B2a 已冻结契约开发）

- [ ] 用户显式选择库、进入写作且切书成功后才消费交接；挂载后新增交接仍可被消费，取消后原状态保留；active/degraded/none 与服务端一致。
- [ ] 定向组件测试含挂载后交接和失败状态，真实页面不发送自由 consumer/运行 ID。**完成记录：待填。**

### B2c · 写作正式闭环（AI1；依赖 B2a、B2b）

- [ ] 隔离 executable 完成带库写作真实模型生成、重启/取消、预览与真实输入一致性；检查原库、书、Session、压缩与 run ledger 无额外正文写入。模型凭据不可用时保持未完成。**完成记录：待填。**

### B3a · 游戏后端接线（AI2；依赖 B1、B2a 契约）

- [ ] 新回合绑定自己的 InteractiveRun，Task 仍是执行尝试；regenerate/reconnect 复用原运行背景，不依赖客户端重发库 Ref；冲突/来源失败明确返回。**完成记录：待填。**

### B3b · 游戏入口与状态（AI3；依赖 B3a 契约）

- [ ] 游戏入口仅在选择故事/分支成功后消费交接；切故事/分支清旧交接，服务端状态真实可见；补定向时序和失败测试。**完成记录：待填。**

### B3c · 游戏正式闭环（AI1；依赖 B3a、B3b）

- [ ] 隔离正式游戏页面验证真实模型取材、regenerate/切分支/来源故障；检查已保存 Turn、Session 与冒险数据无设定正文副本。**完成记录：待填。**

### B4a · 叙界受控接入（AI2 后端、AI3 页面，AI1 集成；依赖 B0、B1、B3c）

- [ ] 沿用既有宿主受控入口绑定新库，iframe 首次请求等待绑定；不下发运行秘密，不改 iframe 信任根或 Module3 引擎；正式页面验证实际取材。**完成记录：待填。**

### B4b · Module4 受控接入（AI2 后端、AI3 页面，AI1 集成；依赖 B0、B1、B3c）

- [ ] 沿用同一受控边界，不改 Adventure 规则、存档真源或模型 Settings；正式页面验证动作成败与背景读取状态独立、切实例不串库。**完成记录：待填。**

### B5 · 四模式统一验收与交付（AI1；依赖 B2c、B3c、B4a、B4b）

- [ ] 先审代码再在隔离 Denova executable/测试库跑写作→游戏→叙界→Module4；确认四个入口都**真正把获准内容送到现有模型链**，无暗中旧背景叠加、无剧情回写 Library、来源变更能阻断新读取。
- [ ] 测试取消/重连/regenerate/切实例/预算/来源故障；对 Session、工具结果、压缩源、run ledger、运行目录做脱敏扫描。分类记录缺口和环境失败，不以 UI 徽章或 HTTP 200 当送模证据。
- [ ] 产出 L3 验收报告、精确提交 SHA 与部署状态。**完成记录：待填。**

**检查点 B 通过条件**：四模式分别有正式页面、服务端取材和真实模型输入证据，用户数据与运行态边界经测试；只有 L3 全部完成才称“新库已接四模式”。

## 5. 检查点 C：L4 安全迁移旧资料

### C1 · 只读映射和盘点（AI2；B0 后可在独立分支与 L3 并行）

- [ ] 在 `internal/librarymigration/` 用虚构 World/Lore fixtures 实现纯映射：稳定 ID、共享/world scope binding、旧时间线八态、重名、未解析来源、冲突/遗漏完整可见；不猜测用户意图，不写文件。
- [ ] 纯函数测试输入逐字节不变；映射设计与 L1 数据契约冲突时先记录并复核，不改旧 World/Lore 持久结构。**完成记录：待填。**

### C2a · dry-run 受控读取与 DTO（AI2；依赖 C1）

- [ ] 仅从受控、明确选择的旧资料读取，返回目标库预览、ID 映射、版本、冲突、忽略项、计划指纹和预计大小；拒绝任意路径/损坏输入，测试预览前后文件哈希一致。**完成记录：待填。**

### C2b · dry-run 页面与隔离验收（AI3 页面、AI1 验收；依赖 C2a 契约）

- [ ] 页面显示每项去向与人工处理项；隔离 executable 用虚构副本验收零写入、刷新和失败提示。**完成记录：待填。**

### C3 · 用户选择与写入授权门（AI1；依赖 C2b、B5）

- [ ] 向用户呈现**具体旧资料集合、dry-run、备份与回滚位置/影响**并取得明确确认；未确认时只能保留 dry-run，**不可对真实用户资料 apply**。资料在确认后改变，必须重新生成预览和指纹。
- [ ] 记录确认范围与版本（不记正文/密钥）；若用户选择暂缓迁移，标“待用户选择”，保持本项及后续项 `[ ]`，不能伪称整个 L4 完成。**完成记录：待填。**

### C4a · 备份、原子 apply 与幂等（AI2；依赖 C3）

- [ ] 精确来源备份并校验可读/哈希，单源→单新库原子写入；相同指纹重放不重复建库；源文件保持原样。先在虚构副本做故障注入。**完成记录：待填。**

### C4b · 回执、恢复和回滚保护（AI2 实现、AI1 复核；依赖 C4a）

- [ ] 崩溃/并发/CAS 冲突后可用回执与真实文件恢复；目标库被用户再次编辑后，回滚不得覆盖其修改。虚构副本测试通过后才在 C3 允许范围内 apply。**完成记录：待填。**

### C5 · L4 验收和产品交接（AI1；依赖 C4b）

- [ ] 逐项核对库条目/关系/事件/来源、L2 可读性、L3 目标模式取材、旧资料仍可恢复；记录遗漏与用户确认结果。
- [ ] “旧入口是否退役”单独交用户决定；不以迁移完成自动删除旧文件、旧菜单或冒险实例。更新文档、协作日志及提交状态。**完成记录：待填。**

**检查点 C 通过条件**：用户明确选定的来源在备份可恢复、原件未丢、目标库可读、重复执行无重复库的条件下迁移成功。用户未授权真实资料时，只可宣布 dry-run 完成。

## 6. 本工作流的终点

- [ ] A/B/C 各自满足检查点，所有已领取任务在主线有 SHA 与实际验证记录；外部依赖或用户未授权项明确保持未完成。
- [ ] 最终报告清楚写出：当前运行的版本/URL、L1/L2 提交与部署状态、四模式实际取材状态、旧资料迁移范围、保留的旧系统、未解决问题与下一步。
- [ ] `git status` 中与本工作流有关的未提交文件、产物和用户数据有明确归属；只清理由本工作流产生且已核对可丢的临时产物，不清理其他 AI 或用户文件。

**不在本工作流自动开展**：自动拆书、Obsidian/图谱写回、全局 Canon、世界模拟、多库自动合并、自动删除旧 World/Lore、重做 Module3/Module4、第二套模型配置或代理。新想法另立范围与验收。
