package app

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"

	"denova/internal/world"
	"denova/internal/worldcontext"
)

// Phase 3.2-A2：bind-before-start 裁定（resolveWritingRun）与 analysis handle 生命周期测试。
// 这些用例只覆盖进程内 Registry/handle 编排，不启动模型、不接 HTTP、不写 World。
// 注意：销毁 runContext 后 ProjectionBody LRU 缓存仍可保留派生字节（有界、进程内），
// 因此“已释放”只断言 RunContexts 归零，不断言 BodyEntries。

func writingSvcHarness(t *testing.T) (*App, *WorldContextService, world.World, string) {
	t.Helper()
	a, w, rev := newWorldContextTestApp(t)
	svc := newWorldContextService(a)
	return a, svc, w, rev
}

// snapshotFingerprint 构建一次 Snapshot 以取得期望指纹。worldcontext 的 runId 不跨包暴露，
// “迁移保持同一 runId”由 worldcontext 自身的 MoveScopeByID 测试覆盖；app 层用计数+指纹断言。
func snapshotFingerprint(t *testing.T, svc *WorldContextService, ref worldcontext.Ref) string {
	t.Helper()
	snap, err := svc.loadSnapshot(context.Background(), worldcontext.ConsumerWriting, ref)
	if err != nil {
		t.Fatalf("构建期望 Snapshot 失败: %v", err)
	}
	return snap.ContextFingerprint
}

func TestWritingResolve_BareZeroRegistry(t *testing.T) {
	_, svc, _, _ := writingSvcHarness(t)
	before := svc.WorldContextRegistryStats()
	wr, err := svc.resolveWritingRun(context.Background(), "1", "", WritingWorldControl{})
	if err != nil {
		t.Fatalf("bare 不应报错: %v", err)
	}
	if wr != nil {
		t.Fatalf("bare 不应产生 runContext，got %+v", wr)
	}
	if after := svc.WorldContextRegistryStats(); after != before {
		t.Fatalf("bare 必须零 Registry 增量: before=%#v after=%#v", before, after)
	}
}

func TestWritingResolve_DegradedWorldNotFoundReturnsBare(t *testing.T) {
	_, svc, _, _ := writingSvcHarness(t)
	before := svc.WorldContextRegistryStats()
	ref := worldcontext.Ref{
		WorldID:               "world-that-does-not-exist",
		ExpectedWorldRevision: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
		Selection:             worldcontext.Selection{IncludeTone: true},
	}

	wr, err := svc.resolveWritingRun(context.Background(), "missing", "", WritingWorldControl{Ref: &ref})
	if err != nil {
		t.Fatalf("world_not_found should degrade to bare, got %v", err)
	}
	if wr != nil {
		t.Fatalf("degraded ref must not produce a run context, got %+v", wr)
	}
	if after := svc.WorldContextRegistryStats(); after != before {
		t.Fatalf("degraded ref must add no Registry entries: before=%#v after=%#v", before, after)
	}
}

func TestWritingResolve_SnapshotBudgetBlocksWithoutRegistryEntry(t *testing.T) {
	a, svc, _, _ := writingSvcHarness(t)
	locations := make([]world.Location, 0, 5)
	locationIDs := make([]string, 0, 5)
	for i := 0; i < 5; i++ {
		id := fmt.Sprintf("writing-budget-location-%d", i)
		locationIDs = append(locationIDs, id)
		locations = append(locations, world.Location{
			ID:          id,
			Name:        fmt.Sprintf("地点%d", i),
			Description: strings.Repeat("x", 20000),
		})
	}
	w, rev, err := a.CreateWorld(context.Background(), world.CreateInput{
		Name:      "写作降级超限世界",
		Locations: locations,
	})
	if err != nil {
		t.Fatalf("prepare oversized world: %v", err)
	}
	ref := worldcontext.Ref{
		WorldID:               w.ID,
		ExpectedWorldRevision: rev,
		Selection:             worldcontext.Selection{LocationIDs: locationIDs},
	}
	before := svc.WorldContextRegistryStats()

	wr, err := svc.resolveWritingRun(context.Background(), "budget", "", WritingWorldControl{Ref: &ref})
	if worldcontext.CodeOf(err) != worldcontext.ErrBudgetExceeded {
		t.Fatalf("snapshot budget failure must block, got wr=%+v err=%v", wr, err)
	}
	if after := svc.WorldContextRegistryStats(); after != before {
		t.Fatalf("blocked budget must add no Registry entries: before=%#v after=%#v", before, after)
	}
}

func TestWritingResolve_DirectRefTaskScopeAndReleaseOnce(t *testing.T) {
	a, svc, w, rev := writingSvcHarness(t)
	ref := worldRef(w, rev)
	wr, err := svc.resolveWritingRun(context.Background(), "77", "", WritingWorldControl{Ref: &ref})
	if err != nil {
		t.Fatalf("direct Ref 绑定失败: %v", err)
	}
	if wr == nil || wr.runContext == nil {
		t.Fatal("direct Ref 必须产生 runContext")
	}
	if wr.scopeKey != "task:77" || wr.runContext.ScopeKey() != "task:77" {
		t.Fatalf("scopeKey 必须由服务端 Task ID 派生, got %q", wr.runContext.ScopeKey())
	}
	if wr.runContext.Consumer() != worldcontext.ConsumerWriting {
		t.Fatalf("consumer 固定 writing, got %q", wr.runContext.Consumer())
	}
	if st := svc.WorldContextRegistryStats(); st.RunContexts != 1 {
		t.Fatalf("应恰好 1 个 runContext, got %#v", st)
	}
	// 释放恰好一次：第一次命中，第二次 noop（不产生负 refCount）。
	if !svc.ReleaseWorldRun(worldcontext.ConsumerWriting, wr.scopeKey) {
		t.Fatal("首次释放应命中")
	}
	if svc.ReleaseWorldRun(worldcontext.ConsumerWriting, wr.scopeKey) {
		t.Fatal("重复释放必须 noop")
	}
	if st := svc.WorldContextRegistryStats(); st.RunContexts != 0 {
		t.Fatalf("释放后 runContext 应清空, got %#v", st)
	}
	// World 文件与 revision 不被绑定/释放改变。
	got, gotRev, err := a.GetWorld(context.Background(), w.ID)
	if err != nil || gotRev != rev || got.Name != w.Name {
		t.Fatalf("World 不应被改写: rev=%s->%s err=%v", rev, gotRev, err)
	}
}

func TestWritingResolve_HandleOnlyMovesAndConsumes(t *testing.T) {
	_, svc, w, rev := writingSvcHarness(t)
	ctx := context.Background()
	ref := worldRef(w, rev)
	view, err := svc.createAnalysisHandle(ctx, worldcontext.ConsumerWriting, "workspace:ws|session:s1", ref)
	if err != nil {
		t.Fatalf("准备 handle 失败: %v", err)
	}
	if st := svc.WorldContextRegistryStats(); st.RunContexts != 1 {
		t.Fatalf("handle 创建后应有 1 个 pending runContext, got %#v", st)
	}
	wantFP := snapshotFingerprint(t, svc, ref)

	wr, err := svc.resolveWritingRun(ctx, "9", "workspace:ws|session:s1", WritingWorldControl{
		HasAnalysisHandle: true, AnalysisHandle: view.AnalysisHandle,
	})
	if err != nil {
		t.Fatalf("handle 解析失败: %v", err)
	}
	if wr == nil || wr.handleStatus != AnalysisHandleConsumed {
		t.Fatalf("应 consume handle, got %+v", wr)
	}
	// 迁移而非新建：指纹沿用 pending，且不新增第二个 run。
	if wr.runContext.Fingerprint() != wantFP {
		t.Fatalf("handle 路径必须沿用 pending 指纹, want %s got %s", wantFP, wr.runContext.Fingerprint())
	}
	if wr.runContext.ScopeKey() != "task:9" {
		t.Fatalf("应迁移到 task scope, got %q", wr.runContext.ScopeKey())
	}
	if st := svc.WorldContextRegistryStats(); st.RunContexts != 1 {
		t.Fatalf("迁移后仍应恰好 1 个 runContext, got %#v", st)
	}
	// 已 consume 的 handle 不可再次接管；无 Ref 时回落 bare。
	wr2, err := svc.resolveWritingRun(ctx, "10", "workspace:ws|session:s1", WritingWorldControl{
		HasAnalysisHandle: true, AnalysisHandle: view.AnalysisHandle,
	})
	if err != nil {
		t.Fatalf("失效 handle 不应阻断: %v", err)
	}
	if wr2 != nil {
		t.Fatal("已 consume 的 handle 无 Ref 时必须回落 bare")
	}
	svc.ReleaseWorldRun(worldcontext.ConsumerWriting, "task:9")
}

func TestWritingResolve_RefPlusHandleMatchReusesPending(t *testing.T) {
	_, svc, w, rev := writingSvcHarness(t)
	ctx := context.Background()
	ref := worldRef(w, rev)
	view, err := svc.createAnalysisHandle(ctx, worldcontext.ConsumerWriting, "workspace:ws|session:s1", ref)
	if err != nil {
		t.Fatalf("准备 handle 失败: %v", err)
	}
	wantFP := snapshotFingerprint(t, svc, ref)

	wr, err := svc.resolveWritingRun(ctx, "11", "workspace:ws|session:s1", WritingWorldControl{
		Ref: &ref, HasAnalysisHandle: true, AnalysisHandle: view.AnalysisHandle,
	})
	if err != nil {
		t.Fatalf("Ref+handle 解析失败: %v", err)
	}
	if wr.handleStatus != AnalysisHandleConsumed {
		t.Fatalf("fingerprint 一致应 consume, got %q", wr.handleStatus)
	}
	if wr.runContext.Fingerprint() != wantFP {
		t.Fatalf("一致时必须复用 pending 指纹, want %s got %s", wantFP, wr.runContext.Fingerprint())
	}
	if st := svc.WorldContextRegistryStats(); st.RunContexts != 1 {
		t.Fatalf("一致时不得新建第二个 runContext, got %#v", st)
	}
	svc.ReleaseWorldRun(worldcontext.ConsumerWriting, wr.scopeKey)
}

func TestWritingResolve_RefPlusHandleConflictRefWins(t *testing.T) {
	a, svc, wA, revA := writingSvcHarness(t)
	ctx := context.Background()
	refA := worldRef(wA, revA)
	// 第二个世界，保证 fingerprint 不同。
	wB, revB, err := a.CreateWorld(ctx, world.CreateInput{Name: "另一世界", Summary: "不同的大陆"})
	if err != nil {
		t.Fatalf("准备第二个世界失败: %v", err)
	}
	refB := worldRef(wB, revB)

	view, err := svc.createAnalysisHandle(ctx, worldcontext.ConsumerWriting, "workspace:ws|session:s1", refA)
	if err != nil {
		t.Fatalf("准备 handle A 失败: %v", err)
	}
	fpA := snapshotFingerprint(t, svc, refA)

	wr, err := svc.resolveWritingRun(ctx, "12", "workspace:ws|session:s1", WritingWorldControl{
		Ref: &refB, HasAnalysisHandle: true, AnalysisHandle: view.AnalysisHandle,
	})
	if err != nil {
		t.Fatalf("冲突路径不应报错: %v", err)
	}
	if wr.handleStatus != AnalysisHandleIgnoredConflict {
		t.Fatalf("fingerprint 冲突必须 ignored_conflict, got %q", wr.handleStatus)
	}
	if wr.runContext.Fingerprint() == fpA {
		t.Fatal("冲突时必须按 Ref B 新建 runContext，不得复用 A 的 pending 指纹")
	}
	if wr.runContext.WorldID() != wB.ID {
		t.Fatalf("Ref 优先，runContext 必须属于世界 B, got %q", wr.runContext.WorldID())
	}
	if st := svc.WorldContextRegistryStats(); st.RunContexts != 1 {
		t.Fatalf("A 的 pending 必须被释放，仅剩 B 的 task run, got %#v", st)
	}
	// 被作废的 handle 不可再 claim。
	claim, status := svc.claimAnalysisHandle(view.AnalysisHandle, worldcontext.ConsumerWriting, "workspace:ws|session:s1")
	if claim != nil || status == AnalysisHandleClaimed {
		t.Fatal("冲突作废的 handle 不允许再次 claim")
	}
	svc.ReleaseWorldRun(worldcontext.ConsumerWriting, wr.scopeKey)
}

func TestWritingResolve_InvalidHandleFallback(t *testing.T) {
	_, svc, w, rev := writingSvcHarness(t)
	ctx := context.Background()
	ref := worldRef(w, rev)

	// 失效 handle + 有效 Ref：仍按 Ref 绑定，handle 记为 ignored_invalid。
	wr, err := svc.resolveWritingRun(ctx, "13", "workspace:ws|session:s1", WritingWorldControl{
		Ref: &ref, HasAnalysisHandle: true, AnalysisHandle: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	if err != nil {
		t.Fatalf("失效 handle 不应阻断 Ref: %v", err)
	}
	if wr == nil || wr.runContext == nil {
		t.Fatal("有效 Ref 必须绑定成功")
	}
	if wr.handleStatus != AnalysisHandleIgnoredInvalid {
		t.Fatalf("失效 handle 状态应为 ignored_invalid, got %q", wr.handleStatus)
	}
	svc.ReleaseWorldRun(worldcontext.ConsumerWriting, wr.scopeKey)

	// 失效 handle 且无 Ref：bare，零增量。
	before := svc.WorldContextRegistryStats()
	wr2, err := svc.resolveWritingRun(ctx, "14", "workspace:ws|session:s1", WritingWorldControl{
		HasAnalysisHandle: true, AnalysisHandle: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	if err != nil || wr2 != nil {
		t.Fatalf("失效 handle 无 Ref 必须回落 bare, wr=%+v err=%v", wr2, err)
	}
	if after := svc.WorldContextRegistryStats(); after.RunContexts != before.RunContexts {
		t.Fatalf("bare 回落必须零 runContext 增量: before=%#v after=%#v", before, after)
	}
}

func TestWritingResolve_BlockingRefRevisionConflict(t *testing.T) {
	_, svc, w, _ := writingSvcHarness(t)
	bad := worldcontext.Ref{
		WorldID:               w.ID,
		ExpectedWorldRevision: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
		Selection:             worldcontext.Selection{IncludeTone: true},
	}
	wr, err := svc.resolveWritingRun(context.Background(), "15", "", WritingWorldControl{Ref: &bad})
	if err == nil || wr != nil {
		t.Fatalf("revision 冲突必须阻断且不产生 run, wr=%+v err=%v", wr, err)
	}
	if worldcontext.CodeOf(err) != worldcontext.ErrRevisionConflict {
		t.Fatalf("应为 revision_conflict, got %v", err)
	}
	if st := svc.WorldContextRegistryStats(); st.RunContexts != 0 {
		t.Fatalf("阻断后不得残留 runContext, got %#v", st)
	}
}

func TestWritingResolve_SessionSwitchInvalidatesPendingHandle(t *testing.T) {
	_, svc, w, rev := writingSvcHarness(t)
	ctx := context.Background()
	ref := worldRef(w, rev)
	view, err := svc.createAnalysisHandle(ctx, worldcontext.ConsumerWriting, "workspace:ws|session:old", ref)
	if err != nil {
		t.Fatalf("准备 handle 失败: %v", err)
	}
	// 不同会话键不影响该 handle。
	if n := svc.invalidateWritingHandlesForSession("workspace:ws|session:other"); n != 0 {
		t.Fatalf("不同会话键不应失效任何 handle, got %d", n)
	}
	// 切换旧会话：失效 1 个并释放其 pending runContext。
	if n := svc.invalidateWritingHandlesForSession("workspace:ws|session:old"); n != 1 {
		t.Fatalf("应失效 1 个旧会话 handle, got %d", n)
	}
	if st := svc.WorldContextRegistryStats(); st.RunContexts != 0 {
		t.Fatalf("失效后 pending runContext 必须释放, got %#v", st)
	}
	// 之后无法再 claim，只能 bare。
	wr, err := svc.resolveWritingRun(ctx, "16", "workspace:ws|session:old", WritingWorldControl{
		HasAnalysisHandle: true, AnalysisHandle: view.AnalysisHandle,
	})
	if err != nil || wr != nil {
		t.Fatalf("会话切换后旧 handle 必须不可用并回落 bare, wr=%+v err=%v", wr, err)
	}
}

func TestWritingResolve_ConcurrentClaimOnlyOneWins(t *testing.T) {
	_, svc, w, rev := writingSvcHarness(t)
	ctx := context.Background()
	ref := worldRef(w, rev)
	view, err := svc.createAnalysisHandle(ctx, worldcontext.ConsumerWriting, "workspace:ws|session:s1", ref)
	if err != nil {
		t.Fatalf("准备 handle 失败: %v", err)
	}

	const n = 24
	var wg sync.WaitGroup
	var mu sync.Mutex
	winners := 0
	var winnerClaim *AnalysisHandleClaim
	start := make(chan struct{})
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			<-start
			claim, status := svc.claimAnalysisHandle(view.AnalysisHandle, worldcontext.ConsumerWriting, "workspace:ws|session:s1")
			if status == AnalysisHandleClaimed {
				mu.Lock()
				winners++
				winnerClaim = claim
				mu.Unlock()
			}
		}()
	}
	close(start)
	wg.Wait()

	if winners != 1 {
		t.Fatalf("并发 claim 必须恰好 1 个成功, got %d", winners)
	}
	// 唯一赢家回滚，释放 pending 恰好一次，runContext 归零且无负 refCount。
	if !svc.rollbackAnalysisClaim(winnerClaim) {
		t.Fatal("唯一赢家应可回滚")
	}
	if svc.rollbackAnalysisClaim(winnerClaim) {
		t.Fatal("重复回滚必须 noop")
	}
	if st := svc.WorldContextRegistryStats(); st.RunContexts != 0 {
		t.Fatalf("回滚后 runContext 必须清空, got %#v", st)
	}
}
