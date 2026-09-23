// Package libraryruntime 实现作品设定库的临时读取授权核心（L3 计划 §8 B0 冻结契约，批次 B1/L3.0）。
//
// 冻结不变量（违反即契约变更，须先改 L3 计划 §8）：
//   - 本包是 per-run 临时授权对象，没有包级可变状态、没有第二 Registry；运行身份
//     （consumer/scopeKey）由受控入口（app/agent 适配层）服务端派生后注入，客户端与
//     模型提交的任何身份字段在这里一律无效；
//   - Run 只保留元数据（库 ID、固定 revision、manual 授权集、预算计数、状态码），
//     绝不保留任何设定正文；正文只在 AssembleInitial/ReadOnDemand 的返回值中出现，
//     由调用方送入当次模型输入，不落库、World、Session、压缩摘要、run ledger、
//     display 或任何持久记录；
//   - 库正文唯一来源是注入的 LibraryProvider（读已保存库）与 librarycontext.Resolver
//     （受控 Master 解析），本包不读写磁盘、不感知路径，Locator 永远不是读取许可；
//   - 单运行单库单 revision：绑定期固定 revision，此后每次装配/按需读取都重新核对
//     当前 revision，变化即 stale（library_revision_conflict 语义），停止追加旧授权
//     下的新正文，也绝不把新版本内容悄悄当成原版本；
//   - 累计预算是单运行单计数器（绑定期计入系统提示+历史基线与预留输出，随后计入
//     初始装配与每次按需读取，同项重复读取照计），沿用 librarycontext 的同一定点
//     估算口径；绑定期预算失败阻断启动，不静默降级；
//   - 运行期读取失败显式 unavailable|stale|denied|budget_exceeded（外加生命周期的
//     released），绝不标 active 却暗中 bare。
//
// 依赖方向：libraryruntime → librarycontext → library。禁止反向依赖 App/HTTP/agent。
package libraryruntime

import (
	"context"
	"fmt"
	"sync"

	"denova/internal/library"
	"denova/internal/librarycontext"
)

// Consumer 标识消费模式；与 internal/worldcontext 的取值保持一致，永远由服务端派生。
type Consumer string

const (
	ConsumerWriting    Consumer = "writing"
	ConsumerGame       Consumer = "game"
	ConsumerNarraverse Consumer = "narraverse"
	ConsumerModule4    Consumer = "module4"
)

func supportedConsumer(consumer Consumer) bool {
	switch consumer {
	case ConsumerWriting, ConsumerGame, ConsumerNarraverse, ConsumerModule4:
		return true
	default:
		return false
	}
}

// ErrorCode 是稳定错误码：绑定期失败阻断启动；运行期读取失败显式分类，
// 客户端 wire 层（B2/B3 接线时）只映射这些码，不透出正文或内部路径。
type ErrorCode string

const (
	// 绑定期（模型启动前）阻断错误。
	ErrInvalidRequest     ErrorCode = "invalid_request"
	ErrConsumerNotTrusted ErrorCode = "consumer_not_trusted"
	ErrSelectionInvalid   ErrorCode = "selection_invalid"
	ErrRevisionConflict   ErrorCode = "revision_conflict"
	ErrLibraryUnavailable ErrorCode = "library_unavailable"
	ErrBudgetExceeded     ErrorCode = "budget_exceeded"
	// 运行期按需读取显式错误（§8.4 四类）。
	ErrUnavailable ErrorCode = "unavailable"
	ErrStale       ErrorCode = "stale"
	ErrDenied      ErrorCode = "denied"
	// 生命周期误用：运行已 complete/cancel 后继续读取；显式报错，绝不静默 bare。
	ErrReleased ErrorCode = "released"
)

// Error 是本包的唯一错误类型；Message 不含库正文与本机路径。
type Error struct {
	Code    ErrorCode
	Message string
}

func (e *Error) Error() string { return string(e.Code) + ": " + e.Message }

func fail(code ErrorCode, message string) *Error { return &Error{Code: code, Message: message} }

// CodeOf 返回错误的稳定码；非本包错误（含 ctx 取消）返回空串，由调用方原样处理。
func CodeOf(err error) ErrorCode {
	if err == nil {
		return ""
	}
	if domainErr, ok := err.(*Error); ok {
		return domainErr.Code
	}
	return ""
}

// Config 是单运行累计预算与初始目录边界（B0 §8.3：数值常量是 L3.0 配置项，不写死在契约）。
// 初始装配本体仍受 L2 预览常量（librarycontext.MaxPreviewBytes/MaxEstimatedTokens）约束；
// 本计数器覆盖初始装配 + 按需读取 + 调用方已知基线（系统提示+历史）+ 预留输出。
type Config struct {
	// MaxBytes 是本运行设定库来源内容的累计字节上限。
	MaxBytes int
	// MaxEstimatedTokens 是累计 token 估算上限（同 librarycontext 口径）。
	MaxEstimatedTokens int
	// ReservedOutputTokens 在绑定期一次性计入，为模型输出预留额度。
	// 零/负值表示未指定→用默认；显式值必须小于 MaxEstimatedTokens，否则 Bind
	// 显式 invalid_request（不静默改写）。
	ReservedOutputTokens int
	// InitialCatalogLimit 是初始装配中有界 auto 目录的长度（1~librarycontext.MaxCatalogLimit）。
	InitialCatalogLimit int
}

// DefaultConfig 返回默认预算：初始装配 ≤ L2 预览上限（256KB/16k tokens），
// 累计上限给按需读取留一倍余量，预留输出按常规长回复估算。所有值可被调用方覆盖。
func DefaultConfig() Config {
	return Config{
		MaxBytes:             512 * 1024,
		MaxEstimatedTokens:   32000,
		ReservedOutputTokens: 8000,
		InitialCatalogLimit:  50,
	}
}

func normalizeConfig(cfg Config) Config {
	def := DefaultConfig()
	if cfg.MaxBytes <= 0 {
		cfg.MaxBytes = def.MaxBytes
	}
	if cfg.MaxEstimatedTokens <= 0 {
		cfg.MaxEstimatedTokens = def.MaxEstimatedTokens
	}
	// 与同结构体其他字段同语义：零/负=未指定→默认。显式值若 ≥ 累计上限属配置错误，
	// 由 Bind 显式拒绝，绝不静默改写成又一个可能仍不可用的绝对默认。
	if cfg.ReservedOutputTokens <= 0 {
		cfg.ReservedOutputTokens = def.ReservedOutputTokens
	}
	if cfg.InitialCatalogLimit <= 0 {
		cfg.InitialCatalogLimit = def.InitialCatalogLimit
	}
	if cfg.InitialCatalogLimit > librarycontext.MaxCatalogLimit {
		cfg.InitialCatalogLimit = librarycontext.MaxCatalogLimit
	}
	return cfg
}

// LibraryProvider 由受控适配层注入，读取一份已保存库并返回其当前内容哈希 revision。
// 它是本包感知库正文的唯一入口；本包不持有文件路径，不缓存库副本。
type LibraryProvider func(ctx context.Context, libraryID string) (library.Library, string, error)

// BindInput 是一次运行绑定的全部输入：服务端派生的身份 + 用户显式选择的授权。
// L2 预览的 autoItemIds 只是预览模拟，不进入这里——运行授权只有 manual 集合。
type BindInput struct {
	Consumer         Consumer
	ScopeKey         string // 服务端派生的运行归属（如 "task:<id>"）；对模型不可见、不可提交
	LibraryID        string
	ExpectedRevision string // 选择时已保存的库版本，绑定后固定
	ManualItemIDs    []string
	Config           Config
	// BaselineBytes/BaselineTokens 是调用方在绑定期已知的固定成本（系统提示+历史），
	// 计入同一累计计数器，保证“单运行单计数器”覆盖完整模型输入预算。
	BaselineBytes  int
	BaselineTokens int
}

type runState int

const (
	stateActive runState = iota
	stateCompleted
	stateCancelled
)

// Run 是一次运行的临时读取授权。正文只经 AssembleInitial/ReadOnDemand 返回值流动，
// Run 自身只保存元数据；complete/cancel 幂等释放（首个终态生效，无负引用计数）。
type Run struct {
	mu          sync.Mutex
	consumer    Consumer
	scopeKey    string
	libraryID   string
	revision    string // 固定的期望 revision，绑定后不变
	libraryName string
	manual      map[string]struct{}
	provider    LibraryProvider
	resolver    librarycontext.Resolver
	cfg         Config
	bytesUsed   int
	tokensUsed  int
	state       runState
	lastErrCode ErrorCode
}

// Bind 建立一次运行的读取授权。任何绑定期失败都阻断启动（返回错误，不产生 Run、
// 不产生 ephemeral 输入、不静默降级为无背景）；这是 §8.4“绑定期失败阻断启动”的实现。
func Bind(ctx context.Context, in BindInput, provider LibraryProvider, resolver librarycontext.Resolver) (*Run, error) {
	if provider == nil {
		return nil, fail(ErrInvalidRequest, "library provider is required")
	}
	if !supportedConsumer(in.Consumer) {
		return nil, fail(ErrConsumerNotTrusted, "consumer is not trusted: "+string(in.Consumer))
	}
	if trim(in.ScopeKey) == "" {
		return nil, fail(ErrInvalidRequest, "scope key is required")
	}
	if !library.ValidLibraryID(in.LibraryID) {
		return nil, fail(ErrInvalidRequest, "library id is invalid")
	}
	if trim(in.ExpectedRevision) == "" {
		return nil, fail(ErrInvalidRequest, "expected revision is required to pin the library")
	}
	if in.BaselineBytes < 0 || in.BaselineTokens < 0 {
		return nil, fail(ErrInvalidRequest, "baseline costs must not be negative")
	}
	manual, err := normalizeManualIDs(in.ManualItemIDs)
	if err != nil {
		return nil, err
	}
	cfg := normalizeConfig(in.Config)
	// 预留输出必须装得进累计预算：显式越界（≥ 累计 token 上限）是配置错误，
	// 绑定期显式 invalid_request，绝不静默改写后再用误导性的 budget_exceeded 阻断。
	if cfg.ReservedOutputTokens >= cfg.MaxEstimatedTokens {
		return nil, fail(ErrInvalidRequest, "reserved output tokens must be smaller than the cumulative token budget")
	}
	l, revision, err := provider(ctx, in.LibraryID)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fail(ErrLibraryUnavailable, "cannot load the bound library")
	}
	if revision != in.ExpectedRevision {
		return nil, fail(ErrRevisionConflict, "library revision changed since selection")
	}
	// manual 集合逐项校验：必须存在、启用且为 manual 档；禁用/跨库/未知/非 manual 档一律拒绝。
	items := make(map[string]library.Item, len(l.Items))
	for _, item := range l.Items {
		items[item.ID] = item
	}
	for id := range manual {
		item, ok := items[id]
		if !ok || !item.Enabled || item.LoadMode != library.LoadModeManual {
			return nil, fail(ErrSelectionInvalid, "manual item is unknown, disabled or not manual-mode: "+id)
		}
	}
	run := &Run{
		consumer:    in.Consumer,
		scopeKey:    trim(in.ScopeKey),
		libraryID:   in.LibraryID,
		revision:    revision,
		libraryName: l.Name,
		manual:      manual,
		provider:    provider,
		resolver:    resolver,
		cfg:         cfg,
		bytesUsed:   in.BaselineBytes,
		tokensUsed:  in.BaselineTokens + cfg.ReservedOutputTokens,
		state:       stateActive,
	}
	// 基线+预留输出即刻计入唯一计数器；放不下就阻断启动，绝不“先跑起来再说”。
	if run.bytesUsed > cfg.MaxBytes || run.tokensUsed > cfg.MaxEstimatedTokens {
		return nil, fail(ErrBudgetExceeded, "baseline costs plus reserved output exceed the run budget")
	}
	return run, nil
}

// normalizeManualIDs 去重并校验 manual 授权集的形状（数量上限沿用 L2 加载上限）。
func normalizeManualIDs(ids []string) (map[string]struct{}, error) {
	manual := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		id = trim(id)
		if id == "" {
			return nil, fail(ErrInvalidRequest, "manual item id must not be blank")
		}
		manual[id] = struct{}{}
	}
	if len(manual) > librarycontext.MaxLoadedItems {
		return nil, fail(ErrInvalidRequest, fmt.Sprintf("manual selection exceeds %d items", librarycontext.MaxLoadedItems))
	}
	return manual, nil
}

// Status 是服务端可见的脱敏运行状态（wire 投影在 B2/B3 由适配层进一步裁剪）。
// 错误只能通过 ErrorCode 显式暴露，永不伪装成 active-with-background。
type Status struct {
	State               string // "active" | "completed" | "cancelled"
	LibraryID           string
	LibraryName         string
	Revision            string
	ManualCount         int
	BytesUsed           int
	EstimatedTokensUsed int
	MaxBytes            int
	MaxEstimatedTokens  int
	LastErrorCode       ErrorCode // 最近一次装配/读取失败的稳定码；无失败为空
}

// Status 返回当前状态快照；只含元数据，绝不含正文。
func (r *Run) Status() Status {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := "active"
	switch r.state {
	case stateCompleted:
		state = "completed"
	case stateCancelled:
		state = "cancelled"
	case stateActive:
	}
	return Status{
		State:               state,
		LibraryID:           r.libraryID,
		LibraryName:         r.libraryName,
		Revision:            r.revision,
		ManualCount:         len(r.manual),
		BytesUsed:           r.bytesUsed,
		EstimatedTokensUsed: r.tokensUsed,
		MaxBytes:            r.cfg.MaxBytes,
		MaxEstimatedTokens:  r.cfg.MaxEstimatedTokens,
		LastErrorCode:       r.lastErrCode,
	}
}

// Consumer 返回服务端派生的消费模式（供适配层核对接线，不下发给客户端/模型）。
func (r *Run) Consumer() Consumer {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.consumer
}

// ScopeKey 返回服务端派生的运行归属。
func (r *Run) ScopeKey() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.scopeKey
}

// Complete 幂等结束运行：首个终态生效，重复调用与随后的 Cancel 都是无副作用的 no-op。
func (r *Run) Complete() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.state == stateActive {
		r.state = stateCompleted
	}
}

// Cancel 幂等取消运行：语义与 Complete 相同，只是终态标记不同（供审计区分正常结束与中止）。
func (r *Run) Cancel() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.state == stateActive {
		r.state = stateCancelled
	}
}

// ChargeExternal 把接线层在运行中产生的已知成本计入同一累计计数器（§8.3：单计数器
// 覆盖系统提示+历史+初始装配+每次按需读取工具结果+预留输出）。写作/游戏等模式下
// 历史逐轮增长、真实系统提示与按需读取工具结果的外包装文本都由调用方量测后经此
// 通道计入，保证“每次读取前校验剩余额度”对完整模型输入成立。它不是读取许可、
// 不返回任何正文：超限显式 budget_exceeded（不部分计入），负数 invalid_request，
// 终态后 released。
func (r *Run) ChargeExternal(bytes, tokens int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.requireActiveLocked(); err != nil {
		return err
	}
	if bytes < 0 || tokens < 0 {
		r.lastErrCode = ErrInvalidRequest
		return fail(ErrInvalidRequest, "external charge must not be negative")
	}
	return r.chargeLocked(bytes, tokens)
}

// requireActiveLocked 校验运行仍处于 active；终态后一切读取显式 released，不静默变 bare。
func (r *Run) requireActiveLocked() error {
	if r.state != stateActive {
		r.lastErrCode = ErrReleased
		return fail(ErrReleased, "run is already completed or cancelled")
	}
	return nil
}

// chargeLocked 在唯一计数器上计入一次用量；超限即拒绝本次读取，不部分计入。
func (r *Run) chargeLocked(bytes, tokens int) error {
	if r.bytesUsed+bytes > r.cfg.MaxBytes || r.tokensUsed+tokens > r.cfg.MaxEstimatedTokens {
		r.lastErrCode = ErrBudgetExceeded
		return fail(ErrBudgetExceeded, "cumulative run budget exceeded")
	}
	r.bytesUsed += bytes
	r.tokensUsed += tokens
	return nil
}

// loadPinnedLocked 重新读取绑定的库并核对 revision；变化即 stale（§8.3：
// 停止追加旧授权下的新正文，也拒绝把当前文件内容当成原版本）。
func (r *Run) loadPinnedLocked(ctx context.Context) (library.Library, error) {
	l, revision, err := r.provider(ctx, r.libraryID)
	if err != nil {
		if ctx.Err() != nil {
			return library.Library{}, ctx.Err()
		}
		r.lastErrCode = ErrUnavailable
		return library.Library{}, fail(ErrUnavailable, "cannot load the bound library")
	}
	if revision != r.revision {
		r.lastErrCode = ErrStale
		return library.Library{}, fail(ErrStale, "library revision changed during the run")
	}
	return l, nil
}
