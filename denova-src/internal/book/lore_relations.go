package book

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// LoreRelation belongs to its source LoreItem. IDs are stable across renames;
// labels express user-confirmed setting facts, not inferred mention links.
type LoreRelation struct {
	TargetID string `json:"target_id"`
	Label    string `json:"label"`
	Note     string `json:"note,omitempty"`
}

type LoreRelationUpdate struct {
	ID           string         `json:"id"`
	BaseRevision string         `json:"base_revision"`
	Relations    []LoreRelation `json:"relations"`
}

// WriteRelations replaces the selected sources' outgoing links in one atomic
// lore transaction. A failed validation or stale source leaves all items intact.
func (s *LoreStore) WriteRelations(updates []LoreRelationUpdate) ([]LoreItem, error) {
	if len(updates) == 0 || len(updates) > 16 {
		return nil, fmt.Errorf("一次关系写入须包含 1–16 个资料条目")
	}
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	collection, err := s.loadOrCreate()
	if err != nil {
		return nil, err
	}
	byID := make(map[string]int, len(collection.Items))
	for i, item := range collection.Items {
		byID[item.ID] = i
	}
	seen := map[string]bool{}
	result := make([]LoreItem, 0, len(updates))
	for _, update := range updates {
		id := strings.TrimSpace(update.ID)
		idx, ok := byID[id]
		if !ok || seen[id] {
			return nil, fmt.Errorf("关系源条目不存在或重复: %s", id)
		}
		seen[id] = true
		item := collection.Items[idx]
		if strings.TrimSpace(update.BaseRevision) == "" {
			return nil, fmt.Errorf("关系写入必须提供 base_revision")
		}
		if update.BaseRevision != item.UpdatedAt {
			return nil, ErrLoreRevisionConflict
		}
		if update.Relations == nil || len(update.Relations) > 128 {
			return nil, fmt.Errorf("relations 必须是数组，最多 128 条；清空时传 []")
		}
		relations := make([]LoreRelation, 0, len(update.Relations))
		keys := map[string]bool{}
		for _, relation := range update.Relations {
			relation.TargetID = strings.TrimSpace(relation.TargetID)
			relation.Label = strings.TrimSpace(relation.Label)
			relation.Note = strings.TrimSpace(relation.Note)
			if _, exists := byID[relation.TargetID]; !exists || relation.TargetID == id {
				return nil, fmt.Errorf("关系目标必须是本书另一条已存在的资料: %s", relation.TargetID)
			}
			if relation.Label == "" || utf8.RuneCountInString(relation.Label) > 100 || utf8.RuneCountInString(relation.Note) > 2000 {
				return nil, fmt.Errorf("关系名称须为 1–100 字，说明最多 2000 字")
			}
			key := relation.TargetID + "\x00" + relation.Label
			if keys[key] {
				return nil, fmt.Errorf("同一目标与关系名称不能重复")
			}
			keys[key] = true
			relations = append(relations, relation)
		}
		item.Relations = relations
		item.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		collection.Items[idx] = item
		result = append(result, item)
	}
	if err := s.save(collection); err != nil {
		return nil, err
	}
	return result, nil
}

// Deleting an item also unlinks incoming relations in the same save. The source
// revision advances so a stale relation editor cannot resurrect deleted links.
func pruneDeletedLoreRelations(items []LoreItem) []LoreItem {
	exists := make(map[string]bool, len(items))
	for _, item := range items {
		exists[item.ID] = true
	}
	for i, item := range items {
		if len(item.Relations) == 0 {
			continue
		}
		kept := make([]LoreRelation, 0, len(item.Relations))
		for _, relation := range item.Relations {
			if exists[relation.TargetID] {
				kept = append(kept, relation)
			}
		}
		if len(kept) == len(item.Relations) {
			continue
		}
		items[i].Relations = kept
		items[i].UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	return items
}
