package libraryruntime

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strings"

	"denova/internal/library"
	"denova/internal/librarycontext"
)

// ModelView 是初始装配的模型可见投影：库概览 + 常驻/已授权 manual 正文 + 有界 auto 目录。
// 刻意不含 L2 Preview 的 Budget 计数器（避免估算自引用，保持同输入同字节）。
type ModelView struct {
	SchemaVersion int                         `json:"schemaVersion"`
	LibraryID     string                      `json:"libraryId"`
	Revision      string                      `json:"revision"`
	Name          string                      `json:"name"`
	Summary       string                      `json:"summary,omitempty"`
	Tone          string                      `json:"tone,omitempty"`
	StartingPoint string                      `json:"startingPoint,omitempty"`
	Catalog       librarycontext.Catalog      `json:"catalog"` // auto 目录：可按需读取的条目清单
	Loaded        []librarycontext.LoadedItem `json:"loaded"`
	Relations     []library.Relation          `json:"relations"`
	Issues        []librarycontext.Issue      `json:"issues"` // 来源失败逐项可见，不静默吞掉
}

// ItemView 是一次按需读取的模型可见投影。
type ItemView struct {
	ItemID   string            `json:"itemId"`
	Name     string            `json:"name"`
	Type     string            `json:"type"`
	LoadMode string            `json:"loadMode"`
	Origin   string            `json:"origin"`
	Content  string            `json:"content"`
	Fields   map[string]string `json:"fields"`
	// SourceRevision 标记 reference 条目实际读到的来源版本（为空表示本地正文）。
	SourceRevision string `json:"sourceRevision,omitempty"`
}

// ReadResult 是一次按需读取的结果：ModelText 即可进入当次模型输入的完整文本（逐字节确定）。
type ReadResult struct {
	ItemID          string
	Name            string
	ModelText       string
	Bytes           int
	EstimatedTokens int
}

// AssembleInitial 装配本次运行的初始模型输入并计入预算：复用 L2 librarycontext.Build
// 的加载/闭包/来源解析/定点估算口径（auto 档只进目录不进正文），包上冻结只读抬头后
// 以临时输入返回。重复调用会再次装配并再次计费（同项重复读取照计）。
// 库 revision 已变化时返回 stale，既不交付旧授权下的新正文，也不静默换版本。
func (r *Run) AssembleInitial(ctx context.Context) (EphemeralLibraryContext, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.requireActiveLocked(); err != nil {
		return EphemeralLibraryContext{}, err
	}
	l, err := r.loadPinnedLocked(ctx)
	if err != nil {
		return EphemeralLibraryContext{}, err
	}
	req := librarycontext.Request{
		ExpectedRevision: r.revision,
		ManualItemIDs:    slices.Sorted(maps.Keys(r.manual)),
		CatalogLimit:     r.cfg.InitialCatalogLimit,
	}
	preview, err := librarycontext.Build(ctx, l, r.revision, req, r.resolver)
	if err != nil {
		return EphemeralLibraryContext{}, r.mapBuildErrorLocked(err)
	}
	view := ModelView{
		SchemaVersion: 1,
		LibraryID:     preview.LibraryID,
		Revision:      preview.Revision,
		Name:          preview.Name,
		Summary:       preview.Summary,
		Tone:          preview.Tone,
		StartingPoint: preview.StartingPoint,
		Catalog:       preview.Catalog,
		Loaded:        preview.Loaded,
		Relations:     preview.Relations,
		Issues:        preview.Issues,
	}
	data, err := json.Marshal(view)
	if err != nil {
		r.lastErrCode = ErrUnavailable
		return EphemeralLibraryContext{}, fail(ErrUnavailable, "cannot serialize the initial library view")
	}
	bytes, tokens := measureText(string(data))
	if err := r.chargeLocked(bytes, tokens); err != nil {
		return EphemeralLibraryContext{}, err
	}
	return NewEphemeralLibraryContext(data), nil
}

// mapBuildErrorLocked 把 L2 Build 的错误映射为本包稳定码（绑定后数据不应再变形，
// 但仍按显式语义处理，绝不吞错降级）。
func (r *Run) mapBuildErrorLocked(err error) error {
	switch {
	case errors.Is(err, librarycontext.ErrBudgetExceeded):
		r.lastErrCode = ErrBudgetExceeded
		return fail(ErrBudgetExceeded, "initial assembly exceeds the library preview bounds")
	case errors.Is(err, librarycontext.ErrRevisionConflict):
		r.lastErrCode = ErrStale
		return fail(ErrStale, "library revision changed during the run")
	case errors.Is(err, librarycontext.ErrSelectionInvalid):
		r.lastErrCode = ErrSelectionInvalid
		return fail(ErrSelectionInvalid, "bound selection no longer validates")
	default:
		// ctx 取消原样透传给调用方，其余按运行期不可用显式上报。
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		r.lastErrCode = ErrUnavailable
		return fail(ErrUnavailable, "initial assembly failed")
	}
}

// ReadOnDemand 执行一次受控按需读取。获准范围只有两类（§8.3）：
// 目录内启用的 auto 条目，或本次运行显式授权 manual 集合内的条目；resident 已整体
// 进入初始装配，禁用/跨库/未知/resident/未授权 manual 一律 denied；revision 漂移返回
// stale；reference 条目必须经受控 Resolver 读到与固定版本一致的来源正文，Locator 永远
// 不是许可。读取结果按同口径计入累计预算（重复读取照计）。
func (r *Run) ReadOnDemand(ctx context.Context, itemID string) (ReadResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.requireActiveLocked(); err != nil {
		return ReadResult{}, err
	}
	itemID = trim(itemID)
	if itemID == "" {
		r.lastErrCode = ErrDenied
		return ReadResult{}, fail(ErrDenied, "item id is required")
	}
	l, err := r.loadPinnedLocked(ctx)
	if err != nil {
		return ReadResult{}, err
	}
	var item library.Item
	found := false
	for i := range l.Items {
		if l.Items[i].ID == itemID {
			item = l.Items[i]
			found = true
			break
		}
	}
	if !found || !item.Enabled {
		r.lastErrCode = ErrDenied
		return ReadResult{}, fail(ErrDenied, "item is unknown or disabled: "+itemID)
	}
	_, manualAllowed := r.manual[itemID]
	switch {
	case item.LoadMode == library.LoadModeAuto:
	case item.LoadMode == library.LoadModeManual && manualAllowed:
	default:
		// resident 已在初始装配；未授权 manual/其他档位不因按需读取而扩大授权。
		r.lastErrCode = ErrDenied
		return ReadResult{}, fail(ErrDenied, "item is not readable on demand under this grant: "+itemID)
	}
	view, err := r.itemViewLocked(ctx, item)
	if err != nil {
		return ReadResult{}, err
	}
	data, err := json.Marshal(view)
	if err != nil {
		r.lastErrCode = ErrUnavailable
		return ReadResult{}, fail(ErrUnavailable, "cannot serialize the item view")
	}
	bytes, tokens := measureText(string(data))
	if err := r.chargeLocked(bytes, tokens); err != nil {
		return ReadResult{}, err
	}
	return ReadResult{
		ItemID:          item.ID,
		Name:            item.Name,
		ModelText:       string(data),
		Bytes:           bytes,
		EstimatedTokens: tokens,
	}, nil
}

// itemViewLocked 解析一条条目的模型可见正文：本地正文直接投影；reference 条目经受控
// Resolver 核对固定来源版本，失败显式分类（来源缺失/不可用→unavailable，来源版本
// 变化→stale），绝不回落到缓存或猜测文本。
func (r *Run) itemViewLocked(ctx context.Context, item library.Item) (ItemView, error) {
	view := ItemView{
		ItemID:   item.ID,
		Name:     item.Name,
		Type:     item.Type,
		LoadMode: item.LoadMode,
		Origin:   item.Origin,
		Content:  item.Content,
		Fields:   maps.Clone(item.Fields),
	}
	if view.Fields == nil {
		view.Fields = map[string]string{}
	}
	switch item.Origin {
	case library.OriginOriginal, library.OriginAdaptation:
		return view, nil
	case library.OriginReference:
		ref := item.Source
		if ref == nil || trim(ref.ID) == "" || trim(ref.Revision) == "" {
			r.lastErrCode = ErrUnavailable
			return ItemView{}, fail(ErrUnavailable, "reference item has no verified source")
		}
		// Locator 是展示定位，不是路径许可；任何 locator 都不改变受控解析。
		if ref.Kind != "master" || trim(ref.Locator) != "" {
			r.lastErrCode = ErrUnavailable
			return ItemView{}, fail(ErrUnavailable, "reference source kind or locator is not supported")
		}
		if r.resolver == nil {
			r.lastErrCode = ErrUnavailable
			return ItemView{}, fail(ErrUnavailable, "no controlled resolver is bound for reference items")
		}
		resolved, err := r.resolver(ctx, *ref)
		if ctx.Err() != nil {
			return ItemView{}, ctx.Err()
		}
		if err != nil {
			r.lastErrCode = ErrUnavailable
			return ItemView{}, fail(ErrUnavailable, "reference source cannot be resolved")
		}
		if resolved.Revision == "" {
			r.lastErrCode = ErrUnavailable
			return ItemView{}, fail(ErrUnavailable, "reference source revision is unverified")
		}
		if resolved.Revision != ref.Revision {
			r.lastErrCode = ErrStale
			return ItemView{}, fail(ErrStale, "reference source revision changed since binding")
		}
		view.Content = resolved.Content
		view.Fields = maps.Clone(resolved.Fields)
		if view.Fields == nil {
			view.Fields = map[string]string{}
		}
		view.SourceRevision = resolved.Revision
		return view, nil
	default:
		r.lastErrCode = ErrUnavailable
		return ItemView{}, fail(ErrUnavailable, "unknown item origin")
	}
}

// measureText 与 librarycontext.measure 使用同一 token 估算口径
// （ASCII 每 3 字符≈1 token，非 ASCII 每 rune≈2 token），保证预算口径一致。
func measureText(text string) (bytes int, tokens int) {
	ascii, nonASCII := 0, 0
	for _, r := range text {
		if r < 128 {
			ascii++
		} else {
			nonASCII++
		}
	}
	return len(text), (ascii+2)/3 + nonASCII*2
}

func trim(s string) string { return strings.TrimSpace(s) }
