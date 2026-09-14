package app

import (
	"context"

	"denova/internal/agent"
	"denova/internal/worldcontext"
)

// Phase 3.2-A1b：写作运行的正式输入边界。
//
// 冻结约束：
//   - agent.ChatRequest 只承载既有聊天业务字段，绝不塞入 worldcontext 运行字段；
//   - World 控制信息（Ref / analysis handle）经独立的 WritingWorldControl 显式传递；
//   - consumer 由写作路由固定为 writing，客户端提交的 consumer/scope/runContextId
//         已在 HTTP 传输层被拒绝，这里不读取、不信任。
//
// A1b 只建立输入契约；bind-before-start（pending Task → 解析 Ref/claim handle →
// bind/move/降级 → start）在 A2 于本文件内接入，此处不静默丢弃控制字段。

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

// WritingTaskInput 是写作后台任务的完整 app 层输入：业务请求 + World 控制信息分离。
type WritingTaskInput struct {
	Request agent.ChatRequest
	World   WritingWorldControl
}

// StartWritingTaskWithError 是写作任务的正式 app 入口（A1b 输入边界）。
//
// A1b 阶段仅建立 handler → app 的显式输入类型，并保持既有运行路径逐结构不变；
// World 控制字段的 bind-before-start 在 A2 原子接入，不经过 agent.ChatRequest。
func (a *App) StartWritingTaskWithError(ctx context.Context, in WritingTaskInput) (*Task, error) {
	return a.chat().StartWritingTaskWithError(ctx, in)
}

func (s *ChatAppService) StartWritingTaskWithError(ctx context.Context, in WritingTaskInput) (*Task, error) {
	// A1b：World 控制字段已通过显式输入类型到达 app 边界；运行时绑定在 A2 接入。
	// 此阶段保持与 StartTaskWithError 完全一致的业务准备与启动语义。
	return s.StartTaskWithError(ctx, in.Request)
}
