package app

import (
	"context"
	"log"
	"log/slog"
	"strings"
	"sync"

	"github.com/cloudwego/eino/adk"

	"denova/config"
	"denova/internal/agent"
	"denova/internal/book"
	"denova/internal/libraryruntime"
	"denova/internal/worldcontext"
)

// Phase 3.2-A1b/A2：写作运行的正式输入边界与 bind-before-start 编排。
//
// 冻结约束：
//   - agent.ChatRequest 只承载既有聊天业务字段，绝不塞入 worldcontext 运行字段；
//   - World 控制信息（Ref / analysis handle）经独立的 WritingWorldControl 显式传递；
//   - consumer 由写作路径固定为 writing，scopeKey 由服务端 Task ID 派生，
//     客户端提交的 consumer/scope/runContextId 已在 HTTP 传输层被拒绝；
//   - 模型 goroutine 绝不早于 Ref/handle 的 bind/claim/move/降级裁定；
//   - World 只读：不写 revision、不保存 Snapshot/ModelView，runContext 仅存在于进程内 Registry。

// WritingWorldControl 是一次写作请求携带的 World Context 控制信息（handler-owned）。
type WritingWorldControl struct {
	// Ref 为 nil 表示请求未携带 world_context（bare 写作）。
	Ref *worldcontext.Ref
	// HasAnalysisHandle 表示是否携带非空 analysis_handle（"" 与 null 视为未携带）。
	HasAnalysisHandle bool
	// AnalysisHandle 是规范化后的不透明 token；不是 Task、runContext，也不持久化。
	AnalysisHandle string
}

// Present 报告是否携带任一 World Context 控制字段。
func (c WritingWorldControl) Present() bool {
	return c.Ref != nil || c.HasAnalysisHandle
}

// WritingTaskInput 是写作后台任务的完整 app 层输入：业务请求 + World/Library 控制信息分离。
// Library 与 World 由传输层互斥（同现 400 background_source_conflict）；Library.Present()
// 时 World 必为空，app 层再防御性校验一次，绝不按优先级吞并其一。
type WritingTaskInput struct {
	Request agent.ChatRequest
	World   WritingWorldControl
	Library WritingLibraryControl
	// BackgroundSource 是传输层裁定后的背景来源：legacy | library | none（§8.1）。
	BackgroundSource string
	// BackgroundSourceExplicit 区分“客户端显式声明 background_source”与“缺省时的
	// 结构推断”（B2a 修正轮）：只有显式 none 才关闭旧 Lore 注入并兑现“无作品背景”；
	// 未声明请求即使被推断为 none 也保持旧写作路径逐字节兼容。
	BackgroundSourceExplicit bool
}

// writingTaskScopeKey 由服务端 Task ID 派生写作 runContext 的 scopeKey；
// 禁止读取客户端自造的 scope/scopeKey。
func writingTaskScopeKey(taskID string) string {
	return "task:" + taskID
}

// writingBackgroundPlan 是一次写作运行的背景模式裁定与单源系统提示组成（B2a 修正轮）。
// Composition 必须同时充当两个角色且来自同一对象：Instruction() 送入 runner 构建
// （模型实际系统提示），整个 composition 作为 RunOptions.SystemPromptLog（计费量测
// 与提示审计）——两份文本逐字节一致。
type writingBackgroundPlan struct {
	// Mode ∈ {agent.BackgroundModeLegacy, BackgroundModeLibrary, BackgroundModeNone}。
	Mode string
	// NoLegacyLore 表示旧 Lore 注入三通道（系统提示 lore 片段、稳定上下文 lore 片段、
	// lore 工具与指引）必须全关；legacy 模式恒为 false（旧请求兼容）。
	NoLegacyLore  bool
	Composition   agent.SystemPromptCompositionLog
}

// planWritingBackground 裁定背景模式并构建单源系统提示组成（B2a 修正轮）。
//   - 携带 library 控制字段：library 模式，旧 Lore 三通道全关；
//   - 显式声明 background_source=none：none 模式，同上且不挂任何背景读取工具；
//   - 其余（未声明/显式 legacy，含结构推断为 none 的未声明请求）：legacy 模式，
//     与基线逐字节一致（旧请求兼容——推断的 none 不等于显式 none）。
func planWritingBackground(cfg *config.Config, state *book.State, teller agent.IDEStoryTeller, in WritingTaskInput) writingBackgroundPlan {
	mode := agent.BackgroundModeLegacy
	if in.Library.Present() {
		mode = agent.BackgroundModeLibrary
	} else if in.BackgroundSourceExplicit && in.BackgroundSource == agent.BackgroundModeNone {
		mode = agent.BackgroundModeNone
	}
	return writingBackgroundPlan{
		Mode:         mode,
		NoLegacyLore: mode != agent.BackgroundModeLegacy,
		Composition:  agent.BuildBackgroundInstructionComposition(cfg, state, teller, mode),
	}
}

// writingSessionKey 派生写作 analysis handle 归属的会话键（§6.4.1），
// 供会话/工作区切换时让旧 pending/claimed handle 失效；A4 创建 handle 时复用同一规则。
func writingSessionKey(workspaceID, sessionID string) string {
	return "workspace:" + workspaceID + "|session:" + sessionID
}

// isBlockingWorldContextError 区分“必须阻断本次写作”的领域错误与“可降级为 bare”的错误。
// 选择/修订/归档/可信消费者/引用不一致属于客户端可纠正或安全相关问题，必须阻断；
// world 暂时不可读、投影失败等运行时问题不阻断写作，降级为无 World 背景的 bare 运行。
// budget_exceeded 只有 consumer_window 过小无法由用户缩减选择修复，允许降级；
// 其它预算层必须阻断并让用户显式缩减输入。
func isBlockingWorldContextError(err error) bool {
	switch worldcontext.CodeOf(err) {
	case worldcontext.ErrInvalidRequest,
		worldcontext.ErrSelectionInvalid,
		worldcontext.ErrRevisionConflict,
		worldcontext.ErrWorldArchived,
		worldcontext.ErrContextRefMismatch,
		worldcontext.ErrConsumerNotTrusted:
		return true
	case worldcontext.ErrBudgetExceeded:
		de, ok := err.(*worldcontext.DomainError)
		return !ok || de.Layer != "consumer_window"
	default:
		return false
	}
}

// writingWorldRun 是一次写作任务 bind-before-start 的运行时结果（派生，不持久化）。
type writingWorldRun struct {
	runContext   *worldcontext.RunContext
	scopeKey     string
	hasHandle    bool
	handleStatus AnalysisHandleUseStatus // 未携带 handle 时为空
	// degraded 表示客户端显式提交了 Ref，但因可降级运行时错误最终无背景送模（§6.3）。
	// 此时 runContext 为 nil，但 context_state 必须标 degraded 而不是 none。
	degraded     bool
	degradedCode string
}

// resolveWritingRun 执行写作的 bind-before-start 裁定，返回最终绑定到 task scope 的运行上下文。
// 返回 nil 表示本次为 bare 写作（Registry 零增量）。World 只读，不复制 ModelView bytes。
//
// 状态矩阵：
//   - 无 Ref 且无 handle：bare，零 Registry 增量。
//   - 仅 Ref：读取已保存 World 构建 Snapshot 后 Bind 到 task scope。
//   - 仅 handle：claim 成功则把 pending runContext 迁移到 task scope 并 consume；
//     claim 失效（invalid/expired/consumed）且无服务端 Task 关联时回落 bare。
//   - Ref + handle：Ref 优先。fingerprint 一致→迁移 pending 并 consume（不复制 bytes）；
//     不一致→回滚 handle、按 Ref 新建，状态 ignored_conflict；绝不报“字段互斥”。
func (s *WorldContextService) resolveWritingRun(ctx context.Context, taskID, sessionKey string, ctrl WritingWorldControl) (*writingWorldRun, error) {
	if s == nil {
		return nil, nil
	}
	consumer := worldcontext.ConsumerWriting
	taskScope := writingTaskScopeKey(taskID)
	refRequested := ctrl.Ref != nil
	hasRef := refRequested
	hasHandle := ctrl.HasAnalysisHandle && strings.TrimSpace(ctrl.AnalysisHandle) != ""
	if !hasRef && !hasHandle {
		return nil, nil // bare：零 Registry 增量
	}
	// degradedRun 构造一个“客户端要了背景但可降级失败”的占位结果（runContext 为 nil）。
	degradedRun := func(code string) *writingWorldRun {
		return &writingWorldRun{scopeKey: taskScope, degraded: true, degradedCode: code}
	}

	// Ref 优先：先校验显式 Ref。阻断错误直接返回；可降级错误放弃 Ref，但仍允许尝试 handle。
	var refSnapshot *worldcontext.Snapshot
	refFingerprint := ""
	refDegradedCode := ""
	if hasRef {
		snap, err := s.loadSnapshot(ctx, consumer, *ctrl.Ref)
		if err != nil {
			if isBlockingWorldContextError(err) {
				return nil, err
			}
			refDegradedCode = string(worldcontext.CodeOf(err))
			slog.Warn("world_context writing ref degraded to bare",
				"consumer", string(consumer), "code", refDegradedCode)
			hasRef = false
		} else {
			refSnapshot = snap
			refFingerprint = snap.ContextFingerprint
		}
	}

	if hasHandle {
		claim, claimStatus := s.claimAnalysisHandle(ctrl.AnalysisHandle, consumer, sessionKey)
		if claim != nil && claimStatus == AnalysisHandleClaimed {
			lease := claim.pendingContextLease()
			fingerprint := lease.Fingerprint
			if hasRef {
				fingerprint = refFingerprint
			}
			moved, moveErr := s.registry.MoveScopeByID(
				consumer, lease.RunContextID, lease.PendingScopeKey, taskScope, fingerprint,
			)
			if moveErr == nil {
				// runContext 已原子迁移到 task scope（不重投影/不换 salt/不复制 bytes），此后由本 task
				// 的 releaseWorldRun 负责释放。consume 可能在 move 之后被并发取消/会话切换/TTL 过期命中，
				// 必须采用其真实返回状态，不能无条件假定 consumed；handle 清理即便失败也不会重复释放
				// task scope（releasePendingLocked 只 Destroy 原 pending scope，幂等返回 false）。
				consumeStatus := s.consumeAnalysisHandle(claim)
				status := consumeStatus
				if consumeStatus == AnalysisHandleConsumed && hasRef && lease.Fingerprint != refFingerprint {
					// 迁移成功但指纹不一致在 MoveScopeByID 下不可能发生；保守按冲突处理。
					status = AnalysisHandleIgnoredConflict
				}
				if consumeStatus != AnalysisHandleConsumed {
					slog.Warn("world_context writing handle moved but not cleanly consumed",
						"consumer", string(consumer), "status", string(consumeStatus))
				}
				return &writingWorldRun{
					runContext:   moved,
					scopeKey:     taskScope,
					hasHandle:    true,
					handleStatus: status,
				}, nil
			}
			// 迁移失败：回滚 claimant（释放 pending 恰好一次）。
			s.rollbackAnalysisClaim(claim)
			if hasRef {
				// Ref 仍可用：按 Ref 新建，handle 记为冲突忽略。
				rc, err := s.bindWritingSnapshot(taskScope, refSnapshot)
				if err != nil {
					return nil, err
				}
				return &writingWorldRun{
					runContext:   rc,
					scopeKey:     taskScope,
					hasHandle:    true,
					handleStatus: AnalysisHandleIgnoredConflict,
				}, nil
			}
			slog.Warn("world_context writing handle move failed; fall back to bare",
				"consumer", string(consumer), "code", string(worldcontext.CodeOf(moveErr)))
			if refRequested {
				code := refDegradedCode
				if code == "" {
					code = string(worldcontext.CodeOf(moveErr))
				}
				return degradedRun(code), nil
			}
			return nil, nil
		}

		// claim 未成功（invalid/expired/consumed）：失效 handle 绝不用于恢复背景。
		if hasRef {
			rc, err := s.bindWritingSnapshot(taskScope, refSnapshot)
			if err != nil {
				return nil, err
			}
			return &writingWorldRun{
				runContext:   rc,
				scopeKey:     taskScope,
				hasHandle:    true,
				handleStatus: claimStatus,
			}, nil
		}
		// 无可用 Ref、handle 失效：若客户端原本提交了 Ref 但已可降级失败，标 degraded；
		// 否则写作阶段不存在可恢复的服务端 Task 关联 → bare（none）。
		slog.Warn("world_context writing handle unusable; fall back to bare",
			"consumer", string(consumer), "status", string(claimStatus))
		if refRequested {
			code := refDegradedCode
			if code == "" {
				code = "context_unavailable"
			}
			return degradedRun(code), nil
		}
		return nil, nil
	}

	// 仅 Ref。
	// loadSnapshot 的非阻断错误会把 hasRef 降级为 false；没有可用 handle 时必须在
	// 进入 bindWritingSnapshot 前结束为 bare，绝不能把 nil Snapshot 交给 Registry。
	if !hasRef || refSnapshot == nil {
		// 客户端提交了 Ref，但快照阶段已可降级失败 → degraded；否则才是真正的 bare（none）。
		if refRequested {
			code := refDegradedCode
			if code == "" {
				code = "context_unavailable"
			}
			return degradedRun(code), nil
		}
		return nil, nil
	}
	rc, err := s.bindWritingSnapshot(taskScope, refSnapshot)
	if err != nil {
		if isBlockingWorldContextError(err) {
			return nil, err
		}
		code := string(worldcontext.CodeOf(err))
		slog.Warn("world_context writing bind degraded to bare",
			"consumer", string(consumer), "code", code)
		return degradedRun(code), nil
	}
	return &writingWorldRun{runContext: rc, scopeKey: taskScope}, nil
}

// writingWorldContextStateEvent 构造模型内容前下发一次的 world_context_state 事件（派生、不持久化）。
// active：已绑定背景并附脱敏摘要；degraded：客户端要了背景但可降级失败；none：本次无世界背景。
// analysisHandleStatus 单列，绝不伪装成 context_state=degraded。
func writingWorldContextStateEvent(run *writingWorldRun) agent.Event {
	data := map[string]any{}
	switch {
	case run != nil && run.runContext != nil:
		summary := run.runContext.UISummary()
		data["state"] = "active"
		if summary.WorldName != "" {
			data["worldName"] = summary.WorldName
		}
		if summary.RevisionLabel != "" {
			data["revisionLabel"] = summary.RevisionLabel
		}
		if summary.SelectedCount != 0 {
			data["selectedCount"] = summary.SelectedCount
		}
		if run.hasHandle && run.handleStatus != "" {
			data["analysisHandleStatus"] = string(run.handleStatus)
		}
	case run != nil && run.degraded:
		data["state"] = "degraded"
		if run.degradedCode != "" {
			data["errorCode"] = run.degradedCode
		}
	default:
		data["state"] = "none"
	}
	return agent.Event{Type: "world_context_state", Data: data}
}

// bindWritingSnapshot 把已构建的 Snapshot 绑定到指定 task scope（不重新读 World）。
func (s *WorldContextService) bindWritingSnapshot(scopeKey string, snap *worldcontext.Snapshot) (*worldcontext.RunContext, error) {
	rc, _, err := s.registry.Bind(worldcontext.BindInput{
		Consumer:  worldcontext.ConsumerWriting,
		ScopeKey:  scopeKey,
		Snapshot:  snap,
		UISummary: uiSummaryFromSnapshot(snap),
	})
	if err != nil {
		return nil, err
	}
	return rc, nil
}

// StartWritingTaskWithError 是写作任务的正式 app 入口（A1b 输入边界 + A2 bind-before-start）。
//
// 顺序冻结：准备运行环境 → newPendingTask（不起 goroutine）→ 解析 Ref/claim handle、
// bind/move/降级裁定 → 设置 activeTask → task.start 启动模型 goroutine。
// 模型 goroutine 绝不可能早于绑定裁定；bare 请求与既有 StartTaskWithError 逐结构一致。
func (a *App) StartWritingTaskWithError(ctx context.Context, in WritingTaskInput) (*Task, error) {
	return a.chat().StartWritingTaskWithError(ctx, in)
}

func (s *ChatAppService) StartWritingTaskWithError(ctx context.Context, in WritingTaskInput) (*Task, error) {
	runtime, req, err := s.prepareIDEChatRuntime(ctx, in.Request, true)
	if err != nil {
		return nil, err
	}

	// 1) 先分配 pending Task（仅 ID + 可取消上下文，不起 goroutine）。
	task := newPendingTask()

	// 1a) B2a 修正轮：单源裁定背景模式与系统提示组成（缺口②的唯一入口）。
	// plan.Composition 同时充当 runner 构建输入（Instruction()，模型实际系统提示）
	// 与 RunOptions.SystemPromptLog（计费量测/提示审计），保证二者逐字节一致。
	plan := planWritingBackground(&runtime.cfg, runtime.state, runtime.ideTeller, in)
	if plan.NoLegacyLore && len(in.Request.LoreReferences) > 0 {
		// 传输层已对 library/显式 none + lore_references 返回 400 background_source_conflict；
		// 此处为直连调用方的防御性拒绝（不静默丢弃，旧背景通道必须显式关闭）。
		task.discard()
		return nil, &libraryruntime.Error{
			Code:    libraryruntime.ErrInvalidRequest,
			Message: "library/显式 none 背景模式不能携带 lore_references（旧资料库引用通道已关闭）",
		}
	}

	// 1b) B2a bind-before-start：library 背景在 runner 构建/模型 goroutine 启动前完成
	// 绑定与初始装配；绑定期失败阻断启动，绝不静默降级。与 World 控制字段互斥。
	var libRun *writingLibraryRun
	if in.Library.Present() {
		if in.World.Present() {
			task.discard()
			return nil, &libraryruntime.Error{
				Code:    libraryruntime.ErrInvalidRequest,
				Message: "library_context 与 world_context/analysis_handle 互斥，不能同时提交背景控制字段",
			}
		}
		libRun, err = s.resolveWritingLibraryRun(ctx, task.ID(), in.Library)
		if err != nil {
			task.discard() // 从未启动，废弃半成品 Task，不产生模型回调。
			return nil, err
		}
	}

	// 2) runner：按 plan.Mode 构建（缺口①）。library 模式不挂载旧 lore 工具（§8.6 通道 2），
	// 改挂载持有本次绑定 Run 的库按需读取工具；显式 none 模式无任何背景读取工具；
	// 其余路径与基线逐字节一致（旧请求兼容）。
	var runner *adk.Runner
	switch plan.Mode {
	case agent.BackgroundModeLibrary:
		runner, err = buildAgentRunnerWithLibrary(ctx, &runtime.cfg, runtime.state, runtime.ideTeller, plan.Composition.Instruction(), libRun.run)
	case agent.BackgroundModeNone:
		runner, err = buildAgentRunnerWithNoBackground(ctx, &runtime.cfg, plan.Composition.Instruction())
	default:
		runner, err = buildAgentRunner(ctx, &runtime.cfg, runtime.state, runtime.ideTeller)
	}
	if err != nil {
		log.Printf("[agent-task] 刷新 Agent Runner 失败 workspace=%s err=%v", runtime.workspace, err)
		releaseWritingLibraryRun(libRun, false)
		task.discard()
		return nil, err
	}
	a := s.app
	a.mu.Lock()
	if a.workspace == runtime.workspace {
		a.agentRunner = runner
	}
	a.mu.Unlock()

	// 3) bind-before-start：所有 Ref/handle 副作用在模型启动前完成裁定。
	// sessionKey 由服务端按当前工作区+活跃会话派生，用于校验 handle 归属，禁止采信客户端字段。
	worldSvc := a.worldContext()
	sessionKey := writingSessionKey(runtime.workspace, runtime.sess.ID)
	worldRun, err := worldSvc.resolveWritingRun(ctx, task.ID(), sessionKey, in.World)
	if err != nil {
		releaseWritingLibraryRun(libRun, false)
		task.discard() // 从未启动，废弃半成品 Task，不产生模型回调。
		return nil, err
	}

	// 3) 运行结束（成功/失败/取消）只释放一次 task scope 运行引用；World 不写。
	var releaseOnce sync.Once
	releaseWorldRun := func() {
		releaseOnce.Do(func() {
			// degraded 占位结果没有真正绑定 runContext，无需也不能 Destroy 一个不存在的 scope。
			if worldRun != nil && worldRun.runContext != nil {
				worldSvc.ReleaseWorldRun(worldcontext.ConsumerWriting, worldRun.scopeKey)
			}
		})
	}

	runFunc := func(ctx context.Context, task *Task, emit func(agent.Event)) {
		defer releaseWorldRun()
		// 运行结束（成功/失败/取消）幂等释放库绑定：中止 → Cancel，其余 → Complete。
		defer func() {
			releaseWritingLibraryRun(libRun, ctx.Err() != nil)
		}()
		// A6/B2a：模型内容前恰好下发一次背景状态事件；library 与 world 由传输层互斥，
		// 各模式只发自己的一次性状态（active/none），均为纯派生、不含正文/内部 ID。
		if libRun != nil {
			emit(writingLibraryContextStateEvent(libRun))
		} else {
			emit(writingWorldContextStateEvent(worldRun))
		}
		if worldRun != nil && worldRun.hasHandle {
			log.Printf("[agent-task] world context handle status id=%s status=%s", task.ID(), string(worldRun.handleStatus))
		}
		if libRun != nil {
			st := libRun.run.Status()
			log.Printf("[agent-task] library context bound id=%s library_id=%s revision=%s manual=%d", task.ID(), st.LibraryID, st.Revision, st.ManualCount)
		}
		log.Printf("[agent-task] run begin id=%s message_len=%d references=%d lore_references=%d style_scenes=%d style_rules=%d selections=%d plan_mode=%v teller_id=%s writing_skill=%s", task.ID(), len(req.Message), len(req.References), len(req.LoreReferences), len(req.StyleScenes), len(req.StyleRules), len(req.Selections), req.PlanMode, req.TellerID, req.WritingSkill)
		// B2a 修正轮（通道 ②）：library/显式 none 模式稳定上下文排除旧 lore 片段，
		// 不与库背景/无背景叠加；legacy（缺省/显式 legacy）保持原取法（旧请求兼容）。
		var runtimeContexts agent.IDEWorkspaceRuntimeContexts
		if plan.NoLegacyLore {
			runtimeContexts = agent.IDEWorkspaceRuntimeContextsForRequestExcludingLore(runtime.state, req)
		} else {
			runtimeContexts = agent.IDEWorkspaceRuntimeContextsForRequest(runtime.state, req)
		}
		conversation := agent.NewSessionConversationForAgentWithRuntimeContexts(
			runtime.sess,
			&runtime.cfg,
			config.AgentKindIDE,
			runtimeContexts.StableTitle,
			runtimeContexts.Stable,
			runtimeContexts.DynamicTitle,
			runtimeContexts.Dynamic,
		)
		var onUserMessageCommitted func(context.Context) error
		if !req.ResolvedReviewFeedback.Empty() {
			onUserMessageCommitted = func(ctx context.Context) error {
				return s.consumeResolvedReviewFeedback(ctx, runtime, req)
			}
		}
		// A3：用绑定 runContext 的最终 ModelView bytes 装配临时只读世界背景；bare（worldRun==nil）
		// 传零值，模型输入与基线逐结构一致。该输入只在本次 Run 调用栈，绝不进 Session/压缩/ledger。
		var ephemeralWorld agent.EphemeralWorldContextInput
		if worldRun != nil {
			ephemeralWorld = agent.NewEphemeralWorldContextInput(worldRun.runContext.ModelViewBytes())
		}
		// B2a：library 模式用绑定期装配的临时库背景（冻结抬头+ModelView JSON），
		// 同一栈内生命周期约束；并把绑定 Run 交给运行层做模型送入前的预算计量。
		var ephemeralLibrary agent.EphemeralLibraryContextInput
		var libraryRuntimeRun *libraryruntime.Run
		if libRun != nil {
			ephemeralLibrary = agent.NewEphemeralLibraryContextInput(libRun.ephemeral.LeadingText())
			libraryRuntimeRun = libRun.run
		}
		runtime.chatService.RunWithOptions(ctx, runner, conversation, runtime.bookService, req, agent.RunOptions{
			AgentKind:          agent.AgentKindIDE,
			TaskID:             task.ID(),
			SessionID:          runtime.sess.ID,
			ReviewThreadID:     req.ResolvedReviewFeedback.PrimaryReviewThreadID(),
			Workspace:          runtime.workspace,
			Mode:               "ide",
			IdleTimeout:        agentIdleTimeout(runtime.cfg),
			ToolResultMaxBytes: agentToolResultMaxBytes(runtime.cfg),
			// B2a 修正轮（缺口②）：计费/审计使用实际送模的系统提示——与 runner 构建
			// 消费同一个 plan.Composition（单源），不再传默认 composition。
			SystemPromptLog:    plan.Composition,
			OnMutationsVerified: a.verifiedWorkspaceMutationCallback(
				"ide_agent_post_run",
				runtime.versionService,
				versionAutoSettingsForConfig(&runtime.cfg),
			),
			OnUserMessageCommitted: onUserMessageCommitted,
			EphemeralWorldContext:  ephemeralWorld,
			// library 模式专用：二者与 EphemeralWorldContext 由传输层互斥，同一运行
			// 至多一组背景输入。
			EphemeralLibraryContext: ephemeralLibrary,
			LibraryRuntimeRun:       libraryRuntimeRun,
		}, emit)
		log.Printf("[agent-task] run end id=%s status=%s", task.ID(), task.Status())
	}

	// 4) 设置 activeTask 后才允许 start；start 失败必须回滚绑定并清空 activeTask。
	a.mu.Lock()
	a.activeTask = task
	a.mu.Unlock()

	if !task.start(runFunc) {
		releaseWorldRun()
		releaseWritingLibraryRun(libRun, false)
		a.mu.Lock()
		if a.activeTask == task {
			a.activeTask = nil
		}
		a.mu.Unlock()
		return nil, context.Canceled
	}

	return task, nil
}
