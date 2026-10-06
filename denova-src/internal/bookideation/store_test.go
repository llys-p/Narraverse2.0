package bookideation

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"denova/internal/book"
)

// fakeModel is the fixed upstream stub: it returns canned completions and
// records every request so tests can assert what the ideation chain asked for.
type fakeModel struct {
	replies  []string
	err      error
	requests []ModelRequest
}

func (f *fakeModel) Generate(_ context.Context, request ModelRequest) (ModelReply, error) {
	f.requests = append(f.requests, request)
	if f.err != nil {
		err := f.err
		f.err = nil
		return ModelReply{}, err
	}
	if len(f.replies) == 0 {
		return ModelReply{}, errors.New("stub 没有更多回复")
	}
	reply := f.replies[0]
	f.replies = f.replies[1:]
	return ModelReply{Content: reply, Model: "stub-model", Profile: "stub"}, nil
}

func (f *fakeModel) callCount() int { return len(f.requests) }

// fakeWorkspaces stands in for the detached book creator so commit tests exercise
// the real workspace-change and lore paths without touching the app runtime.
// incompleteWorkspace simulates an interrupted creation that recorded a target
// path which is not a usable workspace yet.
type fakeWorkspaces struct {
	calls               int
	failNext            error
	incompleteWorkspace bool
}

func (f *fakeWorkspaces) CreateBookDetached(_ context.Context, parentDir, title, _, _ string) (string, error) {
	f.calls++
	if f.failNext != nil {
		err := f.failNext
		f.failNext = nil
		return "", err
	}
	dir := filepath.Join(parentDir, title)
	if f.incompleteWorkspace {
		if err := os.WriteFile(dir, []byte("interrupted"), 0o644); err != nil {
			return "", err
		}
		return dir, nil
	}
	if _, err := os.Stat(dir); err == nil {
		return "", fmt.Errorf("目录已存在: %s", dir)
	}
	if err := book.NewState(dir).InitWorkspace(); err != nil {
		return "", err
	}
	return dir, nil
}

func newTestService(t *testing.T, replies ...string) (*Service, *fakeModel, *fakeWorkspaces, string) {
	t.Helper()
	dataDir := t.TempDir()
	store, err := NewStore(dataDir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	model := &fakeModel{replies: replies}
	workspaces := &fakeWorkspaces{}
	projects := filepath.Join(dataDir, "projects")
	if err := os.MkdirAll(projects, 0o755); err != nil {
		t.Fatalf("mkdir projects: %v", err)
	}
	return NewService(store, model, workspaces, projects), model, workspaces, dataDir
}

func (s *Service) draft(t *testing.T, id string) Draft {
	t.Helper()
	record, err := s.Get(context.Background(), id)
	if err != nil {
		t.Fatalf("get draft %s: %v", id, err)
	}
	return record.Draft
}

func (s *Service) revision(t *testing.T, id string) string {
	t.Helper()
	record, err := s.Get(context.Background(), id)
	if err != nil {
		t.Fatalf("get draft %s: %v", id, err)
	}
	return record.Revision
}

func lorebookSource() string {
	return `{
	  "title": "雾港设定书",
	  "content": "【第七灯塔】\n位于雾港北岬的石塔，灯语以三短一长为安全信号。\n【锈潮钥】\n开启旧港区水闸的钥匙，离开灯塔即失效。\n【守灯人】\n世袭职位，不得兼任港务。"
	}`
}

func characterCard() string {
	return `{
	  "spec": "chara_card_v2",
	  "spec_version": "2.0",
	  "data": {
	    "name": "守灯人",
	    "description": "四十岁，左耳失聪，负责第七灯塔。",
	    "personality": "寡言，重承诺。",
	    "first_mes": "灯还没点亮。你是今晚第三个上塔的人。",
	    "alternate_greetings": ["你又回来了。钥匙还在你手里。"],
	    "mes_example": "玩家：灯塔为何要三短一长？\n守灯人：那是安全信号。",
	    "system_prompt": "你是守灯人，不得替玩家发言。",
	    "post_history_instructions": "始终使用中文。",
	    "tags": ["雾港", "配角"]
	  }
	}`
}

const candidateReply = `{
	  "title": "雾港守灯人",
	  "book_name_suggestions": ["雾港守灯人", "第七灯塔", "锈潮之下"],
	  "synopsis": "外乡人调查灯塔失踪案。",
	  "overview": "# 雾港\n雨港悬疑世界。",
	  "items": [
	    {"ref": "c1", "name": "第七灯塔", "type": "location", "load_mode": "resident",
	     "content": "位于雾港北岬的石塔，灯语以三短一长为安全信号。", "keywords": ["灯塔"],
	     "origin": "source", "source_refs": ["s0-e0"]},
	    {"ref": "c2", "name": "守灯人", "type": "character", "load_mode": "manual",
	     "content": "世袭职位，不得兼任港务。", "character_tier": "major",
	     "origin": "source", "source_refs": ["s0-e2"]},
	    {"ref": "c3", "name": "外乡调查者", "type": "character", "load_mode": "manual",
	     "content": "自称受托而来，身份未经证实。", "origin": "source", "source_refs": ["s9-zz"]}
	  ],
	  "relations": [
	    {"ref": "r1", "source_ref": "c2", "target_ref": "c1", "label": "驻守", "origin": "source", "source_refs": ["s0-e2"]},
	    {"ref": "r2", "source_ref": "c3", "target_ref": "c9", "label": "寻找", "origin": "ai"}
	  ],
	  "open_questions": ["失踪案时间线原件未说明"]
	}`

func mustCreateDraft(t *testing.T, service *Service) Record {
	t.Helper()
	record, err := service.CreateDraft(context.Background(), "外乡人调查灯塔失踪案", "zh-CN")
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	return record
}

func TestStoreCASRejectsStaleWrite(t *testing.T) {
	service, _, _, _ := newTestService(t)
	ctx := context.Background()
	record := mustCreateDraft(t, service)

	idea := "第一版想法"
	if _, err := service.UpdateDraft(ctx, record.Draft.ID, record.Revision, DraftPatch{Idea: &idea}); err != nil {
		t.Fatalf("first update: %v", err)
	}
	if _, err := service.UpdateDraft(ctx, record.Draft.ID, record.Revision, DraftPatch{Idea: strPtr("旧视图写入")}); err == nil {
		t.Fatal("expected conflict when writing with a stale revision")
	} else {
		var conflict *ConflictError
		if !errors.As(err, &conflict) {
			t.Fatalf("expected *ConflictError, got %T %v", err, err)
		}
	}
	if got := service.draft(t, record.Draft.ID).Idea; got != idea {
		t.Fatalf("stale write changed the draft: %q", got)
	}
}

func TestDraftsLiveOutsideTheBookshelf(t *testing.T) {
	service, _, workspaces, dataDir := newTestService(t)
	record := mustCreateDraft(t, service)
	ctx := context.Background()
	if _, err := service.AddSource(ctx, record.Draft.ID, record.Revision, "fog harbour.json", []byte(lorebookSource())); err != nil {
		t.Fatalf("AddSource: %v", err)
	}
	if _, err := service.SendMessage(ctx, record.Draft.ID, service.revision(t, record.Draft.ID), "偏悬疑，少战斗"); err == nil {
		t.Fatal("expected the stub model without a queued reply to fail")
	} else if !errors.Is(err, ErrModelUnavailable) {
		t.Fatalf("expected ErrModelUnavailable, got %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(dataDir, "projects"))
	if err != nil {
		t.Fatalf("read projects: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("ideation created a book before confirmation: %v", entries)
	}
	if workspaces.calls != 0 {
		t.Fatalf("creator called before confirm: %d", workspaces.calls)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "book-ideation", "drafts", record.Draft.ID+".json")); err != nil {
		t.Fatalf("draft not persisted for refresh recovery: %v", err)
	}
}

func TestRefreshRecoversDraft(t *testing.T) {
	service, _, _, dataDir := newTestService(t)
	record := mustCreateDraft(t, service)
	ctx := context.Background()
	withSource, err := service.AddSource(ctx, record.Draft.ID, record.Revision, "card.json", []byte(characterCard()))
	if err != nil {
		t.Fatalf("AddSource: %v", err)
	}
	reopened, err := NewStore(dataDir)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	recovered, err := NewService(reopened, &fakeModel{}, &fakeWorkspaces{}, dataDir).Get(ctx, record.Draft.ID)
	if err != nil {
		t.Fatalf("recovered read: %v", err)
	}
	if recovered.Revision != withSource.Revision {
		t.Fatalf("recovered revision mismatch: %s != %s", recovered.Revision, withSource.Revision)
	}
	if len(recovered.Draft.Sources) != 1 || recovered.Draft.Sources[0].Name != "守灯人" {
		t.Fatalf("recovered sources: %+v", recovered.Draft.Sources)
	}
}

func TestSourceIntakeKeepsOriginalMaterialDistinct(t *testing.T) {
	service, _, _, _ := newTestService(t)
	ctx := context.Background()
	record := mustCreateDraft(t, service)
	withBook, err := service.AddSource(ctx, record.Draft.ID, record.Revision, "fog.json", []byte(lorebookSource()))
	if err != nil {
		t.Fatalf("AddSource lorebook: %v", err)
	}
	withCard, err := service.AddSource(ctx, withBook.Draft.ID, withBook.Revision, "keeper.json", []byte(characterCard()))
	if err != nil {
		t.Fatalf("AddSource card: %v", err)
	}
	sources := withCard.Draft.Sources
	if len(sources) != 2 {
		t.Fatalf("want 2 sources, got %d", len(sources))
	}
	if sources[0].Kind != KindLorebook || sources[0].Name != "雾港设定书" {
		t.Fatalf("lorebook source: %+v", sources[0])
	}
	if len(sources[0].Entries) != 3 || sources[0].Entries[0].Name != "第七灯塔" {
		t.Fatalf("lorebook entries: %+v", sources[0].Entries)
	}
	if !strings.Contains(sources[0].Entries[0].Content, "三短一长") {
		t.Fatalf("entry content was rewritten: %q", sources[0].Entries[0].Content)
	}
	card := sources[1]
	if card.Kind != KindCharacterCard {
		t.Fatalf("card kind: %s", card.Kind)
	}
	byRole := map[string][]string{}
	for _, entry := range card.Entries {
		byRole[entry.Role] = append(byRole[entry.Role], entry.Content)
	}
	joined := func(role string) string { return strings.Join(byRole[role], "|") }
	if !strings.Contains(joined(RoleOpening), "今晚第三个上塔的人") || !strings.Contains(joined(RoleOpening), "你又回来了") {
		t.Fatalf("card opening lines lost: %+v", card.Entries)
	}
	if !strings.Contains(joined(RoleDialogue), "三短一长") {
		t.Fatalf("example dialogue lost: %+v", card.Entries)
	}
	if !strings.Contains(joined(RoleProfile), "四十岁") || !strings.Contains(joined(RoleProfile), "寡言") {
		t.Fatalf("card profile fields lost: %+v", card.Entries)
	}
	if !strings.Contains(joined(RolePrompt), "不得替玩家发言") {
		t.Fatalf("prompt-shaped text was dropped instead of kept as source: %+v", card.Entries)
	}
	if _, err := service.AddSource(ctx, record.Draft.ID, withCard.Revision, "keeper-copy.json", []byte(characterCard())); err == nil {
		t.Fatal("expected the same source version to be rejected")
	}
}

func TestSendMessagePersistsUserTurnWhenModelFails(t *testing.T) {
	service, model, _, _ := newTestService(t)
	ctx := context.Background()
	record := mustCreateDraft(t, service)
	model.err = errors.New("upstream 401")
	updated, err := service.SendMessage(ctx, record.Draft.ID, record.Revision, "先定基调：克制冷峻")
	if !errors.Is(err, ErrModelUnavailable) {
		t.Fatalf("expected ErrModelUnavailable, got %v", err)
	}
	if len(updated.Draft.Turns) != 1 || updated.Draft.Turns[0].Role != "user" {
		t.Fatalf("user turn was not stored: %+v", updated.Draft.Turns)
	}
}

func TestSendMessageRecordsDirectionFromModel(t *testing.T) {
	reply := `{"reply":"建议 A：调查为主线。","direction":{"summary":"雨港悬疑，调查为主线","genre":"悬疑","tone":"冷峻","conflict":"灯塔失踪案","cast":["守灯人"]},"open_questions":["锈潮钥的归属未说明"]}`
	service, model, _, _ := newTestService(t, reply)
	ctx := context.Background()
	record := mustCreateDraft(t, service)
	updated, err := service.SendMessage(ctx, record.Draft.ID, record.Revision, "偏悬疑，少战斗")
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if model.callCount() != 1 {
		t.Fatalf("model calls: %d", model.callCount())
	}
	if !strings.Contains(model.requests[0].Messages[len(model.requests[0].Messages)-1].Content, "偏悬疑") {
		t.Fatalf("latest turn missing from the model request")
	}
	if updated.Draft.Direction.Summary == "" || len(updated.Draft.Direction.Cast) != 1 {
		t.Fatalf("direction not recorded: %+v", updated.Draft.Direction)
	}
	if updated.Draft.Direction.UpdatedBy != "agent" {
		t.Fatalf("direction author: %s", updated.Draft.Direction.UpdatedBy)
	}
	if len(updated.Draft.Turns) != 2 || updated.Draft.Turns[1].Role != "assistant" {
		t.Fatalf("turns: %+v", updated.Draft.Turns)
	}
}

func strPtr(value string) *string { return &value }
