package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"denova/internal/workspacepath"
)

func TestBookOverviewOrganizeDoesNotExposeCorruptLorePath(t *testing.T) {
	application := newTestApplication(t)
	server := NewServer(application, "0")
	workspace := application.Workspace()
	lorePath := workspacepath.Path(workspace, "lore", "items.json")
	loreDir := filepath.Dir(lorePath)
	if err := os.MkdirAll(loreDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lorePath, []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}

	response := performJSONRequest(t, server, http.MethodPost, "/api/book/overview/organize", map[string]any{"current_draft": "# Draft"})
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), workspace) || strings.Contains(response.Body.String(), "items.json") {
		t.Fatalf("internal path leaked: %s", response.Body.String())
	}
}
