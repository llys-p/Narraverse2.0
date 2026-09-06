package book

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	masterProposalSchemaVersion   = 1
	masterProposalDir             = ".narraverse/master-agent/proposals"
	MasterProposalRecovery        = "recovery"
	MasterProposalPolish          = "polish"
	MasterProposalAuto            = "auto"
	MasterProposalConfirm         = "confirm"
	MasterProposalStatusProposed  = "proposed"
	MasterProposalStatusValid     = "validated"
	MasterProposalStatusCandidate = "candidate_ready"
	MasterProposalStatusApplied   = "applied"
	MasterProposalStatusConflict  = "conflict"
	MasterProposalStatusRejected  = "rejected"
)

// MasterCASConflictError is returned when a Proposal no longer describes the
// current Master field. It is deliberately domain-specific so callers can
// render a conflict without exposing low-level filesystem details.
type MasterCASConflictError struct {
	MasterItemID         string `json:"master_item_id"`
	FieldPath            string `json:"field_path"`
	ExpectedRevision     string `json:"expected_revision,omitempty"`
	ActualRevision       string `json:"actual_revision,omitempty"`
	ExpectedSourceSHA256 string `json:"expected_source_sha256,omitempty"`
	ActualSourceSHA256   string `json:"actual_source_sha256,omitempty"`
	ExpectedVersion      string `json:"expected_translation_version,omitempty"`
	ActualVersion        string `json:"actual_translation_version,omitempty"`
}

func (e *MasterCASConflictError) Error() string {
	if e == nil {
		return "Master 字段版本已变化，请重新读取"
	}
	return fmt.Sprintf("Master 字段版本已变化：%s/%s", e.MasterItemID, e.FieldPath)
}

type MasterProposalPatch struct {
	FieldPath   string `json:"field_path"`
	Translation string `json:"translation"`
}

// MasterProposal is the durable, field-scoped operation record. It is not a
// replacement for Pipeline Status: status here describes the proposal/apply
// operation only, while pipeline status remains derived from Master + 8097.
type MasterProposal struct {
	SchemaVersion               int                 `json:"schema_version"`
	ProposalID                  string              `json:"proposal_id"`
	OperationID                 string              `json:"operation_id"`
	Kind                        string              `json:"kind"`
	Stage                       string              `json:"stage"`
	ApplyMode                   string              `json:"apply_mode"`
	Status                      string              `json:"status"`
	MasterItemID                string              `json:"master_item_id"`
	FieldPath                   string              `json:"field_path"`
	ImportID                    string              `json:"import_id"`
	Original                    string              `json:"original"`
	CurrentTranslation          string              `json:"current_translation,omitempty"`
	Patch                       MasterProposalPatch `json:"patch"`
	InputRevision               string              `json:"input_revision"`
	SourceSHA256                string              `json:"source_sha256"`
	BaseTranslationVersion      string              `json:"base_translation_version,omitempty"`
	Risk                        string              `json:"risk"`
	IssueCode                   string              `json:"issue_code,omitempty"`
	Reason                      string              `json:"reason,omitempty"`
	ProtectedTokenOverride      bool                `json:"protected_token_override,omitempty"`
	AgentRunID                  string              `json:"agent_run_id,omitempty"`
	RecoveryAttempt             int                 `json:"recovery_attempt,omitempty"`
	AppliedTranslationVersionID string              `json:"applied_translation_version_id,omitempty"`
	CreatedAt                   string              `json:"created_at"`
	UpdatedAt                   string              `json:"updated_at"`
}

// MasterTranslationMarkerMismatchError describes a protected-marker mismatch
// without echoing the original text, URLs, or user content into API errors.
// The UI already shows the source and candidate side by side, so category and
// count are enough to explain why strict validation stopped the operation.
type MasterTranslationMarkerMismatchError struct {
	MissingVariables int
	MissingLinks     int
	MissingNumbers   int
	ExtraVariables   int
	ExtraLinks       int
	ExtraNumbers     int
}

func (e *MasterTranslationMarkerMismatchError) Error() string {
	if e == nil {
		return "候选译文未保留原文中的变量、链接或数字标记"
	}
	missing := make([]string, 0, 3)
	if e.MissingVariables > 0 {
		missing = append(missing, fmt.Sprintf("变量 %d 个", e.MissingVariables))
	}
	if e.MissingLinks > 0 {
		missing = append(missing, fmt.Sprintf("链接 %d 个", e.MissingLinks))
	}
	if e.MissingNumbers > 0 {
		missing = append(missing, fmt.Sprintf("数字标记 %d 个", e.MissingNumbers))
	}
	extra := make([]string, 0, 3)
	if e.ExtraVariables > 0 {
		extra = append(extra, fmt.Sprintf("变量 %d 个", e.ExtraVariables))
	}
	if e.ExtraLinks > 0 {
		extra = append(extra, fmt.Sprintf("链接 %d 个", e.ExtraLinks))
	}
	if e.ExtraNumbers > 0 {
		extra = append(extra, fmt.Sprintf("数字标记 %d 个", e.ExtraNumbers))
	}
	parts := make([]string, 0, 2)
	if len(missing) > 0 {
		parts = append(parts, "缺少"+strings.Join(missing, "、"))
	}
	if len(extra) > 0 {
		parts = append(parts, "多出"+strings.Join(extra, "、"))
	}
	if len(parts) == 0 {
		return "候选译文未保留原文中的变量、链接或数字标记"
	}
	return "候选译文未保留原文中的变量、链接或数字标记：" + strings.Join(parts, "；")
}

type MasterProposalInput struct {
	OperationID            string `json:"operation_id"`
	Kind                   string `json:"kind"`
	Stage                  string `json:"stage"`
	ApplyMode              string `json:"apply_mode"`
	MasterItemID           string `json:"master_item_id"`
	FieldPath              string `json:"field_path"`
	Translation            string `json:"translation"`
	InputRevision          string `json:"input_revision"`
	SourceSHA256           string `json:"source_sha256"`
	BaseTranslationVersion string `json:"base_translation_version"`
	Risk                   string `json:"risk"`
	IssueCode              string `json:"issue_code"`
	Reason                 string `json:"reason"`
	AgentRunID             string `json:"agent_run_id"`
	RecoveryAttempt        int    `json:"recovery_attempt"`
}

type MasterProposalApplyResult struct {
	Proposal    MasterProposal               `json:"proposal"`
	Translation MasterTranslationApplyResult `json:"translation"`
}

type MasterProposalList struct {
	Proposals []MasterProposal `json:"proposals"`
}

type MasterProposalBatchResult struct {
	AppliedCount int                         `json:"applied_count"`
	Results      []MasterProposalBatchStatus `json:"results"`
}

type MasterProposalRejectResult struct {
	RejectedCount int                         `json:"rejected_count"`
	Results       []MasterProposalBatchStatus `json:"results"`
}

type MasterProposalBatchStatus struct {
	ProposalID           string `json:"proposal_id"`
	Status               string `json:"status"`
	Error                string `json:"error,omitempty"`
	TranslationVersionID string `json:"translation_version_id,omitempty"`
}

var masterProtectedTokenPattern = regexp.MustCompile(`\{\{[^{}\r\n]+\}\}|https?://[^\s]+|\b\d+(?:[.,]\d+)*\b`)

func (s *MasterLibraryStore) CreateMasterProposal(input MasterProposalInput) (MasterProposal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, field, err := s.loadMasterProposalTargetUnlocked(input.MasterItemID, input.FieldPath)
	if err != nil {
		return MasterProposal{}, err
	}
	kind := strings.ToLower(strings.TrimSpace(input.Kind))
	if kind != MasterProposalRecovery && kind != MasterProposalPolish {
		return MasterProposal{}, errors.New("Master Proposal 类型仅支持 recovery 或 polish")
	}
	applyMode := strings.ToLower(strings.TrimSpace(input.ApplyMode))
	if applyMode == "" {
		applyMode = MasterProposalConfirm
	}
	if applyMode != MasterProposalAuto && applyMode != MasterProposalConfirm {
		return MasterProposal{}, errors.New("Master Proposal 应用模式无效")
	}
	if kind == MasterProposalPolish && applyMode == MasterProposalAuto {
		return MasterProposal{}, errors.New("主动润色必须等待用户确认")
	}
	candidate := strings.TrimSpace(input.Translation)
	if candidate == "" {
		return MasterProposal{}, errors.New("Master Proposal 译文不能为空")
	}
	inputRevision := strings.TrimSpace(input.InputRevision)
	if inputRevision == "" {
		inputRevision = item.Revision
	}
	sourceSHA := strings.TrimSpace(input.SourceSHA256)
	if sourceSHA == "" {
		sourceSHA = field.SourceSHA256
	}
	baseVersion := strings.TrimSpace(input.BaseTranslationVersion)
	if baseVersion == "" {
		baseVersion = field.ActiveTranslationVersionID
	}
	importID, err := s.findMasterImportForFieldUnlocked(item.MasterItemID, input.FieldPath)
	if err != nil {
		return MasterProposal{}, err
	}
	if existing, found := s.findEquivalentMasterProposalUnlocked(
		item.MasterItemID,
		strings.TrimSpace(input.FieldPath),
		candidate,
		inputRevision,
		sourceSHA,
		baseVersion,
		kind,
		applyMode,
	); found {
		// Saving the same user candidate twice is idempotent. Reuse the durable
		// record instead of creating a second review row.
		return existing, nil
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	proposal := MasterProposal{
		SchemaVersion: masterProposalSchemaVersion,
		ProposalID:    uuid.NewString(), OperationID: strings.TrimSpace(input.OperationID),
		Kind: kind, Stage: strings.TrimSpace(input.Stage), ApplyMode: applyMode,
		Status: MasterProposalStatusProposed, MasterItemID: item.MasterItemID,
		FieldPath: strings.TrimSpace(input.FieldPath), ImportID: importID,
		Original: field.SourceText, CurrentTranslation: field.ActiveText,
		Patch:         MasterProposalPatch{FieldPath: strings.TrimSpace(input.FieldPath), Translation: candidate},
		InputRevision: inputRevision, SourceSHA256: sourceSHA, BaseTranslationVersion: baseVersion,
		Risk:      firstNonEmptyMasterValue(strings.TrimSpace(input.Risk), field.Risk),
		IssueCode: strings.TrimSpace(input.IssueCode), Reason: strings.TrimSpace(input.Reason),
		AgentRunID: strings.TrimSpace(input.AgentRunID), RecoveryAttempt: input.RecoveryAttempt,
		CreatedAt: now, UpdatedAt: now,
	}
	if proposal.OperationID == "" {
		proposal.OperationID = proposal.ProposalID
	}
	if err := s.writeMasterProposalUnlocked(proposal); err != nil {
		return MasterProposal{}, err
	}
	return proposal, nil
}

// RejectMasterProposal soft-deletes a review candidate. The Proposal file is
// retained for audit, while rejected candidates no longer enter the review UI.
func (s *MasterLibraryStore) RejectMasterProposal(proposalID string) (MasterProposal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	proposal, err := s.loadMasterProposalUnlocked(proposalID)
	if err != nil {
		return MasterProposal{}, err
	}
	if proposal.Status == MasterProposalStatusRejected {
		return proposal, nil
	}
	switch proposal.Status {
	case MasterProposalStatusProposed, MasterProposalStatusValid, MasterProposalStatusCandidate, MasterProposalStatusConflict:
		// Reviewable candidates may be dismissed without changing the Master item.
	default:
		return MasterProposal{}, fmt.Errorf("Proposal 当前状态不可删除: %s", proposal.Status)
	}
	proposal.Status = MasterProposalStatusRejected
	proposal.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.writeMasterProposalUnlocked(proposal); err != nil {
		return MasterProposal{}, err
	}
	return proposal, nil
}

func (s *MasterLibraryStore) RejectMasterProposals(masterItemID string, proposalIDs []string) MasterProposalRejectResult {
	result := MasterProposalRejectResult{Results: make([]MasterProposalBatchStatus, 0, len(proposalIDs))}
	seen := map[string]bool{}
	for _, proposalID := range proposalIDs {
		proposalID = strings.TrimSpace(proposalID)
		if proposalID == "" || seen[proposalID] {
			continue
		}
		seen[proposalID] = true
		status := MasterProposalBatchStatus{ProposalID: proposalID}
		proposal, err := s.GetMasterProposal(proposalID)
		if err == nil && proposal.MasterItemID != strings.TrimSpace(masterItemID) {
			err = errors.New("Proposal 不属于当前总库资产")
		}
		if err == nil {
			_, err = s.RejectMasterProposal(proposalID)
		}
		if err != nil {
			status.Status = MasterProposalStatusConflict
			status.Error = err.Error()
		} else {
			status.Status = MasterProposalStatusRejected
			result.RejectedCount++
		}
		result.Results = append(result.Results, status)
	}
	return result
}

func (s *MasterLibraryStore) GetMasterProposal(proposalID string) (MasterProposal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadMasterProposalUnlocked(proposalID)
}

func (s *MasterLibraryStore) ListMasterProposals(masterItemID string) (MasterProposalList, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(filepath.Join(s.workspace, filepath.FromSlash(masterProposalDir)))
	if errors.Is(err, os.ErrNotExist) {
		return MasterProposalList{Proposals: []MasterProposal{}}, nil
	}
	if err != nil {
		return MasterProposalList{}, err
	}
	result := make([]MasterProposal, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		var proposal MasterProposal
		data, readErr := os.ReadFile(filepath.Join(s.workspace, filepath.FromSlash(masterProposalDir), entry.Name()))
		if readErr != nil || json.Unmarshal(data, &proposal) != nil {
			continue
		}
		if strings.TrimSpace(masterItemID) != "" && proposal.MasterItemID != strings.TrimSpace(masterItemID) {
			continue
		}
		result = append(result, proposal)
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].UpdatedAt > result[j].UpdatedAt })
	return MasterProposalList{Proposals: result}, nil
}

func (s *MasterLibraryStore) ValidateMasterProposal(proposalID string) (MasterProposal, error) {
	return s.ValidateMasterProposalWithOptions(proposalID, false)
}

// ValidateMasterProposalWithOptions validates a proposal. Protected-marker
// mismatch can only be bypassed through an explicit human edit action; model
// and batch candidates continue to use the strict default above.
func (s *MasterLibraryStore) ValidateMasterProposalWithOptions(proposalID string, allowProtectedTokenMismatch bool) (MasterProposal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	proposal, err := s.loadMasterProposalUnlocked(proposalID)
	if err != nil {
		return MasterProposal{}, err
	}
	if proposal.Status != MasterProposalStatusProposed && proposal.Status != MasterProposalStatusValid {
		return MasterProposal{}, fmt.Errorf("Proposal 当前状态不可验证: %s", proposal.Status)
	}
	item, field, err := s.loadMasterProposalTargetUnlocked(proposal.MasterItemID, proposal.FieldPath)
	if err != nil {
		return MasterProposal{}, err
	}
	if err := validateMasterProposalCAS(proposal, item, field); err != nil {
		proposal.Status = MasterProposalStatusConflict
		proposal.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		_ = s.writeMasterProposalUnlocked(proposal)
		return MasterProposal{}, err
	}
	if err := validateMasterTranslationCandidate(field.SourceText, proposal.Patch.Translation); err != nil {
		var markerMismatch *MasterTranslationMarkerMismatchError
		if !allowProtectedTokenMismatch || !errors.As(err, &markerMismatch) {
			return MasterProposal{}, err
		}
		proposal.ProtectedTokenOverride = true
		proposal.Reason = strings.TrimSpace("人工确认允许保护标记不一致；" + proposal.Reason)
	}
	proposal.Status = MasterProposalStatusValid
	proposal.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.writeMasterProposalUnlocked(proposal); err != nil {
		return MasterProposal{}, err
	}
	return proposal, nil
}

// ApplyMasterProposal applies a validated/candidate Proposal. The first
// optional forceConflict flag is only for an explicit human approval of a
// stale conflict. The second optional flag permits a protected-marker
// mismatch for the same explicit human edit flow; validated proposals also
// retain that decision in ProtectedTokenOverride.
func (s *MasterLibraryStore) ApplyMasterProposal(proposalID string, confirmed bool, forceConflict ...bool) (MasterProposalApplyResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	allowForceConflict := len(forceConflict) > 0 && forceConflict[0]
	allowProtectedTokenMismatch := len(forceConflict) > 1 && forceConflict[1]
	proposal, err := s.loadMasterProposalUnlocked(proposalID)
	if err != nil {
		return MasterProposalApplyResult{}, err
	}
	wasConflict := proposal.Status == MasterProposalStatusConflict
	if !wasConflict && proposal.Status != MasterProposalStatusValid && proposal.Status != MasterProposalStatusCandidate {
		return MasterProposalApplyResult{}, fmt.Errorf("Proposal 当前状态不可应用: %s", proposal.Status)
	}
	item, field, err := s.loadMasterProposalTargetUnlocked(proposal.MasterItemID, proposal.FieldPath)
	if err != nil {
		return MasterProposalApplyResult{}, err
	}
	if wasConflict {
		if !allowForceConflict {
			return MasterProposalApplyResult{}, fmt.Errorf("Proposal 当前状态不可应用: %s", proposal.Status)
		}
		rebaseMasterProposalForForce(&proposal, item, field)
	}
	if err := validateMasterProposalCAS(proposal, item, field); err != nil {
		if !allowForceConflict {
			proposal.Status = MasterProposalStatusConflict
			proposal.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
			_ = s.writeMasterProposalUnlocked(proposal)
			return MasterProposalApplyResult{}, err
		}
		// The explicit approval also covers a race between the read above and
		// the apply. Re-read once and rebase to the newest field.
		item, field, err = s.loadMasterProposalTargetUnlocked(proposal.MasterItemID, proposal.FieldPath)
		if err != nil {
			return MasterProposalApplyResult{}, err
		}
		rebaseMasterProposalForForce(&proposal, item, field)
		if err := validateMasterProposalCAS(proposal, item, field); err != nil {
			return MasterProposalApplyResult{}, err
		}
	}
	if err := validateMasterTranslationCandidate(field.SourceText, proposal.Patch.Translation); err != nil {
		var markerMismatch *MasterTranslationMarkerMismatchError
		if !errors.As(err, &markerMismatch) || (!allowProtectedTokenMismatch && !proposal.ProtectedTokenOverride) {
			return MasterProposalApplyResult{}, err
		}
		if allowProtectedTokenMismatch && !proposal.ProtectedTokenOverride {
			proposal.ProtectedTokenOverride = true
			proposal.Reason = strings.TrimSpace("人工确认允许保护标记不一致；" + proposal.Reason)
		}
	}
	if proposal.Kind == MasterProposalPolish && proposal.ApplyMode == MasterProposalAuto {
		return MasterProposalApplyResult{}, errors.New("主动润色不允许自动应用")
	}
	if proposal.ApplyMode == MasterProposalAuto {
		if field.Risk == masterFieldRiskHigh || proposal.Kind != MasterProposalRecovery {
			return MasterProposalApplyResult{}, errors.New("当前 Proposal 不满足自动应用安全边界")
		}
		confirmed = true
	}
	translation, err := s.applyTranslationUnlocked(MasterTranslationApplyInput{
		ImportID: proposal.ImportID, MasterItemID: proposal.MasterItemID, FieldPath: proposal.FieldPath,
		SourceSHA256: proposal.SourceSHA256, InputRevision: proposal.InputRevision,
		BaseTranslationVersion: proposal.BaseTranslationVersion, Translation: proposal.Patch.Translation,
		Model: masterProposalModel(proposal.Kind), JobID: proposal.OperationID, Confirmed: confirmed,
		Candidate: proposal.Kind == MasterProposalPolish && !confirmed,
	})
	if err != nil {
		if _, ok := err.(*MasterCASConflictError); ok {
			proposal.Status = MasterProposalStatusConflict
			proposal.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
			_ = s.writeMasterProposalUnlocked(proposal)
		}
		return MasterProposalApplyResult{}, err
	}
	proposal.AppliedTranslationVersionID = translation.TranslationVersionID
	proposal.Status = MasterProposalStatusApplied
	if proposal.Kind == MasterProposalPolish && !confirmed {
		proposal.Status = MasterProposalStatusCandidate
	}
	proposal.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.writeMasterProposalUnlocked(proposal); err != nil {
		return MasterProposalApplyResult{}, err
	}
	if proposal.Status == MasterProposalStatusApplied {
		s.rejectSupersededMasterProposalsUnlocked(proposal)
	}
	return MasterProposalApplyResult{Proposal: proposal, Translation: translation}, nil
}

// ApplyMasterProposals applies selected proposals one by one. If an
// earlier proposal changed the parent revision, an untouched target field is
// rebased to that new parent revision before the existing CAS/apply path runs.
// A changed target field still fails CAS and is reported independently.
// High-risk proposals require confirmedHighRisk=true; without the explicit
// flag they are reported as requires_high_risk_confirmation and never applied.
func (s *MasterLibraryStore) ApplyMasterProposals(masterItemID string, proposalIDs []string, options ...bool) MasterProposalBatchResult {
	highRiskConfirmed := len(options) > 0 && options[0]
	allowForceConflict := len(options) > 1 && options[1]
	allowProtectedTokenMismatch := len(options) > 2 && options[2]
	result := MasterProposalBatchResult{Results: make([]MasterProposalBatchStatus, 0, len(proposalIDs))}
	seen := map[string]bool{}
	for _, proposalID := range proposalIDs {
		proposalID = strings.TrimSpace(proposalID)
		if proposalID == "" || seen[proposalID] {
			continue
		}
		seen[proposalID] = true
		status := MasterProposalBatchStatus{ProposalID: proposalID}
		proposal, err := s.GetMasterProposal(proposalID)
		if err == nil && proposal.MasterItemID != strings.TrimSpace(masterItemID) {
			err = errors.New("Proposal 不属于当前总库资产")
		}
		if err == nil && strings.EqualFold(strings.TrimSpace(proposal.Risk), masterFieldRiskHigh) && !highRiskConfirmed {
			err = errors.New("requires_high_risk_confirmation: 高风险 Proposal 需要显式确认")
		}
		if err == nil {
			s.rebaseUntouchedBatchProposal(proposalID)
			// Agent-created proposals are intentionally persisted as proposed until
			// the user confirms them in the shared review workbench. Batch apply is
			// that confirmation, so validate each proposal immediately before the
			// existing CAS/apply path instead of rejecting all proposed candidates.
			if proposal.Status == MasterProposalStatusProposed {
				_, err = s.ValidateMasterProposalWithOptions(proposalID, allowProtectedTokenMismatch)
			}
			if err == nil {
				_, err = s.ApplyMasterProposal(proposalID, true, allowForceConflict, allowProtectedTokenMismatch)
			}
		}
		if err != nil {
			status.Status = MasterProposalStatusConflict
			status.Error = err.Error()
		} else {
			status.Status = MasterProposalStatusApplied
			result.AppliedCount++
			applied, loadErr := s.GetMasterProposal(proposalID)
			if loadErr == nil {
				status.TranslationVersionID = applied.AppliedTranslationVersionID
			}
		}
		result.Results = append(result.Results, status)
	}
	return result
}

func rebaseMasterProposalForForce(proposal *MasterProposal, item MasterItem, field MasterField) {
	proposal.InputRevision = item.Revision
	proposal.SourceSHA256 = field.SourceSHA256
	proposal.BaseTranslationVersion = field.ActiveTranslationVersionID
	proposal.Original = field.SourceText
	proposal.CurrentTranslation = field.ActiveText
	proposal.Status = MasterProposalStatusValid
	proposal.Reason = strings.TrimSpace("人工批准并完成：覆盖当前版本；" + proposal.Reason)
	proposal.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
}

func (s *MasterLibraryStore) rebaseUntouchedBatchProposal(proposalID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	proposal, err := s.loadMasterProposalUnlocked(proposalID)
	if err != nil {
		return
	}
	item, field, err := s.loadMasterProposalTargetUnlocked(proposal.MasterItemID, proposal.FieldPath)
	if err != nil {
		return
	}
	if proposal.SourceSHA256 != field.SourceSHA256 || proposal.BaseTranslationVersion != field.ActiveTranslationVersionID || proposal.InputRevision == item.Revision {
		return
	}
	proposal.InputRevision = item.Revision
	proposal.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	_ = s.writeMasterProposalUnlocked(proposal)
}

func (s *MasterLibraryStore) loadMasterProposalTargetUnlocked(itemID, fieldPath string) (MasterItem, MasterField, error) {
	item, err := s.loadItemUnlocked(strings.TrimSpace(itemID))
	if err != nil {
		return MasterItem{}, MasterField{}, err
	}
	field, ok := item.Fields[strings.TrimSpace(fieldPath)]
	if !ok {
		return MasterItem{}, MasterField{}, errors.New("Master 字段路径不存在")
	}
	if !field.NeedsTranslation {
		return MasterItem{}, MasterField{}, errors.New("当前字段不需要翻译处理")
	}
	return item, field, nil
}

func (s *MasterLibraryStore) findMasterImportForFieldUnlocked(itemID, fieldPath string) (string, error) {
	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return "", err
	}
	for _, ref := range manifest.Imports {
		transaction, loadErr := s.loadImportUnlocked(ref.Path)
		if loadErr != nil {
			continue
		}
		for _, target := range transaction.TranslationTargets {
			if target.MasterItemID == itemID && target.FieldPath == fieldPath {
				return transaction.ImportID, nil
			}
		}
	}
	return "", errors.New("找不到该 Master 字段对应的导入事务")
}

func (s *MasterLibraryStore) loadMasterProposalUnlocked(proposalID string) (MasterProposal, error) {
	proposalID = strings.TrimSpace(proposalID)
	if proposalID == "" {
		return MasterProposal{}, errors.New("Proposal ID 不能为空")
	}
	if _, err := uuid.Parse(proposalID); err != nil {
		return MasterProposal{}, errors.New("Proposal ID 无效")
	}
	data, err := os.ReadFile(filepath.Join(s.workspace, filepath.FromSlash(masterProposalDir), proposalID+".json"))
	if err != nil {
		return MasterProposal{}, err
	}
	var proposal MasterProposal
	if err := json.Unmarshal(data, &proposal); err != nil {
		return MasterProposal{}, fmt.Errorf("Master Proposal 损坏: %w", err)
	}
	return proposal, nil
}

func (s *MasterLibraryStore) writeMasterProposalUnlocked(proposal MasterProposal) error {
	return s.writeJSONUnlocked(filepath.ToSlash(filepath.Join(masterProposalDir, proposal.ProposalID+".json")), proposal)
}

func masterProposalIsReviewable(status string) bool {
	switch status {
	case MasterProposalStatusProposed, MasterProposalStatusValid, MasterProposalStatusCandidate, MasterProposalStatusConflict:
		return true
	default:
		return false
	}
}

func masterProposalCanDeduplicate(status string) bool {
	return status == MasterProposalStatusProposed || status == MasterProposalStatusValid || status == MasterProposalStatusCandidate
}

func (s *MasterLibraryStore) findEquivalentMasterProposalUnlocked(masterItemID, fieldPath, translation, inputRevision, sourceSHA, baseVersion, kind, applyMode string) (MasterProposal, bool) {
	entries, err := os.ReadDir(filepath.Join(s.workspace, filepath.FromSlash(masterProposalDir)))
	if errors.Is(err, os.ErrNotExist) || err != nil {
		return MasterProposal{}, false
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(s.workspace, filepath.FromSlash(masterProposalDir), entry.Name()))
		if readErr != nil {
			continue
		}
		var proposal MasterProposal
		if json.Unmarshal(data, &proposal) != nil || !masterProposalCanDeduplicate(proposal.Status) {
			continue
		}
		if proposal.MasterItemID == masterItemID && proposal.FieldPath == fieldPath &&
			proposal.Patch.Translation == translation && proposal.InputRevision == inputRevision &&
			proposal.SourceSHA256 == sourceSHA && proposal.BaseTranslationVersion == baseVersion &&
			proposal.Kind == kind && proposal.ApplyMode == applyMode {
			return proposal, true
		}
	}
	return MasterProposal{}, false
}

func (s *MasterLibraryStore) rejectSupersededMasterProposalsUnlocked(applied MasterProposal) {
	entries, err := os.ReadDir(filepath.Join(s.workspace, filepath.FromSlash(masterProposalDir)))
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" || entry.Name() == applied.ProposalID+".json" {
			continue
		}
		path := filepath.Join(s.workspace, filepath.FromSlash(masterProposalDir), entry.Name())
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			continue
		}
		var sibling MasterProposal
		if json.Unmarshal(data, &sibling) != nil || !masterProposalIsReviewable(sibling.Status) {
			continue
		}
		if sibling.MasterItemID != applied.MasterItemID || sibling.FieldPath != applied.FieldPath || sibling.SourceSHA256 != applied.SourceSHA256 {
			continue
		}
		sibling.Status = MasterProposalStatusRejected
		sibling.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		sibling.Reason = strings.TrimSpace("已由候选 " + applied.ProposalID + " 应用覆盖；" + sibling.Reason)
		_ = s.writeMasterProposalUnlocked(sibling)
	}
}

func validateMasterProposalCAS(proposal MasterProposal, item MasterItem, field MasterField) error {
	if proposal.MasterItemID != item.MasterItemID || proposal.FieldPath != proposal.Patch.FieldPath {
		return errors.New("Proposal 目标字段不一致")
	}
	if proposal.InputRevision != item.Revision {
		return &MasterCASConflictError{MasterItemID: item.MasterItemID, FieldPath: proposal.FieldPath, ExpectedRevision: proposal.InputRevision, ActualRevision: item.Revision}
	}
	if proposal.SourceSHA256 != field.SourceSHA256 {
		return &MasterCASConflictError{MasterItemID: item.MasterItemID, FieldPath: proposal.FieldPath, ExpectedSourceSHA256: proposal.SourceSHA256, ActualSourceSHA256: field.SourceSHA256}
	}
	if proposal.BaseTranslationVersion != field.ActiveTranslationVersionID {
		return &MasterCASConflictError{MasterItemID: item.MasterItemID, FieldPath: proposal.FieldPath, ExpectedVersion: proposal.BaseTranslationVersion, ActualVersion: field.ActiveTranslationVersionID}
	}
	return nil
}

func validateMasterTranslationCandidate(original, candidate string) error {
	if strings.TrimSpace(candidate) == "" {
		return errors.New("候选译文不能为空")
	}
	originalTokens := masterProtectedTokenPattern.FindAllString(original, -1)
	candidateTokens := masterProtectedTokenPattern.FindAllString(candidate, -1)
	if !sameMasterTokenMultiset(originalTokens, candidateTokens) {
		missing, extra := masterProtectedTokenDiff(originalTokens, candidateTokens)
		return &MasterTranslationMarkerMismatchError{
			MissingVariables: missing.Variables,
			MissingLinks:     missing.Links,
			MissingNumbers:   missing.Numbers,
			ExtraVariables:   extra.Variables,
			ExtraLinks:       extra.Links,
			ExtraNumbers:     extra.Numbers,
		}
	}
	return nil
}

type masterProtectedTokenCounts struct {
	Variables int
	Links     int
	Numbers   int
}

func masterProtectedTokenDiff(original, candidate []string) (masterProtectedTokenCounts, masterProtectedTokenCounts) {
	originalCounts := map[string]int{}
	candidateCounts := map[string]int{}
	for _, token := range original {
		originalCounts[token]++
	}
	for _, token := range candidate {
		candidateCounts[token]++
	}
	var missing, extra masterProtectedTokenCounts
	for token, count := range originalCounts {
		if difference := count - candidateCounts[token]; difference > 0 {
			addMasterProtectedTokenCount(&missing, token, difference)
		}
	}
	for token, count := range candidateCounts {
		if difference := count - originalCounts[token]; difference > 0 {
			addMasterProtectedTokenCount(&extra, token, difference)
		}
	}
	return missing, extra
}

func addMasterProtectedTokenCount(counts *masterProtectedTokenCounts, token string, amount int) {
	switch {
	case strings.HasPrefix(token, "{{"):
		counts.Variables += amount
	case strings.HasPrefix(token, "http://"), strings.HasPrefix(token, "https://"):
		counts.Links += amount
	default:
		counts.Numbers += amount
	}
}

func sameMasterTokenMultiset(left, right []string) bool {
	counts := map[string]int{}
	for _, token := range left {
		counts[token]++
	}
	for _, token := range right {
		counts[token]--
	}
	for _, count := range counts {
		if count != 0 {
			return false
		}
	}
	for _, token := range right {
		if counts[token] != 0 {
			return false
		}
	}
	return true
}

func masterProposalModel(kind string) string {
	if kind == MasterProposalPolish {
		return "denova-agent-polish"
	}
	return "denova-agent-recovery"
}

func firstNonEmptyMasterValue(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return "safe"
}
