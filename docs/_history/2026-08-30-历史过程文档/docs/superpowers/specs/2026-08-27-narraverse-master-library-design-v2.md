# 叙界总资料库设计（第二版历史基线）

日期：2026-08-27  
状态：已由 2026-08-28 批准规格取代；仅保留用于设计追溯，未据此实施总库迁移  
现行规格：`2026-08-28-叙界总资料库与导入翻译流水线设计.md`  
历史基线：`2026-08-27-narraverse-master-library-design.md`

> 注意：本文件后文的“三种 ID”、按 `entity_type` 生成条目 ID、MVP 即做三方合并等内容均属于历史方案。实施时必须以现行规格的四级 ID、稳定 `record_kind`、总库优先导入和分阶段范围为准。

## 1. 目标与不变原则

建立独立、干净、可持续补充的 Denova 工程“叙界总资料库”。英文原件永久保留；HY-MT 初译通过结构校验后成为中文工作版；在线强模型润色是可选升级。其他冒险只按用户选择加载受管快照。

第一版同时把 Denova 的“管家模型”抽象为可替换的大脑：云端模型和本地 OpenAI 兼容模型共用同一套管家提示词、上下文组装器和输出排版器。总库负责提供完整资料，运行时负责在不改写原件的前提下整理、回答和简单摘要。

所有冒险的记忆、关系、成长、伤势、位置和其他运行状态完全独立。总库保存角色模板与世界知识，不保存任何冒险经历，也不自动把冒险实例回写总库。

本规格优先冻结四个底层契约：ID 层级、manifest 索引、版本字段、Base/Local/Remote 字段级合并。

## 2. 工程位置与目录

总库工程固定为：

```text
<project-root>\denova\.denova\projects\narraverse-master-library\
```

Denova 显示名称为“叙界总资料库”。建议目录结构：

```text
narraverse-master-library\
├─ .denova\lore\items.json
├─ .narraverse\
│  ├─ master-library-manifest.json
│  ├─ audit-log.jsonl
│  ├─ source\originals\
│  ├─ snapshots\
│  └─ backups\
├─ 资料整理\
│  ├─ 润色任务清单.md
│  └─ <source_id>\
│     ├─ 原文.json
│     ├─ HY-MT初译.json
│     ├─ 润色结果.json
│     └─ 校验报告.json
├─ CREATOR.md
└─ setting\world.md
```

首次整理前创建不可变备份：

```text
<project-root>\.workbuddy\backups\master-library-<YYYYMMDD-HHMMSS>\
```

备份包含知识库角色卡、世界观设定、相关元数据/索引、`books.json` 和已存在总库工程。备份清单必须记录相对路径、字节数、SHA-256、备份时间；校验不完整时禁止迁移。

## 3. ID 层级与生成规则

三种 ID 必须区分，任何接口不得把它们当作同义字段：

### 3.1 `source_id`：原始素材身份

表示一个原始素材及其版本谱系，不表示拆分后的条目。一本设定书只有一个 `source_id`，即使拆成很多条 LoreItem。`source_id` 在同一来源谱系的修订中保持不变；新文件且无法证明属于同一谱系时创建新 ID。

生成规则：`source_id = uuid5(NARRAVERSE_SOURCE_NAMESPACE, canonical_origin_key)`。`canonical_origin_key` 由来源类型、知识库相对路径、外部稳定 ID（若有）和内部卡片 ID 组成，并使用 UTF-8、正斜杠、大小写敏感的规范化形式。内容 SHA 不直接作为 `source_id`，因为内容变化应产生新版本而非丢失来源身份。

### 3.2 `master_item_id`：总库正式条目身份

表示拆分后的一个可加载条目，必须可回溯到一个 `source_id`。生成规则：`master_item_id = uuid5(NARRAVERSE_ITEM_NAMESPACE, source_id + "\\0" + source_entry_id + "\\0" + entity_type)`。

`source_entry_id` 优先使用原格式稳定 entry ID；没有稳定 ID 时使用规范化字段指纹，并将匹配置信度写入 manifest。仅靠数组位置不得作为唯一 ID。一本设定书可以有多个 `master_item_id`。

### 3.3 `instance_id`：冒险独立实例身份

每次把总库条目加载到冒险时生成新的 UUID `instance_id`。实例记录 `master_item_id`、加载时的 `master_revision` 和本地覆盖。实例的记忆、关系和成长只属于当前冒险。

### 3.4 ID 不变量

- `source_id` 不等于 `master_item_id`，`master_item_id` 不等于 `instance_id`。
- ID 一旦写入 manifest 或受管快照，不因改名、翻译或重新排序而改变。
- 无法可靠推导稳定 entry ID 时必须标记 `identity_confidence: low`，要求人工确认；不得静默合并。

## 4. 统一版本字段

所有核心 JSON 对象都必须包含以下字段：

```json
{
  "schema_version": 2,
  "data_version": 1,
  "revision": "sha256:<canonical-json-hash>",
  "updated_at": "2026-08-27T03:13:00+08:00"
}
```

- `schema_version`：结构版本。结构迁移只递增此字段。
- `data_version`：同一对象谱系的单调递增整数，从 1 开始；任何语义内容变更递增。
- `revision`：对去除运行时字段、按固定键序列化后的规范 JSON 求 SHA-256；用于 CAS、快照和三方比较。
- `updated_at`：审计时间，不参与 `revision` 计算。

适用对象：manifest、原文、HY-MT 初译、润色候选、校验报告、LoreItem、冒险受管快照及其条目。读取旧格式时先迁移到当前 schema；无法解析或哈希不匹配必须报告损坏，不能当作空数据。

## 5. manifest：总库核心索引

`.narraverse/master-library-manifest.json` 是总库唯一的映射索引，不以目录扫描结果代替。顶层至少包含：

```json
{
  "schema_version": 2,
  "data_version": 1,
  "revision": "sha256:...",
  "sources": [],
  "items": [],
  "snapshots": [],
  "translations": [],
  "polish_jobs": [],
  "integrity": {"dangling_references": 0}
}
```

每个 source 记录：`source_id`、来源类型、相对路径、原件路径、内部名称、格式、字节数、SHA-256、来源版本、首次导入时间、当前状态和别名路径。

每个 item 记录：`master_item_id`、`source_id`、`source_entry_id`、`entity_type`、语义分组、原文/初译/润色/当前工作版路径、各自 revision、状态、版本历史、加载策略、关键词/英文别名、原始字段到 LoreItem 字段的 `field_routes`。

每个 snapshot 记录：冒险 ID、`instance_id`、`master_item_id`、加载时 Base revision、当前 Local revision、来源路径和冲突状态。

manifest 必须支持双向追溯：

```text
source_id → [master_item_id] → current_working_file → LoreItem
master_item_id → source_id → original_file / translation_files
```

所有路径均为工程内相对路径，禁止绝对路径。提交 manifest 前执行引用完整性检查；不得存在指向不存在文件、条目或来源的悬空引用。

## 6. 角色模板与 LoreItem 类型

长期模型区分 `CharacterTemplate` 和 `LoreItem`。当前 Denova 若只能统一存储 LoreItem，必须增加 `entity_type`：

```text
character | lore | location | faction | rule
```

角色模板字段包括身份、外貌、性格、背景、说话方式、`first_mes`、`mes_example`、固定能力与边界。LoreItem 字段包括正文、关键词、触发条件、优先级、加载策略。

角色模板与世界知识可以共享来源和版本系统，但不得因为统一存储格式而混淆加载语义。空字段组不创建虚假条目。

## 7. 去重、版本与生命周期

- SHA-256 完全相同：幂等跳过，不生成新 source、item 或版本。
- 同名不同 SHA：保留为不同来源/版本，记录 `name_collision`，禁止按名称覆盖。
- 能确认同一来源谱系的更新：沿用 `source_id`，递增 `data_version`。
- 不能确认谱系：创建新 `source_id`，等待人工关联。

条目生命周期为：

```text
active → deprecated → archived
```

`deprecated` 不再允许新冒险默认选择，但已有快照继续工作；`archived` 不参与默认检索，也不删除原文或历史。可选 `replacement_item_id` 指向替代条目。物理删除不属于普通 UI 操作，只能通过显式维护工具执行并保留备份。

导入流程必须幂等：同一份原件重复导入任意次数，不能重复生成条目、版本或审计噪声，也不能改变已有有效数据。

## 8. 翻译与润色状态机

翻译状态严格为：

```text
untranslated → hy_mt_active → polish_candidate → polished_active
```

`hy_mt_active` 表示初译已通过结构校验并成为当前中文工作版；`polish_candidate` 只表示候选文件已生成；只有校验通过且用户/流程实际激活后才是 `polished_active`。

HY-MT 按字段和段落串行翻译，忠实、不总结、不净化、不续写。保护模板变量、URL、Markdown、HTML、代码块、正则和脚本；脚本/正则默认 `manual` 或禁用。缺少必需译文字段的条目不得 active 或被冒险加载，且报告不得显示全绿成功。

润色任务必须同时记录 `source_id`、`master_item_id`、字段路径、原文路径与 revision、初译路径与 revision、输出路径。在线模型不得靠文件名猜测来源、不得覆盖英文原件。

## 9. Base / Local / Remote 字段级三方合并

总库更新冒险受管快照时使用三方比较：

- `Base`：该冒险上次确认加载的总库版本。
- `Local`：当前冒险受管内容。
- `Remote`：总库最新 active 版本。

合并单位是字段路径，而不是整个条目：

1. `Local == Base` 且 `Remote != Base`：接受 Remote。
2. `Remote == Base` 且 `Local != Base`：保留 Local。
3. `Local == Remote`：保留共同结果，不产生冲突。
4. `Local != Base` 且 `Remote != Base` 且 `Local != Remote`：仅该字段冲突。

对象递归到叶字段；有稳定 ID 的对象数组按成员合并；无稳定 ID 的有序数组视为整体字段，避免错误重排。集合型关键词按集合合并并保留删除冲突；二进制/脚本字段不自动合并。冲突记录字段路径、三方值、三方 revision 和建议动作，生成冲突副本，不覆盖 Local。

合并成功后更新快照 Base 为 Remote revision；存在任一未解决冲突时，快照状态为 `conflicted`，但旧 Local 仍可运行。

## 10. 自动加载触发模型

加载策略保留：`resident`、`auto`、`manual`、`disabled`。`auto` 必须带结构化触发条件：

```json
{
  "keywords_zh": ["日向", "木叶"],
  "aliases_en": ["Hinata", "Konoha"],
  "characters": ["master-character-id"],
  "locations": ["master-location-id"],
  "factions": ["master-faction-id"],
  "semantic_query": null
}
```

当前只实现关键词、别名和显式实体关联；`semantic_query` 预留但不启用。这样未来替换检索器时无需迁移全部总库数据。玩家绑定角色和核心规则才默认 `resident`，普通角色/地点/组织/世界知识默认 `auto`，作者约束/脚本/正则默认 `manual` 或禁用。

## 10A. 第一版管家模型与本地 OpenAI 兼容接口

第一版不新建独立“本地管家”系统，而是在现有云端管家调用链上增加 provider 切换：

```text
云端管家模型 ─┐
              ├─→ 同一套管家提示词 → 整理/回答 → Denova 统一排版
本地模型 ─────┘
```

设置页必须支持填写并持久化：

- Provider：云端 / 本地；
- Base URL，例如 `http://127.0.0.1:4000/v1`；
- API Key，例如 `sk-local-free`；
- Model，例如用户选择的本地模型别名。

本地 provider 使用 OpenAI Chat Completions 兼容协议；不得把本地配置发送到云端，也不得自动回退到收费 API。连接失败、模型不存在或返回空内容时显示明确错误，并保留当前游戏状态。

上下文组装器必须按当前冒险生成一份可审计的完整上下文包，至少包括：当前冒险已启用的角色卡、世界书/LoreItem、剧情状态、独立记忆、聊天记录及必要的运行约束。总库未启用的条目不得混入；其他冒险的记忆和成长绝不混入。每次请求记录字段计数、字符/令牌估算、来源 ID 和截断状态，不记录隐藏思考。

上下文超过模型或本地服务上限时必须在发送前明确提示并让用户选择“取消、缩减可选资料、分段处理”；禁止静默截断角色卡、世界书或聊天记录。若服务端仍返回截断标记，Denova 将该次结果标为不完整，不覆盖任何原始资料。

模型职责仅限：阅读 Denova 提供的全部上下文，理解人物与设定，回答、摘要和简单整理，并按指定格式输出。模型不得直接写入原始角色卡、世界书、对话档案或总库文件；任何整理结果先作为界面草稿/新版本候选，由 Denova 统一 Markdown、角色页和对话排版后保存。

上下文内容按原始资料权限送入模型，包括 NSFW 等已启用资料；不做隐式净化或删节。安全提示、成人内容开关和用户确认属于 Denova 的可见设置，不得由 provider 偷换。

## 11. 冒险快照、追加与状态隔离

从总库加载时复制中文工作版，并生成新的 `instance_id` 与受管快照，记录 Base revision、哈希和本地修改状态。总库更新只提示“有新版”，不静默覆盖冒险。

冒险中途可以加载：新设定从下一轮检索开始生效；新角色默认只加入世界，不自动插入 `first_mes` 或改写过去对话。用户可明确选择“加入当前场景”。移除实例不删除总库条目。

每个冒险实例的运行记忆、关系、成长等状态只写入该冒险状态库。只有用户主动“另存为总库变体”时，才创建新的 source/item 版本；默认禁止反向污染总库。

## 12. 审计日志

`.narraverse/audit-log.jsonl` 为追加式日志，记录导入、去重、翻译、润色、激活版本、更新、冲突、归档、恢复和快照创建等操作。每行至少包含：

```json
{
  "schema_version": 2,
  "timestamp": "2026-08-27T03:13:00+08:00",
  "operation": "activate_translation",
  "source_id": "...",
  "master_item_id": "...",
  "before_revision": "sha256:...",
  "after_revision": "sha256:...",
  "actor": "user|hy_mt|online_model|migration",
  "result": "success|conflict|failed"
}
```

审计日志不参与 LoreItem 上下文，不得因清理 UI 队列而删除。修复或恢复操作也必须追加日志。

## 13. 原子性、恢复与错误显示

每个原始素材是独立事务。先写临时文件和恢复点，再按“原件/翻译包 → LoreItem → manifest”顺序校验并原子替换；manifest 只有在所有引用可解析后才提交。崩溃恢复时扫描未提交事务，删除临时文件或完成可验证提交，不凭目录猜测成功。

报告必须分开显示创建、更新、重复、冲突、翻译失败、截断、不支持字段和恢复状态。任何缺失、冲突、截断或翻译失败都不能显示全绿成功。

## 14. 实施顺序

1. 备份并生成哈希清单。
2. 建立 ID、schema/data version 与 manifest 验证器。
3. 新建并注册总库工程。
4. 实现原件归档、拆分、幂等去重和审计日志。
5. 完成三份代表素材试译与质量报告。
6. 实现 HY-MT 全字段入库和失败阻断。
7. 增加 CharacterTemplate/LoreItem 的 `entity_type` 兼容层。
8. 增加总库来源、受管快照和 Base/Local/Remote 字段级合并。
9. 增加统一上下文组装器、云端/本地 OpenAI 兼容 provider 切换、长度预检和 Denova 输出排版；先支持设置与单次请求，不做批量结构化改写。
10. 增加生命周期、结构化触发条件和中途加载。
11. 生成在线润色映射，最后执行回归与真实素材抽检。

## 15. 验收矩阵

- ID：一本设定书一个 `source_id`、每个 entry 独立 `master_item_id`、每次冒险加载独立 `instance_id`。
- 版本：所有核心对象含 `schema_version`、`data_version`、`revision`；哈希可复算。
- manifest：source→items 与 item→source 双向可定位，悬空引用为 0。
- 幂等：相同原件重复导入不增加条目、版本或有效数据。
- 合并：只改不同字段时自动合并；同一字段同时修改才冲突；Local 不被静默覆盖。
- 生命周期：归档不影响已有快照，新冒险默认不可选。
- 翻译：三种代表素材无结构/占位符损坏；失败字段不可加载。
- 快照：冒险 A/B 的记忆、关系、成长互不可见；中途加载不改历史。
- 管家：云端与本地 provider 使用同一提示词和排版链；本地 URL/API Key/模型可配置；完整上下文可审计；超长时不静默截断；空/截断响应不覆盖原件；已启用 NSFW 资料可正常送入模型。
- 追溯：任意 LoreItem、快照和翻译结果都能通过 manifest 找到原件与 revision。
- 审计：关键操作可按 source/item 和前后 revision 查询。

## 16. 明确不做

- 不实时让所有冒险引用总库最新版。
- 不把整个总库设为 resident。
- 不覆盖或删除英文原件。
- 不自动把冒险经历写回总库。
- 不把在线润色设为总库可用的前置条件。
- 不批量修改已有冒险的运行状态。
- 第一版不做自动批量结构化整理、自动改写角色卡/世界书或在线模型强制润色；这些属于后续版本。
