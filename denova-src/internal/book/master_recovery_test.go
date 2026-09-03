package book

import "testing"

func TestMasterRecoveryClaimIsIdempotentForOneFailureIdentity(t *testing.T) {
	store, adventure := masterTestStore(t)
	ingested, err := store.Ingest(MasterIngestInput{
		Filename: "recovery.json", Data: []byte("recovery-source"), SourceKind: "user_upload",
		AdventureWorkspace: adventure, Items: []MasterItemInput{masterTestItem("lore", "Recovery source")},
	})
	if err != nil {
		t.Fatal(err)
	}
	target := ingested.Transaction.TranslationTargets[0]
	first, claimed, err := store.ClaimMasterRecovery(target.MasterItemID, target.FieldPath, ingested.Items[0].Revision, target.SourceSHA256, "translation-job-1")
	if err != nil || !claimed || first.RecoveryKey != MasterRecoveryKey(target.MasterItemID, target.FieldPath, ingested.Items[0].Revision, target.SourceSHA256) {
		t.Fatalf("第一次 Recovery 应成功建立 claim: %#v %v %v", first, claimed, err)
	}
	second, claimed, err := store.ClaimMasterRecovery(target.MasterItemID, target.FieldPath, ingested.Items[0].Revision, target.SourceSHA256, "translation-job-1")
	if err != nil || claimed || second.RecoveryKey != first.RecoveryKey {
		t.Fatalf("同一失败身份不得重复 claim: %#v %v %v", second, claimed, err)
	}
	claims, err := store.ListMasterRecoveryClaims(target.MasterItemID)
	if err != nil || len(claims) != 1 {
		t.Fatalf("应只保留一个 Recovery claim: %#v %v", claims, err)
	}
}
