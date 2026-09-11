package app

import (
	"context"
	"sync"
	"testing"
	"time"

	"denova/internal/worldcontext"
)

type analysisTestClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *analysisTestClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *analysisTestClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

func newAnalysisTestService(t *testing.T) (*WorldContextService, worldcontext.Ref, *analysisTestClock) {
	t.Helper()
	a, w, rev := newWorldContextTestApp(t)
	clock := &analysisTestClock{now: time.Date(2026, 9, 11, 12, 0, 0, 0, time.UTC)}
	registry := worldcontext.NewRegistryWithConfig(worldcontext.RegistryConfig{
		RunIdleTTL:  time.Hour,
		RunMaxTTL:   2 * time.Hour,
		BodyIdleTTL: time.Minute,
		Now:         clock.Now,
	})
	svc := &WorldContextService{app: a, registry: registry}
	svc.analysisHandles = newAnalysisHandleRegistry(registry, analysisHandleConfig{
		TTL: 10 * time.Minute,
		Now: clock.Now,
	})
	return svc, worldRef(w, rev), clock
}

func createAnalysisHandleForTest(t *testing.T, svc *WorldContextService, ref worldcontext.Ref, session string) AnalysisHandleView {
	t.Helper()
	view, err := svc.createAnalysisHandle(context.Background(), worldcontext.ConsumerWriting, session, ref)
	if err != nil {
		t.Fatalf("createAnalysisHandle: %v", err)
	}
	if view.AnalysisHandle == "" || view.ExpiresAt.IsZero() {
		t.Fatalf("handle view 不完整: %#v", view)
	}
	return view
}

func TestAnalysisHandle_CreateIsIdempotentAndDoesNotCreateTask(t *testing.T) {
	svc, ref, _ := newAnalysisTestService(t)
	tasksBefore := taskSeq.Load()

	first := createAnalysisHandleForTest(t, svc, ref, "writing-session-1")
	second := createAnalysisHandleForTest(t, svc, ref, "writing-session-1")

	if first != second {
		t.Fatalf("同 key 的未消费 handle 应幂等复用: first=%#v second=%#v", first, second)
	}
	if got := taskSeq.Load(); got != tasksBefore {
		t.Fatalf("analysis 阶段不得创建 Pending Task: before=%d after=%d", tasksBefore, got)
	}
	if stats := svc.WorldContextRegistryStats(); stats.RunContexts != 1 || stats.BodyEntries != 1 {
		t.Fatalf("幂等创建只应保留一个 pending context: %#v", stats)
	}
}

func TestAnalysisHandle_ClaimIsSingleUse(t *testing.T) {
	svc, ref, _ := newAnalysisTestService(t)
	view := createAnalysisHandleForTest(t, svc, ref, "writing-session-1")

	claim, status := svc.claimAnalysisHandle(view.AnalysisHandle, worldcontext.ConsumerWriting)
	if status != AnalysisHandleClaimed || claim == nil {
		t.Fatalf("首次 claim 应成功: status=%s claim=%#v", status, claim)
	}
	if second, secondStatus := svc.claimAnalysisHandle(view.AnalysisHandle, worldcontext.ConsumerWriting); second != nil || secondStatus != AnalysisHandleIgnoredConsumed {
		t.Fatalf("同一 handle 不得二次 claim: status=%s claim=%#v", secondStatus, second)
	}

	lease := claim.pendingContextLease()
	if lease.RunContextID == "" {
		t.Fatalf("claim 应携带待迁移的 pending lease: %#v", lease)
	}
	if status := svc.consumeAnalysisHandle(claim); status != AnalysisHandleConsumed {
		t.Fatalf("claim owner 应能完成一次消费: status=%s", status)
	}
	if status := svc.consumeAnalysisHandle(claim); status != AnalysisHandleIgnoredConsumed {
		t.Fatalf("同一 claim 不得二次消费: status=%s", status)
	}

	// P4.1 不做实际 Task/InteractiveRun 迁移；测试显式释放消费后 lease。
	if !svc.ReleaseWorldRun(lease.Consumer, lease.PendingScopeKey) {
		t.Fatal("消费后的 lease 应仍唯一拥有 runContext")
	}
}

func TestAnalysisHandle_CancelAndClaimRaceHasOneOwner(t *testing.T) {
	for i := 0; i < 64; i++ {
		svc, ref, _ := newAnalysisTestService(t)
		view := createAnalysisHandleForTest(t, svc, ref, "race-session")
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)

		var claim *AnalysisHandleClaim
		var claimStatus AnalysisHandleUseStatus
		go func() {
			defer wg.Done()
			<-start
			claim, claimStatus = svc.claimAnalysisHandle(view.AnalysisHandle, worldcontext.ConsumerWriting)
		}()

		var cancelOutcome AnalysisHandleInvalidateOutcome
		go func() {
			defer wg.Done()
			<-start
			cancelOutcome = svc.invalidateAnalysisHandle(view.AnalysisHandle, worldcontext.ConsumerWriting)
		}()

		close(start)
		wg.Wait()

		switch claimStatus {
		case AnalysisHandleClaimed:
			if cancelOutcome != AnalysisHandleInvalidateClaimed {
				t.Fatalf("claim 赢得所有权后 cancel 只能标记 claimed: claim=%s cancel=%s", claimStatus, cancelOutcome)
			}
			if status := svc.consumeAnalysisHandle(claim); status != AnalysisHandleIgnoredConsumed {
				t.Fatalf("已被取消的 claim 不得消费: status=%s", status)
			}
		case AnalysisHandleIgnoredConsumed:
			if claim != nil || cancelOutcome != AnalysisHandleInvalidated {
				t.Fatalf("cancel 赢得所有权时 claim 必须失败: claim=%#v cancel=%s", claim, cancelOutcome)
			}
		default:
			t.Fatalf("竞态出现未冻结状态: %s", claimStatus)
		}

		if stats := svc.WorldContextRegistryStats(); stats.RunContexts != 0 {
			t.Fatalf("竞态收敛后不得残留 pending context: %#v", stats)
		}
	}
}

func TestAnalysisHandle_CancelAfterConsumeIsNoop(t *testing.T) {
	svc, ref, _ := newAnalysisTestService(t)
	view := createAnalysisHandleForTest(t, svc, ref, "writing-session-1")
	claim, status := svc.claimAnalysisHandle(view.AnalysisHandle, worldcontext.ConsumerWriting)
	if status != AnalysisHandleClaimed {
		t.Fatalf("claim: %s", status)
	}
	lease := claim.pendingContextLease()
	if status := svc.consumeAnalysisHandle(claim); status != AnalysisHandleConsumed {
		t.Fatalf("consume: %s", status)
	}

	if got := svc.invalidateAnalysisHandle(view.AnalysisHandle, worldcontext.ConsumerWriting); got != AnalysisHandleInvalidateConsumedNoop {
		t.Fatalf("消费后取消必须是幂等无操作: %s", got)
	}
	if stats := svc.WorldContextRegistryStats(); stats.RunContexts != 1 {
		t.Fatalf("取消 consumed handle 不得释放运行身份拥有的上下文: %#v", stats)
	}
	if !svc.ReleaseWorldRun(lease.Consumer, lease.PendingScopeKey) {
		t.Fatal("消费后的上下文应仍可由 lease owner 释放")
	}
}

func TestAnalysisHandle_CancelRejectsDifferentConsumer(t *testing.T) {
	svc, ref, _ := newAnalysisTestService(t)
	view := createAnalysisHandleForTest(t, svc, ref, "writing-session-1")

	if got := svc.invalidateAnalysisHandle(view.AnalysisHandle, worldcontext.ConsumerGame); got != AnalysisHandleInvalidateMissingNoop {
		t.Fatalf("其它 consumer 不得取消 handle: %s", got)
	}
	claim, status := svc.claimAnalysisHandle(view.AnalysisHandle, worldcontext.ConsumerWriting)
	if status != AnalysisHandleClaimed || claim == nil {
		t.Fatalf("原 consumer 的 handle 不应受影响: status=%s claim=%#v", status, claim)
	}
	if !svc.rollbackAnalysisClaim(claim) {
		t.Fatal("测试收尾应释放 pending context")
	}
}

func TestAnalysisHandle_ExpiredCannotBeClaimed(t *testing.T) {
	svc, ref, clock := newAnalysisTestService(t)
	view := createAnalysisHandleForTest(t, svc, ref, "writing-session-1")
	clock.Advance(10*time.Minute + time.Nanosecond)

	if claim, status := svc.claimAnalysisHandle(view.AnalysisHandle, worldcontext.ConsumerWriting); claim != nil || status != AnalysisHandleIgnoredExpired {
		t.Fatalf("过期 handle 不得 claim: status=%s claim=%#v", status, claim)
	}
	if stats := svc.WorldContextRegistryStats(); stats.RunContexts != 0 {
		t.Fatalf("过期应同时释放 pending context: %#v", stats)
	}
}

func TestAnalysisHandle_ClaimedExpiryReleasesOnce(t *testing.T) {
	svc, ref, clock := newAnalysisTestService(t)
	view := createAnalysisHandleForTest(t, svc, ref, "writing-session-1")
	claim, status := svc.claimAnalysisHandle(view.AnalysisHandle, worldcontext.ConsumerWriting)
	if status != AnalysisHandleClaimed {
		t.Fatalf("claim: %s", status)
	}
	clock.Advance(10*time.Minute + time.Nanosecond)
	result := svc.sweepAnalysisHandles()
	if result.HandlesRemoved != 1 || result.ContextsReleased != 1 {
		t.Fatalf("claimed TTL 回收应删除 handle 并释放一次 context: %#v", result)
	}
	if stats := svc.WorldContextRegistryStats(); stats.RunContexts != 0 {
		t.Fatalf("claimed 过期不得留下 runContext: %#v", stats)
	}
	if got := svc.consumeAnalysisHandle(claim); got != AnalysisHandleIgnoredConsumed {
		t.Fatalf("过期 claim 不得恢复消费: status=%s", got)
	}
	if svc.rollbackAnalysisClaim(claim) {
		t.Fatal("过期 sweep 已清理后 rollback 必须为 no-op")
	}
	if again := svc.sweepAnalysisHandles(); again.ContextsReleased != 0 || again.HandlesRemoved != 0 {
		t.Fatalf("重复 sweep 不得再次清理: %#v", again)
	}
}

func TestAnalysisHandle_ServiceRebuildDoesNotRestoreHandle(t *testing.T) {
	svc, ref, _ := newAnalysisTestService(t)
	view := createAnalysisHandleForTest(t, svc, ref, "writing-session-1")

	rebuilt := newWorldContextService(svc.app)
	if claim, status := rebuilt.claimAnalysisHandle(view.AnalysisHandle, worldcontext.ConsumerWriting); claim != nil || status != AnalysisHandleIgnoredInvalid {
		t.Fatalf("服务重建后不得恢复旧 handle: status=%s claim=%#v", status, claim)
	}
	if stats := rebuilt.WorldContextRegistryStats(); stats.RunContexts != 0 || stats.BodyEntries != 0 {
		t.Fatalf("服务重建后的注册表必须为空: %#v", stats)
	}
}

func TestAnalysisHandle_CapacityDoesNotEvictLivePendingContext(t *testing.T) {
	svc, ref, _ := newAnalysisTestService(t)
	svc.analysisHandles.maxHandles = 1
	first := createAnalysisHandleForTest(t, svc, ref, "writing-session-1")

	if _, err := svc.createAnalysisHandle(context.Background(), worldcontext.ConsumerWriting, "writing-session-2", ref); worldcontext.CodeOf(err) != worldcontext.ErrContextUnavailable {
		t.Fatalf("容量满时应拒绝新建而不是驱逐 live pending context: %v", err)
	}
	claim, status := svc.claimAnalysisHandle(first.AnalysisHandle, worldcontext.ConsumerWriting)
	if status != AnalysisHandleClaimed || claim == nil {
		t.Fatalf("容量拒绝不得破坏已有 handle: status=%s claim=%#v", status, claim)
	}
	if !svc.rollbackAnalysisClaim(claim) {
		t.Fatal("测试清理：claim rollback 应成功")
	}
	if _, err := svc.createAnalysisHandle(context.Background(), worldcontext.ConsumerWriting, "writing-session-2", ref); err != nil {
		t.Fatalf("已结算 tombstone 可在容量压力下提前移除: %v", err)
	}
}

func TestAnalysisHandle_DuplicateCleanupDoesNotUnderflowSharedBodyRefCount(t *testing.T) {
	svc, ref, clock := newAnalysisTestService(t)
	first := createAnalysisHandleForTest(t, svc, ref, "writing-session-1")
	second := createAnalysisHandleForTest(t, svc, ref, "writing-session-2")
	if stats := svc.WorldContextRegistryStats(); stats.RunContexts != 2 || stats.BodyEntries != 1 {
		t.Fatalf("两个 pending context 应共享一个 ProjectionBody: %#v", stats)
	}

	if got := svc.invalidateAnalysisHandle(first.AnalysisHandle, worldcontext.ConsumerWriting); got != AnalysisHandleInvalidated {
		t.Fatalf("首次取消: %s", got)
	}
	if got := svc.invalidateAnalysisHandle(first.AnalysisHandle, worldcontext.ConsumerWriting); got != AnalysisHandleInvalidateAlreadyNoop {
		t.Fatalf("重复取消应幂等: %s", got)
	}
	clock.Advance(2 * time.Minute)
	svc.sweepWorldContexts()
	if stats := svc.WorldContextRegistryStats(); stats.RunContexts != 1 || stats.BodyEntries != 1 {
		t.Fatalf("重复清理不得把仍被第二个 run 引用的 body 回收到零: %#v", stats)
	}

	if got := svc.invalidateAnalysisHandle(second.AnalysisHandle, worldcontext.ConsumerWriting); got != AnalysisHandleInvalidated {
		t.Fatalf("取消第二个 handle: %s", got)
	}
	svc.sweepAnalysisHandles()
	clock.Advance(2 * time.Minute)
	svc.sweepWorldContexts()
	if stats := svc.WorldContextRegistryStats(); stats.RunContexts != 0 || stats.BodyEntries != 0 {
		t.Fatalf("最后一个引用释放后 body 应可回收: %#v", stats)
	}
}

func TestAnalysisHandle_ClaimedCancellationUsesClaimantCleanupOnce(t *testing.T) {
	svc, ref, _ := newAnalysisTestService(t)
	view := createAnalysisHandleForTest(t, svc, ref, "writing-session-1")
	claim, status := svc.claimAnalysisHandle(view.AnalysisHandle, worldcontext.ConsumerWriting)
	if status != AnalysisHandleClaimed {
		t.Fatalf("claim: %s", status)
	}
	if got := svc.invalidateAnalysisHandle(view.AnalysisHandle, worldcontext.ConsumerWriting); got != AnalysisHandleInvalidateClaimed {
		t.Fatalf("claimed 取消应只转 invalidated: %s", got)
	}
	if stats := svc.WorldContextRegistryStats(); stats.RunContexts != 1 {
		t.Fatalf("取消方不得抢 claimant 的清理责任: %#v", stats)
	}

	if status := svc.consumeAnalysisHandle(claim); status != AnalysisHandleIgnoredConsumed {
		t.Fatalf("claimant 复核到取消后不得消费: status=%s", status)
	}
	if svc.rollbackAnalysisClaim(claim) {
		t.Fatal("consume 失败路径已经清理后，重复 rollback 应为 no-op")
	}
	if stats := svc.WorldContextRegistryStats(); stats.RunContexts != 0 {
		t.Fatalf("claimant 应恰好清理一次: %#v", stats)
	}
}
