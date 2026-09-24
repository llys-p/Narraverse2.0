package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/cloudwego/eino/components/tool"

	"denova/config"
	"denova/internal/library"
	"denova/internal/libraryruntime"
)

// B2a：库按需读取工具与事件脱敏的验证（§8.5/§8.6）。
// 证据链：工具只经服务端绑定 Run 读取（真实库文件、跨库/未授权/禁用显式拒绝）；
// 工具结果事件在唯一脱敏点变成元数据（无正文、无 origin 路径）；
// 结果不跨轮持久化、不按文件读写工具归类。

// newLibraryToolTestRun 构造一个真实 libraryruntime 绑定（真实 Store、零 Master），
// 与 B1 集成测试同构：auto-1 可读、manual-1 已授权、manual-2 未授权、auto-off 禁用。
func newLibraryToolTestRun(t *testing.T) (*libraryruntime.Run, string) {
	t.Helper()
	dir := t.TempDir()
	store := library.NewStore(dir)
	ctx := context.Background()
	lib, _, err := store.Create(ctx, library.CreateInput{Name: "工具测试库"})
	if err != nil {
		t.Fatal(err)
	}
	disabled := false
	strPtr := func(s string) *string { return &s }
	for _, item := range []library.ItemInput{
		{ID: "auto-1", Name: "自动一", Type: "character", LoadMode: library.LoadModeAuto, Origin: library.OriginOriginal, Content: strPtr("AUTO-BODY-1 机密正文")},
		{ID: "manual-1", Name: "手动一", Type: "character", LoadMode: library.LoadModeManual, Origin: library.OriginOriginal, Content: strPtr("MANUAL-BODY-1 机密正文")},
		{ID: "manual-2", Name: "手动二", Type: "character", LoadMode: library.LoadModeManual, Origin: library.OriginOriginal, Content: strPtr("MANUAL-BODY-2 未授权正文")},
		{ID: "auto-off", Name: "禁用一", Type: "character", LoadMode: library.LoadModeAuto, Origin: library.OriginOriginal, Content: strPtr("OFF-BODY"), Enabled: &disabled},
	} {
		if _, _, err := store.CreateItem(ctx, lib.ID, item); err != nil {
			t.Fatal(err)
		}
	}
	_, revision, err := store.Get(ctx, lib.ID)
	if err != nil {
		t.Fatal(err)
	}
	run, err := libraryruntime.Bind(ctx, libraryruntime.BindInput{
		Consumer:         libraryruntime.ConsumerWriting,
		ScopeKey:         "task:library-tool-test",
		LibraryID:        lib.ID,
		ExpectedRevision: revision,
		ManualItemIDs:    []string{"manual-1"},
	}, func(ctx context.Context, libraryID string) (library.Library, string, error) {
		return store.Get(ctx, libraryID)
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(run.Complete)
	return run, revision
}

func TestNewLibraryReadToolsRequiresBoundRun(t *testing.T) {
	if _, err := newLibraryReadTools(nil); err == nil {
		t.Fatal("nil run must be rejected at construction time")
	}
}

func TestLibraryReadToolInvokesBoundRun(t *testing.T) {
	run, _ := newLibraryToolTestRun(t)
	tools, err := newLibraryReadTools(run)
	if err != nil || len(tools) != 1 {
		t.Fatalf("tools: %v %v", tools, err)
	}
	info, err := tools[0].Info(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Name; got != libraryReadItemToolName {
		t.Fatalf("tool name mismatch: %q", got)
	}
	invokable, ok := tools[0].(tool.InvokableTool)
	if !ok {
		t.Fatalf("read tool must be invokable: %#v", tools[0])
	}

	// 授权目录内 auto 条目：模型拿到完整 ItemView JSON（含正文）。
	out, err := invokable.InvokableRun(context.Background(), `{"itemId":"auto-1"}`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "AUTO-BODY-1 机密正文") {
		t.Fatalf("model must receive full item body: %s", out)
	}
	// 已授权 manual 条目可读。
	if _, err := invokable.InvokableRun(context.Background(), `{"itemId":"manual-1"}`); err != nil {
		t.Fatalf("granted manual read failed: %v", err)
	}
	// 未授权 manual / 禁用条目 / 未知条目：显式稳定错误码（eino InferTool 会在错误文本外
	// 包一层 LocalFunc 前缀，稳定码 "denied: " 必须仍随文本回给模型）。
	for _, tc := range []struct {
		args     string
		wantCode string
	}{
		{`{"itemId":"manual-2"}`, "denied"},
		{`{"itemId":"auto-off"}`, "denied"},
		{`{"itemId":"unknown-9"}`, "denied"},
	} {
		_, err := invokable.InvokableRun(context.Background(), tc.args)
		if err == nil || !strings.Contains(err.Error(), tc.wantCode+": ") {
			t.Fatalf("args=%s want stable code %q in error text, got %v", tc.args, tc.wantCode, err)
		}
	}
}

func TestLibraryReadToolEventDataRedactsBody(t *testing.T) {
	success := `{"schemaVersion":1,"itemId":"auto-1","name":"自动一","type":"character","loadMode":"auto","origin":{"kind":"original"},"sourceRevision":"rev-123","content":"AUTO-BODY-1 机密正文"}`
	notice, meta := libraryReadToolEventData(success)
	if strings.Contains(notice, "AUTO-BODY-1") {
		t.Fatalf("notice must not carry body text: %q", notice)
	}
	if !strings.Contains(notice, "自动一") {
		t.Fatalf("notice should carry item name for UI: %q", notice)
	}
	if meta["itemId"] != "auto-1" || meta["name"] != "自动一" || meta["loadMode"] != "auto" || meta["sourceRevision"] != "rev-123" {
		t.Fatalf("meta must carry item metadata only: %#v", meta)
	}
	if bytes, ok := meta["bytes"].(int); !ok || bytes <= 0 {
		t.Fatalf("meta must carry measured bytes: %#v", meta)
	}
	for key := range meta {
		if key == "content" || key == "origin" {
			t.Fatalf("meta must not expose body or origin: %#v", meta)
		}
	}

	// 失败：错误文本是“稳定码: 消息”，meta 只携带 errorCode 与字节数。
	denied := "denied: item is unknown or disabled: manual-2"
	notice, meta = libraryReadToolEventData(denied)
	if meta["errorCode"] != "denied" {
		t.Fatalf("failure meta must carry stable code: %#v", meta)
	}
	if strings.Contains(notice, "AUTO-BODY") {
		t.Fatalf("failure notice must not carry body: %q", notice)
	}
	// 框架包装前缀下（eino LocalFunc）errorCode 仍稳定，notice 只保留码后消息。
	wrapped := "[LocalFunc] failed to invoke tool, toolName=read_library_item, err=denied: item is not readable on demand under this grant: manual-2"
	notice, meta = libraryReadToolEventData(wrapped)
	if meta["errorCode"] != "denied" {
		t.Fatalf("wrapped failure must still yield stable errorCode: %#v", meta)
	}
	if !strings.Contains(notice, "item is not readable on demand") || strings.Contains(notice, "LocalFunc") {
		t.Fatalf("wrapped failure notice must carry only the stable-code message: %q", notice)
	}

	// 超长错误输入被有界截断（防模型超长输入回显进事件）。
	long := "denied: " + strings.Repeat("x", 400)
	_, meta = libraryReadToolEventData(long)
	if b, ok := meta["bytes"].(int); !ok || b != len(long) {
		t.Fatalf("bytes still measured: %#v", meta)
	}
	notice, _ = libraryReadToolEventData(long)
	if len(notice) > 250 {
		t.Fatalf("notice must be bounded: %d", len(notice))
	}
}

func TestLibraryReadToolPersistenceIsolation(t *testing.T) {
	// §8.5：库读取工具结果不跨轮持久化进 Session 上下文（IDE 与互动模式都不保留）。
	for _, kind := range []string{config.AgentKindIDE, config.AgentKindInteractiveStory} {
		if retainToolContextAcrossTurns(libraryReadItemToolName, ToolResultContextPolicy{AgentKind: kind}) {
			t.Fatalf("library read results must never persist across turns (kind=%s)", kind)
		}
	}
	// 归类为受控库读取，不落入文件系统读写或旧 lore 通道。
	manifest := ManifestForTool(libraryReadItemToolName)
	if manifest.Source != ToolSourceLibrary {
		t.Fatalf("manifest source mismatch: %#v", manifest)
	}
	if manifest.MutatesWorkspace {
		t.Fatalf("library read must not mutate workspace: %#v", manifest)
	}
	// 事件名识别（大小写/空白容错）。
	if !isLibraryReadToolName("  Read_Library_Item ") {
		t.Fatal("tool name matching must be case-insensitive")
	}
	if isLibraryReadToolName("read_lore_items") {
		t.Fatal("lore tools must not be confused with the library tool")
	}
}

func TestIDEToolsFactoryWithLibraryMountsNoLoreTools(t *testing.T) {
	// §8.6 通道 2：library 模式挂载 read_library_item，绝不挂载旧 lore 工具，
	// 新旧两套设定不得同时可读；插图工具保持。
	run, _ := newLibraryToolTestRun(t)
	cfg := &config.Config{Workspace: t.TempDir()}
	factory := ideToolsFactoryWithLibrary(cfg, run)
	tools, err := factory(config.ResolvedAgentToolSettings{})
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, t2 := range tools {
		info, err := t2.Info(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		names[info.Name] = true
	}
	if !names[libraryReadItemToolName] {
		t.Fatalf("library mode must mount %s: %#v", libraryReadItemToolName, names)
	}
	for _, banned := range []string{"read_lore_items", "list_lore_items", "write_lore_items"} {
		if names[banned] {
			t.Fatalf("library mode must not mount legacy lore tool %q: %#v", banned, names)
		}
	}
	if names[generateImageToolName] {
		// 插图工具保持挂载（与 lore 通道无关）。
	} else {
		t.Fatalf("illustration tool must stay mounted: %#v", names)
	}

	// 对照组：普通工厂仍挂载 lore 工具（旧请求行为不变）。
	legacyTools, err := ideToolsFactory(cfg)(config.ResolvedAgentToolSettings{})
	if err != nil {
		t.Fatal(err)
	}
	sawLore := false
	for _, t2 := range legacyTools {
		info, err := t2.Info(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if info.Name == "read_lore_items" {
			sawLore = true
		}
	}
	if !sawLore {
		t.Fatalf("legacy factory must keep lore tools for bare/legacy requests: %#v", legacyTools)
	}
}
