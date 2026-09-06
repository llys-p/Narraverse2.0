package app

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	einoopenai "github.com/cloudwego/eino-ext/components/model/openai"
	"github.com/cloudwego/eino/schema"

	"denova/config"
	"denova/internal/agent"
)

const (
	ModelModuleWriting    = "writing"
	ModelModuleGame       = "game"
	ModelModuleNarraverse = "narraverse"
	ModelModuleSandbox    = "module4"

	modelGatewayDefaultMaxTokens = 4096
	modelGatewayMaxTokens        = 16384
	modelGatewayMaxMessages      = 256
	modelGatewayMaxMessageRunes  = 262144
	modelGatewayMaxTotalRunes    = 2097152
)

// ModelGatewayMessage is the transport-neutral message accepted by all four
// product modules. It intentionally contains only role/content; tools and
// agent state remain owned by Denova's native agent APIs.
type ModelGatewayMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ModelGatewayChatRequest is the one-shot request used by the legacy
// Narraverse iframe and any future module client.
type ModelGatewayChatRequest struct {
	Module      string                `json:"module"`
	Messages    []ModelGatewayMessage `json:"messages"`
	MaxTokens   int                   `json:"max_tokens,omitempty"`
	Temperature *float32              `json:"temperature,omitempty"`
}

type ModelGatewayChatResult struct {
	Module    string `json:"module"`
	AgentKind string `json:"agent_kind"`
	ProfileID string `json:"profile_id"`
	Model     string `json:"model"`
	Content   string `json:"content"`
}

// ModelGatewayStatus never contains a credential or provider response body.
type ModelGatewayStatus struct {
	Module               string `json:"module"`
	AgentKind            string `json:"agent_kind"`
	ProfileID            string `json:"profile_id"`
	Model                string `json:"model"`
	BaseURL              string `json:"base_url"`
	Configured           bool   `json:"configured"`
	CredentialConfigured bool   `json:"credential_configured"`
	EndpointConfigured   bool   `json:"endpoint_configured"`
	ModelConfigured      bool   `json:"model_configured"`
}

// ModelGatewayTestResult is returned with HTTP 200 even when the upstream
// test fails, so each module can render a stable, actionable status card.
type ModelGatewayTestResult struct {
	OK             bool   `json:"ok"`
	Module         string `json:"module"`
	AgentKind      string `json:"agent_kind"`
	ProfileID      string `json:"profile_id"`
	Model          string `json:"model"`
	BaseURL        string `json:"base_url"`
	UpstreamStatus int    `json:"upstream_status,omitempty"`
	Code           string `json:"code,omitempty"`
	Message        string `json:"message"`
	LatencyMs      int64  `json:"latency_ms"`
}

// ModelGatewayError is safe to send to a browser: Error never includes the
// provider's raw body, URL query, Authorization header or prompt content.
type ModelGatewayError struct {
	Code           string
	UpstreamStatus int
	Message        string
}

func (e *ModelGatewayError) Error() string {
	if e == nil || e.Message == "" {
		return "共享模型请求失败"
	}
	return e.Message
}

func (e *ModelGatewayError) HTTPStatus() int {
	if e == nil {
		return 502
	}
	if e.Code == "invalid_request" {
		return 400
	}
	return 502
}

var modelGatewayHTTPStatusPattern = regexp.MustCompile(`(?i)status code:\s*(\d{3})`)

// ModelGatewayStatus returns the effective profile for one module. A refresh
// always rereads the current in-memory Denova configuration snapshot.
func (a *App) ModelGatewayStatus(module string) (ModelGatewayStatus, error) {
	normalizedModule, agentKind, err := normalizeModelModule(module)
	if err != nil {
		return ModelGatewayStatus{}, err
	}
	cfg, err := a.modelConfigSnapshot()
	if err != nil {
		return ModelGatewayStatus{}, err
	}
	resolved := config.ResolveAgentModel(cfg, agentKind)
	baseURL := redactModelBaseURL(resolved.OpenAIBaseURL)
	credentialConfigured := strings.TrimSpace(resolved.OpenAIAPIKey) != ""
	endpointConfigured := strings.TrimSpace(resolved.OpenAIBaseURL) != ""
	modelConfigured := strings.TrimSpace(resolved.OpenAIModel) != ""
	return ModelGatewayStatus{
		Module:               normalizedModule,
		AgentKind:            agentKind,
		ProfileID:            resolved.ProfileID,
		Model:                strings.TrimSpace(resolved.OpenAIModel),
		BaseURL:              baseURL,
		Configured:           credentialConfigured && endpointConfigured && modelConfigured,
		CredentialConfigured: credentialConfigured,
		EndpointConfigured:   endpointConfigured,
		ModelConfigured:      modelConfigured,
	}, nil
}

// TestModel makes the smallest possible real model call and returns a stable
// result envelope. It is deliberately not a fallback success: no model call
// means OK=false with a concrete configuration error.
func (a *App) TestModel(ctx context.Context, module string) ModelGatewayTestResult {
	started := time.Now()
	status, err := a.ModelGatewayStatus(module)
	if err != nil {
		return ModelGatewayTestResult{OK: false, Code: "invalid_request", Message: err.Error(), LatencyMs: elapsedMillis(started)}
	}
	result := ModelGatewayTestResult{
		Module:    status.Module,
		AgentKind: status.AgentKind,
		ProfileID: status.ProfileID,
		Model:     status.Model,
		BaseURL:   status.BaseURL,
	}
	if !status.Configured {
		result.Code = "not_configured"
		result.Message = modelConfigurationMessage(status)
		result.LatencyMs = elapsedMillis(started)
		return result
	}

	chatResult, callErr := a.GenerateModel(ctx, ModelGatewayChatRequest{
		Module: status.Module,
		Messages: []ModelGatewayMessage{
			{Role: "system", Content: "你正在进行连接测试。只回复 OK，不要添加其它内容。"},
			{Role: "user", Content: "连接测试"},
		},
		MaxTokens: 256,
	})
	result.LatencyMs = elapsedMillis(started)
	if callErr != nil {
		var gatewayErr *ModelGatewayError
		if errors.As(callErr, &gatewayErr) {
			result.Code = gatewayErr.Code
			result.UpstreamStatus = gatewayErr.UpstreamStatus
			result.Message = gatewayErr.Message
		} else {
			result.Code = "upstream_error"
			result.Message = "共享模型请求失败，请检查网络或 Denova Settings。"
		}
		return result
	}
	if strings.TrimSpace(chatResult.Content) == "" {
		result.Code = "empty_response"
		result.Message = "模型服务已连接，但没有返回可用内容。"
		return result
	}
	result.OK = true
	result.Message = "共享模型连接正常。"
	return result
}

// GenerateModel executes a non-streaming one-shot call using the effective
// model profile selected by the requested module. The browser never sends a
// credential; the server resolves it from existing Denova Settings.
func (a *App) GenerateModel(ctx context.Context, req ModelGatewayChatRequest) (ModelGatewayChatResult, error) {
	normalizedModule, agentKind, err := normalizeModelModule(req.Module)
	if err != nil {
		return ModelGatewayChatResult{}, &ModelGatewayError{Code: "invalid_request", Message: err.Error()}
	}
	if err := validateModelMessages(req.Messages); err != nil {
		return ModelGatewayChatResult{}, &ModelGatewayError{Code: "invalid_request", Message: err.Error()}
	}
	cfg, err := a.modelConfigSnapshot()
	if err != nil {
		return ModelGatewayChatResult{}, &ModelGatewayError{Code: "not_configured", Message: "无法读取 Denova 共享模型配置。"}
	}
	resolved := config.ResolveAgentModel(cfg, agentKind)
	status := ModelGatewayStatus{
		Module:     normalizedModule,
		AgentKind:  agentKind,
		ProfileID:  resolved.ProfileID,
		Model:      strings.TrimSpace(resolved.OpenAIModel),
		BaseURL:    redactModelBaseURL(resolved.OpenAIBaseURL),
		Configured: strings.TrimSpace(resolved.OpenAIAPIKey) != "" && strings.TrimSpace(resolved.OpenAIBaseURL) != "" && strings.TrimSpace(resolved.OpenAIModel) != "",
	}
	if !status.Configured {
		return ModelGatewayChatResult{}, &ModelGatewayError{Code: "not_configured", Message: modelConfigurationMessage(status)}
	}

	modelMessages := make([]*schema.Message, 0, len(req.Messages))
	for _, message := range req.Messages {
		modelMessages = append(modelMessages, &schema.Message{Role: schema.RoleType(message.Role), Content: message.Content})
	}
	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = modelGatewayDefaultMaxTokens
	}
	if maxTokens > modelGatewayMaxTokens {
		maxTokens = modelGatewayMaxTokens
	}
	if req.Temperature != nil && (*req.Temperature < 0 || *req.Temperature > 2) {
		return ModelGatewayChatResult{}, &ModelGatewayError{Code: "invalid_request", Message: "模型温度必须在 0 到 2 之间。"}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	message, callErr := agent.GenerateOneShot(ctx, cfg, agentKind, modelMessages, maxTokens, req.Temperature)
	if callErr != nil {
		return ModelGatewayChatResult{}, classifyModelGatewayError(callErr, ctx)
	}
	if message == nil || strings.TrimSpace(message.Content) == "" {
		return ModelGatewayChatResult{}, &ModelGatewayError{Code: "empty_response", Message: "模型服务没有返回可用内容。"}
	}
	return ModelGatewayChatResult{
		Module:    normalizedModule,
		AgentKind: agentKind,
		ProfileID: resolved.ProfileID,
		Model:     strings.TrimSpace(resolved.OpenAIModel),
		Content:   message.Content,
	}, nil
}

func (a *App) modelConfigSnapshot() (*config.Config, error) {
	if a == nil {
		return nil, errors.New("应用运行时不存在")
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.cfg == nil {
		return nil, errors.New("共享模型配置不存在")
	}
	snapshot := *a.cfg
	return &snapshot, nil
}

func normalizeModelModule(module string) (string, string, error) {
	switch strings.ToLower(strings.TrimSpace(module)) {
	case "", ModelModuleNarraverse, "module3":
		return ModelModuleNarraverse, config.AgentKindInteractiveStory, nil
	case ModelModuleWriting, "module1", "ide":
		return ModelModuleWriting, config.AgentKindIDE, nil
	case ModelModuleGame, "module2", "interactive":
		return ModelModuleGame, config.AgentKindInteractiveStory, nil
	case ModelModuleSandbox, "sandbox", "open-sandbox":
		return ModelModuleSandbox, config.AgentKindInteractiveStory, nil
	default:
		return "", "", fmt.Errorf("未知模块：%s", strings.TrimSpace(module))
	}
}

func validateModelMessages(messages []ModelGatewayMessage) error {
	if len(messages) == 0 {
		return errors.New("模型消息不能为空")
	}
	if len(messages) > modelGatewayMaxMessages {
		return fmt.Errorf("模型消息过多（最多 %d 条）", modelGatewayMaxMessages)
	}
	total := 0
	for _, message := range messages {
		role := strings.ToLower(strings.TrimSpace(message.Role))
		switch role {
		case "system", "user", "assistant", "developer", "tool":
		default:
			return errors.New("模型消息角色无效")
		}
		if strings.TrimSpace(message.Content) == "" {
			return errors.New("模型消息内容不能为空")
		}
		runes := len([]rune(message.Content))
		if runes > modelGatewayMaxMessageRunes {
			return errors.New("单条模型消息过长")
		}
		total += runes
		if total > modelGatewayMaxTotalRunes {
			return errors.New("模型消息总量过大")
		}
	}
	return nil
}

func modelConfigurationMessage(status ModelGatewayStatus) string {
	missing := make([]string, 0, 3)
	if !status.EndpointConfigured {
		missing = append(missing, "Base URL")
	}
	if !status.ModelConfigured {
		missing = append(missing, "模型")
	}
	if !status.CredentialConfigured {
		missing = append(missing, "API Key")
	}
	if len(missing) == 0 {
		return "共享模型尚未配置。"
	}
	return "共享模型尚未配置：请在 Denova Settings 中填写 " + strings.Join(missing, "、") + "。"
}

func classifyModelGatewayError(err error, ctx context.Context) error {
	if err == nil {
		return nil
	}
	status := 0
	var apiErr *einoopenai.APIError
	if errors.As(err, &apiErr) {
		status = apiErr.HTTPStatusCode
	}
	if status == 0 {
		matches := modelGatewayHTTPStatusPattern.FindStringSubmatch(err.Error())
		if len(matches) == 2 {
			_, _ = fmt.Sscanf(matches[1], "%d", &status)
		}
	}
	if ctx != nil && errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return &ModelGatewayError{Code: "timeout", UpstreamStatus: status, Message: "共享模型请求超时，请检查网络后重试。"}
	}
	switch status {
	case 401, 403:
		return &ModelGatewayError{Code: "unauthorized", UpstreamStatus: status, Message: "共享模型鉴权失败，请检查 Denova Settings 中的 API Key。"}
	case 404:
		return &ModelGatewayError{Code: "not_found", UpstreamStatus: status, Message: "共享模型地址不存在，请检查 Base URL；不要填写完整的 /chat/completions 路径。"}
	case 408, 429:
		return &ModelGatewayError{Code: "rate_limited", UpstreamStatus: status, Message: "共享模型暂时繁忙或达到限流，请稍后重试。"}
	case 500, 502, 503, 504:
		return &ModelGatewayError{Code: "provider_unavailable", UpstreamStatus: status, Message: "共享模型服务暂时不可用，请检查供应商状态或网络。"}
	default:
		return &ModelGatewayError{Code: "upstream_error", UpstreamStatus: status, Message: "共享模型请求失败，请检查网络或 Denova Settings。"}
	}
}

func redactModelBaseURL(value string) string {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "配置中的 Base URL 无法解析"
	}
	parsed.User = nil
	parsed.RawQuery = ""
	parsed.Fragment = ""
	path := strings.TrimRight(parsed.Path, "/")
	if strings.HasSuffix(strings.ToLower(path), "/chat/completions") {
		path = path[:len(path)-len("/chat/completions")]
	}
	parsed.Path = path
	parsed.RawPath = ""
	return strings.TrimRight(parsed.String(), "/")
}

func elapsedMillis(start time.Time) int64 {
	return time.Since(start).Milliseconds()
}
