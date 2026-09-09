package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/protocol/consts"

	"denova/internal/revisionfile"
	"denova/internal/world"
)

const maxWorldRequestBodyBytes = 1 << 20

func worldRequestBody(c *app.RequestContext) ([]byte, error) {
	body := c.Request.Body()
	if len(body) > maxWorldRequestBodyBytes {
		return nil, errors.New("世界请求体不能超过 1 MiB")
	}
	return body, nil
}

func decodeWorldRequest(c *app.RequestContext, target any) error {
	body, err := worldRequestBody(c)
	if err != nil {
		return err
	}
	return json.Unmarshal(body, target)
}

// worldErrorStatus 把领域错误映射为 HTTP 状态码。
func worldErrorStatus(err error) int {
	var validation *world.ValidationError
	switch {
	case errors.As(err, &validation):
		return consts.StatusBadRequest
	case errors.Is(err, world.ErrInvalidID):
		return consts.StatusBadRequest
	case errors.Is(err, world.ErrNotFound):
		return consts.StatusNotFound
	case errors.Is(err, revisionfile.ErrRevisionConflict):
		return consts.StatusConflict
	default:
		return consts.StatusInternalServerError
	}
}

func writeWorldError(c *app.RequestContext, err error) {
	status := worldErrorStatus(err)
	var validation *world.ValidationError
	var conflict *revisionfile.ConflictError
	switch {
	case errors.As(err, &validation), errors.Is(err, world.ErrInvalidID), errors.Is(err, world.ErrNotFound):
		writeError(c, status, err.Error())
	case errors.As(err, &conflict):
		writeError(c, status, revisionfile.ErrRevisionConflict.Error()+": expected="+conflict.Expected+" actual="+conflict.Actual)
	default:
		writeError(c, status, "世界数据操作失败")
	}
}

// HandleWorldList GET /api/worlds[?status=active|archived]
func (h *Handlers) HandleWorldList(ctx context.Context, c *app.RequestContext) {
	var status world.WorldStatus
	switch q := strings.TrimSpace(c.Query("status")); q {
	case "", "all":
		status = ""
	case string(world.StatusActive), string(world.StatusArchived):
		status = world.WorldStatus(q)
	default:
		writeError(c, consts.StatusBadRequest, "status 参数非法")
		return
	}
	result, err := h.app.ListWorlds(ctx, status)
	if err != nil {
		writeError(c, consts.StatusInternalServerError, "世界列表读取失败")
		return
	}
	writeJSON(c, consts.StatusOK, map[string]interface{}{
		"worlds":   result.Worlds,
		"warnings": result.Warnings,
	})
}

// createForbiddenFields 是创建时禁止由客户端指定的服务端字段。
var createForbiddenFields = []string{"id", "status", "createdAt", "updatedAt", "schemaVersion", "revision"}

// HandleWorldCreate POST /api/worlds — 一次原子创建完整初始世界。
func (h *Handlers) HandleWorldCreate(ctx context.Context, c *app.RequestContext) {
	body, err := worldRequestBody(c)
	if err != nil {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(body, &probe); err != nil {
		writeErrorKey(c, consts.StatusBadRequest, "api.common.invalidRequest")
		return
	}
	for _, key := range createForbiddenFields {
		if _, present := probe[key]; present {
			writeError(c, consts.StatusBadRequest, "创建世界时不允许指定字段："+key)
			return
		}
	}
	var in world.CreateInput
	if err := json.Unmarshal(body, &in); err != nil {
		writeError(c, consts.StatusBadRequest, "请求体解析失败："+err.Error())
		return
	}
	w, rev, err := h.app.CreateWorld(ctx, in)
	if err != nil {
		writeWorldError(c, err)
		return
	}
	writeJSON(c, consts.StatusCreated, map[string]interface{}{"world": w, "revision": rev})
}

// HandleWorldGet GET /api/worlds/:id
func (h *Handlers) HandleWorldGet(ctx context.Context, c *app.RequestContext) {
	w, rev, err := h.app.GetWorld(ctx, c.Param("id"))
	if err != nil {
		// 统一世界错误脱敏策略：损坏文件等内部错误不得把 err.Error()（可能含本机路径）直接回给客户端。
		writeWorldError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]interface{}{"world": w, "revision": rev})
}

// HandleWorldReplace PUT /api/worlds/:id — 整文档 CAS 替换。
func (h *Handlers) HandleWorldReplace(ctx context.Context, c *app.RequestContext) {
	var req struct {
		ExpectedRevision string      `json:"expected_revision"`
		World            world.World `json:"world"`
	}
	if err := decodeWorldRequest(c, &req); err != nil {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(req.ExpectedRevision) == "" {
		writeError(c, consts.StatusBadRequest, "expected_revision 不能为空")
		return
	}
	w, rev, err := h.app.ReplaceWorld(ctx, c.Param("id"), req.ExpectedRevision, req.World)
	if err != nil {
		writeWorldError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]interface{}{"world": w, "revision": rev})
}

// HandleWorldArchive POST /api/worlds/:id/archive — 归档或恢复（撤销），走 CAS。
func (h *Handlers) HandleWorldArchive(ctx context.Context, c *app.RequestContext) {
	var req struct {
		Archived         *bool  `json:"archived"`
		ExpectedRevision string `json:"expected_revision"`
	}
	if err := decodeWorldRequest(c, &req); err != nil {
		writeError(c, consts.StatusBadRequest, err.Error())
		return
	}
	if req.Archived == nil {
		writeError(c, consts.StatusBadRequest, "archived 必须是布尔值")
		return
	}
	if strings.TrimSpace(req.ExpectedRevision) == "" {
		writeError(c, consts.StatusBadRequest, "expected_revision 不能为空")
		return
	}
	w, rev, err := h.app.ArchiveWorld(ctx, c.Param("id"), req.ExpectedRevision, *req.Archived)
	if err != nil {
		writeWorldError(c, err)
		return
	}
	writeJSON(c, consts.StatusOK, map[string]interface{}{"world": w, "revision": rev})
}
