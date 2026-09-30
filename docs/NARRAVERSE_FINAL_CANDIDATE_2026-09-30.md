# Narraverse 2.0 统一源码候选（2026-09-30）

## 唯一继续开发的候选

- 分支：`codex/narraverse-final-candidate`，工作树：`D:\Narraverse2.0-final`。
- 从远端 `main @ 5ea0be2` 建立，合入 Laya 融合分支 `699ea2d`，再合入跨入口事件身份修复 `cd72a0a`。三者均是本候选的 Git 祖先。主线与 Laya 的玩法代码合并没有冲突；两次冲突都只在协作日志，已保留两边全部带时间的记录。
- 这是**统一源码候选**，不是已部署、同版验收通过或带版本标签的正式 Release。当前 8132 试玩进程仍来自先前的 Laya 融合工作树，并不证明本候选运行成功。

## 保存与验证边界

- `git diff --check` 与合并后工作树状态核对通过；协作日志逐条标题与 `origin/main`、Laya 融合分支、ZCode 修复分支比较，缺失均为 0。
- Git bundle：`E:\Narraverse2.0-backups\narraverse-20260930-final-candidate.bundle`，创建及 `git bundle verify` 通过。它包含创建时的已提交引用，**不包含**其他工作树的未提交文件、被忽略文件或运行数据。
- 本轮没有运行自动化测试、真实模型、完整浏览器链或部署。跨入口修复与两条代码线的组合仍须在后续验收中验证；不能把各来源分支过去的通过计数当成本候选的新测试结果。

## 旧分支处置

| 对象 | 处置建议 | 原因 |
| --- | --- | --- |
| `laya-p2-safe`、`zcode/review-delivery-evidence`、`zcode/fix-delivery-r1` | 归档后可删除分支引用 | 提交均已包含于统一候选；后两者仍有工作树或审查证据，清理工作树前须另核未提交与忽略文件。 |
| 候选 A、B、C（`codex/interaction-core-a`、`laya-b-freeform`、`candidate-c-interaction-core`） | 保留为历史实验，核对资产后归档分支 | 各有独有的替代方案提交；本轮没有把三套并行实现整包搬进最终玩法。 |
| `docs/project-docs-consolidation` | 保留待单独文档审阅 | 有 2 个未纳入统一候选的文档整理提交，部分材料早于当前阶段，不盲合并。 |
| `library-b2a`、`codex/kate-marker-review`、本地 `main` | 保留工作树与引用 | 前两者有独有提交、忽略或未跟踪资料；本地 `main` 与远端分叉并有大量并行未提交改动。Git bundle 不保护这些内容。 |
| `docs/library-world-replan`、`codex/library-l3-closeout` 等旧文档/阶段引用 | 逐项核对后归档 | 文档树可能仍有未提交或忽略内容；仅凭提交数量不能判断目录可删。 |

本轮**不删除**任何现存分支、工作树、运行数据或远端引用。删除前应列出精确目标，检查进程、独有提交、未提交和忽略资产，并明确回退方式。

## 运行恢复事项

`D:\Narraverse2.0-runtime` 仍在；此前 L3 发布工作树和 Laya `_models` / `.venv-cuda` 所在的 `D:\Narraverse2.0-wt-laya` 已在清理中移除。8132 当前健康接口可用，但它报告的模型路径指向已不存在的目录。下次重启前须从受保存的资产恢复模型环境并建立独立、可重启的启动目录。此项未在本轮执行。
