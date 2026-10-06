import type { LoreItem } from '@/lib/api'

// 关系图谱节点来自本书 Lore；明确关系与旧版正文提及线都在前端派生，不写回图谱。

export interface LoreGraphNode {
  id: string
  name: string
  type: LoreItem['type']
  enabled: boolean
  degree: number
}

export interface LoreGraphEdge {
  id?: string
  source: string
  target: string
  mentions: number
  confirmed?: true
  label?: string
  note?: string
}

export interface LoreGraph {
  nodes: LoreGraphNode[]
  edges: LoreGraphEdge[]
}

export type CharacterTierFilter = 'all' | 'core' | 'major' | 'minor' | 'unclassified'

export const CHARACTER_TIER_FILTERS: CharacterTierFilter[] = ['all', 'core', 'major', 'minor', 'unclassified']

export function matchesCharacterTier(item: LoreItem, filter: CharacterTierFilter) {
  if (item.type !== 'character' || filter === 'all') return true
  const tier = item.character_tier || 'unclassified'
  if (filter === 'core') return tier !== 'minor'
  return tier === filter
}

export function relationControlPoint(
  source: { id: string; x: number; y: number },
  target: { id: string; x: number; y: number },
  edgeIndex: number,
  edgeCount: number,
) {
  // Use one canonical perpendicular for both directions so reciprocal labels do not overlap.
  const direction = source.id < target.id ? 1 : -1
  const dx = (target.x - source.x) * direction
  const dy = (target.y - source.y) * direction
  const length = Math.hypot(dx, dy) || 1
  const offset = (edgeIndex - (edgeCount - 1) / 2) * 18
  return {
    x: (source.x + target.x) / 2 - dy / length * offset,
    y: (source.y + target.y) / 2 + dx / length * offset,
  }
}

// 一字名（中文名常见单字）太容易误命中，至少两个字才参与连线。
const MIN_MENTION_NAME_LENGTH = 2

export const GRAPH_TYPE_ORDER: LoreItem['type'][] = ['character', 'location', 'faction', 'rule', 'item', 'world', 'other']

export const TYPE_COLORS: Record<LoreItem['type'], string> = {
  character: '#ef6f6c',
  location: '#4cc38a',
  faction: '#e0af68',
  rule: '#7aa2f7',
  item: '#bb9af7',
  world: '#4fd6c8',
  other: '#9aa3b2',
}

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

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
  const itemIDs = new Set(items.map((item) => item.id))
  const relations: LoreGraphEdge[] = []
  const explicitPairs = new Set<string>()
  const relationIDs = new Set<string>()
  for (const item of items) {
    for (const relation of item.relations || []) {
      if (!itemIDs.has(relation.target_id) || relation.target_id === item.id || !relation.label.trim()) continue
      const id = JSON.stringify([item.id, relation.target_id, relation.label, relation.note || ''])
      if (relationIDs.has(id)) continue
      relationIDs.add(id)
      explicitPairs.add([item.id, relation.target_id].sort().join('\u0000'))
      relations.push({
        id,
        source: item.id,
        target: relation.target_id,
        mentions: 1,
        confirmed: true,
        label: relation.label,
        note: relation.note,
      })
    }
  }
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
      if (explicitPairs.has(`${a}\u0000${b}`)) continue
      const key = `${a}\u0000${b}`
      counts.set(key, (counts.get(key) || 0) + Math.min(hits, 5))
    }
  }
  const neighbors = new Map<string, Set<string>>()
  const edges: LoreGraphEdge[] = []
  for (const [key, mentions] of counts) {
    const [source, target] = key.split('\u0000')
    edges.push({ source, target, mentions })
  }
  edges.push(...relations)
  for (const edge of edges) {
    neighbors.set(edge.source, (neighbors.get(edge.source) || new Set()).add(edge.target))
    neighbors.set(edge.target, (neighbors.get(edge.target) || new Set()).add(edge.source))
  }
  const nodes: LoreGraphNode[] = items.map((item) => ({
    id: item.id,
    name: item.name,
    type: item.type,
    enabled: item.enabled !== false,
    degree: neighbors.get(item.id)?.size || 0,
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

export interface SimNode {
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

export interface VisibleModel {
  nodes: SimNode[]
  byId: Map<string, SimNode>
  edges: LoreGraphEdge[]
  adjacency: Map<string, Set<string>>
}

// 力学参数：斥力与引力的比值决定节点间距，弹簧把有关系的节点拉近。
export const SIM = {
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

export function nodeRadius(degree: number) {
  return Math.min(16, 3.5 + Math.sqrt(degree) * 1.8)
}

export function stepSimulation(model: VisibleModel, alpha: number, spacing = 1) {
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
      // Keep names apart as well as circles. Spacing changes layout only.
      const labelReach = (Math.min(18, [...a.name].length) + Math.min(18, [...b.name].length)) * 3 + 16
      const collision = Math.max(0, Math.max(a.r + b.r + 12, labelReach) * spacing - Math.sqrt(d2)) * 0.12
      const force = ((SIM.repulsion * 2.5 * spacing * spacing) / d2 + collision) * alpha
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
    const force = (d - SIM.restLength * 1.6 * spacing) * SIM.spring * alpha
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

export function themeColors(container: HTMLElement) {
  const style = getComputedStyle(container)
  const read = (name: string, fallback: string) => (style.getPropertyValue(name) || '').trim() || fallback
  return {
    text: read('--nova-text', '#1f2328'),
    faint: read('--nova-text-faint', '#8b949e'),
    bg: read('--nova-surface-2', '#ffffff'),
    accent: read('--nova-accent', '#4c7ef3'),
  }
}

export type PointerState =
  | { kind: 'idle' }
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'node'; id: string; moved: boolean; startClientX: number; startClientY: number }
