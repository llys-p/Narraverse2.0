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
