import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoreItem } from '@/lib/api'
import { BookGraphView } from './BookGraphView'

const items: LoreItem[] = [
  { id: 'a', name: '北岸旅者', type: 'character', enabled: true, type_source: 'manual', importance: 'important', pinned: false, pin_order: 0, load_mode: 'auto', tags: [], keywords: [], brief_description: '', content: '', created_at: 'r1', updated_at: 'r1', relations: [{ target_id: 'b', label: '好友' }] },
  { id: 'b', name: '南港守卫', type: 'character', enabled: true, type_source: 'manual', importance: 'important', pinned: false, pin_order: 0, load_mode: 'auto', tags: [], keywords: [], brief_description: '', content: '', created_at: 'r1', updated_at: 'r1' },
]

describe('BookGraphView label rendering', () => {
  const frames = new Map<number, FrameRequestCallback>()
  let frameID = 0
  const ctx = {
    setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), quadraticCurveTo: vi.fn(), closePath: vi.fn(),
    stroke: vi.fn(), fill: vi.fn(), setLineDash: vi.fn(), arc: vi.fn(), strokeText: vi.fn(), fillText: vi.fn(),
  }

  beforeEach(() => {
    frames.clear()
    frameID = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameID, callback); return frameID })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    vi.stubGlobal('PointerEvent', MouseEvent)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500)
  })

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks() })

  function drawFrame() {
    const callbacks = [...frames.values()]
    frames.clear()
    ctx.fillText.mockClear()
    ctx.arc.mockClear()
    ctx.moveTo.mockClear()
    ctx.quadraticCurveTo.mockClear()
    callbacks.forEach((callback) => callback(0))
  }

  function toScreen(x: number, y: number) {
    const [tx, ty] = ctx.translate.mock.lastCall!
    const [zoom] = ctx.scale.mock.lastCall!
    return { clientX: tx + x * zoom, clientY: ty + y * zoom }
  }

  it('always draws every node name but hides relation text until node hover, and hides it again on leave', () => {
    const before = structuredClone(items)
    render(<BookGraphView items={items} />)
    drawFrame()
    const canvas = screen.getByLabelText('图谱')
    for (const item of items) expect(ctx.fillText).toHaveBeenCalledWith(item.name, expect.any(Number), expect.any(Number))
    expect(ctx.fillText).not.toHaveBeenCalledWith('好友', expect.any(Number), expect.any(Number))
    const [x, y] = ctx.arc.mock.calls[0]
    fireEvent.pointerMove(canvas, toScreen(x, y))
    drawFrame()
    expect(ctx.fillText).toHaveBeenCalledWith('好友', expect.any(Number), expect.any(Number))
    fireEvent.pointerLeave(canvas)
    drawFrame()
    expect(ctx.fillText).not.toHaveBeenCalledWith('好友', expect.any(Number), expect.any(Number))
    for (const item of items) expect(ctx.fillText).toHaveBeenCalledWith(item.name, expect.any(Number), expect.any(Number))
    expect(items).toEqual(before)
  })

  it('reveals the relation name on curve hover even when neither endpoint is hovered', () => {
    render(<BookGraphView items={items} />)
    drawFrame()
    const [sx, sy] = ctx.moveTo.mock.calls[0]
    const [cx, cy, ex, ey] = ctx.quadraticCurveTo.mock.calls[0]
    fireEvent.pointerMove(screen.getByLabelText('图谱'), toScreen((sx + 2 * cx + ex) / 4, (sy + 2 * cy + ey) / 4))
    drawFrame()
    expect(ctx.fillText).toHaveBeenCalledWith('好友', expect.any(Number), expect.any(Number))
    fireEvent.pointerMove(screen.getByLabelText('图谱'), { clientX: 5, clientY: 5 })
    drawFrame()
    expect(ctx.fillText).not.toHaveBeenCalledWith('好友', expect.any(Number), expect.any(Number))
  })

  it('keeps names visible when zoomed out and reveals a full long name on hover', () => {
    const name = '这是一位拥有很长名字的来自北岸远方的旅者😀'
    render(<BookGraphView items={[{ ...items[0], name }, items[1]]} />)
    const canvas = screen.getByLabelText('图谱')
    drawFrame()
    fireEvent.wheel(canvas, { deltaY: 1500, clientX: 400, clientY: 250 })
    drawFrame()
    expect(ctx.fillText).toHaveBeenCalledWith(`${Array.from(name).slice(0, 17).join('')}…`, expect.any(Number), expect.any(Number))
    expect(ctx.fillText).toHaveBeenCalledWith(items[1].name, expect.any(Number), expect.any(Number))
    const [x, y] = ctx.arc.mock.calls[0]
    fireEvent.pointerMove(canvas, toScreen(x, y))
    drawFrame()
    expect(ctx.fillText).toHaveBeenCalledWith(name, expect.any(Number), expect.any(Number))
    fireEvent.pointerCancel(canvas)
    drawFrame()
    expect(ctx.fillText).not.toHaveBeenCalledWith('好友', expect.any(Number), expect.any(Number))
  })

  it('rebinds wheel listeners and keeps drawing when entering and leaving full screen', () => {
    const remove = vi.spyOn(HTMLCanvasElement.prototype, 'removeEventListener')
    const { unmount } = render(<BookGraphView items={items} />)
    const original = screen.getByLabelText('图谱')
    drawFrame()
    fireEvent.click(screen.getByRole('button', { name: '全屏图谱' }))
    const fullscreenCanvas = screen.getByLabelText('图谱')
    expect(fullscreenCanvas).not.toBe(original)
    drawFrame()
    const beforeZoom = ctx.scale.mock.lastCall![0]
    fireEvent.wheel(fullscreenCanvas, { deltaY: 600, clientX: 400, clientY: 250 })
    drawFrame()
    expect(ctx.scale.mock.lastCall![0]).toBeLessThan(beforeZoom)
    fireEvent.click(screen.getByRole('button', { name: '退出全屏' }))
    const restoredCanvas = screen.getByLabelText('图谱')
    expect(restoredCanvas).not.toBe(fullscreenCanvas)
    drawFrame()
    const restoredZoom = ctx.scale.mock.lastCall![0]
    fireEvent.wheel(restoredCanvas, { deltaY: 600, clientX: 400, clientY: 250 })
    drawFrame()
    expect(ctx.scale.mock.lastCall![0]).toBeLessThan(restoredZoom)
    expect(remove).toHaveBeenCalledWith('wheel', expect.any(Function))
    expect(ctx.fillText).toHaveBeenCalledWith(items[0].name, expect.any(Number), expect.any(Number))
    unmount()
    expect(frames.size).toBe(0)
  })
})
