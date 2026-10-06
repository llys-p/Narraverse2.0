import { useTranslation } from 'react-i18next'
import { BookText, Loader2, RefreshCw, RotateCcw, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import type {
  IdeationCandidateItem,
  IdeationCandidatePackage,
  IdeationDraft,
  IdeationOrigin,
  IdeationScope,
} from '@/lib/api-client/book-ideation'

interface CandidateEditorProps {
  draft: IdeationDraft
  busy: boolean
  onPatch: (pkg: IdeationCandidatePackage) => void
  onPersist: () => void
  onRegenerate: (scope: IdeationScope, refs?: string[]) => void
  onTitleChange: (title: string) => void
  onCommit: () => void
  onBack: () => void
}

/**
 * 预览并创建：候选包的每一项都可编辑、可排除；只有点击“创建书籍并保存资料”
 * 才会写入本书，未确认的草稿始终停留在数据目录里。
 */
export function CandidateEditor({
  draft,
  busy,
  onPatch,
  onPersist,
  onRegenerate,
  onTitleChange,
  onCommit,
  onBack,
}: CandidateEditorProps) {
  const { t } = useTranslation()
  const pkg = draft.candidates
  if (!pkg) {
    return (
      <div className="flex h-full flex-col items-start justify-center gap-3 rounded-[var(--nova-radius)] border border-dashed border-[var(--nova-border)] p-6">
        <p className="text-sm text-[var(--nova-text-muted)]">{t('bookIdeation.noCandidates')}</p>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onBack}>
            <RotateCcw data-icon="inline-start" />
            {t('bookIdeation.backDirection')}
          </Button>
          <Button type="button" size="sm" onClick={() => onRegenerate('all')} disabled={busy} data-testid="ideation-generate">
            {busy ? <Loader2 className="animate-spin" /> : <Sparkles data-icon="inline-start" />}
            {t('bookIdeation.generateDraft')}
          </Button>
        </div>
      </div>
    )
  }

  const patchItem = (ref: string, changes: Partial<IdeationCandidateItem>) => {
    onPatch({
      ...pkg,
      items: pkg.items.map((item) => (item.ref === ref ? { ...item, ...changes } : item)),
    })
  }
  const toggleKeep = (entryId: string) => {
    const kept = new Set(pkg.keep_source_entries ?? [])
    if (kept.has(entryId)) kept.delete(entryId)
    else kept.add(entryId)
    onPatch({ ...pkg, keep_source_entries: Array.from(kept) })
  }
  const excludedCount = pkg.items.filter((item) => item.excluded).length
  const keptCount = (pkg.keep_source_entries ?? []).length
  const commitStages = draft.commit?.stages ?? []

  return (
    <ScrollArea className="min-h-0 flex-1 pr-2" data-testid="ideation-preview">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-[var(--nova-text-muted)]" htmlFor="ideation-book-title">
            {t('bookIdeation.bookTitle')}
          </label>
          <Input
            id="ideation-book-title"
            disabled={busy}
            value={draft.title ?? pkg.title ?? ''}
            onChange={(event) => onTitleChange(event.target.value)}
            onBlur={() => onPersist()}
            placeholder={t('bookIdeation.titlePlaceholder')}
            className="nova-field rounded-[var(--nova-radius)] border px-2.5 py-1.5 text-sm"
            data-testid="ideation-title"
          />
          {pkg.book_name_suggestions?.length ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-[var(--nova-text-faint)]">{t('bookIdeation.suggestions')}</span>
              {pkg.book_name_suggestions.map((name) => (
                <Button key={name} type="button" size="xs" variant="ghost" onClick={() => onTitleChange(name)}>
                  {name}
                </Button>
              ))}
            </div>
          ) : null}
          <Textarea
            value={pkg.synopsis ?? ''}
            disabled={busy}
            onChange={(event) => onPatch({ ...pkg, synopsis: event.target.value })}
            placeholder={t('bookIdeation.synopsisPlaceholder')}
            className="min-h-[64px]"
            data-testid="ideation-synopsis"
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-1.5 text-xs font-medium text-[var(--nova-text-muted)]">
            <BookText className="size-3.5" />
            {t('bookIdeation.overview')}
          </label>
          <Button type="button" size="xs" variant="ghost" onClick={() => onRegenerate('overview')} disabled={busy}>
            <RefreshCw data-icon="inline-start" />
            {t('bookIdeation.regenOverview')}
          </Button>
        </div>
        <Textarea
          value={pkg.overview}
          disabled={busy}
          onChange={(event) => onPatch({ ...pkg, overview: event.target.value })}
          className="min-h-[180px] font-mono text-[11px]"
          data-testid="ideation-overview"
        />

        <Separator />

        <div className="flex items-center justify-between gap-2">
          <label className="text-xs font-medium text-[var(--nova-text-muted)]">
            {t('bookIdeation.items', { count: pkg.items.length, kept: pkg.items.length - excludedCount })}
          </label>
          <Button type="button" size="xs" variant="ghost" onClick={() => onRegenerate('all')} disabled={busy}>
            <Sparkles data-icon="inline-start" />
            {t('bookIdeation.regenAll')}
          </Button>
        </div>

        {pkg.items.map((item) => (
          <CandidateRow
            key={item.ref}
            item={item}
            busy={busy}
            onPatch={(changes) => patchItem(item.ref, changes)}
            onRegenerate={() => onRegenerate('items', [item.ref])}
          />
        ))}

        {pkg.relations?.length ? (
          <>
            <Separator />
            <label className="text-xs font-medium text-[var(--nova-text-muted)]">
              {t('bookIdeation.relations', { count: pkg.relations.filter((relation) => !relation.excluded).length })}
            </label>
            <ul className="flex flex-col gap-1.5">
              {pkg.relations.map((relation) => {
                const source = pkg.items.find((item) => item.ref === relation.source_ref)
                const target = pkg.items.find((item) => item.ref === relation.target_ref)
                return (
                  <li key={relation.ref} className="flex items-center gap-2 rounded-[var(--nova-radius)] border border-[var(--nova-border)] px-2.5 py-1.5">
                    <input
                      type="checkbox"
                      checked={!relation.excluded}
                      disabled={busy}
                      onChange={() =>
                        onPatch({
                          ...pkg,
                          relations: pkg.relations!.map((entry) =>
                            entry.ref === relation.ref ? { ...entry, excluded: !entry.excluded } : entry,
                          ),
                        })
                      }
                      aria-label={`${relation.label} ${t('bookIdeation.includeRelation')}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--nova-text)]">
                      {source?.name ?? relation.source_ref}
                      <span aria-hidden> → </span>
                      {relation.label}
                      <span aria-hidden> → </span>
                      {target?.name ?? relation.target_ref}
                    </span>
                    <OriginBadge origin={relation.origin} />
                  </li>
                )
              })}
            </ul>
            <Button type="button" size="xs" variant="ghost" className="w-fit" onClick={() => onRegenerate('relation')} disabled={busy}>
              <RefreshCw data-icon="inline-start" />
              {t('bookIdeation.regenRelations')}
            </Button>
          </>
        ) : null}

        <Separator />
        <label className="text-xs font-medium text-[var(--nova-text-muted)]">
          {t('bookIdeation.keepOriginals', { count: keptCount })}
        </label>
        <p className="text-[11px] text-[var(--nova-text-faint)]">{t('bookIdeation.keepOriginalsHint')}</p>
        {draft.sources.map((source) => (
          <div key={source.id} className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-[var(--nova-text-muted)]">{source.name}</span>
            {source.entries.map((entry) => (
              <label key={entry.id} className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={(pkg.keep_source_entries ?? []).includes(entry.id)}
                  disabled={busy}
                  onChange={() => toggleKeep(entry.id)}
                  className="mt-0.5"
                />
                <span className="min-w-0 text-[var(--nova-text-muted)]">
                  {entry.name}
                  <span className="ml-1.5 text-[11px] text-[var(--nova-text-faint)]">{entry.role}</span>
                </span>
              </label>
            ))}
          </div>
        ))}

        {commitStages.length > 0 && commitStages.some((stage) => stage.status !== 'done') ? (
          <div className="rounded-[var(--nova-radius)] border border-[var(--nova-border)] p-2.5 text-xs" data-testid="ideation-commit-stages">
            <p className="mb-1.5 font-medium text-[var(--nova-text)]">{t('bookIdeation.commitProgress')}</p>
            <ul className="flex flex-col gap-1 text-[var(--nova-text-muted)]">
              {commitStages.map((stage) => (
                <li key={stage.name}>
                  {t(`bookIdeation.commitStage.${stage.name}`)}
                  {stage.status === 'done' ? ` · ${t('bookIdeation.stageDone')}` : ` · ${stage.detail || t('bookIdeation.stagePending')}`}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="sticky bottom-0 flex flex-wrap items-center gap-2 bg-[var(--nova-bg)] py-2">
          <Button type="button" size="sm" variant="ghost" onClick={onBack} disabled={busy}>
            <RotateCcw data-icon="inline-start" />
            {t('bookIdeation.backDirection')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onPersist} disabled={busy}>
            {t('bookIdeation.saveEdits')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onCommit}
            disabled={busy || !(draft.title || pkg.title)}
            data-testid="ideation-commit"
          >
            {busy ? <Loader2 className="animate-spin" /> : <Sparkles data-icon="inline-start" />}
            {draft.commit ? t('bookIdeation.retryCreate') : t('bookIdeation.createBook')}
          </Button>
        </div>
      </div>
    </ScrollArea>
  )
}

function CandidateRow({
  item,
  busy,
  onPatch,
  onRegenerate,
}: {
  item: IdeationCandidateItem
  busy: boolean
  onPatch: (changes: Partial<IdeationCandidateItem>) => void
  onRegenerate: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className={`flex flex-col gap-2 rounded-[var(--nova-radius)] border border-[var(--nova-border)] p-2.5 ${item.excluded ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="checkbox"
          checked={!item.excluded}
          disabled={busy}
          onChange={() => onPatch({ excluded: !item.excluded })}
          aria-label={`${item.name} ${t('bookIdeation.includeItem')}`}
          data-testid={`ideation-item-keep-${item.ref}`}
        />
        <Input
          value={item.name}
          disabled={busy}
          onChange={(event) => onPatch({ name: event.target.value })}
          className="nova-field min-w-[120px] flex-1 rounded-[var(--nova-radius)] border px-2 py-1 text-xs"
          data-testid={`ideation-item-name-${item.ref}`}
        />
        <select
          value={item.type}
          disabled={busy}
          onChange={(event) => onPatch({ type: event.target.value })}
          className="nova-field rounded-[var(--nova-radius)] border px-2 py-1 text-xs"
          aria-label={`${item.name} ${t('bookIdeation.type')}`}
        >
          {['character', 'location', 'faction', 'rule', 'item', 'world', 'other'].map((option) => (
            <option key={option} value={option}>
              {t(`bookIdeation.loreType.${option}`)}
            </option>
          ))}
        </select>
        <select
          value={item.load_mode}
          disabled={busy}
          onChange={(event) => onPatch({ load_mode: event.target.value as IdeationCandidateItem['load_mode'] })}
          className="nova-field rounded-[var(--nova-radius)] border px-2 py-1 text-xs"
          aria-label={`${item.name} ${t('bookIdeation.loadMode')}`}
        >
          {(['resident', 'manual', 'auto'] as const).map((option) => (
            <option key={option} value={option}>
              {t(`bookIdeation.loadMode.${option}`)}
            </option>
          ))}
        </select>
        <OriginBadge origin={item.origin} />
        {item.edited_by_user ? <Badge variant="outline">{t('bookIdeation.editedByUser')}</Badge> : null}
      </div>
      <Textarea
        value={item.content}
        disabled={busy}
        onChange={(event) => onPatch({ content: event.target.value })}
        className="min-h-[80px] text-xs"
        data-testid={`ideation-item-content-${item.ref}`}
      />
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--nova-text-faint)]">
        {item.keywords?.length ? <span>{item.keywords.join(' / ')}</span> : null}
        {item.source_refs?.length ? <span>{t('bookIdeation.citedBy', { refs: item.source_refs.join(', ') })}</span> : null}
        {item.open_notes ? <span className="text-[var(--nova-warning-fg)]">{item.open_notes}</span> : null}
        <Button type="button" size="xs" variant="ghost" onClick={onRegenerate} disabled={busy} className="ml-auto">
          <RefreshCw data-icon="inline-start" />
          {t('bookIdeation.regenItem')}
        </Button>
      </div>
    </div>
  )
}

function OriginBadge({ origin }: { origin: IdeationOrigin }) {
  const { t } = useTranslation()
  return <Badge variant="outline">{t(`bookIdeation.origin.${origin}`)}</Badge>
}
