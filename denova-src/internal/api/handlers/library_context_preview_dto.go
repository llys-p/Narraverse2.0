package handlers

import "denova/internal/librarycontext"

// Explicit output types keep internal source/storage/runtime fields off the wire.
type libraryCatalogItemDTO struct {
	ItemID           string   `json:"itemId"`
	Name             string   `json:"name"`
	Type             string   `json:"type"`
	BriefDescription string   `json:"briefDescription,omitempty"`
	Tags             []string `json:"tags"`
	Keywords         []string `json:"keywords"`
}
type libraryCatalogDTO struct {
	Items      []libraryCatalogItemDTO `json:"items"`
	Total      int                     `json:"total"`
	Offset     int                     `json:"offset"`
	NextOffset *int                    `json:"nextOffset,omitempty"`
}
type libraryPreviewEventDTO struct {
	Order              int      `json:"order"`
	Era                string   `json:"era"`
	Category           string   `json:"category"`
	ParticipantItemIDs []string `json:"participantItemIds,omitempty"`
	LocationItemID     string   `json:"locationItemId,omitempty"`
}
type libraryLoadedItemDTO struct {
	ItemID         string                  `json:"itemId"`
	Name           string                  `json:"name"`
	Type           string                  `json:"type"`
	LoadMode       string                  `json:"loadMode"`
	Origin         string                  `json:"origin"`
	Content        string                  `json:"content"`
	Fields         map[string]string       `json:"fields"`
	Event          *libraryPreviewEventDTO `json:"event,omitempty"`
	SourceRevision string                  `json:"sourceRevision,omitempty"`
}
type libraryPreviewRelationDTO struct {
	ID         string `json:"id"`
	FromItemID string `json:"fromItemId"`
	ToItemID   string `json:"toItemId"`
	Kind       string `json:"kind"`
	Label      string `json:"label,omitempty"`
	Note       string `json:"note,omitempty"`
	Since      string `json:"since,omitempty"`
	Until      string `json:"until,omitempty"`
	CreatedAt  string `json:"createdAt"`
	UpdatedAt  string `json:"updatedAt"`
}
type libraryPreviewIssueDTO struct {
	ItemID string `json:"itemId"`
	Code   string `json:"code"`
}
type libraryPreviewBudgetDTO struct {
	Bytes              int `json:"bytes"`
	EstimatedTokens    int `json:"estimatedTokens"`
	MaxBytes           int `json:"maxBytes"`
	MaxEstimatedTokens int `json:"maxEstimatedTokens"`
}
type libraryPreviewDTO struct {
	LibraryID     string                      `json:"libraryId"`
	Revision      string                      `json:"revision"`
	Name          string                      `json:"name"`
	Summary       string                      `json:"summary"`
	Tone          string                      `json:"tone"`
	StartingPoint string                      `json:"startingPoint"`
	Catalog       libraryCatalogDTO           `json:"catalog"`
	Loaded        []libraryLoadedItemDTO      `json:"loaded"`
	Relations     []libraryPreviewRelationDTO `json:"relations"`
	Issues        []libraryPreviewIssueDTO    `json:"issues"`
	Budget        libraryPreviewBudgetDTO     `json:"budget"`
}

func libraryPreviewToDTO(p librarycontext.Preview) libraryPreviewDTO {
	out := libraryPreviewDTO{
		LibraryID: p.LibraryID, Revision: p.Revision, Name: p.Name, Summary: p.Summary, Tone: p.Tone, StartingPoint: p.StartingPoint,
		Catalog: libraryCatalogDTO{Items: []libraryCatalogItemDTO{}, Total: p.Catalog.Total, Offset: p.Catalog.Offset, NextOffset: p.Catalog.NextOffset},
		Loaded:  []libraryLoadedItemDTO{}, Relations: []libraryPreviewRelationDTO{}, Issues: []libraryPreviewIssueDTO{},
		Budget: libraryPreviewBudgetDTO{p.Budget.Bytes, p.Budget.EstimatedTokens, p.Budget.MaxBytes, p.Budget.MaxEstimatedTokens},
	}
	for _, item := range p.Catalog.Items {
		out.Catalog.Items = append(out.Catalog.Items, libraryCatalogItemDTO{item.ItemID, item.Name, item.Type, item.BriefDescription, append([]string{}, item.Tags...), append([]string{}, item.Keywords...)})
	}
	for _, item := range p.Loaded {
		body := libraryLoadedItemDTO{ItemID: item.ItemID, Name: item.Name, Type: item.Type, LoadMode: item.LoadMode, Origin: item.Origin, Content: item.Content, Fields: item.Fields, SourceRevision: item.SourceRevision}
		if item.Event != nil {
			e := item.Event
			body.Event = &libraryPreviewEventDTO{e.Order, e.Era, e.Category, append([]string{}, e.ParticipantItemIDs...), e.LocationItemID}
		}
		out.Loaded = append(out.Loaded, body)
	}
	for _, r := range p.Relations {
		out.Relations = append(out.Relations, libraryPreviewRelationDTO{r.ID, r.FromItemID, r.ToItemID, r.Kind, r.Label, r.Note, r.Since, r.Until, r.CreatedAt, r.UpdatedAt})
	}
	for _, issue := range p.Issues {
		out.Issues = append(out.Issues, libraryPreviewIssueDTO{issue.ItemID, issue.Code})
	}
	return out
}
