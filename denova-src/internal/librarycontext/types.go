// Package librarycontext derives bounded read-only views of a saved library.
// It owns neither storage nor a model client. Runtime authorization is supplied
// by a trusted caller; HTTP and mode adapters must not accept model-authored grants.
package librarycontext

import (
	"context"
	"denova/internal/library"
	"errors"
)

const (
	MaxPreviewBytes    = 256 * 1024
	MaxEstimatedTokens = 16000
	MaxLoadedItems     = 64
	MaxCatalogLimit    = 100
)

var (
	ErrSelectionInvalid  = errors.New("selection_invalid")
	ErrRevisionConflict  = errors.New("revision_conflict")
	ErrBudgetExceeded    = errors.New("budget_exceeded")
	ErrSourceMissing     = errors.New("source_missing")
	ErrSourceUnavailable = errors.New("source_unavailable")
)

// Request is internal, not an HTTP DTO. Manual IDs represent explicit user intent.
type Request struct {
	ExpectedRevision string
	ManualItemIDs    []string
	AutoItemIDs      []string
	CatalogOffset    int
	CatalogLimit     int
}

// Resolver must read only a registered source; locator is never a path permission.
type Resolver func(context.Context, library.SourceRef) (ResolvedSource, error)
type ResolvedSource struct {
	Revision string
	Content  string
	Fields   map[string]string
}

type CatalogItem struct {
	ItemID           string   `json:"itemId"`
	Name             string   `json:"name"`
	Type             string   `json:"type"`
	BriefDescription string   `json:"briefDescription,omitempty"`
	Tags             []string `json:"tags"`
	Keywords         []string `json:"keywords"`
}
type Catalog struct {
	Items      []CatalogItem `json:"items"`
	Total      int           `json:"total"`
	Offset     int           `json:"offset"`
	NextOffset *int          `json:"nextOffset,omitempty"`
}
type LoadedItem struct {
	ItemID         string               `json:"itemId"`
	Name           string               `json:"name"`
	Type           string               `json:"type"`
	LoadMode       string               `json:"loadMode"`
	Origin         string               `json:"origin"`
	Content        string               `json:"content"`
	Fields         map[string]string    `json:"fields"`
	Event          *library.EventDetail `json:"event,omitempty"`
	SourceRevision string               `json:"sourceRevision,omitempty"`
}
type Issue struct {
	ItemID string `json:"itemId"`
	Code   string `json:"code"`
}
type Budget struct {
	Bytes              int `json:"bytes"`
	EstimatedTokens    int `json:"estimatedTokens"`
	MaxBytes           int `json:"maxBytes"`
	MaxEstimatedTokens int `json:"maxEstimatedTokens"`
}

// Preview is transient. Transport adapters must explicitly map their wire DTO.
type Preview struct {
	LibraryID     string             `json:"libraryId"`
	Revision      string             `json:"revision"`
	Name          string             `json:"name"`
	Summary       string             `json:"summary"`
	Tone          string             `json:"tone"`
	StartingPoint string             `json:"startingPoint"`
	Catalog       Catalog            `json:"catalog"`
	Loaded        []LoadedItem       `json:"loaded"`
	Relations     []library.Relation `json:"relations"`
	Issues        []Issue            `json:"issues"`
	Budget        Budget             `json:"budget"`
}
