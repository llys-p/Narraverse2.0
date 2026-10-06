package bookideation

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"denova/internal/book"
	"denova/internal/workspacechange"
)

// confirmedDraft runs the ideation chain up to a confirmed candidate package with
// one excluded item, which is the state a commit consumes.
func confirmedDraft(t *testing.T, service *Service) Record {
	t.Helper()
	ctx := context.Background()
	record := preparedDraft(t, service)
	generated, err := service.Generate(ctx, record.Draft.ID, record.Revision, ScopeAll, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	pkg := *generated.Draft.Candidates
	pkg.Items[2].Excluded = true
	pkg.Title = "雾港守灯人"
	saved, err := service.UpdateCandidates(ctx, generated.Draft.ID, generated.Revision, pkg)
	if err != nil {
		t.Fatalf("UpdateCandidates: %v", err)
	}
	return saved
}

func TestCommitWritesBookOverviewItemsAndRelations(t *testing.T) {
	service, _, workspaces, dataDir := newTestService(t, candidateReply)
	ctx := context.Background()
	draft := confirmedDraft(t, service)

	before := bookShelfNames(t, dataDir)
	receipt, err := service.Commit(ctx, draft.Draft.ID, draft.Revision, "req-1")
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if receipt.Status != CommitComplete || workspaces.calls != 1 {
		t.Fatalf("receipt=%s calls=%d", receipt.Status, workspaces.calls)
	}
	if len(bookShelfNames(t, dataDir)) != len(before)+1 {
		t.Fatalf("unexpected shelf: %v", bookShelfNames(t, dataDir))
	}
	workspace := receipt.WorkspacePath
	if workspace == "" {
		t.Fatal("receipt lost the workspace path")
	}

	// Overview lands in the existing per-book document, not a second store.
	changeService, err := workspacechange.ForWorkspace(workspace)
	if err != nil {
		t.Fatalf("ForWorkspace: %v", err)
	}
	content, revision, err := changeService.ReadFile(BookOverviewPath)
	if err != nil {
		t.Fatalf("read overview: %v", err)
	}
	if !strings.Contains(content, "雨港悬疑世界") {
		t.Fatalf("overview content: %q", content)
	}
	if revision != receipt.OverviewRevision {
		t.Fatalf("overview revision mismatch: %s != %s", revision, receipt.OverviewRevision)
	}

	items, err := book.NewLoreStore(workspace).ListAll()
	if err != nil {
		t.Fatalf("ListAll: %v", err)
	}
	byName := map[string]book.LoreItem{}
	for _, item := range items {
		byName[item.Name] = item
	}
	if _, excluded := byName["外乡调查者"]; excluded {
		t.Fatal("an excluded candidate was written into the book")
	}
	lighthouse, ok := byName["第七灯塔"]
	if !ok {
		t.Fatalf("candidate item missing: %v", namesOf(items))
	}
	if lighthouse.LoadMode != book.LoreLoadModeResident || lighthouse.Provenance == nil ||
		lighthouse.Provenance.SourceRecordID != "s0-e0" {
		t.Fatalf("resident/source binding lost: %+v", lighthouse)
	}
	if lighthouse.Importance != "major" {
		t.Fatalf("resident item importance: %s", lighthouse.Importance)
	}
	keeper := byName["守灯人"]
	if keeper.CharacterTier != "major" {
		t.Fatalf("character tier lost: %+v", keeper)
	}
	// The original detailed setting is retained as its own entry, so a summary
	// never replaces the source text.
	retained, ok := byName["锈潮钥"]
	if !ok {
		t.Fatalf("retained original entry missing: %v", namesOf(items))
	}
	if retained.Provenance == nil || retained.Provenance.SourceName != "雾港设定书" {
		t.Fatalf("retained entry lost its source identity: %+v", retained)
	}
	for _, item := range items {
		if strings.Contains(item.Name, "角色设定指令") || strings.Contains(item.Name, "置尾指令") {
			t.Fatalf("card prompt text was written as book fact: %s", item.Name)
		}
	}
	if len(keeper.Relations) != 1 || keeper.Relations[0].TargetID != lighthouse.ID ||
		keeper.Relations[0].Label != "驻守" {
		t.Fatalf("relations not written: %+v", keeper.Relations)
	}
	if len(receipt.ItemIDs) < 3 {
		t.Fatalf("receipt item map: %+v", receipt.ItemIDs)
	}

	// A repeated confirm resumes the finished draft: no second book, no duplicates.
	repeated, err := service.Commit(ctx, draft.Draft.ID, "ignored-revision", "req-1")
	if err != nil {
		t.Fatalf("repeat Commit: %v", err)
	}
	if repeated.Status != CommitComplete || workspaces.calls != 1 {
		t.Fatalf("repeat created another book: status=%s calls=%d", repeated.Status, workspaces.calls)
	}
	if repeated.WorkspacePath != workspace {
		t.Fatalf("repeat pointed at another workspace: %s", repeated.WorkspacePath)
	}
	afterRepeat, err := book.NewLoreStore(workspace).ListAll()
	if err != nil {
		t.Fatalf("ListAll after repeat: %v", err)
	}
	if len(afterRepeat) != len(items) {
		t.Fatalf("repeat duplicated entries: %d -> %d", len(items), len(afterRepeat))
	}
	for _, name := range []string{"第七灯塔", "守灯人", "锈潮钥"} {
		if count := countByName(afterRepeat, name); count != 1 {
			t.Fatalf("%s written %d times", name, count)
		}
	}
	committed := service.draft(t, draft.Draft.ID)
	if committed.Status != StatusCommitted {
		t.Fatalf("draft status: %s", committed.Status)
	}
	// The frozen draft no longer accepts edits or regeneration.
	if _, err := service.Generate(ctx, draft.Draft.ID, "ignored", ScopeAll, nil); err == nil {
		t.Fatal("expected a committed draft to refuse regeneration")
	}
}

// TestCommitResumesFromAFailedStage drives the interrupted case: the book stage
// recorded a workspace that is not usable yet, so the overview stage stopped.
// Retrying has to continue that same book instead of creating another one.
func TestCommitResumesFromAFailedStage(t *testing.T) {
	service, _, workspaces, dataDir := newTestService(t, candidateReply)
	ctx := context.Background()
	draft := confirmedDraft(t, service)
	workspaces.incompleteWorkspace = true

	receipt, err := service.Commit(ctx, draft.Draft.ID, draft.Revision, "req-interrupted")
	if err == nil {
		t.Fatal("expected the interrupted commit to fail")
	}
	if !errors.Is(err, ErrCommitIncomplete) {
		t.Fatalf("expected ErrCommitIncomplete, got %v", err)
	}
	if receipt.Status != CommitIncomplete {
		t.Fatalf("receipt status: %s", receipt.Status)
	}
	if statusOf(receipt.Stages, StageBook) != StageDone {
		t.Fatalf("book stage not recorded: %+v", receipt.Stages)
	}
	if statusOf(receipt.Stages, StageOverview) == StageDone {
		t.Fatal("overview stage reported done although the workspace was unusable")
	}
	if strings.TrimSpace(receipt.WorkspacePath) == "" {
		t.Fatal("the interrupted receipt lost its target book")
	}
	if names := bookShelfNames(t, dataDir); len(names) != 1 {
		t.Fatalf("shelf after the interruption: %v", names)
	}

	// Recovery: the same recorded path becomes a real workspace, and the retry
	// finishes it without another create call.
	target := receipt.WorkspacePath
	if err := os.Remove(target); err != nil {
		t.Fatalf("remove placeholder: %v", err)
	}
	if err := book.NewState(target).InitWorkspace(); err != nil {
		t.Fatalf("InitWorkspace: %v", err)
	}
	workspaces.incompleteWorkspace = false
	resumed, err := service.Commit(ctx, draft.Draft.ID, "ignored-revision", "req-interrupted")
	if err != nil {
		t.Fatalf("resumed Commit: %v", err)
	}
	if resumed.Status != CommitComplete {
		t.Fatalf("resumed status: %s", resumed.Status)
	}
	if workspaces.calls != 1 {
		t.Fatalf("resume created a second book: calls=%d", workspaces.calls)
	}
	if resumed.WorkspacePath != target {
		t.Fatalf("resume switched target: %s != %s", resumed.WorkspacePath, target)
	}
	items, err := book.NewLoreStore(resumed.WorkspacePath).ListAll()
	if err != nil || len(items) == 0 {
		t.Fatalf("resumed commit wrote nothing: %d items, %v", len(items), err)
	}
	if _, err := os.Stat(filepath.Join(target, "setting", "book-overview.md")); err != nil {
		t.Fatalf("resumed commit has no overview: %v", err)
	}
}

func TestCommitRefusesWithoutConfirmedCandidates(t *testing.T) {
	service, _, workspaces, dataDir := newTestService(t)
	ctx := context.Background()
	record := mustCreateDraft(t, service)
	if _, err := service.Commit(ctx, record.Draft.ID, record.Revision, "req-empty"); err == nil {
		t.Fatal("expected an empty draft to refuse creation")
	}
	if workspaces.calls != 0 || len(bookShelfNames(t, dataDir)) != 0 {
		t.Fatalf("an unconfirmed draft created a book: calls=%d", workspaces.calls)
	}
}

// TestCommitTitleConflictKeepsDraftEditable proves a same-named book is an
// actionable validation problem, not a leaked path, and that the draft can be
// retitled and committed because nothing was written yet.
func TestCommitTitleConflictKeepsDraftEditable(t *testing.T) {
	service, _, _, dataDir := newTestService(t, candidateReply, candidateReply)
	ctx := context.Background()

	first := confirmedDraft(t, service)
	if _, err := service.Commit(ctx, first.Draft.ID, first.Revision, "req-a"); err != nil {
		t.Fatalf("first commit: %v", err)
	}
	second := confirmedDraft(t, service)
	if second.Draft.ID == first.Draft.ID {
		t.Fatal("two drafts share an id")
	}
	_, err := service.Commit(ctx, second.Draft.ID, second.Revision, "req-b")
	if err == nil {
		t.Fatal("expected the same title to conflict with the existing book")
	}
	var validation *ValidationError
	if !errors.As(err, &validation) || validation.Field != "title" {
		t.Fatalf("expected a title validation error, got %T %v", err, err)
	}
	if !strings.Contains(err.Error(), "已有同名书籍") || strings.Contains(err.Error(), dataDir) {
		t.Fatalf("conflict message: %v", err)
	}
	if names := bookShelfNames(t, dataDir); len(names) != 1 {
		t.Fatalf("the conflicting attempt still created a book: %v", names)
	}

	renamed := "锈潮之下"
	updated, err := service.UpdateDraft(ctx, second.Draft.ID, service.revision(t, second.Draft.ID), DraftPatch{Title: &renamed})
	if err != nil {
		t.Fatalf("retitling a not-yet-written draft must stay possible: %v", err)
	}
	// Nothing was written yet, so the preview stays editable: excluding an entry
	// after a stopped attempt must not be refused.
	pkg := *updated.Draft.Candidates
	pkg.Items[1].Excluded = true
	if _, err := service.UpdateCandidates(ctx, second.Draft.ID, updated.Revision, pkg); err != nil {
		t.Fatalf("editing candidates after a pre-creation failure: %v", err)
	}
	receipt, err := service.Commit(ctx, second.Draft.ID, service.revision(t, second.Draft.ID), "req-b")
	if err != nil {
		t.Fatalf("retry after retitling: %v", err)
	}
	if receipt.Status != CommitComplete || receipt.Title != renamed {
		t.Fatalf("retry receipt: %+v", receipt)
	}
	items, err := book.NewLoreStore(receipt.WorkspacePath).ListAll()
	if err != nil {
		t.Fatalf("ListAll: %v", err)
	}
	for _, item := range items {
		if item.Name == "守灯人" && item.Type == "character" {
			t.Fatalf("the candidate excluded before the retry was still written: %+v", item)
		}
	}
	if names := bookShelfNames(t, dataDir); len(names) != 2 {
		t.Fatalf("shelf: %v", names)
	}
}

func statusOf(stages []CommitStage, name string) string {
	for _, stage := range stages {
		if stage.Name == name {
			return stage.Status
		}
	}
	return ""
}

func namesOf(items []book.LoreItem) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.Name)
	}
	return out
}

func countByName(items []book.LoreItem, name string) int {
	count := 0
	for _, item := range items {
		if item.Name == name {
			count++
		}
	}
	return count
}
