import { Pencil, ScanSearch, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/common/EmptyState'
import { ThemedMarkdownRenderer } from '@/components/common/MarkdownRenderer'
import { AutosaveStatusIndicator } from '@/components/forms/autosave-status'
import { formatDateTime } from '@/i18n'
import type { LoreItem } from '@/lib/api'
import type { ImagePreset } from '@/features/interactive/types'
import { LoreEditor } from '@/features/interactive/components/setting-panel/LoreEditor'
import { LoreImageGallery } from '@/features/interactive/components/setting-panel/LoreImageGallery'
import { explicitRelationsOf, hasGalleryImages, isBlankField, resolveCharacterTier } from '../book-library-view-model'
import type { BookLibraryLore } from '../use-book-library-lore'

interface EntryDetailViewProps {
  workspace: string
  lore: BookLibraryLore
  items: LoreItem[]
  imagePresets: ImagePreset[]
  imagePresetId: string
  imageInstruction: string
  onImagePresetChange: (id: string) => void
  setImageInstruction: (value: string) => void
  editing: boolean
  setEditing: (value: boolean) => void
  /** 图谱抽屉内的只读态：隐藏编辑/删除/图片解除关联，画布状态因此不被打断。 */
  readOnly?: boolean
  query: string
  onOpen: (id: string) => void
  onBack: () => void
  onConfirmDelete: (item: LoreItem) => void
}

/** 统一详情：同一条目在读/写两态共用同一份 draft 与同一条保存通道。 */
export function EntryDetailView({
  workspace,
  lore,
  items,
  imagePresets,
  imagePresetId,
  imageInstruction,
  onImagePresetChange,
  setImageInstruction,
  editing,
  setEditing,
  readOnly = false,
  query,
  onOpen,
  onBack,
  onConfirmDelete,
}: EntryDetailViewProps) {
  const { t } = useTranslation()
  const draft = lore.draft

  if (!draft) {
    return (
      <EmptyState
        variant="page"
        title={t('bookLibrary.entry.noneSelected')}
        description={t('bookLibrary.entry.noneSelectedDesc')}
        action={{ label: t('bookLibrary.entry.backToList'), onClick: onBack }}
      />
    )
  }

  if (editing) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="book-library-toolbar" style={{ padding: '0 0 8px', marginBottom: 0 }}>
          <Button type="button" size="sm" variant="outline" onClick={() => { void lore.saveNow().then(() => setEditing(false)) }}>
            {t('bookLibrary.entry.doneEditing')}
          </Button>
          <AutosaveStatusIndicator status={lore.autosaveStatus} error={lore.autosaveError} onRetry={() => void lore.saveNow()} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <LoreEditor
            workspace={workspace}
            draft={draft}
            tagDraft={lore.tagDraft}
            residentTotalBytes={lore.residentTotalBytes}
            imagePresets={imagePresets}
            imagePresetId={imagePresetId}
            imageInstruction={imageInstruction}
            imageGenerating={lore.imageBusy.generating}
            imageUploading={lore.imageBusy.uploading}
            searchQuery={query}
            setDraft={lore.setDraft}
            setTagDraft={lore.setTagDraft}
            onImagePresetChange={onImagePresetChange}
            setImageInstruction={setImageInstruction}
            onGenerateImage={() => void lore.generateImage(imageInstruction, imagePresetId)}
            onClearImage={() => void lore.clearImage()}
            onUploadImages={lore.uploadImages}
            onRemoveUploadedImage={(imagePath) => void lore.removeImage(imagePath)}
            onSave={() => { void lore.saveNow() }}
          />
        </div>
      </div>
    )
  }

  const relations = explicitRelationsOf(draft, items)

  return (
    <div className="bl-detail">
      <section className="bl-detail-hero">
        <div style={{ minWidth: 0 }}>
          <div className="book-library-eyebrow">
            <button type="button" className="bl-chip" style={{ minHeight: 22, padding: '0 7px' }} onClick={onBack}>{t('bookLibrary.entry.back')}</button>
            {' '}
            {t(`lore.type.${draft.type}`)} · {t(`settingPanel.characterTier.${resolveCharacterTier(draft)}`)}
          </div>
          <h1 className="page-title" style={{ fontSize: 20, fontWeight: 600, margin: '8px 0 0' }}>{draft.name || t('bookLibrary.entry.unnamed')}</h1>
          <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--nova-text-muted)' }}>
            {isBlankField(draft.brief_description) ? t('bookLibrary.field.notFilled') : draft.brief_description}
          </p>
        </div>
        <div className="detail-actions" style={{ display: 'flex', gap: 8, flex: 'none' }}>
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
            {readOnly ? <ScanSearch data-icon="inline-start" /> : <Pencil data-icon="inline-start" />}
            {t(readOnly ? 'bookLibrary.entry.openFull' : 'bookLibrary.entry.edit')}
          </Button>
          {readOnly ? null : (
            <Button type="button" size="icon-xs" variant="ghost" aria-label={t('settingPanel.deleteLore')} title={t('settingPanel.deleteLore')} onClick={() => onConfirmDelete(draft)}>
              <Trash2 />
            </Button>
          )}
        </div>
      </section>

      {hasGalleryImages(draft) ? (
        <section className="bl-card bl-gallery">
          <LoreImageGallery
            itemName={draft.name || t('bookLibrary.entry.unnamed')}
            aiImage={draft.image}
            uploadedImages={draft.images || []}
            onRemove={(imagePath) => { if (!readOnly) void lore.removeImage(imagePath) }}
            disabled={readOnly || lore.imageBusy.uploading}
          />
        </section>
      ) : null}

      <section className="bl-card bl-info">
        <h3>{t('bookLibrary.entry.profile')}</h3>
        <div className="bl-fields">
          <Field label={t('bookLibrary.field.type')} value={t(`lore.type.${draft.type}`)} />
          <Field label={t('bookLibrary.field.tier')} value={draft.type === 'character' ? t(`settingPanel.characterTier.${resolveCharacterTier(draft)}`) : null} />
          <Field label={t('bookLibrary.field.enabled')} value={draft.enabled === false ? t('common.no') : t('common.yes')} />
          <Field label={t('bookLibrary.field.importance')} value={t(`lore.importance.${draft.importance}`)} />
          <Field label={t('bookLibrary.field.loadMode')} value={t(`lore.loadMode.${draft.load_mode || 'auto'}`)} />
          <Field label={t('bookLibrary.field.updatedAt')} value={draft.updated_at ? formatDateTime(draft.updated_at) : null} />
        </div>
        <div style={{ marginTop: 12 }}>
          <p className="bl-section-heading">{t('bookLibrary.field.tags')}</p>
          {draft.tags?.length ? (
            <div className="bl-tag-row">{draft.tags.map((tag) => <span key={tag} className="bl-tag">{tag}</span>)}</div>
          ) : <span className="bl-entry-type">{t('bookLibrary.field.notFilled')}</span>}
        </div>
      </section>

      <section className="bl-card bl-info" style={{ gridColumn: '1 / -1' }}>
        <h3>{t('bookLibrary.entry.content')}</h3>
        {isBlankField(draft.content)
          ? <p className="bl-entry-type">{t('bookLibrary.field.notFilled')}</p>
          : <ThemedMarkdownRenderer className="bl-prose" content={draft.content} />}
      </section>

      <section className="bl-card bl-info" style={{ gridColumn: '1 / -1' }}>
        <h3>{t('bookLibrary.entry.relations', { count: relations.length })}</h3>
        {relations.length ? (
          relations.map((relation) => (
            <div className="bl-relation-row" key={relation.key}>
              <button type="button" className="bl-chip" style={{ minHeight: 24 }} onClick={() => onOpen(relation.target.id)}>
                {relation.target.name || t('bookLibrary.entry.unnamed')}
              </button>
              <span className="bl-relation-label">{relation.label}{relation.note ? ` · ${relation.note}` : ''}</span>
            </div>
          ))
        ) : <p className="bl-entry-type">{t('bookLibrary.entry.noRelations')}</p>}
        <p className="bl-entry-type" style={{ marginTop: 10 }}>{t('bookLibrary.entry.relationsHint')}</p>
      </section>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="bl-field">
      <span>{label}</span>
      <b className={value ? undefined : 'is-empty'}>{value || <NotFilled />}</b>
    </div>
  )
}

function NotFilled() {
  const { t } = useTranslation()
  return <>{t('bookLibrary.field.notFilled')}</>
}
