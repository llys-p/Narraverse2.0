package book

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	MasterAvailabilityStaging = "staging"
	MasterAvailabilityUsable  = "usable"
	masterPipelineWaiting     = "waiting"
	masterPipelineCompleted   = "completed"
	masterPipelineWarning     = "warning"
	masterPipelineReview      = "review_required"
	masterPipelineFailed      = "failed"
	masterPipelineStale       = "stale"
	masterPipelineSkipped     = "skipped"
)

type MasterAssetQuery struct {
	Query        string
	RecordKind   string
	SemanticType string
	Availability string
	Limit        int
	Offset       int
}

type MasterAssetList struct {
	Assets []MasterAssetSummary `json:"assets"`
	Total  int                  `json:"total"`
}

type MasterAssetSummary struct {
	MasterItemID     string               `json:"master_item_id"`
	Name             string               `json:"name"`
	Tags             []string             `json:"tags,omitempty"`
	Description      string               `json:"description,omitempty"`
	AvatarURL        string               `json:"avatar_url,omitempty"`
	NestedEntryCount int                  `json:"nested_entry_count"`
	RecordKind       string               `json:"record_kind"`
	SemanticType     string               `json:"semantic_type"`
	SourceID         string               `json:"source_id"`
	SourceName       string               `json:"source_name"`
	SourceRevision   string               `json:"source_revision"`
	MasterRevision   string               `json:"master_revision"`
	Availability     string               `json:"availability"`
	UsageCount       int                  `json:"usage_count"`
	Pipeline         MasterPipelineStatus `json:"pipeline"`
}

type MasterAssetDetail struct {
	Summary        MasterAssetSummary             `json:"summary"`
	Item           MasterItem                     `json:"item"`
	Source         MasterSourceRecord             `json:"source"`
	SourceRevision MasterSourceRevision           `json:"source_revision"`
	Translations   []MasterTranslationVersionView `json:"translations"`
	Usages         []MasterInstanceRef            `json:"usages"`
}

type MasterTranslationVersionView struct {
	Version            MasterTranslationVersion `json:"version"`
	ContentVersionKind string                   `json:"content_version_kind"`
}

type MasterPipelineStatus struct {
	Availability string                  `json:"availability"`
	Nodes        []MasterPipelineNode    `json:"nodes"`
	Issues       []MasterPipelineIssue   `json:"issues"`
	Translation  MasterTranslationStatus `json:"translation"`
	UsageCount   int                     `json:"usage_count"`
}

type MasterPipelineNode struct {
	Key            string   `json:"key"`
	Status         string   `json:"status"`
	InputRevision  string   `json:"input_revision,omitempty"`
	OutputRevision string   `json:"output_revision,omitempty"`
	Inferred       bool     `json:"inferred"`
	Reason         string   `json:"reason,omitempty"`
	IssueIDs       []string `json:"issue_ids,omitempty"`
}

type MasterPipelineIssue struct {
	ID       string `json:"id"`
	Stage    string `json:"stage"`
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Blocking bool   `json:"blocking"`
	Message  string `json:"message"`
	Reason   string `json:"reason,omitempty"`
}

type MasterTranslationStatus struct {
	TotalFields        int            `json:"total_fields"`
	ActiveFields       int            `json:"active_fields"`
	PendingFields      int            `json:"pending_fields"`
	ReviewFields       int            `json:"review_fields"`
	FailedFields       int            `json:"failed_fields"`
	ContentVersionKind map[string]int `json:"content_version_kind"`
}

// ListAssets is a read-only projection over the existing Master manifest and
// item files. The first version intentionally uses a bounded linear scan;
// ponytail: add a persisted search index only when asset counts make this
// scan measurably too slow.
func (s *MasterLibraryStore) ListAssets(query MasterAssetQuery) (MasterAssetList, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return MasterAssetList{}, err
	}
	assets := make([]MasterAssetSummary, 0, len(manifest.Items))
	for _, ref := range manifest.Items {
		if ref.RecordKind == "worldbook_entry" {
			continue
		}
		item, loadErr := s.loadItemUnlocked(ref.MasterItemID)
		if loadErr != nil {
			return MasterAssetList{}, loadErr
		}
		asset := s.buildAssetSummaryUnlocked(manifest, item)
		if !masterAssetMatches(asset, query) {
			continue
		}
		assets = append(assets, asset)
	}
	sort.SliceStable(assets, func(i, j int) bool {
		left, right := strings.ToLower(assets[i].Name), strings.ToLower(assets[j].Name)
		if left == right {
			return assets[i].MasterItemID < assets[j].MasterItemID
		}
		return left < right
	})
	total := len(assets)
	offset := query.Offset
	if offset < 0 {
		offset = 0
	}
	if offset >= total {
		return MasterAssetList{Assets: []MasterAssetSummary{}, Total: total}, nil
	}
	limit := query.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	end := offset + limit
	if end > total {
		end = total
	}
	return MasterAssetList{Assets: assets[offset:end], Total: total}, nil
}

func (s *MasterLibraryStore) GetAsset(masterItemID string) (MasterAssetDetail, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	manifest, err := s.loadManifestUnlocked()
	if err != nil {
		return MasterAssetDetail{}, err
	}
	masterItemID = strings.TrimSpace(masterItemID)
	active := false
	for _, ref := range manifest.Items {
		if ref.MasterItemID == masterItemID && ref.RecordKind != "worldbook_entry" {
			active = true
			break
		}
	}
	if !active {
		return MasterAssetDetail{}, os.ErrNotExist
	}
	item, err := s.loadItemUnlocked(masterItemID)
	if err != nil {
		return MasterAssetDetail{}, err
	}
	source, revision, ok := masterSourceAndRevision(manifest, item.SourceID, item.SourceRevision)
	if !ok {
		return MasterAssetDetail{}, errors.New("总库资产来源或版本不存在")
	}
	translations := make([]MasterTranslationVersionView, 0)
	for _, ref := range manifest.Translations {
		if ref.MasterItemID != item.MasterItemID {
			continue
		}
		var version MasterTranslationVersion
		data, readErr := os.ReadFile(filepath.Join(s.workspace, filepath.FromSlash(ref.Path)))
		if readErr != nil {
			continue
		}
		if jsonErr := json.Unmarshal(data, &version); jsonErr != nil {
			continue
		}
		translations = append(translations, MasterTranslationVersionView{
			Version: version, ContentVersionKind: masterContentVersionKind(version),
		})
	}
	usages := make([]MasterInstanceRef, 0)
	for _, usage := range manifest.Instances {
		if usage.MasterItemID == item.MasterItemID {
			usages = append(usages, usage)
		}
	}
	summary := s.buildAssetSummaryUnlocked(manifest, item)
	return MasterAssetDetail{
		Summary: summary, Item: item, Source: source, SourceRevision: revision,
		Translations: translations, Usages: usages,
	}, nil
}

func (s *MasterLibraryStore) GetAssetPipeline(masterItemID string) (MasterPipelineStatus, error) {
	detail, err := s.GetAsset(masterItemID)
	if err != nil {
		return MasterPipelineStatus{}, err
	}
	return detail.Summary.Pipeline, nil
}

func (s *MasterLibraryStore) buildAssetSummaryUnlocked(manifest MasterLibraryManifest, item MasterItem) MasterAssetSummary {
	source, revision, found := masterSourceAndRevision(manifest, item.SourceID, item.SourceRevision)
	status := deriveMasterPipeline(s.workspace, item, source, revision, found, manifest)
	return MasterAssetSummary{
		MasterItemID: item.MasterItemID, Name: masterItemDisplayName(item), Tags: masterItemTags(item), Description: masterItemDescription(item),
		AvatarURL:        masterCharacterAvatarURL(item, revision, found),
		NestedEntryCount: len(item.NestedEntries), RecordKind: item.RecordKind,
		SemanticType: item.SemanticType, SourceID: item.SourceID, SourceName: source.Filename,
		SourceRevision: item.SourceRevision, MasterRevision: item.Revision,
		Availability: status.Availability, UsageCount: status.UsageCount, Pipeline: status,
	}
}

func masterCharacterAvatarURL(item MasterItem, revision MasterSourceRevision, found bool) string {
	if item.RecordKind != "character_template" || !found || !strings.EqualFold(filepath.Ext(revision.OriginalPath), ".png") {
		return ""
	}
	// Master item IDs are generated UUIDs. Keeping this URL relative lets the
	// browser use the current Denova origin without exposing the archive path.
	return "/api/library/assets/" + item.MasterItemID + "/avatar"
}

func masterItemTags(item MasterItem) []string {
	if item.RecordKind != "character_template" {
		return nil
	}
	if field, found := item.Fields["character.tags"]; found {
		if tags := materialStrings(field.ActiveText); len(tags) > 0 {
			return appendUnique(nil, tags...)
		}
		if tags := materialStrings(field.SourceText); len(tags) > 0 {
			return appendUnique(nil, tags...)
		}
	}
	tags := appendUnique(nil, materialStrings(item.Original["tags"])...)
	tags = appendUnique(tags, materialStrings(item.SourceSemantics["tags"])...)
	return tags
}

func masterItemDescription(item MasterItem) string {
	paths := []string{"character.description", "character.personality", "lorebook.description"}
	for _, path := range paths {
		if field, found := item.Fields[path]; found {
			if text := masterSummaryText(firstNonEmpty(field.ActiveText, field.SourceText)); text != "" {
				return text
			}
		}
	}
	for _, key := range []string{"description"} {
		if text := masterSummaryText(materialString(item.Original[key])); text != "" {
			return text
		}
	}
	// Legacy single-record imports may only have a top-level content value.
	// Once nested entries exist, never promote one of their bodies to the
	// asset introduction: the introduction is an independent top-level field.
	if len(item.NestedEntries) == 0 {
		if text := masterSummaryText(materialString(item.Original["content"])); text != "" {
			return text
		}
	}
	return ""
}

func masterSummaryText(value string) string {
	text := strings.Join(strings.Fields(value), " ")
	if text == "" {
		return ""
	}
	runes := []rune(text)
	if len(runes) <= 96 {
		return text
	}
	return string(runes[:96]) + "…"
}

func masterAssetMatches(asset MasterAssetSummary, query MasterAssetQuery) bool {
	if query.RecordKind != "" && !strings.EqualFold(asset.RecordKind, query.RecordKind) {
		return false
	}
	if query.SemanticType != "" && !strings.EqualFold(asset.SemanticType, query.SemanticType) {
		return false
	}
	if query.Availability != "" && !strings.EqualFold(asset.Availability, query.Availability) {
		return false
	}
	needle := strings.ToLower(strings.TrimSpace(query.Query))
	return needle == "" || strings.Contains(strings.ToLower(asset.Name), needle) || strings.Contains(strings.ToLower(asset.SourceName), needle)
}

func masterSourceAndRevision(manifest MasterLibraryManifest, sourceID, revisionID string) (MasterSourceRecord, MasterSourceRevision, bool) {
	for _, source := range manifest.Sources {
		if source.SourceID != sourceID {
			continue
		}
		for _, revision := range source.Revisions {
			if revision.Revision == revisionID {
				return source, revision, true
			}
		}
		return source, MasterSourceRevision{}, false
	}
	return MasterSourceRecord{}, MasterSourceRevision{}, false
}

func deriveMasterPipeline(workspace string, item MasterItem, source MasterSourceRecord, revision MasterSourceRevision, found bool, manifest MasterLibraryManifest) MasterPipelineStatus {
	issues := []MasterPipelineIssue{}
	addIssue := func(stage, code, severity, message, reason string, blocking bool) string {
		id := stage + ":" + code
		issues = append(issues, MasterPipelineIssue{ID: id, Stage: stage, Code: code, Severity: severity, Blocking: blocking, Message: message, Reason: reason})
		return id
	}
	nodes := make([]MasterPipelineNode, 0, 7)
	archiveStatus := masterPipelineCompleted
	archiveIssueIDs := []string{}
	if !found {
		archiveStatus = masterPipelineFailed
		archiveIssueIDs = append(archiveIssueIDs, addIssue("archive", "source_missing", "blocking", "总库来源或来源版本不存在", "资产无法证明来自当前原件", true))
	} else if _, err := os.Stat(filepath.Join(workspace, filepath.FromSlash(revision.OriginalPath))); err != nil {
		archiveStatus = masterPipelineFailed
		archiveIssueIDs = append(archiveIssueIDs, addIssue("archive", "original_missing", "blocking", "原始文件归档不存在", "Master manifest 仍有记录，但原件路径无法读取", true))
	}
	nodes = append(nodes, MasterPipelineNode{Key: "archive", Status: archiveStatus, OutputRevision: item.SourceRevision, Inferred: false, IssueIDs: archiveIssueIDs})

	staleSource := found && source.CurrentRevision != item.SourceRevision
	staleIssueIDs := []string{}
	if staleSource {
		staleIssueIDs = append(staleIssueIDs, addIssue("parse", "source_revision_changed", "blocking", "来源已有更新，当前条目不是最新来源版本", "后续节点的输入 revision 已失效", true))
	}
	parseStatus := masterPipelineCompleted
	if !found {
		parseStatus = masterPipelineFailed
	} else if staleSource {
		parseStatus = masterPipelineStale
	}
	nodes = append(nodes, MasterPipelineNode{Key: "parse", Status: parseStatus, InputRevision: item.SourceRevision, OutputRevision: item.SourceRevision, Inferred: true, Reason: "由 Master 条目和来源 revision 推导", IssueIDs: staleIssueIDs})

	normalizeStatus := masterPipelineCompleted
	normalizeIssueIDs := []string{}
	if len(item.Original) == 0 || len(item.SourceSemantics) == 0 || len(item.RuntimeSemantics) == 0 {
		normalizeStatus = masterPipelineWarning
		normalizeIssueIDs = append(normalizeIssueIDs, addIssue("normalize", "normalization_evidence_incomplete", "warning", "规范化证据不完整", "当前数据没有独立保存规范化输出 revision", false))
	}
	if staleSource {
		normalizeStatus = masterPipelineStale
		normalizeIssueIDs = append(normalizeIssueIDs, staleIssueIDs...)
	}
	nodes = append(nodes, MasterPipelineNode{Key: "normalize", Status: normalizeStatus, InputRevision: item.SourceRevision, OutputRevision: item.Revision, Inferred: true, Reason: "由 Master 条目结构推导", IssueIDs: normalizeIssueIDs})

	translation, translationStatus, translationIssueIDs := deriveMasterTranslationStatus(workspace, item, manifest, staleSource, addIssue)
	nodes = append(nodes, MasterPipelineNode{Key: "translation", Status: translationStatus, InputRevision: item.Revision, OutputRevision: item.ActiveWorkingRevision, Inferred: true, Reason: "由 Master 字段、翻译版本和导入事务推导", IssueIDs: translationIssueIDs})

	checkStatus := masterPipelineCompleted
	checkIssueIDs := []string{}
	if staleSource {
		checkStatus = masterPipelineStale
		checkIssueIDs = append(checkIssueIDs, staleIssueIDs...)
	} else if hasBlockingIssues(issues) {
		checkStatus = masterPipelineFailed
		for _, issue := range issues {
			if issue.Blocking {
				checkIssueIDs = append(checkIssueIDs, issue.ID)
			}
		}
	} else if len(issues) > 0 {
		checkStatus = masterPipelineWarning
		for _, issue := range issues {
			checkIssueIDs = append(checkIssueIDs, issue.ID)
		}
	}
	nodes = append(nodes, MasterPipelineNode{Key: "check", Status: checkStatus, InputRevision: item.ActiveWorkingRevision, OutputRevision: item.ActiveWorkingRevision, Inferred: true, Reason: "第一阶段尚无独立检查快照，基于现有数据推导", IssueIDs: uniqueStrings(checkIssueIDs)})

	availability := MasterAvailabilityUsable
	if hasBlockingIssues(issues) || translationStatus == masterPipelineStale || translationStatus == masterPipelineFailed {
		availability = MasterAvailabilityStaging
	}
	usableStatus := masterPipelineCompleted
	usableIssues := []string{}
	if availability != MasterAvailabilityUsable {
		usableStatus = masterPipelineWaiting
		for _, issue := range issues {
			if issue.Blocking {
				usableIssues = append(usableIssues, issue.ID)
			}
		}
	}
	nodes = append(nodes, MasterPipelineNode{Key: "usable", Status: usableStatus, InputRevision: item.ActiveWorkingRevision, OutputRevision: availability, Inferred: true, Reason: "可用状态由阻断问题和必需翻译字段推导", IssueIDs: uniqueStrings(usableIssues)})

	usageCount := 0
	for _, usage := range manifest.Instances {
		if usage.MasterItemID == item.MasterItemID {
			usageCount++
		}
	}
	instanceStatus := masterPipelineWaiting
	if usageCount > 0 {
		instanceStatus = masterPipelineCompleted
	}
	nodes = append(nodes, MasterPipelineNode{Key: "instantiate", Status: instanceStatus, Inferred: false, Reason: "该节点表示已创建实例数量，不作为可用 Gate"})
	return MasterPipelineStatus{Availability: availability, Nodes: nodes, Issues: issues, Translation: translation, UsageCount: usageCount}
}

func deriveMasterTranslationStatus(workspace string, item MasterItem, manifest MasterLibraryManifest, stale bool, addIssue func(string, string, string, string, string, bool) string) (MasterTranslationStatus, string, []string) {
	status := MasterTranslationStatus{ContentVersionKind: map[string]int{}}
	issueIDs := []string{}
	optionalNestedProblem := false
	activeKinds := masterActiveVersionKinds(workspace, item, manifest)
	targets := map[string]MasterTranslationTarget{}
	for _, transactionRef := range manifest.Imports {
		data, err := os.ReadFile(filepath.Join(workspace, filepath.FromSlash(transactionRef.Path)))
		if err != nil {
			continue
		}
		var transaction MasterImportTransaction
		if json.Unmarshal(data, &transaction) != nil {
			continue
		}
		for _, target := range transaction.TranslationTargets {
			if target.MasterItemID == item.MasterItemID {
				targets[target.FieldPath] = target
			}
		}
	}
	for fieldPath, field := range item.Fields {
		if !field.NeedsTranslation {
			continue
		}
		status.TotalFields++
		if field.ActiveTranslationVersionID != "" && strings.TrimSpace(field.ActiveText) != "" {
			status.ActiveFields++
			kind := "translation_active"
			if activeKinds[field.ActiveTranslationVersionID] != "" {
				kind = activeKinds[field.ActiveTranslationVersionID]
			}
			status.ContentVersionKind[kind]++
			continue
		}
		if target, ok := targets[fieldPath]; ok {
			switch target.Status {
			case "pending_review":
				status.ReviewFields++
				if isNestedMasterField(fieldPath) {
					optionalNestedProblem = true
				}
				issueIDs = append(issueIDs, addIssue("translation", "review_required", "warning", "翻译结果等待人工确认", "该字段不是阻断性必需字段或采用了 review 策略", false))
			case "failed", "cancelled":
				status.FailedFields++
				blocking := target.Required || !isNestedMasterField(fieldPath)
				if !blocking {
					optionalNestedProblem = true
				}
				issueIDs = append(issueIDs, addIssue("translation", "translation_failed", map[bool]string{true: "blocking", false: "warning"}[blocking], "翻译任务失败或已取消", "字段没有可用译文", blocking))
			default:
				status.PendingFields++
				if target.Required {
					issueIDs = append(issueIDs, addIssue("translation", "required_translation_pending", "blocking", "必需字段尚未完成翻译", "字段仍处于待处理状态", true))
				} else if isNestedMasterField(fieldPath) {
					optionalNestedProblem = true
					issueIDs = append(issueIDs, addIssue("translation", "optional_translation_pending", "warning", "部分内部条目尚未完成翻译", "该嵌套字段不阻止整张资产使用", false))
				}
			}
		} else {
			status.PendingFields++
			blocking := field.Required || !isNestedMasterField(fieldPath)
			if !blocking {
				optionalNestedProblem = true
			}
			issueIDs = append(issueIDs, addIssue("translation", "translation_target_missing", map[bool]string{true: "blocking", false: "warning"}[blocking], "需要翻译的字段没有对应任务", "Master 字段和导入事务不一致", blocking))
		}
	}
	if stale {
		return status, masterPipelineStale, append(issueIDs, addIssue("translation", "translation_input_stale", "blocking", "翻译输入已经过期", "来源 revision 已变化，不能继续沿用当前译文", true))
	}
	if status.FailedFields > 0 && !optionalNestedProblem {
		return status, masterPipelineFailed, uniqueStrings(issueIDs)
	}
	if optionalNestedProblem {
		return status, masterPipelineWarning, uniqueStrings(issueIDs)
	}
	if status.ReviewFields > 0 {
		return status, masterPipelineReview, uniqueStrings(issueIDs)
	}
	if status.PendingFields > 0 {
		return status, masterPipelineWaiting, uniqueStrings(issueIDs)
	}
	if status.TotalFields == 0 {
		return status, masterPipelineSkipped, uniqueStrings(issueIDs)
	}
	return status, masterPipelineCompleted, uniqueStrings(issueIDs)
}

func isNestedMasterField(fieldPath string) bool {
	return strings.Contains(fieldPath, ".entries/")
}

func masterActiveVersionKinds(workspace string, item MasterItem, manifest MasterLibraryManifest) map[string]string {
	result := map[string]string{}
	for _, ref := range manifest.Translations {
		if ref.MasterItemID != item.MasterItemID {
			continue
		}
		data, err := os.ReadFile(filepath.Join(workspace, filepath.FromSlash(ref.Path)))
		if err != nil {
			continue
		}
		var version MasterTranslationVersion
		if json.Unmarshal(data, &version) == nil {
			result[version.TranslationVersionID] = masterContentVersionKind(version)
		}
	}
	return result
}

func hasBlockingIssues(issues []MasterPipelineIssue) bool {
	for _, issue := range issues {
		if issue.Blocking {
			return true
		}
	}
	return false
}

func masterItemDisplayName(item MasterItem) string {
	for _, path := range []string{"character.name", "lorebook.name"} {
		if field, found := item.Fields[path]; found {
			if strings.TrimSpace(field.ActiveText) != "" {
				return field.ActiveText
			}
			if field.NeedsTranslation && strings.TrimSpace(field.SourceText) != "" {
				return "待翻译 · " + field.SourceText
			}
		}
	}
	if name := materialString(item.Original["name"]); name != "" {
		return name
	}
	return item.MasterItemID
}

func masterContentVersionKind(version MasterTranslationVersion) string {
	model := strings.ToLower(strings.TrimSpace(version.Model))
	if strings.Contains(model, "hy-mt") || strings.Contains(model, "hymt") {
		return "hy_mt_active"
	}
	if version.Confirmed {
		return "polished_active"
	}
	return "polish_candidate"
}

func uniqueStrings(values []string) []string {
	seen := map[string]struct{}{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
