export interface RelationHitArea {
  id: string
  source: string
  target: string
  start: { x: number; y: number }
  control: { x: number; y: number }
  end: { x: number; y: number }
}

export function pickRelationAt(
  edges: readonly RelationHitArea[], x: number, y: number, tolerance: number,
): string | null {
  if (tolerance < 0) return null
  let closestID: string | null = null
  let closestDistanceSquared = Infinity
  const toleranceSquared = tolerance * tolerance

  // Approximate the quadratic curve itself, never the chord between endpoints.
  for (const edge of edges) {
    let previous = edge.start
    for (let segment = 1; segment <= 24; segment += 1) {
      const t = segment / 24
      const u = 1 - t
      const point = {
        x: u * u * edge.start.x + 2 * u * t * edge.control.x + t * t * edge.end.x,
        y: u * u * edge.start.y + 2 * u * t * edge.control.y + t * t * edge.end.y,
      }
      const dx = point.x - previous.x
      const dy = point.y - previous.y
      const lengthSquared = dx * dx + dy * dy
      const projection = lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, ((x - previous.x) * dx + (y - previous.y) * dy) / lengthSquared))
      const offsetX = x - (previous.x + projection * dx)
      const offsetY = y - (previous.y + projection * dy)
      const distanceSquared = offsetX * offsetX + offsetY * offsetY
      if (distanceSquared <= toleranceSquared && distanceSquared < closestDistanceSquared) {
        closestDistanceSquared = distanceSquared
        closestID = edge.id
      }
      previous = point
    }
  }
  return closestID
}
