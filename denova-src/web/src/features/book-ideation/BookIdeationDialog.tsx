import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, Check, Loader2, Sparkles, Trash2, Upload, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import {
  abandonIdeationDraft,
  addIdeationSource,
  commitIdeationDraft,
  createIdeationDraft,
  generateIdeationCandidates,
  getIdeationDraft,
  removeIdeationSource,
  saveIdeationCandidates,
  sendIdeationMessage,
  updateIdeationDraft,
  type IdeationDraft,
  type IdeationDraftResult,
} from '@/lib/api'
import { APIError } from '@/lib/api-client/client'
import { CandidateEditor } from './CandidateEditor'

/** 本地只记住“正在构思哪一份草稿”，内容真源始终在服务端草稿文件里。 */
const DRAFT_STORAGE_KEY = 'nova.book-ideation.draft-id.v1'

const STAGES = ['idea', 'direction', 'draft', 'preview'] as const
type Stage = (typeof STAGES)[number]

const inputCls =
  'nova-field w-full rounded-[var(--nova-radius)] border px-2.5 py-1.5 outline-none placeholder:text-[var(--nova-text-faint)] focus:border-[var(--nova-field-focus-border)]'

interface BookIdeationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 创建成功后由父组件切书并刷新书目；本组件从不提前切书。 */
  onCreated: (workspace: string) => void
}

export function BookIdeationDialog({ open, onOpenChange, onCreated }: BookIdeationDialogProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<IdeationDraft | null>(null)
  const [revision, setRevision] = useState('')
  const [stage, setStage] = useState<Stage>('idea')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [idea, setIdea] = useState('')
  const [message, setMessage] = useState('')
  const [sourceText, setSourceText] = useState('')
  const [sourceName, setSourceName] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const creating = useRef(false)
  // revision 用 ref 承载：连续两次写入（改书名 + 存候选）不会拿到过期 CAS 令牌。
  const revisionRef = useRef('')

  const adopt = useCallback((result: IdeationDraftResult, nextStage?: Stage) => {
    setDraft(result.draft)
    setRevision(result.revision)
    revisionRef.current = result.revision
    writeStoredDraftId(result.draft.id)
    // 一句话输入框由本地状态驱动，回填一次即可，避免 value 取自草稿却只 setIdea 造成回弹。
    setIdea(result.draft.idea || '')
    if (nextStage) setStage(nextStage)
    if (result.model_error) setNotice(result.model_error)
  }, [])

  const applyError = useCallback((err: unknown) => {
    if (err instanceof APIError) {
      const payload = err.payload as { draft?: IdeationDraft; revision?: string }
      if (err.code === 'draft_conflict' || err.code === 'generation_stale') {
        if (payload.draft) {
          setDraft(payload.draft)
          setRevision(payload.revision || '')
          revisionRef.current = payload.revision || ''
        }
        setError(t('bookIdeation.stale', { message: err.message }))
        return
      }
      setError(err.message)
      return
    }
    setError(err instanceof Error ? err.message : String(err))
  }, [t])

  useEffect(() => {
    if (!open) {
      setNotice('')
      setError('')
    }
  }, [open])

  // 刷新恢复：本地只存草稿 id，内容与 revision 一律从服务端读回。
  useEffect(() => {
    if (!open || draft || creating.current) return
    const stored = readStoredDraftId()
    if (!stored) return
    creating.current = true
    getIdeationDraft(stored)
      .then((result) => {
        adopt(result, restoreStage(result.draft))
      })
      .catch((err: unknown) => {
        // 只有服务端确认草稿不存在才清掉指针；接口暂时失败必须保留唯一恢复入口。
        if (err instanceof APIError && err.status === 404) {
          clearStoredDraftId()
          return
        }
        setError(t('bookIdeation.recoverFailed'))
      })
      .finally(() => {
        creating.current = false
      })
  }, [open, draft, adopt, t])

  const mutate = useCallback(
    async (action: (baseRevision: string) => Promise<IdeationDraftResult>, options: { keepStage?: Stage } = {}) => {
      if (!draft) return null
      setBusy(true)
      setError('')
      try {
        const result = await action(revisionRef.current)
        // 只在该次调用明确要求时才切阶段：否则在途保存会把用户拉回上一步。
        adopt(result, options.keepStage)
        return result
      } catch (err) {
        applyError(err)
        return null
      } finally {
        setBusy(false)
      }
    },
    [adopt, applyError, draft],
  )

  const startDraft = useCallback(async () => {
    if (draft) return
    setBusy(true)
    setError('')
    try {
      const result = await createIdeationDraft({ idea, locale: locale() })
      adopt(result, 'idea')
    } catch (err) {
      applyError(err)
    } finally {
      setBusy(false)
    }
  }, [applyError, draft, idea])

  const attachSource = useCallback(async () => {
    const content = sourceText.trim()
    if (!content) {
      setError(t('bookIdeation.sourceEmpty'))
      return
    }
    const result = await mutate((base) => addIdeationSource({
      id: draft!.id,
      baseRevision: base,
      fileName: sourceName.trim() || 'material.json',
      content,
    }))
    if (result) {
      setSourceText('')
      setSourceName('')
      setNotice(t('bookIdeation.sourceAdded', { count: result.draft.sources.reduce((sum, source) => sum + source.entries.length, 0) }))
    }
  }, [draft, mutate, sourceName, sourceText, stage, t])

  const submitMessage = useCallback(async () => {
    const content = message.trim()
    if (!content) return
    const result = await mutate((base) => sendIdeationMessage({ id: draft!.id, baseRevision: base, content }))
    if (result) setMessage('')
  }, [draft, message, mutate])

  // persistEdits writes the preview back (title first, then the package). It
  // returns false when the draft could not be re-read, so callers never build on
  // a stale CAS token.
  const persistEdits = useCallback(async (): Promise<boolean> => {
    if (!draft) return false
    const title = (draft.title || draft.candidates?.title || '').trim()
    const refreshed = await mutate((base) => updateIdeationDraft(draft.id, base, { title }))
    if (!refreshed || !draft.candidates) return Boolean(refreshed)
    const saved = await mutate((base) => saveIdeationCandidates({
      id: draft.id,
      baseRevision: base,
      package: draft.candidates!,
    }))
    return Boolean(saved)
  }, [draft, mutate])

  const generate = useCallback(async (scope: 'all' | 'overview' | 'items' | 'relation', refs: string[] = []) => {
    // 生成前先把预览里的编辑写回：服务端返回的是整份草稿，不能拿旧内容覆盖刚写的话。
    if (!(await persistEdits())) return
    const result = await mutate((base) => generateIdeationCandidates({
      id: draft!.id,
      baseRevision: base,
      scope,
      refs,
    }), { keepStage: scope === 'all' ? 'preview' : undefined })
    if (result && scope === 'all') setNotice(t('bookIdeation.generated'))
  }, [draft, mutate, persistEdits, t])

  const commit = useCallback(async () => {
    if (!draft) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      // 目录还没落盘时草稿仍可编辑：先把本次确认的书名、排除与改写写回草稿，
      // 让创建目标与用户在预览里看到的确实是同一份内容。
      // 目录已存在时后端已冻结草稿，此时只能按记录好的阶段继续，不能再编辑。
      if (!draft.commit?.workspace_path && draft.candidates) {
        const titled = await updateIdeationDraft(draft.id, revisionRef.current, {
          title: (draft.title || draft.candidates.title || '').trim(),
        })
        adopt(titled)
        const saved = await saveIdeationCandidates({
          id: draft.id,
          baseRevision: revisionRef.current,
          package: draft.candidates,
        })
        adopt(saved)
      }
      const response = await commitIdeationDraft({
        id: draft.id,
        baseRevision: revisionRef.current,
        requestId: `ideation-${draft.id}`,
      })
      clearStoredDraftId()
      setDraft(null)
      setRevision('')
      revisionRef.current = ''
      setStage('idea')
      setIdea('')
      onCreated(response.receipt.workspace_path || '')
    } catch (err) {
      if (err instanceof APIError && err.code === 'commit_incomplete') {
        const payload = err.payload as { receipt?: { stages?: { name: string; status: string; detail?: string }[] }; draft?: IdeationDraft; revision?: string }
        if (payload.draft) {
          setDraft(payload.draft)
          setRevision(payload.revision || '')
          revisionRef.current = payload.revision || ''
        }
        const failed = (payload.receipt?.stages || []).filter((item) => item.status !== 'done')
        setError(t('bookIdeation.commitIncomplete', {
          stages: failed.map((item) => t(`bookIdeation.commitStage.${item.name}`)).join('、'),
          detail: failed[0]?.detail || '',
        }))
      } else {
        applyError(err)
      }
    } finally {
      setBusy(false)
    }
  }, [adopt, applyError, draft, onCreated, t])

  // 普通关闭（Esc、点外部、关闭按钮）只是收起窗口：草稿与恢复指针都留着，
  // 下次打开还能回到同一份构思。只有主动“放弃草稿”才写入 abandoned 并清指针。
  const closeDialog = useCallback(() => {
    setNotice('')
    setError('')
    onOpenChange(false)
  }, [onOpenChange])

  const giveUp = useCallback(async () => {
    if (!draft) {
      clearStoredDraftId()
      onOpenChange(false)
      return
    }
    setBusy(true)
    try {
      await abandonIdeationDraft(draft.id, revisionRef.current)
      setNotice(t('bookIdeation.abandoned'))
    } catch (err) {
      applyError(err)
    } finally {
      clearStoredDraftId()
      setDraft(null)
      setRevision('')
      revisionRef.current = ''
      setStage('idea')
      setBusy(false)
      onOpenChange(false)
    }
  }, [draft, onOpenChange, revision])

  const sources = draft?.sources ?? []
  const candidates = draft?.candidates ?? null
  // 生成条件：有素材、有已确认方向，或至少有还没保存进草稿的一句话。
  const canGenerate = useMemo(
    () =>
      Boolean(draft) &&
      (sources.length > 0 || Boolean(draft?.direction.summary) || Boolean(draft?.idea) || Boolean(idea.trim())),
    [draft, idea, sources.length],
  )

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) closeDialog(); else onOpenChange(true) }}>
      <DialogContent className="max-w-[min(1180px,96vw)] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" />
            {t('bookIdeation.title')}
          </DialogTitle>
          <DialogDescription>{t('bookIdeation.description')}</DialogDescription>
        </DialogHeader>

        <StageBar stage={stage} onJump={(next) => setStage(next)} canJump={Boolean(candidates)} />

        <div className="grid max-h-[62vh] min-h-[360px] grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="flex min-h-0 flex-col gap-3">
            {!draft ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-[var(--nova-text-muted)]">{t('bookIdeation.startHint')}</p>
                <Textarea
                  value={idea}
                  onChange={(event) => setIdea(event.target.value)}
                  placeholder={t('bookIdeation.ideaPlaceholder')}
                  className="min-h-[96px]"
                  data-testid="ideation-idea"
                />
                <Button type="button" onClick={() => void startDraft()} disabled={busy} className="w-fit">
                  {busy ? <Loader2 className="animate-spin" /> : <Sparkles data-icon="inline-start" />}
                  {t('bookIdeation.start')}
                </Button>
              </div>
            ) : (
              <>
                {stage === 'idea' && (
                  <div className="flex flex-col gap-3">
                    <label className="text-xs font-medium text-[var(--nova-text-muted)]">{t('bookIdeation.ideaLabel')}</label>
                    <Textarea
                      value={idea}
                      onChange={(event) => setIdea(event.target.value)}
                      onBlur={() => {
                        if (idea && idea !== draft.idea) void mutate((base) => updateIdeationDraft(draft.id, base, { idea }))
                      }}
                      className="min-h-[80px]"
                      data-testid="ideation-idea-edit"
                    />
                    <SourcePicker
                      sources={sources}
                      busy={busy}
                      fileInput={fileInput}
                      sourceName={sourceName}
                      sourceText={sourceText}
                      onNameChange={setSourceName}
                      onTextChange={setSourceText}
                      onAdd={() => void attachSource()}
                      onRemove={(sourceId) => void mutate((base) => removeIdeationSource({ id: draft.id, baseRevision: base, sourceId }), { keepStage: 'idea' })}
                    />
                    <div className="flex justify-end">
                      <Button type="button" size="sm" variant="ghost" onClick={() => setStage('direction')} disabled={!canGenerate && sources.length === 0}>
                        {t('bookIdeation.nextDirection')}
                        <ArrowRight data-icon="inline-end" />
                      </Button>
                    </div>
                  </div>
                )}

                {stage === 'direction' && (
                  <div className="flex min-h-0 flex-1 flex-col gap-3">
                    <ScrollArea className="min-h-[180px] flex-1 rounded-[var(--nova-radius)] border border-[var(--nova-border)] p-3">
                      <div className="flex flex-col gap-2" data-testid="ideation-turns">
                        {draft.turns.length === 0 ? (
                          <p className="text-xs text-[var(--nova-text-faint)]">{t('bookIdeation.chatEmpty')}</p>
                        ) : (
                          draft.turns.map((turn, index) => (
                            <div
                              key={`${turn.at}-${index}`}
                              className={`rounded-[var(--nova-radius)] px-2.5 py-2 text-xs leading-relaxed ${
                                turn.role === 'user'
                                  ? 'ml-8 bg-[var(--nova-surface-3)] text-[var(--nova-text)]'
                                  : 'mr-8 bg-[var(--nova-hover)] text-[var(--nova-text)]'
                              }`}
                            >
                              {turn.content}
                            </div>
                          ))
                        )}
                      </div>
                    </ScrollArea>
                    <div className="flex gap-2">
                      <Textarea
                        value={message}
                        onChange={(event) => setMessage(event.target.value)}
                        placeholder={t('bookIdeation.chatPlaceholder')}
                        className="min-h-[64px]"
                        data-testid="ideation-chat-input"
                      />
                      <Button type="button" onClick={() => void submitMessage()} disabled={busy || !message.trim()}>
                        {busy ? <Loader2 className="animate-spin" /> : t('bookIdeation.send')}
                      </Button>
                    </div>
                    <div className="flex justify-between">
                      <Button type="button" size="sm" variant="ghost" onClick={() => setStage('idea')}>
                        <ArrowLeft data-icon="inline-start" />
                        {t('bookIdeation.backIdea')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void generate('all')}
                        disabled={busy || !canGenerate}
                        data-testid="ideation-generate"
                      >
                        <Sparkles data-icon="inline-start" />
                        {t('bookIdeation.generateDraft')}
                      </Button>
                    </div>
                  </div>
                )}

                {(stage === 'draft' || stage === 'preview') && (
                  <CandidateEditor
                    draft={draft}
                    busy={busy}
                    onPatch={(next) => setDraft({ ...draft, candidates: next })}
                    onPersist={() => void persistEdits()}
                    onRegenerate={(scope, refs) => void generate(scope, refs)}
                    onTitleChange={(value) => {
                      setDraft({ ...draft, title: value })
                    }}
                    onCommit={() => void commit()}
                    onBack={() => setStage('direction')}
                  />
                )}
              </>
            )}
          </div>

          <aside className="flex min-h-0 flex-col gap-3 rounded-[var(--nova-radius)] border border-[var(--nova-border)] bg-[var(--nova-surface)] p-3">
            <SectionTitle label={t('bookIdeation.directionPanel')} value={draft?.direction.updated_by} />
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--nova-text-muted)]">
              {draft?.direction.summary || t('bookIdeation.directionEmpty')}
            </p>
            {draft?.direction.cast?.length ? (
              <div className="flex flex-wrap gap-1.5">
                {draft.direction.cast.map((name) => (
                  <Badge key={name} variant="outline">{name}</Badge>
                ))}
              </div>
            ) : null}
            <Separator />
            <SectionTitle label={t('bookIdeation.pendingItems')} value={undefined} />
            {pendingQuestions(draft).length === 0 ? (
              <p className="text-xs text-[var(--nova-text-faint)]">{t('bookIdeation.pendingEmpty')}</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-xs text-[var(--nova-text-muted)]">
                {pendingQuestions(draft).map((question, index) => (
                  <li key={`${question}-${index}`} className="flex gap-2">
                    <span aria-hidden>·</span>
                    <span>{question}</span>
                  </li>
                ))}
              </ul>
            )}
            <Separator />
            <div className="flex flex-wrap gap-1.5 text-[11px] text-[var(--nova-text-faint)]">
              <Badge variant="outline">{t('bookIdeation.origin.source')}</Badge>
              <span>{t('bookIdeation.originSourceHint')}</span>
              <Badge variant="outline">{t('bookIdeation.origin.ai')}</Badge>
              <span>{t('bookIdeation.originAiHint')}</span>
            </div>
            {(notice || error) && (
              <div
                role={error ? 'alert' : 'status'}
                className={`mt-auto rounded-[var(--nova-radius)] px-2.5 py-2 text-xs ${
                  error ? 'bg-[var(--nova-danger-bg)] text-[var(--nova-danger-fg)]' : 'bg-[var(--nova-surface-3)] text-[var(--nova-text-muted)]'
                }`}
                data-testid="ideation-notice"
              >
                {error || notice}
              </div>
            )}
          </aside>
        </div>

        <DialogFooter>
          <p className="mr-auto text-[11px] text-[var(--nova-text-faint)]">{t('bookIdeation.readOnlyFootnote')}</p>
          <Button type="button" variant="ghost" size="sm" onClick={closeDialog} disabled={busy} data-testid="ideation-close">
            <X data-icon="inline-start" />
            {t('bookIdeation.close')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void giveUp()}
            disabled={busy || !draft}
            data-testid="ideation-abandon"
          >
            <Trash2 data-icon="inline-start" />
            {t('bookIdeation.giveUp')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StageBar({ stage, onJump, canJump }: { stage: Stage; onJump: (stage: Stage) => void; canJump: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]" data-testid="ideation-stages">
      {STAGES.map((item, index) => {
        const active = item === stage
        const reachable = index === 0 || item === 'direction' || canJump
        return (
          <button
            key={item}
            type="button"
            disabled={!reachable}
            onClick={() => onJump(item)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${
              active
                ? 'border-[var(--nova-active-border)] bg-[var(--nova-active)] text-[var(--nova-text)]'
                : 'border-[var(--nova-border)] text-[var(--nova-text-faint)]'
            } disabled:opacity-50`}
          >
            <span>{index + 1}</span>
            <span>{t(`bookIdeation.stage.${item}`)}</span>
            {active && <Check className="size-3" />}
          </button>
        )
      })}
    </div>
  )
}

function SectionTitle({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-xs font-semibold text-[var(--nova-text)]">{label}</h3>
      {value ? <span className="text-[11px] text-[var(--nova-text-faint)]">{value}</span> : null}
    </div>
  )
}

function SourcePicker({
  sources,
  busy,
  fileInput,
  sourceName,
  sourceText,
  onNameChange,
  onTextChange,
  onAdd,
  onRemove,
}: {
  sources: IdeationDraft['sources']
  busy: boolean
  fileInput: React.RefObject<HTMLInputElement | null>
  sourceName: string
  sourceText: string
  onNameChange: (value: string) => void
  onTextChange: (value: string) => void
  onAdd: () => void
  onRemove: (sourceId: string) => void
}) {
  const { t } = useTranslation()
  const readFile = async (file: File) => {
    const text = await file.text()
    onNameChange(file.name)
    onTextChange(text)
  }
  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium text-[var(--nova-text-muted)]">{t('bookIdeation.sourcesTitle')}</label>
      {sources.length === 0 ? (
        <p className="text-xs text-[var(--nova-text-faint)]">{t('bookIdeation.sourcesEmpty')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {sources.map((source) => (
            <li key={source.id} className="flex items-start justify-between gap-2 rounded-[var(--nova-radius)] border border-[var(--nova-border)] px-2.5 py-1.5">
              <div className="min-w-0">
                <p className="truncate text-xs text-[var(--nova-text)]">{source.name}</p>
                <p className="text-[11px] text-[var(--nova-text-faint)]">
                  {t(source.kind === 'character_card' ? 'bookIdeation.kindCard' : 'bookIdeation.kindLorebook')}
                  {' · '}
                  {t('bookIdeation.entryCount', { count: source.entries.length })}
                </p>
                {source.warnings?.length ? (
                  <p className="text-[11px] text-[var(--nova-warning-fg)]">{source.warnings.join(' / ')}</p>
                ) : null}
              </div>
              <Button type="button" size="xs" variant="ghost" onClick={() => onRemove(source.id)} disabled={busy}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          ref={fileInput}
          type="file"
          accept=".json,.txt,.md"
          className="hidden"
          data-testid="ideation-file-input"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void readFile(file)
            event.target.value = ''
          }}
        />
        <Button type="button" size="xs" variant="ghost" onClick={() => fileInput.current?.click()}>
          <Upload data-icon="inline-start" />
          {t('bookIdeation.pickFile')}
        </Button>
        <Input
          value={sourceName}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder={t('bookIdeation.sourceNamePlaceholder')}
          className={`${inputCls} min-w-[160px] flex-1`}
        />
      </div>
      <Textarea
        value={sourceText}
        onChange={(event) => onTextChange(event.target.value)}
        placeholder={t('bookIdeation.sourcePastePlaceholder')}
        className="min-h-[92px] font-mono text-[11px]"
        data-testid="ideation-source-text"
      />
      <Button type="button" size="sm" onClick={onAdd} disabled={busy || !sourceText.trim()} className="w-fit">
        {t('bookIdeation.attachSource')}
      </Button>
    </div>
  )
}

function pendingQuestions(draft: IdeationDraft | null): string[] {
  return draft?.candidates?.open_questions ?? []
}

function restoreStage(draft: IdeationDraft): Stage {
  if (draft.commit) return 'preview'
  if (draft.candidates) return 'preview'
  if (draft.turns.length > 0) return 'direction'
  return 'idea'
}

function readStoredDraftId(): string {
  try {
    return localStorage.getItem(DRAFT_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

function writeStoredDraftId(id: string) {
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, id)
  } catch {
    // localStorage 不可用时只是失去刷新恢复，不影响正确性。
  }
}

function clearStoredDraftId() {
  try {
    localStorage.removeItem(DRAFT_STORAGE_KEY)
  } catch {
    // 忽略
  }
}

function locale(): string {
  if (typeof document !== 'undefined' && document.documentElement.lang) {
    return document.documentElement.lang
  }
  return 'zh-CN'
}
