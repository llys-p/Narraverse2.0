import { lazy, Suspense, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LibraryWorkspacePage } from './LibraryWorkspacePage'

// 资料库入口 = 「我的作品设定库」+「公共素材」两个分区。
//
// 公共素材仍是既有的 Master 资料页（原件、导入、翻译），这里只是把它和新的
// 作品设定库并列，避免出现两套入口各说各话；默认进入作品设定库，因为 L1 的目标
// 是“用户不必先建书就能整理资料”，而公共素材是可选的上游来源。

const LibraryView = lazy(() => import('@/features/library/LibraryView').then((module) => ({ default: module.LibraryView })))

type LibrarySection = 'mine' | 'public'

interface LibraryWorkspaceRouteProps {
  workspace: string
  onClose: () => void
  /** B2b：用户在库工作区显式带入写作（写入一次性交接并切回写作模式）。 */
  onLaunchWriting?: () => void
}

export function LibraryWorkspaceRoute({ workspace, onClose, onLaunchWriting }: LibraryWorkspaceRouteProps) {
  const { t } = useTranslation()
  const [section, setSection] = useState<LibrarySection>('mine')
  const [dirty, setDirty] = useState(false)

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div
        role="tablist"
        className="nova-topbar flex shrink-0 items-center gap-1 border-b px-3 py-1.5 text-xs"
      >
        {(['mine', 'public'] as LibrarySection[]).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={section === value}
            onClick={() => {
              if (value === section) return
              if (dirty && !window.confirm(t('workLibrary.reloadConfirm'))) return
              setDirty(false)
              setSection(value)
            }}
            className={`rounded-[var(--radius-sm)] px-2 py-0.5 transition-colors ${section === value ? 'bg-[var(--nova-surface-2)] text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t(value === 'mine' ? 'workLibrary.section.mine' : 'workLibrary.section.public')}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {section === 'mine' ? (
          <LibraryWorkspacePage onClose={onClose} onDirtyChange={setDirty} hasWritingBook={Boolean(workspace)} onLaunchWriting={onLaunchWriting} />
        ) : (
          <Suspense fallback={null}>
            <LibraryView workspace={workspace} onClose={onClose} />
          </Suspense>
        )}
      </div>
    </div>
  )
}
