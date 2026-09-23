# Laya 实时对话 Demo

用 **Laya 决策引擎**（非自回归 System-1）驱动 NPC 行为决策，用 **LLM** 把决策渲染成台词的实时对话 Demo。

浏览器里输入一句话 → Laya 跑一次前向 → 输出「NPC 下一步做什么 + 关系数值怎么变」→ LLM 只负责把结果说成人话。

> 这不是「又一个酒馆聊天」。酒馆里的 NPC 行为完全由 LLM 即兴生成，不可复现、不可校验；这里的**行为决策来自一个冻结的判别式引擎**——单次前向、无采样、无生成、同样输入必得同样输出，且每个维度都有概率值可查。

---

## 它解决什么问题

LLM 直接演 NPC 有三个绕不过的毛病：

| 问题 | LLM 即兴演 | 本方案 |
|---|---|---|
| 可复现性 | 同一句话两次结果不同 | 同输入同输出（无采样） |
| 数值一致 | 「好感 +3」纯属编造 | 由 `score` 原始输出映射，可追溯 |
| 行为边界 | 容易被玩家用话术带跑 | `noul` 门限可硬性改写行为 |
| 幻觉 | 会凭空发明设定 | 决策引擎不生成文本，无从幻觉 |

代价是：**决策质量没法和 LLM 比**。这是刻意的取舍——要的是一个**能被校验的骨架**，而不是一段好看的文字。实测边界见文末「已知局限」。

---

## 架构

```
 浏览器 (laya-live-demo.html)
    │  POST /narrate  { actor, message, state }
    ▼
 ┌─────────────────────────────────────┐
 │  laya_bridge.py  (纯标准库 HTTP)     │
 │                                     │
 │  1. build_laya_questions()          │  ← narra_config.json
 │      组装 question / score / noul    │
 │  2. engine.set(...) → agent.answer  │  ← Laya 单次前向
 │  3. apply_gates()                   │  ← noul 概率 ≥ 阈值则改写行为
 │  4. build_deltas()                  │  ← score → 关系数值增量
 │  5. llm_narrate()                   │  ← DeepSeek 只做「说人话」
 └─────────────────────────────────────┘
```

### 三个决策原语里只有一个半能用

Laya 提供 `choice` / `score` / `noul` 三种问题类型。实测下来：

- **`score`（0–4 打分）和 `noul`（是/否）是校准可信的** —— 问题写对了，方向就能对上。
- **`choice` 本质偏弱** —— 哪怕把问题重写到最优，置信度仍卡在 **0.07–0.16**。置信度用的是归一化 Shannon 熵，这个数值等于模型在说「我不知道」。所以**不能把 `choice` 的 argmax 当作行为决策**。

于是架构变成：**`choice` 提供基础分布，`noul` 门限负责最终改写，`score` 提供数值增量。**

`narra_config.json` 里的 `gates` 段就是那个「改写开关」：

```json
"gate_ally": { "behavior": "ally", "threshold": 0.45 }
```

含义：`gate_ally` 这个 noul 问句（「她是否在考虑结盟」）的输出概率 ≥ 0.45 时，**无视 `choice` 选了什么**，行为直接改写为 `ally`。实测该门限把 `choice` 选的 `confide` 改成了 `ally`，UI 上会显示「choice 首选·被改写」。

---

## 问题设计的三条铁律

这三条是 A/B/C/D 对照实验里踩出来的，违反任何一条，`choice` 就会退化成「永远选同一个」：

1. **`instructions` 必须用反引号引用状态里的键名** —— `` `npc` ``、`` `message` ``、`` `relationship` ``。裸写自然语言描述会被忽略。
2. **`score.criteria` 必须是领域内的等级描述**，不能是一套通用比较级（如「很差/较差/一般/较好/很好」）。必须写成「信任明显下降 / 信任略有下降 / 信任不变 / 信任略有上升 / 信任明显上升」。
3. **`choice` 的选项必须是 3–5 个词的短标签**。写成完整句子会形成一个「先验吸引子」，把答案全部吸过去。

---

## 快速开始

```bash
# 1. 配置
cp .env.example .env
#    编辑 .env，填入 DEEPSEEK_API_KEY

# 2. 装依赖（Laya + torch CPU）
pip install "laya==0.3.5" torch transformers

# 3. 起桥
python laya_bridge.py serve          # 默认 127.0.0.1:8130

# 4. 开页面
#    http://127.0.0.1:8130/demo
```

Windows 下可直接双击 `启动Laya桥.bat`。

> **内存要求**：每个 Laya 检查点约 840 MB。同时加载两个会 OOM 且**无任何报错堆栈**（直接段错误）。桥启动前会自行检查可用物理内存。

### 检查点

首次运行会自动下载。若想手动放置，目录结构：

```
_models/
  typed-decisions/    ← 默认使用（ModernBERT-large, max_len=1024, head_max_len=256）
  english/
  multilingual/
```

用 `LAYA_MODEL=english` 可切换。

---

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/demo` | 演示页面 |
| GET | `/health` | 引擎、模型名、加载状态 |
| GET | `/config` | 当前决策模型（脱敏） |
| POST | `/decide` | 只跑 Laya，返回行为 + 概率 + 数值增量 |
| POST | `/narrate` | 跑 Laya 再让 LLM 出台词；**省略 `behavior` 会自动先跑 `decide`** |
| POST | `/world` | 世界事件推进 |
| GET | `/history` | 决策历史 |

```bash
curl -s http://127.0.0.1:8130/narrate \
  -H 'Content-Type: application/json' \
  -d '{"message":"我是圣殿派来的，带了一封火漆印的信。"}'
```

---

## 命令行自检

```bash
python laya_bridge.py selftest    # 不起模型，验证 fallback 引擎
python laya_bridge.py qcheck      # 校验问题集是否超预算（超了会被静默截断）
python laya_bridge.py llmtest     # 验证密钥与模型 id
python laya_bridge.py langtest    # 极端对比输入下的区分度测试
```

`qcheck` 值得单独说：Laya 的 `build_sequence` 对选项有 48 token 上限，且所有选项必须塞进 `head_max_len`，塞不下会**静默压缩**。问题写太长就会在无声无息中失效。

---

## 文件

| 文件 | 说明 |
|---|---|
| `laya_bridge.py` | HTTP 桥 + 决策编排 + CLI 自检（纯标准库，无第三方依赖） |
| `narra_config.json` | **决策模型本体**：行为表、6 个 score 维度、3 个门限问句、`gates` 段 |
| `laya-live-demo.html` | 单文件前端，可实时输入，展示完整决策链路 |
| `Laya接入报告.md` | 面向其他 AI 的交接报告：代码行号索引、字段表、全部实测数据、故障排查 |
| `启动Laya桥.bat` | Windows 一键启动（**GBK 编码**，勿转 UTF-8） |
| `.env.example` | 配置样例，复制为 `.env` 后填自己的密钥 |
| `.gitignore` | 排除 `.env`、虚拟环境、检查点权重、调试产物 |

想改设定，**先读 `Laya接入报告.md`** —— 里面记了每个字段的形状和那三个容易踩的坑。

### 开发脚本（`_` 前缀 = 本地工具）

⚠️ 这些脚本**必须和 `laya_bridge.py` 保持同一层目录**，不要归到子目录里：`_gen_bat.py` 把 `.bat` 写到自身所在目录，`_fetch_laya.py` 把检查点下到自身同级的 `_models/`——而那正是桥查找检查点的位置。挪位置会**静默失效**（不报错，只是找不到东西）。

| 文件 | 说明 |
|---|---|
| `_fetch_laya.py` | 带断点续传的检查点下载器，写入同级 `_models/` |
| `_gen_bat.py` | 生成 `启动Laya桥.bat`（改启动文案请改这里，别手改 `.bat`） |
| `_shot.mjs` | 借 CDP 驱动 Edge 截图，零依赖（Node 21+ 自带 `WebSocket`） |
| `_probe_demo.mjs` | 抓取演示页文本，用于核查 UI 实际渲染了什么 |
| `_probe_llm.mjs` | 直连 LLM 接口探活 |

---

## 实测效果

四个极端对比输入（持刀威胁 / 同袍相认 / 路人问路 / 辱骂教团），`typed-decisions` + compact 状态：

| 指标 | 优化前 | 优化后 |
|---|---|---|
| 行为区分度 | 4 输入 → **1** 种行为 | 4 输入 → **2** 种行为 |
| 玩家意图判定 | — | **4/4 正确** |
| 信任值跨度 | 0.10 | **1.02** |
| 尊重 / 好感跨度 | 0.22 / 0.19 | **0.95 / 0.88** |
| 单轮延迟 | 19 s | 14–15 s |

6 个数值维度里 **5 个方向正确**（信任/尊重/好感/怀疑/目标），`alert_shift` 方向可疑。

---

## 已知局限

这一节是认真的，不是免责声明。**当前状态适合做技术验证，不适合直接上生产。**

- **`choice` 对敌意输入判断偏弱**：持刀威胁的场景，`choice` 选了 `probe`（试探），语义上更该是 `leave`（离开）或 `distance`（保持距离）。
- **`gate_leave` 方向可疑，已标记为不生效**。`gate_confide` 观察到的分布里找不到安全阈值，同样未启用。目前**只有 `gate_ally` 一个门限是真正生效的**。
- **所有门限阈值都建立在 ≤7 个样本上**。0.45 这个数是「非结盟最高 0.344 / 结盟最低 0.527」的中点，两侧各留约 0.08 余量——样本量一大就得重算。
- **单轮 21–27 s（CPU）**。瓶颈在 Laya 前向，不在 LLM。
- **`typed-decisions` 与 `english` 未做过同条件对比**（内存装不下两个检查点同时加载）。上游 `router.py` 明确说 `typed-decisions` 是「针对四种合成工作流微调的，不应作为静默默认值」——这个对比该补。

### 关于 `effort` 的坑

`LLM_EFFORT=low` 时，DeepSeek-V4.1-Flash 有时**不产生独立推理通道**（`usage.reasoning_tokens == 0`），于是它把「复述要求 + 写计划 + 真正台词」一股脑塞进 `message.content`，台词位置就会混进计划文本。

桥里做了两道防线：要求 `<line></line>` 结构化输出；取不到标签且命中 ≥2 个计划特征词就判定污染 → 降温度重试一次 → 仍失败则退回台词池，并把原始内容留在 `raw_content_first` 里备查。**根治办法是把 `LLM_EFFORT` 调成 `high`**，high 会走独立推理通道。

---

## 上游

- Laya 决策引擎：<https://github.com/NandhaKishorM/laya>（PyPI `laya` 0.3.5）
- 训练方式：RLCD + 严格适当评分规则
