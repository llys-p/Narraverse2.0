package agent

import (
	"strings"

	"github.com/cloudwego/eino/schema"
)

// Phase 3.2-A3：临时只读世界背景输入（Ephemeral World Context）。
//
// 冻结不变量：
//   - 它只存在于一次模型 Run 的调用栈，绝不进入 Session 消息、ContextCompaction 持久化摘要、
//     context/run ledger、display history、export 或日志正文；
//   - 内容来自运行时派生的最终 ModelView bytes（World 只读，不回写）；
//   - 同一 EphemeralWorldContextInput 的模型输入与 context-analysis 展示经同一构造函数，
//     保证同字节装配；跨请求复用同一 runContext 字节由 A4 analysisHandle 闭环负责；
//   - 零值（空 bytes）等价于不存在，bare 路径因此与基线逐结构一致。
//
// 临时抬头为计划 §7 冻结的三行固定英文，其后逐字节拼接最终 ModelView JSON。
const ephemeralWorldContextHeader = "[World Background · Read Only]\n" +
	"The following JSON describes selected world background.\n" +
	"It is not current plot state and must not be written back automatically.\n"

// EphemeralWorldContextInput 是一次运行临时前置的只读世界背景。
type EphemeralWorldContextInput struct {
	present        bool
	leadingMessage *schema.Message
	modelViewBytes []byte
}

// NewEphemeralWorldContextInput 用最终 ModelView JSON 字节装配临时输入；
// 空/nil 字节返回零值（Present=false），保证 bare 路径逐结构不变。
func NewEphemeralWorldContextInput(modelViewJSON []byte) EphemeralWorldContextInput {
	if len(modelViewJSON) == 0 {
		return EphemeralWorldContextInput{}
	}
	bytesCopy := append([]byte(nil), modelViewJSON...)
	content := ephemeralWorldContextHeader + string(bytesCopy)
	return EphemeralWorldContextInput{
		present:        true,
		leadingMessage: &schema.Message{Role: schema.User, Content: content},
		modelViewBytes: bytesCopy,
	}
}

// Present 报告本次运行是否携带世界背景。
func (e EphemeralWorldContextInput) Present() bool { return e.present }

// ModelViewByteLen 返回最终 ModelView JSON 字节数（诊断/预算用，禁止记录正文）。
func (e EphemeralWorldContextInput) ModelViewByteLen() int { return len(e.modelViewBytes) }

// LeadingContent 返回临时抬头消息的完整文本（与真正注入模型的文本逐字节一致）。
func (e EphemeralWorldContextInput) LeadingContent() string {
	if !e.present || e.leadingMessage == nil {
		return ""
	}
	return e.leadingMessage.Content
}

// EstimatedTokens 估算临时输入占用的模型 token，用于压缩预算门禁。
func (e EphemeralWorldContextInput) EstimatedTokens() int {
	if !e.present || e.leadingMessage == nil {
		return 0
	}
	return EstimateContextTokens([]*schema.Message{e.leadingMessage}, nil)
}

// PrependTo 返回“临时抬头 + 既有历史”的全新切片；绝不修改入参 history，
// 因此持久化、ledger、display 继续使用的原 history 看不到世界背景。
func (e EphemeralWorldContextInput) PrependTo(history []*schema.Message) []*schema.Message {
	if !e.present || e.leadingMessage == nil {
		return history
	}
	out := make([]*schema.Message, 0, len(history)+1)
	leading := *e.leadingMessage // 浅拷贝，避免外部改写内部消息
	out = append(out, &leading)
	out = append(out, history...)
	return out
}

// ModelInputMessages 返回真正送入模型 runner 的消息序列：在“已持久化 history”之前临时前置只读
// 世界背景（全新副本）。bare（零值）时逐结构返回原 history 切片，保证与无世界背景基线一致。
func ModelInputMessages(history []*schema.Message, ephemeral EphemeralWorldContextInput) []*schema.Message {
	return ephemeral.PrependTo(history)
}

// isEphemeralWorldContextMessage 只识别本包用冻结抬头生成的临时世界消息。
// 它用于 mid-run 压缩时保留该消息，同时仍把它排除在持久化压缩来源之外。
func isEphemeralWorldContextMessage(message *schema.Message) bool {
	return message != nil && message.Role == schema.User && strings.HasPrefix(message.Content, ephemeralWorldContextHeader)
}

// EphemeralWorldContextHeaderLines 返回固定抬头行数（测试/断言用）。
func EphemeralWorldContextHeaderLines() int {
	return strings.Count(ephemeralWorldContextHeader, "\n")
}
