# Narraverse2.0 AI 协作决策原则

> 目标：让 AI 以低摩擦方式推进工作，同时始终让用户知道项目当前结构、分支和发布状态。这里的“谨慎”指与风险匹配，而不是为小概率问题叠加流程、代码或等待。

## 1. 唯一真源与角色

- 唯一正式源码：`llys-p/Narraverse2.0` 的 `main`。
- `main`：可发布基线，只通过审查后的 PR 合入；首次空仓库导入等明确行政操作除外。
- task branch：一个目标一条短生命周期分支，完成 PR 后可删除远端分支，PR 历史保留。
- integration branch：仅用于具有多个顺序 Task 的大型计划；普通修复不创建。
- release worktree：只从已合并的 SHA 或 tag 构建/验证，不用于日常开发。
- 浏览器 localStorage、`.denova/`、`node_modules/`、`web/dist/`、`output/` 是本机运行或生成物，不是源码真源。

旧仓库、旧 executable、旧端口和旧 worktree 只能作为历史证据，不能作为新任务基线。

## 2. 默认工作方式：先判断，再正常推进

AI 应先判断任务属于哪一类：

| 情况 | 默认动作 | 是否要向用户说明 |
| --- | --- | --- |
| 阅读、搜索本仓库、查看 Git、运行无副作用检查 | 直接执行 | 不必逐步汇报 |
| 用户已明确要求实现，且当前任务 worktree 干净、base 正确 | 在当前 task branch 正常推进 | 只给简短进度 |
| 文档、小范围代码、定向测试 | 优先最小改动和定向验证 | 不为形式跑全量构建 |
| 要新建 worktree、分支或 PR | 先说明结构决定，再继续创建 | 必须说明 |
| 要合并到 `main`、删除目录/branch/worktree、重置、覆盖或发布 | 停止并等待明确授权 | 必须等待 |
| 产品范围、数据模型、API、存储或跨模块边界改变 | 先给最小方案和影响 | 必须等待 |

“说明”不等于每次都请求许可。若新 worktree/branch 是明确任务的标准步骤，AI 应先用一条简短说明告知，再继续；只有会改变发布状态、删除数据或需要产品选择时才暂停等待。

## 2.1 渐进读取：不要为流程重复消耗上下文

完整了解项目只在以下场景进行一次：新 AI 首次接手、新会话没有可靠上下文、切换到不同仓库，或用户明确要求完整审查。

首次接手时，读取 README、当前交接指南、本原则、交付清单、当前 Git 状态，以及与任务直接相关的设计/代码指南。完成定位后，应在本会话保留这些结论，不要每个小任务重复读取全部文件。

同一会话中的后续任务只需要：

1. 查看当前 `git status --short --branch`。
2. 读取与当前改动直接有关的源码、测试和局部文档。
3. 仅在任务触及对应边界时再读取专项资料：例如 Module4 计划、迁移说明、构建脚本、API 规则或历史踩坑记录。

普通问答、只读排查、单文件文案、已有 PR 的小修复，不应重读完整协作日志、全部设计文档或全仓库历史。信息不足且可能改变结论时，才补读最小必要资料。

## 3. 何时需要新 worktree

只有满足以下任一条件时，才建立新 worktree：

1. 当前目录有用户未提交改动，无法安全隔离本任务。
2. 当前任务需要不同的 base branch、不同 Git 历史或独立 PR。
3. 另一项工作正在当前 worktree 中进行。
4. 要从固定已合并 SHA 做 release/build 验证。

以下情况不要新建：

- 只是阅读、排查、回答或 review。
- 当前 task worktree 干净，且 branch/base 与任务一致。
- 同一 PR 中继续修复审查意见。
- 只改文档或做一次小范围后续修改，且不会混入另一项任务。

新建前必须向用户说清楚这四项：

```text
工作位置：现有 worktree / 新 worktree
原因：为什么当前目录不能或不应继续使用
基线：origin/main 或明确 integration branch 的 SHA
产出：将形成的 branch / PR，或仅用于 release 验证
```

推荐结构：

```text
C:\Projects\Narraverse2.0\              main 基准工作树
C:\Projects\worktrees\n2-<task>\        单一任务 worktree
C:\Projects\worktrees\n2-release\       固定 SHA 的发布验证 worktree
%LOCALAPPDATA%\Narraverse2.0\             本机运行数据与配置
```

worktree 只能通过 `git worktree add/remove` 管理；不得直接用资源管理器删除。删除前必须确认无独有 commit、无运行进程和无待保留证据，随后再清理 stale metadata。

## 4. 分支与 PR 决策

普通功能或修复：

```text
origin/main → task branch → PR base: main → merge → 删除 task branch
```

大型连续计划：

```text
origin/main → integration/<program>
integration/<program> → task branches → task PR
integration/<program> → release PR → main
```

规则：

- 每个 task branch 必须从最新远端 base 创建，不得从旧本地分支或旧 release 目录开始。
- 开 PR 前确认重要 commit 已 push；不得让关键改动只存在本机。
- `main` 出现 hotfix 后，若存在活跃 integration branch，必须及时同步回 integration branch，不要等最后收束。
- GitHub 上传默认是：push task branch → 创建 PR → review → merge。除非用户明确要求，不能直接 push 功能到 `main`。
- 合并后用 GitHub PR、tag 和 release note 保存历史，不靠长期堆积 task branch 保存历史。

## 5. 效率与止损原则

AI 必须追求“足够的证据”，而不是“最多的检查”。

- 文档改动：检查链接/格式、`git diff --check`；不重跑前端、Go 或真实模型。
- 仅 Module4 局部逻辑：跑对应定向测试、语法检查；只有碰 Store、Migration、World schema 或 Preview 才补跑相关旧测试。
- 静态资源、宿主或构建链改动：再加同步/hash、前端构建或 executable smoke。
- 没有源码、资源或配置变化时，不得重复完整构建来“证明没问题”。
- 同一失败没有新证据时，最多进行有限重试；第二次仍无新信息，就报告根因假设和最小下一步，不无限循环。
- 如果一项排查预计长时间下载、反复启动、消耗真实 API，且结果不会改变当前决定，应跳过或先说明收益。

当以下任一项由用户亲自完成明显更快时，AI 应直接说明需要用户做什么，而不是机械模拟或反复猜测：

- 登录、GitHub 权限、浏览器设置、API Key 填写。
- 需要主观体验判断的 UI、文本表达、游戏感受。
- 需要用户选择产品方向、是否保留历史数据或是否发布。
- 长时间下载、安装系统级依赖、需要管理员权限的操作。

AI 需要的提问应只有一件明确的事情，例如：“请在正式 Denova 的共享设置保存 API 配置后告诉我，我再继续验证。”

## 6. 反过度防御原则

不因为低概率、未复现或不会影响本次交付的问题，引入高复杂度方案。

以下改动必须先证明必要性并向用户说明：

- 新服务、后台进程、数据库、配置层或 API endpoint。
- 大规模兼容层、迁移框架、重试系统、抽象工厂或全局重构。
- 为单次临时问题保存永久运行逻辑。

优先顺序：

```text
现有能力的最小修复
→ 明确的人工步骤或文档
→ 小型局部自动化
→ 只有重复发生且影响交付时，才建设长期机制
```

在开始复杂实现前，AI 必须说明：问题证据、最小方案、为什么现有方式不够、复杂方案的维护成本。

## 7. 模块与运行态边界

- Module4 业务代码放在 `app/module4/`；不复制 Module3 Adventure/Game Engine，不把主要逻辑塞入 `app.js`。
- Module4 使用现有共享 `window.callLLM()` → `state.apiConfig`；不创建专属 API 配置。
- `app/module4/` 是源码；`denova-src/web/public/narraverse/module4/` 是同步生成物。
- 5174 是静态前端检查；5173 是 Denova Vite 开发前端；8080 通常是正式 Denova executable 入口。端口变更可能导致 localStorage、世界和共享配置看起来“消失”。
- 当问题只在 embedded 或正式 executable 中发生时，先核对静态同步、构建来源和实际 URL，再修改业务逻辑。

## 8. 每次交付的最小汇报格式

完成后只需清楚回答：

```text
结果：完成了什么
结构：是否新建/复用 worktree、branch、PR；当前 base 是什么
验证：运行了哪些必要检查
未验证：什么因风险低、无源码变化或需要用户操作而没有执行
下一步：是否需要用户做一件具体事情
```

不要用冗长命令输出、重复状态轮询或大量历史细节掩盖结论。

## 9. 当前交接入口

新 AI 首次接手本仓库时阅读：

1. `README.md`
2. 本文件
3. `docs/交付/Narraverse2.0交接指南.md`
4. `docs/交付/Narraverse2.0交付清单.md`
5. `DESIGN.md`、`代码指南.md`、`平台模块功能总览.md`
6. 当前 `git status`、远端分支、当前任务相关源码和测试

之后同一会话遵循第 2.1 节的渐进读取规则，不重复整套阅读。若历史文档、旧聊天和当前 Git 状态冲突，以当前 Git 与源码为准。
