package app

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"

	"denova/internal/book"
	"denova/internal/library"
	"denova/internal/librarycontext"
)

// PreviewWorkLibraryContext reads saved data only: no registry, model, or writes.
func (a *App) PreviewWorkLibraryContext(ctx context.Context, id string, req librarycontext.Request) (librarycontext.Preview, error) {
	l, revision, err := a.GetWorkLibrary(ctx, id)
	if err != nil {
		return librarycontext.Preview{}, err
	}
	return librarycontext.Build(ctx, l, revision, req, a.libraryMasterResolver())
}

// libraryMasterResolver 返回当前工作区的受控 Master 解析器。捕获一次 workspace：
// 并发切书不能把两个 Master 根混进同一次读取。预览与运行授权共用此解析边界。
func (a *App) libraryMasterResolver() librarycontext.Resolver {
	// Capture once: a concurrent book switch cannot mix Master roots within a preview.
	a.mu.RLock()
	workspace := a.workspace
	a.mu.RUnlock()
	return func(ctx context.Context, ref library.SourceRef) (librarycontext.ResolvedSource, error) {
		if err := ctx.Err(); err != nil {
			return librarycontext.ResolvedSource{}, err
		}
		if strings.TrimSpace(workspace) == "" {
			return librarycontext.ResolvedSource{}, librarycontext.ErrSourceUnavailable
		}
		detail, err := book.NewMasterLibraryStore(workspace).GetAsset(ref.ID)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return librarycontext.ResolvedSource{}, librarycontext.ErrSourceMissing
			}
			return librarycontext.ResolvedSource{}, librarycontext.ErrSourceUnavailable
		}
		if detail.Summary.Availability != book.MasterAvailabilityUsable {
			return librarycontext.ResolvedSource{}, librarycontext.ErrSourceUnavailable
		}
		return projectLibraryMasterSource(detail), nil
	}
}

// Reuse the existing factual-field allowlist. Original, system prompts, runtime
// semantics, translation logs and local paths never cross this projection.
func projectLibraryMasterSource(detail book.MasterAssetDetail) librarycontext.ResolvedSource {
	result := librarycontext.ResolvedSource{Revision: detail.Summary.MasterRevision, Fields: map[string]string{}}
	keys := []string{}
	for key, field := range detail.Item.Fields {
		if !fieldPathAllowed(detail.Summary.RecordKind, key) {
			continue
		}
		text := strings.TrimSpace(field.ActiveText)
		if text == "" {
			text = strings.TrimSpace(field.SourceText)
		}
		if text == "" {
			continue
		}
		result.Fields[key] = text
		keys = append(keys, key)
	}
	slices.Sort(keys)
	var body strings.Builder
	for _, key := range keys {
		if body.Len() > 0 {
			body.WriteString("\n\n")
		}
		body.WriteString(key)
		body.WriteString(":\n")
		body.WriteString(result.Fields[key])
	}
	result.Content = body.String()
	return result
}
