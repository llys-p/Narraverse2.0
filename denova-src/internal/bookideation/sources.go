package bookideation

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Source kinds.
const (
	KindLorebook      = "lorebook"
	KindCharacterCard = "character_card"
)

// Entry roles keep card opening material addressable as scene material instead
// of letting it collapse into a character biography.
const (
	RoleProfile  = "profile"
	RoleOpening  = "opening"
	RoleDialogue = "example_dialogue"
	RolePrompt   = "source_prompt"
	RoleEntry    = "entry"
)

const (
	maxSourceBytes     = 4 << 20
	maxEntryRunes      = 12_000
	truncationMarker   = "{{original_data:"
	maxPlainTextBlocks = 80
)

// ParsedSource is the read-only snapshot produced from user-selected material.
type ParsedSource struct {
	Kind        string
	Name        string
	Entries     []SourceEntry
	Warnings    []string
	ContentHash string
}

var (
	bracketSectionPattern = regexp.MustCompile(`【([^】\n]{1,80})】`)
	markdownHeadingOpen   = regexp.MustCompile(`(?m)^#{1,6}\s+\S`)
	whitespacePattern     = regexp.MustCompile(`[、,，;；/]`)
)

// ParseMaterialSource reads one selected 设定书 or 角色卡 without touching the
// original file. It accepts JSON (SillyTavern card v2, standalone lorebook,
// 叙界 library book objects) and plain text or Markdown, and retains the raw
// body of every section it finds.
func ParseMaterialSource(filename string, data []byte) (ParsedSource, error) {
	if len(data) == 0 {
		return ParsedSource{}, errors.New("素材内容为空")
	}
	if len(data) > maxSourceBytes {
		return ParsedSource{}, fmt.Errorf("单个素材超过 %d MiB 上限", maxSourceBytes>>20)
	}
	name := strings.TrimSpace(strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename)))
	trimmed := bytesTrimSpace(data)
	if len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[') {
		var payload map[string]any
		if err := json.Unmarshal(trimmed, &payload); err != nil {
			return ParsedSource{}, fmt.Errorf("素材 JSON 解析失败: %w", err)
		}
		if looksLikeCharacterCard(payload) {
			return parseCharacterCard(payload, name, data)
		}
		if parsed, ok, err := parseLorebookJSON(payload, name, data); err != nil {
			return ParsedSource{}, err
		} else if ok {
			return parsed, nil
		}
		return ParsedSource{}, errors.New("无法识别该 JSON 素材，请提供设定书或角色卡")
	}
	return parsePlainText(trimmed, name, data)
}

func parseCharacterCard(payload map[string]any, name string, raw []byte) (ParsedSource, error) {
	card := payload
	if nested, ok := nestedMap(payload, "data"); ok {
		card = nested
	}
	warnings := warningsFor(raw)
	displayName := firstString(card, "name", "char_name")
	if displayName == "" {
		displayName = name
	}
	if displayName == "" {
		return ParsedSource{}, errors.New("角色卡缺少名称")
	}
	entries := make([]SourceEntry, 0, 12)
	appendEntry := func(label, value, role string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		content, truncated := truncateRunes(value, maxEntryRunes)
		entries = append(entries, SourceEntry{
			ID:        fmt.Sprintf("tmp-%d", len(entries)),
			Name:      displayName + " · " + label,
			Content:   content,
			Keywords:  []string{displayName},
			Role:      role,
			Truncated: truncated,
		})
	}
	// Prompt-shaped card fields stay source content. They are never promoted to
	// host instructions by this flow.
	appendEntry("简介", firstString(card, "description", "notes"), RoleProfile)
	appendEntry("外貌", firstString(card, "appearance"), RoleProfile)
	appendEntry("性格", firstString(card, "personality"), RoleProfile)
	appendEntry("关系", firstString(card, "relationship"), RoleProfile)
	appendEntry("场景", firstString(card, "scenario"), RoleProfile)
	appendEntry("开场语", firstString(card, "first_mes", "greeting"), RoleOpening)
	for index, greeting := range stringSlice(card["alternate_greetings"]) {
		label := fmt.Sprintf("备选开场 %d", index+1)
		appendEntry(label, greeting, RoleOpening)
	}
	appendEntry("示例对话", firstString(card, "mes_example", "example_dialogue"), RoleDialogue)
	appendEntry("角色设定指令", firstString(card, "system_prompt"), RolePrompt)
	appendEntry("置尾指令", firstString(card, "post_history_instructions"), RolePrompt)
	appendEntry("扮演备注", firstString(card, "character_note", "creator_notes"), RoleProfile)
	if len(entries) == 0 {
		return ParsedSource{}, errors.New("角色卡没有可用的正文字段")
	}
	if tags := stringSlice(card["tags"]); len(tags) > 0 {
		warnings = append(warnings, "卡片标签："+strings.Join(tags, "、"))
	}
	return ParsedSource{
		Kind:        KindCharacterCard,
		Name:        displayName,
		Entries:     entries,
		Warnings:    warnings,
		ContentHash: hashBytes(raw),
	}, nil
}

func parseLorebookJSON(payload map[string]any, name string, raw []byte) (ParsedSource, bool, error) {
	books := payloadBooks(payload)
	if len(books) == 0 {
		return ParsedSource{}, false, nil
	}
	warnings := warningsFor(raw)
	entries := make([]SourceEntry, 0, 32)
	// The book's own title wins over the file name; the file name is only a
	// fallback for sources that carry no title field.
	title := ""
	for _, book := range books {
		if bookTitle := firstString(book, "title", "name"); bookTitle != "" && title == "" {
			title = bookTitle
		}
		if content := firstString(book, "content", "text", "description"); content != "" {
			for _, entry := range segmentPlainText(content) {
				entry.ID = fmt.Sprintf("tmp-%d", len(entries))
				entries = append(entries, entry)
			}
		}
		for _, item := range bookLorebookEntries(book) {
			itemName := firstString(item, "comment", "name", "key")
			content := firstString(item, "content", "text")
			if strings.TrimSpace(content) == "" {
				continue
			}
			body, truncated := truncateRunes(content, maxEntryRunes)
			keywords := stringSlice(item["keys"])
			if len(keywords) == 0 {
				keywords = splitKeywords(itemName)
			}
			entries = append(entries, SourceEntry{
				ID:        fmt.Sprintf("tmp-%d", len(entries)),
				Name:      orDefault(itemName, fmt.Sprintf("条目 %d", len(entries)+1)),
				Content:   body,
				Keywords:  keywords,
				Role:      RoleEntry,
				Truncated: truncated,
			})
		}
	}
	if len(entries) == 0 {
		return ParsedSource{}, true, errors.New("设定书没有可用的条目正文")
	}
	if title == "" {
		title = "未命名设定书"
	}
	return ParsedSource{
		Kind:        KindLorebook,
		Name:        title,
		Entries:     entries,
		Warnings:    warnings,
		ContentHash: hashBytes(raw),
	}, true, nil
}

func parsePlainText(text []byte, name string, raw []byte) (ParsedSource, error) {
	entries := segmentPlainText(string(text))
	if len(entries) == 0 {
		return ParsedSource{}, errors.New("素材没有可用正文")
	}
	for i := range entries {
		entries[i].ID = fmt.Sprintf("tmp-%d", i)
	}
	return ParsedSource{
		Kind:        KindLorebook,
		Name:        orDefault(name, "未命名素材"),
		Entries:     entries,
		Warnings:    warningsFor(raw),
		ContentHash: hashBytes(raw),
	}, nil
}

// segmentPlainText keeps the original wording and only splits: 【键】正文 first
// (the convention the 叙界 library uses), then Markdown headings, then blank-line
// blocks. Undocumented text stays as one 待分类 block rather than being dropped.
func segmentPlainText(content string) []SourceEntry {
	content = strings.ReplaceAll(content, "\r\n", "\n")
	if strings.TrimSpace(content) == "" {
		return nil
	}
	entries := make([]SourceEntry, 0, 16)
	add := func(name, body string, keywords []string) {
		body = strings.TrimSpace(body)
		if body == "" {
			return
		}
		text, truncated := truncateRunes(body, maxEntryRunes)
		if name == "" {
			name = "待分类原文"
		}
		entries = append(entries, SourceEntry{
			Name:      name,
			Content:   text,
			Keywords:  keywords,
			Role:      RoleEntry,
			Truncated: truncated,
		})
	}
	locations := bracketSectionPattern.FindAllStringIndex(content, -1)
	if len(locations) > 0 {
		if preamble := strings.TrimSpace(content[:locations[0][0]]); preamble != "" {
			add("开篇说明", preamble, nil)
		}
		for i, location := range locations {
			key := bracketSectionPattern.FindStringSubmatch(content[location[0]:location[1]])[1]
			end := len(content)
			if i+1 < len(locations) {
				end = locations[i+1][0]
			}
			add(key, content[location[1]:end], splitKeywords(key))
		}
		return entries
	}
	if markdownHeadingOpen.MatchString(content) {
		lines := strings.Split(content, "\n")
		currentName, buffer := "", strings.Builder{}
		flush := func() {
			add(currentName, buffer.String(), splitKeywords(currentName))
			buffer.Reset()
		}
		for _, line := range lines {
			if match := markdownHeadingOpen.FindString(line); match != "" && strings.HasPrefix(strings.TrimSpace(line), "#") {
				flush()
				currentName = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(line), "#"))
				continue
			}
			buffer.WriteString(line)
			buffer.WriteString("\n")
		}
		flush()
		if len(entries) > 0 {
			return entries
		}
	}
	blocks := strings.Split(content, "\n\n")
	if len(blocks) > maxPlainTextBlocks {
		blocks = blocks[:maxPlainTextBlocks]
	}
	for i, block := range blocks {
		name := fmt.Sprintf("原文段落 %d", i+1)
		if len(blocks) == 1 {
			name = "原文"
		}
		add(name, block, nil)
	}
	return entries
}

func looksLikeCharacterCard(payload map[string]any) bool {
	if _, ok := payload["data"]; ok {
		if nested, nestedOK := payload["data"].(map[string]any); nestedOK {
			if firstString(nested, "name", "char_name") != "" &&
				firstString(nested, "description", "personality", "first_mes", "notes") != "" {
				return true
			}
		}
	}
	if firstString(payload, "char_name") != "" {
		return true
	}
	return firstString(payload, "name") != "" &&
		firstString(payload, "first_mes", "personality", "notes", "description", "relationship") != "" &&
		len(payloadBooks(payload)) == 0
}

func payloadBooks(payload map[string]any) []map[string]any {
	if title := firstString(payload, "title"); title != "" && firstString(payload, "content") != "" {
		return []map[string]any{payload}
	}
	for _, key := range []string{"books", "lorebooks"} {
		if items, ok := payload[key].([]any); ok {
			return mapSlice(items)
		}
	}
	if items, ok := payload["book"].([]any); ok {
		return mapSlice(items)
	}
	return nil
}

func bookLorebookEntries(book map[string]any) []map[string]any {
	lorebook, ok := nestedMap(book, "lorebook")
	if !ok {
		lorebook = book
	}
	if entries, ok := lorebook["entries"].(map[string]any); ok {
		out := make([]map[string]any, 0, len(entries))
		for _, value := range entries {
			if item, ok := value.(map[string]any); ok {
				out = append(out, item)
			}
		}
		sortMapEntries(out)
		return out
	}
	if entries, ok := lorebook["entries"].([]any); ok {
		return mapSlice(entries)
	}
	return nil
}

// sortMapEntries stabilises JSON object iteration so repeated parses of the
// same source produce the same entry order.
func sortMapEntries(items []map[string]any) {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && strings.Compare(entrySortKey(items[j-1]), entrySortKey(items[j])) > 0; j-- {
			items[j-1], items[j] = items[j], items[j-1]
		}
	}
}

func entrySortKey(item map[string]any) string {
	if position, ok := item["position"]; ok {
		if number, isNumber := position.(float64); isNumber {
			return fmt.Sprintf("%09.0f-%s", number, firstString(item, "comment", "name"))
		}
	}
	return firstString(item, "comment", "name")
}

func splitKeywords(value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	parts := whitespacePattern.Split(value, -1)
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if utf8.RuneCountInString(part) >= 2 {
			out = append(out, part)
		}
	}
	if len(out) == 0 {
		return []string{value}
	}
	return out
}

func warningsFor(raw []byte) []string {
	if strings.Contains(string(raw), truncationMarker) {
		return []string{"原件含内容已截断标记"}
	}
	return nil
}

func nestedMap(payload map[string]any, key string) (map[string]any, bool) {
	value, ok := payload[key].(map[string]any)
	return value, ok
}

func firstString(payload map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := payload[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func stringSlice(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
			out = append(out, strings.TrimSpace(text))
		}
	}
	return out
}

func mapSlice(items []any) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if record, ok := item.(map[string]any); ok {
			out = append(out, record)
		}
	}
	return out
}

func orDefault(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func bytesTrimSpace(data []byte) []byte {
	return []byte(strings.TrimSpace(string(data)))
}

// hashBytes records the exact source version a draft was built from, so a later
// "来源有新版" check can compare without trusting names.
func hashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}
