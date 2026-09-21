package handlers

import (
	"context"
	"errors"
	"log"
	"strings"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/protocol/consts"

	"denova/internal/agent"
	"denova/internal/api/sse"
	novaApp "denova/internal/app"
	"denova/internal/workspacechange"
	"denova/internal/worldcontext"
)

// decodeChatRequestBody 从同一只读 body 依次完成 World Context 控制字段的严格解码与
// 既有 agent.ChatRequest 解码。body 只解析一次：控制字段不进入 ChatRequest，
// 并借助顶层 map 解码天然拒绝尾随 JSON / 多个 JSON 值。
func decodeChatRequestBody(body []byte, policy WorldContextEndpointPolicy) (agent.ChatRequest, RuntimeWorldContext, error) {
	var req agent.ChatRequest
	// 先严格校验显式 Ref / handle（含越权字段、camelCase、handle 字符集）。
	runtimeWC, err := DecodeWorldContextTransport(body, policy)
	if err != nil {
		return req, RuntimeWorldContext{}, err
	}
	// 再解码既有业务字段；world_context / analysis_handle 不会进入 ChatRequest。
	if err := DecodeChatRequestWithoutWorldContext(body, &req); err != nil {
		return req, RuntimeWorldContext{}, err
	}
	return req, runtimeWC, nil
}

// writeChatBodyDecodeError 区分 World Context 传输层领域错误（回稳定 code + 安全文案，
// 不泄漏路径/handle/正文）与既有 ChatRequest JSON 错误（沿用 invalidBody）。
func (h *Handlers) writeChatBodyDecodeError(c *app.RequestContext, err error) {
	var domainErr *worldcontext.DomainError
	if errors.As(err, &domainErr) {
		writeContextPreviewError(c, err)
		return
	}
	writeErrorKey(c, consts.StatusBadRequest, "api.common.invalidBody")
}

// handleChat 处理聊天请求：启动后台 Task，然后以 AI SDK UIMessage stream 订阅事件。
func (h *Handlers) HandleChat(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	// body 只读一次：同一字节流同时供 World Context 控制字段与 ChatRequest 解码。
	req, runtimeWC, err := decodeChatRequestBody(c.Request.Body(), PolicyChat)
	if err != nil {
		h.writeChatBodyDecodeError(c, err)
		return
	}
	if strings.TrimSpace(req.Message) == "" {
		writeErrorKey(c, consts.StatusBadRequest, "api.common.messageRequired")
		return
	}
	req.Locale = requestLocale(c)

	in := novaApp.WritingTaskInput{
		Request: req,
		World: novaApp.WritingWorldControl{
			Ref:               runtimeWC.Ref,
			HasAnalysisHandle: runtimeWC.HasAnalysisHandle,
			AnalysisHandle:    runtimeWC.AnalysisHandle,
		},
	}
	task, err := h.app.StartWritingTaskWithError(ctx, in)
	if err != nil {
		h.writeChatPreparationError(c, err)
		return
	}
	log.Printf("[agent-ui-sse] attach new chat task_id=%s", task.ID())
	sse.StreamTaskUI(c, task, h.chatSSEStreamOptions()...)
}

// HandleChatContextAnalysis 模拟一次聊天请求，返回真实 SystemPrompt 和上下文组成，不启动 LLM。
// 该端点允许携带 world_context，但禁止消费旧 analysis_handle（PolicyContextAnalysis）。
func (h *Handlers) HandleChatContextAnalysis(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	req, runtimeWC, err := decodeChatRequestBody(c.Request.Body(), PolicyContextAnalysis)
	if err != nil {
		h.writeChatBodyDecodeError(c, err)
		return
	}
	if strings.TrimSpace(req.Message) == "" {
		writeErrorKey(c, consts.StatusBadRequest, "api.common.messageRequired")
		return
	}
	req.Locale = requestLocale(c)
	// A4：提交有效 Ref 时建立/复用 pending runContext 并签发短期 analysisHandle；
	// 分析展示读取该 pending runContext 的最终 ModelView bytes（与首次 chat 同源）。
	result, err := h.app.AnalyzeWritingContext(ctx, req, runtimeWC.Ref)
	if err != nil {
		var domainErr *worldcontext.DomainError
		if errors.As(err, &domainErr) {
			writeContextPreviewError(c, err)
			return
		}
		h.writeChatPreparationError(c, err)
		return
	}
	c.JSON(consts.StatusOK, toWritingContextAnalysisWire(result))
}

func (h *Handlers) writeChatPreparationError(c *app.RequestContext, err error) {
	if errors.Is(err, novaApp.ErrNoWorkspace) {
		writeErrorKey(c, consts.StatusConflict, "api.workspace.noWorkspace")
		return
	}
	if errors.Is(err, novaApp.ErrWorkspaceChanged) {
		h.writeWorkspaceChangeLeaseError(c, "", err)
		return
	}
	var changeErr *workspacechange.Error
	if errors.As(err, &changeErr) {
		writeWorkspaceChangeError(c, err)
		return
	}
	writeError(c, consts.StatusInternalServerError, err.Error())
}

func (h *Handlers) HandleChatContextCompaction(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	result, err := h.app.CompactContext(ctx)
	if err != nil {
		writeError(c, consts.StatusConflict, err.Error())
		return
	}
	writeJSON(c, consts.StatusOK, result)
}

func (h *Handlers) HandleChatContextCompactionRemove(ctx context.Context, c *app.RequestContext) {
	if !h.requireWorkspace(c) {
		return
	}
	removed, err := h.app.RemoveContextCompaction()
	if err != nil {
		writeError(c, consts.StatusConflict, err.Error())
		return
	}
	writeJSON(c, consts.StatusOK, map[string]bool{"removed": removed})
}

// handleChatStream 重连到当前活跃任务的 UIMessage 事件流（回放已有事件 + 继续接收新事件）。
func (h *Handlers) HandleChatStream(ctx context.Context, c *app.RequestContext) {
	task := h.app.ActiveTask()
	if task == nil {
		writeErrorKey(c, consts.StatusNotFound, "api.chat.noActiveTask")
		return
	}
	log.Printf("[agent-ui-sse] attach active chat task_id=%s status=%s", task.ID(), task.Status())
	sse.StreamTaskUI(c, task, h.chatSSEStreamOptions()...)
}

// handleChatActive 查询当前是否有活跃任务。
func (h *Handlers) HandleChatActive(ctx context.Context, c *app.RequestContext) {
	task := h.app.ActiveTask()
	if task == nil {
		c.JSON(consts.StatusOK, map[string]interface{}{
			"active": false,
		})
		return
	}
	status := task.Status()
	c.JSON(consts.StatusOK, map[string]interface{}{
		"active": status == novaApp.TaskRunning,
		"status": status,
	})
}

// handleChatAbort 终止当前活跃任务。
func (h *Handlers) HandleChatAbort(ctx context.Context, c *app.RequestContext) {
	if task := h.app.ActiveTask(); task != nil {
		log.Printf("[agent-sse] abort requested task_id=%s status=%s", task.ID(), task.Status())
	}
	h.app.AbortTask()
	c.JSON(consts.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handlers) chatSSEStreamOptions() []sse.StreamOption {
	return []sse.StreamOption{
		sse.WithHideChapterBodyLiveOutput(h.app.HideChapterBodyLiveOutput()),
	}
}
