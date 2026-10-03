package app

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"denova/internal/book"
)

// 书籍总览（P1）：归属于当前书籍工作区的 setting/book-overview.md。
// 读取/保存复用现有 workspace 文件能力（GET/POST /api/workspace/file，
// 带 base_revision 冲突检查）；本文件只提供「AI 整理总览」草稿生成。
// 冻结约束：生成结果只是草稿，由用户确认后经现有文件保存流程落盘；
// 本服务不写总览文件、不写 lore 条目。

const (
	// BookOverviewPath 是书籍总览在书籍工作区内的固定相对路径。
	BookOverviewPath = "setting/book-overview.md"

	bookOverviewDraftMaxRunes   = 32_000
	bookOverviewOutlineMaxRunes = 8_000
	bookOverviewSelectedMax     = 50
	bookOverviewInputMaxBytes   = 256 << 10
)

var ErrBookOverviewInvalidRequest = errors.New("invalid book overview request")

// BookOverviewOrganizeRequest 是「AI 整理总览」的输入。
// CurrentDraft 是用户编辑器里的当前草稿（模型须保留其中用户内容）；
// SelectedLoreIDs 是用户显式选定参与整理的条目；IncludeOutline 控制是否附加大纲摘要。
type BookOverviewOrganizeRequest struct {
	CurrentDraft    string   `json:"current_draft"`
	SelectedLoreIDs []string `json:"selected_lore_ids"`
	IncludeOutline  bool     `json:"include_outline"`
}

// BookOverviewOrganizeUsage 说明本次整理实际使用的资料与缺失范围，供界面如实展示。
type BookOverviewOrganizeUsage struct {
	ResidentCount  int      `json:"resident_count"`
	SelectedIDs    []string `json:"selected_ids"`
	UnknownIDs     []string `json:"unknown_ids,omitempty"`
	IncludeOutline bool     `json:"include_outline"`
	OutlineFound   bool     `json:"outline_found"`
	DraftChars     int      `json:"draft_chars"`
	Missing        []string `json:"missing"`
}

// BookOverviewOrganizeResult 是 AI 整理草稿；Draft 未落盘。
type BookOverviewOrganizeResult struct {
	Draft string                   `json:"draft"`
	Used  BookOverviewOrganizeUsage `json:"used"`
}

// buildBookOverviewOrganizeMessages 装配整理请求（纯函数，便于测试）。
// 资料不足或矛盾只能标注为「待补/矛盾」，禁止模型补成既定事实。
func buildBookOverviewOrganizeMessages(draft, resident, selected, outline string, usage BookOverviewOrganizeUsage) []ModelGatewayMessage {
	var input strings.Builder
	input.WriteString("【当前总览草稿】（用户已编辑内容，整理时必须保留，不得整篇丢弃；为空表示尚未创建）\n")
	input.WriteString(strings.TrimSpace(draft) + "\n\n")
	input.WriteString("【常驻资料】（本书启用为常驻的条目正文）\n")
	if strings.TrimSpace(resident) == "" {
		input.WriteString("（无）\n\n")
	} else {
		input.WriteString(resident + "\n\n")
	}
	input.WriteString("【用户选定条目】\n")
	if strings.TrimSpace(selected) == "" {
		input.WriteString("（未选择）\n\n")
	} else {
		input.WriteString(selected + "\n\n")
	}
	if usage.IncludeOutline {
		input.WriteString("【长期大纲摘要】\n")
		if strings.TrimSpace(outline) == "" {
			input.WriteString("（无）\n\n")
		} else {
			input.WriteString(outline + "\n\n")
		}
	}
	if len(usage.Missing) > 0 {
		input.WriteString("【缺失范围】以下资料本次不可用，请在草稿中如实标注而不是编造：")
		input.WriteString(strings.Join(usage.Missing, "；") + "\n")
	}

	system := strings.Join([]string{
		"你是书籍资料整理助手。根据用户提供的本书资料，生成或更新一份「书籍总览」Markdown 草稿。",
		"总览帮助读者理解全书，可涵盖：世界背景、核心规则、主要人物、地点、势力及重要关系；结构允许按资料自然组织，不强制固定表格。",
		"规则：1) 只依据提供的资料整理，资料不足或资料间矛盾处，用「待补：」「矛盾：」小节明确列出，不得自行补成既定事实；",
		"2) 当前草稿中用户已写的内容默认保留并融入，除非与新资料直接矛盾（矛盾时并列标注，不要静默删除）；",
		"3) 总览是摘要与索引，不复制条目全文；每个小节控制在简短段落；",
		"4) 只输出总览 Markdown 正文，不要解释、不要代码块。",
	}, "")
	return []ModelGatewayMessage{
		{Role: "system", Content: system},
		{Role: "user", Content: input.String()},
	}
}

// OrganizeBookOverview 生成总览草稿（不写盘）。资料读取与模型生成都属于
// 当前工作区这一本书；调用方（界面）负责草稿确认与 revision 检查保存。
func (a *App) OrganizeBookOverview(ctx context.Context, req BookOverviewOrganizeRequest) (BookOverviewOrganizeResult, error) {
	workspace := a.Workspace()
	if strings.TrimSpace(workspace) == "" {
		return BookOverviewOrganizeResult{}, fmt.Errorf("%w: 当前没有打开的书籍", ErrBookOverviewInvalidRequest)
	}
	draftRunes := []rune(req.CurrentDraft)
	if len(draftRunes) > bookOverviewDraftMaxRunes {
		return BookOverviewOrganizeResult{}, fmt.Errorf("%w: 当前草稿超过 %d 字上限", ErrBookOverviewInvalidRequest, bookOverviewDraftMaxRunes)
	}

	store := book.NewLoreStore(workspace)
	// 三个列表始终返回 JSON 数组（不是 null），前端直接读 .length。
	usage := BookOverviewOrganizeUsage{
		IncludeOutline: req.IncludeOutline,
		DraftChars:     len(draftRunes),
		SelectedIDs:    []string{},
		UnknownIDs:     []string{},
		Missing:        []string{},
	}

	resident, err := store.ResidentContextMarkdown()
	if err != nil {
		return BookOverviewOrganizeResult{}, fmt.Errorf("读取常驻资料失败: %w", err)
	}
	items, err := store.List()
	if err != nil {
		return BookOverviewOrganizeResult{}, fmt.Errorf("读取资料目录失败: %w", err)
	}
	for _, item := range items {
		if item.LoadMode == book.LoreLoadModeResident && strings.TrimSpace(item.Content) != "" {
			usage.ResidentCount++
		}
	}
	if usage.ResidentCount == 0 {
		usage.Missing = append(usage.Missing, "无常驻资料")
	}

	selectedIDs := req.SelectedLoreIDs
	if len(selectedIDs) > bookOverviewSelectedMax {
		return BookOverviewOrganizeResult{}, fmt.Errorf("%w: 选定条目超过 %d 条上限", ErrBookOverviewInvalidRequest, bookOverviewSelectedMax)
	}
	var selectedBlock string
	if len(selectedIDs) > 0 {
		byID := make(map[string]book.LoreItem, len(items))
		for _, item := range items {
			byID[item.ID] = item
		}
		var sb strings.Builder
		seen := make(map[string]bool, len(selectedIDs))
		for _, id := range selectedIDs {
			id = strings.TrimSpace(id)
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			item, ok := byID[id]
			if !ok {
				usage.UnknownIDs = append(usage.UnknownIDs, id)
				continue
			}
			if strings.TrimSpace(item.Content) == "" {
				continue
			}
			// Resident bodies are already in the first block. A checked resident
			// entry must not be sent to the model a second time.
			if item.LoadMode == book.LoreLoadModeResident {
				continue
			}
			usage.SelectedIDs = append(usage.SelectedIDs, item.ID)
			fmt.Fprintf(&sb, "### %s（%s）\n%s\n\n", item.Name, item.Type, strings.TrimSpace(item.Content))
		}
		selectedBlock = strings.TrimSpace(sb.String())
	} else {
		usage.Missing = append(usage.Missing, "未选定额外条目")
	}

	var outline string
	if req.IncludeOutline {
		content, readErr := a.BookService().ReadFile("setting/outline.md")
		if readErr == nil {
			runes := []rune(strings.TrimSpace(content))
			if len(runes) > bookOverviewOutlineMaxRunes {
				runes = runes[:bookOverviewOutlineMaxRunes]
			}
			outline = string(runes)
			usage.OutlineFound = outline != ""
		}
		if !usage.OutlineFound {
			usage.Missing = append(usage.Missing, "无长期大纲")
		}
	}

	messages := buildBookOverviewOrganizeMessages(req.CurrentDraft, resident, selectedBlock, outline, usage)
	if len(messages[0].Content)+len(messages[1].Content) > bookOverviewInputMaxBytes {
		return BookOverviewOrganizeResult{}, fmt.Errorf("%w: 整理输入超过 %d 字节上限，请减少所选资料", ErrBookOverviewInvalidRequest, bookOverviewInputMaxBytes)
	}
	result, err := a.GenerateModel(ctx, ModelGatewayChatRequest{
		Module:    ModelModuleWriting,
		Messages:  messages,
		MaxTokens: 4096,
	})
	if err != nil {
		return BookOverviewOrganizeResult{}, err
	}
	draft := strings.TrimSpace(result.Content)
	if draft == "" {
		return BookOverviewOrganizeResult{}, fmt.Errorf("模型没有返回可用草稿")
	}
	return BookOverviewOrganizeResult{Draft: draft, Used: usage}, nil
}
