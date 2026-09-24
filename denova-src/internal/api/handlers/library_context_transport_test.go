package handlers

import (
	"errors"
	"strings"
	"testing"

	"denova/internal/worldcontext"
)

// B2a（§8.1/§8.4）：library_context 传输层冻结契约测试。
// 覆盖：字段解码与结构推断、background_source 三值声明、与 world_context/analysis_handle
// 互斥（background_source_conflict，禁止优先级吞并）、越权字段精确拒绝、
// 形状校验（空 ID/空条目/未知字段/非法类型）、context-analysis 策略拒绝 library 交接。

// libraryCtxBody 组一个最小合法 library 请求体。
func libraryCtxBody(extra string) []byte {
	body := `{"message":"m","library_context":{"libraryId":"lib-1","expectedRevision":"rev-1","manualItemIds":["item-1"," item-2 "]}}`
	if extra == "" {
		return []byte(body)
	}
	return []byte(body[:len(body)-1] + "," + extra + "}")
}

// domainErrOf 提取领域错误并断言错误码。
func domainErrOf(t *testing.T, err error, wantCode worldcontext.ErrorCode, wantFieldContains string) {
	t.Helper()
	var domainErr *worldcontext.DomainError
	if !errors.As(err, &domainErr) {
		t.Fatalf("want *worldcontext.DomainError, got %v", err)
	}
	if domainErr.Code != wantCode {
		t.Fatalf("error code mismatch: want %q got %q (field=%s)", wantCode, domainErr.Code, domainErr.Field)
	}
	if wantFieldContains != "" && !strings.Contains(domainErr.Field, wantFieldContains) {
		t.Fatalf("error field mismatch: want contains %q got %q", wantFieldContains, domainErr.Field)
	}
}

// 1) 成功路径：字段解析 + manualItemIds 去空白 + 结构推断 library。
func TestLibraryContextTransportDecodeAndInference(t *testing.T) {
	_, rt, err := decodeChatRequestBody(libraryCtxBody(""), PolicyChat)
	if err != nil {
		t.Fatalf("library_context 请求应解码成功: %v", err)
	}
	if !rt.HasLibraryContext() || rt.LibraryRef == nil {
		t.Fatalf("library_context 必须被分离: %+v", rt)
	}
	if rt.LibraryRef.LibraryID != "lib-1" || rt.LibraryRef.ExpectedRevision != "rev-1" {
		t.Fatalf("library ref 字段解析错误: %+v", rt.LibraryRef)
	}
	if len(rt.LibraryRef.ManualItemIDs) != 2 || rt.LibraryRef.ManualItemIDs[1] != "item-2" {
		t.Fatalf("manualItemIds 必须去空白: %+v", rt.LibraryRef.ManualItemIDs)
	}
	if rt.BackgroundSource != BackgroundSourceLibrary {
		t.Fatalf("缺省时必须结构推断为 library: %q", rt.BackgroundSource)
	}
	if rt.HasWorldContext() || rt.HasAnalysisHandle {
		t.Fatalf("library 请求不应携带 world 控制字段: %+v", rt)
	}

	// 结构推断的另外两支：world 载体 → legacy；全无 → none。
	worldBody := []byte(`{"message":"m","world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{}}}`)
	if _, rt, err := decodeChatRequestBody(worldBody, PolicyChat); err != nil || rt.BackgroundSource != BackgroundSourceLegacy {
		t.Fatalf("world 载体缺省应推断 legacy: err=%v source=%q", err, rt.BackgroundSource)
	}
	if _, rt, err := decodeChatRequestBody([]byte(`{"message":"m"}`), PolicyChat); err != nil || rt.BackgroundSource != BackgroundSourceNone {
		t.Fatalf("裸请求缺省应推断 none: err=%v source=%q", err, rt.BackgroundSource)
	}
}

// 2) 显式声明三值合法：legacy+world / library+library_context / none 裸请求。
func TestLibraryContextTransportExplicitBackgroundSource(t *testing.T) {
	if _, rt, err := decodeChatRequestBody([]byte(`{"message":"m","background_source":"legacy","world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{}}}`), PolicyChat); err != nil || rt.BackgroundSource != BackgroundSourceLegacy {
		t.Fatalf("显式 legacy 应成功: err=%v source=%q", err, rt.BackgroundSource)
	}
	if _, rt, err := decodeChatRequestBody([]byte(`{"message":"m","background_source":"library","library_context":{"libraryId":"lib-1","expectedRevision":"rev-1"}}`), PolicyChat); err != nil || rt.BackgroundSource != BackgroundSourceLibrary {
		t.Fatalf("显式 library 应成功: err=%v source=%q", err, rt.BackgroundSource)
	}
	if _, rt, err := decodeChatRequestBody([]byte(`{"message":"m","background_source":"none"}`), PolicyChat); err != nil || rt.BackgroundSource != BackgroundSourceNone {
		t.Fatalf("显式 none 应成功: err=%v source=%q", err, rt.BackgroundSource)
	}
	// null 与空串视为未声明（等价缺省推断）。
	if _, rt, err := decodeChatRequestBody([]byte(`{"message":"m","background_source":null}`), PolicyChat); err != nil || rt.BackgroundSource != BackgroundSourceNone {
		t.Fatalf("null 声明视为缺省: err=%v source=%q", err, rt.BackgroundSource)
	}
	if _, rt, err := decodeChatRequestBody([]byte(`{"message":"m","background_source":""}`), PolicyChat); err != nil || rt.BackgroundSource != BackgroundSourceNone {
		t.Fatalf("空串声明视为缺省: err=%v source=%q", err, rt.BackgroundSource)
	}
	// 非法值：非枚举字符串 / 非字符串类型。
	if _, _, err := decodeChatRequestBody([]byte(`{"message":"m","background_source":"both"}`), PolicyChat); err == nil {
		t.Fatal("非枚举 background_source 必须拒绝")
	} else {
		domainErrOf(t, err, worldcontext.ErrInvalidRequest, "background_source")
	}
	if _, _, err := decodeChatRequestBody([]byte(`{"message":"m","background_source":123}`), PolicyChat); err == nil {
		t.Fatal("非字符串 background_source 必须拒绝")
	}
}

// 3) 互斥拒绝：library_context 与 world_context / analysis_handle 同现 →
// background_source_conflict，禁止任何优先级吞并。
func TestLibraryContextTransportConflict(t *testing.T) {
	world := `"world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{}}`
	if _, _, err := decodeChatRequestBody(libraryCtxBody(world), PolicyChat); err == nil {
		t.Fatal("library+world_context 必须冲突")
	} else {
		domainErrOf(t, err, BackgroundSourceConflictCode, "library_context")
	}

	handle := `"analysis_handle":"` + repeatHandle(32) + `"`
	if _, _, err := decodeChatRequestBody(libraryCtxBody(handle), PolicyChat); err == nil {
		t.Fatal("library+analysis_handle 必须冲突")
	} else {
		domainErrOf(t, err, BackgroundSourceConflictCode, "library_context")
	}

	// legacy 显式声明携带 library 载体 → 冲突。
	if _, _, err := decodeChatRequestBody([]byte(`{"message":"m","background_source":"legacy","library_context":{"libraryId":"lib-1","expectedRevision":"rev-1"}}`), PolicyChat); err == nil {
		t.Fatal("legacy+library_context 必须冲突")
	} else {
		domainErrOf(t, err, BackgroundSourceConflictCode, "background_source")
	}
}

// 4) 一致性拒绝：library 声明无载体 / none 声明带字段。
func TestLibraryContextTransportDeclarationConsistency(t *testing.T) {
	if _, _, err := decodeChatRequestBody([]byte(`{"message":"m","background_source":"library"}`), PolicyChat); err == nil {
		t.Fatal("library 声明无 library_context 必须拒绝")
	} else {
		domainErrOf(t, err, worldcontext.ErrInvalidRequest, "background_source")
	}
	if _, _, err := decodeChatRequestBody([]byte(`{"message":"m","background_source":"none","world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{}}}`), PolicyChat); err == nil {
		t.Fatal("none 声明携带 world 字段必须拒绝")
	} else {
		domainErrOf(t, err, worldcontext.ErrInvalidRequest, "background_source")
	}
	if _, _, err := decodeChatRequestBody(libraryCtxBody(`"background_source":"none"`), PolicyChat); err == nil {
		t.Fatal("none 声明携带 library 字段必须拒绝")
	}
}

// 5) 越权与形状校验：运行身份字段在 library_context 子树精确拒绝。
func TestLibraryContextTransportForbiddenAndShape(t *testing.T) {
	for _, key := range []string{"consumer", "scopeKey", "runContextId", "taskId"} {
		body := []byte(`{"message":"m","library_context":{"libraryId":"lib-1","expectedRevision":"rev-1","` + key + `":"x"}}`)
		if _, _, err := decodeChatRequestBody(body, PolicyChat); err == nil {
			t.Fatalf("越权字段 %s 必须拒绝", key)
		} else {
			domainErrOf(t, err, worldcontext.ErrInvalidRequest, "library_context."+key)
		}
	}
	// 顶层越权字段同样拒绝。
	if _, _, err := decodeChatRequestBody([]byte(`{"message":"m","library_context":{"libraryId":"lib-1","expectedRevision":"rev-1"},"consumer":"writing"}`), PolicyChat); err == nil {
		t.Fatal("顶层 consumer 必须拒绝")
	}

	// 未知字段 / 非对象 / 空 ID / 空条目。
	if _, _, err := decodeChatRequestBody([]byte(`{"message":"m","library_context":{"libraryId":"lib-1","expectedRevision":"rev-1","fingerprint":"x"}}`), PolicyChat); err == nil {
		t.Fatal("未知字段必须拒绝")
	} else {
		domainErrOf(t, err, worldcontext.ErrInvalidRequest, "library_context.fingerprint")
	}
	if _, _, err := decodeChatRequestBody([]byte(`{"message":"m","library_context":"lib-1"}`), PolicyChat); err == nil {
		t.Fatal("非对象 library_context 必须拒绝")
	}
	if _, _, err := decodeChatRequestBody([]byte(`{"message":"m","library_context":{"expectedRevision":"rev-1"}}`), PolicyChat); err == nil {
		t.Fatal("空 libraryId 必须拒绝")
	} else {
		domainErrOf(t, err, worldcontext.ErrInvalidRequest, "library_context.libraryId")
	}
	if _, _, err := decodeChatRequestBody([]byte(`{"message":"m","library_context":{"libraryId":"lib-1"}}`), PolicyChat); err == nil {
		t.Fatal("空 expectedRevision 必须拒绝")
	} else {
		domainErrOf(t, err, worldcontext.ErrInvalidRequest, "library_context.expectedRevision")
	}
	if _, _, err := decodeChatRequestBody([]byte(`{"message":"m","library_context":{"libraryId":"lib-1","expectedRevision":"rev-1","manualItemIds":[" "]}}`), PolicyChat); err == nil {
		t.Fatal("manualItemIds 空条目必须拒绝")
	} else {
		domainErrOf(t, err, worldcontext.ErrInvalidRequest, "library_context.manualItemIds")
	}
	// library_context: null 等同未携带（旧请求兼容）。
	if _, rt, err := decodeChatRequestBody([]byte(`{"message":"m","library_context":null}`), PolicyChat); err != nil || rt.HasLibraryContext() || rt.BackgroundSource != BackgroundSourceNone {
		t.Fatalf("null library_context 等同未携带: err=%v rt=%+v", err, rt)
	}
}

// 6) context-analysis 策略：library 背景（显式与推断）一律拒绝（§8.3 库预览走 L2 preview 端点）。
func TestLibraryContextTransportContextAnalysisPolicy(t *testing.T) {
	if _, _, err := decodeChatRequestBody(libraryCtxBody(`"background_source":"library"`), PolicyContextAnalysis); err == nil {
		t.Fatal("context-analysis 显式 library 必须拒绝")
	} else {
		domainErrOf(t, err, worldcontext.ErrInvalidRequest, "library_context")
	}
	if _, _, err := decodeChatRequestBody(libraryCtxBody(""), PolicyContextAnalysis); err == nil {
		t.Fatal("context-analysis 推断 library 必须拒绝")
	} else {
		domainErrOf(t, err, worldcontext.ErrInvalidRequest, "library_context")
	}
}

// 7) B2a 修正轮：显式声明标记（BackgroundSourceExplicit）必须区分“客户端显式声明”
// 与“缺省结构推断”——app 层只有显式 none 才关闭旧 Lore 注入。
func TestLibraryContextTransportBackgroundSourceExplicitFlag(t *testing.T) {
	cases := []struct {
		name       string
		body       string
		wantSource string
		wantFlag   bool
	}{
		{"显式 none", `{"message":"m","background_source":"none"}`, BackgroundSourceNone, true},
		{"未声明裸请求（推断 none）", `{"message":"m"}`, BackgroundSourceNone, false},
		{"显式 legacy", `{"message":"m","background_source":"legacy","world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{}}}`, BackgroundSourceLegacy, true},
		{"world 载体（推断 legacy）", `{"message":"m","world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{}}}`, BackgroundSourceLegacy, false},
		{"显式 library", `{"message":"m","background_source":"library","library_context":{"libraryId":"lib-1","expectedRevision":"rev-1"}}`, BackgroundSourceLibrary, true},
		{"library 载体（推断 library）", string(libraryCtxBody("")), BackgroundSourceLibrary, false},
	}
	for _, tc := range cases {
		_, rt, err := decodeChatRequestBody([]byte(tc.body), PolicyChat)
		if err != nil {
			t.Fatalf("%s: 解码失败: %v", tc.name, err)
		}
		if rt.BackgroundSource != tc.wantSource {
			t.Fatalf("%s: source=%q want %q", tc.name, rt.BackgroundSource, tc.wantSource)
		}
		if rt.BackgroundSourceExplicit != tc.wantFlag {
			t.Fatalf("%s: explicit=%v want %v", tc.name, rt.BackgroundSourceExplicit, tc.wantFlag)
		}
	}
}

// 8) B2a 修正轮（缺口①）：lore_references 是旧 Lore 注入通道，library / 显式 none
// 模式与其同现即 background_source_conflict；未声明/legacy 请求保持原行为（旧请求兼容）。
func TestLibraryContextTransportLoreReferencesConflict(t *testing.T) {
	// 显式 library + lore_references → 冲突。
	if _, _, err := decodeChatRequestBody(libraryCtxBody(`"background_source":"library","lore_references":["hero"]`), PolicyChat); err == nil {
		t.Fatal("显式 library + lore_references 必须冲突")
	} else {
		domainErrOf(t, err, BackgroundSourceConflictCode, "lore_references")
	}
	// 推断 library（未声明来源）+ lore_references → 冲突（新背景模式不叠加旧 Lore）。
	if _, _, err := decodeChatRequestBody(libraryCtxBody(`"lore_references":["hero"]`), PolicyChat); err == nil {
		t.Fatal("推断 library + lore_references 必须冲突")
	} else {
		domainErrOf(t, err, BackgroundSourceConflictCode, "lore_references")
	}
	// 显式 none + lore_references → 冲突。
	if _, _, err := decodeChatRequestBody([]byte(`{"message":"m","background_source":"none","lore_references":["hero"]}`), PolicyChat); err == nil {
		t.Fatal("显式 none + lore_references 必须冲突")
	} else {
		domainErrOf(t, err, BackgroundSourceConflictCode, "lore_references")
	}
	// 未声明裸请求 + lore_references → 通过（旧请求兼容：推断 none ≠ 显式 none）。
	if _, rt, err := decodeChatRequestBody([]byte(`{"message":"m","lore_references":["hero"]}`), PolicyChat); err != nil {
		t.Fatalf("未声明请求携带 lore_references 必须保持兼容: %v", err)
	} else if rt.BackgroundSourceExplicit {
		t.Fatal("未声明请求 explicit 必须为 false")
	}
	// 显式 legacy + lore_references → 通过。
	if _, _, err := decodeChatRequestBody([]byte(`{"message":"m","background_source":"legacy","world_context":{"worldId":"w","expectedWorldRevision":"r","selection":{}},"lore_references":["hero"]}`), PolicyChat); err != nil {
		t.Fatalf("显式 legacy + lore_references 必须保持兼容: %v", err)
	}
	// 空数组等价未携带：显式 none 不因空 lore_references 被拒。
	if _, _, err := decodeChatRequestBody([]byte(`{"message":"m","background_source":"none","lore_references":[]}`), PolicyChat); err != nil {
		t.Fatalf("空 lore_references 不构成冲突: %v", err)
	}
}
