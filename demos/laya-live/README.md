# Laya 实时对话 Demo

用 **Laya 决策引擎**（非自回归 System-1）产出 **决策信号**，由 **Policy Resolver** 裁定 NPC 行为，
再由 **LLM** 把决定写成台词。

```text
Actor / World State
        ↓  State Projector
   Laya Decision Signals      ← 单次前向、无采样、有概率值
        ↓
   Policy Resolver            ← 规则可插拔、裁决可审计、拿不准就交回上游
        ↓
   Director / Story Agent
        ↓
      Narrative
```

> **这不是「又一个酒馆聊天」。** 酒馆里 NPC 行为完全由 LLM 即兴生成，不可复现、不可校验；
> 这里的决策来自一个**冻结的判别式引擎**：单次前向、无采样、同设备同输入必得同输出，
> 且每个维度都有概率值可查。
>
> **但它也还不是「NPC 大脑」。** 48 条方向回归实测：9 个信号的方向准确率 **49.5% ≈ 抛硬币**。
> 本 Demo 的价值是**把 Laya 真正能负责什么、不能负责什么测清楚**，
> 不是假装它已经能演 NPC。完整证据见 `Laya接入报告.md` §12。

---

## 它解决什么问题

LLM 直接演 NPC 有三个绕不过的毛病：

| 问题 | LLM 即兴演 | 本方案 |
|---|---|---|
| 可复现性 | 同一句话两次结果不同 | 同**设备**同输入同输出（无采样） |
| 数值一致 | 「好感 +3」纯属编造 | 由 `score` 原始输出映射，可追溯 |
| 行为边界 | 容易被玩家用话术带跑 | Policy Resolver 可硬性改写行为 |
| 幻觉 | 会凭空发明设定 | 决策引擎不生成文本，无从幻觉 |
| **可审计** | 「为什么这样演」说不清 | 每个信号、每条规则命中都有原始值可查 |

代价是：**决策质量没法和 LLM 比**。这是刻意的取舍 —— 要的是一个**能被校验的骨架**，
而不是一段好看的文字。实测边界见文末「已知局限」。

---

## 三个决策原语里只有一个半能用

Laya 提供 `choice` / `score` / `noul` 三种问题类型。实测：

- **`score`（0–4 打分）和 `noul`（是/否）是校准可信的** —— 问题写对了，方向就能对上。
- **`choice` 本质偏弱** —— 哪怕把问题重写到最优，置信度仍卡在 **0.06–0.14**。
  置信度用的是归一化 Shannon 熵，这个数值等于模型在说「我不知道」。

所以**不能把 `choice` 的 argmax 当作行为决策**。第二轮把这个判断执行到底：

```text
choice argmax   → 只当 fallback baseline（不是权威）
noul 门限       → ★ 已停用（实测在 live state 下恒真，见下）
score           → 只出状态数值增量建议
decision signals → Policy Resolver 的输入
Policy Resolver → ★ 行为权威
```

### `decision_signals`：9 个信号

> ⚠️ **本节口径已被 §16.5 / §17 收窄，先读这段再读下面。**
> 上面「score 可用 / noul 不可用」的说法**只在 `typed-decisions` 上成立**；
> 换到 `english`，level 组 AUC 均值 0.750→**0.607**、prob 组 0.623→**0.632**，**两组的差反号**。
> 所以「哪种 kind 可用」不是 Laya 的属性，**是检查点的属性**。
> 现在真正的判据不再是 kind，而是每个检查点一份的**能力档案**（`laya_bridge.py capability`）。
>
> ⚠️ **还有一条对 `*_shift` 的额外限制（§18 / P2.5）：**
> `*_shift`（`trust_shift` 等 score 型）问的是「**这句话**带来多少变化」，**是变化量不是状态量**。
> 实测：`trust_shift` 随 `relationship.trust` 变化（两检查点 100% 方向正确），
> 但**不随 `decision_history` 的内容反号**（两检查点 0%）。
> 所以拿 `*_shift` 去验收「随历史变化」是**口径用错**，不是模型缺陷。
> 需要状态量时应当看 `trust` / `doubt` 这类 noul 信号。详见报告 §18.5。

`narra_config.json` 的 `signals.order` 定义 **9 个面板信号**，两类量纲**不要混用**：

| kind | 来源 | 量纲 | 能否当阈值 |
|---|---|---|---|
| `prob` | `noul`，校准过的 P(true) | 0 ~ 1 | 可以 |
| `level` | `score`，期望强度 | 0 ~ 4 | **不可以**（不是概率） |

`hostility` / `cooperation` / `withdraw` / `confront` / `disclose` / `trust` / `doubt` / `danger`
是 `prob`；`investigate` 是 `level`。

★ 面板之外还有 **6 个 `*_shift` 信号**（`trust_shift` / `respect_shift` / `doubt_shift` /
`fondness_shift` / `alert_shift` / `goal_shift`，都是 `level` 0~4）。
它们**刻意不上面板**（会把重点淹掉，见 `SHIFT_IDS` 的注释），但它们是**唯一会写 Actor State 的一层**。
所以「可定级的 signal」一共是 **9 + 6 = 15 个**，
统计时若只看面板那 9 个，会得出「可写状态的信号：无」这种错误结论
（`laya-live-demo.html` 的 ⓿ 栏就是为此改成读档案全量的）。
每个 signal 的 role / status 见 `narra_config.json` 的 `signals.roles` 与能力档案。

### Policy Resolver

求值顺序（`laya_bridge.policy_resolve`，**改过，别改回去**）：

1. `policy.enabled = false` → 一律回落 choice baseline
2. 逐条规则 `{when: 阈值合取}` → 命中即 `source = policy`
3. 无规则命中且判为歧义 → `source = ambiguous`，`fallback = story_agent`（**不硬选一个行为**）
4. 其余 → `source = choice_baseline`

★ **规则必须先于歧义判定。** 反过来的话规则永远触发不了 ——
早期版本用「top1 与 top2 差值过小」判歧义，把 8 个**正交**的 prob 信号当成互相竞争的候选，
导致「敌意 0.88 + 退出 0.71」被判 ambiguous。这个判据已废弃。

---

## ★ 两个必须知道的坑

### 1. 阈值不可从夹具迁移到线上

`narra_config.json` 的 `gates` 段是第一轮的遗留机制，**目前已全部停用**。原因是实测的：

```text
离线夹具：非结盟 0.23~0.34  |0.45|  结盟 0.53~0.64    ← 阈值落在空隙里，看着很稳
线上 live：          0.415 ~ 0.572                     ← 阈值被埋在分布内部，恒真
                         ▲ 0.45
```

恒真的门限**把所有输入都改写成了同一个行为**，包括「刀抵在你喉咙上」。
这不是门限，是常量 —— 而且**比没有门限更糟**，因为它掩盖了 baseline 的方差。

规则：**阈值只能在目标 state 文档上标定**，且每个阈值都要过一遍「恒真/恒假自检」。
停用的门限用 `threshold = 1.01`（概率上界之外）表达，**不删键** —— 删了会让人以为没人标定过。

### 2. `/decide` 认 `player_input`，不是 `message`

```jsonc
// ❌ 这三行的 message 会被静默忽略，state.message 变成空串
{"message": "刀抵在你喉咙上"}
// ✅ 这两种写法都行（message 是别名）
{"player_input": "刀抵在你喉咙上"}
```

桥会对未知键**静默忽略**。旧版踩过一次：两个语义完全不同的输入返回了 **md5 相同的 state**，
差点被写成「引擎对敌意不敏感」的结论。

现在有三道防线：`input_key` 字段、输入为空时的 `input_warning`、以及前端面板顶部的告警横幅。

---

## 快速开始

```bash
# 1. 配置（.env.example 由 _gen_env_example.py 生成，不要手改）
cp .env.example .env
#    编辑 .env，填入 DEEPSEEK_API_KEY

# 2. 装依赖（Laya + torch CPU）
pip install "laya==0.3.5" torch transformers

# 3. 起桥
python laya_bridge.py serve          # 默认 127.0.0.1:8130

# 4. 开页面
#    http://127.0.0.1:8130/demo
```

Windows 下可直接双击 `启动Laya桥.bat`（GBK 编码，勿转 UTF-8）。

> **内存要求**：每个 Laya 检查点约 840 MB。同时加载两个会 OOM 且**无任何报错堆栈**（直接段错误）。
> 桥启动前会自行检查可用物理内存。

### GPU（强烈建议）

CPU 上完整一轮 22 题 NPC tick 要 **22 秒**；GPU 上只要 **399 ms（55×）**。

```bash
# 建独立 CUDA 环境（torch 必须从 download.pytorch.org 取 cu126 wheel，PyPI 的 torch 是 CPU-only）
bash _build_cuda_env.sh

# 起 GPU 版
LAYA_DEVICE=cuda ./.venv-cuda/Scripts/python.exe laya_bridge.py serve
```

实测（RTX 4060 Laptop，8 GB）：NPC tick 399 ms ／ World tick 42 ms ／ 峰值 VRAM 2.93 GB。
★ 冷加载 GPU **不比 CPU 快**（49.7 s vs 45.3 s）—— 瓶颈不在算力，而在 `build_model()` 的随机权重初始化
（占 95%；早先写成「磁盘 + tokenizer」是错的，2026-09-23 实测更正）。开快加载后干净进程 **12.1 s**，见「上游」一节。

### 检查点

| 检查点 | 结论 |
|---|---|
| `typed-decisions` | **默认使用。** 方向准确率 49.5%，state 余量 767 token，`qcheck` 全绿 |
| `english` | 准确率打平（51.5% vs 49.5%，差 2 条断言），但 state 余量只有 **319 token**，4 种 state 形态里 3 种溢出会静默截断 |
| `multilingual` | 未测 |

用 `LAYA_MODEL=english` 可切换。★ **不要同时加载两个检查点。**

---

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/demo` | 演示页面 |
| GET | `/health` | 引擎、模型、设备、state 预算、policy 状态、ticks |
| GET | `/config` | 当前决策模型（脱敏） |
| POST | `/decide` | 只跑 Laya：决策信号 + Policy 裁决 + 状态建议。**只 propose，不写历史** |
| POST | `/commit` | 确认本轮被上游采纳 → 才写入决策历史（`behavior=null` 的轮次会被拒） |
| POST | `/narrate` | 跑 Laya 再让 LLM 出台词；省略 `behavior` 会自动先跑 `decide` |
| POST | `/world` | 世界事件推进（独立 tick） |
| GET | `/history` | 决策历史（按 `session_id` / `actor_id` 分桶） |
| POST | `/reset` | 清历史。给 `session_id` 只清那一桶；都不给才是全清 |

### 决策历史：三道门 + 分桶

历史**不再**是一个进程级全局列表（那会让两个 NPC / 两个冒险 / 两个浏览器会话共用同一条，
且完全静默）。现在按 `(session_id, actor_id)` 分桶，且必须过三道门：

```
proposed  →  /decide 只登记候选（_PENDING），不写历史
accepted  →  上游（Story / Director）确认可用
committed →  POST /commit 才真正写进桶   ← 只有这一步会写
```

**`behavior=null` 的轮次永远无法提交** —— 没有行为就没有可确认的事实。
调用方**必须传** `session_id` + `actor_id`，否则历史会退到 `default` 桶
（响应里的 `turn.history_isolation=false` 会明确报出来，不静默）。

```bash
curl -s http://127.0.0.1:8130/narrate \
  -H 'Content-Type: application/json' \
  -d '{"player_input":"我是圣殿派来的，带了一封火漆印的信。","session_id":"s1","actor_id":"莉亚"}'
```

关键返回字段：

| 字段 | 含义 |
|---|---|
| `decision_signals` | 9 个信号（`signal` / `label` / `kind` / `value` / `range`） |
| `policy` | `behavior` / `source` / `reasons` / `choice_baseline` / `confidence_level` / `fallback` |
| `decision.behavior` | 最终行为 + `choice_argmax` + `gated_baseline` + 可选 `gated_by` |
| `decision.awaiting_upstream` | **`true` = 本轮判为歧义，桥不给行为**，交上游裁决 |
| `decision.behavior_null_reason` | 为什么没给行为（歧义是正常裁决，不是故障） |
| `decision.choice_baseline.adopted` | choice argmax 是否被采纳（歧义轮次恒为 `false`） |
| `turn.turn_id` / `turn.history_isolation` | 提交要用的编号 / 历史是否真隔离 |
| `history_gate` | 本轮历史处于哪道门（`proposed`） |
| `state_budget` | state token 数 / 余量 / **是否溢出** |
| `proposed_deltas` | 状态增量**建议**（不是 Actor State 真值） |
| `tick` | `npc` 或 `world` |
| `input_key` / `input_warning` | 本轮吃到的输入键 / 输入为空告警 |

★ **`behavior=null` 的含义**：Laya 判出「没有哪个信号有把握」时，桥**不代选行为**，
`/narrate` 也**不生成台词**（返回 `awaiting_upstream`）。前端显示
「Laya 不确定 · 交由上游模型裁决」。旧实现在这里偷偷用 choice argmax 兜底，
于是「其实没人拍板」在界面上和「正常决策」长得一样 —— 那是**假交接**。

★ `proposed_deltas` 是 proposal。正式链路必须是
**Laya Proposal → 后端 Validate → State Transition → Commit**；
浏览器端的 `applyDeltas()` 只是 Demo 手段，**不是状态权威**。

---

## 命令行自检

```bash
PY=.venv/Scripts/python.exe          # 一律用项目自带 venv，不要裸 python

$PY laya_bridge.py qcheck       # ★ 改配置后必跑：token 预算 / 温度桶 / state 溢出
$PY laya_bridge.py signalmetrics # ★★ 主实验：逐 signal 判别力 + 上下文响应 + A/B/C/D/R 分级
$PY laya_bridge.py capability    # ★★ P2：从 tests/runs/ 推导每个检查点的能力档案（不跑模型，秒级）
$PY laya_bridge.py capability --check  # 核对现有档案是否仍与磁盘一致
$PY laya_bridge.py signaltest   # 旧口径回归（48 用例 / 99 断言，legacy 对照用）
$PY laya_bridge.py ckptcompare  # 检查点同条件对照（两个进程各跑一次 signaltest）
$PY laya_bridge.py personatest  # 人格 A/B 对照（LAYA_PERSONA_STYLE=polarity 换写法）
$PY laya_bridge.py bench        # 性能基准（CPU / GPU 各跑一次）
$PY laya_bridge.py selftest     # 不起模型，验证 fallback 引擎
$PY laya_bridge.py llmtest      # 验证密钥与模型 id
$PY laya_bridge.py langtest     # 旧版 4 句极端输入区分度测试

$PY tests/p0_acceptance.py      # Phase3 P0 验收（歧义交接 + 历史分桶 + 提交门控，需先起桥）
$PY tests/p2_acceptance.py --json   # ★ Phase3 P2 验收（能力档案 / 角色分层 / Proposal 过滤，54 条断言）
$PY tests/p25_acceptance.py --json  # ★ Phase3 P2.5 验收（trust_shift 上下文敏感性，14 PASS / 2 FAIL）
```

诊断子集（结果单独存放，不影响正式对照）：
`LAYA_QSET=signals`、`LAYA_CASES=id1,id2`、`LAYA_SETS=observable,contextual`（排除隐藏真相组）。

### `signalmetrics`：为什么主结论必须是逐 signal

「方向准确率 53.1%」这个数**不能用来判断能不能用** —— 它把 15 个维度揉成一个数。
真正有行动价值的是逐 signal 的表（`tests/signal_metrics.json`）。当前结论：

| kind | AUC 均值 | 说明 |
|---|---|---|
| `level`（score，0~4） | **0.755** | 7 个里 4 个达 A 级，可作行为输入 |
| `prob`（noul，0~1） | **0.621** | 8 个里 0 个 A 级，且全部挤在 0.5 附近、最佳阈值落在 0.35~0.53 |

**noul 分支的输出缺少动态范围**（与上游 issue #156 一致）——
所以它**不能**当概率用。这正是任务清单里「不把 noul 数值称为真实概率」的本机数据依据。

分级：`N` 样本不足 ｜ `A` CI 下界>0.5 且 AUC≥0.70 ｜ `B` CI 下界>0.5 且 AUC≥0.60 ｜
`C` AUC≥0.55 但区间不稳（只能当合取项）｜ `R` **稳定反向**（比噪声更危险）｜ `D` AUC<0.55。
最终等级 = `min(判别, 上下文)`，规则见 `grade_signal()` / `grade_context()` 的 docstring。

### ★ 三个口径：说「A 级有几个」时必须先声明用哪个

同一份数据能数出三个不同的 A 级个数，**混着读会以为表格出错**：

| 口径 | 怎么数 | 本机 typed-decisions |
|---|---|---|
| ① 判别力（只看 AUC+CI） | 全部 15 个 signal | **6** |
| ② 判别力 · 仅 level 组 | 只数 7 个 level 型 | **4** |
| ③ 最终 `min(判别, 上下文)` | 判别力与上下文取差 | **3** |

差异来自 `investigate`：判别力 AUC 0.905（15 个里最高）→ 上下文反向 → 最终 **R**。
另有两个 prob 信号（`cooperation`、`trust`）判别力为 A、最终降为 C（对前文无反应）。
详见 `Laya接入报告.md` §15.8 的口径声明。

### 有效性过滤：坏输入不参与能力对比

`signalmetrics` 跑模型**之前**先做一次静态体检，把「输入根本没被有效呈现」的用例
从所有主结论里**剔除**并单独列出（`validity.invalid`）：

1. **state 溢出** —— `build_sequence` 溢出时做 `st[:room]`（保留左、丢右），
   而 compact state 的尾部正是 `message` 和 `decision_history`。实测 english
   `room=319`、本套用例 token 222~256，**当前 0 溢出**；但换检查点/加字段就会踩到。
2. **翻译缓存缺失** —— `translate_to_en` 在本机**稳定返回空串**（HTTP 200 但 content 为空），
   `_cached_translate` 于是**静默回落成中文原文**，`message` 字段变成中文，
   而两个检查点都是英文校准的 ModernBERT。实测 `obs_crow_3` 命中这一类。

只报「剔除了几条」不算达标 —— 必须能说出是哪几条、为什么，所以 invalid 会逐条打印。

### 每次运行单独留档（`tests/runs/`）

`signalmetrics` 每次运行写一份 `tests/runs/<检查点>__<run_id>.json`（含逐用例 `budgets`），
`tests/signal_metrics.json` 只保留该检查点最新一次。
原因：跑次抖动实测中位 0.013 / 最大 0.073，**只留最后一次等于把抖动当成结果**，
而且没法算 run-to-run 区间。`LAYA_RUN_ID=run2` 可指定 run id。

**三个必须知道的限制**：

1. ~~bootstrap CI 只覆盖单次运行内的重采样方差，实测三次同条件运行 AUC 最大极差 0.073。~~
   **已更正（见 §16.2）**：条件真正冻结后（缓存完备 + 哈希核对），
   两检查点各跑 3 次 **15/15 个 AUC 逐位相同，跑次区间 = 0.000** —— 模型是确定性的。
   原先那个「0.073」是**测试台缺陷**（翻译缓存被运行中途改写 → 输入变了）。
   → 教训换成：**输入管线可变，必须冻结并留下可校验证据**；
   且**跑次区间 = 0 ≠ 结论稳**（一条坏用例就能把 `goal_shift` 打成 `N`）。
2. 8 个 noul 信号里没有一个的上下文效应**在 `typed-decisions` 上**超过噪声底；
   唯一测到的 `investigate` 是**反向**的，且跨检查点稳定（td −0.151 → english −0.410，
   方向对率 10% → **0%**）。它只能反向使用，且须先查清是「用例期望写反了」
   还是「信号语义相反」。★ 但在 `english` 上 `withdraw`/`trust`/`danger` **真的随前文动了**
   （等级 B）—— 「上下文无反应」是检查点特征，不是 Laya 的固有属性。
3. ★ **跨检查点结论（§16）**：15 个 signal 里 **8 个的等级会随检查点改变**。
   P1 的头号结论「score 型可用 / noul 型不可用」在 english 上**反号**
   （level 0.750→0.607，prob 0.623→0.632）。
   **P1 的「4 个 level A 级可直接输入」在跨检查点口径下只剩 `trust_shift` 一个**；
   `disclose`（D→A）与 `doubt_shift`（A→D）**方向相反，必须淘汰**。
   P2 的信号选择以报告 §16.8 为准。
4. ★ **P2 起「哪些 signal 能用」不再写在报告里，而是每个检查点一份能力档案**（见下节）。
   档案对不上时**拒绝产出状态增量** —— 所以「某个属性忽然不动了」通常是正确行为，不是 bug。

### `capability`：能力档案（P2，`tests/capability_profiles.json`）

P1.5 的结论是诊断性的（写在表里）；P2 把它变成**结构性**的：机器可读、跟着检查点走、可核对。

```bash
$PY laya_bridge.py capability                     # 为 tests/runs/ 里出现的检查点各生成一份
$PY laya_bridge.py capability typed-decisions      # 只做指定的
$PY laya_bridge.py capability --check              # 只核对现档案与磁盘是否一致（不重新生成）
```

**等级不在这里定**：全部读 `tests/runs/*.json` 里 `signalmetrics` 已经算好的 `grade`。
能力档案只做「跨跑次取代表值 → 跨检查点分类 → 按 grade 推导 status」。
想改判据只能改 `grade_signal()` —— 改在档案层等于偷偷改评分规则。

**status 四值**（`_derive_status()`，规则写死在代码里）：

| status | 触发条件 | 含义 |
|---|---|---|
| `active` | `grade=A` | 该 role 的**主输入**；`role=state_shift` 时才能产生状态增量 |
| `auxiliary` | `grade=B` / `grade=C` | 只能当合取/修正项，**不能单独驱动重大状态变化** |
| `disabled` | `grade=D` / `grade=N` / 跑次等级不一致 | 不接入正式链路 |
| `semantic_review` | `grade=R`（稳定反向） | 明显稳定响应但方向/语义有问题；**禁止静默取反**，先查清 |

两张**声明式覆盖**（`narra_config.json` → `capability_policy.override`，档案里标
`status_source=policy_override` 且附理由，不伪装成推导结果）：
`investigate`→`semantic_review`、`disclose`→`disabled`。

**五类哈希，四硬一软**：`dataset` / `checkpoint` / `config` / `translation_cache` 不符 → **硬阻断**；
`code` 不符 → 只提示（`code_changed`）。硬阻断只留给**输入侧**：输入变了，
同一份档案描述的就是另一批条件，没有辩解空间。

★ `translation_cache` 记的是**实验用例那批文本的译文**哈希（`case_subset`），
不是整个缓存文件 —— 否则「玩过几轮 demo」会被误判成「实验条件变了」（已实测修掉）。

**当前 typed-decisions（生产候选）**：`active 3 · auxiliary 9 · disabled 2 · semantic_review 1`，
可写 Actor State 的是 `trust_shift` / `doubt_shift` / `fondness_shift`。
english 上只剩 `trust_shift` 一个 —— 这就是「不能透明互换」的量化证据（报告 §17.7）。

`decide()` 的输出自 P2 起多出 `state_proposal` / `behavior_tendency` / `situation_assessment` /
`checkpoint_profile` / `capability_summary` / `signal_table`；
`proposed_deltas` **语义已变**（现在是过滤后的结果），未过滤的全量在 `raw_deltas_all_signals`（仅供审计）。


`qcheck` 值得单独说：Laya 的 `build_sequence` 对选项有 48 token 上限，且所有选项必须塞进
`head_max_len`，塞不下会**静默压缩**；state 超预算会被 `st[:room]` **静默截断**
（保留左边、丢掉右边，最先丢的是 `decision_history` 和 `message`）。问题写太长、
state 塞太满，都会在无声无息中失效。

---

## 文件

| 文件 | 说明 |
|---|---|
| `laya_bridge.py` | HTTP 桥 + 决策编排 + CLI 自检（纯标准库） |
| `narra_config.json` | **决策模型本体**：行为表、6 个 score 维度、9 个信号、`gates`（已停用）、`policy`、`signals`（含 **`roles`：15 个 signal 的职责分层**）、**`capability_policy`**（检查点身份 + 声明式 status 覆盖） |
| `laya-live-demo.html` | 单文件前端，三区结构：① Decision Signals ② Policy Resolver ③ Story Agent，外加 **⓿ Checkpoint Capability Profile**（P2） |
| `Laya接入报告.md` | 面向其他 AI 的交接报告。**§12 第二轮结论、§14 Phase3-P0、§15 Phase3-P1 逐 signal 分级、§16 English 跨检查点复现（P2 信号选择依据）、§17 ★ Phase3-P2 能力档案与 Proposal + Phase3 最终设计原则、§18 ★ Phase3-P2.5 trust_shift 上下文敏感性（state 轴可用 / history 轴不可用）** |
| `tests/cases/` | **三组标准用例集**：`observable` 70 / `contextual` 48 / `hidden_truth` 20（`omniscient`，永不混进主准确率）；另有 **`trust_context.json`（P2.5 专项，6 条 pair，只测 `trust_shift`）** |
| `tests/` | 其它实验证据（`regression_cases.json` 旧口径 48 用例 / `signal_metrics.json` 逐 signal 结果 / `thresholds.json` / `personality_personas.json` / `p0_acceptance.py` / **`p2_acceptance.py`** / **`p25_acceptance.py`** / **`capability_profiles.json`**）。**这些是证据，要提交** |
| `tests/runs/` | ★ **每次运行一份原始结果**（`<检查点>__<run_id>.json`，含逐用例 `budgets`）。跨检查点对照靠它，不能只留最新一次 |
| `tests/capability_profiles.json` | ★ **P2：每个检查点的能力档案**（机器可读）。由 `capability` 从 `tests/runs/` 推导，**不要手改**；运行时按五类哈希核对后才敢用 |
| `tests/replication/` | 复现实验工具：`prewarm_cache.py`（预热翻译缓存，**自动扫 `tests/cases/*.json`**）/ `budget_check.py`（静态预算）/ `ckpt_analysis.py`（跨检查点分类，**classify() 的唯一权威实现**）/ **`trust_context_probe.py`（P2.5 主实验）/ `p25_control.py`（自我证伪：同态重复 + 反序配对）/ `p25_attribution.py`（变化量 vs 状态量归因）** |
| `启动Laya桥.bat` | Windows 一键启动（**GBK 编码**，由 `_gen_bat.py` 生成，勿手改） |
| `.env.example` | 配置样例，**由 `_gen_env_example.py` 生成，手改会被下次生成覆盖** |
| `.gitignore` / `.gitattributes` | 排除 `.env`、虚拟环境、检查点权重；`.bat` 标为 binary 防止换行改写 |

### 开发脚本（`_` 前缀 = 本地工具）

⚠️ 这些脚本**必须和 `laya_bridge.py` 保持同一层目录**，不要归到子目录里：
`_gen_bat.py` 把 `.bat` 写到自身所在目录，`_fetch_laya.py` 把检查点下到自身同级的 `_models/`
—— 而那正是桥查找检查点的位置。挪位置会**静默失效**（不报错，只是找不到东西）。

| 文件 | 说明 |
|---|---|
| `_fetch_laya.py` | 带断点续传的检查点下载器，写入同级 `_models/` |
| `_gen_bat.py` | 生成 `启动Laya桥.bat`（改启动文案请改这里，别手改 `.bat`） |
| `_gen_env_example.py` | 生成 `.env.example`（`.env` 的**透传 + 脱敏**） |
| `_build_cuda_env.sh` / `_fetch_cuda_torch.sh` | 建独立 CUDA 环境（`_models` 之外的第二大产物，约 5 GB） |
| `_shot.mjs` | 零依赖 CDP 截图（Node 21+ 自带 `WebSocket`） |
| `_probe_demo.mjs` / `_probe_llm.mjs` | 抓取演示页文本 / 直连 LLM 探活 |

---

## 实测效果

### 第二轮（决策信号路线，48 用例 / 99 条方向断言）

| 指标 | typed-decisions | english |
|---|---|---|
| 方向准确率 | **49.5%** | 51.5% |
| 有效区分信号 | 9/9 有跨度，但只有 **3/15** 个维度越过噪声 | 同 |
| 人格影响 | **0/9 信号可观察**（极差 ≤0.031） | — |

**结论：决策信号路线没有解决问题。** 9 个信号里只有 `doubt_shift`(+0.108) / `hostility`(+0.046) /
`confront`(+0.037) 越过噪声地板（≈0.055）；语义上最该区分敌友的 `cooperation`(−0.010)
与 `trust`(−0.028) 均值差是**负的**。

### 性能

| 题数 | CPU 均次 ms | GPU 均次 ms | 加速 |
|---|---|---|---|
| 10 | 10 843 | 170 | 64× |
| **完整 NPC tick（22）** | **22 132** | **399** | **55×** |
| World Tick（3） | 2617 | 42 | 62× |

### 第一轮（行为 choice 路线，4 句极端输入）

| 指标 | 优化前 | 优化后 |
|---|---|---|
| 行为区分度 | 4 输入 → 1 种 | 4 输入 → 2 种 |
| 玩家意图判定 | — | 4/4 正确 |
| 信任值跨度 | 0.10 | 1.02 |
| 单轮延迟 | 19 s | 14–15 s（CPU）／ 数百 ms（GPU） |

★ **第一轮的「4 → 2 种」是夹具上的数字**，live 下靠遗留门限维持，而该门限恒真（见上）。
不要在线上引用这一行。

---

## 已知局限

这一节是认真的，不是免责声明。**当前状态适合做技术验证，不适合直接上生产。**

- ★ **决策信号方向准确率 49.5% = 抛硬币。** 这是最重要的一个数字。
  它意味着「有读数」不等于「有信息」：错被穿上了数值外衣，比 LLM 的显式错误更难发现。
- ★ **人格对决策无可观察影响**（4 人格 × 9 信号，极差 ≤0.031，低于噪声地板）。
  `personality` 确实进了 state（机械改造成功），但 Laya 不因此改变判断。
- ★ **阈值不可迁移**（见上「两个坑」）。`gate_ally` 与 `hostility ≥ 0.56` 两个阈值都是反例。
- **`choice` 对敌意输入判断偏弱**：威胁场景下 `leave`(0.037) / `distance`(0.057) 排倒数，
  语义上恰恰应该最高。§8.1 的缺陷**没有被修复，只是被重新表述了**。
- **`decision_history` 是进程级滚动窗口**，不是按 actor 分桶 ——
  连续两次独立 `/decide` 并非彼此独立。单角色 Demo 够用，**多角色/并发必须改**。
- **`decision_history` 的内容由决策结果反推**（英文 criteria），不携带输入信息；
  输入为空时历史会饱和成常量。语言问题（§8）已解决，**信息量问题没有**。
- **设备是数值噪声源**：同检查点同用例，CPU 与 GPU 的 720 个数值里 710 个不同（最大差 0.033）。
  「同输入同输出」只在**同设备**内成立；跨检查点比较必须同设备。
- **`typed-decisions` 与 `english` 的比较**已完成（见 `tests/ckpt_compare.json`），
  结论是**平局**，不是一个更好的选择。

### 关于 `effort` 的坑

`LLM_EFFORT=low` 时，DeepSeek-V4.1-Flash 有时**不产生独立推理通道**
（`usage.reasoning_tokens == 0`），于是它把「复述要求 + 写计划 + 真正台词」一股脑塞进
`message.content`，台词位置就会混进计划文本。

桥里做了两道防线：要求 `<line></line>` 结构化输出；取不到标签且命中 ≥2 个计划特征词就判定污染
→ 降温度重试一次 → 仍失败则退回台词池，并把原始内容留在 `raw_content_first` 里备查。
**根治办法是把 `LLM_EFFORT` 调成 `high`**，high 会走独立推理通道。

---

## 上游

- Laya 决策引擎：<https://github.com/NandhaKishorM/laya>（PyPI `laya` 0.3.5）
- ⚠️ **PyPI 停在 0.3.5，上游已经到 v0.3.7**（2026-09-23 发布，PR #195 跳过检查点加载时的无用初始化，
  上游自称 CPU 冷加载 22 s → 2 s 且答案位级一致）。**PyPI 上装不到**，要升只能从 git：
  `pip install "git+https://github.com/NandhaKishorM/laya@v0.3.7"`。
  **那一步我们已在本机自己实现**（`install_fastload()`，见下），所以不再有升级的紧迫性。
  （细节见 `Laya接入报告.md` §13.3.1 / §13.3.2）
- 训练方式：RLCD + 严格适当评分规则
- 上游对 `typed-decisions` 的说明：「在四种合成工作流上微调，不应作为静默默认」——
  我们没有更好的选择（`english` 装不下 state），但这个警告仍然成立。

### 快加载（`LAYA_FASTLOAD`，默认开）

`laya` 0.3.5 的 `preload` 要 **35–75 s**，其中 **95% 是纯粹浪费**：
`build_model()` 用 `AutoModel.from_config()` 对 4.2 亿参数做一次随机初始化，
紧接着 `load_state_dict(strict=True)` 把它**全量覆盖**。
分步实测：`build_model 25.15 s` / 读 842 MB 权重 `0.16 s` / `load_state_dict 0.63 s`
（同一个文件纯读一遍只要 `0.43 s` —— 所以瓶颈跟磁盘无关）。

本仓库在 `laya_bridge.py` 里用等价做法省掉那一步：在 `torch.device("meta")` 下建形状 →
`to_empty()` → 重建非持久 buffer → 让 `load_state_dict` 照常覆盖。

| 口径（干净进程，cuda） | 原生 | 快加载 |
|---|---|---|
| `ENGINE.init()` | 35 623 ms | **12 075 ms** |
| 差值来自 | — | 被删掉的随机初始化（≈25 s） |

★ **唯一的坑**：`persistent=False` 的 buffer **不会被 `load_state_dict` 覆盖**。
本检查点有 4 个 RoPE `*_inv_freq` 正属此类 —— 跳过初始化后它们是**未初始化内存**，
模型能跑、不报错、输出是垃圾。所以快加载会重算它们，并带守卫：
重算数量对不上、或实体化后仍有 meta 张量，就**回退到原生构建**（`/health` 的
`laya.fastload` 会报出实际走的哪条路径）。

正确性：10 组输入 × 全 22 问题集，`decision` / `decision_signals` / `policy` / `proposed_deltas`
展开后 **1707 个值逐个相同**。验证脚本：`tests/fastload_compare.py`。
不放心可关：`LAYA_FASTLOAD=0`（对比时两个进程各跑一次，别在同一进程里切）。
