package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"denova/config"
	"denova/internal/agent"
	"denova/internal/book"
	"denova/internal/interactive"
	"denova/internal/library"
	"denova/internal/libraryruntime"
	"denova/internal/session"
)

// B3a 审查轮：startInteractiveTask 最终送模与持久化路径的集成测试。
// 真实 App + 真实库文件 + 真实 interactive store + httptest 假 OpenAI 端点
// （SSE 流式，按回合协议脚本：叙述 → submit_interactive_turn 工具调用 →
// 定稿叙述）走完 带库新回合 → regenerate 复用 → 模拟索引未命中 三段：
//   - 最终送模：系统提示是 library 模式单源 composition（含 read_library_item
//     指引、无旧 lore 指引），ephemeral 库正文逐字节前置且未授权 manual 不在；
//   - 持久化：turn 落盘、InteractiveRun 索引映射 turn→run 且固定原 revision、
//     库文件逐字节零写入、story 快照无库正文；
//   - regenerate 不依赖客户端重发：空 InteractiveTaskInput 服务端复用原背景与
//     绑定，同一 InteractiveRun；
//   - 索引未命中（进程重启/索引过期）：显式 stale 错误事件、零模型请求、不留
//     新建 bare run（B3a 审查修正的行为锁定）。

type gameLibraryModelRequest struct {
	Messages  []gameLibraryModelMessage `json:"messages"`
	ToolNames []string
}

type gameLibraryModelMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type gameLibraryFakeModelServer struct {
	mu       sync.Mutex
	calls    int
	requests []gameLibraryModelRequest
}

func (s *gameLibraryFakeModelServer) handle(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	var payload struct {
		Messages   []gameLibraryModelMessage `json:"messages"`
		Tools      []struct {
			Function struct {
				Name string `json:"name"`
			} `json:"function"`
		} `json:"tools"`
		ToolChoice any `json:"tool_choice"`
	}
	_ = json.Unmarshal(body, &payload)
	toolNames := make([]string, 0, len(payload.Tools))
	for _, t := range payload.Tools {
		if t.Function.Name != "" {
			toolNames = append(toolNames, t.Function.Name)
		}
	}
	s.mu.Lock()
	s.calls++
	s.requests = append(s.requests, gameLibraryModelRequest{Messages: payload.Messages, ToolNames: toolNames})
	s.mu.Unlock()

	// 回合协议脚本：定稿阶段请求 tool_choice=none → 返回定稿叙述；带协议重试反馈
	// （completion guard 注入）或 tool 结果的请求 → submit_interactive_turn 工具
	// 调用；首轮 → 纯叙述（触发协议恢复重试）。
	toolChoiceNone := false
	if tc, ok := payload.ToolChoice.(string); ok && tc == "none" {
		toolChoiceNone = true
	}
	shouldSubmit := false
	for _, m := range payload.Messages {
		if m.Role == "tool" || strings.Contains(m.Content, "[Interactive turn protocol feedback") {
			shouldSubmit = true
			break
		}
	}

	w.Header().Set("Content-Type", "text/event-stream")
	flusher, _ := w.(http.Flusher)
	emit := func(delta map[string]any, finish any, withUsage bool) {
		choice := map[string]any{"index": 0, "delta": delta, "finish_reason": finish}
		chunk := map[string]any{
			"id": "chatcmpl-b3a", "object": "chat.completion.chunk", "created": 1, "model": "test-model",
			"choices": []any{choice},
		}
		if withUsage {
			chunk["usage"] = map[string]any{"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}
		}
		data, _ := json.Marshal(chunk)
		fmt.Fprintf(w, "data: %s\n\n", data)
		if flusher != nil {
			flusher.Flush()
		}
	}
	switch {
	case toolChoiceNone:
		emit(map[string]any{"role": "assistant", "content": "石门缓缓开启。"}, nil, false)
		emit(map[string]any{}, "stop", true)
	case shouldSubmit:
		args := `{"state_changes":[{"op":"replace","actor_id":"story","field_id":"当前事件","value":"主角在门后听到锁链拖地的声音。"},{"op":"replace","actor_id":"story","field_id":"当前详细地点","value":"石门之内"}],"choices":["进入房间","观察门后","检查锁链","询问同伴","退后戒备"]}`
		emit(map[string]any{"role": "assistant", "content": "", "tool_calls": []any{map[string]any{
			"index": 0, "id": "call-submit", "type": "function",
			"function": map[string]any{"name": "submit_interactive_turn", "arguments": args},
		}}}, nil, false)
		emit(map[string]any{}, "tool_calls", true)
	default:
		emit(map[string]any{"role": "assistant", "content": "门后传来锁链拖地的声音。"}, nil, false)
		emit(map[string]any{}, "stop", true)
	}
	fmt.Fprint(w, "data: [DONE]\n\n")
}

func (s *gameLibraryFakeModelServer) snapshotRequests() (int, []gameLibraryModelRequest) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls, append([]gameLibraryModelRequest(nil), s.requests...)
}

func drainInteractiveTaskEvents(t *testing.T, task *Task, timeout time.Duration) []agent.Event {
	t.Helper()
	snapshot, ch := task.Subscribe()
	events := append([]agent.Event(nil), snapshot...)
	deadline := time.After(timeout)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				return events
			}
			events = append(events, ev)
		case <-deadline:
			task.Abort()
			t.Fatalf("interactive task did not finish in time; events so far: %#v", eventTypes(events))
		}
	}
}

func eventTypes(events []agent.Event) []string {
	types := make([]string, 0, len(events))
	for _, ev := range events {
		types = append(types, ev.Type)
	}
	return types
}

func firstEventOfType(events []agent.Event, eventType string) (agent.Event, bool) {
	for _, ev := range events {
		if ev.Type == eventType {
			return ev, true
		}
	}
	return agent.Event{}, false
}

// interactiveGameIntegrationFixture 构造带真实库文件与假模型端点的最小互动 App。
func interactiveGameIntegrationFixture(t *testing.T) (*App, *InteractiveAppService, *gameLibraryFakeModelServer, library.Library, string, *interactive.Store, interactive.StorySummary, string) {
	t.Helper()
	ctx := context.Background()
	server := &gameLibraryFakeModelServer{}
	httpServer := httptest.NewServer(http.HandlerFunc(server.handle))
	t.Cleanup(httpServer.Close)

	root := t.TempDir()
	workspace := filepath.Join(root, "projects", "test-book")
	cfg := &config.Config{}
	cfg.SetDataDir(root)
	cfg.OpenAIAPIKey = "test-key"
	cfg.OpenAIBaseURL = httpServer.URL
	cfg.OpenAIModel = "test-model"

	a := &App{cfg: cfg, workspace: workspace, bookService: book.NewService(workspace)}
	a.bookState = book.NewState(workspace)
	a.interactive = interactive.NewStore(workspace)
	a.versionService = book.NewVersionService(workspace)
	sessionStore, err := session.NewStore(filepath.Join(root, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	a.sessionStore = sessionStore
	a.chatService = agent.NewChatService()

	l, _, err := a.CreateWorkLibrary(ctx, library.CreateInput{Name: "游戏绑定集成库"})
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
	t.Cleanup(func() {
		after, err := os.ReadFile(libraryPath)
		if err != nil || string(after) != string(before) {
			t.Errorf("game library run must not write the library file")
		}
	})

	story, err := a.interactive.CreateStory(interactive.CreateStoryRequest{
		Title:            "库背景集成",
		Origin:           "主角醒来发现世界已末日",
		StoryTellerID:    "classic",
		ReplyTargetChars: 800,
		DirectorRunPolicy: &interactive.StoryDirectorRunPolicy{Mode: interactive.DirectorRunModeManual},
	})
	if err != nil {
		t.Fatal(err)
	}
	return a, a.interactiveService(), server, l, revision, a.interactive, story, libraryPath
}

func assertLibraryModeModelRequest(t *testing.T, req gameLibraryModelRequest, phase string) {
	t.Helper()
	if len(req.Messages) == 0 {
		t.Fatalf("%s: model request has no messages", phase)
	}
	system := ""
	for _, m := range req.Messages {
		if m.Role == "system" {
			system = m.Content
			break
		}
	}
	if system == "" {
		t.Fatalf("%s: model request missing system message: %#v", phase, req.Messages)
	}
	for _, want := range []string{"read_library_item"} {
		if !strings.Contains(system, want) {
			t.Fatalf("%s: library-mode system prompt missing %q", phase, want)
		}
	}
	for _, forbidden := range []string{"read_lore_items", "list_lore_items", "lore-context.md"} {
		if strings.Contains(system, forbidden) {
			t.Fatalf("%s: library-mode system prompt must not contain legacy lore marker %q", phase, forbidden)
		}
	}
	if len(req.ToolNames) > 0 {
		joined := strings.Join(req.ToolNames, ",")
		if !strings.Contains(joined, "read_library_item") || strings.Contains(joined, "read_lore_items") || strings.Contains(joined, "list_lore_items") {
			t.Fatalf("%s: tool mount wrong: %v", phase, req.ToolNames)
		}
	}
}

func assertEphemeralLibraryDelivered(t *testing.T, phase string, requests []gameLibraryModelRequest) {
	t.Helper()
	delivered := false
	for _, req := range requests {
		for _, m := range req.Messages {
			if strings.Contains(m.Content, libraryruntime.EphemeralLibraryContextHeader()) {
				delivered = true
				for _, want := range []string{"常驻正文", "手动正文"} {
					if !strings.Contains(m.Content, want) {
						t.Fatalf("%s: delivered library background missing granted content %q", phase, want)
					}
				}
				if strings.Contains(m.Content, "未授权正文") {
					t.Fatalf("%s: delivered library background leaked ungranted manual content", phase)
				}
			}
		}
	}
	if !delivered {
		t.Fatalf("%s: ephemeral library background header never reached the model input", phase)
	}
}

func assertNoErrorEvents(t *testing.T, phase string, events []agent.Event) {
	t.Helper()
	for _, ev := range events {
		if ev.Type == "error" {
			t.Fatalf("%s: unexpected error event: %#v (events: %v)", phase, ev.Data, eventTypes(events))
		}
	}
}

func persistedTurnID(t *testing.T, phase string, events []agent.Event) string {
	t.Helper()
	ev, ok := firstEventOfType(events, "interactive_turn_persisted")
	if !ok {
		t.Fatalf("%s: turn was not persisted (events: %v)", phase, eventTypes(events))
	}
	data, ok := ev.Data.(InteractiveTurnPersistedEvent)
	if !ok || data.Turn.ID == "" {
		t.Fatalf("%s: persisted event payload wrong: %#v", phase, ev.Data)
	}
	return data.Turn.ID
}

func TestStartInteractiveTaskLibraryTurnRegenerateAndMissIntegration(t *testing.T) {
	ctx := context.Background()
	a, svc, server, l, revision, store, story, _ := interactiveGameIntegrationFixture(t)
	worldContexts := a.worldContext()
	const message = "我推开酒馆的门"

	// ── 段 1：带库新回合（bind-before-start → 最终送模 → 持久化） ──
	task := svc.startInteractiveTask(ctx, story.ID, "main", message, nil, "", "", InteractiveTaskInput{
		Library: InteractiveLibraryControl{LibraryID: l.ID, ExpectedRevision: revision, ManualItemIDs: []string{"item-manual-1"}},
	})
	if task == nil {
		t.Fatal("library turn task must start")
	}
	events := drainInteractiveTaskEvents(t, task, 60*time.Second)
	assertNoErrorEvents(t, "turn1", events)
	first := events[0]
	if first.Type != "library_context_state" {
		t.Fatalf("first event must be the library state event, got %q (%v)", first.Type, eventTypes(events))
	}
	if data, ok := first.Data.(map[string]any); !ok || data["state"] != "active" {
		t.Fatalf("library state event must be active: %#v", first.Data)
	}
	turn1ID := persistedTurnID(t, "turn1", events)

	calls, requests := server.snapshotRequests()
	// 回合协议：call1 纯叙述被 completion guard 保留为候选，call2 submit Ready 后
	// 直接复用候选叙述定稿——每回合恰好 2 次模型调用。
	if calls != 2 || len(requests) != 2 {
		t.Fatalf("turn1 must call the model exactly 2 times (candidate narrative + submit), got %d", calls)
	}
	assertLibraryModeModelRequest(t, requests[0], "turn1")
	assertEphemeralLibraryDelivered(t, "turn1", requests)

	// InteractiveRun 索引：turn→run 映射 + 背景模式与库绑定元数据（regenerate 复用真源）。
	runID, ok := worldContexts.interactiveRuns.findByPersistedTurn(story.ID, "main", turn1ID)
	if !ok {
		t.Fatalf("turn1 must be indexed to its InteractiveRun")
	}
	record, ok := worldContexts.interactiveRuns.snapshot(runID)
	if !ok || record.background == nil || *record.background != agent.BackgroundModeLibrary {
		t.Fatalf("run record must store the library background mode: %#v", record)
	}
	if record.library == nil || record.library.libraryID != l.ID || record.library.expectedRevision != revision {
		t.Fatalf("run record must pin the original library binding: %#v", record.library)
	}

	// 持久化隔离：story 快照含回合叙述但无库正文。
	snapshot, err := store.Snapshot(story.ID, "main")
	if err != nil {
		t.Fatal(err)
	}
	snapshotJSON, _ := json.Marshal(snapshot)
	if !strings.Contains(string(snapshotJSON), "门后传来锁链拖地的声音。") {
		t.Fatalf("persisted turn narrative missing: %s", snapshotJSON)
	}
	for _, forbidden := range []string{"常驻正文", "手动正文", "未授权正文", string(libraryruntime.EphemeralLibraryContextHeader())} {
		if strings.Contains(string(snapshotJSON), forbidden) {
			t.Fatalf("story snapshot must not contain library content %q", forbidden)
		}
	}

	// ── 段 2：regenerate（空 InteractiveTaskInput——服务端复用原背景与绑定） ──
	task2 := svc.startInteractiveTask(ctx, story.ID, "main", message, nil, turn1ID, "", InteractiveTaskInput{})
	if task2 == nil {
		t.Fatal("regenerate task must start")
	}
	events2 := drainInteractiveTaskEvents(t, task2, 60*time.Second)
	assertNoErrorEvents(t, "regenerate", events2)
	if ev, ok := firstEventOfType(events2, "library_context_state"); !ok {
		t.Fatalf("regenerate must re-emit the library state event (%v)", eventTypes(events2))
	} else if data, ok := ev.Data.(map[string]any); !ok || data["state"] != "active" {
		t.Fatalf("regenerate library state event must be active: %#v", ev.Data)
	}
	turn2ID := persistedTurnID(t, "regenerate", events2)

	calls2, requests2 := server.snapshotRequests()
	if calls2 != 4 {
		t.Fatalf("regenerate must call the model exactly 2 more times, got %d total", calls2)
	}
	assertLibraryModeModelRequest(t, requests2[2], "regenerate")
	assertEphemeralLibraryDelivered(t, "regenerate", requests2[2:])

	// 复用同一 InteractiveRun（不新建），绑定元数据仍是原 revision。
	runID2, ok := worldContexts.interactiveRuns.findByPersistedTurn(story.ID, "main", turn2ID)
	if !ok || runID2 != runID {
		t.Fatalf("regenerate must reuse the original InteractiveRun: got %q want %q", runID2, runID)
	}
	record2, _ := worldContexts.interactiveRuns.snapshot(runID2)
	if record2.library == nil || record2.library.expectedRevision != revision || record2.library.libraryID != l.ID {
		t.Fatalf("regenerate must keep the original library binding: %#v", record2.library)
	}
	snapshot2, err := store.Snapshot(story.ID, "main")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot2.Turns) != 1 || snapshot2.Turns[0].ID == turn1ID {
		t.Fatalf("regenerate must rewind and re-persist one turn: turns=%d oldID=%s", len(snapshot2.Turns), turn1ID)
	}
	snapshot2JSON, _ := json.Marshal(snapshot2)
	if strings.Contains(string(snapshot2JSON), "常驻正文") || strings.Contains(string(snapshot2JSON), "未授权正文") {
		t.Fatal("regenerated story snapshot must not contain library content")
	}

	// ── 段 3：索引未命中（模拟进程重启/索引过期）→ 显式阻断，不猜测背景 ──
	worldContexts.interactiveRuns = newInteractiveRunRegistry(interactiveRunRegistryConfig{})
	callsBeforeMiss, _ := server.snapshotRequests()
	task3 := svc.startInteractiveTask(ctx, story.ID, "main", message, nil, turn2ID, "", InteractiveTaskInput{})
	if task3 == nil {
		t.Fatal("miss task must still return a task (with an explicit error event)")
	}
	events3 := drainInteractiveTaskEvents(t, task3, 30*time.Second)
	ev, ok := firstEventOfType(events3, "error")
	if !ok {
		t.Fatalf("index miss must fail explicitly with an error event (%v)", eventTypes(events3))
	}
	data, ok := ev.Data.(map[string]string)
	if !ok || data["code"] != string(libraryruntime.ErrStale) || data["message"] != "原回合的运行背景已不可用，无法按原背景重新生成，请刷新后重试" {
		t.Fatalf("miss error event must be the stable stale code with the fixed copy: %#v", ev.Data)
	}
	callsAfterMiss, _ := server.snapshotRequests()
	if callsAfterMiss != callsBeforeMiss {
		t.Fatalf("index miss must not start the model: calls %d -> %d", callsBeforeMiss, callsAfterMiss)
	}
	if _, exists := worldContexts.interactiveRuns.findByTask(story.ID, "main", task3.ID()); exists {
		t.Fatal("index miss must roll back the freshly created bare run")
	}
	if task3.Status() != TaskError {
		t.Fatalf("miss task must end in error state, got %s", task3.Status())
	}
}
