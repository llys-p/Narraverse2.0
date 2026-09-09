import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, Globe2, History as HistoryIcon, Loader2, MapPin, Plus, RotateCcw, Save, Settings2, Shield, Sparkles, UserRound, Users, X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FeaturePageShell } from '@/components/layout/feature-page-shell'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/common/EmptyState'
import { APIError, getBooks, type BookRecord } from '@/lib/api-client'
import { getInteractiveStories } from '@/features/interactive/api'
import { cn } from '@/lib/utils'
import { BindingPicker } from '../components/BindingPicker'
import { BindingAvatar } from '../components/BindingAvatar'
import { ModeEntries } from '../components/ModeEntries'
import { LocationSection } from '../components/sections/LocationSection'
import { FactionSection } from '../components/sections/FactionSection'
import { TimelineSection } from '../components/sections/TimelineSection'
import { classifyTargetValidity, type TargetLoadState, type TargetValidity } from '../binding-health'
import { characterDisplayName, getBinding, worldStats } from '../selectors'
import { characterFromBinding, emptyCharacter } from '../world-factory'
import { findDraftIssue, removeWorldEntity } from '../world-ops'
import { getWorld, updateWorld } from '../world-api'
import type { WorkspaceMode } from '@/stores/workspace-store'
import type { World, WorldAssetBinding, WorldCharacter, WorldFaction, WorldLocation, WorldTimelineEntry } from '../types'

type Section = 'overview' | 'setting' | 'characters' | 'locations' | 'factions' | 'history'
type LoadState = 'loading' | 'error' | 'notfound' | 'ready'

/** 草稿问题类别映射到控制台分区，便于保存前定位到首个空实体。 */
function issueToSection(kind: 'character' | 'location' | 'faction' | 'timeline'): Section {
  if (kind === 'character') return 'characters'
  if (kind === 'timeline') return 'history'
  return `${kind}s` as Section
}

interface WorldConsolePageProps {
  worldId: string
  onBack: () => void
  onOpenCharacter: (characterId: string) => void
  onWorldChanged: () => void
  onSetMode: (mode: WorkspaceMode) => void
  onQuickSwitchBook: (path: string) => Promise<boolean>
  onOpenModule4?: () => void
  onCloseModule4?: () => void
}

export function WorldConsolePage({
  worldId, onBack, onOpenCharacter, onWorldChanged, onSetMode, onQuickSwitchBook, onOpenModule4, onCloseModule4,
}: WorldConsolePageProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<LoadState>('loading')
  const [draft, setDraft] = useState<World | null>(null)
  const [revision, setRevision] = useState('')
  const [section, setSection] = useState<Section>('overview')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [books, setBooks] = useState<BookRecord[]>([])
  const [stories, setStories] = useState<{ id: string; title: string }[]>([])
  const [booksLoad, setBooksLoad] = useState<TargetLoadState>('loading')
  const [storiesLoad, setStoriesLoad] = useState<TargetLoadState>('loading')

  const load = useCallback(async () => {
    setState('loading')
    setConflict(false)
    try {
      const env = await getWorld(worldId)
      setDraft(env.world)
      setRevision(env.revision)
      setDirty(false)
      setState('ready')
    } catch (err) {
      setState(err instanceof APIError && err.status === 404 ? 'notfound' : 'error')
    }
  }, [worldId])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    void getBooks().then((b) => { setBooks(b); setBooksLoad('ok') }).catch(() => { setBooks([]); setBooksLoad('failed') })
    void getInteractiveStories().then((i) => { setStories(i.stories ?? []); setStoriesLoad('ok') }).catch(() => { setStories([]); setStoriesLoad('failed') })
  }, [])

  const mutate = useCallback((mutator: (w: World) => World) => {
    setDraft((prev) => {
      if (!prev) return prev
      setDirty(true)
      setConflict(false)
      return mutator(prev)
    })
  }, [])

  const save = useCallback(async () => {
    if (!draft || saving) return
    // 保存前先拦截空名/空标题实体（后端必然 400）：定位到对应分区并提示，不发请求。
    const issue = findDraftIssue(draft)
    if (issue) {
      setSection(issueToSection(issue.kind))
      toast.error(t(`worldWorkspace.console.draftInvalid.${issue.kind}`))
      return
    }
    setSaving(true)
    setConflict(false)
    try {
      const res = await updateWorld(worldId, revision, draft)
      setDraft(res.world)
      setRevision(res.revision)
      setDirty(false)
      onWorldChanged()
      toast.success(t('worldWorkspace.console.settingSaved'))
    } catch (err) {
      if (err instanceof APIError && err.status === 409) setConflict(true)
      else toast.error(err instanceof Error ? err.message : t('worldWorkspace.saveError'))
    } finally {
      setSaving(false)
    }
  }, [draft, saving, revision, worldId, onWorldChanged, t])

  // 冲突时显式重新加载：先确认放弃本地未保存修改，再以服务器数据为准（load 会清 conflict/dirty）。
  const reload = useCallback(async () => {
    if (!window.confirm(t('worldWorkspace.bindingHealth.reloadConfirm'))) return
    await load()
  }, [load, t])

  // 统一离开 preflight：有未保存修改时确认一次，返回是否允许离开。页面内各出口与 ModeEntries 共用它，杜绝双重确认。
  const confirmLeave = useCallback(() => !dirty || window.confirm(t('worldWorkspace.unsavedLeave')), [dirty, t])
  const guardLeave = useCallback((fn: () => void) => {
    if (!confirmLeave()) return
    fn()
  }, [confirmLeave])

  const boundMasterIds = useMemo(() => new Set((draft?.bindings ?? []).map((b) => b.masterItemId)), [draft])

  // 手动新建必须带可保存的非空默认名（后端要求 displayName 非空），重名时追加序号。
  const addManualCharacter = () => mutate((w) => {
    const base = t('worldWorkspace.console.newCharacterDefault')
    const taken = new Set(w.characters.map((c) => c.displayName.trim()))
    let name = base
    let n = 2
    while (taken.has(name)) name = `${base} ${n++}`
    return { ...w, characters: [...w.characters, emptyCharacter(name)] }
  })

  // 删除实体走纯函数级联：解除其它实体引用并清理 orphan binding，保证草稿仍可被后端接受。
  const confirmRemove = (kind: 'character' | 'location' | 'faction', id: string) => {
    if (!window.confirm(t('worldWorkspace.console.deleteConfirm'))) return
    mutate((w) => removeWorldEntity(w, kind, id))
  }

  const bindCharacter = (binding: WorldAssetBinding) => {
    mutate((w) => {
      const bindings = w.bindings.some((b) => b.bindingId === binding.bindingId) ? w.bindings : [...w.bindings, binding]
      const character: WorldCharacter = characterFromBinding(binding)
      return { ...w, bindings, characters: [...w.characters, character] }
    })
    setPickerOpen(false)
    setSection('characters')
  }

  const removeCharacter = (id: string) => confirmRemove('character', id)

  const tabs: { key: Section; icon: typeof Globe2; label: string }[] = [
    { key: 'overview', icon: Globe2, label: t('worldWorkspace.console.overview') },
    { key: 'setting', icon: Settings2, label: t('worldWorkspace.console.setting') },
    { key: 'characters', icon: Users, label: t('worldWorkspace.characters') },
    { key: 'locations', icon: MapPin, label: t('worldWorkspace.locations') },
    { key: 'factions', icon: Shield, label: t('worldWorkspace.factions') },
    { key: 'history', icon: HistoryIcon, label: t('worldWorkspace.timeline') },
  ]

  return (
    <FeaturePageShell
      icon={Globe2}
      title={draft?.name ?? t('worldWorkspace.title')}
      leadingContent={<Button variant="ghost" size="icon-sm" onClick={() => guardLeave(onBack)} aria-label={t('worldWorkspace.console.backToList')}><ArrowLeft /></Button>}
      actions={dirty ? <Button size="sm" disabled={saving || state !== 'ready'} onClick={() => void save()} data-icon="inline-start">
        {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}{t('worldWorkspace.save')}
      </Button> : undefined}
      onClose={() => guardLeave(onBack)}
      error={state === 'error' ? t('worldWorkspace.console.getError') : null}
    >
      {state === 'loading' && (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-[var(--nova-text-muted)]"><Loader2 className="size-4 animate-spin" />{t('worldWorkspace.loading')}</div>
      )}
      {(state === 'error' || state === 'notfound') && (
        <EmptyState variant="page" icon={Globe2}
          title={state === 'notfound' ? t('worldWorkspace.console.notFound') : t('worldWorkspace.console.getError')}
          action={{ label: t('worldWorkspace.retry'), onClick: () => void load() }} />
      )}

      {state === 'ready' && draft && (
        <div className="flex h-full min-h-0 flex-col">
          {conflict && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
              <span className="flex-1">{t('worldWorkspace.console.conflict')}</span>
              <Button variant="outline" size="xs" data-icon="inline-start" disabled={saving} onClick={() => void reload()}>
                <RotateCcw className="size-3.5" />{t('worldWorkspace.bindingHealth.reload')}
              </Button>
            </div>
          )}
          <nav className="flex shrink-0 flex-wrap gap-1 border-b border-[var(--nova-border)] px-2 py-1">
            {tabs.map(({ key, icon: Icon, label }) => (
              <button key={key} type="button" onClick={() => setSection(key)}
                className={cn('inline-flex items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 py-1.5 text-xs transition-colors',
                  section === key ? 'bg-[var(--nova-active)] text-[var(--nova-active-text)]' : 'text-[var(--nova-text-muted)] hover:bg-[var(--nova-surface-2)]')}>
                <Icon className="size-3.5" />{label}
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
            {section === 'overview' && <Overview world={draft} t={t} books={books} stories={stories}
              booksLoad={booksLoad} storiesLoad={storiesLoad} mutate={mutate} confirmLeave={confirmLeave}
              onSetMode={onSetMode} onQuickSwitchBook={onQuickSwitchBook} onOpenModule4={onOpenModule4} onCloseModule4={onCloseModule4} />}

            {section === 'setting' && <SettingEditor world={draft} mutate={mutate} t={t} />}

            {section === 'characters' && (
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <Button variant="outline" size="xs" data-icon="inline-start" onClick={() => setPickerOpen(true)}><Sparkles className="size-3.5" />{t('worldWorkspace.console.bindAsset')}</Button>
                  <Button variant="outline" size="xs" data-icon="inline-start" onClick={addManualCharacter}><Plus className="size-3.5" />{t('worldWorkspace.console.manualCreate')}</Button>
                </div>
                {draft.characters.length === 0 ? (
                  <EmptyState variant="dashed" icon={UserRound} title={t('worldWorkspace.console.emptyCharacters')} />
                ) : (
                  <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {draft.characters.map((c) => {
                      const binding = getBinding(draft, c.bindingId)
                      return (
                        <li key={c.id} className="group flex items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--nova-border)] p-2">
                          <BindingAvatar masterItemId={binding?.masterItemId} className="size-10 rounded-[var(--radius-md)]" />
                          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => guardLeave(() => onOpenCharacter(c.id))}>
                            <span className="block truncate text-sm font-medium">{characterDisplayName(draft, c) || t('worldWorkspace.empty')}</span>
                            {c.role ? <span className="block text-[11px] text-[var(--nova-text-muted)]">{t(`worldWorkspace.role.${c.role}`)}</span> : null}
                          </button>
                          <Button variant="ghost" size="icon-xs" className="opacity-0 transition-opacity group-hover:opacity-100" aria-label="remove" onClick={() => removeCharacter(c.id)}><X /></Button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )}

            {section === 'locations' && (
              <LocationSection world={draft} onChange={(locations: WorldLocation[]) => mutate((w) => ({ ...w, locations }))}
                onRemove={(id) => confirmRemove('location', id)} />
            )}
            {section === 'factions' && (
              <FactionSection world={draft} onChange={(factions: WorldFaction[]) => mutate((w) => ({ ...w, factions }))}
                onRemove={(id) => confirmRemove('faction', id)} />
            )}
            {section === 'history' && (
              <TimelineSection world={draft} onChange={(timeline: WorldTimelineEntry[]) => mutate((w) => ({ ...w, timeline }))} />
            )}
          </div>
        </div>
      )}

      <BindingPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        boundMasterIds={boundMasterIds}
        recordKind="character_template"
        semanticType="character"
        onBind={bindCharacter}
      />
    </FeaturePageShell>
  )
}

type Mutator = (fn: (w: World) => World) => void
type TFn = (k: string, o?: Record<string, unknown>) => string

function Overview({ world, t, books, stories, booksLoad, storiesLoad, mutate, confirmLeave, onSetMode, onQuickSwitchBook, onOpenModule4, onCloseModule4 }: {
  world: World
  t: TFn
  books: BookRecord[]
  stories: { id: string; title: string }[]
  booksLoad: TargetLoadState
  storiesLoad: TargetLoadState
  mutate: Mutator
  confirmLeave: () => boolean
  onSetMode: (mode: WorkspaceMode) => void
  onQuickSwitchBook: (path: string) => Promise<boolean>
  onOpenModule4?: () => void
  onCloseModule4?: () => void
}) {
  const stats = worldStats(world)
  const bookPath = world.primaryBookPath ?? ''
  const storyId = world.primaryInteractiveStoryId ?? ''
  const bookValidity = classifyTargetValidity(bookPath, books.some((b) => b.path === bookPath), booksLoad)
  const storyValidity = classifyTargetValidity(storyId, stories.some((s) => s.id === storyId), storiesLoad)
  const truncate = (v: string) => (v.length > 48 ? `${v.slice(0, 45)}…` : v)
  const chips = [
    { label: t('worldWorkspace.characters'), value: stats.characterCount },
    { label: t('worldWorkspace.locations'), value: stats.locationCount },
    { label: t('worldWorkspace.factions'), value: stats.factionCount },
    { label: t('worldWorkspace.timeline'), value: stats.timelineCount },
  ]
  const selectCls = 'h-8 w-full rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-2 text-sm outline-none focus:border-[var(--nova-ring)]'
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="rounded-[var(--radius-lg)] border border-[var(--nova-border)] p-4" style={{ borderLeft: `3px solid ${world.coverColor || 'var(--nova-border)'}` }}>
        <h2 className="text-base font-medium">{world.name}</h2>
        {world.tagline ? <p className="mt-1 text-sm text-[var(--nova-text-muted)]">{world.tagline}</p> : null}
        {world.summary ? <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{world.summary}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {chips.map((c) => (
            <span key={c.label} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--nova-border)] px-2.5 py-1 text-xs">
              <span className="font-medium">{c.value}</span>{c.label}
            </span>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
          <span className="flex items-center justify-between gap-2">
            {t('worldWorkspace.create.primaryBook')}
            {bookValidity !== 'none' && <TargetValidityTag t={t} validity={bookValidity} />}
          </span>
          <select className={selectCls} value={bookPath} onChange={(e) => mutate((w) => ({ ...w, primaryBookPath: e.target.value || undefined }))}>
            <option value="">{t('worldWorkspace.create.primaryBookNone')}</option>
            {bookValidity === 'invalid' && <option value={bookPath} disabled>{t('worldWorkspace.targetValidity.invalidOption', { value: truncate(bookPath) })}</option>}
            {books.map((b) => <option key={b.path} value={b.path}>{b.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
          <span className="flex items-center justify-between gap-2">
            {t('worldWorkspace.create.primaryStory')}
            {storyValidity !== 'none' && <TargetValidityTag t={t} validity={storyValidity} />}
          </span>
          <select className={selectCls} value={storyId} onChange={(e) => mutate((w) => ({ ...w, primaryInteractiveStoryId: e.target.value || undefined }))}>
            <option value="">{t('worldWorkspace.create.primaryStoryNone')}</option>
            {storyValidity === 'invalid' && <option value={storyId} disabled>{t('worldWorkspace.targetValidity.invalidOption', { value: truncate(storyId) })}</option>}
            {stories.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </label>
      </div>

      <ModeEntries world={world} confirmLeave={confirmLeave} onSetMode={onSetMode} onQuickSwitchBook={onQuickSwitchBook} onOpenModule4={onOpenModule4} onCloseModule4={onCloseModule4} />
    </div>
  )
}

function SettingEditor({ world, mutate, t }: { world: World; mutate: Mutator; t: TFn }) {
  const setting = world.worldSetting ?? { rules: [] }
  const inputCls = 'h-8 w-full rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-2.5 text-sm outline-none focus:border-[var(--nova-ring)]'
  const patch = (patch: Partial<World>) => mutate((w) => ({ ...w, ...patch }))
  const patchSetting = (p: Partial<NonNullable<World['worldSetting']>>) => mutate((w) => ({ ...w, worldSetting: { rules: [], ...w.worldSetting, ...p } }))
  const setRule = (i: number, value: string) => patchSetting({ rules: setting.rules.map((r, idx) => (idx === i ? value : r)) })

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
        {t('worldWorkspace.console.tagline')}
        <input className={inputCls} value={world.tagline ?? ''} maxLength={200} onChange={(e) => patch({ tagline: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
        {t('worldWorkspace.console.genre')}
        <input className={inputCls} value={world.genre ?? ''} maxLength={50} onChange={(e) => patch({ genre: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
        {t('worldWorkspace.console.summary')}
        <textarea className="min-h-28 rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2.5 text-sm leading-6 outline-none focus:border-[var(--nova-ring)]"
          value={world.summary ?? ''} maxLength={20000} onChange={(e) => patch({ summary: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
        {t('worldWorkspace.console.tone')}
        <input className={inputCls} value={setting.tone ?? ''} maxLength={200} onChange={(e) => patchSetting({ tone: e.target.value })} />
      </label>
      <div className="flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
        {t('worldWorkspace.console.rules')}
        <div className="flex flex-col gap-2">
          {setting.rules.map((rule, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className={inputCls} value={rule} maxLength={2000} onChange={(e) => setRule(i, e.target.value)} />
              <Button variant="ghost" size="icon-sm" aria-label="remove"
                onClick={() => patchSetting({ rules: setting.rules.filter((_, idx) => idx !== i) })}><X /></Button>
            </div>
          ))}
          <Button variant="outline" size="xs" className="self-start" data-icon="inline-start"
            onClick={() => patchSetting({ rules: [...setting.rules, ''] })}><Plus className="size-3.5" />{t('worldWorkspace.console.addRule')}</Button>
        </div>
      </div>
    </div>
  )
}

const VALIDITY_CLS: Record<TargetValidity, string> = {
  enterable: 'text-emerald-700 dark:text-emerald-300',
  invalid: 'text-amber-700 dark:text-amber-300',
  unavailable: 'text-[var(--nova-text-muted)]',
  checking: 'text-[var(--nova-text-muted)]',
  none: 'text-[var(--nova-text-muted)]',
}

/** 主书/主故事入口有效性小标签（只读校验，不回写目标数据）。 */
function TargetValidityTag({ t, validity }: { t: TFn; validity: TargetValidity }) {
  if (validity === 'none') return null
  return <span className={cn('font-normal', VALIDITY_CLS[validity])}>{t(`worldWorkspace.targetValidity.${validity}`)}</span>
}
