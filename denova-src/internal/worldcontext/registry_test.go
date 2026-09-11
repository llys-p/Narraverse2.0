package worldcontext

import (
	"bytes"
	"sync"
	"testing"
	"time"
)

func testSnap(t *testing.T, sel Selection) *Snapshot {
	t.Helper()
	return mustBuild(t, ConsumerWriting, baseRef(sel), sampleWorld())
}

func fakeClock() (func() time.Time, func(time.Duration), *time.Time) {
	now := time.Date(2026, 9, 11, 16, 0, 0, 0, time.UTC)
	clk := func() time.Time { return now }
	advance := func(d time.Duration) { now = now.Add(d) }
	return clk, advance, &now
}

func bindRun(t *testing.T, r *Registry, scope string, sel Selection) (*RunContext, BindOutcome) {
	t.Helper()
	rc, outcome, err := r.Bind(BindInput{
		Consumer: ConsumerWriting, ScopeKey: scope, Snapshot: testSnap(t, sel),
		UISummary: UIViewSummary{WorldName: "测试世界"},
	})
	if err != nil {
		t.Fatalf("Bind scope=%s 失败: %v", scope, err)
	}
	return rc, outcome
}

func TestBind_CreateIdempotentReuseAndReplace(t *testing.T) {
	clk, _, _ := fakeClock()
	r := NewRegistryWithConfig(RegistryConfig{Now: clk})
	sel := Selection{CharacterIDs: []string{"c1"}}

	rc1, outcome := bindRun(t, r, "task:1", sel)
	if outcome != OutcomeCreated {
		t.Fatalf("首次应为 created，got %s", outcome)
	}
	if rc1.State() != StateBound {
		t.Fatalf("create 后应为 bound，got %s", rc1.State())
	}
	if st := r.Stats(); st.RunContexts != 1 || st.BodyEntries != 1 {
		t.Fatalf("创建后 stats 异常 %#v", st)
	}
	if rc, ok := r.bodyRefCount(rc1.Fingerprint()); !ok || rc != 1 {
		t.Fatalf("新 run 引用 body，refCount 应为 1，got %d ok=%v", rc, ok)
	}

	// 同 scope 同 fp → 幂等复用：同 id/同字节，不重复计 refCount。
	rc2, outcome := bindRun(t, r, "task:1", sel)
	if outcome != OutcomeReused || rc2.ID() != rc1.ID() {
		t.Fatalf("同 scope 同 fp 应幂等复用，outcome=%s idEq=%v", outcome, rc2.ID() == rc1.ID())
	}
	if !bytes.Equal(rc1.ModelViewBytes(), rc2.ModelViewBytes()) {
		t.Fatal("复用必须返回同一最终字节")
	}
	if rc, _ := r.bodyRefCount(rc1.Fingerprint()); rc != 1 {
		t.Fatalf("幂等复用不应增加 refCount，got %d", rc)
	}

	// reuse 路径置 active，字节不变。
	got, err := r.Reuse(ConsumerWriting, "task:1", "")
	if err != nil || got.State() != StateActive || !bytes.Equal(got.ModelViewBytes(), rc1.ModelViewBytes()) {
		t.Fatalf("Reuse 应返回 active 且字节不变，err=%v state=%s", err, got.State())
	}

	// 同 scope 换 fp → replace：新 id/新字节，旧 body 引用被释放。
	oldFP := rc1.Fingerprint()
	sel2 := Selection{CharacterIDs: []string{"c1", "c2"}}
	rc3, outcome := bindRun(t, r, "task:1", sel2)
	if outcome != OutcomeReplaced || rc3.ID() == rc1.ID() || rc3.Fingerprint() == oldFP {
		t.Fatalf("换背景应 replace 为新 run，outcome=%s", outcome)
	}
	if bytes.Equal(rc3.ModelViewBytes(), rc1.ModelViewBytes()) {
		t.Fatal("替换后最终字节必须不同")
	}
	// 替换释放旧 body 引用：条目按 idle TTL 延迟删除，但 refCount 必须已归零。
	if rc, ok := r.bodyRefCount(oldFP); !ok || rc != 0 {
		t.Fatalf("替换后旧 body refCount 应归零（条目待 idle 释放），got rc=%d ok=%v", rc, ok)
	}
}

func TestBind_SharedBodyDifferentRunsDifferentSalt(t *testing.T) {
	clk, _, _ := fakeClock()
	r := NewRegistryWithConfig(RegistryConfig{Now: clk})
	sel := Selection{CharacterIDs: []string{"c1", "c2"}, IncludeTone: true}

	a, _ := bindRun(t, r, "task:a", sel)
	b, _ := bindRun(t, r, "task:b", sel)
	if a.Fingerprint() != b.Fingerprint() {
		t.Fatal("同选择 fingerprint 必须相同")
	}
	if st := r.Stats(); st.BodyEntries != 1 || st.RunContexts != 2 {
		t.Fatalf("body 应共享一份、run 两条，got %#v", st)
	}
	if rc, _ := r.bodyRefCount(a.Fingerprint()); rc != 2 {
		t.Fatalf("两 run 共享 body，refCount=2，got %d", rc)
	}
	if bytes.Equal(a.ModelViewBytes(), b.ModelViewBytes()) {
		t.Fatal("不同 run 的 runSalt/sourceRef/最终字节必须不同")
	}
	// sourceRef 表每 run 独立。
	if eq := mapsEqual(a.SourceRefTable(), b.SourceRefTable()); eq {
		t.Fatal("不同 run 的 sourceRefTable 必须不同")
	}

	if !r.Destroy(ConsumerWriting, "task:a") {
		t.Fatal("destroy a 应命中")
	}
	if rc, _ := r.bodyRefCount(a.Fingerprint()); rc != 1 {
		t.Fatalf("销毁一条后 refCount=1，got %d", rc)
	}
	r.Destroy(ConsumerWriting, "task:b")
	if rc, ok := r.bodyRefCount(a.Fingerprint()); rc != 0 || !ok {
		t.Fatalf("全部销毁后 refCount=0（条目暂留待 idle 释放），got %d ok=%v", rc, ok)
	}
}

func TestRegistry_BodyFreedOnlyAfterIdleTTL(t *testing.T) {
	clk, advance, _ := fakeClock()
	r := NewRegistryWithConfig(RegistryConfig{Now: clk, BodyIdleTTL: 30 * time.Minute})
	sel := Selection{CharacterIDs: []string{"c1"}}
	rc, _ := bindRun(t, r, "task:1", sel)
	fp := rc.Fingerprint()
	r.Destroy(ConsumerWriting, "task:1")

	advance(29 * time.Minute)
	r.Sweep()
	if _, ok := r.bodyRefCount(fp); !ok {
		t.Fatal("未满 body idle TTL 不应释放")
	}
	advance(2 * time.Minute)
	res := r.Sweep()
	if res.BodiesFreed != 1 {
		t.Fatalf("满 idle TTL 应释放 1 条，got %d", res.BodiesFreed)
	}
	if _, ok := r.bodyRefCount(fp); ok {
		t.Fatal("释放后 body 条目应删除")
	}
}

func TestRegistry_RunIdleAndAbsoluteTTL(t *testing.T) {
	clk, advance, _ := fakeClock()
	r := NewRegistryWithConfig(RegistryConfig{
		Now: clk, RunIdleTTL: 30 * time.Minute, RunMaxTTL: 6 * time.Hour,
	})
	rc, _ := bindRun(t, r, "task:1", Selection{CharacterIDs: []string{"c1"}})

	advance(29 * time.Minute)
	if _, err := r.Reuse(ConsumerWriting, "task:1", ""); err != nil {
		t.Fatalf("idle 未到应可复用: %v", err)
	}
	// Reuse 刷新了 idle；再走 29 分钟仍未到 idle，但绝对寿命接近。
	advance(29 * time.Minute)
	if _, err := r.Reuse(ConsumerWriting, "task:1", ""); err != nil {
		t.Fatalf("idle 被刷新后应仍可复用: %v", err)
	}
	// 直接把绝对寿命推过 6h（相对 createdAt）。
	advance(6 * time.Hour)
	if _, err := r.Reuse(ConsumerWriting, "task:1", ""); CodeOf(err) != ErrContextUnavailable {
		t.Fatalf("超过 absolute TTL 应 context_unavailable，got %v", err)
	}
	if st := r.Stats(); st.RunContexts != 0 {
		t.Fatalf("过期 run 应在取回时清理，got %d", st.RunContexts)
	}
	_ = rc
}

func TestRegistry_RunLRUCap(t *testing.T) {
	clk, advance, _ := fakeClock()
	r := NewRegistryWithConfig(RegistryConfig{Now: clk, MaxRunContexts: 2})
	s1 := Selection{CharacterIDs: []string{"c1"}}
	s2 := Selection{CharacterIDs: []string{"c2"}}
	s3 := Selection{LocationIDs: []string{"l1"}}
	bindRun(t, r, "task:1", s1)
	advance(time.Minute)
	bindRun(t, r, "task:2", s2)
	advance(time.Minute)
	// 第三条触发 LRU，最久未用 task:1 被淘汰。
	bindRun(t, r, "task:3", s3)
	if st := r.Stats(); st.RunContexts != 2 {
		t.Fatalf("run 上限 2，got %d", st.RunContexts)
	}
	if _, err := r.Reuse(ConsumerWriting, "task:1", ""); CodeOf(err) != ErrContextUnavailable {
		t.Fatalf("被 LRU 淘汰的 task:1 应 unavailable，got %v", err)
	}
	for _, sk := range []string{"task:2", "task:3"} {
		if _, err := r.Reuse(ConsumerWriting, sk, ""); err != nil {
			t.Fatalf("%s 应仍在，got %v", sk, err)
		}
	}
}

func TestRegistry_BodyLRUPrefersFree(t *testing.T) {
	clk, advance, _ := fakeClock()
	// 容量 2：第三条不同 fp 插入时，优先淘汰 refCount==0 的最久未用 body。
	r := NewRegistryWithConfig(RegistryConfig{Now: clk, MaxBodyEntries: 2, BodyIdleTTL: time.Nanosecond})
	a, _ := bindRun(t, r, "task:a", Selection{CharacterIDs: []string{"c1"}})
	b, _ := bindRun(t, r, "task:b", Selection{CharacterIDs: []string{"c2"}})
	// 释放 a，使其 refCount==0；b 仍在用。
	r.Destroy(ConsumerWriting, "task:a")
	// 时钟前进超过极小 idle TTL 后 sweep 清掉 a。
	advance(time.Millisecond)
	r.Sweep()
	if _, ok := r.bodyRefCount(a.Fingerprint()); ok {
		t.Fatal("a 应已被 idle 释放")
	}
	// 再插两条，容量 2 下 LRU 生效且不 panic；在用户 b 最后才可能被挤掉。
	bindRun(t, r, "task:c", Selection{LocationIDs: []string{"l1"}})
	bindRun(t, r, "task:d", Selection{LocationIDs: []string{"l1", "l2"}})
	if st := r.Stats(); st.BodyEntries > 2 {
		t.Fatalf("body 上限 2，got %d", st.BodyEntries)
	}
	_ = b
}

func TestReuse_FingerprintMismatch(t *testing.T) {
	clk, _, _ := fakeClock()
	r := NewRegistryWithConfig(RegistryConfig{Now: clk})
	rc, _ := bindRun(t, r, "task:1", Selection{CharacterIDs: []string{"c1"}})
	other := testSnap(t, Selection{CharacterIDs: []string{"c1", "c2"}}).ContextFingerprint
	if other == rc.Fingerprint() {
		t.Fatal("测试前提：两个 selection 的 fingerprint 应不同")
	}
	if _, err := r.Reuse(ConsumerWriting, "task:1", other); CodeOf(err) != ErrContextRefMismatch {
		t.Fatalf("续接 fp 不一致应 context_ref_mismatch，got %v", err)
	}
	// mismatch 不破坏既有绑定。
	if _, err := r.Reuse(ConsumerWriting, "task:1", rc.Fingerprint()); err != nil {
		t.Fatalf("匹配 fp 仍应可复用: %v", err)
	}
}

func TestGetByID_CrossConsumerAndUnknown(t *testing.T) {
	clk, _, _ := fakeClock()
	r := NewRegistryWithConfig(RegistryConfig{Now: clk})
	rc, _ := bindRun(t, r, "task:1", Selection{CharacterIDs: []string{"c1"}})
	if got, err := r.GetByID(rc.ID(), ConsumerWriting); err != nil || got.ID() != rc.ID() {
		t.Fatalf("按 id 应取回，err=%v", err)
	}
	if _, err := r.GetByID(rc.ID(), ConsumerGame); CodeOf(err) != ErrConsumerNotTrusted {
		t.Fatalf("跨 consumer 应 consumer_not_trusted，got %v", err)
	}
	if _, err := r.GetByID("nonexistent", ConsumerWriting); CodeOf(err) != ErrContextUnavailable {
		t.Fatalf("未知 id 应 context_unavailable，got %v", err)
	}
}

func TestMoveScopeByID_PreservesRunAndBodyReference(t *testing.T) {
	clk, _, _ := fakeClock()
	r := NewRegistryWithConfig(RegistryConfig{Now: clk})
	rc, _ := bindRun(t, r, "analysis:pending", Selection{CharacterIDs: []string{"c1", "c2"}})

	idBefore := rc.ID()
	bytesBefore := rc.ModelViewBytes()
	refsBefore := rc.SourceRefTable()
	fingerprint := rc.Fingerprint()
	refCountBefore, _ := r.bodyRefCount(fingerprint)

	moved, err := r.MoveScopeByID(
		ConsumerWriting,
		idBefore,
		"analysis:pending",
		"interactive:run-1",
		fingerprint,
	)
	if err != nil {
		t.Fatalf("MoveScopeByID 失败: %v", err)
	}
	if moved.ID() != idBefore {
		t.Fatalf("move 必须保留 runContext ID，before=%s after=%s", idBefore, moved.ID())
	}
	if moved.ScopeKey() != "interactive:run-1" {
		t.Fatalf("move 后 scope 错误: %s", moved.ScopeKey())
	}
	if !bytes.Equal(moved.ModelViewBytes(), bytesBefore) {
		t.Fatal("move 必须逐字节保留最终 ModelView")
	}
	if !mapsEqual(moved.SourceRefTable(), refsBefore) {
		t.Fatal("move 必须保留 sourceRefTable")
	}
	if got, _ := r.bodyRefCount(fingerprint); got != refCountBefore {
		t.Fatalf("move 不得改变 body refCount，before=%d after=%d", refCountBefore, got)
	}
	if _, err := r.Reuse(ConsumerWriting, "analysis:pending", fingerprint); CodeOf(err) != ErrContextUnavailable {
		t.Fatalf("旧 scope 必须解除，got %v", err)
	}
	if got, err := r.Reuse(ConsumerWriting, "interactive:run-1", fingerprint); err != nil || got.ID() != idBefore {
		t.Fatalf("新 scope 必须复用原 run，got id=%v err=%v", idOf(got), err)
	}
}

func TestMoveScopeByID_IdempotentRetryDoesNotChangeRefCount(t *testing.T) {
	clk, _, _ := fakeClock()
	r := NewRegistryWithConfig(RegistryConfig{Now: clk})
	rc, _ := bindRun(t, r, "analysis:pending", Selection{CharacterIDs: []string{"c1"}})
	fingerprint := rc.Fingerprint()

	if _, err := r.MoveScopeByID(ConsumerWriting, rc.ID(), "analysis:pending", "interactive:run-1", fingerprint); err != nil {
		t.Fatalf("首次 move 失败: %v", err)
	}
	firstBytes := rc.ModelViewBytes()
	if got, err := r.MoveScopeByID(ConsumerWriting, rc.ID(), "analysis:pending", "interactive:run-1", fingerprint); err != nil || got.ID() != rc.ID() {
		t.Fatalf("同一 move 重试应幂等成功，got id=%v err=%v", idOf(got), err)
	}
	if !bytes.Equal(rc.ModelViewBytes(), firstBytes) {
		t.Fatal("幂等重试不得重新物化最终 ModelView")
	}
	if got, _ := r.bodyRefCount(fingerprint); got != 1 {
		t.Fatalf("幂等重试不得重复计 refCount，got %d", got)
	}
}

func TestMoveScopeByID_ValidationFailuresAreAtomic(t *testing.T) {
	clk, _, _ := fakeClock()
	r := NewRegistryWithConfig(RegistryConfig{Now: clk})
	source, _ := bindRun(t, r, "analysis:pending", Selection{CharacterIDs: []string{"c1"}})
	target, _ := bindRun(t, r, "interactive:occupied", Selection{CharacterIDs: []string{"c2"}})
	sourceBytes := source.ModelViewBytes()
	sourceFP := source.Fingerprint()
	targetFP := target.Fingerprint()

	cases := []struct {
		name     string
		consumer Consumer
		id       string
		from     string
		to       string
		fp       string
		wantCode ErrorCode
	}{
		{name: "cross consumer", consumer: ConsumerGame, id: source.ID(), from: "analysis:pending", to: "interactive:new", fp: sourceFP, wantCode: ErrConsumerNotTrusted},
		{name: "unknown id", consumer: ConsumerWriting, id: "missing", from: "analysis:pending", to: "interactive:new", fp: sourceFP, wantCode: ErrContextUnavailable},
		{name: "wrong source", consumer: ConsumerWriting, id: source.ID(), from: "analysis:other", to: "interactive:new", fp: sourceFP, wantCode: ErrContextRefMismatch},
		{name: "wrong fingerprint", consumer: ConsumerWriting, id: source.ID(), from: "analysis:pending", to: "interactive:new", fp: targetFP, wantCode: ErrContextRefMismatch},
		{name: "occupied target", consumer: ConsumerWriting, id: source.ID(), from: "analysis:pending", to: "interactive:occupied", fp: sourceFP, wantCode: ErrContextRefMismatch},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := r.MoveScopeByID(tc.consumer, tc.id, tc.from, tc.to, tc.fp); CodeOf(err) != tc.wantCode {
				t.Fatalf("want %s, got %v", tc.wantCode, err)
			}
			if got, err := r.Reuse(ConsumerWriting, "analysis:pending", sourceFP); err != nil || got.ID() != source.ID() {
				t.Fatalf("失败后源绑定必须完整，got id=%v err=%v", idOf(got), err)
			}
			if got, err := r.Reuse(ConsumerWriting, "interactive:occupied", targetFP); err != nil || got.ID() != target.ID() {
				t.Fatalf("失败后目标绑定必须完整，got id=%v err=%v", idOf(got), err)
			}
			if !bytes.Equal(source.ModelViewBytes(), sourceBytes) {
				t.Fatal("失败不得改变源 ModelView 字节")
			}
			if got, _ := r.bodyRefCount(sourceFP); got != 1 {
				t.Fatalf("失败不得改变源 refCount，got %d", got)
			}
			if got, _ := r.bodyRefCount(targetFP); got != 1 {
				t.Fatalf("失败不得改变目标 refCount，got %d", got)
			}
		})
	}
}

func TestBind_RejectsUntrustedConsumerAndEmptyScope(t *testing.T) {
	r := NewRegistry()
	snap := testSnap(t, Selection{})
	if _, _, err := r.Bind(BindInput{Consumer: ConsumerNarraverse, ScopeKey: "x", Snapshot: snap}); CodeOf(err) != ErrConsumerNotTrusted {
		t.Fatalf("narraverse 应被拒，got %v", err)
	}
	if _, _, err := r.Bind(BindInput{Consumer: ConsumerWriting, ScopeKey: "", Snapshot: snap}); CodeOf(err) != ErrInvalidRequest {
		t.Fatalf("空 scope 应 invalid_request，got %v", err)
	}
	if _, _, err := r.Bind(BindInput{Consumer: ConsumerWriting, ScopeKey: "x", Snapshot: nil}); CodeOf(err) != ErrInvalidRequest {
		t.Fatalf("nil snapshot 应 invalid_request，got %v", err)
	}
}

func TestRegistry_NoAutoRecoveryAfterRestart(t *testing.T) {
	clk, _, _ := fakeClock()
	r1 := NewRegistryWithConfig(RegistryConfig{Now: clk})
	bindRun(t, r1, "task:1", Selection{CharacterIDs: []string{"c1"}})
	// 模拟进程重启：全新注册表为空，旧 scope 不可恢复。
	r2 := NewRegistryWithConfig(RegistryConfig{Now: clk})
	if st := r2.Stats(); st.RunContexts != 0 || st.BodyEntries != 0 {
		t.Fatalf("重启后注册表必须为空，got %#v", st)
	}
	if _, err := r2.Reuse(ConsumerWriting, "task:1", ""); CodeOf(err) != ErrContextUnavailable {
		t.Fatalf("重启后旧 run 应 context_unavailable（不自动恢复），got %v", err)
	}
}

func TestRegistry_ConcurrentSameScopeIdempotent(t *testing.T) {
	r := NewRegistry()
	snap := testSnap(t, Selection{CharacterIDs: []string{"c1", "c2"}})
	const n = 100
	var wg sync.WaitGroup
	ids := make(chan string, n)
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			rc, _, err := r.Bind(BindInput{Consumer: ConsumerWriting, ScopeKey: "task:same", Snapshot: snap})
			if err != nil {
				t.Errorf("并发 Bind 失败: %v", err)
				return
			}
			ids <- rc.ID()
		}()
	}
	wg.Wait()
	close(ids)
	first := ""
	count := 0
	for id := range ids {
		if first == "" {
			first = id
		}
		if id != first {
			t.Fatalf("同 scope 同 fp 并发必须幂等为同一 run，出现不同 id %s vs %s", first, id)
		}
		count++
	}
	if count != n {
		t.Fatalf("应返回 %d 个结果，got %d", n, count)
	}
	if st := r.Stats(); st.RunContexts != 1 || st.BodyEntries != 1 {
		t.Fatalf("并发幂等后应只有 1 run/1 body，got %#v", st)
	}
	if rc, _ := r.bodyRefCount(snap.ContextFingerprint); rc != 1 {
		t.Fatalf("幂等 bind 不应重复计 refCount，got %d", rc)
	}
}

func TestRegistry_ConcurrentDistinctScopesRefCount(t *testing.T) {
	r := NewRegistry()
	snap := testSnap(t, Selection{CharacterIDs: []string{"c1"}})
	const n = 40
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		scope := "task:" + string(rune('a'+i%26)) + string(rune('a'+i/26)) + "-" + itoa(i)
		go func(sk string) {
			defer wg.Done()
			if _, _, err := r.Bind(BindInput{Consumer: ConsumerWriting, ScopeKey: sk, Snapshot: snap}); err != nil {
				t.Errorf("并发 Bind %s 失败: %v", sk, err)
			}
		}(scope)
	}
	wg.Wait()
	if st := r.Stats(); st.RunContexts != n || st.BodyEntries != 1 {
		t.Fatalf("应有 %d run 共享 1 body，got %#v", n, st)
	}
	if rc, _ := r.bodyRefCount(snap.ContextFingerprint); rc != n {
		t.Fatalf("共享 body refCount 应=%d，got %d", n, rc)
	}
}

func TestRegistry_ConcurrentMixedOpsNoRace(t *testing.T) {
	clk, advance, _ := fakeClock()
	r := NewRegistryWithConfig(RegistryConfig{Now: clk, MaxRunContexts: 128})
	sel := []Selection{
		{CharacterIDs: []string{"c1"}},
		{CharacterIDs: []string{"c2"}},
		{LocationIDs: []string{"l1"}},
		{FactionIDs: []string{"f1"}},
	}
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for k := 0; k < 200; k++ {
				scope := "task:g" + itoa(g) + "-k" + itoa(k%8)
				s := sel[(g+k)%len(sel)]
				if rc, _, err := r.Bind(BindInput{Consumer: ConsumerWriting, ScopeKey: scope, Snapshot: testSnap(t, s)}); err == nil {
					_, _ = r.Reuse(ConsumerWriting, scope, "")
					_, _ = r.GetByID(rc.ID(), ConsumerWriting)
					if k%3 == 0 {
						r.Destroy(ConsumerWriting, scope)
					}
				}
			}
		}(g)
	}
	// 并发放一个 sweep。
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 50; i++ {
			advance(time.Second)
			r.Sweep()
		}
	}()
	wg.Wait()
	// 结束后 refCount 不得为负、run 数不超上限、body 数不超上限。
	st := r.Stats()
	if st.RunContexts > 128 || st.BodyEntries > DefaultMaxBodyEntries {
		t.Fatalf("混合并发后超容量：%#v", st)
	}
	for _, fp := range r.sortedFingerprints() {
		if rc, _ := r.bodyRefCount(fp); rc < 0 {
			t.Fatalf("body %s refCount 为负 %d", fp, rc)
		}
	}
}

func mapsEqual(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

func idOf(rc *RunContext) string {
	if rc == nil {
		return ""
	}
	return rc.ID()
}

// itoa 避免在测试里再引 strconv 的轻量整数转字符串。
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [12]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
