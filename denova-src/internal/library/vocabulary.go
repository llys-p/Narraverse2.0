package library

import "denova/internal/book"

// 本文件是设定库唯一的词表定义处：类型、加载档位、来源类型、条目来源形态、
// 关系类型、事件类别。全部值都是持久化在 library-<id>.json 里的稳定字符串，
// 改名即破坏旧数据，因此只能新增、不能重命名。
//
// 基础类型复用旧作品 Lore 的词表（internal/book 的 normalizeLoreType），
// 只有设定库新引入的类型（event/ability）在这里追加。

// SchemaVersion 是设定库磁盘结构的当前版本号。
const SchemaVersion = 1

// 条目类型。基础七类与旧 Lore 完全一致；event 是事件条目（时间线的唯一真源），
// ability 是“技能/武技”类条目（刻意不与平台 Skills 混名）。
const (
	TypeCharacter = "character"
	TypeWorld     = "world"
	TypeLocation  = "location"
	TypeFaction   = "faction"
	TypeRule      = "rule"
	TypeItem      = "item"
	TypeOther     = "other"
	// TypeEvent 事件条目：关联参与者/地点，带顺序与年代，时间线是它的派生视图。
	TypeEvent = "event"
	// TypeAbility 技能/武技条目；L1 只做条目与三档，不含规则结算。
	TypeAbility = "ability"
)

// BaseItemTypes 返回旧 Lore 已有的基础类型（顺序即 UI 展示顺序）。
func BaseItemTypes() []string {
	return []string{TypeCharacter, TypeWorld, TypeLocation, TypeFaction, TypeRule, TypeItem, TypeOther}
}

// AllItemTypes 返回设定库支持的完整类型集合。
func AllItemTypes() []string {
	return append(BaseItemTypes(), TypeEvent, TypeAbility)
}

// EventTypeAlias 是事件条目的别名，供 UI 区分“普通条目 / 事件”。
const EventTypeAlias = TypeEvent

// 加载档位。与旧 Lore 同名同值；enabled=false 是总开关，不是第四档。
const (
	LoadModeResident = book.LoreLoadModeResident
	LoadModeAuto     = book.LoreLoadModeAuto
	LoadModeManual   = book.LoreLoadModeManual
)

// AllLoadModes 返回三档档位（顺序即 UI 展示顺序）。
func AllLoadModes() []string {
	return []string{LoadModeResident, LoadModeAuto, LoadModeManual}
}

// 重要度。与旧 Lore 同词表（major/important/minor）。
// 新库刻意不把重要度作为档位推导依据：major 不等于自动常驻。
const (
	ImportanceMajor     = "major"
	ImportanceImportant = "important"
	ImportanceMinor     = "minor"
)

// AllImportanceLevels 返回全部重要度取值。
func AllImportanceLevels() []string {
	return []string{ImportanceMajor, ImportanceImportant, ImportanceMinor}
}

// 条目来源形态：决定条目正文能否在本库编辑。
const (
	// OriginOriginal 本库原创条目，正文可编辑。
	OriginOriginal = "original"
	// OriginAdaptation 由来源复制而来、在本库可编辑的改编条目（保留来源指向）。
	OriginAdaptation = "adaptation"
	// OriginReference 对来源版本的只读引用；正文以来源为准，本库不得改写。
	OriginReference = "reference"
)

// AllOrigins 返回全部来源形态。
func AllOrigins() []string {
	return []string{OriginOriginal, OriginAdaptation, OriginReference}
}

// 来源类型（sourceKind）。master/lore/world 对应既有原件体系，
// manual 表示用户口述/外部输入，file 表示用户导入的本地文件材料。
const (
	SourceKindMaster = "master"
	SourceKindLore   = "lore"
	SourceKindWorld  = "world"
	SourceKindFile   = "file"
	SourceKindManual = "manual"
)

// AllSourceKinds 返回全部来源类型。
func AllSourceKinds() []string {
	return []string{SourceKindMaster, SourceKindLore, SourceKindWorld, SourceKindFile, SourceKindManual}
}

// 关系类型。受控词表保证关系可检索、可展示；展示文案由 UI 用 label 覆盖。
// 只增不改：新增类型需同步 UI 词条与筛选。
const (
	RelationAlly      = "ally"
	RelationRival     = "rival"
	RelationFamily    = "family"
	RelationMentor    = "mentor"
	RelationMemberOf  = "member_of"
	RelationLocatedIn = "located_in"
	RelationOwns      = "owns"
	RelationKnows     = "knows"
	RelationOther     = "other"
)

// AllRelationKinds 返回全部关系类型。
func AllRelationKinds() []string {
	return []string{
		RelationAlly, RelationRival, RelationFamily, RelationMentor,
		RelationMemberOf, RelationLocatedIn, RelationOwns, RelationKnows, RelationOther,
	}
}

// 事件类别。与旧 World 时间线可写词表一致（background/historical/planned），
// 便于迁移时直接映射；旧值的 canon/空/未知保留原始语义，展示层再归一。
const (
	EventCategoryBackground = "background"
	EventCategoryHistorical = "historical"
	EventCategoryPlanned    = "planned"
)

// AllEventCategories 返回全部事件类别。
func AllEventCategories() []string {
	return []string{EventCategoryBackground, EventCategoryHistorical, EventCategoryPlanned}
}

// Purpose 是库的用途标注，仅用于列表筛选，不决定存储归属。
const (
	PurposeAny        = "any"
	PurposeWriting    = "writing"
	PurposeGame       = "game"
	PurposeNarraverse = "narraverse"
	PurposeSandbox    = "sandbox"
	PurposeMixed      = "mixed"
)

// AllPurposes 返回全部用途标注。
func AllPurposes() []string {
	return []string{PurposeAny, PurposeWriting, PurposeGame, PurposeNarraverse, PurposeSandbox, PurposeMixed}
}
