import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, BookMarked, Loader2, RefreshCw, Save, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { EmptyState } from '@/components/common/EmptyState'
import { InlineErrorNotice } from '@/components/common/inline-error-notice'
import { Button } from '@/components/ui/button'
import { getWorkLibraryItemImpact, type WorkLibraryImpact, type WorkLibraryItem, type WorkLibraryItemInput, type WorkLibraryMetaPatch, type WorkLibraryVocabulary } from '@/lib/api-client'
import { filterItems, itemNameLookup, residentRuleItems, sortItems } from '../library-draft'
import { LibraryItemForm } from './LibraryItemForm'
import { LibraryConflictBanner } from './LibraryConflictBanner'
import { LibraryLoadSettings } from './LibraryLoadSettings'
import { LibrarySourcePicker } from './LibrarySourcePicker'
import { LibraryRelationsPanel } from './LibraryRelationsPanel'
import { LibraryTimelinePanel } from './LibraryTimelinePanel'
import { LibraryDeleteImpact } from './LibraryDeleteImpact'
import type { WorkLibraryEditorState } from '../use-work-library'

// 单个设定库的编辑面板：背景总览 / 条目。
//
// 草稿与冲突：库元信息草稿保存在本组件内，只在「重新加载」或「保存成功」时同步；
// 409 时显示横幅并提供重新加载，草稿与服务端数据都不丢（L1.2 验收要求）。

type EditorTab = 'overview' | 'items' | 'settings' | 'relations' | 'timeline'

interface NewItemDraft {
  name: string
  type: string
  importance: string
  missing: boolean
}

// 新建条目时的默认类型词表（服务端未下发词表时的兜底，取值对齐 L1 契约）。
const FALLBACK_ITEM_TYPES = ['character', 'world', 'location', 'faction', 'rule', 'item', 'ability', 'event', 'other']
const FALLBACK_IMPORTANCE = ['major', 'important', 'minor']
const EMPTY_EVENT_INPUT = { order: 0, era: '', category: 'background', participantItemIds: [], locationItemId: '' }

interface LibraryEditorPanelProps {
  editor: WorkLibraryEditorState
  vocabulary: WorkLibraryVocabulary | null
  onBack: () => void
  onDirtyChange?: (dirty: boolean) => void
}

const inputClass = 'h-8 w-full rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-2.5 text-sm outline-none focus:border-[var(--nova-ring)]'
const areaClass = 'min-h-24 w-full rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2.5 text-sm leading-6 outline-none focus:border-[var(--nova-ring)]'
const labelClass = 'text-[11px] font-medium text-muted-foreground'

export function LibraryEditorPanel({ editor, vocabulary, onBack, onDirtyChange }: LibraryEditorPanelProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<EditorTab>('overview')
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [savingItem, setSavingItem] = useState(false)
  const [savingMeta, setSavingMeta] = useState(false)
  const [confirmDeleteItem, setConfirmDeleteItem] = useState<WorkLibraryItem | null>(null)
  const [deleteImpact, setDeleteImpact] = useState<WorkLibraryImpact | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [newDraft, setNewDraft] = useState<NewItemDraft | null>(null)
  const [itemDirty, setItemDirty] = useState(false)
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [relationsDirty, setRelationsDirty] = useState(false)

  // 库元信息草稿：仅在「换了库」或「重新加载/保存成功」后同步。
  const [meta, setMeta] = useState<WorkLibraryMetaPatch>({})
  const library = editor.library
  const syncKey = JSON.stringify([library?.id, library?.name, library?.summary, library?.tone, library?.startingPoint])
  useEffect(() => {
    if (!library) return
    setMeta({
      name: library.name,
      summary: library.summary ?? '',
      tone: library.tone ?? '',
      startingPoint: library.startingPoint ?? '',
    })
    // 条目保存也会改变库 revision；只同步元信息自身，避免抹掉未保存的总览草稿。
  }, [syncKey])

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
  const hasDraft = Boolean(metaDirty || itemDirty || settingsDirty || relationsDirty)
  useEffect(() => onDirtyChange?.(hasDraft), [hasDraft, onDirtyChange])
  const guardLeave = () => !hasDraft || window.confirm(t('workLibrary.reloadConfirm'))

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

  const requestDelete = async (item: WorkLibraryItem) => {
    if (!library) return
    try {
      const impact = await getWorkLibraryItemImpact(library.id, item.id)
      setDeleteImpact(impact)
      setConfirmDeleteItem(item)
    } catch {
      setNotice(t('workLibrary.loadError'))
    }
  }

  const removeItem = async () => {
    if (!confirmDeleteItem) return false
    if (!deleteImpact) return false
    const cascade = deleteImpact.relations.length > 0 || deleteImpact.events.length > 0
    const outcome = await editor.deleteItem(confirmDeleteItem.id, cascade)
    if (outcome.status === 'deleted') {
      setNotice(t('workLibrary.item.deleted'))
      setSelectedItemId(null)
      setConfirmDeleteItem(null)
      setDeleteImpact(null)
      return true
    }
    if (outcome.status === 'in_use') {
      setDeleteImpact(outcome.impact ?? deleteImpact)
    }
    return false
  }

  // 新建条目必须先让用户给出真实名称：稳定 ID 在创建时由名称派生，
  // 不能用「新建条目」占位名落库后再改名（ID 一经分配永不改变）。
  const openNewItem = (type: string) => {
    setSourceOpen(false)
    setNewDraft({ name: '', type, importance: 'important', missing: false })
    setTab('items')
  }

  const submitNewItem = async () => {
    if (!newDraft) return
    const trimmed = newDraft.name.trim()
    if (!trimmed) {
      setNewDraft({ ...newDraft, missing: true })
      return
    }
    setSavingItem(true)
    const created = await editor.createItem({
      type: newDraft.type,
      name: trimmed,
      loadMode: 'auto',
      importance: newDraft.importance,
      ...(newDraft.type === 'event' ? { event: { ...EMPTY_EVENT_INPUT } } : {}),
    })
    setSavingItem(false)
    if (created) {
      setNewDraft(null)
      setItemDirty(false)
      setSelectedItemId(created.id)
      setTab('items')
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--nova-border)] px-3 py-2">
        <Button type="button" size="sm" variant="ghost" onClick={() => { if (guardLeave()) onBack() }}>
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
              if (!guardLeave()) return
              setMeta({ name: library?.name ?? '', summary: library?.summary ?? '', tone: library?.tone ?? '', startingPoint: library?.startingPoint ?? '' })
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
            if (!guardLeave()) return
            setMeta({ name: library?.name ?? '', summary: library?.summary ?? '', tone: library?.tone ?? '', startingPoint: library?.startingPoint ?? '' })
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
        {(['overview', 'items', 'relations', 'timeline', 'settings'] as EditorTab[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              if (value === tab || !guardLeave()) return
              setItemDirty(false)
              setSettingsDirty(false)
              setRelationsDirty(false)
              setNewDraft(null)
              setTab(value)
            }}
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
                        if (guardLeave()) {
                          setSelectedItemId(rule.id)
                          setTab('items')
                        }
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
      ) : tab === 'settings' && library ? (
        <LibraryLoadSettings key={library.id} items={library.items}
          onSave={async (itemId, patch) => Boolean(await editor.saveItem(itemId, patch))}
          onDirtyChange={setSettingsDirty} />
      ) : tab === 'relations' && library ? (
        <LibraryRelationsPanel items={library.items} relations={library.relations} vocabulary={vocabulary}
          onCreate={async (input) => Boolean(await editor.createRelation(input))}
          onUpdate={async (id, input) => Boolean(await editor.saveRelation(id, input))}
          onDelete={editor.deleteRelation} onDirtyChange={setRelationsDirty} />
      ) : tab === 'timeline' ? (
        <LibraryTimelinePanel timeline={editor.timeline} onCreate={() => openNewItem('event')}
          onOpen={(itemId) => { if (guardLeave()) { setSelectedItemId(itemId); setTab('items') } }} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <div className="flex max-h-64 w-full shrink-0 flex-col border-b border-[var(--nova-border)] sm:max-h-none sm:w-64 sm:border-b-0 sm:border-r">
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
              <Button type="button" size="sm" variant="ghost" className="w-full justify-start" onClick={() => openNewItem('character')}>
                {t('workLibrary.items.new')}
              </Button>
              <Button type="button" size="sm" variant="ghost" className="w-full justify-start" onClick={() => { setNewDraft(null); setSourceOpen((value) => !value) }}>
                {t('workLibrary.items.newFromSource')}
              </Button>
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {visibleItems.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                  onClick={() => {
                    if (item.id === selectedItemId || !guardLeave()) return
                    setItemDirty(false)
                    setNewDraft(null)
                    setSelectedItemId(item.id)
                  }}
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

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {sourceOpen ? <LibrarySourcePicker vocabulary={vocabulary} onClose={() => setSourceOpen(false)} onCreate={async (input) => {
            if (!guardLeave()) return false
            const created = await editor.createItem(input)
            if (!created) return false
            setSelectedItemId(created.id)
            return true
          }} /> : null}
          {newDraft ? (
            <div className="m-3 space-y-3 rounded-[var(--radius-lg)] border border-[var(--nova-border)] p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className={labelClass}>{t('workLibrary.item.name')}</span>
                  <input
                    className={inputClass}
                    value={newDraft.name}
                    maxLength={120}
                    autoFocus
                    aria-invalid={newDraft.missing}
                    placeholder={t('workLibrary.item.namePlaceholder')}
                    onChange={(event) => setNewDraft((current) => current
                      ? { ...current, name: event.target.value, missing: event.target.value.trim() ? false : current.missing }
                      : current)}
                    onKeyDown={(event) => { if (event.key === 'Enter') void submitNewItem() }}
                  />
                  {newDraft.missing ? (
                    <span role="alert" className="text-[11px] text-[var(--nova-danger)]">{t('workLibrary.item.requiredName')}</span>
                  ) : null}
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1">
                    <span className={labelClass}>{t('workLibrary.item.type')}</span>
                    <select
                      className={inputClass}
                      value={newDraft.type}
                      disabled={newDraft.type === 'event'}
                      onChange={(event) => setNewDraft((current) => current ? { ...current, type: event.target.value } : current)}
                    >
                      {(vocabulary?.itemTypes ?? FALLBACK_ITEM_TYPES).map((value) => (
                        <option key={value} value={value}>{t(`workLibrary.type.${value}`, { defaultValue: value })}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={labelClass}>{t('workLibrary.item.importance')}</span>
                    <select
                      className={inputClass}
                      value={newDraft.importance}
                      onChange={(event) => setNewDraft((current) => current ? { ...current, importance: event.target.value } : current)}
                    >
                      {(vocabulary?.importanceLevels ?? FALLBACK_IMPORTANCE).map((value) => (
                        <option key={value} value={value}>{t(`workLibrary.importance.${value}`, { defaultValue: value })}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
              <p className="text-[11px] leading-5 text-muted-foreground">{t('workLibrary.item.idCreateHint')}</p>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" disabled={savingItem || !newDraft.name.trim()} onClick={() => void submitNewItem()}>
                  {savingItem ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                  {savingItem ? t('workLibrary.saving') : t('workLibrary.create.submit')}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setNewDraft(null)}>
                  {t('workLibrary.cancel')}
                </Button>
              </div>
            </div>
          ) : null}
          {selectedItem && !newDraft ? (
            <LibraryItemForm
              item={selectedItem}
              allItems={items}
              vocabulary={vocabulary}
              saving={savingItem}
              readOnlyBody={selectedItem.origin === 'reference'}
              onSave={(input) => void saveItem(input)}
              onDelete={() => void requestDelete(selectedItem)}
              onDirtyChange={setItemDirty}
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center p-4">
              <EmptyState
                icon={BookMarked}
                variant="dashed"
                title={t('workLibrary.items.empty.title')}
                description={t('workLibrary.items.selectHint')}
                action={{ label: t('workLibrary.items.new'), onClick: () => openNewItem('character') }}
              />
            </div>
          )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteItem !== null && deleteImpact !== null}
        onOpenChange={(open) => {
          if (!open) { setConfirmDeleteItem(null); setDeleteImpact(null) }
        }}
        title={t('workLibrary.item.delete')}
        description={t('workLibrary.item.deleteConfirm')}
        detailContent={deleteImpact ? <LibraryDeleteImpact impact={deleteImpact} /> : null}
        tone="danger"
        confirmLabel={deleteImpact && (deleteImpact.relations.length || deleteImpact.events.length)
          ? t('workLibrary.itemInUse.cascade') : t('workLibrary.confirm')}
        onConfirm={removeItem}
      />
    </div>
  )
}
