import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Loader2, RefreshCw, RotateCcw, Save, UserRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FeaturePageShell } from '@/components/layout/feature-page-shell'
import { Button } from '@/components/ui/button'
import { APIError, fetchMasterAsset, type MasterAssetDetail } from '@/lib/api-client'
import { applyRefreshedBinding, classifyBindingHealth, type BindingCheckOutcome } from '../binding-health'
import { getBinding } from '../selectors'
import { getWorld, updateWorld } from '../world-api'
import { BindingAvatar } from './BindingAvatar'
import { BindingHealthBadge } from './BindingHealthBadge'
import type { CharacterRole, World, WorldAssetBinding, WorldCharacter } from '../types'

interface CharacterProfileProps {
  worldId: string
  characterId: string
  onBack: () => void
}

type LoadState = 'loading' | 'error' | 'ready'
const ROLES: CharacterRole[] = ['protagonist', 'major', 'minor', 'npc']

export function CharacterProfile({ worldId, characterId, onBack }: CharacterProfileProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<LoadState>('loading')
  const [world, setWorld] = useState<World | null>(null)
  const [revision, setRevision] = useState('')
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [source, setSource] = useState<MasterAssetDetail | null>(null)
  const [sourceError, setSourceError] = useState(false)
  const [check, setCheck] = useState<BindingCheckOutcome>({ phase: 'idle' })
  const [refreshing, setRefreshing] = useState(false)
  // 重载后强制重新检查一次原件；请求序号防止旧请求覆盖新状态（不使用 AbortController）。
  const [checkNonce, setCheckNonce] = useState(0)
  const inspectSeq = useRef(0)

  const load = useCallback(async () => {
    setState('loading')
    setConflict(false)
    try {
      const env = await getWorld(worldId)
      setWorld(env.world)
      setRevision(env.revision)
      setState('ready')
    } catch {
      setState('error')
    }
  }, [worldId])

  useEffect(() => { void load() }, [load])

  const character = world?.characters.find((c) => c.id === characterId) ?? null
  const binding = world && character ? getBinding(world, character.bindingId) : undefined
  const health = classifyBindingHealth(binding, check)

  // 按需检查原件（只读，绝不修改 world）。仅在打开角色/重载后触发一次，不做轮询、不做加载扇出。
  const runInspect = useCallback(async (target: WorldAssetBinding, mode: 'check' | 'refresh') => {
    const seq = ++inspectSeq.current
    if (mode === 'refresh') setRefreshing(true)
    setCheck({ phase: 'loading' })
    try {
      const detail = await fetchMasterAsset(target.masterItemId)
      if (seq !== inspectSeq.current) return
      setSource(detail)
      setSourceError(false)
      const currentRevision = detail.summary.master_revision ?? ''
      setCheck({ phase: 'ok', currentRevision })
      if (mode === 'refresh') {
        // 原件缺少内容哈希则无法建立基线：保持 unavailable，不改名称/标签/版本，也不报成功。
        if (!currentRevision) {
          toast.error(t('worldWorkspace.bindingHealth.refreshUnavailable'))
          return
        }
        // 只有显式刷新且拿到有效哈希时，才更新本地 world 的绑定三字段；角色世界内数据保持不变。
        setWorld((prev) => prev
          ? applyRefreshedBinding(prev, target.bindingId, {
            name: detail.summary.name,
            tags: Array.isArray(detail.summary.tags) ? detail.summary.tags : [],
            masterRevision: currentRevision,
          })
          : prev)
        toast.success(t('worldWorkspace.bindingHealth.refreshed'))
      }
    } catch (err) {
      if (seq !== inspectSeq.current) return
      setSource(null)
      setSourceError(true)
      const status = err instanceof APIError ? err.status : undefined
      setCheck({ phase: 'error', status })
      // 404/其它错误都不改本地 world、不删绑定或角色。
      if (mode === 'refresh') {
        toast.error(status === 404
          ? t('worldWorkspace.bindingHealth.refreshMissing')
          : t('worldWorkspace.bindingHealth.refreshUnavailable'))
      }
    } finally {
      if (seq === inspectSeq.current) setRefreshing(false)
    }
  }, [t])

  useEffect(() => {
    if (!binding) {
      setSource(null)
      setSourceError(false)
      setCheck({ phase: 'idle' })
      // 绑定被移除/切到无绑定角色：使上一角色的在途检查请求失效。
      inspectSeq.current += 1
      return
    }
    void runInspect(binding, 'check')
    // cleanup：依赖变化（切换角色）或组件卸载时使旧请求失效（不使用 AbortController）。
    return () => { inspectSeq.current += 1 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding?.masterItemId, checkNonce])

  const patchCharacter = (patch: Partial<WorldCharacter>) => {
    if (!world || !character) return
    setConflict(false)
    setWorld({ ...world, characters: world.characters.map((c) => (c.id === character.id ? { ...c, ...patch } : c)) })
  }

  const save = async () => {
    if (!world || saving) return
    setSaving(true)
    setConflict(false)
    try {
      const res = await updateWorld(worldId, revision, world)
      setWorld(res.world)
      setRevision(res.revision)
      toast.success(t('worldWorkspace.saved'))
    } catch (err) {
      if (err instanceof APIError && err.status === 409) setConflict(true)
      else toast.error(err instanceof Error ? err.message : t('worldWorkspace.saveError'))
    } finally {
      setSaving(false)
    }
  }

  // 冲突时显式重新加载：先确认放弃本地未保存修改，再以服务器数据为准。
  const reload = async () => {
    if (!window.confirm(t('worldWorkspace.bindingHealth.reloadConfirm'))) return
    await load()
    setCheckNonce((n) => n + 1)
  }

  const inputCls = 'h-8 w-full rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-2.5 text-sm outline-none focus:border-[var(--nova-ring)]'

  return (
    <FeaturePageShell
      icon={UserRound}
      title={character?.displayName || t('worldWorkspace.characters')}
      leadingContent={<Button variant="ghost" size="icon-sm" onClick={onBack} aria-label={t('worldWorkspace.character.back')}><ArrowLeft /></Button>}
      actions={<Button size="sm" disabled={state !== 'ready' || saving || !character} onClick={() => void save()} data-icon="inline-start">
        {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}{t('worldWorkspace.save')}
      </Button>}
    >
      {conflict && state === 'ready' && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
          <span className="flex-1">{t('worldWorkspace.console.conflict')}</span>
          <Button variant="outline" size="xs" data-icon="inline-start" onClick={() => void reload()}>
            <RotateCcw className="size-3.5" />{t('worldWorkspace.bindingHealth.reload')}
          </Button>
        </div>
      )}
      {state === 'loading' && (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-[var(--nova-text-muted)]"><Loader2 className="size-4 animate-spin" />{t('worldWorkspace.loading')}</div>
      )}
      {state === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm">
          <span>{t('worldWorkspace.console.getError')}</span>
          <Button variant="outline" size="xs" onClick={() => void load()}>{t('worldWorkspace.retry')}</Button>
        </div>
      )}
      {state === 'ready' && !character && (
        <div className="flex flex-1 items-center justify-center text-sm text-[var(--nova-text-muted)]">{t('worldWorkspace.console.notFound')}</div>
      )}
      {state === 'ready' && world && character && (
        <div className="grid h-full min-h-0 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[1fr_320px]">
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              {binding
                ? <BindingAvatar masterItemId={binding.masterItemId} className="size-14 rounded-[var(--radius-lg)]" />
                : <BindingAvatar masterItemId={undefined} className="size-14 rounded-[var(--radius-lg)]" />}
              <label className="flex flex-1 flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
                {t('worldWorkspace.character.displayName')}
                <input className={inputCls} value={character.displayName} maxLength={100} onChange={(e) => patchCharacter({ displayName: e.target.value })} />
              </label>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
                {t('worldWorkspace.character.role')}
                <select className={inputCls} value={character.role ?? ''} onChange={(e) => patchCharacter({ role: (e.target.value || undefined) as CharacterRole | undefined })}>
                  <option value="">—</option>
                  {ROLES.map((r) => <option key={r} value={r}>{t(`worldWorkspace.role.${r}`)}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
                {t('worldWorkspace.character.faction')}
                <select className={inputCls} value={character.factionId ?? ''} onChange={(e) => patchCharacter({ factionId: e.target.value || undefined })}>
                  <option value="">—</option>
                  {world.factions.map((f) => <option key={f.id} value={f.id}>{f.name || f.id}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
                {t('worldWorkspace.character.location')}
                <select className={inputCls} value={character.locationId ?? ''} onChange={(e) => patchCharacter({ locationId: e.target.value || undefined })}>
                  <option value="">—</option>
                  {world.locations.map((l) => <option key={l.id} value={l.id}>{l.name || l.id}</option>)}
                </select>
              </label>
            </div>
            <label className="flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
              {t('worldWorkspace.character.worldNote')}
              <span className="text-[11px] text-[var(--nova-text-muted)]">{t('worldWorkspace.character.worldNoteHint')}</span>
              <textarea className="min-h-24 rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2.5 text-sm leading-6 outline-none focus:border-[var(--nova-ring)]"
                value={character.worldNote ?? ''} maxLength={4000} onChange={(e) => patchCharacter({ worldNote: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--nova-text-muted)]">
              {t('worldWorkspace.character.growthNote')}
              <textarea className="min-h-20 rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2.5 text-sm leading-6 outline-none focus:border-[var(--nova-ring)]"
                value={character.growthNote ?? ''} maxLength={4000} onChange={(e) => patchCharacter({ growthNote: e.target.value })} />
            </label>
          </section>

          <aside className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--nova-border)] bg-[var(--nova-surface)] p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-medium text-[var(--nova-text-muted)]">{t('worldWorkspace.character.sourceRecord')}</h3>
              {binding ? <BindingHealthBadge state={health} /> : null}
            </div>
            {!binding && <p className="text-xs text-[var(--nova-text-muted)]">{t('worldWorkspace.console.emptyBinding')}</p>}
            {binding && sourceError && (
              <p className="rounded-[var(--radius-md)] border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">{t('worldWorkspace.character.sourceUnavailable')}</p>
            )}
            {binding && !sourceError && !source && <p className="flex items-center gap-2 text-[11px] text-[var(--nova-text-muted)]"><Loader2 className="size-3 animate-spin" />{t('worldWorkspace.loading')}</p>}
            {source && (
              <div className="flex flex-col gap-1.5 text-xs">
                <div className="font-medium">{source.summary.name}</div>
                <div className="text-[var(--nova-text-muted)]">{source.summary.semantic_type} · {source.summary.record_kind}</div>
                {typeof source.item.description === 'string' && source.item.description ? (
                  <p className="max-h-64 overflow-y-auto rounded-[var(--radius-md)] bg-[var(--nova-surface-2)] p-2 leading-5">{String(source.item.description)}</p>
                ) : null}
              </div>
            )}
            {binding && (
              <Button variant="outline" size="xs" className="mt-1 self-start" disabled={refreshing} data-icon="inline-start"
                onClick={() => void runInspect(binding, 'refresh')}>
                {refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                {t('worldWorkspace.bindingHealth.refresh')}
              </Button>
            )}
          </aside>
        </div>
      )}
    </FeaturePageShell>
  )
}
