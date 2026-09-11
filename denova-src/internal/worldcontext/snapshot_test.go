package worldcontext

import (
	"strings"
	"testing"

	"denova/internal/world"
)

func TestBuildSnapshot_ConsumerBoundary(t *testing.T) {
	sel := Selection{}
	for _, c := range []Consumer{ConsumerNarraverse, ConsumerModule4, Consumer("bogus")} {
		_, err := BuildSnapshot(c, baseRef(sel), testRevision, sampleWorld())
		if CodeOf(err) != ErrConsumerNotTrusted {
			t.Fatalf("consumer=%q 应 consumer_not_trusted，got %v", c, err)
		}
	}
}

func TestBuildSnapshot_RevisionShapeAndConflict(t *testing.T) {
	sel := Selection{}
	bad := []string{"", "nodeprefix", "sha256:with space", strings.Repeat("a", 101)}
	for _, rev := range bad {
		ref := baseRef(sel)
		ref.ExpectedWorldRevision = rev
		_, err := BuildSnapshot(ConsumerWriting, ref, testRevision, sampleWorld())
		if CodeOf(err) != ErrInvalidRequest {
			t.Fatalf("revision=%q 应 invalid_request，got %v", rev, err)
		}
	}
	// 形状合法但与当前不一致 → revision_conflict。
	ref := baseRef(sel)
	ref.ExpectedWorldRevision = "sha256:ffffffff"
	if _, err := BuildSnapshot(ConsumerWriting, ref, testRevision, sampleWorld()); CodeOf(err) != ErrRevisionConflict {
		t.Fatalf("版本不一致应 revision_conflict，got %v", err)
	}
}

func TestBuildSnapshot_ArchivedRejected(t *testing.T) {
	w := sampleWorld()
	w.Status = world.StatusArchived
	_, err := BuildSnapshot(ConsumerGame, baseRef(Selection{}), testRevision, w)
	if CodeOf(err) != ErrWorldArchived {
		t.Fatalf("归档世界应 world_archived，got %v", err)
	}
}

func TestBuildSnapshot_CrossWorld(t *testing.T) {
	ref := baseRef(Selection{})
	ref.WorldID = "anotherworld"
	_, err := BuildSnapshot(ConsumerWriting, ref, testRevision, sampleWorld())
	if CodeOf(err) != ErrSelectionInvalid {
		t.Fatalf("跨世界应 selection_invalid，got %v", err)
	}
}

func TestBuildSnapshot_ClosureOmitsUnselectedRefs(t *testing.T) {
	// 只选 c1，不选 f1/l1/c2：faction/location/relationship 全部省略并记 omission。
	sel := Selection{CharacterIDs: []string{"c1"}}
	snap := mustBuild(t, ConsumerWriting, baseRef(sel), sampleWorld())

	if len(snap.Characters) != 1 {
		t.Fatalf("应只含 1 角色，got %d", len(snap.Characters))
	}
	c := snap.Characters[0]
	if c.FactionID != "" || c.LocationID != "" {
		t.Fatalf("未入选的 faction/location 必须清空，got %#v", c)
	}
	if len(c.Relationships) != 0 {
		t.Fatalf("未入选目标的关系边必须裁剪，got %#v", c.Relationships)
	}
	kinds := map[OmissionKind]bool{}
	for _, o := range snap.Omissions {
		kinds[o.Kind] = true
		if o.Reason != ReasonTargetNotSelected {
			t.Fatalf("目标存在但未入选应为 target_not_selected，got %q", o.Reason)
		}
	}
	for _, want := range []OmissionKind{OmissionCharacterFaction, OmissionCharacterLocation, OmissionRelationshipEdge} {
		if !kinds[want] {
			t.Fatalf("缺少 omission %s，实际 %#v", want, snap.Omissions)
		}
	}
}

func TestBuildSnapshot_ClosureKeepsSelectedRefs(t *testing.T) {
	sel := Selection{
		CharacterIDs: []string{"c1", "c2"}, LocationIDs: []string{"l1"}, FactionIDs: []string{"f1"},
	}
	snap := mustBuild(t, ConsumerWriting, baseRef(sel), sampleWorld())
	c := snap.Characters[0]
	if c.FactionID != "f1" || c.LocationID != "l1" || len(c.Relationships) != 1 ||
		c.Relationships[0].TargetCharacterID != "c2" {
		t.Fatalf("入选引用应保留，got %#v", c)
	}
	f := snap.Factions[0]
	if f.HeadquartersLocationID != "l1" {
		t.Fatalf("入选总部应保留，got %#v", f)
	}
	if len(snap.Omissions) != 0 {
		t.Fatalf("全部入选时不应有 omission，got %#v", snap.Omissions)
	}
}

func TestBuildSnapshot_EntityBindingAutoDerived(t *testing.T) {
	// 选 c1（挂 b-char）但不通过 bindingIds：实体绑定必须自动派生为 material。
	sel := Selection{CharacterIDs: []string{"c1"}}
	snap := mustBuild(t, ConsumerWriting, baseRef(sel), sampleWorld())
	if len(snap.Materials) != 1 || snap.Materials[0].BindingID != "b-char" {
		t.Fatalf("实体绑定应自动派生，got %#v", snap.Materials)
	}
	if snap.Materials[0].Scope != world.ScopeEntity {
		t.Fatalf("派生绑定 scope 应为 entity")
	}
}

func TestBuildSnapshot_Warnings(t *testing.T) {
	// t1 是 canon 旧值 → legacy_timeline_category；b-world 无 masterRevision → binding_unchecked。
	sel := Selection{TimelineEntryIDs: []string{"t1"}, BindingIDs: []string{"b-world"}}
	snap := mustBuild(t, ConsumerWriting, baseRef(sel), sampleWorld())
	codes := map[WarningCode]int{}
	for _, wn := range snap.Warnings {
		codes[wn.Code]++
	}
	if codes[WarningLegacyTimelineCategory] != 1 || codes[WarningBindingUnchecked] != 1 {
		t.Fatalf("warning 不符合预期，got %#v", snap.Warnings)
	}
	// timeline category 归一为 historical。
	if snap.Timeline[0].Category != world.TimelineHistorical {
		t.Fatalf("canon 应归一为 historical，got %q", snap.Timeline[0].Category)
	}
}

func TestBuildSnapshot_EmptyArraysAreNeverNil(t *testing.T) {
	snap := mustBuild(t, ConsumerWriting, baseRef(Selection{IncludeTone: false}), sampleWorld())
	for name, n := range map[string]int{
		"characters": len(snap.Characters), "locations": len(snap.Locations),
		"factions": len(snap.Factions), "timeline": len(snap.Timeline),
		"materials": len(snap.Materials), "omissions": len(snap.Omissions), "warnings": len(snap.Warnings),
	} {
		if n != 0 {
			t.Fatalf("%s 应为空", name)
		}
	}
	if anyNil(snap.Characters, snap.Locations, snap.Factions, snap.Timeline, snap.Materials, snap.Omissions, snap.Warnings) {
		t.Fatal("空集合必须是非 nil 切片")
	}
	if snap.Setting != nil {
		t.Fatal("未选 tone/规则时 setting 必须缺省")
	}
}

func anyNil(slices ...any) bool {
	for _, s := range slices {
		switch v := s.(type) {
		case []SnapshotCharacter:
			if v == nil {
				return true
			}
		case []SnapshotLocation:
			if v == nil {
				return true
			}
		case []SnapshotFaction:
			if v == nil {
				return true
			}
		case []SnapshotTimelineEntry:
			if v == nil {
				return true
			}
		case []SnapshotMaterial:
			if v == nil {
				return true
			}
		case []Omission:
			if v == nil {
				return true
			}
		case []SnapshotWarning:
			if v == nil {
				return true
			}
		}
	}
	return false
}

func TestBuildSnapshot_DeterministicFingerprint(t *testing.T) {
	sel := Selection{CharacterIDs: []string{"c1", "c2"}, IncludeTone: true, RuleIndexes: []int{0}}
	s1 := mustBuild(t, ConsumerWriting, baseRef(sel), sampleWorld())
	s2 := mustBuild(t, ConsumerWriting, baseRef(sel), sampleWorld())
	if s1.ContextFingerprint != s2.ContextFingerprint {
		t.Fatal("同输入 fingerprint 必须稳定")
	}
	if !strings.HasPrefix(s1.ContextFingerprint, "v1|") || len(s1.ContextFingerprint) != len("v1|")+32 {
		t.Fatalf("fingerprint 必须为 v1| + 32hex，got %q", s1.ContextFingerprint)
	}
	// consumer 参与 fingerprint。
	s3 := mustBuild(t, ConsumerGame, baseRef(sel), sampleWorld())
	if s3.ContextFingerprint == s1.ContextFingerprint {
		t.Fatal("不同 consumer 的 fingerprint 必须不同")
	}
}

func TestBuildSnapshot_FingerprintChangesWithRevision(t *testing.T) {
	sel := Selection{CharacterIDs: []string{"c1"}}
	revB := "sha256:2222222222222222222222222222222222222222222222222222222222222222"
	a := mustBuild(t, ConsumerWriting, baseRef(sel), sampleWorld())
	refB := baseRef(sel)
	refB.ExpectedWorldRevision = revB
	b := mustBuildAt(t, ConsumerWriting, refB, revB, sampleWorld())
	if a.ContextFingerprint == b.ContextFingerprint {
		t.Fatal("不同 worldRevision 的 fingerprint 必须不同")
	}
}
