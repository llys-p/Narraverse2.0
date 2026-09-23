# L4 旧资料迁移骨架

日期：2026-09-22。**只定义方案，未执行迁移、未删除数据、未注册迁移API。**
迁移独立于运行模式，不借助LLM自动裁定事实。实施apply前必须得到用户对具体数据的授权。

## 1. 目标与前置

把用户选中的旧 World 与作品 Lore 转为独立作品设定库，最终减少重复管理。
前置：L1持久化可靠；L2读取可解释；L3至少目标模式的真实闭环通过。
L4.1盘点/纯映射可提前只读实施，L4.3写入与入口退役不得提前。

Master原件不是需要搬走的另一份Library；保留原件，以source引用或显式改编关联。
原有书籍、互动故事、Adventure存档、localStorage、node_modules、exe与dist不在迁移输入内。

## 2. 流程与状态

inventory → selected → preview → confirmed → applying → verified
                                         ↘ failed → recoverable

- inventory：只扫描用户指定/服务端登记的数据根；给出数量、来源身份、版本、损坏项，不输出完整用户存档。
- preview：纯映射，无文件创建/目录搬运。给出拟建库、条目、关系、事件、来源、冲突、忽略原因与风险。
- confirmed：确认绑定预览指纹和所有输入revision；任何源变动使确认失效，重做预览。
- applying：先备份/核验可恢复，再原子写入一个新库；不原地改旧World/Lore。
- verified：核对条目数量、引用完整性、语义、来源版本与L2读取；用户确认后才考虑改变默认入口。
- failed：保留源文件和备份，显示实际完成项；不能报告全成功或自动重试造成重复库。

不要用“文件移动完成”当迁移完成，也不要把读到损坏文件静默跳过。

## 3. 映射表（实现前以真实字段校准）

| 输入 | 拟输出 | 保真与冲突处理 |
| --- | --- | --- |
| World name/summary/tone/rules | 库概览及rule条目 | 保留原文；不让简介覆盖详细规则；新稳定ID只分配一次 |
| characters/locations/factions/codex | 对应Library条目 | 原始定义和世界实例自定义字段分别预览；有改写时按adaptation，不伪称纯reference |
| World binding | source身份+revision | world scope零实体引用也不能丢；共享binding多实体引用不得合并实体 |
| Timeline | event条目+派生时间线 | canon仅兼容映射historical；未知/null/缺失保留在迁移证据并提示，禁止强猜事实 |
| 实体关系/总部/地点 | 库内稳定ID关系/事件引用 | 先建立完整ID映射再连边；悬空项必须人工处理或显式排除 |
| 作品Lore | 条目及loadMode | 尊重实际保存档位；major不自动升resident；重名不自动合并 |
| Master引用 | source.kind=master | 固定版本且可解析才reference；未知版本显式unverified，不能造hash |

不让legacy source指针成为保留旧系统才能读取正文的依赖：
- 纯Master引用保留reference；
- 旧World/Lore人工确认的正文复制进新库作为adaptation，并记录旧来源身份/版本；
- 原旧文件保留为审计/回滚资料，不再与新库双向同步。

## 4. 计划与回执形状（内部草案，不是HTTP）

MigrationPlan：
- planVersion、sourceKind、受控sourceId、sourceRevision、mappingVersion；
- 目标库预览与旧ID→新ID映射；
- conflicts/omissions/warnings、预计字节数；
- planFingerprint（规范序列化哈希，包含所有输入版本与用户选择）。

MigrationReceipt：
- fingerprint、targetLibraryId、writtenRevision、完成时间、核验结论；
- 仅必要ID/版本/计数；无Key、正文或绝对来源路径。

回执是导入审计，不是新的设定真源；库内容仍只在Library。
回执原子提交与崩溃恢复、是否需要受控本地journal须在L4.2锁定，不能先写目标再“尽力记录”造成无法幂等。
第一版每次一个源作品到一个新库；多作品批处理、合并到已有库延后，避免多文件事务假原子。

## 5. 幂等、备份与回滚

- 相同指纹再次apply：返回原结果，不重复创建；不同版本/选择必须生成新计划并再确认。
- 备份限用户明确选中的输入；核验hash与可读性；禁止复制整块D盘或含密钥的配置目录。
- 失败不得删除输入；目标库原子写失败不得留下半JSON。
- apply后用户已修改新库：回滚必须检查writtenRevision，冲突时保留用户改动并提示，禁止覆盖/删除。
- 未修改目标的回滚：优先可恢复归档；数据恢复前再次验证目标路径和备份hash。
- 重启中断恢复：只依据持久化回执/受控journal和真实文件核对，不根据聊天推断。
- 自动退役旧入口、删除旧目录、重建Obsidian均不属于apply；另需用户确认与验收。

## 6. 批次、范围、验收

| 批次 | 拟文件范围 | 验收 |
| --- | --- | --- |
| L4.1 只读盘点与映射 | internal/librarymigration/纯函数+虚构fixtures | 输入不变；共享binding/world scope不丢；重名稳定ID；八态时间线；损坏/未解析项可见 |
| L4.2 dry-run预览 | app受控读取、独立DTO/前端预览（路径待定） | 零写入；任意路径拒绝；前后输入hash一致；确认指纹覆盖全部输入 |
| L4.3 显式apply与恢复 | 独立application服务+受控备份/receipt | 幂等重放；崩溃注入；CAS冲突；中断恢复；源不变；回滚不伤用户后续编辑 |
| L4.4 产品切换 | 来源提示/默认入口/兼容文档 | 新库真实模式可用；用户批准后才退役旧入口；旧数据仍可恢复 |

每批单独commit，迁移纯函数、HTTP、UI、真实数据apply不能伪装成一次“整理文件”。
L4.3之前使用虚构fixtures或用户明确选择的副本；不得先在重要用户世界上试错。

## 7. 明确延期

多源自动融合、AI消歧、重复实体自动合并、全盘扫描、批量删旧目录、知识图谱/Obsidian写回、剧情导入设定、自动迁移所有书籍。
这些都不是骨架授权，任何后续AI不得靠“更完整”自行加入。
