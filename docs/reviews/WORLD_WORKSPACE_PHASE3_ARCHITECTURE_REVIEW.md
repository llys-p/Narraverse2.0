# Narraverse2.0 Phase 3 Architecture Review

- 审查时间：2026-09-10 18:57（Asia/Shanghai）
- 审查基线：`main` / `55fc07a2382ee2196c01b1d824d81b5ffbb42456`
- 审查对象：`docs/plans/WORLD_WORKSPACE_PHASE3_ARCHITECTURE_PLAN.md`
- 范围：只读架构审查；未修改生产代码、未创建 API、未运行模型或构建

## 1. 总结结论

**结论：NEED REVISION。**

总体方向是正确的：World 仍是唯一持久化真源，Snapshot 是服务端按引用投影出的临时 DTO，四模式只读消费，不建立全局 Canon、事件总线、第二套模型链或后台同步。按当前 World/Master/四模式代码事实，这个方向不会必然破坏 Phase 2B 的实现。

但当前计划还不能直接进入生产编码，主要因为以下契约尚未收紧：

1. Snapshot 中的内部 ID、跨实体引用和 Master 元数据如何进入模型上下文尚未分层，存在泄露内部标识和产生悬空引用的风险。
2. `WorldContextRef` 到现有聊天、流式重连、上下文分析和 iframe/Module4 调用的生命周期没有冻结；“只存宿主内存”不足以覆盖现有长任务和重连路径。
3. Timeline 从 `canon` 写成 `historical` 的混合版本行为没有明确，当前代码仍只接受 `canon|planned`，不能仅靠文档中的运行时映射视为已完成兼容。
4. `/api/model/chat` 的通用入口与 Module4 的实际调用边界没有明确，不能只依赖客户端传入 `module` 来证明 consumer 不可伪造。
5. 数量限制、字符限制、模型预算和引用归一化规则还需要变成可测试的服务端契约，而不是只停留在方案表格。

修订完成后，推荐按“Timeline 兼容收口 → Snapshot 纯投影与请求生命周期 → 控制台选择/预览 → 写作 → 游戏 → Narraverse → Module4”的顺序实施。Phase 3.1 和 3.2 可以保留，但必须依赖修订后的 3.0 契约。

## 2. 当前基线与已核实事实

本次审查以当前工作树中的代码与方案为依据，未将未跟踪的运行产物视为源码事实。

- `denova-src/internal/world` 当前 `TimelineCategory`/校验仍是 `canon|planned`，World schemaVersion 仍为 1。
- `denova-src/web/src/features/world-workspace/types.ts` 当前 Timeline 类型仍为 `canon|planned`；World 没有 `WorldContextSnapshot` 字段。
- World 继续通过全局数据目录的 `world-<id>.json` 保存，使用内容哈希 revision 和整文档 CAS；这是本次方案可复用的真源与并发边界。
- `WorldConsolePage` 已有统一草稿、dirty、CAS 冲突重载、实体/绑定编辑和四模式入口，但尚未产生上下文引用或快照。
- `/api/chat`、`/api/chat/context-analysis`、`/api/interactive/chat`、互动故事流式重连接口当前没有 `world_context` 字段。
- `NarraverseWorkspace` 与 `app/bridge.js` 当前是 v1 iframe 协议，已有同源、来源 window 和消息类型校验，但没有世界上下文消息。
- `ModeEntries` 的写作、游戏、叙界和 Module4 入口是导航/选择入口，不是当前的 World 上下文注入入口。

## 3. WorldContextSnapshotV1 与现有 World 模型

### 3.1 可以通过的部分

以下设计可以保留：

- Snapshot 不嵌入 `World`，不把上下文、快照时间或模式状态写回 `world-<id>.json`。
- 客户端提交 `worldId + expectedWorldRevision + selection`，服务端重读已保存 World，再做白名单投影；这与现有内容哈希 CAS 和“草稿不作为权威数据”的规则一致。
- Snapshot 不包含 Master 正文、lorebook 嵌套正文、绝对路径、头像二进制、运行态、未确认 Proposal 或未保存草稿。
- 模式结果不改 World revision，World 仍只通过既有保存路径和 CAS 修改。

在上述约束下，`WorldContextSnapshotV1` 是一个向外的只读视图，不会改变现有 World schemaVersion=1 的业务含义。

### 3.2 必须修改的模型契约

当前 Snapshot 示例仍把以下三类数据混在一个对象中：

1. UI/审计需要的内部标识：`bindingId`、`masterItemId`、实体 ID；
2. 模型可读的背景内容：名称、描述、规则、标签；
3. 诊断信息：`warnings`、revision、健康状态。

必须拆成至少两种投影语义：

- **UI/来源投影**：可保留 World entity id、binding id、master item id，用于“查看来源”和回到控制台。
- **模型上下文投影**：默认不暴露本机内部 ID、文件名、Master item id、binding id 和路径；如必须回溯来源，使用服务端生成的稳定、不可用于寻址的 `sourceRef`，并明确它不是任何写入凭证。

同时补齐以下不变量：

- 角色的 `factionId`、`locationId` 只有在目标势力/地点也被选中时才可输出；否则省略，不输出悬空 ID。
- 势力的 `headquartersLocationId` 同样只在对应地点被选中时输出；否则省略或输出展示名，不能留下不可解释的内部引用。
- 关系边只允许连接本次选中的角色；该规则也适用于所有新增的跨实体引用。
- entity scope binding 必须由已选实体自动派生，不能通过单独提交 `bindingIds` 把未选实体的资料偷偷带入模型上下文；world scope binding 才可单独选择。
- `ruleIndexes` 必须服务端校验为非负、唯一、排序稳定且属于当前 World revision；不得依赖客户端数组位置未经归一化地落入 Snapshot。
- `generatedAt` 不参与内容语义或缓存等值判断；如保留，应放在响应元数据中，避免同一 World/ref 每次生成不同的“上下文内容”。

## 4. 服务端生成 Snapshot 方案

### 4.1 方向合理

“引用 → 服务端重读 World → revision/selection 校验 → 纯投影 → 模式格式化”的方案是正确的，优于浏览器上传完整 Snapshot，也优于四个模式各自读取完整 World。

它能同时满足：

- 防止客户端伪造或扩大 World 正文；
- 不把未保存草稿送入模型；
- 统一四模式字段白名单、数量上限和脱敏规则；
- 不新增 Snapshot 数据库、快照任务或第二真源。

### 4.2 必须补齐的服务端边界

计划需要在进入 3.0 实施前冻结以下内容：

1. **明确 API 形态**：是仅由四个受控 handler 接收 `world_context`，还是允许通用 `/api/model/chat` 接收；不能同时保留两种可自由组合的入口。建议通用模型网关不接受任意 `consumer`/Snapshot，只接受由受控调用方构造并验证过的内部参数。
2. **固定 consumer 的可信来源**：不能把客户端的 `module=narraverse|module4` 当作唯一授权依据。handler/服务端调用者必须把允许的 consumer 与入口绑定，并拒绝跨入口伪造，例如写作请求不能声明为 Module4 来取得不同投影。
3. **冻结失败语义**：World 404、已归档、revision 409、selection 非法、数量超限、格式化超预算、服务端异常分别对应稳定错误码；降级只能是“本次请求不带 World Context”，不能吞掉 selection 错误后悄悄改用另一版本。
4. **不查询 Master 作为 Snapshot 生成副作用**：`masterRevision` 和健康状态只能是已保存薄快照/既有运行结果的说明；Snapshot 生成不应形成 Master 详情扇出或把 stale 检查变成后台任务。若展示 `binding_unchecked`，必须注明“未检查”不是“当前原件健康”。
5. **服务端预算优先**：对每个字段、每种实体、总序列化字节数和最终模型文本分别硬校验；不得只在前端计数，也不得靠字符截断满足 token 上限。超限时返回可诊断错误，保留用户选择。

### 4.3 当前计划遗漏的请求生命周期

现有写作和游戏都有异步任务、SSE 流、active 查询、重连、上下文分析或重新生成路径。若 `world_context` 只保存在宿主内存，会出现：

- 首次请求带有 World 背景，但流重连/恢复请求没有背景；
- context-analysis 展示的 Snapshot 与真正运行任务使用的 Snapshot 不一致；
- 页面组件重挂载后仍有活动任务，但引用已经丢失；
- 游戏重生成或恢复活动回合时，无法判断是否继续使用原 World revision。

必须在计划中明确以下一种方案：

- 将不可变的 `WorldContextRef` 绑定到当前 task/run 的非 World 元数据，并让 stream/reconnect/context-analysis/regenerate 通过该绑定取回；或
- 每个续接请求都显式携带相同 ref，并由服务端验证与活动 run 的 ref 完全一致。

这不等于把 Snapshot 持久化进 World，也不要求长期 AI 任务；但必须保证一次模式运行不会在重连时无声切换上下文。当前方案缺少这一条，因此属于进入编码前的阻塞修订项。

## 5. 四模式只读注入与回写风险

### 5.1 总体边界正确

“模式只读读取 World，剧情/回合/对话/沙盒事件留在各自运行态，不自动进入 World Timeline”是正确的产品和数据边界。验收时比较 World JSON 与 revision 不变，也是可执行的硬断言。

### 5.2 接入顺序合理，但需分段冻结

推荐顺序“写作 → 游戏 → Narraverse → Module4”合理：

- 写作和游戏有明确的原生 HTTP/任务边界，最容易验证请求契约和 context-analysis；
- Narraverse 需要升级 iframe 协议，但仍可先验证宿主消息和后端引用解析；
- Module4 是 iframe 内独立运行态，最容易把“背景读取”误做成运行世界同步，因此应最后接入。

每一段必须有独立的 feature flag/回退路径、无上下文基线回归和 World revision 不变验收，不能四模式一次性联调。

### 5.3 四模式各自必须补的回写防线

- **写作**：`/api/chat`、stream、abort、context-analysis、Agent 修改书籍/选区的代码路径都不得获得 World Store 写权限；`world_context` 只能进入模型输入。
- **游戏**：普通回合、分支、Actor State、Director Plan、重生成和恢复活动回合都不能调用 World PUT/Archive；World ref 必须与活动故事运行绑定。
- **Narraverse**：`world-context-changed` 只能是宿主到 iframe 的只读消息；iframe 发送给宿主的消息类型白名单中不得出现“保存 World/更新实体”。
- **Module4**：必须核对实际模型调用路径，确保它使用现有共享网关并携带受控 ref，而不是在 `app/` 中绕过服务端直接拼装完整 World 或建立专属配置；沙盒 runtime 的 world clock、NPC、事件和结算必须继续是实例态。

此外，清除上下文、切换世界、World revision 变化、iframe 未实现新协议、模式退出再进入都要有明确行为，不能只定义首次进入。

## 6. Timeline `canon → historical` 兼容性

### 6.1 产品语义方向正确

取消 Canon 概念、把旧 `canon` 解释为当前 World 内由用户维护的历史，是正确的；并且禁止模式剧情自动写入 Timeline，能够防止 World 退化为跨模式剧情总线。

### 6.2 当前兼容方案还不安全

当前代码仍在 Go/TS 类型、校验和 UI 中使用 `canon|planned`。如果新代码直接写入 `background|historical|planned`，仍使用 schemaVersion=1，则旧版本二进制读取同一文件时可能拒绝或损坏；而“运行时映射 canon”本身并不能让旧写入器理解新值。

进入编码前必须补一份明确的混合版本策略，至少回答：

1. 新版本读取：`canon → historical` 的映射发生在哪一层，是否兼容空值（当前校验允许空值）。
2. 新版本写入：何时把旧值升级为 `historical`，用户未修改的旧条目是否在保存时转换，是否保留未知值并报警。
3. 旧版本行为：升级后的数据是否明确要求旧二进制不可继续写入；若要求兼容，是否需要 schemaVersion 2 或写入仍保留旧枚举。
4. 单文件原子保存和 CAS 在“旧值读入、新值写出”时如何保持；不能因为兼容转换丢掉其他草稿字段。
5. `background` 的默认值、空 category 的显示和新建/编辑 UI 默认值是什么。

推荐：把 Timeline 兼容作为独立、可回退的 3.0A 提交；先实现新代码“读旧 canon、内存归一化为 historical、按明确升级策略写入”的测试，再开始 Snapshot。未完成这一步前，不应声称 Phase 3.0 的 World 契约已经冻结。

## 7. 其他遗漏的数据边界

以下问题不是当前架构方向错误，但必须写入实施契约和测试：

- **快照与健康状态分离**：Snapshot 的 `warnings` 不得被解释成实时 Master 健康结果；stale/missing/unavailable 应沿用既有按需检查语义。
- **归档与选择**：已归档 World 必须拒绝创建新 Snapshot；正在运行的模式可以继续使用已有不可变 Snapshot，直到请求结束，不能中途热替换。
- **引用一致性**：选择实体时要处理被删除实体、被移除 binding、级联解除关系和重复 ID；服务端必须拒绝非法 selection，不自动补全或静默丢弃。
- **隐私与日志**：Snapshot 正文、Master 正文、用户片段、Prompt、模型原始输出和内部路径不能进入通用日志、错误响应或前端诊断上报。
- **模式格式化**：共享投影与四个模式的提示格式要分离；模式格式化器不能重新读取完整 World，也不能自行扩展字段白名单。
- **来源展示**：UI 的“查看来源”可以使用内部 ID，但模型可见文本不应依赖这些 ID；来源显示与模型提示必须有不同序列化函数。
- **上限一致性**：JSON 96 KiB、48,000 字符、12,000 tokens 之间的估算算法、保留空间和各消费者更小预算必须可重复测试，不能使用环境相关的近似导致线上随机失败。
- **接口兼容**：无 World Context 的旧请求必须字节/语义兼容；新字段未知时，旧前端仍能正常运行，iframe 未实现新消息时仍能按旧协议运行。

## 8. Phase 3.0/3.1/3.2 拆分判断

### 8.1 可以保留的拆分

- **3.0**：冻结 Timeline 兼容、Ref/Snapshot、权限、预算、错误和生命周期，是后续开发的必要地基。
- **3.1**：只做 World Console 的上下文选择、预览、健康/引用解释和保存状态约束，不把模式接入混入控制台改造。
- **3.2**：按模式逐个只读接入，沿用现有模型和运行链路，不重写 Module3/Module4。

### 8.2 建议把 3.0 再拆成两个可回退节点

1. **3.0A Timeline compatibility**：枚举、校验、读旧值、写新值、空值策略、CAS/旧版本说明。
2. **3.0B Snapshot contract**：Ref 信任边界、纯投影、模型/UI 双投影、预算、错误、任务生命周期和契约测试。

这样可以避免 Timeline 持久化兼容和上下文注入同时变更，便于发现是数据迁移问题还是模型输入问题。

### 8.3 3.2 的建议门禁

- 3.2-A 写作通过后再做 3.2-B 游戏；两者都要覆盖首次请求、context-analysis、流重连/恢复和无上下文回归。
- 3.2-C Narraverse 先只做宿主消息与引用保存，再验证一次实际模型调用；iframe 未升级时必须保持旧行为。
- 3.2-D Module4 最后做，先验证只读初始背景，再验证沙盒推进、事件和结算不会改变 World 文件或 revision。
- 每个子阶段都应能关闭 World Context 并回到当前 Phase 2B 行为；不要以全局开关或隐式 localStorage 作为唯一回退机制。

## 9. 必须修改项（进入编码前）

以下为本次评审的阻塞项：

1. 将 Snapshot 拆出 UI/来源投影与模型上下文投影，明确内部 ID、跨实体引用和 Master 元数据的可见性。
2. 冻结 selection 归一化规则：entity binding 自动派生、world binding 单独选择、引用闭包、ID/索引去重排序和非法 selection 的错误语义。
3. 冻结 `WorldContextRef` 在任务、SSE 重连、active、context-analysis、regenerate 和 iframe 调用中的生命周期；禁止首请求有上下文、续接无上下文。
4. 明确通用模型网关、四个 handler 和 iframe/Module4 的可信调用边界；客户端不得通过 `module` 或 `consumer` 选择更宽投影，也不得直接提交 Snapshot。
5. 完成 `canon → historical` 的混合版本策略与测试，特别是当前 schemaVersion=1、空 category、旧二进制继续运行/写入的处理。
6. 冻结模型上下文的 per-field/total/token 预算、估算算法和保留空间；所有超限不得静默截断或自动换版本。
7. 把 Snapshot 健康 warning、归档行为、日志脱敏、清除/切换/重挂载行为写入 DoD 与端到端验收清单。

## 10. 可延期项

以下可以在上述阻塞项修订后延期，不阻止 3.0B/3.2 首次实现：

- 控制台搜索、排序、来源证据展开和关系列表。
- 健康总览的用户触发批量检查；首版可以只做单项检查和明确的未检查状态。
- Module4 指定 adventure 的旧协议限制。
- Knowledge Workspace 的正式接口、章节稳定 ID 和片段 UI；本阶段继续只保留边界文档。
- 关系图谱、地图、后台健康任务、自动同步、长期上下文任务和快照持久化。
- `growthNote` 是否属于 World 背景；在没有明确产品语义前继续排除。

## 11. 推荐实施顺序

1. 修订本架构计划，补齐第 9 节七项契约；Codex 复审通过后冻结。
2. 3.0A：Timeline `canon → historical` 兼容实现与定向测试，独立提交、独立回退。
3. 3.0B：Snapshot Ref/投影/预算/错误/生命周期契约与纯函数测试，不接任何模式。
4. 3.1-P0：World Console 保存状态约束、上下文选择、结构化预览和清除/切换行为。
5. 3.1-P1：健康与引用解释；若时间有限，批量健康检查延期。
6. 3.2-A：写作接入，覆盖 `/api/chat`、stream、context-analysis、恢复与无上下文回归。
7. 3.2-B：游戏接入，覆盖 turn、branch、active、stream、regenerate 与 World revision 不变。
8. 3.2-C：Narraverse 宿主协议增量接入，先只传 Ref/摘要，验证同源和旧 iframe 兼容。
9. 3.2-D：Module4 最后接入；正式 executable 中验证沙盒运行不改变 World JSON/revision。
10. 每个节点完成后再决定是否进入下一节点，不提前实现 Knowledge Workspace 或 2B.3 类 AI/世界模拟能力。

## 12. 最终裁定

- **Phase 3 总体：NEED REVISION。** 当前计划不能直接进入生产编码。
- **WorldContextSnapshot 方向：可保留，但需先完成第 9 节 1～3 项。**
- **服务端生成方向：原则上通过；需完成可信入口、错误/预算和生命周期契约后才可实现。**
- **四模式顺序：通过；按写作→游戏→Narraverse→Module4 分段实施。**
- **Timeline `canon → historical`：产品方向通过，兼容方案需修订并独立验证。**
- **Phase 3.1/3.2：可保留为阶段边界，但均依赖 3.0A/3.0B 的修订完成。**
- **Knowledge Workspace：继续只预留，不开发。**

下一次 Codex 节点审查应只核对：双投影与引用闭包、任务/重连生命周期、通用模型网关信任边界、Timeline 混合版本策略和预算/错误契约。通过后再进入 3.0A/3.0B 实施计划。
