package app

import (
	"denova/internal/worldcontext"
)

// Phase 3.2-B1：游戏运行的 World Context 输入边界（传输层 DTO 已在 handlers 层解码）。
//
// 冻结约束（与写作侧 WritingWorldControl 对齐）：
//   - 游戏请求体的既有业务字段（story_id/branch/message/style_scenes/...）绝不塞入
//     worldcontext 运行字段；World 控制信息经独立的 InteractiveWorldControl 显式传递；
//   - consumer 由游戏路径固定为 game，scopeKey 由服务端 InteractiveRun/Task 派生，
//     客户端提交的 consumer/scope/runContextId 已在 HTTP 传输层被拒绝；
//   - B1 只建立输入边界与 handler 传参，不做 runContext 绑定（B2 实现 resolveInteractiveRun）；
//   - World 只读：不写 revision、不保存 Snapshot/ModelView。

// InteractiveWorldControl 是一次游戏请求携带的 World Context 控制信息（handler-owned）。
type InteractiveWorldControl struct {
	// Ref 为 nil 表示请求未携带 world_context（bare 游戏回合）。
	Ref *worldcontext.Ref
	// HasAnalysisHandle 表示是否携带非空 analysis_handle（"" 与 null 视为未携带）。
	HasAnalysisHandle bool
	// AnalysisHandle 是规范化后的不透明 token；不是 Task、runContext，也不持久化。
	AnalysisHandle string
}

// Present 报告是否携带任一 World Context 控制字段。
func (c InteractiveWorldControl) Present() bool {
	return c.Ref != nil || c.HasAnalysisHandle
}

// InteractiveTaskInput 是游戏后台任务的完整 app 层输入：业务参数 + World 控制信息分离。
// B1 阶段 World 字段已传递但暂不消费（bare 路径不变）；B2 在 startInteractiveTask 中
// 接入 resolveInteractiveRun 完成 bind-before-start。
type InteractiveTaskInput struct {
	StoryID      string
	BranchID     string
	Message      string
	StyleScenes  []string
	Locale       string
	RewindTurnID string // 空表示新回合，非空表示 regenerate
	World        InteractiveWorldControl
}
