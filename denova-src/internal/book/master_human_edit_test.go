package book

import (
	"errors"
	"testing"
)

func TestUpdateMasterAssetFieldsAllowsHumanOverwriteAndMissingCharacterField(t *testing.T) {
	workspace := t.TempDir()
	result, err := NewService(workspace).ImportMaterialToMaster("aiko.json", []byte(`{"spec":"chara_card_v2","data":{"name":"Aiko","description":"Old description"}}`), MaterialImportOptions{SourceID: "human_edit_character_001"})
	if err != nil {
		t.Fatalf("导入角色卡失败: %v", err)
	}
	store := NewMasterLibraryStore(workspace)
	item, err := store.LoadItem(result.MasterItemIDs[0])
	if err != nil {
		t.Fatal(err)
	}

	updated, err := store.UpdateMasterAssetFields(MasterHumanFieldEditInput{
		MasterItemID:     item.MasterItemID,
		ExpectedRevision: item.Revision,
		Fields: map[string]string{
			"character.description": "人工说明",
			"character.openings[0]": "人工开场白",
		},
	})
	if err != nil {
		t.Fatalf("人工直接保存失败: %v", err)
	}
	for path, want := range map[string]string{"character.description": "人工说明", "character.openings[0]": "人工开场白"} {
		field, ok := updated.Fields[path]
		if !ok || field.ActiveText != want || field.ActiveKind != "human" || field.NeedsTranslation || field.ActiveTranslationVersionID != "" {
			t.Fatalf("人工字段没有正确生效 path=%s field=%#v", path, field)
		}
	}
	if updated.Original["first_mes"] != "" || updated.Original["description"] != "Old description" {
		t.Fatalf("人工编辑不应改写归档来源投影: %#v", updated.Original)
	}
	transaction, err := store.LoadImport(result.ImportID)
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range transaction.TranslationTargets {
		if target.FieldPath == "character.description" && target.Status != "active" {
			t.Fatalf("人工保存后翻译目标没有完成: %#v", target)
		}
	}
}

func TestUpdateMasterAssetFieldsAllowsMissingNestedOptionalField(t *testing.T) {
	workspace := t.TempDir()
	result, err := NewService(workspace).ImportMaterialToMaster("world.json", []byte(`{"name":"World","entries":[{"uid":1,"comment":"Gate","content":"Old content"}]}`), MaterialImportOptions{SourceID: "human_edit_lore_001"})
	if err != nil {
		t.Fatalf("导入设定书失败: %v", err)
	}
	store := NewMasterLibraryStore(workspace)
	item, err := store.LoadItem(result.MasterItemIDs[0])
	if err != nil {
		t.Fatal(err)
	}
	entryID := item.NestedEntries[0].EntryID
	path := "lorebook.entries/" + entryID + "/secondary_keys"
	updated, err := store.UpdateMasterAssetFields(MasterHumanFieldEditInput{
		MasterItemID: item.MasterItemID, ExpectedRevision: item.Revision,
		Fields: map[string]string{path: "north\ngate"},
	})
	if err != nil {
		t.Fatalf("创建缺失的设定书可选字段失败: %v", err)
	}
	if field := updated.Fields[path]; field.ActiveText != "north\ngate" || field.ActiveKind != "human" {
		t.Fatalf("缺失字段没有被人工创建: %#v", field)
	}
}

func TestUpdateMasterAssetFieldsRejectsStaleRevisionAndUnknownPath(t *testing.T) {
	workspace := t.TempDir()
	result, err := NewService(workspace).ImportMaterialToMaster("aiko.json", []byte(`{"spec":"chara_card_v2","data":{"name":"Aiko","description":"Old description"}}`), MaterialImportOptions{SourceID: "human_edit_guard_001"})
	if err != nil {
		t.Fatal(err)
	}
	store := NewMasterLibraryStore(workspace)
	item, err := store.LoadItem(result.MasterItemIDs[0])
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.UpdateMasterAssetFields(MasterHumanFieldEditInput{MasterItemID: item.MasterItemID, ExpectedRevision: "stale", Fields: map[string]string{"character.description": "new"}})
	var conflict *MasterCASConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("过期页面应返回版本冲突: %v", err)
	}
	_, err = store.UpdateMasterAssetFields(MasterHumanFieldEditInput{MasterItemID: item.MasterItemID, ExpectedRevision: item.Revision, Fields: map[string]string{"character.unknown": "new"}})
	if err == nil {
		t.Fatal("未知字段路径不应被静默保存")
	}
}

func TestAddManualLorebookEntryPersistsAndIsIdempotent(t *testing.T) {
	workspace := t.TempDir()
	result, err := NewService(workspace).ImportMaterialToMaster("world.json", []byte(`{"name":"World","entries":[{"uid":1,"comment":"Gate","content":"Old content"}]}`), MaterialImportOptions{SourceID: "human_add_lore_001"})
	if err != nil {
		t.Fatalf("导入设定书失败: %v", err)
	}
	store := NewMasterLibraryStore(workspace)
	item, err := store.LoadItem(result.MasterItemIDs[0])
	if err != nil {
		t.Fatal(err)
	}
	input := MasterManualLorebookEntryInput{
		MasterItemID: item.MasterItemID, ExpectedRevision: item.Revision,
		Name: "人工港口", Content: "这里是人工补充的港口。", Keywords: []string{"港口", "人工"}, SecondaryKeys: []string{"海岸"},
	}
	updated, err := store.AddManualLorebookEntry(input)
	if err != nil {
		t.Fatalf("新增总库条目失败: %v", err)
	}
	if len(updated.NestedEntries) != 2 {
		t.Fatalf("新增后总库条目数量错误: %d", len(updated.NestedEntries))
	}
	entry := updated.NestedEntries[1]
	if entry.SourceEntryIdentity == "" || entry.Original["comment"] != "人工港口" || entry.Original["content"] != "这里是人工补充的港口。" {
		t.Fatalf("人工条目内容未持久化: %#v", entry)
	}
	if got := updated.Fields["lorebook.entries/"+entry.EntryID+"/content"]; got.ActiveText != "这里是人工补充的港口。" || got.ActiveKind != "human" || got.NeedsTranslation {
		t.Fatalf("人工条目字段状态错误: %#v", got)
	}
	reloaded, err := store.LoadItem(item.MasterItemID)
	if err != nil || len(reloaded.NestedEntries) != 2 {
		t.Fatalf("重新读取后人工条目消失: len=%d err=%v", len(reloaded.NestedEntries), err)
	}
	idempotent, err := store.AddManualLorebookEntry(MasterManualLorebookEntryInput{
		MasterItemID: item.MasterItemID, ExpectedRevision: reloaded.Revision,
		Name: input.Name, Content: input.Content, Keywords: input.Keywords, SecondaryKeys: input.SecondaryKeys,
	})
	if err != nil || len(idempotent.NestedEntries) != 2 {
		t.Fatalf("重复重试不应生成第二个条目: len=%d err=%v", len(idempotent.NestedEntries), err)
	}
}
