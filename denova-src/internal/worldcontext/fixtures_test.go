package worldcontext

import (
	"denova/internal/world"
)

const (
	testRevision = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	testWorldID  = "worldtest0001"
)

func ptrInt(v int) *int { return &v }

// sampleWorld 构建覆盖闭包/警告/绑定派生的世界：
//
//	c1 主角：绑定 b-char（有 masterRevision），引用势力 f1、地点 l1、关系目标 c2；
//	c2 配角：无绑定；f1 势力：总部 l1；l1/l2 地点；
//	t1 历史(canon 旧值→legacy warning)、t2 planned；
//	b-world 世界资料（无 masterRevision→binding_unchecked）。
func sampleWorld() world.World {
	return world.World{
		ID:            testWorldID,
		SchemaVersion: world.SchemaVersion,
		Name:          "测试世界",
		Tagline:       "一个用于测试的世界",
		Genre:         "奇幻",
		Summary:       "摘要",
		Status:        world.StatusActive,
		WorldSetting: &world.WorldSetting{
			Tone:  "冷峻",
			Rules: []string{"规则甲", "规则乙"},
		},
		Bindings: []world.AssetBinding{
			{
				BindingID: "b-char", MasterItemID: "m-char-1",
				RecordKind: world.CharacterTemplate, SemanticType: world.SemanticCharacter,
				NameSnapshot: "角色卡", TagsSnapshot: []string{"主角"},
				MasterRevision: "sha256:aaa", Scope: world.ScopeEntity, BoundAt: "2026-09-11T00:00:00Z",
			},
			{
				BindingID: "b-world", MasterItemID: "m-world-1",
				RecordKind: world.LorebookTemplate, SemanticType: world.SemanticOther,
				NameSnapshot: "世界设定集", TagsSnapshot: []string{"lore"},
				MasterRevision: "", Scope: world.ScopeWorld, BoundAt: "2026-09-11T00:00:00Z",
			},
		},
		Characters: []world.Character{
			{
				ID: "c1", BindingID: "b-char", DisplayName: "林一", Role: world.RoleProtagonist,
				FactionID: "f1", LocationID: "l1", WorldNote: "主角备注",
				Relationships: []world.Relationship{{TargetCharacterID: "c2", Label: "挚友"}},
			},
			{ID: "c2", DisplayName: "陈二", Role: world.RoleMajor},
		},
		Locations: []world.Location{
			{ID: "l1", Name: "北境城", Description: "寒冷", Tags: []string{"都城"}},
			{ID: "l2", Name: "南境港"},
		},
		Factions: []world.Faction{
			{ID: "f1", Name: "白塔", Influence: ptrInt(60), Stability: ptrInt(40), HeadquartersLocationID: "l1"},
		},
		Timeline: []world.TimelineEntry{
			{ID: "t1", Order: 0, Title: "旧纪元", Category: world.TimelineCanon},
			{ID: "t2", Order: 1, Title: "新征程", Category: world.TimelinePlanned},
		},
		CreatedAt: "2026-09-10T00:00:00Z",
		UpdatedAt: "2026-09-11T00:00:00Z",
	}
}

func baseRef(sel Selection) Ref {
	return Ref{WorldID: testWorldID, ExpectedWorldRevision: testRevision, Selection: sel}
}

func mustBuild(t testingT, consumer Consumer, ref Ref, w world.World) *Snapshot {
	t.Helper()
	return mustBuildAt(t, consumer, ref, testRevision, w)
}

func mustBuildAt(t testingT, consumer Consumer, ref Ref, currentRevision string, w world.World) *Snapshot {
	t.Helper()
	snap, err := BuildSnapshot(consumer, ref, currentRevision, w)
	if err != nil {
		t.Fatalf("BuildSnapshot 意外失败: %v", err)
	}
	return snap
}

// testingT 是 testing.T 的最小接口，避免在 helper 签名里重复 import 名冲突。
type testingT interface {
	Helper()
	Fatalf(format string, args ...any)
	Errorf(format string, args ...any)
}
