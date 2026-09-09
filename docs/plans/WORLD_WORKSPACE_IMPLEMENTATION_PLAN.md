# World Workspace MVP 实施计划（v3.1 · 已批准开工）

- 文档状态：**用户已正式批准开工（2026-09-08）**。Codex 二审架构通过；v3 按二审 5 处契约修订；v3.1 完成开工前 4 处机械修正（archive 补 expected_revision、bindingId 所有权、精确联合类型、设计基调 4/3/7），无需再送审。
- 作者：Doubao（主力开发 AI）
- v1 14:18；v2 15:15（一审七项）；v3 15:40（二审 5 处契约）；**v3.1 15:48（开工前 4 处机械修正，已批准）**
- 适用基线：`denova-src`（Go Hertz + `web`：React19/Vite/TS/zustand/Tailwind v4/react-i18next）
- 关联：`design-previews/2026-09-08-narraverse-world-demo-v3/说明-v3.md`（仅交互参考，范围以 0.5 为准）、`README.md`、`docs/交付/Narraverse2.0交接指南.md`

---

## 0. 结论速览

1. 世界工作区 = 新增**共享菜单模式 `worlds`**（对齐 library），不新增内容模式；不动四模块与 Module3/4。
2. **四个运行入口**：写作 `ide` / 游戏 `interactive` / 叙界 `narraverse`（独立）/ 开放沙盒 Module4。
3. **正式 MVP 服务端真源**：新增 `internal/world`，落**全局** `cfg.DataDir()/worlds/`（跨书、不归 internal/book）；前端走真实 HTTP，**不使用 localStorage 存任何世界或草稿数据（创世草稿纯组件状态）**。
4. **每个世界一个 `world-<id>.json`，不建 index.json**：列表扫描目录即时派生摘要，避免「文件已写、索引失败→世界消失」的双重真源；损坏文件以**显式 warnings/可操作错误**返回，绝不静默跳过。
5. **并发用内容哈希 revision CAS（不用 updatedAt）**：复用 `internal/revisionfile`（`Read`/`ReplaceIfRevision`/`ErrRevisionConflict`）；单世界响应信封 `{world, revision}`，PUT 带 `expected_revision`；`updatedAt` 仅展示。
6. **POST 一次原子创建完整初始世界**：`WorldCreateInput` 含第 3 步所选 bindings/初始角色/主书/主游戏故事，杜绝「先建空世界再 PUT」的半成品。
7. **绑定单一真源**：只在 `World.bindings` 存一份快照，实体只存 `bindingId`；计数即时算、头像按 id 构造 URL、不设虚假 stale。
8. **安全与字段语义**：世界 id 仅服务端生成并按白名单校验后才允许进入文件路径；请求体/数组数量/文本长度全部设上限；**删除 lastVisitedAt**（避免读操作写盘），列表按 updatedAt 倒序。
9. 相对 Demo v3 为**主动范围缩减**（0.5），Phase 1 不是完整「世界上下文与事实记忆层」。

### 0.1 历次修订对照
**v2→v3（二审 5 处，便于核对 diff）**
| 二审意见 | 处理 | 位置 |
|---|---|---|
| ① 创世无法一次落库 | 扩展 `WorldCreateInput`（bindings/初始角色/primaryBookPath/primaryInteractiveStoryId），POST 原子建完整世界 | 4.1、6.2、7.2 |
| ② CAS 不该用 updatedAt | 改用 revisionfile 内容哈希；信封 `{world,revision}`、PUT `{expected_revision,world}`；updatedAt 仅展示 | 4.1、4.3、6.2、10-R7 |
| ③ 不需要 index.json | 去索引，扫描目录即时派生摘要；损坏文件返回 warnings/可操作错误，不静默跳过 | 4.3、6.2、10-R7 |
| ④ 叙界缺回调传递 | ModeRouter 已有 onCloseModule4 等，直接透传 WorldWorkspace；selectInteractiveStory 在 feature 内直接 import，不做 prop drilling | 5.2、7.5、8.4 |
| ⑤ 安全与字段语义 | 服务端生成+校验 id 与路径、请求上限表、草稿纯组件态（去 localStorage）、删 lastVisitedAt | 4.1、4.3、6.4、7.2、12 |

**v1→v2（一审七项）**：四模式补叙界；localStorage→服务端真源；入口进入绑定实例；绑定单一真源；务实最小 API；补全模式接入清单；补全页面状态契约 + 地点/势力/时间线拆分。

### 0.5 相对 Demo v3 的主动范围缩减（先读）
Phase 1 **不是**完整「世界上下文与事实记忆层」。不做：世界事实提案/六类事实、任务与健康中心、沙盒推进/事件候选/影响预测/三权限、平台控制平面抽屉、AI 生成世界、关系图谱/地图（均移 Phase2/3）。做：世界列表/创世/控制台/角色资料/地点·势力·时间线（三独立分区）/四模式入口 + 最小服务端存储。

---

## 1. 背景、目标与非目标

### 1.1 产品定位
让用户感到「这是我的世界」：创造、管理、进入自己的 AI 世界。世界是主体（设定/历史/地点/势力/角色/物品/入口），不是资料后台，也不是新的 World Engine。

### 1.2 四个运行模式（与正式平台一致，不重写）
| 模式 | 现有实现 | 用户身份 | 世界工作区入口行为 |
|---|---|---|---|
| 写作 | 内容模式 `ide` | 作者 | 先切到 `primaryBookPath` 成功再进 ide |
| 游戏 | 内容模式 `interactive` | 玩家 | feature 内直接 `selectInteractiveStory(primaryInteractiveStoryId)` 成功再进 interactive |
| 叙界 Narraverse | 内容模式 `narraverse`（iframe 对话冒险） | 冒险者 | 独立入口：`onCloseModule4()` 后进入 narraverse |
| 开放沙盒 | narraverse iframe 内 Module4 | 观察者/导演/介入角色 | 调 `onOpenModule4()` 打开现有沙盒 |

### 1.3 硬性约束
不重写 Module3/4、不替换互动系统、不改 iframe 与 postMessage v1；不复制/污染/回写总资料库；世界背景共享、剧情不强制同步（事实提案移 Phase3）；不新增平行 Agent/Skill/预设/网关、不读 Key、不增 npm 依赖；现有功能零变化。

### 1.4 非目标（Phase1 不做）
事实库/提案、沙盒推演、AI 生成、地图/关系图谱、世界版本快照、物理删除、多元实例模型、index.json 索引、lastVisitedAt 访问时间、把世界塞进某本书。

---

## 2. 现状代码事实（已核对）

### 2.1 前端模式机制
- `stores/workspace-store.ts`：`WorkspaceMode` L10、`ContentMode` L12（仅 ide/interactive/narraverse 持久化 `nova:content-mode`，persistMode L46-51）、`isWorkspaceMode` L38、`?mode=` 仅覆盖本次启动 L18-27。
- `components/workbench/ModeRouter.tsx`：`MainRouteId` L46、`visibleMainRoute` L498-518、`mountedRoutes` L519-528、懒加载 L41、`<MainRouteLayer>` 挂载；**已持有 `onCloseModule4`（L96/L196）、`onOpenModule4`、`onQuickSwitchBook` 等回调**，可直接透传给新视图，无需 App 再加 props。
- `components/workbench/WorkbenchShell.tsx`：四模式按钮 L512-553（Module4 L544-553）、移动 L708+；`switchNavigationMode` 进 narraverse 时**已自动 `onCloseModule4()`（L243）**；`navigationModelModule` L976-983（共享清单 L977 必加 worlds）；`ActivityItemId` L66、两套默认排序 L87-88；openLibrary 再点返回 L297-305、returnFromBooks L268-279；sharedMenuActive L216/navigationMode L226/modeLabel L225。
- `App.tsx`：共享清单 L109/L324-331/L603-615；`handleQuickWorkspaceSwitch` 返回 Promise<boolean> L388-406；`handleOpenModule4` L616-619；`handleCloseModule4` L620（已在 L790 下传）。

### 2.2 可复用前端能力
- 书籍：`getBooks()`；切书 `onQuickSwitchBook(path): Promise<boolean>`（经 ModeRouter props）。
- 总资料库只读：`listMasterAssets`（摘要）、`fetchMasterAsset`（按需详情）、头像 `GET /api/library/assets/:id/avatar`。
- 游戏：**feature 内直接 `import { selectInteractiveStory } from '@/features/interactive/api'`（api.ts:56，POST `/stories/:id/select`）**，不经过 App props。
- Module3/4：iframe 入站仅 ready/switch-mode/module4-closed（`NarraverseWorkspace.tsx:21-26`），不能携带世界/冒险 id → 不存 module4AdventureId。

### 2.3 后端事实
- 分层：`internal/<领域>` → `internal/app/*_app_service.go` → `internal/api/handlers/handler_*.go` → `routes.go`；`handlers.New(s.app)`。
- 全局目录 `cfg.DataDir()`（`config/config.go:437`，跨书）。
- **内容哈希 CAS：`internal/revisionfile`**——`Revision(bytes)="sha256:..."`（L49）、`Read(ctx,path) Snapshot{Content,Revision,Exists}`（L75）、`Mutate`（L90，锁内读-改-原子替换）、`ReplaceIfRevision(ctx,path,expectedRevision,content,opts)`（L122，空 expected=盲写，冲突返回 `*ConflictError{Expected,Actual}` 并 `Unwrap → ErrRevisionConflict`）、常量 `MissingRevision="missing"`。世界文件直接用它做原子写与乐观锁。
- 端口/origin：`docs/交付/Narraverse2.0交接指南.md:60`（端口顺延、localhost/127.0.0.1 不互通）→ 服务端真源的决定性依据。
- 语义词表（复用）：`character|world|location|faction|rule|item|other`（`internal/book/lore.go:1082`）；总库 `record_kind=character_template|lorebook_template`。

### 2.4 i18n/构建
zh/en 命名空间键全等（`i18n.test.ts`、`check-i18n-keys.mjs`）；`build=tsc && vite build`；中文文件 UTF-8，禁止 PowerShell 重写。

---

## 3. 产品结构

### 3.1 位置与导航
```
WorkbenchShell
├─ 内容四模块（不变）：写作 ide │ 游戏 interactive │ 叙界 narraverse │ 开放沙盒 Module4
├─ 共享菜单：books │ library │ Skills │ Agents │ 自动化 │ 设置
└─ 【新增共享菜单】worlds（左侧活动栏，ide/interactive 两套排序都在）
      └─ WorldWorkspace（内部 useState 状态机，不引路由库）
           list │ create │ console │ character(二级)
```
`?mode=worlds` 深链接但**不写 content-mode**；关闭/再点返回进入前模式（复用 booksReturnMode）。内部视图：`{name:'list'}|{name:'create'}|{name:'console',id}|{name:'character',id,characterId}`。

### 3.2 背景共享、剧情不同步
世界存背景正典 + **一个主书 `primaryBookPath` / 一个主游戏故事 `primaryInteractiveStoryId`**（非多元实例）；模式剧情不自动回写；叙界/沙盒不存实例 id。

---

## 4. 数据模型

### 4.1 TS 契约（与 Go JSON 对齐）
```ts
export interface World {
  id: string                       // 服务端生成；客户端不可指定
  schemaVersion: 1
  name: string
  tagline?: string
  genre?: string
  summary: string
  coverColor?: string
  status: 'active' | 'archived'
  worldSetting?: { rules: string[]; tone?: string }
  bindings: WorldAssetBinding[]    // ★绑定唯一真源
  characters: WorldCharacter[]
  locations: WorldLocation[]
  factions: WorldFaction[]
  timeline: WorldTimelineEntry[]
  primaryBookPath?: string
  primaryInteractiveStoryId?: string
  // 不设 module4AdventureId（协议不支持）；不设 stats（即时算）；不设 lastVisitedAt
  createdAt: string
  updatedAt: string                // 仅展示/排序；并发令牌是信封里的 revision，不在此
}
// 注意：revision 不放在 World 内，而在响应信封 { world, revision }；前端另存 revision 供 PUT

export type BindingRecordKind = 'character_template' | 'lorebook_template'
export type WorldSemanticType = 'character' | 'world' | 'location' | 'faction' | 'rule' | 'item' | 'other'
export type CharacterRole = 'protagonist' | 'major' | 'minor' | 'npc'
export interface WorldAssetBinding {
  bindingId: string                // ★客户端生成（uuid）；服务端只校验「格式 + 世界内唯一 + 被角色/地点/势力引用时的引用完整性」，绝不重建/改写（重建会让实体上的旧 bindingId 悬空）；不合格直接 400
  masterItemId: string
  recordKind: BindingRecordKind
  semanticType: WorldSemanticType
  nameSnapshot: string             // 仅即时渲染，可手动刷新；非真相
  tagsSnapshot: string[]
  boundAt: string
  // 无 bindStatus/stale/sourceRevision/avatarUrl（Phase1 不比对 revision，头像按 id 构造）
}
export interface WorldCharacter {
  id: string; bindingId?: string; displayName: string
  role?: CharacterRole
  factionId?: string; locationId?: string; worldNote?: string
  relationships?: Array<{ targetCharacterId: string; label: string }>
  growthNote?: string; customFields?: Record<string,string>
}
export interface WorldLocation { id: string; bindingId?: string; name: string; description: string; tags?: string[] }
export interface WorldFaction  { id: string; bindingId?: string; name: string; description: string; influence?: number; stability?: number; headquartersLocationId?: string }
export interface WorldTimelineEntry { id: string; order: number; eraLabel?: string; title: string; description: string; category?: 'canon'|'planned' }

export interface WorldSummary { id: string; name: string; tagline?: string; genre?: string; status:'active'|'archived'; characterCount:number; locationCount:number; factionCount:number; timelineCount:number; createdAt:string; updatedAt:string }

// ★创建入参：一次携带第 3 步全部选择，POST 原子建成完整世界
export interface WorldCreateInput {
  name: string                     // 必填
  tagline?: string; genre?: string; summary?: string; coverColor?: string
  worldSetting?: { rules: string[]; tone?: string }
  bindings?: WorldAssetBinding[]   // 选中的总资料库绑定（只含摘要）
  characters?: WorldCharacter[]    // 由绑定/手填得到的初始角色实例（可空）
  locations?: WorldLocation[]; factions?: WorldFaction[]; timeline?: WorldTimelineEntry[] // 通常为空，保留
  primaryBookPath?: string
  primaryInteractiveStoryId?: string
  // 禁止携带 id/createdAt/updatedAt/status/revision（服务端生成；出现 id 直接 400）
}

// 纯函数：getBinding(world,bindingId)、worldStats(world)（数组长度）、masterAvatarURL(masterItemId)
```

### 4.2 来源与可写性
| 数据 | 来源 | 世界存什么 | 回写来源？ |
|---|---|---|---|
| 原始正文 | fetchMasterAsset 按需 | 不存，仅当下渲染 | 否 |
| 名称/标签/头像 | listMasterAssets | 仅 bindings[] 一份 name/tags 快照；头像只存 masterItemId、URL 现构造 | 否 |
| 实体与总库关系 | bindings | 角色/地点/势力只存 bindingId | 否 |
| 世界内容与实例状态 | 用户编辑 | 完整对象（服务端 JSON） | 写世界自身 |
| 主书/主故事 | books / interactive | 仅 primaryBookPath / primaryInteractiveStoryId | 否 |
| 模式剧情 | 四模式 | 不回收（Phase3 提案） | 否 |

快照仅一份故无多处不一致；手动「刷新绑定名称」=重拉摘要后 PUT（带 revision）。

### 4.3 持久化所有权与磁盘形态
- 根目录：**全局 `cfg.DataDir()/worlds/`，跨书**；每个世界一个文件 `world-<id>.json`，**不建 index.json**。
- **列表 = 扫描目录**：列出 `world-*.json` → 逐个 `revisionfile.Read` → 解析 → 内存派生 `WorldSummary`（计数即时算）→ 按 `updatedAt` 倒序。世界规模出现真实性能问题后才评估加索引（YAGNI）。
- **写入用 `revisionfile.Mutate/ReplaceIfRevision`**：锁内读-改-原子替换，杜绝半写入；不另写索引，因此不存在「文件成、索引败」的不一致。
- **损坏文件不静默跳过**：
  - 列表：有效世界正常返回，同时 `warnings` 列出无法解析的文件；目录不存在视为空列表（无 warning）。
  - 单世界详情：文件缺失=404；存在但解析失败=**500 且错误可操作**（区分「不存在」与「已损坏」）。
- **不设 lastVisitedAt**：打开控制台是读操作，不触发写盘；排序用 updatedAt。
- **前端零世界持久化、零 localStorage**：创世向导草稿是纯 React 组件状态，关闭/刷新即弃（与拍板一致，删除 v2 中「localStorage 临时草稿」表述）。

---

## 5. 前端目录规划

### 5.1 新增（隔离 feature）
```
web/src/features/world-workspace/
├─ types.ts                 # 第4节类型 + WorldView + 响应信封类型 {world,revision}/{worlds,warnings}
├─ selectors.ts             # getBinding/worldStats/masterAvatarURL（纯函数单测）
├─ world-api.ts             # HTTP：listWorlds/getWorld/createWorld/updateWorld/archiveWorld；直连 selectInteractiveStory 用于游戏入口
├─ world-factory.ts         # 空世界/新条目构造（纯函数单测）
├─ WorldWorkspace.tsx       # 容器：取数、视图状态机、四模式进入（持有 revision 供 PUT）
├─ pages/{WorldListPage,CreateWorldPage,WorldConsolePage}.tsx
├─ components/{BindingPicker,CharacterProfile,LocationSection,FactionSection,TimelineSection,ModeEntries}.tsx
└─ __tests__/{selectors,world-factory,world-api}.test.ts 与 WorldWorkspace.test.tsx
```
i18n：新增 zh/en `worldWorkspace.ts` 并在两个聚合器注册；双语 `workbench.ts` 加模式/活动栏标签。

### 5.2 修改的既有文件
| 文件 | 改动 |
|---|---|
| `stores/workspace-store.ts` | 类型+守卫加 worlds；不纳入 content-mode 持久化 |
| `components/workbench/ModeRouter.tsx` | lazy 引入、MainRouteId/visibleMainRoute/mountedRoutes/MainRouteLayer；**并把其已有的 `setMode/onQuickSwitchBook/onOpenModule4/onCloseModule4` 透传给 WorldWorkspace**（回调本就到 ModeRouter，App 无需新增 prop） |
| `components/workbench/WorkbenchShell.tsx` | 见 8.4 全清单 |
| `App.tsx` | **仅** L109/L324-331/L603-615 三处共享清单加 worlds；不新增世界相关 props（selectInteractiveStory 由 feature 直连） |
| `i18n/locales/{zh,en}/workbench.ts` | 加 worlds 标签（双语） |

### 5.3 后端新增
| 文件 | 职责 |
|---|---|
| `internal/world/types.go` | 结构体+JSON tag、normalize、**字段校验与上限（6.4）** |
| `internal/world/store.go` | 目录扫描列表（派生摘要+warnings）、Get（区分 404/损坏）、Create（服务端生成 id、原子写一文件）、Update（revisionfile.ReplaceIfRevision CAS）、Archive；严格路径构造 |
| `internal/world/*_test.go` | 扫描派生、损坏 warning、CAS 冲突、原子创建、路径非法拒绝、上限校验、跨书隔离 |
| `internal/app/world_app_service.go` | App 服务，解析 `cfg.DataDir()` |
| `internal/api/handlers/handler_world.go` | HTTP 适配 + 统一错误 envelope（400/404/409/500） |
| `internal/api/routes.go` | 注册 6.2 端点 |

### 5.4 不修改
`app/`、`web/public/narraverse/`、features/narraverse|interactive|library、Module3/4 协议、模型网关/设置、knowledge-base、.denova、design-previews；不在 internal/book 加世界逻辑。

---

## 6. 持久化与 API 契约

### 6.1 原则
持久化所有权在服务端全局 DataDir；编辑动作=创建/读取/整文档替换/归档恢复；整文档 PUT + **内容哈希 revision 乐观锁**；归档恢复同一 archive 端点；**无 DELETE、无 index、无 JSON-patch、无子资源端点**；不承诺未来 UI 零改动。

### 6.2 Phase1 端点（本期实现）
| 方法路径 | 动作 | 请求 | 成功 | 失败 |
|---|---|---|---|---|
| `GET /api/worlds` | 扫描目录派生摘要 | `?status=active\|archived`（可空） | 200 `{worlds: WorldSummary[], warnings: WorldLoadWarning[]}`（按 updatedAt 倒序） | 500 |
| `POST /api/worlds` | **原子创建完整初始世界**（一次写入，不先建空壳） | `WorldCreateInput`（含 bindings/初始角色/主书/主故事） | 201 `{world: World, revision: string}` | 400（校验/超限/携带 id） |
| `GET /api/worlds/:id` | 详情 | — | 200 `{world, revision}` | 404 缺失 / 500 损坏 |
| `PUT /api/worlds/:id` | 整文档替换（CAS） | `{expected_revision, world}` | 200 `{world, revision}`（新 revision） | 400 / 404 / **409 revision 冲突（含 expected/actual）** |
| `POST /api/worlds/:id/archive` | 归档或恢复（撤销，同样走 CAS） | `{archived: boolean, expected_revision: string}` | 200 `{world, revision}`（新 revision） | 400 / 404 / **409 revision 冲突** |

- `WorldLoadWarning = { file: string; id?: string; reason: string }`；前端列表在顶部展示「N 个世界文件无法读取」可操作警示（给文件名与原因，不藏）。
- 前端保存流程：进入详情拿到 `revision` → 编辑/归档 → 写请求带 `expected_revision`（PUT 与 archive 都要）→ 用响应新 revision 覆盖本地；409 提示「已在别处修改，请刷新」，不覆盖。
- 绑定候选/详情复用现有 `/api/library/assets*` 只读端点，不在世界 API 重复。

### 6.3 revisionfile 落法
- 文件路径：`filepath.Join(dataDir,"worlds", "world-"+id+".json")`；读用 `revisionfile.Read`，写用 `ReplaceIfRevision`（创建 expected=`revisionfile.MissingRevision` 或盲写并先确认不存在，避免覆盖已存在 id），冲突 `errors.Is(err, revisionfile.ErrRevisionConflict)` → 409。
- 文件字节即规范化后的 World JSON；`revision = revisionfile.Revision(bytes)`，与磁盘严格对应。

### 6.4 最小安全与字段语义（开工前冻结）
- **世界 id 只由服务端生成**：使用服务端随机 id（小写字母数字，形如 `^[a-z0-9]{12,24}$`）；POST body 出现 `id` 直接 400；任何进入文件路径的 id 必须过该白名单校验，并用 `filepath.Clean` + 基名校验，拒绝分隔符/`..`/绝对路径，文件只能落在 worlds 目录内（禁止路径穿越）。
- **bindingId 由客户端生成、服务端只校验不重建**：bindingId 用客户端 uuid；服务端校验其格式、在 `world.bindings` 内唯一，以及角色/地点/势力引用的 bindingId 必须真实存在（引用完整性）；任一不满足返回 400，**绝不自动重建或改写 bindingId**（否则实体上的旧引用会悬空）。实体 id（character/location/faction/timeline）同理：客户端生成、服务端校验唯一与引用完整性。
- **请求上限（超限 400 并指出字段，不静默截断）**：
  - name 必填去空白 1–100；tagline ≤200；genre ≤50；summary ≤20000；tone ≤200；rules ≤50 条且每条 ≤2000。
  - bindings ≤200；characters/locations/factions/timeline 各 ≤500；单角色 relationships ≤100；customFields ≤50 键，键 ≤50、值 ≤2000。
  - 枚举白名单：status、role、category、semanticType、recordKind；非法即 400。
  - 请求体总大小 ≤1 MiB（沿用/对齐服务端既有 body limit）；嵌套深度受限。
- **草稿纯组件状态**：不写 localStorage（见 4.3）。
- **无 lastVisitedAt**：不做「读时写盘」，列表按 updatedAt 倒序。

---

## 7. 页面规划

> 沿用 Denova 设计系统与 nova-* 变量，不另出视觉：视觉冒险 4/10、动效 3/10（≤300ms、尊重 reduced-motion）、信息密度 7/10；正文 ≥14px；加载/失败/空态均给下一步。

### 7.1 世界列表
卡片：名称/基调/题材/即时统计/更新时间/状态；进控制台；次级「归档」（直接归档 + toast 撤销，**无删除确认**）；分段 全部/活跃/已归档；默认空（fixture 仅单测）；顶部展示后端 warnings（损坏文件可操作警示）；加载/失败/空三态。

### 7.2 创建世界（创世体验；纯组件会话草稿，最后一步一次原子落库）
四步：①种子（名称+基调，AI 补全禁用占位标 Phase2）②题材/规则（可跳）③**可选绑定（BindingPicker 选总库角色/设定 + 选主书/主游戏故事，文案「只引用不复制不改」）** ④预览与「创造世界」→ 成形动效 → **一次 `POST WorldCreateInput`（携带③全部选择）** → 进控制台。
- 未保存离开：弹窗「保留/放弃」；草稿只在组件 state，刷新即失（**不写 localStorage**）。
- 提交失败：保留输入、内联错误、可重试。
- 重复提交：in-flight 禁用 + 守卫，杜绝双建。
- 恢复：失败停留第④步；**成功即得到完整世界（含绑定/角色/主书），不存在先空后补的半成品**。

### 7.3 世界控制台
概览（名/基调/设定/即时统计/最近时间线/四模式入口）、设定（编辑→PUT 带 revision）、角色（列表→CharacterProfile；绑定或新建原创）、**地点 LocationSection / 势力 FactionSection / 历史 TimelineSection 三独立分区**。编辑走「本地暂存→保存 PUT」，409 刷新重试。

### 7.4 角色资料（原件故障不堵实例）
上层「原始资料·只读」：有 bindingId 按需 fetchMasterAsset；**加载失败显示内联错误+重试，但下层世界实例仍可查看/编辑**；无绑定显示「世界原创角色」。下层「世界内状态」可编辑且仅写世界，标注不回写总库。头像 `masterAvatarURL`，无则首字色块。

### 7.5 四模式入口（成功才离开，失败留页）
| 入口 | 契约 |
|---|---|
| 写作 | 有 primaryBookPath：`const ok=await onQuickSwitchBook(path)`，ok 才 `setMode('ide')`，否则 toast 留页；无主书引导去书库选/登记 |
| 游戏 | feature 内 `await selectInteractiveStory(primaryInteractiveStoryId)`（直连 import），成功 `setMode('interactive')`，catch 留页；无主故事引导选择 |
| 叙界（独立） | 调 ModeRouter 透传的 **`onCloseModule4()`** 后 `setMode('narraverse')`（与 WorkbenchShell L243 行为一致）；不依赖实例 id |
| 开放沙盒 | 仅 `onOpenModule4()`；说明 Phase1 不能按世界选冒险（协议不支持），不存 module4AdventureId，按世界进入存档列 Phase3 |

### 7.6 BindingPicker 五态
加载骨架 / 分页（limit/offset 加载更多）/筛选无结果（清空引导）/服务不可用（错误+重试）/正常多选列表（仅摘要，显示 record/语义类型）；不提供批量拉详情。

### 7.7 地点/势力/历史（分别实现）
LocationSection（地点增改、可绑 lorebook）、FactionSection（势力、influence/stability 0-100 静态展示、据点关联）、TimelineSection（按 order、canon/planned、注明模式剧情不自动入史）。物品 item 本期不进导航/页面（类型可留，UI 延后）。

---

## 8. 与现有代码兼容

### 8.1/8.2 Module3/4
不改 iframe/URL/postMessage v1/public-narraverse/app；世界工作区在 React 侧独立；仅复用宿主既有单向回调，不新增 iframe 消息，不解析 Module4 存档，不存不可用冒险 id。

### 8.3 总资料库
只调三类只读 GET；不调写/实例化/删除；不批量拉详情、不把正文写入世界文件；绑定唯一真源 + 实体只存 bindingId。

### 8.4 模式接入完整清单
- [ ] workspace-store：类型+守卫加 worlds；content-mode 集合不变；**测试 `?mode=worlds` 不改写 `nova:content-mode`**。
- [ ] ModeRouter：MainRouteId/visibleMainRoute/mountedRoutes/懒加载层；**向 WorldWorkspace 透传 setMode/onQuickSwitchBook/onOpenModule4/onCloseModule4（均已在 ModeRouter 可得）**；既有分支结果不变。
- [ ] WorkbenchShell：sharedMenuActive L216；**navigationModelModule L977 加 worlds**（测试从 interactive/narraverse 进 worlds 模型上下文分别保持 game/narraverse）；navigationMode L226/modeLabel L225；ActivityItemId L66；**两套默认排序 L87-88 都加 worlds**（补自定义排序 merge 测试）；**openWorlds 已在 worlds 时再点按 returnFromBooks 返回**；**桌面+移动活动栏**均出现可点。
- [ ] App：仅 L109/L324-331/L603-615 共享清单加 worlds，不新增世界 props。
- [ ] 顶栏四模式分段保持四个、不增不减；worlds 只在左侧活动栏。

### 8.5 其它系统
Agent/Skills/自动化/预设/设置零耦合，不读 Key。

### 8.6 i18n/构建/依赖
zh/en 对齐过 check:i18n；不增依赖；独立懒 chunk；不碰 PWA/同步脚本。

---

## 9. 开发阶段

**Phase 0 准备**：本计划 diff 核对通过 + 用户拍板；冻结 4.1/6 契约；基线 `go test ./...`、tsc、vitest 留绿。

**Phase 1 MVP（含最小后端）**
1. `internal/world`：types+校验上限、目录扫描 store（warnings）、revisionfile CAS、服务端 id 与路径安全 + 单测。
2. `internal/app` 服务 + handler_world + routes；定向 `go test`；5 端点 smoke（含 409/400/损坏 warning）。
3. 前端 types/selectors/world-factory/world-api（信封 revision、错误映射）+ 单测。
4. 模式接入（8.4 全清单）挂占位页：进入/返回/深链接/模型上下文/双端活动栏。
5. 列表（warnings、归档+撤销、三态）。
6. 创世四步（一次原子 POST + 7.2 状态）。
7. 控制台框架 + 设定 PUT/CAS。
8. 角色 + CharacterProfile + BindingPicker 五态。
9. Location/Faction/Timeline 三独立分区。
10. 四模式入口（7.5 成败契约）。
11. zh/en、测试、`tsc && vite build`、check:i18n、vitest、`go test`、Edge 无头截图；更新协作日志。

**DoD**：功能可用且**服务端持久化（换端口/重启不丢）**；POST 一次成完整世界；PUT revision CAS 409 可复现；损坏文件显式告警不消失；绑定只读单一真源不回写（有断言）；四模式按 7.5 进入或正确留页；路径/上限校验拒绝非法输入（有测试）；Module3/4 及其它模式零回归；go test/tsc/build/vitest/i18n 全过；无新增依赖；日志倒序登记。

**Phase 2**：绑定 revision 差异检测/一键刷新、世界与书/故事双向校验、AI 补全（复用网关）、必要时导入导出与索引（仅在性能需要时）。
**Phase 3**：事实提案→入正典、任务健康、**扩展 iframe 协议以支持按世界选 Module4 冒险**、沙盒三权限/影响预测、关系图谱/地图、世界版本快照。

---

## 10. 风险

| # | 风险 | 等级 | 缓解 / 验证 |
|---|---|---|---|
| R1 | 端口顺延/不同 origin 丢数据 | 高 | 服务端全局 DataDir 真源；前端不持久化；换端口/重启回归 |
| R2 | 变相复制总资料库 | 高 | 三类只读 GET、不批量拉详情、世界文件无正文；断言 |
| R3 | 污染/回写总库 | 高 | 只 import 只读 API；双层 UI 隔离；review 排查写调用 |
| R4 | 模式联合类型外溢（含 navigationModelModule） | 高 | 8.4 清单 + 模型上下文/返回/双端测试 + 等价性核对 |
| R5 | 绑定多快照不一致 | 中 | 顶层唯一 bindings、实体存 bindingId、计数即时、头像构造；仅手动刷新 |
| R6 | 入口进不了绑定实例 | 中-高 | 写作 await 切书、游戏 await select、失败留页；叙界 onCloseModule4 后进入；沙盒不存不可用 id |
| R7 | 并发覆盖 / 半写入 / 索引不一致 / 损坏即“消失” | 中 | **revisionfile 内容哈希 CAS（409）+ 原子替换；不建 index（扫描派生，消除双真源）；损坏返回 warnings/500 可操作**；专项单测 |
| R8 | 世界放错位置（随书删/跨书不可见） | 中 | 全局 DataDir/worlds、独立 internal/world；删书不影响、跨书可见测试 |
| R9 | **路径穿越 / 超大与非法请求** | 中-高 | 服务端生成 id + 白名单 + filepath.Clean 基名校验；6.4 上限与枚举校验，400；fuzz/越界用例 |
| R10 | 半成品世界（先建后补失败） | 中 | POST 一次原子建完整世界；服务端事务内构造后单次写文件 |
| R11 | i18n 不对齐 | 中 | 成对新增、过 check:i18n |
| R12 | 范围蔓延 | 中 | 0.5 守门，超界进 Phase2/3 |
| R13 | Module3/4 回归 | 中 | 不改 iframe/协议；专项回归四模式与沙盒开合 |
| R14 | 中文编码 | 低 | 只用编辑工具；git diff 查乱码 |
| R15 | 构建/进程 | 低 | 先自验；完整重建经用户确认，不擅杀进程 |

---

## 11. 验证与验收
- 后端 `go test ./internal/world ./internal/app ./internal/api`：扫描派生、损坏 warning、404 vs 500、CAS 409、原子创建、路径穿越拒绝、字段上限、归档恢复、跨书隔离。
- 前端 tsc、vitest（新增 + ModeRouter/WorkbenchShell/i18n 不回归）、check:i18n、`vite build`。
- 模式专项：从 ide/interactive/narraverse 进 worlds 的模型上下文与返回；`?mode=worlds` 不改 content-mode；桌面+移动；再点返回。
- 入口专项：切书失败留页、select 失败留页、叙界进入且 Module4 关闭、沙盒仅打开。
- 持久化专项：创建（含绑定/主书一次成型）、编辑 409、归档撤销后**换端口/重启仍在**；网络面板：世界走 `/api/worlds`，对总库仅 GET，无 Key/模型请求；构造超大/非法 body 与路径穿越被 400 拒绝。
- 损坏注入：手动制造一个坏 world 文件，列表出现可操作 warning 且其余世界正常。
- 无头截图各页 + 回归五既有入口；`git status` 对照 5.1/5.3 新增与 5.2 修改清单，无计划外变更。

---

## 12. 已拍板决策与遗留
**已拍板**
1. worlds 共享菜单模式。2. 创世草稿**纯组件状态、不用 localStorage**，最后一步原子 POST。3. 字段 `primaryBookPath`/`primaryInteractiveStoryId`（一主书一主故事），不设 module4AdventureId。4. 手建条目升格总库延后。5. 仅归档+撤销，无物理删除。6. 新增 `internal/world`，全局 `cfg.DataDir()/worlds`，不归 internal/book。7. 事实提案/任务健康移 Phase3，首页声明范围缩减。8. 沿用 Denova 设计系统（视觉冒险 4 / 动效 3 / 信息密度 7）。9. **并发用 revisionfile 内容哈希，updatedAt 仅展示。10. 不建 index，扫描派生；损坏显式告警。11. 服务端生成并校验 id；请求字段/数量/体积设上限。12. 删除 lastVisitedAt，列表按 updatedAt 倒序。**

**遗留（不阻塞，编码期定，给默认）**
- worlds 在两套默认活动栏的精确位置（默认「书库」前）。
- 色牌取值集合（nova 变量低饱和组）。
- 1 MiB body 上限若与服务端全局 limit 不一致，以更严格者为准。

---

## 附录 A：代码锚点
- revisionfile：`internal/revisionfile/revisionfile.go` L17(MissingRevision)/L21(ErrRevisionConflict)/L49(Revision)/L75(Read)/L90(Mutate)/L122(ReplaceIfRevision)
- 四模式：`WorkbenchShell.tsx` L512-553（Module4 L544-553、进叙界自动关 Module4 L243）；模型上下文 navigationModelModule L976-983；活动栏 L66/L87-88/L297-305
- 模式类型：`workspace-store.ts` L10/L12/L18-27/L38-51；路由 `ModeRouter.tsx` L41/L46/L96/L196/L498-528/L700-709/L752-756
- App：`App.tsx` L109/L324-331/L388-406/L603-620/L790
- 游戏选择 `features/interactive/api.ts:56`；总库 `lib/api-client/master-library.ts`；书籍 `lib/api-client/books.ts`
- 全局目录 `config/config.go:437`；路由 `internal/api/routes.go`；handler 装配 `internal/api/handlers/handlers.go`
- 语义词表 `internal/book/lore.go:1082`；四模块 `README.md:3-8`；端口/origin `docs/交付/Narraverse2.0交接指南.md:60`
- i18n：`i18n/locales/zh-CN.ts`、`en-US.ts`、`i18n/i18n.test.ts`、`web/scripts/check-i18n-keys.mjs`
