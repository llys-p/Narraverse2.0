# World Workspace Phase 2A 实施方案 v2：真实资料库绑定健康与刷新

- 状态：**v2，待 Codex 快速核对（本轮只改方案，不编码）**
- 作者：Doubao · 2026-09-09 08:39
- 基线：Phase 1 已通过节点审查并完成 F-01～F-06；本方案**完整保留 F-01～F-06 及其全部测试**，不重构、不替换 Module3/Module4，不新增后端路由、不新增 npm 依赖、不做轮询/后台任务/批量扫描。
- 关联：`docs/plans/WORLD_WORKSPACE_IMPLEMENTATION_PLAN.md`（v3.1）。

## v1 → v2 修订对照（回应 Codex 三审 6 点，仅方案改动）
1. **明确“重新加载”按钮**：v1 写“沿用现有重载”，但 `WorldConsolePage`/`CharacterProfile` 的 conflict 只有文案、无操作。v2 新增显式“重新加载”按钮（两处），点击先 `confirm` 提示将放弃本地未保存内容，确认后重新 `getWorld`，成功更新 world/revision、清除 conflict（控制台同时清 dirty），取消则不动作；补测试。
2. **检查与刷新分离（最小实现）**：控制台角色列表**不增加任何健康检查/刷新请求或控件**；仅在打开 `CharacterProfile` 时复用其**现有** `fetchMasterAsset` 完成一次“检查”（只读，**绝不修改本地 world/draft**）；档案页展示健康状态；只有用户明确点“刷新资料摘要”才重新读取并把三字段写进本地 world。
3. **取消 useBindingHealth hook 与 AbortController/signal 承诺**：`fetchMasterAsset` 不接收 signal；唯一消费者是 CharacterProfile，故**不新建 hook**，直接在该组件内用现有的 `cancelled` 布尔 + 请求序号（request-sequence）防止卸载后/竞态写状态。
4. **CharacterProfile 无 dirty 概念**：删除 v1“刷新后置 dirty”及对应测试。刷新只更新该组件既有的本地 `world` 状态，持久化仍由其**既有“保存”按钮**经 PUT CAS 完成；`WorldConsolePage` 的 dirty 仅服务它自己的编辑，与绑定刷新无关，维持不变。
5. **失效主书/故事保留禁用项**：select 中当前值若已不在列表，前置一个 `disabled` 的“已失效：原路径/ID”选项，避免看起来像未选择；只有用户主动另选才替换旧值。
6. **一致性修正**：新增前端文件由 4 改为 **3**（删除 hook）；`BindingHealthState` 只在 `types.ts` 定义一次、其余位置 import；统一状态表述（四个**结果态** + 遗留 `unchecked` + 瞬时 `checking`，见第 3 节）；`toBinding` 写入 `masterRevision` 列为**必测**用例（导出该纯函数并断言），不再写“必要时”。

---

## 0. 开工前代码核对结论（实读，方案依据）

1. **master_revision 语义**：`internal/book/master_library.go:119` 的 `MasterItem.Revision`，写入时由 `masterItemRevision` 重算（`:1024/:1048`），形如 `sha256:<hex>` 的内容哈希；内容不变哈希不变（`:1031-1033`）。是否有更新用**字符串等值比较**即可。
2. **前端已可取**：`MasterAssetSummary.master_revision`（`web/src/lib/api-client/master-library.ts:57`）同时存在于 `listMasterAssets` 与 `fetchMasterAsset().summary`；绑定选择器的 `asset` 已带值，记录版本零额外请求。
3. **档案页已有按需读取**：`CharacterProfile.tsx:50-58` 已对当前角色的那一个绑定调用一次 `fetchMasterAsset`，失败置 `sourceError` 且不阻断世界实例编辑。v2 直接复用这次请求做“检查”，不新增读取通道。
4. **有效性零额外请求**：`WorldConsolePage.tsx:68-71` 挂载时一次性拉取 `getBooks()`（`BookRecord{name,path}`，`api-client/types.ts:301`）与 `getInteractiveStories().stories[{id,title}]`。
5. **错误带状态码**：`APIError.status` 已用于区分 404（`WorldConsolePage.tsx:63`、`CharacterProfile.tsx:76`）。
6. **绑定唯一真源**：快照只在 `World.bindings`（`internal/world/types.go:68-76`、前端 `types.ts:20-28`），角色仅持 `bindingId`。
7. **唯一写路径**：`updateWorld(id, expectedRevision, world)` = PUT + CAS；两页目前在 409 时只 `setConflict(true)` 显示文案，**没有重载按钮**（v2 补）。

---

## 1. 范围

### 本轮做
绑定记录 `masterRevision`；角色档案内的绑定健康检查与手动刷新摘要；冲突时显式重新加载；头像 fallback；主书/主故事有效性显示（含失效禁用项）与重选。

### 本轮明确不做
控制台角色列表健康检查/刷新、地点/势力绑定化、Module4 冒险绑定、自动同步/后台轮询/批量扫描、AI 补全、导入导出、index.json/新索引、Module3/Module4 重构、总库/书籍/故事结构迁移或反向写 worldId、AbortController 改造既有请求。

---

## 2. 字段与迁移兼容（加可选字段，不升 schema 版本）

### 2.1 后端（3 文件，小改；handler/store/路由零改动）
- `internal/world/types.go`：`AssetBinding` 增加 `MasterRevision string \`json:"masterRevision,omitempty"\``。omitempty 保证旧文件缺字段反序列化为 `""`，不报错、不判损坏。
- `internal/world/validate.go`：新增 `maxMasterRevision = 100`，绑定循环只做**长度上限**校验，**空串合法**；`validateStoredWorld` 严格度不提升——缺 `masterRevision` 不算结构损坏（守住 F-05 边界）。
- `internal/world/store_test.go`：补兼容/上限/往返用例（第 7 节）。
- `SchemaVersion` 维持 1；不迁移、不重写旧文件；空值 PUT 时仍省略。新字段随既有 World PUT body 透传，继续受 F-01/F-02/F-05 保护。

### 2.2 前端
- `types.ts`：`WorldAssetBinding` 增加 `masterRevision?: string`。
- `BindingPicker.toBinding`（当前 `components/BindingPicker.tsx:26-40`）补 `masterRevision: asset.master_revision ?? ''`，并**导出**该纯函数以便单测；创世页与控制台都经 picker `onBind` 拿到成品绑定，一处覆盖两条路径。

### 2.3 兼容矩阵
| 来源 | masterRevision | 界面 | 判损坏 |
|---|---|---|---|
| 旧世界（无此字段） | `""` | 尚未检查，可在档案页检查/刷新 | 否 |
| v2 新建绑定 | 绑定时总库哈希 | 档案页检查后显示结果态 | 否 |
| 超长异常值 | — | 400 长度校验 | 仅长度失败 |

---

## 3. 健康状态：一个类型、四个结果态 + 两个辅助态

`BindingHealthState` **只在 `types.ts` 定义一次**，`binding-health.ts` 与组件均 import，不重复声明：

```ts
// types.ts（唯一定义处）
export type BindingHealthState =
  | 'unchecked'    // 遗留：binding.masterRevision 为空，尚无基线
  | 'checking'     // 瞬时：本次检查请求进行中
  | 'latest'       // 结果态：已是最新
  | 'stale'        // 结果态：原件有更新
  | 'missing'      // 结果态：原件已不存在（HTTP 404）
  | 'unavailable'  // 结果态：暂时无法检查（网络/5xx/当前哈希缺失）
```

- **四个结果态**对应用户需求“最新 / 有更新 / 不存在 / 无法检查”；`unchecked` 是旧数据遗留基线，`checking` 是瞬时加载态。全文统一此表述，不再出现“四态/六态”混用。
- 判定原则：存储版本为空时一律 `unchecked`，不臆断最新或过期；当前 `summary.master_revision` 为空（异常）归 `unavailable` 而非 `stale`，杜绝假阳性。

### 3.1 纯函数（新增 `binding-health.ts`，可单测、无 DOM）
- `classifyBindingHealth(binding, outcome)`：
  - `outcome: {phase:'idle'} | {phase:'loading'} | {phase:'error'; status?:number} | {phase:'ok'; currentRevision?:string}`
  - 规则：存储 `masterRevision` 空 → `unchecked`（除非正在 loading 则 `checking`）；loading→`checking`；error 且 status===404→`missing`；其它 error→`unavailable`；ok 且 currentRevision 空→`unavailable`；ok 且与存储相等→`latest`；不等→`stale`。
- `applyRefreshedBinding(world, bindingId, next:{name,tags,masterRevision})`：返回**新 World**，仅替换目标绑定的 `nameSnapshot/tagsSnapshot/masterRevision`；`characters/locations/factions/timeline` 与其余绑定**引用不变**（单测锁死刷新不碰角色实例）；未知 bindingId 原样返回。
- `classifyTargetValidity(selected, present, loadState)`：见第 5 节。

### 3.2 检查时机（无扇出、无轮询、无 AbortController）
- **世界加载、控制台角色列表：零健康请求**，列表也不渲染健康/刷新控件。
- 仅 `CharacterProfile` 打开时，复用其**现有** `fetchMasterAsset` useEffect 做一次检查；用现有 `cancelled` 布尔 + 自增请求序号防止卸载后/竞态 setState（与 `BindingPicker` 的 `requestSeq` 同模式），**不引入 AbortController、不传 signal**。
- **检查只读**：无论结果如何都不调用任何修改本地 world 的函数。

---

## 4. 角色档案：检查（只读）与刷新（显式）分离

全部集中在 `components/CharacterProfile.tsx`（不新建 hook）：

### 4.1 检查（打开即做，只读）
- 复用现有 `fetchMasterAsset(binding.masterItemId)`：成功→保存 `{currentRevision: detail.summary.master_revision}`；404→记录 error.status；其它错误→通用错误。用 `classifyBindingHealth` 得状态，经 `BindingHealthBadge` 展示。检查过程**不改 world**。
- 现有右侧“原件”只读面板保持不变。

### 4.2 刷新资料摘要（仅按钮触发）
- “刷新资料摘要”按钮：再次 `fetchMasterAsset`（带请求序号）。
  - 404 → `missing`，**不删绑定/角色、不改本地 world、不发 PUT**，提示“原件不存在，已保留世界内资料”，可重试。
  - 其它错误 → `unavailable`，不改 world。
  - 成功 → `applyRefreshedBinding` 只把三字段写入组件**本地 world 状态**（`setWorld`）；**不使用 dirty**（本组件本就没有 dirty）；随后由页面**既有“保存”按钮**经 `updateWorld` PUT + `expected_revision` 落库。健康态转 `latest`。
- 明确**不改** `WorldCharacter.displayName/worldNote/growthNote/role/factionId/locationId/relationships/customFields`，不复制正文。
- 保存 409：见 4.3 的显式重新加载。

### 4.3 冲突时显式“重新加载”（新增，两处一致）
- `CharacterProfile` 与 `WorldConsolePage` 在 conflict 横幅内新增“重新加载”按钮（不只有文案）。
- 行为：点击先 `window.confirm`（i18n 提示“将放弃尚未保存的修改，是否继续”）；取消→不动作；确认→调用各自既有 `load()` 重新 `getWorld`，成功后用服务器数据覆盖本地 world/draft、更新 `revision`、`setConflict(false)`；控制台额外 `setDirty(false)`。
- 加载失败保留错误态与重试，不吞异常。

---

## 5. 主书 / 游戏故事有效性（控制台概览，零额外请求）

- 把 `WorldConsolePage.tsx:69-70`“失败即空数组”细化为 `booksLoadState/storiesLoadState: 'loading'|'ok'|'failed'`，区分“真空”与“请求失败”。
- `classifyTargetValidity(selected, present:boolean, loadState)`：
  - 未选→`none`；loading→`checking`；failed→`unavailable`（暂时无法检查，**不误判失效**）；ok 且命中→`enterable`；ok 且不命中→`invalid`。
- 两个 select 旁加状态点/文案：可进入 / 已失效 / 暂时无法检查 / 未选择。
- **失效禁用项（v2 新增要求）**：当 `invalid` 时，在 select 顶部保留一个 `<option disabled value={selected}>` 显示 `已失效：{selected}`（路径/ID 过长截断），使当前值仍可见、界面不呈现“未选择”；下拉可选项仍是当前 books/stories，用户主动另选后才经 `mutate` 替换 draft 中的旧值，保存走既有 CAS。
- 只读校验：不改书籍/故事、不回写 worldId、不建第二真源；`ModeEntries` 进入逻辑不变。

---

## 6. 头像 fallback（只复用）

- 新增展示组件 `components/BindingAvatar.tsx`：`<img src={masterAvatarURL(id)}>`，`onError` 回退现有 `UserRound` 图标；用于 BindingPicker 列表、控制台角色卡、CharacterProfile 头部。PNG 有头像即显示，非 PNG/无头像/失败回退图标；不复制文件、不建世界头像系统。

---

## 7. 精确改动文件清单

### 后端（3，小改）
1. `internal/world/types.go`：`AssetBinding.MasterRevision`（omitempty）。
2. `internal/world/validate.go`：`maxMasterRevision` 长度校验，空串允许，不提升 stored 校验严格度。
3. `internal/world/store_test.go`：兼容/上限/往返用例。

### 前端新增（**3**）
4. `features/world-workspace/binding-health.ts`：三个纯函数。
5. `features/world-workspace/components/BindingAvatar.tsx`：头像 + onError fallback。
6. `features/world-workspace/components/BindingHealthBadge.tsx`：状态→颜色/文案。

> 不新增 `useBindingHealth.ts`（唯一消费者为 CharacterProfile，逻辑内联）。

### 前端修改（**6**）
7. `features/world-workspace/types.ts`：`WorldAssetBinding.masterRevision?`；**唯一定义** `BindingHealthState`。
8. `features/world-workspace/components/BindingPicker.tsx`：**导出** `toBinding` 并写入 `masterRevision`；列表头像换 `BindingAvatar`。
9. `features/world-workspace/components/CharacterProfile.tsx`：内联检查（复用现有 fetch + cancelled/序号，只读不改 world）、健康徽章、显式“刷新资料摘要”（成功才用 applyRefreshedBinding 更新本地 world，无 dirty）、冲突区“重新加载”按钮（confirm→load→清 conflict）；头像换 `BindingAvatar`。
10. `features/world-workspace/pages/WorldConsolePage.tsx`：books/stories 增加 loadState 与有效性展示 + **失效禁用 option**；冲突区“重新加载”按钮（confirm→load→更新 revision/清 conflict/dirty）；角色卡头像换 `BindingAvatar`；**角色列表不加健康/刷新控件、不发请求**。
11. `i18n/locales/zh-CN/worldWorkspace.ts`、`i18n/locales/en-US/worldWorkspace.ts`：同步等数量新键（四个结果态+尚未检查/检查中、刷新、重新加载与放弃确认、有效性四态、失效选项前缀）。

### 前端测试
12. 新增 `features/world-workspace/__tests__/binding-health.test.ts`：classify/apply/validity 纯函数矩阵。
13. `BindingPicker` 的 `toBinding` **必测**：导出后单测断言其把 `asset.master_revision` 写入 `binding.masterRevision`（含缺省回退 `''`）。
14. CharacterProfile / WorldConsolePage 的行为测试见第 8 节；既有 `world-factory/world-api/selectors` 测试保持通过。

> 不改：`internal/api/**`、`internal/app/world_app_service.go`、`internal/revisionfile/**`、Module3/Module4、总库/书籍/互动故事结构、workspace-store/ModeRouter/WorkbenchShell/App。

---

## 8. 测试矩阵

### 后端 Go（叠加，不删 F-01～F-06 用例）
- [ ] 旧世界绑定无 masterRevision：Get/List 正常、无 warning、不损坏（核心兼容）。
- [ ] 带 masterRevision 新建→读取往返保留。
- [ ] masterRevision 超 100 → ValidationError（400 映射不变）；空串合法可 CAS 保存。
- [ ] 回归 F-01/F-04/F-05 既有断言仍通过。

### 纯函数 binding-health
- [ ] classify：空存储→unchecked；loading→checking；非空相等→latest；非空不等→stale；404→missing；网络/5xx→unavailable；当前哈希空→unavailable。
- [ ] applyRefreshedBinding：仅目标绑定三字段变化；characters 等集合引用不变；未知 id 原样返回。
- [ ] classifyTargetValidity：none/loading/failed→unavailable/ok 命中→enterable/ok 缺失→invalid。

### 组件/集成
- [ ] **toBinding 必测**：记录 master_revision，缺省回退空串。
- [ ] CharacterProfile 打开即“检查”：渲染对应结果态；**检查过程不修改 world**（spy 断言不产生本地变更、不发 PUT）。
- [ ] 显式点“刷新资料摘要”成功：仅绑定三字段更新、角色 displayName/worldNote/growthNote 不变、徽章转 latest；不涉及 dirty。
- [ ] 刷新遇 404：显示 missing，绑定与角色仍在、不发 PUT；其它错误显示 unavailable。
- [ ] **重新加载**：两页 conflict 时出现按钮；确认后重新 getWorld、覆盖本地、更新 revision、清除 conflict（控制台清 dirty）；点取消不请求、状态不变。
- [ ] 控制台：加载世界与渲染角色列表时**零** `/api/library/assets/:id` 明细请求，且角色行无健康/刷新控件。
- [ ] 主书/故事：失效时 select 内存在 disabled 的“已失效：原值”且仍选中它；主动重选才替换；列表加载失败显示“暂时无法检查”。
- [ ] BindingAvatar：头像出错回退图标，不裂图。

### 全局门禁
`go test ./internal/world ./internal/api/handlers -count=1` + 作用域 vet；`tsc --noEmit`；`check-i18n-keys` zh/en 全等；定向 vitest（world-workspace + ModeRouter/WorkbenchShell/workspace-store）全过；`vite build` 成功（仅既有大 chunk 提示）；Edge headless 对档案健康/刷新、概览有效性做一次真实渲染回归，确认四模式与现有模块零影响。

---

## 9. 风险与对策
| 风险 | 对策 |
|---|---|
| 旧世界误判过期/损坏 | 空 masterRevision→unchecked；后端不设必填、不升 stored 严格度；兼容用例锁死 |
| 请求风暴 | 世界加载与控制台列表零请求；仅档案打开检查一个；无批量/轮询；测试断言无扇出 |
| 检查误改数据 | 检查只读，纯渲染；单测断言检查不产生 world 变更 |
| 刷新覆盖角色世界内数据 | 只改绑定三字段，applyRefreshedBinding 纯函数+单测保证角色引用不变 |
| 409 无出路 | 显式重新加载按钮 + 放弃确认，成功后以服务器为准 |
| 404 级联删除 | 只标 missing，绝不自动删绑定/角色 |
| 失效目标看起来像未选择 | select 保留 disabled“已失效：原值”，主动重选才替换 |
| 把加载失败当失效 | books/stories 区分 loadState，failed→unavailable |
| 范围蔓延 | 第 1 节不做清单；不改模式接入与 Module3/4，不新增 hook/依赖/路由 |

---

## 10. 提交纪律
- 只暂存第 7 节精确文件，**不使用 `git add .`**；不提交 `shot-*.png`、`web/dist-verify-*`、`web/dist`、`.obsidian`、`docs/` 下既有 Demo/原型/zip。
- 可分两提交：①后端可选字段+测试；②前端健康/刷新/重载/有效性+i18n+测试。信息注明 “Phase 2A v2: binding health & refresh (additive, preserves F-01~F-06)”。

## 11. 批准后实施顺序
1) 后端可选字段+校验+测试（go test/vet）→ 2) binding-health 纯函数+单测 → 3) BindingAvatar/Badge、导出 toBinding+测试 → 4) CharacterProfile 检查/刷新/重载 → 5) Console 有效性/失效项/重载/头像 + i18n → 6) tsc/i18n/定向 vitest/build → 7) 起服务定向验收（旧世界兼容、无扇出、检查只读、404 保留、409 重载、失效禁用项）→ 8) 更新协作日志并交 Codex 节点审查。
