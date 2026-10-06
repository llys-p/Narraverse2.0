package bookideation

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Model-side shapes. They stay separate from the stored candidate types because
// model output is untrusted input that has to be validated and re-labelled.
type modelTurnReply struct {
	Reply         string         `json:"reply"`
	Direction     modelDirection `json:"direction"`
	OpenQuestions []string       `json:"open_questions"`
}

type modelDirection struct {
	Summary  string   `json:"summary"`
	Genre    string   `json:"genre"`
	Tone     string   `json:"tone"`
	Conflict string   `json:"conflict"`
	Cast     []string `json:"cast"`
}

type modelCandidatePackage struct {
	Title               string               `json:"title"`
	BookNameSuggestions []string             `json:"book_name_suggestions"`
	Synopsis            string               `json:"synopsis"`
	Overview            string               `json:"overview"`
	Items               []modelCandidateItem `json:"items"`
	Relations           []modelCandidateLink `json:"relations"`
	OpenQuestions       []string             `json:"open_questions"`
}

type modelCandidateItem struct {
	Ref              string   `json:"ref"`
	Name             string   `json:"name"`
	Type             string   `json:"type"`
	Content          string   `json:"content"`
	BriefDescription string   `json:"brief_description"`
	Keywords         []string `json:"keywords"`
	LoadMode         string   `json:"load_mode"`
	CharacterTier    string   `json:"character_tier"`
	Origin           string   `json:"origin"`
	SourceRefs       []string `json:"source_refs"`
	OpenNotes        string   `json:"open_notes"`
}

type modelCandidateLink struct {
	Ref        string   `json:"ref"`
	SourceRef  string   `json:"source_ref"`
	TargetRef  string   `json:"target_ref"`
	Label      string   `json:"label"`
	Note       string   `json:"note"`
	Origin     string   `json:"origin"`
	SourceRefs []string `json:"source_refs"`
}

// Load modes mirror the lore store's vocabulary so a candidate needs no
// translation when it becomes an item.
const (
	LoadModeResident = "resident"
	LoadModeAuto     = "auto"
	LoadModeManual   = "manual"
)

var allowedLoreTypes = map[string]bool{
	"character": true, "location": true, "faction": true,
	"rule": true, "item": true, "world": true, "other": true,
}

var allowedLoadModes = map[string]bool{LoadModeResident: true, LoadModeAuto: true, LoadModeManual: true}

var allowedCharacterTiers = map[string]bool{"": true, "major": true, "minor": true, "unclassified": true}

// extractJSONObject returns the first balanced JSON object in a completion, so a
// fenced or slightly chatty reply still yields a document instead of wasting the
// model call on a parse failure.
func extractJSONObject(content string) (string, error) {
	document := strings.TrimSpace(content)
	document = strings.TrimPrefix(document, "```json")
	document = strings.TrimPrefix(document, "```")
	document = strings.TrimSpace(strings.TrimSuffix(document, "```"))
	start := strings.Index(document, "{")
	if start < 0 {
		return "", errors.New("模型没有返回 JSON 对象")
	}
	depth, inString, escape := 0, false, false
	for index, runeValue := range document[start:] {
		offset := start + index
		switch {
		case escape:
			escape = false
		case runeValue == '\\' && inString:
			escape = true
		case runeValue == '"':
			inString = !inString
		case inString:
			continue
		case runeValue == '{':
			depth++
		case runeValue == '}':
			depth--
			if depth == 0 {
				return document[start : offset+1], nil
			}
		}
	}
	return "", errors.New("模型返回的 JSON 不完整")
}

func decodeModelJSON(content string, target any) error {
	document, err := extractJSONObject(content)
	if err != nil {
		return err
	}
	if err := json.Unmarshal([]byte(document), target); err != nil {
		return fmt.Errorf("模型返回的 JSON 无法解析: %w", err)
	}
	return nil
}

func parseTurnReply(content string) (modelTurnReply, error) {
	var reply modelTurnReply
	if err := decodeModelJSON(content, &reply); err != nil {
		return modelTurnReply{}, err
	}
	if strings.TrimSpace(reply.Reply) == "" {
		return modelTurnReply{}, errors.New("模型没有给出可用回应")
	}
	return reply, nil
}

// normalizeTurnDirection keeps the direction the model says the user agreed to,
// bounded by the same limits the manual edit path enforces.
func normalizeTurnDirection(current Direction, reply modelTurnReply) (Direction, []string) {
	next := current
	next.Summary = boundField(reply.Direction.Summary, MaxDirectionSummaryRun)
	next.Genre = boundField(reply.Direction.Genre, 200)
	next.Tone = boundField(reply.Direction.Tone, 200)
	next.Conflict = boundField(reply.Direction.Conflict, 1000)
	next.Cast = boundList(reply.Direction.Cast, 20, 100)
	next.UpdatedBy = "agent"
	next.UpdatedAt = nowUTC()
	return next, boundQuestions(reply.OpenQuestions)
}

func boundQuestions(questions []string) []string {
	return boundList(questions, MaxOpenQuestions, 500)
}

// generationContext says what one completion is allowed to replace. Every field
// outside the scope is copied from the confirmed draft instead of taken from the
// model, so a scoped rewrite can never move unrelated text, relations or the
// user's retained-original selection.
type generationContext struct {
	Scope    string
	Refs     []string
	Existing *CandidatePackage
}

// assemblePackage validates a completion against the draft's retained source ids
// and the lore field rules, then returns the whole resulting package. A citation
// that does not resolve downgrades the candidate to an AI proposal instead of
// letting it pose as a fact already present in the original material.
func assemblePackage(raw modelCandidatePackage, draft Draft, gen generationContext) (*CandidatePackage, error) {
	sourceIDs := retainedSourceIDs(draft)
	next := CandidatePackage{Items: []CandidateItem{}, Relations: []CandidateRelation{}}
	if gen.Existing != nil {
		next = *gen.Existing
	}
	questions := boundQuestions(raw.OpenQuestions)

	touchesOverview := gen.Scope == ScopeAll || gen.Scope == ScopeOverview
	touchesItems := gen.Scope == ScopeAll || gen.Scope == ScopeItems
	touchesRelations := gen.Scope == ScopeAll || gen.Scope == ScopeRelation

	if !touchesOverview && strings.TrimSpace(raw.Overview) != "" {
		questions = appendUnique(questions, "本次范围不含总览，模型返回的总览改动未采用")
	}
	if !touchesItems && len(raw.Items) > 0 {
		questions = appendUnique(questions, "本次范围不含条目，模型返回的条目改动未采用")
	}
	if !touchesRelations && len(raw.Relations) > 0 {
		questions = appendUnique(questions, "本次范围不含关系，模型返回的关系改动未采用")
	}

	if touchesOverview {
		overview := boundField(raw.Overview, MaxOverviewRunes)
		if overview == "" {
			return nil, &ValidationError{Field: "overview", Message: "模型没有生成总览，请重新生成"}
		}
		next.Overview = overview
		next.Synopsis = firstNonEmpty(boundField(raw.Synopsis, MaxDescriptionRunes), next.Synopsis)
		if gen.Scope == ScopeAll {
			next.Title = firstNonEmpty(boundField(raw.Title, MaxTitleRunes), next.Title)
			next.BookNameSuggestions = dedupeStrings(raw.BookNameSuggestions, 3)
		}
	}

	refMap := map[string]string{}
	if touchesItems {
		if len(raw.Items) > MaxCandidateItems {
			return nil, &ValidationError{Field: "items", Message: fmt.Sprintf("候选条目最多 %d 条", MaxCandidateItems)}
		}
		if len(raw.Items) == 0 {
			return nil, &ValidationError{Field: "items", Message: "模型没有给出可用条目，请重新生成"}
		}
		items, mapping, notes, err := assembleItems(raw.Items, gen, sourceIDs)
		if err != nil {
			return nil, err
		}
		next.Items = items
		refMap = mapping
		questions = append(questions, notes...)
	}

	if touchesRelations {
		relations, dropped := validateRelations(rewriteRelationRefs(raw.Relations, refMap), next.Items, sourceIDs)
		next.Relations = relations
		if dropped > 0 {
			questions = appendUnique(questions,
				fmt.Sprintf("有 %d 条关系指向不存在的条目，未纳入候选，请在预览中补充", dropped))
		}
	}

	if len(next.Items) == 0 {
		return nil, &ValidationError{Field: "items", Message: "本书候选没有任何资料条目，请重新生成"}
	}
	// 原文保留选择是用户的确认结果：只有第一版候选才给出默认勾选。
	if gen.Existing == nil {
		next.KeepSourceEntries = defaultKeepSourceEntries(draft)
	}
	next.OpenQuestions = dedupeStrings(append(next.OpenQuestions, questions...), MaxOpenQuestions)
	return &next, nil
}

// assembleItems builds the final item list for a scope that owns items: locked
// entries survive untouched, a scoped rewrite replaces only the listed refs, and
// everything else is kept. It returns the model-ref to final-ref map so relations
// can be re-pointed, plus notes about entries the model could not change.
func assembleItems(raw []modelCandidateItem, gen generationContext, sourceIDs map[string]bool) ([]CandidateItem, map[string]string, []string, error) {
	kept := make([]CandidateItem, 0, len(raw)+8)
	refMap := map[string]string{}
	notes := make([]string, 0, 4)
	lockedNames := map[string]bool{}
	lockedRefs := map[string]bool{}
	byRef := map[string]int{}
	refsInScope := map[string]bool{}
	for _, ref := range gen.Refs {
		refsInScope[strings.TrimSpace(ref)] = true
	}
	if gen.Existing != nil {
		for _, item := range gen.Existing.Items {
			switch {
			case item.EditedByUser || item.Excluded:
				lockedNames[strings.ToLower(item.Name)] = true
				lockedRefs[item.Ref] = true
				kept = append(kept, item)
				byRef[item.Ref] = len(kept) - 1
			case gen.Scope == ScopeItems:
				// 局部重写时所有现存条目都先占位，被选中的那条原位替换，用户在预览里
				// 看到的顺序不会因为一次改写而改变。
				kept = append(kept, item)
				byRef[item.Ref] = len(kept) - 1
			}
		}
	}
	nextRef := highestCandidateRef(gen.Existing)
	seenNames := map[string]bool{}
	for _, item := range kept {
		seenNames[strings.ToLower(item.Name)] = true
	}
	for _, item := range raw {
		name := boundField(item.Name, 100)
		if name == "" {
			return nil, nil, nil, &ValidationError{Field: "items", Message: "候选条目缺少名称"}
		}
		content := boundField(item.Content, 12_000)
		if content == "" {
			return nil, nil, nil, &ValidationError{Field: "items", Message: "候选条目《" + name + "》没有正文"}
		}
		key := strings.ToLower(name)
		modelRef := strings.TrimSpace(item.Ref)
		if gen.Scope == ScopeItems {
			// 局部重写只能替换原候选中本次申请的 ref。仅检查请求白名单不够：
			// 不存在于原包的 ref 也不能借此成为新条目。
			if !refsInScope[modelRef] {
				notes = appendUnique(notes, "只重写选中的条目，模型返回的《"+name+"》不在本次范围内，未采用")
				continue
			}
			if _, exists := byRef[modelRef]; !exists {
				notes = appendUnique(notes, "模型返回的 ref "+modelRef+" 在原候选中不存在，未新增条目")
				continue
			}
			if lockedRefs[modelRef] {
				original := kept[byRef[modelRef]]
				notes = appendUnique(notes, "《"+original.Name+"》已由你编辑或明确排除，本次生成未覆盖")
				continue
			}
		}
		if lockedNames[key] {
			notes = appendUnique(notes, "《"+name+"》已由你编辑或明确排除，本次生成未覆盖")
			continue
		}
		rewriteIndex, rewriting := -1, false
		if gen.Scope == ScopeItems && isCandidateRef(modelRef) {
			if index, exists := byRef[modelRef]; exists && refsInScope[modelRef] {
				rewriteIndex, rewriting = index, true
			}
		}
		if !rewriting && seenNames[key] {
			notes = appendUnique(notes, "候选中存在同名条目，已去重保留第一条："+name)
			continue
		}
		ref := modelRef
		if !isCandidateRef(ref) || gen.Scope == ScopeAll {
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
		candidate := CandidateItem{
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
		}
		if modelRef != "" {
			refMap[modelRef] = candidate.Ref
		}
		if rewriting {
			candidate.EditedByUser = false
			kept[rewriteIndex] = candidate
			continue
		}
		seenNames[key] = true
		kept = append(kept, candidate)
		byRef[candidate.Ref] = len(kept) - 1
	}
	// 候选 ref 必须唯一：它同时是预览编辑、关系引用与落盘确定性 ID 的依据。
	usedRefs := map[string]bool{}
	for index := range kept {
		ref := kept[index].Ref
		if usedRefs[ref] {
			nextRef++
			renumbered := fmt.Sprintf("c%d", nextRef)
			notes = appendUnique(notes, "候选标识 "+ref+" 重复，已把后一条改为 "+renumbered+"，请在预览中核对")
			kept[index].Ref = renumbered
		}
		usedRefs[kept[index].Ref] = true
	}
	return kept, refMap, notes, nil
}

// rewriteRelationRefs maps the refs the model used onto the final item refs,
// because a locked or renamed item keeps its original ref.
func rewriteRelationRefs(raw []modelCandidateLink, refMap map[string]string) []modelCandidateLink {
	out := make([]modelCandidateLink, 0, len(raw))
	for _, relation := range raw {
		if mapped, ok := refMap[strings.TrimSpace(relation.SourceRef)]; ok {
			relation.SourceRef = mapped
		}
		if mapped, ok := refMap[strings.TrimSpace(relation.TargetRef)]; ok {
			relation.TargetRef = mapped
		}
		out = append(out, relation)
	}
	return out
}
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func validateRelations(raw []modelCandidateLink, items []CandidateItem, sourceIDs map[string]bool) ([]CandidateRelation, int) {
	byRef := map[string]CandidateItem{}
	for _, item := range items {
		byRef[item.Ref] = item
	}
	out := make([]CandidateRelation, 0, len(raw))
	keys := map[string]bool{}
	dropped := 0
	for index, relation := range raw {
		if len(out) >= MaxCandidateRelations {
			dropped++
			continue
		}
		sourceItem, sourceOK := byRef[strings.TrimSpace(relation.SourceRef)]
		targetItem, targetOK := byRef[strings.TrimSpace(relation.TargetRef)]
		label := boundField(relation.Label, 100)
		if !sourceOK || !targetOK || sourceItem.Ref == targetItem.Ref || label == "" {
			dropped++
			continue
		}
		key := sourceItem.Ref + "\x00" + targetItem.Ref + "\x00" + strings.ToLower(label)
		if keys[key] {
			continue
		}
		keys[key] = true
		ref := boundField(relation.Ref, 24)
		if !isCandidateRef(ref) {
			ref = fmt.Sprintf("r%d", index+1)
		}
		subject := sourceItem.Name + "→" + targetItem.Name
		origin, note := normalizeOrigin(relation.Origin, relation.SourceRefs, sourceIDs, subject)
		out = append(out, CandidateRelation{
			Ref:        ref,
			SourceRef:  sourceItem.Ref,
			TargetRef:  targetItem.Ref,
			Label:      label,
			Note:       joinNotes(boundField(relation.Note, 2000), note),
			Origin:     origin,
			SourceRefs: validRefs(relation.SourceRefs, sourceIDs),
		})
	}
	return out, dropped
}

// normalizeOrigin enforces the source-fact boundary: a claim said to come from
// the original material has to cite a retained entry that exists.
func normalizeOrigin(origin string, refs []string, sourceIDs map[string]bool, subject string) (string, string) {
	switch strings.TrimSpace(origin) {
	case OriginUser:
		return OriginUser, ""
	case OriginSource:
		if len(validRefs(refs, sourceIDs)) == 0 {
			return OriginAI, "来源依据未命中已保留片段，已按 AI 建议标注：" + subject
		}
		return OriginSource, ""
	default:
		return OriginAI, ""
	}
}

func validRefs(refs []string, sourceIDs map[string]bool) []string {
	out := make([]string, 0, len(refs))
	for _, ref := range refs {
		ref = strings.TrimSpace(ref)
		if ref != "" && sourceIDs[ref] {
			out = append(out, ref)
		}
		if len(out) >= 12 {
			break
		}
	}
	return out
}

func retainedSourceIDs(draft Draft) map[string]bool {
	ids := map[string]bool{}
	for _, source := range draft.Sources {
		for _, entry := range source.Entries {
			ids[entry.ID] = true
		}
	}
	return ids
}

func isCandidateRef(ref string) bool {
	ref = strings.TrimSpace(ref)
	return len(ref) > 1 && (strings.HasPrefix(ref, "c") || strings.HasPrefix(ref, "r"))
}

// highestCandidateRef returns the numeric part of the largest existing ref so
// regenerated items continue the sequence instead of colliding.
func highestCandidateRef(pkg *CandidatePackage) int {
	highest := 0
	if pkg == nil {
		return highest
	}
	for _, item := range pkg.Items {
		if index, ok := parseSequentialIDSuffix(item.Ref, "c"); ok && index > highest {
			highest = index
		}
	}
	return highest
}

func joinNotes(existing, added string) string {
	added = strings.TrimSpace(added)
	if added == "" {
		return existing
	}
	if strings.TrimSpace(existing) == "" {
		return added
	}
	return existing + "；" + added
}

func boundList(values []string, countLimit, runeLimit int) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		text := boundField(value, runeLimit)
		if text == "" {
			continue
		}
		out = append(out, text)
		if len(out) >= countLimit {
			break
		}
	}
	return out
}

func dedupeStrings(values []string, limit int) []string {
	out := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		text := boundField(value, 500)
		if text == "" || seen[strings.ToLower(text)] {
			continue
		}
		seen[strings.ToLower(text)] = true
		out = append(out, text)
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out
}

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}
