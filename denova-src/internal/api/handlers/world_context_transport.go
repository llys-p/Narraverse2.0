package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"

	"denova/internal/agent"
	"denova/internal/worldcontext"
)

// Phase 3.2-A1a：写作运行传输 DTO 与纯解码契约（只做传输层，不接 handler、不启动模型、
// 不创建 runContext / Registry / analysisHandle，见
// docs/plans/WORLD_WORKSPACE_PHASE3_2_RUNTIME_INTEGRATION_PLAN.md §6.1 / §8-A1）。
//
// 冻结边界：
//   - handler-owned wire DTO：world_context 子树严格 camelCase，analysis_handle 为顶层 snake_case；
//     不直接把 worldcontext.Ref/Selection 暴露为 HTTP schema（内部 Selection 字段无 json tag，
//     直接序列化会泄漏 PascalCase 形态）。
//   - 顶层请求体对既有 agent.ChatRequest 合法字段全量放行；只对 world_context 子树与受控越权
//     字段做严格校验，保证旧请求逐字段兼容（不能对整个 body 使用 DisallowUnknownFields）。
//   - 纯解码：不写 World、不创建任何运行态、不调模型、不发网络；归属校验（id 是否属于世界、
//     ruleIndexes 是否越界等）属于后续 app 层，本层只做形状/类型/越权校验。
//   - 解码结果把“既有 ChatRequest”与“World Context 控制字段”分离，不把 worldcontext 运行字段
//     塞进 agent.ChatRequest。
const (
	minAnalysisHandleLen = 32
	maxAnalysisHandleLen = 128
)

// WorldContextEndpointPolicy 区分两类端点对 analysis_handle 的消费策略（§6.1 冻结落点表）。
type WorldContextEndpointPolicy int

const (
	// PolicyChat 对应 POST /api/chat（及未来 /api/interactive/chat）：
	// 允许 world_context 与 analysis_handle，且允许二者同时携带（不互斥）。
	PolicyChat WorldContextEndpointPolicy = iota
	// PolicyContextAnalysis 对应 POST /api/chat/context-analysis（及未来 interactive 版）：
	// 允许 world_context，但禁止提交/消费旧 analysis_handle——该请求只负责创建并返回新 handle。
	PolicyContextAnalysis
)

// RuntimeWorldContext 是传输层解码后的 handler-owned 结果（内部类型，不是 HTTP schema）：
// Ref 供后续 app 层消费，AnalysisHandle 是规范化后的不透明 token。
type RuntimeWorldContext struct {
	// Ref 为 nil 表示请求未携带 world_context。
	Ref *worldcontext.Ref
	// HasAnalysisHandle 表示是否携带非空 analysis_handle（"" 与 null 都视为未携带）。
	HasAnalysisHandle bool
	AnalysisHandle    string
	// BackgroundSource 是裁定后的背景来源：legacy | library | none（§8.1）。
	// 显式声明或结构推断，始终非空出站。
	BackgroundSource string
	// LibraryRef 为 nil 表示请求未携带 library_context（library 模式必非 nil）。
	LibraryRef *LibraryContextRef
}

// HasWorldContext 报告是否携带有效 world_context。
func (r RuntimeWorldContext) HasWorldContext() bool { return r.Ref != nil }

// HasLibraryContext 报告是否携带有效 library_context。
func (r RuntimeWorldContext) HasLibraryContext() bool { return r.LibraryRef != nil }

// 背景来源枚举（§8.1 冻结：background_source 顶层 snake_case）。
const (
	BackgroundSourceLegacy  = "legacy"
	BackgroundSourceLibrary = "library"
	BackgroundSourceNone    = "none"
)

// BackgroundSourceConflictCode 是 library_context 与 world_context/analysis_handle
// 同现时的拒绝码：HTTP 400 background_source_conflict，禁止任何优先级吞并。
const BackgroundSourceConflictCode worldcontext.ErrorCode = "background_source_conflict"

// transportBackgroundSourceConflict 构造背景来源冲突领域错误。
func transportBackgroundSourceConflict(field, msg string) *worldcontext.DomainError {
	return &worldcontext.DomainError{
		Code:    BackgroundSourceConflictCode,
		Field:   field,
		Message: msg,
	}
}

// LibraryContextRef 是传输层解码后的库控制字段（handler-owned，服务端持有）。
// consumer/scopeKey/runContextId 等运行身份字段在传输层一律拒绝，不在此结构出现。
type LibraryContextRef struct {
	LibraryID        string
	ExpectedRevision string
	ManualItemIDs    []string
}

// libraryContextRefWire 是 library_context 子树的冻结 wire 形态（严格 camelCase 白名单，
// 内层命名与 L2 preview DTO 一致）。
type libraryContextRefWire struct {
	LibraryID        string   `json:"libraryId"`
	ExpectedRevision string   `json:"expectedRevision"`
	ManualItemIDs    []string `json:"manualItemIds"`
}

var libraryContextRefWireKeys = map[string]struct{}{
	"libraryId":        {},
	"expectedRevision": {},
	"manualItemIds":    {},
}

// worldContextEnvelope 只声明受控的两个顶层键；其余顶层键是 agent.ChatRequest 的领域，
// 解码到 map 时原样保留但不在此消费（默认放行，保证旧请求兼容）。
// 这里用 map[string]RawMessage 而非结构体：既能枚举顶层键以拦截越权字段，又能借助
// json.Unmarshal 天然拒绝“多个 JSON 值 / 尾随 JSON”。

// worldContextRefWire 是 world_context 子树的冻结 wire 形态（严格 camelCase 白名单）。
type worldContextRefWire struct {
	WorldID               string          `json:"worldId"`
	ExpectedWorldRevision string          `json:"expectedWorldRevision"`
	Selection             json.RawMessage `json:"selection"`
}

var worldContextRefWireKeys = map[string]struct{}{
	"worldId":               {},
	"expectedWorldRevision": {},
	"selection":             {},
}

var worldContextSelectionWireKeys = map[string]struct{}{
	"includeTone":      {},
	"ruleIndexes":      {},
	"characterIds":     {},
	"locationIds":      {},
	"factionIds":       {},
	"timelineEntryIds": {},
	"bindingIds":       {},
}

// forbiddenWorldContextKeys 是无论出现在顶层还是 world_context 子树都必须拒绝的越权字段：
// consumer 由路由固定；scope/runContext/capability 等是服务端内部运行态；snapshot/modelView
// 是运行时派生数据，禁止客户端提交。
var forbiddenWorldContextKeys = map[string]string{
	"consumer":         "consumer 由服务端路由固定，不允许客户端提交",
	"scope":            "scope 为服务端内部运行字段，不允许提交",
	"scopeKey":         "scopeKey 为服务端内部运行字段，不允许提交",
	"run_scope":        "run_scope 为服务端内部运行字段，不允许提交",
	"runContextId":     "runContextId 为服务端内部运行字段，不允许提交",
	"run_context_id":   "run_context_id 为服务端内部运行字段，不允许提交",
	"interactiveRunId": "interactiveRunId 为服务端内部运行字段，不允许提交",
	"taskId":           "taskId is a server-internal runtime field and cannot be submitted by clients",
	"runContextID":     "runContextID is a server-internal runtime field and cannot be submitted by clients",
	"capability":       "capability 为服务端内部运行字段，不允许提交",
	"snapshot":         "snapshot 是运行时派生数据，不允许提交",
	"modelView":        "modelView 是运行时派生数据，不允许提交",
}

// DecodeWorldContextTransport 从请求体中纯解码 World Context 控制字段。
//
// 不消费、不拒绝任何既有 agent.ChatRequest 业务字段；world_context 子树与受控越权字段严格校验。
// policy 决定 analysis_handle 是否允许被消费。返回的 RuntimeWorldContext 与 agent.ChatRequest 分离。
func DecodeWorldContextTransport(body []byte, policy WorldContextEndpointPolicy) (RuntimeWorldContext, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		// 空请求体：无任何 World Context 控制字段（旧请求兼容；message 等业务字段由各 handler 自行校验）。
		return RuntimeWorldContext{}, nil
	}

	// 顶层枚举：json.Unmarshal 到 map 天然要求“单个 JSON 值”，会拒绝尾随/多 JSON/非对象类型；
	// null 得到 nil map（等同未携带任何控制字段）。
	top := map[string]json.RawMessage{}
	if err := json.Unmarshal(trimmed, &top); err != nil {
		return RuntimeWorldContext{}, transportInvalidRequest("body", "请求体必须是单个 JSON 对象")
	}

	for key := range top {
		if msg, forbidden := forbiddenWorldContextKeys[key]; forbidden {
			return RuntimeWorldContext{}, transportInvalidRequest(key, msg)
		}
	}

	out := RuntimeWorldContext{}

	if raw, ok := top["world_context"]; ok {
		ref, err := decodeWorldContextRef(raw)
		if err != nil {
			return RuntimeWorldContext{}, err
		}
		out.Ref = ref
	}

	if raw, ok := top["analysis_handle"]; ok {
		handle, present, err := decodeAnalysisHandle(raw)
		if err != nil {
			return RuntimeWorldContext{}, err
		}
		if present {
			if policy == PolicyContextAnalysis {
				// context-analysis 只负责创建并返回新 handle，不允许消费旧 handle。
				return RuntimeWorldContext{}, transportInvalidRequest(
					"analysis_handle",
					"context-analysis 不允许提交 analysis_handle，该请求只负责创建新的分析句柄",
				)
			}
			out.HasAnalysisHandle = true
			out.AnalysisHandle = handle
		}
	}

	// B2a（§8.1）：背景来源声明与 library 载体。二者都必须先于裁定完成形状/越权校验。
	explicitSource := ""
	if raw, ok := top["background_source"]; ok {
		source, present, err := decodeBackgroundSource(raw)
		if err != nil {
			return RuntimeWorldContext{}, err
		}
		if present {
			explicitSource = source
		}
	}
	if raw, ok := top["library_context"]; ok {
		ref, err := decodeLibraryContextRef(raw)
		if err != nil {
			return RuntimeWorldContext{}, err
		}
		out.LibraryRef = ref
	}
	source, resolveErr := resolveBackgroundSource(explicitSource, out, policy)
	if resolveErr != nil {
		return RuntimeWorldContext{}, resolveErr
	}
	out.BackgroundSource = source
	return out, nil
}

// resolveBackgroundSource 裁定最终背景来源并执行冲突/一致性拒绝（§8.1）。
//   - library_context 与 world_context/analysis_handle 同现 → background_source_conflict，
//     禁止任何优先级吞并；
//   - 显式声明与控制字段不一致（library 无载体、none 带字段、legacy 带 library 载体）→ invalid_request；
//   - 缺省时结构推断：有 library_context→library，有 world 字段→legacy，全无→none；旧请求行为不变。
//   - PolicyContextAnalysis 不支持 library 背景交接（§8.3：库预览走 L2 preview 端点，咨询性）。
func resolveBackgroundSource(explicit string, out RuntimeWorldContext, policy WorldContextEndpointPolicy) (string, error) {
	hasLibrary := out.LibraryRef != nil
	hasWorldCarrier := out.Ref != nil || out.HasAnalysisHandle
	if hasLibrary && hasWorldCarrier {
		return "", transportBackgroundSourceConflict(
			"library_context",
			"library_context 与 world_context/analysis_handle 互斥，不能同时提交背景控制字段",
		)
	}
	switch explicit {
	case BackgroundSourceLibrary:
		if !hasLibrary {
			return "", transportInvalidRequest("background_source", "background_source=library 必须携带 library_context")
		}
	case BackgroundSourceLegacy:
		if hasLibrary {
			return "", transportBackgroundSourceConflict("background_source", "background_source=legacy 不能携带 library_context")
		}
	case BackgroundSourceNone:
		if hasLibrary || hasWorldCarrier {
			return "", transportInvalidRequest("background_source", "background_source=none 不能携带任何背景控制字段")
		}
	case "":
		// 缺省：结构推断。
		switch {
		case hasLibrary:
			explicit = BackgroundSourceLibrary
		case hasWorldCarrier:
			explicit = BackgroundSourceLegacy
		default:
			explicit = BackgroundSourceNone
		}
	}
	if explicit == BackgroundSourceLibrary && policy == PolicyContextAnalysis {
		return "", transportInvalidRequest(
			"library_context",
			"context-analysis 不支持 library 背景交接；请使用作品设定库预览端点（咨询性，不建立运行授权）",
		)
	}
	return explicit, nil
}

// decodeBackgroundSource 解码顶层 background_source：null/""/缺省视为未声明；
// 非字符串或非 legacy|library|none 一律拒绝。
func decodeBackgroundSource(raw json.RawMessage) (string, bool, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return "", false, nil
	}
	var source string
	if err := json.Unmarshal(trimmed, &source); err != nil {
		return "", false, transportInvalidRequest("background_source", "background_source 必须是字符串")
	}
	if source == "" {
		return "", false, nil
	}
	switch source {
	case BackgroundSourceLegacy, BackgroundSourceLibrary, BackgroundSourceNone:
		return source, true, nil
	default:
		return "", false, transportInvalidRequest(
			"background_source",
			"background_source 必须是 legacy|library|none",
		)
	}
}

// decodeLibraryContextRef 严格解码 library_context 子树：越权字段与未知字段精确拒绝，
// manualItemIds 只做形状校验（去空白），条目存在性/启用/归属属于 app 绑定期校验。
func decodeLibraryContextRef(raw json.RawMessage) (*LibraryContextRef, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		// library_context: null 等同未携带。
		return nil, nil
	}

	// 必须是 JSON 对象（拒绝数组/字符串/数字/布尔）。
	keys := map[string]json.RawMessage{}
	if err := json.Unmarshal(trimmed, &keys); err != nil {
		return nil, transportInvalidRequest("library_context", "library_context 必须是 JSON 对象")
	}
	for key := range keys {
		if msg, forbidden := forbiddenWorldContextKeys[key]; forbidden {
			return nil, transportInvalidRequest("library_context."+key, msg)
		}
		if _, allowed := libraryContextRefWireKeys[key]; !allowed {
			return nil, transportInvalidRequest("library_context."+key, "library_context 包含未知字段")
		}
	}

	var wire libraryContextRefWire
	if err := decodeStrictJSON(trimmed, &wire); err != nil {
		return nil, transportInvalidRequest("library_context", "library_context 包含非法字段或类型: "+err.Error())
	}
	if strings.TrimSpace(wire.LibraryID) == "" {
		return nil, transportInvalidRequest("library_context.libraryId", "library_context.libraryId 不能为空")
	}
	if strings.TrimSpace(wire.ExpectedRevision) == "" {
		return nil, transportInvalidRequest("library_context.expectedRevision", "library_context.expectedRevision 不能为空")
	}
	manualIDs := make([]string, 0, len(wire.ManualItemIDs))
	for _, id := range wire.ManualItemIDs {
		id = strings.TrimSpace(id)
		if id == "" {
			return nil, transportInvalidRequest("library_context.manualItemIds", "library_context.manualItemIds 包含空条目")
		}
		manualIDs = append(manualIDs, id)
	}
	return &LibraryContextRef{
		LibraryID:        strings.TrimSpace(wire.LibraryID),
		ExpectedRevision: strings.TrimSpace(wire.ExpectedRevision),
		ManualItemIDs:    manualIDs,
	}, nil
}

// decodeWorldContextRef 严格解码 world_context 子树：越权字段精确拦截，其余未知字段由
// DisallowUnknownFields 兜底拒绝；selection 复用 worldcontext.DecodeSelection 的冻结形状校验。
func decodeWorldContextRef(raw json.RawMessage) (*worldcontext.Ref, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		// world_context: null 等同未携带。
		return nil, nil
	}

	// 必须是 JSON 对象（拒绝数组/字符串/数字/布尔）。
	keys := map[string]json.RawMessage{}
	if err := json.Unmarshal(trimmed, &keys); err != nil {
		return nil, transportInvalidRequest("world_context", "world_context 必须是 JSON 对象")
	}
	for key := range keys {
		if msg, forbidden := forbiddenWorldContextKeys[key]; forbidden {
			return nil, transportInvalidRequest("world_context."+key, msg)
		}
		if _, allowed := worldContextRefWireKeys[key]; !allowed {
			return nil, transportInvalidRequest("world_context."+key, "world_context 包含未知字段")
		}
	}

	var wire worldContextRefWire
	if err := decodeStrictJSON(trimmed, &wire); err != nil {
		return nil, transportInvalidRequest("world_context", "world_context 包含非法字段或类型: "+err.Error())
	}

	// selection 缺省等价于 {}；形状/未知字段/类型/数量上限全部交给领域层冻结实现。
	selectionRaw := wire.Selection
	if len(bytes.TrimSpace(selectionRaw)) == 0 {
		selectionRaw = json.RawMessage(`{}`)
	}
	if err := validateExactSelectionWireKeys(selectionRaw); err != nil {
		return nil, err
	}
	selection, err := worldcontext.DecodeSelection(selectionRaw)
	if err != nil {
		return nil, err
	}

	return &worldcontext.Ref{
		WorldID:               wire.WorldID,
		ExpectedWorldRevision: wire.ExpectedWorldRevision,
		Selection:             selection,
	}, nil
}

// validateExactSelectionWireKeys 在领域 DecodeSelection 前锁定传输层字段拼写。
// encoding/json 对结构体字段默认接受大小写不敏感匹配，仅靠 DisallowUnknownFields
// 无法保证冻结的 camelCase wire schema。
func validateExactSelectionWireKeys(raw json.RawMessage) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	keys := map[string]json.RawMessage{}
	if err := json.Unmarshal(trimmed, &keys); err != nil {
		return transportInvalidRequest("world_context.selection", "selection 必须是 JSON 对象")
	}
	for key := range keys {
		if _, allowed := worldContextSelectionWireKeys[key]; !allowed {
			return transportInvalidRequest("world_context.selection."+key, "selection 包含未知字段")
		}
	}
	return nil
}

// decodeAnalysisHandle 规范化 analysis_handle：
// 缺省 / null / "" 视为未携带；非字符串拒绝；非空值必须是 32~128 位 base64url 字符。
// 不解析 JWT/JSON 或任何业务字段。返回 (token, present, err)。
func decodeAnalysisHandle(raw json.RawMessage) (string, bool, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return "", false, nil
	}
	var token string
	if err := json.Unmarshal(trimmed, &token); err != nil {
		return "", false, transportInvalidRequest("analysis_handle", "analysis_handle 必须是字符串")
	}
	if token == "" {
		return "", false, nil
	}
	if !isValidAnalysisHandle(token) {
		return "", false, transportInvalidRequest(
			"analysis_handle",
			"analysis_handle 格式非法：必须是 32~128 位 base64url 字符（A-Z a-z 0-9 - _）",
		)
	}
	return token, true, nil
}

// isValidAnalysisHandle 校验不透明 token 的字符集与长度（字节长度，base64url 字母表）。
func isValidAnalysisHandle(token string) bool {
	if len(token) < minAnalysisHandleLen || len(token) > maxAnalysisHandleLen {
		return false
	}
	for i := 0; i < len(token); i++ {
		c := token[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_':
		default:
			return false
		}
	}
	return true
}

// DecodeChatRequestWithoutWorldContext 解码既有 agent.ChatRequest。encoding/json 默认忽略未知键，
// 因此 world_context / analysis_handle 等控制字段不会进入 ChatRequest；控制字段必须先经
// DecodeWorldContextTransport 严格校验。二者分离，禁止把 worldcontext 运行字段加进 ChatRequest。
func DecodeChatRequestWithoutWorldContext(body []byte, req *agent.ChatRequest) error {
	if req == nil {
		return errors.New("agent.ChatRequest 不能为空")
	}
	return json.Unmarshal(bytes.TrimSpace(body), req)
}

// transportInvalidRequest 构造传输层 invalid_request 领域错误（不暴露内部路径）。
func transportInvalidRequest(field, msg string) *worldcontext.DomainError {
	return &worldcontext.DomainError{
		Code:    worldcontext.ErrInvalidRequest,
		Field:   field,
		Message: msg,
	}
}
