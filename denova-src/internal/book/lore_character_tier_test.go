package book

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

func tierInput(t *testing.T, raw string) LoreItemInput {
	t.Helper()
	var input LoreItemInput
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		t.Fatal(err)
	}
	return input
}

func assertCharacterTier(t *testing.T, item LoreItem, want string) {
	t.Helper()
	raw, err := json.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	actual, _ := fields["character_tier"].(string)
	if actual != want {
		t.Fatalf("character_tier=%q, want %q", actual, want)
	}
}

func TestLoreCharacterTierPersistsWithoutChangingLoadingOrRelations(t *testing.T) {
	s, a, b := relationFixture(t)
	links := []LoreRelation{{TargetID: b.ID, Label: "好友"}}
	if _, err := s.WriteRelations([]LoreRelationUpdate{{ID: a.ID, BaseRevision: a.UpdatedAt, Relations: links}}); err != nil {
		t.Fatal(err)
	}
	input := tierInput(t, `{"name":"林冲","type":"character","importance":"minor","load_mode":"resident","content":"原有正文","character_tier":"major"}`)
	edited, err := s.Update(a.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	assertCharacterTier(t, edited, "major")
	if edited.Importance != "minor" || edited.LoadMode != "resident" || edited.Content != a.Content || len(edited.Relations) != 1 {
		t.Fatalf("display tier changed lore semantics: %#v", edited)
	}
	input = tierInput(t, `{"name":"豹子头林冲","type":"character","importance":"minor","load_mode":"resident","content":"原有正文"}`)
	edited, err = s.Update(a.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	assertCharacterTier(t, edited, "major")
	if _, err := s.ApplyOperations("修改正文", []LoreOperation{{Op: "update", ID: a.ID, Item: LoreItemInput{Content: "更新正文"}}}); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewLoreStore(s.workspace).ReadAny(a.ID)
	if err != nil {
		t.Fatal(err)
	}
	assertCharacterTier(t, reloaded, "major")
	if len(reloaded.Relations) != 1 {
		t.Fatal("batch edit dropped relation")
	}
	cleared, err := s.Update(a.ID, tierInput(t, `{"name":"豹子头林冲","type":"character","character_tier":"unclassified"}`))
	if err != nil {
		t.Fatal(err)
	}
	assertCharacterTier(t, cleared, "unclassified")
}

func TestLoreCharacterTierCreateBatchAndLegacyDefaults(t *testing.T) {
	s := NewLoreStore(t.TempDir())
	old, err := s.Create(LoreItemInput{ID: "old", Name: "旧人物", Type: "character", Importance: "major"})
	if err != nil {
		t.Fatal(err)
	}
	assertCharacterTier(t, old, "") // Do not infer a display tier from importance.
	created, err := s.Create(tierInput(t, `{"id":"minor","name":"次要人物","type":"character","character_tier":"minor"}`))
	if err != nil {
		t.Fatal(err)
	}
	assertCharacterTier(t, created, "minor")
	result, err := s.ApplyOperations("新增", []LoreOperation{{Op: "create", Item: tierInput(t, `{"id":"major","name":"主要人物","type":"character","character_tier":"major"}`)}})
	if err != nil {
		t.Fatal(err)
	}
	assertCharacterTier(t, result.Created[0], "major")
}

func TestLoreCharacterTierDoesNotChangeModelContextAndHonorsCAS(t *testing.T) {
	s := NewLoreStore(t.TempDir())
	item, err := s.Create(tierInput(t, `{"id":"core","name":"核心","type":"character","importance":"major","load_mode":"resident","content":"常驻正文"}`))
	if err != nil {
		t.Fatal(err)
	}
	before, err := s.ProgressiveContextMarkdown()
	if err != nil {
		t.Fatal(err)
	}
	input := tierInput(t, `{"id":"core","name":"核心","type":"character","importance":"major","load_mode":"resident","content":"常驻正文","character_tier":"minor"}`)
	input.BaseRevision = item.UpdatedAt
	if _, err := s.Update(item.ID, input); err != nil {
		t.Fatal(err)
	}
	after, err := s.ProgressiveContextMarkdown()
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("display-only tier changed model context")
	}
	if _, err := s.Update(item.ID, input); err == nil {
		t.Fatal("accepted stale CAS revision")
	}
	invalid := tierInput(t, `{"id":"invalid","name":"非法","type":"character","character_tier":"hero"}`)
	if _, err := s.Create(invalid); err == nil {
		t.Fatal("Create accepted invalid tier")
	}
	if _, err := s.ApplyOperations("非法创建", []LoreOperation{{Op: "create", Item: invalid}}); err == nil {
		t.Fatal("batch create accepted invalid tier")
	}
	invalid.ID = item.ID
	if _, err := s.ApplyOperations("非法更新", []LoreOperation{{Op: "update", ID: item.ID, Item: invalid}}); err == nil {
		t.Fatal("batch update accepted invalid tier")
	}
	if _, err := s.ApplyOperations("改为主要", []LoreOperation{{Op: "update", ID: item.ID, Item: tierInput(t, `{"character_tier":"major"}`)}}); err != nil {
		t.Fatal(err)
	}
	final, err := s.ReadAny(item.ID)
	if err != nil {
		t.Fatal(err)
	}
	assertCharacterTier(t, final, "major")
	if final.LoadMode != item.LoadMode || final.Content != item.Content {
		t.Fatal("batch tier update changed loading or content")
	}
}

func TestLoreCharacterTierRejectsInvalidInputsWithoutWriting(t *testing.T) {
	s, a, _ := relationFixture(t)
	before, _ := os.ReadFile(s.itemsPath())
	for _, raw := range []string{
		`{"name":"林冲","type":"character","character_tier":"hero"}`,
		`{"name":"林冲","type":"character","character_tier":""}`,
		`{"name":"林冲","type":"location","character_tier":"major"}`,
	} {
		if _, err := s.Update(a.ID, tierInput(t, raw)); err == nil {
			t.Fatalf("accepted invalid classification %s", raw)
		}
		after, _ := os.ReadFile(s.itemsPath())
		if !bytes.Equal(before, after) {
			t.Fatal("rejected input changed disk")
		}
	}
}
