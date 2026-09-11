package worldcontext

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"

	"denova/internal/world"
)

// 内容字段字符上限（v2.7 §4.8，rune 计；超限 budget_exceeded，绝不截断）。
const (
	maxIdentityName    = 100
	maxIdentityTagline = 200
	maxIdentityGenre   = 50
	maxIdentitySummary = 20000
	maxTone            = 200
	maxRuleText        = 2000
	maxDisplayName     = 100
	maxWorldNote       = 4000
	maxRelLabel        = 100
	maxEntityName      = 100
	maxEntityDesc      = 20000
	maxEraLabel        = 100
	maxTimelineTitle   = 200
	maxTags            = 50
	maxTagText         = 100
	maxMaterials       = 20
	maxSelectedTotal   = 60
	maxRevisionLen     = 100
	revisionPrefix     = "sha256:"
)

// BuildSnapshot 是纯函数：从一份“已保存、revision 匹配”的 World 与已解码 Selection
// 构建不可变 Snapshot。它不读盘、不发网络请求、不回写 World；同输入必同输出。
//
// currentRevision 由 App 层（后续 P2）从 world.Store.Get 取得后传入。
func BuildSnapshot(consumer Consumer, ref Ref, currentRevision string, w world.World) (*Snapshot, error) {
	// 消费者可信边界：3.0B 只允许 writing/game。
	if consumer != ConsumerWriting && consumer != ConsumerGame {
		return nil, domainError(ErrConsumerNotTrusted, "consumer", "当前阶段不允许该模式请求世界上下文")
	}
	// expectedWorldRevision 形状（§4.11c）。
	expected := ref.ExpectedWorldRevision
	if strings.TrimSpace(expected) == "" || strings.ContainsAny(expected, " \t\r\n") ||
		!strings.HasPrefix(expected, revisionPrefix) || len(expected) > maxRevisionLen {
		return nil, domainError(ErrInvalidRequest, "expectedWorldRevision", "世界版本号格式非法")
	}
	if expected != currentRevision {
		return nil, domainError(ErrRevisionConflict, "expectedWorldRevision", "世界已被修改，请重新确认后进入")
	}
	// 跨 World 防护。
	if ref.WorldID != w.ID {
		return nil, domainError(ErrSelectionInvalid, "worldId", "选择与当前世界不一致")
	}
	if w.Status == world.StatusArchived {
		return nil, domainError(ErrWorldArchived, "status", "世界已归档，不能新加载世界上下文")
	}
	if strings.TrimSpace(w.Name) == "" {
		// 已保存世界结构异常（world 校验本应阻止）；属服务端数据问题，可降级。
		return nil, domainError(ErrWorldUnavailable, "identity.name", "世界缺少必填名称")
	}

	// 五步检测：第 2/3/4 步（第 1 步形状由 DecodeSelection 在入口完成）。
	sel, derr := resolveSelection(ref.Selection, w)
	if derr != nil {
		return nil, derr
	}

	// 闭包后合计对象上限。
	totalSelected := len(sel.CharacterIDs) + len(sel.LocationIDs) + len(sel.FactionIDs) +
		len(sel.TimelineEntryIDs) + len(sel.BindingIDs)
	if totalSelected > maxSelectedTotal {
		return nil, budgetError("selection.total", fmt.Sprintf("选中对象合计 %d 超过上限 %d", totalSelected, maxSelectedTotal))
	}

	charByID := indexCharacters(w.Characters)
	locByID := indexLocations(w.Locations)
	facByID := indexFactions(w.Factions)
	tlByID := indexTimeline(w.Timeline)
	bindingByID := indexBindings(w.Bindings)

	selectedChar := asSet(sel.CharacterIDs)
	selectedLoc := asSet(sel.LocationIDs)
	selectedFac := asSet(sel.FactionIDs)

	omissions := []Omission{}
	warnings := []SnapshotWarning{}

	// Identity 段 + 字段上限。
	identity := Identity{
		Name:    strings.TrimSpace(w.Name),
		Tagline: strings.TrimSpace(w.Tagline),
		Genre:   strings.TrimSpace(w.Genre),
		Summary: w.Summary,
	}
	if err := capRune("identity.name", identity.Name, maxIdentityName); err != nil {
		return nil, err
	}
	if err := capRune("identity.tagline", identity.Tagline, maxIdentityTagline); err != nil {
		return nil, err
	}
	if err := capRune("identity.genre", identity.Genre, maxIdentityGenre); err != nil {
		return nil, err
	}
	if err := capRune("identity.summary", identity.Summary, maxIdentitySummary); err != nil {
		return nil, err
	}

	// Setting 段：仅当基调入选或至少一条规则入选时存在。
	var setting *Setting
	if sel.IncludeTone || len(sel.RuleIndexes) > 0 {
		st := &Setting{Rules: []string{}}
		if sel.IncludeTone && w.WorldSetting != nil {
			st.Tone = strings.TrimSpace(w.WorldSetting.Tone)
			if err := capRune("setting.tone", st.Tone, maxTone); err != nil {
				return nil, err
			}
		}
		if w.WorldSetting != nil {
			for _, idx := range sel.RuleIndexes {
				rule := w.WorldSetting.Rules[idx]
				if err := capRune("setting.rules", rule, maxRuleText); err != nil {
					return nil, err
				}
				st.Rules = append(st.Rules, rule)
			}
		}
		if st.Tone != "" || len(st.Rules) > 0 {
			setting = st
		}
	}

	// 角色段：闭包 faction/location/relationship。
	characters := []SnapshotCharacter{}
	for _, id := range sel.CharacterIDs {
		c := charByID[id]
		sc := SnapshotCharacter{
			ID:            c.ID,
			DisplayName:   c.DisplayName,
			Role:          c.Role,
			WorldNote:     c.WorldNote,
			Relationships: []SnapshotRelationship{},
		}
		if err := capRune("character.displayName", sc.DisplayName, maxDisplayName); err != nil {
			return nil, err
		}
		if err := capRune("character.worldNote", sc.WorldNote, maxWorldNote); err != nil {
			return nil, err
		}
		if c.FactionID != "" {
			if _, selOK := selectedFac[c.FactionID]; selOK {
				sc.FactionID = c.FactionID
			} else {
				_, exists := facByID[c.FactionID]
				omissions = append(omissions, Omission{
					Kind: OmissionCharacterFaction, OwnerEntityID: c.ID, MissingEntityID: c.FactionID,
					Reason: omissionReason(exists),
				})
			}
		}
		if c.LocationID != "" {
			if _, selOK := selectedLoc[c.LocationID]; selOK {
				sc.LocationID = c.LocationID
			} else {
				_, exists := locByID[c.LocationID]
				omissions = append(omissions, Omission{
					Kind: OmissionCharacterLocation, OwnerEntityID: c.ID, MissingEntityID: c.LocationID,
					Reason: omissionReason(exists),
				})
			}
		}
		for _, rel := range c.Relationships {
			if err := capRune("relationship.label", rel.Label, maxRelLabel); err != nil {
				return nil, err
			}
			if _, ok := selectedChar[rel.TargetCharacterID]; ok {
				sc.Relationships = append(sc.Relationships, SnapshotRelationship{
					TargetCharacterID: rel.TargetCharacterID, Label: rel.Label,
				})
			} else {
				_, exists := charByID[rel.TargetCharacterID]
				omissions = append(omissions, Omission{
					Kind: OmissionRelationshipEdge, OwnerEntityID: c.ID, MissingEntityID: rel.TargetCharacterID,
					Reason: omissionReason(exists),
				})
			}
		}
		characters = append(characters, sc)
	}

	// 地点段。
	locations := []SnapshotLocation{}
	for _, id := range sel.LocationIDs {
		l := locByID[id]
		sl := SnapshotLocation{ID: l.ID, Name: l.Name, Description: l.Description, Tags: orEmptyTags(l.Tags)}
		if err := capRune("location.name", sl.Name, maxEntityName); err != nil {
			return nil, err
		}
		if err := capRune("location.description", sl.Description, maxEntityDesc); err != nil {
			return nil, err
		}
		if err := capTags("location.tags", sl.Tags); err != nil {
			return nil, err
		}
		locations = append(locations, sl)
	}

	// 势力段：闭包 headquarters。
	factions := []SnapshotFaction{}
	for _, id := range sel.FactionIDs {
		f := facByID[id]
		sf := SnapshotFaction{
			ID: f.ID, Name: f.Name, Description: f.Description,
			Influence: f.Influence, Stability: f.Stability,
		}
		if err := capRune("faction.name", sf.Name, maxEntityName); err != nil {
			return nil, err
		}
		if err := capRune("faction.description", sf.Description, maxEntityDesc); err != nil {
			return nil, err
		}
		if f.HeadquartersLocationID != "" {
			if _, selOK := selectedLoc[f.HeadquartersLocationID]; selOK {
				sf.HeadquartersLocationID = f.HeadquartersLocationID
			} else {
				_, exists := locByID[f.HeadquartersLocationID]
				omissions = append(omissions, Omission{
					Kind: OmissionFactionHeadquarters, OwnerEntityID: f.ID, MissingEntityID: f.HeadquartersLocationID,
					Reason: omissionReason(exists),
				})
			}
		}
		factions = append(factions, sf)
	}

	// 时间段：category 归一为新三值，旧值/空值记 warning。
	timeline := []SnapshotTimelineEntry{}
	for _, id := range sel.TimelineEntryIDs {
		t := tlByID[id]
		raw := t.Category
		if !isNewTimelineCategory(raw) {
			warnings = append(warnings, SnapshotWarning{
				Code: WarningLegacyTimelineCategory, RefKind: "timeline", RefID: t.ID,
			})
		}
		st := SnapshotTimelineEntry{
			ID: t.ID, Order: t.Order, EraLabel: t.EraLabel, Title: t.Title,
			Description: t.Description, Category: world.NormalizeTimelineCategoryForDisplay(raw),
		}
		if err := capRune("timeline.eraLabel", st.EraLabel, maxEraLabel); err != nil {
			return nil, err
		}
		if err := capRune("timeline.title", st.Title, maxTimelineTitle); err != nil {
			return nil, err
		}
		if err := capRune("timeline.description", st.Description, maxEntityDesc); err != nil {
			return nil, err
		}
		if st.Order < 0 {
			return nil, domainError(ErrSelectionInvalid, "timeline.order", "时间线顺序必须是非负整数")
		}
		timeline = append(timeline, st)
	}

	// 资料段：实体绑定随入选实体自动派生（不可经 bindingIds 偷渡），world 绑定显式单选。
	materials, mErr := buildMaterials(sel, w, bindingByID, characters, locations, factions, &warnings)
	if mErr != nil {
		return nil, mErr
	}

	fingerprint, err := computeFingerprint(consumer, currentRevision, sel)
	if err != nil {
		return nil, domainError(ErrProjectionFailed, "contextFingerprint", "指纹计算失败: "+err.Error())
	}

	snap := &Snapshot{
		SchemaVersion:      SchemaVersion,
		WorldID:            w.ID,
		WorldRevision:      currentRevision,
		Consumer:           consumer,
		ContextFingerprint: fingerprint,
		CanonicalSelection: sel,
		Identity:           identity,
		Setting:            setting,
		Characters:         characters,
		Locations:          locations,
		Factions:           factions,
		Timeline:           timeline,
		Materials:          materials,
		Omissions:          omissions,
		Warnings:           warnings,
		Stats: SnapshotStats{
			CharacterCount: len(characters),
			LocationCount:  len(locations),
			FactionCount:   len(factions),
			TimelineCount:  len(timeline),
			MaterialCount:  len(materials),
		},
	}
	return snap, nil
}

func omissionReason(targetExistsInWorld bool) OmissionReason {
	if targetExistsInWorld {
		return ReasonTargetNotSelected
	}
	return ReasonTargetCascadedRemoved
}

func isNewTimelineCategory(c world.TimelineCategory) bool {
	return c == world.TimelineBackground || c == world.TimelineHistorical || c == world.TimelinePlanned
}

func buildMaterials(
	sel Selection,
	w world.World,
	bindingByID map[string]world.AssetBinding,
	characters []SnapshotCharacter,
	locations []SnapshotLocation,
	factions []SnapshotFaction,
	warnings *[]SnapshotWarning,
) ([]SnapshotMaterial, error) {
	materials := []SnapshotMaterial{}
	seen := map[string]struct{}{}

	add := func(bindingID string) {
		if bindingID == "" {
			return
		}
		if _, done := seen[bindingID]; done {
			return
		}
		b, ok := bindingByID[bindingID]
		if !ok {
			// 实体引用了不存在的绑定：已保存世界完整性问题，跳过派生（不失败、不偷渡）。
			return
		}
		seen[bindingID] = struct{}{}
		tags := orEmptyTags(b.TagsSnapshot)
		materials = append(materials, SnapshotMaterial{
			BindingID:    b.BindingID,
			MasterItemID: b.MasterItemID,
			Name:         b.NameSnapshot,
			Tags:         tags,
			SemanticType: b.SemanticType,
			Scope:        effectiveBindingScope(b),
		})
		if b.MasterRevision == "" {
			*warnings = append(*warnings, SnapshotWarning{
				Code: WarningBindingUnchecked, RefKind: "binding", RefID: b.BindingID,
			})
		}
	}

	// 实体派生顺序：角色 → 地点 → 势力（canonical 顺序）。
	entityBinding := func(id string, table map[string]string) { add(table[id]) }
	charBinding := map[string]string{}
	for _, c := range w.Characters {
		charBinding[c.ID] = c.BindingID
	}
	locBinding := map[string]string{}
	for _, l := range w.Locations {
		locBinding[l.ID] = l.BindingID
	}
	facBinding := map[string]string{}
	for _, f := range w.Factions {
		facBinding[f.ID] = f.BindingID
	}
	for _, c := range characters {
		entityBinding(c.ID, charBinding)
	}
	for _, l := range locations {
		entityBinding(l.ID, locBinding)
	}
	for _, f := range factions {
		entityBinding(f.ID, facBinding)
	}
	// world scope 显式选择（已在 resolveSelection 校验为 world scope 且存在）。
	for _, id := range sel.BindingIDs {
		add(id)
	}

	if len(materials) > maxMaterials {
		return nil, budgetError("materials", "资料数量超过上限")
	}
	for _, m := range materials {
		if err := capRune("material.name", m.Name, maxEntityName); err != nil {
			return nil, err
		}
		if err := capTags("material.tags", m.Tags); err != nil {
			return nil, err
		}
	}
	return materials, nil
}

// computeFingerprint 实现 v2.7 §4.6：固定字段顺序的 canonical selection，
// 外层固定顺序，NFC 后 sha256，取前 32 hex，带 v1| 前缀。
func computeFingerprint(consumer Consumer, worldRevision string, sel Selection) (string, error) {
	canonSel, err := marshalStable(sel.wire())
	if err != nil {
		return "", err
	}
	outer := struct {
		SchemaVersion      int             `json:"schemaVersion"`
		Consumer           Consumer        `json:"consumer"`
		WorldRevision      string          `json:"worldRevision"`
		CanonicalSelection json.RawMessage `json:"canonicalSelection"`
	}{
		SchemaVersion:      SchemaVersion,
		Consumer:           consumer,
		WorldRevision:      worldRevision,
		CanonicalSelection: canonSel,
	}
	raw, err := marshalStable(outer)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(norm.NFC.Bytes(raw))
	return "v1|" + hex.EncodeToString(sum[:])[:32], nil
}

func capRune(field, value string, max int) error {
	if utf8.RuneCountInString(value) > max {
		return budgetError(field, "字段超过字符上限")
	}
	return nil
}

func capTags(field string, tags []string) error {
	if len(tags) > maxTags {
		return budgetError(field, "标签数量超过上限")
	}
	for _, t := range tags {
		if err := capRune(field, t, maxTagText); err != nil {
			return err
		}
	}
	return nil
}

func orEmptyTags(tags []string) []string {
	if tags == nil {
		return []string{}
	}
	return tags
}

func asSet(ids []string) map[string]struct{} {
	m := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		m[id] = struct{}{}
	}
	return m
}

func indexCharacters(in []world.Character) map[string]world.Character {
	m := make(map[string]world.Character, len(in))
	for _, c := range in {
		m[c.ID] = c
	}
	return m
}
func indexLocations(in []world.Location) map[string]world.Location {
	m := make(map[string]world.Location, len(in))
	for _, l := range in {
		m[l.ID] = l
	}
	return m
}
func indexFactions(in []world.Faction) map[string]world.Faction {
	m := make(map[string]world.Faction, len(in))
	for _, f := range in {
		m[f.ID] = f
	}
	return m
}
func indexTimeline(in []world.TimelineEntry) map[string]world.TimelineEntry {
	m := make(map[string]world.TimelineEntry, len(in))
	for _, t := range in {
		m[t.ID] = t
	}
	return m
}
func indexBindings(in []world.AssetBinding) map[string]world.AssetBinding {
	m := make(map[string]world.AssetBinding, len(in))
	for _, b := range in {
		m[b.BindingID] = b
	}
	return m
}
