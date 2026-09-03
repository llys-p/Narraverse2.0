package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/cloudwego/eino/components/tool"

	"denova/internal/book"
)

func TestConfigManagerMasterToolsReadOriginalAndCreateValidatedProposal(t *testing.T) {
	adventureWorkspace := t.TempDir()
	store := book.NewMasterLibraryStore(adventureWorkspace)
	raw := []byte(`{"name":"Aiko","description":"Original card text"}`)
	ingested, err := store.Ingest(book.MasterIngestInput{
		Filename:           "aiko.json",
		Data:               raw,
		AdventureWorkspace: adventureWorkspace,
		Items: []book.MasterItemInput{{
			SourceEntryIdentity: "character-card",
			RecordKind:          "character_template",
			SemanticType:        "character",
			Name:                "Aiko",
			Original:            map[string]any{"name": "Aiko"},
			Fields:              map[string]book.MasterFieldInput{"character.name": {Text: "Aiko", Required: true}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	masterItemID := ingested.Items[0].MasterItemID
	tools, err := newConfigManagerMasterTools(adventureWorkspace, true, true)
	if err != nil {
		t.Fatal(err)
	}

	sourceOutput := invokeConfigManagerTool(t, tools, "read_master_source", `{"master_item_id":"`+masterItemID+`"}`)
	if !strings.Contains(sourceOutput, "Original card text") || !strings.Contains(sourceOutput, "aiko.json") {
		t.Fatalf("source output should contain immutable original: %s", sourceOutput)
	}
	proposalOutput := invokeConfigManagerTool(t, tools, "create_master_proposal", `{"master_item_id":"`+masterItemID+`","field_path":"character.name","translation":"艾可","reason":"翻译角色名称"}`)
	if !strings.Contains(proposalOutput, `"status":"proposed"`) || !strings.Contains(proposalOutput, `"apply_mode":"confirm"`) {
		t.Fatalf("proposal should require confirmation: %s", proposalOutput)
	}
	proposalID := stringBetween(proposalOutput, `"proposal_id":"`, `"`)
	if proposalID == "" {
		t.Fatalf("proposal id missing: %s", proposalOutput)
	}
	validated := invokeConfigManagerTool(t, tools, "validate_master_patch", `{"proposal_id":"`+proposalID+`"}`)
	if !strings.Contains(validated, `"status":"validated"`) {
		t.Fatalf("proposal should validate without applying: %s", validated)
	}
}

func invokeConfigManagerTool(t *testing.T, tools []tool.BaseTool, name, input string) string {
	t.Helper()
	for _, candidate := range tools {
		info, err := candidate.Info(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if info.Name != name {
			continue
		}
		invokable, ok := candidate.(tool.InvokableTool)
		if !ok {
			t.Fatalf("%s is not invokable", name)
		}
		output, err := invokable.InvokableRun(context.Background(), input)
		if err != nil {
			t.Fatal(err)
		}
		return output
	}
	t.Fatalf("tool %s not found", name)
	return ""
}

func stringBetween(value, prefix, suffix string) string {
	start := strings.Index(value, prefix)
	if start < 0 {
		return ""
	}
	start += len(prefix)
	end := strings.Index(value[start:], suffix)
	if end < 0 {
		return ""
	}
	return value[start : start+end]
}
