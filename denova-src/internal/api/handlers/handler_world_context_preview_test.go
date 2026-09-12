package handlers

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	hzapp "github.com/cloudwego/hertz/pkg/app"
	hertzserver "github.com/cloudwego/hertz/pkg/app/server"
	"github.com/cloudwego/hertz/pkg/common/ut"
	"github.com/cloudwego/hertz/pkg/protocol/consts"

	"denova/config"
	novaApp "denova/internal/app"
	"denova/internal/world"
	"denova/internal/worldcontext"
)

// newPreviewHarness 构造真实 App（临时全局 DataDir）并创建一个带设定与角色的 active 世界。
func newPreviewHarness(t *testing.T) (*Handlers, *novaApp.App, world.World, string) {
	t.Helper()
	cfg := &config.Config{Workspace: t.TempDir()}
	cfg.SetDataDir(t.TempDir())
	application, err := novaApp.New(context.Background(), cfg)
	if err != nil {
		t.Fatalf("构造测试 App 失败: %v", err)
	}
	w, rev, err := application.CreateWorld(context.Background(), world.CreateInput{
		Name:    "预览世界",
		Summary: "一片正在形成的大陆。",
		WorldSetting: &world.WorldSetting{
			Tone:  "冷峻",
			Rules: []string{"魔法有代价"},
		},
		Characters: []world.Character{{
			ID: "c1", DisplayName: "艾兰", Role: world.RoleMajor, WorldNote: "主角备注",
		}},
	})
	if err != nil {
		t.Fatalf("准备世界失败: %v", err)
	}
	return New(application), application, w, rev
}

func previewEngine(h *Handlers) *hertzserver.Hertz {
	server := hertzserver.Default()
	server.POST("/api/worlds/:id/context-preview", h.HandleWorldContextPreview)
	return server
}

func doPreview(t *testing.T, h *Handlers, worldID, rawBody string) (int, []byte) {
	t.Helper()
	engine := previewEngine(h)
	body := []byte(rawBody)
	resp := ut.PerformRequest(
		engine.Engine, "POST", "/api/worlds/"+worldID+"/context-preview",
		&ut.Body{Body: bytes.NewReader(body), Len: len(body)},
		ut.Header{Key: "Content-Type", Value: "application/json"},
	)
	return resp.Code, resp.Body.Bytes()
}

func previewBody(rev string, consumer string, extraSelection string) string {
	sel := `"includeTone":true`
	if extraSelection != "" {
		sel += "," + extraSelection
	}
	return `{"consumer":"` + consumer + `","expectedWorldRevision":"` + rev + `","selection":{` + sel + `}}`
}

func TestHandleWorldContextPreview_SuccessWriting(t *testing.T) {
	h, _, w, rev := newPreviewHarness(t)
	code, body := doPreview(t, h, w.ID, previewBody(rev, "writing", `"characterIds":["c1"],"ruleIndexes":[0]`))
	if code != consts.StatusOK {
		t.Fatalf("status=%d body=%s", code, body)
	}
	raw := string(body)
	// 身份与投影内容。
	for _, want := range []string{`"name":"预览世界"`, `"contextFingerprint":"v1|`, `"revisionLabel":"sha256:`} {
		if !strings.Contains(raw, want) {
			t.Fatalf("响应缺少 %s: %s", want, raw)
		}
	}
	if !strings.Contains(raw, `"displayName":"艾兰"`) {
		t.Fatalf("入选角色未投影: %s", raw)
	}
}

func TestHandleWorldContextPreview_GameConsumerAllowed(t *testing.T) {
	h, _, w, rev := newPreviewHarness(t)
	if code, body := doPreview(t, h, w.ID, previewBody(rev, "game", "")); code != consts.StatusOK {
		t.Fatalf("game consumer 应可预览: status=%d body=%s", code, body)
	}
}

// canonicalSelection 必须严格 camelCase，内部无 tag 的 Selection 不得泄漏 PascalCase。
func TestHandleWorldContextPreview_CanonicalSelectionIsCamelCase(t *testing.T) {
	h, _, w, rev := newPreviewHarness(t)
	_, body := doPreview(t, h, w.ID, previewBody(rev, "writing", `"characterIds":["c1"]`))
	raw := string(body)
	if !strings.Contains(raw, `"canonicalSelection":{`) || !strings.Contains(raw, `"characterIds":["c1"]`) || !strings.Contains(raw, `"includeTone":true`) {
		t.Fatalf("canonicalSelection camelCase 异常: %s", raw)
	}
	for _, banned := range []string{"CanonicalSelection", "IncludeTone", "CharacterIDs", "RuleIndexes", "BindingIDs"} {
		if strings.Contains(raw, banned) {
			t.Fatalf("响应泄漏内部 PascalCase 字段 %s: %s", banned, raw)
		}
	}
}

// 响应只含 UI Projection：禁止任何模型/运行态字段。
func TestHandleWorldContextPreview_NoModelOrRuntimeFieldsAndWorldUnchanged(t *testing.T) {
	h, app, w, rev := newPreviewHarness(t)
	_, before, err := app.GetWorld(context.Background(), w.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, body := doPreview(t, h, w.ID, previewBody(rev, "writing", `"characterIds":["c1"]`))
	raw := strings.ToLower(string(body))
	for _, banned := range []string{"modelview", "projectionbody", "projection_body", "sideref", "sourceRef", "runsalt", "runcontext", "run_context", "sidecar"} {
		if strings.Contains(raw, strings.ToLower(banned)) {
			t.Fatalf("响应泄漏禁止字段 %s: %s", banned, body)
		}
	}
	_, after, err := app.GetWorld(context.Background(), w.ID)
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatalf("只读预览改变了 World revision：before=%s after=%s", before, after)
	}
}

func TestHandleWorldContextPreview_RejectsBodyWorldIDAndUnknownFields(t *testing.T) {
	h, _, w, rev := newPreviewHarness(t)
	// body 内 worldId 是双来源，严格解码必须拒绝。
	body := `{"consumer":"writing","expectedWorldRevision":"` + rev + `","worldId":"` + w.ID + `","selection":{}}`
	code, resp := doPreview(t, h, w.ID, body)
	if code != consts.StatusBadRequest || !strings.Contains(string(resp), "invalid_request") {
		t.Fatalf("body worldId 应 400 invalid_request，got %d %s", code, resp)
	}
	// selection 内未知字段同样拒绝。
	code, resp = doPreview(t, h, w.ID, `{"consumer":"writing","expectedWorldRevision":"`+rev+`","selection":{"bogus":1}}`)
	if code != consts.StatusBadRequest {
		t.Fatalf("selection 未知字段应 400，got %d %s", code, resp)
	}
	// 尾随 JSON 拒绝。
	code, resp = doPreview(t, h, w.ID, previewBody(rev, "writing", "")+`{"extra":1}`)
	if code != consts.StatusBadRequest {
		t.Fatalf("尾随 JSON 应 400，got %d %s", code, resp)
	}
}

func TestHandleWorldContextPreview_EmptyAndOversizedBody(t *testing.T) {
	h, _, w, _ := newPreviewHarness(t)
	if code, _ := doPreview(t, h, w.ID, ""); code != consts.StatusBadRequest {
		t.Fatalf("空 body 应 400，got %d", code)
	}
	big := strings.Repeat("a", maxContextPreviewRequestBodyBytes+1)
	if code, body := doPreview(t, h, w.ID, big); code != consts.StatusBadRequest || !strings.Contains(string(body), "invalid_request") {
		t.Fatalf("超 64KiB 应 400 invalid_request，got %d %s", code, body)
	}
}

func TestHandleWorldContextPreview_ConsumerNotTrusted(t *testing.T) {
	h, _, w, rev := newPreviewHarness(t)
	for _, consumer := range []string{"", "narraverse", "module4", "bogus"} {
		code, body := doPreview(t, h, w.ID, previewBody(rev, consumer, ""))
		if code != consts.StatusForbidden || !strings.Contains(string(body), "consumer_not_trusted") {
			t.Fatalf("consumer=%q 应 403 consumer_not_trusted，got %d %s", consumer, code, body)
		}
	}
}

func TestHandleWorldContextPreview_WorldNotFound(t *testing.T) {
	h, _, _, _ := newPreviewHarness(t)
	code, body := doPreview(t, h, "w0123456789abcdef0123", previewBody("sha256:abc", "writing", ""))
	if code != consts.StatusNotFound || !strings.Contains(string(body), "world_not_found") {
		t.Fatalf("不存在世界应 404 world_not_found，got %d %s", code, body)
	}
}

func TestHandleWorldContextPreview_RevisionConflict(t *testing.T) {
	h, _, w, _ := newPreviewHarness(t)
	code, body := doPreview(t, h, w.ID, previewBody("sha256:does-not-match", "writing", ""))
	if code != consts.StatusConflict || !strings.Contains(string(body), "revision_conflict") {
		t.Fatalf("revision 不匹配应 409 revision_conflict，got %d %s", code, body)
	}
}

func TestHandleWorldContextPreview_InvalidRevisionShape(t *testing.T) {
	h, _, w, _ := newPreviewHarness(t)
	code, body := doPreview(t, h, w.ID, previewBody("no-prefix", "writing", ""))
	if code != consts.StatusBadRequest || !strings.Contains(string(body), "invalid_request") {
		t.Fatalf("非法 revision 形状应 400 invalid_request，got %d %s", code, body)
	}
}

func TestHandleWorldContextPreview_Archived(t *testing.T) {
	h, app, w, rev := newPreviewHarness(t)
	archived, newRev, err := app.ArchiveWorld(context.Background(), w.ID, rev, true)
	if err != nil || archived.Status != world.StatusArchived {
		t.Fatalf("归档准备失败: %v %+v", err, archived)
	}
	code, body := doPreview(t, h, w.ID, previewBody(newRev, "writing", ""))
	if code != consts.StatusConflict || !strings.Contains(string(body), "world_archived") {
		t.Fatalf("已归档世界应 409 world_archived，got %d %s", code, body)
	}
}

// 错误码 → HTTP 状态映射全量锁定（含不易走真实链路触发的 413/500/503）。
func TestContextPreviewErrorStatusMapping(t *testing.T) {
	cases := map[worldcontext.ErrorCode]int{
		worldcontext.ErrInvalidRequest:     consts.StatusBadRequest,
		worldcontext.ErrSelectionInvalid:   consts.StatusBadRequest,
		worldcontext.ErrConsumerNotTrusted: consts.StatusForbidden,
		worldcontext.ErrWorldNotFound:      consts.StatusNotFound,
		worldcontext.ErrRevisionConflict:   consts.StatusConflict,
		worldcontext.ErrWorldArchived:      consts.StatusConflict,
		worldcontext.ErrBudgetExceeded:     consts.StatusRequestEntityTooLarge,
		worldcontext.ErrWorldUnavailable:   consts.StatusServiceUnavailable,
		worldcontext.ErrContextUnavailable: consts.StatusServiceUnavailable,
		worldcontext.ErrProjectionFailed:   consts.StatusInternalServerError,
	}
	for code, want := range cases {
		if got := contextPreviewErrorStatus(code); got != want {
			t.Errorf("code=%s got=%d want=%d", code, got, want)
		}
	}
}

// 非领域错误必须脱敏为通用文案，不回传内部 err.Error()。
func TestWriteContextPreviewErrorSanitizesGenericError(t *testing.T) {
	c := hzapp.NewContext(0)
	writeContextPreviewError(c, errors.New("boom at secret-internal-path"))
	body := string(c.Response.Body())
	if strings.Contains(body, "secret-internal-path") {
		t.Fatalf("内部错误细节泄漏: %s", body)
	}
	if !strings.Contains(body, "projection_failed") || !strings.Contains(body, "世界上下文预览失败") {
		t.Fatalf("非领域错误应通用脱敏: %s", body)
	}
}
