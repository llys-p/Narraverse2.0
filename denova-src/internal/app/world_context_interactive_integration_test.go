package app

import (
	"bytes"
	"context"
	"testing"

	"denova/internal/worldcontext"
)

func TestWorldContextInteractiveRun_NormalRegenerateAndNextTurnLifecycle(t *testing.T) {
	svc := &WorldContextService{
		interactiveRuns: newInteractiveRunRegistry(interactiveRunRegistryConfig{}),
	}

	initial, err := svc.prepareInteractiveTaskRun("story-1", "main", "", "task-initial")
	if err != nil || !initial.tracked || !initial.created {
		t.Fatalf("initial task should create and index a run: binding=%#v err=%v", initial, err)
	}
	if !svc.markInteractiveTaskTerminal(initial, "task-initial") {
		t.Fatal("initial task should become terminal")
	}
	if err := svc.recordInteractiveTurnPersisted(initial, "task-initial", "turn-1"); err != nil {
		t.Fatalf("record persisted initial turn: %v", err)
	}

	regenerate, err := svc.prepareInteractiveTaskRun("story-1", "main", "turn-1", "task-regenerate")
	if err != nil || !regenerate.tracked || regenerate.created {
		t.Fatalf("regenerate should reuse the persisted turn run: binding=%#v err=%v", regenerate, err)
	}
	if regenerate.runID != initial.runID {
		t.Fatalf("regenerate must reuse InteractiveRun: initial=%q regenerate=%q", initial.runID, regenerate.runID)
	}
	if !svc.markInteractiveTaskTerminal(regenerate, "task-regenerate") {
		t.Fatal("regenerate task should become terminal")
	}
	if err := svc.recordInteractiveTurnPersisted(regenerate, "task-regenerate", "turn-1b"); err != nil {
		t.Fatalf("record persisted regenerated turn: %v", err)
	}

	next, err := svc.prepareInteractiveTaskRun("story-1", "main", "", "task-next")
	if err != nil || !next.created || next.runID == initial.runID {
		t.Fatalf("ordinary next turn must create a new InteractiveRun: binding=%#v err=%v", next, err)
	}

	snapshot, ok := svc.interactiveRuns.snapshot(initial.runID)
	if !ok || len(snapshot.meta.taskIDs) != 2 || len(snapshot.meta.turnIDs) != 2 {
		t.Fatalf("original run should retain initial+regenerate attempts: %#v", snapshot)
	}
}

func TestWorldContextInteractiveRun_RegenerateMissCreatesBareRunWithoutGuessing(t *testing.T) {
	svc := &WorldContextService{
		interactiveRuns: newInteractiveRunRegistry(interactiveRunRegistryConfig{}),
	}

	binding, err := svc.prepareInteractiveTaskRun("story-1", "main", "unknown-turn", "task-regenerate")
	if err != nil || !binding.created || !binding.tracked {
		t.Fatalf("unknown regenerate turn should create a new bare run: binding=%#v err=%v", binding, err)
	}
	record, ok := svc.interactiveRuns.snapshot(binding.runID)
	if !ok || record.runContextID != "" {
		t.Fatalf("regenerate miss must not guess or rebuild context: %#v", record)
	}
}

func TestWorldContextInteractiveRun_RollbackRemovesTaskAndNewEmptyRun(t *testing.T) {
	svc := &WorldContextService{
		interactiveRuns: newInteractiveRunRegistry(interactiveRunRegistryConfig{}),
	}
	binding, err := svc.prepareInteractiveTaskRun("story-1", "main", "", "task-pending")
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}

	svc.rollbackInteractiveTaskRun(binding, "task-pending")
	if _, ok := svc.interactiveRuns.snapshot(binding.runID); ok {
		t.Fatal("rollback of a newly-created empty run must remove it")
	}
	if _, ok := svc.interactiveRuns.findByTask("story-1", "main", "task-pending"); ok {
		t.Fatal("rollback must remove TaskIndex")
	}
	// Repeated rollback must be harmless.
	svc.rollbackInteractiveTaskRun(binding, "task-pending")
}

func TestWorldContextInteractiveRun_RegenerateReusesSameContextIdentityAndBytes(t *testing.T) {
	a, worldValue, revision := newWorldContextTestApp(t)
	svc := newWorldContextService(a)
	initial, err := svc.prepareInteractiveTaskRun("story-1", "main", "", "task-initial")
	if err != nil {
		t.Fatalf("prepare initial: %v", err)
	}
	record, _ := svc.interactiveRuns.snapshot(initial.runID)
	runContext, _, err := svc.BindWorldRun(context.Background(), worldcontext.ConsumerGame, record.scopeKey, worldRef(worldValue, revision))
	if err != nil {
		t.Fatalf("bind world context to InteractiveRun scope: %v", err)
	}
	if err := svc.interactiveRuns.bindContext(initial.runID, runContext.ID(), record.scopeKey); err != nil {
		t.Fatalf("bind context ref: %v", err)
	}
	bytesBefore := runContext.ModelViewBytes()
	if !svc.markInteractiveTaskTerminal(initial, "task-initial") {
		t.Fatal("mark initial terminal")
	}
	if err := svc.recordInteractiveTurnPersisted(initial, "task-initial", "turn-1"); err != nil {
		t.Fatalf("record turn: %v", err)
	}

	regenerate, err := svc.prepareInteractiveTaskRun("story-1", "main", "turn-1", "task-regenerate")
	if err != nil || regenerate.runID != initial.runID {
		t.Fatalf("regenerate should reuse run: binding=%#v err=%v", regenerate, err)
	}
	afterRecord, _ := svc.interactiveRuns.snapshot(regenerate.runID)
	afterContext, err := svc.GetWorldRunByID(afterRecord.runContextID, worldcontext.ConsumerGame)
	if err != nil {
		t.Fatalf("reused run context unavailable: %v", err)
	}
	if afterContext.ID() != runContext.ID() || !bytes.Equal(afterContext.ModelViewBytes(), bytesBefore) {
		t.Fatal("regenerate must preserve runContext ID and final ModelView bytes")
	}
}

func TestWorldContextInteractiveRun_StaleCleanupCannotDestroyReplacementContext(t *testing.T) {
	a, worldValue, revision := newWorldContextTestApp(t)
	svc := newWorldContextService(a)
	binding, err := svc.prepareInteractiveTaskRun("story-1", "main", "", "task-1")
	if err != nil {
		t.Fatalf("prepare run: %v", err)
	}
	record, _ := svc.interactiveRuns.snapshot(binding.runID)
	oldContext, _, err := svc.BindWorldRun(context.Background(), worldcontext.ConsumerGame, record.scopeKey, worldRef(worldValue, revision))
	if err != nil {
		t.Fatalf("bind old context: %v", err)
	}
	staleRef := interactiveRunContextRef{runContextID: oldContext.ID(), scopeKey: record.scopeKey}

	replacementRef := worldcontext.Ref{
		WorldID: worldValue.ID, ExpectedWorldRevision: revision,
		Selection: worldcontext.Selection{RuleIndexes: []int{0}},
	}
	replacement, outcome, err := svc.BindWorldRun(context.Background(), worldcontext.ConsumerGame, record.scopeKey, replacementRef)
	if err != nil || outcome != worldcontext.OutcomeReplaced || replacement.ID() == oldContext.ID() {
		t.Fatalf("replace context: outcome=%s old=%s replacement=%v err=%v", outcome, oldContext.ID(), replacement, err)
	}

	if svc.releaseInteractiveRunContext(staleRef) {
		t.Fatal("stale cleanup must not release a replacement context at the same scope")
	}
	if got, err := svc.GetWorldRunByID(replacement.ID(), worldcontext.ConsumerGame); err != nil || got.ID() != replacement.ID() {
		t.Fatalf("replacement context must survive stale cleanup: got=%v err=%v", got, err)
	}
}
