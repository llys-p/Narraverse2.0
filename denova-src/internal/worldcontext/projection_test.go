package worldcontext

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
	"testing"
)

func fullSelection() Selection {
	return Selection{
		IncludeTone:      true,
		RuleIndexes:      []int{0},
		CharacterIDs:     []string{"c1", "c2"},
		LocationIDs:      []string{"l1"},
		FactionIDs:       []string{"f1"},
		TimelineEntryIDs: []string{"t2"},
		BindingIDs:       []string{"b-world"},
	}
}

func buildBody(t *testing.T) (*Snapshot, *ProjectionBody) {
	t.Helper()
	snap := mustBuild(t, ConsumerWriting, baseRef(fullSelection()), sampleWorld())
	body, err := ProjectModelBody(snap)
	if err != nil {
		t.Fatalf("ProjectModelBody: %v", err)
	}
	return snap, body
}

func TestProjectForUI_KeepsInternalIDsAndSourceTable(t *testing.T) {
	snap, _ := buildBody(t)
	ui := ProjectForUI(snap)
	if ui.IsDraftPreview {
		t.Fatal("isDraftPreview 必须恒为 false")
	}
	if ui.RevisionLabel == "" {
		t.Fatal("revisionLabel 不应为空")
	}
	if _, ok := ui.SourceTable["character:c1"]; !ok {
		t.Fatal("sourceTable 应含 character:c1 槽位")
	}
	e, ok := ui.SourceTable["material:b-world"]
	if !ok || e.MasterItemID != "m-world-1" {
		t.Fatalf("世界资料槽位应带 masterItemId，got %#v ok=%v", e, ok)
	}
	// UI 允许内部 id 与 omissions。
	if len(ui.Omissions) != len(snap.Omissions) {
		t.Fatal("UIView 必须保留 omissions")
	}
}

func TestModelView_StripsInternalIDs(t *testing.T) {
	_, body := buildBody(t)
	mv, err := MaterializeModelView(body, ConsumerWriting, bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	raw, err := json.Marshal(mv)
	if err != nil {
		t.Fatal(err)
	}
	s := string(raw)
	for _, banned := range []string{
		`"c1"`, `"c2"`, `"f1"`, `"l1"`, `"b-char"`, `"b-world"`, `"m-world-1"`,
		"bindingId", "masterItemId", "factionId", "locationId", "omissions",
		"headquartersLocationId", "targetCharacterId", "worldId", "runSalt", "scopeKey",
	} {
		if strings.Contains(s, banned) {
			t.Fatalf("ModelView 不得出现内部字段/值 %s；JSON=%s", banned, s)
		}
	}
}

func TestModelView_ResolvesLabels(t *testing.T) {
	_, body := buildBody(t)
	if len(body.Characters) != 2 {
		t.Fatalf("应 2 角色，got %d", len(body.Characters))
	}
	c1 := body.Characters[0]
	if c1.FactionLabel != "白塔" || c1.LocationLabel != "北境城" {
		t.Fatalf("跨实体引用应解析为展示名，got %#v", c1)
	}
	if len(c1.Relationships) != 1 || c1.Relationships[0].TargetLabel != "陈二" {
		t.Fatalf("关系目标应解析为陈二，got %#v", c1.Relationships)
	}
	f := body.Factions[0]
	if f.HeadquartersLabel != "北境城" {
		t.Fatalf("总部应解析为北境城，got %q", f.HeadquartersLabel)
	}
}

func TestModelView_ArraysAlwaysPresent(t *testing.T) {
	// 空选择：identity 恒在，六个数组必须输出 []，可选标量不输出键。
	w := sampleWorld()
	w.Tagline, w.Genre, w.Summary = "", "", ""
	snap := mustBuild(t, ConsumerWriting, baseRef(Selection{}), w)
	body, err := ProjectModelBody(snap)
	if err != nil {
		t.Fatal(err)
	}
	mv, err := MaterializeModelView(body, ConsumerWriting, bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(mv)
	s := string(raw)
	for _, arr := range []string{
		`"characters":[]`, `"locations":[]`, `"factions":[]`,
		`"timeline":[]`, `"materials":[]`, `"sources":[`,
	} {
		if !strings.Contains(s, arr) {
			t.Fatalf("缺少恒在数组 %s；JSON=%s", arr, s)
		}
	}
	if strings.Contains(s, "tagline") || strings.Contains(s, "null") {
		t.Fatalf("空可选标量不应输出键/null；JSON=%s", s)
	}
	if mv.Setting != nil {
		t.Fatal("空选择不应有 setting")
	}
}

var base64URLRe = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

func TestSourceRef_Properties(t *testing.T) {
	_, body := buildBody(t)
	saltA := bytes.Repeat([]byte{0xAB}, 32)
	saltB := bytes.Repeat([]byte{0xCD}, 32)

	mvA1, err := MaterializeModelView(body, ConsumerWriting, saltA)
	if err != nil {
		t.Fatal(err)
	}
	mvA2, _ := MaterializeModelView(body, ConsumerWriting, saltA)
	mvB, _ := MaterializeModelView(body, ConsumerWriting, saltB)

	refsA1 := map[string]bool{}
	for _, src := range mvA1.Sources {
		if !base64URLRe.MatchString(src.Ref) {
			t.Fatalf("sourceRef 必须是 22 字符 base64url，got %q", src.Ref)
		}
		if src.Ref == "m-world-1" || strings.Contains(src.Ref, "b-world") {
			t.Fatal("sourceRef 不得是 masterItemId/bindingId 的可逆编码")
		}
		refsA1[src.Ref] = true
	}
	// 同 run 稳定。
	for i := range mvA1.Sources {
		if mvA1.Sources[i].Ref != mvA2.Sources[i].Ref {
			t.Fatal("同 runSalt 的 sourceRef 必须稳定")
		}
	}
	// 跨 run 不可复现。
	for i := range mvA1.Sources {
		if mvA1.Sources[i].Ref == mvB.Sources[i].Ref {
			t.Fatal("不同 runSalt 的 sourceRef 必须不同")
		}
	}
}

func TestMaterialize_RejectsBadSalt(t *testing.T) {
	_, body := buildBody(t)
	for _, n := range []int{0, 16, 31, 33} {
		if _, err := MaterializeModelView(body, ConsumerWriting, bytes.Repeat([]byte{1}, n)); CodeOf(err) != ErrProjectionFailed {
			t.Fatalf("salt 长度 %d 应 projection_failed，got %v", n, err)
		}
	}
}

func TestProjectionBody_DeterministicAndSourceNeutral(t *testing.T) {
	snap := mustBuild(t, ConsumerWriting, baseRef(fullSelection()), sampleWorld())
	b1, err := ProjectModelBody(snap)
	if err != nil {
		t.Fatal(err)
	}
	b2, err := ProjectModelBody(snap)
	if err != nil {
		t.Fatal(err)
	}
	r1, _ := json.Marshal(b1)
	r2, _ := json.Marshal(b2)
	if !bytes.Equal(r1, r2) {
		t.Fatal("同一 Snapshot 的 Body 必须字节一致")
	}
	if len(r1) == 0 {
		t.Fatal("body 不应为空")
	}
	// Body 的 JSON 形态不得含 per-run 随机量。
	if strings.Contains(string(r1), "runSalt") {
		t.Fatal("Body 不得含 runSalt")
	}
}
