package book

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const masterTranslationRuntimeURL = "http://127.0.0.1:8097/api/denova/translator/jobs"

type MasterTranslationTaskStatus string

const (
	MasterTaskQueued    MasterTranslationTaskStatus = "queued"
	MasterTaskRunning   MasterTranslationTaskStatus = "running"
	MasterTaskPaused    MasterTranslationTaskStatus = "paused"
	MasterTaskFailed    MasterTranslationTaskStatus = "failed"
	MasterTaskCompleted MasterTranslationTaskStatus = "completed"
	MasterTaskRetrying  MasterTranslationTaskStatus = "retrying"
	MasterTaskCancelled MasterTranslationTaskStatus = "cancelled"
)

type MasterTranslationFieldRuntime struct {
	FieldPath            string                      `json:"field_path"`
	TaskStatus           MasterTranslationTaskStatus `json:"task_status"`
	ContentVersionStatus string                      `json:"content_version_status"`
	TranslationVersion   string                      `json:"translation_version,omitempty"`
	FailureReason        string                      `json:"failure_reason,omitempty"`
	ReviewRequired       bool                        `json:"review_required"`
	InputRevision        string                      `json:"input_revision,omitempty"`
	SourceSHA256         string                      `json:"source_sha256,omitempty"`
	TaskID               string                      `json:"task_id,omitempty"`
	Model                string                      `json:"model,omitempty"`
	Attempts             int                         `json:"attempts,omitempty"`
	UpdatedAt            string                      `json:"updated_at,omitempty"`
	FinalFailure         bool                        `json:"final_failure"`
	RecoveryStatus       string                      `json:"recovery_status,omitempty"`
	CandidateTranslation string                      `json:"candidate_translation,omitempty"`
	QualityStatus        string                      `json:"quality_status,omitempty"`
	QualityCodes         []string                    `json:"quality_codes,omitempty"`
	QualityReason        string                      `json:"quality_reason,omitempty"`
}

type MasterTranslationRuntime struct {
	Fields           []MasterTranslationFieldRuntime `json:"fields"`
	ActiveFields     int                             `json:"active_fields"`
	TotalFields      int                             `json:"total_fields"`
	ReviewFields     int                             `json:"review_fields"`
	FailedFields     int                             `json:"failed_fields"`
	CancelledFields  int                             `json:"cancelled_fields"`
	QueuePaused      bool                            `json:"queue_paused"`
	RuntimeAvailable bool                            `json:"runtime_available"`
	RuntimeError     string                          `json:"runtime_error,omitempty"`
}

type masterQueueJob struct {
	ID                 string   `json:"id"`
	MasterItemID       string   `json:"master_item_id"`
	Field              string   `json:"field"`
	SourceSHA256       string   `json:"source_sha256"`
	BaseRevision       string   `json:"base_revision"`
	SourceRevision     string   `json:"source_revision"`
	Status             string   `json:"status"`
	ApplyPolicy        string   `json:"apply_policy"`
	Error              string   `json:"error"`
	Model              string   `json:"model"`
	Attempts           int      `json:"attempts"`
	UpdatedAt          string   `json:"updated_at"`
	Translation        string   `json:"translation"`
	QualityStatus      string   `json:"quality_status"`
	QualityCodes       []string `json:"quality_codes"`
	QualityReason      string   `json:"quality_reason"`
	QualityContractVer int      `json:"quality_contract_version"`
}

type masterQueueSnapshot struct {
	OK     bool             `json:"ok"`
	Paused bool             `json:"paused"`
	Jobs   []masterQueueJob `json:"jobs"`
}

// MasterAssetQueueOperationResult is deliberately count-based: callers need
// the outcome, not the contents of any translation task.
type MasterAssetQueueOperationResult struct {
	MasterItemID   string `json:"master_item_id"`
	StoppedFields  int    `json:"stopped_fields"`
	CancelledTasks int    `json:"cancelled_tasks"`
	DeletedTasks   int    `json:"deleted_tasks"`
	PendingTasks   int    `json:"pending_tasks"`
	QueueAvailable bool   `json:"queue_available"`
	QueueError     string `json:"queue_error,omitempty"`
}

// StopMasterAssetTranslation records a deliberate stop for pending Master
// targets, then best-effort cancels the matching live queue jobs. A stopped
// asset remains retryable through the existing field retry action.
func (s *MasterLibraryStore) StopMasterAssetTranslation(masterItemID string) (MasterAssetQueueOperationResult, error) {
	masterItemID = strings.TrimSpace(masterItemID)
	if masterItemID == "" {
		return MasterAssetQueueOperationResult{}, fmt.Errorf("总库资产 ID 不能为空")
	}
	stoppedFields, err := s.markMasterAssetTranslationCancelled(masterItemID)
	if err != nil {
		return MasterAssetQueueOperationResult{}, err
	}
	result := MasterAssetQueueOperationResult{MasterItemID: masterItemID, StoppedFields: stoppedFields}
	queue, queueErr := fetchMasterQueue()
	if queueErr != nil {
		result.QueueError = queueErr.Error()
		return result, nil
	}
	result.QueueAvailable = true
	for _, job := range queue.Jobs {
		if job.MasterItemID != masterItemID || !masterQueueJobCanStop(job.Status) {
			continue
		}
		if actionErr := masterQueueJobAction(job.ID, "cancel"); actionErr != nil {
			result.QueueError = actionErr.Error()
			continue
		}
		result.CancelledTasks++
	}
	return result, nil
}

// RemoveMasterAsset stops and removes this asset's queue jobs where possible,
// then archives the Master asset. Queue availability never blocks the safe
// index removal; QueueError tells the UI when the bridge was unavailable.
func (s *MasterLibraryStore) RemoveMasterAsset(masterItemID string) (MasterAssetQueueOperationResult, MasterAssetArchiveResult, error) {
	queueResult, err := s.StopMasterAssetTranslation(masterItemID)
	if err != nil {
		return MasterAssetQueueOperationResult{}, MasterAssetArchiveResult{}, err
	}
	if queueResult.QueueAvailable {
		queue, queueErr := fetchMasterQueue()
		if queueErr != nil {
			queueResult.QueueError = queueErr.Error()
		} else {
			for _, job := range queue.Jobs {
				if job.MasterItemID != strings.TrimSpace(masterItemID) || job.Status == "running" || job.Status == "applied" || job.Status == "deleted" {
					if job.MasterItemID == strings.TrimSpace(masterItemID) && job.Status == "running" {
						queueResult.PendingTasks++
					}
					continue
				}
				if actionErr := masterQueueJobAction(job.ID, "delete"); actionErr != nil {
					queueResult.QueueError = actionErr.Error()
					continue
				}
				queueResult.DeletedTasks++
			}
		}
	}
	archiveResult, err := s.ArchiveMasterAsset(masterItemID)
	if err != nil {
		return queueResult, MasterAssetArchiveResult{}, err
	}
	return queueResult, archiveResult, nil
}

func (s *MasterLibraryStore) markMasterAssetTranslationCancelled(masterItemID string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return 0, err
	}
	found := false
	for _, ref := range manifest.Items {
		if ref.MasterItemID == masterItemID && ref.RecordKind != "worldbook_entry" {
			found = true
			break
		}
	}
	if !found {
		return 0, fmt.Errorf("总库资产不存在")
	}
	changed := 0
	for index := range manifest.Imports {
		ref := manifest.Imports[index]
		transaction, loadErr := s.loadImportUnlocked(ref.Path)
		if loadErr != nil {
			continue
		}
		transactionChanged := false
		for targetIndex := range transaction.TranslationTargets {
			target := &transaction.TranslationTargets[targetIndex]
			if target.MasterItemID != masterItemID || target.Status != "pending_translation" {
				continue
			}
			target.Status = "cancelled"
			transactionChanged = true
			changed++
		}
		if !transactionChanged {
			continue
		}
		transaction.Status = "cancelled"
		for _, target := range transaction.TranslationTargets {
			if target.Status == "pending_translation" {
				transaction.Status = "pending_translation"
				break
			}
		}
		transaction.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		if err := s.writeJSONUnlocked(ref.Path, transaction); err != nil {
			return changed, err
		}
		manifest.Imports[index].Status = transaction.Status
	}
	if changed > 0 {
		if err := s.saveManifestUnlocked(manifest); err != nil {
			return changed, err
		}
	}
	return changed, nil
}

func masterQueueJobCanStop(status string) bool {
	switch status {
	case "queued", "running", "paused", "retrying":
		return true
	default:
		return false
	}
}

func masterQueueJobAction(jobID, action string) error {
	if action != "cancel" && action != "delete" {
		return fmt.Errorf("不支持的翻译队列操作")
	}
	endpoint := masterTranslationRuntimeURL + "/" + url.PathEscape(strings.TrimSpace(jobID)) + "/" + action
	client := &http.Client{Timeout: 3 * time.Second}
	request, err := http.NewRequest(http.MethodPost, endpoint, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("翻译队列操作失败: %w", err)
	}
	defer response.Body.Close()
	var payload struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return fmt.Errorf("翻译队列操作响应无效: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || !payload.OK {
		if payload.Error == "" {
			payload.Error = fmt.Sprintf("HTTP %d", response.StatusCode)
		}
		return fmt.Errorf("翻译队列操作失败: %s", payload.Error)
	}
	return nil
}

// GetAssetRuntime is a backend read projection. It merges the durable Master
// detail with the live 8097 queue and never writes queue state into Master.
func (s *MasterLibraryStore) GetAssetRuntime(masterItemID string) (MasterTranslationRuntime, error) {
	detail, err := s.GetAsset(masterItemID)
	if err != nil {
		return MasterTranslationRuntime{}, err
	}
	queue, queueErr := fetchMasterQueue()
	runtime := buildMasterTranslationRuntime(detail, queue)
	for index := range runtime.Fields {
		field := &runtime.Fields[index]
		if field.TaskStatus != MasterTaskFailed && field.TaskStatus != MasterTaskRetrying {
			continue
		}
		claim, claimErr := s.GetMasterRecoveryClaimForField(detail.Summary.MasterItemID, field.FieldPath, field.InputRevision, field.SourceSHA256)
		if claimErr == nil {
			field.RecoveryStatus = claim.Status
			markRecoveredRuntimeField(field, claim)
			if field.TaskStatus == MasterTaskCompleted {
				continue
			}
		}
		if !field.FinalFailure {
			field.RecoveryStatus = MasterRecoveryWaitingRuntime
			continue
		}
		if claimErr != nil {
			field.RecoveryStatus = MasterRecoveryEligible
		}
	}
	runtime.FailedFields = 0
	for _, field := range runtime.Fields {
		if field.TaskStatus == MasterTaskFailed {
			runtime.FailedFields++
		}
		if field.TaskStatus == MasterTaskCancelled {
			runtime.CancelledFields++
		}
	}
	if queueErr != nil {
		runtime.RuntimeAvailable = false
		runtime.RuntimeError = queueErr.Error()
	}
	return runtime, nil
}

func markRecoveredRuntimeField(field *MasterTranslationFieldRuntime, claim MasterRecoveryClaim) {
	if field == nil || claim.Status != MasterRecoveryRecovered || field.TranslationVersion == claim.BaseTranslationVersion {
		return
	}
	// Keep the failed queue job and its diagnostics, but expose the current
	// Master version as completed after verified Recovery.
	field.TaskStatus = MasterTaskCompleted
	field.FinalFailure = false
}

func fetchMasterQueue() (masterQueueSnapshot, error) {
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Get(masterTranslationRuntimeURL)
	if err != nil {
		return masterQueueSnapshot{}, fmt.Errorf("读取翻译运行队列失败: %w", err)
	}
	defer response.Body.Close()
	var queue masterQueueSnapshot
	if err := json.NewDecoder(response.Body).Decode(&queue); err != nil {
		return masterQueueSnapshot{}, fmt.Errorf("翻译运行队列响应无效: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || !queue.OK {
		return queue, fmt.Errorf("翻译运行队列暂不可用（HTTP %d）", response.StatusCode)
	}
	return queue, nil
}

func buildMasterTranslationRuntime(detail MasterAssetDetail, queue masterQueueSnapshot) MasterTranslationRuntime {
	fields := make([]MasterTranslationFieldRuntime, 0, len(detail.Item.Fields))
	for fieldPath, field := range detail.Item.Fields {
		if !field.NeedsTranslation {
			continue
		}
		jobs := make([]masterQueueJob, 0)
		for _, job := range queue.Jobs {
			if job.MasterItemID == detail.Summary.MasterItemID && job.Field == fieldPath {
				jobs = append(jobs, job)
			}
		}
		sort.SliceStable(jobs, func(i, j int) bool { return jobs[i].UpdatedAt < jobs[j].UpdatedAt })
		var job *masterQueueJob
		if len(jobs) > 0 {
			job = &jobs[len(jobs)-1]
		}
		var version *MasterTranslationVersionView
		if field.ActiveTranslationVersionID != "" {
			for index := range detail.Translations {
				if detail.Translations[index].Version.TranslationVersionID == field.ActiveTranslationVersionID {
					version = &detail.Translations[index]
					break
				}
			}
		}
		status := masterTaskStatus(job, field.ActiveTranslationVersionID != "")
		entry := MasterTranslationFieldRuntime{
			FieldPath: fieldPath, TaskStatus: status,
			ContentVersionStatus: masterRuntimeContentVersionStatus(field, version),
			TranslationVersion:   field.ActiveTranslationVersionID, ReviewRequired: job != nil && job.Status == "pending_review",
			InputRevision: detail.Item.Revision, SourceSHA256: field.SourceSHA256,
		}
		if job != nil {
			entry.FailureReason, entry.TaskID, entry.Model = job.Error, job.ID, job.Model
			entry.Attempts, entry.UpdatedAt = job.Attempts, job.UpdatedAt
			entry.FinalFailure = masterFinalFailure(job, queue.Paused)
			if job.BaseRevision != "" {
				entry.InputRevision = job.BaseRevision
			}
			entry.CandidateTranslation = job.Translation
			entry.QualityStatus = job.QualityStatus
			entry.QualityCodes = job.QualityCodes
			entry.QualityReason = job.QualityReason
		}
		if version != nil && entry.Model == "" {
			entry.Model = version.Version.Model
		}
		fields = append(fields, entry)
	}
	sort.SliceStable(fields, func(i, j int) bool { return fields[i].FieldPath < fields[j].FieldPath })
	runtime := MasterTranslationRuntime{Fields: fields, TotalFields: len(fields), QueuePaused: queue.Paused, RuntimeAvailable: true}
	for _, field := range fields {
		if field.ContentVersionStatus != "original" {
			runtime.ActiveFields++
		}
		if field.ReviewRequired {
			runtime.ReviewFields++
		}
		if field.TaskStatus == MasterTaskFailed {
			runtime.FailedFields++
		}
	}
	return runtime
}

func masterFinalFailure(job *masterQueueJob, queuePaused bool) bool {
	if job == nil || queuePaused || job.Status != "failed" || job.Attempts < 1 || strings.TrimSpace(job.UpdatedAt) == "" {
		return false
	}
	updatedAt, err := time.Parse(time.RFC3339Nano, job.UpdatedAt)
	if err != nil {
		return false
	}
	return time.Since(updatedAt) >= 5*time.Second
}

func masterTaskStatus(job *masterQueueJob, active bool) MasterTranslationTaskStatus {
	if job == nil {
		if active {
			return MasterTaskCompleted
		}
		return MasterTaskQueued
	}
	switch job.Status {
	case "queued":
		return MasterTaskQueued
	case "running":
		return MasterTaskRunning
	case "paused":
		return MasterTaskPaused
	case "failed", "conflict":
		return MasterTaskFailed
	case "cancelled":
		return MasterTaskCancelled
	case "completed", "pending_review", "applied":
		return MasterTaskCompleted
	default:
		return MasterTaskRetrying
	}
}

func masterVersionKind(version *MasterTranslationVersionView) string {
	if version == nil {
		return "original"
	}
	return version.ContentVersionKind
}

func masterRuntimeContentVersionStatus(field MasterField, version *MasterTranslationVersionView) string {
	if version != nil {
		return version.ContentVersionKind
	}
	switch field.ActiveKind {
	case "hy_mt_active", "polish_candidate", "polished_active":
		return field.ActiveKind
	default:
		return "original"
	}
}

func (s MasterTranslationRuntime) String() string {
	return strings.TrimSpace(fmt.Sprintf("%d/%d", s.ActiveFields, s.TotalFields))
}
