package app

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"denova/internal/book"
	"denova/internal/worldcontext"
)

const hostBookMaxBytes = 128 << 10

type HostBookLoreItem struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	LoadMode         string `json:"load_mode"`
	BriefDescription string `json:"brief_description"`
	Enabled          bool   `json:"enabled"`
}

// The iframe receives a directory, never a second copy of book bodies.
func (a *App) HostBookLore(token, frame string) ([]HostBookLoreItem, HostContextState, error) {
	s := a.worldContextHost()
	hash, err := s.authenticate(token, true)
	if err != nil || !validFrameInstance(frame) {
		return nil, HostContextState{}, trustedHostError()
	}
	s.mu.Lock()
	var binding *hostFrameBinding
	if session := s.sessions[hash]; session != nil {
		binding = session.bindings[hostBindingKey(worldcontext.ConsumerNarraverse, frame)]
	}
	s.mu.Unlock()
	if binding == nil || binding.book == nil {
		return nil, HostContextState{}, trustedHostError()
	}
	if err := s.verifyBookContext(binding.book); err != nil {
		return nil, HostContextState{}, err
	}
	items, err := book.NewLoreStore(binding.book.workspace).List()
	if err != nil {
		return nil, HostContextState{}, bookContextError(worldcontext.ErrContextUnavailable, "无法读取本书资料 / Cannot read this book's lore")
	}
	result := make([]HostBookLoreItem, 0, len(items))
	for _, item := range items {
		result = append(result, HostBookLoreItem{ID: item.ID, Name: item.Name, LoadMode: item.LoadMode, BriefDescription: item.BriefDescription, Enabled: item.Enabled})
	}
	if err := s.verifyBookContext(binding.book); err != nil {
		return nil, HostContextState{}, err
	}
	return result, binding.book.state(), nil
}

// Book ownership is captured by the host, never supplied by the iframe.
// The opaque key lets the iframe keep its existing adventures separated by book.
type hostBookContext struct {
	workspace, key, name, loreRevision, overviewRevision string
	overviewPresent                                      bool
}

func bookContextError(code worldcontext.ErrorCode, message string) error {
	return &worldcontext.DomainError{Code: code, Message: message}
}

func readHostBookOverview(workspace string) (string, string, bool, error) {
	content, revision, err := book.NewService(workspace).ReadFileWithRevision(BookOverviewPath)
	if errors.Is(err, os.ErrNotExist) {
		return "", "", false, nil
	}
	return content, revision, strings.TrimSpace(content) != "", err
}

func (s *WorldContextHostService) captureBookContext() (*hostBookContext, error) {
	workspace := strings.TrimSpace(s.app.Workspace())
	if workspace == "" {
		return nil, bookContextError(worldcontext.ErrContextUnavailable, "请先选择一本书籍 / Select a book first")
	}
	workspace = filepath.Clean(workspace)
	identity := workspace
	// Windows workspaces are case-insensitive; spelling is not a new book.
	if filepath.Separator == '\\' {
		identity = strings.ToLower(identity)
	}
	hash := sha256.Sum256([]byte(identity))
	b := &hostBookContext{workspace: workspace, key: hex.EncodeToString(hash[:16]), name: filepath.Base(workspace)}
	if meta, err := s.app.BookInfo(workspace); err == nil && strings.TrimSpace(meta.Title) != "" {
		b.name = strings.TrimSpace(meta.Title)
	}
	var err error
	b.loreRevision, err = book.NewLoreStore(workspace).Revision()
	if err != nil {
		return nil, bookContextError(worldcontext.ErrContextUnavailable, "无法读取本书资料 / Cannot read this book's lore")
	}
	_, b.overviewRevision, b.overviewPresent, err = readHostBookOverview(workspace)
	if err != nil {
		return nil, bookContextError(worldcontext.ErrContextUnavailable, "无法读取书籍总览 / Cannot read the book overview")
	}
	return b, nil
}

func (b *hostBookContext) state() HostContextState {
	return HostContextState{State: "active", BookBound: true, BookKey: b.key, BookName: b.name,
		BookRevision: b.loreRevision + ":" + b.overviewRevision, OverviewPresent: b.overviewPresent}
}

func (s *WorldContextHostService) verifyBookContext(b *hostBookContext) error {
	current := filepath.Clean(strings.TrimSpace(s.app.Workspace()))
	if current != b.workspace && !(filepath.Separator == '\\' && strings.EqualFold(current, b.workspace)) {
		return bookContextError(worldcontext.ErrBookChanged, "书籍已切换，本次未生成；请在当前书籍中重新开始 / The book changed; start again in the current book")
	}
	revision, err := book.NewLoreStore(b.workspace).Revision()
	if err != nil || revision != b.loreRevision {
		return bookContextError(worldcontext.ErrBookStale, "本书资料已更新，请重新绑定 / Book lore changed; rebind the context")
	}
	_, revision, present, err := readHostBookOverview(b.workspace)
	if err != nil || revision != b.overviewRevision || present != b.overviewPresent {
		return bookContextError(worldcontext.ErrBookStale, "书籍总览已更新，请重新绑定 / The book overview changed; rebind the context")
	}
	return nil
}

func boundedBookText(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	value = value[:limit]
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value
}

// Assembly is read-only. Disabled entries never override an explicit selection,
// and resident/selected IDs are deduplicated rather than copied into another store.
func (s *WorldContextHostService) assembleBookBackground(b *hostBookContext, ids []string) (string, error) {
	return s.assembleBookBackgroundWithActivation(b, ids, nil, nil)
}

func (s *WorldContextHostService) assembleBookBackgroundWithActivation(b *hostBookContext, ids []string, messages []ModelGatewayMessage, activation *BookLoreActivation) (string, error) {
	items, err := book.NewLoreStore(b.workspace).List()
	if err != nil {
		return "", bookContextError(worldcontext.ErrContextUnavailable, "无法读取本书资料 / Cannot read this book's lore")
	}
	overview, _, present, err := readHostBookOverview(b.workspace)
	if err != nil {
		return "", bookContextError(worldcontext.ErrContextUnavailable, "无法读取书籍总览 / Cannot read the book overview")
	}
	var body strings.Builder
	if present {
		body.WriteString("## 书籍总览\n" + boundedBookText(overview, 16<<10) + "\n\n")
	}
	byID := make(map[string]book.LoreItem, len(items))
	seen := make(map[string]bool)
	appendItem := func(item book.LoreItem, reason string) {
		if body.Len() >= hostBookMaxBytes-1024 {
			return
		}
		seen[item.ID] = true
		fmt.Fprintf(&body, "## %s [%s; %s]\n%s\n\n", item.Name, item.ID, reason, boundedBookText(item.Content, hostBookMaxBytes-body.Len()-1024))
	}
	for _, item := range items {
		byID[item.ID] = item
		if item.Enabled && item.LoadMode == book.LoreLoadModeResident {
			appendItem(item, "常驻")
		}
	}
	var unavailable []string
	for _, id := range ids {
		if seen[id] {
			continue
		}
		item, ok := byID[id]
		if !ok || !item.Enabled {
			unavailable = append(unavailable, id)
			continue
		}
		appendItem(item, "本轮选用")
	}
	searchText := hostBookActivationText(messages, activation)
	if searchText != "" {
		for _, item := range items {
			if seen[item.ID] || !item.Enabled || item.LoadMode != book.LoreLoadModeAuto || !hostBookLoreMatches(item, searchText) {
				continue
			}
			appendItem(item, "关键词触发")
		}
	}
	if len(unavailable) > 0 {
		fmt.Fprintf(&body, "选定条目不可用，已跳过：%s\n", strings.Join(unavailable, "、"))
	}
	if body.Len() == 0 {
		return "", nil
	}
	return "[Book Background · Read Only]\n本书已保存资料；与本场剧情记录分开。\n" + boundedBookText(body.String(), hostBookMaxBytes-256), nil
}

func hostBookActivationText(messages []ModelGatewayMessage, activation *BookLoreActivation) string {
	depth := 14
	contextText := ""
	if activation != nil {
		depth = activation.ScanDepth
		contextText = activation.ContextText
	}
	if depth < 1 || depth > 60 {
		depth = 14
	}
	var parts []string
	if contextText != "" {
		parts = append(parts, strings.ToLower(contextText))
	}
	count := 0
	for i := len(messages) - 1; i >= 0 && count < depth; i-- {
		message := messages[i]
		if message.Role != "user" && message.Role != "assistant" {
			continue
		}
		count++
		parts = append(parts, strings.ToLower(message.Content))
	}
	return strings.Join(parts, "\n")
}

func hostBookLoreMatches(item book.LoreItem, searchText string) bool {
	if item.Name != "" && strings.Contains(searchText, strings.ToLower(item.Name)) {
		return true
	}
	for _, keyword := range item.Keywords {
		keyword = strings.TrimSpace(keyword)
		if keyword != "" && strings.Contains(searchText, strings.ToLower(keyword)) {
			return true
		}
	}
	return false
}
