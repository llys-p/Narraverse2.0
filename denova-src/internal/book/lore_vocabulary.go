package book

import "fmt"

// 本文件把旧 Lore 已在使用的“条目词表”和“稳定 ID 规则”以纯函数形式导出，
// 供 internal/library（独立作品设定库）复用。目的：条目类型、加载档位、重要度、
// ID 词干在全仓只有一套实现，新库不重建第二套原件/翻译/分类系统。
//
// 约定：这里只转发既有实现，不改变旧 Lore 的任何既有语义。

// NormalizeLoreType 把任意类型串收敛到合法的基础条目类型
// （character/world/location/faction/rule/item/other），未知值回落 other。
func NormalizeLoreType(t string) string { return normalizeLoreType(t) }

// NormalizeLoreImportance 把任意重要度串收敛到 major/important/minor，未知值回落 important。
func NormalizeLoreImportance(v string) string { return normalizeLoreImportance(v) }

// NormalizeLoreLoadModeStrict 只接受 resident/auto/manual 三个字面量，其余回落 auto。
//
// 与旧 NormalizeLoreLoadMode 的区别：旧实现会把 major 重要度自动升级为常驻，
// 那是旧作品 Lore 的历史行为。新设定库要求“档位与重要度解耦”
// （见 LIBRARY_L1_DATA_CONTRACT §6），因此需要这个只做字面量收敛的严格版本。
func NormalizeLoreLoadModeStrict(v string) string {
	if explicit, ok := explicitLoreLoadMode(v); ok {
		return explicit
	}
	return LoreLoadModeAuto
}

// NormalizeLoreID 保留 ID 中允许出现的字符（字母/数字/连字符/下划线）。
func NormalizeLoreID(id string) string { return normalizeLoreID(id) }

// LoreIDBaseFromName 由名称派生稳定 ID 词干（与旧 Lore 条目 ID 同规则）。
func LoreIDBaseFromName(name string) string { return loreIDBaseFromName(name) }

// UniqueIDFromBase 在已占用集合内生成唯一 ID，冲突时追加 -2、-3……（与旧 Lore 同规则）。
func UniqueIDFromBase(used map[string]bool, base string) string {
	base = normalizeLoreID(base)
	if base == "" {
		base = loreIDBaseFromName("item")
	}
	if base == "" || !used[base] {
		return base
	}
	for suffix := 2; ; suffix++ {
		candidate := fmt.Sprintf("%s-%d", base, suffix)
		if !used[candidate] {
			return candidate
		}
	}
}

// NormalizeLoreStringList 去空白、去重并保持顺序（旧 Lore 的标签/关键词规范化规则）。
func NormalizeLoreStringList(values []string) []string { return normalizeLoreStringList(values) }

// NormalizeLoreSummaryLine 规范化单行摘要（去控制字符与多余空白）。
func NormalizeLoreSummaryLine(line string) string { return normalizeLoreSummaryLine(line) }

// ValidateLoreReferenceName 校验旧 Lore 的“名称引用”约束。
// 新库不再禁止同名条目，但引用名称仍需合法，故导出复用。
func ValidateLoreReferenceName(name string) error { return validateLoreReferenceName(name) }
