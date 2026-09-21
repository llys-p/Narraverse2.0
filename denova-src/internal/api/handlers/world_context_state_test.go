package handlers

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"denova/internal/agent"
	novaApp "denova/internal/app"
)

// A4：context-analysis wire 只暴露稳定状态/脱敏摘要与短期 handle，不泄漏内部运行字段。
func TestToWritingContextAnalysisWire_BoundCarriesHandle(t *testing.T) {
	expires := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	result := novaApp.WritingContextAnalysis{
		Analysis:        agent.ContextAnalysis{},
		AnalysisHandle:  "h-token-123",
		HandleExpiresAt: expires,
		World: &novaApp.WritingWorldContextStatus{
			State:         "bound",
			WorldName:     "测试世界",
			RevisionLabel: "r1",
			SelectedCount: 3,
		},
	}
	wire := toWritingContextAnalysisWire(result)
	if wire.AnalysisHandle != "h-token-123" || wire.AnalysisHandleExpiresAt == nil || !wire.AnalysisHandleExpiresAt.Equal(expires) {
		t.Fatalf("bound 必须携带 handle 与 expires_at: %#v", wire)
	}
	if wire.WorldContext == nil || wire.WorldContext.State != "bound" || wire.WorldContext.WorldName != "测试世界" {
		t.Fatalf("world_context 状态异常: %#v", wire.WorldContext)
	}
	raw, err := json.Marshal(wire)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	body := string(raw)
	for _, leaked := range []string{"runContextId", "scopeKey", "fingerprint", "sourceRef", "runSalt", "pendingScopeKey"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("wire 不得泄漏内部字段 %q: %s", leaked, body)
		}
	}
}

func TestToWritingContextAnalysisWire_BareOmitsHandle(t *testing.T) {
	wire := toWritingContextAnalysisWire(novaApp.WritingContextAnalysis{Analysis: agent.ContextAnalysis{}})
	if wire.AnalysisHandle != "" || wire.AnalysisHandleExpiresAt != nil {
		t.Fatalf("无世界背景分析不得携带 handle: %#v", wire)
	}
	if wire.WorldContext != nil {
		t.Fatalf("无世界背景分析不得携带 world_context: %#v", wire.WorldContext)
	}
}

func TestToWritingContextAnalysisWire_DegradedCarriesCode(t *testing.T) {
	wire := toWritingContextAnalysisWire(novaApp.WritingContextAnalysis{
		Analysis: agent.ContextAnalysis{},
		World:    &novaApp.WritingWorldContextStatus{State: "degraded", ErrorCode: "world_unavailable"},
	})
	if wire.WorldContext == nil || wire.WorldContext.State != "degraded" || wire.WorldContext.ErrorCode != "world_unavailable" {
		t.Fatalf("degraded 必须携带错误码: %#v", wire.WorldContext)
	}
	if wire.AnalysisHandle != "" {
		t.Fatal("degraded 不得签发 handle")
	}
}
