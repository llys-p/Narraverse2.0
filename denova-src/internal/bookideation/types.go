// Package bookideation implements the "ideate a new book" flow: a recoverable
// draft holds the user's chosen source material, the ideation conversation and
// the candidate setting package. Nothing here touches the book shelf or a book
// workspace until the user confirms the draft and the commit stages run.
package bookideation

import (
	"errors"
	"strings"
	"time"
)

// Draft statuses. A draft is never a book, so it cannot appear in the shelf.
const (
	StatusIdeating  = "ideating"
	StatusCommitted = "committed"
	StatusAbandoned = "abandoned"
)

// Candidate origins. The ideation agent may create new content, but every
// candidate has to declare where it came from so source facts stay distinct
// from user decisions and AI proposals.
const (
	OriginSource = "source"
	OriginUser   = "user"
	OriginAI     = "ai"
)

// Generation scopes for a candidate package rewrite.
const (
	ScopeAll      = "all"
	ScopeOverview = "overview"
	ScopeItems    = "items"
	ScopeRelation = "relation"
)

// Commit stage names, recorded in order so a partial failure can resume.
const (
	StageBook      = "book"
	StageOverview  = "overview"
	StageItems     = "items"
	StageRelations = "relations"
)

// Stage status values.
const (
	StagePending = "pending"
	StageDone    = "done"
)

// Persisted limits. Model-visible budgets are applied again at prompt assembly.
const (
	MaxSourcesPerDraft     = 8
	MaxSourceContentRunes  = 200_000
	MaxSourceEntries       = 200
	MaxTurnsPerDraft       = 60
	MaxTurnRunes           = 8_000
	MaxCandidateItems      = 60
	MaxCandidateRelations  = 128
	MaxOverviewRunes       = 20_000
	MaxOpenQuestions       = 20
	MaxTitleRunes          = 120
	MaxDescriptionRunes    = 2_000
	MaxDirectionSummaryRun = 6_000
)

// ErrNotFound is returned when a draft id has no stored file.
var ErrNotFound = errors.New("构思草稿不存在")

// ConflictError reports a stale base revision: someone (the user or a finished
// generation) changed the draft after the caller read it.
type ConflictError struct {
	DraftID      string
	BaseRevision string
	Actual       string
}

func (e *ConflictError) Error() string {
	return "构思草稿已被修改，本次写入未生效"
}

// StaleGenerationError reports a model reply that arrived after the draft moved
// on. Its payload is discarded instead of overwriting newer user edits.
type StaleGenerationError struct {
	DraftID  string
	Expected string
	Actual   string
}

func (e *StaleGenerationError) Error() string {
	return "构思草稿已有更新，本次生成结果未覆盖当前内容"
}

func nowUTC() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

// SourceEntry is one retained piece of the original material. Content is kept
// verbatim; only the segmentation is derived, never rewritten.
type SourceEntry struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Content  string   `json:"content"`
	Keywords []string `json:"keywords,omitempty"`
	// Role marks opening material (card first message, alternate greetings,
	// example dialogue) so it survives as scene material instead of being
	// folded into a character biography.
	Role      string `json:"role,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

// Source is a read-only snapshot of material the user selected. The original
// file is never modified; provenance keeps the source identity distinct from
// the book identity it may later produce.
type Source struct {
	ID          string        `json:"id"`
	Kind        string        `json:"kind"`
	Name        string        `json:"name"`
	FileName    string        `json:"file_name,omitempty"`
	ContentHash string        `json:"content_hash"`
	Entries     []SourceEntry `json:"entries"`
	Warnings    []string      `json:"warnings,omitempty"`
	AddedAt     string        `json:"added_at"`
}

// Turn is one ideation conversation message. Display history and model input
// are assembled from the bounded tail of this list.
type Turn struct {
	Role      string `json:"role"`
	Content   string `json:"content"`
	At        string `json:"at"`
	Generated bool   `json:"generated,omitempty"`
}

// Direction is what the user has agreed so far. It is a summary, not a fact
// source: candidate generation always cites retained source entries.
type Direction struct {
	Summary   string   `json:"summary"`
	Genre     string   `json:"genre,omitempty"`
	Tone      string   `json:"tone,omitempty"`
	Conflict  string   `json:"conflict,omitempty"`
	Cast      []string `json:"cast,omitempty"`
	UpdatedBy string   `json:"updated_by,omitempty"`
	UpdatedAt string   `json:"updated_at,omitempty"`
}

// CandidateItem becomes one lore item after the user confirms creation.
type CandidateItem struct {
	Ref              string   `json:"ref"`
	Name             string   `json:"name"`
	Type             string   `json:"type"`
	BriefDescription string   `json:"brief_description,omitempty"`
	Keywords         []string `json:"keywords,omitempty"`
	Content          string   `json:"content"`
	LoadMode         string   `json:"load_mode"`
	CharacterTier    string   `json:"character_tier,omitempty"`
	Origin           string   `json:"origin"`
	SourceRefs       []string `json:"source_refs,omitempty"`
	// OpenNotes keeps "unknown / contradicts source" visible instead of
	// silently promoting a guess into book fact.
	OpenNotes    string `json:"open_notes,omitempty"`
	Excluded     bool   `json:"excluded,omitempty"`
	EditedByUser bool   `json:"edited_by_user,omitempty"`
}

// CandidateRelation is an explicit link between two candidates. A relation
// only becomes a book relation once the user keeps it through confirmation.
type CandidateRelation struct {
	Ref        string   `json:"ref"`
	SourceRef  string   `json:"source_ref"`
	TargetRef  string   `json:"target_ref"`
	Label      string   `json:"label"`
	Note       string   `json:"note,omitempty"`
	Origin     string   `json:"origin"`
	SourceRefs []string `json:"source_refs,omitempty"`
	Excluded   bool     `json:"excluded,omitempty"`
}

// CandidatePackage is the latest generated draft of the book's setting.
type CandidatePackage struct {
	BookNameSuggestions []string            `json:"book_name_suggestions,omitempty"`
	Title               string              `json:"title,omitempty"`
	Synopsis            string              `json:"synopsis,omitempty"`
	Overview            string              `json:"overview"`
	Items               []CandidateItem     `json:"items"`
	Relations           []CandidateRelation `json:"relations,omitempty"`
	OpenQuestions       []string            `json:"open_questions,omitempty"`
	// KeepSourceEntries lists retained source entry ids whose original text is
	// written into the book as detailed entries on confirm, so a summary never
	// replaces the original setting.
	KeepSourceEntries []string `json:"keep_source_entries,omitempty"`
	GeneratedAt       string   `json:"generated_at"`
	// DirectionRevision records which confirmed direction this package was
	// generated from, so the UI can warn when the direction changed since.
	DirectionRevision int64 `json:"direction_revision"`
	// Revision bumps on every package change; callers use it as the CAS token
	// for scoped regeneration.
	Revision int64 `json:"revision"`
}

// CommitStage is one recoverable step of the confirmed creation.
type CommitStage struct {
	Name       string `json:"name"`
	Status     string `json:"status"`
	Detail     string `json:"detail,omitempty"`
	FinishedAt string `json:"finished_at,omitempty"`
}

// CommitState records the creation attempt bound to this draft. Repeating the
// commit resumes the same target book instead of creating another one.
type CommitState struct {
	RequestID        string            `json:"request_id"`
	Title            string            `json:"title"`
	WorkspacePath    string            `json:"workspace_path,omitempty"`
	Stages           []CommitStage     `json:"stages"`
	ItemIDs          map[string]string `json:"item_ids,omitempty"`
	OverviewRevision string            `json:"overview_revision,omitempty"`
	CreatedAt        string            `json:"created_at"`
	CompletedAt      string            `json:"completed_at,omitempty"`
}

// Draft is the whole ideation document. Revision is carried in the envelope
// returned by the store, not inside the payload, because it addresses the
// exact stored bytes.
type Draft struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	Locale    string `json:"locale,omitempty"`

	Idea        string `json:"idea,omitempty"`
	Title       string `json:"title,omitempty"`
	Author      string `json:"author,omitempty"`
	Description string `json:"description,omitempty"`

	Sources []Source `json:"sources"`
	// NextSourceIndex never rewinds, so a removed source id is not reused while
	// candidates still cite it.
	NextSourceIndex int       `json:"next_source_index"`
	Turns           []Turn    `json:"turns"`
	Direction       Direction `json:"direction"`
	// DirectionRevision lets generation detect a direction that moved past the
	// last generated package.
	DirectionRevision int64             `json:"direction_revision"`
	Candidates        *CandidatePackage `json:"candidates,omitempty"`
	Commit            *CommitState      `json:"commit,omitempty"`
}

// Record pairs a draft with the revision of its stored bytes.
type Record struct {
	Draft    Draft
	Revision string
}

// IsCommitted reports whether the draft already produced its book.
func (d Draft) IsCommitted() bool { return d.Status == StatusCommitted }

// SourceEntryByID finds a retained source entry.
func (d Draft) SourceEntryByID(entryID string) (Source, SourceEntry, bool) {
	for _, source := range d.Sources {
		for _, entry := range source.Entries {
			if entry.ID == entryID {
				return source, entry, true
			}
		}
	}
	return Source{}, SourceEntry{}, false
}

// CandidateItemByRef finds a candidate by its stable ref.
func (p CandidatePackage) CandidateItemByRef(ref string) (CandidateItem, bool) {
	for _, item := range p.Items {
		if item.Ref == strings.TrimSpace(ref) {
			return item, true
		}
	}
	return CandidateItem{}, false
}

// PendingStage returns the first unfinished commit stage.
func (c CommitState) PendingStage() string {
	for _, stage := range c.Stages {
		if stage.Status != StageDone {
			return stage.Name
		}
	}
	return ""
}

// StageStatus reads one stage status, defaulting to pending.
func (c CommitState) StageStatus(name string) string {
	for _, stage := range c.Stages {
		if stage.Name == name {
			return stage.Status
		}
	}
	return StagePending
}
