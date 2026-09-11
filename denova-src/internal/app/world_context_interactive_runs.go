package app

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"denova/internal/worldcontext"
)

const (
	defaultMaxInteractiveRuns        = 64
	defaultInteractiveRunIdleTTL     = 30 * time.Minute
	defaultInteractiveRunAbsoluteTTL = 6 * time.Hour
	interactiveRunIDRandomBytes      = 32
)

var (
	errInteractiveRunInvalid  = errors.New("interactive run identity is invalid")
	errInteractiveRunNotFound = errors.New("interactive run was not found")
	errInteractiveRunConflict = errors.New("interactive run index conflicts with an existing run")
	errInteractiveRunCapacity = errors.New("interactive run registry is at capacity")
)

type interactiveRunID string

type interactiveTaskRunKey struct {
	storyID  string
	branchID string
	taskID   string
}

type interactiveTurnRunKey struct {
	storyID  string
	branchID string
	turnID   string
}

// interactiveRunContextRef is only an opaque pointer into worldcontext.Registry.
// It never owns or copies World, Snapshot, projection, model bytes, or story state.
type interactiveRunContextRef struct {
	runContextID string
	scopeKey     string
}

func (r interactiveRunContextRef) empty() bool {
	return r.runContextID == "" && r.scopeKey == ""
}

type interactiveRunMeta struct {
	storyID       string
	branchID      string
	taskIDs       map[string]struct{}
	turnIDs       map[string]struct{}
	activeTaskIDs map[string]struct{}
	createdAt     time.Time
	lastUsedAt    time.Time
}

// interactiveRunRecord is a game-turn identity. Task IDs are execution attempts;
// the optional context reference points to derived, in-memory data owned elsewhere.
type interactiveRunRecord struct {
	id           interactiveRunID
	scopeKey     string
	runContextID string
	meta         interactiveRunMeta
}

type interactiveRunRegistryConfig struct {
	MaxRuns     int
	IdleTTL     time.Duration
	AbsoluteTTL time.Duration
	Now         func() time.Time
	NewID       func() (interactiveRunID, error)
}

type interactiveRunSweepResult struct {
	RunsExpired int
	Contexts    []interactiveRunContextRef
}

// interactiveTaskRunBinding is transient orchestration metadata. It is not
// stored in Task, events, World files, or story persistence.
type interactiveTaskRunBinding struct {
	runID    interactiveRunID
	storyID  string
	branchID string
	created  bool
	tracked  bool
}

// interactiveRunRegistry contains only process-local relationship indexes.
// It is not a World, Task, turn, or context content store.
type interactiveRunRegistry struct {
	mu sync.Mutex

	taskRuns map[interactiveTaskRunKey]interactiveRunID
	turnRuns map[interactiveTurnRunKey]interactiveRunID
	runs     map[interactiveRunID]*interactiveRunRecord

	cfg interactiveRunRegistryConfig
}

func newInteractiveRunRegistry(cfg interactiveRunRegistryConfig) *interactiveRunRegistry {
	if cfg.MaxRuns <= 0 {
		cfg.MaxRuns = defaultMaxInteractiveRuns
	}
	if cfg.IdleTTL <= 0 {
		cfg.IdleTTL = defaultInteractiveRunIdleTTL
	}
	if cfg.AbsoluteTTL <= 0 {
		cfg.AbsoluteTTL = defaultInteractiveRunAbsoluteTTL
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.NewID == nil {
		cfg.NewID = newInteractiveRunID
	}
	return &interactiveRunRegistry{
		taskRuns: map[interactiveTaskRunKey]interactiveRunID{},
		turnRuns: map[interactiveTurnRunKey]interactiveRunID{},
		runs:     map[interactiveRunID]*interactiveRunRecord{},
		cfg:      cfg,
	}
}

// create always creates a new turn-level identity. Callers must explicitly sweep
// and release returned context refs before retrying a capacity failure.
func (r *interactiveRunRegistry) create(storyID, branchID string) (*interactiveRunRecord, error) {
	storyID, branchID = strings.TrimSpace(storyID), strings.TrimSpace(branchID)
	if storyID == "" || branchID == "" {
		return nil, errInteractiveRunInvalid
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.runs) >= r.cfg.MaxRuns {
		return nil, errInteractiveRunCapacity
	}
	id, err := r.cfg.NewID()
	if err != nil || id == "" {
		if err == nil {
			err = errInteractiveRunInvalid
		}
		return nil, fmt.Errorf("generate interactive run id: %w", err)
	}
	if _, exists := r.runs[id]; exists {
		return nil, errInteractiveRunConflict
	}
	now := r.cfg.Now()
	record := &interactiveRunRecord{
		id:       id,
		scopeKey: interactiveRunScopeKey(storyID, branchID, id),
		meta: interactiveRunMeta{
			storyID:       storyID,
			branchID:      branchID,
			taskIDs:       map[string]struct{}{},
			turnIDs:       map[string]struct{}{},
			activeTaskIDs: map[string]struct{}{},
			createdAt:     now,
			lastUsedAt:    now,
		},
	}
	r.runs[id] = record
	return cloneInteractiveRunRecord(record), nil
}

func (r *interactiveRunRegistry) bindContext(runID interactiveRunID, runContextID, scopeKey string) error {
	runContextID, scopeKey = strings.TrimSpace(runContextID), strings.TrimSpace(scopeKey)
	if runContextID == "" || scopeKey == "" {
		return errInteractiveRunInvalid
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	record, ok := r.runs[runID]
	if !ok {
		return errInteractiveRunNotFound
	}
	if record.runContextID != "" || record.scopeKey != scopeKey {
		if record.runContextID == runContextID && record.scopeKey == scopeKey {
			return nil
		}
		return errInteractiveRunConflict
	}
	record.runContextID = runContextID
	record.meta.lastUsedAt = r.cfg.Now()
	return nil
}

func (r *interactiveRunRegistry) attachTask(runID interactiveRunID, storyID, branchID, taskID string) error {
	storyID, branchID, taskID = strings.TrimSpace(storyID), strings.TrimSpace(branchID), strings.TrimSpace(taskID)
	if runID == "" || storyID == "" || branchID == "" || taskID == "" {
		return errInteractiveRunInvalid
	}
	key := interactiveTaskRunKey{storyID: storyID, branchID: branchID, taskID: taskID}

	r.mu.Lock()
	defer r.mu.Unlock()
	record, ok := r.runs[runID]
	if !ok || record.meta.storyID != storyID || record.meta.branchID != branchID {
		return errInteractiveRunNotFound
	}
	if existing, exists := r.taskRuns[key]; exists {
		if existing == runID {
			return nil
		}
		return errInteractiveRunConflict
	}
	if len(record.meta.activeTaskIDs) != 0 {
		return errInteractiveRunConflict
	}
	r.taskRuns[key] = runID
	record.meta.taskIDs[taskID] = struct{}{}
	record.meta.activeTaskIDs[taskID] = struct{}{}
	record.meta.lastUsedAt = r.cfg.Now()
	return nil
}

func (r *interactiveRunRegistry) findByTask(storyID, branchID, taskID string) (interactiveRunID, bool) {
	key := interactiveTaskRunKey{
		storyID: strings.TrimSpace(storyID), branchID: strings.TrimSpace(branchID), taskID: strings.TrimSpace(taskID),
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	runID, ok := r.taskRuns[key]
	if !ok {
		return "", false
	}
	record := r.runs[runID]
	if record == nil || r.expiredLocked(record, r.cfg.Now()) {
		return "", false
	}
	record.meta.lastUsedAt = r.cfg.Now()
	return runID, true
}

func (r *interactiveRunRegistry) findByPersistedTurn(storyID, branchID, turnID string) (interactiveRunID, bool) {
	key := interactiveTurnRunKey{
		storyID: strings.TrimSpace(storyID), branchID: strings.TrimSpace(branchID), turnID: strings.TrimSpace(turnID),
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	runID, ok := r.turnRuns[key]
	if !ok {
		return "", false
	}
	record := r.runs[runID]
	if record == nil || r.expiredLocked(record, r.cfg.Now()) {
		return "", false
	}
	record.meta.lastUsedAt = r.cfg.Now()
	return runID, true
}

func (r *interactiveRunRegistry) recordTurnPersisted(storyID, branchID, taskID, turnID string) (interactiveRunID, error) {
	storyID, branchID = strings.TrimSpace(storyID), strings.TrimSpace(branchID)
	taskID, turnID = strings.TrimSpace(taskID), strings.TrimSpace(turnID)
	if storyID == "" || branchID == "" || taskID == "" || turnID == "" {
		return "", errInteractiveRunInvalid
	}
	taskKey := interactiveTaskRunKey{storyID: storyID, branchID: branchID, taskID: taskID}
	turnKey := interactiveTurnRunKey{storyID: storyID, branchID: branchID, turnID: turnID}

	r.mu.Lock()
	defer r.mu.Unlock()
	runID, ok := r.taskRuns[taskKey]
	if !ok {
		return "", errInteractiveRunNotFound
	}
	record := r.runs[runID]
	if record == nil || record.meta.storyID != storyID || record.meta.branchID != branchID {
		return "", errInteractiveRunNotFound
	}
	if existing, exists := r.turnRuns[turnKey]; exists {
		if existing == runID {
			return runID, nil
		}
		return "", errInteractiveRunConflict
	}
	r.turnRuns[turnKey] = runID
	record.meta.turnIDs[turnID] = struct{}{}
	record.meta.lastUsedAt = r.cfg.Now()
	return runID, nil
}

func (r *interactiveRunRegistry) markTaskTerminal(storyID, branchID, taskID string) bool {
	key := interactiveTaskRunKey{
		storyID: strings.TrimSpace(storyID), branchID: strings.TrimSpace(branchID), taskID: strings.TrimSpace(taskID),
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	runID, ok := r.taskRuns[key]
	if !ok {
		return false
	}
	record := r.runs[runID]
	if record == nil {
		return false
	}
	if _, active := record.meta.activeTaskIDs[key.taskID]; !active {
		return false
	}
	delete(record.meta.activeTaskIDs, key.taskID)
	record.meta.lastUsedAt = r.cfg.Now()
	return true
}

func (r *interactiveRunRegistry) detachContext(runID interactiveRunID) (interactiveRunContextRef, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	record, ok := r.runs[runID]
	if !ok || record.runContextID == "" {
		return interactiveRunContextRef{}, false
	}
	return takeInteractiveRunContextLocked(record), true
}

// detachTask rolls back a Task association that never started or was never
// committed. It removes both the forward index and the run's reverse sets.
func (r *interactiveRunRegistry) detachTask(runID interactiveRunID, storyID, branchID, taskID string) bool {
	key := interactiveTaskRunKey{
		storyID: strings.TrimSpace(storyID), branchID: strings.TrimSpace(branchID), taskID: strings.TrimSpace(taskID),
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	indexedRunID, ok := r.taskRuns[key]
	if !ok || indexedRunID != runID {
		return false
	}
	record := r.runs[runID]
	if record == nil {
		delete(r.taskRuns, key)
		return true
	}
	delete(r.taskRuns, key)
	delete(record.meta.taskIDs, key.taskID)
	delete(record.meta.activeTaskIDs, key.taskID)
	record.meta.lastUsedAt = r.cfg.Now()
	return true
}

// detachStoryContexts transfers cleanup ownership to the caller while retaining
// task/turn mappings until run TTL expiry.
func (r *interactiveRunRegistry) detachStoryContexts(storyID string) []interactiveRunContextRef {
	storyID = strings.TrimSpace(storyID)
	r.mu.Lock()
	defer r.mu.Unlock()
	refs := make([]interactiveRunContextRef, 0)
	for _, record := range r.runs {
		if record.meta.storyID != storyID || record.runContextID == "" {
			continue
		}
		refs = append(refs, takeInteractiveRunContextLocked(record))
		record.meta.lastUsedAt = r.cfg.Now()
	}
	sortInteractiveRunContextRefs(refs)
	return refs
}

func (r *interactiveRunRegistry) destroy(runID interactiveRunID) (interactiveRunContextRef, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.destroyLocked(runID)
}

// reclaimOldestTerminal removes one least-recently-used run that has no active
// Task. The returned context ref gives the caller sole release responsibility.
func (r *interactiveRunRegistry) reclaimOldestTerminal() (interactiveRunContextRef, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var victim *interactiveRunRecord
	for _, record := range r.runs {
		if len(record.meta.activeTaskIDs) != 0 {
			continue
		}
		if victim == nil || record.meta.lastUsedAt.Before(victim.meta.lastUsedAt) {
			victim = record
		}
	}
	if victim == nil {
		return interactiveRunContextRef{}, false
	}
	return r.destroyLocked(victim.id)
}

func (r *interactiveRunRegistry) destroyLocked(runID interactiveRunID) (interactiveRunContextRef, bool) {
	record, ok := r.runs[runID]
	if !ok {
		return interactiveRunContextRef{}, false
	}
	for taskID := range record.meta.taskIDs {
		delete(r.taskRuns, interactiveTaskRunKey{storyID: record.meta.storyID, branchID: record.meta.branchID, taskID: taskID})
	}
	for turnID := range record.meta.turnIDs {
		delete(r.turnRuns, interactiveTurnRunKey{storyID: record.meta.storyID, branchID: record.meta.branchID, turnID: turnID})
	}
	ref := takeInteractiveRunContextLocked(record)
	delete(r.runs, runID)
	return ref, true
}

func (r *interactiveRunRegistry) sweep() interactiveRunSweepResult {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.cfg.Now()
	result := interactiveRunSweepResult{}
	for runID, record := range r.runs {
		if len(record.meta.activeTaskIDs) != 0 || !r.expiredLocked(record, now) {
			continue
		}
		ref, _ := r.destroyLocked(runID)
		result.RunsExpired++
		if !ref.empty() {
			result.Contexts = append(result.Contexts, ref)
		}
	}
	sortInteractiveRunContextRefs(result.Contexts)
	return result
}

func (r *interactiveRunRegistry) expiredLocked(record *interactiveRunRecord, now time.Time) bool {
	return now.Sub(record.meta.lastUsedAt) >= r.cfg.IdleTTL || now.Sub(record.meta.createdAt) >= r.cfg.AbsoluteTTL
}

func (r *interactiveRunRegistry) snapshot(runID interactiveRunID) (*interactiveRunRecord, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	record, ok := r.runs[runID]
	if !ok {
		return nil, false
	}
	return cloneInteractiveRunRecord(record), true
}

func takeInteractiveRunContextLocked(record *interactiveRunRecord) interactiveRunContextRef {
	if record.runContextID == "" {
		return interactiveRunContextRef{}
	}
	ref := interactiveRunContextRef{runContextID: record.runContextID, scopeKey: record.scopeKey}
	record.runContextID = ""
	return ref
}

func cloneInteractiveRunRecord(record *interactiveRunRecord) *interactiveRunRecord {
	if record == nil {
		return nil
	}
	copyRecord := *record
	copyRecord.meta.taskIDs = cloneStringSet(record.meta.taskIDs)
	copyRecord.meta.turnIDs = cloneStringSet(record.meta.turnIDs)
	copyRecord.meta.activeTaskIDs = cloneStringSet(record.meta.activeTaskIDs)
	return &copyRecord
}

func cloneStringSet(source map[string]struct{}) map[string]struct{} {
	copySet := make(map[string]struct{}, len(source))
	for value := range source {
		copySet[value] = struct{}{}
	}
	return copySet
}

func sortInteractiveRunContextRefs(refs []interactiveRunContextRef) {
	sort.Slice(refs, func(i, j int) bool {
		if refs[i].scopeKey == refs[j].scopeKey {
			return refs[i].runContextID < refs[j].runContextID
		}
		return refs[i].scopeKey < refs[j].scopeKey
	})
}

func interactiveRunScopeKey(storyID, branchID string, runID interactiveRunID) string {
	return "story:" + storyID + "|branch:" + branchID + "|run:" + string(runID)
}

func newInteractiveRunID() (interactiveRunID, error) {
	random := make([]byte, interactiveRunIDRandomBytes)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return interactiveRunID(base64.RawURLEncoding.EncodeToString(random)), nil
}

// prepareInteractiveTaskRun resolves one turn-level InteractiveRun and indexes
// the pending Task before it may start. A normal turn always creates a new run;
// regenerate only reuses an exact persisted-turn mapping and never guesses.
func (s *WorldContextService) prepareInteractiveTaskRun(storyID, branchID, regenerateFromTurnID, taskID string) (interactiveTaskRunBinding, error) {
	storyID, branchID = strings.TrimSpace(storyID), strings.TrimSpace(branchID)
	regenerateFromTurnID, taskID = strings.TrimSpace(regenerateFromTurnID), strings.TrimSpace(taskID)
	if s == nil || s.interactiveRuns == nil || storyID == "" || branchID == "" || taskID == "" {
		return interactiveTaskRunBinding{}, errInteractiveRunInvalid
	}

	created := false
	var runID interactiveRunID
	if regenerateFromTurnID != "" {
		runID, _ = s.interactiveRuns.findByPersistedTurn(storyID, branchID, regenerateFromTurnID)
	}
	if runID == "" {
		record, err := s.createInteractiveRunWithReclaim(storyID, branchID)
		if err != nil {
			return interactiveTaskRunBinding{}, err
		}
		runID, created = record.id, true
	} else {
		s.refreshInteractiveRunContext(runID)
	}

	binding := interactiveTaskRunBinding{
		runID: runID, storyID: storyID, branchID: branchID, created: created,
	}
	if err := s.interactiveRuns.attachTask(runID, storyID, branchID, taskID); err != nil {
		if created {
			s.destroyInteractiveRun(runID)
		}
		return interactiveTaskRunBinding{}, err
	}
	binding.tracked = true
	return binding, nil
}

func (s *WorldContextService) createInteractiveRunWithReclaim(storyID, branchID string) (*interactiveRunRecord, error) {
	record, err := s.interactiveRuns.create(storyID, branchID)
	if !errors.Is(err, errInteractiveRunCapacity) {
		return record, err
	}
	s.releaseInteractiveRunContexts(s.interactiveRuns.sweep().Contexts)
	record, err = s.interactiveRuns.create(storyID, branchID)
	if !errors.Is(err, errInteractiveRunCapacity) {
		return record, err
	}
	if ref, reclaimed := s.interactiveRuns.reclaimOldestTerminal(); reclaimed {
		s.releaseInteractiveRunContext(ref)
		return s.interactiveRuns.create(storyID, branchID)
	}
	return nil, err
}

func (s *WorldContextService) refreshInteractiveRunContext(runID interactiveRunID) {
	if s.registry == nil {
		return
	}
	record, ok := s.interactiveRuns.snapshot(runID)
	if !ok || record.runContextID == "" {
		return
	}
	if current, err := s.registry.Reuse(worldcontext.ConsumerGame, record.scopeKey, ""); err == nil && current.ID() == record.runContextID {
		return
	}
	if ref, detached := s.interactiveRuns.detachContext(runID); detached {
		s.releaseInteractiveRunContext(ref)
	}
}

func (s *WorldContextService) recordInteractiveTurnPersisted(binding interactiveTaskRunBinding, taskID, turnID string) error {
	if !binding.tracked {
		return nil
	}
	_, err := s.interactiveRuns.recordTurnPersisted(binding.storyID, binding.branchID, taskID, turnID)
	return err
}

func (s *WorldContextService) markInteractiveTaskTerminal(binding interactiveTaskRunBinding, taskID string) bool {
	return binding.tracked && s != nil && s.interactiveRuns != nil &&
		s.interactiveRuns.markTaskTerminal(binding.storyID, binding.branchID, taskID)
}

func (s *WorldContextService) rollbackInteractiveTaskRun(binding interactiveTaskRunBinding, taskID string) {
	if !binding.tracked || s == nil || s.interactiveRuns == nil {
		return
	}
	s.interactiveRuns.detachTask(binding.runID, binding.storyID, binding.branchID, taskID)
	if binding.created {
		s.destroyInteractiveRun(binding.runID)
	}
}

func (s *WorldContextService) destroyInteractiveRun(runID interactiveRunID) bool {
	if s == nil || s.interactiveRuns == nil {
		return false
	}
	ref, destroyed := s.interactiveRuns.destroy(runID)
	if destroyed {
		s.releaseInteractiveRunContext(ref)
	}
	return destroyed
}

func (s *WorldContextService) releaseInteractiveRunContexts(refs []interactiveRunContextRef) {
	for _, ref := range refs {
		s.releaseInteractiveRunContext(ref)
	}
}

func (s *WorldContextService) releaseInteractiveRunContext(ref interactiveRunContextRef) bool {
	if s == nil || s.registry == nil || ref.empty() {
		return false
	}
	current, err := s.registry.GetByID(ref.runContextID, worldcontext.ConsumerGame)
	if err != nil || current.ScopeKey() != ref.scopeKey {
		return false
	}
	return s.registry.Destroy(worldcontext.ConsumerGame, ref.scopeKey)
}
