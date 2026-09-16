# 模块四：开放沙盒文字 RPG 实施计划

> 状态：执行基线 v1
> 工作分支：`feature/module-four`
> 执行角色：ChatGPT 负责产品/架构/任务拆分/验收；Codex 负责按任务实现、测试、提交 PR。
> 原则：Codex 不负责重新设计产品，不得自行扩大范围。

---

## 0. 先读这些现有资料

Codex 开工前先阅读并遵守：

1. 根目录 `AGENTS.md`
2. 根目录 `AI协作指南.md`
3. 根目录 `代码指南.md` / `CODE_GUIDE.md`
4. 根目录 `DESIGN.md`
5. 现有 `app/index.html`、`app/app.js`、`app/bridge.js`

需要理解现有 Narraverse 的公共能力后，再开始当前 Task。不要把模块四做成一套脱离现有平台的第二系统。

---

# 1. 产品目标

在现有 Narraverse 中增加独立的“模块四：开放沙盒文字 RPG”。模块四与模块三并列，但共享平台底层能力。

模块四核心体验：

- 玩家导入/选择一个世界设定和若干角色。
- 世界不是等待玩家触发剧情，而是每天先自行运行。
- 重要 NPC 每天先生成早 / 中 / 晚三段日程骨架，以及心情、目标、特殊安排等短状态。
- 玩家有自己的时间、位置、精力和生活牵引。
- 玩家行动会与 NPC 已存在的日程发生自然碰撞。
- 玩家可以主动寻找、邀请、帮忙、探索，也可以通过自由输入表达动作。
- 玩家行为不保证成功，关键行为采用综合判定：成功 / 代价成功 / 失败 / 严重失败。
- 玩家介入后可以改写 NPC 当天后续安排。
- 已发生事实必须持久化，并影响后续日期。
- UI 按场景需要出现，不永久堆满所有系统。

第一阶段最终要证明的不是“AI 会聊天”，而是：**世界会自己运行，而且玩家可以改变它。**

---

# 2. 第一阶段最小可玩闭环

必须实现以下主循环：

```text
创建世界
→ 导入/选择角色和世界资料
→ 第 1 天开始
→ AI 预演重要 NPC 当日日程
→ 玩家执行早 / 中 / 晚三次主要行动
→ 按地点和日程检查自然相遇
→ 产生对话或行动
→ 必要时执行综合判定
→ 更新玩家 / NPC / 世界状态
→ 玩家行为可改写 NPC 后续日程
→ 日结算
→ 保存事实与日志
→ 第 2 天重新预演
```

阶段验收至少连续运行 3 个完整游戏日，不能出现核心状态丢失、刷新失档、NPC 已被约走却仍出现在旧地点等一致性错误。

---

# 3. P0 功能范围

第一阶段必须完成：

- 模块四独立入口。
- 独立世界/冒险列表。
- 创建、打开、删除模块四世界。
- 世界名称、世界说明、玩家身份。
- 复用现有角色/世界资料来源。
- 第几天。
- 早 / 中 / 晚三个时段。
- 玩家当前位置。
- 玩家精力。
- NPC Runtime。
- 每日 NPC 日程预演。
- 地点移动。
- 自然相遇。
- 主动寻找人物。
- 推荐行动。
- 自由输入。
- 统一 Action 模型。
- 关键动作综合判定。
- 四档结果：成功 / 代价成功 / 失败 / 严重失败。
- 玩家行为改写 NPC 后续日程。
- 世界事实记录。
- 每日日志。
- 自动保存。
- 页面刷新后恢复当前世界。

---

# 4. 第一阶段明确不做

禁止顺手实现以下内容：

- 完整战斗系统。
- 复杂技能树。
- 传统骰子系统。
- 导演台。
- 重度经营。
- CG 收集。
- 完整恋爱系统。
- NSFW 专属玩法系统。
- 多玩家。
- 分钟级时间轴。
- 全地图永久展示所有 NPC 实时位置。
- 复杂 Agent 系统。
- 新的 Denova Go 后端。
- 模块四专属 API 配置页面。
- 大型地图编辑器。
- 为“以后可能需要”提前建设的泛化平台功能。

出现超出当前范围的新需求时，停止并报告，不自行扩大实现。

---

# 5. 架构硬规则

## 5.1 不复制模块三

禁止复制或改造成模块四核心：

- `app/app.js` 整体或大段复制。
- 现有 `createAdventure()` 巨型 Adventure 数据模型。
- `buildSystemPrompt()`。
- `parseGameResponse()`。
- `applyParsedResult()`。
- 模块三固定 `[NARRATIVE][STATE][CHANGES][CHOICES][QUESTS][COMBAT][CHARACTERS][PLOT]` 输出协议。
- 旧骰子逻辑。
- 旧 Combat。
- 旧 Quests。
- 旧 Plot Nodes / Director 类推进逻辑。

模块四必须拥有独立 World Runtime。

## 5.2 不新增模块四 API 配置

模块四第一版必须复用现有平台的模型请求能力和现有 API 配置。

禁止出现：

- `module4ApiConfig`
- `module4ApiKey`
- `module4Endpoint`
- `module4Model`
- 任何第二套模型设置 UI

可以复用“请求模型”的运输层，但不能复用模块三玩法 Prompt 协议。

## 5.3 资料原件与 Runtime 分离

角色卡/世界设定表示“原始资料”。

模块四 Runtime 表示：

- NPC 今天在哪里。
- NPC 当前心情。
- NPC 当前关系。
- NPC 当前目标。
- NPC 最近发生了什么。
- NPC 今日已被如何改写日程。

模块四运行产生的数据不得写回角色卡原件、世界原件或 Master 原始资料。

## 5.4 第一阶段不改 Denova Go 后端

模块四第一阶段只在现有 `app/` 侧建立玩法闭环。

禁止为了模块四第一阶段增加：

- 新 Go API。
- 新 Master schema。
- 新 Agent。
- 新 Recovery。
- 新 Translation Queue 行为。

如果发现现有公共能力确实无法满足，先停止并报告缺口。

## 5.5 不继续把主要逻辑塞进 `app.js`

允许对 `app/app.js` 做少量公共接入改动，但模块四业务逻辑必须放在 `app/module4/`。

---

# 6. 建议目录结构

建立：

```text
app/
└─ module4/
   ├─ module4.js
   │
   ├─ core/
   │  ├─ world.js
   │  ├─ clock.js
   │  ├─ schedule.js
   │  ├─ action.js
   │  └─ judgment.js
   │
   ├─ ai/
   │  ├─ prompts.js
   │  ├─ preview.js
   │  └─ interaction.js
   │
   ├─ state/
   │  ├─ store.js
   │  └─ migrations.js
   │
   └─ ui/
      ├─ shell.js
      ├─ world-list.js
      ├─ world-create.js
      ├─ play-view.js
      └─ components.js
```

这是建议结构。如果现有静态加载约束导致某个文件需要合并，可在不破坏职责边界的前提下小幅调整，但必须在 PR 里说明原因。

Narraverse 当前是无构建步骤的静态 SPA。模块四第一阶段禁止单独引入 React、Vite、Webpack 或新的构建系统。

模块四脚本共享命名空间建议统一为：

```js
window.Module4 = window.Module4 || {};
```

例如：

```js
Module4.Store = ...
Module4.World = ...
Module4.Clock = ...
Module4.Schedule = ...
Module4.UI = ...
```

避免污染更多顶级全局变量。

---

# 7. 脚本接入规则

只对 `app/index.html` 做必要的最小接入。

不得为了模块四大幅重排现有脚本加载顺序。

模块四内部需要保证依赖顺序正确，最终 `module4.js` 作为模块四入口初始化。

如果模块四需要调用现有 `callLLM` 等公共能力，应通过小型 adapter/公共函数引用，不要复制请求实现。

---

# 8. Module4 World 数据模型

第一版建立独立 `Module4World`，不要把字段继续塞入旧 Adventure。

建议最低结构：

```js
{
  id,
  title,
  createdAt,
  updatedAt,

  source: {
    worldRefs: [],
    characterRefs: []
  },

  player: {
    name,
    identity,
    location,
    energy,
    maxEnergy,
    attributes: {}
  },

  clock: {
    day: 1,
    period: "morning"
  },

  locations: [],
  npcs: {},

  currentDay: {
    previewGenerated: false,
    schedules: {},
    events: []
  },

  facts: [],
  logs: [],
  settings: {}
}
```

NPC Runtime 最低结构建议：

```js
{
  id,
  sourceRef,
  name,

  relation: {
    stage,
    value
  },

  mood,
  temporaryState: [],
  goals: [],
  memories: [],

  schedule: {
    morning: {},
    afternoon: {},
    evening: {}
  }
}
```

具体字段可以根据现有资料结构适配，但必须保持“原始角色资料”和“本局 Runtime”分离。

---

# 9. 日程模型

每个重要 NPC 每天只生成三段骨架。

建议单段：

```js
{
  period: "morning",
  locationId: "library",
  activity: "study",
  intent: "finish_report",
  mood: "neutral",
  availability: "normal"
}
```

每日预演阶段禁止生成：

- 完整对白。
- 完整场景小说。
- 大段心理描写。
- 玩家尚未观察到的完整剧情文本。

预演只回答：“这个 NPC 今天原本准备怎么过。”

---

# 10. 时间系统

第一版只支持：

- `morning` = 早
- `afternoon` = 中
- `evening` = 晚

一次主要行动推进一个时段：

```text
早 → 中
中 → 晚
晚 → 日结算 → 次日早
```

允许以下免费操作不推进时间：

- 查看人物。
- 查看地点/地图信息。
- 查看日志。
- 查看当前状态。
- 纯信息查询类 UI 操作。

---

# 11. 精力系统

目的：限制玩家一天连续执行高消耗活动，让玩家有取舍，不做重度生存管理。

数值必须集中定义，禁止散落在 UI 中。

第一版可用简单默认值，例如：

```text
闲聊          5
短移动        5
学习         10
帮忙         10
探索         15
训练         20
高强度活动   25
```

具体数值后续可调整。

精力不足：

- 不允许执行明显超出剩余精力的高消耗动作。
- UI/系统返回原因。
- 尽可能给出低消耗替代操作。

睡眠/跨日按统一规则恢复精力。

---

# 12. 每日世界预演

`startDay()` 逻辑：

```text
读取当前世界状态
→ 读取重要 NPC
→ 读取最近关键事实
→ 构建 Daily Preview Prompt
→ 调用现有公共 LLM 请求能力
→ 取得结构化结果
→ 校验 NPC ID / 地点 ID / 三时段完整性
→ 写入 currentDay
→ 保存
→ 显示当天早晨
```

建议模型返回：

```json
{
  "npcs": [
    {
      "npcId": "npc_001",
      "mood": "neutral",
      "goal": "finish_report",
      "schedule": {
        "morning": {
          "locationId": "classroom",
          "activity": "attend_class"
        },
        "afternoon": {
          "locationId": "library",
          "activity": "study"
        },
        "evening": {
          "locationId": "dorm",
          "activity": "rest"
        }
      }
    }
  ],
  "worldEvents": []
}
```

要求：

- 当天预演生成后持久化。
- 同一天重新进入/刷新不能无故重新生成另一套日程。
- 结构解析失败不能破坏现有世界。
- 允许一次重试。
- 仍失败时使用最小 fallback 日程，保证游戏可继续。

---

# 13. 统一 Action 模型

模块四核心不是“发送聊天消息”，而是“玩家执行行动”。

主要行为统一转换为 Action。

例：

```js
{
  type: "move",
  target: "library"
}
```

```js
{
  type: "invite",
  npcId: "npc_001",
  intent: "go_to_town"
}
```

自由输入：

```text
我想帮她整理报告
```

解析为：

```js
{
  type: "custom",
  targetNpcId: "npc_001",
  intent: "help_finish_report",
  rawText: "我想帮她整理报告"
}
```

推荐按钮与自由输入最终必须进入同一 Action 执行链。

---

# 14. 自然相遇

相遇判定必须基于：

```text
当前时段
+
玩家当前地点
+
NPC 当前有效日程
```

例：

```text
下午
玩家进入图书馆
NPC A 下午有效日程 = 图书馆
```

则 NPC A 可自然出现。

如果 NPC A 上午在教室，玩家上午去图书馆：

- 不允许为了迎合玩家而强制生成 NPC A。
- 可以返回“没有遇见”。

主动寻找人物也必须遵守同一套当前有效日程，不得绕过世界状态。

---

# 15. 日程改写

这是 P0，不能后补。

例：

```text
NPC A 下午原计划：图书馆学习
```

玩家中午邀请 NPC A 下午去商业街，判定成功后：

```text
NPC A 下午有效日程：商业街，与玩家同行
旧计划：图书馆学习（取消/被替换）
```

后续所有系统必须读取改写后的有效日程。

硬性一致性：

- 下午商业街可以遇到 NPC A。
- 下午图书馆不得再次生成 NPC A 仍在原计划地点。

建议保留计划改写元数据，以便调试：原计划、改写原因、改写来源 Action、时间戳。

---

# 16. 行动判定

不是所有动作都需要判定。

一般不判定：

- 正常移动到可到达地点。
- 正常吃饭。
- 回宿舍。
- 查看资料。
- 普通无冲突聊天。

存在不确定性、阻力或风险时才判定。

判定输入可包含：

- 玩家相关能力。
- 当前精力/状态。
- 环境难度。
- NPC 当前关系。
- NPC 心情。
- NPC 当天安排。
- 当前场合。
- 少量随机因素。

结果固定为：

```text
success
costly_success
failure
critical_failure
```

中文展示：

- 成功
- 代价成功
- 失败
- 严重失败

失败默认产生后果，不默认 Game Over。

结果必须至少改变以下之一：

- NPC 关系。
- NPC 心情。
- 玩家精力/状态。
- 世界事实。
- 当日日程。
- 某个机会/事件状态。

---

# 17. 世界事实 Facts

不要依赖无限增长的完整聊天历史维护世界一致性。

关键已发生事实必须单独记录。

建议：

```js
{
  id,
  day,
  period,
  type,
  actors: [],
  summary,
  persistent: true
}
```

例：

```text
第 3 天下午：玩家帮助艾琳完成魔药报告。
第 3 天晚上：艾琳答应第 5 天和玩家参加学院活动。
```

后续 Prompt 优先读取：

```text
NPC 原始资料
+ 当前 NPC Runtime
+ 近期关键 Facts
+ 当前日有效日程
```

而不是简单把完整对话全部塞入上下文。

---

# 18. 日结算

晚上主要行动结束后执行：

```text
收尾未交互 NPC 的当日状态
→ 应用当日状态变化
→ 生成短日志
→ 保留需要进入后续日期的 Facts
→ 清理仅当天有效的临时状态
→ day + 1
→ 恢复精力
→ 新一天 Daily Preview
```

日结算日志保持简短，不生成长篇小说。

例：

```text
第 3 天
你上午参加了魔药课。
下午在图书馆帮助艾琳完成报告。
晚上错过了社团招新。
艾琳现在对你更信任。
你们约定第 5 天一起参加学院活动。
```

---

# 19. UI 方向

继承现有 Narraverse 设计系统，不新建第二套主题。

模块四主结构建议：

```text
左栏：世界/存档列表
中栏：当前场景 + 叙事 + 推荐操作 + 自由输入
右栏：按当前情境出现的状态组件
```

常驻只显示：

- 第几天。
- 早 / 中 / 晚。
- 当前位置。
- 精力。
- 主要行动入口。

遇到 NPC 后才出现：

- NPC 信息。
- 关系信息。
- NPC 相关互动。

探索时才强化地点组件。

第一阶段没有战斗，因此不要生成战斗 UI。

移动端必须继续遵守现有 Narraverse 响应式和嵌入 Denova 行为，不制造第二套移动端外壳。

---

# 20. 公共能力与模块四私有能力边界

| 能力 | 归属 |
|---|---|
| API 地址 / Key / 模型 | 公共，复用 |
| 模型请求客户端 | 公共，复用 |
| 现有角色资料 | 公共，复用 |
| 现有世界/Lore资料 | 公共，复用 |
| Denova Bridge | 公共，复用 |
| 视觉主题 | 公共，复用 |
| 基础本地持久化机制 | 公共能力，按模块四命名空间使用 |
| 世界时间 | 模块四 |
| 玩家精力 | 模块四 |
| NPC Runtime | 模块四 |
| 每日 NPC 预演 | 模块四 |
| 日程改写 | 模块四 |
| 自然相遇 | 模块四 |
| Action 解析/执行 | 模块四 |
| 综合判定 | 模块四 |
| 日结算 | 模块四 |
| 世界 Facts | 模块四 |
| 模块四日志 | 模块四 |
| 动态情境 UI | 模块四 |

---

# 21. 开发任务拆分

必须按 Task 小步提交，不要一个 PR 实现全部模块四。

## Task 0 — Module4 Skeleton

目标：只建立架构骨架，不做玩法。

允许修改：

- `app/index.html` 必要接入。
- 新建 `app/module4/**`。
- 如确有必要，对现有公共入口做极小 adapter 改动。

实现：

- 创建上述模块四目录结构。
- 建立 `window.Module4` namespace。
- 增加模块四顶层入口。
- 模块四可以进入独立空页面/空工作区。
- 可以从模块四返回原有模式。
- 复用现有主题/宿主环境。
- 不新增 API 配置。
- 不改变模块三 Adventure 数据。
- 不改 Denova Go 后端。

验收：

- Narraverse 正常启动。
- 原有模块/模块三仍能打开和使用。
- 模块四入口存在。
- 进入模块四显示独立工作区。
- 切回旧模块正常。
- Denova embedded 模式不出现双外壳或明显布局破坏。
- 所有新增 JS 可通过语法检查。

## Task 1 — Module4 Store + World CRUD

实现：

- 模块四独立 Store。
- 创建世界。
- 世界列表。
- 打开世界。
- 删除世界。
- 自动保存。
- 页面刷新恢复。
- 使用模块四专用存储 key/namespace，不污染旧 Adventure。

验收：

- 创建 3 个世界。
- 刷新浏览器后仍存在。
- 删除 1 个，另外 2 个不受影响。
- 原有模块三 Adventure 数据完全不变。

## Task 2 — Clock + Energy

实现：

- Day。
- Morning / Afternoon / Evening。
- 精力。
- 主要行动推进时间。
- 免费信息操作不推进。
- 跨日恢复精力。

验收：

```text
第1天早
→ 主要行动
→ 中
→ 主要行动
→ 晚
→ 主要行动
→ 第2天早
```

- 精力消耗正确。
- 精力恢复正确。
- 免费查看动作不推进时间。

## Task 3 — NPC Runtime + 现有资料接入

实现：

- 从已有角色资料建立 NPC Runtime。
- Runtime 与 sourceRef 关联。
- Runtime 状态单独保存。
- 不写回原始角色资料。

验收：

- 导入 3 个角色。
- 原始资料保持不变。
- Runtime 的 mood / relation / schedule 可以独立变化。
- 刷新后 Runtime 保留。

## Task 4 — Daily Preview

实现：

- Daily Preview Prompt。
- 调用现有公共 LLM 请求能力。
- 结构化解析。
- NPC/地点引用校验。
- 同日不重复生成。
- 失败重试和 fallback。

验收：

- 3 个 NPC 每天都有早 / 中 / 晚日程骨架。
- 预演结果不包含完整剧情正文。
- 刷新/重新进入当天不会无故变成另一套日程。
- AI 结构失败时世界仍可继续。

## Task 5 — Location + Encounter

实现：

- 地点。
- 移动。
- 主动寻找。
- 基于当前有效日程的自然相遇。
- 合理的“没有遇到”。

验收：

- NPC 下午日程为图书馆，玩家下午去图书馆可遇见。
- 同 NPC 上午日程为教室，玩家上午去图书馆不得强制遇见。

## Task 6 — Recommended Actions + Free Input

实现：

- 每个情境 2–5 个推荐行动。
- 自由输入。
- 统一 Action Parser/Normalizer。
- 推荐按钮与自由输入最终进入同一执行管线。

验收：

同一场景中：

- 点击“打招呼”。
- 输入“我帮她整理桌上的资料”。

两者都能转换为规范 Action 并执行。

## Task 7 — Judgment

实现：

- 判断动作是否需要判定。
- 四档结果。
- 状态后果。
- 无需判定动作直接执行。

验收：

- 同一个邀请动作，在关系/心情/日程不同情况下可产生不同结果。
- 失败不会默认 Game Over。
- 判定结果会留下实际状态后果。

## Task 8 — Schedule Rewrite

实现：

- 玩家行动成功后修改 NPC 后续有效日程。
- 保存原计划与改写信息用于一致性/调试。

硬性验收：

```text
艾琳下午原定：图书馆
中午玩家成功邀请她下午去商业街
```

下午必须满足：

- 商业街可以遇到艾琳。
- 图书馆不能再遇到艾琳。

## Task 9 — Facts + Day Settlement

实现：

- 世界关键 Facts。
- 日结算。
- 短日志。
- 跨日保留关键事实。
- 次日预演读取前日关键事实。

验收：

- 连续运行 3 天。
- 第 1 天发生的关键事实在第 3 天仍可被系统读取。
- 刷新页面后 Facts/日志不丢失。

## Task 10 — P0 整体验收

建立固定测试世界：

```text
魔法大学

地点：
宿舍
教室
食堂
图书馆
商业街

NPC：3 人
```

连续模拟至少 3 天。

必须验证：

- 时间正确。
- 精力正确。
- NPC 每日预演存在。
- 自然相遇存在。
- 合理的未遇见存在。
- 推荐操作和自由输入都可执行。
- 邀请可被判定。
- 成功邀请可改写日程。
- 失败产生后果但不会直接结束游戏。
- Facts 跨天存在。
- 日志正确。
- 刷新不丢状态。
- 模块三未损坏。

---

# 22. 测试要求

每个 PR 至少执行并报告：

- `node --check app/app.js`
- 对所有新增 `app/module4/**/*.js` 执行 `node --check`。
- 现有可用的 Narraverse headless/regression harness。

应尽早增加模块四最小 headless 测试，至少覆盖：

- 时间推进。
- 精力变化。
- World Store CRUD。
- 同日预演幂等。
- 自然相遇。
- 日程改写一致性。
- Facts 跨日。

人工检查：

- Standalone Narraverse。
- Denova embedded Narraverse。
- 原有模块三。
- 模块四。
- 页面刷新恢复。

不要为了让测试变绿而修改无关旧逻辑。

---

# 23. PR 规则

不要创建一个巨型“Implement Module 4” PR。

建议按以下顺序：

1. PR 1 — Module4 Skeleton
2. PR 2 — World Store
3. PR 3 — Clock + Energy
4. PR 4 — NPC Runtime
5. PR 5 — Daily Preview
6. PR 6 — Encounter
7. PR 7 — Actions
8. PR 8 — Judgment
9. PR 9 — Schedule Rewrite
10. PR 10 — Facts + Day Settlement

每个 PR 必须写明：

- 本 PR 对应 Task 编号。
- 做了什么。
- 明确没做什么。
- 改了哪些文件。
- 测试命令与结果。
- 已知限制。
- 是否触碰任何公共边界。

默认 PR 基线应围绕 `feature/module-four` 工作，不要未经指示直接把未验收模块四功能合并到 `main`。

---

# 24. 禁止事项

以下规则为硬约束：

- 不得为了方便复制现有 Adventure / Game Engine。
- 不得把模块四主要逻辑继续加入 `app.js`。
- 不得新建模块四专属模型/API 配置。
- 不得修改 Master Library 原始资料。
- 不得第一阶段修改 Denova Go 后端。
- 不得实现未列入当前 Task 的大型功能。
- 不得改变模块三固定 LLM 协议。
- 不得删除或重构旧功能来“顺便整理代码”。
- 不得在一个 PR 中同时进行大规模旧架构重构和模块四玩法开发。
- 不得把“玩家说了什么”默认等同于“世界已经发生什么”。
- 不得让 AI 临时重写已经确定且尚未被正式 Action 改写的世界事实。
- 遇到必须跨越上述边界的情况，停止并报告，不自行扩大范围。

---

# 25. P0 最终验收场景

最终必须可以完成以下实际体验：

> 玩家创建一个魔法大学世界，加入三个 NPC。第 1 天开始前，三个 NPC 已经各自有早、中、晚安排。玩家早上去上课，中午去图书馆，碰见原本就在那里的 NPC；玩家邀请她下午去商业街，成功后她下午的日程被改写。下午玩家在商业街能遇见她，而图书馆不能再生成她仍在原处。晚上其他 NPC 继续按自己的生活行动。日结算后进入第 2 天，NPC 根据昨天发生的事情产生新的状态和安排。刷新浏览器后，世界仍处于正确状态。连续运行 3 天后，关键事实仍然一致。

仅达到以下效果不算完成：

- AI 可以聊天。
- 页面有 RPG 风格按钮。
- 能显示角色卡。
- 能生成一段故事。

真正验收标准只有一句：

**世界会自己运行，而且玩家能够改变它。**

---

# 26. Codex 工作协议

Codex 每次只处理当前明确指定的 Task。

执行步骤：

1. 阅读本实施计划与项目协作规范。
2. 阅读当前 Task 涉及的现有代码。
3. 先写“现状判断 + 预计改动文件 + 风险”，不要立刻扩大范围。
4. 实现当前 Task。
5. 运行测试。
6. 检查是否触碰禁止事项。
7. 汇报结果。
8. 提交对应 PR，等待审查。

如果实现过程中发现实施计划与当前仓库实际结构冲突：

- 不要自行重构整个项目。
- 只记录冲突点、原因、最小替代方案。
- 停止在架构边界处，等待新的决定。

---

# 27. 当前开工指令

当前只执行 **Task 0 — Module4 Skeleton**。

不要提前实现 Task 1 及之后的世界存储、时间、NPC、预演、判定等玩法功能。

Task 0 完成后提交 PR，并提供：

- 改动摘要。
- 文件清单。
- 测试结果。
- 模块四入口如何打开。
- 对现有模块三/Denova embedded 的回归结果。
- 任何发现的架构风险。

等待审查通过后再进入 Task 1。
