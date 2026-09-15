package handlers

import (
	"context"
	"strings"
	"testing"

	hzapp "github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/protocol/consts"

	novaApp "denova/internal/app"
)

func TestWorldContextHostWire_ExactKeysAndModelBudget(t *testing.T) {
	if exactObjectKeys([]byte(`{"frameInstance":"abcdefghijklmnop","consumer":"module4"}`), map[string]struct{}{"frameInstance": {}}) == nil {
		t.Fatal("consumer must not be accepted from an iframe transport")
	}
	valid := hostModelCallWire{FrameInstance: "abcdefghijklmnop", Messages: []novaApp.ModelGatewayMessage{{Role: "user", Content: "continue"}}}
	if err := validateHostModelCall(valid); err != nil {
		t.Fatalf("valid host call rejected: %v", err)
	}
	invalidRole := valid
	invalidRole.Messages = []novaApp.ModelGatewayMessage{{Role: "tool", Content: "hidden"}}
	if validateHostModelCall(invalidRole) == nil {
		t.Fatal("tool role must be rejected")
	}
	oversize := valid
	oversize.Messages = []novaApp.ModelGatewayMessage{{Role: "user", Content: strings.Repeat("界", hostModelMaxMessageRunes+1)}}
	if validateHostModelCall(oversize) == nil {
		t.Fatal("oversized message must be rejected")
	}
}

func TestHandleModelChat_RejectsWorldControlFields(t *testing.T) {
	h, _, _, _ := newPreviewHarness(t)
	ctx := hzapp.NewContext(0)
	ctx.Request.Header.Set("Content-Type", "application/json")
	ctx.Request.SetBodyString(`{"module":"narraverse","messages":[{"role":"user","content":"hello"}],"world_context":{"worldId":"w1"}}`)
	h.HandleModelChat(context.Background(), ctx)
	if ctx.Response.StatusCode() != consts.StatusForbidden {
		t.Fatalf("status=%d body=%s", ctx.Response.StatusCode(), ctx.Response.Body())
	}
	if !strings.Contains(string(ctx.Response.Body()), "consumer_not_trusted") {
		t.Fatalf("missing safe code: %s", ctx.Response.Body())
	}
}

func TestHandleModelChat_RejectsUnknownAndTrailingJSON(t *testing.T) {
	h, _, _, _ := newPreviewHarness(t)
	for _, body := range []string{
		`{"module":"narraverse","messages":[{"role":"user","content":"hello"}],"unknown":true}`,
		`{"module":"narraverse","messages":[]} {}`,
	} {
		ctx := hzapp.NewContext(0)
		ctx.Request.Header.Set("Content-Type", "application/json")
		ctx.Request.SetBodyString(body)
		h.HandleModelChat(context.Background(), ctx)
		if ctx.Response.StatusCode() != consts.StatusBadRequest {
			t.Fatalf("body=%s status=%d response=%s", body, ctx.Response.StatusCode(), ctx.Response.Body())
		}
	}
}
