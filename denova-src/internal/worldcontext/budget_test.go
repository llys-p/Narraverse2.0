package worldcontext

import (
	"strings"
	"testing"
)

func TestEstimateTokensGoldenSamples(t *testing.T) {
	cases := []struct {
		name string
		text string
		want int
	}{
		{"abc", "abc", 9},
		{"a*100", strings.Repeat("a", 100), 33},
		{"你好", "你好", 10},
		{"你好世界", "你好世界", 12},
		{"Hello 世界", "Hello 世界", 12},
		{"emoji", "😀😀", 10},
		{"折叠空行", "a\n\n\n\nb", 9},
	}
	for _, tc := range cases {
		got := EstimateTokens(tc.text, 1) // sections 固定为 1
		if got != tc.want {
			t.Fatalf("%s: want %d got %d", tc.name, tc.want, got)
		}
	}
}

func TestNormalizeForEstimate(t *testing.T) {
	got := NormalizeForEstimate("  hello \t\r\n\r\n\r\nworld  \r\n")
	want := "hello\nworld"
	if got != want {
		t.Fatalf("规范化错误: got %q want %q", got, want)
	}
	// 连续空行折叠为单个。
	if NormalizeForEstimate("a\n\n\n\nb") != "a\nb" {
		t.Fatal("连续空行应折叠为单个换行")
	}
}

func TestEffectiveModelBudget(t *testing.T) {
	if b, small := EffectiveModelBudget(4096); !small || b != 0 {
		t.Fatalf("窗口=4096 应判定过小，got b=%d small=%v", b, small)
	}
	if b, small := EffectiveModelBudget(4097); small || b != 1 {
		t.Fatalf("窗口=4097 有效预算应为 1，got b=%d small=%v", b, small)
	}
	if b, _ := EffectiveModelBudget(5000); b != 904 {
		t.Fatalf("窗口=5000 有效预算应为 904，got %d", b)
	}
	if b, _ := EffectiveModelBudget(999999); b != MaxEstimatedTokens {
		t.Fatalf("超大窗口应封顶 12000，got %d", b)
	}
}

func TestCheckTokenBudget_WindowTooSmallDegradable(t *testing.T) {
	mv := minimalModelView("x")
	_, err := CheckTokenBudget(mv, 4096)
	de := mustDomainErr(t, err, ErrBudgetExceeded)
	if de.Layer != "consumer_window" {
		t.Fatalf("窗口过小应标记 consumer_window，got %q", de.Layer)
	}
}

func TestCheckTokenBudget_WithinBudget(t *testing.T) {
	mv := minimalModelView("abc")
	est, err := CheckTokenBudget(mv, 16096) // effective = 12000
	if err != nil {
		t.Fatalf("小上下文不应超预算: %v", err)
	}
	if est != EstimateModelViewTokens(mv) {
		t.Fatal("返回估算值应与 EstimateModelViewTokens 一致")
	}
}

func TestCountSections(t *testing.T) {
	if got := CountSections(false, 0, 0, 0, 0, 0, 0); got != 1 {
		t.Fatalf("仅 identity 应为 1，got %d", got)
	}
	if got := CountSections(true, 2, 0, 1, 0, 0, 3); got != 5 {
		t.Fatalf("identity+setting+char+faction+sources 应为 5，got %d", got)
	}
}

func TestSnapshotAndBodyByteBudget(t *testing.T) {
	snap := mustBuild(t, ConsumerWriting, baseRef(fullSelection()), sampleWorld())
	if err := CheckSnapshotBudget(snap); err != nil {
		t.Fatalf("正常 Snapshot 不应超字节预算: %v", err)
	}
	body, err := ProjectModelBody(snap)
	if err != nil {
		t.Fatal(err)
	}
	if err := CheckProjectionBodyBudget(body); err != nil {
		t.Fatalf("正常 Body 不应超预算: %v", err)
	}
	mv, err := MaterializeModelView(body, ConsumerWriting, make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	if err := CheckFinalModelViewBudget(mv); err != nil {
		t.Fatalf("正常 ModelView 不应超预算: %v", err)
	}
}

func TestFinalModelViewRuneCap(t *testing.T) {
	mv := minimalModelView(strings.Repeat("界", MaxModelRunes+1))
	err := CheckFinalModelViewBudget(mv)
	de := mustDomainErr(t, err, ErrBudgetExceeded)
	if de.Layer != string(LayerModelRunes) {
		t.Fatalf("应标记 model_runes 层，got %q", de.Layer)
	}
}

func TestFinalModelViewRuneBoundaryEqual(t *testing.T) {
	// 恰好等于 rune 上限必须通过（用 ASCII，避免先撞 96KiB 字节层；name/sources 置空使总码位正好 48000）。
	mv := minimalModelView(strings.Repeat("a", MaxModelRunes))
	mv.Identity.Name = ""
	mv.Sources = []ModelSource{}
	if err := CheckFinalModelViewBudget(mv); err != nil {
		t.Fatalf("恰好等于上限应通过: %v", err)
	}
}

func minimalModelView(summary string) *ModelView {
	return &ModelView{
		SchemaVersion: SchemaVersion,
		Identity:      Identity{Name: "n", Summary: summary},
		Characters:    []ModelCharacter{},
		Locations:     []ModelLocation{},
		Factions:      []ModelFaction{},
		Timeline:      []ModelTimelineEntry{},
		Materials:     []ModelMaterial{},
		Sources:       []ModelSource{{Ref: "x", Kind: SourceIdentity, Label: "n"}},
	}
}
