package prompts

import (
	"strings"
	"testing"
)

// B3a：游戏链三列背景模式替换守护（§8.6 通道 1/3/4）。
// legacy 列必须与基线逐字节一致（旧请求兼容）；library/none 列不得残留旧 lore
// 工具指引，必须携带对应模式的召回/落地/边界语义。

func TestInteractiveStoryTurnInstructionLegacyByteCompat(t *testing.T) {
	message, turnContext, runtimeContext := "我推门进入", "导演规则", "[本轮动态上下文]"
	if got := InteractiveStoryTurnInstructionWithBackground(message, turnContext, runtimeContext, BackgroundModeDefault); got != InteractiveStoryTurnInstruction(message, turnContext, runtimeContext) {
		t.Fatal("legacy turn instruction must stay byte-identical to the baseline call")
	}
}

func TestInteractiveStoryTurnInstructionLibraryModeReplacesLoreGuidance(t *testing.T) {
	library := InteractiveStoryTurnInstructionWithBackground("我拔剑", "", "上下文", BackgroundModeLibrary)
	for _, want := range []string{"read_library_item", "设定库没有匹配条目时", "不得凭摘要补全设定"} {
		if !strings.Contains(library, want) {
			t.Fatalf("library turn instruction missing %q:\n%s", want, library)
		}
	}
	for _, forbidden := range []string{"read_lore_items", "list_lore_items", "lore-context.md"} {
		if strings.Contains(library, forbidden) {
			t.Fatalf("library turn instruction must not reference legacy lore channel %q:\n%s", forbidden, library)
		}
	}
	// none 模式：回合指令不再携带任何落地/召回指引（该语义在系统指令与运行时
	// 上下文中分别守护）。
	none := InteractiveStoryTurnInstructionWithBackground("我拔剑", "", "上下文", BackgroundModeNone)
	if strings.Contains(none, "read_library_item") || strings.Contains(none, "read_lore_items") || strings.Contains(none, "list_lore_items") {
		t.Fatalf("none turn instruction must not reference any lore channel:\n%s", none)
	}
}

func TestInteractiveStorySystemInstructionBackgroundModes(t *testing.T) {
	base := InteractiveStorySystemInstructionInput{ChoiceCount: 3}
	legacy := BuildInteractiveStorySystemInstruction(base)
	for _, want := range []string{"read_lore_items", "list_lore_items"} {
		if !strings.Contains(legacy, want) {
			t.Fatalf("legacy system instruction must keep lore tool guidance %q", want)
		}
	}
	library := BuildInteractiveStorySystemInstruction(InteractiveStorySystemInstructionInput{ChoiceCount: 3, BackgroundMode: BackgroundModeLibrary})
	if !strings.Contains(library, "read_library_item") || strings.Contains(library, "read_lore_items") || strings.Contains(library, "list_lore_items") {
		t.Fatalf("library system instruction must swap lore tools for read_library_item:\n%s", library)
	}
	none := BuildInteractiveStorySystemInstruction(InteractiveStorySystemInstructionInput{ChoiceCount: 3, BackgroundMode: BackgroundModeNone})
	if strings.Contains(none, "read_library_item") || strings.Contains(none, "read_lore_items") {
		t.Fatalf("none system instruction must mount no background tools:\n%s", none)
	}
}

func TestInteractiveStoryRuntimeContextBackgroundNoteAndLoreBlock(t *testing.T) {
	legacy := InteractiveStoryRuntimeContext(InteractiveStoryPromptInput{})
	if !strings.Contains(legacy, "lore-context.md 当前区段的按需正文在下方提供") {
		t.Fatalf("legacy runtime context must keep the baseline recall note:\n%s", legacy)
	}
	library := InteractiveStoryRuntimeContext(InteractiveStoryPromptInput{BackgroundMode: BackgroundModeLibrary})
	if !strings.Contains(library, "read_library_item 按需读取") {
		t.Fatalf("library runtime context must point at read_library_item:\n%s", library)
	}
	if strings.Contains(library, "规则与当前资料工作集") {
		t.Fatal("library runtime context with empty lore must not emit the legacy lore block")
	}
	none := InteractiveStoryRuntimeContext(InteractiveStoryPromptInput{BackgroundMode: BackgroundModeNone})
	if !strings.Contains(none, "显式声明无作品背景") {
		t.Fatalf("none runtime context must declare no background:\n%s", none)
	}
}

func TestInteractiveDirectorSystemInstructionBackgroundModes(t *testing.T) {
	if BuildInteractiveDirectorSystemInstruction() != BuildInteractiveDirectorSystemInstructionWithBackground(BackgroundModeDefault) {
		t.Fatal("legacy director instruction must stay byte-identical to the baseline call")
	}
	legacy := BuildInteractiveDirectorSystemInstruction()
	for _, want := range []string{"read_lore_items", "list_lore_items", "lore-context.md 是当前分支资料工作集"} {
		if !strings.Contains(legacy, want) {
			t.Fatalf("legacy director instruction missing %q", want)
		}
	}
	library := BuildInteractiveDirectorSystemInstructionWithBackground(BackgroundModeLibrary)
	if !strings.Contains(library, "设定真源是绑定的作品设定库") || !strings.Contains(library, "lore-context.md 与旧资料库不参与本故事") {
		t.Fatalf("library director instruction must declare the library boundary:\n%s", library)
	}
	for _, forbidden := range []string{"read_lore_items", "list_lore_items", "资料名称目录"} {
		if strings.Contains(library, forbidden) {
			t.Fatalf("library director instruction must not keep legacy lore guidance %q", forbidden)
		}
	}
	none := BuildInteractiveDirectorSystemInstructionWithBackground(BackgroundModeNone)
	if !strings.Contains(none, "显式无作品背景模式") {
		t.Fatalf("none director instruction must declare no background:\n%s", none)
	}
}

func TestInteractiveDirectorInstructionBackgroundModes(t *testing.T) {
	base := InteractiveDirectorPromptInput{Title: "测试故事"}
	legacy := InteractiveDirectorInstruction(base)
	if !strings.Contains(legacy, "lore-context.md 仍然按需") {
		t.Fatal("legacy director instruction must keep lore-context maintenance guidance")
	}
	library := InteractiveDirectorInstruction(InteractiveDirectorPromptInput{Title: "测试故事", BackgroundMode: BackgroundModeLibrary})
	if strings.Contains(library, "lore-context.md 仍然按需") || strings.Contains(library, "list_lore_items") {
		t.Fatalf("library director instruction must gate out lore maintenance:\n%s", library)
	}
	if !strings.Contains(library, "资料工作集边界") {
		t.Fatalf("library director instruction must include the workset boundary section:\n%s", library)
	}
}
