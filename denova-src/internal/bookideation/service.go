package bookideation

import (
	"context"
	"fmt"
	"log"
	"strings"
)

// ModelCaller is the only way this package reaches a model. The shared gateway
// one-shot call has no tools attached, so the ideation chain is structurally
// unable to write a book or change settings; merely telling a write-capable
// agent not to write would not be a boundary.
type ModelCaller interface {
	Generate(ctx context.Context, request ModelRequest) (ModelReply, error)
}

// ModelRequest carries an explicit system rule plus the bounded conversation.
type ModelRequest struct {
	SystemPrompt string
	Messages     []ModelMessage
	MaxTokens    int
}

// ModelMessage is one chat message; only system and user roles are used.
type ModelMessage struct {
	Role    string
	Content string
}

// ModelReply is the raw completion plus the resolved model identity, kept for
// logs and for "which model produced this draft".
type ModelReply struct {
	Content string
	Model   string
	Profile string
}

// WorkspaceCreator creates a book workspace without switching the server's
// current workspace, so a partial commit never leaves the running app pointed
// at a half-built book.
type WorkspaceCreator interface {
	CreateBookDetached(ctx context.Context, parentDir, title, author, description string) (string, error)
}

// ValidationError is a client- or model-output problem surfaced verbatim.
type ValidationError struct {
	Field   string
	Message string
}

func (e *ValidationError) Error() string { return e.Message }

// Service owns the ideation draft lifecycle. Drafts live in the data directory;
// the only code path that writes into a book workspace is Commit.
type Service struct {
	store       *Store
	model       ModelCaller
	workspaces  WorkspaceCreator
	projectsDir string
}

// NewService wires the draft store, the model seam and the detached creator.
// workspaces and projectsDir may stay empty until a commit is attempted.
func NewService(store *Store, model ModelCaller, workspaces WorkspaceCreator, projectsDir string) *Service {
	return &Service{store: store, model: model, workspaces: workspaces, projectsDir: projectsDir}
}

// CreateDraft starts an ideation session. It creates no book and no workspace.
func (s *Service) CreateDraft(ctx context.Context, idea, locale string) (Record, error) {
	id, err := NewDraftID()
	if err != nil {
		return Record{}, err
	}
	record, err := s.store.Create(ctx, Draft{
		ID:      id,
		Status:  StatusIdeating,
		Locale:  normalizeLocale(locale),
		Idea:    boundField(idea, MaxDescriptionRunes),
		Sources: []Source{},
		Turns:   []Turn{},
	})
	if err != nil {
		return Record{}, err
	}
	log.Printf("[book-ideation] draft created id=%s idea_runes=%d", record.Draft.ID, len([]rune(record.Draft.Idea)))
	return record, nil
}

// Get reads one draft.
func (s *Service) Get(ctx context.Context, id string) (Record, error) { return s.store.Read(ctx, id) }

// List returns drafts so a refresh can offer recovery.
func (s *Service) List(ctx context.Context) ([]DraftSummary, error) { return s.store.List(ctx) }

// DraftPatch carries the book-level fields and an optional user-confirmed
// direction. Unset pointers are left untouched.
type DraftPatch struct {
	Title       *string
	Author      *string
	Description *string
	Idea        *string
	Direction   *DirectionPatch
}

// DirectionPatch is the user's own statement of what has been decided.
type DirectionPatch struct {
	Summary  *string
	Genre    *string
	Tone     *string
	Conflict *string
	Cast     *[]string
}

// UpdateDraft writes the plain fields and, when supplied, a user-confirmed
// direction. Direction edits bump DirectionRevision so a later generation can
// warn that the current package predates the change.
func (s *Service) UpdateDraft(ctx context.Context, id, baseRevision string, patch DraftPatch) (Record, error) {
	record, err := s.store.Update(ctx, id, baseRevision, func(draft *Draft) error {
		if draft.Commit != nil && draft.Commit.WorkspacePath != "" {
			return frozenTitleError(draft)
		}
		if patch.Title != nil {
			draft.Title = boundField(*patch.Title, MaxTitleRunes)
		}
		if patch.Author != nil {
			draft.Author = boundField(*patch.Author, MaxTitleRunes)
		}
		if patch.Description != nil {
			draft.Description = boundField(*patch.Description, MaxDescriptionRunes)
		}
		if patch.Idea != nil {
			draft.Idea = boundField(*patch.Idea, MaxDescriptionRunes)
		}
		if patch.Direction == nil {
			return nil
		}
		updated, err := applyDirectionPatch(draft.Direction, patch.Direction)
		if err != nil {
			return err
		}
		updated.UpdatedBy = "user"
		updated.UpdatedAt = nowUTC()
		draft.Direction = updated
		draft.DirectionRevision++
		return nil
	})
	if err != nil {
		return Record{}, err
	}
	return record, nil
}

func applyDirectionPatch(current Direction, patch *DirectionPatch) (Direction, error) {
	next := current
	if patch.Summary != nil {
		bound, truncated := truncateRunes(strings.TrimSpace(*patch.Summary), MaxDirectionSummaryRun)
		if truncated {
			return Direction{}, &ValidationError{Field: "direction.summary", Message: "方向摘要超出长度上限"}
		}
		next.Summary = bound
	}
	if patch.Genre != nil {
		next.Genre = boundField(*patch.Genre, 200)
	}
	if patch.Tone != nil {
		next.Tone = boundField(*patch.Tone, 200)
	}
	if patch.Conflict != nil {
		next.Conflict = boundField(*patch.Conflict, 1000)
	}
	if patch.Cast != nil {
		if len(*patch.Cast) > 20 {
			return Direction{}, &ValidationError{Field: "direction.cast", Message: "主要人物最多 20 位"}
		}
		cast := make([]string, 0, len(*patch.Cast))
		for _, name := range *patch.Cast {
			if trimmed := strings.TrimSpace(name); trimmed != "" {
				cast = append(cast, boundField(trimmed, 100))
			}
		}
		next.Cast = cast
	}
	return next, nil
}

// ensureMaterialEditable blocks source changes once the target book exists on
// disk; a commit that failed before creating anything stays correctable.
func ensureMaterialEditable(draft *Draft) error {
	if draft.Commit != nil && draft.Commit.WorkspacePath != "" {
		return &ValidationError{Field: "sources", Message: "本书已开始创建，不能再变更素材；请另开新的构思"}
	}
	return nil
}

// frozenTitleError explains that a book already created from this draft cannot
// be renamed through the draft: the commit target is fixed for the retry.
func frozenTitleError(draft *Draft) error {
	return &ValidationError{
		Field:   "draft",
		Message: fmt.Sprintf("本草稿已开始创建《%s》，书名与资料范围已锁定；请先完成或放弃当前创建，再修改草稿", draft.Commit.Title),
	}
}

// AddSource stores a read-only snapshot of one selected 设定书 or 角色卡. The
// original file is only read; nothing here writes into a workspace.
func (s *Service) AddSource(ctx context.Context, id, baseRevision, filename string, data []byte) (Record, error) {
	parsed, err := ParseMaterialSource(filename, data)
	if err != nil {
		return Record{}, err
	}
	record, err := s.store.Update(ctx, id, baseRevision, func(draft *Draft) error {
		if err := ensureMaterialEditable(draft); err != nil {
			return err
		}
		if len(draft.Sources) >= MaxSourcesPerDraft {
			return &ValidationError{Field: "sources", Message: fmt.Sprintf("一个草稿最多选择 %d 份素材", MaxSourcesPerDraft)}
		}
		for _, existing := range draft.Sources {
			if existing.ContentHash == parsed.ContentHash {
				return &ValidationError{Field: "source", Message: fmt.Sprintf("《%s》的同一版本已在本次构思中", parsed.Name)}
			}
		}
		index := sourceIDEpisode(draft)
		draft.Sources = append(draft.Sources, buildSource(index, parsed, filename))
		draft.NextSourceIndex = index + 1
		return nil
	})
	if err != nil {
		return Record{}, err
	}
	log.Printf("[book-ideation] draft=%s source added kind=%s entries=%d bytes=%d", id, parsed.Kind, len(parsed.Entries), len(data))
	return record, nil
}

func buildSource(index int, parsed ParsedSource, filename string) Source {
	sourceID := fmt.Sprintf("s%d", index)
	return Source{
		ID:          sourceID,
		Kind:        parsed.Kind,
		Name:        boundField(parsed.Name, MaxTitleRunes),
		FileName:    sanitizeFileName(filename),
		ContentHash: parsed.ContentHash,
		Entries:     assignEntryIDs(parsed.Entries, sourceID),
		Warnings:    parsed.Warnings,
		AddedAt:     nowUTC(),
	}
}

// RemoveSource drops one snapshot and marks its citations inactive: ids already
// assigned to the remaining sources stay put, and candidates that cited the
// removed material lose their source provenance instead of silently resolving to
// whatever is added later.
func (s *Service) RemoveSource(ctx context.Context, id, baseRevision, sourceID string) (Record, error) {
	return s.store.Update(ctx, id, baseRevision, func(draft *Draft) error {
		if err := ensureMaterialEditable(draft); err != nil {
			return err
		}
		kept := make([]Source, 0, len(draft.Sources))
		var removed Source
		found := false
		for _, source := range draft.Sources {
			if source.ID == sourceID {
				found = true
				removed = source
				continue
			}
			kept = append(kept, source)
		}
		if !found {
			return &ValidationError{Field: "source_id", Message: "素材不在此草稿中"}
		}
		draft.Sources = kept
		invalidateRemovedSource(draft, removed)
		return nil
	})
}

func assignEntryIDs(entries []SourceEntry, sourceID string) []SourceEntry {
	out := make([]SourceEntry, 0, len(entries))
	for index, entry := range entries {
		if index >= MaxSourceEntries {
			break
		}
		entry.ID = fmt.Sprintf("%s-e%d", sourceID, index)
		out = append(out, entry)
	}
	return out
}

// sourceIDEpisode returns the next never-reused source index. Drafts written
// before this field existed fall back to one past the highest id in use.
func sourceIDEpisode(draft *Draft) int {
	highest := -1
	for _, source := range draft.Sources {
		if index, ok := parseSequentialIDSuffix(source.ID, "s"); ok && index > highest {
			highest = index
		}
	}
	if draft.NextSourceIndex > highest {
		return draft.NextSourceIndex
	}
	return highest + 1
}

// invalidateRemovedSource makes citations of a removed source explicit: affected
// candidates stop claiming source provenance, their original text is no longer
// offered for retention, and the draft records what the user now has to re-check.
func invalidateRemovedSource(draft *Draft, removed Source) {
	if draft.Candidates == nil || removed.ID == "" {
		return
	}
	removedEntries := map[string]bool{}
	for _, entry := range removed.Entries {
		removedEntries[entry.ID] = true
	}
	pkg := draft.Candidates
	affected := 0
	for index := range pkg.Items {
		keptRefs, dropped := filterRemovedRefs(pkg.Items[index].SourceRefs, removedEntries)
		if !dropped {
			continue
		}
		affected++
		pkg.Items[index].SourceRefs = keptRefs
		if pkg.Items[index].Origin == OriginSource {
			pkg.Items[index].Origin = OriginAI
			pkg.Items[index].OpenNotes = joinNotes(pkg.Items[index].OpenNotes,
				"《"+removed.Name+"》已从本次构思移除，该条目失去原文依据，请重新确认")
		}
	}
	for index := range pkg.Relations {
		keptRefs, dropped := filterRemovedRefs(pkg.Relations[index].SourceRefs, removedEntries)
		if !dropped {
			continue
		}
		affected++
		pkg.Relations[index].SourceRefs = keptRefs
		if pkg.Relations[index].Origin == OriginSource {
			pkg.Relations[index].Origin = OriginAI
			pkg.Relations[index].Note = joinNotes(pkg.Relations[index].Note,
				"依据的《"+removed.Name+"》已移除，请重新确认")
		}
	}
	keptEntries := make([]string, 0, len(pkg.KeepSourceEntries))
	for _, entryID := range pkg.KeepSourceEntries {
		if !removedEntries[entryID] {
			keptEntries = append(keptEntries, entryID)
		}
	}
	pkg.KeepSourceEntries = keptEntries
	if affected > 0 {
		pkg.OpenQuestions = appendUnique(pkg.OpenQuestions,
			fmt.Sprintf("已移除《%s》：%d 条候选失去原文依据，需重新确认后才能作为来源事实", removed.Name, affected))
	}
	log.Printf("[book-ideation] draft=%s source=%s removed, invalidated %d candidates", draft.ID, removed.ID, affected)
}

func filterRemovedRefs(refs []string, removed map[string]bool) ([]string, bool) {
	kept := make([]string, 0, len(refs))
	dropped := false
	for _, ref := range refs {
		if removed[ref] {
			dropped = true
			continue
		}
		kept = append(kept, ref)
	}
	return kept, dropped
}

func parseSequentialIDSuffix(id, prefix string) (int, bool) {
	if !strings.HasPrefix(id, prefix) {
		return 0, false
	}
	digits := strings.TrimPrefix(id, prefix)
	if digits == "" {
		return 0, false
	}
	index := 0
	for _, runeValue := range digits {
		if runeValue < '0' || runeValue > '9' {
			return 0, false
		}
		index = index*10 + int(runeValue-'0')
	}
	return index, true
}

func sanitizeFileName(filename string) string {
	filename = strings.ReplaceAll(filename, "\\", "/")
	if index := strings.LastIndex(filename, "/"); index >= 0 {
		filename = filename[index+1:]
	}
	return boundField(strings.TrimSpace(filename), MaxTitleRunes)
}

func normalizeLocale(locale string) string {
	switch strings.ToLower(strings.TrimSpace(locale)) {
	case "en", "en-us", "english":
		return "en-US"
	default:
		return "zh-CN"
	}
}

func boundField(value string, limit int) string {
	bound, _ := truncateRunes(strings.TrimSpace(value), limit)
	return bound
}
