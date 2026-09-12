package app

import (
	"context"
	"errors"

	"denova/internal/world"
	"denova/internal/worldcontext"
)

// Phase 3.0B P2：App 层只读装配门面（v2.7 / 实施计划 P2）。
//
// 边界（冻结）：
//   - 只通过既有 App.GetWorld 读取已保存 World 与其内容哈希 revision，绝不写 World；
//   - 调用 worldcontext 构建 Snapshot / UIView，并把运行时 runContext 交给进程内 Registry；
//   - 不新增 HTTP route、不改 handler、不改前端、不接 Module3/4、不接 analysisHandle、不调用模型；
//   - Snapshot/ModelView/runContext 只存在于该 service 的内存 Registry；App 重建即清空，不自动恢复。

// WorldContextService 装配 World 只读快照与进程内运行上下文。
type WorldContextService struct {
	app             *App
	registry        *worldcontext.Registry
	analysisHandles *analysisHandleRegistry
	interactiveRuns *interactiveRunRegistry
}

func newWorldContextService(a *App) *WorldContextService {
	registry := worldcontext.NewRegistry()
	return &WorldContextService{
		app:             a,
		registry:        registry,
		analysisHandles: newAnalysisHandleRegistry(registry, analysisHandleConfig{}),
		interactiveRuns: newInteractiveRunRegistry(interactiveRunRegistryConfig{}),
	}
}

// loadSnapshot 经既有 GetWorld 读取 World，并交给领域核心做 revision/状态/选择/预算/消费者校验。
func (s *WorldContextService) loadSnapshot(ctx context.Context, consumer worldcontext.Consumer, ref worldcontext.Ref) (*worldcontext.Snapshot, error) {
	w, currentRevision, err := s.app.GetWorld(ctx, ref.WorldID)
	if err != nil {
		return nil, mapWorldReadError(err)
	}
	return worldcontext.BuildSnapshot(consumer, ref, currentRevision, w)
}

// mapWorldReadError 把 World 存储读取错误映射为稳定领域错误码（不向调用方泄露本机路径）。
func mapWorldReadError(err error) error {
	switch {
	case errors.Is(err, world.ErrNotFound), errors.Is(err, world.ErrInvalidID):
		return &worldcontext.DomainError{Code: worldcontext.ErrWorldNotFound, Field: "worldId", Message: "世界不存在或 id 非法"}
	default:
		return &worldcontext.DomainError{Code: worldcontext.ErrWorldUnavailable, Field: "world", Message: "世界暂时无法读取"}
	}
}

// PreviewWorldContext 只读预览：构建 Snapshot 并投影控制台 UIView；不创建 runContext、不占用 Registry。
func (s *WorldContextService) PreviewWorldContext(ctx context.Context, consumer worldcontext.Consumer, ref worldcontext.Ref) (*worldcontext.UIView, error) {
	snap, err := s.loadSnapshot(ctx, consumer, ref)
	if err != nil {
		return nil, err
	}
	return worldcontext.ProjectForUI(snap), nil
}

// PreviewWorldContext 是供 HTTP handler 调用的 App 外观（Phase 3.1A1）：
// 只做只读 UIView 派生，内部复用同一 service，不重复预算逻辑、不创建 runContext、不占用 Registry。
func (a *App) PreviewWorldContext(ctx context.Context, consumer worldcontext.Consumer, ref worldcontext.Ref) (*worldcontext.UIView, error) {
	return a.worldContext().PreviewWorldContext(ctx, consumer, ref)
}

// BindWorldRun 读取 World、构建 Snapshot 后按服务端内部 scopeKey 创建/复用/替换 runContext。
// scopeKey 必须由服务端在后续 3.2-A/B 从 Task / InteractiveRun 派生，P2 不读取任何请求体自造身份。
func (s *WorldContextService) BindWorldRun(
	ctx context.Context,
	consumer worldcontext.Consumer,
	scopeKey string,
	ref worldcontext.Ref,
) (*worldcontext.RunContext, worldcontext.BindOutcome, error) {
	snap, err := s.loadSnapshot(ctx, consumer, ref)
	if err != nil {
		return nil, "", err
	}
	rc, outcome, err := s.registry.Bind(worldcontext.BindInput{
		Consumer:  consumer,
		ScopeKey:  scopeKey,
		Snapshot:  snap,
		UISummary: uiSummaryFromSnapshot(snap),
	})
	if err != nil {
		return nil, "", err
	}
	return rc, outcome, nil
}

// ReuseWorldRun 按 scopeKey 复用既有 runContext（reuse/reconnect/regenerate）；纯内存，不读 World。
func (s *WorldContextService) ReuseWorldRun(consumer worldcontext.Consumer, scopeKey, expectedFingerprint string) (*worldcontext.RunContext, error) {
	return s.registry.Reuse(consumer, scopeKey, expectedFingerprint)
}

// GetWorldRunByID 按 runContextId 取回（跨 consumer 拒绝、未知/过期降级）。
func (s *WorldContextService) GetWorldRunByID(id string, consumer worldcontext.Consumer) (*worldcontext.RunContext, error) {
	return s.registry.GetByID(id, consumer)
}

// ReleaseWorldRun 解绑一个 scope 的 runContext（destroy）。
func (s *WorldContextService) ReleaseWorldRun(consumer worldcontext.Consumer, scopeKey string) bool {
	return s.registry.Destroy(consumer, scopeKey)
}

// WorldContextRegistryStats 仅暴露计数/字节诊断，不含正文、路径或身份明文。
func (s *WorldContextService) WorldContextRegistryStats() worldcontext.RegistryStats {
	return s.registry.Stats()
}

// sweepWorldContexts 触发一次 TTL/LRU 清理，供后续生命周期接线与测试使用。
func (s *WorldContextService) sweepWorldContexts() worldcontext.SweepResult {
	return s.registry.Sweep()
}

// uiSummaryFromSnapshot 从 Snapshot 派生允许保留的最小展示摘要。
func uiSummaryFromSnapshot(snap *worldcontext.Snapshot) worldcontext.UIViewSummary {
	label := snap.WorldRevision
	const shortN = 12
	if len(label) > shortN {
		label = label[:shortN]
	}
	return worldcontext.UIViewSummary{
		WorldName:     snap.Identity.Name,
		RevisionLabel: label,
		SelectedCount: snap.Stats.CharacterCount + snap.Stats.LocationCount + snap.Stats.FactionCount +
			snap.Stats.TimelineCount + snap.Stats.MaterialCount,
	}
}
