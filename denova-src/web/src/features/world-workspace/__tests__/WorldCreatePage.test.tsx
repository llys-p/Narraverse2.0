import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorldCreatePage } from '../pages/WorldCreatePage'
import type { WorldCreateInput } from '../types'

const mocks = vi.hoisted(() => ({
  createWorld: vi.fn(),
  getBooks: vi.fn(),
  getStories: vi.fn(),
}))

vi.mock('../world-api', () => ({ createWorld: mocks.createWorld }))
vi.mock('@/lib/api-client', () => ({ getBooks: mocks.getBooks }))
vi.mock('@/features/interactive/api', () => ({ getInteractiveStories: mocks.getStories }))

// 手动路径：绑定一个真实角色模板（生成“手动角色”实例）
vi.mock('../components/BindingPicker', () => ({
  WORLD_CREATE_BINDING_SEMANTIC_TYPES: ['character', 'world', 'rule', 'item', 'other'],
  BindingPicker: ({ open, onBind }: { open: boolean; onBind: (b: unknown) => void }) => open ? (
    <button
      onClick={() => onBind({
        bindingId: 'b-manual', masterItemId: 'char-1', recordKind: 'character_template',
        semanticType: 'character', nameSnapshot: '手动角色', tagsSnapshot: [],
        masterRevision: 'sha256:char-1', scope: 'entity', boundAt: '2026-09-10T00:00:00Z',
      })}
    >
      mock-bind
    </button>
  ) : null,
}))

// AI 路径：直接回调一份 AI 应用结果（含 AI 角色 + 世界设定）
vi.mock('../components/AiStructureAnalyzer', () => ({
  AiStructureAnalyzer: ({ open, onApply }: { open: boolean; onApply: (i: unknown) => void }) => open ? (
    <button
      onClick={() => onApply({
        name: 'AI 世界',
        bindings: [{
          bindingId: 'b-ai', masterItemId: 'char-2', recordKind: 'character_template',
          semanticType: 'character', nameSnapshot: 'AI角色', tagsSnapshot: [],
          masterRevision: 'sha256:char-2', scope: 'entity', boundAt: '2026-09-10T00:00:00Z',
        }],
        characters: [{ id: 'ai-1', bindingId: 'b-ai', displayName: 'AI角色' }],
        worldSetting: { tone: 'AI基调', rules: ['AI规则'] },
      } as unknown as WorldCreateInput)}
    >
      mock-apply
    </button>
  ) : null,
}))

vi.mock('@/components/layout/feature-page-shell', () => ({
  FeaturePageShell: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createWorld.mockResolvedValue({ world: { id: 'w1' }, revision: 'r' })
  mocks.getBooks.mockResolvedValue([])
  mocks.getStories.mockResolvedValue({ stories: [] })
})

describe('WorldCreatePage AI 应用合并', () => {
  it('手动角色与 AI 角色同时存在，AI 结果不覆盖用户草稿', async () => {
    const user = userEvent.setup()
    const onCreated = vi.fn()
    render(<WorldCreatePage onCancel={vi.fn()} onCreated={onCreated} />)

    await user.type(await screen.findByPlaceholderText('例如：雾港纪年'), '测试世界')

    // step1 → step2 → step3
    await user.click(screen.getByRole('button', { name: /下一步/ }))
    await user.click(screen.getByRole('button', { name: /下一步/ }))

    // 手动绑定角色（先打开选择器，再触发绑定）
    await user.click(screen.getByText('从总资料库绑定'))
    await user.click(screen.getByRole('button', { name: 'mock-bind' }))
    // 打开 AI 分析并应用
    await user.click(screen.getByText('AI 分析资料'))
    await user.click(screen.getByRole('button', { name: 'mock-apply' }))

    // step3 → step4 → 提交
    await user.click(screen.getByRole('button', { name: /下一步/ }))
    await user.click(screen.getByRole('button', { name: /完成创世/ }))

    await waitFor(() => expect(mocks.createWorld).toHaveBeenCalledTimes(1))
    const input = mocks.createWorld.mock.calls[0][0] as WorldCreateInput

    // 手动角色与 AI 角色同时存在
    expect(input.characters?.map((c) => c.displayName)).toEqual(['手动角色', 'AI角色'])
    expect(input.bindings?.map((b) => b.masterItemId)).toEqual(['char-1', 'char-2'])
    // 用户未填 tone/rules → 采用 AI 值
    expect(input.worldSetting).toEqual({ tone: 'AI基调', rules: ['AI规则'] })
    expect(input.name).toBe('测试世界')
    expect(onCreated).toHaveBeenCalledWith('w1')
  })
})
