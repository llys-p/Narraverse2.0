package book

import (
	"bytes"
	"testing"
)

func TestMasterItemTagsUsesActiveCharacterTagsAndFallsBackToSource(t *testing.T) {
	item := MasterItem{
		RecordKind:      "character_template",
		Original:        map[string]any{"tags": []any{"Anime", "Love"}},
		SourceSemantics: map[string]any{"tags": []any{"Love", "Female"}},
		Fields:          map[string]MasterField{"character.tags": {ActiveText: "动漫\n恋爱"}},
	}
	if got := masterItemTags(item); len(got) != 2 || got[0] != "动漫" || got[1] != "恋爱" {
		t.Fatalf("应优先返回当前角色标签: %#v", got)
	}

	item.Fields = map[string]MasterField{}
	got := masterItemTags(item)
	if len(got) != 3 || got[0] != "Anime" || got[1] != "Love" || got[2] != "Female" {
		t.Fatalf("应从原始和来源语义合并去重角色标签: %#v", got)
	}
}

func TestMasterItemDescriptionDoesNotPromoteNestedEntryContent(t *testing.T) {
	item := MasterItem{
		RecordKind: "lorebook_template",
		Original:   map[string]any{"name": "World"},
		Fields: map[string]MasterField{
			"lorebook.entries/entry-1/content": {SourceText: "第一条正文"},
		},
		NestedEntries: []MasterNestedEntry{{EntryID: "entry-1"}},
	}
	if got := masterItemDescription(item); got != "" {
		t.Fatalf("没有大条目简介时不应提升小条目正文: %q", got)
	}

	item.Fields["lorebook.description"] = MasterField{ActiveText: "世界简介"}
	if got := masterItemDescription(item); got != "世界简介" {
		t.Fatalf("应优先返回独立的大条目简介: %q", got)
	}
}

func TestMasterCharacterAvatarUsesArchivedPNGWithoutExposingArchivePath(t *testing.T) {
	store, adventure := masterTestStore(t)
	result, err := store.Ingest(MasterIngestInput{
		Filename: "aiko.png", Data: []byte("png-data"), SourceKind: "user_upload", AdventureWorkspace: adventure,
		Items: []MasterItemInput{{
			SourceEntryIdentity: "character:0", RecordKind: "character_template", SemanticType: "character", Name: "Aiko",
			Original: map[string]any{"name": "Aiko"}, SourceSemantics: map[string]any{}, RuntimeSemantics: map[string]any{},
			Fields: map[string]MasterFieldInput{"character.name": {Text: "Aiko", Risk: masterFieldRiskSafe, Required: true}},
		}},
	})
	if err != nil {
		t.Fatalf("导入角色卡失败: %v", err)
	}
	detail, err := store.GetAsset(result.Items[0].MasterItemID)
	if err != nil {
		t.Fatal(err)
	}
	wantURL := "/api/library/assets/" + result.Items[0].MasterItemID + "/avatar"
	if detail.Summary.AvatarURL != wantURL {
		t.Fatalf("角色卡摘要头像地址错误: got %q want %q", detail.Summary.AvatarURL, wantURL)
	}
	data, err := store.GetAssetAvatar(result.Items[0].MasterItemID)
	if err != nil {
		t.Fatalf("读取归档角色头像失败: %v", err)
	}
	if !bytes.Equal(data, []byte("png-data")) {
		t.Fatalf("读取的头像内容错误: %q", data)
	}
}

func TestMasterLibraryQueryDerivesStagingThenUsableAndListsUsages(t *testing.T) {
	store, adventure := masterTestStore(t)
	ingested, err := store.Ingest(MasterIngestInput{
		Filename: "harbor.json", Data: []byte("query-source"), SourceKind: "user_upload",
		AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("location", "A trade port.")},
	})
	if err != nil {
		t.Fatal(err)
	}

	list, err := store.ListAssets(MasterAssetQuery{Query: "Entry"})
	if err != nil {
		t.Fatal(err)
	}
	if list.Total != 1 || len(list.Assets) != 1 {
		t.Fatalf("应能按名称查询总库资产: %#v", list)
	}
	asset := list.Assets[0]
	if asset.Availability != MasterAvailabilityStaging || asset.Pipeline.Translation.PendingFields != 1 {
		t.Fatalf("未完成必需翻译时应处于 staging: %#v", asset)
	}
	if asset.Name != "待翻译 · Entry Zero" {
		t.Fatalf("未完成顶层名称时应明确显示待翻译: %#v", asset)
	}
	if asset.Description != "A trade port." || asset.NestedEntryCount != 0 {
		t.Fatalf("列表摘要应直接提供简介和内部条目数量: %#v", asset)
	}
	if asset.Pipeline.Nodes[3].Status != masterPipelineWaiting {
		t.Fatalf("翻译节点应等待任务完成: %#v", asset.Pipeline.Nodes)
	}

	target := ingested.Transaction.TranslationTargets[0]
	translation, err := store.ApplyTranslation(MasterTranslationApplyInput{
		ImportID: target.ImportID, MasterItemID: target.MasterItemID, FieldPath: target.FieldPath,
		SourceSHA256: target.SourceSHA256, Translation: "贸易港", Model: "hy-mt", JobID: "query-job",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !translation.Activated {
		t.Fatal("安全字段译文应激活")
	}
	if _, err := store.MarkImportInstantiated(ingested.Transaction.ImportID, []string{"instance-lore-1"}, []MasterInstanceRef{{
		InstanceID: "instance-1", ImportID: ingested.Transaction.ImportID, MasterItemID: target.MasterItemID,
		AdventureKey: "adventure-a", TargetLoreIDs: []string{"instance-lore-1"}, LoadedRevision: "r1",
	}}); err != nil {
		t.Fatal(err)
	}

	detail, err := store.GetAsset(target.MasterItemID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Summary.Availability != MasterAvailabilityUsable || detail.Summary.UsageCount != 1 {
		t.Fatalf("完成翻译并实例化后状态异常: %#v", detail.Summary)
	}
	if len(detail.Translations) != 1 || detail.Translations[0].ContentVersionKind != "hy_mt_active" {
		t.Fatalf("应返回带内容版本类型的译文: %#v", detail.Translations)
	}
	if len(detail.Usages) != 1 || detail.Usages[0].InstanceID != "instance-1" {
		t.Fatalf("应返回全部实例使用记录: %#v", detail.Usages)
	}
}

func TestMasterLibraryQueryMarksChangedSourceAsStale(t *testing.T) {
	store, adventure := masterTestStore(t)
	first, err := store.Ingest(MasterIngestInput{
		Filename: "world.json", Data: []byte("source-v1"), SourceAnchor: "world/1", SourceKind: "knowledge_base",
		AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("lore", "Version one")},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Ingest(MasterIngestInput{
		Filename: "world.json", Data: []byte("source-v2"), SourceAnchor: "world/1", SourceKind: "knowledge_base",
		AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("lore", "Version two")},
	})
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := store.loadManifestUnlocked()
	if err != nil {
		t.Fatal(err)
	}
	currentSource, _, ok := masterSourceAndRevision(manifest, second.Source.SourceID, second.SourceRevision.Revision)
	if !ok {
		t.Fatal("无法读取新来源版本")
	}
	status := deriveMasterPipeline(store.Workspace(), first.Items[0], currentSource, first.SourceRevision, true, manifest)
	if status.Availability != MasterAvailabilityStaging || status.Nodes[1].Status != masterPipelineStale || status.Nodes[3].Status != masterPipelineStale {
		t.Fatalf("来源 revision 变化后下游应 stale: %#v", status)
	}
	if len(status.Issues) == 0 || status.Issues[0].Code != "source_revision_changed" {
		t.Fatalf("应说明 stale 原因: %#v", status.Issues)
	}
}
