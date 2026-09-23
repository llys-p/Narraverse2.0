package libraryruntime

import (
	"context"
	"errors"
	"strings"
	"testing"

	"denova/internal/library"
	"denova/internal/librarycontext"
)

const (
	testLibraryID = "lib000000000001"
	testRevision  = "rev-0001"
)

// testProvider 返回一份固定形状的测试库：resident/auto/manual/禁用各就各位，
// revision 可被测试改为 "rev-0002" 以模拟库漂移。
type testProvider struct {
	library library.Library
	rev     string
	fail    bool
}

func (p *testProvider) load(ctx context.Context, id string) (library.Library, string, error) {
	if p.fail {
		return library.Library{}, "", errors.New("boom")
	}
	return p.library, p.rev, nil
}

func testItem(id, name, loadMode, content string, enabled bool) library.Item {
	return library.Item{ID: id, Enabled: enabled, Type: "character", Name: name,
		LoadMode: loadMode, Origin: library.OriginOriginal, Content: content,
		Fields: map[string]string{}}
}

func newTestProvider() *testProvider {
	return &testProvider{rev: testRevision, library: library.Library{
		ID: testLibraryID, Name: "测试库", Summary: "测试摘要", Tone: "史诗",
		Items: []library.Item{
			testItem("resident-1", "常驻一", library.LoadModeResident, "常驻正文一", true),
			testItem("auto-1", "自动一", library.LoadModeAuto, "自动正文一", true),
			testItem("auto-disabled", "自动禁用", library.LoadModeAuto, "不该读到", false),
			testItem("manual-1", "手动一", library.LoadModeManual, "手动正文一", true),
			testItem("manual-2", "手动二", library.LoadModeManual, "未授权正文", true),
			testItem("manual-disabled", "手动禁用", library.LoadModeManual, "禁用正文", false),
		},
	}}
}

func bindTest(tb testing.TB, p *testProvider, mutate func(*BindInput)) (*Run, error) {
	tb.Helper()
	in := BindInput{
		Consumer:         ConsumerWriting,
		ScopeKey:         "task:t1",
		LibraryID:        testLibraryID,
		ExpectedRevision: testRevision,
		ManualItemIDs:    []string{"manual-1"},
	}
	if mutate != nil {
		mutate(&in)
	}
	return Bind(context.Background(), in, p.load, nil)
}

func mustBind(tb testing.TB, p *testProvider, mutate func(*BindInput)) *Run {
	tb.Helper()
	run, err := bindTest(tb, p, mutate)
	if err != nil {
		tb.Fatalf("bind: %v", err)
	}
	return run
}

func TestBindValidatesIdentityAndShape(t *testing.T) {
	p := newTestProvider()
	cases := []struct {
		name string
		mut  func(*BindInput)
		code ErrorCode
		prov LibraryProvider
	}{
		{"bad consumer", func(in *BindInput) { in.Consumer = "client" }, ErrConsumerNotTrusted, p.load},
		{"empty scope key", func(in *BindInput) { in.ScopeKey = "  " }, ErrInvalidRequest, p.load},
		{"invalid library id", func(in *BindInput) { in.LibraryID = "../escape" }, ErrInvalidRequest, p.load},
		{"blank revision", func(in *BindInput) { in.ExpectedRevision = "" }, ErrInvalidRequest, p.load},
		{"blank manual id", func(in *BindInput) { in.ManualItemIDs = []string{"manual-1", " "} }, ErrInvalidRequest, p.load},
		{"negative baseline", func(in *BindInput) { in.BaselineTokens = -1 }, ErrInvalidRequest, p.load},
		{"nil provider", nil, ErrInvalidRequest, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			run, err := Bind(context.Background(), func() BindInput {
				in := BindInput{Consumer: ConsumerWriting, ScopeKey: "task:t1", LibraryID: testLibraryID,
					ExpectedRevision: testRevision, ManualItemIDs: []string{"manual-1"}}
				if tc.mut != nil {
					tc.mut(&in)
				}
				return in
			}(), tc.prov, nil)
			if run != nil || err == nil || CodeOf(err) != tc.code {
				t.Fatalf("run=%v err=%v code=%v", run, err, CodeOf(err))
			}
		})
	}
}

func TestBindBlocksOnRevisionProviderAndGrant(t *testing.T) {
	ctx := context.Background()
	// revision 漂移：绑定固定版本，不匹配即阻断。
	p := newTestProvider()
	if _, err := bindTest(t, p, func(in *BindInput) { in.ExpectedRevision = "rev-0002" }); CodeOf(err) != ErrRevisionConflict {
		t.Fatalf("want revision_conflict, got %v", err)
	}
	// 库不可读：绑定期显式 unavailable 类阻断，不静默降级。
	p = newTestProvider()
	p.fail = true
	if _, err := bindTest(t, p, nil); CodeOf(err) != ErrLibraryUnavailable {
		t.Fatalf("want library_unavailable, got %v", err)
	}
	// manual 集合逐项校验：未知/禁用/非 manual 档一律拒绝。
	for _, tc := range []struct {
		name string
		ids  []string
	}{
		{"unknown", []string{"no-such-item"}},
		{"disabled", []string{"manual-disabled"}},
		{"resident mode", []string{"resident-1"}},
		{"auto mode", []string{"auto-1"}},
	} {
		p := newTestProvider()
		if _, err := bindTest(t, p, func(in *BindInput) { in.ManualItemIDs = tc.ids }); CodeOf(err) != ErrSelectionInvalid {
			t.Fatalf("%s: want selection_invalid, got %v", tc.name, err)
		}
	}
	// 合法绑定 + 服务端身份只读。
	p = newTestProvider()
	run, err := Bind(ctx, BindInput{Consumer: ConsumerGame, ScopeKey: " task:t2 ", LibraryID: testLibraryID,
		ExpectedRevision: testRevision, ManualItemIDs: []string{"manual-1", "manual-1"}}, p.load, nil)
	if err != nil {
		t.Fatal(err)
	}
	if run.Consumer() != ConsumerGame || run.ScopeKey() != "task:t2" {
		t.Fatal("server-derived identity must round-trip")
	}
	if st := run.Status(); st.State != "active" || st.LibraryName != "测试库" || st.ManualCount != 1 {
		t.Fatalf("status=%#v", st)
	}
}

func TestBindBudgetBlocksStart(t *testing.T) {
	p := newTestProvider()
	in := BindInput{Consumer: ConsumerWriting, ScopeKey: "task:t1", LibraryID: testLibraryID,
		ExpectedRevision: testRevision, Config: Config{MaxBytes: 100, MaxEstimatedTokens: 10, ReservedOutputTokens: 5},
		BaselineTokens: 9}
	if run, err := Bind(context.Background(), in, p.load, nil); run != nil || CodeOf(err) != ErrBudgetExceeded {
		t.Fatalf("run=%v err=%v", run, err)
	}
}

func TestAssembleInitialIsDeterministicAndCharged(t *testing.T) {
	ctx := context.Background()
	p := newTestProvider()
	run1 := mustBind(t, p, nil)
	run2 := mustBind(t, p, nil)
	e1, err := run1.AssembleInitial(ctx)
	if err != nil || !e1.Present() {
		t.Fatalf("assemble: %v", err)
	}
	e2, err := run2.AssembleInitial(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if e1.LeadingText() != e2.LeadingText() {
		t.Fatal("same pinned input must assemble byte-identical model views")
	}
	if !strings.HasPrefix(e1.LeadingText(), ephemeralLibraryContextHeader) {
		t.Fatal("ephemeral input must start with the frozen header")
	}
	body := strings.TrimPrefix(e1.LeadingText(), ephemeralLibraryContextHeader)
	for _, want := range []string{"常驻正文一", "手动正文一", "自动一", `"auto-1"`, "测试库"} {
		if !strings.Contains(body, want) {
			t.Fatalf("model view missing %q", want)
		}
	}
	for _, banned := range []string{"自动正文一", "未授权正文", "budget"} {
		if strings.Contains(body, banned) {
			t.Fatalf("model view must not contain %q", banned)
		}
	}
	st := run1.Status()
	if st.BytesUsed == 0 || st.EstimatedTokensUsed == 0 || st.LastErrorCode != "" {
		t.Fatalf("charge missing: %#v", st)
	}
	// 重复装配照计（同一授权下的每次模型输入都占预算）。
	before := st.BytesUsed
	if _, err := run1.AssembleInitial(ctx); err != nil {
		t.Fatal(err)
	}
	if run1.Status().BytesUsed != before*2 {
		t.Fatalf("repeat assembly must re-charge: %d -> %d", before, run1.Status().BytesUsed)
	}
}

func TestAssembleInitialStaleAfterLibraryChange(t *testing.T) {
	p := newTestProvider()
	run := mustBind(t, p, nil)
	p.rev = "rev-0002"
	e, err := run.AssembleInitial(context.Background())
	if err == nil || e.Present() || CodeOf(err) != ErrStale {
		t.Fatalf("want stale without carrier, got err=%v present=%v", err, e.Present())
	}
	if run.Status().LastErrorCode != ErrStale {
		t.Fatal("status must expose the explicit stale code")
	}
}

func TestReadOnDemandGrantBoundaries(t *testing.T) {
	ctx := context.Background()
	p := newTestProvider()
	run := mustBind(t, p, nil)
	cases := []struct {
		id   string
		code ErrorCode
	}{
		{"auto-1", ""},
		{"manual-1", ""},
		{"auto-disabled", ErrDenied},
		{"resident-1", ErrDenied}, // resident 已在初始装配，按需读取不扩授权
		{"manual-2", ErrDenied},   // 未授权 manual
		{"no-such-item", ErrDenied},
		{"", ErrDenied},
	}
	for _, tc := range cases {
		res, err := run.ReadOnDemand(ctx, tc.id)
		if tc.code == "" {
			if err != nil || res.ModelText == "" {
				t.Fatalf("%s: err=%v", tc.id, err)
			}
			continue
		}
		if err == nil || CodeOf(err) != tc.code || res.ModelText != "" {
			t.Fatalf("%s: want %s, got res=%v err=%v", tc.id, tc.code, res, err)
		}
	}
	if res, err := run.ReadOnDemand(ctx, "auto-1"); err != nil || !strings.Contains(res.ModelText, "自动正文一") {
		t.Fatalf("auto read: %v", err)
	}
}

func TestReadOnDemandPinsRevisionAndRecharges(t *testing.T) {
	ctx := context.Background()
	p := newTestProvider()
	run := mustBind(t, p, nil)
	if _, err := run.ReadOnDemand(ctx, "auto-1"); err != nil {
		t.Fatal(err)
	}
	used := run.Status().EstimatedTokensUsed
	if _, err := run.ReadOnDemand(ctx, "auto-1"); err != nil {
		t.Fatal(err)
	}
	if run.Status().EstimatedTokensUsed <= used {
		t.Fatal("repeat read of the same item must be charged again")
	}
	// 库漂移后停止旧授权下的新正文，也绝不交付新版本内容。
	p.rev = "rev-0002"
	if res, err := run.ReadOnDemand(ctx, "auto-1"); CodeOf(err) != ErrStale || res.ModelText != "" {
		t.Fatalf("want stale, got res=%v err=%v", res, err)
	}
	// 库读取失败运行期显式 unavailable。
	p.rev = testRevision
	p.fail = true
	if _, err := run.ReadOnDemand(ctx, "auto-1"); CodeOf(err) != ErrUnavailable {
		t.Fatalf("want unavailable, got %v", err)
	}
}

func TestReadOnDemandReferenceResolution(t *testing.T) {
	lib := library.Library{ID: testLibraryID, Name: "引用库", Items: []library.Item{
		{ID: "ref-auto", Enabled: true, Type: "character", Name: "引用条目", LoadMode: library.LoadModeAuto,
			Origin: library.OriginReference, Source: &library.SourceRef{Kind: "master", ID: "m1", Revision: "src-1"}},
		{ID: "ref-locator", Enabled: true, Type: "character", Name: "带定位", LoadMode: library.LoadModeAuto,
			Origin: library.OriginReference, Source: &library.SourceRef{Kind: "master", ID: "m2", Revision: "src-1", Locator: "C:\\secret\\path.md"}},
		{ID: "ref-empty", Enabled: true, Type: "character", Name: "空引用", LoadMode: library.LoadModeAuto,
			Origin: library.OriginReference},
	}}
	newRun := func(resolver librarycontext.Resolver) *Run {
		p := &testProvider{rev: testRevision, library: lib}
		run, err := Bind(context.Background(), BindInput{Consumer: ConsumerNarraverse, ScopeKey: "frame:f1",
			LibraryID: testLibraryID, ExpectedRevision: testRevision}, p.load, resolver)
		if err != nil {
			t.Fatal(err)
		}
		return run
	}
	// 无 resolver：显式 unavailable，不回落到猜测正文。
	if _, err := newRun(nil).ReadOnDemand(context.Background(), "ref-auto"); CodeOf(err) != ErrUnavailable {
		t.Fatalf("want unavailable, got %v", err)
	}
	// 正常受控解析：读到固定版本来源正文。
	ok := librarycontext.Resolver(func(ctx context.Context, ref library.SourceRef) (librarycontext.ResolvedSource, error) {
		return librarycontext.ResolvedSource{Revision: "src-1", Content: "来源正文"}, nil
	})
	res, err := newRun(ok).ReadOnDemand(context.Background(), "ref-auto")
	if err != nil || !strings.Contains(res.ModelText, "来源正文") || !strings.Contains(res.ModelText, "src-1") {
		t.Fatalf("res=%v err=%v", res, err)
	}
	// 来源版本变化：stale，不把新来源当成原版本。
	changed := librarycontext.Resolver(func(ctx context.Context, ref library.SourceRef) (librarycontext.ResolvedSource, error) {
		return librarycontext.ResolvedSource{Revision: "src-2", Content: "新来源"}, nil
	})
	if res, err := newRun(changed).ReadOnDemand(context.Background(), "ref-auto"); CodeOf(err) != ErrStale || res.ModelText != "" {
		t.Fatalf("want stale, got %v", err)
	}
	// 来源失败：unavailable。
	failing := librarycontext.Resolver(func(ctx context.Context, ref library.SourceRef) (librarycontext.ResolvedSource, error) {
		return librarycontext.ResolvedSource{}, librarycontext.ErrSourceUnavailable
	})
	if _, err := newRun(failing).ReadOnDemand(context.Background(), "ref-auto"); CodeOf(err) != ErrUnavailable {
		t.Fatalf("want unavailable, got %v", err)
	}
	// locator / 缺失 ref：拒绝，locator 永远不是读取许可。
	if _, err := newRun(ok).ReadOnDemand(context.Background(), "ref-locator"); CodeOf(err) != ErrUnavailable {
		t.Fatalf("want unavailable for locator ref, got %v", err)
	}
	if _, err := newRun(ok).ReadOnDemand(context.Background(), "ref-empty"); CodeOf(err) != ErrUnavailable {
		t.Fatalf("want unavailable for empty ref, got %v", err)
	}
}

func TestBudgetExhaustionIsExplicit(t *testing.T) {
	ctx := context.Background()
	p := newTestProvider()
	run := mustBind(t, p, func(in *BindInput) {
		in.Config = Config{MaxBytes: 8192, MaxEstimatedTokens: 500, ReservedOutputTokens: 10, InitialCatalogLimit: 2}
	})
	if _, err := run.AssembleInitial(ctx); err != nil {
		t.Fatal(err)
	}
	sawExceeded := false
	for range 50 {
		res, err := run.ReadOnDemand(ctx, "auto-1")
		if err != nil {
			if CodeOf(err) != ErrBudgetExceeded || res.ModelText != "" {
				t.Fatalf("want clean budget_exceeded, got res=%v err=%v", res, err)
			}
			sawExceeded = true
			break
		}
	}
	if !sawExceeded {
		t.Fatal("tight budget must eventually be exceeded")
	}
	if run.Status().LastErrorCode != ErrBudgetExceeded {
		t.Fatalf("status must expose budget_exceeded, got %v", run.Status().LastErrorCode)
	}
}

func TestLifecycleCleanupIsIdempotent(t *testing.T) {
	ctx := context.Background()
	p := newTestProvider()
	run := mustBind(t, p, nil)
	if _, err := run.AssembleInitial(ctx); err != nil {
		t.Fatal(err)
	}
	run.Complete()
	run.Complete() // 重复 Complete：幂等 no-op
	run.Cancel()   // 终态已定，Cancel 不改写历史
	st := run.Status()
	if st.State != "completed" {
		t.Fatalf("want completed, got %#v", st)
	}
	if _, err := run.ReadOnDemand(ctx, "auto-1"); CodeOf(err) != ErrReleased {
		t.Fatalf("read after complete must be released, got %v", err)
	}
	if e, err := run.AssembleInitial(ctx); err == nil || e.Present() {
		t.Fatalf("assemble after complete must fail without carrier: err=%v", err)
	}
	if st := run.Status(); st.State != "completed" || st.LastErrorCode != ErrReleased {
		t.Fatalf("terminal status must stay explicit: %#v", st)
	}
	// 取消路径同理。
	p2 := newTestProvider()
	run2 := mustBind(t, p2, nil)
	run2.Cancel()
	run2.Cancel()
	run2.Complete()
	if st := run2.Status(); st.State != "cancelled" {
		t.Fatalf("want cancelled, got %#v", st)
	}
}

func TestEphemeralZeroValueIsExplicitBareOnly(t *testing.T) {
	zero := EphemeralLibraryContext{}
	if zero.Present() || zero.LeadingText() != "" || zero.ModelViewByteLen() != 0 || zero.EstimatedTokens() != 0 {
		t.Fatal("zero value must be a well-formed bare carrier")
	}
	if empty := NewEphemeralLibraryContext(nil); empty.Present() {
		t.Fatal("empty model view must not pretend to carry background")
	}
	// 错误路径绝不静默产生 bare：绑定期失败根本不返回 Run，
	// 装配失败返回显式错误，这里回归两种失败都不产生 present 载体。
	p := newTestProvider()
	if run, err := bindTest(t, p, func(in *BindInput) { in.ExpectedRevision = "wrong" }); run != nil || err == nil {
		t.Fatal("bind failure must not produce a run")
	}
	p2 := newTestProvider()
	run := mustBind(t, p2, nil)
	p2.rev = "rev-0002"
	if e, err := run.AssembleInitial(context.Background()); err == nil || e.Present() {
		t.Fatal("assemble failure must not produce a present carrier")
	}
}
