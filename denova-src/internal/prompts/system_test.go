package prompts

import (
	"strings"
	"testing"
)

func TestSystemInstructionRequiresIdeasAndCreatorDuringIdeation(t *testing.T) {
	instruction := BuildSystemInstruction(SystemInstructionInput{
		Workspace: "/tmp/book",
	})

	for _, required := range []string{
		"/tmp/book/CREATOR.md",
		"/tmp/book/ideas.md",
		"新书构思阶段也必须基于模板和作者确认更新",
		"先 read_file ideas.md 和 CREATOR.md",
		"阶段性结论和待确认点",
		"CREATOR.md 负责“这本书长期怎么写、哪些规则必须一直遵守”",
		"每章字数/篇幅目标",
		"及时 edit_file 或 write_file 更新 ideas.md",
		"先分别 write_file 更新 ideas.md 和 CREATOR.md",
		"ideas.md 继续作为方向指引",
		"CREATOR.md 继续作为每轮最高优先级创作者指令生效",
		"内容保持短小、可扫读、方便作者评论和后续更新",
		"建议控制在 800-1200 个中文字内",
		"每章安排只写 3-5 条关键点",
		"ch{order:05}-{chapter}-{title}.md",
		"v{order:05}-{volume}",
		"不要自动重命名旧章节",
	} {
		if !strings.Contains(instruction, required) {
			t.Fatalf("系统提示缺少 %q:\n%s", required, instruction)
		}
	}
	if strings.Contains(instruction, "# 当前作品状态") {
		t.Fatalf("系统提示不应直接注入动态作品状态:\n%s", instruction)
	}
}

func TestIDEWritingFlowKeepsChapterStatusIndependentFromStateSync(t *testing.T) {
	instruction := BuildIDEWritingFlowInstruction(SystemInstructionInput{
		Workspace: "/tmp/book",
	})

	for _, required := range []string{
		"章节创作 -> 同步进度与角色状态",
		"章节正文直接写入 chapters/",
		"非空未确认章节可在 UI 中显示为初稿",
		"章节状态只是编辑标记",
		"不影响下一章判断、上下文选择或状态同步",
		"write_file 到 chapters/",
		"在同一轮更新 setting/progress.md 和 setting/character-states.md",
		"不等待作者另行确认成章",
	} {
		if !strings.Contains(instruction, required) {
			t.Fatalf("写作流程提示缺少 %q:\n%s", required, instruction)
		}
	}
	for _, forbidden := range []string{
		"草稿" + "流程",
		"draft" + "s/",
		"Draft" + "Flow",
		"章节草稿应先写入",
		"普通初稿不写入全书事实状态",
		"只有作者明确确认成章",
	} {
		if strings.Contains(instruction, forbidden) {
			t.Fatalf("写作流程提示不应包含旧草稿目录流程 %q:\n%s", forbidden, instruction)
		}
	}
	if strings.Contains(instruction, "%!(EXTRA") {
		t.Fatalf("写作流程提示存在多余 fmt 参数:\n%s", instruction)
	}
}

// TestBuildIDEWritingFlowInstructionBackgroundModesReplaceLoreGuidance 守护
// §8.6 通道 3 与 B2a 修正轮：library / 显式 none 背景模式下旧 lore 工具指引整段替换；
// 同时守护替换表 legacy 列与 systemInstructionBody 逐字节同步（默认模式必须包含每个旧片段）。
func TestBuildIDEWritingFlowInstructionBackgroundModesReplaceLoreGuidance(t *testing.T) {
	in := SystemInstructionInput{Workspace: "/tmp/book"}
	defaultFlow := BuildIDEWritingFlowInstruction(in)
	for i, row := range loreBackgroundGuidanceRows {
		if !strings.Contains(defaultFlow, row.legacy) {
			t.Fatalf("guidance row %d legacy column is out of sync with systemInstructionBody; missing:\n%s", i, row.legacy)
		}
	}

	// library 模式：旧 lore 工具名全部消失，read_library_item 指引逐行出现。
	libraryFlow := BuildIDEWritingFlowInstruction(SystemInstructionInput{Workspace: "/tmp/book", BackgroundMode: BackgroundModeLibrary})
	for _, banned := range []string{"read_lore_items", "list_lore_items", "write_lore_items"} {
		if strings.Contains(libraryFlow, banned) {
			t.Fatalf("library background flow must not reference legacy lore tool %q:\n%s", banned, libraryFlow)
		}
	}
	for i, row := range loreBackgroundGuidanceRows {
		if !strings.Contains(libraryFlow, row.library) {
			t.Fatalf("library background flow must contain replacement guidance %d:\n%s", i, row.library)
		}
	}
	if strings.Contains(libraryFlow, "%!(EXTRA") {
		t.Fatalf("library background flow has fmt artifacts:\n%s", libraryFlow)
	}

	// 显式 none 模式（B2a 修正轮）：无旧 lore 工具名，也无库读取工具指引；
	// 语义改为“以大纲/进度/既有章节为准”。
	noneFlow := BuildIDEWritingFlowInstruction(SystemInstructionInput{Workspace: "/tmp/book", BackgroundMode: BackgroundModeNone})
	for _, banned := range []string{"read_lore_items", "list_lore_items", "write_lore_items", "read_library_item"} {
		if strings.Contains(noneFlow, banned) {
			t.Fatalf("explicit-none flow must not reference background tool %q:\n%s", banned, noneFlow)
		}
	}
	for i, row := range loreBackgroundGuidanceRows {
		if !strings.Contains(noneFlow, row.none) {
			t.Fatalf("explicit-none flow must contain no-background guidance %d:\n%s", i, row.none)
		}
	}
	if strings.Contains(noneFlow, "%!(EXTRA") {
		t.Fatalf("explicit-none flow has fmt artifacts:\n%s", noneFlow)
	}

	// 非 lore 差异之外，三种模式共享同一 body（工作流、目录结构等逐字节一致）。
	if strings.Contains(defaultFlow, "read_library_item") {
		t.Fatal("default flow must not reference read_library_item (tool only mounted in library mode)")
	}
}
