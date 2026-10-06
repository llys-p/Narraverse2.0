package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"denova/config"
	novaApp "denova/internal/app"
	"denova/internal/book"
	"denova/internal/bookideation"
)

// The ideation routes are verified end to end against a fixed upstream stub: the
// same trusted server path the product uses, but with zero paid calls.
const ideationTurnStubReply = `{"reply":"建议一：调查为主线；建议二：守灯人为线。","direction":{"summary":"雨港悬疑，调查为主线","genre":"悬疑","tone":"冷峻","conflict":"灯塔失踪案","cast":["守灯人"]},"open_questions":["锈潮钥的归属未说明"]}`

const ideationCandidateStubReply = `{
	  "title": "雾港守灯人",
	  "book_name_suggestions": ["雾港守灯人", "第七灯塔"],
	  "synopsis": "外乡人调查灯塔失踪案。",
	  "overview": "# 雾港\n雨港悬疑世界，灯语即法律。",
	  "items": [
	    {"ref": "c1", "name": "第七灯塔", "type": "location", "load_mode": "resident",
	     "content": "位于雾港北岬的石塔，灯语以三短一长为安全信号。", "origin": "source", "source_refs": ["s0-e0"]},
	    {"ref": "c2", "name": "守灯人", "type": "character", "load_mode": "manual", "character_tier": "major",
	     "content": "世袭职位，不得兼任港务。", "origin": "source", "source_refs": ["s0-e2"]},
	    {"ref": "c3", "name": "外乡调查者", "type": "character", "load_mode": "manual",
	     "content": "自称受托而来。", "origin": "source", "source_refs": ["s404"]}
	  ],
	  "relations": [{"ref": "r1", "source_ref": "c2", "target_ref": "c1", "label": "驻守", "origin": "source", "source_refs": ["s0-e2"]}],
	  "open_questions": ["失踪案时间线原件未说明"]
	}`

const ideationLorebookSource = `{
	  "title": "雾港设定书",
	  "content": "【第七灯塔】\n位于雾港北岬的石塔，灯语以三短一长为安全信号。\n【锈潮钥】\n开启旧港区水闸的钥匙，离开灯塔即失效。\n【守灯人】\n世袭职位，不得兼任港务。"
	}`

// newIdeationStubUpstream answers /chat/completions: the candidate schema marker
// decides which canned reply the ideation chain gets.
func newIdeationStubUpstream(t *testing.T) (*httptest.Server, *int32) {
	t.Helper()
	var calls int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/chat/completions") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		atomic.AddInt32(&calls, 1)
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		content, _ := payload["messages"].(string)
		if raw, ok := payload["messages"].([]any); ok {
			var builder strings.Builder
			for _, item := range raw {
				message, _ := item.(map[string]any)
				text, _ := message["content"].(string)
				builder.WriteString(text)
			}
			content = builder.String()
		}
		reply := ideationTurnStubReply
		if strings.Contains(content, "book_name_suggestions") {
			reply = ideationCandidateStubReply
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "1", "object": "chat.completion", "created": 0, "model": "stub-model",
			"choices": []any{map[string]any{
				"index": 0, "finish_reason": "stop",
				"message": map[string]any{"role": "assistant", "content": reply},
			}},
		})
	}))
	t.Cleanup(upstream.Close)
	return upstream, &calls
}

func newIdeationTestApp(t *testing.T) (*novaApp.App, *int32, string) {
	t.Helper()
	upstream, calls := newIdeationStubUpstream(t)
	root := t.TempDir()
	tokens := 400000
	cfg := &config.Config{
		NovaDir:                   root,
		Workspace:                 root,
		ResumeLastWorkspace:       false,
		OpenAIAPIKey:              "sk-stub",
		OpenAIBaseURL:             upstream.URL,
		OpenAIModel:               "stub-model",
		OpenAIContextWindowTokens: tokens,
		ModelProfiles: []config.ModelProfileSettings{{
			ID: "default", Name: "default",
			OpenAIAPIKey: "sk-stub", OpenAIBaseURL: upstream.URL, OpenAIModel: "stub-model",
			ContextWindowTokens: &tokens,
		}},
		AgentModels: config.AgentModelSettings{
			Default: config.AgentModelOverride{ProfileID: "default"},
			IDE:     config.AgentModelOverride{ProfileID: "default"},
		},
	}
	application, err := novaApp.New(context.Background(), cfg)
	if err != nil {
		t.Fatalf("构造测试 App 失败: %v", err)
	}
	t.Cleanup(application.Close)
	return application, calls, root
}

func decodeIdeationDraft(t *testing.T, body []byte) bookideation.Record {
	t.Helper()
	var payload struct {
		Draft    bookideation.Draft `json:"draft"`
		Revision string             `json:"revision"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("ideation response is not JSON: %v body=%s", err, string(body))
	}
	return bookideation.Record{Draft: payload.Draft, Revision: payload.Revision}
}

func TestBookIdeationRoutesCreateBookOnlyOnConfirm(t *testing.T) {
	application, calls, root := newIdeationTestApp(t)
	server := NewServer(application, "0")

	created := performJSONRequest(t, server, http.MethodPost, "/api/book-ideation/drafts", map[string]any{
		"idea": "外乡人调查灯塔失踪案", "locale": "zh-CN",
	})
	if created.Code != http.StatusOK {
		t.Fatalf("create draft: %d %s", created.Code, created.Body.String())
	}
	record := decodeIdeationDraft(t, created.Body.Bytes())
	draftPath := "/api/book-ideation/drafts/" + record.Draft.ID
	if _, err := os.Stat(filepath.Join(root, "book-ideation", "drafts", record.Draft.ID+".json")); err != nil {
		t.Fatalf("draft is not recoverable after refresh: %v", err)
	}

	// The shelf must stay untouched until the user confirms creation.
	shelf := bookTitles(t, application)
	if len(shelf) != 0 {
		t.Fatalf("a draft appeared on the shelf: %v", shelf)
	}

	withSource := performJSONRequest(t, server, http.MethodPost, draftPath+"/sources", map[string]any{
		"base_revision": record.Revision, "file_name": "fog.json", "content": ideationLorebookSource,
	})
	if withSource.Code != http.StatusOK {
		t.Fatalf("add source: %d %s", withSource.Code, withSource.Body.String())
	}
	record = decodeIdeationDraft(t, withSource.Body.Bytes())
	if len(record.Draft.Sources) != 1 || len(record.Draft.Sources[0].Entries) != 3 {
		t.Fatalf("source intake: %+v", record.Draft.Sources)
	}

	messaged := performJSONRequest(t, server, http.MethodPost, draftPath+"/messages", map[string]any{
		"base_revision": record.Revision, "content": "偏悬疑，少战斗",
	})
	if messaged.Code != http.StatusOK {
		t.Fatalf("send message: %d %s", messaged.Code, messaged.Body.String())
	}
	record = decodeIdeationDraft(t, messaged.Body.Bytes())
	if len(record.Draft.Turns) != 2 || record.Draft.Turns[1].Role != "assistant" {
		t.Fatalf("turns: %+v", record.Draft.Turns)
	}
	if record.Draft.Direction.Summary == "" || record.Draft.Direction.UpdatedBy != "agent" {
		t.Fatalf("direction not recorded: %+v", record.Draft.Direction)
	}

	generated := performJSONRequest(t, server, http.MethodPost, draftPath+"/generate", map[string]any{
		"base_revision": record.Revision, "scope": "all",
	})
	if generated.Code != http.StatusOK {
		t.Fatalf("generate: %d %s", generated.Code, generated.Body.String())
	}
	record = decodeIdeationDraft(t, generated.Body.Bytes())
	pkg := record.Draft.Candidates
	if pkg == nil || len(pkg.Items) != 3 {
		t.Fatalf("candidates: %+v", pkg)
	}
	if pkg.Items[2].Origin != bookideation.OriginAI || !strings.Contains(pkg.Items[2].OpenNotes, "来源依据未命中") {
		t.Fatalf("a bogus source citation was accepted as a source fact: %+v", pkg.Items[2])
	}
	if len(pkg.Relations) != 1 || pkg.Relations[0].Ref != "r1" {
		t.Fatalf("relations: %+v", pkg.Relations)
	}
	if titles := bookTitles(t, application); len(titles) != 0 {
		t.Fatalf("generation created a book before confirm: %v", titles)
	}
	if _, err := os.Stat(filepath.Join(root, "projects", "雾港守灯人")); !os.IsNotExist(err) {
		t.Fatalf("generation wrote into the book directory: %v", err)
	}

	preview := *pkg
	preview.Title = "雾港守灯人"
	preview.Items[2].Excluded = true
	preview.Items[1].Content = "用户改写的守灯人设定。"
	updated := performJSONRequest(t, server, http.MethodPut, draftPath+"/candidates", map[string]any{
		"base_revision": record.Revision, "package": candidatePayload(preview),
	})
	if updated.Code != http.StatusOK {
		t.Fatalf("update candidates: %d %s", updated.Code, updated.Body.String())
	}
	record = decodeIdeationDraft(t, updated.Body.Bytes())
	if !record.Draft.Candidates.Items[1].EditedByUser || record.Draft.Candidates.Items[2].Excluded != true {
		t.Fatalf("preview edits not stored: %+v", record.Draft.Candidates.Items)
	}
	callsBeforeCommit := atomic.LoadInt32(calls)

	committed := performJSONRequest(t, server, http.MethodPost, draftPath+"/commit", map[string]any{
		"base_revision": record.Revision, "request_id": "req-http-1",
	})
	if committed.Code != http.StatusOK {
		t.Fatalf("commit: %d %s", committed.Code, committed.Body.String())
	}
	var receipt struct {
		Receipt bookideation.CommitReceipt `json:"receipt"`
		Draft   bookideation.Draft         `json:"draft"`
	}
	if err := json.Unmarshal(committed.Body.Bytes(), &receipt); err != nil {
		t.Fatalf("commit response: %v %s", err, committed.Body.String())
	}
	if receipt.Receipt.Status != bookideation.CommitComplete {
		t.Fatalf("receipt: %+v", receipt.Receipt)
	}
	if receipt.Draft.Status != bookideation.StatusCommitted {
		t.Fatalf("draft status: %s", receipt.Draft.Status)
	}
	workspace := receipt.Receipt.WorkspacePath
	overviewBytes, err := os.ReadFile(filepath.Join(workspace, "setting", "book-overview.md"))
	if err != nil {
		t.Fatalf("overview was not written: %v", err)
	}
	if !strings.Contains(string(overviewBytes), "雨港悬疑世界") {
		t.Fatalf("overview content: %q", overviewBytes)
	}
	items := loreItems(t, workspace)
	names := loreNames(items)
	if !strings.Contains(names, "第七灯塔") || !strings.Contains(names, "守灯人") || !strings.Contains(names, "锈潮钥") {
		t.Fatalf("confirmed entries missing: %s", names)
	}
	if strings.Contains(names, "外乡调查者") {
		t.Fatalf("an excluded candidate was written: %s", names)
	}
	for _, item := range items {
		if item.Name == "守灯人" && (item.Content != "用户改写的守灯人设定。" || len(item.Relations) != 1) {
			t.Fatalf("manual edit or relation lost: %+v", item)
		}
	}
	if titles := bookTitles(t, application); !strings.Contains(strings.Join(titles, "|"), "雾港守灯人") {
		t.Fatalf("created book missing from the shelf: %v", titles)
	}
	if atomic.LoadInt32(calls) != callsBeforeCommit {
		t.Fatalf("commit called the model: %d -> %d", callsBeforeCommit, atomic.LoadInt32(calls))
	}

	// Repeating the confirm must not create a second book or duplicate entries.
	repeated := performJSONRequest(t, server, http.MethodPost, draftPath+"/commit", map[string]any{
		"base_revision": "stale-on-purpose", "request_id": "req-http-1",
	})
	if repeated.Code != http.StatusOK {
		t.Fatalf("repeat commit: %d %s", repeated.Code, repeated.Body.String())
	}
	if got := len(loreItems(t, workspace)); got != len(items) {
		t.Fatalf("repeat commit duplicated entries: %d -> %d", len(items), got)
	}
	if titles := bookTitles(t, application); len(titles) != 1 {
		t.Fatalf("repeat commit created another book: %v", titles)
	}

	// The committed draft no longer accepts regeneration.
	afterCommit := performJSONRequest(t, server, http.MethodPost, draftPath+"/generate", map[string]any{
		"base_revision": "ignored", "scope": "all",
	})
	if afterCommit.Code != http.StatusBadRequest {
		t.Fatalf("committed draft regeneration: %d %s", afterCommit.Code, afterCommit.Body.String())
	}
}

func TestBookIdeationRoutesRejectStaleAndUnknown(t *testing.T) {
	application, _, _ := newIdeationTestApp(t)
	server := NewServer(application, "0")

	created := decodeIdeationDraft(t, performJSONRequest(t, server, http.MethodPost,
		"/api/book-ideation/drafts", map[string]any{"idea": "测试"}).Body.Bytes())
	draftPath := "/api/book-ideation/drafts/" + created.Draft.ID

	first := performJSONRequest(t, server, http.MethodPatch, draftPath, map[string]any{
		"base_revision": created.Revision, "title": "第一次改名",
	})
	if first.Code != http.StatusOK {
		t.Fatalf("patch: %d %s", first.Code, first.Body.String())
	}
	stale := performJSONRequest(t, server, http.MethodPatch, draftPath, map[string]any{
		"base_revision": created.Revision, "title": "旧视图改名",
	})
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale patch status: %d %s", stale.Code, stale.Body.String())
	}
	if !strings.Contains(stale.Body.String(), "draft_conflict") {
		t.Fatalf("stale patch body: %s", stale.Body.String())
	}
	current := decodeIdeationDraft(t, performJSONRequest(t, server, http.MethodGet, draftPath, nil).Body.Bytes())
	if current.Draft.Title != "第一次改名" {
		t.Fatalf("stale write changed the title: %q", current.Draft.Title)
	}

	unknown := performJSONRequest(t, server, http.MethodGet, "/api/book-ideation/drafts/deadbeefdeadbeef", nil)
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("unknown draft status: %d", unknown.Code)
	}
	traversal := performJSONRequest(t, server, http.MethodGet, "/api/book-ideation/drafts/..%2f..%2fconfig", nil)
	if traversal.Code == http.StatusOK {
		t.Fatalf("path-like draft id was accepted: %s", traversal.Body.String())
	}

	// An unknown field in the request body is refused instead of being ignored.
	badBody := performJSONRequest(t, server, http.MethodPost, draftPath+"/generate", map[string]any{
		"base_revision": current.Revision, "scope": "all", "workspace": "/etc",
	})
	if badBody.Code != http.StatusBadRequest {
		t.Fatalf("unknown field status: %d %s", badBody.Code, badBody.Body.String())
	}

	listed := performJSONRequest(t, server, http.MethodGet, "/api/book-ideation/drafts", nil)
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), created.Draft.ID) {
		t.Fatalf("draft list: %d %s", listed.Code, listed.Body.String())
	}
}

func candidatePayload(pkg bookideation.CandidatePackage) map[string]any {
	items := make([]map[string]any, 0, len(pkg.Items))
	for _, item := range pkg.Items {
		items = append(items, map[string]any{
			"ref": item.Ref, "name": item.Name, "type": item.Type, "content": item.Content,
			"brief_description": item.BriefDescription, "keywords": item.Keywords,
			"load_mode": item.LoadMode, "character_tier": item.CharacterTier,
			"origin": item.Origin, "source_refs": item.SourceRefs, "open_notes": item.OpenNotes,
			"excluded": item.Excluded,
		})
	}
	relations := make([]map[string]any, 0, len(pkg.Relations))
	for _, relation := range pkg.Relations {
		relations = append(relations, map[string]any{
			"ref": relation.Ref, "source_ref": relation.SourceRef, "target_ref": relation.TargetRef,
			"label": relation.Label, "note": relation.Note, "origin": relation.Origin,
			"source_refs": relation.SourceRefs, "excluded": relation.Excluded,
		})
	}
	return map[string]any{
		"title": pkg.Title, "book_name_suggestions": pkg.BookNameSuggestions,
		"synopsis": pkg.Synopsis, "overview": pkg.Overview,
		"items": items, "relations": relations,
		"open_questions": pkg.OpenQuestions, "keep_source_entries": pkg.KeepSourceEntries,
	}
}

func bookTitles(t *testing.T, application *novaApp.App) []string {
	t.Helper()
	var titles []string
	for _, record := range application.Books() {
		titles = append(titles, record.Name)
	}
	return titles
}

func loreItems(t *testing.T, workspace string) []book.LoreItem {
	t.Helper()
	items, err := book.NewLoreStore(workspace).ListAll()
	if err != nil {
		t.Fatalf("ListAll: %v", err)
	}
	return items
}

func loreNames(items []book.LoreItem) string {
	names := make([]string, 0, len(items))
	for _, item := range items {
		names = append(names, item.Name)
	}
	return strings.Join(names, "|")
}
