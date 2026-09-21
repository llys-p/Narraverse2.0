package library

import (
	"sort"
	"strings"
	"time"

	"denova/internal/book"
)

// 本文件负责把外部输入收敛到契约允许的形态：词表回落、空白清理、
// 稳定 ID 分配与默认档位。所有写入路径都必须先归一化再校验。
//
// 与旧作品 Lore 的关键差别（刻意为之，见 LIBRARY_L1_DATA_CONTRACT §4）：
//   - 允许同名条目：名称只用于展示与检索，引用一律走稳定 ID，不按名称合并；
//   - 加载档位与重要度解耦：major 不自动升为常驻，新条目默认按需（auto）。

func nowStamp() string { return time.Now().UTC().Format(time.RFC3339Nano) }

// normalizeItemType 收敛条目类型：库内新类型优先，其余交给旧 Lore 词表实现。
func normalizeItemType(t string) string {
	switch strings.TrimSpace(t) {
	case TypeEvent, TypeAbility:
		return strings.TrimSpace(t)
	default:
		return book.NormalizeLoreType(t)
	}
}

// normalizeLoadMode 收敛加载档位，未知值回落按需。
func normalizeLoadMode(v string) string { return book.NormalizeLoreLoadModeStrict(v) }

// normalizeImportance 收敛重要度，未知值回落 important。
func normalizeImportance(v string) string { return book.NormalizeLoreImportance(v) }

// normalizeOrigin 收敛来源形态。缺省原创；但只要带了来源就默认按“改编”处理，
// 避免“带了来源却标原创”这种自相矛盾的元数据。
func normalizeOrigin(v string, src *SourceRef) string {
	switch strings.TrimSpace(v) {
	case OriginOriginal, OriginAdaptation, OriginReference:
		return strings.TrimSpace(v)
	}
	if src != nil {
		return OriginAdaptation
	}
	return OriginOriginal
}

// normalizePurpose 收敛用途标注，未知值回落 any。
func normalizePurpose(v string) string {
	v = strings.TrimSpace(v)
	if isPurpose(v) {
		return v
	}
	return PurposeAny
}

// normalizeRelationKind 收敛关系类型，未知值回落 other。
func normalizeRelationKind(v string) string {
	v = strings.TrimSpace(v)
	if isRelationKind(v) {
		return v
	}
	return RelationOther
}

// normalizeEventCategory 收敛事件类别，未知值回落 background。
func normalizeEventCategory(v string) string {
	v = strings.TrimSpace(v)
	if isEventCategory(v) {
		return v
	}
	return EventCategoryBackground
}

func normalizeSource(src *SourceRef) *SourceRef {
	if src == nil {
		return nil
	}
	kind := strings.TrimSpace(src.Kind)
	if kind == "" {
		kind = SourceKindManual
	}
	out := &SourceRef{
		Kind:     kind,
		ID:       strings.TrimSpace(src.ID),
		Revision: strings.TrimSpace(src.Revision),
		Locator:  strings.TrimSpace(src.Locator),
		Label:    strings.TrimSpace(src.Label),
	}
	// Updated 是服务端核对的派生标记，不接受客户端写入。
	out.Updated = false
	return out
}

func normalizeFields(fields map[string]string) map[string]string {
	if len(fields) == 0 {
		return nil
	}
	out := make(map[string]string, len(fields))
	for key, value := range fields {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		out[key] = strings.TrimSpace(value)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// normalizeItemFromInput 把条目入参转成条目记录（不含服务端 ID/时间戳）。
func normalizeItemFromInput(in ItemInput) Item {
	item := Item{
		Enabled:    in.Enabled == nil || *in.Enabled,
		Type:       in.Type,
		TypeSource: in.TypeSource,
		Name:       in.Name,
		Importance: in.Importance,
		Tags:       in.Tags,
		Keywords:   in.Keywords,
		LoadMode:   in.LoadMode,
		Origin:     in.Origin,
		Source:     in.Source,
		Fields:     in.Fields,
		Event:      in.Event,
	}
	if in.Content != nil {
		item.Content = *in.Content
	}
	if in.BriefDescription != nil {
		item.BriefDescription = *in.BriefDescription
	}
	return item
}

// NormalizeItem 把条目收敛到契约形态。firstCreate=true 时补齐创建时间并分配 ID。
func NormalizeItem(item Item, firstCreate bool) Item {
	item.Type = normalizeItemType(item.Type)
	item.Name = strings.TrimSpace(item.Name)
	item.BriefDescription = strings.TrimSpace(item.BriefDescription)
	item.Tags = book.NormalizeLoreStringList(item.Tags)
	item.Keywords = book.NormalizeLoreStringList(item.Keywords)
	item.LoadMode = normalizeLoadMode(item.LoadMode)
	item.Importance = normalizeImportance(item.Importance)
	item.Source = normalizeSource(item.Source)
	item.Origin = normalizeOrigin(item.Origin, item.Source)
	item.Fields = normalizeFields(item.Fields)
	if item.TypeSource == "" {
		item.TypeSource = book.LoreTypeSourceManual
	}
	if item.Type == TypeEvent {
		detail := EventDetail{}
		if item.Event != nil {
			detail = *item.Event
		}
		detail.Era = strings.TrimSpace(detail.Era)
		detail.Category = normalizeEventCategory(detail.Category)
		detail.ParticipantItemIDs = normalizeIDList(detail.ParticipantItemIDs)
		detail.LocationItemID = strings.TrimSpace(detail.LocationItemID)
		item.Event = &detail
	} else {
		item.Event = nil
	}
	if firstCreate {
		item.CreatedAt = nowStamp()
		item.UpdatedAt = item.CreatedAt
	}
	return item
}

// normalizeIDList 去空白、去重并保持顺序。
func normalizeIDList(ids []string) []string {
	if len(ids) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// NormalizeRelation 收敛关系记录。
func NormalizeRelation(relation Relation, firstCreate bool) Relation {
	relation.FromItemID = strings.TrimSpace(relation.FromItemID)
	relation.ToItemID = strings.TrimSpace(relation.ToItemID)
	relation.Kind = normalizeRelationKind(relation.Kind)
	relation.Label = strings.TrimSpace(relation.Label)
	relation.Note = strings.TrimSpace(relation.Note)
	relation.Since = strings.TrimSpace(relation.Since)
	relation.Until = strings.TrimSpace(relation.Until)
	if firstCreate {
		relation.CreatedAt = nowStamp()
		relation.UpdatedAt = relation.CreatedAt
	}
	return relation
}

// NormalizeLibrary 收敛整个库（不改 ID/时间戳，交由调用方决定）。
func NormalizeLibrary(l Library) Library {
	l.Name = strings.TrimSpace(l.Name)
	l.Summary = strings.TrimSpace(l.Summary)
	l.Tone = strings.TrimSpace(l.Tone)
	l.StartingPoint = strings.TrimSpace(l.StartingPoint)
	l.Purpose = normalizePurpose(l.Purpose)
	l.SchemaVersion = SchemaVersion
	if l.Items == nil {
		l.Items = []Item{}
	}
	if l.Relations == nil {
		l.Relations = []Relation{}
	}
	return l
}

// itemIDSet 返回库内已占用的条目 ID 集合。
func itemIDSet(items []Item) map[string]bool {
	used := make(map[string]bool, len(items))
	for _, item := range items {
		if id := strings.TrimSpace(item.ID); id != "" {
			used[id] = true
		}
	}
	return used
}

// allocateItemID 为条目分配稳定 ID：优先由名称派生，冲突时追加 -2、-3……
// 名称派生不出可用词干时回落到类型名。ID 一旦分配即不变，改名不改 ID。
func allocateItemID(items []Item, name, itemType string) string {
	used := itemIDSet(items)
	base := book.LoreIDBaseFromName(name)
	if base == "" {
		base = normalizeItemType(itemType)
	}
	return book.UniqueIDFromBase(used, base)
}

// allocateRelationID 为关系分配稳定 ID。
func allocateRelationID(relations []Relation) string {
	used := make(map[string]bool, len(relations))
	for _, relation := range relations {
		used[strings.TrimSpace(relation.ID)] = true
	}
	return book.UniqueIDFromBase(used, "rel")
}

// BuildTimeline 由事件条目派生时间线视图（唯一的读取入口，不单独落盘）。
// 排序：类别（background → historical → planned）→ order → era → 名称 → ID，
// 保证同一份数据每次得到完全相同的顺序（前端与测试都可依赖）。
func BuildTimeline(items []Item) []TimelineEntry {
	entries := make([]TimelineEntry, 0, len(items))
	for _, item := range items {
		if item.Type != TypeEvent || item.Event == nil {
			continue
		}
		participants := make([]string, 0, len(item.Event.ParticipantItemIDs))
		for _, id := range item.Event.ParticipantItemIDs {
			participants = append(participants, id)
		}
		entries = append(entries, TimelineEntry{
			ItemID:       item.ID,
			Title:        item.Name,
			Era:          item.Event.Era,
			Order:        item.Event.Order,
			Category:     item.Event.Category,
			Enabled:      item.Enabled,
			Summary:      firstNonEmpty(item.BriefDescription, book.NormalizeLoreSummaryLine(item.Content)),
			Participants: participants,
			LocationID:   item.Event.LocationItemID,
		})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		ri, rj := eventCategoryRank(entries[i].Category), eventCategoryRank(entries[j].Category)
		if ri != rj {
			return ri < rj
		}
		if entries[i].Order != entries[j].Order {
			return entries[i].Order < entries[j].Order
		}
		if entries[i].Era != entries[j].Era {
			return entries[i].Era < entries[j].Era
		}
		if entries[i].Title != entries[j].Title {
			return entries[i].Title < entries[j].Title
		}
		return entries[i].ItemID < entries[j].ItemID
	})
	return entries
}

func eventCategoryRank(category string) int {
	switch category {
	case EventCategoryBackground:
		return 0
	case EventCategoryHistorical:
		return 1
	case EventCategoryPlanned:
		return 2
	default:
		return 3
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// ComputeImpact 计算删除某条目会波及的引用（关系与事件）。
func ComputeImpact(l Library, itemID string) Impact {
	impact := Impact{ItemID: itemID, Relations: []Relation{}, Events: []TimelineEntry{}}
	for _, item := range l.Items {
		if item.ID == itemID {
			impact.ItemName = item.Name
			break
		}
	}
	for _, relation := range l.Relations {
		if relation.FromItemID == itemID || relation.ToItemID == itemID {
			impact.Relations = append(impact.Relations, relation)
		}
	}
	for _, entry := range BuildTimeline(l.Items) {
		if entry.ItemID == itemID {
			continue
		}
		if entry.LocationID == itemID {
			impact.Events = append(impact.Events, entry)
			continue
		}
		for _, participant := range entry.Participants {
			if participant == itemID {
				impact.Events = append(impact.Events, entry)
				break
			}
		}
	}
	return impact
}

// SummarizeLibrary 由库内容即时派生列表摘要。
func SummarizeLibrary(l Library) Summary {
	summary := Summary{
		ID:        l.ID,
		Name:      l.Name,
		Summary:   l.Summary,
		Purpose:   l.Purpose,
		Tone:      l.Tone,
		ItemCount: len(l.Items),
		CreatedAt: l.CreatedAt,
		UpdatedAt: l.UpdatedAt,
	}
	summary.RelationCount = len(l.Relations)
	for _, item := range l.Items {
		if item.Type == TypeEvent {
			summary.EventCount++
		}
		if item.Origin == OriginReference {
			summary.ReferenceCount++
		}
		if item.LoadMode == LoadModeResident {
			summary.ResidentCount++
		}
	}
	return summary
}
