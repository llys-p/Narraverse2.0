package handlers

import (
	"strings"
	"testing"

	"github.com/cloudwego/hertz/pkg/app"

	"denova/internal/revisionfile"
)

func TestWorldRequestBodyLimit(t *testing.T) {
	c := app.NewContext(0)
	c.Request.SetBody(make([]byte, maxWorldRequestBodyBytes+1))
	if _, err := worldRequestBody(c); err == nil {
		t.Fatal("oversized world request must fail")
	}

	c.Request.SetBody(make([]byte, maxWorldRequestBodyBytes))
	if _, err := worldRequestBody(c); err != nil {
		t.Fatalf("request at limit must pass: %v", err)
	}
}

func TestWorldConflictResponseDoesNotLeakStoragePath(t *testing.T) {
	c := app.NewContext(0)
	writeWorldError(c, &revisionfile.ConflictError{
		Path:     `C:\Users\secret\worlds\world-abcdef0123456789.json`,
		Expected: "sha256:old",
		Actual:   "sha256:new",
	})
	body := string(c.Response.Body())
	if strings.Contains(body, `C:\Users\secret`) {
		t.Fatalf("response leaked storage path: %s", body)
	}
	if !strings.Contains(body, "sha256:old") || !strings.Contains(body, "sha256:new") {
		t.Fatalf("response omitted conflict revisions: %s", body)
	}
}
