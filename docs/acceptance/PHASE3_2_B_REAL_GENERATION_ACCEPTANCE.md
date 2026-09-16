# Phase 3.2-B Real Generation Acceptance

## 1. 结论

**PASS WITH FOLLOW-UPS**：当前 B 分支已完成一次真实的 World Context → InteractiveRun → DeepSeek 模型生成闭环。World 未被改写，运行态背景未进入非 World 持久化文件。

本结论允许进入后续验收收口，但不等同于允许开始 3.2-C。

## 2. 验收对象与环境

- 分支：`phase3.2b-game`
- commit：`d1dfc01db457bd935eadcce283ac41312607ccce`
- 正式 executable：`D:\Narraverse2.0-wt-a1a\denova-b32-real.exe`
- 前端装配：`denova-src/web/dist-b32-real-verify/`
- 隔离数据目录：`.acceptance-real-b32/home/`（验收后清理）
- 正式 URL：`http://127.0.0.1:18085/`
- 模型：DeepSeek 兼容 OpenAI API；凭据仅临时注入进程环境，未写入仓库、配置、日志或报告。

## 3. 真实闭环结果

| 路径 | 结果 |
| --- | --- |
| 创建临时 World | PASS，HTTP 201 |
| World context-analysis | PASS，状态 `bound`，返回一次性 handle；handle 长度 43 |
| 分析上下文包含 World 背景 | PASS，`context_messages` 含 `world_context` |
| 首次游戏请求携带 handle | PASS |
| InteractiveRun 绑定 | PASS，SSE 状态为 `active` |
| handle 消费 | PASS，状态为 `consumed` |
| 真实模型生成 | PASS，收到非空模型 chunk 与 `done`，无 error 事件 |
| World revision 前后 | PASS，保持 `sha256:b388bb...`，未发生写入 |
| World 背景污染运行数据 | PASS，扫描 28 个非 World 文件，背景抬头与世界名命中均为 0 |

## 4. 自动门禁

- Go：`internal/app`、`internal/agent`、`internal/api/handlers` 定向测试通过。
- 前端：StoryStage、ModeEntries、WorldConsolePage、world-context-runtime 共 5 个文件、102 项测试通过。
- `tsc --noEmit`：通过。
- i18n：zh/en 3877 键对齐。
- Vite production build：通过，仅有既有大 chunk 警告。
- `go vet`、`go build ./cmd/denova`、`git diff --check`：通过。

## 5. 未验证与后续

- 本轮未做完整浏览器点击链路；前端闭环由新增组件测试覆盖，HTTP 与正式 executable 链路已实测。
- 尚未验证 regenerate 的真实模型第二回合；服务端 TurnIndex 复用由定向测试覆盖。
- 真实 DeepSeek 生成已经成功；此前继承环境中的旧凭据曾导致一次 401，已改为本次临时有效凭据重验并通过。

## 6. 清理与边界

验收服务已停止，18085 端口已释放。临时 executable、dist、隔离数据和启动脚本不进入 Git；原有未跟踪 `denova-src/denova.exe` 保留不动。

本次未修改 Module3/Module4、World 真源、iframe/capability、全局模型代理或新增持久化层。
