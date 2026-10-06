import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookText, Database, LayoutDashboard, MapPin, Network, ScrollText, Shapes, Shield, Users, Wand2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { SettingPanel } from '@/features/interactive/components/SettingPanel'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { InlineErrorNotice } from '@/components/common/inline-error-notice'
import { getImagePresets } from '@/features/interactive/api'
import type { ImagePreset } from '@/features/interactive/types'
import { CharacterTierBatchDialog } from '@/features/interactive/components/setting-panel/CharacterTierBatchDialog'
import type { LoreItem } from '@/lib/api'
import { BOOK_LIBRARY_CATEGORIES, type BookLibraryView } from './book-library-view-model'
import { useBookLibraryLore } from './use-book-library-lore'
import { useBookOverview } from './use-book-library-overview'
import { NewEntryDialog } from './NewEntryDialog'
import { NoBookNotice } from './views/NoBookNotice'
import { WorkbenchHomeView } from './views/WorkbenchHomeView'
import { EntriesView } from './views/EntriesView'
import { PeopleView } from './views/PeopleView'
import { EntryDetailView } from './views/EntryDetailView'
import { RelationsView } from './views/RelationsView'
import { OverviewView } from './views/OverviewView'
import './book-library.css'

const NAV_ICON: Record<BookLibraryView, typeof Database> = {
  home: LayoutDashboard,
  all: Database,
  character: Users,
  location: MapPin,
  faction: Shield,
  'world-rule': ScrollText,
  'item-other': Shapes,
  graph: Network,
  overview: BookText,
  tools: Wand2,
  detail: Database,
}

const NAV_LABEL_KEY: Record<BookLibraryView, string> = {
  home: 'bookLibrary.nav.home',
  all: 'bookLibrary.nav.all',
  character: 'lore.type.character',
  location: 'lore.type.location',
  faction: 'lore.type.faction',
  'world-rule': 'bookLibrary.category.worldRule',
  'item-other': 'bookLibrary.category.itemOther',
  graph: 'bookLibrary.nav.graph',
  overview: 'bookLibrary.nav.overview',
  tools: 'bookLibrary.nav.tools',
  detail: 'bookLibrary.nav.detail',
}

interface BookLibraryWorkspaceProps {
  workspace: string
  bookName: string
  onClose?: () => void
  onDirtyChange?: (dirty: boolean) => void
  onFlushHandlerChange?: (handler: (() => Promise<boolean>) | null) => void
}

/**
 * 本书资料工作台（T2 主壳）。
 *
 * 视图切换只改本地视图状态：不开局、不启动模式、不切书。条目数据、编辑保存、
 * 图集、总览与关系图都来自当前书的既有接口与既有组件。
 */
export function BookLibraryWorkspace({ workspace, bookName, onClose, onDirtyChange, onFlushHandlerChange }: BookLibraryWorkspaceProps) {
  const { t } = useTranslation()
  const lore = useBookLibraryLore(workspace)
  const overview = useBookOverview(workspace)

  const [view, setView] = useState<BookLibraryView>('home')
  const [returnView, setReturnView] = useState<BookLibraryView>('all')
  const [editing, setEditing] = useState(false)
  const [query, setQuery] = useState('')
  const [peekId, setPeekId] = useState<string | null>(null)
  const [newEntryOpen, setNewEntryOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<LoreItem | null>(null)
  // 名称单独留存：确认弹窗关闭时条目状态已清空，避免退场过程中显示「将删除「」」。
  const [deleteTargetName, setDeleteTargetName] = useState('')
  const [imagePresets, setImagePresets] = useState<ImagePreset[]>([])
  const [imagePresetId, setImagePresetId] = useState('')
  const [imageInstruction, setImageInstruction] = useState('')
  const searchRef = useRef<HTMLInputElement | null>(null)
  const toolsFlushRef = useRef<(() => Promise<boolean>) | null>(null)
  const navigationSeqRef = useRef(0)
  const [toolsDirty, setToolsDirty] = useState(false)
  const registerToolsFlush = useCallback((handler: (() => Promise<boolean>) | null) => {
    toolsFlushRef.current = handler
  }, [])

  useEffect(() => {
    let cancelled = false
    getImagePresets()
      .then((presets) => { if (!cancelled) setImagePresets(presets) })
      .catch((error) => console.warn('[book-library] failed to load image presets', error))
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    onDirtyChange?.(lore.dirty || overview.dirty || toolsDirty)
  }, [lore.dirty, onDirtyChange, overview.dirty, toolsDirty])

  // 总览的文件自动保存只在总览可见时持有写权，避免与作品设定库等其它面板双写同一文件。
  const setActiveOverview = overview.setActive
  useEffect(() => {
    setActiveOverview(view === 'overview')
  }, [setActiveOverview, view])

  // 换书时回到工作台首页，上一本书的视图、搜索与抽屉都不残留。
  useEffect(() => {
    navigationSeqRef.current += 1
    setView('home')
    setEditing(false)
    setPeekId(null)
    setQuery('')
    setDeleteTarget(null)
    setNewEntryOpen(false)
    setToolsDirty(false)
  }, [workspace])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /**
   * 离开总览视图前必须先落盘；落盘失败时留在总览并保留草稿。
   * 其它视图之间保持同步切换，不给普通导航加一个微任务窗口。
   */
  const goto = useCallback((next: BookLibraryView) => {
    if (next === view) return
    const request = ++navigationSeqRef.current
    if (view === 'tools' || next === 'tools') {
      void (async () => {
        if (view === 'tools') {
          if (toolsFlushRef.current && !(await toolsFlushRef.current())) return
          await lore.reload()
        } else {
          if (!(await lore.saveNow()) || !(await overview.flush())) return
        }
        if (navigationSeqRef.current !== request) return
        setToolsDirty(false)
        setEditing(false)
        setPeekId(null)
        setView(next)
      })()
      return
    }
    if (view !== 'overview') {
      setEditing(false)
      setPeekId(null)
      setView(next)
      return
    }
    void overview.flush().then((ok) => {
      if (!ok || navigationSeqRef.current !== request) return
      setEditing(false)
      setPeekId(null)
      setView(next)
    })
  }, [lore, overview, view])

  /** 图谱内打开档案用抽屉，画布保持挂载，返回后筛选/聚焦/缩放不丢。 */
  const openEntry = useCallback(async (id: string, from: BookLibraryView) => {
    if (view === 'overview') {
      const flushed = await overview.flush()
      if (!flushed) return
    }
    await lore.selectItem(id)
    if (from === 'graph') {
      setPeekId(id)
      return
    }
    setReturnView(from === 'detail' ? returnView : from)
    setEditing(false)
    setPeekId(null)
    setView('detail')
  }, [lore, overview, returnView, view])

  const closeDetail = useCallback(() => {
    setPeekId(null)
    if (editing) {
      void lore.saveNow().then(() => setEditing(false))
      return
    }
    setEditing(false)
    setView(returnView)
  }, [editing, lore, returnView])

  const categoryCounts = useMemo(() => {
    const base: Record<string, number> = {}
    for (const category of BOOK_LIBRARY_CATEGORIES) {
      base[category.id] = lore.items.filter((item) => category.types.includes(item.type)).length
    }
    return base
  }, [lore.items])

  const activeCategory = useMemo(
    () => BOOK_LIBRARY_CATEGORIES.find((category) => category.id === view) || null,
    [view],
  )

  const validImagePresets = useMemo(() => imagePresets.filter((preset) => !preset.invalid), [imagePresets])
  const peekItem = useMemo(
    () => (peekId ? lore.items.find((item) => item.id === peekId) || null : null),
    [lore.items, peekId],
  )

  const flushDrafts = useCallback(async () => {
    if (toolsFlushRef.current && !(await toolsFlushRef.current())) return false
    if (!(await lore.saveNow())) return false
    return overview.flush()
  }, [lore.saveNow, overview.flush])

  // 切书由路由控制器发起：把当前书的保存边界注册给它，避免外层只保存普通编辑器。
  useEffect(() => {
    onFlushHandlerChange?.(flushDrafts)
    return () => onFlushHandlerChange?.(null)
  }, [flushDrafts, onFlushHandlerChange])

  const handleClose = useCallback(async () => {
    if (!onClose || !(await flushDrafts())) return
    onDirtyChange?.(false)
    onClose()
  }, [flushDrafts, onClose, onDirtyChange])

  if (!workspace) return <NoBookNotice />

  const title = view === 'detail' ? lore.draft?.name || t('bookLibrary.nav.detail') : t(NAV_LABEL_KEY[view])

  const entryViewProps = {
    workspace,
    items: lore.items,
    imagePresets: validImagePresets,
    imagePresetId: imagePresetId || validImagePresets[0]?.id || 'game-cg',
    imageInstruction,
    onImagePresetChange: setImagePresetId,
    setImageInstruction,
    query,
    onConfirmDelete: (item: LoreItem) => {
      setDeleteTargetName(item.name || t('bookLibrary.entry.unnamed'))
      setDeleteTarget(item)
    },
  }

  return (
    <section className="book-library" aria-label={t('bookLibrary.title')}>
      <nav className="book-library-nav" aria-label={t('bookLibrary.nav.label')}>
        <div className="book-library-book" title={bookName}>
          <span className="book-library-book-mark"><Wand2 className="h-3.5 w-3.5" /></span>
          <span className="book-library-book-copy">
            <b>{bookName}</b>
            <small>{t('bookLibrary.book.entries', { count: lore.items.length })}</small>
          </span>
        </div>

        <div className="book-library-nav-group">{t('bookLibrary.group.workspace')}</div>
        <NavButton id="home" active={view === 'home'} label={t(NAV_LABEL_KEY.home)} onClick={() => { void goto('home') }} hideCount />
        <NavButton id="overview" active={view === 'overview'} label={t(NAV_LABEL_KEY.overview)} onClick={() => { void goto('overview') }} hideCount />
        <NavButton
          id="all"
          active={view === 'all' || (view === 'detail' && returnView === 'all')}
          label={t(NAV_LABEL_KEY.all)}
          count={lore.items.length}
          onClick={() => { void goto('all') }}
        />

        <div className="book-library-nav-group">{t('bookLibrary.group.categories')}</div>
        {BOOK_LIBRARY_CATEGORIES.map((category) => (
          <NavButton
            key={category.id}
            id={category.id}
            active={view === category.id || (view === 'detail' && returnView === category.id)}
            label={t(NAV_LABEL_KEY[category.id])}
            count={categoryCounts[category.id]}
            onClick={() => { void goto(category.id) }}
          />
        ))}

        <div className="book-library-nav-group">{t('bookLibrary.group.explore')}</div>
        <NavButton id="graph" active={view === 'graph'} label={t(NAV_LABEL_KEY.graph)} onClick={() => { void goto('graph') }} hideCount />
        <NavButton id="tools" active={view === 'tools'} label={t(NAV_LABEL_KEY.tools)} onClick={() => { void goto('tools') }} hideCount />
      </nav>

      <div className="book-library-main">
        <header className="book-library-topbar">
          <div className="book-library-crumb">
            <span>{bookName}</span>
            <span className="sep">/</span>
            <b>{t('bookLibrary.nav.bookSection')}</b>
            <span className="sep">/</span>
            <b>{title}</b>
          </div>
          <div className="book-library-search">
            <span aria-hidden="true">⌕</span>
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('bookLibrary.search.placeholder')}
              aria-label={t('bookLibrary.search.placeholder')}
            />
            <kbd>Ctrl K</kbd>
          </div>
          {view !== 'graph' && view !== 'overview' && view !== 'tools' ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setNewEntryOpen(true)}>
              {t('bookLibrary.entry.create')}
            </Button>
          ) : null}
          {onClose ? (
            <Button type="button" size="icon-xs" variant="ghost" aria-label={t('common.close')} title={t('common.close')} onClick={() => void handleClose()}>
              ✕
            </Button>
          ) : null}
        </header>

        {lore.error ? (
          <InlineErrorNotice
            className="mx-3 mt-2"
            title={t('bookLibrary.load.error')}
            message={`${lore.error} · ${t('common.retry')}`}
          />
        ) : null}

        <div className="book-library-body" style={view === 'graph' ? { overflow: 'hidden' } : undefined}>
          {view === 'graph' ? (
            <div className={`bl-graph-layout${peekItem ? ' has-peek' : ''}`}>
              <RelationsView workspace={workspace} items={lore.items} onOpenItem={(id) => void openEntry(id, 'graph')} />
              {peekItem ? (
                <aside className="bl-graph-peek" aria-label={t('bookLibrary.graph.peek')}>
                  <div className="bl-graph-peek-scroll">
                    <EntryDetailView
                      {...entryViewProps}
                      lore={lore}
                      readOnly
                      editing={false}
                      setEditing={(next) => {
                        if (!next) {
                          setPeekId(null)
                          return
                        }
                        setReturnView('graph')
                        setView('detail')
                      }}
                      onOpen={(id) => void openEntry(id, 'graph')}
                      onBack={() => setPeekId(null)}
                    />
                  </div>
                </aside>
              ) : null}
            </div>
          ) : view === 'tools' ? (
            <SettingPanel key={workspace} mode="lore" workspace={workspace} embedded showBookOverview={false}
              onFlushHandlerChange={registerToolsFlush} onDirtyChange={setToolsDirty} />
          ) : (
            <div className="book-library-page">
              {view === 'home' ? (
                <WorkbenchHomeView
                  bookName={bookName}
                  items={lore.items}
                  onOpen={(id) => void openEntry(id, 'home')}
                  onGoto={goto}
                />
              ) : null}

              {view === 'character' ? (
                <PeopleView
                  items={lore.items}
                  query={query}
                  onOpen={(id) => void openEntry(id, 'character')}
                  batchAction={
                    <CharacterTierBatchDialog
                      workspace={workspace}
                      items={lore.items}
                      onBeforeWrite={async () => {
                        await lore.saveNow()
                        return !lore.dirty
                      }}
                      onSaved={() => undefined}
                      onChanged={() => { void lore.reload() }}
                    />
                  }
                />
              ) : null}

              {(view === 'all' || (activeCategory && activeCategory.id !== 'character')) ? (
                <EntriesView
                  items={lore.items}
                  query={query}
                  types={view === 'all' ? [] : activeCategory?.types || []}
                  showTypeFilter={view === 'all'}
                  onOpen={(id) => void openEntry(id, view)}
                />
              ) : null}

              {view === 'detail' ? (
                <EntryDetailView
                  {...entryViewProps}
                  lore={lore}
                  editing={editing}
                  setEditing={setEditing}
                  onOpen={(id) => void openEntry(id, returnView)}
                  onBack={closeDetail}
                />
              ) : null}

              {view === 'overview' ? (
                <OverviewView
                  workspace={workspace}
                  items={lore.items}
                  draft={overview}
                  onOpenItem={(id) => void openEntry(id, 'overview')}
                  onSaved={() => { void lore.reload() }}
                />
              ) : null}
            </div>
          )}
        </div>
      </div>

      <NewEntryDialog
        open={newEntryOpen}
        busy={lore.loading}
        defaultType={activeCategory?.types[0] || 'character'}
        onOpenChange={setNewEntryOpen}
        onCreate={async (input) => {
          const created = await lore.createItem(input)
          if (created) {
            setReturnView(view === 'detail' ? returnView : view)
            setEditing(false)
            setView('detail')
          }
          return created
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={t('bookLibrary.entry.deleteTitle')}
        description={t('bookLibrary.entry.deleteDesc', { name: deleteTargetName })}
        confirmLabel={t('common.delete')}
        tone="danger"
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        onConfirm={async () => {
          if (!deleteTarget) return
          const ok = await lore.removeItem(deleteTarget.id)
          if (ok) {
            setDeleteTarget(null)
            setView('all')
          }
        }}
      />
    </section>
  )
}

function NavButton({ id, active, label, count, onClick, hideCount }: {
  id: BookLibraryView
  active: boolean
  label: string
  count?: number
  onClick: () => void
  hideCount?: boolean
}) {
  const Icon = NAV_ICON[id]
  return (
    <button type="button" className={`book-library-nav-item${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}>
      <Icon className="h-3.5 w-3.5" />
      <span className="book-library-nav-label">{label}</span>
      {!hideCount && typeof count === 'number' ? <span className="book-library-nav-count">{count}</span> : null}
    </button>
  )
}
