package app

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"denova/config"
	"denova/internal/library"
	"denova/internal/libraryruntime"
	"denova/internal/worldcontext"
)

// B4a（L3.3 叙界）：受控 iframe 库载体的宿主层验证——绑定期装配、每次调用前置
// 临时背景并计费、状态 DTO 脱敏、换绑/解绑/撤销/过期幂等释放、绑定期失败显式阻断。

func newHostLibraryTestService(t *testing.T) (*WorldContextHostService, library.Library, string, string, *time.Time) {
	t.Helper()
	cfg := &config.Config{}
	cfg.SetDataDir(t.TempDir())
	a := &App{cfg: cfg}
	ctx := context.Background()
	l, _, err := a.CreateWorkLibrary(ctx, library.CreateInput{Name: "叙界集成库"})
	if err != nil {
		t.Fatalf("准备库失败: %v", err)
	}
	strPtr := func(s string) *string { return &s }
	for _, item := range []library.ItemInput{
		{ID: "res-1", Name: "常驻一", Type: "character", Origin: "original", LoadMode: "resident", Content: strPtr("HOSTLIB-RES-01 常驻正文")},
		{ID: "auto-1", Name: "自动一", Type: "character", Origin: "original", LoadMode: "auto", Content: strPtr("HOSTLIB-AUTO-01 自动正文")},
		{ID: "manual-1", Name: "手动一", Type: "character", Origin: "original", LoadMode: "manual", Content: strPtr("HOSTLIB-MAN-01 手动正文")},
	} {
		if _, _, err := a.CreateWorkLibraryItem(ctx, l.ID, item); err != nil {
			t.Fatalf("准备条目失败: %v", err)
		}
	}
	_, revision, err := a.GetWorkLibrary(ctx, l.ID)
	if err != nil {
		t.Fatalf("读取库版本失败: %v", err)
	}
	worldSvc := newWorldContextService(a)
	now := time.Date(2026, 9, 25, 8, 0, 0, 0, time.UTC)
	host := newWorldContextHostService(a, worldSvc)
	host.now = func() time.Time { return now }
	libraryPath := filepath.Join(a.cfg.DataDir(), "libraries", "library-"+l.ID+".json")
	return host, l, revision, libraryPath, &now
}

func hostLibraryControl(l library.Library, revision string, manual []string) HostFrameLibraryControl {
	return HostFrameLibraryControl{LibraryID: l.ID, ExpectedRevision: revision, ManualItemIDs: manual}
}

func hostBindingForTest(t *testing.T, host *WorldContextHostService, token string, consumer worldcontext.Consumer, frame string) *hostFrameBinding {
	t.Helper()
	hash := sha256.Sum256([]byte(token))
	host.mu.Lock()
	defer host.mu.Unlock()
	session := host.sessions[hash]
	if session == nil {
		t.Fatal("host session missing")
	}
	return session.bindings[hostBindingKey(consumer, frame)]
}

func TestWorldContextHost_LibraryBindCallInjectsEphemeralAndStaysReadOnly(t *testing.T) {
	var upstream [][]ModelGatewayMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Messages []ModelGatewayMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode upstream: %v", err)
		}
		upstream = append(upstream, payload.Messages)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"generated"}}]}`))
	}))
	defer server.Close()

	host, l, revision, libraryPath, _ := newHostLibraryTestService(t)
	host.app.cfg.OpenAIAPIKey = "test-key"
	host.app.cfg.OpenAIBaseURL = server.URL
	host.app.cfg.OpenAIModel = "test-model"
	before, err := os.ReadFile(libraryPath)
	if err != nil {
		t.Fatal(err)
	}
	token := hostSessionForTest(t, host)
	frame := "frame_abcdefghijklmnop"

	state, err := host.bindLibrary(context.Background(), token, worldcontext.ConsumerNarraverse, frame, hostLibraryControl(l, revision, []string{"manual-1"}))
	if err != nil || state.State != "active" || state.LibraryName != l.Name {
		t.Fatalf("library bind state=%+v err=%v", state, err)
	}
	// 状态 DTO 只带脱敏摘要：绝不含库 ID/revision/运行秘密/条目 ID。
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{l.ID, revision, token, "manual-1", "scopeKey"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("host state leaked %q: %s", forbidden, encoded)
		}
	}

	result, callState, err := host.generate(context.Background(), token, worldcontext.ConsumerNarraverse, frame, ModelGatewayChatRequest{
		Messages: []ModelGatewayMessage{{Role: "user", Content: "继续"}},
	})
	if err != nil || result.Content != "generated" || callState.State != "active" {
		t.Fatalf("call result=%+v state=%+v err=%v", result, callState, err)
	}
	if len(upstream) != 1 {
		t.Fatalf("upstream calls=%d, want 1", len(upstream))
	}
	messages := upstream[0]
	if len(messages) != 2 {
		t.Fatalf("upstream messages=%d, want leading+iframe: %#v", len(messages), messages)
	}
	leading := messages[0].Content
	if !strings.HasPrefix(leading, libraryruntime.EphemeralLibraryContextHeader()) {
		t.Fatalf("leading message must carry the frozen library header: %q", leading)
	}
	for _, want := range []string{"HOSTLIB-RES-01", "HOSTLIB-MAN-01", "常驻一", "手动一"} {
		if !strings.Contains(leading, want) {
			t.Fatalf("leading message missing granted content %q", want)
		}
	}
	if strings.Contains(leading, "HOSTLIB-AUTO-01") {
		t.Fatal("catalog-only auto content must not be assembled into the initial background")
	}
	if messages[1].Content != "继续" {
		t.Fatalf("iframe message must stay after the leading background: %#v", messages)
	}
	after, err := os.ReadFile(libraryPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("host library call modified the library source file")
	}

	// 解绑（正常结束）→ Complete，幂等；重复解绑不再报错。
	binding := hostBindingForTest(t, host, token, worldcontext.ConsumerNarraverse, frame)
	if binding == nil || binding.libraryRun == nil {
		t.Fatal("library binding missing")
	}
	run := binding.libraryRun
	if err := host.unbind(token, worldcontext.ConsumerNarraverse, frame); err != nil {
		t.Fatalf("unbind: %v", err)
	}
	if st := run.Status(); st.State != "completed" {
		t.Fatalf("explicit unbind must complete the run, got %s", st.State)
	}
	if err := host.unbind(token, worldcontext.ConsumerNarraverse, frame); err != nil {
		t.Fatalf("second unbind must stay idempotent: %v", err)
	}
}

func TestWorldContextHost_LibraryBindFailuresAreExplicitAndLeaveNoBinding(t *testing.T) {
	host, l, revision, _, _ := newHostLibraryTestService(t)
	token := hostSessionForTest(t, host)
	frame := "frame_abcdefghijklmnop"

	// revision 冲突：显式稳定码，且不落半绑定。
	if _, err := host.bindLibrary(context.Background(), token, worldcontext.ConsumerNarraverse, frame, hostLibraryControl(l, "sha256:deadbeef", nil)); libraryruntime.CodeOf(err) != libraryruntime.ErrRevisionConflict {
		t.Fatalf("wrong revision must be an explicit conflict, got %v", err)
	}
	if binding := hostBindingForTest(t, host, token, worldcontext.ConsumerNarraverse, frame); binding != nil {
		t.Fatalf("failed bind must not leave a binding: %#v", binding)
	}
	if _, _, err := host.generate(context.Background(), token, worldcontext.ConsumerNarraverse, frame, ModelGatewayChatRequest{
		Messages: []ModelGatewayMessage{{Role: "user", Content: "继续"}},
	}); worldcontext.CodeOf(err) != worldcontext.ErrConsumerNotTrusted {
		t.Fatalf("call without a binding must stay untrusted, got %v", err)
	}
	// 未授权 manual 条目：显式 selection_invalid。
	if _, err := host.bindLibrary(context.Background(), token, worldcontext.ConsumerNarraverse, frame, hostLibraryControl(l, revision, []string{"manual-unknown"})); libraryruntime.CodeOf(err) != libraryruntime.ErrSelectionInvalid {
		t.Fatalf("unknown manual item must be selection_invalid, got %v", err)
	}
	// B4a 只接叙界：Module4 的库载体显式拒绝（B4b 按其受控适配另行接入）。
	if _, err := host.bindLibrary(context.Background(), token, worldcontext.ConsumerModule4, frame, hostLibraryControl(l, revision, nil)); worldcontext.CodeOf(err) != worldcontext.ErrInvalidRequest {
		t.Fatalf("module4 library bind must be rejected for now, got %v", err)
	}
}

func TestWorldContextHost_LibraryRebindAndExpiryReleaseExactlyOnce(t *testing.T) {
	host, l, revision, _, now := newHostLibraryTestService(t)
	ctx := context.Background()
	token := hostSessionForTest(t, host)
	frame := "frame_abcdefghijklmnop"

	first, err := host.bindLibrary(ctx, token, worldcontext.ConsumerNarraverse, frame, hostLibraryControl(l, revision, nil))
	if err != nil || first.State != "active" {
		t.Fatalf("first bind: %+v %v", first, err)
	}
	firstRun := hostBindingForTest(t, host, token, worldcontext.ConsumerNarraverse, frame).libraryRun

	// 库→库换绑：旧运行取消，新运行生效。
	if _, err := host.bindLibrary(ctx, token, worldcontext.ConsumerNarraverse, frame, hostLibraryControl(l, revision, nil)); err != nil {
		t.Fatalf("rebind: %v", err)
	}
	if st := firstRun.Status(); st.State != "cancelled" {
		t.Fatalf("replaced library run must be cancelled, got %s", st.State)
	}
	secondRun := hostBindingForTest(t, host, token, worldcontext.ConsumerNarraverse, frame).libraryRun
	if secondRun == firstRun {
		t.Fatal("rebind must create a fresh library run")
	}

	// 库→bare（显式 none）：同样释放旧运行。
	if state, err := host.bind(ctx, token, worldcontext.ConsumerNarraverse, frame, nil); err != nil || state.State != "none" {
		t.Fatalf("bare rebind: %+v %v", state, err)
	}
	if st := secondRun.Status(); st.State != "cancelled" {
		t.Fatalf("bare rebind must cancel the library run, got %s", st.State)
	}

	// 会话空闲过期：库运行被取消且只释放一次。
	if _, err := host.bindLibrary(ctx, token, worldcontext.ConsumerNarraverse, frame, hostLibraryControl(l, revision, nil)); err != nil {
		t.Fatalf("bind before expiry: %v", err)
	}
	expiringRun := hostBindingForTest(t, host, token, worldcontext.ConsumerNarraverse, frame).libraryRun
	*now = now.Add(hostIdleTTL + time.Second)
	if _, err := host.authenticate(token, true); worldcontext.CodeOf(err) != worldcontext.ErrConsumerNotTrusted {
		t.Fatalf("expired session should fail, got %v", err)
	}
	if st := expiringRun.Status(); st.State != "cancelled" {
		t.Fatalf("expiry must cancel the library run, got %s", st.State)
	}
	host.Close()
	host.Close()
	if st := expiringRun.Status(); st.State != "cancelled" {
		t.Fatalf("idempotent close must not change released state: %s", st.State)
	}
}

func TestWorldContextHost_LibraryCallBudgetIsExplicit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"generated"}}]}`))
	}))
	defer server.Close()

	host, l, revision, _, _ := newHostLibraryTestService(t)
	host.app.cfg.OpenAIAPIKey = "test-key"
	host.app.cfg.OpenAIBaseURL = server.URL
	host.app.cfg.OpenAIModel = "test-model"
	ctx := context.Background()
	token := hostSessionForTest(t, host)
	frame := "frame_abcdefghijklmnop"
	if _, err := host.bindLibrary(ctx, token, worldcontext.ConsumerNarraverse, frame, hostLibraryControl(l, revision, nil)); err != nil {
		t.Fatalf("bind: %v", err)
	}
	// 超预算输入（CJK ≈ 1 token/字，30k 字 + 预留 8k 超 32k 上限）：显式 budget_exceeded，
	// 不触发上游模型调用，绑定保持可继续。
	if _, _, err := host.generate(ctx, token, worldcontext.ConsumerNarraverse, frame, ModelGatewayChatRequest{
		Messages: []ModelGatewayMessage{{Role: "user", Content: strings.Repeat("界", 30000)}},
	}); libraryruntime.CodeOf(err) != libraryruntime.ErrBudgetExceeded {
		t.Fatalf("over-budget call must be explicit budget_exceeded, got %v", err)
	}
	if _, _, err := host.generate(ctx, token, worldcontext.ConsumerNarraverse, frame, ModelGatewayChatRequest{
		Messages: []ModelGatewayMessage{{Role: "user", Content: "继续"}},
	}); err != nil {
		t.Fatalf("binding must stay usable after a budget failure: %v", err)
	}
}
