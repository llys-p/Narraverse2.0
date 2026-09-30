# P3-A 定稿：云端人物主动性与信号适配（口径 v1）

日期：2026-09-25。代码基线：`laya-p2-safe / df84df8`（P2-C 页面已留档）。
审核断档期间按用户要求每步留档；本文为本阶段**口径定稿**（替代原「先等 Codex 定口径」），待审核回归。

## 1. 定位与已定取舍（对齐 plan.md §6.3 / P2-A §7）

| 决定 | 边界 |
|---|---|
| 主动性归云端 | DeepSeek 根据人物目标、已提交状态、参考信号与对话自然追问、表态、给有限线索、可换话题；**不恢复 Laya 强选动作**（plan.md 决定 5） |
| 区分「表现」与「事件」 | 提示词明确：分数/信号只影响**语气、立场、试探策略**，绝不等于「事件已发生」；秘密、场景切换、世界事件仍受剧情约束 |
| 已提交状态是唯一权威 | 数值只读注入；**不因分数高泄露秘密、修改数值、替玩家决定** |
| 参考信号不冒充事实 | known/auxiliary 仅作「参考资料」，标注不改状态；unknown 不填 0；不把 confidence/熵当真实概率 |
| 提问规则调整但**不强制** | analysis 模式放宽「一律禁止结尾提问」（旧 legacy 行为保留不动）；允许自然追问，但**不要求每轮提问或推进** |
| 云端失败明确反馈 | 保留 502 + `state_source/state_version`（状态已确认，回复可重试）；不把推理内容/理由展示成台词；禁止无限重试 |

显式不做：不新增情感标签、不改 Laya 判断、不写状态、不接旧 `/decide` 行为、不进入 P3-B 的 6 组对照（最多 12 次云端生成，待授权）。

## 2. 输入分块（送 DeepSeek 的结构）

mode=analysis 的叙事输入按以下**分块**注入 `_build_narrate_prompt` 的扩展分支：

1. **[人物设定]**（不变）：identity/personality/traits/situation/goals 模板字段。
2. **[已提交状态]**（权威）：当前 `relationship/emotion/goals` 的数值行（`state_line`），并标注「这是服务器已提交的**当前数值**，写作时只用来校准语气，不要在文本里念数字」。
3. **[本轮判断参考]**（非事实）：`analysis.signals` 中 `availability=known` 的条目 + `writable_delta`（标注为**候选建议**：未提交前不当作已变化）；auxiliary 标注「仅供参考、不改状态」。
4. **[原文与上下文]**：`message`（本轮玩家原话）+ `context.history`（最近 ≤8 条对话） + `context.scene`（本轮场景提示，非场景切换）。
5. **[表现规则]**：允许自然追问 / 立场表达 / 有限线索 / 话题转换；**不强制**每轮提问或推进；区分「角色可以这样表现」与「事件已经发生」。

## 3. 提示词改造（最小 diff，只影响 analysis 模式）

- `_build_narrate_prompt` 新增参数：`proactive=True`（允许自然提问等）与 `signals_block: str|None`（参考信号块）、`scene: str|None`。
- analysis 模式规则集（与 legacy 分支并存，legacy 行为/规则 3 不动）：
  ```
  4) 可对玩家自然追问、表达立场、透露有限线索或转换话题；
     不要每轮都提问，也不要强行推进剧情。
  5) 你只调整语气与试探策略：数值和信号是「角色此刻的感受倾向」，
     不是已发生的事实；不得据此泄露秘密、改名数值或替玩家做决定。
  ```
- `signals_block` 为空或不可用时：不注入该块，规则 4/5 仍生效（降级不报错）。

## 4. 实现落点

- `laya_bridge.py`：
  - `_build_narrate_prompt(...)` 增加 `proactive=False, signals_block=None, scene=None`；`proactive=True` 时走新规则分支。
  - `llm_narrate(...)` 增加透传参数 `proactive=False, signals_block=None, scene=None`。
  - `/narrate mode=analysis` handler：把 `narrate_context` 返回的 `signals`（known）与 `context.scene` 组装成 `signals_block`；以 `proactive=True` 调用 `llm_narrate`。**不改** legacy/upstream 分支语义（§7 边界）。
- `tests/p3a_unit.py`（零模型）：prompt 分块存在性（已提交状态 / 参考块 / 场景）、proactive 规则（允许提问/不强制推进/不泄露）、legacy 分支规则 3 保留、signals_block 缺失降级、handler 错误路径（云端失败 502 保留 state_source/state_version）。

## 5. P3-B 对照口径（后置，待授权；本阶段不执行）

- 6 组场景 × 无信号/有信号 = **最多 12 次**云端生成；先 1 组预热再批。
- 评价（五条，均需人读）：是否回应原话；保持人物；主动但不抢玩家决定；信号差异能否合理影响语气/策略；是否擅自改变事实。
- 明确不做：不以固定种子/数字阈值宣称创作质量；不自动扩大付费请求。

## 6. 验收

- P3-A 完成：`tests/p3a_unit.py` 通过；legacy 与 upstream 分支语义不变（p3p2 等回归无退化）；接口字段与 P2-C 一致。创作质量由 P3-B 对照评审，**本阶段不宣称已恢复「旧版有反应」的体验**。