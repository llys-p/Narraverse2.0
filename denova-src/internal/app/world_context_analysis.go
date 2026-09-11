package app

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"denova/internal/worldcontext"
)

const (
	defaultAnalysisHandleTTL  = 10 * time.Minute
	defaultMaxAnalysisHandles = worldcontext.DefaultMaxRunContexts
	analysisTokenBytes        = 32
)

// AnalysisHandleView 是 P4.1 唯一允许离开服务层的 handle 视图。
// 本阶段尚未接 HTTP；后续接线也不得暴露 pending context、fingerprint 或 claim 元数据。
type AnalysisHandleView struct {
	AnalysisHandle string
	ExpiresAt      time.Time
}

// AnalysisHandleUseStatus 描述内部 claim/consume 结果；失效 handle 均为非阻断结果。
type AnalysisHandleUseStatus string

const (
	AnalysisHandleClaimed         AnalysisHandleUseStatus = "claimed"
	AnalysisHandleConsumed        AnalysisHandleUseStatus = "consumed"
	AnalysisHandleIgnoredInvalid  AnalysisHandleUseStatus = "ignored_invalid"
	AnalysisHandleIgnoredExpired  AnalysisHandleUseStatus = "ignored_expired"
	AnalysisHandleIgnoredConsumed AnalysisHandleUseStatus = "ignored_consumed"
)

// AnalysisHandleInvalidateOutcome 区分取消方是否获得了 pending context 的清理责任。
type AnalysisHandleInvalidateOutcome string

const (
	AnalysisHandleInvalidated            AnalysisHandleInvalidateOutcome = "invalidated"
	AnalysisHandleInvalidateClaimed      AnalysisHandleInvalidateOutcome = "claimed_invalidated"
	AnalysisHandleInvalidateConsumedNoop AnalysisHandleInvalidateOutcome = "consumed_noop"
	AnalysisHandleInvalidateAlreadyNoop  AnalysisHandleInvalidateOutcome = "already_invalidated_noop"
	AnalysisHandleInvalidateMissingNoop  AnalysisHandleInvalidateOutcome = "missing_noop"
)

type analysisHandleState string

const (
	analysisHandlePending     analysisHandleState = "pending"
	analysisHandleClaimed     analysisHandleState = "claimed"
	analysisHandleConsumed    analysisHandleState = "consumed"
	analysisHandleInvalidated analysisHandleState = "invalidated"
)

// AnalysisHandleClaim 是一次原子认领的服务端所有权凭据。
// 它不是 Task、InteractiveRun 或长期运行身份，也不得被序列化或写入日志。
type AnalysisHandleClaim struct {
	handleID string
	claimID  string
	consumer worldcontext.Consumer
	lease    AnalysisContextLease
}

// AnalysisContextLease 表示 claimant 在最终 consume 前必须迁移/接管的 pending runContext。
// P4.1 不做实际 Task/InteractiveRun 迁移；调用方未提交 consume 时必须 rollback，
// 已提交但尚无真实运行身份的测试/后续调用方则必须按 PendingScopeKey 释放。
type AnalysisContextLease struct {
	Consumer        worldcontext.Consumer
	PendingScopeKey string
	RunContextID    string
	Fingerprint     string
}

// pendingContextLease 只供 app 服务编排层在最终 consume 前完成运行身份迁移。
// 返回值是副本；调用方不得把它下发客户端或写入任务/故事存档。
func (c *AnalysisHandleClaim) pendingContextLease() AnalysisContextLease {
	if c == nil {
		return AnalysisContextLease{}
	}
	return c.lease
}

type analysisHandleKey struct {
	consumer    worldcontext.Consumer
	sessionKey  string
	fingerprint string
}

// analysisHandleRecord 只保存短期消费协调元数据。
// 禁止加入 Task/InteractiveRun 身份、模型回调、事件缓冲或 World/Snapshot/ModelView 副本。
type analysisHandleRecord struct {
	handleID         string
	pendingScopeKey  string
	pendingContextID string
	key              analysisHandleKey
	issuedAt         time.Time
	expiresAt        time.Time
	state            analysisHandleState
	claimID          string
	contextSettled   bool
}

type analysisHandleConfig struct {
	TTL        time.Duration
	MaxHandles int
	Now        func() time.Time
	NewToken   func() (string, error)
}

// AnalysisHandleSweepResult 只包含安全的计数诊断，不包含 handle 或上下文身份。
type AnalysisHandleSweepResult struct {
	HandlesRemoved   int
	ContextsReleased int
}

// analysisHandleRegistry 是进程内、无 goroutine 的短期 handle 注册表。
// contexts 是唯一 runContext 所有者；清理统一通过其幂等 Destroy 完成。
type analysisHandleRegistry struct {
	mu         sync.Mutex
	contexts   *worldcontext.Registry
	handles    map[string]*analysisHandleRecord
	byKey      map[analysisHandleKey]string
	ttl        time.Duration
	maxHandles int
	now        func() time.Time
	newToken   func() (string, error)
	claimSeq   uint64
}

func newAnalysisHandleRegistry(contexts *worldcontext.Registry, cfg analysisHandleConfig) *analysisHandleRegistry {
	ttl := cfg.TTL
	if ttl <= 0 || ttl > defaultAnalysisHandleTTL {
		ttl = defaultAnalysisHandleTTL
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	newToken := cfg.NewToken
	if newToken == nil {
		newToken = newAnalysisToken
	}
	maxHandles := cfg.MaxHandles
	if maxHandles <= 0 || maxHandles > defaultMaxAnalysisHandles {
		maxHandles = defaultMaxAnalysisHandles
	}
	return &analysisHandleRegistry{
		contexts:   contexts,
		handles:    make(map[string]*analysisHandleRecord),
		byKey:      make(map[analysisHandleKey]string),
		ttl:        ttl,
		maxHandles: maxHandles,
		now:        now,
		newToken:   newToken,
	}
}

func newAnalysisToken() (string, error) {
	raw := make([]byte, analysisTokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// createOrReuse 在同一把锁内完成去重判断与 pending runContext 创建，避免并发签发两个 handle。
func (r *analysisHandleRegistry) createOrReuse(
	consumer worldcontext.Consumer,
	sessionKey string,
	snapshot *worldcontext.Snapshot,
	uiSummary worldcontext.UIViewSummary,
) (AnalysisHandleView, error) {
	if r == nil || r.contexts == nil {
		return AnalysisHandleView{}, fmt.Errorf("analysis handle registry is not initialized")
	}
	if consumer != worldcontext.ConsumerWriting && consumer != worldcontext.ConsumerGame {
		return AnalysisHandleView{}, &worldcontext.DomainError{Code: worldcontext.ErrConsumerNotTrusted, Field: "consumer", Message: "当前阶段只允许 writing/game"}
	}
	if strings.TrimSpace(sessionKey) == "" {
		return AnalysisHandleView{}, &worldcontext.DomainError{Code: worldcontext.ErrInvalidRequest, Field: "sessionKey", Message: "服务端 sessionKey 不能为空"}
	}
	if snapshot == nil || snapshot.ContextFingerprint == "" {
		return AnalysisHandleView{}, &worldcontext.DomainError{Code: worldcontext.ErrInvalidRequest, Field: "snapshot", Message: "analysis 必须提供已构建的 Snapshot"}
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	r.sweepLocked(now)
	key := analysisHandleKey{consumer: consumer, sessionKey: sessionKey, fingerprint: snapshot.ContextFingerprint}
	if handleID, ok := r.byKey[key]; ok {
		if existing := r.handles[handleID]; existing != nil && existing.state == analysisHandlePending && now.Before(existing.expiresAt) {
			if _, err := r.contexts.GetByID(existing.pendingContextID, consumer); err == nil {
				return AnalysisHandleView{AnalysisHandle: existing.handleID, ExpiresAt: existing.expiresAt}, nil
			}
			r.invalidatePendingLocked(existing)
		}
		delete(r.byKey, key)
	}
	if len(r.handles) >= r.maxHandles {
		r.pruneSettledLocked()
	}
	if len(r.handles) >= r.maxHandles {
		return AnalysisHandleView{}, &worldcontext.DomainError{Code: worldcontext.ErrContextUnavailable, Field: "analysisHandle", Message: "analysis 上下文容量已满，请稍后重试"}
	}

	handleID, err := r.uniqueTokenLocked()
	if err != nil {
		return AnalysisHandleView{}, fmt.Errorf("generate analysis handle: %w", err)
	}
	pendingID, err := r.newToken()
	if err != nil {
		return AnalysisHandleView{}, fmt.Errorf("generate pending context reference: %w", err)
	}
	pendingScopeKey := "analysis:" + pendingID
	run, _, err := r.contexts.Bind(worldcontext.BindInput{
		Consumer:  consumer,
		ScopeKey:  pendingScopeKey,
		Snapshot:  snapshot,
		UISummary: uiSummary,
	})
	if err != nil {
		return AnalysisHandleView{}, err
	}

	record := &analysisHandleRecord{
		handleID:         handleID,
		pendingScopeKey:  pendingScopeKey,
		pendingContextID: run.ID(),
		key:              key,
		issuedAt:         now,
		expiresAt:        now.Add(r.ttl),
		state:            analysisHandlePending,
	}
	r.handles[handleID] = record
	r.byKey[key] = handleID
	return AnalysisHandleView{AnalysisHandle: handleID, ExpiresAt: record.expiresAt}, nil
}

// pruneSettledLocked 仅在容量压力下提前移除已完成 tombstone；不触碰 pending/claimed。
// tombstone 的冻结语义是“最多保留到 expiresAt”，因此提前丢弃只会把重复请求归类为 invalid。
func (r *analysisHandleRegistry) pruneSettledLocked() {
	for handleID, record := range r.handles {
		if len(r.handles) < r.maxHandles {
			return
		}
		if record.contextSettled && (record.state == analysisHandleConsumed || record.state == analysisHandleInvalidated) {
			delete(r.byKey, record.key)
			delete(r.handles, handleID)
		}
	}
}

func (r *analysisHandleRegistry) uniqueTokenLocked() (string, error) {
	for i := 0; i < 4; i++ {
		token, err := r.newToken()
		if err != nil {
			return "", err
		}
		if token != "" {
			if _, exists := r.handles[token]; !exists {
				return token, nil
			}
		}
	}
	return "", fmt.Errorf("failed to generate unique opaque token")
}

func (r *analysisHandleRegistry) claim(handleID string, consumer worldcontext.Consumer) (*AnalysisHandleClaim, AnalysisHandleUseStatus) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	record := r.handles[handleID]
	if record == nil || record.key.consumer != consumer {
		return nil, AnalysisHandleIgnoredInvalid
	}
	if !now.Before(record.expiresAt) {
		r.expireLocked(record)
		return nil, AnalysisHandleIgnoredExpired
	}
	if record.state != analysisHandlePending {
		return nil, AnalysisHandleIgnoredConsumed
	}
	if _, err := r.contexts.GetByID(record.pendingContextID, consumer); err != nil {
		r.invalidatePendingLocked(record)
		return nil, AnalysisHandleIgnoredInvalid
	}
	r.claimSeq++
	claimID := strconv.FormatUint(r.claimSeq, 10)
	record.state = analysisHandleClaimed
	record.claimID = claimID
	delete(r.byKey, record.key)
	return &AnalysisHandleClaim{
		handleID: handleID,
		claimID:  claimID,
		consumer: consumer,
		lease: AnalysisContextLease{
			Consumer:        record.key.consumer,
			PendingScopeKey: record.pendingScopeKey,
			RunContextID:    record.pendingContextID,
			Fingerprint:     record.key.fingerprint,
		},
	}, AnalysisHandleClaimed
}

func (r *analysisHandleRegistry) consume(claim *AnalysisHandleClaim) AnalysisHandleUseStatus {
	if claim == nil {
		return AnalysisHandleIgnoredInvalid
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	record := r.handles[claim.handleID]
	if record == nil || record.key.consumer != claim.consumer || record.claimID != claim.claimID {
		return AnalysisHandleIgnoredConsumed
	}
	if !r.now().Before(record.expiresAt) {
		r.expireLocked(record)
		return AnalysisHandleIgnoredExpired
	}
	switch record.state {
	case analysisHandleClaimed:
		record.state = analysisHandleConsumed
		record.contextSettled = true // 所有权已由 claimant 迁移/接管，handle 清理不得再释放。
		return AnalysisHandleConsumed
	case analysisHandleInvalidated:
		r.releasePendingLocked(record)
		return AnalysisHandleIgnoredConsumed
	default:
		return AnalysisHandleIgnoredConsumed
	}
}

func (r *analysisHandleRegistry) invalidate(handleID string, consumer worldcontext.Consumer) AnalysisHandleInvalidateOutcome {
	r.mu.Lock()
	defer r.mu.Unlock()
	record := r.handles[handleID]
	if record == nil || record.key.consumer != consumer {
		return AnalysisHandleInvalidateMissingNoop
	}
	if !r.now().Before(record.expiresAt) {
		r.expireLocked(record)
		return AnalysisHandleInvalidateAlreadyNoop
	}
	switch record.state {
	case analysisHandlePending:
		r.invalidatePendingLocked(record)
		return AnalysisHandleInvalidated
	case analysisHandleClaimed:
		record.state = analysisHandleInvalidated
		delete(r.byKey, record.key)
		return AnalysisHandleInvalidateClaimed
	case analysisHandleConsumed:
		return AnalysisHandleInvalidateConsumedNoop
	case analysisHandleInvalidated:
		return AnalysisHandleInvalidateAlreadyNoop
	default:
		return AnalysisHandleInvalidateAlreadyNoop
	}
}

// rollback 由唯一 claimant 的 defer 调用；取消方只标 invalidated，不抢占清理责任。
func (r *analysisHandleRegistry) rollback(claim *AnalysisHandleClaim) bool {
	if claim == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	record := r.handles[claim.handleID]
	if record == nil || record.key.consumer != claim.consumer || record.claimID != claim.claimID || record.contextSettled {
		return false
	}
	if record.state != analysisHandleClaimed && record.state != analysisHandleInvalidated {
		return false
	}
	record.state = analysisHandleInvalidated
	delete(r.byKey, record.key)
	r.releasePendingLocked(record)
	return true
}

func (r *analysisHandleRegistry) sweep() AnalysisHandleSweepResult {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sweepLocked(r.now())
}

func (r *analysisHandleRegistry) sweepLocked(now time.Time) AnalysisHandleSweepResult {
	result := AnalysisHandleSweepResult{}
	for handleID, record := range r.handles {
		if now.Before(record.expiresAt) {
			continue
		}
		if r.releasePendingLocked(record) {
			result.ContextsReleased++
		}
		delete(r.byKey, record.key)
		delete(r.handles, handleID)
		result.HandlesRemoved++
	}
	return result
}

func (r *analysisHandleRegistry) expireLocked(record *analysisHandleRecord) {
	record.state = analysisHandleInvalidated
	delete(r.byKey, record.key)
	r.releasePendingLocked(record)
	delete(r.handles, record.handleID)
}

func (r *analysisHandleRegistry) invalidatePendingLocked(record *analysisHandleRecord) {
	record.state = analysisHandleInvalidated
	delete(r.byKey, record.key)
	r.releasePendingLocked(record)
}

// releasePendingLocked 是唯一释放原语。contextSettled 同时表示“已释放”或“已转移”，
// 因而重复取消、rollback、expire、sweep 永远不会重复 Destroy/refCount--。
func (r *analysisHandleRegistry) releasePendingLocked(record *analysisHandleRecord) bool {
	if record.contextSettled || record.state == analysisHandleConsumed {
		return false
	}
	record.contextSettled = true
	return r.contexts.Destroy(record.key.consumer, record.pendingScopeKey)
}

func (s *WorldContextService) createAnalysisHandle(
	ctx context.Context,
	consumer worldcontext.Consumer,
	sessionKey string,
	ref worldcontext.Ref,
) (AnalysisHandleView, error) {
	snapshot, err := s.loadSnapshot(ctx, consumer, ref)
	if err != nil {
		return AnalysisHandleView{}, err
	}
	return s.analysisHandles.createOrReuse(consumer, sessionKey, snapshot, uiSummaryFromSnapshot(snapshot))
}

func (s *WorldContextService) claimAnalysisHandle(handleID string, consumer worldcontext.Consumer) (*AnalysisHandleClaim, AnalysisHandleUseStatus) {
	if s == nil || s.analysisHandles == nil {
		return nil, AnalysisHandleIgnoredInvalid
	}
	return s.analysisHandles.claim(handleID, consumer)
}

func (s *WorldContextService) consumeAnalysisHandle(claim *AnalysisHandleClaim) AnalysisHandleUseStatus {
	if s == nil || s.analysisHandles == nil {
		return AnalysisHandleIgnoredInvalid
	}
	return s.analysisHandles.consume(claim)
}

func (s *WorldContextService) invalidateAnalysisHandle(handleID string, consumer worldcontext.Consumer) AnalysisHandleInvalidateOutcome {
	if s == nil || s.analysisHandles == nil {
		return AnalysisHandleInvalidateMissingNoop
	}
	return s.analysisHandles.invalidate(handleID, consumer)
}

func (s *WorldContextService) rollbackAnalysisClaim(claim *AnalysisHandleClaim) bool {
	return s != nil && s.analysisHandles != nil && s.analysisHandles.rollback(claim)
}

func (s *WorldContextService) sweepAnalysisHandles() AnalysisHandleSweepResult {
	if s == nil || s.analysisHandles == nil {
		return AnalysisHandleSweepResult{}
	}
	return s.analysisHandles.sweep()
}
