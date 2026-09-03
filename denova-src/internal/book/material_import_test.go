package book

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testLorebook(count int, suffix string) []byte {
	var entries strings.Builder
	for index := 0; index < count; index++ {
		if index > 0 {
			entries.WriteByte(',')
		}
		fmt.Fprintf(&entries, `%q:{"uid":%d,"key":[%q],"comment":%q,"content":%q,"disable":false}`, fmt.Sprint(index), index, fmt.Sprintf("Key-%d", index), fmt.Sprintf("Entry %d", index), fmt.Sprintf("Complete content %d %s", index, suffix))
	}
	return []byte(`{"name":"Large World","entries":{` + entries.String() + `}}`)
}

func TestPreviewMaterialReadsStandaloneLorebookBeyondLegacyLimits(t *testing.T) {
	preview, err := PreviewMaterial("large.json", testLorebook(503, "v1"))
	if err != nil {
		t.Fatalf("预览设定书失败: %v", err)
	}
	if preview.Kind != "lorebook" || preview.EntryCount != 503 {
		t.Fatalf("预览数量不完整: %#v", preview)
	}
}

func TestPreviewMaterialDoesNotMistakeLorebookDescriptionForCharacterCard(t *testing.T) {
	data := []byte(`{"name":"World","description":"Book description","entries":[{"uid":1,"key":["x"],"content":"full"}]}`)
	preview, err := PreviewMaterial("world.json", data)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Kind != "lorebook" || preview.EntryCount != 1 {
		t.Fatalf("设定书被误判: %#v", preview)
	}
}

func TestImportMaterialArchivesAndTracksStableLoreItems(t *testing.T) {
	workspace := t.TempDir()
	service := NewService(workspace)
	result, err := service.ImportMaterial("world.json", testLorebook(3, "v1"), MaterialImportOptions{SourceID: "source_world_001", SourceKind: "test", ManagementMode: MaterialModeDirect})
	if err != nil {
		t.Fatalf("导入设定书失败: %v", err)
	}
	if len(result.CreatedIDs) != 3 || len(result.ItemIDs) != 3 {
		t.Fatalf("目标数量不符: %#v", result)
	}
	if _, err := os.Stat(filepath.Join(workspace, filepath.FromSlash(result.ArchivePath))); err != nil {
		t.Fatalf("原件未归档: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workspace, filepath.FromSlash(result.ManifestPath))); err != nil {
		t.Fatalf("清单未保存: %v", err)
	}

	repeated, err := service.ImportMaterial("world.json", testLorebook(3, "v1"), MaterialImportOptions{SourceID: "source_world_001", ManagementMode: MaterialModeDirect})
	if err != nil {
		t.Fatalf("重复导入失败: %v", err)
	}
	if len(repeated.CreatedIDs) != 0 || len(repeated.SkippedIDs) != 3 {
		t.Fatalf("重复导入未稳定跳过: %#v", repeated)
	}
}

func TestImportMaterialUpdatesManagedItemButProtectsManualEdit(t *testing.T) {
	workspace := t.TempDir()
	service := NewService(workspace)
	_, err := service.ImportMaterial("world.json", testLorebook(2, "v1"), MaterialImportOptions{SourceID: "source_world_002", ManagementMode: MaterialModeDirect})
	if err != nil {
		t.Fatal(err)
	}

	updated, err := service.ImportMaterial("world.json", testLorebook(2, "v2"), MaterialImportOptions{SourceID: "source_world_002", ManagementMode: MaterialModeDirect})
	if err != nil {
		t.Fatal(err)
	}
	if len(updated.UpdatedIDs) != 2 || len(updated.ConflictIDs) != 0 {
		t.Fatalf("受管项未更新: %#v", updated)
	}

	store := NewLoreStore(workspace)
	items, _ := store.ListAll()
	item := items[0]
	enabled := item.Enabled
	_, err = store.Update(item.ID, LoreItemInput{Enabled: &enabled, Type: item.Type, Name: item.Name, Importance: item.Importance, Tags: item.Tags, BriefDescription: item.BriefDescription, Keywords: item.Keywords, LoadMode: item.LoadMode, Content: item.Content + " manual", BaseRevision: item.UpdatedAt})
	if err != nil {
		t.Fatal(err)
	}

	conflicted, err := service.ImportMaterial("world.json", testLorebook(2, "v3"), MaterialImportOptions{SourceID: "source_world_002", ManagementMode: MaterialModeDirect})
	if err != nil {
		t.Fatal(err)
	}
	if len(conflicted.ConflictIDs) != 1 || len(conflicted.UpdatedIDs) != 1 {
		t.Fatalf("手改项没有产生冲突副本: %#v", conflicted)
	}
}

func TestImportMaterialRequiresExplicitAcceptanceForTruncatedSource(t *testing.T) {
	workspace := t.TempDir()
	data := []byte(`{"name":"World","entries":[{"uid":1,"key":["x"],"content":"内容已截断，完整版见原文件"}]}`)
	_, err := NewService(workspace).ImportMaterial("world.json", data, MaterialImportOptions{SourceID: "source_world_003", ManagementMode: MaterialModeDirect})
	if err == nil || !strings.Contains(err.Error(), "接受不完整导入") {
		t.Fatalf("截断原件未被阻止: %v", err)
	}
}

func TestLegacyDirectMaterialUploadSourceIDIsStableAcrossFileUpdates(t *testing.T) {
	if materialSourceID("World.json", []byte("v1")) != materialSourceID("world.json", []byte("v2")) {
		t.Fatal("同名上传素材更新后应保持来源 ID 稳定")
	}
}

func TestImportMaterialDefaultsToMasterManagedAndInstantiatesChineseLorebook(t *testing.T) {
	workspace := t.TempDir()
	data := []byte(`{"name":"云港","entries":{"0":{"id":0,"key":["码头"],"comment":"港区","content":"潮汐驱动的贸易港。"}}}`)

	result, err := NewService(workspace).ImportMaterial("world.json", data, MaterialImportOptions{})
	if err != nil {
		t.Fatalf("管理式导入失败: %v", err)
	}
	if result.ManagementMode != MaterialModeManaged || result.Status != "instantiated" {
		t.Fatalf("普通导入没有默认走总库: %#v", result)
	}
	if len(result.CreatedIDs) != 1 || len(result.ItemIDs) != 1 || len(result.MasterItemIDs) != 1 {
		t.Fatalf("总库与冒险实例数量不符: %#v", result)
	}
	if len(result.TranslationTargets) != 0 {
		t.Fatalf("纯中文条目不应创建翻译任务: %#v", result.TranslationTargets)
	}
	if _, err := os.Stat(filepath.Join(result.MasterWorkspace, filepath.FromSlash(result.ArchivePath))); err != nil {
		t.Fatalf("Master 原件未归档: %v", err)
	}
	item, err := NewMasterLibraryStore(workspace).LoadItem(result.MasterItemIDs[0])
	if err != nil {
		t.Fatal(err)
	}
	if item.SourceEntryIdentity != "lorebook" {
		t.Fatalf("独立设定书应使用稳定的顶层身份: %q", item.SourceEntryIdentity)
	}
}

func TestImportMaterialToMasterDoesNotInstantiateUntilSelectedAdventure(t *testing.T) {
	workspace := t.TempDir()
	service := NewService(workspace)
	data := []byte(`{"name":"Master World","entries":{"0":{"uid":0,"key":["dock"],"comment":"Harbor","content":"A trade port."}}}`)

	pending, err := service.ImportMaterialToMaster("world.json", data, MaterialImportOptions{SourceID: "master_world_001"})
	if err != nil {
		t.Fatalf("总库专用导入失败: %v", err)
	}
	if pending.Status != "pending_translation" || len(pending.MasterItemIDs) != 1 {
		t.Fatalf("总库导入状态异常: %#v", pending)
	}
	items, err := NewLoreStore(workspace).ListAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("仅加入总库不应创建当前冒险实例: %#v", items)
	}

	master := NewMasterLibraryStore(workspace)
	translations := map[string]string{
		"lorebook.name": "总库世界",
		"lorebook.entries/entry-" + masterHashString("uid:0")[:24] + "/comment": "港区",
		"lorebook.entries/entry-" + masterHashString("uid:0")[:24] + "/content": "一座贸易港。",
		"lorebook.entries/entry-" + masterHashString("uid:0")[:24] + "/keys":    "码头",
	}
	for _, target := range pending.TranslationTargets {
		if _, err := master.ApplyTranslation(MasterTranslationApplyInput{
			ImportID: pending.ImportID, MasterItemID: target.MasterItemID, FieldPath: target.FieldPath,
			SourceSHA256: target.SourceSHA256, Translation: translations[target.FieldPath], Model: "test-model",
		}); err != nil {
			t.Fatalf("保存总库译文失败: %v", err)
		}
	}
	instantiated, err := service.InstantiateMasterAsset(pending.MasterItemIDs[0])
	if err != nil {
		t.Fatalf("从总库加入当前冒险失败: %v", err)
	}
	if instantiated.Status != "instantiated" || len(instantiated.ItemIDs) != 1 {
		t.Fatalf("加入冒险结果异常: %#v", instantiated)
	}
	repeated, err := service.InstantiateMasterAsset(pending.MasterItemIDs[0])
	if err != nil {
		t.Fatalf("重复加入冒险失败: %v", err)
	}
	if len(repeated.CreatedIDs) != 0 || len(repeated.SkippedIDs) != 1 {
		t.Fatalf("重复加入冒险不幂等: %#v", repeated)
	}
}

func TestLorebookRuntimeUsesKeywordsWhenOptionalEntryNameIsEmpty(t *testing.T) {
	workspace := t.TempDir()
	service := NewService(workspace)
	data := []byte(`{"name":"中文设定书","entries":{"0":{"uid":0,"key":["港口"],"comment":"","content":"港区正文。"}}}`)

	imported, err := service.ImportMaterialToMaster("world.json", data, MaterialImportOptions{SourceID: "runtime_name_fallback_001"})
	if err != nil {
		t.Fatal(err)
	}
	if imported.Status != "ready" || len(imported.MasterItemIDs) != 1 {
		t.Fatalf("中文设定书应直接可用: %#v", imported)
	}
	instantiated, err := service.InstantiateMasterAsset(imported.MasterItemIDs[0])
	if err != nil {
		t.Fatalf("空 comment 不应阻止运行时展开: %v", err)
	}
	if len(instantiated.ItemIDs) != 1 {
		t.Fatalf("运行时展开数量错误: %#v", instantiated)
	}
	items, err := NewLoreStore(workspace).ListAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Name != "港口" {
		t.Fatalf("运行时条目没有使用关键词名称回退: %#v", items)
	}
}

func TestManagedImportWaitsForRequiredTranslationsThenFinalizesOnce(t *testing.T) {
	workspace := t.TempDir()
	service := NewService(workspace)
	data := []byte(`{"name":"Harbor","entries":[{"uid":0,"key":["dock"],"comment":"Harbor District","content":"A trade port driven by tides."}]}`)

	pending, err := service.ImportMaterial("harbor.json", data, MaterialImportOptions{})
	if err != nil {
		t.Fatalf("导入英文设定书失败: %v", err)
	}
	if pending.Status != "pending_translation" || len(pending.TranslationTargets) != 4 {
		t.Fatalf("英文必需字段没有等待翻译: %#v", pending)
	}
	items, err := NewLoreStore(workspace).ListAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("翻译完成前不应污染冒险资料库: %#v", items)
	}

	master := NewMasterLibraryStore(workspace)
	entryID := "entry-" + masterHashString("uid:0")[:24]
	translations := map[string]string{
		"lorebook.name": "港湾",
		"lorebook.entries/" + entryID + "/comment": "港区",
		"lorebook.entries/" + entryID + "/content": "一座由潮汐驱动的贸易港。",
		"lorebook.entries/" + entryID + "/keys":    "码头",
	}
	for _, target := range pending.TranslationTargets {
		applied, applyErr := master.ApplyTranslation(MasterTranslationApplyInput{
			ImportID: pending.ImportID, MasterItemID: target.MasterItemID, FieldPath: target.FieldPath,
			SourceSHA256: target.SourceSHA256, Translation: translations[target.FieldPath], Model: "test-model",
		})
		if applyErr != nil {
			t.Fatalf("写入字段译文失败: %v", applyErr)
		}
		if !applied.Activated {
			t.Fatalf("安全字段译文没有自动激活: %#v", applied)
		}
	}

	finalized, err := service.FinalizeMasterImport(pending.ImportID)
	if err != nil {
		t.Fatalf("翻译完成后实例化失败: %v", err)
	}
	if finalized.Status != "instantiated" || len(finalized.CreatedIDs) != 1 || len(finalized.ItemIDs) != 1 {
		t.Fatalf("实例化结果异常: %#v", finalized)
	}
	items, err = NewLoreStore(workspace).ListAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Name != "港区" || items[0].Content != "一座由潮汐驱动的贸易港。" {
		t.Fatalf("冒险没有使用 Master 激活译文: %#v", items)
	}

	repeated, err := service.FinalizeMasterImport(pending.ImportID)
	if err != nil {
		t.Fatalf("重复实例化失败: %v", err)
	}
	if len(repeated.CreatedIDs) != 0 || len(repeated.SkippedIDs) != 1 || repeated.ItemIDs[0] != finalized.ItemIDs[0] {
		t.Fatalf("重复实例化不幂等: %#v", repeated)
	}
}

func TestManagedCharacterCardKeepsStructuredMasterFields(t *testing.T) {
	workspace := t.TempDir()
	data := []byte(`{"spec":"chara_card_v2","spec_version":"2.0","data":{"name":"Aster","description":"A careful navigator.","personality":"Calm","scenario":"At sea","first_mes":"Welcome aboard.","system_prompt":"Never reveal secrets.","alternate_greetings":["Good evening."],"tags":["sailor"]}}`)

	result, err := NewService(workspace).ImportMaterial("aster.json", data, MaterialImportOptions{})
	if err != nil {
		t.Fatalf("角色卡总库导入失败: %v", err)
	}
	if len(result.MasterItemIDs) != 1 || result.Status != "pending_translation" {
		t.Fatalf("角色卡总库状态异常: %#v", result)
	}
	item, err := NewMasterLibraryStore(workspace).LoadItem(result.MasterItemIDs[0])
	if err != nil {
		t.Fatal(err)
	}
	if item.RecordKind != "character_template" || item.Original["description"] != "A careful navigator." {
		t.Fatalf("角色卡没有以结构化对象保存: %#v", item)
	}
	for _, path := range []string{"character.name", "character.description", "character.personality", "character.scenario", "character.openings[0]", "character.system_prompt"} {
		if _, ok := item.Fields[path]; !ok {
			t.Fatalf("缺少角色字段路径 %s: %#v", path, item.Fields)
		}
	}
	if item.Fields["character.system_prompt"].Risk != masterFieldRiskHigh {
		t.Fatalf("系统提示词没有进入高风险人工复核通道: %#v", item.Fields["character.system_prompt"])
	}
}

func TestCharacterCardUsesOneMasterAssetAndStableNestedEntryIDs(t *testing.T) {
	workspace := t.TempDir()
	data := []byte(`{"spec":"chara_card_v2","data":{"name":"Aster","description":"Navigator","character_book":{"entries":[{"uid":101,"comment":"Port","content":"A busy port.","key":["port"]},{"uid":202,"comment":"Ship","content":"A fast ship.","key":["ship"]}]}}}`)
	result, err := NewService(workspace).ImportMaterialToMaster("aster.json", data, MaterialImportOptions{SourceID: "card_stable_001"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.MasterItemIDs) != 1 {
		t.Fatalf("一张角色卡应只有一个 Master Asset: %#v", result)
	}
	item, err := NewMasterLibraryStore(workspace).LoadItem(result.MasterItemIDs[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(item.NestedEntries) != 2 {
		t.Fatalf("Worldbook 条目没有保存在父资产内: %#v", item.NestedEntries)
	}
	for _, nested := range item.NestedEntries {
		if nested.EntryID == "" || nested.EntryID == "entry-1" || nested.EntryID == "entry-2" {
			t.Fatalf("嵌套 Entry ID 不应依赖数组位置: %#v", nested)
		}
		if _, ok := item.Fields["character_book.entries/"+nested.EntryID+"/content"]; !ok {
			t.Fatalf("嵌套字段没有进入父资产 fields: %#v", item.Fields)
		}
	}
	assets, err := NewMasterLibraryStore(workspace).ListAssets(MasterAssetQuery{})
	if err != nil || assets.Total != 1 {
		t.Fatalf("总库列表应只显示一个角色卡资产: %#v %v", assets, err)
	}
	if assets.Assets[0].Description != "Navigator" || assets.Assets[0].NestedEntryCount != 2 {
		t.Fatalf("角色卡列表摘要不完整: %#v", assets.Assets[0])
	}
	if lore, _ := NewLoreStore(workspace).ListAll(); len(lore) != 0 {
		t.Fatalf("总库导入不应写入冒险 Lore: %#v", lore)
	}

	swapped := []byte(`{"spec":"chara_card_v2","data":{"name":"Aster","description":"Navigator","character_book":{"entries":[{"uid":202,"comment":"Ship","content":"A fast ship.","key":["ship"]},{"uid":101,"comment":"Port","content":"A busy port.","key":["port"]}]}}}`)
	firstPreview, _ := PreviewMaterial("aster.json", data)
	secondPreview, _ := PreviewMaterial("aster.json", swapped)
	firstInputs, _ := buildMasterItemInputs("aster.json", data, firstPreview, MaterialImportOptions{})
	secondInputs, _ := buildMasterItemInputs("aster.json", swapped, secondPreview, MaterialImportOptions{})
	firstIDs, secondIDs := map[string]string{}, map[string]string{}
	for _, entry := range firstInputs[0].NestedEntries {
		firstIDs[entry.SourceEntryIdentity] = entry.EntryID
	}
	for _, entry := range secondInputs[0].NestedEntries {
		secondIDs[entry.SourceEntryIdentity] = entry.EntryID
	}
	if len(firstIDs) != len(secondIDs) || firstIDs["uid:101"] != secondIDs["uid:101"] || firstIDs["uid:202"] != secondIDs["uid:202"] {
		t.Fatalf("Entry ID 随数组位置变化: %#v %#v", firstIDs, secondIDs)
	}
}

func TestNestedTranslationAndInstantiationKeepsEntryMapping(t *testing.T) {
	workspace := t.TempDir()
	data := []byte(`{"spec":"chara_card_v2","data":{"name":"阿斯特","description":"航海者","character_book":{"entries":[{"uid":7,"comment":"Harbor","content":"A busy harbor.","key":["harbor"]}]}}}`)
	service := NewService(workspace)
	pending, err := service.ImportMaterialToMaster("aster.json", data, MaterialImportOptions{SourceID: "nested_card_001"})
	if err != nil {
		t.Fatal(err)
	}
	master := NewMasterLibraryStore(workspace)
	for _, target := range pending.TranslationTargets {
		fieldName := target.FieldPath[strings.LastIndex(target.FieldPath, "/")+1:]
		translation := map[string]string{"comment": "港湾", "content": "繁忙的港口。", "keys": "港口"}[fieldName]
		if translation == "" {
			translation = "港口"
		}
		if _, err := master.ApplyTranslation(MasterTranslationApplyInput{ImportID: pending.ImportID, MasterItemID: target.MasterItemID, FieldPath: target.FieldPath, SourceSHA256: target.SourceSHA256, Translation: translation, Model: "hy-mt"}); err != nil {
			t.Fatal(err)
		}
	}
	instantiated, err := service.InstantiateMasterAsset(pending.MasterItemIDs[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(instantiated.CreatedIDs) != 2 {
		t.Fatalf("角色 Lore 与 Worldbook Lore 未完整展开: %#v", instantiated)
	}
	detail, err := master.GetAsset(pending.MasterItemIDs[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Usages) != 1 || len(detail.Usages[0].NestedEntryLoreIDs) != 1 {
		t.Fatalf("实例没有保存嵌套 Entry 映射: %#v", detail.Usages)
	}
}

func TestLegacyWorldbookEntriesArchiveIntoParentAsset(t *testing.T) {
	workspace := t.TempDir()
	adventure := filepath.Join(workspace, ".denova", "projects", "adventure")
	store := NewMasterLibraryStore(adventure)
	data := []byte(`{"name":"Legacy World","entries":[{"id":7,"key":["harbor"],"comment":"Harbor","content":"A busy harbor."}]}`)
	ingested, err := store.Ingest(MasterIngestInput{
		Filename: "legacy.json", Data: data, SourceKind: "user_upload", AdventureWorkspace: adventure,
		Items: []MasterItemInput{masterLoreEntryInput(tavernBookEntry{ID: 7, SourceRecordID: "id:7", Comment: "Harbor", Content: "A busy harbor.", Keys: []string{"harbor"}}, 0, "Legacy World")},
	})
	if err != nil {
		t.Fatal(err)
	}
	oldTarget := ingested.Transaction.TranslationTargets[0]
	for _, target := range ingested.Transaction.TranslationTargets {
		translation := "繁忙港口"
		if strings.HasSuffix(target.FieldPath, ".name") {
			translation = "港湾"
		}
		if _, err := store.ApplyTranslation(MasterTranslationApplyInput{ImportID: target.ImportID, MasterItemID: target.MasterItemID, FieldPath: target.FieldPath, SourceSHA256: target.SourceSHA256, Translation: translation, Model: "hy-mt"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.MarkImportInstantiated(ingested.Transaction.ImportID, []string{"old-lore"}, []MasterInstanceRef{{InstanceID: "old-instance", ImportID: ingested.Transaction.ImportID, MasterItemID: oldTarget.MasterItemID, AdventureKey: "old-adventure", TargetLoreIDs: []string{"old-lore"}}}); err != nil {
		t.Fatal(err)
	}

	result, err := store.MigrateLegacyWorldbookEntries()
	if err != nil {
		t.Fatal(err)
	}
	if result.ArchivedItems != 1 || result.ParentAssets != 1 || result.PreservedInstances != 1 {
		t.Fatalf("旧子资产迁移统计异常: %#v", result)
	}
	assets, err := store.ListAssets(MasterAssetQuery{})
	if err != nil || assets.Total != 1 || assets.Assets[0].RecordKind != "lorebook_template" {
		t.Fatalf("迁移后 active 列表异常: %#v %v", assets, err)
	}
	if _, err := store.GetAsset(oldTarget.MasterItemID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("旧子资产不应继续作为 active 详情: %v", err)
	}
	detail, err := store.GetAsset(assets.Assets[0].MasterItemID)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Item.NestedEntries) != 1 || detail.Item.Fields["lorebook.entries/entry-"+masterHashString("id:7")[:24]+"/content"].ActiveText != "繁忙港口" {
		t.Fatalf("旧译文没有迁移到嵌套字段: %#v", detail.Item)
	}
	manifest, err := store.loadManifestUnlocked()
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.LegacyItems) != 1 || len(manifest.LegacyInstances) != 1 || len(manifest.LegacyTranslations) < 2 {
		t.Fatalf("legacy tombstone 索引不完整: %#v", manifest)
	}
	if _, err := os.Stat(filepath.Join(store.Workspace(), filepath.FromSlash(masterLegacyMappingPath))); err != nil {
		t.Fatalf("迁移映射没有保存: %v", err)
	}
}
