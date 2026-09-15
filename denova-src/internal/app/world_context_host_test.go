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
	"sync"
	"testing"
	"time"

	"denova/internal/world"
	"denova/internal/worldcontext"
)

func newHostTestService(t *testing.T) (*WorldContextHostService, world.World, string, *time.Time) {
	t.Helper()
	a, w, revision := newWorldContextTestApp(t)
	worldSvc := newWorldContextService(a)
	now := time.Date(2026, 9, 15, 6, 0, 0, 0, time.UTC)
	host := newWorldContextHostService(a, worldSvc)
	host.now = func() time.Time { return now }
	return host, w, revision, &now
}

func hostSessionForTest(t *testing.T, host *WorldContextHostService) string {
	t.Helper()
	secret, err := host.newBootstrapSecret()
	if err != nil {
		t.Fatalf("new secret: %v", err)
	}
	token, _, err := host.bootstrap(secret)
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	return token
}

func TestWorldContextHost_OneShotBootstrapAndTTL(t *testing.T) {
	host, _, _, now := newHostTestService(t)
	secret, err := host.newBootstrapSecret()
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := host.bootstrap(secret)
	if err != nil || token == "" {
		t.Fatalf("bootstrap token=%q err=%v", token, err)
	}
	if _, _, err := host.bootstrap(secret); worldcontext.CodeOf(err) != worldcontext.ErrConsumerNotTrusted {
		t.Fatalf("secret reuse must fail, got %v", err)
	}
	if _, err := host.authenticate(token, true); err != nil {
		t.Fatalf("fresh session: %v", err)
	}
	*now = now.Add(hostIdleTTL + time.Second)
	if _, err := host.authenticate(token, true); worldcontext.CodeOf(err) != worldcontext.ErrConsumerNotTrusted {
		t.Fatalf("idle-expired session must fail, got %v", err)
	}
}

func TestWorldContextHost_BindBareUnbindAndExpiryReleaseExactlyOnce(t *testing.T) {
	host, w, revision, now := newHostTestService(t)
	token := hostSessionForTest(t, host)
	frame := "frame_abcdefghijklmnop"
	ref := worldRef(w, revision)
	state, err := host.bind(context.Background(), token, worldcontext.ConsumerNarraverse, frame, &ref)
	if err != nil || state.State != "active" || state.WorldName != w.Name {
		t.Fatalf("active bind state=%+v err=%v", state, err)
	}
	if got := host.world.WorldContextRegistryStats().RunContexts; got != 1 {
		t.Fatalf("run contexts=%d, want 1", got)
	}
	state, err = host.bind(context.Background(), token, worldcontext.ConsumerNarraverse, frame, nil)
	if err != nil || state.State != "none" {
		t.Fatalf("bare bind state=%+v err=%v", state, err)
	}
	if got := host.world.WorldContextRegistryStats().RunContexts; got != 0 {
		t.Fatalf("active-to-bare must release run once, got %d", got)
	}
	if _, err := host.bind(context.Background(), token, worldcontext.ConsumerModule4, frame, &ref); err != nil {
		t.Fatalf("module4 bind: %v", err)
	}
	*now = now.Add(hostIdleTTL + time.Second)
	if _, err := host.authenticate(token, false); worldcontext.CodeOf(err) != worldcontext.ErrConsumerNotTrusted {
		t.Fatalf("expired session should fail, got %v", err)
	}
	if got := host.world.WorldContextRegistryStats().RunContexts; got != 0 {
		t.Fatalf("expiry must release run, got %d", got)
	}
	host.Close()
	host.Close()
	if got := host.world.WorldContextRegistryStats().RunContexts; got != 0 {
		t.Fatalf("idempotent close changed registry: %d", got)
	}
}

func TestWorldContextHost_ModelInjectionIsEphemeralAndWorldReadOnly(t *testing.T) {
	var upstreamMessages []ModelGatewayMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Messages []ModelGatewayMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode upstream: %v", err)
		}
		upstreamMessages = payload.Messages
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"generated"}}]}`))
	}))
	defer server.Close()

	host, w, revision, _ := newHostTestService(t)
	host.app.cfg.OpenAIAPIKey = "test-key"
	host.app.cfg.OpenAIBaseURL = server.URL
	host.app.cfg.OpenAIModel = "test-model"
	token := hostSessionForTest(t, host)
	frame := "frame_abcdefghijklmnop"
	ref := worldRef(w, revision)
	if _, err := host.bind(context.Background(), token, worldcontext.ConsumerNarraverse, frame, &ref); err != nil {
		t.Fatalf("bind: %v", err)
	}
	worldPath := filepath.Join(world.NewStore(host.app.cfg.DataDir()).Root(), "world-"+w.ID+".json")
	before, err := os.ReadFile(worldPath)
	if err != nil {
		t.Fatal(err)
	}
	result, state, err := host.generate(context.Background(), token, worldcontext.ConsumerNarraverse, frame, ModelGatewayChatRequest{
		Messages: []ModelGatewayMessage{{Role: "user", Content: "continue story"}},
	})
	if err != nil || result.Content != "generated" || state.State != "active" {
		t.Fatalf("result=%+v state=%+v err=%v", result, state, err)
	}
	if len(upstreamMessages) != 2 || !strings.HasPrefix(upstreamMessages[0].Content, "[World Background · Read Only]") || upstreamMessages[1].Content != "continue story" {
		t.Fatalf("unexpected upstream messages: %#v", upstreamMessages)
	}
	after, err := os.ReadFile(worldPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("host model call modified World source file")
	}
}

func TestWorldContextHost_ConcurrentRebindNeverStoresReleasedRun(t *testing.T) {
	host, w, revision, _ := newHostTestService(t)
	token := hostSessionForTest(t, host)
	frame := "frame_abcdefghijklmnop"
	refA := worldRef(w, revision)
	refB := refA
	refB.Selection.IncludeTone = false
	refB.Selection.RuleIndexes = []int{0}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		ref := refA
		if i%2 == 1 {
			ref = refB
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := host.bind(context.Background(), token, worldcontext.ConsumerNarraverse, frame, &ref); err != nil {
				t.Errorf("bind: %v", err)
			}
		}()
	}
	wg.Wait()
	hash := sha256.Sum256([]byte(token))
	host.mu.Lock()
	binding := *host.sessions[hash].bindings[hostBindingKey(worldcontext.ConsumerNarraverse, frame)]
	host.mu.Unlock()
	if _, err := host.world.GetWorldRunByID(binding.runContextID, worldcontext.ConsumerNarraverse); err != nil {
		t.Fatalf("stored binding points at released run: %v", err)
	}
	if got := host.world.WorldContextRegistryStats().RunContexts; got != 1 {
		t.Fatalf("run contexts=%d, want exactly one", got)
	}
}
