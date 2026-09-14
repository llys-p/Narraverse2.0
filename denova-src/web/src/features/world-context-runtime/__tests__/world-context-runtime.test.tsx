import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  normalizeWorldContextStatus,
  toWorldContextRequestBody,
} from '../world-context-wire'
import {
  WorldContextRunProvider,
  useWorldContextRun,
} from '../WorldContextRunProvider'

const selection = {
  includeTone: false,
  ruleIndexes: [],
  characterIds: [],
  locationIds: [],
  factionIds: [],
  timelineEntryIds: [],
  bindingIds: [],
}

describe('world-context-wire', () => {
  it('builds a request body with only the frozen Ref fields', () => {
    const body = toWorldContextRequestBody({
      worldId: 'w1',
      expectedWorldRevision: 'r1',
      selection,
    })
    expect(body).toEqual({ worldId: 'w1', expectedWorldRevision: 'r1', selection })
    expect(Object.keys(body).sort()).toEqual(['expectedWorldRevision', 'selection', 'worldId'])
  })

  it('normalizes known states and drops unknown fields', () => {
    expect(normalizeWorldContextStatus({ state: 'active', worldName: 'W', runContextId: 'leak', scopeKey: 'leak' }))
      .toEqual({ state: 'active', worldName: 'W' })
  })

  it.each([null, undefined, 'x', 1, { state: 'weird' }, { state: 'active', selectedCount: 'no' }])(
    'returns null or coerces invalid payload %j',
    (payload) => {
      const out = normalizeWorldContextStatus(payload)
      if (payload && typeof payload === 'object' && (payload as any).state === 'active') {
        expect(out).toEqual({ state: 'active' })
      } else {
        expect(out).toBeNull()
      }
    },
  )

  it('keeps only whitelisted analysisHandleStatus', () => {
    expect(normalizeWorldContextStatus({ state: 'active', analysisHandleStatus: 'consumed' })?.analysisHandleStatus)
      .toBe('consumed')
    expect(normalizeWorldContextStatus({ state: 'active', analysisHandleStatus: 'claimed' })?.analysisHandleStatus)
      .toBeUndefined()
  })
})

describe('WorldContextRunProvider', () => {
  function wrapper({ children }: { children: ReactNode }) {
    return <WorldContextRunProvider>{children}</WorldContextRunProvider>
  }

  it('starts at none and updates view; clear routes through registered callback', () => {
    const clear = vi.fn()
    const { result } = renderHook(() => useWorldContextRun(), { wrapper })
    expect(result.current.view).toEqual({ state: 'none', hasBound: false })

    act(() => result.current.setView({ state: 'bound', hasBound: true, worldName: 'W' }))
    expect(result.current.view.state).toBe('bound')

    act(() => result.current.registerClear(clear))
    act(() => result.current.requestClear())
    expect(clear).toHaveBeenCalledTimes(1)

    act(() => result.current.registerClear(null))
    act(() => result.current.requestClear())
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('throws outside the provider', () => {
    expect(() => renderHook(() => useWorldContextRun())).toThrow(/WorldContextRunProvider/)
  })
})
