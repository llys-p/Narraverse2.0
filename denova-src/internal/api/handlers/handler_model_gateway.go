package handlers

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/protocol/consts"

	novaApp "denova/internal/app"
)

// HandleModelStatus refreshes one module's effective shared model snapshot.
// The response contains only redacted endpoint metadata and configuration
// presence flags; credentials never leave the server.
func (h *Handlers) HandleModelStatus(ctx context.Context, c *app.RequestContext) {
	status, err := h.app.ModelGatewayStatus(string(c.Query("module")))
	if err != nil {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	writeJSON(c, consts.StatusOK, status)
}

// HandleModelTest performs a minimal real upstream request. It intentionally
// returns an envelope with HTTP 200 for upstream failures so module UIs can
// render 401/404/timeout details without treating the test control request as
// a broken Denova server request.
func (h *Handlers) HandleModelTest(ctx context.Context, c *app.RequestContext) {
	module := string(c.Query("module"))
	if module == "" {
		var body struct {
			Module string `json:"module"`
		}
		if raw := c.Request.Body(); len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
			module = body.Module
		}
	}
	writeJSON(c, consts.StatusOK, h.app.TestModel(ctx, module))
}

// HandleModelChat is the common non-streaming transport used by embedded
// Narraverse and Module4. Native Denova agents keep their existing SSE/tool
// protocol; all four modules nevertheless share the same settings resolution
// and provider-compatible model transport.
func (h *Handlers) HandleModelChat(ctx context.Context, c *app.RequestContext) {
	var req novaApp.ModelGatewayChatRequest
	if err := c.BindJSON(&req); err != nil {
		writeError(c, consts.StatusBadRequest, "模型请求格式无效。")
		return
	}
	result, err := h.app.GenerateModel(ctx, req)
	if err == nil {
		writeJSON(c, consts.StatusOK, result)
		return
	}
	var gatewayErr *novaApp.ModelGatewayError
	if errors.As(err, &gatewayErr) {
		writeJSON(c, gatewayErr.HTTPStatus(), map[string]any{
			"error":           gatewayErr.Message,
			"code":            gatewayErr.Code,
			"upstream_status": gatewayErr.UpstreamStatus,
		})
		return
	}
	writeError(c, consts.StatusBadGateway, "共享模型请求失败。")
}
