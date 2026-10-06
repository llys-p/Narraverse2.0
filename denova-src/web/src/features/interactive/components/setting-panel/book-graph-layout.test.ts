import { describe, expect, it } from 'vitest'
import { stepSimulation, type VisibleModel } from './book-graph-model'

function model(distance = 30): VisibleModel {
  const nodes = ['北岸', '南港'].map((name, i) => ({
    id: String(i), name, type: 'location' as const, enabled: true, r: 5,
    x: i * distance, y: 0, vx: 0, vy: 0,
  }))
  return { nodes, byId: new Map(nodes.map((node) => [node.id, node])), edges: [
    { source: '0', target: '1', mentions: 1, confirmed: true, label: '盟友' },
  ], adjacency: new Map() }
}

describe('graph display spacing', () => {
  it('actually separates connected nodes farther apart at larger spacing', () => {
    const compact = model()
    const spacious = model()
    for (let i = 0; i < 250; i++) {
      stepSimulation(compact, 0.4, 0.7)
      stepSimulation(spacious, 0.4, 2)
    }
    const width = (m: VisibleModel) => Math.abs(m.nodes[1].x - m.nodes[0].x)
    expect(width(spacious)).toBeGreaterThan(width(compact) * 1.5)
  })

  it('separates overlapping names deterministically without non-finite coordinates', () => {
    const a = model(0)
    const b = model(0)
    for (let i = 0; i < 250; i++) { stepSimulation(a, 0.4); stepSimulation(b, 0.4) }
    expect(a.nodes).toEqual(b.nodes)
    expect(a.nodes.every((node) => [node.x, node.y, node.vx, node.vy].every(Number.isFinite))).toBe(true)
    expect(Math.hypot(a.nodes[0].x - a.nodes[1].x, a.nodes[0].y - a.nodes[1].y)).toBeGreaterThan(20)
  })
})
