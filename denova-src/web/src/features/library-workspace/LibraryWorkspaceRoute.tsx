import { lazy, Suspense, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LibraryWorkspacePage } from './LibraryWorkspacePage'

// 资料库入口 = 「本书资料」+「作品设定库」+「公共素材」三个分区。
//
// 三者各管各的原件与写入责任，这里只统一取材入口，避免出现多套导航各说各话：
// 本书资料按当前 workspace 身份读写真实 Lore；作品设定库是独立的 L 库；
// 公共素材仍是既有 Master 资料页（原件、导入、翻译）。
// 有当前书时默认进本书分区——这是用户整理这本书资料时最先要到的地方；
// 没有书时回落作品设定库，保证「不必先建书也能整理资料」的既有行为不变。

const LibraryView = lazy(() => import('@/features/library/LibraryView').then((module) => ({ default: module.LibraryView })))
const BookLibraryWorkspace = lazy(() => import('@/features/book-library/BookLibraryWorkspace').then((module) => ({ default: module.BookLibraryWorkspace })))

export type LibrarySection = 'book' | 'mine' | 'public'

const SECTION_ORDER: LibrarySection[] = ['book', 'mine', 'public']

interface LibraryWorkspaceRouteProps {
  workspace: string
  bookName?: string
  section?: LibrarySection
  onSectionChange?: (section: LibrarySection) => void
  onClose: () => void
  onBookFlushHandlerChange?: (handler: (() => Promise<boolean>) | null) => void
  /** B2b：用户在库工作区显式带入写作（写入一次性交接并切回写作模式）。 */
  onLaunchWriting?: () => void
  /** B3b：用户在库工作区显式带入游戏（选择目标故事/分支成功后切到游戏模式）。 */
  onLaunchGame?: () => void
  /** B4a：用户在库工作区显式带入叙界（宿主受控 iframe）。 */
  onLaunchNarraverse?: () => void
  /** B4b：用户在库工作区显式带入开放沙盒（Module4）。 */
  onLaunchModule4?: () => void
}

export function LibraryWorkspaceRoute({
  workspace,
  bookName = '',
  section: controlledSection,
  onSectionChange,
  onClose,
  onBookFlushHandlerChange,
  onLaunchWriting,
  onLaunchGame,
  onLaunchNarraverse,
  onLaunchModule4,
}: LibraryWorkspaceRouteProps) {
  const { t } = useTranslation()
  const [ownSection, setOwnSection] = useState<LibrarySection>(workspace ? 'book' : 'mine')
  const section = controlledSection ?? ownSection
  const [dirty, setDirty] = useState(false)

  // 外部入口（写作/游戏的本书资料快捷入口）请求切分区时以请求为准。
  useEffect(() => {
    if (controlledSection) setOwnSection(controlledSection)
  }, [controlledSection])

  const switchSection = (value: LibrarySection) => {
    if (value === section) return
    if (dirty && !window.confirm(t('workLibrary.reloadConfirm'))) return
    setDirty(false)
    setOwnSection(value)
    onSectionChange?.(value)
  }

  const resolveSection = (value: LibrarySection) => (value === 'book' ? t('bookLibrary.nav.bookSection') : t(value === 'mine' ? 'workLibrary.section.mine' : 'workLibrary.section.public'))

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div
        role="tablist"
        className="nova-topbar flex shrink-0 items-center gap-1 border-b px-3 py-1.5 text-xs"
      >
        {SECTION_ORDER.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={section === value}
            onClick={() => switchSection(value)}
            className={`rounded-[var(--radius-sm)] px-2 py-0.5 transition-colors ${section === value ? 'bg-[var(--nova-surface-2)] text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {resolveSection(value)}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {section === 'book' ? (
          <Suspense fallback={null}>
            <BookLibraryWorkspace
              workspace={workspace}
              bookName={bookName || workspace}
              onClose={onClose}
              onDirtyChange={setDirty}
              onFlushHandlerChange={onBookFlushHandlerChange}
            />
          </Suspense>
        ) : section === 'mine' ? (
          <LibraryWorkspacePage onClose={onClose} onDirtyChange={setDirty} hasWritingBook={Boolean(workspace)} onLaunchWriting={onLaunchWriting} onLaunchGame={onLaunchGame} onLaunchNarraverse={onLaunchNarraverse} onLaunchModule4={onLaunchModule4} />
        ) : (
          <Suspense fallback={null}>
            <LibraryView workspace={workspace} onClose={onClose} />
          </Suspense>
        )}
      </div>
    </div>
  )
}
