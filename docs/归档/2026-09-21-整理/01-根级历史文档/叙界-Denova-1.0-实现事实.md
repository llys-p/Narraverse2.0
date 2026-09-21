# Narraverse / Denova 1.0 Implementation Facts

> 事实核验底稿，不是产品愿景或重新设计方案。
>
> 核验日期：2026-08-30
>
> 状态：正式基线（已冻结）
>
> 核验范围：当前 `<project-root>` 生产源码、已部署运行版记录、`代码指南.md` 与 `项目协作日志.md`。文档与源码冲突时，以源码为准。

## 状态标记

- **CURRENT**：当前生产源码中存在，并有部署或运行记录。
- **PARTIAL**：已有实现，但能力只覆盖一部分场景，或关键证据仍由现有数据推导。
- **LEGACY**：仍可用或仍保留，但不是当前推荐主流程。
- **NOT IMPLEMENTED**：设计或历史文档讨论过，当前代码没有实现。

## 1. 当前生产架构

| 能力 | 状态 | 当前事实 |
|---|---|---|
| Narraverse | CURRENT | 原始互动故事前端，源码主要在 `app/`；通过宿主桥接与 Denova 互通故事、素材和章节。 |
| Denova | CURRENT | 运行宿主和后端服务；源码在 `denova-src/`，当前运行版在 `denova/`，前端是 React/Vite。 |
| Master Library | CURRENT | 独立的文件型总库工作区，默认位于与当前 Adventure 相邻的 `narraverse-master-library` 工程；权威索引是 `.narraverse/master-library-manifest.json`。 |
| Translation / 8097 | CURRENT | 8097 提供持久化、串行的翻译任务队列和翻译执行桥；Master 通过 HTTP 读取运行态并提交字段翻译任务。 |
| Agent | CURRENT / PARTIAL | Agent Runner 使用现有 Tool Agent 体系；Master Agent 是受限的单资产、单字段 Agent，Config Manager Agent 另有总库读取和 Proposal 能力。 |
| Adventure | CURRENT | 当前故事工作区保存 Adventure Lore 和实例化结果；它不是 Master 内容的权威来源。 |
| Web UI | CURRENT | Denova 工作台通过 `ModeRouter` 打开独立“总资料库”页面；使用既有页面壳和自适应右侧面板。 |

真实关系是：原件先归档到 Master，Master 保存规范化字段、翻译版本和处理状态；只有用户明确“加入当前冒险”时，Master 才投影为当前 Adventure 的 Lore。Master 后续版本不会自动同步覆盖已经生成的 Adventure 内容。

## 2. 当前数据模型

以下对象均在当前代码中有对应结构或持久化记录：

| 对象 | 状态 | 当前实现 |
|---|---|---|
| Source | CURRENT | `MasterSourceRecord`，保存来源 ID、文件名、来源类型、当前 revision 和 revision 列表。 |
| Source Revision | CURRENT | `MasterSourceRevision`，保存 `revision`、SHA-256、字节数、原件归档路径、导入时间和父 revision。 |
| Master Asset / Item | CURRENT | `MasterItem`，保存 `master_item_id`、来源定位、资产类型、语义类型、原件结构、来源语义、运行语义、字段和活动工作版本。 |
| Master Field | CURRENT | `MasterField`，保存原文、原文 SHA、风险、是否必需、是否需要翻译、活动内容、活动类型和活动 Translation Version ID。 |
| Nested Entry | CURRENT | `MasterNestedEntry`，嵌在父 Master Item 的 `nested_entries` 中，保存稳定 Entry ID、原始数据、来源语义和运行语义。 |
| Translation Version | CURRENT | `MasterTranslationVersion` 独立保存翻译版本、字段路径、来源 revision/SHA、译文、译文 SHA、模型、任务 ID、确认状态和版本 revision。 |
| Translation Target | CURRENT | `MasterTranslationTarget` 保存在导入事务中，描述字段、模式、应用策略、必需性和当前状态。 |
| Import Transaction | CURRENT | `MasterImportTransaction` 保存导入 ID、来源、Master Item IDs、实例 ID 预分配、目标 Lore、翻译目标、状态和时间。 |
| Pipeline Status | CURRENT / PARTIAL | `GetAssetPipeline()` 返回只读聚合视图；不是新的持久状态真源。parse、normalize、check 部分使用现有数据推导。 |
| Issue | PARTIAL | `MasterPipelineIssue` 是 Pipeline 查询时生成的问题摘要，不是单独的持久 Issue 表或 Issue 实体存储。 |
| Proposal / Patch | CURRENT | `MasterProposal` 和 `MasterProposalPatch` 是字段级、持久化的候选修改记录。 |
| Recovery Claim | CURRENT | `MasterRecoveryClaim` 持久化恢复幂等键、目标字段、输入 revision/SHA、队列任务、Agent task、Proposal 和恢复状态。 |
| Adventure Instance | CURRENT | `MasterInstanceRef` 保存 Master 到 Adventure 的实例关系、目标 Lore、嵌套 Entry 到 Lore 的映射和载入 revision。 |
| Usage | PARTIAL | 没有独立 Usage 对象；usage 数量和列表由 `MasterInstanceRef` 过滤得到。 |

Master manifest 只作为索引，正文、来源、翻译版本、导入事务、Proposal 和 Recovery Claim 分文件保存。活动 manifest 同时包含 active 与 legacy/tombstone 范围的索引字段。

## 3. 当前 Master 资产粒度

| 能力 | 状态 | 当前事实 |
|---|---|---|
| 角色卡顶层粒度 | CURRENT | `buildMasterItemInputs()` 对一张角色卡只生成一个 `character_template` Master Asset。 |
| 独立 Lorebook 顶层粒度 | CURRENT | 对一个独立 Lorebook 只生成一个 `lorebook_template` Master Asset。 |
| 内嵌 Worldbook/Lorebook Entry | CURRENT | 不再作为活动列表中的独立 Master Asset；保存于父资产 `nested_entries`。 |
| Entry 稳定身份 | CURRENT / PARTIAL | 当前 `masterNestedEntryID()` 生成 `entry-<hash>`。优先使用原 Entry 的来源记录身份；缺少身份时使用 comment、keys、secondary keys、group 等身份字段生成哈希。源码不使用数组位置。完全没有身份字段时当前实现仍走可重复的生成哈希，不是首次 UUID 方案。 |
| 稳定字段路径 | CURRENT | 角色卡使用 `character_book.entries/<entry_id>/<field>`；独立 Lorebook 使用 `lorebook.entries/<entry_id>/<field>`。支持 `comment`、`content`、`keys`、`secondary_keys`。 |
| 顶层名称翻译 | CURRENT | `character.name` 和 `lorebook.name` 是必需字段，翻译目标模式为 `name_zh`；活动中文名优先显示，未完成时显示“待翻译 · 原名称”。 |
| 内部 Entry 名称/内容 | CURRENT / PARTIAL | Entry 字段可以独立进入翻译、CAS、Recovery 和实例化；内部字段默认 optional，局部失败通常只产生 warning，不阻止父资产 usable。高风险内容仍受风险规则限制。 |
| 旧 Entry 构造器 | LEGACY | `masterLoreEntryInput()` 和 `worldbook_entry` record kind 仍为旧数据/迁移测试提供兼容能力；活动查询会过滤 `worldbook_entry`。 |

## 4. 当前完整导入流程

### 4.1 Master 推荐导入

1. 前端 `MasterImportDialog` 选择 `.json` 或 `.png`。
2. `/api/workspace/import-material/preview` 调用 `PreviewMaterial()`，识别 `character_card` 或 `lorebook`，解析名称、条目数、截断标记和警告，不写数据。
3. 用户确认后，`POST /api/library/import-material` 调用 `ImportMaterialToMaster()`。
4. `buildMasterItemInputs()` 调用角色卡/Lorebook 解析器，并保证一份文件只生成一个顶层输入。
5. `MasterLibraryStore.Ingest()`：
   - 归档 Source 和 Source Revision；
   - 生成稳定 `master_item_id`；
   - 生成父资产的 fields 和 nested entries；
   - 为需要翻译的字段生成 `MasterTranslationTarget`；
   - 写入 Master Item、Import Transaction 和 manifest 索引。
6. `MasterImportDialog` 调用 `enqueueMasterTranslationTargets()`，把目标提交给 8097。
7. Master-only 入口在 `options.MasterOnly` 下返回，不调用 Adventure 投影；API 结果的 `item_ids` 保持空数组，Master IDs 单独放在 `master_item_ids`。
8. 所有必需字段完成后，Master 的 `availability` 由 Pipeline 推导为 `usable`；尚未完成则是 `staging`。

### 4.2 Adventure 内普通素材导入

| 能力 | 状态 | 当前事实 |
|---|---|---|
| `master_managed` | CURRENT | `/api/workspace/import-material` 默认使用 Master 管理；必需翻译完成后可以调用 `FinalizeMasterImport()` 投影到当前 Adventure。 |
| `unmanaged_direct` | LEGACY | 高级/临时路径仍可直接生成 Adventure Lore，绕过 Master 管理；不是推荐主流程。 |
| 截断文件保护 | CURRENT | 预览发现截断标记时，必须显式接受不完整导入。 |
| Master-only 与 Adventure 隔离 | CURRENT | `/api/library/import-material` 只执行 Source/Master/Translation Target/Pipeline；`/api/library/assets/:id/instances` 才创建 Adventure Instance。 |

`FinalizeMasterImport()` 当前实际负责 Adventure 投影收尾和幂等写入；它不是 Master-only 导入的必经步骤。必需字段完成后，翻译回写 handler 只在 `TransactionTargetsAdventure()` 为真时触发该投影。

## 5. 当前翻译流程

| 部分 | 状态 | 当前事实 |
|---|---|---|
| HY-MT / 8097 全量初译 | CURRENT | 导入返回字段级目标，前端使用 `enqueueMasterTranslationTargets()` 创建 8097 任务；安全字段使用 `master_auto`，高风险字段使用 `master_review`。 |
| Field Path | CURRENT | Master 任务使用稳定字段路径；角色卡 openings 仍使用 dotted/indexed 路径，嵌套 Entry 使用稳定 ID 的 slash 路径。 |
| 顶层名称模式 | CURRENT | 以 `.name` 结尾或等于 `character.name` 的目标使用 `name_zh`；其余使用 `faithful_zh`。 |
| Master Translation Version | CURRENT | 由 `ApplyTranslation()` 独立写入；写入前检查 import、Master Item、字段存在性、source SHA、输入 revision 和 base translation version。 |
| 活动内容版本 | CURRENT | 查询层按版本模型和确认状态映射为 `hy_mt_active`、`polish_candidate`、`polished_active` 等内容类型；任务状态和内容版本类型分开。 |
| 8097 Runtime 聚合 | CURRENT | `GetAssetRuntime()` 读取 `http://127.0.0.1:8097/api/denova/translator/jobs`，按 `master_item_id + field_path` 与 Master 字段/版本合并；不把队列状态写回 Master。 |
| 字段级后台状态 | CURRENT | 聚合保留 `task_status`、`content_version_status`、`translation_version`、`failure_reason`、`review_required`、`input_revision`、`source_sha256`、`task_id`、`model`、`attempts` 和 `recovery_status`。 |
| 重试 | CURRENT | UI 通过现有 `retryTranslationJob()` 调用 8097 的 `/jobs/:id/retry`；没有另建 Master 重试队列。 |
| Polish Candidate | CURRENT / PARTIAL | 主动润色走 `polish` Proposal；未确认时作为 candidate，不替换 active；确认后才生成并激活新的版本。 |
| 8097 终态协议 | PARTIAL | 当前只能根据 `status`、`attempts`、`updated_at` 等已有字段推断部分终态；没有可靠的 `terminal_failure`、`retry_exhausted` 或 `max_retries` 长期协议。 |

## 6. 当前 Agent 系统

### 6.1 Agent 类型和模型

| 能力 | 状态 | 当前事实 |
|---|---|---|
| Master Agent kind | CURRENT | 使用 `config.AgentKindToolAgent`，调用 `StartMasterAgentTask()`，复用现有 Runner/Task/SSE 生命周期。 |
| 模型解析 | CURRENT | `ResolveAgentModel()` 按统一 `model_profiles` 和 `agent_models` 配置解析；Master Agent 不硬编码模型。当前工作区配置中 `agent_models.tool_agent.profile_id = qwen25-local`。 |
| 当前本地 profile | CURRENT | `qwen25-local` 指向本地 OpenAI-compatible Ollama endpoint；实际模型为 `qwen2.5:7b`。本文不记录 API key。 |
| Config Manager Agent | CURRENT / PARTIAL | 复用全局 `ConfigManagerChat`；总库上下文固定为 `origin=master-library` 和当前 `master_item_id`，可读取总库资产、原件和字段，并创建/校验 Proposal。 |
| 总库 Skill | CURRENT | `skills/master-library/SKILL.md` 由资源 Skill 加载逻辑在总库上下文或相关指令下提供读取顺序、原件核对、稳定路径和安全边界。 |

### 6.2 Master Agent 工具与权限

`newMasterAgentTools()` 当前提供受作用域限制的八个工具：

- `get_master_asset`
- `get_master_field`
- `get_master_pipeline_status`
- `get_master_translation_status`
- `get_master_issue`
- `create_master_proposal`
- `validate_master_patch`
- `apply_master_patch`

权限事实：

- **CURRENT**：Master Agent 只能处理启动任务指定的一个 `master_item_id + field_path`。
- **CURRENT**：不开放普通文件系统写入、Shell、普通 Lore 写入、联网、Skill 管理或 Agent 配置写入。
- **CURRENT**：Master 写入必须经过 Proposal、字段范围校验、CAS、变量/链接/数字保护和风险判断。
- **CURRENT**：Config Manager Agent 不暴露 `apply_master_patch`；它创建/校验 Proposal，用户在 UI 中查看差异并应用。
- **CURRENT**：`create_master_proposal`、`validate_master_patch`、`apply_master_patch` 已从普通 `file_write` 能力分类中单独识别，不需要打开通用 `file_write`。

### 6.3 Proposal、CAS 与风险

`MasterProposal` 保存：目标资产、字段路径、原文、当前译文、候选译文、输入 revision、source SHA、基础 Translation Version、风险、问题代码、来源 Agent/Recovery 和应用版本。

- **CURRENT**：Proposal 状态包括 `proposed`、`validated`、`candidate_ready`、`applied`、`conflict`、`rejected`。
- **CURRENT**：Validate/Apply 都会检查 `master_item_id`、`field_path`、`input_revision`、`source_sha256`、`base_translation_version`。
- **CURRENT**：CAS 冲突时不会覆盖新数据，Proposal 标记为 conflict。
- **CURRENT**：低风险 Recovery 可以自动应用；主动 polish 不允许 auto apply。
- **CURRENT**：高风险字段不能由自动 Recovery 应用；用户确认路径仍受字段范围和候选内容保护。
- **CURRENT**：候选 Translation Version 在用户确认前不会替换 active 内容。

## 7. 当前 Recovery

当前实际链路为：

```text
8097 failed
→ Master Runtime 聚合
→ failed 稳定超过临时窗口
→ Recovery Claim
→ 受限 Master Agent
→ 唯一 Recovery Proposal
→ Validate / CAS
→ 低风险 Apply
→ 新 Translation Version
→ Pipeline 复核
→ recovered
```

| 能力 | 状态 | 当前事实 |
|---|---|---|
| Recovery Orchestrator | CURRENT | `App.StartMasterRecoveryOrchestrator()` 以后台 watcher 运行，Runtime/Pipeline GET 不产生副作用。 |
| Claim 幂等 | CURRENT | key 是 `master_item_id + field_path + input_revision + source_sha256` 的哈希；相同失败版本只创建一个 claim，重启后可继续读取。 |
| 当前终态判断 | PARTIAL | `masterFinalFailure()` 使用 `status=failed`、`attempts>=1`、队列未暂停、`updated_at` 距现在至少 5 秒。它是 8097 缺少终态字段时的临时兼容逻辑。 |
| 自动恢复边界 | CURRENT | 只对低风险字段尝试自动 Proposal/Validate/Apply；高风险、无唯一 Proposal、CAS 冲突、复核失败等进入 `needs_user`。 |
| 用户态错误隐藏 | CURRENT | 普通 UI 显示“Denova 正在处理 / 已完成 / 需要你处理”等产品化状态；底层 failure reason、任务 ID、attempts 等保留在 Runtime/Claim/日志和折叠诊断中。 |
| 真实成功 E2E | CURRENT | 已记录 qwen25-local/Ollama 实际完成一次低风险 Recovery：Proposal、Validate、CAS、Apply、新版本激活、Pipeline recovered。 |
| 真实 needs_user 回归 | CURRENT / PARTIAL | 高风险场景已验证不会 Apply 并进入 needs_user；现有记录中有一次因 Agent 未生成唯一 Proposal 进入 needs_user，不等同于“已生成候选后被风险规则拦截”的完整样例。 |

已确认的暂时缺口：5 秒窗口与 8097 自身 retry 之间没有长期协议级互斥证明；当前不修改 8097 核心队列。

## 8. Adventure Instance

```text
Master Asset
→ PrepareAssetInstantiation()
→ Adventure Import Transaction
→ FinalizeMasterImport()
→ Adventure Lore
```

- **CURRENT**：`POST /api/library/assets/:id/instances` 是从总库加入当前冒险的明确入口。
- **CURRENT**：角色卡实例化会生成 Character Lore，并把父资产内部 Worldbook Entry 展开为多个 Lore。
- **CURRENT**：独立 Lorebook 实例化按 `nested_entries` 展开多个 Lore。
- **CURRENT**：`MasterInstanceRef.nested_entry_lore_ids` 保存 `entry_id → adventure_lore_id` 映射；同时保存目标 Lore IDs、Adventure key 和载入 revision。
- **CURRENT**：重复加入同一 Master Asset 到同一 Adventure 使用幂等键和已有 usage 检查，不重复生成 Lore。
- **CURRENT**：旧 Adventure 中引用旧 `worldbook_entry` 的 Lore 保留，不因 Master 迁移删除或重新绑定。
- **CURRENT**：Master 新 revision 不会自动同步已经存在的 Adventure Instance。

## 9. 当前主要 API

### Master 与资料库

| 方法 | 路径 | 用途 | 状态 |
|---|---|---|---|
| GET | `/api/library/assets` | 列表、搜索、record kind、semantic type、availability、分页 | CURRENT |
| POST | `/api/library/import-material` | 只导入总库，不创建 Adventure Lore | CURRENT |
| GET | `/api/library/assets/:id` | 资产、Source、Source Revision、译文版本、usages | CURRENT |
| GET | `/api/library/assets/:id/pipeline` | Pipeline 只读状态 | CURRENT |
| GET | `/api/library/assets/:id/translations` | Translation Version 列表 | CURRENT |
| GET | `/api/library/assets/:id/usages` | Adventure 实例/usage 列表 | CURRENT |
| POST | `/api/library/assets/:id/instances` | 把 usable Master 加入当前 Adventure | CURRENT |
| GET | `/api/library/assets/:id/runtime` | Master + 8097 字段级实时聚合 | CURRENT |
| GET | `/api/library/assets/:id/proposals` | 读取 Proposal | CURRENT |
| POST | `/api/library/assets/:id/proposals` | 创建字段级 Proposal | CURRENT |
| POST | `/api/library/assets/:id/proposals/batch-apply` | 逐条应用用户选择的低风险 Proposal | CURRENT |
| POST | `/api/library/proposals/:id/validate` | Validate Proposal/CAS | CURRENT |
| POST | `/api/library/proposals/:id/apply` | 应用已验证 Proposal | CURRENT |
| POST | `/api/library/assets/:id/agent` | 启动指定字段的 Master Agent | CURRENT |
| GET | `/api/library/agent/tasks/:id/stream` | Master Agent 任务 SSE | CURRENT |

### Adventure 素材导入与翻译回写

| 方法 | 路径 | 用途 | 状态 |
|---|---|---|---|
| POST | `/api/workspace/import-material/preview` | Adventure 素材预览 | CURRENT |
| POST | `/api/workspace/import-material` | Adventure 内素材导入，默认 `master_managed` | CURRENT / LEGACY |
| POST | `/api/workspace/import-material/master/translation` | 回写一个 Master 字段 Translation Version | CURRENT |
| POST | `/api/workspace/import-material/master/finalize` | 对 Adventure-bound transaction 执行实例化收尾 | CURRENT |

8097 翻译队列的核心任务查询和控制路径包括 `/api/denova/translator/jobs`、`/jobs/:id/retry`、暂停/取消/删除/resolve 等；它们由前端 `local-translation.ts` 和后端 Master Runtime 读取。

## 10. 当前 UI

### 总资料库页面

| 能力 | 状态 | 当前显示/交互 |
|---|---|---|
| 独立入口 | CURRENT | `ModeRouter` 的 `library` 页面，复用 `FeaturePageShell`、`WorkbenchShell` 和既有自适应布局。 |
| 资产列表 | CURRENT | 以整张角色卡/整本设定书为卡片；显示中文名称、类型、简介、内部条目数、用户态、来源文件和 Adventure 使用数；支持搜索、筛选、分页。 |
| 资产详情 | CURRENT | 默认进入“内容”，另有“处理进度 / 版本 / 已加入冒险 / 技术信息”。 |
| 完整内容 | CURRENT | 角色卡按角色概览、性格背景、场景开场、示例对白、内部设定、高级指令分组；Lorebook 有稳定 Entry 目录、标题/关键词/正文搜索和单条阅读。 |
| 七节点 | CURRENT / PARTIAL | 显示原件、解析、规范化、翻译、检查、可用、加入冒险；前几节点的 `inferred/reason` 会标明是由现有数据推导。 |
| 翻译进度 | CURRENT | 默认显示“翻译中 x/y / 翻译完成 / 未完成”等用户态；字段诊断默认折叠。 |
| 版本 | CURRENT | 显示机器初译、润色候选、当前译文、历史版本、字段位置和更新时间；技术 ID/模型名主要在技术信息中。 |
| 总库导入 | CURRENT | “导入到总资料库”打开 `MasterImportDialog`，预览后只写 Master。 |
| 加入冒险 | CURRENT | 资产详情“加入当前冒险”按钮，以及 Adventure“加载资料”对话框的“总资料库”页签；只允许选择 usable 资产。 |
| 配置管理 Agent | CURRENT | 点击后右侧出现可调整宽度的 Agent 对话栏，范围固定到当前 Master Asset；可读取规范化内容和原件，并创建/校验受控 Proposal。 |
| 受控内容编辑 | CURRENT / PARTIAL | 角色卡常用字段、Lorebook Entry 标题/正文/关键词可编辑；先显示修改前后预览，再逐字段走 Proposal → Validate → CAS → Apply。高级系统指令/对话后指令仍只读或交给 Agent。 |
| Proposal 应用 | CURRENT | 支持单条应用和低风险批量应用；高风险不进入批量入口。 |
| needs_user | CURRENT | 以“需要你处理/确认”的产品化状态显示，不默认展示 timeout、HTTP、worker、CAS 等技术错误。 |

## 11. 当前重要配置

- **CURRENT**：配置系统支持多 `model_profiles` 和按 Agent 的 `agent_models.<agent>.profile_id`，Master Agent 使用 `tool_agent` 配置，不拥有第二套模型配置。
- **CURRENT**：当前工作区 `agent_models.tool_agent.profile_id` 为 `qwen25-local`。
- **CURRENT**：`qwen25-local` 的模型是 `qwen2.5:7b`，endpoint 是本机 Ollama 的 OpenAI-compatible 地址 `http://127.0.0.1:11434/v1`。
- **CURRENT**：Master Runtime 当前读取固定本机 8097 地址 `http://127.0.0.1:8097/api/denova/translator/jobs`。
- **CURRENT**：Go module 声明 Go `1.26.5`；当前 Codex 执行环境没有可直接调用的 `go`/`gofmt` 命令。
- **安全**：配置文件含 API key、远程访问凭据等敏感值；本事实底稿不复制这些值。

## 12. 当前测试与验证状态

| 验证项 | 状态 | 当前证据 |
|---|---|---|
| 资料库前端定向 Vitest | CURRENT | 最近记录为 `LibraryView` 6 项通过，覆盖列表/详情投影、队列重试、版本显示、共享 Config Manager、编辑预览/字段上下文、Lorebook 目录。 |
| i18n 检查 | CURRENT | 最近记录的资料库改动通过 i18n key 对齐检查。 |
| Vite/TypeScript 构建 | CURRENT | 最近记录通过，web dist 已部署到 `denova/web`。 |
| Master Go 定向测试 | CURRENT（以最近记录为准） | 最近 Go 工具链可用时已通过 Master 相关包、API handlers 等定向测试；本轮文档生成没有修改 Go。 |
| Go build | CURRENT（以最近记录为准） | 最近记录曾使用临时 Go 1.26.7 工具链完成 `go build ./...`；当前环境不具备 `go` 命令，因此本轮未重跑。 |
| 全量 Go test | PARTIAL | 历史记录仍有 Windows 符号链接、权限、路径格式等既有边缘失败；不能将其表述为全量全绿。 |
| Recovery 成功 E2E | CURRENT | 已有真实 8097 + Master Asset + qwen25-local/Ollama 记录，实际完成 Proposal → Validate/CAS → Apply → 新 Translation Version → recovered。 |
| Recovery claim 幂等 | CURRENT | 已有同一失败版本只启动一次、重启后 claim 保留的定向验证记录。 |
| CAS 冲突 | CURRENT | 已有输入 revision、source SHA、base translation version 变化时拒绝旧 Proposal 覆盖的测试/记录。 |
| Translation Version 生命周期 | CURRENT | 已验证旧版本保留；Recovery 生成新 active 版本；polish candidate 在确认前不替换 active。 |
| 高风险安全回归 | CURRENT / PARTIAL | 已验证高风险场景不自动 Apply 并进入 needs_user；完整“候选生成后由风险规则拦截”的真实样例仍未形成。 |
| 浏览器生产验收 | CURRENT | 记录中已验收总库列表、整卡详情、内部 Entry、七节点、翻译状态、右侧 Agent、实例化幂等和简化用户态。 |

## 13. 当前技术债

- **PARTIAL**：8097 没有正式 `terminal_failure`/`retry_exhausted`/`next_retry` 协议，Recovery 仍依赖 `failed + attempts >= 1 + 稳定 5 秒` 的临时判断。
- **PARTIAL**：5 秒等待窗口与 8097 自己即将 retry 的竞态没有协议级保证；当前没有重写 8097。
- **PARTIAL**：parse、normalize、check 没有独立快照或输出 revision，Pipeline 只能由 Master、Source、Translation、Issue 等现有数据推导并标记 `inferred`。
- **PARTIAL**：Pipeline、Issue、Usage 都不是完全独立的持久领域实体；它们主要是查询聚合或 instance ref 的投影。
- **LEGACY**：`unmanaged_direct` 和旧 `worldbook_entry` 兼容代码仍存在，增加了理解成本，但活动 Master 查询已排除旧子资产。
- **PARTIAL**：完整 `go test ./...` 仍受既有 Windows 文件系统边缘测试影响；当前环境也没有 Go 工具链可即时复验。
- **PARTIAL**：当前高风险真实回归证明了“不会越权 Apply”，但尚未覆盖所有“Agent 生成候选后被规则拦截”的路径。
- **PARTIAL**：总库列表仍使用有界线性扫描，没有独立持久搜索索引；当前实现明确以资产规模尚未造成性能问题为前提。

## 14. 明确 NOT IMPLEMENTED

以下能力在历史方案中讨论过，但当前生产代码不应被描述为已完成：

- **NOT IMPLEMENTED**：规范化 Agent、未知字段 Agent、独立检查 Agent、全库 Agent、批量 Agent。
- **NOT IMPLEMENTED**：对全资料默认执行 Agent 二次翻译；当前仍以 HY-MT 全量初译为主，Agent 只按字段处理或用户主动调用。
- **NOT IMPLEMENTED**：Master revision 自动同步已经创建的 Adventure Instance。
- **NOT IMPLEMENTED**：Entry 级总库选择器、批量跨资产实例化、选择性展开控制。
- **NOT IMPLEMENTED**：8097 正式 terminal failure/retry exhausted 协议及基于它的完整恢复调度。
- **NOT IMPLEMENTED**：字段级 stale 的进一步细分和按依赖图自动重跑。
- **NOT IMPLEMENTED**：历史 Translation Version 合并 UI、通用任意 JSON Patch 编辑器、Master 原文件直接写回。
- **NOT IMPLEMENTED**：完整的 Proposal/Recovery 审计工作台和复杂异常人工处理流；当前只有现有 Proposal、Runtime、Claim、折叠诊断和 needs_user 分流。

## 15. 核心代码地图

| 文件/目录 | 职责 | 关键入口 |
|---|---|---|
| `denova-src/internal/book/master_library.go` | Master manifest、Source、Item、Field、Translation Version、Import Transaction 的文件型存储和 CAS 翻译写回 | `MasterLibraryStore.Ingest`、`ApplyTranslation`、`PrepareAssetInstantiation` |
| `denova-src/internal/book/master_library_query.go` | Master 列表、详情、Pipeline、翻译状态和内容版本的只读聚合 | `ListAssets`、`GetAsset`、`GetAssetPipeline`、`deriveMasterPipeline` |
| `denova-src/internal/book/material_import.go` | 角色卡/Lorebook 预览、Master 输入构造、Master-only 导入和 Adventure 投影 | `PreviewMaterial`、`ImportMaterialToMaster`、`FinalizeMasterImport`、`buildMasterItemInputs` |
| `denova-src/internal/book/character_card.go` | Tavern/PNG/JSON 角色卡解析、规范化和运行时 Lore 操作 | 角色卡解析与 `buildTavernCardLoreOperations` |
| `denova-src/internal/book/master_runtime.go` | Master Translation Version 与 8097 队列的只读字段级聚合 | `GetAssetRuntime`、`buildMasterTranslationRuntime` |
| `denova-src/internal/book/master_agent.go` | Master Proposal、Validate、Apply、CAS、候选/活动版本规则 | `CreateMasterProposal`、`ValidateMasterProposal`、`ApplyMasterProposal` |
| `denova-src/internal/book/master_recovery.go` | Recovery Claim 的持久化、幂等键和状态更新 | `ClaimMasterRecovery`、`UpdateMasterRecoveryClaim` |
| `denova-src/internal/book/master_migration.go` | 旧 `worldbook_entry` 归档、父资产生成、翻译复制和 legacy mapping | `MigrateLegacyWorldbookEntries` |
| `denova-src/internal/app/master_agent.go` | 启动受限 Master Agent Task，复用 Tool Agent Runner | `StartMasterAgentTask` |
| `denova-src/internal/app/master_recovery.go` | 后台 Recovery Orchestrator 和 claim 收敛 | `StartMasterRecoveryOrchestrator`、`runMasterRecoveryTick` |
| `denova-src/internal/agent/master_agent_tools.go` | Master Agent 的八个受限工具和单字段作用域检查 | `newMasterAgentTools` |
| `denova-src/internal/agent/config_manager_master_tools.go` | Config Manager Agent 的总库列表、原件、字段读取和 Proposal 工具 | `newConfigManagerMasterTools` 相关构造逻辑 |
| `denova-src/internal/agent/tool_result_policy.go` | Tool 能力分类和 Master 受控工具与普通 file write 的隔离 | `ManifestForTool` 相关规则 |
| `denova-src/internal/app/config_manager_resource_skills.go` | 按资源上下文加载总库 Skill | Master-library Skill 选择逻辑 |
| `denova-src/internal/api/routes.go` | Master、素材导入和翻译回写路由注册 | `/api/library/*`、`/api/workspace/import-material*` |
| `denova-src/internal/api/handlers/handler_library.go` | 总库查询、导入、实例化、Runtime、Proposal 和 Agent handlers | `HandleLibrary*` |
| `denova-src/internal/api/handlers/handler_material.go` | 素材预览、Adventure 导入、Master 翻译回写和 finalize | `HandleWorkspace*Material` |
| `denova-src/web/src/features/library/LibraryView.tsx` | 总库列表、详情、内容阅读器、七节点、版本、Proposal、编辑和右侧 Agent UI | `LibraryView`、`LibraryDetail` |
| `denova-src/web/src/features/library/MasterImportDialog.tsx` | 总库文件预览、确认导入和翻译目标入队 | `MasterImportDialog` |
| `denova-src/web/src/features/interactive/components/setting-panel/MaterialImportDialog.tsx` | Adventure 内素材/总库资产选择、直接导入和加入当前冒险 | `MaterialImportDialog` |
| `denova-src/web/src/lib/api-client/master-library.ts` | Master API 客户端、类型和翻译目标入队 | `listMasterAssets`、`fetchMasterAsset*`、`create/apply` |
| `denova-src/web/src/lib/api-client/material-library.ts` | 素材预览、两种导入入口和翻译回写客户端 | `importMaterial`、`importMaterialToMaster` |
| `denova-src/web/src/lib/api-client/local-translation.ts` | 8097 队列查询、重试、暂停、取消和任务控制 | `getTranslationQueue`、`retryTranslationJob` |

## Documentation Drift

### `代码指南.md` 与当前代码的主要差异

1. **文档说法**：`代码指南.md` §1.6 将资料库页面描述为“只读界面”，并写明不承载导入、翻译、修复或写回操作。

   **当前代码**：`LibraryView.tsx` 已包含总库导入入口、字段重试、主动润色、Proposal 单条/批量应用、角色卡/Lorebook 常用字段编辑和右侧 Config Manager Agent 入口。

   **建议更新**：将 §1.6 改为“阅读优先、受控处理与编辑”，并明确普通 UI 与后端诊断的区别。

2. **文档说法**：部分早期阶段记录只描述四个只读查询 API。

   **当前代码**：路由已增加 Runtime、Proposal、Batch Apply、Master Agent 和实例化 API。

   **建议更新**：以本底稿第 9 节的实际路由为准，更新 `代码指南.md` 的 API 清单。

3. **文档说法**：早期记录将总库页面描述为不修改 Master 内容。

   **当前代码**：直接编辑和 Agent 修改已通过 Proposal → Validate → CAS → Apply 受控实现；不直接写原文件，也不直接写 Adventure。

   **建议更新**：保留“不能直接写入”的安全约束，但删除“完全没有写回能力”的旧表述。

### `项目协作日志.md`

截至本次核验，协作日志最近记录已经包含上述前端编辑、Agent 上下文和批量 Proposal 变化，整体与当前实现一致；其“最近测试通过”信息属于对应时间点的执行记录，不能替代本次环境中不存在 Go 工具链的即时复验。
