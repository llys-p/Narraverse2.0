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
| 检查点冷加载 | 45 700 ~ 67 000 ms（★ 其中约 25 s 是**无用的随机初始化**，已由快加载消除 → **9.2 ~ 12.1 s**，见 §13.3.2） |
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
| 冷加载 | 45.3 s（CPU）／49.7 s（GPU）〔0.3.5 原生；开快加载后 12.1 s，见 §13.3.2〕 | — |

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
  ★ **2026-09-23 18:20 修正**：当时把原因写成「瓶颈是磁盘 + tokenizer」，**这是错的**。
  真实构成是 `build_model()` 那次随机权重初始化 **≈25 s（占 95%）**，而读 842 MB 权重只要 0.16 s
  （同一个文件纯读一遍 0.43 s / 1972 MB/s）。**不要指望换 GPU 加快启动** ——
  该指望的是把那次随机初始化删掉，见 §13.3.2。
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

---

## 13. 上游文档与同类项目（2026-09-23 查证）

> 本节是到上游仓库和 GitHub 生态里核对后的结果。
> **它改变了 §12.3 的归因**：我们的 49.5% 不是集成 bug，而是**上游明确记录的基线状态**。

### 13.1 ★ 上游自己承认「zero-shot 就是接近随机」

上游 README（`github.com/NandhaKishorM/laya`）在 **Honest limits** 一节原文写着：

> **The base checkpoints are near chance on typed-decisions zero-shot** — 0.362 and 0.342
> against a 0.318 random baseline and a 0.461 majority-class baseline.
> The 0.766 figure comes from the checkpoint fine-tuned on that benchmark's own training split.
> **Laya is a fast base to specialise, not a zero-shot decision engine.**

对上我们的实测：

| | 上游自测（typed-decisions 基准，2000 决策） | 我们的 48 用例回归 |
|---|---|---|
| 方向准确率 | 0.362 / 0.342（两个基础检查点） | **0.495 / 0.515** |
| 随机基线 | 0.318 | 0.500（二分类方向断言） |
| 多数类基线 | 0.461 | — |

→ **§12.3 的判定要改口径**：不是「我们没接好」，而是
**「我们把一个官方声明为 zero-shot 接近随机的模型，当成了决策引擎来用」**。
§12.2 ② 那句「有读数 ≠ 有信息」依然成立，但责任不在集成层，在**选型**。
→ **唯一已知的出路是 fine-tune**（§13.2）。

### 13.2 ★ 三个上游已知 bug，与我们的症状逐个吻合

| 上游 issue | 症状 | 对应的我们的现象 |
|---|---|---|
| **#156** `noul` 会跟随**选项标签**而不是 state，在 `laya`（英文）上最明显 —— 对明显正面的输入返回自信的 "no" | 概率是标签驱动的，不是内容驱动的 | ★ **`cooperation`(−0.010) / `trust`(−0.028) 方向为负**（§12.2 ④）极可能就是它 |
| **#131** `laya-multilingual` 在 `score` 上有**位置偏置**：几乎不选第一个等级 | 等级分布被系统性压向一侧 | 我们的 score 型信号（`*_shift`、`signal_investigate`）方向普遍偏弱 |
| **#185** `action.act_probability` 读出来几乎恒为 1.0，与正确性反相关（AUROC 0.30） | 该字段无信号 | 我们没用它；上游建议改用 `confidence`（AUROC 0.77） |

★ **一个自洽的旁证**：我们的 `player_intent` 是 **`choice`** 型 → **4/4 全对**；
我们的 8 个信号里 7 个是 **`noul`** 型 → 大面积方向为负。
上游对 #156 给的 workaround 正是：**把它改写成两选项 `choice`，选项键用中性的 A/B**：

```json
{"type": "choice", "instructions": "这句话是在表达敌意吗？",
 "criteria": {"A": "是，明确表达敌意", "B": "否，没有敌意"}}
```

→ **这是当前最便宜、最可能见效的一个实验**：把 8 个 `noul` 信号全改成两选项 `choice`
（`criteria` 用中性键 + 我们的等级描述），重跑 `signaltest`，看方向准确率是否从 49.5% 抬起来。
**在 §12.3 的判定不变的前提下，这是唯一值得先做的一步。**

### 13.3 上游能力我们没用上的

| 能力 | 说明 | 我们的现状 |
|---|---|---|
| **fine-tune 配方** | Kaggle 免费 2×T4，~4-5 小时 / 4 epoch / ~30k 题，带 RLCD 训练 + 温度标定 + 推上 Hub | **未做**。这是从 0.49 走向可用的唯一路径 |
| **workspace 级成功案例** | `docs/finetune_browser_agent.md`：单张 16 GB 卡微调，元素 top-1 从 **0.10 → 0.66**，真实任务成功率 **0% → 62%**，17–23 ms/步 | 证明「微调能把 near-chance 抬到可用」在同类任务上已经发生过 |
| **`laya-serve`** | 官方 Jev 兼容 HTTP 服务（`POST /v1/systemone`），`pip install "laya[serve]"` | 我们手写了 `laya_bridge.py`（更贴合本项目，但上游有现成的） |
| **内置预设** | `router_questions()` / `guard_questions()` / `moderation_questions()` / **`triage_questions()`**（intent / urgency / frustration / churn） | 未用。**`triage_questions` 就是现成的意图识别问题集** |
| **0.3.7 加载提速** | 「checkpoint 不再做一次无用的随机权重初始化」，CPU 冷加载 **22 s → 2 s**，且答案位级一致（原文见下） | ✅ **本机已用等价做法自实现**（`LAYA_FASTLOAD`，见 §13.3.2）：干净进程 **35.6 s → 12.1 s**，输出 **1707 个值逐个相同**。0.3.7 本身仍装不到（PyPI 最新 0.3.5） |
| **`predict_shortlist`** | 选项多时先用 embedding 召回 top-k 再前向 | 我们没这个问题（7 个行为） |

★ **检查点选择要修正**：上游在 **MASSIVE intent（20 选项，随机 0.050）** 上，
英文检查点 `laya` 得 **0.783**、multilingual 0.657 —— 也就是说
**「意图识别」这类 `choice` 任务，表现最好的检查点是英文根检查点，不是 `typed-decisions`**。
我们因为 state 预算选了 `typed-decisions`（`english` 余量只有 319 token）。
→ 若要做意图识别，正确路线是：**压缩 state → 换回 `english` 检查点**，而不是继续用 `typed-decisions`。

### 13.3.1 ★ 0.3.7 加载提速：查证结果与两个更正（2026-09-23 17:50 核对）

| 项 | 查证结果 |
|---|---|
| 上游最新版本 | **v0.3.7，发布于 2026-09-23T07:25Z**（今天上午，我们核对前约 2 小时） |
| 相关 PR | **#195 `Skip redundant initialization when loading checkpoints`** |
| 原始声明（README，v0.3.7 tag） | “**About 10x faster loading.** Checkpoints are built without the throwaway random weight initialisation, so `laya.load()` drops from about 22 s to about 2 s on CPU **with bit-identical answers**. This also skips the pass that **crashed on Windows with Python 3.14 (#123)**.” |
| ★ 更正一：**PyPI 上拿不到** | `pip index versions laya` → `Available versions: … 0.3.5`（**LATEST: 0.3.5**）。0.3.5 是 PyPI 最新，**0.3.6 / 0.3.7 只在 GitHub 上**。 |
| ★ 更正二：**原先写的「瓶颈在磁盘 + tokenizer」已被推翻** | 2026-09-23 18:20 复测（见 §13.3.2）：纯读 842.6 MB 权重只要 **0.43 s**（1972 MB/s，页缓存热）；`Agent.__init__` 分步拆解 **build_model 25.15 s / load_file 0.16 s / load_state_dict 0.63 s** —— **95% 花在 `AutoModel.from_config()` 的那次随机初始化上，正是 0.3.7 删掉的那一段**。所以「升级即 ~2 s」这个方向是对的，我上一轮写的「升级也降不到」是错的结论。 |

**安装方式（PyPI 装不到，只能从 git 装）：**

```bash
./.venv-cuda/Scripts/python.exe -m pip install "git+https://github.com/NandhaKishorM/laya@v0.3.7"
```

★ 装之前必须做两件事，否则会白忙：

1. **记录当前基线**：`python laya_bridge.py bench` 与 `signaltest` 各跑一次存档，升级后**同设备**复跑对照。
   上游说的是 "bit-identical answers"，但那是**他们自己**跨版本的对照；我们不能替他们担保。
   §12.4 已经证明**同一版本换设备都会漂 0.033**，跨版本必须重新验。
2. **别指望它治准确率**：这次提速改的是「加载时多做了一遍随机权重初始化」，与推理、与信号质量无关。
   0.3.7 的其它条目（`lang_guess=`、错误信息带上问题名、Router 常驻两个检查点）对我们都是体验级改进，
   **不会把 49.5% 变成可用**。

**顺带一条对本项目直接有用的**（README「Production Preload & Memory」）：
`Router()` 默认常驻 `english` + `multilingual` 两个检查点；而 `max_loaded=1` 会导致**每次语言切换都重建被驱逐的那个**，
上游实测中位重载 **7.4 s（CPU）/ 10.3 s（T4）**。
→ 我们 `laya_bridge.py` 自己也持有检查点，且**按 actor 缓存**；若之后加多语言切换，
要注意别退化成这种「每次切换重建」的模式。

### 13.3.2 ★ 快加载：把 0.3.7 那一步在本机自己实现（2026-09-23 18:20 实测）

**起因**：核对「加载 45 s → 2 s 到底实没实现」。查证结果：**没有**。
`pip index versions laya` → 最新仍是 0.3.5；本机两个 venv 都是 0.3.5。
但同一句话的后半段——「45 s 是真实开销吗」——测完之后结论反过来了。

**先看 45 s 花在哪（`tests/loadstage.py` 分阶段 + `tests/loadstage_detail.py` 分步）：**

| 阶段 | 耗时 | 占比 |
|---|---|---|
| `import laya` | 1.8 – 4.1 s | ~5% |
| `Router(preload=False)` | 0.00 s | — |
| `preload(['typed-decisions'])` | **38.2 – 46.8 s** | **~95%** |
| └ `AutoTokenizer.from_pretrained` | 0.28 s | 1% |
| └ **`build_model()`（`AutoModel.from_config`）** | **25.15 s** | **95%** |
| └ `safetensors.load_file`（读 842.6 MB） | **0.16 s** | 1% |
| └ `model.load_state_dict` | 0.63 s | 2% |

**旁证（用来排除 IO）**：同一个 842.6 MB 文件，纯 `read()` 循环只要 **0.43 s**（**1972 MB/s**，页缓存热态）。
→ **瓶颈完全不是磁盘、也不是 tokenizer，而是 `laya/common.py:139 build_model()` 里
`AutoModel.from_config(ecfg)` 对 4.2 亿参数做的那一次随机初始化**，
紧接着 `agent.py:194 load_state_dict(weights, strict=True)` 把它**全量覆盖**——纯浪费。

**做法**（`laya_bridge.py` 的 `install_fastload()`）：

```
AutoModel.from_config 在 torch.device("meta") 下构建   # 只建形状，不分配、不填充
        ↓
.to_empty(device="cpu")                              # 落成未初始化的真张量
        ↓
重建非持久 buffer（见下的坑）
        ↓
Agent 的 load_state_dict(strict=True) 覆盖全部权重      # 与原生路径同一份权重
```

**★ 唯一的坑：非持久 buffer 不会被 `load_state_dict` 覆盖。**
`tests/fastload_compare.py diag` 实测：本检查点有 **4 个** buffer 不在 `state_dict()` 里，全是 RoPE 的

```
encoder.rotary_emb.full_attention_inv_freq / full_attention_original_inv_freq
encoder.rotary_emb.sliding_attention_inv_freq / sliding_attention_original_inv_freq
```

`persistent=False` 意味着没有任何东西会去覆盖它们，跳过初始化之后它们就是**未初始化内存**——
模型照样能建、能前向、不报错，只是输出是垃圾。**这是最难查的一类失效。**
好在它们只是 config 的纯函数（`compute_default_rope_parameters`），重算即可；
`install_fastload()` 里带守卫：**重算数量 ≠ 未覆盖 buffer 数量** 或 **实体化后仍有 meta 张量**，
就立刻回退到原生构建并在 stderr 说明原因，绝不会把未初始化内存当结果用。

**实测结果（同一台机器、同设备 cuda、同口径）：**

| 口径 | 关闭（原生） | 开启 | 说明 |
|---|---|---|---|
| 干净进程 `ENGINE.init()`（服务启动时用户真正经历的那段） | **35 623 ms** | **12 075 ms** | 剩下 12 s = torch/transformers 导入 + `import laya` + tokenizer，本次改动碰不到 |
| 同脚本、同进程（已预先 import torch/transformers） | 34 452 ms | **8 772 ms** | 差额 25.7 s ≈ 被删掉的随机初始化 |
| 纯 `build_model` 那一段 | 25.15 s | ≈ 0 | 归因 |

**正确性验证（`tests/fastload_compare.py`，走产品自己的开关，不再由脚本另打一份补丁）：**
**10 组输入 × 全 22 问题集**（威胁 / 友好 / 辱骂 / 道歉 / 贿赂 / 提问 / 空输入 / 中性 / 道别 / 好感），
比对 `decision` + `decision_signals` + `policy` + `proposed_deltas` 的全部展开值：

```
键数: 关=1707 开=1707 ；只在一侧的键: 无
★ 不相等的值: 0 / 1707
```

`english` 检查点同样验证（重算 4 个 buffer、未回退、ready）。
开关：`LAYA_FASTLOAD=0` 关闭；`/health` 的 `laya.fastload` / `laya.fastload_rebuilt_buffers` 会报出实际走的哪条路径——
这类「静默加速」如果不报出来，事后没人知道跑的是哪条。

**保留意见**：这次一致性是**同版本、同设备、10 组输入**上的位级一致，
不等于跨版本（0.3.5 → 0.3.7）也一致；上游的 "bit-identical" 是他们自己的对照，不能替他们担保。

**★ 顺带查清的一件行为差异（排查时差点当成新 bug）**：
同样的台词在 live `/decide` 与 CLI 直调 `decide()` 下会得到**不同行为**——
「谢谢你救了我」在 live 上给 `leave`（conf 0.0776），CLI 直调给 `confide`（conf 0.1237）。
原因不是缺陷：`_DECISION_HISTORY` 的累加写在 **HTTP 处理层**（`laya_bridge.py` 内 `_DECISION_HISTORY.extend(...)`），
CLI 直调 `decide()` 不累加。手工注入一轮「刀架脖子」历史后，CLI 结果变成 `leave / argmax=leave / 0.0776`，与 live **完全一致**。
→ 两条结论：① 这是设计（第二轮才体现出上一轮的影响）；② **以后做 live vs 离线对照必须对齐历史窗口**，
否则会把「有历史」误判成「代码不一致」。

### 13.4 同类型项目（和我们这个 Demo 是同一物种）

| 项目 | 星 | 为什么值得看 |
|---|---|---|
| **`ARCJ137442/jev-2048`** | 5 | ★★ 「每一步 2048 都是一次 Jev `choice`，**刻意不做启发式兜底**，概率/置信度/延迟/成本全部摊开可见」—— 和我们「不让 choice 冒充权威、把原始值摊开」是同一个方法论 |
| **`inhabitants/laya-invaders`** | 1 | ★★ 「Laya 从事实里挑目标，**一条单行规则作为 baseline**」—— 和我们 Policy Resolver 的 baseline 对照思路一致 |
| **`wdobry/laya-playground`** | 140 | 「一个网站 + 两个游戏 + 一个 benchmark + 一个 agent skill」 —— 交付形态最接近我们 |
| **`ThinkFlowLab/system1-agents`** | 20 | 把 System 1 决策模型当 agent 大脑，覆盖浏览器/电脑操作、**游戏**、机器人 |
| **`1Panel-dev/laya-server`** | 35 | 自托管 API + Web UI，Jev 兼容格式 —— 我们的 `laya_bridge.py` 的同类 |
| **`receptron/laya`** | 314 | Node.js / TypeScript 经 **ONNX Runtime** 跑 Laya |
| **`mizorewww/laya-mlx`** / **`laya-coreml`** | 5712 / 1346 | Apple MLX / Core ML 移植，M3 Max 上 **7–14 ms / ~5 ms** |
| **`yzfly/edgejev`** | 8 | ★ ONNX + INT8，**4 核 CPU 单题 15.6 ms、运行时不需要 torch** —— 比我们的 GPU 方案更省事（我们 GPU 18 ms/题） |
| **`bladedevoff/stuntd`** | 13 | 「本地代理，**学习你应用的 typed LLM 决策**，用 Laya head 回答」 —— 蒸馏路线 |
| **`ReallyArtificial/stuntdouble`** | 1 | shadow 模式代理：并行跑线上 Jev 与本地模型，**判断能不能替换** |

### 13.5 意图识别方向的参考

| 项目 | 星 | 说明 |
|---|---|---|
| **`jev-chat/jev-chat-windows`** | 393 | ★★ **最贴合「意图识别」的一个**：微信旁挂 → 截图 + 离线 OCR 读对方消息 → **Jev 判断意图** → 3 条候选填入，发送永远手动 |
| `laya` 内置 `triage_questions()` | — | intent / urgency / frustration / churn 四种预设问题，开箱可用 |
| `Anil-matcha/awesome-jev-by-typesafe` | 811 | 用例集，topics 覆盖 `semantic-routing` / `llm-routing` / `reranking` / `classification` |
| `kydlikebtc/awesome-jev` | 170 | **805 条已验证用例，按「它做了什么决策」索引**（不是按博客索引），中英双语 + JSON schema |
| `sutro-sh/jev-align` | 280 | 用**人工反馈** + GEPA 构建校准过的决策函数 —— 对应我们的阈值标定难题 |
| `KNambiarDJsc/second-thought` | 1 | 主动学习 / **漂移检测** / 人在回路 |

### 13.6 酒馆（SillyTavern）方向

**结论：酒馆生态里没有任何项目用决策模型，全部是 LLM prompt 路线。**

| 项目 | 星 | 它解决的其实是我们的哪个问题 |
|---|---|---|
| `SillyTavern/SillyTavern` | 33.7k | 前端本体 |
| `SpicyMarinara/rpg-companion-sillytavern` | 312 | ★★ **追踪角色/任务/物品/游戏状态** —— 对应我们的 ACTOR STATE + 数值面板 |
| `prolix-oc/SillyTavern-SimTracker` | 63 | ★★ 从聊天里的 JSON **生成状态追踪卡片**（RPG / 恋爱模拟的角色属性） |
| `bmen25124/SillyTavern-Roadway` | 82 | ★★ 「帮你对**故事走向做决定**」 —— 对应我们的行为候选 |
| `mattjaybe/SillyTavern-Pathweaver` | 115 | ★ 「把故事/角色扮演变成冒险，带智能**剧情建议**」 |
| `cierru/st-stepped-thinking` | 171 | 「让角色**先思考再回应**」 —— 对应「思考过程」 |
| `muyoou/st-memory-enhancement`（1480）/ `SenriYuki/SillyTavern-Horae`（189）/ `bal-spec/sillytavern-character-memory`（72） | — | 长期记忆层 |
| `bmen25124/SillyTavern-MCP-Client` | 95 | 给酒馆接 MCP —— **如果我们想把 Laya 暴露给酒馆，这是入口** |
| `LYiHub/liars-bar-llm` | 673 | LLM 驱动的「骗子酒馆」对战框架 —— 多 agent 博弈 |

★ 两点判断：

1. **酒馆那套用纯 LLM 解决了同样的需求**（状态追踪、剧情决策、剧情建议、状态卡片），
   而且用户量是几万级。**这说明「NPC 行为决策」在角色扮演场景里，用户接受 LLM 即兴**
   —— 我们 Demo 的「可复现、可审计」卖点，在酒馆用户那里**不构成痛点**。
   这是对产品定位的一个负面信号，比技术指标更值得注意。
2. 反过来看也是**空位**：没人用判别式模型做酒馆的意图/剧情决策层。
   若要做，落点应该是 **ST 扩展（`SillyTavern-MCP-Client` 或直接写扩展）**，
   而不是独立前端 —— 因为流量在酒馆那里。

### 13.7 ⚠️ 用这些项目时要注意的「星数不可信」问题

这个生态目前处于**明显的炒作/刷榜期**，选型时不要看星数：

- 主仓 **5 天前创建，已 18.5k star**；`laya-mlx` 4 天 5.7k。
- **至少 10 个内容几乎一样的 `awesome-jev*` 列表**，多个在 2026-09-17~22 一周内创建，
  描述模板高度雷同（「curated, source-backed list of projects built with Jev」），星数从 0 到 1389 不等。
- 有仓库在描述里直接写「全网最全」「每日重扫，含批判」当作卖点。

→ **判断标准换成可验证的三条**：① 有没有公开 benchmark 与复现脚本；
② 有没有可看的具体数字；③ 代码能不能跑。
按这个标准，本节里 13.1（上游文档自述）、13.2（上游 issue）、13.3（fine-tune 配方）、
`jev-2048`、`laya-invaders`、`edgejev`、`jev-chat-windows` 是**可验证的**；
`awesome-*` 列表只当索引用，不当证据。

---

## 14. Phase3 P0：真交接 + 历史隔离（2026-09-23）

> 提交 `9562724`。验收脚本 `tests/p0_acceptance.py`，**20 PASS / 0 FAIL**（RTX 4060 / typed-decisions）。

### 14.1 「交回上游」原来在实现上不成立

`policy_resolve()` 判出歧义时，返回的是：

```python
{"behavior": choice_baseline, "source": "ambiguous", "fallback": "story_agent", ...}
```

看起来是「给了上游一个标签」。但：

| 消费者 | 读什么 | 结果 |
|---|---|---|
| `decide()` | `policy.get("behavior") or choice_argmax` | 拿到 `choice_baseline` → **当成最终行为** |
| `/narrate` | `payload.behavior.id` | 拿到同一个 → **照常生成台词** |
| 前端 | `out.decision.behavior` | 照常渲染「她选了 X」 |
| `policy.fallback` | **全仓库零消费者**（只有两处把它当标签显示） | 没人读 |

也就是说：**歧义轮次照样产出一个具体行为、照样念出台词**，而调用方从响应里
完全看不出「其实没人拍板」。这不是「交接得不够优雅」，是**这个机制根本没有接上**。

### 14.2 改法

- `policy_resolve()` ambiguous → `behavior=None`，`fallback="story_agent"` 保留（给上游看的标签）。
- `decide()` 去掉 `or choice_argmax` 兜底。仅在 **policy 配置异常**（有非歧义 source 但没给行为 /
  给了不在 `behaviors` 里的名字）时才回落，并把原因写进 `policy.reasons` —— 异常要吵，不能静默。
- `/narrate`：未带 behavior 且本轮判歧义 → 返回 `awaiting_upstream: true`、`line: null`，
  **不生成台词**。
- 前端：新增专用中断态「**Laya 不确定 · 交由上游模型裁决**」，虚线橙框、刻意不像 NPC 气泡，
  并列出 `fallback` / `choice 首选（未被采纳）` / `turn_id`。
- 新增字段让这件事**可验证而不必读代码**：`decision.awaiting_upstream`、
  `decision.behavior_is_null`、`decision.behavior_null_reason`、`choice_baseline.adopted`。

### 14.3 决策历史：全局单例 → 按 (session, actor) 分桶 + 提交门控

删掉了进程级全局 `_DECISION_HISTORY`。它让两个 NPC、两个冒险、两个浏览器会话
共用同一条历史，而且**完全静默**（实测复现：同一句台词在 live 与 CLI 直调下行为不同）。

三道门：`proposed`（`/decide` 只登记，不写历史）→ `committed`（新增 `POST /commit` 才写）。
`behavior=null` 的轮次**永远无法提交** —— 没有行为就没有可确认的事实。
`/reset` 改为按桶清；`/history` 暴露分桶结构，不再暴露那条废弃的全局。

前端补了 `session_id` / `actor_id`，并让「重开一局」**连服务端桶一起清**再换新 session id
——只清前端 `history` 是假的，桥里的桶还在。

### 14.4 验收数字（`tests/p0_acceptance.py`）

| 项 | 结果 |
|---|---|
| 3 句中性输入里判为歧义的 | **1 句** → `behavior=None` / `fallback=story_agent` / `/narrate` 无台词 / `adopted=false` |
| 60 轮（2 会话 × 3 NPC × 10 交替） | 全部正常；**11 轮歧义**（18.3%，不可提交）；**9 轮 commit** |
| 桶隔离 | A / B 各 3 个 actor 桶，互不包含 |
| 内容级串扰（比条数更硬） | A 有历史时 `decision_history`=2 条、**全新会话=0**；同输入不同会话 `state_doc` 不同 |
| 提交门 | `/decide` 后桶仍空；commit 后才有；**重复 commit 同一 turn_id → 409** |

### 14.5 ⚠️ 本轮自己引入、又自己在验收里抓到的 bug

`behavior_null_reason` 里写了 `"；".join(ambiguity_reasons)`，但 `assess_ambiguity()`
返回的是**字典列表**，不是字符串列表 → 抛 `TypeError`。后果很阴：

> **越该进歧义分支的轮次越会崩，正常轮次完全看不出来。**

在验收脚本里表现为 **3 个看起来互不相干的失败**（1 条用例 + 60 轮里的若干），
实际是同一个根因。修法是加 `_why_text()` 统一处理 reasons 的三种形状
（`{why:...}` 字典 / 纯字符串 / 嵌套列表）。

**可复用的教训**：当失败只在某条分支上出现时，先怀疑**那条分支里的结构假设**
（字符串 vs 对象），而不是急着当三个独立 bug 修。

### 14.6 P0 刻意**没**做的事

歧义阈值（`mid_low 0.35 / mid_high 0.65 / margin 0.08 / min_signals 3`）**没动**。
P0 只修「判出歧义之后怎么交接」，不碰「判得准不准」。所以：

- 歧义召回率仍然低（3 句中性输入只有 1 句被判歧义）——**这是阈值问题，不是交接问题**；
- 阈值要等 P1 的逐 signal 分布出来之后再校准，否则就是「因单次测试好就写生产阈值」，
  正是任务清单里明令禁止的。

---

## 15. ★ Phase3 P1：逐 signal 指标与分级（主结论）

> `python laya_bridge.py signalmetrics`。结果落 `tests/signal_metrics.json`。
> bootstrap n=2000 / seed=20260923（固定种子，同输入必然同结论）。

### 15.1 为什么必须先重建用例集

第二轮的「方向准确率 49.5% / 51.5%」这个数**不能用来做任何判断**，因为它把两种
完全不同的能力揉成了一个数：

- 「玩家说了一句威胁 → 敌意该高」：NPC 能观察到，做得到是本分；
- 「玩家在撒谎 → 应该识破」：**NPC 观察不到**，要求它做到是评测错误。

旧口径 48 条里混着 16 条后者。剔掉后 typed-decisions `0.4949 → 0.5663`、
english `0.5152 → 0.6145`（+7.1pp / +9.9pp）—— 也就是说**七到十个百分点是评测口径造成的假缺陷**。

### 15.2 三组用例集（`tests/cases/`）

| 组 | 条数 | 断言 | 判据 |
|---|---|---|---|
| `observable` | **70** | 518 | 期望方向**完全由 NPC 可观测信息推出** |
| `contextual` | **48** | 306 对 | **成对**：同句在「无前文 / 注入前文」下跑两次，断言**增量符号** |
| `hidden_truth` | **20** | 38 | 每条带 `omniscient: true`；`counts_in_main_accuracy: false` |

旧的 `regression_cases.json` 保留为 legacy（旧口径对照用），`cmd_signaltest` 仍能跑。

**★ 用例集必须做平衡性静态校验**（这一步救了一次 7 分钟的白跑）：
第一版 observable 只写了方向性期望（如 `cooperation` 全是 `high`），
结果 15 个维度里 **12 个因为缺 low 组而无法计算 AUC**，只报「两组不齐」。
那是**用例集的缺陷，不是模型的发现** —— 如果不先静态数一遍，就会把它当成结论写进报告。
现在每个维度两侧各 ≥10 条断言。

### 15.3 主结论：逐 signal 判别力（**仅 observable**，518 条断言）

| signal | kind | nHi | nLo | 均值Hi | 均值Lo | meanGap | AUC | 最佳阈值 | 阈值准率 | AUC 95%CI | 等级 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hostility | prob | 23 | 41 | 0.456 | 0.420 | +0.036 | 0.660 | 0.4619 | 0.703 | (0.510, 0.798) | B |
| cooperation | prob | 24 | 19 | 0.455 | 0.404 | +0.051 | 0.706 | 0.3746 | 0.721 | (0.536, 0.857) | A |
| withdraw | prob | 23 | 14 | 0.359 | 0.349 | +0.011 | 0.571 | 0.3565 | 0.595 | (0.372, 0.779) | C |
| confront | prob | 25 | 14 | 0.504 | 0.473 | +0.031 | 0.681 | 0.4617 | 0.769 | (0.497, 0.864) | C |
| disclose | prob | 10 | 18 | 0.469 | 0.481 | **−0.012** | **0.464** | 0.3973 | 0.429 | (0.244, 0.692) | **D** |
| investigate | level | 19 | 10 | 2.894 | 2.679 | +0.215 | **0.905** | 2.8305 | 0.862 | (0.763, 0.994) | **A** |
| trust | prob | 19 | 23 | 0.400 | 0.365 | +0.035 | 0.716 | 0.3974 | 0.714 | (0.537, 0.865) | A |
| doubt | prob | 19 | 26 | 0.450 | 0.441 | +0.009 | 0.600 | 0.4615 | 0.689 | (0.426, 0.775) | C |
| danger | prob | 18 | 22 | 0.512 | 0.501 | +0.011 | 0.576 | 0.5277 | 0.675 | (0.381, 0.762) | C |
| trust_shift | level | 15 | 10 | 2.274 | 2.112 | +0.162 | 0.827 | 2.2343 | 0.760 | (0.639, 0.971) | **A** |
| respect_shift | level | 13 | 10 | 2.202 | 2.132 | +0.070 | 0.615 | 2.2178 | 0.652 | (0.357, 0.857) | C |
| doubt_shift | level | 10 | 15 | 2.708 | 2.520 | +0.188 | 0.847 | 2.6295 | 0.800 | (0.660, 0.987) | **A** |
| fondness_shift | level | 21 | 10 | 2.174 | 1.978 | +0.195 | 0.790 | 2.1023 | 0.774 | (0.600, 0.942) | **A** |
| alert_shift | level | 17 | 10 | 2.575 | 2.494 | +0.081 | 0.688 | 2.5264 | 0.741 | (0.466, 0.901) | C |
| goal_shift | level | 10 | 10 | 2.724 | 2.630 | +0.094 | 0.610 | 2.689 | 0.650 | (0.333, 0.853) | C |

### 15.4 ★ 分层结论：score 型可用，noul 型基本不可用

把上表按 kind 分组：

| kind | n | AUC 均值 | A 级 | B 级 | C 级 | D 级 |
|---|---|---|---|---|---|---|
| **level**（score 期望值 0~4） | 7 | **0.755** | 4 | 0 | 3 | 0 |
| **prob**（noul 概率 0~1） | 8 | **0.621** | 2 | 1 | 4 | 1 |

★ **本表的 A/B/C/D 是「判别力口径」（口径 ①），不含上下文维度**。同一份数据在
「最终口径 `min(判别, 上下文)`」下 A 只有 3 个。两个数都对，混用就错 ——
三个口径的对照见 §15.8 的口径声明。另外本表 prob 组有 **2 个 A 级**
（`cooperation`、`trust`），这与 §15.9 第 2 条的措辞原先不一致，已在 §15.9 修正。

**这是本轮最有行动价值的一条结论**，而且它是本机独立测出来的 ——
与上游 issue #156（「`noul` 跟随选项标签而不是跟随状态」）方向完全一致：
**同一个检查点里，score 分支的信号明显比 noul 分支可信。**

另外两个直接可用的观察：

- **noul 全都挤在 0.5 附近**：8 个 prob 信号的组均值差只有 +0.011 ~ +0.051，
  最佳阈值也全部落在 0.35~0.53 —— 说明 noul 的输出基本是一个**常量偏置**，
  而不是随输入变化的量。`danger` 的中位差甚至是 **−0.001**。
- **`disclose` 是反向的**：AUC 0.464 < 0.5，即「该透露秘密时它的值反而更低」。
  虽然 CI 跨过 0.5（暂记 D 而不是 R），但均值差为负、中位差为 0 —— 这个信号现在
  **不能按字面使用**。

### 15.5 上下文维度（成对增量，定向统计）

统计量是**定向 Δ**（期望 `up` 用 `+Δ`，期望 `down` 用 `−Δ`）。
★ 第一版这里算的是**裸 Δ 的均值**，方向相反的配对会互相抵消，把「有反应」算成「没动」——
这是个必须修的错误，见 15.6。

| signal | 配对 n | 均Δ(定向) | 方向对率 | 越噪声底 | 均值 95%CI | 等级 |
|---|---|---|---|---|---|---|
| hostility | 22 | +0.025 | 68% | 50% | (0.007, 0.043) | C |
| cooperation | 17 | +0.006 | 59% | 76% | (−0.048, 0.057) | C |
| withdraw | 12 | −0.003 | 58% | 42% | (−0.040, 0.031) | C |
| **investigate** | 10 | **−0.151** | **10%** | 80% | **(−0.220, −0.079)** | **R** |
| trust | 16 | +0.020 | 56% | 38% | (−0.010, 0.048) | C |
| doubt | 25 | +0.013 | 64% | 44% | (−0.019, 0.045) | C |
| danger | 10 | −0.006 | 50% | 10% | (−0.026, 0.011) | D |
| confront | 1 | — | — | — | — | N（样本不足） |

噪声底取 **0.05**（第二轮实测：设备漂移 0.033 / 翻译抖动 0.055）。

**读法**：除 `investigate` 外，所有信号的上下文效应**都低于噪声底**
（定向均 Δ 只有 0.006~0.025，而噪声底是 0.05）。也就是说：

> 把前文喂进去，NPC 的信号基本**不动**。

对 Projection Layer 而言这是**比「不准」更根本的问题** —— 一个不随世界状态变化的量，
无论多准都不能当「状态投影」的输入，它只能是常量。

### 15.6 ★ 三个方法论问题（都是本轮自己发现并修掉的）

**(1) hidden_truth 混进了 AUC。** 第一版把三组配对一起汇总算 AUC。
错的：hidden_truth 的期望方向依赖 NPC 观察不到的事实，模型**原理上不可能满足**，
并进来会系统性压低 AUC —— 这正是任务清单里「不把 hidden truth 混进 observable」禁止的事。
现在判别力**只用 observable**，hidden_truth 单列一段并标注 `counts_in_main_accuracy: false`。

**(2) 上下文统计量用了裸 Δ。** 同一个 signal 既有期望 `up` 的配对、也有期望 `down` 的，
裸 Δ 求均值会互相抵消。现在用**定向 Δ**。

**(3) ★ bootstrap CI 不覆盖「重复运行」方差。** 这是本轮新发现，值得单独记住：

同一份 observable 用例集、同一台机器、**三次独立运行**的 AUC：

| signal | 第1次 | 第2次 | 第3次 | 极差 |
|---|---|---|---|---|
| doubt_shift | 0.920 | 0.920 | 0.847 | **0.073** |
| goal_shift | 0.680 | 0.610 | 0.610 | **0.070** |
| confront | 0.721 | 0.693 | 0.681 | 0.040 |
| withdraw | 0.606 | 0.606 | 0.571 | 0.035 |
| hostility | 0.664 | 0.682 | 0.660 | 0.022 |
| （8 个维度） | — | — | — | **0.000** |

**中位极差 0.013，最大 0.073，5/15 个维度极差 > 0.02。**

> **★ 更正（2026-09-23，见 §16.2）**：这条「跑次方差」**不成立**。
> §16 在**真正冻结条件**（翻译缓存完备 + 前后哈希核对 + 逐用例 state_budget）后
> 两检查点各跑 3 次，**15/15 个 AUC 逐位相同，跑次区间 = 0.000**。
> §15.6 这张表的 `doubt_shift` 是 0.920/0.920/0.847，而 §15.3 已发布表里是 0.847 ——
> **两次用的不是同一套用例**，所以它测到的很可能是**输入在变**，不是模型在抖。
> 更正后更锋利的教训是：**「输入管线是可变的，必须冻结并留下可校验的证据」**；
> 并且 **跑次区间 = 0 不等于「结论稳」**，它对「换一条用例就翻」毫无免疫力
> （`obs_crow_3` 一条坏输入就把 `goal_shift` 从可计算打成 `N`）。
> 下面「任何阈值都不可能靠单次实验定下来」这个**操作结论仍然成立**，
> 但理由要换：不是因为模型随机，而是因为**输入面（缓存/用例/state 长度）会变**。

含义很直接：表里的 bootstrap CI 只反映**单次运行内**的重采样方差，
**不包含运行间方差**。对那 5 个维度，真实不确定度比 CI 宽度更大。
→ **任何阈值都不可能靠单次实验定下来**；这也反过来解释了为什么
任务清单要求「不因单次测试好就写生产阈值」。

### 15.7 「稳定反向」必须单列一级：R

`investigate` 的上下文效应是本轮**唯一**超过噪声底、且 CI 不含 0 的效应 ——
但方向与设计预期**相反**：10 个话题连续性配对里 **9 个是下降**，幅度最大 −0.361。

第一版的分级规则把它判成了 **B**（「有反应就是好」）。这是个危险的规则漏洞：

> **一个可靠地往反方向走的信号，比一个纯噪声信号更危险** ——
> 噪声不会骗人，反向会。

所以新增 **R 级**（稳定反向）：CI 不含 0 且越噪声底 ≥60% 且**方向对率 ≤25%**。
`investigate` 最终等级 `min(A, R) = R`。

**取证**（`ctx_topicshift_*` / `ctx_topic_extra_*` 逐条 Δ）：

```
ctx_topic_extra_3  −0.361   ctx_topic_extra_6  −0.310
ctx_topic_extra_4  −0.195   ctx_topic_extra_5  −0.143
ctx_topicshift_3   −0.159   ctx_topicshift_4   −0.141
ctx_topic_extra_2  −0.114   ctx_topic_extra_1  −0.109
ctx_topicshift_2   −0.022   ctx_topicshift_1   +0.043
```

两种解释，**现在还不能定**（两种都指向同一条操作结论）：

1. **我的用例期望写反了**：省略句的歧义是**对读者**的，不是对 NPC 的。
   NPC 有了前文反而「知道在说什么」，所以调查倾向**降低**才是对的。
2. **信号语义与命名相反**：`investigate` 名义是「调查需求」，实际更像「信息缺口 / 困惑感」——
   有前文 = 缺口变小 = 值降低。

**无论哪种，可操作的结论一样**：`investigate` 的值随「已有上下文」**单调下降**，
这是一个稳定、超越噪声的效应。它可以当「信息是否已被给出」的**反向**指示器，
但**绝不能**按字面「调查需求」使用。**在查清是哪一种之前，禁止用它写任何阈值。**

### 15.8 最终等级（`min(判别, 上下文)`）

合并规则写在 `combine_grades()` 里。取 min 的理由：Projection Layer 的意义就是
「随世界状态变化」；一个只能靠固定阈值把两组人分开、但对前文完全无反应的信号，
无法承担这个职责 —— 它更像一个常量偏置。

| 等级 | signal | 含义 |
|---|---|---|
| **A** | `trust_shift`、`doubt_shift`、`fondness_shift` | 可以作行为的直接输入 |
| **B** | — | 可作强提示但需上层规则约束 |
| **C** | `hostility`、`cooperation`、`withdraw`、`confront`、`trust`、`doubt`、`respect_shift`、`alert_shift`、`goal_shift` | 只能当合取项，禁止单独定行为 |
| **R** | `investigate` | **稳定反向** —— 只能反向使用，且须先查清 15.7 的两种解释 |
| **D** | `disclose`、`danger` | 不可用，不要拿它写阈值 |

**★ 口径声明（必读；不读这一段，会数出三个不同的「A 级个数」，然后以为表格出错）**

本报告里「A 级」出现在**三个不同口径**下。数字不一样是正常的，**混着读才是错的**：

| 口径 | 数的是哪一步 | A 级 signal | 个数 |
|---|---|---|---|
| ① 判别力口径（§15.3 / §15.4 的表） | 只看 AUC + CI，**不含上下文** | `cooperation`、`investigate`、`trust`、`trust_shift`、`doubt_shift`、`fondness_shift` | **6** |
| ② 判别力口径 · 只数 level 组（§15.9 第 1 条） | 同上，但范围限 7 个 level 型 | `investigate`、`trust_shift`、`doubt_shift`、`fondness_shift` | **4** |
| ③ 最终口径 `min(判别, 上下文)`（本节上表） | 判别力与上下文**取差** | `trust_shift`、`doubt_shift`、`fondness_shift` | **3** |

所以：**§15.9 第 1 条说的「7 个 level 里有 4 个 A 级」用的是口径 ②；
本节上表只列 3 个用的是口径 ③。第 4 个 signal 就是 `investigate`**
（判别力 AUC 0.905，15 个 signal 里最高）—— 它被 §15.7 的上下文反向拉到 R。
**这不是统计错误、也不是表格漏行，是口径差。**

★ 同时承认一个真实缺陷：§15.9 是**同一个编号列表**，第 1 条用口径 ②、第 2 条用口径 ③，
读者无法从上下文分辨 —— 这是本报告原先的表述问题，本节即为此补充。
**做跨检查点对照时也必须带着这个口径差去读**，否则「english 上几个 A」同样会数错。

### 15.9 结论：Laya 能不能当 Actor / World State Projection Layer 的信号源？

**能，但只能作为「得分型信号源」，且必须逐 signal 分权，不能整体接入。**

三条依据：

1. **7 个 level 型信号里有 4 个达到 A 级**（`investigate` 0.905 / `doubt_shift` 0.847 /
   `trust_shift` 0.827 / `fondness_shift` 0.790）。这些 AUC 与 CI 都站得住，
   在 518 条断言、两侧各 ≥10 的样本上取得。
   ★ 这是**判别力口径**（口径 ②，见 15.8 的口径声明）—— 其中 `investigate` 最终降为 R，
   **不能**按这一句直接当输入用；能直接作输入的只有另外 3 个。
2. **8 个 noul 型信号里没有一个 A 级**，且全部挤在 0.5 附近、最佳阈值落在 0.35~0.53。
   ★ 这句原先只对**最终口径**成立（口径 ③）。按**判别力口径**（口径 ①）其实有
   **2 个** A 级：`cooperation` 0.706、`trust` 0.716 —— 它们判别力站得住，
   是因为**对前文完全无反应**才被 max/min 规则降到 C。
   说「noul 全都不行」是过度概括；准确的说法是「**noul 里没有能同时满足判别力与上下文响应的**」。
   这不是「阈值没调好」，是**输出本身缺少动态范围**（与上游 #156 一致）。
   把它们当概率用是错的 —— 任务清单里「不把 noul 数值称为真实概率」这条，
   本轮有了本机数据支持。
3. **上下文响应普遍测不出来**（唯一测到的那个还是反向的）。
   Projection Layer 最核心的职责是「随世界状态变化」，而当前证据显示：
   喂进前文之后，绝大多数信号**不动**。这一条是**目前最大的阻碍**，
   比准确率不足更根本。

**因此当前可落地的形态是**：
Laya 提供**倾向/势能**（倾向 A 级那 4 个 signal，及其余 C 级信号作为合取项），
**由 Narraverse Policy 决定行为**；不要期待 Laya 提供「状态投影」意义上的世界建模。

> **★ 本结论已被 §16 收窄（务必连着读）**：上面「倾向 A 级那 4 个 signal」是
> **单检查点口径**。§16 的跨检查点复现实验显示，这 4 个里**只有 `trust_shift` 在
> english 上仍是 A**（`doubt_shift`→D、`fondness_shift`→C、`investigate`→R），
> 并且 §15.4 的「score 型可用 / noul 型不可用」在 english 上**反号**。
> **P2 的信号选择请以 §16.8 为准。**

### 15.10 本轮**没**做、且不能声称做了的

- 英文检查点（`english`）的同口径对照 —— 需要**另一个进程**重跑（检查点不能在进程内切换）。
  ~~本轮没跑~~ → **已在 §16 完成**（两检查点各 3 次独立运行）。
  结果：**§15.9 里「4 个 A 级」的那 4 个，在 english 上只有 `trust_shift` 仍然是 A**；
  `doubt_shift` 掉到 D、`fondness_shift` 掉到 C、`investigate` 仍是 R。
  **§15.9 的结论需要按 §16.8 的跨检查点口径重读，不要单独引用 §15.9。**
- 歧义阈值校准（P0 明确没动，见 14.6）。
- `noul → 两选项 choice` 重写（上游 #156 的 workaround）—— 这是 15.4 结论的**验证实验**，
  应该做，但属于 P2 之后。
- P2~P9 全部未开始（任务清单规定「P0 + P1 完成以前，不进入后续正式实现」）。
  截至本节，**P0 与 P1 均已完成**，门已打开。

---

## 16. ★ Phase3 English checkpoint 独立复现实验（2026-09-23）

**要回答的问题**：§15 的 P1 结论，究竟是 **Laya 的能力特征**，还是
**`typed-decisions` 这单一检查点**的特征？

**做法（严格冻结 P1 条件，只换检查点）**：

| 冻结项 | 值 |
|---|---|
| 用例集 | `observable.json` sha256 前 16 = `6181eb87de04baf9`（70 条）｜`contextual.json` = `e34edc68989f601c`（48 条）｜`hidden_truth.json` = `64933965adcebf56`（20 条） |
| 评分规则 | 未改（`grade_signal()` / `grade_context()` / `combine_grades()` 原样） |
| 噪声底 / bootstrap | 0.05 ｜ n=2000 seed=20260923 |
| 翻译缓存 | 173 条，sha256 前 16 = `bfa17f6de3798a69`，**6 次运行前后都不变** |
| 检查点 | 只换 `LAYA_MODEL`；各自**独立新进程**；每次运行**单独留档** `tests/runs/` |
| 运行次序 | **交错**：en1 → td1 → en2 → td2 → en3 → td3（避免「检查点」与「时间」共线） |

### 16.1 输入有效性（req.5）：0 溢出，0 剔除

| 检查点 | max_len | head | **room** | 本套用例 token | 溢出 |
|---|---|---|---|---|---|
| `typed-decisions` | 1024 | 256 | **767** | 222 ~ 254（中位 236） | **0** |
| `english` | 512 | 192 | **319** | 222 ~ 254（中位 236） | **0** |

★ **req.5 担心的那件事没有发生**：english 的 room 确实只有 td 的 42%，
但 compact state 的实测占用是 222~254 token，**离 319 还有 65 token 余量**，
`observable / contextual / hidden_truth` 三组**一条都没溢出**。

报告里原先「切 english 就会静默变差」（见 `state_budget()` docstring 的
`en 372 ★溢出 / zh 371 ★溢出`）**测的是旧的 12 字段 `full` state 形态**；
compact 形态把长键名和缩进省掉之后就不爆了。
**结论：english 与 td 的输入都是完整的，两边可以公平比较**
—— 「english 更差」不是被截断造成的。

### 16.2 ★★ 先纠一个比结论本身更重要的方法论错误

**P1 §15.6 说的「跑次方差」其实不是模型的属性，是我测试台的缺陷。这轮把它揪出来了。**

**事故过程**（有原始文件为证，留档在 `_diag/mixed_condition_runs/`）：

1. `obs_crow_3`（70 条 observable 里的一条，20:20 才加进用例集）不在翻译缓存里。
2. `translate_to_en` 在本机**间歇性返回空串**（HTTP 200 但 `content` 为空，
   见 §16.7 的实测），`_cached_translate` 于是**静默回落**：`message` 字段被填成**中文原文**。
3. 第 1、2 次 english 运行读到缓存缺这条 → 判为 invalid → 打印 **69/70，剔除 1 项**。
4. **20:55:50**（第 2 次运行进行中）那次 LLM 调用偶然成功，译文被写进缓存。
5. 第 3 次运行读到 **70/70，0 剔除** → 条件变了，AUC 随之改变。

**后果**：同一组号称「3 次独立运行」的数据里**混了两种条件**，而且**全程没有任何报错**。

**修法（已落地在代码里，不是靠自觉）**：

- 新增 `tests/replication/prewarm_cache.py`：开跑前一次性补齐缓存。
- `signalmetrics` 开跑前**断言缓存完备**，缺任何一条就 `return 2` **拒绝执行**，
  并提示先预热 —— 不允许「边跑边改条件」。
- 每次运行**前后各取一次缓存 sha256**，不一致就在报告里报警并写进
  `validity.cache_changed_during_run`。
- 运行结果**每次单独落盘** `tests/runs/<检查点>__<run_id>.json`（含逐用例 `budgets`）。

**修好之后的实测（这是本节的地基）**：

| 检查点 | 3 次运行 AUC 完全相同的 signal | 跑次区间 | 缓存哈希 | 运行中被改写 |
|---|---|---|---|---|
| `typed-decisions` | **15 / 15** | **0.0000** | 3 次全同 | `[False, False, False]` |
| `english` | **15 / 15** | **0.0000** | 3 次全同 | `[False, False, False]` |

**两个检查点在本机型上都是确定性的**（同一份输入 → 逐位相同的输出）。
交叉验证：**新的 english run1 与事故里那次 70/70 的旧 run3，15/15 个 AUC 完全相同**
（`0.6352 0.7719 0.5047 0.4143 0.8889 0.6895 0.7780 0.6144 0.4470 0.8067 0.6692 0.4067 0.7238 0.5000 0.4500`）。

**⟹ 对 §15.6 的更正**（两处已同步修改：本节 + README）：

- §15.6 说「同条件三次独立运行的 AUC 中位极差 0.013、**最大 0.073**、5/15 个维度 >0.02」。
  **在条件真正冻结的前提下，这个数复现不出来 —— 实测跑次区间是 0.000。**
- 顺带可解释 §15.6 那张表为什么和 §15.3 的表对不上：
  它的 `doubt_shift` 是 **0.920 / 0.920 / 0.847**，而 §15.3 已发布表里是 **0.847** ——
  **两次用的不是同一套用例**。所以它测到的很可能是**输入在变**（用例集/缓存），
  而不是模型在抖。（第二种可能是当时跨了设备或批处理组合，无法完全排除。）
- **更正后的教训更锋利**：不是「模型是随机的」，而是
  **「输入管线是可变的，必须冻结并留下可校验的证据」**。
- **另一个不能反过来误读的点**：跑次区间 = 0 **不等于**「结论很稳」。
  确定性只说明「重复跑学不到新东西」，它**不提供任何**对「换一条用例就翻」的免疫力。
  现成的反例就在眼前：`obs_crow_3` 一条用例把 `goal_shift` 的 high 侧样本从 10 打到 9，
  直接让它掉出可计算范围（等级 `N`）—— **一条坏输入就能改变一个 signal 的可评价性**。

### 16.3 跨检查点对照主表（req.3 要求的全部列）

AUC 列是 3 次运行的完整值 + 中位（括号内为跑次区间）。CI 取自 AUC 最接近中位的那一次运行，
**只覆盖同一次运行内的 bootstrap 重采样**。`上下文Δ` 是定向 Δ 的中位。

| signal | kind | td AUC×3（中位/区间） | td CI | td 均值差 | td 阈值 | td 上下文Δ | td 等级 | en AUC×3（中位/区间） | en CI | en 均值差 | en 阈值 | en 上下文Δ | en 等级 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `hostility` | prob | 0.665 0.665 0.665 / 0.665（0.000） | (0.514, 0.801) | +0.038 | 0.462 | +0.025 | C/C/C | 0.635 0.635 0.635 / 0.635（0.000） | (0.494, 0.765) | +0.042 | 0.274 | +0.042 | C/C/C |
| `cooperation` | prob | 0.706 0.706 0.706 / 0.706（0.000） | (0.536, 0.857) | +0.051 | 0.375 | +0.006 | C/C/C | 0.772 0.772 0.772 / 0.772（0.000） | (0.607, 0.898) | +0.200 | 0.361 | +0.039 | C/C/C |
| `withdraw` | prob | 0.571 0.571 0.571 / 0.571（0.000） | (0.372, 0.779) | +0.011 | 0.356 | −0.003 | C/C/C | 0.505 0.505 0.505 / 0.505（0.000） | (0.311, 0.703) | +0.005 | 0.490 | +0.280 | D/D/D |
| `confront` | prob | 0.664 0.664 0.664 / 0.664（0.000） | (0.476, 0.848) | +0.027 | 0.462 | +0.076 | C/C/C | 0.414 0.414 0.414 / 0.414（0.000） | (0.238, 0.606) | −0.041 | 0.494 | +0.064 | D/D/D |
| `disclose` | prob | 0.464 0.464 0.464 / 0.464（0.000） | (0.244, 0.692) | −0.012 | 0.397 | — | D/D/D | 0.889 0.889 0.889 / 0.889（0.000） | (0.740, 0.989) | +0.165 | 0.429 | — | A/A/A |
| `investigate` | level | 0.895 0.895 0.895 / 0.895（0.000） | (0.747, 0.990) | +0.209 | 2.809 | −0.151 | R/R/R | 0.690 0.690 0.690 / 0.690（0.000） | (0.467, 0.877) | +0.068 | 2.294 | −0.410 | R/R/R |
| `trust` | prob | 0.716 0.716 0.716 / 0.716（0.000） | (0.537, 0.865) | +0.035 | 0.397 | +0.020 | C/C/C | 0.778 0.778 0.778 / 0.778（0.000） | (0.623, 0.908) | +0.118 | 0.350 | +0.099 | B/B/B |
| `doubt` | prob | 0.618 0.618 0.618 / 0.618（0.000） | (0.438, 0.788) | +0.013 | 0.462 | +0.013 | C/C/C | 0.614 0.614 0.614 / 0.614（0.000） | (0.450, 0.777) | +0.022 | 0.272 | −0.004 | C/C/C |
| `danger` | prob | 0.576 0.576 0.576 / 0.576（0.000） | (0.381, 0.762) | +0.011 | 0.528 | −0.006 | D/D/D | 0.447 0.447 0.447 / 0.447（0.000） | (0.255, 0.637) | −0.004 | 0.235 | +0.051 | D/D/D |
| `trust_shift` | level | 0.827 0.827 0.827 / 0.827（0.000） | (0.639, 0.971) | +0.162 | 2.234 | — | A/A/A | 0.807 0.807 0.807 / 0.807（0.000） | (0.591, 0.956) | +0.144 | 2.142 | — | A/A/A |
| `respect_shift` | level | 0.615 0.615 0.615 / 0.615（0.000） | (0.357, 0.857) | +0.070 | 2.218 | — | C/C/C | 0.669 0.669 0.669 / 0.669（0.000） | (0.405, 0.894) | +0.118 | 2.060 | — | C/C/C |
| `doubt_shift` | level | 0.847 0.847 0.847 / 0.847（0.000） | (0.660, 0.987) | +0.188 | 2.630 | — | A/A/A | 0.407 0.407 0.407 / 0.407（0.000） | (0.160, 0.653) | −0.018 | 2.236 | — | D/D/D |
| `fondness_shift` | level | 0.790 0.790 0.790 / 0.790（0.000） | (0.600, 0.942) | +0.195 | 2.102 | — | A/A/A | 0.724 0.724 0.724 / 0.724（0.000） | (0.500, 0.933) | +0.170 | 1.752 | — | C/C/C |
| `alert_shift` | level | 0.688 0.688 0.688 / 0.688（0.000） | (0.466, 0.901) | +0.081 | 2.526 | — | C/C/C | 0.500 0.500 0.500 / 0.500（0.000） | (0.263, 0.736) | −0.046 | 2.023 | — | D/D/D |
| `goal_shift` | level | 0.590 0.590 0.590 / 0.590（0.000） | (0.307, 0.838) | +0.088 | 2.630 | — | C/C/C | 0.450 0.450 0.450 / 0.450（0.000） | (0.191, 0.725) | −0.018 | 1.898 | — | D/D/D |

**★ P1 已发布表格的更正说明**：P1 那次运行里 `obs_crow_3` 的 `message` 被喂成中文。
本轮修正后，td 的 AUC 变化**最大 0.020**（`goal_shift` 0.610→0.590，
`doubt` 0.600→0.618，`confront` 0.681→0.664，`investigate` 0.905→0.895，`hostility` 0.660→0.665），
**没有任何 signal 的等级发生变化**。所以 P1 的主结论**不是**被这条缺陷造成的 ——
但要记住：这条缺陷是**静默**的，这一轮能发现它，靠的是「逐用例记 state_budget + 独立可复现」，
不是靠它自己暴露。

### 16.4 三分类结果（req. 的核心交付）

判定规则**写死在代码里**（`tests/replication/ckpt_analysis.py` 的 `classify()`），
优先级固定为：**反向 ＞ 跑次不一致 ＞ 跨检查点稳定 ＞ 检查点特有**，不许事后挑好听的桶。

| 类别 | 个数 | signal |
|---|---|---|
| **① 跨检查点稳定** | **6** | `hostility`(C/C)、`cooperation`(C/C)、`doubt`(C/C)、`danger`(D/D)、`trust_shift`(**A/A**)、`respect_shift`(C/C) |
| **② 检查点特有** | **8** | `withdraw`(C→D)、`confront`(C→D)、`disclose`(**D→A**)、`trust`(C→B)、`doubt_shift`(**A→D**)、`fondness_shift`(**A→C**)、`alert_shift`(C→D)、`goal_shift`(C→D) |
| **③ 不可靠 / 反向** | **1** | `investigate`(**R/R**) |

**15 个 signal 里，8 个的等级在两个检查点之间会变** —— 这个比例远高于「个别抖动」，
说明 **P1 的多数结论不能直接当作「Laya 的能力」**。

**最终等级分布**：

| 检查点 | A | B | C | D | R |
|---|---|---|---|---|---|
| `typed-decisions` | 3 | 0 | 9 | 2 | 1 |
| `english` | 2 | 1 | 5 | 6 | 1 |

英文检查点整体**更严**（D 从 2 个涨到 6 个），但 A 级**不是同一批**。

### 16.5 P1 的头号结论**不成立**：score 型 vs noul 型

P1 §15.4 的原话是「同一个检查点里，score 分支的信号明显比 noul 分支可信」，
并按此把整份报告的建议建立在「level 可用、prob 不可用」之上。跨检查点一测：

| 检查点 | level 组 AUC 均值（7 个） | prob 组 AUC 均值（8 个） | 差 |
|---|---|---|---|
| `typed-decisions` | **0.750** | 0.623 | **+0.128** |
| `english` | 0.607 | **0.632** | **−0.025** |

**英文检查点上这个差距直接反号**。再看判别力 A 级的构成：

| 检查点 | level 组 A 级 | prob/noul 组 A 级 |
|---|---|---|
| `typed-decisions` | 4（`investigate`、`trust_shift`、`doubt_shift`、`fondness_shift`） | 2（`cooperation`、`trust`） |
| `english` | **1**（`trust_shift`） | **3**（`cooperation`、`disclose`、`trust`） |

⟹ **「score 型可用、noul 型不可用」是 `typed-decisions` 这个检查点的特征，不是 Laya 的普遍属性。**
它可以作为「`typed-decisions` 不适合本项目的自定义问句集」的一条证据，
但**不能**用来在 P2 里做「只信 score 分支、不信 noul 分支」的架构决定。

### 16.6 逐条回答（req.4 的 (a)~(h)）

**(a) `trust_shift` / `doubt_shift` / `fondness_shift` 在 english 上是否仍有高判别力？→ 只有 1 个成立。**

| signal | td 中位 | td 等级 | en 中位 | en 等级 | 判定 |
|---|---|---|---|---|---|
| `trust_shift` | 0.827 | **A** | 0.807 | **A** | ✅ 跨检查点都成立 |
| `fondness_shift` | 0.790 | **A** | 0.724 | C | ⚠ 掉出 A（en CI 下界 0.500，卡在门槛上） |
| `doubt_shift` | 0.847 | **A** | **0.407** | **D** | ❌ **不但掉级，而且方向反了**（en 均值差 −0.018） |

`doubt_shift` 这一条最值得警惕：P1 把它列为「可直接作行为输入」，
而 english 上它的 AUC 是 0.407 —— **低于 0.5，即「该怀疑时它的值反而更低」**。
**P1 的 A 级名单必须按跨检查点口径重写。**

**(b) 「7 个 level 里 4 个 A 级」但 A 级表只列 3 个 —— 第 4 个是谁？**
→ 第 4 个是 **`investigate`**（判别力 AUC 0.895/0.905，15 个里最高），
被 §15.7 的上下文反向拉到 **R**。**是口径差，不是统计错误、也不是表格漏行**：
「4 个」= 判别力口径（只数 7 个 level），「3 个」= 最终口径 `min(判别, 上下文)`。
更完整的口径对照（还牵出第 3 个数 **6**）已补进 **§15.8 的口径声明**，
同时修正了 §15.9 第 2 条「8 个 noul 没有一个 A 级」的过度概括
（判别力口径下其实有 `cooperation`、`trust` 两个）。
中文检查点上的三个数：判别力全量 **6** ／ 判别力仅 level **4** ／ 最终 **3**；
英文检查点上：**4** ／ **1** ／ **2**。

**(c) 8 个 noul/prob 信号在 english 上是否仍然全部没有 A 级？→ 不成立。**
english 的判别力 A 级里有 **3 个是 prob 型**（`cooperation` 0.772、`disclose` 0.889、`trust` 0.778）。
反过来，**td 上也有 2 个**（`cooperation`、`trust`）—— 所以 §15.9 第 2 条
「8 个 noul 型信号里没有一个 A 级」这句**在 P1 自身的数据上就已经不准确**，已修正。

**(d) noul 最佳阈值是否仍聚在 0.35~0.53？→ 只在 td 上成立。**

| 检查点 | 24 个阈值（8 信号 × 3 次）范围 | 落在 0.35~0.53 |
|---|---|---|
| `typed-decisions` | 0.356 ~ 0.528 | **24 / 24** |
| `english` | **0.235 ~ 0.494** | 12 / 24 |

english 上阈值明显**整体下移**（低至 0.235），说明 noul 分支的输出**基线本身就不同**
—— 更坐实了「noul 的绝对值不是一个可直接跨检查点搬运的量」。
（阈值只作统计输出，**没有**回写 `narra_config.json` / Policy，符合 req.6。）

**(e) `disclose` 是否仍是 AUC<0.5 / 稳定反向？→ 在 td 上是，在 english 上完全相反。**

| 检查点 | AUC | 等级 | 含义 |
|---|---|---|---|
| `typed-decisions` | 0.464 | D | 反向（该透露时更低），CI 跨 0.5 |
| `english` | **0.889** | **A** | 方向正确且判别力最强之一 |

**这是本轮最危险的一条**：同一个 signal、同一套用例、同一个 state 构造，
换个检查点就从「反向」变成「最强正向」。**任何按字面使用 `disclose` 的规则，
换检查点就会把行为推向相反方向。** 必须隔离。

**(f) `investigate` 的上下文效应是否仍下降？→ 是，而且 english 上更强。**

| 检查点 | 定向均Δ | 方向对率 | 越噪声底 | 等级 |
|---|---|---|---|---|
| `typed-decisions` | −0.151 | 1/10 = 10% | 80% | R |
| `english` | **−0.410** | **0/10 = 0%** | 100% | R |

**跨检查点稳定复现**，而且幅度**放大到 2.7 倍**（−0.410 / −0.151），
10 个配对**没有一个**方向是对 —— 这已经不像「个别用例写反」，
更像**信号语义整体与命名相反**（即 §15.7 的解释 2：`investigate` 实测更像
「信息缺口 / 困惑度」，有前文 ⇒ 缺口变小 ⇒ 值降低）。

★ 依 req.4(f) 的要求，**不立刻归罪模型**，两种解释分开查：

| 解释 | 支持它的证据 | 反对它的证据 |
|---|---|---|
| ① **用例期望写反了**（省略句歧义是对读者的，不是对 NPC 的） | td 上还有 1/10 方向对，像「多数写反、个别蒙对」 | 若是期望写反，两个检查点不该都 100% 反向且幅度差 2.7 倍；english 上 **0/10** 已经不像「期望写反」应有的形态 |
| ② **信号命名语义相反** | 两个检查点同向、稳定、超噪声底，且幅度随模型变强而变大 → 更像一个真实存在的、稳定的量 | 需要读 `narra_config.json` 里 `investigate` 的题面与判据才能坐实 |

**当前证据倾向解释 ②**，但要坐实得看题面（本轮只验证，未动题面）。
**无论哪种，结论一致：`investigate` 在跨检查点口径下是「稳定反向」，进入 P2 前必须隔离。**

**(g) 「上下文信号对前文几乎无反应」是否复现？→ 在 td 上复现，在 english 上**不**复现。**

| 检查点 | 中位\|定向Δ\| ≥ 噪声底 0.05 的 signal |
|---|---|
| `typed-decisions` | **2 个**（`confront` 0.076、`investigate` 0.151）—— 其中 confront 的配对样本只有 1（等级 N） |
| `english` | **5 个**（`withdraw` **0.280**、`investigate` 0.410、`trust` 0.099、`confront` 0.064、`danger` 0.051） |

english 上 `withdraw`（+0.280，等级 **B**）、`trust`（+0.099，**B**）、
`danger`（+0.051，**B**）都**真的随前文动了**，而它们在 td 上的定向Δ 分别是
−0.003 / +0.020 / −0.006（等级 C/C/D）。

⟹ **「上下文几乎无反应」是 `typed-decisions` 的特征**。
P1 把「上下文响应普遍测不出来」列为「目前最大的阻碍」——
现在看，这条阻碍**在这个检查点上是真的，但换 `english` 就松了一大截**。
反过来说也成立：**它同样不能作为「Laya 不能做状态投影」的普遍结论**。

**(h) 哪个检查点的跑次方差更小？→ 两个都是 0；这个问题问错了前提。**
两个检查点 3 次运行 **15/15 个 AUC 逐位相同**（见 §16.2）。
所以「谁更稳」没有区别 —— **差异来自检查点本身，不来自运行**。
真正会改变结果的不是「再跑一次」，而是**换一条输入**（缓存/用例文本/state 长度）。
P1 §15.6 那个「最大 0.073」的方差来源已被定位为测试台缺陷，
更正后的正确表述见 §16.2。

### 16.7 附带发现：翻译层有一个静默失效（会影响任何走这条路的实验）

`translate_to_en` 在本机**会间歇性返回空串**。实测（同一个请求，同一个 key）
成功时能拿到正常译文（`obs_crow_3` → *"Grey Crow has an old scar on his hand,
running from his left cheek all the way down to his chin."*），失败时是
**HTTP 200 + `content` 为空字符串**：

```python
out = (j["choices"][0]["message"].get("content") or "").strip()
if out:                      # ← 空串走 else，静默回落到 return text, "none"
    ...
return text, "none"          # ← 中文原文被当成「英文译文」交给模型
```

而 `_cached_translate` 只在 `en and en != text` 时才写缓存 ——
于是这**既不会报错、也不会留下缓存痕迹**，只在最终指标里表现为「这条用例模型答错了」。

**风险面**：任何「中文输入 → 翻成英文 → 喂本地英文模型」的链路都踩在这个坑上。
**已加的两道防线**：预热脚本 + 开跑前完备性断言 + 运行前后哈希核对（§16.2）。
**建议（不在本轮范围）**：在 `translate_to_en` 里把「空响应」与「网络异常」区分开并计数，
返回 `src="empty"`，让调用方**不能**把它当成正常译文用。

### 16.8 ★ 本题的正题：基于跨检查点结果，P2 应该围绕哪些 signal 设计？

> 前提提醒：本轮**只验证、不实现**。下面给的是**信号选择**的判断与依据，
> 不涉及 P2 架构（Task 8 的 Perception / Internal State Proposal / Behavior Tendency 分层）的实现。

判定基准统一为：**跨检查点稳定 + 等级 + 上下文是否响应**，
并刻意**不**采信单一检查点上的高 AUC（因为 8/15 的等级会变）。

**P2 可以依赖的（白名单）**

| 层 | signal | 依据 |
|---|---|---|
| **可以直接作行为输入的** | `trust_shift` | **唯一**在两个检查点上都是 A 级（0.827 / 0.807），CI 下界 0.639 / 0.591，且都是判别力与上下文综合后的最终 A。**这是本轮唯一一个「跨检查点可迁移」的高判别力量。** |
| **只能作合取项 / 上下文条件** | `hostility`(C/C)、`cooperation`(C/C)、`doubt`(C/C)、`respect_shift`(C/C) | 跨检查点**等级一致**，说明它们的行为不是检查点偶然。但 AUC 0.61~0.77、CI 下界常压到 0.5 附近，单独定行为会翻车，只能当条件项。 |
| **需上层强约束才能用** | `trust`(C→B) | 两个检查点**同向但不同级**，english 上明显更好（0.778 / CI 0.623）。属「有信息但不可单独依赖」。 |

**P2 必须淘汰或隔离的（黑名单）**

| signal | 跨检查点表现 | 处理 | 理由 |
|---|---|---|---|
| `investigate` | **R / R** | **隔离** | 稳定反向（−0.151 → −0.410，方向对率 10% → 0%）。**稳定反向比噪声更危险 —— 噪声不会骗人，反向信号会。** 查清 §15.7 的两种解释之前禁止写任何阈值；若采用，必须**反向**解释为「信息缺口」。 |
| `disclose` | **D → A** | **淘汰（首要）** | 方向在两个检查点之间**相反**（0.464 反向 → 0.889 最强正向之一）。按字面用会让行为随检查点反转，是**唯一一类会主动造成错误动作**的不一致。 |
| `doubt_shift` | **A → D** | **淘汰** | P1 的 A 级，english 上 0.407（低于随机）。**P1 的「A 级可直接输入」名单里，这一条必须撤下。** |
| `withdraw`、`confront`、`alert_shift`、`goal_shift` | C → D | **淘汰** | 「td 上勉强、english 上掉到噪声以下」。**不是稳定可用，是检查点依赖。** 其中 `alert_shift` 在 english 上恰好 0.500 = 完全无判别。 |
| `danger` | D / D | **淘汰** | 两个检查点都不可用（0.576 / 0.447）。虽稳定，但稳定地没用。 |
| `fondness_shift` | A → C | **降级**（从「直接输入」降到「合取项」） | 判别力还在（0.724），但 CI 下界恰好 0.500，卡在 A 门槛上。跨检查点不成立。 |

**一句话结论**：

> **P1 的「4 个 level 型 A 级可直接作行为输入」，在跨检查点口径下只剩 `trust_shift` 一个。**
> 围绕它建 P2 的行为倾向层是站得住的；
> 把 `doubt_shift`、`disclose`、`investigate` 带进 P2 是**危险**的 ——
> 前两个会让行为随检查点反转，第三个是稳定反向。
> 同时 `withdraw` / `trust` / `danger` 暴露出一条 P1 没有的信息：
> **上下文响应能力本身是检查点相关的**，english 明显更强，
> 所以在 P2 里「用不用得了上下文」必须**先选定检查点再谈**，不能当作模型固有属性。

### 16.9 本轮**没**做、且不能声称做了的

- **没有**开始 P2（含 Task 8 的信号分层）——按 req 只验证。本节 §16.8 只是**选择建议**。
- **没有**改 signal 分层、问题定义、用例集、评分规则、噪声底、bootstrap 参数。
- **没有**重调任何阈值；表里的「最佳阈值」是**统计输出**，未回写
  `narra_config.json` / Policy（req.6）。
- **没有**解决 §15.7 `investigate` 的两种解释（本轮只给出「倾向解释 ②」的证据）；
  因此 `investigate` 上的阈值禁令**继续有效**。
- **没有**动 Narraverse 主项目、数据协议，也**没有**新增任何正式 signal（req.7）。
- **没跑** `multilingual` 检查点 —— 本轮只对照 td / english 两个（req.2）。若
  `trust_shift` 是 P2 的唯一支柱，**再加一个检查点来确认它**是值得的下一步。
- §15.6 的更正**只对 td/english 在本机、本用例集上成立**；换设备/换用例集需重测。

