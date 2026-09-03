package app

import (
	"context"
	"fmt"
	"strings"

	"github.com/cloudwego/eino/adk"

	"denova/config"
	"denova/internal/agent"
	"denova/internal/book"
	"denova/internal/session"
)

// StartMasterAgentTask runs one scoped Master Agent task using the existing
// Agent Runner/Task/SSE lifecycle. The task receives no generic file tools.
func (a *App) StartMasterAgentTask(ctx context.Context, masterItemID, fieldPath, kind, message string) (*Task, error) {
	if a == nil {
		return nil, ErrNoWorkspace
	}
	a.mu.RLock()
	workspace, cfg, state, sessions, chat := a.workspace, a.cfg, a.bookState, a.sessionStore, a.chatService
	a.mu.RUnlock()
	if strings.TrimSpace(workspace) == "" || cfg == nil || sessions == nil {
		return nil, ErrNoWorkspace
	}
	masterItemID = strings.TrimSpace(masterItemID)
	fieldPath = strings.TrimSpace(fieldPath)
	if masterItemID == "" || fieldPath == "" {
		return nil, fmt.Errorf("Master Agent 目标不能为空")
	}
	kind = strings.ToLower(strings.TrimSpace(kind))
	if kind != book.MasterProposalRecovery && kind != book.MasterProposalPolish {
		return nil, fmt.Errorf("Master Agent 任务类型无效")
	}
	message = strings.TrimSpace(message)
	if message == "" {
		if kind == book.MasterProposalPolish {
			message = "请对指定字段生成一个 polish_candidate，只创建 Proposal，不要自动采用。"
		} else {
			message = "请分析指定字段的翻译失败，尝试一次安全恢复；若不能可靠处理则停止并说明原因。"
		}
	}
	runtimeCfg := *cfg
	runner, err := buildMasterAgentRunner(ctx, &runtimeCfg, state, masterItemID, fieldPath)
	if err != nil {
		return nil, err
	}
	agentSession, err := session.AgentSession(sessions, config.AgentKindToolAgent)
	if err != nil {
		return nil, err
	}
	if chat == nil {
		chat = agent.NewChatService()
	}
	masterWorkspace := book.ResolveMasterLibraryWorkspace(workspace)
	task := NewTask(func(taskCtx context.Context, task *Task, emit func(agent.Event)) {
		conversation := agent.NewSessionConversationForAgentWithRuntimeContext(
			agentSession, &runtimeCfg, config.AgentKindToolAgent,
			"Master 字段级处理", fmt.Sprintf("目标资产：%s\n目标字段：%s\n处理类型：%s", masterItemID, fieldPath, kind),
		)
		chat.RunWithOptions(taskCtx, runner, conversation, nil, agent.ChatRequest{Message: message}, agent.RunOptions{
			AgentKind: config.AgentKindToolAgent, RootAgentName: "DenovaMasterAgent", TaskID: task.ID(),
			SessionID: agentSession.ID, Workspace: masterWorkspace, Mode: "master_agent",
			ToolResultMaxBytes: runtimeCfg.AgentToolResultLimitKB * 1024,
		}, emit)
	})
	a.mu.Lock()
	if a.masterAgentTasks == nil {
		a.masterAgentTasks = make(map[string]*Task)
	}
	a.masterAgentTasks[task.ID()] = task
	a.mu.Unlock()
	return task, nil
}

func (a *App) MasterAgentTask(id string) *Task {
	if a == nil {
		return nil
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.masterAgentTasks[strings.TrimSpace(id)]
}

func buildMasterAgentRunner(ctx context.Context, cfg *config.Config, state *book.State, masterItemID, fieldPath string) (*adk.Runner, error) {
	builtAgent, err := agent.BuildMasterAgent(ctx, cfg, state, masterItemID, fieldPath)
	if err != nil {
		return nil, fmt.Errorf("构建 Master Agent 失败: %w", err)
	}
	return agent.NewRunnerWithOptions(ctx, builtAgent, agent.RunOptions{
		AgentKind: config.AgentKindToolAgent,
		Workspace: book.ResolveMasterLibraryWorkspace(cfg.Workspace),
	}), nil
}
