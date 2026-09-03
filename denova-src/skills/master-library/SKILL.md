---
name: master-library
description: 使用配置管理 Agent 浏览、核对原文件并安全修改总资料库角色卡或设定书时使用；修改必须生成 Proposal 并等待用户确认。
agent: config_manager
---

# 总资料库管理

总资料库保存可跨 Adventure 复用的角色卡和独立设定文件。一个原始文件对应一个顶层 Master Asset；角色卡内 Worldbook 与 Lorebook Entries 是父资产中的嵌套实体，不是独立顶层资产。

## 读取顺序

1. 不知道资产 ID 时，先用 `list_master_assets` 搜索顶层资产。
2. 用 `read_master_asset` 读取规范结构、字段目录、稳定 Entry ID 和当前内容。
3. 只在需要理解原始 JSON、核对未规范化字段或判断导入差异时，使用 `read_master_source` 读取不可变原文件。不要尝试修改原件。
4. 准备修改前，用 `read_master_field` 读取准确字段、当前活动内容和 CAS 基线。

嵌套 Entry 必须使用稳定路径，例如：

```text
character_book.entries/<entry_id>/content
lorebook.entries/<entry_id>/comment
```

不得使用数组位置（例如 `entries[17]`）定位长期身份。

## 修改流程

修改总库内容时只能执行：

```text
read_master_field
→ create_master_proposal
→ validate_master_patch
→ 向用户说明已生成待确认修改
```

- `create_master_proposal` 只创建候选，不会直接改动活动内容。
- 不调用普通 `write_lore_items` 修改 Master；它只属于当前 Adventure 的普通资料库。
- 不通过文件工具修改 `.narraverse`、原件或 Master JSON。
- 不声称已经应用。只有用户在总资料库界面查看差异并点击“应用修改”后，内容才会产生新的活动 Translation Version。
- 删除资产、改原文件、批量重写整卡或同步 Adventure 不属于本 Skill。

## 风险边界

角色描述、背景、开场白和普通嵌套 Entry 内容可以提出字段级候选。系统提示词、后历史指令、脚本、正则、运行控制字段和其它高风险字段必须明确提示风险，并等待界面额外确认；不得规避 Proposal、CAS 或字段范围校验。

如果用户只要求解释或检查，保持只读，不生成 Proposal。工具失败或 CAS 冲突时说明当前内容已变化，并要求重新读取，不要循环重试或假装成功。
