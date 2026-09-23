package library

import (
	"context"
	"errors"
	"testing"
)

func TestReferencePartialUpdatePreservesOrigin(t *testing.T) {
	store := newTestStore(t)
	l, _ := mustCreateLibrary(t, store, "引用库")
	ctx := context.Background()
	item := mustCreateItem(t, store, l.ID, ItemInput{
		Name: "原件", Type: TypeCharacter, Origin: OriginReference,
		Source:  &SourceRef{Kind: SourceKindMaster, ID: "master-1", Revision: "sha256:abc"},
		Content: strPtr("原文"),
	})
	updated, _, err := store.UpdateItem(ctx, l.ID, ItemInput{ID: item.ID, BaseUpdatedAt: item.UpdatedAt, LoadMode: LoadModeManual})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Origin != OriginReference || updated.Content != item.Content || updated.Source.ID != item.Source.ID {
		t.Fatalf("partial settings update changed reference ownership: %#v", updated)
	}
	_, revision, err := store.Get(ctx, l.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = store.UpdateItem(ctx, l.ID, ItemInput{ID: item.ID, BaseUpdatedAt: updated.UpdatedAt, Content: strPtr("不可改写")})
	if !errors.Is(err, ErrReferenceReadOnly) {
		t.Fatalf("omitting origin bypassed read-only protection: %v", err)
	}
	_, after, err := store.Get(ctx, l.ID)
	if err != nil || after != revision {
		t.Fatalf("rejected update changed data: %v", err)
	}
}
