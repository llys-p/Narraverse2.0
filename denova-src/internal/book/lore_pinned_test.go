package book

import (
	"os"
	"path/filepath"
	"testing"
)

// 关键条目字段走 PATCH 全字段替换路径：省略时继承，显式取消时清零顺序。
func TestLoreStoreUpdateKeepsPinnedWhenInputOmitsIt(t *testing.T) {
	store := NewLoreStore(t.TempDir())
	pinned, order := true, 2
	created, err := store.Create(LoreItemInput{
		ID: "hero", Type: "character", Name: "林川", Importance: "major",
		Content: "主角设定", Pinned: &pinned, PinOrder: &order,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !created.Pinned || created.PinOrder != 2 {
		t.Fatalf("create should honor pinned fields: %#v", created)
	}

	updated, err := store.Update(created.ID, LoreItemInput{
		Type: "character", Name: "林川", Importance: "major", Content: "改过的主角设定",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !updated.Pinned || updated.PinOrder != 2 {
		t.Fatalf("update without pinned input must inherit previous values, got pinned=%v order=%d", updated.Pinned, updated.PinOrder)
	}

	off := false
	cleared, err := store.Update(created.ID, LoreItemInput{
		Type: "character", Name: "林川", Importance: "major", Content: "改过的主角设定",
		Pinned: &off, PinOrder: &order,
	})
	if err != nil {
		t.Fatal(err)
	}
	if cleared.Pinned || cleared.PinOrder != 0 {
		t.Fatalf("unpinned item must reset pin_order: %#v", cleared)
	}
}

func TestLoreStoreReadsLegacyItemsWithoutPinnedFields(t *testing.T) {
	store := NewLoreStore(t.TempDir())
	if err := os.MkdirAll(filepath.Dir(store.itemsPath()), 0o755); err != nil {
		t.Fatal(err)
	}
	data := `{"version":1,"items":[{"id":"base","type":"location","name":"黄泉酒馆","importance":"important","content":"据点设定"}]}`
	if err := os.WriteFile(store.itemsPath(), []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	items, err := store.ListAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Pinned || items[0].PinOrder != 0 {
		t.Fatalf("legacy items should load as unpinned: %#v", items)
	}
}

func TestLoreStorePinnedDoesNotChangeServerOrdering(t *testing.T) {
	store := NewLoreStore(t.TempDir())
	for _, input := range []LoreItemInput{
		{ID: "a", Type: "character", Name: "甲", Importance: "important", Content: "普通"},
		{ID: "b", Type: "location", Name: "乙", Importance: "major", Content: "重要"},
	} {
		if _, err := store.Create(input); err != nil {
			t.Fatal(err)
		}
	}
	pinned, order := true, 0
	if _, err := store.Update("a", LoreItemInput{
		Type: "character", Name: "甲", Importance: "important", Content: "普通",
		Pinned: &pinned, PinOrder: &order,
	}); err != nil {
		t.Fatal(err)
	}
	list, err := store.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].ID != "b" {
		t.Fatalf("major item must still lead the default order after pinning a minor one: %#v", list)
	}
}

func TestLoreStoreApplyOperationsInheritsAndClearsPinnedAndPreservesImages(t *testing.T) {
	store := NewLoreStore(t.TempDir())
	pinned, order := true, 1
	created, err := store.ApplyOperations("create pinned lore", []LoreOperation{{
		Op: "create", Item: LoreItemInput{
			ID: "hero", Type: "character", Name: "林川", Importance: "major", Content: "原文",
			Pinned: &pinned, PinOrder: &order,
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(created.Items) != 1 || !created.Items[0].Pinned || created.Items[0].PinOrder != 1 {
		t.Fatalf("apply create should honor pinned fields: %#v", created.Items)
	}
	if _, err := store.AppendImages("hero", []LoreItemImage{{Schema: "lore-image/v1", ImagePath: "images/hero.webp"}}); err != nil {
		t.Fatal(err)
	}

	updated, err := store.ApplyOperations("update body only", []LoreOperation{{
		Op: "update", ID: "hero", Item: LoreItemInput{
			Type: "character", Name: "林川", Importance: "major", Content: "更新正文",
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	item := updated.Items[0]
	if !item.Pinned || item.PinOrder != 1 || item.Content != "更新正文" {
		t.Fatalf("apply update should inherit pin while updating body: %#v", item)
	}
	if len(item.Images) != 1 || item.Images[0].ImagePath != "images/hero.webp" {
		t.Fatalf("ordinary body update must preserve manual images: %#v", item.Images)
	}

	off := false
	cleared, err := store.ApplyOperations("unpin lore", []LoreOperation{{
		Op: "update", ID: "hero", Item: LoreItemInput{
			Type: "character", Name: "林川", Importance: "major", Content: "再次更新正文",
			Pinned: &off, PinOrder: &order,
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	item = cleared.Items[0]
	if item.Pinned || item.PinOrder != 0 {
		t.Fatalf("apply update should clear pin order when unpinned: %#v", item)
	}
	if len(item.Images) != 1 || item.Images[0].ImagePath != "images/hero.webp" {
		t.Fatalf("unpin update must preserve manual images: %#v", item.Images)
	}
}
