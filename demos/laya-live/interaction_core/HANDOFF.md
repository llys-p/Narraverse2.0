# Candidate A · 交接

## 身份

- baseline SHA：`357d78b74fccbba6ae14307ed204ae55e6b6c300`
- baseline branch：`laya-p2-safe`；开工工作树干净。
- candidate branch：`codex/interaction-core-a`
- worktree：`D:\Narraverse2.0-interaction-a`
- 当前候选 HEAD：在该 worktree 执行 `git rev-parse HEAD`（最终提交号见交付消息）。
- 未查看其他候选实现；未 push；未修改/重启外部 8131 服务。

## 本次实现

多意图/多目标云端 Interpreter、显式前提检查、8 种动作操作、6 档确定性结算、
Laya 真实适配、原状态存储上的多实体事务、已提交回执叙事、最近对话注入、可试玩页面。
按用户最新要求，本轮优先实现功能，**没有新增或执行测试**。任务书的测试要求交后续 AI。

新增：interaction_core/ 下 contracts、interpreter、rules、bridge_adapter、scene、service、
narration、demo.html、本说明、ARCHITECTURE、TRACE_EXAMPLE，以及上一级 interaction_server.py。
修改：laya_bridge.py（analyze_core 内部可选跳过 legacy adjudication）；
laya_state_protocol.py（内部多实体提交）；README 与项目协作日志（入口与交接）。
冻结缓存、capability profiles、cases、旧 runs、配置和现有测试均未修改。

## 启动（PowerShell；本轮未执行）

不复制环境或模型；复用 D 盘现有资源。新端口默认 8132，若已占用换空闲端口。
路径须由验收者确认当前仍有效；--env-file 读取密钥而不输出内容。

```powershell
Set-Location 'D:\Narraverse2.0-interaction-a\demos\laya-live'
$env:LAYA_MODELS_DIR = 'D:\Narraverse2.0-wt-laya\demos\laya-live\_models'
$env:LAYA_DEVICE = 'cuda'
$env:PYTHONIOENCODING = 'utf-8'
& 'D:\Narraverse2.0-wt-laya\demos\laya-live\.venv-cuda\Scripts\python.exe' interaction_server.py --port 8132 --env-file 'D:\Narraverse2.0-wt-laya\demos\laya-live\.env'
```

打开 `http://127.0.0.1:8132/interaction`。输入 → 分析预览 → 确认提交 → 状态与中文结果。
可新建会话，避免污染其他任务的运行数据。默认场景含 player、lia、oren、地窖门、旧井
中的钥匙，以及玩家持有的徽章、小刀、苹果。规则试玩可追加 `--rules-only`；仍需云端
Interpreter API，此模式没有 Laya 推理/信号，不得用它声称真实 Laya 闭环已通过。

不要盲目把设备标签当成实际模型驻留证明；统一验收时确认张量设备。未做 CPU/GPU
性能比较或复制旧 benchmark 结论为本候选结论。模型目录环境变量须在 Python 导入前设置。

## HTTP 最小协议

```text
GET /interaction/state?session_id=demo-a
→ {versions:{player:token,lia:token,oren:token,ic_world:token},states:{...},history:[]}

POST /interaction/prepare
{session_id,event_id,actor_id:"player",message,expected_versions:上一步 versions}
→ {analysis_id,status:"ready",expires_at,state_proposal,outcome,trace}

POST /interaction/commit
{session_id,event_id,analysis_id,expected_versions:prepare 使用的原版本映射}
→ {commit_id,event_id,analysis_id,versions,outcome,states,trace,replayed,base_versions}

GET /interaction/receipt?session_id=demo-a&event_id=事件ID
→ 原提交回执（用于丢响应后恢复）

POST /interaction/narrate
{session_id,event_id}
→ {commit_id,source:"canonical_renderer",pace,text,contract}
```

Prepare 可以失败：NEEDS_CLARIFICATION、语义格式错误、模型/翻译不可用、档案不匹配、
版本冲突。均无游戏状态变化。新消息用新 event_id；提交网络超时重试原 commit，
不要重新生成一次动作。已提交后叙事失败，仅重试 narrate。

## 统一验收优先级

1. 语法/导入与启动；旧 p1/p2b1/p2b2/p2c 定向回归，确认可选参数默认兼容。
2. 注入 Interpreter/Evidence 端口做无模型 Resolver 与事务测试：6 档、资源耗尽、
   钥匙缺失、重复转交物品、条件动作、失败前进、多角色一次提交、异常回滚。
3. 2 NPC × 2 sessions 隔离；prepare 零写；旧 commit/reset 与新多实体候选双向 stale；
   重复 commit 不重复扣资源、不重复推进时钟；Narrate 只能引用已提交结果。
4. 小批真实语义表达：否定、隐喻、物体语境、间接信息、多意图、多目标、指代历史。
   检查错误分类而非只检查 JSON；严禁为隐藏句添加词表补丁。
5. 真实 Laya 少量样本及设备确认，核对 active/auxiliary、目标原文片段、翻译来源和
   新文档 token 预算。最后再试玩，记录分阶段耗时/费用，避免先大规模云端运行。

可以注入一个 callable 替代 JsonModel；它的输入为 system+data，输出为 JSON dict。
也可实现 Interpreter/EvidenceProvider 接口；这些仅是依赖注入端口，生产默认仍走
真实云端语义与 Laya。本候选没有硬编码测试句、伪造信号或模拟测试通过记录。

## 三项主要风险

1. **语义正确性尚未验证**：模型即使返回 schema 合法的动作，也可能误读否定/指代。
   temperature=0 不代表云端输出绝对一致。需要独立隐藏表达验收。
2. **玩法与表现仍是骨架**：档位公式是手写演示平衡；自由文学叙事尚未接入，当前是
   权威中文结果表达。默认关系是对玩家的一份向量，不是完整 NPC×NPC 关系矩阵。
3. **运行闭环未执行**：新增事务和页面尚未经过真实运行，Laya token 预算、实际设备、
   档案适配以及旧路由并发必须由后续验收确认。单进程、内存状态，重启不保存游戏。

如果只能继续一件事：对同一小批未见自然表达，逐层核验 Interpretation → CanonicalOutcome，
并用多角色/资源动作确认实际提交；先证明玩家语义与规则结果一致，再扩张动作种类。

## 本轮验证记录

仅静态阅读实现和 Git 差异/变更范围。未运行单测、语法检查、构建、HTTP 试玩、模型、
云端调用、benchmark 或浏览器检查；因此没有任何 PASS 数字，也不宣称已验收可用。
TRACE_EXAMPLE 为人工推演，真实 trace 可由页面或上述 HTTP 接口取得。
