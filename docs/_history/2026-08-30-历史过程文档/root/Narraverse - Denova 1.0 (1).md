# Narraverse / Denova 1.0  
## 项目总览、系统架构与维护说明

**版本：1.0**  
**基线日期：2026-08-30**

---

# 1. 文档定位与阅读指南

本文档是 Narraverse / Denova 1.0 的正式系统说明。

它不是开发日志，也不是需求愿望清单，而是用于说明：

- Narraverse / Denova 目前是什么；
- 1.0 已经实际具备哪些能力；
- 为什么系统采用现在的资料架构；
- Character Card、Lorebook、Master、翻译、Agent 和 Adventure 之间如何协作；
- 用户日常应怎样使用；
- 后续 AI 或开发者接手时，哪些边界不能随意破坏；
- 哪些能力仍然属于技术债、兼容代码或未来计划。

本文档依据当前生产代码核验得到的《Narraverse / Denova 1.0 Implementation Facts》整理。Facts 明确以当前生产源码作为事实基准，并使用 `CURRENT / PARTIAL / LEGACY / NOT IMPLEMENTED` 区分真实能力状态。

## 1.1 信息真值优先级

发生冲突时，优先级为：

```text
当前生产代码
>
Implementation Facts
>
本文档
>
CODE_GUIDE / COLLABORATION_LOG
>
历史设计稿与旧方案
```

其中：

- **代码**负责回答“现在实际上怎么运行”；
- **Facts**负责回答“当前实现状态是什么”；
- **本文档**负责解释“系统为什么这样设计，以及应如何理解和维护”；
- 历史文档仅作为设计背景和导航参考。

## 1.2 状态定义

### CURRENT

当前生产代码中真实存在，并有部署、测试或运行记录。

### PARTIAL

功能已经存在，但仍只覆盖部分场景，或者关键状态仍依赖推导、兼容逻辑或临时协议。

### LEGACY

旧功能仍保留并可能继续工作，但已经不是推荐主流程。

### NOT IMPLEMENTED

曾经讨论、设计或规划过，但当前生产系统并未完成。

---

# 2. Narraverse / Denova 1.0 是什么

Narraverse / Denova 是一个围绕角色卡、世界设定、Lorebook、AI 翻译、资料维护和互动故事建立的本地 AI 资料与运行平台。

它最初可以被理解成：

> 把角色卡和设定加载进 AI 互动故事。

但到 1.0，它已经形成了更明确的系统定位：

> **先把角色、设定和世界知识整理成长期可维护的资料资产，再根据需要将这些资产安全地实例化到不同 Adventure 中运行。**

因此，Narraverse / Denova 不再把“资料”和“故事”视为同一件事。

系统现在明确区分：

```text
原始资料
↓
Master Library
↓
翻译 / 版本 / Agent 维护
↓
可用 Master Asset
↓
Adventure Instance
↓
具体故事运行
```

当前生产系统已经实际包含 Narraverse、Denova、Master Library、8097 Translation、Agent、Adventure 和 Web UI 等主要组成部分。

## 2.1 1.0 的五个核心目标

### 资料能够长期保存

角色卡和 Lorebook 不再只是一次性导入文件。

系统保存：

- 原始来源；
- Source Revision；
- SHA-256；
- Master Asset；
- Master Field；
- Nested Entry；
- Translation Version；
- Adventure Instance；
- 使用关系。

### 英文资料能够自动进入中文资料库

大量英文 Character Card / Lorebook 默认交给 HY-MT / 8097 进行字段级初译。

Agent 不负责无差别重新翻译整份资料。

### AI 可以修资料，但不能任意写资料

Denova Agent 不能直接修改原文件，也不能拥有普通文件系统写权限。

写入必须经过：

```text
Proposal
→ Validate
→ CAS
→ Risk Check
→ Apply
```

### Master 可以被多个 Adventure 重复使用

Master 保存可复用模板。

Adventure 保存具体运行状态。

某个 Adventure 里的成长、关系、伤势、装备变化和剧情记忆不会自动污染 Master。

### 用户不需要成为系统管理员

后台可以存在：

```text
SHA
revision
CAS
task_id
worker
claim
attempts
HTTP error
```

但普通 UI 应优先展示：

```text
翻译中
翻译完成
Denova 正在处理
需要你的确认
```

---

# 3. 为什么这样设计：资料与故事必须分离

这是理解 Narraverse / Denova 最重要的一章。

系统当前不是因为“技术上喜欢分层”才把资料拆开，而是为了避免长期使用以后发生数据污染。

## 3.1 系统存在三种不同的真相

### 原始来源真相

回答：

> 这个角色卡 / Lorebook 原来是什么？

对应：

```text
Source
Source Revision
Original File
```

### Master 当前真相

回答：

> 如果今天新建一个 Adventure，现在应该采用哪个版本的角色或设定？

对应：

```text
Master Asset
Active Field Content
Active Translation Version
```

### Adventure 运行真相

回答：

> 这个具体故事里的角色现在是什么状态？

对应：

```text
Adventure Instance
Adventure Lore
Runtime State
```

这三个真相不能互相替代。

## 3.2 为什么原文件不能直接覆盖

如果翻译、Agent 修正或用户编辑直接改掉原文件：

```text
原始来源消失
↓
无法重新核对
↓
无法判断翻译是不是错了
↓
无法可靠做版本比较
```

因此原文件承担的是**来源证明**。

## 3.3 为什么 Master 不能自动覆盖 Adventure

假设某个 Adventure 中的 Aiko 已经经历：

- 性格成长；
- 关系变化；
- 装备变化；
- 剧情事件；
- 新记忆。

此时 Master Aiko 出现新 revision。

如果系统自动同步：

```text
Master Aiko v2
→ 覆盖 Adventure Aiko
```

就可能破坏已经发生的故事状态。

因此：

> **Master 更新不会静默覆盖已经生成的 Adventure Instance。**

当前实现也明确保留这种隔离。

## 3.4 为什么 Adventure 不能自动回写 Master

Adventure 内容属于具体故事。

例如某个 Adventure 里：

```text
Aiko 与玩家关系 = 恋人
```

另一个 Adventure 中可能完全不存在这段关系。

如果 Adventure 自动反写 Master，就会导致：

```text
一次故事的发展
↓
污染公共角色模板
↓
影响所有未来 Adventure
```

因此：

> **Master 是模板，Adventure 是实例。**

这是 Narraverse / Denova 1.0 最重要的数据边界之一。

---

# 4. 顶层架构与运行组件

## 4.1 系统整体结构

```text
                 原始角色卡 / Lorebook
                         │
                         ▼
               ┌──────────────────┐
               │      Source      │
               │ Source Revision  │
               └────────┬─────────┘
                        │
                        ▼
               ┌──────────────────┐
               │  Master Library  │
               │ Master Asset     │
               │ Field / Entries  │
               └────────┬─────────┘
                        │
              Translation Targets
                        │
                        ▼
               ┌──────────────────┐
               │  HY-MT / 8097    │
               │ Translation Queue│
               └────────┬─────────┘
                        │
                        ▼
               Translation Version
                        │
             ┌──────────┴──────────┐
             ▼                     ▼
      Pipeline / Runtime       Master Agent
             │               Proposal / CAS
             └──────────┬──────────┘
                        ▼
                      usable
                        │
               用户明确“加入冒险”
                        │
                        ▼
               Adventure Instance
                        │
                        ▼
                  Adventure Lore
```

## 4.2 主要组件

### Narraverse

互动故事和冒险侧前端。

### Denova

系统宿主和主要后端服务，同时提供 React/Vite Web 工作台。

### Master Library

保存：

- Source；
- Revision；
- Master Asset；
- Field；
- Nested Entry；
- Translation Version；
- Import Transaction；
- Proposal；
- Recovery Claim；
- Instance Ref。

Master 是资料管理中心，而不是 Adventure 内容的替代品。

### 8097 Translation Service

承担本地翻译任务队列和翻译执行桥。

Master 通过字段级 Translation Target 向其提交任务。

### Ollama

当前 Master Agent 使用本地 OpenAI-Compatible Ollama 服务。

当前已核验：

```text
profile: qwen25-local
model: qwen2.5:7b
endpoint: http://127.0.0.1:11434/v1
```



### Agent Runner

Master Agent 复用现有 Tool Agent Runner、Task 和 SSE 生命周期。

### Adventure

保存具体故事中的运行 Lore 和实例化内容。

---

## 4.3 Master 数据落盘

Master Library 当前是文件型资料库。

权威索引是：

```text
.narraverse/master-library-manifest.json
```

Manifest 主要负责索引。

真正的：

- Source；
- Revision；
- Master 正文；
- Translation Version；
- Import Transaction；
- Proposal；
- Recovery Claim；

分别持久化保存，而不是全部塞进一个巨型 manifest。

当前默认 Master Library 位于与 Adventure 相邻的 `narraverse-master-library` 工程。

---

# 5. 四层资料结构

系统从用户角度可以理解为四层。

## 5.1 第一层：原文件

包括：

```text
Character Card PNG
Character Card JSON
Standalone Lorebook JSON
Embedded Worldbook
```

原文件负责：

- 来源追溯；
- Revision；
- SHA；
- 后续重新解析；
- 翻译核对；
- Agent 核对原文。

原文件原则上不可被翻译或 Agent 覆盖。

---

## 5.2 第二层：Master Library

Master 保存可长期复用的资料资产。

例如：

```text
Aiko
Kate
Skyrim Worldbook
Night City Lorebook
```

Master 是以后新 Adventure 创建实例时的基线。

它不是：

```text
当前 Adventure 的角色记忆
当前 Adventure 的装备
当前 Adventure 的剧情进度
```

---

## 5.3 第三层：翻译与维护层

这一层包含：

- Translation Target；
- 8097 Job；
- Translation Version；
- Runtime；
- Proposal；
- Polish Candidate；
- Recovery；
- CAS；
- Apply。

它描述的是：

> Master 内容如何从原文逐渐变成可用、可靠、可维护的中文资料。

---

## 5.4 第四层：Adventure Instance

只有用户明确将某个 Master Asset 加入 Adventure 后，系统才生成 Instance。

Instance 属于具体 Adventure。

以后这份资料在 Adventure 内怎么变化，与 Master 分离。

---

# 6. 核心对象与术语

## 6.1 Source

代表一个来源文件的逻辑身份。

例如：

```text
Aiko.png
```

可能以后出现多个 revision。

## 6.2 Source Revision

描述某一次具体原文件版本。

包含：

- revision；
- SHA-256；
- 字节数；
- 原件路径；
- 导入时间；
- parent revision。



---

## 6.3 Master Asset

用户在总资料库真正看到的资料资产。

1.0 正式采用：

```text
一个角色卡 / 一个设定文件
=
一个顶层 Master Asset
```

角色卡：

```text
character_template
```

独立 Lorebook：

```text
lorebook_template
```



---

## 6.4 用户资产粒度 ≠ 内部处理粒度

用户看到：

```text
Aiko
```

系统内部可以看到：

```text
Aiko
├─ character.name
├─ character.description
├─ character.personality
├─ character.scenario
├─ character.first_mes
├─ character_book
│  ├─ entry-xxxx/content
│  ├─ entry-yyyy/content
│  └─ entry-zzzz/content
└─ system_prompt
```

因此：

> 资料库不需要为了字段级处理，把一个角色卡拆成几十个用户可见资产。

---

## 6.5 Nested Entry

角色卡内部 Worldbook 或独立 Lorebook 中的 Entry。

它不是顶层 Master Asset，但仍拥有稳定身份。

当前采用类似：

```text
entry-<hash>
```

的稳定 ID。

字段路径例如：

```text
character_book.entries/<entry_id>/content
```

或者：

```text
lorebook.entries/<entry_id>/content
```

系统不把数组位置作为长期身份。

---

## 6.6 Master Field

真正进行字段级翻译、Recovery、Proposal 和 CAS 的基本单位。

主要记录：

- 原文；
- source hash；
- risk；
- required；
- translation required；
- active content；
- active type；
- active Translation Version。

---

## 6.7 Translation Target

描述：

> 哪个字段需要怎么翻译。

例如：

```text
character.name
→ name_zh
```

普通字段：

```text
character.description
→ faithful_zh
```

它属于导入处理过程，而不是新的用户资产。

---

## 6.8 Translation Version

翻译不会直接覆盖过去的版本。

每次有效译文都会形成独立 Translation Version。

因此：

```text
旧 HY-MT 版本
新 Recovery 版本
Polish Candidate
用户确认后的 polished version
```

可以保留历史关系。

---

## 6.9 任务状态与内容状态

必须区分：

### 任务状态

```text
queued
running
failed
completed
retrying
```

### 内容状态

```text
hy_mt_active
polish_candidate
polished_active
```

一个历史 Job 失败，并不代表当前 Field 一定仍然失败。

---

## 6.10 Proposal

AI 或受控编辑生成的候选修改。

Proposal 并不等于已经写入。

---

## 6.11 Recovery Claim

用于记录某一个明确失败身份是否已经进入 Recovery。

它承担 Recovery 去重和重启后继续追踪的作用。

---

## 6.12 Adventure Instance

代表：

> 某个 Master Asset 在某个 Adventure 中的具体实例。

---

# 7. 端到端旅程：一张 Aiko 角色卡如何进入系统

这是理解系统最直接的方式。

假设用户拥有：

```text
Aiko.png
```

其中包含：

- 名称；
- 描述；
- 性格；
- Scenario；
- Opening；
- 示例对话；
- Embedded Worldbook。

---

## 7.1 导入总资料库

用户进入：

```text
叙界
→ 总资料库
→ 导入到总资料库
```

选择：

```text
Aiko.png
```

系统先执行 Preview。

Preview 负责识别：

- Character Card；
- Lorebook；
- 名称；
- 条目数量；
- 是否存在截断或警告。

此时不写 Master。

---

## 7.2 用户确认导入

确认后：

```text
POST /api/library/import-material
```

进入 Master-only Import。

系统执行：

```text
Aiko.png
↓
Source
↓
Source Revision
↓
Aiko Master Asset
↓
Fields
↓
Nested Entries
↓
Translation Targets
```

这一入口不会创建当前 Adventure Lore，也不会创建当前 Adventure Instance。

---

## 7.3 整卡进入 Master

总资料库只出现：

```text
Aiko
```

不会出现：

```text
Aiko
Aiko Worldbook Entry 1
Aiko Worldbook Entry 2
Aiko Worldbook Entry 3
```

内部 Worldbook Entry 保存在 Aiko 的 Nested Entries 中。

---

## 7.4 创建翻译任务

例如：

```text
character.name
character.description
character.personality
character.scenario
character.first_mes
character_book.entries/<entry_id>/content
```

分别形成 Translation Targets。

然后进入 8097。

---

## 7.5 初译

8097 完成后：

```text
Translation Version
```

写入 Master。

UI 可以显示：

```text
翻译中 4 / 7
```

最终：

```text
翻译完成 7 / 7
```

---

## 7.6 出现失败

如果：

```text
character.scenario
```

翻译失败：

8097 仍然保存该失败记录。

Denova Runtime 将队列记录与 Master Field 合并。

如果满足 Recovery 条件，Orchestrator 会尝试恢复。

---

## 7.7 Agent Recovery

低风险情况下：

```text
Recovery Claim
↓
Master Agent
↓
Proposal
↓
Validate
↓
CAS
↓
Apply
↓
New Translation Version
↓
recovered
```

旧失败任务和旧 Translation Version 可以继续作为历史记录存在。

当前已有真实 qwen25-local Recovery E2E 记录。

---

## 7.8 Aiko 变为 usable

当 blocking requirement 都满足后：

```text
Pipeline
→ usable
```

此时用户可以正常阅读和实例化。

---

## 7.9 阅读角色卡

详情页展示：

```text
角色概览
性格背景
场景开场
示例对白
内部设定
高级指令
```

而不是把原始 JSON 整块打印给用户。

---

## 7.10 加入 Adventure

用户点击：

```text
加入当前冒险
```

才发生：

```text
Aiko Master Asset
↓
Adventure Instance
↓
Character Lore
+
Worldbook Lore
```

内部 Nested Entry 会展开为 Adventure Runtime 需要的多个 Lore。

---

## 7.11 重复加入

同一个：

```text
Aiko
+
Adventure A
```

重复点击，不应该继续制造第二套相同 Lore。

当前实例化已有幂等逻辑。

---

# 8. 翻译流水线

## 8.1 HY-MT / 8097 的定位

8097 承担大量、重复、低成本翻译工作。

Agent 不应该默认重新翻译整套资料。

当前推荐分工：

```text
HY-MT / 8097
→ 全量初译

Agent
→ 失败 Recovery
→ 重要字段精修
→ 用户主动修改
→ 复杂问题
```

---

## 8.2 Runtime 聚合

Master 不把 8097 Job 状态复制成新的持久状态源。

Runtime 查询时动态读取：

```text
http://127.0.0.1:8097/api/denova/translator/jobs
```

并依据：

```text
master_item_id
+
field_path
```

和 Master Field 对齐。

---

## 8.3 用户手动 Retry 与自动 Recovery 不是同一件事

需要区分三个概念。

### 8097 自己的重试行为

属于 Translation Queue 自身机制。

### 用户手动 Retry

UI 可以通过现有：

```text
retryTranslationJob()
```

重新执行一个失败任务。

### Denova Recovery

当失败被判定为稳定失败后，由 Recovery Orchestrator 自动进入 Agent 恢复流程。

因此不能简单描述成：

```text
Retry
→ Recovery
→ Agent
```

它们不是固定串行步骤。

---

## 8.4 必需字段与 Optional Nested Field

一个角色卡可能包含大量 Nested Entries。

如果：

```text
99 个字段正常
1 个非关键 Entry 失败
```

不应该机械地让整张角色卡永远不可用。

因此系统区分：

```text
required
optional
```

关键字段失败可能 blocking。

Optional Nested Field 通常表现为 warning 或进入 Recovery。

---

## 8.5 结构保护

翻译并不只是“获得中文”。

系统仍应保护：

```text
{{char}}
{{user}}
ID
URL
数字
代码
Regex
脚本
Markdown / HTML 结构
控制字段
```

翻译版本写入前还需要满足 revision / SHA / CAS 等安全条件。

---

# 9. Agent 系统与受控修改

Narraverse / Denova 1.0 实际存在两种不同的 Master 相关 Agent 使用方式。

这是必须明确区分的。

---

## 9.1 Master Recovery Agent

用于：

```text
翻译失败
→ 自动 Recovery
```

它使用：

```text
AgentKindToolAgent
```

并被限制到：

```text
一个 master_item_id
+
一个 field_path
```

在低风险 Recovery 中，可以在通过 Proposal / Validate / CAS / Risk Rule 后自动 Apply。

---

## 9.2 Config Manager Agent

这是用户在总资料库中主动打开的交互式 Agent。

它可以：

- 查看当前 Master Asset；
- 查看原件；
- 查看 Field；
- 分析问题；
- 创建 Proposal；
- Validate Proposal。

但它不直接暴露：

```text
apply_master_patch
```

用户主动编辑/精修场景最终仍由用户决定是否应用。

当前 Facts 已明确这两种 Agent 路径都存在。

---

## 9.3 当前本地模型

当前 Master Tool Agent profile：

```text
qwen25-local
```

模型：

```text
qwen2.5:7b
```

Endpoint：

```text
http://127.0.0.1:11434/v1
```

Master Agent 不硬编码该模型，而是通过统一 model profile 解析。

---

## 9.4 为什么小模型目前能够完成 Recovery

系统没有要求模型：

> 自己理解整个项目并任意修改。

而是把任务限制成：

```text
这是目标 Asset
这是目标 Field
这是 Pipeline
这是 Translation 状态
这是允许使用的工具
这是 Proposal Schema
```

因此：

> **模型能力 + 明确工具边界 + Schema + CAS**

共同决定可靠性。

不是单独依赖模型“聪明”。

---

## 9.5 Master Agent 工具

当前 Master Agent 有八个受控工具：

```text
get_master_asset
get_master_field
get_master_pipeline_status
get_master_translation_status
get_master_issue
create_master_proposal
validate_master_patch
apply_master_patch
```

但没有：

- Shell；
- 普通文件写入；
- 普通 Lore 任意写入；
- Agent 配置修改；
- 任意跨资产修改。



---

## 9.6 Proposal

任何受控 AI 修改首先形成 Proposal。

Proposal 的意义是：

```text
AI 建议
≠
当前生效内容
```

它允许系统：

- 显示前后差异；
- Validate；
- 判断是否过期；
- 判断风险；
- 决定是否 Apply。

---

## 9.7 CAS

Apply 前必须核对：

```text
master_item_id
field_path
input_revision
source_sha256
base_translation_version
```

如果 Proposal 建立以后字段已经变化：

```text
Proposal
→ conflict
```

而不是覆盖最新数据。



---

## 9.8 Polish Candidate

用户主动精修时：

```text
Agent Output
→ Candidate
```

Candidate 不应自动取代当前 active Translation。

用户确认后，才会成为新的活动版本。

当前 Candidate 机制已经存在，但部分完整生产路径仍属于 PARTIAL，而不是所有场景都已经完全闭环。

---

## 9.9 高风险字段

高风险内容包括：

```text
system_prompt
post_history_instructions
scripts
regex
runtime control fields
```

自动 Recovery 不应该擅自 Apply。

此类场景应该进入：

```text
needs_user
```

---

# 10. Recovery 自动恢复

## 10.1 Recovery 的目的

传统系统遇到失败通常：

```text
失败
→ 报错
→ 用户自己处理
```

Denova 的目标是：

```text
失败
→ 系统判断
→ 自动 Recovery
→ 只有无法安全解决时才找用户
```

---

## 10.2 当前 Recovery 流程

```text
8097 failed
↓
Master Runtime
↓
稳定失败判定
↓
Recovery Claim
↓
Master Agent
↓
Proposal
↓
Validate / CAS
↓
低风险 Apply
↓
New Translation Version
↓
Pipeline Recheck
↓
recovered
```



---

## 10.3 Recovery Claim

Claim Key 基于：

```text
master_item_id
field_path
input_revision
source_sha256
```

这解决：

```text
watcher 重扫
程序重启
重复看到同一个 failed
```

导致 Agent 重复启动的问题。

同一失败身份只应该被 Recovery 一次。

---

## 10.4 needs_user

以下情况可能进入 needs_user：

- 高风险；
- CAS Conflict；
- 没有合法 Proposal；
- Agent 无法可靠判断；
- Recovery 后 Pipeline 仍失败；
- 需要人为选择。

`needs_user` 是产品状态。

不是简单的技术报错。

---

## 10.5 当前 5 秒终态判断

目前 8097 没有正式提供：

```text
terminal_failure
retry_exhausted
max_retries
next_retry
```

Denova 当前采用近似判断：

```text
status = failed
attempts >= 1
queue 未暂停
updated_at 稳定至少约 5 秒
```

这属于：

```text
PARTIAL
```

因为已经有可运行兼容逻辑。

但正式：

```text
terminal_failure / retry_exhausted 协议
+
基于协议的完整 Recovery 调度
```

仍属于：

```text
NOT IMPLEMENTED
```



---

# 11. Master 与 Adventure 的隔离边界

## 11.1 Master 是模板

例如：

```text
Aiko Master Asset
```

描述的是：

> 新 Adventure 当前应该拿到的 Aiko 基线。

---

## 11.2 Adventure 是实例

Adventure A 中：

```text
Aiko Instance A
```

Adventure B 中：

```text
Aiko Instance B
```

两者以后可以发展成完全不同的状态。

---

## 11.3 Master 粒度与 Adventure Lore 粒度不同

Master：

```text
Aiko
```

是一项资产。

Adventure Runtime 可以展开：

```text
Aiko Character Lore
Aiko Worldbook Lore 1
Aiko Worldbook Lore 2
Aiko Worldbook Lore 3
```

这是正常投影，而不是 Master 资产重复。

---

## 11.4 Nested Entry 映射当前已经存在

`MasterInstanceRef` 当前保存：

```text
nested_entry_id
→ adventure_lore_id
```

因此系统已经能够追踪：

> Adventure 中某条 Runtime Lore 来自 Master 中哪个 Nested Entry。

这不是未来设想，而是当前已实现关系。

---

## 11.5 实例化幂等

同一个：

```text
Master Asset
+
Adventure
```

默认只创建一个 Instance。

用户重复点击“加入当前冒险”不会重复生成完整 Lore 集合。

---

## 11.6 Master 不自动同步已有 Instance

Master 出现新 revision 后：

```text
不会自动修改已有 Adventure Instance
```

以后如果设计升级机制，应采用：

```text
发现 Master 新版本
→ 提示用户
→ 用户选择
→ Diff / Upgrade
```

而不能静默覆盖。

---

## 11.7 旧 Adventure 兼容

旧 `worldbook_entry` Master 结构已经属于 LEGACY。

但旧 Adventure 中已经实例化出来的 Lore 内容继续保留。

迁移或清理旧 Master 子资产不能自动删除历史 Adventure 内容。

当前实现明确保留这种兼容。

---

# 12. 用户操作指南

## 12.1 导入到总资料库

入口：

```text
叙界
→ 总资料库
→ 导入到总资料库
```

意义：

```text
文件
→ Master
```

不会自动进入当前 Adventure。

---

## 12.2 浏览资料

总库列表目前支持：

- 资产卡片；
- 中文名称；
- 类型；
- 简介；
- Nested Entry 数量；
- 来源；
- Adventure usage；
- 搜索；
- 筛选；
- 分页。



---

## 12.3 阅读详情

角色卡详情以内容阅读为主。

主要区域：

```text
角色概览
性格背景
场景开场
示例对白
内部设定
高级指令
```

Lorebook：

```text
Entry 目录
标题
关键词
正文
搜索
```

---

## 12.4 七节点工作台

资产详情提供：

```text
1. 原件
2. 解析
3. 规范化
4. 翻译
5. 检查
6. 可用
7. 加入冒险
```

### 原件

确认 Source / Revision / Original 已存在。

### 解析

确认文件类型和基本字段结构已经识别。

### 规范化

确认来源数据已经映射成 Master 可处理结构。

### 翻译

显示字段翻译进度和 Runtime。

### 检查

聚合当前问题。

### 可用

表示当前 revision 满足进入 Adventure 的条件。

### 加入冒险

显示 Instance / Usage，而不是新的内容处理状态。

当前 parse / normalize / check 部分数据仍由现有事实推导，并非都有独立 Snapshot，因此属于 CURRENT / PARTIAL。

---

## 12.5 主动修改 / 精修

用户可以：

- 编辑常用字段；
- 调用右侧 Config Manager Agent；
- 查看 Proposal；
- 查看修改前后；
- Validate；
- Apply。

高级风险字段继续受到限制。

---

## 12.6 加入当前冒险

两个入口：

### 总资料库详情

```text
加入当前冒险
```

### Adventure 内

```text
加载资料
→ 总资料库
→ 选择 Asset
→ 加入当前冒险
```

只有这一阶段才创建 Adventure Instance 和 Lore。

---

## 12.7 两个按钮不能混淆

必须长期保持：

```text
导入到总资料库
```

和：

```text
加入当前冒险
```

是两个不同操作。

前者处理：

```text
Source / Master / Translation
```

后者处理：

```text
Instance / Adventure Lore
```

---

# 13. 1.0 能力边界

## 13.1 CURRENT

当前生产版已经具备：

| 能力 | 状态 |
|---|---|
| Master Library | CURRENT |
| Source / Revision | CURRENT |
| 一文件一个顶层 Master Asset | CURRENT |
| Nested Entry | CURRENT |
| 稳定 Entry 字段路径 | CURRENT |
| Character / Lorebook 整卡阅读 | CURRENT |
| Master-only Import | CURRENT |
| HY-MT / 8097 字段翻译 | CURRENT |
| Translation Version | CURRENT |
| Master + 8097 Runtime 聚合 | CURRENT |
| Translation Retry | CURRENT |
| 七节点 UI | CURRENT / PARTIAL |
| Pipeline usable / staging | CURRENT |
| Master Agent | CURRENT |
| Config Manager Master Agent | CURRENT / PARTIAL |
| Proposal / Validate / CAS | CURRENT |
| 低风险 Recovery Auto Apply | CURRENT |
| Recovery Claim | CURRENT |
| Recovery Orchestrator | CURRENT |
| needs_user | CURRENT |
| Adventure Instance | CURRENT |
| Nested Entry → Adventure Lore 展开 | CURRENT |
| Instance 幂等 | CURRENT |
| Usage 投影 | CURRENT / PARTIAL |
| 总资料库生产 UI | CURRENT |

---

## 13.2 PARTIAL

| 能力 | 说明 |
|---|---|
| Entry Stable ID | 已使用稳定哈希，但极端缺少身份信息时仍非“首次 UUID 持久化”方案 |
| Pipeline parse / normalize / check | 仍有状态通过现有数据推导 |
| Issue | 主要是查询聚合，不是完整持久 Issue Domain |
| Usage | 主要由 Instance Ref 投影 |
| Polish Candidate | 核心机制存在，但并非所有真实场景都完成完整回归 |
| 高风险 Candidate E2E | 已证明不会越权 Apply，但所有候选阻断路径未完全覆盖 |
| 8097 Terminal Failure 判断 | 当前使用临时稳定窗口判断 |
| Master Search | 当前仍是有界扫描，没有独立搜索索引 |
| 全量 Go Test | 历史 Windows 边缘测试未全绿 |

当前技术债和 PARTIAL 项在 Facts 中已有明确记录。

---

## 13.3 LEGACY

当前仍存在但不应成为新设计核心：

```text
unmanaged_direct
旧 worldbook_entry 兼容结构
旧 Entry 构造/迁移辅助逻辑
```

Adventure 内上传并直接加载的旧路径仍可能继续保留，但新资料库推荐路径应优先经过 Master。

---

## 13.4 NOT IMPLEMENTED

以下能力不能描述为 1.0 已完成：

- Normalize Agent；
- Unknown Field Agent；
- 独立 Check Agent；
- 全库 Agent；
- 批量 Agent；
- 所有资料默认 Agent 二次翻译；
- Master Revision 自动同步 Adventure；
- Entry 级总库实例化选择器；
- 跨 Asset 批量实例化；
- 8097 正式 terminal failure 协议；
- 基于 dependency graph 的字段 stale 重跑；
- Translation Version Merge UI；
- 通用 JSON Patch Editor；
- 原文件直接写回；
- 完整 Proposal / Recovery 审计工作台。



---

# 14. 当前技术债与开发原则

## 14.1 8097 正式终态协议

长期最值得解决的是：

```text
terminal_failure
retry_exhausted
max_retries
next_retry
```

Denova 不应该永久依赖：

```text
failed + 5 秒
```

猜测队列是否已经最终失败。

---

## 14.2 Pipeline 独立快照

未来如果真实需求出现，可以进一步为：

```text
parse
normalize
check
```

建立独立输出 Revision / Snapshot。

但当前没有必要仅为了“架构漂亮”重写。

---

## 14.3 Legacy 理解成本

旧 `worldbook_entry` 和 `unmanaged_direct` 增加维护复杂度。

是否删除应以：

```text
实际迁移价值
+
旧数据兼容风险
```

判断，而不是为了代码整洁立即清除。

---

## 14.4 全量 Go Test

当前已经有：

- Master 定向测试；
- API 定向测试；
- Capability 回归；
- CAS 回归；
- Recovery E2E；
- Go Build；
- 前端 Build；
- 浏览器生产验收。

但历史 `go test ./...` 仍存在 Windows：

- Symlink；
- Permission；
- Path；
- Atomic Replace；

等边缘失败，不能把 1.0 描述成“全仓所有测试全部全绿”。

---

## 14.5 开发原则一：先查现有能力

新功能开发顺序：

```text
先查当前代码
↓
再查 Implementation Facts
↓
再查当前设计
↓
必要时查成熟外部方案
↓
最后才新增实现
```

不要重复造已经存在的能力。

---

## 14.6 开发原则二：后台复杂，前台简单

普通用户不应该成为 Debug Console 使用者。

技术细节：

```text
task id
worker
CAS
revision
HTTP
claim
```

默认应该折叠。

---

## 14.7 开发原则三：用户是最后一级

异常优先顺序：

```text
系统自动处理
→ Agent
→ 用户
```

而不是一出问题就让用户解决。

---

## 14.8 开发原则四：模型能力不能替代权限系统

模型更强：

```text
≠
应该给 file_write
```

Master Agent 的可靠性来自：

```text
Tool Scope
Proposal
CAS
Risk
Validation
```

---

## 14.9 开发原则五：不要为了小模型破坏安全架构

如果模型不会正确使用 Proposal：

应该考虑：

```text
改 Prompt
缩小 Scope
改善 Tool
改善 Schema 提示
换模型
```

不能：

```text
关闭 CAS
放宽安全检查
开放普通文件写
```

---

## 14.10 开发原则六：Master 与 Adventure 隔离不可默认破坏

任何未来：

```text
Master → Adventure Update
```

都必须是新功能，并有明确：

```text
Diff
用户确认
Instance Revision
Conflict Handling
```

不能偷偷同步。

---

## 14.11 开发原则七：优先解决真实使用问题

1.0 以后应先观察：

- 哪些字段翻译差；
- 哪些角色卡不好读；
- 哪些 UI 状态难理解；
- 哪些 Recovery 经常失败；
- needs_user 是否太多；
- 大 Lorebook 是否慢。

真实问题优先于继续堆新 Agent 和复杂领域模型。

---

# 15. 新 AI / Codex 接手指南

## 15.1 推荐阅读顺序

新的 AI 接手项目时：

```text
1. 本文档
2. Narraverse-Denova-1.0-Implementation-Facts.md
3. CODE_GUIDE.md
4. COLLABORATION_LOG.md
5. 本次任务直接相关源码
```

不要第一步读取整个仓库。

---

## 15.2 开工前必须确认

任何修改之前先回答：

```text
我要改的是哪一层？
Source？
Master？
Translation？
Agent？
Runtime？
Adventure？
UI？
```

再确认：

```text
当前是不是已经有类似实现？
是不是 LEGACY 路径？
是不是会改变 Master / Adventure 边界？
是不是会产生新的状态真源？
```

---

## 15.3 常见修改从哪里开始

### 修改 Master 数据结构 / Translation Version

优先：

```text
denova-src/internal/book/master_library.go
```

核心职责包括：

- Manifest；
- Source；
- Master Item；
- Field；
- Translation Version；
- Import Transaction；
- CAS Translation 写入。

---

### 修改 Master 查询 / Pipeline

优先：

```text
denova-src/internal/book/master_library_query.go
```

---

### 修改 Character / Lorebook Import

优先：

```text
denova-src/internal/book/material_import.go
denova-src/internal/book/character_card.go
```

---

### 修改 Master 与 8097 Runtime 聚合

优先：

```text
denova-src/internal/book/master_runtime.go
```

---

### 修改 Proposal / CAS / Candidate

优先：

```text
denova-src/internal/book/master_agent.go
```

---

### 修改 Recovery

优先：

```text
denova-src/internal/book/master_recovery.go
denova-src/internal/app/master_recovery.go
```

---

### 修改 Master Agent Tools

优先：

```text
denova-src/internal/agent/master_agent_tools.go
```

---

### 修改 Agent Capability

检查：

```text
denova-src/internal/agent/tool_result_policy.go
```

尤其不要再次把 Master 受控工具错误归类为普通 `file_write`。

---

### 修改 Library UI

优先：

```text
denova-src/web/src/features/library/LibraryView.tsx
```

---

### 修改总库导入 UI

优先：

```text
denova-src/web/src/features/library/MasterImportDialog.tsx
```

---

### 修改 Adventure 加载资料

优先：

```text
denova-src/web/src/features/interactive/components/setting-panel/MaterialImportDialog.tsx
```

完整核心代码地图已经由 Facts 核验。

---

## 15.4 修改 Master 时必须检查

至少考虑：

```text
source_id
source revision
source SHA
master_item_id
field_path
Translation Version
CAS
Instance Ref
legacy data
```

---

## 15.5 修改 Agent 时必须检查

至少考虑：

```text
Agent Scope
Tool Capability
Proposal
Validate
CAS
Risk
Apply
needs_user
```

---

## 15.6 修改 Translation 时必须检查

至少考虑：

```text
Placeholder
Numbers
URLs
Scripts
Regex
Markdown / HTML
Source Revision
Source SHA
Base Translation Version
```

---

## 15.7 修改实例化时必须检查

至少考虑：

```text
Master Asset
Adventure Key
Instance ID
generated_lore_ids
nested_entry_lore_ids
loaded revision
幂等
```

---

## 15.8 开发完成标准

以后不能只用：

```text
代码写完
+
测试通过
```

作为所有用户功能的最终完成定义。

对于用户可见功能，应尽量满足：

```text
源码完成
+
定向测试
+
Build
+
正式运行版部署
+
浏览器 / 用户可见验收
```

这条规则来自 1.0 实际开发过程中已经暴露过的问题：测试实例成功并不代表日常 Denova 已经真正可用。

---

# 16. 附录

---

## 附录 A：主要 API

### Master Library

```text
GET  /api/library/assets
POST /api/library/import-material
GET  /api/library/assets/:id
GET  /api/library/assets/:id/pipeline
GET  /api/library/assets/:id/translations
GET  /api/library/assets/:id/usages
POST /api/library/assets/:id/instances
GET  /api/library/assets/:id/runtime
GET  /api/library/assets/:id/proposals
POST /api/library/assets/:id/proposals
POST /api/library/assets/:id/proposals/batch-apply
POST /api/library/proposals/:id/validate
POST /api/library/proposals/:id/apply
POST /api/library/assets/:id/agent
GET  /api/library/agent/tasks/:id/stream
```



### Adventure / Material

```text
POST /api/workspace/import-material/preview
POST /api/workspace/import-material
POST /api/workspace/import-material/master/translation
POST /api/workspace/import-material/master/finalize
```

旧素材导入接口仍存在，但新的资料库主流程应优先使用 Master。

---

## 附录 B：核心代码地图

| 文件 | 主要职责 |
|---|---|
| `internal/book/master_library.go` | Master 存储、Source、Field、Translation Version、CAS |
| `internal/book/master_library_query.go` | List、Detail、Pipeline |
| `internal/book/material_import.go` | Preview、Master Import、Adventure Projection |
| `internal/book/character_card.go` | Character Card 解析 |
| `internal/book/master_runtime.go` | Master + 8097 Runtime |
| `internal/book/master_agent.go` | Proposal / Validate / CAS / Apply |
| `internal/book/master_recovery.go` | Recovery Claim |
| `internal/app/master_agent.go` | Master Agent Task |
| `internal/app/master_recovery.go` | Recovery Orchestrator |
| `internal/agent/master_agent_tools.go` | Master Agent Tool Scope |
| `internal/agent/config_manager_master_tools.go` | Config Manager Master Tools |
| `internal/agent/tool_result_policy.go` | Capability 分类 |
| `internal/api/routes.go` | API Routes |
| `internal/api/handlers/handler_library.go` | Library Handlers |
| `web/src/features/library/LibraryView.tsx` | 总资料库 UI |
| `web/src/features/library/MasterImportDialog.tsx` | Master Import UI |
| `MaterialImportDialog.tsx` | Adventure 加载资料 |



---

## 附录 C：Master Agent 安全边界

Master Agent 当前允许：

```text
读取目标 Asset
读取目标 Field
读取 Pipeline
读取 Translation Runtime
读取 Issue
创建 Proposal
Validate Proposal
Apply 受控 Patch
```

Master Agent 当前不允许：

```text
普通文件系统写入
Shell
任意 Adventure 写入
修改其他 Master Asset
修改 Agent 配置
绕过 Proposal
绕过 CAS
绕过 Risk Check
```

---

## 附录 D：术语表

### Source

原始资料来源逻辑身份。

### Source Revision

某一次具体原件版本。

### Master Asset

用户可见的顶层资料资产。

### Master Field

字段级处理单位。

### Nested Entry

角色卡 / Lorebook 内部稳定 Entry。

### Translation Target

需要交给翻译系统处理的字段目标。

### Translation Version

字段的一次独立翻译版本。

### Pipeline

根据当前 Source、Master、Translation、Issue 等信息聚合出来的处理状态。

### Runtime

Master 与当前 8097 Job 的实时聚合状态。

### Proposal

AI 或受控编辑产生的候选修改。

### CAS

用于防止基于旧数据生成的 Proposal 覆盖新内容的比较交换保护。

### Polish Candidate

尚未成为活动版本的精修候选。

### Recovery Claim

记录一个失败身份的自动恢复生命周期和幂等状态。

### needs_user

系统无法或不应该安全自动处理，需要用户参与决策的产品状态。

### Adventure Instance

Master Asset 在某个 Adventure 中的具体运行实例。

### Usage

由 Instance Ref 推导出的 Master Asset 被 Adventure 使用的关系。

---

# 结语：Narraverse / Denova 1.0 的正式定义

Narraverse / Denova 1.0 已经不再只是一个：

> 读取角色卡，然后和 AI 聊天的应用。

它已经形成：

```text
原始角色 / 世界资料
↓
长期归档
↓
结构化 Master Library
↓
本地自动翻译
↓
字段级版本管理
↓
Agent 辅助修复和精修
↓
Proposal / CAS / Risk 安全控制
↓
可复用 Master Asset
↓
按需实例化到不同 Adventure
↓
独立故事运行
```

其中最重要的不是某个 API、某个模型或某个页面，而是已经形成了以下稳定边界：

```text
原件负责来源真相

Master 负责长期资料资产

Translation Version 负责内容演进

Agent 负责受控辅助处理

Adventure Instance 负责故事运行

用户负责最终选择
```

因此，Narraverse / Denova 1.0 可以正式定义为：

> **一个以 Master Library 为中心，将角色卡、Lorebook 和世界设定进行归档、翻译、版本化、AI 辅助维护，并安全实例化到不同 Adventure 中使用的本地 AI 资料与互动运行平台。**

1.0 之后，项目的重点不再是继续证明这套架构“能不能工作”。

接下来真正值得关注的是：

> **它在大量真实角色卡、Lorebook 和实际 Adventure 中到底好不好用。**