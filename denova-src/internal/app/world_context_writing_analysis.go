package app

import (
	"context"
	"log/slog"
	"time"

	"denova/internal/agent"
	"denova/internal/worldcontext"
)

// Phase 3.2-A4：写作 context-analysis → analysisHandle 闭环。
//
// 冻结约束：
//   - context-analysis 只提交 Ref；服务端按当前工作区+会话派生 sessionKey，建立/幂等复用
//     pending runContext 并签发短期 analysisHandle，不启动模型或 Task；
//   - 分析展示的 world_context part 必须读取该 pending runContext 的最终 ModelView bytes，
//     与首次 chat 迁移（MoveScopeByID，不重投影/不换 salt）后送模的 bytes 逐字节同源；
//   - 普通无 Ref 分析不创建 handle/runContext；
//   - handle、Snapshot、ModelView 只在进程内，不进入 Session、任务记录、导出或日志正文。

// WritingWorldContextStatus 是 context-analysis 返回上层的最小世界背景状态（不含内部 ID/正文）。
type WritingWorldContextStatus struct {
	// State 仅取 bound（已建立 pending 背景）/ degraded（可降级失败，仍返回普通分析）。
	State         string
	WorldName     string
	RevisionLabel string
	SelectedCount int
	ErrorCode     string
}

// WritingContextAnalysis 是写作 context-analysis 的 app 结果：
// 原有上下文分析 + 可选 pending handle + 世界背景状态。
type WritingContextAnalysis struct {
	Analysis        agent.ContextAnalysis
	AnalysisHandle  string
	HandleExpiresAt time.Time
	// World 为 nil 表示本次为无世界背景的普通分析（不创建 handle）。
	World *WritingWorldContextStatus
}

// AnalyzeWritingContext 建立/复用 pending 世界背景、签发 handle，并用同一 pending runContext 的
// ModelView bytes 装配 context-analysis 展示。World 只读，不启动模型、不写任何持久化。
func (s *ChatAppService) AnalyzeWritingContext(
	ctx context.Context,
	req agent.ChatRequest,
	ref *worldcontext.Ref,
) (WritingContextAnalysis, error) {
	runtime, req, err := s.prepareIDEChatRuntime(ctx, req, false)
	if err != nil {
		return WritingContextAnalysis{}, err
	}

	result := WritingContextAnalysis{}
	ephemeral := agent.EphemeralWorldContextInput{}
	if ref != nil {
		// sessionKey 由服务端按当前工作区+活跃会话派生，禁止采信客户端自造 scope/sessionKey。
		sessionKey := writingSessionKey(runtime.workspace, runtime.sess.ID)
		view, pendingRun, handleErr := s.app.worldContext().createAnalysisHandleWithRun(
			ctx, worldcontext.ConsumerWriting, sessionKey, *ref,
		)
		switch {
		case handleErr == nil:
			// 展示与首次 chat 同源：直接读取 pending runContext 的最终 ModelView bytes。
			ephemeral = agent.NewEphemeralWorldContextInput(pendingRun.ModelViewBytes())
			summary := pendingRun.UISummary()
			result.AnalysisHandle = view.AnalysisHandle
			result.HandleExpiresAt = view.ExpiresAt
			result.World = &WritingWorldContextStatus{
				State:         "bound",
				WorldName:     summary.WorldName,
				RevisionLabel: summary.RevisionLabel,
				SelectedCount: summary.SelectedCount,
			}
		case isBlockingWorldContextError(handleErr):
			// 选择/修订/归档/可信消费者等阻断错误：直接返回，让用户修正后重试。
			return WritingContextAnalysis{}, handleErr
		default:
			// 可降级运行时错误：仍返回普通分析，但显式标 degraded（不是 none），且不签发 handle。
			code := string(worldcontext.CodeOf(handleErr))
			result.World = &WritingWorldContextStatus{State: "degraded", ErrorCode: code}
			slog.Warn("world_context writing analysis degraded",
				"consumer", string(worldcontext.ConsumerWriting), "code", code)
		}
	}

	analysis, err := s.buildContextAnalysis(runtime, req, ephemeral)
	if err != nil {
		return WritingContextAnalysis{}, err
	}
	result.Analysis = analysis
	return result, nil
}
