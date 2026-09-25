# Candidate B 交接

基线 `357d78b74fccbba6ae14307ed204ae55e6b6c300`；分支 `laya-b-freeform`；
工作树 `D:\Narraverse2.0-wt-b`。WorkBuddy 留下 3 个模块和一个 Interpreter 测试；
Codex 接通服务层、试玩页、旧 Laya 适配和本文档。没有读取或依赖 A/C 实现。

## 代码

新增：`laya_turn_interpreter.py`、`laya_facts.py`、`laya_resolver.py`、
`laya_interaction_b.py`、`b_demo.html`、`tests/b_turn_interpreter_test.py`、
`ARCHITECTURE.md`、`TRACE_EXAMPLE.md`、`HANDOFF.md`。
修改：`laya_bridge.py` 的分析内部开关、`README.md` 入口、项目协作日志。
冻结翻译缓存、capability、cases、runs、配置和旧测试不改。

## 启动（仅交接命令；本轮未执行）

在 PowerShell 中先设置模型目录与 CUDA，再启动新进程；不要重启正在使用的 8131。

```powershell
Set-Location 'D:\Narraverse2.0-wt-b\demos\laya-live'
$env:LAYA_MODELS_DIR = 'D:\Narraverse2.0-wt-laya\demos\laya-live\_models'
$env:LAYA_DEVICE = 'cuda'
$env:PYTHONIOENCODING = 'utf-8'
& 'D:\Narraverse2.0-wt-laya\demos\laya-live\.venv-cuda\Scripts\python.exe' laya_interaction_b.py --port 8133 --env-file 'D:\Narraverse2.0-wt-laya\demos\laya-live\.env'
```

打开 `http://127.0.0.1:8133/b/demo`。新会话建议使用页面按钮。游戏状态只存在此
服务进程内。`--env-file` 读取既有密钥，不打印或复制密钥；需要云端 Interpreter，
Laya 必须真实就绪。用户此前指出 CPU 误跑问题，因此验收时确认实际张量设备；
仅 `device_label` 和环境变量不足以证明 GPU 驻留。

## HTTP

```text
GET /b/state?session_id=demo-b
→ {session_id,states,versions}

POST /b/analyze
{session_id,event_id,actor_id:"player",message,expected_versions:刚取得的 versions}
→ {analysis_id,interpretation,laya_evidence,fact_resolution,
   canonical_outcome,proposed_states,base_versions}

POST /b/commit
{session_id,event_id,analysis_id,expected_versions:分析所用的原 versions}
→ {status:"committed",commit_id,versions,states,canonical_outcome,trace,replayed}

GET /b/receipt?session_id=demo-b&event_id=原事件ID
→ 原提交回执（网络断线可恢复）

POST /b/narrate {session_id,event_id}
→ {commit_id,text,source:"committed_outcome",canonical_outcome}
```

分析不提交，提交不接受客户端 delta。重复提交原 analysis_id 返回 replayed 回执。
新一句话必须新 event_id。失败时错误码可明确区分语义、事实目标、Laya、状态版本。

## 待验收

依用户要求，本轮**未运行测试、语法检查、模型、云端、浏览器或 benchmark**；
没有 PASS 数字。之前 WorkBuddy 写的 `b_turn_interpreter_test.py` 是资产，不代表已运行。
建议另一个 AI 用隔离端口与少量样本核对：

1. Interpreter 否定、隐喻、物体语境、多意图、多目标、历史指代；不加测试句词表。
2. 未持有钥匙不能开门；交徽章前后所有权；同回合连续动作读取上一动作结果；
   失败代价和机会不被 Story 改成成功。
3. Analyze 零写、版本冲突、重复提交、异常回退、2 NPC × 2 sessions 隔离，
   旧路由 commit/reset 与 B 候选的相互失效。
4. 真实 Laya 证据、能力门禁、翻译缓存与 token 预算，少量真实云端请求的费用和耗时。

最值得注意：B 当前的 operation 集是首版子集，Resolver 的权重尚未调平衡；
走向旧井、拾起钥匙、回到酒馆开门只是最小连续玩法，实际表现待验收。
故事层是权威结果表达，不是开放文学台词。真正接入 Narraverse Runtime 存储与
Cloud Director，需要在统一评审 A/B/C 后单独设计。
