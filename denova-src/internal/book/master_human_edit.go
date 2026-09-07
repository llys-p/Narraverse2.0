package book

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

var masterCharacterOpeningPath = regexp.MustCompile(`^character\.openings\[(\d+)\]$`)

// MasterHumanFieldEditInput is the trusted, UI-scoped path for explicit human
// edits. It intentionally bypasses translation proposal and token validation,
// while retaining revision protection against overwriting a newer page state.
type MasterHumanFieldEditInput struct {
	MasterItemID     string            `json:"master_item_id"`
	ExpectedRevision string            `json:"expected_revision"`
	Fields           map[string]string `json:"fields"`
}

// MasterManualLorebookEntryInput describes a new human-authored entry. New
// entries are Master-owned first; the caller may separately project them into
// the current Adventure for immediate use.
type MasterManualLorebookEntryInput struct {
	MasterItemID     string
	ExpectedRevision string
	Name             string
	Content          string
	Keywords         []string
	SecondaryKeys    []string
}

// MasterManualCharacterEntryInput describes a human-authored entry added to
// the editable character-card directory. It is stored in the Master item and
// is intentionally independent from the archived card source.
type MasterManualCharacterEntryInput struct {
	MasterItemID     string
	ExpectedRevision string
	Name             string
	Content          string
}

func masterHumanMapString(values map[string]any, key string) string {
	value, _ := values[key].(string)
	return strings.TrimSpace(value)
}

func nonEmptyMasterStrings(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			result = append(result, value)
		}
	}
	return result
}

func sameMasterStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if strings.TrimSpace(left[index]) != strings.TrimSpace(right[index]) {
			return false
		}
	}
	return true
}

// AddManualLorebookEntry appends a human-authored entry to a Master lorebook.
// An exact human entry is idempotent so a client retry cannot create a second
// visible entry.
func (s *MasterLibraryStore) AddManualLorebookEntry(input MasterManualLorebookEntryInput) (MasterItem, error) {
	input.MasterItemID = strings.TrimSpace(input.MasterItemID)
	input.ExpectedRevision = strings.TrimSpace(input.ExpectedRevision)
	input.Name = strings.TrimSpace(input.Name)
	input.Content = strings.TrimSpace(input.Content)
	if input.MasterItemID == "" {
		return MasterItem{}, errors.New("总库资产 ID 不能为空")
	}
	if input.ExpectedRevision == "" {
		return MasterItem{}, errors.New("页面版本不能为空，请刷新后重试")
	}
	if input.Name == "" || input.Content == "" {
		return MasterItem{}, errors.New("手动条目标题和正文不能为空")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return MasterItem{}, err
	}
	item, err := s.loadItemUnlocked(input.MasterItemID)
	if err != nil {
		return MasterItem{}, err
	}
	if item.RecordKind != "lorebook_template" {
		return MasterItem{}, errors.New("只有设定书资产支持手动新增条目")
	}
	if input.ExpectedRevision != item.Revision {
		return MasterItem{}, &MasterCASConflictError{
			MasterItemID: item.MasterItemID, FieldPath: "manual-entry",
			ExpectedRevision: input.ExpectedRevision, ActualRevision: item.Revision,
		}
	}
	keywords := append([]string{}, input.Keywords...)
	secondaryKeys := append([]string{}, input.SecondaryKeys...)
	for index := range keywords {
		keywords[index] = strings.TrimSpace(keywords[index])
	}
	for index := range secondaryKeys {
		secondaryKeys[index] = strings.TrimSpace(secondaryKeys[index])
	}
	keywords = nonEmptyMasterStrings(keywords)
	secondaryKeys = nonEmptyMasterStrings(secondaryKeys)
	for _, entry := range item.NestedEntries {
		if entry.SourceEntryIdentity != "" && strings.HasPrefix(entry.SourceEntryIdentity, "human:") &&
			masterHumanMapString(entry.Original, "comment") == input.Name && masterHumanMapString(entry.Original, "content") == input.Content &&
			sameMasterStrings(masterStringSlice(entry.Original["keys"]), keywords) &&
			sameMasterStrings(masterStringSlice(entry.Original["secondary_keys"]), secondaryKeys) {
			return item, nil
		}
	}

	entryID := "human-" + uuid.New().String()
	original := map[string]any{
		"comment": input.Name, "content": input.Content,
		"keys": keywords, "secondary_keys": secondaryKeys,
	}
	item.NestedEntries = append(item.NestedEntries, MasterNestedEntry{
		EntryID: entryID, SourceEntryIdentity: "human:" + entryID,
		Original:         original,
		SourceSemantics:  map[string]any{"origin": "human"},
		RuntimeSemantics: map[string]any{"enabled": true, "load_mode": "auto", "keys": keywords, "secondary_keys": secondaryKeys},
	})
	prefix := "lorebook.entries/" + entryID + "/"
	if item.Fields == nil {
		item.Fields = map[string]MasterField{}
	}
	for field, value := range map[string]string{"comment": input.Name, "content": input.Content, "keys": strings.Join(keywords, "\n"), "secondary_keys": strings.Join(secondaryKeys, "\n")} {
		item.Fields[prefix+field] = MasterField{
			SourceText: value, SourceSHA256: masterHashString(value), Risk: masterFieldRiskSafe,
			ActiveText: value, ActiveKind: "human", NeedsTranslation: false,
		}
	}
	item.ActiveWorkingRevision = masterActiveWorkingRevision(item.Fields)
	if err := s.saveItemUnlocked(&manifest, item); err != nil {
		return MasterItem{}, err
	}
	if err := s.saveManifestUnlocked(manifest); err != nil {
		return MasterItem{}, err
	}
	return s.loadItemUnlocked(item.MasterItemID)
}

// AddManualCharacterEntry appends a human-authored character-book entry. An
// exact human entry is idempotent so a client retry cannot duplicate it.
func (s *MasterLibraryStore) AddManualCharacterEntry(input MasterManualCharacterEntryInput) (MasterItem, error) {
	input.MasterItemID = strings.TrimSpace(input.MasterItemID)
	input.ExpectedRevision = strings.TrimSpace(input.ExpectedRevision)
	input.Name = strings.TrimSpace(input.Name)
	input.Content = strings.TrimSpace(input.Content)
	if input.MasterItemID == "" {
		return MasterItem{}, errors.New("总库资产 ID 不能为空")
	}
	if input.ExpectedRevision == "" {
		return MasterItem{}, errors.New("页面版本不能为空，请刷新后重试")
	}
	if input.Name == "" || input.Content == "" {
		return MasterItem{}, errors.New("角色条目标题和正文不能为空")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return MasterItem{}, err
	}
	item, err := s.loadItemUnlocked(input.MasterItemID)
	if err != nil {
		return MasterItem{}, err
	}
	if item.RecordKind != "character_template" {
		return MasterItem{}, errors.New("只有角色卡资产支持手动新增条目")
	}
	if input.ExpectedRevision != item.Revision {
		return MasterItem{}, &MasterCASConflictError{
			MasterItemID: item.MasterItemID, FieldPath: "manual-character-entry",
			ExpectedRevision: input.ExpectedRevision, ActualRevision: item.Revision,
		}
	}
	for _, entry := range item.NestedEntries {
		if entry.SourceEntryIdentity != "" && strings.HasPrefix(entry.SourceEntryIdentity, "human:") &&
			masterHumanMapString(entry.Original, "comment") == input.Name &&
			masterHumanMapString(entry.Original, "content") == input.Content {
			return item, nil
		}
	}

	entryID := "human-" + uuid.New().String()
	item.NestedEntries = append(item.NestedEntries, MasterNestedEntry{
		EntryID: entryID, SourceEntryIdentity: "human:" + entryID,
		Original:         map[string]any{"comment": input.Name, "content": input.Content},
		SourceSemantics:  map[string]any{"origin": "human"},
		RuntimeSemantics: map[string]any{"enabled": true, "load_mode": "auto"},
	})
	prefix := "character_book.entries/" + entryID + "/"
	if item.Fields == nil {
		item.Fields = map[string]MasterField{}
	}
	for field, value := range map[string]string{"comment": input.Name, "content": input.Content} {
		item.Fields[prefix+field] = MasterField{
			SourceText: value, SourceSHA256: masterHashString(value), Risk: masterFieldRiskSafe,
			ActiveText: value, ActiveKind: "human", NeedsTranslation: false,
		}
	}
	item.ActiveWorkingRevision = masterActiveWorkingRevision(item.Fields)
	if err := s.saveItemUnlocked(&manifest, item); err != nil {
		return MasterItem{}, err
	}
	if err := s.saveManifestUnlocked(manifest); err != nil {
		return MasterItem{}, err
	}
	return s.loadItemUnlocked(item.MasterItemID)
}

// UpdateMasterAssetFields applies explicit human edits atomically to one
// Master asset. Missing fields displayed by the editor may be created; unknown
// paths are rejected so the UI cannot report success for data runtime ignores.
func (s *MasterLibraryStore) UpdateMasterAssetFields(input MasterHumanFieldEditInput) (MasterItem, error) {
	input.MasterItemID = strings.TrimSpace(input.MasterItemID)
	input.ExpectedRevision = strings.TrimSpace(input.ExpectedRevision)
	if input.MasterItemID == "" {
		return MasterItem{}, errors.New("总库资产 ID 不能为空")
	}
	if input.ExpectedRevision == "" {
		return MasterItem{}, errors.New("页面版本不能为空，请刷新后重试")
	}
	if len(input.Fields) == 0 {
		return MasterItem{}, errors.New("没有需要保存的字段")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return MasterItem{}, err
	}
	item, err := s.loadItemUnlocked(input.MasterItemID)
	if err != nil {
		return MasterItem{}, err
	}
	if input.ExpectedRevision != item.Revision {
		return MasterItem{}, &MasterCASConflictError{
			MasterItemID: item.MasterItemID, FieldPath: "human-edit",
			ExpectedRevision: input.ExpectedRevision, ActualRevision: item.Revision,
		}
	}
	for path := range input.Fields {
		if err := validateMasterHumanEditPath(item, strings.TrimSpace(path)); err != nil {
			return MasterItem{}, err
		}
	}
	if item.Fields == nil {
		item.Fields = map[string]MasterField{}
	}
	paths := make(map[string]bool, len(input.Fields))
	for rawPath, text := range input.Fields {
		path := strings.TrimSpace(rawPath)
		field := item.Fields[path]
		if field.Risk == "" {
			field.Risk = masterFieldRiskSafe
		}
		field.ActiveText = text
		field.ActiveKind = "human"
		field.ActiveTranslationVersionID = ""
		field.NeedsTranslation = false
		item.Fields[path] = field
		paths[path] = true
	}
	item.ActiveWorkingRevision = masterActiveWorkingRevision(item.Fields)
	if err := s.saveItemUnlocked(&manifest, item); err != nil {
		return MasterItem{}, err
	}
	if err := s.completeHumanEditedTargetsUnlocked(&manifest, item.MasterItemID, paths); err != nil {
		return MasterItem{}, err
	}
	if err := s.saveManifestUnlocked(manifest); err != nil {
		return MasterItem{}, err
	}
	return s.loadItemUnlocked(item.MasterItemID)
}

func validateMasterHumanEditPath(item MasterItem, path string) error {
	if path == "" {
		return errors.New("人工编辑字段路径不能为空")
	}
	if item.RecordKind == "character_template" {
		allowed := map[string]bool{
			"character.name": true, "character.description": true, "character.personality": true,
			"character.scenario": true, "character.mes_example": true, "character.creator_notes": true,
			"character.creator_comment": true, "character.system_prompt": true,
			"character.post_history_instructions": true, "character.tags": true,
		}
		if allowed[path] || masterCharacterOpeningPath.MatchString(path) {
			return nil
		}
		return validateMasterNestedHumanEditPath(item, path, "character_book.entries")
	}
	if item.RecordKind == "lorebook_template" {
		if path == "lorebook.description" {
			return nil
		}
		return validateMasterNestedHumanEditPath(item, path, "lorebook.entries")
	}
	return fmt.Errorf("当前资产类型不支持人工字段编辑: %s", item.RecordKind)
}

func validateMasterNestedHumanEditPath(item MasterItem, path, prefix string) error {
	parts := strings.Split(path, "/")
	if len(parts) != 3 || parts[0] != prefix {
		return fmt.Errorf("该字段不能在人工编辑器中修改: %s", path)
	}
	allowedField := parts[2] == "comment" || parts[2] == "content" || parts[2] == "keys" || parts[2] == "secondary_keys"
	if !allowedField {
		return fmt.Errorf("该字段不能在人工编辑器中修改: %s", path)
	}
	for _, entry := range item.NestedEntries {
		if entry.EntryID == parts[1] {
			return nil
		}
	}
	return fmt.Errorf("设定书条目不存在，请刷新后重试: %s", parts[1])
}

func (s *MasterLibraryStore) completeHumanEditedTargetsUnlocked(manifest *MasterLibraryManifest, itemID string, paths map[string]bool) error {
	for refIndex := range manifest.Imports {
		ref := &manifest.Imports[refIndex]
		transaction, err := s.loadImportUnlocked(ref.Path)
		if err != nil {
			return err
		}
		changed := false
		for targetIndex := range transaction.TranslationTargets {
			target := &transaction.TranslationTargets[targetIndex]
			if target.MasterItemID == itemID && paths[target.FieldPath] && target.Status != "active" {
				target.Status = "active"
				changed = true
			}
		}
		if !changed {
			continue
		}
		if transaction.Status == "pending_translation" && masterTransactionReady(transaction) {
			transaction.Status = "ready"
		}
		transaction.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		if err := s.writeJSONUnlocked(ref.Path, transaction); err != nil {
			return err
		}
		ref.Status = transaction.Status
	}
	return nil
}
