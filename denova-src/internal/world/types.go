// Package world 实现 World Workspace 的世界数据领域层与最小 JSON 持久化。
//
// 设计约束（见 docs/plans/WORLD_WORKSPACE_IMPLEMENTATION_PLAN.md）：
//   - 世界跨书存在，数据落在全局 cfg.DataDir()/worlds，而不是某本书的 .denova；
//   - 每个世界一个 world-<id>.json，不维护 index.json，列表通过扫描目录即时派生；
//   - 文件读写走 internal/revisionfile 的内容哈希 CAS（revision 是 sha256 信封值）；
//   - 世界 id 只由服务端生成；bindingId/实体 id 由客户端生成、服务端只校验不重建。
package world

// SchemaVersion 是世界磁盘结构的当前版本号。
const SchemaVersion = 1

// BindingRecordKind 对应总资料库资产的顶层 record_kind。
type BindingRecordKind string

const (
	CharacterTemplate BindingRecordKind = "character_template"
	LorebookTemplate  BindingRecordKind = "lorebook_template"
)

// SemanticType 复用既有 lore 语义分类词表（internal/book/lore.go）。
type SemanticType string

const (
	SemanticCharacter SemanticType = "character"
	SemanticWorld     SemanticType = "world"
	SemanticLocation  SemanticType = "location"
	SemanticFaction   SemanticType = "faction"
	SemanticRule      SemanticType = "rule"
	SemanticItem      SemanticType = "item"
	SemanticOther     SemanticType = "other"
)

// CharacterRole 是世界内角色定位（枚举白名单）。
type CharacterRole string

const (
	RoleProtagonist CharacterRole = "protagonist"
	RoleMajor       CharacterRole = "major"
	RoleMinor       CharacterRole = "minor"
	RoleNPC         CharacterRole = "npc"
)

// WorldStatus 是世界状态。
type WorldStatus string

const (
	StatusActive   WorldStatus = "active"
	StatusArchived WorldStatus = "archived"
)

// TimelineCategory 区分背景正典与计划伏笔。
type TimelineCategory string

const (
	TimelineCanon   TimelineCategory = "canon"
	TimelinePlanned TimelineCategory = "planned"
)

// WorldSetting 是世界规则与基调（背景，不是运行时规则引擎）。
type WorldSetting struct {
	Rules []string `json:"rules"`
	Tone  string   `json:"tone,omitempty"`
}

// AssetBinding 是对总资料库资产的只读引用；它只在 World.Bindings 中出现一次，
// 角色/地点/势力通过 BindingID 外键引用，避免多处快照不一致。
type AssetBinding struct {
	BindingID    string            `json:"bindingId"`
	MasterItemID string            `json:"masterItemId"`
	RecordKind   BindingRecordKind `json:"recordKind"`
	SemanticType SemanticType      `json:"semanticType"`
	NameSnapshot string            `json:"nameSnapshot"`
	TagsSnapshot []string          `json:"tagsSnapshot"`
	// MasterRevision 记录绑定时总资料库条目的内容哈希（sha256:...）。
	// 可选：Phase 2A 之前的旧世界没有该字段，反序列化为空串，语义为“尚未检查”，不算损坏。
	MasterRevision string `json:"masterRevision,omitempty"`
	BoundAt        string `json:"boundAt"`
}

// Relationship 是角色之间的世界内关系标注。
type Relationship struct {
	TargetCharacterID string `json:"targetCharacterId"`
	Label             string `json:"label"`
}

// Character 是世界内角色实例；其世界内状态绝不回写总资料库。
type Character struct {
	ID            string            `json:"id"`
	BindingID     string            `json:"bindingId,omitempty"`
	DisplayName   string            `json:"displayName"`
	Role          CharacterRole     `json:"role,omitempty"`
	FactionID     string            `json:"factionId,omitempty"`
	LocationID    string            `json:"locationId,omitempty"`
	WorldNote     string            `json:"worldNote,omitempty"`
	Relationships []Relationship    `json:"relationships,omitempty"`
	GrowthNote    string            `json:"growthNote,omitempty"`
	CustomFields  map[string]string `json:"customFields,omitempty"`
}

// Location 是世界地点。
type Location struct {
	ID          string   `json:"id"`
	BindingID   string   `json:"bindingId,omitempty"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Tags        []string `json:"tags,omitempty"`
}

// Faction 是世界势力；Influence/Stability 为 0-100 的静态展示值，可缺省。
type Faction struct {
	ID                     string `json:"id"`
	BindingID              string `json:"bindingId,omitempty"`
	Name                   string `json:"name"`
	Description            string `json:"description,omitempty"`
	Influence              *int   `json:"influence,omitempty"`
	Stability              *int   `json:"stability,omitempty"`
	HeadquartersLocationID string `json:"headquartersLocationId,omitempty"`
}

// TimelineEntry 是背景历史时间线条目。
type TimelineEntry struct {
	ID          string           `json:"id"`
	Order       int              `json:"order"`
	EraLabel    string           `json:"eraLabel,omitempty"`
	Title       string           `json:"title"`
	Description string           `json:"description,omitempty"`
	Category    TimelineCategory `json:"category,omitempty"`
}

// World 是世界主体。Revision 不存于此结构，而在 HTTP 信封 {world,revision}。
type World struct {
	ID                        string          `json:"id"`
	SchemaVersion             int             `json:"schemaVersion"`
	Name                      string          `json:"name"`
	Tagline                   string          `json:"tagline,omitempty"`
	Genre                     string          `json:"genre,omitempty"`
	Summary                   string          `json:"summary,omitempty"`
	CoverColor                string          `json:"coverColor,omitempty"`
	Status                    WorldStatus     `json:"status"`
	WorldSetting              *WorldSetting   `json:"worldSetting,omitempty"`
	Bindings                  []AssetBinding  `json:"bindings"`
	Characters                []Character     `json:"characters"`
	Locations                 []Location      `json:"locations"`
	Factions                  []Faction       `json:"factions"`
	Timeline                  []TimelineEntry `json:"timeline"`
	PrimaryBookPath           string          `json:"primaryBookPath,omitempty"`
	PrimaryInteractiveStoryID string          `json:"primaryInteractiveStoryId,omitempty"`
	CreatedAt                 string          `json:"createdAt"`
	UpdatedAt                 string          `json:"updatedAt"`
}

// Summary 是列表项，其计数值由世界内容即时派生、不持久化。
type Summary struct {
	ID             string      `json:"id"`
	Name           string      `json:"name"`
	Tagline        string      `json:"tagline,omitempty"`
	Genre          string      `json:"genre,omitempty"`
	CoverColor     string      `json:"coverColor,omitempty"`
	Status         WorldStatus `json:"status"`
	CharacterCount int         `json:"characterCount"`
	LocationCount  int         `json:"locationCount"`
	FactionCount   int         `json:"factionCount"`
	TimelineCount  int         `json:"timelineCount"`
	CreatedAt      string      `json:"createdAt"`
	UpdatedAt      string      `json:"updatedAt"`
}

// LoadWarning 表示列表扫描时无法解析的世界文件（不静默跳过）。
type LoadWarning struct {
	File   string `json:"file"`
	ID     string `json:"id,omitempty"`
	Reason string `json:"reason"`
}

// ListResult 是列表扫描结果。
type ListResult struct {
	Worlds   []Summary     `json:"-"`
	Warnings []LoadWarning `json:"-"`
}

// CreateInput 是创建世界的入参；一次携带创世向导的全部选择，服务端原子建成。
// 刻意不含 ID/Status/CreatedAt/UpdatedAt/SchemaVersion——这些由服务端生成。
type CreateInput struct {
	Name                      string          `json:"name"`
	Tagline                   string          `json:"tagline,omitempty"`
	Genre                     string          `json:"genre,omitempty"`
	Summary                   string          `json:"summary,omitempty"`
	CoverColor                string          `json:"coverColor,omitempty"`
	WorldSetting              *WorldSetting   `json:"worldSetting,omitempty"`
	Bindings                  []AssetBinding  `json:"bindings,omitempty"`
	Characters                []Character     `json:"characters,omitempty"`
	Locations                 []Location      `json:"locations,omitempty"`
	Factions                  []Faction       `json:"factions,omitempty"`
	Timeline                  []TimelineEntry `json:"timeline,omitempty"`
	PrimaryBookPath           string          `json:"primaryBookPath,omitempty"`
	PrimaryInteractiveStoryID string          `json:"primaryInteractiveStoryId,omitempty"`
}
