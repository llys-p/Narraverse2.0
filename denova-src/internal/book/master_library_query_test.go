package book

import "testing"

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
