package book

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

const masterLegacyMappingPath = ".narraverse/master/legacy-mapping.json"

// MasterLegacyMapping keeps the old entry-level Master identities traceable
// after they leave the active asset index. The old item and translation files
// are intentionally not deleted.
type MasterLegacyMapping struct {
	SchemaVersion int                        `json:"schema_version"`
	MigratedAt    string                     `json:"migrated_at"`
	Entries       []MasterLegacyMappingEntry `json:"entries"`
}

type MasterLegacyMappingEntry struct {
	OldMasterItemID          string   `json:"old_master_item_id"`
	ParentMasterItemID       string   `json:"parent_master_item_id"`
	NestedEntryID            string   `json:"nested_entry_id"`
	OldTranslationVersionIDs []string `json:"old_translation_version_ids,omitempty"`
	OldInstanceIDs           []string `json:"old_instance_ids,omitempty"`
	MigrationStatus          string   `json:"migration_status"`
}

type MasterLegacyMigrationResult struct {
	Sources              int    `json:"sources"`
	ParentAssets         int    `json:"parent_assets"`
	ArchivedItems        int    `json:"archived_items"`
	MigratedTranslations int    `json:"migrated_translations"`
	PreservedInstances   int    `json:"preserved_instances"`
	MappingPath          string `json:"mapping_path"`
}

// MigrateLegacyWorldbookEntries folds active legacy worldbook_entry items into
// one parent asset per original source. It is deliberately a one-shot archive
// operation: existing Adventure lore and old files remain untouched.
func (s *MasterLibraryStore) MigrateLegacyWorldbookEntries() (MasterLegacyMigrationResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.initializeUnlocked(); err != nil {
		return MasterLegacyMigrationResult{}, err
	}
	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return MasterLegacyMigrationResult{}, err
	}
	legacyRefs := make([]MasterItemRef, 0)
	bySource := map[string][]MasterItemRef{}
	for _, ref := range manifest.Items {
		if ref.RecordKind != "worldbook_entry" {
			continue
		}
		legacyRefs = append(legacyRefs, ref)
		bySource[ref.SourceID] = append(bySource[ref.SourceID], ref)
	}
	if len(legacyRefs) == 0 {
		return MasterLegacyMigrationResult{MappingPath: masterLegacyMappingPath}, nil
	}

	mapping := MasterLegacyMapping{SchemaVersion: masterSchemaVersion, MigratedAt: time.Now().UTC().Format(time.RFC3339Nano), Entries: []MasterLegacyMappingEntry{}}
	if previous, readErr := s.readLegacyMappingUnlocked(); readErr == nil {
		mapping.Entries = append(mapping.Entries, previous.Entries...)
	}
	oldIDs := map[string]bool{}
	for _, ref := range legacyRefs {
		oldIDs[ref.MasterItemID] = true
	}
	result := MasterLegacyMigrationResult{ArchivedItems: len(legacyRefs), MappingPath: masterLegacyMappingPath}
	for sourceID, refs := range bySource {
		source, revision, data, loadErr := s.loadLegacySourceUnlocked(manifest, sourceID, refs[0].SourceRevision)
		if loadErr != nil {
			return MasterLegacyMigrationResult{}, loadErr
		}
		preview, previewErr := PreviewMaterial(source.Filename, data)
		if previewErr != nil {
			return MasterLegacyMigrationResult{}, fmt.Errorf("迁移来源 %s 预览失败: %w", sourceID, previewErr)
		}
		inputs, inputErr := buildMasterItemInputs(source.Filename, data, preview, MaterialImportOptions{})
		if inputErr != nil || len(inputs) != 1 {
			if inputErr == nil {
				inputErr = errors.New("未生成唯一父资产")
			}
			return MasterLegacyMigrationResult{}, fmt.Errorf("迁移来源 %s 构建父资产失败: %w", sourceID, inputErr)
		}
		migrationID := uuid.NewSHA1(masterImportNamespace, []byte("legacy-migration\x00"+sourceID+"\x00"+revision.Revision)).String()
		item, targets, buildErr := s.buildItemUnlocked(source, revision, migrationID, inputs[0])
		if buildErr != nil {
			return MasterLegacyMigrationResult{}, buildErr
		}
		result.Sources++
		result.ParentAssets++

		parent, parentErr := s.findActiveParentUnlocked(manifest, sourceID, item.RecordKind)
		if parentErr == nil {
			mergeCompatibleMasterFields(&item, parent)
		}
		nestedByIdentity := map[string]MasterNestedEntry{}
		for _, nested := range item.NestedEntries {
			nestedByIdentity[nested.SourceEntryIdentity] = nested
		}
		for _, oldRef := range refs {
			oldItem, loadItemErr := s.loadItemUnlocked(oldRef.MasterItemID)
			if loadItemErr != nil {
				return MasterLegacyMigrationResult{}, loadItemErr
			}
			nested, matched := nestedByIdentity[oldItem.SourceEntryIdentity]
			mappingEntry := MasterLegacyMappingEntry{OldMasterItemID: oldRef.MasterItemID, ParentMasterItemID: item.MasterItemID, MigrationStatus: "archived"}
			if matched {
				mappingEntry.NestedEntryID = nested.EntryID
				copied, copyErr := s.copyLegacyTranslationsUnlocked(&item, oldItem, nested.EntryID, manifest, &mappingEntry)
				if copyErr != nil {
					return MasterLegacyMigrationResult{}, copyErr
				}
				result.MigratedTranslations += copied
			}
			for _, usage := range manifest.Instances {
				if usage.MasterItemID == oldRef.MasterItemID {
					mappingEntry.OldInstanceIDs = append(mappingEntry.OldInstanceIDs, usage.InstanceID)
					result.PreservedInstances++
				}
			}
			for _, translation := range manifest.Translations {
				if translation.MasterItemID == oldRef.MasterItemID {
					mappingEntry.OldTranslationVersionIDs = append(mappingEntry.OldTranslationVersionIDs, translation.TranslationVersionID)
				}
			}
			mapping.Entries = append(mapping.Entries, mappingEntry)
			_ = s.writeJSONUnlocked(filepath.ToSlash(filepath.Join(".narraverse", "master", "tombstones", oldRef.MasterItemID+".json")), mappingEntry)
		}

		for index := range targets {
			field := item.Fields[targets[index].FieldPath]
			if field.ActiveTranslationVersionID != "" && strings.TrimSpace(field.ActiveText) != "" {
				targets[index].Status = "active"
			}
		}
		item.ActiveWorkingRevision = masterActiveWorkingRevision(item.Fields)
		if err := s.saveItemUnlocked(&manifest, item); err != nil {
			return MasterLegacyMigrationResult{}, err
		}
		transaction := MasterImportTransaction{
			SchemaVersion: masterSchemaVersion, ImportID: migrationID,
			IdempotencyKey:     "legacy-migration\x00" + sourceID + "\x00" + revision.Revision,
			AdventureWorkspace: s.workspace, AdventureKey: masterHashString(filepath.Clean(s.workspace)),
			SourceID: sourceID, SourceRevision: revision.Revision, ItemIDs: []string{item.MasterItemID},
			InstanceIDs: map[string]string{}, TargetLoreIDs: []string{}, TranslationTargets: targets,
			Status: "ready", CreatedAt: mapping.MigratedAt, UpdatedAt: mapping.MigratedAt,
		}
		for _, target := range targets {
			if target.Required && target.Status != "active" {
				transaction.Status = "pending_translation"
				break
			}
		}
		if existing, exists := masterImportByID(manifest, migrationID); !exists {
			path := masterImportRelPath(migrationID)
			if err := s.writeJSONUnlocked(path, transaction); err != nil {
				return MasterLegacyMigrationResult{}, err
			}
			manifest.Imports = append(manifest.Imports, MasterImportRef{ImportID: migrationID, IdempotencyKey: transaction.IdempotencyKey, Path: path, Status: transaction.Status})
		} else if existing.Status != transaction.Status {
			for index := range manifest.Imports {
				if manifest.Imports[index].ImportID == migrationID {
					manifest.Imports[index].Status = transaction.Status
				}
			}
		}
	}

	manifest.Items = filterMasterItemRefs(manifest.Items, oldIDs, &manifest.LegacyItems)
	manifest.Translations = moveLegacyTranslations(manifest.Translations, oldIDs, &manifest.LegacyTranslations)
	manifest.Instances = moveLegacyInstances(manifest.Instances, oldIDs, &manifest.LegacyInstances)
	manifest.Imports = moveLegacyImports(manifest.Imports, oldIDs, s, &manifest.LegacyImports)
	if err := s.writeJSONUnlocked(masterLegacyMappingPath, mapping); err != nil {
		return MasterLegacyMigrationResult{}, err
	}
	if err := s.saveManifestUnlocked(manifest); err != nil {
		return MasterLegacyMigrationResult{}, err
	}
	return result, nil
}

func (s *MasterLibraryStore) readLegacyMappingUnlocked() (MasterLegacyMapping, error) {
	var mapping MasterLegacyMapping
	data, err := os.ReadFile(filepath.Join(s.workspace, filepath.FromSlash(masterLegacyMappingPath)))
	if err != nil {
		return mapping, err
	}
	err = json.Unmarshal(data, &mapping)
	return mapping, err
}

func (s *MasterLibraryStore) loadLegacySourceUnlocked(manifest MasterLibraryManifest, sourceID, revisionID string) (MasterSourceRecord, MasterSourceRevision, []byte, error) {
	source, revision, found := masterSourceAndRevision(manifest, sourceID, revisionID)
	if !found {
		return MasterSourceRecord{}, MasterSourceRevision{}, nil, os.ErrNotExist
	}
	data, err := os.ReadFile(filepath.Join(s.workspace, filepath.FromSlash(revision.OriginalPath)))
	return source, revision, data, err
}

func (s *MasterLibraryStore) findActiveParentUnlocked(manifest MasterLibraryManifest, sourceID, recordKind string) (MasterItem, error) {
	for _, ref := range manifest.Items {
		if ref.SourceID == sourceID && ref.RecordKind == recordKind {
			return s.loadItemUnlocked(ref.MasterItemID)
		}
	}
	return MasterItem{}, os.ErrNotExist
}

func mergeCompatibleMasterFields(target *MasterItem, previous MasterItem) {
	for path, oldField := range previous.Fields {
		field, ok := target.Fields[path]
		if !ok || field.SourceSHA256 != oldField.SourceSHA256 || oldField.ActiveTranslationVersionID == "" || strings.TrimSpace(oldField.ActiveText) == "" {
			continue
		}
		field.ActiveText, field.ActiveKind, field.ActiveTranslationVersionID = oldField.ActiveText, oldField.ActiveKind, oldField.ActiveTranslationVersionID
		target.Fields[path] = field
	}
}

func (s *MasterLibraryStore) copyLegacyTranslationsUnlocked(target *MasterItem, old MasterItem, nestedID string, manifest MasterLibraryManifest, mapping *MasterLegacyMappingEntry) (int, error) {
	count := 0
	for oldPath, oldField := range old.Fields {
		if oldField.ActiveTranslationVersionID == "" || strings.TrimSpace(oldField.ActiveText) == "" {
			continue
		}
		fieldName := ""
		switch oldPath {
		case "lore_entry.name":
			fieldName = "comment"
		case "lore_entry.content":
			fieldName = "content"
		case "lore_entry.keys":
			fieldName = "keys"
		}
		if fieldName == "" {
			continue
		}
		newPath := "lorebook.entries/" + nestedID + "/" + fieldName
		field, ok := target.Fields[newPath]
		if !ok {
			continue
		}
		versionID := uuid.NewSHA1(masterTranslationNamespace, []byte(target.MasterItemID+"\x00"+newPath+"\x00"+oldField.ActiveText+"\x00"+oldField.ActiveTranslationVersionID)).String()
		version := MasterTranslationVersion{
			SchemaVersion: masterSchemaVersion, TranslationVersionID: versionID, MasterItemID: target.MasterItemID,
			FieldPath: newPath, SourceRevision: target.SourceRevision, SourceSHA256: field.SourceSHA256,
			SourceText: field.SourceText, Translation: oldField.ActiveText, TranslationSHA256: masterHashString(oldField.ActiveText),
			Model: "migration", Confirmed: true, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
			MigratedFrom: oldField.ActiveTranslationVersionID,
		}
		version.Revision = masterObjectRevision(version)
		path := filepath.ToSlash(filepath.Join(".narraverse", "translations", versionID+".json"))
		if _, err := os.Stat(filepath.Join(s.workspace, filepath.FromSlash(path))); errors.Is(err, os.ErrNotExist) {
			if err := s.writeJSONUnlocked(path, version); err != nil {
				return count, err
			}
			manifest.Translations = append(manifest.Translations, MasterTranslationRef{TranslationVersionID: versionID, MasterItemID: target.MasterItemID, FieldPath: newPath, Path: path, Revision: version.Revision})
		}
		field.ActiveText, field.ActiveKind, field.ActiveTranslationVersionID = oldField.ActiveText, "translation", versionID
		target.Fields[newPath] = field
		mapping.OldTranslationVersionIDs = append(mapping.OldTranslationVersionIDs, oldField.ActiveTranslationVersionID)
		count++
	}
	return count, nil
}

func filterMasterItemRefs(refs []MasterItemRef, oldIDs map[string]bool, legacy *[]MasterItemRef) []MasterItemRef {
	active := make([]MasterItemRef, 0, len(refs))
	for _, ref := range refs {
		if oldIDs[ref.MasterItemID] {
			*legacy = append(*legacy, ref)
			continue
		}
		active = append(active, ref)
	}
	return active
}

func moveLegacyTranslations(refs []MasterTranslationRef, oldIDs map[string]bool, legacy *[]MasterTranslationRef) []MasterTranslationRef {
	active := make([]MasterTranslationRef, 0, len(refs))
	for _, ref := range refs {
		if oldIDs[ref.MasterItemID] {
			*legacy = append(*legacy, ref)
			continue
		}
		active = append(active, ref)
	}
	return active
}

func moveLegacyInstances(refs []MasterInstanceRef, oldIDs map[string]bool, legacy *[]MasterInstanceRef) []MasterInstanceRef {
	active := make([]MasterInstanceRef, 0, len(refs))
	for _, ref := range refs {
		if oldIDs[ref.MasterItemID] {
			*legacy = append(*legacy, ref)
			continue
		}
		active = append(active, ref)
	}
	return active
}

func moveLegacyImports(refs []MasterImportRef, oldIDs map[string]bool, store *MasterLibraryStore, legacy *[]MasterImportRef) []MasterImportRef {
	active := make([]MasterImportRef, 0, len(refs))
	for _, ref := range refs {
		transaction, err := store.loadImportUnlocked(ref.Path)
		containsOld := false
		if err == nil {
			for _, itemID := range transaction.ItemIDs {
				if oldIDs[itemID] {
					containsOld = true
					break
				}
			}
		}
		if containsOld {
			*legacy = append(*legacy, ref)
			continue
		}
		active = append(active, ref)
	}
	return active
}
