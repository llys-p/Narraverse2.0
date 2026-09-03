package book

import (
	"errors"
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
