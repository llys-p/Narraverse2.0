package bookideation

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func preparedDraft(t *testing.T, service *Service) Record {
	t.Helper()
	ctx := context.Background()
	record := mustCreateDraft(t, service)
	withBook, err := service.AddSource(ctx, record.Draft.ID, record.Revision, "fog.json", []byte(lorebookSource()))
	if err != nil {
		t.Fatalf("AddSource: %v", err)
	}
	withCard, err := service.AddSource(ctx, withBook.Draft.ID, withBook.Revision, "keeper.json", []byte(characterCard()))
	if err != nil {
		t.Fatalf("AddSource card: %v", err)
	}
	return withCard
}

func TestGenerateBuildsCandidatePackageWithoutWritingABook(t *testing.T) {
	service, model, workspaces, dataDir := newTestService(t, candidateReply)
	ctx := context.Background()
	record := preparedDraft(t, service)
	before := bookShelfNames(t, dataDir)

	generated, err := service.Generate(ctx, record.Draft.ID, record.Revision, ScopeAll, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	pkg := generated.Draft.Candidates
	if pkg == nil {
		t.Fatal("no candidate package stored")
	}
	if len(pkg.Items) != 3 || len(pkg.Relations) != 1 {
		t.Fatalf("items=%d relations=%d", len(pkg.Items), len(pkg.Relations))
	}
	if workspaces.calls != 0 || len(bookShelfNames(t, dataDir)) != len(before) {
		t.Fatalf("generation wrote a book: calls=%d", workspaces.calls)
	}
	if model.callCount() != 1 {
		t.Fatalf("want one model call, got %d", model.callCount())
	}
	prompt := model.requests[0].Messages[0].Content
	if !strings.Contains(prompt, "s0-e0") || !strings.Contains(prompt, "【来源资料】") {
		t.Fatalf("prompt lost source citations: %s", firstRunes(prompt, 400))
	}
	if !strings.Contains(prompt, "origin") || !strings.Contains(prompt, "open_questions") {
		t.Fatalf("prompt lost the origin/JSON contract: %s", firstRunes(prompt, 400))
	}

	// An item that claimed to be a source fact but cited a missing fragment is
	// re-labelled as an AI proposal instead of being trusted.
	third := pkg.Items[2]
	if third.Origin != OriginAI || !strings.Contains(third.OpenNotes, "来源依据未命中") {
		t.Fatalf("uncited item kept source origin: %+v", third)
	}
	// A relation pointing at a non-existent item is dropped and reported.
	if pkg.Relations[0].Ref != "r1" {
		t.Fatalf("relation set: %+v", pkg.Relations)
	}
	joined := strings.Join(pkg.OpenQuestions, "|")
	if !strings.Contains(joined, "关系") || !strings.Contains(joined, "失踪案时间线") {
		t.Fatalf("open questions lost model gaps: %q", joined)
	}
	if len(pkg.KeepSourceEntries) == 0 {
		t.Fatal("original entries were not offered for retention")
	}
	promptEntries := map[string]bool{}
	for _, source := range generated.Draft.Sources {
		for _, entry := range source.Entries {
			if entry.Role == RolePrompt {
				promptEntries[entry.ID] = true
			}
		}
	}
	for _, id := range pkg.KeepSourceEntries {
		if promptEntries[id] {
			t.Fatalf("prompt-shaped card text offered for retention: %s", id)
		}
	}
}

func TestGenerateRejectsStaleReplyInsteadOfOverwritingEdits(t *testing.T) {
	service, _, _, _ := newTestService(t, candidateReply, candidateReply)
	ctx := context.Background()
	record := preparedDraft(t, service)

	staleBase := record.Revision
	idea := "用户在你生成时改了方向"
	if _, err := service.UpdateDraft(ctx, record.Draft.ID, record.Revision, DraftPatch{Idea: &idea}); err != nil {
		t.Fatalf("user edit: %v", err)
	}
	_, err := service.Generate(ctx, record.Draft.ID, staleBase, ScopeAll, nil)
	if err == nil {
		t.Fatal("expected the late generation to be rejected")
	}
	var stale *StaleGenerationError
	if !errors.As(err, &stale) {
		t.Fatalf("expected *StaleGenerationError, got %T %v", err, err)
	}
	if draft := service.draft(t, record.Draft.ID); draft.Candidates != nil {
		t.Fatal("stale generation overwrote the draft")
	}
}

func TestScopedRegenerationKeepsUserEdits(t *testing.T) {
	service, _, _, _ := newTestService(t, candidateReply, `{
	  "overview": "# 雾港（重写）\n更冷的调查基调。",
	  "items": [
	    {"ref": "c1", "name": "第七灯塔", "type": "location", "load_mode": "resident",
	     "content": "重写后的灯塔设定。", "origin": "source", "source_refs": ["s0-e0"]},
	    {"ref": "c9", "name": "旧港区水闸", "type": "location", "load_mode": "manual",
	     "content": "锈潮钥开启的水闸。", "origin": "source", "source_refs": ["s0-e1"]}
	  ],
	  "relations": []
	}`)
	ctx := context.Background()
	record := preparedDraft(t, service)
	generated, err := service.Generate(ctx, record.Draft.ID, record.Revision, ScopeAll, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}

	edited := generated.Draft.Candidates.Items
	edited[1].Content = "用户亲手写下的守灯人设定，不得被生成覆盖。"
	edited[1].EditedByUser = true
	saved, err := service.UpdateCandidates(ctx, generated.Draft.ID, generated.Revision, *generated.Draft.Candidates)
	if err != nil {
		t.Fatalf("UpdateCandidates: %v", err)
	}
	if !saved.Draft.Candidates.Items[1].EditedByUser {
		t.Fatalf("manual edit was not flagged: %+v", saved.Draft.Candidates.Items[1])
	}

	rewritten, err := service.Generate(ctx, saved.Draft.ID, saved.Revision, ScopeItems, []string{"c1"})
	if err != nil {
		t.Fatalf("scoped Generate: %v", err)
	}
	pkg := rewritten.Draft.Candidates
	byName := map[string]CandidateItem{}
	for _, item := range pkg.Items {
		byName[item.Name] = item
	}
	if byName["第七灯塔"].Content != "重写后的灯塔设定。" {
		t.Fatalf("scoped rewrite missed its target: %+v", byName["第七灯塔"])
	}
	userItem, ok := byName["守灯人"]
	if !ok {
		t.Fatalf("scoped rewrite dropped the user-edited item: %+v", pkg.Items)
	}
	if !strings.Contains(userItem.Content, "不得被生成覆盖") || !userItem.EditedByUser {
		t.Fatalf("scoped rewrite overwrote the manual edit: %+v", userItem)
	}
	// 局部重写是 ref 白名单：模型顺手新增的条目不得进入结果（二审收紧的边界）。
	if _, added := byName["旧港区水闸"]; added {
		t.Fatalf("scoped rewrite appended an unrequested entry: %+v", pkg.Items)
	}
	if len(pkg.Items) != len(saved.Draft.Candidates.Items) {
		t.Fatalf("scoped rewrite changed the item set: %d -> %d", len(saved.Draft.Candidates.Items), len(pkg.Items))
	}
	if !strings.Contains(strings.Join(pkg.OpenQuestions, "|"), "不在本次范围内") {
		t.Fatalf("the rejected addition was silent: %v", pkg.OpenQuestions)
	}
	if pkg.Revision <= saved.Draft.Candidates.Revision {
		t.Fatalf("package revision did not advance: %d -> %d", saved.Draft.Candidates.Revision, pkg.Revision)
	}
}

func TestUpdateCandidatesValidatesPreview(t *testing.T) {
	service, _, _, _ := newTestService(t, candidateReply)
	ctx := context.Background()
	record := preparedDraft(t, service)
	generated, err := service.Generate(ctx, record.Draft.ID, record.Revision, ScopeAll, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	pkg := *generated.Draft.Candidates
	pkg.Overview = "  "
	if _, err := service.UpdateCandidates(ctx, generated.Draft.ID, generated.Revision, pkg); err == nil {
		t.Fatal("expected an empty overview to be rejected")
	}

	pkg = *generated.Draft.Candidates
	pkg.Items = append(pkg.Items, pkg.Items[0])
	if _, err := service.UpdateCandidates(ctx, generated.Draft.ID, generated.Revision, pkg); err == nil {
		t.Fatal("expected a duplicate item name to be rejected")
	}

	pkg = *generated.Draft.Candidates
	pkg.Items[0].Content = "用户改写的灯塔设定。"
	pkg.Relations = append(pkg.Relations, CandidateRelation{SourceRef: "c1", TargetRef: "missing", Label: "无效"})
	if _, err := service.UpdateCandidates(ctx, generated.Draft.ID, generated.Revision, pkg); err == nil {
		t.Fatal("expected a relation to a missing item to be rejected")
	}
}

func TestCandidateJSONToleratesFencedReplies(t *testing.T) {
	service, _, _, _ := newTestService(t, "```json\n"+candidateReply+"\n```")
	ctx := context.Background()
	record := preparedDraft(t, service)
	generated, err := service.Generate(ctx, record.Draft.ID, record.Revision, ScopeAll, nil)
	if err != nil {
		t.Fatalf("fenced reply should still parse: %v", err)
	}
	if len(generated.Draft.Candidates.Items) != 3 {
		t.Fatalf("items: %d", len(generated.Draft.Candidates.Items))
	}
}

func TestGeneratePromptReportsWhatWasNotRead(t *testing.T) {
	service, model, _, _ := newTestService(t, candidateReply)
	ctx := context.Background()
	record := preparedDraft(t, service)
	if _, err := service.Generate(ctx, record.Draft.ID, record.Revision, ScopeAll, nil); err != nil {
		t.Fatalf("Generate: %v", err)
	}
	prompt := model.requests[0].Messages[0].Content
	if !strings.Contains(prompt, "【来源资料】共纳入") {
		t.Fatalf("prompt hides what was read: %s", firstRunes(prompt, 300))
	}
	if !strings.Contains(prompt, "origin") {
		t.Fatalf("prompt lost the origin contract")
	}
	encoded, err := json.Marshal(model.requests[0].SystemPrompt)
	if err != nil || len(encoded) == 0 {
		t.Fatalf("system prompt missing: %v", err)
	}
}

func bookShelfNames(t *testing.T, dataDir string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(dataDir, "projects"))
	if err != nil {
		t.Fatalf("read projects: %v", err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

func firstRunes(value string, count int) string {
	runes := []rune(value)
	if len(runes) <= count {
		return value
	}
	return string(runes[:count])
}
