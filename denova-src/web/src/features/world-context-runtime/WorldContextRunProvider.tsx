/**
 * Phase 3.2-A6：写作世界背景「运行状态」的纯内存 UI 桥。
 *
 * useAgentChat（在 App 内调用）是状态的唯一生产者；AgentPanel（深层子组件）是消费者。
 * 用 Context 桥接，避免在 ModeRouter 的庞大 props 上做长链 drilling。
 *
 * 冻结边界：
 *   - 只承载「当前一次写作运行」的展示状态（none/bound/active/degraded + 脱敏摘要）；
 *   - 不写任何浏览器存储、不进 Zustand、不保存 Snapshot/ModelView/runContext/handle；
 *   - 不修改 World；刷新即回到 none；
 *   - clear 动作通过注册回调交回 useAgentChat 执行，状态真源仍在 useAgentChat。
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
import type { AnalysisHandleStatus, WorldContextRunState } from './world-context-wire'

export interface WritingWorldRunView {
  state: WorldContextRunState
  hasBound: boolean
  worldName?: string
  revisionLabel?: string
  selectedCount?: number
  errorCode?: string
  analysisHandleStatus?: AnalysisHandleStatus
}

const INITIAL_VIEW: WritingWorldRunView = { state: 'none', hasBound: false }

interface WorldContextRunContextValue {
  view: WritingWorldRunView
  setView: (view: WritingWorldRunView) => void
  registerClear: (fn: (() => void) | null) => void
  requestClear: () => void
}

const WorldContextRunContext = createContext<WorldContextRunContextValue | null>(null)

export function WorldContextRunProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<WritingWorldRunView>(INITIAL_VIEW)
  const clearRef = useRef<(() => void) | null>(null)
  const registerClear = useCallback((fn: (() => void) | null) => {
    clearRef.current = fn
  }, [])
  const requestClear = useCallback(() => {
    clearRef.current?.()
  }, [])
  const value = useMemo<WorldContextRunContextValue>(() => ({
    view,
    setView,
    registerClear,
    requestClear,
  }), [view, registerClear, requestClear])

  return (
    <WorldContextRunContext.Provider value={value}>
      {children}
    </WorldContextRunContext.Provider>
  )
}

export function useWorldContextRun(): WorldContextRunContextValue {
  const ctx = useContext(WorldContextRunContext)
  if (!ctx) {
    throw new Error('useWorldContextRun must be used within WorldContextRunProvider')
  }
  return ctx
}
