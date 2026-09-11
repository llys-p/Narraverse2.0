package worldcontext

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"

	"denova/internal/world"
)

// 形状级上限（v2.7 §4.7）；闭包后的合计上限在 budget.go。
const (
	maxRuleIndexes         = 50
	maxSelectionCharacters = 20
	maxSelectionLocations  = 20
	maxSelectionFactions   = 20
	maxSelectionTimeline   = 30
	maxSelectionBindings   = 20
)

// DecodeSelection 严格解码请求侧选择（五步检测的第 1 步：形状/类型解析）。
//
//   - 空字节、null、{} 均合法，得到全空选择（切片非 nil，保证 canonical JSON 稳定）；
//   - 未知字段 → invalid_request；includeTone 非 bool → invalid_request；
//   - id 数组元素必须是字符串；ruleIndexes 必须是整数（拒绝小数/NaN/Inf）；
//   - 普通重复值不在此步报错（第 4 步幂等去重）。
func DecodeSelection(raw json.RawMessage) (Selection, error) {
	var sel Selection
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return emptySelection(), nil
	}

	var wire struct {
		IncludeTone      *bool         `json:"includeTone"`
		RuleIndexes      []json.Number `json:"ruleIndexes"`
		CharacterIDs     []string      `json:"characterIds"`
		LocationIDs      []string      `json:"locationIds"`
		FactionIDs       []string      `json:"factionIds"`
		TimelineEntryIDs []string      `json:"timelineEntryIds"`
		BindingIDs       []string      `json:"bindingIds"`
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.DisallowUnknownFields()
	dec.UseNumber()
	if err := dec.Decode(&wire); err != nil {
		return Selection{}, domainError(ErrInvalidRequest, "selection", "选择参数无法解析: "+err.Error())
	}
	if dec.More() {
		return Selection{}, domainError(ErrInvalidRequest, "selection", "选择参数只允许一个 JSON 对象")
	}

	if wire.IncludeTone != nil {
		sel.IncludeTone = *wire.IncludeTone
	}

	if len(wire.RuleIndexes) > maxRuleIndexes {
		return Selection{}, budgetError("selection.ruleIndexes", "规则下标数量超过上限")
	}
	sel.RuleIndexes = make([]int, 0, len(wire.RuleIndexes))
	for _, n := range wire.RuleIndexes {
		i, ok := parseIntIndex(n)
		if !ok {
			return Selection{}, domainError(ErrSelectionInvalid, "selection.ruleIndexes", "规则下标必须是非负整数")
		}
		sel.RuleIndexes = append(sel.RuleIndexes, i)
	}

	var err error
	if sel.CharacterIDs, err = decodeIDList("characterIds", wire.CharacterIDs, maxSelectionCharacters); err != nil {
		return Selection{}, err
	}
	if sel.LocationIDs, err = decodeIDList("locationIds", wire.LocationIDs, maxSelectionLocations); err != nil {
		return Selection{}, err
	}
	if sel.FactionIDs, err = decodeIDList("factionIds", wire.FactionIDs, maxSelectionFactions); err != nil {
		return Selection{}, err
	}
	if sel.TimelineEntryIDs, err = decodeIDList("timelineEntryIds", wire.TimelineEntryIDs, maxSelectionTimeline); err != nil {
		return Selection{}, err
	}
	if sel.BindingIDs, err = decodeIDList("bindingIds", wire.BindingIDs, maxSelectionBindings); err != nil {
		return Selection{}, err
	}
	return sel, nil
}

func emptySelection() Selection {
	return Selection{
		RuleIndexes:      []int{},
		CharacterIDs:     []string{},
		LocationIDs:      []string{},
		FactionIDs:       []string{},
		TimelineEntryIDs: []string{},
		BindingIDs:       []string{},
	}
}

// parseIntIndex 只保证是整数（形状层）；负数是合法整数，越界/负值在归属阶段拒绝。
func parseIntIndex(n json.Number) (int, bool) {
	f, err := n.Float64()
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) {
		return 0, false
	}
	if f > float64(math.MaxInt32) || f < float64(math.MinInt32) {
		return 0, false
	}
	return int(f), true
}

func decodeIDList(field string, in []string, max int) ([]string, error) {
	if len(in) > max {
		return nil, budgetError("selection."+field, "选择数量超过上限")
	}
	out := make([]string, 0, len(in))
	for _, id := range in {
		out = append(out, id)
	}
	return out, nil
}

// resolveSelection 执行五步检测的第 2（归属）、3（越权/越界）、4（去重+稳定排序）步。
// 闭包（第 5 步）在 snapshot 构建时进行。返回按 World 内顺序稳定排序后的 canonical 选择。
func resolveSelection(sel Selection, w world.World) (Selection, *DomainError) {
	out := emptySelection()
	out.IncludeTone = sel.IncludeTone

	// 规则下标：去重升序；负数拒绝；越界=当前 revision 不存在该下标。
	ruleSet := make(map[int]struct{}, len(sel.RuleIndexes))
	rulesCount := 0
	if w.WorldSetting != nil {
		rulesCount = len(w.WorldSetting.Rules)
	}
	for _, idx := range sel.RuleIndexes {
		if idx < 0 {
			return Selection{}, domainError(ErrSelectionInvalid, "selection.ruleIndexes", "规则下标不允许为负数")
		}
		if idx >= rulesCount {
			return Selection{}, domainError(ErrSelectionInvalid, "selection.ruleIndexes", "规则下标越界，当前世界不存在该规则")
		}
		ruleSet[idx] = struct{}{}
	}
	for i := 0; i < rulesCount; i++ {
		if _, ok := ruleSet[i]; ok {
			out.RuleIndexes = append(out.RuleIndexes, i)
		}
	}

	invalid := []string{}
	out.CharacterIDs, invalid = orderByWorld(sel.CharacterIDs, characterOrder(w), &invalid)
	if len(invalid) > 0 {
		return Selection{}, withInvalid(ErrSelectionInvalid, "selection.characterIds", "存在不属于当前世界的角色 id", invalid)
	}
	out.LocationIDs, invalid = orderByWorld(sel.LocationIDs, locationOrder(w), &invalid)
	if len(invalid) > 0 {
		return Selection{}, withInvalid(ErrSelectionInvalid, "selection.locationIds", "存在不属于当前世界的地点 id", invalid)
	}
	out.FactionIDs, invalid = orderByWorld(sel.FactionIDs, factionOrder(w), &invalid)
	if len(invalid) > 0 {
		return Selection{}, withInvalid(ErrSelectionInvalid, "selection.factionIds", "存在不属于当前世界的势力 id", invalid)
	}
	out.TimelineEntryIDs, invalid = orderByWorld(sel.TimelineEntryIDs, timelineOrder(w), &invalid)
	if len(invalid) > 0 {
		return Selection{}, withInvalid(ErrSelectionInvalid, "selection.timelineEntryIds", "存在不属于当前世界的时间线条目 id", invalid)
	}

	// bindingIds：必须存在（归属）且只能是 world scope（越权）。
	bindingByID := make(map[string]world.AssetBinding, len(w.Bindings))
	bindingOrder := make([]string, 0, len(w.Bindings))
	for _, b := range w.Bindings {
		bindingByID[b.BindingID] = b
		bindingOrder = append(bindingOrder, b.BindingID)
	}
	chosen := dedupePreserveOrder(sel.BindingIDs)
	for _, id := range chosen {
		b, ok := bindingByID[id]
		if !ok {
			return Selection{}, withInvalid(ErrSelectionInvalid, "selection.bindingIds", "存在不属于当前世界的绑定 id", []string{id})
		}
		if effectiveBindingScope(b) != world.ScopeWorld {
			return Selection{}, withInvalid(ErrSelectionInvalid, "selection.bindingIds", "实体作用域绑定不能通过 bindingIds 单独选择，它随实体自动派生", []string{id})
		}
	}
	out.BindingIDs = orderByKeyOrder(chosen, bindingOrder)
	return out, nil
}

func withInvalid(code ErrorCode, field, msg string, ids []string) *DomainError {
	de := domainError(code, field, msg)
	de.Invalid = ids
	return de
}

// effectiveBindingScope 与 internal/world 的同名推导保持一致（P0 不修改 world 包）：
// 显式 scope 优先；缺省时 character/location/faction=entity，其余=world。
func effectiveBindingScope(b world.AssetBinding) world.BindingScope {
	switch b.Scope {
	case world.ScopeEntity, world.ScopeWorld:
		return b.Scope
	}
	switch b.SemanticType {
	case world.SemanticCharacter, world.SemanticLocation, world.SemanticFaction:
		return world.ScopeEntity
	default:
		return world.ScopeWorld
	}
}

// 以下 order 函数返回各类实体在 World 内的稳定顺序（即 canonical 排列依据）。
func characterOrder(w world.World) []string {
	ids := make([]string, 0, len(w.Characters))
	for _, c := range w.Characters {
		ids = append(ids, c.ID)
	}
	return ids
}

func locationOrder(w world.World) []string {
	ids := make([]string, 0, len(w.Locations))
	for _, l := range w.Locations {
		ids = append(ids, l.ID)
	}
	return ids
}

func factionOrder(w world.World) []string {
	ids := make([]string, 0, len(w.Factions))
	for _, f := range w.Factions {
		ids = append(ids, f.ID)
	}
	return ids
}

func timelineOrder(w world.World) []string {
	ids := make([]string, 0, len(w.Timeline))
	for _, t := range w.Timeline {
		ids = append(ids, t.ID)
	}
	return ids
}

// orderByWorld 按 worldOrder 的先后稳定排列 chosen：去重（幂等）、丢弃空白，
// 任何不在 worldOrder 中的 id 收集到 missing（非空表示失败）。
func orderByWorld(chosen, worldOrder []string, missing *[]string) ([]string, []string) {
	present := make(map[string]struct{}, len(worldOrder))
	for _, id := range worldOrder {
		present[id] = struct{}{}
	}
	uniq := dedupePreserveOrder(chosen)
	miss := []string{}
	for _, id := range uniq {
		if _, ok := present[id]; !ok {
			miss = append(miss, id)
		}
	}
	if len(miss) > 0 {
		return nil, miss
	}
	return orderByKeyOrder(uniq, worldOrder), nil
}

func dedupePreserveOrder(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, raw := range in {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

// orderByKeyOrder 返回 subset 按 reference 顺序排列的结果；subset 必须都是 reference 成员。
func orderByKeyOrder(subset, reference []string) []string {
	rank := make(map[string]int, len(reference))
	for i, id := range reference {
		rank[id] = i
	}
	out := append([]string{}, subset...)
	// 子集很小（≤30），插入排序即可，且对相等 rank 稳定。
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && rank[out[j-1]] > rank[out[j]]; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}

// canonicalSelectionWire 以固定字段顺序序列化归一化选择，供 contextFingerprint 使用。
type canonicalSelectionWire struct {
	IncludeTone      bool     `json:"includeTone"`
	RuleIndexes      []int    `json:"ruleIndexes"`
	CharacterIDs     []string `json:"characterIds"`
	LocationIDs      []string `json:"locationIds"`
	FactionIDs       []string `json:"factionIds"`
	TimelineEntryIDs []string `json:"timelineEntryIds"`
	BindingIDs       []string `json:"bindingIds"`
}

func (s Selection) wire() canonicalSelectionWire {
	ensure := func(v []string) []string {
		if v == nil {
			return []string{}
		}
		return v
	}
	ri := s.RuleIndexes
	if ri == nil {
		ri = []int{}
	}
	return canonicalSelectionWire{
		IncludeTone:      s.IncludeTone,
		RuleIndexes:      ri,
		CharacterIDs:     ensure(s.CharacterIDs),
		LocationIDs:      ensure(s.LocationIDs),
		FactionIDs:       ensure(s.FactionIDs),
		TimelineEntryIDs: ensure(s.TimelineEntryIDs),
		BindingIDs:       ensure(s.BindingIDs),
	}
}
