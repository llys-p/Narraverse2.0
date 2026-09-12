import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorldContextPreviewResult } from '../components/WorldContextPreviewResult'
import { emptyContextSelection, type WorldContextUIView } from '../world-context'

function makeView(overrides: Partial<WorldContextUIView> = {}): WorldContextUIView {
  return {
    schemaVersion: 1,
    worldId: 'w1',
    worldRevision: 'sha256:1',
    consumer: 'writing',
    contextFingerprint: 'v1|x',
    canonicalSelection: emptyContextSelection(),
    identity: { name: '九霄', tagline: '风起云涌', genre: '仙侠', summary: '一个测试世界' },
    characters: [],
    locations: [],
    factions: [],
    timeline: [],
    materials: [],
    omissions: [],
    warnings: [],
    stats: { characterCount: 0, locationCount: 0, factionCount: 0, timelineCount: 0, materialCount: 0 },
    sourceTable: {},
    revisionLabel: 'r1',
    isDraftPreview: false,
    ...overrides,
  }
}

describe('WorldContextPreviewResult 只读展示', () => {
  it('idle：无 preview 时显示占位', () => {
    render(<WorldContextPreviewResult state="idle" preview={null} />)
    expect(screen.getByTestId('context-preview-idle')).toBeInTheDocument()
  })

  it('loading：显示加载态', () => {
    render(<WorldContextPreviewResult state="loading" preview={null} />)
    expect(screen.getByTestId('context-preview-loading')).toBeInTheDocument()
  })

  it('error：显示错误信息并可点击重试', () => {
    const onRetry = vi.fn()
    render(<WorldContextPreviewResult state="error" preview={null} error={new Error('网络断了')} onRetry={onRetry} />)
    const box = screen.getByTestId('context-preview-error')
    expect(box.textContent).toContain('网络断了')
    fireEvent.click(screen.getByRole('button'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('ready：渲染 identity 与已选条目、omissions、warnings', () => {
    const view = makeView({
      characters: [{ id: 'c1', displayName: '林九', relationships: [] }],
      locations: [{ id: 'l1', name: '青云镇', tags: [] }],
      factions: [{ id: 'f1', name: '天剑宗' }],
      timeline: [{ id: 't1', order: 0, title: '开宗立派', category: 'historical' }],
      materials: [{ bindingId: 'b1', masterItemId: 'm1', name: '世界规则集', tags: [], semanticType: 'other', scope: 'world' }],
      omissions: [
        { kind: 'character_faction', ownerEntityId: 'c1', missingEntityId: 'f2', reason: 'target_not_selected' },
      ],
      warnings: [{ code: 'legacy_timeline_category', refId: 't9' }],
    })
    render(<WorldContextPreviewResult state="ready" preview={view} />)

    const identity = screen.getByTestId('context-preview-identity')
    expect(identity.textContent).toContain('九霄')
    expect(identity.textContent).toContain('风起云涌')

    const selected = screen.getByTestId('context-preview-selected')
    expect(selected.textContent).toContain('林九')
    expect(selected.textContent).toContain('青云镇')
    expect(selected.textContent).toContain('天剑宗')
    expect(selected.textContent).toContain('开宗立派')
    expect(selected.textContent).toContain('世界规则集')
    expect(screen.queryByTestId('context-preview-selected-empty')).toBeNull()

    const omissions = screen.getByTestId('context-preview-omissions')
    expect(omissions.textContent).toContain('character_faction')
    expect(omissions.textContent).toContain('c1')
    expect(omissions.textContent).toContain('f2')
    expect(screen.queryByTestId('context-preview-omissions-empty')).toBeNull()

    const warnings = screen.getByTestId('context-preview-warnings')
    expect(warnings.textContent).toContain('legacy_timeline_category')
    expect(screen.queryByTestId('context-preview-warnings-empty')).toBeNull()
  })

  it('空数组：已选/omissions/warnings 都显示明确空态，不渲染成空白', () => {
    render(<WorldContextPreviewResult state="ready" preview={makeView()} />)
    expect(screen.getByTestId('context-preview-selected-empty')).toBeInTheDocument()
    expect(screen.getByTestId('context-preview-omissions-empty')).toBeInTheDocument()
    expect(screen.getByTestId('context-preview-warnings-empty')).toBeInTheDocument()
  })

  it('stale：保留旧 preview 并显示草稿未包含提示', () => {
    render(<WorldContextPreviewResult state="stale" preview={makeView()} />)
    expect(screen.getByTestId('context-preview-stale')).toBeInTheDocument()
    expect(screen.getByTestId('context-preview-identity')).toBeInTheDocument()
  })
})
