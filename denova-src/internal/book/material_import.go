package book

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	materialArchiveDir   = ".narraverse/source/imported-materials"
	materialManifestPath = ".narraverse/material-import-manifest.json"
	MaterialModeManaged  = "master_managed"
	MaterialModeDirect   = "unmanaged_direct"
)

type MaterialPreview struct {
	Kind          string                `json:"kind"`
	Name          string                `json:"name"`
	EntryCount    int                   `json:"entry_count"`
	ResidentBytes int                   `json:"resident_bytes"`
	Truncated     bool                  `json:"truncated"`
	Warnings      []string              `json:"warnings"`
	CharacterCard *CharacterCardPreview `json:"character_card,omitempty"`
}

type MaterialImportOptions struct {
	SourceID          string
	SourceKind        string
	AcceptIncomplete  bool
	UserCharacterName string
	ManagementMode    string
	MasterOnly        bool
}

type MaterialImportResult struct {
	Kind               string                    `json:"kind"`
	Name               string                    `json:"name"`
	EntryCount         int                       `json:"entry_count"`
	CreatedIDs         []string                  `json:"created_ids"`
	UpdatedIDs         []string                  `json:"updated_ids"`
	ConflictIDs        []string                  `json:"conflict_ids"`
	SkippedIDs         []string                  `json:"skipped_ids"`
	Failed             []string                  `json:"failed"`
	ItemIDs            []string                  `json:"item_ids"`
	ArchivePath        string                    `json:"archive_path"`
	ManifestPath       string                    `json:"manifest_path"`
	Truncated          bool                      `json:"truncated"`
	ManagementMode     string                    `json:"management_mode"`
	Status             string                    `json:"status"`
	ImportID           string                    `json:"import_id,omitempty"`
	MasterWorkspace    string                    `json:"master_workspace,omitempty"`
	MasterSourceID     string                    `json:"master_source_id,omitempty"`
	MasterItemIDs      []string                  `json:"master_item_ids"`
	TranslationTargets []MasterTranslationTarget `json:"translation_targets"`
}

type materialManifest struct {
	Version int                      `json:"version"`
	Imports []materialManifestImport `json:"imports"`
}

type materialManifestImport struct {
	SourceID    string                   `json:"source_id"`
	SourceKind  string                   `json:"source_kind"`
	Filename    string                   `json:"filename"`
	SHA256      string                   `json:"sha256"`
	Bytes       int                      `json:"bytes"`
	ImportedAt  string                   `json:"imported_at"`
	EntryCount  int                      `json:"entry_count"`
	ArchivePath string                   `json:"archive_path"`
	Truncated   bool                     `json:"truncated"`
	Targets     []materialManifestTarget `json:"targets"`
}

type materialManifestTarget struct {
	SourceRecordID string `json:"source_record_id"`
	TargetID       string `json:"target_id"`
	ManagedHash    string `json:"managed_hash"`
	Status         string `json:"status"`
}

func PreviewMaterial(filename string, data []byte) (MaterialPreview, error) {
	if materialLooksLikeCharacterCard(filename, data) {
		preview, err := PreviewTavernCharacterCard(filename, data)
		if err != nil {
			return MaterialPreview{}, err
		}
		card, err := parseTavernCharacterCard(filename, data)
		if err != nil {
			return MaterialPreview{}, err
		}
		truncated := materialContainsTruncation(data) || materialCardContainsTruncation(card)
		// Always serialize empty collections as [] rather than null.  The web
		// importer renders these collections directly (for example warnings.map).
		warnings := append([]string{}, preview.Compatibility.Warnings...)
		if truncated {
			warnings = append(warnings, "原件含内容已截断标记")
		}
		entryCount := preview.EntryCount + 1
		if preview.UserPlaceholderFound {
			entryCount++
		}
		return MaterialPreview{Kind: "character_card", Name: preview.Name, EntryCount: entryCount, ResidentBytes: preview.ResidentLoreBytes, Truncated: truncated, Warnings: warnings, CharacterCard: &preview}, nil
	}
	name, book, err := parseStandaloneLorebook(filename, data)
	if err != nil {
		return MaterialPreview{}, err
	}
	truncated := materialContainsTruncation(data)
	warnings := []string{}
	if truncated {
		warnings = append(warnings, "原件含内容已截断标记")
	}
	return MaterialPreview{Kind: "lorebook", Name: name, EntryCount: len(book.Entries), Truncated: truncated, Warnings: warnings}, nil
}

func (s *Service) ImportMaterial(filename string, data []byte, options MaterialImportOptions) (MaterialImportResult, error) {
	mode := strings.TrimSpace(options.ManagementMode)
	if mode == "" {
		mode = MaterialModeManaged
	}
	switch mode {
	case MaterialModeManaged:
		options.ManagementMode = mode
		return s.importMaterialManaged(filename, data, options)
	case MaterialModeDirect:
		options.ManagementMode = mode
		return s.importMaterialDirect(filename, data, options)
	default:
		return MaterialImportResult{}, errors.New("素材导入模式无效")
	}
}

// ImportMaterialToMaster archives and ingests a source without creating an
// instance in the current Adventure. Translation targets are returned to the
// existing 8097 queue caller.
func (s *Service) ImportMaterialToMaster(filename string, data []byte, options MaterialImportOptions) (MaterialImportResult, error) {
	options.MasterOnly = true
	options.ManagementMode = MaterialModeManaged
	return s.importMaterialManaged(filename, data, options)
}

// InstantiateMasterAsset projects one usable Master asset into this Adventure.
func (s *Service) InstantiateMasterAsset(masterItemID string) (MaterialImportResult, error) {
	master := NewMasterLibraryStore(s.workspace)
	importID, err := master.PrepareAssetInstantiation(masterItemID, s.workspace)
	if err != nil {
		return MaterialImportResult{}, err
	}
	return s.FinalizeMasterImport(importID)
}

func (s *Service) importMaterialDirect(filename string, data []byte, options MaterialImportOptions) (MaterialImportResult, error) {
	preview, err := PreviewMaterial(filename, data)
	if err != nil {
		return MaterialImportResult{}, err
	}
	if preview.Truncated && !options.AcceptIncomplete {
		return MaterialImportResult{}, errors.New("原件含内容已截断标记；必须明确接受不完整导入")
	}
	sourceID := strings.TrimSpace(options.SourceID)
	if sourceID == "" {
		sourceID = materialSourceID(filename, data)
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{6,100}$`).MatchString(sourceID) {
		return MaterialImportResult{}, errors.New("素材来源 ID 无效")
	}

	store := NewLoreStore(s.workspace)
	existing, err := store.ListAll()
	if err != nil {
		return MaterialImportResult{}, err
	}
	manifest, manifestAbs, err := loadMaterialManifest(s.workspace)
	if err != nil {
		return MaterialImportResult{}, err
	}

	var ops []LoreOperation
	var characterCard *normalizedTavernCard
	if preview.Kind == "character_card" {
		card, parseErr := parseTavernCharacterCard(filename, data)
		if parseErr != nil {
			return MaterialImportResult{}, parseErr
		}
		characterCard = &card
		coverPath := ""
		if card.IsPNG {
			coverPath = tavernCardCoverPath
		}
		ops, _ = buildTavernCardLoreOperations(card, filename, coverPath, options.UserCharacterName, newLoreNameAllocator(nil))
	} else {
		_, lorebook, parseErr := parseStandaloneLorebook(filename, data)
		if parseErr != nil {
			return MaterialImportResult{}, parseErr
		}
		card := normalizedTavernCard{Name: preview.Name, CharacterBook: lorebook}
		built, _ := buildTavernCardLoreOperations(card, filename, "", "", newLoreNameAllocator(nil))
		ops = append([]LoreOperation(nil), built[1:]...)
		for i := range ops {
			ops[i].Item.LoadMode = LoreLoadModeAuto
			if materialManualOnly(ops[i].Item) {
				ops[i].Item.LoadMode = LoreLoadModeManual
			}
		}
	}

	previous := manifestTargets(manifest, sourceID)
	reconciled, targets, result := reconcileMaterialOperations(sourceID, preview, ops, existing, previous)
	// Keep the JSON contract stable for clients: collection fields are always
	// arrays, even when this import creates/updates nothing.
	if result.CreatedIDs == nil {
		result.CreatedIDs = []string{}
	}
	if result.UpdatedIDs == nil {
		result.UpdatedIDs = []string{}
	}
	if result.ConflictIDs == nil {
		result.ConflictIDs = []string{}
	}
	if result.SkippedIDs == nil {
		result.SkippedIDs = []string{}
	}
	if result.Failed == nil {
		result.Failed = []string{}
	}
	if result.ItemIDs == nil {
		result.ItemIDs = []string{}
	}
	result.Name, result.Kind, result.EntryCount, result.Truncated = preview.Name, preview.Kind, len(ops), preview.Truncated
	result.ManagementMode, result.Status = MaterialModeDirect, "instantiated"
	result.MasterItemIDs, result.TranslationTargets = []string{}, []MasterTranslationTarget{}
	result.ManifestPath = materialManifestPath

	digest := sha256.Sum256(data)
	archiveRel := filepath.ToSlash(filepath.Join(materialArchiveDir, sourceID+"--"+safeMaterialFilename(filename)))
	archiveAbs := filepath.Join(s.workspace, filepath.FromSlash(archiveRel))
	result.ArchivePath = archiveRel
	snapshots, err := snapshotCharacterCardImportFiles(s.workspace)
	if err != nil {
		return MaterialImportResult{}, err
	}
	extraSnapshots, err := snapshotMaterialFiles(archiveAbs, manifestAbs)
	if err != nil {
		return MaterialImportResult{}, err
	}
	snapshots = append(snapshots, extraSnapshots...)
	rollback := func(cause error) (MaterialImportResult, error) {
		if restoreErr := restoreCharacterCardImportFiles(snapshots); restoreErr != nil {
			return MaterialImportResult{}, fmt.Errorf("%w；回滚素材导入失败: %v", cause, restoreErr)
		}
		return MaterialImportResult{}, cause
	}

	if characterCard != nil {
		if _, err := s.importTavernCardCover(*characterCard, data); err != nil {
			return rollback(err)
		}
		if _, err := s.importTavernCardOpeningPresets(*characterCard); err != nil {
			return rollback(err)
		}
	}
	if len(reconciled) > 0 {
		applied, applyErr := store.ApplyOperations("导入素材「"+preview.Name+"」", reconciled)
		if applyErr != nil {
			return rollback(applyErr)
		}
		for _, item := range applied.Created {
			result.CreatedIDs = appendUnique(result.CreatedIDs, item.ID)
		}
		for _, item := range applied.Updated {
			result.UpdatedIDs = appendUnique(result.UpdatedIDs, item.ID)
		}
	}
	if err := atomicWriteMaterial(archiveAbs, data); err != nil {
		return rollback(err)
	}
	entry := materialManifestImport{SourceID: sourceID, SourceKind: firstNonEmptyLoreValue(options.SourceKind, preview.Kind), Filename: filename, SHA256: hex.EncodeToString(digest[:]), Bytes: len(data), ImportedAt: time.Now().UTC().Format(time.RFC3339Nano), EntryCount: len(ops), ArchivePath: archiveRel, Truncated: preview.Truncated, Targets: targets}
	manifest.Imports = append(manifest.Imports, entry)
	manifestData, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return rollback(err)
	}
	if err := atomicWriteMaterial(manifestAbs, append(manifestData, '\n')); err != nil {
		return rollback(err)
	}
	result.ItemIDs = appendUnique(append(append([]string{}, result.CreatedIDs...), result.UpdatedIDs...), result.ConflictIDs...)
	return result, nil
}

func (s *Service) importMaterialManaged(filename string, data []byte, options MaterialImportOptions) (MaterialImportResult, error) {
	preview, err := PreviewMaterial(filename, data)
	if err != nil {
		return MaterialImportResult{}, err
	}
	if preview.Truncated && !options.AcceptIncomplete {
		return MaterialImportResult{}, errors.New("原件含内容已截断标记；必须明确接受不完整导入")
	}
	inputs, err := buildMasterItemInputs(filename, data, preview, options)
	if err != nil {
		return MaterialImportResult{}, err
	}
	master := NewMasterLibraryStore(s.workspace)
	masterWorkspace := s.workspace
	if options.MasterOnly {
		masterWorkspace = master.Workspace()
	}
	ingested, err := master.Ingest(MasterIngestInput{
		Filename: filename, Data: data, SourceAnchor: strings.TrimSpace(options.SourceID),
		SourceKind: strings.TrimSpace(options.SourceKind), AdventureWorkspace: masterWorkspace, Items: inputs,
	})
	if err != nil {
		return MaterialImportResult{}, err
	}
	result := emptyMaterialImportResult()
	result.Kind, result.Name, result.EntryCount, result.Truncated = preview.Kind, preview.Name, len(inputs), preview.Truncated
	result.ManagementMode, result.Status = MaterialModeManaged, ingested.Transaction.Status
	result.ImportID, result.MasterWorkspace = ingested.Transaction.ImportID, ingested.MasterWorkspace
	result.MasterSourceID, result.MasterItemIDs = ingested.Source.SourceID, masterItemIDs(ingested.Items)
	result.ArchivePath, result.ManifestPath = ingested.SourceRevision.OriginalPath, masterManifestPath
	result.TranslationTargets = append([]MasterTranslationTarget{}, ingested.Transaction.TranslationTargets...)
	if options.MasterOnly {
		return result, nil
	}
	if ingested.Transaction.Status == "instantiated" {
		result.ItemIDs = append([]string{}, ingested.Transaction.TargetLoreIDs...)
		result.SkippedIDs = append([]string{}, result.ItemIDs...)
		return result, nil
	}
	if ingested.Transaction.Status == "ready" {
		finalized, finalizeErr := s.FinalizeMasterImport(ingested.Transaction.ImportID)
		if finalizeErr != nil {
			return MaterialImportResult{}, finalizeErr
		}
		// A ready transaction can still contain optional high-risk fields that
		// need review. Keep returning those targets after the safe projection is
		// instantiated so the web queue can finish them against Master.
		finalized.TranslationTargets = append([]MasterTranslationTarget{}, ingested.Transaction.TranslationTargets...)
		return finalized, nil
	}
	return result, nil
}

// FinalizeMasterImport projects a ready Master transaction into the current
// adventure. Repeated calls are idempotent and never overwrite an existing
// adventure instance.
func (s *Service) FinalizeMasterImport(importID string) (MaterialImportResult, error) {
	master := NewMasterLibraryStore(s.workspace)
	transaction, err := master.LoadImport(strings.TrimSpace(importID))
	if err != nil {
		return MaterialImportResult{}, err
	}
	if transaction.Status == "instantiated" {
		result := emptyMaterialImportResult()
		result.ManagementMode, result.Status, result.ImportID = MaterialModeManaged, transaction.Status, transaction.ImportID
		result.MasterWorkspace, result.MasterSourceID = master.Workspace(), transaction.SourceID
		result.MasterItemIDs, result.ItemIDs = append([]string{}, transaction.ItemIDs...), append([]string{}, transaction.TargetLoreIDs...)
		result.SkippedIDs = append([]string{}, transaction.TargetLoreIDs...)
		result.ManifestPath = masterManifestPath
		return result, nil
	}
	if !masterTransactionReady(transaction) {
		return MaterialImportResult{}, errors.New("总库素材仍有必需字段等待翻译")
	}
	source, revision, data, err := master.LoadSourceRevision(transaction.SourceID, transaction.SourceRevision)
	if err != nil {
		return MaterialImportResult{}, err
	}
	items := make([]MasterItem, 0, len(transaction.ItemIDs))
	for _, itemID := range transaction.ItemIDs {
		item, loadErr := master.LoadItem(itemID)
		if loadErr != nil {
			return MaterialImportResult{}, loadErr
		}
		items = append(items, item)
	}
	preview, err := PreviewMaterial(source.Filename, data)
	if err != nil {
		return MaterialImportResult{}, err
	}
	store := NewLoreStore(s.workspace)
	existing, err := store.ListAll()
	if err != nil {
		return MaterialImportResult{}, err
	}
	ops, activeCard, itemTargets, nestedLoreIDs, err := buildMasterRuntimeOperations(source.Filename, data, items, transaction, existing)
	if err != nil {
		return MaterialImportResult{}, err
	}
	result := emptyMaterialImportResult()
	result.Kind, result.Name, result.EntryCount, result.Truncated = preview.Kind, preview.Name, len(items), preview.Truncated
	result.ManagementMode, result.Status, result.ImportID = MaterialModeManaged, "ready", transaction.ImportID
	result.MasterWorkspace, result.MasterSourceID = master.Workspace(), transaction.SourceID
	result.MasterItemIDs, result.ArchivePath, result.ManifestPath = append([]string{}, transaction.ItemIDs...), revision.OriginalPath, masterManifestPath

	byID := map[string]LoreItem{}
	for _, item := range existing {
		byID[item.ID] = item
	}
	pending := make([]LoreOperation, 0, len(ops))
	for _, op := range ops {
		if _, found := byID[op.Item.ID]; found {
			result.SkippedIDs = append(result.SkippedIDs, op.Item.ID)
			continue
		}
		pending = append(pending, op)
	}
	snapshots, err := snapshotCharacterCardImportFiles(s.workspace)
	if err != nil {
		return MaterialImportResult{}, err
	}
	rollback := func(cause error) (MaterialImportResult, error) {
		if restoreErr := restoreCharacterCardImportFiles(snapshots); restoreErr != nil {
			return MaterialImportResult{}, fmt.Errorf("%w；回滚冒险实例失败: %v", cause, restoreErr)
		}
		return MaterialImportResult{}, cause
	}
	if activeCard != nil {
		if _, err := s.importTavernCardCover(*activeCard, data); err != nil {
			return rollback(err)
		}
		if _, err := s.importTavernCardOpeningPresets(*activeCard); err != nil {
			return rollback(err)
		}
	}
	if len(pending) > 0 {
		applied, applyErr := store.ApplyOperations("从叙界总资料库加载「"+preview.Name+"」", pending)
		if applyErr != nil {
			return rollback(applyErr)
		}
		for _, item := range applied.Created {
			result.CreatedIDs = appendUnique(result.CreatedIDs, item.ID)
		}
	}
	allTargets := []string{}
	instances := make([]MasterInstanceRef, 0, len(items))
	for _, item := range items {
		targets := append([]string{}, itemTargets[item.MasterItemID]...)
		allTargets = appendUnique(allTargets, targets...)
		instances = append(instances, MasterInstanceRef{
			InstanceID: transaction.InstanceIDs[item.MasterItemID], ImportID: transaction.ImportID,
			MasterItemID: item.MasterItemID, AdventureKey: transaction.AdventureKey,
			TargetLoreIDs: targets, NestedEntryLoreIDs: nestedLoreIDs[item.MasterItemID], LoadedRevision: item.ActiveWorkingRevision,
		})
	}
	if _, err := master.MarkImportInstantiated(transaction.ImportID, allTargets, instances); err != nil {
		return rollback(err)
	}
	result.Status, result.ItemIDs = "instantiated", allTargets
	return result, nil
}

func buildMasterItemInputs(filename string, data []byte, preview MaterialPreview, options MaterialImportOptions) ([]MasterItemInput, error) {
	if preview.Kind == "character_card" {
		card, err := parseTavernCharacterCard(filename, data)
		if err != nil {
			return nil, err
		}
		return []MasterItemInput{masterCharacterItemInput(card, options.UserCharacterName)}, nil
	}
	_, lorebook, err := parseStandaloneLorebook(filename, data)
	if err != nil {
		return nil, err
	}
	return []MasterItemInput{masterLorebookItemInput(preview.Name, lorebook)}, nil
}

func masterCharacterItemInput(card normalizedTavernCard, userCharacterName string) MasterItemInput {
	original := map[string]any{
		"name": card.Name, "description": card.Description, "personality": card.Personality,
		"scenario": card.Scenario, "first_mes": card.FirstMes, "alternate_greetings": append([]string{}, card.AlternateGreetings...),
		"mes_example": card.MesExample, "creator_notes": card.CreatorNotes, "creator_comment": card.CreatorComment,
		"system_prompt": card.SystemPrompt, "post_history_instructions": card.PostHistoryInstructions,
		"creator": card.Creator, "character_version": card.CharacterVersion, "extensions": card.Extensions,
		"tags": append([]string{}, card.Tags...), "spec": card.Spec, "spec_version": card.SpecVersion,
	}
	fields := map[string]MasterFieldInput{}
	add := func(path, text, risk string, required bool) {
		if strings.TrimSpace(text) != "" {
			fields[path] = MasterFieldInput{Text: text, Risk: risk, Required: required}
		}
	}
	add("character.name", card.Name, masterFieldRiskSafe, true)
	add("character.description", card.Description, masterFieldRiskSafe, true)
	add("character.personality", card.Personality, masterFieldRiskSafe, true)
	add("character.scenario", card.Scenario, masterFieldRiskSafe, true)
	add("character.openings[0]", card.FirstMes, masterFieldRiskSafe, true)
	for index, greeting := range card.AlternateGreetings {
		add(fmt.Sprintf("character.openings[%d]", index+1), greeting, masterFieldRiskSafe, true)
	}
	add("character.mes_example", card.MesExample, masterFieldRiskSafe, true)
	add("character.creator_notes", card.CreatorNotes, masterFieldRiskSafe, true)
	add("character.creator_comment", card.CreatorComment, masterFieldRiskSafe, true)
	add("character.system_prompt", card.SystemPrompt, masterFieldRiskHigh, false)
	add("character.post_history_instructions", card.PostHistoryInstructions, masterFieldRiskHigh, false)
	nested := masterNestedEntries(card.CharacterBook)
	addMasterNestedFields(fields, nested, "character_book")
	return MasterItemInput{
		SourceEntryIdentity: "character", RecordKind: "character_template", SemanticType: "character", Name: card.Name,
		Original:         addMasterCharacterBook(original, card.CharacterBook),
		SourceSemantics:  map[string]any{"format": map[bool]string{true: "png", false: "json"}[card.IsPNG], "extensions": card.Extensions, "tags": append([]string{}, card.Tags...), "character_book": masterJSONMap(card.CharacterBook)},
		RuntimeSemantics: map[string]any{"load_mode": LoreLoadModeResident, "has_user_placeholder": card.HasUserPlaceholder, "user_character_name": strings.TrimSpace(userCharacterName)},
		Fields:           fields, NestedEntries: nested,
	}
}

func masterLorebookItemInput(name string, book *tavernCharacterBook) MasterItemInput {
	nested := masterNestedEntries(book)
	fields := map[string]MasterFieldInput{}
	if strings.TrimSpace(name) != "" {
		fields["lorebook.name"] = MasterFieldInput{Text: name, Risk: masterFieldRiskSafe, Required: true}
	}
	addMasterNestedFields(fields, nested, "lorebook")
	bookMap := masterJSONMap(book)
	return MasterItemInput{
		SourceEntryIdentity: "lorebook", RecordKind: "lorebook_template", SemanticType: "lorebook", Name: name,
		Original:         map[string]any{"name": name, "entries": bookMap["entries"]},
		SourceSemantics:  map[string]any{"format": "lorebook", "entries": bookMap["entries"]},
		RuntimeSemantics: map[string]any{"load_mode": LoreLoadModeAuto}, Fields: fields, NestedEntries: nested,
	}
}

func addMasterCharacterBook(original map[string]any, book *tavernCharacterBook) map[string]any {
	result := cloneMasterMap(original)
	if book != nil {
		result["character_book"] = masterJSONMap(book)
	}
	return result
}

func masterNestedEntries(book *tavernCharacterBook) []MasterNestedEntry {
	if book == nil || len(book.Entries) == 0 {
		return []MasterNestedEntry{}
	}
	entries := make([]MasterNestedEntry, 0, len(book.Entries))
	for _, entry := range book.Entries {
		entries = append(entries, MasterNestedEntry{
			EntryID: masterNestedEntryID(entry), SourceEntryIdentity: entry.SourceRecordID,
			Original: masterJSONMap(entry), SourceSemantics: masterLoreEntrySourceSemantics(entry),
			RuntimeSemantics: map[string]any{
				"enabled": entry.Enabled == nil || *entry.Enabled, "load_mode": masterEntryLoadMode(entry),
				"keys": append([]string{}, entry.Keys...), "secondary_keys": append([]string{}, entry.SecondaryKeys...),
				"constant": entry.Constant, "selective": entry.Selective,
			},
		})
	}
	return entries
}

func masterEntryLoadMode(entry tavernBookEntry) string {
	if entry.Constant {
		return LoreLoadModeResident
	}
	return LoreLoadModeAuto
}

func addMasterNestedFields(fields map[string]MasterFieldInput, entries []MasterNestedEntry, prefix string) {
	for _, entry := range entries {
		path := func(field string) string { return prefix + ".entries/" + entry.EntryID + "/" + field }
		comment := materialString(entry.Original["comment"])
		if comment == "" {
			comment = materialString(entry.Original["name"])
		}
		if comment != "" {
			fields[path("comment")] = MasterFieldInput{Text: comment, Risk: masterFieldRiskSafe}
		}
		content := materialString(entry.Original["content"])
		risk := masterFieldRiskSafe
		keywords := append(masterStringSlice(entry.Original["keys"]), masterStringSlice(entry.Original["secondary_keys"])...)
		if materialManualOnly(LoreItemInput{Name: comment, Content: content, Keywords: keywords}) {
			risk = masterFieldRiskHigh
		}
		if content != "" {
			fields[path("content")] = MasterFieldInput{Text: content, Risk: risk}
		}
		if keys := masterStringSlice(entry.Original["keys"]); len(keys) > 0 {
			fields[path("keys")] = MasterFieldInput{Text: strings.Join(keys, "\n"), Risk: masterFieldRiskSafe}
		}
		if keys := masterStringSlice(entry.Original["secondary_keys"]); len(keys) > 0 {
			fields[path("secondary_keys")] = MasterFieldInput{Text: strings.Join(keys, "\n"), Risk: masterFieldRiskSafe}
		}
	}
}

func masterNestedEntryID(entry tavernBookEntry) string {
	identity := strings.TrimSpace(entry.SourceRecordID)
	if identity == "" {
		identity = "generated:" + strings.Join([]string{entry.Comment, strings.Join(entry.Keys, "\x00"), strings.Join(entry.SecondaryKeys, "\x00"), entry.Group}, "\x01")
	}
	return "entry-" + masterHashString(identity)[:24]
}

func masterJSONMap(value any) map[string]any {
	data, _ := json.Marshal(value)
	var result map[string]any
	_ = json.Unmarshal(data, &result)
	return nonNilMasterMap(result)
}

func masterLoreEntryInput(entry tavernBookEntry, index int, sourceName string) MasterItemInput {
	identity := entry.SourceRecordID
	if identity == "" {
		raw := masterLoreEntrySourceSemantics(entry)
		identity = masterSourceEntryIdentity(raw)
	}
	title := tavernBookEntryTitle(entry, index)
	keywords := tavernCardTags(append(append([]string{}, entry.Keys...), entry.SecondaryKeys...)...)
	suggestion := ClassifyLoreItemHeuristic(LoreClassificationInput{Name: title, Tags: []string{"酒馆世界书", sourceName}, Keywords: keywords, Content: entry.Content})
	loadMode := LoreLoadModeAuto
	if entry.Constant {
		loadMode = LoreLoadModeResident
	}
	risk := masterFieldRiskSafe
	probe := LoreItemInput{Name: title, Tags: []string{"酒馆世界书", sourceName}, Keywords: keywords, Content: entry.Content}
	if materialManualOnly(probe) {
		loadMode, risk = LoreLoadModeManual, masterFieldRiskHigh
	}
	fields := map[string]MasterFieldInput{}
	if strings.TrimSpace(title) != "" {
		fields["lore_entry.name"] = MasterFieldInput{Text: title, Risk: masterFieldRiskSafe, Required: true}
	}
	if strings.TrimSpace(entry.Content) != "" {
		fields["lore_entry.content"] = MasterFieldInput{Text: entry.Content, Risk: risk, Required: risk == masterFieldRiskSafe}
	}
	return MasterItemInput{
		SourceEntryIdentity: identity, RecordKind: "worldbook_entry", SemanticType: suggestion.Type, Name: title,
		Original:         map[string]any{"name": title, "content": entry.Content, "source_name": sourceName},
		SourceSemantics:  masterLoreEntrySourceSemantics(entry),
		RuntimeSemantics: map[string]any{"enabled": entry.Enabled == nil || *entry.Enabled, "load_mode": loadMode, "keywords": keywords, "importance": "important"},
		Fields:           fields,
	}
}

func masterLoreEntrySourceSemantics(entry tavernBookEntry) map[string]any {
	if len(entry.SourceRaw) > 0 {
		return cloneMasterMap(entry.SourceRaw)
	}
	data, _ := json.Marshal(entry)
	var raw map[string]any
	_ = json.Unmarshal(data, &raw)
	return nonNilMasterMap(raw)
}

func buildMasterRuntimeOperations(filename string, data []byte, items []MasterItem, transaction MasterImportTransaction, existing []LoreItem) ([]LoreOperation, *normalizedTavernCard, map[string][]string, map[string]map[string]string, error) {
	names := newLoreNameAllocator(existing)
	ops := []LoreOperation{}
	targets := map[string][]string{}
	nestedLoreIDs := map[string]map[string]string{}
	var activeCard *normalizedTavernCard
	for _, item := range items {
		instanceID := transaction.InstanceIDs[item.MasterItemID]
		if item.RecordKind == "character_template" {
			card, err := parseTavernCharacterCard(filename, data)
			if err != nil {
				return nil, nil, nil, nil, err
			}
			applyMasterFieldsToCard(&card, item)
			userName := materialString(item.RuntimeSemantics["user_character_name"])
			coverPath := ""
			if card.IsPNG {
				coverPath = tavernCardCoverPath
			}
			built, _ := buildTavernCardLoreOperations(card, filename, coverPath, userName, names)
			nestedBySource := map[string]string{}
			for _, entry := range card.CharacterBook.Entries {
				nestedBySource[tavernEntryRecordID(entry, entry.ID)] = masterNestedEntryID(entry)
				nestedBySource[entry.SourceRecordID] = masterNestedEntryID(entry)
			}
			for index := range built {
				suffix := "character"
				if recordID := loreOperationSourceRecordID(built[index]); recordID != "" {
					if nestedID := nestedBySource[recordID]; nestedID != "" {
						suffix = "entry/" + nestedID
						if nestedLoreIDs[item.MasterItemID] == nil {
							nestedLoreIDs[item.MasterItemID] = map[string]string{}
						}
					}
				}
				if suffix == "character" && index > 0 {
					suffix = fmt.Sprintf("projection-%d", index)
				}
				built[index].Item.ID = masterRuntimeLoreID(instanceID, suffix)
				targets[item.MasterItemID] = append(targets[item.MasterItemID], built[index].Item.ID)
				if nestedID := strings.TrimPrefix(suffix, "entry/"); nestedID != suffix {
					nestedLoreIDs[item.MasterItemID][nestedID] = built[index].Item.ID
				}
			}
			targets[item.MasterItemID] = append([]string{}, targets[item.MasterItemID]...)
			ops = append(ops, built...)
			activeCard = &card
			continue
		}
		if item.RecordKind == "lorebook_template" {
			entryTargets, entryLoreIDs := buildMasterLorebookRuntimeOperations(filename, item, transaction, names)
			targets[item.MasterItemID] = append(targets[item.MasterItemID], entryTargets...)
			nestedLoreIDs[item.MasterItemID] = entryLoreIDs
			ops = append(ops, masterLorebookOperations(filename, item, transaction, entryLoreIDs, names)...)
			continue
		}
		name := masterActiveField(item, "lore_entry.name", materialString(item.Original["name"]))
		content := masterActiveField(item, "lore_entry.content", materialString(item.Original["content"]))
		enabled := true
		if value, ok := item.RuntimeSemantics["enabled"].(bool); ok {
			enabled = value
		}
		loadMode := firstNonEmptyLoreValue(materialString(item.RuntimeSemantics["load_mode"]), LoreLoadModeAuto)
		keywords := masterStringSlice(item.RuntimeSemantics["keywords"])
		targetID := masterRuntimeLoreID(instanceID, "lore")
		targets[item.MasterItemID] = []string{targetID}
		op := LoreOperation{Op: "create", Item: LoreItemInput{
			ID: targetID, Enabled: loreEnabledPtr(enabled), Type: firstNonEmptyLoreValue(item.SemanticType, "lore"),
			TypeSource: LoreTypeSourceHeuristic, Name: names.Claim(name), Importance: "important",
			Tags:             tavernCardTags("叙界总资料库", materialString(item.Original["source_name"])),
			BriefDescription: tavernLoreSearchBrief(item.SemanticType, name, keywords), Keywords: keywords,
			LoadMode: loadMode, Content: content,
			Provenance: &LoreProvenance{Kind: "narraverse_master_item", SourceName: filename, SourceRecordID: item.MasterItemID, SourceHash: strings.TrimPrefix(item.SourceRevision, "sha256:")},
		}}
		ops = append(ops, op)
	}
	return ops, activeCard, targets, nestedLoreIDs, nil
}

func loreOperationSourceRecordID(operation LoreOperation) string {
	if operation.Item.Provenance == nil {
		return ""
	}
	return operation.Item.Provenance.SourceRecordID
}

func buildMasterLorebookRuntimeOperations(filename string, item MasterItem, transaction MasterImportTransaction, names *loreNameAllocator) ([]string, map[string]string) {
	ids := make([]string, 0, len(item.NestedEntries))
	mapping := map[string]string{}
	for _, entry := range item.NestedEntries {
		id := masterRuntimeLoreID(transaction.InstanceIDs[item.MasterItemID], "entry/"+entry.EntryID)
		ids = append(ids, id)
		mapping[entry.EntryID] = id
	}
	return ids, mapping
}

func masterLorebookOperations(filename string, item MasterItem, transaction MasterImportTransaction, loreIDs map[string]string, names *loreNameAllocator) []LoreOperation {
	ops := make([]LoreOperation, 0, len(item.NestedEntries))
	for _, entry := range item.NestedEntries {
		name := masterNestedActiveField(item, entry.EntryID, "comment", materialString(entry.Original["comment"]))
		content := masterNestedActiveField(item, entry.EntryID, "content", materialString(entry.Original["content"]))
		keys := masterNestedActiveStrings(item, entry.EntryID, "keys", masterStringSlice(entry.Original["keys"]))
		secondary := masterNestedActiveStrings(item, entry.EntryID, "secondary_keys", masterStringSlice(entry.Original["secondary_keys"]))
		name = firstNonEmpty(name, strings.Join(keys, "、"), strings.Join(secondary, "、"), "设定条目 "+entry.EntryID)
		enabled, _ := entry.RuntimeSemantics["enabled"].(bool)
		if _, ok := entry.RuntimeSemantics["enabled"]; !ok {
			enabled = true
		}
		loadMode := firstNonEmptyLoreValue(materialString(entry.RuntimeSemantics["load_mode"]), LoreLoadModeAuto)
		ops = append(ops, LoreOperation{Op: "create", Item: LoreItemInput{
			ID: loreIDs[entry.EntryID], Enabled: loreEnabledPtr(enabled), Type: "lore", TypeSource: LoreTypeSourceHeuristic,
			Name: names.Claim(name), Importance: "important", Tags: tavernCardTags("叙界总资料库", filename),
			BriefDescription: tavernLoreSearchBrief("lore", name, append(keys, secondary...)), Keywords: append(keys, secondary...),
			LoadMode: loadMode, Content: content,
			Provenance: &LoreProvenance{Kind: "narraverse_master_nested_entry", SourceName: filename, SourceRecordID: entry.EntryID, SourceHash: strings.TrimPrefix(item.SourceRevision, "sha256:")},
		}})
	}
	return ops
}

func applyMasterFieldsToCard(card *normalizedTavernCard, item MasterItem) {
	card.Name = masterActiveField(item, "character.name", card.Name)
	card.Description = masterActiveField(item, "character.description", card.Description)
	card.Personality = masterActiveField(item, "character.personality", card.Personality)
	card.Scenario = masterActiveField(item, "character.scenario", card.Scenario)
	card.FirstMes = masterActiveField(item, "character.openings[0]", card.FirstMes)
	for index := range card.AlternateGreetings {
		path := fmt.Sprintf("character.openings[%d]", index+1)
		card.AlternateGreetings[index] = masterActiveField(item, path, card.AlternateGreetings[index])
	}
	card.MesExample = masterActiveField(item, "character.mes_example", card.MesExample)
	card.CreatorNotes = masterActiveField(item, "character.creator_notes", card.CreatorNotes)
	card.CreatorComment = masterActiveField(item, "character.creator_comment", card.CreatorComment)
	card.SystemPrompt = masterActiveField(item, "character.system_prompt", card.SystemPrompt)
	card.PostHistoryInstructions = masterActiveField(item, "character.post_history_instructions", card.PostHistoryInstructions)
	if card.CharacterBook == nil {
		return
	}
	for index := range card.CharacterBook.Entries {
		entry := &card.CharacterBook.Entries[index]
		entryID := masterNestedEntryID(*entry)
		entry.Comment = masterNestedActiveField(item, entryID, "comment", entry.Comment)
		entry.Content = masterNestedActiveField(item, entryID, "content", entry.Content)
		entry.Keys = masterNestedActiveStrings(item, entryID, "keys", entry.Keys)
		entry.SecondaryKeys = masterNestedActiveStrings(item, entryID, "secondary_keys", entry.SecondaryKeys)
	}
}

func masterNestedActiveField(item MasterItem, entryID, field, fallback string) string {
	return masterActiveField(item, "character_book.entries/"+entryID+"/"+field, masterActiveField(item, "lorebook.entries/"+entryID+"/"+field, fallback))
}

func masterNestedActiveStrings(item MasterItem, entryID, field string, fallback []string) []string {
	value := masterNestedActiveField(item, entryID, field, "")
	if strings.TrimSpace(value) == "" {
		return append([]string{}, fallback...)
	}
	return tavernCardTags(strings.FieldsFunc(value, func(r rune) bool { return r == '\n' || r == ',' || r == '，' })...)
}

func masterActiveField(item MasterItem, path, fallback string) string {
	if field, found := item.Fields[path]; found && strings.TrimSpace(field.ActiveText) != "" {
		return field.ActiveText
	}
	return fallback
}

func masterStringSlice(value any) []string {
	switch values := value.(type) {
	case []string:
		return append([]string{}, values...)
	case []any:
		result := []string{}
		for _, item := range values {
			if text := materialString(item); text != "" {
				result = append(result, text)
			}
		}
		return result
	default:
		return nil
	}
}

func emptyMaterialImportResult() MaterialImportResult {
	return MaterialImportResult{
		CreatedIDs: []string{}, UpdatedIDs: []string{}, ConflictIDs: []string{}, SkippedIDs: []string{},
		Failed: []string{}, ItemIDs: []string{}, MasterItemIDs: []string{}, TranslationTargets: []MasterTranslationTarget{},
	}
}

func parseStandaloneLorebook(filename string, data []byte) (string, *tavernCharacterBook, error) {
	var root map[string]any
	if err := json.Unmarshal(data, &root); err != nil {
		return "", nil, fmt.Errorf("设定书 JSON 无效: %w", err)
	}
	container := root
	if value, ok := root["data"].(map[string]any); ok {
		container = value
	}
	if value, ok := container["character_book"].(map[string]any); ok {
		container = value
	}
	entriesValue, ok := container["entries"]
	if !ok {
		return "", nil, errors.New("未找到设定书 entries")
	}
	rawEntries := normalizeMaterialEntries(entriesValue)
	if len(rawEntries) == 0 {
		return "", nil, errors.New("设定书没有可导入条目")
	}
	entries := make([]tavernBookEntry, 0, len(rawEntries))
	for index, raw := range rawEntries {
		entries = append(entries, decodeMaterialEntry(raw, index))
	}
	name := strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename))
	if value := strings.TrimSpace(materialString(container["name"])); value != "" {
		name = value
	}
	return name, &tavernCharacterBook{Name: name, Entries: entries}, nil
}

func materialLooksLikeCharacterCard(filename string, data []byte) bool {
	if strings.EqualFold(filepath.Ext(filename), ".png") {
		return len(data) >= len(pngSignature) && string(data[:len(pngSignature)]) == string(pngSignature)
	}
	var root map[string]any
	if json.Unmarshal(data, &root) != nil {
		return false
	}
	if spec := strings.ToLower(materialString(root["spec"])); strings.Contains(spec, "chara") {
		return true
	}
	container := root
	if value, ok := root["data"].(map[string]any); ok {
		container = value
	}
	if _, hasEntries := container["entries"]; hasEntries {
		return false
	}
	for _, key := range []string{"description", "personality", "scenario", "first_mes", "mes_example", "alternate_greetings"} {
		if _, found := container[key]; found {
			return true
		}
	}
	return false
}

func normalizeMaterialEntries(value any) []map[string]any {
	if list, ok := value.([]any); ok {
		result := make([]map[string]any, 0, len(list))
		for _, item := range list {
			if entry, yes := item.(map[string]any); yes {
				result = append(result, entry)
			}
		}
		return result
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, ea := strconv.Atoi(keys[i])
		b, eb := strconv.Atoi(keys[j])
		if ea == nil && eb == nil {
			return a < b
		}
		return keys[i] < keys[j]
	})
	result := make([]map[string]any, 0, len(keys))
	for _, key := range keys {
		if entry, yes := object[key].(map[string]any); yes {
			if _, found := entry["id"]; !found {
				if _, hasUID := entry["uid"]; hasUID {
					result = append(result, entry)
					continue
				}
				entry["id"] = key
			}
			result = append(result, entry)
		}
	}
	return result
}

func decodeMaterialEntry(raw map[string]any, index int) tavernBookEntry {
	enabled := true
	if value, ok := raw["enabled"].(bool); ok {
		enabled = value
	}
	if value, ok := raw["disable"].(bool); ok && value {
		enabled = false
	}
	id := index
	if number, ok := materialInt(raw["id"]); ok {
		id = number
	} else if number, ok := materialInt(raw["uid"]); ok {
		id = number
	}
	return tavernBookEntry{
		ID: id, Keys: materialStrings(firstMaterialValue(raw, "keys", "key")), SecondaryKeys: materialStrings(firstMaterialValue(raw, "secondary_keys", "keysecondary")),
		Comment: firstNonEmptyLoreValue(materialString(raw["comment"]), materialString(raw["name"])), Content: materialString(raw["content"]),
		Constant: materialBool(raw["constant"]), Selective: materialBool(raw["selective"]), Enabled: &enabled,
		Position: raw["position"], InsertionOrder: id, Group: materialString(raw["group"]), Depth: raw["depth"], Role: raw["role"],
		PreventRecursion: materialBool(raw["preventRecursion"]), DelayUntilRecursion: materialBool(raw["delayUntilRecursion"]), Vectorized: materialBool(raw["vectorized"]),
		SourceRecordID: masterSourceEntryIdentity(raw), SourceRaw: cloneMasterMap(raw),
	}
}

func reconcileMaterialOperations(sourceID string, preview MaterialPreview, ops []LoreOperation, existing []LoreItem, previous map[string]materialManifestTarget) ([]LoreOperation, []materialManifestTarget, MaterialImportResult) {
	byID := map[string]LoreItem{}
	for _, item := range existing {
		byID[item.ID] = item
	}
	names := newLoreNameAllocator(existing)
	result := MaterialImportResult{}
	reconciled := make([]LoreOperation, 0, len(ops))
	targets := make([]materialManifestTarget, 0, len(ops))
	for index, op := range ops {
		recordID := strconv.Itoa(index)
		if op.Item.Provenance != nil && op.Item.Provenance.SourceRecordID != "" {
			recordID = op.Item.Provenance.SourceRecordID
		}
		op.Item.ID = stableMaterialLoreID(sourceID, recordID, op.Item.Type)
		if op.Item.Provenance == nil {
			op.Item.Provenance = &LoreProvenance{Kind: preview.Kind, SourceRecordID: recordID}
		}
		op.Item.Provenance.SourceName = preview.Name
		if current, found := byID[op.Item.ID]; found {
			old, tracked := previous[op.Item.ID]
			if current.Provenance != nil && current.Provenance.SourceHash == op.Item.Provenance.SourceHash {
				result.SkippedIDs = append(result.SkippedIDs, current.ID)
				targets = append(targets, materialManifestTarget{SourceRecordID: recordID, TargetID: current.ID, ManagedHash: materialItemHash(current), Status: "skipped"})
				continue
			}
			if tracked && old.ManagedHash == materialItemHash(current) {
				op.Op, op.ID, op.Item.Name = "update", current.ID, current.Name
				managedHash := materialInputHash(op.Item)
				reconciled = append(reconciled, op)
				result.UpdatedIDs = append(result.UpdatedIDs, current.ID)
				targets = append(targets, materialManifestTarget{SourceRecordID: recordID, TargetID: current.ID, ManagedHash: managedHash, Status: "updated"})
				continue
			}
			conflictID := op.Item.ID + "-conflict-" + op.Item.Provenance.SourceHash[:8]
			op.Item.ID, op.Item.Name = conflictID, names.Claim(op.Item.Name+"（导入冲突）")
			managedHash := materialInputHash(op.Item)
			if _, exists := byID[conflictID]; exists {
				result.SkippedIDs = append(result.SkippedIDs, conflictID)
			} else {
				reconciled = append(reconciled, op)
				result.ConflictIDs = append(result.ConflictIDs, conflictID)
				byID[conflictID] = LoreItem{ID: conflictID, Name: op.Item.Name}
			}
			targets = append(targets, materialManifestTarget{SourceRecordID: recordID, TargetID: conflictID, ManagedHash: managedHash, Status: "conflict"})
			continue
		}
		op.Item.Name = names.Claim(op.Item.Name)
		managedHash := materialInputHash(op.Item)
		reconciled = append(reconciled, op)
		result.CreatedIDs = append(result.CreatedIDs, op.Item.ID)
		byID[op.Item.ID] = LoreItem{ID: op.Item.ID, Name: op.Item.Name}
		targets = append(targets, materialManifestTarget{SourceRecordID: recordID, TargetID: op.Item.ID, ManagedHash: managedHash, Status: "created"})
	}
	return reconciled, targets, result
}

func materialSourceID(filename string, _ []byte) string {
	sum := sha256.Sum256([]byte("user_upload\x00" + strings.ToLower(filepath.Base(filename))))
	return hex.EncodeToString(sum[:12])
}
func stableMaterialLoreID(sourceID, recordID, group string) string {
	sum := sha256.Sum256([]byte(sourceID + "\x00" + recordID + "\x00" + group))
	return "material-" + hex.EncodeToString(sum[:12])
}
func materialContainsTruncation(data []byte) bool {
	text := string(data)
	return strings.Contains(text, "内容已截断") || strings.Contains(strings.ToLower(text), "content truncated")
}

func materialCardContainsTruncation(card normalizedTavernCard) bool {
	values := []string{card.Description, card.Personality, card.Scenario, card.FirstMes, card.MesExample, card.CreatorNotes, card.CreatorComment, card.SystemPrompt, card.PostHistoryInstructions}
	values = append(values, card.AlternateGreetings...)
	if card.CharacterBook != nil {
		for _, entry := range card.CharacterBook.Entries {
			values = append(values, entry.Comment, entry.Content)
		}
	}
	return materialContainsTruncation([]byte(strings.Join(values, "\n")))
}
func materialManualOnly(item LoreItemInput) bool {
	text := strings.ToLower(strings.Join(append(append([]string{item.Name, item.Content}, item.Tags...), item.Keywords...), "\n"))
	return strings.Contains(text, "regex") || strings.Contains(text, "正则") || strings.Contains(text, "script") || strings.Contains(text, "脚本") || strings.Contains(text, "作者约束")
}
func materialInputHash(input LoreItemInput) string {
	data, _ := json.Marshal([]any{input.Enabled, input.Type, input.Name, input.Importance, input.Tags, input.BriefDescription, input.Keywords, input.LoadMode, input.Content})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
func materialItemHash(item LoreItem) string {
	enabled := item.Enabled
	return materialInputHash(LoreItemInput{Enabled: &enabled, Type: item.Type, Name: item.Name, Importance: item.Importance, Tags: item.Tags, BriefDescription: item.BriefDescription, Keywords: item.Keywords, LoadMode: item.LoadMode, Content: item.Content})
}
func manifestTargets(manifest materialManifest, sourceID string) map[string]materialManifestTarget {
	result := map[string]materialManifestTarget{}
	for i := len(manifest.Imports) - 1; i >= 0; i-- {
		if manifest.Imports[i].SourceID == sourceID {
			for _, target := range manifest.Imports[i].Targets {
				result[target.TargetID] = target
			}
			break
		}
	}
	return result
}
func loadMaterialManifest(workspace string) (materialManifest, string, error) {
	path := filepath.Join(workspace, filepath.FromSlash(materialManifestPath))
	manifest := materialManifest{Version: 1, Imports: []materialManifestImport{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return manifest, path, nil
	}
	if err != nil {
		return manifest, path, err
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return manifest, path, fmt.Errorf("素材导入清单损坏: %w", err)
	}
	return manifest, path, nil
}
func snapshotMaterialFiles(paths ...string) ([]characterCardFileSnapshot, error) {
	snapshots := make([]characterCardFileSnapshot, 0, len(paths))
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			snapshots = append(snapshots, characterCardFileSnapshot{path: path})
			continue
		}
		if err != nil {
			return nil, err
		}
		snapshots = append(snapshots, characterCardFileSnapshot{path: path, data: data, existed: true})
	}
	return snapshots, nil
}
func atomicWriteMaterial(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tempFile, err := os.CreateTemp(filepath.Dir(path), ".material-*.tmp")
	if err != nil {
		return err
	}
	temp := tempFile.Name()
	defer os.Remove(temp)
	if err := tempFile.Chmod(0o644); err != nil {
		tempFile.Close()
		return err
	}
	if _, err := tempFile.Write(data); err != nil {
		tempFile.Close()
		return err
	}
	if err := tempFile.Sync(); err != nil {
		tempFile.Close()
		return err
	}
	if err := tempFile.Close(); err != nil {
		return err
	}
	return os.Rename(temp, path)
}
func safeMaterialFilename(value string) string {
	value = filepath.Base(value)
	value = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`<>:"/\\|?*`, r) || r < 32 {
			return '_'
		}
		return r
	}, value)
	if value == "" {
		return "material.json"
	}
	return value
}
func firstMaterialValue(values map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, found := values[key]; found {
			return value
		}
	}
	return nil
}
func materialString(value any) string {
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return ""
}
func materialStrings(value any) []string {
	if text, ok := value.(string); ok {
		fields := strings.FieldsFunc(text, func(r rune) bool { return r == ',' || r == '，' || r == '\n' })
		return fields
	}
	list, _ := value.([]any)
	result := []string{}
	for _, item := range list {
		if text := materialString(item); text != "" {
			result = append(result, text)
		}
	}
	return result
}
func materialBool(value any) bool { result, _ := value.(bool); return result }
func materialInt(value any) (int, bool) {
	switch number := value.(type) {
	case float64:
		return int(number), true
	case int:
		return number, true
	case string:
		parsed, err := strconv.Atoi(number)
		return parsed, err == nil
	}
	return 0, false
}
func appendUnique(values []string, additions ...string) []string {
	seen := map[string]bool{}
	for _, value := range values {
		seen[value] = true
	}
	for _, value := range additions {
		if value != "" && !seen[value] {
			values = append(values, value)
			seen[value] = true
		}
	}
	return values
}
