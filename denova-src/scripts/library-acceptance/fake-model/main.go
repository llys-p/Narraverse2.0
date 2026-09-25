// 作品设定库验收用的确定性假模型端点（L3/B5 脚手架；不消耗付费额度）。
//
// 模式（FAKE_MODEL_MODE）：
//   - game（默认）：互动故事回合协议脚本——首轮调用 read_library_item（itemId 由
//     FAKE_READ_ITEM 指定，默认沈孤鸿）→ 工具结果回填后叙述 → 协议反馈后
//     submit_interactive_turn；识别压缩请求返回摘要；call>12 兜底 finalize 防跑飞。
//   - writing：写作链只需纯文本产出（不做任何工具调用）；同样识别压缩请求。
//
// 每个请求的 messages 追加写入 FAKE_MODEL_LOG（JSONL），用于证明模型侧实际收到的
// 上下文（如库正文/冻结抬头）；该文件属于验收证据，不要提交进 Git。
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
)

type toolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCallID string     `json:"tool_call_id"`
	ToolCalls  []toolCall `json:"tool_calls"`
}

type chatRequest struct {
	Stream     bool      `json:"stream"`
	Messages   []message `json:"messages"`
	ToolChoice any       `json:"tool_choice"`
}

var (
	mu      sync.Mutex
	logFile *os.File
	calls   int
	mode    = "game"
)

const submitArgs = `{"state_changes":[{"op":"replace","actor_id":"story","field_id":"当前事件","value":"主角在门后听到锁链拖地的声音。"},{"op":"replace","actor_id":"story","field_id":"当前详细地点","value":"石门之内"}],"choices":["进入房间","观察门后","检查锁链","询问同伴","退后戒备"]}`

func writeJSONLine(value any) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return
	}
	mu.Lock()
	defer mu.Unlock()
	if logFile != nil {
		_, _ = logFile.Write(append(encoded, '\n'))
		_ = logFile.Sync()
	}
}

func handle(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	var req chatRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	mu.Lock()
	calls++
	callIndex := calls
	mu.Unlock()

	toolChoice := ""
	if tc, ok := req.ToolChoice.(string); ok {
		toolChoice = tc
	}
	callNames := map[string]string{}
	hasFeedback, hasNarrative, readResultSeen, submitSeen, isCompaction := false, false, false, false, false
	for _, m := range req.Messages {
		if strings.Contains(m.Content, "互动小说上下文压缩器") {
			isCompaction = true
		}
		if strings.Contains(m.Content, "[Interactive turn protocol feedback") {
			hasFeedback = true
		}
		if m.Role == "assistant" && strings.TrimSpace(m.Content) != "" {
			hasNarrative = true
		}
		for _, tc := range m.ToolCalls {
			callNames[tc.ID] = tc.Function.Name
		}
		if m.Role == "tool" {
			switch callNames[m.ToolCallID] {
			case "read_library_item":
				readResultSeen = true
			case "submit_interactive_turn":
				submitSeen = true
			}
		}
	}
	script := "text"
	switch {
	case isCompaction:
		script = "compaction_summary"
	case mode == "game" && (toolChoice == "none" || callIndex > 12):
		script = "finalize"
	case mode == "game" && (submitSeen || (hasFeedback && hasNarrative)):
		script = "submit"
	case mode == "game" && readResultSeen:
		script = "narrative"
	case mode == "game":
		script = "read_library_item"
	}
	writeJSONLine(map[string]any{"call": callIndex, "script": script, "tool_choice": toolChoice, "messages": req.Messages})

	readItem := os.Getenv("FAKE_READ_ITEM")
	if readItem == "" {
		readItem = "沈孤鸿"
	}

	w.Header().Set("Content-Type", "text/event-stream")
	flusher, _ := w.(http.Flusher)
	emit := func(delta map[string]any, finish any) {
		chunk := map[string]any{
			"id": "chatcmpl-fake", "object": "chat.completion.chunk", "created": 1, "model": "fake-model",
			"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}},
		}
		data, _ := json.Marshal(chunk)
		fmt.Fprintf(w, "data: %s\n\n", data)
		if flusher != nil {
			flusher.Flush()
		}
	}
	switch script {
	case "compaction_summary":
		emit(map[string]any{"role": "assistant", "content": "此前：主角在雾巷尽头发现上锁的木门，听完门后的锁链声。本轮：准备推门进入。"}, nil)
		emit(map[string]any{}, "stop")
	case "finalize":
		emit(map[string]any{"role": "assistant", "content": "石门缓缓开启。"}, nil)
		emit(map[string]any{}, "stop")
	case "submit":
		emit(map[string]any{"role": "assistant", "content": "", "tool_calls": []any{map[string]any{
			"index": 0, "id": "call-submit", "type": "function",
			"function": map[string]any{"name": "submit_interactive_turn", "arguments": submitArgs},
		}}}, nil)
		emit(map[string]any{}, "tool_calls")
	case "narrative":
		emit(map[string]any{"role": "assistant", "content": "门后传来锁链拖地的声音。"}, nil)
		emit(map[string]any{}, "stop")
	case "read_library_item":
		emit(map[string]any{"role": "assistant", "content": "", "tool_calls": []any{map[string]any{
			"index": 0, "id": "call-read-library", "type": "function",
			"function": map[string]any{"name": "read_library_item", "arguments": `{"itemId":"` + readItem + `"}`},
		}}}, nil)
		emit(map[string]any{}, "tool_calls")
	default: // writing：纯文本
		emit(map[string]any{"role": "assistant", "content": "（假模型）本轮按绑定的设定库背景推进了一段正文，未调用任何工具。"}, nil)
		emit(map[string]any{}, "stop")
	}
	fmt.Fprint(w, "data: [DONE]\n\n")
}

func main() {
	if v := strings.TrimSpace(os.Getenv("FAKE_MODEL_MODE")); v != "" {
		mode = v
	}
	port := os.Getenv("FAKE_MODEL_PORT")
	if port == "" {
		port = "18086"
	}
	if logPath := os.Getenv("FAKE_MODEL_LOG"); logPath != "" {
		f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			log.Fatalf("open log: %v", err)
		}
		logFile = f
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/chat/completions", handle)
	mux.HandleFunc("/v1/chat/completions", handle)
	log.Printf("fake model listening on 127.0.0.1:%s mode=%s", port, mode)
	log.Fatal(http.ListenAndServe("127.0.0.1:"+port, mux))
}
