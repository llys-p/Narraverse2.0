package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode/utf8"

	"denova/internal/library"
	"denova/internal/librarycontext"
	"github.com/cloudwego/hertz/pkg/app"
)

// This wire DTO is intentionally independent of librarycontext.Request.
type libraryPreviewRequest struct {
	ExpectedRevision string
	ManualItemIDs    []string
	AutoItemIDs      []string
	CatalogOffset    int
	CatalogLimit     int
}

func decodeLibraryPreview(body []byte) (libraryPreviewRequest, error) {
	bad := errors.New("invalid_request")
	req := libraryPreviewRequest{CatalogLimit: 50}
	if len(body) > librarycontext.MaxPreviewBytes || !utf8.Valid(body) {
		return req, bad
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return req, bad
	}
	seen := map[string]bool{}
	for decoder.More() {
		token, err = decoder.Token()
		if err != nil {
			return req, bad
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return req, bad
		}
		seen[key] = true
		var raw json.RawMessage
		if decoder.Decode(&raw) != nil || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return req, bad
		}
		switch key {
		case "expectedRevision":
			err = json.Unmarshal(raw, &req.ExpectedRevision)
		case "catalogOffset":
			err = json.Unmarshal(raw, &req.CatalogOffset)
		case "catalogLimit":
			err = json.Unmarshal(raw, &req.CatalogLimit)
		case "manualItemIds", "autoItemIds":
			var values []json.RawMessage
			if err = json.Unmarshal(raw, &values); err != nil || len(values) > librarycontext.MaxLoadedItems {
				return req, bad
			}
			ids := make([]string, 0, len(values))
			for _, value := range values {
				var id string
				if bytes.Equal(bytes.TrimSpace(value), []byte("null")) || json.Unmarshal(value, &id) != nil || strings.TrimSpace(id) == "" {
					return req, bad
				}
				ids = append(ids, id)
			}
			if key == "manualItemIds" {
				req.ManualItemIDs = ids
			} else {
				req.AutoItemIDs = ids
			}
		default:
			return req, bad
		}
		if err != nil {
			return req, bad
		}
	}
	if token, err = decoder.Token(); err != nil || token != json.Delim('}') {
		return req, bad
	}
	if err = decoder.Decode(new(any)); err != io.EOF {
		return req, bad
	}
	if strings.TrimSpace(req.ExpectedRevision) == "" || req.CatalogOffset < 0 || req.CatalogLimit < 1 || req.CatalogLimit > librarycontext.MaxCatalogLimit {
		return req, bad
	}
	return req, nil
}

// HandleLibraryContextPreview only reads saved data. No model, task or registry.
func (h *Handlers) HandleLibraryContextPreview(ctx context.Context, c *app.RequestContext) {
	req, err := decodeLibraryPreview(c.Request.Body())
	if err != nil {
		writeWorkLibraryError(c, 400, "invalid_request", "加载预览请求无效")
		return
	}
	p, err := h.app.PreviewWorkLibraryContext(ctx, c.Param("id"), librarycontext.Request{
		ExpectedRevision: req.ExpectedRevision, ManualItemIDs: req.ManualItemIDs, AutoItemIDs: req.AutoItemIDs,
		CatalogOffset: req.CatalogOffset, CatalogLimit: req.CatalogLimit,
	})
	if err != nil {
		switch {
		case errors.Is(err, librarycontext.ErrSelectionInvalid), errors.Is(err, library.ErrInvalidID):
			writeWorkLibraryError(c, 400, "selection_invalid", "所选条目或范围无效")
		case errors.Is(err, librarycontext.ErrRevisionConflict):
			writeWorkLibraryError(c, 409, "revision_conflict", "资料库已变化，请重新加载")
		case errors.Is(err, librarycontext.ErrBudgetExceeded):
			writeWorkLibraryError(c, 413, "budget_exceeded", "加载内容超出预算，请减少常驻或所选资料")
		case errors.Is(err, library.ErrNotFound):
			writeWorkLibraryError(c, 404, "library_not_found", "作品设定库不存在")
		default:
			writeWorkLibraryError(c, 500, "library_unavailable", "作品设定库暂时无法读取")
		}
		return
	}
	writeJSON(c, 200, libraryPreviewToDTO(p))
}
