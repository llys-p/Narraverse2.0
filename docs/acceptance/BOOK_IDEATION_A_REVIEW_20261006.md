# 新建书籍构思 · 阶段 A 定向复审

当前状态（2026-10-06，用户更正）：**ENTRY_REMOVED，仅移除书架「和 AI 一起构思」入口**。上一轮把范围扩大为整个功能撤销，现纠正为保留草稿 API、客户端导出、底层实现与测试。已有模块三/四模型网关和资料接入不改，普通新建书籍保留。此前阶段 A 的工程 PASS 记录保留，书架不再提供这一构思向导入口；已有书籍与草稿数据不清理。

本次范围纠正及上一轮撤销的证据均在 `artifacts/book-ideation-cancel-20261006/`；上一轮源码副本仍保留。下面 12:49 的 404/排除构建记录是纠正前的历史状态，不能作为当前 API 状态。阶段 B 的读取重构未实施，本轮只保留现有接入，不自动推进 B。

范围纠正验证（2026-10-06 12:57 Asia/Shanghai）：15 个 Go 文件移除归档构建标签，11 条草稿路由及 `CreateBookDetached` 恢复；17 个后端恢复文件与撤销前副本内容一致。前端客户端导出、翻译注册和历史测试恢复，Home 仍无构思入口。bookideation 全包与构思/角色卡导入/总览定向 API 测试通过，Home 与构思组件 17/17、tsc、i18n 4369、隔离前后端构建通过；模型注入、Module4 消费与消费者隔离 3 条定向测试通过。8177 当前 PID 61888，GET 草稿 API 恢复 200；真实 Edge 入口仍为 0，普通建书对话框可打开，无 pageerror。9 个网关/宿主/前端接入文件与纠正前哈希一致，11 个草稿/资料内容文件与原基线哈希一致。数据目录和 Kate 工作区保留，无模型付费调用，未重跑完整游戏会话链。

纠正证据：`scope-correction-verification.json`、`backend-restored-comparison.json`、`entry-only-page.json` 及 `entry-only-*.png`，独立构建为 `denova-entry-only.exe` 与 `web-entry-only/`。只重启8177隔离预览，不替换正式dist或其它服务。

上一轮范围过大的历史验证（2026-10-06 12:49 Asia/Shanghai，已被上方纠正）：普通建书/角色卡导入、总览、封面与导出定向 API 测试通过；Home 10 条与 i18n 5 条通过，tsc、4368 键检查及隔离 Vite/Go 构建通过，旧功能测试 7 条明确跳过。当时8177更换隔离预览进程（PID 2636），保留原独立数据目录和 Kate 工作区；GET/POST 草稿 API 均 404，书目与状态 API 均 200。真实 Edge 桌面浏览器从撤销前 1 个入口变为 0 个，普通新建书籍对话框可打开，无 pageerror；只检查打开对话框，未创建书籍。

4 份草稿及资料内容等 11 个受保护文件 SHA-256 不变；隔离 `books.json` 的哈希变化与重启时既有 `registry.Touch` 写最近打开时间相符，当前工作区仍为 Kate，当前书目 4 本。基线只保存哈希，未保存注册表原文，因此不宣称逐字段差异已经核对。其它服务和正式前端 dist 未替换，无付费模型调用、提交或推送。

复审日期：2026-10-06（Asia/Shanghai）；主审 Codex，前端复核 GPT-6-Luna。目标与实际 HEAD 均为 `95acac709bbb269e5612467712886022266160bd`，分支 `codex/platform-model-unification`，工作树 `D:/Narraverse2.0-platform-model`。审查对象包含此 HEAD 之上的阶段 A 未提交文件，不是只审该提交。既有其它任务脏改动保留。

## 0. 2026-10-06 修复与收口复验（Asia/Shanghai）

用户授权主审直接开子代理修复。Luna 仅修改 `denova-src/internal/bookideation/validate.go` 与 `review_fixes_test.go`；主审独立核对修前副本差异、复跑隔离反例/API，再统一更新此报告、双语 CHANGELOG 与两棵树协作日志。分支、HEAD、其它任务未提交内容保持既有归属。

### 最终修复

- ScopeItems 同时检查请求白名单与原包存在性；未知 ref 即使被请求也不新增，写明未采用原因。
- 从原包建立 lockedRefs，人工编辑/排除依据原 ref 保护；模型改名不能取消 Excluded 或 EditedByUser，也不能覆盖对应内容。
- 正常允许的局部重写仍沿原 ref 原位替换，保留其余条目、顺序、总览、关系与原文保留选择。
- 新增两条仓内回归，其中锁定测试分别覆盖已排除与人工编辑：先 RED 复现，后 GREEN。仅修这两个条件，没有前端改动或无关重构。

### 收口证据

| 检查 | 实际结果 |
| --- | --- |
| Luna 新回归 RED → GREEN | 未修时失败，修后两条及锁定的两个子例通过 |
| Luna `go test ./internal/bookideation -count=1 -v` | 24/24 顶层测试通过，3.663s |
| 主审合并三轮 overlay，`-run TestReview -count=1 -v` | 7/7 通过，包括原四条、round2 一条、round3 两条 |
| 主审 `go test ./internal/api -run TestBookIdeation -count=1 -v` | 2/2 通过 |
| 主审只读修前副本 overlay 对照 | 修正基线后的 round3 两条在修前代码仍失败，退出 1；相同断言在修后通过 |
| 格式与差异 | 两个 Go 文件 gofmt 无输出，与修前副本对比无新增空白错误 |
| 前端/构建/浏览器/真实模型 | 本轮未重跑；保留此前分层记录，未把固定上游算成真实模型 |

主审首次复验遇到隔离测试的比较方式问题：UpdateCandidates 即时返回的空切片经 JSON omitempty 持久化读取后变成 nil，DeepEqual 因此把业务内容相同误判为变化。仅将 round3 隔离测试基线改为先读取实际持久化记录，完整结构比较不变；原版本与首次失败日志保留，另用修前 validate.go 副本 overlay 确认两个真实缺陷仍能被该断言检出。没有为了过测试修改生产序列化或放宽内容/排除检查。

证据集中在 `artifacts/book-ideation-review-20261006/luna-fix/`：`red-targeted.log`、`green-targeted.log`、`green-full-package.log`、`root-overlay-final-normalized.log`、`root-overlay-pre-fix-red.log`、`root-api-final.log` 以及修前副本。`overlay-final.json` 合并三轮反例；`overlay-pre-fix.json` 仅替换测试构建的 validate.go，没有回退或覆盖工作树。

结论：F1—F4 工程阻断已关闭，阶段 A 可结束本轮返修。真实模型复验、素材库直选/PNG 是明示的待办；阶段 B 尚未实施。没有提交、推送、部署、启停服务、读取密钥或写入真实书籍。

## 0.1. 2026-10-06 三审（历史，最新结论见第 0 节）

目录、分支与 HEAD 已重核，仍为上方正式维护树及 `95acac7` 基准之上的未提交内容。本轮仅审 `assembleItems` 的 ref 白名单、原位替换与既有锁定约定，不新增功能或重演其它模块。

### 已通过的定向检查

- Luna 实跑二审 `TestReviewRound2` overlay：1/1 通过；原四条 `TestReview` overlay：4/4 通过。
- `internal/bookideation` 全包 22/22 通过（当前实际测试数）；`internal/api -run TestBookIdeation` 两条通过。日志在 `artifacts/book-ideation-review-20261006/round3/`，四组退出码均为 0。
- 源码及仓内 `TestScopedItemsRewriteIsARefWhitelist` 确认正常已存在目标的原位替换、未申请 c2/c99 的过滤与提示；按用户明示，旧“局部重写可追加”断言调整为不可追加。
- 主审核对 `verification.json` 的 `round_3_ref_whitelist`，其中浏览器采用本机桩，真实模型仍未验；本轮主审没有重演浏览器、重跑前端或构建。前轮主审前端结果与作者本轮结果分别保留，不能冒充本轮新测。
- 相关 tracked diff 空白检查通过；新目录主要为未跟踪文件，不能把该检查当作全仓审查。

### F1 剩余条件一 · P1：模型改名可撤销用户排除

位置：`denova-src/internal/bookideation/validate.go:290`、`:295`、`:338`；前端 `CandidateEditor.tsx` 的单条重写按钮允许对已排除条目执行。

已排除的 c3 先保留在 kept/byRef，但锁定判断只按模型返回的名称查 lockedNames。用户点击该条的局部重写，模型返回同 ref、新名称时绕过名称锁；后面的原位替换直接采用新 CandidateItem，其 `Excluded` 默认为 false。隔离反例得到 `Excluded:true → false`，正文同时被替换，因此之后确认可能写入用户明确排除的资料。

最小修复：局部重写命中 ref 后先读原条目，依据原条目的 `EditedByUser`/`Excluded` 执行已有保护约定。不能用模型名称决定是否受保护，更不能因重新构造结构而取消用户排除。无需改 UI 或增加流程。

### F1 剩余条件二 · P2：申请未知 ref 仍被当作新增

位置：`denova-src/internal/bookideation/validate.go:284`—`:299`、`:344`；`generate.go:98` 只检查 refs 非空，没有检查是否在当前包存在。

当前 guard 仅检查模型 ref 是否属于请求 refs。请求 `scope=items, refs=[c99]` 且原包无 c99，模型同样返回 c99 时会通过 guard，byRef 未命中使 rewriting=false，最终走 append。隔离反例确认候选 **3→4**。这不是有效页面点击的正常 ref，而是服务端宣称“本次申请且原包存在”的第二个条件尚未执行。

最小修复：ScopeItems 必须同时满足“请求包含 ref”与“原包存在 ref”，不满足时明确拒绝或忽略并提示。不可保留新增分支。按原 ref 原位替换，保留其余条目及顺序。

### 两条反例与下一次复核范围

主审新增隔离文件 `artifacts/book-ideation-review-20261006/scope_items_round3_test.go`，通过 `overlay-round3.json` 注入测试。两条均实跑失败，输出 `scope-items-round3-result.txt`。仅使用 Go 临时数据与固定模型，未修改业务源码或真实书籍。

在 denova-src 运行：

```powershell
go test -overlay ../artifacts/book-ideation-review-20261006/overlay-round3.json ./internal/bookideation -run TestReviewRound3 -count=1 -v
```

给执行 AI：只补上述两个判断，把这两条落成仓内回归；修后复跑 round3、round2、原四反例与 bookideation 正常包。除非另有实际改动，不必重跑前端/全构建/完整浏览器，也不增加真实模型调用、素材导入或 B 的要求。仍未提交、未推送、未部署；服务、真实资料与其它任务改动保持原样。

## 0.2. 2026-10-06 二审（历史，最新结论见第 0 节）

目标目录、分支、HEAD 与首审一致；验收对象为该 HEAD 上阶段 A 返修后的未提交内容。本轮只针对 F1—F4 及一句话输入修复，不扩展其它模块。

### 原缺陷关闭情况

| 项目 | 本轮结论 |
| --- | --- |
| F1 总览/关系/原文选择越界 | 原反例通过；字段类别隔离生效，但同属条目的 ID 白名单仍有缺口，见下 |
| F2 关闭即放弃 | 源码已分 closeDialog/giveUp，普通关闭不 abandon；恢复临时失败保留指针 |
| F3 重试与阶段快照 | 后端原失败后新增关系反例通过；未落目录重建阶段并 CAS，已落目录固定续跑；前端已跳过冻结 PATCH/PUT 并同步 revisionRef |
| F4 来源 ID 复用 | 原反例通过；NextSourceIndex 单调分配，移除来源使旧引用失效并提示 |
| 一句话输入回弹 | 本地 idea 驱动输入，已修改；Luna 相关组件回归通过 |

### 唯一剩余必修：F1 · P1 · 只重写 c1 仍可新增或改名 c2/c99

位置：`denova-src/internal/bookideation/validate.go:271`、`:285`、`:336`。

assemblePackage 限制了 scope 能改哪一类字段；assembleItems 没有排除 `refs` 之外的模型条目。现有按名称去重仅在模型保持同名时有效；模型给未选中的条目换名字，就绕过同名过滤并追加。未知 ref 也直接追加。

本轮隔离 Go 反例实跑：用户请求 `scope=items, refs=[c1]`，模型返回 c1、改名的 c2、陌生 c99。生成成功，候选数 **3→5**，采用 `OUT_OF_SCOPE_CHANGE` 与 `UNREQUESTED_NEW_ITEM`，并产生 **两个 c2**。重复身份会进一步影响预览编辑、关系引用与确定性落盘 ID。

最小修复：在条目局部重写时，只允许替换本次申请且原包存在的 ref；范围外/未知 ref 忽略或明确拒绝，并保持候选 ID 唯一。对允许重写的条目沿用原 ref，其它条目原样保留。不能依赖模型提示词或名称去重。保留已有人工编辑/排除保护约定，不为此扩展导入或自动召回。

复现文件：`artifacts/book-ideation-review-20261006/scope_items_round2_test.go`。运行（denova-src）：

```powershell
go test -overlay ../artifacts/book-ideation-review-20261006/overlay-round2.json ./internal/bookideation -run TestReviewRound2 -count=1 -v
```

结果：`artifacts/book-ideation-review-20261006/scope-items-round2-result.txt`。使用 Go 临时目录和固定模型，无付费调用、无业务源码修改。

### 本轮主审证据

- 原 overlay 四反例：4/4 通过，日志 `backend-counterexamples-round2.txt`。
- `go test ./internal/bookideation -count=1` 通过；`go test ./internal/api -run TestBookIdeation -count=1` 两条路由测试通过，日志 `api-round2.jsonl`。不重跑全包 symlink 用例，不声称全仓通过。
- `tsc --noEmit` 通过；i18n 4369 键对齐；相关 tracked diff 空白检查通过。
- Luna 前端二审：BookIdeationDialog 7 + HomeView 10，共17/17通过；一句话用例有React act()警告，未影响断言。指定前端修复未发现高置信残留。额外partial commit组件反例因隔离配置无法解析msw/node未运行；该路径依据源码核对，不冒充实跑。
- 作者返修浏览器 evidence 文件已核对，SHA 已修正、明确零真实模型调用；本轮主审未重演完整浏览器，也未重跑 Vite。原四反例通过不覆盖本轮新增的同一 F1 条目 ID 边界。
- 素材库直选/PNG、真实模型、B 仍为已明示的未完成范围，不追加到本轮返修卡。

只修上述一处条目 ID 范围限制，固化该反例，再跑原四反例及相关包，即可申请收口。未提交、未推送、未部署，运行服务与真实书籍未启停/写入。

## 1. 首审必须返修（历史，关闭状态见第 0 节）

### F1 · P1：局部生成会改动范围外内容，并丢失未保存的人工编辑

位置：`denova-src/internal/bookideation/validate.go:197`、`:218`，`generate.go:323`；前端 `BookIdeationDialog.tsx:180`、`:94`。

隔离 Go 反例已复现：

- 只重写 c1，原人工总览 `USER_EDITED_OVERVIEW` 被模型的 `UNREQUESTED_OVERVIEW` 覆盖；原关系由 1 条变成 0 条。
- 同一次条目重写把已清空的原文保留选择重新选上 8 条。
- 只重写关系，模型返回的条目正文仍被采用，出现 `UNREQUESTED_ITEM_CHANGE`。

原因：scope 没有形成服务端写入白名单。relation 分支复制原条目后继续经过 assembleItems；items 分支没有强制保留总览和关系，buildPackage 又恢复默认来源选择。

前端另有同一保护缺口：编辑仅更新本地 draft，generate 不先保存；成功后 adopt 整份服务端草稿。即使编辑发生在点击生成之前，也可能被旧服务端内容覆盖；生成期间编辑控件仍可用，晚到回复同样覆盖本地新编辑。此项为源码确认，不能拿服务端 CAS 测试冒充前端未保存编辑已受保护。

修复要求：服务端按 scope 只替换允许字段；保留其它正文、关系和来源选择。前端生成前保存已有编辑，生成期间禁编辑或用本地编辑版本合并/拒收旧回复。补单条重写、关系重写与未保存编辑三个定向反例，不只改提示词。

### F2 · P1：正常关闭窗口会放弃草稿

位置：`BookIdeationDialog.tsx:254`、`:286`。

Dialog 的所有关闭事件都执行 giveUp，调用 abandon 后清除本地草稿 ID。Escape、外部点击和关闭按钮因此等同于主动放弃；后端 abandoned 草稿不能继续生成。文件仍存在不等于用户可恢复。

修复要求：普通关闭保留可恢复草稿；明确“放弃”才调用 abandon。恢复接口暂时失败也不应直接清除唯一草稿指针。无需为此扩展成复杂草稿管理器，保证单份当前草稿可以可靠恢复即可。

### F3 · P1：部分提交的前端重试被拦截，失败前的阶段快照又可能漏写后续确认内容

位置：`BookIdeationDialog.tsx:202`、`:235`，`service.go:118`；`commit.go:94`、`:110`、`:180`。

前端：每次点击创建/继续，先 PATCH 书名再 PUT 候选包。一旦上次已生成 workspace，后端 UpdateDraft 会返回冻结错误，因此请求到不了 commit 续跑。commit_incomplete 分支还只更新 revision state，遗漏 revisionRef，未建目录时重试也会额外触发旧 revision 冲突。

后端隔离反例已复现：首次候选无关系，创建因同名冲突失败，此时 relations 阶段已标 done；用户补上关系后再次确认，旧 StageDone 使该阶段被跳过，回执仍为 complete，实际关系数为 0。条目原先为空再增加也需同类保护。

修复要求：工作区已创建时直接续跑固定提交，不再编辑冻结草稿；统一更新 revision 与 revisionRef。工作区尚未创建、草稿仍可编辑时，用本次确认版本重新建立待提交阶段，严格检查确认 revision。只有实际采用内容完成才报告 complete。

### F4 · P2：删除再添加素材会复用来源 ID，导致旧引用串到新素材

位置：`service.go:224`、`:267`、`:286`。

nextIDSuffix 只看当前剩余来源。移除最后一份 s0 再添加新素材会重新得到 s0，旧候选保留的 s0-e0 引用随即指向新内容。

隔离反例：雾港灯塔候选生成后，删除雾港来源、加入沙漠来源，旧灯塔候选的 provenance 被解析成“沙漠王国”。这不是显示名称问题，而是引用身份改变。

修复要求：来源 ID 在草稿生命周期内不复用；删除素材时将其引用标失效/要求重新确认，不能静默映射。已有候选的来源版本变化需要明确提示。

## 2. 证据与已验证范围

| 检查 | 本轮结果 |
| --- | --- |
| 原有 `go test ./internal/bookideation -count=1` | 通过 |
| `internal/api` 全包 | 失败项为 `TestWorkspaceSwitchCanonicalizesSymlinkIdentity`：Windows 创建 symlink 缺权限，不能标全包通过 |
| 阶段 A 两条真实路由测试 | `TestBookIdeationRoutesCreateBookOnlyOnConfirm`、`TestBookIdeationRoutesRejectStaleAndUnknown` 均通过 |
| 主审新增隔离 Go 反例 | 4/4 按预期失败，钉住 F1、F3 后端、F4 |
| Luna 现有组件测试 | Home 10 + BookIdeationDialog 4，共 14/14 通过；原测试未覆盖上述失败路径 |
| Luna 新增前端反例 | 文件已保留，但位于 web 根目录外，Vitest 报 No test files / /@fs ERR_MODULE_NOT_FOUND，未成功执行；F2 与 F3 前端依据源码及后端契约确认，不冒充测试复现 |
| TypeScript | `tsc --noEmit` 通过 |
| 运行实例点检 | 复审初段核实 8177/PID 66132，`/api/status` HTTP 200；18310/PID 70672 为 Node 桩。没有启停这些进程 |
| 作者真实浏览器链 | 作为历史证据读取 `artifacts/book-ideation-20261006/verification.json`，本轮未重演完整真实浏览器流程 |
| 真实模型 | 未验证，零付费调用；不是本轮已通过的第三层 |

隔离实例可执行文件：`artifacts/book-ideation-20261006/run/denova-ideation.exe`；作者隔离数据：`artifacts/book-ideation-20261006/data`。主审反例仅使用 Go 临时目录；未写入作者隔离书籍或用户真实资料。

主审反例文件：`artifacts/book-ideation-review-20261006/review_regressions_test.go`，通过 `overlay.json` 注入测试包，不修改业务源码。结果在 `backend-counterexamples.txt`；API 完整事件在 `api-tests.jsonl`。运行方式（在 denova-src）：

Luna 草拟的前端复现位于 `artifacts/book-ideation-review-20261006-luna/frontend-repro.test.tsx`，尚需在项目允许的测试位置或隔离配置下运行。脚本断言用于观察缺陷行为，不能原样当作修复后回归通过标准。

```powershell
go test -overlay ../artifacts/book-ideation-review-20261006/overlay.json ./internal/bookideation -run TestReview -count=1 -v
```

## 3. 交付口径与范围补充

- 原报告不能写“三层验证全通过”：浏览器使用固定上游，真实模型明确未跑。本轮也没有重跑 Vite/i18n，不引用作者结果冒充本轮结果。
- verification.json 的 base_sha 为拼接错误值，应修正为本报告完整 SHA；executed_at_local 的两种时区时间互不对应，应从真实运行日志校正，不能猜补。
- 当前实现仅提供文本/JSON 上传或粘贴，素材库直选及 PNG 角色卡未完成。原方向强调保留添加设定书/角色卡体验；此限制应在交付中明确，不应称已无差别保留旧入口能力。本轮不要求为了复审再造完整素材平台，是否追加直选需单独明确范围。
- 构思想法输入框 `value={draft.idea ?? idea}` 却只 setIdea，已有 draft.idea 时输入会回弹；请随前端草稿编辑修复一起处理，并测试修改后保存/恢复。该项源码确认，未作为新的架构任务扩张。

## 4. 给执行 AI 的返修卡

继续在已确认归属的阶段 A 工作范围中，只修 F1—F4，并处理同一编辑链的想法输入回弹。保留其它 AI 改动、运行实例和真实资料，未授权不要提交/推送/部署，不进入 B，不改游戏模式或模块四。

先运行本报告反例确认失败，再修最小业务逻辑并将必要行为纳入仓内回归。补前端关闭再打开/刷新、未保存编辑后生成、建书部分成功后续跑；后端补局部生成范围、素材移除重加、失败后改变候选再提交。修后给出定向结果和一个隔离真实浏览器闭环；真实模型待授权时仍标待验。修正证据 SHA/时间和全包测试口径。

上述问题修完再申请阶段 A 二审；主审只复跑这些失败路径与相关正常路径，避免无限扩大验收。
