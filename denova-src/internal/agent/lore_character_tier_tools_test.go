package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/cloudwego/eino/components/tool"

	"denova/internal/book"
	"denova/internal/workspacepath"
)

// All mutations use a disposable on-disk book and the real registered tools.
func loreCharacterTierToolsFixture(t *testing.T) (string, map[string]tool.InvokableTool) {
	t.Helper()
	workspace := t.TempDir()
	store := book.NewLoreStore(workspace)
	minor, pinned, pinOrder := "minor", true, 3
	for _, input := range []book.LoreItemInput{
		{ID: "tier-minor", Type: "character", Name: "测试次要人物", CharacterTier: &minor, Importance: "major", LoadMode: book.LoreLoadModeResident, Content: "保留次要人物正文。"},
		{ID: "tier-legacy", Type: "character", Name: "测试旧人物", Importance: "major", LoadMode: book.LoreLoadModeManual, Content: "保留旧人物正文。", Pinned: &pinned, PinOrder: &pinOrder, Tags: []string{"原标签"}, Keywords: []string{"原别名"}},
	} {
		if _, err := store.Create(input); err != nil {
			t.Fatal(err)
		}
	}
	legacy, err := store.ReadAny("tier-legacy")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteRelations([]book.LoreRelationUpdate{{
		ID: legacy.ID, BaseRevision: legacy.UpdatedAt,
		Relations: []book.LoreRelation{{TargetID: "tier-minor", Label: "好友", Note: "保留关系备注"}},
	}}); err != nil {
		t.Fatal(err)
	}
	registered, err := newLoreTools(workspace, true)
	if err != nil {
		t.Fatal(err)
	}
	byName := make(map[string]tool.InvokableTool)
	for _, candidate := range registered {
		info, err := candidate.Info(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		invokable, ok := candidate.(tool.InvokableTool)
		if !ok {
			t.Fatalf("%s is not invokable: %T", info.Name, candidate)
		}
		byName[info.Name] = invokable
	}
	for _, name := range []string{"write_lore_items", "read_lore_items", "list_lore_items"} {
		if byName[name] == nil {
			t.Fatalf("missing tool %s", name)
		}
	}
	return workspace, byName
}

func TestLoreCharacterTierToolsTierOnlyUpdatePersistsAndPreservesExistingFields(t *testing.T) {
	workspace, tools := loreCharacterTierToolsFixture(t)
	before, err := book.NewLoreStore(workspace).ReadAny("tier-legacy")
	if err != nil {
		t.Fatal(err)
	}
	output, err := tools["write_lore_items"].InvokableRun(context.Background(),
		`{"message":"只更新人物层级","items":[{"id":"tier-legacy","character_tier":"minor"}]}`)
	if err != nil {
		t.Fatalf("tier-only update failed: %v", err)
	}
	if !strings.Contains(output, "tier-legacy") {
		t.Errorf("write receipt omitted changed ID: %s", output)
	}
	// Inspect the persisted JSON, then load through a new store instance.
	data, err := os.ReadFile(workspacepath.Path(workspace, "lore", "items.json"))
	if err != nil {
		t.Fatal(err)
	}
	var disk struct {
		Items []book.LoreItem `json:"items"`
	}
	if err := json.Unmarshal(data, &disk); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range disk.Items {
		if item.ID == before.ID {
			found = true
			if item.CharacterTier != "minor" {
				t.Errorf("disk character_tier = %q, want minor", item.CharacterTier)
			}
		}
	}
	if !found {
		t.Fatal("updated item missing from persisted JSON")
	}
	after, err := book.NewLoreStore(workspace).ReadAny(before.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := before
	want.CharacterTier = "minor"
	want.UpdatedAt = after.UpdatedAt
	if !reflect.DeepEqual(after, want) {
		t.Errorf("tier-only update changed unrelated fields or lost tier:\ngot:  %#v\nwant: %#v", after, want)
	}
}

func TestLoreCharacterTierToolsReadAndListExposeExplicitTierWithoutImportanceInference(t *testing.T) {
	_, tools := loreCharacterTierToolsFixture(t)
	for _, tc := range []struct {
		name, toolName, args, separator string
	}{
		{"read", "read_lore_items", `{"ids":["tier-minor","tier-legacy"]}`, "## "},
		{"unfiltered catalog", "list_lore_items", `{}`, "- ["},
		{"filtered index", "list_lore_items", `{"types":["character"],"detail":"index","limit":50}`, "- id:"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			output, err := tools[tc.toolName].InvokableRun(context.Background(), tc.args)
			if err != nil {
				t.Fatal(err)
			}
			for _, character := range []struct{ name, tier string }{
				{"测试次要人物", "minor"},
				{"测试旧人物", "unclassified"},
			} {
				found := false
				for _, entry := range strings.Split(output, tc.separator)[1:] {
					if !strings.Contains(entry, character.name) {
						continue
					}
					found = true
					if !strings.Contains(entry, "character_tier: "+character.tier) {
						t.Errorf("%s entry must explicitly expose character_tier: %s (importance is major for both fixtures):\n%s", character.name, character.tier, entry)
					}
				}
				if !found {
					t.Errorf("missing %s entry:\n%s", character.name, output)
				}
			}
		})
	}
}

func TestLoreCharacterTierToolsInvalidTierRejectsWholeBatchWithoutDiskWrites(t *testing.T) {
	for _, invalid := range []string{"important", "unknown", "MAJOR", ""} {
		t.Run("tier="+invalid, func(t *testing.T) {
			workspace, tools := loreCharacterTierToolsFixture(t)
			path := workspacepath.Path(workspace, "lore", "items.json")
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			args, err := json.Marshal(map[string]any{
				"message": "无效批次不能保存前一项",
				"items": []map[string]any{
					{"id": "tier-legacy", "character_tier": "minor", "content": "不应保存的正文"},
					{"id": "tier-minor", "character_tier": invalid},
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			if output, err := tools["write_lore_items"].InvokableRun(context.Background(), string(args)); err == nil {
				t.Errorf("invalid tier %q accepted: %s", invalid, output)
			}
			after, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(after, before) {
				t.Errorf("invalid tier %q changed persisted store; batch must be atomic", invalid)
			}
		})
	}
}

func TestLoreCharacterTierToolsWriteSchemaExposesCharacterTierEnum(t *testing.T) {
	_, tools := loreCharacterTierToolsFixture(t)
	info, err := tools["write_lore_items"].Info(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	parameters, err := info.ParamsOneOf.ToJSONSchema()
	if err != nil {
		t.Fatal(err)
	}
	items, ok := parameters.Properties.Get("items")
	if !ok || items.Items == nil || items.Items.Properties == nil {
		t.Fatal("write_lore_items schema missing structured items array")
	}
	for _, field := range items.Items.Required {
		if field != "id" {
			t.Errorf("tier-only updates must not require unrelated field %q", field)
		}
	}
	tier, ok := items.Items.Properties.Get("character_tier")
	if !ok {
		t.Fatal("write_lore_items item schema missing character_tier")
	}
	want := map[string]bool{"major": true, "minor": true, "unclassified": true}
	got := make(map[string]bool)
	for _, value := range tier.Enum {
		text, ok := value.(string)
		if !ok {
			t.Fatalf("non-string character_tier enum value: %#v", value)
		}
		got[text] = true
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("character_tier enum = %#v, want %#v", got, want)
	}
}
