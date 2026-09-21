//go:build windows

package securityprobe

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"testing"
)

const migrationVersion = "narraverse-origin-migration/v1"

var migrationPrefixes = []string{"adventureAI_", "narraverse:", "og_ai_"}

type migrationEntry struct {
	Key   string `json:"key"`
	Value any    `json:"value"`
}

type migrationPackage struct {
	Version      string            `json:"version"`
	LocalStorage map[string]string `json:"localStorage"`
	IndexedDB    []migrationEntry  `json:"indexedDB"`
}

type migrationStore struct {
	LocalStorage map[string]string
	IndexedDB    map[string]any
	Manifest     string
	Incomplete   bool
}

func buildMigrationPackage(local map[string]string, indexed map[string]any) migrationPackage {
	filtered := make(map[string]string)
	for key, value := range local {
		for _, prefix := range migrationPrefixes {
			if strings.HasPrefix(key, prefix) {
				filtered[key] = value
				break
			}
		}
	}
	keys := make([]string, 0, len(indexed))
	for key := range indexed {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	entries := make([]migrationEntry, 0, len(keys))
	for _, key := range keys {
		entries = append(entries, migrationEntry{Key: key, Value: indexed[key]})
	}
	return migrationPackage{Version: migrationVersion, LocalStorage: filtered, IndexedDB: entries}
}

func migrationDigest(pkg migrationPackage) string {
	raw, _ := json.Marshal(pkg)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func applyMigration(target *migrationStore, pkg migrationPackage, failAfter int) error {
	if target.Manifest != "" || len(target.LocalStorage) > 0 || len(target.IndexedDB) > 0 {
		return errors.New("target_not_empty")
	}
	stagedLocal := make(map[string]string, len(pkg.LocalStorage))
	stagedIDB := make(map[string]any, len(pkg.IndexedDB))
	writes := 0
	for key, value := range pkg.LocalStorage {
		if failAfter >= 0 && writes == failAfter {
			target.Incomplete = true
			return errors.New("injected_failure")
		}
		stagedLocal[key] = value
		writes++
	}
	for _, entry := range pkg.IndexedDB {
		if failAfter >= 0 && writes == failAfter {
			target.Incomplete = true
			return errors.New("injected_failure")
		}
		stagedIDB[entry.Key] = entry.Value
		writes++
	}
	target.LocalStorage = stagedLocal
	target.IndexedDB = stagedIDB
	target.Manifest = migrationDigest(pkg)
	target.Incomplete = false
	return nil
}

func TestMigrationContract_AllowlistAndFullNarraverseStore(t *testing.T) {
	sourceLocal := map[string]string{
		"adventureAI_state":         "state",
		"adventureAI_state_backup":  "backup",
		"narraverse:module4:state":  "module4",
		"og_ai_preferences":         "prefs",
		"unrelated-private-setting": "do-not-copy",
	}
	sourceIDB := map[string]any{
		"state":                         map[string]any{"chapter": float64(7)},
		"state_bak":                     map[string]any{"chapter": float64(6)},
		"conversationArchive:v1:a:meta": map[string]any{"turns": float64(3)},
	}
	pkg := buildMigrationPackage(sourceLocal, sourceIDB)
	if _, copied := pkg.LocalStorage["unrelated-private-setting"]; copied {
		t.Fatal("unrelated localStorage key was copied")
	}
	if len(pkg.LocalStorage) != 4 || len(pkg.IndexedDB) != len(sourceIDB) {
		t.Fatalf("migration selection mismatch: local=%d idb=%d", len(pkg.LocalStorage), len(pkg.IndexedDB))
	}
	if sourceLocal["adventureAI_state"] != "state" || len(sourceIDB) != 3 {
		t.Fatal("building package mutated source data")
	}
}

func TestMigrationContract_EmptyTargetAppliesWithMatchingDigest(t *testing.T) {
	pkg := buildMigrationPackage(
		map[string]string{"adventureAI_state": "state"},
		map[string]any{"conversationArchive:v1:a:meta": map[string]any{"turns": float64(3)}},
	)
	target := &migrationStore{}
	if err := applyMigration(target, pkg, -1); err != nil {
		t.Fatalf("apply migration: %v", err)
	}
	if target.Manifest != migrationDigest(pkg) || target.Incomplete {
		t.Fatalf("manifest mismatch or incomplete: %#v", target)
	}
	if target.LocalStorage["adventureAI_state"] != "state" {
		t.Fatal("localStorage payload missing")
	}
	if _, ok := target.IndexedDB["conversationArchive:v1:a:meta"]; !ok {
		t.Fatal("conversation archive payload missing")
	}
}

func TestMigrationContract_NonEmptyTargetIsNeverOverwritten(t *testing.T) {
	pkg := buildMigrationPackage(map[string]string{"adventureAI_state": "new"}, nil)
	target := &migrationStore{LocalStorage: map[string]string{"adventureAI_state": "existing"}}
	if err := applyMigration(target, pkg, -1); err == nil || err.Error() != "target_not_empty" {
		t.Fatalf("expected target_not_empty, got %v", err)
	}
	if target.LocalStorage["adventureAI_state"] != "existing" || target.Manifest != "" {
		t.Fatal("conflicting target was modified")
	}
}

func TestMigrationContract_FailureLeavesNoLoadablePartialData(t *testing.T) {
	pkg := buildMigrationPackage(
		map[string]string{"adventureAI_state": "state", "narraverse:module4:state": "module4"},
		map[string]any{"state": map[string]any{"chapter": float64(7)}},
	)
	target := &migrationStore{}
	if err := applyMigration(target, pkg, 1); err == nil || err.Error() != "injected_failure" {
		t.Fatalf("expected injected failure, got %v", err)
	}
	if !target.Incomplete || target.Manifest != "" || len(target.LocalStorage) != 0 || len(target.IndexedDB) != 0 {
		t.Fatalf("partial migration became loadable: %#v", target)
	}
}

func TestMigrationContract_DigestDetectsAnyPayloadChange(t *testing.T) {
	original := buildMigrationPackage(map[string]string{"adventureAI_state": "state"}, map[string]any{"state": "one"})
	changed := buildMigrationPackage(map[string]string{"adventureAI_state": "changed"}, map[string]any{"state": "one"})
	if migrationDigest(original) == migrationDigest(changed) {
		t.Fatal("digest did not detect changed migration payload")
	}
}
