package world

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// 数量与长度上限（计划 6.4）。超限一律视为 400，不做静默截断。
const (
	maxName        = 100
	maxTagline     = 200
	maxGenre       = 50
	maxSummary     = 20000
	maxCoverColor  = 32
	maxTone        = 200
	maxRules       = 50
	maxRuleItem    = 2000
	maxBindings    = 200
	maxCharacters  = 500
	maxLocations   = 500
	maxFactions    = 500
	maxTimeline    = 500
	maxTags        = 50
	maxTagItem     = 100
	maxItemName    = 100
	maxDescription = 20000
	maxNote        = 4000
	maxRelations   = 100
	maxRelationLbl = 200
	maxCustomKeys  = 50
	maxCustomKey   = 50
	maxCustomVal   = 2000
	maxEraLabel    = 100
	maxTitle       = 200
	maxCategory    = 100
	maxMasterItem  = 200
	maxMasterRev   = 100
)

var (
	// 客户端生成的 binding/实体 id：uuid 等可读唯一串，禁止路径分隔符。
	clientIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	// 服务端世界 id：纯小写字母数字。
	worldIDRe = regexp.MustCompile(`^[a-z0-9]{12,24}$`)
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

func runeLen(s string) int { return utf8.RuneCountInString(s) }

func checkLen(field, value string, max int) error {
	if runeLen(value) > max {
		return fieldError(field, "长度不能超过 %d 个字符", max)
	}
	return nil
}

// ValidWorldID 校验服务端世界 id 是否可安全进入文件路径。
func ValidWorldID(id string) bool { return worldIDRe.MatchString(id) }

func validClientID(id string) bool { return clientIDRe.MatchString(id) }

func validRecordKind(k BindingRecordKind) bool {
	return k == CharacterTemplate || k == LorebookTemplate
}

func validSemanticType(t SemanticType) bool {
	switch t {
	case SemanticCharacter, SemanticWorld, SemanticLocation, SemanticFaction,
		SemanticRule, SemanticItem, SemanticOther:
		return true
	}
	return false
}

// effectiveBindingScope 返回绑定的生命周期策略：显式 scope 优先；
// 旧绑定缺省 scope 时按语义推导——character/location/faction 挂实体=entity，其余属于世界=world。
// 该推导只用于校验与运行时，读取时不回写磁盘。
func effectiveBindingScope(b AssetBinding) BindingScope {
	if b.Scope == ScopeEntity || b.Scope == ScopeWorld {
		return b.Scope
	}
	switch b.SemanticType {
	case SemanticCharacter, SemanticLocation, SemanticFaction:
		return ScopeEntity
	default:
		return ScopeWorld
	}
}

func validRole(r CharacterRole) bool {
	switch r {
	case "", RoleProtagonist, RoleMajor, RoleMinor, RoleNPC:
		return true
	}
	return false
}

// normalizeWorld 归一化世界：默认值、去空白、保证切片非 nil（输出稳定数组）。
func normalizeWorld(w *World) {
	if w.Status == "" {
		w.Status = StatusActive
	}
	w.SchemaVersion = SchemaVersion
	w.Name = strings.TrimSpace(w.Name)
	w.Tagline = strings.TrimSpace(w.Tagline)
	w.Genre = strings.TrimSpace(w.Genre)
	w.CoverColor = strings.TrimSpace(w.CoverColor)
	w.PrimaryBookPath = strings.TrimSpace(w.PrimaryBookPath)
	w.PrimaryInteractiveStoryID = strings.TrimSpace(w.PrimaryInteractiveStoryID)
	if w.Bindings == nil {
		w.Bindings = []AssetBinding{}
	}
	if w.Characters == nil {
		w.Characters = []Character{}
	}
	if w.Locations == nil {
		w.Locations = []Location{}
	}
	if w.Factions == nil {
		w.Factions = []Faction{}
	}
	if w.Timeline == nil {
		w.Timeline = []TimelineEntry{}
	}
	if w.WorldSetting != nil && w.WorldSetting.Rules == nil {
		w.WorldSetting.Rules = []string{}
	}
}

// validateWorld 做上限、枚举白名单、唯一与引用完整性校验。调用前可先 normalize。
func validateWorld(w *World) error {
	name := strings.TrimSpace(w.Name)
	if name == "" {
		return fieldError("name", "世界名称不能为空")
	}
	if err := checkLen("name", name, maxName); err != nil {
		return err
	}
	if err := checkLen("tagline", w.Tagline, maxTagline); err != nil {
		return err
	}
	if err := checkLen("genre", w.Genre, maxGenre); err != nil {
		return err
	}
	if err := checkLen("summary", w.Summary, maxSummary); err != nil {
		return err
	}
	if err := checkLen("coverColor", w.CoverColor, maxCoverColor); err != nil {
		return err
	}
	if err := checkLen("primaryBookPath", w.PrimaryBookPath, maxDescription); err != nil {
		return err
	}
	if w.Status != StatusActive && w.Status != StatusArchived {
		return fieldError("status", "状态值非法")
	}
	if w.WorldSetting != nil {
		if err := checkLen("worldSetting.tone", w.WorldSetting.Tone, maxTone); err != nil {
			return err
		}
		if len(w.WorldSetting.Rules) > maxRules {
			return fieldError("worldSetting.rules", "规则数量不能超过 %d", maxRules)
		}
		for i, rule := range w.WorldSetting.Rules {
			if err := checkLen(fmt.Sprintf("worldSetting.rules[%d]", i), rule, maxRuleItem); err != nil {
				return err
			}
		}
	}

	if len(w.Bindings) > maxBindings {
		return fieldError("bindings", "绑定数量不能超过 %d", maxBindings)
	}
	bindingByID := make(map[string]AssetBinding, len(w.Bindings))
	masterItemSeen := make(map[string]int, len(w.Bindings))
	for i := range w.Bindings {
		b := &w.Bindings[i]
		field := fmt.Sprintf("bindings[%d]", i)
		if !validClientID(b.BindingID) {
			return fieldError(field+".bindingId", "格式非法")
		}
		if _, dup := bindingByID[b.BindingID]; dup {
			return fieldError(field+".bindingId", "bindingId 重复：%s", b.BindingID)
		}
		bindingByID[b.BindingID] = *b
		// 一个世界内同一总库条目只允许一个绑定（共享同一 bindingId），重复 masterItemId 直接拒绝。
		if prev, dup := masterItemSeen[b.MasterItemID]; dup {
			return fieldError(field+".masterItemId", "与 bindings[%d] 指向同一总库条目", prev)
		}
		masterItemSeen[b.MasterItemID] = i
		// scope 仅允许空（旧数据，读取时按 semanticType 推导）/entity/world，其它值判非法。
		if b.Scope != "" && b.Scope != ScopeEntity && b.Scope != ScopeWorld {
			return fieldError(field+".scope", "枚举值非法")
		}
		// masterRevision 允许空串（旧世界=尚未检查）；非空仅做长度上限校验。
		if err := checkLen(field+".masterRevision", b.MasterRevision, maxMasterRev); err != nil {
			return err
		}
		if strings.TrimSpace(b.MasterItemID) == "" {
			return fieldError(field+".masterItemId", "不能为空")
		}
		if err := checkLen(field+".masterItemId", b.MasterItemID, maxMasterItem); err != nil {
			return err
		}
		if !validRecordKind(b.RecordKind) {
			return fieldError(field+".recordKind", "枚举值非法")
		}
		if !validSemanticType(b.SemanticType) {
			return fieldError(field+".semanticType", "枚举值非法")
		}
		if err := checkLen(field+".nameSnapshot", b.NameSnapshot, maxItemName); err != nil {
			return err
		}
		if len(b.TagsSnapshot) > maxTags {
			return fieldError(field+".tagsSnapshot", "标签数量不能超过 %d", maxTags)
		}
		for j, tag := range b.TagsSnapshot {
			if err := checkLen(fmt.Sprintf("%s.tagsSnapshot[%d]", field, j), tag, maxTagItem); err != nil {
				return err
			}
		}
	}

	// locations / factions 需要先于角色建立索引（角色引用它们）。
	if len(w.Locations) > maxLocations {
		return fieldError("locations", "数量不能超过 %d", maxLocations)
	}
	locationIDs := make(map[string]struct{}, len(w.Locations))
	for i := range w.Locations {
		loc := &w.Locations[i]
		field := fmt.Sprintf("locations[%d]", i)
		if !validClientID(loc.ID) {
			return fieldError(field+".id", "格式非法")
		}
		if _, dup := locationIDs[loc.ID]; dup {
			return fieldError(field+".id", "id 重复：%s", loc.ID)
		}
		locationIDs[loc.ID] = struct{}{}
		if strings.TrimSpace(loc.Name) == "" {
			return fieldError(field+".name", "名称不能为空")
		}
		if err := checkLen(field+".name", loc.Name, maxItemName); err != nil {
			return err
		}
		if err := checkLen(field+".description", loc.Description, maxDescription); err != nil {
			return err
		}
		if len(loc.Tags) > maxTags {
			return fieldError(field+".tags", "标签数量不能超过 %d", maxTags)
		}
		if loc.BindingID != "" {
			b, ok := bindingByID[loc.BindingID]
			if !ok {
				return fieldError(field+".bindingId", "引用了不存在的绑定：%s", loc.BindingID)
			}
			// 地点只能绑定语义为 location 的顶层资产，禁止把 lore/设定伪装成地点。
			if b.SemanticType != SemanticLocation {
				return fieldError(field+".bindingId", "地点只能绑定 location 语义资产：%s", loc.BindingID)
			}
		}
	}

	if len(w.Factions) > maxFactions {
		return fieldError("factions", "数量不能超过 %d", maxFactions)
	}
	factionIDs := make(map[string]struct{}, len(w.Factions))
	for i := range w.Factions {
		f := &w.Factions[i]
		field := fmt.Sprintf("factions[%d]", i)
		if !validClientID(f.ID) {
			return fieldError(field+".id", "格式非法")
		}
		if _, dup := factionIDs[f.ID]; dup {
			return fieldError(field+".id", "id 重复：%s", f.ID)
		}
		factionIDs[f.ID] = struct{}{}
		if strings.TrimSpace(f.Name) == "" {
			return fieldError(field+".name", "名称不能为空")
		}
		if err := checkLen(field+".name", f.Name, maxItemName); err != nil {
			return err
		}
		if err := checkLen(field+".description", f.Description, maxDescription); err != nil {
			return err
		}
		if f.Influence != nil && (*f.Influence < 0 || *f.Influence > 100) {
			return fieldError(field+".influence", "取值必须在 0-100")
		}
		if f.Stability != nil && (*f.Stability < 0 || *f.Stability > 100) {
			return fieldError(field+".stability", "取值必须在 0-100")
		}
		if f.HeadquartersLocationID != "" {
			if _, ok := locationIDs[f.HeadquartersLocationID]; !ok {
				return fieldError(field+".headquartersLocationId", "引用了不存在的地点：%s", f.HeadquartersLocationID)
			}
		}
		if f.BindingID != "" {
			b, ok := bindingByID[f.BindingID]
			if !ok {
				return fieldError(field+".bindingId", "引用了不存在的绑定：%s", f.BindingID)
			}
			// 势力只能绑定语义为 faction 的顶层资产。
			if b.SemanticType != SemanticFaction {
				return fieldError(field+".bindingId", "势力只能绑定 faction 语义资产：%s", f.BindingID)
			}
		}
	}

	if len(w.Characters) > maxCharacters {
		return fieldError("characters", "数量不能超过 %d", maxCharacters)
	}
	characterIDs := make(map[string]struct{}, len(w.Characters))
	for i := range w.Characters {
		ch := &w.Characters[i]
		field := fmt.Sprintf("characters[%d]", i)
		if !validClientID(ch.ID) {
			return fieldError(field+".id", "格式非法")
		}
		if _, dup := characterIDs[ch.ID]; dup {
			return fieldError(field+".id", "id 重复：%s", ch.ID)
		}
		characterIDs[ch.ID] = struct{}{}
		if strings.TrimSpace(ch.DisplayName) == "" {
			return fieldError(field+".displayName", "名称不能为空")
		}
		if err := checkLen(field+".displayName", ch.DisplayName, maxItemName); err != nil {
			return err
		}
		if !validRole(ch.Role) {
			return fieldError(field+".role", "枚举值非法")
		}
		if ch.FactionID != "" {
			if _, ok := factionIDs[ch.FactionID]; !ok {
				return fieldError(field+".factionId", "引用了不存在的势力：%s", ch.FactionID)
			}
		}
		if ch.LocationID != "" {
			if _, ok := locationIDs[ch.LocationID]; !ok {
				return fieldError(field+".locationId", "引用了不存在的地点：%s", ch.LocationID)
			}
		}
		if ch.BindingID != "" {
			binding, ok := bindingByID[ch.BindingID]
			if !ok {
				return fieldError(field+".bindingId", "引用了不存在的绑定：%s", ch.BindingID)
			}
			if binding.RecordKind != CharacterTemplate || binding.SemanticType != SemanticCharacter {
				return fieldError(field+".bindingId", "角色只能引用角色模板绑定：%s", ch.BindingID)
			}
		}
		if err := checkLen(field+".worldNote", ch.WorldNote, maxNote); err != nil {
			return err
		}
		if err := checkLen(field+".growthNote", ch.GrowthNote, maxNote); err != nil {
			return err
		}
		if len(ch.Relationships) > maxRelations {
			return fieldError(field+".relationships", "关系数量不能超过 %d", maxRelations)
		}
		if len(ch.CustomFields) > maxCustomKeys {
			return fieldError(field+".customFields", "自定义字段不能超过 %d 个", maxCustomKeys)
		}
		for k, v := range ch.CustomFields {
			if runeLen(k) > maxCustomKey {
				return fieldError(field+".customFields key", "键长度不能超过 %d", maxCustomKey)
			}
			if runeLen(v) > maxCustomVal {
				return fieldError(field+".customFields value", "值长度不能超过 %d", maxCustomVal)
			}
		}
	}
	// 关系目标在全量角色索引建立后再校验。
	for i := range w.Characters {
		ch := &w.Characters[i]
		for j, rel := range ch.Relationships {
			field := fmt.Sprintf("characters[%d].relationships[%d]", i, j)
			if _, ok := characterIDs[rel.TargetCharacterID]; !ok {
				return fieldError(field+".targetCharacterId", "引用了不存在的角色：%s", rel.TargetCharacterID)
			}
			if err := checkLen(field+".label", rel.Label, maxRelationLbl); err != nil {
				return err
			}
		}
	}

	// 实体作用域绑定必须至少被一个角色/地点/势力引用；世界作用域绑定允许零引用。
	referenced := make(map[string]struct{})
	for i := range w.Characters {
		if id := w.Characters[i].BindingID; id != "" {
			referenced[id] = struct{}{}
		}
	}
	for i := range w.Locations {
		if id := w.Locations[i].BindingID; id != "" {
			referenced[id] = struct{}{}
		}
	}
	for i := range w.Factions {
		if id := w.Factions[i].BindingID; id != "" {
			referenced[id] = struct{}{}
		}
	}
	for i := range w.Bindings {
		b := &w.Bindings[i]
		if effectiveBindingScope(*b) == ScopeEntity {
			if _, ok := referenced[b.BindingID]; !ok {
				return fieldError(fmt.Sprintf("bindings[%d].scope", i), "实体作用域绑定缺少实体引用：%s", b.BindingID)
			}
		}
	}

	if len(w.Timeline) > maxTimeline {
		return fieldError("timeline", "数量不能超过 %d", maxTimeline)
	}
	timelineIDs := make(map[string]struct{}, len(w.Timeline))
	for i := range w.Timeline {
		t := &w.Timeline[i]
		field := fmt.Sprintf("timeline[%d]", i)
		if !validClientID(t.ID) {
			return fieldError(field+".id", "格式非法")
		}
		if _, dup := timelineIDs[t.ID]; dup {
			return fieldError(field+".id", "id 重复：%s", t.ID)
		}
		timelineIDs[t.ID] = struct{}{}
		if strings.TrimSpace(t.Title) == "" {
			return fieldError(field+".title", "标题不能为空")
		}
		if err := checkLen(field+".title", t.Title, maxTitle); err != nil {
			return err
		}
		if err := checkLen(field+".eraLabel", t.EraLabel, maxEraLabel); err != nil {
			return err
		}
		if err := checkLen(field+".description", t.Description, maxDescription); err != nil {
			return err
		}
		if err := checkLen(field+".category", string(t.Category), maxCategory); err != nil {
			return err
		}
	}
	return nil
}

// validateStoredWorld 校验磁盘文件的服务端字段与业务结构，避免合法 JSON 被当作正常世界。
func validateStoredWorld(w *World, fileID string) error {
	if !ValidWorldID(fileID) {
		return fieldError("id", "文件名中的世界 id 非法")
	}
	if w.ID != fileID {
		return fieldError("id", "文件内容 id 与文件名不一致")
	}
	if w.SchemaVersion != SchemaVersion {
		return fieldError("schemaVersion", "不支持的结构版本：%d", w.SchemaVersion)
	}
	if strings.TrimSpace(w.CreatedAt) == "" || strings.TrimSpace(w.UpdatedAt) == "" {
		return fieldError("timestamps", "创建或更新时间缺失")
	}
	normalizeWorld(w)
	return validateWorld(w)
}

// newWorldFromInput 把创建入参转为待落库世界（id/时间由 Store 补）。
func newWorldFromInput(in CreateInput) World {
	return World{
		Name:                      in.Name,
		Tagline:                   in.Tagline,
		Genre:                     in.Genre,
		Summary:                   in.Summary,
		CoverColor:                in.CoverColor,
		WorldSetting:              in.WorldSetting,
		Bindings:                  in.Bindings,
		Characters:                in.Characters,
		Locations:                 in.Locations,
		Factions:                  in.Factions,
		Timeline:                  in.Timeline,
		PrimaryBookPath:           in.PrimaryBookPath,
		PrimaryInteractiveStoryID: in.PrimaryInteractiveStoryID,
	}
}
