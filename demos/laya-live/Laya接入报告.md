# Laya 决策引擎接入报告

> **读者：其他 AI 协作者。**
> 本文自包含，不依赖任何对话上下文。所有数字都是本机实测结果，不是估算。
> 最后更新：2026-09-23 17:20
>
> **怎么用这份文档**：如果你要接手 `laya-live/` 的工作，**先读第 6 节（实测数据）和第 7 节（环境约束）**，
> 那两节能省掉你最可能重复踩的几个小时。**然后读第 12 节（Decision Signals 实验）** ——
> 那是第二轮的全部结论与架构判定，也是**唯一能告诉你「Laya 到底该干什么」**的一节。
> 第 8 节是诚实缺陷清单，不要把它当成待修 bug 列表去逐条修。

---

## 1. 一句话结论

已经把 Laya（`github.com/NandhaKishorM/laya`，PyPI `laya` 0.3.5）接成了一个本地 HTTP 桥，
配上 DeepSeek-V4.1-Flash 做台词生成，前端是一个能实时输入的三栏演示页。

**能用，但有一个必须先知道的结论**：`choice` 原语即使按最优方式改写，区分度仍然偏弱；
`score` / `noul` 才是 Laya 可靠的原语。当前架构是
**「Laya 出决策信号 → Policy Resolver 出行为 → Story Agent 出台词」**。

**★ 第二轮结论（2026-09-23；48 条方向回归 + CPU/GPU 实测 + live 端到端）：
把职责从「选行为」下移到「出决策信号」之后，结论没有变好。**

| 问题 | 实测结果 |
|---|---|
| 决策信号方向准确率 | **49.5%**（typed-decisions）／ **51.5%**（english），差 2 条断言 = **抛硬币** |
| 人格是否影响决策 | 4 个人格的信号极差 **≤ 0.031**，全部低于噪声 → **不成立** |
| GPU 加速 | 完整 22 题 NPC tick：22 132 ms（CPU）→ **399 ms**（GPU）= **55×**；VRAM 峰值 2.93 GB |
| live 端到端 | 阈值**不可从夹具迁移到线上**：同一门限在夹具上「两侧有余量」，在 live 上恒真 |

**架构判定：B（仅部分能力可进入）与 C（不适合生产接入）之间，倾向 C。** 逐条证据见 §12.3。
一句话：**Laya 现在可以当低成本的场景倾向探测器，不能当行为决策权威。**

★ 本轮还修掉了三个**静默**缺陷（都不报错，只是让结果默默变错）：`/decide` 的键名陷阱、
遗留 noul 门限把**所有**输入都改写成 `ally`、`choice_baseline` 字段装的其实是门限改写后的值。
三个都记在 §12.5 —— 它们代表同一类风险：**这个系统倾向于「安静地给出一个看起来正常的答案」**。

---

## 2. 产物清单

工作目录：`C:\Users\11\WorkBuddy\2026-09-23-11-11-35\laya-live\`

| 文件 | 规模 | 作用 | 可以改吗 |
|---|---|---|---|
| `laya_bridge.py` | 2201 行 / 111 KB | HTTP 桥主程序。**只用标准库**，无第三方依赖（laya/torch 除外） | 改行为要动它 |
| `narra_config.json` | 310 行 / 17.8 KB | **决策模型本体**。角色、行为候选、问题集、增量映射、门限 | ★ 优先改这个，不用碰代码 |
| `laya-live-demo.html` | 782 行 / 45 KB | 三栏演示页（角色状态 / 对话 / 决策台）。单文件无依赖 | 可改 |
| `_fetch_laya.py` | — | 手工 HF 下载器。**绕开 `huggingface_hub`**，理由见 7.3 | 只在换检查点时要动 |
| `_gen_bat.py` | — | 生成 `启动Laya桥.bat`。**改 .bat 文案必须改这个再重跑**，见 7.5 | 可改 |
| `_shot.mjs` / `_probe_demo.mjs` | — | Edge + CDP 截图 / 读页面文本。零依赖（Node 21+ 自带 WebSocket） | 验收用 |
| `启动Laya桥.bat` | 1469 B | 双击启动器，GBK 无 BOM 编码 | **不要手改**，用 `_gen_bat.py` 重生成 |
| `.venv/` | — | laya 0.3.5 + torch 2.14.0+cpu + transformers 5.17.0 | — |
| `_models/laya-typed-decisions/` | 842 609 220 B | **当前默认检查点** | — |
| `_models/laya-english/` | 842 609 210 B | 备用（未启用） | — |
| `_diag/` | — | 全部诊断日志归档。排查问题先来这里 | — |

**关键代码位置**（`laya_bridge.py`）：

| 行号 | 内容 |
|---|---|
| 96 | `load_env_file()` —— `.env` 与系统环境变量的优先级规则 |
| 163–190 | `MODELS_DIR` / `DEFAULT_MODEL_NAME` / `find_local_models()` / `_free_phys_mb()` |
| 446 | `fallback_decide()` —— 不装 Laya 时的回退引擎 |
| 596 | `build_deltas()` —— score 期望值 → 状态增量，含人格归因 |
| 638 | `apply_gates()` —— ★ noul 门限覆盖 choice |
| 672–712 | `LINE_OPEN` / `_PLAN_MARKERS` / `extract_line()` —— ★ 台词结构化解析 |
| 747 | `llm_narrate()` —— 含「污染重试」逻辑 |
| 904–940 | `behavior_short_criteria()` / `build_laya_questions()`（含 `criteria_source` 解析） |
| 943 | `build_state_doc()` —— compact / full 两种 state 形态 |
| 1063 | `decide()` —— 决策主流程 |
| 1401 | `LANGTEST_CASES` —— ★ 四句极端反差测试输入 |
| 1637 | `cmd_qcheck()` —— 预算审计 |
| 1772 | `cmd_sanity()` —— A/B/C/D 对照诊断 |

---

## 3. 当前运行状态

桥正在 `http://127.0.0.1:8130` 上运行。启动加载检查点约 **45–70 秒**（冷启动），
期间 `/health` 不响应，这是正常的，不是卡死。

`/health` 已确认：`engine=laya`，`model_name=typed-decisions`，
`local_models=[english, typed-decisions]`，
`llm.ready=true`，`llm.env_overridden=[DEEPSEEK_API_KEY]`。

### 起停

```bash
# 起（前台）
laya-live/.venv/Scripts/python.exe -u laya_bridge.py

# 起（后台，AI 侧必须用 run_in_background，不能用 (cmd &)）
#   见 7.6：用 (cmd &) 启动的进程会被工具调用结束时的进程组清理带走

# 停（先拿 PID，再杀）
netstat -ano | grep LISTENING | grep ":8130" | awk '{print $NF}'
MSYS_NO_PATHCONV=1 taskkill /PID <pid> /F
```

注意：`taskkill //PID n //F` 在 Git Bash 里会失败（MSYS 把 `//PID` 当字面量），
必须加 `MSYS_NO_PATHCONV=1` 并用单个斜杠。

---

## 4. 接口契约

### 4.1 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 体检。含 Laya 真实 API 形状、已装预设、`env_overridden` |
| GET | `/config` | 原样返回 `narra_config.json` |
| GET | `/demo` | 演示页（由桥自己提供，避开 `file://` 的 opaque origin 跨源问题） |
| GET | `/history` | 最近 50 轮决策记录 |
| POST | `/decide` | **主流程**：state + questions → 行为分布 / 状态增量 / 导演裁决 |
| POST | `/world` | 世界层事件概率（3 个 noul，约 1.7 s） |
| POST | `/narrate` | 生成台词。★ **不传 `behavior` 会自动先跑一次 decide**，一次请求办完决策+台词 |
| POST | `/predict` | 原始透传，直接调 Laya。调试 API 形状用 |

CORS 已开（`Allow-Origin: *`），`do_OPTIONS` 已实现，预检返回 204 + 三个 Allow 头。

### 4.2 `/decide` 请求

```json
{
  "player_input": "玩家的中文台词（必填）",
  "player_input_en": "可选。若客户端已有英译就传，省掉一次 LLM 翻译",
  "actor": { ... },          // 省略则用 CFG.actor
  "history": [{"role":"player","text":"..."},{"role":"npc","text":"..."}],
  "world_state": { ... },    // 省略则用 CFG.world.state
  "questions": { ... },      // 省略则用 CFG.questions
  "seed": 15                 // 只影响回退引擎
}
```

### 4.3 `/decide` 返回（字段全表）

```
engine                 "laya" | "fallback"
engine_detail          人类可读的加载描述
confidence_reliable    bool。★ 回退引擎时为 false，前端必须显示「粗估」
latency_ms             float
latency_breakdown      {"translate_ms":..., "decide_ms":...}
lang                   "en" | "zh"。★ 决策文档语言，恒为 en（见 5.4）
player_input_en        实际送进 Laya 的英文台词
routing                {model, repo, reason, detection, workflow}
answers                {qid: {...}}      全部问题的原始答案，见 4.4
raw                    Laya 的原始返回（透传，schema 猜错时看这里）
state_doc              ★ 实际送进 Laya 的 state 文档（原则 3 的可审计载体）
state_line             一行中文状态摘要，给 LLM 看的
attribution            {"k_positive":1.15,"k_negative":0.85,"enabled":true}
deltas                 [{question,target,label,raw,attribution,delta,range}]
director               {threshold, hidden_event, adopt, note}
decision               {behavior, player_intent, betrayal_intent, hidden_event}
question_count         int（当前 16）
```

### 4.4 `answers[qid]` 的三种形态

```
choice:  {type, choice, probabilities{label:p}, confidence, action, _probabilities, _value}
score:   {type, score, legend{档位:描述}, probabilities{档位:p}, confidence, action, _value}
noul:    {type, noul, confidence, action, _value}     # _value 就是校准后的 P(true)
```

`_probabilities` / `_value` 是桥加的下划线字段，是**归一化后的统一访问入口**，
其它 AI 应该只用这两个，不要依赖 Laya 原生的 `probabilities` / `choice` / `score` / `noul` 拼写。

### 4.5 `decision.behavior`（★ 前端最需要关心的部分）

```json
{
  "id": "ally",              // 最终行为
  "name": "提出结盟",
  "desc": "...", "instr": "...",     // 给 LLM 的表现指令
  "confidence": 0.0948,      // ★ 这是 choice 的置信度，不是最终行为的概率
  "probabilities": {"confide":0.2817, "observe":0.2148, ...},
  "choice_pick": "confide",  // choice 原语的 argmax
  "gated_by": {              // null 表示没被门限改写
    "gate": "gate_ally", "p": 0.637, "threshold": 0.45,
    "choice_said": "probe", "overrode": "probe"
  }
}
```

★ **`gated_by != null` 时不要显示 `confidence`**。那个数描述的是另一个行为。
应该显示 `gated_by.p`。演示页已按这个规则处理（`laya-live-demo.html` 的 `gateBox` 与消息装饰）。

---

## 5. 配置契约（`narra_config.json`）

### 5.1 顶层键

```
_readme           自说明书。★ 改配置前先读它，里面写了三条铁律的由来
laya_language     "en"（不要改成 zh，见 5.4）
state_format      "compact"（默认，实测有效）| "full"（早期形态，留作对照）
scene             场景信息。★ 必须有 note_en
actor             角色卡：personality(-1~1) / traits(0~1) / emotion / relationship / goals / situation
behaviors[]       行为候选。★ 每个必须有 short_en（3~5 词），这是喂给 choice 的选项文本
questions{}       问题集。见 5.2
gates{}           ★ noul 门限。见 5.3
state_shift{}     score 期望值 → 状态增量的插值表 + attribution（人格归因）
director{}        hidden_event 阈值（当前 0.75）
world{}           世界层 state + 3 个 noul 问题
```

### 5.2 问题集的三条铁律

这三条是 A/B/C/D 四轮真机对照实测出来的。**违反任意一条，模型就退化成先验**，而且不报错。

**① `instructions` 必须用反引号引用 state 里的键名。**

```json
"instructions": "How does `message` change the trust that `npc` has in the player?"
```

Laya 自带 presets 就是这个形态（`` `message` ``、`` `prompt` ``）。
早期我们写 `"this sentence"`，模型没有锚点知道指什么 → 四个语义相反的输入给出同一个答案。

**② `score` 的 `criteria` 必须是领域化档位描述，不能六题共用一组通用词。**

```json
"criteria": ["trust drops sharply","trust drops a little","trust is unchanged",
             "trust rises a little","trust rises sharply"]
```

早期六个评分题共用 `["much lower",...,"much higher"]`，选项本身不含任何领域信息。
实测跨度 **0.10~0.22 档 → 改后 0.88~1.02 档**（满分 4 档）。

**③ `choice` 的选项必须是 3~5 个词的短标签。**

选项文本来自 `behaviors[].short_en`，通过 `"criteria_source": "behaviors"` 引用
（`laya_bridge.py:904` 的 `behavior_short_criteria()`）。
这样写是为了避免短标签在 `behaviors` 和 `questions` 两处各存一份然后悄悄漂移。

早期用长描述（`"asks a direct question, cornering the other person on one specific contradiction in what they said"`），
结果某个选项变成**先验吸引子**：7 个长选项下，「她主动交出秘密」对
「玩家拔刀要杀她」和「玩家朝地上吐口水辱骂骑士团」**都是 argmax**。压成短标签后 argmax 才开始随输入移动。

### 5.3 `gates`：noul 门限覆盖

```json
"gates": {
  "gate_ally":    { "behavior": "ally",    "threshold": 0.45, "_status": "已生效" },
  "gate_confide": { "behavior": "confide", "threshold": 0.85, "_status": "暂不生效" },
  "gate_leave":   { "behavior": "leave",   "threshold": 0.70, "_status": "暂不生效" }
}
```

逻辑在 `apply_gates()`（`laya_bridge.py:638`）：取所有门限的 `_value`，按概率降序，
第一个 `p >= threshold` 的把最终行为改成 `behavior`。

**`_status` 字段是给人看的，程序不读；但不要删掉**，它记录了每个门限的验证程度。
`langtest` 会显式报告哪些门限是「死门限」（观察最大 P 从未超过阈值）。

★ 阈值必须按实测分布定，且**必须把英译抖动算进余量**：
同一句中文因英译措辞不同（`Templar` / `Temple's`，`Grey Crow` / `Gray Crows`），
`gate_ally` 会在 **0.527 ~ 0.637** 之间跳。0.55 正好落在噪声带里会时灵时不灵，
所以取 0.45（非结盟组最大 0.344，结盟组最小 0.527，两侧各留约 0.08）。

### 5.4 ★ 语言分工（最容易踩的架构坑）

**喂给 Laya 的 state 与 questions 一律英文。**

`typed-decisions` 是英文 ModernBERT。README 自己的基准表写着：英文检查点在非拉丁脚本上会
「高置信度 + 零准确率」（高棉语 0.952 置信 / 0.000 准确）；而 `multilingual`
检查点在 typed-decisions 任务上只有 0.342（低于 0.318 随机基线）。

中文只用于 UI 展示和 LLM 台词。**连玩家的中文台词也要先翻成英文再进 state**，
否则 state 里混着中文同样静默失效（`translate_to_en()`，`laya_bridge.py:867`）。

---

## 6. ★ 实测数据（不用重跑，直接引用）

检查点 `typed-decisions`，state_format `compact`，
四句**极端反差**输入（`LANGTEST_CASES`，`laya_bridge.py:1401`）：
持刀威胁 / 同袍相助 / 陌生问路 / 羞辱骑士团。

复现命令：`.venv/Scripts/python.exe laya_bridge.py langtest typed-decisions`
（约 1 分 40 秒。★ 只跑一个检查点，理由见 7.2）

### 6.1 行为 choice 与门限

| 输入 | choice argmax | conf | gate_ally | gate_confide | gate_leave | **最终行为** |
|---|---|---|---|---|---|---|
| 持刀威胁 | probe | 0.094 | 0.233 | 0.571 | 0.237 | probe |
| 同袍相助 | confide | 0.068 | **0.625** | 0.637 | 0.185 | **ally**（门限改写） |
| 陌生问路 | probe | 0.102 | 0.344 | 0.543 | 0.189 | probe |
| 羞辱骑士团 | probe | 0.155 | 0.333 | 0.618 | 0.257 | probe |

- 4 个输入 → **2 种**行为（改配置前是 4 个输入 → 1 种）
- `choice` 的置信度长期 **0.07~0.16**，等于模型自己在说「不知道」
- 实跑（`/decide` 全链路）里 `gate_ally` 另见 0.527 / 0.587 两个值 → 噪声带宽约 ±0.05

### 6.2 玩家意图 choice —— 4/4 全对

| 输入 | 期望 | 实际 |
|---|---|---|
| 持刀威胁 | threaten | **threaten** ✓ |
| 同袍相助 | sincere | **sincere** ✓ |
| 陌生问路 | probe | **probe** ✓ |
| 羞辱骑士团 | threaten | **threaten** ✓ |

`player_intent` 用的是短标签 + 反引号锚点，证明**短标签方案本身是对的**，
问题只出在「谁来选行为」这件事上（`npc_behavior` 有 7 个选项且带剧情语义）。

### 6.3 score 逐输入期望值（★ 方向比对跨度更重要）

满分 4 档（0=最低档，4=最高档）。

| 维度 | 持刀威胁 | 同袍相助 | 陌生问路 | 羞辱骑士团 | 跨度 | 方向 |
|---|---|---|---|---|---|---|
| 信任 | 1.76 | **2.29** | 2.14 | **1.26** | 1.02 | ✓ 正确 |
| 尊敬 | 1.76 | **2.36** | 2.16 | **1.41** | 0.95 | ✓ 正确 |
| 好感 | 1.72 | **2.26** | 2.12 | **1.38** | 0.88 | ✓ 正确 |
| 怀疑 | **2.81** | 2.37 | 2.29 | 2.64 | 0.51 | ✓ 正确 |
| 查明身份 | **2.93** | 2.44 | 2.26 | 2.49 | 0.68 | ✓ 合理 |
| 警觉 | 2.23 | **2.40** | 2.22 | 2.02 | 0.37 | ✗ 可疑（同袍相助最高） |

**六个维度里五个方向正确，只有「警觉」可疑。**
改配置前跨度只有 0.10~0.22 且无方向。`langtest` 已内置这张表（`逐输入期望值`）。

### 6.4 已经证伪的做法（不要重试）

| 试过的做法 | 结果 | 结论 |
|---|---|---|
| 12 字段嵌套 JSON 当 state | 367 token，超出 english 检查点可用余量 354 → 尾部被 `st[:room]` 静默截断，丢掉最关键的 `player_says` | 用 compact（284 token） |
| 行为选项写长描述 | 4 个极端输入 → 1 个 argmax | 必须 3~5 词 |
| 六题共用通用比较词 | 跨度 0.10~0.22 | 必须领域化档位 |
| 加第 8 个 `other` 兜底选项 | 从 1 种变 2 种，没解决 | 治标不治本 |
| 每个行为拆一个 `noul` 再归一成分布 | 语义上更合理，但 `confide` 仍是吸引子（原始 noul 0.528~0.616，四个输入里三个最高） | 不如直接做门限 |
| 用温和输入测区分度 | 三句温和对话全给同一答案 → 误判「模型没能力」 | ★ 判「模型不行」之前先确认输入真的把差异压出来了 |

### 6.5 性能

| 项 | 实测 |
|---|---|
| 检查点冷加载 | 45 700 ~ 67 000 ms |
| Laya 推理本身（14 题，`langtest`，不含翻译） | 14 100 ~ 15 200 ms |
| 一轮 `/decide`（16 题 + 英译 LLM 调用） | 21 500 ~ 27 300 ms |
| 其中 `translate_to_en` 占 | 3 500 ~ 4 000 ms（★ 客户端传 `player_input_en` 可省掉） |
| `/world`（3 题） | 约 1 700 ms |
| `llm_narrate`（deepseek-flash, effort=low） | 1 400 ~ 6 500 ms |

★ 全部是 CPU 推理。16 题的 `/decide` 要 20 秒以上属于正常，不是卡死 ——
排查前先看 `/health` 里有没有 `"ready": true`，再确认服务日志有没有当真在算。

`choice:6-10` 桶温度 = 1.0000，`score:3-5` = 1.2514，`noul:2` = 1.9834，
**全部在 `[0.5, 5]` 内，未被 clamp，置信度可校准**。
（`choice:11+` 桶 = 0.1006 会被 clamp，但当前问题集不用那个桶。）

---

## 7. ★ 环境约束（本机特有。不遵守会浪费几小时）

### 7.1 一律用项目自带 venv

```bash
laya-live/.venv/Scripts/python.exe <script>
```

不要用系统 python，不要用 `python` 裸命令。

### 7.2 ★ 不要同时加载两个检查点 —— 会 Segmentation fault 且无 traceback

每个 ModernBERT-large 检查点约 **840 MB** 权重。同时加载 2 个 ≈ 2.5 GB+。
本机 15.7 GB 内存，实测时只剩 3.3 GB 可用 → 加载第二个时进程被系统杀掉。

**症状**：进程直接退出，**零 traceback**，日志停在「创建第一个 Agent」那一行。
Windows 上表现为静默退出；Linux/macOS 是 exit 139。

`cmd_langtest` 原来默认遍历本地所有检查点，直接崩。
**已修**：默认只跑 `LAYA_MODEL` 那一个；跑多个之前先调 `_free_phys_mb()` 查可用内存，
不够就直接劝退并给出单跑命令。

→ **对照实验必须点名**：`python laya_bridge.py langtest english`

### 7.3 ★ 不要用 `huggingface_hub` 下模型

它会删 `.incomplete` 哨兵、`.locks/*.lock` 文件和 tempfile 目录 —— 正好撞上本机的
**删除配额守卫**（单轮删除 > 50 项 → `SystemExit(1)`，见 7.4）。

用 `_fetch_laya.py`：纯 GET-to-file，零删除，8 次指数退避重试，支持断点续传。
换检查点改它顶部的 `SUBFOLDER`。

### 7.4 ★ pip install 会被「删除配额守卫」杀掉

- 注入文件：`<WorkBuddy>\resources\app.asar.unpacked\cli\vendor\shim\sitecustomize.py`
- 机制：把 `os.unlink` / `os.remove` / `shutil.rmtree` 改写成「移到回收站」，
  每次删除 fork 一个 node 守卫进程。**单轮累计 > 50 次删除 → `raise SystemExit(1)`**
- 症状：进程还在但 **CPU 增量 0 / I/O 增量 0**，看起来像死锁，事后 venv 半损坏
- 正确做法：**重命名而不是删除**冲突项，且**不要加 `--ignore-installed`**

```bash
# 把 5 个冲突项 mv 进 .venv_parked_<ts>/，然后
"$PY" -m pip install laya --only-binary=:all: -i https://mirrors.aliyun.com/pypi/simple
# 成功判据：日志出现 Installing collected packages 且【没有】Attempting uninstall
```

### 7.5 `启动Laya桥.bat` 是 GBK 编码，不要手改

CMD 按 OEM 代码页（中文 Windows = 936/GBK）逐行解析 .bat。
存成 UTF-8 时中文字节被误读，碎片可能落在行首被当成命令执行，
报 `'鎶?JSON' 不是内部或外部命令` 这类错。

→ **改文案要改 `_gen_bat.py` 再重跑**。它自带自检（GBK 唯一解 / 无 BOM / 中文只在 echo|rem|title 行）。
→ AI 侧**无法真正运行 .bat 验证**（`cmd //c` 会被 MSYS 路径转换吃掉参数，退化成只打印版本头就退出；
显式调 `cmd.exe` 被安全策略拦截）。只做解码自检，最后请人双击确认。

### 7.6 后台起服务必须用 `run_in_background`

用 `(cmd &)` 启动的进程会被工具调用结束时的进程组清理带走，
表现为「下一条 curl 报 `目标计算机积极拒绝 10061`」。

### 7.7 其它

- `/tmp` 不可写（Git Bash）；临时文件放工作区内
- `PowerShell` 工具不回显 stdout，需要取结果时写临时文件再用 Read 读
- `reg` 被安全策略禁用；从 Bash 里调 `powershell` 会被拦截
- GitHub / HF 端点在本机会间歇性 TLS 握手失败，需要重试循环

---

## 8. 已知缺陷（诚实清单）

> **警告**：这一节不是待修 bug 列表。前三条是**架构层面的已知取舍**，
> 试图直接"修掉"会破坏第 1 节说的架构结论。第 4 条以下才是可以动手的。

### 8.1 `choice` 对敌意输入仍会选「迂回试探」

实测：玩家拔刀说要杀她 → 行为 `probe`。语义上应该是 `leave` 或 `distance`。
`choice` 的 prompt 已经按最优方式改写（短标签 + 反引号锚点），仍然如此。

**当前靠门限兜着，但 `gate_leave` 方向可疑**（持刀威胁时 0.237，低于羞辱骑士团的 0.257，
与语义不符），所以**不要拿 gate_leave 做剧情转折**。

要真正解决，需要的是**收集真实对局样本重新设计一个「敌意门限」**，
而不是继续调现有这三条门限的阈值。**当前不要动它。**

### 8.2 门限阈值样本极少

`gate_ally` 的 0.45 来自 4 个测试输入 + 3 次实跑。**必须随真实对局重标**。
`gate_confide` 观察最大 0.637 / 次大 0.618，**只差 0.02，没有安全阈值**，所以暂时不生效 ——
这是刻意留白的，不是忘了配。

### 8.3 `effort=low` 时模型可能把「计划」写进 content

DeepSeek-V4.1-Flash 在 `effort=low` 时有时**不产出独立推理通道**
（`usage.reasoning_tokens == 0`），而是把「复述系统要求 + 写自己的计划 + 台词」
全写进 `message.content`。实测抓到过完整污染样本，前端原样显示 → NPC 像在念需求文档。

**已修**（`extract_line()` + `llm_narrate()` 的重试）：
1. 要求模型把台词包在 `<line></line>` 里，有标签直接取（零歧义）
2. 没标签且带 ≥2 个计划标记词 → 判为不可用 → **降温重试一次**（temp 0.35）
3. 仍失败 → 退回台词池，并在 `llm_error` / `llm_meta.raw_content_first` 留下污染原文

★ **不要试图用启发式把计划和台词切开**。两者是交错的：按「第一个像样的引号」切，
会把计划里的例句当成台词开头，越切越错（试过四种切法，全错）。

**根治建议**：把 `LLM_EFFORT` 调成 `high`。`high` 会走独立推理通道，计划就不会落进 content，
也省掉重试。（代价是 token 成本上升。这个取舍还没做，需要产品决策。）

### 8.4 遗留垃圾目录需要人工删

`laya-live/.venv_broken_20260923_124031`（557 项）、
`laya-live/.venv_parked_20260923_124553`（535 项），合计约 110 MB。

**AI 侧清不掉**：单轮删除 > 50 项会触发 7.4 的守卫被杀进程。
需要人在资源管理器里删。

### 8.5 切到 `english` 检查点会撞上 state 余量上限（已实测）

`qcheck` 现在会同时审计**问题集预算**和 **state 文档预算**，实测输出：

```
                     typed-decisions（当前默认）        english（备用）
head_max_len / max_len     256 / 1024                     192 / 512
问题集头余量范围           207 ~ 240 token                143 ~ 176 token
state 余量（max_len−head−1）        767                        319
  compact en state        284 token → 余量 483 ✓          284 token → 余量  35 ⚠
  compact zh state        377 token → 余量 390 ✓          377 token → ★ 溢出
```

结论：

- **默认的 `typed-decisions` 很宽松**（英文余量 483），两处都不需要担心。
- **切到 `english` 时英文只剩 35 token 余量**，中文直接溢出。
- 溢出是**静默截断**（`build_sequence` 里 `st[:room]` 保留左边、丢掉右边），
  会先丢掉最关键的 `message` 字段 —— 模型看不到玩家说了什么，但**不报错**。

→ 要切 `english` 之前，必须先把 state 砍短（或写一个 english 专用的精简 state）。
复现：`LAYA_MODEL=english .venv/Scripts/python.exe laya_bridge.py qcheck`
（环境变量优先于 `.env`，所以不用改文件）

---

## 9. 排查速查表

| 现象 | 先查什么 |
|---|---|
| `/health` 连不上（连接被拒 10061） | 还没加载完（45~70 s）。或服务被进程组清理带走了，见 7.6 |
| 加载第二个检查点时进程静默退出 / segfault | OOM，见 7.2。查 `_free_phys_mb()` |
| `pip install` 卡住且 CPU/IO 全 0 | 删除配额守卫，见 7.4。**别 kill**，按那套「改名挪走冲突项」重来 |
| 台词里混着「复述要求/写计划」 | 见 8.3。看 `reasoning_tokens` 是否为 0 |
| 行为不随输入变化 | 先跑 `qcheck`（选项是否被挤成一样长），再跑 `langtest`（区分度） |
| 页面显示「选中」的行和分布第一名不一致 | **正常**，说明 `gated_by` 生效了。看 `decision.behavior.gated_by` |
| 置信度看起来很低（0.07~0.16） | `choice:6-10` 的正常水平，模型在说「不知道」。别把 `confidence_reliable` 当成「置信度高」 |
| 回退引擎跑出了「合理」结果 | ★ 回退引擎（`fallback_decide`）的关键词规则**在敌意输入上反而比 Laya 准**（威胁→distance）。不要用它的表现推断 Laya 的能力 |

### 诊断命令

```bash
PY=laya-live/.venv/Scripts/python.exe

$PY laya_bridge.py probe      # 报告本机 laya 真实 API 形状（dir / signature / 预设）
$PY laya_bridge.py qcheck     # ★ 改 narra_config.json 后必跑：token 预算 / 温度桶 / state 溢出
$PY laya_bridge.py signaltest # ★★ 本轮主回归：48 用例 / 99 条决策方向断言
$PY laya_bridge.py langtest   # 旧版区分度测试（4 句极端输入）+ 门限是否在生效
$PY laya_bridge.py ckptcompare# 检查点同条件对照（需先用两个进程各跑一次 signaltest）
$PY laya_bridge.py personatest# 人格 A/B 对照（LAYA_PERSONA_STYLE 可换写法）
$PY laya_bridge.py bench      # 性能基准（CPU / GPU 各跑一次，按设备合并）
$PY laya_bridge.py selftest   # 离线自检（不需要 Laya，验证回退引擎与增量）
$PY laya_bridge.py llmtest    # LLM 接入自检（key / model id / <line> 标签是否正常）
$PY laya_bridge.py sanity A|B|C|D   # A/B/C/D 对照诊断，保留用于回归
```

★ 诊断子集（结果会单独存放，不影响正式对照）：`LAYA_QSET=signals`（只跑 15 个信号题）、
`LAYA_CASES=id1,id2`（只跑指定用例）。两者都可与 `signaltest` 组合。

---

## 10. 下一步建议

> ★ 第二轮已把本节大部分条目推进（结论在 §12）。下面是**更新后**的清单。

**已解决（不要再重复做）：**

- ~~决定检查点~~ → **已定：保持 `typed-decisions`。** `english` 与它方向准确率打平
  （51.5% vs 49.5%，差 2 条断言），但 `english` 的 state 余量只有 319 token，
  4 种 state 形态里 3 种溢出、会静默截断尾部字段。见 §12.2 ⑥。
- ~~补做 typed-decisions / english 同条件对照~~ → 已完成，见 `tests/ckpt_compare.json`。
- ~~性能只有 CPU 数据~~ → 已完成 CPU/GPU 对照，见 §12.4。
- ~~`gate_ally` 是否真的在生效~~ → 已查明：它在 live 下**恒真**，已停用，见 §12.5 ②。

**仍待做（按优先级）：**

1. **深挖 `doubt_shift`。** 它是 15 个维度里**唯一**稳定越过噪声的（+0.108）。
   要回答：它是「怀疑玩家」还是「困惑」？5 档 criteria 是否真的单调？
   **这是当前最有希望的一条线** —— 若它站得住，Laya 就有第一个可用的信号。
2. **`LLM_EFFORT` 的决定**（`low` vs `high`）。这是 §8.3 的根治手段，成本 vs 质量。
3. **重标阈值 —— 但必须遵守 §12.6 的两条规则**：
   ① 阈值只能在**目标 state 文档**上标定（夹具上标的搬不过来，已实测两次翻车）；
   ② 每个阈值都要过一遍「恒真 / 恒假自检」。
   `gate_ally` 与 `hostility ≥ 0.56` 现在都是**反例**，重标前不要启用任何门限。
4. **查清 `cooperation` / `trust` 为何方向为负。** 需要做 state 表述的对照实验
   （怀疑「玩家提出合作」被读成「玩家在试探」）。**没有对照实验前不许写进结论。**
5. **把 `decision_history` 从进程级改为按 actor 分桶**，否则多角色场景下历史互相污染（§12.7 ④）。
6. 清理 §8.4 的遗留目录（需要人做）。

### 未决问题（留给下一个 AI）

- `score` 的 `legend` 字段是 Laya 原生返回，含义未验证过 —— 目前前端没用它，用的是配置里的
  `state_shift.paths[].label`。要不要改成用 `legend`？
- `alert_shift` 方向可疑（同袍相助最高）。是 state 表述问题，还是这个维度本身难以判断？未深究。
- `world_decide` 用 `{"world_state":..., "role":"WORLD"}` 当 state，
  但世界层问题和 NPC 层问题时**共用同一次 predict**（`decide()` 里 `all_questions` 合并）。
  这样的耦合是否有必要？拆开能省时间（世界层可以低频调用）。

---

## 11. 变更记录

| 时间 | 内容 |
|---|---|
| 2026-09-23 上午 | 装 laya 0.3.5；诊断删除配额守卫（pip 反复失败的根因）；写出 `_fetch_laya.py` 手工下载两个检查点 |
| 2026-09-23 下午 | 按 A/B/C/D 对照结论重写 `narra_config.json`；加 `gates`；修 Router 预载 bug；接 DeepSeek-V4.1-Flash |
| 2026-09-23 14:00 | 修 `<line>` 结构化输出 + 污染重试；修 langtest 双检查点 OOM；`/narrate` 支持自动决策；新增 `/demo` 路由 |
| 2026-09-23 14:40 | 全链路验收通过（`/health` `/decide` `/narrate` `/world` `/demo` + CORS 预检 + 无头截图）；生成本报告 |
| 2026-09-23 17:20 | **第二轮**：决策信号 9 项 + Policy Resolver + 人格进 state + NPC/World tick 分离 + 48 条方向回归 + CPU/GPU 基准；修 3 个静默缺陷（§12.5）；产出 §12 |

---

## 12. ★ Decision Signals 实验（第二轮）

> 本轮的问题不是「怎么让 Laya 看起来更聪明」，而是
> **「怎么找到 Laya 真正可靠的职责，然后只让它负责这些职责」**。
> 下面每一项都是本机实测。每小节附复现入口 —— **不要引用未经复现的数字**。

### 12.1 实验装置（复现入口）

| 命令 | 作用 | 规模 |
|---|---|---|
| `.venv/Scripts/python.exe laya_bridge.py qcheck` | 问题集 / state token 预算体检 | 22 题 × 4 种 state 形态 |
| `.venv/Scripts/python.exe laya_bridge.py signaltest` | **决策方向回归**（本轮主测试） | 48 用例 → 99 条方向断言 |
| `LAYA_MODEL=english … signaltest` | 换检查点跑同一批 | 同上 |
| `.venv/Scripts/python.exe laya_bridge.py ckptcompare` | 两个检查点同条件对照 | 读 `tests/thresholds.json` |
| `.venv/Scripts/python.exe laya_bridge.py personatest` | 人格 A/B 对照 | 4 人格 × 3 刺激 |
| `LAYA_PERSONA_STYLE=polarity … personatest` | 换人格写法再跑一次 | 同上 |
| `.venv/Scripts/python.exe laya_bridge.py bench` | 性能基准（CPU） | 1/3/6/10/22 题 + World Tick |
| `LAYA_DEVICE=cuda ./.venv-cuda/Scripts/python.exe laya_bridge.py bench` | 性能基准（GPU） | 同上 |

一键回归：`qcheck` 与 `signaltest` 都是**单命令自足**，退出码可直接当 CI 判据。

诊断过滤器（产出会**单独存放**，不会被 `ckptcompare` 当成正式结果采纳）：

```bash
LAYA_QSET=signals  python laya_bridge.py signaltest    # 只跑 15 个信号题
LAYA_CASES=id1,id2 python laya_bridge.py signaltest    # 只跑指定用例
```

★ 为什么要把子集结果隔离：见 12.2 ③ 的 `cooperation` 近失误 ——
**在小样本子集上挑信号会挑到假货**。

产出文件（均由脚本生成，**不要手改**）：`tests/thresholds.json`（按检查点键存放逐用例全维度观测）、
`tests/ckpt_compare.json`、`tests/personality_ab.json`、`tests/bench.json`（按设备键合并）。

### 12.2 十个问题

#### ① Laya 是否适合直接选 NPC 行为？

**不适合。**

- `choice` 置信度长期 **0.063 ~ 0.137**（归一化 Shannon 熵），等于模型自称「不知道」。
- live 实测（4 个语义极端不同的输入）：行为只在 **2 种**之间摆动，且最该分离的一对
  （「刀抵在你喉咙上」vs「今晚的麦酒比上个月淡了不少」）拿到**同一类**行为。
- 第一轮靠 noul 门限「救」回来的区分度是**假的** —— 见 §12.5 ②。

#### ② Laya 是否适合作为 Decision Signals Engine？

**只适合当「倾向探测器」，不适合当决策依据。**

9 个信号确实有数字、确实随输入变化、确实可审计，但：

> ★ **有读数 ≠ 有信息。**

判据是方向准确率：48 用例展开成 **99 条方向断言 → 49.5%**。随机基线就是 50%。

拿一个 49.5% 的引擎去驱动行为，等于把决策权交给一枚硬币，**还给它加上了
「可复现、有概率值、有字段名」的可信外观**。这比直接用 LLM 即兴更危险：
LLM 的错是显式的（读起来就不对，人会拦一下），而这里的错是**穿着数值外衣**的。

#### ③ 哪些 signal 最可靠？

判据：敌意组 vs 友好组的**类别均值差**，噪声地板 = 翻译抖动 ≈ **0.055**。

| 信号 | 均值差 | 判定 |
|---|---|---|
| `doubt_shift` | **+0.108** | 唯一稳定越过噪声的 |
| `hostility` | +0.046 | 边缘，勉强可用 |
| `confront` | +0.037 | 边缘，勉强可用 |
| 其余 12 个（含 `cooperation` **−0.010**、`trust` **−0.028**、`danger` +0.017、`investigate` +0.082） | < 0.03 | **噪声级** |

（9 个 `signal_*` 里，`investigate` 属 `kind=level`，量纲是 0~4，不参与上表的 prob 均值比较。）

★ **一个必须记下的近失误**：`cooperation` 在**4 个极端输入的诊断子集**上看有 **0.17** 的差距，
看上去很可用；但扩到 16 类 × 3 措辞的**类别均值**后掉到 **−0.010**。

#### ④ 哪些 signal 不可靠？

- `cooperation` / `trust` —— 语义上**最该**区分敌友的两个，实测均值差是**负的**。
- `withdraw` / `danger` / `disclose` / `investigate` —— 跨度有，方向没有。
- 全部 9 个在 **persona 维度**上都不动（见 ⑤）。
- ★ 通用规则：**不要为噪声级信号写阈值**。15 个维度里只有 3 个能写。

#### ⑤ Personality 是否真的产生可观察影响？

**没有。** 4 个 persona（A=I+T+J ／ B=E+F+P ／ C=I+F ／ D=E+T），
固定场景 / 关系 / 情绪 / 目标 / 台词，**只改 `personality` 字段**，跑全部 22 题：

| 信号 | 默认写法平均极差 | `polarity` 写法平均极差 |
|---|---|---|
| 9 个信号全部 | **0.003 ~ 0.022** | **0.002 ~ 0.031** |

对照噪声地板 0.055 → **0/9 个信号呈现可观察差异**，两种人格写法结果一致。

★ 一个精确的点：Laya 是单次前向、无采样，所以 0.009 这种差**是真的、可复现的**，
不是随机波动。但它比翻译抖动小一个数量级，**没法用来做任何判断**。
**「能测出差异」和「差异可用」是两件事** —— 混为一谈是这个项目最容易犯的错。

必须把两句话**一起**说，只说前半句就是误导：

- ✅ §3 的机械改造**成功了**：`personality` 确实进了 Laya state（见 `/decide` 返回的 `state_doc`）。
- ❌ §4 的 A/B **证明它对决策没有可观察影响**。

#### ⑥ typed-decisions 与 english 哪个更适合？

**都不适合当决策权威。当信号源时，`typed-decisions` 更可用**（注意：与工具默认判词相反）。

| | typed-decisions | english |
|---|---|---|
| 方向准确率 | 49.5% | 51.5%（差 **2 条断言** → 平局） |
| 9 个信号跨度 | 0.19 ~ 1.09 | 0.37 ~ 0.77（更宽） |
| state 余量 | **767 token** | **319 token** |
| `qcheck` | **全绿** | 4 种 state 形态里 **3 种溢出** |
| 冷加载 | 45.3 s（CPU）／49.7 s（GPU） | — |

- `ckptcompare` 原来会因为 2 条断言的差距宣布「english 更适合」——
  这是**缺少显著性护栏**导致的假结论。已加 `MIN_PASS_GAP=5`（分钟断言数）修正为「平局」，
  并在平局时退到次级指标（跨度之和）且**明确标注「这只是可用性偏好，不是准确率证据」**。
- 即使按「跨度更宽」偏好 english，它**装不下我们的 state**：满 `decision_history` + 中文输入
  为 459 token > 319 余量 → 尾部字段被 `st[:room]` **静默截断**。
  **一个会把关键字段悄悄丢掉的检查点，跨度再宽也不能用。**
- 结论：**保持 `typed-decisions`**。只有「state 极简 + 不需要历史」的场景才考虑 `english`。

#### ⑦ GPU 后实际性能是多少？

§17 要求的口径，真实测量、非估算：

```text
GPU warm NPC decision（22 题全量 tick）: 399 ms
GPU world decision（3 题）            : 42 ms
VRAM（峰值）                          : allocated 2.48 GB / reserved 2.93 GB（共 8.00 GB）
```

完整对照见 §12.4。

#### ⑧ 高频 NPC Tick 是否具有实际可行性？

**在 GPU 上可行，在 CPU 上不可行。**

| 设备 | 完整 NPC tick | 单 NPC 决策频率 | 8 个并发 NPC / 回合 |
|---|---|---|---|
| CPU（torch 2.14.0+cpu） | 22 132 ms | 0.05 次/秒 | 177 s |
| **GPU（RTX 4060 Laptop）** | **399 ms** | **2.5 次/秒** | **3.2 s** |

- CPU 的 22 s/次意味着**一个 NPC 一个回合就吃掉整个对话节奏**，高频 tick 在 CPU 上不成立。
- GPU 上 400 ms 已进入「可以每回合都跑」的量级；8 NPC 并发 3.2 s 也在可接受范围。
- ★ 但必须补一句：**这是「引擎跑得动」，不是「引擎判断得对」**。
  49.5% 的准确率说明跑得再快也是在快速处理**没有方向的信息**。
  **性能解决的是可行性，不是有效性。** 不要把 55× 当成「Laya 现在能用了」的证据。

#### ⑨ World Tick 应该采用什么频率？

**低频，按「日」或「幕」跑，不要混进 NPC 回合。**

- 本轮把 World Tick 从 `/decide` 拆出（§9）：独立 `/world` 端点，返回 `tick="world"`、
  `world_state` 与 3 个世界问题（战争 / 商队 / 黑市）。
- 实测 **42 ms（GPU）／2617 ms（CPU）**，都远低于 NPC tick 预算。
  所以「世界层低频」的实现成本几乎为零 —— **值得做的理由是别让世界变量污染 NPC 决策**，
  而不是省算力。
- 建议：世界层每次推进时**自己**完成状态提交（`world_state` 回写）；
  NPC 层只读快照，不重复问世界问题。

#### ⑩ 哪些能力可以进入 Narraverse Phase 1？

原则：**凡是「读数可审计但结论不可靠」的能力留在 Demo；
凡是「不依赖 Laya 判断质量」的工程能力可以进 Phase 1。** 清单见 §12.3。

### 12.3 架构判定

按 §17 三选一：

```text
A. Laya 可以进入 Narraverse World Decision Engine
B. 仅部分能力可以进入
C. 当前模型仍不适合生产接入
```

**判定：B / C 之间，倾向 C。**

**排除 A 的证据**（任一条成立即排除 A）：

1. 48 用例 × 99 条方向断言 → **49.5%**，等于随机。
2. 4 个人格 × 9 个信号 → 极差 **≤ 0.031**，人格维度**完全无效**。
3. 15 个维度里只有 **3 个**越过噪声；语义最核心的 `cooperation` / `trust` 均值差为**负**。
4. live 端到端：阈值不可迁移；未受控的遗留门限会把**所有**输入改写成同一个行为（§12.5 ②）。

**倾向 C 而不停在 B 的理由**：
「部分能力可以进入」这个判定需要至少**一个**能力被证明可靠。
本轮端到端实测**没有找到这样的能力** —— 9 个信号里最好的 `doubt_shift`
也只在**类别均值**层面胜过噪声，单条输入上仍会翻向（48 条里有明确的失败样本）。

**✅ 可以进入 Phase 1（工程层，不依赖判断质量）：**

- `/decide` 与 `/world` 的**契约与字段结构**（`decision_signals` / `policy` / `state_proposals` / tick 分离）
- `qcheck` 这类**预算体检**（token 截断是真实且静默的）
- `state_budget` **运行时溢出告警**
- 结构化 `decision_history`（§8 的语言问题已解决）
- **Policy Resolver 的框架**（规则可插拔、裁决可审计、歧义可回退）—— 注意：是框架，不是其中的规则
- GPU 部署方案与实测基线

**❌ 必须留在 Demo（不可进 Phase 1）：**

- 任何**具体阈值**（`gate_ally` 0.45 与 `hostility ≥ 0.56` 都是反例，见 §12.6）
- 「Laya 决定 NPC 行为」这件事本身
- 把 `state_proposals` 直接写进 Actor State
- 人格驱动决策
- 任何声称 Laya 能区分敌友的用法

### 12.4 性能实测（CPU vs GPU，同机同检查点）

环境：RTX 4060 Laptop GPU，8188 MiB VRAM，driver 595.71。
CPU 用 `.venv`（torch 2.14.0+cpu），GPU 用 `.venv-cuda`（torch 2.14.0+cu126）。

| 题数 | CPU 首次 ms | CPU 均次 ms | GPU 首次 ms | GPU 均次 ms | 加速 |
|---|---|---|---|---|---|
| 1 | 1551 | 1170 | 1653 | 42 | 28× |
| 3 | 3019 | 3623 | 82 | 63 | 58× |
| 6 | 7228 | 9280 | 102 | 101 | 92× |
| 10 | 11814 | 10843 | 171 | 170 | 64× |
| **完整 NPC tick（22）** | **22 563** | **22 132** | **401** | **399** | **55×** |
| **World Tick（3）** | 2383 | 2617 | 51 | 42 | 62× |

- **冷加载：CPU 45 339 ms ／ GPU 49 738 ms** —— ★ GPU **没有更快**。
  加载瓶颈是磁盘 + tokenizer，不是矩阵运算。**不要指望换 GPU 加快启动。**
- GPU 首次调用 1653 ms（含 CUDA kernel 预热），之后 42 ms。**首次延迟必须计入健康检查。**
- 峰值 VRAM `allocated 2.48 GB / reserved 2.93 GB`（8 GB 卡余量充足，
  但**仍不要同时加载第二个检查点**，见 §7.2）。
- 结论：**性能是本轮唯一被彻底解决的问题。** 但见 §12.2 ⑧ 的警告。

★ **设备本身也是数值噪声源**：同一检查点、同一批 48 用例，
CPU 与 GPU 的 720 个数值里 **710 个不同，最大差 0.033**（与翻译抖动 0.055 同量级）。
方向准确率不受影响（两边都是 49.5%），但——

**「同输入同输出」这个卖点必须限定为「同设备」。**
跨检查点比较**必须同设备**，否则 0.03 的设备漂移会伪装成检查点差异。

### 12.5 本轮发现并修复的三个静默缺陷

共同特征：**不报错、不崩溃、返回结构完整、数字看起来正常**。
这是最贵的一类 bug —— 你会拿着错的数据写出正确的推理，得到一个错的结论。

#### ① `/decide` 的键名陷阱（最危险的一个）

`/decide` 读 `player_input`，但直觉（和本报告旧版的 curl 示例）都写成 `message`。
旧实现对未知键**静默忽略**：

```text
POST /decide {"message": "他慢慢把刀从鞘里抽出来，抵在你喉咙上：「别动。」"}
→ state.message = ""      ← 玩家台词从未进入 state
→ 与 {"message": "今晚的麦酒比上个月淡了不少。"} 返回 md5 完全相同的 state
```

★ **本报告的撰写者本人就被这个坑骗过一次**：第一轮端到端跑出「四个输入行为全是 ally」，
差点直接写成「引擎对敌意不敏感」的结论 —— 实际是引擎**压根没收到输入**。

修法：

- 新增 `payload_text(payload)`，**统一**读取 `player_input`（规范键）或 `message`（别名），
  `/decide` 与 `/narrate` 共用一份。原来这两处是**分开手写**的，所以还存在更隐蔽的版本：
  用 `message` 调用时「决策吃到了台词、LLM 拿到空串」，两条链路基于不同输入。
- 新增响应字段 `input_key`（`"player_input"` / `"message(别名)"` / `null`）。
- 输入为空时返回 `input_warning`，并在前端面板**顶部**显示告警横幅
  （它会让整块面板失效，不能藏在诊断区里）。

★ 教训：**对未知键静默忽略的 API，一定会有人用错键，而且不会有人发现。**

#### ② 遗留 noul 门限把所有输入都改写成 `ally`

`decide()` 的裁决链是「choice argmax → noul 门限 → Policy Resolver」，
第二轮**保留了**第一轮的 `gates` 层。live 实测：

| 输入 | `gate_ally` 实测 | 阈值 | 命中 | 最终行为 |
|---|---|---|---|---|
| 他慢慢把刀…抵在你喉咙上 | 0.483 | 0.45 | **是** | **ally（提出结盟）** |
| 外面有人在盯着你，我替你挡住门口 | 0.480 | 0.45 | **是** | **ally** |
| 你们骑士团不过是国王养的一条狗 | 0.572 | 0.45 | **是** | **ally** |
| 今晚的麦酒比上个月淡了不少 | 0.553 | 0.45 | **是** | **ally** |

→ 门限**恒真** → 4 个语义极端不同的输入拿到**同一个**行为，包括「刀抵喉咙」。
→ 这正是第一轮宣称已修好的「4 输入 → 1 行为」，**它以另一种形式回来了**。

原因见 §12.6。修法：

- `gate_ally` 停用（`threshold=1.01`，落在概率上界之外），行为权威交回 `policy` 段。
- 前端把停用的门限显式标成「· 已停用」并附 `_status`。
- **不删键** —— 删掉会让下一个人以为从来没人标定过。

修复后 live 复测：4 个输入 → **2 种**行为（威胁→`observe`，寒暄→`confide`），
来源标注为 `choice_baseline` / `ambiguous`。

#### ③ `choice_baseline` 装的其实是门限改写后的值

```python
policy = policy_resolve(signal_values, gated_id)   # ← 旧代码：传的是 gated_id
"choice_baseline": gated_id,                        # ← 名字叫 baseline，内容是 gated
```

后果：前端据此显示「choice 首选 · 被改写」，但显示的并不是真实 argmax。
实测反例：刀抵喉咙时真实 `choice` argmax = `confide`（0.2461），
而字段里是 `ally`（0.1567）—— 用户看到的「choice 首选」是个**不存在的事实**。

修法：`policy_resolve` 收真实 `choice_argmax`；
返回拆成 `choice_argmax` / `gated_baseline` 两个字段，前者才是 baseline。

### 12.6 ★ 阈值不可迁移（本轮最重要的方法论结论）

第一轮把 `gate_ally` 的阈值标在 **0.45**，依据是离线夹具：
非结盟侧观测最大 0.344、结盟侧最小 0.527，两侧各留 0.08 余量 —— 看起来很稳。

线上实测同一门限：**0.415 / 0.480 / 0.483 / 0.515 / 0.553 / 0.565 / 0.566 / 0.572**。

```text
夹具：非结盟 0.23~0.34  |0.45|  结盟 0.53~0.64     ← 阈值落在空隙里，稳
线上：            0.415 ~ 0.572                      ← 阈值被埋在分布内部，恒真
                         ▲ 0.45
```

**换 state 文档会让整组分布整体平移。** 夹具用的是为测试构造的固定 state，
线上用的是 `CFG["actor"]` + `CFG["scene"]` 默认文档 —— 两者对同一个门限问题
产生的 P(true) 不在同一区间。

由此得到两条必须遵守的规则：

1. **阈值只能在「目标 state 文档」上标定。** 想标 live 阈值，就必须用 live state 采两组分布。
2. **任何阈值都要做一次「恒真 / 恒假自检」**：若某组输入全部命中（或全部不命中），
   那它不是门限，是常量。**恒真的门限比没有门限更糟** ——
   它会掩盖 baseline 的方差，让系统表现得像「有明确判断」。

同一个坑也适用于 `policy` 段的安全护栏：`hostility ≥ 0.56` 标在**夹具**上
（唯一越过的是 `armed_attack_1` = 0.63）；而 live 实测刀抵喉咙的 `hostility` = **0.46 ~ 0.49**，
**护栏不触发**。这两个数字的差异（0.63 vs 0.49）就是同一件事的第二次出现。

→ 结论：**护栏目前不能声称「能拦住极端敌意」**。
§8.1 的缺陷**没有被修复，只是被重新表述了**。

### 12.7 本轮仍未解决的问题

1. **`choice` 的方向性**：`confide` 仍是吸引子；威胁场景下 `leave`(0.037) / `distance`(0.057)
   在 7 个选项里排倒数 —— 语义上恰恰应该最高。
2. **`cooperation` / `trust` 方向为负**，原因未查明。怀疑 state 表述把「玩家提出合作」
   读成了「玩家在试探」，但**没有做对照实验，不要当结论用**。
3. **`doubt_shift` 是唯一稳定越过噪声的维度**，值得单独深挖：
   它到底是「怀疑」还是「困惑」？5 档 criteria 是否真的单调？
   **这是下一步最有希望的方向。**
4. **`decision_history` 是进程级滚动窗口**，不是按 actor 分桶：
   连续两次独立 `/decide` 并非彼此独立。单角色 Demo 够用，**多角色 / 并发必须改**。
5. **`decision_history` 的内容由「决策结果」反推**（intent id + behavior id → 配置里的英文 criteria），
   不携带输入信息。当决策本身恒定（如输入为空）时，历史会**饱和成常量**。
   机制（§8 的语言要求）是对的，**内容是下游问题的函数**。
