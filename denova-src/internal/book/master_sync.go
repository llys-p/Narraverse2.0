package book

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// MasterReprojectResult reports the outcome of syncing one Master asset's
// active working revision into its current-Adventure instance.
type MasterReprojectResult struct {
	MasterItemID     string   `json:"master_item_id"`
	UpdatedLoreIDs   []string `json:"updated_lore_ids"`
	PreviousRevision string   `json:"previous_revision,omitempty"`
	LoadedRevision   string   `json:"loaded_revision,omitempty"`
	Skipped          bool     `json:"skipped"`
	Message          string   `json:"message,omitempty"`
}

// MasterAdventureUsage describes whether the current Adventure uses one
// Master asset and whether a newer active working revision is available.
// The API handler only reads masterItemID and returns this projection; all
// workspace/adventure-key computation stays inside the service.
type MasterAdventureUsage struct {
	Used            bool   `json:"used"`
	HasNewVersion   bool   `json:"has_new_version"`
	LoadedRevision  string `json:"loaded_revision,omitempty"`
	CurrentRevision string `json:"current_revision,omitempty"`
}

// MasterAssetAdventureUsage answers the read-only "can I sync this asset"
// question for the current Adventure. An unused asset is not an error.
func (s *Service) MasterAssetAdventureUsage(masterItemID string) (MasterAdventureUsage, error) {
	master := NewMasterLibraryStore(s.workspace)
	item, err := master.LoadItem(strings.TrimSpace(masterItemID))
	if err != nil {
		return MasterAdventureUsage{}, err
	}
	usage := MasterAdventureUsage{CurrentRevision: item.ActiveWorkingRevision}
	adventureKey := masterHashString(filepath.Clean(s.workspace))
	instance, err := master.FindAssetInstance(masterItemID, adventureKey)
	if err != nil {
		return usage, nil
	}
	usage.Used = true
	usage.LoadedRevision = instance.LoadedRevision
	usage.HasNewVersion = instance.LoadedRevision != item.ActiveWorkingRevision
	return usage, nil
}

// FindAssetInstance returns the unique instance binding one Master asset to
// one Adventure. Zero bindings mean the asset was never loaded into that
// Adventure; multiple bindings are a data error the user must resolve first.
func (s *MasterLibraryStore) FindAssetInstance(masterItemID, adventureKey string) (MasterInstanceRef, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return MasterInstanceRef{}, err
	}
	found := make([]MasterInstanceRef, 0, 1)
	for _, instance := range manifest.Instances {
		if instance.MasterItemID == strings.TrimSpace(masterItemID) && instance.AdventureKey == strings.TrimSpace(adventureKey) {
			found = append(found, instance)
		}
	}
	if len(found) == 0 {
		return MasterInstanceRef{}, errors.New("当前冒险未使用该资产")
	}
	if len(found) > 1 {
		return MasterInstanceRef{}, errors.New("当前冒险存在重复实例，请人工清理后再同步")
	}
	return found[0], nil
}

// MarkInstanceSynced refreshes the loaded revision after every Adventure
// target was updated. It must never be called after a partial failure,
// otherwise the UI would claim "synced" while content stayed stale.
func (s *MasterLibraryStore) MarkInstanceSynced(importID, instanceID, loadedRevision string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return err
	}
	updated := false
	for index := range manifest.Instances {
		if manifest.Instances[index].InstanceID == instanceID {
			manifest.Instances[index].LoadedRevision = strings.TrimSpace(loadedRevision)
			updated = true
		}
	}
	if !updated {
		return os.ErrNotExist
	}
	ref, ok := masterImportByID(manifest, importID)
	if ok {
		if transaction, loadErr := s.loadImportUnlocked(ref.Path); loadErr == nil {
			transaction.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
			if err := s.writeJSONUnlocked(ref.Path, transaction); err != nil {
				return err
			}
		}
	}
	return s.saveManifestUnlocked(manifest)
}

// ReprojectMasterAsset syncs one Master asset's current active working
// revision into the existing Adventure instance, updating the projected lore
// items in place. It is user-triggered and never runs silently; the Master
// side keeps its "new versions never overwrite Adventure instances" rule.
//
// Update boundary: Master-owned fields (display name, brief/content,
// keywords/secondary keywords) are refreshed from the active translation
// version; Adventure-local fields (ID, Enabled, load mode, images,
// provenance, tags and other local runtime state) are preserved. Opening
// presets stay Adventure-local snapshots and are not synced.
func (s *Service) ReprojectMasterAsset(masterItemID string) (MasterReprojectResult, error) {
	masterItemID = strings.TrimSpace(masterItemID)
	if masterItemID == "" {
		return MasterReprojectResult{}, errors.New("总库资产 ID 不能为空")
	}
	master := NewMasterLibraryStore(s.workspace)
	item, err := master.LoadItem(masterItemID)
	if err != nil {
		return MasterReprojectResult{}, err
	}
	adventureKey := masterHashString(filepath.Clean(s.workspace))
	instance, err := master.FindAssetInstance(masterItemID, adventureKey)
	if err != nil {
		return MasterReprojectResult{}, err
	}
	transaction, err := master.LoadImport(instance.ImportID)
	if err != nil {
		return MasterReprojectResult{}, err
	}
	if transaction.Status != "instantiated" {
		return MasterReprojectResult{}, errors.New("该资产尚未完成加入冒险，无法同步")
	}
	if !containsMasterString(transaction.ItemIDs, masterItemID) {
		return MasterReprojectResult{}, errors.New("导入事务与总库资产不一致")
	}
	store := NewLoreStore(s.workspace)
	existing, err := store.ListAll()
	if err != nil {
		return MasterReprojectResult{}, err
	}
	byID := map[string]LoreItem{}
	for _, lore := range existing {
		byID[lore.ID] = lore
	}
	// 目标完整性：全部实例目标与嵌套条目必须仍然存在；缺失时整体失败，
	// 绝不 continue 后仍更新 LoadedRevision，避免“同步成功但内容没更新”的假状态。
	ownTargets := map[string]bool{}
	for _, id := range instance.TargetLoreIDs {
		ownTargets[id] = true
		if _, found := byID[id]; !found {
			return MasterReprojectResult{}, fmt.Errorf("冒险资料条目缺失: %s，请删除后重新加入冒险", id)
		}
	}
	for _, id := range instance.NestedEntryLoreIDs {
		if _, found := byID[id]; !found {
			return MasterReprojectResult{}, fmt.Errorf("冒险嵌套条目缺失: %s，请删除后重新加入冒险", id)
		}
	}
	if len(ownTargets) == 0 {
		return MasterReprojectResult{}, errors.New("实例缺少目标资料映射，无法同步")
	}
	sourceRecord, _, sourceData, err := master.LoadSourceRevision(item.SourceID, item.SourceRevision)
	if err != nil {
		return MasterReprojectResult{}, err
	}
	// 名称分配排除本资产自己的全部 target ID，避免原名被误判占用而生成
	// “Alice-2”一类伪冲突。
	existingForOps := make([]LoreItem, 0, len(existing))
	for _, lore := range existing {
		if ownTargets[lore.ID] {
			continue
		}
		existingForOps = append(existingForOps, lore)
	}
	ops, _, _, _, err := buildMasterRuntimeOperations(sourceRecord.Filename, sourceData, []MasterItem{item}, transaction, existingForOps)
	if err != nil {
		return MasterReprojectResult{}, err
	}
	if len(ops) != len(ownTargets) {
		return MasterReprojectResult{}, fmt.Errorf("实例目标映射不完整（实例 %d 个目标，当前生成 %d 个），请人工核查", len(ownTargets), len(ops))
	}
	updateOps := make([]LoreOperation, 0, len(ops))
	for _, op := range ops {
		id := op.Item.ID
		if !ownTargets[id] {
			return MasterReprojectResult{}, fmt.Errorf("生成的目标不在实例映射中: %s", id)
		}
		target := byID[id]
		name := op.Item.Name
		if name == "" || loreItemNameIndex(existing, name, id) >= 0 {
			name = target.Name
		}
		updateOps = append(updateOps, LoreOperation{Op: "update", ID: id, Item: LoreItemInput{
			ID:               id,
			Enabled:          &target.Enabled,
			Type:             target.Type,
			TypeSource:       target.TypeSource,
			Name:             name,
			Importance:       firstNonEmptyLoreValue(op.Item.Importance, target.Importance),
			BriefDescription: firstNonEmptyLoreValue(op.Item.BriefDescription, target.BriefDescription),
			Keywords:         op.Item.Keywords,
			LoadMode:         target.LoadMode,
			Content:          firstNonEmptyLoreValue(op.Item.Content, target.Content),
			Image:            target.Image,
			Provenance:       target.Provenance,
		}})
	}
	snapshots, err := snapshotCharacterCardImportFiles(s.workspace)
	if err != nil {
		return MasterReprojectResult{}, err
	}
	rollback := func(cause error) (MasterReprojectResult, error) {
		if restoreErr := restoreCharacterCardImportFiles(snapshots); restoreErr != nil {
			return MasterReprojectResult{}, fmt.Errorf("%w；回滚冒险资料失败: %v", cause, restoreErr)
		}
		return MasterReprojectResult{}, cause
	}
	applied, err := store.ApplyOperations("从叙界总资料库同步「"+masterItemDisplayName(item)+"」", updateOps)
	if err != nil {
		return rollback(err)
	}
	if err := master.MarkInstanceSynced(instance.ImportID, instance.InstanceID, item.ActiveWorkingRevision); err != nil {
		return rollback(fmt.Errorf("更新同步版本失败: %w", err))
	}
	updated := make([]string, 0, len(applied.Updated))
	for _, lore := range applied.Updated {
		updated = append(updated, lore.ID)
	}
	return MasterReprojectResult{
		MasterItemID:     masterItemID,
		UpdatedLoreIDs:   updated,
		PreviousRevision: instance.LoadedRevision,
		LoadedRevision:   item.ActiveWorkingRevision,
	}, nil
}
