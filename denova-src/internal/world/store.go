package world

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"denova/internal/revisionfile"
)

const (
	dirName       = "worlds"
	filePrefix    = "world-"
	fileSuffix    = ".json"
	createRetries = 6
)

// ErrConflict 复用 revisionfile 的内容哈希 CAS 冲突（HTTP 映射 409）。
var ErrConflict = revisionfile.ErrRevisionConflict

var (
	ErrNotFound  = errors.New("世界不存在")
	ErrInvalidID = errors.New("世界 id 非法")
)

// Store 以全局数据目录下的 worlds 子目录为根管理世界 JSON 文件。
type Store struct {
	root string
}

// NewStore 创建世界存储；dataDir 通常是 cfg.DataDir()。
func NewStore(dataDir string) *Store {
	return &Store{root: filepath.Join(strings.TrimSpace(dataDir), dirName)}
}

// Root 返回世界存储目录。
func (s *Store) Root() string { return s.root }

func (s *Store) dir() string { return s.root }

func (s *Store) worldPath(id string) string {
	return filepath.Join(s.dir(), filePrefix+id+fileSuffix)
}

// 使用纳秒精度，保证同秒内连续修改也能得到不同的 updatedAt（仍为合法 ISO8601）。
func nowStamp() string { return time.Now().UTC().Format(time.RFC3339Nano) }

// newServerID 生成服务端世界 id（16 位小写字母数字）。
func newServerID() (string, error) {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	const length = 16
	b := make([]byte, length)
	max := big.NewInt(int64(len(alphabet)))
	for i := range b {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		b[i] = alphabet[n.Int64()]
	}
	return string(b), nil
}

func marshalWorld(w *World) ([]byte, error) {
	return json.MarshalIndent(w, "", "  ")
}

// SummaryOf 由世界内容即时派生列表摘要（计数不持久化）。
func SummaryOf(w World) Summary {
	return Summary{
		ID:             w.ID,
		Name:           w.Name,
		Tagline:        w.Tagline,
		Genre:          w.Genre,
		CoverColor:     w.CoverColor,
		Status:         w.Status,
		CharacterCount: len(w.Characters),
		LocationCount:  len(w.Locations),
		FactionCount:   len(w.Factions),
		TimelineCount:  len(w.Timeline),
		CreatedAt:      w.CreatedAt,
		UpdatedAt:      w.UpdatedAt,
	}
}

// List 扫描目录即时生成摘要；损坏文件进入 Warnings 而非被静默丢弃。
func (s *Store) List(ctx context.Context, statusFilter WorldStatus) (ListResult, error) {
	result := ListResult{Worlds: []Summary{}, Warnings: []LoadWarning{}}
	entries, err := os.ReadDir(s.dir())
	if err != nil {
		if os.IsNotExist(err) {
			return result, nil // 目录尚未创建视为空集合
		}
		return result, err
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasPrefix(name, filePrefix) || !strings.HasSuffix(name, fileSuffix) {
			continue
		}
		path := filepath.Join(s.dir(), name)
		fileID := strings.TrimSuffix(strings.TrimPrefix(name, filePrefix), fileSuffix)
		if !ValidWorldID(fileID) {
			result.Warnings = append(result.Warnings, LoadWarning{File: name, ID: fileID, Reason: "文件名中的世界 id 非法"})
			continue
		}
		snap, err := revisionfile.Read(ctx, path)
		if err != nil {
			result.Warnings = append(result.Warnings, LoadWarning{File: name, ID: fileID, Reason: "读取失败"})
			continue
		}
		if !snap.Exists {
			continue
		}
		var w World
		if err := json.Unmarshal(snap.Content, &w); err != nil {
			result.Warnings = append(result.Warnings, LoadWarning{File: name, ID: fileID, Reason: fmt.Sprintf("解析失败（文件可能已损坏）：%v", err)})
			continue
		}
		if err := validateStoredWorld(&w, fileID); err != nil {
			result.Warnings = append(result.Warnings, LoadWarning{File: name, ID: fileID, Reason: "数据校验失败：" + err.Error()})
			continue
		}
		if statusFilter != "" && w.Status != statusFilter {
			continue
		}
		result.Worlds = append(result.Worlds, SummaryOf(w))
	}
	sort.SliceStable(result.Worlds, func(i, j int) bool {
		if result.Worlds[i].UpdatedAt != result.Worlds[j].UpdatedAt {
			return result.Worlds[i].UpdatedAt > result.Worlds[j].UpdatedAt
		}
		if result.Worlds[i].CreatedAt != result.Worlds[j].CreatedAt {
			return result.Worlds[i].CreatedAt > result.Worlds[j].CreatedAt
		}
		return result.Worlds[i].ID < result.Worlds[j].ID
	})
	return result, nil
}

// Get 读取单个世界，返回世界与其当前内容哈希 revision。缺失=ErrNotFound，损坏=普通错误（500）。
func (s *Store) Get(ctx context.Context, id string) (World, string, error) {
	if !ValidWorldID(id) {
		return World{}, "", ErrInvalidID
	}
	snap, err := revisionfile.Read(ctx, s.worldPath(id))
	if err != nil {
		return World{}, "", err
	}
	if !snap.Exists {
		return World{}, "", ErrNotFound
	}
	var w World
	if err := json.Unmarshal(snap.Content, &w); err != nil {
		return World{}, "", fmt.Errorf("世界文件已损坏：%w", err)
	}
	if err := validateStoredWorld(&w, id); err != nil {
		return World{}, "", fmt.Errorf("世界文件已损坏：%w", err)
	}
	return w, snap.Revision, nil
}

// Create 原子创建一个完整初始世界；服务端生成 id 与时间戳。
func (s *Store) Create(ctx context.Context, in CreateInput) (World, string, error) {
	w := newWorldFromInput(in)
	normalizeWorld(&w)
	w.Status = StatusActive
	if err := validateWorld(&w); err != nil {
		return World{}, "", err
	}
	if err := os.MkdirAll(s.dir(), 0o755); err != nil {
		return World{}, "", err
	}
	now := nowStamp()
	w.CreatedAt, w.UpdatedAt = now, now
	var lastErr error
	for attempt := 0; attempt < createRetries; attempt++ {
		id, err := newServerID()
		if err != nil {
			return World{}, "", err
		}
		w.ID = id
		bytes, err := marshalWorld(&w)
		if err != nil {
			return World{}, "", err
		}
		path := s.worldPath(id)
		// 期望文件尚不存在（MissingRevision），碰撞则换 id 重试。
		res, err := revisionfile.ReplaceIfRevision(ctx, path, revisionfile.MissingRevision, bytes, revisionfile.Options{
			FileMode: 0o644, DirectoryMode: 0o755,
		})
		if err == nil {
			return w, res.Revision, nil
		}
		if !errors.Is(err, ErrConflict) {
			return World{}, "", err
		}
		lastErr = err
	}
	return World{}, "", fmt.Errorf("创建世界失败，多次生成 id 冲突：%w", lastErr)
}

// Replace 以 expected 为基做整文档 CAS 替换；保留原 createdAt，刷新 updatedAt。
func (s *Store) Replace(ctx context.Context, id, expected string, incoming World) (World, string, error) {
	if !ValidWorldID(id) {
		return World{}, "", ErrInvalidID
	}
	if strings.TrimSpace(expected) == "" {
		return World{}, "", fieldError("expected_revision", "不能为空")
	}
	incoming.ID = id
	normalizeWorld(&incoming)
	if err := validateWorld(&incoming); err != nil {
		return World{}, "", err
	}
	if err := os.MkdirAll(s.dir(), 0o755); err != nil {
		return World{}, "", err
	}
	path := s.worldPath(id)
	var final World
	res, err := revisionfile.Mutate(ctx, path, revisionfile.Options{FileMode: 0o644, DirectoryMode: 0o755}, func(snap revisionfile.Snapshot) ([]byte, error) {
		if !snap.Exists {
			return nil, ErrNotFound
		}
		if snap.Revision != expected {
			return nil, &revisionfile.ConflictError{Path: path, Expected: expected, Actual: snap.Revision}
		}
		var current World
		if err := json.Unmarshal(snap.Content, &current); err != nil {
			return nil, fmt.Errorf("世界文件已损坏，拒绝覆盖：%w", err)
		}
		if err := validateStoredWorld(&current, id); err != nil {
			return nil, fmt.Errorf("世界文件已损坏，拒绝覆盖：%w", err)
		}
		incoming.CreatedAt = current.CreatedAt // 创建时间以磁盘为准
		if incoming.CreatedAt == "" {
			incoming.CreatedAt = nowStamp()
		}
		incoming.UpdatedAt = nowStamp()
		final = incoming
		return marshalWorld(&incoming)
	})
	if err != nil {
		return World{}, "", err
	}
	return final, res.Revision, nil
}

// Archive 归档或恢复（撤销），同样走 CAS。
func (s *Store) Archive(ctx context.Context, id, expected string, archived bool) (World, string, error) {
	if !ValidWorldID(id) {
		return World{}, "", ErrInvalidID
	}
	if strings.TrimSpace(expected) == "" {
		return World{}, "", fieldError("expected_revision", "不能为空")
	}
	if err := os.MkdirAll(s.dir(), 0o755); err != nil {
		return World{}, "", err
	}
	path := s.worldPath(id)
	var final World
	res, err := revisionfile.Mutate(ctx, path, revisionfile.Options{FileMode: 0o644, DirectoryMode: 0o755}, func(snap revisionfile.Snapshot) ([]byte, error) {
		if !snap.Exists {
			return nil, ErrNotFound
		}
		if snap.Revision != expected {
			return nil, &revisionfile.ConflictError{Path: path, Expected: expected, Actual: snap.Revision}
		}
		var w World
		if err := json.Unmarshal(snap.Content, &w); err != nil {
			return nil, fmt.Errorf("世界文件已损坏，拒绝修改：%w", err)
		}
		if err := validateStoredWorld(&w, id); err != nil {
			return nil, fmt.Errorf("世界文件已损坏，拒绝修改：%w", err)
		}
		if archived {
			w.Status = StatusArchived
		} else {
			w.Status = StatusActive
		}
		w.UpdatedAt = nowStamp()
		normalizeWorld(&w)
		final = w
		return marshalWorld(&w)
	})
	if err != nil {
		return World{}, "", err
	}
	return final, res.Revision, nil
}
