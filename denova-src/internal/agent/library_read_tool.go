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

// libraryReadToolEventData 把库读取工具结果转成可下发/可落盘的脱敏形态：
//   - 成功：notice 为固定占位标记（不含正文），meta 只携带条目元数据；
//   - 失败：错误文本是服务端稳定错误码 + 消息（不含正文），按上限截断防止模型超长输入放大。
//
// 该函数是 tool_result 事件的唯一脱敏点：SSE、display、run ledger 共用其输出，
// 模型仍通过 runner 内部工具循环拿到完整结果，不受影响。
func libraryReadToolEventData(content string) (notice string, meta map[string]any) {
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return "[library-item-read] empty result", map[string]any{"bytes": 0}
	}
	var view libraryItemViewMeta
	if err := json.Unmarshal([]byte(trimmed), &view); err == nil && strings.TrimSpace(view.ItemID) != "" {
		meta = map[string]any{
			"itemId":         view.ItemID,
			"name":           view.Name,
			"type":           view.Type,
			"loadMode":       view.LoadMode,
			"sourceRevision": view.SourceRevision,
			"bytes":          len(content),
		}
		return "[library-item-read] " + view.Name, meta
	}
	// 失败路径：错误文本本身是“稳定错误码: 消息”，只保留有界前缀，防止把超长输入回显进事件。
	// 框架层（InferTool/LocalFunc）可能给错误文本加包装前缀，因此先按已知运行期错误码扫描。
	if len(trimmed) > 200 {
		trimmed = trimmed[:200]
	}
	for _, code := range []string{"unavailable", "stale", "denied", "budget_exceeded", "released"} {
		if idx := strings.Index(trimmed, code+": "); idx >= 0 {
			msg := trimmed[idx+len(code)+2:]
			if len(msg) > 160 {
				msg = msg[:160]
			}
			return "[library-item-read] " + msg, map[string]any{"errorCode": code, "bytes": len(content)}
		}
	}
	code, msg, found := strings.Cut(trimmed, ": ")
	if !found {
		return "[library-item-read] " + trimmed, map[string]any{"bytes": len(content)}
	}
	meta = map[string]any{"errorCode": strings.TrimSpace(code), "bytes": len(content)}
	return "[library-item-read] " + strings.TrimSpace(msg), meta
}
