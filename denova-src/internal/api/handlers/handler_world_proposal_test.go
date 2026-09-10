package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/protocol/consts"

	"denova/config"
	novaApp "denova/internal/app"
)

// ---- 夹具：构造一个最小可用的 Master Library（manifest + item + 原件归档） ----

func writeProposalMasterFixture(t *testing.T, root, masterItemID, recordKind string, fields map[string]map[string]string) (workspace, masterRevision string) {
	t.Helper()
	workspace = filepath.Join(root, "projects", "book-a")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatal(err)
	}
	libRoot := filepath.Join(root, "projects", "narraverse-master-library")
	// item 落盘路径由 masterItemRelPath 决定：.narraverse/master/items/<id>.json
	itemRel := filepath.ToSlash(filepath.Join(".narraverse", "master", "items", masterItemID+".json"))
	originalRel := "originals/" + masterItemID + ".json"
	for _, dir := range []string{
		filepath.Join(libRoot, ".narraverse", "master", "items"),
		filepath.Join(libRoot, "originals"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	masterRevision = "sha256:item-" + masterItemID

	item := map[string]any{
		"schema_version": 3, "data_version": 3,
		"revision":                masterRevision,
		"master_item_id":          masterItemID,
		"source_id":               "src-1",
		"source_revision":         "rev-1",
		"record_kind":             recordKind,
		"semantic_type":           map[string]string{"character_template": "character", "lorebook_template": "lorebook"}[recordKind],
		"original":                map[string]any{"name": "夹具"},
		"source_semantics":        map[string]any{"name": "夹具"},
		"runtime_semantics":       map[string]any{"name": "夹具"},
		"fields":                  fields,
		"active_working_revision": masterRevision,
	}
	writeJSONFile(t, filepath.Join(libRoot, filepath.FromSlash(itemRel)), item)

	manifest := map[string]any{
		"schema_version": 3, "data_version": 3,
		"revision": "sha256:manifest", "updated_at": "2026-09-10T00:00:00Z",
		"sources": []any{map[string]any{
			"source_id": "src-1", "source_kind": "json", "filename": masterItemID + ".json",
			"current_revision": "rev-1",
			"revisions": []any{map[string]any{
				"revision": "rev-1", "sha256": "x", "bytes": 2,
				"original_path": originalRel, "imported_at": "2026-09-10T00:00:00Z",
			}},
		}},
		"items": []any{map[string]any{
			"master_item_id": masterItemID, "source_id": "src-1", "source_revision": "rev-1",
			"record_kind": recordKind, "path": itemRel, "revision": masterRevision,
		}},
		"translations": []any{}, "imports": []any{}, "instances": []any{},
	}
	writeJSONFile(t, filepath.Join(libRoot, ".narraverse", "master-library-manifest.json"), manifest)
	// 原件归档必须存在（否则归档节点判定失败 → 非 usable）。
	if err := os.WriteFile(filepath.Join(libRoot, filepath.FromSlash(originalRel)), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	return workspace, masterRevision
}

func writeJSONFile(t *testing.T, path string, payload any) {
	t.Helper()
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// newProposalTestApp 构造真实 App（仅替换模型上游为 httptest 假服务，不调用真实模型）。
func newProposalTestApp(t *testing.T, workspace string, modelContent string, contextWindowTokens int) (*novaApp.App, *int) {
	t.Helper()
	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/chat/completions") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		upstreamCalls++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "1", "object": "chat.completion", "created": 0, "model": "test-model",
			"choices": []any{map[string]any{
				"index": 0, "finish_reason": "stop",
				"message": map[string]any{"role": "assistant", "content": modelContent},
			}},
		})
	}))
	t.Cleanup(upstream.Close)

	novaDir := t.TempDir()
	cfg := &config.Config{
		Workspace:                 workspace,
		NovaDir:                   novaDir,
		OpenAIAPIKey:              "sk-test",
		OpenAIBaseURL:             upstream.URL,
		OpenAIModel:               "test-model",
		OpenAIContextWindowTokens: contextWindowTokens,
		ModelProfiles: []config.ModelProfileSettings{{
			ID: "default", Name: "default",
			OpenAIAPIKey: "sk-test", OpenAIBaseURL: upstream.URL, OpenAIModel: "test-model",
			ContextWindowTokens: &contextWindowTokens,
		}},
		AgentModels: config.AgentModelSettings{
			InteractiveStory: config.AgentModelOverride{ProfileID: "default"},
		},
	}
	application, err := novaApp.New(context.Background(), cfg)
	if err != nil {
		t.Fatalf("构造测试 App 失败: %v", err)
	}
	return application, &upstreamCalls
}

func doProposalRequest(t *testing.T, h *Handlers, body string) *app.RequestContext {
	t.Helper()
	c := app.NewContext(0)
	c.Request.SetMethod("POST")
	c.Request.SetRequestURI("/api/world-proposals")
	c.Request.Header.Set("Content-Type", "application/json")
	c.Request.SetBody([]byte(body))
	h.HandleWorldProposal(context.Background(), c)
	return c
}

// ---- 测试 ----

func TestHandleWorldProposal_FullPipelineWithMockedModel(t *testing.T) {
	root := t.TempDir()
	fields := map[string]map[string]string{
		"character.name":        {"source_text": "艾兰妮", "active_text": "艾兰妮"},
		"character.personality": {"source_text": "冷静", "active_text": "冷静"},
	}
	workspace, revision := writeProposalMasterFixture(t, root, "m-char-1", "character_template", fields)

	modelReply := `{"characters":[{"sourceRefIds":["s0"],"confidence":"high","displayName":"艾兰妮","role":"major","worldNote":"提案备注"}],"locations":[],"factions":[]}`
	application, calls := newProposalTestApp(t, workspace, modelReply, 400000)
	h := New(application)

	body := `{"sources":[{"masterItemId":"m-char-1","expectedMasterRevision":"` + revision + `","fieldPaths":["character.name","character.personality"]}]}`
	c := doProposalRequest(t, h, body)

	if got := c.Response.StatusCode(); got != consts.StatusOK {
		t.Fatalf("status = %d body = %s", got, string(c.Response.Body()))
	}
	if *calls != 1 {
		t.Fatalf("upstream model calls = %d, want 1", *calls)
	}

	var resp struct {
		Proposal struct {
			SchemaVersion int `json:"schemaVersion"`
			SourceRefs    []struct {
				ID           string `json:"id"`
				FieldPath    string `json:"fieldPath"`
				MasterItemID string `json:"masterItemId"`
			} `json:"sourceRefs"`
			BindingCandidates []struct {
				BindingCandidateID string `json:"bindingCandidateId"`
				MasterItemID       string `json:"masterItemId"`
				SemanticType       string `json:"semanticType"`
				Scope              string `json:"scope"`
				RecordKind         string `json:"recordKind"`
			} `json:"bindingCandidates"`
			Characters []struct {
				ProposalItemID string `json:"proposalItemId"`
				DisplayName    string `json:"displayName"`
				Role           string `json:"role"`
				WorldNote      string `json:"worldNote"`
			} `json:"characters"`
			GeneratedAt string `json:"generatedAt"`
		} `json:"proposal"`
	}
	if err := json.Unmarshal(c.Response.Body(), &resp); err != nil {
		t.Fatalf("响应不是合法 JSON: %v body=%s", err, string(c.Response.Body()))
	}
	p := resp.Proposal
	if p.SchemaVersion != 1 || p.GeneratedAt == "" {
		t.Fatalf("服务端盖章字段缺失: %+v", p)
	}
	if len(p.SourceRefs) != 2 || p.SourceRefs[0].MasterItemID != "m-char-1" || p.SourceRefs[0].FieldPath != "character.name" {
		t.Fatalf("sourceRefs 不符合预期: %+v", p.SourceRefs)
	}
	if len(p.BindingCandidates) != 1 {
		t.Fatalf("bindingCandidates = %+v", p.BindingCandidates)
	}
	bc := p.BindingCandidates[0]
	if bc.MasterItemID != "m-char-1" || bc.RecordKind != "character_template" || bc.SemanticType != "character" || bc.Scope != "entity" || bc.BindingCandidateID == "" {
		t.Fatalf("bindingCandidate 盖章不符合预期: %+v", bc)
	}
	if len(p.Characters) != 1 {
		t.Fatalf("characters = %+v", p.Characters)
	}
	ch := p.Characters[0]
	if ch.DisplayName != "艾兰妮" || ch.Role != "major" || ch.WorldNote != "提案备注" || ch.ProposalItemID == "" {
		t.Fatalf("character 不符合预期: %+v", ch)
	}
}

func TestHandleWorldProposal_StrictDecodeRejectsUnknownFieldAndTrailingJSON(t *testing.T) {
	// 严格解码在触达服务前完成，无需可用的 Master/模型。
	h := New(nil)
	cases := map[string]string{
		"未知字段":   `{"sources":[],"unknownField":1}`,
		"尾随JSON": `{"sources":[]}{"sources":[]}`,
	}
	for name, body := range cases {
		c := doProposalRequest(t, h, body)
		if got := c.Response.StatusCode(); got != consts.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400 (body=%s)", name, got, string(c.Response.Body()))
			continue
		}
		if !strings.Contains(string(c.Response.Body()), "invalid_request") {
			t.Errorf("%s: body 缺少 invalid_request 码: %s", name, string(c.Response.Body()))
		}
	}
}

func TestHandleWorldProposal_ModelNotConfigured(t *testing.T) {
	root := t.TempDir()
	fields := map[string]map[string]string{"character.name": {"source_text": "A", "active_text": "A"}}
	workspace, revision := writeProposalMasterFixture(t, root, "m-char-2", "character_template", fields)

	// 未配置模型（无 base URL/key）→ 领域错误 not_configured，且不产生 proposal。
	cfg := &config.Config{Workspace: workspace, NovaDir: t.TempDir()}
	application, err := novaApp.New(context.Background(), cfg)
	if err != nil {
		t.Fatalf("构造测试 App 失败: %v", err)
	}
	h := New(application)
	body := `{"sources":[{"masterItemId":"m-char-2","expectedMasterRevision":"` + revision + `","fieldPaths":["character.name"]}]}`
	c := doProposalRequest(t, h, body)

	if got := c.Response.StatusCode(); got == consts.StatusOK {
		t.Fatalf("未配置模型不应成功: %s", string(c.Response.Body()))
	}
	if !strings.Contains(string(c.Response.Body()), "not_configured") {
		t.Fatalf("期望 not_configured，实际: %s", string(c.Response.Body()))
	}
}

func TestHandleWorldProposal_ContextWindowTooSmallRejects(t *testing.T) {
	root := t.TempDir()
	fields := map[string]map[string]string{"character.name": {"source_text": "A", "active_text": "A"}}
	workspace, revision := writeProposalMasterFixture(t, root, "m-char-3", "character_template", fields)

	// contextWindowTokens = 8191 → 预算 2047 < 2048，必须在调用模型前拒绝。
	application, calls := newProposalTestApp(t, workspace, `{"characters":[],"locations":[],"factions":[]}`, 8191)
	h := New(application)
	body := `{"sources":[{"masterItemId":"m-char-3","expectedMasterRevision":"` + revision + `","fieldPaths":["character.name"]}]}`
	c := doProposalRequest(t, h, body)

	if got := c.Response.StatusCode(); got != consts.StatusRequestEntityTooLarge && got != consts.StatusBadRequest {
		t.Fatalf("status = %d body = %s", got, string(c.Response.Body()))
	}
	if !strings.Contains(string(c.Response.Body()), "input_too_large") {
		t.Fatalf("期望 input_too_large，实际: %s", string(c.Response.Body()))
	}
	if *calls != 0 {
		t.Fatalf("预算不足时不得调用模型，实际调用 %d 次", *calls)
	}
}
