# World Workspace Phase 2B.2 代码复审

- 复审时间：2026-09-10 13:33（Asia/Shanghai）
- 复审基线：`c48b20e1063d8803639bbaed7557213db3a08d0b`（Phase 2B.1）
- 复审对象：当前工作树中的 Phase 2B.2 实现及其测试、计划、实现报告
- 复审结论：**CHANGES REQUESTED**
- 本轮动作：仅复审与记录，未修改生产代码，未调用真实模型，未开始 Phase 2B.3

## 1. 当前实现进度

Phase 2B.2 已实现“创建世界向导 AI 结构提案”的主链路：

```text
WorldCreatePage
  → AiStructureAnalyzer
  → POST /api/world-proposals
  → 服务端重读 Master、校验 revision/usable/字段白名单/预算
  → App.GenerateModel(module=narraverse)
  → 严格解析 ModelStructureProposal
  → 服务端增强为 StructureProposal
  → 用户 adopt/discard/edit
  → proposalToWorldCreateInput
  → POST /api/worlds
```

已确认的范围边界仍然符合设计：不包含 Timeline 提案、既有世界合并、自动世界生成、世界模拟、Agent 自治、长期记忆以及 Module3/Module4 运行态接入。

已执行并通过的独立门禁：

- `go test ./internal/app ./internal/api/handlers ./internal/world -run 'Proposal|SemanticMapping|FieldPath|World' -count=1`
- `go vet ./internal/app ./internal/api/handlers ./internal/world`
- `go build ./cmd/denova`
- `pnpm exec vitest run src/features/world-workspace --reporter=dot`（12 文件 / 99 测试）
- `pnpm exec tsc --noEmit`
- `node scripts/check-i18n-keys.mjs`（3761 键对齐）
- 隔离输出目录的 `pnpm exec vite build`
- `git diff --check`

补充：`gofmt -l` 当前仍报告 `internal/app/world_proposal.go`、`internal/app/world_proposal_test.go`、`internal/api/routes.go`，应在修复提交中一并处理。仓库既有 Windows 符号链接权限测试失败仍需与本轮结果分开标注。

## 2. 阻塞问题（P0/P1）

### P0-01：AI 分析弹窗存在 React Hook 顺序错误

文件：`denova-src/web/src/features/world-workspace/components/AiStructureAnalyzer.tsx`

当前顺序是：

```tsx
if (!open) return null
const selectedCount = useMemo(...)
```

组件初次以 `open=false` 渲染时不会调用 `useMemo`，打开后同一实例新增 Hook，违反 React Hook 顺序规则，可能直接出现 “Rendered more hooks than during the previous render”。这会阻塞 AI 分析弹窗的真实使用。

最小修复建议：删除这个不必要的 `useMemo`，直接计算计数；或者把 Hook 移到条件返回之前。必须补一个从关闭状态切换到打开状态的组件测试。

### P1-01：分析请求没有取消和生命周期失效保护

文件：`AiStructureAnalyzer.tsx`、`world-api.ts`

当前分析请求没有 `AbortSignal`、请求序号或 mounted/closed 保护；关闭按钮、遮罩、组件卸载只调用 `onClose`。由于组件由 `WorldCreatePage` 持有，关闭后状态仍然保留，晚返回的请求仍可能写入已关闭的提案状态，重新打开时还会看到旧提案。

最小修复建议：请求支持 `AbortController` 或等价请求序号；关闭/卸载/重新分析时使旧请求失效；关闭时清理未确认 Proposal。若分析进行中关闭，应显示取消或确认行为，而不是让后台响应继续改变页面。

### P1-02：应用提案会静默覆盖用户已有草稿

文件：`denova-src/web/src/features/world-workspace/pages/WorldCreatePage.tsx` 的 `applyProposal`

当前 `applyProposal` 直接用提案结果替换 `bindings`、`characters`、`locations`、`factions`、`tone` 和 `rules`。如果用户在打开 AI 分析前已经手动添加内容，这些内容会被无提示删除；函数注释写“合并”但实现实际是替换。

最小修复建议：明确采用可验证的合并规则（按 `masterItemId`、实体绑定和稳定字段去重），保留用户已有草稿；或者在应用前明确提示“替换现有草稿”，并让用户确认。必须补集成测试覆盖“手动草稿 + AI 应用”路径。

### P1-03：未采纳 setting 时仍可能写入 tone

文件：`denova-src/web/src/features/world-workspace/world-proposal.ts`

当前逻辑无条件读取：

```ts
const tone = choices.settingOverride?.tone ?? proposal.setting?.tone
```

因此用户丢弃 `setting` 后，模型生成的 `proposal.setting.tone` 仍可进入 `WorldCreateInput`。这违反“未采纳提案项不进入 World”的契约；现有测试还把该错误行为固定成了预期。

最小修复建议：只有在 `setting` 被采纳时才使用其 tone 或 settingOverride；同步修正测试。

### P1-04：实体跨多个来源时错误绑定到第一个资产

文件：`world-proposal.ts` 的 `bindEntity`

当前实现从 `sourceRefIds` 推导多个 Master 资产后返回第一个匹配候选。设计要求跨多个来源综合出的实体默认不绑定，以免把综合事实错误归属于单一 Master 资产。

最小修复建议：仅当来源解析到唯一一个兼容实体资产时生成 `bindingId`；多个不同 Master 资产或无法唯一确定时保持无绑定实体。补充多来源测试。

### P1-05：输入 token 预算没有实现冻结的上下文窗口下限

文件：`denova-src/internal/app/world_proposal.go`

当前只判断估算值是否大于固定 `16000`。冻结契约要求有效输入预算为：

```text
min(16000, contextWindowTokens - 6144)
```

当共享 Settings 的上下文窗口较小时，当前实现可能仍接受模型无法承载的输入。还需要在有效预算低于 `2048` 时拒绝，并把该边界加入单测。

### P1-06：模型输出字段长度/标签限制未完整执行

文件：`world_proposal.go` 的 `enhanceStructureProposal`

当前执行了数量、空名称、角色枚举、confidence、sourceRef 和 reason 检查，但没有完整执行设计冻结中的名称、description/worldNote、tone、rule text、tags 数量和标签长度上限。结果可能延迟到 `POST /api/worlds` 才以 400 失败，而不是按约定在提案阶段返回 `invalid_model_output`。

最小修复建议：服务端在增强阶段统一执行所有 Proposal 输出限制；越界一律拒绝，不静默截断。补齐边界测试。

## 3. 非阻塞但应补齐的问题

### P2-01：失败降级缺少明确操作入口

模型未配置、超时、429、5xx 或输出非法时，当前 UI 主要显示通用错误文本。设计要求用户仍能明确选择“继续手动创建”，并在共享模型未配置时提供配置/前往 Settings 的可理解提示。

### P2-02：提案复核界面没有充分展示来源证据

服务端保留了 `sourceRefs`、`reason` 和 `confidence`，但界面主要展示置信度，没有让用户查看每项提案的来源字段和依据。对于结构变化的人工确认，建议至少能展开查看来源标签与 reason。

### P2-03：前端缺少输入预算实时反馈

计划要求显示资产数、字段数、片段数和字符计数；当前界面只计算部分选中资产数量，缺少字段/字符上限提示，容易让用户在提交后才遇到 413。

### P2-04：缺少真实服务路径的完整测试

现有新增后端测试主要覆盖解析、增强和辅助函数，尚未覆盖带测试 Master Library 与可控模型响应的 `AnalyzeWorldStructure` 完整路径；handler 专项测试和 AI 组件测试也不完整。真实模型 E2E 尚未执行。

## 4. 验收结论

当前结论：**不建议把本工作树标记为 Phase 2B.2 完成，也不建议进入 Phase 2B.3。**

原因是 P0 Hook 错误会直接阻塞 AI 弹窗使用，P1 问题涉及请求生命周期、用户草稿保留、提案采纳语义、错误绑定和服务端预算/输出边界，不能仅作为后续体验优化。

建议修复顺序：

1. 修复 Hook 顺序并补打开/关闭组件测试；
2. 加入请求取消/失效和提案关闭清理；
3. 修正提案应用的草稿合并策略；
4. 修正 setting 采纳门控和多来源绑定；
5. 补齐服务端上下文预算与 Proposal 输出限制；
6. gofmt、补完整服务路径测试，再做隔离环境真实 executable + 可用模型 E2E。

在上述修复完成前，不应把任何 API Key 写入源码、Git、日志或测试夹具；真实模型验收必须使用隔离数据目录，且脱敏记录请求与响应。
