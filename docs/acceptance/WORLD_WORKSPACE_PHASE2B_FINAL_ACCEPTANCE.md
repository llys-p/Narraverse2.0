# World Workspace Phase 2B 正式验收报告

**验收时间：** 2026-09-10 16:53
**验收结论：** **CONDITIONAL PASS**
**范围：** Phase 2B.2 创建向导 AI 结构提案、World 持久化与 Master Library 绑定闭环；未开始 Phase 2B.3。

## 1. 验收基线与环境

- 仓库：`llys-p/Narraverse2.0`
- HEAD：`37d6bfc64756db7cae84fc243d253dff5c6d2c07`
- HEAD 之后存在 Workbuddy 未提交的 A/B/C 修复；本报告按当前工作树实际状态验收，不能等同于一个已提交的发布 commit。
- 系统：Windows 11
- Git：2.45.1.windows.1
- Node：v24.14.0
- pnpm：11.19.0
- Python：3.11.5
- Go：go1.26.5 windows/amd64
- PowerShell：7.6.5
- 验收数据目录：`.phase2b-acceptance-codex-20260910-1414`（隔离目录）
- 正式可执行程序：`C:\Users\11\AppData\Local\Temp\narraverse-phase2b-acceptance.exe`
- 正式静态资源目录：`C:\Users\11\AppData\Local\Temp\narraverse-phase2b-web-20260910-141046`
- Denova 验收端口：`127.0.0.1:8124`
- Vite 对照端口：`127.0.0.1:8174`

验收没有使用本地 Ollama/qwen2.5，也没有读取、复制或输出 DeepSeek API Key。AI 请求链使用隔离的本地 mock OpenAI-compatible 上游验证协议、服务端校验和页面闭环；真实 DeepSeek 生成质量单独列为未完成项。

## 2. 正式 executable 闭环

| 验收项 | 结果 | 证据/说明 |
|---|---|---|
| 启动正式 Denova executable | PASS | `8124` 正常监听，静态资源与 API 同源提供 |
| 进入 World Workspace | PASS | 页面显示世界工作区和创建入口 |
| 创建隔离测试世界 | PASS | UI 完成四步向导，世界名为“Phase2B隔离验收世界” |
| 选择 Master Library 资产 | PASS | 从隔离副本中的真实 Master Library 数据选择角色卡“喜多川海梦”，API 返回 7 个 usable 资产，其中 4 个角色卡、3 个 lorebook |
| AI 结构提案 | PASS（mock 模型） | UI 返回世界设定、角色、地点、资料绑定候选；严格 Proposal 经服务端增强后展示 |
| Proposal 不直接写 World | PASS | 调用前世界数为 0；Proposal 返回后仍未产生 World，点击“应用并继续”后才通过 `POST /api/worlds` 创建 |
| 提案采纳与创建 | PASS | 控制台显示 1 角色、1 地点、1 条绑定 |
| 四模式入口 | PASS | 控制台可见写作、游戏、叙界 Narraverse、开放沙盒四个体验入口 |
| 角色档案与 Master 健康 | PASS | 档案显示 Master 原件、类型 `character · character_template`，初始显示“已是最新” |
| Master revision 变化识别 | PASS | 隔离 Master 条目 revision 改变后，重新打开角色档案显示“原件有更新” |
| 刷新与保存边界 | PASS | 点击刷新先显示“已更新本地资料摘要，保存后才会生效”，保存按钮随后启用；保存后才更新 World binding |
| 刷新不污染世界实例 | PASS | 保存后角色世界内名称、世界内状态和地点实例仍保留 |
| 完整重启后持久化 | PASS | 停服、重启同一 executable 后，世界、1 个角色、1 个地点、1 条 binding 和 revision 均存在 |
| 重启后正式页面 | PASS | `8124/?mode=worlds` 显示测试世界卡片，可再次进入控制台 |

最终隔离世界摘要：`worldCount=1`、`characters=1`、`locations=1`、`bindings=1`。测试世界 ID、revision 和 Master ID 只保存在本次隔离验收证据中，未写入源码、日志或 Git。

## 3. Vite 代理对照

| 验收项 | 结果 | 证据/说明 |
|---|---|---|
| Vite 页面加载 | PASS | `http://127.0.0.1:8174/?mode=worlds` 返回 200 和应用壳 |
| `/api` proxy | PASS | Vite 代理读取 `8124/api/worlds`，返回同一隔离世界 |
| Vite 页面渲染世界卡 | PASS | 浏览器无头 AX 页面显示“Phase2B隔离验收世界”及 1 角色、1 地点 |
| executable 静态装配 | PASS | `8124` 同源提供同一前端构建产物和 `/api`，页面结果与 Vite 对照一致 |

页面出现过一次既有更新检查警告：GitHub Release API 被限流。它不影响 World Workspace、Proposal 或 API 代理验收，也不是本轮代码错误。

## 4. 自动化门禁

- `go test ./internal/api/handlers ./internal/world -count=1`：PASS
- `go test ./internal/app -run 'Proposal|AnalyzeWorldStructure|EffectiveProposal' -count=1`：PASS
- `go vet ./internal/app ./internal/api/handlers ./internal/world`：PASS
- `go build -o <temporary> ./cmd/denova`：PASS
- `pnpm exec vitest run src/features/world-workspace`：14 文件、113 测试 PASS
- `pnpm exec vitest run src/components/workbench src/stores`：12 文件、41 测试 PASS
- `pnpm exec tsc --noEmit`：PASS
- `node scripts/check-i18n-keys.mjs`：3761 个 zh/en key 对齐
- Vite 隔离构建：PASS，仅有既有大 chunk 警告
- `git diff --check`：PASS

`go test ./...` 仍受到既有 Windows 符号链接权限测试影响：`internal/agent/TestToolExecutionGateCanonicalizesWorkspaceSymlink` 报 `A required privilege is not held by the client`。该失败在本轮 Phase 2B 之外独立复现，不是 Proposal 或 World Workspace 回归。

## 5. 问题分级

### P0

无。

### P1

无新的 P1。当前已验证的 A/B/C 修复没有发现新的阻断性回归：Hook 顺序、请求取消与过期响应、Proposal 合并草稿、setting 采纳门控、多来源绑定和服务端预算/输出限制均有自动化覆盖，且正式 executable 闭环通过。

### P2 / 验收边界

1. **真实 DeepSeek E2E 尚未执行。** 本轮遵守“不用本地 qwen2.5”并避免在命令、日志或报告中传输 API Key，采用隔离 mock 上游验证协议和真实 executable 闭环。因此模型真实回答质量、真实 endpoint 延迟和真实错误映射仍需由用户在已配置 DeepSeek 的隔离环境手动触发一次。
2. **真实 PNG 头像未能在本次样本中验证。** 当前隔离 Master API 的角色摘要没有 `avatar_url`，页面按设计显示通用 fallback 图标；BindingAvatar 的“有 URL 才加载、失败回退”由组件测试覆盖，但需要一张确实带已归档 PNG `avatar_url` 的 Master 角色卡做一次目视验收。
3. **全量 Go 测试的符号链接权限问题仍存在。** 需要在具备 Windows 创建符号链接权限的环境补跑，不应通过修改测试或 Go 代码规避。
4. `internal/api/routes.go` 仍被独立 `gofmt -l` 标记为未格式化；它不是本轮验收修改文件，不影响功能，但建议在下一次提交前单独格式化或确认其历史状态。
5. 当前 A/B/C 修复尚未形成提交。发布前必须由 Workbuddy/Codex 精确暂存 Phase 2B.2 文件，避免把 `denova.exe`、截图、dist 和验收目录带入提交。

## 6. 是否允许进入下一阶段

**Phase 2B.2 的代码与隔离运行验收：允许关闭，结论为 CONDITIONAL PASS。**

**不建议立即开始 Phase 2B.3。** 在进入下一阶段前至少完成：

1. 将当前 Workbuddy A/B/C 修复精确提交并推送；
2. 在用户确认的 DeepSeek 隔离配置中跑一次真实 `/api/world-proposals` executable E2E，不记录 Key 和原始敏感请求；
3. 使用带 `avatar_url` 的真实角色卡补一次 PNG 头像目视验收；
4. 在有符号链接权限的 Windows 环境补跑 `go test ./...`。

本轮没有修改生产代码，没有修改 Module3/Module4，没有新增模型配置链，也没有开始 Phase 2B.3。
