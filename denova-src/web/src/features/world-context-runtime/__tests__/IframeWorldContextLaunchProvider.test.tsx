import { renderHook, act } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { IframeWorldContextLaunchProvider, useIframeWorldContextLaunch } from '../IframeWorldContextLaunchProvider'

const launch = {
  worldId: 'w1', expectedWorldRevision: 'sha256:r1', worldName: '世界', selectedCount: 1, launchedAt: 1,
  selection: { includeTone: true, ruleIndexes: [], characterIds: [], locationIds: [], factionIds: [], timelineEntryIds: [], bindingIds: [] },
}

describe('IframeWorldContextLaunchProvider', () => {
  it('keeps per-consumer refs only in component memory and consumes each independently', () => {
    const { result, unmount } = renderHook(() => useIframeWorldContextLaunch(), { wrapper: IframeWorldContextLaunchProvider })
    act(() => {
      result.current.launch('narraverse', launch)
      result.current.launch('module4', { ...launch, worldId: 'w2' })
    })
    expect(result.current.pending.narraverse?.worldId).toBe('w1')
    expect(result.current.pending.module4?.worldId).toBe('w2')
    let taken = null
    act(() => { taken = result.current.take('narraverse') })
    expect(taken).toMatchObject({ worldId: 'w1' })
    expect(result.current.pending.narraverse).toBeNull()
    expect(result.current.pending.module4?.worldId).toBe('w2')
    expect(localStorage.getItem('world-context')).toBeNull()
    unmount()
  })
})
