import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AiStructureAnalyzer } from '../components/AiStructureAnalyzer'
import type { MasterAssetSummary } from '@/lib/api-client'
import type { StructureProposal } from '../types'

const mocks = vi.hoisted(() => ({ listMasterAssets: vi.fn(), analyzeWorldStructure: vi.fn() }))
vi.mock('@/lib/api-client', () => ({ listMasterAssets: mocks.listMasterAssets }))
vi.mock('../world-api', () => ({ analyzeWorldStructure: mocks.analyzeWorldStructure }))

const BASE = { name: '测试世界' }

function asset(id: string, name: string): MasterAssetSummary {
  return {
    master_item_id: id, name, tags: [], nested_entry_count: 0,
    record_kind: 'character_template', semantic_type: 'character',
    source_id: 's', source_name: 's', source_revision: 'r', master_revision: 'sha256:' + id,
    availability: 'usable', usage_count: 0,
    pipeline: { availability: 'usable', nodes: [], issues: [] },
  } as unknown as MasterAssetSummary
}

function proposalFixture(): StructureProposal {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-10T00:00:00Z',
    sourceRefs: [{ id: 's0', kind: 'master_field', masterItemId: 'c1', masterRevision: 'sha256:c1', fieldPath: 'character.name', label: '角色A' }],
    bindingCandidates: [],
    characters: [{ proposalItemId: 'p1', sourceRefIds: ['s0'], confidence: 'high', displayName: '提案角色' }],
    locations: [],
    factions: [],
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function renderAnalyzer(props: Partial<React.ComponentProps<typeof AiStructureAnalyzer>> = {}) {
  const onClose = vi.fn()
  const onApply = vi.fn()
  const utils = render(<AiStructureAnalyzer open base={BASE} onClose={onClose} onApply={onApply} {...props} />)
  return { ...utils, onClose, onApply }
}

async function selectFirstAsset(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByText('角色A'))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listMasterAssets.mockResolvedValue({ assets: [asset('c1', '角色A')], total: 1 })
})

describe('AiStructureAnalyzer 稳定性', () => {
  it('关闭后可重新打开（无 Hook 顺序错误）', async () => {
    const { rerender } = render(<AiStructureAnalyzer open base={BASE} onClose={vi.fn()} onApply={vi.fn()} />)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(await screen.findByText('角色A')).toBeInTheDocument()

    rerender(<AiStructureAnalyzer open={false} base={BASE} onClose={vi.fn()} onApply={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()

    rerender(<AiStructureAnalyzer open base={BASE} onClose={vi.fn()} onApply={vi.fn()} />)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(await screen.findByText('角色A')).toBeInTheDocument()
  })

  it('关闭未确认 proposal 时清理临时状态，且不触发 onApply', async () => {
    const user = userEvent.setup()
    mocks.analyzeWorldStructure.mockResolvedValue({ proposal: proposalFixture() })
    const { rerender, onApply } = renderAnalyzer()

    await selectFirstAsset(user)
    await user.click(screen.getByRole('button', { name: /请求分析/ }))
    expect(await screen.findByDisplayValue('提案角色')).toBeInTheDocument()

    rerender(<AiStructureAnalyzer open={false} base={BASE} onClose={vi.fn()} onApply={onApply} />)
    rerender(<AiStructureAnalyzer open base={BASE} onClose={vi.fn()} onApply={onApply} />)

    await waitFor(() => expect(screen.queryByDisplayValue('提案角色')).toBeNull())
    // 回到资料选择视图，未确认提案未进入手动创建流程
    expect(await screen.findByText('选择资料来源')).toBeInTheDocument()
    expect(onApply).not.toHaveBeenCalled()
  })

  it('关闭时使在途请求失效，旧响应不得覆盖新状态', async () => {
    const user = userEvent.setup()
    const pending = deferred<{ proposal: StructureProposal }>()
    mocks.analyzeWorldStructure.mockReturnValue(pending.promise)
    const { rerender, onApply } = renderAnalyzer()

    await selectFirstAsset(user)
    await user.click(screen.getByRole('button', { name: /请求分析/ }))
    await waitFor(() => expect(mocks.analyzeWorldStructure).toHaveBeenCalledTimes(1))

    // 关闭弹窗（请求仍在途）
    rerender(<AiStructureAnalyzer open={false} base={BASE} onClose={vi.fn()} onApply={onApply} />)
    // 在途请求此刻才返回
    await act(async () => {
      pending.resolve({ proposal: proposalFixture() })
      await Promise.resolve()
    })

    // 旧响应不得把 proposal 写回
    expect(screen.queryByDisplayValue('提案角色')).toBeNull()
  })

  it('关闭时中止在途请求（AbortSignal 已 aborted）', async () => {
    const user = userEvent.setup()
    const pending = deferred<{ proposal: StructureProposal }>()
    mocks.analyzeWorldStructure.mockReturnValue(pending.promise)
    const { rerender, onApply } = renderAnalyzer()

    await selectFirstAsset(user)
    await user.click(screen.getByRole('button', { name: /请求分析/ }))
    await waitFor(() => expect(mocks.analyzeWorldStructure).toHaveBeenCalledTimes(1))

    const signal = mocks.analyzeWorldStructure.mock.calls[0][1] as AbortSignal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)

    rerender(<AiStructureAnalyzer open={false} base={BASE} onClose={vi.fn()} onApply={onApply} />)
    expect(signal.aborted).toBe(true)

    await act(async () => {
      pending.resolve({ proposal: proposalFixture() })
      await Promise.resolve()
    })
    expect(screen.queryByDisplayValue('提案角色')).toBeNull()
  })
})
