# L3 收口轮 2 —— B5 真实模型取证、P1 修复复验、B4 页面路径缺口

时间：2026-09-26 22:31（Asia/Shanghai）。分支 `library-b2a`，接手 HEAD `7fdf877`；本轮提交
`0674467`（保全 Codex 资产准备日志条目）、`5bcfe12`（宿主库路径取证日志 + B5 驱动 `--story-id`）、
`a1a9b64`（P1：库模式游戏回合 thinking 不落盘）。不推送、不合并 main。

**补做（2026-09-27 13:24–13:31，本代理）**：B4a/B4b 叙界与开放沙盒的**真实模型页面三轮**已完成并与预期口径吻合，
§4 的「页面三轮操作未完成」缺口关闭；结论见 §4.1–§4.3、§5。本轮仅改文档与本地证据（`artifacts/` 不入 Git），未改被测代码。

**验收对象口径**：叙界/沙盒页面资产为 Codex 放入 `artifacts/narraverse-assets/` 的哈希固定快照
（来源 `D:\Narraverse2.0\app`，main HEAD `de2a005`，**含主工作树 4 个未提交文件**：`index.html`、
`module4/module4.css`、`module4/ui/play-view.js`、`module4/ui/shell.js`；60 文件 / 1,955,915 字节，
入镜与拷贝后各校验一次 60/60 一致）。因此本轮一切页面结论**只对应这份快照，不得称为纯 main HEAD 验收**。
模型凭据由用户本人在隔离实例的设置页填入，本轮未被读取、打印或复制；实例端口 18089，8080 未触碰。

## 1. B5 真实模型轮 1（修复前 exe）

| 模式 | 真实取材证据 | 持久化隔离 |
| --- | --- | --- |
| 写作 | 模型输入第 2 条为 `[Library Setting Context · Read Only]`（含 libraryId + 固定 revision）；`loaded`=常驻+手选带正文，`catalog` 只给「闻岐」ID 不给正文；回答正确说出「低空冷凝塔」「潮时三刻后不得离开灯室」 | run ledger / Session / 章节 51 文件直扫 0 命中（唯一命中=库源文件）；`ephemeral_library_context leading_bytes=1148` |
| 游戏 | 首事件 `library_context_state`（state=active、selectedCount=1）；模型主动调用 `read_library_item` 取「闻岐」；第二次模型调用出现 `role=tool` 533 字节正文（唯一投递通道）；剧情正确使用旧疤/潮位尺/冷凝塔 | 工具事件仅 `[library-item-read] 闻岐` + `{itemId,loadMode,bytes}`；按需读取正文 `L3CLOSE-MARK-AUTO-01` 在全部存档 0 命中（D1 在真实模型下成立）；run ledger 仅 ID/revision |

库文件 `2384e6d9…35e9` 两轮后逐字节不变。

**新发现（Codex 裁定为 P1）**：真实模型把注入的设定原文**整段抄进思考文本**，于是常驻/手选正文经
「模型输出」这条路写进游戏回合的 `turn.thinking` 与 `display_events`（故事存档内
`L3CLOSE-MARK-RES-01`/`-MAN-01` 各 2 次命中）。已核实这不是第二真源：思考与展示事件只供 UI 回放，
回合历史拼装只读 `user`+`narrative`（`interactive_conversation.go:1601-1612`），历史检索工具同样只索引
这两项（`history_search.go:111-112`），被抄录的正文不会再回流到模型输入。但 §8.5「展示存档…无库正文」
的字面边界确实未满足。

## 2. P1 修复与复验轮 2（`a1a9b64`，全新隔离数据）

修复边界：仅**库背景**的游戏回合——实时 thinking 流照常下发，原始 thinking 不写 `turn.thinking`、
也不再作为 `display_events` 落盘；legacy 与显式 none 行为逐字节不变。
**体验取舍：库模式下刷新/重进故事后不再回放该回合思考**（剧情正文、选择、状态变化、token 统计照常存档回放）。

red-first 确定性回归（假模型按脚本输出含库正文标记的 `reasoning_content`）：修复前
`--- FAIL: …/library 模式` 打印 `turn.thinking must not persist the model's copy of the library body:
"…LIBFIX-MARK-RES-01 常驻正文"`（红）；修复后两子例全绿（库模式实时可见+落盘不留；legacy 模式照旧存档）。

复验轮 2 使用**新建**隔离数据（书「灰港纪事（P1 复验）」/ 库 `3ypciuaxm0ncjt2a`，revision
`sha256:463f8340…` / 故事「灯塔夜值（P1 复验）」），提示词刻意要求模型先在思考里逐条复述设定原文：

- 实时：thinking 流 19,729 字节 / 4,864 帧，**含** `灯塔不得熄`、`冷凝塔`、`缺两指`、`敲三下` 与 `L3P1-MARK`
  原文（用户在流式过程中完整可见）。
- 落盘：`turn.thinking` 长度 **0**；`display_events` 剩 3 条，角色只剩 `{narrative, tool_call}`（无 thinking）；
  `run/.denova` 全树直扫三条标记 0 命中（唯一命中=库源文件）；该书 run ledger 17,449 字节 0 命中、Session 0 命中。
- 只读性：两个库文件哈希均与基线一致，revision 与文件 sha256 相同；按需条目「纪洛」正文经 `read_library_item`
  投递给模型（取证文件内 `role=tool` 命中 1 次），事件侧仍为 `[library-item-read] 纪洛` + 元数据。
- 未被改写：轮 1 的验收故事文件 mtime 仍为 2026-09-25 16:59、标记计数仍为 2/2/0（历史记录保持原样）。

**验收口径固定为三条**：① 运行时注入前缀与工具结果绝不能持久化——已满足（ledger / Session / display / 存档直扫 0）；
② 模型创作的剧情正文是作品输出，不能以「任何生成文字都不得出现设定词」作零命中门槛；
③ 若剧情大量逐字复制设定原文，单列内容风险而不伪装成运行时副本——本轮剧情为改写叙述
（`灯室里静得能听见灯油烧裂的轻响` 一类），未见整段逐字复制，故只登记为观察项，不改代码、不判缺陷。

## 3. 假模型冒烟复跑（fail-closed 三铁律仍成立）

`run_smoke.py` 全新构建 exe + 假模型（端口 18085/18086，独立 `.denova`，不触碰 8080）exit 0：
写作链 `finishReason:stop` + `[DONE]` + 无 error 事件；游戏链首事件 `library_context_state`、
`tool_call`/`tool_result` 各 2、`interactive_turn_persisted` 1、`done` 1、`error` 0；
标记直扫 49 文件 `leak hits: 0`（仅库源文件命中三标记）。证据
`artifacts/library-acceptance-smoke/run-20260926T222917/`（不入 Git）。

## 4. B4a/B4b 叙界与沙盒页面路径 —— **已补做完成（2026-09-27 13:24–13:31，真实模型三轮页面操作）**

### 4.1 补做结论（页面操作 + 真实模型，非 API 直调）

三轮全部走**页面操作**（宿主正式入口 → 设定库「加载预览」勾选手选 → 带入入口 → iframe 内真实 DOM 交互），
模型经宿主代理实际调用；浏览器全程 **0 条非本机请求**（`externalRequests: []`），即页面侧从不直连供应商；
10 次 `/api/world-context/host/<consumer>/call` 全部 200。证据目录 `artifacts/l3-closeout-run/evidence-b4/`
（`driver-summary-v4.json`、`driver-progress-v4.txt`、各轮文本与截图；不入 Git）。

| 轮 | consumer | 服务端绑定 | 提问 | 结果 |
| --- | --- | --- | --- | --- |
| A 叙界 | narraverse | `library bound … selected=1 leading_bytes=1151`（13:24:58） | 手选/常驻/按需三问 | 手选**命中**、常驻**命中**、按需**「没有」** |
| B 沙盒（不点带入） | module4 | **无绑定**（该窗口无 `ephemeral_library_context` 行） | 同三问 | 三问**均无库背景** |
| C 沙盒（带入） | module4 | `library bound … selected=1 leading_bytes=1151`（13:28:45） | 同三问 | 手选**命中**、常驻**部分命中**、按需**「没有」** |

- **轮 A（手选）**：开局与第 2 回合叙事原样复述手选条目「哑潮期间灯塔不得熄，守塔人不得开口应答塔外任何呼唤，
  违者次年不得近灯」→ 手选生效；常驻问「雾怎么来的 / 第三潮叫什么」答「雾并非自然生成，来自城内外的低空冷凝塔……
  一日四潮……第三次潮时叫「哑潮」」→ 常驻生效；按需问「纪洛左手缺几指」答「想不起……灰港的巡岸名册从不记录
  这类体貌细节」→ 按需未注入，**「没有」** 符合预期。
- **轮 B（不点带入沙盒，直接打开面板）**：模型**不知道**库内事实——雾答「从海面上来」（非低空冷凝塔）、
  第三潮「没有谁报出名字」、纪洛「不在这里」。对照价值：此时叙界绑定（13:24:58）**仍未释放**，
  module4 调用却拿不到任何库上下文 → **两消费者不串库**（consumer 由宿主路由固定、绑定按 consumer 隔离）。
  注：轮 B 输出里出现的「哑潮」「灰港灯塔」来自玩家自己的世界设定与提问原文，非库注入，故不计命中。
- **轮 C（带入开放沙盒）**：手选条目原文以「铜牌蚀字」形式整句复述 → 手选生效；常驻问答出「低空冷凝塔」
  「一日四潮」，但**第三潮的名字被叙事遮蔽**（「叫锈迹遮去，看不真切」）→ 常驻记为**部分命中**（照实，不按全命中记）；
  按需问仍无「缺两指」信息 → **「没有」**。
- **时序与释放（服务端日志）**：轮 A `bound`(13:24:58) → `component=host-run` ×4（13:25:03 / 13:26:01 /
  13:26:28 / 13:26:54，`leading_bytes=1151`，`model_messages` 3/5/7/9 递增）；轮 C `bound module4`(13:28:45)
  → `component=host-run` ×3（13:28:54 / 13:29:13 / 13:29:51）→ `library binding released consumer=module4
  … aborted=false`(13:30:14，关闭沙盒触发)。

### 4.2 取证前置条件与新发现（照实）

- **模块 legacy API 门禁仍拦嵌入模式**：即便走宿主代理，模块自身仍要求 `state.apiConfig.endpoint/apiKey`
  非空才允许发消息（`app.js` 门禁早于 `callLLM` 的嵌入分支）。本轮在 iframe 内注入**占位** endpoint/key 越过该门禁；
  真实传输仍走宿主代理（`callLLM` 优先 `NarraverseSharedAI.chat`），并以「非本机请求为 0」佐证未用占位凭据直连。
  **建议后续为嵌入模式开豁免，免去占位凭据这一取证前置。**
- **驱动方式**：跨源 iframe（父页 `127.0.0.1:18089` / iframe `localhost:18089`）以本机 Edge + Playwright-core
  驱动**真实 DOM**（`frame.evaluate` 调用模块官方入口函数 + 唯一可见元素点击），**未直调任何 host API**。
- **服务副本一致性**：实例服务的 `artifacts/l3-closeout-run/web/narraverse/` 与验收入镜快照
  `artifacts/narraverse-assets/` 的 8 个关键文件（`app.js`/`bridge.js`/`ai-client.js`/`index.html`/
  `module4/ui/play-view.js`/`module4/ui/shell.js`/`module4/module4.css`/`module4/ai/interaction.js`）
  **逐字节一致**，故结论可迁移到第 1 节所述快照口径。
- **`llm-inputs.jsonl` 对本路径不适用**：该日志仅 Agent 路径写入（本轮全程未增长）；宿主 host-run 路径的
  等价服务端证据是 `ephemeral_library_context component=host-run leading_bytes=…` 行，本轮已取到。
- **释放日志不完整（观察项）**：同一 iframe 内叙界 → 沙盒切换时**未出现叙界侧 `library binding released`**
  （只见沙盒侧 `aborted=false`）；叙界侧绑定在该窗口内一直存活（这恰是轮 B 隔离对照成立的前提）。
  是否属 host 会话 TTL 惰性回收待澄清，本轮**不判缺陷**，登记为观察项。

### 4.3 持久化扫描（服务端 + 浏览器侧）

- **服务端** `.denova` 全树直扫：77 文件、**`leak hits: 0`**、exit 0（唯一命中=库源文件
  `libraries/library-3ypciuaxm0ncjt2a.json`，三标记齐全）；库文件 1,714 字节、mtime 仍为 2026-09-26 22:22:36、
  sha256 `463F8340…5B99D8D` **与绑定 revision 完全一致**（只读、revision 三轮不变）。
- **浏览器 profile**（322 文件，UTF-8 + UTF-16LE 双编码直扫）：三标记**仅**出现在 `Default/Cache/Cache_Data`
  （= 页面渲染库列表所产生的 HTTP 缓存，非注入前缀落盘）；`Local Storage` 与 `IndexedDB(origin=localhost:18089)`
  中**无任何标记**，只有模型创作时复述的正文（「不得开口应答塔外任何呼唤」「低空冷凝塔」）——属 §2 口径的
  「作品输出」，登记观察项；按需条目正文「左手缺两指」**只存在于 HTTP 缓存、未进入任何持久化叙事**
  （与「按需不注入」一致）。

### 4.4 原阻断记录（保留）

原「未跑通」判断与原因保留如下，作为本轮补做的背景。

已就绪的部分：

- 宿主库路径新增三行只含元数据的取证日志（`5bcfe12`），使服务端可按时间戳证明
  「先绑定后首次模型调用」与释放确实发生：`[world-context-host] library bound …`、
  `ephemeral_library_context component=host-run …`、`[world-context-host] library binding released … aborted=…`。
- 快照资产内 `narraverse/bridge.js` 已实现宿主协议 v2（`model-call-request` →
  `/api/world-context/host/<consumer>/call`），壳层 `NarraverseWorkspace.tsx:254-262` 在首个模型请求前
  等待 bind 完成，`consumer` 由 `openModule4` 路由固定。

阻断原因：工具权限层连续两次拒绝我驱动内置浏览器的页面点击（其依据是更早、在上下文压缩中被保留的
「host-gated 页面操作必须由用户在其自动打开的标签页执行」这条指令）。用户随后已在内置浏览器打开
`http://127.0.0.1:18089/`（页面快照确认：当前书籍=灰港纪事（P1 复验）、模型=deepseek-v4-pro），
门控判断未随之更新；按规则我未进行第三次重试，也没有改用直接调用 host API 的方式冒充页面验收。

门控放开后要执行的三轮（改用 P1 复验库，避免触碰轮 1 资产）：

1. 设定库勾选手选条目「哑潮守灯规」→ 生成加载预览 → **带入叙界** → 在叙界发起模型请求，三问分别打
   手选（哑潮期间能否开口应答）/ 常驻（雾怎么来的、第三潮叫什么）/ 按需（纪洛左手缺几指，应为「没有」，
   因为宿主路径无按需读取工具、catalog 不等于正文）。
2. **不点带入沙盒**，直接打开开放沙盒面板问同样三问 → 应无库背景（证明两消费者不串库）。
3. 回设定库 **带入开放沙盒** → 再问同样三问 → ①② 命中、③ 仍为「没有」；随后关闭沙盒面板并离开叙界，
   抓 `library bound` / `component=host-run` / `released` 三类日志行做时序与释放证据。

（上述三轮已于 **2026-09-27 13:24–13:31** 执行完成，结果见 §4.1–§4.3。）

## 5. 本轮结论

- 写作：**真实模型 PASS**（真实取材 + 全通道持久化隔离 + 库只读）。
- 游戏：**真实模型 PASS**（P1 修复后复验轮 2 取证齐；D1 在真实模型下保持成立）。
- 叙界、开放沙盒：**2026-09-27 补做 = 真实模型页面三轮完成**（手选/常驻/按需三分档在叙界与开放沙盒均可复现；
  未绑定沙盒三问无库背景 → 消费者隔离；绑定/注入/释放三类时序日志齐；服务端 `.denova` 直扫 0 泄漏、
  浏览器侧仅 HTTP 缓存与模型创作正文）。**B4a/B4b 的「页面三轮操作」缺口就此关闭。**
- 遗留观察项（不影响 B4 判完成，均已登记）：① 叙界 → 沙盒切换未见叙界侧 `released` 行（仅沙盒侧 `aborted=false`）；
  ② 轮 C 常驻问「第三潮名字」被叙事遮蔽，常驻按**部分命中**记；③ 嵌入模式仍需模块 legacy 门禁占位凭据越过，
  建议后续开豁免。
- **四模式（写作 / 游戏 / 叙界 / 开放沙盒）真实模型页面证据均已齐；但 L3 整体关闭仍取决于清单
  `LIBRARY_EVOLUTION_TASK_CHECKLIST.md` 中 B5 未完成项（取消/重连/regenerate/切实例/预算/来源故障测试，
  以及产出带 SHA 与部署状态的 L3 验收报告）——本轮**不自行宣布「L3 全部完成」**。**
- 回归门禁：`go vet`（app + agent）干净；`go build ./cmd/denova` 与验收 exe 均构建通过；
  `go test ./internal/app/ -count=1` 唯一失败为既有 Windows symlink 特权环境用例
  （`TestActiveAutomationReservationAtomicallyAttachesConcurrentCaller`，已在无本轮改动的 HEAD 基线复现同败）；
  `go test ./internal/agent/` 同理（`TestToolExecutionGateCanonicalizesWorkspaceSymlink`）；
  handlers 与 libraryruntime 两包 ok；定向套件 66 例 PASS；`git diff --check` 干净。
- 本轮未提交 `artifacts/`（实例数据、模型配置与全部原始证据只在本地留存）。
