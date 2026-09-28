package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/cloudwego/eino/schema"

	"denova/config"
	"denova/internal/book"
	"denova/internal/session"
)

// B2a 修正轮验证（缺口①/②）：
//   - 旧 Lore 注入三通道（系统提示 StateContext、稳定上下文片段、工具指引）在
//     library / 显式 none 模式全关；legacy（缺省/未声明）与基线逐字节兼容；
//   - 计费/审计使用的 SystemPromptLog 与 runner 实际系统提示来自同一 composition；
//   - 最终模型消息（系统提示 + 稳定上下文消息 + 头部库背景 + 会话历史）无旧 Lore。

// newLoreFixtureState 构造一个带旧资料库条目的真实 book.State（lore 片段进入稳定上下文
// 与系统提示 StateContext），作为旧 Lore 注入存在的有效性证明。
func newLoreFixtureState(t *testing.T) *book.State {
	t.Helper()
	workspace := t.TempDir()
	store := book.NewLoreStore(workspace)
	if _, err := store.Create(book.LoreItemInput{
		ID:               "hero",
		Type:             "character",
		Name:             "林川",
		Importance:       "major",
		BriefDescription: "角色 林川。谨慎的幸存者。",
		Content:          "档案柜线索只存在于正文。",
	}); err != nil {
		t.Fatal(err)
	}
	return book.NewState(workspace)
}

// 1) 模式组合：legacy 与默认 composition 逐字节一致；library/none 排除 lore 片段
//（StateContext 与审计 stateParts），工具指引按模式替换；同源文本断言守护缺口②
//（旧缺陷：RunOptions.SystemPromptLog 恒传默认 composition）。
func TestBackgroundInstructionCompositionByMode(t *testing.T) {
	state := newLoreFixtureState(t)
	cfg := &config.Config{Workspace: state.Workspace()}
	teller := IDEStoryTeller{}

	legacy := BuildBackgroundInstructionComposition(cfg, state, teller, BackgroundModeLegacy)
	defaultComp := BuildInstructionComposition(cfg, state, teller)
	if legacy.Instruction() != defaultComp.Instruction() {
		t.Fatal("legacy（缺省/未声明）composition 必须与默认 BuildInstructionComposition 逐字节一致（旧请求兼容）")
	}
	if !strings.Contains(legacy.Instruction(), "read_lore_items") {
		t.Fatal("legacy 指引必须保留旧 lore 工具（旧请求兼容）")
	}
	// 通道①断言面：StateContext/stateParts 在 composition 审计组成中保留旧 lore（fixture 有效性）。
	if !strings.Contains(legacy.stateContext, "林川") {
		t.Fatal("legacy composition 的 StateContext 必须保留旧 lore（fixture 有效性）")
	}
	var legacyHasLorePart bool
	for _, part := range legacy.stateParts {
		if part.ID == "lore" {
			legacyHasLorePart = true
		}
	}
	if !legacyHasLorePart {
		t.Fatal("legacy 审计 stateParts 必须包含 lore 片段（fixture 有效性）")
	}

	library := BuildBackgroundInstructionComposition(cfg, state, teller, BackgroundModeLibrary)
	// 缺口②同源守护：library 模式的 composition 就是库模式系统提示本身。
	if library.Instruction() != BuildLibraryBackgroundInstruction(cfg, state, teller) {
		t.Fatal("library composition.Instruction() 必须与 BuildLibraryBackgroundInstruction 同源")
	}
	if library.Instruction() == defaultComp.Instruction() {
		t.Fatal("library 模式计费文本不得回落到默认 composition（缺口②回归：SystemPromptLog 必须是库模式提示）")
	}
	for _, banned := range []string{"read_lore_items", "list_lore_items", "write_lore_items"} {
		if strings.Contains(library.Instruction(), banned) {
			t.Fatalf("library 指引不得引用旧 lore 工具 %q", banned)
		}
	}
	if !strings.Contains(library.Instruction(), "read_library_item") {
		t.Fatal("library 指引必须包含 read_library_item")
	}
	// 通道①：StateContext 与审计 stateParts 排除旧 lore（提示审计与实际送模一致）。
	if strings.Contains(library.stateContext, "林川") {
		t.Fatal("library StateContext 必须排除旧 lore")
	}
	for _, part := range library.stateParts {
		if part.ID == "lore" {
			t.Fatal("library 审计 stateParts 必须排除 lore 片段（提示审计与实际送模一致）")
		}
		if strings.Contains(part.Content, "林川") {
			t.Fatalf("library stateParts 片段 %s 泄漏旧 lore 正文", part.ID)
		}
	}

	none := BuildBackgroundInstructionComposition(cfg, state, teller, BackgroundModeNone)
	for _, banned := range []string{"read_lore_items", "list_lore_items", "write_lore_items", "read_library_item"} {
		if strings.Contains(none.Instruction(), banned) {
			t.Fatalf("显式 none 指引不得引用任何背景读取工具 %q", banned)
		}
	}
	if !strings.Contains(none.Instruction(), "本轮写作未启用任何作品背景") {
		t.Fatal("显式 none 指引必须替换为无背景语义")
	}
	if strings.Contains(none.stateContext, "林川") {
		t.Fatal("显式 none StateContext 必须排除旧 lore")
	}
	for _, part := range none.stateParts {
		if part.ID == "lore" {
			t.Fatal("显式 none 审计 stateParts 必须排除 lore 片段")
		}
	}
}

// 2) 最终模型消息：library / 显式 none 模式下（系统提示 + 排除 lore 的稳定上下文
// + 头部库背景 + 会话历史装配）不含任何旧 Lore；legacy 模式保留旧 Lore（兼容对照）。
func TestFinalModelMessagesExcludeLegacyLoreInNewBackgroundModes(t *testing.T) {
	state := newLoreFixtureState(t)
	cfg := &config.Config{}
	req := ChatRequest{Message: "继续写"}

	// legacy（未声明）：稳定上下文含旧 lore——fixture 有效性。
	legacyContexts := IDEWorkspaceRuntimeContextsForRequest(state, req)
	if !strings.Contains(legacyContexts.Stable, "林川") {
		t.Fatalf("legacy 稳定上下文必须含旧 lore（fixture 有效性）: %q", legacyContexts.Stable)
	}
	// library / 显式 none：稳定上下文排除旧 lore（通道 ②）。
	newContexts := IDEWorkspaceRuntimeContextsForRequestExcludingLore(state, req)
	if strings.Contains(newContexts.Stable, "林川") || strings.Contains(newContexts.Dynamic, "林川") {
		t.Fatalf("新背景模式稳定/动态上下文不得叠加旧 lore: stable=%q dynamic=%q", newContexts.Stable, newContexts.Dynamic)
	}

	store, err := session.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sess, err := store.GetOrCreate("default")
	if err != nil {
		t.Fatal(err)
	}
	if err := sess.Append(schema.UserMessage("上一轮用户请求")); err != nil {
		t.Fatal(err)
	}

	// 与 chat.go 同构的最终装配：头部库背景 + 历史（含稳定上下文消息）。
	lib := NewEphemeralLibraryContextInput(testLibraryLeadingText)
	assembled := func(contexts IDEWorkspaceRuntimeContexts) []*schema.Message {
		conversation := NewSessionConversationForAgentWithRuntimeContexts(
			sess,
			cfg,
			config.AgentKindIDE,
			contexts.StableTitle,
			contexts.Stable,
			contexts.DynamicTitle,
			contexts.Dynamic,
		)
		history, err := conversation.PrepareMessages("继续写", "继续写")
		if err != nil {
			t.Fatal(err)
		}
		return ModelInputMessagesWithLibrary(history, EphemeralWorldContextInput{}, lib)
	}

	// 新背景模式：最终模型消息全程无旧 Lore（系统提示见上一下测试，此处为消息装配面）。
	for _, m := range assembled(newContexts) {
		if strings.Contains(m.Content, "林川") || strings.Contains(m.Content, "read_lore_items") {
			t.Fatalf("library/显式 none 最终模型消息不得含旧 lore: %#v", m)
		}
	}
	// 兼容对照：legacy 模式最终模型消息确实携带旧 lore（旧请求行为不变）。
	sawLore := false
	for _, m := range assembled(legacyContexts) {
		if strings.Contains(m.Content, "林川") {
			sawLore = true
		}
	}
	if !sawLore {
		t.Fatal("legacy 最终模型消息必须保留旧 lore（旧请求兼容对照）")
	}
}

// 3) 单源构建器契约：显式 none 必须提供单源系统提示（空串显式报错）；
// library 模式空 instruction 防御性回退自建；nil libRun 回退 Build。
func TestBackgroundBuildersInstructionContract(t *testing.T) {
	state := newLoreFixtureState(t)
	cfg := &config.Config{Workspace: state.Workspace()}

	if _, err := BuildWithNoBackground(context.Background(), cfg, ""); err == nil {
		t.Fatal("显式 none 空系统提示必须显式报错（无回退路径）")
	}
	ag, err := BuildWithNoBackground(context.Background(), cfg, "系统提示")
	if err != nil || ag == nil {
		t.Fatalf("BuildWithNoBackground 必须以单源提示构建: err=%v ag=%v", err, ag)
	}

	run, _ := newLibraryToolTestRun(t)
	defer run.Complete()
	// 空 instruction → 防御性回退自建 library 提示（不空提示送模）。
	built, err := BuildWithLibraryBackground(context.Background(), cfg, state, IDEStoryTeller{}, "", run)
	if err != nil || built == nil {
		t.Fatalf("BuildWithLibraryBackground 空 instruction 必须回退: err=%v", err)
	}
	// nil libRun → 回退默认 Build（既有语义）。
	fallback, err := BuildWithLibraryBackground(context.Background(), cfg, state, IDEStoryTeller{}, "", nil)
	if err != nil || fallback == nil {
		t.Fatalf("BuildWithLibraryBackground nil libRun 必须回退 Build: err=%v", err)
	}
	// 计费通道量测公式与单源提示一致：chargeLibraryRuntimeInputCost 的入量正是
	// composition.Instruction()（缺口②：计费文本 == 实际提示）。
	comp := BuildBackgroundInstructionComposition(cfg, state, IDEStoryTeller{}, BackgroundModeLibrary)
	charger := &fakeCostCharger{}
	history := []*schema.Message{schema.UserMessage("继续写")}
	if err := chargeLibraryRuntimeInputCost(charger, comp.Instruction(), history); err != nil {
		t.Fatal(err)
	}
	if len(charger.calls) != 1 || charger.calls[0].bytes <= len(comp.Instruction()) {
		t.Fatalf("计费必须覆盖单源系统提示: %+v", charger.calls)
	}
}
