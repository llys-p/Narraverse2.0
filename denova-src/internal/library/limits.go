package library

// 本文件集中定义设定库的全部数量与长度上限（L1 数据契约 §7）。
// 超限一律返回 400 字段错误，绝不静默截断——静默截断会让用户以为资料已保存。
//
// 这些上限描述的是“存储与编辑边界”，不是模型读取预算：
// L2 的常驻/按需/单轮合计预算另有一套门禁，两者不得相加后当作模型容量。

const (
	// MaxLibraryFileBytes 单个库文件的字节上限。超过即拒绝保存（400），
	// 用户应拆分为多个库，而不是让一个库无限增长。
	MaxLibraryFileBytes = 8 << 20 // 8 MiB
	// MaxLibrariesPerStore 数据目录内库的数量上限，仅约束“新建”，不阻止读取既有库。
	MaxLibrariesPerStore = 200

	// MaxItems 单个库的条目上限（含事件条目）。
	MaxItems = 2000
	// MaxRelations 单个库的关系上限。
	MaxRelations = 4000
	// MaxEvents 单个库的事件条目上限（items 的子集）。
	MaxEvents = 500

	// MaxLibraryNameRunes 库名长度上限。
	MaxLibraryNameRunes = 120
	// MaxLibrarySummaryRunes 库简介长度上限。
	MaxLibrarySummaryRunes = 4000
	// MaxToneRunes 背景基调长度上限。
	MaxToneRunes = 200
	// MaxStartingPointRunes 背景起点长度上限。
	MaxStartingPointRunes = 2000

	// MaxItemNameRunes 条目名称长度上限。同名条目允许存在，由 ID 区分。
	MaxItemNameRunes = 120
	// MaxBriefRunes 条目简介长度上限。
	MaxBriefRunes = 500
	// MaxItemContentRunes 条目正文长度上限（存储边界，不等于可注入模型的长度）。
	MaxItemContentRunes = 200000
	// MaxTags 单条目标签数量上限。
	MaxTags = 30
	// MaxTagRunes 单个标签长度上限。
	MaxTagRunes = 60
	// MaxKeywords 单条目关键词数量上限。
	MaxKeywords = 50
	// MaxKeywordRunes 单个关键词长度上限。
	MaxKeywordRunes = 60

	// MaxFields 单条目类型专用字段数量上限（受控模板键，不做动态 schema 编辑器）。
	MaxFields = 40
	// MaxFieldKeyRunes 类型专用字段键长度上限。
	MaxFieldKeyRunes = 60
	// MaxFieldValueRunes 类型专用字段值长度上限。
	MaxFieldValueRunes = 2000

	// MaxSourceLabelRunes 来源展示名长度上限。
	MaxSourceLabelRunes = 200
	// MaxSourceIDRunes 来源实体 ID 长度上限。
	MaxSourceIDRunes = 200
	// MaxSourceRevisionRunes 来源版本标记长度上限。
	MaxSourceRevisionRunes = 200
	// MaxSourceLocatorRunes 来源定位串长度上限（只允许相对定位，禁止本机绝对路径）。
	MaxSourceLocatorRunes = 300

	// MaxRelationNoteRunes 关系备注长度上限。
	MaxRelationNoteRunes = 2000
	// MaxRelationLabelRunes 关系展示标签长度上限。
	MaxRelationLabelRunes = 120
	// MaxEraRunes 事件年代标签长度上限。
	MaxEraRunes = 120
	// MaxEventParticipants 单个事件的参与者上限。
	MaxEventParticipants = 50
	// MaxEventOrderAbs 事件顺序的绝对值上限，防止写入异常大的排序键。
	MaxEventOrderAbs = 1000000

	// MaxRequestBodyBytes 单个 API 请求体上限（HTTP 层）。与 MaxLibraryFileBytes 保持一致。
	MaxRequestBodyBytes = 8 << 20
)
