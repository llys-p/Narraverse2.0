import type { LoreGraph } from './book-graph-model'

export function projectGraphView(graph: LoreGraph, options: {
  showInferred: boolean
  relationLabel: string | null
  focusId: string | null
  depth: 1 | 2
}): LoreGraph {
  const adjacency = new Map(graph.nodes.map((node) => [node.id, new Set<string>()]))
  const filteredEdges = graph.edges.filter((edge) => {
    if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) return false
    if (!options.showInferred && edge.confirmed !== true) return false
    if (options.relationLabel !== null) {
      return edge.confirmed === true && edge.label?.trim() === options.relationLabel
    }
    return true
  })
  for (const edge of filteredEdges) {
    adjacency.get(edge.source)!.add(edge.target)
    adjacency.get(edge.target)!.add(edge.source)
  }

  // Invalid focus falls back to the filtered full graph, including isolated nodes.
  let selected = new Set(adjacency.keys())
  if (options.focusId !== null && adjacency.has(options.focusId)) {
    selected = new Set([options.focusId])
    let frontier = [options.focusId]
    for (let layer = 0; layer < options.depth; layer += 1) {
      const next: string[] = []
      for (const id of frontier) {
        for (const neighbor of adjacency.get(id)!) {
          if (selected.has(neighbor)) continue
          selected.add(neighbor)
          next.push(neighbor)
        }
      }
      frontier = next
    }
  }

  return {
    nodes: graph.nodes.filter((node) => selected.has(node.id)).map((node) => ({
      ...node,
      degree: [...adjacency.get(node.id)!].filter((id) => selected.has(id)).length,
    })),
    edges: filteredEdges.filter((edge) => selected.has(edge.source) && selected.has(edge.target)),
  }
}
