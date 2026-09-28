package handlers

import (
	"encoding/json"
	"testing"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/protocol/consts"

	"denova/internal/book"
)

func TestLibraryMarkerMismatchHasStableReviewCode(t *testing.T) {
	var c app.RequestContext
	writeLibraryMutationError(&c, &book.MasterTranslationMarkerMismatchError{MissingNumbers: 1})
	if got := c.Response.StatusCode(); got != consts.StatusBadRequest {
		t.Fatalf("status = %d, want 400", got)
	}
	var body map[string]string
	if err := json.Unmarshal(c.Response.Body(), &body); err != nil {
		t.Fatal(err)
	}
	if body["code"] != "protected_token_mismatch" || body["error"] == "" {
		t.Fatalf("marker mismatch must be actionable without source content: %#v", body)
	}
}
