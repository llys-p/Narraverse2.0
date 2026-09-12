package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"denova/config"
	"denova/internal/world"
	"denova/internal/worldcontext"
)

// newWorldContextTestApp 在临时 DataDir 下构造一个只装配 cfg 的 App，并创建一个 active 世界。
func newWorldContextTestApp(t *testing.T) (*App, world.World, string) {
	t.Helper()
	cfg := &config.Config{}
	cfg.SetDataDir(t.TempDir())
	a := &App{cfg: cfg}
	ctx := context.Background()
	w, rev, err := a.CreateWorld(ctx, world.CreateInput{
		Name:    "测试世界",
		Summary: "一片正在形成的大陆。",
		WorldSetting: &world.WorldSetting{
			Tone:  "冷峻",
			Rules: []string{"魔法有代价"},
		},
	})
	if err != nil {
		t.Fatalf("准备世界失败: %v", err)
	}
	return a, w, rev
}

func worldRef(w world.World, rev string) worldcontext.Ref {
	return worldcontext.Ref{WorldID: w.ID, ExpectedWorldRevision: rev, Selection: worldcontext.Selection{IncludeTone: true}}
}

func TestWorldContext_PreviewAndBindRun(t *testing.T) {
	a, w, rev := newWorldContextTestApp(t)
	svc := newWorldContextService(a)
	ctx := context.Background()
	ref := worldRef(w, rev)

	// 只读预览：不建 run、不占 registry。
	view, err := svc.PreviewWorldContext(ctx, worldcontext.ConsumerWriting, ref)
	if err != nil {
		t.Fatalf("Preview 失败: %v", err)
	}
	if view.Identity.Name != "测试世界" || view.RevisionLabel == "" {
		t.Fatalf("UIView 内容异常: %+v", view.Identity)
	}
	if st := svc.WorldContextRegistryStats(); st.RunContexts != 0 {
		t.Fatalf("预览不应创建 runContext，got %#v", st)
	}

	// 首次 bind=created，重复同 scope 同 fp=reused。
	rc1, outcome, err := svc.BindWorldRun(ctx, worldcontext.ConsumerWriting, "task:1", ref)
	if err != nil || outcome != worldcontext.OutcomeCreated {
		t.Fatalf("首次 bind 应 created，outcome=%s err=%v", outcome, err)
	}
	_, outcome2, err := svc.BindWorldRun(ctx, worldcontext.ConsumerWriting, "task:1", ref)
	if err != nil || outcome2 != worldcontext.OutcomeReused {
		t.Fatalf("同 scope 同 fp 应 reused，got %s err=%v", outcome2, err)
	}
	got, err := svc.ReuseWorldRun(worldcontext.ConsumerWriting, "task:1", rc1.Fingerprint())
	if err != nil || string(got.State()) != "active" {
		t.Fatalf("Reuse 应 active，state=%s err=%v", got.State(), err)
	}
	if !svc.ReleaseWorldRun(worldcontext.ConsumerWriting, "task:1") {
		t.Fatal("Release 应命中")
	}
	if _, err := svc.ReuseWorldRun(worldcontext.ConsumerWriting, "task:1", ""); worldcontext.CodeOf(err) != worldcontext.ErrContextUnavailable {
		t.Fatalf("释放后应 context_unavailable，got %v", err)
	}
}

func TestWorldContext_AppPreviewFacadeDoesNotEnterRegistry(t *testing.T) {
	a, w, rev := newWorldContextTestApp(t)
	svc := a.worldContext()
	before := svc.WorldContextRegistryStats()
	if _, err := a.PreviewWorldContext(context.Background(), worldcontext.ConsumerWriting, worldRef(w, rev)); err != nil {
		t.Fatalf("App Preview 失败: %v", err)
	}
	after := svc.WorldContextRegistryStats()
	if before != after || after.RunContexts != 0 || after.BodyEntries != 0 || after.BodyBytes != 0 {
		t.Fatalf("App Preview 不得进入 Registry：before=%#v after=%#v", before, after)
	}
}

func TestWorldContext_RevisionMismatchFails(t *testing.T) {
	a, w, _ := newWorldContextTestApp(t)
	svc := newWorldContextService(a)
	bad := worldcontext.Ref{
		WorldID: w.ID, ExpectedWorldRevision: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
	}
	if _, err := svc.PreviewWorldContext(context.Background(), worldcontext.ConsumerWriting, bad); worldcontext.CodeOf(err) != worldcontext.ErrRevisionConflict {
		t.Fatalf("revision 不符应 revision_conflict，got %v", err)
	}
	if _, _, err := svc.BindWorldRun(context.Background(), worldcontext.ConsumerWriting, "task:1", bad); worldcontext.CodeOf(err) != worldcontext.ErrRevisionConflict {
		t.Fatalf("Bind revision 不符应 revision_conflict，got %v", err)
	}
	if st := svc.WorldContextRegistryStats(); st.RunContexts != 0 || st.BodyEntries != 0 {
		t.Fatalf("失败后不得残留 run/body，got %#v", st)
	}
}

func TestWorldContext_ArchivedFails(t *testing.T) {
	a, w, rev := newWorldContextTestApp(t)
	ctx := context.Background()
	archived, newRev, err := a.ArchiveWorld(ctx, w.ID, rev, true)
	if err != nil {
		t.Fatalf("归档准备失败: %v", err)
	}
	if archived.Status != world.StatusArchived {
		t.Fatal("测试前提：世界应已归档")
	}
	svc := newWorldContextService(a)
	ref := worldRef(archived, newRev)
	if _, err := svc.PreviewWorldContext(ctx, worldcontext.ConsumerGame, ref); worldcontext.CodeOf(err) != worldcontext.ErrWorldArchived {
		t.Fatalf("归档世界应 world_archived，got %v", err)
	}
	if _, _, err := svc.BindWorldRun(ctx, worldcontext.ConsumerGame, "run:1", ref); worldcontext.CodeOf(err) != worldcontext.ErrWorldArchived {
		t.Fatalf("归档世界 Bind 应 world_archived，got %v", err)
	}
}

func TestWorldContext_NotFound(t *testing.T) {
	a, _, _ := newWorldContextTestApp(t)
	svc := newWorldContextService(a)
	ref := worldcontext.Ref{WorldID: "w_missing____0000000000000000", ExpectedWorldRevision: "sha256:abc"}
	if _, err := svc.PreviewWorldContext(context.Background(), worldcontext.ConsumerWriting, ref); worldcontext.CodeOf(err) != worldcontext.ErrWorldNotFound {
		t.Fatalf("不存在世界应 world_not_found，got code=%s err=%v", worldcontext.CodeOf(err), err)
	}
}

func TestWorldContext_UntrustedConsumer(t *testing.T) {
	a, w, rev := newWorldContextTestApp(t)
	svc := newWorldContextService(a)
	ref := worldRef(w, rev)
	if _, _, err := svc.BindWorldRun(context.Background(), worldcontext.ConsumerNarraverse, "x:1", ref); worldcontext.CodeOf(err) != worldcontext.ErrConsumerNotTrusted {
		t.Fatalf("narraverse 应 consumer_not_trusted，got %v", err)
	}
}

// 真源守卫：完整预览/绑定/复用/释放全过程不得写 World，文件字节与 revision 保持不变。
func TestWorldContext_DoesNotWriteWorld(t *testing.T) {
	a, w, rev := newWorldContextTestApp(t)
	store := world.NewStore(a.cfg.DataDir())
	path := filepath.Join(store.Root(), "world-"+w.ID+".json")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取世界文件失败: %v", err)
	}

	svc := newWorldContextService(a)
	ctx := context.Background()
	ref := worldRef(w, rev)
	if _, err := svc.PreviewWorldContext(ctx, worldcontext.ConsumerWriting, ref); err != nil {
		t.Fatalf("Preview: %v", err)
	}
	if _, _, err := svc.BindWorldRun(ctx, worldcontext.ConsumerWriting, "task:1", ref); err != nil {
		t.Fatalf("Bind: %v", err)
	}
	if _, _, err := svc.BindWorldRun(ctx, worldcontext.ConsumerWriting, "task:2", ref); err != nil {
		t.Fatalf("Bind2: %v", err)
	}
	if _, err := svc.ReuseWorldRun(worldcontext.ConsumerWriting, "task:1", ""); err != nil {
		t.Fatalf("Reuse: %v", err)
	}
	svc.sweepWorldContexts()

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("再次读取世界文件失败: %v", err)
	}
	if string(before) != string(after) {
		t.Fatal("世界上下文装配过程修改了 World 文件字节")
	}
	_, gotRev, err := a.GetWorld(ctx, w.ID)
	if err != nil {
		t.Fatalf("GetWorld: %v", err)
	}
	if gotRev != rev {
		t.Fatalf("World revision 发生变化：before=%s after=%s", rev, gotRev)
	}
}

// App 重建（进程重启语义）：旧 Registry 不恢复，必须重新 bind；World 本身仍可读。
func TestWorldContext_RegistryEmptyAfterRebuild(t *testing.T) {
	a, w, rev := newWorldContextTestApp(t)
	ctx := context.Background()
	svc1 := newWorldContextService(a)
	rc, _, err := svc1.BindWorldRun(ctx, worldcontext.ConsumerWriting, "task:1", worldRef(w, rev))
	if err != nil {
		t.Fatalf("首次 Bind: %v", err)
	}
	if st := svc1.WorldContextRegistryStats(); st.RunContexts != 1 {
		t.Fatalf("绑定后应有 1 run，got %#v", st)
	}

	// 模拟 App 重建：同一 World 数据，但 Registry 是全新进程内对象。
	svc2 := newWorldContextService(a)
	if st := svc2.WorldContextRegistryStats(); st.RunContexts != 0 || st.BodyEntries != 0 {
		t.Fatalf("重建后 Registry 必须为空，got %#v", st)
	}
	if _, err := svc2.ReuseWorldRun(worldcontext.ConsumerWriting, "task:1", ""); worldcontext.CodeOf(err) != worldcontext.ErrContextUnavailable {
		t.Fatalf("重建后旧 run 必须 context_unavailable（不自动恢复），got %v", err)
	}
	if _, err := svc2.GetWorldRunByID(rc.ID(), worldcontext.ConsumerWriting); worldcontext.CodeOf(err) != worldcontext.ErrContextUnavailable {
		t.Fatalf("重建后旧 id 必须不可取回，got %v", err)
	}
	// World 仍是唯一真源：重新 bind 可成功。
	if _, _, err := svc2.BindWorldRun(ctx, worldcontext.ConsumerWriting, "task:1", worldRef(w, rev)); err != nil {
		t.Fatalf("重建后应能重新 Bind：%v", err)
	}
}

func TestWorldContext_SnapshotBudgetSharedByPreviewAndBind(t *testing.T) {
	cfg := &config.Config{}
	cfg.SetDataDir(t.TempDir())
	a := &App{cfg: cfg}

	locations := make([]world.Location, 0, 5)
	locationIDs := make([]string, 0, 5)
	for i := 0; i < 5; i++ {
		id := fmt.Sprintf("budget-location-%d", i)
		locationIDs = append(locationIDs, id)
		locations = append(locations, world.Location{
			ID:          id,
			Name:        fmt.Sprintf("地点%d", i),
			Description: strings.Repeat("x", 20000),
		})
	}
	w, rev, err := a.CreateWorld(context.Background(), world.CreateInput{
		Name:      "超限测试世界",
		Locations: locations,
	})
	if err != nil {
		t.Fatalf("准备超限世界失败: %v", err)
	}
	ref := worldcontext.Ref{
		WorldID:               w.ID,
		ExpectedWorldRevision: rev,
		Selection:             worldcontext.Selection{LocationIDs: locationIDs},
	}
	svc := newWorldContextService(a)

	assertSnapshotBudgetError := func(label string, got error) {
		t.Helper()
		de, ok := got.(*worldcontext.DomainError)
		if !ok || de.Code != worldcontext.ErrBudgetExceeded || de.Layer != string(worldcontext.LayerSnapshotBytes) {
			t.Fatalf("%s 必须返回 budget_exceeded/snapshot_bytes，got %#v", label, got)
		}
	}
	_, previewErr := svc.PreviewWorldContext(context.Background(), worldcontext.ConsumerWriting, ref)
	assertSnapshotBudgetError("Preview", previewErr)
	_, _, bindErr := svc.BindWorldRun(context.Background(), worldcontext.ConsumerWriting, "task:budget", ref)
	assertSnapshotBudgetError("Bind", bindErr)

	if stats := svc.WorldContextRegistryStats(); stats.RunContexts != 0 || stats.BodyEntries != 0 || stats.BodyBytes != 0 {
		t.Fatalf("预算失败不得占用 Registry，got %#v", stats)
	}
}
