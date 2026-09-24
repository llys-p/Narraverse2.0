package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"denova/config"
	"denova/internal/agent"
	"denova/internal/book"
	"denova/internal/interactive"
	"denova/internal/library"
	"denova/internal/libraryruntime"
	"denova/internal/prompts"
)

// B3a：游戏链 library 背景的 bind-before-start 验证（L3 计划 §8.1–§8.6）。
// 证据链：真实 App + 真实库文件走完 绑定→装配→按需读取→幂等释放，正文只出现在
// 装配返回值；regenerate 以服务端记录的绑定元数据复用原 revision，不依赖客户端重发；
// 冲突/漂移显式错误事件；conversation 与导演侧旧 Lore 通道在 library/none 模式全关。

// interactiveLibraryFixture 构造带真实库文件与旧 lore 资料的最小游戏 App。
func interactiveLibraryFixture(t *testing.T) (*App, library.Library, string, string) {
	t.Helper()
	root := t.TempDir()
	workspace := filepath.Join(root, "projects", "test-story")
	cfg := &config.Config{}
	cfg.SetDataDir(root)
	a := &App{cfg: cfg, workspace: workspace, bookService: book.NewService(workspace)}
	ctx := context.Background()
	l, _, err := a.CreateWorkLibrary(ctx, library.CreateInput{Name: "游戏绑定测试库"})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []library.ItemInput{
		{ID: "item-resident", Name: "常驻一", Type: "character", Origin: "original", LoadMode: "resident", Content: strPtrItem("游戏常驻正文")},
		{ID: "item-manual-1", Name: "手动一", Type: "character", Origin: "original", LoadMode: "manual", Content: strPtrItem("游戏手动正文")},
		{ID: "item-manual-2", Name: "手动二", Type: "character", Origin: "original", LoadMode: "manual", Content: strPtrItem("未授权正文")},
	} {
		if _, _, err := a.CreateWorkLibraryItem(ctx, l.ID, item); err != nil {
			t.Fatal(err)
		}
	}
	_, revision, err := a.GetWorkLibrary(ctx, l.ID)
	if err != nil {
		t.Fatal(err)
	}
	libraryPath := filepath.Join(root, "libraries", "library-"+l.ID+".json")
	before, err := os.ReadFile(libraryPath)
	if err != nil {
		t.Fatal(err)
	}
	return a, l, revision, string(before)
}

// interactiveGameRegistry 构造最小 WorldContextService，用于派生服务端 run 身份。
func interactiveGameRegistry(t *testing.T) (*WorldContextService, interactiveTaskRunBinding, string) {
	t.Helper()
	svc := &WorldContextService{interactiveRuns: newInteractiveRunRegistry(interactiveRunRegistryConfig{})}
	binding, err := svc.prepareInteractiveTaskRun("story-1", "main", "", "task-game-"+strings.ReplaceAll(t.Name(), "/", "-"))
	if err != nil {
		t.Fatal(err)
	}
	record, ok := svc.interactiveRuns.snapshot(binding.runID)
	if !ok || record.scopeKey == "" {
		t.Fatal("interactive run must expose a server-derived scopeKey")
	}
	return svc, binding, record.scopeKey
}

// 1) 新回合 bind-before-start：consumer=game、scopeKey 服务端派生、装配只含获准
// 内容、幂等释放、库文件零写入。
func TestResolveInteractiveLibraryRunFullChain(t *testing.T) {
	a, l, revision, beforeLibrary := interactiveLibraryFixture(t)
	svc, binding, scopeKey := interactiveGameRegistry(t)
	ctx := context.Background()

	run, err := resolveInteractiveLibraryRun(ctx, a, scopeKey, InteractiveLibraryControl{
		LibraryID: l.ID, ExpectedRevision: revision, ManualItemIDs: []string{"item-manual-1"},
	})
	if err != nil || run == nil {
		t.Fatalf("bind+assemble failed: run=%v err=%v", run, err)
	}
	if !strings.HasPrefix(scopeKey, "story:story-1|branch:main|run:") {
		t.Fatalf("scopeKey must be derived from the interactive run identity: %q", scopeKey)
	}
	if run.scopeKey != scopeKey {
		t.Fatalf("run scopeKey must equal the server-derived scope: %q vs %q", run.scopeKey, scopeKey)
	}
	if st := run.run.Status(); st.State != "active" || st.LibraryID != l.ID || st.ManualCount != 1 {
		t.Fatalf("bound run status mismatch: %#v", st)
	}
	if !run.ephemeral.Present() {
		t.Fatal("initial assembly must be present")
	}
	leading := run.ephemeral.LeadingText()
	for _, want := range []string{"游戏常驻正文", "游戏手动正文"} {
		if !strings.Contains(leading, want) {
			t.Fatalf("leading text missing granted content %q", want)
		}
	}
	if strings.Contains(leading, "未授权正文") {
		t.Fatal("leading text leaked ungranted manual content")
	}
	// 绑定元数据写入运行记录（regenerate 复用真源），背景模式同步记录。
	if err := svc.interactiveRuns.bindLibrary(binding.runID, run.binding); err != nil {
		t.Fatalf("bindLibrary failed: %v", err)
	}
	if err := svc.interactiveRuns.bindBackground(binding.runID, agent.BackgroundModeLibrary); err != nil {
		t.Fatalf("bindBackground failed: %v", err)
	}
	stored, ok := svc.interactiveRuns.libraryBinding(binding.runID)
	if !ok || !stored.same(run.binding) {
		t.Fatalf("stored binding mismatch: %#v", stored)
	}
	if mode := svc.interactiveRuns.backgroundOf(binding.runID); mode != agent.BackgroundModeLibrary {
		t.Fatalf("stored background mode = %q, want library", mode)
	}

	releaseInteractiveLibraryRun(run, false)
	releaseInteractiveLibraryRun(run, false) // 幂等
	if st := run.run.Status(); st.State != "completed" {
		t.Fatalf("release must be idempotent and terminal: %#v", st)
	}
	after, err := os.ReadFile(filepath.Join(a.cfg.DataDir(), "libraries", "library-"+l.ID+".json"))
	if err != nil || string(after) != beforeLibrary {
		t.Fatal("game library run must not write the library file")
	}
}

// 2) regenerate 服务端复用（§8.2）：不依赖客户端重发，固定原 revision 重绑；
// 库漂移→revision_conflict；绑定元数据缺失→invalid_request。
func TestReuseInteractiveLibraryBindingPinsOriginalRevision(t *testing.T) {
	a, l, revision, _ := interactiveLibraryFixture(t)
	_, _, scopeKey := interactiveGameRegistry(t)
	ctx := context.Background()

	binding := interactiveRunLibraryBinding{
		libraryID:        l.ID,
		expectedRevision: revision,
		manualItemIDs:    []string{"item-manual-1"},
	}
	run, err := reuseInteractiveLibraryBinding(ctx, a, scopeKey, binding)
	if err != nil || run == nil {
		t.Fatalf("reuse with stored binding failed: %v", err)
	}
	releaseInteractiveLibraryRun(run, false)

	// 客户端重发不同授权集：与存储绑定不冲突（服务端以存储为准重绑），但显式
	// 冲突检测会拒绝——见 interactiveRegenerateBackgroundConflict 矩阵。
	// 库漂移：新增条目产生新 revision，旧授权重绑必须显式失败。
	if _, _, err := a.CreateWorkLibraryItem(ctx, l.ID, library.ItemInput{
		ID: "item-manual-3", Name: "手动三", Type: "character", Origin: "original", LoadMode: "manual", Content: strPtrItem("漂移正文"),
	}); err != nil {
		t.Fatal(err)
	}
	drifted, err := reuseInteractiveLibraryBinding(ctx, a, scopeKey, binding)
	if drifted != nil || libraryruntime.CodeOf(err) != libraryruntime.ErrRevisionConflict {
		t.Fatalf("drifted library must fail with revision_conflict: run=%v err=%v", drifted, err)
	}
	if _, err := reuseInteractiveLibraryBinding(ctx, a, scopeKey, interactiveRunLibraryBinding{}); err == nil {
		t.Fatal("incomplete stored binding must fail explicitly")
	}
	if _, err := reuseInteractiveLibraryBinding(ctx, a, "", binding); err == nil {
		t.Fatal("missing server-derived scope must fail explicitly")
	}
}

// 3) 模式裁定与 regenerate 冲突矩阵：未声明请求 legacy 逐字节兼容；显式 none 独立；
// regenerate 对改写背景的请求显式冲突。
func TestPlanInteractiveBackgroundModesAndLegacyCompat(t *testing.T) {
	a, l, revision, _ := interactiveLibraryFixture(t)
	cfg := a.cfg
	state := book.NewState(a.workspace)
	teller := prompts.InteractiveStorySystemInstructionInput{}

	legacy := planInteractiveBackground(cfg, state, teller, InteractiveTaskInput{})
	if legacy.Mode != agent.BackgroundModeLegacy || legacy.NoLegacyLore {
		t.Fatalf("undeclared request must stay legacy: %#v", legacy)
	}
	if baseline := agent.BuildInteractiveStoryInstructionComposition(cfg, state, teller); legacy.Composition.Instruction() != baseline.Instruction() {
		t.Fatal("legacy composition must stay byte-identical to the baseline builder")
	}
	libraryPlan := planInteractiveBackground(cfg, state, teller, InteractiveTaskInput{
		Library: InteractiveLibraryControl{LibraryID: l.ID, ExpectedRevision: revision},
	})
	if libraryPlan.Mode != agent.BackgroundModeLibrary || !libraryPlan.NoLegacyLore || libraryPlan.Composition.Instruction() == legacy.Composition.Instruction() {
		t.Fatalf("library plan mismatch: mode=%q", libraryPlan.Mode)
	}
	nonePlan := planInteractiveBackground(cfg, state, teller, InteractiveTaskInput{
		BackgroundSource: "none", BackgroundSourceExplicit: true,
	})
	if nonePlan.Mode != agent.BackgroundModeNone || !nonePlan.NoLegacyLore || nonePlan.Composition.Instruction() == legacy.Composition.Instruction() {
		t.Fatalf("explicit none plan mismatch: mode=%q", nonePlan.Mode)
	}
	// 推断 none（未声明显式标记）仍是 legacy：推断 none ≠ 显式 none。
	inferred := planInteractiveBackground(cfg, state, teller, InteractiveTaskInput{BackgroundSource: "none"})
	if inferred.Mode != agent.BackgroundModeLegacy {
		t.Fatalf("inferred none must stay legacy: %#v", inferred)
	}

	storedLibrary := interactiveRunLibraryBinding{libraryID: l.ID, expectedRevision: revision, manualItemIDs: []string{"item-manual-1"}}
	cases := []struct {
		name       string
		storedMode string
		stored     interactiveRunLibraryBinding
		in         InteractiveTaskInput
		wantCode   string
	}{
		{"library run resent same binding", agent.BackgroundModeLibrary, storedLibrary, InteractiveTaskInput{Library: InteractiveLibraryControl{LibraryID: l.ID, ExpectedRevision: revision, ManualItemIDs: []string{"item-manual-1"}}}, ""},
		{"library run resent different binding", agent.BackgroundModeLibrary, storedLibrary, InteractiveTaskInput{Library: InteractiveLibraryControl{LibraryID: l.ID, ExpectedRevision: "other-rev"}}, "invalid_request"},
		{"bare run resent library context", agent.BackgroundModeLegacy, interactiveRunLibraryBinding{}, InteractiveTaskInput{Library: InteractiveLibraryControl{LibraryID: l.ID, ExpectedRevision: revision}}, "invalid_request"},
		{"none run resent library context", agent.BackgroundModeNone, interactiveRunLibraryBinding{}, InteractiveTaskInput{Library: InteractiveLibraryControl{LibraryID: l.ID, ExpectedRevision: revision}}, "invalid_request"},
		{"library run resent explicit none", agent.BackgroundModeLibrary, storedLibrary, InteractiveTaskInput{BackgroundSource: "none", BackgroundSourceExplicit: true}, "invalid_request"},
		{"legacy run resent explicit none", agent.BackgroundModeLegacy, interactiveRunLibraryBinding{}, InteractiveTaskInput{BackgroundSource: "none", BackgroundSourceExplicit: true}, "invalid_request"},
		{"legacy run resent explicit legacy", agent.BackgroundModeLegacy, interactiveRunLibraryBinding{}, InteractiveTaskInput{BackgroundSource: "legacy", BackgroundSourceExplicit: true}, ""},
		{"legacy run resent nothing", agent.BackgroundModeLegacy, interactiveRunLibraryBinding{}, InteractiveTaskInput{}, ""},
	}
	for _, tc := range cases {
		if got := interactiveRegenerateBackgroundConflict(tc.storedMode, tc.stored, tc.in); got != tc.wantCode {
			t.Fatalf("%s: conflict code = %q, want %q", tc.name, got, tc.wantCode)
		}
	}
}

// 4) 状态/错误事件脱敏：只携带 state+摘要，错误只携带稳定码+固定文案。
func TestInteractiveLibraryEventsSanitized(t *testing.T) {
	a, l, revision, _ := interactiveLibraryFixture(t)
	_, _, scopeKey := interactiveGameRegistry(t)

	run, err := resolveInteractiveLibraryRun(context.Background(), a, scopeKey, InteractiveLibraryControl{
		LibraryID: l.ID, ExpectedRevision: revision, ManualItemIDs: []string{"item-manual-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer releaseInteractiveLibraryRun(run, false)
	data, ok := interactiveLibraryContextStateEvent(run).Data.(map[string]any)
	if !ok || data["state"] != "active" {
		t.Fatalf("state event mismatch: %#v", data)
	}
	for _, forbidden := range []string{"scopeKey", "runContextId", "fingerprint", "libraryId", "expectedRevision", "manualItemIds", "body"} {
		if _, exists := data[forbidden]; exists {
			t.Fatalf("state event leaked forbidden key %q: %#v", forbidden, data)
		}
	}
	revConflict := interactiveLibraryContextErrorEvent(&libraryruntime.Error{Code: libraryruntime.ErrRevisionConflict, Message: "D:\\secret\\library.json"})
	errData, ok := revConflict.Data.(map[string]string)
	if !ok || errData["code"] != string(libraryruntime.ErrRevisionConflict) || errData["message"] != "作品设定库背景无法加载，请修正当前选择后重试" {
		t.Fatalf("error event mismatch: %#v", errData)
	}
	if strings.Contains(errData["message"], "secret") {
		t.Fatal("error event must not expose internal details")
	}
	unknownCode := interactiveLibraryContextErrorEvent(context.Canceled).Data.(map[string]string)
	if unknownCode["code"] != string(libraryruntime.ErrLibraryUnavailable) {
		t.Fatalf("non-libraryruntime error must map to library_unavailable: %#v", unknownCode)
	}
	conflictCode := interactiveLibraryContextErrorEvent(&libraryruntime.Error{Code: libraryruntime.ErrInvalidRequest, Message: "regenerate conflict"}).Data.(map[string]string)
	if conflictCode["code"] != string(libraryruntime.ErrInvalidRequest) {
		t.Fatalf("regenerate conflict must surface invalid_request: %#v", conflictCode)
	}
}

// 5) registry 背景模式记录语义：缺省 legacy、非法值拒绝、改写冲突。
func TestInteractiveRunBackgroundRegistrySemantics(t *testing.T) {
	svc, binding, _ := interactiveGameRegistry(t)
	// 旧运行/未记录缺省视为 legacy。
	if mode := svc.interactiveRuns.backgroundOf(binding.runID); mode != agent.BackgroundModeLegacy {
		t.Fatalf("unrecorded run must default to legacy: %q", mode)
	}
	if err := svc.interactiveRuns.bindBackground(binding.runID, agent.BackgroundModeNone); err != nil {
		t.Fatal(err)
	}
	if err := svc.interactiveRuns.bindBackground(binding.runID, agent.BackgroundModeLibrary); err == nil {
		t.Fatal("rewriting a recorded background mode must conflict")
	}
	if err := svc.interactiveRuns.bindBackground(binding.runID, agent.BackgroundModeNone); err != nil {
		t.Fatalf("same-mode rewrite must be idempotent: %v", err)
	}
	if err := svc.interactiveRuns.bindBackground(binding.runID, "bogus"); err == nil {
		t.Fatal("invalid background mode must be rejected")
	}
	if mode := svc.interactiveRuns.backgroundOf(interactiveRunID("missing")); mode != agent.BackgroundModeLegacy {
		t.Fatalf("missing run must default to legacy: %q", mode)
	}
}

// 6) library/显式 none 模式的最终故事模型消息排除旧 Lore；legacy 对照保持基线。
func TestInteractiveConversationExcludesLegacyLoreInNewBackgroundModes(t *testing.T) {
	workspace := t.TempDir()
	loreStore := book.NewLoreStore(workspace)
	if _, err := loreStore.Create(book.LoreItemInput{ID: "hero", Type: "character", Name: "林川", Importance: "major", LoadMode: book.LoreLoadModeResident, Content: "林川：谨慎的幸存者"}); err != nil {
		t.Fatal(err)
	}
	store := interactive.NewStore(workspace)
	story, err := store.CreateStory(interactive.CreateStoryRequest{
		Title:            "背景模式",
		Origin:           "主角醒来发现世界已末日",
		StoryTellerID:    "classic",
		ReplyTargetChars: 800,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendTurn(story.ID, interactive.AppendTurnRequest{User: "我推开酒馆的门", Narrative: "门后传来低沉的风声。"}); err != nil {
		t.Fatal(err)
	}

	build := func(mode string) *interactiveConversation {
		return newInteractiveConversation(store, t.TempDir(), workspace, story.ID, "", "我点燃火把", story.ReplyTargetChars, nil).withBackgroundMode(mode)
	}

	legacyHistory, err := build("").PrepareMessages("我点燃火把", "我点燃火把")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(legacyHistory[0].Content, "常驻资料库") || !strings.Contains(legacyHistory[0].Content, "林川：谨慎的幸存者") {
		t.Fatalf("legacy baseline must keep the resident lore leading message: %#v", legacyHistory[0])
	}
	legacyTurn := legacyHistory[len(legacyHistory)-1].Content
	for _, want := range []string{"read_lore_items", "list_lore_items"} {
		if !strings.Contains(legacyTurn, want) {
			t.Fatalf("legacy turn instruction must keep lore tool guidance %q", want)
		}
	}

	libraryHistory, err := build(agent.BackgroundModeLibrary).PrepareMessages("我点燃火把", "我点燃火把")
	if err != nil {
		t.Fatal(err)
	}
	if len(libraryHistory) != len(legacyHistory)-1 {
		t.Fatalf("library mode must drop the resident lore leading message: %d vs %d", len(libraryHistory), len(legacyHistory))
	}
	libraryTurn := libraryHistory[len(libraryHistory)-1].Content
	if !strings.Contains(libraryTurn, "read_library_item") {
		t.Fatalf("library turn instruction must point at read_library_item:\n%s", libraryTurn)
	}
	for _, forbidden := range []string{"林川：谨慎的幸存者", "常驻资料库", "read_lore_items", "list_lore_items"} {
		for i, msg := range libraryHistory {
			if strings.Contains(msg.Content, forbidden) {
				t.Fatalf("library mode history[%d] leaked legacy lore %q:\n%s", i, forbidden, msg.Content)
			}
		}
	}
	sources := build(agent.BackgroundModeLibrary).ContextSourceSummary()
	for _, forbidden := range []string{"ResidentLore", "LoreContext", "已启用常驻 Lore 正文"} {
		if strings.Contains(sources, forbidden) {
			t.Fatalf("library mode ledger sources must exclude %q:\n%s", forbidden, sources)
		}
	}

	noneHistory, err := build(agent.BackgroundModeNone).PrepareMessages("我点燃火把", "我点燃火把")
	if err != nil {
		t.Fatal(err)
	}
	for i, msg := range noneHistory {
		for _, forbidden := range []string{"林川：谨慎的幸存者", "read_lore_items", "list_lore_items", "read_library_item"} {
			if strings.Contains(msg.Content, forbidden) {
				t.Fatalf("none mode history[%d] leaked %q:\n%s", i, forbidden, msg.Content)
			}
		}
	}
}

// 7) 导演侧：library 模式不装配常驻资料稳定上下文，指令切到无旧资料变体。
func TestInteractiveDirectorModelInputExcludesLegacyLoreInLibraryMode(t *testing.T) {
	workspace := t.TempDir()
	novaDir := t.TempDir()
	loreStore := book.NewLoreStore(workspace)
	if _, err := loreStore.Create(book.LoreItemInput{ID: "hero", Type: "character", Name: "林川", Importance: "major", LoadMode: book.LoreLoadModeResident, Content: "林川：谨慎的幸存者"}); err != nil {
		t.Fatal(err)
	}
	store := interactive.NewStore(workspace)
	story, err := store.CreateStory(interactive.CreateStoryRequest{
		Title:            "导演背景模式",
		Origin:           "主角进入旧城",
		StoryTellerID:    "classic",
		ReplyTargetChars: 800,
	})
	if err != nil {
		t.Fatal(err)
	}
	turn, err := store.AppendTurn(story.ID, interactive.AppendTurnRequest{User: "我观察街角", Narrative: "街角的灯忽明忽暗。"})
	if err != nil {
		t.Fatal(err)
	}

	legacyStable, legacyInstruction, err := newInteractiveConversation(store, novaDir, workspace, story.ID, "", "我跟上灯影", story.ReplyTargetChars, nil).buildDirectorModelInput(turn)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(legacyStable.Content, "林川：谨慎的幸存者") {
		t.Fatalf("legacy director stable context must keep resident lore: %s", legacyStable.Title)
	}
	if !strings.Contains(legacyInstruction, "list_lore_items") {
		t.Fatalf("legacy director instruction must keep lore discovery guidance")
	}

	libraryStable, libraryInstruction, err := newInteractiveConversation(store, novaDir, workspace, story.ID, "", "我跟上灯影", story.ReplyTargetChars, nil).withBackgroundMode(agent.BackgroundModeLibrary).buildDirectorModelInput(turn)
	if err != nil {
		t.Fatal(err)
	}
	if libraryStable.Content != "" || libraryStable.Revision != "" {
		t.Fatalf("library director must not assemble resident lore stable context: %#v", libraryStable)
	}
	if !strings.Contains(libraryInstruction, "资料工作集边界") {
		t.Fatalf("library director instruction must include the workset boundary:\n%s", libraryInstruction)
	}
	for _, forbidden := range []string{"林川：谨慎的幸存者", "list_lore_items", "read_lore_items", "资料工作集要求"} {
		if strings.Contains(libraryInstruction, forbidden) {
			t.Fatalf("library director instruction leaked legacy lore guidance %q", forbidden)
		}
	}
}
