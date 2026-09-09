import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Archive, ArrowRight, Globe2, Loader2, MapPin, RotateCcw, Shield, Users, History as HistoryIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/common/EmptyState'
import { APIError } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import { archiveWorld, getWorld, listWorlds } from '../world-api'
import { formatStamp } from '../selectors'
import type { WorldLoadWarning, WorldSummary } from '../types'

type Filter = 'all' | 'active' | 'archived'
type LoadState = 'loading' | 'error' | 'ready'

interface WorldListPageProps {
  reloadToken: number
  onCreate: () => void
  onOpen: (id: string) => void
}

export function WorldListPage({ reloadToken, onCreate, onOpen }: WorldListPageProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<LoadState>('loading')
  const [summaries, setSummaries] = useState<WorldSummary[]>([])
  const [warnings, setWarnings] = useState<WorldLoadWarning[]>([])
  const [filter, setFilter] = useState<Filter>('active')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setState('loading')
    try {
      const res = await listWorlds('all')
      setSummaries(res.worlds ?? [])
      setWarnings(res.warnings ?? [])
      setState('ready')
    } catch {
      setState('error')
    }
  }, [])

  useEffect(() => { void load() }, [load, reloadToken])

  const visible = summaries.filter((s) => filter === 'all' ? true : filter === 'archived' ? s.status === 'archived' : s.status === 'active')

  const setArchived = async (summary: Pick<WorldSummary, 'id' | 'status' | 'updatedAt'>, archived: boolean) => {
    setBusyId(summary.id)
    try {
      // 列表摘要不含 revision，归档/恢复前先取当前信封。
      const current = await getWorld(summary.id)
      const res = await archiveWorld(summary.id, current.revision, archived)
      setSummaries((prev) => prev.map((s) => s.id === summary.id ? { ...s, status: res.world.status, updatedAt: res.world.updatedAt } : s))
      toast.success(archived ? t('worldWorkspace.list.archiveSuccess') : t('worldWorkspace.list.restoreSuccess'), {
        action: archived
          ? { label: t('worldWorkspace.list.restore'), onClick: () => void setArchived(res.world, false) }
          : { label: t('worldWorkspace.list.archive'), onClick: () => void setArchived(res.world, true) },
      })
    } catch (err) {
      const message = err instanceof APIError ? err.message : t('worldWorkspace.list.archiveError')
      toast.error(message)
    } finally {
      setBusyId(null)
    }
  }

  const filters: Filter[] = ['active', 'archived', 'all']

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onCreate} data-icon="inline-start">
          <Globe2 />
          {t('worldWorkspace.list.create')}
        </Button>
        <div className="ml-auto flex items-center gap-1 rounded-[var(--radius-md)] border border-[var(--nova-border)] p-0.5">
          {filters.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-[calc(var(--radius-md)-2px)] px-2.5 py-1 text-xs transition-colors',
                filter === f ? 'bg-[var(--nova-active)] text-[var(--nova-active-text)]' : 'text-[var(--nova-text-muted)] hover:bg-[var(--nova-surface-2)]',
              )}
            >
              {t(`worldWorkspace.list.filter.${f}`)}
            </button>
          ))}
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="rounded-[var(--radius-md)] border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="size-4" />
            {t('worldWorkspace.list.warnings.title', { count: warnings.length })}
          </div>
          <p className="mt-1 text-[var(--nova-text-muted)]">{t('worldWorkspace.list.warnings.hint')}</p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 font-mono text-[11px]">
            {warnings.map((w) => <li key={`${w.file}-${w.reason}`}>{w.file}：{w.reason}</li>)}
          </ul>
        </div>
      )}

      {state === 'loading' && (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-[var(--nova-text-muted)]">
          <Loader2 className="size-4 animate-spin" />
          {t('worldWorkspace.loading')}
        </div>
      )}

      {state === 'error' && (
        <EmptyState
          variant="page"
          icon={AlertTriangle}
          title={t('worldWorkspace.loadError')}
          action={{ label: t('worldWorkspace.retry'), onClick: () => void load() }}
        />
      )}

      {state === 'ready' && visible.length === 0 && (
        <EmptyState
          variant="page"
          icon={Globe2}
          title={t('worldWorkspace.list.empty.title')}
          description={t('worldWorkspace.list.empty.hint')}
          action={{ label: t('worldWorkspace.list.create'), onClick: onCreate }}
        />
      )}

      {state === 'ready' && visible.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((s) => (
            <WorldCard
              key={s.id}
              summary={s}
              busy={busyId === s.id}
              t={t}
              onOpen={() => onOpen(s.id)}
              onToggleArchive={() => void setArchived(s, s.status !== 'archived')}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function WorldCard({ summary, busy, t, onOpen, onToggleArchive }: {
  summary: WorldSummary
  busy: boolean
  t: (key: string, options?: Record<string, unknown>) => string
  onOpen: () => void
  onToggleArchive: () => void
}) {
  const accent = summary.coverColor || 'var(--nova-border)'
  return (
    <div
      className="group flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--nova-border)] bg-[var(--nova-surface)] p-3 transition-shadow hover:shadow-[0_2px_12px_-6px_rgba(0,0,0,0.35)]"
      style={{ borderLeft: `3px solid ${accent}` }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-medium">{summary.name}</h3>
            {summary.status === 'archived' && (
              <span className="shrink-0 rounded-full border border-[var(--nova-border)] px-1.5 py-0.5 text-[10px] text-[var(--nova-text-muted)]">
                {t('worldWorkspace.list.archivedBadge')}
              </span>
            )}
          </div>
          {summary.tagline ? <p className="mt-0.5 line-clamp-2 text-xs text-[var(--nova-text-muted)]">{summary.tagline}</p> : null}
          {summary.genre ? <p className="mt-0.5 text-[11px] text-[var(--nova-text-muted)]">{summary.genre}</p> : null}
        </div>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--nova-text-muted)]">
        <span className="inline-flex items-center gap-1"><Users className="size-3" />{summary.characterCount}</span>
        <span className="inline-flex items-center gap-1"><MapPin className="size-3" />{summary.locationCount}</span>
        <span className="inline-flex items-center gap-1"><Shield className="size-3" />{summary.factionCount}</span>
        <span className="inline-flex items-center gap-1"><HistoryIcon className="size-3" />{summary.timelineCount}</span>
      </div>

      <div className="mt-auto flex items-center gap-2 pt-1">
        <span className="text-[10px] text-[var(--nova-text-muted)]">{t('worldWorkspace.list.updatedAt', { time: formatStamp(summary.updatedAt) })}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="xs" onClick={onToggleArchive} disabled={busy}>
            {busy ? <Loader2 className="size-3 animate-spin" /> : summary.status === 'archived' ? <RotateCcw className="size-3" /> : <Archive className="size-3" />}
            {summary.status === 'archived' ? t('worldWorkspace.list.restore') : t('worldWorkspace.list.archive')}
          </Button>
          <Button variant="outline" size="xs" onClick={onOpen} data-icon="inline-end">
            {t('worldWorkspace.list.open')}
            <ArrowRight />
          </Button>
        </div>
      </div>
    </div>
  )
}
