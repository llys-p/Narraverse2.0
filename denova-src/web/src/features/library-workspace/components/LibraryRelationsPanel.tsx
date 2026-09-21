import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import type { WorkLibraryItem, WorkLibraryRelation, WorkLibraryRelationInput, WorkLibraryVocabulary } from '@/lib/api-client'

interface Props {
  items: WorkLibraryItem[]
  relations: WorkLibraryRelation[]
  vocabulary: WorkLibraryVocabulary | null
  onCreate: (input: WorkLibraryRelationInput) => Promise<boolean>
  onUpdate: (id: string, input: WorkLibraryRelationInput) => Promise<boolean>
  onDelete: (id: string) => Promise<boolean>
  onDirtyChange?: (dirty: boolean) => void
}

const control = 'min-w-0 rounded border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-1.5 text-xs'

export function LibraryRelationsPanel({ items, relations, vocabulary, onCreate, onUpdate, onDelete, onDirtyChange }: Props) {
  const { t } = useTranslation()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [fromId, setFromId] = useState(items[0]?.id ?? '')
  const [toId, setToId] = useState(items[1]?.id ?? '')
  const [kind, setKind] = useState('ally')
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [saving, setSaving] = useState(false)
  const [issue, setIssue] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [draftTouched, setDraftTouched] = useState(false)
  useEffect(() => onDirtyChange?.(draftTouched || editingId !== null), [draftTouched, editingId, onDirtyChange])
  const names = new Map(items.map((item) => [item.id, item.name]))

  const save = async () => {
    if (!fromId || !toId || fromId === toId) { setIssue(t('workLibrary.relations.needBoth')); return }
    if (relations.some((relation) => relation.id !== editingId && relation.fromItemId === fromId && relation.toItemId === toId && relation.kind === kind)) {
      setIssue(t('workLibrary.relations.duplicate'))
      return
    }
    setSaving(true)
    setIssue('')
    const input = { fromItemId: fromId, toItemId: toId, kind, label, note, since, until }
    try {
      const ok = editingId ? await onUpdate(editingId, input) : await onCreate(input)
      if (ok) { setEditingId(null); setDraftTouched(false); setLabel(''); setNote(''); setSince(''); setUntil('') }
      else setIssue(t('workLibrary.saveError'))
    } finally { setSaving(false) }
  }

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs">
      <p className="text-muted-foreground">{t('workLibrary.relations.hint')}</p>
      {items.length < 2 ? <p>{t('workLibrary.relations.needBoth')}</p> : (
        <div className="grid gap-2 rounded border border-[var(--nova-border)] p-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1">{t('workLibrary.relations.from')}
            <select className={control} value={fromId} onChange={(event) => { setFromId(event.target.value); setDraftTouched(true) }}>
              {items.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">{t('workLibrary.relations.to')}
            <select className={control} value={toId} onChange={(event) => { setToId(event.target.value); setDraftTouched(true) }}>
              {items.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">{t('workLibrary.relations.kind')}
            <select className={control} value={kind} onChange={(event) => { setKind(event.target.value); setDraftTouched(true) }}>
              {(vocabulary?.relationKinds ?? ['ally', 'rival', 'family', 'mentor', 'member_of', 'located_in', 'owns', 'knows', 'other']).map((value) =>
                <option key={value} value={value}>{t(`workLibrary.relationKind.${value}`, { defaultValue: value })}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">{t('workLibrary.relations.label')}
            <input className={control} value={label} maxLength={120} onChange={(event) => { setLabel(event.target.value); setDraftTouched(true) }} />
          </label>
          <label className="flex flex-col gap-1">{t('workLibrary.relations.since')}
            <input className={control} value={since} onChange={(event) => { setSince(event.target.value); setDraftTouched(true) }} />
          </label>
          <label className="flex flex-col gap-1">{t('workLibrary.relations.until')}
            <input className={control} value={until} onChange={(event) => { setUntil(event.target.value); setDraftTouched(true) }} />
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">{t('workLibrary.relations.note')}
            <textarea className={control} value={note} maxLength={2000} onChange={(event) => { setNote(event.target.value); setDraftTouched(true) }} />
          </label>
          {issue ? <p role="alert" className="text-[var(--nova-danger)] sm:col-span-2">{issue}</p> : null}
          <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>{t(editingId ? 'workLibrary.relations.save' : 'workLibrary.relations.new')}</Button>
        </div>
      )}
      {relations.length === 0 ? <p className="text-muted-foreground">{t('workLibrary.relations.empty')}</p> : (
        <ul className="space-y-1">
          {relations.map((relation) => <li key={relation.id} className="flex flex-wrap items-center gap-2 rounded border border-[var(--nova-border)] p-2">
            <span className="min-w-0 flex-1 break-words">{names.get(relation.fromItemId) ?? relation.fromItemId} · {relation.fromItemId} → {names.get(relation.toItemId) ?? relation.toItemId} · {relation.toItemId} · {t(`workLibrary.relationKind.${relation.kind}`, { defaultValue: relation.kind })}</span>
            <Button type="button" size="sm" variant="ghost" onClick={() => {
              setDraftTouched(true)
              setEditingId(relation.id); setFromId(relation.fromItemId); setToId(relation.toItemId)
              setKind(relation.kind); setLabel(relation.label ?? ''); setNote(relation.note ?? '')
              setSince(relation.since ?? ''); setUntil(relation.until ?? '')
            }}>{t('workLibrary.relations.edit')}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setDeleteId(relation.id)}>{t('workLibrary.relations.delete')}</Button>
          </li>) }
        </ul>
      )}
      <ConfirmDialog open={deleteId !== null} onOpenChange={(open) => { if (!open) setDeleteId(null) }}
        title={t('workLibrary.relations.delete')} description={t('workLibrary.relations.deleteConfirm')}
        tone="danger" onConfirm={async () => deleteId ? onDelete(deleteId) : false} />
    </div>
  )
}
