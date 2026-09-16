# Narraverse2.0 文档索引

> 更新：2026-09-16。本文是文档导航，不替代源码、Git 状态或验收记录。

## 先读什么

新开发者或新的 AI 应按下列顺序定位：

1. 根目录 `AGENTS.md`、`项目协作日志.md` 与 `README.md`。
2. [项目当前状态与交接](PROJECT_STATUS_2026-09-16.md)。
3. [架构总蓝图](ARCHITECTURE_MASTER_BLUEPRINT.md)。
4. [待重新立项清单](NEXT_PROJECT_BACKLOG.md)。
5. 仅在需要追溯某个阶段的决策或验收时，打开 `archive/` 中相应材料。

## 在用文档

| 类别 | 位置 | 用途 |
| --- | --- | --- |
| 当前事实 | [PROJECT_STATUS_2026-09-16.md](PROJECT_STATUS_2026-09-16.md) | 当前 `main`、本地部署、已交付能力、局限与本机资产边界。 |
| 架构不变量 | [ARCHITECTURE_MASTER_BLUEPRINT.md](ARCHITECTURE_MASTER_BLUEPRINT.md) | World 单一真源、运行态隔离、AI 与四模式边界。 |
| 路线方向 | [ARCHITECTURE_ROADMAP.md](ARCHITECTURE_ROADMAP.md) | 已完成阶段与长期方向；不等于已授权开发。 |
| 重新立项入口 | [NEXT_PROJECT_BACKLOG.md](NEXT_PROJECT_BACKLOG.md) | 尚未实施、需重新验证或需用户选择优先级的事项。 |
| 协作和部署规则 | `交付/AI协作决策原则.md`、`交付/Narraverse2.0交接指南.md`、`交付/Narraverse2.0交付清单.md` | 协作边界、Windows 部署与交付基线。 |
| 架构图 | `architecture/` | 已生成的可视化辅助资料；代码和蓝图优先于图中的旧状态文字。 |

## 已完成阶段归档

这些材料保留为审计与复现依据，不应再被误读为当前实施任务：

| 归档位置 | 内容 |
| --- | --- |
| `archive/2026-09-world-workspace/plans/` | World Workspace Phase 1–3.2 的实施/架构计划。 |
| `archive/2026-09-world-workspace/reviews/` | Phase 2–3 的架构与代码复审。 |
| `archive/2026-09-world-workspace/acceptance/` | Phase 2A、2B、3.2 的独立验收和真实生成证据。 |
| `archive/2026-09-module4-v1/` | Module4 v1/V1.5 已交付基线与改造方案。 |
| `archive/2026-09-translation/` | 2026-09-04 翻译修复的方案、复审与最终交付版本。 |
| `archive/legacy-platform/`、`归档/`、`阶段归档/`、`_history/` | 更早的整合决策和迁移历史。 |

## 尚未实施的材料

`future/` 仅存放待重新评估的设计输入：

- `future/module4/`：Module4 V2 玩法概念，尚未进入规格、编码或验收。
- `future/legacy-proposals/three-mode-play/`：三模式游玩体验方案，尚未按该方案实施。
- 本机旧工作区内的研究/原型见当前状态文档的“本地保留资产”；它们不是 GitHub `main` 的已实现功能。

任何人要开始这些方向，先在 [NEXT_PROJECT_BACKLOG.md](NEXT_PROJECT_BACKLOG.md) 中建立新的任务范围和验收标准；不得把历史方案直接当作可执行指令。
