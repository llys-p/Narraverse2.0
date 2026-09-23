# L2 作品设定库只读加载契约

日期：2026-09-22。配套 LIBRARY_RUNTIME_IMPLEMENTATION_PLAN.md；只覆盖 L2，非四模式送模承诺。

## 所有权与数据流

已保存 Library + expectedRevision → 纯选择计划 → 必要来源只读解析 → 有界 Preview。
Library 是作品确认设定真源；Master 是引用原件。Preview 仅请求内派生，不落盘、不进 Registry/Task、无模型调用。
original/adaptation 读取库内 content/fields；reference 不信任本地缓存正文，只读取指定版本的 Master。

## 三档与选择

- enabled=false 从目录与正文排除，显式请求同样拒绝。
- resident：自动读取正文；auto：默认仅目录，autoItemIds 指定后才读取正文；manual：仅 manualItemIds 明确选择后读取。
- ID 去重并按 ID 排序；未知 ID、错档位、禁用 ID 整体 selection_invalid，不返回部分成功。
- 名称不是身份；同名不合并。purpose 不是权限。
- 自动目录按稳定 ID 分页，默认 50、最多 100；返回 total/offset/nextOffset，不能静默截断。
- 单次最多读取 64 条正文；超出预算明确失败，不偷偷降档或截断正文。
- 关系仅保留本次成功读取正文的两端；事件参与者/地点同样按此集合裁剪。关系不递归扩展读取权限。

## 来源

仅 reference 触发来源解析；resolver 只支持已登记 master，locator 非空暂不支持，不解释为文件路径。
只读取安全设定字段及 lorebook 条目，不透传 Original、路径、处理日志、提示配置或运行语义。
Master 必须 usable，固定 revision 非空且与当前 MasterRevision 相等；不匹配返回 source_changed，不自动接受最新版。
来源失败按条目返回 source_missing/source_changed/source_unavailable/source_unsupported/source_unverified；该条目不进入 loaded。
original/adaptation 不因 Master 变化被覆盖。无书籍时本库内容仍可预览；Master 不可用单独告警。

## 预算

集中常量：最终 Preview JSON ≤256 KiB；正文数≤64；估算 token≤16000。
估算公式：序列化结果 ASCII 码位每 3 个估 1 token（向上取整），非 ASCII 每码位估 2 token。
该估算仅用于预览保护，非模型实际 tokenizer/上下文窗口保证；L3 须再扣系统提示、历史、输出预算。
所有字段和元信息都计入最终 JSON 预算；预算统计迭代至数值稳定。超限整体 budget_exceeded，无正文截断。

## HTTP（已接线并完成本地正式页面验收，未提交）

POST /api/work-libraries/:id/context-preview

请求：expectedRevision 必填非空；manualItemIds/autoItemIds 可省略空数组；catalogOffset 默认0；catalogLimit 默认50（1–100）。
仅上述5个精确 camelCase 键合法，拒重复键、未知键、null、错型、尾随JSON；外层≤256 KiB。
响应：libraryId/revision/name/summary/tone/startingPoint/catalog/loaded/relations/issues/budget。
catalog={items:[{itemId,name,type,briefDescription,tags,keywords}],total,offset,nextOffset?}。
loaded=[{itemId,name,type,loadMode,origin,content,fields,event?,sourceRevision?}]；issues=[{itemId,code}]。
顶层 loaded/relations/issues、catalog.items 及目录 tags/keywords 空数组始终 []。可选 event 沿用现有 WorkLibraryEventDetail 传输契约，空的可选 participantItemIds 可省略，消费端按空集合处理；不改变已持久化事件 schema。错误固定 {error,code}，不含路径/来源正文/内部运行身份。
400 invalid_request/selection_invalid；404 library_not_found；409 revision_conflict；413 budget_exceeded；500 library_unavailable。

## UI 与验收

保存后主动点击预览；草稿未保存禁用生成。请求/选择/库revision改变使旧结果过期；切库和卸载废弃迟到结果。
明确标注“加载预览，尚未发送模型”；目录与正文分开展示，来源失败可见，不假装已加载。
测试：三档、禁用、重复名、ID去重、闭包裁剪、来源版本/404/不可用、预算边界、输入不变、严格HTTP、并发预览、库及原件哈希不变、真实页面与重启。

## 后续不变量

本期不读任意文件、不接旧World迁移、不自动全文检索、不自动扫描所有Master、不构造模型运行身份。
L3 才接模式实际请求，复用本核心但另做运行期预算与临时注入验证；不得把本Preview持久化为新真源。
