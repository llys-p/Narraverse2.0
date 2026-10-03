package api

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"denova/internal/book"
	"github.com/cloudwego/hertz/pkg/common/ut"
)

func uploadLoreTestFiles(t *testing.T, server *Server, id, workspace string, files ...[]byte) *ut.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("workspace", workspace); err != nil {
		t.Fatal(err)
	}
	for _, data := range files {
		part, err := writer.CreateFormFile("files", "../../chosen.png")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return ut.PerformRequest(server.engine.Engine, http.MethodPost, "/api/lore/items/"+id+"/images",
		&ut.Body{Body: bytes.NewReader(body.Bytes()), Len: body.Len()}, ut.Header{Key: "Content-Type", Value: writer.FormDataContentType()})
}

func TestLoreUploadMultiplePreservesAIAndText(t *testing.T) {
	application := newTestApplication(t)
	server := NewServer(application, "0")
	workspace := application.Workspace()
	store := book.NewLoreStore(workspace)
	item, err := application.CreateLoreItem(book.LoreItemInput{ID: "upload-hero", Name: "Hero", Type: "character", Content: "original"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.SetImage(item.ID, &book.LoreItemImage{ImagePath: "assets/ai.png"}); err != nil {
		t.Fatal(err)
	}
	response := uploadLoreTestFiles(t, server, item.ID, workspace, loreImageTestPNGBytes(), loreImageTestPNGBytes())
	if response.Code != 200 {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var result book.LoreItem
	decodeResponse(t, response.Body.Bytes(), &result)
	if len(result.Images) != 2 || result.Image == nil || result.Image.ImagePath != "assets/ai.png" {
		t.Fatalf("lost images: %+v", result)
	}
	for _, img := range result.Images {
		if filepath.Ext(img.ImagePath) != ".png" || !filepath.IsLocal(img.ImagePath) {
			t.Fatalf("unsafe path %s", img.ImagePath)
		}
		data, err := os.ReadFile(filepath.Join(workspace, filepath.FromSlash(img.ImagePath)))
		if err != nil || !bytes.Equal(data, loreImageTestPNGBytes()) {
			t.Fatalf("uploaded bytes changed: %v", err)
		}
	}
	if result.Images[0].ImagePath == result.Images[1].ImagePath {
		t.Fatal("uploads overwrite one another")
	}
	// Editing text and clearing the AI image must retain every manual attachment.
	if _, err := application.UpdateLoreItem(item.ID, book.LoreItemInput{Name: "Hero", Type: "character", Content: "edited", BaseRevision: result.UpdatedAt}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetImage(item.ID, nil); err != nil {
		t.Fatal(err)
	}
	stored, err := book.NewLoreStore(workspace).ReadAny(item.ID)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(stored)
	result = book.LoreItem{}
	decodeResponse(t, raw, &result)
	if len(result.Images) != 2 || result.Content != "edited" || result.Image != nil {
		t.Fatalf("lost data after text/AI update: %s", raw)
	}
	removed := performJSONRequest(t, server, http.MethodDelete, "/api/lore/items/"+item.ID+"/images", map[string]string{"workspace": workspace, "image_path": result.Images[0].ImagePath})
	if removed.Code != 200 {
		t.Fatalf("remove=%d %s", removed.Code, removed.Body.String())
	}
	var after struct {
		Images []book.LoreItemImage `json:"images"`
	}
	decodeResponse(t, removed.Body.Bytes(), &after)
	if len(after.Images) != 1 || after.Images[0].ImagePath != result.Images[1].ImagePath {
		t.Fatalf("wrong image removed: %+v", after)
	}
	if _, err := os.Stat(filepath.Join(workspace, filepath.FromSlash(result.Images[0].ImagePath))); err != nil {
		t.Fatal("removal must retain asset for recovery")
	}
}

func TestLoreUploadRejectsInvalidBatchAndChangedWorkspace(t *testing.T) {
	application := newTestApplication(t)
	server := NewServer(application, "0")
	item, err := application.CreateLoreItem(book.LoreItemInput{ID: "upload-reject", Name: "Hero", Type: "character"})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name, workspace string
		files           [][]byte
		status          int
	}{
		{"invalid mixed batch", application.Workspace(), [][]byte{loreImageTestPNGBytes(), []byte(`<svg onload="alert(1)"></svg>`)}, 400},
		{"wrong workspace", t.TempDir(), [][]byte{loreImageTestPNGBytes()}, 409},
		{"missing workspace", "", [][]byte{loreImageTestPNGBytes()}, 409},
		{"no files", application.Workspace(), nil, 400},
		{"oversize", application.Workspace(), [][]byte{make([]byte, (10<<20)+1)}, 400},
	} {
		t.Run(c.name, func(t *testing.T) {
			resp := uploadLoreTestFiles(t, server, item.ID, c.workspace, c.files...)
			if resp.Code != c.status {
				t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
			}
		})
	}
	stored, err := book.NewLoreStore(application.Workspace()).ReadAny(item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.UpdatedAt != item.UpdatedAt {
		t.Fatal("rejected batch changed item revision")
	}
	files, _ := filepath.Glob(filepath.Join(application.Workspace(), "assets", "lore", "uploads", "*"))
	if len(files) != 0 {
		t.Fatalf("rejected batch wrote assets: %v", files)
	}
}
