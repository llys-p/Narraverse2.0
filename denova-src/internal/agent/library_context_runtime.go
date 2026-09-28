package agent

import (
	"strings"

	"github.com/cloudwego/eino/schema"

	"denova/internal/libraryruntime"
)

// B2a：临时只读设定库背景输入（Ephemeral Library Context）。
//
// 冻结不变量（与 EphemeralWorldContextInput 同构，L3 计划 §8.5）：
//   - 它只存在于一次模型 Run 的调用栈，绝不进入 Session 消息、ContextCompaction 持久化摘要、
//     context/run ledger、display history、export 或日志正文；
//   - 文本由 libraryruntime.AssembleInitial 在绑定期产出（冻结抬头 + ModelView JSON，
//     固定 revision 只读投影），本类型不再增删任何字节；
//   - 零值（空文本）等价于“本次运行没有库背景”，仅当用户显式选择 legacy/none 时出现；
//     library 模式装配失败在绑定期阻断，不存在静默降级为零值的路径。
//
// 抬头字符串的唯一定义在 libraryruntime（EphemeralLibraryContextHeader），
// 本包只读引用，保证识别与装配逐字节一致。
type EphemeralLibraryContextInput struct {
	present        bool
	leadingMessage *schema.Message
}

// NewEphemeralLibraryContextInput 用 libraryruntime 装配出的完整临时文本（含冻结抬头）
// 构造 leading message；空文本返回零值（Present=false）。
func NewEphemeralLibraryContextInput(leadingText string) EphemeralLibraryContextInput {
	if strings.TrimSpace(leadingText) == "" {
		return EphemeralLibraryContextInput{}
	}
	return EphemeralLibraryContextInput{
		present:        true,
		leadingMessage: &schema.Message{Role: schema.User, Content: leadingText},
	}
}

// Present 报告本次运行是否携带设定库背景。
func (e EphemeralLibraryContextInput) Present() bool { return e.present }

// LeadingContent 返回临时抬头消息的完整文本（与真正注入模型的文本逐字节一致）。
func (e EphemeralLibraryContextInput) LeadingContent() string {
	if !e.present || e.leadingMessage == nil {
		return ""
	}
	return e.leadingMessage.Content
}

// ModelViewByteLen 返回临时文本字节数（诊断/预算用，禁止记录正文）。
func (e EphemeralLibraryContextInput) ModelViewByteLen() int {
	return len(e.LeadingContent())
}

// EstimatedTokens 估算临时输入占用的模型 token，用于压缩预算门禁。
func (e EphemeralLibraryContextInput) EstimatedTokens() int {
	if !e.present || e.leadingMessage == nil {
		return 0
	}
	return EstimateContextTokens([]*schema.Message{e.leadingMessage}, nil)
}

// PrependTo 返回“临时库背景 + 既有历史”的全新切片；绝不修改入参 history，
// 因此持久化、ledger、display 继续使用的原 history 看不到库正文。
func (e EphemeralLibraryContextInput) PrependTo(history []*schema.Message) []*schema.Message {
	if !e.present || e.leadingMessage == nil {
		return history
	}
	out := make([]*schema.Message, 0, len(history)+1)
	leading := *e.leadingMessage // 浅拷贝，避免外部改写内部消息
	out = append(out, &leading)
	out = append(out, history...)
	return out
}

// ModelInputMessagesWithLibrary 返回真正送入模型 runner 的消息序列。
// library 与 world 背景由传输层互斥（同现即 400），此处不做优先级吞并：
// 若两者同时非零（防御性），按“库背景最前、世界背景其后”确定性装配并保持可断言。
func ModelInputMessagesWithLibrary(history []*schema.Message, world EphemeralWorldContextInput, library EphemeralLibraryContextInput) []*schema.Message {
	if library.Present() {
		return library.PrependTo(world.PrependTo(history))
	}
	return world.PrependTo(history)
}

// isEphemeralLibraryContextMessage 只识别 libraryruntime 冻结抬头生成的临时库消息。
// 它用于 mid-run 压缩时保留该消息，同时仍把它排除在持久化压缩来源之外。
func isEphemeralLibraryContextMessage(message *schema.Message) bool {
	return message != nil && message.Role == schema.User && strings.HasPrefix(message.Content, libraryruntime.EphemeralLibraryContextHeader())
}

// chargeLibraryRuntimeInputCost 把“系统提示 + 已组装模型历史（含新用户消息）”量测后
// 经 ChargeExternal 计入单运行累计预算（§8.3）。入参 history 必须是尚未前置临时库
// 背景的原始模型历史：库背景已由绑定期 AssembleInitial 计费，重复传入会双重计费。
// charger 为 nil 时是 no-op（非 library 模式）。
func chargeLibraryRuntimeInputCost(charger ExternalCostCharger, systemPrompt string, history []*schema.Message) error {
	if charger == nil {
		return nil
	}
	messages := make([]*schema.Message, 0, len(history)+1)
	if strings.TrimSpace(systemPrompt) != "" {
		messages = append(messages, &schema.Message{Role: schema.System, Content: systemPrompt})
	}
	messages = append(messages, history...)
	totalBytes := 0
	for _, m := range messages {
		if m == nil {
			continue
		}
		totalBytes += len(m.Content)
	}
	tokens := EstimateContextTokens(messages, nil)
	return charger.ChargeExternal(totalBytes, tokens)
}
