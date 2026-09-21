# World Workspace Phase 2B 设计方案 v2：真实资料库深度接入

- 文档版本：**v2（已按架构评审冻结决策修订；仍为设计稿，不写生产代码）**
- 修订时间：2026-09-10（Asia/Shanghai）
- 代码基线：`main` commit `01253b9f33feaab6e83565c17c842ad1eceaf8f2`（Phase 2A.2 已提交并推送）
- 修订依据：`docs/reviews/WORLD_WORKSPACE_PHASE2B_ARCHITECTURE_REVIEW.md`（结论：v1 Changes requested；v2 通过一次 diff 快速核对后，2B.1 为 Conditional Go，2B.2 仍需单独评审）
- 关联文档：`WORLD_WORKSPACE_IMPLEMENTATION_PLAN.md`、`WORLD_WORKSPACE_PHASE2A_PLAN.md`、`docs/reviews/WORLD_WORKSPACE_PHASE2A1_DOUBAO_REVIEW.md`

### v1 → v2 变更摘要（供 Codex 做 diff 核对）

1. **Binding 冻结为 `scope + 派生引用`**：保留 `scope`，**删除 `ownerId`，不新增持久化 `references[]`**；引用关系一律由实体 `bindingId` 即时派生；`scope` 定义为“生命周期策略”。
2. **时间线去 Canon**：枚举由 `canon|planned` 改为 **`background|historical|planned`**；旧 `canon` 只兼容读取（按 historical 展示），**不迁移、不判损坏**。
3. **`StructureProposal` 明确为一次性会话草稿**：刷新/关闭/重启允许丢失，不建任务系统、不建后台恢复、不存 localStorage；`SourceRef` 去掉可能泄露本机路径的 `path?`，并移除不展示的 `model?`。
4. **AI 输入边界冻结**：只用用户勾选的 usable Master Asset **结构化字段白名单** + 用户主动选择/粘贴的有限片段；**禁止自动读取全文小说/完整互动故事/未选资产详情**；来源数与字符数设硬上限，最终拒绝在服务端，不靠放宽 1 MiB。
5. **2B.1 收窄为非 AI 绑定底座**：只用现有 `/api/library/assets` 真实返回的 usable 顶层资产；**不假设 `worldbook_entry` 存在，不把 lorebook 嵌套条目伪装成独立地点/势力资产**；无真实来源时显示真实空状态。
6. 更新基线为 `01253b9`；把已拍板项从“开放问题”移到“冻结决策”，开放问题只保留 4 项。

---

## 0. 现状基线（设计建立在事实上）

当前世界模型（前端 `web/src/features/world-workspace/types.ts`，与后端 `internal/world` JSON 契约对齐）：

- `World.bindings: WorldAssetBinding[]` 是绑定**唯一真源**，只存只读引用与薄快照：`bindingId / masterItemId / recordKind / semanticType / nameSnapshot / tagsSnapshot / masterRevision? / boundAt`，不复制原件正文。
- `WorldCharacter / WorldLocation / WorldFaction / WorldTimelineEntry` 通过可选 `bindingId` 反查绑定；目前只有角色真正实现“绑定→同步生成实体”，地点/势力有 `bindingId?` 字段但无绑定 UI。
- 总资料库 `MasterAssetSummary`（`lib/api-client/master-library.ts`）提供 `master_item_id/name/tags/record_kind/semantic_type/master_revision/availability/usage_count/avatar_url?/pipeline`；详情 `MasterAssetDetail` 只能**逐个按 id** 获取；列表支持 `query/record_kind/semantic_type/availability/limit/offset`。
- 后端 Master 列表/详情**主动排除 `worldbook_entry`**（`internal/book/master_library_query.go`）：lorebook 的嵌套地点/势力条目当前**不是**可独立绑定的顶层资产。
- 2A/2A.2 已成立并在 `01253b9` 落地：服务端真源 `cfg.DataDir()/worlds/world-<id>.json`、无 index.json、原子创建、`{world,revision}` 信封与 PUT `expected_revision`（CAS 409）、健康六态按需检查与手动刷新三字段、orphan 按 `ENTITY_SCOPED_SEMANTICS` 保守清理、错误路径脱敏、请求体 ≤1 MiB。

**Phase 2B 一句话定位：** 把“手工逐条挑资产、手动建实体”的浅接入，升级为“选定资料来源 →（2B.2 才有的）AI 生成可确认结构草案 → 人确认 → 原子落库”的深度接入；2B.1 先交付**不依赖 AI** 的绑定底座（显式 scope、世界级资料可见可移除、地点/势力在真实资产存在时绑定化）。世界是主体，总资料库只读，AI 只产待确认提案。

---

## 1. Phase 2B 目标

### 1.1 核心目标

1. **显式 Binding 作用域**：用持久化 `scope: 'entity' | 'world'` 取代当前按 semantic 推断的隐式行为，规则见第 4 节（冻结）。
2. **非 AI 的确定性绑定底座（2B.1）**：复用现有 Master 列表摘要做 usable 顶层资产的确定性（可多选）绑定；角色模板继续生成角色；lorebook_template 作为 **world scope** 世界资料可见、可显式移除；当列表真实返回 `semantic_type=location|faction` 的 usable 顶层资产时才生成对应地点/势力实体，否则给真实空状态。
3. **AI 结构提案（2B.2，单独评审后开工）**：仅对用户勾选来源做结构化字段分析，产出世界设定/角色/地点/势力/时间线**提案**，人确认后才转成 bindings+entities。
4. **世界级绑定获得正式身份与 UI**：world scope 绑定有列表展示与显式移除入口，不再只存在于 JSON。
5. **平滑承接 2A**：单一绑定真源、CAS、健康六态、错误脱敏、F-01～F-06 不回退；旧世界缺新字段兼容读取。

### 1.2 相对 2A 的增量边界

| 维度 | 2A（已完成） | 2B.1（非 AI 底座） | 2B.2（AI 提案，另审） |
| --- | --- | --- | --- |
| 绑定作用域 | 按 semantic 隐式推断清理 | 显式 `scope` + 兼容推导 | 沿用 |
| 实体绑定 | 角色 | 角色 + 真实存在的地点/势力顶层资产 | 沿用 |
| 世界级资料 | 能存、UI 不可见 | world scope 列表 + 显式移除 | 可由提案追加 |
| 选择方式 | 单选 Picker 逐个绑 | 复用分页的确定性多选 | 多选 + AI 归类提案 |
| AI | 无 | **无** | 仅勾选来源、字段白名单、会话草稿 |
| 数据来源 | 顶层 Master Asset | 同左，**排除嵌套条目/书籍/故事正文** | 同左 + 用户片段 |

### 1.3 子阶段与门槛（冻结顺序）

- **2B.1（Conditional Go：本 v2 通过 diff 核对即可开工，不等 2B.2）**：scope 字段与兼容、确定性多选绑定、world scope 资料 UI、真实地点/势力资产绑定与空状态、复用 POST/PUT/CAS/健康刷新；**不新增模型请求、任务系统、后台任务，不改 Module3/4**。时间线枚举兼容改动作为**独立提交**，不夹进 2B.1 首个 scope 提交（见 3.3）。
- **2B.2（暂不允许开工）**：完成 2B.1 后，单独冻结模型调用路径、输入字段白名单、来源/字符硬上限、日志脱敏与会话草稿语义，经 Codex 审查通过才开工。
- **2B.3（更后，另审）**：控制台增量导入、模式“带入世界背景”的注入评估；本期不改 Module3/4 协议。

> 原则：2B.1 不依赖 AI 也完整成立，模型不可用时世界创建与资料绑定必须照常可用。

---

## 2. 用户体验流程

### 2.1 主流程（创建世界）

```
选择资料来源
   │ 2B.1：仅可勾选 /api/library/assets 真实返回的 usable【顶层】Master Asset（可多选），
   │       主书/主故事只是目标指针，不在此读正文；
   │ 2B.2：在此之上才出现“AI 分析”动作。
   ▼
[2B.2 才有] AI 分析资料
   │ 只读“被勾选资产的结构化字段白名单 + 用户主动选择/粘贴片段”，产出会话级 StructureProposal
   ▼
生成世界结构（2B.1 为按 semantic 直接分组的候选列表；2B.2 为带置信度的提案视图）
   │ 分栏：世界设定 / 角色 / 地点 / 势力 / 时间线 / 世界资料(world scope：规则·lore·物品)
   │ 每条：来源资产、识别类型、建议名、(2B.2)置信度、采纳 / 改类型 / 编辑 / 丢弃
   ▼
用户确认（可反复修改、可回上一步重选）
   ▼
一次性原子创建 POST /api/worlds（完整 bindings+entities，沿用 Phase1 原子契约）
   ▼
进入世界控制台（轻提示本次导入条数，不自动进入任何运行模式）
```

### 2.2 提案/草稿的生命周期（2B.2 冻结语义）

- 选择状态、分析状态、`StructureProposal` **只存在当前页面组件内存（一次性会话草稿）**。
- **刷新页面、关闭应用、Denova 重启后允许丢失，不承诺恢复**；不建任务表/任务队列、不做后台恢复、不写 localStorage、不做跨设备同步。
- 离开含未确认提案的页面时复用现有未保存确认：取消离开则保留本次会话草稿，确认离开即丢弃。
- 失败后的“重试”= 用用户当前选择**重新提交一次**，不恢复旧任务。
- 2B.1 不提前定义任何 AI 类型、任务框架或占位接口；`proposalToWorldInput` 纯转换函数只在 2B.2 真正需要时新增。

### 2.3 副流程：控制台内增量绑定/导入

- 单条绑定走现有 BindingPicker；2B.1 可把它扩展为**多选确认**，但复用同一分页与请求世代（generation）逻辑，不复制查询实现。
- 增量结果通过 **PUT + expected_revision（CAS）** 合并；409 走既有“重新加载”；不覆盖用户已编辑的世界内字段；同一 `masterItemId` 已绑定时提示并共享既有 binding，不重复建。

### 2.4 明确不做的伪流程

- 不做“AI 自动建完世界直接进运行模式”；确认前世界不存在。
- 不监听总资料库变化自动改世界；刷新永远是用户显式动作。
- 不把书籍/互动故事正文、lorebook 嵌套条目当作可直接结构化导入的资产（见第 6 节）。

---

## 3. 数据模型设计

### 3.1 四层概念与关系（评审通过，保留）

```
Master Asset（世界之外的只读权威源：原件、内容哈希、可用性）
      ▲ 只读引用：masterItemId + 绑定时 masterRevision 基线；绝不回写、不复制正文
World Binding（唯一真源 = World.bindings：薄快照 + scope 生命周期策略）
      │ 实体以 bindingId 即时派生引用（不持久化 ownerId / references[]）
      ├── World Entity（Character/Location/Faction/Timeline：世界内实例与世界内创作）
      └── World 自身（世界背景层，持有 world scope 绑定）
            ▼ 运行时（不进 World JSON）
Runtime State：健康六态 / 加载与请求世代 / 未确认会话提案 / UI 视图
```

### 3.2 各层职责

| 层 | 归属 | 持久化 | 职责 | 禁止 |
| --- | --- | --- | --- | --- |
| Master Asset | 总资料库 | 总资料库自持 | 原件权威、哈希、可用性 | 世界不回写、不复制正文 |
| World Binding | `World.bindings[]` | 是 | 只读引用 + 薄快照 + 版本基线 + **`scope`** | 不嵌进实体、不存 ownerId/references[] |
| World Entity | characters/locations/factions/timeline | 是 | 世界内实例与世界内内容 | 不回写总库、不存原件正文 |
| Runtime State | 前端会话派生 | **否** | 健康态、请求世代、一次性提案、UI 态 | 不把派生态持久化 |

### 3.3 WorldAssetBinding（冻结）

```ts
interface WorldAssetBinding {
  bindingId: string
  masterItemId: string
  recordKind: 'character_template' | 'lorebook_template'
  semanticType: 'character' | 'world' | 'location' | 'faction' | 'rule' | 'item' | 'other'
  nameSnapshot: string
  tagsSnapshot: string[]
  masterRevision?: string
  boundAt: string
  // 2B 新增（旧世界可缺省）：生命周期策略，而不是“是否允许被引用”。
  scope?: 'entity' | 'world'
  // 明确不新增：ownerId、references[]（引用由实体 bindingId 即时派生，避免多真源）。
}
```

- **`scope` 是生命周期策略（冻结语义）**：
  - `entity`：至少被一个实体引用才进入新的持久化结果；失去最后一个引用时由删除实体流程自动清理。
  - `world`：可被实体引用，也可**零引用**；删除实体**不**自动清理，只能在“世界资料”UI 由用户显式移除。
- **引用即时派生**：`referencedBindingIds(world)` 从全部实体的 `bindingId` 现算；UI 需要“被谁使用”时用派生函数，不持久化引用列表。规模上限（500/500/500 实体、200 bindings）下即时扫描足够。
- **唯一性（冻结）**：同一 `masterItemId` 在一个 World 内只保留一个 binding；多实体共用时共享同一 `bindingId`，不复制快照。
- **兼容（冻结）**：旧 binding 缺 `scope` 时，按 `semanticType ∈ {character,location,faction}` 推导为 `entity`、其余为 `world`；**GET 不回写**，下一次用户成功保存时才写入显式 scope；缺字段**不得触发损坏 warning**。纯函数 `bindingScopeOf(binding)` 集中该推导并单测。
- 清理纯函数沿用并显式化：`referencedBindingIds / pruneOrphanBindings（只清 entity 作用域零引用者，world 恒保留）/ removeWorldEntity`，四条不变量测试：旧 binding 无 scope、entity 最后引用删除、共享引用保留、world 零引用保留。

### 3.4 WorldTimelineEntry：去 Canon（冻结，独立提交）

```ts
// 旧：type TimelineCategory = 'canon' | 'planned'
type TimelineCategory = 'background' | 'historical' | 'planned'
```

- `background`：作为世界背景使用的节点；`historical`：该 World 已确立的历史节点；`planned`：在世界工作区记录的后续规划。三者都**只描述当前 World**，不代表四模式剧情必须同步。
- **兼容（冻结）**：磁盘旧值 `canon` 允许读取并按 `historical` 展示；新建与下一次保存只写新枚举；**不做批量磁盘迁移、不因旧值判损坏**。
- 该枚举兼容 + 时间线 UI/校验改动放在**同一个独立提交**，不夹进 2B.1 首个 scope 提交。
- 写作章节、游戏进度、叙界会话、Module4 冒险属于各自模式实例，**不得自动写入 World Timeline**；未来若采用，只能生成待用户确认的时间线提案（2B.2 之后）。

### 3.5 StructureProposal（仅 2B.2 定义，一次性会话草稿）

- 仅在 2B.2 开工时新增，且**不进 World JSON、不持久化**：

```ts
// 全部为运行时内存态；刷新/关闭可丢失
interface StructureProposal {
  sourceIds: string[]                 // 只存安全 id，不携带本机 path
  settingDraft?: Partial<WorldSetting>
  characters: ProposedEntity[]
  locations: ProposedEntity[]
  factions: ProposedEntity[]
  timeline: ProposedEntry[]
  worldScoped: ProposedBinding[]      // world scope 候选（规则/lore/物品）
  generatedAt: string
  // 不设 model 字段（UI 不展示模型名）；不设任务 id / 可恢复游标
}
```

- 用户确认后由纯函数 `proposalToWorldInput(proposal, choices): WorldCreateInput`（或增量 patch）统一转换，规则集中可单测，组件内不手拼。
- 时间线不直接绑定资产（它是世界内编排结果，可由 AI 从资料抽取，但落库即世界内容）。

### 3.6 Runtime State 边界

健康六态、请求世代、分析中状态、未确认提案、模式 pending 都是会话派生态，刷新按需重算，不写入世界 JSON；世界 JSON 只保存用户确认过的世界内容。

---

## 4. Binding Ownership（冻结为 C'：scope + 派生引用）

v1 曾列 A 引用型 / B 拥有者型 / C 混合型并推荐“C 含 ownerId”。架构评审冻结为 **C'**，结论与理由如下，本节不再是待选方案：

### 4.1 冻结决策

- **只持久化 `scope`；不持久化 `ownerId`，不持久化 `references[]`。**
- 实体→绑定的引用已经存在于各实体的 `bindingId`；存活判定以“全部实体 bindingId 的引用集合”为唯一依据，即时派生。

### 4.2 为什么不要 ownerId / references[]

- 一个 binding 可被多个实体引用，单一 owner 表达不了共享；`ownerId` 不参与正确性，只剩展示/定位价值，而当前规模即时扫描即可。
- owner 在删除/更换后极易与真实引用集合分叉，制造新的迁移与修复负担。
- 再写一份 `references[]` 会与实体 `bindingId` 形成双重真源（2A 已专门消除过双真源）。
- “被哪些实体使用”这类展示需求由派生函数现算。

### 4.3 三方案对照（说明为何收敛到 C'）

| 维度 | A 纯引用（不清理） | B 唯一 owner 级联 | **C' scope+派生引用（冻结）** |
| --- | --- | --- | --- |
| world 作用域资料（规则/lore） | 支持 | 无法表达 | `scope:'world'` 零引用保留 |
| 角色卡随最后引用清理 | 需人工清理 | 自动级联 | `scope:'entity'` 零引用自动清 |
| 多实体共享同一来源 | 支持 | 被迫复制 | 共享同一 bindingId |
| 是否引入多真源 | 否 | owner 易分叉 | **否（无 ownerId/references[]）** |
| 与 2A.2 现状衔接 | 要改回不清理 | 会重新引入误删 | 把隐式推断升级为显式 scope，最平滑 |

### 4.4 不变量（测试锁死）

1. 旧 binding 无 `scope` → 按 semantic 推导，GET 不回写、不报损坏；
2. `entity` binding 删除最后一个引用实体 → 清理；仍有任一引用 → 保留；
3. `world` binding 删任何实体都保留，只能用户显式移除；
4. 同一 `masterItemId` 不产生第二个 binding；非法 `scope` 前后端都拒绝。

---

## 5. 四模式关系（背景共享、剧情隔离；去 Canon）

```
                 World（世界：背景与结构的共享层，不含跨模式唯一事实）
                 ├── 写作模式   用户=作者（IDE / Module3，目标 primaryBookPath）
                 ├── 游戏模式   用户=玩家角色（interactive，目标 primaryInteractiveStoryId）
                 ├── 叙界 Narraverse   独立入口（narraverse）
                 └── 开放沙盒 Module4  观察者/导演/可介入角色
```

- **世界背景共享，剧情不强制同步**：World 提供共享背景层，四模式长出各自独立的体验实例与发展；**不建全局 Canon**。
- 进入任一模式沿用 2A.2 的**单次统一 preflight**（dirty 时只确认一次，副作用在确认后）；世界不向书/故事反写 `worldId`。

### 5.1 共享什么（来自 World 的只读背景）

| 共享内容 | 来源 | 方式 |
| --- | --- | --- |
| 世界元信息/设定 | name/tagline/genre/summary/worldSetting | 进入模式时作为背景上下文（2B.1 不做注入实现） |
| 角色/地点/势力结构 | characters/locations/factions 世界内字段 | 只读背景，模式内不改世界原件 |
| 总资料库素材 | bindings 薄快照 + 按需取原件 | 经 masterItemId 只读拉取，不复制正文 |
| 世界时间线 | timeline 的 background/historical/planned | 仅当前 World 的背景与规划，非跨模式事实 |
| 目标指针 | primaryBookPath / primaryInteractiveStoryId | 写作切书、游戏选故事的目标；**不是导入来源、不读正文** |

### 5.2 隔离什么（模式实例私有，不回灌世界）

| 模式 | 私有发展 | 与世界关系 |
| --- | --- | --- |
| 写作 | 书内正文/章节/稿件（在 book 内） | 只读引用背景，不回写 |
| 游戏 | 互动故事玩家进度/分支/运行态 | 经 selectInteractiveStory 进入，不回写 |
| 叙界 | Narraverse 会话/产出 | 独立入口，只读背景 |
| 沙盒 | Module4 冒险实例/导演操作/临时事件 | 2B 不改 Module4 协议，仅带入背景 |

- 世界背景更新后，已存在模式实例不被强制改写；模式事件**永不自动写入** World Timeline。要改世界结构回控制台。

---

## 6. Phase 2B.1 精确范围（非 AI 绑定底座）

### 6.1 允许做

1. 给 World Binding 增加兼容的 `scope`（无 ownerId/references[]），含缺省推导、显式化与四条清理不变量。
2. 复用现有 Master Asset **列表摘要**做 usable 顶层资产的确定性多选（扩展现有单选 Picker，复用分页/请求世代，不新增列表路由、不发起 N 个详情请求）。
3. 角色：继续从 `character_template + character` 生成角色实体（沿用现有白名单与同步建实体逻辑）。
4. world scope 资料：`lorebook_template` 等作为世界资料绑定，提供可见列表与**显式移除**。
5. 地点/势力：**仅当**列表真实返回 usable 且 `semantic_type=location|faction` 的**顶层**资产时，才生成绑定+实体；后端补与前端一致的组合白名单校验。
6. 复用 POST/PUT/CAS、健康检查、手动刷新；保留主书/主故事作为目标指针，不读其正文。

### 6.2 禁止做（冻结）

- **不假设 `worldbook_entry` 已作为独立资产暴露**：当前查询明确排除它。
- **不把 lorebook 的嵌套条目伪装成独立地点/势力资产**：不把整本 lorebook 当一个地点/势力，也不把 `semantic_type=other` 强改写成 location/faction（semanticType 永远是来源快照，目标实体类型另由受控 UI 路径决定并受白名单约束）。
- 不读取/导入整本小说、全部章节或完整互动故事。
- 不新增 AI 路由、模型依赖、任务系统、后台任务、轮询；不改 Module3/Module4；不新增 index.json；不提高 1 MiB 安全上限。

### 6.3 隐藏依赖与处理（实施计划必须列出）

| 隐藏依赖 | 当前事实 | 2B.1 处理 |
| --- | --- | --- |
| 地点/势力来源 | 列表排除 worldbook_entry，真实环境暂无独立 location/faction 顶层资产 | 不承诺必有结果；用受控 fixture/契约测试，真实 UI 给空状态；嵌套条目另立契约 |
| Picker 形态 | 现为单选弹窗 | 可扩为多选确认，复用同一分页/竞态逻辑 |
| 后端组合校验 | 角色严格、地点/势力仅校验绑定存在 | 补前后端一致白名单与测试，不只靠 UI |
| scope 兼容 | 旧世界无 scope | 缺省推导、读时不写、保存显式化、不触发损坏 warning |
| 重复资产 | 前端禁选已绑，后端无明确唯一契约 | 冻结“一 World 一 masterItemId 一 binding”，共享而非复制 |
| 批量详情 | 详情逐项读取 | 只用列表摘要生成薄快照，禁止 N 选择触发 N 详情 |
| 大小上限 | 最多 200 bindings、写请求 ≤1 MiB | 多选设上限与剩余容量提示，不提高安全上限 |
| 真实数据验收 | 真实库以角色/lorebook 模板为主 | 正式验收角色、world scope lorebook、空状态、旧世界兼容；不伪造“真实地点资产已存在” |

### 6.4 2B.1 开工门槛（Conditional Go）

- 本 v2 落实 M1/M5/M6 并通过一次 diff 快速核对；
- 实施计划列出前后端 `scope` 字段、缺省推导、唯一性、清理与校验矩阵；
- 明确 location/faction 无真实顶层资产时的空状态，不暗中升级嵌套条目；
- 测试矩阵至少覆盖：旧 binding 无 scope、entity 删最后引用、共享引用保留、world 零引用保留、重复 masterItemId、非法 scope、CAS 409、Master 404/5xx；
- 不新增 AI 路由/依赖/全文读取/任务系统/Module3·4 改动。

### 6.5 嵌套条目独立绑定（未来契约，本期不做）

若产品将来要把 lorebook 内某个嵌套条目独立绑定为地点/势力，必须**另立契约**：稳定的 nested entry identity、版本/失效语义、详情读取与 binding 定位字段；不能在 2B.1 无成本复用，更不能靠复制条目正文进 World 绕过。立项时需 Codex 再次审查。

---

## 7. AI 输入边界（2B.2 冻结，开工前还要单独评审）

### 7.1 允许进入模型的输入

- 用户**明确勾选**的、`availability=usable` 的 Master Asset 的**结构化字段白名单**（如 name/tags/受控摘要字段；具体白名单在 2B.2 实施计划一次性冻结）。
- 用户**主动选择或粘贴**的有限文本片段。

### 7.2 禁止自动读取/发送

- 整本小说、全部章节、完整互动故事；
- 未被勾选的 Master Asset 详情与其嵌套正文；
- 本机绝对路径、API Key、Authorization、运行日志、完整用户存档（`SourceRef` 只带安全 id，不带 path）。

### 7.3 上限与落地职责

- 模型调用前在同一入口实施**来源数量与总字符数硬上限**，前端只显示计数，**服务端/实际模型调用边界负责最终拒绝**；具体数值在 2B.2 结合共享模型上下文一次性冻结。
- **不得靠放宽 World 的 1 MiB 请求体上限来解决模型输入问题**（模型输入与世界持久化是两条边界）。
- Prompt、原始片段、未确认提案**不写入** World、协作日志或通用诊断日志。
- 分析失败降级为手动选择（2B.1 路径），重试即按当前选择重提，不恢复旧任务。

---

## 8. 与现有契约的衔接

- **原子创建不变**：确认后仍 `POST /api/worlds` 一次携带完整 `WorldCreateInput`。
- **更新走 CAS**：增量绑定/导入用 `PUT /api/worlds/:id`，body `{expected_revision, world}`，409 走既有“重新加载”。
- **健康复用**：地点/势力/world 绑定复用 `fetchMasterAsset` + `classifyBindingHealth` 六态与手动刷新三字段，不新增并行机制，不做批量扇出与轮询。
- **纯函数与测试**：`bindingScopeOf / referencedBindingIds / pruneOrphanBindings / entityFromBinding /（2B.2）proposalToWorldInput` 全部纯函数化单测；异步用请求世代防竞态（不依赖 AbortController，除非现有 fetch 已支持 signal）。
- **i18n/设计系统**：新增步骤与“世界资料”UI 中英键对齐，复用现有 Denova 设计系统（视觉冒险度 4/10、动效 3/10、信息密度 7/10）。

---

## 9. 冻结决策（已拍板，不再作为开放问题讨论）

1. Binding：保留 `scope`，**无 `ownerId`、无持久化 `references[]`**，引用由实体 bindingId 即时派生；entity 有引用才留、world 零引用也留。
2. `StructureProposal`：一次性会话草稿，刷新/关闭允许丢失，不建任务系统、不做后台恢复/localStorage。
3. 时间线：枚举 `background|historical|planned`；旧 `canon` 仅兼容读取按 historical 展示，不迁移。
4. AI 输入：结构化字段白名单 + 用户主动片段；禁止自动全文小说/完整互动故事；硬上限最终在服务端拒绝。
5. 2B.1：只做非 AI 绑定底座；仅认可用顶层 Master Asset，不假设 worldbook_entry、不伪装嵌套条目。
6. 顺序：2B.1 v2 diff 核对后先行；2B.2 完成 2B.1 并单独冻结模型契约后才开工。

## 10. 仍开放的问题（只保留这 4 项）

1. 地点/势力在真实总资料库中的**可用顶层资产来源**（当前可能长期为空，空状态是默认结果）。
2. “世界资料（world scope）”管理 UI 在控制台的**具体位置与交互**。
3. 单次多选的**数量上限**与剩余容量提示口径（在 200 bindings / 1 MiB 内取值）。
4. 未来是否需要、以及何时立项 **lorebook 嵌套条目身份契约**（6.5）。

---

## 11. 不进入范围（明确禁止 / 暂不做）

1. 世界自动模拟（时间自走、世界自演化后台）。
2. AI 自主事件（AI 不主动产生/推进事件，只在用户触发时产待确认提案）。
3. 全局 Canon / 跨模式强制一致的世界事实库（时间线已去 Canon，仅描述当前 World）。
4. 大规模事实系统（实体/事实知识图谱、自动推理与一致性维护）。
5. 地图引擎（空间地图、坐标、路径、地图可视化）。
6. 关系图谱（维持简单 `relationships[]`，不做图数据库/图谱可视化）。
7. 重写或替换 Module3/Module4、为“背景注入”提前改其 iframe/postMessage 协议。
8. 后台轮询/自动同步/自动刷新；复制总资料库正文；回写总资料库、书籍、互动故事。
9. index.json/第二索引、重型 npm 依赖；新增后端路由需单独评审，优先复用现有 library/worlds 接口。
10. 持久化 AI 任务系统、提案后台恢复、跨设备同步；导入/导出等衍生能力登记为后续债务。

> 本文为 v2 设计稿：完成 Codex 一次 diff 快速核对后，2B.1 可进入实施计划与编码；2B.2 在此之前不编码、不建路由、不改 schema。
