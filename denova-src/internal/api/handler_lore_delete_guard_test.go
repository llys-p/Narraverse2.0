package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"denova/config"
	runtimeapp "denova/internal/app"
	"denova/internal/book"
)

// 复审返修 F1：删除必须带目标书籍守卫。
// 反例场景——当前书是 A，请求声明 B 的同 ID 条目：两条链都必须被拒，且两册文件都不变。
func TestDeleteLoreItemWorkspaceGuardRejectsCrossBookDelete(t *testing.T) {
	application, workspaceA, workspaceB := newLoreWorkspaceGuardTestApp(t)
	if _, err := application.CreateLoreItem(book.LoreItemInput{
		ID: "shared-id", Type: "character", Name: "同一标识", Importance: "major", Content: "A 正文",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := book.NewLoreStore(workspaceB).Create(book.LoreItemInput{
		ID: "shared-id", Type: "character", Name: "同一标识", Importance: "major", Content: "B 正文",
	}); err != nil {
		t.Fatal(err)
	}
	beforeA := readLoreItemsFile(t, workspaceA)
	beforeB := readLoreItemsFile(t, workspaceB)

	server := NewServer(application, "0")
	resp := performJSONRequest(t, server, http.MethodDelete, "/api/lore/items/shared-id", map[string]any{
		"workspace": workspaceB,
	})
	if resp.Code != http.StatusConflict {
		t.Fatalf("cross-book delete status = %d, want %d; body=%s", resp.Code, http.StatusConflict, resp.Body.String())
	}
	if body := resp.Body.String(); strings.Contains(body, workspaceA) || strings.Contains(body, workspaceB) {
		t.Fatalf("conflict response must not disclose workspace paths: %s", body)
	}
	if got := readLoreItemsFile(t, workspaceA); string(got) != string(beforeA) {
		t.Fatalf("active book changed after cross-book delete\nbefore: %s\nafter:  %s", beforeA, got)
	}
	if got := readLoreItemsFile(t, workspaceB); string(got) != string(beforeB) {
		t.Fatalf("declared book changed after cross-book delete\nbefore: %s\nafter:  %s", beforeB, got)
	}
	loreItemExists(t, workspaceA, "shared-id")
	loreItemExists(t, workspaceB, "shared-id")
}

// 同一标识在两册都存在时，用当前书的身份删除只应命中当前书。
func TestDeleteLoreItemWorkspaceGuardDeletesOnlyDeclaredBook(t *testing.T) {
	application, workspaceA, workspaceB := newLoreWorkspaceGuardTestApp(t)
	if _, err := application.CreateLoreItem(book.LoreItemInput{
		ID: "shared-id", Type: "character", Name: "同一标识", Importance: "major", Content: "A 正文",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := book.NewLoreStore(workspaceB).Create(book.LoreItemInput{
		ID: "shared-id", Type: "character", Name: "同一标识", Importance: "major", Content: "B 正文",
	}); err != nil {
		t.Fatal(err)
	}

	server := NewServer(application, "0")
	resp := performJSONRequest(t, server, http.MethodDelete, "/api/lore/items/shared-id", map[string]any{
		"workspace": workspaceA,
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("matching delete status = %d, want 200; body=%s", resp.Code, resp.Body.String())
	}
	loreItemMissing(t, workspaceA, "shared-id")
	loreItemExists(t, workspaceB, "shared-id")
}

// 不带 workspace 的旧调用方保持既有行为，本期不破坏其它写入者。
func TestDeleteLoreItemWithoutWorkspaceKeepsLegacyBehavior(t *testing.T) {
	application, workspaceA, _ := newLoreWorkspaceGuardTestApp(t)
	if _, err := application.CreateLoreItem(book.LoreItemInput{
		ID: "legacy", Type: "other", Name: "旧调用", Importance: "minor", Content: "正文",
	}); err != nil {
		t.Fatal(err)
	}
	server := NewServer(application, "0")
	resp := performJSONRequest(t, server, http.MethodDelete, "/api/lore/items/legacy", map[string]any{})
	if resp.Code != http.StatusOK {
		t.Fatalf("legacy delete status = %d, want 200; body=%s", resp.Code, resp.Body.String())
	}
	loreItemMissing(t, workspaceA, "legacy")
}

// 新建同样需要书籍守卫：切书后的迟到创建不得写进另一册。
func TestCreateLoreItemWorkspaceGuardRejectsCrossBookCreate(t *testing.T) {
	application, _, workspaceB := newLoreWorkspaceGuardTestApp(t)
	if _, err := book.NewLoreStore(workspaceB).Create(book.LoreItemInput{
		ID: "resident", Type: "other", Name: "他册原有", Importance: "minor", Content: "他册正文",
	}); err != nil {
		t.Fatal(err)
	}
	beforeB := readLoreItemsFile(t, workspaceB)
	server := NewServer(application, "0")

	resp := performJSONRequest(t, server, http.MethodPost, "/api/lore/items", map[string]any{
		"workspace":  workspaceB,
		"id":         "late-create",
		"type":       "character",
		"name":       "迟到的新建",
		"importance": "major",
		"content":    "正文",
	})
	if resp.Code != http.StatusConflict {
		t.Fatalf("cross-book create status = %d, want %d; body=%s", resp.Code, http.StatusConflict, resp.Body.String())
	}
	if got := readLoreItemsFile(t, workspaceB); string(got) != string(beforeB) {
		t.Fatalf("declared book changed after cross-book create\nbefore: %s\nafter:  %s", beforeB, got)
	}
	loreItemMissing(t, workspaceB, "late-create")
	loreItemExists(t, workspaceB, "resident")
}

func TestCreateLoreItemWorkspaceGuardAcceptsMatchingWorkspace(t *testing.T) {
	application, workspaceA, _ := newLoreWorkspaceGuardTestApp(t)
	server := NewServer(application, "0")
	resp := performJSONRequest(t, server, http.MethodPost, "/api/lore/items", map[string]any{
		"workspace":  workspaceA,
		"id":         "ok-create",
		"type":       "character",
		"name":       "合法新建",
		"importance": "major",
		"content":    "正文",
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("matching create status = %d, want 200; body=%s", resp.Code, resp.Body.String())
	}
	loreItemExists(t, workspaceA, "ok-create")
}

func TestCreateDeleteWorkspaceGuardAcceptsCleanEquivalentPath(t *testing.T) {
	application, workspaceA, _ := newLoreWorkspaceGuardTestApp(t)
	server := NewServer(application, "0")
	cleanEquivalent := workspaceA + string(filepath.Separator) + "."
	resp := performJSONRequest(t, server, http.MethodPost, "/api/lore/items", map[string]any{
		"workspace": cleanEquivalent, "id": "clean-path", "type": "other", "name": "清理路径", "importance": "minor", "content": "正文",
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("clean-equivalent create status = %d; body=%s", resp.Code, resp.Body.String())
	}
	resp = performJSONRequest(t, server, http.MethodDelete, "/api/lore/items/clean-path", map[string]any{"workspace": cleanEquivalent})
	if resp.Code != http.StatusOK {
		t.Fatalf("clean-equivalent delete status = %d; body=%s", resp.Code, resp.Body.String())
	}
	loreItemMissing(t, workspaceA, "clean-path")
}

func TestClearLoreItemImageWorkspaceMismatchDoesNotTouchOtherBook(t *testing.T) {
	application, workspaceA, workspaceB := newLoreWorkspaceGuardTestApp(t)
	image := &book.LoreItemImage{Schema: "lore_item_image.v1", ImagePath: "assets/lore/images/shared/stale/image.png", MetaPath: "assets/lore/images/shared/stale/meta.json"}
	for _, workspace := range []string{workspaceA, workspaceB} {
		if _, err := book.NewLoreStore(workspace).Create(book.LoreItemInput{ID: "shared", Type: "character", Name: "同ID", Importance: "major", Content: "正文"}); err != nil {
			t.Fatal(err)
		}
		if _, err := book.NewLoreStore(workspace).SetImage("shared", image); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(application, "0")
	resp := performJSONRequest(t, server, http.MethodDelete, "/api/lore/items/shared/image", map[string]any{"workspace": workspaceB})
	if resp.Code != http.StatusConflict {
		t.Fatalf("cross-book clear status=%d; body=%s", resp.Code, resp.Body.String())
	}
	if body := resp.Body.String(); strings.Contains(body, workspaceA) || strings.Contains(body, workspaceB) {
		t.Fatalf("conflict leaked workspace path: %s", body)
	}
	for _, workspace := range []string{workspaceA, workspaceB} {
		item, err := book.NewLoreStore(workspace).ReadAny("shared")
		if err != nil || item.Image == nil || item.Image.ImagePath != image.ImagePath {
			t.Fatalf("image changed in %s: item=%#v err=%v", workspace, item, err)
		}
	}
}

func TestGenerateLoreItemImageWorkspaceMismatchStopsBeforeUpstream(t *testing.T) {
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{}})
	}))
	defer upstream.Close()
	root := t.TempDir()
	workspaceA, workspaceB := t.TempDir(), t.TempDir()
	application, err := runtimeapp.New(context.Background(), &config.Config{
		NovaDir: root, Workspace: workspaceA, ResumeLastWorkspace: false,
		ImageAPIKey: "local-test-only", ImageAPIBaseURL: upstream.URL, ImageAPIModel: "test-image",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, workspace := range []string{workspaceA, workspaceB} {
		if _, err := book.NewLoreStore(workspace).Create(book.LoreItemInput{ID: "shared", Type: "character", Name: "同ID", Importance: "major", Content: "正文"}); err != nil {
			t.Fatal(err)
		}
	}
	resp := performJSONRequest(t, NewServer(application, "0"), http.MethodPost, "/api/lore/items/shared/image/generate", map[string]any{
		"workspace": workspaceB, "instruction": "test",
	})
	if resp.Code != http.StatusConflict {
		t.Fatalf("cross-book generate status=%d; body=%s", resp.Code, resp.Body.String())
	}
	if got := upstreamCalls.Load(); got != 0 {
		t.Fatalf("stale cross-book request called upstream %d times", got)
	}
}

func TestBatchLoreImageWorkspaceMismatchStopsBeforeUpstream(t *testing.T) {
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{}})
	}))
	defer upstream.Close()
	root := t.TempDir()
	workspaceA, workspaceB := t.TempDir(), t.TempDir()
	application, err := runtimeapp.New(context.Background(), &config.Config{
		NovaDir: root, Workspace: workspaceA, ResumeLastWorkspace: false,
		ImageAPIKey: "local-test-only", ImageAPIBaseURL: upstream.URL, ImageAPIModel: "test-image",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := book.NewLoreStore(workspaceA).Create(book.LoreItemInput{ID: "batch-shared", Type: "character", Name: "A item", Importance: "major", Content: "正文"}); err != nil {
		t.Fatal(err)
	}
	if _, err := book.NewLoreStore(workspaceB).Create(book.LoreItemInput{ID: "batch-shared", Type: "character", Name: "B item", Importance: "major", Content: "正文"}); err != nil {
		t.Fatal(err)
	}
	resp := performJSONRequest(t, NewServer(application, "0"), http.MethodPost, "/api/lore/images/generate/stream", map[string]any{
		"workspace": workspaceB, "item_ids": []string{"batch-shared"},
	})
	if resp.Code != http.StatusConflict {
		t.Fatalf("cross-book batch status=%d; body=%s", resp.Code, resp.Body.String())
	}
	if body := resp.Body.String(); strings.Contains(body, workspaceA) || strings.Contains(body, workspaceB) {
		t.Fatalf("conflict leaked workspace path: %s", body)
	}
	if got := upstreamCalls.Load(); got != 0 {
		t.Fatalf("cross-book batch called upstream %d times", got)
	}
}

func loreItemExists(t *testing.T, workspace, id string) {
	t.Helper()
	if _, err := book.NewLoreStore(workspace).ReadAny(id); err != nil {
		t.Fatalf("expected item %q to exist in %s: %v", id, workspace, err)
	}
}

func loreItemMissing(t *testing.T, workspace, id string) {
	t.Helper()
	if item, err := book.NewLoreStore(workspace).ReadAny(id); err == nil {
		t.Fatalf("expected item %q to be absent in %s, got %#v", id, workspace, item)
	}
}
