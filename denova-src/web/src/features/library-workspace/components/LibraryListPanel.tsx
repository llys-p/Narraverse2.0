import { useState } from 'react'
import { AlertTriangle, BookMarked, Library, Loader2, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/common/EmptyState'
import { Button } from '@/components/ui/button'
import type { WorkLibrarySummary, WorkLibraryVocabulary } from '@/lib/api-client'
import { summarizeForCard } from '../library-draft'
import type { LoadStatus } from '../use-work-library'

// 我的作品设定库：列表 + 新建。
//
// 列表项展示计数（条目/事件/关系/只读引用）与用途标注；损坏文件单列告警，
// 不静默丢弃（用户至少知道自己有一份文件读不出来）。

interface LibraryListPanelProps {
  status: LoadStatus
  error?: string | null
  onRetry?: () => void
  libraries: WorkLibrarySummary[]
  warnings: { file: string; id?: string; reason: string }[]
  creating: boolean
  vocabulary: WorkLibraryVocabulary | null
  onOpen: (id: string) => void
  onCreate: (input: { name: string; summary?: string; purpose?: string }) => Promise<boolean> | void
}

const inputClass = 'h-8 w-full rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-2.5 text-sm outline-none focus:border-[var(--nova-ring)]'

export function LibraryListPanel({
  status,
  error,
  onRetry,
  libraries,
  warnings,
  creating,
  vocabulary,
  onOpen,
  onCreate,
}: LibraryListPanelProps) {
  const { t } = useTranslation()
  const [creatingOpen, setCreatingOpen] = useState(false)
  const [name, setName] = useState('')
  const [summary, setSummary] = useState('')
  const [purpose, setPurpose] = useState('any')
  const [nameMissing, setNameMissing] = useState(false)

  const purposes = vocabulary?.purposes ?? ['any', 'writing', 'game', 'narraverse', 'sandbox', 'mixed']

  const resetForm = () => {
    setName('')
    setSummary('')
    setPurpose('any')
    setNameMissing(false)
  }

  const submit = async () => {
    const trimmed = name.trim()
    // 按钮禁用时 Enter 仍会触发：给出行内提示，不能静默无响应。
    if (!trimmed) {
      setNameMissing(true)
      return
    }
    const created = await onCreate({ name: trimmed, summary: summary.trim() || undefined, purpose })
    if (created === false) return
    resetForm()
    setCreatingOpen(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--nova-border)] px-3 py-2">
        <span className="text-xs text-muted-foreground">{t('workLibrary.list.description')}</span>
        <Button type="button" size="sm" className="ml-auto" onClick={() => {
          setCreatingOpen((open) => !open)
          setNameMissing(false)
        }}>
          <Plus className="size-3.5" />
          {t('workLibrary.create.submit')}
        </Button>
      </div>

      {creatingOpen ? (
        <div className="shrink-0 border-b border-[var(--nova-border)] bg-[var(--nova-surface-2)]/40 p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">{t('workLibrary.create.name')}</span>
              <input
                className={inputClass}
                value={name}
                maxLength={120}
                autoFocus
                aria-invalid={nameMissing}
                placeholder={t('workLibrary.create.namePlaceholder')}
                onChange={(event) => {
                  setName(event.target.value)
                  if (nameMissing && event.target.value.trim()) setNameMissing(false)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit()
                }}
              />
              {nameMissing ? (
                <span role="alert" className="text-[11px] text-[var(--nova-danger)]">{t('workLibrary.create.nameRequired')}</span>
              ) : null}
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">{t('workLibrary.create.purpose')}</span>
              <select className={inputClass} value={purpose} onChange={(event) => setPurpose(event.target.value)}>
                {purposes.map((value) => (
                  <option key={value} value={value}>{t(`workLibrary.purpose.${value}`, { defaultValue: value })}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="mt-2 flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">{t('workLibrary.create.summary')}</span>
            <input
              className={inputClass}
              value={summary}
              maxLength={4000}
              onChange={(event) => setSummary(event.target.value)}
            />
          </label>
          <p className="mt-1 text-[11px] text-muted-foreground">{t('workLibrary.create.purposeHint')}</p>
          <div className="mt-2 flex items-center gap-2">
            <Button type="button" size="sm" disabled={creating || !name.trim()} onClick={() => void submit()}>
              {creating ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {creating ? t('workLibrary.create.creating') : t('workLibrary.create.submit')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setCreatingOpen(false); resetForm() }}>
              {t('workLibrary.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="shrink-0 border-b border-[var(--nova-border)] bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
          <div className="flex items-center gap-1 font-medium">
            <AlertTriangle className="size-3.5" />
            {t('workLibrary.list.warnings', { count: warnings.length })}
          </div>
          <p className="mt-0.5">{t('workLibrary.list.warningsHint')}</p>
          <ul className="mt-1 space-y-0.5 font-mono">
            {warnings.map((warning) => (
              <li key={warning.file}>{warning.file}: {warning.reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {status === 'loading' ? (
          <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t('workLibrary.loading')}
          </div>
        ) : status === 'error' ? (
          <div role="alert" className="space-y-2 p-3 text-xs">
            <p>{error || t('workLibrary.loadError')}</p>
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>{t('workLibrary.retry')}</Button>
          </div>
        ) : libraries.length === 0 ? (
          <EmptyState
            icon={Library}
            variant="dashed"
            title={t('workLibrary.list.empty.title')}
            description={t('workLibrary.list.empty.body')}
            action={{ label: t('workLibrary.create.submit'), onClick: () => setCreatingOpen(true) }}
          />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {libraries.map((library) => (
              <li key={library.id}>
                <button
                  type="button"
                  onClick={() => onOpen(library.id)}
                  className="flex h-full w-full flex-col gap-1.5 rounded-[var(--radius-lg)] border border-[var(--nova-border)] bg-[var(--nova-surface)] p-3 text-left transition-colors hover:border-[var(--nova-ring)]"
                >
                  <div className="flex items-center gap-2">
                    <BookMarked className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate text-sm font-medium text-foreground">{library.name}</span>
                    <span className="ml-auto shrink-0 rounded-full border border-[var(--nova-border)] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {t(`workLibrary.purpose.${library.purpose}`, { defaultValue: library.purpose })}
                    </span>
                  </div>
                  {library.summary ? (
                    <p className="line-clamp-2 text-[11px] leading-5 text-muted-foreground">{library.summary}</p>
                  ) : null}
                  <div className="mt-auto flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                    {summarizeForCard(library).map((item) => (
                      <span key={item.key}>{t(item.key, { count: item.count })}</span>
                    ))}
                  </div>
                  <span className="text-[10px] text-muted-foreground">{t('workLibrary.list.updatedAt', { time: library.updatedAt })}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
