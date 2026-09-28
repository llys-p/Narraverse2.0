package app

import (
	"context"
	"strings"

	"denova/internal/agent"
	"denova/internal/libraryruntime"
)

// B2a：写作链 library 背景模式的 bind-before-start 编排（L3 计划 §8.1–§8.5）。
//
// 冻结约束（与 WritingWorldControl 同构，且二者由传输层互斥）：
//   - consumer 由写作路径固定为 writing，scopeKey 由服务端 Task ID 派生；
//     客户端提交的 consumer/scopeKey/runContextId 已在 HTTP 传输层被拒绝；
//   - 先绑定并核库版本/预算、装配初始输入，再构建 runner、启动模型 goroutine；
//   - 绑定期失败一律阻断启动，绝不静默降级为 bare——“无资料继续”只能是用户的显式
//     background_source 选择（§8.4），不存在库绑定失败却继续写作的路径；
//   - 库正文只经 EphemeralLibraryContext 进入当次模型输入；完成/取消幂等释放。

// WritingLibraryControl 是一次写作请求携带的作品设定库控制信息（handler-owned）。
// LibraryID 为空表示请求未选择库背景（bare/legacy/none）。
type WritingLibraryControl struct {
	LibraryID        string
	ExpectedRevision string
	ManualItemIDs    []string
}

// Present 报告是否携带库控制字段。
func (c WritingLibraryControl) Present() bool {
	return strings.TrimSpace(c.LibraryID) != ""
}

// writingLibraryRun 是一次写作任务 library 模式 bind-before-start 的绑定结果（派生，不持久化）。
type writingLibraryRun struct {
	run       *libraryruntime.Run
	ephemeral libraryruntime.EphemeralLibraryContext
	scopeKey  string
}

// resolveWritingLibraryRun 执行 library 模式的绑定与初始装配（模型 goroutine 启动前）。
// 返回 nil, nil 表示本次未携带库背景。绑定期错误（invalid_request / selection_invalid /
// revision_conflict / consumer_not_trusted / library_unavailable / budget_exceeded）
// 原样返回并阻断启动。
func (s *ChatAppService) resolveWritingLibraryRun(ctx context.Context, taskID string, ctrl WritingLibraryControl) (*writingLibraryRun, error) {
	if !ctrl.Present() {
		return nil, nil
	}
	// §8.2：服务端派生身份，禁止读取客户端自造的 scope/consumer。
	scopeKey := writingTaskScopeKey(taskID)
	// 零值 Config → libraryruntime 默认预算（512KB / 32000 tokens / 预留输出 8000 / 目录 50）；
	// 系统提示+历史+新消息在模型送入前经 ChargeExternal 计入（§8.3），绑定期不预收。
	run, err := s.app.BindWorkLibraryRuntime(ctx, libraryruntime.BindInput{
		Consumer:         libraryruntime.ConsumerWriting,
		ScopeKey:         scopeKey,
		LibraryID:        ctrl.LibraryID,
		ExpectedRevision: ctrl.ExpectedRevision,
		ManualItemIDs:    ctrl.ManualItemIDs,
	})
	if err != nil {
		return nil, err
	}
	ephemeral, err := run.AssembleInitial(ctx)
	if err != nil {
		// 装配失败即终结本次绑定运行，不留半绑定状态；幂等清理。
		run.Cancel()
		return nil, err
	}
	return &writingLibraryRun{run: run, ephemeral: ephemeral, scopeKey: scopeKey}, nil
}

// releaseWritingLibraryRun 在运行结束时幂等释放库绑定：用户中止 → Cancel，
// 其余（正常完成或运行失败）→ Complete。首终态生效，重复调用返回 released。
func releaseWritingLibraryRun(run *writingLibraryRun, aborted bool) {
	if run == nil || run.run == nil {
		return
	}
	if aborted {
		run.run.Cancel()
		return
	}
	run.run.Complete()
}

// writingLibraryContextStateEvent 构造 library 模式的一次性状态事件（首个模型 chunk 前，
// §8.4）。只携带脱敏摘要：libraryName / revisionLabel / selectedCount；绝不携带
// runContextId、scopeKey、fingerprint 或任何库正文。library 模式只有 active 一种
// 出站状态——绑定期失败已阻断启动，不存在 degraded/静默 bare。
func writingLibraryContextStateEvent(run *writingLibraryRun) agent.Event {
	if run == nil || run.run == nil {
		return agent.Event{Type: "library_context_state", Data: map[string]any{"state": "none"}}
	}
	st := run.run.Status()
	data := map[string]any{
		"state": "active",
	}
	if st.LibraryName != "" {
		data["libraryName"] = st.LibraryName
	}
	if st.Revision != "" {
		data["revisionLabel"] = revisionWireLabel(st.Revision)
	}
	if st.ManualCount > 0 {
		data["selectedCount"] = st.ManualCount
	}
	return agent.Event{Type: "library_context_state", Data: data}
}

// revisionWireLabel 把内部 revision 裁剪为有界 wire 标签，防止超长值进入状态事件。
func revisionWireLabel(revision string) string {
	if len(revision) > 64 {
		return revision[:64]
	}
	return revision
}
