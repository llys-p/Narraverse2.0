package library

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// L1.1 契约测试：库身份、稳定 ID、库级/条目级并发、来源引用、三档、关系引用、
// 事件与时间线同源、删除影响、存储位置与原子保存。
// 每个用例都对着 docs/plans/LIBRARY_L1_DATA_CONTRACT.md 的具体条款。

func newTestStore(t *testing.T) *Store {
	t.Helper()
	return NewStore(t.TempDir())
}

func strPtr(v string) *string { return &v }

func mustCreateLibrary(t *testing.T, store *Store, name string) (Library, string) {
	t.Helper()
	l, rev, err := store.Create(context.Background(), CreateInput{Name: name})
	if err != nil {
		t.Fatalf("创建库失败: %v", err)
	}
	return l, rev
}

func mustCreateItem(t *testing.T, store *Store, libraryID string, in ItemInput) Item {
	t.Helper()
	item, _, err := store.CreateItem(context.Background(), libraryID, in)
	if err != nil {
		t.Fatalf("创建条目失败: %v", err)
	}
	return item
}

// §2 库身份与存储位置：库落在全局数据目录下的 libraries/，与任何 workspace 无关。
func TestStorePersistsLibraryOutsideWorkspace(t *testing.T) {
	dataDir := t.TempDir()
	store := NewStore(dataDir)
	l, rev := mustCreateLibrary(t, store, "水浒原著资料")
	if !ValidLibraryID(l.ID) {
		t.Fatalf("服务端应生成合法库 id，got %q", l.ID)
	}
	if rev == "" || rev == "missing" {
		t.Fatalf("创建应返回内容 revision，got %q", rev)
	}
	path := filepath.Join(dataDir, "libraries", "library-"+l.ID+".json")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("库文件应写在 <dataDir>/libraries 下: %v", err)
	}
	if strings.Contains(path, ".denova") {
		t.Fatal("库不得落在某本书的 workspace 私有目录")
	}

	// 重启语义：换一个 Store 读同一目录，数据仍在且 revision 不变。
	reopened := NewStore(dataDir)
	got, rev2, err := reopened.Get(context.Background(), l.ID)
	if err != nil {
		t.Fatalf("重启后读取失败: %v", err)
	}
	if rev2 != rev {
		t.Fatalf("未修改时 revision 应稳定: %q -> %q", rev, rev2)
	}
	if got.Name != "水浒原著资料" || got.Purpose != PurposeAny || got.SchemaVersion != SchemaVersion {
		t.Fatalf("重启后库元信息不一致: %+v", got)
	}
	list, err := reopened.List(context.Background())
	if err != nil || len(list.Libraries) != 1 {
		t.Fatalf("重启后列表应有 1 个库: %+v err=%v", list.Libraries, err)
	}
	if list.Libraries[0].ItemCount != 0 || list.Libraries[0].EventCount != 0 {
		t.Fatalf("空库计数应为 0: %+v", list.Libraries[0])
	}
}

// §4 同名条目：名称只作展示，引用一律走稳定 ID。
func TestSameNameItemsAreDistinguishedByStableID(t *testing.T) {
	store := newTestStore(t)
	l, _ := mustCreateLibrary(t, store, "库")
	ctx := context.Background()

	first := mustCreateItem(t, store, l.ID, ItemInput{Type: TypeCharacter, Name: "林冲", Content: strPtr("八十万禁军教头")})
	second := mustCreateItem(t, store, l.ID, ItemInput{Type: TypeCharacter, Name: "林冲", Content: strPtr("另一个平行世界的林冲")})

	if first.ID == second.ID {
		t.Fatalf("同名条目必须由 ID 区分，got 同一个 ID %q", first.ID)
	}
	got, _, err := store.Get(ctx, l.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Items) != 2 {
		t.Fatalf("同名条目都应保留: %+v", got.Items)
	}
	byID := map[string]Item{}
	for _, item := range got.Items {
		byID[item.ID] = item
	}
	if byID[first.ID].Content != "八十万禁军教头" || byID[second.ID].Content != "另一个平行世界的林冲" {
		t.Fatalf("两条同名条目的正文不得互相覆盖: %+v", byID)
	}
}

// §4 稳定 ID：改名不改 ID，引用继续指向同一条目。
func TestRenameKeepsItemID(t *testing.T) {
	store := newTestStore(t)
	l, _ := mustCreateLibrary(t, store, "库")
	item := mustCreateItem(t, store, l.ID, ItemInput{Type: TypeCharacter, Name: "林冲"})

	renamed, _, err := store.UpdateItem(context.Background(), l.ID, ItemInput{ID: item.ID, Name: "豹子头林冲"})
	if err != nil {
		t.Fatalf("改名失败: %v", err)
	}
	if renamed.ID != item.ID {
		t.Fatalf("改名不得改变 ID: %q -> %q", item.ID, renamed.ID)
	}
	if renamed.CreatedAt != item.CreatedAt {
		t.Fatalf("改名不得改变创建时间: %q -> %q", item.CreatedAt, renamed.CreatedAt)
	}
	if renamed.UpdatedAt == item.UpdatedAt {
		t.Fatal("改名必须推进 updatedAt（条目级并发基线）")
	}
}

// §4 省略字段不清空正文：只有显式提交空串才清空。
func TestOmittedContentIsPreservedExplicitEmptyClears(t *testing.T) {
	store := newTestStore(t)
	l, _ := mustCreateLibrary(t, store, "库")
	ctx := context.Background()
	item := mustCreateItem(t, store, l.ID, ItemInput{
		Type: TypeCharacter, Name: "林冲", Content: strPtr("原文"), BriefDescription: strPtr("简介"),
	})

	// 只改档位，不提交正文 → 正文保持
	updated, _, err := store.UpdateItem(ctx, l.ID, ItemInput{ID: item.ID, LoadMode: LoadModeResident})
	if err != nil {
		t.Fatalf("更新失败: %v", err)
	}
	if updated.Content != "原文" || updated.BriefDescription != "简介" {
		t.Fatalf("省略正文时不得清空: %+v", updated)
	}
	if updated.LoadMode != LoadModeResident {
		t.Fatalf("档位应更新为常驻: %q", updated.LoadMode)
	}

	// 显式提交空串 → 清空
	cleared, _, err := store.UpdateItem(ctx, l.ID, ItemInput{ID: item.ID, Content: strPtr("")})
	if err != nil {
		t.Fatalf("清空失败: %v", err)
	}
	if cleared.Content != "" {
		t.Fatalf("显式空串应清空正文，got %q", cleared.Content)
	}
}

// §5 并发：库级 CAS 冲突 → 409；条目级 baseUpdatedAt 冲突 → 409。
func TestConcurrentSaveConflictsAreDetectable(t *testing.T) {
	store := newTestStore(t)
	l, rev := mustCreateLibrary(t, store, "库")
	ctx := context.Background()

	// 模拟两个编辑器：A 先保存成功，B 用过期的 revision 保存 → 冲突。
	if _, newRev, err := store.UpdateMeta(ctx, l.ID, rev, MetaPatchInput{Summary: strPtr("A 的修改")}); err != nil {
		t.Fatalf("A 保存应成功: %v", err)
	} else if newRev == rev {
		t.Fatal("元信息变更必须推进库级 revision")
	}
	_, _, err := store.UpdateMeta(ctx, l.ID, rev, MetaPatchInput{Summary: strPtr("B 的修改")})
	if !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("过期 revision 保存必须报并发冲突，got %v", err)
	}

	item := mustCreateItem(t, store, l.ID, ItemInput{Type: TypeItem, Name: "刀"})
	if _, _, err := store.UpdateItem(ctx, l.ID, ItemInput{ID: item.ID, Content: strPtr("A 的正文")}); err != nil {
		t.Fatalf("条目首次更新应成功: %v", err)
	}
	_, _, err = store.UpdateItem(ctx, l.ID, ItemInput{ID: item.ID, Content: strPtr("B 的正文"), BaseUpdatedAt: item.UpdatedAt})
	if !errors.Is(err, ErrItemRevisionConflict) {
		t.Fatalf("过期 baseUpdatedAt 必须报条目并发冲突，got %v", err)
	}
	// 冲突不得覆盖已保存内容
	got, _, _ := store.Get(ctx, l.ID)
	if got.Items[0].Content != "A 的正文" {
		t.Fatalf("冲突写入不得落盘: %+v", got.Items[0])
	}
}

// §5 原子保存：并发读改写不丢更新（同一文件的所有变更被串行化）。
func TestConcurrentItemCreatesDoNotLoseUpdates(t *testing.T) {
	store := newTestStore(t)
	l, _ := mustCreateLibrary(t, store, "并发库")
	ctx := context.Background()

	const writers = 12
	var wg sync.WaitGroup
	errs := make([]error, writers)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			_, _, err := store.CreateItem(ctx, l.ID, ItemInput{
				Type: TypeItem, Name: fmt.Sprintf("条目-%d", index),
			})
			errs[index] = err
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("并发创建第 %d 个条目失败: %v", i, err)
		}
	}
	got, _, err := store.Get(ctx, l.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Items) != writers {
		t.Fatalf("并发创建不得丢更新：期望 %d 条，实际 %d 条", writers, len(got.Items))
	}
	// 文件必须是完整可解析的 JSON（原子替换，不留半个文件）。
	raw, err := os.ReadFile(filepath.Join(store.Root(), "library-"+l.ID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var probe Library
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatalf("落盘文件必须是完整 JSON: %v", err)
	}
}

// §6 三档与重要度解耦：新条目默认按需，major 不自动常驻；非法档位回落按需。
func TestLoadModeDefaultsAndDecoupling(t *testing.T) {
	store := newTestStore(t)
	l, _ := mustCreateLibrary(t, store, "库")
	ctx := context.Background()

	plain := mustCreateItem(t, store, l.ID, ItemInput{Type: TypeOther, Name: "普通"})
	if plain.LoadMode != LoadModeAuto {
		t.Fatalf("新条目默认应为按需，got %q", plain.LoadMode)
	}
	major := mustCreateItem(t, store, l.ID, ItemInput{Type: TypeOther, Name: "重要", Importance: ImportanceMajor})
	if major.LoadMode != LoadModeAuto {
		t.Fatalf("major 不得自动升级为常驻，got %q", major.LoadMode)
	}
	bogus := mustCreateItem(t, store, l.ID, ItemInput{Type: TypeOther, Name: "非法档位", LoadMode: "sometimes"})
	if bogus.LoadMode != LoadModeAuto {
		t.Fatalf("未知档位应回落按需，got %q", bogus.LoadMode)
	}
	resident := mustCreateItem(t, store, l.ID, ItemInput{Type: TypeRule, Name: "核心规则", LoadMode: LoadModeResident})
	if resident.LoadMode != LoadModeResident {
		t.Fatalf("显式常驻必须保留，got %q", resident.LoadMode)
	}
	// 禁用是总开关，不是第四档。
	disabled := mustCreateItem(t, store, l.ID, ItemInput{Type: TypeOther, Name: "停用", Enabled: boolPtr(false), LoadMode: LoadModeManual})
	if disabled.Enabled || disabled.LoadMode != LoadModeManual {
		t.Fatalf("enabled=false 与档位应各自独立: %+v", disabled)
	}
	_ = ctx
}

func boolPtr(v bool) *bool { return &v }

// §4 来源引用：只读引用条目不得被本库改写正文；显式转为本地改编才可写。
func TestReferenceItemBodyIsReadOnlyUntilAdapted(t *testing.T) {
	store := newTestStore(t)
	l, _ := mustCreateLibrary(t, store, "库")
	ctx := context.Background()
	item := mustCreateItem(t, store, l.ID, ItemInput{
		Type:    TypeCharacter,
		Name:    "林冲",
		Origin:  OriginReference,
		Source:  &SourceRef{Kind: SourceKindMaster, ID: "master-1", Revision: "sha256:abc", Label: "原著角色卡"},
		Content: strPtr("原件正文"),
	})
	if item.Origin != OriginReference || item.Source == nil {
		t.Fatalf("只读引用条目应带来源: %+v", item)
	}

	// 改写正文 → 拒绝
	if _, _, err := store.UpdateItem(ctx, l.ID, ItemInput{
		ID: item.ID, Origin: OriginReference, Content: strPtr("我改的正文"),
	}); !errors.Is(err, ErrReferenceReadOnly) {
		t.Fatalf("只读引用正文被改写必须拒绝，got %v", err)
	}
	// 只改档位（不改正文）→ 允许
	if _, _, err := store.UpdateItem(ctx, l.ID, ItemInput{
		ID: item.ID, Origin: OriginReference, LoadMode: LoadModeManual,
	}); err != nil {
		t.Fatalf("只读引用条目仍应允许调整档位: %v", err)
	}
	// 显式转为本地改编 → 允许改写，且保留来源
	adapted, _, err := store.UpdateItem(ctx, l.ID, ItemInput{
		ID: item.ID, Origin: OriginAdaptation, Content: strPtr("本项目改编正文"),
	})
	if err != nil {
		t.Fatalf("显式转本地改编应允许改写: %v", err)
	}
	if adapted.Origin != OriginAdaptation || adapted.Content != "本项目改编正文" {
		t.Fatalf("改编结果不正确: %+v", adapted)
	}
	if adapted.Source == nil || adapted.Source.ID != "master-1" {
		t.Fatalf("转为本地改编必须保留来源指向: %+v", adapted.Source)
	}
}

// §4/§7 来源定位不得是本机绝对路径。
func TestSourceLocatorRejectsAbsolutePaths(t *testing.T) {
	store := newTestStore(t)
	l, _ := mustCreateLibrary(t, store, "库")
	ctx := context.Background()
	cases := []string{`C:\Users\11\secret\world.json`, `D:/data/novel.txt`, "/home/user/notes.md", `\\server\share\x`}
	for _, locator := range cases {
		_, _, err := store.CreateItem(ctx, l.ID, ItemInput{
			Type: TypeOther, Name: "来源条目",
			Source: &SourceRef{Kind: SourceKindFile, Label: "本地材料", Locator: locator},
		})
		var validation *ValidationError
		if !errors.As(err, &validation) || validation.Field != "item.source.locator" {
			t.Fatalf("绝对路径定位必须被拒绝: locator=%q err=%v", locator, err)
		}
	}
	if _, _, err := store.CreateItem(ctx, l.ID, ItemInput{
		Type: TypeOther, Name: "相对定位",
		Source: &SourceRef{Kind: SourceKindFile, Label: "材料", Locator: "novels/水浒/第003回.txt"},
	}); err != nil {
		t.Fatalf("相对定位应被接受: %v", err)
	}
}

// §8 关系：两端必须存在、不得自指、不得重复。
func TestRelationsRequireExistingEndpoints(t *testing.T) {
	store := newTestStore(t)
	l, _ := mustCreateLibrary(t, store, "库")
	ctx := context.Background()
	a := mustCreateItem(t, store, l.ID, ItemInput{Type: TypeCharacter, Name: "林冲"})
	b := mustCreateItem(t, store, l.ID, ItemInput{Type: TypeCharacter, Name: "鲁智深"})

	if _, _, err := store.CreateRelation(ctx, l.ID, RelationInput{FromItemID: a.ID, ToItemID: "不存在", Kind: RelationAlly}); err == nil {
		t.Fatal("悬空引用必须被拒绝")
	} else {
		var validation *ValidationError
		if !errors.As(err, &validation) || validation.Field != "toItemId" {
			t.Fatalf("悬空引用应报 toItemId 字段错误，got %v", err)
		}
	}
	if _, _, err := store.CreateRelation(ctx, l.ID, RelationInput{FromItemID: a.ID, ToItemID: a.ID, Kind: RelationAlly}); !errors.Is(err, ErrSelfRelation) {
		t.Fatalf("自指关系必须被拒绝，got %v", err)
	}
	first, _, err := store.CreateRelation(ctx, l.ID, RelationInput{FromItemID: a.ID, ToItemID: b.ID, Kind: RelationAlly, Label: "结义兄弟"})
	if err != nil {
		t.Fatalf("正常关系应创建成功: %v", err)
	}
	if _, _, err := store.CreateRelation(ctx, l.ID, RelationInput{FromItemID: a.ID, ToItemID: b.ID, Kind: RelationAlly}); !errors.Is(err, ErrDuplicateRelation) {
		t.Fatalf("重复关系必须被拒绝，got %v", err)
	}
	// 反向同类型允许（有向关系）
	if _, _, err := store.CreateRelation(ctx, l.ID, RelationInput{FromItemID: b.ID, ToItemID: a.ID, Kind: RelationAlly}); err != nil {
		t.Fatalf("反向关系应允许: %v", err)
	}
	// 更新为悬空 → 拒绝且不落盘
	if _, _, err := store.UpdateRelation(ctx, l.ID, first.ID, RelationInput{ToItemID: "不存在"}); err == nil {
		t.Fatal("更新成悬空引用必须被拒绝")
	}
	got, _, _ := store.Get(ctx, l.ID)
	if len(got.Relations) != 2 {
		t.Fatalf("被拒绝的更新不得落盘: %+v", got.Relations)
	}
}

// §9 删除影响：先给影响明细，显式级联才删除，且不留悬空引用。
func TestDeleteItemShowsImpactThenCascades(t *testing.T) {
	store := newTestStore(t)
	l, _ := mustCreateLibrary(t, store, "库")
	ctx := context.Background()
	hero := mustCreateItem(t, store, l.ID, ItemInput{Type: TypeCharacter, Name: "林冲"})
	place := mustCreateItem(t, store, l.ID, ItemInput{Type: TypeLocation, Name: "梁山"})
	other := mustCreateItem(t, store, l.ID, ItemInput{Type: TypeCharacter, Name: "鲁智深"})
	if _, _, err := store.CreateRelation(ctx, l.ID, RelationInput{FromItemID: hero.ID, ToItemID: other.ID, Kind: RelationAlly}); err != nil {
		t.Fatal(err)
	}
	event := mustCreateItem(t, store, l.ID, ItemInput{
		Type: TypeEvent, Name: "火并王伦",
		Event: &EventDetail{Order: 3, Era: "宣和年间", Category: EventCategoryHistorical, ParticipantItemIDs: []string{hero.ID, other.ID}, LocationItemID: place.ID},
	})

	impact, err := store.Impact(ctx, l.ID, hero.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(impact.Relations) != 1 || len(impact.Events) != 1 || impact.ItemName != "林冲" {
		t.Fatalf("影响预览应列出关系与事件: %+v", impact)
	}

	// 未级联 → 409 语义错误，且数据不变
	_, _, err = store.DeleteItem(ctx, l.ID, hero.ID, false)
	var inUse *ItemInUseError
	if !errors.As(err, &inUse) {
		t.Fatalf("存在引用时必须拒绝删除，got %v", err)
	}
	if len(inUse.Impact.Relations) != 1 || len(inUse.Impact.Events) != 1 {
		t.Fatalf("拒绝删除时必须带回影响明细: %+v", inUse.Impact)
	}
	got, _, _ := store.Get(ctx, l.ID)
	// 3 个实体条目 + 1 个事件条目；关系 1 条。
	if len(got.Items) != 4 || len(got.Relations) != 1 {
		t.Fatal("被拒绝的删除不得修改数据")
	}

	// 显式级联 → 删除条目并清理引用
	result, _, err := store.DeleteItem(ctx, l.ID, hero.ID, true)
	if err != nil {
		t.Fatalf("级联删除失败: %v", err)
	}
	if result.DeletedID != hero.ID || len(result.RemovedRelationIDs) != 1 || len(result.UpdatedEventIDs) != 1 {
		t.Fatalf("级联结果应说明清理了哪些引用: %+v", result)
	}
	after, _, _ := store.Get(ctx, l.ID)
	// 4 个条目删 1 剩 3（地点、另一角色、事件），关系被级联清理。
	if len(after.Items) != 3 || len(after.Relations) != 0 {
		t.Fatalf("级联后不应残留关系: items=%d relations=%d", len(after.Items), len(after.Relations))
	}
	var remaining *Item
	for i := range after.Items {
		if after.Items[i].ID == event.ID {
			remaining = &after.Items[i]
		}
	}
	if remaining == nil || remaining.Event == nil {
		t.Fatal("事件条目必须保留")
	}
	for _, participant := range remaining.Event.ParticipantItemIDs {
		if participant == hero.ID {
			t.Fatal("级联后事件不得残留被删条目的参与者引用")
		}
	}
	if len(remaining.Event.ParticipantItemIDs) != 1 || remaining.Event.ParticipantItemIDs[0] != other.ID {
		t.Fatalf("事件应只保留仍存在的参与者: %+v", remaining.Event.ParticipantItemIDs)
	}
	if err := ValidateLibrary(&after); err != nil {
		t.Fatalf("级联后库必须仍然自洽: %v", err)
	}
}

// §9 事件与时间线同源：时间线由事件条目派生，顺序稳定；删事件不动人物。
func TestTimelineDerivedFromEventsOnly(t *testing.T) {
	store := newTestStore(t)
	l, _ := mustCreateLibrary(t, store, "库")
	ctx := context.Background()
	hero := mustCreateItem(t, store, l.ID, ItemInput{Type: TypeCharacter, Name: "林冲"})
	mustCreateItem(t, store, l.ID, ItemInput{Type: TypeCharacter, Name: "无事件的普通条目"})

	// 故意乱序创建，验证派生视图排序稳定。
	for _, in := range []ItemInput{
		{Type: TypeEvent, Name: "风雪山神庙", Event: &EventDetail{Order: 5, Era: "宣和年间", Category: EventCategoryHistorical, ParticipantItemIDs: []string{hero.ID}}},
		{Type: TypeEvent, Name: "误入白虎堂", Event: &EventDetail{Order: 2, Era: "宣和年间", Category: EventCategoryHistorical}},
		{Type: TypeEvent, Name: "聚义梁山", Event: &EventDetail{Order: 1, Era: "宣和年间", Category: EventCategoryPlanned}},
		{Type: TypeEvent, Name: "前朝旧事", Event: &EventDetail{Order: 0, Era: "唐", Category: EventCategoryBackground}},
	} {
		mustCreateItem(t, store, l.ID, in)
	}
	got, _, err := store.Get(ctx, l.ID)
	if err != nil {
		t.Fatal(err)
	}
	timeline := BuildTimeline(got.Items)
	if len(timeline) != 4 {
		t.Fatalf("时间线应只含事件条目，got %d", len(timeline))
	}
	wantOrder := []string{"前朝旧事", "误入白虎堂", "风雪山神庙", "聚义梁山"}
	for i, want := range wantOrder {
		if timeline[i].Title != want {
			t.Fatalf("时间线排序不稳定：第 %d 项 = %q，期望 %q（实际顺序 %+v）", i, timeline[i].Title, want, timeline)
		}
	}
	// 再算一次必须完全一致（派生视图可复现）
	again := BuildTimeline(got.Items)
	if !reflect.DeepEqual(again, timeline) {
		t.Fatalf("同一份数据两次派生必须一致: %+v vs %+v", again, timeline)
	}
	// 删除事件条目不得影响参与人物
	var eventID string
	for _, item := range got.Items {
		if item.Name == "风雪山神庙" {
			eventID = item.ID
		}
	}
	if _, _, err := store.DeleteItem(ctx, l.ID, eventID, false); err != nil {
		t.Fatalf("删除事件条目应允许（人物不被牵连）: %v", err)
	}
	after, _, _ := store.Get(ctx, l.ID)
	if itemIndex(after.Items, hero.ID) < 0 {
		t.Fatal("删除事件不得删除参与人物")
	}
	if len(BuildTimeline(after.Items)) != 3 {
		t.Fatalf("时间线应随事件删除而收敛: %d", len(BuildTimeline(after.Items)))
	}
}

// §7 上限：超限输入返回字段错误，绝不静默截断。
func TestLimitsAreEnforcedNotSilentlyTruncated(t *testing.T) {
	store := newTestStore(t)
	l, _ := mustCreateLibrary(t, store, "库")
	ctx := context.Background()

	longName := strings.Repeat("名", MaxItemNameRunes+1)
	if _, _, err := store.CreateItem(ctx, l.ID, ItemInput{Type: TypeOther, Name: longName}); err == nil {
		t.Fatal("超长名称必须被拒绝")
	}
	longContent := strings.Repeat("文", MaxItemContentRunes+1)
	if _, _, err := store.CreateItem(ctx, l.ID, ItemInput{Type: TypeOther, Name: "正文过长", Content: &longContent}); err == nil {
		t.Fatal("超长正文必须被拒绝")
	}
	longSummary := strings.Repeat("简", MaxLibrarySummaryRunes+1)
	if _, _, err := store.UpdateMeta(ctx, l.ID, "", MetaPatchInput{Summary: &longSummary}); err == nil {
		t.Fatal("expected_revision 为空必须被拒绝")
	}
	if _, _, err := store.Create(ctx, CreateInput{Name: strings.Repeat("库", MaxLibraryNameRunes+1)}); err == nil {
		t.Fatal("超长库名必须被拒绝")
	}
	// 被拒绝的写入不得留下任何条目
	got, _, _ := store.Get(ctx, l.ID)
	if len(got.Items) != 0 {
		t.Fatalf("被拒绝的写入不得落盘: %+v", got.Items)
	}
	// 事件顺序越界
	if _, _, err := store.CreateItem(ctx, l.ID, ItemInput{
		Type: TypeEvent, Name: "越界事件",
		Event: &EventDetail{Order: MaxEventOrderAbs + 1, Category: EventCategoryHistorical},
	}); err == nil {
		t.Fatal("事件顺序越界必须被拒绝")
	}
}

// §5/§7 损坏文件：进入 warnings，不被静默丢弃；Get 报损坏，不泄露路径。
func TestCorruptLibraryFileIsReportedNotDropped(t *testing.T) {
	dataDir := t.TempDir()
	store := NewStore(dataDir)
	if err := os.MkdirAll(filepath.Join(dataDir, "libraries"), 0o755); err != nil {
		t.Fatal(err)
	}
	// 合法 id 文件名 + 损坏内容
	badID := "aaaaaaaaaaaaaaaa"
	if err := os.WriteFile(filepath.Join(dataDir, "libraries", "library-"+badID+".json"), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 非法 id 文件名
	if err := os.WriteFile(filepath.Join(dataDir, "libraries", "library-BAD-ID.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := store.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Libraries) != 0 {
		t.Fatalf("损坏文件不得出现在列表里: %+v", result.Libraries)
	}
	if len(result.Warnings) != 2 {
		t.Fatalf("损坏文件必须进入 warnings: %+v", result.Warnings)
	}
	if _, _, err := store.Get(context.Background(), badID); err == nil {
		t.Fatal("读取损坏库必须报错")
	} else if strings.Contains(err.Error(), dataDir) {
		t.Fatalf("损坏错误不得暴露本机路径: %v", err)
	}
	// 不允许用“合法但损坏”的库覆盖写
	var s string = "x"
	if _, _, err := store.UpdateMeta(context.Background(), badID, "sha256:deadbeef", MetaPatchInput{Summary: &s}); err == nil {
		t.Fatal("revision 不匹配时必须拒绝写入损坏库")
	}
}

// §3 库元信息与用途：新建默认 any，非法用途回落 any。
func TestLibraryMetaDefaults(t *testing.T) {
	store := newTestStore(t)
	l, _ := mustCreateLibrary(t, store, "库")
	if l.Purpose != PurposeAny || l.SchemaVersion != SchemaVersion || l.Items == nil || l.Relations == nil {
		t.Fatalf("新建库默认值不符合契约: %+v", l)
	}
	game, _, err := store.Create(context.Background(), CreateInput{Name: "游戏库", Purpose: PurposeGame, Tone: "冷峻", StartingPoint: "梁山泊初立"})
	if err != nil {
		t.Fatal(err)
	}
	if game.Purpose != PurposeGame || game.Tone != "冷峻" || game.StartingPoint != "梁山泊初立" {
		t.Fatalf("创建参数未生效: %+v", game)
	}
	if _, _, err := store.Create(context.Background(), CreateInput{Name: "非法用途", Purpose: "nonsense"}); err != nil {
		t.Fatalf("非法用途应回落 any 而不是报错: %v", err)
	}
	// 空名必须拒绝
	if _, _, err := store.Create(context.Background(), CreateInput{Name: "   "}); err == nil {
		t.Fatal("空库名必须被拒绝")
	}
}
