package handlers

import (
	"strings"
	"testing"

	novaApp "denova/internal/app"
	"denova/internal/worldcontext"
)

func TestHostBookSelectionLimitsAndConflictStatus(t *testing.T) {
	valid := hostModelCallWire{Messages: []novaApp.ModelGatewayMessage{{Role: "user", Content: "continue"}}, SelectedLoreIDs: []string{"tower"}}
	if err := validateHostModelCall(valid); err != nil {
		t.Fatal(err)
	}
	for _, ids := range [][]string{make([]string, 51), {""}, {" "}, {strings.Repeat("x", 129)}} {
		bad := valid
		bad.SelectedLoreIDs = ids
		if validateHostModelCall(bad) == nil {
			t.Fatalf("invalid IDs accepted: %#v", ids)
		}
	}
	if contextPreviewErrorStatus(worldcontext.ErrBookChanged) != 409 || contextPreviewErrorStatus(worldcontext.ErrBookStale) != 409 {
		t.Fatal("book conflicts must remain 409")
	}
}
