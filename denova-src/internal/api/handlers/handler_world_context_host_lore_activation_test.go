package handlers

import (
	"strings"
	"testing"

	novaApp "denova/internal/app"
)

func TestHostLoreActivationValidation(t *testing.T) {
	valid := hostModelCallWire{Messages: []novaApp.ModelGatewayMessage{{Role: "user", Content: "hi"}}, LoreActivation: &novaApp.BookLoreActivation{ScanDepth: 60, ContextText: strings.Repeat("界", 512)}}
	if err := validateHostModelCall(valid); err != nil {
		t.Fatalf("valid maximum rejected: %v", err)
	}
	for _, activation := range []*novaApp.BookLoreActivation{
		{ScanDepth: 0}, {ScanDepth: 61}, {ScanDepth: 1, ContextText: strings.Repeat("界", 513)},
	} {
		bad := valid
		bad.LoreActivation = activation
		if validateHostModelCall(bad) == nil {
			t.Fatalf("invalid activation accepted: %+v", activation)
		}
	}
	for _, raw := range []string{
		`null`, `[]`, `"bad"`, `{}`, `{"scan_depth":14}`, `{"context_text":"x"}`,
		`{"scan_depth":null,"context_text":"x"}`, `{"scan_depth":14,"context_text":null}`,
		`{"scan_depth":"14","context_text":"x"}`, `{"scan_depth":14,"context_text":12}`,
		`{"scan_depth":14,"context_text":"x","unknown":true}`,
	} {
		if validateHostLoreActivationRaw([]byte(raw)) == nil {
			t.Fatalf("invalid activation object accepted: %s", raw)
		}
	}
	if validateHostLoreActivationRaw([]byte(`{"scan_depth":14,"context_text":"当前人物"}`)) != nil {
		t.Fatal("valid activation rejected")
	}
}
