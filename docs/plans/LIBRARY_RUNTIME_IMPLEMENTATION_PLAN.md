# 作品设定库 L1 收口与 L2 实施计划

更新：2026-09-23。基线 main `3f226e1`。本轮授权：补全 L1、完成 L2；L3 模式接入和 L4 迁移仅列后续边界。实现尚未提交，状态不是发布承诺。

总导航：[LIBRARY_EVOLUTION_BLUEPRINT.md](LIBRARY_EVOLUTION_BLUEPRINT.md)。本文保留 L1/L2 实施与验收事实；跨 AI 的后续任务状态统一在 [L1–L4 交接任务清单](LIBRARY_EVOLUTION_TASK_CHECKLIST.md) 勾选。L3/L4 分层骨架已建立，未接运行态、未迁移数据。

最终验收：2026-09-23 **PASS WITH FOLLOW-UPS**，见 [L1/L2 验收记录](../acceptance/LIBRARY_L1_L2_ACCEPTANCE.md)。以下代码已完成本地验证但未提交/部署到用户服务；外壳告警和覆盖边界以报告为准。

## 事实与目标

L1 已有独立库、条目、关系、事件、来源指针和三档设置；三档尚未参与新库的模型取材。旧 Lore 已有常驻正文、目录和按需读取；四模式已有旧 WorldContext 链路。二者都不是新作品设定库已接入模型的证明。

L2 交付可验证的只读资料读取核心、受控来源解析、预算和前端加载预览。模型实际接入属于 L3，不能把预览说成“已经送模”。本计划自包含，不依赖未入库的 LIBRARY_WORLD_FUSION_REPLAN.md。

## 不变量

- Master 管原件；Library 管本作品确认的设定；模式运行数据管剧情和进度。不得把新库复制到 World 作为另一份可编辑设定。
- original/adaptation 读取本库正文；reference 解析明确的来源版本。来源变化不得覆盖改编。
- stable item ID 是引用依据，名称允许重复。library.purpose 是分类，不是读取授权。
- enabled=false 不可被目录、检索或显式请求绕过；manual 仅在用户明确选择后读取；auto 初始只提供目录；resident 提供有界正文。
- 关系和事件不扩大授权集合；未选择实体的关系信息不能随正文结构自动泄漏。
- 读取结果仅请求内派生，不持久化、不改原件或库、不创建 Registry/runContext/Task、不调用模型。
- 来源 locator 不是任意文件读取授权。第一版可读取本库及已登记 Master；其他来源类型明确返回未支持，不猜路径。
- 原有 World、旧 Lore 和用户数据保留；不迁移、不退役入口、不重构 Module3/4。

## 执行任务

| 阶段 | 文件范围 | 验收条件 | 状态 |
| --- | --- | --- | --- |
| L1 修复 | internal/library/store.go 与测试；handler_library_workspace.go；library-workspace 编辑器、hook 与测试 | 省略 origin 不改变来源形态；新建/离开保留草稿；迟到请求不串库；冲突不丢内容 | 完成；另修级联事件时间戳与HTTP缺失更新基线，真实编辑/重启通过 |
| L2.1 读取核心 | internal/librarycontext/ | 三档分类、ID 去重和范围检查、禁用拒绝、确定性结果、输入不变 | 已实现；核心及来源错误矩阵、预算统计测试通过 |
| L2.2 解析与预算 | internal/librarycontext/；internal/app/library_context_service.go | 来源版本验证、Master 字段筛选、总量预算、错误脱敏、零写入 | 已实现；虚构 Master 原件解析、库/原件不变测试通过 |
| L2.3 HTTP 与预览 | 单独 handler/DTO；既有 routes 注册；library-workspace 预览组件/API/zh-en | 请求严格解码；不触发模型；预览标注候选和实际读取；竞态与空/错误状态正确 | 完成；严格请求、错误矩阵、组件测试及真实浏览器通过 |
| L2 验收 | 定向 Go/前端测试；构建；独立测试库与真实页面 | 重启持久化、预览前后库/原件哈希不变、无新持久化、浏览器请求符合边界 | 完成；正式exe 23项检查、全前端1296项、Go相关门禁通过，外壳告警单列 |

## 后续边界（本轮不实施）

L3：先写作完整闭环，再游戏，再叙界/沙盒。每次运行选择一份库；复用模型配置和调用入口，不新造网关。明确选择新库或旧背景来源，拒绝冲突控制字段，不能默默叠加旧 Lore/World。按需工具的正文也必须在日志/压缩/会话持久化边界审计；Task 与 InteractiveRun 不改义。

L4：旧 World/Lore 到 Library 的预览映射、备份、用户确认、可回滚迁移、核验；核验后再讨论退役旧入口。Obsidian 和关系图谱仅为未来只读投影。

## 验证与交接

2026-09-23 独立复跑：

- `go test ./internal/librarycontext ./internal/library -count=1`：两个包通过。
- `go test ./internal/app ./internal/api -run 'TestLibrary(ContextPreview|Preview)' -count=1`：两个包实际命中并通过，不能代表整个 app/api 包全过。
- web：`vitest run src/features/library-workspace`：14 文件 / 44 测试通过；`tsc --noEmit` 通过；`node scripts/check-i18n-keys.mjs`：4132 键对齐。
- 已重建最新隔离 Go executable 和 Vite 产物（`artifacts/library-l2/`），实际同源页面完成23项检查和重启验证。产物不是源码，不提交。
- 全量前端207文件/1296测试通过；Go相关包、vet通过。未跑真实模型（L2 不应调用）或全仓Go；Master成功读取使用真实临时磁盘集成而非用户原库，详见验收记录。

上述 HTTP 错误/并发、构建、页面/重启、只读哈希与自审已完成。下一步是用户审阅/决定提交，再按 L3 计划核对运行适配契约；不可直接迁移资料或宣称新库已送模。所有本次测试进程已停止，用户服务未动。

先定向回归，再相关包和前端构建；错误必须区分产品回归与现有 Windows symlink 环境限制。实际页面未完成前不得写“全部验收通过”。不读取密钥和完整用户存档；验收只用明确的测试库。保护当前知识库脏改动和运行产物。

后续 AI 从本文件、LIBRARY_L2_READ_CONTRACT.md、两份 AGENTS.md、最新日志与真实 git diff 接手。完成任务时更新状态、实际命令/结果和未验证项；不以聊天中的旧 SHA 代替当前 Git。按功能独立提交英文 message，精确暂存，不自动推送或合并。
