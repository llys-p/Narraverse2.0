package libraryruntime

// 集成测试：用真实 library.Store（临时目录）验证运行授权核心对真实落盘库的
// 全生命周期行为——零写入、跨库拒绝、revision 漂移显式 stale、幂等清理。
// “正文只进入当次模型输入”在核心层的证据：所有操作前后库文件逐字节不变，
// Run/Status/ReadResult 之外不存在任何获取正文的通道，且 Run 自身不保留正文。

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"denova/internal/library"
)

type integrationFixture struct {
	store *library.Store
	dir   string
	libA  string
	revA  string
	libB  string
}

func newIntegrationFixture(tb testing.TB) *integrationFixture {
	tb.Helper()
	dir := tb.TempDir()
	store := library.NewStore(dir)
	ctx := context.Background()
	a, _, err := store.Create(ctx, library.CreateInput{Name: "库A", Summary: "集成测试库"})
	if err != nil {
		tb.Fatal(err)
	}
	disabled := false
	for _, item := range []library.ItemInput{
		{ID: "resident-1", Name: "常驻一", Type: "character", LoadMode: library.LoadModeResident, Origin: library.OriginOriginal, Content: strPtr("A-常驻正文")},
		{ID: "auto-1", Name: "自动一", Type: "character", LoadMode: library.LoadModeAuto, Origin: library.OriginOriginal, Content: strPtr("A-自动正文")},
		{ID: "manual-1", Name: "手动一", Type: "character", LoadMode: library.LoadModeManual, Origin: library.OriginOriginal, Content: strPtr("A-手动正文")},
		{ID: "manual-2", Name: "手动二", Type: "character", LoadMode: library.LoadModeManual, Origin: library.OriginOriginal, Content: strPtr("A-未授权正文")},
		{ID: "auto-off", Name: "自动禁用", Type: "character", LoadMode: library.LoadModeAuto, Origin: library.OriginOriginal, Content: strPtr("A-禁用正文"), Enabled: &disabled},
	} {
		if _, _, err := store.CreateItem(ctx, a.ID, item); err != nil {
			tb.Fatal(err)
		}
	}
	// 库 B 与库 A 存在同名条目 ID（auto-1），用于证明按需读取只可能命中绑定库。
	b, _, err := store.Create(ctx, library.CreateInput{Name: "库B"})
	if err != nil {
		tb.Fatal(err)
	}
	if _, _, err := store.CreateItem(ctx, b.ID, library.ItemInput{ID: "auto-1", Name: "自动一", Type: "character",
		LoadMode: library.LoadModeAuto, Origin: library.OriginOriginal, Content: strPtr("B-自动正文")}); err != nil {
		tb.Fatal(err)
	}
	if _, _, err := store.CreateItem(ctx, b.ID, library.ItemInput{ID: "b-only-auto", Name: "B独有", Type: "character",
		LoadMode: library.LoadModeAuto, Origin: library.OriginOriginal, Content: strPtr("B-独有正文")}); err != nil {
		tb.Fatal(err)
	}
	// 绑定期望的 revision 必须是建完条目后的当前内容哈希。
	_, currentRevA, err := store.Get(ctx, a.ID)
	if err != nil {
		tb.Fatal(err)
	}
	return &integrationFixture{store: store, dir: dir, libA: a.ID, revA: currentRevA, libB: b.ID}
}

func strPtr(s string) *string { return &s }

func (f *integrationFixture) provider() LibraryProvider {
	return func(ctx context.Context, libraryID string) (library.Library, string, error) {
		return f.store.Get(ctx, libraryID)
	}
}

func (f *integrationFixture) fileSnapshot(tb testing.TB, id string) string {
	tb.Helper()
	data, err := os.ReadFile(filepath.Join(f.dir, "libraries", "library-"+id+".json"))
	if err != nil {
		tb.Fatal(err)
	}
	return string(data)
}

func TestIntegrationZeroWriteAndCrossLibraryPinning(t *testing.T) {
	ctx := context.Background()
	f := newIntegrationFixture(t)
	beforeA, beforeB := f.fileSnapshot(t, f.libA), f.fileSnapshot(t, f.libB)
	run, err := Bind(ctx, BindInput{Consumer: ConsumerWriting, ScopeKey: "task:abc123",
		LibraryID: f.libA, ExpectedRevision: f.revA, ManualItemIDs: []string{"manual-1"}}, f.provider(), nil)
	if err != nil {
		t.Fatal(err)
	}
	e, err := run.AssembleInitial(ctx)
	if err != nil || !e.Present() {
		t.Fatalf("assemble: %v", err)
	}
	// 同名条目 ID 只可能解析到绑定库 A 的内容，绝不串库。
	res, err := run.ReadOnDemand(ctx, "auto-1")
	if err != nil || !strings.Contains(res.ModelText, "A-自动正文") || strings.Contains(res.ModelText, "B-自动正文") {
		t.Fatalf("cross-library leak: res=%v err=%v", res, err)
	}
	// 只存在于库 B 的条目对本次运行不可见。
	if res, err := run.ReadOnDemand(ctx, "b-only-auto"); CodeOf(err) != ErrDenied || res.ModelText != "" {
		t.Fatalf("other library item must be denied, got %v", err)
	}
	if _, err := run.ReadOnDemand(ctx, "manual-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := run.ReadOnDemand(ctx, "manual-2"); CodeOf(err) != ErrDenied {
		t.Fatalf("ungranted manual must be denied, got %v", err)
	}
	if _, err := run.ReadOnDemand(ctx, "auto-off"); CodeOf(err) != ErrDenied {
		t.Fatalf("disabled item must be denied, got %v", err)
	}
	run.Complete()
	// 全生命周期零写入：两个库文件逐字节不变。
	if after := f.fileSnapshot(t, f.libA); after != beforeA {
		t.Fatal("runtime must not write the bound library")
	}
	if after := f.fileSnapshot(t, f.libB); after != beforeB {
		t.Fatal("runtime must not write any library")
	}
}

func TestIntegrationRevisionDriftIsExplicitStale(t *testing.T) {
	ctx := context.Background()
	f := newIntegrationFixture(t)
	run, err := Bind(ctx, BindInput{Consumer: ConsumerGame, ScopeKey: "story:s1/turn:1",
		LibraryID: f.libA, ExpectedRevision: f.revA, ManualItemIDs: []string{"manual-1"}}, f.provider(), nil)
	if err != nil {
		t.Fatal(err)
	}
	// 绑定后库被编辑：旧授权停止追加新正文，装配与读取都显式 stale。
	if _, _, err := f.store.CreateItem(ctx, f.libA, library.ItemInput{Name: "新条目", Type: "other",
		LoadMode: library.LoadModeManual, Origin: library.OriginOriginal, Content: strPtr("新正文")}); err != nil {
		t.Fatal(err)
	}
	if e, err := run.AssembleInitial(ctx); CodeOf(err) != ErrStale || e.Present() {
		t.Fatalf("assemble must be stale, got err=%v", err)
	}
	if res, err := run.ReadOnDemand(ctx, "auto-1"); CodeOf(err) != ErrStale || res.ModelText != "" {
		t.Fatalf("read must be stale, got err=%v", err)
	}
	// stale 是运行期显式状态，不是静默 bare：run 仍可查询并报告错误码。
	if st := run.Status(); st.State != "active" || st.LastErrorCode != ErrStale {
		t.Fatalf("status must expose stale explicitly: %#v", st)
	}
}

func TestIntegrationIdempotentCleanup(t *testing.T) {
	ctx := context.Background()
	f := newIntegrationFixture(t)
	run, err := Bind(ctx, BindInput{Consumer: ConsumerModule4, ScopeKey: "frame:xyz",
		LibraryID: f.libA, ExpectedRevision: f.revA}, f.provider(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run.AssembleInitial(ctx); err != nil {
		t.Fatal(err)
	}
	run.Cancel()
	run.Cancel()
	run.Complete()
	if st := run.Status(); st.State != "cancelled" || st.LastErrorCode != "" {
		t.Fatalf("first terminal state must win and stay clean: %#v", st)
	}
	if _, err := run.ReadOnDemand(ctx, "auto-1"); CodeOf(err) != ErrReleased {
		t.Fatalf("read after cancel must be released, got %v", err)
	}
}
