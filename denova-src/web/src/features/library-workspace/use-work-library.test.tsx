import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/lib/api-client'
import { useWorkLibraryEditor } from './use-work-library'

vi.mock('@/lib/api-client', async (original) => ({
  ...await original<typeof api>(), getWorkLibrary: vi.fn(),
  getWorkLibraryTimeline: vi.fn(), updateWorkLibraryMeta: vi.fn(),
  deleteWorkLibraryItem: vi.fn(),
}))

function envelope(id: string) {
  return { library: { id, schemaVersion: 1, name: id, purpose: 'any',
    items: [], relations: [], createdAt: '', updatedAt: '' }, revision: `sha256:${id}` }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

describe('library editor request ownership', () => {
  beforeEach(() => { vi.resetAllMocks(); vi.mocked(api.getWorkLibraryTimeline).mockResolvedValue([]) })

  it('reloads authoritative event versions after cascade deletion', async () => {
    const initial = envelope('a') as api.WorkLibraryEnvelope
    initial.library.items = [{ id: 'event', name: '事件', type: 'event', enabled: true, origin: 'original', loadMode: 'auto', importance: 'minor', createdAt: '', updatedAt: 'old', event: { order: 0, era: '', category: 'background', participantItemIds: ['removed'] } }]
    const updated = structuredClone(initial)
    updated.library.items[0].updatedAt = 'server-new'
    updated.library.items[0].event!.participantItemIds = []
    updated.revision = 'sha256:server-new'
    vi.mocked(api.getWorkLibrary).mockResolvedValueOnce(initial).mockResolvedValue(updated)
    vi.mocked(api.deleteWorkLibraryItem).mockResolvedValue({ deletedId: 'removed', removedRelationIds: [], updatedEventIds: ['event'], revision: updated.revision })
    const hook = renderHook(() => useWorkLibraryEditor('a'))
    await waitFor(() => expect(hook.result.current.status).toBe('ready'))
    await act(async () => { await hook.result.current.deleteItem('removed', true) })
    expect(hook.result.current.library?.items[0].updatedAt).toBe('server-new')
  })

  it('discards a late load after switching libraries', async () => {
    const old = deferred<ReturnType<typeof envelope>>()
    vi.mocked(api.getWorkLibrary).mockImplementation((id) => id === 'a' ? old.promise : Promise.resolve(envelope(id)))
    const hook = renderHook(({ id }) => useWorkLibraryEditor(id), { initialProps: { id: 'a' as string | null } })
    hook.rerender({ id: 'b' })
    await waitFor(() => expect(hook.result.current.library?.id).toBe('b'))
    await act(async () => old.resolve(envelope('a')))
    expect(hook.result.current.library?.id).toBe('b')
    expect(hook.result.current.revision).toBe('sha256:b')
  })

  it('does not resurrect a closed editor from a late error', async () => {
    const old = deferred<ReturnType<typeof envelope>>()
    vi.mocked(api.getWorkLibrary).mockReturnValue(old.promise)
    const hook = renderHook(({ id }) => useWorkLibraryEditor(id), { initialProps: { id: 'a' as string | null } })
    hook.rerender({ id: null })
    await act(async () => old.reject(new Error('late')))
    expect(hook.result.current.status).toBe('idle')
    expect(hook.result.current.error).toBeNull()
  })

  it('ignores a completed save from a library that is no longer open', async () => {
    vi.mocked(api.getWorkLibrary).mockImplementation(async (id) => envelope(id))
    const save = deferred<ReturnType<typeof envelope>>()
    vi.mocked(api.updateWorkLibraryMeta).mockReturnValue(save.promise)
    const hook = renderHook(({ id }) => useWorkLibraryEditor(id), { initialProps: { id: 'a' } })
    await waitFor(() => expect(hook.result.current.status).toBe('ready'))
    let pending!: Promise<boolean>
    act(() => { pending = hook.result.current.saveMeta({ name: 'changed' }) })
    hook.rerender({ id: 'b' })
    await waitFor(() => expect(hook.result.current.library?.id).toBe('b'))
    await act(async () => save.resolve(envelope('a')))
    expect(await pending).toBe(false)
    expect(hook.result.current.library?.id).toBe('b')
  })
})
