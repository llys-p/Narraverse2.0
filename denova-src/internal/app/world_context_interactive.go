package app

import (
	"context"
	"log/slog"

	"denova/internal/agent"
	"denova/internal/worldcontext"
)

// Phase 3.2-B1：游戏运行的 World Context 输入边界（传输层 DTO 已在 handlers 层解码）。
// Phase 3.2-B2：InteractiveRun 运行闭环——Ref 绑定到 Run scope、注入模型临时输入、
// 发送 world_context_state SSE 事件。

// InteractiveWorldControl 是一次游戏请求携带的 World Context 控制信息（handler-owned）。
type InteractiveWorldControl struct {
	// Ref 为 nil 表示请求未携带 world_context（bare 游戏回合）。
	Ref *worldcontext.Ref
	// HasAnalysisHandle 表示是否携带非空 analysis_handle（"" 与 null 视为未携带）。
	HasAnalysisHandle bool
	// AnalysisHandle 是规范化后的不透明 token；不是 Task、runContext，也不持久化。
	AnalysisHandle string
}

// Present 报告是否携带任一 World Context 控制字段。
func (c InteractiveWorldControl) Present() bool {
	return c.Ref != nil || c.HasAnalysisHandle
}

// InteractiveTaskInput 是游戏后台任务的完整 app 层输入：业务参数 + World 控制信息分离。
type InteractiveTaskInput struct {
	StoryID      string
	BranchID     string
	Message      string
	StyleScenes  []string
	Locale       string
	RewindTurnID string // 空表示新回合，非空表示 regenerate
	World        InteractiveWorldControl
}

// interactiveWorldRun 是一次游戏 Task bind-before-start 的运行时结果（瞬态，不持久化）。
type interactiveWorldRun struct {
	runContext   *worldcontext.RunContext
	scopeKey     string
	degraded     bool
	degradedCode string
}

// resolveInteractiveRun 完成游戏新回合的 bind-before-start 绑定。
// 返回 nil 表示本次为 bare 游戏（Registry 零增量）。
// regenerate 路径不调用此方法——通过 reuseInteractiveRunContext 复用已绑定的 context。
func (s *WorldContextService) resolveInteractiveRun(
	ctx context.Context,
	binding interactiveTaskRunBinding,
	world InteractiveWorldControl,
) (*interactiveWorldRun, error) {
	if s == nil || s.interactiveRuns == nil || !world.Present() {
		return nil, nil
	}
	consumer := worldcontext.ConsumerGame

	record, ok := s.interactiveRuns.snapshot(binding.runID)
	if !ok {
		return nil, nil
	}
	scopeKey := record.scopeKey

	// Ref 优先：读取已保存 World 构建 Snapshot 并 Bind 到 Run scope。
	if world.Ref != nil {
		rc, _, err := s.BindWorldRun(ctx, consumer, scopeKey, *world.Ref)
		if err != nil {
			if isBlockingWorldContextError(err) {
				return nil, err
			}
			code := string(worldcontext.CodeOf(err))
			slog.Warn("world_context game ref degraded to bare",
				"consumer", string(consumer), "code", code)
			return &interactiveWorldRun{scopeKey: scopeKey, degraded: true, degradedCode: code}, nil
		}
		// 把 runContext 引用绑定到 InteractiveRun（供后续 regenerate Reuse）。
		if bindErr := s.interactiveRuns.bindContext(binding.runID, rc.ID(), scopeKey); bindErr != nil {
			slog.Warn("world_context game bindContext failed",
				"run_id", string(binding.runID), "err", bindErr)
		}
		return &interactiveWorldRun{runContext: rc, scopeKey: scopeKey}, nil
	}

	// 仅 handle：B2 暂不实现 claim/move（B3 前端完整交接时接入）。
	// 客户端携带了 handle 但无 Ref，按 degraded 处理。
	if world.HasAnalysisHandle {
		slog.Warn("world_context game handle present without ref; ignored in B2",
			"consumer", string(consumer))
		return &interactiveWorldRun{scopeKey: scopeKey, degraded: true, degradedCode: "handle_not_supported"}, nil
	}

	return nil, nil
}

// reuseInteractiveRunContext 在 regenerate 路径上复用已绑定到 InteractiveRun 的 runContext。
// 返回 nil 表示该 Run 没有已绑定的 World 背景（bare regenerate）。
func (s *WorldContextService) reuseInteractiveRunContext(binding interactiveTaskRunBinding) *worldcontext.RunContext {
	if s == nil || s.interactiveRuns == nil || !binding.tracked {
		return nil
	}
	record, ok := s.interactiveRuns.snapshot(binding.runID)
	if !ok || record.runContextID == "" {
		return nil
	}
	rc, err := s.registry.Reuse(worldcontext.ConsumerGame, record.scopeKey, "")
	if err != nil {
		slog.Warn("world_context game regenerate reuse failed",
			"run_id", string(binding.runID), "err", err)
		return nil
	}
	return rc
}

// interactiveWorldContextStateEvent 在模型内容前发送一次 world_context_state 事件。
// active：已绑定背景；degraded：客户端请求了背景但降级；none：本次无世界背景。
func interactiveWorldContextStateEvent(run *interactiveWorldRun) agent.Event {
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

// interactiveEphemeralWorldInput builds the read-only ephemeral world context for
// model input from a resolved runContext. Returns zero value for bare runs.
// The bytes are NEVER persisted to Turn, ActorState, DirectorPlan, or World.
func interactiveEphemeralWorldInput(run *interactiveWorldRun) agent.EphemeralWorldContextInput {
	if run == nil || run.runContext == nil {
		return agent.EphemeralWorldContextInput{}
	}
	return agent.NewEphemeralWorldContextInput(run.runContext.ModelViewBytes())
}
