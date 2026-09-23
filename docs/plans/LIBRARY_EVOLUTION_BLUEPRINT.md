# 作品设定库 L2–L4 总骨架与接手入口

更新：2026-09-23。源码基线 main `3f226e1`；本轮未提交工作须以 git diff 和未跟踪文件为准。
状态：**L1/L2 已本地验收（含独立列明的外壳告警），尚未提交；L3/L4 仅骨架，不代表功能完成。**

## 1. 为什么这样分层

产品方向：用作品设定库完整描述一部作品/设定世界，不要求先维护一份 Library 再复制到独立 World。
原来的 World 和 Lore 已有真实用户数据与运行链，暂时保留，不直接删除、不一次性重写。
先让新库可可靠读取，再接真实模式，最后经用户确认迁移旧资料，避免同时改三套所有权。

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

旧 World / 作品 Lore ── L4 盘点 → dry-run → 用户确认 → 新 Library
                            └→ 原件保留；备份、幂等、回滚、核验
```

**不是**“任何数据只能有一个文件”：Master、Library、旧World、运行存档各有自己的职责；
禁止的是把同一份作品设定复制成两份都能随意编辑的真源。

## 2. 事实、目标与未来严格分开

| 层 | 当前真实状态 | 交付目标 |
| --- | --- | --- |
| L1 | main 已有存储/API/UI；本轮修引用 origin、草稿/异步串库、级联时间戳与HTTP基线，已本地验收，修复未提交 | 整理、保存、重启后可靠存在 |
| L2 | 纯读取核心、受控 Master resolver、只读 HTTP 和预览 UI 已实现；自动门禁及正式页面/重启验收通过，未提交 | 加载规则真正生效且可解释、可验证 |
| L3 | 本轮只有文档/目录边界；旧 WorldContext 已接四模式，不等于新 Library 已接 | 用户从设定库进入模式，真实模型使用获准背景 |
| L4 | 本轮只有方案/目录边界；没有执行迁移 | 用户自选旧资料、预览确认、可靠迁入新库 |

本轮范围以最新用户指令“先搭骨架”为先。之后继续补全 L1/L2；
L3/L4 的骨架不是自动授权改模式、迁移或清理用户资料。

## 3. 文档单一入口

- L1 已有契约：[LIBRARY_L1_DATA_CONTRACT.md](LIBRARY_L1_DATA_CONTRACT.md)。
- L1/L2 实施与验收事实：[LIBRARY_RUNTIME_IMPLEMENTATION_PLAN.md](LIBRARY_RUNTIME_IMPLEMENTATION_PLAN.md)。
- 多 AI 接手与 L1–L4 唯一勾选表：[LIBRARY_EVOLUTION_TASK_CHECKLIST.md](LIBRARY_EVOLUTION_TASK_CHECKLIST.md)。
- L2 读取语义/预算/只读HTTP：[LIBRARY_L2_READ_CONTRACT.md](LIBRARY_L2_READ_CONTRACT.md)。
- L3 文件范围、接入顺序、验收：[LIBRARY_L3_MODE_INTEGRATION_PLAN.md](LIBRARY_L3_MODE_INTEGRATION_PLAN.md)。
- L4 映射、dry-run、备份、回滚：[LIBRARY_L4_MIGRATION_PLAN.md](LIBRARY_L4_MIGRATION_PLAN.md)。

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
| internal/libraryruntime/（边界占位） | L3 若确有跨模式共用的读取授权/临时输入适配 | 第二套模型链、复制 World Registry |
| internal/librarymigration/（边界占位） | L4 纯映射、冲突与幂等计划 | 启动即迁移、删除原件 |

占位目录只有职责说明，不注册 API、不返回假成功、不填入 TODO 服务。
App/handlers/routes/main.tsx/共享 i18n/协作日志由集成者单独修改，禁止多 AI 同时争用。
L2完成后可并行做 L3 接口设计与 L4只读样例映射；**同一工作树不要并行改生产代码**。

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

## 6. 继续建设顺序

L1 余项收口 → L2 纯核 → Master解析/预算 → HTTP/UI → L2真实只读验收
→ L3写作纵向闭环 → 游戏 → 受控叙界/沙盒 → 四模式验收
→ L4只读盘点/预览 → 备份与显式apply → 幂等/回滚验收 → 用户决定旧入口退役。

下一位 AI 首先读本文件、L1/L2进度表、两份 AGENTS 与最新日志，再看任务局部 diff。
不能把目录存在、接口类型存在、按钮存在或模型返回200当作整层完成。

## 7. 交接检查点

1. 接手先检查 HEAD、工作树与未跟踪文件；当前代码/文档尚未提交，不能只看 `git diff` 而漏掉新文件。
2. L1/L2 已本地收口；从进度表及验收记录核对真实覆盖边界，不要再创建第二套读取器，也不要把本地通过当成已发布。
3. L3/L4 的文件范围仍是规划，涉及 transport、运行身份和真实迁移时需核对实际调用点并锁定契约；不得把本文当作自动迁移用户数据的授权。
4. 共享文件（CHANGELOG、日志、路由、i18n）当前含并行任务改动。提交时按内容核对，禁止整树暂存，禁止为了干净而还原别人的修改。
