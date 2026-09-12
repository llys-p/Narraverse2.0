import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorldContextPanel, type ContextPreviewPanelState } from '../components/context/WorldContextPanel'
import type { World } from '../types'
import { emptyContextSelection, type WorldContextUIView } from '../world-context'

function worldFixture(): World {
  return {
    id: 'w1', schemaVersion: 1, name: '面板世界', status: 'active',
    bindings: [
      { bindingId: 'bw', masterItemId: 'mw', recordKind: 'lorebook_template', semanticType: 'rule', nameSnapshot: '世界规则集', tagsSnapshot: ['标签甲'], scope: 'world', masterRevision: 'r', boundAt: '' },
    ],
    characters: [
      { id: 'c1', displayName: '角色甲' },
      { id: 'c2', displayName: '角色乙' },
    ],
    locations: [{ id: 'l1', name: '地点甲' }],
    factions: [{ id: 'f1', name: '势力甲' }],
    timeline: [{ id: 't1', order: 0, title: '事件甲', category: 'historical' }],
    createdAt: '', updatedAt: '',
  }
}

function viewFixture(): WorldContextUIView {
  return {
    schemaVersion: 1, worldId: 'w1', worldRevision: 'sha256:r1', consumer: 'writing',
    contextFingerprint: 'v1|abcdef1234567890',
    canonicalSelection: {
      includeTone: true, ruleIndexes: [0], characterIds: ['c1'], locationIds: ['l1'],
      factionIds: ['f1'], timelineEntryIds: ['t1'], bindingIds: ['bw'],
    },
    identity: { name: '面板世界', tagline: '一句话', genre: '奇幻', summary: '世界简介' },
    setting: { tone: '冷峻', rules: ['铁律一'] },
    characters: [{
      id: 'c1', displayName: '角色甲', role: '主角', worldNote: '角色备注',
      factionId: 'f1', locationId: 'l1',
      relationships: [{ targetCharacterId: 'c2', label: '盟友' }],
    }],
    locations: [{ id: 'l1', name: '地点甲', description: '地点简介', tags: ['地名标签'] }],
    factions: [{ id: 'f1', name: '势力甲', description: '势力简介', headquartersLocationId: '' }],
    timeline: [{ id: 't1', order: 0, eraLabel: '第一纪', title: '事件甲', description: '事件简介', category: 'historical' }],
    materials: [{ bindingId: 'bw', masterItemId: 'mw', name: '世界规则集', tags: ['标签甲'], semanticType: 'rule', scope: 'world' }],
    omissions: [
      { kind: 'character_location', ownerEntityId: 'c1', missingEntityId: 'l1', reason: 'target_not_selected' },
      { kind: 'mystery_kind', ownerEntityId: 'x1', missingEntityId: 'x2', reason: 'weird_reason' },
    ],
    warnings: [
      { code: 'legacy_timeline_category', refKind: 'timeline', refId: 't1' },
      { code: 'binding_unchecked', refKind: 'binding', refId: 'bw' },
      { code: 'future_code' },
    ],
    stats: { characterCount: 1, locationCount: 1, factionCount: 1, timelineCount: 1, materialCount: 1 },
    sourceTable: {
      identity: { kind: 'identity' },
      'character:c1': { kind: 'character', entityId: 'c1' },
      'location:l1': { kind: 'location', entityId: 'l1' },
      'binding:bw': { kind: 'material', bindingId: 'bw', masterItemId: 'mw' },
      'future:z': { kind: 'future_kind' },
    },
    revisionLabel: 'r1', isDraftPreview: false,
  }
}

type PanelProps = Parameters<typeof WorldContextPanel>[0]

function setup(overrides: Partial<PanelProps> = {}) {
  const onGenerate = vi.fn()
  const onJump = vi.fn()
  const onSelectionChange = vi.fn()
  const onConsumerChange = vi.fn()
  const props: PanelProps = {
    world: worldFixture(),
    dirty: false,
    consumer: 'writing',
    selection: emptyContextSelection(),
    state: 'ready',
    preview: viewFixture(),
    error: null,
    onGenerate,
    onJumpSection: onJump,
    onSelectionChange,
    onConsumerChange,
    ...overrides,
  }
  const view = render(<WorldContextPanel {...props} />)
  return { ...view, onGenerate, onJump, onSelectionChange, onConsumerChange }
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('WorldContextPanel B2 状态', () => {
  it('idle：显示选择提示，不显示详情', () => {
    setup({ state: 'idle', preview: null })
    expect(screen.getByText('选择内容后生成上下文预览')).toBeInTheDocument()
    expect(screen.queryByTestId('context-preview-detail')).toBeNull()
  })

  it('loading：显示生成中', () => {
    setup({ state: 'loading', preview: null })
    expect(screen.getByText('正在生成上下文预览…')).toBeInTheDocument()
  })

  it('error：显示错误标题', () => {
    setup({ state: 'error', preview: null, error: new Error('网络错误') })
    expect(screen.getByText('上下文预览失败')).toBeInTheDocument()
  })

  it('ready：渲染分段详情；stale：显示过期横幅', () => {
    const { rerender } = setup({ state: 'ready' })
    expect(screen.getByTestId('context-preview-detail')).toBeInTheDocument()
    expect(screen.queryByTestId('context-preview-stale-banner')).toBeNull()
    rerender(<WorldContextPanel {...baseProps('stale')} />)
    expect(screen.getByTestId('context-preview-stale-banner')).toBeInTheDocument()
  })
})

function baseProps(state: ContextPreviewPanelState): PanelProps {
  return {
    world: worldFixture(), dirty: false, consumer: 'writing', selection: emptyContextSelection(),
    state, preview: viewFixture(), error: null,
    onGenerate: vi.fn(), onJumpSection: vi.fn(), onSelectionChange: vi.fn(), onConsumerChange: vi.fn(),
  }
}

describe('WorldContextPanel B2 内容', () => {
  it('渲染各主要分段、canonical、短指纹', () => {
    setup()
    // “世界概览”同时是 Identity 段标题与 identity 来源标签，允许出现多次
    expect(screen.getAllByText('世界概览').length).toBeGreaterThan(0)
    expect(screen.getAllByText('世界设定').length).toBeGreaterThan(0)
    for (const name of ['角色甲', '地点甲', '势力甲', '事件甲', '世界规则集']) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0)
    }
    expect(screen.getByTestId('context-fingerprint').textContent).toContain('abcdef1234…')
    expect(screen.getByText('服务端最终选择')).toBeInTheDocument()
  })

  it('空 Preview：各分段显示未包含、已选内容为空提示', () => {
    const emptyView: WorldContextUIView = {
      schemaVersion: 1, worldId: 'w1', worldRevision: 'r', consumer: 'writing', contextFingerprint: 'v1|zz',
      identity: { name: '空世界' },
      setting: { tone: '', rules: [] },
      characters: [], locations: [], factions: [], timeline: [], materials: [],
      canonicalSelection: { includeTone: false, ruleIndexes: [], characterIds: [], locationIds: [], factionIds: [], timelineEntryIds: [], bindingIds: [] },
      stats: { characterCount: 0, locationCount: 0, factionCount: 0, timelineCount: 0, materialCount: 0 },
      omissions: [], warnings: [], sourceTable: { identity: { kind: 'identity' } },
      revisionLabel: 'r', isDraftPreview: false,
    }
    setup({ preview: emptyView })
    expect(screen.getByText('暂未包含任何条目（仅世界概览）')).toBeInTheDocument()
    expect(screen.getAllByText(/本次未包含/).length).toBeGreaterThan(0)
  })

  it('omissions 映射为可读“谁引用谁 + 原因”，未知 kind 安全降级', () => {
    setup()
    const list = screen.getByTestId('context-omissions')
    expect(list.textContent).toContain('角色“角色甲”所在地点“地点甲”')
    expect(list.textContent).toContain('未纳入本次选择')
    expect(list.textContent).toContain('省略引用')
    expect(list.textContent).not.toContain('x1')
    expect(list.textContent).not.toContain('x2')
  })

  it('warnings 可读映射；binding_unchecked 不写成失效/过期；未知 code 安全展示', () => {
    setup()
    const list = screen.getByTestId('context-warnings')
    expect(list.textContent).toContain('旧版时间线分类')
    expect(list.textContent).toContain('尚未联网检查原件')
    expect(list.textContent).not.toMatch(/失效|不是最新/)
    expect(list.textContent).toContain('future_code')
  })

  it('sourceTable 导航意图：已知来源点击跳转对应分区；未知来源不可跳转', async () => {
    const user = userEvent.setup()
    const { onJump } = setup()
    await user.click(screen.getByRole('button', { name: '跳转到地点' }))
    expect(onJump).toHaveBeenCalledWith('locations')
    const sources = screen.getByTestId('context-sources')
    const unknownRow = sources.querySelector('li[data-source-kind="future_kind"]')!
    // 未知 kind：整行无跳转按钮，且以“未知来源”中性标签呈现（不暴露内部 kind 作为主文案）
    expect(unknownRow.querySelector('button')).toBeNull()
    expect(unknownRow.textContent).toContain('未知来源')
    expect(unknownRow.textContent).not.toContain('future_kind')
  })

  it('内部 ID 不作为主文案：来源显示名称而非 c1', () => {
    setup()
    const sources = screen.getByTestId('context-sources')
    expect(sources.textContent).toContain('角色甲')
    expect(within(sources).queryByRole('button', { name: 'c1' })).toBeNull()
  })

  it('不渲染运行态/模型字段（scopeKey/runContextId/prompt/ModelView）', () => {
    setup()
    const root = screen.getByTestId('world-context-panel')
    expect(root.textContent).not.toMatch(/scopeKey|runContextId|runSalt|sourceRef|ModelView|prompt/i)
  })
})

describe('WorldContextPanel 生成动作', () => {
  it('点击生成只回调一次', async () => {
    const user = userEvent.setup()
    const { onGenerate } = setup({ state: 'idle', preview: null })
    await user.click(screen.getByRole('button', { name: '生成预览' }))
    expect(onGenerate).toHaveBeenCalledTimes(1)
  })

  it('dirty 时禁用生成并提示先保存，点击不回调', async () => {
    const user = userEvent.setup()
    const onGenerate = vi.fn()
    render(<WorldContextPanel {...baseProps('idle')} dirty preview={null} onGenerate={onGenerate} />)
    expect(screen.getByTestId('context-blocked-dirty')).toBeInTheDocument()
    const btn = screen.getByRole('button', { name: '生成预览' })
    expect(btn).toBeDisabled()
    await user.click(btn)
    expect(onGenerate).not.toHaveBeenCalled()
  })

  it('挂载与渲染零 Master 详情/模型请求', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    setup()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
