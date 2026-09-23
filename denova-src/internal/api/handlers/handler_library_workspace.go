package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/protocol/consts"

	novaApp "denova/internal/app"
	"denova/internal/library"
	"denova/internal/revisionfile"
)

// 作品设定库 HTTP 边界（L1）。
//
// 与既有 `/api/library/*`（Master 公共素材）刻意分属不同命名空间：这里管理的是
// “用户自己的作品设定库”，与书籍和 World 无关。因此本组路由**不要求 workspace**，
// 库必须能在还没有书的状态下创建与编辑。
//
// 脱敏约定：除字段级校验错误（ValidationError）与并发冲突（只带 revision 哈希）外，
// 一律回固定文案，绝不把 err.Error() 直接回给客户端——文件读写错误里可能含本机路径。

func workLibraryRequestBody(c *app.RequestContext) ([]byte, error) {
	body := c.Request.Body()
	if len(body) > library.MaxRequestBodyBytes {
		return nil, errors.New("请求体过大")
	}
	return body, nil
}

func decodeWorkLibraryRequest(c *app.RequestContext, target any) error {
	body, err := workLibraryRequestBody(c)
	if err != nil {
		return err
	}
	return json.Unmarshal(body, target)
}

// workLibraryErrorPayload 是设定库错误响应；code 供前端区分“并发冲突”与业务拒绝。
type workLibraryErrorPayload struct {
	Error  string          `json:"error"`
	Code   string          `json:"code"`
	Impact *library.Impact `json:"impact,omitempty"`
}

func writeWorkLibraryError(c *app.RequestContext, status int, code, message string) {
	writeJSON(c, status, workLibraryErrorPayload{Error: message, Code: code})
}

// writeWorkLibraryDomainError 把领域错误映射为状态码与稳定 code。
//
// 重要：revision_conflict 走 409，而 item_in_use 也是 409 但 code 不同——
// 前端 `isRevisionConflict()` 只在 code 缺失时才把任意 409 当成并发冲突，
// 因此两者必须带各自的 code，避免把“条目被引用”误判成“别人改过，重试即可”。
func writeWorkLibraryDomainError(c *app.RequestContext, err error) {
	var validation *library.ValidationError
	var inUse *library.ItemInUseError
	var conflict *revisionfile.ConflictError
	switch {
	case errors.As(err, &inUse):
		payload := workLibraryErrorPayload{Error: inUse.Error(), Code: "item_in_use"}
		impact := inUse.Impact
		payload.Impact = &impact
		writeJSON(c, consts.StatusConflict, payload)
	case errors.Is(err, library.ErrItemRevisionConflict), errors.Is(err, library.ErrRevisionConflict):
		writeWorkLibraryError(c, consts.StatusConflict, "revision_conflict", library.ErrRevisionConflict.Error())
	case errors.As(err, &conflict):
		writeWorkLibraryError(c, consts.StatusConflict, "revision_conflict",
			library.ErrRevisionConflict.Error()+": expected="+conflict.Expected+" actual="+conflict.Actual)
	case errors.As(err, &validation):
		writeWorkLibraryError(c, consts.StatusBadRequest, "validation_failed", validation.Error())
	case errors.Is(err, library.ErrInvalidID):
		writeWorkLibraryError(c, consts.StatusBadRequest, "invalid_id", library.ErrInvalidID.Error())
	case errors.Is(err, library.ErrNotFound):
		writeWorkLibraryError(c, consts.StatusNotFound, "not_found", library.ErrNotFound.Error())
	case errors.Is(err, library.ErrItemNotFound):
		writeWorkLibraryError(c, consts.StatusNotFound, "item_not_found", library.ErrItemNotFound.Error())
	case errors.Is(err, library.ErrRelationNotFound):
		writeWorkLibraryError(c, consts.StatusNotFound, "relation_not_found", library.ErrRelationNotFound.Error())
	case errors.Is(err, library.ErrReferenceReadOnly):
		writeWorkLibraryError(c, consts.StatusBadRequest, "reference_read_only", library.ErrReferenceReadOnly.Error())
	case errors.Is(err, library.ErrDuplicateRelation):
		writeWorkLibraryError(c, consts.StatusBadRequest, "duplicate_relation", library.ErrDuplicateRelation.Error())
	case errors.Is(err, library.ErrSelfRelation):
		writeWorkLibraryError(c, consts.StatusBadRequest, "self_relation", library.ErrSelfRelation.Error())
	case errors.Is(err, novaApp.ErrLibraryDataDirMissing):
		writeWorkLibraryError(c, consts.StatusInternalServerError, "library_storage_unavailable", "尚未配置 Denova 数据目录，暂时无法保存作品设定库")
	default:
		// 文件损坏、磁盘错误等：回固定文案，避免把本机路径或内部实现细节泄露给客户端。
		writeWorkLibraryError(c, consts.StatusInternalServerError, "library_invalid", "作品设定库数据操作失败")
	}
}

// workLibraryCreateForbiddenFields 是创建时禁止由客户端指定的服务端字段。
var workLibraryCreateForbiddenFields = []string{"id", "schemaVersion", "createdAt", "updatedAt", "revision", "items", "relations"}

// HandleWorkLibraryVocabulary GET /api/work-libraries/vocabulary
// 服务端统一下发词表，避免前后端各硬编码一份导致“能选但不能存”。
func (h *Handlers) HandleWorkLibraryVocabulary(ctx context.Context, c *app.RequestContext) {
	writeJSON(c, consts.StatusOK, map[string]interface{}{"vocabulary": h.app.WorkLibraryVocabulary()})
}

// HandleWorkLibraryList GET /api/work-libraries
func (h *Handlers) HandleWorkLibraryList(ctx context.Context, c *app.RequestContext) {
	result, err := h.app.ListWorkLibraries(ctx)
	if err != nil {
		writeWorkLibraryDomainError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]interface{}{
		"libraries": result.Libraries,
		"warnings":  result.Warnings,
	})
}

// HandleWorkLibraryCreate POST /api/work-libraries
func (h *Handlers) HandleWorkLibraryCreate(ctx context.Context, c *app.RequestContext) {
	body, err := workLibraryRequestBody(c)
	if err != nil {
		writeWorkLibraryError(c, consts.StatusBadRequest, "validation_failed", err.Error())
		return
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(body, &probe); err != nil {
		writeWorkLibraryError(c, consts.StatusBadRequest, "validation_failed", "请求体必须是单个 JSON 对象")
		return
	}
	for _, key := range workLibraryCreateForbiddenFields {
		if _, present := probe[key]; present {
			writeWorkLibraryError(c, consts.StatusBadRequest, "validation_failed", "创建设定库时不允许指定字段："+key)
			return
		}
	}
	var in library.CreateInput
	if err := json.Unmarshal(body, &in); err != nil {
		writeWorkLibraryError(c, consts.StatusBadRequest, "validation_failed", "请求体解析失败")
		return
	}
	l, revision, err := h.app.CreateWorkLibrary(ctx, in)
	if err != nil {
		writeWorkLibraryDomainError(c, err)
		return
	}
	writeJSON(c, consts.StatusCreated, map[string]interface{}{"library": l, "revision": revision})
}

// HandleWorkLibraryGet GET /api/work-libraries/:id
func (h *Handlers) HandleWorkLibraryGet(ctx context.Context, c *app.RequestContext) {
	l, revision, err := h.app.GetWorkLibrary(ctx, c.Param("id"))
	if err != nil {
		writeWorkLibraryDomainError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]interface{}{"library": l, "revision": revision})
}

// HandleWorkLibraryUpdateMeta PATCH /api/work-libraries/:id — 库级 CAS。
func (h *Handlers) HandleWorkLibraryUpdateMeta(ctx context.Context, c *app.RequestContext) {
	var req struct {
		ExpectedRevision string                 `json:"expected_revision"`
		Patch            library.MetaPatchInput `json:"patch"`
	}
	if err := decodeWorkLibraryRequest(c, &req); err != nil {
		writeWorkLibraryError(c, consts.StatusBadRequest, "validation_failed", err.Error())
		return
	}
	if strings.TrimSpace(req.ExpectedRevision) == "" {
		writeWorkLibraryError(c, consts.StatusBadRequest, "validation_failed", "expected_revision 不能为空")
		return
	}
	l, revision, err := h.app.UpdateWorkLibraryMeta(ctx, c.Param("id"), req.ExpectedRevision, req.Patch)
	if err != nil {
		writeWorkLibraryDomainError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]interface{}{"library": l, "revision": revision})
}

// HandleWorkLibraryDelete DELETE /api/work-libraries/:id — 需要 expected_revision。
func (h *Handlers) HandleWorkLibraryDelete(ctx context.Context, c *app.RequestContext) {
	expected := strings.TrimSpace(c.Query("expected_revision"))
	if expected == "" {
		writeWorkLibraryError(c, consts.StatusBadRequest, "validation_failed", "expected_revision 不能为空")
		return
	}
	if err := h.app.DeleteWorkLibrary(ctx, c.Param("id"), expected); err != nil {
		writeWorkLibraryDomainError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]interface{}{"deleted": true})
}

// HandleWorkLibraryTimeline GET /api/work-libraries/:id/timeline — 派生视图。
func (h *Handlers) HandleWorkLibraryTimeline(ctx context.Context, c *app.RequestContext) {
	entries, err := h.app.WorkLibraryTimeline(ctx, c.Param("id"))
	if err != nil {
		writeWorkLibraryDomainError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]interface{}{"timeline": entries})
}

// HandleWorkLibraryItemCreate POST /api/work-libraries/:id/items
func (h *Handlers) HandleWorkLibraryItemCreate(ctx context.Context, c *app.RequestContext) {
	var in library.ItemInput
	if err := decodeWorkLibraryRequest(c, &in); err != nil {
		writeWorkLibraryError(c, consts.StatusBadRequest, "validation_failed", err.Error())
		return
	}
	item, revision, err := h.app.CreateWorkLibraryItem(ctx, c.Param("id"), in)
	if err != nil {
		writeWorkLibraryDomainError(c, err)
		return
	}
	writeJSON(c, consts.StatusCreated, map[string]interface{}{"item": item, "revision": revision})
}

// HandleWorkLibraryItemUpdate PATCH /api/work-libraries/:id/items/:itemId — 条目级 CAS。
func (h *Handlers) HandleWorkLibraryItemUpdate(ctx context.Context, c *app.RequestContext) {
	var in library.ItemInput
	if err := decodeWorkLibraryRequest(c, &in); err != nil {
		writeWorkLibraryError(c, consts.StatusBadRequest, "validation_failed", err.Error())
		return
	}
	// HTTP callers must supply the saved baseline; omission is not force-overwrite.
	if strings.TrimSpace(in.BaseUpdatedAt) == "" {
		writeWorkLibraryError(c, consts.StatusBadRequest, "validation_failed", "baseUpdatedAt is required")
		return
	}
	// 条目 ID 以路径为准，避免请求体与路径不一致时产生歧义。
	in.ID = c.Param("itemId")
	item, revision, err := h.app.UpdateWorkLibraryItem(ctx, c.Param("id"), in)
	if err != nil {
		writeWorkLibraryDomainError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]interface{}{"item": item, "revision": revision})
}

// HandleWorkLibraryItemDelete DELETE /api/work-libraries/:id/items/:itemId[?cascade=true]
func (h *Handlers) HandleWorkLibraryItemDelete(ctx context.Context, c *app.RequestContext) {
	cascade := strings.TrimSpace(c.Query("cascade")) == "true"
	result, revision, err := h.app.DeleteWorkLibraryItem(ctx, c.Param("id"), c.Param("itemId"), cascade)
	if err != nil {
		writeWorkLibraryDomainError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]interface{}{
		"deletedId":          result.DeletedID,
		"removedRelationIds": result.RemovedRelationIDs,
		"updatedEventIds":    result.UpdatedEventIDs,
		"revision":           revision,
	})
}

// HandleWorkLibraryItemImpact GET /api/work-libraries/:id/items/:itemId/impact
func (h *Handlers) HandleWorkLibraryItemImpact(ctx context.Context, c *app.RequestContext) {
	impact, err := h.app.WorkLibraryItemImpact(ctx, c.Param("id"), c.Param("itemId"))
	if err != nil {
		writeWorkLibraryDomainError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]interface{}{"impact": impact})
}

// HandleWorkLibraryRelationCreate POST /api/work-libraries/:id/relations
func (h *Handlers) HandleWorkLibraryRelationCreate(ctx context.Context, c *app.RequestContext) {
	var in library.RelationInput
	if err := decodeWorkLibraryRequest(c, &in); err != nil {
		writeWorkLibraryError(c, consts.StatusBadRequest, "validation_failed", err.Error())
		return
	}
	relation, revision, err := h.app.CreateWorkLibraryRelation(ctx, c.Param("id"), in)
	if err != nil {
		writeWorkLibraryDomainError(c, err)
		return
	}
	writeJSON(c, consts.StatusCreated, map[string]interface{}{"relation": relation, "revision": revision})
}

// HandleWorkLibraryRelationUpdate PATCH /api/work-libraries/:id/relations/:relationId
func (h *Handlers) HandleWorkLibraryRelationUpdate(ctx context.Context, c *app.RequestContext) {
	var in library.RelationInput
	if err := decodeWorkLibraryRequest(c, &in); err != nil {
		writeWorkLibraryError(c, consts.StatusBadRequest, "validation_failed", err.Error())
		return
	}
	relation, revision, err := h.app.UpdateWorkLibraryRelation(ctx, c.Param("id"), c.Param("relationId"), in)
	if err != nil {
		writeWorkLibraryDomainError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]interface{}{"relation": relation, "revision": revision})
}

// HandleWorkLibraryRelationDelete DELETE /api/work-libraries/:id/relations/:relationId
func (h *Handlers) HandleWorkLibraryRelationDelete(ctx context.Context, c *app.RequestContext) {
	revision, err := h.app.DeleteWorkLibraryRelation(ctx, c.Param("id"), c.Param("relationId"))
	if err != nil {
		writeWorkLibraryDomainError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]interface{}{"deleted": true, "revision": revision})
}
