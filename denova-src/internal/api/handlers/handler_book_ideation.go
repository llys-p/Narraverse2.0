package handlers

import (
	"context"
	"errors"
	"strings"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/protocol/consts"

	"denova/internal/bookideation"
)

// maxIdeationBodyBytes bounds one ideation request. A 设定书 or 角色卡 is sent as
// text so a source snapshot can approach the package's own 4 MiB material cap.
const maxIdeationBodyBytes = 4 << 20

// ideationDraftResponse always returns the stored draft plus its revision, so a
// client that failed a later call can still re-sync instead of guessing state.
type ideationDraftResponse struct {
	Draft      bookideation.Draft `json:"draft"`
	Revision   string             `json:"revision"`
	ModelError string             `json:"model_error,omitempty"`
}

// ideationCommitResponse carries the staged receipt next to the draft.
type ideationCommitResponse struct {
	Receipt bookideation.CommitReceipt `json:"receipt"`
	Draft   bookideation.Draft         `json:"draft"`
}

func (h *Handlers) ideationService(c *app.RequestContext) (*bookideation.Service, bool) {
	service, err := h.app.BookIdeation()
	if err != nil {
		writeError(c, consts.StatusInternalServerError, err.Error())
		return nil, false
	}
	return service, true
}

func ideationDraftID(c *app.RequestContext) string {
	return strings.TrimSpace(c.Param("draftId"))
}

func writeIdeationDraft(c *app.RequestContext, status int, record bookideation.Record, modelError string) {
	writeJSON(c, status, ideationDraftResponse{Draft: record.Draft, Revision: record.Revision, ModelError: modelError})
}

// writeIdeationError maps the service's typed errors onto stable API codes. A
// stale generation returns the current draft so the client can re-read and let
// the user decide whether to regenerate.
func writeIdeationError(c *app.RequestContext, err error, current *bookideation.Record) {
	var conflict *bookideation.ConflictError
	if errors.As(err, &conflict) {
		payload := map[string]any{"error": err.Error(), "code": "draft_conflict", "actual_revision": conflict.Actual}
		if current != nil {
			payload["draft"] = current.Draft
			payload["revision"] = current.Revision
		}
		writeJSON(c, consts.StatusConflict, payload)
		return
	}
	var stale *bookideation.StaleGenerationError
	if errors.As(err, &stale) {
		payload := map[string]any{"error": err.Error(), "code": "generation_stale"}
		if current != nil {
			payload["draft"] = current.Draft
			payload["revision"] = current.Revision
		}
		writeJSON(c, consts.StatusConflict, payload)
		return
	}
	var validation *bookideation.ValidationError
	if errors.As(err, &validation) {
		writeJSON(c, consts.StatusBadRequest, map[string]any{"error": err.Error(), "code": "invalid_request", "field": validation.Field})
		return
	}
	switch {
	case errors.Is(err, bookideation.ErrNotFound):
		writeErrorKey(c, consts.StatusNotFound, "api.common.notFound")
	case errors.Is(err, bookideation.ErrModelUnavailable):
		writeJSON(c, consts.StatusServiceUnavailable, map[string]any{"error": err.Error(), "code": "model_unavailable"})
	case errors.Is(err, bookideation.ErrCommitIncomplete):
		writeJSON(c, consts.StatusBadGateway, map[string]any{"error": err.Error(), "code": "commit_incomplete"})
	default:
		writeError(c, consts.StatusInternalServerError, err.Error())
	}
}

// HandleBookIdeationCreateDraft POST /api/book-ideation/drafts — 开始一次书籍构思，
// 只创建草稿，不建书、不切工作区、不调用模型。
func (h *Handlers) HandleBookIdeationCreateDraft(ctx context.Context, c *app.RequestContext) {
	var req struct {
		Idea   string `json:"idea"`
		Locale string `json:"locale"`
	}
	if err := decodeStrictJSON(c.Request.Body(), &req); err != nil {
		writeProposalError(c, consts.StatusBadRequest, "invalid_request", "请求体解析失败或包含未知字段")
		return
	}
	service, ok := h.ideationService(c)
	if !ok {
		return
	}
	record, err := service.CreateDraft(ctx, req.Idea, req.Locale)
	if err != nil {
		writeIdeationError(c, err, nil)
		return
	}
	writeIdeationDraft(c, consts.StatusOK, record, "")
}

// HandleBookIdeationListDrafts GET /api/book-ideation/drafts — 供刷新后恢复构思。
func (h *Handlers) HandleBookIdeationListDrafts(ctx context.Context, c *app.RequestContext) {
	service, ok := h.ideationService(c)
	if !ok {
		return
	}
	drafts, err := service.List(ctx)
	if err != nil {
		writeIdeationError(c, err, nil)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]any{"drafts": drafts})
}

// HandleBookIdeationGetDraft GET /api/book-ideation/drafts/:draftId
func (h *Handlers) HandleBookIdeationGetDraft(ctx context.Context, c *app.RequestContext) {
	service, ok := h.ideationService(c)
	if !ok {
		return
	}
	record, err := service.Get(ctx, ideationDraftID(c))
	if err != nil {
		writeIdeationError(c, err, nil)
		return
	}
	writeIdeationDraft(c, consts.StatusOK, record, "")
}

type ideationDirectionInput struct {
	Summary  *string   `json:"summary"`
	Genre    *string   `json:"genre"`
	Tone     *string   `json:"tone"`
	Conflict *string   `json:"conflict"`
	Cast     *[]string `json:"cast"`
}

// HandleBookIdeationUpdateDraft PATCH /api/book-ideation/drafts/:draftId — 书名、
// 简介、一句话与用户确认的方向；全部走 base_revision CAS。
func (h *Handlers) HandleBookIdeationUpdateDraft(ctx context.Context, c *app.RequestContext) {
	var req struct {
		BaseRevision string                  `json:"base_revision"`
		Title        *string                 `json:"title"`
		Author       *string                 `json:"author"`
		Description  *string                 `json:"description"`
		Idea         *string                 `json:"idea"`
		Direction    *ideationDirectionInput `json:"direction"`
	}
	if err := decodeStrictJSON(c.Request.Body(), &req); err != nil {
		writeProposalError(c, consts.StatusBadRequest, "invalid_request", "请求体解析失败或包含未知字段")
		return
	}
	patch := bookideation.DraftPatch{
		Title:       req.Title,
		Author:      req.Author,
		Description: req.Description,
		Idea:        req.Idea,
	}
	if req.Direction != nil {
		patch.Direction = &bookideation.DirectionPatch{
			Summary:  req.Direction.Summary,
			Genre:    req.Direction.Genre,
			Tone:     req.Direction.Tone,
			Conflict: req.Direction.Conflict,
			Cast:     req.Direction.Cast,
		}
	}
	service, ok := h.ideationService(c)
	if !ok {
		return
	}
	record, err := service.UpdateDraft(ctx, ideationDraftID(c), req.BaseRevision, patch)
	if err != nil {
		writeIdeationError(c, err, h.currentIdeationDraft(ctx, service, ideationDraftID(c)))
		return
	}
	writeIdeationDraft(c, consts.StatusOK, record, "")
}

// HandleBookIdeationAddSource POST /api/book-ideation/drafts/:draftId/sources —
// 只读地把选中素材的原文存进草稿，原件与任何书籍目录都不受影响。
func (h *Handlers) HandleBookIdeationAddSource(ctx context.Context, c *app.RequestContext) {
	body := c.Request.Body()
	if len(body) > maxIdeationBodyBytes {
		writeProposalError(c, consts.StatusBadRequest, "invalid_request", "素材过大（上限 4 MiB）")
		return
	}
	var req struct {
		BaseRevision string `json:"base_revision"`
		FileName     string `json:"file_name"`
		Content      string `json:"content"`
	}
	if err := decodeStrictJSON(body, &req); err != nil {
		writeProposalError(c, consts.StatusBadRequest, "invalid_request", "请求体解析失败或包含未知字段")
		return
	}
	if strings.TrimSpace(req.Content) == "" {
		writeProposalError(c, consts.StatusBadRequest, "invalid_request", "素材内容为空")
		return
	}
	service, ok := h.ideationService(c)
	if !ok {
		return
	}
	record, err := service.AddSource(ctx, ideationDraftID(c), req.BaseRevision, req.FileName, []byte(req.Content))
	if err != nil {
		writeIdeationError(c, err, h.currentIdeationDraft(ctx, service, ideationDraftID(c)))
		return
	}
	writeIdeationDraft(c, consts.StatusOK, record, "")
}

// HandleBookIdeationRemoveSource POST /api/book-ideation/drafts/:draftId/sources/:sourceId/remove
func (h *Handlers) HandleBookIdeationRemoveSource(ctx context.Context, c *app.RequestContext) {
	var req struct {
		BaseRevision string `json:"base_revision"`
	}
	if err := decodeStrictJSON(c.Request.Body(), &req); err != nil {
		writeProposalError(c, consts.StatusBadRequest, "invalid_request", "请求体解析失败或包含未知字段")
		return
	}
	service, ok := h.ideationService(c)
	if !ok {
		return
	}
	record, err := service.RemoveSource(ctx, ideationDraftID(c), req.BaseRevision, strings.TrimSpace(c.Param("sourceId")))
	if err != nil {
		writeIdeationError(c, err, h.currentIdeationDraft(ctx, service, ideationDraftID(c)))
		return
	}
	writeIdeationDraft(c, consts.StatusOK, record, "")
}

// HandleBookIdeationMessage POST /api/book-ideation/drafts/:draftId/messages —
// 一轮构思对话。用户消息先落草稿，模型失败时仍可在刷新后看到自己说过的话。
func (h *Handlers) HandleBookIdeationMessage(ctx context.Context, c *app.RequestContext) {
	var req struct {
		BaseRevision string `json:"base_revision"`
		Content      string `json:"content"`
	}
	if err := decodeStrictJSON(c.Request.Body(), &req); err != nil {
		writeProposalError(c, consts.StatusBadRequest, "invalid_request", "请求体解析失败或包含未知字段")
		return
	}
	service, ok := h.ideationService(c)
	if !ok {
		return
	}
	record, err := service.SendMessage(ctx, ideationDraftID(c), req.BaseRevision, req.Content)
	if err != nil {
		if errors.Is(err, bookideation.ErrModelUnavailable) {
			// The user's turn persisted; report the model problem alongside it.
			writeIdeationDraft(c, consts.StatusOK, record, err.Error())
			return
		}
		writeIdeationError(c, err, h.currentIdeationDraft(ctx, service, ideationDraftID(c)))
		return
	}
	writeIdeationDraft(c, consts.StatusOK, record, "")
}

// HandleBookIdeationGenerate POST /api/book-ideation/drafts/:draftId/generate —
// 生成或局部重写候选包；确认前不写任何书籍内容。
func (h *Handlers) HandleBookIdeationGenerate(ctx context.Context, c *app.RequestContext) {
	var req struct {
		BaseRevision string   `json:"base_revision"`
		Scope        string   `json:"scope"`
		Refs         []string `json:"refs"`
	}
	if err := decodeStrictJSON(c.Request.Body(), &req); err != nil {
		writeProposalError(c, consts.StatusBadRequest, "invalid_request", "请求体解析失败或包含未知字段")
		return
	}
	service, ok := h.ideationService(c)
	if !ok {
		return
	}
	record, err := service.Generate(ctx, ideationDraftID(c), req.BaseRevision, req.Scope, req.Refs)
	if err != nil {
		var stale *bookideation.StaleGenerationError
		if errors.As(err, &stale) {
			current, readErr := service.Get(ctx, ideationDraftID(c))
			if readErr == nil {
				writeIdeationError(c, err, &current)
				return
			}
		}
		writeIdeationError(c, err, nil)
		return
	}
	writeIdeationDraft(c, consts.StatusOK, record, "")
}

type ideationCandidateItemInput struct {
	Ref              string   `json:"ref"`
	Name             string   `json:"name"`
	Type             string   `json:"type"`
	Content          string   `json:"content"`
	BriefDescription string   `json:"brief_description"`
	Keywords         []string `json:"keywords"`
	LoadMode         string   `json:"load_mode"`
	CharacterTier    string   `json:"character_tier"`
	Origin           string   `json:"origin"`
	SourceRefs       []string `json:"source_refs"`
	OpenNotes        string   `json:"open_notes"`
	Excluded         bool     `json:"excluded"`
}

type ideationRelationInput struct {
	Ref        string   `json:"ref"`
	SourceRef  string   `json:"source_ref"`
	TargetRef  string   `json:"target_ref"`
	Label      string   `json:"label"`
	Note       string   `json:"note"`
	Origin     string   `json:"origin"`
	SourceRefs []string `json:"source_refs"`
	Excluded   bool     `json:"excluded"`
}

// HandleBookIdeationUpdateCandidates PUT /api/book-ideation/drafts/:draftId/candidates —
// 预览页的手工编辑：改文、排除条目、选择保留的原文条目。
func (h *Handlers) HandleBookIdeationUpdateCandidates(ctx context.Context, c *app.RequestContext) {
	var req struct {
		BaseRevision string `json:"base_revision"`
		Package      struct {
			Title               string                       `json:"title"`
			BookNameSuggestions []string                     `json:"book_name_suggestions"`
			Synopsis            string                       `json:"synopsis"`
			Overview            string                       `json:"overview"`
			Items               []ideationCandidateItemInput `json:"items"`
			Relations           []ideationRelationInput      `json:"relations"`
			OpenQuestions       []string                     `json:"open_questions"`
			KeepSourceEntries   []string                     `json:"keep_source_entries"`
		} `json:"package"`
	}
	if err := decodeStrictJSON(c.Request.Body(), &req); err != nil {
		writeProposalError(c, consts.StatusBadRequest, "invalid_request", "请求体解析失败或包含未知字段")
		return
	}
	incoming := bookideation.CandidatePackage{
		Title:               req.Package.Title,
		BookNameSuggestions: req.Package.BookNameSuggestions,
		Synopsis:            req.Package.Synopsis,
		Overview:            req.Package.Overview,
		OpenQuestions:       req.Package.OpenQuestions,
		KeepSourceEntries:   req.Package.KeepSourceEntries,
	}
	for _, item := range req.Package.Items {
		incoming.Items = append(incoming.Items, bookideation.CandidateItem{
			Ref:              item.Ref,
			Name:             item.Name,
			Type:             item.Type,
			Content:          item.Content,
			BriefDescription: item.BriefDescription,
			Keywords:         item.Keywords,
			LoadMode:         item.LoadMode,
			CharacterTier:    item.CharacterTier,
			Origin:           item.Origin,
			SourceRefs:       item.SourceRefs,
			OpenNotes:        item.OpenNotes,
			Excluded:         item.Excluded,
		})
	}
	for _, relation := range req.Package.Relations {
		incoming.Relations = append(incoming.Relations, bookideation.CandidateRelation{
			Ref:        relation.Ref,
			SourceRef:  relation.SourceRef,
			TargetRef:  relation.TargetRef,
			Label:      relation.Label,
			Note:       relation.Note,
			Origin:     relation.Origin,
			SourceRefs: relation.SourceRefs,
			Excluded:   relation.Excluded,
		})
	}
	service, ok := h.ideationService(c)
	if !ok {
		return
	}
	record, err := service.UpdateCandidates(ctx, ideationDraftID(c), req.BaseRevision, incoming)
	if err != nil {
		writeIdeationError(c, err, h.currentIdeationDraft(ctx, service, ideationDraftID(c)))
		return
	}
	writeIdeationDraft(c, consts.StatusOK, record, "")
}

// HandleBookIdeationCommit POST /api/book-ideation/drafts/:draftId/commit —
// 用户确认后才建书、存总览、写条目与关系；部分失败返回可恢复回执。
func (h *Handlers) HandleBookIdeationCommit(ctx context.Context, c *app.RequestContext) {
	var req struct {
		BaseRevision string `json:"base_revision"`
		RequestID    string `json:"request_id"`
	}
	if err := decodeStrictJSON(c.Request.Body(), &req); err != nil {
		writeProposalError(c, consts.StatusBadRequest, "invalid_request", "请求体解析失败或包含未知字段")
		return
	}
	service, ok := h.ideationService(c)
	if !ok {
		return
	}
	draftID := ideationDraftID(c)
	receipt, err := service.Commit(ctx, draftID, req.BaseRevision, req.RequestID)
	current, readErr := service.Get(ctx, draftID)
	if err != nil {
		if errors.Is(err, bookideation.ErrCommitIncomplete) {
			payload := map[string]any{"error": err.Error(), "code": "commit_incomplete", "receipt": receipt}
			if readErr == nil {
				payload["draft"] = current.Draft
				payload["revision"] = current.Revision
			}
			writeJSON(c, consts.StatusBadGateway, payload)
			return
		}
		if readErr == nil {
			writeIdeationError(c, err, &current)
			return
		}
		writeIdeationError(c, err, nil)
		return
	}
	response := ideationCommitResponse{Receipt: receipt}
	if readErr == nil {
		response.Draft = current.Draft
	}
	writeJSON(c, consts.StatusOK, response)
}

// HandleBookIdeationAbandon POST /api/book-ideation/drafts/:draftId/abandon —
// 放弃构思：保留草稿文件，停止接受写入，不删除任何数据。
func (h *Handlers) HandleBookIdeationAbandon(ctx context.Context, c *app.RequestContext) {
	var req struct {
		BaseRevision string `json:"base_revision"`
	}
	if err := decodeStrictJSON(c.Request.Body(), &req); err != nil {
		writeProposalError(c, consts.StatusBadRequest, "invalid_request", "请求体解析失败或包含未知字段")
		return
	}
	service, ok := h.ideationService(c)
	if !ok {
		return
	}
	record, err := service.Abandon(ctx, ideationDraftID(c), req.BaseRevision)
	if err != nil {
		writeIdeationError(c, err, h.currentIdeationDraft(ctx, service, ideationDraftID(c)))
		return
	}
	writeIdeationDraft(c, consts.StatusOK, record, "")
}

func (h *Handlers) currentIdeationDraft(ctx context.Context, service *bookideation.Service, draftID string) *bookideation.Record {
	record, err := service.Get(ctx, draftID)
	if err != nil {
		return nil
	}
	return &record
}
