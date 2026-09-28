# 作品设定库 L2–L4 总骨架与接手入口

更新：2026-09-28。历史基线说明见 Git；接手时必须重查当前 HEAD、工作树和验收证据。
状态：L1/L2 已实现；L3 四模式工程验收见 `docs/acceptance/LIBRARY_L3_B5_FINAL_ACCEPTANCE.md`，L3 已通过 PR #4 合入 GitHub `main`（`81e201c`），但用户正在运行的实例是否使用该版本须单独核对。**L3 是新 Library 产品主闭环；L4 是按需整理旧资料，不是前置条件。**

## 1. 为什么这样分层

产品方向：用作品设定库完整描述一部作品/设定世界，不要求先维护一份 Library 再复制到独立 World。
原来的 World 和 Lore 已有真实用户数据与运行链，暂时保留，不直接删除、不一次性重写。
先让新库可可靠读取，再接真实模式。用户目前没有要批量迁移的旧资料；旧数据可保留，个别有价值内容日后按需整理，不为了完成路线图而搬迁。

```text
Master 原件 ─── 明确版本引用 ─┐
用户原创/本地改编 ──────────┤
                            ▼
L1 作品设定库（唯一可编辑的本作品设定）
                            │ 只读
                            ▼
L2 读取核心 → 目录 / 选中正文 / 来源状态 / 预算 / 预览
                            │ 有限授权，不复制成 World
                            ▼
L3 受控模式适配 → 写作 → 游戏 → 叙界 → Module4
                            └→ 剧情、进度在各模式自己的存储；不回写 Library

旧 World / 作品 Lore / Master ── 用户确有需要时指定片段
                                  → Agent 在已授权范围内辅助阅读、形成草稿
                                  → 用户核对并通过现有编辑器保存至 Library
旧来源原样保留；没有选定资料时 L4 可结束，绝不自动迁移。
```

**不是**“任何数据只能有一个文件”：Master、Library、旧World、运行存档各有自己的职责；
禁止的是把同一份作品设定复制成两份都能随意编辑的真源。

## 2. 事实、目标与未来严格分开

| 层 | 当前真实状态 | 交付目标 |
| --- | --- | --- |
| L1 | 独立 Library 持久化、API 和编辑页面已实现；具体提交/部署见清单 | 作品设定可保存、重启后存在 |
| L2 | 受控读取、Master resolver、预算和只读预览已实现 | 加载规则可解释、可验证 |
| L3 | `library-b2a` 已形成四模式工程验收证据；发布状态与用户现用版本须另核 | 新 Library 作为四模式明确选择的只读背景；剧情不回写 |
| L4 | 用户目前未提出要迁的具体旧资料；C1/C2a 只读实验在本地分支，C2b 页面未完成正式验收，均非主产品依赖 | 无资料可整理时合法结束；日后单条按需整理，不启动批量迁移 |

文档中的“工程验收”不等于已部署到每个用户实例；也不授权 Agent 自动写库、改旧资料或清理旧入口。

## 3. 文档单一入口

- L1 已有契约：[LIBRARY_L1_DATA_CONTRACT.md](LIBRARY_L1_DATA_CONTRACT.md)。
- L1/L2 实施与验收事实：[LIBRARY_RUNTIME_IMPLEMENTATION_PLAN.md](LIBRARY_RUNTIME_IMPLEMENTATION_PLAN.md)。
- 多 AI 接手与 L1–L4 唯一勾选表：[LIBRARY_EVOLUTION_TASK_CHECKLIST.md](LIBRARY_EVOLUTION_TASK_CHECKLIST.md)。
- L2 读取语义/预算/只读HTTP：[LIBRARY_L2_READ_CONTRACT.md](LIBRARY_L2_READ_CONTRACT.md)。
- L3 文件范围、接入顺序、验收：[LIBRARY_L3_MODE_INTEGRATION_PLAN.md](LIBRARY_L3_MODE_INTEGRATION_PLAN.md)。
- L4 按需旧资料整理与已暂停实验：[LIBRARY_L4_MIGRATION_PLAN.md](LIBRARY_L4_MIGRATION_PLAN.md)。

不要另建同义路线图。改范围先改对应契约，并在协作日志说明原因。
旧路线图中的阶段编号是历史产品大阶段；这里 L1–L4 专指作品设定库工程层，不能混叫 Phase 3.2 的 A/B/C。

## 4. 文件所有权与分工

| 区域 | 负责什么 | 禁止什么 |
| --- | --- | --- |
| internal/library/ | L1 持久数据与原子更新 | 模型请求、运行上下文存储 |
| internal/librarycontext/ | L2 选择、只读解析接口、预算、派生结构 | 数据写入、任意文件读取、Registry |
| internal/app/library_context_service.go | 读库版本、注入 Master resolver | 扫描全部原件、默默采用新版本 |
| internal/api/handlers/handler_library_context_preview.go、library_context_preview_dto.go | 严格 transport DTO | 直接暴露内部 Request 或运行字段 |
| web/.../library-workspace/ | L1 编辑与 L2 预览 | 把预览保存为新数据、伪称已送模 |
| internal/libraryruntime/ | L3 已实现跨模式受控读取授权与临时输入适配 | 第二套模型链、复制 World Registry |
| internal/librarymigration/（本地分支实验） | 已有单来源纯映射；仅供将来用户明确提出导入需求时评估 | 将实验代码当成产品必需、启动即迁移、删除原件 |

`library-b2a` 本地已有只读来源/预览 API；它们不提供 apply 授权，也不表示 L4 要继续开发。
App/handlers/routes/main.tsx/共享 i18n/协作日志由集成者单独修改，禁止多 AI 同时争用。**同一工作树不要并行改生产代码。**

## 5. 防跑偏规则

1. enabled=false 是总开关；manual 不是让模型自由猜到 ID 就能读。
2. 读取按稳定 ID，名字允许重复；purpose 只是分类，不是安全凭证。
3. 原件引用、改编、原创分清；source locator 不授权任意磁盘路径。
4. 模型只有分析/生成能力，无自动写设定库权限。剧情写回须未来独立“提案→用户确认”，本轮不做。
5. 同一次运行只显式选择一种作品背景源；不暗中叠加 Library+World+旧 Lore。
6. 模型配置/Key/网关沿用既有共享 Settings；不用新服务、新 Agent 系统或新数据库。
7. 目录/关系/事件不能扩大正文授权范围；token 限制不允许以静默截断伪装成功。
8. 所有“通过”附实际命令、命中用例/页面证据；单测绿不等于真实模型已用到背景。
9. 日志不包含正文、Key、完整存档、绝对来源路径；报告只用虚构验收资料。
10. 不自动提交/推送，不替换当前用户服务，不清除其他任务的脏改动。
11. 配置管理 Agent 当前能读 Master 和当前作品 Lore，但没有直接写入独立 Work Library 的工具；旧 World 不可假定有 Agent 受控读取入口。`lore/world/file` 手填 reference 在 L3 运行时不解析正文，不能冒充可用背景。罕见旧内容须经用户核对后保存为 `original/adaptation` 正文；已核验 Master 才可保留真正的 `reference`。
12. 不因存在旧 World/Lore 文件而要求盘点、导入或退役；无用户选定资料时 L4 记为“无需导入/零数据变更”。

## 6. 继续建设顺序

L1 持久化 → L2 受控读取 → L3 写作/游戏/叙界/沙盒真实消费与验收
→ **新 Library 主产品闭环**。

L4 为独立、可选的旧资料整理：没有具体资料时结束；需要单条内容时，用户指定来源 → Agent 在现有权限内辅助阅读/提炼 → 用户核对 → 现有 Library 编辑器保存 → L2 预览并按需验证目标模式。批量导入另立需求，不由本路线自动触发。

下一位 AI 首先读本文件、L1/L2进度表、两份 AGENTS 与最新日志，再看任务局部 diff。
不能把目录存在、接口类型存在、按钮存在或模型返回200当作整层完成。

## 7. 交接检查点

1. 接手先检查 HEAD、工作树与未跟踪文件；当前代码/文档尚未提交，不能只看 `git diff` 而漏掉新文件。
2. 从进度表及验收记录核对 L1–L3 的实现、验收和部署三个不同状态；本地通过不等于已发布。
3. L4 当前只保留按需整理决策；C1/C2a 是本地分支只读实验，C2b 未完成正式验收，不据此启动 apply、批量扫描或新 Agent 工具。
4. 共享文件（CHANGELOG、日志、路由、i18n）当前含并行任务改动。提交时按内容核对，禁止整树暂存，禁止为了干净而还原别人的修改。
