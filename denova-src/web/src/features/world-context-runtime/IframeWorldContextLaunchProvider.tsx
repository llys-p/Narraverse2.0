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

export type IframeWorldConsumer = 'narraverse' | 'module4'

export interface IframeWorldContextLaunch {
  worldId: string
  expectedWorldRevision: string
  selection: WorldContextSelection
  worldName: string
  revisionLabel?: string
  selectedCount: number
  launchedAt: number
}

interface IframeWorldContextLaunchValue {
  pending: Readonly<Record<IframeWorldConsumer, IframeWorldContextLaunch | null>>
  launch: (consumer: IframeWorldConsumer, value: IframeWorldContextLaunch) => void
  take: (consumer: IframeWorldConsumer) => IframeWorldContextLaunch | null
  clear: (consumer: IframeWorldConsumer) => void
}

const IframeWorldContextLaunchContext = createContext<IframeWorldContextLaunchValue | null>(null)

const emptyPending = (): Record<IframeWorldConsumer, IframeWorldContextLaunch | null> => ({
  narraverse: null,
  module4: null,
})

export function IframeWorldContextLaunchProvider({ children }: { children: ReactNode }) {
  const pendingRef = useRef(emptyPending())
  const [pending, setPending] = useState(emptyPending)

  const launch = useCallback((consumer: IframeWorldConsumer, value: IframeWorldContextLaunch) => {
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

  const value = useMemo<IframeWorldContextLaunchValue>(() => ({ pending, launch, take, clear }), [pending, launch, take, clear])
  return <IframeWorldContextLaunchContext.Provider value={value}>{children}</IframeWorldContextLaunchContext.Provider>
}

export function useIframeWorldContextLaunch(): IframeWorldContextLaunchValue {
  const value = useContext(IframeWorldContextLaunchContext)
  if (!value) throw new Error('useIframeWorldContextLaunch must be used within IframeWorldContextLaunchProvider')
  return value
}
