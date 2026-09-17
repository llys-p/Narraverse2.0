package library

import (
	"strings"
	"testing"

	"denova/internal/book"
)

// 词表契约测试：保护“设定库扩展类型不吞掉旧 Lore 基础类型”、
// “档位/重要度只有一套实现”，以及新增类型必须双向同步（枚举/校验）。

// 基础类型必须与旧 Lore 词表逐项一致：设定库不得悄悄改变旧类型语义。
func TestBaseTypesMatchLoreVocabulary(t *testing.T) {
	for _, base := range BaseItemTypes() {
		if got := book.NormalizeLoreType(base); got != base {
			t.Fatalf("基础类型 %q 应与旧 Lore 词表一致，归一化得到 %q", base, got)
		}
	}
	// 任意未知类型在旧词表里回落 other；设定库必须保留这一行为（除自有扩展类型外）。
	if got := normalizeItemType("no-such-type"); got != TypeOther {
		t.Fatalf("未知类型应回落 other，got %q", got)
	}
	// 自有扩展类型不得被旧词表吞掉。
	for _, extended := range []string{TypeEvent, TypeAbility} {
		if got := normalizeItemType(extended); got != extended {
			t.Fatalf("扩展类型 %q 必须被保留，got %q", extended, got)
		}
		for _, base := range BaseItemTypes() {
			if extended == base {
				t.Fatalf("扩展类型 %q 与基础类型冲突", extended)
			}
		}
	}
}

// 档位：三档字面量与旧 Lore 常量同源；严格归一化不因重要度升级。
func TestLoadModeVocabularyIsSharedAndStrict(t *testing.T) {
	if LoadModeResident != book.LoreLoadModeResident ||
		LoadModeAuto != book.LoreLoadModeAuto ||
		LoadModeManual != book.LoreLoadModeManual {
		t.Fatal("三档字面量必须复用 book 常量，避免出现第二套档位词表")
	}
	if got := book.NormalizeLoreLoadModeStrict(""); got != LoadModeAuto {
		t.Fatalf("空档位应回落按需，got %q", got)
	}
	for _, mode := range AllLoadModes() {
		if got := book.NormalizeLoreLoadModeStrict(mode); got != mode {
			t.Fatalf("档位 %q 不应被改写，got %q", mode, got)
		}
	}
}

// 全部词表都必须非空、无重复、无空白项：它们会被序列化进库文件，脏值无法回滚。
func TestVocabularyListsAreClean(t *testing.T) {
	lists := map[string][]string{
		"AllItemTypes":        AllItemTypes(),
		"AllLoadModes":        AllLoadModes(),
		"AllImportanceLevels": AllImportanceLevels(),
		"AllOrigins":          AllOrigins(),
		"AllSourceKinds":      AllSourceKinds(),
		"AllRelationKinds":    AllRelationKinds(),
		"AllEventCategories":  AllEventCategories(),
		"AllPurposes":         AllPurposes(),
	}
	for name, values := range lists {
		if len(values) == 0 {
			t.Fatalf("%s 不能为空", name)
		}
		seen := map[string]bool{}
		for _, value := range values {
			if strings.TrimSpace(value) != value || value == "" {
				t.Fatalf("%s 含空白项: %q", name, value)
			}
			if seen[value] {
				t.Fatalf("%s 含重复项: %q", name, value)
			}
			seen[value] = true
		}
	}
	if len(AllItemTypes()) != len(BaseItemTypes())+2 {
		t.Fatalf("完整类型集合应为 7 基础 + 2 扩展，got %d", len(AllItemTypes()))
	}
}

// 每个类型/档位/来源形态/关系类型/事件类别都必须能被校验器接受，
// 否则“UI 能选但保存被拒”会成为静默的功能缺口。
func TestEveryVocabularyValueIsAcceptedByValidation(t *testing.T) {
	store := newTestStore(t)
	l, _ := mustCreateLibrary(t, store, "词表库")
	for _, itemType := range AllItemTypes() {
		in := ItemInput{Type: itemType, Name: "类型-" + itemType}
		if itemType == TypeEvent {
			in.Event = &EventDetail{Category: EventCategoryBackground}
		}
		if _, _, err := store.CreateItem(t.Context(), l.ID, in); err != nil {
			t.Fatalf("类型 %q 应可创建: %v", itemType, err)
		}
	}
	for _, mode := range AllLoadModes() {
		if _, _, err := store.CreateItem(t.Context(), l.ID, ItemInput{Type: TypeOther, Name: "档位-" + mode, LoadMode: mode}); err != nil {
			t.Fatalf("档位 %q 应可保存: %v", mode, err)
		}
	}
	for _, origin := range AllOrigins() {
		in := ItemInput{Type: TypeOther, Name: "来源形态-" + origin, Origin: origin}
		if origin == OriginReference {
			in.Source = &SourceRef{Kind: SourceKindMaster, ID: "m-1", Label: "原件"}
		}
		if _, _, err := store.CreateItem(t.Context(), l.ID, in); err != nil {
			t.Fatalf("来源形态 %q 应可保存: %v", origin, err)
		}
	}
	for _, kind := range AllSourceKinds() {
		if _, _, err := store.CreateItem(t.Context(), l.ID, ItemInput{
			Type: TypeOther, Name: "来源类型-" + kind,
			Source: &SourceRef{Kind: kind, Label: "来源"},
		}); err != nil {
			t.Fatalf("来源类型 %q 应可保存: %v", kind, err)
		}
	}
	for _, category := range AllEventCategories() {
		if _, _, err := store.CreateItem(t.Context(), l.ID, ItemInput{
			Type: TypeEvent, Name: "事件-" + category,
			Event: &EventDetail{Category: category},
		}); err != nil {
			t.Fatalf("事件类别 %q 应可保存: %v", category, err)
		}
	}
	for _, purpose := range AllPurposes() {
		if _, _, err := store.Create(t.Context(), CreateInput{Name: "用途-" + purpose, Purpose: purpose}); err != nil {
			t.Fatalf("用途 %q 应可保存: %v", purpose, err)
		}
	}
}
