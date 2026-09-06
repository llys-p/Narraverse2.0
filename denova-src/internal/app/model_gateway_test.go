package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"denova/config"
)

func TestNormalizeModelModuleMapsFourProductModules(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{input: "module1", want: ModelModuleWriting},
		{input: "game", want: ModelModuleGame},
		{input: "module3", want: ModelModuleNarraverse},
		{input: "sandbox", want: ModelModuleSandbox},
		{input: "", want: ModelModuleNarraverse},
	}
	for _, tt := range tests {
		module, _, err := normalizeModelModule(tt.input)
		if err != nil || module != tt.want {
			t.Fatalf("normalizeModelModule(%q) = %q, %v; want %q", tt.input, module, err, tt.want)
		}
	}
	if _, _, err := normalizeModelModule("not-a-module"); err == nil {
		t.Fatal("unknown module should be rejected")
	}
}

func TestRedactModelBaseURLRemovesCredentialsQueryAndCompletionPath(t *testing.T) {
	got := redactModelBaseURL("https://user:secret@example.com/v1/chat/completions?token=hidden#fragment")
	if got != "https://example.com/v1" {
		t.Fatalf("redactModelBaseURL() = %q, want redacted base URL", got)
	}
}

func TestModelConfigurationMessageDoesNotExposeCredential(t *testing.T) {
	message := modelConfigurationMessage(ModelGatewayStatus{EndpointConfigured: true, ModelConfigured: true})
	if message == "" || message == "API Key" || message != "共享模型尚未配置：请在 Denova Settings 中填写 API Key。" {
		t.Fatalf("unexpected configuration message: %q", message)
	}
}

func TestGenerateModelUsesNormalizedEndpointAndRedactsUpstreamErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			http.Error(w, "unexpected path", http.StatusNotFound)
			return
		}
		if r.Header.Get("Authorization") != "Bearer test-key" {
			http.Error(w, "missing auth", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{
				"message": map[string]string{"role": "assistant", "content": "收到"},
			}},
		})
	}))
	defer server.Close()

	configured := &App{cfg: &config.Config{
		OpenAIAPIKey:  "test-key",
		OpenAIBaseURL: server.URL + "/chat/completions",
		OpenAIModel:   "test-model",
	}}
	result, err := configured.GenerateModel(context.Background(), ModelGatewayChatRequest{
		Module:   ModelModuleNarraverse,
		Messages: []ModelGatewayMessage{{Role: "user", Content: "测试"}},
	})
	if err != nil {
		t.Fatalf("GenerateModel() error = %v", err)
	}
	if result.Content != "收到" {
		t.Fatalf("GenerateModel() content = %q, want response", result.Content)
	}

	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "provider body must stay private", http.StatusUnauthorized)
	}))
	defer failing.Close()
	unauthorized := &App{cfg: &config.Config{
		OpenAIAPIKey:  "test-key",
		OpenAIBaseURL: failing.URL,
		OpenAIModel:   "test-model",
	}}
	_, err = unauthorized.GenerateModel(context.Background(), ModelGatewayChatRequest{
		Module:   ModelModuleSandbox,
		Messages: []ModelGatewayMessage{{Role: "user", Content: "测试"}},
	})
	var gatewayErr *ModelGatewayError
	if !errors.As(err, &gatewayErr) || gatewayErr.Code != "unauthorized" || gatewayErr.UpstreamStatus != http.StatusUnauthorized {
		t.Fatalf("GenerateModel() error = %#v, want redacted unauthorized error", err)
	}
	if strings.Contains(err.Error(), "test-key") || strings.Contains(err.Error(), "provider body") {
		t.Fatalf("upstream details leaked from error: %q", err.Error())
	}
}
