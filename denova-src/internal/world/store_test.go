package world

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func ctx() context.Context { return context.Background() }

func sampleInput() CreateInput {
	return CreateInput{
		Name:    "黑月大陆",
		Tagline: "长夜将至",
		Genre:   "奇幻",
		Summary: "测试世界",
		Bindings: []AssetBinding{{
			BindingID:    "b1",
			MasterItemID: "master-1",
			RecordKind:   CharacterTemplate,
			SemanticType: SemanticCharacter,
			NameSnapshot: "卡蕾妮",
			TagsSnapshot: []string{"主角"},
			BoundAt:      "2026-09-08T00:00:00Z",
		}},
		Characters: []Character{{
			ID: "c1", BindingID: "b1", DisplayName: "卡蕾妮", Role: RoleProtagonist,
		}},
		Locations: []Location{{ID: "l1", Name: "灰港"}},
		Factions:  []Faction{{ID: "f1", Name: "守夜人"}},
		Timeline:  []TimelineEntry{{ID: "t1", Order: 1, Title: "长夜开端"}},
	}
}

func TestCreateGetRoundtrip(t *testing.T) {
	s := NewStore(t.TempDir())
	w, rev, err := s.Create(ctx(), sampleInput())
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !ValidWorldID(w.ID) {
		t.Fatalf("server id invalid: %q", w.ID)
	}
	if !strings.HasPrefix(rev, "sha256:") {
		t.Fatalf("revision not content hash: %q", rev)
	}
	if w.Status != StatusActive || w.CreatedAt == "" || w.UpdatedAt == "" {
		t.Fatalf("bad defaults: %+v", w)
	}
	got, gotRev, err := s.Get(ctx(), w.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if gotRev != rev {
		t.Fatalf("revision mismatch %q vs %q", gotRev, rev)
	}
	if got.Name != "黑月大陆" || got.Tagline != "长夜将至" {
		t.Fatalf("UTF-8 world text changed after roundtrip: name=%q tagline=%q", got.Name, got.Tagline)
	}
	if len(got.Bindings) != 1 || len(got.Characters) != 1 || got.Characters[0].BindingID != "b1" {
		t.Fatalf("binding/character not persisted atomically: %+v", got)
	}
	sum := SummaryOf(got)
	if sum.CharacterCount != 1 || sum.LocationCount != 1 || sum.FactionCount != 1 || sum.TimelineCount != 1 {
		t.Fatalf("summary counts wrong: %+v", sum)
	}
}

func TestListScansAndFilters(t *testing.T) {
	s := NewStore(t.TempDir())
	w1, _, err := s.Create(ctx(), sampleInput())
	if err != nil {
		t.Fatal(err)
	}
	in2 := sampleInput()
	in2.Name = "第二世界"
	w2, _, err := s.Create(ctx(), in2)
	if err != nil {
		t.Fatal(err)
	}
	res, err := s.List(ctx(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Worlds) != 2 || len(res.Warnings) != 0 {
		t.Fatalf("list = %+v", res)
	}
	// 归档 w1 后，active 过滤只剩 w2。
	if _, _, err := s.Archive(ctx(), w1.ID, mustRev(t, s, w1.ID), true); err != nil {
		t.Fatal(err)
	}
	active, err := s.List(ctx(), StatusActive)
	if err != nil {
		t.Fatal(err)
	}
	if len(active.Worlds) != 1 || active.Worlds[0].ID != w2.ID {
		t.Fatalf("active filter wrong: %+v", active.Worlds)
	}
}

func TestReplaceCAS(t *testing.T) {
	s := NewStore(t.TempDir())
	w, rev, err := s.Create(ctx(), sampleInput())
	if err != nil {
		t.Fatal(err)
	}
	createdAt := w.CreatedAt
	// 错误基 revision → 冲突。
	if _, _, err := s.Replace(ctx(), w.ID, "sha256:deadbeef", w); !errors.Is(err, ErrConflict) {
		t.Fatalf("want conflict, got %v", err)
	}
	w.Summary = "更新后的概述"
	updated, newRev, err := s.Replace(ctx(), w.ID, rev, w)
	if err != nil {
		t.Fatalf("replace: %v", err)
	}
	if newRev == rev {
		t.Fatal("revision should change after replace")
	}
	if updated.CreatedAt != createdAt {
		t.Fatal("createdAt must be preserved")
	}
	if updated.UpdatedAt == w.UpdatedAt {
		t.Fatal("updatedAt should refresh")
	}
}

func TestReplaceAndArchiveRequireRevision(t *testing.T) {
	s := NewStore(t.TempDir())
	w, _, err := s.Create(ctx(), sampleInput())
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Replace(ctx(), w.ID, "", w); err == nil {
		t.Fatal("replace without expected revision must fail")
	} else if validation, ok := err.(*ValidationError); !ok || validation.Field != "expected_revision" {
		t.Fatalf("replace error = %T %v", err, err)
	}
	if _, _, err := s.Archive(ctx(), w.ID, "", true); err == nil {
		t.Fatal("archive without expected revision must fail")
	} else if validation, ok := err.(*ValidationError); !ok || validation.Field != "expected_revision" {
		t.Fatalf("archive error = %T %v", err, err)
	}
}

func TestArchiveRestoreCAS(t *testing.T) {
	s := NewStore(t.TempDir())
	w, rev, _ := s.Create(ctx(), sampleInput())
	arch, _, err := s.Archive(ctx(), w.ID, rev, true)
	if err != nil {
		t.Fatal(err)
	}
	if arch.Status != StatusArchived {
		t.Fatalf("not archived: %+v", arch)
	}
	// 旧 revision 再操作应冲突。
	if _, _, err := s.Archive(ctx(), w.ID, rev, false); !errors.Is(err, ErrConflict) {
		t.Fatalf("want conflict on stale archive, got %v", err)
	}
}

func TestGetMissingAndInvalidID(t *testing.T) {
	s := NewStore(t.TempDir())
	if _, _, err := s.Get(ctx(), "0123456789abcdef"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want not found, got %v", err)
	}
	if _, _, err := s.Get(ctx(), "../escape"); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("want invalid id, got %v", err)
	}
}

func TestCorruptFileProducesWarning(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	good, _, err := s.Create(ctx(), sampleInput())
	if err != nil {
		t.Fatal(err)
	}
	// 注入一个损坏文件，id 仍符合服务端格式。
	badPath := filepath.Join(s.Root(), "world-"+"abcdef0123456789"+".json")
	if err := os.WriteFile(badPath, []byte("{not-json"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := s.List(ctx(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Worlds) != 1 || res.Worlds[0].ID != good.ID {
		t.Fatalf("valid world should survive: %+v", res.Worlds)
	}
	if len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0].Reason, "损坏") {
		t.Fatalf("want corrupt warning, got %+v", res.Warnings)
	}
	// 单取损坏文件：返回非 NotFound 的错误（映射 500）。
	if _, _, err := s.Get(ctx(), "abcdef0123456789"); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("want corrupt error, got %v", err)
	} else if strings.Contains(err.Error(), s.Root()) {
		t.Fatalf("corrupt error leaked storage path: %v", err)
	}
}

func TestSemanticallyInvalidFileProducesWarning(t *testing.T) {
	s := NewStore(t.TempDir())
	if err := os.MkdirAll(s.Root(), 0o755); err != nil {
		t.Fatal(err)
	}
	id := "abcdef0123456789"
	if err := os.WriteFile(filepath.Join(s.Root(), "world-"+id+".json"), []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := s.List(ctx(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Worlds) != 0 || len(res.Warnings) != 1 {
		t.Fatalf("semantic corruption must be a warning: %+v", res)
	}
	if _, _, err := s.Get(ctx(), id); err == nil {
		t.Fatal("semantic corruption must fail direct get")
	}
}

func TestValidationReferentialAndLimits(t *testing.T) {
	s := NewStore(t.TempDir())
	// 角色引用不存在的绑定。
	bad := sampleInput()
	bad.Bindings = nil
	if _, _, err := s.Create(ctx(), bad); err == nil {
		t.Fatal("expected referential error for dangling bindingId")
	} else if _, ok := err.(*ValidationError); !ok {
		t.Fatalf("want ValidationError, got %T %v", err, err)
	}
	// 重复 bindingId。
	dup := sampleInput()
	dup.Bindings = append(dup.Bindings, dup.Bindings[0])
	if _, _, err := s.Create(ctx(), dup); err == nil {
		t.Fatal("expected duplicate bindingId error")
	}
	// 名称为空。
	noname := sampleInput()
	noname.Name = "   "
	if _, _, err := s.Create(ctx(), noname); err == nil {
		t.Fatal("expected name required error")
	}
	// 非法枚举。
	badEnum := sampleInput()
	badEnum.Bindings[0].SemanticType = "not-a-type"
	if _, _, err := s.Create(ctx(), badEnum); err == nil {
		t.Fatal("expected enum error")
	}
	// 角色只能引用角色模板，不能把地点/设定绑定实例化为角色。
	wrongCharacterBinding := sampleInput()
	wrongCharacterBinding.Bindings[0].RecordKind = LorebookTemplate
	wrongCharacterBinding.Bindings[0].SemanticType = SemanticLocation
	if _, _, err := s.Create(ctx(), wrongCharacterBinding); err == nil {
		t.Fatal("expected character binding type error")
	}
}

func TestBindingMasterRevision(t *testing.T) {
	// 旧世界绑定没有 masterRevision：读取为空（尚未检查），不产生 warning、不算损坏。
	t.Run("legacy empty masterRevision stays valid", func(t *testing.T) {
		s := NewStore(t.TempDir())
		w, _, err := s.Create(ctx(), sampleInput())
		if err != nil {
			t.Fatal(err)
		}
		got, _, err := s.Get(ctx(), w.ID)
		if err != nil {
			t.Fatalf("legacy world should load: %v", err)
		}
		if got.Bindings[0].MasterRevision != "" {
			t.Fatalf("legacy binding masterRevision want empty, got %q", got.Bindings[0].MasterRevision)
		}
		res, err := s.List(ctx(), "")
		if err != nil {
			t.Fatal(err)
		}
		if len(res.Warnings) != 0 {
			t.Fatalf("legacy file must not warn: %+v", res.Warnings)
		}
	})
	// 新绑定带 masterRevision：Create→Get 往返保留，并可经 CAS 再次保存。
	t.Run("masterRevision roundtrip and CAS", func(t *testing.T) {
		s := NewStore(t.TempDir())
		in := sampleInput()
		in.Bindings[0].MasterRevision = "sha256:0123456789abcdef"
		w, rev, err := s.Create(ctx(), in)
		if err != nil {
			t.Fatal(err)
		}
		got, _, err := s.Get(ctx(), w.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.Bindings[0].MasterRevision != "sha256:0123456789abcdef" {
			t.Fatalf("masterRevision lost: %q", got.Bindings[0].MasterRevision)
		}
		if _, _, err := s.Replace(ctx(), w.ID, rev, got); err != nil {
			t.Fatalf("CAS replace carrying masterRevision failed: %v", err)
		}
	})
	// masterRevision 超过上限：校验失败（映射 400）；空串合法已在上面两个用例覆盖。
	t.Run("oversized masterRevision rejected", func(t *testing.T) {
		s := NewStore(t.TempDir())
		in := sampleInput()
		in.Bindings[0].MasterRevision = strings.Repeat("x", maxMasterRev+1)
		if _, _, err := s.Create(ctx(), in); err == nil {
			t.Fatal("expected masterRevision length error")
		} else if ve, ok := err.(*ValidationError); !ok || !strings.Contains(ve.Field, "masterRevision") {
			t.Fatalf("want masterRevision ValidationError, got %T %v", err, err)
		}
	})
}

func mustRev(t *testing.T, s *Store, id string) string {
	t.Helper()
	_, rev, err := s.Get(ctx(), id)
	if err != nil {
		t.Fatal(err)
	}
	return rev
}
