# Narraverse2.0 交付清单

## 交付基线

- 来源：当前 `feature/module-four` 干净源码快照
- 来源提交：`3c629ed8eafa017c1c63617b9f883d65934bf8d1`
- 目标仓库：`llys-p/Narraverse2.0`（私有）
- 当前目标分支：`main`
- 当前快照提交：`6ba260b43985f74bf152b2bf9157074b100a40dc`
- 交付形式：可重复构建的源码，不提供预编译 Windows 包

## 已交付

- 根目录 Narraverse 前端与 `app/module4/`
- `denova-src/` Denova 前端与 Go 后端源码
- `knowledge-base/` 世界观设定和角色资料
- `tools/` 生成、同步、测试和 Windows 初始化入口
- Module1–4 对应说明、架构文档、代码指南、协作日志和阶段归档
- `package.json`、`pnpm-lock.yaml`、`denova-src/go.mod`、`denova-src/go.sum`
- `Launch-Narraverse.cmd`
- `tools/setup_narraverse2.ps1`
- `docs/交付/Narraverse2.0交接指南.md`
- `docs/交付/AI协作决策原则.md`

## 初始化与运行链

1. 检查 Python、Node.js 20+、pnpm、Go 1.26.5+ 和 Git Bash。
2. 运行 `tools/gen_local_library_v2.py`。
3. 运行 `denova-src/scripts/sync-narraverse-assets.mjs app`。
4. 在 `denova-src/web` 安装锁定依赖并构建前端。
5. 运行既有 `denova-src/scripts/build.sh` 构建 Denova executable。
6. 通过 `tools/start_narraverse.ps1` 启动生成的 executable 并打开本机页面。

Windows 交付入口会优先使用 Git for Windows 的 Git Bash，并在当前进程中临时加入 Go `bin`；不会修改系统 PATH。构建脚本兼容 Git Bash 下的 `pnpm.cmd` 命令名，且交付快照使用 LF 行尾以避免 shell 读取 CRLF 失败。

## 配置位置

模型配置使用 Denova 现有共享 Settings 页面。每台电脑都要重新填写 API key；API key 不随仓库迁移，也不写入文档、日志或构建产物。endpoint/model 只作为非敏感示例：OpenAI-compatible HTTPS endpoint 与 `deepseek-v4-flash`。

## 明确排除

- `node_modules/`
- `app/local_library.js`
- `denova-src/web/public/narraverse/`
- `denova-src/web/dist/`
- `denova-src/output/`
- `.denova/`、`.nova/`、localStorage、运行日志
- 旧 executable、个人配置、API key 和本机运行数据

上述生成物在新电脑上由初始化脚本和现有构建流程产生，不作为源码真源提交。

## 验收清单（当前快照验证结果）

- [x] 干净克隆后初始化脚本完成
- [x] 前端构建完成
- [x] Go 构建完成
- [x] Module4 源资源与同步资源文件列表及 SHA-256 一致
- [x] Module4 定向测试、JavaScript 语法检查和 `app/app.js` 检查通过
- [x] Denova executable 可启动，根页面、`/api/status`、Narraverse 页面可访问
- [x] Module1 写作、Module2 游戏、Module3 叙界、Module4 开放沙盒入口存在
- [x] Module4 世界列表、创建、打开和页面滚动可用
- [x] Module3 保护性 smoke 通过
- [x] 第二个临时目录可重复执行初始化
- [x] 仓库未包含 secret 或机器专属路径

## 已知限制

- 新电脑需要预先安装符合版本要求的工具链并联网下载依赖；本版本不含预编译 executable。
- Windows 文件锁可能影响静态资源同步的原子替换；应在干净 staging 或停止占用资源的运行态重试，不能覆盖源码工作树。
- Module4 运行时使用 localStorage；大量 Facts / dailyLogs 的长期容量治理留待后续阶段。
