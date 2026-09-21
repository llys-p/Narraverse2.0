package handlers

import (
	"strings"
	"testing"

	"denova/internal/agent"
	"denova/internal/worldcontext"
)

// Phase 3.2-A1a 传输契约测试：只验证纯解码/映射，不接 handler、不创建运行态、不调模型。

func repeatHandle(n int) string { return strings.Repeat("a", n) }

func wantInvalidRequest(t *testing.T, err error, fieldContains string) {
	t.Helper()
	if err == nil {
		t.Fatalf("期望 invalid_request 错误（字段含 %q），实际 nil", fieldContains)
	}
	de, ok := err.(*worldcontext.DomainError)
	if !ok {
		t.Fatalf("期望 *worldcontext.DomainError，实际 %T: %v", err, err)
	}
	if de.Code != worldcontext.ErrInvalidRequest {
		t.Fatalf("期望 code=%s，实际 %s", worldcontext.ErrInvalidRequest, de.Code)
	}
	if fieldContains != "" && !strings.Contains(de.Field, fieldContains) {
		t.Fatalf("期望错误字段包含 %q，实际 field=%q", fieldContains, de.Field)
	}
}

// 1) 旧 chat 请求逐字段兼容：不携带任何控制字段时正常，且不影响既有 ChatRequest 字段。
func TestWorldContextTransportLegacyChat(t *testing.T) {
	body := []byte(`{
		"message":"hi",
		"references":["r1"],
		"lore_references":["l1"],
		"style_scenes":["scene1"],
		"selections":[{"file_name":"chapter.md","start_line":2,"end_line":4,"content":"selected"}],
		"ide_context":{"current_file":"chapter.md","open_files":["chapter.md","notes.md"]},
		"review_feedback":[{"source":"review","review_thread_id":"thread-1","comment_ids":["comment-1"]}],
		"plan_mode":true,
		"writing_skill":"s",
		"image_preset_id":"preset-1",
		"teller_id":"t"
	}`)
	got, err := DecodeWorldContextTransport(body, PolicyChat)
	if err != nil {
		t.Fatalf("旧请求不应报错: %v", err)
	}
	if got.HasWorldContext() || got.HasAnalysisHandle {
		t.Fatalf("旧请求不应解析出控制字段: %+v", got)
	}

	var req agent.ChatRequest
	if err := DecodeChatRequestWithoutWorldContext(body, &req); err != nil {
		t.Fatalf("ChatRequest 解码失败: %v", err)
	}
	if req.Message != "hi" || !req.PlanMode || req.TellerID != "t" || req.WritingSkill != "s" || req.ImagePresetID != "preset-1" {
		t.Fatalf("ChatRequest 标量字段未逐字段保留: %+v", req)
	}
	if len(req.References) != 1 || req.References[0] != "r1" ||
		len(req.LoreReferences) != 1 || req.LoreReferences[0] != "l1" ||
		len(req.StyleScenes) != 1 || req.StyleScenes[0] != "scene1" {
		t.Fatalf("ChatRequest 引用字段未逐字段保留: %+v", req)
	}
	if len(req.Selections) != 1 || req.Selections[0].FileName != "chapter.md" ||
		req.Selections[0].StartLine != 2 || req.Selections[0].EndLine != 4 || req.Selections[0].Content != "selected" {
		t.Fatalf("ChatRequest selections 未保留: %+v", req.Selections)
	}
	if req.IDEContext.CurrentFile != "chapter.md" || len(req.IDEContext.OpenFiles) != 2 {
		t.Fatalf("ChatRequest ide_context 未保留: %+v", req.IDEContext)
	}
	if len(req.ReviewFeedback) != 1 || req.ReviewFeedback[0].Source != "review" ||
		req.ReviewFeedback[0].ReviewThreadID != "thread-1" || len(req.ReviewFeedback[0].CommentIDs) != 1 {
		t.Fatalf("ChatRequest 字段未逐字段保留: %+v", req)
	}
}

// 2) 只有 world_context。
func TestWorldContextTransportWorldContextOnly(t *testing.T) {
	body := []byte(`{"message":"m","world_context":{"worldId":"w1","expectedWorldRevision":"sha256:abc",` +
		`"selection":{"includeTone":true,"ruleIndexes":[0,2],"characterIds":["c1"],"locationIds":[],"factionIds":[],` +
		`"timelineEntryIds":[],"bindingIds":[]}}}`)
	got, err := DecodeWorldContextTransport(body, PolicyChat)
	if err != nil {
		t.Fatalf("仅 world_context 不应报错: %v", err)
	}
	if !got.HasWorldContext() {
		t.Fatal("期望携带 Ref")
	}
	if got.HasAnalysisHandle {
		t.Fatal("不应携带 analysis_handle")
	}
	ref := got.Ref
	if ref.WorldID != "w1" || ref.ExpectedWorldRevision != "sha256:abc" {
		t.Fatalf("Ref 身份字段错误: %+v", ref)
	}
	if !ref.Selection.IncludeTone {
		t.Fatal("includeTone 应为 true")
	}
	if len(ref.Selection.RuleIndexes) != 2 || ref.Selection.RuleIndexes[0] != 0 || ref.Selection.RuleIndexes[1] != 2 {
		t.Fatalf("ruleIndexes 映射错误: %v", ref.Selection.RuleIndexes)
	}
	if len(ref.Selection.CharacterIDs) != 1 || ref.Selection.CharacterIDs[0] != "c1" {
		t.Fatalf("characterIds 映射错误: %v", ref.Selection.CharacterIDs)
	}
}

// 3) 只有 analysis_handle（PolicyChat）。
func TestWorldContextTransportHandleOnly(t *testing.T) {
	tok := repeatHandle(40)
	body := []byte(`{"message":"m","analysis_handle":"` + tok + `"}`)
	got, err := DecodeWorldContextTransport(body, PolicyChat)
	if err != nil {
		t.Fatalf("仅 handle 不应报错: %v", err)
	}
	if got.HasWorldContext() {
		t.Fatal("不应携带 Ref")
	}
	if !got.HasAnalysisHandle || got.AnalysisHandle != tok {
		t.Fatalf("handle 解析错误: %+v", got)
	}
}

// 4) world_context 与 analysis_handle 同时出现：PolicyChat 允许，不互斥、不报 invalid_request。
func TestWorldContextTransportBothAllowedForChat(t *testing.T) {
	tok := repeatHandle(48)
	body := []byte(`{"message":"m","world_context":{"worldId":"w1","expectedWorldRevision":"r","selection":{}},` +
		`"analysis_handle":"` + tok + `"}`)
	got, err := DecodeWorldContextTransport(body, PolicyChat)
	if err != nil {
		t.Fatalf("chat 同时携带二者不应报错: %v", err)
	}
	if !got.HasWorldContext() || !got.HasAnalysisHandle || got.AnalysisHandle != tok {
		t.Fatalf("二者都应被保留: %+v", got)
	}
}

// 5) analysis_handle="" 等同未携带；null 也等同未携带。
func TestWorldContextTransportEmptyHandle(t *testing.T) {
	for _, body := range [][]byte{
		[]byte(`{"analysis_handle":""}`),
		[]byte(`{"analysis_handle":null}`),
		[]byte(`{}`),
	} {
		got, err := DecodeWorldContextTransport(body, PolicyChat)
		if err != nil {
			t.Fatalf("body=%s 不应报错: %v", body, err)
		}
		if got.HasAnalysisHandle || got.AnalysisHandle != "" {
			t.Fatalf("body=%s 应视为未携带 handle: %+v", body, got)
		}
	}
}

// 6) 非字符串 handle 拒绝。
func TestWorldContextTransportNonStringHandle(t *testing.T) {
	for _, body := range [][]byte{
		[]byte(`{"analysis_handle":123}`),
		[]byte(`{"analysis_handle":true}`),
		[]byte(`{"analysis_handle":{}}`),
		[]byte(`{"analysis_handle":["x"]}`),
	} {
		_, err := DecodeWorldContextTransport(body, PolicyChat)
		wantInvalidRequest(t, err, "analysis_handle")
	}
}

// 7) 非法字符拒绝。
func TestWorldContextTransportIllegalHandleChars(t *testing.T) {
	base := []byte("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") // 32 个合法字符
	for _, bad := range []string{".", "+", "=", " ", "/", "中"} {
		raw := append(append([]byte{}, base[:31]...), bad[0])
		// 构造长度仍在区间但含非法字符的 token。
		token := string(append(raw, 'a')) // 32 长度，含一个非法字符
		body := []byte(`{"analysis_handle":"` + token + `"}`)
		_, err := DecodeWorldContextTransport(body, PolicyChat)
		wantInvalidRequest(t, err, "analysis_handle")
	}
}

// 8) 长度边界：31/129 拒绝，32/128 通过。
func TestWorldContextTransportHandleLengthBounds(t *testing.T) {
	for _, n := range []int{31, 129} {
		body := []byte(`{"analysis_handle":"` + repeatHandle(n) + `"}`)
		_, err := DecodeWorldContextTransport(body, PolicyChat)
		wantInvalidRequest(t, err, "analysis_handle")
	}
	for _, n := range []int{32, 128} {
		tok := repeatHandle(n)
		body := []byte(`{"analysis_handle":"` + tok + `"}`)
		got, err := DecodeWorldContextTransport(body, PolicyChat)
		if err != nil {
			t.Fatalf("长度 %d 应通过: %v", n, err)
		}
		if !got.HasAnalysisHandle || got.AnalysisHandle != tok {
			t.Fatalf("长度 %d 解析错误", n)
		}
	}
}

// 9) Selection 空数组稳定（非 nil），且缺省 includeTone=false。
func TestWorldContextTransportSelectionDefaults(t *testing.T) {
	for _, body := range [][]byte{
		[]byte(`{"world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{}}}`),
		[]byte(`{"world_context":{"worldId":"w","expectedWorldRevision":"r"}}`),
		[]byte(`{"world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{"ruleIndexes":[],"characterIds":[],"locationIds":[],"factionIds":[],"timelineEntryIds":[],"bindingIds":[]}}}`),
	} {
		got, err := DecodeWorldContextTransport(body, PolicyChat)
		if err != nil {
			t.Fatalf("body=%s 不应报错: %v", body, err)
		}
		sel := got.Ref.Selection
		if sel.IncludeTone {
			t.Fatalf("body=%s 缺省 includeTone 必须为 false", body)
		}
		if sel.RuleIndexes == nil || sel.CharacterIDs == nil || sel.LocationIDs == nil ||
			sel.FactionIDs == nil || sel.TimelineEntryIDs == nil || sel.BindingIDs == nil {
			t.Fatalf("body=%s selection 空数组必须非 nil 以保证 canonical 稳定: %+v", body, sel)
		}
	}
}

// world_context: null 等同未携带。
func TestWorldContextTransportNullWorldContext(t *testing.T) {
	got, err := DecodeWorldContextTransport([]byte(`{"message":"m","world_context":null}`), PolicyChat)
	if err != nil {
		t.Fatalf("world_context:null 不应报错: %v", err)
	}
	if got.HasWorldContext() {
		t.Fatal("null 不应解析出 Ref")
	}
}

// 10) 越权字段：无论出现在顶层还是 world_context 子树都必须逐个拒绝。
func TestWorldContextTransportForbiddenKeys(t *testing.T) {
	forbidden := []string{
		"consumer", "scope", "scopeKey", "run_scope", "runContextId", "run_context_id",
		"interactiveRunId", "capability", "snapshot", "modelView",
	}
	for _, key := range forbidden {
		// 顶层越权。
		topBody := []byte(`{"message":"m","` + key + `":"x"}`)
		if _, err := DecodeWorldContextTransport(topBody, PolicyChat); err == nil {
			t.Fatalf("顶层越权字段 %q 必须拒绝", key)
		} else {
			wantInvalidRequest(t, err, key)
		}
		// world_context 子树越权。
		subBody := []byte(`{"world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{},"` + key + `":"x"}}`)
		if _, err := DecodeWorldContextTransport(subBody, PolicyChat); err == nil {
			t.Fatalf("world_context 内越权字段 %q 必须拒绝", key)
		} else {
			wantInvalidRequest(t, err, key)
		}
	}
}

// 11) world_context 未知字段拒绝（白名单之外一律拒绝）。
func TestWorldContextTransportUnknownRefField(t *testing.T) {
	body := []byte(`{"world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{},"bogus":1}}`)
	_, err := DecodeWorldContextTransport(body, PolicyChat)
	wantInvalidRequest(t, err, "world_context")
}

// 12) selection 未知字段拒绝。
func TestWorldContextTransportUnknownSelectionField(t *testing.T) {
	body := []byte(`{"world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{"characterIds":[],"bogus":[]}}}`)
	_, err := DecodeWorldContextTransport(body, PolicyChat)
	if err == nil {
		t.Fatal("selection 未知字段必须拒绝")
	}
	// 领域层返回 selection_invalid 或 invalid_request 均可，但必须是 DomainError。
	if _, ok := err.(*worldcontext.DomainError); !ok {
		t.Fatalf("期望 DomainError，实际 %T", err)
	}
}

// world_context 与 selection 的冻结 wire schema 严格区分大小写；
// encoding/json 默认的大小写不敏感结构体匹配不得放宽该契约。
func TestWorldContextTransportRejectsNonCanonicalRefKeyCasing(t *testing.T) {
	cases := []string{
		`{"WorldID":"w","expectedWorldRevision":"r","selection":{}}`,
		`{"worldId":"w","ExpectedWorldRevision":"r","selection":{}}`,
		`{"worldId":"w","expectedWorldRevision":"r","Selection":{}}`,
	}
	for _, ref := range cases {
		body := []byte(`{"world_context":` + ref + `}`)
		_, err := DecodeWorldContextTransport(body, PolicyChat)
		wantInvalidRequest(t, err, "world_context")
	}
}

func TestWorldContextTransportRejectsNonCanonicalSelectionKeyCasing(t *testing.T) {
	cases := []string{
		`"IncludeTone":true`,
		`"RuleIndexes":[]`,
		`"CharacterIDs":[]`,
		`"LocationIDs":[]`,
		`"FactionIDs":[]`,
		`"TimelineEntryIDs":[]`,
		`"BindingIDs":[]`,
	}
	for _, field := range cases {
		body := []byte(`{"world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{` + field + `}}}`)
		_, err := DecodeWorldContextTransport(body, PolicyChat)
		wantInvalidRequest(t, err, "selection")
	}
}

// selection 错误类型（ruleIndexes 小数）由领域层拒绝。
func TestWorldContextTransportSelectionWrongType(t *testing.T) {
	body := []byte(`{"world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{"ruleIndexes":[1.5]}}}`)
	if _, err := DecodeWorldContextTransport(body, PolicyChat); err == nil {
		t.Fatal("ruleIndexes 小数必须拒绝")
	}
}

// 13) 尾随 JSON、多 JSON、空 body、null、错误类型。
func TestWorldContextTransportMalformed(t *testing.T) {
	// 空 body / 纯空白：合法，得到零结果（旧请求兼容）。
	for _, body := range [][]byte{nil, []byte(``), []byte("   \n\t")} {
		got, err := DecodeWorldContextTransport(body, PolicyChat)
		if err != nil {
			t.Fatalf("空 body 不应报错: %v", err)
		}
		if got.HasWorldContext() || got.HasAnalysisHandle {
			t.Fatalf("空 body 必须零结果: %+v", got)
		}
	}
	// 顶层 null：零结果。
	if got, err := DecodeWorldContextTransport([]byte(`null`), PolicyChat); err != nil || got.HasWorldContext() {
		t.Fatalf("顶层 null 应零结果无错: %+v err=%v", got, err)
	}
	// 尾随 / 多 JSON / 非对象类型：拒绝。
	bad := [][]byte{
		[]byte(`{"world_context":{}} {"x":1}`),
		[]byte(`{}{}`),
		[]byte(`[]`),
		[]byte(`"str"`),
		[]byte(`123`),
		[]byte(`true`),
	}
	for _, body := range bad {
		if _, err := DecodeWorldContextTransport(body, PolicyChat); err == nil {
			t.Fatalf("畸形 body 必须拒绝: %s", body)
		}
	}
	// world_context 非对象：拒绝。
	for _, body := range [][]byte{
		[]byte(`{"world_context":[]}`),
		[]byte(`{"world_context":"x"}`),
		[]byte(`{"world_context":1}`),
		[]byte(`{"world_context":true}`),
	} {
		_, err := DecodeWorldContextTransport(body, PolicyChat)
		wantInvalidRequest(t, err, "world_context")
	}
}

// 14) chat 与 context-analysis 的 policy 差异。
func TestWorldContextTransportPolicyDifference(t *testing.T) {
	tok := repeatHandle(40)

	// context-analysis：只带 world_context → 允许。
	refOnly := []byte(`{"world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{}}}`)
	got, err := DecodeWorldContextTransport(refOnly, PolicyContextAnalysis)
	if err != nil || !got.HasWorldContext() || got.HasAnalysisHandle {
		t.Fatalf("context-analysis 允许只带 Ref: %+v err=%v", got, err)
	}

	// context-analysis：带非空 handle → 拒绝（该请求只负责创建新 handle）。
	withHandle := []byte(`{"world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{}},"analysis_handle":"` + tok + `"}`)
	if _, err := DecodeWorldContextTransport(withHandle, PolicyContextAnalysis); err == nil {
		t.Fatal("context-analysis 不允许消费 analysis_handle")
	} else {
		wantInvalidRequest(t, err, "analysis_handle")
	}

	// context-analysis：handle 为空字符串/null → 等同未携带，允许。
	for _, body := range [][]byte{
		[]byte(`{"world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{}},"analysis_handle":""}`),
		[]byte(`{"world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{}},"analysis_handle":null}`),
	} {
		if _, err := DecodeWorldContextTransport(body, PolicyContextAnalysis); err != nil {
			t.Fatalf("context-analysis 空 handle 应视为未携带并放行: %v", err)
		}
	}

	// 同一 body 在 PolicyChat 下允许同时携带。
	if _, err := DecodeWorldContextTransport(withHandle, PolicyChat); err != nil {
		t.Fatalf("PolicyChat 应允许二者同现: %v", err)
	}
}

// 15) 映射后不把 worldcontext 运行字段塞进 agent.ChatRequest：控制字段被忽略，业务字段保留。
func TestWorldContextTransportChatRequestSeparation(t *testing.T) {
	tok := repeatHandle(40)
	body := []byte(`{"message":"keep","plan_mode":true,` +
		`"world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{"includeTone":true}},` +
		`"analysis_handle":"` + tok + `"}`)

	transport, err := DecodeWorldContextTransport(body, PolicyChat)
	if err != nil {
		t.Fatalf("控制字段解码失败: %v", err)
	}
	if !transport.HasWorldContext() || !transport.HasAnalysisHandle {
		t.Fatal("控制字段应被 transport 正常解析")
	}

	var req agent.ChatRequest
	if err := DecodeChatRequestWithoutWorldContext(body, &req); err != nil {
		t.Fatalf("ChatRequest 解码失败: %v", err)
	}
	if req.Message != "keep" || !req.PlanMode {
		t.Fatalf("业务字段应保留: %+v", req)
	}
	// agent.ChatRequest 结构上没有任何 world context 运行字段；这里再确认零值无隐藏映射。
	if req.WritingSkill != "" || req.TellerID != "" || req.ImagePresetID != "" {
		t.Fatalf("不应有额外字段被写入 ChatRequest: %+v", req)
	}

	// nil 目标必须报错而不是 panic。
	if err := DecodeChatRequestWithoutWorldContext(body, nil); err == nil {
		t.Fatal("nil ChatRequest 必须返回错误")
	}
}
