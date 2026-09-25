# B 全链路 Trace：人工推演，未经运行

输入：`箱子我没带来，不过钥匙埋在旧井第三块砖下面。你如果还觉得我是骗子，就自己去看。`
会话为 trace-b，行动者 player，默认听者 lia，原版本映射由 GET /b/state 获取。

1. **Raw Input**：原句、session_id、actor_id、event_id 和四个读取版本进入 /b/analyze。
2. **Turn Interpretation**：示例模型产出两项意图：`information_handover + speak → lia`
   （原文依据“钥匙埋在旧井第三块砖下面”）及 `challenge + speak → lia`
   （依据“你如果还觉得我是骗子，就自己去看”）。这是人工示例，不冒充 DeepSeek 实际输出。
3. **Fact Checks**：lia 存在且玩家可以说话。初始 WorldState 中玩家**未持有**钥匙，
   但本轮只是声称位置，不要求持有钥匙，也不改变其所有权。第三块砖并非已验证事实。
4. **Laya Evidence**：真实运行时按莉亚当前关系、整句原文得到 Laya signals 与
   profile 限定的 state proposal；这里不捏造分数。若引擎未就绪，本候选拒绝分析。
5. **Resolution Context**：每条使用明确意图、目标、事实报告、玩家 stats、莉亚对
   玩家的关系、环境、资源和有限 Laya 倾向；`resolve()` 输出每条 6 档之一及 factor 明细。
6. **Canonical Outcome**：每条 speak 若结算成功，仅生成
   `reported_claim{speaker:player,listener:lia,content:原文片段,verified:false}`。
   莉亚是否相信、钥匙是否真实埋在该砖下、是否去检查，都不在已发生事实中。
   若某条不成功，保留该条失败结果，不以另一条成功覆盖它。
7. **State Proposal**：仅计划把未核实的“说过什么”、有限且经 capability/State
   Transition 校验的 Laya 状态变化、turn+1 写入现有 session 状态桶。
8. **Commit Result**：服务端按原版本重新算，再在协议锁下更新实际 Actor State、
   世界运行桶、版本、trace、event 回执。只有成功 Commit 后才成为下一轮可读状态。
9. **Narration Contract**：/b/narrate 仅按已提交回执表达各项结果，可写“莉亚听到了
   你对钥匙位置的说法”，不能写“莉亚已经找到钥匙并确信你诚实”。

完整运行 trace 会在页面“完整审计过程”和 /b/receipt 中显示；本文件不包含实测输出。
