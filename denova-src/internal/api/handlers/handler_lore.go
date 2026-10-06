package handlers

import (
	"context"
	"errors"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/protocol/consts"

	"denova/internal/api/sse"
	novaApp "denova/internal/app"
	"denova/internal/book"
)

func (h *Handlers) HandleLoreItems(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	items, err := h.app.LoreItems()
	if err != nil {
		writeError(c, consts.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(c, consts.StatusOK, map[string]any{"items": items})
}

func (h *Handlers) HandleLoreItemCreate(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var body struct {
		book.LoreItemInput
		Workspace *string `json:"workspace,omitempty"`
	}
	if err := c.BindJSON(&body); err != nil {
		writeErrorKey(c, consts.StatusBadRequest, "api.common.invalidRequestWithDetail", "detail", err.Error())
		return
	}
	var item book.LoreItem
	var err error
	if body.Workspace == nil {
		item, err = h.app.CreateLoreItem(body.LoreItemInput)
	} else {
		item, err = h.app.CreateLoreItemForWorkspace(body.LoreItemInput, *body.Workspace)
	}
	if err != nil {
		if errors.Is(err, novaApp.ErrLoreWorkspaceMismatch) {
			writeErrorKey(c, consts.StatusConflict, "api.resource.revisionConflict")
			return
		}
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	writeJSON(c, consts.StatusOK, item)
}

func (h *Handlers) HandleLoreItemUpdate(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var body struct {
		book.LoreItemInput
		Workspace *string `json:"workspace,omitempty"`
	}
	if err := c.BindJSON(&body); err != nil {
		writeErrorKey(c, consts.StatusBadRequest, "api.common.invalidRequestWithDetail", "detail", err.Error())
		return
	}
	var item book.LoreItem
	var err error
	if body.Workspace == nil {
		item, err = h.app.UpdateLoreItem(c.Param("id"), body.LoreItemInput)
	} else {
		item, err = h.app.UpdateLoreItemForWorkspace(c.Param("id"), body.LoreItemInput, *body.Workspace)
	}
	if err != nil {
		if errors.Is(err, book.ErrLoreRevisionConflict) || errors.Is(err, novaApp.ErrLoreWorkspaceMismatch) {
			writeErrorKey(c, consts.StatusConflict, "api.resource.revisionConflict")
			return
		}
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	writeJSON(c, consts.StatusOK, item)
}

func (h *Handlers) HandleLoreItemDelete(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	// 可选的 JSON body 携带目标书籍身份；没有 body 时保持旧行为，供既有调用方使用。
	var body struct {
		Workspace string `json:"workspace,omitempty"`
	}
	if length := len(c.Request.Body()); length > 0 {
		if err := c.BindJSON(&body); err != nil {
			writeErrorKey(c, consts.StatusBadRequest, "api.common.invalidRequestWithDetail", "detail", err.Error())
			return
		}
	}
	var err error
	if body.Workspace == "" {
		err = h.app.DeleteLoreItem(c.Param("id"))
	} else {
		err = h.app.DeleteLoreItemForWorkspace(c.Param("id"), body.Workspace)
	}
	if err != nil {
		if errors.Is(err, novaApp.ErrLoreWorkspaceMismatch) {
			writeErrorKey(c, consts.StatusConflict, "api.resource.revisionConflict")
			return
		}
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	writeJSON(c, consts.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handlers) HandleLoreClassificationPreview(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var body novaApp.LoreClassificationPreviewRequest
	if err := c.BindJSON(&body); err != nil && len(c.Request.Body()) > 0 {
		writeErrorKey(c, consts.StatusBadRequest, "api.common.invalidRequestWithDetail", "detail", err.Error())
		return
	}
	preview, err := h.app.PreviewLoreClassification(ctx, body)
	if err != nil {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	writeJSON(c, consts.StatusOK, preview)
}

func (h *Handlers) HandleLoreClassificationApply(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var body novaApp.LoreClassificationApplyRequest
	if err := c.BindJSON(&body); err != nil {
		writeErrorKey(c, consts.StatusBadRequest, "api.common.invalidRequestWithDetail", "detail", err.Error())
		return
	}
	result, err := h.app.ApplyLoreClassification(body)
	if err != nil {
		if errors.Is(err, book.ErrLoreRevisionConflict) {
			writeErrorKey(c, consts.StatusConflict, "api.resource.revisionConflict")
			return
		}
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	writeJSON(c, consts.StatusOK, result)
}

func (h *Handlers) HandleLoreItemImageGenerate(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var body novaApp.LoreItemImageGenerateRequest
	if err := c.BindJSON(&body); err != nil && len(c.Request.Body()) > 0 {
		writeErrorKey(c, consts.StatusBadRequest, "api.common.invalidRequestWithDetail", "detail", err.Error())
		return
	}
	item, err := h.app.GenerateLoreItemImage(ctx, c.Param("id"), body)
	if err != nil {
		if errors.Is(err, novaApp.ErrLoreWorkspaceMismatch) {
			writeErrorKey(c, consts.StatusConflict, "api.resource.revisionConflict")
			return
		}
		if err == novaApp.ErrNoWorkspace {
			writeErrorKey(c, consts.StatusBadRequest, "api.settings.workspaceMissing")
			return
		}
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	writeJSON(c, consts.StatusOK, item)
}

func (h *Handlers) HandleLoreImagesGenerateStream(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var body novaApp.LoreImagesGenerateRequest
	if err := c.BindJSON(&body); err != nil {
		writeErrorKey(c, consts.StatusBadRequest, "api.common.invalidRequestWithDetail", "detail", err.Error())
		return
	}
	task, err := h.app.StartLoreImagesGenerateTask(body)
	if err != nil {
		if errors.Is(err, novaApp.ErrLoreWorkspaceMismatch) {
			writeErrorKey(c, consts.StatusConflict, "api.resource.revisionConflict")
			return
		}
		if errors.Is(err, novaApp.ErrLoreImageTaskRunning) {
			writeError(c, consts.StatusConflict, err.Error())
			return
		}
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	sse.StreamTask(c, task)
}

func (h *Handlers) HandleLoreImagesGenerateAbort(ctx context.Context, c *app.RequestContext) {
	h.app.AbortLoreImagesGenerateTask()
	writeJSON(c, consts.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handlers) HandleLoreItemImageDelete(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var body struct {
		Workspace string `json:"workspace,omitempty"`
	}
	if length := len(c.Request.Body()); length > 0 {
		if err := c.BindJSON(&body); err != nil {
			writeErrorKey(c, consts.StatusBadRequest, "api.common.invalidRequestWithDetail", "detail", err.Error())
			return
		}
	}
	var item book.LoreItem
	var err error
	if body.Workspace == "" {
		item, err = h.app.ClearLoreItemImage(c.Param("id"))
	} else {
		item, err = h.app.ClearLoreItemImageForWorkspace(c.Param("id"), body.Workspace)
	}
	if err != nil {
		if errors.Is(err, novaApp.ErrLoreWorkspaceMismatch) {
			writeErrorKey(c, consts.StatusConflict, "api.resource.revisionConflict")
			return
		}
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	writeJSON(c, consts.StatusOK, item)
}
