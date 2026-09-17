package library

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"denova/internal/book"
	"denova/internal/revisionfile"
)

// 领域错误。HTTP 层按 code 映射状态码与响应 code（见 handler_library_workspace.go）：
//   - ValidationError / ErrInvalidID            → 400
//   - ErrNotFound / ErrItemNotFound / ErrRelationNotFound → 404
//   - ErrRevisionConflict / ErrItemRevisionConflict       → 409 + code=revision_conflict
//   - ErrItemInUse                                        → 409 + code=item_in_use
//   - ErrReferenceReadOnly / ErrDuplicateRelation / ErrSelfRelation → 400 / 409
var (
	// ErrRevisionConflict 复用 revisionfile 的内容哈希 CAS 冲突（库级并发保存冲突）。
	ErrRevisionConflict = revisionfile.ErrRevisionConflict

	// ErrNotFound 表示库不存在。
	ErrNotFound = errors.New("设定库不存在")
	// ErrInvalidID 表示库 id 非法。
	ErrInvalidID = errors.New("设定库 id 非法")
	// ErrItemNotFound 表示库内条目不存在。
	ErrItemNotFound = errors.New("条目不存在")
	// ErrRelationNotFound 表示库内关系不存在。
	ErrRelationNotFound = errors.New("关系不存在")
	// ErrItemRevisionConflict 表示条目级乐观并发冲突（baseUpdatedAt 与磁盘不一致）。
	ErrItemRevisionConflict = errors.New("条目已被其他操作更新，请重新加载后再保存")
	// ErrItemInUse 表示条目仍被关系或事件引用，删除需要显式级联。
	ErrItemInUse = errors.New("条目仍被关系或事件引用")
	// ErrReferenceReadOnly 表示试图改写只读引用条目的来源内容。
	ErrReferenceReadOnly = errors.New("只读引用条目的正文以来源为准，不能在本库改写")
	// ErrDuplicateRelation 表示同一条目对之间已存在同类型关系。
	ErrDuplicateRelation = errors.New("相同关系已存在")
	// ErrSelfRelation 表示关系两端是同一个条目。
	ErrSelfRelation = errors.New("关系两端不能是同一条目")
	// ErrLimitExceeded 表示超出存储/编辑上限（HTTP 400）。
	ErrLimitExceeded = errors.New("超出设定库上限")
)

// ValidationError 表示字段级校验失败，HTTP 层映射为 400。
type ValidationError struct {
	Field  string `json:"field"`
	Reason string `json:"reason"`
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("字段 %s：%s", e.Field, e.Reason)
}

func fieldError(field, format string, args ...any) error {
	return &ValidationError{Field: field, Reason: fmt.Sprintf(format, args...)}
}

var (
	// 服务端库 id：纯小写字母数字，长度与 world 一致，便于目录名安全。
	libraryIDRe = regexp.MustCompile(`^[a-z0-9]{12,24}$`)
	// 条目/关系 ID：允许 Unicode 字母数字与 - _ .，禁止路径分隔符与空白。
	entityIDRe = regexp.MustCompile(`^[^\\/\s\x00-\x1f]{1,80}$`)
	// 绝对路径形态：Windows 盘符、UNC、POSIX 绝对路径。
	absolutePathRe = regexp.MustCompile(`(?i)^([a-z]:[\\/]|\\\\|/)`)
)

// ValidLibraryID 报告库 id 是否合法。
func ValidLibraryID(id string) bool { return libraryIDRe.MatchString(strings.TrimSpace(id)) }

func runeLen(s string) int { return utf8.RuneCountInString(s) }

func checkRunes(field, value string, max int) error {
	if runeLen(value) > max {
		return fieldError(field, "长度不能超过 %d 个字符", max)
	}
	return nil
}

// ValidateLibrary 校验整个库的结构不变量。任何写入（含内部读改写）都必须先过这里。
func ValidateLibrary(l *Library) error {
	if l == nil {
		return fieldError("library", "不能为空")
	}
	if err := checkRunes("name", l.Name, MaxLibraryNameRunes); err != nil {
		return err
	}
	if strings.TrimSpace(l.Name) == "" {
		return fieldError("name", "库名称不能为空")
	}
	if err := checkRunes("summary", l.Summary, MaxLibrarySummaryRunes); err != nil {
		return err
	}
	if err := checkRunes("tone", l.Tone, MaxToneRunes); err != nil {
		return err
	}
	if err := checkRunes("startingPoint", l.StartingPoint, MaxStartingPointRunes); err != nil {
		return err
	}
	if !isPurpose(l.Purpose) {
		return fieldError("purpose", "用途取值非法：%s", l.Purpose)
	}
	if len(l.Items) > MaxItems {
		return fieldError("items", "条目数量不能超过 %d（当前 %d）", MaxItems, len(l.Items))
	}
	if len(l.Relations) > MaxRelations {
		return fieldError("relations", "关系数量不能超过 %d（当前 %d）", MaxRelations, len(l.Relations))
	}

	itemIDs := make(map[string]bool, len(l.Items))
	eventCount := 0
	for i := range l.Items {
		item := &l.Items[i]
		if err := validateItem(item, fmt.Sprintf("items[%d]", i)); err != nil {
			return err
		}
		if itemIDs[item.ID] {
			return fieldError(fmt.Sprintf("items[%d].id", i), "条目 ID 重复：%s", item.ID)
		}
		itemIDs[item.ID] = true
		if item.Type == TypeEvent {
			eventCount++
		}
	}
	if eventCount > MaxEvents {
		return fieldError("items", "事件条目数量不能超过 %d（当前 %d）", MaxEvents, eventCount)
	}

	relationIDs := make(map[string]bool, len(l.Relations))
	seenPairs := make(map[string]bool, len(l.Relations))
	for i := range l.Relations {
		relation := &l.Relations[i]
		if err := validateRelation(relation, fmt.Sprintf("relations[%d]", i)); err != nil {
			return err
		}
		if relationIDs[relation.ID] {
			return fieldError(fmt.Sprintf("relations[%d].id", i), "关系 ID 重复：%s", relation.ID)
		}
		relationIDs[relation.ID] = true
		// 悬空引用是硬错误：关系两端必须是本库存在的条目。
		if !itemIDs[relation.FromItemID] {
			return fieldError(fmt.Sprintf("relations[%d].fromItemId", i), "引用了不存在的条目：%s", relation.FromItemID)
		}
		if !itemIDs[relation.ToItemID] {
			return fieldError(fmt.Sprintf("relations[%d].toItemId", i), "引用了不存在的条目：%s", relation.ToItemID)
		}
		pairKey := relation.FromItemID + "\x00" + relation.ToItemID + "\x00" + relation.Kind
		if seenPairs[pairKey] {
			return fieldError(fmt.Sprintf("relations[%d]", i), "重复关系：%s → %s (%s)", relation.FromItemID, relation.ToItemID, relation.Kind)
		}
		seenPairs[pairKey] = true
	}
	return nil
}

func validateItem(item *Item, field string) error {
	if item == nil {
		return fieldError(field, "不能为空")
	}
	if !ValidEntityID(item.ID) {
		return fieldError(field+".id", "条目 ID 非法")
	}
	if err := checkRunes(field+".name", item.Name, MaxItemNameRunes); err != nil {
		return err
	}
	if strings.TrimSpace(item.Name) == "" {
		return fieldError(field+".name", "条目名称不能为空")
	}
	if err := book.ValidateLoreReferenceName(item.Name); err != nil {
		return fieldError(field+".name", "%s", err.Error())
	}
	if !isItemType(item.Type) {
		return fieldError(field+".type", "条目类型非法：%s", item.Type)
	}
	if !isLoadMode(item.LoadMode) {
		return fieldError(field+".loadMode", "加载档位非法：%s", item.LoadMode)
	}
	if !isImportance(item.Importance) {
		return fieldError(field+".importance", "重要度非法：%s", item.Importance)
	}
	if !isOrigin(item.Origin) {
		return fieldError(field+".origin", "来源形态非法：%s", item.Origin)
	}
	if err := checkRunes(field+".briefDescription", item.BriefDescription, MaxBriefRunes); err != nil {
		return err
	}
	if err := checkRunes(field+".content", item.Content, MaxItemContentRunes); err != nil {
		return err
	}
	if len(item.Tags) > MaxTags {
		return fieldError(field+".tags", "标签数量不能超过 %d", MaxTags)
	}
	for _, tag := range item.Tags {
		if err := checkRunes(field+".tags", tag, MaxTagRunes); err != nil {
			return err
		}
	}
	if len(item.Keywords) > MaxKeywords {
		return fieldError(field+".keywords", "关键词数量不能超过 %d", MaxKeywords)
	}
	for _, keyword := range item.Keywords {
		if err := checkRunes(field+".keywords", keyword, MaxKeywordRunes); err != nil {
			return err
		}
	}
	if err := validateFields(item.Fields, field+".fields"); err != nil {
		return err
	}
	if err := validateSource(item.Source, field+".source"); err != nil {
		return err
	}
	// 只读引用条目必须带来源，否则“以来源为准”无从核对。
	if item.Origin == OriginReference && item.Source == nil {
		return fieldError(field+".source", "只读引用条目必须提供来源")
	}
	if item.Type == TypeEvent {
		if err := validateEvent(item.Event, field+".event"); err != nil {
			return err
		}
	} else if item.Event != nil {
		return fieldError(field+".event", "只有事件条目（type=event）可以带事件字段")
	}
	return nil
}

func validateFields(fields map[string]string, field string) error {
	if len(fields) > MaxFields {
		return fieldError(field, "类型专用字段不能超过 %d 个", MaxFields)
	}
	for key, value := range fields {
		key = strings.TrimSpace(key)
		if key == "" {
			return fieldError(field, "字段键不能为空")
		}
		if err := checkRunes(field+"."+key, key, MaxFieldKeyRunes); err != nil {
			return err
		}
		if err := checkRunes(field+"."+key, value, MaxFieldValueRunes); err != nil {
			return err
		}
	}
	return nil
}

func validateSource(src *SourceRef, field string) error {
	if src == nil {
		return nil
	}
	if !isSourceKind(src.Kind) {
		return fieldError(field+".kind", "来源类型非法：%s", src.Kind)
	}
	if err := checkRunes(field+".id", src.ID, MaxSourceIDRunes); err != nil {
		return err
	}
	if err := checkRunes(field+".revision", src.Revision, MaxSourceRevisionRunes); err != nil {
		return err
	}
	if err := checkRunes(field+".label", src.Label, MaxSourceLabelRunes); err != nil {
		return err
	}
	if err := checkRunes(field+".locator", src.Locator, MaxSourceLocatorRunes); err != nil {
		return err
	}
	// 本机绝对路径属于隐私，绝不进入资料库；来源只用稳定 ID / 相对定位标识。
	if IsAbsoluteLocator(src.Locator) {
		return fieldError(field+".locator", "来源定位不能是本机绝对路径")
	}
	return nil
}

// IsAbsoluteLocator 报告定位串是否为绝对路径（Windows 盘符 / UNC / POSIX 绝对路径）。
func IsAbsoluteLocator(locator string) bool {
	locator = strings.TrimSpace(locator)
	if locator == "" {
		return false
	}
	return absolutePathRe.MatchString(locator)
}

func validateEvent(detail *EventDetail, field string) error {
	if detail == nil {
		return fieldError(field, "事件条目必须提供事件字段")
	}
	if !isEventCategory(detail.Category) {
		return fieldError(field+".category", "事件类别非法：%s", detail.Category)
	}
	if err := checkRunes(field+".era", detail.Era, MaxEraRunes); err != nil {
		return err
	}
	if detail.Order > MaxEventOrderAbs || detail.Order < -MaxEventOrderAbs {
		return fieldError(field+".order", "顺序绝对值不能超过 %d", MaxEventOrderAbs)
	}
	if len(detail.ParticipantItemIDs) > MaxEventParticipants {
		return fieldError(field+".participantItemIds", "参与者数量不能超过 %d", MaxEventParticipants)
	}
	for _, id := range detail.ParticipantItemIDs {
		if !ValidEntityID(id) {
			return fieldError(field+".participantItemIds", "参与者 ID 非法：%s", id)
		}
	}
	if detail.LocationItemID != "" && !ValidEntityID(detail.LocationItemID) {
		return fieldError(field+".locationItemId", "地点 ID 非法：%s", detail.LocationItemID)
	}
	return nil
}

func validateRelation(r *Relation, field string) error {
	if r == nil {
		return fieldError(field, "不能为空")
	}
	if !ValidEntityID(r.ID) {
		return fieldError(field+".id", "关系 ID 非法")
	}
	if !isRelationKind(r.Kind) {
		return fieldError(field+".kind", "关系类型非法：%s", r.Kind)
	}
	if !ValidEntityID(r.FromItemID) {
		return fieldError(field+".fromItemId", "来源条目 ID 非法")
	}
	if !ValidEntityID(r.ToItemID) {
		return fieldError(field+".toItemId", "目标条目 ID 非法")
	}
	if r.FromItemID == r.ToItemID {
		return ErrSelfRelation
	}
	if err := checkRunes(field+".label", r.Label, MaxRelationLabelRunes); err != nil {
		return err
	}
	if err := checkRunes(field+".note", r.Note, MaxRelationNoteRunes); err != nil {
		return err
	}
	if err := checkRunes(field+".since", r.Since, MaxEraRunes); err != nil {
		return err
	}
	if err := checkRunes(field+".until", r.Until, MaxEraRunes); err != nil {
		return err
	}
	return nil
}

// ValidEntityID 报告条目/关系 ID 是否可用作稳定引用。
func ValidEntityID(id string) bool {
	id = strings.TrimSpace(id)
	if id == "" {
		return false
	}
	return entityIDRe.MatchString(id)
}

func isItemType(t string) bool {
	switch strings.TrimSpace(t) {
	case TypeEvent, TypeAbility:
		return true
	}
	for _, base := range BaseItemTypes() {
		if strings.TrimSpace(t) == base {
			return true
		}
	}
	return false
}

func isLoadMode(v string) bool {
	switch strings.TrimSpace(v) {
	case LoadModeResident, LoadModeAuto, LoadModeManual:
		return true
	default:
		return false
	}
}

func isImportance(v string) bool {
	switch strings.TrimSpace(v) {
	case ImportanceMajor, ImportanceImportant, ImportanceMinor:
		return true
	default:
		return false
	}
}

func isOrigin(v string) bool {
	switch strings.TrimSpace(v) {
	case OriginOriginal, OriginAdaptation, OriginReference:
		return true
	default:
		return false
	}
}

func isSourceKind(v string) bool {
	for _, kind := range AllSourceKinds() {
		if strings.TrimSpace(v) == kind {
			return true
		}
	}
	return false
}

func isRelationKind(v string) bool {
	for _, kind := range AllRelationKinds() {
		if strings.TrimSpace(v) == kind {
			return true
		}
	}
	return false
}

func isEventCategory(v string) bool {
	for _, category := range AllEventCategories() {
		if strings.TrimSpace(v) == category {
			return true
		}
	}
	return false
}

func isPurpose(v string) bool {
	for _, purpose := range AllPurposes() {
		if strings.TrimSpace(v) == purpose {
			return true
		}
	}
	return false
}
