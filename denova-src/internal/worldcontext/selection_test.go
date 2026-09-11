package worldcontext

import (
	"encoding/json"
	"errors"
	"testing"

	"denova/internal/world"
)

func TestDecodeSelection_DefaultsAndEmptySlices(t *testing.T) {
	for _, raw := range []string{``, `null`, `{}`, `   `} {
		sel, err := DecodeSelection(json.RawMessage(raw))
		if err != nil {
			t.Fatalf("raw=%q 意外错误 %v", raw, err)
		}
		if sel.IncludeTone {
			t.Fatalf("raw=%q includeTone 默认应为 false", raw)
		}
		for name, got := range map[string][]string{
			"characterIds": sel.CharacterIDs, "locationIds": sel.LocationIDs, "factionIds": sel.FactionIDs,
			"timelineEntryIds": sel.TimelineEntryIDs, "bindingIds": sel.BindingIDs,
		} {
			if got == nil {
				t.Fatalf("raw=%q %s 必须是非 nil 空切片", raw, name)
			}
		}
		if sel.RuleIndexes == nil {
			t.Fatalf("raw=%q ruleIndexes 必须是非 nil", raw)
		}
	}
}

func TestDecodeSelection_UnknownFieldIsInvalidRequest(t *testing.T) {
	_, err := DecodeSelection(json.RawMessage(`{"characterIds":["c1"],"scopeKey":"x"}`))
	if CodeOf(err) != ErrInvalidRequest {
		t.Fatalf("未知字段应 invalid_request，got %v", err)
	}
}

func TestDecodeSelection_IncludeToneWrongType(t *testing.T) {
	_, err := DecodeSelection(json.RawMessage(`{"includeTone":"yes"}`))
	if CodeOf(err) != ErrInvalidRequest {
		t.Fatalf("includeTone 非 bool 应 invalid_request，got %v", err)
	}
}

func TestDecodeSelection_RuleIndexFraction(t *testing.T) {
	_, err := DecodeSelection(json.RawMessage(`{"ruleIndexes":[1.5]}`))
	if CodeOf(err) != ErrSelectionInvalid {
		t.Fatalf("小数下标应 selection_invalid，got %v", err)
	}
}

func TestDecodeSelection_RuleIndexNegative(t *testing.T) {
	// 负数是合法整数，归属/越界阶段拒绝。
	sel, err := DecodeSelection(json.RawMessage(`{"ruleIndexes":[-1]}`))
	if err != nil {
		t.Fatalf("解码阶段不应拒绝负数，got %v", err)
	}
	_, berr := BuildSnapshot(ConsumerWriting, baseRef(sel), testRevision, sampleWorld())
	if CodeOf(berr) != ErrSelectionInvalid {
		t.Fatalf("负规则下标应 selection_invalid，got %v", berr)
	}
}

func TestResolveSelection_UnknownEntityID(t *testing.T) {
	sel := Selection{CharacterIDs: []string{"c1", "ghost"}}
	_, err := BuildSnapshot(ConsumerWriting, baseRef(sel), testRevision, sampleWorld())
	de := mustDomainErr(t, err, ErrSelectionInvalid)
	if len(de.Invalid) != 1 || de.Invalid[0] != "ghost" {
		t.Fatalf("应回传安全非法 id 清单 [ghost]，got %#v", de.Invalid)
	}
}

func TestResolveSelection_EntityBindingViaBindingIDsRejected(t *testing.T) {
	sel := Selection{BindingIDs: []string{"b-char"}} // b-char 是 entity scope
	_, err := BuildSnapshot(ConsumerWriting, baseRef(sel), testRevision, sampleWorld())
	if CodeOf(err) != ErrSelectionInvalid {
		t.Fatalf("entity 绑定走 bindingIds 应拒绝，got %v", err)
	}
}

func TestResolveSelection_WorldBindingAllowed(t *testing.T) {
	sel := Selection{BindingIDs: []string{"b-world"}}
	snap := mustBuild(t, ConsumerWriting, baseRef(sel), sampleWorld())
	if len(snap.Materials) != 1 || snap.Materials[0].BindingID != "b-world" {
		t.Fatalf("world 绑定应入选 materials，got %#v", snap.Materials)
	}
	if snap.Materials[0].Scope != world.ScopeWorld {
		t.Fatalf("scope 应为 world，got %q", snap.Materials[0].Scope)
	}
}

func TestResolveSelection_DedupesAndOrdersByWorld(t *testing.T) {
	// 客户端乱序 + 重复；canonical 必须按 World 内顺序稳定排列。
	sel := Selection{CharacterIDs: []string{"c2", "c1", "c1"}, LocationIDs: []string{"l2", "l1"}}
	snap := mustBuild(t, ConsumerWriting, baseRef(sel), sampleWorld())
	gotC := snap.CanonicalSelection.CharacterIDs
	if len(gotC) != 2 || gotC[0] != "c1" || gotC[1] != "c2" {
		t.Fatalf("角色应按 world 顺序去重为 [c1 c2]，got %v", gotC)
	}
	gotL := snap.CanonicalSelection.LocationIDs
	if len(gotL) != 2 || gotL[0] != "l1" || gotL[1] != "l2" {
		t.Fatalf("地点应按 world 顺序为 [l1 l2]，got %v", gotL)
	}
}

func TestResolveSelection_RuleIndexOutOfRange(t *testing.T) {
	sel := Selection{RuleIndexes: []int{2}} // 只有 2 条规则，下标 2 越界
	_, err := BuildSnapshot(ConsumerWriting, baseRef(sel), testRevision, sampleWorld())
	if CodeOf(err) != ErrSelectionInvalid {
		t.Fatalf("越界规则下标应 selection_invalid，got %v", err)
	}
}

func TestResolveSelection_RuleIndexesAscending(t *testing.T) {
	sel := Selection{RuleIndexes: []int{1, 0, 1}}
	snap := mustBuild(t, ConsumerWriting, baseRef(sel), sampleWorld())
	got := snap.CanonicalSelection.RuleIndexes
	if len(got) != 2 || got[0] != 0 || got[1] != 1 {
		t.Fatalf("规则下标应去重升序 [0 1]，got %v", got)
	}
	if snap.Setting == nil || len(snap.Setting.Rules) != 2 ||
		snap.Setting.Rules[0] != "规则甲" || snap.Setting.Rules[1] != "规则乙" {
		t.Fatalf("setting.rules 按下标取原文，got %#v", snap.Setting)
	}
}

func mustDomainErr(t *testing.T, err error, want ErrorCode) *DomainError {
	t.Helper()
	if err == nil {
		t.Fatalf("期望错误 %s，实际 nil", want)
	}
	var de *DomainError
	if !errors.As(err, &de) {
		t.Fatalf("期望 *DomainError，got %T %v", err, err)
	}
	if de.Code != want {
		t.Fatalf("期望 %s，got %s", want, de.Code)
	}
	return de
}
