import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState, type ComponentProps, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePersistedUserSettings } from '@/hooks/usePersistedUserSettings'
import { ModeRouter } from './ModeRouter'
import { useWorkspaceStore } from '@/stores/workspace-store'

const toastMock = vi.hoisted(() => ({ warning: vi.fn() }))
const useDocumentReviewMock = vi.hoisted(() => vi.fn())
const bookDraftFlush = vi.hoisted(() => vi.fn(async () => true))

vi.mock('sonner', () => ({ toast: toastMock }))

vi.mock('@/hooks/usePersistedUserSettings', () => ({
  usePersistedUserSettings: vi.fn(),
}))

vi.mock('@/components/Chat/AgentPanel', () => ({
  WRITING_COMPOSER_SETTING_DEFAULTS: {
    ide_story_teller_id: 'classic',
    ide_image_preset_id: 'game-cg',
    writing_skill_default: 'novel-lite',
  },
  AgentPanel: ({ reviewFeedback, onReviewFeedbackOpen }: {
    reviewFeedback?: Array<{ comments: Array<{ id: string }> }>
    onReviewFeedbackOpen?: (selection: unknown, comment: unknown) => void
  }) => {
    const selection = reviewFeedback?.[0]
    const comment = selection?.comments[0]
    return (
      <button type="button" disabled={!selection || !comment} onClick={() => onReviewFeedbackOpen?.(selection, comment)}>
        open document feedback
      </button>
    )
  },
}))

vi.mock('@/components/Editor/MarkdownEditor', () => ({
  MarkdownEditor: ({ fileName, documentReviewNavigationIntent }: {
    fileName: string | null
    documentReviewNavigationIntent?: { commentID: string; nonce: number } | null
  }) => (
    <div data-testid="markdown-editor-navigation">
      {fileName || 'none'}|{documentReviewNavigationIntent?.commentID || 'none'}|{documentReviewNavigationIntent?.nonce || 0}
    </div>
  ),
}))

vi.mock('@/features/interactive/api', () => ({
  getImagePresets: vi.fn(async () => []),
  getInteractiveTellers: vi.fn(async () => []),
}))

vi.mock('@/features/interactive/stores/interactive-store', () => ({
  useInteractiveStore: (selector: (state: { submode: string; setSubmode: () => void }) => unknown) => selector({
    submode: 'story',
    setSubmode: vi.fn(),
  }),
}))

vi.mock('@/features/changes/use-writing-change-review', () => ({
  useWritingChangeReview: () => ({
    activeReviewThreadID: '',
    activeReviewRequest: null,
    reviewFeedback: null,
    submittedReviewCommentIDs: new Set<string>(),
    openChangeReview: vi.fn(),
    closeChangeReview: vi.fn(),
    selectReviewFeedback: vi.fn(),
    removeReviewFeedback: vi.fn(),
    submitReviewFeedback: vi.fn(),
    restoreReviewFeedback: vi.fn(),
  }),
}))

vi.mock('@/features/document-review/use-document-review', () => ({
  useDocumentReview: useDocumentReviewMock,
}))

vi.mock('@/features/world-context-runtime/WorldContextHostProvider', () => ({
  useWorldContextHost: () => ({ state: 'ready', migration: null }),
}))

vi.mock('@/features/library-workspace/LibraryWorkspacePage', () => ({
  LibraryWorkspacePage: () => <div data-testid="library-workspace-page">work library</div>,
}))
vi.mock('@/features/library/LibraryView', () => ({ LibraryView: () => <div>public materials</div> }))
vi.mock('@/features/book-library/BookLibraryWorkspace', () => ({
  BookLibraryWorkspace: ({ onFlushHandlerChange, onClose }: { onFlushHandlerChange?: (handler: (() => Promise<boolean>) | null) => void; onClose?: () => void }) => {
    useEffect(() => {
      onFlushHandlerChange?.(bookDraftFlush)
      return () => onFlushHandlerChange?.(null)
    }, [onFlushHandlerChange])
    return <div data-testid="book-library-draft">book draft<button type="button" onClick={onClose}>close unified library</button></div>
  },
}))

vi.mock('@/features/interactive/components/SettingPanel', () => ({
  SettingPanel: ({ mode, workspace, onClose }: { mode: string; workspace: string; onClose: () => void }) => (
    <div data-testid="book-lore-panel" data-mode={mode} data-workspace={workspace}>
      <button type="button" onClick={onClose}>close book lore</button>
    </div>
  ),
}))

vi.mock('@/features/world-context-runtime/IframeWorldContextLaunchProvider', () => ({
  useIframeWorldContextLaunch: () => ({
    pending: { narraverse: null, module4: null },
    launch: vi.fn(),
    take: vi.fn(),
    clear: vi.fn(),
  }),
}))

vi.mock('./WorkbenchShell', () => ({
  WorkbenchShell: ({ onQuickSwitchBook, onSetRightPanel, main, rightPanelContent }: {
    onQuickSwitchBook: (path: string) => Promise<boolean>
    onSetRightPanel: (panel: 'lore' | null) => void
    main: ReactNode
    rightPanelContent: ReactNode
  }) => (
    <>
      <button type="button" onClick={() => { void onQuickSwitchBook('/book-b') }}>
        quick switch
      </button>
      <button type="button" onClick={() => onSetRightPanel('lore')}>open book lore</button>
      {main}
      {rightPanelContent}
    </>
  ),
}))

describe('ModeRouter autosave navigation policy', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ librarySection: null })
    bookDraftFlush.mockReset().mockResolvedValue(true)
    toastMock.warning.mockReset()
    useDocumentReviewMock.mockReset()
    useDocumentReviewMock.mockReturnValue({
      feedback: null,
      thread: { comments: [] },
      addComment: vi.fn(),
      editComment: vi.fn(),
      removeComment: vi.fn(),
      removeFeedback: vi.fn(),
      submitFeedback: vi.fn(),
      restoreFeedback: vi.fn(),
    })
    vi.mocked(usePersistedUserSettings).mockReturnValue({
      values: {
        ide_story_teller_id: 'classic',
        ide_image_preset_id: 'game-cg',
        writing_skill_default: 'novel-lite',
      },
      loading: false,
      isSaving: vi.fn(() => true),
      persist: vi.fn(async () => true),
      reload: vi.fn(async () => null),
      flushPending: vi.fn(async () => false),
    })
  })

  it('continues a workspace switch and warns when preference flush remains pending', async () => {
    const user = userEvent.setup()
    const onQuickSwitchBook = vi.fn(async () => true)
    render(<ModeRouter {...modeRouterProps({ onQuickSwitchBook })} />)

    await user.click(screen.getByRole('button', { name: 'quick switch' }))

    await waitFor(() => expect(onQuickSwitchBook).toHaveBeenCalledWith('/book-b'))
    expect(toastMock.warning).toHaveBeenCalledWith('偏好设置暂未保存', {
      description: '本地修改已保留，将在下次自动保存时重试。',
    })
  })

  it('does not wait for a slow preference request before switching workspaces', async () => {
    const user = userEvent.setup()
    let resolveFlush!: (saved: boolean) => void
    const pendingFlush = new Promise<boolean>((resolve) => { resolveFlush = resolve })
    vi.mocked(usePersistedUserSettings).mockReturnValue({
      values: {
        ide_story_teller_id: 'classic',
        ide_image_preset_id: 'game-cg',
        writing_skill_default: 'novel-lite',
      },
      loading: false,
      isSaving: vi.fn(() => true),
      persist: vi.fn(async () => true),
      reload: vi.fn(async () => null),
      flushPending: vi.fn(() => pendingFlush),
    })
    const onQuickSwitchBook = vi.fn(async () => true)
    render(<ModeRouter {...modeRouterProps({ onQuickSwitchBook })} />)

    await user.click(screen.getByRole('button', { name: 'quick switch' }))
    expect(onQuickSwitchBook).toHaveBeenCalledWith('/book-b')

    resolveFlush(false)
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalled())
  })

  it('opens the referenced chapter before revealing its document review comment', async () => {
    const user = userEvent.setup()
    const comment = {
      id: 'document-comment',
      thread_id: 'document-thread',
      path: 'chapters/ch02.md',
      body: '正文这里需要更克制',
      created_at: '',
      updated_at: '',
      review_line: 111,
    }
    const feedback = {
      source: 'document' as const,
      reviewThreadId: 'document-thread',
      comments: [comment],
    }
    useDocumentReviewMock.mockReturnValue({
      feedback,
      thread: { comments: [comment] },
      addComment: vi.fn(),
      editComment: vi.fn(),
      removeComment: vi.fn(),
      removeFeedback: vi.fn(),
      submitFeedback: vi.fn(),
      restoreFeedback: vi.fn(),
    })
    const handleSelectFile = vi.fn(async (_path: string) => true)

    function Harness() {
      const [selectedFile, setSelectedFile] = useState('chapters/ch03.md')
      return (
        <ModeRouter
          {...modeRouterProps({
            rightPanel: 'ai',
            selectedFile,
            openTabs: [{ kind: 'file', path: 'chapters/ch03.md' }],
            activeTabKey: 'file:chapters/ch03.md',
            onSelectFile: async (path) => {
              const navigated = await handleSelectFile(path)
              if (navigated !== false) setSelectedFile(path)
              return navigated
            },
          })}
        />
      )
    }

    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'open document feedback' }))

    await waitFor(() => expect(handleSelectFile).toHaveBeenCalledWith(comment.path))
    await waitFor(() => expect(screen.getByTestId('markdown-editor-navigation')).toHaveTextContent(
      `${comment.path}|${comment.id}|1`,
    ))

    await user.click(screen.getByRole('button', { name: 'open document feedback' }))
    await waitFor(() => expect(screen.getByTestId('markdown-editor-navigation')).toHaveTextContent(
      `${comment.path}|${comment.id}|2`,
    ))
    expect(handleSelectFile).toHaveBeenCalledTimes(1)
  })

  it('keeps the narraverse iframe mounted while switching content modes', () => {
    const props = modeRouterProps({ mode: 'narraverse', booksReturnMode: 'narraverse' })
    const view = render(<ModeRouter {...props} />)
    const iframe = view.container.querySelector('iframe')

    const iframeURL = new URL(iframe?.getAttribute('src') || '')
    expect(iframeURL.hostname).toBe('localhost')
    expect(iframeURL.pathname).toBe('/narraverse/index.html')
    expect(iframeURL.searchParams.get('embedded')).toBe('denova')
    expect(iframeURL.searchParams.get('host_origin')).toBe(window.location.origin)
    expect(iframeURL.searchParams.get('v')).toBe('20261006-book-lore-v2')

    view.rerender(<ModeRouter {...props} mode="ide" />)
    expect(view.container.querySelector('iframe')).toBe(iframe)
    expect(iframe?.closest('section')).toHaveAttribute('hidden')

    view.rerender(<ModeRouter {...props} mode="narraverse" />)
    expect(view.container.querySelector('iframe')).toBe(iframe)
    expect(iframe?.closest('section')).not.toHaveAttribute('hidden')
  })

  it('waits for the book overview save before the desktop quick switch', async () => {
    const user = userEvent.setup()
    let resolveSave!: (ok: boolean) => void
    bookDraftFlush.mockImplementation(() => new Promise<boolean>((resolve) => { resolveSave = resolve }))
    const onQuickSwitchBook = vi.fn(async () => true)
    render(<ModeRouter {...modeRouterProps({ mode: 'library', onQuickSwitchBook })} />)
    await screen.findByTestId('book-library-draft')
    await user.click(screen.getByRole('button', { name: 'quick switch' }))
    expect(bookDraftFlush).toHaveBeenCalledOnce()
    expect(onQuickSwitchBook).not.toHaveBeenCalled()
    resolveSave(true)
    await waitFor(() => expect(onQuickSwitchBook).toHaveBeenCalledWith('/book-b'))
  })

  it('does not switch books when the book overview save fails', async () => {
    const user = userEvent.setup()
    bookDraftFlush.mockResolvedValue(false)
    const onQuickSwitchBook = vi.fn(async () => true)
    render(<ModeRouter {...modeRouterProps({ mode: 'library', onQuickSwitchBook })} />)
    await screen.findByTestId('book-library-draft')
    await user.click(screen.getByRole('button', { name: 'quick switch' }))
    await waitFor(() => expect(bookDraftFlush).toHaveBeenCalledOnce())
    expect(onQuickSwitchBook).not.toHaveBeenCalled()
  })

  it('opens and closes the unified library from Module4 without unloading its iframe', async () => {
    const user = userEvent.setup()

    function Harness() {
      const [rightPanel, setRightPanel] = useState<ComponentProps<typeof ModeRouter>['rightPanel']>(null)
      const [mode, setMode] = useState<ComponentProps<typeof ModeRouter>['mode']>('narraverse')
      return (
        <ModeRouter
          {...modeRouterProps({ mode, onSetMode: setMode, booksReturnMode: 'narraverse', openModule4: true, rightPanel, onSetRightPanel: setRightPanel })}
        />
      )
    }

    const view = render(<Harness />)
    const iframe = view.container.querySelector('iframe')
    expect(iframe).toBeInTheDocument()
    expect(iframe?.closest('section')).not.toHaveAttribute('hidden')

    await user.click(screen.getByRole('button', { name: 'open book lore' }))
    await screen.findByTestId('book-library-draft')
    expect(screen.queryByTestId('book-lore-panel')).not.toBeInTheDocument()
    expect(iframe?.closest('section')).toHaveAttribute('hidden')
    expect(view.container.querySelector('iframe')).toBe(iframe)

    await user.click(screen.getByRole('button', { name: 'close unified library' }))
    await waitFor(() => expect(iframe?.closest('section')).not.toHaveAttribute('hidden'))
    expect(view.container.querySelector('iframe')).toBe(iframe)
  })

  it('shows the work library page without an open book', async () => {
    // 作品设定库是自包含的共享模式：没有当前书籍时也必须可见，
    // 不能被「无书籍 → 回落到 books」的守卫弹回书库。
    // 库路由是 lazy 的，需要等 Suspense 落地。
    render(
      <ModeRouter {...modeRouterProps({ mode: 'library', workspace: '', currentBookName: '' })} />,
    )
    const page = await screen.findByTestId('library-workspace-page')

    expect(page).toBeInTheDocument()
    expect(page.closest('section')).not.toHaveAttribute('hidden')
  })
})

function modeRouterProps(
  overrides: Partial<ComponentProps<typeof ModeRouter>> = {},
): ComponentProps<typeof ModeRouter> {
  return {
    mode: 'ide',
    booksReturnMode: 'ide',
    currentBookName: 'Book A',
    workspace: '/book-a',
    appVersion: 'test',
    summary: null,
    chapterStats: {},
    isStreaming: false,
    projectVisible: true,
    activityBarExpanded: true,
    rightPanel: null,
    settingsOpen: false,
    interactiveRightVisible: false,
    novaDir: '/book-a/.nova',
    books: [],
    bookSortMode: 'recent',
    tree: [],
    loading: false,
    selectedFile: null,
    fileContent: '',
    fileRevision: '',
    openTabs: [],
    activeTabKey: null,
    sidebarView: 'outline',
    editorSearchIntent: null,
    saveSignal: 0,
    editorAutoSaveEnabled: true,
    editorAutoSaveDelayMs: 1000,
    versionRefreshSignal: 0,
    messages: [],
    sessions: [],
    activeSessionId: '',
    activityContent: '',
    hasEarlierMessages: false,
    isLoadingEarlierHistory: false,
    references: [],
    loreReferences: [],
    loreItems: [],
    styleScenes: [],
    textSelections: [],
    chatPlanMode: false,
    onSetMode: vi.fn(),
    onToggleActivityBarExpanded: vi.fn(),
    onToggleProjectVisible: vi.fn(),
    onSetRightPanel: vi.fn(),
    onToggleSettings: vi.fn(),
    onCloseSettings: vi.fn(),
    onToggleInteractiveRightPanel: vi.fn(),
    onSwitchBook: vi.fn(),
    onQuickSwitchBook: vi.fn(async () => true),
    onBeforeWorkspaceSwitch: vi.fn(async () => true),
    onBooksChange: vi.fn(),
    onOpenCharacterCardImport: vi.fn(),
    onSetSidebarView: vi.fn(),
    onSelectSearchResult: vi.fn(),
    onSelectFile: vi.fn(),
    onSetChapterConfirmed: vi.fn(),
    onReferenceFile: vi.fn(),
    onCreateItem: vi.fn(),
    onDeleteItem: vi.fn(),
    onRenameItem: vi.fn(),
    onCopyItem: vi.fn(),
    onMoveItem: vi.fn(),
    onActivateTab: vi.fn(),
    onCloseTab: vi.fn(),
    onSaveCurrentFile: vi.fn(),
    onEditorFlushHandlerChange: vi.fn(),
    onWorkspaceChanged: vi.fn(),
    onQuoteSelection: vi.fn(),
    onCreateChatSession: vi.fn(),
    onSwitchChatSession: vi.fn(),
    onRenameChatSession: vi.fn(),
    onDeleteChatSession: vi.fn(),
    onLoadEarlierHistory: vi.fn(),
    onSend: vi.fn(),
    onAnalyzeContext: vi.fn(async () => ({} as any)),
    onStop: vi.fn(),
    onReferenceRemove: vi.fn(),
    onLoreReferenceAdd: vi.fn(),
    onLoreReferenceRemove: vi.fn(),
    onStyleSceneAdd: vi.fn(),
    onStyleSceneRemove: vi.fn(),
    onTextSelectionRemove: vi.fn(),
    onChatPlanModeChange: vi.fn(),
    onChatPlanModeToggle: vi.fn(),
    onSubmitPlanQuestion: vi.fn(),
    onApproveProposedPlan: vi.fn(),
    onExitChatPlanMode: vi.fn(),
    ...overrides,
  }
}
