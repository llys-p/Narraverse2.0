import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { RotateCcw, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LoreItem } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { presetActionButtonClassName as actionButtonClassName } from '../preset-config/editor-styles'
import { loreTypeLabel } from './editor-shared'

// 关系图谱：节点是资料条目，连线完全派生自「一个条目的正文提到另一个条目的名称」，
// 与 Obsidian 图谱同一思路（它由 [[双链]] 派生，这里没有双链字段，用正文提及近似）。
// 不新增后端字段、不持久化关系数据；纯本地计算 + canvas 自绘力导向布局。

export interface LoreGraphNode {
  id: string
  name: string
  type: LoreItem['type']
  enabled: boolean
  degree: number
}

export interface LoreGraphEdge {
  source: string
  target: string
  mentions: number
}

export interface LoreGraph {
  nodes: LoreGraphNode[]
  edges: LoreGraphEdge[]
}

// 一字名（中文名常见单字）太容易误命中，至少两个字才参与连线。
const MIN_MENTION_NAME_LENGTH = 2

const GRAPH_TYPE_ORDER: LoreItem['type'][] = ['character', 'location', 'faction', 'rule', 'item', 'world', 'other']

const TYPE_COLORS: Record<LoreItem['type'], string> = {
  character: '#ef6f6c',
  location: '#4cc38a',
  faction: '#e0af68',
  rule: '#7aa2f7',
  item: '#bb9af7',
  world: '#4fd6c8',
  other: '#9aa3b2',
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

// 纯 ASCII 名（如 Ed）要求整词命中，避免 "Ed" 吃进 "Edmund"；
// 中文名按子串命中。入参 haystack / name 都已小写。
function countWholeWord(haystack: string, name: string): number {
  let count = 0
  let index = haystack.indexOf(name)
  while (index >= 0) {
    const before = index > 0 ? haystack[index - 1] : ''
    const after = haystack[index + name.length] || ''
    const isWordChar = (ch: string) => /[a-z0-9]/.test(ch)
    if (!isWordChar(before) && !isWordChar(after)) count += 1
    index = haystack.indexOf(name, index + 1)
  }
  return count
}

export function deriveLoreGraph(items: LoreItem[]): LoreGraph {
  const haystacks = items.map((item) => `${item.name}\n${item.brief_description || ''}\n${item.content || ''}`.toLowerCase())
  const counts = new Map<string, number>()
  for (let i = 0; i < items.length; i += 1) {
    const text = haystacks[i]
    for (let j = 0; j < items.length; j += 1) {
      if (i === j) continue
      const name = items[j].name.trim()
      if (name.length < MIN_MENTION_NAME_LENGTH) continue
      const lowered = name.toLowerCase()
      // 用小写形式判定 ASCII（'Ed' 含大写，需先归一）。
      const hits = /^[a-z0-9_'’ -]+$/.test(lowered) ? countWholeWord(text, lowered) : countOccurrences(text, lowered)
      if (hits <= 0) continue
      const [a, b] = items[i].id < items[j].id ? [items[i].id, items[j].id] : [items[j].id, items[i].id]
      const key = `${a}\u0000${b}`
      counts.set(key, (counts.get(key) || 0) + Math.min(hits, 5))
    }
  }
  const degree = new Map<string, number>()
  const edges: LoreGraphEdge[] = []
  for (const [key, mentions] of counts) {
    const [source, target] = key.split('\u0000')
    edges.push({ source, target, mentions })
    degree.set(source, (degree.get(source) || 0) + 1)
    degree.set(target, (degree.get(target) || 0) + 1)
  }
  const nodes: LoreGraphNode[] = items.map((item) => ({
    id: item.id,
    name: item.name,
    type: item.type,
    enabled: item.enabled !== false,
    degree: degree.get(item.id) || 0,
  }))
  return { nodes, edges }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

export interface PickingNode {
  id: string
  x: number
  y: number
  r: number
}

export function pickNodeAt(nodes: PickingNode[], x: number, y: number, pad = 0): string | null {
  // 后画的节点在上层：从数组尾部向前找。
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]
    const dx = node.x - x
    const dy = node.y - y
    const reach = node.r + pad
    if (dx * dx + dy * dy <= reach * reach) return node.id
  }
  return null
}

interface SimNode {
  id: string
  name: string
  type: LoreItem['type']
  enabled: boolean
  r: number
  x: number
  y: number
  vx: number
  vy: number
}

interface VisibleModel {
  nodes: SimNode[]
  byId: Map<string, SimNode>
  edges: LoreGraphEdge[]
  adjacency: Map<string, Set<string>>
}

// 力学参数：斥力与引力的比值决定节点间距，弹簧把有关系的节点拉近。
const SIM = {
  repulsion: 3600,
  restLength: 90,
  spring: 0.05,
  gravity: 0.008,
  damping: 0.82,
  maxSpeed: 14,
  decay: 0.985,
  stop: 0.015,
  reheat: 0.45,
}

function nodeRadius(degree: number) {
  return Math.min(16, 3.5 + Math.sqrt(degree) * 1.8)
}

function stepSimulation(model: VisibleModel, alpha: number) {
  const nodes = model.nodes
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i]
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let d2 = dx * dx + dy * dy
      if (d2 < 1) {
        // 完全重叠时给一个确定性的扰动方向，避免除零与 NaN。
        dx = ((i * 7 + j * 13) % 10) / 10 + 0.1
        dy = ((i * 11 + j * 3) % 10) / 10 + 0.1
        d2 = dx * dx + dy * dy
      }
      const force = (SIM.repulsion * alpha) / d2
      const inv = 1 / Math.sqrt(d2)
      a.vx -= dx * inv * force
      a.vy -= dy * inv * force
      b.vx += dx * inv * force
      b.vy += dy * inv * force
    }
  }
  for (const edge of model.edges) {
    const a = model.byId.get(edge.source)
    const b = model.byId.get(edge.target)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01
    const force = (d - SIM.restLength) * SIM.spring * alpha
    const inv = 1 / d
    a.vx += dx * inv * force
    a.vy += dy * inv * force
    b.vx -= dx * inv * force
    b.vy -= dy * inv * force
  }
  for (const node of nodes) {
    node.vx -= node.x * SIM.gravity * alpha
    node.vy -= node.y * SIM.gravity * alpha
    node.vx *= SIM.damping
    node.vy *= SIM.damping
    const speed2 = node.vx * node.vx + node.vy * node.vy
    if (speed2 > SIM.maxSpeed * SIM.maxSpeed) {
      const scale = SIM.maxSpeed / Math.sqrt(speed2)
      node.vx *= scale
      node.vy *= scale
    }
    node.x += node.vx
    node.y += node.vy
  }
}

function themeColors(container: HTMLElement) {
  const style = getComputedStyle(container)
  const read = (name: string, fallback: string) => (style.getPropertyValue(name) || '').trim() || fallback
  return {
    text: read('--nova-text', '#1f2328'),
    faint: read('--nova-text-faint', '#8b949e'),
    bg: read('--nova-surface-2', '#ffffff'),
    accent: read('--nova-accent', '#4c7ef3'),
  }
}

type PointerState =
  | { kind: 'idle' }
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'node'; id: string; moved: boolean; startClientX: number; startClientY: number }

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

  const graph = useMemo(() => deriveLoreGraph(items), [items])
  const hasNodes = graph.nodes.length > 0
  const visibleNodes = useMemo(() => graph.nodes.filter((node) => !hidden.has(node.type)), [graph, hidden])
  const stats = useMemo(() => {
    const visibleIds = new Set(visibleNodes.map((node) => node.id))
    const edges = graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    return t('settingPanel.bookOverview.graphStats', { nodes: visibleNodes.length, edges: edges.length })
  }, [graph, hidden, t, visibleNodes])

  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const mountedRef = useRef(true)
  const frameRef = useRef(0)
  const frameTypeRef = useRef<'animation' | 'timeout' | null>(null)
  const alphaRef = useRef(1)
  const hoverRef = useRef<string | null>(null)
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

    for (const edge of model.edges) {
      const a = model.byId.get(edge.source)
      const b = model.byId.get(edge.target)
      if (!a || !b) continue
      const highlighted = hovered !== null && (edge.source === hovered || edge.target === hovered)
      let alpha = 0.12 + Math.min(edge.mentions, 5) * 0.035
      if (focusIds) alpha = highlighted ? 0.9 : 0.05
      ctx.globalAlpha = alpha
      ctx.strokeStyle = highlighted ? theme.accent : theme.faint
      ctx.lineWidth = (highlighted ? 1.6 : 1) / view.zoom
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }

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

    // 标签画在屏幕空间，字号不随缩放变化。
    if (focusIds) {
      ctx.globalAlpha = 1
      ctx.font = '11px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      for (const node of model.nodes) {
        if (!focusIds.has(node.id)) continue
        const sx = node.x * view.zoom + width / 2 + view.panX
        const sy = node.y * view.zoom + height / 2 + view.panY + node.r * view.zoom + 4
        const label = node.name.length > 18 ? `${node.name.slice(0, 17)}…` : node.name
        ctx.lineWidth = 3
        ctx.strokeStyle = theme.bg
        ctx.strokeText(label, sx, sy)
        ctx.fillStyle = theme.text
        ctx.fillText(label, sx, sy)
      }
    }
    ctx.globalAlpha = 1
  }
  drawRef.current = draw

  const frame = useCallback(() => {
    frameRef.current = 0
    frameTypeRef.current = null
    if (!mountedRef.current) return
    const alpha = alphaRef.current
    if (alpha > SIM.stop) {
      stepSimulation(modelRef.current, alpha)
      alphaRef.current = alpha * SIM.decay
    }
    drawRef.current()
    if (alphaRef.current > SIM.stop) scheduleRef.current()
  }, [])

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
    if (prevGraphRef.current !== graph) {
      prevGraphRef.current = graph
      fitView()
      alphaRef.current = 1
    } else {
      alphaRef.current = Math.max(alphaRef.current, SIM.reheat)
    }
    schedule()
  }, [fitView, graph, hidden, schedule, visibleNodes])

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
  }, [hasNodes])

  useEffect(() => {
    if (!hasNodes) return
    const observer = new MutationObserver(() => scheduleRef.current())
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [hasNodes])

  // 滚轮缩放要 preventDefault，React 的合成 onWheel 是 passive 的，必须挂原生监听。
  useEffect(() => {
    if (!hasNodes) return
    const canvas = canvasRef.current
    if (!canvas) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
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
  }, [hasNodes])

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
      const world = worldFromScreen(point.x, point.y)
      const id = pickNodeAt(modelRef.current.nodes, world.x, world.y, 3 / viewRef.current.zoom)
      if (id !== hoverRef.current) {
        hoverRef.current = id
        if (canvasRef.current) canvasRef.current.style.cursor = id ? 'pointer' : 'grab'
      }
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
    if (hoverRef.current) {
      hoverRef.current = null
      if (canvasRef.current) canvasRef.current.style.cursor = 'grab'
    }
    schedule()
  }

  const handlePointerCancel = () => {
    pointerRef.current = { kind: 'idle' }
    schedule()
  }

  const handleDoubleClick = () => {
    fitView()
    schedule()
  }

  const handleReset = () => {
    fitView()
    schedule()
  }

  if (graph.nodes.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <p className="max-w-[420px] text-center text-xs leading-6 text-[var(--nova-text-faint)]">
          {t('settingPanel.bookOverview.graphEmpty')}
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-56 shrink-0 flex-col gap-3 border-r border-[var(--nova-border)] p-3">
        <div className="nova-field flex h-8 items-center gap-2 rounded-[var(--nova-radius)] px-2 text-xs text-[var(--nova-text-faint)]">
          <Search className="h-3.5 w-3.5" />
          <input
            className="min-w-0 flex-1 bg-transparent text-[var(--nova-text-muted)] outline-none placeholder:text-[var(--nova-text-faint)]"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('settingPanel.bookOverview.graphSearch')}
            aria-label={t('settingPanel.bookOverview.graphSearch')}
          />
        </div>

        <div className="flex flex-col gap-0.5">
          <p className="mb-1 text-[11px] text-[var(--nova-text-faint)]">{t('settingPanel.bookOverview.graphFilterTitle')}</p>
          {GRAPH_TYPE_ORDER.map((type) => {
            const count = items.filter((item) => item.type === type).length
            if (!count) return null
            const checked = !hidden.has(type)
            return (
              <label
                key={type}
                className="flex min-h-7 cursor-pointer items-center gap-2 rounded px-1 text-xs text-[var(--nova-text-muted)] hover:bg-[var(--nova-hover)]"
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[var(--nova-accent)]"
                  checked={checked}
                  onChange={() => {
                    setHidden((current) => {
                      const next = new Set(current)
                      if (next.has(type)) next.delete(type)
                      else next.add(type)
                      return next
                    })
                  }}
                  aria-label={loreTypeLabel(type, t)}
                />
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: TYPE_COLORS[type] }} />
                <span className="min-w-0 flex-1 truncate">{loreTypeLabel(type, t)}</span>
                <span className="text-[11px] text-[var(--nova-text-faint)]">{count}</span>
              </label>
            )
          })}
        </div>

        <div className="mt-auto flex flex-col gap-2">
          <p className="text-[11px] leading-5 text-[var(--nova-text-faint)]">{stats}</p>
          <p className="text-[11px] leading-5 text-[var(--nova-text-faint)]">{t('settingPanel.bookOverview.graphHint')}</p>
          <Button className={actionButtonClassName} variant="outline" size="sm" onClick={handleReset}>
            <RotateCcw data-icon="inline-start" />
            {t('settingPanel.bookOverview.graphResetView')}
          </Button>
        </div>
      </aside>

      <div ref={containerRef} className="relative min-h-0 min-w-0 flex-1">
        <canvas
          ref={canvasRef}
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
}
