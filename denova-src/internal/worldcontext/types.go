// Package worldcontext 实现 World Context 的纯内存领域核心（Phase 3.0B · P0）。
//
// 设计冻结依据：docs/plans/WORLD_WORKSPACE_PHASE3_ARCHITECTURE_PLAN.md v2.7
// （§4.1～§4.12 双投影与 schema、§5 selection 闭包、§9.1 预算、§9.2 错误码）。
//
// P0 边界（严格遵守）：
//   - 纯函数领域包：不持有文件路径、不读写磁盘、不依赖 HTTP handler、不发起网络/模型调用；
//   - 不包含 runContext 注册表、analysisHandle、Task/InteractiveRun（后续 P1/P4）；
//   - 只从一份“已保存、revision 匹配”的 world.World 派生 Snapshot/投影，绝不回写 World；
//   - 复用 internal/world 的枚举类型（CharacterRole/SemanticType/BindingScope/TimelineCategory），
//     不复制 World 持久化结构。
package worldcontext

import (
	"fmt"

	"denova/internal/world"
)

// SchemaVersion 是 Snapshot / UIView / ModelView 的 v1 结构版本，参与 fingerprint。
const SchemaVersion = 1

// Consumer 标识世界上下文的消费模式；consumer 永远由服务端路由固定，客户端不得提交。
type Consumer string

const (
	ConsumerWriting    Consumer = "writing"
	ConsumerGame       Consumer = "game"
	ConsumerNarraverse Consumer = "narraverse" // 3.0B 仅保留枚举兼容，不允许构建
	ConsumerModule4    Consumer = "module4"    // 同上，3.2-C0 安全门通过后才启用
)

// ErrorCode 是 v2.7 §9.2 冻结的稳定领域错误码；P0 只产生领域错误，不做 HTTP 映射。
type ErrorCode string

const (
	ErrInvalidRequest     ErrorCode = "invalid_request"
	ErrSelectionInvalid   ErrorCode = "selection_invalid"
	ErrRevisionConflict   ErrorCode = "revision_conflict"
	ErrWorldArchived      ErrorCode = "world_archived"
	ErrWorldNotFound      ErrorCode = "world_not_found"
	ErrWorldUnavailable   ErrorCode = "world_unavailable"
	ErrBudgetExceeded     ErrorCode = "budget_exceeded"
	ErrProjectionFailed   ErrorCode = "projection_failed"
	ErrContextUnavailable ErrorCode = "context_unavailable"
	ErrContextRefMismatch ErrorCode = "context_ref_mismatch"
	ErrConsumerNotTrusted ErrorCode = "consumer_not_trusted"
)

// DomainError 是世界上下文领域错误；Invalid 只回传客户端提交过的安全 id 清单（不含内部路径）。
type DomainError struct {
	Code    ErrorCode
	Field   string
	Message string
	Layer   string // 预算层级（仅 Code==budget_exceeded 时使用）
	Invalid []string
}

func (e *DomainError) Error() string {
	if e.Field != "" {
		return fmt.Sprintf("%s: 字段 %s: %s", e.Code, e.Field, e.Message)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func domainError(code ErrorCode, field, message string) *DomainError {
	return &DomainError{Code: code, Field: field, Message: message}
}

func budgetError(layer, message string) *DomainError {
	return &DomainError{Code: ErrBudgetExceeded, Layer: layer, Message: message}
}

// CodeOf 返回错误对应的稳定错误码；非领域错误返回 projection_failed。
func CodeOf(err error) ErrorCode {
	if err == nil {
		return ""
	}
	if de, ok := err.(*DomainError); ok {
		return de.Code
	}
	return ErrProjectionFailed
}

// Ref 是客户端可持有、随请求提交的不可变值对象；它不是 Snapshot、不含正文。
type Ref struct {
	WorldID               string    `json:"worldId"`
	ExpectedWorldRevision string    `json:"expectedWorldRevision"`
	Selection             Selection `json:"selection"`
}

// Selection 是请求侧选择；字段契约见 v2.7 §4.7。
type Selection struct {
	IncludeTone      bool
	RuleIndexes      []int
	CharacterIDs     []string
	LocationIDs      []string
	FactionIDs       []string
	TimelineEntryIDs []string
	BindingIDs       []string // 仅允许 world scope 绑定
}

// OmissionKind 标识被闭包裁剪的跨实体引用类型。
type OmissionKind string

const (
	OmissionCharacterFaction    OmissionKind = "character_faction"
	OmissionCharacterLocation   OmissionKind = "character_location"
	OmissionFactionHeadquarters OmissionKind = "faction_headquarters"
	OmissionRelationshipEdge    OmissionKind = "relationship_edge"
)

// OmissionReason 标识裁剪原因。
type OmissionReason string

const (
	ReasonTargetNotSelected     OmissionReason = "target_not_selected"
	ReasonTargetCascadedRemoved OmissionReason = "target_cascaded_removed"
)

// Omission 是闭包省略审计；只含内部 id，仅供 Snapshot/UIView，ModelView 不输出。
type Omission struct {
	Kind            OmissionKind   `json:"kind"`
	OwnerEntityID   string         `json:"ownerEntityId"`
	MissingEntityID string         `json:"missingEntityId"`
	Reason          OmissionReason `json:"reason"`
}

// WarningCode 是 Snapshot warning 的枚举。
type WarningCode string

const (
	WarningLegacyTimelineCategory WarningCode = "legacy_timeline_category"
	WarningBindingUnchecked       WarningCode = "binding_unchecked"
)

// SnapshotWarning 是一条运行期 warning，不含正文。
type SnapshotWarning struct {
	Code    WarningCode `json:"code"`
	RefKind string      `json:"refKind,omitempty"`
	RefID   string      `json:"refId,omitempty"`
}

// Identity 是世界身份段；可选标量空串即缺失（投影时不输出该键）。
type Identity struct {
	Name    string `json:"name"`
	Tagline string `json:"tagline,omitempty"`
	Genre   string `json:"genre,omitempty"`
	Summary string `json:"summary,omitempty"`
}

// Setting 是世界基调与入选规则；仅当基调入选或至少一条规则入选时存在。
type Setting struct {
	Tone  string   `json:"tone,omitempty"`
	Rules []string `json:"rules"`
}

// SnapshotRelationship 保留目标内部 id（闭包后必命中入选角色）。
type SnapshotRelationship struct {
	TargetCharacterID string `json:"targetCharacterId"`
	Label             string `json:"label"`
}

// SnapshotCharacter 是内部角色段，允许携带内部引用 id。
type SnapshotCharacter struct {
	ID            string                 `json:"id"`
	DisplayName   string                 `json:"displayName"`
	Role          world.CharacterRole    `json:"role,omitempty"`
	WorldNote     string                 `json:"worldNote,omitempty"`
	FactionID     string                 `json:"factionId,omitempty"`
	LocationID    string                 `json:"locationId,omitempty"`
	Relationships []SnapshotRelationship `json:"relationships"`
}

// SnapshotLocation 是内部地点段。
type SnapshotLocation struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Tags        []string `json:"tags"`
}

// SnapshotFaction 是内部势力段。
type SnapshotFaction struct {
	ID                     string `json:"id"`
	Name                   string `json:"name"`
	Description            string `json:"description,omitempty"`
	Influence              *int   `json:"influence,omitempty"`
	Stability              *int   `json:"stability,omitempty"`
	HeadquartersLocationID string `json:"headquartersLocationId,omitempty"`
}

// SnapshotTimelineEntry 是内部时间线段；category 已归一为新三值。
type SnapshotTimelineEntry struct {
	ID          string                 `json:"id"`
	Order       int                    `json:"order"`
	EraLabel    string                 `json:"eraLabel,omitempty"`
	Title       string                 `json:"title"`
	Description string                 `json:"description,omitempty"`
	Category    world.TimelineCategory `json:"category"`
}

// SnapshotMaterial 是绑定薄快照（不含正文/头像/masterRevision 等运行健康信息）。
type SnapshotMaterial struct {
	BindingID    string             `json:"bindingId"`
	MasterItemID string             `json:"masterItemId"`
	Name         string             `json:"name"`
	Tags         []string           `json:"tags"`
	SemanticType world.SemanticType `json:"semanticType"`
	Scope        world.BindingScope `json:"scope"`
}

// SnapshotStats 计数全部由闭包结果即时派生。
type SnapshotStats struct {
	CharacterCount int `json:"characterCount"`
	LocationCount  int `json:"locationCount"`
	FactionCount   int `json:"factionCount"`
	TimelineCount  int `json:"timelineCount"`
	MaterialCount  int `json:"materialCount"`
}

// Snapshot 是服务端内部不可变对象（v2.7 §4.8，WorldContextSnapshotV1）。
// 它不出服务端边界；无 generatedAt 等运行时间戳，保证同输入必同字节。
type Snapshot struct {
	SchemaVersion      int                     `json:"schemaVersion"`
	WorldID            string                  `json:"worldId"`
	WorldRevision      string                  `json:"worldRevision"`
	Consumer           Consumer                `json:"consumer"`
	ContextFingerprint string                  `json:"contextFingerprint"`
	CanonicalSelection Selection               `json:"canonicalSelection"`
	Identity           Identity                `json:"identity"`
	Setting            *Setting                `json:"setting,omitempty"`
	Characters         []SnapshotCharacter     `json:"characters"`
	Locations          []SnapshotLocation      `json:"locations"`
	Factions           []SnapshotFaction       `json:"factions"`
	Timeline           []SnapshotTimelineEntry `json:"timeline"`
	Materials          []SnapshotMaterial      `json:"materials"`
	Omissions          []Omission              `json:"omissions"`
	Warnings           []SnapshotWarning       `json:"warnings"`
	Stats              SnapshotStats           `json:"stats"`
}

// SourceKind 标识一条来源的槽位类型。
type SourceKind string

const (
	SourceIdentity  SourceKind = "identity"
	SourceSetting   SourceKind = "setting"
	SourceCharacter SourceKind = "character"
	SourceLocation  SourceKind = "location"
	SourceFaction   SourceKind = "faction"
	SourceTimeline  SourceKind = "timeline"
	SourceMaterial  SourceKind = "material"
)

// SourceTableEntry 供 UIView “查看来源/高亮/回到分区”，允许携带内部 id。
type SourceTableEntry struct {
	Kind         SourceKind `json:"kind"`
	EntityID     string     `json:"entityId,omitempty"`
	BindingID    string     `json:"bindingId,omitempty"`
	MasterItemID string     `json:"masterItemId,omitempty"`
	FieldPath    string     `json:"fieldPath,omitempty"`
}

// UIView 是控制台投影（v2.7 §4.9）：全量 Snapshot 字段 + 视图专有字段。
type UIView struct {
	*Snapshot
	SourceTable    map[string]SourceTableEntry `json:"sourceTable"`
	RevisionLabel  string                      `json:"revisionLabel"`
	IsDraftPreview bool                        `json:"isDraftPreview"`
}

// ModelRelationship 只保留目标展示名（闭包后无悬空 id）。
type ModelRelationship struct {
	TargetLabel string `json:"targetLabel"`
	Label       string `json:"label"`
}

// ModelCharacter 是模型可见角色段（无任何内部 id）。
type ModelCharacter struct {
	DisplayName   string              `json:"displayName"`
	Role          world.CharacterRole `json:"role,omitempty"`
	WorldNote     string              `json:"worldNote,omitempty"`
	FactionLabel  string              `json:"factionLabel,omitempty"`
	LocationLabel string              `json:"locationLabel,omitempty"`
	Relationships []ModelRelationship `json:"relationships"`
}

// ModelLocation 是模型可见地点段。
type ModelLocation struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Tags        []string `json:"tags"`
}

// ModelFaction 是模型可见势力段。
type ModelFaction struct {
	Name              string `json:"name"`
	Description       string `json:"description,omitempty"`
	Influence         *int   `json:"influence,omitempty"`
	Stability         *int   `json:"stability,omitempty"`
	HeadquartersLabel string `json:"headquartersLabel,omitempty"`
}

// ModelTimelineEntry 是模型可见时间段（category 为新三值）。
type ModelTimelineEntry struct {
	Order       int                    `json:"order"`
	EraLabel    string                 `json:"eraLabel,omitempty"`
	Title       string                 `json:"title"`
	Description string                 `json:"description,omitempty"`
	Category    world.TimelineCategory `json:"category"`
}

// ModelMaterial 是模型可见资料薄快照展示段。
type ModelMaterial struct {
	Name              string   `json:"name"`
	Tags              []string `json:"tags"`
	SemanticTypeLabel string   `json:"semanticTypeLabel"`
}

// BodySource 是 source-neutral 的内部来源项：RefValue 为稳定内部键，物化时换成 sourceRef。
type BodySource struct {
	RefKind  SourceKind
	RefValue string
	Label    string
}

// ProjectionBody 是 source-neutral、可按 fingerprint 跨 run 缓存的投影体（v2.7 §4.1）。
// 它不携带 runSalt/sourceRef 等 per-run 随机量；属于服务端内部对象，不直接给模型。
type ProjectionBody struct {
	SchemaVersion int                  `json:"schemaVersion"`
	Identity      Identity             `json:"identity"`
	Setting       *Setting             `json:"setting,omitempty"`
	Characters    []ModelCharacter     `json:"characters"`
	Locations     []ModelLocation      `json:"locations"`
	Factions      []ModelFaction       `json:"factions"`
	Timeline      []ModelTimelineEntry `json:"timeline"`
	Materials     []ModelMaterial      `json:"materials"`
	Sources       []BodySource         `json:"-"`
}

// ModelSource 是最终 ModelView 的来源项；Ref 为本 run 不可寻址 sourceRef。
type ModelSource struct {
	Ref   string     `json:"ref"`
	Kind  SourceKind `json:"kind"`
	Label string     `json:"label"`
}

// ModelView 是模型可见的最终 per-run 产物（v2.7 §4.10）。
// 六个数组恒在（无内容输出 []）；可选标量缺失即不输出该键（无 null/""）。
type ModelView struct {
	SchemaVersion int                  `json:"schemaVersion"`
	Identity      Identity             `json:"identity"`
	Setting       *Setting             `json:"setting,omitempty"`
	Characters    []ModelCharacter     `json:"characters"`
	Locations     []ModelLocation      `json:"locations"`
	Factions      []ModelFaction       `json:"factions"`
	Timeline      []ModelTimelineEntry `json:"timeline"`
	Materials     []ModelMaterial      `json:"materials"`
	Sources       []ModelSource        `json:"sources"`
}

// SidecarMeta 是独立于 Snapshot 的诊断/预算元数据（v2.7 §4.12）；
// 不进 Snapshot/UIView/ModelView，不参与 fingerprint，仅服务端内部使用。
type SidecarMeta struct {
	WorldID              string   `json:"worldId"`
	WorldRevision        string   `json:"worldRevision"`
	Consumer             Consumer `json:"consumer"`
	ContextFingerprint   string   `json:"contextFingerprint"`
	Scope                string   `json:"scope"` // build | cache_hit
	SnapshotBodyBytes    int      `json:"snapshotBodyBytes"`
	ProjectionBodyBytes  int      `json:"projectionBodyBytes"`
	FinalModelViewBytes  int      `json:"finalModelViewBytes"`
	CountCharacters      int      `json:"-"`
	CountLocations       int      `json:"-"`
	CountFactions        int      `json:"-"`
	CountTimeline        int      `json:"-"`
	CountMaterials       int      `json:"-"`
	CountOmissions       int      `json:"-"`
	CountWarnings        int      `json:"-"`
	CountSources         int      `json:"-"`
	EstimatedTokens      int      `json:"estimatedTokens"`
	EffectiveModelBudget int      `json:"effectiveModelBudget"`
	Sections             int      `json:"sections"`
}
