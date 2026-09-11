# Narraverse2.0 World Workspace Phase 3 Architecture Plan（v2.7 · Phase 3.0B Design Freeze）

- 规划时间：2026-09-10（初版）／2026-09-11（v2.7）
- 文档版本：**v2.7（Phase 3.0B Design Freeze；仅架构设计，不含生产代码）**
- 审查基线：`main` / `f87d795`（Phase 3.0A 已落地）
- 前置状态：Phase 2B `CLOSED WITH ACCEPTANCE FOLLOW-UPS`；Phase 3.0A 已实现并提交
- 本文范围：Phase 3.0A～3.2 架构与实施顺序；**不包含生产代码实现**
- 文档状态：`PHASE 3.0B DESIGN FREEZE（v2.7）；Phase 3.2-C0 iframe 安全边界另设强制设计门`
- 取代：本文件 v2.6；并落实 **Codex 对 v2.6 的短复审 NEED REVISION 三项**
- **Snapshot schema（§4.7～§4.12）已通过冻结，本版不改**（复审明示无需再改）

## 0. v2.6 → v2.7 变更摘要

| v2.7 定点修订 | 落点 |
| --- | --- |
| ① **Capability 不再伪冻结**：当前同源、无 sandbox 的 iframe 没有真实信任根；v2.6 的“进程外注入三选一 + 隔离三选一”既未选型，也与浏览器宿主和既有 IndexedDB/localStorage 数据连续性冲突。Capability 整体移出 3.0B，改为 **3.2-C0 独立安全门**；在该门通过前不得创建/启用 iframe 世界上下文受控入口 | §6.4、§7.1、§7.6、§14、§17 |
| ② **analysisHandle 原子消费并对齐现有 Task**：一个 pending context 只对应一个可复用 handle；服务端注册表以 CAS/互斥锁完成 `pending → claimed`，杜绝并发双消费；Task 采用“分配 ID → 绑定上下文 → 启动 goroutine”顺序，模型执行前绑定必须完成；writing 锚定 Task，game 锚定 InteractiveRun；移除 iframe analysis 与“统一迁移到 task”的旧表述 | §6.6、§6.7、§14 |
| ③ **InteractiveRun 映射对齐真实持久化时机**：增加 `taskId → interactiveRunId` 运行期映射；`turnId → interactiveRunId` 只能在 `interactive_turn_persisted` 后写入，不能在 Task 创建时伪造；regenerate 先用已持久化 turn 反查 run，再创建新的 Task | §6.3.3、§6.6、§14 |

**冻结范围说明**

- **Phase 3.0B 可以进入编码**：Snapshot、双投影、selection/闭包、fingerprint、预算、错误、日志、runContext 核心注册表，以及 writing/game 所需的 analysisHandle/InteractiveRun 纯契约与测试。
- **Phase 3.2-C / 3.2-D 仍不可进入编码**：当前不实现 host capability、不改 iframe origin/sandbox、不迁移其浏览器存储。3.2-C0 必须先提交独立安全设计并完成真实数据连续性验证。
- **Snapshot schema（§4.7～§4.12）保持冻结，v2.7 未修改。**

## 0.1 v2.5 → v2.6 变更摘要（历史，保留供追溯）

| v2.6 定点修订 | 落点 |
| --- | --- |
| ① **Capability 形成真实信任根**：承认宿主是浏览器 React 页面、iframe **同源且无 sandbox** ⇒ 纯 HTTP 无法区分两者；**冻结具体可信来源** = **Denova 进程生成一次性 bootstrap secret** + **secret 只经进程外通道注入顶层宿主** + **签发端点强制校验**；并**强制配套** iframe `sandbox`（不含 `allow-same-origin`）／独立 origin／native bridge **三者之一** | **§7.6.1 重写**（问题陈述 + secret 规格 + 交付通道 + 三选一配套 + 未实现即不得开工）；§7.6.0/§7.6.2/§7.6.3 同步 |
| ② **analysisHandle 流程闭合**：为 `/api/chat` 与 `/api/interactive/chat` **冻结合法 `analysis_handle` 请求字段** + **严格解码规则** + **消费顺序** + **失效错误语义**；**game 消费 handle 时先建 InteractiveRun、再建其下 Task**（不是直接迁移到 Task） | **§6.7 新增「请求契约 / 严格解码 / 消费顺序 / 失效语义」四小节**；§9.2 新增三个失效原因码；§7.1 表补 `analysis_handle` 字段；§6.6 同步 |
| ③ **InteractiveRun 残留清理 + 两条新规则**：§6.5「story/branch/**task** 取 runContext」、§7.1「game scope 从服务端 **task** 派生」、§14 测试「`story_id+branch(+task)`」三处改为 `story+branch+interactiveRunId`；**新增 `turnId → interactiveRunId` 服务端内存映射**；**新增「普通非 regenerate 的下一回合必须创建新 InteractiveRun」规则** | **§6.5 / §7.1 / §14 三处改写**；**§6.3.2 新增映射表与规则 7**；§13 §14 同步 |
| ③′ 清理复审点名的**测试章节旧规则**「analysis 无目标 task 不建 runContext」（v2.5 已取消该前置） | §13 风险行改写、§14 测试行改写 |

**保持不变（v2.5 已冻结，本版不放松）**

- **Snapshot schema 全套契约（§4.7～§4.12）**：四类类型、空值语义、数组与文本限制、revision 校验、sidecar metadata、ModelView schema 稳定性（**复审已通过，本版不动**）。
- World 仍是**唯一持久化真源**；UI/Model 双投影（ProjectionBody 共享 / final ModelView 每 run 独占）；四模式只读；不回写 World；**Timeline 去 Canon**；Knowledge/Obsidian 只读投影。
- 线上无 `scopeKey`、consumer 由路由固定、`context_state` 四值、bare 规则、降级分级、`sourceRef` 不可寻址、token 确定性公式。

## 0.1 v2.4 → v2.5 变更摘要（历史，保留供追溯）

| v2.5 必补项 | 落点 |
| --- | --- |
| ① **Capability 信任根**：iframe 不可信、**capability 不能由 iframe 申请**、**host bootstrap 流程**、服务端签发 **opaque token**、浏览器不可见内部 `hostInstanceId` / `iframeInstanceRef` / `revoked`、`consumer_not_trusted` **错误归属** | **§7.6 重写（信任根模型 + bootstrap 时序 + 不透明令牌 + 错误归属归属表）**；§6.4/§7.1/§7.3 §13 §14 联动 |
| ② **analysisHandle 生命周期改为「先分析后建 task」链**：`context-analysis` → **pending analysis context** → opaque `analysisHandle` → **首次 chat 消费 handle** → 创建 task → **迁移 runContext** | **§6.7 重写**（pending 阶段不再要求 task 锚点）；§6.6 analysis run 段与五态表同步；§6.3.2 关联 |
| ③ **InteractiveRun 模型**：冻结 `InteractiveRun != Task`（Task = **一次执行尝试**）；regenerate 经 `regenerate_from_turn_id` 找回 InteractiveRun；**abort 只结束当前 Task**；branch 切换创建新 InteractiveRun | **§6.3.2 重写**；§6.3 表 game 行改写（`story+branch+run`，去掉 task 作为 run 身份）；§6.6 五态表与边界规则同步 |
| ③′ **清理 v2.4 残留的错误表述** | 删除「`story+branch+task` 作为 run 身份」「同一个 task regenerate」「task 结束即销毁 run」三处表述（§6.3 表 / §6.3.1 / §6.6 / §6.3.2） |

**保持不变（v2.4 已冻结，本版不放松）**

- World 仍是**唯一持久化真源**；Snapshot / sidecar / ProjectionBody / runContext / ModelView 均不进入 World JSON。
- **UI Projection / Model Projection 双投影**；ProjectionBody（source-neutral，可共享）与最终 ModelView（每 run 独占）分离。
- **四模式只读**：模式产出只留各自存储，**不回写 World**，World revision 运行前后不变。
- **Timeline 去 Canon**：八态保真 + 解码侧四态区分（3.0A 已落地）。
- **Knowledge / Obsidian 只读投影**：引用形状冻结、禁止绝对路径、关系图不是 World 真源（§12）。
- 线上无 `scopeKey`、consumer 由路由固定、`context_state` 四值、bare 规则、selection 五步检测顺序、token 确定性公式、fingerprint 规范化、`sourceRef` 不可寻址、降级分级、sidecar metadata、ModelView schema 稳定性。

## 0.1 v2.3 → v2.4 变更摘要（历史，保留供追溯）

| v2.4 必补项 | 落点 |
| --- | --- |
| ① **iframe capability 边界**：iframe 不可信；`worldId`/`revision` **不作为授权**；**host capability 由服务端签发**；`consumer_not_trusted` 的**穷举触发规则** | **§7.6 新增（capability 模型 + 授权来源三层 + 错误规则清单）**；§6.4/§7.1/§7.3 §13 §14 联动 |
| ② **analysisHandle 生命周期**：明确 `analysisHandle → runContext → task` 三者关系；handle **短期**、**不进任务日志**、**不作为长期身份** | **§6.7 新增**；§6.6 analysis run 段改为引用 |
| ③ **interactiveRunId 设计**：**task ≠ run**；regenerate **复用** `interactiveRun`；branch 切换**创建新** `interactiveRun` | **§6.3.2 新增** + §6.3 映射表 game 行改写（scope 用 run，不再用 task） |
| ④ **删除 Snapshot 自引用 `stats.bodyBytes`**，改为 **sidecar metadata** | **§4.8 删字段** + **§4.12 新增 sidecar 契约**；§4.11(b) 引用同步 |
| ⑤ **ModelView 固定字段契约**：空数组、空 `sources`、schema 稳定性（`sections` 重新定义） | **§4.10 增「schema 稳定性」小节** + §9.1 `sections` 定义同步 |

**保持不变（v2.3 已冻结，本版不放松）**

- World 仍是**唯一持久化真源**；Snapshot / sidecar / ProjectionBody / runContext / ModelView 均不进入 World JSON。
- **UI Projection / Model Projection 双投影**；ProjectionBody（source-neutral，可共享）与最终 ModelView（每 run 独占）分离。
- **四模式只读**：模式产出只留各自存储，**不回写 World**，World revision 运行前后不变。
- **Timeline 去 Canon**：八态保真 + 解码侧四态区分（3.0A 已落地）。
- **Knowledge / Obsidian 只读投影**：引用形状冻结、禁止绝对路径、关系图不是 World 真源（§12）。
- 线上无 `scopeKey`、consumer 由路由固定、`context_state` 四值、bare 规则、selection 五步检测顺序、token 确定性公式、fingerprint 规范化、`sourceRef` 不可寻址、降级分级。

### v2.3 已生效结论（保留，不重开）

- 契约完整性（§4.7～§4.11）、两级产物缓存、五态生命周期、iframe 由宿主代理、降级分级。

## 0.1 v2.2 → v2.3 变更摘要（历史，保留供追溯）

| v2.3 必补项 | 落点 |
| --- | --- |
| ① **完整 Snapshot 契约**：`WorldContextSelection` / `WorldContextSnapshotV1` / `WorldContextUIViewV1` / `WorldContextModelViewV1`，逐字段标注必填/可选、空值语义、数组与文本上限、revision 校验、UI 字段、Model 字段 | **§4.7～§4.11 新增**（含三张总表：空值语义 / 数组与文本限制 / revision 校验）；§5.1 改为引用 §4.7 |
| ② **修正缓存设计**：**取消最终 `modelViewBytes` 共享**，改为缓存 **source-neutral projection body**；每个 runContext 各自生成 `runSalt`、`sourceRef`、最终 ModelView | **§4.1 重写（单一序列化→两级产物）**、**§6.2 两级注册表重构（`ProjectionBodyCacheEntry` + `RunContext`）**、§6.3 并存规则、§6.5 清理粒度、§9.1/§9.3 命名与上限、§14 测试 |
| ③ **runContext 生命周期**：明确 **analysis run → task 绑定**；定义 **create / reuse / reconnect / regenerate / destroy** 五态 | **§6.6 新增（生命周期状态机 + analysis run 绑定规则）**；§6.5 表补 analysis 行 |
| ④ **iframe 边界**：iframe **不得直接调用受控入口**，一律由宿主代理 | **§6.4「iframe 直呼受控入口的处置」新增**；§7.1 补代理声明；§7.3 补丢弃与审计规则 |
| ⑤ **错误降级**：明确 **可降级 / 不可降级** 两类清单 | **§9.2 降级分级表新增**（替换原「降级例外」段落，语义不放松） |

**保持不变（v2.2 已冻结，本版不放松）**

- World 仍是**唯一持久化真源**；Snapshot / projection body / runContext / ModelView 均不进入 World JSON。
- **UI Projection / Model Projection 双投影**；ModelView 默认脱敏。
- **四模式只读**：模式产出只留各自存储，**不回写 World**，World revision 运行前后不变。
- **不建立 Canon**（无全局剧情共同真源、模式事件不自动写入 World / Timeline）。
- **Knowledge / Obsidian 只读投影**：引用形状冻结、禁止绝对路径、关系图不是 World 真源（§12）。
- 服务端受控入口（consumer 由路由固定、线上无 `scopeKey`）、selection 闭包与五步检测顺序、token 确定性公式、fingerprint 规范化、`sourceRef` 不可寻址、错误码映射层、`context_state` 四值、bare 规则。

### v2.2 已生效的两项快速复审结论（保留，不重开）

- **scopeKey 规则**：线上协议无 `scopeKey`；writing/game 由服务端既有 `task.ID()`/`story_id`/`branch` 派生，iframe 类由服务端生成 `runContextId` 并取内部 `rc:<id>`；客户端自造该字段不被采信（§6.3.1）。
- **受控入口 bare 规则**：bare 是适配层解析后的显式状态，不与错误降级混同；`context_state = none | bound | active | degraded`（§7.5）。

## 0.1 v2.1 → v2.2 变更摘要（历史，保留供追溯）

| v2.2 必加项 | 落点 |
| --- | --- |
| ① **runContext 归属规则**：iframe 不持有 `runContextId`；宿主负责绑定；`model-call-request` 只传消息 | **§6.4 重写**（归属与消息契约）+ §7.1（受控入口只接受宿主绑定）+ §7.3（越权丢弃） |
| ② **runContext 生命周期**：多任务 / 多分支 / 多 iframe 实例并存；task/story/adventure/sandbox instance → runContext 映射；清理粒度 | **§6.2 扩展为两级注册表**（`runContext` scope 绑定 + `modelViewCache` 共享字节）+ §6.3 映射表 + §6.5 清理粒度 |
| ③ **Timeline 空值保真**：`null` / `""` / 字段缺失 的读取、显示、保存规则 | **§8.1 ①②** 增补八态保真表 + 解码侧实现约束（必须区分四态，不得 `string+omitempty` 一把梭） |
| ④ **模型预算**：`consumerContextWindowTokens <= 4096` 直接 `budget_exceeded` | **§9.1 新增加固 guard** + §9.2 该原因允许「无上下文继续」的例外说明 |
| ⑤ **Knowledge Workspace / Obsidian**：采用 `sourceKind` / `sourceId` / `sourceRevision` / `locator`；禁止绝对路径；Obsidian 关系图只是只读投影、不是 World 真源 | **§12 重写**（引用形状 + locator 白名单 + 禁止绝对路径 + 只读投影定位 + 本期不实现） |

### v2.2 本次补强（在 Codex 核对 v2.2 diff 前一并纳入，仍属 v2.2 freeze，不另升版本）

| 补强项 | 起因 | 落点 |
| --- | --- | --- |
| ⑥ **scopeKey 形式化规则**：唯一生成者、语法/长度/字符集、确定性（禁用随机/时间戳）、consumer 命名空间、bind/resume/unbind 三操作（首请求 upsert/幂等复用/换 fingerprint 走替换 vs 续接 mismatch）、缺失与非法处理、iframeInstanceId 派生、脱敏 | §6.3 原表只给组成段，未冻结「同 scope 重复首请求 / 主动换选择 / 缺 scopeKey」的确定行为 | **§6.3.1 新增**；联动 §13、§14(3.0B)、§17 |
| ⑦ **受控入口无上下文（bare）规则**：三请求形状、`context_state = none/bound/active/degraded`、bare 不创建 runContext/不占名额、不隐式注入也不隐式解绑、与错误降级严格区分、通用网关永远 bare | §7.1 原仅一句「两字段都不带=基线」，未区分「主动无上下文」与「加载失败降级」，也未说明已绑定 scope 裸发如何处理 | **§7.5 新增** + §7.1 改为引用；联动 §9.2、§13、§14(3.2)、§17 |
| ⑧ **scopeKey 上线通道（第二轮快速复审）**：冻结「线上协议无 scopeKey 字段」——writing/game 由服务端从 `task.ID()`/`story_id`/`branch` **派生**，iframe 类由服务端 bind 时**生成** `runContextId`、宿主只本地保存；请求体出现自造 scopeKey 一律忽略+审计，不作授权凭证 | v2.2 首版只说「宿主生成 scopeKey、服务端记录」，但请求体只有 `world_context?/run_context_id?/messages`，未定义首请求如何交付 scopeKey，无法实现 | **§6.3 表 + §6.3.1 重写**；联动 §6.2、§6.4、§7.1、§7.3、§11、§13、§14(3.0B)、§17 |

**保持不变（v2.1 已冻结，本版不放松）**

- World 仍是**唯一持久化真源**；Snapshot / runContext / ModelView 均不进入 World JSON。
- **UI Projection / Model Projection 双投影**；ModelView 默认脱敏、单一序列化。
- **四模式只读**：模式产出只留各自存储，**不回写 World**，World revision 运行前后不变。
- **不建立 Canon**（无全局剧情共同真源、模式事件不自动写入 World / Timeline）。
- 服务端受控入口（consumer 由路由固定）、selection 闭包与五步检测顺序、token 确定性公式、fingerprint 规范化、`sourceRef` 不可寻址、错误码映射层。

## 1. 结论

Phase 3 按以下顺序推进：

1. **Phase 3.0A：Timeline 去 Canon 的混合版本兼容（独立提交、独立回退）。**
2. **Phase 3.0B：冻结 `WorldContextRef` / `runContext`（含归属与生命周期）、双投影、selection 闭包、预算 / 错误 / 日志契约。**
3. **Phase 3.1：增强 World Console，让用户看懂将带入模式的来源、健康与闭包结果。**
4. **Phase 3.2：分段接入四模式。** 写作 / 游戏复用各自既有的服务端入口（consumer 由路由固定）；叙界 / 开放沙盒**必须先完成 3.2-C0：服务端受控模式入口 + 宿主绑定与代办**（§6.4、§7）。

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
- **叙界 / 沙盒**：
  - `app/ai-client.js` 的 `NarraverseSharedAI.chat()` **由浏览器直接 `POST /api/model/chat`**；
  - `app/app.js` 依据 `module4-active` 在**浏览器**决定提交 `module=narraverse|module4`；
  - `denova-src/internal/api/handlers/handler_model_gateway.go` 当前直接 `BindJSON` 为 `ModelGatewayChatRequest` 并调用 `GenerateModel`，**不校验调用方身份与上下文**；
  - `NarraverseWorkspace` 与 `app/bridge.js` 为 v1 iframe 宿主协议，已做同源、来源 window、消息类型校验，但无世界上下文消息。
  - → 因此「通用网关拒收自由 consumer」与「Narraverse/Module4 复用浏览器直调链」**不可能同时成立**；v2.1 起改为受控入口 + 宿主代办，v2.2 进一步冻结**归属**（iframe 不持有 `runContextId`）。
- Timeline：Go（`internal/world`）与 TS（`features/world-workspace/types.ts`）当前仍是 `canon|planned`，schemaVersion 仍为 1；`category` 目前为 `string + omitempty`，**无法区分 `missing` / `null` / `""`**（v2.2 §8.1 明确要求区分）。

### 2.3 当前缺口

- 没有 `WorldContextRef / WorldContextSnapshot / UI Projection / Model Projection / runContext` 契约。
- 四模式入口只导航，不携带/解析 World 背景；chat、interactive、iframe 协议均无世界字段。
- 绑定健康只在单档案/单资料按需出现，没有控制台总览与「被谁引用」的派生展示。
- Timeline 仍含 Canon，且空值形态无法区分，与「禁止 Canon + 不静默改写数据」冲突。
- 没有「本次进入模式携带哪些世界内容」的选择、闭包预览与来源视图。
- **没有服务端受控的叙界/沙盒调用入口**，也没有宿主侧的 runContext 归属与多实例生命周期。

## 3. 方案比较

### 方案 A：服务端由引用生成快照，再双投影（采用）

客户端提交安全引用，服务端重读 World、校验、生成唯一内部 Snapshot，再分别序列化为 UI / 模型两种投影。3.0B 先冻结公共解析器与 writing/game 的服务端内部 runContext；Narraverse/Module4 未来仍须复用同一解析器，但其受控入口、宿主句柄与内部 scope 生成方式必须先通过 3.2-C0 安全门，当前不预设具体协议。

- 客户端无法伪造 World 正文或绕过字段白名单。
- 一个解析器统一四模式字段、数量、脱敏、闭包与预算；UI 与模型各取所需、互不污染。
- 复用现有 World Store、内容哈希 revision、CAS 与错误体系；不持久化快照、不产生第二真源。

代价：3.2-A/B 分别给写作/游戏入口增加同一个可选 `world_context` 引用字段；叙界/沙盒若在 3.2-C0 安全复审通过，还需要按唯一冻结方案新增受控入口、宿主绑定层与 iframe 协议增量（§6.4、§7）。

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
WorldContextSnapshotV1（内部、不可变；含 omissions 审计）
   ├── projectForUI(snapshot)          → WorldContextUIViewV1   （控制台预览/查看来源，可含内部 ID）
   └── projectForModelBody(snapshot)   → ProjectionBody          （source-neutral、纯函数、可跨 run 缓存）
                 │  每个 runContext：runSalt（随机）→ sourceRef 表 → 物化
                 ▼
        WorldContextModelViewV1（**per-run 最终产物**，含本 run 的 sourceRef）
```

- 三个纯函数：`projectForUI` / `projectForModelBody`（source-neutral）/ `materializeModelView`（body + runSalt → 最终 ModelView，确定性）；同输入必同输出，均不得回读完整 World、不得扩展白名单、不得发起 Master 请求。
- 模式格式化器（写作/游戏/叙界/沙盒各自的提示排版）只接收**最终** `WorldContextModelViewV1`，不能接收内部 Snapshot、ProjectionBody 或 UIView。
- **两级产物，取消最终字节共享（v2.3 修正）**：
  - **ProjectionBody（source-neutral）**：只由 `(Snapshot 内容, canonicalSelection, consumer)` 决定，**不含** `runSalt`、`sourceRef`、任何 per-run 随机量或 run 标识；因此可按 `contextFingerprint` 缓存并在多个 runContext 之间**共享**（§6.2）。
  - **最终 `WorldContextModelViewV1`**：由 `(ProjectionBody, runSalt)` 物化，`sourceRef` 随 `runSalt` 变化 → **每个 runContext 各有一份，绝不共享**（杜绝「跨 run 复用同一 sourceRef」与「共享字节泄漏 run 标识」）。
  - 同一 runContext 内，模型实际提示与 context-analysis 展示仍使用**同一份最终 ModelView 字节**（禁止前端二次排版近似，§9.1）。
- 两处字节上限（§9.1）：`projectionBodyBytes ≤ 96 KiB`、`finalModelViewBytes ≤ 96 KiB`。

### 4.2 内部 Snapshot（服务端内部对象）

字段语义沿用白名单（identity/setting/characters/locations/factions/timeline/materials/warnings），并明确：

- 内部 Snapshot 允许携带实体 id 与跨实体 id 引用，仅供两个投影函数消费；**不直接序列化给模型**。
- `generatedAt` 仅作运行元数据，不参与内容等值判断，也不进入 ModelView。
- **闭包省略审计 `omissions`**：
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
- **`sourceRef` 为不可寻址值**：
  ```
  sourceRef = base64url( HMAC-SHA256(runSalt, consumer + '|' + refKind + '|' + refValue)[0..16] )
  ```
  - `runSalt` 为每个 runContext 随机生成（32 字节，仅内存、不落盘、不进日志）；
  - 同一 runContext 内对同一输入稳定（可回指 UIView 映射表）；**跨 run 不可复现**；
  - 不可是对 `masterItemId` 的可逆编码；
  - 测试必须断言：`sourceRef` 不能用于 `/api/library/assets/:id`、`/api/worlds/:id` 或任何文件路径，也不能作为写入凭证。
- 角色只输出 `displayName/role/worldNote/关系展示名`；地点输出 `name/description/tags`；势力输出 `name/description/influence/stability`；时间线输出 `order/eraLabel/title/description/category(新三值)`；资料只输出薄快照 `name/tags/semanticType 展示名`。
- 模型投影内**不允许出现悬空引用**（闭包规则见 §5）：角色的 faction/location、势力总部、角色关系，目标未入选则省略或改展示名，绝不留内部 id。

### 4.5 双投影不变量（测试化）

1. 对任意 Snapshot，`projectForModel` 的序列化结果中，正则扫描不得出现任一内部 `bindingId/masterItemId/文件路径/source_id/sourceRef 反查痕迹`。
2. UIView 与 ModelView 的「入选集合」必须一致：闭包裁剪只发生一次（在内部 Snapshot 阶段）。
3. 纯函数：重复投影字节一致（`generatedAt` 不进投影）。
4. 任一模版格式化器只能读到 ModelView 白名单字段，越界字段在类型层不可达。
5. `projectForModel` 输出中不得出现 `omissions`；`projectForUI` 必须完整覆盖 Snapshot 的 `omissions`。

### 4.6 contextFingerprint 规范化

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

### 4.7 WorldContextSelection（请求侧契约，v2.3 冻结）

```
interface WorldContextSelection {
  includeTone:      boolean    // 可选，缺失 = false
  ruleIndexes:      number[]   // 可选，缺失 = []
  characterIds:     string[]   // 可选
  locationIds:      string[]   // 可选
  factionIds:       string[]   // 可选
  timelineEntryIds: string[]   // 可选
  bindingIds:       string[]   // 可选，仅 world scope
}
```

| 字段 | 必填 | 上限 | 空值 / 缺失语义 | 非法处理 |
| --- | --- | --- | --- | --- |
| `includeTone` | 可选 | — | 缺失 = `false`（不注入基调段；`setting.tone` 存在也不输出） | 非 bool → `invalid_request` |
| `ruleIndexes` | 可选 | ≤ 50 | 缺失/`[]` = 不注入规则段 | 负数/非整数/越界 → `selection_invalid`；重复 = 幂等去重 |
| `characterIds` | 可选 | ≤ 20 | 缺失/`[]` = 不含角色 | 不属于该 revision → `selection_invalid` |
| `locationIds` | 可选 | ≤ 20 | 同上 | 同上 |
| `factionIds` | 可选 | ≤ 20 | 同上 | 同上 |
| `timelineEntryIds` | 可选 | ≤ 30 | 同上 | 同上 |
| `bindingIds` | 可选 | ≤ 20 | 缺失/`[]` = 不含 world 资料 | 出现 entity scope → `selection_invalid` |
| 合计入选对象 | — | **≤ 60**（闭包**之后**计数） | 全空 = 合法（仅 identity，可按 `includeTone` 带基调） | 超限 → `budget_exceeded` |

- 请求体**严格解码**：未知字段 → `invalid_request`；`scopeKey`/`consumer`/`worldId`/`revision` 等保留字段出现 → `consumer_not_trusted`（§7.1）。
- 闭包后实际入选集合是 Snapshot 的唯一内容来源（§5.2「只做减法」）。

### 4.8 WorldContextSnapshotV1（服务端内部对象，v2.3 冻结）

```
interface WorldContextSnapshotV1 {
  schemaVersion: 1
  worldId: string                 // 服务端世界 id（内部，可寻址，仅内部使用）
  worldRevision: string           // 'sha256:' 前缀内容哈希，必须等于请求 expectedWorldRevision
  consumer: 'writing' | 'game' | 'narraverse' | 'module4'
  contextFingerprint: string      // §4.6
  canonicalSelection: WorldContextSelection   // 归一化后（去重 + 稳定排序）
  identity: { name: string; tagline?: string; genre?: string; summary?: string }
  setting?: { tone?: string; rules: string[] }
  characters: Array<{
    id: string; displayName: string; role?: CharacterRole
    worldNote?: string
    factionId?: string; locationId?: string                 // 内部引用，闭包后必命中已入选实体
    relationships: Array<{ targetCharacterId: string; label: string }>
  }>
  locations: Array<{ id: string; name: string; description?: string; tags: string[] }>
  factions: Array<{ id: string; name: string; description?: string; influence?: number; stability?: number; headquartersLocationId?: string }>
  timeline: Array<{ id: string; order: number; eraLabel?: string; title: string; description?: string; category: TimelineCategory }>
  materials: Array<{ bindingId: string; masterItemId: string; name: string; tags: string[]; semanticType: SemanticType; scope: 'entity' | 'world' }>
  omissions: Array<{ kind: 'character_faction'|'character_location'|'faction_headquarters'|'relationship_edge'; ownerEntityId: string; missingEntityId: string; reason: 'target_not_selected'|'target_cascaded_removed' }>
  warnings: Array<{ code: 'legacy_timeline_category' | 'binding_unchecked'; refKind?: string; refId?: string }>
  stats: { characterCount: number; locationCount: number; factionCount: number; timelineCount: number; materialCount: number }   // v2.4：移除自引用 bodyBytes（改由 §4.12 sidecar 承载）
}
```

| 字段组 | 必填 | 上限 / 语义 |
| --- | --- | --- |
| `schemaVersion` | 必填 | 固定 `1`；参与 §4.6 fingerprint |
| `worldId` / `worldRevision` / `consumer` / `contextFingerprint` / `canonicalSelection` | 必填 | revision 见 §4.11(c)；fingerprint 见 §4.6 |
| `identity.name` | 必填 | ≤ 100 字；空字符串视为缺失 → 生成期拒绝（World 契约要求 name 非空） |
| `identity.tagline` / `genre` / `summary` | 可选 | ≤ 200 / ≤ 50 / ≤ 20,000 字；**空字符串 = 缺失（不输出该键）** |
| `setting` | 可选 | 仅当 `includeTone=true` 或至少一条规则入选时存在；`tone` ≤ 200，`rules` ≤ 50 条、每条 ≤ 2,000 |
| `characters` | 必填（可空数组） | ≤ 20；`displayName` ≤ 100；`worldNote` ≤ 4,000；`relationships` ≤ 100 |
| `locations` | 必填（可空数组） | ≤ 20；`name` ≤ 100；`description` ≤ 20,000；`tags` ≤ 50 × ≤ 100 |
| `factions` | 必填（可空数组） | ≤ 20；`name` ≤ 100；`description` ≤ 20,000；`influence`/`stability` ∈ 0–100 |
| `timeline` | 必填（可空数组） | ≤ 30；`order` ≥ 0 整数；`title` ≤ 200；`eraLabel` ≤ 100；`description` ≤ 20,000；`category` ∈ 新三值（3.0A 已归一） |
| `materials` | 必填（可空数组） | ≤ 20；薄快照，不含正文/头像 |
| `omissions` / `warnings` | 必填（可空数组） | 只含内部 id 与枚举 code，不含正文 |
| `stats` 各 count | 必填 | 由闭包结果派生；**不含 `bodyBytes`（v2.4 移除，改由 §4.12 sidecar 承载）** |
| 序列化 | — | Snapshot JSON ≤ **96 KiB**（§9.1 层②）；Snapshot **不含自引用字段、不含运行期时间戳** |

- **空值语义（全表统一）**：可选字段**缺失即「不适用/未选」**，Snapshot 内**一律不写 `null`**；空数组 = 该段无内容（ModelView 不输出该段）。
- Snapshot **不出服务端边界**；`generatedAt` 类运行元数据不进 Snapshot（避免同输入不同字节）。

### 4.9 WorldContextUIViewV1（控制台投影，v2.3 冻结）

= Snapshot 全量字段 + 下列内部视图专有字段：

| 追加字段 | 必填 | 语义 |
| --- | --- | --- |
| `sourceTable` | 必填 | `slot → { kind: 'character'|'location'|'faction'|'timeline'|'material'|'identity'|'setting'; entityId?; bindingId?; masterItemId?; fieldPath? }`；供「查看来源 / 高亮 / 回到分区」 |
| `revisionLabel` | 必填 | 展示用 revision 前缀（UI 可见） |
| `isDraftPreview` | 必填 | `false`（权威快照）；dirty 草稿不生成权威 UIView（§10.1） |

- **允许**出现内部 id、`bindingId`、`masterItemId`（用户自己的数据，便于定位）。
- **禁止**出现：Master 正文/嵌套正文/头像 URL、任何绝对路径、API Key、Prompt、模型原始输出。
- UIView **不进入任何模型请求体**，也不写入日志/存档。

### 4.10 WorldContextModelViewV1（模型可见最终产物，v2.3 冻结）

```
interface WorldContextModelViewV1 {
  schemaVersion: 1
  identity: { name: string; tagline?: string; genre?: string; summary?: string }
  setting?: { tone?: string; rules: string[] }
  characters: Array<{ displayName: string; role?: CharacterRole; worldNote?: string; factionLabel?: string; locationLabel?: string; relationships: Array<{ targetLabel: string; label: string }> }>
  locations: Array<{ name: string; description?: string; tags: string[] }>
  factions: Array<{ name: string; description?: string; influence?: number; stability?: number; headquartersLabel?: string }>
  timeline: Array<{ order: number; eraLabel?: string; title: string; description?: string; category: TimelineCategory }>
  materials: Array<{ name: string; tags: string[]; semanticTypeLabel: string }>
  sources: Array<{ ref: string; kind: 'identity'|'setting'|'character'|'location'|'faction'|'timeline'|'material'; label: string }>
}
```

| 规则 | 冻结内容 |
| --- | --- |
| **Model 字段白名单** | 仅上列字段；`displayName/role/worldNote/关系展示名`、`name/description/tags`、`influence/stability`、`order/eraLabel/title/description/category`（三值）、materials 薄快照展示名 |
| **UI 字段（不进模型）** | 全部内部 id、`bindingId`、`masterItemId`、`sourceTable`、`omissions`、warnings 明细、`revisionLabel` |
| **硬禁止** | 实体内部 id、`bindingId`、`masterItemId`、任何文件/绝对路径、`boundAt`、封面色、归档状态、主书路径、主故事 id、`customFields`、`growthNote`、Master 正文/嵌套正文/头像/远程 URL、Proposal/AI 原始输出、未保存草稿、`omissions`、`runSalt`、`scopeKey`、`runContextId`、`contextFingerprint` |
| **`sources[].ref`** | 本 run 的 `sourceRef`（§4.4）——每 run 重新生成，**跨 run 不可复现**；`sources` ≤ 60 条、`ref` 唯一 |
| **空值语义** | 可选字段缺失 → **不输出该键**（不写 `null`）；无内容段（空数组）→ **不输出该段**（`sections` 相应减少，§9.1） |
| **长度上限** | 全文 ≤ **48,000 rune**；JSON ≤ **96 KiB**；单字段沿用 §4.8 的上限 |
| **不可变性** | 同一 runContext 内字节恒定；模型实际提示与 context-analysis 展示必须使用**同一份字节** |
| **每 run 独占** | 最终 ModelView **不共享**（与 §6.2 的 `ProjectionBody` 缓存严格区分） |

**ModelView schema 稳定性契约（v2.4 冻结）**

| 规则 | 内容 |
| --- | --- |
| **恒在数组** | `characters` / `locations` / `factions` / `timeline` / `materials` / `sources` **恒为数组**；无内容时输出 `[]`，**不允许省略键、不允许 `null`** |
| **空 `sources`** | 合法（例如仅 identity 入选的极简上下文）；必须是 `[]`，不得省略；`sources` 不得含重复 `ref` |
| **可选标量** | `identity.tagline/genre/summary`、`setting.tone`、`characters[].role/worldNote/factionLabel/locationLabel`、`locations[].description`、`factions[].description/influence/stability/headquartersLabel`、`timeline[].eraLabel/description` → **缺失即不输出该键**（不得输出 `null`，不得输出 `""`） |
| `identity` | **恒存在**，`name` 必填且非空 |
| `setting` | **可选键**：仅当基调或至少一条规则入选时存在；一旦存在，`rules` 恒为数组 |
| `schemaVersion` | 恒为 `1` |
| **字段结构与命名稳定性** | v1 内**不允许**新增 / 重命名 / 删除字段或改类型；确需变更则 `schemaVersion: 2` 并提供双读兼容期（本期不做） |
| **`sections` 定义（供 §9.1 token 估算）** | `sections = 1(identity) + (setting 键存在 ? 1 : 0) + [characters / locations / factions / timeline / materials 中 length>0 的段数] + (sources.length>0 ? 1 : 0)`；**空数组段不计数** |
| **键集合快照测试** | 每个黄金样例除断言 token 数外，必须断言**顶层键集合与各数组元素键集合**，防止误加 / 漏字段导致 schema 漂移 |

### 4.11 空值语义 / 数值与文本限制 / revision 校验（三张总表）

**(a) 空值语义总表**

| 形态 | 含义 | Snapshot | UIView | ModelView |
| --- | --- | --- | --- | --- |
| 键缺失 | 不适用 / 未选 | 允许（可选字段） | 同 Snapshot | **不输出该键** |
| `null` | 不表示任何语义 | **禁止写入** | **禁止** | **禁止** |
| `""`（空串） | 等同于缺失 | 归一为缺失（不写该键） | 同 | 不输出 |
| `[]` | 该段无内容 | 允许（必填数组可为空） | 同 | **不输出该段**（sections 减一） |
| `timeline.category` 旧值 | `canon` / 未知 / `""` / `null` / 缺失 | 读取即归一为三值（3.0A） | 按 §8.1 显示 + warning | 只输出三值 |

**(b) 数组与文本限制总表（政策上限，服务端最终裁决）**

| 项 | 上限 | 超限结果 |
| --- | --- | --- |
| characters / locations / factions | 各 ≤ 20（闭包后） | `budget_exceeded` |
| timeline | ≤ 30 | `budget_exceeded` |
| world scope materials（单独选择） | ≤ 20 | `budget_exceeded` |
| 入选对象合计 | ≤ 60 | `budget_exceeded` |
| relationships（单角色） | ≤ 100 | `budget_exceeded` |
| tags（单实体） | ≤ 50 × 每项 ≤ 100 | `budget_exceeded` |
| 文本上限 | name 100 / tagline 200 / genre 50 / summary 20,000 / description 20,000 / worldNote 4,000 / rule 2,000 / eraLabel 100 / title 200 / tone 200 | `budget_exceeded`（不截断） |
| Snapshot JSON | ≤ 96 KiB | `budget_exceeded` |
| ProjectionBody JSON | ≤ 96 KiB | `budget_exceeded` |
| 最终 ModelView JSON | ≤ 96 KiB，且文本 ≤ 48,000 rune | `budget_exceeded` |
| token 估算 | ≤ `min(12,000, consumerContextWindowTokens − 4,096)` | `budget_exceeded` |

**(c) revision 校验表**

| 环节 | 规则 | 失败结果 |
| --- | --- | --- |
| 请求字段 | `expectedWorldRevision` 必填、`sha256:` 前缀、长度 ≤ 100、无空白 | `invalid_request` |
| 读盘比对 | 必须等于磁盘当前内容哈希 | `revision_conflict`（409，**不自动换版本**） |
| 快照生成 | 只按**该 revision 的磁盘字节**解析；生成后**不复查**（内容寻址保证一致） | — |
| 运行期变化 | 已绑定 runContext 的 Snapshot/ModelView **不热替换** | 新请求才按新 revision 重新解析 |
| 归档 | 已绑定可继续用到本次 run 结束；**新请求**拒绝 | `world_archived` |
| 写回 | Phase 3 **不写 World**；无 CAS 写路径 | 不存在写入冲突 |

### 4.12 Snapshot sidecar metadata（v2.4：替代自引用 `bodyBytes`）

**为什么必须移出**：字节数写入 Snapshot 自身会让其序列化依赖自身长度（自引用），破坏「同输入必同字节」的纯函数性质，也使 `contextFingerprint` 失去可复现性。因此 v2.4 把**诊断/预算/计数**信息移入独立 sidecar。

```
interface SnapshotSidecarMetaV1 {   // 服务端内部对象，独立于 Snapshot
  worldId: string
  worldRevision: string
  consumer: 'writing' | 'game' | 'narraverse' | 'module4'
  contextFingerprint: string
  generatedAt: string               // RFC3339；仅诊断，不参与任何投影
  scope: 'build' | 'cache_hit'      // 本次 body 是新生成还是命中缓存
  snapshotBodyBytes: number         // Snapshot 序列化字节数
  projectionBodyBytes: number
  finalModelViewBytes: number
  counts: { characters: number; locations: number; factions: number; timeline: number; materials: number; omissions: number; warnings: number; sources: number }
  budget: { estimatedTokens: number; effectiveModelBudget: number; sections: number }
}
```

**规则（冻结）**

1. sidecar **不进 Snapshot 对象**，也**不进 UIView / ModelView / 任何请求或响应体**（仅用于服务端内部诊断与预算判定）。
2. sidecar **不参与** `contextFingerprint` 计算、`ProjectionBody` 缓存键与任何等值判断。
3. sidecar 与两级注册表同级受 §9.3 禁令：不入通用日志 / 任务日志 / 故事存档 / 导出包；日志中只允许出现其**派生标量**（字节数、计数、`estimatedTokens`）。
4. `generatedAt` 只存在于 sidecar；投影函数一律不读 sidecar，保证 §4.5 不变量③（重复投影字节一致）严格成立。
5. sidecar 随 runContext / body 生命周期一起释放，不单独持久化。

## 5. selection 闭包规则

### 5.1 selection 形状与归一化

客户端提交 `WorldContextSelection`（字段级**必填/上限/空值/非法**契约见 **§4.7**）在服务端进入投影前必须**确定性归一化**：

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

### 5.3 严格拒绝语义与检测顺序

**检测顺序（固定、可测）**：

1. **形状/类型解析**：字段类型、id 字符串可解析；不可解析 → `selection_invalid`。
2. **归属校验**：每个 id / 下标必须存在于**当前 revision** 的 World（已删除、绑定已移除、级联解引用后失效 → `selection_invalid`）。
3. **越权/越界校验**：`bindingIds` 出现 entity scope（越权偷渡）、`ruleIndexes` 负数或越界 → `selection_invalid`。
4. **去重 + 稳定排序**：普通重复值在此步**幂等归一化，不报错**。
5. **闭包计算**：只做减法并记录 `omissions`。

- 任一步致命失败 → 整个请求 `selection_invalid`，**不返回部分 Snapshot、不自动补全、不静默丢弃**，错误中回传「安全的非法选择清单」（只含客户端提交的 id，不含内部路径）。
- **普通重复 = 幂等去重**，拒绝只针对非法 / 越权 / 跨 World / 越界。若未来要把重复视为攻击信号，必须另立版本并**取消先去重**、明确检测顺序，本期不做。
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

### 6.2 两级注册表：ProjectionBody 缓存 + runContext（v2.3 修正：取消最终 ModelView 共享）

**v2.3 关键修正**：缓存对象从「最终 `modelViewBytes`」改为 **source-neutral projection body**。最终 ModelView 含 `sourceRef`，而 `sourceRef` 由每个 runContext 的 `runSalt` 决定，因此**最终字节绝不共享**；只有不含任何 per-run 随机量的 projection body 可以跨 runContext 共享。

```
ProjectionBodyCacheEntry {          // 一级：fingerprint → source-neutral body（可跨 runContext 共享）
  contextFingerprint: string        // §4.6
  projectionBodyBytes: []byte       // ≤ 96 KiB；不含 runSalt / sourceRef / run 标识
  bodySizeBytes: number
  refCount: number                  // 被多少 RunContext 引用
  lastUsedAt: number
}

RunContext {                        // 二级：scope → 上下文绑定（每 run 独占最终产物）
  runContextId: string              // 服务端生成：32 字节 CSPRNG → base64url
  consumer: 'writing' | 'game' | 'narraverse' | 'module4'
  scopeKey: string                  // 服务端内部键（§6.3）：3.0B 仅 writing/game 由既有运行对象派生；iframe 形状留待 3.2-C0；从不读取请求体
  worldId: string
  expectedWorldRevision: string
  contextFingerprint: string        // §4.6（与 ProjectionBody 的缓存键一致）
  runSalt: []byte                   // 32 字节，**每 runContext 独立随机**；§4.4 sourceRef 用；仅内存
  sourceRefTable: Map<string,string>// 本 run 的 slot → sourceRef（仅内存；供 UIView ↔ ModelView 映射）
  finalModelViewBytes: []byte       // ≤ 96 KiB；由 (projectionBody, runSalt) 物化，**不共享**
  uiViewSummary: { worldName: string; revisionLabel: string; selectedCount: number }
  contextState: 'bound' | 'active' | 'degraded'   // §7.5；bare 不建 RunContext
  createdAt: number
  lastUsedAt: number
}
```

**物化链路（每 run 一次，冻结）**

```
ProjectionBody（缓存命中或新生成）
  → 生成随机 runSalt（32B）
  → 对 body 中每个 slot 计算 sourceRef = HMAC-SHA256(runSalt, consumer|slotKind|slotValue)[0..16] → sourceRefTable
  → 写入 sources[] 与各段引用 → finalModelViewBytes
```

- `ProjectionBody` 由 `projectForModelBody(snapshot)` 产出，**只依赖 (Snapshot 内容, canonicalSelection, consumer)**；同 fingerprint 必须字节一致（纯函数 + 测试锁定）。
- 同一 runContext 内 `runSalt`、`sourceRefTable`、`finalModelViewBytes` **恒定**（续接/重连/regenerate 一律复用，不重新随机化）。
- 不同 runContext 即使 fingerprint 相同，`runSalt` 不同 ⇒ `sourceRef` 不同 ⇒ **最终 ModelView 字节不同**。

**存储与边界（冻结）**

- 存储：**仅进程内存**（两个 `map` + mutex）。**不落盘**、不写 `world-<id>.json`、不写任务日志、不写故事存档/可导出运行数据、不写 localStorage。
- 大小：`projectionBodyBytes` ≤ **96 KiB**；`finalModelViewBytes` ≤ **96 KiB**。
- 容量：`RunContext` ≤ **64 条**；`ProjectionBodyCacheEntry` ≤ **32 条**且总量 ≤ **8 MiB**；超限按 `lastUsedAt` **LRU** 淘汰。
- 淘汰/过期后的行为：后续请求返回 `context_unavailable`，**降级为无上下文继续**，并提示「世界背景已失效，可重新进入以加载」；不自动重建、不要求客户端补 Ref。

**重启语义（冻结）**

- Denova 进程重启后两级注册表为空：`active` / `reconnect` / `context-analysis` / `model-call` 一律返回 `context_unavailable`，按**无上下文降级**继续（模式可用），**不自动重放、不追溯旧 Ref**。
- 与「刷新页面可无上下文运行」一致；不使用 localStorage 作为权威。

**一致性校验**

- 续接请求若显式携带 Ref 且与绑定 `contextFingerprint` 不一致 → `context_ref_mismatch`；**不得静默采用新或旧中的某一份**。
- 携带未知 / 过期 `runContextId` → `context_unavailable`（不视为越权）。
- 跨 consumer 使用同一 `runContextId` → `consumer_not_trusted`。

### 6.3 运行身份 → runContext 映射（scopeKey，冻结）

**核心冻结（第二轮复审）：scopeKey 是服务端内部键，永不出现在任何请求体 / 查询串 / iframe 消息中；客户端（含浏览器宿主与 iframe）不提交、也无法自造 scopeKey，更不得把它当授权凭证。** 3.0B 只冻结一条绑定通道：写作/游戏由服务端从**既有运行对象**派生。叙界/Module4 的绑定通道尚无可信调用源，整体留到 3.2-C0 独立冻结；本节对 iframe 的描述均为未来约束，不是 3.0B 实现合同。

| consumer | scopeKey 来源（**服务端内部，不上线**） | 首次 bind 如何定位 scope（请求体**无** scopeKey） | 多任务 / 多分支 / 多实例语义 |
| --- | --- | --- | --- |
| `writing` | **服务端派生** `task:<serverTaskId>`；`serverTaskId` 是 `POST /api/chat` 时 `StartTask` **服务端生成**的 `task.ID()`（`agent.ChatRequest` 本身无 task 字段） | 首请求随 `world_context: Ref` 到达，服务端先建 task、再用该 `task.ID()` 内部派生并绑定；SSE / active / regenerate 走既有 task 通道，无需客户端传 scope | 每个写作任务一条；**写作侧 regenerate 沿用同一 task**（写作无 InteractiveRun，§6.3.2 规则 6）；新任务 = 新 runContext |
| `game` | **服务端派生** `story:<storyId>\|branch:<branchId>\|run:<interactiveRunId>`；`story_id`/`branch` 是 `/api/interactive/chat` **既有字段**，`interactiveRunId` 由服务端为**该活动回合**生成（**`InteractiveRun` ≠ `Task`**，run 身份**不含 task**，见 §6.3.2） | 服务端直接从既有 `story_id`(+`branch`) 与服务端 InteractiveRun 身份派生，**不新增请求字段** | **branch 切换 = 新 InteractiveRun = 新 scope / 新 runContext**；同一 InteractiveRun（含其下多次 Task / regenerate，经 `regenerate_from_turn_id` 找回）复用同一条 |
| `narraverse` | **3.2-C0 预留**：安全门通过后才可冻结生成方式 | 3.0B 不存在 bind/resume 入口 | 每 iframe 实例语义留待 3.2-C0 与真实信任根一起冻结 |
| `module4` | **3.2-C0 预留** | 3.0B 不存在 bind/resume 入口 | 每沙盒实例语义留待 3.2-C0；本期不解决指定 adventure 的旧协议限制 |

**并存与共享规则（冻结）**

- 3.0B 中多个 writing Task / game InteractiveRun **可同时存在**各自的 runContext（上限 64 条）；iframe 多实例并存只作为 3.2-C0 后续目标，当前不占用注册表。
- 若它们的 `contextFingerprint` 相同（同 World + 同 revision + 同 selection + 同 consumer），则**共享同一份 source-neutral `ProjectionBody`**（`ProjectionBodyCacheEntry` 只存一份，`refCount` 计数），但**各自保留独立 runContextId**。
- **最终 ModelView 一律不共享（v2.3 修正）**：每个 runContext 有独立 `runSalt` → 独立 `sourceRefTable` → 独立 `finalModelViewBytes`；即使 body 命中缓存，物化后的字节也必然不同。
- 不同 consumer 的 fingerprint 天然不同（§4.6 含 consumer），因此**不跨模式共享 body**。
- runContext 与内部 scopeKey 是**一对一**：同一 `(consumer, scopeKey)` 重复 **bind** → fingerprint 相同则幂等复用（并复用同一 runContext 的既有 `runSalt`/ModelView，不重新随机化）、不同则替换旧绑定（细则见 §6.3.1）；`context_ref_mismatch` 只发生在 **resume** 同时携带冲突 Ref 时。

#### 6.3.1 scopeKey 形式化规则（v2.2 补强；第二轮复审冻结「线上无 scopeKey」）

- **世界上下文控制字段白名单（冻结）**：3.0B 只定义 writing/game 的 `world_context?` 与服务层 `analysis_handle?` 契约，均不新增 `run_context_id` 或 scopeKey；HTTP 路由接线留到 3.2-A/3.2-B。iframe 受控入口字段仅为 3.2-C0 候选，安全门前不得实现。任何请求体 / 查询串出现自造 `scopeKey`、`scope`、`run_scope` 均不采信并记脱敏审计。
- **两类来源（路径已按 consumer 固定，调用方无权选择）**：
  - **A 服务端派生（writing / game）**：只能使用**服务端已持有**的标识——服务端 `task.ID()`（仅 writing）、既有 `story_id`/`branch` 与 `interactiveRunId`（game）；这些标识本就由服务端生成或经过既有校验，客户端无法把它们伪造成授权凭证。**确定性**：writing 同 `task.ID()`、game 同 `story_id+branch+interactiveRunId` 必得到字节相同的内部 scopeKey（**game 的 run 身份不含 task**，§6.3.2）。
  - **B 未来候选（narraverse / module4，非 3.0B 合同）**：只有 3.2-C0 先证明宿主与 iframe 的请求来源可区分，并冻结唯一 trust root 后，才能定义 bind、`runContextId` 签发和宿主内存路由。v2.6 的 `rc:<runContextId>` / `iframeInstanceId → runContextId` 仅作历史候选，不得直接实现（§7.6）。
- **内部语法（只约束服务端自派生 / 自生成的键，测试锁定，不解析任何客户端输入）**：非空；字符集 `[a-z0-9:|._-]`；以 `kind:id` 为段、`|` 连接；长度 1～160；无首尾空白。
- **命名空间**：内部按 consumer 隔离；不同 consumer 即使 scopeKey 字符串相同也互不共享（§4.6 fingerprint 亦含 consumer）。
- **三种操作语义（区分首请求与续接）**：
  1. **bind（首请求 / 主动重绑）**：3.0B 服务层接收 `world_context: Ref` 或有效 `analysis_handle`，由服务端得到 writing/game 的内部 `(consumer, scopeKey)` 后 **upsert**：无绑定 → 新建并挂到本次 Task / InteractiveRun；已绑定且 fingerprint 相同 → **幂等复用**（同一 id，不重复计 `refCount`）；已绑定且 fingerprint 不同 → **替换**（旧 runContext `refCount--`，即 §6.5「切换世界 / 改选择 = 新 run」），**不**返回 mismatch。3.0B 不接收或返回 `run_context_id`。
  2. **resume（续接）**：3.0B 只走服务端既有 Task / story + branch + InteractiveRun 关联（Ref 可选）。命中且 consumer 一致 → 复用同一份 bytes；若**同时**带 Ref 且 fingerprint 与该 runContext 不一致 → `context_ref_mismatch`（不挑新或旧、不静默替换）。iframe 的 `run_context_id` resume 协议留到 3.2-C0 重新设计。
  3. **unbind**：只由 §6.5 的 scope 事件或用户「清除上下文」触发；bare 请求不是 unbind（§7.5）。
- **派生缺失处理**：3.0B 在服务端拿不到 writing/game 必需运行标识（如 interactive 缺 `story_id`）→ 走**既有**请求校验 400（不新增错误码、不建 runContext、禁止「每请求临时解析 Snapshot」绕过注册表）；写作 Task / game InteractiveRun 必须按 §6.7.3 在模型启动前完成分配与绑定。iframe 侧的缺失语义尚未冻结。
- **iframeInstanceId 未冻结**：它是否存在、如何生成、是否需要宿主本地映射，统一留给 3.2-C0；3.0B 不创建该标识、map 或 unbind 协议。
- **脱敏**：内部 scopeKey 与 `runContextId` 同级——不回传 iframe、不进 ModelView、不进通用日志 / 存档 / 导出，日志只记其哈希（§9.3）。

#### 6.3.2 InteractiveRun 与 Task 的模型（v2.5 重写，冻结）

**冻结前提：`InteractiveRun` ≠ `Task`**（v2.4 只说了「task ≠ run」，未给出二者的**包含关系**；v2.5 补足并纠正多处由此派生的错误表述）。

```
InteractiveRun                      ← 一次「活动回合」的语义身份（服务端生成，回合级）
├─ Task #1  (initial generation)    ← 第一次生成：一次执行尝试
├─ Task #2  (regenerate)            ← 重生成：又一次执行尝试
└─ Task #3  (regenerate)            ← 再重生成：再一次执行尝试
```

| 概念 | 定义 | 粒度 | 生命周期 | 是否参与 scopeKey |
| --- | --- | --- | --- | --- |
| **InteractiveRun**（`interactiveRunId`） | 一个**活动回合**的语义身份；服务端生成 | **回合级**（含该回合的多次尝试） | 中：跨该回合的多次 Task | `game`：**是**（`run:<interactiveRunId>`） |
| **Task** | **一次执行尝试**（`StartInteractiveTask` 创建的一次生成过程） | **尝试级** | 短：本次尝试结束即终止 | **否**（不作为 run 身份） |
| **branch** | 故事分支 | 分支持久 | 长 | `game`：**是** |

**规则（v2.5 冻结）**

1. **Task 是一次执行尝试**：每次生成（首次或 regenerate）服务端都会新建一个 **Task**；Task 结束 = 本次尝试结束，**不等于** InteractiveRun 结束。
2. **regenerate 通过 `regenerate_from_turn_id` 找回同一个 InteractiveRun**：重生成请求携带 `regenerate_from_turn_id`；服务端由该 turn 反查其所属的 `interactiveRunId` ⇒ **复用同一 runContext、不重新随机化 `runSalt`、ModelView 字节保持不变**（对应 §6.6 的 `regenerate`）。**新建的是 Task，不是 InteractiveRun。**
3. **abort / 取消只结束当前 Task**：abort 终止正在进行的那一次执行尝试；**InteractiveRun 仍然存在**，其 runContext **不解绑**——用户可继续 regenerate 或推进。
4. **branch 切换创建新的 InteractiveRun**：branch 段变化 ⇒ 新 `interactiveRunId` ⇒ 新 scopeKey ⇒ **新 runContext**（旧 runContext 按 §6.5「scope 事件」解绑）。
5. `interactiveRunId` 由**服务端**生成、不可推导、不上线（与 `scopeKey` 同级脱敏，§6.3.1）；客户端既不能提交也不能指定；请求体出现同名自造字段 → 忽略 + 脱敏审计（§7.1、§9.3）。
6. **写作侧没有 `interactiveRun`**：写作的回合语义**等价于 task**（regenerate 沿用同一 task），故 `writing` 的 scopeKey 仍为 `task:<serverTaskId>`；本节的 InteractiveRun 模型**只适用于 game**。
7. **普通（非 regenerate）的下一回合必须创建新 InteractiveRun（v2.6 新增，冻结）**：用户推进到下一回合（新 turn，不带 `regenerate_from_turn_id`）⇒ 服务端**新建 `interactiveRunId`** ⇒ 新 scopeKey ⇒ **新 runContext**。
   - 理由：runContext 的生命周期应跟随「回合」，而非跟随「故事/分支」；否则跨回合会误复用同一份 `runSalt` 与 `sourceRef`，违背 §6.2「final ModelView 每 run 独占」。
   - 旧 runContext 不立即销毁：按 §6.5 TTL/LRU 自然回收（用户可能切回该回合 regenerate）。

#### 6.3.3 Task / Turn → InteractiveRun 服务端内存映射（v2.7，冻结）

当前 `NewTask` 在返回前即启动 goroutine，而 `turn.ID` 只会在生成结果持久化后出现。因此不能在“创建 Task”时写一个尚不存在的 `turnId`。冻结为两段映射：运行中用 Task 定位 run，持久化后再用 Turn 支持 regenerate。

```
// 服务端内部，仅内存；进程重启即失
type TaskRunIndex = Map<taskId, interactiveRunId>      // 运行期 / SSE / abort / active
type TurnRunIndex = Map<turnId, interactiveRunId>      // turn 持久化后 / regenerate
type RunMeta = Map<interactiveRunId, {
  storyId: string
  branchId: string
  taskIds: Set<string>
  turnIds: Set<string>
  createdAt: number
  lastUsedAt: number
}>
```

| 规则 | 冻结内容 |
| --- | --- |
| **普通新回合** | 不带 `regenerate_from_turn_id` ⇒ 服务端先生成新的 `interactiveRunId`；Task 获得服务端 `task.ID()` 后、其 goroutine 启动前，同步写 `taskId → interactiveRunId`。 |
| **Turn 写入时机** | 仅在既有 `interactive_turn_persisted` 成功事件中取得真实 `turn.ID` 后，写 `turnId → interactiveRunId` 并加入 `RunMeta.turnIds`；失败或 abort、未持久化的 Task **不得**产生虚构 turn 映射。 |
| **regenerate 反查** | 收到 `regenerate_from_turn_id` ⇒ 先按 `(storyId, branchId)` 查 `TurnRunIndex` ⇒ 命中后复用同一 InteractiveRun / runContext，再创建新的 Task 并登记 `TaskRunIndex`；新生成的 turn 仍要等持久化成功后才登记 `TurnRunIndex`。 |
| **运行期定位** | SSE reconnect、active、abort 与 Task 状态查询通过 `TaskRunIndex` 找到所属 InteractiveRun；Task 结束只结束该次尝试，不解绑 runContext。Task 映射的保留时间与既有 Task 事件缓冲/注册表一致，随后由 §6.5 TTL/LRU 回收。 |
| **branch 切换** | branch 变化 ⇒ 新建 `interactiveRunId`（§6.3.2 规则 4）；旧映射保留至 TTL 回收，支持切回旧分支后对仍在内存中的 turn regenerate。 |
| **作用域隔离** | 两张索引都按 `(storyId, branchId)` 与 consumer 隔离；不同 story/branch 的 taskId/turnId 即使相同也互不干扰。 |
| **生命周期** | 两张索引仅内存；随 runContext / Task 注册表受 §6.5 清理；**不持久化、不进日志原值、不进存档/导出**（§9.3）。 |
| **regenerate 未命中** | 查不到 `regenerate_from_turn_id`（已回收 / 进程重启 / 客户端伪造）⇒ **不得猜测或暗中复用旧 run**。只有请求显式携带并通过校验的新 `world_context` 才可创建新 run；否则本次按 bare 执行并记脱敏审计。 |
| **客户端不可提交** | `interactiveRunId` 及两张映射关系均不下发；客户端自造 `interactiveRunId` 一律忽略 + 审计。 |

**v2.5 清理的错误表述（原 v2.4 残留，本版作废）**

| 原表述 | 问题 | v2.5 修正 |
| --- | --- | --- |
| 「`story+branch+task` 作为 run 身份」 | task 是**尝试级**，把 task 编进 run 身份会导致每次 regenerate 都换 scope，进而重建 runContext | run 身份 = `story:<storyId>\|branch:<branchId>\|run:<interactiveRunId>`，**不含 task**（§6.3 表同步） |
| 「同一个 task regenerate」 | 与「Task = 一次执行尝试」矛盾；regenerate 必然新建 Task | regenerate ⇒ **新建 Task**，但**沿用同一 InteractiveRun**（经 `regenerate_from_turn_id` 找回） |
| 「task 结束即销毁 run」 | Task 结束只是一次尝试终止，run 应保留以支持后续 regenerate | **InteractiveRun 结束 / branch 切换 / 实例级 scope 事件**才解绑 runContext（§6.6 `destroy` 同步） |

### 6.4 iframe 归属规则（3.2-C0 预留；v2.7 明确不属于 3.0B）

**当前事实与阶段门**

- 当前 Narraverse iframe 与宿主**同源且无 sandbox**，并依赖 IndexedDB/localStorage；现有代码没有可让服务端区分顶层 React 宿主与 iframe 的可信通道。
- 因此下列消息协议只作为 **3.2-C0 的目标契约**，3.0B **不得**创建或启用 `/api/world-context/{narraverse|module4}/model-call`，也不得签发 host capability。
- 3.2-C0 开工前必须单独冻结“来源隔离 + 既有浏览器数据连续性”方案并验收；在此之前 Narraverse/Module4 继续 Phase 2B 行为，不携带 World Context。

**归属不变量（具体标识与映射形状未冻结）**

- 任何 runContext 内部标识都只能存在于服务端，或在 3.2-C0 证明安全后存在于可信宿主内存；**iframe 既不接收、也不持有、也不得回传**。
- 若 3.2-C0 最终采用宿主代理，宿主必须按“已挂载 iframe + 来源 window”在本地路由；但具体 `iframeInstanceId`、runContext 句柄、scopeKey 形状与签发协议**尚未冻结**，不得直接采用 v2.6 的 `iframeInstanceId → runContextId` 候选。
- **仅在 3.2-C0 安全设计与隔离验证 PASS，且 3.2-C 按冻结方案实现后**，才能声称 iframe 无法换 World、revision、selection 或 consumer。

**消息契约（目标形状，3.2-C0 冻结后方可启用）**

| 方向 | 消息 | payload（严格白名单） |
| --- | --- | --- |
| 宿主 → iframe | `world-context-changed` | `{ worldId, revision, displaySummary{ worldName, selectedCount } }`（**不含** `runContextId`、**不含** Snapshot/ModelView 正文、**不含**路径与密钥）；仅用于显示与用户确认 |
| iframe → 宿主 | `model-call-request` | `{ requestId, messages }` —— **只传消息**；出现 `runContextId` / `worldId` / `revision` / `selection` / `consumer` 任一字段 → 宿主**丢弃该请求并记审计**，不转发 |
| 宿主 → iframe | `model-call-result` | `{ requestId, content, contextSummary?{ worldName, revision, selectedCount } }`（不含 `runContextId`、不含 ModelView 正文） |

**其它冻结行为**

- 旧 iframe 未实现新消息时：按 v1 旧协议继续运行，其 `NarraverseSharedAI.chat()` 直调 `/api/model/chat` **不带世界上下文**，行为与 Phase 2B 基线完全一致（§9.4）；宿主不得为其伪造上下文。
- 旧 iframe 的 `world-context-changed` 摘要可作为只读展示；宿主 → iframe 消息不得携带任何写 World 的指令。
- iframe 内不得缓存 ref/摘要以外的世界数据；不得把摘要写入自身持久化存储。
- Module4 复用同一消息与受控入口，不另建 Module4 专属模型配置。

**iframe 受控入口规则（3.2-C0 强制门）**

- **当前禁用**：在 3.2-C0 通过前，这两个受控入口不存在；iframe 继续直调旧 `/api/model/chat`，但该通用入口拒收所有世界上下文字段。
- **未来协议**：iframe 只允许通过 `model-call-request` 把 `{ requestId, messages }` 交给宿主；`Ref`、`runContextId`、`scopeKey`、`sourceRef`、`runSalt` 与未来 capability 一律不下发 iframe。
- **未来强制**：3.2-C0 必须选定并验证 §7.6 的真实来源隔离；随后由 3.2-C 按冻结方案实现宿主代理。宿主必须重新构造受控请求，不得把 iframe 原始请求原样转发。

### 6.5 分路径行为契约与清理粒度

| 路径 | 世界上下文行为 |
| --- | --- |
| 写作 `/api/chat` 首次请求 | 带 Ref → 校验、创建 runContext（consumer=writing，scopeKey 见 §6.3）、注入只读 ModelView |
| 写作 SSE stream / reconnect / active | 服务端凭既有 task/run 关联取回 runContext 与同一份 bytes；客户端和宿主**不提交** `runContextId`，也不再接收/采信另传的 Ref |
| 写作 `/api/chat/context-analysis` | 返回该 runContext 的**同一份 `finalModelViewBytes`** 与来源映射；无绑定则返回「无世界上下文」 |
| writing / game 的 `context-analysis` | **无需 task 锚点**：建 **pending context** 并签发唯一 opaque `analysisHandle`；首次 chat 携带 `analysis_handle` 时原子认领并建立运行身份（writing=Task；game=InteractiveRun+Task），再完成 runContext 迁移；无有效上下文时 `context_state='none'`。iframe consumer 本期无 analysis 路径。 |
| 写作 regenerate / abort 后续取 | 沿用原 runContext（同一 task）；用户改了选择 → 以新 Ref 起**新 run** |
| 游戏 `/api/interactive/chat`、turn / branch / active / regenerate | 服务端凭既有 **`story_id`/`branch` + `interactiveRunId`** 关联取回 runContext（**不含 task**，§6.3.2）；**branch 切换 = 新的服务端内部 scopeKey / 新 runContext**；**普通新回合（非 regenerate）= 新 InteractiveRun = 新 runContext**（§6.3.2 规则 7）；regenerate 经 `regenerate_from_turn_id` 找回原 InteractiveRun 复用同一条；客户端不提交 `runContextId` 或 scopeKey，Actor/Director 逻辑不读取 World 写接口 |
| 叙界 / Module4 | **3.0B 不接入**。3.2-C0 安全门通过后才允许宿主按 §6.4 代办，consumer 由受控入口路由固定。 |

**清理粒度（冻结，四档）**

1. **scope 事件（最优先，即时）**：写作上下文被用户显式结束 / 清除；**游戏 InteractiveRun 结束**（**非**单次 Task 结束——abort 只结束当前 Task，§6.3.2 规则 3）或 branch 切换/删除 → 立即解绑对应 runContext（`refCount--`）。iframe 实例卸载 / adventure 结束的精确清理事件留到 3.2-C0 冻结，3.0B 不注册此类 scope。
2. **空闲 / 绝对 TTL**：`runContextIdleTTL = 30min`（每次使用刷新）；`runContextMaxTTL = 6h`（强制解绑）。
3. **ProjectionBody 释放**：`ProjectionBodyCacheEntry` 的 `refCount == 0` 且空闲 ≥ 30min 才释放；容量兜底按 LRU（32 条 / 8 MiB）先淘汰 `refCount == 0` 的条目，仍有压力时才淘汰 `refCount > 0` 的最久未用条目（被淘汰者的后续请求 → `context_unavailable`）。
   - runContext 自身携带的 `finalModelViewBytes` / `sourceRefTable` / `runSalt` 随该 runContext 一起释放，**不单独缓存、不跨 run 复用**。
4. **全量**：Denova 进程重启 → 两级注册表清空。

**其它清除语义**

- **用户「清除上下文」**：立即解绑**该 consumer 的当前 scope**（只影响该实例/任务/分支），其余实例不受影响；该模式回到无 World Context 基线；已在途请求继续用其已注入的 ModelView 直到结束。
- **切换世界 / 改选择**：新 fingerprint → 新 runContext（旧 runContext 按 TTL 自然回收）。
- **revision 变化（409）**：提示「世界背景已更新」，用户回控制台重新确认后以新 Ref 启动新 run；不自动热替换。
- **页面重挂载**：3.0B 的 writing/game 活动 run 凭服务端 Task / InteractiveRun 关联恢复上下文显示；无活动 run 或已过期时允许丢失（降级为无上下文）。iframe 重挂载语义留到 3.2-C0。
- **World 在运行期间被归档**：已绑定的不可变 ModelView 可继续用到本次请求/run 结束；**新请求**一律 `world_archived` 拒绝加载上下文（§9.2）。

### 6.6 runContext 生命周期状态机（v2.7：analysis run → 运行身份绑定）

**载体分类（冻结）**

| 载体 | 说明 | 是否产出模式内容 | 绑定锚点 |
| --- | --- | --- | --- |
| **analysis（pending context）** | `context-analysis` 预览（本期仅 writing / game） | **否**（只读展示） | 无需 task 锚点：analysis 先建 pending 态 runContext 并签发唯一 opaque handle；首次 chat 原子认领后，writing 迁移到 Task，game 迁移到 InteractiveRun。iframe consumer 本期无 analysis 路径。 |
| **Task / InteractiveRun** | writing Task；game InteractiveRun（含该回合的多个 Task，§6.3.2） | 是 | 服务端 `task.ID()`（writing）或 `story_id+branch+interactiveRunId`（game）。iframe 会话延后到 3.2-C0。 |

**analysis 绑定规则（v2.7 冻结）**

1. **不产生游离身份**：pending context 就是 runContext 的 pending 态；迁移只改归属锚点（writing→Task，game→InteractiveRun），**不换 id、不换 `runSalt`、不换 ModelView 字节**。
2. **先分析后聊天**：analysis 建 pending context + 唯一 handle；首次 chat 先原子认领 handle，再建立运行身份并迁移。后续请求走 Task / InteractiveRun 关联复用，不新建第二个 runContext。
3. **同 fingerprint 重复分析**：同一 `(consumer, sessionKey, contextFingerprint)` 只保留**一个**未消费、未过期 handle；重复 analysis 幂等返回同一个 handle，不延长 TTL。
4. **展示 = 模型实际看到**：analysis 返回该上下文的同一份 `finalModelViewBytes`；无有效上下文且无法建立时返回 `context_state='none'` 的「无世界上下文」（正常结果，非 4xx）。
5. **不落库**：analysis 自身不写任务日志、不写故事存档、不产生模式内容；pending → 运行身份的迁移也不写任务日志；runContext 仍仅内存。
6. **analysisHandle**：每个 pending context 只有一个短期、单次消费的 opaque handle（§6.7）；前端只可见 `analysisHandle` 与 `expiresAt`。

**五态操作（冻结）**

| 操作 | 触发 | 服务端动作 | 结果 / 错误 |
| --- | --- | --- | --- |
| **create** | 首次 bind（`world_context: Ref` 或有效 `analysis_handle`；由服务端 writing Task / game InteractiveRun 派生 scope） | 校验 revision / selection / 预算 → body 命中缓存或新生成 → 生成 `runSalt` → 物化 ModelView → 建 runContext，并在模型启动前完成运行身份绑定 | `context_state='bound'`；3.0B 的 runContextId 仅为服务端内部字段，不在响应中下发 |
| **reuse** | 同 scope + 同 fingerprint 的续接（stream / active / analysis） | 命中 → 复用同一 runContext 与同一 `finalModelViewBytes`；**不重算 body、不重新随机化** | `context_state='active'` |
| **reconnect** | SSE 重连 / 页面重挂载 | 凭服务端 Task / story + branch + InteractiveRun 关联恢复；**不重建** | `active`；若已过期 / 被淘汰 / 进程重启 → `context_unavailable`（降级）。iframe 重连留到 3.2-C0 |
| **regenerate** | **新建一次 Task** 的重新生成：writing 沿用同一 `task:<serverTaskId>`；game 经 **`regenerate_from_turn_id`** 找回同一 InteractiveRun（§6.3.2 规则 2） | **复用同一 runContext**（同一世界背景）；**不新建 InteractiveRun**；`runSalt` 与 ModelView 字节保持不变 | `active` |
| **destroy** | **scope 结束**：writing 上下文被显式结束/清除；game **InteractiveRun 结束**或 branch 切换/删除；用户「清除上下文」／TTL／LRU／进程重启 | 解绑并释放 runContext（`ProjectionBody.refCount--`） | 后续请求 `context_unavailable`（降级）。iframe/adventure 的销毁事件留到 3.2-C0 |

**边界规则（易错点，冻结）**

- **regenerate ≠ 换背景**：regenerate 沿用原 runContext；只有用户**改了 selection/World**（新 Ref）才走新 run（§6.3.1 bind 替换语义）。
- **Task 结束 ≠ InteractiveRun 结束（v2.5 修正）**：Task 只是**一次执行尝试**；**abort / 取消只结束当前 Task**，InteractiveRun 与其 runContext **保留**，用户可继续 regenerate 或推进。只有 **InteractiveRun 结束 / branch 切换或删除 / 实例级 scope 事件**才解绑 runContext——**不得**把「task 完成/取消」直接当作销毁 run 的触发条件（game 侧尤须注意，§6.3.2）。
- **reconnect 不新建**：仅在 runContext 已过期 / 被 LRU 淘汰 / 进程重启后失败；失败一律 `context_unavailable`，**不重建、不追溯旧 Ref**。
- **bare ≠ destroy**：bare（§7.5）不释放绑定；连发 bare 不会解绑，解绑只能走 scope 事件或用户显式「清除上下文」。
- **create 幂等**：同 `(consumer, scopeKey)` 重复 bind 且 fingerprint 相同 → 复用同一 runContextId 与同一 ModelView（不重复计 `refCount`）。
- **pending 迁移只发生一次**：handle 必须先以注册表 CAS/互斥锁从 `pending` 原子转为 `claimed`；并发请求只有一个能认领。迁移完成后锚定到 writing Task 或 game InteractiveRun，重复消费按 `ignored_consumed` 回落常规解析。
- 任何状态都**不写 World**、不写任务日志 / 故事存档 / 导出。

### 6.7 analysisHandle 生命周期（v2.7：原子认领 + 分 consumer 迁移）

**冻结流程（v2.5：`analysisHandle` 是「先分析、后建 task」的桥，analysis 阶段**不要求** task 锚点）**

```
① context-analysis（仅 writing / game；此时可能还没有运行身份）
        │  校验 revision / selection / 预算 → 生成或命中 ProjectionBody
        ▼
② pending analysis context            ← 内存中「待认领」的上下文（无 task 锚点）
        │  与 runContext 同生命周期规则，但状态为 pending
        ▼
③ opaque analysisHandle               ← 服务端签发，前端只看到 handle + expiresAt
        │
        ▼
④ 首次 chat 携带 handle
        │  服务端校验后原子 CAS：pending → claimed
        ▼
⑤ 建立运行身份并迁移
        ├─ writing：分配 Task ID → 锚定 Task
        └─ game：创建 InteractiveRun → 锚定 run → 分配其下 Task ID
        │  复用同一 runContextId / runSalt / finalModelViewBytes
        ▼
⑥ 标记 consumed → 启动 Task goroutine；后续按运行身份复用
```

**关键修正**：analysis 可以先于运行身份发生。首次 chat 消费时，writing 锚定 Task，game 锚定 InteractiveRun；不再用“统一迁移到 task”的旧说法。

**三者关系（冻结）**

```
pending analysis context ──签发──▶ opaque analysisHandle
            │                              │
            │  首次 chat 消费 handle        │ 短期、单次、可过期
            ▼                              ▼
      runContext（迁移后）◀──绑定── Task（writing）/ InteractiveRun（game）
```

- `analysisHandle` **不是身份**：只是「本次分析结果对应哪份 pending context」的**短期单次引用**；它不新建 runContext（pending context 本身就是 runContext 的 pending 态）、不替代 `runContextId`、不参与 `scopeKey`。
- **pending context 就是 runContext 的 pending 态**：两者是同一条记录的两个阶段（§6.6 载体表），迁移只改归属锚点，**不换 id、不换 `runSalt`、不换 ModelView 字节**。
- 同一 `(consumer, sessionKey, contextFingerprint)` 同时最多有**一个**有效 handle；重复 analysis 返回同一个 handle，避免一个 pending context 被多个 handle 竞争消费。

**数据结构（冻结）**

```
// 服务端内部记录（永不出服务端边界）
interface AnalysisHandleV1 {
  analysisHandleId: string        // 服务端 CSPRNG 生成；不可推导、不可枚举
  pendingContextRef: string       // 指向 pending 态 runContext（内部标识，不下发 iframe）
  consumer: 'writing' | 'game'
  contextFingerprint: string      // 与所引用上下文一致
  issuedAt: number
  expiresAt: number               // 短期：≤ 10 分钟（不因 task 存在与否而改变）
  status: 'pending' | 'claimed' | 'consumed' | 'invalidated'
  claimId?: string                // 服务端内部 CAS 所有权；永不下发
  consumedAt?: number
  usage: 'analysis'
}

// 前端可见的全部内容（v2.5 冻结）
interface AnalysisHandleViewV1 {  // 前端只能看到这两项
  analysisHandle: string          // opaque，无结构、不可解析
  expiresAt: number               // 过期时刻（用于前端提示与去重）
}
```

**生命周期（create / reuse / consume / expire / invalidate）**

| 操作 | 触发 | 行为 |
| --- | --- | --- |
| **create** | `context-analysis` 调用（**不要求已有 task**） | 校验 → 生成/命中 body → 建 **pending context** → 签发 opaque handle；响应只回 `analysisHandle` + `expiresAt` |
| **reuse** | 同一 `(consumer, sessionKey, contextFingerprint)` 且未消费、未过期时重复 analysis | **幂等复用同一 handle**（便于前端去重）；不跨会话复用、不新建上下文、不重置 TTL 上限 |
| **consume** | 首次 chat 携带该 handle | 原子 `pending→claimed` → 建立运行身份 → 迁移到 writing Task / game InteractiveRun → `claimed→consumed` → 才允许 Task goroutine 执行 |
| **expire** | 到达 `expiresAt`，或进程重启 | handle 与 pending context 一并失效（**不报错**）；再次 analysis 时重新签发 |
| **invalidate** | selection / World revision 变化（新 Ref）、用户「清除上下文」、上下文被 destroy | 立即作废；旧 handle 不得指向新上下文 |

**硬性禁令（冻结）**

1. **短期存在**：`expiresAt - issuedAt ≤ 10 分钟`；**不续期**；不得把有效期延长；不得当作会话标识。
2. **不进入任务日志**：`analysisHandleId`、handle 明文、`claimId`、其指向关系与 `pendingContextRef` 不得写入任务日志、故事存档、导出包或通用日志；日志只允许记哈希与计数。
3. **不作为长期身份**：handle 不能用于 resume、不能替代 `runContextId`、不能跨运行身份复用，也不是授权凭证。
4. **前端可见面最小化**：前端（含宿主页面 JS）**只能看到 `analysisHandle` 与 `expiresAt`**；`analysisHandleId` / `pendingContextRef` / `contextFingerprint` / `consumedAt` 一律不可见。
5. **不下发 iframe**：handle 只在宿主/前端与同一 consumer 的服务端之间流转；iframe 全程不可见（§6.4）。
6. **单次消费**：一个 handle 只能被消费一次；重复消费 → 视为无效 handle（按未携带处理，回落到该请求的常规绑定解析）。

#### 6.7.1 `analysis_handle` 请求字段契约（v2.6 新增，冻结）

v2.5 定义了「首次 chat 消费 handle」，但**未冻结该 chat 请求如何携带 handle**；本小节闭合此缺口。

**新增合法请求字段（冻结）**

| 入口 | consumer | 新增字段 | 语义 |
| --- | --- | --- | --- |
| `POST /api/chat` | `writing` | **`analysis_handle?: string`**（可选、opaque） | 首次 chat 携带，表示「沿用这次 analysis 产出的上下文」 |
| `POST /api/interactive/chat` | `game` | **`analysis_handle?: string`**（可选、opaque） | 同上 |
| `POST /api/world-context/*/model-call` | `narraverse` / `module4` | **不存在（3.0B）** | 仅为 3.2-C0 预留；iframe 路径无 analysis 阶段，handle 永不经此提交 |

- **这是唯一合法的 handle 提交位置**：除上表两个入口外，任何其它位置（查询串、header、iframe 消息、其它请求体字段）出现的 handle 值一律忽略并记脱敏审计。
- 与 `world_context` 的互斥关系：二者可同时出现；若同时出现且 fingerprint 不一致 → 按 `world_context`（新 Ref）优先，handle **作废**（不迁移）；若一致 → 正常消费 handle。

#### 6.7.2 严格解码规则（v2.6 新增，冻结）

服务端对 `analysis_handle` 必须**先严格解码、后使用**；**任一规则不满足即判定为非法 handle**（`analysis_handle_invalid`），不得尝试"尽力解析"。

| 检查 | 规则 | 不满足 |
| --- | --- | --- |
| 类型 | 必须是 `string` | 非法 |
| 空值 | 非空、非纯空白；`""` 视为**未携带**（等同字段缺失，不是错误） | `""` → 按未携带处理 |
| 字符集 | 仅 `[A-Za-z0-9_-]`（base64url） | 非法 |
| 长度 | 32～128 字符 | 非法 |
| 不透明性 | 值必须由服务端 CSPRNG 生成，不能采用 JWT、JSON 或编码业务字段；服务端只做**整串查表**，不得尝试解码或解析客户端内容 | 非法 |
| 存在性 | 必须命中服务端内部 handle 表 | 非法 |
| consumer | 必须与当前路由的 consumer 一致 | 非法 |

- **严格解码失败一律不阻断用户请求**：handle 被**忽略**，本次请求回落到**常规绑定解析**（等同于不带 handle）；同时在响应中回 `analysis_handle_status`（见 §6.7.4）。
- **不得**因 handle 非法就返回 4xx 阻断 chat；也**不得**用非法 handle 去做任何迁移。

#### 6.7.3 原子消费与 Task 启动顺序（v2.7，冻结）

当前 `NewTask` 会在返回前立即启动 goroutine，因此不能“先启动 Task、后迁移上下文”。实现必须对 Task 创建路径做最小两阶段拆分：**分配 Task/ID** 与 **启动 goroutine** 分离；绑定或明确降级完成前，模型代码不得开始执行。

```
① 严格解码 analysis_handle                    → 失败：忽略 handle，走常规解析
        ▼
② 注册表锁内校验并原子认领：pending → claimed（写入唯一 claimId）
   并发第二请求看到 claimed/consumed → ignored_consumed，不得再次认领或继承该 pending context
        ▼
③ 准备运行时并建立身份（仍未启动模型 goroutine）
   ├─ writing：分配 Task 与 task.ID()
   └─ game   ：先生成 InteractiveRun → 再分配其下 Task / task.ID()
        ▼
④ 迁移 runContext 并登记映射
   writing → task.ID(); game → interactiveRunId，并写 TaskRunIndex
        ▼
⑤ 注册表锁内校验 claimId，claimed → consumed（consumedAt=now）
        ▼
⑥ 启动 Task goroutine；其第一轮模型调用使用已绑定的同一份 ModelView
```

**失败原子性**：步骤③前失败按 §6.7.4 回落；步骤③～⑤失败时不得启动该次预分配 Task。若尚未产生运行身份，可在持有同一 `claimId` 时回退为 `pending`；一旦产生任何身份或映射，则把 handle 标记 `invalidated` 并清理该次未启动身份，禁止重试复用半成品。请求若仍满足既有 chat 契约，可在清理完成后按**独立的常规请求**重新分配身份；它只能使用自己携带的有效 Ref 或 bare，绝不能继承失效 handle 的 pending context。不得出现“模型已经开始、上下文随后才绑定”的窗口。

#### 6.7.4 消费失败语义（v2.6 新增，冻结）

| 失效原因 | 判定 | 服务端行为 |
| --- | --- | --- |
| `analysis_handle_invalid` | 解码失败 / 查表未命中 / consumer 不一致 | handle 忽略 → 常规绑定解析；不阻断 |
| `analysis_handle_expired` | `now > expiresAt` | 同上；handle 与 pending context 一并清理 |
| `analysis_handle_consumed` | 状态为 `claimed` / `consumed` / `invalidated`（重复、并发或半成品已清理） | 同上；**不得**二次迁移 |
| `analysis_handle_conflict` | 同时带 `world_context` 且 fingerprint 与 handle 不一致 | 以 `world_context` 为准起新 run；handle 作废 |

- **统一非阻断原则**：handle 失效**不阻断**用户本次 chat，也**不改变** `context_state` 的既有语义；响应中附加：
  ```
  analysis_handle_status?: 'consumed' | 'ignored_invalid' | 'ignored_expired'
                          | 'ignored_consumed' | 'ignored_conflict'
  ```
  前端收到非 `consumed` 时**可**提示「上下文预览已过期，请重新分析」，但**不得**自动重发 analysis。
- **不得静默降级为裸跑**：handle 失效回落到常规解析后，若该 scope 本就无绑定 → 正常 `context_state='none'`（bare，§7.5）；**不得**因为「曾有 handle」就伪造一个上下文。
- **错误码归属**：上述四类是提示性状态，不是 §9.2 的阻断型错误码；不得混进 `context_state` 的降级判定。

## 7. consumer 可信边界（受控入口 + 宿主绑定）

### 7.1 冻结：服务端受控模式入口 + 宿主代办

**consumer 永远由服务端路由/调用上下文决定，客户端（含 iframe）不得提交。**

| 受控入口 | 服务端固定 consumer | 说明 |
| --- | --- | --- |
| `POST /api/chat`（既有） | `writing` | 请求体若声明其它 consumer → 忽略并记审计；世界上下文只经 `world_context: Ref`；**新增可选 `analysis_handle?: string`（§6.7.1）**；**scope 由服务端从本次 `StartTask` 的 `task.ID()` 内部派生，不新增其它字段**（§6.3 A 类） |
| `POST /api/interactive/chat`（既有） | `game` | 同上；**新增可选 `analysis_handle?: string`（§6.7.1）**；scope 由服务端从既有 `story_id`/`branch` + **服务端 `interactiveRunId`** 派生（**不含 task**，§6.3.2 / §6.3 A 类）；消费 handle 时**先建 InteractiveRun 再建其下 Task**（§6.7.3） |
| `POST /api/world-context/narraverse/model-call`（**3.2-C0 预留，3.0B 禁止创建**） | `narraverse` | 只有 §7.6 独立安全门通过后才可确定并启用契约；当前不存在。 |
| `POST /api/world-context/module4/model-call`（**3.2-C0 预留，3.0B 禁止创建**） | `module4` | 同上；当前不存在。 |
| `POST /api/model/chat`（既有，**降级**） | — | **仅旧 iframe 兼容**：不承载世界上下文；出现 `world_context` / `consumer` / `run_context_id` / `scopeKey` 任一字段 → `consumer_not_trusted` |

未来 iframe 受控入口只冻结以下**不变量**（**非 3.0B 实施项；请求字段、签发和续接协议必须由 3.2-C0 重写**）：

- **不是第二套模型调用链**：未来入口只能复用既有模型网关与 provider 兼容层，并在服务端注入只读 ModelView。
- **拒绝客户端正文与自由权限参数**：不接受客户端 Snapshot / ModelView / 系统 Prompt / 字段白名单扩展 / 自造 consumer、scopeKey 或运行身份。
- **安全门先于路由**：3.2-C0 独立安全复审通过前不得注册相关路由；`worldId`、revision、随机 ID 本身均不构成授权。
- **秘密不落 iframe**：无论 3.2-C0 最终选用何种机制，iframe 都不得持有 Ref 权威副本、runContext 内部标识、capability 或 sourceRef。
- **bare 保持基线**：未建立可信宿主代理时，Narraverse/Module4 只能使用既有 `/api/model/chat` 的无世界上下文行为；不得以“兼容”为名隐式注入 World。

### 7.2 最小权限与同构白名单

- 四 consumer 共用同一基础字段白名单；未来确需差异化（如沙盒需要更多规则）必须在服务端以「consumer → 允许字段集」的**收紧**表实现，默认收敛、不可由客户端扩大。
- 所有入口继续受 Denova 既有本地/远程访问控制约束，不新增匿名 World 读取通道。
- 加载上下文的前提：用户显式从某 World Console 进入；World id 合法、存在、active；revision 匹配；selection 合法；预算未超。

### 7.3 iframe 信任边界与越权处置

- `world-context-changed` / `model-call-request` / `model-call-result` 均校验同源、来源 window 必须是**当前已挂载**的 iframe、协议版本与消息类型；忽略任何其它来源 window 的同名消息。
- **越权处置（冻结）**：`model-call-request` 出现 `runContextId` / `scopeKey` / `worldId` / `revision` / `selection` / `consumer` 等任一保留字段 → 宿主**丢弃**、记审计（脱敏）、回 `model-call-result{ error: 'consumer_not_trusted' }`，**不转发**给服务端。
- **当前行为**：`/api/world-context/*/model-call` 尚不存在，iframe 无法直呼；通用 `/api/model/chat` 拒收世界上下文字段。未来直呼如何由技术手段拒绝，必须由 §7.6 的 3.2-C0 安全设计明确。
- **宿主须重新构造请求**：宿主不得原样转发 iframe 请求（除 `messages` 外的字段一律剥除），并按本表丢弃越权字段。
- 消息方向控制：宿主 → iframe 只传只读摘要（§6.4）；iframe → 宿主不得请求写 World。
- 不在 iframe 内拼装完整 World，不存放可寻址凭证；`sourceRef` 与 `runContextId` 均不可用于寻址或写入。

### 7.4 迁移与兼容（旧 iframe 行为不变）

- 旧 iframe（未实现新消息）：继续直调 `/api/model/chat` 且**不带世界上下文**，行为与 Phase 2B 基线一致；本期不要求旧 iframe 改造。
- 新 iframe：优先走宿主代办；若宿主不支持 `model-call-request`（协议版本未协商），回退为「无世界上下文直调」，并显式提示「本次未携带世界背景」。
- 任何回退都不得伪造世界上下文，也不得把回退文本伪装成已加载背景。

### 7.5 受控入口「无上下文（bare）」规则（v2.2 补强，冻结）

受控入口的上下文状态由**服务端适配层解析结果**决定，不能只按请求中是否出现 `world_context` 机械判断。3.0B 只定义既有 `/api/chat`、`/api/interactive/chat` 的服务层契约；二者仍保留各自业务字段且不新增 `run_context_id`。iframe 入口字段留到 3.2-C0：

| 入口与形状 | 世界上下文控制字段 / 服务端身份 | 语义 |
| --- | --- | --- |
| 原生 bind（写作 / 游戏起始或主动重绑） | `world_context: Ref` 或有效 `analysis_handle`；服务端从 writing Task / game story + branch + InteractiveRun 派生内部 scope | 按 §6.3.1 upsert runContext，注入只读 ModelView |
| 原生 active（续接 / stream / reconnect / regenerate） | 客户端不传 Ref、`run_context_id` 或 scopeKey；服务端凭 writing Task / game story + branch + InteractiveRun 找到绑定 | 复用已绑定 runContext，`context_state='active'` |
| 原生 **bare** | 本次服务端运行身份没有绑定，且请求未主动 bind | 本次不携带世界背景，`context_state='none'` |
| iframe bind / resume / bare | **3.2-C0 预留，3.0B 不存在** | 只有真实来源隔离与数据连续性方案通过后才能冻结并启用。 |

**bare 请求规则（冻结）**

1. **一等支持、非错误**：bare 的判定条件是「当前受控适配层未解析到活动绑定，且本次请求未要求 bind/resume」，不是“请求里刚好没有两个字段”；consumer 仍由路由固定。bare 不创建 runContext、不读 World、不生成 Snapshot/ModelView、不占两级注册表名额与 `refCount`、不触发任何 Master 请求；`messages` 直接走既有模型链，与 Phase 2B 基线一致。
2. **显式状态字段 `context_state`**：3.0B 的 writing/game 服务层结果带该字段——bind 成功 = `bound`、续接命中 = `active`、bare = `none`、§9.2 允许的错误降级 = `degraded`。前端据此区分「用户本次主动不带背景（none）」与「想带但失败被降级（degraded）」，**禁止把 degraded 伪装成 none**；bare 不返回任何 runContext 内部标识。iframe 响应形状留到 3.2-C0。
3. **不隐式升级、不隐式解绑**：原生续接先按服务端既有 Task / InteractiveRun 关联解析 active；只有适配层最终解析为 bare 时才不注入。bare **不解除**任何仍存活的绑定（其 runContext 继续按 TTL 存活）。「清除上下文」只能走显式 unbind（§6.5），不能用连发 bare 代替。iframe resume 规则留到 3.2-C0。
4. **可交替、无需重启**：同一 writing/game 会话内 bare 与 bind/active 可逐请求交替，每次独立判定 `context_state`；runContext 生命周期只受 bind/显式 unbind/运行身份事件/TTL 影响，不受 bare 影响。
5. **context-analysis**：服务端按该入口既有运行身份解析后无绑定（或本次为 bare）时，返回 `context_state: 'none'` 的「无世界上下文」，属正常结果而非 4xx。
6. **不得成为错误绕过通道**：bare 不带 Ref，因此本就不触发 selection/revision/预算校验；反过来，任何**带了 Ref** 而命中 `selection_invalid`、`revision_conflict`、非窗口类 `budget_exceeded`、`world_archived` 的请求，**不得**改成「吞掉上下文当 bare 放行」，降级白名单仍严格以 §9.2 为准。
7. **通用网关与旧 iframe**：`/api/model/chat` 对世界上下文**永远等价 bare**，且一旦出现 `world_context` / `consumer` / `run_context_id` / `scopeKey` 即 `consumer_not_trusted`（§7.1）；旧 iframe 直调天然为 bare、无上下文（§7.4）。

### 7.6 Phase 3.2-C0 Capability 安全门（v2.7：未冻结，不属于 3.0B）

**v2.7 裁定**

- 当前系统没有真实 host trust root。顶层 React 宿主与 iframe 同源、iframe 无 sandbox；任何纯 HTTP bootstrap 都无法证明调用来自顶层宿主。
- v2.6 的“进程外注入方式三选一 + iframe 隔离方式三选一”不是冻结方案：浏览器页面不能直接读取任意临时文件/本地 socket；不含 `allow-same-origin` 的 sandbox 会使现有 IndexedDB/localStorage 不可用；改变 origin 又会产生用户运行数据迁移问题。
- v2.6 还存在“一次性 secret 只签发一次”与“一个宿主为多个 iframe 分别签发 capability”的直接冲突。因此 v2.6 的 bootstrap/capability 细节整体降级为**历史候选，不可作为实现依据**。

**3.0B 的强制边界**

1. 不创建 host bootstrap、host capability、iframe bind/resume 或 `/api/world-context/{narraverse|module4}/model-call`。
2. `/api/model/chat` 继续兼容旧 iframe，但拒收 `world_context`、`consumer`、`run_context_id`、`scopeKey` 等世界上下文字段；旧 iframe 只能 bare。
3. 3.0B 仅冻结并实现与 iframe 无关的 Snapshot/runContext 核心，以及 writing/game 的服务端受控契约。

**3.2-C0 开工前必须提交并通过的独立安全设计**

1. **只选一个来源隔离机制**，不得再保留 A/B/C 多选；必须用当前 Windows executable + 外部浏览器实测证明 iframe 与宿主可区分。
2. **只选一个 bootstrap 交付通道**，写清生成、交付、销毁和泄漏面；`Origin`/`Sec-Fetch-*` 只能做辅助校验，不能单独充当授权。
3. 若改变 sandbox/origin，必须提供现有 `app/` IndexedDB/localStorage 数据的无损迁移、回滚与正式 executable 验收；未解决数据连续性不得上线。
4. 明确“一次 bootstrap 建立宿主会话、宿主会话签发多个 iframe capability”或“每 iframe 独立 secret”中的**唯一一种**，并冻结多 iframe、refresh、revoke 与进程重启语义。
5. 安全设计通过之前，3.2-C / 3.2-D 不得开工；这不阻塞 3.0B、3.1、3.2-A、3.2-B。

以下 §7.6.0～§7.6.3 仅保留用于解释 v2.6 为什么未通过，**全部非规范、已作废**。

#### 7.6.0 v2.6 信任根前提（历史候选，已作废）

- iframe 视作**完全不可信的前端**：不持有任何能力凭证、**不能申请 capability**、不能触发世界上下文加载、不能影响绑定、不能读取任何内部状态。
- **「iframe 不能申请」必须由技术手段保证，不能只靠声明（v2.6 强化）**：当前 iframe **同源且无 sandbox**，纯 HTTP 无法区分它与顶层宿主 ⇒ v2.6 冻结 **Denova 一次性 bootstrap secret + 强制配套（sandbox / 独立 origin / native bridge 三选一）**（§7.6.1）。**未实现配套 ⇒ 信任根不成立。**
- **capability 只能由宿主申请，且只能由服务端签发**（详见 §7.6.1）：
  - iframe → 宿主：只有 §7.3 的 `model-call-request{ requestId, messages }` 一条通道；**不存在**「iframe 向服务端申请 capability」的接口。
  - 服务端**不得**提供任何「凭 iframe 自报身份即可换取 capability」的端点；`iframeInstanceRef` 由**宿主**在 bootstrap 时上报，服务端**不接受** iframe 自行提交的同名字段（出现即忽略 + 审计）。
- **`worldId` / `revision` 不是授权**：它们只用于「目标定位 + 一致性比对 + 显示」。请求里带上它们**不产生任何权限**；服务端绝不会因为调用方声明了 `worldId`/`revision` 就信任它。
- **授权来源只有三层（穷举，冻结）**：① **路由固定的 consumer**（`/api/chat`=writing、`/api/interactive/chat`=game、`/api/world-context/narraverse|module4/model-call`=对应 iframe consumer）；② **服务端签发的 host capability**（不透明令牌，§7.6.2）；③ 服务端在 bind 时**派生/生成的内部绑定**（scopeKey / runContext）。三者缺一不可用，客户端无法新增授权来源。

#### 7.6.1 v2.6 一次性 bootstrap secret（历史候选，已作废）

**问题陈述（v2.5 的缺陷，本版必须闭合）**

- v2.5 写的「宿主进程凭据 / 本地监听令牌」**在仓库中不存在**：当前宿主是**浏览器 React 页面**，没有进程级凭据，也没有安全 bootstrap 通道。
- iframe **同源且无 sandbox** ⇒ 顶层宿主与 iframe 能发出**完全一样**的 HTTP 请求（同 cookie、同 header、同 `Origin`、同 `Sec-Fetch-Site: same-origin`）。**纯 HTTP bootstrap 无法区分二者。**
- 因此：**仅声明「iframe 不能申请 capability」不构成技术边界**。必须冻结**具体可信来源**。

**冻结方案（v2.6）：Denova 进程生成一次性 bootstrap secret**

```
Denova 进程启动
   │ ① CSPRNG 生成 denovaBootstrapSecret（一次性；内存 + 进程外交付）
   │
   ├─② 非 HTTP 可枚举通道 ──▶ 交付给「顶层 React 宿主」
   │     例：启动器注入 window.__DENOVA_BOOTSTRAP_SECRET__
   │         / 本地临时文件（仅宿主可读）由宿主读取
   │         / 本地 socket / native bridge 握手
   │     ✗ 禁止：写入 localStorage / sessionStorage / cookie / 任何 iframe 可读存储
   │     ✗ 禁止：经 HTTP 响应体下发（否则同源 iframe 也能取）
   │
   └─③ capability 签发端点强制校验该 secret
         不匹配 / 已使用 / 已过期 ⇒ 拒绝签发（403 consumer_not_trusted）
```

**secret 规格（冻结）**

| 属性 | 冻结值 |
| --- | --- |
| 生成方 | **Denova 进程**（服务端本体），CSPRNG ≥ 32 字节 → base64url |
| 生命周期 | **一次性**：成功签发一次后立即作废 |
| 时效 | 生成后 **≤ 5 分钟**未使用即失效 |
| 存储 | **服务端仅内存**；宿主侧仅内存；**不得**写入 localStorage / sessionStorage / cookie / IndexedDB / 任何 Web 存储 |
| 传输 | 只经**进程外通道**注入顶层宿主；**不得**经 HTTP 响应体 / 任何同源 iframe 可读通道下发 |
| 校验 | 签发端点**强制**校验；不匹配 / 已用 / 过期 → 403 `consumer_not_trusted` + 审计（不回显原因差异） |

**为什么 iframe 取不到（冻结理由）**

1. secret 通过**顶层宿主的启动 / 注入通道**交付，iframe 作为子文档**不参与**该通道；
2. secret **不落任何 Web 存储**，iframe 的 JS 无法通过存储 API、`window.parent.*`、`document.*` 取得；
3. secret **不经 HTTP 下发**，iframe 无法通过网络嗅探或同源请求获得；
4. 配合下方「强制配套」后，服务端还能从传输层独立验证「请求来自顶层宿主」。

**强制配套（v2.6 必须同启其一，否则不得声称已建立信任根）**

仅靠 secret 仍依赖「iframe 拿不到注入值」这一**假设**；为形成**可在服务端独立验证**的技术边界，必须**同时**实现以下**之一**：

| 方案 | 机制 | 服务端可验证信号 |
| --- | --- | --- |
| **A · iframe `sandbox`（推荐）** | 给 world-context iframe 加 `sandbox` 属性，**不含 `allow-same-origin`** ⇒ iframe 变为**独立 origin** | `Origin` ≠ 宿主 origin；`Sec-Fetch-Site: cross-site`；服务端据此拒绝非顶层宿主的 bootstrap |
| **B · 独立 origin** | iframe 挂在独立子域 / 独立端口 | 同上（origin 可区分） |
| **C · native bridge** | Denova 原生层（Electron / 本地宿主）代理 bootstrap，浏览器 JS 全程不接触 secret | 请求来自本地进程的可信通道（非浏览器网络栈） |

- **v2.6 当时结论（已被 v2.7 取代）**：未实现 A / B / C 任一就不得声称已建立信任根。v2.7 已进一步裁定 3.0B **完全不含 capability**；本条不能再用于选择实现路线。
- 采用 A / B 后，`model-call-request` 仍需经 `postMessage` 并**校验 `event.origin` / `event.source`**（§7.3 已有同源校验，v2.6 升级为「预期 iframe origin」校验）。

**host bootstrap 流程（v2.6 更新：② 增加 secret 强制校验）**

```
① 宿主启动 / 首次挂载 iframe
        │  宿主已持有 denovaBootstrapSecret（进程外注入，仅内存）
        ▼
② 宿主 → 服务端：host bootstrap 请求
        （携带 denovaBootstrapSecret + iframeInstanceRef = 宿主本地索引键）
        │  服务端强制校验 secret（存在 / 未使用 / 未过期）+ 传输层信号（A/B/C）
        ▼
③ 服务端生成 HostCapabilityV1 → 只回给宿主一个 opaque token
        │  secret 立即作废；服务端内部保留 capabilityId / hostInstanceId / iframeInstanceRef / revoked
        ▼
④ 宿主内存保存 opaque token（不写 localStorage、不落盘、不下发 iframe）
        │
        ▼
⑤ 宿主代理受控调用时注入 token；服务端反查内部记录并逐项校验
```

| 步骤 | 谁发起 | 服务端动作 | 失败处理 |
| --- | --- | --- | --- |
| ① 挂载 | 宿主 | — | — |
| ② bootstrap | **宿主**（iframe 不可发起） | **强制校验 secret**（一次性）→ 校验传输层信号（A/B/C）→ 分配 `hostInstanceId`（首次）→ 记录 `iframeInstanceRef` | secret 缺失/已用/过期，或传输层信号不符 → 403 `consumer_not_trusted`，**不签发** |
| ③ 签发 | 服务端 | CSPRNG 生成 token → 内部表 `token_hash → capability` → **secret 作废** | — |
| ④ 存储 | 宿主 | 只存内存 | 宿主不得持久化、不得下发 iframe |
| ⑤ 使用 | 宿主代理 | 反查 → 校验存在 / 未过期 / consumer 匹配 / usage 覆盖 / 未 revoke | 任一不满足 → 403 `consumer_not_trusted` |

- **iframe 侧无 bootstrap**：iframe 不同源（A/B）或走不到本地通道（C），且拿不到 secret ⇒ **结构上不可能**完成步骤②。这是「iframe 拿不到 capability」的**可验证**技术原因，而非仅靠约定。
- **一个宿主实例可为多个 iframe 实例 bootstrap**，每个 `iframeInstanceRef` 对应独立 capability；卸载 iframe → 宿主发起 unbind → 服务端立即 revoke。

#### 7.6.2 v2.6 不透明令牌（历史候选，已作废）

**浏览器（含宿主页面 JS 与 iframe）只能看到一个不透明字符串，看不到任何内部字段。**

```
// 服务端内部记录（永不出服务端边界，永不下发浏览器）
interface HostCapabilityV1 {
  capabilityId: string            // CSPRNG 32B → base64url；不可推导、不可枚举
  tokenHash: string               // 下发令牌的哈希（服务端只存哈希）
  consumer: 'narraverse' | 'module4'
  hostInstanceId: string          // 服务端在宿主 bootstrap 时分配（宿主进程级）
  iframeInstanceRef: string       // 宿主 bootstrap 时上报的本地实例索引键
  issuedAt: number
  expiresAt: number               // 短期：≤ 15 分钟；可 refresh
  usage: 'bind' | 'resume' | 'analysis' | 'model_call'
  revoked: boolean                // 撤销标记
}

// 浏览器可见的全部内容（宿主内存保存；iframe 不可见）
type HostCapabilityToken = string   // opaque，无结构、不可解析、不可自证
```

**不透明性规则（冻结）**

| 内部字段 | 浏览器可见 | 说明 |
| --- | --- | --- |
| `capabilityId` | ❌ 不可见 | 内部主键；不在任何响应体 / 消息中出现 |
| `hostInstanceId` | ❌ **不可见** | 宿主进程级标识；bootstrap 时服务端内部绑定，不下发给宿主页面，更不下发 iframe |
| `iframeInstanceRef` | ❌ **不可见** | 宿主上报的本地索引；服务端内部记录，不回显 |
| `revoked` | ❌ **不可见** | 撤销状态只在服务端内部；被 revoke 后调用一律 403，客户端无法据此探测 |
| `tokenHash` | ❌ 不可见 | 服务端只存哈希，不存明文 |
| `expiresAt` / `issuedAt` | ✅ 宿主可见（数值） | 宿主可据 `expiresAt` 决定刷新时机；**不下发 iframe** |
| `consumer` | ✅ 宿主可见（枚举） | 便于宿主路由；**不下发 iframe** |
| `usage` | ✅ 宿主可见（枚举） | 便于宿主判断能否代理某类操作；**不下发 iframe** |

- **令牌本身无结构**：opaque token 是不可解析的随机串；**不得**把 `hostInstanceId` / `iframeInstanceRef` / `revoked` / `capabilityId` 编码进令牌，也不得使用 JWT 等可解码载体。
- **不下发 iframe**（与 `Ref` / `runContextId` / `scopeKey` / `sourceRef` / `runSalt` 同级秘密，§6.4「秘密不落 iframe」）：宿主 → iframe 只传**显示摘要**，绝不传 capability。
- **refresh / revoke**：宿主可在过期前滚动刷新（始终 ≤ 15 分钟窗口，刷新即换发新 token、旧 token 立即失效）；宿主卸载 iframe、用户清除上下文、runContext destroy、World 归档 → 服务端**立即 revoke**（其后调用一律 403）。
- **作用域最小化**：capability 仅对签发它的 `consumer` + `hostInstanceId` 有效；跨 consumer / 跨宿主实例使用 → `consumer_not_trusted`。

#### 7.6.3 v2.6 `consumer_not_trusted` 规则（历史候选，已作废）

**归属原则（先判归属，再判错误）**：`consumer_not_trusted` **只表示「调用方不被信任为某个 consumer 的合法代理」**，是**授权/信任**维度的拒绝；它**不表示**世界、selection、revision 或预算有问题。后一类一律归 §9.2（见归属表「不属于本条」列）。

| # | 触发条件 | 归属 | 处理 |
| --- | --- | --- | --- |
| 1 | 通用 `/api/model/chat` 出现 `world_context` / `consumer` / `run_context_id` / `scopeKey` / capability 任一字段 | **本条** | 403 `consumer_not_trusted`（**不降级、不 bare**） |
| 2 | 受控入口 `/api/world-context/*/model-call` **缺少有效 capability**（缺失 / 过期 / 已 revoke / consumer 不匹配 / usage 不覆盖） | **本条** | 403 `consumer_not_trusted`（**iframe 直呼天然落入此条**：结构性拿不到 token） |
| 2′ | **iframe 试图申请 / 提交 capability 或 `iframeInstanceRef`** | **本条** | 403 `consumer_not_trusted` + 审计；服务端无 iframe bootstrap 端点，此类请求无合法入口 |
| 3 | 请求体 / 查询串携带自造 `consumer` / `scopeKey` / `interactiveRunId` / `analysisHandleId` 等运行身份字段 | **部分归属** | **忽略其值 + 脱敏审计**；若同时试图据此绑定世界上下文 → 403；否则按该入口既有校验继续（不因出现该字段就一律 403） |
| 4 | 跨 consumer 复用 `runContextId` 或 capability | **本条** | 403 `consumer_not_trusted` |
| 5 | 客户端提交 Snapshot / ModelView / 系统 Prompt / 字段白名单扩展 | **本条** | 403 `consumer_not_trusted` |
| 6 | capability 校验**通过**，但 `worldId` / `revision` 与绑定不符 | **不属于本条** | 按 §9.2 处理（`revision_conflict` / `world_archived` 等） |
| 7 | capability 校验**通过**，但 selection 非法 / 超预算 / 目标 World 不存在 | **不属于本条** | 按 §9.2 处理（`selection_invalid` / `budget_exceeded` / `world_not_found`） |

**统一响应与审计（冻结）**

- 403 + 脱敏消息 + 审计（记 consumer、capability **哈希**、失败原因码；不记正文/路径/令牌明文）；**不得**回传内部细节（`hostInstanceId` / `iframeInstanceRef` / `revoked` / scopeKey / runContextId / 绑定关系）。
- **不泄露撤销状态**：被 revoke 与「从未签发」返回**同一**响应，客户端无法据此枚举或探测。
- **不与 bare 混淆**：bare 是「无世界上下文但被允许」的正常状态（`context_state='none'`）；`consumer_not_trusted` 是**拒绝**，**不得**被降级成 bare 放行（§9.2）。
- **旧 iframe 兼容**：旧 iframe 走 `/api/model/chat` 且不带世界字段 → 仍为 Phase 2B 基线行为，不触发本规则（§7.4）。

## 8. Timeline 3.0A 兼容策略

去 Canon 作为**独立、可回退的 3.0A 提交**，先于 3.0B；未完成前不得声称 Snapshot 契约已冻结。新枚举：`background | historical | planned`；旧 `canon` 仅兼容读取、按 `historical` 展示，不批量迁移文件。

### 8.1 六个必须回答的问题（v2.2 冻结决策）

**① 读取（映射层位置、空值与缺失）**

- 在**解码边界统一归一化**：Go（`internal/world` 读盘/校验前）与 TS（前端读取）各有一处 `normalizeTimelineCategoryForDisplay`。
- 归一化**只用于展示与 ModelView**，不改变磁盘值（保存规则见 ②）。
- 空值三类 + 未知值一律不判损坏，按下表处理。

**② 空值 / 缺失保真（v2.2 新增，八态冻结表）**

| 磁盘形态 | 读取归一化（展示 / ModelView） | UI 显示 | warning | **未编辑时保存** |
| --- | --- | --- | --- | --- |
| `"category":"background"` | `background` | 背景 | — | 原值 `background` |
| `"category":"historical"` | `historical` | 历史 | — | 原值 `historical` |
| `"category":"planned"` | `planned` | 规划 | — | 原值 `planned` |
| `"category":"canon"` | `historical` | 历史（旧数据） | `legacy_timeline_category` | **写回 `"canon"`** |
| `"category":"<未知非空>"` | `background` | 背景（旧数据） | `legacy_timeline_category` | **写回原字符串** |
| `"category":""` | `background` | 背景 | — | **写回 `""`** |
| `"category":null` | `background` | 背景 | — | **写回 `null`** |
| 字段缺失（无 `category` 键） | `background` | 背景 | — | **保持缺失：保存时不新增该键** |

- **判定「未编辑」**：提交值 == 该条目**磁盘原值的归一化展示值**（`canon→historical`、未知/`""`/`null`/缺失→`background`），且用户未在该会话显式改过分类。
- **用户显式选择三值之一** → 写新值（覆盖任何保真原值），此后该条目为显式枚举。
- 新建条目直接写 `background`（不产生空值形态）。
- **禁止静默规范化**：不得因为内存归一化结果而把 `canon` / 未知值 / `""` / `null` / 缺失改写为 `background`。

**③ 解码侧实现约束（必须，不可省）**

- 当前 `category` 为 `string + omitempty`，**无法区分 `missing` / `null` / `""`**；3.0A 必须在解码边界保留**原始形态**（四态），冻结两种可接受实现（推荐 ①）：
  1. 在 `internal/world` 为 timeline 条目实现自定义 `UnmarshalJSON`，用 `json.RawMessage` 记录 `category` 原始字节（`missing` 与 `null` 可区分），并随 World 对象以**非持久化**读取侧状态携带；
  2. 读取侧 sidecar（`timelineCategoryRaw map[entryID]rawState`），仅在内存中存在，**不落盘**。
- 无论哪种实现：**不得新增持久化字段**、不得改变现有 JSON 字段名与 schemaVersion、不得让保真状态进入 ModelView 或通用日志。
- 保真回写路径**跳过枚举白名单**（原值原样回写），但仍受其它字段校验与 schemaVersion 约束；用户编辑路径只接受 `background|historical|planned`。
- CAS：保真回写与用户编辑都走既有 `expected_revision` 整文档 CAS，除该条目的 category 外不得改动任何其它字段。

**④ 旧版本二进制（回滚）策略 —— 精确措辞**

- 「独立可回退」的**准确含义**：**代码提交可回退**；但**一旦有 World 以新三值落盘，旧二进制不再保证可读写该文件**（旧校验只认 `canon|planned`，会得到字段校验失败）。
- 3.0A 发布说明必须包含**升级栅栏**：升级前备份 `cfg.DataDir()/worlds`（或使用内置导出）；明确「升级后不要用旧二进制回写同一数据目录」；若不提供数据备份/恢复能力，必须显式声明单向升级，并说明旧版本打开含新枚举文件的**确定行为**（400 + 明确提示，而不是判损坏或静默丢字段）。
- **不**引入 schemaVersion=2（避免与既有 F-05 语义校验耦合）；若未来需要新旧二进制长期共存，再单独立项。

**⑤ CAS 与原子保存**

- 「读旧值 → 内存归一（仅展示）→ 保真写回」走既有 CAS；归一化本身不产生 `updatedAt` 之外的额外脏写（`updatedAt` 仍只在真实保存时刷新）。

**⑥ 默认值与 UI 文案**

- 新建默认 `background`；空值/缺失按 ② 显示；旧 `canon` 显示「历史（旧数据）」；未知值显示「背景（旧数据）」并带 warning；三值中文文案：背景 / 历史 / 规划。

### 8.2 3.0A 测试与边界

- 定向测试（**八态全覆盖**）：  - 读 `canon` → 展示 `historical`、**保存后磁盘仍是 `canon`**；
  - 读未知值 → warning 且不损坏，**保存后磁盘仍是原字符串**；
  - 读 `""` → 展示 `background`、**保存后磁盘仍是 `""`**；
  - 读 `null` → 展示 `background`、**保存后磁盘仍是 `null`**；
  - 读缺失字段 → 展示 `background`、**保存后该键仍不存在**；
  - 用户显式改分类 → 写新三值并可往返；
  - CAS 下其它字段不丢；旧 `planned` 保持不变；
  - 混合版本：新二进制保存过的文件，用旧校验路径读取时给出**确定错误**（非静默丢字段）。
- 断言方式：对同一文件做「保存前后**字节级**比对」（除 `updatedAt`），确保保真不靠语义近似。
- Snapshot 的 ModelView 只输出新三值；`historical` 仅表示「该 World 内用户维护的既有历史」，**不是**跨模式共同剧情真相。
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

**消费者窗口加固（v2.2 新增，先于公式）**

```
consumerReserveTokens = 4_096
if consumerContextWindowTokens <= consumerReserveTokens:      // 即 ≤ 4096
    → budget_exceeded（413），不进入估算、不调用模型
effectiveModelBudget = min(12_000, consumerContextWindowTokens − 4_096)
```

- 窗口 ≤ 4096 时**直接 `budget_exceeded`**，不再计算 token 估算：此时预算必然 ≤ 0，任何上下文都会挤掉模式自身历史。
- 因该原因**不可由用户缩减选择修复**，允许**降级为无上下文继续**（§9.2 例外说明），UI 文案：「共享模型上下文窗口过小，本次不携带世界背景」。
- 该判断在**入口层**执行（写作/游戏/受控入口共用），保证四模式一致。

**token 估算器实际公式（冻结）**

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
   - `sections` 见 **§4.10** 定义：`1(identity) + (setting 存在 ? 1) + [characters/locations/factions/timeline/materials 中非空段数] + (sources 非空 ? 1)`；**空数组段不计**；
   - 每段固定 8 token 结构开销。
4. **比较顺序（固定）**：**⓪** `consumerContextWindowTokens <= 4,096` → `budget_exceeded` → **①** 每字段/每实体数量与字符上限 → **②** Snapshot JSON ≤ 96 KiB → **②′** `ProjectionBody` JSON ≤ 96 KiB → **③** 最终 ModelView 文本 ≤ 48,000 rune → **③′** 最终 ModelView JSON ≤ 96 KiB → **④** `estimatedTokens ≤ effectiveModelBudget`。
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
| `budget_exceeded` | 任一预算层超限（含 **⓪ 消费者窗口 ≤ 4096**） | 413/422 | 保留选择并指明层级；**若原因为消费者窗口过小，允许无上下文继续**（见下） |
| `context_ref_mismatch` | 续接请求 Ref 与 runContext fingerprint 不一致 | 409 | 拒绝静默替换，需以新 Ref 起新 run |
| `context_unavailable` | `runContextId` 未知 / 过期 / 被 LRU 淘汰 / **服务重启丢失** | 410 | **降级为无上下文继续**，提示可重新进入加载 |
| `consumer_not_trusted` | 3.0B：通用网关收到 `world_context`/`consumer`/`run_context_id`/`scopeKey`，或客户端直提 Snapshot/ModelView。未来 iframe capability 触发条件由 3.2-C0 另行冻结。 | 403 | 拒绝（**不降级、不 bare、不部分执行**） |
| `projection_failed` | 投影/格式化内部错误 | 500 | 本次降级为无上下文，记录脱敏诊断 |
| `world_unavailable` | World 服务暂时异常 | 503 | **允许**「本次请求不带 World Context」降级 |

**降级分级（v2.3 冻结：可降级 / 不可降级）**

| 分级 | 错误码 | 服务端行为 | `context_state` | 阻断本次模式运行 |
| --- | --- | --- | --- | --- |
| **可降级**（自动降级 + **必须显式提示**） | `world_unavailable`（503） | 本次不带世界上下文 | `degraded` | 否 |
| | `context_unavailable`（410） | 同上 | `degraded` | 否 |
| | `projection_failed`（500） | 同上 + 记脱敏诊断 | `degraded` | 否 |
| | `budget_exceeded`（**仅**原因为 `consumerContextWindowTokens ≤ 4096`） | 同上（用户无法通过缩减选择修复） | `degraded` | 否 |
| | `world_not_found`（404） | 同上（World 已不存在） | `degraded` | 否 |
| **不可降级**（阻断，须用户显式处理） | `selection_invalid`（400/422） | 整体拒绝 + 回传安全非法清单 | 不写（错误响应） | **是** |
| | `revision_conflict`（409） | 拒绝，要求回控制台重确认后重进 | 同上 | **是** |
| | `world_archived`（409/422） | 拒绝新加载（在途 run 用完即止，§6.5） | 同上 | **是** |
| | `budget_exceeded`（字段/实体/字节/rune/token 超限） | 拒绝 + 指明层级与用量 | 同上 | **是** |
| | `consumer_not_trusted`（403） | 拒绝 | 同上 | **是** |
| | `invalid_request`（400，含未知字段 / 自造运行身份字段） | 拒绝 | 同上 | **是** |
| **非降级** | 无错误码 | 适配层按 §7.5 解析为**主动 bare** | `none` | 否 |

- 「不可降级」一律**不得**被吞掉后悄悄换版本、去掉上下文或降级重试；必须让用户显式处理（缩减选择 / 重新确认 revision / 重新进入）。
- **主动 bare 不是降级**：`context_state='none'` 且**无错误码**；原生续接只要服务端 task/story/branch 仍有关联，就必须解析为 `active`（不得误判 bare）。`none` 与 `degraded` 严格分离，**禁止把 degraded 伪装成 none**。
- 降级只改变**本次请求**是否携带世界上下文，不改变模式自身的可用性；runContext 的创建/复用/销毁仍按 §6.6 五态执行。

**错误码映射层（冻结）**

- `world_not_found` / `world_archived` / `revision_conflict` 属 **World Context 加载层**；World API 自身的 404 与 CAS 409 必须由**前端 World API 映射层**先转换为这三个语义，再与 Context 错误统一呈现。
- **不得**把 World **保存**的 CAS 冲突显示为 Context 加载失败，反之亦然；两者在 UI 上使用不同文案与入口（保存冲突 → 「重新加载」；上下文 revision 变化 → 「重新确认后进入」）。

### 9.3 日志与隐私契约

- 通用日志、错误响应、前端诊断上报中**禁止出现**：Snapshot/ModelView 正文、Master 正文、用户片段、Prompt、模型原始输出、本机绝对路径、`masterItemId/source_id` 等可寻址标识、`sourceRef` 原值、`runSalt`、`runContextId`、**Knowledge locator 原值**。
- **runContext 专属禁令**：`projectionBodyBytes`、`finalModelViewBytes`、`sourceRefTable`、`runSalt`、`uiViewSummary`、两级注册表内容**不得**进入通用日志、任务日志、故事存档、导出包或任何可跨会话读取的存储；只允许记录 `runContextId` 的**哈希**、字节数、consumer、耗时与 fingerprint 哈希。
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

1. Timeline 分类迁移 UI（背景/历史/规划；旧 canon 显示「历史（旧数据）」、未知值显示「背景（旧数据）」、空值/缺失显示「背景」）—— 与 3.0A 同批。
2. **世界上下文准备卡**：当前 revision、始终包含的 identity/概述/基调/规则、实体与 world 资料选择入口；用 `projectForUI` 同源逻辑做**闭包预览**（直接消费 Snapshot 的 `omissions`）。
3. **上下文预览**：进入模式前看到本次来源清单与模型投影的只读文本（与运行同源的 `finalModelViewBytes` 渲染），但不展示系统 Prompt 模板。
4. **保存状态硬约束**：dirty 时不生成权威 Snapshot，只能「先保存」或「放弃草稿后继续」，绝不把草稿当已保存 World 送入模型。

### 10.2 P1

1. 绑定健康总览，按 unchecked/latest/stale/missing/unavailable 分组；**页面加载零 Master 扇出**；用户触发的批量检查需有限并发、可停止、不轮询，结果只在运行时。
2. 「被哪些实体使用」由实体 `bindingId` 即时派生；**不**新增 `ownerId`、不持久化 `references[]`。
3. 移除影响预览：列出将被解除的引用，复用 `removeWorldBinding`，不删实体/Master 原件。
4. 上下文条（四模式通用）：世界名、revision、入选数量、查看来源、清除上下文；上下文失效时显示「世界背景已失效，可重新进入」并可一键重进；窗口过小降级时显示「未携带世界背景（模型窗口过小）」。

### 10.3 P2（可延期）

实体搜索/排序/轻筛选、来源证据展开、关系列表视图。不做地图、关系图谱、拖拽画布、后台健康任务、自动同步。

## 11. Phase 3.2：四模式只读连接（依赖 3.0B，分段验收）

统一链路：

```
已保存 World → 用户选择 + 目标模式 → WorldContextRef（宿主持有）
  → 服务端重读 + revision/selection/闭包/预算校验 + 创建/复用 runContext（3.0B 的 writing/game scopeKey 由服务端派生；iframe 生成规则须经 3.2-C0 另行冻结，均不上线，§6.3）
  → 内部 Snapshot → projectForModel → 模式专用只读格式化器
  → 四模式既有模型/运行链路；产出只留各自存储，World 与 revision 不变
```

- **写作（3.2-A）**：进入前仍先 `onQuickSwitchBook(primaryBookPath)`；`/api/chat` 增可选 `world_context`（consumer 由路由固定为 `writing`），作为带来源说明的独立只读段加入既有上下文；stream/reconnect/active/context-analysis/regenerate 按 §6 复用 runContext；Agent 改书/选区路径无 World 写权限。
- **游戏（3.2-B）**：先 `selectInteractiveStory`；`/api/interactive/chat` 与其 context-analysis 同构接入（consumer=`game`）；World 仅稳定外部背景，turn/分支/Actor State/Director Plan 仍归互动故事；**分支切换产生新的服务端内部 scopeKey / 新 runContext**。
- **3.2-C0（前置，只做安全设计与隔离验证）**：选定唯一 trust root、来源隔离与 bootstrap 交付方案；冻结宿主代理、运行句柄、多 iframe、refresh/revoke、重启、数据迁移与回滚契约，并用隔离原型/测试夹具证明可行。**不注册生产受控入口，不改 iframe 业务逻辑。**
- **叙界（3.2-C）**：C0 复审 PASS 后，才按其唯一冻结方案实现 Narraverse 服务端受控入口、宿主代理与最小消息协议；验证一次真实模型调用。iframe 不持有权威 Snapshot 或内部凭证，旧 iframe 保持 v1 bare 回退。
- **Module4（3.2-D，最后）**：复用 3.2-C 已验收的宿主代理与受控入口框架（consumer=`module4`）；具体 adventure/instance → runContext 映射沿用 C0/C 的冻结契约，不在 v2.7 预设 `rc:<id>`。Snapshot 仅作初始背景，world clock/NPC/事件/结算继续是实例态；正式 executable 验证沙盒推进不改 World 文件/revision。

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
| runContext（绑定 + ProjectionBody + finalModelView + sourceRefTable + runSalt） | 仅内存 | 仅内存 | 仅内存 | 仅内存 | **否；不入日志/存档/导出** |
| Knowledge 引用（sourceKind/sourceId/sourceRevision/locator） | 仅引用 | 仅引用 | 仅引用 | 仅引用 | **否；**只读投影，非真源 |

## 12. Knowledge Workspace / Obsidian 引用契约（v2.2 冻结形状，本期不实现）

方向不变：把**用户主动选择的片段**变成可追溯来源，不自动读整本小说/vault、不做另一个 World/Agent、不建立 Canon。

### 12.1 引用形状（冻结）

```
interface KnowledgeExcerptRefV1 {
  sourceKind:     'obsidian_vault' | 'book' | 'master_asset' | 'user_paste'
  sourceId:       string      // 逻辑源 id，由服务端注册表解析；禁止绝对路径
  sourceRevision: string      // 内容哈希 / vault 快照 revision；用于失效判定
  locator:        Locator     // 见 12.2，随 sourceKind 变化
}
```

- 浏览器只提交**引用**（`sourceKind/sourceId/sourceRevision/locator`），**不提交正文、不提交路径**；服务端按引用重读并校验 `sourceRevision`，不一致即失效（需用户重新选择）。
- 片段正文、Prompt、模型输出**不入通用日志**；`locator` 原值不入通用日志，也不进 ModelView（ModelView 只可出现脱敏后的来源展示名）。

### 12.2 locator 白名单（随 sourceKind 冻结）

| sourceKind | locator 字段 | 说明 |
| --- | --- | --- |
| `obsidian_vault` | `{ vaultId, filePath, heading?, blockId?, startOffset?, endOffset? }` | `filePath` **必须是 vault 内相对路径**；`vaultId` 由服务端 vault 注册表映射本地根，浏览器不可提交根路径 |
| `book` | `{ chapterId, startOffset, endOffset }` | 章节稳定 id + 偏移 |
| `master_asset` | `{ masterItemId, fieldPath }` | 复用总库字段白名单，不复制正文 |
| `user_paste` | `{ snippetHash }` | 用户主动粘贴片段的哈希，正文另行按会话临时处理 |

### 12.3 禁止绝对路径（冻结，服务端最终校验）

- **一律禁止**：盘符路径（`C:\...`）、UNC（`\\server\share`）、前导 `/` 或 `\`、包含 `..` 的路径段、URL 形式（`file://` / `http(s)://`）、以及任何可推出本机根目录的拼接。
- `obsidian_vault` 的 `filePath` 只接受 vault 内相对路径；`vaultId` 必须命中服务端注册表；越界或未注册 → `invalid_request`（不降级、不猜测）。
- 校验在**服务端**执行并作为最终裁决；前端提示不能替代。

### 12.4 Obsidian 关系图的定位（冻结）

- Obsidian vault 的 `[[wiki link]]`、backlink、图谱仅作为**只读投影**：只用于在知识视图中展示关系、便于用户挑选片段。
- **它不是 World 真源**：不写入 World、不参与 World 校验、不构成 Canon、不触发模式行为；World 仍是唯一持久化真源。
- 关系图不进入 ModelView 的 World 段；若未来需要作为参考，只能以「用户主动选择的片段引用」形式出现。

### 12.5 本期范围

- **只冻结形状与禁止项**：不建表、不建路由、不建组件、不建占位目录、不写未使用类型。
- 未来实现时的变更路径不变：`用户主动选择 → 引用（12.1）→ 服务端重读校验 → 提案 → 用户确认 → 原子保存`。

## 13. 风险与控制

| 风险 | 级别 | 控制 |
| --- | --- | --- |
| 模式剧情被误写成共同事实 | P0 | 无 World 写回接口；只收 Ref；验收比较 World JSON/revision 不变 |
| 内部 ID / 路径泄露进模型 | P0 | 双投影；ModelView 脱敏不变量测试；`sourceRef` 为 HMAC + 每 run 随机盐、不可寻址 |
| 浏览器伪造 consumer / 直提 Snapshot | P0 | 受控入口 consumer 由**路由**固定；通用网关拒收世界上下文字段；跨 consumer 复用句柄拒绝 |
| **iframe 越权持有/回传 runContextId 或换背景** | P0 | 3.0B 不创建 iframe 受控入口，也不向 iframe 提供任何 Context 标识；3.2-C0 单独冻结并验收真实来源隔离后才允许接入（§6.4/§7.6）。 |
| 旧 iframe 直调链与未来受控入口并存导致越权 | P0 | 通用网关拒收世界上下文字段；3.2-C0 安全门通过前受控入口不得存在。 |
| runContext 泄漏进日志 / 存档 / 导出 | P0 | 仅内存两级注册表；日志只记 `runContextIdHash` 与字节数；禁止写入任何持久化与导出 |
| 多任务 / 多分支 / 多实例并存导致绑定错乱或内存膨胀 | P1 | scopeKey 由**服务端**派生/生成、消费者隔离；两级注册表 + 上限（64 条 / 32 条 / 8 MiB）+ 四档清理粒度（§6.5） |
| **缓存了含 `sourceRef` 的最终 ModelView，导致跨 run 复用同一 sourceRef / 泄漏 run 标识** | P0 | 缓存对象改为 **source-neutral `ProjectionBody`**；最终 ModelView 由 `(body, runSalt)` 每 run 独占物化，**不共享**（§4.1/§6.2）；测试断言不同 run 的 `sourceRef` 与 ModelView 字节必须不同 |
| **analysis 展示的上下文与实际运行背景不一致（v2.6 改写）** | P0 | analysis 建 pending context 并签发 handle（§6.6/§6.7）：**首次 chat 消费 handle 时迁移**到新建的运行身份，迁移**不换 id/runSalt/ModelView 字节**；展示与模型使用同一份 `finalModelViewBytes`；analysis 与迁移均不写任务日志/存档 |
| **handle 失效后被静默降级为裸跑，或用失效 handle 完成迁移** | P0 | §6.7.4 四个失效原因码：一律**忽略 handle + 常规解析**；**不得**用失效 handle 迁移、**不得**因曾有 handle 伪造上下文、不得把原因码混进 `context_state` 降级判定 |
| **trust root 未真实建立（iframe 同源可冒用宿主）** | P0 | v2.7 不再伪冻结 capability：整体移到 3.2-C0 独立安全门；未选定单一来源隔离、bootstrap 通道及数据迁移方案前，相关路由不得创建。 |
| **`turnId → interactiveRunId` 映射未命中时"猜"一个 run** | P0 | §6.3.3：未命中（回收/重启/伪造）⇒ 回落常规解析 ⇒ 仍无绑定则 `context_state='none'`；**不新建 InteractiveRun 去猜**；记脱敏审计 |
| **普通新回合误复用上一回合的 InteractiveRun** | P0 | §6.3.2 规则 7：非 regenerate 的下一回合**必须**新建 InteractiveRun（新 runContext / 新 `runSalt`）；仅 regenerate 经 `regenerate_from_turn_id` 复用 |
| **iframe 违规直呼受控入口** | P0 | 3.0B 无该入口；3.2-C0 必须先证明调用来源可区分，再定义 403 与审计，禁止用“iframe 按约定不调用”替代技术边界。 |
| **把「不可降级错误」悄悄当 bare/degraded 放行** | P0 | §9.2 分级表：可降级仅 5 类（`world_unavailable`/`context_unavailable`/`projection_failed`/窗口类 `budget_exceeded`/`world_not_found`）；其余必须阻断并让用户显式处理 |
| **客户端自造 scopeKey/运行身份被当成绑定或授权凭证** | P0 | 线上协议**无 scopeKey 字段**：writing/game 服务端从 task/story/branch 派生，iframe 类服务端生成 id；请求体出现 scopeKey 一律忽略+审计，通用网关出现即 `consumer_not_trusted`（§6.3/§7.1） |
| scopeKey 不稳定（服务端派生用了随机 / 时间戳）导致 runContext 反复新建、绑定泄漏 | P1 | §6.3.1 强制用服务端稳定标识（task.ID/story_id/branch 或 CSPRNG 一次性 id）；同身份 bind 幂等复用（不重复 `refCount`）；内部语法测试锁定；scopeKey 只记哈希 |
| 受控入口混淆「主动无上下文」与「加载失败降级」，或对已绑定 scope 隐式注入 / 隐式解绑 | P1 | §7.5 三形状 + `context_state` 四值；bare 不读 World、不占名额、不隐式升降级；逐请求独立判定并补测试 |
| 首请求有上下文、重连/分析丢上下文或不一致 | P0 | runContext 绑定 + TTL/LRU；续接复用同一份 bytes；mismatch 拒绝 |
| World 更新后模式悄悄换背景 | P1 | expected revision + 409；显式重进，不热替换 |
| 上下文挤占模型预算 / 消费者窗口过小 | P1 | 四层硬上限 + 确定性 token 公式 + **窗口 ≤ 4096 直接 budget_exceeded**；禁止静默截断 |
| Timeline 空值/未知值被静默改写 | P1 | 3.0A 八态保真表 + 解码侧四态区分 + 字节级保真测试；升级栅栏与备份要求 |
| Context 错误与 World 保存 CAS 冲突混淆 | P1 | §9.2 映射层：保存冲突与上下文失效分开文案与入口 |
| **Obsidian / Knowledge 被当成第二真源或上传全文** | P1 | 只接受引用（12.1），禁止绝对路径；关系图仅只读投影；主动片段 + 服务端重读 + revision 校验；本期不实现 |
| **把 `worldId` / `revision` 当授权凭证** | P0 | 二者只用于定位/比对/显示；3.0B 只有服务端固定的 writing/game consumer 与内部绑定，iframe 授权留待 3.2-C0 独立冻结。 |
| **capability 设计提前进入 3.0B** | P0 | 不创建 token、bootstrap 或 iframe 路由；所有 capability 细节必须等 3.2-C0 选定单一信任根后重写并复审。 |
| **analysisHandle 被当长期身份或写入任务日志** | P0 | handle 只作 pending context ↔ 首次 chat 的短期单次引用：≤10 分钟、不续期、消费即作废、不替代运行身份、不下发 iframe、不进任务日志/存档/导出；迁移本身也不写任务日志。 |
| **pending context 并发双消费，或 Task 在绑定前已启动模型** | P0 | handle 注册表原子 `pending→claimed`；Task 两阶段创建，绑定/明确降级完成后才启动 goroutine；并发与启动顺序测试锁定（§6.7.3）。 |
| **pending context 迁移时重建 runContext（导致换背景 / 换 sourceRef）** | P0 | pending 态与迁移后是同一条记录：迁移只改归属锚点，不换 id、`runSalt` 或 ModelView 字节。 |
| **前端拿到 handle 内部字段** | P1 | 前端可见面冻结为 `{ analysisHandle, expiresAt }`；`analysisHandleId` / `pendingContextRef` / `contextFingerprint` / `consumedAt` 一律不下发（§6.7） |
| **`InteractiveRun` 与 `Task` 混用导致 regenerate / abort 复用错背景或误销毁** | P0 | 冻结 `InteractiveRun ⊃ Task`（Task = **一次执行尝试**）：game scope 用 `run:<interactiveRunId>` 且**不含 task**；regenerate 经 `regenerate_from_turn_id` 找回同一 InteractiveRun（**新建 Task，不新建 run**）；**abort 只结束当前 Task，不解绑 runContext**；branch 切换 = 新 InteractiveRun = 新 runContext（§6.3.2） |
| **Task 生成时尚无 turnId，却提前写 TurnRunIndex** | P0 | Task 分配后先写 `TaskRunIndex`；只有 `interactive_turn_persisted` 成功后才写 `TurnRunIndex`，失败/abort 不产生虚构 turn 映射（§6.3.3）。 |
| **把「task 完成 / 取消」当销毁 run 的触发条件** | P0 | 只有 **InteractiveRun 结束 / branch 切换或删除 / 实例级 scope 事件**才解绑（§6.5 档 1、§6.6 `destroy`）；单次 Task 结束**不销毁** run（§6.3.2 规则 3） |
| **Snapshot 自引用字节数 / 时间戳破坏纯函数与 fingerprint 复现** | P1 | 移除 `stats.bodyBytes`；诊断与预算信息移入 **sidecar metadata**（不参与 fingerprint/等值判断、不进任何投影）（§4.12） |
| **ModelView 段缺失或键漂移导致同输入不同 schema** | P1 | 数组恒在（空为 `[]`）、可选标量缺失即不输出（不写 `null`）、v1 内字段结构不可变、`sections` 定义固定、键集合快照测试（§4.10） |
| 四模式各自解释 World | P1 | 单一解析器 + 双投影 + 薄格式化器，禁止各自 GET 全量 World |
| 健康总览形成请求风暴 | P2 | 页面零自动扇出；用户触发、有限并发、可停止 |
| Snapshot warning 被误读为实时健康 | P2 | warning 只表「未检查」；不触发 Master 请求 |

## 14. 分阶段交付与门禁（DoD）

### Phase 3.0A（独立提交）

- Go/TS 解码边界 `canon→historical`（仅展示）、**空值八态**策略（`null` / `""` / 缺失 / 未知 / canon / 三值）、新建默认 `background`。
- **解码侧四态区分**落地（自定义 UnmarshalJSON 或内存 sidecar，二选一），**不新增持久化字段**。
- **未编辑即保真**：`canon`、未知值、`""`、`null`、缺失在保存后**磁盘字节不变**（除 `updatedAt`）；用户显式改分类才写新值。
- 单向升级精确措辞 + 升级栅栏（备份指引 / 禁旧二进制回写 / 旧版本打开新枚举文件的确定行为）；CAS 保存不改其它字段；兼容定向测试全绿。
- 可独立回退；不夹带任何 Snapshot/模式接入代码。

### Phase 3.0B

- Ref / 内部 Snapshot（含 `omissions`）/ UI Projection / Model Projection、selection 归一化与闭包为**纯函数**，前后端同源契约测试。
- **两级注册表契约（v2.3）**：`scopeKey` 映射（§6.3）、多 scope 共享同一 fingerprint 的 **`ProjectionBody`**（`refCount`）、**最终 ModelView 每 run 独占**（`runSalt`/`sourceRef` 必然不同）、上限（64 条 / 32 条 / 8 MiB）、**四档清理粒度**（§6.5）、**五态生命周期**（create/reuse/reconnect/regenerate/destroy，§6.6）、重启全丢 → `context_unavailable`；日志/存档/导出禁令测试。
- **契约 schema 测试（§4.7～§4.11）**：四类型字段必填/可选、空值语义（缺失 ≠ `null`、空数组不输出该段）、数组与文本上限、revision 校验（`sha256:` 前缀 + 比对 + 不自动换版本）、UI 字段与 Model 字段白名单（ModelView 硬禁止项正则扫描）。
- **ProjectionBody vs 最终 ModelView 测试**：同 fingerprint 的两个 runContext 命中同一 body（字节一致、`refCount==2`），但 `runSalt`/`sourceRef`/`finalModelViewBytes` **必须不同**；同 runContext 内续接/重连/regenerate 字节恒定。
- **analysisHandle 服务层契约测试（§6.6/§6.7 v2.7）**：同 `(consumer, sessionKey, fingerprint)` 只有一个有效 handle且重复 analysis 幂等复用；严格解码；原子 `pending→claimed→consumed`；两个并发消费只有一个能继承 pending context，失败方即使按常规请求继续也必须获得独立身份且不得继承该上下文；迁移前后 `runContextId`/`runSalt`/`finalModelViewBytes` 完全相同；失效 handle 不阻断、不迁移、不伪造上下文。3.0B 只实现服务层，`/api/chat` 与 `/api/interactive/chat` 字段接线分别留到 3.2-A/3.2-B。
- **Task 启动顺序测试（§6.7.3）**：Task ID 分配后、模型 goroutine 启动前完成 runContext 迁移；绑定失败时模型调用次数为 0；并发失败不留下半成品运行身份或映射。
- **降级分级测试（§9.2）**：可降级 5 类返回 `degraded` 且模式可继续；不可降级 6 类必须阻断且不被降级；主动 bare 返回 `none` 且无错误码。
- **3.0B iframe 负向范围测试**：路由表中不存在 world-context iframe model-call/bootstrap/capability 端点；旧 `/api/model/chat` 带世界上下文字段仍被拒绝；不得新增 iframe origin/sandbox 或浏览器数据迁移代码。
- **InteractiveRun 模型测试（§6.3.2）**：①`regenerate_from_turn_id` 找回同一 InteractiveRun ⇒ 同一 runContext、`runSalt` 与 ModelView 字节恒定（**断言新建的是新 Task，不是新 run**）；②**abort 只结束当前 Task** ⇒ InteractiveRun 与其 runContext 保留（后续 regenerate 仍复用同一背景）；③branch 切换 ⇒ 新 `interactiveRunId` ⇒ 新 runContext；④**run 身份不含 task**：断言 scopeKey 中无 task 段；⑤客户端自造 `interactiveRunId` 被忽略并审计。
- **Task/Turn → InteractiveRun 映射测试（§6.3.3 v2.7）**：Task ID 分配后、启动前登记 `TaskRunIndex`；`TurnRunIndex` 在 `interactive_turn_persisted` 前必须为空、成功后才登记；失败/abort 不登记 turn；regenerate 命中后复用 run 并创建新 Task；未命中不猜 run；两索引按 story/branch 隔离且仅内存。
- **新回合规则测试（§6.3.2 规则 7 v2.6）**：非 regenerate 的下一回合 ⇒ **新 `interactiveRunId` + 新 runContext + 新 `runSalt`**（断言与上一回合的 `sourceRef`/ModelView 字节**不同**）。
- **Snapshot sidecar 测试（§4.12）**：Snapshot 内**不存在** `stats.bodyBytes` 与任何运行期时间戳；仅修改 sidecar 字段**不影响** `contextFingerprint` 与投影字节；sidecar 不出现在任何请求/响应体与投影中。
- **ModelView schema 稳定性测试（§4.10）**：空 selection 下六个数组恒为 `[]` 且 `identity` 存在；`sections` 按 §4.10 定义计算（空数组段不计数）；v1 顶层与元素键集合快照测试；可选标量缺失时**不出现该键**、全文**绝不出现 `null`**。
- **scopeKey 规则测试（§6.3.1）**：3.0B 只覆盖服务端内部 writing/game 形状；客户端不能提交 scopeKey；writing 使用 Task ID，game 使用 `story_id+branch+interactiveRunId` 且不含 task；scopeKey 不入请求体、ModelView 或日志原值。iframe 形状延后到 3.2-C0。
- `contextFingerprint` 规范化与 mismatch 一致性测试。
- 预算：**窗口 ≤ 4096 直接 `budget_exceeded`** + 四层上限 + token 黄金样例（含边界等值）；稳定错误码（含 `context_unavailable`）；日志脱敏（路径/`sourceRef`/`runContextId`/locator 不泄露）测试。
- `sourceRef` 不可寻址测试：跨 run 不可复现、不能作为任何 API 路径或写入凭证。
- 只从已保存 World 生成；不读 Master 正文/模式运行态；不新增持久化、任务、轮询、模型调用。
- Codex 节点审查通过后才进入 3.1/3.2。

### Phase 3.1

- 选择/闭包预览区分已保存与草稿；健康/引用/移除影响解释；`omissions` 展示；页面加载零 Master 扇出；Timeline 八态显示文案。
- 不增 ownerId/references[]/图库/后台；dirty/CAS409/Master404·5xx/旧 Timeline（含空值）、桌面与移动端均有定向测试。

### Phase 3.2

- **3.2-C0 只做安全 Design Freeze 与隔离验证，不做生产接入**：按 §7.6 选定唯一来源隔离与 bootstrap 通道，给出 IndexedDB/localStorage 数据连续性、多 iframe 签发、refresh/revoke 与回滚的可执行契约；用隔离原型或测试夹具证明宿主与 iframe 可区分。独立安全复审 PASS 后，才由 3.2-C 创建 Narraverse 受控入口与宿主代理，3.2-D 复用到 Module4。
- 3.2-A/B/C/D 分别验收对应模式可显式带入与清除；无上下文时与基线一致；revision/selection/预算（含窗口过小）/服务异常按 §9.2 分级处理；`context_unavailable` 有明确 UI 与重进入口。
- **无上下文（bare）规则测试（§7.5）**：bare 不建 runContext、不读 World、不占注册表名额，响应 `context_state='none'` 且无 `run_context_id`；原生续接不带世界字段时仍按服务端 task/story/branch 解析为 `active`，不得误判 bare；iframe 宿主主动 bare 既不注入也不解绑旧绑定；`none` 与 `degraded` 可区分；通用 `/api/model/chat` 带世界字段仍 `consumer_not_trusted`。
- 写作/游戏 context-analysis 展示与该 runContext **同一份 bytes**；stream/reconnect/active/regenerate 覆盖。
- iframe 按 3.2-C0 最终选定的预期 origin、来源 window、版本与类型校验；旧 iframe 在迁移前继续走 v1 bare。
- 自动化断言四模式不调用 World 写端点、运行前后 World revision 不变。
- 正式 executable 端到端：进入模式→读背景→产出一次模式内容→返回 World→World JSON/revision 不变→重启仍不变（与 Vite dev/代理验收分别记录）。

## 15. 明确不做

- 全局 Canon、剧情共同真源、模式事件自动同步。
- 世界自动模拟、后台时间推进、Agent 自治世界。
- 章节/回合/对话/沙盒事件自动写 World 或 Timeline。
- 长期 World Context 任务、快照数据库/snapshotId、后台轮询、自动热更新；runContext 不持久化、不跨重启。
- 自动读取整本小说、完整互动故事、全部 Master、完整存档或整个 Obsidian vault。
- 重写 Module3/Module4、复制游戏引擎、Module4 专属 API/模型配置。
- 地图、关系图谱、图数据库与大型控制台重构；**把 Obsidian 关系图升级为 World 真源或 Canon**。
- 让通用模型网关接受浏览器自由 consumer、`world_context`、`run_context_id` 或客户端 Snapshot。
- 让 iframe 持有 `runContextId`、Ref 权威副本或任何 World 写能力。
- 把 `worldId` / `revision`（或任何客户端可声明字段）当作授权凭证。
- 在 3.2-C0 独立安全设计通过前创建 host capability/bootstrap/iframe 受控入口，或把 `analysisHandleId` 下发给 iframe。
- 用 `task` 作为 game 侧 scope 身份（冻结 `InteractiveRun` ⊃ `Task`，game 的 run 身份**不含 task**，§6.3.2）。
- 把 v2.6 已作废的 bootstrap secret / opaque token 候选直接当实现合同；3.2-C0 必须重新冻结唯一方案。
- 在 analysis 阶段**强制要求 task 锚点**（v2.5 取消该前置：先建 pending context，首次 chat 消费 handle 时才建 task，§6.7）。
- 让 pending → 运行身份迁移新建 runContext / 重新随机化 `runSalt` / 重算 ModelView，或在绑定完成前启动 Task goroutine。
- 把 `analysisHandleId` / `pendingContextRef` / `contextFingerprint` / `consumedAt` 下发给前端（前端可见面冻结为 `{ analysisHandle, expiresAt }`，§6.7）。
- 让一个 handle 被消费多次、同一 pending context 同时签发多个 handle，或把 handle 续期到超过 10 分钟。
- 把「task 完成 / 取消 / abort」当作销毁 run 的触发条件（只结束**一次执行尝试**；解绑只由 InteractiveRun 结束 / branch 切换 / 实例级 scope 事件触发，§6.3.2/§6.5/§6.6）。
- 用 `story/branch/**task**` 取 runContext，或让 game 的 scope 从服务端 **task** 派生（run 身份**不含 task**，§6.5/§7.1/§6.3.2）。
- 让普通（非 regenerate）的下一回合复用上一回合的 InteractiveRun（**必须新建**，§6.3.2 规则 7）。
- `regenerate_from_turn_id` 未命中时"猜"一个 InteractiveRun（应回落常规解析 ⇒ 无绑定则 bare，§6.3.3）。
- 在 Task 创建时伪造尚不存在的 turnId；`TurnRunIndex` 只能在 turn 持久化成功后写入。两张 run 映射都不得持久化或写日志原值。
- 把 `analysis_handle` 加进受控入口 `/api/world-context/*/model-call`（iframe 路径无 analysis 阶段），或在查询串 / header / iframe 消息中接收 handle（**唯一合法位置**是 `/api/chat` 与 `/api/interactive/chat` 的 `analysis_handle` 字段，§6.7.1）。
- 对 `analysis_handle` 做"尽力解析"（必须**严格解码** 7 项；`""` = 未携带而非错误，§6.7.2）。
- 让 handle 失效**阻断** chat、或用失效 handle 完成迁移、或因曾有 handle 而伪造上下文（一律忽略 + 常规解析，§6.7.4）。
- 把 `analysis_handle_status` 的四个提示码混入 §9.2 的 `context_state` 降级判定（§6.7.4）。
- 在未选定并实测唯一来源隔离、bootstrap 交付与浏览器数据迁移方案时声称 capability 信任根已建立。
- 在 Snapshot / ModelView 内写自引用字节数、运行期时间戳，或让 sidecar 参与 fingerprint 与投影。
- 在任何请求体 / 查询串 / iframe 消息中接收客户端自造的 `scopeKey`（或同义运行身份字段）作为绑定键或授权凭证；scopeKey 只能服务端派生/生成。
- Knowledge Workspace 实现（仅冻结引用形状与禁止项）。

## 16. 建议实施顺序

1. **3.0A**：Timeline 枚举兼容（八态保真 + 解码侧四态区分）与 UI 文案，独立可回退提交。
2. **3.0B**：Ref / 两级 runContext / 双投影 / 闭包 / fingerprint / 预算（含窗口加固）/ 错误 / 日志纯契约与测试，不接任何模式。
3. **3.1-P0**：保存状态约束、上下文选择与闭包/双投影预览（含 `omissions`）。
4. **3.1-P1**：健康总览（批量检查可延期）、引用位置、移除影响、上下文条。
5. **3.2-A**：写作只读接入（chat/stream/context-analysis/恢复/无上下文回归）。
6. **3.2-B**：游戏只读接入（turn/branch/active/stream/regenerate/revision 不变；分支切换产生新的服务端内部 scopeKey）。
7. **3.2-C0**：先做独立安全 Design Freeze（唯一信任根/交付通道/数据迁移/多实例），复审通过后再实现受控模式入口与宿主代办。
8. **3.2-C**：叙界接入（宿主协议增量 + 一次真实调用）。
9. **3.2-D**：Module4 复用同一受控通路，完成四模式不回写正式 executable 验收。

每步独立可回退；不得把控制台重做、Timeline 迁移、四模式接入、Knowledge Workspace 混成一次大改。

## 17. 架构裁定（v2.7）

- **Phase 3.0A：已实现并提交**（`f87d795`）；本版不变更 3.0A 契约。
- **Snapshot schema（§4.7～§4.12）：已通过冻结**（复审明示无需再改）；本版未改动。
- **Phase 3.0B：PASS / DESIGN FREEZE**。允许按 §14 的 3.0B 范围进入编码：Snapshot、双投影、selection/闭包、fingerprint、预算/错误/日志、runContext 核心，以及 analysisHandle/InteractiveRun 的服务层契约与测试；**不接四模式路由、不创建 iframe 受控入口或 capability**。
  冻结前提：完整四类契约（§4.7～§4.12）、两级产物缓存、`InteractiveRun ⊃ Task`、`TaskRunIndex + TurnRunIndex` 两段映射、普通新回合规则、pending context 的唯一 handle + 原子认领 + 模型启动前迁移，以及降级分级（§9.2）。
- **Phase 3.1：PASS WITH DEPENDENCY**，依赖 3.0B。
- **Phase 3.2-C0：NEED DESIGN FREEZE**，是叙界/Module4 接入的强前置；必须先解决唯一信任根、bootstrap 交付、浏览器数据迁移与多 iframe 签发，未通过前 3.2-C/3.2-D 不得开始。
- **Phase 3.2：PASS WITH DEPENDENCY**，按 写作 → 游戏 → 3.2-C0 → 叙界 → Module4 分段，每段独立回退与不回写验收。
- **Knowledge Workspace / Obsidian：保留方向与引用形状，禁止本期实现；关系图仅只读投影，不是 World 真源。**
- **设计不变量（本版冻结、不得放松）**：World 单一真源；UI/Model 双投影；四模式只读；不回写 World；**Timeline 去 Canon**；Knowledge/Obsidian 只读投影。
- **v2.7 定点复审结论**：① Capability 未假装解决，已从 3.0B 移到 3.2-C0 独立安全门；② analysisHandle 已冻结唯一 handle、原子认领与 Task 启动前迁移；③ InteractiveRun 已按当前 Task/turn 持久化事实拆为 TaskRunIndex 与 TurnRunIndex。Snapshot schema 未改。**允许进入 3.0B，完成后必须停下验收，不得自动进入 3.1。**
