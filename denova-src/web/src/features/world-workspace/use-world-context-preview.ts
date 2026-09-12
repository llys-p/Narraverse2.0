import { useCallback, useEffect, useRef, useState } from 'react'
import { APIError } from '@/lib/api-client'
import { previewWorldContext } from './world-api'
import {
  emptyContextSelection,
  type ContextPreviewState,
  type WorldContextConsumer,
  type WorldContextSelection,
  type WorldContextUIView,
} from './world-context'

/**
 * Phase 3.1A2：Context Preview 的会话内消费状态。
 *
 * 硬约束（计划 §4.2/§4.3/§4.5）：
 *   - selection/preview 只保存在本 hook 的 React state（组件内存）中，
 *     不写入 localStorage/sessionStorage/IndexedDB，不进入 Zustand 全局 store；
 *   - 状态名只用 idle/loading/ready/stale/error；
 *   - 只读：调用 previewWorldContext，不创建 runContext、不调模型、不写 World；
 *   - 用“请求序号 + 卸载标记”丢弃过期响应，避免旧请求覆盖新状态（不引入 AbortController，
 *     与现有 fetchMasterAsset 等消费层一致）。
 *
 * 本 hook 不在挂载时自动请求；选择控件与触发按钮属于 3.1B1，页面接入属于 3.1B3。
 */
export interface RequestPreviewInput {
  consumer: WorldContextConsumer
  expectedWorldRevision: string
  selection: WorldContextSelection
}

export interface UseWorldContextPreview {
  selection: WorldContextSelection
  preview: WorldContextUIView | null
  state: ContextPreviewState
  error: APIError | Error | null
  requestPreview: (worldId: string, input: RequestPreviewInput) => Promise<void>
  /** World 保存成功 / CAS 重新加载后：保留旧 preview 但标记 stale（计划 §4.3）。 */
  markStale: () => void
  reset: () => void
}

export function useWorldContextPreview(): UseWorldContextPreview {
  const [selection, setSelection] = useState<WorldContextSelection>(emptyContextSelection)
  const [preview, setPreview] = useState<WorldContextUIView | null>(null)
  const [state, setState] = useState<ContextPreviewState>('idle')
  const [error, setError] = useState<APIError | Error | null>(null)

  const seqRef = useRef(0)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      // 卸载时让所有在途请求失效。
      seqRef.current += 1
    }
  }, [])

  const requestPreview = useCallback(async (worldId: string, input: RequestPreviewInput) => {
    const seq = seqRef.current + 1
    seqRef.current = seq
    setSelection(input.selection)
    setError(null)
    setState('loading')
    try {
      const envelope = await previewWorldContext(worldId, {
        consumer: input.consumer,
        expectedWorldRevision: input.expectedWorldRevision,
        selection: input.selection,
      })
      // 过期响应（已有更新请求 / 组件已卸载）一律丢弃，不写任何状态。
      if (!aliveRef.current || seqRef.current !== seq) return
      setPreview(envelope.preview)
      setState('ready')
    } catch (err) {
      if (!aliveRef.current || seqRef.current !== seq) return
      setError(err instanceof Error ? err : new Error(String(err)))
      setState('error')
    }
  }, [])

  const markStale = useCallback(() => {
    setState((current) => (current === 'ready' ? 'stale' : current))
  }, [])

  const reset = useCallback(() => {
    seqRef.current += 1
    setSelection(emptyContextSelection())
    setPreview(null)
    setError(null)
    setState('idle')
  }, [])

  return { selection, preview, state, error, requestPreview, markStale, reset }
}
