package app

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"denova/internal/book"
)

const masterRecoveryPollInterval = 5 * time.Second

// StartMasterRecoveryOrchestrator starts the side-effecting recovery loop.
// Runtime/Pipeline GET handlers never call this loop or start an Agent.
func (a *App) StartMasterRecoveryOrchestrator(parent context.Context) {
	if a == nil {
		return
	}
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	a.mu.Lock()
	if a.masterRecoveryCancel != nil {
		a.masterRecoveryCancel()
	}
	a.masterRecoveryCancel = cancel
	a.mu.Unlock()
	go func() {
		ticker := time.NewTicker(masterRecoveryPollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				a.runMasterRecoveryTick(ctx)
			}
		}
	}()
}

func (a *App) runMasterRecoveryTick(ctx context.Context) {
	defer func() {
		if recovered := recover(); recovered != nil {
			log.Printf("[master-recovery] tick panic recovered err=%v", recovered)
		}
	}()
	workspace := a.Workspace()
	if strings.TrimSpace(workspace) == "" {
		return
	}
	store := book.NewMasterLibraryStore(workspace)
	a.reconcileMasterRecoveryClaims(ctx, store)
	assets, err := listAllMasterAssets(store)
	if err != nil {
		log.Printf("[master-recovery] list assets failed err=%v", err)
		return
	}
	for _, asset := range assets {
		runtime, runtimeErr := store.GetAssetRuntime(asset.MasterItemID)
		if runtimeErr != nil || !runtime.RuntimeAvailable || runtime.QueuePaused {
			continue
		}
		for _, field := range runtime.Fields {
			if !field.FinalFailure || field.RecoveryStatus != book.MasterRecoveryEligible {
				continue
			}
			claim, claimed, claimErr := store.ClaimMasterRecovery(asset.MasterItemID, field.FieldPath, field.InputRevision, field.SourceSHA256, field.TaskID)
			if claimErr != nil || !claimed {
				continue
			}
			task, startErr := a.StartMasterAgentTask(ctx, asset.MasterItemID, field.FieldPath, book.MasterProposalRecovery, "系统正在尝试恢复这个翻译字段。只尝试一次；请读取字段诊断，生成并验证一个安全的 Recovery Proposal，满足低风险条件时自动应用，否则停止并升级处理。")
			if startErr != nil {
				_, _ = store.UpdateMasterRecoveryClaim(claim.RecoveryKey, book.MasterRecoveryNeedsUser, "", "", startErr.Error())
				continue
			}
			_, _ = store.UpdateMasterRecoveryClaim(claim.RecoveryKey, book.MasterRecoveryAgentRunning, task.ID(), "", "")
		}
	}
}

func listAllMasterAssets(store *book.MasterLibraryStore) ([]book.MasterAssetSummary, error) {
	assets := make([]book.MasterAssetSummary, 0)
	for offset := 0; ; offset += 500 {
		page, err := store.ListAssets(book.MasterAssetQuery{Limit: 500, Offset: offset})
		if err != nil {
			return nil, err
		}
		assets = append(assets, page.Assets...)
		if len(page.Assets) == 0 || len(assets) >= page.Total {
			return assets, nil
		}
	}
}

func (a *App) reconcileMasterRecoveryClaims(ctx context.Context, store *book.MasterLibraryStore) {
	claims, err := store.ListMasterRecoveryClaims("")
	if err != nil {
		log.Printf("[master-recovery] list claims failed err=%v", err)
		return
	}
	for _, claim := range claims {
		if claim.Status != book.MasterRecoveryAgentRunning && claim.Status != book.MasterRecoveryProposalReady && claim.Status != book.MasterRecoveryApplying && claim.Status != book.MasterRecoveryRevalidating {
			continue
		}
		a.reconcileMasterRecoveryClaim(ctx, store, claim)
	}
}

func (a *App) reconcileMasterRecoveryClaim(ctx context.Context, store *book.MasterLibraryStore, claim book.MasterRecoveryClaim) {
	if claim.AgentTaskID != "" {
		task := a.MasterAgentTask(claim.AgentTaskID)
		if task == nil {
			_, _ = store.UpdateMasterRecoveryClaim(claim.RecoveryKey, book.MasterRecoveryNeedsUser, claim.AgentTaskID, claim.ProposalID, "Recovery Agent 任务不再可追踪")
			return
		}
		if !task.Finished() {
			return
		}
	}
	proposals, err := store.ListMasterProposals(claim.MasterItemID)
	if err != nil {
		_, _ = store.UpdateMasterRecoveryClaim(claim.RecoveryKey, book.MasterRecoveryNeedsUser, claim.AgentTaskID, "", err.Error())
		return
	}
	matches := make([]book.MasterProposal, 0, 1)
	for _, proposal := range proposals.Proposals {
		if proposal.Kind == book.MasterProposalRecovery && proposal.FieldPath == claim.FieldPath && proposal.InputRevision == claim.InputRevision && proposal.SourceSHA256 == claim.SourceSHA256 && proposal.CreatedAt >= claim.CreatedAt {
			matches = append(matches, proposal)
		}
	}
	if len(matches) != 1 {
		if len(matches) == 0 && claim.AgentTaskID != "" && !a.MasterAgentTask(claim.AgentTaskID).Finished() {
			return
		}
		_, _ = store.UpdateMasterRecoveryClaim(claim.RecoveryKey, book.MasterRecoveryNeedsUser, claim.AgentTaskID, "", "Recovery Agent 未生成唯一可验证的处理建议")
		return
	}
	proposal := matches[0]
	_, _ = store.UpdateMasterRecoveryClaim(claim.RecoveryKey, book.MasterRecoveryProposalReady, claim.AgentTaskID, proposal.ProposalID, "")
	item, err := store.LoadItem(claim.MasterItemID)
	if err != nil {
		_, _ = store.UpdateMasterRecoveryClaim(claim.RecoveryKey, book.MasterRecoveryNeedsUser, claim.AgentTaskID, proposal.ProposalID, err.Error())
		return
	}
	field, ok := item.Fields[claim.FieldPath]
	if !ok || field.Risk == "high" {
		_, _ = store.UpdateMasterRecoveryClaim(claim.RecoveryKey, book.MasterRecoveryNeedsUser, claim.AgentTaskID, proposal.ProposalID, "高风险字段不能自动恢复")
		return
	}
	if proposal.Status == book.MasterProposalStatusProposed || proposal.Status == book.MasterProposalStatusValid {
		_, _ = store.UpdateMasterRecoveryClaim(claim.RecoveryKey, book.MasterRecoveryApplying, claim.AgentTaskID, proposal.ProposalID, "")
		if _, err := store.ValidateMasterProposal(proposal.ProposalID); err != nil {
			_, _ = store.UpdateMasterRecoveryClaim(claim.RecoveryKey, book.MasterRecoveryNeedsUser, claim.AgentTaskID, proposal.ProposalID, err.Error())
			return
		}
		if _, err := store.ApplyMasterProposal(proposal.ProposalID, true); err != nil {
			_, _ = store.UpdateMasterRecoveryClaim(claim.RecoveryKey, book.MasterRecoveryNeedsUser, claim.AgentTaskID, proposal.ProposalID, err.Error())
			return
		}
	}
	if proposal.Status == book.MasterProposalStatusCandidate || proposal.Status == book.MasterProposalStatusConflict || proposal.Status == book.MasterProposalStatusRejected {
		_, _ = store.UpdateMasterRecoveryClaim(claim.RecoveryKey, book.MasterRecoveryNeedsUser, claim.AgentTaskID, proposal.ProposalID, "Recovery Proposal 不能安全自动采用")
		return
	}
	_, _ = store.UpdateMasterRecoveryClaim(claim.RecoveryKey, book.MasterRecoveryRevalidating, claim.AgentTaskID, proposal.ProposalID, "")
	if err := verifyMasterRecovery(store, claim); err != nil {
		_, _ = store.UpdateMasterRecoveryClaim(claim.RecoveryKey, book.MasterRecoveryNeedsUser, claim.AgentTaskID, proposal.ProposalID, err.Error())
		return
	}
	_, _ = store.UpdateMasterRecoveryClaim(claim.RecoveryKey, book.MasterRecoveryRecovered, claim.AgentTaskID, proposal.ProposalID, "")
	_ = ctx
}

func verifyMasterRecovery(store *book.MasterLibraryStore, claim book.MasterRecoveryClaim) error {
	item, err := store.LoadItem(claim.MasterItemID)
	if err != nil {
		return err
	}
	field, ok := item.Fields[claim.FieldPath]
	if !ok || field.ActiveTranslationVersionID == "" {
		return fmt.Errorf("Recovery 后字段仍没有活动 Translation Version")
	}
	if claim.BaseTranslationVersion != "" && field.ActiveTranslationVersionID == claim.BaseTranslationVersion {
		return fmt.Errorf("Recovery 后字段未产生新的 Translation Version")
	}
	pipeline, err := store.GetAssetPipeline(claim.MasterItemID)
	if err != nil {
		return err
	}
	if pipeline.Translation.FailedFields > 0 {
		return fmt.Errorf("Recovery 后仍存在失败翻译字段")
	}
	for _, node := range pipeline.Nodes {
		if node.Key == "translation" && (node.Status == "failed" || node.Status == "stale") {
			return fmt.Errorf("Recovery 后翻译节点仍未恢复")
		}
	}
	return nil
}
