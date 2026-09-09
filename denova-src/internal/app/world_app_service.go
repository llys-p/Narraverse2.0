package app

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"denova/internal/world"
)

// ErrWorldDataDirMissing 表示尚未配置全局 Denova 数据目录，无法落盘世界。
var ErrWorldDataDirMissing = errors.New("尚未配置 Denova 数据目录，无法存储世界")

// worldStore 在全局 cfg.DataDir()/worlds 下构造世界存储；世界跨书存在。
func (a *App) worldStore() (*world.Store, error) {
	if a == nil || a.cfg == nil || strings.TrimSpace(a.cfg.DataDir()) == "" {
		return nil, ErrWorldDataDirMissing
	}
	return world.NewStore(a.cfg.DataDir()), nil
}

// ListWorlds 扫描世界目录，返回摘要与损坏文件告警。
func (a *App) ListWorlds(ctx context.Context, status world.WorldStatus) (world.ListResult, error) {
	store, err := a.worldStore()
	if err != nil {
		return world.ListResult{Worlds: []world.Summary{}, Warnings: []world.LoadWarning{}}, err
	}
	return store.List(ctx, status)
}

// GetWorld 读取单个世界及其内容哈希 revision。
func (a *App) GetWorld(ctx context.Context, id string) (world.World, string, error) {
	store, err := a.worldStore()
	if err != nil {
		return world.World{}, "", err
	}
	return store.Get(ctx, id)
}

// CreateWorld 一次原子创建完整初始世界。
func (a *App) CreateWorld(ctx context.Context, in world.CreateInput) (world.World, string, error) {
	store, err := a.worldStore()
	if err != nil {
		return world.World{}, "", err
	}
	return store.Create(ctx, in)
}

// ReplaceWorld 以 expectedRevision 为基做整文档 CAS 替换。
func (a *App) ReplaceWorld(ctx context.Context, id, expectedRevision string, w world.World) (world.World, string, error) {
	store, err := a.worldStore()
	if err != nil {
		return world.World{}, "", err
	}
	if strings.TrimSpace(id) == "" {
		return world.World{}, "", fmt.Errorf("世界 id 不能为空")
	}
	return store.Replace(ctx, id, expectedRevision, w)
}

// ArchiveWorld 归档或恢复世界（撤销），同样走 CAS。
func (a *App) ArchiveWorld(ctx context.Context, id, expectedRevision string, archived bool) (world.World, string, error) {
	store, err := a.worldStore()
	if err != nil {
		return world.World{}, "", err
	}
	return store.Archive(ctx, id, expectedRevision, archived)
}
