# Narraverse 2.0 文档索引

> 更新：2026-09-21（main HEAD `0ea84eb`，Phase 3.2 与 Phase 5 L1 已合入主干）。本文是文档导航，不替代源码、Git 状态或验收记录。

## 先读什么

新开发者或新的 AI 应按下列顺序定位：

1. 根目录 `AGENTS.md`、`项目协作日志.md` 与 `README.md`。
2. [项目文档状态全景（2026-09-21）](项目文档状态全景-2026-09-21.md)——已完成/执行中/规划中/未实现/遗漏矛盾的全量盘点。
3. [架构总蓝图](ARCHITECTURE_MASTER_BLUEPRINT.md) 与 [架构路线图](ARCHITECTURE_ROADMAP.md)。
4. [下一项目待办与重新立项清单](NEXT_PROJECT_BACKLOG.md)。
5. 仅在需要追溯某个阶段的决策或验收时，打开归档区相应材料。

## 在用文档

作品设定库接手先读 [L2–L4 总骨架](plans/LIBRARY_EVOLUTION_BLUEPRINT.md)，再看 [多 AI 交接任务清单](plans/LIBRARY_EVOLUTION_TASK_CHECKLIST.md) 的实时勾选状态；[L1/L2 实施记录](plans/LIBRARY_RUNTIME_IMPLEMENTATION_PLAN.md) 与 [验收报告](acceptance/LIBRARY_L1_L2_ACCEPTANCE.md) 提供已完成部分的证据。不要以旧路线图的“尚无文档”为准。

| 类别 | 位置 | 用途 |
| --- | --- | --- |
| 全景事实 | [项目文档状态全景-2026-09-21.md](项目文档状态全景-2026-09-21.md) | 全量文档分类、分支/代码事实落差、遗漏矛盾清单 |
| 架构不变量 | [ARCHITECTURE_MASTER_BLUEPRINT.md](ARCHITECTURE_MASTER_BLUEPRINT.md) | World 单一真源、运行态隔离、AI 与四模式边界 |
| 路线方向 | [ARCHITECTURE_ROADMAP.md](ARCHITECTURE_ROADMAP.md) | 已完成阶段与长期方向；不等于已授权开发 |
| Phase 3 计划 | [plans/WORLD_WORKSPACE_PHASE3_ARCHITECTURE_PLAN.md](plans/WORLD_WORKSPACE_PHASE3_ARCHITECTURE_PLAN.md) | Phase 3 架构 v2.7（3.0/3.1/3.2） |
| Phase 3.2-C0 安全门 | [plans/WORLD_WORKSPACE_PHASE3_2_C0_IFRAME_SECURITY_DESIGN.md](plans/WORLD_WORKSPACE_PHASE3_2_C0_IFRAME_SECURITY_DESIGN.md) | iframe bootstrap secret / sandbox / 独立 origin |
| Phase 5 L1 数据契约 | [plans/LIBRARY_L1_DATA_CONTRACT.md](plans/LIBRARY_L1_DATA_CONTRACT.md) | 独立作品设定库 L1 数据契约（已实现） |
| 重新立项入口 | [NEXT_PROJECT_BACKLOG.md](NEXT_PROJECT_BACKLOG.md) | 尚未实施、需重新验证或需用户选择优先级的事项 |
| 协作与部署 | `交付/AI协作决策原则.md`、`交付/Narraverse2.0交接指南.md`、`交付/Narraverse2.0交付清单.md` | 协作边界、Windows 部署与交付基线 |
| 模式设计 | `模式设计/` | 新模式提案（如 Denova 养成攻略模式，仅有设计稿） |
| 验收记录 | `acceptance/` | Phase 2A/2B/3.2 独立验收与真实生成证据（现行目录） |

## 归档区（审计与复现依据，不是当前任务）

| 位置 | 内容 |
| --- | --- |
| `归档/2026-09-21-整理/01-根级历史文档/` | Denova 1.0 三件套、迁移清单、模块四改造总结、诊断日志 |
| `归档/2026-09-21-整理/02-docs历史方案/` | 翻译修复方案×3、模块四方案、早期架构图、reviews、Phase2 阶段计划、superpowers 早期设计（含 `README-归档说明.md` 清单） |
| `归档/2026-09-21-整理/03-验收审查产物/` | 阶段验收/审查机器产物（**已入 .gitignore，不入库**） |
| `归档/2026-09-21-整理/04-其他/` | Dify 角色卡分类 v1/v2（v3 在根 `artifacts/`） |
| `阶段归档/模块四P0发布/` | Module4 P0 发布验收材料 |
| `_history/` | 2026-08 早期方案（总资料库 v1–v3、三模式、Denova 入口等） |
| `_local-archive/`（**未入 git**） | Phase 2/3 计划与验收原件、早期原型、研究报告；本机资产 |
| `归档/` 根目录 | 平台整合规划说明书早期版本（v1–v3、实地版、版本比对） |

## 尚未实施的材料

- 根目录 `平台整合规划说明书.md`（v4 决策锁定版）：P3 写作工程化 / P4 第三套中性视觉 / P5 换机迁移 / iframe 外壳路线**未落地**，且与"Denova 唯一宿主"现行路线存在分叉，启动前需先确认取舍（见状态全景第五节）。
- `模式设计/Denova-养成攻略模式-模式定位与核心数值.md`：仅有设计稿，无代码、无路线图条目。
- `design-previews/`（未入 git）：6 版 UI 原型，纯展示未接代码。
- knowledge-base 中带 NSFW/草稿标记的素材与 `knowledge-base/草稿/`：创作素材，不是功能。

任何人要开始上述方向，先在 [NEXT_PROJECT_BACKLOG.md](NEXT_PROJECT_BACKLOG.md) 建立任务范围与验收标准；不得把历史方案直接当作可执行指令。
