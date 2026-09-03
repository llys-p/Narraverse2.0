package book

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	masterRecoveryClaimDir       = ".narraverse/master-agent/recovery-claims"
	MasterRecoveryWaitingRuntime = "waiting_for_runtime"
	MasterRecoveryEligible       = "eligible"
	MasterRecoveryAgentRunning   = "agent_running"
	MasterRecoveryProposalReady  = "proposal_ready"
	MasterRecoveryApplying       = "applying"
	MasterRecoveryRevalidating   = "revalidating"
	MasterRecoveryRecovered      = "recovered"
	MasterRecoveryNeedsUser      = "needs_user"
	MasterRecoveryFailed         = "failed"
)

// MasterRecoveryClaim is the small durable idempotency/escalation record that
// cannot be reconstructed from Runtime + Proposal + Task after a restart.
type MasterRecoveryClaim struct {
	SchemaVersion          int    `json:"schema_version"`
	RecoveryKey            string `json:"recovery_key"`
	MasterItemID           string `json:"master_item_id"`
	FieldPath              string `json:"field_path"`
	InputRevision          string `json:"input_revision"`
	SourceSHA256           string `json:"source_sha256"`
	BaseTranslationVersion string `json:"base_translation_version,omitempty"`
	QueueJobID             string `json:"queue_job_id,omitempty"`
	Status                 string `json:"status"`
	AgentTaskID            string `json:"agent_task_id,omitempty"`
	ProposalID             string `json:"proposal_id,omitempty"`
	RecoveryAttempt        int    `json:"recovery_attempt"`
	Reason                 string `json:"reason,omitempty"`
	CreatedAt              string `json:"created_at"`
	UpdatedAt              string `json:"updated_at"`
}

func MasterRecoveryKey(masterItemID, fieldPath, inputRevision, sourceSHA256 string) string {
	value := strings.Join([]string{strings.TrimSpace(masterItemID), strings.TrimSpace(fieldPath), strings.TrimSpace(inputRevision), strings.TrimSpace(sourceSHA256)}, "\x00")
	return "recovery-" + masterHashString(value)
}

func (s *MasterLibraryStore) ClaimMasterRecovery(masterItemID, fieldPath, inputRevision, sourceSHA256, queueJobID string) (MasterRecoveryClaim, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, field, err := s.loadMasterProposalTargetUnlocked(masterItemID, fieldPath)
	if err != nil {
		return MasterRecoveryClaim{}, false, err
	}
	if strings.TrimSpace(inputRevision) != item.Revision || strings.TrimSpace(sourceSHA256) != field.SourceSHA256 {
		return MasterRecoveryClaim{}, false, &MasterCASConflictError{
			MasterItemID: item.MasterItemID, FieldPath: fieldPath,
			ExpectedRevision: strings.TrimSpace(inputRevision), ActualRevision: item.Revision,
			ExpectedSourceSHA256: strings.TrimSpace(sourceSHA256), ActualSourceSHA256: field.SourceSHA256,
		}
	}
	key := MasterRecoveryKey(item.MasterItemID, fieldPath, item.Revision, field.SourceSHA256)
	if existing, err := s.loadMasterRecoveryClaimUnlocked(key); err == nil {
		return existing, false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return MasterRecoveryClaim{}, false, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	claim := MasterRecoveryClaim{
		SchemaVersion: 1, RecoveryKey: key, MasterItemID: item.MasterItemID, FieldPath: strings.TrimSpace(fieldPath),
		InputRevision: item.Revision, SourceSHA256: field.SourceSHA256, BaseTranslationVersion: field.ActiveTranslationVersionID, QueueJobID: strings.TrimSpace(queueJobID),
		Status: MasterRecoveryAgentRunning, RecoveryAttempt: 1, CreatedAt: now, UpdatedAt: now,
	}
	if err := s.writeMasterRecoveryClaimUnlocked(claim); err != nil {
		return MasterRecoveryClaim{}, false, err
	}
	return claim, true, nil
}

func (s *MasterLibraryStore) GetMasterRecoveryClaim(key string) (MasterRecoveryClaim, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadMasterRecoveryClaimUnlocked(key)
}

func (s *MasterLibraryStore) GetMasterRecoveryClaimForField(masterItemID, fieldPath, inputRevision, sourceSHA256 string) (MasterRecoveryClaim, error) {
	return s.GetMasterRecoveryClaim(MasterRecoveryKey(masterItemID, fieldPath, inputRevision, sourceSHA256))
}

func (s *MasterLibraryStore) UpdateMasterRecoveryClaim(key, status, taskID, proposalID, reason string) (MasterRecoveryClaim, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	claim, err := s.loadMasterRecoveryClaimUnlocked(key)
	if err != nil {
		return MasterRecoveryClaim{}, err
	}
	claim.Status = strings.TrimSpace(status)
	claim.AgentTaskID = strings.TrimSpace(taskID)
	claim.ProposalID = strings.TrimSpace(proposalID)
	claim.Reason = strings.TrimSpace(reason)
	claim.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.writeMasterRecoveryClaimUnlocked(claim); err != nil {
		return MasterRecoveryClaim{}, err
	}
	return claim, nil
}

func (s *MasterLibraryStore) ListMasterRecoveryClaims(masterItemID string) ([]MasterRecoveryClaim, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(filepath.Join(s.workspace, filepath.FromSlash(masterRecoveryClaimDir)))
	if errors.Is(err, os.ErrNotExist) {
		return []MasterRecoveryClaim{}, nil
	}
	if err != nil {
		return nil, err
	}
	claims := make([]MasterRecoveryClaim, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		claim, readErr := s.loadMasterRecoveryClaimUnlocked(strings.TrimSuffix(entry.Name(), ".json"))
		if readErr != nil || (strings.TrimSpace(masterItemID) != "" && claim.MasterItemID != strings.TrimSpace(masterItemID)) {
			continue
		}
		claims = append(claims, claim)
	}
	sort.SliceStable(claims, func(i, j int) bool { return claims[i].UpdatedAt > claims[j].UpdatedAt })
	return claims, nil
}

func (s *MasterLibraryStore) loadMasterRecoveryClaimUnlocked(key string) (MasterRecoveryClaim, error) {
	key = strings.TrimSpace(key)
	if len(key) != len("recovery-")+64 || !strings.HasPrefix(key, "recovery-") {
		return MasterRecoveryClaim{}, errors.New("Recovery key 无效")
	}
	data, err := os.ReadFile(filepath.Join(s.workspace, filepath.FromSlash(masterRecoveryClaimDir), key+".json"))
	if err != nil {
		return MasterRecoveryClaim{}, err
	}
	var claim MasterRecoveryClaim
	if err := json.Unmarshal(data, &claim); err != nil {
		return MasterRecoveryClaim{}, err
	}
	return claim, nil
}

func (s *MasterLibraryStore) writeMasterRecoveryClaimUnlocked(claim MasterRecoveryClaim) error {
	return s.writeJSONUnlocked(filepath.ToSlash(filepath.Join(masterRecoveryClaimDir, claim.RecoveryKey+".json")), claim)
}
