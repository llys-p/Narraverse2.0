import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { WorkLibraryTimelineEntry } from '@/lib/api-client'

interface Props {
  timeline: WorkLibraryTimelineEntry[]
  onOpen: (itemId: string) => void
  onCreate: () => void
}

export function LibraryTimelinePanel({ timeline, onOpen, onCreate }: Props) {
  const { t } = useTranslation()
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs">
      <p className="text-muted-foreground">{t('workLibrary.timeline.hint')}</p>
      <Button type="button" size="sm" onClick={onCreate}>{t('workLibrary.timeline.new')}</Button>
      {timeline.length === 0 ? <p className="text-muted-foreground">{t('workLibrary.timeline.emptyBody')}</p> : (
        <ol className="space-y-2">
          {timeline.map((entry) => <li key={entry.itemId}>
            <button type="button" className="flex w-full min-w-0 flex-col gap-1 rounded border border-[var(--nova-border)] p-2 text-left hover:border-[var(--nova-ring)]"
              onClick={() => onOpen(entry.itemId)}>
              <span className="font-medium">{entry.title}</span>
              <span className="break-words text-muted-foreground">
                {t(`workLibrary.eventCategory.${entry.category}`, { defaultValue: entry.category })} · {entry.era} · {entry.order}
              </span>
            </button>
          </li>)}
        </ol>
      )}
      <p className="text-muted-foreground">{t('workLibrary.timeline.derivedHint')}</p>
    </div>
  )
}
