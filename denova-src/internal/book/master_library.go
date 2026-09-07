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
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	masterLibraryProjectName = "narraverse-master-library"
	masterManifestPath       = ".narraverse/master-library-manifest.json"
	masterSchemaVersion      = 3
	masterFieldRiskSafe      = "safe"
	masterFieldRiskHigh      = "high"
)

var (
	masterSourceNamespace      = uuid.MustParse("f3b6bb9f-130d-5e5b-95cf-03ef0ff6eb16")
	masterItemNamespace        = uuid.MustParse("01fa5ec0-d4f2-52c2-84d6-e48340d3ee7f")
	masterTranslationNamespace = uuid.MustParse("8df0a933-1451-51a0-91ba-b80a055631d3")
	masterImportNamespace      = uuid.MustParse("5696726a-3ab5-5eef-889c-e1a5a5f1370e")
	masterInstanceNamespace    = uuid.MustParse("5dd80569-5f0d-578d-b021-895224972502")
	masterStoreLocks           sync.Map
)

// MasterLibraryManifest is the only index joining source, item, translation,
// import, and adventure-instance records. Object bodies stay in separate files.
type MasterLibraryManifest struct {
	SchemaVersion      int                    `json:"schema_version"`
	DataVersion        int                    `json:"data_version"`
	Revision           string                 `json:"revision"`
	UpdatedAt          string                 `json:"updated_at"`
	Sources            []MasterSourceRecord   `json:"sources"`
	Items              []MasterItemRef        `json:"items"`
	Translations       []MasterTranslationRef `json:"translations"`
	Imports            []MasterImportRef      `json:"imports"`
	Instances          []MasterInstanceRef    `json:"instances"`
	LegacyItems        []MasterItemRef        `json:"legacy_items,omitempty"`
	LegacyTranslations []MasterTranslationRef `json:"legacy_translations,omitempty"`
	LegacyImports      []MasterImportRef      `json:"legacy_imports,omitempty"`
	LegacyInstances    []MasterInstanceRef    `json:"legacy_instances,omitempty"`
}

type MasterSourceRecord struct {
	SourceID        string                 `json:"source_id"`
	OriginKey       string                 `json:"origin_key,omitempty"`
	OriginAliases   []string               `json:"origin_aliases"`
	SourceKind      string                 `json:"source_kind"`
	Filename        string                 `json:"filename"`
	CurrentRevision string                 `json:"current_revision"`
	Revisions       []MasterSourceRevision `json:"revisions"`
}

type MasterSourceRevision struct {
	Revision       string `json:"revision"`
	SHA256         string `json:"sha256"`
	Bytes          int    `json:"bytes"`
	OriginalPath   string `json:"original_path"`
	ImportedAt     string `json:"imported_at"`
	ParentRevision string `json:"parent_revision,omitempty"`
}

type MasterItemRef struct {
	MasterItemID        string `json:"master_item_id"`
	SourceID            string `json:"source_id"`
	SourceRevision      string `json:"source_revision"`
	SourceEntryIdentity string `json:"source_entry_identity"`
	RecordKind          string `json:"record_kind"`
	Path                string `json:"path"`
	Revision            string `json:"revision"`
}

type MasterTranslationRef struct {
	TranslationVersionID string `json:"translation_version_id"`
	MasterItemID         string `json:"master_item_id"`
	FieldPath            string `json:"field_path"`
	Path                 string `json:"path"`
	Revision             string `json:"revision"`
}

type MasterImportRef struct {
	ImportID       string `json:"import_id"`
	IdempotencyKey string `json:"idempotency_key"`
	Path           string `json:"path"`
	Status         string `json:"status"`
}

type MasterInstanceRef struct {
	InstanceID         string            `json:"instance_id"`
	ImportID           string            `json:"import_id"`
	MasterItemID       string            `json:"master_item_id"`
	AdventureKey       string            `json:"adventure_key"`
	TargetLoreIDs      []string          `json:"target_lore_ids"`
	NestedEntryLoreIDs map[string]string `json:"nested_entry_lore_ids,omitempty"`
	LoadedRevision     string            `json:"loaded_revision,omitempty"`
}

type MasterNestedEntry struct {
	EntryID             string         `json:"entry_id"`
	SourceEntryIdentity string         `json:"source_entry_identity"`
	Original            map[string]any `json:"original"`
	SourceSemantics     map[string]any `json:"source_semantics"`
	RuntimeSemantics    map[string]any `json:"runtime_semantics"`
}

type MasterItem struct {
	SchemaVersion         int                    `json:"schema_version"`
	DataVersion           int                    `json:"data_version"`
	Revision              string                 `json:"revision"`
	UpdatedAt             string                 `json:"updated_at"`
	MasterItemID          string                 `json:"master_item_id"`
	SourceID              string                 `json:"source_id"`
	SourceRevision        string                 `json:"source_revision"`
	SourceEntryIdentity   string                 `json:"source_entry_identity"`
	RecordKind            string                 `json:"record_kind"`
	SemanticType          string                 `json:"semantic_type"`
	Original              map[string]any         `json:"original"`
	SourceSemantics       map[string]any         `json:"source_semantics"`
	RuntimeSemantics      map[string]any         `json:"runtime_semantics"`
	Fields                map[string]MasterField `json:"fields"`
	NestedEntries         []MasterNestedEntry    `json:"nested_entries,omitempty"`
	ActiveWorkingRevision string                 `json:"active_working_revision"`
}

type MasterField struct {
	SourceText                 string `json:"source_text"`
	SourceSHA256               string `json:"source_sha256"`
	Risk                       string `json:"risk"`
	Required                   bool   `json:"required"`
	NeedsTranslation           bool   `json:"needs_translation"`
	ActiveText                 string `json:"active_text,omitempty"`
	ActiveKind                 string `json:"active_kind,omitempty"`
	ActiveTranslationVersionID string `json:"active_translation_version_id,omitempty"`
}

type MasterTranslationVersion struct {
	SchemaVersion        int    `json:"schema_version"`
	TranslationVersionID string `json:"translation_version_id"`
	MasterItemID         string `json:"master_item_id"`
	FieldPath            string `json:"field_path"`
	SourceRevision       string `json:"source_revision"`
	SourceSHA256         string `json:"source_sha256"`
	SourceText           string `json:"source_text"`
	Translation          string `json:"translation"`
	TranslationSHA256    string `json:"translation_sha256"`
	Model                string `json:"model"`
	JobID                string `json:"job_id,omitempty"`
	Confirmed            bool   `json:"confirmed"`
	CreatedAt            string `json:"created_at"`
	Revision             string `json:"revision"`
	MigratedFrom         string `json:"migrated_from,omitempty"`
}

type MasterTranslationTarget struct {
	ImportID       string `json:"import_id"`
	SourceID       string `json:"source_id"`
	SourceRevision string `json:"source_revision"`
	MasterItemID   string `json:"master_item_id"`
	ItemName       string `json:"item_name"`
	FieldPath      string `json:"field_path"`
	SourceText     string `json:"source_text"`
	SourceSHA256   string `json:"source_sha256"`
	Mode           string `json:"mode"`
	ApplyPolicy    string `json:"apply_policy"`
	Required       bool   `json:"required"`
	Status         string `json:"status"`
}

type MasterImportTransaction struct {
	SchemaVersion      int                       `json:"schema_version"`
	ImportID           string                    `json:"import_id"`
	IdempotencyKey     string                    `json:"idempotency_key"`
	AdventureWorkspace string                    `json:"adventure_workspace"`
	AdventureKey       string                    `json:"adventure_key"`
	SourceID           string                    `json:"source_id"`
	SourceRevision     string                    `json:"source_revision"`
	ItemIDs            []string                  `json:"item_ids"`
	InstanceIDs        map[string]string         `json:"instance_ids"`
	TargetLoreIDs      []string                  `json:"target_lore_ids"`
	TranslationTargets []MasterTranslationTarget `json:"translation_targets"`
	Status             string                    `json:"status"`
	CreatedAt          string                    `json:"created_at"`
	UpdatedAt          string                    `json:"updated_at"`
}

type MasterFieldInput struct {
	Text     string
	Risk     string
	Required bool
}

type MasterItemInput struct {
	SourceEntryIdentity string
	RecordKind          string
	SemanticType        string
	Name                string
	Original            map[string]any
	SourceSemantics     map[string]any
	RuntimeSemantics    map[string]any
	Fields              map[string]MasterFieldInput
	NestedEntries       []MasterNestedEntry
}

type MasterIngestInput struct {
	Filename           string
	Data               []byte
	SourceAnchor       string
	SourceKind         string
	AdventureWorkspace string
	Items              []MasterItemInput
}

type MasterIngestResult struct {
	MasterWorkspace string
	Source          MasterSourceRecord
	SourceRevision  MasterSourceRevision
	Items           []MasterItem
	Transaction     MasterImportTransaction
}

type MasterTranslationApplyInput struct {
	ImportID               string `json:"import_id"`
	MasterItemID           string `json:"master_item_id"`
	FieldPath              string `json:"field_path"`
	SourceSHA256           string `json:"source_sha256"`
	InputRevision          string `json:"input_revision,omitempty"`
	BaseTranslationVersion string `json:"base_translation_version,omitempty"`
	Translation            string `json:"translation"`
	Model                  string `json:"model"`
	JobID                  string `json:"job_id"`
	Confirmed              bool   `json:"confirmed"`
	Candidate              bool   `json:"candidate,omitempty"`
}

type MasterTranslationApplyResult struct {
	TranslationVersionID string                  `json:"translation_version_id"`
	Activated            bool                    `json:"activated"`
	Ready                bool                    `json:"ready"`
	Transaction          MasterImportTransaction `json:"transaction"`
}

type MasterLibraryStore struct {
	workspace          string
	adventureWorkspace string
	mu                 *sync.Mutex
}

func NewMasterLibraryStore(adventureWorkspace string) *MasterLibraryStore {
	workspace := ResolveMasterLibraryWorkspace(adventureWorkspace)
	lock, _ := masterStoreLocks.LoadOrStore(strings.ToLower(filepath.Clean(workspace)), &sync.Mutex{})
	return &MasterLibraryStore{workspace: workspace, adventureWorkspace: adventureWorkspace, mu: lock.(*sync.Mutex)}
}

func ResolveMasterLibraryWorkspace(adventureWorkspace string) string {
	abs, err := filepath.Abs(strings.TrimSpace(adventureWorkspace))
	if err != nil {
		abs = filepath.Clean(strings.TrimSpace(adventureWorkspace))
	}
	if strings.EqualFold(filepath.Base(abs), masterLibraryProjectName) {
		return abs
	}
	parent := filepath.Dir(abs)
	if strings.EqualFold(filepath.Base(parent), "projects") {
		return filepath.Join(parent, masterLibraryProjectName)
	}
	if base := strings.ToLower(filepath.Base(parent)); base == ".denova" || base == ".nova" {
		return filepath.Join(parent, "projects", masterLibraryProjectName)
	}
	return filepath.Join(parent, masterLibraryProjectName)
}

func (s *MasterLibraryStore) Workspace() string { return s.workspace }

// TransactionTargetsAdventure reports whether a completed import should be
// projected into an Adventure. Master-only ingestion records the Master
// workspace itself as the target and stops after becoming ready.
func (s *MasterLibraryStore) TransactionTargetsAdventure(transaction MasterImportTransaction) bool {
	target := strings.TrimSpace(transaction.AdventureWorkspace)
	return target != "" && filepath.Clean(target) != filepath.Clean(s.workspace)
}

func (s *MasterLibraryStore) Ingest(input MasterIngestInput) (MasterIngestResult, error) {
	if len(input.Data) == 0 || strings.TrimSpace(input.Filename) == "" {
		return MasterIngestResult{}, errors.New("总库导入缺少完整原文件")
	}
	if len(input.Items) == 0 {
		return MasterIngestResult{}, errors.New("总库导入没有规范条目")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.initializeUnlocked(); err != nil {
		return MasterIngestResult{}, err
	}
	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return MasterIngestResult{}, err
	}
	source, sourceRevision, err := s.upsertSourceUnlocked(&manifest, input)
	if err != nil {
		return MasterIngestResult{}, err
	}
	adventureWorkspace := firstNonEmptyLoreValue(input.AdventureWorkspace, s.adventureWorkspace)
	adventureKey := masterHashString(filepath.Clean(adventureWorkspace))
	idempotencyKey := masterHashString(adventureKey + "\x00" + source.SourceID + "\x00" + sourceRevision.Revision)
	importID := uuid.NewSHA1(masterImportNamespace, []byte(idempotencyKey)).String()
	if existing, ok := masterImportByID(manifest, importID); ok {
		transaction, loadErr := s.loadImportUnlocked(existing.Path)
		if loadErr != nil {
			return MasterIngestResult{}, loadErr
		}
		items, loadErr := s.loadItemsUnlocked(transaction.ItemIDs)
		return MasterIngestResult{MasterWorkspace: s.workspace, Source: source, SourceRevision: sourceRevision, Items: items, Transaction: transaction}, loadErr
	}

	items := make([]MasterItem, 0, len(input.Items))
	targets := []MasterTranslationTarget{}
	instanceIDs := map[string]string{}
	for _, raw := range input.Items {
		item, itemTargets, buildErr := s.buildItemUnlocked(source, sourceRevision, importID, raw)
		if buildErr != nil {
			return MasterIngestResult{}, buildErr
		}
		if saveErr := s.saveItemUnlocked(&manifest, item); saveErr != nil {
			return MasterIngestResult{}, saveErr
		}
		items = append(items, item)
		targets = append(targets, itemTargets...)
		instanceIDs[item.MasterItemID] = uuid.NewSHA1(masterInstanceNamespace, []byte(importID+"\x00"+item.MasterItemID)).String()
	}
	status := "ready"
	for _, target := range targets {
		if target.Required && target.Status != "active" {
			status = "pending_translation"
			break
		}
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	transaction := MasterImportTransaction{
		SchemaVersion: masterSchemaVersion, ImportID: importID, IdempotencyKey: idempotencyKey,
		AdventureWorkspace: adventureWorkspace, AdventureKey: adventureKey,
		SourceID: source.SourceID, SourceRevision: sourceRevision.Revision,
		ItemIDs: masterItemIDs(items), InstanceIDs: instanceIDs, TargetLoreIDs: []string{}, TranslationTargets: targets,
		Status: status, CreatedAt: now, UpdatedAt: now,
	}
	transactionPath := masterImportRelPath(importID)
	if err := s.writeJSONUnlocked(transactionPath, transaction); err != nil {
		return MasterIngestResult{}, err
	}
	manifest.Imports = append(manifest.Imports, MasterImportRef{ImportID: importID, IdempotencyKey: idempotencyKey, Path: transactionPath, Status: status})
	if err := s.saveManifestUnlocked(manifest); err != nil {
		return MasterIngestResult{}, err
	}
	return MasterIngestResult{MasterWorkspace: s.workspace, Source: source, SourceRevision: sourceRevision, Items: items, Transaction: transaction}, nil
}

func (s *MasterLibraryStore) ApplyTranslation(input MasterTranslationApplyInput) (MasterTranslationApplyResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.applyTranslationUnlocked(input)
}

func (s *MasterLibraryStore) applyTranslationUnlocked(input MasterTranslationApplyInput) (MasterTranslationApplyResult, error) {
	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return MasterTranslationApplyResult{}, err
	}
	importRef, ok := masterImportByID(manifest, strings.TrimSpace(input.ImportID))
	if !ok {
		return MasterTranslationApplyResult{}, errors.New("总库导入事务不存在")
	}
	transaction, err := s.loadImportUnlocked(importRef.Path)
	if err != nil {
		return MasterTranslationApplyResult{}, err
	}
	if filepath.Clean(transaction.AdventureWorkspace) != filepath.Clean(s.adventureWorkspace) && filepath.Clean(transaction.AdventureWorkspace) != filepath.Clean(s.workspace) {
		return MasterTranslationApplyResult{}, errors.New("总库导入事务不属于当前冒险")
	}
	item, err := s.loadItemUnlocked(input.MasterItemID)
	if err != nil {
		return MasterTranslationApplyResult{}, err
	}
	field, ok := item.Fields[input.FieldPath]
	if !ok {
		return MasterTranslationApplyResult{}, errors.New("总库字段路径不存在")
	}
	if field.SourceSHA256 != strings.TrimSpace(input.SourceSHA256) {
		return MasterTranslationApplyResult{}, errors.New("总库字段原文已变化，请重新翻译")
	}
	if expected := strings.TrimSpace(input.InputRevision); expected != "" && expected != item.Revision {
		return MasterTranslationApplyResult{}, &MasterCASConflictError{MasterItemID: item.MasterItemID, FieldPath: input.FieldPath, ExpectedRevision: expected, ActualRevision: item.Revision}
	}
	if expected := strings.TrimSpace(input.BaseTranslationVersion); expected != "" && expected != field.ActiveTranslationVersionID {
		return MasterTranslationApplyResult{}, &MasterCASConflictError{MasterItemID: item.MasterItemID, FieldPath: input.FieldPath, ExpectedVersion: expected, ActualVersion: field.ActiveTranslationVersionID}
	}
	translation := strings.TrimSpace(input.Translation)
	if translation == "" {
		return MasterTranslationApplyResult{}, errors.New("译文不能为空")
	}
	translationHash := masterHashString(translation)
	versionKey := strings.Join([]string{item.MasterItemID, input.FieldPath, item.SourceRevision, field.SourceSHA256, translationHash, strings.TrimSpace(input.Model), fmt.Sprintf("%t", input.Confirmed)}, "\x00")
	versionID := uuid.NewSHA1(masterTranslationNamespace, []byte(versionKey)).String()
	version := MasterTranslationVersion{
		SchemaVersion: masterSchemaVersion, TranslationVersionID: versionID,
		MasterItemID: item.MasterItemID, FieldPath: input.FieldPath,
		SourceRevision: item.SourceRevision, SourceSHA256: field.SourceSHA256,
		SourceText: field.SourceText, Translation: translation, TranslationSHA256: translationHash,
		Model: strings.TrimSpace(input.Model), JobID: strings.TrimSpace(input.JobID),
		Confirmed: input.Confirmed, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	version.Revision = masterObjectRevision(version)
	versionPath := filepath.ToSlash(filepath.Join(".narraverse", "translations", versionID+".json"))
	if _, statErr := os.Stat(filepath.Join(s.workspace, filepath.FromSlash(versionPath))); errors.Is(statErr, os.ErrNotExist) {
		if err := s.writeJSONUnlocked(versionPath, version); err != nil {
			return MasterTranslationApplyResult{}, err
		}
		manifest.Translations = append(manifest.Translations, MasterTranslationRef{TranslationVersionID: versionID, MasterItemID: item.MasterItemID, FieldPath: input.FieldPath, Path: versionPath, Revision: version.Revision})
	} else if statErr != nil {
		return MasterTranslationApplyResult{}, statErr
	}
	// Candidate versions are durable proposals, not active Master content.
	// Existing HY-MT callers keep the historical safe-field behavior because
	// Candidate defaults to false.
	activated := !input.Candidate && (field.Risk != masterFieldRiskHigh || input.Confirmed)
	if activated {
		field.ActiveText = translation
		field.ActiveKind = "translation"
		field.ActiveTranslationVersionID = versionID
		item.Fields[input.FieldPath] = field
		item.ActiveWorkingRevision = masterActiveWorkingRevision(item.Fields)
		if err := s.saveItemUnlocked(&manifest, item); err != nil {
			return MasterTranslationApplyResult{}, err
		}
	}
	for index := range transaction.TranslationTargets {
		target := &transaction.TranslationTargets[index]
		if target.MasterItemID == item.MasterItemID && target.FieldPath == input.FieldPath {
			if activated {
				target.Status = "active"
			} else {
				target.Status = "pending_review"
			}
		}
	}
	ready := masterTransactionReady(transaction)
	if ready && transaction.Status == "pending_translation" {
		transaction.Status = "ready"
	}
	transaction.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.writeJSONUnlocked(importRef.Path, transaction); err != nil {
		return MasterTranslationApplyResult{}, err
	}
	for index := range manifest.Imports {
		if manifest.Imports[index].ImportID == transaction.ImportID {
			manifest.Imports[index].Status = transaction.Status
		}
	}
	if err := s.saveManifestUnlocked(manifest); err != nil {
		return MasterTranslationApplyResult{}, err
	}
	return MasterTranslationApplyResult{TranslationVersionID: versionID, Activated: activated, Ready: ready, Transaction: transaction}, nil
}

func (s *MasterLibraryStore) LoadImport(importID string) (MasterImportTransaction, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return MasterImportTransaction{}, err
	}
	ref, ok := masterImportByID(manifest, importID)
	if !ok {
		return MasterImportTransaction{}, os.ErrNotExist
	}
	return s.loadImportUnlocked(ref.Path)
}

func (s *MasterLibraryStore) LoadItem(masterItemID string) (MasterItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadItemUnlocked(masterItemID)
}

// MasterAssetArchiveResult describes a safe removal from the active Master
// index. The item, source archive, translation files, and Adventure data are
// intentionally kept on disk and remain traceable through legacy indexes.
type MasterAssetArchiveResult struct {
	MasterItemID           string `json:"master_item_id"`
	ArchivedAt             string `json:"archived_at"`
	PreservedInstanceCount int    `json:"preserved_instance_count"`
}

type masterAssetArchiveRecord struct {
	SchemaVersion          int    `json:"schema_version"`
	MasterItemID           string `json:"master_item_id"`
	SourceID               string `json:"source_id"`
	SourceRevision         string `json:"source_revision"`
	ArchivedAt             string `json:"archived_at"`
	PreservedInstanceCount int    `json:"preserved_instance_count"`
}

// ArchiveMasterAsset removes one asset from the active Master index without
// deleting its source, item, translation, transaction, or Adventure files.
// Existing Adventure instances are moved to the legacy index so their data
// remains preserved while the archived asset no longer appears as active.
func (s *MasterLibraryStore) ArchiveMasterAsset(masterItemID string) (MasterAssetArchiveResult, error) {
	masterItemID = strings.TrimSpace(masterItemID)
	if masterItemID == "" {
		return MasterAssetArchiveResult{}, errors.New("总库资产 ID 不能为空")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return MasterAssetArchiveResult{}, err
	}
	var itemRef MasterItemRef
	found := false
	for _, ref := range manifest.Items {
		if ref.MasterItemID == masterItemID && ref.RecordKind != "worldbook_entry" {
			itemRef = ref
			found = true
			break
		}
	}
	if !found {
		return MasterAssetArchiveResult{}, os.ErrNotExist
	}
	if _, err := s.loadItemUnlocked(masterItemID); err != nil {
		return MasterAssetArchiveResult{}, err
	}

	activeItemIDs := make(map[string]bool, len(manifest.Items))
	for _, ref := range manifest.Items {
		if ref.MasterItemID != masterItemID {
			activeItemIDs[ref.MasterItemID] = true
		}
	}
	manifest.Items = moveMasterItemToLegacy(manifest.Items, masterItemID, &manifest.LegacyItems)
	manifest.Translations = moveMasterTranslationsToLegacy(manifest.Translations, masterItemID, &manifest.LegacyTranslations)
	instanceCount := 0
	keptInstances := make([]MasterInstanceRef, 0, len(manifest.Instances))
	for _, instance := range manifest.Instances {
		if instance.MasterItemID == masterItemID {
			manifest.LegacyInstances = append(manifest.LegacyInstances, instance)
			instanceCount++
			continue
		}
		keptInstances = append(keptInstances, instance)
	}
	manifest.Instances = keptInstances
	keptImports := make([]MasterImportRef, 0, len(manifest.Imports))
	for _, ref := range manifest.Imports {
		transaction, loadErr := s.loadImportUnlocked(ref.Path)
		containsAsset := false
		containsOtherActiveAsset := false
		if loadErr == nil {
			for _, itemID := range transaction.ItemIDs {
				if itemID == masterItemID {
					containsAsset = true
					continue
				}
				if activeItemIDs[itemID] {
					containsOtherActiveAsset = true
				}
			}
		}
		if containsAsset && !containsOtherActiveAsset {
			manifest.LegacyImports = append(manifest.LegacyImports, ref)
			continue
		}
		keptImports = append(keptImports, ref)
	}
	manifest.Imports = keptImports

	now := time.Now().UTC().Format(time.RFC3339Nano)
	tombstone := masterAssetArchiveRecord{
		SchemaVersion: masterSchemaVersion, MasterItemID: masterItemID,
		SourceID: itemRef.SourceID, SourceRevision: itemRef.SourceRevision,
		ArchivedAt: now, PreservedInstanceCount: instanceCount,
	}
	tombstonePath := filepath.ToSlash(filepath.Join(".narraverse", "master", "tombstones", masterItemID+".json"))
	if err := s.writeJSONUnlocked(tombstonePath, tombstone); err != nil {
		return MasterAssetArchiveResult{}, err
	}
	if err := s.saveManifestUnlocked(manifest); err != nil {
		return MasterAssetArchiveResult{}, err
	}
	return MasterAssetArchiveResult{MasterItemID: masterItemID, ArchivedAt: now, PreservedInstanceCount: instanceCount}, nil
}

// GetAssetAvatar returns the archived PNG for a character card. The archive
// path is resolved from the Master manifest, never from a client-supplied
// filesystem path, so the endpoint cannot be used as a general file reader.
func (s *MasterLibraryStore) GetAssetAvatar(masterItemID string) ([]byte, error) {
	masterItemID = strings.TrimSpace(masterItemID)
	if masterItemID == "" {
		return nil, errors.New("总库资产 ID 不能为空")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return nil, err
	}
	item, err := s.loadItemUnlocked(masterItemID)
	if err != nil {
		return nil, err
	}
	if item.RecordKind != "character_template" {
		return nil, os.ErrNotExist
	}
	_, revision, found := masterSourceAndRevision(manifest, item.SourceID, item.SourceRevision)
	if !found || !strings.EqualFold(filepath.Ext(revision.OriginalPath), ".png") {
		return nil, os.ErrNotExist
	}
	workspace, err := filepath.Abs(s.workspace)
	if err != nil {
		return nil, err
	}
	absPath, err := filepath.Abs(filepath.Join(workspace, filepath.FromSlash(revision.OriginalPath)))
	if err != nil {
		return nil, err
	}
	if absPath != workspace && !strings.HasPrefix(absPath, workspace+string(filepath.Separator)) {
		return nil, errors.New("头像归档路径不在总库 workspace 范围内")
	}
	data, err := os.ReadFile(absPath)
	if err != nil {
		return nil, err
	}
	return data, nil
}

// UpdateMasterAssetDescription edits the human-facing introduction of a
// lorebook directly in Master. It is metadata editing, not a translation
// proposal, so it remains available even when the source had no description
// field or the previous field was not a translation target.
func (s *MasterLibraryStore) UpdateMasterAssetDescription(masterItemID, description string) (MasterItem, error) {
	masterItemID = strings.TrimSpace(masterItemID)
	description = strings.TrimSpace(description)
	if masterItemID == "" {
		return MasterItem{}, errors.New("总库资产 ID 不能为空")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return MasterItem{}, err
	}
	item, err := s.loadItemUnlocked(masterItemID)
	if err != nil {
		return MasterItem{}, err
	}
	if item.RecordKind != "lorebook_template" {
		return MasterItem{}, errors.New("只有设定书资产可以修改设定书介绍")
	}
	fieldPath, originalKey := "lorebook.description", "description"
	if item.Fields == nil {
		item.Fields = map[string]MasterField{}
	}
	if description == "" {
		delete(item.Fields, fieldPath)
	} else {
		item.Fields[fieldPath] = MasterField{
			SourceText: description, SourceSHA256: masterHashString(description),
			Risk: masterFieldRiskSafe, Required: false, NeedsTranslation: false,
			ActiveText: description, ActiveKind: "human",
		}
	}
	item.Original = cloneMasterMap(item.Original)
	if description == "" {
		delete(item.Original, originalKey)
	} else {
		item.Original[originalKey] = description
	}
	item.ActiveWorkingRevision = masterActiveWorkingRevision(item.Fields)
	if err := s.saveItemUnlocked(&manifest, item); err != nil {
		return MasterItem{}, err
	}
	if err := s.saveManifestUnlocked(manifest); err != nil {
		return MasterItem{}, err
	}
	return item, nil
}

func (s *MasterLibraryStore) LoadSourceRevision(sourceID, revisionID string) (MasterSourceRecord, MasterSourceRevision, []byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return MasterSourceRecord{}, MasterSourceRevision{}, nil, err
	}
	for _, source := range manifest.Sources {
		if source.SourceID != sourceID {
			continue
		}
		for _, revision := range source.Revisions {
			if revision.Revision != revisionID {
				continue
			}
			data, readErr := os.ReadFile(filepath.Join(s.workspace, filepath.FromSlash(revision.OriginalPath)))
			return source, revision, data, readErr
		}
		return source, MasterSourceRevision{}, nil, os.ErrNotExist
	}
	return MasterSourceRecord{}, MasterSourceRevision{}, nil, os.ErrNotExist
}

func (s *MasterLibraryStore) MarkImportInstantiated(importID string, targetLoreIDs []string, instances []MasterInstanceRef) (MasterImportTransaction, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return MasterImportTransaction{}, err
	}
	ref, ok := masterImportByID(manifest, importID)
	if !ok {
		return MasterImportTransaction{}, os.ErrNotExist
	}
	transaction, err := s.loadImportUnlocked(ref.Path)
	if err != nil {
		return MasterImportTransaction{}, err
	}
	transaction.Status = "instantiated"
	transaction.TargetLoreIDs = append([]string{}, targetLoreIDs...)
	transaction.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.writeJSONUnlocked(ref.Path, transaction); err != nil {
		return MasterImportTransaction{}, err
	}
	for index := range manifest.Imports {
		if manifest.Imports[index].ImportID == importID {
			manifest.Imports[index].Status = transaction.Status
		}
	}
	for _, instance := range instances {
		found := false
		for index := range manifest.Instances {
			if manifest.Instances[index].InstanceID == instance.InstanceID {
				manifest.Instances[index] = instance
				found = true
				break
			}
		}
		if !found {
			manifest.Instances = append(manifest.Instances, instance)
		}
	}
	if err := s.saveManifestUnlocked(manifest); err != nil {
		return MasterImportTransaction{}, err
	}
	return transaction, nil
}

// PrepareAssetInstantiation creates an existing Master asset's per-Adventure
// transaction. FinalizeMasterImport remains the single projection path.
func (s *MasterLibraryStore) PrepareAssetInstantiation(masterItemID, adventureWorkspace string) (string, error) {
	adventureWorkspace = strings.TrimSpace(adventureWorkspace)
	if adventureWorkspace == "" {
		return "", errors.New("当前冒险不存在")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return "", err
	}
	item, err := s.loadItemUnlocked(strings.TrimSpace(masterItemID))
	if err != nil {
		return "", err
	}
	source, revision, found := masterSourceAndRevision(manifest, item.SourceID, item.SourceRevision)
	if !found {
		return "", errors.New("总库资产来源或版本不存在")
	}
	pipeline := deriveMasterPipeline(s.workspace, item, source, revision, found, manifest)
	if pipeline.Availability != MasterAvailabilityUsable {
		return "", errors.New("总库资产尚未达到可用状态")
	}
	adventureKey := masterHashString(filepath.Clean(adventureWorkspace))
	for _, usage := range manifest.Instances {
		if usage.MasterItemID == item.MasterItemID && usage.AdventureKey == adventureKey {
			return usage.ImportID, nil
		}
	}
	idempotencyKey := masterHashString("asset-instance\x00" + adventureKey + "\x00" + item.MasterItemID + "\x00" + item.ActiveWorkingRevision)
	importID := uuid.NewSHA1(masterImportNamespace, []byte(idempotencyKey)).String()
	if existing, ok := masterImportByID(manifest, importID); ok {
		return existing.ImportID, nil
	}
	instanceID := uuid.NewSHA1(masterInstanceNamespace, []byte(importID+"\x00"+item.MasterItemID)).String()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	transaction := MasterImportTransaction{
		SchemaVersion: masterSchemaVersion, ImportID: importID, IdempotencyKey: idempotencyKey,
		AdventureWorkspace: adventureWorkspace, AdventureKey: adventureKey,
		SourceID: item.SourceID, SourceRevision: item.SourceRevision,
		ItemIDs: []string{item.MasterItemID}, InstanceIDs: map[string]string{item.MasterItemID: instanceID},
		TargetLoreIDs: []string{}, TranslationTargets: []MasterTranslationTarget{}, Status: "ready",
		CreatedAt: now, UpdatedAt: now,
	}
	transactionPath := masterImportRelPath(importID)
	if err := s.writeJSONUnlocked(transactionPath, transaction); err != nil {
		return "", err
	}
	manifest.Imports = append(manifest.Imports, MasterImportRef{ImportID: importID, IdempotencyKey: idempotencyKey, Path: transactionPath, Status: transaction.Status})
	if err := s.saveManifestUnlocked(manifest); err != nil {
		return "", err
	}
	return importID, nil
}

func (s *MasterLibraryStore) initializeUnlocked() error {
	if err := os.MkdirAll(s.workspace, 0o755); err != nil {
		return err
	}
	files := map[string][]byte{
		"CREATOR.md": []byte("# 叙界总资料库\n\n本工程由 Narraverse Master-first 导入流水线维护。\n"),
		"book.json":  []byte("{\n  \"title\": \"叙界总资料库\",\n  \"author\": \"Narraverse\",\n  \"description\": \"跨冒险复用的原始设定卡、清洗规范条目与字段级翻译版本；不保存冒险运行状态。\"\n}\n"),
		filepath.ToSlash(filepath.Join("setting", "world.md")):           []byte("# 叙界总资料库\n\n保存跨冒险复用的角色模板与世界知识；不保存冒险运行状态。\n"),
		filepath.ToSlash(filepath.Join(".denova", "lore", "items.json")): []byte("{\n  \"version\": 2,\n  \"items\": []\n}\n"),
	}
	for rel, data := range files {
		path := filepath.Join(s.workspace, filepath.FromSlash(rel))
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			if err := atomicWriteMaterial(path, data); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
	}
	return nil
}

func (s *MasterLibraryStore) loadManifestUnlocked() (MasterLibraryManifest, error) {
	manifest := MasterLibraryManifest{
		SchemaVersion: masterSchemaVersion, DataVersion: 0,
		Sources: []MasterSourceRecord{}, Items: []MasterItemRef{}, Translations: []MasterTranslationRef{},
		Imports: []MasterImportRef{}, Instances: []MasterInstanceRef{},
	}
	data, err := os.ReadFile(filepath.Join(s.workspace, filepath.FromSlash(masterManifestPath)))
	if errors.Is(err, os.ErrNotExist) {
		return manifest, nil
	}
	if err != nil {
		return manifest, err
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return manifest, fmt.Errorf("总资料库 manifest 损坏: %w", err)
	}
	if manifest.SchemaVersion != masterSchemaVersion {
		return manifest, fmt.Errorf("不支持的总资料库 schema_version: %d", manifest.SchemaVersion)
	}
	if manifest.Sources == nil {
		manifest.Sources = []MasterSourceRecord{}
	}
	if manifest.Items == nil {
		manifest.Items = []MasterItemRef{}
	}
	if manifest.Translations == nil {
		manifest.Translations = []MasterTranslationRef{}
	}
	if manifest.Imports == nil {
		manifest.Imports = []MasterImportRef{}
	}
	if manifest.Instances == nil {
		manifest.Instances = []MasterInstanceRef{}
	}
	if manifest.LegacyItems == nil {
		manifest.LegacyItems = []MasterItemRef{}
	}
	if manifest.LegacyTranslations == nil {
		manifest.LegacyTranslations = []MasterTranslationRef{}
	}
	if manifest.LegacyImports == nil {
		manifest.LegacyImports = []MasterImportRef{}
	}
	if manifest.LegacyInstances == nil {
		manifest.LegacyInstances = []MasterInstanceRef{}
	}
	return manifest, nil
}

func (s *MasterLibraryStore) saveManifestUnlocked(manifest MasterLibraryManifest) error {
	manifest.SchemaVersion = masterSchemaVersion
	manifest.DataVersion++
	manifest.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	manifest.Revision = ""
	manifest.Revision = masterObjectRevision(manifest)
	return s.writeJSONUnlocked(masterManifestPath, manifest)
}

func (s *MasterLibraryStore) upsertSourceUnlocked(manifest *MasterLibraryManifest, input MasterIngestInput) (MasterSourceRecord, MasterSourceRevision, error) {
	digest := masterHashBytes(input.Data)
	revisionID := "sha256:" + digest
	sourceKind := firstNonEmptyLoreValue(strings.TrimSpace(input.SourceKind), "user_upload")
	originKey := ""
	if anchor := strings.TrimSpace(input.SourceAnchor); anchor != "" {
		originKey = strings.ToLower(sourceKind) + "\x00" + anchor
	}
	sourceIndex := -1
	if originKey != "" {
		for index, source := range manifest.Sources {
			if source.OriginKey == originKey || containsMasterString(source.OriginAliases, originKey) {
				sourceIndex = index
				break
			}
		}
	}
	if sourceIndex < 0 {
		for index, source := range manifest.Sources {
			for _, revision := range source.Revisions {
				if revision.SHA256 == digest {
					sourceIndex = index
					if originKey != "" && source.OriginKey != originKey {
						manifest.Sources[index].OriginAliases = appendMasterUnique(source.OriginAliases, originKey)
					}
					break
				}
			}
			if sourceIndex >= 0 {
				break
			}
		}
	}
	if sourceIndex < 0 {
		sourceID := uuid.New().String()
		if originKey != "" {
			sourceID = uuid.NewSHA1(masterSourceNamespace, []byte(originKey)).String()
		}
		manifest.Sources = append(manifest.Sources, MasterSourceRecord{
			SourceID: sourceID, OriginKey: originKey, OriginAliases: []string{}, SourceKind: sourceKind,
			Filename: filepath.Base(input.Filename), Revisions: []MasterSourceRevision{},
		})
		sourceIndex = len(manifest.Sources) - 1
	}
	source := &manifest.Sources[sourceIndex]
	for _, revision := range source.Revisions {
		if revision.SHA256 == digest {
			source.CurrentRevision = revision.Revision
			return *source, revision, nil
		}
	}
	archiveRel := filepath.ToSlash(filepath.Join(".narraverse", "source", "originals", source.SourceID, digest, safeMaterialFilename(input.Filename)))
	archiveAbs := filepath.Join(s.workspace, filepath.FromSlash(archiveRel))
	if err := atomicWriteMaterial(archiveAbs, input.Data); err != nil {
		return MasterSourceRecord{}, MasterSourceRevision{}, err
	}
	revision := MasterSourceRevision{
		Revision: revisionID, SHA256: digest, Bytes: len(input.Data), OriginalPath: archiveRel,
		ImportedAt: time.Now().UTC().Format(time.RFC3339Nano), ParentRevision: source.CurrentRevision,
	}
	source.CurrentRevision = revisionID
	source.Filename = filepath.Base(input.Filename)
	source.SourceKind = sourceKind
	source.Revisions = append(source.Revisions, revision)
	return *source, revision, nil
}

func (s *MasterLibraryStore) buildItemUnlocked(source MasterSourceRecord, sourceRevision MasterSourceRevision, importID string, input MasterItemInput) (MasterItem, []MasterTranslationTarget, error) {
	entryIdentity := strings.TrimSpace(input.SourceEntryIdentity)
	recordKind := strings.TrimSpace(input.RecordKind)
	if entryIdentity == "" || recordKind == "" {
		return MasterItem{}, nil, errors.New("总库条目缺少稳定来源身份或 record_kind")
	}
	itemID := uuid.NewSHA1(masterItemNamespace, []byte(source.SourceID+"\x00"+entryIdentity+"\x00"+recordKind)).String()
	fields := map[string]MasterField{}
	targets := []MasterTranslationTarget{}
	for path, raw := range input.Fields {
		path = strings.TrimSpace(path)
		text := strings.TrimSpace(raw.Text)
		if path == "" || text == "" {
			continue
		}
		risk := raw.Risk
		if risk != masterFieldRiskHigh {
			risk = masterFieldRiskSafe
		}
		needsTranslation := masterTextNeedsTranslation(text)
		field := MasterField{SourceText: text, SourceSHA256: masterHashString(text), Risk: risk, Required: raw.Required, NeedsTranslation: needsTranslation}
		if !needsTranslation || risk == masterFieldRiskHigh {
			field.ActiveText, field.ActiveKind = text, "source"
		}
		fields[path] = field
		if needsTranslation {
			policy := "master_auto"
			status := "queued"
			if risk == masterFieldRiskHigh {
				policy = "master_review"
				status = "queued"
			}
			mode := "faithful_zh"
			if strings.HasSuffix(path, ".name") || path == "character.name" {
				mode = "name_zh"
			}
			targets = append(targets, MasterTranslationTarget{
				ImportID: importID, SourceID: source.SourceID, SourceRevision: sourceRevision.Revision,
				MasterItemID: itemID, ItemName: firstNonEmptyLoreValue(input.Name, entryIdentity), FieldPath: path,
				SourceText: text, SourceSHA256: field.SourceSHA256, Mode: mode, ApplyPolicy: policy,
				Required: raw.Required && risk != masterFieldRiskHigh, Status: status,
			})
		}
	}
	item := MasterItem{
		SchemaVersion: masterSchemaVersion, DataVersion: 1, MasterItemID: itemID,
		SourceID: source.SourceID, SourceRevision: sourceRevision.Revision, SourceEntryIdentity: entryIdentity,
		RecordKind: recordKind, SemanticType: strings.TrimSpace(input.SemanticType),
		Original: nonNilMasterMap(input.Original), SourceSemantics: nonNilMasterMap(input.SourceSemantics),
		RuntimeSemantics: nonNilMasterMap(input.RuntimeSemantics), Fields: fields,
		NestedEntries: cloneMasterNestedEntries(input.NestedEntries),
		UpdatedAt:     time.Now().UTC().Format(time.RFC3339Nano),
	}
	item.ActiveWorkingRevision = masterActiveWorkingRevision(item.Fields)
	item.Revision = masterItemRevision(item)
	return item, targets, nil
}

func (s *MasterLibraryStore) saveItemUnlocked(manifest *MasterLibraryManifest, item MasterItem) error {
	path := masterItemRelPath(item.MasterItemID)
	if previous, err := s.loadItemUnlocked(item.MasterItemID); err == nil {
		if previous.Revision == item.Revision {
			item.DataVersion = previous.DataVersion
			item.UpdatedAt = previous.UpdatedAt
		} else {
			item.DataVersion = previous.DataVersion + 1
			historyRevision := strings.TrimPrefix(previous.Revision, "sha256:")
			historyPath := filepath.ToSlash(filepath.Join(".narraverse", "master", "history", previous.MasterItemID, historyRevision+".json"))
			if _, statErr := os.Stat(filepath.Join(s.workspace, filepath.FromSlash(historyPath))); errors.Is(statErr, os.ErrNotExist) {
				if err := s.writeJSONUnlocked(historyPath, previous); err != nil {
					return err
				}
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	item.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	item.Revision = masterItemRevision(item)
	if err := s.writeJSONUnlocked(path, item); err != nil {
		return err
	}
	ref := MasterItemRef{MasterItemID: item.MasterItemID, SourceID: item.SourceID, SourceRevision: item.SourceRevision, SourceEntryIdentity: item.SourceEntryIdentity, RecordKind: item.RecordKind, Path: path, Revision: item.Revision}
	for index := range manifest.Items {
		if manifest.Items[index].MasterItemID == item.MasterItemID {
			manifest.Items[index] = ref
			return nil
		}
	}
	manifest.Items = append(manifest.Items, ref)
	return nil
}

func (s *MasterLibraryStore) loadItemUnlocked(itemID string) (MasterItem, error) {
	var item MasterItem
	data, err := os.ReadFile(filepath.Join(s.workspace, filepath.FromSlash(masterItemRelPath(itemID))))
	if err != nil {
		return item, err
	}
	if err := json.Unmarshal(data, &item); err != nil {
		return item, fmt.Errorf("总库条目损坏: %w", err)
	}
	return item, nil
}

func (s *MasterLibraryStore) loadItemsUnlocked(itemIDs []string) ([]MasterItem, error) {
	items := make([]MasterItem, 0, len(itemIDs))
	for _, itemID := range itemIDs {
		item, err := s.loadItemUnlocked(itemID)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func (s *MasterLibraryStore) loadImportUnlocked(rel string) (MasterImportTransaction, error) {
	var transaction MasterImportTransaction
	data, err := os.ReadFile(filepath.Join(s.workspace, filepath.FromSlash(rel)))
	if err != nil {
		return transaction, err
	}
	if err := json.Unmarshal(data, &transaction); err != nil {
		return transaction, fmt.Errorf("总库导入事务损坏: %w", err)
	}
	return transaction, nil
}

func (s *MasterLibraryStore) writeJSONUnlocked(rel string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteMaterial(filepath.Join(s.workspace, filepath.FromSlash(rel)), append(data, '\n'))
}

func masterImportByID(manifest MasterLibraryManifest, importID string) (MasterImportRef, bool) {
	for _, ref := range manifest.Imports {
		if ref.ImportID == importID {
			return ref, true
		}
	}
	return MasterImportRef{}, false
}

func masterTransactionReady(transaction MasterImportTransaction) bool {
	for _, target := range transaction.TranslationTargets {
		if target.Required && target.Status != "active" {
			return false
		}
	}
	return true
}

func masterItemIDs(items []MasterItem) []string {
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.MasterItemID)
	}
	return ids
}

func masterItemRelPath(itemID string) string {
	return filepath.ToSlash(filepath.Join(".narraverse", "master", "items", itemID+".json"))
}

func masterImportRelPath(importID string) string {
	return filepath.ToSlash(filepath.Join(".narraverse", "transactions", importID+".json"))
}

var (
	masterTranslationProbePattern = regexp.MustCompile("https?://[^\\s]+|\\{\\{[^{}\\r\\n]+\\}\\}|__NV_[A-Z_]+_[0-9]{4}__|<[^>]+>|`[^`\\r\\n]+`")
	masterTranslationWordPattern  = regexp.MustCompile(`[A-Za-z][A-Za-z'-]*`)
	masterTranslationLabelPattern = regexp.MustCompile(`(?m)^\s*[A-Za-z][A-Za-z \t/&-]{1,32}\s*[:：]`)
)

func masterTextNeedsTranslation(text string) bool {
	probe := masterTranslationProbePattern.ReplaceAllString(text, " ")
	words := masterTranslationWordPattern.FindAllString(probe, -1)
	if len(words) == 0 {
		return false
	}
	meaningful := 0
	for _, word := range words {
		// Short all-cap tokens are usually product names, variables, or game
		// acronyms. They are preserved instead of creating a useless job.
		if strings.ToUpper(word) == word && len([]rune(word)) <= 8 {
			continue
		}
		meaningful++
	}
	if masterTranslationLabelPattern.MatchString(probe) {
		return true
	}
	// A single ordinary English label (for example "Harbor" or "dock") is
	// still a real translation target. Only machine-like tokens are filtered
	// above; short human-facing fields must not disappear.
	if meaningful > 0 {
		return true
	}
	return false
}

func masterHashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func masterHashString(value string) string { return masterHashBytes([]byte(value)) }

func masterObjectRevision(value any) string {
	data, _ := json.Marshal(value)
	return "sha256:" + masterHashBytes(data)
}

func masterItemRevision(item MasterItem) string {
	payload := struct {
		MasterItemID, SourceID, SourceRevision, SourceEntryIdentity, RecordKind, SemanticType string
		Original, SourceSemantics, RuntimeSemantics                                           map[string]any
		Fields                                                                                map[string]MasterField
		NestedEntries                                                                         []MasterNestedEntry
	}{item.MasterItemID, item.SourceID, item.SourceRevision, item.SourceEntryIdentity, item.RecordKind, item.SemanticType, item.Original, item.SourceSemantics, item.RuntimeSemantics, item.Fields, item.NestedEntries}
	return masterObjectRevision(payload)
}

func cloneMasterNestedEntries(entries []MasterNestedEntry) []MasterNestedEntry {
	if len(entries) == 0 {
		return []MasterNestedEntry{}
	}
	result := make([]MasterNestedEntry, len(entries))
	for index, entry := range entries {
		result[index] = MasterNestedEntry{
			EntryID: entry.EntryID, SourceEntryIdentity: entry.SourceEntryIdentity,
			Original: cloneMasterMap(entry.Original), SourceSemantics: cloneMasterMap(entry.SourceSemantics),
			RuntimeSemantics: cloneMasterMap(entry.RuntimeSemantics),
		}
	}
	return result
}

func masterActiveWorkingRevision(fields map[string]MasterField) string {
	active := map[string]any{}
	for path, field := range fields {
		active[path] = []any{field.ActiveText, field.ActiveKind, field.ActiveTranslationVersionID}
	}
	return masterObjectRevision(active)
}

func nonNilMasterMap(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	return value
}

func containsMasterString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func appendMasterUnique(values []string, additions ...string) []string {
	for _, addition := range additions {
		if addition != "" && !containsMasterString(values, addition) {
			values = append(values, addition)
		}
	}
	return values
}

func masterSourceEntryIdentity(raw map[string]any) string {
	for _, key := range []string{"id", "uid"} {
		if value, found := raw[key]; found {
			encoded, _ := json.Marshal(value)
			return key + ":" + strings.Trim(string(encoded), "\"")
		}
	}
	identity := map[string]any{}
	for _, key := range []string{"comment", "name", "keys", "key", "secondary_keys", "keysecondary", "group"} {
		if value, found := raw[key]; found {
			identity[key] = value
		}
	}
	if len(identity) == 0 {
		data, _ := json.Marshal(raw)
		return "fingerprint:" + masterHashBytes(data)[:24]
	}
	data, _ := json.Marshal(identity)
	return "fingerprint:" + masterHashBytes(data)[:24]
}

func cloneMasterMap(raw map[string]any) map[string]any {
	if raw == nil {
		return map[string]any{}
	}
	data, _ := json.Marshal(raw)
	var clone map[string]any
	_ = json.Unmarshal(data, &clone)
	return nonNilMasterMap(clone)
}

func masterRuntimeLoreID(instanceID, suffix string) string {
	id := uuid.NewSHA1(masterInstanceNamespace, []byte(instanceID+"\x00"+suffix)).String()
	return "instance-" + strings.ReplaceAll(id, "-", "")
}
