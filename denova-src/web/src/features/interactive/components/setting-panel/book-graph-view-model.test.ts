import { describe, expect, it } from 'vitest'
import type { LoreGraph, LoreGraphNode } from './book-graph-model'
import { projectGraphView } from './book-graph-view-model'

function node(id: string, degree = 99): LoreGraphNode {
  return { id, name: id, type: 'character', enabled: true, degree }
}

function fixture(): LoreGraph {
  return {
    nodes: ['c', 'a', 'd', 'b', 'isolated'].map((id) => node(id)),
    edges: [
      { id: 'ba', source: 'b', target: 'a', mentions: 1, confirmed: true, label: ' 好友 ' },
      { id: 'bc', source: 'b', target: 'c', mentions: 1, confirmed: true, label: '同盟' },
      { id: 'cd', source: 'c', target: 'd', mentions: 1, confirmed: true, label: '好友' },
      { id: 'ad', source: 'a', target: 'd', mentions: 2, label: '好友' },
      { id: 'dangling', source: 'a', target: 'missing', mentions: 1, confirmed: true, label: '好友' },
    ],
  }
}

const all = { showInferred: true, relationLabel: null, focusId: null, depth: 1 } as const

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

describe('projectGraphView', () => {
  it('keeps isolated nodes and input order, discards dangling edges, and recomputes degrees', () => {
    const graph = fixture()
    expect(projectGraphView(graph, all)).toEqual({
      nodes: [node('c', 2), node('a', 2), node('d', 2), node('b', 2), node('isolated', 0)],
      edges: graph.edges.slice(0, 4),
    })
  })

  it('hides inferred edges without removing any full-graph nodes', () => {
    const graph = fixture()
    expect(projectGraphView(graph, { ...all, showInferred: false })).toEqual({
      nodes: [node('c', 2), node('a', 1), node('d', 1), node('b', 2), node('isolated', 0)],
      edges: graph.edges.slice(0, 3),
    })
  })

  it('matches trimmed confirmed labels and never includes inferred edges with that label', () => {
    const graph = fixture()
    expect(projectGraphView(graph, { ...all, relationLabel: '好友' })).toEqual({
      nodes: [node('c', 1), node('a', 1), node('d', 1), node('b', 1), node('isolated', 0)],
      edges: [graph.edges[0], graph.edges[2]],
    })
  })

  it('retains full-graph nodes when no confirmed relation matches the label', () => {
    expect(projectGraphView(fixture(), { ...all, relationLabel: '不存在' })).toEqual({
      nodes: ['c', 'a', 'd', 'b', 'isolated'].map((id) => node(id, 0)), edges: [],
    })
  })

  it('finds one undirected layer through a reverse-directed edge', () => {
    const graph = fixture()
    expect(projectGraphView(graph, { ...all, showInferred: false, focusId: 'a' })).toEqual({
      nodes: [node('a', 1), node('b', 1)], edges: [graph.edges[0]],
    })
  })

  it('finds exactly two layers and excludes edges to the third layer', () => {
    const graph = fixture()
    expect(projectGraphView(graph, { ...all, showInferred: false, focusId: 'a', depth: 2 })).toEqual({
      nodes: [node('c', 1), node('a', 1), node('b', 2)], edges: graph.edges.slice(0, 2),
    })
  })

  it('traverses only the edges remaining after inferred and relation-label filters', () => {
    const graph = fixture()
    expect(projectGraphView(graph, { ...all, relationLabel: '好友', focusId: 'a', depth: 2 })).toEqual({
      nodes: [node('a', 1), node('b', 1)], edges: [graph.edges[0]],
    })
  })

  it('handles cycles and includes every surviving edge whose endpoints were selected', () => {
    const graph = fixture()
    graph.edges.push({ id: 'ca', source: 'c', target: 'a', mentions: 1, confirmed: true, label: '同盟' })
    expect(projectGraphView(graph, { ...all, showInferred: false, focusId: 'a', depth: 2 })).toEqual({
      nodes: [node('c', 3), node('a', 2), node('d', 1), node('b', 2)],
      edges: [graph.edges[0], graph.edges[1], graph.edges[2], graph.edges[5]],
    })
  })

  it('counts distinct neighbors once across parallel and reciprocal relations', () => {
    const graph: LoreGraph = {
      nodes: [node('b'), node('a')],
      edges: [
        { id: 'one', source: 'a', target: 'b', mentions: 1, confirmed: true, label: '好友' },
        { id: 'two', source: 'a', target: 'b', mentions: 1, confirmed: true, label: '同盟' },
        { id: 'back', source: 'b', target: 'a', mentions: 1, confirmed: true, label: '竞争' },
      ],
    }
    expect(projectGraphView(graph, all)).toEqual({ nodes: [node('b', 1), node('a', 1)], edges: graph.edges })
  })

  it('keeps a valid isolated focus instead of falling back to other nodes', () => {
    expect(projectGraphView(fixture(), { ...all, focusId: 'isolated', depth: 2 })).toEqual({
      nodes: [node('isolated', 0)], edges: [],
    })
  })

  it('falls back to the filtered full graph when the focus ID is missing', () => {
    const graph = fixture()
    expect(projectGraphView(graph, { ...all, showInferred: false, focusId: 'missing' })).toEqual({
      nodes: [node('c', 2), node('a', 1), node('d', 1), node('b', 2), node('isolated', 0)],
      edges: graph.edges.slice(0, 3),
    })
  })

  it('returns an empty graph for no data even with a stale focus', () => {
    expect(projectGraphView({ nodes: [], edges: [] }, { ...all, focusId: 'a', depth: 2 })).toEqual({ nodes: [], edges: [] })
  })

  it('does not mutate deeply frozen graph or options', () => {
    const graph = deepFreeze(fixture())
    const options = deepFreeze({ ...all, showInferred: false, focusId: 'a', depth: 2 as const })
    const before = structuredClone({ graph, options })
    expect(projectGraphView(graph, options)).toEqual({
      nodes: [node('c', 1), node('a', 1), node('b', 2)], edges: graph.edges.slice(0, 2),
    })
    expect({ graph, options }).toEqual(before)
  })
})
