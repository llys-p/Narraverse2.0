package handlers

import (
	"testing"

	"denova/internal/worldcontext"
)

// Phase 3.2-A1b：decodeChatRequestBody 组合边界测试。
// 底层 DecodeWorldContextTransport 的 17 个用例已在 world_context_transport_test.go 覆盖
//（含共享的 repeatHandle 测试助手），这里只锁定“同一 body 单次解码 + ChatRequest 与
// World 控制字段分离 + 双 policy 差异”。

// 1) 旧 chat 请求：11 个合法 ChatRequest 字段全部兼容，且不携带任何 World 控制字段。
func TestDecodeChatBodyLegacyFields(t *testing.T) {
	body := []byte(`{
		"message":"hi",
		"references":["a.md"],
		"lore_references":["l.md"],
		"style_scenes":["全局"],
		"selections":[{"file_name":"c.md","start_line":1,"end_line":2,"content":"x"}],
		"ide_context":{"current_file":"c.md","open_files":["c.md"]},
		"review_feedback":[],
		"plan_mode":true,
		"writing_skill":"polish",
		"image_preset_id":"default",
		"teller_id":"classic"
	}`)
	req, rt, err := decodeChatRequestBody(body, PolicyChat)
	if err != nil {
		t.Fatalf("旧请求应兼容: %v", err)
	}
	if req.Message != "hi" || req.PlanMode != true || req.WritingSkill != "polish" ||
		req.ImagePresetID != "default" || req.TellerID != "classic" {
		t.Fatalf("标量字段未保留: %+v", req)
	}
	if len(req.References) != 1 || len(req.LoreReferences) != 1 || len(req.StyleScenes) != 1 ||
		len(req.Selections) != 1 {
		t.Fatalf("数组字段未保留: refs=%v lore=%v scenes=%v sel=%v",
			req.References, req.LoreReferences, req.StyleScenes, req.Selections)
	}
	if rt.HasWorldContext() || rt.HasAnalysisHandle {
		t.Fatalf("旧请求不应携带 World 控制字段: %+v", rt)
	}
}

// 2/3/4) Ref only / handle only / Ref+handle（PolicyChat 允许同时出现）。
func TestDecodeChatBodyWorldControlCombinations(t *testing.T) {
	ref := `"world_context":{"worldId":"w1","expectedWorldRevision":"r1","selection":{"includeTone":true,"characterIds":["c1"]}}`
	h32 := repeatHandle(32)

	if _, rt, err := decodeChatRequestBody([]byte(`{"message":"m",`+ref+`}`), PolicyChat); err != nil {
		t.Fatalf("Ref only 不应报错: %v", err)
	} else if !rt.HasWorldContext() || rt.Ref.WorldID != "w1" || !rt.Ref.Selection.IncludeTone {
		t.Fatalf("Ref 未正确分离: %+v", rt)
	}

	bodyHandle := []byte(`{"message":"m","analysis_handle":"` + h32 + `"}`)
	if _, rt, err := decodeChatRequestBody(bodyHandle, PolicyChat); err != nil {
		t.Fatalf("handle only 不应报错: %v", err)
	} else if !rt.HasAnalysisHandle || rt.AnalysisHandle != h32 {
		t.Fatalf("handle 未正确分离: %+v", rt)
	}

	both := []byte(`{"message":"m",` + ref + `,"analysis_handle":"` + h32 + `"}`)
	if _, rt, err := decodeChatRequestBody(both, PolicyChat); err != nil {
		t.Fatalf("Ref+handle 在 PolicyChat 下允许同时出现: %v", err)
	} else if !rt.HasWorldContext() || !rt.HasAnalysisHandle {
		t.Fatalf("Ref+handle 应同时保留: %+v", rt)
	}
}

// 5) context-analysis policy：允许 Ref，但非空 handle 必须拒绝。
func TestDecodeChatBodyContextAnalysisPolicy(t *testing.T) {
	ref := []byte(`{"message":"m","world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{}}}`)
	if _, _, err := decodeChatRequestBody(ref, PolicyContextAnalysis); err != nil {
		t.Fatalf("context-analysis 允许 Ref: %v", err)
	}
	withHandle := []byte(`{"message":"m","analysis_handle":"` + repeatHandle(32) + `"}`)
	if _, _, err := decodeChatRequestBody(withHandle, PolicyContextAnalysis); err == nil {
		t.Fatal("context-analysis 携带非空 analysis_handle 必须拒绝")
	}
	// 空串等同未携带，不拒绝。
	emptyHandle := []byte(`{"message":"m","analysis_handle":""}`)
	if _, rt, err := decodeChatRequestBody(emptyHandle, PolicyContextAnalysis); err != nil || rt.HasAnalysisHandle {
		t.Fatalf("空 handle 应等同未携带: err=%v rt=%+v", err, rt)
	}
}

// 6) 尾随 JSON / 多 JSON / 非对象拒绝；空 body 与 null 不报错（业务校验在后续）。
func TestDecodeChatBodyShape(t *testing.T) {
	if _, _, err := decodeChatRequestBody([]byte(`{"message":"m"}garbage`), PolicyChat); err == nil {
		t.Fatal("尾随 JSON 必须拒绝")
	}
	if _, _, err := decodeChatRequestBody([]byte(`{"message":"m"}{"message":"n"}`), PolicyChat); err == nil {
		t.Fatal("多个 JSON 值必须拒绝")
	}
	if _, _, err := decodeChatRequestBody([]byte(`["not","object"]`), PolicyChat); err == nil {
		t.Fatal("数组顶层必须拒绝")
	}
	// 空 body 与旧 BindJSON 行为一致：在解码层报错（handler 回 invalidBody）。
	if _, _, err := decodeChatRequestBody(nil, PolicyChat); err == nil {
		t.Fatal("空 body 必须报错（沿用旧 invalidBody 行为）")
	}
	// null 得到空对象，等价于未携带任何字段，不在解码层报错。
	if _, _, err := decodeChatRequestBody([]byte(`null`), PolicyChat); err != nil {
		t.Fatalf("null 不应在解码层报错: %v", err)
	}
}

// 7) 越权字段在任意位置都必须拒绝。
func TestDecodeChatBodyForbiddenKeys(t *testing.T) {
	for _, key := range []string{
		"consumer", "scope", "scopeKey", "run_scope", "runContextId",
		"run_context_id", "interactiveRunId", "capability", "snapshot", "modelView",
	} {
		body := []byte(`{"message":"m","` + key + `":"x"}`)
		if _, _, err := decodeChatRequestBody(body, PolicyChat); err == nil {
			t.Fatalf("越权顶层字段 %q 必须拒绝", key)
		}
		inner := []byte(`{"message":"m","world_context":{"worldId":"w","selection":{},"` + key + `":"x"}}`)
		if _, _, err := decodeChatRequestBody(inner, PolicyChat); err == nil {
			t.Fatalf("越权 world_context 字段 %q 必须拒绝", key)
		}
	}
}

// 8) world_context / selection 未知字段拒绝。
func TestDecodeChatBodyUnknownNestedKeys(t *testing.T) {
	if _, _, err := decodeChatRequestBody([]byte(`{"message":"m","world_context":{"worldId":"w","bogus":1}}`), PolicyChat); err == nil {
		t.Fatal("world_context 未知字段必须拒绝")
	}
	if _, _, err := decodeChatRequestBody([]byte(`{"message":"m","world_context":{"worldId":"w","selection":{"bogus":1}}}`), PolicyChat); err == nil {
		t.Fatal("selection 未知字段必须拒绝")
	}
}

// 9) 缺省 includeTone=false，空数组稳定。
func TestDecodeChatBodySelectionDefaults(t *testing.T) {
	body := []byte(`{"message":"m","world_context":{"worldId":"w","selection":{"characterIds":[],"ruleIndexes":[]}}}`)
	_, rt, err := decodeChatRequestBody(body, PolicyChat)
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	sel := rt.Ref.Selection
	if sel.IncludeTone {
		t.Fatal("缺省 includeTone 必须为 false")
	}
	if sel.CharacterIDs == nil || sel.RuleIndexes == nil {
		t.Fatal("空数组必须稳定为非 nil")
	}
}

// 10) handle 长度边界：31/129 拒绝，32/128 通过。
func TestDecodeChatBodyHandleBounds(t *testing.T) {
	for _, n := range []int{31, 129} {
		body := []byte(`{"message":"m","analysis_handle":"` + repeatHandle(n) + `"}`)
		if _, _, err := decodeChatRequestBody(body, PolicyChat); err == nil {
			t.Fatalf("handle 长度 %d 必须拒绝", n)
		}
	}
	for _, n := range []int{32, 128} {
		body := []byte(`{"message":"m","analysis_handle":"` + repeatHandle(n) + `"}`)
		if _, rt, err := decodeChatRequestBody(body, PolicyChat); err != nil || !rt.HasAnalysisHandle {
			t.Fatalf("handle 长度 %d 必须通过: err=%v", n, err)
		}
	}
}

// 11) World 控制字段不进入 agent.ChatRequest（类型分离锁定）。
func TestDecodeChatBodyControlStaysOutOfChatRequest(t *testing.T) {
	body := []byte(`{"message":"m","world_context":{"worldId":"w","selection":{}},"analysis_handle":"` + repeatHandle(40) + `"}`)
	req, rt, err := decodeChatRequestBody(body, PolicyChat)
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if req.Message != "m" {
		t.Fatalf("业务消息丢失: %+v", req)
	}
	if rt.Ref == nil || rt.Ref.WorldID != "w" || !rt.HasAnalysisHandle {
		t.Fatalf("控制字段必须只存在于 RuntimeWorldContext: %+v", rt)
	}
	// ChatRequest 类型本身不允许携带 Ref/handle：编译期保证，这里再确认零泄漏字段。
	var _ *worldcontext.Ref = rt.Ref
}
