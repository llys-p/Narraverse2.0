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
	AgentRunID                  string              `json:"agent_run_id,omitempty"`
	RecoveryAttempt             int                 `json:"recovery_attempt,omitempty"`
	AppliedTranslationVersionID string              `json:"applied_translation_version_id,omitempty"`
	CreatedAt                   string              `json:"created_at"`
	UpdatedAt                   string              `json:"updated_at"`
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
		return MasterProposal{}, err
	}
	proposal.Status = MasterProposalStatusValid
	proposal.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.writeMasterProposalUnlocked(proposal); err != nil {
		return MasterProposal{}, err
	}
	return proposal, nil
}

func (s *MasterLibraryStore) ApplyMasterProposal(proposalID string, confirmed bool) (MasterProposalApplyResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	proposal, err := s.loadMasterProposalUnlocked(proposalID)
	if err != nil {
		return MasterProposalApplyResult{}, err
	}
	if proposal.Status != MasterProposalStatusValid && proposal.Status != MasterProposalStatusCandidate {
		return MasterProposalApplyResult{}, fmt.Errorf("Proposal 当前状态不可应用: %s", proposal.Status)
	}
	item, field, err := s.loadMasterProposalTargetUnlocked(proposal.MasterItemID, proposal.FieldPath)
	if err != nil {
		return MasterProposalApplyResult{}, err
	}
	if err := validateMasterProposalCAS(proposal, item, field); err != nil {
		proposal.Status = MasterProposalStatusConflict
		proposal.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		_ = s.writeMasterProposalUnlocked(proposal)
		return MasterProposalApplyResult{}, err
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
	return MasterProposalApplyResult{Proposal: proposal, Translation: translation}, nil
}

// ApplyMasterProposals applies selected low-risk proposals one by one. If an
// earlier proposal changed the parent revision, an untouched target field is
// rebased to that new parent revision before the existing CAS/apply path runs.
// A changed target field still fails CAS and is reported independently.
func (s *MasterLibraryStore) ApplyMasterProposals(masterItemID string, proposalIDs []string) MasterProposalBatchResult {
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
		if err == nil && strings.EqualFold(strings.TrimSpace(proposal.Risk), masterFieldRiskHigh) {
			err = errors.New("高风险 Proposal 需要单独确认")
		}
		if err == nil {
			s.rebaseUntouchedBatchProposal(proposalID)
			_, err = s.ApplyMasterProposal(proposalID, true)
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

func (s *MasterLibraryStore) rebaseUntouchedBatchProposal(proposalID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	proposal, err := s.loadMasterProposalUnlocked(proposalID)
	if err != nil {
		return
	}
	item, field, err := s.loadMasterProposalTargetUnlocked(proposal.MasterItemID, proposal.FieldPath)
	if err != nil || proposal.SourceSHA256 != field.SourceSHA256 || proposal.BaseTranslationVersion != field.ActiveTranslationVersionID || proposal.InputRevision == item.Revision {
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
		return errors.New("候选译文未保留原文中的变量、链接或数字标记")
	}
	return nil
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
