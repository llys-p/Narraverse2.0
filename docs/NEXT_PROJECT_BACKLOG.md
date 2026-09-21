# Narraverse 2.0 下一项目待办与重新立项清单

> 更新：2026-09-21（main HEAD `0ea84eb`）。这里列的是"尚未实施或需要重新确认"的方向，不是当前开发指令。
> 上一版（2026-09-16，docs 整理分支）已按 main 当前事实更新。

## 使用规则

- 每次只选择一个主题重新立项；先确认产品目标、数据边界、文件范围与验收方式。
- 不得把本文任一条理解为已存在的功能，或直接跳过设计/验收。
- World 单一真源、运行态只读、AI 不能自动改世界是所有候选项的前置约束。
- 当前分工：豆包/Workbuddy 编码实现，Codex 只做架构关卡审查；已过审提交不回头复审。

## 已落地（09-21 更新，移出待办）

- **Phase 3.2 写作/游戏/叙界+Module4 只读 World Context 接入**：已通过 PR #2 合入 main（含 iframe 安全门、真实 DeepSeek 验收）。
- **UI 导航澄清（去重四模式卡）**：已通过 PR #3 合入 main。
- **Phase 5 L1 独立作品设定库**：已合入 main（`0ea84eb`），含 create/edit、source references、relations events、impact preview、无书模式守卫；数据契约见 [plans/LIBRARY_L1_DATA_CONTRACT.md](plans/LIBRARY_L1_DATA_CONTRACT.md)。

## P0：仓库卫生与文档对齐（小而确定，建议先清）

| 事项 | 现状 | 处理建议 |
| --- | --- | --- |
| 交接指南引用断裂 | `交付/Narraverse2.0交接指南.md` 仍指向已归档的 `docs/module4/`、英文 `CODE_GUIDE.md`/`COLLABORATION_LOG.md`（与中文版双轨漂移，冻结于约 08-30） | 更新为现行路径与中文版文档；确认英文版是否退役 |
| AI协作指南口径过时 | 根 `AI协作指南.md` 仍自称"纯静态单页、无后端、app.js 约 5000 行"，与 Denova 托管+Go 后端+四模块现状冲突 | 改写或标注历史 |
| knowledge-base 口径矛盾 | `说明文档.md` 正文写 39 卡/50 书，底部补记 47/51；引用的 `归档/`、`oldswf存档.sav` 路径不存在 | 统一为 47/51 并修死链 |
| denova 作品重名 | `denova-src/.denova/projects/` 下武松×2、水浒传×2、火影忍者×2 并存 | 内容比对后去重，保留权威副本 |
| worktree/分支清理 | `wt-pr3`（分支已合并）、`wt-docs-cleanup`（英文 archive 归档方案，已被 09-21 中文归档取代）、`main-deploy`（detached）仍在；`feat/library-l1` 已合并 | 确认后逐个 `git worktree remove`、删分支 |
| `_local-archive/` 未入 git | 含 Phase 3.1 验收报告原件；其中原型 node_modules 应排除 | 决定入库范围（排除 node_modules） |
| v4 路线分叉 | 根 `平台整合规划说明书.md`（iframe 外壳）与"Denova 唯一宿主"现行路线并列，未点明搁置状态 | 产品决策：搁置则归档并改代码指南 L623 引用 |
| 主仓库前端依赖残缺 | `denova-src/web/node_modules` 缺 `.bin/vitest.cmd`、`@adobe/css-tools`，全量 vitest 无法在主仓库跑（l1 worktree 依赖完整，1284 测试全绿） | `pnpm install` 修复主仓库依赖 |
| Windows symlink 测试 | `internal/app`、`internal/api` 各 1 个 symlink 测试因非管理员无 SeCreateSymbolicLink 权限失败（origin/main 同样失败） | 开开发者模式或管理员终端运行；CI（Linux）不受影响 |

## P1：下一项目开始前的产品选择

| 候选 | 现状 | 重新立项前需决定 |
| --- | --- | --- |
| UI/信息架构落地 | 本机有 `design-previews/2026-09-15-narraverse-ui-v4` 高保真 Demo；尚未接入产品 | 是否采用"书籍区 + 世界内双入口"、模式是否可复用资产、哪些页面先替换 |
| 世界内容建设 | 平台已交付，但缺足量结构化世界资料时体验很轻 | 先做水浒等具体世界的资料整理/绑定，还是先做通用内容录入效率 |
| 本地资料迁移 | 旧 `.denova` 和旧目录仍保留（含重名项目） | 哪些项目/世界要迁移、怎样备份核验，绝不把缓存直接复制进新版本 |
| L2/L3/L4 资料库 | L1 已落地；L2（模型读取授权）仅在分支提交信息中提及，无文档 | 先为 L2 立项：模型读取边界、授权模型、验收方式 |

## P2：可独立规划的产品方向

### Knowledge Graph（Phase 6 候选）
- 目标：可视化人物、地点、事件、组织、物品与来源关系。
- 前置：L1 的稳定引用（`sourceKind/sourceId/sourceRevision/locator`）和用户可核查的关系来源。
- 不做：把图谱当事实数据库，或让图谱编辑自动修改 World。

### Module4 V2（概念已保留，已放弃过一次）
- 目标：研究事件驱动的自由沙盒体验；原始玩法在归档区 `归档/2026-09-21-整理/02-docs历史方案/Narraverse2.0_模块四V2_玩法设计文档.md`。
- 前置：独立规格、性能/成本预算、运行态与 World 的单向边界、可验收的最小玩法闭环。
- 不做：借"世界会变化"绕过 World 真源、让 Agent 自主改核心数据、直接重写现有 Module4。

### Denova 养成攻略模式（仅有设计稿）
- 目标：NSFW 多女角数值养成（6 数值/4–5 阶段/H 面板），稿在 `模式设计/Denova-养成攻略模式-模式定位与核心数值.md`。
- 前置：产品定位（是否进入四模式之外的第五模式）、数值与内容合规边界、最小闭环规格。
- 现状：全仓库无代码、无路线图条目。

### 三模式/游玩体验（历史提案，待重新验证）
- 目标：降低游戏模式信息密度、澄清叙界与规则层体验职责；原提案在归档区 `02-docs历史方案/superpowers/`。
- 前置：重新对照当前 UI、ModeRouter 与 Phase 3.2 运行边界；旧方案不能直接照搬。

## P3：研究材料，不等于排期

- `_local-archive/2026-09-16/research/deep-research-report.md`：曾提出大范围重构，已过时，只能作为问题清单重审。
- `_local-archive/2026-09-16/prototypes/`：角色档案模板、UI/互动原型，均未接生产代码。
- 归档区 `02-docs历史方案/architecture/`：早期架构图，辅助理解，不构成需求。

## 不应自动重开

- 已验收的 World Workspace Phase 1–3.2 与 Phase 5 L1。
- 已完成的翻译五项修复；只有复现当前版本的具体问题才另立修复任务。
- Module4 v1/V1.5 已交付范围；V2 必须是新项目，不能在维护任务中顺手重构。
