package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"denova/internal/library"
	"github.com/cloudwego/hertz/pkg/common/ut"
)

func TestLibraryContextPreviewHTTPReadOnly(t *testing.T) {
	dir := t.TempDir()
	a := newNoBookApplication(t, dir)
	s := NewServer(a, "0")
	ctx := context.Background()
	l, _, err := a.CreateWorkLibrary(ctx, library.CreateInput{Name: "预览测试"})
	if err != nil {
		t.Fatal(err)
	}
	text := "只读正文"
	_, rev, err := a.CreateWorkLibraryItem(ctx, l.ID, library.ItemInput{Name: "规则", Type: "rule", LoadMode: "resident", Content: &text})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "libraries", "library-"+l.ID+".json")
	before, _ := os.ReadFile(path)
	response := performJSONRequest(t, s, http.MethodPost, "/api/work-libraries/"+l.ID+"/context-preview", map[string]any{"expectedRevision": rev})
	if response.Code != 200 {
		t.Fatalf("status=%d %s", response.Code, response.Body.String())
	}
	var p map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if len(p["loaded"].([]any)) != 1 || p["revision"] != rev || p["issues"] == nil || p["relations"] == nil {
		t.Fatalf("%#v", p)
	}
	if int(p["budget"].(map[string]any)["bytes"].(float64)) != response.Body.Len() {
		t.Fatal("wire response differs from measured byte budget")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("preview changed file")
	}
	for _, key := range []string{"runContextId", "scopeKey", "modelView", "runSalt", "analysisHandle"} {
		if strings.Contains(response.Body.String(), key) {
			t.Fatal("runtime field leaked")
		}
	}
	conflict := performJSONRequest(t, s, http.MethodPost, "/api/work-libraries/"+l.ID+"/context-preview", map[string]any{"expectedRevision": "old"})
	if conflict.Code != 409 {
		t.Fatalf("revision status %d", conflict.Code)
	}
}

func TestLibraryContextPreviewHTTPRejectsMalformedControl(t *testing.T) {
	a := newNoBookApplication(t, "")
	s := NewServer(a, "0")
	cases := []string{
		`{}`, `null`, `[]`, `{"expectedRevision":null}`, `{"ExpectedRevision":"x"}`,
		`{"expectedRevision":"x","worldId":"y"}`, `{"expectedRevision":"x","runContextId":"r"}`,
		`{"expectedRevision":"x","consumer":"writing"}`, `{"expectedRevision":"x","expectedRevision":"y"}`,
		`{"expectedRevision":"x","manualItemIds":[null]}`, `{"expectedRevision":"x","autoItemIds":null}`,
		`{"expectedRevision":"x","catalogLimit":null}`, `{"expectedRevision":"x"}{}`,
	}
	for _, body := range cases {
		result := ut.PerformRequest(s.engine.Engine, http.MethodPost, "/api/work-libraries/abcdefghijklmnop/context-preview",
			&ut.Body{Body: strings.NewReader(body), Len: len(body)}, ut.Header{Key: "Content-Type", Value: "application/json"})
		if result.Result().StatusCode() != 400 {
			t.Errorf("accepted %s: %d", body, result.Result().StatusCode())
		}
	}
}

func TestLibraryContextPreviewHTTPErrorAndConcurrency(t *testing.T) {
	dir := t.TempDir()
	a := newNoBookApplication(t, dir)
	s := NewServer(a, "0")
	ctx := context.Background()
	l, rev, err := a.CreateWorkLibrary(ctx, library.CreateInput{Name: "boundary"})
	if err != nil {
		t.Fatal(err)
	}
	url := "/api/work-libraries/" + l.ID + "/context-preview"
	file := filepath.Join(dir, "libraries", "library-"+l.ID+".json")
	before, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			body, _ := json.Marshal(map[string]any{"expectedRevision": rev})
			r := ut.PerformRequest(s.engine.Engine, http.MethodPost, url, &ut.Body{Body: strings.NewReader(string(body)), Len: len(body)})
			if r.Result().StatusCode() != 200 {
				t.Errorf("concurrent status %d", r.Result().StatusCode())
			}
		}()
	}
	wg.Wait()
	after, err := os.ReadFile(file)
	if err != nil || string(before) != string(after) {
		t.Fatal("concurrent preview wrote data")
	}
	for _, tc := range []struct {
		url     string
		request map[string]any
		status  int
		code    string
	}{
		{url, map[string]any{"expectedRevision": rev, "autoItemIds": []string{"missing"}}, 400, "selection_invalid"},
		{"/api/work-libraries/zzzzzzzzzzzzzzzz/context-preview", map[string]any{"expectedRevision": rev}, 404, "library_not_found"},
	} {
		r := performJSONRequest(t, s, http.MethodPost, tc.url, tc.request)
		if r.Code != tc.status || !strings.Contains(r.Body.String(), tc.code) {
			t.Fatalf("%d %s", r.Code, r.Body.String())
		}
	}
	large := strings.Repeat("字", 12000)
	_, rev, err = a.CreateWorkLibraryItem(ctx, l.ID, library.ItemInput{Name: "large", Type: "rule", LoadMode: "resident", Content: &large})
	if err != nil {
		t.Fatal(err)
	}
	r := performJSONRequest(t, s, http.MethodPost, url, map[string]any{"expectedRevision": rev})
	if r.Code != 413 || !strings.Contains(r.Body.String(), "budget_exceeded") {
		t.Fatalf("budget %d %s", r.Code, r.Body.String())
	}
	if err := os.WriteFile(file, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	r = performJSONRequest(t, s, http.MethodPost, url, map[string]any{"expectedRevision": rev})
	if r.Code != 500 || !strings.Contains(r.Body.String(), "library_unavailable") || strings.Contains(r.Body.String(), dir) {
		t.Fatalf("corruption %d %s", r.Code, r.Body.String())
	}
}

func TestLibraryItemHTTPRequiresUpdateBaseline(t *testing.T) {
	dir := t.TempDir()
	a := newNoBookApplication(t, dir)
	s := NewServer(a, "0")
	ctx := context.Background()
	l, _, err := a.CreateWorkLibrary(ctx, library.CreateInput{Name: "cas"})
	if err != nil {
		t.Fatal(err)
	}
	i, rev, err := a.CreateWorkLibraryItem(ctx, l.ID, library.ItemInput{Name: "original", Type: "rule"})
	if err != nil {
		t.Fatal(err)
	}
	for _, base := range []any{nil, "", "  "} {
		input := map[string]any{"name": "must not write"}
		if base != nil {
			input["baseUpdatedAt"] = base
		}
		r := performJSONRequest(t, s, http.MethodPatch, "/api/work-libraries/"+l.ID+"/items/"+i.ID, input)
		if r.Code != 400 {
			t.Errorf("empty baseline accepted: %d", r.Code)
		}
	}
	got, after, err := a.GetWorkLibrary(ctx, l.ID)
	if err != nil || after != rev || got.Items[0].Name != "original" {
		t.Fatal("missing baseline modified library")
	}
}
