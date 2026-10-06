import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { LoreItem } from '@/lib/api'
import { pickRelationAt, type RelationHitArea } from './graph-edge-hover'

import {
  TYPE_COLORS, GOLDEN_ANGLE, SIM, deriveLoreGraph, matchesCharacterTier,
  relationControlPoint, nodeRadius, stepSimulation, themeColors, pickNodeAt,
} from './book-graph-model'
import type { CharacterTierFilter, SimNode, VisibleModel, PointerState, LoreGraph, LoreGraphEdge } from './book-graph-model'
import { BookGraphControls } from './BookGraphControls'
import { projectGraphView } from './book-graph-view-model'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
export { deriveLoreGraph, pickNodeAt, relationControlPoint } from './book-graph-model'
export type { LoreGraphNode, LoreGraphEdge, LoreGraph, PickingNode } from './book-graph-model'
export function BookGraphView({
  items,
  onOpenItem,
}: {
  items: LoreItem[]
  onOpenItem?: (id: string) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [characterTierFilter, setCharacterTierFilter] = useState<CharacterTierFilter>('all')

  const [showInferred, setShowInferred] = useState(false)
  const [relationLabel, setRelationLabel] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [depth, setDepth] = useState<1 | 2>(1)
  const [spacing, setSpacing] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)
  const [canvasElement, setCanvasElement] = useState<HTMLCanvasElement | null>(null)
  const visibleItems = useMemo(
    () => items.filter((item) => !hidden.has(item.type) && matchesCharacterTier(item, characterTierFilter)),
    [items, hidden, characterTierFilter],
  )
  const baseGraph = useMemo(() => deriveLoreGraph(visibleItems), [visibleItems])
  const activeFocusId = baseGraph.nodes.some((node) => node.id === focusId) ? focusId : null
  const relationLabels = useMemo(() => [...new Set(baseGraph.edges.filter((edge) => edge.confirmed).map((edge) => edge.label!.trim()))].sort(), [baseGraph])
  const activeRelationLabel = relationLabel && relationLabels.includes(relationLabel) ? relationLabel : null
  const graph = useMemo(() => projectGraphView(baseGraph, {
    showInferred, relationLabel: activeRelationLabel, focusId: activeFocusId, depth,
  }), [baseGraph, showInferred, activeRelationLabel, activeFocusId, depth])
  const hasNodes = graph.nodes.length > 0
  const visibleNodes = graph.nodes

  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const bindCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas
    setCanvasElement(canvas)
  }, [])
  const spacingRef = useRef(spacing)
  const fitAfterLayoutRef = useRef(true)
  const mountedRef = useRef(true)
  const frameRef = useRef(0)
  const frameTypeRef = useRef<'animation' | 'timeout' | null>(null)
  const alphaRef = useRef(1)
  const hoverRef = useRef<string | null>(null)
  const hoverEdgeRef = useRef<string | null>(null)
  const hoverPointRef = useRef<{ x: number; y: number } | null>(null)
  const relationHitAreasRef = useRef<RelationHitArea[]>([])
  const queryRef = useRef('')
  const viewRef = useRef({ zoom: 1, panX: 0, panY: 0 })
  const modelRef = useRef<VisibleModel>({ nodes: [], byId: new Map(), edges: [], adjacency: new Map() })
  const pointerRef = useRef<PointerState>({ kind: 'idle' })
  const scheduleRef = useRef<() => void>(() => {})
  const drawRef = useRef<() => void>(() => {})

  const fitView = useCallback(() => {
    const container = containerRef.current
    const nodes = modelRef.current.nodes
    if (!container || nodes.length === 0) {
      viewRef.current = { zoom: 1, panX: 0, panY: 0 }
      return
    }
    const width = container.clientWidth
    const height = container.clientHeight
    if (width <= 0 || height <= 0) {
      viewRef.current = { zoom: 1, panX: 0, panY: 0 }
      return
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const node of nodes) {
      minX = Math.min(minX, node.x)
      minY = Math.min(minY, node.y)
      maxX = Math.max(maxX, node.x)
      maxY = Math.max(maxY, node.y)
    }
    const pad = 60
    const boundsWidth = Math.max(maxX - minX, 1)
    const boundsHeight = Math.max(maxY - minY, 1)
    const zoom = Math.min(2.5, Math.max(0.15, Math.min((width - pad * 2) / boundsWidth, (height - pad * 2) / boundsHeight)))
    viewRef.current = {
      zoom,
      panX: -((minX + maxX) / 2) * zoom,
      panY: -((minY + maxY) / 2) * zoom,
    }
  }, [])

  const draw = () => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || !mountedRef.current) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const width = container.clientWidth
    const height = container.clientHeight
    if (width <= 0 || height <= 0) return
    const dpr = window.devicePixelRatio || 1
    const pixelWidth = Math.round(width * dpr)
    const pixelHeight = Math.round(height * dpr)
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }

    const theme = themeColors(container)
    const view = viewRef.current
    const model = modelRef.current
    const trimmedQuery = queryRef.current.trim().toLowerCase()
    const hovered = hoverRef.current

    const matchIds = trimmedQuery
      ? new Set(model.nodes.filter((node) => node.name.toLowerCase().includes(trimmedQuery)).map((node) => node.id))
      : null
    const focusIds: Set<string> | null = hovered
      ? new Set([hovered, ...(model.adjacency.get(hovered) || [])])
      : matchIds

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.save()
    ctx.translate(width / 2 + view.panX, height / 2 + view.panY)
    ctx.scale(view.zoom, view.zoom)

    const edgeGroups = new Map<string, LoreGraphEdge[]>()
    const relationHitAreas: RelationHitArea[] = []
    for (const edge of model.edges) {
      const pair = [edge.source, edge.target].sort().join('\u0000')
      const group = edgeGroups.get(pair) || []
      group.push(edge)
      edgeGroups.set(pair, group)
    }
    for (const edge of model.edges) {
      const a = model.byId.get(edge.source)
      const b = model.byId.get(edge.target)
      if (!a || !b) continue
      const highlighted = (hovered !== null && (edge.source === hovered || edge.target === hovered))
        || (edge.id !== undefined && edge.id === hoverEdgeRef.current)
      let alpha = edge.confirmed ? 0.65 : 0.12 + Math.min(edge.mentions, 5) * 0.035
      if (focusIds) alpha = highlighted ? 0.9 : 0.05
      ctx.globalAlpha = alpha
      ctx.strokeStyle = highlighted || edge.confirmed ? theme.accent : theme.faint
      ctx.lineWidth = (highlighted ? 1.6 : edge.confirmed ? 1.35 : 1) / view.zoom
      const pair = [edge.source, edge.target].sort().join('\u0000')
      const group = edgeGroups.get(pair) || [edge]
      const edgeIndex = group.indexOf(edge)
      const dx = b.x - a.x
      const dy = b.y - a.y
      const length = Math.hypot(dx, dy) || 1
      const control = relationControlPoint(a, b, edge.confirmed ? edgeIndex : 0, edge.confirmed ? group.length : 1)
      const controlX = control.x
      const controlY = control.y
      const startX = edge.confirmed ? a.x + dx / length * a.r : a.x
      const startY = edge.confirmed ? a.y + dy / length * a.r : a.y
      const endX = edge.confirmed ? b.x - dx / length * b.r : b.x
      const endY = edge.confirmed ? b.y - dy / length * b.r : b.y
      if (edge.confirmed && edge.id) relationHitAreas.push({ id: edge.id, source: edge.source, target: edge.target,
        start: { x: startX, y: startY }, control, end: { x: endX, y: endY } })
      ctx.setLineDash(edge.confirmed ? [] : [3 / view.zoom, 4 / view.zoom])
      ctx.beginPath()
      ctx.moveTo(startX, startY)
      if (edge.confirmed) ctx.quadraticCurveTo(controlX, controlY, endX, endY)
      else ctx.lineTo(endX, endY)
      ctx.stroke()
      ctx.setLineDash([])
      if (edge.confirmed) {
        const angle = Math.atan2(endY - controlY, endX - controlX)
        const arrowSize = 7 / view.zoom
        ctx.beginPath()
        ctx.moveTo(endX, endY)
        ctx.lineTo(endX - arrowSize * Math.cos(angle - Math.PI / 6), endY - arrowSize * Math.sin(angle - Math.PI / 6))
        ctx.lineTo(endX - arrowSize * Math.cos(angle + Math.PI / 6), endY - arrowSize * Math.sin(angle + Math.PI / 6))
        ctx.closePath()
        ctx.fillStyle = theme.accent
        ctx.fill()

        if (highlighted) {
          const label = edge.label || ''
          const sx = (startX + 2 * controlX + endX) / 4
          const sy = (startY + 2 * controlY + endY) / 4
          ctx.globalAlpha = 1
          ctx.font = `${10 / view.zoom}px system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.lineWidth = 3 / view.zoom
          ctx.strokeStyle = theme.bg
          ctx.strokeText(label, sx, sy)
          ctx.fillStyle = theme.text
          ctx.fillText(label, sx, sy)
        }
      }
    }
    relationHitAreasRef.current = relationHitAreas

    for (const node of model.nodes) {
      const alpha = focusIds ? (focusIds.has(node.id) ? 1 : 0.12) : 0.95
      const color = TYPE_COLORS[node.type] || TYPE_COLORS.other
      ctx.beginPath()
      ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2)
      if (node.enabled) {
        ctx.globalAlpha = alpha
        ctx.fillStyle = color
        ctx.fill()
      } else {
        // 未启用的条目画空心，避免「看着在图里、其实没进上下文」的误会。
        ctx.globalAlpha = alpha * 0.3
        ctx.fillStyle = color
        ctx.fill()
        ctx.globalAlpha = alpha
        ctx.strokeStyle = color
        ctx.lineWidth = 1.2 / view.zoom
        ctx.stroke()
      }
      if (matchIds?.has(node.id)) {
        ctx.globalAlpha = 1
        ctx.strokeStyle = theme.accent
        ctx.lineWidth = 1.5 / view.zoom
        ctx.beginPath()
        ctx.arc(node.x, node.y, node.r + 3 / view.zoom, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    ctx.restore()

    // 所有节点名称常显，屏幕空间字号不随缩放变化；悬停显示完整长名称。
    ctx.globalAlpha = 1
    ctx.font = '11px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const node of model.nodes) {
      const sx = node.x * view.zoom + width / 2 + view.panX
      const sy = node.y * view.zoom + height / 2 + view.panY + node.r * view.zoom + 4
      const characters = Array.from(node.name)
      const label = node.id !== hovered && characters.length > 18 ? `${characters.slice(0, 17).join('')}…` : node.name
      ctx.lineWidth = 3
      ctx.strokeStyle = theme.bg
      ctx.strokeText(label, sx, sy)
      ctx.fillStyle = theme.text
      ctx.fillText(label, sx, sy)
    }
    ctx.globalAlpha = 1
    // 力学布局移动后重新命中，避免鼠标静止时留下已移走的关系标签。
    const point = hoverPointRef.current
    if (point && pointerRef.current.kind === 'idle') {
      const x = (point.x - width / 2 - view.panX) / view.zoom
      const y = (point.y - height / 2 - view.panY) / view.zoom
      const nodeID = pickNodeAt(model.nodes, x, y, 3 / view.zoom)
      const edgeID = nodeID ? null : pickRelationAt(relationHitAreas, x, y, 6 / view.zoom)
      if (nodeID !== hoverRef.current || edgeID !== hoverEdgeRef.current) {
        hoverRef.current = nodeID
        hoverEdgeRef.current = edgeID
        canvas.style.cursor = nodeID || edgeID ? 'pointer' : 'grab'
        scheduleRef.current()
      }
    }
  }
  drawRef.current = draw

  const frame = useCallback(() => {
    frameRef.current = 0
    frameTypeRef.current = null
    if (!mountedRef.current) return
    const alpha = alphaRef.current
    if (alpha > SIM.stop) {
      stepSimulation(modelRef.current, alpha, spacingRef.current)
      alphaRef.current = alpha * SIM.decay
    }
    if (fitAfterLayoutRef.current && alphaRef.current <= SIM.stop) {
      fitView()
      fitAfterLayoutRef.current = false
    }
    drawRef.current()
    if (alphaRef.current > SIM.stop) scheduleRef.current()
  }, [fitView])

  const schedule = useCallback(() => {
    if (frameRef.current) return
    if (typeof requestAnimationFrame === 'function') {
      frameTypeRef.current = 'animation'
      frameRef.current = requestAnimationFrame(frame)
    } else {
      // 没有 rAF 的环境（部分测试）退到定时器，保证至少画出初始布局。
      frameTypeRef.current = 'timeout'
      frameRef.current = window.setTimeout(() => {
        frameRef.current = 0
        frameTypeRef.current = null
        frame()
      }, 16)
    }
  }, [frame])
  scheduleRef.current = schedule

  const prevGraphRef = useRef<LoreGraph | null>(null)
  const prevCanvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (frameRef.current) {
        if (frameTypeRef.current === 'animation') cancelAnimationFrame(frameRef.current)
        else if (frameTypeRef.current === 'timeout') clearTimeout(frameRef.current)
      }
      frameRef.current = 0
      frameTypeRef.current = null
    }
  }, [])

  // 模型重建：类型过滤改变可见集合；items 变化（换书/改条目）时重新适配视图。
  useEffect(() => {
    const keep = new Map(modelRef.current.nodes.map((node) => [node.id, node]))
    let index = 0
    const nodes: SimNode[] = visibleNodes.map((node) => {
      const old = keep.get(node.id)
      index += 1
      const sim: SimNode = old
        ? { ...node, r: nodeRadius(node.degree), x: old.x, y: old.y, vx: old.vx, vy: old.vy }
        : {
            ...node,
            r: nodeRadius(node.degree),
            x: Math.cos(index * GOLDEN_ANGLE) * 26 * Math.sqrt(index),
            y: Math.sin(index * GOLDEN_ANGLE) * 26 * Math.sqrt(index),
            vx: 0,
            vy: 0,
          }
      return sim
    })
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const adjacency = new Map<string, Set<string>>()
    const edges = graph.edges.filter((edge) => byId.has(edge.source) && byId.has(edge.target))
    for (const edge of edges) {
      for (const id of [edge.source, edge.target]) {
        const set = adjacency.get(id) || new Set<string>()
        set.add(id === edge.source ? edge.target : edge.source)
        adjacency.set(id, set)
      }
    }
    modelRef.current = { nodes, byId, edges, adjacency }
    hoverRef.current = null
    hoverEdgeRef.current = null
    hoverPointRef.current = null
    relationHitAreasRef.current = []
    if (prevGraphRef.current !== graph || prevCanvasRef.current !== canvasElement) {
      prevGraphRef.current = graph
      prevCanvasRef.current = canvasElement
      fitView()
      alphaRef.current = 1
      fitAfterLayoutRef.current = true
    } else {
      alphaRef.current = Math.max(alphaRef.current, SIM.reheat)
    }
    schedule()
  }, [fitView, graph, schedule, visibleNodes, canvasElement])

  useEffect(() => {
    queryRef.current = query
    schedule()
  }, [query, schedule])

  useEffect(() => {
    if (!hasNodes) return
    const container = containerRef.current
    if (!container) return
    const onResize = () => scheduleRef.current()
    window.addEventListener('resize', onResize)
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null
    observer?.observe(container)
    return () => {
      window.removeEventListener('resize', onResize)
      observer?.disconnect()
    }
  }, [hasNodes, canvasElement])

  useEffect(() => {
    if (!hasNodes) return
    const observer = new MutationObserver(() => scheduleRef.current())
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [hasNodes, canvasElement])

  // 滚轮缩放要 preventDefault，React 的合成 onWheel 是 passive 的，必须挂原生监听。
  useEffect(() => {
    if (!hasNodes) return
    const canvas = canvasRef.current
    if (!canvas) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      fitAfterLayoutRef.current = false
      const container = containerRef.current
      if (!container) return
      const rect = canvas.getBoundingClientRect()
      const sx = event.clientX - rect.left
      const sy = event.clientY - rect.top
      const width = container.clientWidth
      const height = container.clientHeight
      const view = viewRef.current
      const worldX = (sx - width / 2 - view.panX) / view.zoom
      const worldY = (sy - height / 2 - view.panY) / view.zoom
      const zoom = Math.min(3.5, Math.max(0.15, view.zoom * Math.exp(-event.deltaY * 0.0015)))
      view.panX = sx - width / 2 - worldX * zoom
      view.panY = sy - height / 2 - worldY * zoom
      view.zoom = zoom
      scheduleRef.current()
    }
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [hasNodes, canvasElement])

  const toCanvasPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const worldFromScreen = (sx: number, sy: number) => {
    const container = containerRef.current
    const view = viewRef.current
    const width = container?.clientWidth || 0
    const height = container?.clientHeight || 0
    return { x: (sx - width / 2 - view.panX) / view.zoom, y: (sy - height / 2 - view.panY) / view.zoom }
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return
    fitAfterLayoutRef.current = false
    const point = toCanvasPoint(event)
    const world = worldFromScreen(point.x, point.y)
    const id = pickNodeAt(modelRef.current.nodes, world.x, world.y, 3 / viewRef.current.zoom)
    if (id) {
      pointerRef.current = { kind: 'node', id, moved: false, startClientX: event.clientX, startClientY: event.clientY }
    } else {
      pointerRef.current = { kind: 'pan', lastX: point.x, lastY: point.y }
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 非活动指针时忽略，拖拽在该环境下退化为仅移动内生效。
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const pointer = pointerRef.current
    const point = toCanvasPoint(event)
    if (pointer.kind === 'node') {
      if (Math.hypot(event.clientX - pointer.startClientX, event.clientY - pointer.startClientY) > 4) {
        pointer.moved = true
      }
      if (pointer.moved) {
        const node = modelRef.current.byId.get(pointer.id)
        if (node) {
          const world = worldFromScreen(point.x, point.y)
          node.x = world.x
          node.y = world.y
          node.vx = 0
          node.vy = 0
          alphaRef.current = Math.max(alphaRef.current, SIM.reheat)
        }
      }
    } else if (pointer.kind === 'pan') {
      const view = viewRef.current
      view.panX += point.x - pointer.lastX
      view.panY += point.y - pointer.lastY
      pointer.lastX = point.x
      pointer.lastY = point.y
    } else {
      hoverPointRef.current = point
      const world = worldFromScreen(point.x, point.y)
      const id = pickNodeAt(modelRef.current.nodes, world.x, world.y, 3 / viewRef.current.zoom)
      hoverRef.current = id
      hoverEdgeRef.current = id ? null : pickRelationAt(relationHitAreasRef.current, world.x, world.y, 6 / viewRef.current.zoom)
      if (canvasRef.current) canvasRef.current.style.cursor = id || hoverEdgeRef.current ? 'pointer' : 'grab'
    }
    schedule()
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const pointer = pointerRef.current
    if (pointer.kind === 'node' && !pointer.moved) onOpenItem?.(pointer.id)
    pointerRef.current = { kind: 'idle' }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // 同 pointerdown：无捕获可释放时忽略。
    }
  }

  const handlePointerLeave = () => {
    pointerRef.current = { kind: 'idle' }
    hoverRef.current = null
    hoverEdgeRef.current = null
    hoverPointRef.current = null
    if (canvasRef.current) canvasRef.current.style.cursor = 'grab'
    schedule()
  }

  const handlePointerCancel = () => {
    handlePointerLeave()
  }

  const handleDoubleClick = () => {
    fitView()
    schedule()
  }

  useEffect(() => {
    spacingRef.current = spacing
    alphaRef.current = 1
    fitAfterLayoutRef.current = true
    schedule()
  }, [spacing, schedule])

  const handleReset = () => {
    fitView()
    schedule()
  }

  if (items.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <p className="max-w-[420px] text-center text-xs leading-6 text-[var(--nova-text-faint)]">
          {t('settingPanel.bookOverview.graphEmpty')}
        </p>
      </div>
    )
  }

  const content = (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
      <BookGraphControls
        items={items} graph={graph} baseNodes={baseGraph.nodes}
        query={query} setQuery={setQuery} hidden={hidden} setHidden={setHidden}
        characterTierFilter={characterTierFilter} setCharacterTierFilter={setCharacterTierFilter}
        showInferred={showInferred} setShowInferred={setShowInferred}
        relationLabel={activeRelationLabel} setRelationLabel={setRelationLabel} relationLabels={relationLabels}
        focusId={activeFocusId} setFocusId={setFocusId} depth={depth} setDepth={setDepth}
        spacing={spacing} setSpacing={setSpacing} fullscreen={fullscreen}
        onFullscreen={() => setFullscreen((value) => !value)} onOpenItem={onOpenItem} handleReset={handleReset}
      />

      <div ref={containerRef} className="relative min-h-64 min-w-0 flex-1 md:min-h-0">
        <canvas
          ref={bindCanvas}
          className="absolute inset-0 h-full w-full touch-none"
          aria-label={t('settingPanel.bookOverview.graphMode')}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onLostPointerCapture={handlePointerCancel}
          onPointerLeave={handlePointerLeave}
          onDoubleClick={handleDoubleClick}
        />
      </div>
    </div>
  )
  return fullscreen ? (
    <Dialog open onOpenChange={setFullscreen}>
      <DialogContent
        className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col gap-2 p-3 max-md:max-h-[calc(100dvh-2rem)]"
        showCloseButton={false}
      >
        <div className="flex shrink-0 items-center justify-between gap-2">
          <DialogTitle>{t('settingPanel.bookOverview.graphFullscreenTitle')}</DialogTitle>
          <Button variant="outline" size="sm" onClick={() => setFullscreen(false)}>{t('settingPanel.bookOverview.graphExitFullscreen')}</Button>
        </div>
        <DialogDescription className="sr-only">{t('settingPanel.bookOverview.graphHint')}</DialogDescription>
        {content}
      </DialogContent>
    </Dialog>
  ) : content
}
