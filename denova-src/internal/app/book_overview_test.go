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
)

func TestOrganizeBookOverviewDeduplicatesResidentSelectionAndDoesNotWrite(t *testing.T) {
	requests := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []ModelGatewayMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode model request: %v", err)
		}
		if len(body.Messages) < 2 {
			t.Errorf("model messages = %#v", body.Messages)
		} else {
			requests <- body.Messages[1].Content
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"# Overview"}}]}`))
	}))
	defer server.Close()

	workspace := t.TempDir()
	a := newWorkspaceMutationTestApp(workspace)
	a.cfg.OpenAIAPIKey = "test-key"
	a.cfg.OpenAIBaseURL = server.URL
	a.cfg.OpenAIModel = "test-model"
	store := book.NewLoreStore(workspace)
	item, err := store.Create(book.LoreItemInput{ID: "lamp-keeper", Name: "Lamp keeper", Type: "character", LoadMode: book.LoreLoadModeResident, BriefDescription: "keeper summary", Content: "UNIQUE-RESIDENT-DETAIL"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := a.OrganizeBookOverview(context.Background(), BookOverviewOrganizeRequest{CurrentDraft: "# User note", SelectedLoreIDs: []string{item.ID}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Draft != "# Overview" {
		t.Fatalf("draft = %q", result.Draft)
	}
	modelInput := <-requests
	if count := strings.Count(modelInput, "UNIQUE-RESIDENT-DETAIL"); count != 1 {
		t.Fatalf("resident detail appears %d times in model input", count)
	}
	if _, err := os.Stat(filepath.Join(workspace, filepath.FromSlash(BookOverviewPath))); !os.IsNotExist(err) {
		t.Fatalf("AI draft wrote overview file: %v", err)
	}
}
