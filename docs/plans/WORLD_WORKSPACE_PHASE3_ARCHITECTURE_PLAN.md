# Narraverse2.0 World Workspace Phase 3 Architecture Plan（v2.2 · Design Freeze）

- 规划时间：2026-09-10（Asia/Shanghai）
- 文档版本：**v2.2（Design Freeze；仅架构设计，不含生产代码）**
- 审查基线：`main` / `bd7276ba7ff5e620bebadc5ea7fa1fba6f983542`
- 前置状态：Phase 2B `CLOSED WITH ACCEPTANCE FOLLOW-UPS`
- 本文范围：Phase 3.0A～3.2 架构与实施顺序；**不包含生产代码实现**
- 文档状态：`DESIGN FREEZE PASS（v2.2；scopeKey / 受控入口无上下文两项快速复审已通过）`
- 取代：本文件 v2.1；并落实 `docs/reviews/WORLD_WORKSPACE_PHASE3_ARCHITECTURE_V2_DIFF_REVIEW.md`（P0/P1 五项 + §4 五项）与 Codex Phase 3 架构复审后续提出的 **v2.2 五项必加**

## 0. v2.1 → v2.2 变更摘要（供 Codex diff 核对）

| v2.2 必加项 | 落点 |
| --- | --- |
| ① **runContext 归属规则**：iframe 不持有 `runContextId`；宿主负责绑定；`model-call-request` 只传消息 | **§6.4 重写**（归属与消息契约）+ §7.1（受控入口只接受宿主绑定）+ §7.3（越权丢弃） |
| ② **runContext 生命周期**：多任务 / 多分支 / 多 iframe 实例并存；task/story/adventure/sandbox instance → runContext 映射；清理粒度 | **§6.2 扩展为两级注册表**（`runContext` scope 绑定 + `modelViewCache` 共享字节）+ §6.3 映射表 + §6.5 清理粒度 |
| ③ **Timeline 空值保真**：`null` / `""` / 字段缺失 的读取、显示、保存规则 | **§8.1 ①②** 增补八态保真表 + 解码侧实现约束（必须区分四态，不得 `string+omitempty` 一把梭） |
| ④ **模型预算**：`consumerContextWindowTokens <= 4096` 直接 `budget_exceeded` | **§9.1 新增加固 guard** + §9.2 该原因允许「无上下文继续」的例外说明 |
| ⑤ **Knowledge Workspace / Obsidian**：采用 `sourceKind` / `sourceId` / `sourceRevision` / `locator`；禁止绝对路径；Obsidian 关系图只是只读投影、不是 World 真源 | **§12 重写**（引用形状 + locator 白名单 + 禁止绝对路径 + 只读投影定位 + 本期不实现） |

### v2.2 本次补强（在 Codex 核对 v2.2 diff 前一并纳入，仍属 v2.2 freeze，不另升版本）

| 补强项 | 起因 | 落点 |
| --- | --- | --- |
| ⑥ **scopeKey 形式化规则**：唯一生成者、语法/长度/字符集、确定性（禁用随机/时间戳）、consumer 命名空间、bind/resume/unbind 三操作（首请求 upsert/幂等复用/换 fingerprint 走替换 vs 续接 mismatch）、缺失与非法处理、iframeInstanceId 派生、脱敏 | §6.3 原表只给组成段，未冻结「同 scope 重复首请求 / 主动换选择 / 缺 scopeKey」的确定行为 | **§6.3.1 新增**；联动 §13、§14(3.0B)、§17 |
| ⑦ **受控入口无上下文（bare）规则**：三请求形状、`context_state = none/bound/active/degraded`、bare 不创建 runContext/不占名额、不隐式注入也不隐式解绑、与错误降级严格区分、通用网关永远 bare | §7.1 原仅一句「两字段都不带=基线」，未区分「主动无上下文」与「加载失败降级」，也未说明已绑定 scope 裸发如何处理 | **§7.5 新增** + §7.1 改为引用；联动 §9.2、§13、§14(3.2)、§17 |
| ⑧ **scopeKey 上线通道（第二轮快速复审）**：冻结「线上协议无 scopeKey 字段」——writing/game 由服务端从 `task.ID()`/`story_id`/`branch` **派生**，iframe 类由服务端 bind 时**生成** `runContextId`、宿主只本地保存；请求体出现自造 scopeKey 一律忽略+审计，不作授权凭证 | v2.2 首版只说「宿主生成 scopeKey、服务端记录」，但请求体只有 `world_context?/run_context_id?/messages`，未定义首请求如何交付 scopeKey，无法实现 | **§6.3 表 + §6.3.1 重写**；联动 §6.2、§6.4、§7.1、§7.3、§11、§13、§14(3.0B)、§17 |

**保持不变（v2.1 已冻结，本版不放松）**

- World 仍是**唯一持久化真源**；Snapshot / runContext / ModelView 均不进入 World JSON。
- **UI Projection / Model Projection 双投影**；ModelView 默认脱敏、单一序列化。
- **四模式只读**：模式产出只留各自存储，**不回写 World**，World revision 运行前后不变。
- **不建立 Canon**（无全局剧情共同真源、模式事件不自动写入 World / Timeline）。
- 服务端受控入口（consumer 由路由固定）、selection 闭包与五步检测顺序、token 确定性公式、fingerprint 规范化、`sourceRef` 不可寻址、错误码映射层。

## 1. 结论

Phase 3 按以下顺序推进：

1. **Phase 3.0A：Timeline 去 Canon 的混合版本兼容（独立提交、独立回退）。**
2. **Phase 3.0B：冻结 `WorldContextRef` / `runContext`（含归属与生命周期）、双投影、selection 闭包、预算 / 错误 / 日志契约。**
3. **Phase 3.1：增强 World Console，让用户看懂将带入模式的来源、健康与闭包结果。**
4. **Phase 3.2：分段接入四模式。** 写作 / 游戏复用各自既有的服务端入口（consumer 由路由固定）；叙界 / 开放沙盒**必须先完成 3.2-C0：服务端受控模式入口 + 宿主绑定与代办**（§6.4、§7）。

推荐「**服务端由引用生成快照、再分别投影为 UI / 模型两种视图**」：客户端只提交 `worldId + expectedWorldRevision + selection`；服务端重读**已保存** World、校验 revision 与 selection、按白名单生成内部 `WorldContextSnapshot`，随后：

- 走 **UI Projection** 给控制台「查看来源 / 预览」，允许出现内部 ID；
- 走 **Model Projection** 给四模式模型输入，默认剥离内部 ID 与路径。

四模式复用同一解析器与同一份 `runContext` 注册表。Phase 3 不建立世界事件总线、全局 Canon、后台同步、长期上下文任务或第二套模型调用链；模式产出的章节、回合、对话、沙盒事件不写回 World，World revision 在模式运行前后保持不变。

## 2. 当前代码事实

### 2.1 已有 World Workspace 能力

- 服务端 World 真源：`cfg.DataDir()/worlds/world-<id>.json`，无 `index.json`；内容哈希 revision + 整文档 CAS、归档/恢复、损坏 warning、错误路径脱敏。
- 世界身份字段、世界设定（基调/规则）、角色、地点、势力、世界资料、时间线编辑与引用完整性。
- Master Asset 的 `entity/world` scope、薄快照、`masterRevision`、按需健康检查与显式刷新；不复制正文/头像。
- 主书、主互动故事的目标选择与失效展示。
- 四模式入口：写作先切主书、游戏先选主故事、叙界进入既有 iframe、沙盒打开 iframe 内 Module4；统一单次离开确认。
- 创建向导 AI `StructureProposal → 用户采纳/编辑 → 原子创建 World`；AI 不是控制台运行依赖（Phase 2B.2 已交付服务端受控入口先例 `POST /api/world-proposals`：module 服务端固定、服务端重读素材、严格解析与增强）。

### 2.2 已核实的模式侧事实

- 写作：`/api/chat`、`/api/chat/context-analysis`，存在异步任务、SSE 流、active 查询、abort、重连/恢复、重新生成路径，目前均无 `world_context`。
- 游戏：`/api/interactive/chat` 及对应 context-analysis、turn/branch/Actor State/Director Plan、活动回合恢复与重生成，目前无 `world_context`。
- **叙界 / 沙盒**：
  - `app/ai-client.js` 的 `NarraverseSharedAI.chat()` **由浏览器直接 `POST /api/model/chat`**；
  - `app/app.js` 依据 `module4-active` 在**浏览器**决定提交 `module=narraverse|module4`；
  - `denova-src/internal/api/handlers/handler_model_gateway.go` 当前直接 `BindJSON` 为 `ModelGatewayChatRequest` 并调用 `GenerateModel`，**不校验调用方身份与上下文**；
  - `NarraverseWorkspace` 与 `app/bridge.js` 为 v1 iframe 宿主协议，已做同源、来源 window、消息类型校验，但无世界上下文消息。
  - → 因此「通用网关拒收自由 consumer」与「Narraverse/Module4 复用浏览器直调链」**不可能同时成立**；v2.1 起改为受控入口 + 宿主代办，v2.2 进一步冻结**归属**（iframe 不持有 `runContextId`）。
- Timeline：Go（`internal/world`）与 TS（`features/world-workspace/types.ts`）当前仍是 `canon|planned`，schemaVersion 仍为 1；`category` 目前为 `string + omitempty`，**无法区分 `missing` / `null` / `""`**（v2.2 §8.1 明确要求区分）。

### 2.3 当前缺口

- 没有 `WorldContextRef / WorldContextSnapshot / UI Projection / Model Projection / runContext` 契约。
- 四模式入口只导航，不携带/解析 World 背景；chat、interactive、iframe 协议均无世界字段。
- 绑定健康只在单档案/单资料按需出现，没有控制台总览与「被谁引用」的派生展示。
- Timeline 仍含 Canon，且空值形态无法区分，与「禁止 Canon + 不静默改写数据」冲突。
- 没有「本次进入模式携带哪些世界内容」的选择、闭包预览与来源视图。
- **没有服务端受控的叙界/沙盒调用入口**，也没有宿主侧的 runContext 归属与多实例生命周期。

## 3. 方案比较

### 方案 A：服务端由引用生成快照，再双投影（采用）

客户端提交安全引用，服务端重读 World、校验、生成唯一内部 Snapshot，再分别序列化为 UI / 模型两种投影。四模式受控入口调用同一解析器；runContext 的内部 scopeKey 由服务端派生/生成（不上线），宿主只在 iframe 场景本地保存返回的 `runContextId`。

- 客户端无法伪造 World 正文或绕过字段白名单。
- 一个解析器统一四模式字段、数量、脱敏、闭包与预算；UI 与模型各取所需、互不污染。
- 复用现有 World Store、内容哈希 revision、CAS 与错误体系；不持久化快照、不产生第二真源。

代价：写作/游戏入口增加同一个可选 `world_context` 引用字段；**新增叙界/沙盒两个服务端受控入口 + 宿主绑定层 + iframe 协议增量**（§6.4、§7）。

### 方案 B：浏览器直接把完整快照塞进各模式请求（不采用）

服务端无法区分真实 World 与客户端伪造内容；四入口重复实现校验与预算；容易把未保存草稿、绝对路径、过量内容送入模型，且无法做 UI / 模型分离。

### 方案 C：四模式各自 `GET /api/worlds/:id`（不采用）

四套隐式耦合，字段边界必然漂移；任一模式都可能误读运行字段或未来新增字段，且无法统一脱敏与闭包。

## 4. 双投影架构：UI Projection / Model Projection

### 4.1 为什么必须拆两份

内部解析只生成一次不可变 `WorldContextSnapshot`（内部对象，不出服务端边界）；对外存在两个互不替代的纯序列化函数。

```
已保存 World + WorldContextRef
        │  服务端：revision/selection/预算校验 + 闭包解析
        ▼
WorldContextSnapshot（内部、不可变、单次 run 内复用；含 omissions 审计）
   ├── projectForUI(snapshot)    → WorldContextUIView     （控制台预览/查看来源，可含内部 ID）
   └── projectForModel(snapshot) → WorldContextModelView  （模型输入，剥离内部 ID/路径，带 sourceRef）
```

- `projectForUI` 与 `projectForModel` 都是**纯函数**，同输入必同输出；二者都不得回读完整 World、不得自行扩展白名单、不得发起 Master 请求。
- 模式格式化器（写作/游戏/叙界/沙盒各自的提示排版）只接收 `WorldContextModelView`，不能接收内部 Snapshot 或 UIView。
- **ModelView 单一序列化**：一个 fingerprint 只序列化一次，落成 `modelViewBytes`；模型实际提示与 context-analysis 展示都用这份字节，禁止前端二次排版近似（§6.2、§9.1）。

### 4.2 内部 Snapshot（服务端内部对象）

字段语义沿用白名单（identity/setting/characters/locations/factions/timeline/materials/warnings），并明确：

- 内部 Snapshot 允许携带实体 id 与跨实体 id 引用，仅供两个投影函数消费；**不直接序列化给模型**。
- `generatedAt` 仅作运行元数据，不参与内容等值判断，也不进入 ModelView。
- **闭包省略审计 `omissions`**：
  ```
  omissions: Array<{
    kind: 'character_faction' | 'character_location' | 'faction_headquarters' | 'relationship_edge'
    ownerEntityId: string          // 被保留的源实体 id
    missingEntityId: string        // 因未入选而被省略的目标实体 id
    reason: 'target_not_selected' | 'target_cascaded_removed'
  }>
  ```
  内部 Snapshot 保留完整审计；`projectForUI` 输出全部（供「被闭包省略的悬空引用」展示）；`projectForModel` **不输出**任何 `omissions` 字段。

### 4.3 UI Projection（来源 / 预览投影）

`WorldContextUIView` 面向控制台：

- 允许保留 World 实体 id、`bindingId`、`masterItemId`，用于「查看来源」、高亮、回到对应分区。
- 展示：世界名/revision、闭包后实际入选清单、每条来源类型、被自动派生带入的 entity 绑定、**被闭包省略的悬空引用（来自 `omissions`）**、warnings（`legacy_timeline_category` / `binding_unchecked`）。
- 明确区分「**已保存 World**」与「**未保存草稿**」：存在 dirty 草稿时不生成权威 Snapshot，UI 只做本地结构预览并加「未保存，不会进入模型」标识（§10）。
- UIView 不进入任何模型请求体。

### 4.4 Model Projection（模型投影，默认脱敏）

`WorldContextModelView` 面向模型，规则：

- **默认不输出**：实体内部 id、`bindingId`、`masterItemId`、任何文件/绝对路径、`boundAt`、封面色、归档状态、主书路径、主故事 id、`customFields`、`growthNote`、Master 正文/嵌套正文/头像/远程 URL、Proposal/AI 原始输出、未保存草稿、`omissions`。
- **`sourceRef` 为不可寻址值**：
  ```
  sourceRef = base64url( HMAC-SHA256(runSalt, consumer + '|' + refKind + '|' + refValue)[0..16] )
  ```
  - `runSalt` 为每个 runContext 随机生成（32 字节，仅内存、不落盘、不进日志）；
  - 同一 runContext 内对同一输入稳定（可回指 UIView 映射表）；**跨 run 不可复现**；
  - 不可是对 `masterItemId` 的可逆编码；
  - 测试必须断言：`sourceRef` 不能用于 `/api/library/assets/:id`、`/api/worlds/:id` 或任何文件路径，也不能作为写入凭证。
- 角色只输出 `displayName/role/worldNote/关系展示名`；地点输出 `name/description/tags`；势力输出 `name/description/influence/stability`；时间线输出 `order/eraLabel/title/description/category(新三值)`；资料只输出薄快照 `name/tags/semanticType 展示名`。
- 模型投影内**不允许出现悬空引用**（闭包规则见 §5）：角色的 faction/location、势力总部、角色关系，目标未入选则省略或改展示名，绝不留内部 id。

### 4.5 双投影不变量（测试化）

1. 对任意 Snapshot，`projectForModel` 的序列化结果中，正则扫描不得出现任一内部 `bindingId/masterItemId/文件路径/source_id/sourceRef 反查痕迹`。
2. UIView 与 ModelView 的「入选集合」必须一致：闭包裁剪只发生一次（在内部 Snapshot 阶段）。
3. 纯函数：重复投影字节一致（`generatedAt` 不进投影）。
4. 任一模版格式化器只能读到 ModelView 白名单字段，越界字段在类型层不可达。
5. `projectForModel` 输出中不得出现 `omissions`；`projectForUI` 必须完整覆盖 Snapshot 的 `omissions`。

### 4.6 contextFingerprint 规范化

```
canonicalSelection = 归一化后的确定性 JSON（去重 + 稳定排序 + 固定字段顺序）
contextFingerprint = "v1|" + sha256hex( NFC( JSON({
    schemaVersion: <Snapshot schemaVersion>,
    consumer:      <writing|game|narraverse|module4>,
    worldRevision: <内容哈希>,
    canonicalSelection
}) ) ).slice(0, 32)
```

- 必须带**版本前缀与显式分隔**（`"v1|"`），字段集与顺序固定，避免不同 consumer / 不同 Snapshot 版本意外复用同一 fingerprint。
- `consumer` 必须参与 fingerprint：同一 World 同一选择在写作与沙盒下是不同上下文。
- fingerprint 只用于绑定、比对与日志（哈希），不承载正文。

## 5. selection 闭包规则

### 5.1 selection 形状与归一化

客户端提交 `WorldContextSelection`（`includeTone / ruleIndexes / characterIds / locationIds / factionIds / timelineEntryIds / bindingIds`）在服务端进入投影前必须**确定性归一化**：

- 所有 id 数组：去空白 → **幂等去重（普通重复值不视为错误）** → 按稳定规则排序（实体按 World 内顺序，而非客户端数组顺序）。
- `ruleIndexes`：非负整数、去重、升序、必须命中当前 World revision 的规则下标；**不接受负数、不接受越界**。
- 归一化结果是闭包计算的唯一输入；客户端顺序与重复度不影响 Snapshot 内容。

### 5.2 引用闭包（只裁剪、不偷偷扩容）

- **entity scope 绑定自动派生**：某角色/地点/势力入选时，其 `bindingId` 对应的薄快照自动进入 materials；**不能**通过单独提交 `bindingIds` 把「实体未入选」的 entity 绑定带入模型。
- **world scope 绑定才可单独选择**：`bindingIds` 中只允许出现 world scope 绑定；出现 entity scope id 判 `selection_invalid`。
- **跨实体引用闭包**（每次省略必须记入 `omissions`，见 §4.2）：
  - 角色的 `factionId/locationId` 目标未入选 → ModelView 省略该引用（UIView 标注「引用未入选」）。
  - 势力 `headquartersLocationId` 目标未入选 → 同样省略/改展示名。
  - 角色关系边只保留「源与目标都入选」的边，单边删除，不输出悬空目标。
- 闭包**只做减法**：除「入选实体的 entity 绑定」这一项派生外，不自动拉入用户未选的角色/地点/势力/时间线。

### 5.3 严格拒绝语义与检测顺序

**检测顺序（固定、可测）**：

1. **形状/类型解析**：字段类型、id 字符串可解析；不可解析 → `selection_invalid`。
2. **归属校验**：每个 id / 下标必须存在于**当前 revision** 的 World（已删除、绑定已移除、级联解引用后失效 → `selection_invalid`）。
3. **越权/越界校验**：`bindingIds` 出现 entity scope（越权偷渡）、`ruleIndexes` 负数或越界 → `selection_invalid`。
4. **去重 + 稳定排序**：普通重复值在此步**幂等归一化，不报错**。
5. **闭包计算**：只做减法并记录 `omissions`。

- 任一步致命失败 → 整个请求 `selection_invalid`，**不返回部分 Snapshot、不自动补全、不静默丢弃**，错误中回传「安全的非法选择清单」（只含客户端提交的 id，不含内部路径）。
- **普通重复 = 幂等去重**，拒绝只针对非法 / 越权 / 跨 World / 越界。若未来要把重复视为攻击信号，必须另立版本并**取消先去重**、明确检测顺序，本期不做。
- 同一 `masterItemId` 在 World 内本就唯一（2B.1 已强制），selection 不再处理重复来源。
- 选择结果在 UI 端即时预览闭包后的数量与「被省略引用」，但**服务端是最终权威**，前端计数不能替代服务端校验。

## 6. WorldContextRef 与 runContext 生命周期

### 6.1 Ref 与 Snapshot 的不可变性

```
interface WorldContextRef {           // 客户端可持有、可随请求提交的唯一对象
  worldId: string
  expectedWorldRevision: string       // 内容哈希；不等即 409，不自动换版本
  selection: WorldContextSelection
}
```

- Ref 是**不可变值对象**：改任一选择 = 新 Ref；它不是 Snapshot，不含正文。
- 服务端首次把 Ref 解析为内部 Snapshot 后，按 §4.6 计算 `contextFingerprint`。
- Snapshot/ModelView 在**一次模式运行（run）内不可变**，运行中 World 被他人更新也**不热替换**，仅在下次显式进入时按新 revision 重新解析。

### 6.2 两级注册表：runContext（scope 绑定）+ modelViewCache（共享字节）

v2.2 把 v2.1 的单层注册表拆为**两级**，以支持「多任务 / 多分支 / 多 iframe 实例并存」而不重复存正文：

```
RunContext {                        // 一级：scope → 上下文绑定（轻量，可多条）
  runContextId: string              // 服务端生成：32 字节 CSPRNG → base64url
  consumer: 'writing' | 'game' | 'narraverse' | 'module4'
  scopeKey: string                  // 服务端内部键（§6.3）：writing/game 由 task/story/branch 派生，iframe 类取 rc:<runContextId>；从不读取请求体
  worldId: string
  expectedWorldRevision: string
  contextFingerprint: string        // §4.6
  runSalt: []byte                   // §4.4 sourceRef 用；仅内存
  createdAt: number
  lastUsedAt: number
}

ModelViewCacheEntry {               // 二级：fingerprint → 字节（重内容，按引用共享）
  contextFingerprint: string
  modelViewBytes: []byte            // ≤ 96 KiB
  uiViewSummary: {...}              // 供上下文条显示，不含正文
  refCount: number                  // 被多少 RunContext 引用
  sizeBytes: int
  lastUsedAt: number
}
```

**存储与边界（冻结）**

- 存储：**仅进程内存**（`map` + mutex）。**不落盘**、不写 `world-<id>.json`、不写任务日志、不写故事存档/可导出运行数据、不写 localStorage。
- 单条 `modelViewBytes` ≤ **96 KiB**；同一 fingerprint 只保留 **一份** 字节（多 scope 共享）。
- 容量：`RunContext` ≤ **64 条**；`ModelViewCacheEntry` ≤ **32 条**且总量 ≤ **8 MiB**；超限按 `lastUsedAt` **LRU** 淘汰。
- 淘汰/过期后的行为：后续请求返回 `context_unavailable`，**降级为无上下文继续**，并提示「世界背景已失效，可重新进入以加载」；不自动重建、不要求客户端补 Ref。

**重启语义（冻结）**

- Denova 进程重启后两级注册表为空：`active` / `reconnect` / `context-analysis` / `model-call` 一律返回 `context_unavailable`，按**无上下文降级**继续（模式可用），**不自动重放、不追溯旧 Ref**。
- 与「刷新页面可无上下文运行」一致；不使用 localStorage 作为权威。

**一致性校验**

- 续接请求若显式携带 Ref 且与绑定 `contextFingerprint` 不一致 → `context_ref_mismatch`；**不得静默采用新或旧中的某一份**。
- 携带未知 / 过期 `runContextId` → `context_unavailable`（不视为越权）。
- 跨 consumer 使用同一 `runContextId` → `consumer_not_trusted`。

### 6.3 运行身份 → runContext 映射（scopeKey，冻结）

**核心冻结（第二轮复审）：scopeKey 是服务端内部键，永不出现在任何请求体 / 查询串 / iframe 消息中；客户端（含浏览器宿主与 iframe）不提交、也无法自造 scopeKey，更不得把它当授权凭证。** 线上只有两条绑定通道：①写作/游戏由服务端从**既有运行对象**派生；②叙界/Module4 由服务端在 bind 时**生成** `runContextId` 并仅回给宿主。

| consumer | scopeKey 来源（**服务端内部，不上线**） | 首次 bind 如何定位 scope（请求体**无** scopeKey） | 多任务 / 多分支 / 多实例语义 |
| --- | --- | --- | --- |
| `writing` | **服务端派生** `task:<serverTaskId>`；`serverTaskId` 是 `POST /api/chat` 时 `StartTask` **服务端生成**的 `task.ID()`（`agent.ChatRequest` 本身无 task 字段） | 首请求随 `world_context: Ref` 到达，服务端先建 task、再用该 `task.ID()` 内部派生并绑定；SSE / active / regenerate 走既有 task 通道，无需客户端传 scope | 每个写作任务（含同 task 的 regenerate）一条；新任务 = 新 runContext |
| `game` | **服务端派生** `story:<storyId>\|branch:<branchId>\|task:<serverTaskId>`；`story_id`/`branch` 是 `/api/interactive/chat` **既有字段**，task 亦由 `StartInteractiveTask` 服务端创建 | 服务端直接从既有 `story_id`(+`branch`) 与服务端 task 派生，**不新增请求字段** | **分支切换 = 新 scope / 新 runContext**；同分支 SSE 重连 / active / 重生成复用同一条 |
| `narraverse` | **服务端生成**：bind 时服务端 CSPRNG 生成 `runContextId`，内部 scopeKey = `rc:<runContextId>` | 受控入口首请求只带 `world_context: Ref`（无 `run_context_id`、无 scopeKey）→ 服务端新建并在**响应**回 `run_context_id`，**仅宿主保存**；宿主用本地内存 `iframeInstanceId → runContextId` 路由 | 每个 iframe 实例一次 bind = 一条；实例卸载由宿主 unbind；多实例并存 = 多条 |
| `module4` | 同 `narraverse`（consumer 由路由区分，内部 scopeKey 仍取 `rc:<runContextId>`） | 同上 | 每沙盒实例一条；「指定进入某个 adventure」的旧协议限制本期仍不解决 |

**并存与共享规则（冻结）**

- 多个 task / branch / iframe 实例**可同时存在**各自的 runContext（上限 64 条）。
- 若它们的 `contextFingerprint` 相同（同 World + 同 revision + 同 selection + 同 consumer），则**共享同一份 `modelViewBytes`**（`modelViewCache` 只存一份，`refCount` 计数），但**各自保留独立 runContextId**。
- 不同 consumer 的 fingerprint 天然不同（§4.6 含 consumer），因此**不跨模式共享**。
- runContext 与内部 scopeKey 是**一对一**：同一 `(consumer, scopeKey)` 重复 **bind** → fingerprint 相同则幂等复用、不同则替换旧绑定（细则见 §6.3.1）；`context_ref_mismatch` 只发生在 **resume** 同时携带冲突 Ref 时。

#### 6.3.1 scopeKey 形式化规则（v2.2 补强；第二轮复审冻结「线上无 scopeKey」）

- **世界上下文控制字段白名单（冻结）**：两个新增 iframe 受控入口只接受 `world_context?`、`run_context_id?`、`messages`；既有 `/api/chat`、`/api/interactive/chat` 保留原业务字段，只新增可选 `world_context`，并复用其**已有**的 task 创建结果与 `story_id`/`branch`，**均不新增 `run_context_id` 或 scopeKey**。请求体 / 查询串 / iframe 消息一旦出现 `scopeKey`、`scope`、`run_scope` 等任何自造运行身份字段 → 服务端（宿主桥）**忽略其值、不采信、记脱敏审计**，绝不以其作为绑定键或授权依据（iframe 侧按 §7.3 直接丢弃）。
- **两类来源（路径已按 consumer 固定，调用方无权选择）**：
  - **A 服务端派生（writing / game）**：只能使用**服务端已持有**的标识——服务端 `task.ID()`、既有 `story_id`/`branch`；这些标识本就由服务端生成或经过既有校验，客户端无法把它们伪造成授权凭证。**确定性**：同 task、同 `story+branch+task` 必得到字节相同的内部 scopeKey。
  - **B 服务端生成（narraverse / module4）**：bind 时由服务端 CSPRNG 生成 32 字节 base64url `runContextId`（同 §6.2），内部 scopeKey 直接取 `rc:<runContextId>`；宿主只保存返回的 `runContextId`，以**本地内存** `iframeInstanceId → runContextId` 路由，该 map 不上线、不持久化、不是凭证；iframe 全程不可见（§6.4）。
- **内部语法（只约束服务端自派生 / 自生成的键，测试锁定，不解析任何客户端输入）**：非空；字符集 `[a-z0-9:|._-]`；以 `kind:id` 为段、`|` 连接；长度 1～160；无首尾空白。
- **命名空间**：内部按 consumer 隔离；不同 consumer 即使 scopeKey 字符串相同也互不共享（§4.6 fingerprint 亦含 consumer）。
- **三种操作语义（区分首请求与续接）**：
  1. **bind（首请求 / 主动重绑）**：带 `world_context: Ref`、不带有效 `run_context_id`。服务端按上表得到内部 `(consumer, scopeKey)` 后 **upsert**：无绑定 → 新建（B 类在响应回 `run_context_id` 给宿主；A 类挂到本次服务端 task）；已绑定且 fingerprint 相同 → **幂等复用**（同一 id，不重复计 `refCount`）；已绑定且 fingerprint 不同 → **替换**（旧 runContext `refCount--`，即 §6.5「切换世界 / 改选择 = 新 run」），**不**返回 mismatch。
  2. **resume（续接）**：B 类带 `run_context_id`、A 类走既有 task / story 通道（Ref 可选）。命中且 consumer 一致 → 复用同一份 bytes；若**同时**带 Ref 且 fingerprint 与该 runContext 不一致 → `context_ref_mismatch`（不挑新或旧、不静默替换）。
  3. **unbind**：只由 §6.5 的 scope 事件或用户「清除上下文」触发；bare 请求不是 unbind（§7.5）。
- **派生缺失处理**：A 类在服务端拿不到必需运行标识（如 interactive 缺 `story_id`）→ 走**既有**请求校验 400（不新增错误码、不建 runContext、禁止「每请求临时解析 Snapshot」绕过注册表）；写作 task 由本次首请求创建，不存在「先于 task 绑定」。B 类 id 由服务端生成，因此**不存在**「客户端缺 scopeKey」这一失败形态。
- **iframeInstanceId 是宿主本地索引键（不上线）**：挂载期稳定，用于本地 `iframeInstanceId → runContextId` map；卸载即作废、发 unbind、丢弃本地 id；重新挂载 = 重新 bind = 新 `runContextId`，不复用上一实例。
- **脱敏**：内部 scopeKey 与 `runContextId` 同级——不回传 iframe、不进 ModelView、不进通用日志 / 存档 / 导出，日志只记其哈希（§9.3）。

### 6.4 iframe 归属规则（v2.2 冻结：iframe 不持有 runContextId）

**归属原则**

- `runContextId` **只存在于服务端与宿主内存**；**iframe 既不接收、也不持有、也不得回传**。
- 宿主负责**本地路由**：宿主在自己的消息桥里维护本地内存 `iframeInstanceId → runContextId`（`runContextId` 来自 bind 响应；内部 scopeKey 为服务端 `rc:<id>`，宿主不持有也不上传 scopeKey）；`iframeInstanceId` 由**宿主**按「当前已挂载的 iframe + 来源 window」派生为本地索引键，iframe 无法自报或伪造。
- 因此 iframe 天然不可能换 World、换 revision、换 selection 或换 consumer。

**消息契约（冻结）**

| 方向 | 消息 | payload（严格白名单） |
| --- | --- | --- |
| 宿主 → iframe | `world-context-changed` | `{ worldId, revision, displaySummary{ worldName, selectedCount } }`（**不含** `runContextId`、**不含** Snapshot/ModelView 正文、**不含**路径与密钥）；仅用于显示与用户确认 |
| iframe → 宿主 | `model-call-request` | `{ requestId, messages }` —— **只传消息**；出现 `runContextId` / `worldId` / `revision` / `selection` / `consumer` 任一字段 → 宿主**丢弃该请求并记审计**，不转发 |
| 宿主 → iframe | `model-call-result` | `{ requestId, content, contextSummary?{ worldName, revision, selectedCount } }`（不含 `runContextId`、不含 ModelView 正文） |

**其它冻结行为**

- 旧 iframe 未实现新消息时：按 v1 旧协议继续运行，其 `NarraverseSharedAI.chat()` 直调 `/api/model/chat` **不带世界上下文**，行为与 Phase 2B 基线完全一致（§9.4）；宿主不得为其伪造上下文。
- 旧 iframe 的 `world-context-changed` 摘要可作为只读展示；宿主 → iframe 消息不得携带任何写 World 的指令。
- iframe 内不得缓存 ref/摘要以外的世界数据；不得把摘要写入自身持久化存储。
- Module4 复用同一消息与受控入口，不另建 Module4 专属模型配置。

### 6.5 分路径行为契约与清理粒度

| 路径 | 世界上下文行为 |
| --- | --- |
| 写作 `/api/chat` 首次请求 | 带 Ref → 校验、创建 runContext（consumer=writing，scopeKey 见 §6.3）、注入只读 ModelView |
| 写作 SSE stream / reconnect / active | 服务端凭既有 task/run 关联取回 runContext 与同一份 bytes；客户端和宿主**不提交** `runContextId`，也不再接收/采信另传的 Ref |
| 写作 `/api/chat/context-analysis` | 返回该 runContext 的**同一份 `modelViewBytes`** 与来源映射；无绑定则返回「无世界上下文」 |
| 写作 regenerate / abort 后续取 | 沿用原 runContext（同一 task）；用户改了选择 → 以新 Ref 起**新 run** |
| 游戏 `/api/interactive/chat`、turn / branch / active / regenerate | 服务端凭既有 story/branch/task 关联取回 runContext；**branch 切换 = 新的服务端内部 scopeKey / 新 runContext**；客户端不提交 `runContextId` 或 scopeKey，Actor/Director 逻辑不读取 World 写接口 |
| 叙界 / Module4 | 宿主按 §6.4 代办（iframe 只传消息）；consumer 由受控入口**路由**固定 |

**清理粒度（冻结，四档）**

1. **scope 事件（最优先，即时）**：写作 task 结束 / 取消；游戏 branch 切换或删除、活动回合结束；iframe 实例卸载；adventure 结束 → 立即解绑对应 runContext（`refCount--`）。
2. **空闲 / 绝对 TTL**：`runContextIdleTTL = 30min`（每次使用刷新）；`runContextMaxTTL = 6h`（强制解绑）。
3. **共享字节释放**：`modelViewCache` 条目的 `refCount == 0` 且空闲 ≥ 30min 才释放；容量兜底按 LRU（32 条 / 8 MiB）先淘汰 `refCount == 0` 的条目，仍有压力时才淘汰 `refCount > 0` 的最久未用条目（被淘汰者的后续请求 → `context_unavailable`）。
4. **全量**：Denova 进程重启 → 两级注册表清空。

**其它清除语义**

- **用户「清除上下文」**：立即解绑**该 consumer 的当前 scope**（只影响该实例/任务/分支），其余实例不受影响；该模式回到无 World Context 基线；已在途请求继续用其已注入的 ModelView 直到结束。
- **切换世界 / 改选择**：新 fingerprint → 新 runContext（旧 runContext 按 TTL 自然回收）。
- **revision 变化（409）**：提示「世界背景已更新」，用户回控制台重新确认后以新 Ref 启动新 run；不自动热替换。
- **页面重挂载**：活动 run 凭服务端 runContextId 恢复上下文显示；无活动 run 或已过期时允许丢失（降级为无上下文）。
- **World 在运行期间被归档**：已绑定的不可变 ModelView 可继续用到本次请求/run 结束；**新请求**一律 `world_archived` 拒绝加载上下文（§9.2）。

## 7. consumer 可信边界（受控入口 + 宿主绑定）

### 7.1 冻结：服务端受控模式入口 + 宿主代办

**consumer 永远由服务端路由/调用上下文决定，客户端（含 iframe）不得提交。**

| 受控入口 | 服务端固定 consumer | 说明 |
| --- | --- | --- |
| `POST /api/chat`（既有） | `writing` | 请求体若声明其它 consumer → 忽略并记审计；世界上下文只经 `world_context: Ref`；**scope 由服务端从本次 `StartTask` 的 `task.ID()` 内部派生，不新增字段**（§6.3 A 类） |
| `POST /api/interactive/chat`（既有） | `game` | 同上；scope 由服务端从既有 `story_id`/`branch` + 服务端 task 派生（§6.3 A 类） |
| `POST /api/world-context/narraverse/model-call`（**新增**） | `narraverse` | **仅宿主调用**；body 严格 = `{ world_context?: Ref, run_context_id?: string, messages: [...] }`，**无 scopeKey**；首次 bind 由服务端生成并回 `run_context_id`（§6.3 B 类） |
| `POST /api/world-context/module4/model-call`（**新增**） | `module4` | 同上，路由不同即 consumer 不同 |
| `POST /api/model/chat`（既有，**降级**） | — | **仅旧 iframe 兼容**：不承载世界上下文；出现 `world_context` / `consumer` / `run_context_id` / `scopeKey` 任一字段 → `consumer_not_trusted` |

新增受控入口的契约要点：

- **不是第二套模型调用链**：内部只做「严格解码 → 校验 `world_context`/`runContextId` → 绑定/复用 runContext → 拼接只读 ModelView 段 → `App.GenerateModel(module=narraverse|module4)` → 返回内容与字节摘要」，复用既有模型网关与 provider 兼容层。
- **拒绝客户端正文/自由参数**：不接受客户端提交的 Snapshot / ModelView / 系统 Prompt / 字段白名单扩展，也**不接受自造 `scopeKey`/运行身份字段**（出现即忽略并记审计，§6.3.1）；只接受 `Ref` 或 `runContextId` + `messages`。
- **`runContextId` 只由宿主提交**（服务端无法区分「宿主」与「任意浏览器」的传输层差异，因此额外约束：`runContextId` 不可推导、不可枚举，且必须与请求路由固定的 consumer 一致；跨 consumer → `consumer_not_trusted`）。
- **首调用与续调用（无客户端 scopeKey）**：writing/game 首请求由服务端建 task / 读 `story_id` 后**内部派生** scope；iframe 类首请求带 `world_context: Ref`（无 `run_context_id`、无 scopeKey）→ 服务端生成 runContext 并在响应返回 `run_context_id`（**宿主保存，不下发 iframe**）；之后带 `run_context_id` 复用；两者同时出现且 fingerprint 不一致 → `context_ref_mismatch`。
- **无世界上下文调用（bare）**：新增 iframe 受控入口两字段都不带时为 bare；写作/游戏则由服务端适配层先按 task/story/branch 解析活动绑定，解析不到且本次未带 Ref 才是 bare。完整规则见 **§7.5**；consumer 仍由路由固定。

### 7.2 最小权限与同构白名单

- 四 consumer 共用同一基础字段白名单；未来确需差异化（如沙盒需要更多规则）必须在服务端以「consumer → 允许字段集」的**收紧**表实现，默认收敛、不可由客户端扩大。
- 所有入口继续受 Denova 既有本地/远程访问控制约束，不新增匿名 World 读取通道。
- 加载上下文的前提：用户显式从某 World Console 进入；World id 合法、存在、active；revision 匹配；selection 合法；预算未超。

### 7.3 iframe 信任边界与越权处置

- `world-context-changed` / `model-call-request` / `model-call-result` 均校验同源、来源 window 必须是**当前已挂载**的 iframe、协议版本与消息类型；忽略任何其它来源 window 的同名消息。
- **越权处置（冻结）**：`model-call-request` 出现 `runContextId` / `scopeKey` / `worldId` / `revision` / `selection` / `consumer` 等任一保留字段 → 宿主**丢弃**、记审计（脱敏）、回 `model-call-result{ error: 'consumer_not_trusted' }`，**不转发**给服务端。
- 消息方向控制：宿主 → iframe 只传只读摘要（§6.4）；iframe → 宿主不得请求写 World。
- 不在 iframe 内拼装完整 World，不存放可寻址凭证；`sourceRef` 与 `runContextId` 均不可用于寻址或写入。

### 7.4 迁移与兼容（旧 iframe 行为不变）

- 旧 iframe（未实现新消息）：继续直调 `/api/model/chat` 且**不带世界上下文**，行为与 Phase 2B 基线一致；本期不要求旧 iframe 改造。
- 新 iframe：优先走宿主代办；若宿主不支持 `model-call-request`（协议版本未协商），回退为「无世界上下文直调」，并显式提示「本次未携带世界背景」。
- 任何回退都不得伪造世界上下文，也不得把回退文本伪装成已加载背景。

### 7.5 受控入口「无上下文（bare）」规则（v2.2 补强，冻结）

受控入口的上下文状态由**服务端适配层解析结果**决定，不能只按请求中是否出现 `world_context` / `run_context_id` 机械判断。既有 `/api/chat`、`/api/interactive/chat` 仍保留各自业务字段；下表只描述新增的世界上下文控制字段与服务端既有运行身份：

| 入口与形状 | 世界上下文控制字段 / 服务端身份 | 语义 |
| --- | --- | --- |
| 原生 bind（写作 / 游戏起始或主动重绑） | `world_context: Ref`；服务端从 task/story/branch 派生内部 scope | 按 §6.3.1 upsert runContext，注入只读 ModelView |
| 原生 active（续接 / stream / reconnect / regenerate） | 客户端不传 Ref、`run_context_id` 或 scopeKey；服务端凭既有 task/story/branch 找到绑定 | 复用已绑定 runContext，`context_state='active'` |
| 原生 **bare** | 本次服务端运行身份没有绑定，且请求未主动 bind | 本次不携带世界背景，`context_state='none'` |
| iframe bind | 宿主传 `world_context: Ref`（无有效 `run_context_id`） | 服务端新建绑定并只向宿主返回 `run_context_id` |
| iframe resume | 宿主传 `run_context_id`（Ref 可选） | 复用已绑定 runContext |
| iframe **bare** | 宿主两者都不传，只传 `messages` | 本次不携带世界背景，`context_state='none'` |

**bare 请求规则（冻结）**

1. **一等支持、非错误**：bare 的判定条件是「当前受控适配层未解析到活动绑定，且本次请求未要求 bind/resume」，不是“请求里刚好没有两个字段”；consumer 仍由路由固定。bare 不创建 runContext、不读 World、不生成 Snapshot/ModelView、不占两级注册表名额与 `refCount`、不触发任何 Master 请求；`messages` 直接走既有模型链，与 Phase 2B 基线一致。
2. **显式状态字段 `context_state`**：每个受控入口响应都带该字段——bind 成功 = `bound`、resume 命中 = `active`、bare = `none`、§9.2 允许的错误降级 = `degraded`。宿主据此区分「用户本次主动不带背景（none）」与「想带但失败被降级（degraded）」，**禁止把 degraded 伪装成 none**；bare 响应不含 `run_context_id` 与 `contextSummary`。
3. **不隐式升级、不隐式解绑**：原生续接先按服务端既有 task/story/branch 关联解析 active，iframe 续接只认宿主持有的 `run_context_id`；只有适配层最终解析为 bare 时才不注入。bare **不解除**任何仍存活的绑定（其 runContext 继续按 TTL 存活）。「清除上下文」只能走显式 unbind（§6.5），不能用连发 bare 代替。
4. **可交替、无需重启**：同一会话内 bare 与 bind/resume 可逐请求交替，每次独立判定 `context_state`；runContext 生命周期只受 bind/resume/unbind/TTL 影响，不受 bare 影响。
5. **context-analysis**：服务端按该入口既有运行身份解析后无绑定（或本次为 bare）时，返回 `context_state: 'none'` 的「无世界上下文」，属正常结果而非 4xx。
6. **不得成为错误绕过通道**：bare 不带 Ref，因此本就不触发 selection/revision/预算校验；反过来，任何**带了 Ref** 而命中 `selection_invalid`、`revision_conflict`、非窗口类 `budget_exceeded`、`world_archived` 的请求，**不得**改成「吞掉上下文当 bare 放行」，降级白名单仍严格以 §9.2 为准。
7. **通用网关与旧 iframe**：`/api/model/chat` 对世界上下文**永远等价 bare**，且一旦出现 `world_context` / `consumer` / `run_context_id` / `scopeKey` 即 `consumer_not_trusted`（§7.1）；旧 iframe 直调天然为 bare、无上下文（§7.4）。

## 8. Timeline 3.0A 兼容策略

去 Canon 作为**独立、可回退的 3.0A 提交**，先于 3.0B；未完成前不得声称 Snapshot 契约已冻结。新枚举：`background | historical | planned`；旧 `canon` 仅兼容读取、按 `historical` 展示，不批量迁移文件。

### 8.1 六个必须回答的问题（v2.2 冻结决策）

**① 读取（映射层位置、空值与缺失）**

- 在**解码边界统一归一化**：Go（`internal/world` 读盘/校验前）与 TS（前端读取）各有一处 `normalizeTimelineCategoryForDisplay`。
- 归一化**只用于展示与 ModelView**，不改变磁盘值（保存规则见 ②）。
- 空值三类 + 未知值一律不判损坏，按下表处理。

**② 空值 / 缺失保真（v2.2 新增，八态冻结表）**

| 磁盘形态 | 读取归一化（展示 / ModelView） | UI 显示 | warning | **未编辑时保存** |
| --- | --- | --- | --- | --- |
| `"category":"background"` | `background` | 背景 | — | 原值 `background` |
| `"category":"historical"` | `historical` | 历史 | — | 原值 `historical` |
| `"category":"planned"` | `planned` | 规划 | — | 原值 `planned` |
| `"category":"canon"` | `historical` | 历史（旧数据） | `legacy_timeline_category` | **写回 `"canon"`** |
| `"category":"<未知非空>"` | `background` | 背景（旧数据） | `legacy_timeline_category` | **写回原字符串** |
| `"category":""` | `background` | 背景 | — | **写回 `""`** |
| `"category":null` | `background` | 背景 | — | **写回 `null`** |
| 字段缺失（无 `category` 键） | `background` | 背景 | — | **保持缺失：保存时不新增该键** |

- **判定「未编辑」**：提交值 == 该条目**磁盘原值的归一化展示值**（`canon→historical`、未知/`""`/`null`/缺失→`background`），且用户未在该会话显式改过分类。
- **用户显式选择三值之一** → 写新值（覆盖任何保真原值），此后该条目为显式枚举。
- 新建条目直接写 `background`（不产生空值形态）。
- **禁止静默规范化**：不得因为内存归一化结果而把 `canon` / 未知值 / `""` / `null` / 缺失改写为 `background`。

**③ 解码侧实现约束（必须，不可省）**

- 当前 `category` 为 `string + omitempty`，**无法区分 `missing` / `null` / `""`**；3.0A 必须在解码边界保留**原始形态**（四态），冻结两种可接受实现（推荐 ①）：
  1. 在 `internal/world` 为 timeline 条目实现自定义 `UnmarshalJSON`，用 `json.RawMessage` 记录 `category` 原始字节（`missing` 与 `null` 可区分），并随 World 对象以**非持久化**读取侧状态携带；
  2. 读取侧 sidecar（`timelineCategoryRaw map[entryID]rawState`），仅在内存中存在，**不落盘**。
- 无论哪种实现：**不得新增持久化字段**、不得改变现有 JSON 字段名与 schemaVersion、不得让保真状态进入 ModelView 或通用日志。
- 保真回写路径**跳过枚举白名单**（原值原样回写），但仍受其它字段校验与 schemaVersion 约束；用户编辑路径只接受 `background|historical|planned`。
- CAS：保真回写与用户编辑都走既有 `expected_revision` 整文档 CAS，除该条目的 category 外不得改动任何其它字段。

**④ 旧版本二进制（回滚）策略 —— 精确措辞**

- 「独立可回退」的**准确含义**：**代码提交可回退**；但**一旦有 World 以新三值落盘，旧二进制不再保证可读写该文件**（旧校验只认 `canon|planned`，会得到字段校验失败）。
- 3.0A 发布说明必须包含**升级栅栏**：升级前备份 `cfg.DataDir()/worlds`（或使用内置导出）；明确「升级后不要用旧二进制回写同一数据目录」；若不提供数据备份/恢复能力，必须显式声明单向升级，并说明旧版本打开含新枚举文件的**确定行为**（400 + 明确提示，而不是判损坏或静默丢字段）。
- **不**引入 schemaVersion=2（避免与既有 F-05 语义校验耦合）；若未来需要新旧二进制长期共存，再单独立项。

**⑤ CAS 与原子保存**

- 「读旧值 → 内存归一（仅展示）→ 保真写回」走既有 CAS；归一化本身不产生 `updatedAt` 之外的额外脏写（`updatedAt` 仍只在真实保存时刷新）。

**⑥ 默认值与 UI 文案**

- 新建默认 `background`；空值/缺失按 ② 显示；旧 `canon` 显示「历史（旧数据）」；未知值显示「背景（旧数据）」并带 warning；三值中文文案：背景 / 历史 / 规划。

### 8.2 3.0A 测试与边界

- 定向测试（**八态全覆盖**）：  - 读 `canon` → 展示 `historical`、**保存后磁盘仍是 `canon`**；
  - 读未知值 → warning 且不损坏，**保存后磁盘仍是原字符串**；
  - 读 `""` → 展示 `background`、**保存后磁盘仍是 `""`**；
  - 读 `null` → 展示 `background`、**保存后磁盘仍是 `null`**；
  - 读缺失字段 → 展示 `background`、**保存后该键仍不存在**；
  - 用户显式改分类 → 写新三值并可往返；
  - CAS 下其它字段不丢；旧 `planned` 保持不变；
  - 混合版本：新二进制保存过的文件，用旧校验路径读取时给出**确定错误**（非静默丢字段）。
- 断言方式：对同一文件做「保存前后**字节级**比对」（除 `updatedAt`），确保保真不靠语义近似。
- Snapshot 的 ModelView 只输出新三值；`historical` 仅表示「该 World 内用户维护的既有历史」，**不是**跨模式共同剧情真相。
- 写作章节、游戏回合、叙界对话、Module4 事件永远不自动写入 Timeline。

## 9. 预算 / 错误 / 日志契约

### 9.1 预算：四层硬上限 + 确定性估算（服务端最终裁决）

数量上限（首版冻结）：角色/地点/势力各 20、时间线 30、显式 world 资料 20、选中对象合计 60（闭包**之后**计数）。

| 层 | 上限（首版冻结） | 计量方式（确定性，与环境无关） |
| --- | --- | --- |
| 选中对象数量 | 见上 | 闭包之后计数 |
| 内部 Snapshot 序列化 JSON | 96 KiB | UTF-8 编码字节数 |
| ModelView 模型可见文本 | 48,000 | **Unicode 码位（rune）数** |
| 模型 token 估算 | ≤ `min(12,000, consumerContextWindowTokens − 4,096)` | **确定性分段公式（下）** |

**消费者窗口加固（v2.2 新增，先于公式）**

```
consumerReserveTokens = 4_096
if consumerContextWindowTokens <= consumerReserveTokens:      // 即 ≤ 4096
    → budget_exceeded（413），不进入估算、不调用模型
effectiveModelBudget = min(12_000, consumerContextWindowTokens − 4_096)
```

- 窗口 ≤ 4096 时**直接 `budget_exceeded`**，不再计算 token 估算：此时预算必然 ≤ 0，任何上下文都会挤掉模式自身历史。
- 因该原因**不可由用户缩减选择修复**，允许**降级为无上下文继续**（§9.2 例外说明），UI 文案：「共享模型上下文窗口过小，本次不携带世界背景」。
- 该判断在**入口层**执行（写作/游戏/受控入口共用），保证四模式一致。

**token 估算器实际公式（冻结）**

1. **输入规范化（按序）**：
   1. Unicode **NFC** 规范化；
   2. 换行统一：`\r\n`、`\r` → `\n`；
   3. 去除每行行尾空白（空格/制表符）；
   4. 连续空行（≥2 个 `\n`）折叠为单个 `\n`；
   5. 去首尾空白。
2. **计量**：
   - `asciiCount` = 规范化后码位 ≤ `U+007F` 的数量；
   - `nonAsciiCount` = 其余码位数量（CJK、全角标点、emoji 均按 **1 码位 = 1** 计，emoji 不做组合序列合并，保持保守）。
3. **公式**：
   ```
   estimatedTokens = ceil(asciiCount / 4) + nonAsciiCount * 1 + sections * 8
   ```
   - `sections` = ModelView 中实际拼入提示的段数（identity/setting/characters/locations/factions/timeline/materials）；
   - 每段固定 8 token 结构开销。
4. **比较顺序（固定）**：**⓪** `consumerContextWindowTokens <= 4,096` → `budget_exceeded` → **①** 每字段/每实体数量与字符上限 → **②** Snapshot JSON ≤ 96 KiB → **③** ModelView rune ≤ 48,000 → **④** `estimatedTokens ≤ effectiveModelBudget`。
   任一超限 → `budget_exceeded`，**禁止静默截断、随机抽样、自动丢字段**；保留用户选择并指明层级、当前用量与上限。
5. **黄金样例（测试锁定，`sections = 1`）**：

   | 输入（规范化后） | asciiCount | nonAsciiCount | estimatedTokens |
   | --- | ---: | ---: | ---: |
   | `abc` | 3 | 0 | `ceil(3/4)=1 + 0 + 8 = 9` |
   | `a`×100 | 100 | 0 | `25 + 0 + 8 = 33` |
   | `你好` | 0 | 2 | `0 + 2 + 8 = 10` |
   | `你好世界` | 0 | 4 | `0 + 4 + 8 = 12` |
   | `Hello 世界` | 6 | 2 | `ceil(6/4)=2 + 2 + 8 = 12` |
   | `😀😀` | 0 | 2 | `0 + 2 + 8 = 10` |
   | `a\n\n\n\nb` → 折叠为 `a\nb` | 3 | 0 | `1 + 0 + 8 = 9` |

- 测试必须包含中文混排、英文、空白折叠、emoji 与**边界等值**（恰好等于上限必须通过）用例，防止「线上随机失败」。
- 估算器为纯函数：同一输入在任何机器、任何 locale 下结果一致（不使用 `Intl`、不依赖 `length`）。

### 9.2 稳定错误码契约

| code | 触发 | HTTP 倾向 | 用户 / 模式行为 |
| --- | --- | --- | --- |
| `world_not_found` | World 不存在 | 404 | 本次不带上下文，模式可无上下文继续 |
| `world_archived` | 已归档仍请求**新**上下文 | 409/422 | 拒绝新加载；在途 run 用完即止（§6.5） |
| `revision_conflict` | expectedWorldRevision 与当前不符 | 409 | 提示回控制台重确认，不自动换版本 |
| `selection_invalid` | 不可解析 / 不属于该 World / 跨 World / entity 绑定走 `bindingIds` / 下标越界 | 400/422 | 整体拒绝，回传安全非法清单，不返回部分快照 |
| `budget_exceeded` | 任一预算层超限（含 **⓪ 消费者窗口 ≤ 4096**） | 413/422 | 保留选择并指明层级；**若原因为消费者窗口过小，允许无上下文继续**（见下） |
| `context_ref_mismatch` | 续接请求 Ref 与 runContext fingerprint 不一致 | 409 | 拒绝静默替换，需以新 Ref 起新 run |
| `context_unavailable` | `runContextId` 未知 / 过期 / 被 LRU 淘汰 / **服务重启丢失** | 410 | **降级为无上下文继续**，提示可重新进入加载 |
| `consumer_not_trusted` | 通用网关收到 `world_context`/`consumer`/`run_context_id`/`scopeKey`；跨 consumer 复用运行句柄；iframe 越权字段（宿主丢弃）；直提 Snapshot | 403 | 拒绝 |
| `projection_failed` | 投影/格式化内部错误 | 500 | 本次降级为无上下文，记录脱敏诊断 |
| `world_unavailable` | World 服务暂时异常 | 503 | **允许**「本次请求不带 World Context」降级 |

**降级例外（v2.2 明确，冻结）**

- 允许「本次请求不携带 World Context」的**且仅限**以下原因：`world_unavailable`、`context_unavailable`、以及 **`budget_exceeded` 且原因为 `consumerContextWindowTokens ≤ 4096`**（用户无法通过缩减选择修复）。
- 其余 `budget_exceeded`（字段/实体/字节/rune/token 超限）、`selection_invalid`、`revision_conflict`、`world_archived` **不得**被吞掉后悄悄换版本或去掉上下文继续；必须让用户显式处理。
- **主动 bare 不是降级**：服务端适配层按 §7.5 解析为 bare 时，响应 `context_state='none'` 且**无错误码**；原生续接即使不带 `world_context/run_context_id`，只要服务端 task/story/branch 仍有关联，就必须解析为 `active`。只有本段列出的三类允许降级才标 `context_state='degraded'` 并带错误码。三者不得混同。

**错误码映射层（冻结）**

- `world_not_found` / `world_archived` / `revision_conflict` 属 **World Context 加载层**；World API 自身的 404 与 CAS 409 必须由**前端 World API 映射层**先转换为这三个语义，再与 Context 错误统一呈现。
- **不得**把 World **保存**的 CAS 冲突显示为 Context 加载失败，反之亦然；两者在 UI 上使用不同文案与入口（保存冲突 → 「重新加载」；上下文 revision 变化 → 「重新确认后进入」）。

### 9.3 日志与隐私契约

- 通用日志、错误响应、前端诊断上报中**禁止出现**：Snapshot/ModelView 正文、Master 正文、用户片段、Prompt、模型原始输出、本机绝对路径、`masterItemId/source_id` 等可寻址标识、`sourceRef` 原值、`runSalt`、`runContextId`、**Knowledge locator 原值**。
- **runContext 专属禁令**：`modelViewBytes`、`uiViewSummary`、`sourceRef` 映射表、`runSalt`、两级注册表内容**不得**进入通用日志、任务日志、故事存档、导出包或任何可跨会话读取的存储；只允许记录 `runContextId` 的**哈希**、字节数、consumer、耗时与 fingerprint 哈希。
- 允许记录：稳定错误码、各层计数与字节数、`contextFingerprint`（哈希）、`runContextIdHash`、consumer、耗时；错误响应沿用 F-05 路径脱敏，409 仅保留 expected/actual revision 哈希。
- context-analysis 面向**用户本人**展示其 ModelView 是允许的（用户自己的数据），但**不等于**可以写进服务端通用日志。
- warnings 不是实时 Master 健康结论：`binding_unchecked` 必须表达「尚未检查」；stale/missing/unavailable 沿用 2A 的按需检查语义，Snapshot 生成**不触发** Master 详情请求扇出。

### 9.4 接口兼容契约

- 无 `world_context` 的旧请求：字节级/语义级保持现状，四模式无 Snapshot 时与当前基线完全一致（含旧 iframe 直调 `/api/model/chat`）。
- 新字段对旧前端未知不影响其运行；iframe 未实现 `world-context-changed` / `model-call-request` 时按 v1 运行。
- 每个模式接入都带独立 feature flag / 回退路径，关闭即回到 Phase 2B 行为；不以全局开关或 localStorage 作为唯一回退手段。

## 10. Phase 3.1：World Console 增强（依赖 3.0A/3.0B）

在现有七分区、统一草稿、CAS、冲突重载、未保存离开保护、级联删除、世界资料显式移除之上**增量**增强，不重做导航。

### 10.1 P0

1. Timeline 分类迁移 UI（背景/历史/规划；旧 canon 显示「历史（旧数据）」、未知值显示「背景（旧数据）」、空值/缺失显示「背景」）—— 与 3.0A 同批。
2. **世界上下文准备卡**：当前 revision、始终包含的 identity/概述/基调/规则、实体与 world 资料选择入口；用 `projectForUI` 同源逻辑做**闭包预览**（直接消费 Snapshot 的 `omissions`）。
3. **上下文预览**：进入模式前看到本次来源清单与模型投影的只读文本（与运行同源的 `modelViewBytes` 渲染），但不展示系统 Prompt 模板。
4. **保存状态硬约束**：dirty 时不生成权威 Snapshot，只能「先保存」或「放弃草稿后继续」，绝不把草稿当已保存 World 送入模型。

### 10.2 P1

1. 绑定健康总览，按 unchecked/latest/stale/missing/unavailable 分组；**页面加载零 Master 扇出**；用户触发的批量检查需有限并发、可停止、不轮询，结果只在运行时。
2. 「被哪些实体使用」由实体 `bindingId` 即时派生；**不**新增 `ownerId`、不持久化 `references[]`。
3. 移除影响预览：列出将被解除的引用，复用 `removeWorldBinding`，不删实体/Master 原件。
4. 上下文条（四模式通用）：世界名、revision、入选数量、查看来源、清除上下文；上下文失效时显示「世界背景已失效，可重新进入」并可一键重进；窗口过小降级时显示「未携带世界背景（模型窗口过小）」。

### 10.3 P2（可延期）

实体搜索/排序/轻筛选、来源证据展开、关系列表视图。不做地图、关系图谱、拖拽画布、后台健康任务、自动同步。

## 11. Phase 3.2：四模式只读连接（依赖 3.0B，分段验收）

统一链路：

```
已保存 World → 用户选择 + 目标模式 → WorldContextRef（宿主持有）
  → 服务端重读 + revision/selection/闭包/预算校验 + 创建/复用 runContext（内部 scopeKey 由服务端派生/生成，不上线，§6.3）
  → 内部 Snapshot → projectForModel → 模式专用只读格式化器
  → 四模式既有模型/运行链路；产出只留各自存储，World 与 revision 不变
```

- **写作（3.2-A）**：进入前仍先 `onQuickSwitchBook(primaryBookPath)`；`/api/chat` 增可选 `world_context`（consumer 由路由固定为 `writing`），作为带来源说明的独立只读段加入既有上下文；stream/reconnect/active/context-analysis/regenerate 按 §6 复用 runContext；Agent 改书/选区路径无 World 写权限。
- **游戏（3.2-B）**：先 `selectInteractiveStory`；`/api/interactive/chat` 与其 context-analysis 同构接入（consumer=`game`）；World 仅稳定外部背景，turn/分支/Actor State/Director Plan 仍归互动故事；**分支切换产生新的服务端内部 scopeKey / 新 runContext**。
- **3.2-C0（前置，必须先完成）**：实现 §7.1 两个**服务端受控模式入口** + §6.4 宿主归属与代办协议（`world-context-changed` / `model-call-request` / `model-call-result`，iframe 不持有 `runContextId`）+ 通用 `/api/model/chat` 的世界上下文拒收（`consumer_not_trusted`）+ §6.3 scopeKey 映射与 §6.5 清理粒度。此段不改 iframe 既有渲染逻辑，只新增受控通路；旧 iframe 行为不变。
- **叙界（3.2-C）**：在 C0 之上接入——宿主下发只读摘要、iframe 经宿主代办调用受控入口，验证一次真实模型调用；iframe 不产权威 Snapshot，旧 iframe 保持 v1 行为。
- **Module4（3.2-D，最后）**：复用同一 iframe 代办与受控入口（consumer=`module4`）；宿主只在本地维护 `adventure/instance → runContextId`，服务端内部 scopeKey 仍为 `rc:<runContextId>`，线上不传 scopeKey；Snapshot 仅作初始背景，world clock/NPC/事件/结算继续是实例态；正式 executable 验证沙盒推进不改 World 文件/revision。

每段都必须：独立可回退、无上下文基线回归、覆盖首请求/续接/分析/重连、自动化断言「不调用任何 World 写端点且 World revision 前后不变」。

### 隔离矩阵

| 内容 | 写作 | 游戏 | 叙界 | Module4 | 是否进入 World |
| --- | --- | --- | --- | --- | --- |
| World identity / 基调 / 规则 / 所选实体 / world 资料 | 只读 | 只读 | 只读 | 只读 | 已在 World |
| 章节正文与修改 | 模式内 | — | — | — | **否** |
| 游戏 Turn / 分支 / Actor/Director | — | 模式内 | — | — | **否** |
| Narraverse 对话 / 前情摘要 | — | — | 模式内 | — | **否** |
| 沙盒时钟 / NPC / 事件 / 结算 | — | — | — | 模式内 | **否** |
| 模式生成的新设定 | 模式内草稿 | 模式内草稿 | 模式内草稿 | 模式内草稿 | **否；未来仅「提案→确认」** |
| runContext（绑定、ModelView 字节、sourceRef、runSalt） | 仅内存 | 仅内存 | 仅内存 | 仅内存 | **否；不入日志/存档/导出** |
| Knowledge 引用（sourceKind/sourceId/sourceRevision/locator） | 仅引用 | 仅引用 | 仅引用 | 仅引用 | **否；**只读投影，非真源 |

## 12. Knowledge Workspace / Obsidian 引用契约（v2.2 冻结形状，本期不实现）

方向不变：把**用户主动选择的片段**变成可追溯来源，不自动读整本小说/vault、不做另一个 World/Agent、不建立 Canon。

### 12.1 引用形状（冻结）

```
interface KnowledgeExcerptRefV1 {
  sourceKind:     'obsidian_vault' | 'book' | 'master_asset' | 'user_paste'
  sourceId:       string      // 逻辑源 id，由服务端注册表解析；禁止绝对路径
  sourceRevision: string      // 内容哈希 / vault 快照 revision；用于失效判定
  locator:        Locator     // 见 12.2，随 sourceKind 变化
}
```

- 浏览器只提交**引用**（`sourceKind/sourceId/sourceRevision/locator`），**不提交正文、不提交路径**；服务端按引用重读并校验 `sourceRevision`，不一致即失效（需用户重新选择）。
- 片段正文、Prompt、模型输出**不入通用日志**；`locator` 原值不入通用日志，也不进 ModelView（ModelView 只可出现脱敏后的来源展示名）。

### 12.2 locator 白名单（随 sourceKind 冻结）

| sourceKind | locator 字段 | 说明 |
| --- | --- | --- |
| `obsidian_vault` | `{ vaultId, filePath, heading?, blockId?, startOffset?, endOffset? }` | `filePath` **必须是 vault 内相对路径**；`vaultId` 由服务端 vault 注册表映射本地根，浏览器不可提交根路径 |
| `book` | `{ chapterId, startOffset, endOffset }` | 章节稳定 id + 偏移 |
| `master_asset` | `{ masterItemId, fieldPath }` | 复用总库字段白名单，不复制正文 |
| `user_paste` | `{ snippetHash }` | 用户主动粘贴片段的哈希，正文另行按会话临时处理 |

### 12.3 禁止绝对路径（冻结，服务端最终校验）

- **一律禁止**：盘符路径（`C:\...`）、UNC（`\\server\share`）、前导 `/` 或 `\`、包含 `..` 的路径段、URL 形式（`file://` / `http(s)://`）、以及任何可推出本机根目录的拼接。
- `obsidian_vault` 的 `filePath` 只接受 vault 内相对路径；`vaultId` 必须命中服务端注册表；越界或未注册 → `invalid_request`（不降级、不猜测）。
- 校验在**服务端**执行并作为最终裁决；前端提示不能替代。

### 12.4 Obsidian 关系图的定位（冻结）

- Obsidian vault 的 `[[wiki link]]`、backlink、图谱仅作为**只读投影**：只用于在知识视图中展示关系、便于用户挑选片段。
- **它不是 World 真源**：不写入 World、不参与 World 校验、不构成 Canon、不触发模式行为；World 仍是唯一持久化真源。
- 关系图不进入 ModelView 的 World 段；若未来需要作为参考，只能以「用户主动选择的片段引用」形式出现。

### 12.5 本期范围

- **只冻结形状与禁止项**：不建表、不建路由、不建组件、不建占位目录、不写未使用类型。
- 未来实现时的变更路径不变：`用户主动选择 → 引用（12.1）→ 服务端重读校验 → 提案 → 用户确认 → 原子保存`。

## 13. 风险与控制

| 风险 | 级别 | 控制 |
| --- | --- | --- |
| 模式剧情被误写成共同事实 | P0 | 无 World 写回接口；只收 Ref；验收比较 World JSON/revision 不变 |
| 内部 ID / 路径泄露进模型 | P0 | 双投影；ModelView 脱敏不变量测试；`sourceRef` 为 HMAC + 每 run 随机盐、不可寻址 |
| 浏览器伪造 consumer / 直提 Snapshot | P0 | 受控入口 consumer 由**路由**固定；通用网关拒收世界上下文字段；跨 consumer 复用句柄拒绝 |
| **iframe 越权持有/回传 runContextId 或换背景** | P0 | **iframe 不接收、不持有、不回传 `runContextId`**；`model-call-request` 只传 `messages`；宿主按来源 window 派生 `iframeInstanceId`；越权字段丢弃并记审计（§6.4/§7.3） |
| 旧 iframe 直调链与受控入口并存导致越权 | P0 | 通用网关对 `world_context`/`consumer`/`run_context_id` 一律 `consumer_not_trusted`；3.2-C0 先落地 |
| runContext 泄漏进日志 / 存档 / 导出 | P0 | 仅内存两级注册表；日志只记 `runContextIdHash` 与字节数；禁止写入任何持久化与导出 |
| 多任务 / 多分支 / 多实例并存导致绑定错乱或内存膨胀 | P1 | scopeKey 由**服务端**派生/生成、消费者隔离；两级注册表 + 上限（64 条 / 32 条 / 8 MiB）+ 四档清理粒度（§6.5） |
| **客户端自造 scopeKey/运行身份被当成绑定或授权凭证** | P0 | 线上协议**无 scopeKey 字段**：writing/game 服务端从 task/story/branch 派生，iframe 类服务端生成 id；请求体出现 scopeKey 一律忽略+审计，通用网关出现即 `consumer_not_trusted`（§6.3/§7.1） |
| scopeKey 不稳定（服务端派生用了随机 / 时间戳）导致 runContext 反复新建、绑定泄漏 | P1 | §6.3.1 强制用服务端稳定标识（task.ID/story_id/branch 或 CSPRNG 一次性 id）；同身份 bind 幂等复用（不重复 `refCount`）；内部语法测试锁定；scopeKey 只记哈希 |
| 受控入口混淆「主动无上下文」与「加载失败降级」，或对已绑定 scope 隐式注入 / 隐式解绑 | P1 | §7.5 三形状 + `context_state` 四值；bare 不读 World、不占名额、不隐式升降级；逐请求独立判定并补测试 |
| 首请求有上下文、重连/分析丢上下文或不一致 | P0 | runContext 绑定 + TTL/LRU；续接复用同一份 bytes；mismatch 拒绝 |
| World 更新后模式悄悄换背景 | P1 | expected revision + 409；显式重进，不热替换 |
| 上下文挤占模型预算 / 消费者窗口过小 | P1 | 四层硬上限 + 确定性 token 公式 + **窗口 ≤ 4096 直接 budget_exceeded**；禁止静默截断 |
| Timeline 空值/未知值被静默改写 | P1 | 3.0A 八态保真表 + 解码侧四态区分 + 字节级保真测试；升级栅栏与备份要求 |
| Context 错误与 World 保存 CAS 冲突混淆 | P1 | §9.2 映射层：保存冲突与上下文失效分开文案与入口 |
| **Obsidian / Knowledge 被当成第二真源或上传全文** | P1 | 只接受引用（12.1），禁止绝对路径；关系图仅只读投影；主动片段 + 服务端重读 + revision 校验；本期不实现 |
| 四模式各自解释 World | P1 | 单一解析器 + 双投影 + 薄格式化器，禁止各自 GET 全量 World |
| 健康总览形成请求风暴 | P2 | 页面零自动扇出；用户触发、有限并发、可停止 |
| Snapshot warning 被误读为实时健康 | P2 | warning 只表「未检查」；不触发 Master 请求 |

## 14. 分阶段交付与门禁（DoD）

### Phase 3.0A（独立提交）

- Go/TS 解码边界 `canon→historical`（仅展示）、**空值八态**策略（`null` / `""` / 缺失 / 未知 / canon / 三值）、新建默认 `background`。
- **解码侧四态区分**落地（自定义 UnmarshalJSON 或内存 sidecar，二选一），**不新增持久化字段**。
- **未编辑即保真**：`canon`、未知值、`""`、`null`、缺失在保存后**磁盘字节不变**（除 `updatedAt`）；用户显式改分类才写新值。
- 单向升级精确措辞 + 升级栅栏（备份指引 / 禁旧二进制回写 / 旧版本打开新枚举文件的确定行为）；CAS 保存不改其它字段；兼容定向测试全绿。
- 可独立回退；不夹带任何 Snapshot/模式接入代码。

### Phase 3.0B

- Ref / 内部 Snapshot（含 `omissions`）/ UI Projection / Model Projection、selection 归一化与闭包为**纯函数**，前后端同源契约测试。
- **两级 runContext 注册表契约**：`scopeKey` 映射（§6.3）、多 scope 共享同一 fingerprint 字节（`refCount`）、上限（64 / 32 / 8 MiB）、**四档清理粒度**（§6.5）、重启全丢 → `context_unavailable`；日志/存档/导出禁令测试。
- **iframe 归属契约测试**：iframe 侧不可见 `runContextId`；`model-call-request` 带保留字段被宿主丢弃（§7.3）。
- **scopeKey 规则测试（§6.3.1）**：①**线上无 scopeKey 字段**——任一受控入口请求体/查询/iframe 消息带 `scopeKey` 均被忽略且不影响绑定，通用 `/api/model/chat` 带该字段为 `consumer_not_trusted`；②writing 首请求绑定到服务端 `task.ID()`、game 绑定到 `story_id+branch(+task)`，客户端无法指定；③iframe 类 bind 由服务端返回 `run_context_id`、宿主本地映射，多 iframe 各得独立 id；④同身份重复 bind 幂等复用（不重复 `refCount`），换 fingerprint 的 bind 走替换、续接带冲突 Ref 走 `context_ref_mismatch`；⑤A 类缺必需标识走既有 400 且不建 runContext；scopeKey 不入请求体/ModelView/日志原值。
- `contextFingerprint` 规范化与 mismatch 一致性测试。
- 预算：**窗口 ≤ 4096 直接 `budget_exceeded`** + 四层上限 + token 黄金样例（含边界等值）；稳定错误码（含 `context_unavailable`）；日志脱敏（路径/`sourceRef`/`runContextId`/locator 不泄露）测试。
- `sourceRef` 不可寻址测试：跨 run 不可复现、不能作为任何 API 路径或写入凭证。
- 只从已保存 World 生成；不读 Master 正文/模式运行态；不新增持久化、任务、轮询、模型调用。
- Codex 节点审查通过后才进入 3.1/3.2。

### Phase 3.1

- 选择/闭包预览区分已保存与草稿；健康/引用/移除影响解释；`omissions` 展示；页面加载零 Master 扇出；Timeline 八态显示文案。
- 不增 ownerId/references[]/图库/后台；dirty/CAS409/Master404·5xx/旧 Timeline（含空值）、桌面与移动端均有定向测试。

### Phase 3.2

- **3.2-C0 先行**：两个受控模式入口 + 宿主归属与代办协议 + 通用网关世界上下文拒收 + scopeKey 映射与清理粒度；旧 iframe 行为不变；有越权拒绝测试。
- 四模式均可显式带入与清除；无上下文时与基线一致；revision/selection/预算（含窗口过小）/服务异常均可降级且不阻断模式启动；`context_unavailable` 有明确 UI 与重进入口。
- **无上下文（bare）规则测试（§7.5）**：bare 不建 runContext、不读 World、不占注册表名额，响应 `context_state='none'` 且无 `run_context_id`；原生续接不带世界字段时仍按服务端 task/story/branch 解析为 `active`，不得误判 bare；iframe 宿主主动 bare 既不注入也不解绑旧绑定；`none` 与 `degraded` 可区分；通用 `/api/model/chat` 带世界字段仍 `consumer_not_trusted`。
- 写作/游戏 context-analysis 展示与该 runContext **同一份 bytes**；stream/reconnect/active/regenerate 覆盖。
- iframe 校验同源/来源 window/版本/类型，旧 iframe 走 v1。
- 自动化断言四模式不调用 World 写端点、运行前后 World revision 不变。
- 正式 executable 端到端：进入模式→读背景→产出一次模式内容→返回 World→World JSON/revision 不变→重启仍不变（与 Vite dev/代理验收分别记录）。

## 15. 明确不做

- 全局 Canon、剧情共同真源、模式事件自动同步。
- 世界自动模拟、后台时间推进、Agent 自治世界。
- 章节/回合/对话/沙盒事件自动写 World 或 Timeline。
- 长期 World Context 任务、快照数据库/snapshotId、后台轮询、自动热更新；runContext 不持久化、不跨重启。
- 自动读取整本小说、完整互动故事、全部 Master、完整存档或整个 Obsidian vault。
- 重写 Module3/Module4、复制游戏引擎、Module4 专属 API/模型配置。
- 地图、关系图谱、图数据库与大型控制台重构；**把 Obsidian 关系图升级为 World 真源或 Canon**。
- 让通用模型网关接受浏览器自由 consumer、`world_context`、`run_context_id` 或客户端 Snapshot。
- 让 iframe 持有 `runContextId`、Ref 权威副本或任何 World 写能力。
- 在任何请求体 / 查询串 / iframe 消息中接收客户端自造的 `scopeKey`（或同义运行身份字段）作为绑定键或授权凭证；scopeKey 只能服务端派生/生成。
- Knowledge Workspace 实现（仅冻结引用形状与禁止项）。

## 16. 建议实施顺序

1. **3.0A**：Timeline 枚举兼容（八态保真 + 解码侧四态区分）与 UI 文案，独立可回退提交。
2. **3.0B**：Ref / 两级 runContext / 双投影 / 闭包 / fingerprint / 预算（含窗口加固）/ 错误 / 日志纯契约与测试，不接任何模式。
3. **3.1-P0**：保存状态约束、上下文选择与闭包/双投影预览（含 `omissions`）。
4. **3.1-P1**：健康总览（批量检查可延期）、引用位置、移除影响、上下文条。
5. **3.2-A**：写作只读接入（chat/stream/context-analysis/恢复/无上下文回归）。
6. **3.2-B**：游戏只读接入（turn/branch/active/stream/regenerate/revision 不变；分支切换产生新的服务端内部 scopeKey）。
7. **3.2-C0**：受控模式入口 + 宿主归属与代办 + scopeKey 映射与清理粒度 + 通用网关拒收世界上下文。
8. **3.2-C**：叙界接入（宿主协议增量 + 一次真实调用）。
9. **3.2-D**：Module4 复用同一受控通路，完成四模式不回写正式 executable 验收。

每步独立可回退；不得把控制台重做、Timeline 迁移、四模式接入、Knowledge Workspace 混成一次大改。

## 17. 架构裁定（v2.2 · Design Freeze）

- **Phase 3.0A：PASS TO PLAN**，独立先行，是 3.0B 的前置；须含**八态保真**与解码侧四态区分、升级栅栏。
- **Phase 3.0B：PASS TO PLAN（CONDITIONAL）**，以本版 §4～§9 的双投影、闭包、**两级 runContext（归属 + 生命周期 + 清理粒度）**、受控入口、预算（含窗口加固）/错误/日志冻结为前提。
- **Phase 3.1：PASS WITH DEPENDENCY**，依赖 3.0A/3.0B。
- **Phase 3.2-C0：PASS TO PLAN（前置）**，是叙界/Module4 接入的**强前置**；未完成前 3.2-C/3.2-D 不得开始。
- **Phase 3.2：PASS WITH DEPENDENCY**，按写作→游戏→3.2-C0→叙界→Module4 分段，每段独立回退与不回写验收。
- **Knowledge Workspace / Obsidian：保留方向与引用形状，禁止本期实现；关系图仅只读投影，不是 World 真源。**
- **设计不变量（本版冻结、不得放松）**：World 单一真源；UI/Model 双投影；四模式只读；不回写 World；不建立 Canon。
- **Codex 两项快速复审结论：PASS。** ①scopeKey 规则已闭合：线上协议无 scopeKey；writing/game 由服务端既有 task/story/branch 派生，iframe 类由服务端生成 `runContextId` 并取内部 `rc:<id>`，客户端自造字段不被采信；②受控入口无上下文规则已闭合：bare 是适配层解析后的显式状态，不会把原生续接误判为 bare，`none` 与错误降级 `degraded` 分离，且 bare 不隐式解绑。**v2.2 达到 Design Freeze，可进入 3.0A 实施计划；本裁定不授权开始编码。**
