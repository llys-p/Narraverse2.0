package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"denova/config"
	"denova/internal/book"
	"github.com/cloudwego/eino/components/tool"
)

func TestConfigManagerBookOverviewCASAndRelationTools(t *testing.T) {
	ws := t.TempDir()
	tools, err := newConfigManagerTools(&config.Config{Workspace: ws}, config.ResolvedAgentToolSettings{LoreRead: true, LoreWrite: true})
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]tool.BaseTool{}
	for _, item := range tools {
		info, _ := item.Info(context.Background())
		byName[info.Name] = item
	}
	call := func(name, input string) (string, error) {
		item := byName[name]
		if item == nil {
			t.Fatalf("missing management tool: %s", name)
		}
		return item.(tool.InvokableTool).InvokableRun(context.Background(), input)
	}
	output, err := call("read_book_overview", `{}`)
	if err != nil || !strings.Contains(output, `"revision":"missing"`) {
		t.Fatalf("empty overview: %s %v", output, err)
	}
	if _, err = call("write_book_overview", `{"content":"## 世界概况\n水浒世界","base_revision":"missing"}`); err != nil {
		t.Fatal(err)
	}
	output, err = call("read_book_overview", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	var overview struct {
		Revision string `json:"revision"`
	}
	if err := json.Unmarshal([]byte(output), &overview); err != nil {
		t.Fatal(err)
	}
	missingContent, _ := json.Marshal(map[string]string{"base_revision": overview.Revision})
	if _, err = call("write_book_overview", string(missingContent)); err == nil {
		t.Fatal("omitted content must not implicitly clear the overview")
	}
	argsOverview, _ := json.Marshal(map[string]string{"content": "## 世界概况\n水浒世界更新", "base_revision": overview.Revision})
	receipt, err := call("write_book_overview", string(argsOverview))
	if err != nil {
		t.Fatal(err)
	}
	tracker := newMutationTracker()
	tracker.Observe(Event{Type: "tool_call", Data: map[string]any{"id": "overview-call", "name": "write_book_overview", "args": string(argsOverview)}})
	tracker.Observe(Event{Type: "tool_result", Data: map[string]any{"id": "overview-call", "name": "write_book_overview", "content": receipt}})
	mutations := tracker.Mutations()
	if len(mutations) != 1 || mutations[0].Target != bookOverviewToolPath || mutations[0].Workspace == "" || mutations[0].ChangeSetID == "" {
		t.Fatalf("overview change not tracked: %#v", mutations)
	}
	content, err := os.ReadFile(filepath.Join(ws, "setting", "book-overview.md"))
	if err != nil || string(content) != "## 世界概况\n水浒世界更新" {
		t.Fatalf("overview write: %s %v", content, err)
	}
	if _, err = call("write_book_overview", `{"content":"错误覆盖","base_revision":"missing"}`); err == nil {
		t.Fatal("stale overview accepted")
	}
	unchanged, _ := os.ReadFile(filepath.Join(ws, "setting", "book-overview.md"))
	if string(unchanged) != string(content) {
		t.Fatal("conflict overwrote overview")
	}
	s := book.NewLoreStore(ws)
	a, _ := s.Create(book.LoreItemInput{ID: "a", Name: "林冲", Type: "character", Content: "原文"})
	s.Create(book.LoreItemInput{ID: "b", Name: "鲁智深", Type: "character", Content: "原文二"})
	args, _ := json.Marshal(map[string]any{"message": "设置朋友关系", "items": []any{map[string]any{"id": "a", "base_revision": a.UpdatedAt, "relations": []any{map[string]any{"target_id": "b", "label": "好友"}}}}})
	if output, err = call("write_lore_relations", string(args)); err != nil || !strings.Contains(output, `item_ids: ["a"]`) {
		t.Fatalf("relation receipt: %s %v", output, err)
	}
	ids, _ := parseWriteLoreItemsToolResult("write_lore_relations", output)
	if len(ids) != 1 || ids[0] != a.ID {
		t.Fatalf("relation change did not expose mutation IDs: %#v", ids)
	}
	if output, err = call("read_lore_relations", `{"ids":["a","b"]}`); err != nil || !strings.Contains(output, `"label":"好友"`) || !strings.Contains(output, a.ID) {
		t.Fatalf("relations read: %s %v", output, err)
	}
	for _, name := range []string{"read_book_overview", "read_lore_relations"} {
		if ManifestForTool(name).Capability != config.AgentToolLoreRead {
			t.Fatalf("bad read permission: %s", name)
		}
	}
	for _, name := range []string{"write_book_overview", "write_lore_relations"} {
		if ManifestForTool(name).Capability != config.AgentToolLoreWrite {
			t.Fatalf("bad write permission: %s", name)
		}
	}
}
