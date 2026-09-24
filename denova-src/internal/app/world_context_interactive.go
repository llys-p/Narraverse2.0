package app

import (
	"context"
	"log/slog"
	"strings"
	"time"

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

// InteractiveWorldContextStatus 是游戏 context-analysis 的脱敏世界状态。
type InteractiveWorldContextStatus struct {
	State         string
	WorldName     string
	RevisionLabel string
	SelectedCount int
	ErrorCode     string
}

// InteractiveContextAnalysis 保留旧分析响应的扁平字段，并只叠加短期 handle
// 与世界状态；不暴露 Snapshot、ModelView、Registry 或 InteractiveRun 身份。
type InteractiveContextAnalysis struct {
	agent.ContextAnalysis
	AnalysisHandle  string
	HandleExpiresAt time.Time
	World           *InteractiveWorldContextStatus
}

// Present 报告是否携带任一 World Context 控制字段。
func (c InteractiveWorldControl) Present() bool {
	return c.Ref != nil || c.HasAnalysisHandle
}

// interactiveWorldRun 是一次游戏 Task bind-before-start 的运行时结果（瞬态，不持久化）。
type interactiveWorldRun struct {
	runContext   *worldcontext.RunContext
	scopeKey     string
	hasHandle    bool
	handleStatus AnalysisHandleUseStatus
	degraded     bool
	degradedCode string
}

// interactiveSessionKey 由服务端按当前工作区、故事和分支派生 analysis handle
// 的归属键。客户端不能提交或覆盖它；切故事/分支自然进入另一条会话边界。
func interactiveSessionKey(workspace, storyID, branchID string) string {
	branchID = strings.TrimSpace(branchID)
	if branchID == "" {
		branchID = "main"
	}
	return "workspace:" + strings.TrimSpace(workspace) + "|story:" + strings.TrimSpace(storyID) + "|branch:" + branchID
}

// resolveInteractiveRun 完成游戏新回合的 bind-before-start 绑定。
// 返回 nil 表示本次为 bare 游戏（Registry 零增量）。
// regenerate 路径不调用此方法——通过 reuseInteractiveRunContext 复用已绑定的 context。
func (s *WorldContextService) resolveInteractiveRun(
	ctx context.Context,
	binding interactiveTaskRunBinding,
	world InteractiveWorldControl,
	sessionKey string,
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

	// Ref 优先：读取已保存 World 构建 Snapshot，并在同时提交 handle 时
	// 用 fingerprint 校验两者是否同源。Ref 与 handle 冲突时 Ref 可继续，
	// 但 handle 必须回滚并显式标记 ignored_conflict。
	var refSnapshot *worldcontext.Snapshot
	refFingerprint := ""
	if world.Ref != nil {
		snap, err := s.loadSnapshot(ctx, consumer, *world.Ref)
		if err != nil {
			if isBlockingWorldContextError(err) {
				return nil, err
			}
			code := string(worldcontext.CodeOf(err))
			slog.Warn("world_context game ref degraded to bare",
				"consumer", string(consumer), "code", code)
			// A valid analysis handle may still carry the already materialized
			// context. Do not discard it merely because a fresh Ref read is
			// temporarily unavailable; handle-only claim below remains authoritative.
			if !world.HasAnalysisHandle {
				return &interactiveWorldRun{scopeKey: scopeKey, degraded: true, degradedCode: code}, nil
			}
		}
		if snap != nil {
			refSnapshot = snap
			refFingerprint = snap.ContextFingerprint
		}
	}

	if world.HasAnalysisHandle {
		claim, claimStatus := s.claimAnalysisHandle(world.AnalysisHandle, consumer, sessionKey)
		if claim != nil && claimStatus == AnalysisHandleClaimed {
			lease := claim.pendingContextLease()
			moveFingerprint := lease.Fingerprint
			if refSnapshot != nil && moveFingerprint != refFingerprint {
				s.rollbackAnalysisClaim(claim)
				claim = nil
				claimStatus = AnalysisHandleIgnoredConflict
			} else {
				moved, moveErr := s.registry.MoveScopeByID(consumer, lease.RunContextID, lease.PendingScopeKey, scopeKey, moveFingerprint)
				if moveErr == nil {
					consumeStatus := s.consumeAnalysisHandle(claim)
					if bindErr := s.interactiveRuns.bindContext(binding.runID, moved.ID(), scopeKey); bindErr != nil {
						slog.Warn("world_context game bindContext failed", "run_id", string(binding.runID), "err", bindErr)
					}
					return &interactiveWorldRun{
						runContext:   moved,
						scopeKey:     scopeKey,
						hasHandle:    true,
						handleStatus: consumeStatus,
					}, nil
				}
				s.rollbackAnalysisClaim(claim)
				if refSnapshot == nil {
					if isBlockingWorldContextError(moveErr) {
						return nil, moveErr
					}
					return &interactiveWorldRun{scopeKey: scopeKey, degraded: true, degradedCode: string(worldcontext.CodeOf(moveErr))}, nil
				}
				claim = nil
				claimStatus = AnalysisHandleIgnoredConflict
			}
		}

		if refSnapshot != nil {
			rc, err := s.bindWorldSnapshot(scopeKey, refSnapshot)
			if err != nil {
				if isBlockingWorldContextError(err) {
					return nil, err
				}
				return &interactiveWorldRun{scopeKey: scopeKey, degraded: true, degradedCode: string(worldcontext.CodeOf(err))}, nil
			}
			return &interactiveWorldRun{runContext: rc, scopeKey: scopeKey, hasHandle: true, handleStatus: claimStatus}, nil
		}

		// 失效 handle 不恢复背景；这是显式的 bare 结果，不伪装成 active/degraded。
		return nil, nil
	}

	if refSnapshot == nil {
		return nil, nil
	}
	rc, err := s.bindWorldSnapshot(scopeKey, refSnapshot)
	if err != nil {
		if isBlockingWorldContextError(err) {
			return nil, err
		}
		return &interactiveWorldRun{scopeKey: scopeKey, degraded: true, degradedCode: string(worldcontext.CodeOf(err))}, nil
	}
	if bindErr := s.interactiveRuns.bindContext(binding.runID, rc.ID(), scopeKey); bindErr != nil {
		slog.Warn("world_context game bindContext failed", "run_id", string(binding.runID), "err", bindErr)
	}
	return &interactiveWorldRun{runContext: rc, scopeKey: scopeKey}, nil
}

func (s *WorldContextService) bindWorldSnapshot(scopeKey string, snap *worldcontext.Snapshot) (*worldcontext.RunContext, error) {
	rc, _, err := s.registry.Bind(worldcontext.BindInput{
		Consumer:  worldcontext.ConsumerGame,
		ScopeKey:  scopeKey,
		Snapshot:  snap,
		UISummary: uiSummaryFromSnapshot(snap),
	})
	return rc, err
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

// interactiveWorldContextErrorEvent 把阻断性 World 错误转换成稳定、脱敏的 SSE
// error 事件。不得把本机路径、World 正文或内部运行身份放进客户端消息。
func interactiveWorldContextErrorEvent(err error) agent.Event {
	code := string(worldcontext.CodeOf(err))
	if code == "" {
		code = string(worldcontext.ErrContextUnavailable)
	}
	return agent.Event{Type: "error", Data: map[string]string{
		"code":    code,
		"message": "世界背景无法加载，请修正当前选择后重试",
	}}
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
