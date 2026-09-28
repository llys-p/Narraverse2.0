package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"time"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/protocol"
	"github.com/cloudwego/hertz/pkg/protocol/consts"

	novaApp "denova/internal/app"
	"denova/internal/libraryruntime"
	"denova/internal/worldcontext"
)

const hostSessionCookie = "denova_host_session"

const (
	hostModelMaxMessages     = 64
	hostModelMaxMessageRunes = 32_000
	hostModelMaxTotalRunes   = 48_000
	hostModelMaxBodyBytes    = 96 << 10
)

type hostBindWire struct {
	FrameInstance  string          `json:"frameInstance"`
	WorldContext   json.RawMessage `json:"world_context"`
	LibraryContext json.RawMessage `json:"library_context"`
}

// hostLibraryContextWire 是受控 iframe 的库载体（camelCase，与 L2 预览 DTO 一致）；
// consumer/scopeKey 由宿主层派生，出现即拒绝。
type hostLibraryContextWire struct {
	LibraryID        string   `json:"libraryId"`
	ExpectedRevision string   `json:"expectedRevision"`
	ManualItemIDs    []string `json:"manualItemIds"`
}

func hostRawPresent(raw json.RawMessage) bool {
	return len(bytes.TrimSpace(raw)) > 0
}

// hostBindCarrierConflict 报告一次 bind 同时携带 world 与 library 两种背景载体
// （B4a/L3.3：两类互斥，不做优先级吞并）。
func hostBindCarrierConflict(wire hostBindWire) bool {
	return hostRawPresent(wire.WorldContext) && hostRawPresent(wire.LibraryContext)
}

// decodeHostLibraryContext 严格解析库载体：未知字段、空库 ID、空版本、空白条目一律拒绝。
func decodeHostLibraryContext(raw json.RawMessage) (novaApp.HostFrameLibraryControl, error) {
	if exactObjectKeys(raw, map[string]struct{}{"libraryId": {}, "expectedRevision": {}, "manualItemIds": {}}) != nil {
		return novaApp.HostFrameLibraryControl{}, errors.New("library context shape is invalid")
	}
	var wire hostLibraryContextWire
	if err := decodeStrictJSON(raw, &wire); err != nil {
		return novaApp.HostFrameLibraryControl{}, err
	}
	ctrl := novaApp.HostFrameLibraryControl{
		LibraryID:        strings.TrimSpace(wire.LibraryID),
		ExpectedRevision: strings.TrimSpace(wire.ExpectedRevision),
	}
	if ctrl.LibraryID == "" || ctrl.ExpectedRevision == "" {
		return novaApp.HostFrameLibraryControl{}, errors.New("library id and revision are required")
	}
	for _, itemID := range wire.ManualItemIDs {
		trimmed := strings.TrimSpace(itemID)
		if trimmed == "" {
			return novaApp.HostFrameLibraryControl{}, errors.New("manual item id must not be blank")
		}
		ctrl.ManualItemIDs = append(ctrl.ManualItemIDs, trimmed)
	}
	return ctrl, nil
}

type hostModelOptionsWire struct {
	MaxTokens   int      `json:"maxTokens,omitempty"`
	Temperature *float32 `json:"temperature,omitempty"`
}

type hostModelCallWire struct {
	FrameInstance string                        `json:"frameInstance"`
	Messages      []novaApp.ModelGatewayMessage `json:"messages"`
	Options       hostModelOptionsWire          `json:"options"`
}

func validateHostModelCall(wire hostModelCallWire) error {
	if len(wire.Messages) == 0 || len(wire.Messages) > hostModelMaxMessages || wire.Options.MaxTokens < 0 || wire.Options.MaxTokens > 8192 {
		return errors.New("host model request exceeds limits")
	}
	totalRunes := 0
	for _, message := range wire.Messages {
		if message.Role != "system" && message.Role != "user" && message.Role != "assistant" {
			return errors.New("host model message role is invalid")
		}
		messageRunes := len([]rune(message.Content))
		if messageRunes == 0 || messageRunes > hostModelMaxMessageRunes {
			return errors.New("host model message exceeds limits")
		}
		totalRunes += messageRunes
	}
	if totalRunes > hostModelMaxTotalRunes || (wire.Options.Temperature != nil && (*wire.Options.Temperature < 0 || *wire.Options.Temperature > 2)) {
		return errors.New("host model request exceeds limits")
	}
	return nil
}

func exactObjectKeys(body []byte, allowed map[string]struct{}) error {
	trimmed := bytes.TrimSpace(body)
	var keys map[string]json.RawMessage
	if len(trimmed) == 0 || json.Unmarshal(trimmed, &keys) != nil || keys == nil {
		return errors.New("request must be one JSON object")
	}
	for key := range keys {
		if _, ok := allowed[key]; !ok {
			return errors.New("request contains unknown field")
		}
	}
	return nil
}

func hostRequestBody(c *app.RequestContext, limit int) ([]byte, error) {
	body := c.Request.Body()
	if len(body) == 0 || len(body) > limit {
		return nil, errors.New("invalid request body")
	}
	return body, nil
}

func directLoopbackRequest(c *app.RequestContext) bool {
	addr := c.RemoteAddr()
	if addr == nil {
		return false
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(addr.String()))
	if err != nil {
		host = strings.TrimSpace(addr.String())
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (h *Handlers) trustedWorldContextHostRequest(c *app.RequestContext) bool {
	if !directLoopbackRequest(c) {
		return false
	}
	expected := h.app.RuntimeHostOrigin()
	return expected != "" && string(c.Request.Header.Peek("Origin")) == expected
}

func hostToken(c *app.RequestContext) string {
	return string(c.Cookie(hostSessionCookie))
}

func writeHostTrustError(c *app.RequestContext) {
	c.JSON(consts.StatusForbidden, map[string]string{
		"code":  string(worldcontext.ErrConsumerNotTrusted),
		"error": "宿主会话无效或已过期",
	})
}

// HandleWorldContextHostBootstrap consumes the process-issued one-shot secret
// and sets an HttpOnly Strict cookie. The token is never returned in JSON.
func (h *Handlers) HandleWorldContextHostBootstrap(ctx context.Context, c *app.RequestContext) {
	if !h.trustedWorldContextHostRequest(c) || !strings.HasPrefix(strings.ToLower(string(c.Request.Header.ContentType())), "application/json") {
		writeHostTrustError(c)
		return
	}
	body, err := hostRequestBody(c, 1024)
	if err != nil || exactObjectKeys(body, map[string]struct{}{"secret": {}}) != nil {
		writeContextPreviewRequestError(c, "宿主 bootstrap 请求格式无效")
		return
	}
	var wire struct {
		Secret string `json:"secret"`
	}
	if err := decodeStrictJSON(body, &wire); err != nil {
		writeContextPreviewRequestError(c, "宿主 bootstrap 请求格式无效")
		return
	}
	token, expiresAt, err := h.app.BootstrapWorldContextHost(wire.Secret)
	if err != nil {
		writeHostTrustError(c)
		return
	}
	maxAge := int(time.Until(expiresAt).Seconds())
	if maxAge < 1 {
		maxAge = 1
	}
	c.SetCookie(hostSessionCookie, token, maxAge, "/api/world-context/host", "", protocol.CookieSameSiteStrictMode, false, true)
	c.JSON(consts.StatusOK, map[string]any{"status": "ready", "expiresAt": expiresAt.UTC().Format(time.RFC3339)})
}

func (h *Handlers) HandleWorldContextHostStatus(ctx context.Context, c *app.RequestContext) {
	if !h.trustedWorldContextHostRequest(c) {
		writeHostTrustError(c)
		return
	}
	body, err := hostRequestBody(c, 16)
	if err != nil || exactObjectKeys(body, map[string]struct{}{}) != nil {
		writeContextPreviewRequestError(c, "宿主状态请求格式无效")
		return
	}
	if h.app.WorldContextHostStatus(hostToken(c)) != nil {
		writeHostTrustError(c)
		return
	}
	c.JSON(consts.StatusOK, map[string]string{"status": "ready"})
}

func (h *Handlers) handleWorldContextHostBind(ctx context.Context, c *app.RequestContext, consumer worldcontext.Consumer) {
	if !h.trustedWorldContextHostRequest(c) {
		writeHostTrustError(c)
		return
	}
	body, err := hostRequestBody(c, 64*1024)
	if err != nil || exactObjectKeys(body, map[string]struct{}{"frameInstance": {}, "world_context": {}, "library_context": {}}) != nil {
		writeContextPreviewRequestError(c, "iframe 绑定请求格式无效")
		return
	}
	var wire hostBindWire
	if err := decodeStrictJSON(body, &wire); err != nil {
		writeContextPreviewRequestError(c, "iframe 绑定请求格式无效")
		return
	}
	// 背景载体互斥（B4a/L3.3）：一次 bind 只承载 world 或 library 一种背景，
	// 不做优先级吞并；两类都不携带时是显式 bare 绑定（state=none）。
	if hostBindCarrierConflict(wire) {
		writeContextPreviewRequestError(c, "iframe 绑定不接受同时携带世界与库背景")
		return
	}
	if hostRawPresent(wire.LibraryContext) {
		ctrl, decodeErr := decodeHostLibraryContext(wire.LibraryContext)
		if decodeErr != nil {
			writeContextPreviewRequestError(c, "iframe 库绑定请求格式无效")
			return
		}
		state, bindErr := h.app.BindLibraryHostFrame(ctx, hostToken(c), consumer, wire.FrameInstance, ctrl)
		if bindErr != nil {
			h.writeHostBindError(c, bindErr)
			return
		}
		c.JSON(consts.StatusOK, map[string]any{"contextSummary": state})
		return
	}
	var ref *worldcontext.Ref
	if hostRawPresent(wire.WorldContext) {
		ref, err = decodeWorldContextRef(wire.WorldContext)
		if err != nil {
			writeContextPreviewError(c, err)
			return
		}
	}
	state, err := h.app.BindWorldContextHostFrame(ctx, hostToken(c), consumer, wire.FrameInstance, ref)
	if err != nil {
		writeContextPreviewError(c, err)
		return
	}
	c.JSON(consts.StatusOK, map[string]any{"contextSummary": state})
}

// writeHostBindError 下发 iframe 绑定期错误：库载体错误复用 libraryruntime 稳定码映射，
// 其余走 worldcontext 领域错误映射；两类文案都不含库正文、运行秘密或本机路径。
func (h *Handlers) writeHostBindError(c *app.RequestContext, err error) {
	var libErr *libraryruntime.Error
	if errors.As(err, &libErr) {
		h.writeLibraryRuntimePreparationError(c, libErr)
		return
	}
	writeContextPreviewError(c, err)
}

func (h *Handlers) HandleWorldContextHostNarraverseBind(ctx context.Context, c *app.RequestContext) {
	h.handleWorldContextHostBind(ctx, c, worldcontext.ConsumerNarraverse)
}

func (h *Handlers) HandleWorldContextHostModule4Bind(ctx context.Context, c *app.RequestContext) {
	h.handleWorldContextHostBind(ctx, c, worldcontext.ConsumerModule4)
}

func (h *Handlers) handleWorldContextHostCall(ctx context.Context, c *app.RequestContext, consumer worldcontext.Consumer) {
	if !h.trustedWorldContextHostRequest(c) {
		writeHostTrustError(c)
		return
	}
	body, err := hostRequestBody(c, hostModelMaxBodyBytes)
	if err != nil || exactObjectKeys(body, map[string]struct{}{"frameInstance": {}, "messages": {}, "options": {}}) != nil {
		writeContextPreviewRequestError(c, "宿主模型请求格式无效")
		return
	}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(body, &raw)
	if options := raw["options"]; len(bytes.TrimSpace(options)) > 0 && !bytes.Equal(bytes.TrimSpace(options), []byte("null")) {
		if exactObjectKeys(options, map[string]struct{}{"maxTokens": {}, "temperature": {}}) != nil {
			writeContextPreviewRequestError(c, "宿主模型 options 包含未知字段")
			return
		}
	}
	var wire hostModelCallWire
	if err := decodeStrictJSON(body, &wire); err != nil {
		writeContextPreviewRequestError(c, "宿主模型请求格式无效")
		return
	}
	if validateHostModelCall(wire) != nil {
		writeContextPreviewRequestError(c, "宿主模型请求超出限制")
		return
	}
	req := novaApp.ModelGatewayChatRequest{Messages: wire.Messages, MaxTokens: wire.Options.MaxTokens, Temperature: wire.Options.Temperature}
	result, state, err := h.app.GenerateHostModel(ctx, hostToken(c), consumer, wire.FrameInstance, req)
	if err == nil {
		c.JSON(consts.StatusOK, map[string]any{"content": result.Content, "contextSummary": state})
		return
	}
	var domainErr *worldcontext.DomainError
	if errors.As(err, &domainErr) {
		writeContextPreviewError(c, err)
		return
	}
	var libErr *libraryruntime.Error
	if errors.As(err, &libErr) {
		h.writeLibraryRuntimePreparationError(c, libErr)
		return
	}
	var gatewayErr *novaApp.ModelGatewayError
	if errors.As(err, &gatewayErr) {
		c.JSON(gatewayErr.HTTPStatus(), map[string]any{"error": gatewayErr.Message, "code": gatewayErr.Code, "upstream_status": gatewayErr.UpstreamStatus})
		return
	}
	c.JSON(consts.StatusBadGateway, map[string]string{"code": "upstream_error", "error": "共享模型请求失败。"})
}

func (h *Handlers) HandleWorldContextHostNarraverseCall(ctx context.Context, c *app.RequestContext) {
	h.handleWorldContextHostCall(ctx, c, worldcontext.ConsumerNarraverse)
}

func (h *Handlers) HandleWorldContextHostModule4Call(ctx context.Context, c *app.RequestContext) {
	h.handleWorldContextHostCall(ctx, c, worldcontext.ConsumerModule4)
}

func (h *Handlers) handleWorldContextHostUnbind(ctx context.Context, c *app.RequestContext, consumer worldcontext.Consumer) {
	if !h.trustedWorldContextHostRequest(c) {
		writeHostTrustError(c)
		return
	}
	body, err := hostRequestBody(c, 1024)
	if err != nil || exactObjectKeys(body, map[string]struct{}{"frameInstance": {}}) != nil {
		writeContextPreviewRequestError(c, "iframe 解绑请求格式无效")
		return
	}
	var wire struct {
		FrameInstance string `json:"frameInstance"`
	}
	if decodeStrictJSON(body, &wire) != nil {
		writeContextPreviewRequestError(c, "iframe 解绑请求格式无效")
		return
	}
	if err := h.app.UnbindWorldContextHostFrame(hostToken(c), consumer, wire.FrameInstance); err != nil {
		writeHostTrustError(c)
		return
	}
	c.Status(consts.StatusNoContent)
}

func (h *Handlers) HandleWorldContextHostNarraverseUnbind(ctx context.Context, c *app.RequestContext) {
	h.handleWorldContextHostUnbind(ctx, c, worldcontext.ConsumerNarraverse)
}

func (h *Handlers) HandleWorldContextHostModule4Unbind(ctx context.Context, c *app.RequestContext) {
	h.handleWorldContextHostUnbind(ctx, c, worldcontext.ConsumerModule4)
}

func (h *Handlers) HandleWorldContextHostRevoke(ctx context.Context, c *app.RequestContext) {
	if !h.trustedWorldContextHostRequest(c) || h.app.RevokeWorldContextHost(hostToken(c)) != nil {
		writeHostTrustError(c)
		return
	}
	c.SetCookie(hostSessionCookie, "", -1, "/api/world-context/host", "", protocol.CookieSameSiteStrictMode, false, true)
	c.Status(consts.StatusNoContent)
}
