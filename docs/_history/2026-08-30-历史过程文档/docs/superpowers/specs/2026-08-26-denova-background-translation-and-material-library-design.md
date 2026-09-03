# Denova 后台翻译队列与资料加载库设计

日期：2026-08-26  
状态：本文第 1–15 节已实施并部署（2026-08-27 01:45 更新批量写回策略）；第 16 节是 2026-08-28 已批准但未实施的总库衔接修订  
范围：Denova 当前工程的资料库、本地 HY-MT 翻译、叙界知识库与外部素材导入

## 1. 目标

本设计交付两个互相关联但职责独立的能力：

1. 把现有资料库单条同步翻译升级为持久化后台队列，支持单条与当前工程批量任务、名称中文化、安全自动写回、单条正文待确认和失败/冲突恢复。
2. 在 Denova 资料库增加类似叙界的“加载资料”入口，既能浏览叙界知识库，也能多选上传外部角色卡与设定书，并通过同一条完整、可追溯的导入管线写入当前工程。

翻译与游戏严格分开：进入游戏模式后翻译队列暂停，离开游戏模式后恢复。游戏期间可以继续排队，但不执行翻译，不与游戏模型争抢 Ollama 资源。

## 2. 已锁定决策

- 后台翻译支持：单条加入队列，以及扫描当前工程全部英文资料批量加入队列。
- 名称使用独立“中文化/音译”模式，不受普通翻译的 8 个拉丁字母阈值限制；已经主要为中文的名称跳过。
- 新导入的英文素材只自动翻译名称与简介；正文不自动排队。
- 名称与简介翻译完成后，在修订与原文哈希均未变化时自动保存。
- 单条翻译的正文只生成待确认译文；用户明确发起的批量翻译正文在原文与 revision 未变化时自动写回，冲突时不得覆盖。
- 翻译和游戏不同时执行：进入游戏模式暂停，离开游戏模式恢复；正在运行的字段在字段边界结束后暂停，不强杀 Ollama。游戏界面可以先打开，但第一条游戏模型请求必须等翻译队列进入 idle/paused，确保两种模型调用不重叠。
- 资料加载同时支持浏览叙界知识库和多文件上传。
- 角色卡复用 Denova 现有酒馆卡解析器；设定书新增正式逐条导入器。
- 预览可以有界，但导入必须读取原件全文；任何缺失、截断、冲突或翻译失败都不能显示为全绿成功。
- 不调用付费翻译 API，不使用或卸载现有 Qwen/Llama，不增加 Agent 自动翻译工具。

## 3. 总体架构

### 3.1 组件边界

1. **8097 翻译任务服务**
   - 负责持久化队列、串行调度、HY-MT 调用、缓存、术语表、结构保护、译文校验、暂停/恢复和结果保存。
   - 不直接修改 Denova 的 `.denova/lore/items.json`。

2. **Denova 全局翻译协调器**
   - 位于不会随资料库或游戏子页面卸载的全局层。
   - 负责提交任务、轮询队列、显示状态、通过 Denova 现有 lore API 安全写回批量任务、保存单条正文待确认状态，以及进入/离开游戏时暂停/恢复队列。

3. **Denova 素材导入服务**
   - Go 后端负责解析和原子写入当前工作区。
   - 角色卡复用现有 `ImportTavernCharacterCard`；设定书新增解析和映射实现。
   - 叙界知识库文件与用户上传文件最终都以同一份素材二进制进入预览/导入接口。

4. **8097 资料目录服务**
   - 只列出并读取允许范围内的叙界知识库原件。
   - 前端只传稳定 `source_id`，不能提交任意绝对路径。

### 3.2 数据流

```text
资料库单条/批量入口 ─┐
资料导入完成 ────────┼→ 8097 持久翻译队列 → HY-MT 串行翻译
                     │                         ↓
进入游戏 → 暂停 ─────┘        名称/简介 → 修订检查 → Denova PATCH 写回
离开游戏 → 恢复                            单条正文 → 待确认结果
                                            批量正文 → 校验后自动写回

叙界知识库目录 → 8097 安全读取原件 ─┐
外部多文件上传 ──────────────────────┼→ Denova 统一预览/导入 → Lore items
                                    └→ 原件归档 + 来源清单
```

## 4. 持久化翻译队列

### 4.1 落盘结构

```text
denova/.denova/narraverse-translation-jobs/
├─ queue.json
└─ jobs/
   └─ <job-id>.json
```

`queue.json` 只保存任务顺序、全局暂停状态、暂停原因和活动任务 ID。每个 job 独立保存，避免长正文结果反复重写整个队列文件。所有文件使用现有原子写入工具。

任务至少包含：

- `schema_version`
- `id`
- `workspace`
- `item_id`
- `item_name`
- `field`：`name | brief_description | content`
- `mode`：`name_zh | faithful_zh`
- `apply_policy`：`auto_apply_metadata | review_content`
- `source_text`
- `source_sha256`
- `base_revision`
- `status`：`queued | running | paused | completed | pending_review | applied | conflict | failed | cancelled`
- `translation`
- `model`
- `cache_version`
- `attempts`
- `error`
- `created_at / updated_at / completed_at`

重启时将遗留的 `running` 恢复为 `queued`。`completed/applied/cancelled` 不重复执行。幂等键为：

```text
workspace + item_id + field + source_sha256 + mode
```

### 4.2 调度规则

- 全局严格串行，一次只调用一个 HY-MT 请求。
- 同一条目按 `name → brief_description → content` 排序。
- 游戏暂停状态下不领取新任务。
- 已开始的 Ollama 请求不强杀；完成当前字段后进入暂停。
- 游戏期间仍可添加任务。
- 用户手动暂停优先于游戏自动恢复；离开游戏不得覆盖用户手动暂停状态。
- 取消只影响尚未运行的任务或下一个字段边界；已完成译文保留到用户明确清理任务。

### 4.3 接口

```text
POST /api/denova/translator/jobs
GET  /api/denova/translator/jobs?workspace=<workspace>
GET  /api/denova/translator/jobs/{id}
POST /api/denova/translator/jobs/{id}/cancel
POST /api/denova/translator/jobs/{id}/retry
POST /api/denova/translator/queue/pause
POST /api/denova/translator/queue/resume
```

`pause` 必须带原因：`manual | game`。恢复 `game` 原因时，如果仍存在 `manual` 暂停则保持暂停。

所有接口继续限制为本机回环调用、限制请求体大小并返回稳定错误码。批量创建返回已创建和因幂等而跳过的任务 ID。

## 5. 翻译模式、缓存与校验

### 5.1 名称中文化

名称字段使用专用提示：把英文或罗马字专名翻译或音译为自然简体中文；有通行中文译名时优先使用；只输出名称本身。该模式显式绕过普通 `needs_translation()` 的 8 字母阈值。

跳过条件：字段为空，或 CJK 字符已经占主要部分。`do_not_translate` 中的名称保持原样。

示例验收：`Alice` 不能再返回 `skipped_fields`，应得到“爱丽丝”或等价自然中文名。

### 5.2 普通忠实翻译

简介和正文继续使用现有 HY-MT 忠实翻译提示，保持“不总结、不净化、不审查、不解释、不续写”。继续保护模板变量、URL、HTML、Markdown、代码块、行内代码和正则。

### 5.3 缓存修复

缓存键必须加入：

- `TRANSLATION_CACHE_VERSION`
- `PROMPT_VERSION`
- `VALIDATOR_VERSION`
- 翻译模式

缓存命中后仍运行当前版本的统一译文校验。校验不通过则删除或隔离该缓存并重新翻译，不能再次依赖手工清空整个缓存目录。

### 5.4 部分失败

- 至少一个字段成功：任务组可显示部分成功，失败字段单独保留原文并显示原因。
- 全部字段失败：不得出现“采用译文”，任务组状态为失败。
- 前端必须展示 `failed_fields`，不能把失败误标为“无需翻译”。

## 6. 自动写回与冲突

名称和简介自动写回前，全局协调器重新读取最新 LoreItem，并验证：

1. 条目仍存在。
2. 当前字段 SHA-256 等于任务的 `source_sha256`。
3. 当前修订未发生不可安全合并的变化。

满足条件后，通过现有 `PATCH /api/lore/items/{id}` 携带 `base_revision` 保存。不得直接写 `items.json`。

以下情况进入 `conflict`：

- 字段在翻译期间被用户或 Agent 修改。
- 条目被删除。
- 名称中文化后与同类型现有资料重名。
- Denova revision conflict 无法自动重放。

冲突只允许重新翻译、放弃或由用户手工复制译文，不自动改名、不覆盖。

正文结果始终为 `pending_review`。用户在任务抽屉查看原文/译文后点击采用，才按相同哈希与修订规则写回。

## 7. 翻译界面

### 7.1 资料库入口

- 单条“译为中文”：选择名称、简介、正文后加入队列，立即关闭弹窗也不影响执行。
- “批量翻译”：扫描当前工程英文资料，支持仅名称＋简介、仅正文、全部三种选择；提交前显示预计条目数和字段数。
- 新导入素材自动为英文名称与简介建队，正文不自动建队。

只有被勾选且非空的字段允许提交。

### 7.2 全局状态入口

Denova 顶栏显示紧凑状态，例如“翻译 3/128”或“翻译已因游戏暂停”。点击打开任务抽屉。入口属于全局外壳，不随资料库页面卸载。

任务抽屉展示：

- 等待、运行、暂停、完成、待确认、冲突和失败数量。
- 当前条目与字段。
- 手动暂停/恢复、取消未开始任务、失败重试。
- 正文原文/译文对照与采用按钮。
- 冲突原因和重建任务入口。

旧的单条同步弹窗改为“选择字段并加入队列”，不得再自行持有长请求。使用任务 ID 和请求序号防止旧响应覆盖新响应；卸载时只停止轮询，不取消后台任务。

## 8. 游戏隔离

进入 Denova 游戏模式时，全局协调器发送 `pause(reason=game)`。队列完成当前字段后停止。游戏界面可以立即显示，但发送第一条游戏模型请求前必须等待队列确认进入 `idle/paused`；等待期间显示“正在停止本地翻译”。这样既不强杀正在写缓存的 Ollama 请求，也不会让翻译模型与游戏模型同时运行。游戏期间不执行 HY-MT，但可以继续排队。

离开游戏模式时发送 `resume(reason=game)`。若用户此前手动暂停，队列仍保持暂停。

验收必须覆盖：

- 从资料库切入游戏时停止领取新任务。
- 第一条游戏模型请求必须等当前翻译字段结束，不能与 HY-MT 重叠。
- 游戏期间任务数量可增加但进度不前进。
- 离开游戏后从未完成字段继续。
- 不修改普通 Denova 工程的导演、故事策略或游戏状态。

## 9. 资料加载库

### 9.1 界面

资料库顶部增加“加载资料”，弹窗包含：

1. **叙界知识库**：角色卡/设定书分类、搜索、NSFW 显示开关、多选、来源与条目数预览。
2. **上传文件**：多选 PNG/JSON 角色卡和 JSON 设定书。

两种来源进入同一个预览表，统一显示类型、名称、条目数、预计 resident 大小、截断/格式警告、重复项和将自动翻译的名称/简介数量。

### 9.2 目录接口安全

```text
GET /api/denova/material-library
GET /api/denova/material-library/{source-id}
```

目录服务只扫描项目配置的知识库根目录。`source-id` 由相对路径和源文件哈希稳定生成；读取接口通过服务端索引反查路径，不接受 `../`、绝对路径或任意文件名。

目录响应只返回预览元数据与 `source_ref v1`。请求原件时返回完整文件二进制和 SHA-256。

### 9.3 Denova 导入接口

```text
POST /api/workspace/import-material/preview
POST /api/workspace/import-material
```

接口按单份素材工作。前端批量导入时逐份提交，以“每份素材独立原子提交”为边界。一份失败不回滚其他已成功素材，但最终报告保留失败。

叙界知识库来源由前端先通过 8097 获取原件，再以和上传文件相同的 multipart 请求提交给 Denova，确保解析和导入逻辑只有一套。

## 10. 素材解析与映射

### 10.1 角色卡

- 继续支持 PNG `ccv3/chara` 元数据和 JSON V2/V3。
- 复用现有预览、兼容报告、角色卡导入、开场预设和封面处理。
- 保留 description、personality、scenario、first_mes、alternate_greetings、mes_example、creator_notes、system_prompt、post_history_instructions、depth prompt 和可识别扩展。
- 内嵌世界书逐 entry 导入。
- 返回创建、更新、冲突和失败的 LoreItem ID，供翻译队列只处理实际成功条目。

### 10.2 设定书

- 支持叙界/SillyTavern 常见 JSON 世界书结构及当前知识库包装格式。
- 一条源 entry 对应一条 Denova LoreItem，不整本压缩为单条。
- 不设 200/500 条上限。
- `key/keysecondary` 映射 keywords，comment/name 映射名称与简介，content 全文保留。
- 源条目禁用状态映射 `enabled=false`。
- 普通人物与世界知识默认 `auto`；脚本、正则、作者约束默认 `manual`；不把整本书设为 resident。

### 10.3 原件与来源

原件保存到：

```text
<workspace>/.narraverse/source/imported-materials/
```

清单保存到：

```text
<workspace>/.narraverse/material-import-manifest.json
```

清单记录原文件名、来源类型、相对路径、稳定来源 ID、SHA-256、字节数、导入时间、源条目数、目标 ID、字段路由、截断、冲突和自动翻译任务 ID。

稳定资料 ID 使用：

```text
source_id + source_entry_id + semantic_group
```

重复导入只更新仍与上次受管哈希一致的条目。用户手工修改过的条目保留现有内容并产生冲突记录，不静默覆盖。

## 11. 错误与恢复

- 8097、Ollama或模型不可用：任务保留 queued/failed，可重试，不修改资料。
- 磁盘不足：预览或预检阶段阻止导入；已经存在的工程文件不变。
- 素材含截断标记：预览明确警告；只能选择原件、明确接受不完整导入或跳过，不能显示完整成功。
- 翻译失败：名称/简介保持原文，正文无写回，错误进入任务报告。
- 队列或导入清单损坏：保留损坏文件副本并停止自动处理，不猜测修复。
- 原子提交失败：回滚该份素材涉及的 lore、原件和清单更新。

## 12. 预计代码范围

### Python

- `tools/denova_full_export.py`
- `tools/denova_bridge.py`
- `tools/translation_glossary.json`
- `.workbuddy/tmp/test_denova_full_export.py`

### Denova Go

- 新增 `internal/book/lorebook_import.go`
- 新增 `internal/book/lorebook_import_test.go`
- 扩展素材导入 handler、route、请求/响应类型和测试
- 扩展角色卡导入结果，使其返回创建、更新和冲突的资料 ID

### Denova Web

- 新增全局翻译队列状态与协调器
- 新增翻译任务抽屉
- 改造单条翻译弹窗为入队入口
- 新增批量翻译入口
- 新增资料加载库弹窗
- 增加 API 类型、i18n 和定向 Vitest
- 在游戏模式进入/退出的稳定边界发送队列暂停/恢复

### 文档与部署

- 更新 `CODE_GUIDE.md`
- 每次代码修改更新 `COLLABORATION_LOG.md`
- 只修改 `denova-src` 源码；测试通过后构建，再原子同步到 `denova/web`

## 13. 测试与验收

### Python

- 任务幂等、串行、暂停/恢复、取消、重试和重启恢复。
- 游戏暂停原因与手动暂停原因互不覆盖。
- 名称短文本强制中文化，中文名跳过。
- 缓存键包含提示词/校验器版本，旧缓存不复用，缓存命中重新校验。
- 全字段失败、部分失败、拒绝、提示回显、异常重复正确分类。
- NSFW、`{{char}}`、`{{user}}`、URL、Markdown、代码块和正则不损坏。
- 资料目录禁止路径穿越，source ID 与 SHA-256 稳定。

### Go

- PNG/JSON V2/V3 角色卡完整导入并返回目标 ID。
- 设定书逐条导入，超过 500 条仍完整。
- 禁用状态、keywords、简介、加载策略和内嵌世界书正确。
- 重复导入 ID 稳定，未修改条目可更新，手工修改触发冲突。
- 长卡、截断标记、坏 JSON、磁盘/原子提交失败正确处理。

### Web

- 单条和批量任务正确入队，只有选中且非空字段提交。
- 页面切换不取消后台任务，旧请求不覆盖新请求。
- 批量任务全部字段在修订匹配时自动保存；单条正文只进入待确认。
- `failed_fields` 可见；全部失败没有采用按钮。
- 游戏进入暂停、离开恢复；手动暂停不会被游戏退出误恢复。
- 知识库浏览、多选、上传、预览、逐份导入和最终报告正确。

### 完整回归

- Python现有全量导出与翻译测试。
- Denova定向Go测试。
- Denova定向Vitest、i18n检查、TypeScript和生产构建。
- 叙界导出、未来同步、分支、加载库和启动器回归。
- 人工抽检一张长V3英文角色卡、一本超过200条的设定书、短英文名称、部分失败任务、游戏暂停续跑、批量正文自动写回和单条正文待确认写回。

## 14. 非目标

- 不在游戏模式运行翻译。
- 不让 Agent 自动翻译或自动写资料。
- 不把导入的全部资料设为 resident，也不在每轮全部注入上下文。
- 不自动翻译新导入素材的正文。
- 不直接编辑 `denova/web` 构建产物。
- 不自动覆盖手工修改或无法验证来源完整性的内容。
- 不批量迁移所有 Denova 工程，只处理当前工程和用户本次选择的素材。

## 15. 完成标准

只有以下条件同时满足，功能才可显示完成：

- 名称中文化、批量安全自动写回和单条正文待确认均按规则运行。
- 游戏期间翻译任务不执行。
- 队列和结果可跨页面、刷新及8097重启恢复。
- 角色卡和设定书均可从叙界知识库与外部多文件导入。
- 原件、哈希、来源、字段路由和目标 ID 可追溯。
- 截断数为0；任何缺失、冲突或失败均明确显示，不能全绿。
- 所有定向测试、构建和现有回归通过后，运行版静态资源与构建产物哈希一致。

## 16. 2026-08-28 总资料库流水线衔接修订（已批准，未实施）

现行总库规格见 `2026-08-28-叙界总资料库与导入翻译流水线设计.md`。本节不改写第 1–15 节所记录的已部署事实，只明确下一阶段如何复用现有实现。

### 16.1 CURRENT：当前已部署行为

- 素材导入目标是当前 workspace 的 Denova LoreItem。
- 角色卡在导入时直接投影为 LoreItem/开场预设；世界书逐 entry 导入。
- 原件和 `material-import-manifest.json` 保存在当前 workspace。
- 新导入素材只自动排队名称和简介；正文默认不自动翻译。
- 翻译任务以 workspace、LoreItem 和 `name | brief_description | content` 为主要目标，结果服务于当前 workspace 的安全写回或待确认。

以上能力继续保留为可复用底座，但不能视为叙界总资料库已经建成。

### 16.2 PLANNED：总库衔接后的目标行为

- 普通入口默认使用 `master_managed`：原文件先进入总库，解析为结构化 CharacterTemplate/LoreEntry，生成字段级 translation versions，通过校验后再创建冒险 instance。
- 高级入口才允许 `unmanaged_direct`：只进入当前冒险，明确不受管、不更新总库、不跨冒险复用，之后可主动提升到总库。
- 当前翻译队列继续负责持久化、串行、缓存、游戏暂停、重试和冲突保护；任务目标扩展为 `source_id + master_item_id + source revision + field_path`。
- `job_id` 继续表示一次队列执行；只有持久化成功的译文/润色结果才生成独立 `translation_version_id`。
- HY-MT 初译范围扩展到全部安全自然语言字段；`system_prompt`、`post_history_instructions`、脚本、正则和行为控制提示等高风险字段必须人工确认后才能激活。
- Denova Agent 只做选择性的字段级校对、纠错和润色，并产出候选版本，不自动覆盖原件、总库 active 版本或冒险实例。
- 现有素材导入器、角色卡解析器和导入弹窗继续复用，但当前 material manifest 和扁平 LoreItem 只是运行时/兼容结构，不是未来总库的规范模型。

### 16.3 迁移边界

- 不批量重写已有冒险；旧冒险按现状继续运行。
- 总库新版只提示用户，不静默覆盖冒险实例。
- Base/Local/Remote 字段级合并放到第二阶段；MVP 先做显式替换和可恢复快照。
- 本节仅修订设计目标；截至 2026-08-28，尚未创建总库 schema、四级 ID、translation version 持久层或 Master→Adventure 实例链。
