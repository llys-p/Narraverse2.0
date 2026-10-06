# 本书资料工作台第一期 · 主审返修与收口

时间：2026-10-06 19:49（Asia/Shanghai）。结论：**PASS：本期剩余返修及同类旧入口补漏已完成并通过定向验收**。

## 最终补漏与最终产物验收（19:49）

- 旧 `SettingPanel` 的新建、删除、单条生成、清图、批量生图也传入目标 workspace。删除确认将 workspace 与条目一起冻结；批量选区在打开时冻结 workspace。切书关闭旧确认/批量弹窗、清空选择并终止旧流；迟到事件核对控制器与归属，旧 finally 不清除新控制器。避免将旧书 ID 与新书身份重新配对。
- 批量任务在服务端接收时持锁核验并固定 workspace，即使兼容调用未带身份也固定接收时的书；后台初始快照和逐项生成均核验该身份，不能随当前书变化转去新书。错误声明返回 409，未进入模型调用。
- 旧入口缺参三条先 RED 后原面板全量通过；删除确认/批量选择跨书两条先 RED 后最终 `SettingPanel` **52/52**。此前组合回归 **8 文件 113/113**（与面板测试重叠，不相加）；最终补丁后 tsc 0、Vite build 0。Go 最终 exe build/vet 0；主审独立重跑后台批次切书反例通过，上游调用次数 0。Luna 对刚才两条弹窗/选区阻断只读复核 PASS，不冒称运行了测试。
- **最终 exe + web-final 的真实 Edge 1440×900 五链 PASS，pageerror 0**：立即切书先保存且 A/B 隔离；注入保存 500 阻止切书并保草稿；UI 清图 body 归属 A 且 B 同 ID 不变；真实单条清图/生图错书 409；真实批量错书 409。正例和单独故障注入均有脚本/JSON。未调用真实模型，没有再次宣称全仓测试通过。
- 最终独立实例 8192/PID17520，`denova-repaired-final.exe` + `web-final`，仅使用本轮虚构 A/B 数据；在线首页 SHA 与磁盘一致，验完核验 PID 对应 exe 后只停该进程。8192 已释放；8084/PID86204、8190/PID95300 保持，正式实例未部署/重启。证据 `repair3/browser-results-final.json`、`runtime-receipt-final.json`、`dialog-scope-{red,green}.log`、`batch-final-tests.log`。
- 最终源码中的共享活动栏入口已由并行任务统一命名为「资料库」（进入后分区「本书资料」），浏览器脚本按当前名称定位；初次最终脚本因旧按钮名超时，调整后五链通过，未修改产品来配合测试。首次 19:36 的四链与产物收据保留如下，最终结论以上述新产物为准。

---

## 19:36 首轮修复记录（保留证据）

用户授权主审自行修复；评估为局部改动，未另写大任务书。Luna 负责后端补参和锁边界，主审完成前端切书保存链与最终真实验收。业务改动仅在维护树 `D:/Narraverse2.0-platform-model`，HEAD/分支保持不变；其他人的脏改动保留，没有提交、推送或更新正式实例。

## 修复结果

1. **F1-a 原子写入边界关闭。** Create/DeleteForWorkspace 在同一个 App RLock 内核验 `filepath.Clean` 身份并直接对当前固定 store 写入，锁持有至同步磁盘操作结束，不再转调重新读取当前书的 legacy 方法。切书需等锁释放；旧接口兼容保留。
2. **F1-b AI 图请求归属关闭。** `generateLoreItemImage(id, input, workspace?)` 与 `clearLoreItemImage(id, workspace?)` 现将身份写入 JSON；工作台传捕获的 target.scope。生图请求字段新增可选 workspace，runtime snapshot 在锁内核验后捕获目标书/store，后续写回固定目标。不匹配在条目读取/图像上游调用前返回 409。清图同样按请求身份持锁核验写入，错误不泄漏路径。
3. **F2 顶部切书保护关闭。** 工作台把条目与总览的保存函数经 LibraryWorkspaceRoute 注册给 ModeRouter；顶部 quickSwitchBook 与书架切书前的 flushBeforeWorkspaceSwitch 都先等待该边界。任一保存失败返回 false，不发送切书请求，不清空草稿。关闭也直接保存成功后退出，移除与实际保存行为矛盾的丢弃确认。切分区仍是用户明确确认后丢弃，映射表已纠正表述。
4. **F3 维持已关闭。** 本轮未改导航入口或关系图实现，不扩 R2—R5/手机适配。

## 本轮验证与限度

- 新增四条前端失败反例先实跑 RED：外层未等待总览保存、失败仍继续切书、总览保存边界未注册、图像请求缺 workspace。补丁后定向 **7 文件 59/59**；tsc --noEmit 0；i18n 4457 键对齐；隔离 Vite build 0（既有大 chunk 提示）。没有宣称全仓测试通过。
- 后端两条新反例先 RED：跨书清图曾返回 200；跨书生图在调用本地上游后返回 400。修复后 Luna 的 api/app Lore 定向通过。主审独立重跑 3 条关键测试（Clean 等价路径新建/删除、错书清图、错书生图且上游调用 0）全部通过；go vet app/handlers 0；Go 可执行构建 0。原子性由持锁实现确认，没有伪造调度窗口或用无意义循环测试替代锁证据。
- **真实 Edge 1440×900 四链均 PASS，pageerror 0**：①A 总览改动后立即顶部切 B，文件 POST 1 次且带 A 身份，磁盘一致，B 未含 A 文本，切回 A 文本仍在；②单独注入文件 POST 500，顶部切书请求 0、仍在 A、草稿保留；③页面打开 AI 图对话框点击清图，DELETE body 带 A workspace，A 关联清除、B 同 ID 图关联保持；④真实 handler 在当前 B 收到声明 A 的清图/生图请求都返回 409。故障注入与无拦截正例分开标注。
- 验收使用本轮新 exe+web 的**独立 8192 实例**，PID 97120，exe `D:/Narraverse2.0/artifacts/book-library-phase1-review-20261006/repair3/denova-repaired.exe`，前端同目录 web，数据同目录 run/data。两册书通过真实建书 API 新建，未复制用户配置、书籍或密钥。在线首页与新构建 SHA 一致，见 runtime-receipt.json；验收完成只停止自己启动的 PID97120，8192 已释放。8084/PID86204、8190/PID95300 保持。
- 生图测试上游为本地 httptest，未调用付费模型；真实模型质量不在本次验证范围。图像 UI 夹具只有合成关联元数据，未验生成图片质量。正式页面没有部署该补丁，仍使用原快照。
- 浏览器脚本早期遇到空总览两个“编辑”按钮、清图按钮位于弹窗 Portal、夹具 Lore 存储路径定位差异，均修正验收定位后四链通过，没有为脚本方便修改产品界面。证据 `D:/Narraverse2.0/artifacts/book-library-phase1-review-20261006/repair3/`；后端 RED/GREEN 原始日志在维护树 `denova-src/artifacts/book-library-phase1-review-20261006/repair3/backend/`。

本期上述阻塞关闭。可以继续日常集成体验；正式部署、提交/推送与后续阶段没有在本轮执行。

---

# 历史：本书资料工作台第一期 · A 二审

时间：2026-10-06 19:21（Asia/Shanghai）。结论：**NEED REVISION**，只继续本期小范围返修。

F3 已关闭；F2 的快速切视图与保存失败保护通过真实桌面浏览器复验。F1 的主要前端补丁和顺序执行的后端守卫测试通过，但尚有两个服务端跨书写入缺口。F2 的切书草稿保护也没有接入外层切书流程。本轮不修改业务源码、不提交/推送、不部署或启停正式实例。

## 二审基线与新鲜证据

- 审查树 `D:/Narraverse2.0-platform-model`，分支 `codex/platform-model-unification`，HEAD `95acac709bbb269e5612467712886022266160bd` 加当前未提交修改。只读基线再次存入 `artifacts/book-library-phase1-review-20261006/revision2/baseline.txt`（本报告所在根目录）；既有脏改动保留。
- 浏览器实际目标为交付隔离实例 `http://127.0.0.1:8190/`，PID 95300，exe `D:/Narraverse2.0-platform-model/artifacts/book-library-phase1-20261006/denova-book-library.exe`；虚构数据在同目录 `run/.denova`、书籍在 `run/books`。未启停该实例。
- 首页 HTTP 200；在线首页与交付 `web/index.html` SHA-256 一致：`23B8AF63F7495E384337A999692C6EA12F929061DFA760783C15E24635F83E85`。本轮没有再构建替换 exe/web；不能把首页哈希核对扩大称为所有业务源码与二进制的独立证明。
- 主审 fresh Vitest：book-library、LibraryWorkspaceRoute、WorkbenchShell.bookLibrary、共享 use-lore-item-autosave，共 **6 文件 49/49**；tsc --noEmit 退出 0；i18n **4457 键对齐**。Luna 定向复核的 32 项与主审集合重叠，不相加。
- 主审 `go test ./internal/api -run Lore -count=1 -v` 退出 0，包含新增 5 条守卫测试。生图测试使用 `handler_lore_image_test.go` 明确配置的本地 httptest 上游和 test-key，未调用真实模型。没有再次跑全仓测试、go vet 或构建，不沿用交付报告的 552 数量作为主审结果。
- 新的实际 Edge 桌面 1440×900 证据与本地负例集中在 `D:/Narraverse2.0/artifacts/book-library-phase1-review-20261006/revision2/`。页面 pageerror 0，虚构总览的二审标记已通过界面恢复并以 GET 确认不存在；没有改真实用户书籍/密钥。

## 仍须返修

### F1-a · P1：新建/删除的书籍校验与写入不是同一个事务

`denova-src/internal/app/lore_app_service.go:79-84`、`:130-134` 先以 `currentWorkspacePath()` 检查 A，随后调用旧 Create/Delete。这两个旧方法在 `:65-70`、`:116-121` 再读取当前 `bookState()`。`bookState()` 的 `:380-384` 只在取指针时持 RLock，检查结束就已释放。允许序列：**检查读取 A → 切书取得写锁改成 B → 旧 CRUD 重新读取 B → 写入/删除 B**。

这是明确源码竞态，顺序测试“当前 A、声明 B”返回 409 并不能覆盖检查期间切书。此次未人为增加调度钩子或修改业务代码来执行这一微小窗口，证据分类为源码确认。现有 `UpdateLoreItemForWorkspace:102-109` 已展示持锁校验和写入的做法。

最小修复：核验并固定同一个状态/目标 store，后续写入不能重新解释为另一当前书；优先沿用已有锁和 PATCH 边界。补相应并发/切书反例，不扩业务 schema。

### F1-b · P1：迟到的清图请求会清掉另一书同 ID 的 AI 图

客户端 `web/src/lib/api-client/lore.ts:79-88` 的生图/清图仍不携带 workspace；handler `internal/api/handlers/handler_lore.go:156-165`、`:203-207` 也没有解析目标书。清图服务 `internal/app/lore_app_service.go:167-172` 按请求被处理时的当前书读 store。前端发出前的 generation 检查与响应后的丢弃不能保护已发出的 HTTP 请求。

**本轮独立本地反例已复现，零模型调用**：t.TempDir 两册各建同 ID 且各挂 AI 图关联；A 发起清图所需 ID 已捕获，服务端切 B 后处理不带 workspace 的 DELETE。响应 200，**A 图仍在、B 图关联变 nil**。脚本通过表示“错误行为被复现”，不是产品验收通过。

证据 `revision2/late_image_clear_test.go`、`go-overlay.json`、`late-clear-log.txt`。Go overlay 将诊断测试虚拟加入 api 包，未新增或覆盖维护树业务/测试源码。生成接口也在 handler 到达后才固定当前书 snapshot（服务 `:281-338`），存在相同请求归属缺口；本轮没有发送真实或桩生图请求来复现该竞态，不能称两个接口都已动态复现。

最小修复：两个书籍写接口都接受并传递目标 workspace，在服务端核验并固定目标书后才读取条目/调用模型/写关联；不匹配拒绝且不触发模型。可以保留明确的 legacy 调用行为，但新工作台必须走守卫路径。若不做接口修复，则工作台暂时停用这两个危险动作，不能继续声称全链安全。

### F2 · P1：切书流程仍未保护工作台总览草稿

快速切工作台的修复成立，不代表顶部切书也受保护。`web/src/components/workbench/ModeRouter.tsx:301-304` 的 quickSwitchBook 只处理 composer settings，再转交 App；`web/src/App.tsx:388-407` 只 flush 普通编辑器 handler 后执行 switchWorkspace。新工作台的 overview.flush 没有注册到这个切书链，dirty 只在 LibraryWorkspaceRoute 内部使用。workspace 改变后 `use-book-library-overview.ts:103-113` 清空正文并重读，未保存草稿没有按书籍保留。

证据分类为源码确认；本轮桌面切书反例**未成功执行**：该隔离实例的顶栏菜单只列当前夹具，无法点击第二书架。脚本的定位超时不算产品缺陷，也不冒称跨书浏览器验证通过，见 `revision2/book-switch-results.json`。修复应把总览保存或明确放弃选择接到真正的切书前边界，保存失败不能切走；补顶栏实际链或组件集成反例。

## 已关闭与接受的行为

- **F3 关闭。** 桌面叙界活动栏“本书资料”进入工作台，关闭返回后同一个 iframe DOM 仍连接，`nova:mode` 仍为 narraverse；无故事生成或模型请求。
- **F2 切视图/失败部分通过。** 总览填入标记后立即点工作台，真实文件 POST 恰 1 次且带 workspace；返回仍有标记。单独注入文件 POST 500 后，仍停总览且文本保留。故障注入与无拦截正例分开记录，见 `revision2/browser-results.json`、`targeted-browser.cjs`。
- **切分区是明确丢弃选择，非静默丢失。** 实测确认后切作品设定库再返回，草稿丢弃、保存请求 0；确认文案明示“丢弃当前未保存的修改”。本审接受这一可选行为，不把它列为新的 P1，但交付“切分区前统一 flush”的表述不实，需要改为实际行为。关闭按钮也使用该丢弃文案，却实际保存，应顺带改为与操作一致的提示（P2）。
- 新建/删除顺序守卫、普通自动保存 workspace 第四参、前端代次检查已有有效补丁和测试；不要求回退这些改动。保留 SettingPanel 与第一期关系只读继续接受。

## 收口范围

只补 F1 的原子边界、AI 图接口归属，以及 F2 顶部切书保护；更新实际行为说明。F3 和已经通过的切页/失败路径无需再改。下一轮只验证上述剩余反例及匹配改动的定向检查，不重跑整仓或付费模型、不启动 R2—R5/手机适配。所有正式实例与用户运行数据保持，未提交、推送、部署。

---

# 历史：本书资料工作台第一期 · A 初审

时间：2026-10-06 17:48（Asia/Shanghai）。结论：**NEED REVISION**。

界面和复用方向成立，T1/T2/T5 存在必须返修的边界问题。不能把本期正式收口或据此展开 R2—R5；允许继续本期定向修复。此次只审查与验收，未修改业务源码、鉴权、模型配置或正式服务，未提交/推送。

## 基线与证据范围

- 任务书：`D:/Narraverse2.0/docs/交付/本书资料工作台-第一期实施任务书-2026-10-06.md`。
- 审查树：`D:/Narraverse2.0-platform-model`，`codex/platform-model-unification`，HEAD `95acac709bbb269e5612467712886022266160bd` 加当前脏改动与未跟踪源码。独立只读基线脚本已运行，既有改动保留。
- 实际浏览器目标：`http://127.0.0.1:8190/`，PID 75556；exe 为维护树 `artifacts/book-library-phase1-20261006/denova-book-library.exe`，前端为同目录 `web`，虚构数据为同目录 `run/.denova`，书籍在 `run/books/`。没有启停该进程。
- 8190 是实施者交付的隔离 Denova 实例，不是正式部署。18309 原型与正式实例没有改动。
- 主审重新构建前端到 `D:/Narraverse2.0/artifacts/book-library-phase1-review-20261006/web-fresh`，退出 0；8190 仍提供实施者 16:51 的构建。两份 index/chunk 文件名不同（存在并行改动），未替换原实例。新鲜源码检查与交付快照浏览器证据分别记录，不能声称当前全部共享文件已运行验收。

## 必须返修

### F1 · P1：书籍写入守卫缺失，等待保存后仍能删到另一书

直接复现：A 书有未保存条目，调用删除后等待 `flushPending()`；此时切到 B，A 的保存完成后仍继续执行 `deleteLoreItem('same-id')`。服务端 DeleteLoreItem 读取请求处理时的当前工作区；B 若有该 ID，会删除 B 的条目。UI 返回时再比书籍，不能撤回已执行的写入。

定位（均为维护树路径）：

- `denova-src/web/src/features/book-library/use-book-library-lore.ts:294-304`：flush 后无目标书/操作代次检查就发删除。
- `denova-src/web/src/lib/api-client/lore.ts:25-27`：DELETE 无 workspace 参数。
- `denova-src/internal/api/handlers/handler_lore.go:74-82` 与 `internal/app/lore_app_service.go:102-108`：按当前 workspace 删除，没有目标书校验。

同一写入边界还须补齐普通自动保存：`setting-panel/use-lore-item-autosave.ts:47` 使用 `save: updateLoreItem`，通用保存器只传 ID、payload、revision；`loreAutosavePayload` 没有注入 workspace。已有 PATCH 的第四参数/后端工作区校验实际没有在这条链使用。`scopeKey` 仅隔离前端队列，不能代替 HTTP 的目标书籍约束。交付映射表与“workspace 作为 CAS 守卫”的测试标题需同步纠正。

新建、AI 图片生成/清除也沿用无显式目标 workspace 的接口；上传/解除关联及层级批改已携带 workspace，二者不要混称全链安全。`isCurrentTarget` 仅比较 workspace 字符串与 item ID，图片 A₁→B→A₂ 后旧结果仍可能重新匹配；返回合并、busy 清理也应核对操作代次。

最小返修：异步每一步前核对发起时书籍/操作代次；普通保存和必要写接口传递目标 workspace，由服务端在写入边界拒绝不匹配请求。优先复用 PATCH 现有能力，补删除等必要的书籍守卫，不借此扩业务 schema。不能仅在响应后丢弃 UI，也不能只禁用一个删除按钮。冲突恢复重读不得把 B 的同 ID 内容合并到 A。

证据：Luna 的独立接口桩复现 1/1 通过（测试断言**错误行为仍发生**，不是产品通过）：
`D:/Narraverse2.0-platform-model/artifacts/book-library-phase1-review-20261006/luna/delete-scope-review.test.tsx`。
该测试没有向真实书籍发送删除。除删除继续执行的复现外，其余同类写入缺口由源码确认，未实写污染夹具或调用付费模型。

### F2 · P1：总览快速离开时静默丢失草稿

真实 Edge 在 8190 重现：进入书籍总览→编辑→末尾输入标记→立即点击工作台→等待 2.2 秒→再打开总览。标记已丢失，内容恢复原文；全过程文件保存 POST **0 次**、离开确认 **0 次**。

定位：`BookLibraryWorkspace.tsx:88-90` 只上报 `lore.dirty`；`:113-117` 的 goto 直接切视图；总览按 view 条件卸载。`views/OverviewView.tsx:31-47` 的文件自动保存和草稿只在该视图内，未加入工作台 dirty/pending/离开流程。分区/退出保护同样不能保护总览。仅增加等待时间不是修复。

最小返修：把总览草稿与 pending/error 纳入统一工作台保护；切视图、切分区、关闭、切书前 flush 或保留可恢复草稿。保存失败应留在编辑态/保留草稿，不得无条件退出。修复后验证快速切页及保存失败两个场景，不需要付费模型。

证据：`D:/Narraverse2.0/artifacts/book-library-phase1-review-20261006/overview-fast-switch.cjs`、`overview-fast-switch.json`、`overview-lost-draft.png`。夹具原文保持原样，未写入标记。

### F3 · P2：叙界快捷入口尚未接入统一工作台

写作/游戏新活动项已实测可进入并返回，但叙界 `narraverseActivityItems` 只有旧 `lore`，仍打开 SettingPanel。

定位：`denova-src/web/src/components/workbench/WorkbenchShell.tsx:444-451`。8190 桌面叙界活动栏实测“本书资料”按钮 0 个、旧“资料库”按钮 1 个。这不满足 T5 的三种模式统一快捷入口要求；不是缺一张截图。

最小返修：叙界增加同一 `openBookLibrary` 入口，返回保持叙界/会话状态。旧 SettingPanel 工具入口可保留，不删除其附带能力，不改模型网关或开局行为。

证据：`narraverse-entry.json`、`narraverse-entry.png`；未生成故事、未发送模型请求。

## 本轮已验证

| 项目 | 本轮结果与限度 |
| --- | --- |
| 定向 Vitest | book-library + LibraryWorkspaceRoute + WorkbenchShell.bookLibrary：5 文件、39/39。没有以实施者的 135/385/160 数量作为本次结果。 |
| 类型/翻译 | tsc --noEmit 退出 0；4457 键 zh/en 对齐。 |
| 隔离前端构建 | 当前源码 Vite build 退出 0；大 chunk 警告，未覆盖正式 dist。未改 Go，未重复无关 Go 全量构建。 |
| 真实 Edge 桌面 | 6 组正常链检查通过：写作入口返回、2/25/3 分组及25位三页不重不漏、图谱抽屉关闭保留 canvas/焦点、游戏入口返回、1366/1440/1920 浅色桌面无工作台横向溢出、英文页面无原始翻译 key。pageerror 0。 |
| 数据/界面 | 分组和图谱来自 8190 真实 Lore API，无接口拦截；截图/路径状态留存。此前改正文/上传/移除链属于实施者报告，主审本轮未再上传或删图。 |
| 反例 | 删除异步切书为接口桩反例；总览丢草稿为真实浏览器反例；叙界入口缺失为真实浏览器+源码证据。 |

截图与脱敏接口路径/状态：`D:/Narraverse2.0/artifacts/book-library-phase1-review-20261006/desktop-results.json`、`01-home-dark-1440.png`、`02-people-unclassified.png`、`03-graph-dark.png`、`04-people-light-*.png`、`05-people-english-light.png`。

桌面脚本初次失败包括“故事/剧情”、英文活动项和主题自动保存等待的定位差异；修正脚本后 6 组正常链通过。不能把这些脚本定位失败算作产品缺陷，也不掩盖随后独立复现的草稿丢失。

## 接受的取舍与未验证

- **接受保留 SettingPanel。** CREATOR、开局预设、批量生图/翻译/导入等既有能力不能直接摘掉。新本书工作台与旧管理工具可以共存；F3 是补新入口，不要求删除旧工具。
- **接受第一期关系只读。** 保持既有 Agent 写入关系与当前显式关系数据源，复用 Canvas；本期不强加全新关系编辑器/HTTP schema。但本轮没有实测 Agent 改关系后新工作台刷新链，不能称关系写入已验。
- 模型未验证：总览 AI、生图未调用；无需为关闭 F1—F3 付费调用。正式用户鉴权、带实际游戏回合的返回、冷启动重启持久化、普通写入/图片 ABA 完整反例未验。
- 无 R2—R5、手机适配、用户资料迁移或部署授权。此次保持 8190、18309 与正式服务，未提交、推送、清理工作树。

## 给实施者的返修范围

只修 F1—F3；同一任务书/工作树继续，不重新规划、不扩大阶段。优先 F1 写入所有权与代次，其次 F2 总览草稿保护，最后 F3 叙界入口。为每项添加对应失败反例，修完定向测试/类型/i18n/隔离构建，再提供实际匹配修复源码的隔离实例和证据。既有脏修改继续保护；不得重启正式服务或用真实用户数据做破坏性测试。交 A 二审后再决定收口。
