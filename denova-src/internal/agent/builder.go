package agent

import (
	"context"
	"fmt"
	"log"
	"strings"

	localbk "github.com/cloudwego/eino-ext/adk/backend/local"
	"github.com/cloudwego/eino-ext/components/model/openai"
	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/adk/filesystem"
	filesystemmw "github.com/cloudwego/eino/adk/middlewares/filesystem"
	"github.com/cloudwego/eino/adk/middlewares/skill"
	"github.com/cloudwego/eino/adk/prebuilt/deep"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/compose"

	"denova/config"
	agenttools "denova/internal/agent/tools"
	"denova/internal/book"
	"denova/internal/libraryruntime"
	"denova/internal/prompts"
	"denova/internal/providercompat"
	novaskills "denova/internal/skills"
	"denova/internal/workspacechange"
)

var newDeepAgent = deep.New

const unlimitedAgentMaxIterations = 1_000_000

// Build 构建小说创作 Agent（deep agent + 文件系统工具 + Skill 中间件）。
func Build(ctx context.Context, cfg *config.Config, state *book.State, teller IDEStoryTeller) (adk.Agent, error) {
	return buildDeepAgent(ctx, cfg, deepAgentSpec{
		Kind:              config.AgentKindIDE,
		Name:              "DenovaAgent",
		Description:       "AI 小说创作助手",
		Instruction:       BuildInstruction(cfg, state, teller),
		EnableSkills:      true,
		ExtraToolsFactory: ideToolsFactory(cfg),
	})
}

// BuildWithLibraryBackground 构建 library 背景模式的写作 Agent（B2a）。
// 与 Build 的差异（§8.6 通道 2/3）：不挂载旧 lore 读取工具（防止新旧两套设定叠加），
// 改挂载持有本次绑定 Run 的 read_library_item 按需读取工具。其余工具集逐字节一致。
// instruction 必须是调用方以单源 composition 构建的系统提示（B2a 修正轮缺口②：
// 与 RunOptions.SystemPromptLog 同一来源，保证计费/审计文本 == 模型实际系统提示）；
// 空串时退回自建 library 提示（防御性兜底，不改变行为语义）。
// libRun 必须是本次写作任务在 bind-before-start 阶段绑定的运行；nil 时退回 Build。
func BuildWithLibraryBackground(ctx context.Context, cfg *config.Config, state *book.State, teller IDEStoryTeller, instruction string, libRun *libraryruntime.Run) (adk.Agent, error) {
	if libRun == nil {
		return Build(ctx, cfg, state, teller)
	}
	if strings.TrimSpace(instruction) == "" {
		instruction = BuildLibraryBackgroundInstruction(cfg, state, teller)
	}
	return buildDeepAgent(ctx, cfg, deepAgentSpec{
		Kind:              config.AgentKindIDE,
		Name:              "DenovaAgent",
		Description:       "AI 小说创作助手",
		Instruction:       instruction,
		EnableSkills:      true,
		ExtraToolsFactory: ideToolsFactoryWithLibrary(cfg, libRun),
	})
}

// BuildWithNoBackground 构建“显式无作品背景”（background_source=none）的写作 Agent
// （B2a 修正轮）：不挂载旧 lore 工具，也不挂载库读取工具；系统提示中的旧 lore
// 工具指引整段替换为无背景指引。instruction 必须由调用方以单源 composition 提供
// （与 RunOptions.SystemPromptLog 同一来源）；空串即显式报错——none 模式没有可
// 回退的自建提示路径。
func BuildWithNoBackground(ctx context.Context, cfg *config.Config, instruction string) (adk.Agent, error) {
	if strings.TrimSpace(instruction) == "" {
		return nil, fmt.Errorf("显式 none 背景模式必须提供单源系统提示")
	}
	return buildDeepAgent(ctx, cfg, deepAgentSpec{
		Kind:              config.AgentKindIDE,
		Name:              "DenovaAgent",
		Description:       "AI 小说创作助手",
		Instruction:       instruction,
		EnableSkills:      true,
		ExtraToolsFactory: ideToolsFactoryNoBackground(cfg),
	})
}

func BuildInteractiveStory(ctx context.Context, cfg *config.Config, state *book.State, teller prompts.InteractiveStorySystemInstructionInput, toolContexts ...InteractiveStoryToolContext) (adk.Agent, error) {
	handlers := []adk.ChatModelAgentMiddleware{newInteractiveStoryToolMiddleware()}
	var outputGuard func(context.Context, *adk.RetryContext) *adk.RetryDecision
	if len(toolContexts) > 0 && toolContexts[0].TurnResultReady != nil {
		completionTokens, _ := EstimateContextProjectionReserves(cfg, config.AgentKindInteractiveStory, teller.ReplyTargetChars)
		handlers = append(handlers, newInteractiveTurnProtocolMiddleware(toolContexts[0].TurnResultReady, completionTokens))
		outputGuard = newInteractiveCompletionGuard(toolContexts[0].TurnResultReady)
	}
	return buildDeepAgent(ctx, cfg, deepAgentSpec{
		Kind:              config.AgentKindInteractiveStory,
		Name:              "DenovaInteractiveStoryAgent",
		Description:       "AI 互动故事叙事助手",
		Instruction:       BuildInteractiveStoryInstruction(cfg, state, teller),
		EnableSkills:      true,
		DisableWriteTodos: true,
		ExtraHandlers:     handlers,
		ExtraToolsFactory: interactiveStoryToolsFactory(cfg, toolContexts...),
		ModelOutputGuard:  outputGuard,
	})
}

// BuildInteractiveStoryWithLibraryBackground 构建 library 背景模式的游戏回合 Agent
// （B3a，§8.6 通道 2）：不挂载旧 lore 读写工具（防止新旧两套设定叠加），改挂载持有
// 本次绑定 Run 的 read_library_item 按需读取工具；历史/状态/回合工具保持一致。
// instruction 必须是调用方以单源 composition（BuildInteractiveStoryBackgroundInstructionComposition）
// 构建的系统提示，与 RunOptions.SystemPromptLog 同一来源，保证计费/审计文本 == 模型
// 实际系统提示；空串即显式报错——library 模式没有可回退的自建提示路径。
// libRun 必须是本回合在 bind-before-start 阶段绑定的运行；nil 时退回 BuildInteractiveStory。
func BuildInteractiveStoryWithLibraryBackground(ctx context.Context, cfg *config.Config, state *book.State, teller prompts.InteractiveStorySystemInstructionInput, instruction string, libRun *libraryruntime.Run, toolContexts ...InteractiveStoryToolContext) (adk.Agent, error) {
	if libRun == nil {
		return BuildInteractiveStory(ctx, cfg, state, teller, toolContexts...)
	}
	if strings.TrimSpace(instruction) == "" {
		return nil, fmt.Errorf("library 背景模式必须提供单源系统提示")
	}
	handlers := []adk.ChatModelAgentMiddleware{newInteractiveStoryToolMiddleware()}
	var outputGuard func(context.Context, *adk.RetryContext) *adk.RetryDecision
	if len(toolContexts) > 0 && toolContexts[0].TurnResultReady != nil {
		completionTokens, _ := EstimateContextProjectionReserves(cfg, config.AgentKindInteractiveStory, teller.ReplyTargetChars)
		handlers = append(handlers, newInteractiveTurnProtocolMiddleware(toolContexts[0].TurnResultReady, completionTokens))
		outputGuard = newInteractiveCompletionGuard(toolContexts[0].TurnResultReady)
	}
	return buildDeepAgent(ctx, cfg, deepAgentSpec{
		Kind:              config.AgentKindInteractiveStory,
		Name:              "DenovaInteractiveStoryAgent",
		Description:       "AI 互动故事叙事助手",
		Instruction:       instruction,
		EnableSkills:      true,
		DisableWriteTodos: true,
		ExtraHandlers:     handlers,
		ExtraToolsFactory: interactiveStoryToolsFactoryWithLibrary(cfg, libRun, toolContexts...),
		ModelOutputGuard:  outputGuard,
	})
}

// BuildInteractiveStoryWithNoBackground 构建显式无作品背景（background_source=none）
// 的游戏回合 Agent（B3a）：不挂载旧 lore 工具，也不挂载库读取工具；系统提示旧 lore
// 指引由单源 composition 替换为无背景指引。空 instruction 显式报错。
func BuildInteractiveStoryWithNoBackground(ctx context.Context, cfg *config.Config, state *book.State, teller prompts.InteractiveStorySystemInstructionInput, instruction string, toolContexts ...InteractiveStoryToolContext) (adk.Agent, error) {
	if strings.TrimSpace(instruction) == "" {
		return nil, fmt.Errorf("显式 none 背景模式必须提供单源系统提示")
	}
	handlers := []adk.ChatModelAgentMiddleware{newInteractiveStoryToolMiddleware()}
	var outputGuard func(context.Context, *adk.RetryContext) *adk.RetryDecision
	if len(toolContexts) > 0 && toolContexts[0].TurnResultReady != nil {
		completionTokens, _ := EstimateContextProjectionReserves(cfg, config.AgentKindInteractiveStory, teller.ReplyTargetChars)
		handlers = append(handlers, newInteractiveTurnProtocolMiddleware(toolContexts[0].TurnResultReady, completionTokens))
		outputGuard = newInteractiveCompletionGuard(toolContexts[0].TurnResultReady)
	}
	return buildDeepAgent(ctx, cfg, deepAgentSpec{
		Kind:              config.AgentKindInteractiveStory,
		Name:              "DenovaInteractiveStoryAgent",
		Description:       "AI 互动故事叙事助手",
		Instruction:       instruction,
		EnableSkills:      true,
		DisableWriteTodos: true,
		ExtraHandlers:     handlers,
		ExtraToolsFactory: interactiveStoryToolsFactoryNoBackground(cfg, toolContexts...),
		ModelOutputGuard:  outputGuard,
	})
}

func BuildInteractiveDirector(ctx context.Context, cfg *config.Config, state *book.State, toolContexts ...InteractiveStoryToolContext) (adk.Agent, error) {
	// B3a（§8.6 通道 4）：library / 显式 none 背景模式下，导演系统提示使用无旧资料
	// 指引的变体；legacy 模式与基线逐字节一致。
	directorInstruction := prompts.BuildInteractiveDirectorSystemInstruction()
	if len(toolContexts) > 0 && toolContexts[0].NoLegacyLore {
		if toolContexts[0].BackgroundMode == prompts.BackgroundModeNone {
			directorInstruction = prompts.BuildInteractiveDirectorSystemInstructionWithBackground(prompts.BackgroundModeNone)
		} else {
			directorInstruction = prompts.BuildInteractiveDirectorSystemInstructionWithBackground(prompts.BackgroundModeLibrary)
		}
	}
	return buildDeepAgent(ctx, cfg, deepAgentSpec{
		Kind:              config.AgentKindInteractiveDirector,
		Name:              "DenovaInteractiveDirectorAgent",
		Description:       "AI 互动故事后台导演",
		Instruction:       protectedSystemInstruction(cfg, config.AgentKindInteractiveDirector, directorInstruction),
		EnableSkills:      false,
		DisableWriteTodos: true,
		ExtraHandlers:     []adk.ChatModelAgentMiddleware{newInteractiveDirectorPlanFileMiddleware()},
		ExtraToolsFactory: interactiveDirectorToolsFactory(cfg, toolContexts...),
	})
}

// BuildConfigManagerAgent 构建统一配置管理 Agent（deep agent + 通用工具 + Skill + 模块资源工具）。
func BuildConfigManagerAgent(ctx context.Context, cfg *config.Config, state *book.State, resourceSkills ...ConfigManagerResourceSkill) (adk.Agent, error) {
	return buildDeepAgent(ctx, cfg, deepAgentSpec{
		Kind:              config.AgentKindConfigManager,
		Name:              "DenovaConfigManagerAgent",
		Description:       "AI 配置与资源管理助手",
		Instruction:       BuildConfigManagerInstruction(cfg, state, resourceSkills...),
		EnableSkills:      true,
		ExtraToolsFactory: configManagerToolsFactory(cfg),
	})
}

// BuildAutomationAgent 构建后台自动化 Agent。工具权限由调用方按任务写入策略提前收敛到 cfg.AgentTools.Automation。
func BuildAutomationAgent(ctx context.Context, cfg *config.Config, state *book.State, task AutomationTaskInstruction) (adk.Agent, error) {
	return buildDeepAgent(ctx, cfg, deepAgentSpec{
		Kind:              config.AgentKindAutomation,
		Name:              "DenovaAutomationAgent",
		Description:       "AI 自动化任务助手",
		Instruction:       BuildAutomationInstruction(cfg, state, task),
		EnableSkills:      true,
		ExtraToolsFactory: loreToolsFactory(cfg, false),
	})
}

// BuildImageAgent 构建通用图像 Agent。调用方通过运行时上下文和 Skill 约束具体用途。
func BuildImageAgent(ctx context.Context, cfg *config.Config, state *book.State, systemPrompt string) (adk.Agent, error) {
	return buildDeepAgent(ctx, cfg, deepAgentSpec{
		Kind:              config.AgentKindImage,
		Name:              "DenovaImageAgent",
		Description:       "AI 图像生成助手",
		Instruction:       BuildImageInstruction(cfg, state, systemPrompt),
		EnableSkills:      true,
		DisableWriteTodos: true,
		ExtraToolsFactory: imageToolsFactory(cfg),
	})
}

// BuildMasterAgent builds the narrowly scoped Agent used by Master recovery
// and user-requested polish. It deliberately reuses the Tool Agent model path
// while disabling every generic filesystem/lore/skill capability.
func BuildMasterAgent(ctx context.Context, cfg *config.Config, state *book.State, masterItemID, fieldPath string) (adk.Agent, error) {
	_ = state
	if cfg == nil {
		return nil, fmt.Errorf("Master Agent 配置不存在")
	}
	restricted := *cfg
	restricted.AgentTools = restrictedMasterAgentTools()
	workspace := book.ResolveMasterLibraryWorkspace(cfg.Workspace)
	return buildDeepAgent(ctx, &restricted, deepAgentSpec{
		Kind:              config.AgentKindToolAgent,
		Name:              "DenovaMasterAgent",
		Description:       "Master 字段级异常恢复与翻译润色助手",
		Instruction:       masterAgentSystemInstruction(masterItemID, fieldPath),
		EnableSkills:      false,
		DisableWriteTodos: true,
		ExtraToolsFactory: func(config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
			return newMasterAgentTools(workspace, masterAgentScope{MasterItemID: strings.TrimSpace(masterItemID), FieldPath: strings.TrimSpace(fieldPath)})
		},
	})
}

func restrictedMasterAgentTools() config.AgentToolSettings {
	off := false
	return config.AgentToolSettings{
		Default:   config.AgentToolOverride{FileRead: &off, FileWrite: &off, ShellExecute: &off, Skills: &off, LoreRead: &off, LoreWrite: &off, Todo: &off, WebSearch: &off, ImageGeneration: &off, AgentConfigRead: &off, AgentConfigWrite: &off},
		ToolAgent: config.AgentToolOverride{FileRead: &off, FileWrite: &off, ShellExecute: &off, Skills: &off, LoreRead: &off, LoreWrite: &off, Todo: &off, WebSearch: &off, ImageGeneration: &off, AgentConfigRead: &off, AgentConfigWrite: &off},
	}
}

func masterAgentSystemInstruction(masterItemID, fieldPath string) string {
	return fmt.Sprintf("你是 Denova Master 字段级处理 Agent。你只能处理 master_item_id=%s、field_path=%s。先读取字段和运行状态，再判断是 recovery 还是 polish；必须 create_master_proposal → validate_master_patch →（仅满足权限时）apply_master_patch。不得修改原件、Adventure 实例、其它资产或无关字段；不得整卡翻译；不得循环重试。recovery 只尝试一次，polish 必须生成候选并等待用户确认。", strings.TrimSpace(masterItemID), strings.TrimSpace(fieldPath))
}

type deepAgentSpec struct {
	Kind              string
	Name              string
	Description       string
	Instruction       string
	EnableSkills      bool
	DisableWriteTodos bool
	ExtraHandlers     []adk.ChatModelAgentMiddleware
	ExtraTools        []tool.BaseTool
	ExtraToolsFactory func(config.ResolvedAgentToolSettings) ([]tool.BaseTool, error)
	ModelOutputGuard  func(context.Context, *adk.RetryContext) *adk.RetryDecision
}

func buildDeepAgent(ctx context.Context, cfg *config.Config, spec deepAgentSpec) (adk.Agent, error) {
	modelCfg := chatModelConfigForAgent(cfg, spec.Kind)
	toolSettings := config.ResolveAgentTools(cfg, spec.Kind)
	cm, err := openai.NewChatModel(ctx, &modelCfg)
	if err != nil {
		return nil, fmt.Errorf("创建模型失败: %w", err)
	}
	// providercompat 决定是否要为这个 provider 加包装层（修复工具调用格式、剥离内联 think 等）。
	// agent 包不感知具体 provider；新增 provider 的兼容性处理只需在 providercompat 里加。
	chatModel := providercompat.Wrap(cm, modelCfg)

	assembly, err := buildChatModelAgentAssembly(ctx, cfg, chatModelAgentAssemblySpec{
		Kind:              spec.Kind,
		ModelCfg:          modelCfg,
		ToolSettings:      toolSettings,
		EnableSkills:      spec.EnableSkills,
		ExtraHandlers:     spec.ExtraHandlers,
		ExtraTools:        spec.ExtraTools,
		ExtraToolsFactory: spec.ExtraToolsFactory,
		IncludeCompaction: true,
	})
	if err != nil {
		return nil, err
	}
	subAgents, err := buildConfiguredSubAgents(ctx, cfg, spec, toolSettings)
	if err != nil {
		return nil, err
	}

	return newDeepAgent(ctx, &deep.Config{
		Name:                   spec.Name,
		Description:            spec.Description,
		ChatModel:              chatModel,
		Instruction:            spec.Instruction,
		SubAgents:              subAgents,
		WithoutWriteTodos:      spec.DisableWriteTodos || !toolSettings.Todo,
		WithoutGeneralSubAgent: !config.GeneralSubAgentEnabled(cfg, spec.Kind),
		MaxIteration:           configMaxIteration(cfg),
		Handlers:               assembly.Handlers,
		ToolsConfig: adk.ToolsConfig{
			EmitInternalEvents: true,
			ToolsNodeConfig: compose.ToolsNodeConfig{
				Tools: assembly.Tools,
				// 当 LLM 幻觉出不存在的工具时，把错误信息以 ToolMessage 形式回传，
				// 让 Agent 在下一轮自行修正工具名或改用其他方案，避免整次任务被 NodeRunError 中断。
				UnknownToolsHandler: handleUnknownTool,
			},
		},
		ModelRetryConfig: modelRetryConfig(cfg, spec.ModelOutputGuard),
	})
}

type chatModelAgentAssemblySpec struct {
	Kind              string
	ToolPolicyKind    string
	ModelCfg          openai.ChatModelConfig
	ToolSettings      config.ResolvedAgentToolSettings
	EnableSkills      bool
	ExtraHandlers     []adk.ChatModelAgentMiddleware
	ExtraTools        []tool.BaseTool
	ExtraToolsFactory func(config.ResolvedAgentToolSettings) ([]tool.BaseTool, error)
	IncludeCompaction bool
}

type chatModelAgentAssembly struct {
	Tools    []tool.BaseTool
	Handlers []adk.ChatModelAgentMiddleware
}

func buildChatModelAgentAssembly(ctx context.Context, cfg *config.Config, spec chatModelAgentAssemblySpec) (chatModelAgentAssembly, error) {
	localBackend, err := localbk.NewBackend(ctx, &localbk.Config{})
	if err != nil {
		return chatModelAgentAssembly{}, fmt.Errorf("创建 backend 失败: %w", err)
	}
	workspace := ""
	if cfg != nil {
		workspace = cfg.Workspace
	}
	backend := newAgentFilesystemBackend(localBackend, workspace)
	executionGate := sharedToolExecutionGate(workspace)
	settings := spec.ToolSettings
	middlewares := []agenttools.MiddlewareRegistration{
		{
			Name:    "filesystem",
			Enabled: agenttools.FilesystemAllowed,
			Build: func(ctx context.Context, _ agenttools.Settings) (adk.ChatModelAgentMiddleware, error) {
				return newFilesystemMiddleware(ctx, backend, newAgentStreamingShell(workspace), spec.ToolSettings, workspace)
			},
		},
		{
			Name:    "skills",
			Enabled: agenttools.CapabilityAllowed(config.AgentToolSkills),
			Build: func(ctx context.Context, settings agenttools.Settings) (adk.ChatModelAgentMiddleware, error) {
				return newSkillMiddleware(ctx, cfg, spec.Kind, spec.EnableSkills, settings)
			},
		},
	}
	middlewares = append(middlewares, staticMiddlewareRegistrations("extra_handler", spec.ExtraHandlers)...)
	middlewares = append(middlewares,
		agenttools.MiddlewareRegistration{
			Name: "context_compaction",
			Enabled: func(agenttools.Settings) bool {
				return spec.IncludeCompaction
			},
			Build: func(context.Context, agenttools.Settings) (adk.ChatModelAgentMiddleware, error) {
				return &contextCompactionMiddleware{
					BaseChatModelAgentMiddleware: &adk.BaseChatModelAgentMiddleware{},
					agentKind:                    spec.Kind,
				}, nil
			},
		},
		agenttools.MiddlewareRegistration{
			Name: "tool_orchestrator",
			Build: func(context.Context, agenttools.Settings) (adk.ChatModelAgentMiddleware, error) {
				return &toolOrchestratorMiddleware{
					agentKind:           spec.Kind,
					policyKind:          firstNonEmpty(spec.ToolPolicyKind, spec.Kind),
					toolSettings:        spec.ToolSettings,
					enforceToolSettings: true,
					toolResultMaxBytes:  configToolResultMaxBytes(cfg),
					executionGate:       executionGate,
				}, nil
			},
		},
		agenttools.MiddlewareRegistration{
			Name: "model_input_logging",
			Build: func(context.Context, agenttools.Settings) (adk.ChatModelAgentMiddleware, error) {
				return &modelInputLoggingMiddleware{
					BaseChatModelAgentMiddleware: &adk.BaseChatModelAgentMiddleware{},
					agentKind:                    spec.Kind,
					config:                       spec.ModelCfg,
				}, nil
			},
		},
	)
	toolRegistrations := []agenttools.ToolRegistration{
		agenttools.StaticTools("extra_tools", spec.ExtraTools...),
	}
	if spec.ExtraToolsFactory != nil {
		toolRegistrations = append(toolRegistrations, agenttools.ToolRegistration{
			Name:  "extra_tools_factory",
			Build: spec.ExtraToolsFactory,
		})
	}
	toolRegistrations = append(toolRegistrations, agenttools.ToolRegistration{
		Name:    "web_search",
		Enabled: stableWebSearchSchemaAllowed(firstNonEmpty(spec.ToolPolicyKind, spec.Kind)),
		Build: func(agenttools.Settings) ([]tool.BaseTool, error) {
			return newWebSearchTools()
		},
	})
	assembly, err := agenttools.Build(ctx, agenttools.BuildRequest{
		Settings:    settings,
		Middlewares: middlewares,
		Tools:       toolRegistrations,
	})
	if err != nil {
		return chatModelAgentAssembly{}, err
	}
	return chatModelAgentAssembly{Tools: assembly.Tools, Handlers: assembly.Handlers}, nil
}

func staticMiddlewareRegistrations(prefix string, handlers []adk.ChatModelAgentMiddleware) []agenttools.MiddlewareRegistration {
	registrations := make([]agenttools.MiddlewareRegistration, 0, len(handlers))
	for i, handler := range handlers {
		handler := handler
		name := fmt.Sprintf("%s_%d", prefix, i+1)
		registrations = append(registrations, agenttools.MiddlewareRegistration{
			Name: name,
			Build: func(context.Context, agenttools.Settings) (adk.ChatModelAgentMiddleware, error) {
				return handler, nil
			},
		})
	}
	return registrations
}

func newSkillMiddleware(ctx context.Context, cfg *config.Config, agentKind string, enabled bool, settings agenttools.Settings) (adk.ChatModelAgentMiddleware, error) {
	if !enabled || !settings.Skills || cfg == nil {
		return nil, nil
	}
	skillBackend := novaskills.NewAgentBackend(
		novaskills.NewDirectories(cfg.SkillsDir, cfg.DataDir(), cfg.Workspace),
		agentKind,
		config.ResolveAgentSkillOverrides(cfg, agentKind),
	)
	availableSkills, listErr := skillBackend.List(ctx)
	if listErr != nil {
		log.Printf("[agent] 加载 Skills 列表失败 agent=%s err=%v", agentKind, listErr)
		return nil, nil
	}
	if len(availableSkills) == 0 {
		return nil, nil
	}
	skillMw, err := skill.NewMiddleware(ctx, &skill.Config{Backend: skillBackend})
	if err != nil {
		log.Printf("[agent] 创建 Skill middleware 失败 agent=%s err=%v", agentKind, err)
		return nil, nil
	}
	return skillMw, nil
}

func buildConfiguredSubAgents(ctx context.Context, cfg *config.Config, parent deepAgentSpec, parentTools config.ResolvedAgentToolSettings) ([]adk.Agent, error) {
	if cfg == nil || !config.IsDeepAgentParentKind(parent.Kind) {
		return nil, nil
	}
	subConfigs := config.SanitizeSubAgents(cfg.SubAgents)
	if len(subConfigs) == 0 {
		return nil, nil
	}
	subAgents := make([]adk.Agent, 0, len(subConfigs))
	for _, sub := range subConfigs {
		if !config.SubAgentAllowedForParent(sub, parent.Kind) {
			continue
		}
		subAgent, err := buildConfiguredSubAgent(ctx, cfg, parent, parentTools, sub)
		if err != nil {
			return nil, err
		}
		subAgents = append(subAgents, subAgent)
	}
	return subAgents, nil
}

func buildConfiguredSubAgent(ctx context.Context, cfg *config.Config, parent deepAgentSpec, parentTools config.ResolvedAgentToolSettings, sub config.SubAgentConfig) (adk.Agent, error) {
	modelCfg := chatModelConfigFromResolved(config.ResolveSubAgentModel(cfg, parent.Kind, sub))
	cm, err := openai.NewChatModel(ctx, &modelCfg)
	if err != nil {
		return nil, fmt.Errorf("创建子 Agent 模型失败 id=%s: %w", sub.ID, err)
	}
	subChatModel := providercompat.Wrap(cm, modelCfg)
	toolSettings := config.ResolveSubAgentTools(parentTools, sub.Tools)
	assembly, err := buildChatModelAgentAssembly(ctx, cfg, chatModelAgentAssemblySpec{
		Kind:              sub.ID,
		ToolPolicyKind:    parent.Kind,
		ModelCfg:          modelCfg,
		ToolSettings:      toolSettings,
		EnableSkills:      parent.EnableSkills,
		ExtraToolsFactory: parent.ExtraToolsFactory,
		IncludeCompaction: false,
	})
	if err != nil {
		return nil, err
	}
	return adk.NewChatModelAgent(ctx, &adk.ChatModelAgentConfig{
		Name:          sub.ID,
		Description:   sub.Description,
		Instruction:   buildSubAgentInstruction(parent, sub),
		Model:         subChatModel,
		MaxIterations: configMaxIteration(cfg),
		Handlers:      assembly.Handlers,
		ToolsConfig: adk.ToolsConfig{
			EmitInternalEvents: true,
			ToolsNodeConfig: compose.ToolsNodeConfig{
				Tools:               assembly.Tools,
				UnknownToolsHandler: handleUnknownTool,
			},
		},
		ModelRetryConfig: modelRetryConfig(cfg, nil),
	})
}

func modelRetryConfig(cfg *config.Config, outputGuard func(context.Context, *adk.RetryContext) *adk.RetryDecision) *adk.ModelRetryConfig {
	retryConfig := &adk.ModelRetryConfig{
		MaxRetries:  configModelMaxRetries(cfg),
		IsRetryAble: isTransientModelError,
	}
	if outputGuard == nil {
		return retryConfig
	}
	retryConfig.IsRetryAble = nil
	retryConfig.ShouldRetry = func(ctx context.Context, retryCtx *adk.RetryContext) *adk.RetryDecision {
		if retryCtx != nil && retryCtx.Err != nil {
			return &adk.RetryDecision{Retry: isTransientModelError(ctx, retryCtx.Err)}
		}
		return outputGuard(ctx, retryCtx)
	}
	return retryConfig
}

func isTransientModelError(_ context.Context, err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "429") ||
		strings.Contains(err.Error(), "Too Many Requests") ||
		strings.Contains(err.Error(), "qpm limit")
}

func buildSubAgentInstruction(parent deepAgentSpec, sub config.SubAgentConfig) string {
	var sb strings.Builder
	if parentInstruction := strings.TrimSpace(parent.Instruction); parentInstruction != "" {
		sb.WriteString(parentInstruction)
		sb.WriteString("\n\n---\n\n")
	}
	sb.WriteString("# SubAgent 专属说明\n\n")
	sb.WriteString("以下说明只限定当前 SubAgent 的职责、输出形态和工作偏好；不得覆盖父 Agent 的运行时契约、工具权限、workspace 边界、互动禁写规则、输出协议或后端校验。若与父 Agent system prompt 冲突，必须以父 Agent system prompt 为准。\n\n")
	if name := strings.TrimSpace(sub.Name); name != "" {
		sb.WriteString("- 名称：")
		sb.WriteString(name)
		sb.WriteString("\n")
	}
	if id := strings.TrimSpace(sub.ID); id != "" {
		sb.WriteString("- ID：")
		sb.WriteString(id)
		sb.WriteString("\n")
	}
	if description := strings.TrimSpace(sub.Description); description != "" {
		sb.WriteString("- 职责：")
		sb.WriteString(description)
		sb.WriteString("\n")
	}
	if prompt := strings.TrimSpace(sub.SystemPrompt); prompt != "" {
		sb.WriteString("\n## 专属系统提示\n\n")
		sb.WriteString(prompt)
	}
	return strings.TrimSpace(sb.String())
}

func loreToolsFactory(cfg *config.Config, forceReadOnly bool) func(config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
	return func(settings config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
		if cfg == nil || (!settings.LoreRead && !settings.LoreWrite) {
			return nil, nil
		}
		allowWrite := !forceReadOnly && settings.LoreWrite
		return newLoreTools(cfg.Workspace, allowWrite)
	}
}

func ideToolsFactory(cfg *config.Config) func(config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
	return func(_ config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
		if cfg == nil {
			return nil, nil
		}
		loreTools, err := newLoreTools(cfg.Workspace, true)
		if err != nil {
			return nil, err
		}
		imageTools, err := newIllustrationTools(cfg)
		if err != nil {
			return nil, err
		}
		tools := append([]tool.BaseTool{}, loreTools...)
		tools = append(tools, imageTools...)
		return tools, nil
	}
}

// ideToolsFactoryWithLibrary 是 library 背景模式的 IDE 工具工厂（B2a，§8.6 通道 2）：
// 不挂载旧 lore 工具（新旧设定不得叠加），改挂载持有本次绑定 Run 的库按需读取工具；
// 插图工具保持不变。libRun 为 nil 时退回旧工厂（防御性，正常由 BuildWithLibraryBackground 挡住）。
func ideToolsFactoryWithLibrary(cfg *config.Config, libRun *libraryruntime.Run) func(config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
	return func(_ config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
		if cfg == nil {
			return nil, nil
		}
		if libRun == nil {
			return ideToolsFactory(cfg)(config.ResolvedAgentToolSettings{})
		}
		libraryTools, err := newLibraryReadTools(libRun)
		if err != nil {
			return nil, err
		}
		imageTools, err := newIllustrationTools(cfg)
		if err != nil {
			return nil, err
		}
		tools := append([]tool.BaseTool{}, libraryTools...)
		tools = append(tools, imageTools...)
		return tools, nil
	}
}

// ideToolsFactoryNoBackground 是显式 none 背景模式的 IDE 工具工厂（B2a 修正轮）：
// 不挂载旧 lore 工具，也不挂载库读取工具；仅保留插图工具。
func ideToolsFactoryNoBackground(cfg *config.Config) func(config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
	return func(_ config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
		if cfg == nil {
			return nil, nil
		}
		return newIllustrationTools(cfg)
	}
}

func imageToolsFactory(cfg *config.Config) func(config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
	return func(_ config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
		if cfg == nil {
			return nil, nil
		}
		return newIllustrationTools(cfg)
	}
}

func interactiveStoryToolsFactory(cfg *config.Config, toolContexts ...InteractiveStoryToolContext) func(config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
	return func(_ config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
		var tools []tool.BaseTool
		if cfg != nil {
			loreTools, err := newLoreTools(cfg.Workspace, false)
			if err != nil {
				return nil, err
			}
			tools = append(tools, loreTools...)
		}
		if len(toolContexts) > 0 {
			historyTools, err := newInteractiveHistoryTools(toolContexts[0])
			if err != nil {
				return nil, err
			}
			tools = append(tools, historyTools...)
			stateSchemaTools, err := newInteractiveOpeningStateSchemaTools(toolContexts[0])
			if err != nil {
				return nil, err
			}
			tools = append(tools, stateSchemaTools...)
			turnTools, err := newInteractiveTurnTools(toolContexts[0])
			if err != nil {
				return nil, err
			}
			tools = append(tools, turnTools...)
		}
		return tools, nil
	}
}

// interactiveStoryToolsFactoryWithLibrary 是 library 背景模式的游戏回合工具工厂
// （B3a，§8.6 通道 2）：不挂载旧 lore 读写工具，改挂载持有本次绑定 Run 的
// read_library_item；历史/状态/回合工具保持一致。libRun 为 nil 时退回旧工厂
// （防御性，正常由 BuildInteractiveStoryWithLibraryBackground 挡住）。
func interactiveStoryToolsFactoryWithLibrary(cfg *config.Config, libRun *libraryruntime.Run, toolContexts ...InteractiveStoryToolContext) func(config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
	return func(_ config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
		if libRun == nil {
			return interactiveStoryToolsFactory(cfg, toolContexts...)(config.ResolvedAgentToolSettings{})
		}
		libraryTools, err := newLibraryReadTools(libRun)
		if err != nil {
			return nil, err
		}
		tools := append([]tool.BaseTool{}, libraryTools...)
		if len(toolContexts) > 0 {
			historyTools, err := newInteractiveHistoryTools(toolContexts[0])
			if err != nil {
				return nil, err
			}
			tools = append(tools, historyTools...)
			stateSchemaTools, err := newInteractiveOpeningStateSchemaTools(toolContexts[0])
			if err != nil {
				return nil, err
			}
			tools = append(tools, stateSchemaTools...)
			turnTools, err := newInteractiveTurnTools(toolContexts[0])
			if err != nil {
				return nil, err
			}
			tools = append(tools, turnTools...)
		}
		return tools, nil
	}
}

// interactiveStoryToolsFactoryNoBackground 是显式 none 背景模式的游戏回合工具工厂
// （B3a）：不挂载旧 lore 工具，也不挂载库读取工具；仅保留历史/状态/回合工具。
func interactiveStoryToolsFactoryNoBackground(cfg *config.Config, toolContexts ...InteractiveStoryToolContext) func(config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
	return func(_ config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
		if len(toolContexts) == 0 {
			return nil, nil
		}
		historyTools, err := newInteractiveHistoryTools(toolContexts[0])
		if err != nil {
			return nil, err
		}
		tools := append([]tool.BaseTool{}, historyTools...)
		stateSchemaTools, err := newInteractiveOpeningStateSchemaTools(toolContexts[0])
		if err != nil {
			return nil, err
		}
		tools = append(tools, stateSchemaTools...)
		turnTools, err := newInteractiveTurnTools(toolContexts[0])
		if err != nil {
			return nil, err
		}
		return append(tools, turnTools...), nil
	}
}

func interactiveDirectorToolsFactory(cfg *config.Config, toolContexts ...InteractiveStoryToolContext) func(config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
	return func(settings config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
		var tools []tool.BaseTool
		var storyToolContext InteractiveStoryToolContext
		if len(toolContexts) > 0 {
			storyToolContext = toolContexts[0]
		}
		// B3a（§8.6 通道 4）：library / 显式 none 背景模式下，后台导演不挂载旧
		// lore 工具——旧资料库不参与本故事，规划只依据注入的规划上下文。
		if cfg != nil && settings.LoreRead && !storyToolContext.NoLegacyLore {
			var options []loreToolsOptions
			switch strings.TrimSpace(storyToolContext.MaintenanceTask) {
			case "director_plan_update", "opening_plan":
				policy := defaultLoreReadPolicy()
				policy.OnRead = storyToolContext.OnLoreItemsRead
				options = append(options, loreToolsOptions{ReadPolicy: policy})
			}
			loreTools, err := newLoreTools(cfg.Workspace, false, options...)
			if err != nil {
				return nil, err
			}
			tools = append(tools, loreTools...)
		}
		if len(toolContexts) == 0 {
			return tools, nil
		}
		ctx := storyToolContext
		switch strings.TrimSpace(ctx.MaintenanceTask) {
		case "director_plan_update", "opening_plan":
			historyTools, err := newInteractiveHistoryTools(ctx)
			if err != nil {
				return nil, err
			}
			eventTools, err := newInteractiveEventTools(ctx)
			if err != nil {
				return nil, err
			}
			planTools, err := newInteractiveDirectorPlanTools(ctx)
			tools = append(tools, historyTools...)
			tools = append(tools, eventTools...)
			return append(tools, planTools...), err
		default:
			return tools, nil
		}
	}
}

func configManagerToolsFactory(cfg *config.Config) func(config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
	return func(settings config.ResolvedAgentToolSettings) ([]tool.BaseTool, error) {
		if cfg == nil {
			return nil, nil
		}
		if !configManagerFactoryAllowed(settings) {
			return nil, nil
		}
		configTools, err := newConfigManagerTools(cfg, settings)
		if err != nil {
			return nil, err
		}
		return configTools, nil
	}
}

func configManagerFactoryAllowed(settings config.ResolvedAgentToolSettings) bool {
	return settings.LoreRead ||
		settings.LoreWrite ||
		settings.Todo ||
		settings.Skills ||
		settings.AgentConfigRead ||
		settings.AgentConfigWrite
}

func newFilesystemMiddleware(ctx context.Context, backend filesystem.Backend, streamingShell filesystem.StreamingShell, settings config.ResolvedAgentToolSettings, workspaces ...string) (adk.ChatModelAgentMiddleware, error) {
	if backend == nil {
		return nil, nil
	}
	if !settings.FileRead && !settings.FileWrite && !settings.ShellExecute {
		return nil, nil
	}
	workspace := ""
	if len(workspaces) > 0 {
		workspace = strings.TrimSpace(workspaces[0])
	}
	readTool, err := newWorkspaceReadFileTool(backend, workspace)
	if err != nil {
		return nil, fmt.Errorf("创建 read_file 工具失败: %w", err)
	}
	readToolConfig := &filesystemmw.ToolConfig{CustomTool: readTool}
	writeToolConfig := &filesystemmw.ToolConfig{}
	editToolConfig := &filesystemmw.ToolConfig{}
	if workspace != "" && settings.FileWrite {
		changes, err := workspacechange.ForWorkspace(workspace)
		if err != nil {
			return nil, fmt.Errorf("创建 workspace change service 失败: %w", err)
		}
		writeTool, err := newWorkspaceWriteFileTool(changes)
		if err != nil {
			return nil, fmt.Errorf("创建 write_file 工具失败: %w", err)
		}
		editTool, err := newWorkspaceEditFileTool(changes)
		if err != nil {
			return nil, fmt.Errorf("创建 edit_file 工具失败: %w", err)
		}
		writeToolConfig.CustomTool = writeTool
		editToolConfig.CustomTool = editTool
	}
	mwConfig := &filesystemmw.MiddlewareConfig{
		Backend:             backend,
		LsToolConfig:        &filesystemmw.ToolConfig{},
		ReadFileToolConfig:  readToolConfig,
		GlobToolConfig:      &filesystemmw.ToolConfig{},
		GrepToolConfig:      &filesystemmw.ToolConfig{},
		WriteFileToolConfig: writeToolConfig,
		EditFileToolConfig:  editToolConfig,
	}
	if streamingShell != nil {
		mwConfig.StreamingShell = streamingShell
	}
	return filesystemmw.New(ctx, mwConfig)
}

func stableWebSearchSchemaAllowed(agentKind string) func(config.ResolvedAgentToolSettings) bool {
	return func(settings config.ResolvedAgentToolSettings) bool {
		if settings.WebSearch {
			return true
		}
		switch agentKind {
		case config.AgentKindIDE, config.AgentKindInteractiveStory, config.AgentKindConfigManager, config.AgentKindAutomation:
			return true
		default:
			return false
		}
	}
}

func configMaxIteration(cfg *config.Config) int {
	if cfg == nil || cfg.MaxIteration <= 0 {
		return unlimitedAgentMaxIterations
	}
	return cfg.MaxIteration
}

func configModelMaxRetries(cfg *config.Config) int {
	if cfg == nil || cfg.ModelMaxRetries < 0 {
		return 5
	}
	return cfg.ModelMaxRetries
}

func configToolResultMaxBytes(cfg *config.Config) int {
	if cfg == nil || cfg.AgentToolResultLimitKB <= 0 {
		return defaultToolResultMaxBytes
	}
	return cfg.AgentToolResultLimitKB * 1024
}

// handleUnknownTool 拦截 LLM 调用未知工具的错误，把可读提示作为工具结果回传给模型，
// 引导 Agent 在后续轮次基于该反馈自我修正（例如改用正确的工具名）。
func handleUnknownTool(_ context.Context, name, input string) (string, error) {
	log.Printf("[agent] LLM 调用了不存在的工具 name=%s args=%s", name, input)
	return prompts.UnknownToolMessage(name), nil
}
