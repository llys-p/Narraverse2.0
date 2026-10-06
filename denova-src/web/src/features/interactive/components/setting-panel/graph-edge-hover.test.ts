import { describe, expect, it } from 'vitest'
import { pickRelationAt } from './graph-edge-hover'
import type { RelationHitArea } from './graph-edge-hover'

const straight: RelationHitArea = {
  id: 'straight', source: 'a', target: 'b',
  start: { x: 0, y: 0 }, control: { x: 50, y: 0 }, end: { x: 100, y: 0 },
}

const curved: RelationHitArea = {
  ...straight, id: 'curved', control: { x: 50, y: 100 },
}

describe('pickRelationAt', () => {
  it('hits a straight relation within tolerance, including the exact boundary', () => {
    expect(pickRelationAt([straight], 25, 3, 3)).toBe('straight')
    expect(pickRelationAt([straight], 50, 0, 0)).toBe('straight')
  })

  it('returns null outside tolerance and beyond segment endpoints', () => {
    expect(pickRelationAt([straight], 50, 4, 3)).toBeNull()
    expect(pickRelationAt([straight], 104, 0, 3)).toBeNull()
  })

  it('hits the actual bowed quadratic Bezier curve', () => {
    // B(0.5) = (50, 50); the control point itself is not on the curve.
    expect(pickRelationAt([curved], 50, 50, 1)).toBe('curved')
    expect(pickRelationAt([curved], 50, 100, 3)).toBeNull()
  })

  it('does not mistake the chord between curved endpoints for the relation', () => {
    expect(pickRelationAt([curved], 50, 0, 3)).toBeNull()
  })

  it('checks every nearby relation and chooses the closest regardless of order', () => {
    const nearer = { ...curved, id: 'nearer', control: { x: 50, y: 102 } }
    const edges = [curved, nearer]
    const before = structuredClone(edges)
    expect(pickRelationAt(edges, 50, 50.8, 3)).toBe('nearer')
    expect(pickRelationAt([...edges].reverse(), 50, 50.8, 3)).toBe('nearer')
    expect(edges).toEqual(before)
  })

  it('uses caller-provided world tolerance for zoomed hit testing', () => {
    const screenTolerance = 6
    expect(pickRelationAt([straight], 50, 8, screenTolerance / 0.5)).toBe('straight')
    expect(pickRelationAt([straight], 50, 8, screenTolerance / 2)).toBeNull()
  })

  it('returns null for no relations', () => {
    expect(pickRelationAt([], 0, 0, 5)).toBeNull()
  })

  it('handles a collapsed curve as a point without dividing by zero', () => {
    const point: RelationHitArea = {
      id: 'point', source: 'a', target: 'b',
      start: { x: 10, y: 20 }, control: { x: 10, y: 20 }, end: { x: 10, y: 20 },
    }
    expect(pickRelationAt([point], 10, 20, 0)).toBe('point')
    expect(pickRelationAt([point], 14, 20, 3)).toBeNull()
  })
})
