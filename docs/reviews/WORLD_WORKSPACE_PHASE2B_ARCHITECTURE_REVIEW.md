# World Workspace Phase 2B 架构审查

- 审查日期：2026-09-10（Asia/Shanghai）
- 审查基线：`main` commit `01253b9f33feaab6e83565c17c842ad1eceaf8f2`
- 被审查文档：`docs/plans/WORLD_WORKSPACE_PHASE2B_DESIGN_PLAN.md` v1
- 审查范围：数据分层、Binding Ownership、AI 提案边界、时间线语义、AI 输入边界、Phase 2B.1 可实施性
- 审查结论：**Changes requested；修订后允许进入 Phase 2B.1，当前 v1 不应直接作为编码任务书。**

本次只做架构审查，没有修改生产代码、没有运行构建或测试，也没有进入 Phase 2B 实现。

---

## 1. 总结论

方案的主体方向是正确的：以 World 为主体、Master Library 为只读素材源、AI 只生成待确认提案，并继续复用 Phase 1/2A 已成立的服务端真源、薄快照、内容哈希 CAS、按需健康检查和人工确认机制。这些设计可以保留。

但 v1 仍有五项必须冻结的契约：

1. `WorldAssetBinding` 保留 `scope`，删除 `ownerId`，也不新增持久化 `references[]`。
2. `StructureProposal` 在 2B.2 明确定义为可丢失的一次性会话草稿，不建设持久任务系统。
3. 产品与新数据契约停止使用 Canon；旧 `canon` 仅作兼容读取。
4. AI 输入限定为 Master Library 结构化字段和用户主动选择的片段，禁止自动读取全文小说或完整互动故事。
5. 2B.1 只做不依赖 AI、且当前接口真实支持的绑定底座；不得假设总资料库已经暴露独立地点/势力资产。

完成这些修订后，Phase 2B.1 可以开始；Phase 2B.2 仍须单独审查模型调用与数据边界。

---

## 2. 已核对的当前事实

| 事实 | 代码证据 | 对方案的影响 |
| --- | --- | --- |
| `World.bindings[]` 是绑定薄快照的唯一存储位置 | `web/src/features/world-workspace/types.ts` | 四层分层可以直接延续，不应在实体中复制快照 |
| Character/Location/Faction 通过可选 `bindingId` 引用绑定 | 同上 | 引用集合可以从实体即时推导，无需 `ownerId` 或 `references[]` |
| orphan 清理目前按 `semanticType` 推导实体/世界作用域 | `world-ops.ts` 的 `ENTITY_SCOPED_SEMANTICS`、`referencedBindingIds`、`pruneOrphanBindings` | 2B 可用显式 `scope` 替代推断，同时保留旧数据兼容 |
| Master Asset 列表已支持 query、record_kind、semantic_type、availability、limit、offset | `lib/api-client/master-library.ts` | 2B.1 可复用现有查询接口，不需要新增列表路由 |
| Master Asset 详情只能逐个按 id 获取 | 同上 | 2B.1 应只依赖列表摘要，不能产生批量详情请求扇出 |
| Master Library 列表和详情主动排除 `worldbook_entry` | `internal/book/master_library_query.go` | 当前不能把 lorebook 的嵌套地点/势力条目当作独立 Master Asset 直接绑定 |
| World 后端目前只对白名单 record kind/semantic type 和角色绑定组合做严格校验 | `internal/world/validate.go` | 地点/势力绑定组合与新 `scope` 必须补前后端一致的契约 |
| 当前时间线枚举是 `canon | planned` | 前端 `types.ts`、后端 `internal/world/types.go` | 不能只改 UI 文案；新枚举必须带旧值兼容策略 |
| 主书和主故事当前是进入模式的目标指针 | `primaryBookPath`、`primaryInteractiveStoryId` | 2B.1 不应把它们误当作可自动结构化导入的 Master Asset |

---

## 3. 可以通过的设计

### 3.1 四层关系

以下四层关系合理，应保留：

1. **Master Asset**：世界外部的只读权威源，负责原件、内容哈希和可用性。
2. **World Binding**：世界对 Master Asset 的引用、薄快照和版本基线；唯一真源仍是 `World.bindings[]`。
3. **World Entity**：角色、地点、势力和时间线等世界内实例，保存用户在该世界中的独立编辑，不回写 Master Library。
4. **Runtime State**：健康检查、加载状态、未确认提案、请求世代和 UI 状态，不进入 World JSON。

这个分层解决了三个核心问题：原件与实例分离、世界可独立编辑、运行时派生状态不污染长期数据。没有必要再增加“事实层”“任务层”或第二套绑定索引。

### 3.2 现有持久化与并发契约

以下机制可以原样复用：

- 原子创建完整世界，不先创建空壳。
- 更新使用 `PUT + expected_revision`，冲突返回 409 并走现有重新加载流程。
- 绑定只保存 name/tags/masterRevision 等薄快照，不复制原件正文。
- 健康状态运行时派生，刷新由用户显式触发。
- 世界仍落在 `cfg.DataDir()/worlds/`，不归某本书或某个模式实例所有。
- 不新增 index.json，不重写 Module3/Module4，不把 `worldId` 反写到书籍或互动故事。

### 3.3 人工确认边界

“AI 只生成提案，用户确认后才进入 World”方向正确。`proposalToWorldInput` 可以作为纯转换函数存在，但只能在 2B.2 真正需要时增加；2B.1 不应提前搭建 AI 类型、任务框架或占位接口。

### 3.4 Phase 2B.1 先于 AI

先交付非 AI 的资料库深度绑定是正确顺序。它能先验证数据模型、scope 生命周期、筛选、重复绑定、实体生成、CAS 保存和旧世界兼容；这些也是 2B.2 的必要底座。模型不可用时，世界创建和资料绑定仍应可用。

---

## 4. 必须修改的设计

### M1. Binding 采用 `scope + 派生引用`，不持久化 `ownerId`

建议将方案 C 修订为 C'：

```ts
interface WorldAssetBinding {
  // 旧世界可缺省；所有 2B 新建/新保存的绑定都必须显式写入。
  scope?: 'entity' | 'world'
  // 其余现有字段保持不变。
}
```

不应加入 `ownerId`，原因如下：

- 一个 binding 可以被多个实体引用，单一 owner 无法表达真实关系。
- binding 的存活规则已经由全部实体的 `bindingId` 引用集合决定，`ownerId` 不参与正确性判断。
- `ownerId` 只剩 UI 展示或快速定位价值；世界规模上限目前只有 500 角色、500 地点、500 势力和 200 bindings，即时扫描足够，不值得增加持久化字段。
- 删除或更换所谓 owner 时，`ownerId` 很容易与真实引用集合分叉，形成新的迁移和修复负担。

同样不得加入持久化 `references[]`。引用已经存在于 World Entity 的 `bindingId`，再写一份数组会形成双重真源。UI 如需显示“被哪些实体使用”，调用 `referencedBindingIds` 的扩展派生函数即可。

`scope` 的语义必须定义为**生命周期策略**，而不是“是否允许被引用”：

- `entity`：至少有一个实体引用才应进入新的持久化结果；失去最后一个引用时自动清理。
- `world`：可被实体引用，也可零引用；删除实体不自动清理，只能在“世界资料”中由用户显式移除。
- 同一 `masterItemId` 在一个 World 内只保留一个 binding；需要被多个实体使用时共享同一个 `bindingId`。

兼容规则：旧 binding 缺 `scope` 时，继续按 `semanticType ∈ {character, location, faction}` 推导为 `entity`，其余推导为 `world`；GET 不回写，下一次用户成功保存时再写入显式 scope。不得因为新增字段把旧世界判为损坏。

### M2. 2B.2 的 `StructureProposal` 是一次性会话草稿

v1 虽然写了“不进 World”，但“分析任务状态”仍可能被理解成可恢复的长期任务。必须明确选择一次性方案：

- 提案和分析状态只存在当前页面组件内存。
- 刷新页面、关闭应用或 Denova 重启后允许丢失，不承诺恢复。
- 用户离开含未确认提案的页面时复用现有未保存确认；取消离开则保留当前会话草稿。
- 失败后的“重试”是重新提交用户当前选择，不恢复旧任务。
- 2B.2 不新增任务表、任务队列、localStorage 草稿、后台恢复或跨设备同步。

`StructureProposal` 只在 2B.2 开工时定义。若 UI 不展示模型名，删除建议结构中的 `model?`；`SourceRef` 不应携带可能泄露本机路径的 `path?`，来源选择状态与模型输入都使用已有安全 id/受控片段。

### M3. 新设计停止使用 Canon，时间线只属于 World

文档中的“时间线 canon 层”和“全局 Canon”形成概念冲突。目标枚举改为：

```ts
type TimelineCategory = 'background' | 'historical' | 'planned'
```

- `background`：作为世界背景使用的节点。
- `historical`：该 World 已确立的历史节点。
- `planned`：用户在 World Workspace 中记录的后续规划。

这三个分类都只描述当前 World 的背景与规划，不表示写作、游戏、叙界、沙盒必须同步剧情。

当前磁盘已有 `canon | planned`，因此实施时必须兼容：旧 `canon` 允许读取并按 `historical` 展示；新建和用户下一次保存只写新枚举；不做批量磁盘迁移、不因旧值报损坏。该兼容改动应与时间线 UI/校验改动放在同一个独立提交，不应夹进 2B.1 的首个 scope 提交。

写作章节、互动游戏进度、Narraverse 会话和 Module4 冒险仍属于各自模式实例。它们不得自动写入 World Timeline；未来如需采用，只能生成待用户确认的时间线提案。

### M4. AI 输入采用字段白名单和用户主动选择，禁止自动全文

2B.2 第一版只允许：

- 用户明确勾选的 usable Master Asset 的结构化字段白名单。
- 用户主动选择或粘贴的有限文本片段。

不得自动读取或发送：

- 整本小说、全部章节或完整互动故事。
- 未选择的 Master Asset 详情与嵌套正文。
- 本机绝对路径、API Key、Authorization、运行日志和完整用户存档。

模型调用前必须在同一入口实施来源数量与总字符数硬上限，前端只负责显示计数，服务端或实际模型调用边界负责最终拒绝。限制值应在 2B.2 的实施计划中结合当前共享模型上下文一次性冻结；不得靠放宽 World 的 1 MiB 请求体上限解决模型输入问题。Prompt、原始片段和未确认提案不写入 World、协作日志或通用诊断日志。

### M5. 2B.1 不得把书籍/故事正文或 lorebook 嵌套条目当作现成资产

2B.1 的来源必须先收窄为当前 `/api/library/assets` 真正返回的 usable 顶层 Master Asset。`primaryBookPath` 和 `primaryInteractiveStoryId` 在本阶段仍只是进入写作/游戏模式的目标指针，不作为结构导入来源，也不读取正文。

当前 Master 查询明确排除了 `worldbook_entry`。因此：

- 角色可以继续从 `character_template + character` 生成实体。
- lorebook_template 可以作为 world scope 的世界资料绑定。
- 只有列表实际返回 usable 且 `semantic_type=location|faction` 的顶层资产时，才允许生成绑定地点/势力。
- 没有匹配资产时展示真实空状态，不把 `semantic_type=other` 强行改写成 location/faction，也不把整本 lorebook 假装成一个地点或势力。

如果产品要求把 lorebook 内的某个嵌套条目独立绑定为地点/势力，必须另立契约：需要稳定的 nested entry identity、版本/失效语义、详情读取和 binding 定位字段。这不是现有 2B.1 可以无成本复用的能力，也不得通过复制条目正文进 World 绕过。

### M6. 更新计划基线与开放问题

方案当前仍写着“Phase 2A.2（工作树）”。Phase 2A.2 已在 commit `01253b9` 提交并推送，修订版应更新基线并把已经拍板的问题从“开放问题”移到“冻结决策”：

- Ownership：采用 `scope + 派生引用`，无 ownerId、无 references[]。
- AI 提案：一次性会话草稿。
- AI 输入：结构化白名单 + 用户选择片段，禁止自动全文。
- 时间线：World 背景/历史/规划，不做跨模式 Canon。
- 子阶段：2B.1 先行，2B.2 单独评审后再开工。

仍可保留的开放问题只有：地点/势力实际可用资产来源、世界资料 UI 的具体位置、单次多选上限，以及未来是否需要嵌套条目身份契约。

---

## 5. Phase 2B.1 建议范围与隐藏依赖

### 5.1 允许进入的最小范围

修订计划通过后，2B.1 只包含：

1. 给 World Binding 增加可兼容的 `scope`，不增加 ownerId/references[]。
2. 复用现有 Master Asset 列表摘要，支持 usable 顶层资产的确定性多选。
3. 保留角色模板绑定；增加世界级 lorebook 绑定的可见列表与显式移除。
4. 对实际存在的 location/faction 顶层资产生成对应实体；没有来源时正确显示空状态。
5. 复用现有 POST/PUT/CAS、健康检查与手动刷新，不新增模型请求和后台任务。
6. 保留主书/主故事选择作为目标指针，不读取其正文。

### 5.2 必须在实施计划中列出的隐藏依赖

| 隐藏依赖 | 当前事实 | 2B.1 处理方式 |
| --- | --- | --- |
| 地点/势力来源 | `/api/library/assets` 排除 `worldbook_entry`；最终验收环境也没有独立 location/faction 顶层资产 | 不承诺现实数据必有结果；使用契约测试/受控 fixture，真实 UI 提供空状态；嵌套条目另立任务 |
| Picker 形态 | 当前 BindingPicker 是单选弹窗 | 可扩展为多选确认，但复用同一分页/竞态逻辑，不复制查询实现 |
| 后端组合校验 | 角色有严格组合校验，地点/势力目前只校验 binding 是否存在 | 定义前后端一致白名单并补测试；不得只靠 UI 过滤 |
| `scope` 兼容 | 旧世界没有 scope | 缺省推导、读时不写、保存后显式化；旧值不能触发损坏 warning |
| 重复资产 | 前端已禁用已绑定 masterItemId，但后端未形成明确唯一契约 | 2B.1 冻结“一 World 一 masterItemId 一 binding”，共享引用而非复制快照 |
| 批量详情 | 详情接口逐项读取 | 2B.1 只用列表摘要生成薄快照，禁止 N 个选择触发 N 个详情请求 |
| 大小上限 | World 目前最多 200 bindings，写请求仍受 1 MiB 限制 | 多选提供明确上限与剩余容量提示，不提高安全上限 |
| 实际数据验收 | 当前真实库以角色模板和 lorebook 模板为主 | 正式 executable 验收角色、world scope lorebook、空状态和旧世界兼容；不伪造“真实地点资产已存在”结论 |

### 5.3 2B.1 开工门槛

以下条件同时满足后，允许进入 2B.1：

- Phase 2B 方案修订为 v2，并落实本报告 M1、M5、M6。
- 实施计划列出前后端 `scope` 字段、缺省推导、唯一性、清理与校验矩阵。
- 明确 location/faction 无真实顶层资产时的空状态，不将 nested entry 暗中升级为 Master Asset。
- 测试计划至少覆盖：旧 binding 无 scope、entity 最后引用删除、共享引用保留、world 零引用保留、重复 masterItemId、非法 scope、CAS 409、Master 404/5xx。
- 不新增 AI 路由、模型依赖、全文读取、任务系统或 Module3/Module4 改动。

结论：**2B.1 为 Conditional Go。v2 方案完成上述修订并经一次 diff 快速核对后即可开工；无需等待 2B.2 设计。**

---

## 6. 长期风险

| 风险 | 级别 | 说明 | 控制方式 |
| --- | --- | --- | --- |
| scope 与引用语义漂移 | P1 | 若 ownerId/references[] 与实体 bindingId 并存，会形成多真源和误删 | 只持久化 scope；引用即时派生；集中纯函数和后端校验 |
| lorebook 嵌套条目身份缺失 | P1 | 顶层列表不暴露 worldbook_entry，地点/势力深度绑定可能被迫复制正文或绑定整本资料 | 2B.1 不伪造；需要时单独设计 nested identity/version 契约 |
| AI 全文摄入 | P1 | 带来上下文溢出、长等待、隐私与日志风险 | 字段白名单、用户显式片段、统一硬上限、禁止持久化原文 |
| 时间线重新演变成跨模式 Canon | P1 | 模式剧情若自动回灌，会破坏“背景共享、剧情隔离” | 去 Canon 命名；模式事件只能成为人工确认提案 |
| 临时提案被升级为任务系统 | P2 | 为恢复一次分析引入队列、数据库和状态机，成本远超 2B 目标 | 2B.2 明确允许刷新丢失；真实长期需求出现后另立阶段 |
| 批量选择导致请求扇出或超限 | P2 | 逐项详情请求和过大 World PUT 会拖慢本地应用 | 2B.1 只用 summary；单次多选上限；不放宽 1 MiB |
| 语义类型被用户目标覆盖 | P2 | 把 `other` 改写成 location/faction 会伪造 Master 语义并影响刷新 | semanticType 始终是来源快照；目标实体类型另由 UI 路径决定并受白名单约束 |
| 四模式耦合提前扩大 | P2 | 为“背景注入”提前修改 Module3/4 协议会把资料绑定升级成跨模块重构 | 2B.1 不做模式注入；2B.3 另审 |

---

## 7. 是否需要 Codex 继续参与

需要，但只在契约节点参与，不需要伴随每个普通 UI 改动：

1. **现在**：核对 Phase 2B v2 文档 diff，确认本报告的冻结决策已写入。
2. **2B.1 节点**：审查 scope 的前后端兼容、引用清理、组合白名单和真实 executable 验收；通过后关闭 2B.1。
3. **2B.2 开工前**：强制审查实际模型调用路径、输入字段白名单、字符/来源上限、日志脱敏和会话草稿语义。
4. **只有产品决定支持 lorebook 嵌套条目独立绑定时**：再次审查 nested identity、revision 与失效模型。

常规组件布局、文案、样式和复用现有分页逻辑不需要单独提交 Codex 架构审查。

---

## 8. 最终裁定

- **可以通过的设计**：四层模型、World 主体/总库只读、薄快照、人工确认、原子创建、CAS、健康状态运行时派生、2B.1 先于 AI、四模式剧情隔离。
- **必须修改的设计**：删除 ownerId/references[]；明确 scope 生命周期；提案改为可丢失会话草稿；去 Canon 化并兼容旧值；禁止 AI 自动全文；收窄 2B.1 到现有 Master API 真正支持的资产；更新 Phase 2A.2 基线。
- **是否允许进入 2B.1**：**条件允许**。v1 不能直接开工；v2 修订并通过一次快速 diff 核对后可以开工。
- **是否允许进入 2B.2**：**暂不允许**。需先完成 2B.1，并单独冻结模型输入和调用契约。
- **Codex 后续参与**：需要在 v2 diff、2B.1 节点验收和 2B.2 开工前继续参与；不介入普通实现细节。

