package bookideation

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
)

// ErrModelUnavailable is returned when the shared model gateway is not usable.
// The draft is left untouched so the user can retry after configuring a model.
var ErrModelUnavailable = errors.New("共享模型当前不可用，构思内容未变更")

// SendMessage runs one ideation exchange. The user's message is stored before
// the model is called, so a failed or slow call still survives a refresh.
func (s *Service) SendMessage(ctx context.Context, id, baseRevision, content string) (Record, error) {
	text := boundField(content, MaxTurnRunes)
	if text == "" {
		return Record{}, &ValidationError{Field: "content", Message: "请先写下你的想法或选择"}
	}
	record, err := s.store.Update(ctx, id, baseRevision, func(draft *Draft) error {
		if err := ensureEditable(draft); err != nil {
			return err
		}
		if len(draft.Turns) >= MaxTurnsPerDraft {
			return &ValidationError{Field: "turns", Message: fmt.Sprintf("构思对话已达 %d 轮，请先生成草稿或另开新的构思", MaxTurnsPerDraft)}
		}
		draft.Turns = append(draft.Turns, Turn{Role: "user", Content: text, At: nowUTC()})
		if strings.TrimSpace(draft.Idea) == "" {
			draft.Idea = boundField(text, MaxDescriptionRunes)
		}
		return nil
	})
	if err != nil {
		return Record{}, err
	}
	if s.model == nil {
		return record, ErrModelUnavailable
	}
	corpus := buildSourceCorpus(record.Draft)
	history := conversationTail(record.Draft.Turns[:len(record.Draft.Turns)-1])
	request := ModelRequest{
		SystemPrompt: ideationTurnSystemPrompt,
		Messages: append(history, ModelMessage{
			Role:    "user",
			Content: turnUserPrompt(record.Draft, corpus, text),
		}),
		MaxTokens: turnOutputTokens,
	}
	reply, err := s.model.Generate(ctx, request)
	if err != nil {
		log.Printf("[book-ideation] draft=%s ideation turn model failed err=%v", id, err)
		return record, fmt.Errorf("%w: %v", ErrModelUnavailable, err)
	}
	parsed, err := parseTurnReply(reply.Content)
	if err != nil {
		log.Printf("[book-ideation] draft=%s ideation turn parse failed err=%v", id, err)
		return record, fmt.Errorf("%w: %v", ErrModelUnavailable, err)
	}
	assistant := boundField(parsed.Reply, MaxTurnRunes)
	updated, err := s.store.Update(ctx, id, record.Revision, func(draft *Draft) error {
		if err := ensureEditable(draft); err != nil {
			return err
		}
		direction, questions := normalizeTurnDirection(draft.Direction, parsed)
		draft.Direction = direction
		draft.DirectionRevision++
		if draft.Candidates != nil && len(questions) > 0 {
			draft.Candidates.OpenQuestions = dedupeStrings(append(draft.Candidates.OpenQuestions, questions...), MaxOpenQuestions)
		}
		draft.Turns = append(draft.Turns, Turn{Role: "assistant", Content: assistant, At: nowUTC(), Generated: true})
		return nil
	})
	if err != nil {
		return record, err
	}
	log.Printf("[book-ideation] draft=%s ideation turn ok model=%s turns=%d", id, reply.Model, len(updated.Draft.Turns))
	return updated, nil
}

// Generate produces or rewrites the candidate package. The model call happens
// outside the draft lock; the write then compares against the revision the
// caller had, so a reply that arrives after the user edited the draft is
// discarded instead of overwriting the newer content.
func (s *Service) Generate(ctx context.Context, id, baseRevision, scope string, refs []string) (Record, error) {
	if s.model == nil {
		return Record{}, ErrModelUnavailable
	}
	current, err := s.store.Read(ctx, id)
	if err != nil {
		return Record{}, err
	}
	if err := ensureEditable(&current.Draft); err != nil {
		return Record{}, err
	}
	scope = normalizeScope(scope)
	if scope == ScopeItems || scope == ScopeRelation {
		if scope == ScopeItems && len(refs) == 0 {
			return Record{}, &ValidationError{Field: "refs", Message: "局部重写需要指定要重写的条目"}
		}
		if current.Draft.Candidates == nil {
			return Record{}, &ValidationError{Field: "scope", Message: "还没有候选包，请先生成完整草稿"}
		}
	}
	corpus := buildSourceCorpus(current.Draft)
	if len(current.Draft.Sources) == 0 && strings.TrimSpace(current.Draft.Idea) == "" && strings.TrimSpace(current.Draft.Direction.Summary) == "" {
		return Record{}, &ValidationError{Field: "idea", Message: "请先写下一句话或选择素材，再生成设定草稿"}
	}
	raw, err := s.callCandidateModel(ctx, current.Draft, corpus, scope, refs)
	if err != nil {
		return Record{}, err
	}
	nextPackage, err := assemblePackage(raw, current.Draft, generationContext{
		Scope:    scope,
		Refs:     refs,
		Existing: current.Draft.Candidates,
	})
	if err != nil {
		log.Printf("[book-ideation] draft=%s candidate validation failed err=%v", id, err)
		return Record{}, err
	}
	nextPackage.GeneratedAt = nowUTC()
	record, err := s.store.Update(ctx, id, baseRevision, func(draft *Draft) error {
		if err := ensureEditable(draft); err != nil {
			return err
		}
		previousRevision := int64(0)
		if draft.Candidates != nil {
			previousRevision = draft.Candidates.Revision
		}
		nextPackage.Revision = previousRevision + 1
		nextPackage.DirectionRevision = draft.DirectionRevision
		draft.Candidates = nextPackage
		if strings.TrimSpace(draft.Title) == "" && nextPackage.Title != "" {
			draft.Title = nextPackage.Title
		}
		return nil
	})
	if err != nil {
		var conflict *ConflictError
		if errors.As(err, &conflict) {
			return Record{}, &StaleGenerationError{DraftID: id, Expected: baseRevision, Actual: conflict.Actual}
		}
		return Record{}, err
	}
	log.Printf("[book-ideation] draft=%s candidates generated scope=%s items=%d relations=%d kept_entries=%d",
		id, scope, len(nextPackage.Items), len(nextPackage.Relations), len(nextPackage.KeepSourceEntries))
	return record, nil
}

func (s *Service) callCandidateModel(ctx context.Context, draft Draft, corpus sourceCorpus, scope string, refs []string) (modelCandidatePackage, error) {
	prompt := candidateUserPrompt(draft, corpus, scope, refs, draft.Candidates)
	reply, err := s.model.Generate(ctx, ModelRequest{
		SystemPrompt: candidateSystemPrompt,
		Messages:     []ModelMessage{{Role: "user", Content: prompt}},
		MaxTokens:    generationOutputTokens,
	})
	if err != nil {
		log.Printf("[book-ideation] draft=%s candidate model failed err=%v", draft.ID, err)
		return modelCandidatePackage{}, fmt.Errorf("%w: %v", ErrModelUnavailable, err)
	}
	var raw modelCandidatePackage
	if err := decodeModelJSON(reply.Content, &raw); err != nil {
		log.Printf("[book-ideation] draft=%s candidate parse failed err=%v", draft.ID, err)
		return modelCandidatePackage{}, fmt.Errorf("%w: %v", ErrModelUnavailable, err)
	}
	return raw, nil
}

// UpdateCandidates stores the user's own preview edits: text changes, exclusions
// and which original entries to retain. Edited items are flagged so a later
// scoped regeneration leaves them alone.
func (s *Service) UpdateCandidates(ctx context.Context, id, baseRevision string, incoming CandidatePackage) (Record, error) {
	return s.store.Update(ctx, id, baseRevision, func(draft *Draft) error {
		if err := ensureEditable(draft); err != nil {
			return err
		}
		sourceIDs := retainedSourceIDs(*draft)
		next, err := normalizeUserPackage(incoming, draft.Candidates, sourceIDs)
		if err != nil {
			return err
		}
		previousRevision := int64(0)
		if draft.Candidates != nil {
			previousRevision = draft.Candidates.Revision
		}
		next.Revision = previousRevision + 1
		next.DirectionRevision = draft.DirectionRevision
		draft.Candidates = next
		return nil
	})
}

func normalizeUserPackage(incoming CandidatePackage, existing *CandidatePackage, sourceIDs map[string]bool) (*CandidatePackage, error) {
	overview := boundField(incoming.Overview, MaxOverviewRunes)
	if overview == "" {
		return nil, &ValidationError{Field: "overview", Message: "总览不能为空，可先保留现有内容"}
	}
	if len(incoming.Items) > MaxCandidateItems {
		return nil, &ValidationError{Field: "items", Message: fmt.Sprintf("候选条目最多 %d 条", MaxCandidateItems)}
	}
	existingByRef := map[string]CandidateItem{}
	if existing != nil {
		for _, item := range existing.Items {
			existingByRef[item.Ref] = item
		}
	}
	nextRef := highestCandidateRef(existing)
	items := make([]CandidateItem, 0, len(incoming.Items))
	names := map[string]bool{}
	for _, item := range incoming.Items {
		name := boundField(item.Name, 100)
		if name == "" {
			return nil, &ValidationError{Field: "items", Message: "条目缺少名称"}
		}
		content := boundField(item.Content, 12_000)
		if content == "" {
			return nil, &ValidationError{Field: "items", Message: "条目《" + name + "》正文不能为空"}
		}
		key := strings.ToLower(name)
		if names[key] {
			return nil, &ValidationError{Field: "items", Message: "条目名称重复：" + name}
		}
		names[key] = true
		ref := strings.TrimSpace(item.Ref)
		if !isCandidateRef(ref) {
			nextRef++
			ref = fmt.Sprintf("c%d", nextRef)
		}
		origin, note := normalizeOrigin(item.Origin, item.SourceRefs, sourceIDs, name)
		loreType := strings.TrimSpace(item.Type)
		if !allowedLoreTypes[loreType] {
			loreType = "other"
		}
		loadMode := strings.TrimSpace(item.LoadMode)
		if !allowedLoadModes[loadMode] {
			loadMode = LoadModeManual
		}
		tier := strings.TrimSpace(item.CharacterTier)
		if !allowedCharacterTiers[tier] {
			tier = ""
		}
		merged := CandidateItem{
			Ref:              ref,
			Name:             name,
			Type:             loreType,
			BriefDescription: boundField(item.BriefDescription, 400),
			Keywords:         boundList(item.Keywords, 12, 40),
			Content:          content,
			LoadMode:         loadMode,
			CharacterTier:    tier,
			Origin:           origin,
			SourceRefs:       validRefs(item.SourceRefs, sourceIDs),
			OpenNotes:        joinNotes(boundField(item.OpenNotes, 500), note),
			Excluded:         item.Excluded,
		}
		// A ref that already existed and changed content is a human edit; the
		// flag is what keeps a later regeneration from overwriting it.
		if previous, existed := existingByRef[ref]; existed {
			merged.EditedByUser = previous.EditedByUser || previous.Content != merged.Content ||
				previous.Name != merged.Name || previous.LoadMode != merged.LoadMode
		} else {
			merged.EditedByUser = true
		}
		items = append(items, merged)
	}
	byRef := map[string]bool{}
	for _, item := range items {
		byRef[item.Ref] = true
	}
	relations := make([]CandidateRelation, 0, len(incoming.Relations))
	keys := map[string]bool{}
	for index, relation := range incoming.Relations {
		if len(relations) >= MaxCandidateRelations {
			break
		}
		sourceRef := strings.TrimSpace(relation.SourceRef)
		targetRef := strings.TrimSpace(relation.TargetRef)
		label := boundField(relation.Label, 100)
		if !byRef[sourceRef] || !byRef[targetRef] || sourceRef == targetRef || label == "" {
			return nil, &ValidationError{Field: "relations", Message: "关系必须连接两个现存条目"}
		}
		key := sourceRef + "\x00" + targetRef + "\x00" + strings.ToLower(label)
		if keys[key] {
			continue
		}
		keys[key] = true
		relationRef := strings.TrimSpace(relation.Ref)
		if !isCandidateRef(relationRef) {
			relationRef = fmt.Sprintf("r%d", index+1)
		}
		origin, note := normalizeOrigin(relation.Origin, relation.SourceRefs, sourceIDs, sourceRef+"→"+targetRef)
		relations = append(relations, CandidateRelation{
			Ref:        relationRef,
			SourceRef:  sourceRef,
			TargetRef:  targetRef,
			Label:      label,
			Note:       joinNotes(boundField(relation.Note, 2000), note),
			Origin:     origin,
			SourceRefs: validRefs(relation.SourceRefs, sourceIDs),
			Excluded:   relation.Excluded,
		})
	}
	kept := validRefs(incoming.KeepSourceEntries, sourceIDs)
	if len(kept) > MaxSourceItemsKept {
		kept = kept[:MaxSourceItemsKept]
	}
	return &CandidatePackage{
		BookNameSuggestions: boundList(incoming.BookNameSuggestions, 3, MaxTitleRunes),
		Title:               boundField(incoming.Title, MaxTitleRunes),
		Synopsis:            boundField(incoming.Synopsis, MaxDescriptionRunes),
		Overview:            overview,
		Items:               items,
		Relations:           relations,
		OpenQuestions:       boundList(incoming.OpenQuestions, MaxOpenQuestions, 500),
		KeepSourceEntries:   kept,
		GeneratedAt:         nowUTC(),
	}, nil
}

// defaultKeepSourceEntries retains the original detailed setting text as book
// entries: card profile and opening material first, then lorebook entries, up to
// the retention cap. The user can change this selection in the preview.
func defaultKeepSourceEntries(draft Draft) []string {
	kept := make([]string, 0, MaxSourceItemsKept)
	for _, source := range draft.Sources {
		for _, entry := range source.Entries {
			if entry.Role == RolePrompt {
				// Prompt-shaped card text stays as reference material only.
				continue
			}
			kept = append(kept, entry.ID)
			if len(kept) >= MaxSourceItemsKept {
				return kept
			}
		}
	}
	return kept
}

func normalizeScope(scope string) string {
	switch strings.TrimSpace(scope) {
	case ScopeOverview, ScopeItems, ScopeRelation:
		return strings.TrimSpace(scope)
	default:
		return ScopeAll
	}
}

// Abandon marks a draft abandoned. The draft file is kept so an accidental
// abandon stays recoverable, but it stops accepting writes.
func (s *Service) Abandon(ctx context.Context, id, baseRevision string) (Record, error) {
	return s.store.Update(ctx, id, baseRevision, func(draft *Draft) error {
		if draft.Status == StatusCommitted {
			return &ValidationError{Field: "draft", Message: "已创建书籍的草稿不能标记为放弃"}
		}
		if draft.Commit != nil && draft.Commit.WorkspacePath != "" {
			return &ValidationError{Field: "draft", Message: fmt.Sprintf("本书已开始创建（《%s》），请先完成创建再放弃草稿", draft.Commit.Title)}
		}
		draft.Status = StatusAbandoned
		return nil
	})
}

func ensureEditable(draft *Draft) error {
	switch draft.Status {
	case StatusCommitted:
		return &ValidationError{Field: "draft", Message: "该草稿已创建书籍，请另开新的构思"}
	case StatusAbandoned:
		return &ValidationError{Field: "draft", Message: "该草稿已放弃"}
	}
	// 只有本书目录真的存在之后才冻结草稿。停在第一步的失败（例如同名书籍）还没
	// 写入任何内容，用户必须能改书名、改条目后继续创建。
	if draft.Commit != nil && draft.Commit.WorkspacePath != "" {
		return &ValidationError{Field: "draft", Message: "本书已开始创建，请先完成当前创建，或另开新的构思"}
	}
	return nil
}
