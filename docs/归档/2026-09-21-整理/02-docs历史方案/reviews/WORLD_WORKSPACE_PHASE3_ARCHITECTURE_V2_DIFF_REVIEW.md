# Phase 3 Architecture Plan v2 Diff Review

- 复审时间：2026-09-10 19:36（Asia/Shanghai）
- 复审基线：`main` / `55fc07a2382ee2196c01b1d824d81b5ffbb42456`
- 复审对象：`docs/plans/WORLD_WORKSPACE_PHASE3_ARCHITECTURE_PLAN.md` v2
- 复审方式：只核对 v1→v2 文档 diff 与当前源码契约；未修改生产代码、未创建 API、未运行模型或构建

## 1. 结论

**结论：NEED REVISION。**

v2 已经覆盖上轮提出的六项主题，且 3.0A/3.0B 拆分方向正确；但尚不能直接进入 3.0B 或四模式接入开发。原因不是整体架构方向错误，而是 v2 仍有一处与当前真实调用链冲突，以及若干会影响数据安全和可实现性的契约未完全冻结。

## 2. 六项修订核对结果

| 评审项 | v2 核对结果 |
| --- | --- |
| 双投影 | **已补齐**。内部 Snapshot、`projectForUI`、`projectForModel` 和 ModelView 脱敏规则已分开；context-analysis 要展示实际 ModelView。 |
| Ref 生命周期 | **基本补齐**。已覆盖首请求、task/run、SSE、active、重连、context-analysis、regenerate 和 iframe，并规定 fingerprint 不一致拒绝。 |
| consumer 可信边界 | **文档已补齐，源码边界未闭合**。v2 要求浏览器不能直达通用网关，但当前 `app/ai-client.js` 仍直接 `POST /api/model/chat`，`module` 仍来自客户端。 |
| Timeline 兼容 | **基本补齐，但写入损失语义需修订**。已回答五问并拆为 3.0A；未知 category 归 background 后再次保存可能丢失原始未知值。 |
| selection 闭包 | **基本补齐**。已覆盖归一化、entity/world binding、外键裁剪和整体拒绝；“先去重”与“重复伪造 id 直接拒绝”存在语义冲突，需明确。 |
| 预算/错误/日志 | **方向已补齐**。稳定错误码和日志脱敏明确；token 估算仍未给出实际确定性公式，黄金样例无法据此实现。 |

## 3. 必须修改项

### P0：修复通用模型网关的真实调用边界

源码事实：

- `app/ai-client.js` 的 `NarraverseSharedAI.chat()` 直接调用 `/api/model/chat`；
- `app/app.js` 根据 `module4-active` 在浏览器选择 `module4` 或 `narraverse`；
- `denova-src/internal/api/handlers/handler_model_gateway.go` 当前直接 BindJSON 为 `ModelGatewayChatRequest` 并调用 `GenerateModel`。

因此 v2 的以下两条目前不能同时成立：

1. “通用 `/api/model/chat` 拒收浏览器自由 consumer”；
2. “Narraverse/Module4 复用现有浏览器共享模型网关调用链”。

v2 必须在文档中选择并冻结一种真实方案：

- 为 Narraverse/Module4 增加服务端受控的模式调用入口，浏览器只提交经过宿主绑定的 run/context 句柄；或
- 明确改造 `/api/model/chat` 的请求鉴权/上下文绑定，使它能区分受控 iframe 调用与浏览器伪造，并将 consumer 从客户端字段改为服务端会话/调用上下文；或
- 如果首版不接入 World Context，则把 Narraverse/Module4 从本期 3.2 移出，而不是宣称已经具备可信 consumer 边界。

不能只在文档中把 `module` 描述为“不是授权依据”，却保留当前客户端直调路径。

### P1：冻结 run 元数据的存活、清理与重启语义

v2 规定把 fingerprint 或 ModelView 绑定到 task/run 的非 World 元数据，但没有说明：

- 绑定存在哪个现有 task/run 对象或服务层；
- 是否跨 Denova 重启存在；
- 何时过期和清理；
- 是否允许把 ModelView 放进任务日志、故事存档或可导出的运行数据；
- 服务端重启后 active/reconnect 是拒绝、无上下文降级，还是要求新 run。

至少需要冻结：`runContext` 的生命周期、TTL、最大大小、不得进入通用日志/故事存档的规则，以及重启后的明确错误或降级行为。不得用“非 World 元数据”作为未定义的第二真源。

### P1：补足 Timeline 未知值的保真策略

v2 规定未知 category 读取时显示为 `background` 并产生 warning，下一次 CAS 保存时写入新三值。这样会在用户没有明确编辑该条目的情况下，静默丢失原始未知值。

需要二选一并写入 3.0A：

- 保存时保留原始未知值，直到用户在 UI 明确选择新分类；或
- 保存前把“未知值将规范化为背景”作为显式数据修复动作并记录可撤销/可恢复信息。

同时把“独立可回退”改成精确表述：代码提交可回退不等于已写入新枚举的数据可由旧二进制继续读写。若不提供数据备份/恢复，必须明确 3.0A 的升级栅栏和旧版本打开行为。

### P1：给出 token 估算器的实际公式

“固定系数估算器”还不是可实现契约。v2 必须写出：输入规范化规则；中文、英文、数字、空白、emoji、标点的计量方式；系数或分段公式；向上取整/保守系数；headroom 的具体常量；与 12,000 上限的比较顺序。

否则不同实现可以对同一 ModelView 得出不同预算结果，黄金样例也无法判定唯一答案。

### P1：消除 selection 重复项语义冲突

§5.1 写的是所有 id 数组先去重；§5.3 又把“重复伪造 id”列入整体 `selection_invalid`。需要明确：普通重复值是否幂等归一化；只有无法解析、跨 World、越权或 entity binding 偷渡才拒绝；如果要把重复视为攻击信号，必须取消“先去重”并定义检测顺序。

建议普通重复值幂等去重，错误只针对非法/越权/不属于当前 World 的引用，避免前后端预览与服务端结果不一致。

## 4. 需要补强但不阻止 3.0A 计划的事项

- `contextFingerprint` 应采用带明确分隔和字段版本的规范化输入，至少包含 Snapshot schemaVersion、consumer、World revision 和 canonical selection，避免不同 consumer/版本意外复用同一 fingerprint。
- UI 所谓“显示被闭包省略的悬空引用”需要在内部 Snapshot 中保留脱敏后的 omission audit；否则投影函数不能回读完整 World，又无法解释哪些引用被裁剪。
- `sourceRef` 应明确为随机/不可逆的非寻址值，不能只是对 `masterItemId` 做可逆编码；测试要验证跨 run 不可作为 API 路径或写入凭证。
- 错误码表中的 `world_not_found`、`revision_conflict`、`world_archived` 与已有 World API 错误应明确映射层，避免前端把 World 保存 CAS 冲突误判成 Context 加载冲突。
- 3.0B 的 ModelView 预算应保证 context-analysis 展示与模型实际提示使用同一份序列化结果，不能展示前端再次格式化后的近似文本。

## 5. 可以通过的设计

- World 仍是唯一持久化真源，Snapshot 不进入 World JSON。
- 服务端从 `worldId + expectedWorldRevision + selection` 重读并投影，拒绝客户端完整 World/Snapshot。
- entity scope binding 随入选实体派生，world scope binding 才可单独选择；不增加 `ownerId` 或持久化 `references[]`。
- World 外键按选择闭包裁剪，不自动扩容到用户未选实体；非法选择整体拒绝，不返回部分快照。
- Timeline 不再使用 Canon 产品语义，模式剧情、回合、对话和沙盒事件不自动进入 World Timeline。
- 写作→游戏→Narraverse→Module4 的渐进接入顺序合理；Module4 最后接入并要求正式 executable 验证 World revision 不变。
- Knowledge Workspace 继续只保留用户主动片段引用原则，本阶段不开发。

## 6. 是否允许进入下一阶段

- **进入 3.0A 实施计划：可以，但需先修订未知值保真、单向升级/回退措辞，并补齐具体测试契约。** 3.0A 与模型网关无关，可保持独立提交。
- **进入 3.0B 编码：暂不允许。** 先完成第 3 节的 P0/P1 修订并做一次文档复审。
- **进入 3.2 四模式接入：不允许。** 当前 `/api/model/chat` 的真实浏览器调用边界尚未与 v2 的 consumer 可信边界一致。

## 7. 推荐顺序

1. 修订 v2 文档：真实模型网关调用边界、runContext 存活/清理、Timeline 未知值保真、token 公式、selection 重复语义。
2. Codex 复审上述 diff。
3. 独立实施 3.0A Timeline 兼容并完成混合版本/数据安全测试。
4. 冻结 3.0B Snapshot 双投影、闭包、fingerprint、预算、错误和 runContext 契约。
5. 实施 3.1 控制台选择与 UI 预览。
6. 依次验收写作、游戏、Narraverse、Module4；每一步都保留无上下文回退。

## 8. 最终裁定

**Phase 3 Architecture Plan v2：NEED REVISION。**

不是六项修订缺失，而是文档契约与当前真实 `/api/model/chat` 调用链仍存在冲突。修订并通过下一轮 diff 后，3.0A 可先行；3.0B 和四模式只读连接必须等待通过。
