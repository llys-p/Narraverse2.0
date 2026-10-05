package book

import (
	"bytes"
	"errors"
	"os"
	"reflect"
	"testing"
)

func relationFixture(t *testing.T) (*LoreStore, LoreItem, LoreItem) {
	t.Helper()
	s := NewLoreStore(t.TempDir())
	a, err := s.Create(LoreItemInput{ID: "a", Name: "林冲", Type: "character", Content: "原有正文"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.Create(LoreItemInput{ID: "b", Name: "鲁智深", Type: "character", Content: "朋友"})
	if err != nil {
		t.Fatal(err)
	}
	return s, a, b
}

func TestLoreRelationsPersistAndSurviveOrdinaryEdits(t *testing.T) {
	s, a, b := relationFixture(t)
	rels := []LoreRelation{{TargetID: b.ID, Label: "好友", Note: "曾互相帮助"}}
	updated, err := s.WriteRelations([]LoreRelationUpdate{{ID: a.ID, BaseRevision: a.UpdatedAt, Relations: rels}})
	if err != nil {
		t.Fatal(err)
	}
	if len(updated) != 1 || !reflect.DeepEqual(updated[0].Relations, rels) || updated[0].Content != a.Content {
		t.Fatalf("bad relation update: %#v", updated)
	}
	if _, err := s.Update(a.ID, LoreItemInput{Name: "豹子头林冲", Type: "character", Content: "修改正文"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyOperations("更新", []LoreOperation{{Op: "update", ID: a.ID, Item: LoreItemInput{Content: "再次修改"}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Update(b.ID, LoreItemInput{Name: "花和尚", Type: "character", Content: b.Content}); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewLoreStore(s.workspace).ReadAny(a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(reloaded.Relations, rels) {
		t.Fatalf("edit/rename dropped stable-ID relations: %#v", reloaded)
	}
	if _, err := s.WriteRelations([]LoreRelationUpdate{{ID: a.ID, BaseRevision: a.UpdatedAt, Relations: []LoreRelation{}}}); !errors.Is(err, ErrLoreRevisionConflict) {
		t.Fatalf("stale update: %v", err)
	}
}

func TestLoreRelationsRejectInvalidBatchWithoutWriting(t *testing.T) {
	s, a, b := relationFixture(t)
	before, _ := os.ReadFile(s.itemsPath())
	for name, bad := range map[string]LoreRelationUpdate{
		"unknown target":   {ID: b.ID, BaseRevision: b.UpdatedAt, Relations: []LoreRelation{{TargetID: "missing", Label: "好友"}}},
		"self":             {ID: b.ID, BaseRevision: b.UpdatedAt, Relations: []LoreRelation{{TargetID: b.ID, Label: "好友"}}},
		"blank label":      {ID: b.ID, BaseRevision: b.UpdatedAt, Relations: []LoreRelation{{TargetID: a.ID, Label: " "}}},
		"missing revision": {ID: b.ID, Relations: []LoreRelation{{TargetID: a.ID, Label: "好友"}}},
		"nil relations":    {ID: b.ID, BaseRevision: b.UpdatedAt},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := s.WriteRelations([]LoreRelationUpdate{{ID: a.ID, BaseRevision: a.UpdatedAt, Relations: []LoreRelation{{TargetID: b.ID, Label: "朋友"}}}, bad})
			if err == nil {
				t.Fatal("invalid batch accepted")
			}
			after, _ := os.ReadFile(s.itemsPath())
			if !bytes.Equal(before, after) {
				t.Fatal("rejected batch mutated disk")
			}
		})
	}
}

func TestLoreRelationDeleteCleansIncomingReferencesAndCanClear(t *testing.T) {
	for _, batch := range []bool{false, true} {
		s, a, b := relationFixture(t)
		if _, err := s.WriteRelations([]LoreRelationUpdate{{ID: a.ID, BaseRevision: a.UpdatedAt, Relations: []LoreRelation{{TargetID: b.ID, Label: "好友"}}}}); err != nil {
			t.Fatal(err)
		}
		linked, _ := s.ReadAny(a.ID)
		if batch {
			if _, err := s.ApplyOperations("删除", []LoreOperation{{Op: "delete", ID: b.ID}}); err != nil {
				t.Fatal(err)
			}
		} else if err := s.Delete(b.ID); err != nil {
			t.Fatal(err)
		}
		clean, _ := s.ReadAny(a.ID)
		if len(clean.Relations) != 0 || clean.UpdatedAt == linked.UpdatedAt {
			t.Fatalf("dangling references or unchanged CAS: %#v", clean)
		}
		if _, err := s.WriteRelations([]LoreRelationUpdate{{ID: a.ID, BaseRevision: clean.UpdatedAt, Relations: []LoreRelation{}}}); err != nil {
			t.Fatal(err)
		}
	}
}
