# Narraverse2.0 World Workspace Phase 3 Architecture Plan（v2.1）

- 规划时间：2026-09-10（Asia/Shanghai）
- 文档版本：**v2.1（本版仅修订架构设计，不含生产代码）**
- 审查基线：`main` / `55fc07a2382ee2196c01b1d824d81b5ffbb42456`
- 前置状态：Phase 2B `CLOSED WITH ACCEPTANCE FOLLOW-UPS`
- 本文范围：Phase 3.0A～3.2 架构与实施顺序；**不包含生产代码实现**
- 文档状态：`READY FOR REVIEW（v2.1，待 Codex 只核对本版 diff）`
- 取代：本文件 v2；并落实 `docs/reviews/WORLD_WORKSPACE_PHASE3_ARCHITECTURE_V2_DIFF_REVIEW.md` 第 3 节 P0/P1 五项修订 + 第 4 节五项补强

## 0. v2 → v2.1 变更摘要（供 Codex diff 核对）

| 复审项（v2 diff review §3/§4） | v2.1 落点 |
| --- | --- |
| **P0** 通用网关真实调用边界与「拒收自由 consumer」冲突 | **§7.1 冻结方案 A′：新增服务端受控模式入口** `POST /api/world-context/narraverse/model-call`、`POST /api/world-context/module4/model-call`（**consumer 由路由固定**）；iframe 不再直连模型网关，改由**宿主 postMessage 代办**（§7.4）；通用 `POST /api/model/chat` 明确降级为「仅旧 iframe 兼容、**不承载世界上下文**」；§11 新增 **3.2-C0** 前置阶段；§17 裁定同步 |
| **P1** runContext 存活 / 清理 / 重启语义未具体 | **§6.2 冻结 `runContext` 注册表**：仅进程内存、字段与上限、空闲 TTL 30min / 绝对 TTL 6h、注册表 ≤64 条 且 ≤8 MiB LRU、**禁止进入通用日志/任务日志/故事存档/可导出运行数据**、**重启即全丢 → `context_unavailable` 无上下文降级**（§6.3/§9.2） |
| **P1** Timeline 未知值保真 | **§8.1 冻结「未编辑即保留磁盘原值」**：读层归一化只用于展示；CAS 保存时未被用户显式改分类的条目**原样写回原值（含旧 `canon` 与未知值）**；§8.3 精确回退措辞 + 升级栅栏与备份要求；§8.2 补字节级保真测试 |
| **P1** token 估算缺实际公式 | **§9.1 冻结确定性公式**：输入规范化规则 + ASCII/非 ASCII 分段计量 + 系数与取整 + headroom 常量 + 四层比较顺序 + 黄金样例表 |
| **P1** selection 重复语义冲突 | **§5.1/§5.3 冻结**：普通重复值**幂等去重、不报错**；`selection_invalid` 仅限不可解析 / 不属于当前 World / 跨 World / 越权 / 越界；冻结**检测顺序** |
| §4 补强：fingerprint 规范化 | **§4.6 新增**：`contextFingerprint = "v1|" + sha256(NFC(JSON({schemaVersion, consumer, worldRevision, canonicalSelection})))`，字段顺序固定、带版本分隔符 |
| §4 补强：闭包省略审计 | **§4.2 新增 `omissions` 审计**（内部 Snapshot 保留、UIView 可见、ModelView 不可见） |
| §4 补强：sourceRef 不可寻址 | **§4.4 冻结**：`HMAC-SHA256(runSalt, ref)` 截断，runSalt 每 run 随机不落盘；测试断言不可作为任何 API 路径或写入凭证 |
| §4 补强：错误码映射层 | **§9.2 新增映射层**：World API 的 404/409（CAS）先映射为 `world_not_found` / `revision_conflict`，不得被 Context 错误覆盖保存冲突 |
| §4 补强：ModelView 单一序列化 | **§4.4/§9.1 冻结**：context-analysis 展示与模型实际提示**必须使用同一份序列化字节**，禁止前端二次排版近似 |

> 保留 v2 已通过的设计（World 唯一真源、服务端重读与闭包、双投影分离、Timeline 去 Canon、渐进接入顺序、Knowledge 仅冻边界）不变。

## 1. 结论

Phase 3 按以下顺序推进：

1. **Phase 3.0A：Timeline 去 Canon 的混合版本兼容（独立提交、独立回退）。**
2. **Phase 3.0B：冻结 `WorldContextRef` / `runContext`、双投影、selection 闭包、预算 / 错误 / 日志契约。**
3. **Phase 3.1：增强 World Console，让用户看懂将带入模式的来源、健康与闭包结果。**
4. **Phase 3.2：分段接入四模式。** 其中写作 / 游戏复用各自**既有的服务端入口**（consumer 由路由固定）；叙界 / 开放沙盒**必须先完成 3.2-C0：新增服务端受控模式入口 + 宿主代办**（本版 §7），未完成前不得接入。

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
- **叙界 / 沙盒（本轮复审新增核实）**：
  - `app/ai-client.js` 的 `NarraverseSharedAI.chat()` **由浏览器直接 `POST /api/model/chat`**；
  - `app/app.js` 依据 `module4-active` 在**浏览器**决定提交 `module=narraverse|module4`；
  - `denova-src/internal/api/handlers/handler_model_gateway.go` 当前直接 `BindJSON` 为 `ModelGatewayChatRequest` 并调用 `GenerateModel`，**不校验调用方身份与上下文**；
  - `NarraverseWorkspace` 与 `app/bridge.js` 为 v1 iframe 宿主协议，已做同源、来源 window、消息类型校验，但无世界上下文消息。
  - → 因此 v2 的「通用网关拒收自由 consumer」与「Narraverse/Module4 复用现有浏览器直调链」**不可能同时成立**；v2.1 按 §7 改为受控入口 + 宿主代办。
- Timeline：Go（`internal/world`）与 TS（`features/world-workspace/types.ts`）当前仍是 `canon|planned`，schemaVersion 仍为 1。

### 2.3 当前缺口

- 没有 `WorldContextRef / WorldContextSnapshot / UI Projection / Model Projection / runContext` 契约。
- 四模式入口只导航，不携带/解析 World 背景；chat、interactive、iframe 协议均无世界字段。
- 绑定健康只在单档案/单资料按需出现，没有控制台总览与「被谁引用」的派生展示。
- Timeline 仍含 Canon，与「禁止 Canon」的产品语义不一致。
- 没有「本次进入模式携带哪些世界内容」的选择、闭包预览与来源视图。
- **没有服务端受控的叙界/沙盒调用入口**（当前只有浏览器直连的通用网关）。

## 3. 方案比较

### 方案 A：服务端由引用生成快照，再双投影（采用）

客户端提交安全引用，服务端重读 World、校验、生成唯一内部 Snapshot，再分别序列化为 UI / 模型两种投影。四模式受控入口调用同一解析器。

- 客户端无法伪造 World 正文或绕过字段白名单。
- 一个解析器统一四模式字段、数量、脱敏、闭包与预算；UI 与模型各取所需、互不污染。
- 复用现有 World Store、内容哈希 revision、CAS 与错误体系；不持久化快照、不产生第二真源。

代价：写作/游戏入口增加同一个可选 `world_context` 引用字段；**新增叙界/沙盒两个服务端受控入口并升级 iframe 宿主协议**（§7.1/§7.4）。

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
- **ModelView 单一序列化**：一个 runContext 只序列化一次，落成 `modelViewBytes`；模型实际提示与 context-analysis 展示都用这份字节，禁止前端二次排版近似（§6.2、§9.1）。

### 4.2 内部 Snapshot（服务端内部对象）

字段语义沿用白名单（identity/setting/characters/locations/factions/timeline/materials/warnings），并明确：

- 内部 Snapshot 允许携带实体 id 与跨实体 id 引用，仅供两个投影函数消费；**不直接序列化给模型**。
- `generatedAt` 仅作运行元数据，不参与内容等值判断，也不进入 ModelView。
- **闭包省略审计 `omissions`**（本轮新增）：
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
- **`sourceRef` 冻结为不可寻址值（本轮收紧）**：
  ```
  sourceRef = base64url( HMAC-SHA256(runSalt, consumer + '|' + refKind + '|' + refValue)[0..16] )
  ```
  - `runSalt` 为每个 runContext 随机生成（32 字节，仅内存、不落盘、不进日志）；
  - 同一 runContext 内对同一输入稳定（可回指 UIView 映射表）；**跨 run 不可复现**；
  - 不可是对 `masterItemId` 的可逆编码；
  - 测试必须断言：`sourceRef` 不能用于 `/api/library/assets/:id`、`/api/worlds/:id` 或任何文件路径，也不能作为写入凭证。
- 角色只输出 `displayName/role/worldNote/关系展示名`；地点输出 `name/description/tags`；势力输出 `name/description/influence/stability`；时间线输出 `order/eraLabel/title/description/category(新枚举)`；资料只输出薄快照 `name/tags/semanticType 展示名`。
- 模型投影内**不允许出现悬空引用**（闭包规则见 §5）：角色的 faction/location、势力总部、角色关系，目标未入选则省略或改展示名，绝不留内部 id。

### 4.5 双投影不变量（测试化）

1. 对任意 Snapshot，`projectForModel` 的序列化结果中，正则扫描不得出现任一内部 `bindingId/masterItemId/文件路径/source_id/sourceRef 反查痕迹`。
2. UIView 与 ModelView 的「入选集合」必须一致：闭包裁剪只发生一次（在内部 Snapshot 阶段）。
3. 纯函数：重复投影字节一致（`generatedAt` 不进投影）。
4. 任一模版格式化器只能读到 ModelView 白名单字段，越界字段在类型层不可达。
5. `projectForModel` 输出中不得出现 `omissions`；`projectForUI` 必须完整覆盖 Snapshot 的 `omissions`。

### 4.6 contextFingerprint 规范化（本轮新增）

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

### 5.3 严格拒绝语义与检测顺序（本轮冻结）

**检测顺序（固定、可测）**：

1. **形状/类型解析**：字段类型、id 字符串可解析；不可解析 → `selection_invalid`。
2. **归属校验**：每个 id / 下标必须存在于**当前 revision** 的 World（已删除、绑定已移除、级联解引用后失效 → `selection_invalid`）。
3. **越权/越界校验**：`bindingIds` 出现 entity scope（越权偷渡）、`ruleIndexes` 负数或越界 → `selection_invalid`。
4. **去重 + 稳定排序**：普通重复值在此步**幂等归一化，不报错**。
5. **闭包计算**：只做减法并记录 `omissions`。

- 任一步致命失败 → 整个请求 `selection_invalid`，**不返回部分 Snapshot、不自动补全、不静默丢弃**，错误中回传「安全的非法选择清单」（只含客户端提交的 id，不含内部路径）。
- **明确取消 v2 的语义冲突**：v2 §5.3 曾把「重复伪造 id」列为整体拒绝，与 §5.1「先去重」冲突；v2.1 冻结为 **普通重复 = 幂等去重**，拒绝只针对非法 / 越权 / 跨 World / 越界。若未来要把重复视为攻击信号，必须另立版本并**取消先去重**、明确检测顺序，本期不做。
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

### 6.2 采用方案：服务端 `runContext` 注册表（本轮冻结具体语义）

首次模式请求携带 `world_context: Ref`；服务端校验通过后创建一条 **runContext** 并返回其 id；此后该 run 的所有续接路径凭 `runContextId` 复用同一份 bytes，不再采信客户端另传的 Ref。

```
RunContext {
  runContextId: string        // 服务端生成：32 字节 CSPRNG → base64url（不可预测、不可枚举）
  consumer: 'writing' | 'game' | 'narraverse' | 'module4'
  worldId: string
  expectedWorldRevision: string
  contextFingerprint: string  // §4.6
  modelViewBytes: []byte      // 该 run 唯一序列化结果（模型实际提示 = context-analysis 展示）
  uiViewSummary: {...}        // 供上下文条显示（世界名/revision/入选数量），不含正文
  runSalt: []byte             // §4.4 sourceRef 用；仅内存
  createdAt: number
  lastUsedAt: number
  sizeBytes: int
}
```

**存储与边界（冻结）**

- 存储：**仅进程内存**（`map[runContextId]*RunContext` + mutex）。**不落盘**、不写 `world-<id>.json`、不写任务日志、不写故事存档/可导出运行数据、不写 localStorage。
- 单条大小：`modelViewBytes` ≤ **96 KiB**（与 Snapshot 序列化上限一致）。
- 注册表容量：≤ **64 条**且总量 ≤ **8 MiB**；超限按 LRU（`lastUsedAt`）淘汰。
- 生命周期：空闲 **30 分钟**（`runContextIdleTTL`）回收；绝对上限 **6 小时**（`runContextMaxTTL`）强制回收；每次使用刷新 `lastUsedAt`。
- 淘汰/过期后的行为：后续请求返回 `context_unavailable`，**降级为无上下文继续**，并提示「世界背景已失效，可重新进入以加载」；不自动重建、不要求客户端补 Ref。

**重启语义（冻结）**

- Denova 进程重启后注册表为空：`active` / `reconnect` / `context-analysis` / `model-call` 一律返回 `context_unavailable`，按**无上下文降级**继续（模式可用），**不自动重放、不追溯旧 Ref**。
- 这与「刷新页面可无上下文运行」一致；不使用 localStorage 作为权威。

**一致性校验**

- 续接请求若显式携带 Ref 且与绑定 `contextFingerprint` 不一致 → `context_ref_mismatch`，不得静默采用新或旧中的某一份。
- 携带未知 / 过期 `runContextId` → `context_unavailable`（不视为越权）。
- 跨 consumer 使用同一 `runContextId` → `consumer_not_trusted`。

### 6.3 分路径行为契约

| 路径 | 世界上下文行为 |
| --- | --- |
| 写作 `/api/chat` 首次请求 | 带 Ref → 校验、创建 runContext（consumer=writing）、注入只读 ModelView |
| 写作 SSE stream / reconnect / active | 凭 `runContextId` 复用同一份 bytes；**不再接收/采信客户端另传的 Ref** |
| 写作 `/api/chat/context-analysis` | 返回**该 runContext 的同一份 `modelViewBytes`** 与来源映射；无绑定则返回「无世界上下文」 |
| 写作 regenerate / abort 后续取 | 沿用原 runContext；用户改了选择 → 以新 Ref 起**新 run** |
| 游戏 `/api/interactive/chat`、turn / branch / active / regenerate | 同构（consumer=game）；Actor/Director 逻辑不读取 World 写接口 |
| 叙界 / Module4 | 经**新增受控入口**（§7.1）由**宿主代办**提交；服务端创建/复用 runContext（consumer 由路由固定） |

**一致性校验**：任何续接请求若携带与绑定 fingerprint 不一致的 Ref → `context_ref_mismatch`。

### 6.4 iframe（Narraverse / Module4）生命周期

- 宿主协议从 v1 增量、向后兼容地新增两条消息：
  - 宿主 → iframe：`world-context-changed`，payload 只含 `WorldContextRef` + 可显示摘要（世界名/revision/入选数量），**不含正文、路径、密钥、Snapshot、runContextId**；
  - iframe → 宿主：`model-call-request`（`messages` + 可选 `runContextId`）→ 宿主执行 §7.1 受控入口 → 宿主回 `model-call-result`（`content` + 可选摘要）。
- **iframe 不再直连 `/api/model/chat`**（该路径对世界上下文一律 `consumer_not_trusted`，见 §7.1）；Ref 只存活于宿主与 iframe 的**内存**。
- iframe → 宿主 的消息类型白名单中**不得出现**「保存 World / 更新实体 / 写回时间线」等任何 World 写动作。
- 旧 iframe 未实现新消息时：按 v1 旧协议继续运行，其 `NarraverseSharedAI.chat()` 直调 `/api/model/chat` **不带世界上下文**，行为与 Phase 2B 基线完全一致（§9.4）。
- Module4 复用同一消息与受控入口，不另建 Module4 专属模型配置；「指定进入某个 Module4 adventure」的旧协议限制本期仍不解决，单独立项。

### 6.5 清除 / 切换 / 重挂载 / 归档

- **清除上下文**：立即销毁该 consumer 的 runContext 绑定（并停止续接复用），该模式回到无 World Context 的基线；已在途请求继续用其已注入的 ModelView 直到结束，新请求不再带上下文。
- **切换世界 / 改选择**：产生新 Ref/fingerprint = 新 runContext；旧 runContext 不被改写（按 TTL 自然回收）。
- **revision 变化（409）**：提示「世界背景已更新」，用户回控制台重新确认后以新 Ref 启动新 run；不自动热替换。
- **页面重挂载**：活动 run 凭服务端 `runContextId` 恢复上下文显示；无活动 run 或已过期时允许丢失（降级为无上下文）。
- **World 在运行期间被归档**：已绑定的不可变 ModelView 可继续用到本次请求/run 结束；**新请求**一律 `world_archived` 拒绝加载上下文（§9.2）。

## 7. consumer 可信边界（P0 冻结方案 A′）

### 7.1 冻结：新增服务端受控模式入口 + 宿主代办

**consumer 永远由服务端路由/调用上下文决定，客户端不得提交。**

| 受控入口 | 服务端固定 consumer | 说明 |
| --- | --- | --- |
| `POST /api/chat`（既有） | `writing` | 请求体若声明其它 consumer → 忽略并记审计；世界上下文只经 `world_context: Ref` |
| `POST /api/interactive/chat`（既有） | `game` | 同上 |
| `POST /api/world-context/narraverse/model-call`（**新增**） | `narraverse` | 由宿主调用；body = `{ world_context?: Ref, run_context_id?: string, messages: [...] }` |
| `POST /api/world-context/module4/model-call`（**新增**） | `module4` | 同上，路由不同即 consumer 不同 |
| `POST /api/model/chat`（既有，**降级**） | — | **仅旧 iframe 兼容**：不承载世界上下文；出现 `world_context` / `consumer` / `run_context_id` 任一字段 → `consumer_not_trusted` |

新增受控入口的契约要点：

- **不是第二套模型调用链**：入口内部只做「严格解码 → 校验 `world_context`/`runContextId` → 解析并绑定 runContext → 拼接只读 ModelView 段 → `App.GenerateModel(module=narraverse|module4)` → 返回内容与本次 bytes 摘要」，复用既有模型网关与 provider 兼容层。
- **拒绝客户端正文/自由参数**：入口不接受客户端提交的 Snapshot / ModelView / 系统 Prompt / 字段白名单扩展；只接受 `Ref` 或 `runContextId` + `messages`。
- **首调用与续调用**：首次带 `world_context: Ref` → 创建 runContext 并在响应返回 `runContext_id`；之后带 `run_context_id` 复用；两者同时出现且 fingerprint 不一致 → `context_ref_mismatch`。
- **无世界上下文调用**：两个字段都不带 → 与基线等价（可继续服务纯聊天），consumer 仍由路由固定，不因缺上下文而放宽。
- **跨 consumer 校验**：`run_context_id` 的 consumer 与路由不一致 → `consumer_not_trusted`。

### 7.2 最小权限与同构白名单

- 四 consumer 共用同一基础字段白名单；未来确需差异化（如沙盒需要更多规则）必须在服务端以「consumer → 允许字段集」的**收紧**表实现，默认收敛、不可由客户端扩大。
- 所有入口继续受 Denova 既有本地/远程访问控制约束，不新增匿名 World 读取通道。
- 加载上下文的前提：用户显式从某 World Console 进入；World id 合法、存在、active；revision 匹配；selection 合法；预算未超。

### 7.3 iframe 信任边界

- `world-context-changed` / `model-call-request` 校验同源、来源 window 必须是当前已挂载的 iframe、协议版本与消息类型；忽略任何其它来源 window 的同名消息。
- 消息方向控制：宿主→iframe 只传只读 Ref（不含 runContextId 与正文）；iframe→宿主 不得请求写 World。
- 不在 iframe 内拼装完整 World，不存放可寻址凭证；`sourceRef` 与 `runContextId` 均不可用于寻址或写入。

### 7.4 迁移与兼容（旧 iframe 行为不变）

- 旧 iframe（未实现新消息）：继续直调 `/api/model/chat` 且**不带世界上下文**，行为与 Phase 2B 基线一致；本期不要求旧 iframe 改造。
- 新 iframe：优先走宿主代办；若宿主不支持 `model-call-request`（协议版本未协商），回退为「无世界上下文直调」，并显式提示「本次未携带世界背景」。
- 任何回退都不得伪造世界上下文，也不得把回退文本伪装成已加载背景。

## 8. Timeline 3.0A 兼容策略

去 Canon 作为**独立、可回退的 3.0A 提交**，先于 3.0B；未完成前不得声称 Snapshot 契约已冻结。新枚举：`background | historical | planned`；旧 `canon` 仅兼容读取、按 `historical` 展示，不批量迁移文件。

### 8.1 五个必须回答的问题（v2.1 冻结决策）

**① 新版本读取（映射层位置与空值）**

- 在**解码边界统一归一化**：Go（`internal/world` 读盘/校验前）与 TS（前端读取）各有一处 `normalizeTimelineCategoryForDisplay`。
- `canon → historical`（仅展示）；空串/缺失 → `background`（正常显示，不报错、不损坏）；未知值：读取时不判损坏，**展示**为 `background` 并产生 `legacy_timeline_category` warning。

**② 新版本写入（保真规则，本轮修订）**

- 新建条目默认写 `background`；UI 只产出新三值。
- **未编辑即保真**：CAS 保存时，若某条目在本次会话中**未被用户显式修改分类**，则**原样写回磁盘原值**——旧 `canon` 仍是 `canon`、未知值仍是原字符串；**不得**因为内存归一化结果而静默改写。
- 仅当用户在 UI 明确选择了 `background|historical|planned` 时才写入新值；写入白名单只接受新三值。
- 实现判定口径（冻结）：服务端在保存时以**当前磁盘值**为基准比对——若磁盘原值 ∈ {`canon`, 未知值} 且提交值等于该原值的**归一化展示值**（`canon→historical`、未知→`background`），视为「未编辑」，写回原值。
- **不做**全局批量改写；未保存过的世界文件保持原值。

**③ 旧版本二进制（回滚）策略 —— 精确措辞（本轮修订）**

- 「独立可回退」的**准确含义**：**代码提交可回退**；但**一旦有 World 以新三值落盘，旧二进制不再保证可读写该文件**（旧校验只认 `canon|planned`，会得到字段校验失败）。
- 3.0A 发布说明必须包含**升级栅栏**：
  - 升级前备份 `cfg.DataDir()/worlds`（或使用内置导出）；
  - 明确「升级后不要用旧二进制回写同一数据目录」；
  - 若不提供数据备份/恢复能力，必须显式声明单向升级，并说明旧版本打开含新枚举的文件时的**确定行为**（400 + 明确提示，而不是判损坏或静默丢字段）。
- **不**为此引入 schemaVersion=2（避免与既有 F-05 语义校验耦合）；若未来需要新旧二进制长期共存，再单独立项，不在 3.0A 范围。

**④ CAS 与原子保存**

- 「读旧值→内存归一（仅展示）→保真写回」走既有 `expected_revision` 整文档 CAS，除 category 归一外不得改动任何其它字段；归一化本身不产生 `updatedAt` 之外的额外脏写（`updatedAt` 仍只在真实保存时刷新）。

**⑤ 默认值与 UI**

- 新建默认 `background`；空 category 显示为背景；旧 `canon` 显示为「历史（旧数据）」；未知值显示为「背景（旧数据）」，并带 warning 提示；三值中文文案：背景 / 历史 / 规划。

### 8.2 3.0A 测试与边界

- 定向测试：
  - 读 `canon` → 展示 `historical`、**保存后磁盘仍是 `canon`**（字节级不变）；
  - 读空 → `background`；
  - 读未知值 → warning 且不损坏，**保存后磁盘仍是原未知字符串**；
  - 用户显式改分类 → 写新三值并可往返；
  - CAS 下其它字段不丢；旧 `planned` 保持不变；
  - 混合版本：新二进制保存过的文件，用旧校验路径读取时给出**确定错误**（非静默丢字段）。
- Snapshot 的 ModelView 只输出新枚举（展示层）；`historical` 仅表示「该 World 内用户维护的既有历史」，**不是**跨模式共同剧情真相。
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

**token 估算器实际公式（本轮冻结）**

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
   - `ceil(asciiCount / 4)`：ASCII 按 4 字符 ≈ 1 token 的保守估计；非 ASCII 按 1 码位 1 token 的保守上限；每段固定 8 token 结构开销。
4. **headroom 与比较顺序（固定）**：
   ```
   effectiveModelBudget = min(12_000, consumerContextWindowTokens − 4_096)
   ```
   `4_096` 为模式自身历史与输出的固定保留（常量 `consumerReserveTokens`）。校验顺序：
   **①** 每字段/每实体数量与字符上限 → **②** Snapshot JSON ≤ 96 KiB → **③** ModelView rune ≤ 48,000 → **④** `estimatedTokens ≤ effectiveModelBudget`。
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
| `budget_exceeded` | 任一预算层超限 | 413/422 | 保留选择，提示缩减，指明层级与用量 |
| `context_ref_mismatch` | 续接请求 Ref 与 runContext fingerprint 不一致 | 409 | 拒绝静默替换，需以新 Ref 起新 run |
| `context_unavailable` | `runContextId` 未知 / 过期 / 被 LRU 淘汰 / **服务重启丢失** | 410 | **降级为无上下文继续**，提示可重新进入加载 |
| `consumer_not_trusted` | 通用网关收到 `world_context`/`consumer`/`run_context_id`；跨 consumer 复用运行句柄；直提 Snapshot | 403 | 拒绝 |
| `projection_failed` | 投影/格式化内部错误 | 500 | 本次降级为无上下文，记录脱敏诊断 |
| `world_unavailable` | World 服务暂时异常 | 503 | **仅此情况**允许「本次请求不带 World Context」降级 |

**错误码映射层（本轮新增，冻结）**

- `world_not_found` / `world_archived` / `revision_conflict` 属 **World Context 加载层**；World API 自身的 404 与 CAS 409 必须由**前端 World API 映射层**先转换为这三个语义，再与 Context 错误统一呈现。
- **不得**把 World **保存**的 CAS 冲突显示为 Context 加载失败，反之亦然；两者在 UI 上使用不同文案与入口（保存冲突 → 「重新加载」；上下文 revision 变化 → 「重新确认后进入」）。
- `context_unavailable` 与 `world_unavailable` 的降级都只允许「本次请求不带 World Context」这一种形态；selection / budget / revision 类用户可修复错误**不得**被吞掉后悄悄换版本继续。

### 9.3 日志与隐私契约

- 通用日志、错误响应、前端诊断上报中**禁止出现**：Snapshot/ModelView 正文、Master 正文、用户片段、Prompt、模型原始输出、本机绝对路径、`masterItemId/source_id` 等可寻址标识、`sourceRef` 原值、`runSalt`、`runContextId`。
- **runContext 专属禁令（本轮补充）**：`modelViewBytes`、`uiViewSummary`、`sourceRef` 映射表、`runSalt` **不得**进入通用日志、任务日志、故事存档、导出包或任何可跨会话读取的存储；只允许记录 `runContextId` 的**哈希**、字节数、consumer、耗时与 fingerprint 哈希。
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

1. Timeline 分类迁移 UI（背景/历史/规划，旧 canon 显示「历史（旧数据）」、未知值显示「背景（旧数据）」）—— 与 3.0A 同批。
2. **世界上下文准备卡**：当前 revision、始终包含的 identity/概述/基调/规则、实体与 world 资料选择入口；用 `projectForUI` 同源逻辑做**闭包预览**（自动派生了哪些 entity 绑定、哪些跨实体引用因目标未选被省略——直接消费 Snapshot 的 `omissions`）。
3. **上下文预览**：进入模式前看到本次来源清单与模型投影的只读文本（与运行同源的 `modelViewBytes` 渲染），但不展示系统 Prompt 模板。
4. **保存状态硬约束**：dirty 时不生成权威 Snapshot，只能「先保存」或「放弃草稿后继续」，绝不把草稿当已保存 World 送入模型。

### 10.2 P1

1. 绑定健康总览，按 unchecked/latest/stale/missing/unavailable 分组；**页面加载零 Master 扇出**；用户触发的批量检查需有限并发、可停止、不轮询，结果只在运行时。
2. 「被哪些实体使用」由实体 `bindingId` 即时派生；**不**新增 `ownerId`、不持久化 `references[]`。
3. 移除影响预览：列出将被解除的引用，复用 `removeWorldBinding`，不删实体/Master 原件。
4. 上下文条（四模式通用）：世界名、revision、入选数量、查看来源、清除上下文；上下文失效时显示「世界背景已失效，可重新进入」并可一键重进。

### 10.3 P2（可延期）

实体搜索/排序/轻筛选、来源证据展开、关系列表视图。不做地图、关系图谱、拖拽画布、后台健康任务、自动同步。

## 11. Phase 3.2：四模式只读连接（依赖 3.0B，分段验收）

统一链路：

```
已保存 World → 用户选择 + 目标模式 → WorldContextRef
  → 服务端重读 + revision/selection/闭包/预算校验 + 创建/复用 runContext
  → 内部 Snapshot → projectForModel → 模式专用只读格式化器
  → 四模式既有模型/运行链路；产出只留各自存储，World 与 revision 不变
```

- **写作（3.2-A）**：进入前仍先 `onQuickSwitchBook(primaryBookPath)`；`/api/chat` 增可选 `world_context`（consumer 由路由固定为 `writing`），作为带来源说明的独立只读段加入既有上下文；stream/reconnect/active/context-analysis/regenerate 按 §6 复用 runContext；Agent 改书/选区路径无 World 写权限。
- **游戏（3.2-B）**：先 `selectInteractiveStory`；`/api/interactive/chat` 与其 context-analysis 同构接入（consumer=`game`）；World 仅稳定外部背景，turn/分支/Actor State/Director Plan 仍归互动故事；恢复活动回合复用 runContext。
- **3.2-C0（新增前置，必须先完成）**：实现 §7.1 两个**服务端受控模式入口** + §6.4 宿主代办协议（`world-context-changed` / `model-call-request` / `model-call-result`）+ 通用 `/api/model/chat` 的世界上下文拒收（`consumer_not_trusted`）。此段不改 iframe 既有渲染逻辑，只新增受控通路；旧 iframe 行为不变。
- **叙界（3.2-C）**：在 C0 之上接入——宿主下发 Ref、iframe 经宿主代办调用受控入口，验证一次真实模型调用；iframe 不产权威 Snapshot，旧 iframe 保持 v1 行为。
- **Module4（3.2-D，最后）**：复用同一 iframe Ref 与受控入口（consumer=`module4`）；Snapshot 仅作初始背景，world clock/NPC/事件/结算继续是实例态；正式 executable 验证沙盒推进不改 World 文件/revision。

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
| runContext（ModelView 字节、sourceRef、runSalt） | 仅内存 | 仅内存 | 仅内存 | 仅内存 | **否；不入日志/存档/导出** |

## 12. Knowledge Workspace 接口预留（本期不开发）

方向不变：把**用户主动选择的书籍片段**变成可追溯来源，不自动读整本小说、不做另一个 World/Agent。未来 `KnowledgeExcerptRefV1`（片段 id + sourceRevision + 章节 + 起止偏移）继续只在文档冻结：浏览器提交引用而非路径、服务端重读校验 revision、用户主动选择、产生变更走 `Proposal→确认→原子保存`、片段正文/Prompt/模型输出不入通用日志。Phase 3 不建表、路由、组件、占位目录或未用类型。

## 13. 风险与控制

| 风险 | 级别 | 控制 |
| --- | --- | --- |
| 模式剧情被误写成共同事实 | P0 | 无 World 写回接口；只收 Ref；验收比较 World JSON/revision 不变 |
| 内部 ID / 路径泄露进模型 | P0 | 双投影；ModelView 脱敏不变量测试；`sourceRef` 为 HMAC + 每 run 随机盐、不可寻址 |
| 浏览器伪造 consumer / 直提 Snapshot | P0 | 受控入口 consumer 由**路由**固定；通用网关拒收世界上下文字段；跨 consumer 复用句柄拒绝 |
| 旧 iframe 直调链与受控入口并存导致越权 | P0 | 通用网关对 `world_context`/`consumer`/`run_context_id` 一律 `consumer_not_trusted`；3.2-C0 先落地 |
| runContext 泄漏进日志 / 存档 / 导出 | P0 | 仅内存；日志只记 `runContextIdHash` 与字节数；禁止写入任何持久化与导出 |
| 首请求有上下文、重连/分析丢上下文或不一致 | P0 | runContext 注册表 + TTL/LRU；续接复用同一份 bytes；mismatch 拒绝 |
| World 更新后模式悄悄换背景 | P1 | expected revision + 409；显式重进，不热替换 |
| 上下文挤占模型预算 | P1 | 四层硬上限 + 确定性 token 公式 + 消费者更小预算；禁止静默截断 |
| 四模式各自解释 World | P1 | 单一解析器 + 双投影 + 薄格式化器，禁止各自 GET 全量 World |
| iframe 消息越权 | P1 | 同源/来源 window/版本/类型校验；只传 Ref；iframe→宿主无 World 写消息 |
| canon / 未知值被静默改写 | P1 | 3.0A「未编辑即保真」；升级栅栏与备份要求；字节级保真测试 |
| Context 错误与 World 保存 CAS 冲突混淆 | P1 | §9.2 映射层：保存冲突与上下文失效分开文案与入口 |
| 健康总览形成请求风暴 | P2 | 页面零自动扇出；用户触发、有限并发、可停止 |
| Snapshot warning 被误读为实时健康 | P2 | warning 只表「未检查」；不触发 Master 请求 |
| Knowledge 变成全文上传器 | P1 | 主动片段、服务端重读、revision/预算、禁自动全文 |

## 14. 分阶段交付与门禁（DoD）

### Phase 3.0A（独立提交）

- Go/TS 解码边界 `canon→historical`（仅展示）、空/未知值策略、新建默认 `background`。
- **未编辑即保真**：`canon` 与未知值在保存后磁盘字节不变；用户显式改分类才写新值。
- 单向升级精确措辞 + 升级栅栏（备份指引 / 禁旧二进制回写 / 旧版本打开新枚举文件的确定行为）落地；CAS 保存不改其它字段；兼容定向测试全绿。
- 可独立回退；不夹带任何 Snapshot/模式接入代码。

### Phase 3.0B

- Ref / 内部 Snapshot（含 `omissions`）/ UI Projection / Model Projection、selection 归一化与闭包为**纯函数**，前后端同源契约测试。
- `runContext` 注册表契约：TTL 30min/6h、容量 64 条/8MiB、LRU、重启全丢 → `context_unavailable`；日志/存档/导出禁令测试。
- `contextFingerprint` 规范化（版本前缀 + consumer + revision + canonicalSelection）与 mismatch 一致性测试。
- 预算：四层上限 + token 确定性公式黄金样例（含边界等值）；稳定错误码（含 `context_unavailable`）；日志脱敏（路径/`sourceRef`/`runContextId` 不泄露）测试。
- `sourceRef` 不可寻址测试：跨 run 不可复现、不能作为任何 API 路径或写入凭证。
- 只从已保存 World 生成；不读 Master 正文/模式运行态；不新增持久化、任务、轮询、模型调用。
- Codex 节点审查通过后才进入 3.1/3.2。

### Phase 3.1

- 选择/闭包预览区分已保存与草稿；健康/引用/移除影响解释；`omissions` 展示；页面加载零 Master 扇出。
- 不增 ownerId/references[]/图库/后台；dirty/CAS409/Master404·5xx/旧 Timeline、桌面与移动端均有定向测试。

### Phase 3.2

- **3.2-C0 先行**：两个受控模式入口 + 宿主代办协议 + 通用网关世界上下文拒收；旧 iframe 行为不变；有越权拒绝测试。
- 四模式均可显式带入与清除；无上下文时与基线一致；revision/selection/预算/服务异常均可降级且不阻断模式启动；`context_unavailable` 有明确 UI 与重进入口。
- 写作/游戏 context-analysis 展示与该 runContext **同一份 bytes**；stream/reconnect/active/regenerate 覆盖。
- iframe 校验同源/来源 window/版本/类型，旧 iframe 走 v1。
- 自动化断言四模式不调用 World 写端点、运行前后 World revision 不变。
- 正式 executable 端到端：进入模式→读背景→产出一次模式内容→返回 World→World JSON/revision 不变→重启仍不变（与 Vite dev/代理验收分别记录）。

## 15. 明确不做

- 全局 Canon、剧情共同真源、模式事件自动同步。
- 世界自动模拟、后台时间推进、Agent 自治世界。
- 章节/回合/对话/沙盒事件自动写 World 或 Timeline。
- 长期 World Context 任务、快照数据库/snapshotId、后台轮询、自动热更新；runContext 不持久化、不跨重启。
- 自动读取整本小说、完整互动故事、全部 Master 或完整存档。
- 重写 Module3/Module4、复制游戏引擎、Module4 专属 API/模型配置。
- 地图、关系图谱、图数据库与大型控制台重构。
- 让通用模型网关接受浏览器自由 consumer、`world_context`、`run_context_id` 或客户端 Snapshot。
- Knowledge Workspace 实现（仅冻结边界）。

## 16. 建议实施顺序

1. **3.0A**：Timeline 枚举兼容（含未知值保真）与 UI 文案，独立可回退提交。
2. **3.0B**：Ref / runContext / 双投影 / 闭包 / fingerprint / 预算 / 错误 / 日志纯契约与测试，不接任何模式。
3. **3.1-P0**：保存状态约束、上下文选择与闭包/双投影预览（含 `omissions`）。
4. **3.1-P1**：健康总览（批量检查可延期）、引用位置、移除影响、上下文条。
5. **3.2-A**：写作只读接入（chat/stream/context-analysis/恢复/无上下文回归）。
6. **3.2-B**：游戏只读接入（turn/branch/active/stream/regenerate/revision 不变）。
7. **3.2-C0**：受控模式入口 + 宿主代办 + 通用网关拒收世界上下文。
8. **3.2-C**：叙界接入（宿主协议增量 + 一次真实调用）。
9. **3.2-D**：Module4 复用同一受控通路，完成四模式不回写正式 executable 验收。

每步独立可回退；不得把控制台重做、Timeline 迁移、四模式接入、Knowledge Workspace 混成一次大改。

## 17. 架构裁定（v2.1）

- **Phase 3.0A：PASS TO PLAN（条件已明确）**，独立先行，是 3.0B 的前置；须含「未编辑即保真」与升级栅栏。
- **Phase 3.0B：PASS TO PLAN（CONDITIONAL）**，以本版 §4～§9 的双投影、闭包、runContext 生命周期、受控入口、预算/错误/日志冻结为前提。
- **Phase 3.1：PASS WITH DEPENDENCY**，依赖 3.0A/3.0B。
- **Phase 3.2-C0：PASS TO PLAN（新增）**，是叙界/Module4 接入的**强前置**；未完成前 3.2-C/3.2-D 不得开始。
- **Phase 3.2：PASS WITH DEPENDENCY**，按写作→游戏→3.2-C0→叙界→Module4 分段，每段独立回退与不回写验收。
- **Knowledge Workspace：保留方向，禁止本期开发。**
- **Codex 复审只核对本版 diff：** ①P0 受控入口与通用网关边界；②runContext 存活/清理/重启语义；③Timeline 未知值保真与回退措辞；④token 确定性公式；⑤selection 重复语义与检测顺序；⑥§4/§9 五项补强（fingerprint、omissions、sourceRef、错误码映射层、ModelView 单一序列化）。通过后再进入 3.0A 实施计划。
