package world

import (
	"errors"
	"strings"
	"testing"
)

// wantValidationFail 断言创建失败且为 ValidationError。
func wantValidationFail(t *testing.T, s *Store, in CreateInput, msg string) {
	t.Helper()
	if _, _, err := s.Create(ctx(), in); err == nil {
		t.Fatalf("%s: expected validation error, got nil", msg)
	} else if _, ok := err.(*ValidationError); !ok {
		t.Fatalf("%s: want ValidationError, got %T %v", msg, err, err)
	}
}

// 旧绑定没有 scope：实体语义（character）被引用即合法，世界语义（rule）零引用也合法，读取不判损坏。
func TestScopeLegacyMissingScopeCompatible(t *testing.T) {
	s := NewStore(t.TempDir())
	in := sampleInput()
	// 额外挂一个无 scope 的世界语义绑定（lorebook_template + rule），零实体引用也必须保留。
	in.Bindings = append(in.Bindings, AssetBinding{
		BindingID: "bw1", MasterItemID: "master-rule", RecordKind: LorebookTemplate,
		SemanticType: SemanticRule, NameSnapshot: "世界规则", BoundAt: "2026-09-10T00:00:00Z",
	})
	w, _, err := s.Create(ctx(), in)
	if err != nil {
		t.Fatalf("legacy mixed-scope create: %v", err)
	}
	got, _, err := s.Get(ctx(), w.ID)
	if err != nil {
		t.Fatalf("legacy get: %v", err)
	}
	if len(got.Bindings) != 2 {
		t.Fatalf("world-scoped binding must be retained, got %d", len(got.Bindings))
	}
	res, err := s.List(ctx(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Warnings) != 0 {
		t.Fatalf("legacy missing-scope must not warn: %+v", res.Warnings)
	}
}

// 显式 entity 作用域绑定若没有任何实体引用，不允许持久化。
func TestScopeEntityWithoutReferenceRejected(t *testing.T) {
	s := NewStore(t.TempDir())
	in := sampleInput()
	in.Bindings = append(in.Bindings, AssetBinding{
		BindingID: "be1", MasterItemID: "master-loc-x", RecordKind: LorebookTemplate,
		SemanticType: SemanticLocation, Scope: ScopeEntity, NameSnapshot: "无人引用的地点",
		BoundAt: "2026-09-10T00:00:00Z",
	})
	wantValidationFail(t, s, in, "entity scope without reference")
}

// 显式 world 作用域绑定零实体引用也保留。
func TestScopeWorldZeroReferenceKept(t *testing.T) {
	s := NewStore(t.TempDir())
	in := sampleInput()
	in.Bindings = append(in.Bindings, AssetBinding{
		BindingID: "bw2", MasterItemID: "master-lore", RecordKind: LorebookTemplate,
		SemanticType: SemanticWorld, Scope: ScopeWorld, NameSnapshot: "世界设定集",
		BoundAt: "2026-09-10T00:00:00Z",
	})
	w, _, err := s.Create(ctx(), in)
	if err != nil {
		t.Fatalf("world scope zero-ref create: %v", err)
	}
	got, _, err := s.Get(ctx(), w.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	var found bool
	for _, b := range got.Bindings {
		if b.BindingID == "bw2" {
			found = true
		}
	}
	if !found {
		t.Fatal("world-scoped binding disappeared despite zero entity reference")
	}
}

// 同一 masterItemId 只允许一个绑定。
func TestScopeDuplicateMasterItemRejected(t *testing.T) {
	s := NewStore(t.TempDir())
	in := sampleInput()
	in.Bindings = append(in.Bindings, AssetBinding{
		BindingID: "bw3", MasterItemID: "master-1", RecordKind: LorebookTemplate,
		SemanticType: SemanticRule, Scope: ScopeWorld, NameSnapshot: "重复来源",
		BoundAt: "2026-09-10T00:00:00Z",
	})
	wantValidationFail(t, s, in, "duplicate masterItemId")
}

// 非法 scope 枚举拒绝。
func TestScopeIllegalValueRejected(t *testing.T) {
	s := NewStore(t.TempDir())
	in := sampleInput()
	in.Bindings[0].Scope = BindingScope("global")
	wantValidationFail(t, s, in, "illegal scope")
}

// 地点/势力只能绑定对应语义的顶层资产；语义不匹配拒绝。
func TestScopeLocationFactionSemanticMatch(t *testing.T) {
	s := NewStore(t.TempDir())

	// 合法：location 绑定 location 语义资产并被地点引用。
	ok := sampleInput()
	ok.Bindings = append(ok.Bindings, AssetBinding{
		BindingID: "bl1", MasterItemID: "master-loc", RecordKind: LorebookTemplate,
		SemanticType: SemanticLocation, Scope: ScopeEntity, NameSnapshot: "灰港总库",
		BoundAt: "2026-09-10T00:00:00Z",
	})
	ok.Locations = append(ok.Locations, Location{ID: "l2", Name: "灰港总库", BindingID: "bl1"})
	if _, _, err := s.Create(ctx(), ok); err != nil {
		t.Fatalf("location semantic match should pass: %v", err)
	}

	// 非法：地点引用了 rule 语义绑定。
	badLoc := sampleInput()
	badLoc.Bindings = append(badLoc.Bindings, AssetBinding{
		BindingID: "blx", MasterItemID: "master-rule2", RecordKind: LorebookTemplate,
		SemanticType: SemanticRule, Scope: ScopeEntity, NameSnapshot: "规则",
		BoundAt: "2026-09-10T00:00:00Z",
	})
	badLoc.Locations = append(badLoc.Locations, Location{ID: "l3", Name: "错绑地点", BindingID: "blx"})
	wantValidationFail(t, s, badLoc, "location bound to rule semantic")

	// 非法：势力引用了 location 语义绑定。
	badFac := sampleInput()
	badFac.Bindings = append(badFac.Bindings, AssetBinding{
		BindingID: "bfx", MasterItemID: "master-loc3", RecordKind: LorebookTemplate,
		SemanticType: SemanticLocation, Scope: ScopeEntity, NameSnapshot: "地点",
		BoundAt: "2026-09-10T00:00:00Z",
	})
	badFac.Factions = append(badFac.Factions, Faction{ID: "f2", Name: "错绑势力", BindingID: "bfx"})
	wantValidationFail(t, s, badFac, "faction bound to location semantic")
}

// 携带显式 scope 的世界经 CAS 再次保存：错误基 revision 冲突，正确基成功。
func TestScopeCARoundtrip(t *testing.T) {
	s := NewStore(t.TempDir())
	in := sampleInput()
	in.Bindings[0].Scope = ScopeEntity
	w, rev, err := s.Create(ctx(), in)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Replace(ctx(), w.ID, "sha256:stale", w); !errors.Is(err, ErrConflict) {
		t.Fatalf("want CAS conflict, got %v", err)
	}
	w.Summary = "带 scope 的更新"
	updated, _, err := s.Replace(ctx(), w.ID, rev, w)
	if err != nil {
		t.Fatalf("CAS replace with scope failed: %v", err)
	}
	if updated.Bindings[0].Scope != ScopeEntity {
		t.Fatalf("scope lost after replace: %q", updated.Bindings[0].Scope)
	}
	if !strings.Contains(updated.Summary, "更新") {
		t.Fatalf("update not applied: %q", updated.Summary)
	}
}

func TestEffectiveBindingScopeDerivation(t *testing.T) {
	cases := []struct {
		name string
		b    AssetBinding
		want BindingScope
	}{
		{"explicit entity wins", AssetBinding{Scope: ScopeEntity, SemanticType: SemanticRule}, ScopeEntity},
		{"explicit world wins", AssetBinding{Scope: ScopeWorld, SemanticType: SemanticCharacter}, ScopeWorld},
		{"legacy character derives entity", AssetBinding{SemanticType: SemanticCharacter}, ScopeEntity},
		{"legacy location derives entity", AssetBinding{SemanticType: SemanticLocation}, ScopeEntity},
		{"legacy faction derives entity", AssetBinding{SemanticType: SemanticFaction}, ScopeEntity},
		{"legacy rule derives world", AssetBinding{SemanticType: SemanticRule}, ScopeWorld},
		{"legacy world derives world", AssetBinding{SemanticType: SemanticWorld}, ScopeWorld},
		{"legacy other derives world", AssetBinding{SemanticType: SemanticOther}, ScopeWorld},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := effectiveBindingScope(c.b); got != c.want {
				t.Fatalf("effectiveBindingScope = %q, want %q", got, c.want)
			}
		})
	}
}
