package handlers

import (
	"time"

	"denova/internal/agent"
	novaApp "denova/internal/app"
)

// Phase 3.2-A4/A6：世界背景对外 wire 契约（handler-owned）。
// 只暴露稳定状态与脱敏摘要，禁止下发 runContextId/scopeKey/fingerprint/sourceRef/handle 元数据。

// worldContextStateWire 对应冻结的 WorldContextRunStatus（§6.2）。
type worldContextStateWire struct {
	State         string `json:"state"`
	WorldName     string `json:"worldName,omitempty"`
	RevisionLabel string `json:"revisionLabel,omitempty"`
	SelectedCount int    `json:"selectedCount,omitempty"`
	ErrorCode     string `json:"errorCode,omitempty"`
}

// writingContextAnalysisWire 在原 context-analysis 响应上叠加世界背景状态与短期 handle。
// 只有成功建立 pending context 时才携带 analysis_handle / expires_at。
type writingContextAnalysisWire struct {
	agent.ContextAnalysis
	WorldContext            *worldContextStateWire `json:"world_context,omitempty"`
	AnalysisHandle          string                 `json:"analysis_handle,omitempty"`
	AnalysisHandleExpiresAt *time.Time             `json:"analysis_handle_expires_at,omitempty"`
}

func toWorldContextStateWire(s *novaApp.WritingWorldContextStatus) *worldContextStateWire {
	if s == nil {
		return nil
	}
	return &worldContextStateWire{
		State:         s.State,
		WorldName:     s.WorldName,
		RevisionLabel: s.RevisionLabel,
		SelectedCount: s.SelectedCount,
		ErrorCode:     s.ErrorCode,
	}
}

func toWritingContextAnalysisWire(result novaApp.WritingContextAnalysis) writingContextAnalysisWire {
	wire := writingContextAnalysisWire{
		ContextAnalysis: result.Analysis,
		WorldContext:    toWorldContextStateWire(result.World),
	}
	if result.AnalysisHandle != "" {
		expiresAt := result.HandleExpiresAt
		wire.AnalysisHandle = result.AnalysisHandle
		wire.AnalysisHandleExpiresAt = &expiresAt
	}
	return wire
}
