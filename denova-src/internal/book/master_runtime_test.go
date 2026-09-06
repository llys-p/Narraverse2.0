package book

import "testing"

func TestRecoveredRuntimeFieldUsesCurrentMasterVersion(t *testing.T) {
	field := &MasterTranslationFieldRuntime{
		TaskStatus:         MasterTaskFailed,
		TranslationVersion: "version-new",
		FailureReason:      "worker failure",
		FinalFailure:       true,
	}
	markRecoveredRuntimeField(field, MasterRecoveryClaim{
		Status:                 MasterRecoveryRecovered,
		BaseTranslationVersion: "version-old",
	})

	if field.TaskStatus != MasterTaskCompleted || field.FinalFailure {
		t.Fatalf("recovered field status = %q final_failure=%v, want completed/false", field.TaskStatus, field.FinalFailure)
	}
	if field.FailureReason != "worker failure" {
		t.Fatalf("recovery diagnostics were lost: %q", field.FailureReason)
	}
}

func TestUnrecoveredRuntimeFieldKeepsFailedStatus(t *testing.T) {
	field := &MasterTranslationFieldRuntime{TaskStatus: MasterTaskFailed, TranslationVersion: "version-old", FinalFailure: true}
	markRecoveredRuntimeField(field, MasterRecoveryClaim{
		Status:                 MasterRecoveryNeedsUser,
		BaseTranslationVersion: "version-old",
	})

	if field.TaskStatus != MasterTaskFailed || !field.FinalFailure {
		t.Fatalf("unrecovered field changed: status=%q final_failure=%v", field.TaskStatus, field.FinalFailure)
	}
}

func TestRuntimeAggregatesQualityCandidate(t *testing.T) {
	detail := MasterAssetDetail{
		Summary: MasterAssetSummary{MasterItemID: "item-1"},
		Item: MasterItem{
			Fields: map[string]MasterField{
				"character.description": {
					NeedsTranslation: true,
					SourceText:       "She walks quietly.",
					SourceSHA256:     "sha-1",
				},
			},
		},
	}
	queue := masterQueueSnapshot{
		OK: true,
		Jobs: []masterQueueJob{{
			ID: "translation-1", MasterItemID: "item-1", Field: "character.description",
			SourceSHA256: "sha-1", Status: "pending_review", ApplyPolicy: "master_review",
			Translation: "她 walks quietly。", QualityStatus: "needs_review",
			QualityCodes: []string{"mixed_language"}, QualityReason: "译文中残留连续英文句段",
			UpdatedAt: "2026-09-04T00:00:00Z",
		}},
	}

	runtime := buildMasterTranslationRuntime(detail, queue)
	if len(runtime.Fields) != 1 {
		t.Fatalf("runtime fields = %d, want 1", len(runtime.Fields))
	}
	field := runtime.Fields[0]
	if field.CandidateTranslation != "她 walks quietly。" {
		t.Fatalf("candidate not aggregated: %q", field.CandidateTranslation)
	}
	if field.QualityStatus != "needs_review" || len(field.QualityCodes) != 1 || field.QualityCodes[0] != "mixed_language" {
		t.Fatalf("quality not aggregated: status=%q codes=%v", field.QualityStatus, field.QualityCodes)
	}
	if field.QualityReason == "" {
		t.Fatalf("quality reason lost")
	}
	if field.TaskStatus != MasterTaskCompleted || !field.ReviewRequired {
		t.Fatalf("pending_review mapping wrong: status=%q review=%v", field.TaskStatus, field.ReviewRequired)
	}
}
