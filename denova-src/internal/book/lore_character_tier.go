package book

import "errors"

// LoreCharacterTierForDisplay never infers a display tier from importance.
func LoreCharacterTierForDisplay(item LoreItem) string {
	if item.Type == "character" && (item.CharacterTier == "major" || item.CharacterTier == "minor") {
		return item.CharacterTier
	}
	return "unclassified"
}

// Character tiers are optional book-local display metadata. Importance, load
// mode, sorting and prompt assembly retain their existing semantics.
func validateLoreCharacterTier(tier *string, itemType string) error {
	if tier == nil {
		return nil
	}
	switch *tier {
	case "unclassified":
		return nil
	case "major", "minor":
		if normalizeLoreType(itemType) == "character" {
			return nil
		}
	}
	return errors.New("人物层级须为 major、minor 或 unclassified，主要/次要仅适用于人物条目")
}

func loreInputCharacterTier(tier *string, fallback string) string {
	if tier == nil {
		return fallback
	}
	return *tier
}
