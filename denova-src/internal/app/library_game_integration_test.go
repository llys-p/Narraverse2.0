package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
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

type gameLibraryToolCall struct {
	ID       string `json:"id"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type gameLibraryModelMessage struct {
	Role       string                `json:"role"`
	Content    string                `json:"content"`
	ToolCallID string                `json:"tool_call_id"`
	ToolCalls  []gameLibraryToolCall `json:"tool_calls"`
}

type gameLibraryFakeModelServer struct {
	mu       sync.Mutex
	calls    int
	requests []gameLibraryModelRequest
	// readItemID 非空时启用库读取脚本：首轮强制调用 read_library_item，
	// 工具结果回填后再叙述 → submit（D1 修复轮的持久化链验证）。
	readItemID string
}

func (s *gameLibraryFakeModelServer) handle(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	var payload struct {
		Messages []gameLibraryModelMessage `json:"messages"`
		Tools    []struct {
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
	// 调用；首轮 → 纯叙述（触发协议恢复重试）。readItemID 非空时走库读取脚本：
	// 首轮强制 read_library_item，工具结果回填后叙述，再按协议反馈 submit。
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
	emitSubmit := func() {
		args := `{"state_changes":[{"op":"replace","actor_id":"story","field_id":"当前事件","value":"主角在门后听到锁链拖地的声音。"},{"op":"replace","actor_id":"story","field_id":"当前详细地点","value":"石门之内"}],"choices":["进入房间","观察门后","检查锁链","询问同伴","退后戒备"]}`
		emit(map[string]any{"role": "assistant", "content": "", "tool_calls": []any{map[string]any{
			"index": 0, "id": "call-submit", "type": "function",
			"function": map[string]any{"name": "submit_interactive_turn", "arguments": args},
		}}}, nil, false)
		emit(map[string]any{}, "tool_calls", true)
	}
	emitNarrative := func() {
		emit(map[string]any{"role": "assistant", "content": "门后传来锁链拖地的声音。"}, nil, false)
		emit(map[string]any{}, "stop", true)
	}
	switch {
	case toolChoiceNone:
		emit(map[string]any{"role": "assistant", "content": "石门缓缓开启。"}, nil, false)
		emit(map[string]any{}, "stop", true)
	case s.readItemID != "":
		callNames := map[string]string{}
		hasFeedback, hasNarrative, readResultSeen, submitSeen := false, false, false, false
		for _, m := range payload.Messages {
			if strings.Contains(m.Content, "[Interactive turn protocol feedback") {
				hasFeedback = true
			}
			if m.Role == "assistant" && strings.TrimSpace(m.Content) != "" {
				hasNarrative = true
			}
			for _, tc := range m.ToolCalls {
				callNames[tc.ID] = tc.Function.Name
			}
			if m.Role == "tool" {
				switch callNames[m.ToolCallID] {
				case "read_library_item":
					readResultSeen = true
				case "submit_interactive_turn":
					submitSeen = true
				}
			}
		}
		switch {
		case submitSeen || (hasFeedback && hasNarrative):
			emitSubmit()
		case readResultSeen:
			emitNarrative()
		default:
			emit(map[string]any{"role": "assistant", "content": "", "tool_calls": []any{map[string]any{
				"index": 0, "id": "call-read-library", "type": "function",
				"function": map[string]any{"name": "read_library_item", "arguments": `{"itemId":"` + s.readItemID + `"}`},
			}}}, nil, false)
			emit(map[string]any{}, "tool_calls", true)
		}
	case shouldSubmit:
		emitSubmit()
	default:
		emitNarrative()
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

// D1 修复轮：每个虚构条目嵌入非空、唯一的 ASCII 标记串——落盘扫描按标记直扫
// （不再依赖连续汉字 n-gram），标记出现在库源文件之外即为泄漏。
const (
	gameFixtureMarkerResident = "LIBFIX-MARK-RES-01"
	gameFixtureMarkerAuto     = "LIBFIX-MARK-AUTO-01"
	gameFixtureMarkerManual1  = "LIBFIX-MARK-MAN-01"
	gameFixtureMarkerManual2  = "LIBFIX-MARK-MAN-02"
)

var gameFixtureMarkers = []string{
	gameFixtureMarkerResident,
	gameFixtureMarkerAuto,
	gameFixtureMarkerManual1,
	gameFixtureMarkerManual2,
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
		{ID: "item-resident", Name: "常驻一", Type: "character", Origin: "original", LoadMode: "resident", Content: strPtrItem(gameFixtureMarkerResident + " 常驻正文")},
		{ID: "item-auto-1", Name: "自动一", Type: "character", Origin: "original", LoadMode: "auto", Content: strPtrItem(gameFixtureMarkerAuto + " 自动正文")},
		{ID: "item-manual-1", Name: "手动一", Type: "character", Origin: "original", LoadMode: "manual", Content: strPtrItem(gameFixtureMarkerManual1 + " 手动正文")},
		{ID: "item-manual-2", Name: "手动二", Type: "character", Origin: "original", LoadMode: "manual", Content: strPtrItem(gameFixtureMarkerManual2 + " 未授权正文")},
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
		Title:             "库背景集成",
		Origin:            "主角醒来发现世界已末日",
		StoryTellerID:     "classic",
		ReplyTargetChars:  800,
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

// ── D1 修复轮（2026-09-25）：read_library_item 真实触发后的全通道落盘扫描 ──

// findGameRunLedgers 返回隔离数据目录下全部 run ledger JSONL（<workspace>/.denova/runs/*.jsonl）。
func findGameRunLedgers(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if filepath.Ext(path) == ".jsonl" && filepath.Base(filepath.Dir(path)) == "runs" {
			out = append(out, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk run ledgers: %v", err)
	}
	return out
}

// findGameStoryFiles 返回隔离数据目录下全部故事存档 JSONL（story-*.jsonl，含备份副本）。
func findGameStoryFiles(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		base := filepath.Base(path)
		if filepath.Ext(base) == ".jsonl" && strings.HasPrefix(base, "story-") {
			out = append(out, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk story archives: %v", err)
	}
	return out
}

// scanGameFixtureMarkers 对隔离数据目录逐文件做标记串直扫（非 n-gram），
// 返回 文件绝对路径 → 命中标记列表。
func scanGameFixtureMarkers(t *testing.T, root string, markers []string) map[string][]string {
	t.Helper()
	hits := map[string][]string{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			t.Fatalf("scan read %s: %v", path, readErr)
		}
		for _, marker := range markers {
			if strings.Contains(string(raw), marker) {
				hits[path] = append(hits[path], marker)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk data dir: %v", err)
	}
	return hits
}

// assertGamePersistenceChannelsMetadataOnly 断言全部落盘通道中标记只允许出现在库源文件：
// 模型输入只允许存在于内存捕获（server.requests），任何落盘副本（run ledger、故事
// display 存档、Session、服务日志、备份等）出现标记即失败。同时自检标记非空唯一、
// 目标文件真实生成，避免扫描假绿。
func assertGamePersistenceChannelsMetadataOnly(t *testing.T, phase, root, libraryPath string, markers []string) []string {
	t.Helper()
	// 自检：标记必须非空且唯一（空标记会让扫描假绿）。
	if len(markers) == 0 {
		t.Fatalf("%s: fixture markers must not be empty", phase)
	}
	seen := map[string]bool{}
	for _, marker := range markers {
		if strings.TrimSpace(marker) == "" {
			t.Fatalf("%s: fixture marker must be non-empty ASCII text", phase)
		}
		if seen[marker] {
			t.Fatalf("%s: fixture marker %q duplicated", phase, marker)
		}
		seen[marker] = true
	}
	// 必备落盘目标必须真实生成，否则扫描无效。
	ledgers := findGameRunLedgers(t, root)
	if len(ledgers) == 0 {
		t.Fatalf("%s: run ledger files were not generated, scan would be vacuous", phase)
	}
	storyFiles := findGameStoryFiles(t, root)
	if len(storyFiles) == 0 {
		t.Fatalf("%s: story archive files were not generated, scan would be vacuous", phase)
	}
	// 库源文件必须命中全部标记：证明扫描器能看见标记、源文件未被清空或改写。
	// 模型输入属"允许的内存捕获"，不经此扫描（由调用方直接断言 server.requests）。
	hits := scanGameFixtureMarkers(t, root, markers)
	if sourceHits := hits[libraryPath]; len(sourceHits) != len(markers) {
		t.Fatalf("%s: library source file must keep all markers, got %v", phase, sourceHits)
	}
	for file, fileHits := range hits {
		if file != libraryPath {
			t.Fatalf("%s: marker leaked into persisted channel %s (%v)", phase, file, fileHits)
		}
	}
	// 故事 display 存档必须真实捕获过库读取事件（否则 story 侧扫描无意义）。
	noticeArchived := false
	for _, storyFile := range storyFiles {
		raw, err := os.ReadFile(storyFile)
		if err != nil {
			t.Fatalf("%s: read story archive %s: %v", phase, storyFile, err)
		}
		if strings.Contains(string(raw), "library-item-read") {
			noticeArchived = true
		}
	}
	if !noticeArchived {
		t.Fatalf("%s: story display archive never captured the sanitized read notice, scan would be vacuous", phase)
	}
	return ledgers
}

// ledgerRecordText 从 run ledger 字段值取文本：原始字符串，或 ledger 对正文类字段
// 摘要后的 {bytes,chars,hash,preview} 形态。
func ledgerRecordText(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case map[string]any:
		preview, _ := typed["preview"].(string)
		return preview
	default:
		return ""
	}
}

// assertReadToolLedgerEventMetadataOnly 在 run ledger 中定位 read_library_item 的
// tool_result 落盘事件（带 library_read 元数据的那条），断言其 content 是固定提示、
// 不含任何正文标记，且 library_read 只携带字节数与条目元数据。
func assertReadToolLedgerEventMetadataOnly(t *testing.T, phase string, ledgers []string) {
	t.Helper()
	found := false
	for _, ledger := range ledgers {
		raw, err := os.ReadFile(ledger)
		if err != nil {
			t.Fatalf("%s: read ledger %s: %v", phase, ledger, err)
		}
		for _, line := range strings.Split(string(raw), "\n") {
			if !strings.Contains(line, `"read_library_item"`) {
				continue
			}
			var record struct {
				Data struct {
					EventData map[string]any `json:"event_data"`
				} `json:"data"`
			}
			if err := json.Unmarshal([]byte(line), &record); err != nil {
				continue
			}
			eventData := record.Data.EventData
			name, _ := eventData["name"].(string)
			if name != "read_library_item" {
				continue
			}
			meta, _ := eventData["library_read"].(map[string]any)
			if meta == nil {
				continue // tool_call / tool_execution 等其它事件形态，另行覆盖
			}
			found = true
			content := ledgerRecordText(eventData["content"])
			if !strings.Contains(content, "library-item-read") {
				t.Fatalf("%s: ledger tool_result content must be the sanitized notice: %q", phase, content)
			}
			for _, marker := range gameFixtureMarkers {
				if strings.Contains(content, marker) {
					t.Fatalf("%s: ledger tool_result notice leaked body: %q", phase, content)
				}
			}
			if bytes, ok := meta["bytes"].(float64); !ok || bytes <= 0 {
				t.Fatalf("%s: ledger meta must carry measured bytes: %#v", phase, meta)
			}
			if itemID, _ := meta["itemId"].(string); itemID != "item-auto-1" {
				t.Fatalf("%s: ledger meta must carry the item id (tolerant parse of the runtime result): %#v", phase, meta)
			}
			t.Logf("%s: ledger read event content=%q meta=%v", phase, content, meta)
		}
	}
	if !found {
		t.Fatalf("%s: read_library_item tool_result event not found in run ledgers", phase)
	}
}

// TestLibraryGameReadToolKeepsBodyOutOfPersistedChannels 用确定性假模型强制触发一次
// 库按需读取，验证 B3c 验收 D1 的修复在真实持久化链上成立：模型侧收到完整正文；
// run ledger、turn display_events（story jsonl）与 Session 落盘无正文标记；库文件与
// revision 不变；regenerate 复用原绑定且新 run 的落盘同样干净。
func TestLibraryGameReadToolKeepsBodyOutOfPersistedChannels(t *testing.T) {
	ctx := context.Background()
	a, svc, server, l, revision, _, story, libraryPath := interactiveGameIntegrationFixture(t)
	root := filepath.Dir(filepath.Dir(libraryPath)) // <root>/libraries/library-<id>.json → <root>
	worldContexts := a.worldContext()
	server.readItemID = "item-auto-1"
	const message = "我照着地图走向雾巷"

	task := svc.startInteractiveTask(ctx, story.ID, "main", message, nil, "", "", InteractiveTaskInput{
		Library: InteractiveLibraryControl{LibraryID: l.ID, ExpectedRevision: revision, ManualItemIDs: []string{"item-manual-1"}},
	})
	if task == nil {
		t.Fatal("library read turn task must start")
	}
	events := drainInteractiveTaskEvents(t, task, 60*time.Second)
	assertNoErrorEvents(t, "read turn", events)
	if ev, ok := firstEventOfType(events, "library_context_state"); !ok {
		t.Fatalf("read turn must emit the library state event (%v)", eventTypes(events))
	} else if data, ok := ev.Data.(map[string]any); !ok || data["state"] != "active" {
		t.Fatalf("library state event must be active: %#v", ev.Data)
	}
	turnID := persistedTurnID(t, "read turn", events)

	// 模型侧：工具确实被请求执行，且工具结果（含完整正文）进入了下一次模型输入。
	calls, requests := server.snapshotRequests()
	readRequested, bodyDelivered := false, false
	for _, req := range requests {
		for _, m := range req.Messages {
			for _, tc := range m.ToolCalls {
				if tc.Function.Name == "read_library_item" {
					readRequested = true
				}
			}
			if m.Role == "tool" && strings.Contains(m.Content, gameFixtureMarkerAuto) {
				bodyDelivered = true
				if !strings.Contains(m.Content, "自动正文") {
					t.Fatalf("tool result delivered to the model must keep the full body: %q", m.Content)
				}
			}
		}
	}
	if !readRequested {
		t.Fatalf("fake model script must force a read_library_item call (calls=%d)", calls)
	}
	if !bodyDelivered {
		t.Fatalf("model must receive the item body through the tool loop (calls=%d)", calls)
	}
	t.Logf("read turn: model calls=%d (tool forced), body delivered to model, turn=%s", calls, turnID)

	// 绑定索引与库只读性：库文件由 fixture 的 Cleanup 逐字节复核，此处锁定 revision。
	if _, ok := worldContexts.interactiveRuns.findByPersistedTurn(story.ID, "main", turnID); !ok {
		t.Fatal("read turn must be indexed to its InteractiveRun")
	}
	if _, revisionAfter, err := a.GetWorkLibrary(ctx, l.ID); err != nil || revisionAfter != revision {
		t.Fatalf("library revision must not change: err=%v before=%s after=%s", err, revision, revisionAfter)
	}

	// 全通道落盘扫描 + run ledger 事件形态。
	ledgers := assertGamePersistenceChannelsMetadataOnly(t, "read turn", root, libraryPath, gameFixtureMarkers)
	assertReadToolLedgerEventMetadataOnly(t, "read turn", ledgers)

	// regenerate：空 InteractiveTaskInput 服务端复用原绑定，新 run 的落盘同样干净。
	task2 := svc.startInteractiveTask(ctx, story.ID, "main", message, nil, turnID, "", InteractiveTaskInput{})
	if task2 == nil {
		t.Fatal("regenerate task must start")
	}
	events2 := drainInteractiveTaskEvents(t, task2, 60*time.Second)
	assertNoErrorEvents(t, "regenerate", events2)
	if ev, ok := firstEventOfType(events2, "library_context_state"); !ok {
		t.Fatalf("regenerate must re-emit the library state event (%v)", eventTypes(events2))
	} else if data, ok := ev.Data.(map[string]any); !ok || data["state"] != "active" {
		t.Fatalf("regenerate state event must be active: %#v", ev.Data)
	}
	turn2ID := persistedTurnID(t, "regenerate", events2)
	runID, _ := worldContexts.interactiveRuns.findByPersistedTurn(story.ID, "main", turnID)
	runID2, ok := worldContexts.interactiveRuns.findByPersistedTurn(story.ID, "main", turn2ID)
	if !ok || runID2 != runID {
		t.Fatalf("regenerate must reuse the original InteractiveRun: got %q want %q", runID2, runID)
	}
	record2, _ := worldContexts.interactiveRuns.snapshot(runID2)
	if record2.library == nil || record2.library.expectedRevision != revision || record2.library.libraryID != l.ID {
		t.Fatalf("regenerate must keep the original library binding: %#v", record2.library)
	}
	ledgers2 := assertGamePersistenceChannelsMetadataOnly(t, "regenerate", root, libraryPath, gameFixtureMarkers)
	assertReadToolLedgerEventMetadataOnly(t, "regenerate", ledgers2)
}
