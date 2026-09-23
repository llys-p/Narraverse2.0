package app

import (
	"context"

	"denova/internal/library"
	"denova/internal/libraryruntime"
)

// BindWorkLibraryRuntime 为一次模型运行建立作品设定库的临时读取授权
// （L3 计划 §8 B0 冻结契约的核心适配层）。
//
// 调用约束：consumer 与 scopeKey 由服务端调用方按真实运行归属派生
// （写作=task:<id>、游戏=story/turn、受控 iframe=frame 实例），绝不接受客户端
// 提交值；ManualItemIds 是用户本次显式授权的 manual 条目集合，L2 预览的
// autoItemIds 不进入运行授权。绑定失败显式返回错误，由调用方阻断模型启动
// （bind-before-start），不允许静默降级为无背景。
//
// 返回的 Run 由调用方持有：初始装配经 AssembleInitial 得到的临时输入只进入
// 当次模型输入；运行结束必须 Complete/Cancel（幂等）。本方法不写任何数据。
func (a *App) BindWorkLibraryRuntime(ctx context.Context, in libraryruntime.BindInput) (*libraryruntime.Run, error) {
	provider := func(ctx context.Context, libraryID string) (library.Library, string, error) {
		return a.GetWorkLibrary(ctx, libraryID)
	}
	return libraryruntime.Bind(ctx, in, provider, a.libraryMasterResolver())
}
