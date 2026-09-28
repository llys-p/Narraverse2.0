import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { VirtuosoMockContext } from 'react-virtuoso'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchSettings, updateUserSettings } from '@/features/settings/api'
import { usePersistedUserSettings } from '@/hooks/usePersistedUserSettings'
import { AgentPanel, WRITING_COMPOSER_SETTING_DEFAULTS, type WritingComposerSettingsController } from './AgentPanel'
import { WorldContextRunProvider, useWorldContextRun, type WritingWorldRunView } from '@/features/world-context-runtime/WorldContextRunProvider'
import { LibraryContextRunProvider, useLibraryContextRun, type LibraryContextRunView } from '@/features/library-context-runtime/LibraryContextRunProvider'

const useWritingSkillOptionsMock = vi.hoisted(() => vi.fn())
const useWorkspaceChangeGroupsMock = vi.hoisted(() => vi.fn())

vi.mock('@/features/settings/api', () => ({
  fetchSettings: vi.fn().mockResolvedValue({
    effective: { ide_story_teller_id: 'classic', writing_skill_default: 'novel-lite' },
    user: {},
  }),
  updateUserSettings: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/hooks/useSkillCommands', () => ({
  useSkillCommands: () => [],
}))

vi.mock('@/hooks/useWritingSkillOptions', () => ({
  DEFAULT_WRITING_SKILL: 'novel-lite',
  BUILTIN_WRITING_SKILLS: ['novel-lite', 'novel-standard', 'novel-heavy'],
  useWritingSkillOptions: useWritingSkillOptionsMock,
}))

vi.mock('@/features/changes/use-change-review', () => ({
  useWorkspaceChangeGroups: useWorkspaceChangeGroupsMock,
}))

describe('AgentPanel', () => {
  beforeEach(() => {
    vi.mocked(fetchSettings).mockClear()
    vi.mocked(updateUserSettings).mockClear()
    vi.mocked(updateUserSettings).mockImplementation(async (settings) => ({
      default: {},
      global: {},
      user: settings,
      workspace: {},
      effective: {
        ide_story_teller_id: 'classic',
        ide_image_preset_id: 'game-cg',
        writing_skill_default: 'novel-lite',
        ...settings,
      },
      revisions: { user: 'r2' },
      paths: { denova_dir: '', nova_dir: '', user_config: '', workspace_config: '' },
    }))
    useWritingSkillOptionsMock.mockReset()
    useWorkspaceChangeGroupsMock.mockReset()
    useWorkspaceChangeGroupsMock.mockReturnValue({ data: [] })
    useWritingSkillOptionsMock.mockReturnValue([
      { name: 'novel-lite', description: 'Lite', scope: 'builtin', path: '/skills/novel-lite/SKILL.md', active: true, agent: 'ide' },
      { name: 'novel-standard', description: 'Standard', scope: 'builtin', path: '/skills/novel-standard/SKILL.md', active: true, agent: 'ide' },
      { name: 'novel-heavy', description: 'Heavy', scope: 'builtin', path: '/skills/novel-heavy/SKILL.md', active: true, agent: 'ide' },
      { name: 'slow-burn', description: '慢热写作', scope: 'workspace', path: '/book/.nova/skills/slow-burn/SKILL.md', active: true, agent: 'ide' },
    ])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('创作 Agent 顶部切换器不再展示 Review tab，并在输入选项中切换写作 Skill', async () => {
    const user = userEvent.setup()
    renderAgentPanel()

    expect(useWritingSkillOptionsMock).toHaveBeenCalledWith('/workspace')
    expect(useWorkspaceChangeGroupsMock).toHaveBeenCalledWith('/workspace', { sessionID: 'session-1' })
    expect(screen.getByRole('button', { name: '对话' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '会话' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '运行追踪' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '输入动作' }))
    expect(screen.getByText('叙事')).toBeInTheDocument()
    expect(screen.getByText('默认叙事')).toBeInTheDocument()
    expect(screen.getByText('写作 Skill')).toBeInTheDocument()
    expect(screen.getByText(/Lite/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument()
  })

  it('将新建会话按钮放在标题切换器旁边并隐藏会话摘要和空闲状态文字', async () => {
    const user = userEvent.setup()
    const handleCreateSession = vi.fn()
    renderAgentPanel({ onCreateSession: handleCreateSession })

    expect(screen.queryByText('等待')).not.toBeInTheDocument()
    expect(screen.queryByText('当前：')).not.toBeInTheDocument()
    expect(screen.queryByText('当前会话')).not.toBeInTheDocument()
    const createButton = screen.getByRole('button', { name: '新建会话' })
    expect(createButton).toHaveClass('w-7')
    expect(createButton).not.toHaveTextContent('新建')

    await user.click(createButton)
    expect(handleCreateSession).toHaveBeenCalledTimes(1)
  })

  it('写下一章快捷提示要求同轮同步作品状态且不依赖成章确认', async () => {
    const user = userEvent.setup()
    const handleSend = vi.fn()
    renderAgentPanel({ onSend: handleSend })

    await user.click(screen.getByRole('button', { name: '按细纲写下一章' }))

    expect(handleSend).toHaveBeenCalledWith(
      expect.stringContaining('在同一轮同步更新 setting/progress.md 与 setting/character-states.md'),
      expect.objectContaining({ writingSkill: 'novel-lite', tellerId: 'classic' }),
    )
    expect(handleSend.mock.calls[0][0]).toContain('章节是否标记成章不影响同步')
    expect(handleSend.mock.calls[0][0]).not.toContain('由我在章节列表确认后再标记为成章')
  })

  it('创作 Agent 将思考和工具调用折叠到同一个思考过程', async () => {
    const user = userEvent.setup()
    renderAgentPanel({
      messages: [{
        id: 'assistant-trace',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: '读取章节上下文' },
          { type: 'dynamic-tool', toolName: 'read_file', toolCallId: 'tool-1', state: 'output-available', input: { path: 'chapters/ch01.md' }, output: 'ok' },
          { type: 'text', text: '已完成续写。' },
        ],
      }],
    })

    expect(screen.getByRole('button', { name: /思考过程.*1 次工具调用/ })).toBeInTheDocument()
    expect(screen.queryByText('读取章节上下文')).not.toBeInTheDocument()
    expect(screen.queryByText('read_file')).not.toBeInTheDocument()
    expect(screen.getByText('已完成续写。')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /思考过程.*1 次工具调用/ }))
    expect(screen.getByText('读取章节上下文')).toBeInTheDocument()
    expect(screen.getByText('read_file')).toBeInTheDocument()
  })

  it('创作 Agent 运行中自动展开思考过程', () => {
    renderAgentPanel({
      isStreaming: true,
      messages: [{
        id: 'assistant-running-trace',
        role: 'assistant',
        parts: [{ type: 'reasoning', text: '正在读取章节上下文', state: 'streaming' }],
      }],
    })

    expect(screen.getByRole('button', { name: /思考过程/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('正在读取章节上下文')).toBeInTheDocument()
  })

  it('打开 SubAgent 详情时通知外层扩展右栏', async () => {
    const user = userEvent.setup()
    const handleDetailsChange = vi.fn()

    renderAgentPanel({
      messages: [{
        id: 'subagent-output-1',
        role: 'assistant',
        metadata: {
          agent_name: 'researcher',
          subagent: true,
          subagent_session_id: 'run-1-subagent-01-researcher',
        },
        parts: [{ type: 'text', text: '调研摘要' }],
      }],
      onSubAgentDetailsChange: handleDetailsChange,
    })

    expect(handleDetailsChange).toHaveBeenLastCalledWith(false)
    await user.click(screen.getByRole('button', { name: /researcher 输出/ }))
    expect(handleDetailsChange).toHaveBeenLastCalledWith(true)
    expect(screen.getAllByText('researcher 子会话').length).toBeGreaterThan(0)
    expect(screen.getByRole('separator', { name: '调整 SubAgent 详情宽度' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '输入动作' })).toHaveLength(1)

    await user.click(screen.getAllByRole('button', { name: '关闭 SubAgent 详情' })[0])
    expect(handleDetailsChange).toHaveBeenLastCalledWith(false)
  })

  it('根据浮动输入区高度为消息列表预留底部空间', async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('nova-chat-input-area-floating')) {
        return { width: 520, height: 220, top: 500, left: 0, right: 520, bottom: 720, x: 0, y: 500, toJSON: () => ({}) } as DOMRect
      }
      return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    })

    try {
      const { container } = renderAgentPanel({
        messages: [{ id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: '最后一行内容' }] }],
      })

      await waitFor(() => {
        expect(container.querySelector('[data-nova-chat-bottom-spacer]')).toHaveStyle({ height: '240px' })
      })
    } finally {
      rectSpy.mockRestore()
    }
  })

  it('收到章节插画 autoSend 事件时直接发送到创作 Agent', async () => {
    const handleSend = vi.fn()
    renderAgentPanel({
      selectedFile: 'chapters/ch01.md',
      currentChapter: {
        path: 'chapters/ch01.md',
        file_name: 'ch01.md',
        display_title: '第一章',
        index: 1,
        words: 100,
        status: 'draft',
        confirmed: false,
        updated_at: '',
        volume: '',
        volume_path: '',
      },
      onSend: handleSend,
    })

    window.dispatchEvent(new CustomEvent('nova:writing-agent-init', {
      detail: { autoSend: true, prompt: '/<chapter-illustration>\n目标章节 / Target chapter: chapters/ch01.md' },
    }))

    await waitFor(() => {
      expect(handleSend).toHaveBeenCalledWith(
        expect.stringContaining('/<chapter-illustration>'),
        expect.objectContaining({ writingSkill: 'novel-lite', tellerId: 'classic' }),
      )
    })
  })

  it('在输入选项中切换叙事风格后用于下一轮创作 Agent 请求', async () => {
    const user = userEvent.setup()
    const handleSend = vi.fn()
    renderAgentPanel({
      tellers: [
        { id: 'classic', name: '默认叙事', style_rules: [] } as any,
        { id: 'slow-burn', name: '慢热叙事', style_rules: [] } as any,
      ],
      onSend: handleSend,
    })

    await user.click(screen.getByRole('button', { name: '输入动作' }))
    await user.hover(screen.getByText('叙事'))
    const slowBurnItem = await screen.findByText('慢热叙事')
    fireEvent.click(slowBurnItem.closest('[role="menuitem"]') || slowBurnItem)

    await waitFor(() => {
      expect(updateUserSettings).toHaveBeenCalledWith(expect.objectContaining({ ide_story_teller_id: 'slow-burn' }))
    })

    window.dispatchEvent(new CustomEvent('nova:writing-agent-init', {
      detail: { autoSend: true, prompt: '继续写下一段' },
    }))

    await waitFor(() => {
      expect(handleSend).toHaveBeenCalledWith(
        '继续写下一段',
        expect.objectContaining({ tellerId: 'slow-burn', writingSkill: 'novel-lite' }),
      )
    })
  })

  it('关闭面板后由稳定 owner 完成仍在 afterDelay 中的偏好保存', async () => {
    const overrides: AgentPanelOverrides = {
      tellers: [
        { id: 'classic', name: '默认叙事', style_rules: [] } as any,
        { id: 'slow-burn', name: '慢热叙事', style_rules: [] } as any,
      ],
    }
    function Owner({ open }: { open: boolean }) {
      const composerSettings = usePersistedUserSettings({ workspace: '/workspace', defaults: WRITING_COMPOSER_SETTING_DEFAULTS })
      return open ? <AgentPanel {...defaultAgentPanelProps(overrides, composerSettings)} /> : null
    }

    const view = render(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 52 }}>
        <WorldContextRunProvider>
          <LibraryContextRunProvider>
            <Owner open />
          </LibraryContextRunProvider>
        </WorldContextRunProvider>
      </VirtuosoMockContext.Provider>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: '输入动作' })).toBeEnabled())

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '输入动作' }))
    await user.hover(screen.getByText('叙事'))
    const slowBurnItem = await screen.findByText('慢热叙事')
    vi.useFakeTimers()
    fireEvent.click(slowBurnItem.closest('[role="menuitem"]') || slowBurnItem)
    expect(updateUserSettings).not.toHaveBeenCalled()

    view.rerender(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 52 }}>
        <WorldContextRunProvider>
          <LibraryContextRunProvider>
            <Owner open={false} />
          </LibraryContextRunProvider>
        </WorldContextRunProvider>
      </VirtuosoMockContext.Provider>,
    )
    await vi.advanceTimersByTimeAsync(1000)

    expect(updateUserSettings).toHaveBeenCalledWith(expect.objectContaining({ ide_story_teller_id: 'slow-burn' }))
  })

  it('发送开始时移走审阅意见，并在请求失败时恢复', async () => {
    const user = userEvent.setup()
    const handleSend = vi.fn()
      .mockImplementationOnce(async (_message, options) => {
        options?.onSubmissionStart?.()
        options?.onSubmissionError?.()
        return false
      })
      .mockImplementationOnce(async (_message, options) => {
        options?.onSubmissionStart?.()
        return true
      })
    const handleSubmitted = vi.fn()
    const handleSubmissionFailed = vi.fn()
    renderAgentPanel({
      onSend: handleSend,
      onReviewFeedbackSubmitted: handleSubmitted,
      onReviewFeedbackSubmissionFailed: handleSubmissionFailed,
      reviewFeedback: [{
        reviewThreadId: 'thread-1',
        comments: [{ id: 'comment-1', group_id: 'group-1', body: '把这里写得更克制' }],
      }],
    })

    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(handleSend).toHaveBeenCalledTimes(1))
    expect(handleSubmitted).toHaveBeenCalledTimes(1)
    expect(handleSubmissionFailed).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(handleSubmitted).toHaveBeenCalledTimes(2))
    expect(handleSubmissionFailed).toHaveBeenCalledTimes(1)
  })

  it('同时提交正文与 Diff 审阅意见并保留各自来源', async () => {
    const user = userEvent.setup()
    const handleSend = vi.fn().mockResolvedValue(true)
    renderAgentPanel({
      onSend: handleSend,
      onReviewFeedbackRemove: vi.fn(),
      reviewFeedback: [
        {
          source: 'workspace_change',
          reviewThreadId: 'diff-thread',
          comments: [{ id: 'diff-comment', body: '调整 Diff 里的转场', review_path: 'chapters/ch01.md' }],
        },
        {
          source: 'document',
          reviewThreadId: 'document-thread',
          comments: [{ id: 'document-comment', body: '正文这里需要更克制', path: 'chapters/ch02.md' }],
        },
      ],
    })

    expect(screen.getByTitle('调整 Diff 里的转场')).toHaveTextContent('Diff · chapters/ch01.md')
    expect(screen.getByTitle('正文这里需要更克制')).toHaveTextContent('正文 · chapters/ch02.md')
    await user.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(handleSend).toHaveBeenCalledWith(
      '请处理这 2 条审阅意见。',
      expect.objectContaining({
        reviewFeedback: [
          { source: 'workspace_change', reviewThreadId: 'diff-thread', commentIds: ['diff-comment'] },
          { source: 'document', reviewThreadId: 'document-thread', commentIds: ['document-comment'] },
        ],
      }),
    ))
  })

  it('将正文审阅引用点击交给工作台导航', async () => {
    const user = userEvent.setup()
    const handleOpen = vi.fn()
    const selection = {
      source: 'document' as const,
      reviewThreadId: 'document-thread',
      comments: [{ id: 'document-comment', body: '正文这里需要更克制', path: 'chapters/ch02.md', review_line: 111 }],
    }
    renderAgentPanel({
      onReviewFeedbackOpen: handleOpen,
      onReviewFeedbackRemove: vi.fn(),
      reviewFeedback: [selection],
    })

    await user.click(screen.getByRole('button', { name: /正文 · chapters\/ch02\.md · 第 111 行 — 正文这里需要更克制/ }))

    expect(handleOpen).toHaveBeenCalledWith(selection, selection.comments[0])
  })

  it('在超过单次评论上限时保留反馈并阻止发送', async () => {
    const user = userEvent.setup()
    const handleSend = vi.fn().mockResolvedValue(true)
    renderAgentPanel({
      onSend: handleSend,
      onReviewFeedbackRemove: vi.fn(),
      reviewFeedback: [{
        reviewThreadId: 'thread-1',
        comments: Array.from({ length: 257 }, (_, index) => ({
          id: `comment-${index}`,
          group_id: 'group-1',
          body: `意见 ${index}`,
        })),
      }],
    })

    expect(screen.getByRole('alert')).toHaveTextContent('一次最多提交 256 条审阅意见')
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(handleSend).not.toHaveBeenCalled()
  })
})

type AgentPanelOverrides = Partial<Omit<ComponentProps<typeof AgentPanel>, 'composerSettings'>>

  it('世界背景状态条：none 隐藏，bound/active/degraded 分别展示且不泄漏内部 ID', () => {
    renderAgentPanel()
    expect(screen.queryByTestId('writing-world-context-state')).not.toBeInTheDocument()

    renderAgentPanel({}, { state: 'bound', hasBound: true, worldName: '苍穹', revisionLabel: 'rev·2', selectedCount: 4 })
    const bound = screen.getAllByTestId('writing-world-context-state').at(-1)!
    expect(bound).toHaveAttribute('data-state', 'bound')
    expect(bound).toHaveTextContent('苍穹')
    expect(bound).toHaveTextContent('rev·2')

    renderAgentPanel({}, { state: 'active', hasBound: true, worldName: '苍穹', selectedCount: 4, analysisHandleStatus: 'consumed' })
    const active = screen.getAllByTestId('writing-world-context-state').at(-1)!
    expect(active).toHaveAttribute('data-state', 'active')
    expect(active).toHaveTextContent('已采用本次上下文分析的背景')
    expect(active).not.toHaveTextContent(/runContext|scopeKey|fingerprint|analysisHandle/i)

    renderAgentPanel({}, { state: 'degraded', hasBound: true, errorCode: 'world_not_found' })
    const degraded = screen.getAllByTestId('writing-world-context-state').at(-1)!
    expect(degraded).toHaveAttribute('data-state', 'degraded')
    expect(degraded).toHaveTextContent('世界不存在或已被删除')
  })

  it('世界背景状态条清除按钮可点击', async () => {
    const user = userEvent.setup()
    renderAgentPanel({}, { state: 'bound', hasBound: true, worldName: '苍穹' })
    await user.click(screen.getAllByTestId('writing-world-context-clear').at(-1)!)
    // 不抛错即通过；真正的清除逻辑由 useAgentChat 注册并在 hook 测试覆盖。
  })

  it('库背景状态条：none 隐藏，bound/active 展示且不泄漏内部 ID（B2b）', () => {
    renderAgentPanel()
    expect(screen.queryByTestId('writing-library-context-state')).not.toBeInTheDocument()

    renderAgentPanel({}, null, { state: 'bound', hasBound: true, libraryName: '测试设定库', revisionLabel: 'rev·9', selectedCount: 2 })
    const bound = screen.getAllByTestId('writing-library-context-state').at(-1)!
    expect(bound).toHaveAttribute('data-state', 'bound')
    expect(bound).toHaveTextContent('测试设定库')
    expect(bound).toHaveTextContent('rev·9')
    expect(bound).toHaveTextContent('已选 2 条')

    renderAgentPanel({}, null, { state: 'active', hasBound: true, libraryName: '测试设定库', selectedCount: 2 })
    const active = screen.getAllByTestId('writing-library-context-state').at(-1)!
    expect(active).toHaveAttribute('data-state', 'active')
    expect(active).toHaveTextContent('只读，不回写设定库')
    expect(active).not.toHaveTextContent(/runContext|scopeKey|consumer|manualItemIds|libraryId|expectedRevision/i)

    // 服务端 none + 本地已绑定：状态条仍在（Ref 供下次发送生效），data-state 与服务端一致。
    renderAgentPanel({}, null, { state: 'none', hasBound: true, libraryName: '测试设定库' })
    const pending = screen.getAllByTestId('writing-library-context-state').at(-1)!
    expect(pending).toHaveAttribute('data-state', 'none')
  })

  it('库背景状态条清除按钮可点击（B2b）', async () => {
    const user = userEvent.setup()
    renderAgentPanel({}, null, { state: 'active', hasBound: true, libraryName: '测试设定库' })
    await user.click(screen.getAllByTestId('writing-library-context-clear').at(-1)!)
    // 不抛错即通过；清除后恢复 none 原状态由 useAgentChat 注册并在 hook 测试覆盖。
  })

function RunViewSeeder({ view }: { view: WritingWorldRunView | null }) {
  const { setView } = useWorldContextRun()
  useEffect(() => {
    if (view) setView(view)
  }, [view, setView])
  return null
}

function LibraryRunViewSeeder({ view }: { view: LibraryContextRunView | null }) {
  const { setView } = useLibraryContextRun()
  useEffect(() => {
    if (view) setView(view)
  }, [view, setView])
  return null
}

function renderAgentPanel(overrides: AgentPanelOverrides = {}, worldView: WritingWorldRunView | null = null, libraryView: LibraryContextRunView | null = null) {
  function Owner() {
    const composerSettings = usePersistedUserSettings({
      workspace: overrides.workspace || '/workspace',
      defaults: WRITING_COMPOSER_SETTING_DEFAULTS,
    })
    return <AgentPanel {...defaultAgentPanelProps(overrides, composerSettings)} />
  }
  return render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 52 }}>
      <WorldContextRunProvider>
        <RunViewSeeder view={worldView} />
        <LibraryContextRunProvider>
          <LibraryRunViewSeeder view={libraryView} />
          <Owner />
        </LibraryContextRunProvider>
      </WorldContextRunProvider>
    </VirtuosoMockContext.Provider>,
  )
}

function defaultAgentPanelProps(
  overrides: AgentPanelOverrides,
  composerSettings: WritingComposerSettingsController,
): ComponentProps<typeof AgentPanel> {
  return {
    workspace: '/workspace',
    composerSettings,
    selectedFile: null,
    tellers: [{ id: 'classic', name: '默认叙事', style_rules: [] } as any],
    messages: [],
    sessions: [{ id: 'session-1', title: '当前会话', active: true, message_count: 0, created_at: '', updated_at: '' }],
    activeSessionId: 'session-1',
    isStreaming: false,
    activityContent: '',
    hasEarlierMessages: false,
    isLoadingEarlierHistory: false,
    references: [],
    loreReferences: [],
    loreReferenceLabels: {},
    loreSuggestions: [],
    styleScenes: [],
    textSelections: [],
    planMode: false,
    fileSuggestions: [],
    onCreateSession: vi.fn(),
    onSwitchSession: vi.fn(),
    onRenameSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onLoadEarlierHistory: vi.fn(),
    onSend: vi.fn(),
    onAnalyzeContext: vi.fn().mockResolvedValue({} as any),
    onStop: vi.fn(),
    onReferenceRemove: vi.fn(),
    onLoreReferenceAdd: vi.fn(),
    onLoreReferenceRemove: vi.fn(),
    onStyleSceneAdd: vi.fn(),
    onStyleSceneRemove: vi.fn(),
    onTextSelectionRemove: vi.fn(),
    onPlanModeChange: vi.fn(),
    onPlanModeToggle: vi.fn(),
    onSubmitPlanQuestion: vi.fn(),
    onApproveProposedPlan: vi.fn(),
    onExitPlanMode: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}
