/**
 * B4a（L3.3 叙界）：作品设定库 → 受控 iframe 的一次性交接（launch），镜像
 * IframeWorldContextLaunchProvider：
 *   - 只做进程内一次性 Pending，不写 localStorage/sessionStorage，刷新即丢；
 *   - 仅由用户在库工作区显式发起（带入叙界）；交接只携带“已保存库”的 Ref
 *     （libraryId+expectedRevision+manualItemIds，与写作/游戏同一冻结 wire）与
 *     状态条展示摘要；L2 预览的 autoItemIds 是预览专属，不进入交接（B0 §8.2）；
 *   - consumer 由宿主受控路由固定（narraverse|module4），Ref 只交给同源宿主页面，
 *     iframe 永远看不到 Ref、revision、manualItemIds 或任何运行身份。
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
import type { IframeWorldConsumer } from '@/features/world-context-runtime/IframeWorldContextLaunchProvider'

/** 与后端 host bind 冻结 wire 对齐的库 Ref（camelCase）。 */
export interface IframeLibraryContextRef {
  libraryId: string
  expectedRevision: string
  manualItemIds: string[]
}

/** 待消费的 iframe 库交接：Ref + 仅用于状态展示的脱敏摘要。 */
export interface IframeLibraryContextLaunch extends IframeLibraryContextRef {
  libraryName: string
  revisionLabel: string
  selectedCount: number
  launchedAt: number
}

interface IframeLibraryContextLaunchValue {
  /** 响应式快照，供 UI 判断各 consumer 是否有待带入的库背景。 */
  pending: Readonly<Record<IframeWorldConsumer, IframeLibraryContextLaunch | null>>
  /** 库工作区在用户显式发起后调用，写入待消费 Ref。 */
  launch: (consumer: IframeWorldConsumer, value: IframeLibraryContextLaunch) => void
  /** NarraverseWorkspace 绑定成功时取走并清空（一次性）。 */
  take: (consumer: IframeWorldConsumer) => IframeLibraryContextLaunch | null
  /** 用户清除或与 world 背景互斥裁决落败时使旧 pending 失效。 */
  clear: (consumer: IframeWorldConsumer) => void
}

const noopLaunch: IframeLibraryContextLaunchValue = {
  pending: { narraverse: null, module4: null },
  launch: () => {},
  take: () => null,
  clear: () => {},
}

const IframeLibraryContextLaunchContext = createContext<IframeLibraryContextLaunchValue>(noopLaunch)

const emptyPending = (): Record<IframeWorldConsumer, IframeLibraryContextLaunch | null> => ({
  narraverse: null,
  module4: null,
})

export function IframeLibraryContextLaunchProvider({ children }: { children: ReactNode }) {
  const pendingRef = useRef(emptyPending())
  const [pending, setPending] = useState(emptyPending)

  const launch = useCallback((consumer: IframeWorldConsumer, value: IframeLibraryContextLaunch) => {
    pendingRef.current = { ...pendingRef.current, [consumer]: value }
    setPending(pendingRef.current)
  }, [])

  const take = useCallback((consumer: IframeWorldConsumer) => {
    const current = pendingRef.current[consumer]
    pendingRef.current = { ...pendingRef.current, [consumer]: null }
    setPending(pendingRef.current)
    return current
  }, [])

  const clear = useCallback((consumer: IframeWorldConsumer) => {
    pendingRef.current = { ...pendingRef.current, [consumer]: null }
    setPending(pendingRef.current)
  }, [])

  const value = useMemo<IframeLibraryContextLaunchValue>(
    () => ({ pending, launch, take, clear }),
    [pending, launch, take, clear],
  )
  return <IframeLibraryContextLaunchContext.Provider value={value}>{children}</IframeLibraryContextLaunchContext.Provider>
}

export function useIframeLibraryContextLaunch(): IframeLibraryContextLaunchValue {
  return useContext(IframeLibraryContextLaunchContext)
}
