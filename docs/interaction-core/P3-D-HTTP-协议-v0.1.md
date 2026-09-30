# Interaction Core HTTP 协议 v0.1（P3-D）

状态：A 于 2026-09-29 定稿接口边界；**尚未实现 HTTP 路由，尚未验收浏览器链路**。基线为 `codex/interaction-core-fusion @ 9689f35`。本协议只服务本机单玩家 Demo，沿用现有进程内会话与 Pending；正式 Narraverse 的鉴权、持久化和多实例部署另立阶段。

## 目标与权威

浏览器输入一句玩家原话，服务端依次做解释、规则结算与可选真实 Laya Evidence，返回一个可查看的候选；用户或上游确认后，以候选引用 Commit；下轮从已提交状态读取。Prepare 不改游戏状态、正式历史或时钟；Commit 是普通回合的唯一写入口。首次 `ensure_scene` 是**显式场景创世操作**，有自己的幂等语义，不藏在 GET 或 Prepare 中。

沿用 `laya_bridge.py` 的 `ThreadingHTTPServer`、严格 `_read_protocol()` 和 `_json()`。新增路由全部置于 `/interaction/*`，不复用 `/analyze`、`/commit_state`、`/decide` 或 `/turn` 的响应语义。服务端进程内只创建**一个** `DeliveryCore` 实例，使用现有 `PROTOCOL` 锁、状态桶、版本与事件表；每请求新建 Core 会丢失 Pending，属错误实现。生产实例的 `evidence_provider` 与 `capability_identity` 只由服务端配置注入，采用 `laya_evidence.make_real_evidence_provider()` / `real_capability_identity`；测试可注入固定桩，但 HTTP 请求不能选 Provider、模型或档案。

## 端点

| 方法与路径 | 请求 | 成功结果 | 副作用 |
|---|---|---|---|
| `GET /interaction/state?session_id=...` | 仅会话 ID | `DeliveryCore.state()` 的公开场景与完整实体版本集合 | 无；未初始化时也不建桶 |
| `POST /interaction/scene` | `{ "session_id": "s1" }` | 初始化实体清单和随后的公开 state；重复请求不推进版本 | 仅首次场景创世 |
| `POST /interaction/prepare` | 见下 | 解释摘要 + 候选预览；不就绪时无候选 | 可写进程内占位/Pending；不写游戏态 |
| `POST /interaction/commit` | 见下 | `DeliveryCore.commit()` 权威回执；同请求重放带 `replayed=true` | 唯一普通回合发布 |
| `GET /interaction/receipt?session_id=...&event_id=...` | 两个 ID | 已提交的玩家视角回执 | 无；用于 Commit 网络结果不明时查询 |

### Prepare 请求

```json
{
  "session_id": "demo1",
  "event_id": "turn_1",
  "message": "我问莉亚钥匙在哪，然后去旧井",
  "expected_versions": { "player": "v1:...", "lia": "v1:...", "ic_world": "v1:..." }
}
```

`session_id`/`event_id` 沿用 1–64 位 `[A-Za-z0-9_-]`；`message` 为非空且最多 4000 字符。`expected_versions` 必须精确等于公开 state 返回的完整版本映射。第一版行动者由服务端固定为 `player`，请求**不接受** `actor_id`、`actions`、`history`、`directory`、`English`、`difficulty`、`delta`、`outcome`、`facts`、`evidence`、`confidence` 等额外字段；未知字段 422。

处理顺序：先校验请求和当前场景/版本，避免 stale 请求消耗云端调用；再调用 `laya_delivery_interpreter.interpret_turn(..., actor_id="player", history=None, p1_projection=False)`，让历史和目录来自服务端；仅当 `interpretation.status=ready` 且组装成功时，把其内部 `prepare_request` 交 `DeliveryCore.prepare_structured()`。云端解释期间版本若改变，由 Core 的版本复核拒绝旧候选。不要从模型文本直接构造权威状态变化。

成功预览返回至少 `protocol_version=laya-delivery-v1`、`status`、`event_id`、`analysis_id`、`base_versions`、`can_commit`、`expires_at`、逐动作 `resolutions`、`rules_only`、精简 `laya_evidence`、`evidence_absent_reason` 与可供玩家确认的变更摘要。`analysis_id` 与版本从 Core 原样读取，不重新生成。响应按**玩家视角白名单**整理；不要把 `interpret_turn` 的 `directory`、`history_used`、原始模型响应、Prompt、Provider 输入或 NPC 私有 `knowledge` 原样输出。允许展示本轮权威预览所获得、面向玩家的线索，但不得泄露别的角色未披露知识。`can_commit=false` 时页面应展示原因，不能自动 Commit。

**运行翻译与测试基线分开。** 现有 `make_real_evidence_provider()` 的默认 `translation_cache_lookup` 只读冻结资产，适合 P3-B 固定小样；若生产 HTTP 原样采用默认值，普通新句子几乎都会 `translation_missing`，不能宣称 Laya 已接入自由输入。D1 服务端实例需显式注入运行翻译查询：复用现有 `laya_bridge._cached_translate(text, runtime_cache)` 的「基准输入只读冻结、未知输入冻结优先→运行缓存→在线翻译」纪律，运行缓存单独受锁保护且绝不写回 `tests/assets`。翻译失败返回 None，Evidence 缺席为 `translation_missing`，规则动作仍可独立结算；不要回落中文直接推理，不要把测试时的固定注入入口暴露给 HTTP 客户端。实际在线翻译会花费额度，D1 定向验证全部用桩；真实调用额度留 D2 小样。

解释层 `needs_clarification` 返回 409 `NEEDS_CLARIFICATION`、`unsupported` 返回 409 `UNSUPPORTED_OPERATION`，都不建 Pending；`invalid` 若由云端 401/402/429/超时或无可解析响应造成，返回 502 `INTERPRETER_UNAVAILABLE`，其余非法解释返回 422 `INTERPRETATION_INVALID`。错误响应均带 `protocol_version=laya-delivery-v1` 与 `{error:{code,message,details}}`；不要在 500 中回显异常 `repr`、Key、完整云端响应。Core 抛出的 HTTP/错误码予以保留，只把外层协议版本改为 delivery v1。

### Commit 请求

```json
{
  "session_id": "demo1",
  "event_id": "turn_1",
  "analysis_id": "dl_...",
  "expected_versions": { "player": "v1:...", "lia": "v1:...", "ic_world": "v1:..." }
}
```

仅转交 `DeliveryCore.commit()`；绝不接收客户端的动作、状态变化、成功档位、Evidence、档案身份或叙事文本。网络超时后先查 `/interaction/receipt` 或重放**完全相同**的 Commit；不得重新解释并二次提交。只有 Commit 回执是对 Story Agent 的事实权威。D1 不接 Narration；叙事失败时保留 Commit，不重做回合。

## 同事件入口去重

Core 的 in-flight 保护从 `prepare_structured()` 开始，但 `/interaction/prepare` 会先调用云端解释。HTTP 编排层需在云端调用前，按 `(session_id,event_id)` 登记短期单飞，避免同一事件的两个并发请求重复花费云端额度。相同请求在执行中返回 409 `PREPARE_IN_PROGRESS`；同事件不同 `message` 或版本返回 409 `EVENT_PAYLOAD_CONFLICT`。首次完成后，在候选有效期内缓存**服务端已校验的解释结果/组装请求**，相同请求重试不得再次调用云端，而由 Core 复用候选或给出其当前冲突/已提交结果。异常要释放 in-flight；缓存有界、到期清理，不当作正式状态。版本已变意味着新尝试，页面使用**新 event_id** 重新发起。

## 本机访问边界

服务器继续只监听 `127.0.0.1`。`/interaction/*` 只用于同源页面：有 `Origin` 时必须与该服务的实际 origin 一致；无 Origin 的本机诊断请求可用。现有全局 CORS 为 `*`，所以仅设置响应头不能保护新状态路由：跨源请求必须在进入解释器、初始化或 Commit 前实际拒绝，且 OPTIONS 与实际请求口径一致。D1 不做外网部署或用户鉴权，也不声称本地会话 ID 具备授权意义。

## D1 最小验收与后续

在本机临时端口、注入固定 Interpreter/Provider 的真实 HTTP 路由上，证明：公开 GET 零写；显式场景创世幂等；原话到 Prepare 前后游戏态深比较相同；Commit 后多实体版本与下轮 state 改变；重复 Commit 不二次记账；stale/不同载荷/未知字段/非就绪解释均明确失败；并发同事件只有一次解释调用；外站 Origin 在模型调用与写入前被拒；响应无 NPC 私有知识；运行译文缺失时不调用 Laya，冻结资产不变。这里只做定向检查，不运行 CUDA、云端、长基准或浏览器。

D1 完成后由 A 复审实际 HTTP 边界；D2 再把页面接到这些端点并做浏览器真实链路；D3 才接只读 Commit 回执的叙事消费与少量真实试玩。P2-C2 的四轮单次通过和 P3-B 的三句 CUDA 写入各自成立，**尚未证明** HTTP/浏览器合流、长对话稳定性或 Laya 对体验的增益。
