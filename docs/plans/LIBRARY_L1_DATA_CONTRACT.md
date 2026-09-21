# 作品设定库 L1 数据契约（冻结）

> 状态：**L1 冻结**（L1.1 产出）。实现依据：`docs/plans/LIBRARY_WORLD_FUSION_REPLAN.md`（v2，2026-09-17）。
> 基线：`7d1ee08`（= origin/main）。落地代码：`denova-src/internal/library`，测试：`denova-src/internal/library/store_test.go`。
> 本文件冻结 L1 需要的最小契约；**不**在本文件扩展现有 DTO，也不定义 L2 的模型读取授权。

## 1. 范围与不做什么

L1 交付“独立作品设定库的完整编辑体验”：用户**不需要先建书或建 World**就能创建一份库，
在其整理背景、条目、关联、事件与来源，设置三档加载，保存后刷新/重启仍在。

明确不做（留给后续阶段）：

- 不接写作/游戏/叙界/Module4 的运行取材（三档在 L1 只做保存与展示，**模型读取授权属 L2**）；
- 不迁移旧数据（`D:\` 旧 World / 作品 Lore 保持只读可用，L4 才处理）；
- 不新增 AI 调用、自动拆书、事实引擎、世界模拟或图数据库；
- 不删除或改写既有 World、作品 Lore、Master 原件、书籍、故事、冒险、存档；
- **不建立第二套原件/翻译系统**：来源只保存身份与版本指针，原件与翻译仍由 Master 负责。

## 2. 库身份

| 项 | 冻结值 |
| --- | --- |
| ID | 服务端生成，16 位小写字母数字（与 World 同规则） |
| SchemaVersion | `1`，服务端维护，客户端不可写 |
| Name | 必填，≤ 120 字符 |
| Summary / Tone / StartingPoint | 选填；≤ 4000 / 200 / 2000 字符 |
| Purpose | `any`(默认) / `writing` / `game` / `narraverse` / `sandbox` / `mixed`；仅用于列表筛选，**不决定存储归属** |
| 库级 revision | **不存库内**，由文件内容哈希给出（`sha256:…`），在 HTTP 信封 `{library, revision}` 返回 |

库可独立于书籍存在；同一份库可被多个消费者只读使用；平台不自动为四个模式各复制一份。

## 3. 存储位置与原子保存

```
<cfg.DataDir()>/libraries/library-<id>.json      ← 全局数据目录，与任何 workspace 无关
```

- 一个库一个文件，**不维护 index.json**；列表由目录扫描即时派生，计数值由内容派生不落盘。
- 全部写入走 `internal/revisionfile`：路径锁内 **读 → 改 → 临时文件 → fsync → 原子替换 → 目录同步**。
  进程崩溃不会留下半个文件；同库并发写不会互相覆盖（并发创建 N 条 = N 条都在，见测试）。
- 单库文件 ≤ **8 MiB**；库数量 ≤ 200（只限制新建，不阻止读取既有库）。
- 损坏文件不静默丢弃：进入 `List` 的 `warnings`，`Get` 返回“已损坏”错误，且**错误文案不含本机路径**。
- 读写权限：文件 `0644`，目录 `0755`。

## 4. 条目：稳定 ID、同名、内容省略语义

复用旧 Lore 条目字段（`enabled`/`type`/`name`/`importance`/`tags`/`briefDescription`/`keywords`/`loadMode`/`content`），
另加 `origin`/`source`/`fields`/`event`。

| 决定 | 冻结规则 |
| --- | --- |
| ID | 服务端生成：由名称派生词干（与旧 Lore 同规则），冲突追加 `-2`、`-3`……；**分配后永不改变**，改名不改 ID |
| 同名 | **允许同名条目**（与旧 Lore 不同，旧 Lore 拒绝重名）；名称只作展示与检索，引用一律走稳定 ID，不按名称合并 |
| 类型 | `character`/`world`/`location`/`faction`/`rule`/`item`/`other`（复用旧 Lore 词表）+ `event`/`ability`（设定库新增） |
| 重要度 | `major`/`important`(默认)/`minor`（复用旧 Lore 词表） |
| 正文上限 | 200 000 字符（存储边界，不等于可注入模型的长度） |
| 省略语义 | 更新时**省略字段 = 保持原值**；`content`/`briefDescription` 用指针区分“未提交”与“显式清空（空串）”。正文是用户最贵的资产，绝不因省略字段被清掉 |
| 类型专用字段 | `fields`（受控键值，≤ 40 键 × 2000 字符）；L1 不做动态 schema 编辑器 |

### 同一条目只有一份可写值

`fields`（如人物的“阵营”“武器”）、`content` 正文、`relations` 表三者不重复保存同一事实：
关系只存关系表，人物卡不另存“关系”字段；概览/摘要/时间线都是**只读派生**，不接受直接写入。

## 5. 并发：库级与条目级两套基线

| 场景 | 基线 | 冲突响应 |
| --- | --- | --- |
| 库元信息（名称/简介/用途/基调/起点） | `expected_revision`（文件内容哈希） | `409` + `code=revision_conflict` |
| 条目更新 | `baseUpdatedAt`（该条目磁盘上的 `updatedAt`） | `409` + `code=revision_conflict` |
| 删除被引用的条目 | — | `409` + `code=item_in_use` + 影响明细 |

- 客户端必须回传基线；不提供“强制覆盖”入口。
- 前端收到 `revision_conflict` 后**保留草稿**并提示重新加载（`src/lib/revision-conflict.ts` 的既有约定）。
- `item_in_use` **不是** revision conflict：前端不得把它当并发冲突自动重试。
- 时间戳由服务端生成且**严格单调递增**（同纳秒内连续写入也保证不同值），
  因此 `baseUpdatedAt` 作为并发基线是可靠的。

## 6. 加载档位（三档 + 总开关）

| 档位 | 语义 | L1 边界 |
| --- | --- | --- |
| `resident` 常驻 | 少量核心条目按有界全文加载 | L1 只保存与展示 |
| `auto` 按需 | 初始给有界目录，按需读正文 | **新条目默认值** |
| `manual` 手动 | 默认不进自动检索，用户显式选择后才提供 | L1 只保存与展示 |
| `enabled=false` | 总开关，不是第四档：不进目录/检索/读取 | L1 只保存与展示 |

- **档位与重要度解耦**：`major` 不会自动升为常驻（这是旧作品 Lore 的历史行为，设定库刻意不复用）。
- 未知档位字面量回落 `auto`，非法值不写入。

## 7. 来源引用：公共原件与本库改编

```jsonc
// Item.Source（SourceRef）
{ "kind": "master|lore|world|file|manual", "id": "…", "revision": "sha256:…",
  "locator": "相对定位或空", "label": "展示名", "updated": false }
```

- `origin` 决定本库对正文的编辑权：
  - `original` 本库原创 → 可编辑；
  - `adaptation` 复制来源后的**本项目可编辑改编** → 可编辑，且必须保留 `source`；
  - `reference` 对来源版本的**只读引用** → `name`/`content`/`fields` 不得变化（违反返回 `400 ErrReferenceReadOnly`），
    但允许调整 `enabled`/`loadMode`/`importance`/`tags`。
- 由 `reference` 显式改为 `original`/`adaptation` = “创建本项目版本”的显式动作，允许改写正文并**保留来源指向**。
- **原始文件绝对路径绝不入库**：`locator` 为盘符/UNC/POSIX 绝对路径时拒绝写入（防止本机路径泄露给模型或导出）。
- 来源版本固定：`revision` 记录引用时版本；来源更新只提示（`updated` 标记由服务端核对，客户端不可写）。
- 归档型引用只能是不可编辑的来源材料；它与本库改编不能同时冒充同一条目的真源。

## 8. 关系

- `relations[]`：`fromItemId`/`toItemId` 必须是**本库存在的条目稳定 ID**，两端相同拒绝（`ErrSelfRelation`）。
- `kind` 受控词表：`ally`/`rival`/`family`/`mentor`/`member_of`/`located_in`/`owns`/`knows`/`other`；
  `label` 为展示覆盖，`note` 为补充说明，`since`/`until` 为可选虚构时间范围（自由文本，不做数值解析）。
- 同 `(from,to,kind)` 重复拒绝；反向同类型允许（有向）。
- 悬空引用是**硬错误**：任何会产出悬空关系的写入都被拒绝（`ValidateLibrary` 兜底，不靠前端自觉）。

## 9. 事件与时间线：同源、单次保存

- **事件是一种条目**（`type=event`），不是第二张表；`EventDetail`：`order`（≤ ±1e6）、`era`、
  `category`（`background`/`historical`/`planned`，与旧 World 时间线可写词表一致）、
  `participantItemIds`、`locationItemId`。
- **时间线是派生视图**，不落盘：由所有事件条目按
  `类别（background→historical→planned）→ order → era → 名称 → ID` 排序生成，同一份数据两次派生逐字段一致。
- 事件只记录背景/历史/计划；新增事件**不自动更新人物状态**。
- 删除事件条目不影响参与人物（有测试锁定）。
- 旧值兼容：旧 World 时间线的 `canon`/空/未知类别在**展示层**归一，不在 L1 改写原始语义证据。

## 10. 删除影响

删除条目前必须能看见影响，且**不得静默产生悬空引用**：

1. `GET /items/:itemId/impact` → `{relations: [...], events: [...]}`（只读，不修改数据）；
2. `DELETE /items/:itemId` 在存在引用时返回 `409 item_in_use` **并带回影响明细**，数据不变；
3. `DELETE /items/:itemId?cascade=true` 才执行：删除条目 + 移除相关关系 + 从事件中摘掉参与者/地点引用，
   返回 `{deletedId, removedRelationIds, updatedEventIds}`。
4. 删除整个库需要 `expected_revision`（防止删掉别人刚改过的库）；删除库**不触碰**任何 World/Master/书籍数据。

## 11. HTTP 契约（L1 冻结）

命名空间刻意与既有 `/api/library/*`（Master 公共素材）区分：新库用 **`/api/work-libraries`**。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/work-libraries` | 列表 + warnings |
| POST | `/api/work-libraries` | 建库（`CreateInput`）→ 201 |
| GET | `/api/work-libraries/:id` | 取库 → `{library, revision}` |
| PATCH | `/api/work-libraries/:id` | 元信息 CAS（`expected_revision`） |
| DELETE | `/api/work-libraries/:id` | 删库（`expected_revision`） |
| GET | `/api/work-libraries/:id/timeline` | 派生时间线 |
| POST | `/api/work-libraries/:id/items` | 建条目 |
| PATCH | `/api/work-libraries/:id/items/:itemId` | 改条目（`baseUpdatedAt`） |
| DELETE | `/api/work-libraries/:id/items/:itemId` | 删条目（`?cascade=true`） |
| GET | `/api/work-libraries/:id/items/:itemId/impact` | 删除影响预览 |
| POST | `/api/work-libraries/:id/relations` | 建关系 |
| PATCH | `/api/work-libraries/:id/relations/:relationId` | 改关系 |
| DELETE | `/api/work-libraries/:id/relations/:relationId` | 删关系 |

响应约定：

- 成功：`{library, revision}` / `{item, revision}` / `{relation, revision}`（变更类接口都回新 revision）。
- 失败：`{"error": "...", "code": "..."}`；`code` 取值见下表。**任何错误都不得包含本机路径。**
- 这些路由**不要求 workspace**（`requireWorkspace` 不适用）：库必须能在没有书的情况下使用。

| code | HTTP | 含义 |
| --- | --- | --- |
| `validation_failed` | 400 | 字段校验失败（含超限） |
| `invalid_id` | 400 | 库 ID 非法 |
| `not_found` | 404 | 库不存在 |
| `item_not_found` / `relation_not_found` | 404 | 条目/关系不存在 |
| `revision_conflict` | 409 | 并发保存冲突（库级或条目级） |
| `item_in_use` | 409 | 条目仍被引用，需显式级联 |
| `reference_read_only` | 400 | 试图改写只读引用条目的来源内容 |
| `duplicate_relation` / `self_relation` | 400 | 关系约束 |
| `library_invalid` | 500 | 文件损坏等内部错误（脱敏） |

## 12. 上限汇总（超限即 400，绝不静默截断）

| 项 | 上限 |
| --- | --- |
| 单库文件 | 8 MiB |
| 库数量 | 200 |
| 条目 / 关系 / 事件条目 | 2000 / 4000 / 500 |
| 库名 / 简介 / 基调 / 起点 | 120 / 4000 / 200 / 2000 |
| 条目名 / 简介 / 正文 | 120 / 500 / 200 000 |
| 标签 / 关键词 | 各 30 / 50（单项 ≤ 60） |
| `fields` | 40 键 × 2000 字符 |
| 来源 `locator` / `label` / `id` / `revision` | 300 / 200 / 200 / 200 |
| 关系 `note` / `label` | 2000 / 120 |
| 事件 `order` / `participants` | ±1 000 000 / 50 |

这些是**存储与编辑**上限，不是模型读取预算：L2 的常驻/按需/单轮合计预算另行定义，两者不得相加当作模型容量。

## 13. 与旧体系的复用边界

| 复用 | 方式 |
| --- | --- |
| 条目词表（类型/重要度/ID 词干/字符串规范化） | `internal/book` 导出（`lore_vocabulary.go`），**一套实现** |
| 加载档位字面量 | `book.LoreLoadMode*` 常量 + `book.NormalizeLoreLoadModeStrict`（不含 major→常驻升级） |
| 原子保存与 CAS | `internal/revisionfile`（与 World 同一机制） |
| 条目/来源字段形态 | 对齐 `book.LoreItem` / `book.LoreProvenance` 语义 |
| 客户端并发恢复 | `web/src/lib/revision-conflict.ts` 既有约定 |

不复用：旧 `book.LoreStore`（workspace 作用域、拒绝重名、把 `major` 升级为常驻），
新库需要库级作用域、允许重名、档位与重要度解耦，因此另建 `internal/library`，
但**不**把新子系统塞进 `book/lore.go`，也不新建原件/翻译体系。
