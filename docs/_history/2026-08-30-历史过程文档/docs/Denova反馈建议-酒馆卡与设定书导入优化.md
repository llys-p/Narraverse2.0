# 反馈建议：优化「导入酒馆角色卡」与新增「设定书（lorebook）导入」

> 提交对象：Denova 作者（alfredxw）
> 提交日期：2026-08-13
> 提交背景：文字冒险平台用户（重度使用 Denova 写作/游戏模式 + 酒馆（SillyTavern）生态），已在本地完成「平台 ↔ Denova 素材互通」并积累落地经验，以下建议来自真实使用与实现。

---

## 一、使用场景与三个痛点

我们同时使用 Denova 与酒馆生态（SillyTavern 角色卡/世界观设定书）。当前 Denova 的「导入酒馆角色卡」（CharacterCardImportDialog）存在三个问题：

### 1. 只支持角色卡，没有设定书（lorebook）导入入口
酒馆生态里与角色卡同等重要的还有**世界观设定书（lorebook / world_info）**——几十上百条按关键词触发的设定条目（人物、地点、规则、物品）。当前 Denova 只能导入角色卡（chara_card_v2），设定书没有入口，用户只能手动把 lorebook 逐条粘进资料库，成本极高。

### 2. 导入解析偏"僵硬"，只认最基本的字段
- 只读取了角色卡的基础字段（name/description/personality/scenario/first_mes/tags 等），对酒馆生态常见的扩展字段支持不足：
  - **PNG 角色卡**（内嵌 chara JSON 的图片卡）没有支持——需要读取 PNG tEXt 块中 key 为 `chara` 的 base64 JSON；
  - **Character V3 字段**（`alternate_greetings` 多开场白、`character_note` 核心约束、`system_prompt` 专属系统指令、`post_history_instructions` 结尾指令、`note_depth` 深度重注入）没有映射；
  - 描述文本里的 `{{char}}`/`{{user}}` 模板占位符未处理，导入后直接残留。
- 结果：复杂卡导入后"形在神散"，人设细节、多开场白、核心约束大量丢失。

### 3. 导入后内容显示异常："一整条就塞满了整个设定"
导入的角色卡内容没有被结构化拆分，在资料库/设定界面里表现为**一大条塞满**——没有按 人设/性格/场景/开场白/标签 分节展示，也没有拆成可单独检索的条目。用户无法确认"导入进来到底有哪些内容"，更无法局部编辑。

---

## 二、改进建议（参考我们已验证的实现）

### 建议 1：新增「导入酒馆设定书（lorebook）」入口
- 在 CharacterCardImportDialog 同级增加 Lorebook 导入（支持 `.json`，识别 `_world_info` / SillyTavern lorebook 格式：`{entries: {key: {key[], content, comment, ...}}}`）。
- **解析映射**（我们已按此实现，可直接参考）：
  - 每个 entry → 一个 lore item：
    - `keywords` ← entry.key 数组（别名/触发词）
    - `content` ← entry.content 原文（保留敏感词，不做审查）
    - `type` ← 按关键词启发式推断（character/location/faction/rule/item/world）
    - `importance` ← character→major，其余 important
    - `load_mode` ← character/faction→resident，其余 auto（与平台 World Info 按关键词命中语义对齐）
    - `brief_description` ← "类型 名称。内容前 3 句"（渐进式加载时名称目录可读性好）
  - 写入 `projects/<book>/.denova/lore/items.json`（沿用现有 v2 结构，纯增量）。
- 导入后**条目化展示**：列表按条目显示（名称/类型/关键词/简介），支持勾选批量启用、单条编辑——而不是一整条塞满。

### 建议 2：角色卡导入增强
- **支持 PNG 卡**：用 PIL/解码 PNG tEXt 块（key=`chara`）取 base64 JSON；兼容单/双 chara 块（我们曾遇到旧卡双 chara 块问题）。
- **映射 V3 字段**：`alternate_greetings`（多开场白）、`character_note` + `note_depth`（核心约束按深度重注入）、`system_prompt`（专属指令）、`post_history_instructions`（结尾指令）——这些在酒馆生态大量使用。
- **清理模板占位符**：导入时把 `{{char}}`/`{{user}}` 归一化或提示（避免残留进 lore）。
- **导入预览**：解析后先展示"将导入 N 个字段/条目"确认，再落库；导入结果反馈成功/失败/跳过明细。

### 建议 3：导入结果反馈与可逆
- 导入完成后弹窗摘要：新增 N 条 lore / 更新 M 条 / 跳过 K 条（原因）。
- 支持"取消本次导入"（写入前暂存，确认才提交），避免误导入污染资料库。

---

## 三、我们本地已验证的参考实现（供参考）

- 平台侧（纯前端）：PNG 卡 chara 提取 `extractCharaFromPNG`；V3 字段归一化 `normalizeCardObject`；设定书按【关键词】分段解析为 World Info 条目（`parseBookEntries`）。
- 互通侧（本地脚本）：`denova_lore_sync.js` 把平台设定书（lorebook JSON）转成 Denova `lore/items.json`（v2），含上述全部映射规则；反向导入也已实现。
- 若作者需要，我们可提供样例（一本含 100+ 条目的 lorebook 及其转换后的 items.json）供对照测试。

---

## 四、期望

1. 下个版本支持 lorebook（world_info）导入，让酒馆生态的设定书能一键进入 Denova；
2. 角色卡导入覆盖 PNG 卡与 V3 字段；
3. 导入内容条目化展示与导入反馈。

这三项做完，Denova 对酒馆生态的兼容性将补齐最后一块，我们的使用链路也会更顺。
