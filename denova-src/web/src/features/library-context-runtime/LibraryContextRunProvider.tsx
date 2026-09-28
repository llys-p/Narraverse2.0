/**
 * B2b：设定库写作背景的运行状态桥（useAgentChat → AgentPanel 状态条），
 * 镜像 WorldContextRunProvider：仅放「与服务端一致的运行摘要」，不落任何盘，
 * AgentPanel 不读 useAgentChat 内部状态，ModeRouter 的庞大 props 不做长链 drilling。
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { LibraryContextRunState } from './library-context-wire'

export interface LibraryContextRunView {
  state: LibraryContextRunState
  hasBound: boolean
  libraryName?: string
  revisionLabel?: string
  selectedCount?: number
}

interface LibraryContextRunContextType {
  view: LibraryContextRunView
  setView: (view: LibraryContextRunView) => void
  /** 状态条「移除」按钮的回调注册（useAgentChat 在清除后恢复 none 原状态）。 */
  registerClear: (clear: (() => void) | null) => void
  requestClear: () => void
}

const noop = () => {}

const LibraryContextRunContext = createContext<LibraryContextRunContextType | null>(null)

export function LibraryContextRunProvider({ children }: { children: ReactNode }) {
  const [view, setViewState] = useState<LibraryContextRunView>({ state: 'none', hasBound: false })
  const [clear, setClear] = useState<(() => void) | null>(null)

  const setView = useCallback((next: LibraryContextRunView) => setViewState(next), [])
  const registerClear = useCallback((c: (() => void) | null) => setClear(() => c), [])
  const requestClear = useCallback(() => (clear ?? noop)(), [clear])

  const value = useMemo(() => ({ view, setView, registerClear, requestClear }), [view, setView, registerClear, requestClear])
  return <LibraryContextRunContext.Provider value={value}>{children}</LibraryContextRunContext.Provider>
}

export function useLibraryContextRun(): LibraryContextRunContextType {
  const ctx = useContext(LibraryContextRunContext)
  if (!ctx) throw new Error('useLibraryContextRun must be used within LibraryContextRunProvider')
  return ctx
}
