package bookideation

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"denova/internal/revisionfile"
)

const (
	draftsDirName    = "book-ideation"
	draftsSubDirName = "drafts"
	// maxDraftBytes bounds one stored document so a draft cannot grow without
	// limit; content limits above already bound the fields themselves.
	maxDraftBytes = 8 << 20
)

var draftIDPattern = regexp.MustCompile(`^[0-9a-f]{16,64}$`)

// DraftSummary is the list row used to recover a draft after a refresh.
type DraftSummary struct {
	ID            string `json:"id"`
	Status        string `json:"status"`
	Title         string `json:"title,omitempty"`
	Idea          string `json:"idea,omitempty"`
	SourceCount   int    `json:"source_count"`
	TurnCount     int    `json:"turn_count"`
	HasCandidates bool   `json:"has_candidates"`
	CommitStage   string `json:"commit_stage,omitempty"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
}

// Store persists ideation drafts below the Denova data directory. Drafts live
// outside any book workspace, so an unconfirmed draft cannot show up as a book
// or change a book's settings.
type Store struct {
	root string
}

// NewStore returns a draft store rooted at <dataDir>/book-ideation/drafts.
func NewStore(dataDir string) (*Store, error) {
	if strings.TrimSpace(dataDir) == "" {
		return nil, errors.New("构思草稿需要数据目录")
	}
	root := filepath.Join(dataDir, draftsDirName, draftsSubDirName)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("创建构思草稿目录失败: %w", err)
	}
	return &Store{root: root}, nil
}

// NewDraftID returns an unguessable, path-safe draft identifier.
func NewDraftID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("生成草稿 ID 失败: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

func (s *Store) path(id string) string {
	return filepath.Join(s.root, id+".json")
}

// Create writes a new draft. It never overwrites an existing document, so a
// repeated create cannot clobber an in-progress ideation.
func (s *Store) Create(ctx context.Context, draft Draft) (Record, error) {
	if !draftIDPattern.MatchString(draft.ID) {
		return Record{}, fmt.Errorf("草稿 ID 无效")
	}
	if draft.Status == "" {
		draft.Status = StatusIdeating
	}
	if draft.CreatedAt == "" {
		draft.CreatedAt = nowUTC()
	}
	draft.UpdatedAt = draft.CreatedAt
	content, err := s.encode(draft)
	if err != nil {
		return Record{}, err
	}
	result, err := revisionfile.ReplaceIfRevision(ctx, s.path(draft.ID), revisionfile.MissingRevision, content, revisionfile.Options{})
	if isMissingRevisionConflict(err) {
		return Record{}, fmt.Errorf("草稿已存在: %s", draft.ID)
	}
	if err != nil {
		return Record{}, fmt.Errorf("写入构思草稿失败: %w", err)
	}
	return Record{Draft: draft, Revision: result.Revision}, nil
}

// Read returns one draft plus the revision of its stored bytes.
func (s *Store) Read(ctx context.Context, id string) (Record, error) {
	if !draftIDPattern.MatchString(id) {
		return Record{}, fmt.Errorf("草稿 ID 无效")
	}
	snapshot, err := revisionfile.Read(ctx, s.path(id))
	if err != nil {
		return Record{}, fmt.Errorf("读取构思草稿失败: %w", err)
	}
	if !snapshot.Exists {
		return Record{}, ErrNotFound
	}
	draft, err := decodeDraft(snapshot.Content)
	if err != nil {
		return Record{}, err
	}
	return Record{Draft: draft, Revision: snapshot.Revision}, nil
}

// Update applies a compare-and-swap mutation under the path lock. A caller that
// read a stale revision gets *ConflictError and must re-read before writing,
// which is what keeps a late model reply from overwriting newer user edits.
func (s *Store) Update(ctx context.Context, id, baseRevision string, mutate func(*Draft) error) (Record, error) {
	if !draftIDPattern.MatchString(id) {
		return Record{}, fmt.Errorf("草稿 ID 无效")
	}
	if mutate == nil {
		return Record{}, errors.New("草稿更新回调不能为空")
	}
	var out Record
	var conflict *ConflictError
	result, err := revisionfile.Mutate(ctx, s.path(id), revisionfile.Options{}, func(current revisionfile.Snapshot) ([]byte, error) {
		if !current.Exists {
			return nil, ErrNotFound
		}
		if baseRevision != "" && current.Revision != baseRevision {
			conflict = &ConflictError{DraftID: id, BaseRevision: baseRevision, Actual: current.Revision}
			return nil, conflict
		}
		draft, err := decodeDraft(current.Content)
		if err != nil {
			return nil, err
		}
		if err := mutate(&draft); err != nil {
			return nil, err
		}
		draft.UpdatedAt = nowUTC()
		content, err := s.encode(draft)
		if err != nil {
			return nil, err
		}
		out.Draft = draft
		return content, nil
	})
	if err != nil {
		if conflict != nil {
			return Record{}, conflict
		}
		if errors.Is(err, ErrNotFound) {
			return Record{}, ErrNotFound
		}
		return Record{}, fmt.Errorf("更新构思草稿失败: %w", err)
	}
	out.Revision = result.Revision
	return out, nil
}

// List returns every draft newest-first, skipping unreadable files instead of
// failing the whole listing.
func (s *Store) List(ctx context.Context) ([]DraftSummary, error) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		if os.IsNotExist(err) {
			return []DraftSummary{}, nil
		}
		return nil, fmt.Errorf("读取构思草稿目录失败: %w", err)
	}
	summaries := make([]DraftSummary, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		if !draftIDPattern.MatchString(id) {
			continue
		}
		record, err := s.Read(ctx, id)
		if err != nil {
			continue
		}
		summaries = append(summaries, summarize(record.Draft))
	}
	sort.SliceStable(summaries, func(i, j int) bool {
		if summaries[i].UpdatedAt == summaries[j].UpdatedAt {
			return summaries[i].ID > summaries[j].ID
		}
		return summaries[i].UpdatedAt > summaries[j].UpdatedAt
	})
	return summaries, nil
}

func summarize(draft Draft) DraftSummary {
	summary := DraftSummary{
		ID:            draft.ID,
		Status:        draft.Status,
		Title:         draft.Title,
		Idea:          draft.Idea,
		SourceCount:   len(draft.Sources),
		TurnCount:     len(draft.Turns),
		HasCandidates: draft.Candidates != nil,
		CreatedAt:     draft.CreatedAt,
		UpdatedAt:     draft.UpdatedAt,
	}
	if draft.Commit != nil {
		summary.CommitStage = draft.Commit.PendingStage()
	}
	return summary
}

func (s *Store) encode(draft Draft) ([]byte, error) {
	content, err := json.MarshalIndent(draft, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("序列化构思草稿失败: %w", err)
	}
	if len(content) > maxDraftBytes {
		return nil, fmt.Errorf("构思草稿超过 %d MiB 上限，请减少素材或删减条目", maxDraftBytes>>20)
	}
	return content, nil
}

func decodeDraft(content []byte) (Draft, error) {
	var draft Draft
	if err := json.Unmarshal(content, &draft); err != nil {
		return Draft{}, fmt.Errorf("构思草稿已损坏: %w", err)
	}
	if draft.ID == "" {
		return Draft{}, errors.New("构思草稿缺少 ID")
	}
	if draft.Sources == nil {
		draft.Sources = []Source{}
	}
	if draft.Turns == nil {
		draft.Turns = []Turn{}
	}
	return draft, nil
}

func isMissingRevisionConflict(err error) bool {
	var conflict *revisionfile.ConflictError
	return errors.As(err, &conflict) && conflict.Expected == revisionfile.MissingRevision
}

// countRunes is the shared bound helper for user-supplied text fields.
func countRunes(value string) int {
	return utf8.RuneCountInString(value)
}

// truncateRunes keeps a bounded head slice of model-visible text and records
// that the slice happened instead of silently dropping the tail.
func truncateRunes(value string, limit int) (string, bool) {
	if limit <= 0 {
		return "", countRunes(value) > 0
	}
	if utf8.RuneCountInString(value) <= limit {
		return value, false
	}
	return string([]rune(value)[:limit]), true
}
