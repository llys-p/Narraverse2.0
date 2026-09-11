package world

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestTimelineCategoryJSONStates(t *testing.T) {
	tests := []struct {
		name     string
		json     string
		category TimelineCategory
		display  TimelineCategory
		raw      []byte
	}{
		{name: "background", json: `{"id":"t1","order":1,"title":"x","category":"background"}`, category: TimelineBackground, display: TimelineBackground, raw: []byte(`"background"`)},
		{name: "historical", json: `{"id":"t1","order":1,"title":"x","category":"historical"}`, category: TimelineHistorical, display: TimelineHistorical, raw: []byte(`"historical"`)},
		{name: "planned", json: `{"id":"t1","order":1,"title":"x","category":"planned"}`, category: TimelinePlanned, display: TimelinePlanned, raw: []byte(`"planned"`)},
		{name: "canon", json: `{"id":"t1","order":1,"title":"x","category":"canon"}`, category: TimelineCanon, display: TimelineHistorical, raw: []byte(`"canon"`)},
		{name: "unknown", json: `{"id":"t1","order":1,"title":"x","category":"old-custom"}`, category: "old-custom", display: TimelineBackground, raw: []byte(`"old-custom"`)},
		{name: "empty", json: `{"id":"t1","order":1,"title":"x","category":""}`, category: "", display: TimelineBackground, raw: []byte(`""`)},
		{name: "null", json: `{"id":"t1","order":1,"title":"x","category":null}`, category: "", display: TimelineBackground, raw: []byte(`null`)},
		{name: "missing", json: `{"id":"t1","order":1,"title":"x"}`, category: "", display: TimelineBackground, raw: nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var entry TimelineEntry
			if err := json.Unmarshal([]byte(tt.json), &entry); err != nil {
				t.Fatal(err)
			}
			if entry.Category != tt.category {
				t.Fatalf("category = %q, want %q", entry.Category, tt.category)
			}
			if got := NormalizeTimelineCategoryForDisplay(entry.Category); got != tt.display {
				t.Fatalf("display category = %q, want %q", got, tt.display)
			}
			encoded, err := json.Marshal(entry)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(encoded, &fields); err != nil {
				t.Fatal(err)
			}
			gotRaw := fields["category"]
			if !bytes.Equal(gotRaw, tt.raw) {
				t.Fatalf("category raw = %s, want %s", gotRaw, tt.raw)
			}
		})
	}
}

func TestCreateDefaultsTimelineCategory(t *testing.T) {
	s := NewStore(t.TempDir())
	w, _, err := s.Create(ctx(), sampleInput())
	if err != nil {
		t.Fatal(err)
	}
	if w.Timeline[0].Category != TimelineBackground {
		t.Fatalf("created category = %q, want background", w.Timeline[0].Category)
	}
	got, _, err := s.Get(ctx(), w.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Timeline[0].Category != TimelineBackground {
		t.Fatalf("roundtrip category = %q, want background", got.Timeline[0].Category)
	}
}

func TestLegacyTimelineCategorySurvivesReplaceAndArchive(t *testing.T) {
	tests := []struct {
		name string
		raw  []byte
	}{
		{name: "canon", raw: []byte(`"canon"`)},
		{name: "unknown", raw: []byte(`"old-custom"`)},
		{name: "empty", raw: []byte(`""`)},
		{name: "null", raw: []byte(`null`)},
		{name: "missing", raw: nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := NewStore(t.TempDir())
			w, _, err := s.Create(ctx(), sampleInput())
			if err != nil {
				t.Fatal(err)
			}
			writeTimelineCategoryVariant(t, s, w, tt.raw)

			got, rev, err := s.Get(ctx(), w.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.Timeline[0].Category == TimelineBackground && tt.name == "canon" {
				t.Fatal("legacy canon was normalized in the stored object")
			}
			if _, _, err := s.Replace(ctx(), w.ID, rev, got); err != nil {
				t.Fatalf("replace unchanged legacy value: %v", err)
			}
			assertTimelineCategoryRaw(t, s, w.ID, tt.raw)

			_, rev, err = s.Get(ctx(), w.ID)
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := s.Archive(ctx(), w.ID, rev, true); err != nil {
				t.Fatalf("archive: %v", err)
			}
			assertTimelineCategoryRaw(t, s, w.ID, tt.raw)
		})
	}
}

func TestTimelineCategoryExplicitEditAndInjectionGuard(t *testing.T) {
	s := NewStore(t.TempDir())
	w, rev, err := s.Create(ctx(), sampleInput())
	if err != nil {
		t.Fatal(err)
	}
	got, rev, err := s.Get(ctx(), w.ID)
	if err != nil {
		t.Fatal(err)
	}
	got.Timeline[0].Category = TimelineHistorical
	if _, _, err := s.Replace(ctx(), w.ID, rev, got); err != nil {
		t.Fatalf("explicit category edit: %v", err)
	}
	assertTimelineCategoryRaw(t, s, w.ID, []byte(`"historical"`))

	got, rev, err = s.Get(ctx(), w.ID)
	if err != nil {
		t.Fatal(err)
	}
	got.Timeline[0].Category = TimelineCategory("forged-unknown")
	if _, _, err := s.Replace(ctx(), w.ID, rev, got); err == nil {
		t.Fatal("unknown category injection must be rejected")
	} else {
		var validation *ValidationError
		if !errors.As(err, &validation) {
			t.Fatalf("want ValidationError, got %T %v", err, err)
		}
	}
}

func TestCreateRejectsLegacyTimelineCategory(t *testing.T) {
	s := NewStore(t.TempDir())
	in := sampleInput()
	in.Timeline[0].Category = TimelineCanon
	if _, _, err := s.Create(ctx(), in); err == nil {
		t.Fatal("create must reject legacy category")
	}
}

func writeTimelineCategoryVariant(t *testing.T, s *Store, w World, raw []byte) {
	t.Helper()
	entry := &w.Timeline[0]
	entry.categoryState = timelineCategoryRawState{initialized: true, raw: append(json.RawMessage(nil), raw...)}
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		entry.Category = ""
	} else {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			t.Fatal(err)
		}
		entry.Category = TimelineCategory(value)
	}
	encoded, err := marshalWorld(&w)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.Root(), "world-"+w.ID+".json"), encoded, 0o644); err != nil {
		t.Fatal(err)
	}
}

func assertTimelineCategoryRaw(t *testing.T, s *Store, id string, want []byte) {
	t.Helper()
	content, err := os.ReadFile(filepath.Join(s.Root(), "world-"+id+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var worldFields struct {
		Timeline []map[string]json.RawMessage `json:"timeline"`
	}
	if err := json.Unmarshal(content, &worldFields); err != nil {
		t.Fatal(err)
	}
	got := worldFields.Timeline[0]["category"]
	if !bytes.Equal(got, want) {
		t.Fatalf("stored category raw = %s, want %s", got, want)
	}
}
