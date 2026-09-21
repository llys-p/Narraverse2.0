package app

import (
	"context"
	"strings"
	"testing"
)

// A3：无 Registry 的只读同字节装配——不创建/占用 runContext、不写 World、不改 revision。
func TestBuildWritingEphemeralWorld_NoRegistryNoWrite(t *testing.T) {
	a, svc, w, rev := writingSvcHarness(t)
	ctx := context.Background()
	ref := worldRef(w, rev)

	before := svc.WorldContextRegistryStats()
	ep, err := svc.BuildWritingEphemeralWorld(ctx, ref)
	if err != nil {
		t.Fatalf("BuildWritingEphemeralWorld 失败: %v", err)
	}
	after := svc.WorldContextRegistryStats()
	// 不创建 runContext，也不触碰 ProjectionBody LRU。
	if after.RunContexts != before.RunContexts || after.BodyEntries != before.BodyEntries {
		t.Fatalf("只读装配不得改变 Registry: before=%+v after=%+v", before, after)
	}
	if !ep.Present() {
		t.Fatal("应当携带世界背景")
	}
	content := ep.LeadingContent()
	if !strings.HasPrefix(content, "[World Background · Read Only]\n") {
		t.Fatalf("缺少冻结抬头: %q", content)
	}
	// identity 始终包含，selection 选择了 tone，故最终 ModelView 文本应同时含世界名与语气。
	if !strings.Contains(content, "测试世界") || !strings.Contains(content, "冷峻") {
		t.Fatalf("最终 ModelView 内容异常: %q", content)
	}

	// World 文件与 revision 前后不变（只读）。
	w2, rev2, err := a.GetWorld(ctx, w.ID)
	if err != nil {
		t.Fatalf("重新读取世界失败: %v", err)
	}
	if rev2 != rev {
		t.Fatalf("revision 被改变: before=%s after=%s", rev, rev2)
	}
	if w2.WorldSetting == nil || w2.WorldSetting.Tone != "冷峻" {
		t.Fatalf("World 内容被意外修改: %+v", w2.WorldSetting)
	}

	// 两次装配抬头与世界内容一致（同构造、确定性），且彼此独立。
	ep2, err := svc.BuildWritingEphemeralWorld(ctx, ref)
	if err != nil {
		t.Fatalf("第二次装配失败: %v", err)
	}
	if !strings.Contains(ep2.LeadingContent(), "测试世界") {
		t.Fatal("第二次装配内容异常")
	}
	if svc.WorldContextRegistryStats().RunContexts != before.RunContexts {
		t.Fatal("重复只读装配仍不得创建 runContext")
	}
}
