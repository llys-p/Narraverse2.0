package app

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func newInteractiveRunTestRegistry() (*interactiveRunRegistry, func(time.Duration)) {
	now := time.Date(2026, 9, 11, 21, 30, 0, 0, time.UTC)
	nextID := 0
	r := newInteractiveRunRegistry(interactiveRunRegistryConfig{
		Now: func() time.Time { return now },
		NewID: func() (interactiveRunID, error) {
			nextID++
			return interactiveRunID("run-" + itoaForInteractiveRunTest(nextID)), nil
		},
	})
	return r, func(d time.Duration) { now = now.Add(d) }
}

func TestInteractiveRunRegistry_RunOwnsMultipleTaskAttemptsAndPersistedTurns(t *testing.T) {
	r, _ := newInteractiveRunTestRegistry()
	run, err := r.create("story-1", "main")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if run.id == "" || run.meta.storyID != "story-1" || run.meta.branchID != "main" {
		t.Fatalf("run identity mismatch: %#v", run)
	}

	if err := r.attachTask(run.id, "story-1", "main", "task-initial"); err != nil {
		t.Fatalf("attach initial: %v", err)
	}
	if got, err := r.recordTurnPersisted("story-1", "main", "task-initial", "turn-1"); err != nil || got != run.id {
		t.Fatalf("record initial turn: run=%q err=%v", got, err)
	}
	if !r.markTaskTerminal("story-1", "main", "task-initial") {
		t.Fatal("initial task should become terminal")
	}

	if err := r.attachTask(run.id, "story-1", "main", "task-regenerate"); err != nil {
		t.Fatalf("attach regenerate: %v", err)
	}
	if got, err := r.recordTurnPersisted("story-1", "main", "task-regenerate", "turn-2"); err != nil || got != run.id {
		t.Fatalf("record regenerate turn: run=%q err=%v", got, err)
	}

	got, ok := r.findByPersistedTurn("story-1", "main", "turn-1")
	if !ok || got != run.id {
		t.Fatalf("turn-1 should resolve original run, got=%q ok=%v", got, ok)
	}
	got, ok = r.findByPersistedTurn("story-1", "main", "turn-2")
	if !ok || got != run.id {
		t.Fatalf("turn-2 should resolve original run, got=%q ok=%v", got, ok)
	}

	snapshot, ok := r.snapshot(run.id)
	if !ok {
		t.Fatal("run snapshot missing")
	}
	if len(snapshot.meta.taskIDs) != 2 || len(snapshot.meta.turnIDs) != 2 || len(snapshot.meta.activeTaskIDs) != 1 {
		t.Fatalf("run reverse indexes mismatch: tasks=%d turns=%d active=%d", len(snapshot.meta.taskIDs), len(snapshot.meta.turnIDs), len(snapshot.meta.activeTaskIDs))
	}
}

func TestInteractiveRunRegistry_IndexesRejectCrossRunOverwrite(t *testing.T) {
	r, _ := newInteractiveRunTestRegistry()
	a, _ := r.create("story-1", "main")
	b, _ := r.create("story-1", "main")

	if err := r.attachTask(a.id, "story-1", "main", "task-1"); err != nil {
		t.Fatalf("attach task to a: %v", err)
	}
	if err := r.attachTask(a.id, "story-1", "main", "task-1"); err != nil {
		t.Fatalf("same task/same run should be idempotent: %v", err)
	}
	if err := r.attachTask(b.id, "story-1", "main", "task-1"); !errors.Is(err, errInteractiveRunConflict) {
		t.Fatalf("same task must not move across runs, got %v", err)
	}
	if _, err := r.recordTurnPersisted("story-1", "other", "task-1", "turn-1"); !errors.Is(err, errInteractiveRunNotFound) {
		t.Fatalf("story/branch mismatch must not resolve task, got %v", err)
	}
	if _, err := r.recordTurnPersisted("story-1", "main", "task-1", "turn-1"); err != nil {
		t.Fatalf("record turn for a: %v", err)
	}

	if err := r.attachTask(b.id, "story-1", "main", "task-2"); err != nil {
		t.Fatalf("attach task to b: %v", err)
	}
	if _, err := r.recordTurnPersisted("story-1", "main", "task-2", "turn-1"); !errors.Is(err, errInteractiveRunConflict) {
		t.Fatalf("same turn must not move across runs, got %v", err)
	}
	if got, ok := r.findByPersistedTurn("story-1", "main", "turn-1"); !ok || got != a.id {
		t.Fatalf("conflict must preserve original turn mapping, got=%q ok=%v", got, ok)
	}
}

func TestInteractiveRunRegistry_ContextDetachAndDestroyAreIdempotent(t *testing.T) {
	r, _ := newInteractiveRunTestRegistry()
	run, _ := r.create("story-1", "main")
	if err := r.bindContext(run.id, "context-1", "story:story-1|branch:main|run:"+string(run.id)); err != nil {
		t.Fatalf("bind context: %v", err)
	}
	if err := r.attachTask(run.id, "story-1", "main", "task-1"); err != nil {
		t.Fatalf("attach task: %v", err)
	}
	if _, err := r.recordTurnPersisted("story-1", "main", "task-1", "turn-1"); err != nil {
		t.Fatalf("record turn: %v", err)
	}

	detached := r.detachStoryContexts("story-1")
	if len(detached) != 1 || detached[0].runContextID != "context-1" || detached[0].scopeKey == "" {
		t.Fatalf("first detach should return exactly one context ref: %#v", detached)
	}
	if again := r.detachStoryContexts("story-1"); len(again) != 0 {
		t.Fatalf("repeated detach must be no-op, got %#v", again)
	}
	if got, ok := r.findByPersistedTurn("story-1", "main", "turn-1"); !ok || got != run.id {
		t.Fatalf("detach must preserve indexes until TTL, got=%q ok=%v", got, ok)
	}

	contextRef, destroyed := r.destroy(run.id)
	if !destroyed || !contextRef.empty() {
		t.Fatalf("destroy after detach should remove run without second context release: destroyed=%v ref=%#v", destroyed, contextRef)
	}
	if _, destroyed := r.destroy(run.id); destroyed {
		t.Fatal("repeated destroy must be no-op")
	}
	if _, ok := r.findByPersistedTurn("story-1", "main", "turn-1"); ok {
		t.Fatal("destroy must remove turn index")
	}
	if _, ok := r.findByTask("story-1", "main", "task-1"); ok {
		t.Fatal("destroy must remove task index")
	}
}

func TestInteractiveRunRegistry_TTLSkipsActiveTasksThenCleansAllIndexes(t *testing.T) {
	r, advance := newInteractiveRunTestRegistry()
	run, _ := r.create("story-1", "main")
	if err := r.bindContext(run.id, "context-1", run.scopeKey); err != nil {
		t.Fatalf("bind context: %v", err)
	}
	if err := r.attachTask(run.id, "story-1", "main", "task-1"); err != nil {
		t.Fatalf("attach task: %v", err)
	}
	if _, err := r.recordTurnPersisted("story-1", "main", "task-1", "turn-1"); err != nil {
		t.Fatalf("record turn: %v", err)
	}

	advance(7 * time.Hour)
	if result := r.sweep(); result.RunsExpired != 0 {
		t.Fatalf("active task run must not be swept, got %#v", result)
	}
	if !r.markTaskTerminal("story-1", "main", "task-1") {
		t.Fatal("task should become terminal")
	}
	result := r.sweep()
	if result.RunsExpired != 1 || len(result.Contexts) != 1 || result.Contexts[0].runContextID != "context-1" {
		t.Fatalf("terminal expired run should be swept with one context release: %#v", result)
	}
	if result := r.sweep(); result.RunsExpired != 0 || len(result.Contexts) != 0 {
		t.Fatalf("repeated sweep must be idempotent: %#v", result)
	}
	if _, ok := r.findByTask("story-1", "main", "task-1"); ok {
		t.Fatal("sweep must remove task index")
	}
	if _, ok := r.findByPersistedTurn("story-1", "main", "turn-1"); ok {
		t.Fatal("sweep must remove turn index")
	}
}

func TestInteractiveRunRegistry_IdleTTLAndDestroyReturnContextOnlyOnce(t *testing.T) {
	r, advance := newInteractiveRunTestRegistry()
	idleRun, _ := r.create("story-idle", "main")
	if err := r.bindContext(idleRun.id, "context-idle", idleRun.scopeKey); err != nil {
		t.Fatalf("bind idle context: %v", err)
	}
	advance(31 * time.Minute)
	result := r.sweep()
	if result.RunsExpired != 1 || len(result.Contexts) != 1 || result.Contexts[0].runContextID != "context-idle" {
		t.Fatalf("idle TTL should return one context exactly once: %#v", result)
	}
	if result := r.sweep(); result.RunsExpired != 0 || len(result.Contexts) != 0 {
		t.Fatalf("second idle sweep must be empty: %#v", result)
	}

	destroyRun, _ := r.create("story-destroy", "main")
	if err := r.bindContext(destroyRun.id, "context-destroy", destroyRun.scopeKey); err != nil {
		t.Fatalf("bind destroy context: %v", err)
	}
	ref, ok := r.destroy(destroyRun.id)
	if !ok || ref.runContextID != "context-destroy" || ref.scopeKey != destroyRun.scopeKey {
		t.Fatalf("destroy should return its context ref: ok=%v ref=%#v", ok, ref)
	}
	if ref, ok := r.destroy(destroyRun.id); ok || !ref.empty() {
		t.Fatalf("repeated destroy must not return cleanup ownership: ok=%v ref=%#v", ok, ref)
	}
}

func TestInteractiveRunRegistry_ConcurrentTaskAttachHasSingleOwner(t *testing.T) {
	r, _ := newInteractiveRunTestRegistry()
	a, _ := r.create("story-1", "main")
	b, _ := r.create("story-1", "main")

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, runID := range []interactiveRunID{a.id, b.id} {
		wg.Add(1)
		go func(id interactiveRunID) {
			defer wg.Done()
			errs <- r.attachTask(id, "story-1", "main", "task-shared")
		}(runID)
	}
	wg.Wait()
	close(errs)
	successes, conflicts := 0, 0
	for err := range errs {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, errInteractiveRunConflict):
			conflicts++
		default:
			t.Fatalf("unexpected attach error: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("task must have one run owner, successes=%d conflicts=%d", successes, conflicts)
	}
	owner, ok := r.findByTask("story-1", "main", "task-shared")
	if !ok || (owner != a.id && owner != b.id) {
		t.Fatalf("task index owner invalid: owner=%q ok=%v", owner, ok)
	}
	other := a.id
	if owner == a.id {
		other = b.id
	}
	otherSnapshot, _ := r.snapshot(other)
	if len(otherSnapshot.meta.taskIDs) != 0 || len(otherSnapshot.meta.activeTaskIDs) != 0 {
		t.Fatalf("losing run must remain untouched: %#v", otherSnapshot.meta)
	}
}

func TestInteractiveRunRegistry_RejectsInvalidIdentityAndConcurrentActiveTask(t *testing.T) {
	r, _ := newInteractiveRunTestRegistry()
	if _, err := r.create("", "main"); !errors.Is(err, errInteractiveRunInvalid) {
		t.Fatalf("empty story must be invalid, got %v", err)
	}
	run, _ := r.create("story-1", "main")
	if err := r.attachTask(run.id, "story-1", "main", "task-1"); err != nil {
		t.Fatalf("attach first: %v", err)
	}
	if err := r.attachTask(run.id, "story-1", "main", "task-2"); !errors.Is(err, errInteractiveRunConflict) {
		t.Fatalf("a run may have only one active task, got %v", err)
	}
	if !r.markTaskTerminal("story-1", "main", "task-1") {
		t.Fatal("terminal first")
	}
	if err := r.attachTask(run.id, "story-1", "main", "task-2"); err != nil {
		t.Fatalf("attach after terminal: %v", err)
	}
}

func itoaForInteractiveRunTest(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [12]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
