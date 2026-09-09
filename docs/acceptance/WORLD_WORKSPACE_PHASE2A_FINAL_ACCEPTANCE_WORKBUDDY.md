# World Workspace Phase 2A Final Acceptance — Workbuddy 任务书

- 编写时间：2026-09-09（Asia/Shanghai）
- 执行人：Workbuddy（本地真机/真环境验收）
- 被验收对象：当前**工作树未提交改动**（Phase 2A.2 正确性修复），基线 commit `8623b64`
- 你的角色：只做**验收与取证**，不改源码、不重构、不提交、不动 Module3/Module4、不新增依赖。
- 产出：本文件末尾的《验收记录》逐项填好（结论 + 证据路径/截图 + 网络请求观察），发现问题按 P0/P1/P2/P3 记录并**停下来上报**，不要自行修。

---

## 0. 背景速览（你需要知道的最小事实）

- 项目根：`D:\Narraverse2.0`；Go 后端在 `denova-src`，React 前端在 `denova-src\web`。
- 世界数据是**服务端真源**：每个世界一个 `world-<id>.json`，落在启动目录下的 `.denova\worlds\`（DataDir 默认是**进程当前工作目录**的 `./.denova`，所以“换个干净目录启动”就能天然隔离，不污染用户原数据）。
- 世界工作区入口：左侧活动栏点 **“世界工作区”**（URL 表现为 `?mode=worlds`）。
- 四个体验入口（世界控制台 → 概览 → “体验入口”）：**写作模式 / 游戏模式 / 叙界 Narraverse / 开放沙盒**。
- 绑定健康六态文案：`尚未检查 / 检查中… / 已是最新 / 原件有更新 / 原件已不存在 / 暂时无法检查`；手动按钮叫 **“刷新资料摘要”**。
- 创世向导四步：第 1 步 世界雏形 → 第 2 步 基调与规则 → 第 3 步 **绑定与主书** → 第 4 步 确认创世。
- 本轮（2A.2）刚修、需要你重点回归的点：
  1. **M1**：进入任一模式只弹**一次**离开确认；点“取消”必须**零副作用**（不切书、不切模式、不发选择故事的 POST）；成功进入后返回，卡片不能一直转圈。
  2. **M2**：删除角色时，只清理“角色/地点/势力”这类实体绑定；世界规则、lore 等**世界级绑定必须保留**。
  3. 空名称实体保存前拦截、无修改时保存按钮禁用（顺带回归）。

> 环境注意（重要，本机已配置成非标准 PATH）：
> - `go`/`pnpm` 不在 PATH。Go 用绝对路径 `D:\Narraverse2.0\tools\go\bin\go.exe`，且每条命令前先 `$env:GOTOOLCHAIN='local'`。
> - 前端命令用 `denova-src\web\node_modules\.bin\` 下的 `.cmd`（`vite.cmd`、`tsc.cmd`）。
> - PowerShell 控制台里中文可能显示为乱码，不影响功能；以浏览器界面和 UTF-8 的 JSON 文件为准。

---

## 1. 环境准备（正式 executable 为主，Vite dev 仅作对照）

> 2A.2 改了前端，**必须重新 build 前端并重新编译 executable**，不要用旧的 `denova.exe`。

### 1.1 构建（PowerShell）

```powershell
# 1) 前端生产构建（产出 denova-src\web\dist）
cd D:\Narraverse2.0\denova-src\web
.\node_modules\.bin\vite.cmd build
# 期望末尾：✓ built，仅有既有 “chunk > 500kB” 提示，不算失败

# 2) 编译当前工作树的 executable 到隔离目录
cd D:\Narraverse2.0\denova-src
$env:GOTOOLCHAIN='local'
New-Item -ItemType Directory -Force D:\Narraverse2.0\.acceptance-2a-final\runtime | Out-Null
& D:\Narraverse2.0\tools\go\bin\go.exe build -o D:\Narraverse2.0\.acceptance-2a-final\denova.exe ./cmd/denova
# 期望：无输出、退出码 0，生成 denova.exe
```

### 1.2 以隔离工作目录启动正式服务（同源静态装配）

```powershell
# 关键：cd 到隔离 runtime，使 ./.denova（含 worlds）落在隔离目录
cd D:\Narraverse2.0\.acceptance-2a-final\runtime
$env:DENOVA_WEB_DIR='D:\Narraverse2.0\denova-src\web\dist'   # executable 同源托管生产构建
& D:\Narraverse2.0\.acceptance-2a-final\denova.exe -port 8095 -no-open
```

- 启动后浏览器打开 `http://127.0.0.1:8095/`，左侧进入 **世界工作区**。
- 健康检查：访问 `http://127.0.0.1:8095/api/status` 应正常返回。
- **总资料库资产**：M2/基础流程需要能绑定到真实“角色 / 世界规则 / lore”资产。
  - 若换隔离目录后“绑定总资料库资产”列表为空，说明 Master Library 不在该 cwd：参照 `docs/acceptance/WORLD_WORKSPACE_PHASE2A_REAL_ENV_ACCEPTANCE.md` 第 6 行的隔离副本做法，把 `narraverse-master-library` 与一本测试书复制进本 `runtime` 后重启；
  - **仍不确定就停下来问，不要改用户原始 `.denova`。** 绑定只是只读引用，不会回写总资料库。

### 1.3（可选对照）Vite dev 代理

正式 executable 路径是**主验收**。如需对照开发代理：保持 1.2 的后端在 8095，另开一个终端：

```powershell
cd D:\Narraverse2.0\denova-src\web
$env:DENOVA_BACKEND_PORT='8095'
.\node_modules\.bin\vite.cmd --port 5174
# 打开 http://127.0.0.1:5174/ ，/api 代理到 8095
```

> 最终报告必须分开写：哪些结论来自 **正式 executable（8095 + dist）**，哪些来自 **Vite dev（5174 代理）**；不得把 5174 的结果写成正式 executable 验收。

### 1.4 取证准备

- 浏览器 F12 → Network，勾选 Preserve log，过滤框准备好 `api`；每次关键点击前后留意 **POST/PUT/DELETE** 类请求。
- 准备截图目录，例如 `.acceptance-2a-final\shots\`。
- 世界 JSON 随时可读：`.acceptance-2a-final\runtime\.denova\worlds\world-<id>.json`（服务运行时也可读，停止后改写更稳妥）。

---

## 2. 验收项 A：M1 模式跳转统一 preflight（重点）

### A1. 写作模式 —— 取消必须零副作用（核心用例，逐步照做）

前置：先按第 4 节创建一个世界并进入其**世界控制台**；在控制台做一处可保存的小修改（例如概览改“一句话定位”，或角色区手动新建一个角色），让界面处于**有未保存修改（dirty）**状态（出现“保存”按钮即可，先别保存）。打开 F12 Network 并清空。

操作与判定：

1. 概览 → 体验入口，点 **“写作模式”**。
2. **期望：只弹出 1 个离开确认框**（文案：“有尚未保存的修改，离开将丢弃这些改动，确定继续吗？”）。
   - [ ] 实际只出现 1 次（不能连弹第 2 次）。
3. 点 **“取消”**。
4. 期望（全部满足才算过）：
   - [ ] 仍停留在**同一个世界控制台**，视图/URL 没跳到 IDE/写作；
   - [ ] Network 里点击之后**没有任何新的切书/工作区切换类请求**（无 switch/workspace 类 POST）；
   - [ ] 顶部/侧边当前书**没有被切换**；
   - [ ] 刚做的未保存修改还在（“保存”按钮仍在，草稿没丢）；
   - [ ] **“写作模式”卡片没有进入转圈/禁用**（仍可再次点击）。

然后走“确认进入”分支：

5. 再次点 **“写作模式”** → 这次点 **“确定”**。
6. 期望：
   - [ ] 先完成主书切换，再进入写作/IDE（只确认这一次，过程中**不再弹第二个框**）；
   - [ ] 若该世界没选主书，应提示“未选择主书”并留在本页，而不是报错跳转。
7. 通过左侧 **“世界工作区”** 回到刚才的世界控制台（worlds 是保活的，会回到原控制台）。
8. **busy 复位回归（B2）**：
   - [ ] “写作模式”卡片**不转圈、不卡在 disabled**，可正常再次点击。

### A2. 其余三模式（同样：确认一次；取消零副作用；成功后返回不卡转圈）

对每个模式重复“dirty → 点击 → 取消 → 无副作用；再点击 → 确定 → 进入 → 返回 → 卡片不转圈”。特别关注：

| 模式 | 取消时必须观察到的“零副作用” |
| --- | --- |
| **游戏模式** | 点取消后 Network **不得出现** `POST /api/interactive/stories/:id/select`（选择故事是服务端副作用，必须发生在“确定”之后）；不跳 interactive。世界未选主故事时应提示并留页。 |
| **叙界 Narraverse** | 只弹**一次**确认（历史 bug 是连弹两次）；取消后不切到叙界、Module4 叠层不被关闭。 |
| **开放沙盒** | 单次确认；取消后不打开 Module4、不切模式。 |

- [ ] 游戏：取消无 `select` 请求；确定后才发 `select` 且随后进入 interactive；返回后卡片不转圈。
- [ ] 叙界：仅一次确认；取消留页；确定后正常进入。
- [ ] 沙盒：仅一次确认；取消不打开 Module4。

> 判定口径：一次点击 = 一次统一 preflight。**任何“先产生了副作用、再问是否离开 / 问了两次 / 取消后状态已变 / 返回后卡片永久转圈”都判 FAIL（P1）。**

---

## 3. 验收项 B：M2 绑定清理保护（角色绑定删、世界级绑定留）

1. 世界工作区 → **创建世界**，四步走到**第 3 步“绑定与主书”**，在“绑定总资料库资产”里分别添加（用搜索/筛选找到对应类型）：
   - 1 个**角色**（character / character_template）；
   - 1 个**世界规则**（rule / world 类，非角色）；
   - 1 个 **lore**（lorebook / 其它非角色类）。
   主书/主故事可先不选或任选，第 4 步完成创世。记录新世界 id。
2. 进入该世界控制台 → **角色**：应看到第 3 步那个角色（角色绑定会同步生成角色实例）。
3. 打开世界 JSON（`.denova\worlds\world-<id>.json`）记录初始 `bindings`：应含 3 条（角色 + 规则 + lore）。
4. 在控制台**删除该角色**，按界面确认，然后点 **“保存”**（删除要 PUT 后才落盘）。
5. 重新打开/刷新该世界 JSON，判定：
   - [ ] `characters` 已空；
   - [ ] **角色对应的那条 binding 已被删除**；
   - [ ] **世界规则 binding 仍在**；
   - [ ] **lore binding 仍在**；
   - [ ] 界面无报错，世界列表里该世界健康（无损坏 warning）。
6. 反向对照（证明不是“什么都不删”）：另建一个世界，绑定 1 个**地点类**资产但不建对应地点实体（或绑定角色后删角色），保存后这类**实体作用域且无实体引用**的绑定应被清理。
   - [ ] 实体作用域孤儿绑定被清；世界作用域绑定被留（两者行为不同，才说明修复精确）。

> 注：世界级绑定目前**没有专门 UI 展示位**，所以“保留”以世界 JSON / `GET /api/worlds/:id` 返回为准，这是预期，不是缺陷。

---

## 4. 验收项 C：基础闭环（创建→绑定→档案→刷新→stale→刷新→重启恢复）

1. **创建世界**：四步创世，第 3 步绑定 1 张真实**角色**卡，完成创建。
2. **打开角色**：控制台 → 角色 → 点该角色进入角色档案。
   - [ ] 打开时自动做一次只读检查，健康状态显示 **“已是最新”**（刚绑定，存储 masterRevision 与原件一致）；
   - [ ] 右侧能看到“总资料库原件”摘要；打开档案这一动作**不产生 PUT**（Network 观察）。
3. **首次刷新**：点 **“刷新资料摘要”**。
   - [ ] 提示“已更新本地资料摘要，保存后才会生效”（不声称已保存）；
   - [ ] 此时**不发 PUT**；角色世界内的 `displayName / worldNote / growthNote` 不被原件覆盖；
   - [ ] 点 **“保存”** 后才 PUT，保存成功。
4. **制造 upstream 变化以得到 stale（确定性做法，推荐）**：
   - 停止服务；打开 `world-<id>.json`，把该角色 binding 的 `masterRevision` 改成一个明显不同的旧值（如 `"sha256:stale-old"`，可同时把 `nameSnapshot` 改成旧名以便观察），保存文件；重启 1.2 的服务。
   - （更真实的替代做法：在隔离 Master 副本里改该角色源并重新走抽取，使内容哈希变化；二选一即可，推荐前者更可控。）
5. 重开角色档案：
   - [ ] 健康状态显示 **“原件有更新”（stale）**，而不是 missing/unavailable。
6. 点 **“刷新资料摘要”** → **“保存”**：
   - [ ] binding 的 `nameSnapshot / tagsSnapshot / masterRevision` 更新为原件当前值；
   - [ ] 角色世界内字段（displayName、worldNote 等）保持用户值不变；
   - [ ] 保存后重开显示 **“已是最新”**。
7. **重启持久化（恢复正常）**：完全关闭 denova 进程再重新启动（同 1.2），重新打开该世界与角色：
   - [ ] 世界、绑定快照、角色实例、revision 都还在；
   - [ ] 健康状态 **“已是最新”**；世界列表无损坏 warning。

### 4.x 顺带回归（点到即可，记录现象）

- [ ] **空名称拦截**：控制台新增地点/势力/时间线条目但不填名称/标题直接“保存”，应被前端拦下、提示并跳到对应分区，**不发请求、不出现 400**。
- [ ] **无修改禁保存**：角色档案在未做任何修改时“保存”按钮是**禁用**的；控制台无修改时也不显示保存按钮。
- [ ] **冲突重载**（如时间允许）：人为让本地 revision 过期再保存，出现冲突横幅和“重新加载”，取消不重载、确定后以服务端为准并清横幅。

---

## 5. 双入口一致性结论

- [ ] 正式 executable（8095 + `web/dist`）：A/B/C 全部走通（**主结论以此为准**）。
- [ ] Vite dev（5174 代理）：如做了对照，记录是否一致；没做就明确写“未做”，不要混写。

---

## 6. 边界与纪律

- 只验收，不改 `denova-src` 任何源码；不 `git add`、不 `git commit`、不用 `git add .`。
- 不动 Module3 / Module4，不改总资料库、书籍、互动故事的数据结构，不回写 worldId。
- 所有创建/改写只允许发生在 `.acceptance-2a-final\runtime` 隔离目录。
- 遇到与预期不符：**停止该路径继续操作**，截图 + 保存 Network 请求，按下面模板记录，不要尝试“点几下试试能不能好”。

---

## 7. 验收记录（完成后填写并回传）

### 总览

| 验收项 | 结论（PASS/FAIL/阻塞） | 证据（截图/JSON/请求） | 备注 |
| --- | --- | --- | --- |
| A1 写作：单次确认 + 取消零副作用 | PASS | `shots/A1-cancel-branch.png`；`evidence/A1-cancel.requests.json` | 原生 confirm 仅 1 次；取消后仍留控制台、URL 不变、无写请求、草稿在、卡片可用（15/15 全过） |
| A1 写作：确定进入 + 返回不转圈 | PASS | `shots/A1-enter-branch.png`、`shots/A1-reclick.png` | 只确认一次即进入写作/IDE；返回后卡片不转圈、可再次点击（主书即当前书故无切书网络请求，仅记录） |
| A2 游戏：取消无 select POST / 确定后才选 | PASS | `shots/A2g-cancel.png`、`shots/A2g-enter.png`；`evidence/A2g-full.requests.json` | 取消无 `POST /api/interactive/stories/:id/select`；确定后才发 select 并进入游戏工作台（9/9） |
| A2 叙界：仅一次确认 | PASS | `shots/A2n-cancel.png`、`shots/A2n-enter.png`、`shots/A2n-back.png` | 只弹一次；取消留页不切叙界；确定进入叙界工作台；返回卡片可用（7/7） |
| A2 沙盒：单次确认 | PASS | `shots/A2s-cancel.png`、`shots/A2s-enter.png`、`shots/A2s-back.png` | 只弹一次；取消不打开 Module4；确定进入开放沙盒工作台；可返回（5/5） |
| B M2：删角色删角色绑定、留规则/lore | PASS | `shots/B-deleted-saved.png`；`evidence/B-before.json`、`evidence/B-after.json`、`evidence/B-full.requests.json` | 删“喜多川海梦”→confirm 一次→保存 PUT；characters 空、角色 binding 删、两条世界作用域 binding（lorebook，落库 semanticType=other）保留（18/18） |
| B 对照：实体作用域孤儿绑定被清 | PASS | `shots/B6-after-save.png`；`evidence/B6-after.json` | JSON 注入“有绑定无实体”的孤儿 char binding；删除任意实体触发级联后孤儿被清，同世界 lorebook 绑定保留（行为不同=精确） |
| C 创建→绑定→打开→首次刷新→保存 | PASS | `shots/C-open-latest.png`、`shots/C-after-refresh.png`、`shots/C-after-save.png`；`evidence/C-phase1-final.json` | 打开=只读检查“已是最新”、无 PUT、保存禁用；刷新提示“已更新本地资料摘要，保存后才会生效”且无 PUT；保存才 PUT；世界内字段未被原件覆盖（14/14） |
| C stale→刷新→保存→最新 | PASS | `shots/C-stale.png`、`shots/C-reopen-latest.png`；`evidence/C-phase2-final.json` | 停服改 `masterRevision=sha256:stale-old…` 后重开档案显示“原件有更新”；刷新+保存后 nameSnapshot/masterRevision 恢复原件当前值、角色世界内字段保留；重开“已是最新”（9/9） |
| C 重启后持久化、恢复“已是最新” | PASS | `shots/C6-restart-latest.png`；`evidence/C-phase3-results.json` | 完全重启后世界/绑定快照/角色实例/revision 均在，重开档案“已是最新”，列表无损坏 warning（5/5） |
| 4.x 空名称拦截 / 无修改禁保存 / 冲突重载 | PASS | `shots/4x1-location-blocked.png`、`shots/4x2-faction-blocked.png`、`shots/4x3-timeline-blocked.png`、`shots/4x4-clean-console-no-save.png`、`shots/4x5-conflict-banner.png`、`shots/4x5-conflict-reloaded.png`；`evidence/regress-results.json` | 地点/势力空名与时间线空标题保存均被前端拦截并提示、零请求零 4xx；干净控制台无保存按钮；409 冲突横幅+“重新加载”，取消保留草稿、确认以服务端为准（11/11） |
| 双入口一致性（executable / Vite） | PASS（仅 executable 主验收） | 上述全部证据均在正式 executable(8095+dist) 采集 | Vite dev(5174) 对照未做，明确记录；不把 5174 结果计入主结论 |

### 环境事实

- 前端构建时间 / 结果：2026-09-09 23:02，`vite build --outDir .acceptance-2a-final/web-dist` ✓ built 8.60s（仅既有 >500kB chunk 提示；沙箱批量删除保护阻断原地重建 web/dist，故 dist 建到隔离 web-dist，来源为同一工作树，不影响同源装配结论）
- executable 构建时间 / 结果：2026-09-09 23:04，`go build -o .acceptance-2a-final\denova.exe ./cmd/denova` exit0（73,230,336 B）
- 正式服务地址与启动目录：`http://127.0.0.1:8095/`，cwd=`D:\Narraverse2.0\.acceptance-2a-final\runtime`；`DENOVA_WEB_DIR=.acceptance-2a-final\web-dist`；DataDir=启动目录 `.denova`（含隔离 worlds/项目副本）
- Vite dev 是否对照：未做（5174）
- 隔离 runtime 路径：`D:\Narraverse2.0\.acceptance-2a-final\runtime`（截图 `shots\`、网络取证 `evidence\` 均在其同级下）

### 发现的问题（按 P0/P1/P2/P3；没有就写“无”）：无 P0/P1/P2/P3 功能问题。

#### 观察项与记录（非缺陷）
- 环境约束：真实总资料库仅有 character_template(4)+lorebook_template(3) 资产，无 rule/world 类资产，故 M2 的“世界规则/lore”位以 lorebook 充当（落库 semanticType=`other`，属世界作用域）；绑定保留语义判定正确。
- 行为观察（与 M1 设计一致）：进入写作/游戏等模式时丢弃的是“离开动作本身”产生的语义，世界控制台为 hidden keepalive，返回后未保存草稿仍在；任务书 A1/B2 的判定（取消保留草稿、返回卡片不转圈可再点）均 PASS。
- 已知边界 D-3：顶栏四模式入口绕过页面级 guard，不在本轮验收范围；本次验收全部走世界控制台“体验入口”卡片路径。
- 验收驱动说明：agent-browser CLI 未预装，采用 playwright-core+系统 Edge（驱动仅存在于隔离验收目录，未向仓库添加依赖）；原生 confirm 通过 dialog 事件模拟“确定/取消”。

### 总结论（三选一，给出理由）

- [x] 允许正式关闭 Phase 2A（A/B/C 全 PASS，无 P0/P1）
- [ ] 有条件关闭（列出必须先修的 P1）
- [ ] 不允许关闭（说明阻塞项）
