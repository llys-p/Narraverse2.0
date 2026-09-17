package app

import (
	"context"
	"errors"
	"strings"

	"denova/internal/library"
)

// ErrLibraryDataDirMissing 表示尚未配置全局 Denova 数据目录，无法落盘设定库。
var ErrLibraryDataDirMissing = errors.New("尚未配置 Denova 数据目录，无法存储作品设定库")

// libraryStore 在全局 cfg.DataDir()/libraries 下构造设定库存储。
//
// 刻意不使用 workspace：作品设定库必须能在“还没有书”的状态下创建与编辑，
// 这是 L1 的核心产品要求（见 docs/plans/LIBRARY_L1_DATA_CONTRACT.md §2）。
func (a *App) libraryStore() (*library.Store, error) {
	if a == nil || a.cfg == nil || strings.TrimSpace(a.cfg.DataDir()) == "" {
		return nil, ErrLibraryDataDirMissing
	}
	return library.NewStore(a.cfg.DataDir()), nil
}

// ListWorkLibraries 扫描设定库目录，返回摘要与损坏文件告警。
func (a *App) ListWorkLibraries(ctx context.Context) (library.ListResult, error) {
	store, err := a.libraryStore()
	if err != nil {
		return library.ListResult{Libraries: []library.Summary{}, Warnings: []library.LoadWarning{}}, err
	}
	return store.List(ctx)
}

// GetWorkLibrary 读取单个设定库及其内容哈希 revision。
func (a *App) GetWorkLibrary(ctx context.Context, id string) (library.Library, string, error) {
	store, err := a.libraryStore()
	if err != nil {
		return library.Library{}, "", err
	}
	return store.Get(ctx, id)
}

// CreateWorkLibrary 创建一份空的独立设定库。
func (a *App) CreateWorkLibrary(ctx context.Context, in library.CreateInput) (library.Library, string, error) {
	store, err := a.libraryStore()
	if err != nil {
		return library.Library{}, "", err
	}
	return store.Create(ctx, in)
}

// UpdateWorkLibraryMeta 以 expectedRevision 为基更新库元信息（库级 CAS）。
func (a *App) UpdateWorkLibraryMeta(ctx context.Context, id, expectedRevision string, patch library.MetaPatchInput) (library.Library, string, error) {
	store, err := a.libraryStore()
	if err != nil {
		return library.Library{}, "", err
	}
	return store.UpdateMeta(ctx, id, expectedRevision, patch)
}

// DeleteWorkLibrary 删除整份设定库（需要 expectedRevision 防误删）。
func (a *App) DeleteWorkLibrary(ctx context.Context, id, expectedRevision string) error {
	store, err := a.libraryStore()
	if err != nil {
		return err
	}
	return store.Delete(ctx, id, expectedRevision)
}

// WorkLibraryTimeline 返回由事件条目派生的时间线（不落盘，不修改数据）。
func (a *App) WorkLibraryTimeline(ctx context.Context, id string) ([]library.TimelineEntry, error) {
	l, _, err := a.GetWorkLibrary(ctx, id)
	if err != nil {
		return nil, err
	}
	return library.BuildTimeline(l.Items), nil
}

// CreateWorkLibraryItem 在库内新建条目。
func (a *App) CreateWorkLibraryItem(ctx context.Context, id string, in library.ItemInput) (library.Item, string, error) {
	store, err := a.libraryStore()
	if err != nil {
		return library.Item{}, "", err
	}
	return store.CreateItem(ctx, id, in)
}

// UpdateWorkLibraryItem 更新单条条目（条目级 CAS）。
func (a *App) UpdateWorkLibraryItem(ctx context.Context, id string, in library.ItemInput) (library.Item, string, error) {
	store, err := a.libraryStore()
	if err != nil {
		return library.Item{}, "", err
	}
	return store.UpdateItem(ctx, id, in)
}

// DeleteWorkLibraryItem 删除条目；cascade=false 时被引用的条目会被拒绝并带回影响明细。
func (a *App) DeleteWorkLibraryItem(ctx context.Context, id, itemID string, cascade bool) (library.DeleteItemResult, string, error) {
	store, err := a.libraryStore()
	if err != nil {
		return library.DeleteItemResult{}, "", err
	}
	return store.DeleteItem(ctx, id, itemID, cascade)
}

// WorkLibraryItemImpact 预览删除某条目的影响（只读）。
func (a *App) WorkLibraryItemImpact(ctx context.Context, id, itemID string) (library.Impact, error) {
	store, err := a.libraryStore()
	if err != nil {
		return library.Impact{}, err
	}
	return store.Impact(ctx, id, itemID)
}

// CreateWorkLibraryRelation 新建库内关系。
func (a *App) CreateWorkLibraryRelation(ctx context.Context, id string, in library.RelationInput) (library.Relation, string, error) {
	store, err := a.libraryStore()
	if err != nil {
		return library.Relation{}, "", err
	}
	return store.CreateRelation(ctx, id, in)
}

// UpdateWorkLibraryRelation 更新库内关系。
func (a *App) UpdateWorkLibraryRelation(ctx context.Context, id, relationID string, in library.RelationInput) (library.Relation, string, error) {
	store, err := a.libraryStore()
	if err != nil {
		return library.Relation{}, "", err
	}
	return store.UpdateRelation(ctx, id, relationID, in)
}

// DeleteWorkLibraryRelation 删除库内关系。
func (a *App) DeleteWorkLibraryRelation(ctx context.Context, id, relationID string) (string, error) {
	store, err := a.libraryStore()
	if err != nil {
		return "", err
	}
	return store.DeleteRelation(ctx, id, relationID)
}

// WorkLibraryVocabulary 返回设定库的词表（类型/档位/重要度/来源类型/关系类型/事件类别/用途/来源形态）。
//
// 由服务端统一下发，避免前端各自硬编码一份，出现“UI 能选但保存被拒”的静默缺口。
func (a *App) WorkLibraryVocabulary() map[string][]string {
	return map[string][]string{
		"itemTypes":        library.AllItemTypes(),
		"baseItemTypes":    library.BaseItemTypes(),
		"loadModes":        library.AllLoadModes(),
		"importanceLevels": library.AllImportanceLevels(),
		"origins":          library.AllOrigins(),
		"sourceKinds":      library.AllSourceKinds(),
		"relationKinds":    library.AllRelationKinds(),
		"eventCategories":  library.AllEventCategories(),
		"purposes":         library.AllPurposes(),
	}
}
