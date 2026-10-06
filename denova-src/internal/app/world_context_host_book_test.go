package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"denova/internal/book"
	"denova/internal/worldcontext"
)

func TestNarraverseBookContextInputAndReadOnly(t *testing.T) {
	var received []ModelGatewayMessage
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Messages []ModelGatewayMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		received = payload.Messages
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"generated"}}]}`))
	}))
	defer upstream.Close()
	host, _, _, _ := newHostTestService(t)
	host.app.bookMetaStore = NewBookMetaStore(host.app.cfg.DataDir())
	workspace := t.TempDir()
	host.app.workspace = workspace
	host.app.bookService = book.NewService(workspace)
	host.app.cfg.OpenAIAPIKey = "test-key"
	host.app.cfg.OpenAIBaseURL = upstream.URL
	host.app.cfg.OpenAIModel = "test-model"
	store := book.NewLoreStore(workspace)
	for _, item := range []book.LoreItemInput{
		{ID: "oath", Name: "誓言", Type: "rule", LoadMode: "resident", Content: "KEEP_THE_LAMP_LIT"},
		{ID: "tower", Name: "灯塔", Type: "location", LoadMode: "manual", Content: "RUST_KEY_UNIQUE"},
		{ID: "other", Name: "远方", Type: "location", LoadMode: "manual", Content: "NOT_SELECTED"},
		{ID: "off", Name: "停用", Type: "rule", Enabled: func() *bool { v := false; return &v }(), Content: "DISABLED_FACT"},
	} {
		if _, err := store.Create(item); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := host.app.bookService.WriteFileIfRevision(BookOverviewPath, "BOOK_OVERVIEW_FACT", ""); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(workspace, ".denova", "lore", "items.json"))
	if err != nil {
		t.Fatal(err)
	}
	token := hostSessionForTest(t, host)
	frame := "frame_book_abcdefghijklmnop"
	state, err := host.bindContext(context.Background(), token, worldcontext.ConsumerNarraverse, frame, nil, true)
	if err != nil || !state.BookBound || state.BookKey == "" || strings.Contains(state.BookKey, workspace) {
		t.Fatalf("state=%+v err=%v", state, err)
	}
	result, state, err := host.generate(context.Background(), token, worldcontext.ConsumerNarraverse, frame, ModelGatewayChatRequest{
		Messages: []ModelGatewayMessage{{Role: "user", Content: "continue"}}, SelectedLoreIDs: []string{"tower", "oath", "tower", "missing", "off"},
	})
	if err != nil || result.Content != "generated" || !state.BookBound {
		t.Fatalf("result=%+v state=%+v err=%v", result, state, err)
	}
	if len(received) != 2 {
		t.Fatalf("messages=%+v", received)
	}
	for _, fact := range []string{"[Book Background · Read Only]", "BOOK_OVERVIEW_FACT", "KEEP_THE_LAMP_LIT", "RUST_KEY_UNIQUE", "missing"} {
		if !strings.Contains(received[0].Content, fact) {
			t.Fatalf("missing %s: %s", fact, received[0].Content)
		}
	}
	for _, fact := range []string{"[World Background", "NOT_SELECTED", "DISABLED_FACT"} {
		if strings.Contains(received[0].Content, fact) {
			t.Fatalf("unexpected %s", fact)
		}
	}
	if strings.Count(received[0].Content, "KEEP_THE_LAMP_LIT") != 1 || strings.Count(received[0].Content, "RUST_KEY_UNIQUE") != 1 {
		t.Fatal("duplicate lore body")
	}
	after, _ := os.ReadFile(filepath.Join(workspace, ".denova", "lore", "items.json"))
	if string(before) != string(after) {
		t.Fatal("generation wrote to lore")
	}
	if _, err := store.Create(book.LoreItemInput{ID: "new", Name: "新增", Content: "new"}); err != nil {
		t.Fatal(err)
	}
	_, _, err = host.generate(context.Background(), token, worldcontext.ConsumerNarraverse, frame, ModelGatewayChatRequest{Messages: []ModelGatewayMessage{{Role: "user", Content: "again"}}})
	if worldcontext.CodeOf(err) != worldcontext.ErrBookStale {
		t.Fatalf("expected stale: %v", err)
	}
	host.app.workspace = t.TempDir()
	_, _, err = host.generate(context.Background(), token, worldcontext.ConsumerNarraverse, frame, ModelGatewayChatRequest{Messages: []ModelGatewayMessage{{Role: "user", Content: "again"}}})
	if worldcontext.CodeOf(err) != worldcontext.ErrBookChanged {
		t.Fatalf("expected changed: %v", err)
	}
}

func TestNarraverseEmptyBookAndModule4RemainSeparate(t *testing.T) {
	var received []ModelGatewayMessage
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Messages []ModelGatewayMessage `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		received = payload.Messages
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"generated"}}]}`))
	}))
	defer upstream.Close()
	host, world, revision, _ := newHostTestService(t)
	host.app.bookMetaStore = NewBookMetaStore(host.app.cfg.DataDir())
	host.app.workspace = t.TempDir()
	host.app.cfg.OpenAIAPIKey = "test-key"
	host.app.cfg.OpenAIBaseURL = upstream.URL
	host.app.cfg.OpenAIModel = "test-model"
	token := hostSessionForTest(t, host)
	frame := "frame_empty_abcdefghijklmnop"
	ref := worldRef(world, revision)
	if _, err := host.bind(context.Background(), token, worldcontext.ConsumerNarraverse, frame, &ref); err != nil {
		t.Fatal(err)
	}
	if _, err := host.bindContext(context.Background(), token, worldcontext.ConsumerNarraverse, frame, nil, true); err != nil {
		t.Fatal(err)
	}
	request := ModelGatewayChatRequest{Messages: []ModelGatewayMessage{{Role: "user", Content: "continue"}}}
	_, state, err := host.generate(context.Background(), token, worldcontext.ConsumerNarraverse, frame, request)
	if err != nil || !state.BookBound || len(received) != 1 || received[0].Content != "continue" {
		t.Fatalf("state=%+v messages=%+v err=%v", state, received, err)
	}
	if _, err := host.bind(context.Background(), token, worldcontext.ConsumerModule4, frame, &ref); err != nil {
		t.Fatal(err)
	}
	_, state, err = host.generate(context.Background(), token, worldcontext.ConsumerModule4, frame, request)
	if err != nil || state.BookBound || len(received) != 2 || !strings.HasPrefix(received[0].Content, "[World Background") {
		t.Fatalf("module4 changed: state=%+v messages=%+v err=%v", state, received, err)
	}
	text := boundedBookText(strings.Repeat("中文", 100), 101)
	if !json.Valid([]byte(`"` + text + `"`)) {
		t.Fatal("bounded text is not valid UTF-8")
	}
}
