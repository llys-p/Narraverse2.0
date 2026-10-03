package api

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"denova/config"
	runtimeapp "denova/internal/app"
	"denova/internal/book"
)

func TestUpdateLoreItemWorkspaceGuardRejectsCrossBookWrite(t *testing.T) {
	application, workspaceA, workspaceB := newLoreWorkspaceGuardTestApp(t)
	item, err := application.CreateLoreItem(book.LoreItemInput{
		ID: "hero", Type: "character", Name: "原始名称", Importance: "major", Content: "原始正文",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := book.NewLoreStore(workspaceB).Create(book.LoreItemInput{
		ID: "hero", Type: "character", Name: "另一册原名", Importance: "major", Content: "另一册原文",
	}); err != nil {
		t.Fatal(err)
	}
	beforeA := readLoreItemsFile(t, workspaceA)
	beforeB := readLoreItemsFile(t, workspaceB)
	server := NewServer(application, "0")

	resp := performJSONRequest(t, server, http.MethodPatch, "/api/lore/items/"+item.ID, map[string]any{
		"workspace": workspaceB,
		"type":      "character", "name": "被串写名称", "importance": "major", "content": "被串写正文",
	})
	if resp.Code != http.StatusConflict {
		t.Fatalf("cross-book update status = %d, want %d; body=%s", resp.Code, http.StatusConflict, resp.Body.String())
	}
	if bytes := resp.Body.String(); strings.Contains(bytes, workspaceA) || strings.Contains(bytes, workspaceB) {
		t.Fatalf("conflict response must not disclose workspace paths: %s", bytes)
	}
	if got := readLoreItemsFile(t, workspaceA); string(got) != string(beforeA) {
		t.Fatalf("active book changed after cross-book request\nbefore: %s\nafter:  %s", beforeA, got)
	}
	if got := readLoreItemsFile(t, workspaceB); string(got) != string(beforeB) {
		t.Fatalf("requested book changed after cross-book request\nbefore: %s\nafter:  %s", beforeB, got)
	}
}

func TestUpdateLoreItemWorkspaceGuardAcceptsMatchingWorkspace(t *testing.T) {
	application, workspace, _ := newLoreWorkspaceGuardTestApp(t)
	item, err := application.CreateLoreItem(book.LoreItemInput{
		ID: "hero", Type: "character", Name: "原名", Importance: "major", Content: "原文",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(application, "0")
	resp := performJSONRequest(t, server, http.MethodPatch, "/api/lore/items/"+item.ID, map[string]any{
		"workspace": workspace,
		"type":      "character", "name": "匹配更新", "importance": "major", "content": "匹配正文",
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("matching workspace update status = %d, want %d; body=%s", resp.Code, http.StatusOK, resp.Body.String())
	}
	updated, err := book.NewLoreStore(workspace).ReadAny(item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "匹配更新" || updated.Content != "匹配正文" {
		t.Fatalf("matching workspace update did not persist: %#v", updated)
	}
}

func TestUpdateLoreItemWithoutWorkspaceKeepsLegacyBehavior(t *testing.T) {
	application, workspace, _ := newLoreWorkspaceGuardTestApp(t)
	item, err := application.CreateLoreItem(book.LoreItemInput{
		ID: "hero", Type: "character", Name: "原名", Importance: "major", Content: "原文",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(application, "0")
	resp := performJSONRequest(t, server, http.MethodPatch, "/api/lore/items/"+item.ID, map[string]any{
		"type": "character", "name": "兼容更新", "importance": "major", "content": "兼容正文",
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("legacy update status = %d, want %d; body=%s", resp.Code, http.StatusOK, resp.Body.String())
	}
	updated, err := book.NewLoreStore(workspace).ReadAny(item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "兼容更新" || updated.Content != "兼容正文" {
		t.Fatalf("legacy update did not persist: %#v", updated)
	}
}

func newLoreWorkspaceGuardTestApp(t *testing.T) (*runtimeapp.App, string, string) {
	t.Helper()
	root := t.TempDir()
	workspaceA := filepath.Join(root, "projects", "book-a")
	workspaceB := filepath.Join(root, "projects", "book-b")
	if err := os.MkdirAll(workspaceA, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(workspaceB, 0o755); err != nil {
		t.Fatal(err)
	}
	application, err := runtimeapp.New(context.Background(), &config.Config{
		Workspace:           workspaceA,
		NovaDir:             root,
		ResumeLastWorkspace: false,
	})
	if err != nil {
		t.Fatalf("construct test app: %v", err)
	}
	return application, workspaceA, workspaceB
}

func readLoreItemsFile(t *testing.T, workspace string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(workspace, ".denova", "lore", "items.json"))
	if err != nil {
		t.Fatalf("read lore items for test comparison: %v", err)
	}
	return data
}
