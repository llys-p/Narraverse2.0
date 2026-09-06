package book

import (
	"errors"
	"strings"
	"testing"
)

func TestMasterProposalCASRejectsStaleRevisionSourceAndTranslationVersion(t *testing.T) {
	tests := []struct {
		name          string
		inputRevision string
		sourceSHA     string
		baseVersion   string
		check         func(*MasterCASConflictError) bool
	}{
		{
			name:          "input revision",
			inputRevision: "sha256:stale-revision",
			check: func(conflict *MasterCASConflictError) bool {
				return conflict.ExpectedRevision != "" && conflict.ActualRevision != ""
			},
		},
		{
			name:      "source sha",
			sourceSHA: "sha256:stale-source",
			check: func(conflict *MasterCASConflictError) bool {
				return conflict.ExpectedSourceSHA256 != "" && conflict.ActualSourceSHA256 != ""
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store, adventure := masterTestStore(t)
			ingested, err := store.Ingest(MasterIngestInput{
				Filename: "recovery.json", Data: []byte("recovery-source"), SourceKind: "user_upload",
				AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("lore", "Recovery source")},
			})
			if err != nil {
				t.Fatal(err)
			}
			target := ingested.Transaction.TranslationTargets[0]
			proposal, err := store.CreateMasterProposal(MasterProposalInput{
				Kind: MasterProposalRecovery, ApplyMode: MasterProposalAuto,
				MasterItemID: target.MasterItemID, FieldPath: target.FieldPath, Translation: "恢复后的中文",
				InputRevision: test.inputRevision, SourceSHA256: test.sourceSHA, BaseTranslationVersion: test.baseVersion,
			})
			if err != nil {
				t.Fatal(err)
			}
			_, err = store.ValidateMasterProposal(proposal.ProposalID)
			var conflict *MasterCASConflictError
			if !errors.As(err, &conflict) || !test.check(conflict) {
				t.Fatalf("应拒绝过期 Proposal 并返回对应 CAS 维度: err=%v conflict=%#v", err, conflict)
			}
		})
	}

	t.Run("base translation version", func(t *testing.T) {
		store, adventure := masterTestStore(t)
		ingested, err := store.Ingest(MasterIngestInput{
			Filename: "recovery.json", Data: []byte("recovery-source"), SourceKind: "user_upload",
			AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("lore", "Recovery source")},
		})
		if err != nil {
			t.Fatal(err)
		}
		target := ingested.Transaction.TranslationTargets[0]
		if _, err := store.ApplyTranslation(MasterTranslationApplyInput{
			ImportID: target.ImportID, MasterItemID: target.MasterItemID, FieldPath: target.FieldPath,
			SourceSHA256: target.SourceSHA256, Translation: "初始译文", Model: "hy-mt", JobID: "base-job",
		}); err != nil {
			t.Fatal(err)
		}
		current, err := store.LoadItem(target.MasterItemID)
		if err != nil {
			t.Fatal(err)
		}
		proposal, err := store.CreateMasterProposal(MasterProposalInput{
			Kind: MasterProposalRecovery, ApplyMode: MasterProposalAuto,
			MasterItemID: target.MasterItemID, FieldPath: target.FieldPath, Translation: "恢复后的中文",
			InputRevision: current.Revision, SourceSHA256: target.SourceSHA256, BaseTranslationVersion: "stale-version",
		})
		if err != nil {
			t.Fatal(err)
		}
		_, err = store.ValidateMasterProposal(proposal.ProposalID)
		var conflict *MasterCASConflictError
		if !errors.As(err, &conflict) || conflict.ExpectedVersion == "" || conflict.ActualVersion == "" {
			t.Fatalf("应拒绝过期 Translation Version: err=%v conflict=%#v", err, conflict)
		}
	})
}

func TestRejectMasterProposalIsSoftDelete(t *testing.T) {
	store, adventure := masterTestStore(t)
	ingested, err := store.Ingest(MasterIngestInput{
		Filename: "reject.json", Data: []byte("reject-source"), SourceKind: "user_upload",
		AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("lore", "English source")},
	})
	if err != nil {
		t.Fatal(err)
	}
	target := ingested.Transaction.TranslationTargets[0]
	proposal, err := store.CreateMasterProposal(MasterProposalInput{
		Kind: MasterProposalRecovery, ApplyMode: MasterProposalConfirm,
		MasterItemID: target.MasterItemID, FieldPath: target.FieldPath, Translation: "需要丢弃的候选",
	})
	if err != nil {
		t.Fatal(err)
	}
	rejected, err := store.RejectMasterProposal(proposal.ProposalID)
	if err != nil {
		t.Fatal(err)
	}
	if rejected.Status != MasterProposalStatusRejected {
		t.Fatalf("候选应进入 rejected 状态: %#v", rejected)
	}
	list, err := store.ListMasterProposals(target.MasterItemID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Proposals) != 1 || list.Proposals[0].Status != MasterProposalStatusRejected {
		t.Fatalf("软删除应保留审计记录: %#v", list.Proposals)
	}
	loaded, err := store.LoadItem(target.MasterItemID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Fields[target.FieldPath].ActiveText != "" {
		t.Fatalf("删除候选不应修改正式内容: %#v", loaded.Fields[target.FieldPath])
	}
}

func TestCreateMasterProposalIsIdempotentForSameCandidate(t *testing.T) {
	store, adventure := masterTestStore(t)
	ingested, err := store.Ingest(MasterIngestInput{
		Filename: "duplicate.json", Data: []byte("duplicate-source"), SourceKind: "user_upload",
		AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("lore", "English source")},
	})
	if err != nil {
		t.Fatal(err)
	}
	target := ingested.Transaction.TranslationTargets[0]
	input := MasterProposalInput{
		Kind: MasterProposalRecovery, ApplyMode: MasterProposalConfirm,
		MasterItemID: target.MasterItemID, FieldPath: target.FieldPath, Translation: "同一个候选",
	}
	first, err := store.CreateMasterProposal(input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.CreateMasterProposal(input)
	if err != nil {
		t.Fatal(err)
	}
	if first.ProposalID != second.ProposalID {
		t.Fatalf("相同候选重复保存应复用 Proposal: %#v %#v", first, second)
	}
	list, err := store.ListMasterProposals(target.MasterItemID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Proposals) != 1 {
		t.Fatalf("相同候选不应生成重复待处理条目: %#v", list.Proposals)
	}
}

func TestApplyingProposalRejectsOtherCandidatesForSameField(t *testing.T) {
	store, adventure := masterTestStore(t)
	ingested, err := store.Ingest(MasterIngestInput{
		Filename: "siblings.json", Data: []byte("siblings-source"), SourceKind: "user_upload",
		AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("lore", "English source")},
	})
	if err != nil {
		t.Fatal(err)
	}
	target := ingested.Transaction.TranslationTargets[0]
	first, err := store.CreateMasterProposal(MasterProposalInput{
		Kind: MasterProposalRecovery, ApplyMode: MasterProposalConfirm,
		MasterItemID: target.MasterItemID, FieldPath: target.FieldPath, Translation: "第一个候选",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.CreateMasterProposal(MasterProposalInput{
		Kind: MasterProposalRecovery, ApplyMode: MasterProposalConfirm,
		MasterItemID: target.MasterItemID, FieldPath: target.FieldPath, Translation: "第二个候选",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ValidateMasterProposal(first.ProposalID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ValidateMasterProposal(second.ProposalID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ApplyMasterProposal(first.ProposalID, true); err != nil {
		t.Fatal(err)
	}
	sibling, err := store.GetMasterProposal(second.ProposalID)
	if err != nil {
		t.Fatal(err)
	}
	if sibling.Status != MasterProposalStatusRejected {
		t.Fatalf("同字段其它候选应软拒绝并保留审计: %#v", sibling)
	}
	list, err := store.ListMasterProposals(target.MasterItemID)
	if err != nil || len(list.Proposals) != 2 {
		t.Fatalf("候选软拒绝不应删除审计记录: %#v %v", list.Proposals, err)
	}
}

func TestApplyMasterProposalCanForceApplyConflict(t *testing.T) {
	store, adventure := masterTestStore(t)
	ingested, err := store.Ingest(MasterIngestInput{
		Filename: "force-conflict.json", Data: []byte("force-conflict-source"), SourceKind: "user_upload",
		AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("lore", "English source")},
	})
	if err != nil {
		t.Fatal(err)
	}
	target := ingested.Transaction.TranslationTargets[0]
	proposal, err := store.CreateMasterProposal(MasterProposalInput{
		Kind: MasterProposalRecovery, ApplyMode: MasterProposalConfirm,
		MasterItemID: target.MasterItemID, FieldPath: target.FieldPath, Translation: "人工批准后的译文",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ApplyTranslation(MasterTranslationApplyInput{
		ImportID: target.ImportID, MasterItemID: target.MasterItemID, FieldPath: target.FieldPath,
		SourceSHA256: target.SourceSHA256, Translation: "先行译文", Model: "hy-mt", JobID: "other-job",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ValidateMasterProposal(proposal.ProposalID); err == nil {
		t.Fatal("过期 Proposal 应先进入 conflict")
	}
	conflict, err := store.GetMasterProposal(proposal.ProposalID)
	if err != nil || conflict.Status != MasterProposalStatusConflict {
		t.Fatalf("Proposal 应保留 conflict 状态: %#v %v", conflict, err)
	}
	if _, err := store.ApplyMasterProposal(proposal.ProposalID, true); err == nil {
		t.Fatal("未明确 force 时不应应用 conflict Proposal")
	}
	forced, err := store.ApplyMasterProposal(proposal.ProposalID, true, true)
	if err != nil {
		t.Fatal(err)
	}
	if forced.Proposal.Status != MasterProposalStatusApplied || !forced.Translation.Activated {
		t.Fatalf("人工批准并完成应激活当前条目: %#v", forced)
	}
	loaded, err := store.LoadItem(target.MasterItemID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Fields[target.FieldPath].ActiveText != "人工批准后的译文" {
		t.Fatalf("强制批准后的活动译文不正确: %#v", loaded.Fields[target.FieldPath])
	}
	if !strings.Contains(forced.Proposal.Reason, "人工批准并完成") {
		t.Fatalf("强制批准应留下审计原因: %#v", forced.Proposal)
	}
}

func TestApplyMasterProposalsCanForceApplyConflictBatch(t *testing.T) {
	store, adventure := masterTestStore(t)
	ingested, err := store.Ingest(MasterIngestInput{
		Filename: "force-batch.json", Data: []byte("force-batch-source"), SourceKind: "user_upload",
		AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("lore", "English source")},
	})
	if err != nil {
		t.Fatal(err)
	}
	target := ingested.Transaction.TranslationTargets[0]
	proposal, err := store.CreateMasterProposal(MasterProposalInput{
		Kind: MasterProposalRecovery, ApplyMode: MasterProposalConfirm,
		MasterItemID: target.MasterItemID, FieldPath: target.FieldPath, Translation: "批量批准后的译文",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ApplyTranslation(MasterTranslationApplyInput{
		ImportID: target.ImportID, MasterItemID: target.MasterItemID, FieldPath: target.FieldPath,
		SourceSHA256: target.SourceSHA256, Translation: "批量先行译文", Model: "hy-mt", JobID: "batch-other-job",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ValidateMasterProposal(proposal.ProposalID); err == nil {
		t.Fatal("批量测试的 Proposal 应先进入 conflict")
	}
	result := store.ApplyMasterProposals(target.MasterItemID, []string{proposal.ProposalID}, true, true)
	if result.AppliedCount != 1 || len(result.Results) != 1 || result.Results[0].Status != MasterProposalStatusApplied {
		t.Fatalf("批量批准并完成应应用 conflict Proposal: %#v", result)
	}
}

func TestManualProtectedTokenOverrideReportsDetailsAndApplies(t *testing.T) {
	store, adventure := masterTestStore(t)
	input := masterTestItem("lore", "unused")
	input.Fields["lorebook.name"] = MasterFieldInput{
		Text:     "Use {{user}} at https://example.com/2 on day 7",
		Risk:     masterFieldRiskSafe,
		Required: true,
	}
	ingested, err := store.Ingest(MasterIngestInput{
		Filename: "protected-markers.json", Data: []byte("protected-markers-source"), SourceKind: "user_upload",
		AdventureWorkspace: adventure, Items: []MasterItemInput{input},
	})
	if err != nil {
		t.Fatal(err)
	}
	target := ingested.Transaction.TranslationTargets[0]
	candidate := "在 https://example.com/2 使用 {{user}}"
	proposal, err := store.CreateMasterProposal(MasterProposalInput{
		Kind: MasterProposalRecovery, ApplyMode: MasterProposalConfirm,
		MasterItemID: target.MasterItemID, FieldPath: target.FieldPath, Translation: candidate,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ValidateMasterProposal(proposal.ProposalID); err == nil {
		t.Fatal("严格校验应拒绝缺少数字标记的候选")
	} else {
		var mismatch *MasterTranslationMarkerMismatchError
		if !errors.As(err, &mismatch) || mismatch.MissingNumbers != 1 || mismatch.MissingVariables != 0 || mismatch.MissingLinks != 0 {
			t.Fatalf("应返回可解释的保护标记差异: err=%v mismatch=%#v", err, mismatch)
		}
	}
	validated, err := store.ValidateMasterProposalWithOptions(proposal.ProposalID, true)
	if err != nil {
		t.Fatal(err)
	}
	if validated.Status != MasterProposalStatusValid || !validated.ProtectedTokenOverride {
		t.Fatalf("人工确认后应保留覆盖标记: %#v", validated)
	}
	applied, err := store.ApplyMasterProposal(proposal.ProposalID, true)
	if err != nil {
		t.Fatal(err)
	}
	if applied.Proposal.Status != MasterProposalStatusApplied || !applied.Proposal.ProtectedTokenOverride {
		t.Fatalf("人工确认候选应正常应用: %#v", applied.Proposal)
	}
	loaded, err := store.LoadItem(target.MasterItemID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Fields[target.FieldPath].ActiveText != candidate {
		t.Fatalf("人工确认后的译文未成为活动内容: %#v", loaded.Fields[target.FieldPath])
	}
}
