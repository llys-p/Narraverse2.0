# World Workspace Phase 2A.1 独立代码复审（豆包主审）

- 复审时间：2026-09-09 19:20（Asia/Shanghai）
- 复审基线：GitHub main HEAD `8623b64 fix(world-workspace): close Phase 2A acceptance gaps`（在 `6a3f442` Phase 2A 之上）
- 复审方式：纯静态代码阅读 + 链路分析 + 基线测试复跑；**未修改任何生产代码**。
- 基线复跑结果（当前 HEAD 本身是绿的）：
  - 前端 `vitest run src/features/world-workspace`：10 文件 **56 测试通过**
  - 后端 `go test ./internal/world ./internal/api/handlers -count=1`：**通过**
- 范围纪律：本轮只做复审，不进入 Phase 2B，不展开 2B 方案设计。

---

# 主线状态

**结论：Phase 2A 的核心契约（绑定健康/刷新、CAS、错误脱敏、F-01～F-06、级联删除纯函数）成立，代码质量整体良好；但不建议直接把 Phase 2A “正式关闭并推进 2B”。**

存在 **2 个主线级正确性问题（M1、M2，均为 P1）**，都属于“用户取消操作但全局副作用已经发生 / 普通操作静默丢失用户数据”这一类，且都能用最小局部改动修复、**不需要 Codex 核心介入**。建议：豆包按本报告做一次小版本 2A.2 修复并补测试 → Codex 只做一次快速节点复审 → 再关闭 2A、进入 2B。

F-01～F-06、revisionfile 内容哈希 CAS、`{world,revision}` 信封、世界文件语义校验与路径脱敏、绑定单一真源、健康六态优先级等冻结契约，本次复审**未发现回退**。

---

# 主线问题

## M1（P1）：进入运行模式缺少“统一 preflight”，副作用先于离开确认，且存在双重确认

- 严重度：**P1**
- 状态：**CONFIRMED**
- CODEX_NEEDED：**NO**（仅 WorldConsolePage / ModeEntries 两个局部组件的编排顺序问题，不改共享契约、不改 store、不改后端）

### 根因
控制台把“未保存保护”拆成了多个彼此独立的 guard（`guardedSetMode` / `guardedQuickSwitchBook` / `guardedOpenModule4` / `guardedCloseModule4`），而 `ModeEntries` 内部又把“产生副作用”和“真正切走”分成了多步，且每一步各自触发一次 guard。一次用户点击没有单一的“先确认、确认后才允许任何副作用”的 preflight，`dirty` 在两步之间也不会被清掉。

### 证据（按四种模式）
1. **写作模式（双重确认 + 第二次取消后书已被切走）**
   - `ModeEntries.enterWriting`（ModeEntries.tsx:24-32）：先 `await onQuickSwitchBook(path)`，成功后才 `onSetMode('ide')`。
   - 控制台传入的是 `guardedQuickSwitchBook`（WorldConsolePage.tsx:150-153）：dirty 时弹**第 1 次**确认；确认后调用 App 层 `handleQuickWorkspaceSwitch`（App.tsx:388-406），这里会真正 `switchWorkspace`（服务端切书）+ `setWorkspace` + `refreshAll`。
   - 随后 `onSetMode('ide')` 走 `guardedSetMode`（WorldConsolePage.tsx:149 → guardLeave:113-116），此时 `dirty` 仍为 true，弹**第 2 次**确认。
   - 若用户第 2 次点“取消”：**当前书已经被切换（全局状态 + 服务端），但界面仍停在世界工作区**，世界草稿与“当前书”错位。
2. **游戏模式（副作用先于唯一一次确认；且 selectInteractiveStory 是服务端 POST）**
   - `ModeEntries.enterGame`（ModeEntries.tsx:34-44）：**先** `await selectInteractiveStory(id)`，**再** `onSetMode('interactive')`。
   - `selectInteractiveStory` 是 `POST /api/interactive/stories/:id/select`（features/interactive/api.ts），是**真实服务端副作用**，不是本地 store。
   - 唯一的 dirty 确认在 `guardedSetMode` 里，发生在 POST **之后**。用户最后取消离开时，服务端“当前互动故事”已被切换，无法回退。
3. **叙界 Narraverse（双重确认）**
   - `enterNarraverse`（ModeEntries.tsx:46-50）先 `onCloseModule4?.()`（= `guardedCloseModule4`，确认 #1，关闭 Module4 叠层这一副作用），再 `onSetMode('narraverse')`（= `guardedSetMode`，确认 #2）。两次确认；#2 取消时 Module4 已被关闭。
4. **开放沙盒**：`enterSandbox` → `guardedOpenModule4` 单次确认，App.handleOpenModule4 内同时开 Module4 并切到 narraverse，顺序正确，**无问题**。

### 附带的次生 bug（同根因，建议一并修）
- **卡片 busy 态永久卡死（P2，见分支问题 B2）**：`enterWriting/enterGame` 成功切走时 `return` 前没有 `setPending(null)`；而 worlds 路由层是 `hidden` 保活、不是卸载（ModeRouter.tsx:522、760-770），返回世界工作区后“写作/游戏”卡片会一直转圈、永久 disabled。
- **取消被误报为失败（P3）**：`guardedQuickSwitchBook` 因用户取消返回 false 时，`enterWriting` 弹的是 `modes.switchBookFailed`（“切换书籍失败”），实际是用户主动取消，文案误导。

### 建议下一步（最小修法，豆包可做）
- 在 `ModeEntries` 每个 enter* 的**最顶部做一次且仅一次** preflight（由控制台传入一个 `confirmLeave(): boolean`，内部判断 dirty+confirm），确认通过后再按“先副作用、副作用成功后切走”的顺序执行，且**后续步骤不再各自弹确认**：
  - 写作：`confirmLeave()` → quickSwitchBook → setMode（quickSwitch 失败才报失败、留在本页）。
  - 游戏：`confirmLeave()` → selectInteractiveStory → setMode（任一步失败留在本页）。
  - 叙界：`confirmLeave()` 一次 → closeModule4 + setMode。
- 控制台改为把**未加 guard 的原始** `onSetMode/onQuickSwitchBook/onOpenModule4/onCloseModule4` 传给 ModeEntries，只暴露一个统一 `confirmLeave`，消除双重确认。
- 用 `finally` 或在切走后复位 `pending`（即使组件保活也不卡 busy）。
- 补组件测试：dirty 下写作只确认一次；第二次不再弹框；游戏确认取消时**不调用** selectInteractiveStory；叙界只确认一次；成功进入后返回不卡 busy。

---

## M2（P1）：pruneOrphanBindings 会误删“世界级/自由绑定”，且该数据今天就能被创建

- 严重度：**P1**
- 状态：**CONFIRMED**（比“纯 2B 前瞻风险”更强：**当前版本已可触发**）
- CODEX_NEEDED：**NO**（局部纯函数保守化即可）；但其中“世界级 binding 的完整 ownership 模型”属于 2B 设计决策，**那时**需要 Codex 拍板（见后续债务 D-2）。

### 根因
`world-ops.referencedBindingIds`（world-ops.ts:7-13）只统计 `characters/locations/factions` 三者的 `bindingId`，并据此在 `removeWorldEntity` 末尾 `pruneOrphanBindings`（world-ops.ts:16-21、57）删除“无人引用”的绑定。它隐含的 ownership 假设是：**任何 binding 都必须挂在 character/location/faction 上**。

但绑定的语义类型全集是 `character/world/location/faction/rule/item/other` + `lorebook_template`（types.ts:7-8、internal/world/types.go:24-32），后端 `validateWorld` **从不要求每个 binding 都被实体引用**（只校验“实体.bindingId 必须指向存在的绑定”，方向相反，validate.go:248-252、289-293、329-337）。也就是说，**世界级自由绑定在磁盘上是合法的**。

### 当前可触发路径（已逐行确认）
1. 创世向导第 3 步的 `BindingPicker` **没有传 `recordKind/semanticType`**（WorldCreatePage.tsx:220-225），而 `listMasterAssets` 在这两个参数缺省时**不加过滤**（master-library.ts：`if (options.recordKind) ...`），因此可绑定 world/rule/item/location/faction/other/lorebook 等任意资产。
2. onBind 时只有 `character_template + character` 会同步建一个 WorldCharacter（WorldCreatePage.tsx:222-224）；其它语义类型只进 `bindings[]`，**没有任何实体引用它**。世界可正常创建（后端允许）。
3. 进入控制台后，这类自由绑定**没有任何 UI 展示或入口**（角色/地点/势力区都不显示它）。
4. 用户删除**任意一个**角色/地点/势力 → `removeWorldEntity` → `pruneOrphanBindings` 判定该世界级绑定“无人引用” → 在下次保存时**静默删除**。用户在向导里刻意添加的世界背景/规则/物品类绑定就此丢失（薄快照与 masterRevision 基线一并丢失，需重新手动绑定）。

> 说明：控制台内新增的绑定只有角色绑定（WorldConsolePage.tsx:256-262 写死 character_template+character，且 bindCharacter 一定同步建角色），所以控制台自身路径是自洽的；**唯一的自由绑定来源就是创世向导**。正常编辑/保存（不走 removeWorldEntity）不会触发 prune，触发条件精确为“删除某实体”。

### 建议下一步（最小修法，豆包可做）
- 让 orphan 清理**保守化**：只清理“实体作用域”的绑定（`semanticType ∈ {character, location, faction}`）且确无实体引用者；对 `world/rule/item/other` 及 `lorebook_template` 这类**世界作用域**绑定一律保留，不因为没挂实体而删除。
- 在 `world-ops.test.ts` 补必测用例：存在 world/rule/lorebook 自由绑定时，删除任意角色/地点/势力后这些绑定**仍在**；实体作用域且确无引用的绑定仍被正确清理；共享绑定仍不误删。
- 不修改 schema、不改后端、不改绑定单一真源。

---

# 分支问题

## B1（P2）：空地点 / 空势力 / 空时间线仍会造成“必然 400”，与已修的角色默认名不一致
- 状态：**CONFIRMED**
- `emptyLocation/emptyFaction/emptyTimelineEntry` 初始 `name/title=''`（world-factory.ts:26-36）；三个 Section 点“添加”即插入空实体（LocationSection.tsx:25/70、FactionSection.tsx:30/86、TimelineSection.tsx:27/45）。
- 后端硬性要求非空：地点 name（validate.go:236-238）、势力 name（269-271）、时间线 title（387-389），空则 400。用户添加后不填名字直接保存，必然被拒。角色在 2A.1 已用“默认名 + 重名序号”修复（WorldConsolePage.tsx:121-128），这三类却没对齐。
- 建议（不引入表单框架，二选一，推荐后者）：
  - 方案 A：与角色一致，给三者可保存默认名（“新地点/新势力/新事件”+ 去重序号）；
  - **方案 C-lite（推荐）**：保存前用一个纯函数 `findDraftInvalidEntity(world)` 做统一校验，发现空名/空标题时不发请求，toast 明确指出是哪个分区第几条，并自动切到该分区。改动小、不产生“新地点”这类占位垃圾数据。
- CODEX_NEEDED：NO。

## B2（P2）：进入写作/游戏成功后，对应模式卡片 busy 态永久卡死
- 状态：**CONFIRMED**（详见 M1 次生 bug）。ModeRouter 对 worlds 采用 `hidden` 保活而非卸载（ModeRouter.tsx:760-770），`pending` 在成功路径未复位（ModeEntries.tsx:29、39）。返回世界控制台时“写作/游戏”卡片持续转圈且 disabled，需刷新页面才恢复。修复随 M1 一并完成。CODEX_NEEDED：NO。

## B3（P3）：世界控制台角色列表不显示真实头像（单一契约下的已知不一致）
- 状态：**CONFIRMED（预期内的取舍，非回归）**
- 现契约是“只有拿到 `avatar_url` 才渲染 img”。角色档案传 `source.summary.avatar_url`（CharacterProfile.tsx:200-204）、绑定选择器传 `asset.avatar_url`（BindingPicker.tsx:146），**唯独控制台角色列表只传了 masterItemId**（WorldConsolePage.tsx:227），而列表不发起详情请求，因此即便 Master 角色卡真有 PNG 头像，列表也只显示占位图标。
- **不要**恢复“只凭 masterItemId 盲发 /avatar”（那正是 P1-01 已消除的全 404 问题）。当前保持占位是符合单一契约的正确取舍；若 2B 要在列表显示头像，应通过“绑定上记录头像可用性标志 / 列表批量摘要”解决，单独立项。CODEX_NEEDED：NO，本轮不改。

## B4（P3）：叙界入口双重确认
- 状态：CONFIRMED，并入 M1 统一 preflight 修复，不单独处理。CODEX_NEEDED：NO。

## B5（P3）：角色档案在“无改动”时保存按钮仍可用，产生空转 PUT
- 状态：CONFIRMED。控制台保存按钮仅 dirty 时出现（WorldConsolePage.tsx:171），但 CharacterProfile 的保存按钮恒可点（CharacterProfile.tsx:169-171）。打开角色不做任何修改直接保存也会 PUT，服务端刷新 updatedAt、产生新 revision（零编辑写入）。建议：沿用已有 `dirty`，`!dirty` 时禁用保存。CODEX_NEEDED：NO。

## B6（P3）：取消快速切书被误报“切换书籍失败”
- 状态：CONFIRMED（ModeEntries.tsx:31）。用户在确认框取消时应静默留在本页，不应走失败 toast。随 M1 修复。CODEX_NEEDED：NO。

## B7（P3）：selectors.masterAvatarURL 已成为仅测试引用的死代码
- 状态：CONFIRMED。生产侧已不再用它构造头像（selectors.ts:20-23 现仅被 selectors.test 引用）。建议删除该函数及其测试，避免后来者又走回“凭 id 盲请求”的老路。CODEX_NEEDED：NO。

---

# 后续债务（不阻塞 2A 关闭，登记给 2B / 未来）

- **D-1（DESIGN RISK）：1 MiB 请求体上限与领域长度上限不自洽。** HTTP 层 POST/PUT/archive 统一限 1 MiB（handler_world.go:16-24），而领域层允许的极限 World 序列化后远超 1 MiB（如 500 地点×description 20000 字 ≈ 10MB、500 角色×(worldNote+growthNote 各 4000 + customFields) 理论更高、200 绑定×50 标签×100 字 ≈ 1MB）。即“通过领域校验的 World 可能永远无法 PUT/POST”。MVP 真实数据量很难触发（需要数百条长文本），本轮**不扩大修改**；2B 前需统一“HTTP 上限 ↔ 领域上限 ↔ 前端保存前预检”三者口径。CODEX_NEEDED：将来调整共享上限时 = YES，当前 = NO。
- **D-2：世界级 binding 的 ownership 模型需要在 2B 正式定义。** M2 的保守化修复只保证“不误删”；2B 若要真正支持世界背景/规则/物品/lore 独立绑定，需要明确绑定作用域（实体作用域 vs 世界作用域）以及控制台对世界级绑定的展示/移除入口，这属于 binding ownership/schema 层面的决策，**届时应由 Codex 参与拍板**。本轮不实施。
- **D-3：全局顶栏 / 左侧活动栏切模式会绕过页面内 dirty guard。** 全局导航走 App.handleSetMode / WorkbenchShell，不经过 WorldConsolePage.guardLeave。好在 ModeRouter 对 worlds 是 `hidden` 保活，切走并不会销毁草稿（返回仍在），只有整页刷新才丢未保存改动。要彻底拦截需在 ModeRouter/App 层注册“可阻止导航”回调，超出“不重构/最小修复”范围，2B 或专项再做。CODEX_NEEDED：将来动 ModeRouter/App 时 = YES。
- **D-4：列表归档遇到 409 只 toast，没有“重新加载”路径。** WorldListPage.setArchived（WorldListPage.tsx:46-64）冲突时仅显示 err.message。低频，后续可补重载。CODEX_NEEDED：NO。
- **D-5：非 PNG（JSON 卡 / 远程 URL）头像策略尚未定义。** 目前后端只对“已归档 PNG”生成 avatar_url，其余一律图标回退。是否支持、如何安全支持远程 URL 头像留待后续，不在本轮抓不可信远程 URL。CODEX_NEEDED：NO。
- **D-6：刷新在途时点击保存的边角时序。** CharacterProfile 中 refresh 请求晚于 save 返回时，会在已保存世界之上再 apply 一次绑定三字段并置 dirty（CharacterProfile.tsx:80-90）。结果是“保存后又出现一处未保存改动”，不丢数据、可再次保存，体验小瑕疵；2B 可考虑保存时使在途 refresh 失效。CODEX_NEEDED：NO。

---

# A–F 验证表

| 编号 | 假设 | 结论 | 关键依据 / 说明 |
|---|---|---|---|
| **A** | Mode Entry 未保存事务：双重确认、副作用先于确认、取消后全局状态已变 | **CONFIRMED** | 见 M1。写作双重确认且第二次取消后书已切；游戏 `selectInteractiveStory`（服务端 POST）先于唯一确认；叙界双重确认；沙盒单次确认无问题。另发现成功后卡片 busy 永久卡死（B2）。 |
| **B** | 空地点/空势力/空时间线必然保存 400 | **CONFIRMED** | world-factory.ts:26-36 初始空名/空标题；validate.go:236/269/387 要求非空。角色已用默认名修复，这三类未对齐。建议保存前统一校验（C-lite）。 |
| **C** | 控制台角色列表仍只传 masterItemId，真实头像显示占位 | **CONFIRMED（预期取舍，P3）** | WorldConsolePage.tsx:227 仅传 id；档案/选择器传 avatar_url。遵守单一契约，不恢复盲请求；列表头像留待 2B。 |
| **D** | pruneOrphanBindings 可能误删未来世界级 binding | **CONFIRMED，且当前即可触发** | 创世向导 BindingPicker 未过滤语义类型（WorldCreatePage.tsx:220），可建无实体引用的世界级绑定；删任意实体即被 prune（world-ops.ts:7-21）。见 M2；完整 ownership 留 2B（D-2）。 |
| **E** | reload 与 Master refresh 竞态：旧请求在放弃修改后又 apply/置脏 | **NOT REPRODUCED（FALSE POSITIVE）** | reload 会 `setCheckNonce(n+1)`（CharacterProfile.tsx:153），触发检查 effect 的 cleanup `inspectSeq.current += 1`（:120）并以新代发起只读 check；旧 refresh 捕获的 seq 已落后，返回时 `if (seq !== inspectSeq.current) return`（:68、93）直接退出，**不会** applyRefreshedBinding、不会 setDirty。前提“refresh 在途”意味着网络未返回，nonce 自增的 commit 必先行，时序成立。唯一相关边角是 D-6（refresh 晚于 save），不构成 E 描述的问题。 |
| **F** | 领域合法的 World 可能 JSON>1MiB 而永远无法保存 | **DESIGN RISK** | 见 D-1。理论成立、MVP 不易触发；本轮只登记，不改上限。 |

---

# 新发现（按严重度）

## P0
- 无。

## P1
- **M1** 运行模式入口缺统一 preflight：双重确认 + 副作用（切书 / 服务端选择故事 / 关 Module4）先于或跨越离开确认，取消后全局状态已变。CODEX_NEEDED=NO。
- **M2** orphan 绑定清理会误删世界级/自由绑定，且该数据今天可经创世向导创建、删除任意实体即静默丢失。CODEX_NEEDED=NO（2B ownership 决策时再找 Codex，见 D-2）。

## P2
- **B1** 空地点/空势力/空时间线必然 400，未与角色默认名策略对齐。CODEX_NEEDED=NO。
- **B2** 成功进入写作/游戏后模式卡片 busy 态永久卡死（保活不卸载 + pending 未复位）。CODEX_NEEDED=NO。

## P3
- **B3** 控制台角色列表不显示真实头像（契约内取舍，本轮不动）。
- **B4** 叙界双重确认（并入 M1）。
- **B5** 角色档案无改动也能保存，产生空转 PUT / updatedAt 抖动。
- **B6** 用户取消切书被误报“切换书籍失败”。
- **B7** `masterAvatarURL` 成为仅测试引用的死代码，建议删除以防走回盲请求老路。
- 归档 409 无重载入口（D-4）、refresh 晚于 save 的小时序（D-6）。

---

# 下一步执行清单

## 交给 Workbuddy 本地复现（给出确定步骤，便于先验证再修）
1. **M1-写作**：控制台制造未保存修改 → 概览点“写作模式”：观察到两次确认；第一次确认、第二次取消 → 检查当前书已被切换但仍停在 worlds。
2. **M1-游戏**：制造未保存修改 → 点“游戏模式”：在网络面板观察到 `POST /api/interactive/stories/:id/select` **先于**确认框发出；确认框点取消 → 该故事已被选为当前故事。
3. **M1-叙界**：制造未保存修改 → 点“叙界”，观察两次确认。
4. **B2**：无修改直接点“写作模式”进入 IDE → 通过全局导航回到该世界控制台 → “写作/游戏”卡片持续转圈且不可点。
5. **M2**：创世第 3 步绑定一个**非角色**资产（世界/规则类），完成创建 → 控制台新增一个角色再删除它并保存 → 重新打开世界，先前的世界级绑定已消失。
6. **B1**：控制台地点/势力/历史各添加一条但不填名称/标题 → 保存 → 收到 400 字段错误。

## 豆包自己可以修（不需要 Codex，建议作为 2A.2 一次做完，全部补定向测试）
- M1 + B2 + B4 + B6：ModeEntries 统一单次 preflight、副作用成功后才切走、finally 复位 pending、取消不报错；控制台改为传原始回调 + 单个 confirmLeave。
- M2：`pruneOrphanBindings` 按语义作用域保守清理 + world-ops 测试。
- B1：保存前统一草稿校验纯函数 + toast/定位（或默认名，二选一，推荐校验）。
- B5：CharacterProfile 无 dirty 时禁用保存。
- B7：删除 masterAvatarURL 及其测试。
- 修复后复跑：world-workspace vitest、workbench/stores 回归、tsc、check-i18n-keys、`go test ./internal/world ./internal/api/handlers`、作用域 go vet、vite build、go build；并按惯例区分 Vite dev 与正式 executable 两类页面验收。

## 必须保留给 Codex
- **本轮没有必须 Codex 立即介入的项**（无 P0、无 CAS/并发数据损坏、无需改多模块共享契约或 schema）。
- 仅在以下时点需要 Codex：① 2A.2 修复完成后的一次快速节点复审；② Phase 2B 正式定义世界级 binding ownership / 是否加作用域字段（D-2）；③ 将来若要在 ModeRouter/App 层做全局可阻止导航（D-3）或统一 1MiB 与领域上限（D-1）。

## 暂时不处理（登记即可）
- D-1 容量口径、D-3 全局导航拦截、D-4 归档 409 重载、D-5 非 PNG/远程头像策略、D-6 refresh/save 时序、B3 列表头像。均不阻塞 2A 关闭。

---

### 附：本次复审阅读的关键文件
- 前端：`web/src/features/world-workspace/` 下 pages（WorldConsolePage/WorldListPage/WorldCreatePage）、components（CharacterProfile/BindingPicker/BindingAvatar/ModeEntries）、components/sections（Location/Faction/Timeline）、world-ops.ts、binding-health.ts、selectors.ts、world-factory.ts、world-api.ts、types.ts；`components/workbench/ModeRouter.tsx`、`App.tsx`、`features/interactive/api.ts`、`lib/api-client/master-library.ts`。
- 后端：`internal/world/{validate,types,store}.go`、`internal/api/handlers/handler_world.go`。
