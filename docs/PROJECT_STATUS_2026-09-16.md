# Narraverse2.0 当前状态与交接

> 状态日期：2026-09-16
> 代码事实来源：GitHub `main`，提交 `8b91a0259e1cc63a3143a5a47cf3a2e738156dcb`。
> 本文只陈述已合入的能力与本地资产边界；未来方案另见 [NEXT_PROJECT_BACKLOG.md](NEXT_PROJECT_BACKLOG.md)。

## 一句话状态

World Workspace 的 Phase 1、2A、2B、3.0、3.1 与 3.2 已完成并保留验收记录。当前版本可以把 World 的只读背景带入写作、游戏、叙界和 Module4；运行中的剧情、会话、故事进度和沙盒状态不会自动写回 World。

这不是“新的一套世界游戏”：World Workspace 目前是资料绑定、世界设定控制台与受控上下文注入层。若某个世界没有绑定角色、地点、势力、规则或时间线，界面体感会更接近“选择/跳转入口”，而不是地图、任务或自动模拟系统。

## 已完成能力

| 范围 | 已交付事实 |
| --- | --- |
| World 真源 | 每个 World 独立 JSON、CAS revision、归档、绑定和实体关系；World 是世界设定唯一持久化真源。 |
| Master Library | 资料可绑定到 World/实体；资料 revision 可按需检查与刷新；原件不因解除绑定而删除。 |
| 世界控制台 | 创建、编辑、绑定影响预览、时间线兼容展示、Context Preview 与选择闭包。 |
| AI 提案 | 创建向导可生成一次性结构提案，用户采纳后才创建/修改 World；提案本身不是 World 真源。 |
| WorldContext | Snapshot、UI Projection、模型临时输入、Registry、analysis handle、InteractiveRun 都是运行时派生状态，不落入 World。 |
| 四模式 | 写作、游戏、叙界、Module4 均可读取显式选择的 World 背景；3.2 最终验收记录在 `archive/2026-09-world-workspace/acceptance/`。 |
| 安全边界 | iframe 通过受控宿主链路获取模型上下文；World Ref、runContext、模型正文与密钥不进入 iframe。 |

## 已冻结不变量

- World 不能被 Runtime、剧情推进或 AI 自动回写。
- Runtime Context、Snapshot、Projection、Registry、Task、InteractiveRun 都不是第二个事实数据库。
- AI 可以分析/提案；所有世界结构变化必须经用户确认与既有 World 保存路径。
- 四模式共享背景，不自动同步剧情，不建立全局 Canon。
- Knowledge、Obsidian、关系图谱若未来接入，只能作为引用或投影，不能取代 World 真源。

完整理由与术语见 [ARCHITECTURE_MASTER_BLUEPRINT.md](ARCHITECTURE_MASTER_BLUEPRINT.md)。

## 本机目录与运行边界

| 位置 | 角色 | 处理原则 |
| --- | --- | --- |
| `D:\Narraverse2.0-main-deploy` | 当前正式部署源码/构建目录，运行中的 Denova 来自这里。 | 作为当前体验与后续开发的代码基线；以 GitHub `main` 为准。 |
| `D:\Narraverse2.0\denova-src\.denova` | 当前本地运行数据。 | 用户资料，保留；不提交 Git。 |
| `D:\Narraverse2.0\.denova` | 旧工作区的资料/项目遗留数据。 | 保留，迁移前不得清空。 |
| `D:\Narraverse2.0\design-previews\2026-09-15-narraverse-ui-v4` | 高保真 UI 设计预览。 | 保留为设计输入；没有接入正式 React/Denova 页面。 |
| `D:\Narraverse2.0` | 旧工作区，代码分支落后于 `main`，混有资料、文档与运行产物。 | 不再作为当前源码真源；只作为本地资料/设计资产来源。 |

旧工作区中未跟踪的原型、旧交接和研究材料已整理到
`D:\Narraverse2.0\docs\_local-archive\2026-09-16\`；它是本地留存，不会随 GitHub
`main` 自动同步。

模型凭据属于本地 Settings/运行配置，不应写入代码、文档或 Git。开始任何真实模型验收前，应在 Settings 中单独验证当前 Profile。

## 已完成的本机清理与保留项

- 已删除已合并的 `D:\Narraverse2.0-wt-c0` 工作树：其提交 `669d0d9` 已在 GitHub `main` 中；同时清除了约 4.3GB 的隔离验收目录、可重建的前端依赖、旧静态镜像和运行日志。该目录不含用户 `.denova` 数据。
- `D:\Narraverse2.0-wt-a1a` 已从 Git worktree 注册表移除；物理残留约 63MB，内容已逐项比对为旧根目录或当前部署已有的知识库、设计预览和文档副本。若不再需要离线备份，可在资源管理器中删除该**无 Git 元数据的重复目录**。
- 旧根目录的 `.denova`、`denova-src\.denova`、UI v4 设计预览和 `docs\_local-archive` 均为有意保留项；它们不是当前代码真源，也不应在未备份、未按需迁移前删除。

## 清理后的开发起点

1. 新项目从 GitHub `main` 新建干净 worktree 或 clone，不从旧 `D:\Narraverse2.0` 复制源码、`node_modules`、`dist`、`.denova` 或验收产物。
2. 先读 [DOCUMENTATION_INDEX.md](DOCUMENTATION_INDEX.md)、本文件、总蓝图和待办清单，再确定单一任务范围。
3. 需要用户历史资料时，只按需迁移 `.denova` 中明确的项目/世界数据，先备份再操作。
4. 任何下一阶段都需要新的计划、实现、验收三件套；历史文档不能自动授权重新开发。

## 已知边界，不应误报为缺陷

- 当前没有地图、任务板、世界自动模拟或剧情自动写回；这是已冻结的产品/数据边界。
- UI v4 只是设计预览，不是已上线 UI。
- Knowledge Workspace、知识图谱、Obsidian 深度接入和 Module4 V2 尚未开发。
- Windows 全量测试中少数符号链接权限/临时目录并发清理问题需按环境单列，不能改写成 World Workspace 功能失败。
