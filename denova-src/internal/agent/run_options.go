package agent

import (
	"context"
	"strings"
	"time"

	"denova/internal/libraryruntime"
)

const (
	AgentKindUnknown          = "unknown"
	AgentKindIDE              = "ide"
	AgentKindInteractiveStory = "interactive_story"
	AgentKindConfigManager    = "config_manager"
	AgentKindImage            = "image"
	AgentKindAutomation       = "automation"
)

// RunOptions identifies one Agent run across runtime, trace, and UI surfaces.
type RunOptions struct {
	AgentKind              string
	RootAgentName          string
	TaskID                 string
	SessionID              string
	ReviewThreadID         string
	StoryID                string
	BranchID               string
	TurnID                 string
	MaintenanceTask        string
	Workspace              string
	Mode                   string
	IdleTimeout            time.Duration
	ToolResultMaxBytes     int
	SystemPromptLog        SystemPromptCompositionLog
	OnMutationsVerified    func(context.Context, []ToolMutation, PostRunVerification)
	OnUserMessageCommitted func(context.Context) error
	// EphemeralWorldContext 是本次运行临时前置的只读世界背景，仅存在于调用栈，
	// 不进入 Session/压缩摘要/ledger/display/export/日志；零值表示 bare 运行。
	EphemeralWorldContext EphemeralWorldContextInput
	// EphemeralLibraryContext 是本次运行临时前置的只读设定库背景（B2a，与
	// EphemeralWorldContext 由传输层互斥）；同样仅存在于调用栈，零值表示未携带。
	EphemeralLibraryContext EphemeralLibraryContextInput
	// LibraryRuntimeRun 是本次写作运行绑定的设定库临时读取授权运行。
	// 模型送入前用它把“系统提示 + 已组装历史 + 新消息”量测后计入累计预算
	// （§8.3），失败以显式 budget_exceeded 终止运行；nil 表示非 library 模式。
	// 它只用于计费钩子，工具持有同一 Run 的引用由 builder 侧注入。
	LibraryRuntimeRun *libraryruntime.Run
}

// ExternalCostCharger 是运行期外部成本计费通道（§8.3 累计预算），
// *libraryruntime.Run 实现该接口；测试可用假实现替代。
type ExternalCostCharger interface {
	ChargeExternal(bytes, tokens int) error
}

func (o RunOptions) normalized(defaultWorkspace string) RunOptions {
	o.AgentKind = strings.TrimSpace(o.AgentKind)
	if o.AgentKind == "" {
		o.AgentKind = AgentKindUnknown
	}
	o.RootAgentName = strings.TrimSpace(o.RootAgentName)
	if o.RootAgentName == "" {
		o.RootAgentName = rootAgentNameForKind(o.AgentKind)
	}
	o.TaskID = strings.TrimSpace(o.TaskID)
	o.SessionID = strings.TrimSpace(o.SessionID)
	o.ReviewThreadID = strings.TrimSpace(o.ReviewThreadID)
	o.StoryID = strings.TrimSpace(o.StoryID)
	o.BranchID = strings.TrimSpace(o.BranchID)
	o.TurnID = strings.TrimSpace(o.TurnID)
	o.MaintenanceTask = strings.TrimSpace(o.MaintenanceTask)
	o.Workspace = strings.TrimSpace(o.Workspace)
	if o.Workspace == "" {
		o.Workspace = strings.TrimSpace(defaultWorkspace)
	}
	o.Mode = strings.TrimSpace(o.Mode)
	if o.IdleTimeout < 0 {
		o.IdleTimeout = 0
	}
	if o.ToolResultMaxBytes < 0 {
		o.ToolResultMaxBytes = 0
	}
	return o
}

func rootAgentNameForKind(kind string) string {
	switch strings.TrimSpace(kind) {
	case AgentKindIDE:
		return "DenovaAgent"
	case AgentKindInteractiveStory:
		return "DenovaInteractiveStoryAgent"
	case AgentKindConfigManager:
		return "DenovaConfigManagerAgent"
	case AgentKindImage:
		return "DenovaImageAgent"
	case AgentKindAutomation:
		return "DenovaAutomationAgent"
	default:
		return ""
	}
}

func (o RunOptions) checkpointID(runID string) string {
	parts := []string{strings.TrimSpace(o.AgentKind)}
	switch {
	case strings.TrimSpace(o.SessionID) != "":
		parts = append(parts, "session", strings.TrimSpace(o.SessionID))
	case strings.TrimSpace(o.TaskID) != "":
		parts = append(parts, "task", strings.TrimSpace(o.TaskID))
	case strings.TrimSpace(runID) != "":
		parts = append(parts, "run", strings.TrimSpace(runID))
	default:
		return ""
	}
	return strings.Join(parts, ":")
}

const runTraceMetadataValueMaxBytes = 256

func runTraceMetadataForConversation(options RunOptions, conversation Conversation) RunTraceMetadata {
	metadata := RunTraceMetadata{
		StoryID:         options.StoryID,
		BranchID:        options.BranchID,
		TurnID:          options.TurnID,
		MaintenanceTask: options.MaintenanceTask,
	}
	// §8.5：library 模式在 run ledger 只增记库 ID/revision 元数据，禁止正文。
	if options.LibraryRuntimeRun != nil {
		if st := options.LibraryRuntimeRun.Status(); st.LibraryID != "" {
			metadata.LibraryID = st.LibraryID
			metadata.LibraryRevision = st.Revision
		}
	}
	if reporter, ok := conversation.(RunTraceMetadataReporter); ok {
		reported := reporter.RunTraceMetadata()
		if strings.TrimSpace(reported.StoryID) != "" {
			metadata.StoryID = reported.StoryID
		}
		if strings.TrimSpace(reported.BranchID) != "" {
			metadata.BranchID = reported.BranchID
		}
		if strings.TrimSpace(reported.TurnID) != "" {
			metadata.TurnID = reported.TurnID
		}
		if strings.TrimSpace(reported.MaintenanceTask) != "" {
			metadata.MaintenanceTask = reported.MaintenanceTask
		}
	}
	metadata.StoryID = boundedRunTraceMetadataValue(metadata.StoryID)
	metadata.BranchID = boundedRunTraceMetadataValue(metadata.BranchID)
	metadata.TurnID = boundedRunTraceMetadataValue(metadata.TurnID)
	metadata.MaintenanceTask = boundedRunTraceMetadataValue(metadata.MaintenanceTask)
	metadata.LibraryID = boundedRunTraceMetadataValue(metadata.LibraryID)
	metadata.LibraryRevision = boundedRunTraceMetadataValue(metadata.LibraryRevision)
	return metadata
}

func boundedRunTraceMetadataValue(value string) string {
	return truncateUTF8StringBytes(strings.TrimSpace(value), runTraceMetadataValueMaxBytes)
}

func (m RunTraceMetadata) empty() bool {
	return m.StoryID == "" && m.BranchID == "" && m.TurnID == "" && m.MaintenanceTask == "" &&
		m.LibraryID == "" && m.LibraryRevision == ""
}

func (m RunTraceMetadata) record() map[string]any {
	return map[string]any{
		"story_id":         m.StoryID,
		"branch_id":        m.BranchID,
		"turn_id":          m.TurnID,
		"maintenance_task": m.MaintenanceTask,
		"library_id":       m.LibraryID,
		"library_revision": m.LibraryRevision,
	}
}
