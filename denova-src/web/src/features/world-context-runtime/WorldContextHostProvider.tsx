import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { migrateNarraverseOrigin, type OriginMigrationResult } from './origin-migration'

export type WorldContextHostState = 'checking' | 'ready' | 'unavailable'

interface WorldContextHostValue {
  state: WorldContextHostState
  migration: OriginMigrationResult | null
}

const WorldContextHostContext = createContext<WorldContextHostValue>({ state: 'checking', migration: null })
let bootstrapPromise: Promise<WorldContextHostValue> | null = null

function takeBootstrapSecret(): string {
  const params = new URLSearchParams(window.location.hash.slice(1))
  const secret = params.get('denova-host-bootstrap') ?? ''
  if (window.location.hash) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  }
  return secret
}

async function requestStatus(): Promise<boolean> {
  const response = await fetch('/api/world-context/host/status', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  return response.ok
}

async function establishHostSession(): Promise<WorldContextHostValue> {
  const secret = takeBootstrapSecret()
  if (!secret) {
    try {
      return { state: (await requestStatus()) ? 'ready' : 'unavailable', migration: null }
    } catch {
      return { state: 'unavailable', migration: null }
    }
  }
  let migration: OriginMigrationResult = 'failed'
  try {
    migration = await migrateNarraverseOrigin()
  } catch {
    migration = 'failed'
  }
  try {
    const response = await fetch('/api/world-context/host/bootstrap', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret }),
    })
    return { state: response.ok ? 'ready' : 'unavailable', migration }
  } catch {
    return { state: 'unavailable', migration }
  }
}

export function WorldContextHostProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<WorldContextHostValue>({ state: 'checking', migration: null })
  useEffect(() => {
    let mounted = true
    bootstrapPromise ??= establishHostSession()
    void bootstrapPromise.then((next) => {
      if (mounted) setValue(next)
    })
    return () => { mounted = false }
  }, [])
  const stable = useMemo(() => value, [value])
  return <WorldContextHostContext.Provider value={stable}>{children}</WorldContextHostContext.Provider>
}

export function useWorldContextHost(): WorldContextHostValue {
  return useContext(WorldContextHostContext)
}

export function resetWorldContextHostBootstrapForTest() {
  bootstrapPromise = null
}
