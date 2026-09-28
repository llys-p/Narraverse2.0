package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"denova/config"
	"denova/internal/book"
	"denova/internal/library"
	"denova/internal/libraryruntime"
)

// TestBindWorkLibraryRuntimeEphemeralZeroWrite 用真实 App + 真实 Master 解析走完
// 绑定→初始装配→按需读取→幂等清理全链：库文件与 Master 原件全程零写入，
// 正文只出现在装配/读取的返回值（当次模型输入）里。
func TestBindWorkLibraryRuntimeEphemeralZeroWrite(t *testing.T) {
	root := t.TempDir()
	cfg := &config.Config{}
	cfg.SetDataDir(root)
	a := &App{cfg: cfg, workspace: filepath.Join(root, "projects", "test-book")}
	master := book.NewMasterLibraryStore(a.workspace)
	ingested, err := master.Ingest(book.MasterIngestInput{
		Filename: "card.json", Data: []byte("test-source"), SourceKind: "user_upload", AdventureWorkspace: a.workspace,
		Items: []book.MasterItemInput{{SourceEntryIdentity: "character:0", RecordKind: "character_template", SemanticType: "character", Name: "林冲",
			Original: map[string]any{"private": "do-not-expose"}, Fields: map[string]book.MasterFieldInput{
				"character.name":          {Text: "林冲", Risk: "safe"},
				"character.description":   {Text: "风雪山神庙", Risk: "safe"},
				"character.system_prompt": {Text: "forbidden-system-prompt", Risk: "safe"},
			}}}})
	if err != nil {
		t.Fatal(err)
	}
	asset, err := master.GetAsset(ingested.Items[0].MasterItemID)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	l, _, err := a.CreateWorkLibrary(ctx, library.CreateInput{Name: "运行授权测试"})
	if err != nil {
		t.Fatal(err)
	}
	masterRef := &library.SourceRef{Kind: "master", ID: asset.Item.MasterItemID, Revision: asset.Summary.MasterRevision}
	for _, item := range []library.ItemInput{
		{ID: "item-resident", Name: "常驻一", Type: "character", Origin: "original", LoadMode: "resident", Content: strPtrItem("常驻正文")},
		{ID: "item-auto-ref", Name: "自动引用", Type: "character", Origin: "reference", LoadMode: "auto", Source: masterRef},
		{ID: "item-manual-1", Name: "手动一", Type: "character", Origin: "original", LoadMode: "manual", Content: strPtrItem("手动正文")},
		{ID: "item-manual-2", Name: "手动二", Type: "character", Origin: "original", LoadMode: "manual", Content: strPtrItem("未授权正文")},
	} {
		if _, _, err := a.CreateWorkLibraryItem(ctx, l.ID, item); err != nil {
			t.Fatal(err)
		}
	}
	_, currentRevision, err := a.GetWorkLibrary(ctx, l.ID)
	if err != nil {
		t.Fatal(err)
	}
	libraryPath := filepath.Join(root, "libraries", "library-"+l.ID+".json")
	beforeLibrary, err := os.ReadFile(libraryPath)
	if err != nil {
		t.Fatal(err)
	}

	// 绑定：身份服务端派生；manual 授权只含用户显式选择。
	run, err := a.BindWorkLibraryRuntime(ctx, libraryruntime.BindInput{
		Consumer:         libraryruntime.ConsumerWriting,
		ScopeKey:         "task:runtime-test",
		LibraryID:        l.ID,
		ExpectedRevision: currentRevision,
		ManualItemIDs:    []string{"item-manual-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	initial, err := run.AssembleInitial(ctx)
	if err != nil || !initial.Present() {
		t.Fatalf("assemble: %v", err)
	}
	for _, want := range []string{"常驻正文", "手动正文", "自动引用"} {
		if !strings.Contains(initial.LeadingText(), want) {
			t.Fatalf("initial input missing %q", want)
		}
	}
	if strings.Contains(initial.LeadingText(), "forbidden") || strings.Contains(initial.LeadingText(), "未授权正文") {
		t.Fatal("initial input leaked forbidden or ungranted content")
	}
	// 按需读取 reference 条目：受控 Master 投影，禁止字段不跨界。
	res, err := run.ReadOnDemand(ctx, "item-auto-ref")
	if err != nil || !strings.Contains(res.ModelText, "风雪山神庙") || strings.Contains(res.ModelText, "forbidden") {
		t.Fatalf("on-demand reference read: res=%v err=%v", res, err)
	}
	// 未授权 manual 显式 denied；未授权内容不进任何输入。
	if _, err := run.ReadOnDemand(ctx, "item-manual-2"); libraryruntime.CodeOf(err) != libraryruntime.ErrDenied {
		t.Fatalf("ungranted manual must be denied, got %v", err)
	}
	run.Complete()
	run.Complete()

	afterLibrary, err := os.ReadFile(libraryPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(beforeLibrary) != string(afterLibrary) {
		t.Fatal("runtime authorization wrote the library")
	}
	current, err := master.GetAsset(asset.Item.MasterItemID)
	if err != nil || current.Summary.MasterRevision != asset.Summary.MasterRevision {
		t.Fatal("runtime authorization changed the master asset")
	}
	if st := run.Status(); st.State != "completed" {
		t.Fatalf("terminal state must be explicit: %#v", st)
	}
}

// TestBindWorkLibraryRuntimeBlockingErrors 证明绑定期失败阻断启动：
// revision 漂移与不受信 consumer 都不会产生 Run，也不存在静默降级路径。
func TestBindWorkLibraryRuntimeBlockingErrors(t *testing.T) {
	root := t.TempDir()
	cfg := &config.Config{}
	cfg.SetDataDir(root)
	a := &App{cfg: cfg, workspace: filepath.Join(root, "projects", "test-book")}
	ctx := context.Background()
	l, _, err := a.CreateWorkLibrary(ctx, library.CreateInput{Name: "阻断测试"})
	if err != nil {
		t.Fatal(err)
	}
	_, currentRevision, err := a.GetWorkLibrary(ctx, l.ID)
	if err != nil {
		t.Fatal(err)
	}
	// revision 不匹配：阻断，不静默 bare。
	if run, err := a.BindWorkLibraryRuntime(ctx, libraryruntime.BindInput{Consumer: libraryruntime.ConsumerWriting,
		ScopeKey: "task:t", LibraryID: l.ID, ExpectedRevision: "stale-rev"}); run != nil ||
		libraryruntime.CodeOf(err) != libraryruntime.ErrRevisionConflict {
		t.Fatalf("want revision_conflict without run, got run=%v err=%v", run, err)
	}
	// 客户端/模型伪造身份：阻断。
	if run, err := a.BindWorkLibraryRuntime(ctx, libraryruntime.BindInput{Consumer: "client-forged",
		ScopeKey: "task:t", LibraryID: l.ID, ExpectedRevision: currentRevision}); run != nil ||
		libraryruntime.CodeOf(err) != libraryruntime.ErrConsumerNotTrusted {
		t.Fatalf("want consumer_not_trusted without run, got run=%v err=%v", run, err)
	}
}

func strPtrItem(s string) *string { return &s }
