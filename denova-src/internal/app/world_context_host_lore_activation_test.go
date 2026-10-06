package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"denova/internal/book"
	"denova/internal/worldcontext"
)

func TestNarraverseAutoLoreActivationUsesRecentConversationAndCurrentContext(t *testing.T) {
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
	host.app.cfg.OpenAIAPIKey, host.app.cfg.OpenAIBaseURL, host.app.cfg.OpenAIModel = "test-key", upstream.URL, "test-model"
	store := book.NewLoreStore(workspace)
	for _, item := range []book.LoreItemInput{
		{ID: "auto-alias", Name: "断桥", Keywords: []string{"白蛇别名"}, LoadMode: book.LoreLoadModeAuto, Content: "AUTO_ALIAS_BODY"},
		{ID: "auto-tag", Name: "沉船", Tags: []string{"黑礁"}, LoadMode: book.LoreLoadModeAuto, Content: "TAG_MUST_NOT_MATCH"},
		{ID: "manual", Name: "旧钟", Keywords: []string{"钟声"}, LoadMode: book.LoreLoadModeManual, Content: "MANUAL_MUST_NOT_AUTO"},
		{ID: "disabled", Name: "废塔", Keywords: []string{"废塔关键词"}, LoadMode: book.LoreLoadModeAuto, Enabled: boolPtr(false), Content: "DISABLED_MUST_NOT_MATCH"},
	} {
		if _, err := store.Create(item); err != nil {
			t.Fatal(err)
		}
	}
	token := hostSessionForTest(t, host)
	frame := "frame_activation_abcdefghijkl"
	if _, err := host.bindContext(context.Background(), token, worldcontext.ConsumerNarraverse, frame, nil, true); err != nil {
		t.Fatal(err)
	}
	if block, err := host.assembleBookBackgroundWithActivation(&hostBookContext{workspace: workspace}, nil, []ModelGatewayMessage{{Role: "user", Content: "白蛇别名"}}, &BookLoreActivation{ScanDepth: 14}); err != nil || !strings.Contains(block, "AUTO_ALIAS_BODY") {
		t.Fatalf("activation did not match alias: block=%s err=%v", block, err)
	}
	call := func(messages []ModelGatewayMessage, contextText string, depth int) {
		t.Helper()
		_, _, err := host.generate(context.Background(), token, worldcontext.ConsumerNarraverse, frame, ModelGatewayChatRequest{
			Messages: messages, LoreActivation: &BookLoreActivation{ScanDepth: depth, ContextText: contextText},
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	call([]ModelGatewayMessage{{Role: "system", Content: "白蛇别名"}, {Role: "user", Content: "无关"}, {Role: "assistant", Content: "无关"}, {Role: "user", Content: "黑礁 钟声 废塔关键词"}}, "", 14)
	joined := received[0].Content
	if strings.Contains(joined, "AUTO_ALIAS_BODY") || strings.Contains(joined, "TAG_MUST_NOT_MATCH") || strings.Contains(joined, "MANUAL_MUST_NOT_AUTO") || strings.Contains(joined, "DISABLED_MUST_NOT_MATCH") {
		t.Fatalf("wrong auto lore matches: messages=%+v", received)
	}
	call([]ModelGatewayMessage{{Role: "user", Content: "白蛇别名"}}, "", 14)
	if !strings.Contains(received[0].Content, "AUTO_ALIAS_BODY") || !strings.Contains(received[0].Content, "关键词触发") {
		t.Fatalf("recent alias did not trigger auto lore: %s", received[0].Content)
	}
	call([]ModelGatewayMessage{{Role: "user", Content: "无关"}}, "当前人物使用白蛇别名", 14)
	if !strings.Contains(received[0].Content, "AUTO_ALIAS_BODY") || !strings.Contains(received[0].Content, "关键词触发") {
		t.Fatal("current context text should trigger the matching alias")
	}
	call([]ModelGatewayMessage{{Role: "user", Content: "白蛇别名"}, {Role: "assistant", Content: "较新消息"}}, "", 1)
	if strings.Contains(received[0].Content, "AUTO_ALIAS_BODY") {
		t.Fatal("message outside the scan window triggered lore")
	}
}

func TestNarraverseAutoLoreActivationPreservesOrderingAndDoesNotWrite(t *testing.T) {
	// Covered through the actual upstream request so the assembled prompt, order,
	// deduplication, and read-only behavior remain observable at the boundary.
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
	host, _, _, _ := newHostTestService(t)
	host.app.bookMetaStore = NewBookMetaStore(host.app.cfg.DataDir())
	workspace := t.TempDir()
	host.app.workspace, host.app.bookService = workspace, book.NewService(workspace)
	host.app.cfg.OpenAIAPIKey, host.app.cfg.OpenAIBaseURL, host.app.cfg.OpenAIModel = "test-key", upstream.URL, "test-model"
	store := book.NewLoreStore(workspace)
	resident, err := store.Create(book.LoreItemInput{ID: "resident", Name: "常驻", LoadMode: book.LoreLoadModeResident, Content: "RESIDENT_BODY"})
	if err != nil {
		t.Fatal(err)
	}
	selected, err := store.Create(book.LoreItemInput{ID: "selected", Name: "选中", LoadMode: book.LoreLoadModeManual, Content: "SELECTED_BODY"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.Create(book.LoreItemInput{ID: "auto", Name: "命中", Keywords: []string{"召回词"}, LoadMode: book.LoreLoadModeAuto, Content: "AUTO_BODY"})
	if err != nil {
		t.Fatal(err)
	}
	before, err := store.Revision()
	if err != nil {
		t.Fatal(err)
	}
	token := hostSessionForTest(t, host)
	frame := "frame_order_abcdefghijklmnop"
	if _, err := host.bindContext(context.Background(), token, worldcontext.ConsumerNarraverse, frame, nil, true); err != nil {
		t.Fatal(err)
	}
	_, _, err = host.generate(context.Background(), token, worldcontext.ConsumerNarraverse, frame, ModelGatewayChatRequest{
		Messages: []ModelGatewayMessage{{Role: "user", Content: "召回词"}}, SelectedLoreIDs: []string{selected.ID, resident.ID, selected.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	content := received[0].Content
	positions := []int{strings.Index(content, "RESIDENT_BODY"), strings.Index(content, "SELECTED_BODY"), strings.Index(content, "AUTO_BODY")}
	if positions[0] < 0 || positions[1] <= positions[0] || positions[2] <= positions[1] {
		t.Fatalf("wrong background order: %s", content)
	}
	for _, body := range []string{"RESIDENT_BODY", "SELECTED_BODY", "AUTO_BODY"} {
		if strings.Count(content, body) != 1 {
			t.Fatalf("%s duplicated: %s", body, content)
		}
	}
	after, err := store.Revision()
	if err != nil || after != before {
		t.Fatalf("generation changed lore: before=%s after=%s err=%v", before, after, err)
	}
}

func boolPtr(value bool) *bool { return &value }
