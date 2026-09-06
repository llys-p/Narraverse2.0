package agent

import (
	"context"
	"strings"

	"github.com/cloudwego/eino-ext/components/model/openai"
	"github.com/cloudwego/eino/schema"

	"denova/config"
	"denova/internal/providercompat"
)

func chatModelConfigForAgent(cfg *config.Config, agentKind string) openai.ChatModelConfig {
	resolved := config.ResolveAgentModel(cfg, agentKind)
	return chatModelConfigFromResolved(resolved)
}

func chatModelConfigFromResolved(resolved config.ResolvedModelSettings) openai.ChatModelConfig {
	modelCfg := openai.ChatModelConfig{
		APIKey:     resolved.OpenAIAPIKey,
		Model:      resolved.OpenAIModel,
		BaseURL:    normalizeChatModelBaseURL(resolved.OpenAIBaseURL),
		HTTPClient: providercompat.WrapHTTPClient(nil),
	}
	if resolved.Temperature != nil {
		temperature := float32(*resolved.Temperature)
		modelCfg.Temperature = &temperature
	}
	extraFields := map[string]any{}
	for k, v := range providercompat.ThinkingExtraFields(modelCfg, resolved.EnableThinking) {
		extraFields[k] = v
	}
	// 让 providercompat 决定是否要注入 provider 特有的请求字段。
	// agent 包不感知任何具体 provider。
	for k, v := range providercompat.ExtraRequestFields(modelCfg) {
		extraFields[k] = v
	}
	if len(extraFields) > 0 {
		modelCfg.ExtraFields = extraFields
	}
	if resolved.ReasoningEffort != "" {
		modelCfg.ReasoningEffort = openai.ReasoningEffortLevel(resolved.ReasoningEffort)
	}
	return modelCfg
}

// GenerateOneShot executes a bounded, tool-free model call through the same
// OpenAI-compatible client and provider compatibility layer used by Denova's
// agents. It is intentionally small: browser modules use it through the API
// gateway, while the agent loop keeps ownership of tools, sessions and traces.
func GenerateOneShot(ctx context.Context, cfg *config.Config, agentKind string, messages []*schema.Message, maxTokens int, temperature *float32) (*schema.Message, error) {
	if cfg == nil {
		return nil, ErrModelConfigUnavailable
	}
	if len(messages) == 0 {
		return nil, ErrModelMessagesRequired
	}
	modelCfg := chatModelConfigForAgent(cfg, agentKind)
	if maxTokens > 0 {
		modelCfg.MaxTokens = &maxTokens
	}
	if temperature != nil {
		modelCfg.Temperature = temperature
	}
	cm, err := openai.NewChatModel(ctx, &modelCfg)
	if err != nil {
		return nil, err
	}
	return providercompat.Wrap(cm, modelCfg).Generate(ctx, messages)
}

// These errors are deliberately stable and contain no provider response body.
// The app layer maps them to the user-facing, redacted gateway result.
var (
	ErrModelConfigUnavailable = &modelGatewaySentinelError{message: "model configuration unavailable"}
	ErrModelMessagesRequired  = &modelGatewaySentinelError{message: "model messages required"}
)

type modelGatewaySentinelError struct{ message string }

func (e *modelGatewaySentinelError) Error() string { return e.message }

// normalizeChatModelBaseURL accepts either a provider base URL or a copied
// full chat-completions URL. The SDK appends /chat/completions itself, so
// leaving that suffix in settings causes the recurring 404/double-path bug.
// It does not invent /v1: providers such as DeepSeek intentionally expose the
// compatible endpoint at the host root.
func normalizeChatModelBaseURL(value string) string {
	base := strings.TrimSpace(value)
	base = strings.TrimRight(base, "/")
	const completionSuffix = "/chat/completions"
	if strings.HasSuffix(strings.ToLower(base), completionSuffix) {
		base = base[:len(base)-len(completionSuffix)]
	}
	return strings.TrimRight(base, "/")
}
