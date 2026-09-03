package handlers

import (
	"context"
	"errors"
	"log"
	"os"
	"strconv"
	"strings"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/protocol/consts"

	"denova/internal/api/sse"
	"denova/internal/book"
)

// HandleLibraryImportMaterial imports a source into Master only. It does not
// create an Adventure instance; the returned targets are queued by the client.
func (h *Handlers) HandleLibraryImportMaterial(ctx context.Context, c *app.RequestContext) {
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
	}
	result, err := h.app.BookService().ImportMaterialToMaster(filename, data, options)
	if err != nil {
		log.Printf("[api] 总库素材导入失败 filename=%q error=%v", filename, err)
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	writeJSON(c, consts.StatusCreated, result)
}

// HandleLibraryAssets returns the read-only Master asset projection.
func (h *Handlers) HandleLibraryAssets(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	query := book.MasterAssetQuery{
		Query: c.Query("q"), RecordKind: c.Query("record_kind"),
		SemanticType: c.Query("semantic_type"), Availability: c.Query("availability"),
		Limit: queryInt(c.Query("limit"), 100), Offset: queryInt(c.Query("offset"), 0),
	}
	result, err := book.NewMasterLibraryStore(h.app.Workspace()).ListAssets(query)
	if err != nil {
		writeLibraryReadError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, result)
}

// HandleLibraryAsset returns one asset with source, translations and usages.
func (h *Handlers) HandleLibraryAsset(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	result, err := book.NewMasterLibraryStore(h.app.Workspace()).GetAsset(strings.TrimSpace(c.Param("id")))
	if err != nil {
		writeLibraryReadError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, result)
}

func (h *Handlers) HandleLibraryAssetPipeline(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	result, err := book.NewMasterLibraryStore(h.app.Workspace()).GetAssetPipeline(strings.TrimSpace(c.Param("id")))
	if err != nil {
		writeLibraryReadError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, result)
}

func (h *Handlers) HandleLibraryAssetTranslations(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	result, err := book.NewMasterLibraryStore(h.app.Workspace()).GetAsset(strings.TrimSpace(c.Param("id")))
	if err != nil {
		writeLibraryReadError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]any{"translations": result.Translations})
}

func (h *Handlers) HandleLibraryAssetUsages(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	result, err := book.NewMasterLibraryStore(h.app.Workspace()).GetAsset(strings.TrimSpace(c.Param("id")))
	if err != nil {
		writeLibraryReadError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]any{"usages": result.Usages})
}

// HandleLibraryAssetInstantiate creates the current Adventure instance for a
// usable Master asset. Repeated requests are idempotent.
func (h *Handlers) HandleLibraryAssetInstantiate(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	result, err := h.app.BookService().InstantiateMasterAsset(strings.TrimSpace(c.Param("id")))
	if err != nil {
		writeLibraryMutationError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, result)
}

// HandleLibraryAssetRuntime returns the backend-only read projection that
// joins Master translation versions with the live 8097 queue.
func (h *Handlers) HandleLibraryAssetRuntime(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	result, err := book.NewMasterLibraryStore(h.app.Workspace()).GetAssetRuntime(strings.TrimSpace(c.Param("id")))
	if err != nil {
		writeLibraryReadError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, result)
}

func (h *Handlers) HandleLibraryAssetProposals(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	result, err := book.NewMasterLibraryStore(h.app.Workspace()).ListMasterProposals(strings.TrimSpace(c.Param("id")))
	if err != nil {
		writeLibraryReadError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, result)
}

func (h *Handlers) HandleLibraryProposalCreate(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var input book.MasterProposalInput
	if err := c.BindJSON(&input); err != nil {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	input.MasterItemID = strings.TrimSpace(c.Param("id"))
	proposal, err := book.NewMasterLibraryStore(h.app.Workspace()).CreateMasterProposal(input)
	if err != nil {
		writeLibraryMutationError(c, err)
		return
	}
	writeJSON(c, consts.StatusCreated, map[string]any{"proposal": proposal})
}

func (h *Handlers) HandleLibraryProposalValidate(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	proposal, err := book.NewMasterLibraryStore(h.app.Workspace()).ValidateMasterProposal(strings.TrimSpace(c.Param("id")))
	if err != nil {
		writeLibraryMutationError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]any{"proposal": proposal})
}

func (h *Handlers) HandleLibraryProposalApply(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var body struct {
		Confirmed bool `json:"confirmed"`
	}
	if err := c.BindJSON(&body); err != nil && len(c.Request.Body()) > 0 {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	result, err := book.NewMasterLibraryStore(h.app.Workspace()).ApplyMasterProposal(strings.TrimSpace(c.Param("id")), body.Confirmed)
	if err != nil {
		writeLibraryMutationError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, result)
}

func (h *Handlers) HandleLibraryProposalBatchApply(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var body struct {
		ProposalIDs []string `json:"proposal_ids"`
	}
	if err := c.BindJSON(&body); err != nil {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	if len(body.ProposalIDs) == 0 {
		writeError(c, consts.StatusBadRequest, "至少选择一个 Proposal")
		return
	}
	if len(body.ProposalIDs) > 100 {
		writeError(c, consts.StatusBadRequest, "一次最多应用 100 个 Proposal")
		return
	}
	result := book.NewMasterLibraryStore(h.app.Workspace()).ApplyMasterProposals(strings.TrimSpace(c.Param("id")), body.ProposalIDs)
	writeJSON(c, consts.StatusOK, result)
}

func (h *Handlers) HandleLibraryMasterAgentStart(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var body struct {
		FieldPath string `json:"field_path"`
		Kind      string `json:"kind"`
		Message   string `json:"message"`
	}
	if err := c.BindJSON(&body); err != nil {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	task, err := h.app.StartMasterAgentTask(ctx, strings.TrimSpace(c.Param("id")), strings.TrimSpace(body.FieldPath), body.Kind, body.Message)
	if err != nil {
		writeLibraryMutationError(c, err)
		return
	}
	writeJSON(c, consts.StatusAccepted, map[string]any{"task_id": task.ID(), "status": task.Status()})
}

func (h *Handlers) HandleLibraryMasterAgentStream(ctx context.Context, c *app.RequestContext) {
	task := h.app.MasterAgentTask(strings.TrimSpace(c.Param("id")))
	if task == nil {
		writeError(c, consts.StatusNotFound, "Master Agent 任务不存在")
		return
	}
	sse.StreamTaskUI(c, task)
}

func queryInt(value string, fallback int) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return fallback
	}
	return parsed
}

func writeLibraryReadError(c *app.RequestContext, err error) {
	status := consts.StatusInternalServerError
	if errors.Is(err, os.ErrNotExist) || strings.Contains(err.Error(), "不存在") {
		status = consts.StatusNotFound
	}
	writeError(c, status, err.Error())
}

func writeLibraryMutationError(c *app.RequestContext, err error) {
	status := consts.StatusBadRequest
	var conflict *book.MasterCASConflictError
	if errors.As(err, &conflict) {
		status = consts.StatusConflict
	}
	writeError(c, status, err.Error())
}
