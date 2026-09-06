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
		log.Printf("[api] 总库资产加入当前冒险失败 asset_id=%q error=%v", strings.TrimSpace(c.Param("id")), err)
		writeLibraryMutationError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, result)
}

// HandleLibraryAssetDescriptionUpdate edits a lorebook's human-facing
// introduction in Master. It does not mutate the archived source file or an
// existing Adventure instance.
func (h *Handlers) HandleLibraryAssetDescriptionUpdate(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var body struct {
		Description string `json:"description"`
	}
	if err := c.BindJSON(&body); err != nil {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	item, err := book.NewMasterLibraryStore(h.app.Workspace()).UpdateMasterAssetDescription(strings.TrimSpace(c.Param("id")), body.Description)
	if err != nil {
		writeLibraryMutationError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]any{"item": item})
}

// HandleLibraryAssetFieldsUpdate saves explicit human edits without routing
// them through the model translation proposal workflow. Field values are never
// logged; the store enforces the editor's supported paths and revision check.
func (h *Handlers) HandleLibraryAssetFieldsUpdate(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var body struct {
		ExpectedRevision string            `json:"expected_revision"`
		Fields           map[string]string `json:"fields"`
	}
	if err := c.BindJSON(&body); err != nil {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	item, err := book.NewMasterLibraryStore(h.app.Workspace()).UpdateMasterAssetFields(book.MasterHumanFieldEditInput{
		MasterItemID: strings.TrimSpace(c.Param("id")), ExpectedRevision: body.ExpectedRevision, Fields: body.Fields,
	})
	if err != nil {
		log.Printf("[api] 总库人工字段保存失败 asset_id=%q field_count=%d error=%v", strings.TrimSpace(c.Param("id")), len(body.Fields), err)
		writeLibraryMutationError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]any{"item": item})
}

// HandleLibraryAssetEntryCreate adds one explicit human-authored entry to a
// Master lorebook. The request contains no model/translation data.
func (h *Handlers) HandleLibraryAssetEntryCreate(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var body struct {
		ExpectedRevision string   `json:"expected_revision"`
		Name             string   `json:"name"`
		Content          string   `json:"content"`
		Keywords         []string `json:"keywords"`
		SecondaryKeys    []string `json:"secondary_keys"`
	}
	if err := c.BindJSON(&body); err != nil {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	item, err := book.NewMasterLibraryStore(h.app.Workspace()).AddManualLorebookEntry(book.MasterManualLorebookEntryInput{
		MasterItemID: strings.TrimSpace(c.Param("id")), ExpectedRevision: body.ExpectedRevision,
		Name: body.Name, Content: body.Content, Keywords: body.Keywords, SecondaryKeys: body.SecondaryKeys,
	})
	if err != nil {
		log.Printf("[api] 总库手动新增条目失败 asset_id=%q error=%v", strings.TrimSpace(c.Param("id")), err)
		writeLibraryMutationError(c, err)
		return
	}
	writeJSON(c, consts.StatusCreated, map[string]any{"item": item})
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

// HandleLibraryAssetAdventureUsage answers whether the current Adventure uses
// this asset and whether a newer active working revision exists. The frontend
// must rely on this instead of usages.length > 0, which cannot tell "used by
// another Adventure" from "used by this one".
func (h *Handlers) HandleLibraryAssetAdventureUsage(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	usage, err := h.app.BookService().MasterAssetAdventureUsage(strings.TrimSpace(c.Param("id")))
	if err != nil {
		writeLibraryReadError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]any{"usage": usage})
}

// HandleLibraryAssetSyncAdventure re-projects one Master asset's active
// working revision onto its existing Adventure instance. It never creates a
// new instance and never runs automatically.
func (h *Handlers) HandleLibraryAssetSyncAdventure(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	masterItemID := strings.TrimSpace(c.Param("id"))
	result, err := h.app.BookService().ReprojectMasterAsset(masterItemID)
	if err != nil {
		writeLibraryMutationError(c, err)
		return
	}
	usage, usageErr := h.app.BookService().MasterAssetAdventureUsage(masterItemID)
	if usageErr == nil {
		result.Skipped = false
		writeJSON(c, consts.StatusOK, map[string]any{"result": result, "usage": usage})
		return
	}
	writeJSON(c, consts.StatusOK, map[string]any{"result": result})
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
	var body struct {
		AllowProtectedTokenMismatch bool `json:"allow_protected_token_mismatch"`
	}
	if err := c.BindJSON(&body); err != nil && len(c.Request.Body()) > 0 {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	proposal, err := book.NewMasterLibraryStore(h.app.Workspace()).ValidateMasterProposalWithOptions(strings.TrimSpace(c.Param("id")), body.AllowProtectedTokenMismatch)
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
		Confirmed                   bool `json:"confirmed"`
		ForceConflict               bool `json:"force_conflict"`
		AllowProtectedTokenMismatch bool `json:"allow_protected_token_mismatch"`
	}
	if err := c.BindJSON(&body); err != nil && len(c.Request.Body()) > 0 {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	result, err := book.NewMasterLibraryStore(h.app.Workspace()).ApplyMasterProposal(strings.TrimSpace(c.Param("id")), body.Confirmed, body.ForceConflict, body.AllowProtectedTokenMismatch)
	if err != nil {
		writeLibraryMutationError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, result)
}

func (h *Handlers) HandleLibraryProposalReject(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	proposal, err := book.NewMasterLibraryStore(h.app.Workspace()).RejectMasterProposal(strings.TrimSpace(c.Param("id")))
	if err != nil {
		writeLibraryMutationError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]any{"proposal": proposal})
}

func (h *Handlers) HandleLibraryProposalBatchApply(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	var body struct {
		ProposalIDs                 []string `json:"proposal_ids"`
		ConfirmedHighRisk           bool     `json:"confirmed_high_risk"`
		ForceConflicts              bool     `json:"force_conflicts"`
		AllowProtectedTokenMismatch bool     `json:"allow_protected_token_mismatch"`
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
	result := book.NewMasterLibraryStore(h.app.Workspace()).ApplyMasterProposals(strings.TrimSpace(c.Param("id")), body.ProposalIDs, body.ConfirmedHighRisk, body.ForceConflicts, body.AllowProtectedTokenMismatch)
	writeJSON(c, consts.StatusOK, result)
}

func (h *Handlers) HandleLibraryProposalBatchReject(ctx context.Context, c *app.RequestContext) {
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
		writeError(c, consts.StatusBadRequest, "一次最多删除 100 个 Proposal")
		return
	}
	result := book.NewMasterLibraryStore(h.app.Workspace()).RejectMasterProposals(strings.TrimSpace(c.Param("id")), body.ProposalIDs)
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
