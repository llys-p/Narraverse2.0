package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"

	"denova/internal/book"
)

type masterAgentScope struct {
	MasterItemID string
	FieldPath    string
}

type masterAssetToolInput struct {
	MasterItemID string `json:"master_item_id" jsonschema:"required,description=目标 Master 资产 ID"`
}

type masterFieldToolInput struct {
	MasterItemID string `json:"master_item_id" jsonschema:"required,description=目标 Master 资产 ID"`
	FieldPath    string `json:"field_path" jsonschema:"required,description=目标字段路径"`
}

type masterProposalToolInput struct {
	MasterItemID           string `json:"master_item_id" jsonschema:"required,description=目标 Master 资产 ID"`
	FieldPath              string `json:"field_path" jsonschema:"required,description=目标字段路径"`
	Translation            string `json:"translation" jsonschema:"required,description=单一明确的候选译文"`
	Kind                   string `json:"kind" jsonschema:"required,description=recovery 或 polish"`
	ApplyMode              string `json:"apply_mode" jsonschema:"required,description=auto 或 confirm"`
	InputRevision          string `json:"input_revision,omitempty"`
	SourceSHA256           string `json:"source_sha256,omitempty"`
	BaseTranslationVersion string `json:"base_translation_version,omitempty"`
	Risk                   string `json:"risk,omitempty"`
	IssueCode              string `json:"issue_code,omitempty"`
	Reason                 string `json:"reason,omitempty"`
	RecoveryAttempt        int    `json:"recovery_attempt,omitempty"`
}

type masterProposalIDToolInput struct {
	ProposalID string `json:"proposal_id" jsonschema:"required,description=Master Proposal ID"`
}

type masterApplyToolInput struct {
	ProposalID string `json:"proposal_id" jsonschema:"required,description=Master Proposal ID"`
	Confirmed  bool   `json:"confirmed" jsonschema:"description=用户是否明确确认采用候选；自动恢复不得用该字段绕过安全边界"`
}

func newMasterAgentTools(workspace string, scope masterAgentScope) ([]tool.BaseTool, error) {
	workspace = strings.TrimSpace(workspace)
	if workspace == "" || scope.MasterItemID == "" || scope.FieldPath == "" {
		return nil, fmt.Errorf("Master Agent 缺少有效作用域")
	}
	store := book.NewMasterLibraryStore(workspace)
	checkAsset := func(id string) error {
		if strings.TrimSpace(id) != scope.MasterItemID {
			return fmt.Errorf("Master Agent 只能处理当前指定资产")
		}
		return nil
	}
	checkField := func(id, field string) error {
		if err := checkAsset(id); err != nil {
			return err
		}
		if strings.TrimSpace(field) != scope.FieldPath {
			return fmt.Errorf("Master Agent 只能处理当前指定字段")
		}
		return nil
	}
	readAsset, err := utils.InferTool("get_master_asset", "读取当前 Master 资产的最小元数据；不得读取无关资产。", func(ctx context.Context, input masterAssetToolInput) (string, error) {
		_ = ctx
		if err := checkAsset(input.MasterItemID); err != nil {
			return "", err
		}
		detail, err := store.GetAsset(input.MasterItemID)
		if err != nil {
			return "", err
		}
		return marshalMasterToolValue(map[string]any{"summary": detail.Summary, "source": detail.Source, "source_revision": detail.SourceRevision}), nil
	})
	if err != nil {
		return nil, err
	}
	readField, err := utils.InferTool("get_master_field", "读取当前字段的原文、活动译文和版本基线；只读取指定字段。", func(ctx context.Context, input masterFieldToolInput) (string, error) {
		_ = ctx
		if err := checkField(input.MasterItemID, input.FieldPath); err != nil {
			return "", err
		}
		item, err := store.LoadItem(input.MasterItemID)
		if err != nil {
			return "", err
		}
		field, ok := item.Fields[input.FieldPath]
		if !ok {
			return "", fmt.Errorf("Master 字段不存在")
		}
		return marshalMasterToolValue(map[string]any{"master_item_id": item.MasterItemID, "field_path": input.FieldPath, "input_revision": item.Revision, "source_sha256": field.SourceSHA256, "source_text": field.SourceText, "active_text": field.ActiveText, "active_kind": field.ActiveKind, "active_translation_version": field.ActiveTranslationVersionID, "risk": field.Risk, "required": field.Required}), nil
	})
	if err != nil {
		return nil, err
	}
	readPipeline, err := utils.InferTool("get_master_pipeline_status", "读取指定 Master 资产的流水线状态和问题摘要。", func(ctx context.Context, input masterAssetToolInput) (string, error) {
		_ = ctx
		if err := checkAsset(input.MasterItemID); err != nil {
			return "", err
		}
		pipeline, err := store.GetAssetPipeline(input.MasterItemID)
		if err != nil {
			return "", err
		}
		return marshalMasterToolValue(pipeline), nil
	})
	if err != nil {
		return nil, err
	}
	readTranslation, err := utils.InferTool("get_master_translation_status", "读取指定字段的 Master 版本与 8097 实时翻译状态。", func(ctx context.Context, input masterFieldToolInput) (string, error) {
		_ = ctx
		if err := checkField(input.MasterItemID, input.FieldPath); err != nil {
			return "", err
		}
		runtime, err := store.GetAssetRuntime(input.MasterItemID)
		if err != nil {
			return "", err
		}
		for _, field := range runtime.Fields {
			if field.FieldPath == input.FieldPath {
				return marshalMasterToolValue(field), nil
			}
		}
		return "", fmt.Errorf("未找到指定字段的翻译运行状态")
	})
	if err != nil {
		return nil, err
	}
	readIssue, err := utils.InferTool("get_master_issue", "读取当前 Master 资产的检查问题摘要；技术细节仅供诊断。", func(ctx context.Context, input masterAssetToolInput) (string, error) {
		_ = ctx
		if err := checkAsset(input.MasterItemID); err != nil {
			return "", err
		}
		pipeline, err := store.GetAssetPipeline(input.MasterItemID)
		if err != nil {
			return "", err
		}
		return marshalMasterToolValue(pipeline.Issues), nil
	})
	if err != nil {
		return nil, err
	}
	createProposal, err := utils.InferTool("create_master_proposal", "创建一个字段级 Master Proposal。只能提交一个明确候选，不得直接写入 Master。", func(ctx context.Context, input masterProposalToolInput) (string, error) {
		_ = ctx
		if err := checkField(input.MasterItemID, input.FieldPath); err != nil {
			return "", err
		}
		proposal, err := store.CreateMasterProposal(book.MasterProposalInput{Kind: input.Kind, ApplyMode: input.ApplyMode, MasterItemID: input.MasterItemID, FieldPath: input.FieldPath, Translation: input.Translation, InputRevision: input.InputRevision, SourceSHA256: input.SourceSHA256, BaseTranslationVersion: input.BaseTranslationVersion, Risk: input.Risk, IssueCode: input.IssueCode, Reason: input.Reason, RecoveryAttempt: input.RecoveryAttempt})
		if err != nil {
			return "", err
		}
		return marshalMasterToolValue(proposal), nil
	})
	if err != nil {
		return nil, err
	}
	validateProposal, err := utils.InferTool("validate_master_patch", "验证 Proposal 的字段目标、CAS、变量/数字/链接保护和应用边界。验证通过后仍需 apply_master_patch。", func(ctx context.Context, input masterProposalIDToolInput) (string, error) {
		_ = ctx
		proposal, err := store.GetMasterProposal(input.ProposalID)
		if err != nil {
			return "", err
		}
		if err := checkField(proposal.MasterItemID, proposal.FieldPath); err != nil {
			return "", err
		}
		validated, err := store.ValidateMasterProposal(input.ProposalID)
		if err != nil {
			return "", err
		}
		return marshalMasterToolValue(validated), nil
	})
	if err != nil {
		return nil, err
	}
	applyProposal, err := utils.InferTool("apply_master_patch", "应用已验证的字段级 Proposal。必须经过 CAS 和权限校验；失败时不得重复循环。", func(ctx context.Context, input masterApplyToolInput) (string, error) {
		_ = ctx
		proposal, err := store.GetMasterProposal(input.ProposalID)
		if err != nil {
			return "", err
		}
		if err := checkField(proposal.MasterItemID, proposal.FieldPath); err != nil {
			return "", err
		}
		result, err := store.ApplyMasterProposal(input.ProposalID, input.Confirmed)
		if err != nil {
			return "", err
		}
		return marshalMasterToolValue(result), nil
	})
	if err != nil {
		return nil, err
	}
	return []tool.BaseTool{readAsset, readField, readPipeline, readTranslation, readIssue, createProposal, validateProposal, applyProposal}, nil
}

func marshalMasterToolValue(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf("序列化 Master 工具结果失败: %v", err)
	}
	return string(data)
}
