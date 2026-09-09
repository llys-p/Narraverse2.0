# World Workspace Phase 2A 真实环境验收

- 验收时间：2026-09-09 12:50–14:00（Asia/Shanghai）
- 验收 commit：`6a3f4422a15bd35ed5905aaa1169904de8b27ff2`（`main`）
- 范围：Phase 1 + Phase 2A；未启动或实现 Phase 2B。
- 数据隔离：将真实 Master Library 与当前书籍复制到 `D:\Narraverse2.0\.acceptance-phase2a-real-env\runtime`。验收中创建、改写、冲突、失效引用和损坏 JSON 均只存在于该副本；未写入用户原有 `.denova`、世界或 Master 资产。

## 验收环境

| 项目 | 实际环境 |
| --- | --- |
| 后端 | 当前 commit 构建的 `denova.exe`，Go 后端运行于 `127.0.0.1:8095` |
| 正式静态装配 | executable 以 `DENOVA_WEB_DIR=denova-src/web/dist` 同源提供 production Vite 构建产物和 `/api` |
| 开发代理对照 | Vite `127.0.0.1:5174`，`/api` 经本机 8096 故障代理转发至同一 executable |
| 真实资料 | 隔离副本中的 `narraverse-master-library`（4 张可用角色模板） |
| 故障注入 | 仅本机 8096 代理：500、空 `master_revision`、延迟响应；不修改生产接口 |

## 自动化门禁复验

| 检查 | 结果 |
| --- | --- |
| `go test ./internal/world ./internal/api/handlers -count=1` | 通过 |
| `go vet ./internal/world ./internal/api/handlers` | 通过 |
| `tsc --noEmit` | 通过 |
| i18n 键检查 | zh-CN / en-US 各 3717 键，完全对齐 |
| World Workspace Vitest | 8 文件、41 测试通过 |
| Workbench + stores Vitest | 12 文件、41 测试通过 |
| `vite build` | 成功；仅既有大 chunk 提示 |
| 当前 commit executable 构建 | 成功 |

注：World Workspace Vitest 首轮出现 worker 终止超时提示，但同次运行最终 8 文件、41 测试均通过；不视为功能失败。

## 真实闭环结果

| 验收项 | 结果 | 证据 / 结论 |
| --- | --- | --- |
| executable、`/api/status`、World Workspace 启动 | 通过 | 8095 同源静态装配启动；页面和 API 可访问。 |
| 创建独立测试世界 | 通过 | 通过正式 World Workspace 四步创世创建“Phase2A 真实环境验收世界”。 |
| 绑定真实 Master 角色卡 | 通过 | 在正式 UI 选择真实角色模板，原子创建世界绑定与角色实例。 |
| 真实 Master 详情 | 通过 | 打开角色档案成功读取真实 Master 详情与内容哈希，初始显示“已是最新”。 |
| revision stale → 刷新 → 保存 | 通过 | 仅在隔离 Master 副本修改角色名称，内容哈希变化后 UI 显示“原件有更新”；刷新并保存后绑定快照名称和 `masterRevision` 更新，世界内 `displayName` 未被覆盖。 |
| 重启持久化 | 通过 | 重启 executable 后世界、绑定快照、角色实例和 revision 均保留；重开档案显示“已是最新”。 |
| Vite proxy / executable 静态装配一致性 | 通过 | 两种入口均加载同一世界列表、卡片、中文 UI、四模式顶栏和左侧“世界工作区”导航。 |

## 异常路径结果

| 路径 | 结果 | 实际验证 |
| --- | --- | --- |
| Master asset 404 | 通过 | 临时将隔离绑定指向不存在 UUID；档案显示“原件已不存在”，世界内资料仍可编辑，之后恢复绑定。 |
| Master API 5xx | 通过 | 8096 返回一次 500；档案显示“暂时无法检查”，不把错误误判为 stale/missing。 |
| 空 `master_revision` | 通过 | 8096 返回真实详情但清空 revision；显示 unavailable。显式刷新提示“暂时无法检查，未改动资料”，world revision、快照名称和保存的 revision 均不变。 |
| CAS 409 与重新加载 | 通过 | 服务端先改写隔离 world 使本地 revision 过期；保存显示冲突横幅和“重新加载”，确认放弃本地草稿后横幅清除。 |
| 头像失败回退 | 通过 | 真实角色卡头像接口 404 时，档案无失效 img，显示 SVG 图标回退。详见 P1-01。 |
| 主书失效 | 通过 | 注入不存在路径；控制台保留 disabled、已选中的“已失效：原值”，不会伪装成未选择。 |
| 主故事失效 | 通过 | 注入不存在故事 ID；行为与主书一致。 |
| 快速切换角色 | 通过 | 延迟第一张角色详情 1.8s，立即切至第二张真实角色；迟到响应返回后仍显示第二张角色及其“已是最新”状态。 |
| 组件卸载后的在途请求 | 通过 | 延迟详情请求后立即返回控制台；迟到响应没有重新打开或覆盖已卸载档案。 |
| 损坏 world JSON warning | 通过 | 注入仅隔离目录中的截断 `world-abcdef012345.json`；列表保留健康世界并显示 1 条可见警示。 |

## 发现的问题

### P1-01：当前真实角色模板无法显示真实头像

- 复现：隔离真实 Master Library 中 4/4 张可用角色模板的 `/api/library/assets/:id/avatar` 均为 404；绑定后档案正确显示 SVG 回退，但没有真实头像。
- 根因：`internal/api/handlers/handler_library.go:74-76` 明确仅提供已归档 PNG；`internal/book/master_library_query.go:242-247` 也仅在原始卡为 PNG 时生成 `avatar_url`。本次真实资料均非带已归档 PNG 的卡，现有 `BindingAvatar` 又始终按 ID 构造 `/avatar` 请求。
- 最小修复建议：让 Master Library 摘要明确返回“是否具备本地头像 / avatar_url”，World Workspace 仅在该值存在时请求头像；随后单独定义 JSON 卡或远程 URL 头像的可信读取策略。不要在前端盲目请求所有资产，也不要抓取不受信任远程 URL。
- 影响：头像回退安全可用，不影响绑定、健康检查、刷新或持久化；但 Phase 2A 的“真实头像”验收条件不成立。

### P1-02：控制台“手动新建”生成不可保存的空名称角色

- 复现：世界控制台 → 角色 → “手动新建” → 直接保存。后端按契约拒绝：`characters[n].displayName：名称不能为空`；若立即点此临时角色，档案页显示误导性的“世界不存在或已被移除”。
- 根因：`web/src/features/world-workspace/pages/WorldConsolePage.tsx:113` 直接插入 `emptyCharacter()`；`web/src/features/world-workspace/world-factory.ts:22-23` 返回空 `displayName`，而 `internal/world/validate.go:309-313` 正确要求名称非空。临时、未保存角色又由详情页重新从服务端读取，故找不到该实例。
- 最小修复建议：点击“手动新建”时先要求名称（小弹层即可）或提供可保存默认名称并立即聚焦编辑；若仍允许临时项，档案页应明确提示“尚未保存角色”，而非声称世界被移除。
- 影响：不会产生坏数据（后端拒绝），但手动角色创建主路径不可用。

## 分级、结论与 Phase 2B 门槛

| 等级 | 项目 |
| --- | --- |
| P0 | 无。 |
| P1 | P1-01 真实头像来源不兼容；P1-02 手动角色创建不可保存。 |
| P2 | 无新增功能缺陷；构建的大 chunk 提示和 Vitest worker 结束提示均为既有环境/构建提示，未复现为功能回归。 |

**是否允许进入 Phase 2B：暂不建议。** 核心的绑定健康、刷新、CAS、持久化、异常隔离和竞态保护均已在真实环境成立；但 Phase 2A 尚有两条明确的 P1 用户路径未达到完成标准。进入 Phase 2B 前至少应处理：

1. P1-01：确定真实 Master 卡头像能力的单一契约，并让真实数据能走成功路径或明确不支持时不发起失败请求。
2. P1-02：使手动角色创建在首次保存前具备有效名称与正确的临时状态提示。

本报告不包含 Phase 2B 设计或代码变更。
