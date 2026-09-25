# 完整 Turn Trace · 人工推演

**这不是运行结果。** 以下使用显式 rules-only 配置说明契约，不伪造 Laya 分数或云端结果。
版本 token 写作 V0/V1 仅用于阅读，真实调用必须使用 GET 返回的不透明 token。

## 1. Raw Input

```json
{
  "session_id": "trace-a", "event_id": "turn-001", "actor_id": "player",
  "message": "箱子我没带来，不过钥匙埋在旧井第三块砖下面。你如果还觉得我是骗子，就自己去看。",
  "expected_versions": {"player":"V0","lia":"V0","oren":"V0","ic_world":"V0"}
}
```

服务端初始事实：player 与 lia/ oren 在酒馆；cellar_key.owner=null，location=old_well；
门关闭且上锁；default_addressee=lia；turn_tick=0；facts=[]。
“第三块砖”没有登记为已验证事实。

## 2. Turn Interpretation（示例模型输出，未经真实模型执行）

```json
{
  "actions": [
    {"id":"a1","actor_id":"player","kind":"information_handover","operation":"communicate",
     "target_ids":["lia"],"object_id":null,"tool_id":null,"mode":"attempt",
     "content":"箱子没带来；钥匙埋在旧井第三块砖下面",
     "evidence":"箱子我没带来，不过钥匙埋在旧井第三块砖下面。","tone":"matter-of-fact","depends_on":null},
    {"id":"a2","actor_id":"player","kind":"challenge","operation":"communicate",
     "target_ids":["lia"],"object_id":null,"tool_id":null,"mode":"attempt",
     "content":"如果仍不信，可以自己去看",
     "evidence":"你如果还觉得我是骗子，就自己去看。","tone":"impatient","depends_on":null}
  ],
  "ambiguities": []
}
```

这里没有 transfer、取钥匙或强制 NPC 离场动作；对 NPC 的建议保持为传达的内容。

## 3. Fact Checks

两次 communicate 均满足：行动者可行动、接收者存在且同地点、不是自己、接收者未失能、
精力需求为 0。allowed=true，reasons=[]，verified_evidence=[]。
规则不验证被说出的“第三块砖”为真，也不因此修改物体 owner/location。

## 4. Laya Evidence

```json
[]
```

这是 rules-only 的显式空证据。真实模式会调用 BridgeEvidence，并展示 checkpoint、
rules_fingerprint、signals/capability、proposal；真实数值待运行，不能用手填分数代替。

## 5. Resolution Context → Action Resolution

两项上下文分别为：`{action_id:a1/a2,target_id:lia,factors:{},margin:null,rule:prerequisites_sufficient}`。
两项结果分别为 degree=success，achieved="信息已传达；内容真实性及对方是否接受均未确认"。
各产生一条 communicated_claim（speaker=player、recipient=lia、content=对应声明、
truth=unverified）；不产生物品、关系或 NPC 行动变化。

## 6. Canonical Outcome

```text
event_id: turn-001
result: resolved
degree: success
resolutions: 上述 a1 / a2 的独立结果
facts_created:
  - communicated_claim(player → lia, 箱子/钥匙声明, truth=unverified)
  - communicated_claim(player → lia, 邀请对方核验, truth=unverified)
state_changes:
  - ic_world.interaction.turn_tick: 0 → 1 (turn_clock)
  - ic_world.interaction.facts: [] → 两条 communicated_claim (canonical_facts)
costs: []
complications: []
opportunities: []
```

整体 success 指“表达成功”，**不是 NPC 相信、已经拿到钥匙或核验成功**。

## 7. State Proposal → Commit Result

StateProposal 携带四个实体的 base_versions 及上述两个 StateChange。
提交前重验全部版本与纯结算，再向现有协议 commit_interaction_bundle 发布 ic_world。
最终回执包含原 outcome、完整状态快照、commit_id、analysis_id、event_id 和版本映射：
player/lia/oren 保持 V0，ic_world 更新 V1；replayed=false。
同一原 commit 再次请求，返回原回执且 replayed=true，不重复添加事实/推进时钟。
世界桶在同一事务中记录当前 user 原文和确定性 assistant 结果，下一轮 Interpreter 可读。

## 8. Narration Contract

```text
commit_id: 服务端已提交回执的 ID
outcome: 原 CanonicalOutcome
state_versions: 提交后的版本映射
may_change: [pace]
must_preserve: [degree, facts_created, state_changes, costs, complications]
```

默认表达会说明“莉亚 · 达成：信息已传达；内容真实性及对方是否接受均未确认”，
再引用两条声明并标注尚未核实。它不会写“莉亚相信了你，走到旧井取出钥匙”。
页面 trace 同时保留 raw_input、interpretation、fact_checks、laya_evidence、
resolution_context、canonical_outcome、state_proposal、commit receipt 和 narration contract。
