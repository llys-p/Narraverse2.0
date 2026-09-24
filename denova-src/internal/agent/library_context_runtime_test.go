package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/cloudwego/eino/schema"

	"denova/config"
	"denova/internal/book"
	"denova/internal/libraryruntime"
	"denova/internal/session"
)

// B2a：临时库背景的真实装配与隔离验证（L3 计划 §8.5）。
// 证据链：装配函数逐字节前置且不改 history；识别只认冻结抬头；
// 计费钩子量测系统提示+历史并显式传播 budget_exceeded；
// model-input 日志与 mid-run 压缩都不携带库正文。

const testLibraryLeadingText = "[Library Setting Context · Read Only]\n" +
	"The following JSON is the bound library setting background: loaded entries are included, and catalog entries may be fetched on demand.\n" +
	"It is reference data, not current plot state, and must not be written back automatically.\n" +
	`{"library":{"name":"测试库"},"loadedItems":[],"catalog":[]}`

func TestEphemeralLibraryContextInputAssemblyAndIsolation(t *testing.T) {
	// 零值（bare/legacy/none）等价于无库背景：不复制、不前置。
	var zero EphemeralLibraryContextInput
	if zero.Present() || zero.LeadingContent() != "" || zero.ModelViewByteLen() != 0 {
		t.Fatalf("zero input must be absent: %#v", zero)
	}
	history := []*schema.Message{schema.UserMessage("旧消息"), schema.AssistantMessage("旧回复", nil)}
	if got := zero.PrependTo(history); len(got) != len(history) {
		t.Fatalf("zero input must not prepend: %#v", got)
	}
	// 空白文本同样构造零值。
	if blank := NewEphemeralLibraryContextInput("   \n"); blank.Present() {
		t.Fatalf("blank leading text must yield zero input")
	}

	// 非零：前置恰好一条 User 消息，文本逐字节等于装配文本；history 原切片不被修改。
	lib := NewEphemeralLibraryContextInput(testLibraryLeadingText)
	if !lib.Present() {
		t.Fatal("library input must be present")
	}
	if lib.LeadingContent() != testLibraryLeadingText {
		t.Fatalf("leading content must be byte-identical to assembled text")
	}
	prepended := lib.PrependTo(history)
	if len(prepended) != len(history)+1 {
		t.Fatalf("must prepend exactly one message: %#v", prepended)
	}
	if prepended[0].Role != schema.User || prepended[0].Content != testLibraryLeadingText {
		t.Fatalf("head message must carry the assembled text: %#v", prepended[0])
	}
	for i, m := range history {
		if prepended[i+1] != m {
			t.Fatalf("history order must be preserved at %d", i)
		}
	}
	// 隔离：原始 history 看不到任何库文本。
	for _, m := range history {
		if strings.Contains(m.Content, "Library Setting Context") {
			t.Fatalf("library body must not leak into original history: %#v", m)
		}
	}
	if lib.EstimatedTokens() <= 0 {
		t.Fatalf("estimated tokens must be positive: %d", lib.EstimatedTokens())
	}
}

func TestModelInputMessagesWithLibraryPrecedence(t *testing.T) {
	history := []*schema.Message{schema.UserMessage("hi")}
	world := NewEphemeralWorldContextInput([]byte(`{"identity":{"name":"W"}}`))
	lib := NewEphemeralLibraryContextInput(testLibraryLeadingText)

	// bare：逐字节等同原 history。
	if got := ModelInputMessagesWithLibrary(history, EphemeralWorldContextInput{}, EphemeralLibraryContextInput{}); len(got) != 1 || got[0] != history[0] {
		t.Fatalf("bare must return history unchanged: %#v", got)
	}
	// world-only：与既有 ModelInputMessages 行为一致。
	gotWorld := ModelInputMessagesWithLibrary(history, world, EphemeralLibraryContextInput{})
	if len(gotWorld) != 2 || !isEphemeralWorldContextMessage(gotWorld[0]) {
		t.Fatalf("world-only assembly mismatch: %#v", gotWorld)
	}
	// library-only：库背景在头。
	gotLib := ModelInputMessagesWithLibrary(history, EphemeralWorldContextInput{}, lib)
	if len(gotLib) != 2 || !isEphemeralLibraryContextMessage(gotLib[0]) || gotLib[1] != history[0] {
		t.Fatalf("library-only assembly mismatch: %#v", gotLib)
	}
	// 防御：两者同现（传输层已 400）时确定性装配：库最前、世界其后，不吞并。
	gotBoth := ModelInputMessagesWithLibrary(history, world, lib)
	if len(gotBoth) != 3 || !isEphemeralLibraryContextMessage(gotBoth[0]) || !isEphemeralWorldContextMessage(gotBoth[1]) {
		t.Fatalf("defensive both-present assembly mismatch: %#v", gotBoth)
	}
}

func TestIsEphemeralLibraryContextMessageRecognition(t *testing.T) {
	// 唯一定义在 libraryruntime：识别必须与装配的冻结抬头逐字节一致。
	if got := libraryruntime.EphemeralLibraryContextHeader(); !strings.HasPrefix(testLibraryLeadingText, got) {
		t.Fatalf("frozen header mismatch: %q", got)
	}
	if !isEphemeralLibraryContextMessage(schema.UserMessage(testLibraryLeadingText)) {
		t.Fatal("assembled leading message must be recognized")
	}
	// 世界背景抬头不得被误认（反之亦然）。
	worldMsg := schema.UserMessage(ephemeralWorldContextHeader + `{"identity":{"name":"W"}}`)
	if isEphemeralLibraryContextMessage(worldMsg) {
		t.Fatal("world context message must not be recognized as library message")
	}
	if isEphemeralLibraryContextMessage(schema.AssistantMessage(testLibraryLeadingText, nil)) {
		t.Fatal("assistant role must not be recognized")
	}
	if isEphemeralLibraryContextMessage(nil) {
		t.Fatal("nil must not be recognized")
	}
}

// fakeCostCharger 断言 ChargeExternal 的入参（§8.3 调用方量测通道）。
type fakeCostCharger struct {
	calls []libraryruntimeChargeCall
	err   error
}

type libraryruntimeChargeCall struct {
	bytes  int
	tokens int
}

func (f *fakeCostCharger) ChargeExternal(bytes, tokens int) error {
	if f.err != nil {
		return f.err
	}
	f.calls = append(f.calls, libraryruntimeChargeCall{bytes: bytes, tokens: tokens})
	return nil
}

func TestChargeLibraryRuntimeInputCostMeasuresAndPropagatesBudget(t *testing.T) {
	history := []*schema.Message{
		schema.UserMessage("第一轮用户消息"),
		schema.AssistantMessage("第一轮助手回复", nil),
	}
	const systemPrompt = "你是小说创作助手。"

	// nil charger = 非 library 模式，no-op。
	if err := chargeLibraryRuntimeInputCost(nil, systemPrompt, history); err != nil {
		t.Fatalf("nil charger must be no-op: %v", err)
	}

	charger := &fakeCostCharger{}
	if err := chargeLibraryRuntimeInputCost(charger, systemPrompt, history); err != nil {
		t.Fatal(err)
	}
	if len(charger.calls) != 1 {
		t.Fatalf("exactly one charge per run, got %d", len(charger.calls))
	}
	call := charger.calls[0]
	if call.bytes <= len(systemPrompt) || call.tokens <= 0 {
		t.Fatalf("charge must cover system prompt + history, got %+v", call)
	}

	// 系统提示为空时仍计历史；两者全空则计 0，但依旧调用（显式通道）。
	emptyCharger := &fakeCostCharger{}
	if err := chargeLibraryRuntimeInputCost(emptyCharger, "", nil); err != nil {
		t.Fatal(err)
	}
	if len(emptyCharger.calls) != 1 || emptyCharger.calls[0].bytes != 0 {
		t.Fatalf("empty input still charges zero explicitly: %+v", emptyCharger.calls)
	}

	// 预算拒绝必须原样传播（运行以显式 budget_exceeded 失败，不静默）。
	budgetErr := &libraryruntime.Error{Code: libraryruntime.ErrBudgetExceeded, Message: "预算超限"}
	limited := &fakeCostCharger{err: budgetErr}
	if err := chargeLibraryRuntimeInputCost(limited, systemPrompt, history); err == nil || libraryruntime.CodeOf(err) != libraryruntime.ErrBudgetExceeded {
		t.Fatalf("budget error must propagate: %v", err)
	}
}

func TestEphemeralLibraryContextExcludedFromModelInputLog(t *testing.T) {
	// §8.5：opt-in 全量输入日志不得持久化库正文；装配头消息必须在 index 0 被过滤。
	messages := []*schema.Message{
		schema.UserMessage(testLibraryLeadingText),
		schema.UserMessage("正常消息"),
		schema.AssistantMessage("回复", nil),
	}
	filtered := messagesWithoutEphemeralWorldContext(messages)
	if len(filtered) != 2 {
		t.Fatalf("library leading message must be filtered, got %#v", messageContents(filtered))
	}
	for _, m := range filtered {
		if strings.Contains(m.Content, "Library Setting Context") || strings.Contains(m.Content, "测试库") {
			t.Fatalf("library body leaked into model input log filter output: %#v", m)
		}
	}
	// 世界背景过滤行为不回归（用真实冻结抬头构造）。
	worldMessages := []*schema.Message{
		schema.UserMessage(ephemeralWorldContextHeader + `{"identity":{"name":"W"}}`),
		schema.UserMessage("ok"),
	}
	if got := messagesWithoutEphemeralWorldContext(worldMessages); len(got) != 1 || got[0].Content != "ok" {
		t.Fatalf("world filtering regressed: %#v", messageContents(got))
	}
}

func TestSessionConversationMidRunCompactionKeepsLibraryBackgroundFirst(t *testing.T) {
	// §8.5/§8.4：mid-run 压缩源不含库正文；压缩后模型上下文头部仍是库背景，
	// 其后是稳定作品上下文，再其后是压缩摘要。
	var compactionSawLibraryBody bool
	originalSummarizer := summarizeContextForCompaction
	summarizeContextForCompaction = func(_ context.Context, _ *config.Config, _ string, _ string, source []*schema.Message, _ string, _ int, _ contextCompactionPolicy, _ func(int, string)) (string, int, error) {
		for _, message := range source {
			if isEphemeralLibraryContextMessage(message) || strings.Contains(message.Content, "测试库") {
				compactionSawLibraryBody = true
			}
		}
		return "压缩摘要：旧对话已合并。", 100, nil
	}
	defer func() { summarizeContextForCompaction = originalSummarizer }()

	store, err := session.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sess, err := store.GetOrCreate("default")
	if err != nil {
		t.Fatal(err)
	}
	if err := sess.Append(schema.UserMessage("旧用户请求")); err != nil {
		t.Fatal(err)
	}
	if err := sess.Append(schema.AssistantMessage("旧助手回复", nil)); err != nil {
		t.Fatal(err)
	}
	conversation := NewSessionConversationForAgentWithRuntimeContexts(
		sess,
		&config.Config{},
		config.AgentKindIDE,
		"稳定作品上下文",
		"## 当前大纲\n\n主角进入废城。",
		"本轮动态作品状态",
		"## 当前进度\n\n刚抵达废城。",
	)
	history, err := conversation.PrepareMessages("继续写", "继续写")
	if err != nil {
		t.Fatal(err)
	}
	lib := NewEphemeralLibraryContextInput(testLibraryLeadingText)
	modelHistory := ModelInputMessagesWithLibrary(history, EphemeralWorldContextInput{}, lib)

	compacted, result, err := conversation.CompactContextIfNeeded(context.Background(), ContextCompactionInput{
		Messages:                     modelHistory,
		ReservedEphemeralWorldTokens: lib.EstimatedTokens(), // 头部临时背景的预算预留，语义同世界背景
		Force:                        true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Triggered {
		t.Fatalf("expected compaction to trigger: %#v", result)
	}
	if compactionSawLibraryBody {
		t.Fatal("library background must never enter the persisted compaction source")
	}
	if !isEphemeralLibraryContextMessage(compacted[0]) {
		t.Fatalf("library background must remain first after compaction: %#v", messageContents(compacted))
	}
	if !strings.Contains(compacted[1].Content, "# 稳定作品上下文") {
		t.Fatalf("stable context must follow library background: %#v", messageContents(compacted))
	}
	if !isContextCompactionMessage(compacted[2]) {
		t.Fatalf("compaction summary must follow: %#v", messageContents(compacted))
	}
}

func TestIDEInstructionLibraryBackgroundReplacesLoreToolGuidance(t *testing.T) {
	// §8.6 通道 3（写作模式）：library 背景模式下系统提示不得指引旧 lore 工具，
	// 必须替换为 read_library_item 指引；默认模式保持旧指引（替换表与 body 逐字节同步）。
	state := book.NewState(t.TempDir())
	cfg := &config.Config{Workspace: state.Workspace()}

	libraryInstruction := BuildLibraryBackgroundInstruction(cfg, state, IDEStoryTeller{})
	for _, banned := range []string{"read_lore_items", "list_lore_items", "write_lore_items"} {
		if strings.Contains(libraryInstruction, banned) {
			t.Fatalf("library-mode instruction must not reference legacy lore tool %q", banned)
		}
	}
	for _, required := range []string{"read_library_item", "设定库为只读背景"} {
		if !strings.Contains(libraryInstruction, required) {
			t.Fatalf("library-mode instruction must guide the library read tool %q:\n%s", required, libraryInstruction)
		}
	}

	// 默认模式不回归：旧 lore 工具指引仍在（同时守护替换表左侧与 body 逐字节同步）。
	defaultInstruction := BuildInstruction(cfg, state, IDEStoryTeller{})
	for _, required := range []string{"read_lore_items", "list_lore_items", "write_lore_items"} {
		if !strings.Contains(defaultInstruction, required) {
			t.Fatalf("default instruction must keep lore tool guidance %q (replacement pairs out of sync)", required)
		}
	}
}
