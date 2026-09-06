package agent

import (
	"testing"

	"github.com/cloudwego/eino-ext/components/model/openai"

	"denova/config"
)

func TestNormalizeChatModelBaseURLRemovesOnlyCompletionSuffix(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "provider root", in: "https://api.deepseek.com", want: "https://api.deepseek.com"},
		{name: "v1 root", in: "https://api.example.com/v1/", want: "https://api.example.com/v1"},
		{name: "full path", in: "https://api.example.com/v1/chat/completions", want: "https://api.example.com/v1"},
		{name: "full path case insensitive", in: "https://api.example.com/chat/Completions/", want: "https://api.example.com"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeChatModelBaseURL(tt.in); got != tt.want {
				t.Fatalf("normalizeChatModelBaseURL(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestChatModelConfigFromResolvedSkipsEnableThinkingForGemini(t *testing.T) {
	enabled := true
	modelCfg := chatModelConfigFromResolved(config.ResolvedModelSettings{
		OpenAIBaseURL:   "https://generativelanguage.googleapis.com/v1beta/openai/",
		OpenAIModel:     "gemini-3.5-flash",
		EnableThinking:  &enabled,
		ReasoningEffort: "low",
	})
	if _, ok := modelCfg.ExtraFields["enable_thinking"]; ok {
		t.Fatalf("Gemini request must not include enable_thinking: %#v", modelCfg.ExtraFields)
	}
	if modelCfg.ReasoningEffort != openai.ReasoningEffortLevelLow {
		t.Fatalf("reasoning effort = %q, want low", modelCfg.ReasoningEffort)
	}
}

func TestChatModelConfigFromResolvedKeepsEnableThinkingForSupportedProvider(t *testing.T) {
	enabled := true
	modelCfg := chatModelConfigFromResolved(config.ResolvedModelSettings{
		OpenAIBaseURL:  "https://api.deepseek.com/v1",
		OpenAIModel:    "deepseek-v4-pro",
		EnableThinking: &enabled,
	})
	if got := modelCfg.ExtraFields["enable_thinking"]; got != true {
		t.Fatalf("enable_thinking = %v, want true in %#v", got, modelCfg.ExtraFields)
	}
}
