package app

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"denova/config"
	"denova/internal/agent"
	"denova/internal/book"
	"denova/internal/libraryruntime"
	"denova/internal/prompts"
)

// B3a：游戏链 library 背景模式的 bind-before-start 编排（L3 计划 §8.1–§8.6）。
//
// 与写作链（library_writing.go）同构的冻结约束：
//   - consumer 由游戏路径固定为 game，scopeKey 由服务端 InteractiveRun 身份派生
//     （story|branch|run 三元组）；客户端提交的 consumer/scopeKey/runContextId
//     已在 HTTP 传输层被拒绝；
//   - 新回合：先绑定并核库版本/预算、装配初始输入，再构建 runner、启动模型
//     goroutine（bind-before-start）；
//   - regenerate：以原 InteractiveRun 记录的绑定元数据服务端重绑（固定原
//     revision），不依赖客户端重发 library_context；库过期/版本漂移显式失败，
//     绝不静默降级为 bare，也不把新版本当原版本（§8.2）；
//   - 绑定期失败沿游戏链既有语义以显式错误事件返回，任务不产生模型输出；
//   - 库正文只经 EphemeralLibraryContext 进入当次模型输入；完成/取消幂等释放。

// InteractiveLibraryControl 是一次游戏回合请求携带的作品设定库控制信息
// （handler-owned，B3a）。LibraryID 为空表示请求未选择库背景。
type InteractiveLibraryControl struct {
	LibraryID        string
	ExpectedRevision string
	ManualItemIDs    []string
}

// Present 报告是否携带库控制字段。
func (c InteractiveLibraryControl) Present() bool {
	return strings.TrimSpace(c.LibraryID) != ""
}

// interactiveLibraryRun 是一次游戏回合任务（执行尝试）library 模式
// bind-before-start 的绑定结果（派生，不持久化）。
type interactiveLibraryRun struct {
	run       *libraryruntime.Run
	ephemeral libraryruntime.EphemeralLibraryContext
	scopeKey  string
	// binding 是写入 InteractiveRun 记录的授权元数据（regenerate 复用真源）。
	binding interactiveRunLibraryBinding
}

// interactiveBackgroundPlan 是一次游戏回合的背景模式裁定（B3a）。
// 模式语义与写作链 planWritingBackground 一致：
//   - 携带 library_context → library；
//   - 显式 background_source="none" → none（推断的 none 不等于显式 none）；
//   - 其余（未声明/显式 legacy，含结构推断为 none 的未声明请求）→ legacy，
//     与基线逐字节一致（旧请求兼容）。
type interactiveBackgroundPlan struct {
	Mode         string
	NoLegacyLore bool
	// Composition 是单源系统提示 composition（§8.8 缺口②）：同时用于 runner 装配
	// 与 RunOptions.SystemPromptLog，保证计费/审计文本 == 模型实际系统提示。
	Composition agent.SystemPromptCompositionLog
}

func planInteractiveBackground(cfg *config.Config, state *book.State, teller prompts.InteractiveStorySystemInstructionInput, in InteractiveTaskInput) interactiveBackgroundPlan {
	mode := agent.BackgroundModeLegacy
	if in.Library.Present() {
		mode = agent.BackgroundModeLibrary
	} else if in.BackgroundSourceExplicit && in.BackgroundSource == agent.BackgroundModeNone {
		mode = agent.BackgroundModeNone
	}
	return interactiveBackgroundPlanForMode(cfg, state, teller, mode)
}

// interactiveBackgroundPlanForMode 按已定模式构建单源系统提示组成（B3a）。regenerate
// 复用路径的模式来自 InteractiveRun 记录（§8.2 不看请求），经此函数得到与 runner 装配、
// RunOptions.SystemPromptLog 同源的 composition。legacy 模式保持既有
// BuildInteractiveStoryInstructionComposition 调用不变（旧请求兼容）。
func interactiveBackgroundPlanForMode(cfg *config.Config, state *book.State, teller prompts.InteractiveStorySystemInstructionInput, mode string) interactiveBackgroundPlan {
	plan := interactiveBackgroundPlan{
		Mode:         mode,
		NoLegacyLore: mode != agent.BackgroundModeLegacy,
	}
	if mode == agent.BackgroundModeLibrary || mode == agent.BackgroundModeNone {
		plan.Composition = agent.BuildInteractiveStoryBackgroundInstructionComposition(cfg, state, teller, mode)
	} else {
		plan.Composition = agent.BuildInteractiveStoryInstructionComposition(cfg, state, teller)
	}
	return plan
}

// interactiveRegenerateBackgroundConflict 检查 regenerate 请求携带的背景控制是否与
// 原运行记录的背景冲突（§8.2：regenerate 必须服务端复用原背景，不依赖客户端重发；
// 也不接受客户端改写）。返回空串表示兼容（未重发，或重发了与原运行一致的背景）；
// 否则返回稳定错误码。storedMode 为空串表示 legacy（含 B3a 之前的旧运行缺省）。
func interactiveRegenerateBackgroundConflict(storedMode string, storedBinding interactiveRunLibraryBinding, in InteractiveTaskInput) string {
	storedMode = strings.TrimSpace(storedMode)
	if in.Library.Present() {
		requested := interactiveRunLibraryBinding{
			libraryID:        in.Library.LibraryID,
			expectedRevision: in.Library.ExpectedRevision,
			manualItemIDs:    in.Library.ManualItemIDs,
		}.normalize()
		if storedMode != agent.BackgroundModeLibrary || !storedBinding.same(requested) {
			return string(libraryruntime.ErrInvalidRequest)
		}
		return ""
	}
	if in.BackgroundSourceExplicit {
		declared := strings.TrimSpace(in.BackgroundSource)
		if declared == "legacy" {
			// transport 层的显式 legacy 声明（handlers.BackgroundSourceLegacy）等价
			// 内部空串模式（agent.BackgroundModeLegacy）。
			declared = agent.BackgroundModeLegacy
		}
		if declared != storedMode {
			return string(libraryruntime.ErrInvalidRequest)
		}
	}
	return ""
}

// resolveInteractiveLibraryRun 执行新回合 library 模式的绑定与初始装配（模型
// goroutine 启动前）。返回 nil, nil 表示本次未携带库背景。scopeKey 必须由调用方
// 从 InteractiveRun 记录派生（服务端身份），不得接受客户端自造值。
// 绑定期错误（invalid_request / selection_invalid / revision_conflict /
// consumer_not_trusted / library_unavailable / budget_exceeded）原样返回并阻断启动。
func resolveInteractiveLibraryRun(ctx context.Context, a *App, scopeKey string, ctrl InteractiveLibraryControl) (*interactiveLibraryRun, error) {
	if a == nil || !ctrl.Present() {
		return nil, nil
	}
	if scopeKey == "" {
		return nil, fmt.Errorf("interactive library binding requires a server-derived run scope")
	}
	// §8.2：服务端派生身份，禁止读取客户端自造的 scope/consumer。
	run, err := a.BindWorkLibraryRuntime(ctx, libraryruntime.BindInput{
		Consumer:         libraryruntime.ConsumerGame,
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
	return &interactiveLibraryRun{
		run:       run,
		ephemeral: ephemeral,
		scopeKey:  scopeKey,
		binding: interactiveRunLibraryBinding{
			libraryID:        strings.TrimSpace(ctrl.LibraryID),
			expectedRevision: strings.TrimSpace(ctrl.ExpectedRevision),
			manualItemIDs:    ctrl.ManualItemIDs,
		}.normalize(),
	}, nil
}

// reuseInteractiveLibraryBinding 执行 regenerate/reconnect 的服务端重绑（B3a，
// §8.2）：以原 InteractiveRun 记录中的授权元数据（固定原 revision）重新
// Bind+AssembleInitial。库已变更 → revision_conflict 显式失败，不静默 bare，
// 也不把新版本当原版本。binding 不完整（库/版本缺失）→ invalid_request。
func reuseInteractiveLibraryBinding(ctx context.Context, a *App, scopeKey string, binding interactiveRunLibraryBinding) (*interactiveLibraryRun, error) {
	if a == nil {
		return nil, fmt.Errorf("interactive library reuse requires the app runtime")
	}
	binding = binding.normalize()
	if !binding.present() {
		return nil, fmt.Errorf("interactive library reuse requires a complete stored binding")
	}
	return resolveInteractiveLibraryRun(ctx, a, scopeKey, InteractiveLibraryControl{
		LibraryID:        binding.libraryID,
		ExpectedRevision: binding.expectedRevision,
		ManualItemIDs:    binding.manualItemIDs,
	})
}

// releaseInteractiveLibraryRun 在回合任务结束时幂等释放库绑定：用户中止/运行
// 出错 → Cancel，正常完成 → Complete。首终态生效，重复调用返回 released。
// Task 仍是执行尝试：regenerate 各自的任务重绑各自的 Run，互不共享计费状态。
func releaseInteractiveLibraryRun(run *interactiveLibraryRun, aborted bool) {
	if run == nil || run.run == nil {
		return
	}
	if aborted {
		run.run.Cancel()
		return
	}
	run.run.Complete()
}

// errInteractiveRunBackgroundUnavailable 是 regenerate 复用阶段的阻断性错误（§8.2）：
// 原 InteractiveRun 索引未命中（进程重启/索引过期，prepareInteractiveTaskRun 兜底
// 新建 bare run）或运行索引本身不可用时，原运行的背景模式与库绑定不可考。禁止猜测
// 背景：既不能按 legacy 重生成（原本带库的回合会静默换回旧 Lore），也不能启动模型。
// 经 interactiveLibraryContextErrorEvent 映射为稳定 stale 码与固定脱敏文案。
var errInteractiveRunBackgroundUnavailable = errors.New("interactive regenerate: original run background unavailable")

// interactiveLibraryContextErrorEvent 把阻断性库背景错误转换成稳定、脱敏的 SSE
// error 事件（B3a）：code 取 libraryruntime 稳定码（绑定期失败）或请求冲突码；
// message 是固定文案，绝不携带本机路径、库正文或内部运行身份。绑定期失败已阻断
// 启动，不存在 degraded/静默 bare。
func interactiveLibraryContextErrorEvent(err error) agent.Event {
	code := string(libraryruntime.CodeOf(err))
	message := "作品设定库背景无法加载，请修正当前选择后重试"
	if errors.Is(err, errInteractiveRunBackgroundUnavailable) {
		code = string(libraryruntime.ErrStale)
		message = "原回合的运行背景已不可用，无法按原背景重新生成，请刷新后重试"
	}
	if code == "" {
		code = string(libraryruntime.ErrLibraryUnavailable)
	}
	return agent.Event{Type: "error", Data: map[string]string{
		"code":    code,
		"message": message,
	}}
}

// interactiveLibraryContextStateEvent 构造 library 模式的一次性状态事件（首个模型
// chunk 前，§8.4）。只携带脱敏摘要：libraryName / revisionLabel / selectedCount；
// 绝不携带 runContextId、scopeKey、fingerprint 或任何库正文。
func interactiveLibraryContextStateEvent(run *interactiveLibraryRun) agent.Event {
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
