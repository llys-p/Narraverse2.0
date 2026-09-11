package app

import (
	"context"
	"testing"
	"time"

	"denova/internal/agent"
)

// waitFinished 轮询等待任务 goroutine 完全退出。
func waitFinished(t *testing.T, task *Task, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if task.Finished() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("任务未在 %v 内结束，status=%s", within, task.Status())
}

// assertRunNotCalled 断言执行体在短时间内没有被调用。
func assertRunNotCalled(t *testing.T, called <-chan struct{}) {
	t.Helper()
	select {
	case <-called:
		t.Fatal("pending/已废弃任务不应执行 run 模型回调")
	case <-time.After(30 * time.Millisecond):
	}
}

func runThatSignals(called chan<- struct{}) TaskRunFunc {
	return func(ctx context.Context, _ *Task, _ func(agent.Event)) {
		close(called)
	}
}

// 旧语义回归：NewTask 仍然“创建即启动”，run 被执行一次，最终 done。
func TestNewTask_StartsImmediately_Regression(t *testing.T) {
	called := make(chan struct{})
	task := NewTask(runThatSignals(called))
	if task.ID() == "" {
		t.Fatal("NewTask 必须分配 id")
	}
	if got := task.Status(); got != TaskRunning {
		t.Fatalf("NewTask 后应立即 running，got %s", got)
	}
	select {
	case <-called:
	case <-time.After(time.Second):
		t.Fatal("NewTask 必须立即启动执行体")
	}
	waitFinished(t, task, time.Second)
	if got := task.Status(); got != TaskDone {
		t.Fatalf("正常结束应为 done，got %s", got)
	}
}

// pending 任务：只分配身份，不启动、不执行回调、不提供 live 订阅。
func TestPendingTask_AllocatedButNotStarted(t *testing.T) {
	called := make(chan struct{})
	task := newPendingTask()
	defer task.discard()
	if task.ID() == "" {
		t.Fatal("pending 任务必须已有 id")
	}
	if got := task.Status(); got != TaskPending {
		t.Fatalf("新分配应为 pending，got %s", got)
	}
	if task.Finished() {
		t.Fatal("pending 任务未结束")
	}
	// 未 start，执行体不应被调用。
	assertRunNotCalled(t, called)

	snapshot, ch := task.Subscribe()
	if len(snapshot) != 0 {
		t.Fatal("pending 任务不应有事件")
	}
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("pending 任务不得提供 live 订阅 channel")
		}
	case <-time.After(time.Second):
		t.Fatal("pending 订阅 channel 应立即关闭")
	}
}

// start 只能把 pending 任务启动一次；重复 start 不执行第二个执行体。
func TestPendingTask_StartExactlyOnce(t *testing.T) {
	first := make(chan struct{})
	task := newPendingTask()
	if !task.start(runThatSignals(first)) {
		t.Fatal("pending 任务首次 start 必须成功")
	}
	if got := task.Status(); got != TaskRunning {
		t.Fatalf("start 后应为 running，got %s", got)
	}
	second := make(chan struct{})
	if task.start(runThatSignals(second)) {
		t.Fatal("已启动任务再次 start 必须返回 false")
	}
	assertRunNotCalled(t, second)
	select {
	case <-first:
	case <-time.After(time.Second):
		t.Fatal("首个执行体应被运行")
	}
	waitFinished(t, task, time.Second)
}

// 绑定失败路径：start 前 discard，绝不执行模型回调，任务终结且不可再 start。
func TestPendingTask_DiscardBeforeStart(t *testing.T) {
	called := make(chan struct{})
	run := runThatSignals(called)
	task := newPendingTask()

	if !task.discard() {
		t.Fatal("pending 任务 discard 必须成功")
	}
	if got := task.Status(); got != TaskAborted {
		t.Fatalf("discard 后应为 aborted，got %s", got)
	}
	if !task.Finished() {
		t.Fatal("discard 后必须标记 finished，避免残留半成品身份")
	}
	if task.start(run) {
		t.Fatal("已 discard 的任务不得再启动")
	}
	if task.discard() {
		t.Fatal("discard 必须幂等，第二次返回 false")
	}
	assertRunNotCalled(t, called)
}

// Abort 在 pending 阶段同样终结任务且不执行回调。
func TestPendingTask_AbortBeforeStart(t *testing.T) {
	called := make(chan struct{})
	task := newPendingTask()
	task.Abort()
	if got := task.Status(); got != TaskAborted || !task.Finished() {
		t.Fatalf("pending Abort 应 aborted+finished，got %s finished=%v", got, task.Finished())
	}
	if task.start(runThatSignals(called)) {
		t.Fatal("Abort 后不得再启动")
	}
	assertRunNotCalled(t, called)
}

// 已启动任务不能被 discard 回收，执行体照常完成（Task 只是一次执行尝试）。
func TestStartedTask_DiscardFailsAndStillRuns(t *testing.T) {
	called := make(chan struct{})
	task := newPendingTask()
	if !task.start(runThatSignals(called)) {
		t.Fatal("start 应成功")
	}
	if task.discard() {
		t.Fatal("已启动任务不允许 discard")
	}
	select {
	case <-called:
	case <-time.After(time.Second):
		t.Fatal("已启动执行体必须照常运行，不受 discard 影响")
	}
	waitFinished(t, task, time.Second)
}
