package worldcontext

import (
	"math"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// 四层硬上限（v2.7 §9.1）。
const (
	MaxSnapshotBytes       = 96 * 1024
	MaxProjectionBodyBytes = 96 * 1024
	MaxFinalModelViewBytes = 96 * 1024
	MaxModelRunes          = 48000
	MaxEstimatedTokens     = 12000
	ConsumerReserveTokens  = 4096
	sectionOverheadTokens  = 8
)

// BudgetLayer 标识超限发生在哪一层，用于错误回显。
type BudgetLayer string

const (
	LayerSnapshotBytes BudgetLayer = "snapshot_bytes"
	LayerBodyBytes     BudgetLayer = "projection_body_bytes"
	LayerModelRunes    BudgetLayer = "model_runes"
	LayerModelBytes    BudgetLayer = "model_view_bytes"
	LayerTokens        BudgetLayer = "estimated_tokens"
)

// EffectiveModelBudget 返回有效模型预算；窗口 ≤4096 时 windowTooSmall=true（直接 budget_exceeded）。
func EffectiveModelBudget(consumerContextWindowTokens int) (budget int, windowTooSmall bool) {
	if consumerContextWindowTokens <= ConsumerReserveTokens {
		return 0, true
	}
	budget = consumerContextWindowTokens - ConsumerReserveTokens
	if budget > MaxEstimatedTokens {
		budget = MaxEstimatedTokens
	}
	return budget, false
}

// NormalizeForEstimate 按 v2.7 §9.1 固定顺序规范化：NFC → 换行统一 →
// 每行行尾去空白 → 连续空行折叠 → 去首尾空白。纯函数，不依赖 locale。
func NormalizeForEstimate(s string) string {
	s = norm.NFC.String(s)
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")

	lines := strings.Split(s, "\n")
	// 逐行去行尾空白；任何 ≥2 个连续 \n（即空行段）都折叠为单个 \n：
	// 等价于丢弃空行、非空行之间只保留一个换行分隔（黄金样例 a\n\n\n\nb → a\nb）。
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimRight(line, " \t")
		if line == "" {
			continue
		}
		kept = append(kept, line)
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

// EstimateTokens 实现冻结的确定性分段公式：ceil(ascii/4) + nonAscii + sections*8。
// ascii=码位 ≤ U+007F，其余码位（含 CJK、全角、emoji）每个按 1 计。
func EstimateTokens(text string, sections int) int {
	normalized := NormalizeForEstimate(text)
	var ascii, nonAscii int
	for _, r := range normalized {
		if r <= 0x7F {
			ascii++
		} else {
			nonAscii++
		}
	}
	return int(math.Ceil(float64(ascii)/4.0)) + nonAscii + sections*sectionOverheadTokens
}

// CountSections 按 §4.10 定义计算非空段数：identity 恒 1，setting 存在计 1，
// 其余每个非空段（长度>0）计 1。入参依次为 characters/locations/factions/timeline/materials/sources 的长度。
func CountSections(settingPresent bool, sectionLengths ...int) int {
	n := 1 // identity
	if settingPresent {
		n++
	}
	for _, l := range sectionLengths {
		if l > 0 {
			n++
		}
	}
	return n
}

// ModelViewText 汇总最终 ModelView 的全部模型可见文本（固定顺序），用于 rune/token 计量。
func ModelViewText(mv *ModelView) string {
	var b strings.Builder
	write := func(s string) {
		if s != "" {
			if b.Len() > 0 {
				b.WriteByte('\n')
			}
			b.WriteString(s)
		}
	}
	write(mv.Identity.Name)
	write(mv.Identity.Tagline)
	write(mv.Identity.Genre)
	write(mv.Identity.Summary)
	if mv.Setting != nil {
		write(mv.Setting.Tone)
		for _, r := range mv.Setting.Rules {
			write(r)
		}
	}
	for _, c := range mv.Characters {
		write(c.DisplayName)
		write(c.WorldNote)
		for _, rel := range c.Relationships {
			write(rel.TargetLabel)
			write(rel.Label)
		}
	}
	for _, l := range mv.Locations {
		write(l.Name)
		write(l.Description)
		for _, t := range l.Tags {
			write(t)
		}
	}
	for _, f := range mv.Factions {
		write(f.Name)
		write(f.Description)
	}
	for _, t := range mv.Timeline {
		write(t.EraLabel)
		write(t.Title)
		write(t.Description)
	}
	for _, m := range mv.Materials {
		write(m.Name)
		write(m.SemanticTypeLabel)
		for _, t := range m.Tags {
			write(t)
		}
	}
	for _, s := range mv.Sources {
		write(s.Label)
	}
	return b.String()
}

// ModelViewRuneCount 返回规范化后的模型可见文本码位数。
func ModelViewRuneCount(mv *ModelView) int {
	return utf8.RuneCountInString(NormalizeForEstimate(ModelViewText(mv)))
}

// EstimateModelViewTokens 计算最终 ModelView 的 token 估算值。
func EstimateModelViewTokens(mv *ModelView) int {
	sections := CountSections(mv.Setting != nil,
		len(mv.Characters), len(mv.Locations), len(mv.Factions),
		len(mv.Timeline), len(mv.Materials), len(mv.Sources))
	return EstimateTokens(ModelViewText(mv), sections)
}

// CheckSnapshotBudget 校验内部 Snapshot JSON ≤ 96KiB。
func CheckSnapshotBudget(snap *Snapshot) error {
	raw, err := marshalStable(snap)
	if err != nil {
		return domainError(ErrProjectionFailed, "snapshot", "Snapshot 序列化失败")
	}
	if len(raw) > MaxSnapshotBytes {
		return budgetError(string(LayerSnapshotBytes), "内部快照超过 96KiB 上限")
	}
	return nil
}

// CheckProjectionBodyBudget 校验 source-neutral Body JSON ≤ 96KiB（Sources 为内部字段不参与序列化）。
func CheckProjectionBodyBudget(body *ProjectionBody) error {
	raw, err := marshalStable(body)
	if err != nil {
		return domainError(ErrProjectionFailed, "body", "ProjectionBody 序列化失败")
	}
	if len(raw) > MaxProjectionBodyBytes {
		return budgetError(string(LayerBodyBytes), "投影体超过 96KiB 上限")
	}
	return nil
}

// CheckFinalModelViewBudget 校验最终 ModelView：模型可见文本 ≤48000 rune 且 JSON ≤96KiB。
func CheckFinalModelViewBudget(mv *ModelView) error {
	if rc := ModelViewRuneCount(mv); rc > MaxModelRunes {
		return budgetError(string(LayerModelRunes), "模型可见文本超过 48000 码位上限")
	}
	raw, err := marshalStable(mv)
	if err != nil {
		return domainError(ErrProjectionFailed, "modelView", "ModelView 序列化失败")
	}
	if len(raw) > MaxFinalModelViewBytes {
		return budgetError(string(LayerModelBytes), "最终模型视图超过 96KiB 上限")
	}
	return nil
}

// CheckTokenBudget 在给定消费者上下文窗口下校验 token 估算；窗口过小单独标记（可降级）。
func CheckTokenBudget(mv *ModelView, consumerContextWindowTokens int) (estimated int, err error) {
	if _, tooSmall := EffectiveModelBudget(consumerContextWindowTokens); tooSmall {
		return 0, &DomainError{Code: ErrBudgetExceeded, Layer: "consumer_window",
			Message: "共享模型上下文窗口过小，本次不携带世界背景"}
	}
	effective, _ := EffectiveModelBudget(consumerContextWindowTokens)
	estimated = EstimateModelViewTokens(mv)
	if estimated > effective {
		return estimated, budgetError(string(LayerTokens), "估算 token 超过有效模型预算")
	}
	return estimated, nil
}
