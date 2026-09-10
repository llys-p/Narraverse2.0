# World Workspace Phase 2B.2 Implementation Report

- 报告时间：2026-09-10（Asia/Shanghai）
- 设计冻结：`docs/plans/WORLD_WORKSPACE_PHASE2B2_IMPLEMENTATION_PLAN.md` v1.2
- 代码基线：`main` commit `c48b20e1063d8803639bbaed7557213db3a08d0b`（Phase 2B.1）
- 范围：仅「创建世界向导 AI 结构提案」；未实现 Timeline、既有世界合并、Agent、长期记忆、世界模拟、Canon、Module3/4 接入，未开始 2B.3。

---

## 1. 修改文件

### 后端（Go）

| 文件 | 变更 |
| --- | --- |
| `denova-src/internal/app/world_proposal.go` | 新增：World Proposal 领域服务（严格校验 + 重读 Master + 白名单 + 预算 + `App.GenerateModel(module=narraverse)` + 严格解析 + 增强）与领域类型/错误码 |
| `denova-src/internal/app/world_proposal_test.go` | 新增：严格解析/增强/白名单/预算/错误映射单测 |
| `denova-src/internal/api/handlers/handler_world_proposal.go` | 新增：`POST /api/world-proposals` handler + `decodeStrictJSON`（拒未知字段/尾随 JSON） |
| `denova-src/internal/api/routes.go` | 修改：注册 `POST /world-proposals` 路由（World Workspace 段） |

### 前端（React/TS）

| 文件 | 变更 |
| --- | --- |
| `web/src/features/world-workspace/types.ts` | 修改：新增 `StructureProposal` / `ModelStructureProposal` 无关类型、`ProposalChoices` / `WorldEditable*` / `WorldStructureAnalysisRequest` 等 |
| `web/src/features/world-workspace/world-api.ts` | 修改：新增 `analyzeWorldStructure()` → `POST /api/world-proposals` |
| `web/src/features/world-workspace/world-proposal.ts` | 新增：纯函数 `proposalToWorldCreateInput` + `bindingFromCandidate` |
| `web/src/features/world-workspace/components/AiStructureAnalyzer.tsx` | 新增：AI 分析步骤（选资料→选字段→片段→分析→Proposal 逐项确认 adopt/discard/编辑→应用） |
| `web/src/features/world-workspace/pages/WorldCreatePage.tsx` | 修改：步骤 3 增加「AI 分析资料」入口；新增 locations/factions 状态并进入创建入参；`applyProposal` 合并提案结果 |
| `web/src/features/world-workspace/__tests__/world-proposal.test.ts` | 新增：`proposalToWorldCreateInput` 确定性/实体绑定引用/去重/编辑字段单测 |
| `web/src/i18n/locales/zh-CN/worldWorkspace.ts` | 修改：+23 键（`aiAnalyzer.*`） |
| `web/src/i18n/locales/en-US/worldWorkspace.ts` | 修改：+23 键（`aiAnalyzer.*`） |

---

## 2. API 变化

新增受控端点（前端**不得**直调 `/api/model/chat`）：

```
POST /api/world-proposals
```

请求体（≤64 KiB，严格解码：拒绝未知字段与尾随 JSON）：

```json
{
  "sources": [{ "masterItemId": "…", "expectedMasterRevision": "sha256:…", "fieldPaths": ["character.name", "character.personality"] }],
  "snippets": [{ "snippetId": "…", "label": "可选", "text": "…" }]
}
```

响应（200）：`{ "proposal": { StructureProposal } }`（会话草稿，服务端不持久化）。

错误码（按 `ModelGatewayError.Code` 映射，而非其 `HTTPStatus()`）：

| 码 | HTTP | 含义 |
| --- | --- | --- |
| `invalid_request` | 400 | 字段不在白名单 / 未知字段 / 尾随 JSON / 请求体超限 |
| `source_not_found` | 404 | Master 资产不存在 |
| `source_unavailable` | 422 | 资产非 usable |
| `source_changed` | 409 | `expectedMasterRevision` 不一致 |
| `input_too_large` | 413 | 资产/字段/字符/token 超硬上限 |
| `not_configured` | 400 | 共享模型未配置 |
| `model_not_found` | 404 | 模型端点不存在（网关 `not_found` 映射） |
| `unauthorized` / `rate_limited` / `provider_unavailable` / `timeout` | 401 / 429 / 502 / 504 | 透传网关分类 |
| `invalid_model_output` | 422 | 空响应 / markdown / 未知字段 / 尾随 JSON / 多 JSON / 未知 sourceRef / 越界枚举 / timeline |

调用链：`World Proposal Service → App.GenerateModel(module=narraverse) → agent.GenerateOneShot`（无工具/无 Session/无 Task，120s 硬超时，一次请求一次调用）。

---

## 3. 测试结果

| 门禁 | 结果 |
| --- | --- |
| `go test ./internal/app ./internal/world ./internal/api/handlers -count=1` | 通过（`internal/app` 内新增 proposal 测试全过） |
| 已知环境失败 | `TestActiveAutomationReservationAtomicallyAttachesConcurrentCaller`（Windows 符号链接权限，仓库既有问题，与本轮无关；项目日志早有记录） |
| `go vet ./internal/app ./internal/api/handlers ./internal/world` | 通过 |
| `go build ./cmd/denova` | 通过 |
| `tsc --noEmit` | 通过 |
| `vitest run src/features/world-workspace` | 12 文件 / 99 测试通过 |
| `node scripts/check-i18n-keys.mjs` | 3761 键 zh/en 对齐 |
| `vite build`（隔离 outDir） | 通过（仅既有 >500kB chunk 提示） |
| `git diff --check` | 通过 |

新增后端单测覆盖：严格解析六类非法输入（空/markdown/未知字段/timeline/多 JSON/尾随）、增强盖章（proposalItemId/schemaVersion/generatedAt/sourceRefs）、未知 sourceRef/越界 confidence/非法 role/缺名/超限 → `invalid_model_output`、字段白名单、请求预算、`ModelGatewayError` → 领域错误码映射、semantic/scope 归一。

新增前端单测覆盖：`proposalToWorldCreateInput` 的 bindingCandidateId 与 bindingId 区分、master 信息来自服务端盖章、entity 作用域绑定必须有采纳实体引用（否则丢弃）、world 作用域零引用保留、setting/rules 采纳与文本编辑、settingOverride、edits 仅世界可编辑字段、base 字段透传。

---

## 4. 未解决问题 / 边界说明

1. **未跑真实模型 E2E**：本环境未配置真实可用模型，模型调用路径通过 `App.GenerateModel` 复用 + 严格解析/增强单测覆盖；建议在具备可用模型的环境做一次真实 executable 闭环验收。
2. **lorebook 嵌套条目字段选择**：后端白名单已支持 `lorebook.entries/<id>/{comment|content|keys|secondary_keys}`，但前端「AI 分析」UI 第一版仅暴露顶层 `lorebook.name/description` 与 `character.*` 字段，未提供嵌套条目逐项勾选 UI（计划 §2.3 的嵌套条目是可选路径）。不影响契约正确性。
3. **Timeline 按设计排除**：2B.2 第一版完全不支持 timeline；模型返回 timeline 字段即 `invalid_model_output`，禁止静默丢弃。
4. **失败降级**：模型未配置/超时/取消/429/5xx/invalid JSON 均保留页面选择与手动创建能力，不自动重试（前端每次点击「请求分析」才重新调用）。
5. **输入预算**：字符硬上限（单字段/片段 8000、总量 48000）+ `EstimateContextTokens` 估算 token ≤16000（未实现 `contextWindowTokens-6144` 下限 2048 的细分阈值，该边界仅在上下文极小时触发）。

---

## 5. 是否准备进入验收

**是，准备进入 Codex 复审与真实 executable 验收。** 后端受控入口、严格解码、字段白名单、预算、严格解析、服务端增强、错误码区分；前端 `proposalToWorldCreateInput` 确定性转换、ProposalChoices（adopt/discard/编辑）、创建向导 AI 分析步骤、失败降级与手动路径均已落地，且 tsc/vitest/go test/go vet/go build/i18n/vite build 全绿（仅仓库既有符号链接测试失败）。

未开始 2B.3，未实现任何禁止项（Timeline、既有世界合并、Agent、长期记忆、自动世界模拟、Canon、Module3/4 接入）。

---

## 6. 修复任务 A：前端 AI 结构提案稳定性（2026-09-10 13:40）

仅修复前端稳定性，未触碰后端 token 预算、Proposal schema、绑定逻辑。

### 修改文件

| 文件 | 变更 |
| --- | --- |
| `web/src/features/world-workspace/components/AiStructureAnalyzer.tsx` | 修改：①修正 Hook 顺序（原 `if (!open) return null` 位于 `useMemo` 之前，条件 return 后仍有 Hook）；②新增 `requestSeq`（请求代）+ `AbortController` 生命周期；③关闭弹窗清理未确认 proposal |
| `web/src/features/world-workspace/world-api.ts` | 修改：`analyzeWorldStructure(input, signal?)` 增加可选 `AbortSignal`，透传给 `requestJSON`→`fetch` |
| `web/src/features/world-workspace/__tests__/AiStructureAnalyzer.test.tsx` | 新增：4 个稳定性测试 |

### 修复要点

1. **Hook 顺序**：把 `selectedCount` 的 `useMemo` 上移到全部 Hook 区；新增的 `resetProposal`（`useCallback`）与三个 `useEffect`（资料加载 / 关闭清理 / 卸载中止）也全部位于提前 return 之前。现所有 Hook（40–122 行）均在 `if (!open) return null`（179 行）之前。
2. **请求生命周期**：每次 `analyze()` 自增 `requestSeq` 并 `abort()` 上一个 `AbortController`，把新 `signal` 传给 `analyzeWorldStructure`；响应返回后先判 `seq !== requestSeq.current` 即丢弃；`catch` 同样按请求代丢弃并忽略 `AbortError`；`finally` 仅在仍为当前请求时复位 `analyzing`。关闭弹窗与组件卸载都会自增请求代并中止在途请求，旧响应不可能覆盖新状态。
3. **关闭清理**：`open` 变为 false 时调用 `resetProposal()`——中止在途请求、清空 `proposal/decisions/adoptedBindingIds/edits/toneOverride/error/analyzing`；「重新分析」按钮复用同一函数。清理只作用于弹窗内部状态，父组件 `WorldCreatePage` 的手动创建流程（bindings/characters/locations/factions/name 等）不受影响，且关闭不调用 `onApply`。

### 测试结果

| 门禁 | 结果 |
| --- | --- |
| `vitest run src/features/world-workspace/__tests__/AiStructureAnalyzer.test.tsx` | 4/4 通过 |
| `vitest run src/features/world-workspace` | 13 文件 / 103 测试通过（原 12/99） |
| `tsc --noEmit` | 通过 |

新增测试：①关闭后可重新打开（覆盖原 Hook 顺序错误）；②关闭未确认 proposal 清理临时状态且不触发 `onApply`；③关闭使在途请求失效、旧响应不写回 proposal；④关闭中止在途请求（断言 `AbortSignal.aborted === true`）。

---

## 7. 修复任务 B：Proposal 应用语义（2026-09-10 13:50）

只修前端应用语义，未修改 AI 输入契约（请求 schema / 字段白名单 / 预算均未动）。

### 修改文件

| 文件 | 变更 |
| --- | --- |
| `web/src/features/world-workspace/world-proposal.ts` | ①新增 `mergeProposalIntoDraft`（合并策略）+ `CreateDraft`/`EMPTY_CREATE_DRAFT`；②`proposalToWorldCreateInput` 增加 **setting 采纳门控**；③实体绑定改为**唯一 Master 来源**才自动绑定 |
| `web/src/features/world-workspace/pages/WorldCreatePage.tsx` | `applyProposal` 由「整体覆盖」改为调用 `mergeProposalIntoDraft` 合并 |
| `web/src/features/world-workspace/__tests__/world-proposal.test.ts` | 新增 6 例、改写 1 例（原 `settingOverride` 旧语义与新门控冲突） |
| `web/src/features/world-workspace/__tests__/WorldCreatePage.test.tsx` | 新增：创建向导集成测试（手动角色 + AI 角色同时存在） |

### 修复要点

1. **不覆盖用户已有草稿（合并策略）**：`mergeProposalIntoDraft(draft, input)` 保留用户输入、AI 结果只做增量。
   - binding 按 `masterItemId` 去重（一世界一 masterItemId 一 binding）；**重复时复用既有 bindingId 并重映射 AI 实体的 bindingId**，避免悬空引用导致后端 400；
   - 实体按 `bindingId|名称` 去重后追加，用户已有实体一律保留；
   - `tone` 仅在用户未填写时采用 AI 值；`rules` 取并集（用户已有优先 + 去重）；用户未填规则时丢弃空占位行；
   - 重复应用同一 AI 结果不产生重复实体。
2. **setting 采纳门控**：只有 `setting` 提案项被采纳时，才写 `tone`/`rules`；**未采纳 setting 时 `worldSetting` 整体为 undefined**（`settingOverride` 一并不生效），采纳后 `settingOverride.tone` 才可覆盖 AI 基调，且 rules 仍逐条按采纳门控。
3. **多 source 实体绑定**：实体自动绑定要求其 `sourceRefIds` 解析出的 **distinct masterItemId 恰好为 1**；多个来源综合出的实体（或仅来自用户片段）不生成 `bindingId`，其绑定的实体作用域候选因无实体引用也一并不发出。

### 测试结果

| 门禁 | 结果 |
| --- | --- |
| `vitest run src/features/world-workspace` | **14 文件 / 113 测试通过**（任务 A 后为 13/103） |
| `tsc --noEmit` | 通过 |

新增/更新用例：手动角色+AI角色同时存在（合并）、AI 与用户绑定同一 masterItemId 不重复建 binding 且重映射、tone 用户优先与 rules 并集去重、空占位规则行丢弃、重复应用不产生重复实体、未采纳 setting 不写 tone/rules（含 override 不生效）、采纳 setting 时 override 生效、唯一来源生成 binding、多来源不自动绑定、创建向导端到端「手动 + AI 角色共存」提交载荷断言。

---

## 8. 修复任务 C：服务端 AI Proposal 契约（2026-09-10 14:05）

### 修改文件

| 文件 | 变更 |
| --- | --- |
| `denova-src/internal/app/world_proposal.go` | ①冻结输入预算公式（`effectiveProposalInputBudget`）；②`enhanceStructureProposal` 补齐输出字段长度/数量校验；③新增 `denova/config` 依赖以解析上下文窗口 |
| `denova-src/internal/app/world_proposal_test.go` | 新增：预算公式边界 8 例、输出长度/数量限制 11 例（含「恰好等于上限必须通过」） |
| `denova-src/internal/api/handlers/handler_world_proposal_test.go` | **新增**：真实 handler 路径测试 4 例 + Master Library 夹具构造器（不调用真实模型） |
| 上述 4 个 Go 文件 | `gofmt -w` 格式化（此前 `gofmt -l` 提示的 3 个文件即本轮新增文件） |

### 修复要点

1. **输入预算（冻结公式）**：`effectiveBudget = min(16000, contextWindowTokens - 6144)`；`< 2048` 时**在调用模型前**直接拒绝（`input_too_large` 413）。`contextWindowTokens` 取自 `config.ResolveAgentModel(cfg, AgentKindInteractiveStory).ContextWindowTokens`（模块固定 `narraverse`）。token 估算仍用 `EstimateContextTokens` 同口径，**与 effectiveBudget 比较**而非固定 16000。
2. **ModelStructureProposal 输出限制**（`enhanceStructureProposal` 阶段，全部走 `invalid_model_output` 422，**禁止静默截断**）：
   - 名称（角色 `displayName` / 地点 `name` / 势力 `name`）≤100 字；
   - 描述（地点/势力 `description`）≤4,000 字；角色 `worldNote` ≤4,000 字；
   - `setting.tone` ≤200 字；每条 `rule.text` ≤2,000 字；
   - 地点 `tags` ≤50 个，单个 tag ≤100 字；
   - 数量上限沿用：规则 ≤30、角色 ≤20、地点 ≤30、势力 ≤20、提案项总数 ≤60。
3. **真实 handler 路径测试**（`internal/api/handlers/handler_world_proposal_test.go`）：
   - 夹具：临时目录内构造最小可用 Master Library（`master-library-manifest.json` + `.narraverse/master/items/<id>.json` + `originals/<id>.json` 原件归档，保证 availability=usable）；
   - 模型：`httptest` 假 OpenAI-compatible 上游返回固定 `chat.completion`（**不调用真实模型**），并统计上游调用次数；
   - 覆盖：①请求 → mock 模型 → 严格解析 → 增强 → 返回 Proposal（断言 `schemaVersion/generatedAt/sourceRefs/bindingCandidates/characters` 等盖章字段与上游恰好调用 1 次）；②严格解码拒绝未知字段与尾随 JSON（400 `invalid_request`）；③模型未配置 → `not_configured`；④上下文窗口 8191（预算 2047 < 2048）→ `input_too_large` 且**模型调用次数为 0**。

### 测试结果

| 门禁 | 结果 |
| --- | --- |
| `go test ./internal/app`（proposal 相关 10 个测试函数） | 全部 PASS |
| `go test ./internal/api/handlers` | 全部 PASS（含新增 4 个 handler 路径测试） |
| `go test ./internal/world` | PASS |
| `go test ./internal/app`（整包） | 仅既有 Windows 符号链接测试 `TestActiveAutomationReservationAtomicallyAttachesConcurrentCaller` 失败（与本轮无关） |
| `go vet ./internal/app ./internal/api/handlers ./internal/world` | 通过 |
| `go build ./cmd/denova` | 通过 |
| `gofmt -l`（本轮 4 个文件） | 无输出（已格式化） |

> 附注：`gofmt -l internal/` 全仓仍有大量既有未格式化文件（`internal/agent/*` 等），属仓库历史债，未在本轮扩大范围处理。
