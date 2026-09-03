# Narraverse / Denova 1.0

## 项目总览与系统说明

**文档用途**：帮助第一次接触项目的人或 AI 理解 Narraverse / Denova 1.0 的定位、用户流程、系统关系、当前能力与维护边界。

**基线日期**：2026-08-30

**事实原则**：本文是面向理解和使用的总览，不替代实现事实底稿。涉及当前行为时，以生产源码为第一依据，其次参考《Narraverse-Denova-1.0-Implementation-Facts》和已冻结的 1.0 架构维护基线。

**三份 1.0 文档的分工**：

- 本文：解释项目是什么、用户如何使用、系统为什么这样协作，以及新人如何建立整体理解。
- `叙界-Denova-1.0-主文档.md`：说明架构边界、维护规则和设计原则。
- `叙界-Denova-1.0-实现事实.md`：记录当前生产代码事实，并明确 `CURRENT / PARTIAL / LEGACY / NOT IMPLEMENTED` 状态。

---

# 1. 项目是什么

Narraverse / Denova 是一个本地运行的 AI 资料与互动叙事平台。

它可以让用户把角色卡、世界设定和 Lorebook 导入系统，保留原件，自动完成中文翻译和资料整理，再把整理好的资料加入不同的 Adventure（冒险/故事工作区）中使用。

用一句话概括：

> Narraverse / Denova 先把外部资料变成可长期维护的资产，再把资产按需要放入具体冒险中运行。

这里的“资产”不只是一个能马上加载的 JSON 文件，而是包含原件、来源版本、结构化字段、翻译版本、处理状态和使用记录的一份长期资料。

## 1.1 Narraverse 与 Denova 分别是什么

可以把两者理解成同一套本地系统中的两个侧面：

- **Narraverse** 更接近互动故事和叙事体验：用户在其中进行角色对话、推进剧情、使用世界设定。
- **Denova** 是承载工作台、资料处理和后端能力的宿主：它负责资料导入、总资料库、翻译队列、版本管理、受控 Agent 和 Adventure 工作区。

Denova 的 Web 界面提供资料库、导入、处理进度、内容阅读、版本和 Agent 操作；Narraverse 的互动运行部分消费已经加入当前 Adventure 的资料实例。

## 1.2 为什么它不再只是“AI 文字冒险”

早期的核心问题可以简单描述为“把角色卡加载进 AI 对话”。但当角色卡越来越多、原始资料语言越来越复杂、同一角色要被多个冒险复用时，仅把文件直接塞入一次对话会带来一系列问题：原文容易丢失，翻译容易覆盖，Adventure 的临时改动容易污染模板，失败任务也难以追踪。

1.0 因此把项目的重心扩展为：

```text
外部资料
→ 可追溯的总库资产
→ 字段级翻译与处理
→ 受控维护
→ 独立的 Adventure 实例
→ 互动叙事运行
```

用户仍然可以快速开始冒险，但系统不会把“原件、标准资料和某一次冒险的运行状态”混成一个文件。

## 1.3 设计演进的简要结论

项目经历过几次重要调整，当前 1.0 只采用最终已经落地的规则：

1. 早期方案重点是把 Narraverse 与 Denova 统一到一个本地工作平台，并复用已有的角色卡、Lorebook 和互动故事能力。
2. 早期总库设计曾倾向于把一本设定书拆成多个独立 Master 条目。
3. 后续方案确认用户理解的资产应是“整张角色卡”或“整本 Lorebook”，于是改为一个文件对应一个顶层 Master Asset，内部 Entry 仍保留稳定身份，但不再作为总库列表中的独立资产。
4. 翻译流程也从只处理名称/简介，发展为以 HY-MT 全量处理安全自然语言字段、Translation Version 保存结果、Agent 处理困难字段的分工。
5. 资料库界面最初是只读查询，后续增加了受控重试、润色候选、Proposal 和字段编辑；当前仍然禁止绕过安全流程直接任意写文件。

因此，历史文档中的“独立 worldbook_entry 总库资产”“总库只读”“尚未有 Master 实例链”等说法不能直接当作 1.0 当前行为。

---

# 2. 项目现在解决什么问题

Narraverse / Denova 1.0 主要解决的是资料长期使用时的混乱，而不只是一次导入是否成功。

## 2.1 原件与译文容易互相覆盖

外部角色卡和世界设定可能是英文、混合语言或复杂 JSON。系统需要翻译，但翻译结果不应该替代原件。

因此 1.0 把原始文件归档保存，把翻译结果作为独立版本保存。用户可以使用中文工作版，也可以回看原文和历史翻译。

## 2.2 角色卡内部结构复杂

一张角色卡可能包含：

- 角色基本信息；
- 场景、性格、背景和开场白；
- 示例对白；
- 创作者说明；
- 系统提示和对话后指令；
- 内嵌 Worldbook；
- 多条带关键词、正文、分组和运行规则的 Entry。

1.0 不再把这些内容粗暴压成一个不可维护的大段文本，而是保存整卡结构，同时给字段和内部 Entry 稳定路径。

## 2.3 同一资料需要服务多个 Adventure

一张角色卡可能被多个故事使用。每个故事又可能有不同的记忆、关系、位置、成长和临时修改。

Master Library 解决“可复用标准资料”的问题；Adventure Instance 解决“某个故事当前实际使用的副本”的问题。这样一张卡可以复用，但不同冒险不会互相污染。

## 2.4 AI 可以帮忙，但不能随意改资料

翻译失败、术语不一致和重要字段润色很适合交给 Agent；但 Agent 的输出可能不完整、理解有歧义，或者涉及会改变角色行为的高风险字段。

因此 Agent 不能直接写原件或任意写文件。它必须提出 Proposal，由系统检查目标、版本和风险，再决定是自动应用、保存为候选，还是交给用户确认。

## 2.5 用户不应该被后台技术细节淹没

8097、任务队列、worker、CAS 和模型请求都有真实的后台状态，但普通用户通常无法通过阅读 `timeout` 或 `revision mismatch` 解决问题。

前台默认只告诉用户：

```text
正在处理
已完成
部分未完成
需要你处理
```

底层字段状态、失败原因、输入版本和任务 ID 仍然保留给自动恢复、Agent、调试和高级诊断使用。

## 2.6 新 AI 不应每次从零考古整个仓库

项目已经积累了大量阶段方案、实施记录和旧设计。如果新 AI 不区分当前实现和历史规划，就容易把被替代的方案重新实现一遍。

1.0 通过三份职责不同的基线文档，以及本文最后的接手指南，降低重复考古成本。

---

# 3. 用户实际怎么使用

下面用一张名为 **Aiko** 的角色卡说明完整旅程。用户不需要先理解 Master、CAS 或文件 manifest 才能使用，但理解这条旅程有助于知道每个页面的作用。

## 3.1 导入到总资料库

1. 用户拿到 `Aiko.json` 或带角色卡数据的 PNG 文件。
2. 在 Denova 打开“总资料库”，点击“导入到总资料库”。
3. 系统先显示预览：文件类型、角色名称、内部设定数量和可能的提示。
4. 用户确认后，系统保存原始文件，并建立一个名为 Aiko 的顶层 Master Asset。
5. Aiko 卡内的角色字段和 Worldbook Entry 被保存到同一个资产内部；Entry 不会变成总库列表中的一排小资产。
6. 顶层名称进入中文名称翻译。翻译完成前，页面会显示“待翻译 · Aiko”，不会把原名伪装成已经完成的中文名称。
7. HY-MT/8097 开始处理需要翻译的字段。用户可以离开页面，后台继续处理。

此按钮只负责把资料纳入总库：

```text
保存原件
→ 建立 Master Asset
→ 建立字段和内部 Entry
→ 创建翻译目标
→ 进入处理流程
```

它不会自动把 Aiko 写入当前 Adventure，也不会凭空生成 Adventure Lore。

## 3.2 查看整张卡

用户点击总库里的 Aiko，进入资产详情页。详情页优先展示完整内容，而不是一堆内部 ID：

- 角色概览、性格和背景；
- 场景和开场白；
- 示例对白；
- 内部 Worldbook；
- 每个 Entry 的标题、关键词和正文；
- 当前中文工作版与必要的原文信息。

角色卡是一个可阅读的整体。内部 Entry 有自己的稳定身份和处理状态，但不会破坏用户对“一张卡”的理解。

## 3.3 查看处理进度

在详情页的“处理进度”中，用户可以看到七个节点：

```text
原件 → 解析 → 规范化 → 翻译 → 检查 → 可用 → 加入冒险
```

例如翻译节点会显示：

```text
翻译中 5 / 7
```

或者：

```text
翻译完成
```

如果系统确实无法继续，才显示“需要你处理”。字段级后台细节默认折叠。

## 3.4 处理失败或需要 Agent

如果一个普通安全字段翻译失败，系统先等待 8097 的自动重试，并由 Recovery Orchestrator 判断是否需要继续恢复。

在可以安全处理的情况下，Denova Agent 会读取当前资产、字段、原文和翻译状态，提出一个恢复 Proposal。系统验证后可以生成新 Translation Version 并激活它。

如果涉及高风险字段、版本已经变化、Proposal 不唯一或无法安全判断，流程会停在“需要你处理”。这时用户看到的是产品化提示和可操作的确认/查看入口，而不是一长串后台日志。

## 3.5 资产变为“可用”

当必需字段已经有可用的活动内容，且没有阻止使用的处理问题，资产的状态变为“可用”（内部值为 `usable`）。

如果顶层名称或其他必需字段还没有完成，资产保持“处理中”（内部常对应 `staging`）。

内部 Entry 默认是可选字段；单个非关键 Entry 的失败通常形成警告或恢复任务，不会让整张卡永久不可用。

## 3.6 加入当前 Adventure

用户在资产详情页点击“加入当前冒险”，或者在 Adventure 的“加载资料”窗口打开“总资料库”页签，选择已经“可用”的 Aiko。

这时才发生另一条操作：

```text
Aiko Master Asset
→ 创建当前 Adventure 的 Instance
→ 生成 Character Lore
→ 展开内部 Worldbook Entry 为多个 Adventure Lore
```

同一张卡可以加入多个 Adventure。重复点击同一个 Master Asset 加入同一个 Adventure 不会产生一套重复 Lore。

## 3.7 Adventure 中的变化

Aiko 在某个 Adventure 中产生的记忆、关系、成长、位置和剧情变化，只属于这个 Adventure。

它们不会自动写回 Aiko 的 Master Asset。Master 后来有新版本，也不会静默覆盖已经运行中的 Adventure Instance。

---

# 4. 整体系统架构

从产品视角看，系统由资料来源、处理平台、总库、翻译、Agent 和冒险运行时组成。

## 4.1 组件关系

```text
┌────────────────────────────────────────────────────────────┐
│ 用户                                                       │
└───────────────┬────────────────────────────────────────────┘
                │
        ┌───────▼────────┐          ┌───────────────────────┐
        │ Narraverse      │          │ Denova Web UI         │
        │ 互动故事体验     │◄────────►│ 资料库 / 工作台        │
        └───────┬────────┘          └───────────┬───────────┘
                │                               │
        ┌───────▼────────┐          ┌───────────▼───────────┐
        │ Adventure       │          │ Master Library         │
        │ 当前故事实例     │◄────────►│ 原件 / 字段 / 版本      │
        └───────┬────────┘          └───────────┬───────────┘
                │                               │
        ┌───────▼────────┐          ┌───────────▼───────────┐
        │ Adventure Lore  │          │ HY-MT / 8097           │
        │ 运行时资料       │          │ 翻译队列与执行          │
        └────────────────┘          └───────────┬───────────┘
                                                │
                                      ┌─────────▼─────────┐
                                      │ Denova Agent       │
                                      │ 恢复 / 校对 / 提案  │
                                      └─────────┬─────────┘
                                                │
                                      ┌─────────▼─────────┐
                                      │ Ollama / 模型配置  │
                                      └───────────────────┘
```

## 4.2 各组件的真实职责

| 组件 | 主要职责 | 不负责什么 |
|---|---|---|
| Narraverse | 互动故事和叙事体验 | 不作为 Master 原件的唯一保存处 |
| Denova | 本地宿主、后端服务、工作台和流程编排 | 不把 Adventure 运行状态自动当成总库标准 |
| Master Library | 保存跨 Adventure 复用的原件谱系、结构化资产、翻译版本和使用关系 | 不保存某次冒险的全部记忆和剧情状态 |
| HY-MT / 8097 | 执行字段级机器初译、队列、重试和运行状态 | 不决定 Master 是否安全应用 Agent 修改 |
| Denova Agent | 在限定范围内读取、分析、提出候选和恢复方案 | 不拥有任意文件系统写权限 |
| Adventure | 保存具体故事中的实例、Lore 和运行变化 | 不自动反向覆盖 Master |
| Ollama | 提供当前本地 Agent 模型调用 | 不替代 Denova 的权限和版本校验 |

## 4.3 设计演进对当前架构的影响

8 月 11 日至 15 日左右的材料主要讨论 Narraverse 与 Denova 的统一平台、第三模式、桥接和既有设定同步；8 月 26 日开始，项目把重点推进到持久化翻译队列和资料库；8 月 27 日的 Master 设计仍保留了“拆成多个正式条目”的历史倾向；8 月 28 日批准的流水线规格最终确认了整卡化、总库优先导入和 Adventure 实例化隔离；8 月 29 日至 30 日又完成了 Recovery、受控 Agent 和前端操作层。

所以当前架构是“平台整合历史”和“总库流水线后续落地”的合流结果，不能只按最早的平台规划或最早的 Master 设计理解。

---

# 5. 四层资料模型

1.0 把一份资料分成四个相互关联但职责不同的层次。

```text
┌──────────────────────┐
│ 1. 原文件层           │  来源真相：用户拿到的文件和原始字节
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ 2. 处理 / 翻译层      │  解析字段、翻译任务、译文版本、恢复结果
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ 3. Master Library     │  跨 Adventure 复用的标准资产和活动版本
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ 4. Adventure Instance │  某个 Adventure 实际加载的独立副本
└──────────────────────┘
```

## 5.1 原文件层：来源真相

系统保存原始文件、来源 ID、来源 revision、SHA-256、大小、导入时间和归档路径。

原件的作用是让后续解析、翻译、Agent 校对和版本冲突都有依据。原件不会因为中文翻译完成而被替换。

## 5.2 处理 / 翻译层：可追溯的派生结果

解析出的字段、机器译文、Agent 候选和历史结果都属于处理层。它们可以失败、重试、产生多个版本，但不与原件竞争“谁是真相”。

Translation Queue 的任务是一次执行；Translation Version 是成功保存的一个内容版本。两者不能混为一谈。

## 5.3 Master Library：标准真相

Master Asset 是用户可浏览、可翻译、可维护和可被多个 Adventure 使用的标准资料。

它保存整张角色卡或整本 Lorebook 的结构化表示，包含活动中文工作版和对原件的追溯关系。

## 5.4 Adventure Instance：当前故事真相

一个 Master Asset 加入某个 Adventure 后，会形成一个 Instance，并投影成当前 Adventure 可以使用的 Lore。

Instance 可以有自己的运行状态和本地变化。它不是 Master 的另一份“错误副本”，而是为了故事运行而产生的独立层。

## 5.5 三种真相的边界

可以用下面的规则判断一项信息应该放在哪里：

| 信息 | 所属层 | 是否回写 Master |
|---|---|---|
| 用户拿到的原始角色卡 | 原文件层 | 不适用，原件保留 |
| 中文字段和历史译文 | 处理层 / Master | 通过版本与受控应用更新 |
| 角色模板和世界知识 | Master Library | 是，受控更新 |
| 某冒险中的关系、伤势、位置、剧情 | Adventure Instance | 否，默认不自动回写 |

---

# 6. 总资料库

Master Library 是整个 1.0 的核心资料层。

## 6.1 总库保存什么

总库保存：

- 原始角色卡或 Lorebook 文件及来源谱系；
- 一个文件对应的顶层 Master Asset；
- 角色字段或 Lorebook 字段；
- 内嵌 Worldbook/Lorebook Entry；
- 字段级翻译版本和活动内容版本；
- 处理状态、问题摘要和恢复关系；
- 哪些 Adventure 已经创建了实例。

## 6.2 总库不保存什么

总库不把以下内容当作标准资产内容：

- 某一次 Adventure 的聊天记忆；
- 关系、成长、伤势、位置和剧情经历；
- 当前故事临时生成的状态；
- 仅属于 Adventure 的 Lore 运行投影；
- 8097 队列的完整状态副本。

8097 的任务状态可以被查询层聚合到总库详情中，但不会因此成为 Master 的第二套状态真源。

## 6.3 “整卡”是用户看到的资产粒度

当前正式规则是：

```text
一个角色卡文件 = 一个 character_template Master Asset
一个独立 Lorebook 文件 = 一个 lorebook_template Master Asset
```

这让总库列表显示的是：

```text
Aiko
Skyrim Worldbook
Cyberpunk Locations
```

而不是把 Aiko 的每一条内部设定单独列成几十个资产。

## 6.4 staging 与 usable

页面把 `staging` 翻译为“处理中”，把 `usable` 翻译为“可用”。

- **处理中（staging）**：资产仍缺少必需字段的有效活动内容，或者有阻止使用的问题。
- **可用（usable）**：满足当前使用所需的必需字段和处理条件，可以被加入 Adventure。

当前 `usable / staging` 推导已经可用；解析、规范化、检查的一部分节点状态仍依赖现有数据推导，因此这些节点属于部分实现，不应理解为每一步都有独立持久化快照。

## 6.5 顶层名称必须中文化

角色卡的 `character.name`、独立 Lorebook 的 `lorebook.name` 都属于必需字段，并进入中文名称翻译。

列表和详情优先显示活动中文名称。名称未完成时显示“待翻译 · 原名称”，而不是假装原名已经是中文工作名。

---

# 7. Character Card / Lorebook

## 7.1 支持的主要来源

当前导入器主要面向：

- Tavern/SillyTavern 风格 JSON 角色卡；
- 包含角色卡数据的 PNG；
- 独立 Lorebook/设定书文件。

系统先预览和解析，再建立 Master 输入。对于格式不完整或存在截断提示的文件，预览会给出提示，必要时要求用户明确接受不完整导入。

## 7.2 角色卡的内部组成

角色卡在 Master 中保留角色字段，例如名称、简介、性格、场景、开场白、示例对白、创作者说明和扩展信息。

`system_prompt`、`post_history_instructions` 等可能影响模型行为的字段按高风险控制处理，不会因为普通翻译任务完成就被随意替换。

## 7.3 内嵌 Worldbook

内嵌 `character_book` 仍保留在父角色卡内部：

```text
Character Master Asset
├─ character fields
└─ character_book
   ├─ nested entry A
   ├─ nested entry B
   └─ nested entry C
```

这些 Entry：

- 不出现在 Master Library 顶层列表；
- 不单独拥有新的活动 `master_item_id`；
- 保留 `entry_id` 和来源身份；
- 可以独立翻译、恢复、比较和定位；
- 实例化时可以展开成多个 Adventure Lore。

## 7.4 独立 Lorebook

独立 Lorebook 使用相同规则：

```text
Lorebook Master Asset
└─ entries
   ├─ nested entry A
   ├─ nested entry B
   └─ nested entry C
```

它在总库中是一个 `lorebook_template`，而不是每条 Entry 一个 Master 资产。

## 7.5 Nested Entry 的稳定身份

Entry 的长期身份不能依赖数组位置，因为用户可以在原文件中插入、删除或重新排序 Entry。

当前规则优先使用原文件中的 ID/UID 或来源记录身份；如果没有，则根据 comment/name、keys、secondary keys、group 等身份信息生成稳定哈希身份。字段路径使用类似：

```text
character_book.entries/<entry_id>/comment
character_book.entries/<entry_id>/content
character_book.entries/<entry_id>/keys

lorebook.entries/<entry_id>/comment
lorebook.entries/<entry_id>/content
lorebook.entries/<entry_id>/keys
```

当前实现已经不使用数组位置作为长期身份。完全没有身份字段时，生产代码使用可重复生成的哈希形式；“首次生成 UUID 并通过持久身份匹配”的更强方案仍属于部分缺口。

## 7.6 用户资产粒度与内部处理粒度

这是 1.0 的重要区分：

```text
用户看到：一张角色卡 / 一本设定书
系统处理：父资产 + 多个可定位字段和嵌套 Entry
Adventure 运行：角色 Lore + 多个 Worldbook Lore
```

这样既避免总库列表膨胀，又保留了字段级翻译、CAS、Diff、恢复和运行时展开的基础。

---

# 8. 翻译系统

翻译系统的目标不是把原文件覆盖成中文，而是给每个需要翻译的字段建立可追踪的中文版本。

## 8.1 HY-MT 负责大部分初译

导入后，系统为角色名称、描述、正文、开场白、Lorebook Entry 等自然语言字段建立 Translation Target。

当前分工是：

```text
HY-MT / 8097：大部分安全自然语言字段的全量初译
Denova Agent：困难字段、重要字段、失败恢复、用户主动润色
用户：高风险或存在歧义时做最终决定
```

Agent 不是默认对整张卡再翻译一遍的第二台机器翻译器。

## 8.2 8097 Translation Queue

8097 提供持久化、串行执行、暂停、重试、缓存和任务查询能力。Master 通过字段路径把翻译任务和具体资产关联起来。

一次队列任务有自己的 `job_id`，表示这次执行；成功保存的结果会形成独立的 `translation_version_id`。任务失败不一定产生 Translation Version，重试也可能产生新的任务和新的版本。

## 8.3 字段级目标

每个目标至少要能回答：

- 来自哪个 Source 和 source revision；
- 属于哪个 Master Asset；
- 具体字段路径是什么；
- 原文字段是什么；
- 当前输入 revision 和原文 SHA 是什么；
- 采用什么模式和应用策略；
- 是否为必需字段。

这使得一个内部 Entry 可以单独失败，而不需要把整张卡当成一块无法分析的大文本。

## 8.4 Translation Version

Translation Version 是可追溯的译文内容版本，保存原文依据、翻译结果、模型、任务关联、译文 SHA 和确认状态。

内容版本概念与任务运行状态分离：

```text
任务状态：queued / running / failed / completed / retrying
内容版本：hy_mt_active / polish_candidate / polished_active
```

当前活动指针可以指向机器初译，也可以在确认后指向润色版本。历史版本继续保留。

## 8.5 名称翻译与普通忠实翻译

顶层名称使用中文名称模式 `name_zh`，普通正文和自然语言字段使用忠实翻译模式 `faithful_zh`。

名称不是装饰字段：角色卡和 Lorebook 的顶层名称未完成时，资产不能进入“可用”状态。

## 8.6 失败、重试与错误显示

8097 的自动重试优先在后台完成。普通 UI 不默认显示 HTTP 错误、worker 错误、队列内部状态或完整 failure reason。

用户只有在系统不能自动继续，或者确实需要用户决定时，才看到“需要你处理”。调试层仍保留字段路径、任务状态、失败原因、输入 revision、模型和任务 ID。

---

# 9. 节点工作台

节点工作台是一个过程可视化界面，不是把后台日志全部摊给用户的诊断控制台。

## 9.1 七个节点

```text
1 原件
   文件已经保存并有来源、版本和哈希

2 解析
   系统是否读出了角色卡/Lorebook 的结构

3 规范化
   是否整理成当前 Master 能处理的字段和内部 Entry

4 翻译
   需要的字段是否已经有可用的中文内容

5 检查
   是否有阻止使用的问题、警告或需要复核的内容

6 可用
   是否达到可以加入 Adventure 的条件

7 加入冒险
   当前 Master 已经在哪些 Adventure 创建了实例
```

## 9.2 状态的用户表达

用户通常看到：

```text
✓ 已完成
● 正在处理
! 部分未完成
○ 尚未开始
需要你处理
```

翻译节点还会给出“翻译中 5 / 7”这样的进度。内部英文状态仍然存在，但主要用于查询层、恢复和诊断。

## 9.3 节点状态的事实边界

原件、翻译和使用关系有较明确的数据依据；解析、规范化、检查的一部分节点是从现有 Master、Source、Translation、Issue 等数据推导出来的。

因此页面可能标记某些节点为“由现有数据推导”。这不表示流程失效，而是提示当前 1.0 尚未为每个节点都建立独立的输出快照和 revision。

## 9.4 第七节点不是单值生命周期门

“加入冒险”与前六个处理节点不同：一个 Master Asset 可以被多个 Adventure 实例化。

所以第七节点显示的是 usage/instance 列表和数量，而不是简单的“已加入/未加入”单值。资产在第六节点“可用”时已经完成资料处理；第七节点是可重复执行的使用动作。

---

# 10. Denova Agent

Denova Agent 是受约束的资料辅助系统，不是拥有整个项目写权限的万能机器人。

## 10.1 当前 Agent 的主要角色

当前与总库直接相关的 Agent 能力主要有两类：

- **Master Recovery Agent**：处理翻译失败或需要修复的特定字段。
- **Config Manager Agent**：在资料库上下文中读取总库内容、原件和字段，并帮助用户形成或校验 Proposal。

未来可以增加更多专门 Agent，但规范化 Agent、未知字段 Agent、独立检查 Agent、全库 Agent 和批量 Agent 当前不应描述为已经完成。

## 10.2 模型配置

Master Agent 复用 Denova 现有 Tool Agent 配置，不拥有独立的模型配置体系。

当前工作区的 `tool_agent` 使用 `qwen25-local`，对应本地 Ollama 的 OpenAI-compatible endpoint 和 `qwen2.5:7b` 模型。模型是可配置的；以后切换配置时，Master Agent 应跟随有效 profile，而不是依赖硬编码。

## 10.3 Agent 能读取什么

在 Master 上下文中，Agent 可以读取：

- 当前 Master Asset；
- 指定字段；
- 当前 Pipeline 状态；
- 翻译状态和历史版本；
- 问题摘要；
- 原始来源文件和来源 revision（在 Config Manager 资源上下文中）。

## 10.4 Agent 能修改什么

Agent 不能直接改原文件，也不能随意改 Master。它能做的是：

```text
读取指定资产和字段
→ 生成字段级 Proposal
→ 请求 Validate
→ 由系统执行 CAS、风险和范围检查
→ 安全时 Apply，或保存为 Candidate
```

普通文件系统写入、Shell、任意 Lore 写入、网络、Skill 管理和 Agent 配置写入都不属于 Master Agent 的权限。

## 10.5 为什么不把所有工作交给 Agent

机器翻译适合稳定、重复、全量的初步处理；Agent 更适合带上下文的校对、纠错和少量重要字段处理。

如果让 Agent 默认重写所有内容，会增加成本和不确定性，也更容易把角色控制逻辑、变量、脚本或格式结构改坏。因此 1.0 将 Agent 放在“困难问题和受控修改”的位置。

---

# 11. Recovery 系统

Recovery 的目标是让系统尽可能自己恢复翻译问题，只在无法安全解决时打扰用户。

## 11.1 当前链路

```text
8097 任务失败
→ Master Runtime 发现字段异常
→ Recovery Orchestrator 判断是否达到恢复条件
→ 创建持久化 Recovery Claim
→ 启动受限 Master Agent
→ Agent 读取字段并提出 Recovery Proposal
→ Validate / CAS / 风险检查
→ 低风险时 Apply
→ 生成并激活新的 Translation Version
→ 重新读取 Pipeline
→ recovered 或 needs_user
```

## 11.2 Claim 的作用

Claim 是一个持久化的“这次失败已经有人处理”的声明，定位键包含：

```text
master_item_id
+ field_path
+ input_revision
+ source_sha256
```

同一个字段、同一个输入版本的失败被 watcher 多次扫描时，只能启动一次 Agent。应用重启后 Claim 仍然存在，系统不会因为内存丢失而重复启动。

当输入 revision 或原文 SHA 变化时，它会被视为新的问题，可以建立新的恢复 Claim。

## 11.3 用户看到什么

后台可能经历 `waiting_for_runtime`、`eligible`、`agent_running`、`proposal_ready`、`applying` 和 `revalidating`，但普通用户通常只看到：

```text
Denova 正在处理
翻译已完成
需要你处理
```

底层状态仍保存在 Claim、Runtime 和日志中，供后续 Agent、诊断和开发使用。

## 11.4 recovered 与 needs_user

- **recovered**：系统完成了安全 Proposal、版本检查和应用，重新读取后问题消失。
- **needs_user**：高风险、没有唯一可靠 Proposal、CAS 冲突、复核失败或其他无法安全自动处理的情况，需要用户查看或决定。

`needs_user` 不是把技术错误原样转给用户，而是把“系统无法代替用户做决定”产品化表达出来。

## 11.5 当前临时终态判断

由于 8097 尚未提供长期的 `terminal_failure`、`retry_exhausted` 或 `next_retry` 协议，当前兼容判断大致是：

```text
status = failed
+ attempts >= 1
+ 队列未暂停
+ failed 稳定约 5 秒
```

这只是 1.0 的临时兼容逻辑。它与 8097 自身即将发生 retry 之间还没有协议级互斥保证，长期应由 8097 提供明确终态字段。

---

# 12. Proposal / CAS 安全模型

这一层解决的问题是：如何让 Agent 或用户修改翻译内容，同时避免旧结果覆盖新结果、避免越权改字段、避免高风险内容自动生效。

## 12.1 Proposal 是什么

Proposal 是一份待审查的字段级修改提案。它至少说明：

- 要修改哪个 Master Asset；
- 要修改哪个 field path；
- 原文和当前内容是什么；
- 候选新内容是什么；
- 基于哪个 input revision、source SHA 和 Translation Version；
- 修改来自 Recovery、Agent、润色还是用户；
- 风险和原因是什么。

它不是直接写入结果。

## 12.2 Validate 做什么

Validate 会检查提案是否仍然针对正确的资产和字段，以及提案的依据是否仍然有效，包括：

```text
master_item_id 正确
field_path 在允许范围内
input_revision 未变化
source_sha256 未变化
base_translation_version 未变化
候选内容通过结构和安全规则
```

## 12.3 CAS 防止旧结果覆盖新结果

CAS（Compare-And-Swap，比较并交换）意味着“只有我分析时看到的那个版本仍然存在，才允许提交”。

例如：

```text
Agent 开始分析 revision A
→ 期间用户或 8097 产生 revision B
→ Agent 带着 A 返回 Proposal
→ Validate 发现依据过期
→ 标记 conflict，不覆盖 B
```

同理，source SHA 或基础 Translation Version 变化也会让旧 Proposal 失效。

## 12.4 Risk 与 Candidate

- 低风险普通自然语言字段可以在满足条件时自动恢复。
- 高风险字段不能由自动 Recovery 直接 Apply。
- 主动润色通常先生成 `polish_candidate`，用户确认后才成为 `polished_active`。
- 候选未被确认前，不替换当前活动版本。

系统还会保护变量、链接、数字、Markdown/JSON 结构、脚本和其他不应被普通翻译破坏的内容。

## 12.5 Apply 的最终边界

Apply 只能应用已通过校验、版本仍然匹配、字段范围合法并满足风险规则的提案。

Agent 的“任务完成”不等于 Master 已经被修改；只有 Apply 成功、写出新的 Translation Version 并更新活动指针，才算内容真正改变。

---

# 13. Adventure Instance

Adventure 是具体的故事工作区；Master 是可以被多个 Adventure 使用的模板资产。

## 13.1 从 Master 到 Instance

```text
Master Asset
→ Adventure Instance
→ 当前 Adventure Lore
```

角色卡实例化通常展开为：

```text
Character Lore
+ Worldbook Lore 1
+ Worldbook Lore 2
+ Worldbook Lore N
```

独立 Lorebook 也会按照其内部 nested entries 展开为多个 Adventure Lore。

## 13.2 嵌套 Entry 的运行时映射

Instance 会保存：

- Master Item ID；
- Adventure key；
- Instance ID；
- 加载时的 Master revision；
- 生成的目标 Lore IDs；
- `nested_entry_id → adventure_lore_id` 的映射。

因此系统可以知道某个总库 Entry 在某个 Adventure 中展开成了哪条 Lore，而不需要把 Entry 重新变成顶层 Master 资产。

## 13.3 幂等性

同一个 Master Asset 加入同一个 Adventure，默认只创建一个 Instance。

用户再次点击“加入当前冒险”时，系统检查已有使用关系，不再重复生成 Character Lore 和 Worldbook Lore。

## 13.4 Master 与 Adventure 的隔离

当前规则是：

```text
Master 新版本
→ 不自动覆盖已有 Adventure Instance

Adventure 运行变化
→ 不自动回写 Master
```

这使得总库可以继续维护标准角色，而某个 Adventure 仍然可以保持自己的剧情状态和局部变化。

## 13.5 旧 Adventure 的兼容

旧版本曾经把 Worldbook Entry 作为独立 `worldbook_entry` Master 资产。迁移后这些旧子资产从活动 Master 列表中退出，旧 Adventure 中已经生成的 Lore 仍然保留，不重新绑定，也不因清理总库而删除。

---

# 14. 数据流

本章把前面的产品关系压缩成四条可以核对的完整数据流。

## 14.1 新资料导入

```text
角色卡 / Lorebook 文件
→ 预览和解析
→ 保存 Source 与 Source Revision
→ 建立一个顶层 Master Asset
→ 保存 fields 与 nested_entries
→ 建立 Translation Targets
→ 8097 执行字段级初译
→ Translation Version 写入并激活
→ Pipeline 检查必需字段
→ 可用（usable）
```

“导入到总资料库”在这条流中不会生成 Adventure Lore，也不会创建 Instance。

## 14.2 翻译失败与恢复

```text
8097 failed
→ Runtime 聚合字段状态
→ 自动重试 / 等待稳定
→ Recovery Claim 去重
→ Master Agent 读取原文、字段和状态
→ Recovery Proposal
→ Validate
→ CAS / 风险 / 字段范围检查
→ Apply
→ 新 Translation Version
→ active 版本更新
→ Pipeline 复核
→ recovered
```

如果不能安全处理：

```text
→ 不 Apply
→ needs_user
```

## 14.3 加入 Adventure

```text
可用 Master Asset
→ 用户点击“加入当前冒险”
→ 检查 Master + Adventure 幂等关系
→ 创建 Instance
→ 生成 Character Lore
→ 展开 nested entries 为 Worldbook Lore
→ 保存 usage 与 entry-to-lore 映射
→ Adventure 开始使用
```

## 14.4 Adventure 变化

```text
Adventure Runtime Change
→ 只写当前 Adventure Instance / Lore / 故事状态
✕ 不自动写回 Master
✕ 不修改原始 Source
✕ 不静默覆盖其他 Adventure
```

---

# 15. 用户界面

当前 UI 重点是让用户看清资产内容和处理进度，并把技术复杂性折叠起来。

## 15.1 总资料库入口与列表

Denova 通过独立的“总资料库”页面进入 Master Library。列表以整张角色卡或整本 Lorebook 为单位显示：

- 中文名称；
- 资产类型；
- 简介或摘要；
- 内部设定数量；
- “可用 / 正在处理 / 需要你处理”等用户态；
- 来源文件；
- 已加入 Adventure 的数量。

列表支持搜索、`record_kind`、`semantic_type`、`availability` 筛选和分页。内部 nested entries 不在这里单独铺开。

## 15.2 资产详情

详情页优先展示“内容”，并按页签组织：

```text
内容
处理进度
版本
已加入冒险
技术信息
```

内容页可以阅读完整角色卡或 Lorebook；角色卡的内部设定和 Lorebook Entry 有自己的目录和阅读区域。

## 15.3 七节点与翻译状态

“处理进度”页显示七节点。翻译节点默认显示字段数量和产品化状态，必要时可以展开字段列表查看具体进度。

字段详细层仍可以看到内容版本、任务状态、翻译版本、输入 revision 和失败原因，但它不是普通用户进入页面后首先看到的内容。

## 15.4 Agent 右侧栏

在资料库资产详情中可以打开配置管理 Agent。点击后，右侧出现可调整宽度的对话栏。

这个 Agent 的上下文固定到当前 Master Asset，可以阅读总库内容和原文件，并帮助提出或校验受控修改。它不能借助对话直接绕过 Proposal、CAS 和风险边界。

## 15.5 编辑、润色和 Proposal

当前常用角色字段和 Lorebook Entry 字段可以在 UI 中编辑。保存时先显示修改前后，再走：

```text
用户编辑
→ Proposal
→ Validate
→ CAS
→ Apply
```

主动润色通常产生候选版本；低风险候选可以逐条或按现有规则批量应用，高风险内容不会进入普通批量应用入口。

## 15.6 两个容易混淆的按钮

UI 必须区分：

```text
导入到总资料库
```

表示保存原件、建立 Master 和进入翻译流程；

```text
加入当前冒险
```

表示从已经可用的 Master 创建当前 Adventure 的 Instance 和 Lore。

总库页签和 Adventure 导入弹窗都沿用这个区分，避免用户以为“查看总库”就会自动修改当前 Adventure。

## 15.7 用户态与技术态

普通 UI：

```text
正在处理
已完成
部分未完成
需要你处理
```

技术诊断层：

```text
task_status
failure_reason
input_revision
source_sha256
task_id
attempts
recovery_status
```

两层并存，但不要求普通用户阅读第二层。

---

# 16. 关键 API

从这里开始进入技术部分。下面只列与总库、导入、翻译和 Agent 相关的主要接口，不是整个项目的 API 百科。

## 16.1 总库查询与使用

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/library/assets` | 总库列表、搜索、筛选和分页 |
| POST | `/api/library/import-material` | 只导入总库，不创建 Adventure Lore |
| GET | `/api/library/assets/:id` | 资产、来源、版本和 usage 详情 |
| GET | `/api/library/assets/:id/pipeline` | 七节点和处理状态的只读聚合 |
| GET | `/api/library/assets/:id/translations` | Translation Version 列表 |
| GET | `/api/library/assets/:id/usages` | Adventure Instance/usage 列表 |
| POST | `/api/library/assets/:id/instances` | 把可用 Master 加入当前 Adventure |
| GET | `/api/library/assets/:id/runtime` | Master 与 8097 字段运行态聚合 |

这些接口共享 Master 查询层，不为了 UI 再建立第二套总库查询逻辑。

## 16.2 Proposal 与 Agent

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/library/assets/:id/proposals` | 读取资产 Proposal |
| POST | `/api/library/assets/:id/proposals` | 创建字段级 Proposal |
| POST | `/api/library/assets/:id/proposals/batch-apply` | 应用符合条件的 Proposal 集合 |
| POST | `/api/library/proposals/:id/validate` | 校验 Proposal 和 CAS 依据 |
| POST | `/api/library/proposals/:id/apply` | 应用已经通过校验的 Proposal |
| POST | `/api/library/assets/:id/agent` | 启动指定字段的 Master Agent |
| GET | `/api/library/agent/tasks/:id/stream` | 读取 Master Agent 任务 SSE |

## 16.3 Workspace 素材导入

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/workspace/import-material/preview` | 预览 Adventure 素材 |
| POST | `/api/workspace/import-material` | Adventure 内素材导入，默认走 Master 管理流程 |
| POST | `/api/workspace/import-material/master/translation` | 回写一个 Master 字段 Translation Version |
| POST | `/api/workspace/import-material/master/finalize` | 对绑定 Adventure 的事务执行实例化收尾 |
| POST | `/api/workspace/import-character-card/preview` | 角色卡预览兼容入口 |
| POST | `/api/workspace/import-character-card` | 角色卡导入兼容入口 |

`/api/workspace/import-material` 仍同时承载推荐的 `master_managed` 和旧的 `unmanaged_direct` 兼容路径，因此在维护时必须注意上下文和路径。总库专用入口是 `/api/library/import-material`。

## 16.4 8097 相关接口

Master Runtime 读取 8097 的：

```text
/api/denova/translator/jobs
```

现有前端队列控制还包括任务重试、暂停、取消、删除和 resolve 等接口，实际客户端集中在本地翻译 API 模块。Master 不把这些队列状态复制成自己的持久状态源。

---

# 17. 核心代码模块

下面按“职责”和“什么时候先看”整理关键入口。

| 文件/目录 | 职责 | 遇到什么问题先看 |
|---|---|---|
| `denova-src/internal/book/master_library.go` | Master manifest、Source、Item、Field、Translation Version、Import Transaction 的文件型存储和 CAS 翻译写回 | 资产保存、字段写回、版本冲突、原件归档 |
| `denova-src/internal/book/master_library_query.go` | 列表、详情、Pipeline、翻译状态和内容版本的只读聚合 | 列表显示、可用状态、七节点、usage 统计 |
| `denova-src/internal/book/material_import.go` | 角色卡/Lorebook 预览、整卡输入构造、Master-only 导入和 Adventure 投影 | 导入行为、顶层粒度、Entry 展开、两个入口隔离 |
| `denova-src/internal/book/character_card.go` | Tavern/PNG/JSON 角色卡解析、规范化和运行时 Lore 操作 | 角色卡字段、PNG、Worldbook、开场白 |
| `denova-src/internal/book/master_runtime.go` | Master Translation Version 与 8097 队列的字段级聚合 | 翻译进度、失败状态、Recovery 触发依据 |
| `denova-src/internal/book/master_agent.go` | Proposal、Validate、Apply、CAS、候选与活动版本规则 | Agent 修改、用户编辑、版本安全 |
| `denova-src/internal/book/master_recovery.go` | Recovery Claim 的持久化、幂等键和状态更新 | 重复恢复、重启恢复、claim 生命周期 |
| `denova-src/internal/book/master_migration.go` | 旧 `worldbook_entry` 归档、父资产生成、翻译复制和 legacy mapping | 旧数据整卡化、迁移、tombstone |
| `denova-src/internal/app/master_agent.go` | 启动受限 Master Agent Task，复用 Tool Agent Runner | Agent 任务实际启动和模型调用 |
| `denova-src/internal/app/master_recovery.go` | 后台 Recovery Orchestrator 和 claim 收敛 | 8097 失败后的自动恢复 |
| `denova-src/internal/agent/master_agent_tools.go` | Master Agent 的八个受限工具和单字段范围检查 | Agent 工具权限和工具参数 |
| `denova-src/internal/agent/config_manager_master_tools.go` | Config Manager Agent 的总库、原件、字段读取和 Proposal 工具 | 右侧配置管理 Agent 如何理解资料 |
| `denova-src/internal/agent/tool_result_policy.go` | Master 受控工具与普通 `file_write` 的能力隔离 | “工具权限被误分类”一类问题 |
| `denova-src/internal/app/config_manager_resource_skills.go` | 按资源上下文加载总库 Skill | Agent 读取顺序和资料上下文 |
| `denova-src/internal/api/routes.go` | Master、素材导入、Proposal 和 Agent 路由注册 | 接口是否已注册、入口在哪里 |
| `denova-src/internal/api/handlers/handler_library.go` | 总库查询、导入、实例化、Runtime、Proposal 和 Agent handlers | API 行为与响应 |
| `denova-src/internal/api/handlers/handler_material.go` | 素材预览、Adventure 导入、Master 翻译回写和 finalize | Workspace 导入和隔离问题 |
| `denova-src/web/src/features/library/LibraryView.tsx` | 总库列表、详情、完整内容、七节点、版本、Proposal、编辑和右侧 Agent | UI 展示、用户态、编辑交互 |
| `denova-src/web/src/features/library/MasterImportDialog.tsx` | 总库文件预览、确认导入和翻译目标入队 | “导入到总资料库”按钮和流程 |
| `denova-src/web/src/features/interactive/components/setting-panel/MaterialImportDialog.tsx` | Adventure 内素材/总库资产选择、直接导入和加入当前冒险 | “加入当前冒险”入口 |
| `denova-src/web/src/lib/api-client/master-library.ts` | Master API 客户端、类型和翻译目标入队 | 前端如何调用总库 API |
| `denova-src/web/src/lib/api-client/material-library.ts` | 素材预览、两种导入入口和翻译回写客户端 | 导入请求和 Master/Adventure 区分 |
| `denova-src/web/src/lib/api-client/local-translation.ts` | 8097 查询、重试、暂停、取消和任务控制 | 队列 UI 和重试按钮 |

---

# 18. 1.0 已完成能力

本章只列当前有生产代码并有部署、测试或运行记录支撑的能力。状态标签沿用 Facts 的定义。

## 18.1 CURRENT

- Narraverse 与 Denova 的本地协作运行环境。
- 独立 Master Library 及文件型 manifest、Source、Source Revision 和 Master Asset。
- 一个角色卡/一个独立 Lorebook 对应一个顶层 Master Asset。
- 内嵌 Worldbook/Lorebook Entry 作为父资产中的 nested entries 保存。
- 稳定 Entry ID 和字段路径定位；当前不依赖数组位置。
- 顶层角色名和 Lorebook 名进入中文名称翻译，名称未完成时保持处理中。
- 总库专用导入入口与 Adventure 实例化入口的隔离。
- HY-MT/8097 字段级翻译目标、持久化 Translation Version 和运行态聚合。
- `hy_mt_active`、`polish_candidate`、`polished_active` 等内容版本概念与任务状态分离。
- Master 列表、详情、完整内容、七节点、版本、Adventure usage 和技术信息页面。
- 总库搜索、筛选、分页和整卡内容阅读。
- 用户态简化显示，技术状态默认折叠。
- 配置管理 Agent 在总库上下文中读取整库内容和原件，并创建/校验 Proposal。
- Master Recovery Agent 的单资产、单字段受限处理。
- Proposal、Validate、字段级 CAS、风险检查和 Apply。
- 低风险 Recovery 自动应用，高风险和不确定结果进入 `needs_user`。
- Recovery Claim 持久化、重复扫描去重和应用重启后的继续能力。
- Master Asset 加入多个 Adventure 的 Instance 关系。
- Character Lore、Worldbook Lore 的运行时展开和 `nested_entry_id → adventure_lore_id` 映射。
- 同一 Master + Adventure 的实例化幂等。
- 旧子资产归档/tombstone、legacy mapping、旧 Adventure Lore 保留。
- Master 新版本不自动覆盖 Adventure，Adventure 变化不自动回写 Master。

## 18.2 已有真实验证记录

- 资料库 UI 定向测试和 Vite/TypeScript 构建有通过记录。
- Master 查询、Runtime、Proposal、CAS、Recovery 和 API handlers 有定向 Go 测试/构建记录。
- 已有真实 8097 + Master Asset + 本地 Ollama/qwen25-local 的低风险 Recovery 成功记录。
- 已验证旧 Translation Version 保留，新版本生成并成为活动版本。
- 已验证 Claim 幂等、重启持久化和旧 Proposal 在 revision/SHA/base version 变化后被拒绝。
- 已验证高风险场景不会自动 Apply，并可以进入 `needs_user`。
- 已完成总库整卡内容、Entry、七节点、右侧 Agent、实例化幂等和简化用户态的浏览器验收记录。

---

# 19. 已知限制 / 技术债

以下不是历史愿望，而是当前仍然存在的限制。

## 19.1 8097 终态与重试竞态

8097 尚未提供正式的 `terminal_failure`、`retry_exhausted`、`next_retry` 或等价协议字段。Recovery 当前依赖 `failed + attempts >= 1 + 稳定约 5 秒` 的临时判断。

因此 Recovery 与 8097 自身即将进行 retry 之间尚无协议级互斥保证。长期应由 8097 补充明确的终态和重试协议，不应继续堆叠更多时间阈值。

## 19.2 Pipeline 节点推导

`usable / staging` 的当前推导已经可用；parse、normalize、check 的部分节点状态仍依赖 Master、Source、Translation 和 Issue 等现有数据推导，没有完整独立的节点输出快照与 revision。

## 19.3 Issue 与 Usage 的投影性质

Pipeline 中的 Issue 主要是查询时生成的问题摘要，不是完整独立的持久 Issue 领域对象；Usage 数量和列表主要由 Instance Ref 过滤得到，也不是独立 Usage 表。

## 19.4 Entry 身份的极端情况

当前 Entry 没有身份字段时可以使用身份字段哈希保持重复导入的一致性，但还没有完全实现“首次 UUID 持久化后，通过保存身份信息处理所有后续变更”的更强匹配方案。

## 19.5 兼容代码

`unmanaged_direct` 和旧 `worldbook_entry` 构造/迁移代码仍然保留。它们不是推荐主流程，但继续存在会增加维护者理解路径。

## 19.6 全量构建和测试环境

项目曾用临时 Go 1.26.7 工具链完成过 `go build ./...` 和定向验证；当前执行环境未必随时具有 `go`/`gofmt` 命令。全量 `go test ./...` 仍有 Windows 符号链接、权限和路径格式等既有边缘失败记录，不能把它描述为全量全绿。

## 19.7 高风险完整 E2E

当前已经证明高风险内容不会被自动 Apply，也有 `needs_user` 回归记录；但“Agent 成功生成候选后，候选被风险规则拦截并进入用户确认”的所有变体还没有形成完整统一的真实样例。

## 19.8 搜索索引

总库列表当前使用有界线性扫描，没有独立持久化搜索索引。资产数量尚未证明需要引入更复杂的索引系统。

---

# 20. 明确未实现能力

下面的内容在历史设计中出现过，但当前生产系统不能当作已完成。

- **NOT IMPLEMENTED**：规范化 Agent、未知字段 Agent、独立检查 Agent、全库 Agent、批量 Agent。
- **NOT IMPLEMENTED**：默认对所有资料执行 Agent 二次翻译；当前以 HY-MT 全量初译为主。
- **NOT IMPLEMENTED**：Master revision 自动同步已经创建的 Adventure Instance。
- **NOT IMPLEMENTED**：Entry 级总库选择器、跨资产批量实例化和选择性展开控制。
- **NOT IMPLEMENTED**：8097 正式 `terminal_failure / retry_exhausted / next_retry` 协议及完整终态驱动恢复调度。
- **NOT IMPLEMENTED**：字段级 stale 的更细依赖图和自动重跑系统。
- **NOT IMPLEMENTED**：历史 Translation Version 合并界面、通用任意 JSON Patch 编辑器和 Master 原文件直接写回。
- **NOT IMPLEMENTED**：完整的 Proposal/Recovery 审计工作台和复杂异常人工处理流。
- **NOT IMPLEMENTED**：Adventure 运行内容自动回写 Master 的机制。

“未来文档提到过”不等于“当前 API 或 UI 已经存在”。如果需要实现其中任何一项，应先重新确认范围、数据真源和安全边界。

---

# 21. 后续发展方向

本章只是从当前 1.0 推导出的可能方向，不是已经批准的 Roadmap，也不代表应立即开发。

## 21.1 更明确的 8097 终态协议

如果实际运行继续证明 5 秒兼容判断会与队列 retry 产生竞态，可以让 8097 提供正式的 `terminal_failure`、`retry_exhausted`、`next_retry` 和 retry policy 信息，再缩小 Recovery 的判断不确定性。

## 21.2 更完整的节点证据

如果用户确实需要知道解析、规范化和检查发生了什么，可以为这些节点保存独立的输出 revision、输入 hash 和结果摘要，而不是继续依赖推导。

## 21.3 更成熟的资产搜索和浏览

当资产规模显著增长后，可以评估持久搜索索引、标签、来源分组和更细的内容导航；在那之前应先用现有线性查询验证真实瓶颈。

## 21.4 更完整的候选审查体验

如果高风险字段和复杂 Proposal 的使用频率上升，可以加强候选对比、审计、用户确认和失败解释，但不能因此绕开 CAS 或风险保护。

## 21.5 更精确的嵌套 Entry 演进

如果外部文件经常没有稳定 ID，可以增强首次身份持久化、身份匹配置信度和 Entry Diff。重点应是保持当前整卡资产粒度，而不是重新把 Entry 拆回顶层资产。

## 21.6 是否引入第三方能力

面对版本 Diff、JSON Patch、搜索或调度等通用能力时，应先检查项目已经引入的库和成熟开源方案，再判断依赖规模、License、安全性和架构影响。发现方案不等于必须替换当前实现。

---

# 22. 开发原则

这些原则是维护 1.0 时最重要的约束。

## 22.1 先查现有实现，再决定新增

先看当前生产代码、现有 API、已有数据结构和已有测试；再看基线文档；只有确实需要时才检索成熟方案或外部项目。

## 22.2 后台详细，前台简单

后台保留字段级状态、失败原因、revision、SHA、任务和 Claim；普通 UI 优先表达用户能理解和能操作的状态。

## 22.3 能自动恢复就不打扰用户

异常处理优先级是：

```text
任务异常
→ 系统自动重试 / 自动恢复
→ 仍无法解决
→ Denova Agent 分析并提出方案
→ 按安全权限重新执行
→ 仍有风险或歧义
→ 才通知用户处理或确认
```

## 22.4 Agent 不等于任意写权限

Agent 的价值在于理解和提出方案；真实写入必须受字段范围、Proposal、Validate、CAS 和 Risk 约束。

## 22.5 不为了模型跑通而放宽安全边界

如果模型不能生成合法 Proposal，应记录实际输出、工具调用顺序和校验失败原因，再判断是提示词、工具 schema 还是模型能力问题。不能通过放宽 Proposal、CAS 或高风险规则来“让测试通过”。

## 22.6 Master 与 Adventure 必须隔离

Master 是跨 Adventure 复用的模板，Adventure 是当前故事的实例。任何同步或回写都必须是明确设计的功能，不能偷偷加入。

## 22.7 用户资产粒度不等于内部处理粒度

用户应该看到整张卡/整本设定书；内部仍可以按稳定 Entry 和字段处理、翻译、恢复和实例化。

## 22.8 不建立重复状态真源

Pipeline 是现有 Master、Translation、Issue、Instance 等数据的聚合视图；Runtime 读取 8097，但不把 8097 状态复制成另一套 Master 真相。

## 22.9 生产验收才算用户功能完成

单元测试、构建通过和代码存在都不等于用户功能完成。涉及导入、翻译、Recovery、实例化和隔离的变化，应尽量用真实资产和真实运行链路验证。

## 22.10 现实问题优先于架构想象

不要为了可能的未来规模提前引入复杂框架、搜索系统或大范围重构。先确认真实瓶颈和真实用户需求。

---

# 23. 新 AI 接手项目指南

新的 AI 或开发者接手 Narraverse / Denova 时，先建立当前事实，再开始修改。

## 23.1 推荐阅读顺序

```text
叙界-Denova-1.0-项目总览与系统说明.md
↓
叙界-Denova-1.0-主文档.md
↓
叙界-Denova-1.0-实现事实.md
↓
当前任务相关源码
```

如果任务涉及历史迁移或设计选择，再定点阅读相关阶段文档和协作日志，不需要默认完整扫描整个仓库。

## 23.2 判断文档可信度

当前行为的判断顺序是：

```text
当前生产代码
>
Implementation Facts
>
最新阶段验收 / 生产记录
>
1.0 架构与维护基线
>
COLLABORATION_LOG
>
CODE_GUIDE
>
阶段设计文档
>
早期讨论和旧方案
```

时间主要用于理解演进顺序，不能代替代码核验。尤其要注意某些文件的创建时间和修改时间可能来自复制或编辑，不能据此伪造历史。

## 23.3 开始开发前必须回答

1. 当前问题属于原件、处理/翻译、Master、Adventure 还是 UI 哪一层？
2. 当前代码已经有什么能力？状态是 CURRENT、PARTIAL、LEGACY 还是 NOT IMPLEMENTED？
3. 应该从哪个 API、handler、store、查询层或组件开始？
4. 这次变化会不会创建新的状态真源？
5. 这次变化会不会让总库导入偷偷创建 Adventure Lore？
6. 这次变化会不会让 Adventure 变化自动回写 Master？
7. 这次变化会不会绕过 Proposal、CAS、风险或字段范围？
8. 失败时用户真的需要看到技术细节吗？

## 23.4 不要做的事

- 不要一上来扫描整个仓库并把所有旧文档当成当前规范。
- 不要因为看到 `worldbook_entry` 兼容代码，就把它重新设计成当前顶层资产。
- 不要因为旧文档写“资料库只读”，就删除当前已存在的受控编辑和 Proposal 能力。
- 不要为了一个模型失败放宽安全边界。
- 不要把 8097 队列状态复制成新的 Master 状态真源。
- 不要把内部 Entry 重新暴露成总库列表中的独立资产，除非产品粒度被正式重新确认。
- 不要未经要求修改大量基线文档、历史数据或生产流程。

## 23.5 遇到异常时的排查顺序

```text
先确认数据是否存在
→ 确认当前 revision / SHA / field_path
→ 确认 API 是否读取了正确的 Master
→ 确认 8097 Runtime 是否只是被正确聚合
→ 确认 Claim 是否重复或已持久化
→ 确认 Proposal 是否针对当前版本
→ 确认 Validate / CAS / Risk 的具体结果
→ 最后才判断是否需要改代码或改协议
```

如果只是普通错误显示问题，优先调整产品化文案和折叠层，不要删除后台诊断字段。

## 23.6 接手后的最小汇报内容

每次完成一个范围明确的工作后，说明：

- 改了哪些文件；
- 复用了哪些现有能力；
- 新增或改变了哪条数据流；
- 是否影响 Master/Adventure 隔离；
- 是否改变了状态真源；
- 验证了哪些真实路径；
- 哪些仍然是 PARTIAL、LEGACY 或 NOT IMPLEMENTED。

如果发现代码和文档冲突，先以代码为准并明确记录漂移，不要为了“让文档看起来一致”擅自扩大修改范围。

---

**文档结束**
