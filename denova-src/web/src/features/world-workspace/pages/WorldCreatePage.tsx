import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { FeaturePageShell } from '@/components/layout/feature-page-shell'
import { Button } from '@/components/ui/button'
import { getBooks, type BookRecord } from '@/lib/api-client'
import { getInteractiveStories } from '@/features/interactive/api'
import { cn } from '@/lib/utils'
import { BindingPicker } from '../components/BindingPicker'
import { createWorld } from '../world-api'
import { characterFromBinding } from '../world-factory'
import type { WorldAssetBinding, WorldCharacter, WorldCreateInput } from '../types'

const TOTAL_STEPS = 4
// 克制的纯色色板（不使用紫蓝渐变/霓虹）。
const COVER_SWATCHES = ['#64748b', '#0f766e', '#b45309', '#9f1239', '#4d7c0f', '#7c2d12', '#334155', '#a16207']

interface WorldCreatePageProps {
  onCancel: () => void
  onCreated: (id: string) => void
}

export function WorldCreatePage({ onCancel, onCreated }: WorldCreatePageProps) {
  const { t } = useTranslation()
  const [step, setStep] = useState(1)
  const [name, setName] = useState('')
  const [tagline, setTagline] = useState('')
  const [genre, setGenre] = useState('')
  const [summary, setSummary] = useState('')
  const [coverColor, setCoverColor] = useState(COVER_SWATCHES[0])
  const [tone, setTone] = useState('')
  const [rules, setRules] = useState<string[]>([''])
  const [bindings, setBindings] = useState<WorldAssetBinding[]>([])
  const [characters, setCharacters] = useState<WorldCharacter[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [books, setBooks] = useState<BookRecord[]>([])
  const [stories, setStories] = useState<{ id: string; title: string }[]>([])
  const [primaryBookPath, setPrimaryBookPath] = useState('')
  const [primaryStoryId, setPrimaryStoryId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void getBooks().then(setBooks).catch(() => setBooks([]))
    void getInteractiveStories().then((index) => setStories(index.stories ?? [])).catch(() => setStories([]))
  }, [])

  const isDirty = useMemo(
    () => Boolean(name.trim() || tagline.trim() || genre.trim() || summary.trim() || tone.trim() || rules.some((r) => r.trim()) || bindings.length),
    [name, tagline, genre, summary, tone, rules, bindings],
  )

  const requestCancel = () => {
    if (isDirty && !window.confirm(t('worldWorkspace.create.unsavedLeave'))) return
    onCancel()
  }

  const boundMasterIds = useMemo(() => new Set(bindings.map((b) => b.masterItemId)), [bindings])
  const cleanRules = rules.map((r) => r.trim()).filter(Boolean)
  const canAdvanceStep1 = name.trim().length > 0

  const submit = async () => {
    if (submitting) return // 重复提交保护
    if (!name.trim()) { setStep(1); return }
    setSubmitting(true)
    setError(null)
    const input: WorldCreateInput = {
      name: name.trim(),
      tagline: tagline.trim() || undefined,
      genre: genre.trim() || undefined,
      summary: summary.trim() || undefined,
      coverColor,
      worldSetting: { rules: cleanRules, tone: tone.trim() || undefined },
      bindings,
      characters,
      primaryBookPath: primaryBookPath || undefined,
      primaryInteractiveStoryId: primaryStoryId || undefined,
    }
    try {
      const res = await createWorld(input) // 一次原子创建完整初始世界
      onCreated(res.world.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('worldWorkspace.create.submitError'))
      setSubmitting(false)
    }
  }

  const labeledInput = 'h-8 w-full rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-2.5 text-sm outline-none focus:border-[var(--nova-ring)]'
  const labeledArea = 'min-h-28 w-full rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2.5 text-sm leading-6 outline-none focus:border-[var(--nova-ring)]'

  return (
    <FeaturePageShell icon={Sparkles} title={t('worldWorkspace.create.title')} onClose={requestCancel} error={error} errorTitle={t('worldWorkspace.create.submitError')}>
      <div className="mx-auto flex h-full min-h-0 w-full max-w-2xl flex-col gap-4 overflow-y-auto p-4 sm:p-6">
        <StepIndicator current={step} total={TOTAL_STEPS} labels={[1, 2, 3, 4].map((n) => t(`worldWorkspace.create.step${n}` as const))} t={t} />

        {step === 1 && (
          <section className="flex flex-col gap-3">
            <Field label={t('worldWorkspace.create.name')} required>
              <input className={labeledInput} value={name} maxLength={100} placeholder={t('worldWorkspace.create.namePlaceholder')} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            <Field label={t('worldWorkspace.create.tagline')}>
              <input className={labeledInput} value={tagline} maxLength={200} placeholder={t('worldWorkspace.create.taglinePlaceholder')} onChange={(e) => setTagline(e.target.value)} />
            </Field>
            <Field label={t('worldWorkspace.create.genre')}>
              <input className={labeledInput} value={genre} maxLength={50} onChange={(e) => setGenre(e.target.value)} />
            </Field>
            <Field label={t('worldWorkspace.create.coverColor')}>
              <div className="flex flex-wrap gap-2">
                {COVER_SWATCHES.map((c) => (
                  <button key={c} type="button" onClick={() => setCoverColor(c)} aria-label={c}
                    className={cn('size-7 rounded-full border-2 transition-transform', coverColor === c ? 'scale-110 border-[var(--nova-text)]' : 'border-transparent')}
                    style={{ backgroundColor: c }}>
                    {coverColor === c ? <Check className="mx-auto size-4 text-white" /> : null}
                  </button>
                ))}
              </div>
            </Field>
            <Field label={t('worldWorkspace.create.summary')}>
              <textarea className={labeledArea} value={summary} maxLength={20000} placeholder={t('worldWorkspace.create.summaryPlaceholder')} onChange={(e) => setSummary(e.target.value)} />
            </Field>
          </section>
        )}

        {step === 2 && (
          <section className="flex flex-col gap-3">
            <Field label={t('worldWorkspace.create.tone')}>
              <input className={labeledInput} value={tone} maxLength={200} onChange={(e) => setTone(e.target.value)} />
            </Field>
            <Field label={t('worldWorkspace.create.rules')}>
              <div className="flex flex-col gap-2">
                {rules.map((rule, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      className={labeledInput}
                      value={rule}
                      maxLength={2000}
                      placeholder={t('worldWorkspace.create.rulePlaceholder')}
                      onChange={(e) => setRules((prev) => prev.map((r, idx) => idx === i ? e.target.value : r))}
                    />
                    <Button variant="ghost" size="icon-sm" onClick={() => setRules((prev) => prev.filter((_, idx) => idx !== i))} aria-label="remove"><Trash2 /></Button>
                  </div>
                ))}
                <Button variant="outline" size="xs" className="self-start" onClick={() => setRules((prev) => [...prev, ''])} data-icon="inline-start">
                  <Plus />{t('worldWorkspace.create.addRule')}
                </Button>
              </div>
            </Field>
          </section>
        )}

        {step === 3 && (
          <section className="flex flex-col gap-3">
            <Field label={t('worldWorkspace.create.bindings')} hint={t('worldWorkspace.create.bindingsHint')}>
              <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)} data-icon="inline-start">
                <Sparkles />{t('worldWorkspace.console.bindAsset')}
              </Button>
              {bindings.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {bindings.map((b) => (
                    <li key={b.bindingId} className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--nova-border)] px-2 py-1.5 text-sm">
                      <span className="min-w-0 flex-1 truncate">{b.nameSnapshot}</span>
                      <span className="text-[11px] text-[var(--nova-text-muted)]">{b.semanticType}</span>
                      <Button variant="ghost" size="icon-xs" onClick={() => {
                        setBindings((prev) => prev.filter((x) => x.bindingId !== b.bindingId))
                        setCharacters((prev) => prev.filter((character) => character.bindingId !== b.bindingId))
                      }} aria-label="remove"><X /></Button>
                    </li>
                  ))}
                </ul>
              )}
            </Field>
            <Field label={t('worldWorkspace.create.primaryBook')} hint={t('worldWorkspace.create.primaryBookHint')}>
              <select className={labeledInput} value={primaryBookPath} onChange={(e) => setPrimaryBookPath(e.target.value)}>
                <option value="">{t('worldWorkspace.create.primaryBookNone')}</option>
                {books.map((b) => <option key={b.path} value={b.path}>{b.name}</option>)}
              </select>
            </Field>
            <Field label={t('worldWorkspace.create.primaryStory')} hint={t('worldWorkspace.create.primaryStoryHint')}>
              <select className={labeledInput} value={primaryStoryId} onChange={(e) => setPrimaryStoryId(e.target.value)}>
                <option value="">{t('worldWorkspace.create.primaryStoryNone')}</option>
                {stories.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
            </Field>
          </section>
        )}

        {step === 4 && (
          <section className="flex flex-col gap-3 text-sm">
            <p className="text-[var(--nova-text-muted)]">{t('worldWorkspace.create.reviewHint')}</p>
            <ReviewRow k={t('worldWorkspace.create.name')} v={name} />
            {tagline && <ReviewRow k={t('worldWorkspace.create.tagline')} v={tagline} />}
            {genre && <ReviewRow k={t('worldWorkspace.create.genre')} v={genre} />}
            {tone && <ReviewRow k={t('worldWorkspace.create.tone')} v={tone} />}
            {cleanRules.length > 0 && <ReviewRow k={t('worldWorkspace.create.rules')} v={cleanRules.join('；')} />}
            <ReviewRow k={t('worldWorkspace.create.bindings')} v={String(bindings.length)} />
            {primaryBookPath && <ReviewRow k={t('worldWorkspace.create.primaryBook')} v={primaryBookPath} />}
            {primaryStoryId && <ReviewRow k={t('worldWorkspace.create.primaryStory')} v={primaryStoryId} />}
          </section>
        )}

        <div className="mt-auto flex items-center gap-2 border-t border-[var(--nova-border)] pt-3">
          {step > 1 && (
            <Button variant="outline" size="sm" onClick={() => setStep((s) => s - 1)} data-icon="inline-start"><ArrowLeft />{t('worldWorkspace.create.prev')}</Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {step < TOTAL_STEPS ? (
              <Button size="sm" disabled={step === 1 && !canAdvanceStep1} onClick={() => setStep((s) => s + 1)} data-icon="inline-end">
                {t('worldWorkspace.create.next')}<ArrowRight />
              </Button>
            ) : (
              <Button size="sm" disabled={submitting || !canAdvanceStep1} onClick={() => void submit()}>
                {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                {submitting ? t('worldWorkspace.create.submitting') : t('worldWorkspace.create.submit')}
              </Button>
            )}
          </div>
        </div>
      </div>

      <BindingPicker open={pickerOpen} onClose={() => setPickerOpen(false)} boundMasterIds={boundMasterIds} onBind={(binding) => {
        setBindings((prev) => [...prev, binding])
        if (binding.recordKind === 'character_template' && binding.semanticType === 'character') {
          setCharacters((prev) => [...prev, characterFromBinding(binding)])
        }
      }} />
    </FeaturePageShell>
  )
}

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-[var(--nova-text-muted)]">
        {label}{required ? <span className="text-red-500"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="text-[11px] text-[var(--nova-text-muted)]">{hint}</span> : null}
    </label>
  )
}

function ReviewRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-3">
      <span className="w-28 shrink-0 text-[var(--nova-text-muted)]">{k}</span>
      <span className="min-w-0 flex-1 break-words">{v}</span>
    </div>
  )
}

function StepIndicator({ current, total, labels, t }: { current: number; total: number; labels: string[]; t: (k: string, o?: Record<string, unknown>) => string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-[var(--nova-text-muted)]">{t('worldWorkspace.create.step', { current, total })}</span>
      <div className="flex flex-1 flex-wrap gap-1.5">
        {labels.map((label, i) => {
          const n = i + 1
          const active = n === current
          const done = n < current
          return (
            <span key={label} className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
              active ? 'border-[var(--nova-ring)] bg-[var(--nova-active)] text-[var(--nova-active-text)]' : done ? 'border-[var(--nova-border)] text-[var(--nova-text)]' : 'border-[var(--nova-border)] text-[var(--nova-text-muted)]',
            )}>
              {done ? <Check className="size-3" /> : null}{label}
            </span>
          )
        })}
      </div>
    </div>
  )
}
