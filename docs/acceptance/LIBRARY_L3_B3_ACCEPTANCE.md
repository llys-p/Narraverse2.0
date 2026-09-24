# 作品设定库 L3 B3 游戏链路验收（B3a 复审 + B3b + B3c + 竞态修复）

时间：2026-09-25 00:50。结论：**NEED REVISION**。代码对照冻结契约、测试门禁、B3c 真实模型闭环证据全部通过；但游戏链路 run ledger 与故事回合存档把 `read_library_item` 工具结果的库条目正文前缀持久化落盘，违反冻结契约 §8.5「ledger/display 只允许记条目 ID、revision、错误码等元数据，禁止正文」。附带两处测试/扫描覆盖缺口与一项超出范围的安全观察项。本轮只审查、不改代码、不提交、不推送。

## 1. 验收对象和环境

- 工作树 `D:\Narraverse2.0-b2a`，分支 `library-b2a`，HEAD `d8e7974`；B3 提交链 c337994 → f315adb → ada1076 → e6d5edf → c78ca14 → e5fa5a7 → d8e7974，全部本地未推送（基线核对 #17 通过：无 artifacts/密钥入库、无推送、未触碰主工作树与 8080）。
- 契约基准：`docs/plans/LIBRARY_L3_MODE_INTEGRATION_PLAN.md` §8/§8.5/§8.6/§8.8（已冻结，不得更改）。
- B3c 验收实例：`artifacts/library-b3c/denova-b3c.exe`（构建自 HEAD=`c78ca14`；`git diff c78ca14..HEAD` 对 chat.go/library_read_tool.go/run_ledger.go 为空 → exe 后端与当前 HEAD 同版）+ 独立运行目录 `artifacts/library-b3c/run-acceptance/`（端口 18084，已停服）。虚构故事「雾隐城异闻（验收虚构）」`st_dlnjo6npxil41ad1e1a4`、虚构库 `library-bgugewwifr6s837x`（resident 雾隐城永不日落 / auto 沈孤鸿 / manual 雾隐城禁巷）。
- 关键证据文件：`run-acceptance/.denova/projects/雾隐城异闻（验收虚构）/.denova/runs/run-20260924T143558…jsonl`、`run-20260924T143937…jsonl`（regenerate）、`interactive/story/story-st_dlnjo6npxil41ad1e1a4.jsonl`、`artifacts/library-b3c/leak-scan.txt`、`leak-scan24.txt`。

## 2. 通过项

- **B3a 后端**（c337994）：transport 校验（`background_source` snake_case + `library_context` camelCase、与 world 同现→400 `background_source_conflict`、越权键/空 ID/非法值→400）；bind-before-start、scopeKey 服务端派生（consumer=game，伪造→`consumer_not_trusted`）；regenerate 复用存储绑定不看请求；显式失败码映射（400/403/409/503/413）；状态事件脱敏（只发 state/libraryName/revisionLabel/selectedCount）；ephemeral-only 注入（只进当次 ModelInputMessages）；导演侧旧 Lore 排除。逐条对照 §8 通过。
- **B3a 审查修正**（ada1076）：regenerate 在原始运行 background 不可用时显式阻断（不再静默降级 legacy），集成测试覆盖。通过。
- **B3b 前端**（c78ca14）：内存一次性交接、每回合重发、与 world 互斥（launchedAt 决胜）、regenerate 不带库字段、切换故事/分支清除、状态栏 binding/active/none + 清除按钮、stale 引导。代码与记录一致；83 个受影响测试通过。
- **竞态修复**（e5fa5a7）：失效分支要求 `storyId` 非空，保住挂载瞬时空故事的 pending 交接；red-first 测试 53/53 通过。
- **B3c 真实闭环**：库文件 SHA 与 revision 全程一致（只读确认）；真实模型取材、regenerate、切分支、来源故障、reconnect 证据齐全；库正文经工具循环送达模型（当次模型输入），SSE 首帧前状态事件正常。
- **门禁**（本轮重跑）：`go build`、`go vet`（agent/prompts/handlers/agentui/app/libraryruntime 六包）、libraryruntime/prompts/agentui/handlers 全包测试、agent/app 定向测试全部通过；B3b 相关 Vitest 套件与 `tsc --noEmit` 通过。

## 3. 发现缺陷（NEED REVISION 依据）

**D1（契约违规，P1）：read_library_item 工具结果把库条目正文前缀持久化进 run ledger 与故事回合存档。** 证据：

- run ledger：`run-20260924T143558`（第 15 行）与 `run-20260924T143937`（第 10 行）的 tool_result 事件，`name=read_library_item`，`library_read={"bytes":659}`（只有 bytes、无 itemId/name → 脱敏成功分支未命中），`content.preview="[library-item-read] {\"itemId\":\"沈孤鸿\",...,\"content\":\"B3C-MARK-AUTO-02 正文:沈孤鸿是雾隐城唯一的巡雾人,他的..."`（220 字节/160 字符正文前缀落盘，两次运行 hash 相同 sha256:acf63b5b7ef1eaf3，确定性泄漏）。
- 故事存档：`story-st_dlnjo6npxil41ad1e1a4.jsonl` 第 3、4 回合 `display_events[1]`（role=tool_call，606 字节）含同一 `[library-item-read] {…正文前缀}`。
- 违反 §8.5；该正文前缀是运行时事件副本（工具结果通知），不是模型输出。

**机制**（已闭环定位）：chat.go:548-585 把 `drainContent` 得到的 659 字节原始工具消息内容交给 `libraryReadToolEventData`（唯一脱敏点）。成功分支要求内容整体能 `json.Unmarshal` 进 `libraryItemViewMeta` 且 itemId 非空；运行时内容 659 字节、超过该条目视图 JSON 体量（正文仅 97 字符），形态含平台侧附加数据（完整内容未存档，包装层形状无法从留存证据重构），解析失败 → 落入回退分支。回退分支不 fail-closed：截断 200 字符后未命中稳定错误码，`strings.Cut(trimmed, ": ")` 因紧凑 JSON 无 `": "` 未找到分隔符 → `!found` 分支把前 200 字符原样回显，其中含条目正文开头。该回退家族（含 `found` 分支）在解析失败时都可能回显原始内容。模型侧不受影响（正文仍经 runner 内部工具循环送达）；SSE wire、display 存档、run ledger 共用该事件，三处同受污染。

**修复方向**（供修复轮，本轮未实施）：`libraryReadToolEventData` 回退分支改为 fail-closed——解析失败一律只输出固定 notice（如 `[library-item-read] unparsable`）与 `{errorCode, bytes}` 元数据，绝不回显原文；并补该函数单测覆盖「内容含包装/附加数据」「内容超 200 字节」「JSON 值形态」三类输入。共享同一脱敏点的写作链路（B2）存在同源潜在缺陷，单测可一并守护。另可考虑由运行时把结构化结果元数据（ReadResult 的 ItemID/Name）带出事件，避免依赖文本重解析——属加固项，不强制。

## 4. 测试与扫描覆盖缺口（修复轮一并补齐）

- **G1**：`internal/app/library_game_integration_test.go` 无任何 run ledger / tool_result 断言（grep 证实），§8.5 的 ledger 边界在 B3a 测试未覆盖。
- **G2**：B3c 泄漏扫描（`leak-scan.txt`/`leak-scan24.txt`）以「库正文 16/24 字连续 CJK n-gram」为口径，对 auto 条目沈孤鸿结构性失明——该条目正文 CJK 连续段最长 13 字，n-gram 集合为空；且被泄漏的 160 字符截断前缀最长 CJK 段同样 <16 字，双盲。直接 grep 正文标记串（`B3C-MARK`）即可命中 3 个文件（2 个 run ledger + 1 个 story jsonl），扫描未做逐条目「n-gram 集合非空」自检、未覆盖 run ledger 的 tool_result 事件、未做逐字标记串兜底扫描。
- **G3**：B3c 完成记录（清单 B3c 条目）中「Turn/Session/冒险数据无设定正文副本」「run ledger 0 命中」的表述与上述证据不符，需更正为「run ledger 与 turn display_events 的 tool_result 事件存在 ≤200 字节正文前缀副本，其余字段（narrative/state_delta/turn_result/导演文件/usage/schema/服务日志/旧 lore 存储）确为 0 命中」。

## 5. 超出范围观察项（不构成本轮结论依据）

**O1**：`demos/laya-live/_probe_llm.mjs` 存在硬编码模型密钥（由 Laya 团队提交 cd530ec 引入，非 B3 提交链；该文件当前仍存在于工作树）。建议 Laya 团队轮换该密钥并清理仓库历史。未经指示未做任何修改。B3 提交链自身的密钥扫描无命中。

## 6. 门禁结果汇总

| 门禁 | 结果 |
| --- | --- |
| 提交链/工作树/未推送/无 artifacts 与密钥入库（基线核对） | 通过 |
| `go build` / `go vet`（六包） | 通过 |
| libraryruntime/prompts/agentui/handlers 全包 + agent/app 定向测试 | 通过 |
| B3b 前端套件（83 项）+ `tsc --noEmit` | 通过 |
| B3c 证据面：库 SHA/revision 一致、故事与 run ledger 之外无正文副本 | 通过（run ledger 与 turn display_events 的 tool_result 事件除外，见 D1） |

未通过项仅 D1 证据面；无其他未解决 P0/P1。

## 7. 结论

**NEED REVISION**。修复范围小且明确：单函数 fail-closed（D1）+ `libraryReadToolEventData` 单测三类输入 + library_game_integration_test.go 补 ledger 断言（G1）+ 泄漏扫描口径修正与 run ledger 覆盖（G2）+ B3c 完成记录更正（G3）。修复完成后需：重跑受影响 Go/Vitest 门禁，并在隔离实例重放一次库按需读取，复验 run ledger 与 display 存档的 tool_result 事件只含元数据。B4a/B4b/B5 依用户指令仍待 B3 审查通过后进行。本验收文档与协作日志更新未提交、未推送。

## 8. 修复轮补记（2026-09-25，提交 `0e46907`）

D1 已修复：`libraryReadToolEventData` 全分支 fail-closed（固定提示/字节数/白名单错误码，绝不回显原文、截断前缀或码后消息），成功分支改宽松解码（首个 JSON 值的白名单字段），真实链路平台尾随数据下条目元数据（itemId/name 等）恢复落账。回归：fail-closed 单测矩阵 12 子例（合法/包装前缀/尾随数据/超长/畸形/非对象 JSON/含冒号与稳定码原文）+ 游戏集成 `TestLibraryGameReadToolKeepsBodyOutOfPersistedChannels`（确定性假模型强制触发一次按需读取：模型侧确收全文；四条目唯一非空 ASCII 标记直扫 run ledger/故事存档/Session 0 命中；库文件逐字节与 revision 不变；regenerate 复用原绑定；扫描自检防假绿——标记非空唯一、必备文件缺失即失败、源文件必须命中全部标记、故事存档必须含脱敏 notice）。验证：agent 定向 7 例+12 子例、app 定向 6 例、libraryruntime 17 例全过；全包 agent 283 过/1 失败、app 244 过/1 失败（两处失败均为既有 Windows symlink 环境失败，干净树收起本轮改动复跑同样失败）；`go vet` 六包、`go build ./cmd/denova`、`git diff --check` 通过。G1/G2/G3 随修复落地（G2 的 run ledger 覆盖在集成测试内以真实落盘文件完成，非 n-gram；G3 在清单 B3c 条目以追加更正形式落地，原文保留）。旧失败证据保留在 `artifacts/library-b3c/`；新证据（红测与全部分析日志）在 `artifacts/library-b3-fix/`，均不入 Git。**仍未验证：正式 executable 重放（真实模型页面复验）——本轮以确定性假模型覆盖同一持久化链，未消耗付费模型额度，该验收缺口保留。**
