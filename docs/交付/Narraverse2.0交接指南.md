# Narraverse2.0 当前交接指南

> 本文件是 `llys-p/Narraverse2.0` 当前交付快照的权威接手入口。旧的 Module4 阶段归档只用于了解历史，不用于判断当前 Git、分支、构建产物或发布状态。

## 1. 当前交付身份

- 仓库：`llys-p/Narraverse2.0`
- 可见分支：`main`
- 仓库权限：私有；其他 AI 或电脑必须先获得 GitHub 读取权限
- 导入基线：原 `feature/module-four @ 3c629ed8eafa017c1c63617b9f883d65934bf8d1`
- 首次快照提交：`6ba260b43985f74bf152b2bf9157074b100a40dc`
- 交付类型：源码快照，可重复构建；不提供预编译包

如果本文件与 GitHub 或当前源码不一致，以 `git`、GitHub 和当前文件为准，不要依赖旧聊天记录。

## 2. 新 AI 接手顺序

在开始修改前依次读取：

1. 本文件和 `README.md`。
2. `DESIGN.md`、`代码指南.md`、`CODE_GUIDE.md`、`平台模块功能总览.md`。
3. `docs/交付/Narraverse2.0交付清单.md`。
4. `项目协作日志.md`、`COLLABORATION_LOG.md`。
5. 与当前任务相关的 `docs/module4/`、源码和测试。

然后执行：

```powershell
git status --short --branch
git log -5 --oneline
git remote -v
```

任何修改前先确认工作树状态；不要把生成目录、浏览器 localStorage 或运行数据当成源码。

## 3. 四个用户模块

| 模块 | 名称 | 主要位置 | 说明 |
| --- | --- | --- | --- |
| 1 | 写作模式 | Denova 顶层入口、`app/` 旧写作能力 | 长篇写作和资料工作流 |
| 2 | 游戏模式 | Denova 顶层入口、现有游戏流程 | 结构化互动游戏 |
| 3 | 叙界 Narraverse | `app/`、Denova Narraverse 宿主 | 对话式文字冒险 |
| 4 | 开放沙盒 | `app/module4/`、Denova 同级入口 | 独立世界、日程、行动和事实循环 |

模块四与模块三共享必要的宿主嵌入、角色资料入口和模型 transport，但不复制 Module3 Adventure/Game Engine。模块四运行时数据使用自己的 localStorage namespace，不写回旧 Adventure 或角色原件。

## 4. 运行方式与端口

先区分端口：它们不是同一个服务，也不能用一个端口的页面代替另一个端口的验收。

| 端口 | 服务 | 用途 | 是否有 Denova Go 后端 |
| --- | --- | --- | --- |
| `5174` | 根目录 `app/` 的 Python 静态服务器 | 独立检查 Narraverse / Module4 UI | 否 |
| `5173` | Denova Vite dev server | Denova 开发前端；通常与 `8080` 后端配合 | 由 `8080` 提供 |
| `8080` | Denova Go backend | 正式 executable 默认入口；生产包通常由它托管内嵌前端 | 是 |
| `8097` | 可选本地 Denova bridge | 旧工具或启动脚本使用的本地桥接服务，不是用户入口 | 否 |
| `8098` | 可选 Pixiv bridge | 仅存在本地 Pixiv 配置时启动，不是用户入口 | 否 |

正式 Denova 如果端口被占用，程序可能自动选择后续可用端口。以启动窗口打印的最终 URL 为准，不要固守 `8080`；浏览器中的 `localhost` 与 `127.0.0.1` 也会被浏览器视为不同 origin，localStorage 不互通。

### 4.1 5174 静态开发/检查模式

5174 是根目录 `app/` 的静态前端检查入口，不是正式 Denova 服务，也不包含 Go 后端。

```powershell
python tools/gen_local_library_v2.py
python -m http.server 5174 --directory app
```

浏览器打开：

```text
http://127.0.0.1:5174/?mode=narraverse
```

这个模式适合检查 Narraverse、Module4 UI 和浏览器端 localStorage。要验证完整 Denova、`/api/status` 或正式共享设置，应使用下面的正式流程。

### 4.2 Denova 开发模式（需要时使用）

如果需要同时调试 Denova React 前端和 Go 后端，在 Git Bash 中执行：

```bash
cd denova-src
./scripts/bootstrap.sh all
```

默认前端为 `http://127.0.0.1:5173/`，后端为 `http://127.0.0.1:8080/`。也可以只启动一侧：

```bash
./scripts/bootstrap.sh be
./scripts/bootstrap.sh fe --backend-port 8080
```

开发模式使用 `go run`，脚本可能执行 `go mod tidy`；它只适合开发调试。正式交付验证使用下一节的 `setup_narraverse2.ps1`，不需要手动启动 5173/8080 两套服务。

### 4.3 正式 Denova 源码构建模式

在仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\setup_narraverse2.ps1
```

脚本会依次：

1. 检查 Python、Node.js、pnpm、Go 和 Git Bash。
2. 生成 `app/local_library.js`。
3. 同步 `app/` 到 `denova-src/web/public/narraverse/`。
4. 在 `denova-src/web/` 安装锁定依赖并构建前端。
5. 调用现有 `denova-src/scripts/build.sh` 构建 Denova executable。
6. 启动 `denova-src/output/denova(.exe)` 并打开页面。

不自动打开浏览器时：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\setup_narraverse2.ps1 -NoOpen
```

也可以双击根目录 `Launch-Narraverse.cmd`。脚本只在当前进程临时使用 Go 路径，不修改系统级 PATH。

启动后优先访问脚本或 executable 输出的地址；默认情况下通常是：

```text
http://127.0.0.1:8080/?mode=narraverse
```

如果 8080 被占用并自动顺延，使用实际打印出来的端口。正式模式的 Module1–4 都在同一个 Denova 页面内，不要再打开旧工程目录中的 `denova/denova.exe`。

### 4.4 另一台 Windows 电脑的首次部署

建议按以下顺序做一次完整部署：

1. 获得私有仓库读取权限，并确认电脑可以访问 GitHub、Go 模块源和 npm/pnpm registry。
2. 安装 Git for Windows、Python 3.10+、Node.js 20+、pnpm 8+ 和 Go 1.26.5+。
3. 将仓库克隆到普通本地目录，例如 `C:\Projects\Narraverse2.0`，不要把旧电脑的 `node_modules`、`.denova` 或构建目录复制过来。
4. 在仓库根目录运行 `tools/setup_narraverse2.ps1`，等待生成、同步、前端安装、Go 构建和 executable 启动全部完成。
5. 打开启动输出的正式 Denova URL，确认 Module1 写作、Module2 游戏、Module3 叙界和 Module4 开放沙盒都存在。
6. 在 Denova 现有共享 Settings 页面填写 endpoint、model、API Key；关闭设置后重新打开确认保存。API Key 每台电脑重新填写。
7. 进入 Module4，创建/打开世界并确认页面可以滚动；需要真实模型时再执行 Preview，不要把 fallback 当成真实调用成功。
8. 关闭正式 Denova 后再次运行入口，确认世界、Preview、Action 和日结状态按当前浏览器 origin 恢复。

部署完成后可以保留源码目录和运行数据；若要重新验证干净交付，另行克隆到新目录，不要在原目录执行 `reset`、`clean` 或删除用户数据。

### 4.5 端口占用与停止方式

- 查看端口占用：`Get-NetTCPConnection -LocalPort 5174,5173,8080,8097,8098 -ErrorAction SilentlyContinue`。
- 先关闭自己启动的 Denova、Vite 和桥接进程；不要结束来源不明的用户进程。
- 5174 静态服务器在其 PowerShell 窗口按 `Ctrl+C` 停止。
- `bootstrap.sh all` 在 Git Bash 按 `Ctrl+C` 停止。
- 正式 executable 关闭其窗口或按 `Ctrl+C`；关闭后再重新运行，避免旧服务继续占用端口。
- 端口冲突时优先使用程序自动选择的最终地址；只有确需固定端口时，才通过现有 `DENOVA_BACKEND_PORT` / `DENOVA_FRONTEND_PORT` 或 `--port` / `--frontend-port` 配置，不能新建 Module4 专属端口配置。

## 5. Module4 入口和最小玩法路径

进入 Denova 后，在顶层模块入口选择“开放沙盒”。进入后可：

```text
创建世界 → 打开世界 → 导入角色 → 生成今日预演 → 移动/行动
→ 相遇或主动寻找 → Judgment（风险行动）→ Facts / dailyLogs → 次日结算
```

Module4 的业务代码位于 `app/module4/`；静态同步后的副本位于 `denova-src/web/public/narraverse/module4/`，后者是生成物，不手工修改。

## 6. 资源生成与源码边界

源码真源主要是：

- `knowledge-base/`：世界观、角色卡和资料
- `app/`：Narraverse 前端与 Module4
- `denova-src/`：Denova 前端、Go 后端和正式构建流程
- `tools/`：生成、同步、启动和测试工具

以下内容由初始化/构建流程生成，不提交 Git，也不从旧电脑复制：

- `app/local_library.js`
- `denova-src/web/public/narraverse/`
- `denova-src/web/dist/`
- `denova-src/output/`
- `node_modules/`
- `.denova/`、`.nova/`、localStorage、运行日志和旧 executable

## 7. 共享 API 设置

API 配置只使用 Denova 现有共享 Settings 页面。Narraverse 和 Module4 的调用路径是：

```text
页面操作 → window.callLLM() → state.apiConfig → 共享模型 endpoint
```

每台电脑、每个新的浏览器/运行 origin 都需要重新填写：

- endpoint
- model
- API Key

示例仅用于说明格式，不是仓库配置：

```text
endpoint: https://api.deepseek.com
model: deepseek-v4-flash
```

API Key 不迁移、不提交、不写入日志、不截图。不要为 Module4 新增独立 API endpoint、key、model 或设置页。

## 8. 常见问题

### 资源同步报 Windows `EPERM`

先停止占用 `denova-src/web/public/narraverse/` 的运行态，再重试同步。不要删除整个快照，不要覆盖源码目录；优先使用新的 staging 目录验证。

### 找不到 Go 或版本过低

需要 Go 1.26.5 或更高版本。可以使用临时 portable 工具链，并通过当前 PowerShell 会话的 `NARRAVERSE_GO` 指定，不要修改系统环境变量或 `go.mod`。

### 5174 有页面但没有 `/api/status`

这是预期行为：5174 是静态前端检查模式。需要 `/api/status`、正式 Denova 宿主和完整 embedded 验证时，使用 `setup_narraverse2.ps1` 构建并启动 executable。

### 看不到世界或 API 配置

先确认浏览器 origin 没有改变。Module4 世界和共享配置保存在浏览器 localStorage，不同端口、域名或浏览器之间不互通；这不是仓库文件丢失。

## 9. 当前交付验收证据

- 干净克隆初始化：通过
- 第二个临时目录重复初始化：通过
- 前端安装与构建：通过
- Go `build ./...`：通过
- 官方 `build.sh`：通过
- Module4 定向测试：10/10 通过
- Module4 源资源与同步资源：21/21 SHA-256 一致
- Module4、`app/app.js`、同步脚本和交付工具语法检查：通过
- 正式 executable 根页面、`/api/status`、Narraverse 和 Module4 资源 smoke：通过
- secret 与机器专属路径扫描：通过
- 真实 shared-model Preview → Action → refresh persistence：已在原正式验收中通过

已知限制：首次构建需要联网下载依赖；Windows 文件锁可能影响静态资源原子替换；Module4 P0 仍使用 localStorage；Denova 前端保留少量与本交付无关的历史 baseline failures。

## 10. 交接原则

- 先验证真实 Git 和当前源码，再判断项目状态。
- 修改前保护用户工作树，不使用 reset、clean、stash、restore 覆盖用户内容。
- 业务改动按模块边界进行，避免把 Module4 逻辑塞入 `app.js`。
- 完成修改后更新 `项目协作日志.md`，记录时间、改动、验证和已知限制。
- 不把本机路径、密钥、localStorage、运行日志或生成物当成交付文件。
