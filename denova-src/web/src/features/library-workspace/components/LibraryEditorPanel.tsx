import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, BookMarked, Loader2, RefreshCw, Save, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { EmptyState } from '@/components/common/EmptyState'
import { InlineErrorNotice } from '@/components/common/inline-error-notice'
import { Button } from '@/components/ui/button'
import type { WorkLibraryItem, WorkLibraryItemInput, WorkLibraryMetaPatch, WorkLibraryVocabulary } from '@/lib/api-client'
import { filterItems, itemNameLookup, residentRuleItems, sortItems } from '../library-draft'
import { LibraryItemForm } from './LibraryItemForm'
import { LibraryConflictBanner } from './LibraryConflictBanner'
import type { WorkLibraryEditorState } from '../use-work-library'

// 单个设定库的编辑面板：背景总览 / 条目。
//
// 草稿与冲突：库元信息草稿保存在本组件内，只在「重新加载」或「保存成功」时同步；
// 409 时显示横幅并提供重新加载，草稿与服务端数据都不丢（L1.2 验收要求）。

type EditorTab = 'overview' | 'items'

interface LibraryEditorPanelProps {
  editor: WorkLibraryEditorState
  vocabulary: WorkLibraryVocabulary | null
  onBack: () => void
}

const inputClass = 'h-8 w-full rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-2.5 text-sm outline-none focus:border-[var(--nova-ring)]'
const areaClass = 'min-h-24 w-full rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2.5 text-sm leading-6 outline-none focus:border-[var(--nova-ring)]'
const labelClass = 'text-[11px] font-medium text-muted-foreground'

export function LibraryEditorPanel({ editor, vocabulary, onBack }: LibraryEditorPanelProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<EditorTab>('overview')
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [savingItem, setSavingItem] = useState(false)
  const [savingMeta, setSavingMeta] = useState(false)
  const [confirmDeleteItem, setConfirmDeleteItem] = useState<WorkLibraryItem | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // 库元信息草稿：仅在「换了库」或「重新加载/保存成功」后同步。
  const [meta, setMeta] = useState<WorkLibraryMetaPatch>({})
  const library = editor.library
  const syncKey = `${library?.id ?? ''}:${editor.revision}`
  useEffect(() => {
    if (!library) return
    setMeta({
      name: library.name,
      summary: library.summary ?? '',
      tone: library.tone ?? '',
      startingPoint: library.startingPoint ?? '',
    })
    // syncKey 变化代表服务端版本变化（保存成功或重新加载），此时才覆盖草稿。
  }, [syncKey, library])

  useEffect(() => {
    if (!selectedItemId && library && library.items.length > 0) {
      setSelectedItemId(sortItems(library.items)[0].id)
    }
  }, [library, selectedItemId])

  const items = useMemo(() => (library ? sortItems(library.items) : []), [library])
  const visibleItems = useMemo(
    () => filterItems(items, { query, type: typeFilter }),
    [items, query, typeFilter],
  )
  const lookup = useMemo(() => itemNameLookup(items), [items])
  const selectedItem = selectedItemId ? lookup.get(selectedItemId) ?? null : null
  const coreRules = useMemo(() => residentRuleItems(library), [library])

  const metaDirty = Boolean(library) && (
    (meta.name ?? '') !== library!.name
    || (meta.summary ?? '') !== (library!.summary ?? '')
    || (meta.tone ?? '') !== (library!.tone ?? '')
    || (meta.startingPoint ?? '') !== (library!.startingPoint ?? '')
  )

  const saveMeta = async () => {
    setSavingMeta(true)
    const ok = await editor.saveMeta({
      name: (meta.name ?? '').trim(),
      summary: meta.summary ?? '',
      tone: meta.tone ?? '',
      startingPoint: meta.startingPoint ?? '',
    })
    setSavingMeta(false)
    if (ok) setNotice(t('workLibrary.saved'))
  }

  const saveItem = async (input: WorkLibraryItemInput) => {
    if (!selectedItem) return
    setSavingItem(true)
    const saved = await editor.saveItem(selectedItem.id, input)
    setSavingItem(false)
    if (saved) setNotice(t('workLibrary.saved'))
  }

  const removeItem = async (cascade: boolean) => {
    if (!confirmDeleteItem) return false
    const outcome = await editor.deleteItem(confirmDeleteItem.id, cascade)
    if (outcome.status === 'deleted') {
      setNotice(t('workLibrary.item.deleted'))
      setSelectedItemId(null)
      setConfirmDeleteItem(null)
      return true
    }
    setConfirmDeleteItem(null)
    if (outcome.status === 'in_use') {
      setNotice(t('workLibrary.itemInUse.title'))
    }
    return false
  }

  const createItem = async () => {
    const created = await editor.createItem({
      type: 'character',
      name: t('workLibrary.items.new'),
      loadMode: 'auto',
      importance: 'important',
    })
    if (created) {
      setSelectedItemId(created.id)
      setTab('items')
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--nova-border)] px-3 py-2">
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft className="size-3.5" />
          {t('workLibrary.back')}
        </Button>
        <BookMarked className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 truncate text-xs font-medium text-foreground">{library?.name ?? ''}</span>
        {metaDirty ? <span className="text-[11px] text-muted-foreground">{t('workLibrary.dirtyHint')}</span> : null}
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              if (metaDirty && !window.confirm(t('workLibrary.reloadConfirm'))) return
              void editor.reload()
            }}
          >
            <RefreshCw className="size-3.5" />
            {t('workLibrary.reload')}
          </Button>
          {tab === 'overview' ? (
            <Button type="button" size="sm" disabled={savingMeta || !metaDirty} onClick={() => void saveMeta()}>
              {savingMeta ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              {savingMeta ? t('workLibrary.saving') : t('workLibrary.save')}
            </Button>
          ) : null}
        </div>
      </div>

      {editor.conflict ? (
        <LibraryConflictBanner
          conflict={editor.conflict}
          onReload={() => {
            if (!window.confirm(t('workLibrary.reloadConfirm'))) return
            void editor.reload()
          }}
          onDismiss={editor.dismissConflict}
        />
      ) : null}

      {notice ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--nova-border)] px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>{notice}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setNotice(null)}>{t('workLibrary.close')}</Button>
        </div>
      ) : null}

      {editor.lastError ? (
        <div className="shrink-0 px-3 py-2">
          <InlineErrorNotice message={editor.lastError.message || t('workLibrary.saveError')} />
        </div>
      ) : null}

      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--nova-border)] px-3 py-1">
        {(['overview', 'items'] as EditorTab[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`rounded-[var(--radius-sm)] px-2 py-1 text-[11px] transition-colors ${tab === value ? 'bg-[var(--nova-surface-2)] text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t(`workLibrary.tab.${value}`)}
          </button>
        ))}
      </div>

      {editor.status === 'loading' ? (
        <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t('workLibrary.loading')}
        </div>
      ) : editor.status === 'error' ? (
        <div className="p-3">
          <InlineErrorNotice message={editor.error ?? t('workLibrary.loadError')} />
        </div>
      ) : tab === 'overview' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <p className="mb-2 text-[11px] leading-5 text-muted-foreground">{t('workLibrary.overview.hint')}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className={labelClass}>{t('workLibrary.create.name')}</span>
              <input
                className={inputClass}
                value={meta.name ?? ''}
                maxLength={120}
                onChange={(event) => setMeta((current) => ({ ...current, name: event.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>{t('workLibrary.overview.tone')}</span>
              <input
                className={inputClass}
                value={meta.tone ?? ''}
                maxLength={200}
                onChange={(event) => setMeta((current) => ({ ...current, tone: event.target.value }))}
              />
            </label>
          </div>
          <label className="mt-2 flex flex-col gap-1">
            <span className={labelClass}>{t('workLibrary.overview.summary')}</span>
            <textarea
              className={areaClass}
              value={meta.summary ?? ''}
              onChange={(event) => setMeta((current) => ({ ...current, summary: event.target.value }))}
            />
          </label>
          <label className="mt-2 flex flex-col gap-1">
            <span className={labelClass}>{t('workLibrary.overview.startingPoint')}</span>
            <textarea
              className={areaClass}
              value={meta.startingPoint ?? ''}
              onChange={(event) => setMeta((current) => ({ ...current, startingPoint: event.target.value }))}
            />
          </label>

          <section className="mt-4">
            <h3 className="text-[11px] font-medium text-foreground">{t('workLibrary.overview.coreRules')}</h3>
            {coreRules.length === 0 ? (
              <p className="mt-1 text-[11px] text-muted-foreground">{t('workLibrary.overview.coreRulesEmpty')}</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {coreRules.map((rule) => (
                  <li key={rule.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--nova-border)] px-2 py-1.5 text-left text-[11px] hover:border-[var(--nova-ring)]"
                      onClick={() => {
                        setSelectedItemId(rule.id)
                        setTab('items')
                      }}
                    >
                      <span className="min-w-0 truncate">{rule.name}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground">{t('workLibrary.overview.openRule')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-64 shrink-0 flex-col border-r border-[var(--nova-border)]">
            <div className="flex shrink-0 items-center gap-1 border-b border-[var(--nova-border)] p-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  className={`${inputClass} pl-7`}
                  value={query}
                  placeholder={t('workLibrary.searchPlaceholder')}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <select
                className="h-8 shrink-0 rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-1.5 text-[11px] outline-none"
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value)}
              >
                <option value="">{t('workLibrary.filter.allTypes')}</option>
                {(vocabulary?.itemTypes ?? []).map((value) => (
                  <option key={value} value={value}>{t(`workLibrary.type.${value}`, { defaultValue: value })}</option>
                ))}
              </select>
            </div>
            <div className="shrink-0 px-2 py-1">
              <Button type="button" size="sm" variant="ghost" className="w-full justify-start" onClick={() => void createItem()}>
                {t('workLibrary.items.new')}
              </Button>
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {visibleItems.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedItemId(item.id)}
                    className={`flex w-full items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[11px] transition-colors ${selectedItemId === item.id ? 'bg-[var(--nova-surface-2)] text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    {item.origin === 'reference' ? (
                      <span className="shrink-0 rounded border border-[var(--nova-border)] px-1 text-[9px]">{t('workLibrary.items.referenceBadge')}</span>
                    ) : null}
                    {!item.enabled ? (
                      <span className="shrink-0 rounded border border-[var(--nova-border)] px-1 text-[9px]">{t('workLibrary.items.disabledBadge')}</span>
                    ) : null}
                  </button>
                </li>
              ))}
              {visibleItems.length === 0 ? (
                <li className="p-2 text-[11px] text-muted-foreground">{t('workLibrary.items.filterEmpty')}</li>
              ) : null}
            </ul>
          </div>

          {selectedItem ? (
            <LibraryItemForm
              item={selectedItem}
              vocabulary={vocabulary}
              saving={savingItem}
              readOnlyBody={selectedItem.origin === 'reference'}
              onSave={(input) => void saveItem(input)}
              onDelete={() => setConfirmDeleteItem(selectedItem)}
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center p-4">
              <EmptyState
                icon={BookMarked}
                variant="dashed"
                title={t('workLibrary.items.empty.title')}
                description={t('workLibrary.items.selectHint')}
                action={{ label: t('workLibrary.items.new'), onClick: () => void createItem() }}
              />
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteItem !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteItem(null)
        }}
        title={t('workLibrary.item.delete')}
        description={t('workLibrary.item.deleteConfirm')}
        tone="danger"
        confirmLabel={t('workLibrary.confirm')}
        onConfirm={() => removeItem(false)}
      />
    </div>
  )
}
