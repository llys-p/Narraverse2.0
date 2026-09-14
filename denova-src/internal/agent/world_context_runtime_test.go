package agent

import (
	"strings"
	"testing"

	"github.com/cloudwego/eino/schema"

	"denova/config"
	"denova/internal/session"
)

func TestEphemeralWorldContext_NeverPersistedToSession(t *testing.T) {
	dir := t.TempDir()
	store, err := session.NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	sess, err := store.GetOrCreate("s1")
	if err != nil {
		t.Fatal(err)
	}
	if err := sess.Append(schema.UserMessage("持久用户消息")); err != nil {
		t.Fatal(err)
	}
	conversation := NewSessionConversation(sess)
	history, err := conversation.PrepareMessages("本轮消息", "")
	if err != nil {
		t.Fatal(err)
	}

	const worldMarker = "隐世世界标记XYZ"
	e := NewEphemeralWorldContextInput([]byte(`{"identity":{"name":"` + worldMarker + `"}}`))
	modelHistory := ModelInputMessages(history, e)
	if len(modelHistory) != len(history)+1 || !strings.Contains(modelHistory[0].Content, worldMarker) {
		t.Fatalf("model input must lead with world background: %#v", modelHistory)
	}

	// PrepareMessages 提交进 Session 的持久 history 不含世界背景。
	for _, m := range history {
		if strings.Contains(m.Content, worldMarker) || strings.Contains(m.Content, ephemeralWorldContextHeader) {
			t.Fatalf("persisted PrepareMessages history must not contain world: %#v", m)
		}
	}
	for _, m := range sess.GetEffectiveMessages() {
		if strings.Contains(m.Content, worldMarker) {
			t.Fatalf("session effective messages must not contain world: %#v", m)
		}
	}

	// 重新从磁盘打开同一 Session，落盘内容同样不含世界背景。
	store2, err := session.NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	sess2, err := store2.GetOrCreate("s1")
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range sess2.GetEffectiveMessages() {
		if strings.Contains(m.Content, worldMarker) || strings.Contains(m.Content, ephemeralWorldContextHeader) {
			t.Fatalf("world background leaked to disk: %#v", m)
		}
	}
}

func TestEphemeralWorldContext_ZeroIsBare(t *testing.T) {
	history := []*schema.Message{schema.UserMessage("u1"), schema.AssistantMessage("a1", nil)}
	for _, in := range [][]byte{nil, {}} {
		e := NewEphemeralWorldContextInput(in)
		if e.Present() {
			t.Fatalf("empty bytes must not be present: %q", in)
		}
		if e.LeadingContent() != "" || e.EstimatedTokens() != 0 || e.ModelViewByteLen() != 0 {
			t.Fatalf("zero ephemeral input must stay empty: %#v", e)
		}
		got := ModelInputMessages(history, e)
		// bare 路径必须逐结构返回原 history 切片（同一底层切片）。
		if len(got) != len(history) || &got[0] != &history[0] {
			t.Fatalf("bare path must return the original history slice, got %#v", got)
		}
	}
	var zero EphemeralWorldContextInput
	if got := ModelInputMessages(history, zero); &got[0] != &history[0] {
		t.Fatalf("zero-value ephemeral must be structurally identical to baseline")
	}
}

func TestEphemeralWorldContext_PrependIsolatedAndDeterministic(t *testing.T) {
	mv := []byte(`{"identity":{"name":"测试世界"},"setting":{"tone":"冷系"}}`)
	e := NewEphemeralWorldContextInput(mv)
	wantContent := ephemeralWorldContextHeader + string(mv)
	if !e.Present() {
		t.Fatal("non-empty bytes must be present")
	}
	if e.LeadingContent() != wantContent {
		t.Fatalf("leading content mismatch:\n got=%q\nwant=%q", e.LeadingContent(), wantContent)
	}
	// 固定三行英文抬头。
	if !strings.HasPrefix(e.LeadingContent(), "[World Background · Read Only]\n") ||
		!strings.Contains(e.LeadingContent(), "must not be written back automatically.\n") {
		t.Fatalf("frozen header violated: %q", e.LeadingContent())
	}
	if e.ModelViewByteLen() != len(mv) {
		t.Fatalf("model view bytes = %d, want %d", e.ModelViewByteLen(), len(mv))
	}

	u1 := schema.UserMessage("history-1")
	a1 := schema.AssistantMessage("history-2", nil)
	history := []*schema.Message{u1, a1}
	out := ModelInputMessages(history, e)
	if len(out) != 3 {
		t.Fatalf("model input len = %d, want 3", len(out))
	}
	if out[0].Role != schema.User || out[0].Content != wantContent {
		t.Fatalf("leading world message mismatch: %#v", out[0])
	}
	if out[1] != u1 || out[2] != a1 {
		t.Fatal("history tail must keep identical message pointers/order")
	}
	if len(history) != 2 {
		t.Fatalf("persisted history must not be mutated, len=%d", len(history))
	}

	// 两次装配逐字节一致（模型输入与 context-analysis 走同一构造函数）。
	out2 := ModelInputMessages(history, e)
	if out2[0].Content != out[0].Content {
		t.Fatal("same bytes must assemble deterministically")
	}
	// 每次返回独立的抬头消息：改写其一不影响其它（无共享指针）。
	out[0].Content = "MUTATED"
	if out2[0].Content != wantContent {
		t.Fatal("leading message must be copied per assembly, not shared")
	}

	// 构造后改写源字节不影响已构建内容（防御性拷贝）。
	mv[0] = 'Z'
	if !strings.Contains(e.LeadingContent(), `"identity"`) || strings.Contains(e.LeadingContent(), "Zidentity") {
		t.Fatal("constructor must defensively copy model view bytes")
	}
}

func TestEphemeralWorldContext_EstimatedTokens(t *testing.T) {
	e := NewEphemeralWorldContextInput([]byte(`{"a":"bbbb"}`))
	want := EstimateContextTokens([]*schema.Message{{Role: schema.User, Content: e.LeadingContent()}}, nil)
	if e.EstimatedTokens() <= 0 || e.EstimatedTokens() != want {
		t.Fatalf("estimated tokens = %d, want %d", e.EstimatedTokens(), want)
	}
}

func TestEphemeralWorldContext_CompactionBudgetCountsButSourceExcludes(t *testing.T) {
	history := []*schema.Message{schema.UserMessage("剧情历史 A")}
	base := projectedContextTokens(100, ContextCompactionInput{Messages: history})
	withWorld := projectedContextTokens(100, ContextCompactionInput{
		Messages:                     history,
		ReservedEphemeralWorldTokens: 40,
	})
	if withWorld != base+40 {
		t.Fatalf("projected tokens must reserve ephemeral world tokens: base=%d with=%d", base, withWorld)
	}
	// 世界背景只贡献预算，绝不进入压缩 source。
	input := ContextCompactionInput{Messages: history, ReservedEphemeralWorldTokens: 40}
	source := compactionSourceBaseMessages(input)
	if len(source) != len(history) {
		t.Fatalf("compaction source must only contain plot history, got %d messages", len(source))
	}
	for _, m := range source {
		if strings.Contains(m.Content, ephemeralWorldContextHeader) {
			t.Fatal("world background must never enter compaction source")
		}
	}
}

func TestEphemeralWorldContext_AnalysisUsesSameBytes(t *testing.T) {
	mv := []byte(`{"identity":{"name":"测试世界"},"setting":{"tone":"冷系"}}`)
	e := NewEphemeralWorldContextInput(mv)
	eff := []*schema.Message{schema.UserMessage("历史消息")}

	analysis, err := BuildIDEContextAnalysis(
		&config.Config{}, nil, IDEStoryTeller{}, nil, eff, 1, nil, nil,
		ChatRequest{Message: "继续"}, e,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(analysis.ContextMessages) == 0 {
		t.Fatal("expected context messages")
	}
	first := analysis.ContextMessages[0]
	if first.Kind != "world_context" || first.ID != "world_context" {
		t.Fatalf("first part must be world_context, got %#v", first)
	}
	// 展示文本与真正注入模型的抬头逐字节一致，且包含最终 ModelView JSON。
	if first.Content != e.LeadingContent() || !strings.Contains(first.Content, string(mv)) {
		t.Fatalf("analysis world part must share exact bytes with model input: %#v", first)
	}

	bare, err := BuildIDEContextAnalysis(
		&config.Config{}, nil, IDEStoryTeller{}, nil, eff, 1, nil, nil,
		ChatRequest{Message: "继续"}, EphemeralWorldContextInput{},
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range bare.ContextMessages {
		if p.Kind == "world_context" {
			t.Fatal("bare analysis must not contain world_context part")
		}
	}
	// 携带世界背景时预算估算必须更大（计入临时输入）。
	if analysis.TokenEstimate <= bare.TokenEstimate {
		t.Fatalf("token estimate must include ephemeral world: with=%d bare=%d", analysis.TokenEstimate, bare.TokenEstimate)
	}
}
