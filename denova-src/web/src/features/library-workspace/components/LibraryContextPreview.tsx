import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { WorkLibrary } from '@/lib/api-client'
import { useLibraryContextLaunch } from '@/features/library-context-runtime/LibraryContextLaunchProvider'
import { useIframeLibraryContextLaunch } from '@/features/library-context-runtime/IframeLibraryContextLaunchProvider'
import { useWorldContextHost } from '@/features/world-context-runtime/WorldContextHostProvider'
import { previewWorkLibrary, type LibraryPreview } from '../library-context-api'
import { LibraryGameLaunchDialog } from './LibraryGameLaunchDialog'

interface Props {
  library: WorkLibrary
  revision: string
  dirty: boolean
  /** 当前写作侧是否已有打开的书；库与书无关，但带入写作必须落在有书的写作上下文。 */
  hasWritingBook?: boolean
  /** 用户显式发起带入写作：写入一次性交接并返回写作模式（由上层完成模式切换）。 */
  onLaunchWriting?: () => void
  /** 用户显式发起带入游戏：选择目标故事/分支成功后写入一次性交接并切到游戏模式。 */
  onLaunchGame?: () => void
  /** 用户显式发起带入叙界：写入一次性交接并切到叙界模式（宿主受控 iframe）。 */
  onLaunchNarraverse?: () => void
  /** 用户显式发起带入开放沙盒：写入一次性交接并在叙界 iframe 内打开 Module4。 */
  onLaunchModule4?: () => void
}

/** Session-only read preview. Opening the tab never issues a request. */
export function LibraryContextPreview({ library, revision, dirty, hasWritingBook = false, onLaunchWriting, onLaunchGame, onLaunchNarraverse, onLaunchModule4 }: Props) {
  const { t } = useTranslation()
  const { launchWritingLibrary } = useLibraryContextLaunch()
  const iframeLibraryLaunches = useIframeLibraryContextLaunch()
  const worldContextHost = useWorldContextHost()
  const [iframeLaunchNotice, setIframeLaunchNotice] = useState<string | null>(null)
  const [manual, setManual] = useState<string[]>([])
  const [auto, setAuto] = useState<string[]>([])
  const [offset, setOffset] = useState(0)
  const [result, setResult] = useState<{ key: string; data: LibraryPreview } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)
  const mounted = useRef(true)
  const eligible = library.items.filter((item) => item.enabled)
  const manualIDs = manual.filter((id) => eligible.some((item) => item.id === id && item.loadMode === 'manual')).sort()
  const autoIDs = auto.filter((id) => eligible.some((item) => item.id === id && item.loadMode === 'auto')).sort()
  const request = { expectedRevision: revision, manualItemIds: manualIDs, autoItemIds: autoIDs, catalogOffset: offset, catalogLimit: 50 }
  const key = JSON.stringify([library.id, request, dirty])
  const activeKey = useRef(key)
  activeKey.current = key
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; sequence.current++ }
  }, [])
  useEffect(() => {
    sequence.current++
    setLoading(false)
    setError(null)
  }, [key])

  const generate = async () => {
    if (dirty || loading || !revision) return
    const ticket = ++sequence.current
    setLoading(true); setError(null)
    const current = () => mounted.current && ticket === sequence.current && key === activeKey.current
    try {
      const data = await previewWorkLibrary(library.id, request)
      if (current()) setResult({ key, data })
    } catch (failure) {
      if (current()) {
        const code = typeof failure === 'object' && failure && 'code' in failure ? String(failure.code) : ''
        setError(t(`workLibrary.preview.errors.${code}`, { defaultValue: t('workLibrary.loadError') }))
      }
    } finally { if (current()) setLoading(false) }
  }
  const stale = result !== null && (result.key !== key || dirty)
  const data = result?.data
  // B2b：用户显式选择库并带入写作。只交接已保存库的 Ref（libraryId+expectedRevision+
  // manualItemIds）；L2 预览的 autoItemIds 是预览专属选择，不进入运行授权（B0 §8.2）；
  // 无书时禁用（交接必须落在有书的写作上下文），与生成预览一样拒绝未保存草稿。
  const launchToWriting = () => {
    if (dirty || !revision || !hasWritingBook) return
    launchWritingLibrary({
      libraryId: library.id,
      expectedRevision: revision,
      manualItemIds: manualIDs,
      libraryName: library.name,
      revisionLabel: revision,
      selectedCount: manualIDs.length,
    })
    onLaunchWriting?.()
  }
  // B3b：带入游戏先显式选择目标故事/分支；确认成功才写一次性交接并切模式，
  // 取消或失败不写交接（游戏侧当前背景保持不变）。与带入写作共用“已保存库 Ref，
  // autoItemIds 不进入授权”的边界。
  const [gameLaunchOpen, setGameLaunchOpen] = useState(false)
  const gameLaunchPayload = {
    libraryId: library.id,
    expectedRevision: revision,
    manualItemIds: manualIDs,
    libraryName: library.name,
    revisionLabel: revision,
    selectedCount: manualIDs.length,
  }
  // B4a：带入叙界（宿主受控 iframe）。与带入写作/游戏同源：只交接已保存库的 Ref
  // 三字段 + 摘要，autoItemIds 不进入授权；consumer 由宿主受控路由固定，Ref 不落 iframe。
  // 宿主会话不可用时显式提示（与 world 侧带入同一守卫），不写入交接。
  const iframeLaunchPayload = () => ({
    libraryId: library.id,
    expectedRevision: revision,
    manualItemIds: manualIDs,
    libraryName: library.name,
    revisionLabel: revision,
    selectedCount: manualIDs.length,
    launchedAt: Date.now(),
  })
  const launchToNarraverse = () => {
    if (dirty || !revision) return
    if (worldContextHost.state !== 'ready') {
      setIframeLaunchNotice(t('workLibrary.preview.launchHostUnavailable'))
      return
    }
    setIframeLaunchNotice(null)
    iframeLibraryLaunches.launch('narraverse', iframeLaunchPayload())
    onLaunchNarraverse?.()
  }
  // B4b：带入开放沙盒（Module4）。同一受控边界与 Ref 边界；打开走 App 的既有
  // onOpenModule4（切叙界模式并在 iframe 内打开 Module4），不改沙盒规则与存档真源。
  const launchToModule4 = () => {
    if (dirty || !revision) return
    if (worldContextHost.state !== 'ready') {
      setIframeLaunchNotice(t('workLibrary.preview.launchHostUnavailable'))
      return
    }
    setIframeLaunchNotice(null)
    iframeLibraryLaunches.launch('module4', iframeLaunchPayload())
    onLaunchModule4?.()
  }
  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-3" aria-label={t('workLibrary.tab.preview')}>
      <p className="mb-3 text-sm text-muted-foreground">{t('workLibrary.preview.hint')}</p>
      <p className="mb-3 text-xs text-muted-foreground">{t('workLibrary.preview.resident', { count: eligible.filter((item) => item.loadMode === 'resident').length })}</p>
      <div className="grid gap-3 md:grid-cols-2">
        {(['auto', 'manual'] as const).map((mode) => (
          <label key={mode} className="flex min-w-0 flex-col gap-1 text-sm">
            <span>{t(`workLibrary.preview.${mode}`)}</span>
            <select multiple size={5} value={mode === 'auto' ? autoIDs : manualIDs}
              className="w-full min-w-0 rounded border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2"
              onChange={(event) => {
                const ids = Array.from(event.target.selectedOptions, (option) => option.value)
                if (mode === 'auto') setAuto(ids); else setManual(ids)
              }}>
              {eligible.filter((item) => item.loadMode === mode).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
            </select>
          </label>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t('workLibrary.preview.selectionHint')}</p>
      <div className="my-3 flex flex-wrap items-center gap-2">
        <Button type="button" disabled={dirty || loading || !revision} onClick={() => void generate()}>
          {loading ? t('workLibrary.loading') : t('workLibrary.preview.generate')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={dirty || !revision || !hasWritingBook}
          onClick={launchToWriting}
          title={!hasWritingBook ? t('workLibrary.preview.launchNeedBook') : undefined}
        >
          {t('workLibrary.preview.launchWriting')}
        </Button>
        {/* B3b：带入游戏。目标故事/分支在对话框内显式选择（§三.1 复用既有流程）。 */}
        <Button
          type="button"
          variant="outline"
          disabled={dirty || !revision}
          onClick={() => setGameLaunchOpen(true)}
        >
          {t('workLibrary.preview.launchGame')}
        </Button>
        {/* B4a：带入叙界（宿主受控 iframe，库 Ref 只交给同源宿主页面）。 */}
        <Button
          type="button"
          variant="outline"
          disabled={dirty || !revision}
          onClick={launchToNarraverse}
        >
          {t('workLibrary.preview.launchNarraverse')}
        </Button>
        {/* B4b：带入开放沙盒（Module4），沿用既有 onOpenModule4 受控入口。 */}
        <Button
          type="button"
          variant="outline"
          disabled={dirty || !revision}
          onClick={launchToModule4}
        >
          {t('workLibrary.preview.launchModule4')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => { setAuto([]); setManual([]); setOffset(0) }}>{t('workLibrary.preview.clear')}</Button>
        {dirty ? <span role="status">{t('workLibrary.preview.saveFirst')}</span> : null}
        {stale ? <span role="status">{t('workLibrary.preview.stale')}</span> : null}
        {!hasWritingBook ? <span role="status">{t('workLibrary.preview.launchNeedBook')}</span> : null}
        {iframeLaunchNotice ? <span role="alert">{iframeLaunchNotice}</span> : null}
      </div>
      {error ? <p role="alert" className="mb-3 text-sm">{error}</p> : null}
      {gameLaunchOpen ? (
        <LibraryGameLaunchDialog
          launch={gameLaunchPayload}
          onClose={() => setGameLaunchOpen(false)}
          onLaunchGame={onLaunchGame}
        />
      ) : null}
      {data ? <div className="space-y-4" aria-busy={loading}>
        <p className="break-all text-xs text-muted-foreground">{data.name} · {data.revision}</p>
        <p className="text-xs">{t('workLibrary.preview.budget', data.budget)}</p>
        <div className="whitespace-pre-wrap break-words text-sm">{[data.summary, data.tone, data.startingPoint].filter(Boolean).join('\n')}</div>
        <h3 className="font-medium">{t('workLibrary.preview.catalog', { total: data.catalog.total })}</h3>
        {data.catalog.items.length === 0 ? <p>{t('workLibrary.preview.empty')}</p> : <ul className="space-y-2">
          {data.catalog.items.map((item) => <li key={item.itemId} className="break-words"><strong>{item.name}</strong><span className="ml-2 text-xs">{item.itemId}</span><p>{item.briefDescription}</p></li>)}
        </ul>}
        <div className="flex gap-2">
          <Button type="button" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>{t('workLibrary.preview.previous')}</Button>
          <Button type="button" variant="ghost" disabled={stale || data.catalog.nextOffset === undefined} onClick={() => setOffset(data.catalog.nextOffset ?? 0)}>{t('workLibrary.preview.next')}</Button>
        </div>
        <h3 className="font-medium">{t('workLibrary.preview.loaded', { count: data.loaded.length })}</h3>
        {data.loaded.length === 0 ? <p>{t('workLibrary.preview.empty')}</p> : data.loaded.map((item) => (
          <details key={item.itemId} className="rounded border border-[var(--nova-border)] p-2">
            <summary className="cursor-pointer break-words">{item.name} · {item.itemId}</summary>
            {item.sourceRevision ? <p className="break-all text-xs">{item.sourceRevision}</p> : null}
            <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm">{item.content}</pre>
            {Object.entries(item.fields).map(([field, value]) => <p className="whitespace-pre-wrap break-words text-sm" key={field}><strong>{field}: </strong>{value}</p>)}
            {item.event ? <p className="text-xs">{item.event.era} · {item.event.category} · {(item.event.participantItemIds ?? []).join(', ')}</p> : null}
          </details>
        ))}
        <h3 className="font-medium">{t('workLibrary.preview.relations', { count: data.relations.length })}</h3>
        <ul>{data.relations.map((relation) => <li key={relation.id} className="break-words">{relation.fromItemId} → {relation.toItemId} · {relation.label || relation.kind}</li>)}</ul>
        {data.issues.length > 0 ? <div role="status"><h3>{t('workLibrary.preview.issues')}</h3><ul>{data.issues.map((issue) => <li key={issue.itemId}>{library.items.find((item) => item.id === issue.itemId)?.name ?? issue.itemId}：{t(`workLibrary.preview.errors.${issue.code}`, { defaultValue: t('workLibrary.loadError') })}</li>)}</ul></div> : null}
      </div> : !loading && !error ? <p className="text-sm text-muted-foreground">{t('workLibrary.preview.notGenerated')}</p> : null}
    </section>
  )
}
