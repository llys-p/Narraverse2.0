import { useTranslation } from 'react-i18next'
import { AutosaveStatusIndicator } from '@/components/forms/autosave-status'
import { InlineErrorNotice } from '@/components/common/inline-error-notice'
import type { LoreItem } from '@/lib/api'
import { BookOverviewPanel } from '@/features/interactive/components/setting-panel/BookOverviewPanel'
import type { BookOverviewDraft } from '../use-book-library-overview'

interface OverviewViewProps {
  workspace: string
  items: LoreItem[]
  draft: BookOverviewDraft
  onOpenItem: (id: string) => void
  onSaved: (ids?: string[]) => void
}

/**
 * 总览视图：内容与保存通道由工作台的 useBookOverview 持有，
 * 本组件只负责渲染与转交保存，切页不会把草稿留在已卸载的组件里。
 */
export function OverviewView({ workspace, items, draft, onOpenItem, onSaved }: OverviewViewProps) {
  const { t } = useTranslation()

  if (!workspace) return null

  return (
    <div className="bl-overview-host">
      <p className="px-3 py-2 text-sm text-muted-foreground">{t('bookLibrary.overview.purpose')}</p>
      {draft.error ? (
        <InlineErrorNotice className="mx-3 mt-2" title={t('bookLibrary.overview.error')} message={draft.error} />
      ) : null}
      <div className="bl-overview-status">
        <AutosaveStatusIndicator
          status={draft.status}
          error={draft.saveStatusError}
          onRetry={() => { void draft.flush().then((ok) => { if (ok) onSaved() }) }}
        />
      </div>
      <BookOverviewPanel
        key={workspace}
        workspace={workspace}
        content={draft.content}
        setContent={draft.setContent}
        items={items}
        onOpenItem={onOpenItem}
        onSave={() => { void draft.flush().then((ok) => { if (ok) onSaved() }) }}
      />
    </div>
  )
}
