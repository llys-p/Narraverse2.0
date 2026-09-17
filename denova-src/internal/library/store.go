package library

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"denova/internal/revisionfile"
)

// 设定库存储：全局数据目录下的 libraries 子目录，一个库一个 JSON 文件。
//
// 一次写入的完整语义（L1 数据契约 §5）：
//   - 所有变更都在 revisionfile 的路径锁内做“读 → 改 → 原子替换”，
//     因此并发请求不会互相覆盖，进程崩溃也不会留下半个文件；
//   - 库级并发用文件内容哈希 revision（expected_revision 不匹配即 409）；
//   - 条目级并发用条目 updatedAt（baseUpdatedAt 不匹配即 409），与旧 Lore 同语义；
//   - 每次写入前先 ValidateLibrary，悬空引用等结构错误根本写不进去。

const (
	dirName       = "libraries"
	filePrefix    = "library-"
	fileSuffix    = ".json"
	createRetries = 6
)

// Store 以全局数据目录下的 libraries 子目录为根管理设定库文件。
type Store struct {
	root string
}

// NewStore 创建设定库存储；dataDir 通常是 cfg.DataDir()，与书籍 workspace 无关。
func NewStore(dataDir string) *Store {
	return &Store{root: filepath.Join(strings.TrimSpace(dataDir), dirName)}
}

// Root 返回设定库存储目录。
func (s *Store) Root() string { return s.root }

func (s *Store) dir() string { return s.root }

func (s *Store) libraryPath(id string) string {
	return filepath.Join(s.dir(), filePrefix+id+fileSuffix)
}

func writeOptions() revisionfile.Options {
	return revisionfile.Options{FileMode: 0o644, DirectoryMode: 0o755}
}

// newServerID 生成服务端库 id（16 位小写字母数字），与 World 的 ID 规则一致。
func newServerID() (string, error) {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	const length = 16
	b := make([]byte, length)
	max := big.NewInt(int64(len(alphabet)))
	for i := range b {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		b[i] = alphabet[n.Int64()]
	}
	return string(b), nil
}

func marshalLibrary(l *Library) ([]byte, error) {
	return json.MarshalIndent(l, "", "  ")
}

// decodeLibrary 解析并校验库文件；任何结构性问题都视为文件损坏（不静默修复）。
func decodeLibrary(data []byte) (Library, error) {
	var l Library
	if err := json.Unmarshal(data, &l); err != nil {
		return Library{}, fmt.Errorf("解析设定库失败：%w", err)
	}
	l = NormalizeLibrary(l)
	if err := ValidateLibrary(&l); err != nil {
		return Library{}, fmt.Errorf("设定库数据校验失败：%w", err)
	}
	return l, nil
}

// List 扫描目录即时生成摘要；损坏文件进入 Warnings 而非被静默丢弃。
func (s *Store) List(ctx context.Context) (ListResult, error) {
	result := ListResult{Libraries: []Summary{}, Warnings: []LoadWarning{}}
	entries, err := os.ReadDir(s.dir())
	if err != nil {
		if os.IsNotExist(err) {
			return result, nil // 目录尚未创建视为空集合
		}
		return result, err
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasPrefix(name, filePrefix) || !strings.HasSuffix(name, fileSuffix) {
			continue
		}
		fileID := strings.TrimSuffix(strings.TrimPrefix(name, filePrefix), fileSuffix)
		if !ValidLibraryID(fileID) {
			result.Warnings = append(result.Warnings, LoadWarning{File: name, ID: fileID, Reason: "文件名中的库 id 非法"})
			continue
		}
		snap, err := revisionfile.Read(ctx, filepath.Join(s.dir(), name))
		if err != nil {
			result.Warnings = append(result.Warnings, LoadWarning{File: name, ID: fileID, Reason: "读取失败"})
			continue
		}
		if !snap.Exists {
			continue
		}
		l, err := decodeLibrary(snap.Content)
		if err != nil {
			result.Warnings = append(result.Warnings, LoadWarning{File: name, ID: fileID, Reason: "数据校验失败：" + err.Error()})
			continue
		}
		result.Libraries = append(result.Libraries, SummarizeLibrary(l))
	}
	sort.SliceStable(result.Libraries, func(i, j int) bool {
		if result.Libraries[i].UpdatedAt != result.Libraries[j].UpdatedAt {
			return result.Libraries[i].UpdatedAt > result.Libraries[j].UpdatedAt
		}
		if result.Libraries[i].CreatedAt != result.Libraries[j].CreatedAt {
			return result.Libraries[i].CreatedAt > result.Libraries[j].CreatedAt
		}
		return result.Libraries[i].ID < result.Libraries[j].ID
	})
	return result, nil
}

// Get 读取单个库，返回库与其当前内容哈希 revision。缺失=ErrNotFound，损坏=普通错误。
func (s *Store) Get(ctx context.Context, id string) (Library, string, error) {
	if !ValidLibraryID(id) {
		return Library{}, "", ErrInvalidID
	}
	snap, err := revisionfile.Read(ctx, s.libraryPath(id))
	if err != nil {
		return Library{}, "", err
	}
	if !snap.Exists {
		return Library{}, "", ErrNotFound
	}
	l, err := decodeLibrary(snap.Content)
	if err != nil {
		return Library{}, "", fmt.Errorf("设定库文件已损坏：%w", err)
	}
	return l, snap.Revision, nil
}

// Create 原子创建一份空的独立设定库；服务端生成 id、schemaVersion 与时间戳。
func (s *Store) Create(ctx context.Context, in CreateInput) (Library, string, error) {
	if err := os.MkdirAll(s.dir(), 0o755); err != nil {
		return Library{}, "", err
	}
	if err := s.checkCreateCapacity(ctx); err != nil {
		return Library{}, "", err
	}
	now := nowStamp()
	l := NormalizeLibrary(Library{
		Name:          in.Name,
		Summary:       in.Summary,
		Purpose:       in.Purpose,
		Tone:          in.Tone,
		StartingPoint: in.StartingPoint,
		Items:         []Item{},
		Relations:     []Relation{},
		CreatedAt:     now,
		UpdatedAt:     now,
	})
	if err := ValidateLibrary(&l); err != nil {
		return Library{}, "", err
	}
	var lastErr error
	for attempt := 0; attempt < createRetries; attempt++ {
		id, err := newServerID()
		if err != nil {
			return Library{}, "", err
		}
		l.ID = id
		data, err := marshalLibrary(&l)
		if err != nil {
			return Library{}, "", err
		}
		if len(data) > MaxLibraryFileBytes {
			return Library{}, "", fieldError("library", "库数据超过 %d 字节上限", MaxLibraryFileBytes)
		}
		// 期望文件尚不存在（MissingRevision），碰撞则换 id 重试。
		res, err := revisionfile.ReplaceIfRevision(ctx, s.libraryPath(id), revisionfile.MissingRevision, data, writeOptions())
		if err == nil {
			return l, res.Revision, nil
		}
		if !errors.Is(err, ErrRevisionConflict) {
			return Library{}, "", err
		}
		lastErr = err
	}
	return Library{}, "", fmt.Errorf("创建设定库失败，多次生成 id 冲突：%w", lastErr)
}

// checkCreateCapacity 限制库总数，只影响“新建”，不阻止读取既有库。
func (s *Store) checkCreateCapacity(ctx context.Context) error {
	result, err := s.List(ctx)
	if err != nil {
		return err
	}
	if len(result.Libraries)+len(result.Warnings) >= MaxLibrariesPerStore {
		return fieldError("library", "设定库数量已达上限 %d，请先删除不再使用的库", MaxLibrariesPerStore)
	}
	return nil
}

// UpdateMeta 以 expectedRevision 为基做库元信息原子更新；revision 不匹配即 409。
func (s *Store) UpdateMeta(ctx context.Context, id, expectedRevision string, patch MetaPatchInput) (Library, string, error) {
	if !ValidLibraryID(id) {
		return Library{}, "", ErrInvalidID
	}
	if strings.TrimSpace(expectedRevision) == "" {
		return Library{}, "", fieldError("expected_revision", "不能为空")
	}
	var final Library
	res, err := revisionfile.Mutate(ctx, s.libraryPath(id), writeOptions(), func(snap revisionfile.Snapshot) ([]byte, error) {
		// 先判定并发基线，再解析内容：客户端 revision 过期时给 409，而不是“文件损坏”。
		if !snap.Exists {
			return nil, ErrNotFound
		}
		if snap.Revision != expectedRevision {
			return nil, &revisionfile.ConflictError{Path: s.libraryPath(id), Expected: expectedRevision, Actual: snap.Revision}
		}
		current, err := s.libraryFromSnapshot(id, snap)
		if err != nil {
			return nil, err
		}
		applyMetaPatch(&current, patch)
		current = NormalizeLibrary(current)
		current.UpdatedAt = nextStamp(current.UpdatedAt)
		if err := ValidateLibrary(&current); err != nil {
			return nil, err
		}
		final = current
		return s.marshalChecked(current)
	})
	if err != nil {
		return Library{}, "", err
	}
	return final, res.Revision, nil
}

func applyMetaPatch(l *Library, patch MetaPatchInput) {
	if patch.Name != nil {
		l.Name = *patch.Name
	}
	if patch.Summary != nil {
		l.Summary = *patch.Summary
	}
	if patch.Purpose != nil {
		l.Purpose = *patch.Purpose
	}
	if patch.Tone != nil {
		l.Tone = *patch.Tone
	}
	if patch.StartingPoint != nil {
		l.StartingPoint = *patch.StartingPoint
	}
}

// CreateItem 在库内新建条目；ID 为空时由服务端按名称派生稳定 ID。
func (s *Store) CreateItem(ctx context.Context, id string, in ItemInput) (Item, string, error) {
	if !ValidLibraryID(id) {
		return Item{}, "", ErrInvalidID
	}
	var created Item
	res, err := revisionfile.Mutate(ctx, s.libraryPath(id), writeOptions(), func(snap revisionfile.Snapshot) ([]byte, error) {
		current, err := s.libraryFromSnapshot(id, snap)
		if err != nil {
			return nil, err
		}
		if len(current.Items) >= MaxItems {
			return nil, fieldError("items", "条目数量已达上限 %d", MaxItems)
		}
		item := normalizeItemFromInput(in)
		item.ID = strings.TrimSpace(in.ID)
		if item.ID == "" {
			item.ID = allocateItemID(current.Items, item.Name, item.Type)
		}
		if !ValidEntityID(item.ID) {
			return nil, fieldError("id", "条目 ID 非法")
		}
		if itemIndex(current.Items, item.ID) >= 0 {
			return nil, fieldError("id", "条目 ID 已存在：%s", item.ID)
		}
		item = NormalizeItem(item, true)
		if err := validateItem(&item, "item"); err != nil {
			return nil, err
		}
		current.Items = append(current.Items, item)
		current.UpdatedAt = nextStamp(current.UpdatedAt)
		if err := ValidateLibrary(&current); err != nil {
			return nil, err
		}
		created = item
		return s.marshalChecked(current)
	})
	if err != nil {
		return Item{}, "", err
	}
	return created, res.Revision, nil
}

// UpdateItem 更新单条条目；baseUpdatedAt 不匹配即 409（条目级乐观并发）。
func (s *Store) UpdateItem(ctx context.Context, id string, in ItemInput) (Item, string, error) {
	if !ValidLibraryID(id) {
		return Item{}, "", ErrInvalidID
	}
	itemID := strings.TrimSpace(in.ID)
	if itemID == "" {
		return Item{}, "", fieldError("id", "更新条目时必须提供条目 ID")
	}
	var updated Item
	res, err := revisionfile.Mutate(ctx, s.libraryPath(id), writeOptions(), func(snap revisionfile.Snapshot) ([]byte, error) {
		current, err := s.libraryFromSnapshot(id, snap)
		if err != nil {
			return nil, err
		}
		index := itemIndex(current.Items, itemID)
		if index < 0 {
			return nil, fmt.Errorf("%w: %s", ErrItemNotFound, itemID)
		}
		previous := current.Items[index]
		if base := strings.TrimSpace(in.BaseUpdatedAt); base != "" && previous.UpdatedAt != base {
			return nil, fmt.Errorf("%w: %s", ErrItemRevisionConflict, itemID)
		}
		next, err := mergeItemUpdate(previous, in)
		if err != nil {
			return nil, err
		}
		if err := validateItem(&next, "item"); err != nil {
			return nil, err
		}
		next = NormalizeItem(next, false)
		next.CreatedAt = previous.CreatedAt
		next.UpdatedAt = nextStamp(previous.UpdatedAt)
		current.Items[index] = next
		current.UpdatedAt = nextStamp(current.UpdatedAt)
		if err := ValidateLibrary(&current); err != nil {
			return nil, err
		}
		updated = next
		return s.marshalChecked(current)
	})
	if err != nil {
		return Item{}, "", err
	}
	return updated, res.Revision, nil
}

// mergeItemUpdate 合并条目更新，并强制只读引用条目不得被本库改写正文。
//
// 规则（L1 数据契约 §4）：
//   - 存储中为 reference 且本次仍提交 reference：名称/正文/类型专用字段不得变化，否则 400；
//   - 本次显式改为 original/adaptation：视为“创建本项目版本”的显式动作，允许改写正文并保留来源；
//   - ID 永不改变（改名不改 ID，引用始终指向同一条目）；
//   - 省略的字段保持原值，只有显式提交才覆盖（正文用指针区分“未提交”与“清空”）。
func mergeItemUpdate(previous Item, in ItemInput) (Item, error) {
	next := previous
	if strings.TrimSpace(in.Type) != "" {
		next.Type = in.Type
	}
	if strings.TrimSpace(in.Name) != "" {
		next.Name = in.Name
	}
	if in.Enabled != nil {
		next.Enabled = *in.Enabled
	}
	if strings.TrimSpace(in.Importance) != "" {
		next.Importance = in.Importance
	}
	if in.Tags != nil {
		next.Tags = in.Tags
	}
	if in.BriefDescription != nil {
		next.BriefDescription = *in.BriefDescription
	}
	if in.Keywords != nil {
		next.Keywords = in.Keywords
	}
	if strings.TrimSpace(in.LoadMode) != "" {
		next.LoadMode = in.LoadMode
	}
	if strings.TrimSpace(in.TypeSource) != "" {
		next.TypeSource = in.TypeSource
	}
	if in.Source != nil {
		next.Source = in.Source
	}
	if in.Fields != nil {
		next.Fields = in.Fields
	}
	if in.Event != nil {
		next.Event = in.Event
	}
	if in.Content != nil {
		next.Content = *in.Content
	}
	next.Origin = normalizeOrigin(in.Origin, next.Source)
	next.ID = previous.ID

	if previous.Origin == OriginReference && next.Origin == OriginReference {
		// 采样归一化后的形态比较，避免“等价输入被判成改动”。
		incoming := NormalizeItem(next, false)
		existing := NormalizeItem(previous, false)
		if incoming.Name != existing.Name ||
			incoming.Content != existing.Content ||
			!sameFields(incoming.Fields, existing.Fields) {
			return Item{}, ErrReferenceReadOnly
		}
	}
	return next, nil
}

func sameFields(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for key, value := range a {
		if b[key] != value {
			return false
		}
	}
	return true
}

// DeleteItem 删除条目。存在引用且未显式级联时返回 ErrItemInUse（含影响明细，不产生悬空引用）。
func (s *Store) DeleteItem(ctx context.Context, id, itemID string, cascade bool) (DeleteItemResult, string, error) {
	if !ValidLibraryID(id) {
		return DeleteItemResult{}, "", ErrInvalidID
	}
	itemID = strings.TrimSpace(itemID)
	if itemID == "" {
		return DeleteItemResult{}, "", fieldError("itemId", "不能为空")
	}
	var result DeleteItemResult
	res, err := revisionfile.Mutate(ctx, s.libraryPath(id), writeOptions(), func(snap revisionfile.Snapshot) ([]byte, error) {
		current, err := s.libraryFromSnapshot(id, snap)
		if err != nil {
			return nil, err
		}
		index := itemIndex(current.Items, itemID)
		if index < 0 {
			return nil, fmt.Errorf("%w: %s", ErrItemNotFound, itemID)
		}
		impact := ComputeImpact(current, itemID)
		if !impact.Empty() && !cascade {
			return nil, &ItemInUseError{ItemID: itemID, ItemName: impact.ItemName, Impact: impact}
		}
		result = DeleteItemResult{DeletedID: itemID, RemovedRelationIDs: []string{}, UpdatedEventIDs: []string{}}
		// 级联：先清理指向该条目的关系，再从事件中摘掉参与者/地点引用。
		keptRelations := make([]Relation, 0, len(current.Relations))
		for _, relation := range current.Relations {
			if relation.FromItemID == itemID || relation.ToItemID == itemID {
				result.RemovedRelationIDs = append(result.RemovedRelationIDs, relation.ID)
				continue
			}
			keptRelations = append(keptRelations, relation)
		}
		current.Relations = keptRelations
		for i := range current.Items {
			item := &current.Items[i]
			if item.ID == itemID || item.Type != TypeEvent || item.Event == nil {
				continue
			}
			changed := false
			if item.Event.LocationItemID == itemID {
				item.Event.LocationItemID = ""
				changed = true
			}
			if len(item.Event.ParticipantItemIDs) > 0 {
				kept := make([]string, 0, len(item.Event.ParticipantItemIDs))
				for _, participant := range item.Event.ParticipantItemIDs {
					if participant == itemID {
						changed = true
						continue
					}
					kept = append(kept, participant)
				}
				item.Event.ParticipantItemIDs = normalizeIDList(kept)
			}
			if changed {
				item.UpdatedAt = nextStamp(item.UpdatedAt)
				result.UpdatedEventIDs = append(result.UpdatedEventIDs, item.ID)
			}
		}
		current.Items = append(current.Items[:index], current.Items[index+1:]...)
		current.UpdatedAt = nextStamp(current.UpdatedAt)
		if err := ValidateLibrary(&current); err != nil {
			return nil, err
		}
		return s.marshalChecked(current)
	})
	if err != nil {
		return DeleteItemResult{}, "", err
	}
	return result, res.Revision, nil
}

// ItemInUseError 表示删除被引用的条目，携带影响明细供前端展示后再决定是否级联。
type ItemInUseError struct {
	ItemID   string
	ItemName string
	Impact   Impact
}

func (e *ItemInUseError) Error() string {
	return fmt.Sprintf("%s：%s（关系 %d，事件 %d）", ErrItemInUse.Error(), e.ItemName, len(e.Impact.Relations), len(e.Impact.Events))
}

func (e *ItemInUseError) Unwrap() error { return ErrItemInUse }

// Impact 计算删除某条目的影响（只读，不修改任何数据）。
func (s *Store) Impact(ctx context.Context, id, itemID string) (Impact, error) {
	l, _, err := s.Get(ctx, id)
	if err != nil {
		return Impact{}, err
	}
	if itemIndex(l.Items, strings.TrimSpace(itemID)) < 0 {
		return Impact{}, fmt.Errorf("%w: %s", ErrItemNotFound, itemID)
	}
	return ComputeImpact(l, strings.TrimSpace(itemID)), nil
}

// CreateRelation 新建库内关系；两端必须是本库已有条目，且不重复。
func (s *Store) CreateRelation(ctx context.Context, id string, in RelationInput) (Relation, string, error) {
	if !ValidLibraryID(id) {
		return Relation{}, "", ErrInvalidID
	}
	var created Relation
	res, err := revisionfile.Mutate(ctx, s.libraryPath(id), writeOptions(), func(snap revisionfile.Snapshot) ([]byte, error) {
		current, err := s.libraryFromSnapshot(id, snap)
		if err != nil {
			return nil, err
		}
		if len(current.Relations) >= MaxRelations {
			return nil, fieldError("relations", "关系数量已达上限 %d", MaxRelations)
		}
		relation := NormalizeRelation(Relation{
			ID:         strings.TrimSpace(in.ID),
			FromItemID: in.FromItemID,
			ToItemID:   in.ToItemID,
			Kind:       in.Kind,
			Label:      in.Label,
			Note:       in.Note,
			Since:      in.Since,
			Until:      in.Until,
		}, true)
		if relation.ID == "" {
			relation.ID = allocateRelationID(current.Relations)
		}
		if err := ensureRelationTargets(current, relation); err != nil {
			return nil, err
		}
		if err := validateRelation(&relation, "relation"); err != nil {
			return nil, err
		}
		current.Relations = append(current.Relations, relation)
		current.UpdatedAt = nextStamp(current.UpdatedAt)
		if err := ValidateLibrary(&current); err != nil {
			return nil, err
		}
		created = relation
		return s.marshalChecked(current)
	})
	if err != nil {
		return Relation{}, "", err
	}
	return created, res.Revision, nil
}

// UpdateRelation 更新关系；两端必须仍存在。
func (s *Store) UpdateRelation(ctx context.Context, id, relationID string, in RelationInput) (Relation, string, error) {
	if !ValidLibraryID(id) {
		return Relation{}, "", ErrInvalidID
	}
	relationID = strings.TrimSpace(relationID)
	if relationID == "" {
		return Relation{}, "", fieldError("relationId", "不能为空")
	}
	var updated Relation
	res, err := revisionfile.Mutate(ctx, s.libraryPath(id), writeOptions(), func(snap revisionfile.Snapshot) ([]byte, error) {
		current, err := s.libraryFromSnapshot(id, snap)
		if err != nil {
			return nil, err
		}
		index := relationIndex(current.Relations, relationID)
		if index < 0 {
			return nil, fmt.Errorf("%w: %s", ErrRelationNotFound, relationID)
		}
		previous := current.Relations[index]
		next := NormalizeRelation(Relation{
			ID:         relationID,
			FromItemID: firstNonEmpty(in.FromItemID, previous.FromItemID),
			ToItemID:   firstNonEmpty(in.ToItemID, previous.ToItemID),
			Kind:       firstNonEmpty(in.Kind, previous.Kind),
			Label:      in.Label,
			Note:       in.Note,
			Since:      in.Since,
			Until:      in.Until,
		}, false)
		next.CreatedAt = previous.CreatedAt
		next.UpdatedAt = nextStamp(previous.UpdatedAt)
		if err := ensureRelationTargets(current, next); err != nil {
			return nil, err
		}
		if err := validateRelation(&next, "relation"); err != nil {
			return nil, err
		}
		current.Relations[index] = next
		current.UpdatedAt = nextStamp(current.UpdatedAt)
		if err := ValidateLibrary(&current); err != nil {
			return nil, err
		}
		updated = next
		return s.marshalChecked(current)
	})
	if err != nil {
		return Relation{}, "", err
	}
	return updated, res.Revision, nil
}

// DeleteRelation 删除关系。
func (s *Store) DeleteRelation(ctx context.Context, id, relationID string) (string, error) {
	if !ValidLibraryID(id) {
		return "", ErrInvalidID
	}
	relationID = strings.TrimSpace(relationID)
	if relationID == "" {
		return "", fieldError("relationId", "不能为空")
	}
	res, err := revisionfile.Mutate(ctx, s.libraryPath(id), writeOptions(), func(snap revisionfile.Snapshot) ([]byte, error) {
		current, err := s.libraryFromSnapshot(id, snap)
		if err != nil {
			return nil, err
		}
		index := relationIndex(current.Relations, relationID)
		if index < 0 {
			return nil, fmt.Errorf("%w: %s", ErrRelationNotFound, relationID)
		}
		current.Relations = append(current.Relations[:index], current.Relations[index+1:]...)
		current.UpdatedAt = nextStamp(current.UpdatedAt)
		return s.marshalChecked(current)
	})
	if err != nil {
		return "", err
	}
	return res.Revision, nil
}

// ensureRelationTargets 校验关系两端存在且不是同一条目，并拒绝重复关系。
func ensureRelationTargets(l Library, relation Relation) error {
	if itemIndex(l.Items, relation.FromItemID) < 0 {
		return fieldError("fromItemId", "引用了不存在的条目：%s", relation.FromItemID)
	}
	if itemIndex(l.Items, relation.ToItemID) < 0 {
		return fieldError("toItemId", "引用了不存在的条目：%s", relation.ToItemID)
	}
	if relation.FromItemID == relation.ToItemID {
		return ErrSelfRelation
	}
	for _, existing := range l.Relations {
		if existing.ID == relation.ID {
			continue
		}
		if existing.FromItemID == relation.FromItemID && existing.ToItemID == relation.ToItemID && existing.Kind == relation.Kind {
			return ErrDuplicateRelation
		}
	}
	return nil
}

// Delete 删除整个库；expectedRevision 不匹配即 409（防止删掉别人刚改过的库）。
func (s *Store) Delete(ctx context.Context, id, expectedRevision string) error {
	if !ValidLibraryID(id) {
		return ErrInvalidID
	}
	path := s.libraryPath(id)
	snap, err := revisionfile.Read(ctx, path)
	if err != nil {
		return err
	}
	if !snap.Exists {
		return ErrNotFound
	}
	if expected := strings.TrimSpace(expectedRevision); expected != "" && snap.Revision != expected {
		return &revisionfile.ConflictError{Path: path, Expected: expected, Actual: snap.Revision}
	}
	if err := os.Remove(path); err != nil {
		if os.IsNotExist(err) {
			return ErrNotFound
		}
		return err
	}
	return nil
}

// libraryFromSnapshot 在锁内解析快照；不存在即 ErrNotFound，损坏即损坏错误。
func (s *Store) libraryFromSnapshot(id string, snap revisionfile.Snapshot) (Library, error) {
	if !snap.Exists {
		return Library{}, ErrNotFound
	}
	l, err := decodeLibrary(snap.Content)
	if err != nil {
		return Library{}, fmt.Errorf("设定库文件已损坏，拒绝覆盖：%w", err)
	}
	l.ID = id
	return l, nil
}

// marshalChecked 序列化并强制库文件字节上限，避免单库无限增长。
func (s *Store) marshalChecked(l Library) ([]byte, error) {
	data, err := marshalLibrary(&l)
	if err != nil {
		return nil, err
	}
	if len(data) > MaxLibraryFileBytes {
		return nil, fieldError("library", "库数据 %d 字节超过上限 %d 字节，请拆分库或删除冗余资料", len(data), MaxLibraryFileBytes)
	}
	return data, nil
}

// nextStamp 生成严格大于 prev 的时间戳：同纳秒内连续写入也能得到不同值，
// 保证条目级 baseUpdatedAt 作为并发基线是可靠且单调的。
func nextStamp(prev string) string {
	now := nowStamp()
	if now != prev {
		return now
	}
	for i := 0; i < 1000; i++ {
		now = nowStamp()
		if now != prev {
			return now
		}
	}
	return prev + "0"
}

func itemIndex(items []Item, id string) int {
	id = strings.TrimSpace(id)
	for i := range items {
		if items[i].ID == id {
			return i
		}
	}
	return -1
}

func relationIndex(relations []Relation, id string) int {
	id = strings.TrimSpace(id)
	for i := range relations {
		if relations[i].ID == id {
			return i
		}
	}
	return -1
}
