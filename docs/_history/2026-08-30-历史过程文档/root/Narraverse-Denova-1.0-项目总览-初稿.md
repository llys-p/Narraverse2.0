# Narraverse / Denova 1.0  
## 项目总览、系统架构与维护说明

**版本：1.0**  
**基线日期：2026-08-30**

---

# 0. 文档定位

本文档定义当前 Narraverse / Denova 1.0 的正式系统形态。

它的目的不是记录开发过程，也不是罗列曾经讨论过的所有设想，而是回答以下问题：

- Narraverse / Denova 到底是什么；
- 当前 1.0 已经能够做什么；
- 用户实际如何使用；
- 原始资料、总资料库、翻译、Agent 和 Adventure 之间是什么关系；
- 为什么系统采用现在的结构；
- 哪些能力已经投入生产；
- 哪些能力仍然只是部分实现或历史兼容；
- 后续 AI 或开发者接手时，哪些架构边界不能随意破坏。

本文所称“1.0 已完成能力”，以当前生产代码、实际部署和已有运行验收为准，而不是以历史设计稿为准。

当前生产系统已经包括 Narraverse、Denova、Master Library、8097 Translation、Master Agent、Adventure 和 Web UI 等主要部分。

---

# 1. Narraverse / Denova 是什么

Narraverse / Denova 是一套围绕：

- 角色卡；
- 世界设定；
- Lorebook；
- AI 翻译；
- 资料整理；
- AI Agent 辅助维护；
- 互动故事 / 文字冒险；

建立的本地资料与运行平台。

它并不只是一个“聊天界面”，也不只是一个“角色卡播放器”。

1.0 逐渐形成的核心定位是：

> **先把角色、设定和世界知识整理成可长期维护的资料资产，再根据需要将这些资产投影到具体 Adventure 中使用。**

因此，系统把“资料管理”和“故事运行”明确分开。

用户可以长期维护一个独立的总资料库，而不是把所有资料都绑定在某一本故事、某一次冒险或某一个对话中。

---

# 2. 1.0 的核心目标

Narraverse / Denova 1.0 主要解决五个问题。

## 2.1 资料能够长期保存

原始角色卡、Lorebook 和世界设定不再只是一次性加载文件。

系统会保存：

- 原始来源；
- Source Revision；
- SHA-256；
- Master Asset；
- 字段结构；
- Translation Version；
- 嵌套 Worldbook Entry；
- Adventure 使用关系。

原文件始终承担来源证明作用。

---

## 2.2 英文资料可以自动进入中文资料库

大量英文角色卡和 Lorebook 不要求用户手工逐项翻译。

默认路径是：

```text
原文件
→ 解析
→ Master
→ HY-MT / 8097 初译
→ 字段级 Translation Version
→ Pipeline 检查
→ usable
```

Agent 不负责默认把整个资料重新翻译一次。

当前原则仍然是：

> **HY-MT / 本地翻译承担大量初译，Agent 处理异常、重要字段和用户主动要求的精修。**

当前实现中，8097 是持久化、串行的翻译任务队列，Master 通过字段目标把任务提交给 8097。

---

## 2.3 AI 可以帮助修资料，但不能随便改资料

Denova Agent 不拥有对 Master 的任意写权限。

Agent 不能直接：

```text
找到文件
→ 改文件
→ 保存
```

而必须经过：

```text
读取目标字段
→ 创建 Proposal
→ Validate
→ CAS
→ 风险判断
→ Apply
```

这使 AI 成为：

> **受控资料维护者**

而不是：

> **拥有整个资料库写权限的自动脚本。**

---

## 2.4 一个角色可以被多个 Adventure 使用

Master 是公共模板。

Adventure 是具体运行实例。

因此：

```text
Master Aiko
```

可以分别被加载到：

```text
Adventure A
Adventure B
Adventure C
```

这些 Adventure 中的运行内容互相独立。

一个 Adventure 后续产生的：

- 关系变化；
- 装备变化；
- 剧情进度；
- 成长；
- 伤势；
- 临时记忆；

不会自动写回 Master。

---

## 2.5 普通用户不需要理解后台错误

Denova 内部可以很复杂。

但普通界面应尽量只显示：

```text
处理中
翻译完成
Denova 正在处理
需要你的确认
```

而不是：

```text
HTTP 500
worker timeout
revision mismatch
CAS conflict
task id
retry counter
```

技术诊断继续存在，但默认折叠。

---

# 3. 用户实际如何使用 1.0

当前 1.0 的推荐使用流程已经比较清晰。

---

## 3.1 导入资料

用户进入：

```text
叙界
→ 总资料库
→ 导入到总资料库
```

选择：

- Character Card JSON；
- Character Card PNG；
- Lorebook JSON。

系统先进行 Preview。

确认以后：

```text
文件
→ Source
→ Source Revision
→ Master Asset
→ Translation Targets
→ 8097
```

这一入口只进入总资料库。

不会自动加入当前 Adventure。

当前 `/api/library/import-material` 明确属于 Master-only 导入；只有实例化接口才会创建 Adventure Instance。

---

## 3.2 在总资料库查看资料

用户可以在总资料库看到：

- 角色卡；
- Lorebook；
- 中文名称；
- 类型；
- 简介；
- 来源；
- 内部条目数量；
- 翻译进度；
- Adventure 使用次数。

点击资产后进入完整详情页。

---

## 3.3 阅读整张角色卡

角色卡不再被拆成大量顶层 Master 项目。

例如：

```text
Aiko
```

就是一项资产。

内部可以包含：

```text
角色名称
描述
性格
Scenario
Opening
Alternate Greetings
示例对话
System Prompt
Post-history Instructions
Embedded Worldbook
Extensions
```

Worldbook Entry 可以展开查看，但不会污染总库顶层列表。

---

## 3.4 等待翻译完成

导入后，HY-MT / 8097 开始处理字段翻译。

UI 会显示类似：

```text
翻译中 4 / 7
```

完成后：

```text
翻译完成 7 / 7
```

如果局部失败，用户通常不需要马上处理。

系统首先尝试：

```text
Retry
→ Recovery
→ Agent
```

只有安全自动恢复无法完成时，才进入：

```text
needs_user
```

---

## 3.5 需要时让 Denova Agent 处理

用户可以主动对某个字段进行：

```text
Denova 精修
```

或者在 Recovery 中由系统自动启动 Master Agent。

Agent 会：

```text
读取字段
读取 Pipeline
读取 Translation Version
分析问题
创建 Proposal
```

之后系统负责安全校验。

---

## 3.6 加入 Adventure

只有用户明确点击：

```text
加入当前冒险
```

Master Asset 才会被实例化。

也可以在 Adventure 内：

```text
加载资料
→ 总资料库
→ 选择资产
→ 加入当前冒险
```

此时才真正生成 Adventure Lore。

---

# 4. 系统整体架构

Narraverse / Denova 1.0 可以概括为：

```text
                  ┌─────────────────────┐
                  │     原始资料文件      │
                  │ Character / Lorebook │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │    Master Library   │
                  │ Source / Revision   │
                  │ Master Asset        │
                  │ Fields / Entries    │
                  └──────────┬──────────┘
                             │
                   Translation Targets
                             │
                             ▼
                  ┌─────────────────────┐
                  │ HY-MT / 8097 Queue  │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ Translation Version │
                  └──────────┬──────────┘
                             │
                    Pipeline / Runtime
                             │
                ┌────────────┴────────────┐
                ▼                         ▼
        ┌──────────────┐          ┌──────────────┐
        │ Master Agent │          │  usable      │
        │ Recovery     │          │ Master Asset │
        └──────────────┘          └──────┬───────┘
                                        │
                                用户明确加入 Adventure
                                        │
                                        ▼
                                ┌──────────────┐
                                │  Instance    │
                                │ Adventure    │
                                │ Lore         │
                                └──────────────┘
```

---

# 5. 四层资料结构

从产品角度看，Narraverse 最重要的结构可以理解成四层。

---

## 5.1 第一层：原文件

包括：

```text
Character Card PNG
Character Card JSON
Lorebook JSON
Embedded Worldbook
```

原文件是来源真相。

它负责回答：

> 这个资料最初到底是什么？

因此：

- 翻译不能覆盖原件；
- Agent 不能重写原件；
- Adventure 不能反向污染原件。

Master Source Revision 会记录 revision、SHA-256、归档位置和父 revision 等来源信息。

---

# 6. 第二层：Master Library

Master Library 是 Narraverse 1.0 的核心。

它保存的是：

> **可重复使用的资料模板**

例如：

```text
Aiko
Kate
Skyrim Worldbook
Night City Lorebook
```

Master 不保存某一次 Adventure 的实时剧情状态。

---

# 7. 第三层：Translation / Processing

翻译层负责：

- 初译；
- 字段版本；
- Recovery；
- Polish Candidate；
- Agent Proposal；
- Validate；
- CAS；
- Apply。

它不是新的角色资产，而是 Master 内容演进过程。

---

# 8. 第四层：Adventure Instance

Adventure Instance 是：

> 某个 Master Asset 在某一次 Adventure 中的运行副本。

因此：

```text
Master
```

是模板。

```text
Instance
```

是运行内容。

两者必须保持隔离。

---

# 9. Master 的资产粒度

Narraverse 1.0 正式采用：

> **一个原始角色卡 / 一个设定文件 = 一个顶层 Master Asset。**

当前角色卡只生成一个：

```text
character_template
```

独立 Lorebook 只生成一个：

```text
lorebook_template
```

内嵌 Worldbook / Lorebook Entries 不再作为活动总库里的独立顶层资产。

---

# 10. 用户资产粒度与内部处理粒度

这是 1.0 中非常重要的设计原则。

## 用户看到：

```text
Aiko
```

一个角色。

## 系统内部看到：

```text
Aiko
├─ character.name
├─ character.description
├─ character.personality
├─ character.scenario
├─ character.first_mes
├─ character_book
│  ├─ entry-xxx
│  │  └─ content
│  ├─ entry-yyy
│  │  └─ content
│  └─ entry-zzz
│     └─ content
└─ system_prompt
```

因此：

> **用户资产粒度 ≠ 内部处理粒度。**

这样既保持总资料库整洁，也允许字段级处理。

---

# 11. Nested Entry

Worldbook Entry 虽然不是独立 Master Asset，但仍然拥有稳定身份。

例如：

```text
entry-xxxxxxxx
```

系统不会简单依赖：

```text
entries[3]
```

作为长期身份。

当前 Entry ID 基于来源身份字段或可重复哈希生成；字段路径采用稳定 Entry ID，例如：

```text
character_book.entries/<entry_id>/content
```

或：

```text
lorebook.entries/<entry_id>/content
```

因此内部 Entry 仍然可以独立：

- 翻译；
- Recovery；
- Proposal；
- CAS；
- 版本定位；
- 实例化。



---

# 12. Master Field

Master 中真正执行翻译和修改的主要单位是 Field。

字段保存：

- 原文；
- 原文 SHA；
- 风险等级；
- required；
- translation required；
- active content；
- active type；
- active Translation Version。

因此：

```text
Master Asset
```

是用户资产单位。

```text
Master Field
```

是内容处理单位。

---

# 13. Master Source 与 Revision

Master 不只知道：

```text
Aiko
```

它还知道：

```text
Aiko 来自哪个文件
```

以及：

```text
这个文件是哪一个 revision
```

每次来源更新都有：

```text
source_id
revision
source_sha256
```

这为后面的 CAS 和 stale 检查提供基础。

---

# 14. Translation Version

翻译不是直接覆盖字段。

每次有效翻译都会形成：

```text
MasterTranslationVersion
```

版本记录包括：

- Master Item；
- Field Path；
- Source Revision；
- Source SHA；
- Translation；
- Translation SHA；
- Model；
- Task ID；
- Confirmation；
- Version Revision。

因此：

```text
旧译文
```

不会因为新译文出现而消失。

---

# 15. 内容版本状态与任务状态

Narraverse 1.0 明确区分：

## 任务状态

例如：

```text
queued
running
failed
completed
retrying
```

## 内容状态

例如：

```text
hy_mt_active
polish_candidate
polished_active
```

这是两个完全不同的概念。

一个 8097 Job 失败，不等于某个 Master Field 当前没有可用译文。

同样，一个历史任务失败，也不能永久污染当前 Runtime。

---

# 16. HY-MT / 8097

8097 是当前本地翻译流水线的重要组成部分。

它负责：

- 持久化任务；
- 串行执行；
- Retry；
- Pause；
- Cancel；
- Translation Runtime。

Master 本身不把 8097 Job 状态复制成新的持久状态真源。

而是通过 Runtime 查询动态聚合。

当前 Runtime 通过：

```text
master_item_id
+
field_path
```

把 8097 Job 和 Master Field 对齐。

---

# 17. Translation Target

导入 Master 时，每个需要翻译的字段都会生成 Translation Target。

它描述：

- field path；
- translation mode；
- apply policy；
- required；
- current state。

例如：

```text
character.name
```

可以使用：

```text
name_zh
```

普通内容则使用：

```text
faithful_zh
```

---

# 18. 必需字段与可选字段

整卡化之后，一个资产可能拥有几十甚至上百个内部字段。

因此不能要求：

> 任何一个非关键 Entry 翻译失败，就把整张卡判定完全不可用。

当前 Nested Entry 字段多数属于 optional。

局部失败通常产生：

```text
warning
```

而不是永久阻止：

```text
usable
```

关键字段才具有 blocking 意义。

---

# 19. 七节点工作台

当前总资料库使用七节点表达资产处理过程：

```text
1. 原件
2. 解析
3. 规范化
4. 翻译
5. 检查
6. 可用
7. 加入冒险
```

这套节点的目的不是把后台所有实现暴露给用户。

而是回答：

> 这份资料现在处理到哪里了？

---

# 20. 原件节点

表示：

- Source 存在；
- Revision 存在；
- 原件已归档。

---

# 21. 解析节点

表示系统已经理解：

```text
这是什么文件
```

以及主要字段结构。

---

# 22. 规范化节点

表示来源结构已经映射为 Master 可处理结构。

当前 parse、normalize、check 还没有全部拥有独立 Snapshot / Revision，所以部分节点状态仍然由现有数据推导。

---

# 23. 翻译节点

用于表示字段级翻译完成情况。

例如：

```text
7 / 7
```

用户默认只看到：

```text
翻译完成
```

技术字段可以在诊断区域查看。

---

# 24. 检查节点

用于聚合：

- 缺失字段；
- Translation 问题；
- Revision 问题；
- Pipeline Issue。

目前 Issue 主要仍是查询期生成的摘要，不是一个完整独立的 Issue 数据库。

---

# 25. usable

`usable` 表示：

> 当前 Master Asset 已经满足进入 Adventure 的基本条件。

这不是“永远不会再变化”。

而是：

> 当前这个 revision 在现有规则下可以使用。

---

# 26. 加入冒险节点

第七节点实际上与前六个节点不同。

它不是：

```text
处理完成
```

而是：

```text
这份 Master Asset 是否已经被某些 Adventure 使用
```

因此它更接近 Usage / Instance View。

---

# 27. Master Agent 的定位

Master Agent 不是全能 AI。

它是：

> **受作用域限制的字段级资料处理 Agent。**

一个 Master Agent Task 通常只处理：

```text
master_item_id
+
field_path
```

不能随意跳到别的资产。

---

# 28. 当前 Agent 模型

当前 Master Agent 使用统一 Tool Agent 模型配置。

生产配置目前为：

```text
profile: qwen25-local
model: qwen2.5:7b
endpoint: http://127.0.0.1:11434/v1
```

模型通过统一 `ResolveAgentModel()` 配置解析，不在 Master Agent 中硬编码。

---

# 29. 为什么 Qwen2.5 7B 能工作

Narraverse 并没有要求 7B 模型：

> 自己理解整个项目然后随便修改。

而是给它非常明确的环境：

```text
这是 Asset
这是 Field
这是 Pipeline
这是 Translation
这是允许使用的工具
这是 Proposal Schema
```

这显著降低了模型自主规划的难度。

因此，本地小模型在：

> **边界清晰 + 工具受控 + Schema 明确**

的任务中已经能够完成真实 Recovery。

---

# 30. Master Agent Tools

当前 Master Agent 拥有八个受控工具：

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

Master Agent 没有：

- Shell；
- 普通文件写入；
- 普通 Lore 写入；
- 任意网络能力；
- Agent 配置修改能力。



---

# 31. Proposal

Agent 不直接修改 Master Field。

首先生成：

```text
MasterProposal
```

Proposal 包含：

- 目标 Asset；
- Field；
- Current Content；
- Candidate Content；
- Input Revision；
- Source SHA；
- Base Translation Version；
- Risk；
- Reason；
- 来源 Agent。

这使 AI 修改变得：

```text
可查看
可校验
可拒绝
可审计
```

---

# 32. CAS

CAS 是 Master 写入安全的重要基础。

在 Apply 之前系统会验证：

```text
input_revision
source_sha256
base_translation_version
```

如果 Proposal 是基于旧内容生成，而当前字段已经变化：

```text
Proposal
→ conflict
```

而不是覆盖新内容。



---

# 33. 高风险字段

以下类型的内容不应该让自动 Agent 随意修改：

```text
system_prompt
post_history_instructions
脚本
regex
运行控制字段
```

因此：

```text
低风险 Recovery
→ 可以自动 Apply
```

但：

```text
高风险
→ needs_user
```

这是安全边界，不是错误。

---

# 34. Polish Candidate

用户主动精修时，Agent 的输出首先成为：

```text
polish_candidate
```

不会立即取代：

```text
active translation
```

只有确认后才成为新的 active / polished version。

因此：

```text
AI 建议
```

和：

```text
当前生效内容
```

始终是分开的。

---

# 35. Recovery Orchestrator

Recovery 是 Narraverse 1.0 中最重要的自动化之一。

当翻译失败后：

```text
8097 failed
→ Runtime
→ Recovery Claim
→ Master Agent
→ Proposal
→ Validate
→ CAS
→ Apply
→ New Translation Version
→ Pipeline Recheck
→ recovered
```

这条链已经进行过真实生产 E2E。

---

# 36. Recovery Claim

Recovery Claim 用于解决：

> watcher 反复看到同一个失败，会不会反复启动 Agent？

Claim Key 基于：

```text
master_item_id
+
field_path
+
input_revision
+
source_sha256
```

因此同一个失败身份只处理一次。

应用重启以后 Claim 仍然存在。

---

# 37. needs_user

系统最终的异常处理顺序应该是：

```text
自动处理
→ Retry
→ Recovery
→ Agent
→ needs_user
```

用户是最后一级。

只有：

- 高风险；
- CAS conflict；
- Proposal 无法合法生成；
- 自动恢复无法安全完成；
- 需要人为判断；

才应该让用户介入。

---

# 38. 当前 Recovery 的技术债

目前 8097 还没有正式提供：

```text
terminal_failure
retry_exhausted
max_retries
next_retry
```

因此 Denova 暂时使用：

```text
status = failed
attempts >= 1
queue 未暂停
failed 稳定 ≥ 5 秒
```

来近似判断最终失败。

这已经可工作，但不是长期最理想的协议。

---

# 39. Adventure Instance

用户点击：

```text
加入当前冒险
```

以后，系统执行：

```text
Master Asset
→ PrepareAssetInstantiation
→ Adventure Import Transaction
→ FinalizeMasterImport
→ Adventure Lore
```



---

# 40. Master 粒度和 Adventure 粒度不同

Master 中：

```text
Aiko
```

是一项资产。

Adventure 中可以展开：

```text
Aiko Character Lore
Aiko Worldbook Entry 1
Aiko Worldbook Entry 2
Aiko Worldbook Entry 3
```

因此：

> **Master 存储粒度不等于 Runtime Lore 粒度。**

这是正确设计，而不是数据重复。

---

# 41. Nested Entry 到 Adventure Lore

Instance Ref 会保存：

```text
entry_id
→ adventure_lore_id
```

映射。

因此未来系统仍然知道：

> Adventure 中这条 Lore 是由 Master 哪个内部 Entry 生成的。

---

# 42. 实例化幂等

同一个：

```text
Master Asset
+
Adventure
```

重复执行：

```text
加入当前冒险
```

不会重复创建第二套 Lore。

当前实例化逻辑具有幂等检查。

---

# 43. Master 不自动更新已有 Adventure

如果：

```text
Master Aiko v2
```

出现：

```text
新翻译
新字段
新 revision
```

现有 Adventure 中的 Aiko 不会被静默覆盖。

这是故意的。

因为 Adventure 已经拥有自己的运行状态。

---

# 44. 总资料库 UI

当前总资料库已经不再只是只读实验页面。

它拥有：

- 资产列表；
- 搜索；
- 筛选；
- 分页；
- 完整内容；
- 七节点；
- Runtime；
- Translation Version；
- Adventure Usage；
- Master Import；
- 加入 Adventure；
- Agent；
- Proposal；
- 受控编辑；
- needs_user。



---

# 45. 完整角色阅读

角色详情目前以阅读体验为优先。

不是直接把 JSON 打印出来。

主要分组包括：

```text
角色概览
性格背景
场景开场
示例对白
内部设定
高级指令
```

Lorebook 则拥有 Entry 目录、关键词和正文阅读。

---

# 46. 总库导入和 Adventure 导入必须区分

用户界面必须保持两个概念：

```text
导入到总资料库
```

和：

```text
加入当前冒险
```

前者：

```text
文件
→ Master
```

后者：

```text
Master
→ Instance
→ Adventure Lore
```

绝不能重新混合。

---

# 47. 当前主要 API

Master 主要接口包括：

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



---

# 48. Adventure 素材接口

现有 Adventure 侧还保留：

```text
POST /api/workspace/import-material/preview
POST /api/workspace/import-material
POST /api/workspace/import-material/master/translation
POST /api/workspace/import-material/master/finalize
```

其中旧的直接导入能力仍然存在，但不是新的总资料库推荐路径。

---

# 49. 主要代码模块

当前最重要的代码职责可以概括为：

## Master Storage

```text
internal/book/master_library.go
```

负责：

- Manifest；
- Source；
- Revision；
- Master Item；
- Field；
- Translation Version；
- Import Transaction；
- CAS Translation 写回。

## Master Query

```text
internal/book/master_library_query.go
```

负责：

- List；
- Detail；
- Pipeline；
- Translation View。

## Material Import

```text
internal/book/material_import.go
```

负责：

- Preview；
- Character / Lorebook 导入；
- Master-only；
- Adventure Projection。

## Character Parser

```text
internal/book/character_card.go
```

负责 Tavern / PNG / JSON 角色卡解析。

## Runtime

```text
internal/book/master_runtime.go
```

负责 Master 与 8097 字段状态聚合。

## Agent / Proposal

```text
internal/book/master_agent.go
```

负责 Proposal / Validate / Apply / CAS。

## Recovery

```text
internal/book/master_recovery.go
internal/app/master_recovery.go
```

负责 Recovery Claim 和 Orchestrator。

## Agent Tools

```text
internal/agent/master_agent_tools.go
```

负责八个 Master Agent 工具。

完整核心文件地图已经在 1.0 Implementation Facts 中核验。

---

# 50. 数据真相原则

Narraverse 1.0 中存在多个不同层面的“真相”。

## 来源真相

```text
Original Source
```

回答：

> 原文件本来是什么？

## Master 当前真相

```text
Active Master Version
```

回答：

> 新 Adventure 当前应该使用哪个模板版本？

## Adventure Runtime 真相

```text
Adventure Instance
```

回答：

> 这个具体 Adventure 现在到底是什么状态？

三者不能互相替代。

---

# 51. 为什么不能直接覆盖

如果翻译直接覆盖原文件：

```text
来源丢失
```

如果 Master 自动覆盖 Adventure：

```text
故事状态可能被破坏
```

如果 Adventure 自动回写 Master：

```text
某一本故事的变化会污染所有未来 Adventure
```

所以 1.0 的隔离不是复杂化，而是为了避免长期数据混乱。

---

# 52. 1.0 当前已完成能力

以下能力可以视为当前正式能力：

```text
Master Library
Source / Revision
一文件一 Master Asset
Nested Entry
整卡阅读
Master-only Import
HY-MT / 8097
Translation Version
字段级 Runtime
七节点
Pipeline usable / staging
字段 Retry
Master Agent
Proposal
Validate
CAS
Apply
Polish Candidate
Recovery Claim
Recovery Orchestrator
needs_user
Adventure Instance
Nested Entry Runtime 展开
Usage
实例化幂等
生产 Web UI
```

---

# 53. CURRENT / PARTIAL / LEGACY / NOT IMPLEMENTED

为了防止以后 AI 把历史计划误认为当前功能，统一使用四种状态。

## CURRENT

真实生产代码存在，并有部署或运行记录。

## PARTIAL

已经实现，但能力或数据模型还不完整。

## LEGACY

旧功能仍然存在，用于兼容，但不是当前推荐路线。

## NOT IMPLEMENTED

历史上讨论过，但当前代码没有完成。

这套状态定义来自当前 Implementation Facts 的正式核验规则。

---

# 54. 当前 PARTIAL

主要包括：

- 8097 正式 terminal failure 协议；
- parse / normalize / check 独立 Snapshot；
- Issue 独立领域实体；
- Usage 独立领域实体；
- 全量 Go 测试全绿；
- 部分高风险 Candidate 完整真实 E2E；
- 大规模 Master 搜索索引。



---

# 55. 当前 LEGACY

主要包括：

```text
unmanaged_direct
```

以及：

```text
worldbook_entry
```

旧兼容结构。

这些代码可能仍然存在，但不能让新的功能重新以它们为核心设计。

---

# 56. 当前明确没有实现的能力

以下内容不能描述为 1.0 已完成：

- Normalize Agent；
- Unknown Field Agent；
- 独立 Check Agent；
- 全库 Agent；
- 批量 Agent；
- 全资料默认 Agent 二次翻译；
- Master Revision 自动同步 Adventure；
- Entry 级总库实例化选择器；
- 批量跨资产实例化；
- 8097 正式 terminal-failure 协议；
- 完整字段级 Dependency Graph；
- Translation Version Merge UI；
- 通用 JSON Patch Editor；
- Master 原文件直接回写；
- 完整 Proposal / Recovery 审计工作台。



---

# 57. 当前最主要技术债

## 57.1 8097 失败终态

长期应该由 8097 明确告诉 Denova：

```text
retry_exhausted
```

或者：

```text
terminal_failure
```

而不是由 Denova 猜。

---

## 57.2 Pipeline 中部分节点仍是推导状态

Parse / Normalize / Check 目前没有完整独立 Snapshot。

当前已经够用于用户展示，但不是最终领域模型。

---

## 57.3 Legacy 代码

`unmanaged_direct` 和旧 `worldbook_entry` 仍增加代码理解成本。

在没有明确收益时，不需要立刻删除。

---

## 57.4 全量 Go Test

当前 Master 定向测试和 Build 已经有较完整记录，但历史全量测试仍存在 Windows：

- Symlink；
- Permission；
- Path；
- Atomic Replace；

等边缘失败。



---

# 58. 1.0 的开发原则

后续开发应优先遵守以下原则。

---

## 原则一：先查现有能力

开发新功能之前：

```text
先查代码
→ 再查当前设计
→ 必要时查成熟方案
→ 最后才新增
```

不要重复造已有功能。

---

## 原则二：后台复杂，前台简单

后台可以拥有：

```text
revision
SHA
CAS
task id
claim
worker
runtime
```

但普通用户界面应该尽量说人话。

---

## 原则三：用户是最后一级异常处理者

优先：

```text
自动处理
→ Agent
→ 用户
```

而不是：

```text
一出错
→ 弹技术错误
→ 让用户自己解决
```

---

## 原则四：Agent 没有越权理由

模型更聪明并不意味着应该给更多权限。

Agent 的能力应通过：

```text
Tools
Scope
Proposal
CAS
Risk
```

控制。

---

## 原则五：不要为了小模型破坏安全规则

如果某个模型不能正确生成 Proposal：

不要：

```text
放宽 Schema
关闭 CAS
打开 file_write
```

应该：

```text
改善 Prompt
缩小 Scope
改善 Tool
或者换模型
```

---

## 原则六：Master 与 Adventure 永远保持边界

Master：

```text
Template
```

Adventure：

```text
Runtime Instance
```

任何未来自动同步功能都必须显式设计，不得偷偷覆盖。

---

## 原则七：用户粒度和处理粒度可以不同

总库里：

```text
一个角色卡
```

内部可以拥有：

```text
100 个翻译目标
```

不要因为内部需要字段级处理，就把 UI 再拆成 100 个资产。

---

# 59. 新 AI 接手项目时应该先理解什么

一个新的 AI 或 Codex 接手 Narraverse 时，不应该第一步就开始修改代码。

建议阅读顺序：

```text
1. 本 Narraverse / Denova 1.0 文档
2. Narraverse-Denova-1.0-Implementation-Facts.md
3. CODE_GUIDE.md
4. COLLABORATION_LOG.md
5. 当前相关模块源码
```

但必须注意：

> 历史文档只能作为导航。

如果和代码冲突：

```text
当前生产代码
>
Implementation Facts
>
当前 1.0 总文档
>
旧设计文档
```

其中“代码”负责事实真值，“1.0 总文档”负责解释系统意图和架构边界。

---

# 60. AI 接手任务时的推荐方式

不要要求 AI：

```text
先读整个仓库
```

应该告诉它：

```text
这是问题
这是涉及模块
这是 1.0 架构约束
先搜索相关代码
再定点阅读
```

只有确实需要时才扩展阅读范围。

---

# 61. 修改 Master 时必须检查什么

任何涉及 Master 的改动，都应至少考虑：

```text
Source
Revision
master_item_id
field_path
Translation Version
CAS
Adventure Instance
Legacy Data
```

不能只看当前 UI。

---

# 62. 修改 Agent 时必须检查什么

至少确认：

```text
Tool Scope
Capability
Proposal
Validate
CAS
Risk
Apply
needs_user
```

尤其不能为了方便打开普通：

```text
file_write
```

给 Master Agent。

---

# 63. 修改 Translation 时必须检查什么

需要确认：

- Placeholder；
- Number；
- URL；
- Script；
- Regex；
- Markdown；
- JSON；
- Control Field；
- Source Revision；
- Base Translation Version。

翻译完成不只是：

> 模型返回了一段中文。

还需要：

> 输出仍然可以安全成为资料内容。

---

# 64. 修改 Adventure 实例化时必须检查什么

至少检查：

```text
Master Asset
Adventure Key
Instance Ref
generated_lore_ids
nested_entry_lore_ids
loaded revision
幂等
```

不能因为重新点击一次按钮就生成重复 Lore。

---

# 65. 1.0 后的发展方向

1.0 之后不应该马上重新大规模设计系统。

更合理的是先实际使用。

重点观察：

```text
哪些字段翻译最容易出问题
哪些 Agent 任务最容易失败
哪些状态用户看不懂
哪些角色页不好读
哪些 Lorebook 太难浏览
needs_user 是否太频繁
大资产是否影响性能
```

真实问题比新的架构设想更有价值。

---

# 66. 可能的 1.x 优先方向

如果真实使用证明有需要，可以逐步考虑：

## 8097 正式终态协议

```text
terminal_failure
retry_exhausted
next_retry
```

## 更完整的高风险 Candidate 流程

让：

```text
Candidate
→ Risk Block
→ User Review
```

拥有更完整的真实生产路径。

## Master 搜索增强

资产规模明显扩大以后，再考虑独立搜索索引。

## Adventure 更新辅助

未来可以提供：

```text
Master 有新版本
→ 提示
→ 用户选择是否更新 Instance
```

但不能自动覆盖。

---

# 67. 不建议近期优先做的东西

除非出现真实需求，不建议立即开发：

```text
全库 Agent
复杂知识图谱
自动多 Agent 协作
Master 自动同步所有 Adventure
复杂 Translation Merge
任意 JSON 编辑器
过度细化 Pipeline
```

Narraverse 1.0 当前最重要的任务已经从：

> 架构能不能成立

转变为：

> 日常使用体验到底好不好。

---

# 68. 1.0 的完成定义

Narraverse / Denova 1.0 可以概括为：

```text
导入角色卡 / Lorebook
↓
保存原件与 Revision
↓
创建整卡 Master Asset
↓
字段级解析与翻译
↓
8097 执行初译
↓
Translation Version
↓
Pipeline / 七节点
↓
失败时自动 Retry / Recovery
↓
Qwen Master Agent
↓
Proposal / Validate / CAS / Apply
↓
usable
↓
用户浏览完整资料
↓
用户明确加入 Adventure
↓
Adventure Instance / Lore
```

其中：

```text
原件不被覆盖
Master 不被 Adventure 污染
Adventure 不被 Master 静默覆盖
Agent 不拥有任意写权限
历史 Translation Version 不丢失
高风险修改需要用户参与
```

这些规则共同构成 Narraverse / Denova 1.0 的基础边界。

---

# 69. 一句话总结

Narraverse / Denova 1.0 已经从最初的：

> **把角色卡加载进一个 AI 互动故事**

发展成：

> **一个以总资料库为中心，将原始角色与世界设定进行归档、翻译、版本化、AI 辅助维护，并安全实例化到不同 Adventure 中使用的本地 AI 资料与互动运行平台。**

Master Library 负责长期知识资产。

HY-MT / 8097 负责大量翻译工作。

Denova Agent 负责困难字段、异常恢复和受控精修。

Proposal / CAS / Risk Rule 负责约束 AI。

Adventure Instance 负责真正的故事运行。

用户负责：

> **决定什么资料值得保存、什么修改值得接受，以及什么时候把它带进自己的世界。**

这就是 Narraverse / Denova 1.0。