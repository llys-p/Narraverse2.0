/**
 * Phase 3.2-A5：从 World Console「显式带入写作」的进程内交接层。
 *
 * 冻结边界：
 *   - 只在 React 内存中保存唯一一个待消费的写作 World Context Ref；
 *   - 不写 localStorage/sessionStorage/IndexedDB，不进 Zustand，刷新页面后必然为空；
 *   - 这里只携带已保存 World 的 Ref（worldId + expectedWorldRevision + Selection），
 *     不携带 Snapshot/ModelView/runContext/analysisHandle 等运行态对象；
 *   - World 仍是唯一持久化真源，本 Provider 不修改 World、不创建 runContext、不调用模型；
 *   - 普通写作入口（不经过 World Console）永远不会写入这里，保持 bare。
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { WorldContextSelection } from '@/features/world-workspace/world-context'

/** 与后端冻结 wire 对齐的写作 Ref（camelCase，由服务端固定 consumer=writing）。 */
export interface WritingWorldContextRef {
  worldId: string
  expectedWorldRevision: string
  selection: WorldContextSelection
}

/** 待消费的写作交接：Ref + 仅用于状态展示的脱敏摘要（不含任何内部运行 ID/正文）。 */
export interface WritingWorldContextLaunch extends WritingWorldContextRef {
  worldName: string
  revisionLabel?: string
  selectedCount: number
  launchedAt: number
}

interface WorldContextLaunchContextValue {
  /** 响应式快照，供 UI 展示当前是否有待带入的背景。 */
  pendingWriting: WritingWorldContextLaunch | null
  /** World Console 在「切主书成功后」调用，写入待消费 Ref。 */
  launchWriting: (launch: WritingWorldContextLaunch) => void
  /** 写作端首次发送时取走并清空（一次性消费）；无待交接时返回 null。 */
  takeWritingLaunch: () => WritingWorldContextLaunch | null
  /** 不清空读取（用于状态展示判断）。 */
  peekWritingLaunch: () => WritingWorldContextLaunch | null
  /** 用户主动清除「后续新 run」的 Ref。 */
  clearWritingLaunch: () => void
}

const WorldContextLaunchContext = createContext<WorldContextLaunchContextValue | null>(null)

export function WorldContextLaunchProvider({ children }: { children: ReactNode }) {
  // ref 保证 take/peek 同步可读，state 负责触发 UI 更新；二者始终一起写。
  const pendingRef = useRef<WritingWorldContextLaunch | null>(null)
  const [pendingWriting, setPendingWriting] = useState<WritingWorldContextLaunch | null>(null)

  const launchWriting = useCallback((launch: WritingWorldContextLaunch) => {
    pendingRef.current = launch
    setPendingWriting(launch)
  }, [])

  const takeWritingLaunch = useCallback(() => {
    const current = pendingRef.current
    pendingRef.current = null
    setPendingWriting(null)
    return current
  }, [])

  const peekWritingLaunch = useCallback(() => pendingRef.current, [])

  const clearWritingLaunch = useCallback(() => {
    pendingRef.current = null
    setPendingWriting(null)
  }, [])

  const value = useMemo<WorldContextLaunchContextValue>(() => ({
    pendingWriting,
    launchWriting,
    takeWritingLaunch,
    peekWritingLaunch,
    clearWritingLaunch,
  }), [pendingWriting, launchWriting, takeWritingLaunch, peekWritingLaunch, clearWritingLaunch])

  return (
    <WorldContextLaunchContext.Provider value={value}>
      {children}
    </WorldContextLaunchContext.Provider>
  )
}

export function useWorldContextLaunch(): WorldContextLaunchContextValue {
  const ctx = useContext(WorldContextLaunchContext)
  if (!ctx) {
    throw new Error('useWorldContextLaunch must be used within WorldContextLaunchProvider')
  }
  return ctx
}
