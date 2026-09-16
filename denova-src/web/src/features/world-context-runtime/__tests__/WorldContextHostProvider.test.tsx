import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetWorldContextHostBootstrapForTest,
  useWorldContextHost,
  WorldContextHostProvider,
} from '../WorldContextHostProvider'

const migration = vi.hoisted(() => ({ run: vi.fn() }))

vi.mock('../origin-migration', () => ({ migrateNarraverseOrigin: migration.run }))

function Probe() {
  const host = useWorldContextHost()
  return <output data-testid="state">{host.state}:{host.migration ?? 'none'}</output>
}

describe('WorldContextHostProvider', () => {
  beforeEach(() => {
    resetWorldContextHostBootstrapForTest()
    migration.run.mockReset()
    window.history.replaceState(null, '', '/?mode=worlds')
  })

  afterEach(() => vi.unstubAllGlobals())

  it('migrates before consuming the fragment secret and never puts the secret in a request URL', async () => {
    const order: string[] = []
    migration.run.mockImplementation(async () => { order.push('migration'); return 'migrated' })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      order.push('bootstrap')
      expect(String(input)).toBe('/api/world-context/host/bootstrap')
      expect(String(input)).not.toContain('super-secret')
      expect(JSON.parse(String(init?.body))).toEqual({ secret: 'super-secret' })
      return new Response('{}', { status: 200 })
    }))
    window.history.replaceState(null, '', '/?mode=worlds#denova-host-bootstrap=super-secret')
    render(<WorldContextHostProvider><Probe /></WorldContextHostProvider>)
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:migrated'))
    expect(order).toEqual(['migration', 'bootstrap'])
    expect(window.location.hash).toBe('')
    expect(window.location.search).toBe('?mode=worlds')
  })

  it('refreshes through the protected status POST without creating a second bootstrap', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/world-context/host/status')
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe('{}')
      return new Response('{}', { status: 200 })
    }))
    render(<WorldContextHostProvider><Probe /></WorldContextHostProvider>)
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:none'))
    expect(migration.run).not.toHaveBeenCalled()
  })

  it('fails closed when neither bootstrap nor an existing host session is available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })))
    render(<WorldContextHostProvider><Probe /></WorldContextHostProvider>)
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('unavailable:none'))
  })
})
