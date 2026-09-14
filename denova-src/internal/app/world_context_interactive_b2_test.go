package app

import (
	"encoding/json"
	"strings"
	"testing"

	"denova/internal/worldcontext"
)

// Phase 3.2-B2: InteractiveRun 运行闭环的单元测试。
// Registry 生命周期（create/regenerate/reuse/rollback/TTL）已在
// world_context_interactive_runs_test.go 和 integration_test.go 覆盖。
// 这里锁定 B2 新增的绑定/事件/临时输入边界。

// 1) state event: bare run -> "none"
func TestInteractiveWorldStateEventNone(t *testing.T) {
	ev := interactiveWorldContextStateEvent(nil)
	if ev.Type != "world_context_state" {
		t.Fatalf("event type wrong: %s", ev.Type)
	}
	data, _ := ev.Data.(map[string]any)
	if data["state"] != "none" {
		t.Fatalf("expected none, got %v", data)
	}
}

// 2) state event: degraded placeholder -> "degraded" + errorCode
func TestInteractiveWorldStateEventDegraded(t *testing.T) {
	ev := interactiveWorldContextStateEvent(&interactiveWorldRun{
		scopeKey:     "test-scope",
		degraded:     true,
		degradedCode: "world_not_found",
	})
	data, _ := ev.Data.(map[string]any)
	if data["state"] != "degraded" {
		t.Fatalf("expected degraded, got %v", data)
	}
	if data["errorCode"] != "world_not_found" {
		t.Fatalf("expected errorCode, got %v", data)
	}
}

// 3) state event: nil runContext but non-degraded run -> "none"
func TestInteractiveWorldStateEventNilRunContext(t *testing.T) {
	ev := interactiveWorldContextStateEvent(&interactiveWorldRun{
		scopeKey:   "test-scope",
		runContext: nil,
	})
	data, _ := ev.Data.(map[string]any)
	if data["state"] != "none" {
		t.Fatalf("expected none for nil runContext, got %v", data)
	}
}

// 4) ephemeral input: bare run returns zero value (Present=false)
func TestInteractiveEphemeralInputBare(t *testing.T) {
	in := interactiveEphemeralWorldInput(nil)
	if in.Present() {
		t.Fatal("bare run must yield non-present ephemeral input")
	}
}

// 5) ephemeral input: degraded run (no runContext) returns zero value
func TestInteractiveEphemeralInputDegraded(t *testing.T) {
	in := interactiveEphemeralWorldInput(&interactiveWorldRun{degraded: true})
	if in.Present() {
		t.Fatal("degraded run must yield non-present ephemeral input")
	}
}

// 6) resolveInteractiveRun: bare (no Ref, no handle) returns nil with zero Registry growth
func TestInteractiveResolveBareReturnsNil(t *testing.T) {
	svc := &WorldContextService{
		interactiveRuns: newInteractiveRunRegistry(interactiveRunRegistryConfig{}),
	}
	binding, err := svc.prepareInteractiveTaskRun("s1", "main", "", "task-bare")
	if err != nil {
		t.Fatal(err)
	}
	run, err := svc.resolveInteractiveRun(nil, binding, InteractiveWorldControl{})
	if err != nil || run != nil {
		t.Fatalf("bare control must return nil: run=%v err=%v", run, err)
	}
}

// 7) resolveInteractiveRun: handle-only (no Ref) in B2 returns degraded
func TestInteractiveResolveHandleOnlyDegraded(t *testing.T) {
	svc := &WorldContextService{
		interactiveRuns: newInteractiveRunRegistry(interactiveRunRegistryConfig{}),
	}
	binding, err := svc.prepareInteractiveTaskRun("s1", "main", "", "task-handle")
	if err != nil {
		t.Fatal(err)
	}
	run, err := svc.resolveInteractiveRun(nil, binding, InteractiveWorldControl{
		HasAnalysisHandle: true,
		AnalysisHandle:    strings.Repeat("x", 40),
	})
	if err != nil {
		t.Fatalf("handle-only must not error in B2: %v", err)
	}
	if run == nil || !run.degraded {
		t.Fatalf("handle-only should be degraded placeholder: %+v", run)
	}
}

// 8) reuseInteractiveRunContext: run without bound context returns nil
func TestInteractiveReuseNoBoundContext(t *testing.T) {
	svc := &WorldContextService{
		interactiveRuns: newInteractiveRunRegistry(interactiveRunRegistryConfig{}),
	}
	binding, err := svc.prepareInteractiveTaskRun("s1", "main", "", "task-reuse")
	if err != nil {
		t.Fatal(err)
	}
	if rc := svc.reuseInteractiveRunContext(binding); rc != nil {
		t.Fatal("run without bound context should return nil")
	}
}

// 9) WorldContext 不持久化：event data 不含内部 ID（type separation lock）
func TestInteractiveStateEventNoInternalIDs(t *testing.T) {
	ev := interactiveWorldContextStateEvent(&interactiveWorldRun{
		scopeKey:     "story:s1|branch:main|run:abc",
		degraded:     true,
		degradedCode: "world_not_found",
	})
	raw, _ := json.Marshal(ev.Data)
	s := string(raw)
	for _, leak := range []string{"scopeKey", "runContextID", "taskID", "run_id", "runId"} {
		if strings.Contains(s, leak) {
			t.Fatalf("state event must not leak internal field %q: %s", leak, s)
		}
	}
}

// 10) InteractiveWorldControl.Present() 正确判断
func TestInteractiveWorldControlPresent(t *testing.T) {
	var zero InteractiveWorldControl
	if zero.Present() {
		t.Fatal("zero control must not be Present()")
	}
	if !(InteractiveWorldControl{Ref: &worldcontext.Ref{}}).Present() {
		t.Fatal("Ref-only must be Present()")
	}
	if !(InteractiveWorldControl{HasAnalysisHandle: true}).Present() {
		t.Fatal("handle-only must be Present()")
	}
}
