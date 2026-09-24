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
	"denova/internal/library"
	"denova/internal/libraryruntime"
	"denova/internal/session"
)

// B2a：写作链 library 背景的 bind-before-start 验证（L3 计划 §8.1–§8.5）。
// 证据链：真实 App + 真实库文件走完 绑定→装配→按需读取→幂等释放，
// 正文只出现在装配返回值；revision 冲突阻断启动且不产生 Task；
// Library 与 World 同现在 app 层防御性拒绝；状态事件只携带脱敏摘要。

// writingLibraryFixture 构造带真实库文件的最小写作 App（与 library_runtime_service_test 同构）。
func writingLibraryFixture(t *testing.T) (*ChatAppService, library.Library, string, string) {
	t.Helper()
	root := t.TempDir()
	workspace := filepath.Join(root, "projects", "test-book")
	cfg := &config.Config{}
	cfg.SetDataDir(root)
	a := &App{cfg: cfg, workspace: workspace, bookService: book.NewService(workspace)}
	ctx := context.Background()
	l, _, err := a.CreateWorkLibrary(ctx, library.CreateInput{Name: "写作绑定测试库"})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []library.ItemInput{
		{ID: "item-resident", Name: "常驻一", Type: "character", Origin: "original", LoadMode: "resident", Content: strPtrItem("常驻正文")},
		{ID: "item-auto-1", Name: "自动一", Type: "character", Origin: "original", LoadMode: "auto", Content: strPtrItem("自动正文")},
		{ID: "item-manual-1", Name: "手动一", Type: "character", Origin: "original", LoadMode: "manual", Content: strPtrItem("手动正文")},
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
	return &ChatAppService{app: a}, l, revision, string(before)
}

// 1) 真实链路：绑定成功、初始装配只含获准内容、scopeKey 服务端派生、零写入、幂等释放。
func TestResolveWritingLibraryRunFullChain(t *testing.T) {
	chat, l, revision, beforeLibrary := writingLibraryFixture(t)
	ctx := context.Background()

	run, err := chat.resolveWritingLibraryRun(ctx, "task-b2a-1", WritingLibraryControl{
		LibraryID: l.ID, ExpectedRevision: revision, ManualItemIDs: []string{"item-manual-1"},
	})
	if err != nil || run == nil {
		t.Fatalf("bind+assemble failed: run=%v err=%v", run, err)
	}
	if run.scopeKey != writingTaskScopeKey("task-b2a-1") || !strings.HasPrefix(run.scopeKey, "task:") {
		t.Fatalf("scopeKey must be server-derived from task id: %q", run.scopeKey)
	}
	if st := run.run.Status(); st.State != "active" || st.LibraryID != l.ID {
		t.Fatalf("bound run status mismatch: %#v", st)
	}
	if !run.ephemeral.Present() {
		t.Fatal("initial assembly must be present")
	}
	leading := run.ephemeral.LeadingText()
	for _, want := range []string{"常驻正文", "手动正文", "自动一"} {
		if !strings.Contains(leading, want) {
			t.Fatalf("leading text missing granted content %q", want)
		}
	}
	if strings.Contains(leading, "未授权正文") {
		t.Fatal("leading text leaked ungranted manual content")
	}
	// 装配文本可直接进入 agent 临时输入（逐字节前置）。
	libInput := agent.NewEphemeralLibraryContextInput(leading)
	if !libInput.Present() || libInput.LeadingContent() != leading {
		t.Fatalf("leading text must feed the ephemeral agent input byte-identically")
	}
	// 按需读取：授权 manual 可读、未授权 denied（经绑定的 Run）。
	if _, err := run.run.ReadOnDemand(ctx, "item-manual-1"); err != nil {
		t.Fatalf("granted manual on-demand read failed: %v", err)
	}
	if _, err := run.run.ReadOnDemand(ctx, "item-manual-2"); libraryruntime.CodeOf(err) != libraryruntime.ErrDenied {
		t.Fatalf("ungranted manual must be denied: %v", err)
	}

	releaseWritingLibraryRun(run, false)
	releaseWritingLibraryRun(run, false) // 幂等
	if st := run.run.Status(); st.State != "completed" {
		t.Fatalf("release must be idempotent and terminal: %#v", st)
	}
	after, err := os.ReadFile(filepath.Join(chat.app.cfg.DataDir(), "libraries", "library-"+l.ID+".json"))
	if err != nil || string(after) != beforeLibrary {
		t.Fatal("writing library run must not write the library file")
	}
	releaseWritingLibraryRun(nil, false) // nil no-op
}

// 2) 绑定期失败阻断启动（§8.4）：revision 冲突显式报错、不产生 Run、不静默降级。
func TestResolveWritingLibraryRunBlocksOnRevisionConflict(t *testing.T) {
	chat, l, _, _ := writingLibraryFixture(t)
	run, err := chat.resolveWritingLibraryRun(context.Background(), "task-b2a-2", WritingLibraryControl{
		LibraryID: l.ID, ExpectedRevision: "stale-rev",
	})
	if run != nil || libraryruntime.CodeOf(err) != libraryruntime.ErrRevisionConflict {
		t.Fatalf("revision conflict must block without run: run=%v err=%v", run, err)
	}
	// 未携带库控制字段：nil, nil（bare/legacy/none 路径不受影响）。
	if run, err := chat.resolveWritingLibraryRun(context.Background(), "task-b2a-3", WritingLibraryControl{}); run != nil || err != nil {
		t.Fatalf("absent control must be nil,nil: run=%v err=%v", run, err)
	}
}

// 3) 正式入口的防御性互斥与阻断：Library+World 同现拒绝；revision 冲突返回错误且无 Task。
func TestStartWritingTaskLibraryConflictsBlockBeforeStart(t *testing.T) {
	chat, l, revision, _ := writingLibraryFixture(t)
	a := chat.app
	store, err := session.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sess, err := store.GetOrCreate("default")
	if err != nil {
		t.Fatal(err)
	}
	a.session = sess
	a.bookState = book.NewState(a.workspace)

	// Library 与 World 同现：传输层已 400，app 层防御性再次拒绝（不吞并）。
	if task, err := chat.StartWritingTaskWithError(context.Background(), WritingTaskInput{
		Request: agent.ChatRequest{Message: "继续写"},
		World:   WritingWorldControl{HasAnalysisHandle: true, AnalysisHandle: strings.Repeat("h", 32)},
		Library: WritingLibraryControl{LibraryID: l.ID, ExpectedRevision: revision},
	}); task != nil || libraryruntime.CodeOf(err) != libraryruntime.ErrInvalidRequest {
		t.Fatalf("library+world must be rejected: task=%v err=%v", task, err)
	}

	// revision 冲突：阻断启动、不产生 Task、不静默 bare。
	if task, err := chat.StartWritingTaskWithError(context.Background(), WritingTaskInput{
		Request: agent.ChatRequest{Message: "继续写"},
		Library: WritingLibraryControl{LibraryID: l.ID, ExpectedRevision: "stale-rev"},
	}); task != nil || libraryruntime.CodeOf(err) != libraryruntime.ErrRevisionConflict {
		t.Fatalf("stale revision must block task creation: task=%v err=%v", task, err)
	}
	if a.activeTask != nil {
		t.Fatalf("blocked start must not leave an active task: %v", a.activeTask)
	}
}

// 4) 状态事件只携带脱敏摘要（§8.4）：active/none + 禁发运行身份与库控制字段。
func stateEventData(t *testing.T, ev agent.Event) map[string]any {
	t.Helper()
	data, ok := ev.Data.(map[string]any)
	if !ok {
		t.Fatalf("state event data must be map[string]any: %#v", ev.Data)
	}
	return data
}

func TestWritingLibraryContextStateEventSanitized(t *testing.T) {
	// 无库运行：state=none 且不含其它字段。
	noneEvent := writingLibraryContextStateEvent(nil)
	if noneEvent.Type != "library_context_state" {
		t.Fatalf("none event type mismatch: %#v", noneEvent)
	}
	noneData := stateEventData(t, noneEvent)
	if noneData["state"] != "none" {
		t.Fatalf("none event mismatch: %#v", noneData)
	}
	if len(noneData) != 1 {
		t.Fatalf("none event must carry only state: %#v", noneData)
	}

	chat, l, revision, _ := writingLibraryFixture(t)
	run, err := chat.resolveWritingLibraryRun(context.Background(), "task-b2a-4", WritingLibraryControl{
		LibraryID: l.ID, ExpectedRevision: revision, ManualItemIDs: []string{"item-manual-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer releaseWritingLibraryRun(run, false)

	event := writingLibraryContextStateEvent(run)
	if event.Type != "library_context_state" {
		t.Fatalf("active event type mismatch: %#v", event)
	}
	data := stateEventData(t, event)
	if data["state"] != "active" {
		t.Fatalf("active event mismatch: %#v", data)
	}
	if data["libraryName"] != "写作绑定测试库" {
		t.Fatalf("library name mismatch: %#v", data)
	}
	if data["selectedCount"] != 1 {
		t.Fatalf("selected count mismatch: %#v", data)
	}
	if label, _ := data["revisionLabel"].(string); label != revision && len(label) > 64 {
		t.Fatalf("revision label mismatch: %#v", data)
	}
	for _, banned := range []string{"runContextId", "scopeKey", "fingerprint", "libraryId", "expectedRevision", "manualItemIds", "body", "catalog"} {
		if _, ok := data[banned]; ok {
			t.Fatalf("state event leaked banned field %q: %#v", banned, data)
		}
	}
	// 有界标签：超长 revision 截断到 64。
	if got := revisionWireLabel(strings.Repeat("r", 100)); len(got) != 64 {
		t.Fatalf("revision label must be bounded to 64: %d", len(got))
	}
}

// 5) B2a 修正轮：背景模式裁定与单源 composition（缺口②）。legacy 与默认逐字节一致；
// 显式 none / library 关闭旧 Lore；结构推断 none ≠ 显式 none（旧请求兼容）。
func TestPlanWritingBackgroundModesAndLegacyCompat(t *testing.T) {
	chat, _, _, _ := writingLibraryFixture(t)
	a := chat.app
	a.bookState = book.NewState(a.workspace)
	cfg := a.cfg
	state := a.bookState
	teller := agent.IDEStoryTeller{}

	// 未声明（结构推断为 none）：必须保持 legacy 行为（推断的 none 不等于显式 none）。
	bare := planWritingBackground(cfg, state, teller, WritingTaskInput{BackgroundSource: "none", BackgroundSourceExplicit: false})
	if bare.Mode != agent.BackgroundModeLegacy || bare.NoLegacyLore {
		t.Fatalf("未声明请求（即使结构推断为 none）必须保持 legacy 行为: %+v", bare)
	}
	if bare.Composition.Instruction() != agent.BuildInstructionComposition(cfg, state, teller).Instruction() {
		t.Fatal("legacy composition 必须与默认 BuildInstructionComposition 逐字节一致（旧请求兼容）")
	}

	// 显式 legacy：同上（旧请求兼容）。
	explicitLegacy := planWritingBackground(cfg, state, teller, WritingTaskInput{BackgroundSource: "legacy", BackgroundSourceExplicit: true})
	if explicitLegacy.Mode != agent.BackgroundModeLegacy || explicitLegacy.NoLegacyLore {
		t.Fatalf("显式 legacy 必须保持旧行为: %+v", explicitLegacy)
	}

	// 显式 none：none 模式，无任何背景读取工具指引。
	explicitNone := planWritingBackground(cfg, state, teller, WritingTaskInput{BackgroundSource: "none", BackgroundSourceExplicit: true})
	if explicitNone.Mode != agent.BackgroundModeNone || !explicitNone.NoLegacyLore {
		t.Fatalf("显式 none 必须裁定 none 模式: %+v", explicitNone)
	}
	for _, banned := range []string{"read_lore_items", "list_lore_items", "write_lore_items", "read_library_item"} {
		if strings.Contains(explicitNone.Composition.Instruction(), banned) {
			t.Fatalf("显式 none 提示不得引用背景工具 %q", banned)
		}
	}

	// library：库模式提示；SystemPromptLog 不得回落默认 composition（缺口②回归守护）。
	libraryPlan := planWritingBackground(cfg, state, teller, WritingTaskInput{
		Library:               WritingLibraryControl{LibraryID: "lib-1", ExpectedRevision: "rev-1"},
		BackgroundSource:      "library",
		BackgroundSourceExplicit: true,
	})
	if libraryPlan.Mode != agent.BackgroundModeLibrary || !libraryPlan.NoLegacyLore {
		t.Fatalf("库控制字段必须裁定 library 模式: %+v", libraryPlan)
	}
	if libraryPlan.Composition.Instruction() == agent.BuildInstructionComposition(cfg, state, teller).Instruction() {
		t.Fatal("library 模式 SystemPromptLog 必须是库模式提示本身（缺口②回归守护）")
	}
	if !strings.Contains(libraryPlan.Composition.Instruction(), "read_library_item") {
		t.Fatal("library 模式提示必须指引 read_library_item")
	}
}

// 6) B2a 修正轮（缺口①）：lore_references 防御性拒绝——传输层已 400
// background_source_conflict，直连调用同样拒绝（不静默丢弃）；拒绝发生在绑定/启动之前。
func TestStartWritingTaskRejectsLoreReferencesInNewBackgroundModes(t *testing.T) {
	chat, l, revision, _ := writingLibraryFixture(t)
	a := chat.app
	store, err := session.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sess, err := store.GetOrCreate("default")
	if err != nil {
		t.Fatal(err)
	}
	a.session = sess
	a.bookState = book.NewState(a.workspace)

	// library + lore_references → 拒绝（发生在库绑定之前，无副作用）。
	if task, err := chat.StartWritingTaskWithError(context.Background(), WritingTaskInput{
		Request:  agent.ChatRequest{Message: "继续写", LoreReferences: []string{"hero"}},
		Library: WritingLibraryControl{LibraryID: l.ID, ExpectedRevision: revision},
	}); task != nil || libraryruntime.CodeOf(err) != libraryruntime.ErrInvalidRequest {
		t.Fatalf("library + lore_references must be rejected: task=%v err=%v", task, err)
	}

	// 显式 none + lore_references → 拒绝。
	if task, err := chat.StartWritingTaskWithError(context.Background(), WritingTaskInput{
		Request:                  agent.ChatRequest{Message: "继续写", LoreReferences: []string{"hero"}},
		BackgroundSource:         "none",
		BackgroundSourceExplicit: true,
	}); task != nil || libraryruntime.CodeOf(err) != libraryruntime.ErrInvalidRequest {
		t.Fatalf("explicit none + lore_references must be rejected: task=%v err=%v", task, err)
	}
	if a.activeTask != nil {
		t.Fatalf("rejected starts must not leave an active task: %v", a.activeTask)
	}
}

// 7) 修正轮 runner 构建路径冒烟：单源 composition 的 Instruction() 可直接驱动
// none / library runner 构建（缺口②的接线端到端可执行）。
func TestBuildWritingRunnersConsumeSingleSourceInstruction(t *testing.T) {
	chat, l, revision, _ := writingLibraryFixture(t)
	a := chat.app
	a.bookState = book.NewState(a.workspace)
	cfg := a.cfg
	state := a.bookState
	teller := agent.IDEStoryTeller{}

	// 显式 none：单源提示构建 runner；空提示显式报错。
	nonePlan := planWritingBackground(cfg, state, teller, WritingTaskInput{BackgroundSource: "none", BackgroundSourceExplicit: true})
	runner, err := buildAgentRunnerWithNoBackground(context.Background(), cfg, nonePlan.Composition.Instruction())
	if err != nil || runner == nil {
		t.Fatalf("explicit none runner build failed: err=%v runner=%v", err, runner)
	}
	if _, err := buildAgentRunnerWithNoBackground(context.Background(), cfg, ""); err == nil {
		t.Fatal("empty instruction must fail explicit-none runner build")
	}

	// library：真实绑定 Run + 单源提示构建 runner。
	run, err := chat.resolveWritingLibraryRun(context.Background(), "task-r2-instruction", WritingLibraryControl{LibraryID: l.ID, ExpectedRevision: revision})
	if err != nil {
		t.Fatal(err)
	}
	defer releaseWritingLibraryRun(run, false)
	libraryPlan := planWritingBackground(cfg, state, teller, WritingTaskInput{
		Library: WritingLibraryControl{LibraryID: l.ID, ExpectedRevision: revision},
	})
	runner, err = buildAgentRunnerWithLibrary(context.Background(), cfg, state, teller, libraryPlan.Composition.Instruction(), run.run)
	if err != nil || runner == nil {
		t.Fatalf("library runner build failed: err=%v runner=%v", err, runner)
	}
}
