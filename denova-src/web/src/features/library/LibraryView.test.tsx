import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchMasterAsset, fetchMasterAssetPipeline, fetchMasterAssetProposals, fetchMasterAssetTranslations, fetchMasterAssetUsages, fetchMasterTranslationRuntime, listMasterAssets, retryTranslationJob, startMasterAgent } from '@/lib/api-client'
import { LibraryView } from './LibraryView'

vi.mock('@/components/Chat/ConfigManagerChat', () => ({
  ConfigManagerChat: ({ origin, resourceId, context }: { origin: string; resourceId?: string; context?: Record<string, string> }) => <div data-testid="config-manager-chat" data-origin={origin} data-resource-id={resourceId} data-field-path={context?.field_path} />,
}))

vi.mock('@/lib/api-client', () => ({
  fetchMasterAsset: vi.fn(),
  fetchMasterAssetPipeline: vi.fn(),
  fetchMasterAssetProposals: vi.fn(),
  fetchMasterAssetTranslations: vi.fn(),
  fetchMasterAssetUsages: vi.fn(),
  fetchMasterTranslationRuntime: vi.fn(),
  listMasterAssets: vi.fn(),
  instantiateMasterAsset: vi.fn(),
  retryTranslationJob: vi.fn(),
  startMasterAgent: vi.fn(),
  applyMasterProposal: vi.fn(),
}))

const summary = {
  master_item_id: 'master-aiko',
  name: 'Aiko',
  description: 'A curious alchemist.',
  nested_entry_count: 1,
  record_kind: 'character_template',
  semantic_type: 'character',
  source_id: 'source-card',
  source_name: 'aiko.json',
  source_revision: 'src-r1',
  master_revision: 'master-r1',
  availability: 'usable' as const,
  usage_count: 2,
  pipeline: {
    availability: 'usable' as const,
    nodes: [],
    issues: [],
    translation: { total_fields: 1, active_fields: 1, pending_fields: 0, review_fields: 0, failed_fields: 0, content_version_kind: { hy_mt_active: 1 } },
    usage_count: 2,
  },
}

describe('LibraryView', () => {
  beforeEach(() => {
    vi.mocked(listMasterAssets).mockReset().mockResolvedValue({ assets: [summary], total: 1 })
    vi.mocked(fetchMasterAsset).mockReset().mockResolvedValue({ summary, item: { original: {}, source_semantics: {}, runtime_semantics: {}, nested_entries: [], fields: { 'character.description': { active_text: '好奇而勇敢的炼金术士。' }, 'character.personality': { active_text: '活泼、好奇。' } } }, source: { filename: 'aiko.json' }, source_revision: { revision: 'src-r1', sha256: 'sha', imported_at: '2026-08-29T08:37:18Z' }, translations: [], usages: [] })
    vi.mocked(fetchMasterAssetPipeline).mockReset().mockResolvedValue(summary.pipeline)
    vi.mocked(fetchMasterAssetProposals).mockReset().mockResolvedValue({ proposals: [] })
    vi.mocked(fetchMasterAssetTranslations).mockReset().mockResolvedValue({ translations: [] })
    vi.mocked(fetchMasterAssetUsages).mockReset().mockResolvedValue({ usages: [] })
    vi.mocked(fetchMasterTranslationRuntime).mockReset().mockResolvedValue({ fields: [], active_fields: 1, total_fields: 1, review_fields: 0, failed_fields: 0, queue_paused: false, runtime_available: true })
    vi.mocked(retryTranslationJob).mockReset()
    vi.mocked(startMasterAgent).mockReset()
  })

  it('lists assets and loads all read-only detail projections', async () => {
    const user = userEvent.setup()
    render(<LibraryView />)

    await screen.findByText('A curious alchemist.')
    expect(screen.getByText('1 个内部设定')).toBeInTheDocument()
    expect(screen.getAllByText('可以使用').length).toBeGreaterThan(0)
    expect(screen.queryByText('usable')).not.toBeInTheDocument()

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))

    await waitFor(() => {
      expect(fetchMasterAsset).toHaveBeenCalledWith('master-aiko')
      expect(fetchMasterAssetPipeline).toHaveBeenCalledWith('master-aiko')
      expect(fetchMasterAssetTranslations).toHaveBeenCalledWith('master-aiko')
      expect(fetchMasterAssetUsages).toHaveBeenCalledWith('master-aiko')
    })
    expect(screen.getByText('角色概览')).toBeInTheDocument()
    expect(screen.queryByText('总库资产 ID')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: '技术信息' }))
    expect(screen.getByText('总库资产 ID')).toBeInTheDocument()
  })

  it('retries a failed Master translation through the existing queue API', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterTranslationRuntime).mockResolvedValue({
      fields: [{ field_path: 'mes_example', task_status: 'failed', content_version_status: 'original', review_required: false, task_id: 'job-failed', failure_reason: 'worker timeout' }],
      active_fields: 0,
      total_fields: 1,
      review_fields: 0,
      failed_fields: 1,
      queue_paused: false,
      runtime_available: true,
    })
    vi.mocked(retryTranslationJob).mockResolvedValue({} as never)
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('tab', { name: '处理进度' }))
    await user.click(screen.getByText('查看详细处理过程'))
    await user.click(await screen.findByRole('button', { name: '重试' }))

    await waitFor(() => expect(retryTranslationJob).toHaveBeenCalledWith('job-failed'))
  })

  it('presents translation versions as readable current and historical content', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterAsset).mockResolvedValue({
      summary,
      item: { original: {}, source_semantics: {}, runtime_semantics: {}, nested_entries: [], fields: { 'character.description': { active_translation_version_id: 'version-current', active_text: '当前介绍' } } },
      source: { filename: 'aiko.json' }, source_revision: { revision: 'src-r1', sha256: 'sha', imported_at: '2026-08-29T08:37:18Z' },
      translations: [], usages: [],
    })
    vi.mocked(fetchMasterAssetTranslations).mockResolvedValue({ translations: [
      { content_version_kind: 'hy_mt_active', version: { translation_version_id: 'version-current', field_path: 'character.description', translation: '当前介绍', model: 'qwen', created_at: '2026-08-29T08:37:18Z' } },
      { content_version_kind: 'polish_candidate', version: { translation_version_id: 'version-history', field_path: 'character.description', translation: '历史介绍', model: 'agent', created_at: '2026-08-28T08:37:18Z' } },
    ]} as never)
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('tab', { name: '版本' }))

    expect(screen.getByText('机器初译（当前）')).toBeInTheDocument()
    expect(screen.getByText('当前使用')).toBeInTheDocument()
    expect(screen.getByText('润色候选')).toBeInTheDocument()
    expect(screen.getByText('当前介绍')).toBeInTheDocument()
    expect(screen.getByText('历史介绍')).toBeInTheDocument()
    expect(screen.queryByText('version-current')).not.toBeInTheDocument()
  })

  it('opens the shared Config Manager Agent scoped to the selected Master asset', async () => {
    const user = userEvent.setup()
    render(<LibraryView workspace="E:/books/adventure" />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(await screen.findByRole('button', { name: '配置管理 Agent' }))

    const chat = await screen.findByTestId('config-manager-chat')
    expect(chat).toHaveAttribute('data-origin', 'master-library')
    expect(chat).toHaveAttribute('data-resource-id', 'master-aiko')
  })

  it('previews character edits and passes the selected field to the Agent', async () => {
    const user = userEvent.setup()
    render(<LibraryView workspace="E:/books/adventure" />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('button', { name: '编辑角色卡' }))
    const description = screen.getByDisplayValue('好奇而勇敢的炼金术士。')
    await user.clear(description)
    await user.type(description, '更完整的人物介绍。')
    await user.click(screen.getByRole('button', { name: '预览修改' }))
    expect(screen.getByText('修改预览')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: /让 Agent 处理/ })[0])

    const chat = await screen.findByTestId('config-manager-chat')
    expect(chat).toHaveAttribute('data-field-path', 'character.name')
  })

  it('reads a lorebook through a searchable entry directory', async () => {
    const user = userEvent.setup()
    const loreSummary = { ...summary, master_item_id: 'master-lore', name: '城市设定', description: '城市与港口资料。', record_kind: 'lorebook_template', semantic_type: 'lorebook', nested_entry_count: 2 }
    vi.mocked(listMasterAssets).mockResolvedValue({ assets: [loreSummary], total: 1 })
    vi.mocked(fetchMasterAsset).mockResolvedValue({
      summary: loreSummary,
      item: {
        original: {}, source_semantics: {}, runtime_semantics: {},
        nested_entries: [
          { entry_id: 'entry-port', original: { comment: '评论', content: '繁忙的港口。', key: ['港口'] } },
          { entry_id: 'entry-ship', original: { comment: '飞船', content: '一艘快速飞船。', key: ['飞船'] } },
        ],
        fields: {
          'lorebook.entries/entry-ship/keys': { active_text: '空中艇' },
        },
      },
      source: { filename: 'city.json' }, source_revision: { revision: 'src-r1', sha256: 'sha' }, translations: [], usages: [],
    })
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /城市设定/ }))
    expect(await screen.findByText('繁忙的港口。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '打开目录' }))
    expect(screen.getAllByRole('button', { name: '关闭条目目录' })).toHaveLength(2)
    await user.click(screen.getAllByRole('button', { name: '关闭条目目录' })[0])
    await user.type(screen.getByPlaceholderText('搜索标题、关键词或正文'), '飞船')
    await user.click(screen.getByRole('button', { name: /飞船/ }))
    expect(screen.getByText('一艘快速飞船。')).toBeInTheDocument()
    expect(screen.getByText('空中艇')).toBeInTheDocument()
    expect(screen.queryByText('繁忙的港口。')).not.toBeInTheDocument()
  })
})
