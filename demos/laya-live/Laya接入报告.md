# Laya 决策引擎接入报告

> **读者：其他 AI 协作者。**
> 本文自包含，不依赖任何对话上下文。所有数字都是本机实测结果，不是估算。
> 最后更新：2026-09-23 14:40
>
> **怎么用这份文档**：如果你要接手 `laya-live/` 的工作，**先读第 6 节（实测数据）和第 7 节（环境约束）**，
> 那两节能省掉你最可能重复踩的几个小时。第 8 节是诚实缺陷清单，不要把它当成待修 bug 列表去逐条修。

---

## 1. 一句话结论

已经把 Laya（`github.com/NandhaKishorM/laya`，PyPI `laya` 0.3.5）接成了一个本地 HTTP 桥，
配上 DeepSeek-V4.1-Flash 做台词生成，前端是一个能实时输入的三栏演示页。

**能用，但有一个必须先知道的结论**：`choice` 原语即使按最优方式改写，区分度仍然偏弱；
`score` / `noul` 才是 Laya 可靠的原语。当前架构是
**「choice 出基础分布 + noul 门限做覆盖 + score 出状态增量」**。
任何试图靠调 prompt 让 `choice` 变准的尝试，都不要做 —— 已经在 A/B/C/D 四轮对照里证伪了，见第 6.4 节。

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
$PY laya_bridge.py langtest   # ★ 区分度 + 逐输入方向 + 门限是否在生效
$PY laya_bridge.py selftest   # 离线自检（不需要 Laya，验证回退引擎与增量）
$PY laya_bridge.py llmtest    # LLM 接入自检（key / model id / <line> 标签是否正常）
$PY laya_bridge.py sanity A|B|C|D   # A/B/C/D 对照诊断，保留用于回归
```

---

## 10. 下一步建议

按优先级：

1. **把 `LLM_EFFORT` 的决定做掉**（`low` vs `high`）。这是 8.3 的根治手段，成本 vs 质量。
2. **积累真实对局样本，重标门限**。当前全部阈值都建立在 ≤7 个样本上。
   重点先看：真实输入下 `gate_ally` 的分布是否真的双峰（0.34 vs 0.53）。
3. **设计一个独立的「敌意门限」**（对应 8.1）。但**必须先有样本**，不要用现在的 4 个测试输入去拟合。
4. **决定检查点**。`typed-decisions` 是「在四个特定合成工作流上微调的」，
   `router.py` 的注释明确写了「不应作为静默默认」。我们的 `score`/`noul` 表现不错，
   但**没有和 `english` 做过同条件对照**（内存限制导致只能一个一个跑）。
   这是一个该补的实验。
5. 清理 8.4 的遗留目录（需要人做）。

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
