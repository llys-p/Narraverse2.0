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

`narra_config.json` 的 `signals.order` 定义 9 个信号，两类量纲**不要混用**：

| kind | 来源 | 量纲 | 能否当阈值 |
|---|---|---|---|
| `prob` | `noul`，校准过的 P(true) | 0 ~ 1 | 可以 |
| `level` | `score`，期望强度 | 0 ~ 4 | **不可以**（不是概率） |

`hostility` / `cooperation` / `withdraw` / `confront` / `disclose` / `trust` / `doubt` / `danger`
是 `prob`；`investigate` 是 `level`。

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
| POST | `/decide` | 只跑 Laya：决策信号 + Policy 裁决 + 状态建议 |
| POST | `/narrate` | 跑 Laya 再让 LLM 出台词；**省略 `behavior` 会自动先跑 `decide`** |
| POST | `/world` | 世界事件推进（独立 tick） |
| GET | `/history` | 决策历史 |
| POST | `/reset` | 清空进程内历史 |

```bash
curl -s http://127.0.0.1:8130/narrate \
  -H 'Content-Type: application/json' \
  -d '{"player_input":"我是圣殿派来的，带了一封火漆印的信。"}'
```

关键返回字段：

| 字段 | 含义 |
|---|---|
| `decision_signals` | 9 个信号（`signal` / `label` / `kind` / `value` / `range`） |
| `policy` | `behavior` / `source` / `reasons` / `choice_baseline` / `confidence_level` / `fallback` |
| `decision.behavior` | 最终行为 + `choice_argmax` + `gated_baseline` + 可选 `gated_by` |
| `state_budget` | state token 数 / 余量 / **是否溢出** |
| `proposed_deltas` | 状态增量**建议**（不是 Actor State 真值） |
| `tick` | `npc` 或 `world` |
| `input_key` / `input_warning` | 本轮吃到的输入键 / 输入为空告警 |

★ `proposed_deltas` 是 proposal。正式链路必须是
**Laya Proposal → 后端 Validate → State Transition → Commit**；
浏览器端的 `applyDeltas()` 只是 Demo 手段，**不是状态权威**。

---

## 命令行自检

```bash
PY=.venv/Scripts/python.exe          # 一律用项目自带 venv，不要裸 python

$PY laya_bridge.py qcheck       # ★ 改配置后必跑：token 预算 / 温度桶 / state 溢出
$PY laya_bridge.py signaltest   # ★★ 主回归：48 用例 / 99 条决策方向断言
$PY laya_bridge.py ckptcompare  # 检查点同条件对照（两个进程各跑一次 signaltest）
$PY laya_bridge.py personatest  # 人格 A/B 对照（LAYA_PERSONA_STYLE=polarity 换写法）
$PY laya_bridge.py bench        # 性能基准（CPU / GPU 各跑一次）
$PY laya_bridge.py selftest     # 不起模型，验证 fallback 引擎
$PY laya_bridge.py llmtest      # 验证密钥与模型 id
$PY laya_bridge.py langtest     # 旧版 4 句极端输入区分度测试
```

诊断子集（结果单独存放，不影响正式对照）：`LAYA_QSET=signals`、`LAYA_CASES=id1,id2`。

`qcheck` 值得单独说：Laya 的 `build_sequence` 对选项有 48 token 上限，且所有选项必须塞进
`head_max_len`，塞不下会**静默压缩**；state 超预算会被 `st[:room]` **静默截断**
（保留左边、丢掉右边，最先丢的是 `decision_history` 和 `message`）。问题写太长、
state 塞太满，都会在无声无息中失效。

---

## 文件

| 文件 | 说明 |
|---|---|
| `laya_bridge.py` | HTTP 桥 + 决策编排 + CLI 自检（纯标准库） |
| `narra_config.json` | **决策模型本体**：行为表、6 个 score 维度、9 个信号、`gates`（已停用）、`policy`、`signals` |
| `laya-live-demo.html` | 单文件前端，三区结构：① Decision Signals ② Policy Resolver ③ Story Agent |
| `Laya接入报告.md` | 面向其他 AI 的交接报告。**§12 是第二轮全部结论与架构判定，必读** |
| `tests/` | 实验证据（`regression_cases.json` 48 用例 / `thresholds.json` 逐用例全维度观测 / `personality_personas.json` / 4 个结果 JSON）。**这些是证据，要提交** |
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
