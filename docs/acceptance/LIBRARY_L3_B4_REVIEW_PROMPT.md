# 给 Trae 的复核提示词 · 作品设定库 L3（B4 段 + B5 脚手架）

> 用法：把下面「提示词正文」整段交给 Trae（它在本仓库工作树内运行可直接读文件）；本文件本身也可让 Trae 直接打开。

## 提示词正文

你是本项目的**独立复核方**（只读审查）。请在 `D:\Narraverse2.0-b2a`（分支 `library-b2a`）对"作品设定库 L3 · B4 段 + B5 脚手架"这一轮工作做一次**证据驱动的复核**，给出结论并按项目规则落档。

**硬性边界（务必遵守）**

- 只读审查：**不修改、不提交、不推送**任何文件；不动主工作树 `D:\Narraverse2.0`；不碰用户的 8080 实例；`artifacts/` 不入 Git。
- 允许且鼓励：运行测试/脚本复验（假模型路径不需要任何真实密钥，用 `OPENAI_*` 指向本地假端点即可）。
- 18088 端口上有一个在运行的"体验实例"（我搭的，供用户试玩）——**不要停止或改动它**。
- 结论请按项目规则写入 `D:\Narraverse2.0-b2a\项目协作日志.md`（精确时间、时间倒序置顶）。

**背景（先读这些）**

1. `docs/acceptance/LIBRARY_L3_B4_HANDOFF.md`——本段交接：§1 提交清单（`e570b0e..dfbda8c`，18 个本地提交，另有其后文档提交）、§2 契约边界、§3 复核命令、§5 已知缺口、§7 复审修复轮。
2. 上一轮复核基线：`0e46907`/`e570b0e`（B3 D1 脱敏修复，已 PASS）。
3. 前一轮只读子代理的结论：**B4a/B4b 宿主绑定、消费者隔离、前端交接静态审查无新阻断项**；问题集中在 B5 验收脚本可能"误报全绿"的三处 → 已在 `dfbda8c` 修复（就是你这次的重点复核对象）。

**你要验证的内容**

一、脚手架 fail-closed 修复（`denova-src/scripts/library-acceptance/`，重点）

1. `run_smoke.py`：确认"就绪"判定不依赖端口裸响应——须等**本进程 stdout** 报出 `后端服务: http://…`，并校验进程存活、实际端口与请求端口一致、响应含 `has_state` 特征字段，否则拒绝写入。**请尝试证伪**：用 `artifacts/harness-review-fixes/dummy_port_server.py` 之类占位服务占住 18085 再跑 `run_smoke.py`，期望 exit 1 且占位服务收到 **0 请求**（该负例证据见 `artifacts/harness-review-fixes/dummy-negative-run.txt`）。
2. `drive_writing.py` / `drive_game.py`：确认分链 SSE 断言真实存在且失败会退出非零——写作链要求 `finishReason:stop`+`[DONE]`+无 error 事件；游戏链要求 `library_context_state` 首帧、工具往返（`tool_call`/`tool_result`）、`interactive_turn_persisted`、`done`、无 error 事件。可自行构造反例（例如把 `FAKE_READ_ITEM` 指向不存在条目，观察 ledger 断言是否拦住；**测完把文件恢复原状**）。
3. `scan_markers.py`：确认 `os.walk(..., onerror=...)` 真正接线（不是定义了没接）；用悬空 junction 复现"遍历错误 → exit 1"（负例证据 `artifacts/harness-review-fixes/scan-walk-error-negative.txt`）。
4. `run_smoke.py` 结尾校验：模型侧取材必须是**分链**判定（writing/game 各自），且要求游戏 run ledger 存在**元数据化**读取事件（`itemId=auto-1`、preview 无正文标记）；确认没有"任一日志命中即通过"的残留路径。
5. 全绿复跑：`python denova-src/scripts/library-acceptance/run_smoke.py`，期望 exit 0（证据 `artifacts/harness-review-fixes/smoke-green-rerun.txt` 可对照）。

二、B4 关键路径抽查（静态）

- 后端：`internal/app/world_context_host.go`（`bindLibrary` 的 scopeKey 派生/绑定失败不留半绑定/`releaseBinding` 的 Cancel/Complete 语义/`generate` 的注入与计费）、`internal/api/handlers/handler_world_context_host.go`（严格键、与 world 互斥、库错误映射复用）。
- 前端：`features/narraverse/NarraverseWorkspace.tsx`（launchedAt 互斥裁决、首个请求等待绑定、败者 pending 清除）、`features/library-context-runtime/IframeLibraryContextLaunchProvider.tsx`、`features/library-workspace/components/LibraryContextPreview.tsx`（Ref 三字段、草稿禁用、宿主守卫）。

三、声明与文档一致性

- 提交计数：核对 `git rev-list --count e570b0e..dfbda8c` **应为 18**（含复审修复轮）；`dfbda8c` 之后应仅有文档类提交（`d6badbd` 交接更正 + 本提示词落档），可用 `git log --oneline e570b0e..HEAD` 逐一核对；另核对上一版交接文档曾把数量写成 16、已在 `d6badbd` 更正。
- 交接文档 §5 的缺口是否如实（页面验证待资产、B5 真实模型轮未做、分支未推送、18088 实例在跑）；清单 B5 条目与 CHANGELOG 是否与事实一致。

四、回归门禁（可复跑，命令见交接 §3）

- `go test ./internal/app/ -run TestWorldContextHost -count=1`（10 例）；`go test ./internal/api/handlers/ -count=1 -v`（80 例）。
- `go test ./internal/app/ -count=1 -v`：预期 **250 过 / 1 失败**，失败只能是既有 Windows symlink 环境用例 `TestActiveAutomationReservationAtomicallyAttachesConcurrentCaller`（干净树同败，属环境问题）。
- 前端受影响套件 18 文件 88 例 + `tsc --noEmit`；`go vet` 两包；`go build ./cmd/denova`；`git diff --check e570b0e HEAD`。

**输出格式（请照此给结论）**

1. **结论**：PASS / PASS WITH FOLLOW-UPS / NEED REVISION（一句话理由）。
2. **逐项发现**：每条给 文件:行号 或 命令 + 实际输出；标注"阻断/非阻断"；阻断项给最小复现步骤。
3. **未验证项**：明确列出你**没有**验证的内容与原因。
4. **落档**：按项目规则把结论（含时间戳）写入 `项目协作日志.md`。

## 备注（给用户）

- 上一版交接文档把提交数写成 16（实际 17），已在 `d6badbd` 更正为 18 并加 §7；让 Trae 顺手核一下这个数字本身。
- Trae 若在复跑中动了 `scripts/library-acceptance/` 或 `artifacts/` 下的文件，请只做临时反例并在结束后恢复；`artifacts/` 本就不入 Git。
