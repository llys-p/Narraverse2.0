import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addMasterCharacterEntry, addMasterLorebookEntry, applyMasterProposal, applyMasterProposals, createLoreItem, createMasterProposal, deleteTranslationJob, fetchMasterAsset, fetchMasterAssetAdventureUsage, fetchMasterAssetPipeline, fetchMasterAssetProposals, fetchMasterAssetTranslations, fetchMasterAssetUsages, fetchMasterTranslationRuntime, instantiateMasterAsset, listMasterAssets, rejectMasterProposal, rejectMasterProposals, removeMasterAsset, resolveTranslationJob, retryTranslationJob, startMasterAgent, stopMasterAsset, syncMasterAssetToAdventure, updateMasterAssetDescription, updateMasterAssetFields, validateMasterProposal } from '@/lib/api-client'
import { LibraryView } from './LibraryView'

vi.mock('@/components/Chat/ConfigManagerChat', () => ({
  ConfigManagerChat: ({ origin, resourceId, context }: { origin: string; resourceId?: string; context?: Record<string, string> }) => <div data-testid="config-manager-chat" data-origin={origin} data-resource-id={resourceId} data-field-path={context?.field_path} />,
}))

vi.mock('@/lib/api-client', () => ({
  addMasterCharacterEntry: vi.fn(),
  addMasterLorebookEntry: vi.fn(),
  fetchMasterAsset: vi.fn(),
  fetchMasterAssetPipeline: vi.fn(),
  fetchMasterAssetProposals: vi.fn(),
  fetchMasterAssetTranslations: vi.fn(),
  fetchMasterAssetUsages: vi.fn(),
  fetchMasterAssetAdventureUsage: vi.fn(),
  syncMasterAssetToAdventure: vi.fn(),
  updateMasterAssetDescription: vi.fn(),
  updateMasterAssetFields: vi.fn(),
  createLoreItem: vi.fn(),
  fetchMasterTranslationRuntime: vi.fn(),
  listMasterAssets: vi.fn(),
  instantiateMasterAsset: vi.fn(),
  stopMasterAsset: vi.fn(),
  removeMasterAsset: vi.fn(),
  resolveTranslationJob: vi.fn(),
  deleteTranslationJob: vi.fn(),
  retryTranslationJob: vi.fn(),
  startMasterAgent: vi.fn(),
  applyMasterProposal: vi.fn(),
  applyMasterProposals: vi.fn(),
  rejectMasterProposal: vi.fn(),
  rejectMasterProposals: vi.fn(),
  createMasterProposal: vi.fn(),
  validateMasterProposal: vi.fn(),
}))

const summary = {
  master_item_id: 'master-aiko',
  name: 'Aiko',
  tags: ['Anime', 'Love'],
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
    vi.mocked(fetchMasterAssetAdventureUsage).mockReset().mockResolvedValue({ usage: { used: false, has_new_version: false } })
    vi.mocked(syncMasterAssetToAdventure).mockReset().mockResolvedValue({ result: { master_item_id: 'master-aiko', updated_lore_ids: ['lore-1'], skipped: false }, usage: { used: true, has_new_version: false } } as never)
    vi.mocked(updateMasterAssetDescription).mockReset().mockResolvedValue({ item: {} } as never)
    vi.mocked(updateMasterAssetFields).mockReset().mockResolvedValue({ item: {} } as never)
  vi.mocked(addMasterLorebookEntry).mockReset().mockResolvedValue({ item: {} } as never)
    vi.mocked(addMasterCharacterEntry).mockReset().mockResolvedValue({ item: {} } as never)
    vi.mocked(instantiateMasterAsset).mockReset().mockResolvedValue({ item_ids: ['lore-1'], skipped_ids: [] } as never)
    vi.mocked(stopMasterAsset).mockReset().mockResolvedValue({ master_item_id: 'master-aiko', stopped_fields: 1, cancelled_tasks: 1, deleted_tasks: 0, pending_tasks: 0, queue_available: true } as never)
    vi.mocked(removeMasterAsset).mockReset().mockResolvedValue({ master_item_id: 'master-aiko', archived_at: '2026-09-07T00:00:00Z', preserved_instance_count: 0, queue: { master_item_id: 'master-aiko', stopped_fields: 0, cancelled_tasks: 0, deleted_tasks: 0, pending_tasks: 0, queue_available: true } } as never)
    vi.mocked(createLoreItem).mockReset().mockResolvedValue({ id: 'manual-lore-1' } as never)
    vi.mocked(fetchMasterTranslationRuntime).mockReset().mockResolvedValue({ fields: [], active_fields: 1, total_fields: 1, review_fields: 0, failed_fields: 0, queue_paused: false, runtime_available: true }).mockResolvedValue({ fields: [], active_fields: 1, total_fields: 1, review_fields: 0, failed_fields: 0, queue_paused: false, runtime_available: true })
    vi.mocked(resolveTranslationJob).mockReset()
    vi.mocked(deleteTranslationJob).mockReset()
    vi.mocked(rejectMasterProposal).mockReset().mockResolvedValue({ proposal: { proposal_id: 'prop-delete', status: 'rejected' } } as never)
    vi.mocked(rejectMasterProposals).mockReset().mockResolvedValue({ rejected_count: 1, results: [{ proposal_id: 'prop-delete', status: 'rejected' }] })
    vi.mocked(retryTranslationJob).mockReset()
    vi.mocked(startMasterAgent).mockReset()
    vi.mocked(createMasterProposal).mockReset().mockResolvedValue({ proposal: { proposal_id: 'prop-new', field_path: 'character.description', status: 'proposed', patch: { field_path: 'character.description', translation: '新译文' } } } as never)
    vi.mocked(validateMasterProposal).mockReset().mockResolvedValue({ proposal: { proposal_id: 'prop-new', status: 'validated' } } as never)
    vi.mocked(applyMasterProposal).mockReset().mockResolvedValue({} as never)
    vi.mocked(applyMasterProposals).mockReset().mockResolvedValue({ applied_count: 1, results: [{ proposal_id: 'prop-1', status: 'applied' }] })
  })

  it('lists assets and loads all read-only detail projections', async () => {
    const user = userEvent.setup()
    render(<LibraryView />)

    await screen.findByText('A curious alchemist.')
    expect(screen.getByText('动漫')).toBeInTheDocument()
    expect(screen.getByText('恋爱')).toBeInTheDocument()
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
    expect(screen.getAllByText('角色概览').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('总库资产 ID')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: '技术信息' }))
    expect(screen.getByText('总库资产 ID')).toBeInTheDocument()
  })

  it('shows stop and remove actions for every character card', async () => {
    const user = userEvent.setup()
    render(<LibraryView />)

    await screen.findByText('A curious alchemist.')
    expect(screen.getByRole('button', { name: '停止' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '删除' }))
    expect(screen.getByText('从总资料库移除角色卡？')).toBeInTheDocument()
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(removeMasterAsset).toHaveBeenCalledWith('master-aiko'))
  })

  it('shows a character profile with current, original, and compare views', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterAsset).mockResolvedValueOnce({
      summary,
      item: {
        original: { name: 'Aiko' }, source_semantics: { tags: ['alchemist'] }, runtime_semantics: {}, nested_entries: [],
        fields: {
          'character.name': { source_text: 'Aiko', active_text: '爱子' },
          'character.description': { source_text: 'A curious alchemist.', active_text: '好奇的炼金术士。' },
          'character.personality': { source_text: 'Curious and brave.', active_text: '好奇而勇敢。' },
        },
      },
      source: { filename: 'aiko.json' }, source_revision: { revision: 'src-r1', sha256: 'sha', imported_at: '2026-08-29T08:37:18Z' }, translations: [], usages: [],
    } as never)

    render(<LibraryView />)
    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    expect(await screen.findByText('人物档案')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '角色卡简介' })).not.toBeInTheDocument()
    expect(screen.getByText('原文名称: Aiko')).toBeInTheDocument()
    expect(screen.getByText('alchemist')).toBeInTheDocument()
    expect(screen.getAllByText('好奇的炼金术士。').length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: '原文' }))
    expect(screen.getAllByText('A curious alchemist.').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: '中英对照' }))
    expect(screen.getAllByText('当前内容').length).toBeGreaterThan(0)
    expect(screen.getAllByText('原文').length).toBeGreaterThan(0)
  })

  it('provides the selected character editor directory with unknown placeholders and persistent new entries', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterAsset).mockResolvedValueOnce({
      summary,
      item: { revision: 'master-r1', original: { name: 'Aiko' }, source_semantics: {}, runtime_semantics: {}, nested_entries: [], fields: { 'character.description': { active_text: '角色介绍' } } },
      source: { filename: 'aiko.json' }, source_revision: { revision: 'src-r1', sha256: 'sha' }, translations: [], usages: [],
    } as never)

    render(<LibraryView />)
    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    expect(screen.getByRole('complementary', { name: '角色条目' })).toBeInTheDocument()
    expect(screen.getAllByText('未知').length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: '添加条目' }))
    await user.type(screen.getByLabelText('条目标题'), '自定义字段')
    await user.type(screen.getByLabelText('正文'), '这是角色卡的补充内容。')
    await user.click(screen.getByRole('button', { name: '保存条目' }))

    await waitFor(() => expect(addMasterCharacterEntry).toHaveBeenCalledWith('master-aiko', 'master-r1', { name: '自定义字段', content: '这是角色卡的补充内容。' }))
  })

  it('edits a character-book entry from the left directory through the Master human-edit API', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterAsset).mockResolvedValueOnce({
      summary,
      item: { revision: 'master-r1', original: {}, source_semantics: {}, runtime_semantics: {}, nested_entries: [{ entry_id: 'entry-rule', original: { comment: '隐藏规则', content: '旧规则' } }], fields: { 'character_book.entries/entry-rule/comment': { active_text: '隐藏规则' }, 'character_book.entries/entry-rule/content': { active_text: '旧规则' } } },
      source: { filename: 'aiko.json' }, source_revision: { revision: 'src-r1', sha256: 'sha' }, translations: [], usages: [],
    } as never)

    render(<LibraryView />)
    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('button', { name: '隐藏规则' }))
    await user.click(screen.getByRole('button', { name: '编辑条目' }))
    const content = screen.getByLabelText('正文')
    await user.clear(content)
    await user.type(content, '新规则')
    await user.click(screen.getByRole('button', { name: '保存条目' }))

    await waitFor(() => expect(updateMasterAssetFields).toHaveBeenCalledWith('master-aiko', 'master-r1', { 'character_book.entries/entry-rule/content': '新规则' }))
  })

  it('keeps the complete人物档案文本 available instead of clipping the profile summary', async () => {
    const user = userEvent.setup()
    const completeProfile = '姓名：Aiko\n身体：金色长发、棕色眼睛\n喜好：Cosplay、摄影\n描述：完整角色档案末尾。'
    vi.mocked(fetchMasterAsset).mockResolvedValueOnce({
      summary,
      item: {
        original: { name: 'Aiko' }, source_semantics: {}, runtime_semantics: {}, nested_entries: [],
        fields: { 'character.description': { active_text: completeProfile, source_text: completeProfile } },
      },
      source: { filename: 'aiko.json' }, source_revision: { revision: 'src-r1', sha256: 'sha', imported_at: '2026-08-29T08:37:18Z' }, translations: [], usages: [],
    } as never)

    render(<LibraryView />)
    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    const profileText = screen.getByText(/完整角色档案末尾/)
    expect(profileText).toBeInTheDocument()
    expect(profileText).not.toHaveClass('max-h-24')
    expect(profileText).not.toHaveClass('overflow-hidden')
  })

  it('shows editable Chinese character tags without adding a character introduction', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterAsset).mockResolvedValueOnce({
      summary,
       item: { revision: 'master-r1', original: { name: 'Aiko', tags: ['Anime', 'Love'] }, source_semantics: { tags: ['Anime', 'Love'] }, runtime_semantics: {}, nested_entries: [], fields: {} },
      source: { filename: 'aiko.json' }, source_revision: { revision: 'src-r1', sha256: 'sha', imported_at: '2026-08-29T08:37:18Z' }, translations: [], usages: [],
    } as never)

    render(<LibraryView />)
    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    expect(screen.getByRole('heading', { name: '标签' })).toBeInTheDocument()
    expect(screen.getByText('动漫')).toBeInTheDocument()
    expect(screen.getByText('恋爱')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '编辑标签' }))
    const input = screen.getByPlaceholderText('输入中文标签，用逗号或换行分隔')
    expect(input).toHaveValue('动漫、恋爱')
    await user.clear(input)
    await user.type(input, '动漫、恋爱、炼金术士')
    await user.click(screen.getByRole('button', { name: '保存标签' }))
    await waitFor(() => expect(updateMasterAssetFields).toHaveBeenCalledWith('master-aiko', 'master-r1', { 'character.tags': '动漫\n恋爱\n炼金术士' }))
  })

  it('edits a lorebook introduction through the dedicated Master metadata API', async () => {
    const user = userEvent.setup()
    const lorebookSummary = { ...summary, master_item_id: 'master-world', name: 'World', description: '旧介绍', record_kind: 'lorebook_template', semantic_type: 'lorebook', nested_entry_count: 1, usage_count: 0, pipeline: { ...summary.pipeline, usage_count: 0 } }
    vi.mocked(listMasterAssets).mockResolvedValue({ assets: [lorebookSummary], total: 1 } as never)
    vi.mocked(fetchMasterAsset).mockResolvedValue({
      summary: lorebookSummary,
      item: {
        original: { name: 'World', description: '旧介绍' },
        source_semantics: {}, runtime_semantics: {},
        nested_entries: [{ entry_id: 'entry-1', original: { comment: 'Entry', content: 'Content', key: ['keyword'] } }],
        fields: {
          'lorebook.description': { active_text: '旧介绍' },
          'lorebook.entries/entry-1/comment': { active_text: 'Entry' },
          'lorebook.entries/entry-1/content': { active_text: 'Content' },
          'lorebook.entries/entry-1/keys': { active_text: 'keyword' },
        },
      },
      source: { filename: 'world.json' }, source_revision: { revision: 'src-r1', sha256: 'sha', imported_at: '2026-08-29T08:37:18Z' }, translations: [], usages: [],
    } as never)

    render(<LibraryView />)
    await user.click(await screen.findByRole('button', { name: /World/ }))
    await user.click(await screen.findByRole('button', { name: '编辑介绍' }))
    const textarea = screen.getByPlaceholderText('填写这本设定书的简介')
    await user.clear(textarea)
    await user.type(textarea, '人工维护的介绍')
    await user.click(screen.getByRole('button', { name: '保存介绍' }))

    await waitFor(() => expect(updateMasterAssetDescription).toHaveBeenCalledWith('master-world', '人工维护的介绍'))
  })

  it('does not show the first nested entry as the lorebook introduction', async () => {
    const user = userEvent.setup()
    const lorebookSummary = { ...summary, master_item_id: 'master-world-empty', name: '无简介设定', description: '', record_kind: 'lorebook_template', semantic_type: 'lorebook', nested_entry_count: 1, usage_count: 0, pipeline: { ...summary.pipeline, usage_count: 0 } }
    vi.mocked(listMasterAssets).mockResolvedValue({ assets: [lorebookSummary], total: 1 } as never)
    vi.mocked(fetchMasterAsset).mockResolvedValue({
      summary: lorebookSummary,
      item: {
        original: { name: '无简介设定' }, source_semantics: {}, runtime_semantics: {},
        nested_entries: [{ entry_id: 'entry-1', original: { comment: '第一条', content: '第一条正文' } }], fields: {},
      },
      source: { filename: 'world.json' }, source_revision: { revision: 'src-r1', sha256: 'sha', imported_at: '2026-08-29T08:37:18Z' }, translations: [], usages: [],
    } as never)

    render(<LibraryView />)
    await user.click(await screen.findByRole('button', { name: /无简介设定/ }))
    const heading = await screen.findByRole('heading', { name: '设定书介绍' })
    const introduction = heading.parentElement?.parentElement
    expect(introduction).toHaveTextContent('暂无简介')
    expect(introduction).not.toHaveTextContent('第一条正文')
    expect(screen.getByText('第一条正文')).toBeInTheDocument()
  })

  it('creates a missing optional lorebook field through direct human save', async () => {
    const user = userEvent.setup()
    const lorebookSummary = { ...summary, master_item_id: 'master-world', name: 'World', record_kind: 'lorebook_template', semantic_type: 'lorebook', nested_entry_count: 1 }
    vi.mocked(listMasterAssets).mockResolvedValue({ assets: [lorebookSummary], total: 1 } as never)
    vi.mocked(fetchMasterAsset).mockResolvedValue({
      summary: lorebookSummary,
      item: {
        revision: 'master-world-r1', original: { name: 'World' }, source_semantics: {}, runtime_semantics: {},
        nested_entries: [{ entry_id: 'entry-1', original: { comment: 'Entry', content: 'Content', key: ['keyword'] } }],
        fields: {
          'lorebook.entries/entry-1/comment': { active_text: 'Entry' },
          'lorebook.entries/entry-1/content': { active_text: 'Content' },
          'lorebook.entries/entry-1/keys': { active_text: 'keyword' },
        },
      },
      source: { filename: 'world.json' }, source_revision: { revision: 'src-r1', sha256: 'sha', imported_at: '2026-08-29T08:37:18Z' }, translations: [], usages: [],
    } as never)

    render(<LibraryView />)
    await user.click(await screen.findByRole('button', { name: /World/ }))
    await user.click(screen.getByRole('button', { name: '编辑条目' }))
    await user.type(screen.getByLabelText('副关键词'), 'north')
    await user.click(screen.getByRole('button', { name: '保存条目' }))

    await waitFor(() => expect(updateMasterAssetFields).toHaveBeenCalledWith('master-world', 'master-world-r1', { 'lorebook.entries/entry-1/secondary_keys': 'north' }))
    expect(createMasterProposal).not.toHaveBeenCalled()
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

  it('polishes a field and surfaces the new candidate once Denova finishes', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterTranslationRuntime).mockResolvedValue({
      fields: [{ field_path: 'character.description', task_status: 'completed', content_version_status: 'hy_mt_active', review_required: false, task_id: 'job-done' }],
      active_fields: 1, total_fields: 1, review_fields: 0, failed_fields: 0, queue_paused: false, runtime_available: true,
    })
    vi.mocked(startMasterAgent).mockResolvedValue({ task_id: 'agent-polish', status: 'running' } as never)
    let proposalCall = 0
    vi.mocked(fetchMasterAssetProposals).mockImplementation(async () => {
      proposalCall += 1
      if (proposalCall >= 3) {
        return { proposals: [{ proposal_id: 'polish-new', operation_id: 'op-polish', kind: 'polish', stage: '', apply_mode: 'confirm', status: 'candidate_ready', master_item_id: 'master-aiko', field_path: 'character.description', import_id: 'import-1', original: 'She walks quietly.', patch: { field_path: 'character.description', translation: '她安静地走着。' }, input_revision: 'rev-1', source_sha256: 'sha', risk: 'safe', created_at: '2026-09-04T00:00:00Z', updated_at: '2026-09-04T00:00:00Z' }] } as never
      }
      return { proposals: [] }
    })
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('tab', { name: '处理进度' }))
    await user.click(screen.getByText('查看详细处理过程'))

    const polishButton = await screen.findByRole('button', { name: 'Denova 精修' })
    await user.click(polishButton)

    await waitFor(() => expect(startMasterAgent).toHaveBeenCalledWith('master-aiko', 'character.description', 'polish'), { timeout: 5000 })
    expect(await screen.findByText('Denova 已完成精修，请在「Denova 处理结果」确认', {}, { timeout: 15000 })).toBeInTheDocument()
  }, 20000)

  it('reports a rejected polish result instead of waiting for the full timeout', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterTranslationRuntime).mockResolvedValue({
      fields: [{ field_path: 'character.description', task_status: 'completed', content_version_status: 'hy_mt_active', review_required: false, task_id: 'job-done' }],
      active_fields: 1, total_fields: 1, review_fields: 0, failed_fields: 0, queue_paused: false, runtime_available: true,
    })
    vi.mocked(startMasterAgent).mockResolvedValue({ task_id: 'agent-polish-rej', status: 'running' } as never)
    let proposalCall = 0
    vi.mocked(fetchMasterAssetProposals).mockImplementation(async () => {
      proposalCall += 1
      if (proposalCall >= 2) {
        return { proposals: [{ proposal_id: 'polish-rej', operation_id: 'op-rej', kind: 'polish', stage: '', apply_mode: 'confirm', status: 'rejected', master_item_id: 'master-aiko', field_path: 'character.description', import_id: 'import-1', original: 'She walks quietly.', patch: { field_path: 'character.description', translation: '她安静地走着。' }, input_revision: 'rev-1', source_sha256: 'sha', risk: 'safe', created_at: '2026-09-04T00:00:00Z', updated_at: '2026-09-04T00:00:00Z' }] } as never
      }
      return { proposals: [] }
    })
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('tab', { name: '处理进度' }))
    await user.click(screen.getByText('查看详细处理过程'))
    await user.click(await screen.findByRole('button', { name: 'Denova 精修' }))

    expect(await screen.findByText('Denova 精修被拒绝或冲突，请在「Denova 处理结果」查看', {}, { timeout: 15000 })).toBeInTheDocument()
  }, 20000)

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

  it('saves character edits directly with canonical opening paths instead of translation proposals', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterAsset).mockResolvedValue({
      summary,
      item: {
        revision: 'master-r1', original: {}, source_semantics: {}, runtime_semantics: {}, nested_entries: [],
        fields: {
          'character.name': { active_text: 'Aiko' },
          'character.description': { active_text: 'Old description' },
          'character.openings[0]': { active_text: 'Old greeting' },
        },
      },
      source: { filename: 'aiko.json' }, source_revision: { revision: 'src-r1', sha256: 'sha', imported_at: '2026-08-29T08:37:18Z' }, translations: [], usages: [],
    } as never)

    render(<LibraryView workspace="E:/books/adventure" />)
    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('button', { name: '编辑角色卡' }))
    const firstMessage = screen.getByDisplayValue('Old greeting')
    await user.clear(firstMessage)
    await user.type(firstMessage, '新的开场白')
    await user.click(screen.getByRole('button', { name: '保存角色卡' }))

    await waitFor(() => expect(updateMasterAssetFields).toHaveBeenCalledWith('master-aiko', 'master-r1', { 'character.openings[0]': '新的开场白' }))
    expect(createMasterProposal).not.toHaveBeenCalled()
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

  it('shows the backend reason when adding an asset fails', async () => {
    const user = userEvent.setup()
    vi.mocked(instantiateMasterAsset).mockRejectedValue(new Error('资料名称已存在: 城市设定'))
    render(<LibraryView workspace="ws-test" />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('button', { name: '加入当前冒险' }))

    expect(await screen.findByText('加入当前冒险失败：资料名称已存在: 城市设定')).toBeInTheDocument()
  })

  it('opens a blank form for manually adding a nested lorebook entry', async () => {
    const user = userEvent.setup()
    const loreSummary = { ...summary, master_item_id: 'master-lore-manual', name: '城市设定', description: '城市与港口资料。', record_kind: 'lorebook_template', semantic_type: 'lorebook', nested_entry_count: 1 }
    vi.mocked(listMasterAssets).mockResolvedValue({ assets: [loreSummary], total: 1 })
    vi.mocked(fetchMasterAsset).mockResolvedValue({
      summary: loreSummary,
      item: { original: {}, source_semantics: {}, runtime_semantics: {}, nested_entries: [{ entry_id: 'entry-port', original: { comment: '港口', content: '繁忙的港口。', key: ['港口'] } }], fields: {} },
      source: { filename: 'city.json' }, source_revision: { revision: 'src-r1', sha256: 'sha' }, translations: [], usages: [],
    })
    render(<LibraryView workspace="ws-test" />)

    await user.click(await screen.findByRole('button', { name: /城市设定/ }))
    await user.click(screen.getByRole('button', { name: '手动添加条目' }))
    const title = screen.getByLabelText('条目标题')
    await user.type(title, '港口设定（手动）')
    const content = screen.getByLabelText('正文')
    expect(content).toHaveValue('')
    await user.type(content, '这是新建的港口资料。')
    await user.type(screen.getByLabelText('关键词'), '港口,手动')
    await user.click(screen.getByRole('button', { name: '手动添加条目' }))

    await waitFor(() => expect(createLoreItem).toHaveBeenCalledWith(expect.objectContaining({ name: '港口设定（手动）', content: '这是新建的港口资料。', keywords: ['港口', '手动'] })))
    expect(await screen.findByText('条目已手动添加到当前冒险')).toBeInTheDocument()
  })

  it('writes a manual entry to Master and shows it after the detail reloads', async () => {
    const user = userEvent.setup()
    const loreSummary = { ...summary, master_item_id: 'master-lore-visible', name: '城市设定', description: '城市与港口资料。', record_kind: 'lorebook_template', semantic_type: 'lorebook', nested_entry_count: 1 }
    const firstItem = { revision: 'master-lore-visible-r1', original: {}, source_semantics: {}, runtime_semantics: {}, nested_entries: [{ entry_id: 'entry-port', original: { comment: '港口', content: '繁忙的港口。', key: ['港口'] } }], fields: {} }
    const reloadedItem = { ...firstItem, revision: 'master-lore-visible-r2', nested_entries: [...firstItem.nested_entries, { entry_id: 'human-new', original: { comment: '新条目', content: '新条目正文。', key: ['新条目'] } }] }
    vi.mocked(listMasterAssets).mockResolvedValue({ assets: [loreSummary], total: 1 } as never)
    vi.mocked(fetchMasterAsset).mockReset().mockResolvedValueOnce({ summary: loreSummary, item: firstItem, source: { filename: 'city.json' }, source_revision: { revision: 'src-r1', sha256: 'sha' }, translations: [], usages: [] } as never).mockResolvedValueOnce({ summary: { ...loreSummary, nested_entry_count: 2 }, item: reloadedItem, source: { filename: 'city.json' }, source_revision: { revision: 'src-r1', sha256: 'sha' }, translations: [], usages: [] } as never)
    render(<LibraryView workspace="ws-test" />)

    await user.click(await screen.findByRole('button', { name: /城市设定/ }))
    await user.click(screen.getByRole('button', { name: '手动添加条目' }))
    await user.type(screen.getByLabelText('条目标题'), '新条目')
    await user.type(screen.getByLabelText('正文'), '新条目正文。')
    await user.click(screen.getByRole('button', { name: '手动添加条目' }))

    await waitFor(() => expect(addMasterLorebookEntry).toHaveBeenCalledWith('master-lore-visible', 'master-lore-visible-r1', { name: '新条目', content: '新条目正文。', keywords: [], secondary_keys: [] }))
    expect((await screen.findAllByText('新条目')).length).toBeGreaterThan(0)
    expect(fetchMasterAsset).toHaveBeenCalledTimes(2)
  })

  it('collects translation exceptions into the Denova results workbench', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterAsset).mockResolvedValue({
      summary,
      item: { original: {}, source_semantics: {}, runtime_semantics: {}, nested_entries: [], fields: { 'character.description': { source_text: 'She walks quietly.', risk: 'safe' } } },
      source: { filename: 'aiko.json' }, source_revision: { revision: 'src-r1' }, translations: [], usages: [],
    })
    vi.mocked(fetchMasterTranslationRuntime).mockResolvedValue({
      fields: [
        { field_path: 'character.description', task_status: 'failed', content_version_status: 'original', review_required: false, task_id: 'job-echo', candidate_translation: 'She walks quietly.', quality_status: 'needs_review', quality_codes: ['source_echo'], quality_reason: '模型回显了英文原文' },
      ],
      active_fields: 0, total_fields: 1, review_fields: 0, failed_fields: 1, queue_paused: false, runtime_available: true,
    })
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('tab', { name: '处理进度' }))

    expect(await screen.findByText('Denova 处理结果')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '展开原文和候选译文' }))
    expect(screen.getAllByText('She walks quietly.').length).toBeGreaterThan(0)
    expect(screen.getByDisplayValue('She walks quietly.')).toBeInTheDocument()
    expect(screen.getAllByText('模型回显了英文原文').length).toBeGreaterThan(0)
    expect(screen.getByText('失败')).toBeInTheDocument()
  })

  it('saves a manual edit as a recovery proposal', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterAsset).mockResolvedValue({
      summary,
      item: { original: {}, source_semantics: {}, runtime_semantics: {}, nested_entries: [], fields: { 'character.description': { source_text: 'She walks quietly.', risk: 'safe' } } },
      source: { filename: 'aiko.json' }, source_revision: { revision: 'src-r1' }, translations: [], usages: [],
    })
    vi.mocked(fetchMasterTranslationRuntime).mockResolvedValue({
      fields: [{ field_path: 'character.description', task_status: 'failed', content_version_status: 'original', review_required: false, task_id: 'job-echo', candidate_translation: 'She walks quietly.', quality_status: 'needs_review', quality_codes: ['source_echo'], quality_reason: '模型回显了英文原文' }],
      active_fields: 0, total_fields: 1, review_fields: 0, failed_fields: 1, queue_paused: false, runtime_available: true,
    })
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('tab', { name: '处理进度' }))
    await user.click(screen.getByRole('button', { name: '展开原文和候选译文' }))
    const editor = await screen.findByDisplayValue('She walks quietly.')
    await user.clear(editor)
    await user.type(editor, '她安静地走着。')
    await user.click(screen.getByRole('button', { name: /保存修改/ }))

    await waitFor(() => {
      expect(createMasterProposal).toHaveBeenCalledWith('master-aiko', expect.objectContaining({ field_path: 'character.description', translation: '她安静地走着。', kind: 'recovery', apply_mode: 'confirm' }))
      expect(validateMasterProposal).toHaveBeenCalledWith('prop-new', { allowProtectedTokenMismatch: true })
    })
  })

  it('saves and applies a manual edit from the shared review workbench', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterAsset).mockResolvedValue({
      summary,
      item: { original: {}, source_semantics: {}, runtime_semantics: {}, nested_entries: [], fields: { 'character.description': { source_text: 'She walks quietly.', risk: 'safe' } } },
      source: { filename: 'aiko.json' }, source_revision: { revision: 'src-r1' }, translations: [], usages: [],
    })
    vi.mocked(fetchMasterTranslationRuntime).mockResolvedValue({
      fields: [{ field_path: 'character.description', task_status: 'failed', content_version_status: 'original', review_required: false, task_id: 'job-echo', candidate_translation: 'She walks quietly.', quality_status: 'needs_review', quality_codes: ['source_echo'], quality_reason: '模型回显了英文原文' }],
      active_fields: 0, total_fields: 1, review_fields: 0, failed_fields: 1, queue_paused: false, runtime_available: true,
    })
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('tab', { name: '处理进度' }))
    await user.click(screen.getByRole('button', { name: '展开原文和候选译文' }))
    const editor = await screen.findByDisplayValue('She walks quietly.')
    await user.clear(editor)
    await user.type(editor, '她安静地走着。')
    await user.click(screen.getByRole('button', { name: '保存并应用' }))

    await waitFor(() => {
      expect(createMasterProposal).toHaveBeenCalledWith('master-aiko', expect.objectContaining({ field_path: 'character.description', translation: '她安静地走着。' }))
      expect(validateMasterProposal).toHaveBeenCalledWith('prop-new', { allowProtectedTokenMismatch: true })
      expect(applyMasterProposal).toHaveBeenCalledWith('prop-new', true, false, true)
    })
  })

  it('saves and applies an existing runtime candidate without editing, prevents duplicate submission, then removes it from review', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterTranslationRuntime).mockResolvedValue({
      fields: [{ field_path: 'character.description', task_status: 'failed', content_version_status: 'original', review_required: false, task_id: 'job-candidate', candidate_translation: '她安静地走着。', quality_status: 'needs_review', quality_codes: ['mixed_language'], quality_reason: '需要人工确认' }],
      active_fields: 0, total_fields: 1, review_fields: 0, failed_fields: 1, queue_paused: false, runtime_available: true,
    })
    let proposalCalls = 0
    vi.mocked(fetchMasterAssetProposals).mockImplementation(async () => {
      proposalCalls += 1
      if (proposalCalls > 1) {
        return { proposals: [
          { proposal_id: 'prop-new', operation_id: 'op-new', kind: 'recovery', stage: '', apply_mode: 'confirm', status: 'applied', master_item_id: 'master-aiko', field_path: 'character.description', import_id: 'import-1', original: 'She walks quietly.', patch: { field_path: 'character.description', translation: '她安静地走着。' }, input_revision: 'rev-1', source_sha256: 'sha', risk: 'safe', created_at: '2026-09-04T00:00:00Z', updated_at: '2026-09-04T00:00:01Z' },
          { proposal_id: 'prop-old', operation_id: 'op-old', kind: 'recovery', stage: '', apply_mode: 'confirm', status: 'proposed', master_item_id: 'master-aiko', field_path: 'character.description', import_id: 'import-1', original: 'She walks quietly.', patch: { field_path: 'character.description', translation: '她安静地走着。' }, input_revision: 'rev-1', source_sha256: 'sha', risk: 'safe', created_at: '2026-09-04T00:00:00Z', updated_at: '2026-09-04T00:00:00Z' },
        ] } as never
      }
      return { proposals: [] }
    })
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('tab', { name: '处理进度' }))
    const saveApply = await screen.findByRole('button', { name: '保存并应用' })
    fireEvent.click(saveApply)
    fireEvent.click(saveApply)

    await waitFor(() => {
      expect(createMasterProposal).toHaveBeenCalledTimes(1)
      expect(createMasterProposal).toHaveBeenCalledWith('master-aiko', expect.objectContaining({ field_path: 'character.description', translation: '她安静地走着。', kind: 'recovery', apply_mode: 'confirm' }))
      expect(validateMasterProposal).toHaveBeenCalledWith('prop-new')
      expect(applyMasterProposal).toHaveBeenCalledWith('prop-new', true)
      expect(resolveTranslationJob).toHaveBeenCalledWith('job-candidate', 'applied')
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: '保存并应用' })).not.toBeInTheDocument())
  })

  it('batch-applies an existing runtime candidate without editing', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterTranslationRuntime).mockResolvedValue({
      fields: [{ field_path: 'character.description', task_status: 'failed', content_version_status: 'original', review_required: false, task_id: 'job-candidate', candidate_translation: '她安静地走着。', quality_status: 'needs_review', quality_codes: ['mixed_language'], quality_reason: '需要人工确认' }],
      active_fields: 0, total_fields: 1, review_fields: 0, failed_fields: 1, queue_paused: false, runtime_available: true,
    })
    vi.mocked(applyMasterProposals).mockResolvedValue({ applied_count: 1, results: [{ proposal_id: 'prop-new', status: 'applied' }] })
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('tab', { name: '处理进度' }))
    await user.click(await screen.findByRole('button', { name: '全选' }))
    await user.click(screen.getByRole('button', { name: /批量确认应用/ }))

    await waitFor(() => {
      expect(createMasterProposal).toHaveBeenCalledWith('master-aiko', expect.objectContaining({ field_path: 'character.description', translation: '她安静地走着。' }))
      expect(applyMasterProposals).toHaveBeenCalledWith('master-aiko', ['prop-new'], false)
      expect(resolveTranslationJob).toHaveBeenCalledWith('job-candidate', 'applied')
    })
  })

  it('soft-deletes a proposal from the Denova results after confirmation', async () => {
    const user = userEvent.setup()
    let proposalCalls = 0
    vi.mocked(fetchMasterAssetProposals).mockImplementation(async () => {
      proposalCalls += 1
      if (proposalCalls > 1) return { proposals: [] }
      return { proposals: [{
        proposal_id: 'prop-delete', operation_id: 'op-delete', kind: 'recovery', stage: '', apply_mode: 'confirm', status: 'proposed',
        master_item_id: 'master-aiko', field_path: 'character.description', import_id: 'import-1', original: 'She walks quietly.',
        patch: { field_path: 'character.description', translation: '她安静地走着。' },
        input_revision: 'rev-1', source_sha256: 'sha', risk: 'safe', created_at: '2026-09-04T00:00:00Z', updated_at: '2026-09-04T00:00:00Z',
      }] } as never
    })
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('tab', { name: '处理进度' }))
    await user.click(await screen.findByRole('button', { name: '删除候选' }))

    expect(await screen.findByText('删除这个候选？')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^删除$/ }))

    await waitFor(() => expect(rejectMasterProposal).toHaveBeenCalledWith('prop-delete'))
    await waitFor(() => expect(screen.queryByRole('button', { name: '删除候选' })).not.toBeInTheDocument())
  })

  it('batch-deletes selected proposals without touching the source item', async () => {
    const user = userEvent.setup()
    const proposals = ['one', 'two'].map((id, index) => ({
      proposal_id: `prop-${id}`, operation_id: `op-${id}`, kind: 'recovery', stage: '', apply_mode: 'confirm', status: 'proposed',
      master_item_id: 'master-aiko', field_path: `character.description.${index}`, import_id: 'import-1', original: 'Source',
      patch: { field_path: `character.description.${index}`, translation: `中文候选${index}` },
      input_revision: 'rev-1', source_sha256: 'sha', risk: 'safe', created_at: '2026-09-04T00:00:00Z', updated_at: '2026-09-04T00:00:00Z',
    }))
    vi.mocked(fetchMasterAssetProposals).mockResolvedValue({ proposals } as never)
    vi.mocked(rejectMasterProposals).mockResolvedValue({ rejected_count: 2, results: proposals.map((proposal) => ({ proposal_id: proposal.proposal_id, status: 'rejected' })) })
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('tab', { name: '处理进度' }))
    await user.click(screen.getByRole('button', { name: '全选' }))
    await user.click(screen.getByRole('button', { name: '删除所选（2）' }))

    expect(await screen.findByText('删除选中的 2 个候选？')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^删除$/ }))
    await waitFor(() => expect(rejectMasterProposals).toHaveBeenCalledWith('master-aiko', ['prop-one', 'prop-two']))
    expect(applyMasterProposal).not.toHaveBeenCalled()
  })

  it('deletes a failed runtime candidate through the translation queue', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterTranslationRuntime).mockResolvedValue({
      fields: [{ field_path: 'character.description', task_status: 'failed', content_version_status: 'original', review_required: false, task_id: 'job-delete', candidate_translation: '候选译文', quality_status: 'failed', quality_codes: ['bridge_or_model_error'], quality_reason: '需要人工处理' }],
      active_fields: 0, total_fields: 1, review_fields: 0, failed_fields: 1, queue_paused: false, runtime_available: true,
    })
    vi.mocked(deleteTranslationJob).mockResolvedValue({ ok: true, id: 'job-delete', status: 'deleted' } as never)
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('tab', { name: '处理进度' }))
    await user.click(await screen.findByRole('button', { name: '删除候选' }))
    await user.click(screen.getByRole('button', { name: /^删除$/ }))

    await waitFor(() => expect(deleteTranslationJob).toHaveBeenCalledWith('job-delete'))
  })

  it('batch-applies validated proposals without high-risk confirmation', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterAssetProposals).mockResolvedValue({ proposals: [{
      proposal_id: 'prop-1', operation_id: 'op-1', kind: 'recovery', stage: '', apply_mode: 'confirm', status: 'validated',
      master_item_id: 'master-aiko', field_path: 'character.description', import_id: 'import-1', original: 'She walks quietly.',
      patch: { field_path: 'character.description', translation: '她安静地走着。' },
      input_revision: 'rev-1', source_sha256: 'sha', risk: 'safe', created_at: '2026-09-04T00:00:00Z', updated_at: '2026-09-04T00:00:00Z',
    }] } as never)
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('tab', { name: '处理进度' }))
    await user.click(await screen.findByRole('button', { name: '全选' }))
    await user.click(screen.getByRole('button', { name: /批量确认应用/ }))

    await waitFor(() => expect(applyMasterProposals).toHaveBeenCalledWith('master-aiko', ['prop-1'], false))
  })

  it('batch-applies proposed candidates in API-sized chunks', async () => {
    const user = userEvent.setup()
    const proposals = Array.from({ length: 101 }, (_, index) => ({
      proposal_id: `prop-${index}`, operation_id: `op-${index}`, kind: 'recovery', stage: '', apply_mode: 'confirm', status: 'proposed',
      master_item_id: 'master-aiko', field_path: 'character.description', import_id: 'import-1', original: 'She walks quietly.',
      patch: { field_path: 'character.description', translation: `她安静地走着。${index}` },
      input_revision: 'rev-1', source_sha256: 'sha', risk: 'safe', created_at: '2026-09-04T00:00:00Z', updated_at: '2026-09-04T00:00:00Z',
    }))
    vi.mocked(fetchMasterAssetProposals).mockResolvedValue({ proposals } as never)
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('tab', { name: '处理进度' }))
    await user.click(await screen.findByRole('button', { name: '全选' }))
    await user.click(screen.getByRole('button', { name: /批量确认应用/ }))

    await waitFor(() => expect(applyMasterProposals).toHaveBeenCalledTimes(2))
    const calls = vi.mocked(applyMasterProposals).mock.calls
    expect(calls[0][0]).toBe('master-aiko')
    expect(calls[0][1]).toHaveLength(100)
    expect(calls[1][1]).toHaveLength(1)
    expect(calls[0][2]).toBe(false)
  })

  it('validates a proposed candidate before single apply', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterAssetProposals).mockResolvedValue({ proposals: [{
      proposal_id: 'prop-proposed', operation_id: 'op-proposed', kind: 'recovery', stage: '', apply_mode: 'confirm', status: 'proposed',
      master_item_id: 'master-aiko', field_path: 'character.description', import_id: 'import-1', original: 'She walks quietly.',
      patch: { field_path: 'character.description', translation: '她安静地走着。' },
      input_revision: 'rev-1', source_sha256: 'sha', risk: 'safe', created_at: '2026-09-04T00:00:00Z', updated_at: '2026-09-04T00:00:00Z',
    }] } as never)
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('tab', { name: '处理进度' }))
    await user.click(await screen.findByRole('button', { name: '应用' }))

    await waitFor(() => {
      expect(validateMasterProposal).toHaveBeenCalledWith('prop-proposed')
      expect(applyMasterProposal).toHaveBeenCalledWith('prop-proposed', true)
    })
  })

  it('approves and completes a conflicted candidate with an explicit force action', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterAssetProposals).mockResolvedValue({ proposals: [{
      proposal_id: 'prop-conflict', operation_id: 'op-conflict', kind: 'recovery', stage: '', apply_mode: 'confirm', status: 'conflict',
      master_item_id: 'master-aiko', field_path: 'character.description', import_id: 'import-1', original: 'She walks quietly.',
      patch: { field_path: 'character.description', translation: '她安静地走着。' },
      input_revision: 'old-rev', source_sha256: 'old-sha', risk: 'safe', created_at: '2026-09-04T00:00:00Z', updated_at: '2026-09-04T00:00:00Z',
    }] } as never)
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('tab', { name: '处理进度' }))
    await user.click(await screen.findByRole('button', { name: '批准并完成' }))

    await waitFor(() => expect(applyMasterProposal).toHaveBeenCalledWith('prop-conflict', true, true, true))
  })

  it('batch-approves and completes selected conflicts', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterAssetProposals).mockResolvedValue({ proposals: [{
      proposal_id: 'prop-conflict', operation_id: 'op-conflict', kind: 'recovery', stage: '', apply_mode: 'confirm', status: 'conflict',
      master_item_id: 'master-aiko', field_path: 'character.description', import_id: 'import-1', original: 'She walks quietly.',
      patch: { field_path: 'character.description', translation: '她安静地走着。' },
      input_revision: 'old-rev', source_sha256: 'old-sha', risk: 'safe', created_at: '2026-09-04T00:00:00Z', updated_at: '2026-09-04T00:00:00Z',
    }] } as never)
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('tab', { name: '处理进度' }))
    await user.click(await screen.findByRole('button', { name: '全选' }))
    await user.click(screen.getByRole('button', { name: /批量批准并完成/ }))

    await waitFor(() => expect(applyMasterProposals).toHaveBeenCalledWith('master-aiko', ['prop-conflict'], false, true, true))
  })

  it('requires explicit confirmation before applying high-risk proposals', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterAssetProposals).mockResolvedValue({ proposals: [{
      proposal_id: 'prop-risk', operation_id: 'op-risk', kind: 'polish', stage: '', apply_mode: 'confirm', status: 'candidate_ready',
      master_item_id: 'master-aiko', field_path: 'character.system_prompt', import_id: 'import-1', original: 'Always remain in character.',
      patch: { field_path: 'character.system_prompt', translation: '始终保持角色扮演。' },
      input_revision: 'rev-1', source_sha256: 'sha', risk: 'high', created_at: '2026-09-04T00:00:00Z', updated_at: '2026-09-04T00:00:00Z',
    }] } as never)
    render(<LibraryView />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(screen.getByRole('tab', { name: '处理进度' }))
    await user.click(await screen.findByRole('button', { name: '全选' }))
    await user.click(screen.getByRole('button', { name: /批量确认应用/ }))

    expect(await screen.findByText('确认应用高风险字段')).toBeInTheDocument()
    expect(applyMasterProposals).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '应用所选高风险字段' }))
    await waitFor(() => expect(applyMasterProposals).toHaveBeenCalledWith('master-aiko', ['prop-risk'], true))
  })

  it('disables sync when the current Adventure does not use the asset', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterAssetAdventureUsage).mockResolvedValue({ usage: { used: false, has_new_version: false } })
    render(<LibraryView workspace="ws-test" />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    expect(await screen.findByRole('button', { name: '同步到当前冒险' })).toBeDisabled()
    expect(syncMasterAssetToAdventure).not.toHaveBeenCalled()
  })

  it('syncs the active Master revision into the current Adventure on demand', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchMasterAssetAdventureUsage).mockResolvedValue({ usage: { used: true, has_new_version: true, loaded_revision: 'rev-old', current_revision: 'rev-new' } })
    render(<LibraryView workspace="ws-test" />)

    await user.click(await screen.findByRole('button', { name: /Aiko/ }))
    await user.click(await screen.findByRole('button', { name: '同步到当前冒险' }))

    await waitFor(() => expect(syncMasterAssetToAdventure).toHaveBeenCalledWith('master-aiko'))
    expect(await screen.findByText('已同步 1 个冒险资料条目')).toBeInTheDocument()
  })
})
