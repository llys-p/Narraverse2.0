# 作品设定库 L3 · B4 段审查交接（B4a / B4b / 跟进关闭 / 验收脚手架）

时间：2026-09-25 12:40。基线：上次复核 `0e46907`+`e570b0e`（B3 D1 修复复审 PASS）。
本交接供审查方复核本段 16 个**本地提交**（未推送、未合并 main）。审查口径与命令见 §2/§3，缺口如实列在 §5。

## 1. 提交清单（自上次复核基线之后）

| 提交 | 类型 | 摘要 | 关键验证 |
| --- | --- | --- | --- |
| `806d6bb` | test | 扫描辅助遇目录遍历/读取错误即失败（复核跟进②） | 代码在 `library_game_integration_test.go`（三处 `walkErr → return walkErr`） |
| `95fa04a` | docs | B3 复审结论（PASS WITH FOLLOW-UPS）与加固入档 | — |
| `368a0ec` | feat | **B4a 后端**：宿主 iframe 库载体 bind/call | app 新增 4 例全过 |
| `582bb2b` | feat | **B4a 前端**：带入叙界入口 + iframe 库交接消费 | 前端新增 6 例；tsc/构建过 |
| `c4b3509` | docs | B4a 入档（含页面验证缺口） | — |
| `8c0dce9` | test | 自动化测试 TempDir 清理 flake 修复（`defer app.Close()` 排空触发 worker） | 修复前 5/30 失败 → 修复后 3×30=0 失败 |
| `7074e7b` | feat | **B4b 后端**：module4 库载体放开（与叙界同一受控边界） | app 新增 2 例（module4 往返 / 跨消费者不串库） |
| `8219f75` | feat | **B4b 前端**：带入开放沙盒入口 + module4 消费 | 前端新增 4 例 |
| `923ae8f` | docs | B4b 入档 | — |
| `aabd9a2` | docs | B3 跟进关闭：修复后 executable 假模型重放 | 证据 `artifacts/b3-exe-replay/` |
| `768f64d` | chore | B5 验收脚手架（fake-model / drive_writing / drive_game / scan_markers / README）+ Runbook | 冒烟 |
| `132f754` | docs | 写作链冒烟记录 | 23 文件 0 泄漏 |
| `5a3e3de` | chore | 一键自检 `run_smoke.py` | 两次全绿 |
| `b685551` | docs | 一键自检日志 | — |
| `ae01885` | fix | 一键自检改读自建库 auto 条目（覆盖成功路径元数据） | 用户独立一轮 + 收紧后复跑 |
| `6eda047` | docs | 可交互体验实例（18088）入档 | — |

## 2. 复核要点（B4a/B4b 的契约边界，与 B3a 同源）

- **wire**：`library_context{libraryId,expectedRevision,manualItemIds}` 严格键；与 `world_context` 互斥（同现 400）；consumer 由受控路由固定；客户端身份字段一律拒绝。
- **服务端派生**：scopeKey=`iframe:<宿主会话>:<frame>:<consumer>`；bind-before-start；绑定期固定 revision + manual 授权校验 + 初始装配计费；失败显式分类（revision_conflict/selection_invalid/budget_exceeded…），不留半绑定。
- **注入与计费**：每次 `/call` 先按写作链同口径量测 iframe 输入计入运行预算，再把装配文本前置为首条消息；模型模块（narraverse/sandbox）与 Settings 不变。
- **只读与脱敏**：库文件全程逐字节不变；`contextSummary` 只含 state/libraryName/revisionLabel/selectedCount；`/call` 请求与 iframe 摘要不含库 ID/revision/scopeKey/运行 ID。
- **生命周期**：换绑（world↔library、库↔库、库→bare）与撤销/过期/关闭均释放且幂等（替换/中止→Cancel，显式解绑→Complete）。
- **前端**：交接只带"已保存库 Ref 三字段+摘要"；未保存草稿禁用；宿主会话非 ready 显式提示不写交接；world/library 按 launchedAt 互斥（败者 pending 在绑定成功后清除）；首个模型请求等待 bind 完成。

## 3. 复核命令（可直接执行）

```bash
# Go 定向（宿主层 10 例）与全包
go test ./internal/app/ -run TestWorldContextHost -count=1 -v
go test ./internal/api/handlers/ -count=1          # 80 例全过
go test ./internal/app/ -count=1 -v                # 250 过 / 1 失败（既有 Windows symlink 环境失败，干净树复跑同败）
go vet ./internal/app ./internal/api/handlers && go build ./cmd/denova
git diff --check e570b0e HEAD

# 前端（受影响 18 文件 88 例）
cd web && npx tsc --noEmit && npx vitest run src/features/narraverse src/features/library-workspace \
  src/features/library-context-runtime src/i18n/i18n.test.ts src/components/workbench/ModeRouter.test.tsx --maxWorkers=2

# 一键自检（假模型，无额度；写作+游戏链+标记直扫）
python denova-src/scripts/library-acceptance/run_smoke.py
```

## 4. 关键证据（`artifacts/`，均不入 Git）

- `artifacts/b3-exe-replay/`：B3 修复后 exe 假模型重放——SSE 全链、模型侧确收库正文、run ledger 659B 工具内容恢复完整元数据且零正文、全通道 0 标记、库文件 sha256 逐字节一致。
- `artifacts/flake-automation-tempdir/`：flake 修复前 5/30 失败与修复后 90 连跑 0 失败；含"首次基线取样因构建失败作废、重做后基线 7/30"的记录。
- `artifacts/b5-harness-smoke/`、`artifacts/b5-writing-smoke/`、`artifacts/library-acceptance-smoke/run-20260925T120315`（**用户独立执行**的一轮：写作 200、游戏 200、49 文件 0 泄漏、grounding True、库文件一致）。

## 5. 已知缺口与边界（如实列出）

1. **B4a/B4b 正式页面验证未做**：叙界模块资产（`web/public/narraverse`）不在工作树，需 `NARRAVERSE_SOURCE_DIR` 经 `scripts/sync-narraverse-assets.mjs` 同步后才能驱动页面；runbook §4 已写明口径。
2. **B5 四模式真实模型轮次未做**：runbook 与脚手架就绪；写作/游戏已用假模型一键跑通（非真实模型口径）。
3. 分支未推送、未合并 main（main 有 Laya 工作）；本段全部为本地提交。
4. 体验实例当前运行在 18088（隔离数据目录，预置虚构资料），待用户玩过反馈后停止。
5. 范围外观察：`demos/laya-live/_probe_llm.mjs` 硬编码密钥（Laya 团队提交 `cd530ec`），建议其轮换。
6. 用户已决定**暂不做**"每回合使用了哪些条目"的可见性面板，等真实体验反馈再定。

## 6. 建议结论口径

- 可复核后放行的件：B4a/B4b 接线（代码/测试/边界/证据齐备）；扫描加固；flake 修复；B3 跟进关闭。
- 不阻塞复审、待外部条件的件：B4a/B4b 页面验证（资产）、B5 真实模型轮次（额度）。
- 需审查方重点抽查：宿主 bind/call 的隔离与释放路径（`world_context_host.go`）、前端互斥与等待绑定（`NarraverseWorkspace.tsx` + 新增 Provider）、一键自检脚本的扫描判据（`scan_markers.py`）。
