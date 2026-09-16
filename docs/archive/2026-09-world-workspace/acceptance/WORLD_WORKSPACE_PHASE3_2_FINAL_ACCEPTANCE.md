# World Workspace Phase 3.2 Final Acceptance

> 验收日期：2026-09-15～2026-09-16
> 结论：**PASS（代码、正式 executable 与外部 DeepSeek 真实生成闭环全部通过）**

## 1. 验收范围与提交

Phase 3.2 的目标是把 World 的只读背景安全提供给四种运行模式，同时保持 World 为唯一持久化真源，禁止剧情状态、模型输出或运行进度自动回写 World。

| 范围 | 关键提交 | 结果 |
| --- | --- | --- |
| 3.2-A 写作模式 | `9da74a3` 及其祖先 A1-A6 提交 | 已完成并验收 |
| 3.2-B 游戏模式 | `f8e2d9731cd2b364d05331614445db01e35927ca` 及其祖先 B1-B3/修复提交 | 已完成并验收 |
| 3.2-C Narraverse | `54efb2e` | 本轮正式验收通过 |
| 3.2-D Module4 | `54efb2e` | 本轮正式验收通过 |
| C0 安全冻结 | `1befe81c4b29ca0a5d6d708f3e45d3c08d50ca25` | PASS |

本轮在独立 worktree `D:\Narraverse2.0-wt-c0`、分支 `codex/phase3.2-c0` 上实施与验收，没有修改主工作树或用户真实 World 数据。

## 2. 最终结构

```text
World（唯一持久化真源）
  └─ WorldContext Snapshot / Projection（只读派生）
       ├─ Writing Task（临时模型输入）
       ├─ InteractiveRun（临时模型输入）
       ├─ Narraverse host binding（进程内）
       └─ Module4 host binding（进程内）

127.0.0.1 顶层宿主
  ├─ 一次性 fragment bootstrap
  ├─ HttpOnly SameSite=Strict 宿主会话
  └─ 受控 bind / call / unbind
        └─ localhost iframe（不持有凭据、Ref、runContext 或 ModelView）
```

新增的宿主 session、frame binding、Snapshot、Projection 和 runContext 全部只存在于进程内，不写入 World、Narraverse 对话、Module4 存档或新数据库。Narraverse 与 Module4 仍保存各自剧情/冒险运行数据，但不能自动修改 World。

## 3. 正式 executable 浏览器验收

使用当前源码构建的正式 Denova executable，在隔离 home、隔离 workspace、端口 `18090` 和独立 Edge profile 中验收。第一轮使用隔离 HTTP mock，真实接收宿主发出的 HTTP 模型请求并断言请求中包含冻结只读抬头和测试 World 内容；第二轮使用用户授权的有效 DeepSeek 配置，在相同正式页面路径补跑真实供应商生成。凭据只临时写入隔离验收配置，补验后已移除，不进入源码、Git、日志或本报告。

| 断言 | 结果 |
| --- | --- |
| bootstrap fragment 使用后清除 | PASS |
| 原 `127.0.0.1` 浏览器资料保留 | PASS |
| World Console 的 Narraverse 交接可用 | PASS |
| 白名单 localStorage / IndexedDB 迁移到 `localhost` | PASS |
| iframe 无法访问父页面 DOM | PASS |
| iframe 直接调用特权宿主路由被拒绝 | PASS |
| Narraverse 模型请求收到只读 World 背景 | PASS |
| Narraverse 显示 active 状态 | PASS |
| Module4 模型请求收到只读 World 背景 | PASS |
| Module4 可正常打开并保持独立运行态 | PASS |

浏览器控制台错误：0。网络错误：0。

2026-09-16 的真实 DeepSeek 补验结果：

- Denova `/api/model/test` 对 writing、game、narraverse、module4 四个模块均返回连接成功，生效模型为 `deepseek-chat`。
- Narraverse iframe 在 active World Context 状态下返回指定真实生成标记。
- Module4 iframe 在 active World Context 状态下返回指定真实生成标记。
- 同一轮 10 项浏览器断言全部 PASS，浏览器控制台错误 0、网络错误 0。
- 一次性 bootstrap fragment 使用后清除；iframe 仍无法访问父页面 DOM，直接调用特权宿主路由仍被拒绝。

正式验收期间还发现并修复了两项真实运行缺陷：

1. Edge 将 `localhost` 解析为 `::1` 时 iframe 无法访问仅监听 IPv4 的 Denova。现在本地模式会启动仅绑定 `[::1]` 的同端口回环伴随代理并转发到 `127.0.0.1`，不会开放 LAN 监听。
2. iframe ready 后立即发出的第一条模型请求可能早于异步 bind。现在模型调用会等待对应 consumer 的 in-flight bind 完成，回归测试锁定“bind 完成前不得 call”。

## 4. World 单一真源验证

测试 World：`world-9urk27kh6nind3lu.json`。

- 运行前 SHA-256：`f9a4655ed77614654c3bceaa101da826709c096d890e820dd66e31b3690e0e26`
- Narraverse 与 Module4 调用完成后 SHA-256：相同
- World revision：相同
- World 写端点：0 次

结论：四模式接入只读取并派生背景，没有把剧情、对话、事件、模型输出或运行状态写回 World。

## 5. 自动门禁

### Go

- `go test ./internal/worldcontext ./internal/api/handlers -count=1`：PASS
- `go test ./internal/app -run 'WorldContext|InteractiveRun' -count=1`：PASS
- `go test ./internal/api -run 'TestIPv6LoopbackCompanion|TestNewServerUses|TestWorldContextHost' -count=1`：PASS
- `go vet ./internal/worldcontext ./internal/app ./internal/api/... ./cmd/denova`：PASS
- `go build ./cmd/denova`：PASS

`go test ./internal/api -count=1` 的唯一失败是既有 `TestWorkspaceSwitchCanonicalizesSymlinkIdentity`，原因是当前 Windows 会话没有创建符号链接的权限，与本轮代码无关。C0 外部 Edge 探针的安全断言已通过，但 Edge 子进程会在测试退出时短暂锁住临时 profile，故全包运行可能在 TempDir 清理阶段报错，按环境清理问题单列。

### Web

- C/D 定向回归：8 文件、78 项 PASS
- `tsc --noEmit`：PASS
- i18n：3885 个 zh-CN/en-US key 对齐
- `node --check`（Narraverse bridge/client/migration）：PASS
- production `vite build`：PASS（仅既有大 chunk 提示）
- 全量 vitest：191 文件中 189 文件通过，1169/1171 项通过；本轮引入的 `ModeRouter` 旧同源断言已修正并单独通过

全量剩余项均非本轮功能失败：`main.test.tsx` 仍受既有 localhost→127.0.0.1 重定向守卫影响；另两个测试 worker 在长时间全量并发中启动超时，相关定向测试均通过。

## 6. 安全与兼容性结论

- 顶层宿主与 iframe 具有真实跨源边界。
- bootstrap secret 只使用一次且不持久化；宿主 token 只存在 HttpOnly Cookie 与服务端内存。
- consumer 由宿主固定，iframe 不能自报或切换 consumer。
- iframe 请求严格限制字段、数量、字符数与字节数；通用 `/api/model/chat` 拒绝 World 控制字段。
- iframe 不得到 World Ref、scopeKey、runContextId、fingerprint、sourceRef、runSalt、ModelView 或 API Key。
- 旧 iframe v1 / standalone 模式继续以 bare 方式工作；旧浏览器资料迁移源数据保留，目标非空时不覆盖。

## 7. 外部模型验收

2026-09-15 首次探针使用的旧环境凭据返回 HTTP 401，已如实分类为环境凭据问题。2026-09-16 在用户明确授权后，将新凭据仅配置到隔离验收 Denova 数据目录，重新启动正式 executable 并完成补验：四模块共享模型探针全部成功，Narraverse 与 Module4 各完成一条真实 DeepSeek 生成，返回值与预期标记一致。

本次补验完整覆盖：正式 Denova → 一次性宿主 bootstrap → 受控 bind/call → World 临时只读注入 → DeepSeek → iframe 返回值与 active 状态。未把凭据写入源码、Git、协作日志、验收报告或浏览器证据文件；补验结束后已删除隔离配置中的凭据与一次性启动 URL。

## 8. 最终裁定

- P0：0
- P1：0
- 代码与正式 executable：**PASS**
- World 单一真源：**保持**
- Phase 3.2-A/B/C/D：**实现完成**
- 外部 DeepSeek 真实生成：**PASS**
- main 合并：尚未执行，需用户明确批准
