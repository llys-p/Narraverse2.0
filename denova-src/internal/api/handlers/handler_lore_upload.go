package handlers

import (
	"context"
	"errors"
	"io"

	novaApp "denova/internal/app"
	"denova/internal/book"
	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/protocol/consts"
)

// HandleLoreImagesUpload appends files to the pinned book without calling AI.
func (h *Handlers) HandleLoreImagesUpload(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	if len(c.Request.Body()) > novaApp.LoreUploadBatchMaxBytes+(1<<20) {
		writeErrorKey(c, consts.StatusBadRequest, "api.lore.uploadInvalid")
		return
	}
	form, err := c.MultipartForm()
	if err != nil {
		writeErrorKey(c, consts.StatusBadRequest, "api.lore.uploadInvalid")
		return
	}
	headers := form.File["files"]
	if len(headers) == 0 || len(headers) > book.MaxLoreItemImages {
		writeErrorKey(c, consts.StatusBadRequest, "api.lore.uploadInvalid")
		return
	}
	uploads := make([]novaApp.LoreImageUpload, 0, len(headers))
	total := 0
	for _, header := range headers {
		if header.Size > novaApp.LoreUploadFileMaxBytes {
			writeErrorKey(c, consts.StatusBadRequest, "api.lore.uploadInvalid")
			return
		}
		file, err := header.Open()
		if err != nil {
			writeErrorKey(c, consts.StatusBadRequest, "api.lore.uploadInvalid")
			return
		}
		data, readErr := io.ReadAll(io.LimitReader(file, novaApp.LoreUploadFileMaxBytes+1))
		_ = file.Close()
		total += len(data)
		if readErr != nil || len(data) > novaApp.LoreUploadFileMaxBytes || total > novaApp.LoreUploadBatchMaxBytes {
			writeErrorKey(c, consts.StatusBadRequest, "api.lore.uploadInvalid")
			return
		}
		uploads = append(uploads, novaApp.LoreImageUpload{Filename: header.Filename, Data: data})
	}
	item, err := h.app.UploadLoreImages(string(c.FormValue("workspace")), c.Param("id"), uploads)
	if err != nil {
		writeLoreUploadError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, item)
}

// HandleLoreImageDetach removes an association, never the user's original file.
func (h *Handlers) HandleLoreImageDetach(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var request struct {
		Workspace string `json:"workspace"`
		ImagePath string `json:"image_path"`
	}
	if err := c.BindJSON(&request); err != nil {
		writeErrorKey(c, consts.StatusBadRequest, "api.common.invalidRequest")
		return
	}
	item, err := h.app.RemoveLoreImageAttachment(request.Workspace, c.Param("id"), request.ImagePath)
	if err != nil {
		writeLoreUploadError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, item)
}

func writeLoreUploadError(c *app.RequestContext, err error) {
	switch {
	case errors.Is(err, novaApp.ErrLoreUploadWorkspace):
		writeErrorKey(c, consts.StatusConflict, "api.lore.uploadWorkspace")
	case errors.Is(err, novaApp.ErrLoreUploadInvalid):
		writeErrorKey(c, consts.StatusBadRequest, "api.lore.uploadInvalid")
	case errors.Is(err, book.ErrLoreImageLimit):
		writeErrorKey(c, consts.StatusBadRequest, "api.lore.uploadLimit")
	case errors.Is(err, book.ErrLoreImageMissing):
		writeErrorKey(c, consts.StatusNotFound, "api.lore.uploadMissing")
	default:
		writeErrorKey(c, consts.StatusBadRequest, "api.lore.uploadFailed")
	}
}
