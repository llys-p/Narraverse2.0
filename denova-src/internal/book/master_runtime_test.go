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
