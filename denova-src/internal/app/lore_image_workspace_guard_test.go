package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"denova/config"
	"denova/internal/agent"
	"denova/internal/book"
)

func TestLoreImageBatchPinnedWorkspaceRejectsSwitchBeforeRun(t *testing.T) {
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{}})
	}))
	defer upstream.Close()
	workspaceA, workspaceB := t.TempDir(), t.TempDir()
	application, err := New(context.Background(), &config.Config{
		NovaDir: t.TempDir(), Workspace: workspaceA, ResumeLastWorkspace: false,
		ImageAPIKey: "local-test-only", ImageAPIBaseURL: upstream.URL, ImageAPIModel: "test-image",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, workspace := range []string{workspaceA, workspaceB} {
		if _, err := book.NewLoreStore(workspace).Create(book.LoreItemInput{ID: "same-id", Type: "character", Name: "角色", Importance: "major", Content: "正文"}); err != nil {
			t.Fatal(err)
		}
	}
	service := &LoreAppService{app: application}
	// Simulate the selected book changing after the task was accepted but before its batch body starts.
	application.mu.Lock()
	application.workspace = workspaceB
	application.bookService = book.NewService(workspaceB)
	application.bookState = book.NewState(workspaceB)
	application.mu.Unlock()

	var events []agent.Event
	service.runLoreImagesGenerateBatch(context.Background(), LoreImagesGenerateRequest{
		Workspace: workspaceA,
		ItemIDs:   []string{"same-id"},
	}, func(event agent.Event) { events = append(events, event) })
	if got := upstreamCalls.Load(); got != 0 {
		t.Fatalf("stale batch called image upstream %d times", got)
	}
	item, err := book.NewLoreStore(workspaceB).ReadAny("same-id")
	if err != nil {
		t.Fatal(err)
	}
	if item.Image != nil {
		t.Fatalf("stale batch wrote image association into newly active book: %#v", item.Image)
	}
}
