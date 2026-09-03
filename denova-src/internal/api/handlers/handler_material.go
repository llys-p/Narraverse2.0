package handlers

import (
	"context"
	"log"
	"strings"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/protocol/consts"

	"denova/internal/book"
)

// HandleWorkspacePreviewMaterial parses one complete source file without writing it.
func (h *Handlers) HandleWorkspacePreviewMaterial(ctx context.Context, c *app.RequestContext) {
	filename, data, ok := readCharacterCardUpload(c)
	if !ok {
		return
	}
	preview, err := book.PreviewMaterial(filename, data)
	if err != nil {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	writeJSON(c, consts.StatusOK, preview)
}

// HandleWorkspaceImportMaterial imports one character card or lorebook atomically.
func (h *Handlers) HandleWorkspaceImportMaterial(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	filename, data, ok := readCharacterCardUpload(c)
	if !ok {
		return
	}
	options := book.MaterialImportOptions{
		SourceID:          strings.TrimSpace(string(c.FormValue("source_id"))),
		SourceKind:        strings.TrimSpace(string(c.FormValue("source_kind"))),
		AcceptIncomplete:  strings.EqualFold(strings.TrimSpace(string(c.FormValue("accept_incomplete"))), "true"),
		UserCharacterName: strings.TrimSpace(string(c.FormValue("user_character_name"))),
		ManagementMode:    strings.TrimSpace(string(c.FormValue("management_mode"))),
	}
	result, err := h.app.BookService().ImportMaterial(filename, data, options)
	if err != nil {
		log.Printf("[api] 素材导入失败 filename=%q error=%v", filename, err)
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	writeJSON(c, consts.StatusOK, result)
}

// HandleWorkspaceApplyMasterTranslation stores one field-level translation
// version. Only Adventure-bound imports are projected after required fields
// become active; Master-only ingestion stops at the ready state.
func (h *Handlers) HandleWorkspaceApplyMasterTranslation(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var body book.MasterTranslationApplyInput
	if err := c.BindJSON(&body); err != nil {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	master := book.NewMasterLibraryStore(h.app.Workspace())
	result, err := master.ApplyTranslation(body)
	if err != nil {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	response := map[string]any{"translation": result}
	if result.Ready && master.TransactionTargetsAdventure(result.Transaction) {
		imported, finalizeErr := h.app.BookService().FinalizeMasterImport(body.ImportID)
		if finalizeErr != nil {
			writeError(c, consts.StatusBadRequest, finalizeErr.Error())
			return
		}
		response["import"] = imported
	}
	writeJSON(c, consts.StatusOK, response)
}

func (h *Handlers) HandleWorkspaceFinalizeMasterImport(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var body struct {
		ImportID string `json:"import_id"`
	}
	if err := c.BindJSON(&body); err != nil {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	result, err := h.app.BookService().FinalizeMasterImport(strings.TrimSpace(body.ImportID))
	if err != nil {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	writeJSON(c, consts.StatusOK, result)
}
