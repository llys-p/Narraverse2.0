# 作品设定库 L3 收口验收报告（2026-09-25 轮次）

时间：2026-09-25 14:52。**结论：BLOCKED（L3 不允许关闭）**——两个硬前置（叙界/沙盒页面资产、真实模型凭据）都位于本工作树之外，本代理的会话策略层**拒绝一切工作树外访问**（含只读列举），无法同步资产、无法读取既有凭据；按本轮任务规定"明确记为阻塞，不能用假模型结果替代四模式真实模型 PASS"。

## 1. 环境与基线（已核对）

- 工作树 `D:\Narraverse2.0-b2a`，分支 `library-b2a`，HEAD `5518e18`（本地），工作树干净（仅未跟踪 `artifacts/`）；远端 `origin/library-b2a` 已存在（首次推送由用户执行），可能落后本地 1 个文档提交。
- 已重读并核对：根 `AGENTS.md`、`denova-src/AGENTS.md`、`项目协作日志.md`（顶部条目）、`LIBRARY_L3_B4_HANDOFF.md`、`LIBRARY_L3_B5_RUNBOOK.md`、`LIBRARY_EVOLUTION_TASK_CHECKLIST.md`。
- 数据目录解析（用于定位既有凭据）：`config.Load` → `config.toml`（CWD/可执行文件旁）→ `denova_dir`/`nova_dir`（默认 `./.denova`）——即**用户真实凭据在其自身运行目录**（本工作树之外）。

## 2. 本轮实际执行并通过的验证

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 基线核对（HEAD/工作树/文档） | PASS | §1 |
| 假模型一键 smoke 复跑（fail-closed 仍有效） | **PASS，exit 0** | `artifacts/l3-closeout-smoke-rerun.txt`；本轮运行目录 `artifacts/library-acceptance-smoke/run-20260925T145201`：分链取材 `{writing: True, game: True}`、游戏 ledger 元数据化读取 `True`、库文件逐字节一致、`failures: none` |

## 3. 逐模式验收状态

| 模式 | 要求在轮内的内容 | 状态 | 阻塞原因 |
| --- | --- | --- | --- |
| 写作 | 真实模型最小轮：实际取材于获授权库资料 | **BLOCKED** | 真实模型凭据不可得（见 §4.2） |
| 游戏 | 同上（含工具按需读取、regenerate/切分支既有证据复核） | **BLOCKED** | 同上 |
| 叙界（Module 3 in iframe） | 真实页面操作「带入叙界」：绑定先于首次模型调用、不串库、切换/撤销释放、iframe 只收脱敏摘要 + 真实模型取材 | **BLOCKED** | ① 页面资产不可得（§4.1）；② 凭据不可得 |
| 开放沙盒（Module4） | 真实页面操作「带入开放沙盒」，同上 + 动作成败与背景读取状态独立 | **BLOCKED** | 同上 |

**不得以假模型结果替代"四模式真实模型 PASS"**（任务明示）；本轮的假模型 smoke 仅作 fail-closed 回归证据，不计入终验。

## 4. 阻塞项与解除路径（需用户操作）

### 4.1 叙界/沙盒页面资产不可得（策略层拒绝工作树外访问）

- 实测：对工作树外路径（含 `D:\` 根列举与主工作区具体路径）的读取请求被会话策略层**直接拒绝**，理由为"不触碰主工作树"的持久约束优先；本代理无法做只读复制，也就**无法记录资产来源/版本/哈希**（任务要求：无法安全确定版本即记阻塞）。
- 解除（二选一）：
  **A. 你复制（推荐）**——把叙界 app 资产（含 `index.html`、`app.js`、`game_engine.js`、`module4/` 等）复制到隔离目录并记录版本哈希：
  ```powershell
  $src = "<叙界 app 目录，或已同步的 web/public/narraverse 目录>"
  $dst = "D:\Narraverse2.0-b2a\artifacts\narraverse-assets"
  robocopy $src $dst /E /COPY:DAT /R:0 /W:0
  Get-ChildItem $dst -Recurse -File | ForEach-Object { "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash, $_.FullName.Substring($dst.Length) } | Set-Content "$dst\SHA256SUMS.txt"
  # 若来源是 git 仓库，另记录：git -C $src rev-parse HEAD
  ```
  完成后告诉我来源路径与（若有）提交号，我把资产同步进 `web/public/narraverse` 并构建页面。
  **B. 授权我读指定路径**——明确说明"允许只读复制主工作区的 <具体路径> 到 b2a 的 artifacts 下"，我再试（策略层可能仍拒绝，届时仍需 A）。

### 4.2 真实模型凭据不可得

- 既有凭据在用户自身运行目录（`config.toml`/数据目录），位于本工作树之外 → 本代理不能读取（也不打印）。
- 解除（二选一，均不经过本代理的手）：
  **A. B3c 先例**——我把隔离实例起好并把 URL 给你，你在实例「设置」里填入模型接口（只存该隔离数据目录；密钥不进对话、不进证据、不进 Git）；
  **B. 你预置配置**——你在 `artifacts/l3-closeout-run/`（我会先建目录）放一份仅含模型接口的 `config.toml`，实例启动时自动读取（我不查看其内容）。

## 5. 未验证项（本轮，如实列出）

- 四模式真实模型取材、旧 Lore 不叠加、错误/降级不伪装——**未验证（凭据阻塞）**。
- 叙界/沙盒真实页面：绑定先于首调、两消费者不串库、切换/撤销释放、iframe 摘要脱敏——**未验证（资产阻塞）**（其代码级证据见 B4 段交接与独立复核 PASS，不等价于页面验收）。
- 会话/存档/ledger/日志无库正文的**真实模型轮**落盘扫描——未做（其假模型链扫描已 PASS：见 §2 与 `artifacts/harness-review-fixes/`）。
- 不绕开宿主 bootstrap 的页面验收——未做（资产阻塞；拒绝以 API 直调冒充）。

## 6. 结论

- **L3 不允许关闭**：B4a/B4b 页面验收与 B5 四模式真实模型终验均为 BLOCKED。
- 两处阻塞的解除动作都在用户侧（§4.1-A + §4.2-A 最省事）；解除后本代理可在**一轮内**完成：资产同步+哈希留档 → 隔离实例（独立数据目录/虚构资料/独立端口）→ 页面操作两消费者（宿主 bootstrap 真实流程）→ 四模式真实模型最小调用轮 → 落盘扫描 → 终验报告。
- 本轮未改任何代码；仅新增本报告与清单/日志记录（提交见协作日志）。
