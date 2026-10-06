package bookideation

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"denova/internal/book"
)

// 本文件把阶段 A 复审（docs/acceptance/BOOK_IDEATION_A_REVIEW_20261006.md）中
// 复现过的四条反例固化为仓内回归，防止再退回去。

func TestScopedItemsRewriteOnlyTouchesItsScope(t *testing.T) {
	service, model, _, _ := newTestService(t, candidateReply)
	ctx := context.Background()
	record := confirmedDraft(t, service)

	edited := *record.Draft.Candidates
	edited.Overview = "USER_EDITED_OVERVIEW"
	edited.KeepSourceEntries = []string{}
	record, err := service.UpdateCandidates(ctx, record.Draft.ID, record.Revision, edited)
	if err != nil {
		t.Fatalf("user edits: %v", err)
	}
	relationsBefore := len(record.Draft.Candidates.Relations)

	model.replies = append(model.replies, `{
	  "title":"UNREQUESTED_TITLE","overview":"UNREQUESTED_OVERVIEW","synopsis":"UNREQUESTED_SYNOPSIS",
	  "items":[{"ref":"c1","name":"第七灯塔","type":"location","load_mode":"manual","content":"TARGET_REWRITE","origin":"ai"}],
	  "relations":[]
	}`)
	got, err := service.Generate(ctx, record.Draft.ID, record.Revision, ScopeItems, []string{"c1"})
	if err != nil {
		t.Fatalf("scoped generate: %v", err)
	}
	pkg := got.Draft.Candidates
	if pkg.Overview != "USER_EDITED_OVERVIEW" {
		t.Fatalf("item rewrite overwrote the overview: %q", pkg.Overview)
	}
	if pkg.Synopsis != edited.Synopsis && pkg.Synopsis == "UNREQUESTED_SYNOPSIS" {
		t.Fatalf("item rewrite overwrote the synopsis")
	}
	if len(pkg.KeepSourceEntries) != 0 {
		t.Fatalf("item rewrite reselected %d cleared source entries", len(pkg.KeepSourceEntries))
	}
	if len(pkg.Relations) != relationsBefore {
		t.Fatalf("item rewrite lost relations: %d -> %d", relationsBefore, len(pkg.Relations))
	}
	rewritten, ok := pkg.CandidateItemByRef("c1")
	if !ok || rewritten.Content != "TARGET_REWRITE" {
		t.Fatalf("requested entry not rewritten: %+v", rewritten)
	}
	if joined := strings.Join(pkg.OpenQuestions, "|"); !strings.Contains(joined, "总览") {
		t.Fatalf("ignored out-of-scope change was silent: %q", joined)
	}
}

// TestScopedItemsRewriteIsARefWhitelist 固化二审唯一剩余项（validate.go 的条目
// 局部重写）：只允许替换本次申请且原包存在的 ref，改名、陌生 ref 与新增条目一律
// 不得进入结果，候选标识保持唯一。
func TestScopedItemsRewriteIsARefWhitelist(t *testing.T) {
	service, model, _, _ := newTestService(t, candidateReply)
	ctx := context.Background()
	record := confirmedDraft(t, service)
	before := len(record.Draft.Candidates.Items)

	model.replies = append(model.replies, `{"items":[
	  {"ref":"c1","name":"第七灯塔","content":"TARGET_REWRITE","origin":"ai"},
	  {"ref":"c2","name":"范围外守灯人改名","content":"OUT_OF_SCOPE_CHANGE","origin":"ai"},
	  {"ref":"c99","name":"未申请新人物","content":"UNREQUESTED_NEW_ITEM","origin":"ai"}
	]}`)
	got, err := service.Generate(ctx, record.Draft.ID, record.Revision, ScopeItems, []string{"c1"})
	if err != nil {
		t.Fatalf("scoped generate: %v", err)
	}
	items := got.Draft.Candidates.Items
	if len(items) != before {
		t.Fatalf("scope=[c1] changed the item set: %d -> %d", before, len(items))
	}
	seenRefs := map[string]int{}
	for _, item := range items {
		seenRefs[item.Ref]++
		if item.Content == "OUT_OF_SCOPE_CHANGE" || item.Content == "UNREQUESTED_NEW_ITEM" {
			t.Fatalf("forbidden out-of-scope item adopted: ref=%s name=%s", item.Ref, item.Name)
		}
	}
	if seenRefs["c1"] != 1 || seenRefs["c2"] != 1 {
		t.Fatalf("candidate ids not unique: %+v", seenRefs)
	}
	// 改写必须原位进行：顺序变化同样是越界改动。
	originalRefs := []string{}
	for _, item := range record.Draft.Candidates.Items {
		originalRefs = append(originalRefs, item.Ref)
	}
	for index, item := range items {
		if item.Ref != originalRefs[index] {
			t.Fatalf("scoped rewrite reordered entries: %v -> %v", originalRefs, refsInOrder(items))
		}
	}
	var rewritten CandidateItem
	found := false
	for _, item := range items {
		if item.Ref == "c1" {
			rewritten, found = item, true
		}
	}
	if !found || rewritten.Content != "TARGET_REWRITE" {
		t.Fatalf("requested entry was not rewritten: %+v", rewritten)
	}
	joined := strings.Join(got.Draft.Candidates.OpenQuestions, "|")
	if !strings.Contains(joined, "不在本次范围内") {
		t.Fatalf("the rejected out-of-scope change was silent: %q", joined)
	}
}

func TestScopedItemsRewriteIgnoresRequestedRefMissingFromOriginal(t *testing.T) {
	service, model, _, _ := newTestService(t, candidateReply)
	ctx := context.Background()
	record := confirmedDraft(t, service)
	originalItems := append([]CandidateItem(nil), record.Draft.Candidates.Items...)

	model.replies = append(model.replies, `{"items":[
	  {"ref":"c99","name":"越界新条目","content":"MUST_NOT_BE_ADDED","origin":"ai"}
	]}`)
	got, err := service.Generate(ctx, record.Draft.ID, record.Revision, ScopeItems, []string{"c99"})
	if err != nil {
		t.Fatalf("scoped generate: %v", err)
	}
	if len(got.Draft.Candidates.Items) != len(originalItems) {
		t.Fatalf("requested ref missing from original changed item count: %d -> %d", len(originalItems), len(got.Draft.Candidates.Items))
	}
	for index, actual := range got.Draft.Candidates.Items {
		want := originalItems[index]
		if actual.Ref != want.Ref || actual.Name != want.Name || actual.Type != want.Type || actual.Content != want.Content ||
			actual.LoadMode != want.LoadMode || actual.CharacterTier != want.CharacterTier || actual.Origin != want.Origin ||
			actual.BriefDescription != want.BriefDescription || actual.OpenNotes != want.OpenNotes ||
			actual.Excluded != want.Excluded || actual.EditedByUser != want.EditedByUser ||
			!slices.Equal(actual.Keywords, want.Keywords) || !slices.Equal(actual.SourceRefs, want.SourceRefs) {
			t.Fatalf("requested ref missing from original changed candidate %s:\n got: %#v\nwant: %#v", want.Ref, actual, want)
		}
	}
	if joined := strings.Join(got.Draft.Candidates.OpenQuestions, "|"); !strings.Contains(joined, "原候选中不存在") {
		t.Fatalf("missing requested ref was not surfaced to the user: %q", joined)
	}
}

func TestScopedItemsRewritePreservesLockedItemsByRef(t *testing.T) {
	for _, tc := range []struct {
		name     string
		excluded bool
		edit     bool
	}{
		{name: "excluded", excluded: true},
		{name: "manually edited", edit: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service, model, _, _ := newTestService(t, candidateReply)
			ctx := context.Background()
			record := confirmedDraft(t, service)
			pkg := *record.Draft.Candidates
			pkg.Items = append([]CandidateItem(nil), pkg.Items...)
			protectedIndex := -1
			for index := range pkg.Items {
				if pkg.Items[index].Ref != "c3" {
					continue
				}
				protectedIndex = index
				pkg.Items[index].Excluded = tc.excluded
				if tc.edit {
					pkg.Items[index].Content = "USER_EDITED_C3"
				}
				break
			}
			if protectedIndex < 0 {
				t.Fatal("fixture did not contain c3")
			}
			record, err := service.UpdateCandidates(ctx, record.Draft.ID, record.Revision, pkg)
			if err != nil {
				t.Fatalf("save protected item: %v", err)
			}
			protected := record.Draft.Candidates.Items[protectedIndex]

			model.replies = append(model.replies, `{"items":[
			  {"ref":"c3","name":"模型改名覆盖","content":"MODEL_OVERRIDE","origin":"ai"}
			]}`)
			got, err := service.Generate(ctx, record.Draft.ID, record.Revision, ScopeItems, []string{"c3"})
			if err != nil {
				t.Fatalf("scoped generate: %v", err)
			}
			var actual CandidateItem
			found := false
			for _, item := range got.Draft.Candidates.Items {
				if item.Ref == "c3" {
					actual, found = item, true
				}
			}
			if !found || actual.Ref != protected.Ref || actual.Name != protected.Name || actual.Type != protected.Type ||
				actual.Content != protected.Content || actual.LoadMode != protected.LoadMode || actual.CharacterTier != protected.CharacterTier ||
				actual.Origin != protected.Origin || actual.BriefDescription != protected.BriefDescription || actual.OpenNotes != protected.OpenNotes ||
				actual.Excluded != protected.Excluded || actual.EditedByUser != protected.EditedByUser ||
				!slices.Equal(actual.Keywords, protected.Keywords) || !slices.Equal(actual.SourceRefs, protected.SourceRefs) {
				t.Fatalf("locked c3 was changed or lost: got=%+v want=%+v", actual, protected)
			}
			if joined := strings.Join(got.Draft.Candidates.OpenQuestions, "|"); !strings.Contains(joined, "已由你编辑或明确排除") {
				t.Fatalf("rejected locked rewrite was not surfaced to the user: %q", joined)
			}
		})
	}
}

func TestScopedRelationsRewriteCannotReplaceItems(t *testing.T) {
	service, model, _, _ := newTestService(t, candidateReply)
	ctx := context.Background()
	record := confirmedDraft(t, service)

	var response map[string]any
	if err := json.Unmarshal([]byte(candidateReply), &response); err != nil {
		t.Fatalf("stub reply must stay JSON: %v", err)
	}
	response["items"].([]any)[0].(map[string]any)["content"] = "UNREQUESTED_ITEM_CHANGE"
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	model.replies = append(model.replies, string(encoded))

	got, err := service.Generate(ctx, record.Draft.ID, record.Revision, ScopeRelation, nil)
	if err != nil {
		t.Fatalf("relations rewrite: %v", err)
	}
	for _, item := range got.Draft.Candidates.Items {
		if strings.Contains(item.Content, "UNREQUESTED_ITEM_CHANGE") {
			t.Fatalf("relations-only call replaced an entry body: %+v", item)
		}
	}
	before := record.Draft.Candidates.Items
	if len(before) != len(got.Draft.Candidates.Items) {
		t.Fatalf("entry set changed: %d -> %d", len(before), len(got.Draft.Candidates.Items))
	}
	for index, item := range before {
		if got.Draft.Candidates.Items[index].Content != item.Content {
			t.Fatalf("entry %s drifted: %q -> %q", item.Name, item.Content, got.Draft.Candidates.Items[index].Content)
		}
	}
}

func TestRemovedSourceIDIsNeverReusedAndOldCitationsLoseProvenance(t *testing.T) {
	service, _, _, _ := newTestService(t, candidateReply)
	ctx := context.Background()
	record := preparedDraft(t, service)
	generated, err := service.Generate(ctx, record.Draft.ID, record.Revision, ScopeAll, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	record = generated
	oldID := record.Draft.Sources[0].ID

	removed, err := service.RemoveSource(ctx, record.Draft.ID, record.Revision, oldID)
	if err != nil {
		t.Fatalf("RemoveSource: %v", err)
	}
	readded, err := service.AddSource(ctx, removed.Draft.ID, removed.Revision, "desert.json",
		[]byte(`{"title":"沙漠王国","content":"【沙漠神殿】\nDESERT_NEW_UNRELATED_SOURCE"}`))
	if err != nil {
		t.Fatalf("AddSource: %v", err)
	}
	if readded.Draft.Sources[0].ID == oldID {
		t.Fatalf("a removed source id was reused: %s", oldID)
	}

	first := readded.Draft.Candidates.Items[0]
	if first.Origin != OriginAI {
		t.Fatalf("the entry still claims source fact after its material was removed: %+v", first)
	}
	if provenance := provenanceFor(first, readded.Draft); provenance != nil {
		t.Fatalf("provenance resolved to another material: %+v", provenance)
	}
	if !strings.Contains(first.OpenNotes, "移除") {
		t.Fatalf("the loss of provenance was not recorded for the user: %+v", first)
	}
	for _, id := range readded.Draft.Candidates.KeepSourceEntries {
		if strings.HasPrefix(id, oldID+"-") {
			t.Fatalf("removed material is still offered for retention: %s", id)
		}
	}
	joined := strings.Join(readded.Draft.Candidates.OpenQuestions, "|")
	if !strings.Contains(joined, "失去原文依据") {
		t.Fatalf("the draft does not surface what must be re-confirmed: %q", joined)
	}
}

func TestCommitReplansStagesWhenNothingHasBeenWrittenYet(t *testing.T) {
	service, _, workspaces, dataDir := newTestService(t, candidateReply)
	ctx := context.Background()
	record := confirmedDraft(t, service)

	// 第一次确认时把关系全部排除：关系阶段应当记为“无需写入”。
	firstContent := *record.Draft.Candidates
	relation := firstContent.Relations[0]
	firstContent.Relations = []CandidateRelation{relation}
	firstContent.Relations[0].Excluded = true
	record, err := service.UpdateCandidates(ctx, record.Draft.ID, record.Revision, firstContent)
	if err != nil {
		t.Fatalf("exclude relations: %v", err)
	}
	workspaces.failNext = errors.New("目录已存在: 同名书")
	if _, err := service.Commit(ctx, record.Draft.ID, record.Revision, "req-replan"); !errors.Is(err, ErrCommitIncomplete) {
		t.Fatalf("expected an incomplete commit, got %v", err)
	}

	// 失败后用户补上关系。此时还没建任何目录，待提交阶段必须以本次确认内容重建。
	current := service.draft(t, record.Draft.ID)
	second := *current.Candidates
	second.Relations = []CandidateRelation{relation}
	updated, err := service.UpdateCandidates(ctx, current.ID, service.revision(t, current.ID), second)
	if err != nil {
		t.Fatalf("re-confirm relation: %v", err)
	}
	receipt, err := service.Commit(ctx, updated.Draft.ID, updated.Revision, "req-replan")
	if err != nil {
		t.Fatalf("retry commit: %v", err)
	}
	if receipt.Status != CommitComplete {
		t.Fatalf("retry receipt: %+v", receipt)
	}
	items, err := book.NewLoreStore(receipt.WorkspacePath).ListAll()
	if err != nil {
		t.Fatalf("ListAll: %v", err)
	}
	written := 0
	for _, item := range items {
		written += len(item.Relations)
	}
	if written != 1 {
		t.Fatalf("receipt says complete but relations written = %d", written)
	}
	if names := bookShelfNames(t, dataDir); len(names) != 1 {
		t.Fatalf("unexpected shelf: %v", names)
	}
}

func TestCommitAfterWorkspaceExistsRejectsFurtherEdits(t *testing.T) {
	service, _, _, _ := newTestService(t, candidateReply, candidateReply)
	ctx := context.Background()
	first := confirmedDraft(t, service)
	receipt, err := service.Commit(ctx, first.Draft.ID, first.Revision, "req-frozen")
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	// 目录已落盘：草稿冻结，编辑与重复创建都必须失败而不是改目标书。
	if _, err := service.UpdateCandidates(ctx, first.Draft.ID, service.revision(t, first.Draft.ID), *first.Draft.Candidates); err == nil {
		t.Fatal("expected edits to be refused after the workspace exists")
	}
	repeat, err := service.Commit(ctx, first.Draft.ID, service.revision(t, first.Draft.ID), "req-other")
	if err != nil {
		t.Fatalf("repeat commit: %v", err)
	}
	if repeat.WorkspacePath != receipt.WorkspacePath {
		t.Fatalf("repeat commit switched target book: %s -> %s", receipt.WorkspacePath, repeat.WorkspacePath)
	}
}

func refsInOrder(items []CandidateItem) []string {
	refs := make([]string, 0, len(items))
	for _, item := range items {
		refs = append(refs, item.Ref)
	}
	return refs
}
