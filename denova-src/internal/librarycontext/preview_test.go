package librarycontext

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"denova/internal/library"
)

func fixture() library.Library {
	return library.Library{ID: "abcdefghijklmnop", Name: "测试库", Items: []library.Item{
		{ID: "r", Name: "同名", Type: "rule", Enabled: true, LoadMode: "resident", Origin: "original", Content: "常驻正文"},
		{ID: "a", Name: "同名", Type: "character", Enabled: true, LoadMode: "auto", Origin: "original", Content: "按需秘密正文"},
		{ID: "m", Name: "手动", Type: "location", Enabled: true, LoadMode: "manual", Origin: "adaptation", Content: "用户片段"},
		{ID: "off", Name: "禁用", Enabled: false, LoadMode: "resident", Origin: "original", Content: "禁用正文"},
	}}
}

func TestModesAndReadOnly(t *testing.T) {
	l := fixture()
	before, _ := json.Marshal(l)
	p, err := Build(context.Background(), l, "rev", Request{ExpectedRevision: "rev"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Loaded) != 1 || p.Loaded[0].ItemID != "r" || len(p.Catalog.Items) != 1 || p.Catalog.Items[0].ItemID != "a" {
		t.Fatalf("wrong plan: %#v", p)
	}
	data, _ := json.Marshal(p)
	if strings.Contains(string(data), "按需秘密正文") || strings.Contains(string(data), "禁用正文") || strings.Contains(string(data), "用户片段") {
		t.Fatal("unselected body leaked")
	}
	p, err = Build(context.Background(), l, "rev", Request{ExpectedRevision: "rev", AutoItemIDs: []string{"a", "a"}, ManualItemIDs: []string{"m"}}, nil)
	if err != nil || len(p.Loaded) != 3 {
		t.Fatalf("explicit reads: %v %#v", err, p)
	}
	after, _ := json.Marshal(l)
	if string(before) != string(after) {
		t.Fatal("mutated input")
	}
}

func TestRejectsInvalidSelectionAndRevision(t *testing.T) {
	for _, id := range []string{"off", "unknown", "m", "r"} {
		_, err := Build(context.Background(), fixture(), "rev", Request{ExpectedRevision: "rev", AutoItemIDs: []string{id}}, nil)
		if !errors.Is(err, ErrSelectionInvalid) {
			t.Fatalf("%s accepted: %v", id, err)
		}
	}
	_, err := Build(context.Background(), fixture(), "rev", Request{ExpectedRevision: "old"}, nil)
	if !errors.Is(err, ErrRevisionConflict) {
		t.Fatal(err)
	}
}

func TestSourceVersionAndNoFallback(t *testing.T) {
	l := fixture()
	l.Items[0].Origin = "reference"
	l.Items[0].Source = &library.SourceRef{Kind: "master", ID: "asset", Revision: "old"}
	calls := 0
	resolve := func(_ context.Context, source library.SourceRef) (ResolvedSource, error) {
		calls++
		return ResolvedSource{Revision: "new", Content: "原件"}, nil
	}
	p, err := Build(context.Background(), l, "rev", Request{ExpectedRevision: "rev"}, resolve)
	if err != nil || len(p.Loaded) != 0 || len(p.Issues) != 1 || p.Issues[0].Code != "source_changed" || calls != 1 {
		t.Fatalf("%v %#v", err, p)
	}
	l.Items[0].Source.Revision = "new"
	p, err = Build(context.Background(), l, "rev", Request{ExpectedRevision: "rev"}, resolve)
	if err != nil || p.Loaded[0].Content != "原件" || p.Loaded[0].SourceRevision != "new" {
		t.Fatalf("%v %#v", err, p)
	}
	l.Items[0].Origin = "adaptation"
	p, err = Build(context.Background(), l, "rev", Request{ExpectedRevision: "rev"}, nil)
	if err != nil || p.Loaded[0].Content != "常驻正文" {
		t.Fatal("adaptation changed")
	}
}

func TestClosureDoesNotExpandReadScope(t *testing.T) {
	l := fixture()
	l.Items[0].Event = &library.EventDetail{ParticipantItemIDs: []string{"a", "m"}, LocationItemID: "m"}
	l.Relations = []library.Relation{{ID: "ra", FromItemID: "r", ToItemID: "a"}, {ID: "rm", FromItemID: "r", ToItemID: "m"}}
	p, err := Build(context.Background(), l, "rev", Request{ExpectedRevision: "rev", AutoItemIDs: []string{"a"}}, nil)
	if err != nil || len(p.Relations) != 1 || p.Relations[0].ID != "ra" {
		t.Fatalf("%v %#v", err, p)
	}
	for _, item := range p.Loaded {
		if item.ItemID == "r" && (!reflect.DeepEqual(item.Event.ParticipantItemIDs, []string{"a"}) || item.Event.LocationItemID != "") {
			t.Fatal("event leaked hidden references")
		}
	}
	if len(l.Items[0].Event.ParticipantItemIDs) != 2 {
		t.Fatal("mutated source event")
	}
}

func TestBudgetRejectsWholePreviewAndPagination(t *testing.T) {
	l := fixture()
	l.Items[0].Content = strings.Repeat("大", 20000)
	_, err := Build(context.Background(), l, "rev", Request{ExpectedRevision: "rev"}, nil)
	if !errors.Is(err, ErrBudgetExceeded) {
		t.Fatal(err)
	}
	l = fixture()
	l.Items = append(l.Items, library.Item{ID: "z", Enabled: true, LoadMode: "auto", Origin: "original"})
	p, err := Build(context.Background(), l, "rev", Request{ExpectedRevision: "rev", CatalogLimit: 1}, nil)
	if err != nil || p.Catalog.Total != 2 || p.Catalog.NextOffset == nil || *p.Catalog.NextOffset != 1 {
		t.Fatalf("%v %#v", err, p)
	}
}

func TestSourceFailureMatrix(t *testing.T) {
	for _, tc := range []struct {
		name    string
		source  *library.SourceRef
		resolve Resolver
		want    string
	}{
		{"missing identity", nil, nil, "source_unverified"},
		{"unsupported", &library.SourceRef{Kind: "file", ID: "x", Revision: "v"}, nil, "source_unsupported"},
		{"locator", &library.SourceRef{Kind: "master", ID: "x", Revision: "v", Locator: "note"}, nil, "source_unsupported"},
		{"missing", &library.SourceRef{Kind: "master", ID: "x", Revision: "v"}, func(context.Context, library.SourceRef) (ResolvedSource, error) {
			return ResolvedSource{}, ErrSourceMissing
		}, "source_missing"},
		{"unavailable", &library.SourceRef{Kind: "master", ID: "x", Revision: "v"}, func(context.Context, library.SourceRef) (ResolvedSource, error) {
			return ResolvedSource{}, errors.New("D:/private/source.json")
		}, "source_unavailable"},
		{"empty revision", &library.SourceRef{Kind: "master", ID: "x", Revision: "v"}, func(context.Context, library.SourceRef) (ResolvedSource, error) {
			return ResolvedSource{Content: "unverified"}, nil
		}, "source_unverified"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			l := fixture()
			l.Items[0].Origin = "reference"
			l.Items[0].Source = tc.source
			p, err := Build(context.Background(), l, "rev", Request{ExpectedRevision: "rev"}, tc.resolve)
			if err != nil || len(p.Loaded) != 0 || len(p.Issues) != 1 || p.Issues[0].Code != tc.want {
				t.Fatalf("%v %#v", err, p)
			}
			data, _ := json.Marshal(p)
			if strings.Contains(string(data), "D:/private") || strings.Contains(string(data), "常驻正文") {
				t.Fatal("source failure leaked cached data/path")
			}
		})
	}
}

func TestCatalogNeverResolvesUnselectedReferenceAndBudgetIsExact(t *testing.T) {
	l := fixture()
	l.Items[1].Origin = "reference"
	l.Items[1].Source = &library.SourceRef{Kind: "master", ID: "a", Revision: "v"}
	resolve := func(context.Context, library.SourceRef) (ResolvedSource, error) {
		t.Fatal("directory fetched body")
		return ResolvedSource{}, nil
	}
	p, err := Build(context.Background(), l, "rev", Request{ExpectedRevision: "rev"}, resolve)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(p)
	if p.Budget.Bytes != len(data) {
		t.Fatalf("budget %d bytes, actual %d", p.Budget.Bytes, len(data))
	}
	p.Loaded[0].Fields["mutated"] = "x"
	if l.Items[0].Fields["mutated"] != "" {
		t.Fatal("aliased fields")
	}
}
