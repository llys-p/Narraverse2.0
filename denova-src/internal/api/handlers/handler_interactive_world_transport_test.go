package handlers

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"denova/internal/worldcontext"
)

// Phase 3.2-B1：/api/interactive/chat 与 context-analysis 的 World Context 传输契约测试。
//
// 底层 DecodeWorldContextTransport 的完整规范（camelCase、尾随 JSON、越权字段、handle 长度）
// 已在 world_context_transport_test.go 覆盖。这里锁定游戏侧特有的两个差异：
//   1) 游戏聊天允许 world_context + analysis_handle（与写作 PolicyChat 一致）；
//   2) 游戏 context-analysis 只允许 world_context，携带 analysis_handle 必须拒绝。
//
// 同时验证：同一 body 单次读取后，业务字段（story_id/branch/message/style_scenes/...）
// 与 World 控制字段正确分离，不互相污染。

func decodeInteractiveChatBodyForTest(t *testing.T, body []byte, policy WorldContextEndpointPolicy) (*interactiveBodyFixture, RuntimeWorldContext) {
	t.Helper()
	rt, err := DecodeWorldContextTransport(body, policy)
	if err != nil {
		t.Fatalf("DecodeWorldContextTransport 失败: %v", err)
	}
	var fb interactiveBodyFixture
	if err := json.Unmarshal(bytes.TrimSpace(body), &fb); err != nil {
		t.Fatalf("业务字段 Unmarshal 失败: %v", err)
	}
	return &fb, rt
}

type interactiveBodyFixture struct {
	Mode               string   `json:"mode"`
	StoryID            string   `json:"story_id"`
	Branch             string   `json:"branch"`
	Message            string   `json:"message"`
	StyleScenes        []string `json:"style_scenes"`
	RegenerateFromTurn string   `json:"regenerate_from_turn_id"`
}

// 1) 旧游戏请求：全部 6 个合法业务字段兼容，且不携带 World 控制字段。
func TestInteractiveChatLegacyFieldsCompatible(t *testing.T) {
	body := []byte(`{
		"mode":"story",
		"story_id":"s1",
		"branch":"b1",
		"message":"进入黑森林",
		"style_scenes":["全局","战斗"],
		"regenerate_from_turn_id":"t_old"
	}`)
	fb, rt := decodeInteractiveChatBodyForTest(t, body, PolicyChat)
	if fb.Mode != "story" || fb.StoryID != "s1" || fb.Branch != "b1" ||
		fb.Message != "进入黑森林" || len(fb.StyleScenes) != 2 ||
		fb.RegenerateFromTurn != "t_old" {
		t.Fatalf("业务字段未保留: %+v", fb)
	}
	if rt.HasWorldContext() || rt.HasAnalysisHandle {
		t.Fatalf("旧请求不应携带 World 控制字段: %+v", rt)
	}
}

// 2) 游戏聊天允许 world_context + analysis_handle 同时出现（PolicyChat）。
func TestInteractiveChatAllowsRefAndHandle(t *testing.T) {
	ref := `"world_context":{"worldId":"w1","expectedWorldRevision":"r1","selection":{"includeTone":true,"characterIds":["c1"]}}`
	h32 := repeatHandle(32)

	// Ref only
	_, rt := decodeInteractiveChatBodyForTest(t, []byte(`{"story_id":"s1","message":"m",`+ref+`}`), PolicyChat)
	if !rt.HasWorldContext() || rt.Ref.WorldID != "w1" || !rt.Ref.Selection.IncludeTone {
		t.Fatalf("Ref 未正确解码: %+v", rt)
	}

	// handle only
	bodyHandle := []byte(`{"story_id":"s1","message":"m","analysis_handle":"` + h32 + `"}`)
	_, rt = decodeInteractiveChatBodyForTest(t, bodyHandle, PolicyChat)
	if !rt.HasAnalysisHandle || rt.AnalysisHandle != h32 {
		t.Fatalf("handle 未正确解码: %+v", rt)
	}

	// both
	both := []byte(`{"story_id":"s1","message":"m",` + ref + `,"analysis_handle":"` + h32 + `"}`)
	fb, rt := decodeInteractiveChatBodyForTest(t, both, PolicyChat)
	if !rt.HasWorldContext() || !rt.HasAnalysisHandle {
		t.Fatalf("Ref+handle 应同时保留: %+v", rt)
	}
	if fb.Message != "m" || fb.StoryID != "s1" {
		t.Fatalf("业务字段被 World 控制字段污染: %+v", fb)
	}
}

// 3) 游戏 context-analysis：允许 world_context，携带 analysis_handle 必须拒绝。
func TestInteractiveContextAnalysisRejectsHandle(t *testing.T) {
	refBody := []byte(`{"story_id":"s1","message":"m","world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{}}}`)
	if _, err := DecodeWorldContextTransport(refBody, PolicyContextAnalysis); err != nil {
		t.Fatalf("context-analysis 允许 world_context: %v", err)
	}
	withHandle := []byte(`{"story_id":"s1","message":"m","analysis_handle":"` + repeatHandle(32) + `"}`)
	if _, err := DecodeWorldContextTransport(withHandle, PolicyContextAnalysis); err == nil {
		t.Fatal("context-analysis 携带 analysis_handle 必须拒绝")
	}
	// 空串等同未携带
	emptyHandle := []byte(`{"story_id":"s1","message":"m","analysis_handle":""}`)
	rt, err := DecodeWorldContextTransport(emptyHandle, PolicyContextAnalysis)
	if err != nil || rt.HasAnalysisHandle {
		t.Fatalf("空 handle 应等同未携带: err=%v rt=%+v", err, rt)
	}
}

// 4) 越权字段在任意 policy 下都必须拒绝（consumer 固定为 game，客户端不得提交）。
func TestInteractiveChatRejectsForbiddenFields(t *testing.T) {
	for _, key := range []string{
		"consumer", "scope", "scopeKey", "runContextId",
		"capability", "taskId", "runContextID",
	} {
		body := []byte(`{"story_id":"s1","message":"m","` + key + `":"x"}`)
		if _, err := DecodeWorldContextTransport(body, PolicyChat); err == nil {
			t.Fatalf("越权字段 %q 在聊天中必须拒绝", key)
		}
		if _, err := DecodeWorldContextTransport(body, PolicyContextAnalysis); err == nil {
			t.Fatalf("越权字段 %q 在 context-analysis 中必须拒绝", key)
		}
	}
}

//  5. world_context 子树内部严格 camelCase：PascalCase 字段名必须拒绝。
//     顶层 worldContext / analysisHandle（驼峰）不是 wire 协议字段，按业务字段放行。
func TestInteractiveChatRejectsCaseVariants(t *testing.T) {
	for _, bad := range []string{
		`"world_context":{"WorldId":"w","expectedWorldRevision":"r","selection":{}}`,
		`"world_context":{"worldId":"w","expectedWorldRevision":"r","Selection":{}}`,
	} {
		body := []byte(`{"story_id":"s1","message":"m",` + bad + `}`)
		if _, err := DecodeWorldContextTransport(body, PolicyChat); err == nil {
			t.Fatalf("world_context 子树大小写变体 %q 必须拒绝", bad)
		}
	}
	// 顶层驼峰 key 按业务字段放行（不报错，只是不被识别为 wire 字段）
	for _, ok := range []string{
		`"worldContext":{"worldId":"w"}`,
		`"analysisHandle":"` + repeatHandle(32) + `"`,
	} {
		body := []byte(`{"story_id":"s1","message":"m",` + ok + `}`)
		if _, err := DecodeWorldContextTransport(body, PolicyChat); err != nil {
			t.Fatalf("顶层驼峰 key %q 应按业务字段放行: %v", ok, err)
		}
	}
}

// 6) 尾随 JSON / 非对象拒绝。
func TestInteractiveChatShapeRejection(t *testing.T) {
	if _, err := DecodeWorldContextTransport([]byte(`{"story_id":"s1","message":"m"}garbage`), PolicyChat); err == nil {
		t.Fatal("尾随 JSON 必须拒绝")
	}
	if _, err := DecodeWorldContextTransport([]byte(`["array"]`), PolicyChat); err == nil {
		t.Fatal("数组顶层必须拒绝")
	}
}

// 7) World 控制字段不进入业务字段（类型分离）。
func TestInteractiveChatControlStaysSeparate(t *testing.T) {
	body := []byte(`{"story_id":"s1","message":"m","world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{}},"analysis_handle":"` + repeatHandle(40) + `"}`)
	fb, rt := decodeInteractiveChatBodyForTest(t, body, PolicyChat)
	if fb.StoryID != "s1" || fb.Message != "m" {
		t.Fatalf("业务字段丢失: %+v", fb)
	}
	var _ *worldcontext.Ref = rt.Ref
	if rt.Ref == nil || rt.Ref.WorldID != "w" || !rt.HasAnalysisHandle {
		t.Fatalf("控制字段必须只存在于 RuntimeWorldContext: %+v", rt)
	}
	if strings.Contains(string(body), "consumer") {
		t.Fatal("测试夹具不应包含 consumer")
	}
}
