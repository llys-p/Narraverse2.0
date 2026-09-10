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
