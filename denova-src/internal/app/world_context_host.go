package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/cloudwego/eino/schema"

	"denova/internal/agent"
	"denova/internal/libraryruntime"
	"denova/internal/worldcontext"
)

const (
	hostBootstrapTTL = 5 * time.Minute
	hostIdleTTL      = 30 * time.Minute
	hostAbsoluteTTL  = 6 * time.Hour
	hostMaxFrames    = 8
)

type hostBootstrap struct {
	hash      [32]byte
	expiresAt time.Time
}

type hostFrameBinding struct {
	consumer     worldcontext.Consumer
	frame        string
	scopeKey     string
	runContextID string
	inFlight     bool
	summary      worldcontext.UIViewSummary
	// library 载体（与 world 载体互斥，B4a/L3.3）：run 持有临时读取授权与累计预算；
	// libraryLeading 是绑定期 AssembleInitial 产出的临时背景文本，只存内存并在每次
	// /call 时前置到模型输入，绝不回传 iframe、不落盘。
	libraryRun     *libraryruntime.Run
	libraryLeading string
	librarySummary HostContextState
}

type hostSession struct {
	hash            [32]byte
	idleExpiresAt   time.Time
	absoluteExpires time.Time
	bindings        map[string]*hostFrameBinding
}

// HostContextState is the sanitized host/iframe status DTO. It never contains
// a token, World Ref, scope key, run context id, fingerprint, or ModelView.
type HostContextState struct {
	State         string `json:"state"`
	WorldName     string `json:"worldName,omitempty"`
	LibraryName   string `json:"libraryName,omitempty"`
	RevisionLabel string `json:"revisionLabel,omitempty"`
	SelectedCount int    `json:"selectedCount,omitempty"`
}

// HostFrameLibraryControl 是受控 iframe 一次 library bind 的载体（B4a/L3.3）。
// consumer 与 scopeKey 由宿主层服务端派生，绝不接受客户端提交值；ManualItemIDs
// 是用户本次显式授权的 manual 条目集合，autoItemIds 不进入运行授权。
type HostFrameLibraryControl struct {
	LibraryID        string
	ExpectedRevision string
	ManualItemIDs    []string
}

// WorldContextHostService owns the process-local trust root and iframe
// bindings. It is derived runtime state, not a World or story storage layer.
type WorldContextHostService struct {
	app   *App
	world *WorldContextService
	now   func() time.Time

	mu         sync.Mutex
	bindMu     sync.Mutex
	bootstraps []hostBootstrap
	sessions   map[[32]byte]*hostSession
	closed     bool
}

func newWorldContextHostService(a *App, worldSvc *WorldContextService) *WorldContextHostService {
	return &WorldContextHostService{
		app: a, world: worldSvc, now: time.Now,
		sessions: make(map[[32]byte]*hostSession),
	}
}

func randomOpaqueToken(size int) (string, error) {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func trustedHostError() error {
	return &worldcontext.DomainError{Code: worldcontext.ErrConsumerNotTrusted, Message: "宿主会话无效或已过期"}
}

func hostBindingKey(consumer worldcontext.Consumer, frame string) string {
	return string(consumer) + ":" + frame
}

// hostFrameScopeKey 派生受控 iframe 的运行归属键（宿主会话 + frame 实例 + consumer），
// 与写作的 task:<id>、游戏的 story/turn 同构，绝不接受客户端提交值。
func hostFrameScopeKey(hash [32]byte, frame string, consumer worldcontext.Consumer) string {
	return fmt.Sprintf("iframe:%x:%s:%s", hash[:6], frame, consumer)
}

func validHostConsumer(consumer worldcontext.Consumer) bool {
	return consumer == worldcontext.ConsumerNarraverse || consumer == worldcontext.ConsumerModule4
}

func validFrameInstance(value string) bool {
	if len(value) < 16 || len(value) > 128 {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// NewWorldContextHostBootstrapSecret creates one five-minute, single-use
// secret for the OS-opened top-level URL fragment. The plaintext is returned
// once and never stored by the service.
func (a *App) NewWorldContextHostBootstrapSecret() (string, error) {
	return a.worldContextHost().newBootstrapSecret()
}

func (s *WorldContextHostService) newBootstrapSecret() (string, error) {
	secret, err := randomOpaqueToken(32)
	if err != nil {
		return "", err
	}
	now := s.now()
	hash := sha256.Sum256([]byte(secret))
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return "", errors.New("world context host service is closed")
	}
	released := s.sweepLocked(now)
	s.bootstraps = append(s.bootstraps, hostBootstrap{hash: hash, expiresAt: now.Add(hostBootstrapTTL)})
	s.mu.Unlock()
	s.releaseBindings(released)
	return secret, nil
}

// BootstrapWorldContextHost atomically consumes a bootstrap secret and creates
// an opaque host session. Only the hash is retained after this call.
func (a *App) BootstrapWorldContextHost(secret string) (token string, expiresAt time.Time, err error) {
	return a.worldContextHost().bootstrap(secret)
}

func (s *WorldContextHostService) bootstrap(secret string) (string, time.Time, error) {
	if len(secret) != 43 {
		return "", time.Time{}, trustedHostError()
	}
	candidate := sha256.Sum256([]byte(secret))
	now := s.now()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return "", time.Time{}, trustedHostError()
	}
	released := s.sweepLocked(now)
	match := -1
	for i := range s.bootstraps {
		if subtle.ConstantTimeCompare(candidate[:], s.bootstraps[i].hash[:]) == 1 && now.Before(s.bootstraps[i].expiresAt) {
			match = i
		}
	}
	if match < 0 {
		s.mu.Unlock()
		s.releaseBindings(released)
		return "", time.Time{}, trustedHostError()
	}
	s.bootstraps = append(s.bootstraps[:match], s.bootstraps[match+1:]...)
	token, err := randomOpaqueToken(32)
	if err != nil {
		s.mu.Unlock()
		s.releaseBindings(released)
		return "", time.Time{}, err
	}
	hash := sha256.Sum256([]byte(token))
	absolute := now.Add(hostAbsoluteTTL)
	s.sessions[hash] = &hostSession{
		hash: hash, idleExpiresAt: now.Add(hostIdleTTL), absoluteExpires: absolute,
		bindings: make(map[string]*hostFrameBinding),
	}
	s.mu.Unlock()
	s.releaseBindings(released)
	return token, absolute, nil
}

func (s *WorldContextHostService) sweepLocked(now time.Time) []hostFrameBinding {
	kept := s.bootstraps[:0]
	for _, item := range s.bootstraps {
		if now.Before(item.expiresAt) {
			kept = append(kept, item)
		}
	}
	s.bootstraps = kept
	var released []hostFrameBinding
	for hash, session := range s.sessions {
		if !now.Before(session.idleExpiresAt) || !now.Before(session.absoluteExpires) {
			for _, binding := range session.bindings {
				released = append(released, *binding)
			}
			delete(s.sessions, hash)
		}
	}
	return released
}

func (s *WorldContextHostService) releaseBindings(items []hostFrameBinding) {
	for i := range items {
		s.releaseBinding(&items[i], true)
	}
}

// releaseBinding 释放一条 frame 绑定的底层载体，幂等：library → Cancel/Complete，
// world → 归还 Registry。aborted 表示宿主主动中止（替换/撤销/过期/关闭），
// 否则为正常结束（iframe 显式 unbind）。
func (s *WorldContextHostService) releaseBinding(binding *hostFrameBinding, aborted bool) {
	if binding == nil {
		return
	}
	if binding.libraryRun != nil {
		if aborted {
			binding.libraryRun.Cancel()
		} else {
			binding.libraryRun.Complete()
		}
		return
	}
	if binding.scopeKey != "" {
		s.world.ReleaseWorldRun(binding.consumer, binding.scopeKey)
	}
}

func (s *WorldContextHostService) authenticate(token string, touch bool) ([32]byte, error) {
	if token == "" {
		return [32]byte{}, trustedHostError()
	}
	hash := sha256.Sum256([]byte(token))
	now := s.now()
	s.mu.Lock()
	released := s.sweepLocked(now)
	session := s.sessions[hash]
	if session == nil || s.closed {
		s.mu.Unlock()
		s.releaseBindings(released)
		return [32]byte{}, trustedHostError()
	}
	if touch {
		session.idleExpiresAt = now.Add(hostIdleTTL)
	}
	s.mu.Unlock()
	s.releaseBindings(released)
	return hash, nil
}

func (a *App) WorldContextHostStatus(token string) error {
	_, err := a.worldContextHost().authenticate(token, true)
	return err
}

func (a *App) BindWorldContextHostFrame(ctx context.Context, token string, consumer worldcontext.Consumer, frame string, ref *worldcontext.Ref) (HostContextState, error) {
	return a.worldContextHost().bind(ctx, token, consumer, frame, ref)
}

func (s *WorldContextHostService) bind(ctx context.Context, token string, consumer worldcontext.Consumer, frame string, ref *worldcontext.Ref) (HostContextState, error) {
	if !validHostConsumer(consumer) || !validFrameInstance(frame) {
		return HostContextState{}, trustedHostError()
	}
	// BindWorldRun 会按 scope 替换 Registry 条目；同一 frame 的并发 bind 必须
	// 在宿主层串行化，避免较早请求在较晚请求之后把旧 runContextID 写回 binding。
	s.bindMu.Lock()
	defer s.bindMu.Unlock()
	hash, err := s.authenticate(token, true)
	if err != nil {
		return HostContextState{}, err
	}
	key := hostBindingKey(consumer, frame)
	scopeKey := hostFrameScopeKey(hash, frame, consumer)
	var rc *worldcontext.RunContext
	if ref != nil {
		rc, _, err = s.world.BindWorldRun(ctx, consumer, scopeKey, *ref)
		if err != nil {
			return HostContextState{}, err
		}
	}

	s.mu.Lock()
	session := s.sessions[hash]
	if session == nil || s.closed {
		s.mu.Unlock()
		if rc != nil {
			s.world.ReleaseWorldRun(consumer, scopeKey)
		}
		return HostContextState{}, trustedHostError()
	}
	if _, exists := session.bindings[key]; !exists && len(session.bindings) >= hostMaxFrames {
		s.mu.Unlock()
		if rc != nil {
			s.world.ReleaseWorldRun(consumer, scopeKey)
		}
		return HostContextState{}, &worldcontext.DomainError{Code: worldcontext.ErrContextUnavailable, Message: "宿主 frame 数量超过上限"}
	}
	previous := session.bindings[key]
	binding := &hostFrameBinding{consumer: consumer, frame: frame, scopeKey: scopeKey}
	state := HostContextState{State: "none"}
	if rc != nil {
		binding.runContextID = rc.ID()
		binding.summary = rc.UISummary()
		state = HostContextState{State: "active", WorldName: binding.summary.WorldName, RevisionLabel: binding.summary.RevisionLabel, SelectedCount: binding.summary.SelectedCount}
	}
	session.bindings[key] = binding
	s.mu.Unlock()
	switch {
	case previous == nil:
	case previous.libraryRun != nil:
		// 旧载体是库背景：world bind 不经过 World Registry 的同 scope 替换，
		// 必须显式取消旧库运行（幂等）。
		s.releaseBinding(previous, true)
	case previous.scopeKey != "" && rc == nil:
		s.world.ReleaseWorldRun(previous.consumer, previous.scopeKey)
	}
	return state, nil
}

// BindLibraryHostFrame 为受控 iframe 绑定作品设定库背景（B4a 叙界 / B4b Module4 共用同一受控边界）。
// 与 world 载体互斥：同一次 bind 只承载一种背景，换绑即显式释放旧载体。
// 绑定期失败（revision 冲突/授权无效/预算不足/库不可用）显式返回并阻断，不留半绑定。
func (a *App) BindLibraryHostFrame(ctx context.Context, token string, consumer worldcontext.Consumer, frame string, ctrl HostFrameLibraryControl) (HostContextState, error) {
	return a.worldContextHost().bindLibrary(ctx, token, consumer, frame, ctrl)
}

func (s *WorldContextHostService) bindLibrary(ctx context.Context, token string, consumer worldcontext.Consumer, frame string, ctrl HostFrameLibraryControl) (HostContextState, error) {
	if !validHostConsumer(consumer) || !validFrameInstance(frame) {
		return HostContextState{}, trustedHostError()
	}
	// 与 world bind 共用同一把串行锁，保证同一 frame 的并发换绑不会写回旧载体。
	s.bindMu.Lock()
	defer s.bindMu.Unlock()
	hash, err := s.authenticate(token, true)
	if err != nil {
		return HostContextState{}, err
	}
	key := hostBindingKey(consumer, frame)
	scopeKey := hostFrameScopeKey(hash, frame, consumer)
	run, err := s.app.BindWorkLibraryRuntime(ctx, libraryruntime.BindInput{
		Consumer:         libraryruntime.Consumer(consumer),
		ScopeKey:         scopeKey,
		LibraryID:        strings.TrimSpace(ctrl.LibraryID),
		ExpectedRevision: strings.TrimSpace(ctrl.ExpectedRevision),
		ManualItemIDs:    ctrl.ManualItemIDs,
	})
	if err != nil {
		return HostContextState{}, err
	}
	ephemeral, err := run.AssembleInitial(ctx)
	if err != nil {
		run.Cancel()
		return HostContextState{}, err
	}
	st := run.Status()
	state := HostContextState{State: "active", LibraryName: st.LibraryName}
	if st.Revision != "" {
		state.RevisionLabel = revisionWireLabel(st.Revision)
	}
	if st.ManualCount > 0 {
		state.SelectedCount = st.ManualCount
	}

	s.mu.Lock()
	session := s.sessions[hash]
	if session == nil || s.closed {
		s.mu.Unlock()
		run.Cancel()
		return HostContextState{}, trustedHostError()
	}
	if _, exists := session.bindings[key]; !exists && len(session.bindings) >= hostMaxFrames {
		s.mu.Unlock()
		run.Cancel()
		return HostContextState{}, &worldcontext.DomainError{Code: worldcontext.ErrContextUnavailable, Message: "宿主 frame 数量超过上限"}
	}
	previous := session.bindings[key]
	binding := &hostFrameBinding{
		consumer:       consumer,
		frame:          frame,
		scopeKey:       scopeKey,
		libraryRun:     run,
		libraryLeading: ephemeral.LeadingText(),
		librarySummary: state,
	}
	session.bindings[key] = binding
	s.mu.Unlock()
	s.releaseBinding(previous, true)
	return state, nil
}

func (a *App) UnbindWorldContextHostFrame(token string, consumer worldcontext.Consumer, frame string) error {
	return a.worldContextHost().unbind(token, consumer, frame)
}

func (s *WorldContextHostService) unbind(token string, consumer worldcontext.Consumer, frame string) error {
	if !validHostConsumer(consumer) || !validFrameInstance(frame) {
		return trustedHostError()
	}
	hash, err := s.authenticate(token, true)
	if err != nil {
		return err
	}
	key := hostBindingKey(consumer, frame)
	s.mu.Lock()
	session := s.sessions[hash]
	if session == nil {
		s.mu.Unlock()
		return trustedHostError()
	}
	binding := session.bindings[key]
	delete(session.bindings, key)
	s.mu.Unlock()
	s.releaseBinding(binding, false)
	return nil
}

func (a *App) RevokeWorldContextHost(token string) error {
	return a.worldContextHost().revoke(token)
}

func (s *WorldContextHostService) revoke(token string) error {
	hash, err := s.authenticate(token, false)
	if err != nil {
		return err
	}
	s.mu.Lock()
	session := s.sessions[hash]
	delete(s.sessions, hash)
	var released []hostFrameBinding
	if session != nil {
		for _, binding := range session.bindings {
			released = append(released, *binding)
		}
	}
	s.mu.Unlock()
	s.releaseBindings(released)
	return nil
}

func (a *App) GenerateHostModel(ctx context.Context, token string, consumer worldcontext.Consumer, frame string, req ModelGatewayChatRequest) (ModelGatewayChatResult, HostContextState, error) {
	return a.worldContextHost().generate(ctx, token, consumer, frame, req)
}

func (s *WorldContextHostService) generate(ctx context.Context, token string, consumer worldcontext.Consumer, frame string, req ModelGatewayChatRequest) (ModelGatewayChatResult, HostContextState, error) {
	if !validHostConsumer(consumer) || !validFrameInstance(frame) {
		return ModelGatewayChatResult{}, HostContextState{}, trustedHostError()
	}
	hash, err := s.authenticate(token, true)
	if err != nil {
		return ModelGatewayChatResult{}, HostContextState{}, err
	}
	key := hostBindingKey(consumer, frame)
	s.mu.Lock()
	session := s.sessions[hash]
	if session == nil {
		s.mu.Unlock()
		return ModelGatewayChatResult{}, HostContextState{}, trustedHostError()
	}
	binding := session.bindings[key]
	if binding == nil {
		s.mu.Unlock()
		return ModelGatewayChatResult{}, HostContextState{}, trustedHostError()
	}
	if binding.inFlight {
		s.mu.Unlock()
		return ModelGatewayChatResult{}, HostContextState{}, &worldcontext.DomainError{Code: worldcontext.ErrContextUnavailable, Message: "该 frame 已有模型请求执行中"}
	}
	binding.inFlight = true
	runContextID := binding.runContextID
	summary := binding.summary
	libraryRun := binding.libraryRun
	libraryLeading := binding.libraryLeading
	librarySummary := binding.librarySummary
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if current := s.sessions[hash]; current != nil {
			if active := current.bindings[key]; active == binding {
				active.inFlight = false
			}
		}
		s.mu.Unlock()
	}()

	state := HostContextState{State: "none"}
	switch {
	case libraryRun != nil:
		// 库载体：临时背景在绑定期装配（并经 AssembleInitial 计费），每次调用只做
		// 前置与本回合输入的预算计入；iframe 提交的消息照常原样送入模型。
		if chargeErr := chargeHostLibraryInput(libraryRun, req.Messages); chargeErr != nil {
			return ModelGatewayChatResult{}, HostContextState{}, chargeErr
		}
		if libraryLeading != "" {
			messages := make([]ModelGatewayMessage, 0, len(req.Messages)+1)
			messages = append(messages, ModelGatewayMessage{Role: "user", Content: libraryLeading})
			messages = append(messages, req.Messages...)
			req.Messages = messages
		}
		state = librarySummary
	case runContextID != "":
		rc, getErr := s.world.GetWorldRunByID(runContextID, consumer)
		if getErr != nil {
			return ModelGatewayChatResult{}, HostContextState{}, getErr
		}
		ephemeral := agent.NewEphemeralWorldContextInput(rc.ModelViewBytes())
		if ephemeral.Present() {
			messages := make([]ModelGatewayMessage, 0, len(req.Messages)+1)
			messages = append(messages, ModelGatewayMessage{Role: "user", Content: ephemeral.LeadingContent()})
			messages = append(messages, req.Messages...)
			req.Messages = messages
			state = HostContextState{State: "active", WorldName: summary.WorldName, RevisionLabel: summary.RevisionLabel, SelectedCount: summary.SelectedCount}
		}
	}
	if consumer == worldcontext.ConsumerModule4 {
		req.Module = ModelModuleSandbox
	} else {
		req.Module = ModelModuleNarraverse
	}
	result, err := s.app.GenerateModel(ctx, req)
	return result, state, err
}

// chargeHostLibraryInput 把 iframe 本次提交的消息量测后经 ChargeExternal 计入单运行
// 累计预算（与写作链同口径：字节数 + 定点 token 估算）。临时库背景已在绑定期
// AssembleInitial 计费，这里不重复计入；超限返回 budget_exceeded，由 wire 层显式下发。
func chargeHostLibraryInput(run *libraryruntime.Run, messages []ModelGatewayMessage) error {
	if run == nil {
		return nil
	}
	converted := make([]*schema.Message, 0, len(messages))
	totalBytes := 0
	for _, message := range messages {
		totalBytes += len(message.Content)
		converted = append(converted, &schema.Message{Role: schema.RoleType(message.Role), Content: message.Content})
	}
	return run.ChargeExternal(totalBytes, agent.EstimateContextTokens(converted, nil))
}

func (s *WorldContextHostService) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	var released []hostFrameBinding
	for _, session := range s.sessions {
		for _, binding := range session.bindings {
			released = append(released, *binding)
		}
	}
	s.sessions = make(map[[32]byte]*hostSession)
	s.bootstraps = nil
	s.mu.Unlock()
	s.releaseBindings(released)
}
