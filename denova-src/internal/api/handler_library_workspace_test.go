package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudwego/hertz/pkg/common/ut"

	"denova/config"
	runtimeapp "denova/internal/app"
)

// L1.2 纵向链验收：创建 → 列表 → 打开 → 编辑 → 保存 → 重启读取，
// 且整条链在**没有任何书籍/World**的状态下可用；409 保留服务端数据不变，
// 错误不泄露本机路径。测试直接跑 Hertz 引擎，不启动真实进程。

// newNoBookApplication 构造一个刻意不绑定书籍工作区的 App（用户还没建书的状态）。
func newNoBookApplication(t *testing.T, dataDir string) *runtimeapp.App {
	t.Helper()
	if dataDir == "" {
		dataDir = t.TempDir()
	}
	application, err := runtimeapp.New(context.Background(), &config.Config{
		OpenAIModel:         "test-model",
		NovaDir:             dataDir,
		Workspace:           "", // 关键：没有书籍
		ResumeLastWorkspace: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	if application.HasWorkspace() {
		t.Fatal("测试前提：该 App 不应绑定任何书籍工作区")
	}
	return application
}

func decodeWorkLibraryResponse(t *testing.T, body []byte, target any) {
	t.Helper()
	if err := json.Unmarshal(body, target); err != nil {
		t.Fatalf("解析响应失败: %v body=%s", err, string(body))
	}
}

func testMapValue(value any, key string) map[string]any {
	data, _ := value.(map[string]any)
	nested, _ := data[key].(map[string]any)
	return nested
}

func testSliceValue(value any, key string) []any {
	data, _ := value.(map[string]any)
	items, _ := data[key].([]any)
	return items
}

// 主链路：无书籍状态下建库、建条目、改条目、重启后仍在。
func TestWorkLibraryVerticalChainWithoutBook(t *testing.T) {
	dataDir := t.TempDir()
	application := newNoBookApplication(t, dataDir)
	server := NewServer(application, "0")

	// 1) 建库（没有书，也不需要 World）
	createResp := performJSONRequest(t, server, http.MethodPost, "/api/work-libraries", map[string]any{
		"name":    "水浒原著资料",
		"purpose": "writing",
		"tone":    "冷峻",
	})
	if createResp.Code != http.StatusCreated {
		t.Fatalf("建库 status = %d body=%s", createResp.Code, createResp.Body.String())
	}
	var created struct {
		Library  map[string]any `json:"library"`
		Revision string         `json:"revision"`
	}
	decodeWorkLibraryResponse(t, createResp.Body.Bytes(), &created)
	libraryID, _ := created.Library["id"].(string)
	if libraryID == "" || created.Revision == "" {
		t.Fatalf("建库响应缺少 id/revision: %s", createResp.Body.String())
	}
	if created.Library["name"] != "水浒原著资料" || created.Library["purpose"] != "writing" {
		t.Fatalf("建库返回内容不符: %#v", created.Library)
	}

	// 2) 列表
	listResp := performJSONRequest(t, server, http.MethodGet, "/api/work-libraries", nil)
	if listResp.Code != http.StatusOK {
		t.Fatalf("列表 status = %d", listResp.Code)
	}
	var list struct {
		Libraries []map[string]any `json:"libraries"`
		Warnings  []map[string]any `json:"warnings"`
	}
	decodeWorkLibraryResponse(t, listResp.Body.Bytes(), &list)
	if len(list.Libraries) != 1 || list.Libraries[0]["id"] != libraryID {
		t.Fatalf("列表应包含刚建的库: %s", listResp.Body.String())
	}
	if len(list.Warnings) != 0 {
		t.Fatalf("新建库不应有警告: %#v", list.Warnings)
	}

	// 3) 建条目（手建）
	itemResp := performJSONRequest(t, server, http.MethodPost, "/api/work-libraries/"+libraryID+"/items", map[string]any{
		"type":             "character",
		"name":             "林冲",
		"content":          "八十万禁军教头。",
		"briefDescription": "禁军教头",
		"loadMode":         "resident",
		"importance":       "major",
	})
	if itemResp.Code != http.StatusCreated {
		t.Fatalf("建条目 status = %d body=%s", itemResp.Code, itemResp.Body.String())
	}
	var itemCreated struct {
		Item     map[string]any `json:"item"`
		Revision string         `json:"revision"`
	}
	decodeWorkLibraryResponse(t, itemResp.Body.Bytes(), &created)
	decodeWorkLibraryResponse(t, itemResp.Body.Bytes(), &itemCreated)
	itemID, _ := itemCreated.Item["id"].(string)
	if itemID == "" {
		t.Fatalf("条目缺少稳定 ID: %s", itemResp.Body.String())
	}
	firstItemRevision, _ := itemCreated.Item["updatedAt"].(string)

	// 4) 打开（读取单库）
	getResp := performJSONRequest(t, server, http.MethodGet, "/api/work-libraries/"+libraryID, nil)
	if getResp.Code != http.StatusOK {
		t.Fatalf("打开 status = %d", getResp.Code)
	}
	var opened struct {
		Library  map[string]any `json:"library"`
		Revision string         `json:"revision"`
	}
	decodeWorkLibraryResponse(t, getResp.Body.Bytes(), &opened)
	items := testSliceValue(opened.Library, "items")
	if len(items) != 1 {
		t.Fatalf("打开应读到 1 个条目: %s", getResp.Body.String())
	}

	// 5) 编辑并保存（带条目级基线）
	updateResp := performJSONRequest(t, server, http.MethodPatch, "/api/work-libraries/"+libraryID+"/items/"+itemID, map[string]any{
		"name":          "豹子头林冲",
		"content":       "八十万禁军教头，被逼上梁山。",
		"baseUpdatedAt": firstItemRevision,
	})
	if updateResp.Code != http.StatusOK {
		t.Fatalf("保存 status = %d body=%s", updateResp.Code, updateResp.Body.String())
	}
	var updated struct {
		Item     map[string]any `json:"item"`
		Revision string         `json:"revision"`
	}
	decodeWorkLibraryResponse(t, updateResp.Body.Bytes(), &updated)
	if updated.Item["id"] != itemID {
		t.Fatalf("改名不得改变 ID: %#v", updated.Item)
	}
	if updated.Item["content"] != "八十万禁军教头，被逼上梁山。" {
		t.Fatalf("正文未保存: %#v", updated.Item)
	}
	if updated.Revision == opened.Revision {
		t.Fatal("保存后库级 revision 必须变化")
	}

	// 6) 重启：换一个 App 与 Server 读同一数据目录
	restarted := newNoBookApplication(t, dataDir)
	restartedServer := NewServer(restarted, "0")
	reloadResp := performJSONRequest(t, restartedServer, http.MethodGet, "/api/work-libraries/"+libraryID, nil)
	if reloadResp.Code != http.StatusOK {
		t.Fatalf("重启后读取 status = %d body=%s", reloadResp.Code, reloadResp.Body.String())
	}
	var reloaded struct {
		Library  map[string]any `json:"library"`
		Revision string         `json:"revision"`
	}
	decodeWorkLibraryResponse(t, reloadResp.Body.Bytes(), &reloaded)
	if reloaded.Revision != updated.Revision {
		t.Fatalf("重启后 revision 应一致: %q -> %q", updated.Revision, reloaded.Revision)
	}
	reloadedItems := testSliceValue(reloaded.Library, "items")
	if len(reloadedItems) != 1 {
		t.Fatalf("重启后条目应仍在: %s", reloadResp.Body.String())
	}
	reloadedItem, _ := reloadedItems[0].(map[string]any)
	if reloadedItem["name"] != "豹子头林冲" || reloadedItem["content"] != "八十万禁军教头，被逼上梁山。" {
		t.Fatalf("重启后条目内容应与保存一致: %#v", reloadedItem)
	}
	// 重启后的 App 仍然没有书籍：证明库不依赖书籍存在
	if restarted.HasWorkspace() {
		t.Fatal("设定库不应依赖书籍工作区")
	}
}

// 409：并发保存冲突必须可识别、可恢复，且不得覆盖已保存的数据。
func TestWorkLibrarySaveConflictKeepsStoredData(t *testing.T) {
	application := newNoBookApplication(t, "")
	server := NewServer(application, "0")

	createResp := performJSONRequest(t, server, http.MethodPost, "/api/work-libraries", map[string]any{"name": "并发库"})
	var created struct {
		Library  map[string]any `json:"library"`
		Revision string         `json:"revision"`
	}
	decodeWorkLibraryResponse(t, createResp.Body.Bytes(), &created)
	libraryID, _ := created.Library["id"].(string)
	baseRevision := created.Revision

	// A 先保存成功
	saveA := performJSONRequest(t, server, http.MethodPatch, "/api/work-libraries/"+libraryID, map[string]any{
		"expected_revision": baseRevision,
		"patch":             map[string]any{"summary": "A 的简介"},
	})
	if saveA.Code != http.StatusOK {
		t.Fatalf("A 保存应成功: %d %s", saveA.Code, saveA.Body.String())
	}

	// B 用过期 revision 保存 → 409 + revision_conflict
	saveB := performJSONRequest(t, server, http.MethodPatch, "/api/work-libraries/"+libraryID, map[string]any{
		"expected_revision": baseRevision,
		"patch":             map[string]any{"summary": "B 的简介"},
	})
	if saveB.Code != http.StatusConflict {
		t.Fatalf("过期 revision 应 409，got %d body=%s", saveB.Code, saveB.Body.String())
	}
	var conflict struct {
		Code string `json:"code"`
	}
	decodeWorkLibraryResponse(t, saveB.Body.Bytes(), &conflict)
	if conflict.Code != "revision_conflict" {
		t.Fatalf("409 必须带 revision_conflict code（前端据此保留草稿并重新加载），got %q", conflict.Code)
	}

	// 服务器数据仍是 A 的版本，B 的草稿没有被写入
	getResp := performJSONRequest(t, server, http.MethodGet, "/api/work-libraries/"+libraryID, nil)
	var after struct {
		Library map[string]any `json:"library"`
	}
	decodeWorkLibraryResponse(t, getResp.Body.Bytes(), &after)
	if after.Library["summary"] != "A 的简介" {
		t.Fatalf("冲突写入不得落盘: %#v", after.Library["summary"])
	}

	// 条目级冲突：过期 baseUpdatedAt
	itemResp := performJSONRequest(t, server, http.MethodPost, "/api/work-libraries/"+libraryID+"/items", map[string]any{
		"type": "item", "name": "刀", "content": "初稿",
	})
	var itemCreated struct {
		Item map[string]any `json:"item"`
	}
	decodeWorkLibraryResponse(t, itemResp.Body.Bytes(), &itemCreated)
	itemID, _ := itemCreated.Item["id"].(string)
	staleStamp, _ := itemCreated.Item["updatedAt"].(string)

	first := performJSONRequest(t, server, http.MethodPatch, "/api/work-libraries/"+libraryID+"/items/"+itemID, map[string]any{
		"content": "A 的正文", "baseUpdatedAt": staleStamp,
	})
	if first.Code != http.StatusOK {
		t.Fatalf("首次条目更新应成功: %d %s", first.Code, first.Body.String())
	}
	second := performJSONRequest(t, server, http.MethodPatch, "/api/work-libraries/"+libraryID+"/items/"+itemID, map[string]any{
		"content": "B 的正文", "baseUpdatedAt": staleStamp,
	})
	if second.Code != http.StatusConflict {
		t.Fatalf("过期 baseUpdatedAt 应 409，got %d body=%s", second.Code, second.Body.String())
	}
	var itemConflict struct {
		Code string `json:"code"`
	}
	decodeWorkLibraryResponse(t, second.Body.Bytes(), &itemConflict)
	if itemConflict.Code != "revision_conflict" {
		t.Fatalf("条目冲突也必须带 revision_conflict，got %q", itemConflict.Code)
	}
	reload := performJSONRequest(t, server, http.MethodGet, "/api/work-libraries/"+libraryID, nil)
	var reloaded struct {
		Library map[string]any `json:"library"`
	}
	decodeWorkLibraryResponse(t, reload.Body.Bytes(), &reloaded)
	reloadedItems := testSliceValue(reloaded.Library, "items")
	got, _ := reloadedItems[0].(map[string]any)
	if got["content"] != "A 的正文" {
		t.Fatalf("条目冲突不得覆盖已保存正文: %#v", got)
	}
}

// 错误契约：不泄露本机路径、状态码与 code 稳定、非法输入被拒。
func TestWorkLibraryErrorsAreStableAndSanitized(t *testing.T) {
	dataDir := t.TempDir()
	application := newNoBookApplication(t, dataDir)
	server := NewServer(application, "0")

	// 未知库 → 404 not_found
	notFound := performJSONRequest(t, server, http.MethodGet, "/api/work-libraries/aaaaaaaaaaaaaaaa", nil)
	if notFound.Code != http.StatusNotFound {
		t.Fatalf("未知库应 404，got %d", notFound.Code)
	}
	var notFoundBody struct {
		Code string `json:"code"`
	}
	decodeWorkLibraryResponse(t, notFound.Body.Bytes(), &notFoundBody)
	if notFoundBody.Code != "not_found" {
		t.Fatalf("未知库 code 应为 not_found，got %q", notFoundBody.Code)
	}

	// 非法库 id → 400 invalid_id
	badID := performJSONRequest(t, server, http.MethodGet, "/api/work-libraries/BAD-ID", nil)
	if badID.Code != http.StatusBadRequest {
		t.Fatalf("非法 id 应 400，got %d body=%s", badID.Code, badID.Body.String())
	}

	// 空库名 → 400 validation_failed
	emptyName := performJSONRequest(t, server, http.MethodPost, "/api/work-libraries", map[string]any{"name": "   "})
	if emptyName.Code != http.StatusBadRequest {
		t.Fatalf("空库名应 400，got %d", emptyName.Code)
	}

	// 客户端伪造服务端字段 → 400
	forged := performJSONRequest(t, server, http.MethodPost, "/api/work-libraries", map[string]any{
		"name": "伪造", "id": "hacked0000000000", "schemaVersion": 99,
	})
	if forged.Code != http.StatusBadRequest {
		t.Fatalf("伪造服务端字段应 400，got %d body=%s", forged.Code, forged.Body.String())
	}

	// 损坏文件 → 500 且文案不含本机路径
	librariesDir := filepath.Join(dataDir, "libraries")
	if err := os.MkdirAll(librariesDir, 0o755); err != nil {
		t.Fatal(err)
	}
	corruptID := "bbbbbbbbbbbbbbbb"
	if err := os.WriteFile(filepath.Join(librariesDir, "library-"+corruptID+".json"), []byte("{broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	corrupt := performJSONRequest(t, server, http.MethodGet, "/api/work-libraries/"+corruptID, nil)
	if corrupt.Code != http.StatusInternalServerError {
		t.Fatalf("损坏库应 500，got %d body=%s", corrupt.Code, corrupt.Body.String())
	}
	body := corrupt.Body.String()
	if strings.Contains(body, dataDir) || strings.Contains(body, "libraries") || strings.Contains(body, "C:") {
		t.Fatalf("损坏错误不得泄露本机路径或目录结构: %s", body)
	}
	// 列表把损坏文件单列为 warning，而不是静默丢弃
	listResp := performJSONRequest(t, server, http.MethodGet, "/api/work-libraries", nil)
	var list struct {
		Libraries []map[string]any `json:"libraries"`
		Warnings  []map[string]any `json:"warnings"`
	}
	decodeWorkLibraryResponse(t, listResp.Body.Bytes(), &list)
	if len(list.Warnings) != 1 {
		t.Fatalf("损坏文件必须出现在 warnings: %s", listResp.Body.String())
	}
	if reason, _ := list.Warnings[0]["reason"].(string); strings.Contains(reason, dataDir) {
		t.Fatalf("warning 不得泄露本机路径: %q", reason)
	}

	// 超限输入 → 400（请求体超过 8 MiB）
	huge := bytes.Repeat([]byte("a"), 8<<20+1024)
	oversized := ut.PerformRequest(
		server.engine.Engine,
		http.MethodPost,
		"/api/work-libraries",
		&ut.Body{Body: bytes.NewReader(huge), Len: len(huge)},
		ut.Header{Key: "Content-Type", Value: "application/json"},
	)
	if oversized.Code != http.StatusBadRequest {
		t.Fatalf("超限请求体应 400，got %d", oversized.Code)
	}
}

// 删除契约：删库需要 expected_revision，删条目受引用保护。
func TestWorkLibraryDeleteContracts(t *testing.T) {
	application := newNoBookApplication(t, "")
	server := NewServer(application, "0")

	createResp := performJSONRequest(t, server, http.MethodPost, "/api/work-libraries", map[string]any{"name": "待删库"})
	var created struct {
		Library  map[string]any `json:"library"`
		Revision string         `json:"revision"`
	}
	decodeWorkLibraryResponse(t, createResp.Body.Bytes(), &created)
	libraryID, _ := created.Library["id"].(string)

	// 缺少 expected_revision → 400
	noRevision := performJSONRequest(t, server, http.MethodDelete, "/api/work-libraries/"+libraryID, nil)
	if noRevision.Code != http.StatusBadRequest {
		t.Fatalf("删库缺少 expected_revision 应 400，got %d", noRevision.Code)
	}
	// 错误 revision → 409
	stale := performJSONRequest(t, server, http.MethodDelete, "/api/work-libraries/"+libraryID+"?expected_revision=sha256:deadbeef", nil)
	if stale.Code != http.StatusConflict {
		t.Fatalf("删库 revision 不匹配应 409，got %d body=%s", stale.Code, stale.Body.String())
	}
	// 正确 revision → 200，且随后读取 404
	ok := performJSONRequest(t, server, http.MethodDelete, "/api/work-libraries/"+libraryID+"?expected_revision="+created.Revision, nil)
	if ok.Code != http.StatusOK {
		t.Fatalf("删库应成功，got %d body=%s", ok.Code, ok.Body.String())
	}
	gone := performJSONRequest(t, server, http.MethodGet, "/api/work-libraries/"+libraryID, nil)
	if gone.Code != http.StatusNotFound {
		t.Fatalf("删除后读取应 404，got %d", gone.Code)
	}

	// 条目引用保护：未级联 → 409 item_in_use（不是 revision_conflict）
	second := performJSONRequest(t, server, http.MethodPost, "/api/work-libraries", map[string]any{"name": "引用库"})
	var secondCreated struct {
		Library map[string]any `json:"library"`
	}
	decodeWorkLibraryResponse(t, second.Body.Bytes(), &secondCreated)
	secondID, _ := secondCreated.Library["id"].(string)

	heroResp := performJSONRequest(t, server, http.MethodPost, "/api/work-libraries/"+secondID+"/items", map[string]any{"type": "character", "name": "林冲"})
	otherResp := performJSONRequest(t, server, http.MethodPost, "/api/work-libraries/"+secondID+"/items", map[string]any{"type": "character", "name": "鲁智深"})
	var hero, other struct {
		Item map[string]any `json:"item"`
	}
	decodeWorkLibraryResponse(t, heroResp.Body.Bytes(), &hero)
	decodeWorkLibraryResponse(t, otherResp.Body.Bytes(), &other)
	heroID, _ := hero.Item["id"].(string)
	otherID, _ := other.Item["id"].(string)

	relResp := performJSONRequest(t, server, http.MethodPost, "/api/work-libraries/"+secondID+"/relations", map[string]any{
		"fromItemId": heroID, "toItemId": otherID, "kind": "ally", "label": "结义兄弟",
	})
	if relResp.Code != http.StatusCreated {
		t.Fatalf("建关系应成功: %d %s", relResp.Code, relResp.Body.String())
	}

	// 影响预览
	impactResp := performJSONRequest(t, server, http.MethodGet, "/api/work-libraries/"+secondID+"/items/"+heroID+"/impact", nil)
	if impactResp.Code != http.StatusOK {
		t.Fatalf("影响预览应 200，got %d", impactResp.Code)
	}
	var impact struct {
		Impact map[string]any `json:"impact"`
	}
	decodeWorkLibraryResponse(t, impactResp.Body.Bytes(), &impact)
	if len(testSliceValue(impact.Impact, "relations")) != 1 {
		t.Fatalf("影响预览应列出 1 条关系: %s", impactResp.Body.String())
	}

	// 未级联删除 → 409 item_in_use + 影响明细
	inUse := performJSONRequest(t, server, http.MethodDelete, "/api/work-libraries/"+secondID+"/items/"+heroID, nil)
	if inUse.Code != http.StatusConflict {
		t.Fatalf("被引用条目应 409，got %d body=%s", inUse.Code, inUse.Body.String())
	}
	var inUseBody struct {
		Code   string         `json:"code"`
		Impact map[string]any `json:"impact"`
	}
	decodeWorkLibraryResponse(t, inUse.Body.Bytes(), &inUseBody)
	if inUseBody.Code != "item_in_use" {
		t.Fatalf("被引用条目必须回 item_in_use 而不是 revision_conflict（否则前端会误判为并发冲突重试），got %q", inUseBody.Code)
	}
	if len(testSliceValue(inUseBody.Impact, "relations")) != 1 {
		t.Fatalf("拒绝删除时必须带回影响明细: %s", inUse.Body.String())
	}

	// 级联删除 → 200，关系被清理
	cascade := performJSONRequest(t, server, http.MethodDelete, "/api/work-libraries/"+secondID+"/items/"+heroID+"?cascade=true", nil)
	if cascade.Code != http.StatusOK {
		t.Fatalf("级联删除应成功，got %d body=%s", cascade.Code, cascade.Body.String())
	}
	var cascadeBody struct {
		RemovedRelationIDs []string `json:"removedRelationIds"`
	}
	decodeWorkLibraryResponse(t, cascade.Body.Bytes(), &cascadeBody)
	if len(cascadeBody.RemovedRelationIDs) != 1 {
		t.Fatalf("级联结果应说明清理了哪条关系: %s", cascade.Body.String())
	}
	finalResp := performJSONRequest(t, server, http.MethodGet, "/api/work-libraries/"+secondID, nil)
	var final struct {
		Library map[string]any `json:"library"`
	}
	decodeWorkLibraryResponse(t, finalResp.Body.Bytes(), &final)
	if len(testSliceValue(final.Library, "relations")) != 0 {
		t.Fatalf("级联后不应残留悬空关系: %s", finalResp.Body.String())
	}
}

// 词表下发：前端不再硬编码，避免“能选但不能存”。
func TestWorkLibraryVocabularyEndpoint(t *testing.T) {
	application := newNoBookApplication(t, "")
	server := NewServer(application, "0")
	resp := performJSONRequest(t, server, http.MethodGet, "/api/work-libraries/vocabulary", nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("词表 status = %d body=%s", resp.Code, resp.Body.String())
	}
	vocab := testMapValue(mustDecodeAny(t, resp.Body.Bytes()), "vocabulary")
	for _, key := range []string{"itemTypes", "loadModes", "origins", "sourceKinds", "relationKinds", "eventCategories", "purposes", "importanceLevels"} {
		values, _ := vocab[key].([]any)
		if len(values) == 0 {
			t.Fatalf("词表缺少 %s: %s", key, resp.Body.String())
		}
	}
}

func mustDecodeAny(t *testing.T, body []byte) any {
	t.Helper()
	var out any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("解析响应失败: %v body=%s", err, string(body))
	}
	return out
}
