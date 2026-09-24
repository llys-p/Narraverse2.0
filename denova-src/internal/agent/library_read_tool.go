package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/cloudwego/eino/components/tool"
	utils "github.com/cloudwego/eino/components/tool/utils"

	"denova/internal/libraryruntime"
)

// B2a：library 模式的按需读取工具。
//
// 冻结约束（L3 计划 §8.5/§8.6）：
//   - 工具持有服务端绑定的 *libraryruntime.Run（固定 revision + manual 授权集 + 累计预算），
//     模型提交的任意 ID/路径都经 ReadOnDemand 逐项校验归属与剩余额度；
//   - 工具结果正文只回给当次模型的工具循环，绝不进入 Session 跨轮上下文
//     （retainToolContextAcrossTurns=false）、display 存档与 run ledger 正文
//     （tool_result 事件在装配点脱敏为元数据）；
//   - 失败显式返回稳定错误码（unavailable|stale|denied|budget_exceeded|released），
//     不把失败伪装成成功或空内容。
const libraryReadItemToolName = "read_library_item"

// 脱敏事件的固定文案：fail-closed 输出不允许包含工具结果的任何原文片段。
const (
	libraryReadEmptyNotice      = "[library-item-read] empty result"
	libraryReadUnparsableNotice = "[library-item-read] unparsable result"
	// libraryReadUnparsableCode 是脱敏层在解析失败且无白名单错误码时回传的固定码
	// （固定字面量，不来自工具结果内容）。
	libraryReadUnparsableCode = "unparsable"
)

// libraryReadStableErrorCodes 是运行期显式失败码白名单（见 newLibraryReadTools 注释）；
// 事件脱敏只允许回传码本身，不允许码后的消息文本。
var libraryReadStableErrorCodes = []string{"unavailable", "stale", "denied", "budget_exceeded", "released"}

// newLibraryReadTools 构造 library 模式的按需读取工具集（当前仅单条读取）。
func newLibraryReadTools(run *libraryruntime.Run) ([]tool.BaseTool, error) {
	if run == nil {
		return nil, fmt.Errorf("设定库运行未绑定，无法装配读取工具")
	}
	readTool, err := utils.InferTool(libraryReadItemToolName,
		"按条目 ID 从本次绑定的作品设定库中读取单条设定。可读范围仅限临时库背景 catalog 中列出的条目（auto 条目与本次已授权的 manual 条目）；catalog 之外、禁用或未授权的条目会被拒绝。需要批量内容时逐条调用。",
		func(ctx context.Context, input struct {
			ItemID string `json:"itemId" jsonschema:"描述=要读取的设定条目 ID，必须来自临时库背景 catalog"`
		}) (string, error) {
			itemID := strings.TrimSpace(input.ItemID)
			if itemID == "" {
				return "", fmt.Errorf("itemId 不能为空")
			}
			result, err := run.ReadOnDemand(ctx, itemID)
			if err != nil {
				return "", err // 稳定错误码随错误文本回给模型
			}
			return result.ModelText, nil
		})
	if err != nil {
		return nil, err
	}
	return []tool.BaseTool{readTool}, nil
}

// isLibraryReadToolName 识别库按需读取工具（用于事件脱敏与持久化隔离判定）。
func isLibraryReadToolName(name string) bool {
	return strings.EqualFold(strings.TrimSpace(name), libraryReadItemToolName)
}

// libraryItemViewMeta 是从工具结果 JSON 中只提取元数据字段的解码目标；
// 正文字段（content/fields/event）与可能含磁盘路径的 origin 一律不在此列。
type libraryItemViewMeta struct {
	ItemID         string `json:"itemId"`
	Name           string `json:"name"`
	Type           string `json:"type"`
	LoadMode       string `json:"loadMode"`
	SourceRevision string `json:"sourceRevision"`
}

// libraryReadToolEventData 把库读取工具结果转成可下发/可落盘的脱敏形态（§8.5 唯一脱敏点）：
//   - 成功：notice 只携带条目名（为空回退条目 ID），meta 只携带白名单元数据；
//   - 失败：fail-closed——只输出固定提示、字节数与白名单稳定错误码。
//
// 任何解析失败形态（包装前缀、尾随附加数据、截断/畸形/非对象 JSON、超长输入）都不得
// 回显原始内容、截断前缀或错误码后的消息文本；SSE、display 存档与 run ledger 共用其
// 输出，模型仍通过 runner 内部工具循环拿到完整结果，不受影响。
func libraryReadToolEventData(content string) (notice string, meta map[string]any) {
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return libraryReadEmptyNotice, map[string]any{"bytes": 0}
	}
	// 宽松解码：真实链路里工具消息可能带平台侧尾随数据（B3c 验收 D1），只取首个
	// JSON 值并按白名单字段提取元数据；解码成功但无条目 ID 的输入不视为成功。
	var view libraryItemViewMeta
	if err := json.NewDecoder(strings.NewReader(trimmed)).Decode(&view); err == nil && strings.TrimSpace(view.ItemID) != "" {
		name := strings.TrimSpace(view.Name)
		if name == "" {
			name = strings.TrimSpace(view.ItemID)
		}
		meta = map[string]any{
			"itemId":         view.ItemID,
			"name":           view.Name,
			"type":           view.Type,
			"loadMode":       view.LoadMode,
			"sourceRevision": view.SourceRevision,
			"bytes":          len(content),
		}
		return "[library-item-read] " + name, meta
	}
	// 运行期失败：按白名单扫描稳定错误码（框架包装前缀下仍稳定），只回传码本身；
	// 命中多个时取位置最靠前的一个，保证同一输入输出确定。
	code := ""
	codeIndex := -1
	for _, candidate := range libraryReadStableErrorCodes {
		if idx := strings.Index(trimmed, candidate+": "); idx >= 0 && (codeIndex < 0 || idx < codeIndex) {
			code, codeIndex = candidate, idx
		}
	}
	if code != "" {
		return "[library-item-read] " + code, map[string]any{"errorCode": code, "bytes": len(content)}
	}
	return libraryReadUnparsableNotice, map[string]any{"errorCode": libraryReadUnparsableCode, "bytes": len(content)}
}
