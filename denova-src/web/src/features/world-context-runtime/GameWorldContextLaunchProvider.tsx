/**
 * Phase 3.2-B3: 从 World Console「带入游戏」的进程内交接层。
 *
 * 冻结边界（与写作侧 WorldContextLaunchProvider 对齐）：
 *   - 只在 React 内存中保存唯一一个待消费的游戏 World Context Ref；
 *   - 不写 localStorage/sessionStorage/IndexedDB，不过 Zustand，关页面即空；
 *   - 只携带已保存 World 的 Ref（worldId + expectedWorldRevision + selection），
 *     不携带 Snapshot/ModelView/runContext/analysisHandle 等运行时对象；
 *   - launch 必须绑定 storyId + branchId；切故事/切分支时旧 pending 自动失效；
 *   - World 仍是唯一持久化真源，本 Provider 不修改 World、不创建 runContext、不调用模型。
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

/** 与后端冻结 wire 对齐的游戏 Ref（camelCase，服务端固定 consumer=game）。 */
export interface GameWorldContextRef {
  worldId: string
  expectedWorldRevision: string
  selection: WorldContextSelection
}

/** 待消费的游戏交接：Ref + storyId + branchId + 仅用于状态展示的快照摘要。 */
export interface GameWorldContextLaunch extends GameWorldContextRef {
  storyId: string
  branchId: string
  worldName: string
  revisionLabel?: string
  selectedCount: number
  launchedAt: number
}

interface GameWorldContextLaunchContextValue {
  /** 响应式快照，供 UI 展示当前是否有待带入的背景。 */
  pendingGame: GameWorldContextLaunch | null
  /** World Console 在「选定故事并确认」后调用，写入待消费 Ref。 */
  launchGame: (launch: GameWorldContextLaunch) => void
  /** StoryStage 首次发送时取走并清空（一次性消费）；无待交接时返回 null。 */
  takeGameLaunch: () => GameWorldContextLaunch | null
  /** 不清空读取（用于状态展示判断）。 */
  peekGameLaunch: () => GameWorldContextLaunch | null
  /** 用户主动清除，或切故事/切分支时使旧 pending 失效。 */
  clearGameLaunch: () => void
}

const noopLaunch: GameWorldContextLaunchContextValue = {
  pendingGame: null,
  launchGame: () => {},
  takeGameLaunch: () => null,
  peekGameLaunch: () => null,
  clearGameLaunch: () => {},
}

const GameWorldContextLaunchContext = createContext<GameWorldContextLaunchContextValue>(noopLaunch)

export function GameWorldContextLaunchProvider({ children }: { children: ReactNode }) {
  const pendingRef = useRef<GameWorldContextLaunch | null>(null)
  const [pendingGame, setPendingGame] = useState<GameWorldContextLaunch | null>(null)

  const launchGame = useCallback((launch: GameWorldContextLaunch) => {
    pendingRef.current = launch
    setPendingGame(launch)
  }, [])

  const takeGameLaunch = useCallback(() => {
    const current = pendingRef.current
    pendingRef.current = null
    setPendingGame(null)
    return current
  }, [])

  const peekGameLaunch = useCallback(() => pendingRef.current, [])

  const clearGameLaunch = useCallback(() => {
    pendingRef.current = null
    setPendingGame(null)
  }, [])

  const value = useMemo<GameWorldContextLaunchContextValue>(() => ({
    pendingGame,
    launchGame,
    takeGameLaunch,
    peekGameLaunch,
    clearGameLaunch,
  }), [pendingGame, launchGame, takeGameLaunch, peekGameLaunch, clearGameLaunch])

  return (
    <GameWorldContextLaunchContext.Provider value={value}>
      {children}
    </GameWorldContextLaunchContext.Provider>
  )
}

export function useGameWorldContextLaunch(): GameWorldContextLaunchContextValue {
  return useContext(GameWorldContextLaunchContext)
}
