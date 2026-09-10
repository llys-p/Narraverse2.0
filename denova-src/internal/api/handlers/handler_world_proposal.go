package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/protocol/consts"

	novaApp "denova/internal/app"
)

const maxProposalRequestBodyBytes = 64 << 10 // 64 KiB：请求只含 id/字段路径/片段

// decodeStrictJSON 严格解码：拒绝未知字段与尾随 JSON（服务端最终拒绝，前端只显示计数）。
func decodeStrictJSON(body []byte, target any) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		return err
	}
	var trailing json.RawMessage
	if err := dec.Decode(&trailing); err == nil {
		return errors.New("请求体包含多余 JSON 数据")
	} else if !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

func writeProposalError(c *app.RequestContext, status int, code, msg string) {
	c.JSON(status, map[string]any{"error": msg, "code": code})
}

// HandleWorldProposal POST /api/world-proposals —— 创建向导受控 AI 结构分析。
// 前端不得直调 /api/model/chat；本入口重读 Master 校验后走 App.GenerateModel(module=narraverse)。
func (h *Handlers) HandleWorldProposal(ctx context.Context, c *app.RequestContext) {
	body := c.Request.Body()
	if len(body) > maxProposalRequestBodyBytes {
		writeProposalError(c, consts.StatusBadRequest, "invalid_request", "请求体过大（上限 64 KiB）")
		return
	}
	var req novaApp.WorldStructureAnalysisRequest
	if err := decodeStrictJSON(body, &req); err != nil {
		writeProposalError(c, consts.StatusBadRequest, "invalid_request", "请求体解析失败或包含未知字段")
		return
	}
	proposal, err := h.app.AnalyzeWorldStructure(ctx, req)
	if err != nil {
		var pe *novaApp.ProposalError
		if errors.As(err, &pe) {
			writeProposalError(c, pe.HTTPStatus, pe.Code, pe.Message)
			return
		}
		writeProposalError(c, consts.StatusBadGateway, "upstream_error", "共享模型请求失败。")
		return
	}
	writeJSON(c, consts.StatusOK, map[string]any{"proposal": proposal})
}
