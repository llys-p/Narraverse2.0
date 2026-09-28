package libraryruntime

// 临时只读设定库背景输入（Ephemeral Library Context）。
//
// 冻结不变量（与 agent.EphemeralWorldContextInput 同构，§8.5）：
//   - 它只存在于一次模型 Run 的调用栈：由 AssembleInitial 装配、由调用方作为
//     leading message 前置到当次模型输入；绝不进入 Session 持久历史、压缩来源/
//     摘要、context/run ledger、display、export 或日志正文；
//   - 内容是绑定期固定 revision 下的只读投影（World/Library/剧情存档都不回写）；
//   - 零值（Present=false）等价于“本次运行没有库背景”，仅当用户显式选择
//     none/legacy 或装配结果为空时出现；任何错误路径都不会静默降级成零值。
const ephemeralLibraryContextHeader = "[Library Setting Context · Read Only]\n" +
	"The following JSON is the bound library setting background: loaded entries are included, and catalog entries may be fetched on demand.\n" +
	"It is reference data, not current plot state, and must not be written back automatically.\n"

// EphemeralLibraryContextHeader 返回冻结抬头的逐字节副本。
// agent 层只用它识别 leading message（mid-run 压缩保留、model-input 日志脱敏），不得改动其内容。
func EphemeralLibraryContextHeader() string {
	return ephemeralLibraryContextHeader
}

// EphemeralLibraryContext 是一次运行临时前置的只读设定库背景。
type EphemeralLibraryContext struct {
	present        bool
	text           string // 冻结抬头 + ModelView JSON，与真正注入模型的文本逐字节一致
	modelViewBytes int
}

// NewEphemeralLibraryContext 用初始装配 JSON 字节构造临时输入；
// 空/nil 字节返回零值（Present=false），保证 bare 路径逐结构不变。
func NewEphemeralLibraryContext(modelViewJSON []byte) EphemeralLibraryContext {
	if len(modelViewJSON) == 0 {
		return EphemeralLibraryContext{}
	}
	text := ephemeralLibraryContextHeader + string(modelViewJSON)
	return EphemeralLibraryContext{present: true, text: text, modelViewBytes: len(modelViewJSON)}
}

// Present 报告本次运行是否携带设定库背景。
func (e EphemeralLibraryContext) Present() bool { return e.present }

// ModelViewByteLen 返回初始装配 JSON 字节数（诊断/预算用，禁止记录正文）。
func (e EphemeralLibraryContext) ModelViewByteLen() int { return e.modelViewBytes }

// LeadingText 返回完整临时输入文本（与注入模型的文本逐字节一致）。
func (e EphemeralLibraryContext) LeadingText() string { return e.text }

// EstimatedTokens 估算临时输入占用的模型 token（与预算口径一致）。
func (e EphemeralLibraryContext) EstimatedTokens() int {
	_, tokens := measureText(e.text)
	return tokens
}
