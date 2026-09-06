package book

import (
	"strings"
	"testing"
)

// masterSyncFixture imports two separate Master assets into the same
// Adventure, translates them and instantiates both. It returns the service,
// the Master store, both import results and both Master item IDs.
func masterSyncFixture(t *testing.T) (*Service, *MasterLibraryStore, MaterialImportResult, MaterialImportResult) {
	t.Helper()
	workspace := t.TempDir()
	service := NewService(workspace)
	master := NewMasterLibraryStore(workspace)

	first, err := service.ImportMaterialToMaster("world-a.json", []byte(`{"name":"Sync World A","entries":{"0":{"uid":0,"key":["dock"],"comment":"Harbor","content":"A trade port."},"7":{"uid":7,"key":["market"],"comment":"Market","content":"A busy market."}}}`), MaterialImportOptions{SourceID: "master_sync_a"})
	if err != nil {
		t.Fatalf("导入资产 A 失败: %v", err)
	}
	second, err := service.ImportMaterialToMaster("world-b.json", []byte(`{"name":"Sync World B","entries":{"3":{"uid":3,"key":["temple"],"comment":"Temple","content":"An old temple."}}}`), MaterialImportOptions{SourceID: "master_sync_b"})
	if err != nil {
		t.Fatalf("导入资产 B 失败: %v", err)
	}
	if len(first.MasterItemIDs) != 1 || len(second.MasterItemIDs) != 1 {
		t.Fatalf("期望两个独立资产: %#v / %#v", first.MasterItemIDs, second.MasterItemIDs)
	}
	entryA0 := masterHashString("uid:0")[:24]
	entryA7 := masterHashString("uid:7")[:24]
	entryB3 := masterHashString("uid:3")[:24]
	translations := map[string]string{
		"lorebook.name": "同步世界A",
		"lorebook.entries/entry-" + entryA0 + "/comment": "港区",
		"lorebook.entries/entry-" + entryA0 + "/content": "一座贸易港。",
		"lorebook.entries/entry-" + entryA0 + "/keys":    "码头",
		"lorebook.entries/entry-" + entryA7 + "/comment": "集市",
		"lorebook.entries/entry-" + entryA7 + "/content": "热闹的集市。",
		"lorebook.entries/entry-" + entryA7 + "/keys":    "市场",
		"lorebook.entries/entry-" + entryB3 + "/comment": "神庙",
		"lorebook.entries/entry-" + entryB3 + "/content": "一座古神庙。",
		"lorebook.entries/entry-" + entryB3 + "/keys":    "寺庙",
	}
	// 资产 B 的名字单独给，避免两个资产同名导致名称分配产生 -2 后缀。
	translationsB := map[string]string{"lorebook.name": "同步世界B"}
	applyAll := func(result MaterialImportResult, override map[string]string) {
		for _, target := range result.TranslationTargets {
			text, ok := override[target.FieldPath]
			if !ok {
				text = translations[target.FieldPath]
			}
			if strings.TrimSpace(text) == "" {
				t.Fatalf("缺少测试译文: %s", target.FieldPath)
			}
			if _, err := master.ApplyTranslation(MasterTranslationApplyInput{
				ImportID: result.ImportID, MasterItemID: target.MasterItemID, FieldPath: target.FieldPath,
				SourceSHA256: target.SourceSHA256, Translation: text, Model: "test-model",
			}); err != nil {
				t.Fatalf("保存译文失败 %s: %v", target.FieldPath, err)
			}
		}
	}
	applyAll(first, nil)
	applyAll(second, translationsB)
	imports := []MaterialImportResult{first, second}
	for index, result := range imports {
		instantiated, err := service.InstantiateMasterAsset(result.MasterItemIDs[0])
		if err != nil {
			t.Fatalf("加入冒险失败: %v", err)
		}
		if instantiated.Status != "instantiated" || len(instantiated.ItemIDs) == 0 {
			t.Fatalf("加入冒险结果异常: %#v", instantiated)
		}
		// 保留导入期的元数据，测试后续只使用 ItemIDs / ImportID / MasterItemIDs。
		instantiated.MasterItemIDs = result.MasterItemIDs
		instantiated.ImportID = result.ImportID
		imports[index] = instantiated
	}
	return service, master, imports[0], imports[1]
}

func loreByID(t *testing.T, workspace string) map[string]LoreItem {
	t.Helper()
	items, err := NewLoreStore(workspace).ListAll()
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]LoreItem{}
	for _, item := range items {
		byID[item.ID] = item
	}
	return byID
}

func TestMasterAssetAdventureUsageReportsCurrentAdventureOnly(t *testing.T) {
	service, _, first, second := masterSyncFixture(t)
	used, err := service.MasterAssetAdventureUsage(first.MasterItemIDs[0])
	if err != nil {
		t.Fatalf("查询使用情况失败: %v", err)
	}
	if !used.Used || used.HasNewVersion {
		t.Fatalf("已加入且无新版时应为 used=true has_new_version=false: %#v", used)
	}
	other, err := service.MasterAssetAdventureUsage(second.MasterItemIDs[0])
	if err != nil {
		t.Fatalf("查询资产 B 使用情况失败: %v", err)
	}
	if !other.Used || other.HasNewVersion {
		t.Fatalf("资产 B 同样应报告 used=true has_new_version=false: %#v", other)
	}

	pending, err := service.ImportMaterialToMaster("world-c.json", []byte(`{"name":"Sync World C","entries":{"9":{"uid":9,"key":["forest"],"comment":"Forest","content":"A dark forest."}}}`), MaterialImportOptions{SourceID: "master_sync_c"})
	if err != nil {
		t.Fatal(err)
	}
	unused, err := service.MasterAssetAdventureUsage(pending.MasterItemIDs[0])
	if err != nil {
		t.Fatalf("查询未加入资产失败: %v", err)
	}
	if unused.Used || unused.HasNewVersion {
		t.Fatalf("未加入当前冒险的资产不得报告可同步: %#v", unused)
	}
}

func TestReprojectMasterAssetUpdatesOnlyItsOwnTargets(t *testing.T) {
	service, master, first, second := masterSyncFixture(t)
	workspace := service.Workspace()
	itemA := first.MasterItemIDs[0]
	itemB := second.MasterItemIDs[0]

	before := loreByID(t, workspace)
	targetsA := append([]string{}, first.ItemIDs...)
	if len(targetsA) == 0 {
		t.Fatal("资产 A 没有冒险实例目标")
	}

	// 修改资产 A 的显示名译文，制造新版本。
	item, err := master.LoadItem(itemA)
	if err != nil {
		t.Fatal(err)
	}
	nameField, ok := item.Fields["lorebook.name"]
	if !ok {
		t.Fatalf("资产 A 缺少 lorebook.name 字段: %#v", item.Fields)
	}
	if _, err := master.ApplyTranslation(MasterTranslationApplyInput{
		ImportID: first.ImportID, MasterItemID: itemA, FieldPath: "lorebook.name",
		SourceSHA256: nameField.SourceSHA256, Translation: "同步世界A改名", Model: "test-model",
	}); err != nil {
		t.Fatalf("更新资产 A 译文失败: %v", err)
	}

	usageA, err := service.MasterAssetAdventureUsage(itemA)
	if err != nil {
		t.Fatal(err)
	}
	if !usageA.HasNewVersion {
		t.Fatalf("资产 A 应报告有新版本: %#v", usageA)
	}
	usageB, err := service.MasterAssetAdventureUsage(itemB)
	if err != nil {
		t.Fatal(err)
	}
	if usageB.HasNewVersion {
		t.Fatalf("资产 B 不应报告新版本: %#v", usageB)
	}

	result, err := service.ReprojectMasterAsset(itemA)
	if err != nil {
		t.Fatalf("同步资产 A 失败: %v", err)
	}
	if len(result.UpdatedLoreIDs) != len(targetsA) {
		t.Fatalf("应更新资产 A 的全部目标: got %#v want %d", result.UpdatedLoreIDs, len(targetsA))
	}
	after := loreByID(t, workspace)
	for _, id := range targetsA {
		if after[id].Content != before[id].Content {
			t.Fatalf("同步不应改变目标正文 %s: %q -> %q", id, before[id].Content, after[id].Content)
		}
	}
	for _, id := range second.ItemIDs {
		if after[id].Content != before[id].Content || after[id].Name != before[id].Name {
			t.Fatalf("同步资产 A 不得影响资产 B 的目标 %s: %#v -> %#v", id, before[id], after[id])
		}
	}

	updatedB, err := service.MasterAssetAdventureUsage(itemB)
	if err != nil {
		t.Fatal(err)
	}
	if updatedB.HasNewVersion {
		t.Fatal("资产 B 仍被标记为有新版本")
	}
	syncedA, err := service.MasterAssetAdventureUsage(itemA)
	if err != nil {
		t.Fatal(err)
	}
	if syncedA.HasNewVersion || syncedA.LoadedRevision != syncedA.CurrentRevision {
		t.Fatalf("同步后资产 A 不应再有新版本: %#v", syncedA)
	}
}

func TestReprojectMasterAssetPreservesAdventureLocalFields(t *testing.T) {
	service, master, first, _ := masterSyncFixture(t)
	workspace := service.Workspace()
	itemA := first.MasterItemIDs[0]

	local := first.ItemIDs[0]
	store := NewLoreStore(workspace)
	disabled := false
	image := &LoreItemImage{ImagePath: "images/local.png"}
	provenance := &LoreProvenance{Kind: "local_edit", SourceName: "手工维护"}
	if _, err := store.ApplyOperations("本地调整", []LoreOperation{{Op: "update", ID: local, Item: LoreItemInput{
		ID: local, Enabled: &disabled, Type: "lore", TypeSource: "manual", Name: "本地改名",
		LoadMode: LoreLoadModeResident, Content: "本地正文", Image: image, Provenance: provenance,
	}}}); err != nil {
		t.Fatalf("本地调整失败: %v", err)
	}
	before, ok := loreByID(t, workspace)[local]
	if !ok {
		t.Fatalf("本地调整后找不到条目 %s", local)
	}

	item, err := master.LoadItem(itemA)
	if err != nil {
		t.Fatal(err)
	}
	contentField := ""
	for path := range item.Fields {
		if strings.HasSuffix(path, "/content") {
			contentField = path
			break
		}
	}
	if contentField == "" {
		t.Fatalf("资产 A 缺少嵌套条目正文字段: %#v", item.Fields)
	}
	if _, err := master.ApplyTranslation(MasterTranslationApplyInput{
		ImportID: first.ImportID, MasterItemID: itemA, FieldPath: contentField,
		SourceSHA256: item.Fields[contentField].SourceSHA256, Translation: "更新后的正文。", Model: "test-model",
	}); err != nil {
		t.Fatalf("更新正文译文失败: %v", err)
	}

	if _, err := service.ReprojectMasterAsset(itemA); err != nil {
		t.Fatalf("同步失败: %v", err)
	}
	kept, err := store.ListAll()
	if err != nil {
		t.Fatal(err)
	}
	var synced *LoreItem
	for index := range kept {
		if kept[index].ID == local {
			synced = &kept[index]
		}
	}
	if synced == nil {
		t.Fatalf("同步后找不到本地条目 %s", local)
	}
	if synced.Enabled {
		t.Fatal("同步不得重新启用被本地关闭的条目")
	}
	if synced.LoadMode != LoreLoadModeResident {
		t.Fatalf("同步不得覆盖本地加载方式: %q", synced.LoadMode)
	}
	if synced.TypeSource != before.TypeSource || synced.Type != before.Type {
		t.Fatalf("同步不得改写本地类型判定: %q/%q -> %q/%q", before.Type, before.TypeSource, synced.Type, synced.TypeSource)
	}
	if synced.Tags == nil && before.Tags != nil {
		t.Fatal("同步不得把本地标签置空")
	}
	if synced.Image == nil || synced.Image.ImagePath != image.ImagePath {
		t.Fatalf("同步不得清除本地配图: %#v", synced.Image)
	}
	if synced.Provenance == nil || synced.Provenance.SourceName != provenance.SourceName {
		t.Fatalf("同步不得清除本地来源标记: %#v", synced.Provenance)
	}
	if strings.Contains(synced.Name, "-2") {
		t.Fatalf("名称分配应排除本资产自己的目标，避免出现伪冲突后缀: %q", synced.Name)
	}
}

func TestReprojectMasterAssetFailsAtomicallyWhenTargetMissing(t *testing.T) {
	service, master, first, _ := masterSyncFixture(t)
	workspace := service.Workspace()
	itemA := first.MasterItemIDs[0]
	removed := first.ItemIDs[0]

	store := NewLoreStore(workspace)
	if _, err := store.ApplyOperations("删除冒险条目", []LoreOperation{{Op: "delete", ID: removed}}); err != nil {
		t.Fatalf("删除冒险条目失败: %v", err)
	}
	before := loreByID(t, workspace)

	item, err := master.LoadItem(itemA)
	if err != nil {
		t.Fatal(err)
	}
	nameField := item.Fields["lorebook.name"]
	if _, err := master.ApplyTranslation(MasterTranslationApplyInput{
		ImportID: first.ImportID, MasterItemID: itemA, FieldPath: "lorebook.name",
		SourceSHA256: nameField.SourceSHA256, Translation: "缺失目标时的改名", Model: "test-model",
	}); err != nil {
		t.Fatalf("更新译文失败: %v", err)
	}

	if _, err := service.ReprojectMasterAsset(itemA); err == nil {
		t.Fatal("目标缺失时同步必须整体失败")
	}
	usage, err := service.MasterAssetAdventureUsage(itemA)
	if err != nil {
		t.Fatal(err)
	}
	if !usage.HasNewVersion {
		t.Fatal("同步失败后不得把 LoadedRevision 更新为新版本（否则会出现“同步成功但内容没更新”的假状态）")
	}
	after := loreByID(t, workspace)
	for id, item := range before {
		if _, ok := after[id]; !ok {
			t.Fatalf("同步失败回滚后条目丢失: %s", id)
		}
		if after[id].Content != item.Content || after[id].Name != item.Name {
			t.Fatalf("同步失败应完整回滚 %s: %#v -> %#v", id, item, after[id])
		}
	}
}

func TestReprojectMasterAssetRejectsUnusedAsset(t *testing.T) {
	workspace := t.TempDir()
	service := NewService(workspace)
	pending, err := service.ImportMaterialToMaster("unused.json", []byte(`{"name":"Unused World","entries":{"1":{"uid":1,"key":["ruin"],"comment":"Ruin","content":"A ruin."}}}`), MaterialImportOptions{SourceID: "master_sync_unused"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReprojectMasterAsset(pending.MasterItemIDs[0]); err == nil {
		t.Fatal("未加入当前冒险的资产不得同步")
	}
}
