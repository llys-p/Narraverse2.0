/**
 * B3b：作品设定库 → 游戏模式的一次性交接（launch），镜像 GameWorldContextLaunchProvider：
 *   - 只做进程内一次性 Pending，不写 localStorage/sessionStorage，不进 Zustand，刷新即丢；
 *   - 仅由用户在库工作区显式发起（带入游戏），且必须先明确选择目标故事/分支；
 *     launch 绑定 storyId + branchId，切故事/切分支时旧 pending 失效（StoryStage 清除）；
 *   - 交接只携带“已保存库”的 Ref（libraryId+expectedRevision+manualItemIds）与
 *     状态条展示所需摘要；L2 预览的 autoItemIds 是预览专属，不进入交接（B0 §8.2）；
 *   - 不携带 consumer/scopeKey/runContextId 等任何运行身份（服务端按 InteractiveRun
 *     身份派生，伪造→400/403）；regenerate 由服务端复用原运行背景，不依赖本交接。
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

/** 与后端冻结 wire 对齐的游戏库 Ref（camelCase，服务端固定 consumer=game）。 */
export interface GameLibraryContextRef {
  libraryId: string
  expectedRevision: string
  manualItemIds: string[]
}

/** 待消费的游戏库交接：Ref + storyId + branchId + 仅用于状态展示的脱敏摘要。 */
export interface GameLibraryContextLaunch extends GameLibraryContextRef {
  storyId: string
  branchId: string
  libraryName: string
  revisionLabel: string
  selectedCount: number
  launchedAt: number
}

interface GameLibraryContextLaunchContextValue {
  /** 响应式快照，供 UI 展示当前是否有待带入的库背景。 */
  pendingGameLibrary: GameLibraryContextLaunch | null
  /** 库工作区在「选定故事/分支并确认」后调用，写入待消费 Ref。 */
  launchGameLibrary: (launch: GameLibraryContextLaunch) => void
  /** StoryStage 消费时取走并清空（一次性）；无待交接时返回 null。 */
  takeGameLibraryLaunch: () => GameLibraryContextLaunch | null
  /** 不清空读取（用于发送前判断）。 */
  peekGameLibraryLaunch: () => GameLibraryContextLaunch | null
  /** 用户清除，或切故事/切分支时使旧 pending 失效。 */
  clearGameLibraryLaunch: () => void
}

const noopLaunch: GameLibraryContextLaunchContextValue = {
  pendingGameLibrary: null,
  launchGameLibrary: () => {},
  takeGameLibraryLaunch: () => null,
  peekGameLibraryLaunch: () => null,
  clearGameLibraryLaunch: () => {},
}

const GameLibraryContextLaunchContext = createContext<GameLibraryContextLaunchContextValue>(noopLaunch)

export function GameLibraryContextLaunchProvider({ children }: { children: ReactNode }) {
  // ref 保证 take 同步可读，state 负责触发消费；二者始终一起写。
  const pendingRef = useRef<GameLibraryContextLaunch | null>(null)
  const [pendingGameLibrary, setPendingGameLibrary] = useState<GameLibraryContextLaunch | null>(null)

  const launchGameLibrary = useCallback((launch: GameLibraryContextLaunch) => {
    pendingRef.current = launch
    setPendingGameLibrary(launch)
  }, [])

  const takeGameLibraryLaunch = useCallback(() => {
    const current = pendingRef.current
    pendingRef.current = null
    setPendingGameLibrary(null)
    return current
  }, [])

  const peekGameLibraryLaunch = useCallback(() => pendingRef.current, [])

  const clearGameLibraryLaunch = useCallback(() => {
    pendingRef.current = null
    setPendingGameLibrary(null)
  }, [])

  const value = useMemo<GameLibraryContextLaunchContextValue>(() => ({
    pendingGameLibrary,
    launchGameLibrary,
    takeGameLibraryLaunch,
    peekGameLibraryLaunch,
    clearGameLibraryLaunch,
  }), [pendingGameLibrary, launchGameLibrary, takeGameLibraryLaunch, peekGameLibraryLaunch, clearGameLibraryLaunch])

  return (
    <GameLibraryContextLaunchContext.Provider value={value}>
      {children}
    </GameLibraryContextLaunchContext.Provider>
  )
}

export function useGameLibraryContextLaunch(): GameLibraryContextLaunchContextValue {
  return useContext(GameLibraryContextLaunchContext)
}
