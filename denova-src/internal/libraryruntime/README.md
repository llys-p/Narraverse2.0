# libraryruntime — 作品设定库临时读取授权核心（B1/L3.0 已实现）

状态：核心已实现并经单元+集成测试验收（2026-09-24）；**尚未接线任何模式**——
写作/游戏/叙界/Module4 的 transport、handler、agent 装配与前端入口属于 B2/B3/B4。
契约唯一依据：[L3 计划 §8](../../docs/plans/LIBRARY_L3_MODE_INTEGRATION_PLAN.md)（B0 冻结）。

本包提供 per-run 授权对象 `Run`（无包级状态、无新 Registry）：

- `Bind`：服务端派生身份（consumer/scopeKey）+ 固定 revision + 用户显式 manual
  授权集；绑定期任何失败（身份不受信、revision 冲突、manual 集含禁用/跨库/未知项、
  预算装不下）都阻断启动，不静默降级。
- `AssembleInitial`：经 `librarycontext.Build` 装配库概览+常驻正文+授权 manual 正文+
  有界 auto 目录，包上冻结只读抬头，以 `EphemeralLibraryContext` 只返回给当次模型输入。
- `ReadOnDemand`：按需读取仅限目录内启用 auto 条目或已授权 manual 条目；禁用、
  跨库、未知、resident、未授权 manual 一律 denied；reference 条目经受控 Resolver
  核对固定来源版本；每次读取重新核对库 revision（漂移即 stale）并计入累计预算
  （重复读取照计）。
- `Complete`/`Cancel`：幂等清理（首个终态生效），终态后读取显式 released。
- `Status`：只含元数据与稳定错误码（active|completed|cancelled +
  unavailable/stale/denied/budget_exceeded/released），绝不伪装 active 或静默 bare。

冻结不变量：Run 不保留正文；库文件与 Master 原件零写入；错误只暴露稳定码；
Locator 不是读取许可；模型提交的任何 ID/身份对授权无效。

依赖方向：libraryruntime → librarycontext → library；App 适配见
`internal/app/library_runtime_service.go`（注入 provider+受控 Master resolver）。
禁止反向依赖 App/HTTP/agent、禁止第二模型链、禁止持久化 Library 副本。

接线顺序（后续批次）：先写作（B2a/B2b/B2c），再游戏（B3），再既有受控叙界/Module4
通道（B4）。不得将 Library 转换为可写 World，也不得照抄 worldcontext 建平行生命周期
系统。复用现有抽象若足够，可只在现有适配文件接线。
