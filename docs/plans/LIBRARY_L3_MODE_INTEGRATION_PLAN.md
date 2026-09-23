# L3 四模式作品设定库接入骨架

日期：2026-09-22。**仅规划，未实现/未批准运行态接线**。先完成 L2。
本文件定义边界与验收，具体 wire 字段需在实现前对真实 handler 逐项核对，不能照搬内部结构。

## 1. 目标与复用事实

用户选一份作品设定库，再进入写作/游戏/叙界/沙盒；常驻背景进入首次模型输入，按需正文经受控读取获取，手动资料仅用户明确选择可读。
各模式可以选不同的库，也可以只读复用同一库；首版每个运行仅绑定一个库，不做多库自动合并。
**不是再次新增第五个运行模式，也不是新建一个“世界”中转存储。**

当前真实复用点（实现时再核对）：
- `internal/app/world_context_writing.go` 的 bind-before-start 和 session/task 生命周期。
- `world_context_interactive.go` 的新回合 resolve 与 regenerate 复用。
- `internal/agent/world_context_runtime.go` 的临时输入与历史隔离。
- `internal/worldcontext/registry.go` 的运行期引用释放原则，**不直接把 Library 伪装成 World Snapshot**。
- 现有共享模型网关、受控 iframe 宿主路径。前端 Provider 的存在不是交接已消费的证据。

## 2. 接入契约草图（非已存在 API）

服务端绑定的 LibraryReadRef：
- libraryId：唯一库；
- expectedRevision：选择时已保存的库版本；
- manualItemIds：本次用户明确授予读取的手动条目集合。
consumer、scopeKey、runContextId 不由用户或模型提供；受控入口派生。
auto 正文读取是模型在获准目录内的按需行为，不是额外授予 manual 权限。
L2预览的 autoItemIds 仅用于模拟本次读取，不自动成为长期授权。

服务端只在已建立运行身份后产生临时读取授权：
运行身份 + 固定库revision + 用户manual允许集 + 累积读取预算。
这不是新的持久化资料表。ID/revision/安全状态可作为非正文运行元数据，正文不进World/Library/剧情存档。

首版不缓存历史版本的整个库：绑定时先读/核版本；后续按需读取再比对版本。
运行中库变化 → library_revision_conflict，停止追加旧授权下的新正文，提示重选并开新运行。
已经进入模型的本轮临时片段可保留至运行结束，不能悄悄替换为最新版。
拒绝在旧revision授权下“重新读取当前文件再当成原版本”。

## 3. 背景来源互斥

每次运行的背景策略必须显式为 legacy / library / none（具体 transport 名称待核对）：
- legacy 保持已有 World/Lore 行为，不因新功能改变旧请求。
- library 使用一份新库；禁用旧背景**注入通道**，不删旧资料，也不禁写作正文/项目工具。
- none 不携带作品背景。
同时提交相冲突的 Library/World 控制字段必须报错，不能按任意优先级吞掉其中之一。
需核查旧 lore 工具与自动注入点；只移除一个提示片段并不能证明不存在暗中叠加。

## 4. 临时上下文与失败语义

- 初始输入：有来源标记的库概览、常驻正文、有界auto目录、明确选择manual正文。
- 按需工具：工具持有服务端授权对象；只允许目录内auto或用户已授权manual，禁用项不可绕过。
- 模型提交任意库ID、磁盘路径、consumer/运行身份均无效；每次读取校验归属和剩余预算。
- 预算覆盖初始输入+工具结果+历史+系统提示+预留输出；同一项重复读取不能绕过累计预算。
- 背景正文不得落Session、展示存档、run ledger、压缩源/summary。工具结果若通常持久化，必须先解决临时工具结果边界，不能直接沿用会写正文的默认路径。
- 新读取失败要显式 unavailable/stale/denied/budget_exceeded；不能标active却偷偷bare。
- 用户可显式选择“无资料继续”；无法读取背景不是允许默认静默降级的理由。
- 新库权限不是模型提示词安全沙箱；来源文本是不可信数据，不得授予工具/写入权限。

## 5. 生命周期矩阵

| 动作 | 规定 |
| --- | --- |
| 选择库/带入模式 | 仅组件内待交接Ref；目标书/故事选择成功才消费 |
| analysis首次预览 | 使用同一授权与投影，若复用现有handle，必须证明首次分析→运行同字节，不直接复用不同数据类型 |
| start | 完成库版本/预算检查后再启动模型，不得先启动再补绑定 |
| 写作新task | 由服务端session/task归属绑定；取消/切书清理未消费交接 |
| 游戏新回合 | 新InteractiveRun，Task仅执行尝试 |
| regenerate | 同InteractiveRun已有临时背景，不能依赖客户端重发Ref；背景已过期则明确失败/提示重选，不猜新版本 |
| reconnect | 复用同次运行与状态回放，不重抽来源、不重新授权 |
| 切故事/分支/iframe实例 | 清旧待消费交接；已经独立运行的任务按现有归属清理 |
| complete/cancel/destroy | 幂等释放临时上下文，无负refCount |
| 进程重启 | 不从剧情存档恢复背景正文或旧授权；显式重新选库/确认版本 |

## 6. 分段任务、文件范围与验收

| 批次 | 文件范围（拟） | 必须通过 |
| --- | --- | --- |
| L3.0 契约与授权 | libraryruntime、app/agent的最小接口及测试；transport单独DTO | 背景互斥；手动授权不可伪造；禁用/跨库拒绝；无模型/数据写入 |
| L3.1 写作纵向 | 写作handler/app/agent临时注入、对应前端Provider/入口/状态条 | 挂载后交接真实被消费；analysis/首发/取消/重连；模型实际输入有且仅有获准内容；落盘无正文 |
| L3.2 游戏纵向 | interactive handler/app/StoryStage、现有InteractiveRun | Turn持久化后才建索引；regenerate复用；切故事/分支不串库；active/degraded/none真实可见 |
| L3.3 叙界 | 宿主受控bind/call及对应入口 | 不改iframe信任根；无库Ref/运行秘密泄漏；第一请求等待绑定 |
| L3.4 Module4 | 仅现有受控适配与入口 | 不改Adventure规则/存档真源；动作成功与背景读取状态独立 |
| L3.5 收口 | 全套回归+正式exe+真实模型 | 四模式实际读取、无剧情回写、重连/取消/过期、无持久正文、Key脱敏 |

文件范围需在每批开始前按真实调用点精确化，不能以此表授权整目录重构。
CHANGELOG、协作日志、中英文字由集成者集中修改，避免并行冲突。
每个纵向批次独立commit；一次完成整段再审查，避免逐函数等待审批。

## 7. 不做与风险

不做新Agent系统、世界模拟、全局Canon、剧情自动同步、多库合成、新模型网关或新密钥设置。
最大风险：预览绿但实际不注入；按需工具把正文写入Session；旧Lore暗中叠加；客户端用ID冒充授权；游戏regenerate换背景。
每一项都需真实消息装配或存储扫描证据，UI徽章/200响应不足以放行。
