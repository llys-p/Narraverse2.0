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
	FrameInstance string          `json:"frameInstance"`
	WorldContext  json.RawMessage `json:"world_context"`
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
	if err != nil || exactObjectKeys(body, map[string]struct{}{"frameInstance": {}, "world_context": {}}) != nil {
		writeContextPreviewRequestError(c, "iframe 绑定请求格式无效")
		return
	}
	var wire hostBindWire
	if err := decodeStrictJSON(body, &wire); err != nil {
		writeContextPreviewRequestError(c, "iframe 绑定请求格式无效")
		return
	}
	var ref *worldcontext.Ref
	if len(bytes.TrimSpace(wire.WorldContext)) > 0 {
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
