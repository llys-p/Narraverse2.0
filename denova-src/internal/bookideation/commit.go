package bookideation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"strings"

	"denova/internal/book"
	"denova/internal/keyedlock"
	"denova/internal/workspacechange"
)

// BookOverviewPath is the existing per-book overview document this flow reuses;
// no second overview store is introduced.
const BookOverviewPath = "setting/book-overview.md"

// Commit statuses.
const (
	CommitComplete   = "complete"
	CommitIncomplete = "incomplete"
)

// ErrCommitIncomplete marks a resumable partial success: the book may already
// exist, so the caller must show which stages landed rather than pretending the
// creation happened or silently discarding it.
var ErrCommitIncomplete = errors.New("创建未完成")

var commitLocks = keyedlock.New(strings.ToLower)

// CommitReceipt reports exactly which stages landed. It is complete only when the
// book, its overview and the confirmed entries were all written.
type CommitReceipt struct {
	DraftID          string            `json:"draft_id"`
	Status           string            `json:"status"`
	WorkspacePath    string            `json:"workspace_path,omitempty"`
	Title            string            `json:"title"`
	Stages           []CommitStage     `json:"stages"`
	ItemIDs          map[string]string `json:"item_ids,omitempty"`
	OverviewRevision string            `json:"overview_revision,omitempty"`
	Message          string            `json:"message"`
}

// Commit creates the book and writes the confirmed setting. It is resumable: the
// draft records each finished stage, so repeating the call continues the same
// target book instead of creating another one or duplicating entries.
func (s *Service) Commit(ctx context.Context, id, baseRevision, requestID string) (CommitReceipt, error) {
	unlock := commitLocks.Lock(id)
	defer unlock()

	record, err := s.store.Read(ctx, id)
	if err != nil {
		return CommitReceipt{}, err
	}
	draft := record.Draft
	if draft.Status == StatusCommitted && draft.Commit != nil {
		return receiptFrom(*draft.Commit, CommitComplete), nil
	}
	if draft.Status == StatusAbandoned {
		return CommitReceipt{}, &ValidationError{Field: "draft", Message: "该草稿已放弃，无法创建书籍"}
	}
	if draft.Candidates == nil {
		return CommitReceipt{}, &ValidationError{Field: "candidates", Message: "请先生成并确认设定草稿"}
	}
	title := firstNonEmpty(strings.TrimSpace(draft.Title), strings.TrimSpace(draft.Candidates.Title))
	if title == "" {
		return CommitReceipt{}, &ValidationError{Field: "title", Message: "请填写书名后再创建"}
	}
	if s.workspaces == nil || strings.TrimSpace(s.projectsDir) == "" {
		return CommitReceipt{}, errors.New("书籍创建工作区不可用")
	}

	state := draft.Commit
	if state != nil && state.ItemIDs == nil {
		// An interrupted attempt may have persisted before any item existed; the
		// omitempty encoding drops the empty map, so normalise it before resuming.
		state.ItemIDs = map[string]string{}
	}
	switch {
	case state == nil:
		if err := ensureEditable(&draft); err != nil {
			return CommitReceipt{}, err
		}
		state = newCommitState(requestID, title, draft)
		record, err = s.store.Update(ctx, id, baseRevision, func(current *Draft) error {
			if current.Commit != nil {
				return &ValidationError{Field: "commit", Message: "该草稿已开始创建，请沿用当前创建流程"}
			}
			current.Commit = state
			return nil
		})
		if err != nil {
			return CommitReceipt{}, err
		}
		draft = record.Draft
	case state.WorkspacePath == "":
		// Nothing has been written yet, so this confirm is authoritative: the book
		// title may have changed and the stage plan must be rebuilt from the content
		// being confirmed now. Otherwise a first attempt without relations leaves
		// that stage marked done, and a later confirm silently skips it.
		record, err = s.store.Update(ctx, id, baseRevision, func(current *Draft) error {
			if current.Commit == nil || current.Commit.WorkspacePath != "" {
				return &ValidationError{Field: "commit", Message: "本书已开始创建，请沿用当前创建流程继续"}
			}
			replanned := newCommitState(requestID, title, *current)
			current.Commit = replanned
			state = replanned
			return nil
		})
		if err != nil {
			return CommitReceipt{}, err
		}
		draft = record.Draft
	default:
		// The workspace exists: the draft is frozen and the recorded plan is the
		// contract, so the retry continues those same stages.
		if len(state.Stages) == 0 {
			return CommitReceipt{}, &ValidationError{Field: "commit", Message: "创建进度记录缺失，请联系维护或另开新的构思"}
		}
	}

	for _, stage := range []string{StageBook, StageOverview, StageItems, StageRelations} {
		if state.StageStatus(stage) == StageDone {
			continue
		}
		var stageErr error
		switch stage {
		case StageBook:
			stageErr = s.stageBook(ctx, id, state, draft)
		case StageOverview:
			stageErr = s.stageOverview(ctx, id, state, draft)
		case StageItems:
			stageErr = s.stageItems(ctx, id, state, draft)
		case StageRelations:
			stageErr = s.stageRelations(ctx, id, state, draft)
		}
		if stageErr != nil {
			s.markStageFailed(ctx, id, state, stage, stageErr.Error())
			log.Printf("[book-ideation] draft=%s commit stage=%s failed err=%v", id, stage, stageErr)
			receipt := receiptFrom(*state, CommitIncomplete)
			receipt.Message = "创建未完成，停在「" + stageLabel(stage) + "」阶段"
			return receipt, fmt.Errorf("%w（stage=%s）: %w", ErrCommitIncomplete, stage, stageErr)
		}
		s.markStageDone(ctx, id, state, stage)
	}

	final, err := s.store.Update(ctx, id, "", func(current *Draft) error {
		if current.Commit == nil {
			return errors.New("创建状态丢失")
		}
		current.Commit = state
		current.Commit.CompletedAt = nowUTC()
		current.Status = StatusCommitted
		return nil
	})
	if err != nil {
		return receiptFrom(*state, CommitIncomplete), err
	}
	log.Printf("[book-ideation] draft=%s committed workspace=%s items=%d", id, state.WorkspacePath, len(state.ItemIDs))
	return receiptFrom(*final.Draft.Commit, CommitComplete), nil
}

func stageLabel(stage string) string {
	switch stage {
	case StageBook:
		return "创建书籍"
	case StageOverview:
		return "保存总览"
	case StageItems:
		return "写入资料条目"
	case StageRelations:
		return "写入关系"
	default:
		return stage
	}
}

func newCommitState(requestID, title string, draft Draft) *CommitState {
	stages := []CommitStage{
		{Name: StageBook, Status: StagePending},
		{Name: StageOverview, Status: StagePending},
	}
	if len(draft.Candidates.Items) > 0 || len(draft.Candidates.KeepSourceEntries) > 0 {
		stages = append(stages, CommitStage{Name: StageItems, Status: StagePending})
	} else {
		stages = append(stages, CommitStage{Name: StageItems, Status: StageDone, Detail: "没有需要写入的条目"})
	}
	if len(keptRelations(draft.Candidates.Relations)) > 0 {
		stages = append(stages, CommitStage{Name: StageRelations, Status: StagePending})
	} else {
		stages = append(stages, CommitStage{Name: StageRelations, Status: StageDone, Detail: "没有需要写入的关系"})
	}
	return &CommitState{
		RequestID: strings.TrimSpace(requestID),
		Title:     title,
		Stages:    stages,
		ItemIDs:   map[string]string{},
		CreatedAt: nowUTC(),
	}
}

func keptRelations(relations []CandidateRelation) []CandidateRelation {
	out := make([]CandidateRelation, 0, len(relations))
	for _, relation := range relations {
		if !relation.Excluded {
			out = append(out, relation)
		}
	}
	return out
}

func (s *Service) stageBook(ctx context.Context, id string, state *CommitState, draft Draft) error {
	if state.WorkspacePath != "" {
		return nil
	}
	workspace, err := s.workspaces.CreateBookDetached(ctx, s.projectsDir, state.Title, draft.Author,
		firstNonEmpty(draft.Description, draft.Candidates.Synopsis))
	if err != nil {
		// 同名书籍是用户能直接解决的事：给出可操作的下一步，不把内部绝对路径当错误文案。
		// 此时还没有任何写入，所以书名仍可修改后重试。
		if strings.Contains(err.Error(), "目录已存在") {
			return &ValidationError{
				Field:   "title",
				Message: fmt.Sprintf("已有同名书籍《%s》，请先改书名再继续创建；本草稿尚未写入任何内容", state.Title),
			}
		}
		return err
	}
	state.WorkspacePath = workspace
	if err := s.persistCommit(ctx, id, state); err != nil {
		return err
	}
	log.Printf("[book-ideation] draft=%s stage=book workspace=%s", id, workspace)
	return nil
}

func (s *Service) stageOverview(ctx context.Context, id string, state *CommitState, draft Draft) error {
	service, err := workspacechange.ForWorkspace(state.WorkspacePath)
	if err != nil {
		return err
	}
	baseRevision := "missing"
	if _, revision, readErr := service.ReadFile(BookOverviewPath); readErr == nil {
		baseRevision = revision
	}
	result, err := service.SaveFile(ctx, BookOverviewPath, draft.Candidates.Overview, baseRevision)
	if err != nil {
		return err
	}
	state.OverviewRevision = result.Revision
	if err := s.persistCommit(ctx, id, state); err != nil {
		return err
	}
	log.Printf("[book-ideation] draft=%s stage=overview changed=%t revision=%s", id, result.Changed, result.Revision)
	return nil
}

func (s *Service) stageItems(ctx context.Context, id string, state *CommitState, draft Draft) error {
	store := book.NewLoreStore(state.WorkspacePath)
	existing, err := store.ListAll()
	if err != nil {
		return err
	}
	idByID := map[string]bool{}
	idByName := map[string]string{}
	for _, item := range existing {
		idByID[item.ID] = true
		idByName[strings.ToLower(item.Name)] = item.ID
	}
	desired := buildDesiredItems(draft)
	ops := make([]book.LoreOperation, 0, len(desired))
	for _, candidate := range desired {
		if idByID[candidate.input.ID] {
			state.ItemIDs[candidate.ref] = candidate.input.ID
			continue
		}
		if id, clash := idByName[strings.ToLower(candidate.input.Name)]; clash {
			// A same-named entry already exists: never overwrite on name alone,
			// reuse it and let the receipt show what happened.
			state.ItemIDs[candidate.ref] = id
			continue
		}
		ops = append(ops, book.LoreOperation{Op: "create", Item: candidate.input})
		idByName[strings.ToLower(candidate.input.Name)] = candidate.input.ID
	}
	if len(ops) > 0 {
		result, err := store.ApplyOperations("由新建书籍的构思草稿确认创建", ops)
		if err != nil {
			return err
		}
		for _, item := range result.Created {
			for _, candidate := range desired {
				if candidate.input.ID == item.ID {
					state.ItemIDs[candidate.ref] = item.ID
				}
			}
		}
	}
	if err := s.persistCommit(ctx, id, state); err != nil {
		return err
	}
	log.Printf("[book-ideation] draft=%s stage=items created=%d desired=%d mapped=%d",
		id, len(ops), len(desired), len(state.ItemIDs))
	return nil
}

func (s *Service) stageRelations(ctx context.Context, id string, state *CommitState, draft Draft) error {
	updates := buildRelationUpdates(draft, state.ItemIDs)
	if len(updates) == 0 {
		return nil
	}
	store := book.NewLoreStore(state.WorkspacePath)
	existing, err := store.ListAll()
	if err != nil {
		return err
	}
	revisionByID := map[string]string{}
	for _, item := range existing {
		revisionByID[item.ID] = item.UpdatedAt
	}
	for start := 0; start < len(updates); start += 16 {
		end := min(start+16, len(updates))
		chunk := updates[start:end]
		for index := range chunk {
			if chunk[index].BaseRevision == "" {
				chunk[index].BaseRevision = revisionByID[chunk[index].ID]
			}
			if chunk[index].BaseRevision == "" {
				return fmt.Errorf("关系源条目不存在：%s", chunk[index].ID)
			}
		}
		if _, err := store.WriteRelations(chunk); err != nil {
			return err
		}
	}
	log.Printf("[book-ideation] draft=%s stage=relations sources=%d", id, len(updates))
	return nil
}

// persistCommit writes the running commit state without a CAS token: once a
// commit exists the draft is frozen, so this is the only writer.
func (s *Service) persistCommit(ctx context.Context, id string, state *CommitState) error {
	_, err := s.store.Update(ctx, id, "", func(current *Draft) error {
		if current.Commit == nil {
			return errors.New("创建状态丢失")
		}
		current.Commit = state
		return nil
	})
	return err
}

func (s *Service) markStageDone(ctx context.Context, id string, state *CommitState, name string) {
	for index := range state.Stages {
		if state.Stages[index].Name == name {
			state.Stages[index].Status = StageDone
			state.Stages[index].FinishedAt = nowUTC()
			state.Stages[index].Detail = ""
			break
		}
	}
	if err := s.persistCommit(ctx, id, state); err != nil {
		log.Printf("[book-ideation] draft=%s persist stage=%s done failed err=%v", id, name, err)
	}
}

func (s *Service) markStageFailed(ctx context.Context, id string, state *CommitState, name, detail string) {
	for index := range state.Stages {
		if state.Stages[index].Name == name {
			state.Stages[index].Detail = detail
			break
		}
	}
	if err := s.persistCommit(ctx, id, state); err != nil {
		log.Printf("[book-ideation] draft=%s persist stage=%s failure failed err=%v", id, name, err)
	}
}

// desiredItem pairs a lore input with the draft ref that identifies it.
type desiredItem struct {
	ref   string
	input book.LoreItemInput
}

// buildDesiredItems turns the confirmed candidates plus the retained original
// entries into lore inputs with deterministic ids, in a stable order, so a retry
// recognises its own earlier writes instead of duplicating them.
func buildDesiredItems(draft Draft) []desiredItem {
	pkg := draft.Candidates
	out := make([]desiredItem, 0, len(pkg.Items)+len(pkg.KeepSourceEntries))
	usedNames := map[string]bool{}
	uniqueName := func(name string) string {
		key := strings.ToLower(name)
		if name == "" || usedNames[key] {
			return ""
		}
		usedNames[key] = true
		return name
	}
	for _, item := range pkg.Items {
		if item.Excluded {
			continue
		}
		name := uniqueName(item.Name)
		if name == "" {
			continue
		}
		out = append(out, desiredItem{ref: "cand:" + item.Ref, input: candidateInput(draft, item, name)})
	}
	for _, entryID := range pkg.KeepSourceEntries {
		source, entry, ok := draft.SourceEntryByID(entryID)
		if !ok || entry.Role == RolePrompt {
			continue
		}
		name := uniqueName(entry.Name)
		if name == "" {
			name = uniqueName(source.Name + " · " + entry.Name)
		}
		if name == "" {
			continue
		}
		ref := "src:" + entry.ID
		enabled := true
		out = append(out, desiredItem{ref: ref, input: book.LoreItemInput{
			ID:         stableItemID(draft.ID, ref),
			Enabled:    &enabled,
			Type:       sourceEntryType(source),
			TypeSource: book.LoreTypeSourceManual,
			Name:       name,
			Importance: "important",
			LoadMode:   LoadModeManual,
			Content:    entry.Content,
			Keywords:   entry.Keywords,
			Provenance: &book.LoreProvenance{
				Kind:           source.Kind,
				SourceName:     source.Name,
				SourceRecordID: entry.ID,
				SourceHash:     source.ContentHash,
			},
		}})
	}
	return out
}

func candidateInput(draft Draft, item CandidateItem, name string) book.LoreItemInput {
	enabled := true
	input := book.LoreItemInput{
		ID:               stableItemID(draft.ID, "cand:"+item.Ref),
		Enabled:          &enabled,
		Type:             item.Type,
		TypeSource:       book.LoreTypeSourceManual,
		Name:             name,
		Importance:       importanceFor(item.LoadMode),
		LoadMode:         item.LoadMode,
		Content:          item.Content,
		BriefDescription: item.BriefDescription,
		Keywords:         item.Keywords,
		Provenance:       provenanceFor(item, draft),
	}
	if item.CharacterTier != "" && item.Type == "character" {
		tier := item.CharacterTier
		input.CharacterTier = &tier
	}
	return input
}

func provenanceFor(item CandidateItem, draft Draft) *book.LoreProvenance {
	if item.Origin != OriginSource || len(item.SourceRefs) == 0 {
		return nil
	}
	source, entry, ok := draft.SourceEntryByID(item.SourceRefs[0])
	if !ok {
		return nil
	}
	return &book.LoreProvenance{
		Kind:           source.Kind,
		SourceName:     source.Name,
		SourceRecordID: entry.ID,
		SourceHash:     source.ContentHash,
	}
}

func sourceEntryType(source Source) string {
	if source.Kind == KindCharacterCard {
		return "character"
	}
	return "other"
}

func importanceFor(loadMode string) string {
	if loadMode == LoadModeResident {
		return "major"
	}
	return "important"
}

func buildRelationUpdates(draft Draft, itemIDs map[string]string) []book.LoreRelationUpdate {
	bySource := map[string][]book.LoreRelation{}
	order := make([]string, 0)
	for _, relation := range keptRelations(draft.Candidates.Relations) {
		sourceID, sourceOK := itemIDs["cand:"+relation.SourceRef]
		targetID, targetOK := itemIDs["cand:"+relation.TargetRef]
		label := strings.TrimSpace(relation.Label)
		if !sourceOK || !targetOK || sourceID == targetID || label == "" {
			continue
		}
		if _, seen := bySource[sourceID]; !seen {
			order = append(order, sourceID)
		}
		note := strings.TrimSpace(relation.Note)
		if relation.Origin == OriginAI {
			note = joinNotes(note, "构思阶段的建议，采用后成为本书明确关系")
		}
		bySource[sourceID] = append(bySource[sourceID], book.LoreRelation{TargetID: targetID, Label: label, Note: note})
	}
	updates := make([]book.LoreRelationUpdate, 0, len(order))
	for _, sourceID := range order {
		relations := bySource[sourceID]
		if len(relations) > 128 {
			relations = relations[:128]
		}
		updates = append(updates, book.LoreRelationUpdate{ID: sourceID, Relations: relations})
	}
	return updates
}

func receiptFrom(state CommitState, status string) CommitReceipt {
	receipt := CommitReceipt{
		Status:           status,
		Title:            state.Title,
		WorkspacePath:    state.WorkspacePath,
		Stages:           append([]CommitStage(nil), state.Stages...),
		ItemIDs:          map[string]string{},
		OverviewRevision: state.OverviewRevision,
	}
	for key, value := range state.ItemIDs {
		receipt.ItemIDs[key] = value
	}
	switch status {
	case CommitComplete:
		receipt.Message = "《" + state.Title + "》已创建，总览与资料已写入本书"
	default:
		receipt.Message = "创建未完成"
	}
	return receipt
}

// stableItemID derives the lore id of one candidate so retries recognise their
// own earlier writes instead of duplicating an entry.
func stableItemID(draftID, key string) string {
	sum := sha256.Sum256([]byte(draftID + "\x00" + key))
	return "bi" + hex.EncodeToString(sum[:])[:24]
}
