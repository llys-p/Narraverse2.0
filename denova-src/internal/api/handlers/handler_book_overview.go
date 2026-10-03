package handlers

import (
	"context"
	"errors"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/protocol/consts"

	novaApp "denova/internal/app"
)

// HandleBookOverviewOrganize POST /api/book/overview/organize —— AI 整理书籍总览草稿。
// 只返回草稿与所用资料清单，不落盘；保存走现有 /api/workspace/file（revision 检查）。
func (h *Handlers) HandleBookOverviewOrganize(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var req novaApp.BookOverviewOrganizeRequest
	if err := c.BindJSON(&req); err != nil {
		writeErrorKey(c, consts.StatusBadRequest, "api.common.invalidRequest")
		return
	}
	result, err := h.app.OrganizeBookOverview(ctx, req)
	if err != nil {
		var gatewayErr *novaApp.ModelGatewayError
		if errors.As(err, &gatewayErr) {
			c.JSON(gatewayErr.HTTPStatus(), map[string]any{"error": gatewayErr.Message, "code": gatewayErr.Code, "upstream_status": gatewayErr.UpstreamStatus})
			return
		}
		if errors.Is(err, novaApp.ErrBookOverviewInvalidRequest) {
			writeError(c, consts.StatusBadRequest, err.Error())
			return
		}
		writeErrorKey(c, consts.StatusInternalServerError, "api.common.internalError")
		return
	}
	writeJSON(c, consts.StatusOK, result)
}
