package handlers

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/protocol/consts"

	"denova/internal/revisionfile"
	"denova/internal/world"
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

// 损坏文件等内部错误可能包裹本机存储路径，统一脱敏为固定文案，不泄露路径。
func TestWorldErrorSanitizationHidesInternalPath(t *testing.T) {
	c := app.NewContext(0)
	leak := fmt.Errorf("世界文件已损坏：%w", errors.New(`open C:\Users\secret\.denova\worlds\world-x.json: access denied`))
	writeWorldError(c, leak)
	if c.Response.StatusCode() != consts.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", c.Response.StatusCode())
	}
	body := string(c.Response.Body())
	if strings.Contains(body, "secret") || strings.Contains(body, `.denova`) || strings.Contains(body, `C:\`) {
		t.Fatalf("internal error leaked storage detail: %s", body)
	}
	if !strings.Contains(body, "世界数据操作失败") {
		t.Fatalf("expected generic message, got %s", body)
	}
}

// 领域内的安全错误（非法 id / 不存在）保留可读文案与正确状态码。
func TestWorldErrorSanitizationKeepsSafeDomainErrors(t *testing.T) {
	c := app.NewContext(0)
	writeWorldError(c, world.ErrInvalidID)
	if c.Response.StatusCode() != consts.StatusBadRequest {
		t.Fatalf("expected 400, got %d", c.Response.StatusCode())
	}
	if !strings.Contains(string(c.Response.Body()), "世界 id 非法") {
		t.Fatalf("expected safe invalid-id message, got %s", string(c.Response.Body()))
	}

	c2 := app.NewContext(0)
	writeWorldError(c2, world.ErrNotFound)
	if c2.Response.StatusCode() != consts.StatusNotFound {
		t.Fatalf("expected 404, got %d", c2.Response.StatusCode())
	}
}
