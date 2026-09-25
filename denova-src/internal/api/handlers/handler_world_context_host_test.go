package handlers

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	hzapp "github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/protocol/consts"

	novaApp "denova/internal/app"
)

// B4a（L3.3 叙界）：iframe 库载体的 wire 校验——载体互斥、严格字段、空白拒绝。
func TestWorldContextHostWire_LibraryCarrierValidation(t *testing.T) {
	if !hostBindCarrierConflict(hostBindWire{
		WorldContext:   json.RawMessage(`{"worldId":"w1"}`),
		LibraryContext: json.RawMessage(`{"libraryId":"l1"}`),
	}) {
		t.Fatal("world+library carriers in one bind must conflict")
	}
	if hostBindCarrierConflict(hostBindWire{WorldContext: json.RawMessage(`{"worldId":"w1"}`)}) {
		t.Fatal("a single carrier must not conflict")
	}
	if hostRawPresent(json.RawMessage(`  `)) {
		t.Fatal("blank carrier must be treated as absent")
	}
	ctrl, err := decodeHostLibraryContext(json.RawMessage(`{"libraryId":" lib-1 ","expectedRevision":" rev-1 ","manualItemIds":[" m1 ","m2"]}`))
	if err != nil || ctrl.LibraryID != "lib-1" || ctrl.ExpectedRevision != "rev-1" || len(ctrl.ManualItemIDs) != 2 || ctrl.ManualItemIDs[0] != "m1" {
		t.Fatalf("ctrl=%+v err=%v", ctrl, err)
	}
	for _, bad := range []string{
		`{"libraryId":"l","expectedRevision":"r","consumer":"narraverse"}`,
		`{"libraryId":"","expectedRevision":"r"}`,
		`{"libraryId":"l","expectedRevision":" "}`,
		`{"libraryId":"l","expectedRevision":"r","manualItemIds":[" "]}`,
		`{"libraryId":"l","expectedRevision":"r","manualItemIds":"m1"}`,
		`null`,
		`[]`,
	} {
		if _, err := decodeHostLibraryContext(json.RawMessage(bad)); err == nil {
			t.Fatalf("bad library carrier accepted: %s", bad)
		}
	}
}

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
