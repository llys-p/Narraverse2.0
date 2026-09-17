package library

// 本文件定义设定库的 wire / 磁盘结构。
//
// 命名与 JSON tag 是冻结契约（见 LIBRARY_L1_DATA_CONTRACT.md）：
// 前端、HTTP 信封与磁盘文件共用同一份结构，字段改名必须同步全部消费方。

// Library 是一份独立的作品设定库。它是本库人工确认设定的唯一真源。
//
// ID 由服务端生成（16 位小写字母数字），SchemaVersion 由服务端维护；
// 库级 revision 不存于此结构，而在 HTTP 信封 {library, revision} 中
// （revision 是文件内容哈希，见 internal/revisionfile）。
type Library struct {
	ID            string     `json:"id"`
	SchemaVersion int        `json:"schemaVersion"`
	Name          string     `json:"name"`
	Summary       string     `json:"summary,omitempty"`
	Purpose       string     `json:"purpose"`
	Tone          string     `json:"tone,omitempty"`
	StartingPoint string     `json:"startingPoint,omitempty"`
	Items         []Item     `json:"items"`
	Relations     []Relation `json:"relations"`
	CreatedAt     string     `json:"createdAt"`
	UpdatedAt     string     `json:"updatedAt"`
}

// Item 是库内一条设定条目。字段复用旧 Lore 条目语义，另加 L1 需要的
// 来源指向（Source/Origin）、类型专用字段（Fields）与事件结构（Event）。
//
// 只读引用条目（Origin=reference）的 Content/Fields 以来源为准，
// 本库不得改写；服务端在更新时强制这一点。
type Item struct {
	ID               string   `json:"id"`
	Enabled          bool     `json:"enabled"`
	Type             string   `json:"type"`
	TypeSource       string   `json:"typeSource,omitempty"`
	Name             string   `json:"name"`
	Importance       string   `json:"importance"`
	Tags             []string `json:"tags,omitempty"`
	BriefDescription string   `json:"briefDescription,omitempty"`
	Keywords         []string `json:"keywords,omitempty"`
	LoadMode         string   `json:"loadMode"`
	Content          string   `json:"content,omitempty"`

	// Origin 决定本库对正文的编辑权：original/adaptation 可编辑，reference 只读引用。
	Origin string `json:"origin"`
	// Source 指向原件来源的身份与版本；无名来源如实标注，不伪造。
	Source *SourceRef `json:"source,omitempty"`
	// Fields 是类型专用字段（人物/地点/组织等的模板字段），键受控、值有界。
	Fields map[string]string `json:"fields,omitempty"`
	// Event 仅当 Type=event 时存在；时间线从这些字段与条目本体派生。
	Event *EventDetail `json:"event,omitempty"`

	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// SourceRef 记录条目来源的身份与版本。
//
// 只保存“可展示、可核对”的身份信息：原始文件绝对路径属于本机隐私，
// 绝不写入这里（校验会拒绝绝对路径），只允许相对定位或稳定的来源 ID。
type SourceRef struct {
	// Kind 是来源类型：master/lore/world/file/manual。
	Kind string `json:"kind"`
	// ID 是来源实体 ID（如 Master 条目 ID、旧 Lore 条目 ID、World 实体 ID）。
	ID string `json:"id,omitempty"`
	// Revision 是引用时固定的来源版本标记；只读引用据此识别“来源已更新”。
	Revision string `json:"revision,omitempty"`
	// Locator 是可选的人类可读定位（如章节/页码/相对路径），不得是绝对路径。
	Locator string `json:"locator,omitempty"`
	// Label 是来源展示名。
	Label string `json:"label,omitempty"`
	// Updated 表示来源版本可能已变化（由服务端在读取时核对，不由客户端写入）。
	Updated bool `json:"updated,omitempty"`
}

// EventDetail 是事件条目的结构化部分。时间线不单独存储：
// 它由所有 Type=event 的条目按 (order, era, name) 排序即时派生。
type EventDetail struct {
	// Order 是同一年代内的先后顺序（可负，允许“史前”）。
	Order int `json:"order"`
	// Era 是时代标签（自由文本，如“北宋末年”）。
	Era string `json:"era"`
	// Category 是事件类别：background/historical/planned。
	Category string `json:"category"`
	// ParticipantItemIDs 是参与者条目的稳定 ID。
	ParticipantItemIDs []string `json:"participantItemIds,omitempty"`
	// LocationItemID 是地点条目的稳定 ID。
	LocationItemID string `json:"locationItemId,omitempty"`
}

// Relation 是库内两条条目之间的关联。两端都必须是本库存在的条目 ID；
// 名称只作展示，不参与引用解析（同名条目由 ID 区分）。
type Relation struct {
	ID string `json:"id"`
	// FromItemID/ToItemID 是库内稳定条目 ID。
	FromItemID string `json:"fromItemId"`
	ToItemID   string `json:"toItemId"`
	// Kind 是受控关系类型；Label 是展示覆盖，Note 是补充说明。
	Kind  string `json:"kind"`
	Label string `json:"label,omitempty"`
	Note  string `json:"note,omitempty"`
	// Since/Until 是可选的虚构时间范围（自由文本，不做数值解析）。
	Since     string `json:"since,omitempty"`
	Until     string `json:"until,omitempty"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// Summary 是列表项；计数值由库内容即时派生，不持久化。
type Summary struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Summary        string `json:"summary,omitempty"`
	Purpose        string `json:"purpose"`
	Tone           string `json:"tone,omitempty"`
	ItemCount      int    `json:"itemCount"`
	EventCount     int    `json:"eventCount"`
	RelationCount  int    `json:"relationCount"`
	ReferenceCount int    `json:"referenceCount"`
	ResidentCount  int    `json:"residentCount"`
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
}

// LoadWarning 表示列表扫描时无法解析的库文件（不静默跳过）。
type LoadWarning struct {
	File   string `json:"file"`
	ID     string `json:"id,omitempty"`
	Reason string `json:"reason"`
}

// ListResult 是列表扫描结果。
type ListResult struct {
	Libraries []Summary     `json:"libraries"`
	Warnings  []LoadWarning `json:"warnings"`
}

// TimelineEntry 是派生时间线的一项。它不落盘，只由事件条目派生。
type TimelineEntry struct {
	ItemID       string   `json:"itemId"`
	Title        string   `json:"title"`
	Era          string   `json:"era"`
	Order        int      `json:"order"`
	Category     string   `json:"category"`
	Enabled      bool     `json:"enabled"`
	Summary      string   `json:"summary,omitempty"`
	Participants []string `json:"participants,omitempty"`
	LocationID   string   `json:"locationId,omitempty"`
}

// Impact 描述删除某个条目会波及的引用，用于删除前的影响预览。
type Impact struct {
	ItemID    string          `json:"itemId"`
	ItemName  string          `json:"itemName"`
	Relations []Relation      `json:"relations"`
	Events    []TimelineEntry `json:"events"`
}

// Empty 表示该条目没有任何被引用关系。
func (i Impact) Empty() bool { return len(i.Relations) == 0 && len(i.Events) == 0 }

// DeleteItemResult 是删除条目的结果：删除后同步清理了哪些引用。
type DeleteItemResult struct {
	DeletedID          string   `json:"deletedId"`
	RemovedRelationIDs []string `json:"removedRelationIds"`
	UpdatedEventIDs    []string `json:"updatedEventIds"`
}

// CreateInput 是创建库的入参。刻意不含 ID/SchemaVersion/CreatedAt/UpdatedAt。
type CreateInput struct {
	Name          string `json:"name"`
	Summary       string `json:"summary,omitempty"`
	Purpose       string `json:"purpose,omitempty"`
	Tone          string `json:"tone,omitempty"`
	StartingPoint string `json:"startingPoint,omitempty"`
}

// MetaPatchInput 是库元信息的部分更新；未提供的字段保持不变。
type MetaPatchInput struct {
	Name          *string `json:"name,omitempty"`
	Summary       *string `json:"summary,omitempty"`
	Purpose       *string `json:"purpose,omitempty"`
	Tone          *string `json:"tone,omitempty"`
	StartingPoint *string `json:"startingPoint,omitempty"`
}

// ItemInput 是条目创建/更新入参。
//
// 创建时 ID 可留空（服务端按名称生成稳定 ID）；更新时 ID 必填。
// BaseUpdatedAt 是条目级乐观并发基线：与磁盘上的 updatedAt 不一致即 409。
//
// 可选语义：Content/BriefDescription 用指针区分“未提交该字段（保持原值）”
// 与“显式清空（空串）”；正文是用户最贵的资产，绝不能因为省略字段被清掉。
// Tags/Keywords/Fields 为 nil 同样表示“不修改”。
type ItemInput struct {
	ID               string            `json:"id,omitempty"`
	Enabled          *bool             `json:"enabled,omitempty"`
	Type             string            `json:"type"`
	TypeSource       string            `json:"typeSource,omitempty"`
	Name             string            `json:"name"`
	Importance       string            `json:"importance,omitempty"`
	Tags             []string          `json:"tags,omitempty"`
	BriefDescription *string           `json:"briefDescription,omitempty"`
	Keywords         []string          `json:"keywords,omitempty"`
	LoadMode         string            `json:"loadMode,omitempty"`
	Content          *string           `json:"content,omitempty"`
	Origin           string            `json:"origin,omitempty"`
	Source           *SourceRef        `json:"source,omitempty"`
	Fields           map[string]string `json:"fields,omitempty"`
	Event            *EventDetail      `json:"event,omitempty"`
	BaseUpdatedAt    string            `json:"baseUpdatedAt,omitempty"`
}

// RelationInput 是关系创建/更新入参。关系是小对象，更新按整体替换处理：
// label/note/since/until 省略即清空，两端 ID 与类型省略则保持原值。
type RelationInput struct {
	ID         string `json:"id,omitempty"`
	FromItemID string `json:"fromItemId"`
	ToItemID   string `json:"toItemId"`
	Kind       string `json:"kind,omitempty"`
	Label      string `json:"label,omitempty"`
	Note       string `json:"note,omitempty"`
	Since      string `json:"since,omitempty"`
	Until      string `json:"until,omitempty"`
}
