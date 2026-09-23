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
	"denova/internal/librarycontext"
)

func TestLibraryPreviewMasterReadOnly(t *testing.T) {
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
	if asset.Summary.Availability != "usable" {
		t.Fatalf("fixture not usable: %#v", asset.Summary.Pipeline)
	}
	ctx := context.Background()
	l, _, err := a.CreateWorkLibrary(ctx, library.CreateInput{Name: "测试"})
	if err != nil {
		t.Fatal(err)
	}
	_, rev, err := a.CreateWorkLibraryItem(ctx, l.ID, library.ItemInput{Name: "林冲", Type: "character", Origin: "reference", LoadMode: "resident", Source: &library.SourceRef{Kind: "master", ID: asset.Item.MasterItemID, Revision: asset.Summary.MasterRevision}})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "libraries", "library-"+l.ID+".json")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	p, err := a.PreviewWorkLibraryContext(ctx, l.ID, librarycontext.Request{ExpectedRevision: rev})
	if err != nil || len(p.Loaded) != 1 {
		t.Fatalf("%v %#v", err, p)
	}
	if !strings.Contains(p.Loaded[0].Content, "风雪山神庙") || strings.Contains(p.Loaded[0].Content, "forbidden") {
		t.Fatal("wrong source projection")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("preview wrote library")
	}
	current, _ := master.GetAsset(asset.Item.MasterItemID)
	if current.Summary.MasterRevision != asset.Summary.MasterRevision {
		t.Fatal("preview changed master")
	}
}

func TestLibraryPreviewWithoutWorkspaceDoesNotGuessCWD(t *testing.T) {
	cfg := &config.Config{}
	cfg.SetDataDir(t.TempDir())
	a := &App{cfg: cfg}
	ctx := context.Background()
	l, _, err := a.CreateWorkLibrary(ctx, library.CreateInput{Name: "无书测试"})
	if err != nil {
		t.Fatal(err)
	}
	_, rev, err := a.CreateWorkLibraryItem(ctx, l.ID, library.ItemInput{Name: "引用", Type: "character", Origin: "reference", LoadMode: "resident", Source: &library.SourceRef{Kind: "master", ID: "missing", Revision: "sha256:stored"}})
	if err != nil {
		t.Fatal(err)
	}
	p, err := a.PreviewWorkLibraryContext(ctx, l.ID, librarycontext.Request{ExpectedRevision: rev})
	if err != nil || len(p.Loaded) != 0 || len(p.Issues) != 1 || p.Issues[0].Code != "source_unavailable" {
		t.Fatalf("%v %#v", err, p)
	}
}
