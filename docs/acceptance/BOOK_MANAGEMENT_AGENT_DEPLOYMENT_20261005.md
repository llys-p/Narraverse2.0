# 管理 Agent 总览与关系：正式部署验收

时间：2026-10-05 19:07（Asia/Tokyo）

版本归档：2026-10-05 19:28 用户授权将本验收对应源码提交并推送到 `codex/platform-model-unification`，不合并 main；下文“未提交/未推送”描述为19:07验收时的历史状态，最终保存结果以Git分支为准。

结论：本次新增能力 **PASS**，已部署正式 `http://127.0.0.1:8080/`。不代表全部项目或其它模式完成全面验收。

## 部署范围

- 源码：`D:\Narraverse2.0-platform-model`，`codex/platform-model-unification`，HEAD `8410f432e089c19142ed45f13a13fb42a79aa62e` 加当前总览/关系任务未提交改动。
- 程序：`D:\Narraverse2.0-8080-release-20261003\denova-src\output\denova.exe`。
- 前端：同正式包 `denova-src\web\dist`；内置 Skill 同包 `denova-src\skills\book-overview-relations\SKILL.md`。
- 数据仍为 `D:\Narraverse2.0\denova-src\.denova`，不迁移、不读取或打印密钥。
- 启动既有 `tools\start_formal_8080.ps1 -NoOpen`；部署前8080无监听，新PID28912。8082/PID29224及18099/PID63168保持不动。
- 旧程序、dist完整备份位于正式包 `book-management-20261005\`。只更新宿主前端，不覆盖叙界资源；旧/新63份叙界资源SHA256一致。初次127份宿主前端文件、exe与Skill逐文件验证无差异；末次页面刷新修正重新构建并同步，首页HTTP200。

## 真实模型闭环

通过正式浏览器的「资料库 → 配置管理 Agent」发送一次用户指令；使用用户已有 `admin` 模型配置，未新增配置或复制凭据。

验收仅在新增虚构书籍 **管理Agent验收-20261005** 内进行，原《水浒传》内容未作任何编辑。当前服务器选择该验收书，用户可从顶栏切回原书；保留虚构数据供体验，不自动删除。

1. 专用工具 `read_book_overview`、`read_lore_relations` 成功读取。
2. `write_book_overview` 创建 `setting/book-overview.md`，正文显示《灯塔双友》、世界概况与核心矛盾；读取API和页面确认已持久化。
3. `write_lore_relations` 保存 `check-lin → check-lu`，label「好友」，note「作者确认的虚构验收关系」。Lore API、条目文件与图谱说明一致。
4. 管理会话恢复页面显示真实4次工具调用和两项成功写入结论；付费模型实际请求 **3次**，不是4次。平台记录总输入80163 token（含重复与缓存）、缓存输入53632、输出454；未估算金额。
5. 正式图谱显示2个条目、1条关系和有向好友标签；不是静态预览夹具。控制台warn/error为空。

## 页面验收补修

发现关系更新事件会把当前管理Agent页切到条目编辑页。关系更新事件新增 `preserve_selection`，SettingPanel刷新资料但保持当前选择，并校验workspace。补回归验证管理Agent不会因该事件卸载；末次前端3文件 **68项通过**、tsc通过、Vite构建通过。补修后未重复付费调用；该具体刷新时序由回归测试验证。

## 门禁与未验证项

- 本轮前置后端book全包、管理Agent/app相关定向、go vet/build已通过；前端4256键i18n通过。此次部署使用同一通过构建。
- skills/workspacechange/agent/app全包中的已知Windows symlink权限失败单列，不能声称全仓测试全绿。
- 本次只做一个写作管理Agent的真实请求；其它管理入口、多轮并发和游戏运行流程未做完整真实模型验收。新能力用于本书长期资料，不自动回写剧情或操作独立设定库。
- 未提交、未推送、未合并main、未发布GitHub Release。用户当前授权的是本地部署和付费验证。

## 证据与回退

源码树 `artifacts\book-management-agent\formal-overview.png`、`formal-graph.png` 为正式页面截图；该目录不提交Git。

回退准备：停止**确认为本次正式8080的PID28912**后，恢复 `book-management-20261005\denova-before.exe` 与 `dist-before`，再启动原启动脚本。回退尚未执行。**新关系数据不要用旧程序交叉编辑**：旧二进制可能忽略新增relations字段，兼容限制见CHANGELOG。回退不删除用户数据。
