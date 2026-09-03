package agent

import (
	"context"
	"fmt"
	"strings"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"

	"denova/internal/book"
)

type listMasterAssetsInput struct {
	Query        string `json:"query,omitempty" jsonschema:"description=按资产名称或来源名称搜索"`
	RecordKind   string `json:"record_kind,omitempty" jsonschema:"description=可选：character_template 或 lorebook_template"`
	SemanticType string `json:"semantic_type,omitempty" jsonschema:"description=可选内容类型"`
	Availability string `json:"availability,omitempty" jsonschema:"description=可选：staging 或 usable"`
	Limit        int    `json:"limit,omitempty" jsonschema:"description=返回数量，默认 25，最多 100"`
	Offset       int    `json:"offset,omitempty" jsonschema:"description=分页偏移"`
}

type configManagerMasterProposalInput struct {
	MasterItemID string `json:"master_item_id" jsonschema:"required,description=目标总库资产 ID"`
	FieldPath    string `json:"field_path" jsonschema:"required,description=目标稳定字段路径"`
	Translation  string `json:"translation" jsonschema:"required,description=建议采用的新内容"`
	Reason       string `json:"reason,omitempty" jsonschema:"description=简短说明为什么修改"`
}

func newConfigManagerMasterTools(workspace string, allowRead, allowProposal bool) ([]tool.BaseTool, error) {
	workspace = strings.TrimSpace(workspace)
	if workspace == "" || (!allowRead && !allowProposal) {
		return nil, nil
	}
	store := book.NewMasterLibraryStore(workspace)
	tools := make([]tool.BaseTool, 0, 6)
	if allowRead {
		listAssets, err := utils.InferTool("list_master_assets", "浏览或搜索总资料库顶层资产。角色卡和独立设定书各自只作为一个顶层资产，内部 Entry 不会单独列出。", func(ctx context.Context, input listMasterAssetsInput) (string, error) {
			_ = ctx
			limit := input.Limit
			if limit <= 0 {
				limit = 25
			}
			if limit > 100 {
				limit = 100
			}
			result, err := store.ListAssets(book.MasterAssetQuery{Query: input.Query, RecordKind: input.RecordKind, SemanticType: input.SemanticType, Availability: input.Availability, Limit: limit, Offset: input.Offset})
			if err != nil {
				return "", err
			}
			return marshalMasterToolValue(result), nil
		})
		if err != nil {
			return nil, err
		}
		readAsset, err := utils.InferTool("read_master_asset", "读取一个总库资产的完整规范结构、字段目录、嵌套 Entry、来源摘要和当前版本。需要核对原文件时再调用 read_master_source。", func(ctx context.Context, input masterAssetToolInput) (string, error) {
			_ = ctx
			detail, err := store.GetAsset(strings.TrimSpace(input.MasterItemID))
			if err != nil {
				return "", err
			}
			return marshalMasterToolValue(map[string]any{"summary": detail.Summary, "item": detail.Item, "source": detail.Source, "source_revision": detail.SourceRevision}), nil
		})
		if err != nil {
			return nil, err
		}
		readSource, err := utils.InferTool("read_master_source", "读取一个总库资产对应的不可变原文件。仅在需要理解原始角色卡/设定书结构、核对未规范化字段或确认数据来源时调用。原件只读。", func(ctx context.Context, input masterAssetToolInput) (string, error) {
			_ = ctx
			detail, err := store.GetAsset(strings.TrimSpace(input.MasterItemID))
			if err != nil {
				return "", err
			}
			source, revision, data, err := store.LoadSourceRevision(detail.Item.SourceID, detail.Item.SourceRevision)
			if err != nil {
				return "", err
			}
			return marshalMasterToolValue(map[string]any{"master_item_id": detail.Item.MasterItemID, "filename": source.Filename, "revision": revision.Revision, "sha256": revision.SHA256, "content": string(data)}), nil
		})
		if err != nil {
			return nil, err
		}
		readField, err := utils.InferTool("read_master_field", "读取总库资产中一个稳定字段的原文、活动内容、版本基线、风险和是否必需。嵌套 Entry 使用包含 entry_id 的稳定 field_path。", func(ctx context.Context, input masterFieldToolInput) (string, error) {
			_ = ctx
			item, err := store.LoadItem(strings.TrimSpace(input.MasterItemID))
			if err != nil {
				return "", err
			}
			fieldPath := strings.TrimSpace(input.FieldPath)
			field, ok := item.Fields[fieldPath]
			if !ok {
				return "", fmt.Errorf("Master 字段不存在")
			}
			return marshalMasterToolValue(map[string]any{"master_item_id": item.MasterItemID, "field_path": fieldPath, "input_revision": item.Revision, "source_sha256": field.SourceSHA256, "source_text": field.SourceText, "active_text": field.ActiveText, "active_kind": field.ActiveKind, "active_translation_version": field.ActiveTranslationVersionID, "risk": field.Risk, "required": field.Required}), nil
		})
		if err != nil {
			return nil, err
		}
		tools = append(tools, listAssets, readAsset, readSource, readField)
	}
	if allowProposal {
		createProposal, err := utils.InferTool("create_master_proposal", "为一个总库字段创建待用户确认的修改 Proposal。必须先读取目标字段；此工具不会直接应用修改。", func(ctx context.Context, input configManagerMasterProposalInput) (string, error) {
			_ = ctx
			proposal, err := store.CreateMasterProposal(book.MasterProposalInput{Kind: book.MasterProposalPolish, ApplyMode: book.MasterProposalConfirm, MasterItemID: strings.TrimSpace(input.MasterItemID), FieldPath: strings.TrimSpace(input.FieldPath), Translation: input.Translation, Reason: strings.TrimSpace(input.Reason)})
			if err != nil {
				return "", err
			}
			return marshalMasterToolValue(proposal), nil
		})
		if err != nil {
			return nil, err
		}
		validateProposal, err := utils.InferTool("validate_master_patch", "验证总库 Proposal 的字段目标、CAS、变量/数字/链接保护和应用边界。验证通过后仍必须由用户在界面点击应用。", func(ctx context.Context, input masterProposalIDToolInput) (string, error) {
			_ = ctx
			proposal, err := store.ValidateMasterProposal(strings.TrimSpace(input.ProposalID))
			if err != nil {
				return "", err
			}
			return marshalMasterToolValue(proposal), nil
		})
		if err != nil {
			return nil, err
		}
		tools = append(tools, createProposal, validateProposal)
	}
	return tools, nil
}
