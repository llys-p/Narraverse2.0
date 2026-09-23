package librarycontext

import (
	"context"
	"denova/internal/library"
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strings"
)

// Build resolves only authorized bodies and never modifies the input or source.
// Source failures are visible issues, not permission to fall back to cached text.
func Build(ctx context.Context, l library.Library, revision string, req Request, resolve Resolver) (Preview, error) {
	if req.ExpectedRevision == "" || req.ExpectedRevision != revision {
		return Preview{}, ErrRevisionConflict
	}
	limit := req.CatalogLimit
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > MaxCatalogLimit || req.CatalogOffset < 0 || len(req.AutoItemIDs) > MaxLoadedItems || len(req.ManualItemIDs) > MaxLoadedItems {
		return Preview{}, ErrSelectionInvalid
	}
	items := make(map[string]library.Item, len(l.Items))
	selected := map[string]bool{}
	auto := []string{}
	for _, item := range l.Items {
		items[item.ID] = item
		if !item.Enabled {
			continue
		}
		switch item.LoadMode {
		case "resident":
			selected[item.ID] = true
		case "auto":
			auto = append(auto, item.ID)
		case "manual":
		default:
			return Preview{}, ErrSelectionInvalid
		}
	}
	for _, group := range []struct {
		ids  []string
		mode string
	}{{req.AutoItemIDs, "auto"}, {req.ManualItemIDs, "manual"}} {
		for _, id := range group.ids {
			item, ok := items[id]
			if !ok || !item.Enabled || item.LoadMode != group.mode {
				return Preview{}, ErrSelectionInvalid
			}
			selected[id] = true
		}
	}
	if len(selected) > MaxLoadedItems {
		return Preview{}, ErrBudgetExceeded
	}
	slices.Sort(auto)
	if req.CatalogOffset > len(auto) {
		return Preview{}, ErrSelectionInvalid
	}
	p := Preview{LibraryID: l.ID, Revision: revision, Name: l.Name, Summary: l.Summary, Tone: l.Tone, StartingPoint: l.StartingPoint,
		Catalog: Catalog{Items: []CatalogItem{}, Total: len(auto), Offset: req.CatalogOffset}, Loaded: []LoadedItem{}, Relations: []library.Relation{}, Issues: []Issue{},
		Budget: Budget{MaxBytes: MaxPreviewBytes, MaxEstimatedTokens: MaxEstimatedTokens}}
	end := min(req.CatalogOffset+limit, len(auto))
	if end < len(auto) {
		p.Catalog.NextOffset = &end
	}
	for _, id := range auto[req.CatalogOffset:end] {
		item := items[id]
		p.Catalog.Items = append(p.Catalog.Items, CatalogItem{ItemID: id, Name: item.Name, Type: item.Type, BriefDescription: item.BriefDescription,
			Tags: append([]string{}, item.Tags...), Keywords: append([]string{}, item.Keywords...)})
	}
	ids := slices.Sorted(maps.Keys(selected))
	loaded := map[string]bool{}
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return Preview{}, err
		}
		item := items[id]
		body := LoadedItem{ItemID: id, Name: item.Name, Type: item.Type, LoadMode: item.LoadMode, Origin: item.Origin, Content: item.Content, Fields: maps.Clone(item.Fields)}
		switch item.Origin {
		case "original", "adaptation":
		case "reference":
			source, code, err := resolveReference(ctx, item.Source, resolve)
			if err != nil {
				return Preview{}, err
			}
			if code != "" {
				p.Issues = append(p.Issues, Issue{ItemID: id, Code: code})
				continue
			}
			body.Content = source.Content
			body.Fields = maps.Clone(source.Fields)
			body.SourceRevision = source.Revision
		default:
			return Preview{}, ErrSelectionInvalid
		}
		if body.Fields == nil {
			body.Fields = map[string]string{}
		}
		if item.Event != nil {
			event := *item.Event
			event.ParticipantItemIDs = append([]string{}, item.Event.ParticipantItemIDs...)
			body.Event = &event
		}
		p.Loaded = append(p.Loaded, body)
		loaded[id] = true
	}
	for i := range p.Loaded {
		event := p.Loaded[i].Event
		if event == nil {
			continue
		}
		participants := []string{}
		for _, id := range event.ParticipantItemIDs {
			if loaded[id] {
				participants = append(participants, id)
			}
		}
		event.ParticipantItemIDs = participants
		if !loaded[event.LocationItemID] {
			event.LocationItemID = ""
		}
	}
	for _, relation := range l.Relations {
		if loaded[relation.FromItemID] && loaded[relation.ToItemID] {
			p.Relations = append(p.Relations, relation)
		}
	}
	slices.SortFunc(p.Relations, func(a, b library.Relation) int { return strings.Compare(a.ID, b.ID) })
	if err := measure(&p); err != nil {
		return Preview{}, err
	}
	return p, nil
}

func resolveReference(ctx context.Context, ref *library.SourceRef, resolve Resolver) (ResolvedSource, string, error) {
	if ref == nil || strings.TrimSpace(ref.ID) == "" || strings.TrimSpace(ref.Revision) == "" {
		return ResolvedSource{}, "source_unverified", nil
	}
	if ref.Kind != "master" || ref.Locator != "" {
		return ResolvedSource{}, "source_unsupported", nil
	}
	if resolve == nil {
		return ResolvedSource{}, "source_unavailable", nil
	}
	result, err := resolve(ctx, *ref)
	if ctx.Err() != nil {
		return ResolvedSource{}, "", ctx.Err()
	}
	if err != nil {
		if errors.Is(err, ErrSourceMissing) {
			return ResolvedSource{}, "source_missing", nil
		}
		return ResolvedSource{}, "source_unavailable", nil
	}
	if result.Revision == "" {
		return ResolvedSource{}, "source_unverified", nil
	}
	if result.Revision != ref.Revision {
		return ResolvedSource{}, "source_changed", nil
	}
	return result, "", nil
}

// Budget includes metadata, fields and the budget counters themselves. This is a
// deterministic preview estimate, not a claim about any model's tokenizer.
func measure(p *Preview) error {
	for range 8 {
		data, err := json.Marshal(p)
		if err != nil {
			return err
		}
		ascii, nonASCII := 0, 0
		for _, r := range string(data) {
			if r < 128 {
				ascii++
			} else {
				nonASCII++
			}
		}
		tokens := (ascii+2)/3 + nonASCII*2
		if len(data) > MaxPreviewBytes || tokens > MaxEstimatedTokens {
			return ErrBudgetExceeded
		}
		if p.Budget.Bytes == len(data) && p.Budget.EstimatedTokens == tokens {
			return nil
		}
		p.Budget.Bytes = len(data)
		p.Budget.EstimatedTokens = tokens
	}
	return ErrBudgetExceeded
}
