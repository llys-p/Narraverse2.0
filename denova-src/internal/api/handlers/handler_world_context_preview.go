package handlers

import (
	"context"
	"strings"

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

// contextPreviewView 嵌入内部 UIView 复用其已带 camelCase tag 的投影字段，
// 并在更浅层显式声明 canonicalSelection，遮蔽内部无 tag 的 Selection（避免 PascalCase 泄漏）。
type contextPreviewView struct {
	*worldcontext.UIView
	CanonicalSelection contextPreviewSelectionWire `json:"canonicalSelection"`
}

func toSelectionWire(s worldcontext.Selection) contextPreviewSelectionWire {
	orEmptyStr := func(in []string) []string {
		if len(in) == 0 {
			return []string{}
		}
		return in
	}
	ruleIndexes := s.RuleIndexes
	if len(ruleIndexes) == 0 {
		ruleIndexes = []int{}
	}
	return contextPreviewSelectionWire{
		IncludeTone:      s.IncludeTone,
		RuleIndexes:      ruleIndexes,
		CharacterIDs:     orEmptyStr(s.CharacterIDs),
		LocationIDs:      orEmptyStr(s.LocationIDs),
		FactionIDs:       orEmptyStr(s.FactionIDs),
		TimelineEntryIDs: orEmptyStr(s.TimelineEntryIDs),
		BindingIDs:       orEmptyStr(s.BindingIDs),
	}
}

func toInternalSelection(s contextPreviewSelectionRequest) worldcontext.Selection {
	return worldcontext.Selection{
		IncludeTone:      s.IncludeTone,
		RuleIndexes:      s.RuleIndexes,
		CharacterIDs:     s.CharacterIDs,
		LocationIDs:      s.LocationIDs,
		FactionIDs:       s.FactionIDs,
		TimelineEntryIDs: s.TimelineEntryIDs,
		BindingIDs:       s.BindingIDs,
	}
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
	worldID := strings.TrimSpace(c.Param("id"))
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
	switch strings.TrimSpace(req.Consumer) {
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

	ref := worldcontext.Ref{
		WorldID:               worldID,
		ExpectedWorldRevision: strings.TrimSpace(req.ExpectedWorldRevision),
		Selection:             toInternalSelection(req.Selection),
	}

	view, err := h.app.PreviewWorldContext(ctx, consumer, ref)
	if err != nil {
		writeContextPreviewError(c, err)
		return
	}

	wire := contextPreviewView{
		UIView:             view,
		CanonicalSelection: toSelectionWire(view.CanonicalSelection),
	}
	writeJSON(c, consts.StatusOK, map[string]any{"preview": wire})
}
