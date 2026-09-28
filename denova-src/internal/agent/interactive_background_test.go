package agent

import (
	"context"
	"errors"
	"strings"
	"testing"

	"denova/config"
	"denova/internal/library"
	"denova/internal/libraryruntime"
	"denova/internal/prompts"
)

// B3a：游戏链背景模式的工具工厂与 builder 契约守护（§8.6 通道 2/4）。
// legacy 工厂必须保留旧 lore 工具；library 工厂必须换成持有绑定 Run 的
// read_library_item；显式 none 不得挂任何背景工具；builder 的单源 instruction
// 契约与空串显式报错路径在此锁定。

// interactiveBackgroundLibraryRun 用最小假 provider 构造一个真实 libraryruntime.Run
// （工具工厂只需要 Run 身份与读取入口，不需要 app 层）。
func interactiveBackgroundLibraryRun(t *testing.T) *libraryruntime.Run {
	t.Helper()
	provider := func(_ context.Context, id string) (library.Library, string, error) {
		if id != "lib000000000099" {
			return library.Library{}, "", errors.New("unknown library")
		}
		return library.Library{
			ID:   "lib000000000099",
			Name: "游戏绑定测试库",
			Items: []library.Item{
				{ID: "item-resident", Enabled: true, Type: "character", Name: "常驻一", LoadMode: library.LoadModeResident, Origin: library.OriginOriginal, Content: "常驻正文", Fields: map[string]string{}},
				{ID: "item-manual", Enabled: true, Type: "character", Name: "手动一", LoadMode: library.LoadModeManual, Origin: library.OriginOriginal, Content: "手动正文", Fields: map[string]string{}},
			},
		}, "rev-game-1", nil
	}
	run, err := libraryruntime.Bind(context.Background(), libraryruntime.BindInput{
		Consumer:         libraryruntime.ConsumerGame,
		ScopeKey:         "story:s1|branch:main|run:test",
		LibraryID:        "lib000000000099",
		ExpectedRevision: "rev-game-1",
	}, provider, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { run.Cancel() })
	return run
}

func interactiveBackgroundTurnContext() InteractiveStoryToolContext {
	return InteractiveStoryToolContext{Store: nil, StoryID: "s1", BranchID: "main"}
}

func TestInteractiveStoryToolsFactoryKeepsLegacyLoreTools(t *testing.T) {
	factory := interactiveStoryToolsFactory(&config.Config{Workspace: t.TempDir()}, interactiveBackgroundTurnContext())
	tools, err := factory(config.ResolvedAgentToolSettings{})
	if err != nil {
		t.Fatal(err)
	}
	names := configManagerToolNameSet(t, tools)
	if !names["read_lore_items"] || !names["list_lore_items"] {
		t.Fatalf("legacy factory must keep lore tools: %v", names)
	}
	if names["read_library_item"] {
		t.Fatalf("legacy factory must not mount read_library_item: %v", names)
	}
}

func TestInteractiveStoryToolsFactoryWithLibrarySwapsLoreForLibraryTool(t *testing.T) {
	run := interactiveBackgroundLibraryRun(t)
	factory := interactiveStoryToolsFactoryWithLibrary(&config.Config{Workspace: t.TempDir()}, run, interactiveBackgroundTurnContext())
	tools, err := factory(config.ResolvedAgentToolSettings{})
	if err != nil {
		t.Fatal(err)
	}
	names := configManagerToolNameSet(t, tools)
	if !names["read_library_item"] {
		t.Fatalf("library factory must mount read_library_item: %v", names)
	}
	for _, forbidden := range []string{"read_lore_items", "list_lore_items", "write_lore_items"} {
		if names[forbidden] {
			t.Fatalf("library factory must not mount lore tool %q: %v", forbidden, names)
		}
	}
}

func TestInteractiveStoryToolsFactoryNoBackgroundMountsNeither(t *testing.T) {
	factory := interactiveStoryToolsFactoryNoBackground(&config.Config{Workspace: t.TempDir()}, interactiveBackgroundTurnContext())
	tools, err := factory(config.ResolvedAgentToolSettings{})
	if err != nil {
		t.Fatal(err)
	}
	names := configManagerToolNameSet(t, tools)
	for _, forbidden := range []string{"read_library_item", "read_lore_items", "list_lore_items"} {
		if names[forbidden] {
			t.Fatalf("explicit none factory must not mount %q: %v", forbidden, names)
		}
	}
}

func TestInteractiveDirectorToolsFactoryHonorsNoLegacyLore(t *testing.T) {
	cfg := &config.Config{Workspace: t.TempDir()}
	legacyTools, err := interactiveDirectorToolsFactory(cfg, InteractiveStoryToolContext{MaintenanceTask: "director_plan_update"})(config.ResolvedAgentToolSettings{LoreRead: true})
	if err != nil {
		t.Fatal(err)
	}
	if names := configManagerToolNameSet(t, legacyTools); !names["read_lore_items"] {
		t.Fatalf("legacy director factory must keep lore tools: %v", names)
	}
	libraryTools, err := interactiveDirectorToolsFactory(cfg, InteractiveStoryToolContext{MaintenanceTask: "director_plan_update", NoLegacyLore: true, BackgroundMode: prompts.BackgroundModeLibrary})(config.ResolvedAgentToolSettings{LoreRead: true})
	if err != nil {
		t.Fatal(err)
	}
	if names := configManagerToolNameSet(t, libraryTools); names["read_lore_items"] || names["read_library_item"] {
		t.Fatalf("library director factory must mount no background tools: %v", names)
	}
}

func TestBuildInteractiveStoryBackgroundBuildersContract(t *testing.T) {
	ctx := context.Background()
	cfg := &config.Config{Workspace: t.TempDir()}
	run := interactiveBackgroundLibraryRun(t)

	// nil libRun 防御性退回 legacy builder（正常由 app 层挡住）。
	if _, err := BuildInteractiveStoryWithLibraryBackground(ctx, cfg, nil, prompts.InteractiveStorySystemInstructionInput{}, "单源提示", nil, interactiveBackgroundTurnContext()); err != nil {
		t.Fatalf("nil libRun must fall back to legacy builder: %v", err)
	}
	// 单源 instruction 空串显式报错：library 模式没有可回退的自建提示路径。
	if _, err := BuildInteractiveStoryWithLibraryBackground(ctx, cfg, nil, prompts.InteractiveStorySystemInstructionInput{}, "  ", run, interactiveBackgroundTurnContext()); err == nil || !strings.Contains(err.Error(), "单源系统提示") {
		t.Fatalf("library builder with blank instruction must fail explicitly: %v", err)
	}
	if _, err := BuildInteractiveStoryWithNoBackground(ctx, cfg, nil, prompts.InteractiveStorySystemInstructionInput{}, "", interactiveBackgroundTurnContext()); err == nil || !strings.Contains(err.Error(), "单源系统提示") {
		t.Fatalf("none builder with blank instruction must fail explicitly: %v", err)
	}
	// 正常构建（真实绑定 Run + 单源提示 / 显式 none）。
	if _, err := BuildInteractiveStoryWithLibraryBackground(ctx, cfg, nil, prompts.InteractiveStorySystemInstructionInput{}, "单源提示", run, interactiveBackgroundTurnContext()); err != nil {
		t.Fatalf("library builder build failed: %v", err)
	}
	if _, err := BuildInteractiveStoryWithNoBackground(ctx, cfg, nil, prompts.InteractiveStorySystemInstructionInput{}, "单源提示", interactiveBackgroundTurnContext()); err != nil {
		t.Fatalf("none builder build failed: %v", err)
	}
	// legacy 基线仍可构建。
	if _, err := BuildInteractiveStory(ctx, cfg, nil, prompts.InteractiveStorySystemInstructionInput{}, interactiveBackgroundTurnContext()); err != nil {
		t.Fatalf("legacy builder build failed: %v", err)
	}
}
