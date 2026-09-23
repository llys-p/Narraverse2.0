# 作品设定库 L1 收口与 L2 验收

时间：2026-09-23 14:57。结论：**PASS WITH FOLLOW-UPS**。L1 补缺与 L2 只读加载/预览完成；外壳环境告警单列，不构成 L2 读写边界缺陷。未实施 L3/L4，未提交或部署到用户 8080。

## 1. 验收对象和环境

- 源码：`D:\Narraverse2.0`，main / `3f226e1d75c47caef2d0752fc8cfd4fd2e0710e5` **加当前未提交 L1/L2 diff**，不是仅验收该历史提交。
- Windows；Node v24.14.0；Go go1.27.0 windows/amd64；Vite 8.0.13；Vitest 4.1.6。
- 用户明确批准在 18082 启动隔离验收实例；未停止、替换或修改已有 8080 服务。
- 正式 executable：`artifacts/library-l2/denova-acceptance.exe`，SHA256 `8034ce636516290b3deb93447d23481c7d1467c94b4f1dae70f8de71befb484a`。
- 同源静态资源：`DENOVA_WEB_DIR=artifacts/library-l2/web-final`；index.html SHA256 `895e19dd1157c347b97487bd7ed336cd576c3596b82383e23435ff0def509dcb`。不是 Vite dev 验收。
- URL：`http://127.0.0.1:18082/?mode=library`，验收后已停服。
- 数据与证据：`artifacts/library-l2/run-1790146195886/`，全部虚构；`result.json`、深浅色/窄屏截图、隔离日志保留，不提交。脚本 `artifacts/library-l2/acceptance.cjs` 使用已安装 Playwright 与独立 Edge，不安装依赖、不使用用户浏览器资料。
- 子进程清除继承的模型密钥等敏感环境变量；L2 不调用模型，无需 API Key。

## 2. 已修复问题

| 问题 | 修复与证据 |
| --- | --- |
| 部分更新省略 origin，把 reference 错改成 adaptation | Store 保留原形态；`origin_update_test.go` 验证只读正文保护及版本不变 |
| 新建条目覆盖未保存正文/名称草稿 | 编辑器复用离开确认；组件测试与真实浏览器取消后正文仍在 |
| 切库或卸载后迟到 load/save 覆盖当前库 | hook 请求代次与归属检查；延迟响应回归测试 |
| 级联删除后事件 updatedAt 留旧值，导致下一次保存伪冲突 | 有 updatedEventIds 时重读服务端库；hook 回归验证权威时间戳 |
| HTTP 更新漏传 baseUpdatedAt 可无条件覆盖 | 请求层拒绝缺失/空白基线（400）；先复现旧实现三种输入均 200，再验证库内容/版本不变 |

最后一项是落实已有 L1 冻结契约，不新增强制覆盖功能；现有表单与加载设置已携带基线。内部 Store 的既有调用约定未扩大改造。

## 3. L2 需求与证据

| 要求 | 当前证据 |
| --- | --- |
| resident 正文、auto 默认目录、manual 显式读取 | `librarycontext` 单测；正式页面默认读2项，选 auto/manual 后读4项 |
| enabled=false 任何路径不可绕过 | 纯核拒绝禁用选择；页面选择和结果均不出现禁用项 |
| ID 去重/稳定分页/数量与预算 | 纯核测试，非法集合整体拒绝；HTTP 超预算 413；实际响应字节数等于 budget.bytes |
| 原创/改编不被来源覆盖，reference 固定版本解析 | 核心来源矩阵；App 集成创建真实临时 Master 文件，解析安全字段、排除 system prompt/Original，库字节与 Master revision 不变 |
| 来源缺失/变化/不可用不回退本地正文 | source_missing/changed/unavailable/unsupported/unverified 测试；无书籍页面明确显示来源不可用 |
| 关系/事件闭包不能扩大读取集合 | 纯核裁剪未读取的参与者/地点和关系；页面显式选择后才出现1条关联 |
| HTTP 严格且脱敏 | 独立 camelCase DTO；未知/大小写错误/重复键/null/尾随JSON拒绝；400/404/409/413/500覆盖；损坏文件不泄露路径 |
| 读取无写入或运行身份 | 8并发 HTTP 预览前后文件一致；调用链仅 GetWorkLibrary → Build → 显式 DTO，无 Registry/Task/模型调用 |
| UI 主动预览、草稿保护和请求竞态 | 组件测试；正式页面打开零请求、点击一次一个 POST；变更选择显示过期；刷新清空预览 |
| 保存与重启 | 正式页面无书籍建库/建条目/编辑保存；重启 executable 后内容和 revision 均一致；预览可重新派生 |
| 视觉与布局 | 深色1440/768/320px预览无横向溢出；浅色1440px实际截图检查；正文使用文本渲染，无来源脚本执行 |

正式浏览器最终 **23 项检查通过**。Master 成功解析/版本变化是磁盘集成及纯核证据，未伪称已在浏览器连接用户真实总库。未读取用户资料做破坏性测试。

## 4. 门禁结果

- `go test ./internal/library ./internal/librarycontext ./internal/api/handlers -count=1`：三个包通过。
- `go test ./internal/app ./internal/api -run 'TestLibrary|TestWorkLibrary' -count=1`：两个包实际命中并通过，**非 app/api 全包或全仓 Go 全过**。
- `go vet ./internal/library ./internal/librarycontext ./internal/app ./internal/api ./internal/api/handlers`：通过。
- `go build -o D:/Narraverse2.0/artifacts/library-l2/denova-acceptance.exe ./cmd/denova`：通过。
- `vitest run --maxWorkers=4`：**207 文件 / 1296 测试通过**，333.75s；资料库定向14文件/44项也通过。
- `tsc --noEmit`：通过；`node scripts/check-i18n-keys.mjs`：**4132** 键 zh/en 对齐。
- `vite build --outDir D:/Narraverse2.0/artifacts/library-l2/web-final`：通过；保留既有大 chunk 警告，不以调高阈值消除提示。
- 任务范围 `git diff --check`：通过；LF/CRLF 提示非空白错误。一次过宽 gofmt 造成的纯换行已对精确文件验证无语义差异后恢复，未还原并行改动。

## 5. 分类与覆盖边界

- **未发现未解决的 L1/L2 P0/P1。**
- P2（外壳，延期）：`--no-open` 不签发一次性宿主 bootstrap，手工打开页面的既有 `/api/world-context/host/status` 返回403；外部更新检查 `/api/update/check` 返回502，外壳可显示“后端未启动”提示，但 `/api/status` 与本轮库操作正常。这些请求在页面启动发生，与只读预览分开记录；没有改 iframe 认证或全局错误处理。
- P3（环境提示）：完整 Vitest 输出 jsdom CSS 解析与 scrollTo 未实现警告，全部断言通过；Go 1.27 下 sonic 有兼容回退提示，未修改依赖/toolchain。未跑无关 Go 全量，不把历史 Windows symlink 失败计为本轮通过。
- 不在本轮：真实模型送模、四模式读取新库、长期运行/重连、旧 World/Lore 迁移、真实用户库兼容迁移。它们属于 L3/L4，不用当前预览 PASS 代替未来验收。

## 6. 收口与后续

L1/L2 功能与本阶段验证可收口；后续可以按 L3 骨架核对并冻结模式适配契约，但没有自动开始 L3 的授权。L4 真实数据 apply 仍须明确选择、备份和确认。

此次使用阶段验收/浏览器/调试技能落实了隔离实例、失败先复现、请求与持久化证据分开记录；未以 mock 结果宣称真实模型成功。

提交时按 `LIBRARY_RUNTIME_IMPLEMENTATION_PLAN.md` 文件组精确暂存，审查共享日志/CHANGELOG 的混合改动；排除 artifacts、exe、dist、用户数据及并行 Module4/Agent/知识库工作。当前未 commit/push，用户8080仍是其原有实例。
