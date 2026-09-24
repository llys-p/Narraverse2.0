# P2-A 定稿：Laya Analyze / Commit 协议 v1

日期：2026-09-25。代码核对基线：`laya-p2-safe / 17be8d5`。

**状态：协议定稿，等待 P2-B/C 实现；本文不是接口已上线的声明。**

P1 放行依据为用户提供的独立验收报告：`17be8d5`，36/36 + 54/54；本轮确认提交已在开发分支、工作树干净，未重复执行验收。P1 的真实模型闭环仍未验证。

## 1. 范围与已定取舍

适用独立、单进程、本机 Laya Demo，沿用内存状态和现有 Python HTTP 服务。不接 Narraverse 正式 Runtime，不引入数据库、消息队列、登录系统、多人权限或持久化回滚。

| 决定 | 原因及边界 |
|---|---|
| 服务端保存分析结果，客户端仅引用 `analysis_id` | 复用 Pending，避免客户端提交任意 delta、等级或目标路径 |
| 乐观版本检查 + 一把进程内状态事务锁 | 当前为多线程 HTTP 服务；串行化短提交即可解决竞态，模型和网络调用放在锁外 |
| 同时绑定 `event_id` | 同一条消息反复分析会有不同 analysis_id；仅防重复 ID 不能防同一事件重复加减 |
| 新链路不依赖 NPC 行为选择 | 行为候选歧义不等于关系判断无效；状态准入来自信号能力、有效数值和提交确认 |
| Commit 成功后云端生成；失败可单独重试叙事 | 云端请求不占状态事务、不重复应用 delta，不自动回滚已确认互动 |
| 重复成功提交返回原回执 | 超时不代表失败，重试同一请求能确认结果；拒绝重复写入而非拒绝读取既有结果 |
| 内存生命周期有明确上限 | 不声称重启恢复和持久化恰好一次；过期后拒绝旧引用，不猜测或恢复提案 |

未选客户端 delta 方案：难以证明来源、角色和能力门禁。未选数据库事务方案：目前为单进程 Demo，成本超出阶段目标；多进程/生产接入必须另行设计共享事务存储。

不新增情绪标签、safety、场景切换或新的能力等级。typed-decisions 仍仅 `doubt_shift` 可写；english 仍仅 `fondness_shift` 可写，两者不能混为一套能力。这里是现有档案事实，实际准入始终读匹配且 fresh 的档案，不能硬编码等级替代校验。

## 2. 所有权与通用类型

- Laya 分析信号；State Manager 维护数值、版本与提交审计；云端生成剧情。用户或上游调用 Commit 即表示接受本轮**玩家互动**，不是确认云端计划的世界事件已发生。
- Analyze 不创建/修改 `_ACTOR_STATE`、`_STATE_TRACE` 或已提交 `_HISTORY_BUCKETS`。允许创建 Pending、去重/版本元数据、翻译缓存及诊断计时；这不叫完全无副作用函数。
- 新入口不接收 `actor`、`character_state`、`delta`、`questions`、`text_en`、模型选择或规则覆盖。Actor 初值来自服务端 `CFG.actor`；不同 actor_id 分桶隔离，P2 不实现云端初始化/自定义人物注册。
- 当前状态永远读取服务端；对话上下文里的数值、人物声明及世界设定都是参考文本，不覆盖状态。不把客户端历史直接写成已提交历史。
- ID 字符串使用 `[A-Za-z0-9_-]{1,64}`，session_id、actor_id、event_id 均必填，不允许空串/default 隐式回退。角色显示名另用模板中的 name，不把中文显示名作为新接口 ID。
- `analysis_id` 为服务端随机不透明 ID（UUID 等），不得从自增 turn 序号推断。`state_version` 为不透明字符串，客户端只能原样保存和比较，不能加减。
- 所有 JSON 数字须有限且非布尔值，禁止 NaN/Infinity；对象字段按本文白名单严格校验，未知字段返回 422，不能静默忽略拼错的键。响应允许日后增加不改变语义的字段。
- 新协议标记 `protocol_version: "laya-state-v1"`。UTC 时间使用 ISO 8601；超时判断使用服务端单调时钟，不相信客户端时间。

### 2.1 state_version 的含义

版本覆盖同桶的已接受互动：Actor State + 本协议提交记录 + 旧链路已提交决策历史。每个首次成功 Commit（包括合法零变化、旧链路只写历史）只推进一次；失败、Analyze、Reject、重复成功回放均不推进。

推荐内部表示为启动随机 epoch + 桶 generation + revision，输出组合成不透明 token。第一次只读访问可以登记版本元数据，但不初始化 Actor State。Reset 换 generation，服务重启换 epoch，**旧版本绝不因 revision 回到 0 而重新有效**。模板/config 变化另受 rules_fingerprint 约束。

所有旧写入口与 Reset 必须共用事务锁和版本管理。只加新接口的版本字段、让旧 `/commit` 在旁边直接写数值，不算完成 P2。

## 3. 接口总览

| 接口 | 职责 | 修改角色状态/已提交历史 |
|---|---|---|
| `GET /state?session_id=...&actor_id=...` | 读取当前权威快照和版本；扩展现有接口 | 否 |
| `POST /analyze` | 固定快照上分析、校验、登记候选 | 否 |
| `GET /analysis/{analysis_id}?session_id=...&actor_id=...` | 查看候选生命周期及既有提交回执 | 否 |
| `POST /commit_state` | 原子接受候选并返回回执 | 仅首次成功时 |
| `POST /reject_analysis` | 用户/Director 放弃候选，关闭同一事件 | 否 |
| `POST /narrate`，`mode="analysis"` | 使用服务器保存的状态与参考信号生成回复 | 否；P2-C 实现适配 |

### 3.1 GET /state（兼容扩展）

保留现有 `n_buckets/buckets/ranges/per_turn/note`。显式同时提供 session_id 与 actor_id 时，增加 `protocol_version` 和 `current`：

```json
{
  "protocol_version": "laya-state-v1",
  "current": {
    "session_id": "demo_01",
    "actor_id": "lia",
    "state_version": "opaque_v0",
    "initialized": false,
    "source": "template",
    "state": {"relationship": {"trust": 60, "doubt": 30}}
  }
}
```

示例仅摘录部分状态字段；真实 `state` 为 `actor_state_snapshot` 的完整深拷贝。未初始化时展示服务端模板；初始化后 source=`committed`。旧 buckets 的未初始化 `state=null` 语义保留，新页面只消费 current。旧无参数查询保留，但新协议必须明确两项 ID。

### 3.2 POST /analyze

```json
{
  "session_id": "demo_01",
  "actor_id": "lia",
  "event_id": "player_turn_01",
  "expected_state_version": "opaque_v0",
  "message": "你一直在瞒着我什么？",
  "context": {
    "scene": "旅店大厅",
    "history": [{"role": "assistant", "content": "你想知道什么？"}]
  }
}
```

| 字段 | 类型与规则 |
|---|---|
| session_id / actor_id / event_id | 必填 ID；event_id 由调用方为一次玩家发言生成并在重试中保持不变，同文本再次发言是新事件 |
| expected_state_version | 必填字符串，来自 GET /state；所有新分析必须在调用前明确基准版本 |
| message | 必填、非全空白字符串，1–4000 Unicode 字符；保留原文，不擅自 trim 后当成另一输入 |
| context | 可选对象，默认 `{scene:"", history:[]}`；仅 scene/history 两字段 |
| context.scene | 可选字符串，0–2000 字符；本轮参考，不是已发生的场景切换 |
| context.history | 可选数组，最多 12 项；每项仅 role=`user/assistant`、content=1–2000 字符；不接受 system/tool |

HTTP JSON 请求体上限 64 KiB，超限 413。保留现有英文投影和 token 预算；字符上限不能替代模型 token 截断规则。内部适配 message→player_input，历史沿用已有投影，不把新字段直接透传成旧 core 的任意配置。

处理流程：在短锁中检查版本并取得状态/历史/模板快照，登记分析中请求；锁外翻译和推理；针对**捕获的快照**校验；重新取锁检查版本、generation 和规则没有变化后才发布候选。期间状态变化返回 409，不把过期计算标记 ready。

`analyze_core` 当前会重读桶，不能简单在外层读一次版本、内部又读另一份状态。实现必须支持传入内部冻结快照或抽取等价私有核心；不得接受客户端快照伪装成该内部参数。

### 3.3 成功分析响应（HTTP 200）

以下数字是协议示例，不代表本句实际测得结果；fingerprint/token 是示意字符串。

```json
{
  "protocol_version": "laya-state-v1",
  "analysis_id": "an_example",
  "session_id": "demo_01",
  "actor_id": "lia",
  "event_id": "player_turn_01",
  "status": "ready",
  "base_state_version": "opaque_v0",
  "created_at": "2026-09-25T00:00:00Z",
  "expires_at": "2026-09-25T00:10:00Z",
  "can_commit": true,
  "reason_codes": [],
  "signals": {
    "doubt_shift": {"availability": "known", "raw_delta": 2.4, "score": null}
  },
  "state_proposal": {
    "writable_delta": [
      {"source_signal": "doubt_shift", "target": "relationship.doubt", "proposed_delta": 2.4, "applied_delta": 2.4, "old_value": 30, "new_value": 32.4}
    ],
    "auxiliary": [],
    "skipped": [],
    "preview_state": {"relationship": {"trust": 60, "doubt": 32.4}}
  },
  "capability": {
    "checkpoint": "typed-decisions",
    "profile_id": "profile_example",
    "matched": true,
    "fresh": true,
    "code_changed": true,
    "signals": {"doubt_shift": {"grade": "A", "status": "active", "role": "state_shift"}}
  },
  "evidence": {
    "input_sha256": "sha256_of_request_context",
    "base_state_sha256": "sha256_of_captured_state",
    "rules_fingerprint": "sha256_of_effective_rules",
    "translation": {"source": "frozen", "input_en_sha256": "sha256_of_effective_english"}
  },
  "commit_receipt": null
}
```

结构与语义固定如下：

- 上述顶层字段均返回。status 为 `ready/reference_only/committed/rejected/expired/stale`。初次成功仅 ready 或 reference_only，其他值由查询/重试读到。
- signals 为 signal 名到对象的映射，条目固定 `availability: known|unknown`、`raw_delta: number|null`、`score: number|null`；未测信号可缺省，未知值不能填 0。raw_delta 仅表示原映射结果，score 不叫真实行为概率。不存在可信单样本 confidence，所以 v1 不返回 confidence。
- capability.signals 记录本次实际信号的 grade/status/role，未知为 null；它是离线能力元数据，不能用单次分数覆盖。disabled/semantic_review 仅显示原因，不送云端当可靠参考。
- writable_delta 为数组，字段如例；applied_delta 是死区→每轮限制→范围限制后的**预览**，不是已提交值。preview_state 返回完整快照，示例为节选。
- auxiliary 每项为 `{source_signal, proposed_delta: number|null, reason_codes: string[]}`；skipped 每项为 `{source_signal, reason_codes: string[]}`。辅助数据绝不并入 writable_delta；不猜初值或目标路径。
- reason_codes 使用本协议错误码以及 `NO_WRITABLE_SIGNAL/UNKNOWN_VALUE/TARGET_UNAVAILABLE/CAPABILITY_NOT_ACTIVE/ROLE_NOT_WRITABLE`；不能只返回自然语言解释供程序猜。
- 只有 profile fresh/matched、实际 checkpoint 一致、`role=state_shift`、`status=active`、数值与路径有效的项可进入 writable_delta。`CFG.write_status` 不能扩大这个硬约束。目标路径必须与服务端规则一致，同一个目标重复映射拒绝该提案，不依赖遍历顺序累加。
- 至少有一个有效项（允许经过死区后为 0）时 ready/can_commit=true；全部未知/辅助/不可写或档案不可用时 reference_only/can_commit=false。合法 0 可被接受，但 UI 明示“已确认，本轮数值无变化”。reference_only 不允许空 Commit 冒充成功。
- 档案失效可返回 reference_only + `PROFILE_UNAVAILABLE`，writable_delta 必为空。翻译或模型失败是错误响应，不返回伪造信号或 fallback 提案。
- translation.source 枚举 `frozen/runtime/online/passthrough`，映射既有来源，不允许新接口客户端指定译文。英文输入 passthrough；基准文本按 P1 纪律只用冻结译文。
- evidence 是程序证据，不是 LLM 编造的心理理由；实际英文、模板、历史、原始提案保存到服务器候选中。对外不暴露密钥、绝对路径、供应商响应体或推理过程。

### 3.4 POST /commit_state

```json
{
  "session_id": "demo_01",
  "actor_id": "lia",
  "analysis_id": "an_example",
  "expected_state_version": "opaque_v0"
}
```

严格仅接受上述四项；服务器从候选取得 event_id、delta、角色模板与证据。expected_state_version 必须同时等于候选 base_state_version 和提交瞬间当前版本。

首次成功 HTTP 200：

```json
{
  "protocol_version": "laya-state-v1",
  "status": "committed",
  "replayed": false,
  "analysis_id": "an_example",
  "session_id": "demo_01",
  "actor_id": "lia",
  "event_id": "player_turn_01",
  "commit_id": "cm_example",
  "previous_state_version": "opaque_v0",
  "state_version": "opaque_v1",
  "state_changed": true,
  "committed_at": "2026-09-25T00:00:05Z",
  "applied_delta": [
    {"source_signal": "doubt_shift", "target": "relationship.doubt", "old_value": 30, "delta": 2.4, "new_value": 32.4}
  ],
  "state": {"relationship": {"trust": 60, "doubt": 32.4}}
}
```

state 返回完整提交快照。state_changed 仅依据业务字段的实际变化，不把桶初始化、版本或时间戳变化算成数值变化。零变化也标 committed、state_changed=false、推进一次版本并记录事件。applied_delta 保留合法零值项以便解释。

同 ID、同 scope、同 expected_state_version 重试，在回执保留期内返回**原回执**，仅 replayed=true；不重复写入、不推进版本、不重评模型。不要求此时最新版本仍等于旧版本，也不因之后的 profile 变化否定已经发生的提交。重复调用改 scope 返回 404，改 expected_state_version 返回 409 `IDEMPOTENCY_CONFLICT`。

回执的 state 是该次提交快照，不保证仍是此刻最新状态；新页面收到回放后 GET /state 再刷新权威值，不能把较晚提交覆盖回旧快照。

### 3.5 查询与拒绝

GET /analysis/{id} 必须提供 scope，返回第 3.3 节结构和当前 status/can_commit；committed 时 commit_receipt 为第 3.4 节原回执（replayed=false）。请求校验只读处理，不能触发重推理/在线翻译/提交。

POST /reject_analysis 输入严格为 `{session_id, actor_id, analysis_id, reason}`，reason 可选，枚举 `user_cancelled/director_rejected/superseded`，默认 user_cancelled。ready/reference_only → rejected，关闭同一 event_id，使同事件其他候选也不可提交；重复拒绝返回 200/replayed=true。已 committed 返回 409 `ALREADY_COMMITTED`，不得撤销数值；过期/失效按错误表。

Reject 不改状态版本、不写已提交历史，只留候选终态。编辑消息或撤销拒绝后重新发言需新 event_id；P2 不提供“取消拒绝”或回滚接口。

## 4. 重试、生命周期与内存边界

### 4.1 同一次事件的去重

调用方在玩家确认发送时生成 event_id；刷新/HTTP 重试保留它。事件身份为 `(session_id, actor_id, event_id)`。同一 scope 下同事件的 message/context 固定；同文本的另一轮交谈要另发 event_id。

- `input_sha256` 用解析后白名单请求字段（scope、event_id、message、默认补齐的 context）规范序列化计算，排除 expected_state_version；JSON 键顺序不影响身份。相同 event_id 换文本/context 返回 409 `EVENT_PAYLOAD_CONFLICT`。
- 同 event_id + 同基准版本的重复分析，候选仍有效则复用 ID 和结果，不再推理；正在推理则 409 `ANALYSIS_IN_PROGRESS`。预留 single-flight 标记必须原子建立，异常后释放，不允许两个同时执行。
- 旧分析 stale 或 expired 后，事件尚未接受/拒绝时，可用同 event_id、相同文本/context 和当前版本再分析，生成新 ID。旧 ID 保持失效；允许 expired 在同版本重算。查询可惰性标记 stale/expired。
- reference_only 仍在 TTL 内时复用，不因反复点击而重新抽样；规则指纹变更或 TTL 到期后可重算。同 event_id 已 committed → 409 `EVENT_ALREADY_COMMITTED`，携带已知 commit_id/analysis_id/state_version；已 rejected → 409 `EVENT_REJECTED`。
- 不做仅凭文本相同的全局去重，也不保证恶意调用方换 event_id 不重复。这是单客户端 Demo 的事件契约，不是语义事件识别器。

### 4.2 TTL 与容量

候选 ready/reference_only 从发布起有效 **600 秒**，`now >= expires_at` 即过期。推理期间的 reservation 使用单独 in-flight 状态，不对外暴露成可提交结果；不得仅因等待超时就允许同 key 再开第二次推理。

完整终态及提交回执保留到终态时间起 **3600 秒**；expired 的终态时间取原 expires_at，不因晚查询而延长。可在请求时清理，无需后台线程。清理后查询旧 ID 返回 404，提交旧 ID 也不能重建提案。事件的紧凑 committed/rejected 墓碑保留到该 scope Reset 或进程重启，即使完整回执已删，也不可再次接受同 event_id。

默认最多 200 条完整分析记录（含 in-flight）/进程、1000 条事件身份记录/桶。只可清理保留期已过的终态；无可回收位置时返回 429 `PENDING_CAPACITY` 或 `EVENT_CAPACITY`，不仿照旧 `_PENDING` 把前 100 条无声删除。进行中未超时的候选不得因容量被淘汰。事件满后需显式 Reset/新会话，不擅自丢弃去重记录。

### 4.3 Reset / 重启

复用 `/reset` 的作用域语义，但必须在同一事务锁内清状态/历史、关闭相关 Pending/事件记录并更换 generation。覆盖仅有版本元数据或正在推理、尚未初始化 Actor State 的桶；旧计算完成后比较 generation，拒绝重新发布。

Reset 后旧 ID 不可提交（记录仍在时 410 `ANALYSIS_INVALIDATED`，已清理则 404）；旧 state_version 不可重用。进程重启后内存状态、回执和事件去重均不保留，旧 ID 返回 404，旧版本与新 epoch 冲突。页面提示会话失效并重新读取模板，**不得自动重发重启前未确认的旧事件**。

## 5. Commit 的原子边界与门禁

参考实现顺序（所有新旧入口共用，不是另一套状态引擎）：

1. 解析请求，取锁，按 scope 查候选。先处理已提交回执的精确重试；再检查拒绝/TTL/失效/事件已接受等终态。
2. 比较请求版本、候选基础版本、当前版本；不相等标 stale，409 `STATE_VERSION_CONFLICT`，不自动把旧 delta 加在新值上。
3. 从**当前有效资产**重新校验 profile/checkpoint/config/冻结输入指纹；不能只信 Pending 中的 `status=active`，也不能直接复用 Analyze 时缓存的 fresh=true。检查 selected checkpoint 与实际运行模型身份一致。
4. 比较 rules_fingerprint；变化则整份候选 409 `RULESET_CHANGED`，要求重分析。只更新 code_changed 不构成失效；代码/推理进程重启由 epoch 自动隔离。
5. 对所有保存的 writable 项重新核对 role/status/source_signal→target 映射、有限数值、合法范围及状态源，执行原 `state_transition` 死区/单轮限幅/范围校验。任何原本可写项现在不合法，整次失败；不能部分写入后返回总体成功。
6. 在局部副本构造完整新状态、一次审计条目和新版本，核对每项目标、旧值、最终增量和新值与原预览一致；不把提交时间等元数据算成数值差异。预览与提交有不明差异返回 409 `PROPOSAL_MISMATCH`，不偷偷替换数值。所有可失败计算先完成。
7. 在短事务内发布新状态、审计、版本、event committed 墓碑及候选 committed 回执；首次成功才建立 Actor State 桶。任何普通异常全部恢复旧值；成功后才释放锁、写 HTTP 回应。仅发送回应失败时保留已提交回执，以便精确重试。

一把进程内可重入锁足够；所有关联读写遵守相同锁顺序，不靠 GIL 或“先检查再写”保证原子性。锁内不调用模型、翻译、叙事网络或下载；轻量元数据/指纹读取可在锁内，保持 P1 指纹规则，不重新读取巨大权重文件作全量校验。

rules_fingerprint 至少覆盖：协议版本、有效问题/映射/transition 与角色模板的配置、选定检查点及 P1 checkpoint id、当前 profile 内容（不只 profile_id）、通过校验的 dataset 与冻结译文所需子集指纹。规范 JSON 后 SHA256；沿用 P1 CRLF 兼容，不以路径或 mtime 充当内容证据。必要时强制刷新档案缓存；mtime 未变的内容替换也必须被识别。

资产热替换不受 Python 锁保护：P2 不支持运行中更新模型或规则。正常更新必须停服务再启动；提交仍要发现已发生的磁盘漂移并拒绝，不把外部写文件与内存事务说成原子系统。问题指纹扩展不得重新生成现有能力档案。

## 6. 历史、行为歧义与旧接口兼容

### 6.1 判断历史与剧情事实分开

新 Commit 往 `_STATE_TRACE` 写一次 accepted interaction 审计：analysis_id、event_id、scope、前后版本、输入摘要哈希、规则/档案指纹、applied_delta 和前后值。无需新增第二份无界事件全文日志。

新链路不调用 `decision_history_entries` 伪造 NPC 已执行行为，也不将云端回复或行动倾向写入 `_HISTORY_BUCKETS`。下一轮通过最新 Actor State 读到变化，必要对话由 context.history 作为参考输入；旧已提交行为历史仍可只读使用。

### 6.2 解除哪一种歧义门

现 `validate_state_delta` 把 behavior_is_null/awaiting_upstream 与不能改状态绑定。P2 必须明确区分：

- `judgment` 新模式：不需要 NPC 行为；单个 state_shift 不可用则跳过该项，至少一个合法项即可等待用户 Commit。未知值不写，参考值不写；不得把旧 behavior 字段强行伪造成非空来绕过。
- `legacy_behavior` 旧模式：保留 behavior=null / awaiting_upstream 不提交状态或行为历史的既有约定，`mode=upstream` 仍只叙事、不 Commit。

模式是路由在服务器内部选定，不能让客户端随意给 `allow_write=true` 或 `judgment_mode` 放行。

### 6.3 旧链路共同纳入提交保护

`/decide` 继续返回 turn_id，但登记的服务器候选也绑定基础快照、版本、epoch、规则及 scope；`/commit {turn_id}` 适配为同一个原子提交服务，版本从旧 Pending 取得。`/turn commit_state=true` 走同一服务；false 不写状态/已提交历史。Reset 也纳入同一锁。

旧响应字段与行为判定保留，冲突、过期、失效明确拒绝；历史与状态同次发布，不能一边成功一边失败。旧行为有效但无 writable 项时可接受一次行为历史，仍推进一次桶版本；该 legacy 特例不能放宽新 `/commit_state` 的 reference_only 禁令。

`commit_state()` 保留为最终状态写入核心并复用现有公式；HTTP 路由不得绕过候选/版本门直接调用任意 Proposal 写入。内部函数直接调用的旧测试可保留数学验证价值，但不能替代路由并发/权限验证。

旧客户端未提供 event_id 时只能保证同一个 turn_id 不重复写，不保证两次独立 `/turn` HTTP 请求算同一事件；新页面全部走新协议。兼容路由不得成为新页面重试的后门。

## 7. P2-C 页面与叙事适配契约

新页面流程：GET /state → 为本次发言生成 event_id → Analyze → 展示预览/参考 → 手动 Commit 或 Reject → GET /state 刷新 → 云端回复。禁止 `applyDeltas` 对权威面板本地累加；动画可以保留，起止值来自服务器。

- 展示三块：当前权威值；待确认预览；辅助信号。reference_only 显示“仅参考”，不伪装为“数值不变且已提交”。
- Commit 超时先查询 analysis 或用**原请求**重试；不重新生成 event_id，不先重分析再提交。版本冲突先刷新，再让用户确认是否对同一事件重分析。
- 页面刷新可恢复已保存的 scope/event_id/analysis_id 并只读查询；进程 epoch 已变时清理旧候选引用并提示重置，不自动重放。
- `POST /narrate` 新增服务器选定的 `mode="analysis"`，输入仅 `{mode,session_id,actor_id,analysis_id}`。拒绝客户端携带 actor/delta/behavior/state_line 代替服务器数据；不得再隐式调用 decide 或产生新候选。
- committed：从提交回执取本轮状态（附 state_version）和服务器保存的原文/上下文及允许参考信号。reference_only：仅在未过期、版本与规则仍有效时，取基础状态并标 `reference_only`，auxiliary 明示不改变状态。ready 未提交返回 409 `ANALYSIS_NOT_COMMITTED`。
- 返回保留现有 line/引擎信息，并增加 analysis_id、state_version、state_source=`committed/reference_only`、commit_allowed=false、state_commits=[]。展示实际送模的无密钥状态摘要；不展示供应商推理内容。committed 快照可能比当前状态旧，UI 标明本轮引用版本。
- 每次显式叙事请求可重新生成文字（不承诺生成幂等），绝不重复 Commit。云端失败时保留“状态已提交，回复失败，可重试”的准确状态。
- 复用 `llm_narrate/_build_narrate_prompt/extract_line` 和既有 DeepSeek 配置，只做取值来源及模式适配。角色主动性、追问规则与创作对照属于 P3；新 mode 的处理不改旧 upstream 分支语义。

## 8. 错误协议

新端点统一返回 `{protocol_version, error:{code,message,details}}`。details 只放结构化诊断（例如 current_state_version、analysis_id、retry_after_ms）；不返回堆栈/密钥/本机绝对路径。scope 不匹配与未知 analysis_id 同为 404，不披露其他桶记录。scope 绑定用于隔离，不能替代未来的认证授权。

| HTTP | code | 含义/恢复 |
|---|---|---|
| 400 | INVALID_JSON | JSON 无法解析，纠正请求 |
| 413 | PAYLOAD_TOO_LARGE | 请求体超限 |
| 422 | INVALID_REQUEST | 字段/类型/ID/数值不合法，或夹带客户端 delta |
| 404 | ANALYSIS_NOT_FOUND | ID 未知、已清理、重启丢失或 scope 不符 |
| 409 | STATE_VERSION_CONFLICT | 当前版本与分析基础不一致；刷新后显式重分析 |
| 409 | EVENT_PAYLOAD_CONFLICT / EVENT_ALREADY_COMMITTED / EVENT_REJECTED | 同事件内容冲突或已终结，禁止另造候选重复写 |
| 409 | ANALYSIS_IN_PROGRESS | 同分析正在执行；提供 retry_after_ms=500，不自动无限重试 |
| 409 | IDEMPOTENCY_CONFLICT | 已提交 ID 被换版本重试 |
| 409 | ANALYSIS_NOT_COMMITTABLE / ANALYSIS_REJECTED / ANALYSIS_NOT_COMMITTED | 当前候选不允许该操作 |
| 409 | ALREADY_COMMITTED | 已提交结果不能 Reject |
| 409 | RULESET_CHANGED / PROFILE_UNAVAILABLE / PROPOSAL_MISMATCH | 当前准入或提案一致性失效，整次无写入 |
| 410 | ANALYSIS_EXPIRED / ANALYSIS_INVALIDATED | 有记录但已过期或 Reset 失效 |
| 429 | PENDING_CAPACITY / EVENT_CAPACITY | 容量达到上限，保留有效记录，不擅自驱逐 |
| 502 | TRANSLATION_FAILED / MODEL_INFERENCE_FAILED / NARRATION_FAILED | 对应阶段失败，无伪造成功数据；叙事失败不撤销先前 Commit |
| 503 | MODEL_UNAVAILABLE | 指定模型未就绪；不冒用 heuristic 或另一 checkpoint |
| 500 | INTERNAL_ERROR | 普通内部错误；Commit 发布前异常全无写入 |

只有已存在的精确 committed 重试优先回放；其余按 scope→终态/TTL→版本→规则→校验的顺序失败。can_commit 是查询时的候选资格，不是对未来提交必定成功的承诺。

## 9. 验收矩阵（下阶段执行，本轮未跑）

优先用既有测试夹具、假时钟、模拟信号和本机临时 HTTP 端口；网络翻译/模型/云端均 stub，不能接管正在使用的 8130。

| 编号 | 必须证明的结果 |
|---|---|
| A1 | Analyze/查询任意次数均不创建 Actor State 或改变已提交历史/trace；捕获快照一致 |
| A2 | 同事件同版本重试复用 ID；并发 Analyze 只推理一次；不同事件同文本不被错误去重 |
| A3 | active state_shift 合法才能写；auxiliary、disabled、未知、不匹配 checkpoint/路径、NaN/Infinity、伪造等级不写 |
| A4 | behavior=null 的 judgment 可合法提交；旧 ambiguous/upstream 仍不得提交；不是伪造行为绕门 |
| A5 | 死区零值合法提交一次并推进版本；unknown/reference_only 不伪装成功；范围和幅度公式不变 |
| C1 | 首次提交更新完整快照、审计、版本、回执；下一轮读到新状态；两角色/两会话不串桶 |
| C2 | 同 ID 两个线程同时 Commit 只写一次；同事件多个 ID 也只接受一次；两个不同事件同版本只允许一个成功 |
| C3 | 丢响应后原请求重试得到原回执；已有后续版本时重试仍不写，页面刷新不回退数值；换请求字段拒绝 |
| C4 | Analyze 后 profile 内容变化（含保持 mtime）、config/基线/checkpoint 漂移均拒绝；仅 code_changed 不提高或降低能力等级 |
| C5 | 候选 TTL 临界值、Reject、容量满、Reset（含在推理中）、重启旧 token、回执清理与事件墓碑均不误放行 |
| C6 | 事务发布前/发布中可控异常注入无部分状态或历史；回应发送失败后仍可查正确回执 |
| L1 | `/decide→/commit`、`/turn`、Reset 共用版本锁；旧提交使新分析 stale，反向亦然；false 仍零状态/历史写入 |
| U1 | 页面参考/预览/已提交分开；手动提交后使用服务端值；刷新/冲突/回放均无重复本地累加 |
| U2 | 新叙事 mode 不触发 decide/commit；请求中实际包含服务器选定的状态与版本；云端失败重试不加数值 |

保留 P1 36 项与旧 54 项覆盖，不删断言让计数好看。若正式版本/幂等语义确实改变旧断言，逐项说明旧期待、新期待与协议依据。100 条真实样本、真实模型测速和付费创作对照不包含在 P2-B 的默认运行范围。

## 10. 实施顺序与交接终点

1. **P2-B1：协议服务与无模型单元验证。** 复用状态计算/提案/档案；补作用域版本、事件去重、候选生命周期、事务提交与 GET/POST 新入口。建议独立小模块承载存储/协议编排，避免复制推理引擎。先交回审查。
2. **P2-B2：旧路由适配和 HTTP 并发验证。** 全部旧写入口通过同一事务边界、Reset 作废计算中候选；保留旧响应和歧义纪律。B1 与 B2 全部完成前，不宣布新协议可供用户安全试用。再交回审查。
3. **P2-C：页面权威值与叙事引用适配。** 按第 7 节闭环，保留表现组件。先模拟云端验证实际输入和失败处理；真实模型/云端试运行单独安排，不自动花费调用额度。

本定稿覆盖上述阶段的共同契约，当前仅完成 P2-A。执行 AI 每次只领一个小阶段，不自行进入后续阶段。交付返回提交号、复用点、最小 diff、实际测试命令与计数、未验证项；冻结资产/配置/档案/旧 runs 不变，禁止重建 capability 或放宽门禁。

P2 不宣称修好了 trust/fondness 的模型质量，也不强迫每句有数值变化。后续以用户确认的真实体验决定 P3；正式 Narraverse 接入、持久化、多进程、撤销与云端初始化另立任务。
