package book

import (
	"os"
	"path/filepath"
	"testing"
)

func masterTestStore(t *testing.T) (*MasterLibraryStore, string) {
	t.Helper()
	root := t.TempDir()
	adventure := filepath.Join(root, ".denova", "projects", "adventure-a")
	if err := os.MkdirAll(adventure, 0o755); err != nil {
		t.Fatal(err)
	}
	return NewMasterLibraryStore(adventure), adventure
}

func masterTestItem(semanticType, text string) MasterItemInput {
	return MasterItemInput{
		SourceEntryIdentity: "entry:0",
		RecordKind:          "lorebook_template",
		SemanticType:        semanticType,
		Name:                "Entry Zero",
		Original:            map[string]any{"id": 0, "name": "Entry Zero", "content": text},
		SourceSemantics:     map[string]any{"enabled": true, "keys": []string{"entry"}},
		RuntimeSemantics:    map[string]any{"load_mode": "auto"},
		Fields: map[string]MasterFieldInput{
			"lorebook.name": {Text: "Entry Zero", Risk: masterFieldRiskSafe, Required: true},
		},
	}
}

func TestResolveMasterLibraryWorkspaceUsesProjectsSibling(t *testing.T) {
	workspace := filepath.Join("C:\\Denova", ".denova", "projects", "story")
	got := ResolveMasterLibraryWorkspace(workspace)
	want := filepath.Join("C:\\Denova", ".denova", "projects", masterLibraryProjectName)
	if got != want {
		t.Fatalf("总库位置错误: got %q want %q", got, want)
	}
}

func TestMasterOnlyTransactionStopsAtReady(t *testing.T) {
	store, adventure := masterTestStore(t)
	if store.TransactionTargetsAdventure(MasterImportTransaction{AdventureWorkspace: store.Workspace()}) {
		t.Fatal("Master-only transaction must not project into an Adventure")
	}
	if !store.TransactionTargetsAdventure(MasterImportTransaction{AdventureWorkspace: adventure}) {
		t.Fatal("Adventure-bound transaction must keep its projection step")
	}
}

func TestMasterLibraryUnanchoredUploadsDoNotMergeByFilename(t *testing.T) {
	store, adventure := masterTestStore(t)
	first, err := store.Ingest(MasterIngestInput{
		Filename: "world.json", Data: []byte("version-one"), SourceKind: "user_upload",
		AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("lore", "English one")},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Ingest(MasterIngestInput{
		Filename: "WORLD.json", Data: []byte("version-two"), SourceKind: "user_upload",
		AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("lore", "English two")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Source.SourceID == second.Source.SourceID {
		t.Fatal("无来源锚点的同名异内容上传不得静默合并")
	}
}

func TestMasterLibraryExactContentDeduplicatesAcrossAliases(t *testing.T) {
	store, adventure := masterTestStore(t)
	data := []byte("same-complete-source")
	first, err := store.Ingest(MasterIngestInput{
		Filename: "one.json", Data: data, SourceKind: "user_upload",
		AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("lore", "English")},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Ingest(MasterIngestInput{
		Filename: "renamed.json", Data: data, SourceKind: "user_upload",
		AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("lore", "English")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Source.SourceID != second.Source.SourceID || len(second.Source.Revisions) != 1 {
		t.Fatalf("完全相同原件应复用来源和 revision: %#v %#v", first.Source, second.Source)
	}
}

func TestMasterLibraryInitializesVisibleBookMetadata(t *testing.T) {
	store, adventure := masterTestStore(t)
	if _, err := store.Ingest(MasterIngestInput{
		Filename: "world.json", Data: []byte("metadata-check"), SourceKind: "user_upload",
		AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("lore", "English")},
	}); err != nil {
		t.Fatal(err)
	}
	meta := ReadBookMetaFromDir(store.Workspace())
	if meta.Title != "叙界总资料库" || meta.Author != "Narraverse" {
		t.Fatalf("总库应以可识别的书籍名显示: %#v", meta)
	}
}

func TestMasterItemIDIgnoresMutableSemanticType(t *testing.T) {
	store, adventure := masterTestStore(t)
	first, err := store.Ingest(MasterIngestInput{
		Filename: "world.json", Data: []byte("v1"), SourceAnchor: "knowledge/world", SourceKind: "knowledge_base",
		AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("location", "English")},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Ingest(MasterIngestInput{
		Filename: "world.json", Data: []byte("v2"), SourceAnchor: "knowledge/world", SourceKind: "knowledge_base",
		AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("faction", "English changed")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Source.SourceID != second.Source.SourceID {
		t.Fatal("稳定来源的新 revision 应沿用 source_id")
	}
	if first.Items[0].MasterItemID != second.Items[0].MasterItemID {
		t.Fatal("semantic_type 改变不得改变 master_item_id")
	}
}

func TestMasterTranslationCreatesVersionAndMakesRequiredImportReady(t *testing.T) {
	store, adventure := masterTestStore(t)
	ingested, err := store.Ingest(MasterIngestInput{
		Filename: "world.json", Data: []byte("v1"), SourceAnchor: "knowledge/world", SourceKind: "knowledge_base",
		AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("lore", "Complete English content")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if ingested.Transaction.Status != "pending_translation" || len(ingested.Transaction.TranslationTargets) != 1 {
		t.Fatalf("英文必需字段应等待翻译: %#v", ingested.Transaction)
	}
	target := ingested.Transaction.TranslationTargets[0]
	applied, err := store.ApplyTranslation(MasterTranslationApplyInput{
		ImportID: target.ImportID, MasterItemID: target.MasterItemID, FieldPath: target.FieldPath,
		SourceSHA256: target.SourceSHA256, Translation: "完整的中文内容", Model: "hy-mt", JobID: "job-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !applied.Activated || !applied.Ready || applied.TranslationVersionID == "" {
		t.Fatalf("安全译文应激活并使事务就绪: %#v", applied)
	}
	item, err := store.LoadItem(target.MasterItemID)
	if err != nil {
		t.Fatal(err)
	}
	field := item.Fields[target.FieldPath]
	if field.ActiveText != "完整的中文内容" || field.ActiveTranslationVersionID != applied.TranslationVersionID {
		t.Fatalf("active 字段未指向译本: %#v", field)
	}
}

func TestHighRiskTranslationNeedsConfirmationButKeepsOriginalActive(t *testing.T) {
	store, adventure := masterTestStore(t)
	item := masterTestItem("character", "English body")
	item.Fields = map[string]MasterFieldInput{
		"character.system_prompt": {Text: "Always remain in character.", Risk: masterFieldRiskHigh, Required: true},
	}
	ingested, err := store.Ingest(MasterIngestInput{
		Filename: "card.json", Data: []byte("card"), SourceAnchor: "card/1", SourceKind: "knowledge_base",
		AdventureWorkspace: adventure, Items: []MasterItemInput{item},
	})
	if err != nil {
		t.Fatal(err)
	}
	target := ingested.Transaction.TranslationTargets[0]
	applied, err := store.ApplyTranslation(MasterTranslationApplyInput{
		ImportID: target.ImportID, MasterItemID: target.MasterItemID, FieldPath: target.FieldPath,
		SourceSHA256: target.SourceSHA256, Translation: "始终保持角色身份。", Model: "hy-mt", JobID: "job-2",
	})
	if err != nil {
		t.Fatal(err)
	}
	if applied.Activated {
		t.Fatal("高风险译文未经确认不得激活")
	}
	loaded, err := store.LoadItem(target.MasterItemID)
	if err != nil {
		t.Fatal(err)
	}
	field := loaded.Fields[target.FieldPath]
	if field.ActiveText != "Always remain in character." || field.ActiveKind != "source" {
		t.Fatalf("确认前应继续使用可追溯原文: %#v", field)
	}
}

func TestMasterPolishCandidateDoesNotReplaceActiveTranslation(t *testing.T) {
	store, adventure := masterTestStore(t)
	ingested, err := store.Ingest(MasterIngestInput{
		Filename: "card.json", Data: []byte("polish-source"), SourceKind: "user_upload",
		AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("character", "English body")},
	})
	if err != nil {
		t.Fatal(err)
	}
	target := ingested.Transaction.TranslationTargets[0]
	if _, err := store.ApplyTranslation(MasterTranslationApplyInput{
		ImportID: target.ImportID, MasterItemID: target.MasterItemID, FieldPath: target.FieldPath,
		SourceSHA256: target.SourceSHA256, Translation: "初始译文", Model: "hy-mt", JobID: "base-job",
	}); err != nil {
		t.Fatal(err)
	}

	proposal, err := store.CreateMasterProposal(MasterProposalInput{
		Kind: MasterProposalPolish, ApplyMode: MasterProposalConfirm,
		MasterItemID: target.MasterItemID, FieldPath: target.FieldPath, Translation: "润色后的译文",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ValidateMasterProposal(proposal.ProposalID); err != nil {
		t.Fatal(err)
	}
	candidate, err := store.ApplyMasterProposal(proposal.ProposalID, false)
	if err != nil {
		t.Fatal(err)
	}
	if candidate.Proposal.Status != MasterProposalStatusCandidate || candidate.Translation.Activated {
		t.Fatalf("润色候选不应直接覆盖活动译文: %#v", candidate)
	}
	loaded, err := store.LoadItem(target.MasterItemID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Fields[target.FieldPath].ActiveText != "初始译文" {
		t.Fatalf("候选生成后活动译文被错误覆盖: %#v", loaded.Fields[target.FieldPath])
	}

	applied, err := store.ApplyMasterProposal(proposal.ProposalID, true)
	if err != nil {
		t.Fatal(err)
	}
	if applied.Proposal.Status != MasterProposalStatusApplied || !applied.Translation.Activated || applied.Translation.TranslationVersionID == candidate.Translation.TranslationVersionID {
		t.Fatalf("确认采用应生成并激活新的 Translation Version: %#v", applied)
	}
}
