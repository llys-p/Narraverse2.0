package app

import (
	"bytes"
	"context"
	"testing"

	"denova/internal/worldcontext"
)

// Phase 3.2-A4：context-analysis → analysisHandle → 首次 chat 的交接闭环测试。
// 只覆盖进程内编排，不启动模型/HTTP，不写 World。

const writingAnalysisSession = "workspace:ws|session:s1"

// 分析重复请求必须幂等：同一 handle、同一 pending runContext、同一到期时间（不延长 TTL），
// 且只保留一个 pending runContext。
func TestWritingAnalysis_CreateHandleIdempotentSameRunAndTTL(t *testing.T) {
	_, svc, w, rev := writingSvcHarness(t)
	ctx := context.Background()
	ref := worldRef(w, rev)

	first, firstRun, err := svc.createAnalysisHandleWithRun(ctx, worldcontext.ConsumerWriting, writingAnalysisSession, ref)
	if err != nil {
		t.Fatalf("首次分析建 handle 失败: %v", err)
	}
	if first.AnalysisHandle == "" || firstRun == nil {
		t.Fatalf("首次分析应返回 handle 与 pending run: %#v %#v", first, firstRun)
	}
	firstBytes := firstRun.ModelViewBytes()

	second, secondRun, err := svc.createAnalysisHandleWithRun(ctx, worldcontext.ConsumerWriting, writingAnalysisSession, ref)
	if err != nil {
		t.Fatalf("重复分析失败: %v", err)
	}
	if first.AnalysisHandle != second.AnalysisHandle {
		t.Fatalf("同 key 重复分析必须复用同一 handle: %q vs %q", first.AnalysisHandle, second.AnalysisHandle)
	}
	if !first.ExpiresAt.Equal(second.ExpiresAt) {
		t.Fatalf("幂等复用不得延长 TTL: first=%v second=%v", first.ExpiresAt, second.ExpiresAt)
	}
	if firstRun.ID() != secondRun.ID() {
		t.Fatalf("幂等复用必须返回同一 pending runContext: %q vs %q", firstRun.ID(), secondRun.ID())
	}
	if !bytes.Equal(firstBytes, secondRun.ModelViewBytes()) {
		t.Fatal("幂等复用的 ModelView bytes 必须逐字节一致")
	}
	if st := svc.WorldContextRegistryStats(); st.RunContexts != 1 {
		t.Fatalf("重复分析不得新建第二个 runContext: %#v", st)
	}
}

// 分析展示读取的 pending bytes 必须与首次 chat 迁移后送模的 bytes 逐字节一致
// （MoveScopeByID 不重投影、不换 salt、不复制 bytes）。
func TestWritingAnalysis_PendingBytesEqualMovedModelBytes(t *testing.T) {
	_, svc, w, rev := writingSvcHarness(t)
	ctx := context.Background()
	ref := worldRef(w, rev)

	view, pendingRun, err := svc.createAnalysisHandleWithRun(ctx, worldcontext.ConsumerWriting, writingAnalysisSession, ref)
	if err != nil {
		t.Fatalf("分析建 handle 失败: %v", err)
	}
	pendingBytes := pendingRun.ModelViewBytes()
	pendingFP := pendingRun.Fingerprint()

	wr, err := svc.resolveWritingRun(ctx, "task-a4", writingAnalysisSession, WritingWorldControl{
		HasAnalysisHandle: true, AnalysisHandle: view.AnalysisHandle,
	})
	if err != nil {
		t.Fatalf("首次 chat 消费 handle 失败: %v", err)
	}
	if wr == nil || wr.handleStatus != AnalysisHandleConsumed {
		t.Fatalf("应消费 handle 并迁移, got %+v", wr)
	}
	if wr.runContext.ID() != pendingRun.ID() {
		t.Fatalf("必须迁移同一 runContext，而不是新建: pending=%q moved=%q", pendingRun.ID(), wr.runContext.ID())
	}
	if wr.runContext.Fingerprint() != pendingFP {
		t.Fatal("迁移后指纹必须不变")
	}
	if !bytes.Equal(pendingBytes, wr.runContext.ModelViewBytes()) {
		t.Fatal("分析展示与首次 chat 送模的 ModelView bytes 必须逐字节一致")
	}
	if wr.runContext.ScopeKey() != "task:task-a4" {
		t.Fatalf("应迁移到 task scope, got %q", wr.runContext.ScopeKey())
	}
	if st := svc.WorldContextRegistryStats(); st.RunContexts != 1 {
		t.Fatalf("迁移不得新增 runContext: %#v", st)
	}
	svc.ReleaseWorldRun(worldcontext.ConsumerWriting, wr.scopeKey)
}

// A4.8：handle 必须校验会话归属；其它会话即便持有 token 也不得采用，无 Ref 时回落 bare。
func TestWritingAnalysis_HandleRejectedAcrossSession(t *testing.T) {
	_, svc, w, rev := writingSvcHarness(t)
	ctx := context.Background()
	ref := worldRef(w, rev)
	view, _, err := svc.createAnalysisHandleWithRun(ctx, worldcontext.ConsumerWriting, writingAnalysisSession, ref)
	if err != nil {
		t.Fatalf("建 handle 失败: %v", err)
	}

	// 用不同会话键 claim：必须 ignored_invalid，pending 仍归原会话。
	if claim, status := svc.claimAnalysisHandle(view.AnalysisHandle, worldcontext.ConsumerWriting, "workspace:ws|session:other"); claim != nil || status != AnalysisHandleIgnoredInvalid {
		t.Fatalf("跨会话 claim 必须 ignored_invalid: claim=%#v status=%s", claim, status)
	}

	// resolveWritingRun 用错误会话键 + 该 handle（无 Ref）：必须 bare，不迁移 pending。
	wr, err := svc.resolveWritingRun(ctx, "task-cross", "workspace:ws|session:other", WritingWorldControl{
		HasAnalysisHandle: true, AnalysisHandle: view.AnalysisHandle,
	})
	if err != nil {
		t.Fatalf("跨会话失效 handle 不应阻断: %v", err)
	}
	if wr != nil {
		t.Fatalf("跨会话不得采用 handle 背景, got %+v", wr)
	}
	// 原会话仍可正常消费。
	ok, err := svc.resolveWritingRun(ctx, "task-ok", writingAnalysisSession, WritingWorldControl{
		HasAnalysisHandle: true, AnalysisHandle: view.AnalysisHandle,
	})
	if err != nil || ok == nil || ok.handleStatus != AnalysisHandleConsumed {
		t.Fatalf("原会话应仍能消费 handle: wr=%+v err=%v", ok, err)
	}
	svc.ReleaseWorldRun(worldcontext.ConsumerWriting, "task:task-ok")
}

// 加固点：move 成功之后 consume 若被并发会话切换/过期命中而失败，runContext 已在 task scope，
// 必须仍可由 task 恰好释放一次、不产生负 refCount、不残留。
func TestWritingAnalysis_MovedRunSafeWhenConsumeLosesRace(t *testing.T) {
	_, svc, w, rev := writingSvcHarness(t)
	ctx := context.Background()
	ref := worldRef(w, rev)
	view, pendingRun, err := svc.createAnalysisHandleWithRun(ctx, worldcontext.ConsumerWriting, writingAnalysisSession, ref)
	if err != nil {
		t.Fatalf("建 handle 失败: %v", err)
	}
	leaseFP := pendingRun.Fingerprint()

	// 复现 resolveWritingRun 内部顺序：claim → move 到 task scope。
	claim, status := svc.claimAnalysisHandle(view.AnalysisHandle, worldcontext.ConsumerWriting, writingAnalysisSession)
	if status != AnalysisHandleClaimed {
		t.Fatalf("claim 应成功: %s", status)
	}
	moved, err := svc.registry.MoveScopeByID(
		worldcontext.ConsumerWriting, claim.lease.RunContextID, claim.lease.PendingScopeKey, "task:race-task", leaseFP,
	)
	if err != nil {
		t.Fatalf("move 失败: %v", err)
	}
	// move 之后、consume 之前发生会话切换：只标记/尝试清理原 pending scope（已迁走，Destroy noop）。
	if n := svc.invalidateWritingHandlesForSession(writingAnalysisSession); n != 1 {
		t.Fatalf("会话切换应失效 1 个 claimed handle, got %d", n)
	}
	consumeStatus := svc.consumeAnalysisHandle(claim)
	if consumeStatus == AnalysisHandleConsumed {
		t.Fatal("被并发失效后 consume 不得返回 consumed")
	}
	// runContext 已在 task scope，必须仍可恰好释放一次。
	if moved.ScopeKey() != "task:race-task" {
		t.Fatalf("runContext 应已在 task scope, got %q", moved.ScopeKey())
	}
	if !svc.ReleaseWorldRun(worldcontext.ConsumerWriting, "task:race-task") {
		t.Fatal("task scope 运行引用必须可释放")
	}
	if svc.ReleaseWorldRun(worldcontext.ConsumerWriting, "task:race-task") {
		t.Fatal("重复释放必须 noop，不得产生负 refCount")
	}
	if st := svc.WorldContextRegistryStats(); st.RunContexts != 0 {
		t.Fatalf("收敛后不得残留 runContext: %#v", st)
	}
}
