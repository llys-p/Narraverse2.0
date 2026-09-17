import { useEffect, useMemo, useState } from 'react'
import { Loader2, Save, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { WorkLibraryItem, WorkLibraryItemInput, WorkLibraryVocabulary } from '@/lib/api-client'
import { formatListInput, parseListInput } from '../library-errors'

// 条目详情表单：字段与 L1 契约一一对应。
//
// 草稿语义（L1.2 验收要求）：本组件的本地草稿只在「切换条目」或「服务端条目版本变化」
// 时被重置。保存失败（含 409）时草稿原样保留，由上层横幅提示重新加载。

interface LibraryItemFormProps {
  item: WorkLibraryItem
  vocabulary: WorkLibraryVocabulary | null
  saving: boolean
  onSave: (input: WorkLibraryItemInput) => void
  onDelete: () => void
  /** 只读引用条目：正文与名称以来源为准。 */
  readOnlyBody: boolean
}

const inputClass = 'h-8 w-full rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] px-2.5 text-sm outline-none focus:border-[var(--nova-ring)]'
const areaClass = 'min-h-40 w-full rounded-[var(--radius-md)] border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2.5 text-sm leading-6 outline-none focus:border-[var(--nova-ring)]'
const labelClass = 'text-[11px] font-medium text-muted-foreground'

export function LibraryItemForm({ item, vocabulary, saving, onSave, onDelete, readOnlyBody }: LibraryItemFormProps) {
  const { t } = useTranslation()
  const [name, setName] = useState(item.name)
  const [type, setType] = useState(item.type)
  const [importance, setImportance] = useState(item.importance)
  const [loadMode, setLoadMode] = useState(item.loadMode)
  const [enabled, setEnabled] = useState(item.enabled)
  const [brief, setBrief] = useState(item.briefDescription ?? '')
  const [content, setContent] = useState(item.content ?? '')
  const [tags, setTags] = useState(formatListInput(item.tags))
  const [keywords, setKeywords] = useState(formatListInput(item.keywords))

  // 只在条目身份或服务端版本变化时重置草稿；保存失败不重置。
  useEffect(() => {
    setName(item.name)
    setType(item.type)
    setImportance(item.importance)
    setLoadMode(item.loadMode)
    setEnabled(item.enabled)
    setBrief(item.briefDescription ?? '')
    setContent(item.content ?? '')
    setTags(formatListInput(item.tags))
    setKeywords(formatListInput(item.keywords))
  }, [item.id, item.updatedAt, item.name, item.type, item.importance, item.loadMode, item.enabled,
      item.briefDescription, item.content, item.tags, item.keywords])

  const dirty = useMemo(() => (
    name !== item.name
    || type !== item.type
    || importance !== item.importance
    || loadMode !== item.loadMode
    || enabled !== item.enabled
    || brief !== (item.briefDescription ?? '')
    || content !== (item.content ?? '')
    || tags !== formatListInput(item.tags)
    || keywords !== formatListInput(item.keywords)
  ), [name, type, importance, loadMode, enabled, brief, content, tags, keywords, item])

  const submit = () => {
    onSave({
      name: name.trim(),
      type,
      importance,
      loadMode,
      enabled,
      briefDescription: brief,
      content,
      tags: parseListInput(tags),
      keywords: parseListInput(keywords),
      // 条目级并发基线：与磁盘 updatedAt 不一致时服务端返回 409。
      baseUpdatedAt: item.updatedAt,
    })
  }

  const itemTypes = vocabulary?.itemTypes ?? [item.type]
  const loadModes = vocabulary?.loadModes ?? ['resident', 'auto', 'manual']
  const importanceLevels = vocabulary?.importanceLevels ?? ['major', 'important', 'minor']

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>{t('workLibrary.item.name')}</span>
          <input
            className={inputClass}
            value={name}
            maxLength={120}
            placeholder={t('workLibrary.item.namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>{t('workLibrary.item.type')}</span>
          <select className={inputClass} value={type} onChange={(event) => setType(event.target.value)}>
            {itemTypes.map((value) => (
              <option key={value} value={value}>{t(`workLibrary.type.${value}`, { defaultValue: value })}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>{t('workLibrary.item.importance')}</span>
          <select className={inputClass} value={importance} onChange={(event) => setImportance(event.target.value)}>
            {importanceLevels.map((value) => (
              <option key={value} value={value}>{t(`workLibrary.importance.${value}`, { defaultValue: value })}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>{t('workLibrary.loadMode.label')}</span>
          <select className={inputClass} value={loadMode} onChange={(event) => setLoadMode(event.target.value as typeof loadMode)}>
            {loadModes.map((value) => (
              <option key={value} value={value}>{t(`workLibrary.loadMode.${value}`, { defaultValue: value })}</option>
            ))}
          </select>
        </label>
      </div>

      <p className="text-[11px] leading-5 text-muted-foreground">{t(`workLibrary.loadMode.${loadMode}Hint`, { defaultValue: '' })}</p>

      <label className="flex items-center gap-2 text-xs text-foreground">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <span>{t('workLibrary.item.enabled')}</span>
        <span className="text-[11px] text-muted-foreground">{t('workLibrary.item.enabledHint')}</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className={labelClass}>{t('workLibrary.item.brief')}</span>
        <input
          className={inputClass}
          value={brief}
          maxLength={500}
          placeholder={t('workLibrary.item.briefPlaceholder')}
          onChange={(event) => setBrief(event.target.value)}
        />
      </label>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>{t('workLibrary.item.tags')}</span>
          <input
            className={inputClass}
            value={tags}
            placeholder={t('workLibrary.item.tagsPlaceholder')}
            onChange={(event) => setTags(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>{t('workLibrary.item.keywords')}</span>
          <input
            className={inputClass}
            value={keywords}
            placeholder={t('workLibrary.item.keywordsPlaceholder')}
            onChange={(event) => setKeywords(event.target.value)}
          />
        </label>
      </div>

      <label className="flex min-h-0 flex-1 flex-col gap-1">
        <span className={labelClass}>{t('workLibrary.item.content')}</span>
        {readOnlyBody ? (
          <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--nova-border)] p-2.5 text-[11px] leading-5 text-muted-foreground">
            {t('workLibrary.source.readOnlyBody')}
          </div>
        ) : null}
        <textarea
          className={`${areaClass} ${readOnlyBody ? 'opacity-70' : ''}`}
          value={content}
          readOnly={readOnlyBody}
          placeholder={t('workLibrary.item.contentPlaceholder')}
          onChange={(event) => setContent(event.target.value)}
        />
      </label>

      <dl className="grid grid-cols-1 gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
        <div className="flex gap-1">
          <dt>{t('workLibrary.item.id')}</dt>
          <dd className="font-mono">{item.id}</dd>
        </div>
        <div className="flex gap-1">
          <dt>{t('workLibrary.item.updatedAt')}</dt>
          <dd>{item.updatedAt}</dd>
        </div>
      </dl>

      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={saving || !name.trim()}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          {saving ? t('workLibrary.saving') : t('workLibrary.save')}
        </Button>
        {dirty ? <span className="text-[11px] text-muted-foreground">{t('workLibrary.dirtyHint')}</span> : null}
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={onDelete}>
          <Trash2 className="size-3.5" />
          {t('workLibrary.item.delete')}
        </Button>
      </div>
    </div>
  )
}
