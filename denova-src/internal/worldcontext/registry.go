package worldcontext

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"sort"
	"sync"
	"time"
)

// P1：进程内两级注册表（v2.7 §6.2 / §6.5 / §6.6）。
//
// 边界（冻结）：
//   - 只保存“派生状态”：source-neutral ProjectionBody 缓存与每 run 独占的 RunContext；
//     绝不保存 world.World 副本、Ref 原文之外的任何持久化数据；
//   - 纯进程内存（map + mutex），不落盘、不写任务/故事存档、不写浏览器存储；
//   - 进程重启后注册表为空，不自动恢复、不追溯旧 Ref（后续请求 context_unavailable 降级）；
//   - 不读不写 World、不发起模型调用、不接触 HTTP/前端/Module3/4、不含 analysisHandle/task 接线。

// 默认容量与 TTL（v2.7 §6.2/§6.5 冻结值）。
const (
	DefaultMaxBodyEntries   = 32
	DefaultMaxBodyBytes     = 8 * 1024 * 1024
	DefaultMaxRunContexts   = 64
	DefaultRunIdleTTL       = 30 * time.Minute
	DefaultRunAbsoluteTTL   = 6 * time.Hour
	DefaultBodyIdleTTL      = 30 * time.Minute
	runSaltSize             = 32
	runContextIDRandomBytes = 32
)

// ContextState 是 runContext 的对外上下文状态（§7.5；bare 不建 RunContext）。
type ContextState string

const (
	StateBound    ContextState = "bound"
	StateActive   ContextState = "active"
	StateDegraded ContextState = "degraded"
)

// BindOutcome 描述一次 Bind 的结果（create / 幂等 reuse / 换背景 replace）。
type BindOutcome string

const (
	OutcomeCreated  BindOutcome = "created"
	OutcomeReused   BindOutcome = "reused"
	OutcomeReplaced BindOutcome = "replaced"
)

// UIViewSummary 是 runContext 内允许保留的最小展示摘要（不含正文/路径）。
type UIViewSummary struct {
	WorldName     string `json:"worldName"`
	RevisionLabel string `json:"revisionLabel"`
	SelectedCount int    `json:"selectedCount"`
}

// scopeKey 是 (consumer, scopeKey) 复合键；consumer 命名空间隔离（§6.3.1）。
type scopeKey struct {
	consumer Consumer
	scope    string
}

// bodyCacheEntry 是一级缓存：fingerprint → source-neutral body（可跨 run 共享）。
type bodyCacheEntry struct {
	fingerprint string
	body        *ProjectionBody
	bodyBytes   []byte
	sizeBytes   int
	refCount    int
	createdAt   time.Time
	lastUsedAt  time.Time
}

// RunContext 是二级绑定：每 run 独占最终产物。字段创建后不可变（仅 lastUsedAt/state 由注册表内部更新）。
type RunContext struct {
	id                    string
	consumer              Consumer
	scopeKey              string
	worldID               string
	expectedWorldRevision string
	fingerprint           string
	runSalt               []byte
	sourceRefTable        map[string]string
	modelView             *ModelView
	modelViewBytes        []byte
	uiSummary             UIViewSummary
	state                 ContextState
	createdAt             time.Time
	lastUsedAt            time.Time
}

// ID 返回服务端内部 runContextId（脱敏：不进对外 payload/日志，见 §9.3）。
func (c *RunContext) ID() string { return c.id }

// Consumer 返回绑定消费者。
func (c *RunContext) Consumer() Consumer { return c.consumer }

// ScopeKey 返回服务端内部 scope 键。
func (c *RunContext) ScopeKey() string { return c.scopeKey }

// WorldID 返回绑定的世界 id。
func (c *RunContext) WorldID() string { return c.worldID }

// ExpectedWorldRevision 返回绑定期望的世界 revision。
func (c *RunContext) ExpectedWorldRevision() string { return c.expectedWorldRevision }

// Fingerprint 返回 contextFingerprint（与 body 缓存键一致）。
func (c *RunContext) Fingerprint() string { return c.fingerprint }

// State 返回当前上下文状态。
func (c *RunContext) State() ContextState { return c.state }

// ModelView 返回本 run 物化的最终模型视图（调用方不得修改）。
func (c *RunContext) ModelView() *ModelView { return c.modelView }

// ModelViewBytes 返回最终 ModelView 的稳定序列化字节副本。
func (c *RunContext) ModelViewBytes() []byte { return append([]byte(nil), c.modelViewBytes...) }

// SourceRefTable 返回 slot → sourceRef 映射副本。
func (c *RunContext) SourceRefTable() map[string]string {
	out := make(map[string]string, len(c.sourceRefTable))
	for k, v := range c.sourceRefTable {
		out[k] = v
	}
	return out
}

// UISummary 返回展示摘要。
func (c *RunContext) UISummary() UIViewSummary { return c.uiSummary }

// CreatedAt 返回创建时间。
func (c *RunContext) CreatedAt() time.Time { return c.createdAt }

// LastUsedAt 返回最近使用时间。
func (c *RunContext) LastUsedAt() time.Time { return c.lastUsedAt }

// RegistryConfig 注入容量/TTL 与时钟，生产用默认值，测试可缩小 TTL 并注入可控时钟。
type RegistryConfig struct {
	MaxBodyEntries int
	MaxBodyBytes   int
	MaxRunContexts int
	RunIdleTTL     time.Duration
	RunMaxTTL      time.Duration
	BodyIdleTTL    time.Duration
	Now            func() time.Time
}

// RegistryStats 只暴露计数与字节数（诊断用，不含任何秘密/正文，§9.3）。
type RegistryStats struct {
	BodyEntries int
	BodyBytes   int
	RunContexts int
}

// Registry 是并发安全的两级进程内注册表。
type Registry struct {
	mu     sync.Mutex
	bodies map[string]*bodyCacheEntry
	runs   map[scopeKey]*RunContext
	byID   map[string]scopeKey // runContextId → scope，支持按 id 取回与跨 consumer 校验

	cfg RegistryConfig
}

// NewRegistry 创建使用冻结默认值的注册表。
func NewRegistry() *Registry {
	return NewRegistryWithConfig(RegistryConfig{})
}

// NewRegistryWithConfig 创建注册表；零值字段回落到冻结默认值。
func NewRegistryWithConfig(cfg RegistryConfig) *Registry {
	if cfg.MaxBodyEntries <= 0 {
		cfg.MaxBodyEntries = DefaultMaxBodyEntries
	}
	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = DefaultMaxBodyBytes
	}
	if cfg.MaxRunContexts <= 0 {
		cfg.MaxRunContexts = DefaultMaxRunContexts
	}
	if cfg.RunIdleTTL <= 0 {
		cfg.RunIdleTTL = DefaultRunIdleTTL
	}
	if cfg.RunMaxTTL <= 0 {
		cfg.RunMaxTTL = DefaultRunAbsoluteTTL
	}
	if cfg.BodyIdleTTL <= 0 {
		cfg.BodyIdleTTL = DefaultBodyIdleTTL
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Registry{
		bodies: map[string]*bodyCacheEntry{},
		runs:   map[scopeKey]*RunContext{},
		byID:   map[string]scopeKey{},
		cfg:    cfg,
	}
}

// BindInput 是 create/upsert 的输入；Snapshot 必须已由 P0 纯函数构建并通过预算校验。
type BindInput struct {
	Consumer  Consumer
	ScopeKey  string
	Snapshot  *Snapshot
	UISummary UIViewSummary
	// State 可选，缺省为 bound；调用方（后续 P2）可显式给 degraded。
	State ContextState
}

// Bind 执行 §6.3.1 的 upsert 与 §6.6 的 create/reuse/replace：
//   - 同 (consumer,scopeKey) 且同 fingerprint → 幂等复用（同一 id/salt/字节，不重复计 refCount）；
//   - 同 scope 但 fingerprint 不同 → 替换（释放旧 body 引用，建新 run）；
//   - 无绑定 → 新建（body 命中缓存则共享，否则由 Snapshot 投影并缓存）。
func (r *Registry) Bind(in BindInput) (*RunContext, BindOutcome, error) {
	if in.Consumer != ConsumerWriting && in.Consumer != ConsumerGame {
		return nil, "", domainError(ErrConsumerNotTrusted, "consumer", "当前阶段只允许 writing/game 注册 runContext")
	}
	if in.ScopeKey == "" {
		return nil, "", domainError(ErrInvalidRequest, "scopeKey", "服务端内部 scopeKey 不能为空")
	}
	if in.Snapshot == nil {
		return nil, "", domainError(ErrInvalidRequest, "snapshot", "绑定必须提供已构建的 Snapshot")
	}
	fp := in.Snapshot.ContextFingerprint
	if fp == "" {
		return nil, "", domainError(ErrInvalidRequest, "contextFingerprint", "Snapshot 缺少 contextFingerprint")
	}
	state := in.State
	if state == "" {
		state = StateBound
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.cfg.Now()
	r.sweepLocked(now)

	sk := scopeKey{consumer: in.Consumer, scope: in.ScopeKey}
	if existing, ok := r.runs[sk]; ok {
		if existing.fingerprint == fp {
			// 幂等复用：不重算、不重新随机化、不重复计 refCount；刷新 idle 计时。
			existing.lastUsedAt = now
			existing.state = StateActive
			return existing, OutcomeReused, nil
		}
		// 换背景 = 替换：先释放旧 run（及其 body 引用），再走新建。
		r.destroyLocked(existing)
		outcome := OutcomeReplaced
		rc, err := r.createLocked(in, fp, state, now, outcome)
		if err != nil {
			return nil, "", err
		}
		return rc, outcome, nil
	}
	rc, err := r.createLocked(in, fp, state, now, OutcomeCreated)
	if err != nil {
		return nil, "", err
	}
	return rc, OutcomeCreated, nil
}

// createLocked 必须在持锁状态下调用：取/建 body、生成 salt、物化 ModelView、登记 run 与容量回收。
func (r *Registry) createLocked(in BindInput, fp string, state ContextState, now time.Time, _ BindOutcome) (*RunContext, error) {
	entry, err := r.acquireBodyLocked(in.Snapshot, fp, now)
	if err != nil {
		return nil, err
	}

	salt, err := randomBytes(runSaltSize)
	if err != nil {
		return nil, domainError(ErrProjectionFailed, "runSalt", "生成 runSalt 失败")
	}
	mv, err := MaterializeModelView(entry.body, in.Consumer, salt)
	if err != nil {
		r.releaseBodyLocked(fp)
		return nil, err
	}
	mvBytes, err := marshalStable(mv)
	if err != nil {
		r.releaseBodyLocked(fp)
		return nil, domainError(ErrProjectionFailed, "modelView", "最终 ModelView 序列化失败")
	}
	if len(mvBytes) > MaxFinalModelViewBytes {
		r.releaseBodyLocked(fp)
		return nil, budgetError(string(LayerModelBytes), "最终模型视图超过 96KiB 上限")
	}

	id, err := newRunContextID()
	if err != nil {
		r.releaseBodyLocked(fp)
		return nil, domainError(ErrProjectionFailed, "runContextId", "生成 runContextId 失败")
	}

	// slot(kind|refValue) → 本 run sourceRef；与 body.Sources / mv.Sources 同序对齐。
	refTable := make(map[string]string, len(entry.body.Sources))
	for i, src := range entry.body.Sources {
		refTable[slotKey(src.RefKind, src.RefValue)] = mv.Sources[i].Ref
	}

	rc := &RunContext{
		id:                    id,
		consumer:              in.Consumer,
		scopeKey:              in.ScopeKey,
		worldID:               in.Snapshot.WorldID,
		expectedWorldRevision: in.Snapshot.WorldRevision,
		fingerprint:           fp,
		runSalt:               salt,
		sourceRefTable:        refTable,
		modelView:             mv,
		modelViewBytes:        mvBytes,
		uiSummary:             in.UISummary,
		state:                 state,
		createdAt:             now,
		lastUsedAt:            now,
	}

	// run 容量兜底：超出 64 时按 LRU 淘汰最久未用（不会淘汰本次要写入的 scope）。
	if len(r.runs) >= r.cfg.MaxRunContexts {
		r.evictOldestRunLocked(skExcept(rc.consumer, rc.scopeKey))
	}
	r.runs[scopeKey{consumer: rc.consumer, scope: rc.scopeKey}] = rc
	r.byID[rc.id] = scopeKey{consumer: rc.consumer, scope: rc.scopeKey}
	return rc, nil
}

// acquireBodyLocked 命中则共享 body（refCount++、刷新 lastUsedAt），否则由 Snapshot 投影并缓存。
func (r *Registry) acquireBodyLocked(snap *Snapshot, fp string, now time.Time) (*bodyCacheEntry, error) {
	if entry, ok := r.bodies[fp]; ok {
		entry.refCount++
		entry.lastUsedAt = now
		return entry, nil
	}
	body, err := ProjectModelBody(snap)
	if err != nil {
		return nil, err
	}
	bodyBytes, err := marshalStable(body)
	if err != nil {
		return nil, domainError(ErrProjectionFailed, "projectionBody", "ProjectionBody 序列化失败")
	}
	if len(bodyBytes) > MaxProjectionBodyBytes {
		return nil, budgetError(string(LayerBodyBytes), "投影体超过 96KiB 上限")
	}
	entry := &bodyCacheEntry{
		fingerprint: fp,
		body:        body,
		bodyBytes:   bodyBytes,
		sizeBytes:   len(bodyBytes),
		refCount:    1,
		createdAt:   now,
		lastUsedAt:  now,
	}
	// 先为新条目腾出空间，再插入，避免新条目被自身容量策略立即淘汰。
	r.makeRoomForBodyLocked(entry.sizeBytes, fp)
	r.bodies[fp] = entry
	return entry, nil
}

// makeRoomForBodyLocked 在插入新 body 前按 §6.5 策略回收，直到条目数与总字节都能容纳新增量。
func (r *Registry) makeRoomForBodyLocked(incomingSize int, incomingFP string) {
	for len(r.bodies) >= r.cfg.MaxBodyEntries || r.bodyTotalBytesLocked()+incomingSize > r.cfg.MaxBodyBytes {
		victim := r.lruBodyLocked(true)
		if victim == nil {
			victim = r.lruBodyLocked(false)
		}
		if victim == nil || victim.fingerprint == incomingFP {
			return
		}
		delete(r.bodies, victim.fingerprint)
	}
}

func (r *Registry) bodyTotalBytesLocked() int {
	total := 0
	for _, e := range r.bodies {
		total += e.sizeBytes
	}
	return total
}

// enforceBodyCapacityLocked 执行一级缓存容量策略（§6.5）：
// 先淘汰 refCount==0 的 LRU，仍超限时再淘汰最久未用条目（含在用户，其 run 仍可独立工作）。
func (r *Registry) enforceBodyCapacityLocked() {
	for r.bodyOverCapacityLocked() {
		victim := r.lruBodyLocked(true)
		if victim == nil {
			victim = r.lruBodyLocked(false)
		}
		if victim == nil {
			return
		}
		delete(r.bodies, victim.fingerprint)
	}
}

func (r *Registry) bodyOverCapacityLocked() bool {
	return len(r.bodies) > r.cfg.MaxBodyEntries || r.bodyTotalBytesLocked() > r.cfg.MaxBodyBytes
}

// lruBodyLocked 返回最久未用 body；preferFree=true 时只在 refCount==0 中选。
func (r *Registry) lruBodyLocked(preferFree bool) *bodyCacheEntry {
	var victim *bodyCacheEntry
	for _, e := range r.bodies {
		if preferFree && e.refCount > 0 {
			continue
		}
		if victim == nil || e.lastUsedAt.Before(victim.lastUsedAt) {
			victim = e
		}
	}
	return victim
}

// evictOldestRunLocked 淘汰最久未用的 run（避开 except 指定 scope）。
func (r *Registry) evictOldestRunLocked(except scopeKey) {
	var victim *RunContext
	for sk, rc := range r.runs {
		if sk == except {
			continue
		}
		if victim == nil || rc.lastUsedAt.Before(victim.lastUsedAt) {
			victim = rc
		}
	}
	if victim != nil {
		r.destroyLocked(victim)
	}
}

func skExcept(c Consumer, s string) scopeKey { return scopeKey{consumer: c, scope: s} }

// releaseBodyLocked 将某 fingerprint 的引用计数减一（条目不存在则空操作）。
func (r *Registry) releaseBodyLocked(fp string) {
	if entry, ok := r.bodies[fp]; ok {
		entry.refCount--
		if entry.refCount < 0 {
			entry.refCount = 0
		}
	}
}

// Reuse 对应 reuse/reconnect/regenerate：按服务端 scope 取回既有 run，
// 命中则复用同一 salt/最终字节并刷新 idle 计时、置 active；不重建、不重新随机化。
// expectedFingerprint 非空且与绑定不一致时返回 context_ref_mismatch（不静默二选一）。
func (r *Registry) Reuse(consumer Consumer, scope, expectedFingerprint string) (*RunContext, error) {
	if consumer != ConsumerWriting && consumer != ConsumerGame {
		return nil, domainError(ErrConsumerNotTrusted, "consumer", "当前阶段只允许 writing/game")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.cfg.Now()
	r.sweepLocked(now)
	rc, ok := r.runs[scopeKey{consumer: consumer, scope: scope}]
	if !ok || r.runExpiredLocked(rc, now) {
		if ok {
			r.destroyLocked(rc)
		}
		return nil, domainError(ErrContextUnavailable, "runContext", "世界上下文已失效，请重新进入加载")
	}
	if expectedFingerprint != "" && !constantEqual(rc.fingerprint, expectedFingerprint) {
		return nil, domainError(ErrContextRefMismatch, "contextFingerprint", "续接 Ref 与绑定不一致，需以新 Ref 起新 run")
	}
	rc.lastUsedAt = now
	rc.state = StateActive
	return rc, nil
}

// GetByID 按 runContextId 取回：未知/过期 → context_unavailable；跨 consumer → consumer_not_trusted。
func (r *Registry) GetByID(id string, consumer Consumer) (*RunContext, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.cfg.Now()
	r.sweepLocked(now)
	sk, ok := r.byID[id]
	if !ok {
		return nil, domainError(ErrContextUnavailable, "runContextId", "未知或已失效的 runContext")
	}
	if sk.consumer != consumer {
		return nil, domainError(ErrConsumerNotTrusted, "consumer", "不得跨 consumer 使用 runContext")
	}
	rc := r.runs[sk]
	if rc == nil || r.runExpiredLocked(rc, now) {
		if rc != nil {
			r.destroyLocked(rc)
		}
		return nil, domainError(ErrContextUnavailable, "runContextId", "世界上下文已失效")
	}
	rc.lastUsedAt = now
	return rc, nil
}

// Destroy 对应 destroy：解绑 scope 并释放 body 引用；返回是否找到并释放。
func (r *Registry) Destroy(consumer Consumer, scope string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	rc, ok := r.runs[scopeKey{consumer: consumer, scope: scope}]
	if !ok {
		return false
	}
	r.destroyLocked(rc)
	return true
}

// destroyLocked 必须持锁：移除 run 索引并释放其 body 引用。
func (r *Registry) destroyLocked(rc *RunContext) {
	sk := scopeKey{consumer: rc.consumer, scope: rc.scopeKey}
	if cur, ok := r.runs[sk]; ok && cur.id == rc.id {
		delete(r.runs, sk)
		delete(r.byID, rc.id)
		r.releaseBodyLocked(rc.fingerprint)
	}
}

// SweepResult 报告一次清理回收的数量（诊断用）。
type SweepResult struct {
	RunsExpired int
	BodiesFreed int
}

// Sweep 显式执行 TTL/LRU 清理（生产可由 P2 周期性调用；P1 不在内部起后台 goroutine）。
func (r *Registry) Sweep() SweepResult {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sweepLocked(r.cfg.Now())
}

// sweepLocked 清理过期 run 与 refCount==0 且空闲超期的 body，并做一次容量兜底。
func (r *Registry) sweepLocked(now time.Time) SweepResult {
	res := SweepResult{}
	for _, rc := range r.runs {
		if r.runExpiredLocked(rc, now) {
			r.destroyLocked(rc)
			res.RunsExpired++
		}
	}
	for fp, e := range r.bodies {
		if e.refCount <= 0 && now.Sub(e.lastUsedAt) >= r.cfg.BodyIdleTTL {
			delete(r.bodies, fp)
			res.BodiesFreed++
		}
	}
	r.enforceBodyCapacityLocked()
	return res
}

func (r *Registry) runExpiredLocked(rc *RunContext, now time.Time) bool {
	if now.Sub(rc.lastUsedAt) >= r.cfg.RunIdleTTL {
		return true
	}
	if now.Sub(rc.createdAt) >= r.cfg.RunMaxTTL {
		return true
	}
	return false
}

// Stats 返回计数快照（不含秘密）。
func (r *Registry) Stats() RegistryStats {
	r.mu.Lock()
	defer r.mu.Unlock()
	total := 0
	for _, e := range r.bodies {
		total += e.sizeBytes
	}
	return RegistryStats{BodyEntries: len(r.bodies), BodyBytes: total, RunContexts: len(r.runs)}
}

// bodyRefCount 仅供测试/诊断读取某 fingerprint 的引用计数。
func (r *Registry) bodyRefCount(fp string) (int, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.bodies[fp]
	if !ok {
		return 0, false
	}
	return e.refCount, true
}

// sortedFingerprints 仅供测试确定性遍历。
func (r *Registry) sortedFingerprints() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.bodies))
	for fp := range r.bodies {
		out = append(out, fp)
	}
	sort.Strings(out)
	return out
}

func slotKey(kind SourceKind, value string) string { return string(kind) + "|" + value }

func randomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, nil
}

func newRunContextID() (string, error) {
	b, err := randomBytes(runContextIDRandomBytes)
	return base64.RawURLEncoding.EncodeToString(b), err
}

func constantEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
