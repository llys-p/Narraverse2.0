---
name: book-overview-relations
description: 管理当前书籍的总览、人物主次分层和资料条目间明确关系；用于总览整理、目录分组、图谱筛选、人物关系、隶属与地点关联的读取和保存。
agent: config_manager
---

# Book Overview and Relations

只管理当前打开书籍的长期设定。总览来自 `setting/book-overview.md`，明确关系来自本书 Lore 条目的 `relations`；图谱是这些资料的展示。独立作品设定库、总资料库和游戏运行状态属于其它工具，不混写。

## 读取与修改总览

1. 调用 `read_book_overview`，获得完整 Markdown、`exists` 和 `revision`；不存在时 revision 为 `missing`。
2. 按需求用 `list_lore_items` 查看目录、`read_lore_items` 读取相关条目。只读取需要的资料，不扫描整部小说。不把模型推测写成原资料已经确认的事实。
3. 用户要求修改并保存时，以原文为基础完成局部整理，调用 `write_book_overview`，参数为完整 `content` 和刚读取的 `base_revision`。保留未要求改变的段落，不为了关系变更重写整篇总览。
4. revision 冲突表示总览已被其它操作修改；重读并合并，不自动用旧稿强行覆盖。工具返回 rejected/error 时不得报告已保存。

## 人物层级与目录分组

人物目录和图谱共用 Lore 条目的 `character_tier`：`major`=主要人物，`minor`=次要人物，`unclassified`=未分类。`importance`（major/important/minor）是独立的重要度，不是目录分层；不能根据它宣称人物已分类。缺少 character_tier 视为未分类，不自动从重要度推导。

1. 用 `list_lore_items` 查真实 ID 与 character_tier；按分页继续，不必为分类读取全部正文。依据用户已确认的名单或资料提出方案，模糊的“重要人物”先明确映射规则。
2. 用户要求保存主次时调用 `write_lore_items`，例如 `{"message":"将林冲设为次要人物","items":[{"id":"真实人物ID","character_tier":"minor"}]}`。更新只传 ID 和该字段，不顺带改变 importance、load_mode、正文、精选或关系。
3. 成功后调用 `read_lore_items` 核对实际 character_tier，再报告真实保存数量、未分类数量和失败项。工具失败不得称已保存；只输出名单不算完成。分层不需再向图谱保存一份数据。

## 设置明确关系

1. 用 `list_lore_items` 找到两端条目的真实 ID；同名或缺条目先澄清。关系目标必须已经存在于本书，不能填外部资产 ID。
2. `read_lore_relations` 传 `{"ids":["source-id","target-id"]}`，读取当前完整出向关系、入向关系及每个源条目的 `base_revision`。
3. 按用户要求增改关系，保留其它关系。每条关系包含 `target_id`、`label` 和可选 `note`，方向为源条目 → 目标条目。例如“林冲视鲁智深为好友”，源是林冲、目标是鲁智深、label 是“好友”；师父/弟子、隶属/拥有等方向不能混用。只有用户要求或资料明确支持时才创建反向关系。
4. `write_lore_relations` 只改关系，不改正文，结构如下：

```json
{
  "message": "设置林冲与鲁智深的好友关系",
  "items": [{
    "id": "source-id",
    "base_revision": "从 read_lore_relations 原样取得",
    "relations": [{"target_id":"target-id","label":"好友","note":"作者确认的长期关系"}]
  }]
}
```

`relations` 是该源条目的完整关系列表。移除一条关系时只移除该项；用户明确要求清空全部才传 `[]`。一次最多 16 个源条目、每项最多 128 条，label 1–100 字、note 最多 2000 字。整批校验失败不会部分保存。改名仍按稳定 ID 保留关系；删除条目会解除其它条目指向它的关系，不删除其它条目。

正文自动提及连线只是相关性线索，不是“好友/敌对”等事实。用户要求分析但未要求保存时只提出建议。禁止用文件工具直接编辑 `lore/items.json`，也不因游戏剧情临时变化自动更新长期关系。

完成后报告实际保存的总览修改及关系的源、名称、目标；未完成的操作说明原因。写入以成功工具结果为准，不以生成的说明文字代替。
