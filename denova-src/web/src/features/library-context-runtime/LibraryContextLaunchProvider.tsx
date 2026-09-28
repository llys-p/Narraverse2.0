/**
 * B2b：作品设定库 → 写作模式的一次性交接（launch），镜像 WorldContextLaunchProvider 的 A5 冻结边界：
 *   - 只做进程内一次性 Pending，不写 localStorage/sessionStorage，刷新即丢（安全边界的性质，而不是疏漏）；
 *   - 仅由用户在库工作区显式发起（带入写作），普通写作入口永远不会写入这里；
 *   - 交接只携带“已保存库”的 Ref（libraryId+expectedRevision+manualItemIds）与
 *     状态条展示所需摘要（名称/版本标签/手动条数）；L2 preview 的 autoItemIds 是预览专属，
 *     不得进入交接（B0 §8.2：auto 目录是受控按需读取，不是长期授权）；
 *   - 不携带 consumer/scopeKey/runContextId 等任何运行身份（服务端按任务归属派生，伪造→400/403）。
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

/** 写入一次性交接的数据（由库工作区显式发起）。 */
export interface WritingLibraryContextLaunch {
  libraryId: string
  expectedRevision: string
  manualItemIds: string[]
  libraryName: string
  revisionLabel: string
  selectedCount: number
}

interface LibraryContextLaunchContextType {
  /** 响应式快照，供 UI 展示当前是否有待带入的背景；useAgentChat 依赖它以在挂载后仍能消费新交接。 */
  pendingLibrary: WritingLibraryContextLaunch | null
  /** 库工作区在用户显式「带入写作」时调用，写入待消费交接。 */
  launchWritingLibrary: (launch: WritingLibraryContextLaunch) => void
  /** 写作端消费时取走并清空（一次性）；无交接时返回 null。 */
  takeWritingLibraryLaunch: () => WritingLibraryContextLaunch | null
}

const LibraryContextLaunchContext = createContext<LibraryContextLaunchContextType | null>(null)

export function LibraryContextLaunchProvider({ children }: { children: ReactNode }) {
  // ref 保证 take 同步可读，state 负责触发消费 effect；二者始终一起写。
  const pendingRef = useRef<WritingLibraryContextLaunch | null>(null)
  const [pendingLibrary, setPendingLibrary] = useState<WritingLibraryContextLaunch | null>(null)

  const launchWritingLibrary = useCallback((launch: WritingLibraryContextLaunch) => {
    pendingRef.current = launch
    setPendingLibrary(launch)
  }, [])

  const takeWritingLibraryLaunch = useCallback(() => {
    const current = pendingRef.current
    pendingRef.current = null
    setPendingLibrary(null)
    return current
  }, [])

  const value = useMemo<LibraryContextLaunchContextType>(() => ({
    pendingLibrary,
    launchWritingLibrary,
    takeWritingLibraryLaunch,
  }), [pendingLibrary, launchWritingLibrary, takeWritingLibraryLaunch])

  return (
    <LibraryContextLaunchContext.Provider value={value}>
      {children}
    </LibraryContextLaunchContext.Provider>
  )
}

export function useLibraryContextLaunch(): LibraryContextLaunchContextType {
  const ctx = useContext(LibraryContextLaunchContext)
  if (!ctx) throw new Error('useLibraryContextLaunch must be within LibraryContextLaunchProvider')
  return ctx
}
