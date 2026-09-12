package handlers

import (
	"context"
	"encoding/json"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/protocol/consts"

	"denova/internal/worldcontext"
)

// Phase 3.1A1：只读世界上下文预览端点。
//
// 冻结边界（见 docs/plans/WORLD_WORKSPACE_PHASE3_1_WORLD_CONSOLE_IMPLEMENTATION_PLAN.md §3/§5）：
//   - 只调用 App.PreviewWorldContext 外观：GetWorld → BuildSnapshot → ProjectForUI；
//   - 无写入副作用、不创建 runContext、不占 Registry、不读 InteractiveRun/Task/analysisHandle；
//   - 不调用模型、不读 Master 详情、不接四模式；
//   - handler 边界使用显式 camelCase transport DTO，不直接序列化内部 worldcontext.Selection
//     （其字段无 JSON tag，直接编码会泄漏 PascalCase）；
//   - 响应只含 UI Projection，禁止 ModelView/ProjectionBody/sourceRef/runSalt/runContext/sidecar。

const maxContextPreviewRequestBodyBytes = 64 << 10 // 64 KiB：请求只含 consumer/revision/selection

// contextPreviewSelectionRequest 是请求侧选择器的 wire 形态（camelCase 白名单）。
type contextPreviewSelectionRequest struct {
	IncludeTone      bool     `json:"includeTone"`
	RuleIndexes      []int    `json:"ruleIndexes"`
	CharacterIDs     []string `json:"characterIds"`
	LocationIDs      []string `json:"locationIds"`
	FactionIDs       []string `json:"factionIds"`
	TimelineEntryIDs []string `json:"timelineEntryIds"`
	BindingIDs       []string `json:"bindingIds"`
}

// contextPreviewRequest 是 POST /api/worlds/:id/context-preview 请求体；
// 故意不含 worldId：path :id 是唯一世界来源，DisallowUnknownFields 会拒绝 body 内 worldId。
type contextPreviewRequest struct {
	Consumer              string                         `json:"consumer"`
	ExpectedWorldRevision string                         `json:"expectedWorldRevision"`
	Selection             contextPreviewSelectionRequest `json:"selection"`
}

// contextPreviewSelectionWire 是 canonicalSelection 的公共 wire 形态（严格 camelCase）。
type contextPreviewSelectionWire struct {
	IncludeTone      bool     `json:"includeTone"`
	RuleIndexes      []int    `json:"ruleIndexes"`
	CharacterIDs     []string `json:"characterIds"`
	LocationIDs      []string `json:"locationIds"`
	FactionIDs       []string `json:"factionIds"`
	TimelineEntryIDs []string `json:"timelineEntryIds"`
	BindingIDs       []string `json:"bindingIds"`
}

type contextPreviewIdentityWire struct {
	Name    string `json:"name"`
	Tagline string `json:"tagline,omitempty"`
	Genre   string `json:"genre,omitempty"`
	Summary string `json:"summary,omitempty"`
}

type contextPreviewSettingWire struct {
	Tone  string   `json:"tone,omitempty"`
	Rules []string `json:"rules"`
}

type contextPreviewRelationshipWire struct {
	TargetCharacterID string `json:"targetCharacterId"`
	Label             string `json:"label"`
}

type contextPreviewCharacterWire struct {
	ID            string                           `json:"id"`
	DisplayName   string                           `json:"displayName"`
	Role          string                           `json:"role,omitempty"`
	WorldNote     string                           `json:"worldNote,omitempty"`
	FactionID     string                           `json:"factionId,omitempty"`
	LocationID    string                           `json:"locationId,omitempty"`
	Relationships []contextPreviewRelationshipWire `json:"relationships"`
}

type contextPreviewLocationWire struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Tags        []string `json:"tags"`
}

type contextPreviewFactionWire struct {
	ID                     string `json:"id"`
	Name                   string `json:"name"`
	Description            string `json:"description,omitempty"`
	Influence              *int   `json:"influence,omitempty"`
	Stability              *int   `json:"stability,omitempty"`
	HeadquartersLocationID string `json:"headquartersLocationId,omitempty"`
}

type contextPreviewTimelineWire struct {
	ID          string `json:"id"`
	Order       int    `json:"order"`
	EraLabel    string `json:"eraLabel,omitempty"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Category    string `json:"category"`
}

type contextPreviewMaterialWire struct {
	BindingID    string   `json:"bindingId"`
	MasterItemID string   `json:"masterItemId"`
	Name         string   `json:"name"`
	Tags         []string `json:"tags"`
	SemanticType string   `json:"semanticType"`
	Scope        string   `json:"scope"`
}

type contextPreviewOmissionWire struct {
	Kind            string `json:"kind"`
	OwnerEntityID   string `json:"ownerEntityId"`
	MissingEntityID string `json:"missingEntityId"`
	Reason          string `json:"reason"`
}

type contextPreviewWarningWire struct {
	Code    string `json:"code"`
	RefKind string `json:"refKind,omitempty"`
	RefID   string `json:"refId,omitempty"`
}

type contextPreviewStatsWire struct {
	CharacterCount int `json:"characterCount"`
	LocationCount  int `json:"locationCount"`
	FactionCount   int `json:"factionCount"`
	TimelineCount  int `json:"timelineCount"`
	MaterialCount  int `json:"materialCount"`
}

type contextPreviewSourceWire struct {
	Kind         string `json:"kind"`
	EntityID     string `json:"entityId,omitempty"`
	BindingID    string `json:"bindingId,omitempty"`
	MasterItemID string `json:"masterItemId,omitempty"`
	FieldPath    string `json:"fieldPath,omitempty"`
}

// contextPreviewView 是完整的 HTTP response DTO。它不嵌入任何 worldcontext
// 领域结构，防止内部类型以后新增 JSON 字段时无意扩张公共 wire schema。
type contextPreviewView struct {
	SchemaVersion      int                                 `json:"schemaVersion"`
	WorldID            string                              `json:"worldId"`
	WorldRevision      string                              `json:"worldRevision"`
	Consumer           string                              `json:"consumer"`
	ContextFingerprint string                              `json:"contextFingerprint"`
	CanonicalSelection contextPreviewSelectionWire         `json:"canonicalSelection"`
	Identity           contextPreviewIdentityWire          `json:"identity"`
	Setting            *contextPreviewSettingWire          `json:"setting,omitempty"`
	Characters         []contextPreviewCharacterWire       `json:"characters"`
	Locations          []contextPreviewLocationWire        `json:"locations"`
	Factions           []contextPreviewFactionWire         `json:"factions"`
	Timeline           []contextPreviewTimelineWire        `json:"timeline"`
	Materials          []contextPreviewMaterialWire        `json:"materials"`
	Omissions          []contextPreviewOmissionWire        `json:"omissions"`
	Warnings           []contextPreviewWarningWire         `json:"warnings"`
	Stats              contextPreviewStatsWire             `json:"stats"`
	SourceTable        map[string]contextPreviewSourceWire `json:"sourceTable"`
	RevisionLabel      string                              `json:"revisionLabel"`
	IsDraftPreview     bool                                `json:"isDraftPreview"`
}

func stringSliceOrEmpty(in []string) []string {
	if len(in) == 0 {
		return []string{}
	}
	return append([]string(nil), in...)
}

func toSelectionWire(s worldcontext.Selection) contextPreviewSelectionWire {
	ruleIndexes := s.RuleIndexes
	if len(ruleIndexes) == 0 {
		ruleIndexes = []int{}
	} else {
		ruleIndexes = append([]int(nil), ruleIndexes...)
	}
	return contextPreviewSelectionWire{
		IncludeTone:      s.IncludeTone,
		RuleIndexes:      ruleIndexes,
		CharacterIDs:     stringSliceOrEmpty(s.CharacterIDs),
		LocationIDs:      stringSliceOrEmpty(s.LocationIDs),
		FactionIDs:       stringSliceOrEmpty(s.FactionIDs),
		TimelineEntryIDs: stringSliceOrEmpty(s.TimelineEntryIDs),
		BindingIDs:       stringSliceOrEmpty(s.BindingIDs),
	}
}

// decodeContextPreviewSelection keeps the HTTP DTO explicit while delegating
// all frozen shape/count limits to the canonical worldcontext decoder.
func decodeContextPreviewSelection(s contextPreviewSelectionRequest) (worldcontext.Selection, error) {
	raw, err := json.Marshal(s)
	if err != nil {
		return worldcontext.Selection{}, &worldcontext.DomainError{
			Code: worldcontext.ErrInvalidRequest, Field: "selection", Message: "选择参数无法解析",
		}
	}
	return worldcontext.DecodeSelection(raw)
}

func contextPreviewViewFromDomain(view *worldcontext.UIView) contextPreviewView {
	wire := contextPreviewView{
		SchemaVersion:      view.SchemaVersion,
		WorldID:            view.WorldID,
		WorldRevision:      view.WorldRevision,
		Consumer:           string(view.Consumer),
		ContextFingerprint: view.ContextFingerprint,
		CanonicalSelection: toSelectionWire(view.CanonicalSelection),
		Identity: contextPreviewIdentityWire{
			Name: view.Identity.Name, Tagline: view.Identity.Tagline,
			Genre: view.Identity.Genre, Summary: view.Identity.Summary,
		},
		Characters:     make([]contextPreviewCharacterWire, 0, len(view.Characters)),
		Locations:      make([]contextPreviewLocationWire, 0, len(view.Locations)),
		Factions:       make([]contextPreviewFactionWire, 0, len(view.Factions)),
		Timeline:       make([]contextPreviewTimelineWire, 0, len(view.Timeline)),
		Materials:      make([]contextPreviewMaterialWire, 0, len(view.Materials)),
		Omissions:      make([]contextPreviewOmissionWire, 0, len(view.Omissions)),
		Warnings:       make([]contextPreviewWarningWire, 0, len(view.Warnings)),
		SourceTable:    make(map[string]contextPreviewSourceWire, len(view.SourceTable)),
		RevisionLabel:  view.RevisionLabel,
		IsDraftPreview: view.IsDraftPreview,
		Stats: contextPreviewStatsWire{
			CharacterCount: view.Stats.CharacterCount, LocationCount: view.Stats.LocationCount,
			FactionCount: view.Stats.FactionCount, TimelineCount: view.Stats.TimelineCount,
			MaterialCount: view.Stats.MaterialCount,
		},
	}
	if view.Setting != nil {
		wire.Setting = &contextPreviewSettingWire{Tone: view.Setting.Tone, Rules: stringSliceOrEmpty(view.Setting.Rules)}
	}
	for _, character := range view.Characters {
		item := contextPreviewCharacterWire{
			ID: character.ID, DisplayName: character.DisplayName, Role: string(character.Role),
			WorldNote: character.WorldNote, FactionID: character.FactionID, LocationID: character.LocationID,
			Relationships: make([]contextPreviewRelationshipWire, 0, len(character.Relationships)),
		}
		for _, relationship := range character.Relationships {
			item.Relationships = append(item.Relationships, contextPreviewRelationshipWire{
				TargetCharacterID: relationship.TargetCharacterID, Label: relationship.Label,
			})
		}
		wire.Characters = append(wire.Characters, item)
	}
	for _, location := range view.Locations {
		wire.Locations = append(wire.Locations, contextPreviewLocationWire{
			ID: location.ID, Name: location.Name, Description: location.Description,
			Tags: stringSliceOrEmpty(location.Tags),
		})
	}
	for _, faction := range view.Factions {
		wire.Factions = append(wire.Factions, contextPreviewFactionWire{
			ID: faction.ID, Name: faction.Name, Description: faction.Description,
			Influence: faction.Influence, Stability: faction.Stability,
			HeadquartersLocationID: faction.HeadquartersLocationID,
		})
	}
	for _, entry := range view.Timeline {
		wire.Timeline = append(wire.Timeline, contextPreviewTimelineWire{
			ID: entry.ID, Order: entry.Order, EraLabel: entry.EraLabel,
			Title: entry.Title, Description: entry.Description, Category: string(entry.Category),
		})
	}
	for _, material := range view.Materials {
		wire.Materials = append(wire.Materials, contextPreviewMaterialWire{
			BindingID: material.BindingID, MasterItemID: material.MasterItemID,
			Name: material.Name, Tags: stringSliceOrEmpty(material.Tags),
			SemanticType: string(material.SemanticType), Scope: string(material.Scope),
		})
	}
	for _, omission := range view.Omissions {
		wire.Omissions = append(wire.Omissions, contextPreviewOmissionWire{
			Kind: string(omission.Kind), OwnerEntityID: omission.OwnerEntityID,
			MissingEntityID: omission.MissingEntityID, Reason: string(omission.Reason),
		})
	}
	for _, warning := range view.Warnings {
		wire.Warnings = append(wire.Warnings, contextPreviewWarningWire{
			Code: string(warning.Code), RefKind: warning.RefKind, RefID: warning.RefID,
		})
	}
	for key, source := range view.SourceTable {
		wire.SourceTable[key] = contextPreviewSourceWire{
			Kind: string(source.Kind), EntityID: source.EntityID, BindingID: source.BindingID,
			MasterItemID: source.MasterItemID, FieldPath: source.FieldPath,
		}
	}
	return wire
}

// contextPreviewErrorStatus 把稳定领域错误码映射为 HTTP 状态。
func contextPreviewErrorStatus(code worldcontext.ErrorCode) int {
	switch code {
	case worldcontext.ErrInvalidRequest, worldcontext.ErrSelectionInvalid:
		return consts.StatusBadRequest
	case worldcontext.ErrConsumerNotTrusted:
		return consts.StatusForbidden
	case worldcontext.ErrWorldNotFound:
		return consts.StatusNotFound
	case worldcontext.ErrRevisionConflict, worldcontext.ErrWorldArchived, worldcontext.ErrContextRefMismatch:
		return consts.StatusConflict
	case worldcontext.ErrBudgetExceeded:
		return consts.StatusRequestEntityTooLarge
	case worldcontext.ErrWorldUnavailable, worldcontext.ErrContextUnavailable:
		return consts.StatusServiceUnavailable
	default: // ErrProjectionFailed 及其它未知内部错误
		return consts.StatusInternalServerError
	}
}

// writeContextPreviewError 输出稳定 code + 安全文案；只回传 field/layer/不可寻址 id 清单，
// 非领域错误统一为 projection_failed 通用文案，绝不回传内部 err.Error()/磁盘路径。
func writeContextPreviewError(c *app.RequestContext, err error) {
	code := worldcontext.CodeOf(err)
	status := contextPreviewErrorStatus(code)
	payload := map[string]any{"code": string(code)}
	if de, ok := err.(*worldcontext.DomainError); ok {
		payload["error"] = de.Message
		if de.Field != "" {
			payload["field"] = de.Field
		}
		if de.Layer != "" {
			payload["layer"] = de.Layer
		}
		if len(de.Invalid) > 0 {
			payload["invalid"] = de.Invalid
		}
	} else {
		payload["error"] = "世界上下文预览失败"
	}
	c.JSON(status, payload)
}

func writeContextPreviewRequestError(c *app.RequestContext, msg string) {
	c.JSON(consts.StatusBadRequest, map[string]any{
		"code":  string(worldcontext.ErrInvalidRequest),
		"error": msg,
	})
}

// HandleWorldContextPreview POST /api/worlds/:id/context-preview —— 只读世界上下文预览。
func (h *Handlers) HandleWorldContextPreview(ctx context.Context, c *app.RequestContext) {
	worldID := c.Param("id")
	if worldID == "" {
		writeContextPreviewRequestError(c, "世界 id 不能为空")
		return
	}

	body := c.Request.Body()
	if len(body) == 0 {
		writeContextPreviewRequestError(c, "请求体不能为空")
		return
	}
	if len(body) > maxContextPreviewRequestBodyBytes {
		writeContextPreviewRequestError(c, "请求体过大（上限 64 KiB）")
		return
	}

	var req contextPreviewRequest
	if err := decodeStrictJSON(body, &req); err != nil {
		writeContextPreviewRequestError(c, "请求体解析失败或包含未知字段")
		return
	}

	// consumer 可信边界：仅 writing/game；narraverse/module4/空值/其它一律拒绝，不退化为其它 consumer。
	var consumer worldcontext.Consumer
	switch req.Consumer {
	case string(worldcontext.ConsumerWriting):
		consumer = worldcontext.ConsumerWriting
	case string(worldcontext.ConsumerGame):
		consumer = worldcontext.ConsumerGame
	default:
		writeContextPreviewError(c, &worldcontext.DomainError{
			Code: worldcontext.ErrConsumerNotTrusted, Field: "consumer",
			Message: "当前阶段不允许该模式请求世界上下文",
		})
		return
	}

	selection, err := decodeContextPreviewSelection(req.Selection)
	if err != nil {
		writeContextPreviewError(c, err)
		return
	}
	ref := worldcontext.Ref{
		WorldID:               worldID,
		ExpectedWorldRevision: req.ExpectedWorldRevision,
		Selection:             selection,
	}

	view, err := h.app.PreviewWorldContext(ctx, consumer, ref)
	if err != nil {
		writeContextPreviewError(c, err)
		return
	}

	wire := contextPreviewViewFromDomain(view)
	writeJSON(c, consts.StatusOK, map[string]any{"preview": wire})
}
